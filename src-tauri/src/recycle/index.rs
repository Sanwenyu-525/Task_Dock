//! 回收站持久化索引：SQLite 表结构、分页查询、统计与同步状态。
//!
//! 设计要点：
//! - 索引条目以 `(bin_root, record_key)` 为主键，`record_key` 即 `$R` 文件名去掉
//!   前缀（`$R` 后缀同时包含原始扩展名，实测 `$IABCDEF.txt` ↔ `$RABCDEF.txt`）；
//! - **所有排序/搜索/筛选都在 SQL 内完成**，前端只拿当前页，绝不整表传输；
//! - `size` 对目录不可靠（`$I` 中目录通常为 0），因此用 `size_known` 区分
//!   「0 字节」与「未知」——界面上必须显示为 `—` 而不是 0 B；
//! - 统计（总条数/文件数/目录数/已知字节）来自索引；系统口径
//!   `SHQueryRecycleBinW` 的结果单独保存为 `system_*` 字段，两者不混用。

use rusqlite::{params, Connection};

use crate::error::AppResult;

/// 迁移 68：回收站索引表（只追加，不改已发布迁移）。
pub const MIGRATION_68: (i64, &str) = (
    68,
    r#"
CREATE TABLE IF NOT EXISTS recycle_index (
    bin_root      TEXT NOT NULL,
    record_key    TEXT NOT NULL,
    volume        TEXT NOT NULL,
    data_name     TEXT NOT NULL,
    original_path TEXT NOT NULL,
    file_name     TEXT NOT NULL,
    is_dir        INTEGER NOT NULL,
    size          INTEGER NOT NULL,
    size_known    INTEGER NOT NULL,
    deleted_ms    INTEGER NOT NULL,
    state         TEXT NOT NULL,
    anomaly       TEXT,
    meta_len      INTEGER NOT NULL,
    meta_mtime_ms INTEGER NOT NULL,
    scanned_ms    INTEGER NOT NULL,
    PRIMARY KEY (bin_root, record_key)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS recycle_idx_volume_deleted ON recycle_index(volume, deleted_ms DESC);
CREATE INDEX IF NOT EXISTS recycle_idx_deleted ON recycle_index(deleted_ms DESC);
CREATE INDEX IF NOT EXISTS recycle_idx_size ON recycle_index(size DESC);
CREATE INDEX IF NOT EXISTS recycle_idx_name ON recycle_index(file_name COLLATE NOCASE);
CREATE TABLE IF NOT EXISTS recycle_volume_state (
    bin_root          TEXT PRIMARY KEY,
    volume            TEXT NOT NULL,
    last_sync_ms      INTEGER NOT NULL,
    last_attempt_ms   INTEGER NOT NULL,
    state             TEXT NOT NULL,
    item_count        INTEGER NOT NULL,
    known_bytes       INTEGER NOT NULL,
    unknown_size      INTEGER NOT NULL,
    error_code        TEXT,
    system_items      INTEGER,
    system_bytes      INTEGER,
    system_checked_ms INTEGER
) WITHOUT ROWID;
"#,
);

/// 让默认翻页读有序索引，让统计聚合只读窄列。
pub const MIGRATION_70: (i64, &str) = (70, r#"
DROP INDEX IF EXISTS recycle_idx_deleted;
DROP INDEX IF EXISTS recycle_idx_volume_deleted;
CREATE INDEX recycle_idx_deleted ON recycle_index(deleted_ms, record_key, bin_root);
CREATE INDEX recycle_idx_volume_deleted ON recycle_index(volume, deleted_ms, record_key, bin_root);
CREATE INDEX recycle_idx_volume_stats ON recycle_index(volume, is_dir, size_known, size);
"#);

/// 本应用成功移动/删除过的条目的墓碑（原「恢复后残留元数据」表）。
///
/// 键 + `$I` 指纹唯一确定一条记录：扫描拿到的是**旧快照**时，若该键已在本应用
/// 的操作中恢复或永久删除（指纹一致），必须抑制回写，不能让旧快照把刚完成的
/// 真实操作结果覆盖回去。指纹变化说明键被系统复用，墓碑随即失效
/// （见 `forget_tombstones`）。因此不新增迁移，直接把这张表用作统一墓碑。
pub const MIGRATION_71: (i64, &str) = (71, r#"
CREATE TABLE IF NOT EXISTS recycle_restored_metadata (
    bin_root TEXT NOT NULL,
    record_key TEXT NOT NULL,
    meta_len INTEGER NOT NULL,
    meta_mtime_ms INTEGER NOT NULL,
    PRIMARY KEY (bin_root, record_key)
) WITHOUT ROWID;
"#);

/// 单条索引记录在界面上的状态。
pub const STATE_PRESENT: &str = "present";
/// `$I` 存在但 `$R` 数据不存在（元数据孤儿）。
pub const STATE_MISSING_DATA: &str = "missing_data";
/// `$I` 本身损坏/不可读，条目仍保留（用户可见并可在磁盘上核查）。
pub const STATE_UNREADABLE: &str = "unreadable";

/// 分页查询参数（IPC camelCase）。
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecycleQuery {
    #[serde(default)]
    pub search: String,
    /// all | file | folder
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub volume: Option<String>,
    #[serde(default)]
    pub min_size: Option<i64>,
    #[serde(default)]
    pub max_size: Option<i64>,
    #[serde(default)]
    pub deleted_after_ms: Option<i64>,
    #[serde(default)]
    pub deleted_before_ms: Option<i64>,
    /// deleted | name | size | path | volume
    #[serde(default)]
    pub sort: String,
    /// asc | desc
    #[serde(default)]
    pub dir: String,
    #[serde(default)]
    pub offset: usize,
    #[serde(default)]
    pub limit: usize,
    /// 只看有数据 / 缺少数据 / 损坏
    #[serde(default)]
    pub state: Option<String>,
    /// 是否返回全表聚合统计。翻页时不必每次重算（10 万级是两次全表扫描），
    /// 默认 `true` 保持既有调用方语义；前端只在首页/刷新时请求。
    #[serde(default = "default_include_stats")]
    pub include_stats: bool,
}

fn default_include_stats() -> bool {
    true
}

impl Default for RecycleQuery {
    fn default() -> Self {
        Self {
            search: String::new(),
            kind: "all".into(),
            volume: None,
            min_size: None,
            max_size: None,
            deleted_after_ms: None,
            deleted_before_ms: None,
            sort: "deleted".into(),
            dir: "desc".into(),
            offset: 0,
            limit: 200,
            state: None,
            include_stats: true,
        }
    }
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecycleItem {
    /// 不透明操作 ID：`volume|record_key`。不暴露 bin_root（含用户 SID）。
    pub id: String,
    pub volume: String,
    pub name: String,
    pub original_path: String,
    pub is_dir: bool,
    /// 未知（目录）为 None，前端显示 `—`。
    pub size: Option<i64>,
    pub deleted_ms: i64,
    /// present | missing_data | unreadable
    pub state: String,
    pub anomaly: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecycleVolumeStat {
    pub volume: String,
    pub items: i64,
    pub files: i64,
    pub folders: i64,
    pub known_bytes: i64,
    pub unknown_size: i64,
    /// ok | partial | offline | error | scanning | stale
    pub state: String,
    pub last_sync_ms: i64,
    /// 系统口径（Shell）条数与大小；可能长时间未刷新。
    pub system_items: Option<i64>,
    pub system_bytes: Option<i64>,
    pub system_checked_ms: Option<i64>,
    pub error_code: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecycleStats {
    pub items: i64,
    pub files: i64,
    pub folders: i64,
    pub known_bytes: i64,
    pub unknown_size: i64,
    pub volumes: Vec<RecycleVolumeStat>,
    pub last_sync_ms: i64,
    /// empty | ready | scanning | partial | offline | error
    pub state: String,
    /// 数据来源标记：index（本地索引） | system（Shell 口径）
    pub source: String,
    /// 索引最后写入时间；0 表示尚未建立。
    pub indexed_at_ms: i64,
    /// 正在后台同步的卷数量（>0 时界面显示「同步中」）。
    pub syncing: i64,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecyclePage {
    pub items: Vec<RecycleItem>,
    pub total: i64,
    pub offset: usize,
    pub limit: usize,
    /// 仅在 `query.include_stats` 为真时返回；翻页时为 `null`，避免重复全表聚合。
    pub stats: Option<RecycleStats>,
    /// 查询耗时（毫秒，后端实测，供性能验收记录）。
    pub query_ms: u64,
}

/// 扫描阶段写入的一条记录。
#[derive(Debug, Clone)]
pub struct IndexItem {
    pub record_key: String,
    pub data_name: String,
    pub volume: String,
    pub original_path: String,
    pub file_name: String,
    pub is_dir: bool,
    pub size: i64,
    pub size_known: bool,
    pub deleted_ms: i64,
    pub state: String,
    pub anomaly: Option<String>,
    pub meta_len: i64,
    pub meta_mtime_ms: i64,
}

pub fn init_schema(conn: &Connection) -> AppResult<()> {
    conn.execute_batch(MIGRATION_68.1)?;
    conn.execute_batch(MIGRATION_70.1)?;
    conn.execute_batch(MIGRATION_71.1)?;
    Ok(())
}

fn like_pattern(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    // 转义 LIKE 元字符，避免用户输入 `%` 变成全表匹配。
    let mut escaped = String::with_capacity(trimmed.len() + 2);
    escaped.push('%');
    for ch in trimmed.chars() {
        if matches!(ch, '%' | '_' | '\\') {
            escaped.push('\\');
        }
        escaped.push(ch);
    }
    escaped.push('%');
    Some(escaped)
}

fn kind_clause(kind: &str) -> Option<&'static str> {
    match kind {
        "file" => Some("is_dir = 0"),
        "folder" => Some("is_dir = 1"),
        _ => None,
    }
}

fn state_clause(state: &str) -> Option<&'static str> {
    match state {
        "present" => Some("state = 'present'"),
        "missing" => Some("state = 'missing_data'"),
        "unreadable" => Some("state = 'unreadable'"),
        _ => None,
    }
}

/// 分页查询 + 统计。所有过滤都在 SQL 完成。
pub fn page(conn: &Connection, query: &RecycleQuery) -> AppResult<RecyclePage> {
    let started = std::time::Instant::now();
    let limit = query.limit.clamp(1, 500);
    let offset = query.offset.min(50_000_000);

    let mut where_sql = String::from(" WHERE 1=1");
    let mut args: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

    if let Some(pattern) = like_pattern(&query.search) {
        where_sql.push_str(" AND (file_name LIKE ? ESCAPE '\\' OR original_path LIKE ? ESCAPE '\\')");
        args.push(Box::new(pattern.clone()));
        args.push(Box::new(pattern));
    }
    if let Some(clause) = kind_clause(&query.kind) {
        where_sql.push_str(" AND ");
        where_sql.push_str(clause);
    }
    if let Some(clause) = state_clause(query.state.as_deref().unwrap_or("")) {
        where_sql.push_str(" AND ");
        where_sql.push_str(clause);
    }
    if let Some(volume) = query.volume.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
        where_sql.push_str(" AND volume = ?");
        args.push(Box::new(volume.to_string()));
    }
    if let Some(min) = query.min_size {
        where_sql.push_str(" AND size_known = 1 AND size >= ?");
        args.push(Box::new(min));
    }
    if let Some(max) = query.max_size {
        where_sql.push_str(" AND size_known = 1 AND size <= ?");
        args.push(Box::new(max));
    }
    if let Some(after) = query.deleted_after_ms {
        where_sql.push_str(" AND deleted_ms >= ?");
        args.push(Box::new(after));
    }
    if let Some(before) = query.deleted_before_ms {
        where_sql.push_str(" AND deleted_ms <= ?");
        args.push(Box::new(before));
    }

    let order = match query.sort.as_str() {
        "name" => "file_name COLLATE NOCASE",
        "size" => "size",
        "path" => "original_path COLLATE NOCASE",
        "volume" => "volume",
        _ => "deleted_ms",
    };
    let direction = if query.dir.eq_ignore_ascii_case("asc") {
        "ASC"
    } else {
        "DESC"
    };

    let where_sql = if where_sql == " WHERE 1=1" { "" } else { where_sql.as_str() };
    // 同方向次序允许正反扫描同一个索引。bin_root 让跨卷同名记录也有稳定次序。
    let tie_direction = if order == "deleted_ms" { direction } else { "ASC" };
    let total: i64 = {
        let sql = format!("SELECT COUNT(*) FROM recycle_index{where_sql}");
        let mut stmt = conn.prepare(&sql)?;
        let refs: Vec<&dyn rusqlite::ToSql> = args.iter().map(|b| b.as_ref()).collect();
        stmt.query_row(refs.as_slice(), |row| row.get(0))?
    };

    let mut items = Vec::with_capacity(limit);
    if total > offset as i64 {
        let sql = if order == "deleted_ms" {
            // OFFSET traverses only keys. CROSS JOIN keeps the page keys as the outer loop,
            // so SQLite cannot scan the full payload index to satisfy ORDER BY.
            format!(
                "WITH keys AS MATERIALIZED (
                     SELECT bin_root, record_key FROM recycle_index{where_sql}
                     ORDER BY deleted_ms {direction}, record_key {direction}, bin_root {direction}
                     LIMIT ? OFFSET ?
                 )
                 SELECT r.volume, r.record_key, r.file_name, r.original_path, r.is_dir, r.size,
                        r.size_known, r.deleted_ms, r.state, r.anomaly
                 FROM keys k CROSS JOIN recycle_index r USING (bin_root, record_key)
                 ORDER BY r.deleted_ms {direction}, r.record_key {direction}, r.bin_root {direction}"
            )
        } else {
            format!(
            "SELECT volume, record_key, file_name, original_path, is_dir, size, size_known, \
             deleted_ms, state, anomaly FROM recycle_index{where_sql} \
             ORDER BY {order} {direction}, record_key {tie_direction}, bin_root {tie_direction} LIMIT ? OFFSET ?"
            )
        };
        let mut stmt = conn.prepare(&sql)?;
        let mut refs: Vec<&dyn rusqlite::ToSql> = args.iter().map(|b| b.as_ref()).collect();
        let limit_sql = limit as i64;
        let offset_sql = offset as i64;
        refs.push(&limit_sql);
        refs.push(&offset_sql);

        let rows = stmt.query_map(refs.as_slice(), |row| {
            let volume: String = row.get(0)?;
            let record_key: String = row.get(1)?;
            let is_dir: i64 = row.get(4)?;
            let size: i64 = row.get(5)?;
            let size_known: i64 = row.get(6)?;
            Ok(RecycleItem {
                id: format!("{volume}|{record_key}"),
                volume,
                name: row.get(2)?,
                original_path: row.get(3)?,
                is_dir: is_dir != 0,
                size: (size_known != 0).then_some(size),
                deleted_ms: row.get(7)?,
                state: row.get(8)?,
                anomaly: row.get(9)?,
            })
        })?;
        for row in rows {
            items.push(row?);
        }
    }

    let stats = if query.include_stats {
        Some(stats(conn)?)
    } else {
        None
    };
    Ok(RecyclePage {
        items,
        total,
        offset,
        limit,
        stats,
        query_ms: started.elapsed().as_millis() as u64,
    })
}

/// 聚合统计：纯索引口径，毫秒级；不触发任何文件系统扫描。
pub fn stats(conn: &Connection) -> AppResult<RecycleStats> {
    let mut groups = std::collections::HashMap::new();
    let mut totals = [0i64; 5];
    {
        let mut stmt = conn.prepare(
            "SELECT volume, COUNT(*),
                    SUM(CASE WHEN is_dir = 0 THEN 1 ELSE 0 END),
                    SUM(CASE WHEN is_dir = 1 THEN 1 ELSE 0 END),
                    SUM(CASE WHEN size_known = 1 THEN size ELSE 0 END),
                    SUM(CASE WHEN size_known = 0 THEN 1 ELSE 0 END)
             FROM recycle_index GROUP BY volume",
        )?;
        let mut rows = stmt.query([])?;
        while let Some(row) = rows.next()? {
            let volume: String = row.get(0)?;
            let counts = [row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?];
            for (total, count) in totals.iter_mut().zip(counts) {
                *total = total.saturating_add(count);
            }
            groups.insert(volume, counts);
        }
    }
    let [items, files, folders, known_bytes, unknown_size] = totals;

    let mut stmt = conn.prepare(
        "SELECT volume, state, last_sync_ms, error_code, system_items, system_bytes, system_checked_ms
         FROM recycle_volume_state ORDER BY volume ASC",
    )?;
    let volumes = stmt
        .query_map([], |row| {
            let volume: String = row.get(0)?;
            let [items, files, folders, known_bytes, unknown_size] =
                groups.get(&volume).copied().unwrap_or_default();
            Ok(RecycleVolumeStat {
                volume,
                state: row.get(1)?,
                last_sync_ms: row.get(2)?,
                error_code: row.get(3)?,
                system_items: row.get(4)?,
                system_bytes: row.get(5)?,
                system_checked_ms: row.get(6)?,
                items,
                files,
                folders,
                known_bytes,
                unknown_size,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let overall_state = if volumes.iter().any(|v| v.state == "scanning") {
        "scanning"
    } else if volumes.is_empty() && items == 0 {
        "empty"
    } else if volumes.iter().any(|v| v.state == "error") {
        "error"
    } else if volumes.iter().any(|v| v.state == "offline") {
        "offline"
    } else if volumes.iter().any(|v| v.state == "partial") {
        "partial"
    } else if volumes.iter().any(|v| v.state == "stale") {
        // 缓存仍在，但已知与真实回收站不一致：如实呈现为不完整，不冒充最新。
        "partial"
    } else {
        "ready"
    };
    let last_sync = volumes.iter().map(|v| v.last_sync_ms).max().unwrap_or(0);
    let syncing = volumes.iter().filter(|v| v.state == "scanning").count() as i64;
    let indexed_at = volumes.iter().map(|v| v.last_sync_ms).max().unwrap_or(0);

    Ok(RecycleStats {
        items,
        files,
        folders,
        known_bytes,
        unknown_size,
        volumes,
        last_sync_ms: last_sync,
        state: overall_state.into(),
        source: "index".into(),
        indexed_at_ms: indexed_at,
        syncing,
    })
}

/// 已有索引行的轻量指纹：判断「`$I` 是否变化」以及「`$R` 是否变化」。
#[derive(Debug, Clone)]
pub struct Fingerprint {
    pub meta_len: i64,
    pub meta_mtime_ms: i64,
    pub state: String,
    pub is_dir: bool,
}

/// 读取某卷已有索引的指纹。用于增量同步时判断哪些 `$I` 真正发生变化，
/// 避免重复解析。
pub fn existing_fingerprints(
    conn: &Connection,
    bin_root: &str,
) -> AppResult<std::collections::HashMap<String, Fingerprint>> {
    let mut stmt = conn.prepare(
        "SELECT record_key, meta_len, meta_mtime_ms, state, is_dir FROM recycle_index WHERE bin_root = ?1",
    )?;
    let rows = stmt.query_map(params![bin_root], |row| {
        Ok((
            row.get::<_, String>(0)?,
            Fingerprint {
                meta_len: row.get(1)?,
                meta_mtime_ms: row.get(2)?,
                state: row.get(3)?,
                is_dir: row.get::<_, i64>(4)? != 0,
            },
        ))
    })?;
    let mut out = std::collections::HashMap::new();
    for row in rows {
        let (key, fingerprint) = row?;
        out.insert(key, fingerprint);
    }
    Ok(out)
}

/// 批量写入（单事务）。返回实际写入条数。
///
/// 墓碑抑制：只要 `(bin_root, record_key)` 与墓碑指纹一致，任何状态的回写都被
/// 丢弃（不仅是 `missing_data`）。这样「扫描快照早于操作、写入晚于操作」时，
/// 旧快照不会把刚恢复/刚永久删除的条目重新写回索引。
pub fn upsert_items(
    conn: &Connection,
    bin_root: &str,
    items: &[IndexItem],
) -> AppResult<usize> {
    if items.is_empty() {
        return Ok(0);
    }
    let tx = conn.unchecked_transaction()?;
    let mut written = 0;
    {
        let mut stmt = tx.prepare_cached(
            "INSERT INTO recycle_index \
             (bin_root, record_key, volume, data_name, original_path, file_name, is_dir, size, \
              size_known, deleted_ms, state, anomaly, meta_len, meta_mtime_ms, scanned_ms) \
             SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15 \
             WHERE NOT EXISTS (SELECT 1 FROM recycle_restored_metadata \
               WHERE bin_root = ?1 AND record_key = ?2 AND meta_len = ?13 AND meta_mtime_ms = ?14) \
             ON CONFLICT(bin_root, record_key) DO UPDATE SET \
              volume = excluded.volume, data_name = excluded.data_name, \
              original_path = excluded.original_path, file_name = excluded.file_name, \
              is_dir = excluded.is_dir, size = excluded.size, size_known = excluded.size_known, \
              deleted_ms = excluded.deleted_ms, state = excluded.state, anomaly = excluded.anomaly, \
              meta_len = excluded.meta_len, meta_mtime_ms = excluded.meta_mtime_ms, \
              scanned_ms = excluded.scanned_ms",
        )?;
        let now = chrono::Utc::now().timestamp_millis();
        for item in items {
            written += stmt.execute(params![
                bin_root,
                item.record_key,
                item.volume,
                item.data_name,
                item.original_path,
                item.file_name,
                item.is_dir as i64,
                item.size,
                item.size_known as i64,
                item.deleted_ms,
                item.state,
                item.anomaly,
                item.meta_len,
                item.meta_mtime_ms,
                now,
            ])?;
        }
    }
    tx.commit()?;
    Ok(written)
}

/// 删除索引中已不存在的记录（分批，避免一次性构造巨大的 NOT IN）。
pub fn delete_records(conn: &Connection, bin_root: &str, keys: &[String]) -> AppResult<usize> {
    if keys.is_empty() {
        return Ok(0);
    }
    let mut removed = 0usize;
    for chunk in keys.chunks(400) {
        let tx = conn.unchecked_transaction()?;
        {
            let mut stmt = tx.prepare(
                "DELETE FROM recycle_index WHERE bin_root = ?1 AND record_key = ?2",
            )?;
            for key in chunk {
                removed += stmt.execute(params![bin_root, key])?;
            }
        }
        tx.commit()?;
    }
    Ok(removed)
}

/// 记录墓碑并移除索引行：系统操作**已成功**后才调用。
///
/// 墓碑在系统结果与缓存结果之间建立对账锚点：一旦索引写入失败，下一次同步
/// 仍能从 `$I`/`$R` 的真实状态重建，且旧扫描快照无法把该条写回。
/// 表中原有「恢复」语义由所有移动/删除操作共享。
pub fn mark_removed(conn: &Connection, bin_root: &str, key: &str) -> AppResult<()> {
    mark_removed_batch(conn, &[(bin_root.to_string(), key.to_string())]).map(|_| ())
}

/// 同一批次内一次性写墓碑并删除索引行：单事务提交，避免逐项 fsync。
///
/// 生产库使用 WAL + 默认 synchronous，逐条事务在本机实测约 20ms/条；
/// 恢复/永久删除按 40 项一批处理，批量写入把提交次数降到 1/40。
pub fn mark_removed_batch(conn: &Connection, entries: &[(String, String)]) -> AppResult<usize> {
    if entries.is_empty() {
        return Ok(0);
    }
    let tx = conn.unchecked_transaction()?;
    let mut removed = 0usize;
    {
        let mut insert = tx.prepare_cached(
            "INSERT OR REPLACE INTO recycle_restored_metadata
             SELECT bin_root, record_key, meta_len, meta_mtime_ms FROM recycle_index
             WHERE bin_root = ?1 AND record_key = ?2",
        )?;
        let mut delete = tx.prepare_cached(
            "DELETE FROM recycle_index WHERE bin_root = ?1 AND record_key = ?2",
        )?;
        for (bin_root, key) in entries {
            insert.execute(params![bin_root, key])?;
            removed += delete.execute(params![bin_root, key])?;
        }
    }
    tx.commit()?;
    Ok(removed)
}

/// 某卷全部墓碑指纹（键 → `$I` 指纹）。
pub fn tombstone_fingerprints(conn: &Connection, bin_root: &str) -> AppResult<std::collections::HashMap<String, (i64, i64)>> {
    let mut stmt = conn.prepare(
        "SELECT record_key, meta_len, meta_mtime_ms FROM recycle_restored_metadata WHERE bin_root = ?1",
    )?;
    let rows = stmt.query_map([bin_root], |row| Ok((row.get(0)?, (row.get(1)?, row.get(2)?))))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// 丢弃指纹已变化的墓碑：同一键被系统复用为新条目时，旧墓碑必须失效。
pub fn forget_tombstones(
    conn: &Connection,
    bin_root: &str,
    fingerprints: Vec<(&String, &(i64, i64))>,
) -> AppResult<()> {
    if fingerprints.is_empty() {
        return Ok(());
    }
    let tx = conn.unchecked_transaction()?;
    {
        let mut stmt = tx.prepare(
            "DELETE FROM recycle_restored_metadata WHERE bin_root = ?1 AND record_key = ?2
             AND meta_len = ?3 AND meta_mtime_ms = ?4",
        )?;
        for (key, (len, mtime)) in fingerprints {
            stmt.execute(params![bin_root, key, len, mtime])?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// 清空某卷索引（完整重建时使用；只影响缓存，不影响真实回收站）。
pub fn clear_volume(conn: &Connection, bin_root: &str) -> AppResult<usize> {
    let removed = conn.execute("DELETE FROM recycle_index WHERE bin_root = ?1", params![bin_root])?;
    Ok(removed)
}

/// 写入同步状态。`system_*` 为 `None` 时保留旧值（系统统计可能比索引更旧）。
#[allow(clippy::too_many_arguments)]
pub fn set_state(
    conn: &Connection,
    bin_root: &str,
    volume: &str,
    state: &str,
    items: i64,
    known_bytes: i64,
    unknown_size: i64,
    error_code: Option<&str>,
    attempted_ms: i64,
) -> AppResult<()> {
    let synced = if state == "ok" || state == "partial" {
        attempted_ms
    } else {
        0
    };
    conn.execute(
        "INSERT INTO recycle_volume_state \
         (bin_root, volume, last_sync_ms, last_attempt_ms, state, item_count, known_bytes, \
          unknown_size, error_code) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) \
         ON CONFLICT(bin_root) DO UPDATE SET \
          volume = excluded.volume, last_sync_ms = CASE WHEN excluded.last_sync_ms > 0 \
             THEN excluded.last_sync_ms ELSE recycle_volume_state.last_sync_ms END, \
          last_attempt_ms = excluded.last_attempt_ms, state = excluded.state, \
          /* 离线/失败/扫描中不得把已有缓存计数清零：缓存仍需可浏览 */ \
          item_count = CASE WHEN excluded.state IN ('ok', 'partial') \
             THEN excluded.item_count ELSE recycle_volume_state.item_count END, \
          known_bytes = CASE WHEN excluded.state IN ('ok', 'partial') \
             THEN excluded.known_bytes ELSE recycle_volume_state.known_bytes END, \
          unknown_size = CASE WHEN excluded.state IN ('ok', 'partial') \
             THEN excluded.unknown_size ELSE recycle_volume_state.unknown_size END, \
          error_code = excluded.error_code",
        params![
            bin_root,
            volume,
            synced,
            attempted_ms,
            state,
            items,
            known_bytes,
            unknown_size,
            error_code
        ],
    )?;
    Ok(())
}

/// 记录系统口径统计（后台刷新；不覆盖索引统计）。
pub fn set_system_totals(
    conn: &Connection,
    bin_root: &str,
    items: i64,
    bytes: i64,
    checked_ms: i64,
) -> AppResult<()> {
    conn.execute(
        "UPDATE recycle_volume_state SET system_items = ?2, system_bytes = ?3, \
         system_checked_ms = ?4 WHERE bin_root = ?1",
        params![bin_root, items, bytes, checked_ms],
    )?;
    Ok(())
}

/// 把卷标记为 scanning（只更新状态与尝试时间）。
pub fn mark_scanning(conn: &Connection, bin_root: &str, volume: &str) -> AppResult<()> {
    conn.execute(
        "INSERT INTO recycle_volume_state \
         (bin_root, volume, last_sync_ms, last_attempt_ms, state, item_count, known_bytes, \
          unknown_size) VALUES (?1, ?2, 0, ?3, 'scanning', 0, 0, 0) \
         ON CONFLICT(bin_root) DO UPDATE SET state = 'scanning', last_attempt_ms = excluded.last_attempt_ms",
        params![bin_root, volume, chrono::Utc::now().timestamp_millis()],
    )?;
    Ok(())
}

/// 解析操作目标：`id = volume|record_key` → 索引中的定位信息。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedItem {
    pub id: String,
    pub bin_root: String,
    pub record_key: String,
    /// `$R` 数据文件名（扫描时实际观察到的名称，用于定位 Shell 项目）。
    pub data_name: String,
    pub volume: String,
    pub original_path: String,
    pub name: String,
    pub is_dir: bool,
    pub size: Option<i64>,
    pub state: String,
    /// 扫描登记的异常标记（`ORPHAN_DATA` / 元数据损坏原因）；决定异常条目的处置文案。
    pub anomaly: Option<String>,
}

/// 该索引状态能否交给 Windows Shell 执行「真正的删除 / 恢复」。
///
/// `missing_data`（`$I` 在、`$R` 已不存在）与 `unreadable`（元数据损坏，或只有 `$R`
/// 的孤儿）都不能走 Shell：前者没有数据可删，后者定位不可信。它们只能「从索引移除」，
/// 且必须向用户说明这不是磁盘数据清理。
pub fn supports_native_action(state: &str) -> bool {
    state == STATE_PRESENT
}

/// 无法执行的一条请求：必须逐项反馈，不能悄悄缩小操作范围。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnresolvedItem {
    pub id: String,
    /// INVALID_ID | NOT_FOUND | AMBIGUOUS | DUPLICATE
    pub code: &'static str,
    pub message: &'static str,
}

#[derive(Debug, Clone, Default)]
pub struct ResolveOutcome {
    pub items: Vec<ResolvedItem>,
    pub unresolved: Vec<UnresolvedItem>,
}

/// 逐项解析 ID：返回可执行条目与**全部**不可执行条目（含重复 ID）。
/// 调用方必须把 `unresolved` 作为失败结果逐项反馈给用户。
///
/// 性能：`volume` 不是主键列，逐条 `WHERE volume = ? AND record_key = ?`
/// 会在每个 ID 上扫描该卷全部行（10 万条 × 2 万 ID 实测 617 秒）。这里按卷
/// 分组、每 400 个键一次 `IN` 查询，只依赖现有 `(volume, ...)` 索引前缀，
/// 不需新增迁移，耗时降到秒级。
pub fn resolve(conn: &Connection, ids: &[String]) -> AppResult<ResolveOutcome> {
    use std::collections::HashMap;

    let mut outcome = ResolveOutcome::default();
    let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
    // (原始 id, volume, record_key)
    let mut wanted: Vec<(&str, &str, &str)> = Vec::with_capacity(ids.len());
    for id in ids {
        if !seen.insert(id.as_str()) {
            outcome.unresolved.push(UnresolvedItem {
                id: id.clone(),
                code: "DUPLICATE",
                message: "同一请求中重复出现，已跳过重复项",
            });
            continue;
        }
        let Some((volume, record_key)) = id.split_once('|') else {
            outcome.unresolved.push(UnresolvedItem {
                id: id.clone(),
                code: "INVALID_ID",
                message: "项目 ID 格式无效",
            });
            continue;
        };
        wanted.push((id.as_str(), volume, record_key));
    }

    let mut by_volume: HashMap<&str, Vec<&str>> = HashMap::new();
    for (_, volume, key) in &wanted {
        by_volume.entry(volume).or_default().push(key);
    }
    let mut found: HashMap<(String, String), Vec<ResolvedItem>> = HashMap::new();
    for (volume, keys) in by_volume {
        for chunk in keys.chunks(400) {
            let placeholders = (0..chunk.len())
                .map(|index| format!("?{}", index + 2))
                .collect::<Vec<_>>()
                .join(", ");
            let sql = format!(
                "SELECT bin_root, record_key, data_name, volume, original_path, file_name, is_dir, \
                 size, size_known, state, anomaly FROM recycle_index \
                 WHERE volume = ?1 AND record_key IN ({placeholders})"
            );
            let mut stmt = conn.prepare_cached(&sql)?;
            let mut values: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(chunk.len() + 1);
            values.push(&volume);
            for key in chunk {
                values.push(key);
            }
            let rows = stmt.query_map(values.as_slice(), |row| {
                let size: i64 = row.get(7)?;
                let known: i64 = row.get(8)?;
                let volume: String = row.get(3)?;
                let record_key: String = row.get(1)?;
                Ok((
                    (volume, record_key),
                    ResolvedItem {
                        id: String::new(),
                        bin_root: row.get(0)?,
                        record_key: row.get(1)?,
                        data_name: row.get(2)?,
                        volume: row.get(3)?,
                        original_path: row.get(4)?,
                        name: row.get(5)?,
                        is_dir: row.get::<_, i64>(6)? != 0,
                        size: (known != 0).then_some(size),
                        state: row.get(9)?,
                        anomaly: row.get(10)?,
                    },
                ))
            })?;
            for row in rows {
                let (key, mut item) = row?;
                item.id = format!("{}|{}", key.0, key.1);
                found.entry(key).or_default().push(item);
            }
        }
    }

    for (id, volume, record_key) in wanted {
        match found.remove(&(volume.to_string(), record_key.to_string())) {
            None => outcome.unresolved.push(UnresolvedItem {
                id: id.to_string(),
                code: "NOT_FOUND",
                message: "索引中不存在该项目，请先同步回收站",
            }),
            Some(items) if items.len() > 1 => outcome.unresolved.push(UnresolvedItem {
                id: id.to_string(),
                code: "AMBIGUOUS",
                message: "该项目在索引中不唯一，请先同步回收站",
            }),
            Some(mut items) => {
                let mut item = items.pop().expect("非空");
                item.id = id.to_string();
                outcome.items.push(item);
            }
        }
    }
    Ok(outcome)
}

/// 把某卷标记为「缓存不可信，需要重新对账」。
///
/// 不是删除缓存：离线/损坏时仍要可浏览；只是让下一次同步优先重建该卷，
/// 并在统计中如实呈现为 `stale`（不伪装成最新）。
pub fn mark_reconcile_required(
    conn: &Connection,
    bin_root: &str,
    volume: &str,
    reason: &str,
) -> AppResult<()> {
    conn.execute(
        "INSERT INTO recycle_volume_state \
         (bin_root, volume, last_sync_ms, last_attempt_ms, state, item_count, known_bytes, \
          unknown_size, error_code) VALUES (?1, ?2, 0, ?3, 'stale', 0, 0, 0, ?4) \
         ON CONFLICT(bin_root) DO UPDATE SET state = 'stale', error_code = excluded.error_code",
        params![bin_root, volume, chrono::Utc::now().timestamp_millis(), reason],
    )?;
    Ok(())
}

/// 需要重新对账的卷（`bin_root` 列表）。
pub fn pending_reconcile(conn: &Connection) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare("SELECT bin_root FROM recycle_volume_state WHERE state = 'stale'")?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// 索引中是否存在某条目（用于操作后即时校验）。
pub fn contains(conn: &Connection, bin_root: &str, record_key: &str) -> AppResult<bool> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM recycle_index WHERE bin_root = ?1 AND record_key = ?2",
        params![bin_root, record_key],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;

    fn insert(conn: &Connection, key: &str, volume: &str, name: &str, size: Option<i64>) {
        let items = vec![IndexItem {
            record_key: key.to_string(),
            data_name: format!("$R{key}"),
            volume: volume.into(),
            original_path: format!(r"{volume}\dir\{name}"),
            file_name: name.into(),
            is_dir: size.is_none(),
            size: size.unwrap_or(0),
            size_known: size.is_some(),
            deleted_ms: 1_700_000_000_000,
            state: STATE_PRESENT.into(),
            anomaly: None,
            meta_len: 100,
            meta_mtime_ms: 10,
        }];
        upsert_items(conn, r"D:\$Recycle.Bin\S-1", &items).unwrap();
    }

    #[test]
    fn page_filters_search_sort_and_pagination() {
        let db = Db::open_in_memory().unwrap();
        db.with_conn(|conn| {
            insert(conn, "A.doc", "D:", "季度 报告.doc", Some(1024));
            insert(conn, "B.xlsx", "D:", "预算.xlsx", Some(2048));
            insert(conn, "C", "C:", "安装包", None);
            let q = RecycleQuery {
                search: "报告".into(),
                ..Default::default()
            };
            let page = super::page(conn, &q).unwrap();
            assert_eq!(page.total, 1);
            assert_eq!(page.items[0].name, "季度 报告.doc");
            assert_eq!(page.items[0].size, Some(1024));

            let q = RecycleQuery {
                kind: "folder".into(),
                ..Default::default()
            };
            assert_eq!(super::page(conn, &q).unwrap().total, 1);

            let q = RecycleQuery {
                sort: "size".into(),
                dir: "desc".into(),
                limit: 1,
                ..Default::default()
            };
            let page = super::page(conn, &q).unwrap();
            assert_eq!(page.total, 3);
            assert_eq!(page.items.len(), 1);
            assert_eq!(page.items[0].size, Some(2048));

            let q = RecycleQuery {
                volume: Some("C:".into()),
                ..Default::default()
            };
            assert_eq!(super::page(conn, &q).unwrap().total, 1);
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn tombstone_suppresses_stale_present_snapshot_after_operation() {
        let db = Db::open_in_memory().unwrap();
        db.with_conn(|conn| {
            let bin_root = r"D:\$Recycle.Bin\S-1";
            insert(conn, "A", "D:", "A", Some(10));
            // 系统操作成功后才写墓碑（恢复/永久删除共用）。
            mark_removed(conn, bin_root, "A")?;
            assert_eq!(page(conn, &RecycleQuery::default())?.total, 0);
            // 旧扫描快照（同一 `$I` 指纹、present）不得把记录写回。
            let stale = IndexItem {
                record_key: "A".into(), data_name: "$RA".into(), volume: "D:".into(),
                original_path: r"D:\dir\A".into(), file_name: "A".into(), is_dir: false,
                size: 10, size_known: true, deleted_ms: 1, state: STATE_PRESENT.into(),
                anomaly: None, meta_len: 100, meta_mtime_ms: 10,
            };
            assert_eq!(upsert_items(conn, bin_root, std::slice::from_ref(&stale))?, 0);
            assert_eq!(page(conn, &RecycleQuery::default())?.total, 0);
            // 键被系统复用（指纹变化）：墓碑失效，新记录正常入库。
            let reused = IndexItem { meta_len: 101, meta_mtime_ms: 11, ..stale };
            assert_eq!(upsert_items(conn, bin_root, std::slice::from_ref(&reused))?, 1);
            assert_eq!(page(conn, &RecycleQuery::default())?.total, 1);
            Ok(())
        }).unwrap();
    }

    #[test]
    fn tombstone_suppresses_matching_missing_data_too() {
        let db = Db::open_in_memory().unwrap();
        db.with_conn(|conn| {
            let bin_root = r"D:\$Recycle.Bin\S-1";
            insert(conn, "A", "D:", "A", Some(10));
            mark_removed(conn, bin_root, "A")?;
            let orphan = IndexItem {
                record_key: "A".into(), data_name: "$RA".into(), volume: "D:".into(),
                original_path: r"D:\dir\A".into(), file_name: "A".into(), is_dir: false,
                size: 10, size_known: true, deleted_ms: 1, state: STATE_MISSING_DATA.into(),
                anomaly: None, meta_len: 100, meta_mtime_ms: 10,
            };
            assert_eq!(upsert_items(conn, bin_root, &[orphan])?, 0);
            assert_eq!(page(conn, &RecycleQuery::default())?.total, 0);
            Ok(())
        }).unwrap();
    }

    #[test]
    fn stale_volume_is_reported_as_partial_and_reconcile_is_pending() {
        let db = Db::open_in_memory().unwrap();
        db.with_conn(|conn| {
            let bin_root = r"D:\$Recycle.Bin\S-1";
            mark_reconcile_required(conn, bin_root, "D:", "INDEX_UPDATE_FAILED")?;
            assert_eq!(pending_reconcile(conn)?, vec![bin_root.to_string()]);
            let stats = super::stats(conn)?;
            assert_eq!(stats.state, "partial");
            assert_eq!(stats.volumes[0].state, "stale");
            assert_eq!(stats.volumes[0].error_code.as_deref(), Some("INDEX_UPDATE_FAILED"));
            set_state(conn, bin_root, "D:", "ok", 0, 0, 0, None, 123)?;
            assert!(pending_reconcile(conn)?.is_empty());
            Ok(())
        }).unwrap();
    }

    #[test]
    fn default_pages_with_tied_timestamps_remain_disjoint_in_both_directions() {
        let db = Db::open_in_memory().unwrap();
        db.with_conn(|conn| {
            for key in ["A", "B", "C"] {
                insert(conn, key, "D:", key, Some(10));
            }
            for (dir, expected) in [("asc", ["A", "B", "C"]), ("desc", ["C", "B", "A"])] {
                let mut query = RecycleQuery {
                    dir: dir.into(), limit: 1, include_stats: true, ..Default::default()
                };
                for (offset, expected_name) in expected.into_iter().enumerate() {
                    query.offset = offset;
                    let result = page(conn, &query)?;
                    assert_eq!(result.total, 3);
                    assert_eq!(result.items[0].name, expected_name);
                    assert_eq!(result.stats.unwrap().items, 3);
                }
                query.offset = 4;
                assert!(page(conn, &query)?.items.is_empty());
            }
            Ok(())
        }).unwrap();
    }

    #[test]
    fn like_metacharacters_are_escaped() {
        assert_eq!(like_pattern("100%_x").as_deref(), Some("%100\\%\\_x%"));
        assert!(like_pattern("   ").is_none());
    }

    #[test]
    fn stats_count_files_folders_and_unknown_size() {
        let db = Db::open_in_memory().unwrap();
        db.with_conn(|conn| {
            insert(conn, "A", "D:", "a.bin", Some(10));
            insert(conn, "B", "D:", "文件夹", None);
            set_state(conn, r"D:\$Recycle.Bin\S-1", "D:", "ok", 2, 10, 1, None, 123).unwrap();
            let stats = super::stats(conn).unwrap();
            assert_eq!(stats.items, 2);
            assert_eq!(stats.files, 1);
            assert_eq!(stats.folders, 1);
            assert_eq!(stats.known_bytes, 10);
            assert_eq!(stats.unknown_size, 1);
            assert_eq!(stats.volumes.len(), 1);
            assert_eq!(stats.volumes[0].state, "ok");
            assert_eq!(stats.state, "ready");
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn only_present_entries_are_native_actionable() {
        // `missing_data`（$R 已丢失）与 `unreadable`（元数据损坏 / 只有 $R 的孤儿）
        // 都不可交给 Shell：只能从索引移除，UI 不得提供「必失败」的删除按钮。
        assert!(supports_native_action(STATE_PRESENT));
        assert!(!supports_native_action(STATE_MISSING_DATA));
        assert!(!supports_native_action(STATE_UNREADABLE));
        assert!(!supports_native_action(""));
    }

    #[test]
    fn resolve_reports_each_failure_instead_of_shrinking_scope() {
        let db = Db::open_in_memory().unwrap();
        db.with_conn(|conn| {
            insert(conn, "A", "D:", "a.txt", Some(1));
            let ids = vec![
                "D:|A".to_string(),
                "D:|A".to_string(),   // 重复
                "no-separator".to_string(), // 非法
                "D:|MISSING".to_string(),   // 已消失
            ];
            let outcome = resolve(conn, &ids).unwrap();
            assert_eq!(outcome.items.len(), 1);
            assert_eq!(outcome.items[0].data_name, "$RA");
            assert_eq!(outcome.items[0].bin_root, r"D:\$Recycle.Bin\S-1");
            let codes: Vec<_> = outcome.unresolved.iter().map(|item| item.code).collect();
            assert_eq!(codes, vec!["DUPLICATE", "INVALID_ID", "NOT_FOUND"]);
            assert!(contains(conn, r"D:\$Recycle.Bin\S-1", "A").unwrap());
            assert!(!contains(conn, r"D:\$Recycle.Bin\S-1", "Z").unwrap());
            Ok(())
        })
        .unwrap();
    }
}
