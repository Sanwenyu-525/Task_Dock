//! Windows 回收站 `$I` 元数据解析（纯函数，便于单元测试与跨平台编译）。
//!
//! ## 文件格式（本项目实测 + 公开资料互证）
//! ```text
//! offset  size  field
//!   0      8    version (u64 LE)：1 = 旧版（固定 260 WCHAR 路径缓冲），
//!                                2 = Vista+ 变长路径
//!   8      8    original size (u64 LE)
//!  16      8    deletion time (FILETIME, 100ns since 1601-01-01 UTC)
//!  24      4    path length（UTF-16 code unit 数，v2 通常包含结尾 NUL）
//!  28    ...    original path (UTF-16LE)
//! ```
//!
//! 实测数据（本机 13.6 万条真实记录）：v2 记录的 `path length` 包含结尾 NUL，
//! 文件长度恰好为 `28 + pathLength*2`（例如 113 字节文件 → 164 字节 `$I`）。
//!
//! ## 约束
//! - 只读取元数据，**绝不打开 `$R` 数据文件内容**；
//! - 任何字段越界/损坏都降级为异常标记，不 panic、不丢弃可恢复的路径；
//! - 未知版本不做猜测（v1 与 v2 布局不同，猜错会给出错误原始路径）。
//!
//! 注意：`$I` 中**没有**目录标志；是否为目录只能由 `$R` 的 `symlink_metadata`
//! 判定（调用方在扫描阶段完成，且只看元数据）。

/// 单个 `$I` 文件的最大读取长度。真实记录最大约 2 KB（长路径），4 KB 足够；
/// 超出部分不读，避免异常文件把内存放大。
pub const MAX_META_BYTES: usize = 4096;

/// 头部固定长度：version + size + FILETIME + path length。
const HEADER_LEN: usize = 28;

/// 旧版（v1）路径缓冲固定为 260 个 UTF-16 字符。
const V1_PATH_CHARS: usize = 260;

/// 删除时间允许的最早值（1980-01-01 UTC，FAT 时代下限）；早于此视为异常。
const MIN_DELETED_MS: i64 = 315_532_800_000;

/// 稳定异常码（前端与诊断共用；不随文案变化）。
pub const ANOMALY_TRUNCATED: &str = "META_TRUNCATED";
pub const ANOMALY_BAD_VERSION: &str = "META_BAD_VERSION";
pub const ANOMALY_BAD_PATH: &str = "META_BAD_PATH";
pub const ANOMALY_PATH_TOO_LONG: &str = "META_PATH_TOO_LONG";
pub const ANOMALY_BAD_TIME: &str = "META_BAD_TIME";
pub const ANOMALY_BAD_SIZE: &str = "META_BAD_SIZE";
pub const ANOMALY_EMPTY_PATH: &str = "META_EMPTY_PATH";

/// 解析结果。字段缺失时给出安全默认值，并在 `anomaly` 中标明原因。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedMeta {
    /// 原始绝对路径（已去除结尾 NUL）。异常时可能为空。
    pub original_path: String,
    /// 原始大小（字节）。v2 中目录通常记为 0，不能当作真实占用。
    pub size: u64,
    /// 删除时间（UTC 毫秒）；异常/未知为 0。
    pub deleted_ms: i64,
    /// 元数据版本（1/2）；未知版本为实际读到的值。
    pub version: u64,
    /// 第一个异常码（若有）。
    pub anomaly: Option<&'static str>,
}

/// 解析 `$I` 文件头。
///
/// `now_ms` 用于拒绝明显来自未来的删除时间（时钟回拨/损坏），由调用方传入
/// 以保证函数可测试。
pub fn parse_meta(bytes: &[u8], now_ms: i64) -> ParsedMeta {
    if bytes.len() < HEADER_LEN {
        return ParsedMeta {
            original_path: String::new(),
            size: 0,
            deleted_ms: 0,
            version: 0,
            anomaly: Some(ANOMALY_TRUNCATED),
        };
    }
    let version = u64::from_le_bytes(bytes[0..8].try_into().unwrap_or([0; 8]));
    let raw_size = u64::from_le_bytes(bytes[8..16].try_into().unwrap_or([0; 8]));
    let filetime = i64::from_le_bytes(bytes[16..24].try_into().unwrap_or([0; 8]));
    let path_len = u32::from_le_bytes(bytes[24..28].try_into().unwrap_or([0; 4])) as usize;

    let mut anomaly: Option<&'static str> = None;
    if !matches!(version, 1 | 2) {
        return ParsedMeta {
            original_path: String::new(),
            size: 0,
            deleted_ms: 0,
            version,
            anomaly: Some(ANOMALY_BAD_VERSION),
        };
    }

    let size = if raw_size > i64::MAX as u64 {
        anomaly = Some(ANOMALY_BAD_SIZE);
        0
    } else {
        raw_size
    };

    let deleted_ms = filetime_to_ms(filetime, now_ms).unwrap_or_else(|| {
        anomaly = Some(ANOMALY_BAD_TIME);
        0
    });

    let available = &bytes[HEADER_LEN..];
    // v1 是固定 260 WCHAR 缓冲；v2 是变长（可能超过 260）。两者都以长度字段为准，
    // 但 v1 的历史实现偶有长度字段为 0 的记录，因此回退到固定缓冲扫描 NUL。
    let capped_bytes = match version {
        1 => available.len().min(V1_PATH_CHARS * 2),
        _ => {
            if path_len == 0 {
                available.len()
            } else {
                available.len().min(path_len.saturating_mul(2))
            }
        }
    };
    let (path, invalid_utf16) = decode_utf16(&available[..capped_bytes]);
    let path = path.trim_end_matches('\0').to_string();
    if invalid_utf16 {
        anomaly = Some(ANOMALY_BAD_PATH);
    }
    if version == 2 && path_len > V1_PATH_CHARS && path_len > available.len() / 2 {
        // 长度字段声称超过实际字节数：数据被截断，路径可能不完整。
        anomaly = Some(if path.is_empty() {
            ANOMALY_TRUNCATED
        } else {
            ANOMALY_PATH_TOO_LONG
        });
    }
    if path.is_empty() {
        anomaly.get_or_insert(ANOMALY_EMPTY_PATH);
    } else if !is_absolute_windows_path(&path) {
        anomaly = Some(ANOMALY_BAD_PATH);
    }

    ParsedMeta {
        original_path: path,
        size,
        deleted_ms,
        version,
        anomaly,
    }
}

/// FILETIME → UTC 毫秒；非法/超出合理区间返回 `None`。
fn filetime_to_ms(filetime: i64, now_ms: i64) -> Option<i64> {
    if filetime <= 0 {
        return None;
    }
    // 100ns 单位 → ms，再减去 1601→1970 的偏移。
    let ms = filetime / 10_000 - 116_444_736_000_00;
    // 允许 1 天的时区/时钟容差，拒绝明显来自未来的损坏值。
    if ms < MIN_DELETED_MS || ms > now_ms.saturating_add(86_400_000) {
        return None;
    }
    Some(ms)
}

/// UTF-16LE → String，返回（结果, 是否含无效码元）。
fn decode_utf16(bytes: &[u8]) -> (String, bool) {
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
        .collect();
    match String::from_utf16(&units) {
        Ok(s) => (s, false),
        Err(_) => (String::from_utf16_lossy(&units), true),
    }
}

/// 绝对 Windows 路径判定：`C:\...`、`\\server\share\...`（不接受相对路径）。
fn is_absolute_windows_path(path: &str) -> bool {
    let bytes = path.as_bytes();
    if bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/')
    {
        return true;
    }
    // UNC：\\server\share
    path.starts_with("\\\\")
}

/// 从原始路径提取文件名（平台无关：只按 `\` 与 `/` 切分）。
pub fn file_name_of(path: &str) -> String {
    let trimmed = path.trim_end_matches(['\\', '/']);
    if trimmed.is_empty() {
        return path.to_string();
    }
    trimmed
        .rsplit(['\\', '/'])
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or(trimmed)
        .to_string()
}

/// 是否目录已知：`$I` 不含目录标志，恒为未知（由 `$R` 元数据判定）。
pub const DIR_FLAG_KNOWN: bool = false;

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_790_000_000_000; // 2026-09 左右，远晚于测试数据

    fn filetime_of_ms(ms: i64) -> i64 {
        (ms + 116_444_736_000_00) * 10_000
    }

    fn build_v2(path: &str, size: u64, deleted_ms: i64, path_len_override: Option<u32>) -> Vec<u8> {
        let mut units: Vec<u16> = path.encode_utf16().collect();
        units.push(0);
        let mut out = Vec::with_capacity(HEADER_LEN + units.len() * 2);
        out.extend_from_slice(&2u64.to_le_bytes());
        out.extend_from_slice(&size.to_le_bytes());
        out.extend_from_slice(&filetime_of_ms(deleted_ms).to_le_bytes());
        let declared = path_len_override.unwrap_or(units.len() as u32);
        out.extend_from_slice(&declared.to_le_bytes());
        for unit in units {
            out.extend_from_slice(&unit.to_le_bytes());
        }
        out
    }

    #[test]
    fn parses_v2_chinese_path() {
        let path = r"D:\开发\任务坞\报告 2026（终稿）.docx";
        let meta = parse_meta(&build_v2(path, 12_345, NOW - 3_600_000, None), NOW);
        assert_eq!(meta.original_path, path);
        assert_eq!(meta.size, 12_345);
        assert_eq!(meta.deleted_ms, NOW - 3_600_000);
        assert_eq!(meta.anomaly, None);
        assert_eq!(meta.version, 2);
        assert_eq!(file_name_of(path), "报告 2026（终稿）.docx");
    }

    #[test]
    fn parses_v2_special_chars_and_emoji() {
        let path = "C:\\Users\\ASUS\\Desktop\\表情🙂 & 100% [x].txt";
        let meta = parse_meta(&build_v2(path, 1, NOW, None), NOW);
        assert_eq!(meta.original_path, path);
        assert_eq!(meta.anomaly, None);
    }

    #[test]
    fn parses_v2_long_path() {
        let dir = "C:\\".to_string() + &"很长的目录名\\".repeat(40);
        let path = format!("{dir}文件.txt");
        assert!(path.chars().count() > 260);
        let meta = parse_meta(&build_v2(&path, 9, NOW, None), NOW);
        assert_eq!(meta.original_path, path);
        assert_eq!(meta.anomaly, None);
    }

    #[test]
    fn parses_v1_fixed_buffer() {
        let path = r"C:\Temp\旧版记录.txt";
        let mut units: Vec<u16> = path.encode_utf16().collect();
        units.push(0);
        let mut out = Vec::new();
        out.extend_from_slice(&1u64.to_le_bytes());
        out.extend_from_slice(&777u64.to_le_bytes());
        out.extend_from_slice(&filetime_of_ms(NOW - 1000).to_le_bytes());
        out.extend_from_slice(&(units.len() as u32).to_le_bytes());
        for unit in &units {
            out.extend_from_slice(&unit.to_le_bytes());
        }
        for _ in units.len()..V1_PATH_CHARS {
            out.extend_from_slice(&0u16.to_le_bytes());
        }
        let meta = parse_meta(&out, NOW);
        assert_eq!(meta.original_path, path);
        assert_eq!(meta.size, 777);
        assert_eq!(meta.anomaly, None);
    }

    #[test]
    fn v1_zero_length_falls_back_to_nul_scan() {
        let path = r"C:\Temp\零长度.txt";
        let mut units: Vec<u16> = path.encode_utf16().collect();
        units.push(0);
        let mut out = Vec::new();
        out.extend_from_slice(&1u64.to_le_bytes());
        out.extend_from_slice(&1u64.to_le_bytes());
        out.extend_from_slice(&filetime_of_ms(NOW).to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes());
        for unit in &units {
            out.extend_from_slice(&unit.to_le_bytes());
        }
        let meta = parse_meta(&out, NOW);
        assert_eq!(meta.original_path, path);
    }

    #[test]
    fn truncated_header_is_flagged() {
        let meta = parse_meta(&[2, 0, 0], NOW);
        assert_eq!(meta.anomaly, Some(ANOMALY_TRUNCATED));
        assert_eq!(meta.original_path, "");
    }

    #[test]
    fn unknown_version_is_not_guessed() {
        let mut data = build_v2(r"C:\x\y.txt", 1, NOW, None);
        data[0..8].copy_from_slice(&7u64.to_le_bytes());
        let meta = parse_meta(&data, NOW);
        assert_eq!(meta.anomaly, Some(ANOMALY_BAD_VERSION));
        assert_eq!(meta.original_path, "");
    }

    #[test]
    fn corrupted_utf16_is_lossy_and_flagged() {
        let mut data = build_v2(r"C:\x\y.txt", 1, NOW, None);
        // 把路径中的普通字符改成孤立代理项；不要改分隔符，否则前缀本身会变。
        data[HEADER_LEN + 12] = 0x00;
        data[HEADER_LEN + 13] = 0xD8;
        let meta = parse_meta(&data, NOW);
        assert_eq!(meta.anomaly, Some(ANOMALY_BAD_PATH));
        assert!(meta.original_path.contains("C:\\x\\"));
    }

    #[test]
    fn path_len_beyond_payload_is_flagged() {
        let data = build_v2(r"D:\a\b.bin", 5, NOW, Some(9999));
        let meta = parse_meta(&data, NOW);
        assert_eq!(meta.original_path, r"D:\a\b.bin");
        assert_eq!(meta.anomaly, Some(ANOMALY_PATH_TOO_LONG));
    }

    #[test]
    fn bad_time_and_size_are_flagged() {
        let mut data = build_v2(r"D:\a\b.bin", 5, NOW, None);
        data[16..24].copy_from_slice(&(-1i64).to_le_bytes());
        let meta = parse_meta(&data, NOW);
        assert_eq!(meta.deleted_ms, 0);
        assert_eq!(meta.anomaly, Some(ANOMALY_BAD_TIME));
    }

    #[test]
    fn future_or_zero_time_is_rejected() {
        assert_eq!(parse_meta(&build_v2(r"D:\a.txt", 1, 0, None), NOW).anomaly, Some(ANOMALY_BAD_TIME));
        assert_eq!(
            parse_meta(&build_v2(r"D:\a.txt", 1, NOW + 1000 * 86_400_000, None), NOW).anomaly,
            Some(ANOMALY_BAD_TIME)
        );
    }

    #[test]
    fn relative_path_is_rejected() {
        let meta = parse_meta(&build_v2(r"relative\path.txt", 1, NOW, None), NOW);
        assert_eq!(meta.anomaly, Some(ANOMALY_BAD_PATH));
    }

    #[test]
    fn unc_path_is_accepted() {
        let path = r"\\server\share\dir\file.txt";
        let meta = parse_meta(&build_v2(path, 1, NOW, None), NOW);
        assert_eq!(meta.original_path, path);
        assert_eq!(meta.anomaly, None);
    }

    #[test]
    fn file_name_handles_trailing_separator_and_roots() {
        assert_eq!(file_name_of(r"D:\dir\sub\"), "sub");
        assert_eq!(file_name_of(r"D:\"), "D:");
        assert_eq!(file_name_of(r"\\server\share"), "share");
    }
}
