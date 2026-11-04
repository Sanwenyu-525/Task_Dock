//! 剪贴板纯逻辑：类型判定、预览、内容哈希、敏感过滤、HTML 消毒与自动分组决策。
//!
//! 本模块不触碰 SQLite / Win32 / 文件系统，便于单元测试。

use std::sync::OnceLock;

use chrono::{DateTime, Duration, Local, Utc};
use regex::Regex;
use sha2::{Digest, Sha256};

use super::{
    CapturedContent, ClipboardItem, KIND_FILES, KIND_HTML, KIND_IMAGE, KIND_TEXT, KIND_URL,
    MAX_AUTO_GROUP_ITEMS,
};

/// 自动分组动作（由 store 解析具体的开放分组）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GroupAction {
    None,
    Append,
    Create,
}

/// 内容类型判定（顺序即优先级）：
/// 文件列表 > 图片 > 纯 URL > 富文本 HTML > 纯文本。
pub fn classify(text: &str, html: &str, has_image: bool, files: &[String]) -> Option<&'static str> {
    if !files.is_empty() {
        return Some(KIND_FILES);
    }
    if has_image {
        return Some(KIND_IMAGE);
    }
    let t = text.trim();
    if !t.is_empty() && is_url_like(t) {
        return Some(KIND_URL);
    }
    if !html.trim().is_empty() && looks_like_html(html) {
        return Some(KIND_HTML);
    }
    if !t.is_empty() {
        return Some(KIND_TEXT);
    }
    None
}

pub fn is_url_like(text: &str) -> bool {
    if text.chars().any(char::is_whitespace) || text.len() > 4096 {
        return false;
    }
    let lower = text.to_ascii_lowercase();
    (lower.starts_with("http://") || lower.starts_with("https://"))
        && text.len() > "https://".len()
        && !text.contains(['"', '\'', '<', '>'])
}

fn looks_like_html(html: &str) -> bool {
    html.contains('<') && html.contains('>')
}

/// 生成列表预览（不返回完整正文）。
pub fn make_preview(
    kind: &str,
    text: &str,
    strip_from_html: &str,
    files: &[String],
    width: Option<u32>,
    height: Option<u32>,
) -> String {
    match kind {
        KIND_IMAGE => match (width, height) {
            (Some(w), Some(h)) => format!("图片 {w}×{h}"),
            _ => "图片".into(),
        },
        KIND_FILES => {
            let names: Vec<String> = files
                .iter()
                .take(2)
                .map(|p| {
                    std::path::Path::new(p)
                        .file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_else(|| p.clone())
                })
                .collect();
            if files.len() > 2 {
                format!("{} 等 {} 个文件", names.join("、"), files.len())
            } else {
                names.join("、")
            }
        }
        _ => {
            let source = if text.trim().is_empty() {
                strip_tags(strip_from_html)
            } else {
                text.to_string()
            };
            truncate_chars(&collapse_ws(&source), 220)
        }
    }
}

pub fn collapse_ws(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    // 省略号计入上限：截断结果总长不超过 max（标题承诺 ≤30 字符）
    let mut out: String = s.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

fn strip_tags(html: &str) -> String {
    static TAG: OnceLock<Regex> = OnceLock::new();
    let re = TAG.get_or_init(|| Regex::new(r"(?is)<[^>]+>").expect("标签正则"));
    re.replace_all(html, " ").into_owned()
}

/// HTML → 纯文本回退（粘贴目标不接收 HTML 时使用）。
pub fn html_to_text(html: &str) -> String {
    let text = strip_tags(html);
    let text = text
        .replace("&nbsp;", " ")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&amp;", "&");
    collapse_ws(&text)
}

/// 去重哈希：同一类型 + 正文/HTML/文件列表/图片字节 只保留一条。
pub fn content_hash(
    kind: &str,
    text: &str,
    html: &str,
    files: &[String],
    image_png: Option<&[u8]>,
) -> String {
    let mut h = Sha256::new();
    h.update(kind.as_bytes());
    h.update([0]);
    h.update(text.as_bytes());
    h.update([0]);
    h.update(html.as_bytes());
    h.update([0]);
    for f in files {
        h.update(f.as_bytes());
        h.update([0]);
    }
    if let Some(png) = image_png {
        h.update(png);
    }
    let digest = h.finalize();
    let mut out = String::with_capacity(digest.len() * 2);
    for b in digest {
        use std::fmt::Write as _;
        let _ = write!(out, "{b:02x}");
    }
    out
}

/// 去重哈希。
///
/// HTML 参与哈希前先取「净化视图」：采集侧已改为保留原文（复制要还原原始格式），
/// 但历史库中存的是净化后的 HTML。若直接拿原文哈希，同一条富文本在升级后会被判成
/// 新内容而重复入库。以净化视图作为规范化形式，保证升级前后去重键一致。
pub fn hash_of(payload: &CapturedContent) -> String {
    let canonical_html = sanitize_html(&payload.html);
    content_hash(
        &payload.kind,
        &payload.text,
        &canonical_html,
        &payload.file_paths,
        payload.image.as_ref().map(|i| i.png.as_slice()),
    )
}

/// 高置信敏感内容识别（PEM 私钥 / AWS / GitHub / Slack 令牌）。
/// 明确边界：不可能识别全部密码与令牌，设置中可关闭；默认跳过不记录。
pub fn sensitive_reason(text: &str) -> Option<&'static str> {
    if text.is_empty() {
        return None;
    }
    static PEM: OnceLock<Regex> = OnceLock::new();
    static AWS: OnceLock<Regex> = OnceLock::new();
    static GH: OnceLock<Regex> = OnceLock::new();
    static SLACK: OnceLock<Regex> = OnceLock::new();

    let pem = PEM.get_or_init(|| {
        Regex::new(r"-----BEGIN [A-Z0-9 ]{0,24}PRIVATE KEY-----").expect("PEM 正则")
    });
    if pem.is_match(text) {
        return Some("PEM 私钥");
    }
    let aws = AWS.get_or_init(|| Regex::new(r"\bAKIA[0-9A-Z]{16}\b").expect("AWS 正则"));
    if aws.is_match(text) {
        return Some("AWS 访问密钥");
    }
    let gh =
        GH.get_or_init(|| Regex::new(r"\bgh[pousr]_[A-Za-z0-9]{36}\b").expect("GitHub 令牌正则"));
    if gh.is_match(text) {
        return Some("GitHub 令牌");
    }
    let slack = SLACK
        .get_or_init(|| Regex::new(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b").expect("Slack 令牌正则"));
    if slack.is_match(text) {
        return Some("Slack 令牌");
    }
    None
}

/// 来源未知时的保守敏感模式：无法确认是否来自密码管理器，
/// 命中「凭据赋值 / 认证头」这类明确结构就跳过。仍不保证 100% 识别。
pub fn conservative_sensitive_reason(text: &str) -> Option<&'static str> {
    if text.is_empty() {
        return None;
    }
    static ASSIGN: OnceLock<Regex> = OnceLock::new();
    static AUTH: OnceLock<Regex> = OnceLock::new();
    static JSON: OnceLock<Regex> = OnceLock::new();
    let assign = ASSIGN.get_or_init(|| {
        Regex::new(
            r"(?i)\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret)\b\s*[:=]\s*\S{4,}",
        )
        .expect("凭据赋值正则")
    });
    if assign.is_match(text) {
        return Some("凭据赋值");
    }
    let auth = AUTH.get_or_init(|| {
        Regex::new(r"(?i)\bauthorization\s*:\s*(bearer|basic)\s+\S{8,}").expect("认证头正则")
    });
    if auth.is_match(text) {
        return Some("认证头");
    }
    let json = JSON.get_or_init(|| {
        Regex::new(r#"(?i)"(password|passwd|secret|token|api[_-]?key)"\s*:\s*"[^"]{4,}""#)
            .expect("JSON 凭据正则")
    });
    if json.is_match(text) {
        return Some("JSON 凭据字段");
    }
    None
}

/// 清理来自外部的 HTML 片段：移除脚本/样式/框架等主动内容与事件属性。
/// 粘贴目标大多不执行脚本，但剪贴板 HTML 属于不可信输入，统一消毒后再保存/复用。
pub fn sanitize_html(html: &str) -> String {
    static BLOCKS: OnceLock<Vec<Regex>> = OnceLock::new();
    let blocks = BLOCKS.get_or_init(|| {
        vec![
            Regex::new(r"(?is)<script\b[^>]*>.*?</script\s*>").expect("script"),
            Regex::new(r"(?is)<style\b[^>]*>.*?</style\s*>").expect("style"),
            Regex::new(r"(?is)<iframe\b[^>]*>.*?</iframe\s*>").expect("iframe"),
            Regex::new(r"(?is)<object\b[^>]*>.*?</object\s*>").expect("object"),
            Regex::new(r"(?is)<(embed|link|meta|form|input|button|textarea|select)\b[^>]*>")
                .expect("单标签"),
        ]
    });
    let mut out = html.to_string();
    for re in blocks {
        out = re.replace_all(&out, "").into_owned();
    }
    static EVENTS: OnceLock<Regex> = OnceLock::new();
    let events = EVENTS.get_or_init(|| {
        Regex::new(r#"(?i)\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)"#).expect("事件属性")
    });
    out = events.replace_all(&out, "").into_owned();
    static JS: OnceLock<Regex> = OnceLock::new();
    let js = JS.get_or_init(|| Regex::new(r"(?i)javascript:").expect("javascript 协议"));
    js.replace_all(&out, "#").into_owned()
}

/// 生成 Windows CF_HTML 载荷（含必需头部与字节偏移）。
pub fn cf_html(fragment: &str) -> String {
    const EMPTY_HEADER: &str = "Version:0.9\r\nStartHTML:0000000000\r\nEndHTML:0000000000\r\nStartFragment:0000000000\r\nEndFragment:0000000000\r\n";
    let prefix = "<html><body><!--StartFragment-->";
    let suffix = "<!--EndFragment--></body></html>";
    let start_html = EMPTY_HEADER.len();
    let start_fragment = start_html + prefix.len();
    let end_fragment = start_fragment + fragment.len();
    let end_html = end_fragment + suffix.len();
    format!(
        "Version:0.9\r\nStartHTML:{start_html:010}\r\nEndHTML:{end_html:010}\r\nStartFragment:{start_fragment:010}\r\nEndFragment:{end_fragment:010}\r\n{prefix}{fragment}{suffix}"
    )
}

fn escape_html(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

// ── 自动标题 ────────────────────────────────────────────────

/// 自动标题长度上限（按字符数，中文一字算一个字符）。
pub const MAX_AUTO_TITLE_CHARS: usize = 30;

/// 根据复制内容生成本地化轻量标题：纯规则，不调用外部 AI / OCR / 网络。
///
/// 规则（按类型）：
/// - 文本：代码声明行 > Markdown 标题行 > 首个非空行（代表性短句）；
/// - URL：域名 + 首段可辨识路径；
/// - HTML：`<h1>` / `<title>` 文本 > 剥离标签后的文本规则；
/// - 图片：截图尺寸描述，**不推断图片内容**；
/// - 文件列表：首个文件名 + 数量。
/// 没有可靠标题时返回安全类型描述；结果总是 ≤ `MAX_AUTO_TITLE_CHARS` 字符。
pub fn make_title(
    kind: &str,
    text: &str,
    html: &str,
    files: &[String],
    width: Option<u32>,
    height: Option<u32>,
) -> String {
    match kind {
        KIND_IMAGE => match (width, height) {
            (Some(w), Some(h)) => truncate_chars(&format!("截图 {w}×{h}"), MAX_AUTO_TITLE_CHARS),
            _ => "图片".into(),
        },
        KIND_FILES => {
            let first = files
                .first()
                .map(|p| base_name(p))
                .unwrap_or_else(|| "文件".into());
            if files.len() > 1 {
                truncate_chars(
                    &format!("{first} 等 {} 个文件", files.len()),
                    MAX_AUTO_TITLE_CHARS,
                )
            } else {
                truncate_chars(&first, MAX_AUTO_TITLE_CHARS)
            }
        }
        KIND_URL => title_from_url(text),
        KIND_HTML => html_heading_title(html)
            .unwrap_or_else(|| title_from_text(&html_to_text(html), "网页内容")),
        _ => title_from_text(text, "文本"),
    }
}

fn base_name(p: &str) -> String {
    std::path::Path::new(p)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| p.to_string())
}

/// URL 标题：域名 + 首个非空路径段（如 `example.com/a`）。
fn title_from_url(text: &str) -> String {
    let t = text.trim();
    let rest = t.split_once("://").map(|(_, r)| r).unwrap_or(t);
    let (host, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, ""),
    };
    let host = host.rsplit('@').next().unwrap_or(host);
    let mut title = host.to_string();
    if let Some(first) = path
        .split(['?', '#'])
        .next()
        .unwrap_or("")
        .split('/')
        .find(|s| !s.is_empty())
    {
        title.push('/');
        title.push_str(first);
    }
    let title = truncate_chars(&title, MAX_AUTO_TITLE_CHARS);
    if title.is_empty() {
        "链接".into()
    } else {
        title
    }
}

/// 文本标题：代码声明行 > Markdown 标题行 > 首个非空行。
fn title_from_text(text: &str, fallback: &str) -> String {
    static CODE_DECL: OnceLock<Regex> = OnceLock::new();
    let code = CODE_DECL.get_or_init(|| {
        Regex::new(
            r"(?m)^[ \t]*(?:pub(?:\s+\([^)]*\))?\s+)?(?:async\s+)?(?:fn|struct|enum|impl|trait|mod|type|const|static|class|def|function|interface)\s+[A-Za-z_]",
        )
        .expect("代码声明正则")
    });
    if let Some(m) = code.find(text) {
        let line_end = text[m.start()..]
            .find('\n')
            .map(|i| m.start() + i)
            .unwrap_or(text.len());
        let line = collapse_ws(&text[m.start()..line_end]);
        if !line.is_empty() {
            return truncate_chars(&line, MAX_AUTO_TITLE_CHARS);
        }
    }
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        // Markdown 标题行去掉前导 #
        let stripped = line.trim_start_matches('#').trim();
        let candidate = if stripped.len() < line.len() && !stripped.is_empty() {
            stripped
        } else {
            line
        };
        let c = collapse_ws(candidate);
        if !c.is_empty() {
            return truncate_chars(&c, MAX_AUTO_TITLE_CHARS);
        }
    }
    fallback.into()
}

/// OCR 结果标题：跳过空行与无意义短片段（纯符号行、单字符行），
/// 在有信息量的行里取字符数最多的一行（并列取最靠前），截断到标题上限。
/// 纯确定性规则，不调用 LLM；用户未点「设为标题」时绝不写入。
pub fn title_from_ocr(text: &str) -> Option<String> {
    let mut best: Option<(usize, String)> = None;
    for line in text.lines() {
        let line = collapse_ws(line);
        if line.is_empty() {
            continue;
        }
        let meaningful = line.chars().filter(|c| c.is_alphanumeric()).count();
        let total = line.chars().filter(|c| !c.is_whitespace()).count();
        if meaningful < 2 || total == 0 || meaningful * 2 < total {
            continue;
        }
        let score = meaningful.min(MAX_AUTO_TITLE_CHARS);
        let better = match &best {
            Some((current, _)) => score > *current,
            None => true,
        };
        if better {
            best = Some((score, truncate_chars(&line, MAX_AUTO_TITLE_CHARS)));
        }
    }
    best.map(|(_, title)| title)
}

/// HTML 标题：优先 `<h1>` / `<title>` 的文本内容（清理标签后）。
fn html_heading_title(html: &str) -> Option<String> {
    static H1: OnceLock<Regex> = OnceLock::new();
    static TITLE: OnceLock<Regex> = OnceLock::new();
    let h1 = H1.get_or_init(|| Regex::new(r"(?is)<h1[^>]*>(.*?)</h1>").expect("h1 正则"));
    let title =
        TITLE.get_or_init(|| Regex::new(r"(?is)<title[^>]*>(.*?)</title>").expect("title 正则"));
    for re in [h1, title] {
        if let Some(caps) = re.captures(html) {
            let inner = caps.get(1)?.as_str();
            let text = collapse_ws(&strip_tags(inner));
            if !text.is_empty() {
                return Some(truncate_chars(&text, MAX_AUTO_TITLE_CHARS));
            }
        }
    }
    None
}

fn text_to_html(text: &str) -> String {
    escape_html(text)
        .replace("\r\n", "\n")
        .replace('\n', "<br/>")
}

/// 整组富文本：按组内顺序拼接文字/链接/HTML/图片（图片以 data URI 内嵌，受总大小限制）。
pub fn group_rich_html(
    items: &[ClipboardItem],
    image_data: &dyn Fn(&str) -> Option<Vec<u8>>,
) -> (String, String, Vec<String>) {
    let mut html = String::new();
    let mut plain = String::new();
    let mut warnings = Vec::new();
    const EMBED_BUDGET: usize = 6 * 1024 * 1024;
    let mut used: usize = 0;

    for (idx, item) in items.iter().enumerate() {
        if idx > 0 {
            html.push_str("<hr/>");
            plain.push_str("\n\n---\n\n");
        }
        match item.kind.as_str() {
            KIND_IMAGE => {
                let mut done = false;
                if let Some(bytes) = image_data(&item.id) {
                    let encoded_len = bytes.len() * 4 / 3 + 4;
                    if used + encoded_len <= EMBED_BUDGET {
                        use base64::Engine as _;
                        let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
                        html.push_str(&format!(
                            "<p><img src=\"data:image/png;base64,{b64}\" alt=\"{}\" style=\"max-width:100%\"/></p>",
                            escape_html(&item.preview)
                        ));
                        used += encoded_len;
                        done = true;
                    }
                }
                if !done {
                    html.push_str(&format!("<p>[图片：{}]</p>", escape_html(&item.preview)));
                    warnings.push(format!(
                        "第 {} 项图片未内嵌（总大小超过 6MB 或原文件不可读），富文本中为占位符",
                        idx + 1
                    ));
                }
                plain.push_str(&format!("[图片：{}]", item.preview));
            }
            KIND_FILES => {
                let names: Vec<String> = item
                    .file_paths
                    .iter()
                    .map(|p| {
                        std::path::Path::new(p)
                            .file_name()
                            .map(|n| n.to_string_lossy().into_owned())
                            .unwrap_or_else(|| p.clone())
                    })
                    .collect();
                let list = names
                    .iter()
                    .map(|n| format!("<li>{}</li>", escape_html(n)))
                    .collect::<String>();
                html.push_str(&format!("<ul>{list}</ul>"));
                plain.push_str(&names.join("\n"));
                warnings.push("富文本中的文件仅列名称；需要文件本体请使用「复制文件」".into());
            }
            KIND_HTML => {
                if item.html.len() > 512 * 1024 {
                    html.push_str(&format!("<p>{}</p>", escape_html(&item.preview)));
                    warnings.push(format!("第 {} 项网页内容过大，已降级为文本", idx + 1));
                } else {
                    html.push_str(&sanitize_html(&item.html));
                }
                plain.push_str(item.text.as_str());
            }
            KIND_URL => {
                let label = escape_html(item.text.trim());
                html.push_str(&format!("<p><a href=\"{}\">{}</a></p>", label, label));
                plain.push_str(item.text.trim());
            }
            _ => {
                html.push_str(&format!("<p>{}</p>", text_to_html(&item.text)));
                plain.push_str(&item.text);
            }
        }
    }
    (html, plain, warnings)
}

/// 自动分组决策：
/// - 仅截图开启新组；文本/HTML/URL 只有在截图窗口仍有效时按实际顺序追加；
/// - 非截图内容来自与组内截图**不同的应用**时不追加（大概率是无关复制，降低误分组）；
///   任一方来源未知（空串）时保持窗口内追加的原行为；
/// - 文件列表不参与截图自动分组；
/// - 组内条数达到上限后，下一张截图开新组。
pub fn decide_group(
    kind: &str,
    auto_group: bool,
    now: DateTime<Utc>,
    window_secs: i64,
    open_last_image_at: Option<DateTime<Utc>>,
    open_item_count: usize,
    item_source_app: &str,
    group_image_source_app: Option<&str>,
) -> GroupAction {
    if !auto_group || kind == KIND_FILES {
        return GroupAction::None;
    }
    let window = Duration::seconds(window_secs.max(1));
    if let Some(last) = open_last_image_at {
        if now - last <= window && open_item_count < MAX_AUTO_GROUP_ITEMS {
            // 文字/HTML/图片之间的交错内容始终留在当前截图流里：
            // 「截图 A → 文字 → 截图 B」是用户真实工作顺序，不能因为文字来自
            // 记事本、截图来自截图工具就把它拆出去。
            //
            // 只有「另一张图片且来源应用明确不同」才视为新会话：同一窗口内
            // 从浏览器复制图片后紧接着截图，若仍并入会把两种来源混成一组。
            if kind == KIND_IMAGE {
                if let Some(group_src) = group_image_source_app.filter(|s| !s.is_empty()) {
                    if !item_source_app.is_empty() && item_source_app != group_src {
                        return GroupAction::Create;
                    }
                }
            }
            return GroupAction::Append;
        }
    }
    if kind == KIND_IMAGE {
        GroupAction::Create
    } else {
        GroupAction::None
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RestoreDecision {
    /// 没有可用快照（初始剪贴板为空或格式不支持）
    NoSnapshot,
    /// 期间没有其他程序写入剪贴板，可以安全恢复
    Restore,
    /// 用户/其他程序已写入新内容，绝不覆盖
    KeepUserCopy,
}

pub fn decide_restore(has_snapshot: bool, user_changed: bool) -> RestoreDecision {
    if !has_snapshot {
        RestoreDecision::NoSnapshot
    } else if user_changed {
        RestoreDecision::KeepUserCopy
    } else {
        RestoreDecision::Restore
    }
}

/// 截图组自动命名的主题长度上限（字符数）。
pub const MAX_GROUP_TOPIC_CHARS: usize = 24;

/// 从来源标题/关联文本中提取可用于组名的主题：
/// 取首个非空行并折叠空白；`unknown`/`未知`/`无标题` 不是可靠信息，返回 None。
pub fn group_topic(raw: &str) -> Option<String> {
    for line in raw.lines() {
        let text = collapse_ws(line.trim());
        if text.is_empty() {
            continue;
        }
        let lower = text.to_ascii_lowercase();
        if matches!(lower.as_str(), "unknown" | "未知" | "无标题" | "未命名") {
            continue;
        }
        return Some(text);
    }
    None
}

/// 截图组名称：优先可靠来源信息/关联文本主题，信息不足时用时间兜底。
///
/// 返回 `(name, name_source)`，`name_source` 直接写入数据库：
/// `auto_source`（有主题）或 `auto_time`（时间兜底，关闭收集时可再补数量）。
/// 不引入 OCR / AI / 网络调用；`time_label` 由调用方按本地时间格式化。
pub fn screenshot_group_name(topic: Option<&str>, time_label: &str) -> (String, &'static str) {
    match topic.and_then(group_topic) {
        Some(text) => (
            format!("截图 · {}", truncate_chars(&text, MAX_GROUP_TOPIC_CHARS)),
            "auto_source",
        ),
        None => (format!("截图 · {time_label}"), "auto_time"),
    }
}

/// 时间兜底组关闭收集时补上图片数量（只对 `auto_time` 组调用，不会覆盖用户改名）。
pub fn finalize_time_group_name(name: &str, image_count: usize) -> String {
    if image_count == 0 {
        return name.to_string();
    }
    truncate_chars(&format!("{name} · {image_count} 张"), 80)
}

/// 本地时间戳（用于截图组时间兜底命名）。
pub fn local_time_label() -> String {
    Local::now().format("%m-%d %H:%M").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(kind: &str, text: &str, html: &str) -> ClipboardItem {
        ClipboardItem {
            id: uuid::Uuid::new_v4().to_string(),
            kind: kind.into(),
            text: text.into(),
            html: html.into(),
            preview: text.into(),
            title: String::new(),
            title_source: "none".into(),
            byte_size: text.len() as i64,
            source_app: "test.exe".into(),
            source_title: "测试".into(),
            source_kind: "owner".into(),
            image_width: None,
            image_height: None,
            file_paths: vec![],
            favorite: false,
            pinned: false,
            copy_count: 1,
            created_at: "2026-01-01T00:00:00+00:00".into(),
            last_seen_at: "2026-01-01T00:00:00+00:00".into(),
            has_image: false,
            has_thumb: false,
        }
    }

    #[test]
    fn classify_prefers_files_then_image_then_url_then_html() {
        assert_eq!(
            classify("a", "<b>b</b>", false, &["C:\\a.txt".into()]),
            Some(KIND_FILES)
        );
        assert_eq!(classify("", "", true, &[]), Some(KIND_IMAGE));
        assert_eq!(
            classify(" https://example.com/a?b=1 ", "", false, &[]),
            Some(KIND_URL)
        );
        assert_eq!(
            classify("标题", "<h1>标题</h1>", false, &[]),
            Some(KIND_HTML)
        );
        assert_eq!(classify("纯文本", "", false, &[]), Some(KIND_TEXT));
        assert_eq!(classify("   ", "", false, &[]), None);
        assert_eq!(
            classify("https://a b", "", false, &[]),
            Some(KIND_TEXT),
            "含空格不是 URL"
        );
    }

    #[test]
    fn preview_is_bounded_and_never_full_body() {
        let long = "字".repeat(500);
        let p = make_preview(KIND_TEXT, &long, "", &[], None, None);
        assert!(p.chars().count() <= 221);
        assert!(p.ends_with('…'));
        let f = make_preview(
            KIND_FILES,
            "",
            "",
            &[
                "C:\\a\\one.txt".into(),
                "C:\\b\\two.pdf".into(),
                "C:\\c\\three.png".into(),
            ],
            None,
            None,
        );
        assert!(f.contains("one.txt") && f.contains("3 个文件"));
        assert_eq!(
            make_preview(KIND_IMAGE, "", "", &[], Some(1920), Some(1080)),
            "图片 1920×1080"
        );
    }

    #[test]
    fn hash_dedupes_identical_and_separates_types() {
        let a = content_hash(KIND_TEXT, "hello", "", &[], None);
        let b = content_hash(KIND_TEXT, "hello", "", &[], None);
        let c = content_hash(KIND_HTML, "hello", "<b>hello</b>", &[], None);
        let d = content_hash(KIND_TEXT, "hello", "", &[], Some(&[1, 2, 3]));
        assert_eq!(a, b);
        assert_ne!(a, c);
        assert_ne!(a, d);
        assert_eq!(a.len(), 64);
    }

    #[test]
    fn sensitive_filter_only_high_confidence_patterns() {
        assert_eq!(
            sensitive_reason("-----BEGIN OPENSSH PRIVATE KEY-----\nabc"),
            Some("PEM 私钥")
        );
        assert_eq!(
            sensitive_reason("AWS AKIAIOSFODNN7EXAMPLE"),
            Some("AWS 访问密钥")
        );
        assert_eq!(
            sensitive_reason("ghp_abcdefghijklmnopqrstuvwxyz0123456789"),
            Some("GitHub 令牌")
        );
        assert!(
            sensitive_reason("普通备注 password=test").is_none(),
            "不宣称识别普通密码"
        );
        assert!(sensitive_reason("").is_none());
    }

    #[test]
    fn conservative_filter_catches_credentials_only_when_source_unknown() {
        assert_eq!(
            conservative_sensitive_reason("password=hunter2!"),
            Some("凭据赋值")
        );
        assert_eq!(
            conservative_sensitive_reason("Authorization: Bearer abcdefghijkl"),
            Some("认证头")
        );
        assert_eq!(
            conservative_sensitive_reason(r#"{"token":"abcdef123456"}"#),
            Some("JSON 凭据字段")
        );
        assert!(conservative_sensitive_reason("普通的会议纪要内容").is_none());
        assert!(conservative_sensitive_reason("password 是本次会议主题").is_none());
    }

    #[test]
    fn html_sanitizer_removes_active_content() {
        let dirty = r#"<div onclick="steal()"><script>alert(1)</script><b>正文</b><a href="javascript:alert(1)">x</a></div>"#;
        let clean = sanitize_html(dirty);
        assert!(!clean.contains("<script"));
        assert!(!clean.contains("onclick"));
        assert!(!clean.to_lowercase().contains("javascript:"));
        assert!(clean.contains("<b>正文</b>"));
        assert!(clean.contains("<a href=\"#"));
    }

    #[test]
    fn hash_is_stable_between_raw_and_sanitized_html() {
        // 采集侧保留原文后，同一条富文本的去重键必须与升级前（存的是净化 HTML）一致，
        // 否则用户升级后再复制一次同样的内容就会多出一条历史记录。
        let make = |html: &str| CapturedContent {
            kind: KIND_HTML.into(),
            text: String::new(),
            html: html.into(),
            preview: String::new(),
            file_paths: Vec::new(),
            image: None,
            source_app: "chrome.exe".into(),
            source_title: "页面".into(),
            source_kind: "owner".into(),
            byte_size: 0,
        };
        let raw = "<p onclick=\"x()\">正文<script>alert(1)</script></p>";
        let cleaned = sanitize_html(raw);
        assert_ne!(raw, cleaned, "净化结果必须与原文不同，否则本测试无意义");
        assert_eq!(
            hash_of(&make(raw)),
            hash_of(&make(&cleaned)),
            "原文与净化视图必须映射到同一个去重键"
        );
        // 内容不同则哈希必须不同（去重不能过度合并）
        assert_ne!(hash_of(&make(raw)), hash_of(&make("<p>另一段</p>")));
    }

    #[test]
    fn cf_html_offsets_point_into_payload() {
        let frag = "<p>中文 <b>hello</b></p>";
        let doc = cf_html(frag);
        let get = |key: &str| -> usize {
            let line = doc
                .lines()
                .find(|l| l.starts_with(key))
                .unwrap_or_else(|| panic!("缺少 {key}"));
            line[key.len() + 1..].trim().parse().unwrap()
        };
        let sf = get("StartFragment");
        let ef = get("EndFragment");
        assert_eq!(&doc[sf..ef], frag, "字节偏移必须精确指向片段");
        assert!(get("StartHTML") < sf);
        assert!(get("EndHTML") > ef);
    }

    #[test]
    fn grouping_window_and_interleaving() {
        let now = Utc::now();
        let t0 = now - Duration::seconds(10);
        assert_eq!(
            decide_group(KIND_IMAGE, true, now, 45, None, 0, "snip.exe", None),
            GroupAction::Create
        );
        assert_eq!(
            decide_group(
                KIND_IMAGE,
                true,
                now,
                45,
                Some(t0),
                3,
                "snip.exe",
                Some("snip.exe")
            ),
            GroupAction::Append
        );
        assert_eq!(
            decide_group(
                KIND_TEXT,
                true,
                now,
                45,
                Some(t0),
                3,
                "snip.exe",
                Some("snip.exe")
            ),
            GroupAction::Append,
            "窗口内文本插入同一组并保留顺序"
        );
        assert_eq!(
            decide_group(
                KIND_TEXT,
                true,
                now,
                45,
                Some(t0),
                3,
                "word.exe",
                Some("snip.exe")
            ),
            GroupAction::Append,
            "文本来源不同也必须留在截图流中：「截图 A → 文字 → 截图 B」不拆组"
        );
        assert_eq!(
            decide_group(
                KIND_IMAGE,
                true,
                now,
                45,
                Some(t0),
                3,
                "chrome.exe",
                Some("snip.exe")
            ),
            GroupAction::Create,
            "另一张图片来自不同应用时另起截图会话，避免把浏览器图片混入截图组"
        );
        assert_eq!(
            decide_group(KIND_TEXT, true, now, 45, Some(t0), 3, "", Some("snip.exe")),
            GroupAction::Append,
            "条目来源未知时保持原行为"
        );
        assert_eq!(
            decide_group(KIND_TEXT, true, now, 45, Some(t0), 3, "word.exe", Some("")),
            GroupAction::Append,
            "组内截图来源未知时保持原行为"
        );
        assert_eq!(
            decide_group(
                KIND_IMAGE,
                true,
                now,
                5,
                Some(t0),
                3,
                "other.exe",
                Some("snip.exe")
            ),
            GroupAction::Create,
            "超过窗口后新截图开新组"
        );
        assert_eq!(
            decide_group(
                KIND_TEXT,
                true,
                now,
                5,
                Some(t0),
                3,
                "snip.exe",
                Some("snip.exe")
            ),
            GroupAction::None,
            "过期后文本不新建组"
        );
        assert_eq!(
            decide_group(
                KIND_FILES,
                true,
                now,
                45,
                Some(t0),
                3,
                "snip.exe",
                Some("snip.exe")
            ),
            GroupAction::None,
            "文件列表不参与截图分组"
        );
        assert_eq!(
            decide_group(
                KIND_IMAGE,
                false,
                now,
                45,
                Some(t0),
                3,
                "snip.exe",
                Some("snip.exe")
            ),
            GroupAction::None,
            "关闭自动分组后不动作"
        );
        assert_eq!(
            decide_group(
                KIND_IMAGE,
                true,
                now,
                45,
                Some(t0),
                MAX_AUTO_GROUP_ITEMS,
                "snip.exe",
                Some("snip.exe")
            ),
            GroupAction::Create,
            "达到组上限后开新组"
        );
    }

    #[test]
    fn auto_title_rules_per_kind() {
        // 普通文本：首个有效短句
        assert_eq!(
            make_title(KIND_TEXT, "会议纪要要点\n第二行内容", "", &[], None, None),
            "会议纪要要点"
        );
        // 长文章首行超长时截断
        let long = "字".repeat(50);
        let t = make_title(KIND_TEXT, &long, "", &[], None, None);
        assert!(t.chars().count() <= MAX_AUTO_TITLE_CHARS && t.ends_with('…'));
        // Markdown 标题行去掉 #
        assert_eq!(
            make_title(KIND_TEXT, "# 项目周报\n正文内容", "", &[], None, None),
            "项目周报"
        );
        // 代码片段优先声明行
        assert_eq!(
            make_title(
                KIND_TEXT,
                "// 注释\npub fn parse_config(path: &Path) -> Result<Config> {\n}",
                "",
                &[],
                None,
                None
            ),
            "pub fn parse_config(path: &Pa…"
        );
        // URL：域名 + 首段路径
        assert_eq!(
            make_title(KIND_URL, "https://example.com/a/b?x=1", "", &[], None, None),
            "example.com/a"
        );
        assert_eq!(
            make_title(KIND_URL, "https://example.com", "", &[], None, None),
            "example.com"
        );
        // HTML：优先 h1 / title，清理标签
        assert_eq!(
            make_title(
                KIND_HTML,
                "正文",
                "<h1>发布说明</h1><p>v2</p>",
                &[],
                None,
                None
            ),
            "发布说明"
        );
        assert_eq!(
            make_title(
                KIND_HTML,
                "正文文本",
                "<html><title>页面标题</title><p>正文文本</p></html>",
                &[],
                None,
                None
            ),
            "页面标题"
        );
        // HTML 无标题时回退剥离标签后的文本
        assert_eq!(
            make_title(KIND_HTML, "正文文本", "<p>正文文本</p>", &[], None, None),
            "正文文本"
        );
        // 图片：尺寸描述，不推断内容
        assert_eq!(
            make_title(KIND_IMAGE, "", "", &[], Some(1920), Some(1080)),
            "截图 1920×1080"
        );
        assert_eq!(make_title(KIND_IMAGE, "", "", &[], None, None), "图片");
        // 文件列表：首名 + 数量
        assert_eq!(
            make_title(
                KIND_FILES,
                "",
                "",
                &["C:\\a\\报告.pdf".into(), "C:\\b\\图.png".into()],
                None,
                None
            ),
            "报告.pdf 等 2 个文件"
        );
        // 空白/换行归一
        assert_eq!(
            make_title(KIND_TEXT, "  多个   空格\n\n第二行", "", &[], None, None),
            "多个 空格"
        );
    }

    #[test]
    fn restore_never_overwrites_new_user_content() {
        assert_eq!(decide_restore(false, false), RestoreDecision::NoSnapshot);
        assert_eq!(decide_restore(true, false), RestoreDecision::Restore);
        assert_eq!(decide_restore(true, true), RestoreDecision::KeepUserCopy);
    }

    #[test]
    fn rich_group_orders_items_and_marks_missing_images() {
        let a = item(KIND_TEXT, "第一段\n第二行", "");
        let b = item(KIND_IMAGE, "", "");
        let c = item(KIND_URL, "https://example.com", "");
        let (html, plain, warnings) = group_rich_html(&[a, b, c], &|_| None);
        assert!(html.contains("第一段<br/>第二行"));
        assert!(html.contains("[图片："));
        assert!(html.contains("https://example.com"));
        assert!(plain.contains("---"));
        assert_eq!(warnings.len(), 1);
        let ordered = html.find("第一段").unwrap() < html.find("图片").unwrap();
        assert!(ordered, "必须保留组内实际顺序");
    }

    #[test]
    fn screenshot_group_name_prefers_reliable_topic_then_time() {
        let (name, source) = screenshot_group_name(Some("季度报表 - Excel"), "11-04 14:32");
        assert_eq!(name, "截图 · 季度报表 - Excel");
        assert_eq!(source, "auto_source");

        // 占位词/空串不是可靠信息，回退时间
        let (name, source) = screenshot_group_name(Some("未知"), "11-04 14:32");
        assert_eq!(name, "截图 · 11-04 14:32");
        assert_eq!(source, "auto_time");
        let (name, source) = screenshot_group_name(None, "11-04 14:32");
        assert_eq!(name, "截图 · 11-04 14:32");
        assert_eq!(source, "auto_time");

        // 主题取首个非空行并折叠空白，超长截断
        assert_eq!(group_topic("\n\n  项目   评审  \n第二行"), Some("项目 评审".into()));
        let long = "很长的标题".repeat(10);
        let (name, source) = screenshot_group_name(Some(&long), "11-04 14:32");
        assert_eq!(source, "auto_source");
        assert!(name.chars().count() <= "截图 · ".chars().count() + MAX_GROUP_TOPIC_CHARS);
    }

    #[test]
    fn time_fallback_group_gets_image_count_on_close() {
        assert_eq!(finalize_time_group_name("截图 · 11-04 14:32", 3), "截图 · 11-04 14:32 · 3 张");
        assert_eq!(finalize_time_group_name("截图 · 11-04 14:32", 0), "截图 · 11-04 14:32");
    }
}
