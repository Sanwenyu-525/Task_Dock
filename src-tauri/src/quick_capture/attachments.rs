//! 快速捕获图片附件：规范化落盘、元数据入库、读取与清理。
//!
//! 设计（对应任务书 2.3 / 2.4）：
//! - **复用现有图片能力**：编解码 / 缩放全部走 `clipboard::image`（png crate），
//!   不引入第二套图片处理栈，也不新增依赖；
//! - **只存文件，不存 data URL**：数据库只记录相对路径、尺寸与大小；前端拿到的
//!   `data:` URL 都是按需从磁盘读出的展示产物，绝不是数据来源；
//! - **归属明确**：`owner_kind = 'draft' | 'item'`。草稿附件与已提交附件互不重叠，
//!   提交时在同一个事务里改归属，清理任务不会误删「刚转正」的图片；
//! - **失败可回收**：先落盘再入库，入库失败立即删文件；删除条目先删行、再删文件，
//!   残留文件由 `cleanup_orphans` 按「未引用且足够旧」回收。
//!
//! 附件 ID 由后端生成（uuid），前端只持有 ID；读取时按 ID 回查数据库，路径不来自
//! 前端，因此不存在越界读取用户任意文件的问题。

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use base64::Engine as _;
use serde::Serialize;

use crate::clipboard::image;
use crate::db::Db;
use crate::error::{AppError, AppResult};

/// 单条捕获最多携带的图片数（含草稿与已提交条目）。
pub const MAX_ATTACHMENTS: usize = 8;
/// 单张 PNG 的容器字节上限（前端已在 canvas 侧降采样，这里只做防滥用闸门）。
pub const MAX_IMAGE_BYTES: usize = 12 * 1024 * 1024;
/// 单边像素上限：超过它直接拒绝，避免一次粘贴吃满内存。
pub const MAX_IMAGE_EDGE: u32 = 4096;
/// 总像素上限（4096×4096 以内；RGBA 峰值约 64MB）。
pub const MAX_IMAGE_PIXELS: u64 = 16_777_216;
/// 附件根目录下的子目录（与剪贴板资产同名，便于运维辨认）。
const DIR_IMAGES: &str = "images";
const DIR_THUMBS: &str = "thumbs";
/// 孤立文件回收的年龄门槛：大于它才删，避免删掉正在写入的文件。
const ORPHAN_MIN_AGE: std::time::Duration = std::time::Duration::from_secs(3600);

/// 迁移 v80：快速捕获图片附件表（DDL 跟随领域模块，db/mod.rs 只登记迁移号）。
///
/// - `owner_kind` 区分草稿与已提交条目的归属，避免一张图片被两条清理路径同时删除；
/// - `owner_id` 在草稿阶段为 NULL（草稿是单行 'active'，无需额外关联）；
/// - 只存相对路径与元数据，不存 base64 / data URL；
/// - 旧记录没有附件行，读取时得到空数组，行为与升级前一致。
pub const MIGRATION_80: (i64, &str) = (
    80,
    r#"
-- 快速捕获图片附件（v80）：草稿与收集箱条目共用的图片元数据。
-- 文件落在应用数据目录的 capture-attachments/{images,thumbs}，数据库只记相对路径。
CREATE TABLE quick_capture_attachments (
  id TEXT PRIMARY KEY NOT NULL,
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('draft', 'item')),
  owner_id TEXT,
  position INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
  mime TEXT NOT NULL,
  path TEXT NOT NULL,
  thumb_path TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  width INTEGER,
  height INTEGER,
  created_at TEXT NOT NULL,
  -- 归属约束：草稿没有 owner_id；已提交条目必须有 owner_id。
  CHECK (
    (owner_kind = 'draft' AND owner_id IS NULL) OR
    (owner_kind = 'item' AND owner_id IS NOT NULL)
  )
);
CREATE INDEX idx_quick_capture_attachments_owner
  ON quick_capture_attachments(owner_kind, owner_id, position);
"#,
);

/// 附件元数据（IPC 序列化，snake_case 与仓库既有命令一致）。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct CaptureAttachment {
    pub id: String,
    pub mime: String,
    pub byte_size: i64,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub position: i64,
}

/// 附件根目录状态（`data_dir/capture-attachments`）。
pub struct CaptureFiles {
    pub root: PathBuf,
}

impl CaptureFiles {
    /// 创建并校验根目录。子目录按需创建。
    pub fn new(root: PathBuf) -> AppResult<Self> {
        if root.as_os_str().is_empty() {
            return Err(AppError::Validation("附件目录不可用".into()));
        }
        std::fs::create_dir_all(&root)?;
        Ok(Self { root })
    }

    /// 原图绝对路径。`id` 只来自后端生成的 uuid（写入时）或数据库行（删除时），
    /// 不接受前端传入的任意路径；这里再做一次字符白名单校验，杜绝路径穿越。
    pub(crate) fn image_abs(&self, id: &str) -> PathBuf {
        self.root.join(DIR_IMAGES).join(format!("{}.png", safe_id(id)))
    }

    /// 缩略图绝对路径（同上）。
    pub(crate) fn thumb_abs(&self, id: &str) -> PathBuf {
        self.root.join(DIR_THUMBS).join(format!("{}.png", safe_id(id)))
    }
}

/// 附件 ID 只允许十六进制与短横线（uuid）以及保守的字母数字；
/// 其它字符一律替换，保证拼出的路径不会越出附件目录。
fn safe_id(id: &str) -> String {
    let cleaned: String = id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(64)
        .collect();
    if cleaned.is_empty() {
        "_invalid".into()
    } else {
        cleaned
    }
}

fn engine() -> base64::engine::general_purpose::GeneralPurpose {
    base64::engine::general_purpose::STANDARD
}

/// 解码后的待写入图片（已规范化成 PNG）。
struct PreparedImage {
    png: Vec<u8>,
    thumb: Vec<u8>,
    width: u32,
    height: u32,
}

/// 校验并规范化 PNG：签名 → 尺寸闸门 → 解码 → 重新编码（剥离元数据）。
fn prepare_png(bytes: &[u8]) -> AppResult<PreparedImage> {
    if bytes.is_empty() {
        return Err(AppError::Validation("图片内容为空".into()));
    }
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(AppError::Validation(format!(
            "单张图片不能超过 {} MB",
            MAX_IMAGE_BYTES / 1024 / 1024
        )));
    }
    // png_dimensions 同时校验签名与 IHDR，先做尺寸闸门再解码。
    let (w, h) = image::png_dimensions(bytes)?;
    if w > MAX_IMAGE_EDGE || h > MAX_IMAGE_EDGE || u64::from(w) * u64::from(h) > MAX_IMAGE_PIXELS {
        return Err(AppError::Validation(format!(
            "图片尺寸过大（最多 {MAX_IMAGE_EDGE}×{MAX_IMAGE_EDGE}）"
        )));
    }
    let (rgba, w, h) = image::decode_png_rgba(bytes)?;
    // 重新编码：丢掉原始容器里的附加块（EXIF/文本块），保证落盘文件是我们
    // 生成的规范 PNG；同时让 byte_size 反映真实存储大小。
    let png = image::encode_png(&rgba, w, h)?;
    let (thumb_rgba, tw, th) = image::thumbnail(&rgba, w, h);
    let thumb = image::encode_png(&thumb_rgba, tw, th)?;
    Ok(PreparedImage {
        png,
        thumb,
        width: w,
        height: h,
    })
}

fn write_atomic(path: &Path, bytes: &[u8]) -> AppResult<()> {
    let tmp = path.with_extension("png.tmp");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })?;
    Ok(())
}

fn row_to_attachment(r: &rusqlite::Row<'_>) -> rusqlite::Result<CaptureAttachment> {
    Ok(CaptureAttachment {
        id: r.get(0)?,
        mime: r.get(1)?,
        byte_size: r.get(2)?,
        width: r.get(3)?,
        height: r.get(4)?,
        position: r.get(5)?,
    })
}

const ATTACHMENT_COLUMNS: &str = "id, mime, byte_size, width, height, position";

pub(crate) fn draft_count(conn: &rusqlite::Connection) -> AppResult<usize> {
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM quick_capture_attachments
         WHERE owner_kind = 'draft' AND owner_id IS NULL",
        [],
        |r| r.get(0),
    )?;
    Ok(n.max(0) as usize)
}

/// 草稿附件的最近创建时间：用于「只有附件、没有正文」的合成草稿时间戳。
pub fn draft_latest_created_at(conn: &rusqlite::Connection) -> AppResult<Option<String>> {
    let value: Option<String> = conn.query_row(
        "SELECT MAX(created_at) FROM quick_capture_attachments
         WHERE owner_kind = 'draft' AND owner_id IS NULL",
        [],
        |r| r.get(0),
    )?;
    Ok(value)
}

/// 草稿附件列表（按粘贴顺序）。
pub fn list_draft(conn: &rusqlite::Connection) -> AppResult<Vec<CaptureAttachment>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {ATTACHMENT_COLUMNS} FROM quick_capture_attachments
         WHERE owner_kind = 'draft' AND owner_id IS NULL
         ORDER BY position ASC, created_at ASC"
    ))?;
    let rows = stmt.query_map([], row_to_attachment)?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

/// 批量读取条目的附件：一次查询覆盖整页，避免 N+1。
pub fn list_for_items(
    conn: &rusqlite::Connection,
    item_ids: &[String],
) -> AppResult<HashMap<String, Vec<CaptureAttachment>>> {
    let mut grouped: HashMap<String, Vec<CaptureAttachment>> = HashMap::new();
    if item_ids.is_empty() {
        return Ok(grouped);
    }
    // IN 占位符由 ID 数量决定；ID 全部来自数据库自身的行，不含用户输入。
    let placeholders = std::iter::repeat_n("?", item_ids.len())
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT owner_id, {ATTACHMENT_COLUMNS} FROM quick_capture_attachments
         WHERE owner_kind = 'item' AND owner_id IN ({placeholders})
         ORDER BY position ASC, created_at ASC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let params: Vec<&dyn rusqlite::ToSql> =
        item_ids.iter().map(|id| id as &dyn rusqlite::ToSql).collect();
    let mut rows = stmt.query(params.as_slice())?;
    while let Some(row) = rows.next()? {
        let owner: String = row.get(0)?;
        // 第 0 列是 owner_id，附件字段整体后移一列：单独映射，避免复用
        // `row_to_attachment`（它假定从 0 开始）读错列。
        let attachment = CaptureAttachment {
            id: row.get(1)?,
            mime: row.get(2)?,
            byte_size: row.get(3)?,
            width: row.get(4)?,
            height: row.get(5)?,
            position: row.get(6)?,
        };
        grouped.entry(owner).or_default().push(attachment);
    }
    Ok(grouped)
}

/// 单条目附件（供 mark_handled / convert_to_task 的返回值使用）。
pub fn list_for_item(conn: &rusqlite::Connection, item_id: &str) -> AppResult<Vec<CaptureAttachment>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {ATTACHMENT_COLUMNS} FROM quick_capture_attachments
         WHERE owner_kind = 'item' AND owner_id = ?1
         ORDER BY position ASC, created_at ASC"
    ))?;
    let rows = stmt.query_map(rusqlite::params![item_id], row_to_attachment)?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

/// 添加一张粘贴图片：规范化 → 落盘 → 入库（同一连接内先查数量再插入）。
///
/// 入库失败会删除刚写的两个文件，不留孤儿；数量超限在写文件之前就拒绝。
pub fn add(db: &Db, files: &CaptureFiles, data_base64: &str, mime: &str) -> AppResult<CaptureAttachment> {
    let mime = mime.trim().to_ascii_lowercase();
    if !matches!(mime.as_str(), "image/png" | "image/jpeg" | "image/webp") {
        return Err(AppError::Validation("只支持 PNG / JPEG / WebP 图片".into()));
    }
    let raw = engine()
        .decode(data_base64.trim())
        .map_err(|_| AppError::Validation("图片数据无法解码".into()))?;
    let prepared = prepare_png(&raw)?;

    let id = uuid::Uuid::new_v4().to_string();
    std::fs::create_dir_all(files.root.join(DIR_IMAGES))?;
    std::fs::create_dir_all(files.root.join(DIR_THUMBS))?;
    let img_path = files.image_abs(&id);
    let thumb_path = files.thumb_abs(&id);
    if let Err(e) = write_atomic(&img_path, &prepared.png)
        .and_then(|_| write_atomic(&thumb_path, &prepared.thumb))
    {
        let _ = std::fs::remove_file(&img_path);
        let _ = std::fs::remove_file(&thumb_path);
        return Err(e);
    }

    let now = crate::agents::now_iso();
    let inserted = db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        if draft_count(&tx)? >= MAX_ATTACHMENTS {
            return Err(AppError::Validation(format!(
                "最多添加 {MAX_ATTACHMENTS} 张图片"
            )));
        }
        let position: i64 = tx.query_row(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM quick_capture_attachments
             WHERE owner_kind = 'draft' AND owner_id IS NULL",
            [],
            |r| r.get(0),
        )?;
        tx.execute(
            "INSERT INTO quick_capture_attachments
               (id, owner_kind, owner_id, position, mime, path, thumb_path, byte_size, width, height, created_at)
             VALUES (?1, 'draft', NULL, ?2, 'image/png', ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![
                id,
                position,
                format!("{DIR_IMAGES}/{id}.png"),
                format!("{DIR_THUMBS}/{id}.png"),
                prepared.png.len() as i64,
                prepared.width as i64,
                prepared.height as i64,
                now
            ],
        )?;
        tx.commit()?;
        Ok(())
    });
    if let Err(e) = inserted {
        let _ = std::fs::remove_file(&img_path);
        let _ = std::fs::remove_file(&thumb_path);
        return Err(e);
    }
    Ok(CaptureAttachment {
        id,
        mime: "image/png".into(),
        byte_size: prepared.png.len() as i64,
        width: Some(prepared.width as i64),
        height: Some(prepared.height as i64),
        position: 0,
    })
}

/// 删除草稿附件（已提交条目的附件不在这里删，避免误删历史记录里的图片）。
pub fn remove_draft(db: &Db, files: &CaptureFiles, id: &str) -> AppResult<()> {
    let removed = db.with_conn(|conn| {
        let n = conn.execute(
            "DELETE FROM quick_capture_attachments
             WHERE id = ?1 AND owner_kind = 'draft' AND owner_id IS NULL",
            rusqlite::params![id],
        )?;
        Ok::<_, AppError>(n)
    })?;
    if removed == 0 {
        return Err(AppError::NotFound("图片不存在或已提交".into()));
    }
    let _ = std::fs::remove_file(files.image_abs(id));
    let _ = std::fs::remove_file(files.thumb_abs(id));
    Ok(())
}

/// 清空全部草稿附件（用户显式丢弃草稿 / 提交成功后残留）。
pub fn clear_draft(db: &Db, files: &CaptureFiles) -> AppResult<usize> {
    let ids: Vec<String> = db.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id FROM quick_capture_attachments
             WHERE owner_kind = 'draft' AND owner_id IS NULL",
        )?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    })?;
    db.with_conn(|conn| {
        conn.execute(
            "DELETE FROM quick_capture_attachments
             WHERE owner_kind = 'draft' AND owner_id IS NULL",
            [],
        )?;
        Ok::<_, AppError>(())
    })?;
    for id in &ids {
        let _ = std::fs::remove_file(files.image_abs(id));
        let _ = std::fs::remove_file(files.thumb_abs(id));
    }
    Ok(ids.len())
}

/// 提交时把草稿附件转成条目附件（必须在调用方事务内执行）。
///
/// 返回实际转正的行数；调用方据此确认「声明的附件都还在草稿里」，否则整体回滚
/// （例如另一个窗口/另一次提交已经把同一张图转走）。
pub fn transfer_to_item(
    tx: &rusqlite::Transaction<'_>,
    ids: &[String],
    item_id: &str,
) -> AppResult<usize> {
    let mut moved = 0usize;
    for (index, id) in ids.iter().enumerate() {
        let n = tx.execute(
            "UPDATE quick_capture_attachments
             SET owner_kind = 'item', owner_id = ?1, position = ?2
             WHERE id = ?3 AND owner_kind = 'draft' AND owner_id IS NULL",
            rusqlite::params![item_id, index as i64, id],
        )?;
        moved += n;
    }
    Ok(moved)
}

/// 删除条目时收集附件行（在事务内删除行，文件由调用方在提交后删除）。
pub fn take_item_attachments(
    tx: &rusqlite::Transaction<'_>,
    item_id: &str,
) -> AppResult<Vec<String>> {
    let ids: Vec<String> = {
        let mut stmt = tx.prepare(
            "SELECT id FROM quick_capture_attachments
             WHERE owner_kind = 'item' AND owner_id = ?1",
        )?;
        let rows = stmt.query_map(rusqlite::params![item_id], |r| r.get::<_, String>(0))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        out
    };
    tx.execute(
        "DELETE FROM quick_capture_attachments WHERE owner_kind = 'item' AND owner_id = ?1",
        rusqlite::params![item_id],
    )?;
    Ok(ids)
}

/// 按 ID 删除附件文件（尽力而为：文件不存在/占用不阻断数据库删除）。
pub fn remove_files(files: &CaptureFiles, ids: &[String]) {
    for id in ids {
        let _ = std::fs::remove_file(files.image_abs(id));
        let _ = std::fs::remove_file(files.thumb_abs(id));
    }
}

fn read_data_url(path: &Path) -> AppResult<Option<String>> {
    if !path.is_file() {
        return Ok(None);
    }
    let bytes = std::fs::read(path)?;
    Ok(Some(format!(
        "data:image/png;base64,{}",
        engine().encode(&bytes)
    )))
}

/// 附件是否存在（读文件前的数据库闸门：路径只由数据库提供，不接受前端路径）。
fn exists(db: &Db, id: &str) -> AppResult<bool> {
    db.with_read(|conn| {
        let n: i64 = conn.query_row(
            "SELECT COUNT(*) FROM quick_capture_attachments WHERE id = ?1",
            rusqlite::params![id],
            |r| r.get(0),
        )?;
        Ok(n > 0)
    })
}

/// 缩略图 data URL（列表/草稿预览用，约 192px）。
pub fn thumb_data_url(db: &Db, files: &CaptureFiles, id: &str) -> AppResult<Option<String>> {
    if !exists(db, id)? {
        return Ok(None);
    }
    read_data_url(&files.thumb_abs(id))
}

/// 原图 data URL（大图预览用）。
pub fn preview_data_url(db: &Db, files: &CaptureFiles, id: &str) -> AppResult<Option<String>> {
    if !exists(db, id)? {
        return Ok(None);
    }
    read_data_url(&files.image_abs(id))
}

/// 回收未被数据库引用、且超过年龄门槛的附件文件。
///
/// 场景：写入文件后进程崩溃（行没写成）、删除行后文件被占用。只扫两个子目录、
/// 只删「数据库里查不到」的文件，且有 1 小时年龄门槛，不会碰到正在写入的文件。
pub fn cleanup_orphans(db: &Db, files: &CaptureFiles) -> AppResult<usize> {
    let known: std::collections::HashSet<String> = db.with_read(|conn| {
        let mut stmt = conn.prepare("SELECT id FROM quick_capture_attachments")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        let mut out = std::collections::HashSet::new();
        for row in rows {
            out.insert(row?);
        }
        Ok(out)
    })?;
    let mut removed = 0usize;
    for dir in [DIR_IMAGES, DIR_THUMBS] {
        let path = files.root.join(dir);
        let Ok(entries) = std::fs::read_dir(&path) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(stem) = Path::new(&name).file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            let is_png = entry
                .path()
                .extension()
                .and_then(|e| e.to_str())
                .is_some_and(|ext| ext.eq_ignore_ascii_case("png"));
            let is_tmp = entry
                .path()
                .extension()
                .and_then(|e| e.to_str())
                .is_some_and(|ext| ext.eq_ignore_ascii_case("tmp"));
            if !is_png && !is_tmp {
                continue;
            }
            if known.contains(stem) {
                continue;
            }
            let stale = entry
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|m| m.elapsed().ok())
                .is_some_and(|age| age > ORPHAN_MIN_AGE);
            if !stale {
                continue;
            }
            if std::fs::remove_file(entry.path()).is_ok() {
                removed += 1;
            }
        }
    }
    if removed > 0 {
        tracing::info!(removed, "快速捕获附件：已回收孤立文件");
    }
    Ok(removed)
}

/// 草稿是否有附件（`save_draft` 判断「空正文是否该保留草稿行」）。
pub fn draft_has_attachments(db: &Db) -> AppResult<bool> {
    db.with_read(|conn| Ok(draft_count(conn)? > 0))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_env(tag: &str) -> (PathBuf, Db, CaptureFiles) {
        let dir = std::env::temp_dir().join(format!("td-qc-att-{}-{}", tag, uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("创建临时目录");
        let db = Db::open(&dir.join("t.db")).expect("打开临时数据库");
        let files = CaptureFiles::new(dir.join("attachments")).expect("创建附件目录");
        (dir, db, files)
    }

    fn png_base64(width: u32, height: u32) -> String {
        let rgba = vec![0x40u8; (width * height * 4) as usize];
        let png = image::encode_png(&rgba, width, height).expect("编码 PNG");
        base64::engine::general_purpose::STANDARD.encode(png)
    }

    #[test]
    fn add_writes_files_and_row_then_lists_in_order() {
        let (dir, db, files) = temp_env("add");
        let a = add(&db, &files, &png_base64(8, 8), "image/png").expect("添加第一张");
        let b = add(&db, &files, &png_base64(4, 4), "image/jpeg").expect("添加第二张");
        assert!(files.image_abs(&a.id).is_file(), "原图必须落盘");
        assert!(files.thumb_abs(&a.id).is_file(), "缩略图必须落盘");
        assert_eq!(a.mime, "image/png", "统一转存为 PNG");
        assert_eq!(a.width, Some(8));

        let list = db
            .with_read(|conn| list_draft(conn))
            .expect("读取草稿附件");
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].id, a.id);
        assert_eq!(list[1].id, b.id);
        drop(db);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn rejects_non_image_mime_and_bad_base64() {
        let (dir, db, files) = temp_env("reject");
        assert!(add(&db, &files, &png_base64(4, 4), "image/gif").is_err());
        assert!(add(&db, &files, &png_base64(4, 4), "text/plain").is_err());
        assert!(add(&db, &files, "not-base64!!", "image/png").is_err());
        // 非 PNG 字节即使是合法 base64 也必须拒绝
        let not_png = base64::engine::general_purpose::STANDARD.encode(b"hello world");
        assert!(add(&db, &files, &not_png, "image/png").is_err());
        drop(db);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn rejects_oversized_dimensions_before_decoding() {
        let (dir, db, files) = temp_env("big");
        // 用压缩率高的纯色大图验证闸门：容器很小，像素数超限
        let png = png_base64(MAX_IMAGE_EDGE + 1, 2);
        let err = add(&db, &files, &png, "image/png").unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
        drop(db);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn attachment_count_is_capped() {
        let (dir, db, files) = temp_env("cap");
        for _ in 0..MAX_ATTACHMENTS {
            add(&db, &files, &png_base64(2, 2), "image/png").expect("添加");
        }
        let err = add(&db, &files, &png_base64(2, 2), "image/png").unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
        // 超限请求不得留下多余文件
        let images = std::fs::read_dir(files.root.join(DIR_IMAGES)).unwrap().count();
        assert_eq!(images, MAX_ATTACHMENTS);
        drop(db);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn transfer_moves_ownership_and_keeps_files() {
        let (dir, db, files) = temp_env("transfer");
        let a = add(&db, &files, &png_base64(4, 4), "image/png").expect("添加");
        db.with_conn(|conn| {
            let tx = conn.unchecked_transaction()?;
            let moved = transfer_to_item(&tx, std::slice::from_ref(&a.id), "item-1")?;
            assert_eq!(moved, 1);
            tx.commit()?;
            Ok::<_, AppError>(())
        })
        .expect("转正");
        let draft = db.with_read(|conn| list_draft(conn)).unwrap();
        assert!(draft.is_empty(), "转正后不再属于草稿");
        let items = db
            .with_read(|conn| list_for_items(conn, &["item-1".to_string()]))
            .unwrap();
        assert_eq!(items["item-1"].len(), 1);
        assert!(files.image_abs(&a.id).is_file(), "转正不得删文件");
        // 再次转正同一 ID：0 行，幂等且不会重复挂到第二个条目
        db.with_conn(|conn| {
            let tx = conn.unchecked_transaction()?;
            assert_eq!(transfer_to_item(&tx, std::slice::from_ref(&a.id), "item-2")?, 0);
            tx.commit()?;
            Ok::<_, AppError>(())
        })
        .expect("重复转正");
        drop(db);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn remove_and_clear_delete_rows_and_files() {
        let (dir, db, files) = temp_env("remove");
        let a = add(&db, &files, &png_base64(4, 4), "image/png").expect("添加");
        remove_draft(&db, &files, &a.id).expect("删除");
        assert!(!files.image_abs(&a.id).exists());
        assert!(files.thumb_abs(&a.id).exists() == false);
        assert!(remove_draft(&db, &files, &a.id).is_err(), "重复删除应报 NotFound");

        let b = add(&db, &files, &png_base64(4, 4), "image/png").expect("添加");
        assert_eq!(clear_draft(&db, &files).expect("清空"), 1);
        assert!(!files.image_abs(&b.id).exists());
        drop(db);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn data_url_reads_respect_db_ownership() {
        let (dir, db, files) = temp_env("url");
        let a = add(&db, &files, &png_base64(6, 6), "image/png").expect("添加");
        let thumb = thumb_data_url(&db, &files, &a.id).unwrap().expect("缩略图");
        assert!(thumb.starts_with("data:image/png;base64,"));
        let preview = preview_data_url(&db, &files, &a.id).unwrap().expect("原图");
        assert!(preview.starts_with("data:image/png;base64,"));
        assert!(thumb_data_url(&db, &files, "not-exist").unwrap().is_none());
        drop(db);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn orphan_cleanup_skips_referenced_and_fresh_files() {
        let (dir, db, files) = temp_env("orphan");
        let kept = add(&db, &files, &png_base64(2, 2), "image/png").expect("添加");
        // 未被引用但很新：不能删（可能正在写入）
        let fresh = files.image_abs("fresh-orphan");
        std::fs::create_dir_all(fresh.parent().unwrap()).unwrap();
        std::fs::write(&fresh, b"x").unwrap();
        assert_eq!(cleanup_orphans(&db, &files).expect("清理"), 0);
        assert!(fresh.exists());
        assert!(files.image_abs(&kept.id).exists());
        drop(db);
        let _ = std::fs::remove_dir_all(dir);
    }
}
