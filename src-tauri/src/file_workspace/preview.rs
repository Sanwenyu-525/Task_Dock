//! 轻量快速预览的媒体桥：只给用户显式预览的单个本地文件发短期 token，
//! 通过 `taskdock-preview` 自定义协议支持视频/音频 Range 读取。
//!
//! 安全边界：
//! - token 由命令在路径校验（绝对路径、存在、非受保护目录）后注册；
//! - token 30 分钟过期，最多保留 64 个；协议层只接受已注册 token，不接受任意路径；
//! - 单次读取 Range 上限 8 MiB，浏览器按需继续请求；不把整个大视频读进内存。

use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use tauri::http::{header, HeaderValue, Request, Response, StatusCode};
use uuid::Uuid;

use crate::error::{AppError, AppResult};

const TOKEN_TTL: Duration = Duration::from_secs(30 * 60);
const MAX_TOKENS: usize = 64;
const MAX_RANGE_BYTES: u64 = 8 * 1024 * 1024;

struct PreviewToken {
    path: PathBuf,
    expires: Instant,
}

static TOKENS: OnceLock<Mutex<HashMap<String, PreviewToken>>> = OnceLock::new();

fn tokens() -> &'static Mutex<HashMap<String, PreviewToken>> {
    TOKENS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn prune(map: &mut HashMap<String, PreviewToken>) {
    let now = Instant::now();
    map.retain(|_, token| token.expires > now);
    while map.len() >= MAX_TOKENS {
        let Some(oldest) = map
            .iter()
            .min_by_key(|(_, token)| token.expires)
            .map(|(key, _)| key.clone())
        else {
            break;
        };
        map.remove(&oldest);
    }
}

/// 注册一个可预览媒体文件；返回给 WebView 的短期 URL。
pub fn register_media_url(path: &Path) -> AppResult<String> {
    let meta = std::fs::metadata(path)
        .map_err(|e| AppError::NotFound(format!("媒体文件不可读: {e}")))?;
    if !meta.is_file() {
        return Err(AppError::Validation("仅支持预览单个文件".into()));
    }
    let mut map = tokens()
        .lock()
        .map_err(|_| AppError::Validation("预览令牌状态不可用".into()))?;
    prune(&mut map);
    let token = Uuid::new_v4().simple().to_string();
    map.insert(
        token.clone(),
        PreviewToken {
            path: path.to_path_buf(),
            expires: Instant::now() + TOKEN_TTL,
        },
    );
    drop(map);
    Ok(media_url(&token))
}

fn media_url(token: &str) -> String {
    // Windows/Android 的 Tauri 自定义协议走 `http://<scheme>.localhost/<path>`。
    format!("http://taskdock-preview.localhost/{token}")
}

/// 预览关闭/切换时主动释放 token；旧 token 立即失效，不再占用 64 个槽位。
pub fn release_media_url(url: &str) -> AppResult<()> {
    let prefix = "http://taskdock-preview.localhost/";
    let token = url
        .strip_prefix(prefix)
        .unwrap_or("")
        .split('/')
        .next()
        .unwrap_or("");
    if token.is_empty() {
        return Err(AppError::Validation("无效的预览 URL".into()));
    }
    if let Ok(mut map) = tokens().lock() {
        map.remove(token);
    }
    Ok(())
}

/// 预览用 MIME 映射（媒体协议与原始字节预览共用，避免两套扩展名表）。
pub(crate) fn mime_for_path(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "avi" => "video/x-msvideo",
        "mkv" => "video/x-matroska",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "m4a" => "audio/mp4",
        "aac" => "audio/aac",
        "ogg" | "oga" => "audio/ogg",
        "flac" => "audio/flac",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "tif" | "tiff" => "image/tiff",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}

fn parse_range(value: &str, size: u64) -> Option<(u64, u64)> {
    let value = value.trim().strip_prefix("bytes=")?;
    let first = value.split(',').next()?.trim();
    let (start, end) = first.split_once('-')?;
    if start.is_empty() {
        let suffix = end.parse::<u64>().ok()?;
        if suffix == 0 {
            return None;
        }
        let start = size.saturating_sub(suffix);
        return Some((start, size.saturating_sub(1)));
    }
    let start = start.parse::<u64>().ok()?;
    if start >= size {
        return None;
    }
    let end = if end.is_empty() {
        size.saturating_sub(1)
    } else {
        end.parse::<u64>().ok()?.min(size.saturating_sub(1))
    };
    if end < start {
        None
    } else {
        Some((start, end))
    }
}

fn build_status(status: StatusCode, mime: &'static str) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, HeaderValue::from_static(mime))
        .body(Vec::new())
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

/// Tauri 自定义协议 handler。仅响应已注册 token，并支持视频/音频 Range。
pub fn handle_preview_uri(request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let token_key = request
        .uri()
        .path()
        .trim_start_matches('/')
        .split('/')
        .next()
        .unwrap_or("");
    let path = {
        let Ok(mut map) = tokens().lock() else {
            return build_status(StatusCode::INTERNAL_SERVER_ERROR, "text/plain");
        };
        prune(&mut map);
        let Some(entry) = map.get(token_key) else {
            return build_status(StatusCode::NOT_FOUND, "text/plain");
        };
        if entry.expires <= Instant::now() {
            map.remove(token_key);
            return build_status(StatusCode::GONE, "text/plain");
        }
        entry.path.clone()
    };
    let Ok(meta) = std::fs::metadata(&path) else {
        return build_status(StatusCode::NOT_FOUND, "text/plain");
    };
    if !meta.is_file() {
        return build_status(StatusCode::FORBIDDEN, "text/plain");
    }
    let size = meta.len();
    if size == 0 {
        return build_status(StatusCode::NO_CONTENT, mime_for_path(&path));
    }
    let mime = mime_for_path(&path);
    let range = request
        .headers()
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| parse_range(value, size));
    let (start, end, status) = match range {
        Some((start, end)) => {
            let capped_end = end.min(start + MAX_RANGE_BYTES - 1);
            (start, capped_end, StatusCode::PARTIAL_CONTENT)
        }
        None if size > MAX_RANGE_BYTES => {
            // 没有 Range 头的大文件也只返回首块，但必须声明 206/Content-Range，
            // 否则播放器会把 8 MiB 当成完整文件，无法继续 seek。
            (0, MAX_RANGE_BYTES - 1, StatusCode::PARTIAL_CONTENT)
        }
        None => (0, size.saturating_sub(1), StatusCode::OK),
    };
    let length = end.saturating_sub(start) + 1;
    let mut file = match std::fs::File::open(&path) {
        Ok(file) => file,
        Err(_) => return build_status(StatusCode::NOT_FOUND, "text/plain"),
    };
    if file.seek(SeekFrom::Start(start)).is_err() {
        return build_status(StatusCode::INTERNAL_SERVER_ERROR, "text/plain");
    }
    let mut body = vec![0u8; length.min(MAX_RANGE_BYTES) as usize];
    let mut read_total = 0usize;
    while read_total < body.len() {
        match file.read(&mut body[read_total..]) {
            Ok(0) => break,
            Ok(n) => read_total += n,
            Err(_) => return build_status(StatusCode::INTERNAL_SERVER_ERROR, "text/plain"),
        }
    }
    body.truncate(read_total);
    let mut builder = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, HeaderValue::from_static(mime))
        .header(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"))
        .header(header::CONTENT_LENGTH, read_total.to_string())
        .header(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    if status == StatusCode::PARTIAL_CONTENT {
        builder = builder.header(
            header::CONTENT_RANGE,
            format!(
                "bytes {start}-{}/{size}",
                start + read_total.saturating_sub(1) as u64
            ),
        );
    }
    builder
        .body(body)
        .unwrap_or_else(|_| build_status(StatusCode::INTERNAL_SERVER_ERROR, "text/plain"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_range_limits_and_suffixes() {
        assert_eq!(parse_range("bytes=0-1023", 10_000), Some((0, 1023)));
        assert_eq!(parse_range("bytes=500-", 10_000), Some((500, 9999)));
        assert_eq!(parse_range("bytes=-500", 10_000), Some((9500, 9999)));
        assert_eq!(parse_range("bytes=10000-", 10_000), None);
        assert_eq!(parse_range("items=0-1", 10_000), None);
    }

    #[test]
    fn release_media_url_invalidates_token() {
        let token = "abc123";
        let url = media_url(token);
        let path = std::env::temp_dir().join(format!("taskdock-preview-{token}.txt"));
        std::fs::write(&path, b"x").unwrap();
        let _ = register_media_url(&path);
        // 直接插入与 register 不同的 token，验证 release 只按 URL 中的 token 删除。
        tokens().lock().unwrap().insert(
            token.to_string(),
            PreviewToken {
                path: path.clone(),
                expires: Instant::now() + TOKEN_TTL,
            },
        );
        release_media_url(&url).unwrap();
        assert!(!tokens().lock().unwrap().contains_key(token));
        let _ = std::fs::remove_file(path);
    }
}
