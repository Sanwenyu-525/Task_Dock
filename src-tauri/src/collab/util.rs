//! 协作中心通用工具：时间、ID、字段校验、路径与哈希。
//!
//! 规则：
//! - 所有文本先 trim + 长度校验；错误信息只暴露字段名与限制，不回显正文。
//! - 时间统一 RFC3339（UTC），与 `agents::now_iso` 语义一致。
//! - 证据/资产路径只允许应用数据目录内的普通文件，拒绝 `..` 与符号链接。

use std::path::{Component, Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::error::{AppError, AppResult};

pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

pub fn new_id(prefix: &str) -> String {
    format!("{prefix}_{}", uuid::Uuid::new_v4())
}

pub fn validate_text(value: &str, field: &str, max: usize, required: bool) -> AppResult<String> {
    let trimmed = value.trim();
    if required && trimmed.is_empty() {
        return Err(AppError::Validation(format!("{field}不能为空")));
    }
    if trimmed.chars().count() > max {
        return Err(AppError::Validation(format!(
            "{field}超过 {max} 字符上限"
        )));
    }
    Ok(trimmed.to_string())
}

pub fn validate_enum(value: &str, allowed: &[&str], field: &str) -> AppResult<String> {
    if allowed.contains(&value) {
        Ok(value.to_string())
    } else {
        Err(AppError::Validation(format!(
            "{field} 非法：{value}（允许 {}）",
            allowed.join("/")
        )))
    }
}

pub fn validate_string_list(
    items: &[String],
    field: &str,
    max_items: usize,
    max_len: usize,
) -> AppResult<Vec<String>> {
    if items.len() > max_items {
        return Err(AppError::Validation(format!(
            "{field} 最多 {max_items} 条"
        )));
    }
    let mut out = Vec::with_capacity(items.len());
    for item in items {
        let t = item.trim();
        if t.is_empty() {
            continue;
        }
        if t.chars().count() > max_len {
            return Err(AppError::Validation(format!(
                "{field} 单条超过 {max_len} 字符"
            )));
        }
        out.push(t.to_string());
    }
    Ok(out)
}

pub fn parse_string_array(raw: &str) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(raw).unwrap_or_default()
}

pub fn json_array(items: &[String]) -> String {
    serde_json::to_string(items).unwrap_or_else(|_| "[]".to_string())
}

/// 去重键：小写、折叠空白、去掉标点，只保留字母数字与 CJK。
pub fn normalize_key(text: &str) -> String {
    let mut out = String::new();
    let mut last_space = false;
    for ch in text.chars().flat_map(|c| c.to_lowercase()) {
        if ch.is_alphanumeric() {
            out.push(ch);
            last_space = false;
        } else if !last_space {
            out.push(' ');
            last_space = true;
        }
    }
    out.trim().to_string()
}

pub fn page_bounds(page: Option<i64>, page_size: Option<i64>, max: i64) -> (i64, i64, i64) {
    let page = page.unwrap_or(1).max(1);
    let size = page_size.unwrap_or(20).clamp(1, max);
    let offset = (page - 1).saturating_mul(size);
    (page, size, offset)
}

/// 应用数据目录：优先 `TASK_DOCK_DATA_DIR`，其次 `%APPDATA%/com.taskdock.desktop`。
pub fn data_root() -> PathBuf {
    if let Some(dir) = std::env::var_os("TASK_DOCK_DATA_DIR") {
        return PathBuf::from(dir);
    }
    if let Some(appdata) = std::env::var_os("APPDATA") {
        return PathBuf::from(appdata).join("com.taskdock.desktop");
    }
    std::env::temp_dir().join("taskdock")
}

pub fn collab_evidence_root() -> PathBuf {
    data_root().join("collab-evidence")
}

pub fn collab_assets_root() -> PathBuf {
    data_root().join("collab-assets")
}

/// 校验路径是普通文件且位于 `root` 内；返回规范化绝对路径。
pub fn assert_file_in_root(path: &Path, root: &Path, field: &str) -> AppResult<PathBuf> {
    let canon_root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let canon = path
        .canonicalize()
        .map_err(|_| AppError::Validation(format!("{field} 不存在或不可访问")))?;
    if !canon.starts_with(&canon_root) {
        return Err(AppError::Validation(format!("{field} 超出允许目录")));
    }
    let meta = std::fs::metadata(&canon)
        .map_err(|_| AppError::Validation(format!("{field} 不存在或不可访问")))?;
    if !meta.is_file() {
        return Err(AppError::Validation(format!("{field} 必须是普通文件")));
    }
    Ok(canon)
}

/// 拒绝包含 `..` 的相对路径与空组件；用于用户提供的相对资源名。
pub fn assert_relative_safe(path: &Path, field: &str) -> AppResult<()> {
    for comp in path.components() {
        match comp {
            Component::Normal(_) => {}
            Component::CurDir => {}
            _ => {
                return Err(AppError::Validation(format!(
                    "{field} 不允许绝对路径或 .. 逃逸"
                )))
            }
        }
    }
    Ok(())
}

pub fn sanitize_filename(name: &str) -> String {
    let mut out: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') || (c as u32) > 127 {
                c
            } else {
                '_'
            }
        })
        .collect();
    if out.trim_matches(['.', '_']).is_empty() {
        out = "file".to_string();
    }
    if out.chars().count() > 80 {
        out = out.chars().take(80).collect();
    }
    out
}

pub fn sha256_bytes(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    format!("{:x}", hasher.finalize())
}

pub fn sha256_file(path: &Path) -> AppResult<String> {
    let data = std::fs::read(path)?;
    Ok(sha256_bytes(&data))
}

/// 把 `Option<String>` 归一：空串视为 None（避免 `Some("")` 落库）。
pub fn non_empty(value: Option<String>) -> Option<String> {
    value.and_then(|v| {
        let t = v.trim().to_string();
        if t.is_empty() {
            None
        } else {
            Some(t)
        }
    })
}
