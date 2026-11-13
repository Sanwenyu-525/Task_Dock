//! 外部来源文件名的**强制清洗**。
//!
//! 虚拟文件名来自 OLE 描述符（由对方应用填写），可能是任意字符串：
//! 绝对路径、`..\..`、保留设备名、控制字符、超长名、尾部点号。
//! 这里输出的是「只能当文件名用」的组件，永远不会被拼进路径之前不经验证。
//!
//! 规则（每条都有单测）：
//! 1. 只取最后一段（`\` 与 `/` 都当分隔符），其余路径信息一律丢弃；
//!    `..` / `.` / 空 → 用兜底名；
//! 2. 去掉控制字符与 Windows 非法字符 `< > : " | ? *`；
//! 3. 折叠连续空白、去首尾空白与尾部点号（Windows 会静默去掉尾部点/空格）；
//! 4. 命中保留设备名（CON/PRN/AUX/NUL/COM1-9/LPT1-9，含带扩展名形式）时加前缀；
//! 5. 按字符截断到 120（给「(1)」等重名后缀与扩展名留余量），扩展名尽量保留。

/// 文件名最大字符数（不是字节数）。
pub const MAX_NAME_CHARS: usize = 120;

const RESERVED: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

fn is_reserved(stem: &str) -> bool {
    let upper = stem.trim().to_ascii_uppercase();
    RESERVED.iter().any(|r| *r == upper)
}

/// 是否含路径分隔或上跳语义（判定「这条来源名根本不能当路径用」）。
pub fn has_traversal(raw: &str) -> bool {
    raw.contains("..") || raw.contains('\\') || raw.contains('/') || raw.contains(':')
}

/// 清洗为安全文件名。永不返回空串。
pub fn sanitize_file_name(raw: &str, fallback: &str) -> String {
    // 1) 只取最后一段：先按两种分隔符切开，取最后一个非空段。
    let last = raw
        .split(['\\', '/'])
        .filter(|s| !s.trim().is_empty())
        .next_back()
        .unwrap_or("");
    // 2) 去掉非法与控制字符。
    let cleaned: String = last
        .chars()
        .filter(|c| {
            !c.is_control() && !matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*')
        })
        .collect();
    // 3) 折叠空白、去首尾空白与尾部点号。
    let mut name = cleaned
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    while name.ends_with('.') || name.ends_with(' ') {
        name.pop();
    }
    if name.is_empty() || name == "." || name == ".." {
        name = sanitize_fallback(fallback);
    }
    // 4) 保留设备名：加下划线前缀，保持可读又不触发系统语义。
    let stem = name.split('.').next().unwrap_or("");
    if is_reserved(stem) {
        name = format!("_{name}");
    }
    // 5) 长度：保留扩展名，截断主名。
    truncate_keep_ext(&name, MAX_NAME_CHARS)
}

fn sanitize_fallback(fallback: &str) -> String {
    let cleaned: String = fallback
        .chars()
        .filter(|c| {
            !c.is_control() && !matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*' | '\\' | '/')
        })
        .collect();
    let trimmed = cleaned.trim().trim_end_matches('.').trim();
    if trimmed.is_empty() {
        "未命名".to_string()
    } else {
        trimmed.to_string()
    }
}

fn truncate_keep_ext(name: &str, max_chars: usize) -> String {
    if name.chars().count() <= max_chars {
        return name.to_string();
    }
    let path = std::path::Path::new(name);
    let ext = path
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .filter(|e| e.chars().count() <= 16)
        .unwrap_or_default();
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| name.to_string());
    let budget = max_chars.saturating_sub(ext.chars().count());
    let truncated: String = stem.chars().take(budget).collect();
    let truncated = truncated.trim_end_matches('.').to_string();
    format!("{truncated}{ext}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 路径分隔与上跳只保留文件名() {
        assert_eq!(sanitize_file_name(r"C:\Users\a\报表.pdf", "x.pdf"), "报表.pdf");
        assert_eq!(sanitize_file_name("../../etc/passwd", "x"), "passwd");
        assert_eq!(sanitize_file_name(r"..\..\evil.exe", "x"), "evil.exe");
    }

    #[test]
    fn 纯上跳或空名走兜底() {
        assert_eq!(sanitize_file_name("..", "回退.bin"), "回退.bin");
        assert_eq!(sanitize_file_name("   ", "回退.bin"), "回退.bin");
        assert_eq!(sanitize_file_name("", ""), "未命名");
    }

    #[test]
    fn 非法与控制字符被剔除() {
        assert_eq!(sanitize_file_name("a<b>c:d\"e|f?g*h.txt", "x"), "abcdefgh.txt");
        assert_eq!(sanitize_file_name("bad\u{0007}name.txt", "x"), "badname.txt");
    }

    #[test]
    fn 折叠空白并去掉尾部点号() {
        assert_eq!(sanitize_file_name("  a   b  .txt.  ", "x"), "a b .txt");
        assert_eq!(sanitize_file_name("名字...", "x"), "名字");
    }

    #[test]
    fn 保留设备名加前缀() {
        assert_eq!(sanitize_file_name("CON", "x"), "_CON");
        assert_eq!(sanitize_file_name("nul.txt", "x"), "_nul.txt");
        assert_eq!(sanitize_file_name("com1", "x"), "_com1");
        // 不是保留名的近似词不动
        assert_eq!(sanitize_file_name("console.txt", "x"), "console.txt");
    }

    #[test]
    fn 超长名截断且保留扩展名() {
        let raw = format!("{}.png", "很".repeat(300));
        let got = sanitize_file_name(&raw, "x");
        assert!(got.chars().count() <= MAX_NAME_CHARS, "{}", got.chars().count());
        assert!(got.ends_with(".png"));
    }

    #[test]
    fn 遍历判定覆盖两种分隔符与盘符() {
        assert!(has_traversal("..\\a"));
        assert!(has_traversal("C:evil"));
        assert!(!has_traversal("普通.txt"));
    }
}
