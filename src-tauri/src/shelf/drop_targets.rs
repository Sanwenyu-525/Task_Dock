//! 快捷投递目标：用户显式配置的「拖进去就存到这里」的本地目录。
//!
//! 与相邻概念的边界（不要合并成一套）：
//! - `shelf_recent_dirs`：文件操作面板的**自动**最近记录，路径主键、无别名、最多 8 条；
//! - `shelf_groups`：暂存架内部的**逻辑分组**，与磁盘目录无关；
//! - 本模块：用户命名的**真实磁盘目录**快捷入口，带别名、排序、工具面板显示开关与
//!   默认操作模式，供收集箱「文件投递」子页使用。
//!
//! 安全边界：
//! - 只保存配置。删除一行、改路径、改模式都不触碰真实目录与其中的文件；
//! - 路径一律按 `normalize_target_dir` 校验（绝对路径、必须存在的目录、不得指向
//!   暂存架内部），与文件操作面板共用同一套规则；
//! - 同目录去重（Windows 大小写不敏感）；重复配置直接拒绝而不是静默合并；
//! - 可用性只在读取列表时探测一次（`is_dir`），不做后台扫描、不轮询。

use std::path::Path;

use serde::Serialize;

use super::fsops::normalize_target_dir;
use super::*;

/// 目标数量上限：工具面板只有一列窄卡片，超过后管理成本高于收益。
pub const MAX_DROP_TARGETS: usize = 24;
/// 别名长度上限（字符数，不是字节数）：卡片上两行最多显示约 20 字符。
const NAME_MAX_CHARS: usize = 40;

pub const OP_COPY: &str = "copy";
pub const OP_MOVE: &str = "move";
pub const CONFLICT_SKIP: &str = "skip";
pub const CONFLICT_RENAME: &str = "rename";

#[derive(Debug, Clone, Serialize)]
pub struct DropTarget {
    pub id: String,
    pub name: String,
    pub path: String,
    pub sort_order: i64,
    pub show_in_capsule: bool,
    /// copy | move
    pub op_mode: String,
    /// skip | rename
    pub conflict: String,
    /// 仅在读取列表时探测；`false` 时前端禁止投递并标注「目录不可用」。
    pub available: bool,
    /// 最近一次成功投递时间（空串=从未使用）。只用于展示，不改变手动排序。
    pub last_used_at: String,
    pub created_at: String,
    pub updated_at: String,
}

/// 局部更新：None=不修改（与 `UpdatePatch` 同口径）。
#[derive(Debug, Default, Clone)]
pub struct DropTargetPatch {
    pub name: Option<String>,
    pub path: Option<String>,
    pub show_in_capsule: Option<bool>,
    pub op_mode: Option<String>,
    pub conflict: Option<String>,
}

const COLS: &str = "id, name, path, sort_order, show_in_capsule, op_mode, conflict, \
                    created_at, updated_at, last_used_at";

fn from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<DropTarget> {
    Ok(DropTarget {
        id: r.get(0)?,
        name: r.get(1)?,
        // 可用性在行读取之后单独探测：不在持有数据库连接的闭包里做磁盘 IO。
        available: false,
        path: r.get(2)?,
        sort_order: r.get(3)?,
        show_in_capsule: r.get::<_, i64>(4)? != 0,
        op_mode: r.get(5)?,
        conflict: r.get(6)?,
        last_used_at: r.get(9)?,
        created_at: r.get(7)?,
        updated_at: r.get(8)?,
    })
}

/// 探测目录可用性（`is_dir`）。网络盘可能阻塞，所以只在读完之后逐条进行。
fn with_availability(mut target: DropTarget) -> DropTarget {
    target.available = Path::new(&target.path).is_dir();
    target
}

/// 别名清洗：去首尾空白、拒绝空白名与控制字符、按字符截断上限。
fn clean_name(raw: &str, fallback: &str) -> AppResult<String> {
    let trimmed = raw.trim();
    let source = if trimmed.is_empty() {
        // 留空时用目录名兜底，避免出现「只有一个图标」的无名卡片
        fallback.trim()
    } else {
        trimmed
    };
    if source.is_empty() {
        return Err(AppError::Validation("目标名称不能为空".into()));
    }
    if source.chars().any(|c| c.is_control()) {
        return Err(AppError::Validation("目标名称包含不可见控制字符".into()));
    }
    let name: String = source.chars().take(NAME_MAX_CHARS).collect();
    Ok(name)
}

fn validate_mode(raw: &str) -> AppResult<String> {
    match raw.trim() {
        "" | OP_COPY => Ok(OP_COPY.into()),
        OP_MOVE => Ok(OP_MOVE.into()),
        other => Err(AppError::Validation(format!(
            "未知的文件操作模式: {other}（仅支持 copy / move）"
        ))),
    }
}

fn validate_conflict(raw: &str) -> AppResult<String> {
    match raw.trim() {
        "" | CONFLICT_RENAME => Ok(CONFLICT_RENAME.into()),
        CONFLICT_SKIP => Ok(CONFLICT_SKIP.into()),
        other => Err(AppError::Validation(format!(
            "未知的同名冲突策略: {other}（仅支持 skip / rename）"
        ))),
    }
}

/// 目录路径校验：绝对路径、必须存在且为目录、不得是暂存架内部目录。
/// 返回规范化后的路径字符串（不做 canonicalize，避免 UI 出现 `\\?\` 前缀）。
fn validated_path(raw: &str, root: &Path) -> AppResult<String> {
    let dir = normalize_target_dir(raw, root)?;
    Ok(dir.to_string_lossy().into_owned())
}

fn path_taken(db: &Db, path: &str, except_id: Option<&str>) -> AppResult<bool> {
    let taken: bool = db.with_read(|conn| {
        let count: i64 = match except_id {
            Some(id) => conn.query_row(
                "SELECT COUNT(*) FROM shelf_drop_targets WHERE path = ?1 COLLATE NOCASE AND id <> ?2",
                params![path, id],
                |r| r.get(0),
            )?,
            None => conn.query_row(
                "SELECT COUNT(*) FROM shelf_drop_targets WHERE path = ?1 COLLATE NOCASE",
                params![path],
                |r| r.get(0),
            )?,
        };
        Ok(count > 0)
    })?;
    Ok(taken)
}

pub fn list(db: &Db) -> AppResult<Vec<DropTarget>> {
    let rows: Vec<DropTarget> = db.with_read(|conn| {
        let mut stmt = conn.prepare(&format!(
            "SELECT {COLS} FROM shelf_drop_targets \
             ORDER BY sort_order ASC, created_at ASC, id ASC"
        ))?;
        let rows = stmt.query_map([], from_row)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
    })?;
    Ok(rows.into_iter().map(with_availability).collect())
}

pub fn get(db: &Db, id: &str) -> AppResult<DropTarget> {
    let row: Option<DropTarget> = db.with_read(|conn| {
        conn.query_row(
            &format!("SELECT {COLS} FROM shelf_drop_targets WHERE id = ?1"),
            params![id],
            from_row,
        )
        .optional()
        .map_err(AppError::from)
    })?;
    row.map(with_availability)
        .ok_or_else(|| AppError::NotFound("投递目标不存在或已被删除".into()))
}

pub fn create(
    db: &Db,
    root: &Path,
    name: &str,
    raw_path: &str,
    show_in_capsule: bool,
    op_mode: &str,
    conflict: &str,
) -> AppResult<DropTarget> {
    let path = validated_path(raw_path, root)?;
    let default_name = Path::new(&path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.clone());
    let name = clean_name(name, &default_name)?;
    let op_mode = validate_mode(op_mode)?;
    let conflict = validate_conflict(conflict)?;

    let id = uuid::Uuid::new_v4().to_string();
    let now = now_iso();
    // 去重先做一次读（给出可读文案），唯一索引再兜住并发插入的竞态。
    if path_taken(db, &path, None)? {
        return Err(AppError::Conflict(format!("该目录已经添加过: {path}")));
    }
    db.with_conn(|conn| {
        // 注意：不要在 `with_conn` 内部再调用 `db.with_read/with_conn`（非重入锁会死锁），
        // 这里的所有查询都直接用本次拿到的 `conn`。
        let total: i64 =
            conn.query_row("SELECT COUNT(*) FROM shelf_drop_targets", [], |r| r.get(0))?;
        if total >= MAX_DROP_TARGETS as i64 {
            return Err(AppError::Conflict(format!(
                "投递目标最多 {MAX_DROP_TARGETS} 个，请先移除不用的目标"
            )));
        }
        let next: i64 = conn.query_row(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM shelf_drop_targets",
            [],
            |r| r.get(0),
        )?;
        conn.execute(
            "INSERT INTO shelf_drop_targets \
             (id, name, path, sort_order, show_in_capsule, op_mode, conflict, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
            params![
                id,
                name,
                path,
                next,
                i64::from(show_in_capsule),
                op_mode,
                conflict,
                now
            ],
        )
        .map_err(|e| match e {
            rusqlite::Error::SqliteFailure(err, _)
                if err.code == rusqlite::ErrorCode::ConstraintViolation =>
            {
                AppError::Conflict(format!("该目录已经添加过: {path}"))
            }
            other => AppError::from(other),
        })?;
        Ok(())
    })?;
    get(db, &id)
}

pub fn update(db: &Db, root: &Path, id: &str, patch: &DropTargetPatch) -> AppResult<DropTarget> {
    let current = get(db, id)?;

    let name = match patch.name.as_deref() {
        Some(raw) => Some(clean_name(raw, &current.name)?),
        None => None,
    };
    let path = match patch.path.as_deref() {
        Some(raw) => Some(validated_path(raw, root)?),
        None => None,
    };
    let op_mode = patch.op_mode.as_deref().map(validate_mode).transpose()?;
    let conflict = patch
        .conflict
        .as_deref()
        .map(validate_conflict)
        .transpose()?;

    if let Some(next) = path.as_deref() {
        if path_taken(db, next, Some(id))? {
            return Err(AppError::Conflict(format!("该目录已经添加过: {next}")));
        }
    }

    let mut sets: Vec<&str> = Vec::new();
    let mut values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
    if let Some(v) = name {
        sets.push("name = ?");
        values.push(Box::new(v));
    }
    if let Some(v) = path {
        sets.push("path = ?");
        values.push(Box::new(v));
    }
    if let Some(v) = op_mode {
        sets.push("op_mode = ?");
        values.push(Box::new(v));
    }
    if let Some(v) = conflict {
        sets.push("conflict = ?");
        values.push(Box::new(v));
    }
    if let Some(v) = patch.show_in_capsule {
        sets.push("show_in_capsule = ?");
        values.push(Box::new(i64::from(v)));
    }
    if sets.is_empty() {
        return Ok(current);
    }
    sets.push("updated_at = ?");
    values.push(Box::new(now_iso()));
    values.push(Box::new(id.to_string()));

    let sql = format!(
        "UPDATE shelf_drop_targets SET {} WHERE id = ?",
        sets.join(", ")
    );
    db.with_conn(|conn| {
        let refs: Vec<&dyn rusqlite::types::ToSql> = values.iter().map(|v| v.as_ref()).collect();
        conn.execute(&sql, refs.as_slice())?;
        Ok(())
    })?;
    get(db, id)
}

/// 只删除配置行：真实目录与其中文件一律不动。
pub fn delete(db: &Db, id: &str) -> AppResult<()> {
    db.with_conn(|conn| {
        let n = conn.execute("DELETE FROM shelf_drop_targets WHERE id = ?1", params![id])?;
        if n == 0 {
            return Err(AppError::NotFound("投递目标不存在或已被删除".into()));
        }
        Ok(())
    })
}

/// 成功投递后记录使用时间；失败只影响「最近使用」展示，绝不影响投递结果。
pub fn touch_used(db: &Db, id: &str) {
    let _ = db.with_conn(|conn| {
        conn.execute(
            "UPDATE shelf_drop_targets SET last_used_at = ?1 WHERE id = ?2",
            params![now_iso(), id],
        )?;
        Ok(())
    });
}

/// 上下移动一位。
///
/// 历史数据或备份导入可能带**重复的 `sort_order`**：此时「交换两个相邻值」是空操作，
/// 界面看起来毫无反应。这里改为：按稳定顺序（`sort_order → created_at → id`）取出当前
/// 顺序，交换相邻两项在序列中的位置，再按位置把 `sort_order` 重写为 `0..n-1`。
/// - 正常数据（值已是 0..n-1 且唯一）只会写两行，与原来的交换开销一致；
/// - 只有排序值重复/不连续时才顺带规范化，保证之后顺序稳定可复现；
/// - 整个读取+写入在事务里完成，失败不会留下半套顺序。
pub fn reorder(db: &Db, id: &str, direction: &str) -> AppResult<Vec<DropTarget>> {
    let up = match direction.trim() {
        "up" => true,
        "down" => false,
        other => {
            return Err(AppError::Validation(format!(
                "未知的排序方向: {other}（仅支持 up / down）"
            )))
        }
    };
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        let mut order: Vec<(String, i64)> = {
            // id 作为最终 tiebreaker：即使 sort_order 与 created_at 都相同，
            // 顺序也必须是确定且可复现的。
            let mut stmt = tx.prepare(
                "SELECT id, sort_order FROM shelf_drop_targets \
                 ORDER BY sort_order ASC, created_at ASC, id ASC",
            )?;
            let it = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
            it.collect::<Result<Vec<_>, _>>().map_err(AppError::from)?
        };
        let Some(index) = order.iter().position(|(rid, _)| rid == id) else {
            return Err(AppError::NotFound("投递目标不存在或已被删除".into()));
        };
        let target_index = if up {
            index.checked_sub(1)
        } else if index + 1 < order.len() {
            Some(index + 1)
        } else {
            None
        };
        let Some(other_index) = target_index else {
            // 已在首/末位：不是错误，重复点击不应报错
            return Ok(());
        };
        order.swap(index, other_index);
        for (position, (row_id, current)) in order.iter().enumerate() {
            let want = position as i64;
            if *current != want {
                tx.execute(
                    "UPDATE shelf_drop_targets SET sort_order = ?1 WHERE id = ?2",
                    params![want, row_id],
                )?;
            }
        }
        tx.commit()?;
        Ok(())
    })?;
    list(db)
}

/// 解析为可执行的真实目录：目标存在性与目录类型在投递前再确认一次，
/// 前端传入的目标路径不参与文件操作（后端按 id 从库里取权威路径）。
pub fn resolve_dir(db: &Db, root: &Path, id: &str) -> AppResult<(DropTarget, PathBuf)> {
    let target = get(db, id)?;
    let dir = normalize_target_dir(&target.path, root).map_err(|e| {
        AppError::NotFound(format!(
            "目标目录不可用: {}（{e}）。请检查磁盘是否连接或重新选择目录",
            target.path
        ))
    })?;
    Ok((target, dir))
}
