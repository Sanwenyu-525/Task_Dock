//! 重复内容检测：同内容 / 同原始路径 / 同名不同内容 / 相似图片。
//!
//! 只做**提示**，绝不自动合并、删除或移动；哈希结果写回 `shelf_items`
//! 以复用（`content_hash` / `image_hash`），下次检测不再重复读大文件。
//!
//! 边界：
//! - 单文件超过 [`MAX_HASH_BYTES`] 不读字节，仍参与路径/同名判断；
//! - 文件夹不计算内容哈希；
//! - 相似图片只在可解码的 PNG 上计算 8×8 均值哈希，其他格式明确跳过；
//! - 读不到的原文件只记录失败，不影响其他条目。

use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};

use rusqlite::params;
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::db::Db;
use crate::error::{AppError, AppResult};

/// 单次检测条目上限。
pub const MAX_SCAN_ITEMS: usize = 500;
/// 参与内容哈希的单文件上限：超过只做路径/同名判断。
pub const MAX_HASH_BYTES: u64 = 256 * 1024 * 1024;
/// 相似图片判定：8×8 均值哈希的汉明距离上限。
pub const SIMILAR_HAMMING: u32 = 10;
/// 单次返回的重复组上限。
pub const MAX_GROUPS: usize = 40;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DedupItem {
    pub id: String,
    pub display_name: String,
    pub kind: String,
    pub byte_size: i64,
    pub original_path: Option<String>,
    pub content_hash: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DedupGroup {
    /// exact | same_path | similar_image | same_name
    pub kind: String,
    pub key: String,
    pub items: Vec<DedupItem>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DedupFailure {
    pub item_id: String,
    pub code: String,
    pub reason: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct DedupReport {
    pub scanned: usize,
    pub hashed: usize,
    pub groups: Vec<DedupGroup>,
    pub unreadable: Vec<DedupFailure>,
    pub truncated: bool,
}

struct Row {
    id: String,
    kind: String,
    display_name: String,
    original_path: Option<String>,
    managed_path: Option<String>,
    content: Option<String>,
    byte_size: i64,
    content_hash: Option<String>,
    image_hash: Option<String>,
    exists_state: String,
}

fn load_rows(db: &Db, ids: Option<&[String]>) -> AppResult<Vec<Row>> {
    db.with_read(|conn| {
        let mut out = Vec::new();
        let map = |r: &rusqlite::Row<'_>| -> rusqlite::Result<Row> {
            Ok(Row {
                id: r.get(0)?,
                kind: r.get(1)?,
                display_name: r.get(2)?,
                original_path: r.get(3)?,
                managed_path: r.get(4)?,
                content: r.get(5)?,
                byte_size: r.get(6)?,
                content_hash: r.get(7)?,
                image_hash: r.get(8)?,
                exists_state: r.get(9)?,
            })
        };
        if let Some(ids) = ids {
            if ids.is_empty() {
                return Ok(out);
            }
            let placeholders = vec!["?"; ids.len()].join(",");
            let sql = format!(
                "SELECT id, kind, display_name, original_path, managed_path, content, byte_size, \
                 content_hash, image_hash, exists_state FROM shelf_items WHERE id IN ({placeholders})"
            );
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(rusqlite::params_from_iter(ids.iter()), map)?;
            for row in rows {
                out.push(row?);
            }
        } else {
            let mut stmt = conn.prepare(
                "SELECT id, kind, display_name, original_path, managed_path, content, byte_size, \
                 content_hash, image_hash, exists_state FROM shelf_items \
                 ORDER BY created_at DESC LIMIT ?1",
            )?;
            let rows = stmt.query_map(params![MAX_SCAN_ITEMS as i64], map)?;
            for row in rows {
                out.push(row?);
            }
        }
        Ok(out)
    })
}

fn sha256_file(path: &Path) -> AppResult<Option<String>> {
    let meta = std::fs::metadata(path)?;
    if meta.len() > MAX_HASH_BYTES {
        return Ok(None);
    }
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 256 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(Some(format!("{:x}", hasher.finalize())))
}

fn sha256_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

/// 8×8 灰度均值哈希（aHash）；只接受可解码 PNG。
/// 纯色/近乎纯色的图片没有可比较结构，返回 `Ok(None)`（不误报相似）。
fn phash_png(bytes: &[u8]) -> AppResult<Option<u64>> {
    let (rgba, w, h) = crate::clipboard::image::decode_png_rgba(bytes)?;
    if w == 0 || h == 0 {
        return Err(AppError::Validation("图片尺寸无效".into()));
    }
    let mut cells = [0f64; 64];
    for gy in 0..8u32 {
        for gx in 0..8u32 {
            let x0 = gx * w / 8;
            let x1 = ((gx + 1) * w / 8).max(x0 + 1).min(w);
            let y0 = gy * h / 8;
            let y1 = ((gy + 1) * h / 8).max(y0 + 1).min(h);
            // 每格最多采样 16×16 点，避免大图退化为全像素遍历。
            let sx = ((x1 - x0) / 16).max(1);
            let sy = ((y1 - y0) / 16).max(1);
            let mut sum = 0f64;
            let mut n = 0f64;
            let mut y = y0;
            while y < y1 {
                let mut x = x0;
                while x < x1 {
                    let i = ((y * w + x) * 4) as usize;
                    let lum = 0.299 * rgba[i] as f64
                        + 0.587 * rgba[i + 1] as f64
                        + 0.114 * rgba[i + 2] as f64;
                    sum += lum;
                    n += 1.0;
                    x += sx;
                }
                y += sy;
            }
            cells[(gy * 8 + gx) as usize] = if n > 0.0 { sum / n } else { 0.0 };
        }
    }
    let mean = cells.iter().sum::<f64>() / 64.0;
    let min = cells.iter().cloned().fold(f64::INFINITY, f64::min);
    let max = cells.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    if max - min < 4.0 {
        return Ok(None);
    }
    let mut hash = 0u64;
    for (i, v) in cells.iter().enumerate() {
        if *v >= mean {
            hash |= 1u64 << i;
        }
    }
    Ok(Some(hash))
}

fn hex64(v: u64) -> String {
    format!("{v:016x}")
}

fn parse_hex64(s: &str) -> Option<u64> {
    u64::from_str_radix(s, 16).ok()
}

fn normalize_path(p: &str) -> String {
    let mut s = p.trim().replace('/', "\\");
    while s.len() > 3 && s.ends_with('\\') {
        s.pop();
    }
    s.to_lowercase()
}

fn item_view(row: &Row, content_hash: Option<&str>) -> DedupItem {
    DedupItem {
        id: row.id.clone(),
        display_name: row.display_name.clone(),
        kind: row.kind.clone(),
        byte_size: row.byte_size,
        original_path: row.original_path.clone(),
        content_hash: content_hash.map(|s| s.to_string()),
    }
}

/// 计算并回写单条内容的哈希（内容/文件字节 + 图片指纹）。
/// 返回是否成功拿到内容哈希。
fn ensure_hash(db: &Db, root: &Path, row: &mut Row, failures: &mut Vec<DedupFailure>) -> bool {
    if row.content_hash.is_some() {
        return true;
    }
    let computed: AppResult<Option<String>> = (|| {
        match row.kind.as_str() {
            "text" => {
                let bytes = row.content.as_deref().unwrap_or("").as_bytes();
                Ok(Some(sha256_bytes(bytes)))
            }
            "link" => {
                let url = row.original_path.as_deref().unwrap_or("");
                if url.is_empty() {
                    Ok(None)
                } else {
                    Ok(Some(sha256_bytes(url.as_bytes())))
                }
            }
            "file" | "image" => {
                if row.exists_state == "missing" {
                    return Ok(None);
                }
                let path: Option<PathBuf> = if row.storage_mode_managed() {
                    row.managed_path
                        .as_deref()
                        .and_then(|rel| crate::shelf::safe_managed_rel(rel).ok())
                        .map(|rel| root.join(rel))
                } else {
                    row.original_path.as_deref().map(PathBuf::from)
                };
                let Some(path) = path else { return Ok(None) };
                sha256_file(&path)
            }
            _ => Ok(None),
        }
    })();
    match computed {
        Ok(Some(hash)) => {
            row.content_hash = Some(hash.clone());
            let _ = db.with_conn(|conn| {
                conn.execute(
                    "UPDATE shelf_items SET content_hash = ?2 WHERE id = ?1",
                    params![row.id, hash],
                )?;
                Ok(())
            });
            // 图片指纹可独立失败（非 PNG / 解码失败）：不影响内容哈希。
            if row.kind == "image" && row.image_hash.is_none() {
                if let Some(ph) = compute_image_hash(root, row) {
                    row.image_hash = Some(hex64(ph));
                    let _ = db.with_conn(|conn| {
                        conn.execute(
                            "UPDATE shelf_items SET image_hash = ?2 WHERE id = ?1",
                            params![row.id, hex64(ph)],
                        )?;
                        Ok(())
                    });
                }
            }
            true
        }
        Ok(None) => false,
        Err(e) => {
            failures.push(DedupFailure {
                item_id: row.id.clone(),
                code: "SHELF_HASH_UNREADABLE".into(),
                reason: format!("无法读取内容：{e}"),
            });
            false
        }
    }
}

impl Row {
    fn storage_mode_managed(&self) -> bool {
        self.managed_path.is_some() && self.kind != "folder"
    }
}

fn compute_image_hash(root: &Path, row: &Row) -> Option<u64> {
    let path = if let Some(rel) = row.managed_path.as_deref() {
        crate::shelf::safe_managed_rel(rel).ok().map(|r| root.join(r))?
    } else {
        PathBuf::from(row.original_path.as_deref()?)
    };
    let meta = std::fs::metadata(&path).ok()?;
    if meta.len() > MAX_HASH_BYTES {
        return None;
    }
    let bytes = std::fs::read(&path).ok()?;
    phash_png(&bytes).ok().flatten()
}

/// 检测重复（只提示）。`ids=None` 时扫描最近 [`MAX_SCAN_ITEMS`] 条。
pub fn scan(db: &Db, root: &Path, ids: Option<&[String]>) -> AppResult<DedupReport> {
    if let Some(ids) = ids {
        if ids.len() > MAX_SCAN_ITEMS {
            return Err(AppError::Validation(format!(
                "单次最多检测 {MAX_SCAN_ITEMS} 个条目"
            )));
        }
    }
    let mut rows = load_rows(db, ids)?;
    let mut report = DedupReport {
        scanned: rows.len(),
        ..Default::default()
    };
    for row in rows.iter_mut() {
        if ensure_hash(db, root, row, &mut report.unreadable) {
            report.hashed += 1;
        }
    }

    // ── 内容完全相同 ────────────────────────────────────────
    let mut by_hash: HashMap<String, Vec<&Row>> = HashMap::new();
    for row in &rows {
        if let Some(h) = &row.content_hash {
            by_hash.entry(h.clone()).or_default().push(row);
        }
    }
    let mut hashes: Vec<&String> = by_hash.keys().collect();
    hashes.sort();
    for h in hashes {
        let members = &by_hash[h];
        if members.len() < 2 {
            continue;
        }
        report.groups.push(DedupGroup {
            kind: "exact".into(),
            key: h[..12.min(h.len())].to_string(),
            items: members
                .iter()
                .map(|m| item_view(m, m.content_hash.as_deref()))
                .collect(),
        });
    }

    // ── 相同原始路径（大小写与斜杠归一化）────────────────────
    let mut by_path: HashMap<String, Vec<&Row>> = HashMap::new();
    for row in &rows {
        let Some(p) = row.original_path.as_deref() else { continue };
        if p.trim().is_empty() {
            continue;
        }
        by_path.entry(normalize_path(p)).or_default().push(row);
    }
    let mut paths: Vec<&String> = by_path.keys().collect();
    paths.sort();
    for p in paths {
        let members = &by_path[p];
        if members.len() < 2 {
            continue;
        }
        // 内容哈希也相同 → 已被「完全相同」覆盖，不再重复提示。
        let distinct: HashSet<Option<&String>> =
            members.iter().map(|m| m.content_hash.as_ref()).collect();
        if distinct.len() == 1 && members[0].content_hash.is_some() {
            continue;
        }
        report.groups.push(DedupGroup {
            kind: "same_path".into(),
            key: p.clone(),
            items: members
                .iter()
                .map(|m| item_view(m, m.content_hash.as_deref()))
                .collect(),
        });
    }

    // ── 相似图片（连通分量，汉明距离 ≤ 阈值）──────────────────
    let images: Vec<(&Row, u64)> = rows
        .iter()
        .filter_map(|r| {
            let hash = r.image_hash.as_deref().and_then(parse_hex64)?;
            Some((r, hash))
        })
        .collect();
    let mut visited: HashSet<usize> = HashSet::new();
    for i in 0..images.len() {
        if visited.contains(&i) {
            continue;
        }
        let mut component = vec![i];
        for j in (i + 1)..images.len() {
            if visited.contains(&j) {
                continue;
            }
            if (images[i].1 ^ images[j].1).count_ones() <= SIMILAR_HAMMING {
                component.push(j);
            }
        }
        if component.len() < 2 {
            continue;
        }
        for idx in &component {
            visited.insert(*idx);
        }
        report.groups.push(DedupGroup {
            kind: "similar_image".into(),
            key: hex64(images[i].1),
            items: component
                .iter()
                .map(|idx| item_view(images[*idx].0, images[*idx].0.content_hash.as_deref()))
                .collect(),
        });
    }

    // ── 同名不同内容 ────────────────────────────────────────
    let mut by_name: HashMap<String, Vec<&Row>> = HashMap::new();
    for row in &rows {
        let name = row.display_name.trim().to_lowercase();
        if name.is_empty() {
            continue;
        }
        by_name.entry(name).or_default().push(row);
    }
    let mut names: Vec<&String> = by_name.keys().collect();
    names.sort();
    for n in names {
        let members = &by_name[n];
        if members.len() < 2 {
            continue;
        }
        let hashes: HashSet<Option<&String>> =
            members.iter().map(|m| m.content_hash.as_ref()).collect();
        // 内容一致的同名条目已被「完全相同」覆盖。
        if hashes.len() == 1 && members[0].content_hash.is_some() {
            continue;
        }
        report.groups.push(DedupGroup {
            kind: "same_name".into(),
            key: members[0].display_name.clone(),
            items: members
                .iter()
                .map(|m| item_view(m, m.content_hash.as_deref()))
                .collect(),
        });
    }

    // 分组排序：exact → same_path → similar_image → same_name，组内按名称。
    let rank = |k: &str| match k {
        "exact" => 0,
        "same_path" => 1,
        "similar_image" => 2,
        _ => 3,
    };
    report.groups.sort_by(|a, b| {
        rank(&a.kind)
            .cmp(&rank(&b.kind))
            .then_with(|| a.key.cmp(&b.key))
    });
    if report.groups.len() > MAX_GROUPS {
        report.groups.truncate(MAX_GROUPS);
        report.truncated = true;
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shelf::{add_managed_png, add_text};

    struct TempRoot(PathBuf);
    impl TempRoot {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!("td-shelf-dedup-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&p).unwrap();
            Self(p)
        }
    }
    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn test_db() -> Db {
        Db::open_in_memory().expect("in-memory db")
    }

    fn seed_file(db: &Db, root: &Path, dir: &Path, name: &str, body: &[u8]) -> String {
        let path = dir.join(name);
        std::fs::write(&path, body).unwrap();
        crate::shelf::add_managed(db, root, &path.to_string_lossy(), "manual", None)
            .map(|i| i.id)
            .unwrap_or_else(|_| {
                // 托管写入失败时退回引用模式（内容哈希仍可读）。
                crate::shelf::add_reference(db, root, &path.to_string_lossy(), "manual", None)
                    .unwrap()
                    .id
            })
    }

    fn png_gradient(root: &Path, db: &Db, shift: i32) -> String {
        // 横向渐变提供可比较结构；shift 只做轻微亮度偏移，模拟「相似截图」。
        let mut rgba = Vec::with_capacity(8 * 8 * 4);
        for _y in 0..8 {
            for x in 0..8 {
                let v = (x as i32 * 24 + shift).clamp(0, 255) as u8;
                rgba.extend_from_slice(&[v, v, v, 255]);
            }
        }
        let png = crate::clipboard::image::encode_png(&rgba, 8, 8).unwrap();
        add_managed_png(db, root, &png, "shot.png", "manual", None)
            .unwrap()
            .id
    }

    #[test]
    fn exact_content_across_paths() {
        let db = test_db();
        let tmp = TempRoot::new();
        std::fs::create_dir_all(tmp.0.join("shelf")).unwrap();
        let dir = &tmp.0;
        let a = seed_file(&db, &tmp.0.join("shelf"), dir, "a.txt", b"same-body");
        let b = seed_file(&db, &tmp.0.join("shelf"), dir, "b.txt", b"same-body");
        let report = scan(&db, &tmp.0.join("shelf"), Some(&[a, b])).unwrap();
        let exact: Vec<_> = report.groups.iter().filter(|g| g.kind == "exact").collect();
        assert_eq!(exact.len(), 1);
        assert_eq!(exact[0].items.len(), 2);
    }

    #[test]
    fn same_path_groups_are_normalized() {
        let db = test_db();
        let tmp = TempRoot::new();
        let dir = tmp.0.join("docs");
        std::fs::create_dir_all(&dir).unwrap();
        let a = crate::shelf::add_reference(&db, &tmp.0, &dir.to_string_lossy(), "manual", None)
            .unwrap()
            .id;
        // 同一目录的第二个条目，路径大小写与斜杠不同（Windows 归一化后相同）。
        let variant = dir.to_string_lossy().replace('\\', "/").to_uppercase();
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO shelf_items (id, kind, display_name, storage_mode, original_path, \
                 byte_size, created_at, updated_at) VALUES ('dup', 'folder', 'docs', \
                 'reference', ?1, 0, '2026-01-01', '2026-01-01')",
                params![variant],
            )?;
            Ok(())
        })
        .unwrap();
        let report = scan(&db, &tmp.0, Some(&[a, "dup".into()])).unwrap();
        assert!(report.groups.iter().any(|g| g.kind == "same_path"));
    }

    #[test]
    fn same_name_different_content() {
        let db = test_db();
        let tmp = TempRoot::new();
        let dir = tmp.0.join("d");
        std::fs::create_dir_all(&dir).unwrap();
        let a = seed_file(&db, &tmp.0, &dir, "a.txt", b"one");
        let b = seed_file(&db, &tmp.0, &dir, "b.txt", b"two");
        db.with_conn(|conn| {
            conn.execute("UPDATE shelf_items SET display_name = 'same.txt' WHERE id IN (?1, ?2)", params![a, b])?;
            Ok(())
        })
        .unwrap();
        let report = scan(&db, &tmp.0, Some(&[a, b])).unwrap();
        let group = report
            .groups
            .iter()
            .find(|g| g.kind == "same_name")
            .expect("same_name group");
        assert_eq!(group.items.len(), 2);
    }

    #[test]
    fn similar_images_group_but_different_images_do_not() {
        let db = test_db();
        let tmp = TempRoot::new();
        std::fs::create_dir_all(tmp.0.join("shelf")).unwrap();
        let root = tmp.0.join("shelf");
        let a = png_gradient(&root, &db, 0);
        let b = png_gradient(&root, &db, 2);
        // 反向渐变：结构完全不同，不应进入相似组。
        let mut rgba = Vec::with_capacity(8 * 8 * 4);
        for _y in 0..8 {
            for x in 0..8 {
                let v = ((7 - x) * 24) as u8;
                rgba.extend_from_slice(&[v, v, v, 255]);
            }
        }
        let png = crate::clipboard::image::encode_png(&rgba, 8, 8).unwrap();
        let c = add_managed_png(&db, &root, &png, "inverse.png", "manual", None)
            .unwrap()
            .id;
        let report = scan(&db, &root, Some(&[a.clone(), b.clone(), c.clone()])).unwrap();
        let similar = report
            .groups
            .iter()
            .find(|g| g.kind == "similar_image")
            .expect("similar group");
        assert!(similar.items.iter().any(|i| i.id == a));
        assert!(similar.items.iter().any(|i| i.id == b));
        assert!(!similar.items.iter().any(|i| i.id == c));
    }

    #[test]
    fn text_and_link_hashes_are_stored_and_reused() {
        let db = test_db();
        let tmp = TempRoot::new();
        let a = add_text(&db, "同样的正文", "manual", None).unwrap().id;
        let b = add_text(&db, "同样的正文", "manual", None).unwrap().id;
        let report = scan(&db, &tmp.0, Some(&[a.clone(), b.clone()])).unwrap();
        assert_eq!(report.hashed, 2);
        assert!(report.groups.iter().any(|g| g.kind == "exact"));
        let stored: i64 = db
            .with_read(|c| {
                Ok(c.query_row(
                    "SELECT COUNT(*) FROM shelf_items WHERE content_hash IS NOT NULL",
                    [],
                    |r| r.get(0),
                )?)
            })
            .unwrap();
        assert_eq!(stored, 2);
    }

    #[test]
    fn missing_reference_is_reported_not_fatal() {
        let db = test_db();
        let tmp = TempRoot::new();
        // 直接写入失效引用行（绕过 add_reference 的存在性校验）。
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO shelf_items (id, kind, display_name, storage_mode, original_path, \
                 byte_size, created_at, updated_at) VALUES ('gone', 'file', 'missing.bin', \
                 'reference', 'D:/nope/missing.bin', 0, '2026-01-01', '2026-01-01')",
                [],
            )?;
            Ok(())
        })
        .unwrap();
        let report = scan(&db, &tmp.0, Some(&["gone".into()])).unwrap();
        assert_eq!(report.scanned, 1);
        // 读不到的内容只记失败，不中断整次检测。
        assert_eq!(report.unreadable.len(), 1);
        assert_eq!(report.unreadable[0].code, "SHELF_HASH_UNREADABLE");
    }

    #[test]
    fn caps_scan_size() {
        let db = test_db();
        let tmp = TempRoot::new();
        let ids: Vec<String> = (0..=MAX_SCAN_ITEMS).map(|i| format!("id-{i}")).collect();
        assert!(scan(&db, &tmp.0, Some(&ids)).is_err());
    }
}
