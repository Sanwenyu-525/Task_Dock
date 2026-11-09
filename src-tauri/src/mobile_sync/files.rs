//! 手机文件互传 v1：桌面端存储、分块读写与传输记录。
//!
//! 设计边界：
//! - 文件只落在应用数据目录 `mobile_files/{outbox,inbox,tmp}`，不写用户目录；
//!   桌面端 UI 通过「在文件夹中显示」交给资源管理器打开；
//! - 传输记录写 `mobile_files` 表（本机瞬时状态，不进备份）；
//! - 协议只传文件名、大小与分块，桌面端不把 `stored_path` 下发给手机；
//! - 分块上传按顺序落盘，`received_chunks` 是唯一进度来源；重复发送上一块按
//!   幂等重写处理（手机端超时重试不会把文件写坏）；
//! - 完成时校验分块数、文件大小并计算 SHA-256，再原子改名到 `inbox/`；
//! - 删除只允许删除 `mobile_files` 根目录内的普通文件，拒绝符号链接与越界路径。

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use chrono::{SecondsFormat, Utc};
use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::db::Db;
use crate::error::{AppError, AppResult};

/// 传输方向：桌面端提供下载 / 手机上传到桌面端。
pub const DIRECTION_TO_PHONE: &str = "to_phone";
pub const DIRECTION_TO_DESKTOP: &str = "to_desktop";
/// 记录状态：上传中 / 可下载或已接收 / 失败。
pub const STATUS_PENDING: &str = "pending";
pub const STATUS_READY: &str = "ready";
pub const STATUS_FAILED: &str = "failed";

/// 单文件上限：分块加密在手机端用 JS 实现，200MB 是当前可接受的边界。
pub const MAX_FILE_BYTES: u64 = 200 * 1024 * 1024;
/// 分块大小：192KB 明文经 base64 + 加密信封后仍远低于 1MB 请求体上限。
pub const CHUNK_BYTES: u64 = 192 * 1024;
/// 同一设备同时存在的未完成上传上限：手机端严格串行，正常最多 1 条；
/// 留出重试余量，同时防止异常客户端不断创建 pending 记录。
const MAX_PENDING_UPLOADS: i64 = 4;

/// 文件协议的 AAD：把方法 + 完整路径绑进密文，跨端点/跨文件重放会解密失败。
pub const AAD_FILES_LIST: &str = "taskdock-sync-v1|GET|/v1/files";
pub const AAD_FILE_CREATE: &str = "taskdock-sync-v1|POST|/v1/files";

pub fn aad_file_chunk(method: &str, id: &str, index: u64) -> String {
    format!("taskdock-sync-v1|{method}|/v1/files/{id}/chunk/{index}")
}

pub fn aad_file_complete(id: &str) -> String {
    format!("taskdock-sync-v1|POST|/v1/files/{id}/complete")
}

pub fn aad_file_delete(id: &str) -> String {
    format!("taskdock-sync-v1|POST|/v1/files/{id}/delete")
}

/// 文件名展示/落盘上限（字符数，保留扩展名）。
const MAX_NAME_CHARS: usize = 120;
const SUBDIR_OUTBOX: &str = "outbox";
const SUBDIR_INBOX: &str = "inbox";
const SUBDIR_TMP: &str = "tmp";

/// 返回给手机/桌面 UI 的传输记录；`stored_path` 只在进程内使用，绝不序列化。
#[derive(Debug, Clone, Serialize)]
pub struct MobileFile {
    pub id: String,
    pub direction: String,
    pub name: String,
    pub size: i64,
    pub sha256: String,
    pub status: String,
    pub chunk_size: i64,
    pub chunks: i64,
    pub received_chunks: i64,
    pub created_at: String,
    pub updated_at: String,
    pub completed_at: Option<String>,
    #[serde(skip_serializing)]
    pub device_id: String,
    #[serde(skip_serializing)]
    pub stored_path: String,
}

impl MobileFile {
    fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get(0)?,
            device_id: row.get(1)?,
            direction: row.get(2)?,
            name: row.get(3)?,
            size: row.get(4)?,
            sha256: row.get(5)?,
            status: row.get(6)?,
            stored_path: row.get(7)?,
            chunk_size: row.get(8)?,
            chunks: row.get(9)?,
            received_chunks: row.get(10)?,
            created_at: row.get(11)?,
            updated_at: row.get(12)?,
            completed_at: row.get(13)?,
        })
    }
}

const SELECT_COLUMNS: &str = "id, device_id, direction, name, size, sha256, status, stored_path,
     chunk_size, chunks, received_chunks, created_at, updated_at, completed_at";

/// 创建目录结构（幂等）。
pub fn ensure_dirs(root: &Path) -> AppResult<()> {
    for sub in [SUBDIR_OUTBOX, SUBDIR_INBOX, SUBDIR_TMP] {
        fs::create_dir_all(root.join(sub))?;
    }
    Ok(())
}

pub fn inbox_dir(root: &Path) -> PathBuf {
    root.join(SUBDIR_INBOX)
}

/// 清理上次进程遗留的半成品：删除 `tmp/` 下全部分块文件与对应 pending 记录。
/// 手机端下次上传会重新创建记录，不会复用旧 id。
pub fn recover_pending(db: &Db, root: &Path) -> AppResult<usize> {
    ensure_dirs(root)?;
    let removed = db.with_conn(|conn| {
        let count = conn.execute("DELETE FROM mobile_files WHERE status = ?1", params![STATUS_PENDING])?;
        Ok(count)
    })?;
    // tmp 只存半成品；进程启动时目录里不可能有正在使用的上传。
    if let Ok(entries) = fs::read_dir(root.join(SUBDIR_TMP)) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                let _ = fs::remove_file(path);
            }
        }
    }
    Ok(removed)
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, false)
}

/// 清理用户提供的文件名：只保留末段、替换 Windows 非法字符、去尾部点与空格，
/// 并规避设备保留名。空结果回退为 `file`，绝不把路径分隔符带进落盘名。
pub fn sanitize_file_name(raw: &str) -> String {
    let base = Path::new(raw)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("");

    let mut out = String::new();
    let mut count = 0usize;
    for ch in base.chars() {
        if count >= MAX_NAME_CHARS {
            break;
        }
        let mapped = if ch.is_control() || matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') {
            '_'
        } else {
            ch
        };
        out.push(mapped);
        count += 1;
    }

    let trimmed = out.trim().trim_end_matches(['.', ' ']).trim();
    let mut name = if trimmed.is_empty() {
        "file".to_string()
    } else {
        trimmed.to_string()
    };

    // Windows 设备名（大小写不敏感，扩展名不改变保留语义）。
    let stem = name
        .split('.')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ["COM", "LPT"].iter().any(|prefix| {
            stem.strip_prefix(prefix).is_some_and(|rest| {
                rest.len() == 1 && matches!(rest.as_bytes()[0], b'1'..=b'9')
            })
        });
    if reserved {
        name = format!("_{name}");
    }
    name
}

fn validate_size(size: u64) -> AppResult<()> {
    if size == 0 {
        return Err(AppError::Validation("空文件不支持传输".into()));
    }
    if size > MAX_FILE_BYTES {
        return Err(AppError::Validation(format!(
            "文件超过 {} MB 上限",
            MAX_FILE_BYTES / 1024 / 1024
        )));
    }
    Ok(())
}

fn chunk_count(size: u64) -> u64 {
    size.div_ceil(CHUNK_BYTES)
}

fn expected_chunk_len(size: u64, index: u64) -> u64 {
    let start = index.saturating_mul(CHUNK_BYTES);
    size.saturating_sub(start).min(CHUNK_BYTES)
}

fn stored_disk_name(id: &str, name: &str) -> String {
    format!("{id}-{name}")
}

/// 把路径限制在互传根目录内；不存在或不是普通文件时拒绝。
fn ensure_regular_file_inside(root: &Path, path: &Path) -> AppResult<PathBuf> {
    let root = fs::canonicalize(root)?;
    let path = fs::canonicalize(path)?;
    if !path.starts_with(&root) {
        return Err(AppError::Validation("文件路径越界".into()));
    }
    let meta = fs::symlink_metadata(&path)?;
    if meta.file_type().is_symlink() || !meta.is_file() {
        return Err(AppError::Validation("目标不是普通文件".into()));
    }
    Ok(path)
}

fn sha256_file(path: &Path) -> AppResult<String> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

fn copy_with_hash(source: &Path, destination: &Path) -> AppResult<String> {
    let mut input = File::open(source)?;
    let mut output = File::create(destination)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        let read = input.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        output.write_all(&buffer[..read])?;
    }
    output.flush()?;
    Ok(hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

fn load_file(db: &Db, id: &str) -> AppResult<MobileFile> {
    db.with_conn(|conn| {
        conn.query_row(
            &format!("SELECT {SELECT_COLUMNS} FROM mobile_files WHERE id = ?1"),
            params![id],
            |row| MobileFile::from_row(row),
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound("传输记录不存在".into()))
    })
}

/// 桌面端 UI：全部记录（最近 100 条）。
pub fn list_all(db: &Db) -> AppResult<Vec<MobileFile>> {
    db.with_conn(|conn| {
        let mut statement = conn.prepare(&format!(
            "SELECT {SELECT_COLUMNS} FROM mobile_files ORDER BY created_at DESC LIMIT 100"
        ))?;
        let rows = statement.query_map([], |row| MobileFile::from_row(row))?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    })
}

/// 手机端：所有可下载的 `to_phone` 文件 + 本机上传的 `to_desktop` 记录。
pub fn list_for_device(db: &Db, device_id: &str) -> AppResult<Vec<MobileFile>> {
    db.with_conn(|conn| {
        let mut statement = conn.prepare(&format!(
            "SELECT {SELECT_COLUMNS} FROM mobile_files
             WHERE (direction = ?1 AND status = ?2)
                OR (direction = ?3 AND device_id = ?4)
             ORDER BY created_at DESC LIMIT 200"
        ))?;
        let rows = statement.query_map(
            params![DIRECTION_TO_PHONE, STATUS_READY, DIRECTION_TO_DESKTOP, device_id],
            |row| MobileFile::from_row(row),
        )?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    })
}

/// 桌面端选择文件后复制到 outbox 并提供给手机下载。
/// 返回成功创建的记录；单个文件失败不会中断其余文件。
pub fn create_offers(db: &Db, root: &Path, paths: &[String]) -> AppResult<Vec<MobileFile>> {
    ensure_dirs(root)?;
    // 先整体校验，避免「前几个已复制、后一个非法」留下半批记录。
    for raw in paths {
        let source = PathBuf::from(raw);
        let meta = fs::symlink_metadata(&source)?;
        if meta.file_type().is_symlink() || !meta.is_file() {
            return Err(AppError::Validation(format!(
                "只能发送普通文件：{}",
                source.display()
            )));
        }
        validate_size(meta.len())?;
    }

    let mut created = Vec::new();
    for raw in paths {
        let source = PathBuf::from(raw);
        let size = fs::symlink_metadata(&source)?.len();
        let name = sanitize_file_name(&source.to_string_lossy());
        let id = Uuid::new_v4().simple().to_string();
        let stored = root.join(SUBDIR_OUTBOX).join(stored_disk_name(&id, &name));
        let sha256 = copy_with_hash(&source, &stored)?;
        let now = now_iso();
        let chunks = chunk_count(size) as i64;
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO mobile_files
                   (id, device_id, direction, name, size, sha256, status, stored_path,
                    chunk_size, chunks, received_chunks, created_at, updated_at, completed_at)
                 VALUES (?1, '', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11, ?11)",
                params![
                    id,
                    DIRECTION_TO_PHONE,
                    name,
                    size as i64,
                    sha256,
                    STATUS_READY,
                    stored.to_string_lossy().to_string(),
                    CHUNK_BYTES as i64,
                    chunks,
                    chunks,
                    now
                ],
            )?;
            Ok(())
        })?;
        created.push(load_file(db, &id)?);
    }
    Ok(created)
}

/// 手机创建上传：返回 id 与分块参数。真正落盘在 `write_chunk`。
pub fn create_upload(
    db: &Db,
    root: &Path,
    device_id: &str,
    raw_name: &str,
    size: u64,
) -> AppResult<MobileFile> {
    ensure_dirs(root)?;
    validate_size(size)?;
    let name = sanitize_file_name(raw_name);
    let id = Uuid::new_v4().simple().to_string();
    let temp = root.join(SUBDIR_TMP).join(format!("{id}.part"));
    // 先建空文件，后续分块按偏移写入；失败时删除，避免留下孤儿。
    File::create(&temp)?;
    let now = now_iso();
    let chunks = chunk_count(size) as i64;
    let result = db.with_conn(|conn| {
        let pending: i64 = conn.query_row(
            "SELECT COUNT(*) FROM mobile_files
              WHERE device_id = ?1 AND direction = ?2 AND status = ?3",
            params![device_id, DIRECTION_TO_DESKTOP, STATUS_PENDING],
            |row| row.get(0),
        )?;
        if pending >= MAX_PENDING_UPLOADS {
            return Err(AppError::Conflict(
                "同时进行的上传过多，请稍后重试".into(),
            ));
        }
        conn.execute(
            "INSERT INTO mobile_files
               (id, device_id, direction, name, size, sha256, status, stored_path,
                chunk_size, chunks, received_chunks, created_at, updated_at, completed_at)
             VALUES (?1, ?2, ?3, ?4, ?5, '', ?6, ?7, ?8, ?9, 0, ?10, ?10, NULL)",
            params![
                id,
                device_id,
                DIRECTION_TO_DESKTOP,
                name,
                size as i64,
                STATUS_PENDING,
                temp.to_string_lossy().to_string(),
                CHUNK_BYTES as i64,
                chunks,
                now
            ],
        )?;
        Ok(())
    });
    if let Err(error) = result {
        let _ = fs::remove_file(&temp);
        return Err(error);
    }
    load_file(db, &id)
}

/// 写入一个分块。只接受「下一块」或「上一块重写」：
/// - `index == received_chunks`：正常推进；
/// - `index + 1 == received_chunks`：手机端请求超时后的幂等重试。
pub fn write_chunk(
    db: &Db,
    device_id: &str,
    id: &str,
    index: u64,
    bytes: &[u8],
) -> AppResult<MobileFile> {
    db.with_conn(|conn| {
        let row = conn
            .query_row(
                &format!("SELECT {SELECT_COLUMNS} FROM mobile_files WHERE id = ?1"),
                params![id],
                |row| MobileFile::from_row(row),
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound("传输记录不存在".into()))?;

        if row.direction != DIRECTION_TO_DESKTOP || row.device_id != device_id {
            return Err(AppError::NotFound("传输记录不存在".into()));
        }
        if row.status != STATUS_PENDING {
            return Err(AppError::Conflict("该传输已结束".into()));
        }

        let chunks = row.chunks.max(0) as u64;
        if index >= chunks {
            return Err(AppError::Validation("分块序号越界".into()));
        }
        let expected = expected_chunk_len(row.size.max(0) as u64, index);
        if bytes.len() as u64 != expected {
            return Err(AppError::Validation("分块长度与声明大小不一致".into()));
        }

        let received = row.received_chunks.max(0) as u64;
        let advance = if index == received {
            true
        } else if index + 1 == received {
            false
        } else {
            return Err(AppError::Conflict(format!(
                "分块顺序错误：期望 {received}，收到 {index}"
            )));
        };

        let path = PathBuf::from(&row.stored_path);
        let mut file = OpenOptions::new().write(true).open(&path)?;
        file.seek(SeekFrom::Start(index.saturating_mul(CHUNK_BYTES)))?;
        file.write_all(bytes)?;
        file.flush()?;

        let next_received = if advance { received + 1 } else { received };
        let now = now_iso();
        conn.execute(
            "UPDATE mobile_files SET received_chunks = ?1, updated_at = ?2 WHERE id = ?3",
            params![next_received as i64, now, id],
        )?;
        Ok(MobileFile {
            received_chunks: next_received as i64,
            updated_at: now,
            ..row
        })
    })
}

/// 完成上传：校验分块数/大小/哈希，原子改名到 inbox。
pub fn complete_upload(db: &Db, root: &Path, device_id: &str, id: &str) -> AppResult<MobileFile> {
    ensure_dirs(root)?;
    let row = load_file(db, id)?;
    if row.direction != DIRECTION_TO_DESKTOP || row.device_id != device_id {
        return Err(AppError::NotFound("传输记录不存在".into()));
    }
    if row.status == STATUS_READY {
        return Ok(row);
    }
    if row.status != STATUS_PENDING {
        return Err(AppError::Conflict("该传输已结束".into()));
    }
    if row.received_chunks != row.chunks {
        return Err(AppError::Conflict("分块尚未传完".into()));
    }

    let temp = PathBuf::from(&row.stored_path);
    let meta = fs::symlink_metadata(&temp)?;
    if meta.file_type().is_symlink() || !meta.is_file() {
        return Err(AppError::Validation("上传临时文件不可用".into()));
    }
    if meta.len() != row.size.max(0) as u64 {
        return Err(AppError::Validation("文件大小与声明不一致".into()));
    }
    let sha256 = sha256_file(&temp)?;

    let destination = inbox_dir(root).join(stored_disk_name(id, &row.name));
    fs::rename(&temp, &destination)?;
    let now = now_iso();
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE mobile_files
                SET status = ?1, sha256 = ?2, stored_path = ?3,
                    updated_at = ?4, completed_at = ?4
              WHERE id = ?5",
            params![
                STATUS_READY,
                sha256,
                destination.to_string_lossy().to_string(),
                now,
                id
            ],
        )?;
        Ok(())
    })?;
    load_file(db, id)
}

/// 删除记录并清理磁盘文件。手机端只能删自己的上传或任意 `to_phone` 记录；
/// 桌面端命令层传 `None`（本机 UI 拥有全部权限）。
pub fn delete_file(
    db: &Db,
    root: &Path,
    actor_device: Option<&str>,
    id: &str,
) -> AppResult<bool> {
    let row = load_file(db, id)?;
    if let Some(device) = actor_device {
        let allowed = row.direction == DIRECTION_TO_PHONE
            || (row.direction == DIRECTION_TO_DESKTOP && row.device_id == device);
        if !allowed {
            return Err(AppError::NotFound("传输记录不存在".into()));
        }
    }

    if !row.stored_path.is_empty() {
        let path = PathBuf::from(&row.stored_path);
        if path.exists() {
            let safe = ensure_regular_file_inside(root, &path)?;
            fs::remove_file(safe)?;
        }
    }

    db.with_conn(|conn| {
        conn.execute("DELETE FROM mobile_files WHERE id = ?1", params![id])?;
        Ok(())
    })?;
    Ok(true)
}

/// 读取一个分块（`to_phone` 且 ready）。
pub fn read_chunk(
    db: &Db,
    root: &Path,
    actor_device: Option<&str>,
    id: &str,
    index: u64,
) -> AppResult<Vec<u8>> {
    let row = load_file(db, id)?;
    if row.direction != DIRECTION_TO_PHONE || row.status != STATUS_READY {
        return Err(AppError::NotFound("文件不可下载".into()));
    }
    if let Some(device) = actor_device {
        if row.device_id.is_empty() || row.device_id == device {
            // to_phone 记录默认对所有已配对设备可见。
        } else {
            return Err(AppError::NotFound("文件不可下载".into()));
        }
    }
    let chunks = row.chunks.max(0) as u64;
    if index >= chunks {
        return Err(AppError::Validation("分块序号越界".into()));
    }
    let path = ensure_regular_file_inside(root, Path::new(&row.stored_path))?;
    let mut file = File::open(path)?;
    file.seek(SeekFrom::Start(index.saturating_mul(CHUNK_BYTES)))?;
    let length = expected_chunk_len(row.size.max(0) as u64, index) as usize;
    let mut buffer = vec![0u8; length];
    file.read_exact(&mut buffer)?;
    Ok(buffer)
}

/// 解析传输记录对应的真实文件路径（桌面端「在文件夹中显示」用）。
pub fn resolve_stored_file(db: &Db, root: &Path, id: &str) -> AppResult<PathBuf> {
    let row = load_file(db, id)?;
    if row.status != STATUS_READY || row.stored_path.is_empty() {
        return Err(AppError::Conflict("文件尚未就绪".into()));
    }
    ensure_regular_file_inside(root, Path::new(&row.stored_path))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_db() -> Db {
        Db::open_in_memory().unwrap()
    }

    fn temp_root(tag: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "taskdock-mobile-files-{tag}-{}",
            Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn payload(size: usize) -> Vec<u8> {
        (0..size).map(|index| (index % 251) as u8).collect()
    }

    fn upload(
        db: &Db,
        root: &Path,
        name: &str,
        bytes: &[u8],
    ) -> MobileFile {
        let created = create_upload(db, root, "device-1", name, bytes.len() as u64).unwrap();
        let chunk_size = created.chunk_size as usize;
        for index in 0..created.chunks as usize {
            let start = index * chunk_size;
            let end = (start + chunk_size).min(bytes.len());
            write_chunk(db, "device-1", &created.id, index as u64, &bytes[start..end])
                .unwrap();
        }
        complete_upload(db, root, "device-1", &created.id).unwrap()
    }

    #[test]
    fn sanitize_rejects_paths_and_reserved_names() {
        assert_eq!(sanitize_file_name("../../etc/passwd"), "passwd");
        assert_eq!(sanitize_file_name("C:\\temp\\报告.pdf"), "报告.pdf");
        assert_eq!(sanitize_file_name("a<b>c?.txt"), "a_b_c_.txt");
        assert_eq!(sanitize_file_name("CON"), "_CON");
        assert_eq!(sanitize_file_name("   "), "file");
        assert_eq!(sanitize_file_name("trailing..."), "trailing");
        assert!(sanitize_file_name(&"x".repeat(500)).chars().count() <= MAX_NAME_CHARS);
    }

    #[test]
    fn upload_complete_and_delete_roundtrip() {
        let db = test_db();
        let root = temp_root("roundtrip");
        let bytes = payload((CHUNK_BYTES as usize) * 2 + 37);
        let file = upload(&db, &root, "照片.jpg", &bytes);

        assert_eq!(file.status, STATUS_READY);
        assert_eq!(file.received_chunks, file.chunks);
        assert_eq!(file.size as usize, bytes.len());
        assert_eq!(file.chunks, 3);
        assert_eq!(file.sha256, sha256_file(&PathBuf::from(&file.stored_path)).unwrap());

        let stored = fs::read(&file.stored_path).unwrap();
        assert_eq!(stored, bytes);

        assert_eq!(list_for_device(&db, "device-1").unwrap().len(), 1);
        assert!(delete_file(&db, &root, Some("device-1"), &file.id).unwrap());
        assert!(!PathBuf::from(&file.stored_path).exists());
        assert!(list_all(&db).unwrap().is_empty());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn out_of_order_and_bad_length_are_rejected() {
        let db = test_db();
        let root = temp_root("order");
        let created = create_upload(&db, &root, "device-1", "a.bin", CHUNK_BYTES + 5).unwrap();

        assert!(write_chunk(&db, "device-1", &created.id, 1, &payload(5)).is_err());
        assert!(write_chunk(&db, "device-1", &created.id, 0, &payload(10)).is_err());
        write_chunk(&db, "device-1", &created.id, 0, &payload(CHUNK_BYTES as usize)).unwrap();
        // 重发上一块按幂等处理
        write_chunk(&db, "device-1", &created.id, 0, &payload(CHUNK_BYTES as usize)).unwrap();
        let after_retry = load_file(&db, &created.id).unwrap();
        assert_eq!(after_retry.received_chunks, 1);
        // 未传完不能完成
        assert!(complete_upload(&db, &root, "device-1", &created.id).is_err());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn device_scope_hides_other_uploads() {
        let db = test_db();
        let root = temp_root("scope");
        let created = create_upload(&db, &root, "device-1", "a.bin", 4).unwrap();
        write_chunk(&db, "device-1", &created.id, 0, &payload(4)).unwrap();
        complete_upload(&db, &root, "device-1", &created.id).unwrap();

        assert!(list_for_device(&db, "device-2").unwrap().is_empty());
        assert!(delete_file(&db, &root, Some("device-2"), &created.id).is_err());
        assert!(read_chunk(&db, &root, Some("device-2"), &created.id, 0).is_err());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn offer_copies_file_and_is_downloadable() {
        let db = test_db();
        let root = temp_root("offer");
        let source = root.join("source.txt");
        fs::write(&source, b"hello mobile").unwrap();

        let files = create_offers(&db, &root, &[source.to_string_lossy().to_string()]).unwrap();
        assert_eq!(files.len(), 1);
        let file = &files[0];
        assert_eq!(file.direction, DIRECTION_TO_PHONE);
        assert_eq!(file.name, "source.txt");
        assert_eq!(file.status, STATUS_READY);
        assert_eq!(file.received_chunks, file.chunks);
        assert_eq!(
            read_chunk(&db, &root, Some("device-1"), &file.id, 0).unwrap(),
            b"hello mobile"
        );
        assert!(list_for_device(&db, "device-1").unwrap().len() == 1);

        // 手机删除后桌面端记录与文件都消失
        assert!(delete_file(&db, &root, Some("device-1"), &file.id).unwrap());
        assert!(!PathBuf::from(&file.stored_path).exists());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn size_limits_are_enforced() {
        let db = test_db();
        let root = temp_root("limit");
        assert!(create_upload(&db, &root, "device-1", "empty", 0).is_err());
        assert!(create_upload(&db, &root, "device-1", "huge", MAX_FILE_BYTES + 1).is_err());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn pending_upload_limit_is_enforced() {
        let db = test_db();
        let root = temp_root("pending-limit");
        for index in 0..MAX_PENDING_UPLOADS {
            create_upload(&db, &root, "device-1", &format!("f{index}.bin"), 8).unwrap();
        }
        assert!(create_upload(&db, &root, "device-1", "overflow.bin", 8).is_err());

        let first = list_all(&db).unwrap().into_iter().next().unwrap();
        delete_file(&db, &root, Some("device-1"), &first.id).unwrap();
        assert!(create_upload(&db, &root, "device-1", "after-delete.bin", 8).is_ok());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn recovery_clears_pending_uploads() {
        let db = test_db();
        let root = temp_root("recover");
        let created = create_upload(&db, &root, "device-1", "a.bin", 8).unwrap();
        write_chunk(&db, "device-1", &created.id, 0, &payload(8)).unwrap();
        let temp = PathBuf::from(&created.stored_path);
        assert!(temp.exists());

        let removed = recover_pending(&db, &root).unwrap();
        assert_eq!(removed, 1);
        assert!(!temp.exists());
        assert!(list_all(&db).unwrap().is_empty());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn deleting_tampered_path_is_refused() {
        let db = test_db();
        let root = temp_root("tamper");
        let outside = temp_root("outside");
        let target = outside.join("secret.txt");
        fs::write(&target, b"secret").unwrap();
        let created = create_upload(&db, &root, "device-1", "a.bin", 1).unwrap();

        db.with_conn(|conn| {
            conn.execute(
                "UPDATE mobile_files SET stored_path = ?1 WHERE id = ?2",
                params![target.to_string_lossy().to_string(), created.id],
            )?;
            Ok(())
        })
        .unwrap();

        assert!(delete_file(&db, &root, Some("device-1"), &created.id).is_err());
        assert!(target.exists());

        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&outside);
    }
}
