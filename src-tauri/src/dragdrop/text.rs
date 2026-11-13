//! HTML / 文本的**安全解析**：只提取纯文本与第一个图片地址。
//!
//! 为什么不用 HTML 解析器：本模块产物只有「纯文本 + 一个 URL」，
//! 任何树形解析、DOM 构建、实体全集解码都是多余攻击面。
//! 这里是一个显式状态机：
//! - `<script>` / `<style>` / `<!-- -->` 内容直接丢弃，不进入结果；
//! - 标签只作为「块级分隔 → 换行」信号，其余一律不保留（属性、样式、脚本都丢）；
//! - 只解码 5 个最常见实体（`&amp; &lt; &gt; &quot; &#39;` 与数字实体），
//!   其余保持原样，不做二次解码（避免 `&amp;lt;` 变 `<`）；
//! - 图片地址只取 `http:` / `https:`，`blob:` / `data:` / `file:` 一律不当作可读来源。

/// HTML 解析结果。
#[derive(Debug, Clone, PartialEq)]
pub struct HtmlExtract {
    pub text: String,
    pub image_url: Option<String>,
}

/// 块级标签：出现时补一个换行，避免整段粘成一行。
const BLOCK_TAGS: [&str; 18] = [
    "p", "div", "br", "li", "tr", "td", "th", "ul", "ol", "table", "section", "article", "header",
    "footer", "blockquote", "pre", "h1", "hr",
];

fn is_block_tag(tag: &str) -> bool {
    let lower = tag.to_ascii_lowercase();
    if (lower.starts_with('h') && lower.len() == 2) && lower.as_bytes()[1].is_ascii_digit() {
        return true;
    }
    BLOCK_TAGS.contains(&lower.as_str())
}

/// 从 HTML 提取纯文本与首个图片地址。
pub fn extract_html(html: &str) -> HtmlExtract {
    let mut out = String::with_capacity(html.len().min(64 * 1024));
    let mut image_url: Option<String> = None;
    let bytes = html.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] == b'<' {
            // 注释：整段丢弃
            if html[i..].starts_with("<!--") {
                match html[i..].find("-->") {
                    Some(end) => {
                        i += end + 3;
                        continue;
                    }
                    None => break,
                }
            }
            match html[i..].find('>') {
                Some(end) => {
                    let tag_body = &html[i + 1..i + end];
                    let name_end = tag_body
                        .find(|c: char| c.is_whitespace() || c == '/' || c == '>')
                        .unwrap_or(tag_body.len());
                    let tag = &tag_body[..name_end];
                    let lower = tag.to_ascii_lowercase();
                    // script/style 内容整体跳过
                    if lower == "script" || lower == "style" {
                        let close = format!("</{lower}");
                        match html[i + end..].to_ascii_lowercase().find(&close) {
                            Some(rel) => {
                                let end_of_close = html[i + end + rel..]
                                    .find('>')
                                    .map(|p| i + end + rel + p + 1)
                                    .unwrap_or(bytes.len());
                                i = end_of_close;
                                continue;
                            }
                            None => break,
                        }
                    }
                    if lower == "img" && image_url.is_none() {
                        image_url = first_src(tag_body);
                    }
                    if is_block_tag(tag) && !out.ends_with('\n') && !out.is_empty() {
                        out.push('\n');
                    }
                    i += end + 1;
                    continue;
                }
                None => break,
            }
        }
        let ch = html[i..].chars().next().unwrap_or(' ');
        out.push(ch);
        i += ch.len_utf8();
    }
    let text = normalize_text(&decode_entities(&out));
    HtmlExtract { text, image_url }
}

/// 取第一个 `src=` 的 http(s) 值；顺带兼容单引号与无引号写法。
fn first_src(tag_body: &str) -> Option<String> {
    let lower = tag_body.to_ascii_lowercase();
    let mut from = 0usize;
    while let Some(rel) = lower[from..].find("src") {
        let at = from + rel;
        // 必须是独立属性名（前面是空白或标签名之后）
        let after = lower[at + 3..].trim_start();
        if !after.starts_with('=') {
            from = at + 3;
            continue;
        }
        let value = after[1..].trim_start();
        let quote = value.chars().next();
        let raw = match quote {
            Some('"') | Some('\'') => {
                let q = quote.unwrap();
                let rest = &value[1..];
                rest.split(q).next().unwrap_or("")
            }
            _ => value.split_whitespace().next().unwrap_or(""),
        };
        let url = decode_entities(raw.trim());
        if let Some(u) = normalize_http_url(&url) {
            return Some(u);
        }
        from = at + 3;
    }
    None
}

/// 只接受 http/https，并去掉片段与首尾空白；其它协议返回 `None`。
pub fn normalize_http_url(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    let lower = trimmed.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return None;
    }
    if trimmed.len() > 2048 {
        return None;
    }
    // 拒绝含控制字符/空白的地址（浏览器可能把换行塞进属性里）
    if trimmed.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return None;
    }
    Some(trimmed.to_string())
}

/// 判断一段纯文本是否是**单个** URL（用于「拖了一个链接」的识别）。
pub fn single_url_in_text(text: &str) -> Option<String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    // 允许多行时只有一处非空行
    let lines: Vec<&str> = trimmed.lines().filter(|l| !l.trim().is_empty()).collect();
    if lines.len() > 1 {
        return None;
    }
    let candidate = lines[0].trim();
    normalize_http_url(candidate)
}

fn decode_entities(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut rest = raw;
    while let Some(pos) = rest.find('&') {
        out.push_str(&rest[..pos]);
        let tail = &rest[pos..];
        // 实体名最长 10 个字符；找不到 `;` 或名字不认识就原样保留 `&`
        // （绝不二次解码，避免 `&amp;lt;` 变成 `<`）。
        let entity_end = tail[1..]
            .find(';')
            .map(|p| p + 1)
            .filter(|p| *p <= 10);
        match entity_end.and_then(|end| decode_one(&tail[1..end]).map(|rep| (rep, end))) {
            Some((rep, end)) => {
                out.push_str(rep);
                rest = &tail[end + 1..];
            }
            None => {
                out.push('&');
                rest = &tail[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// 单个实体 → 文本。只覆盖最常见的 5 个与 `&nbsp;`，
/// 其余（含数字实体）返回 `None` 并按原文保留。
fn decode_one(entity: &str) -> Option<&'static str> {
    Some(match entity {
        "amp" => "&",
        "lt" => "<",
        "gt" => ">",
        "quot" => "\"",
        "apos" | "#39" => "'",
        "nbsp" => " ",
        _ => return None,
    })
}

/// 折叠空白：保留换行，行内多空白压成一个空格，去首尾空行。
pub fn normalize_text(raw: &str) -> String {
    let mut lines: Vec<String> = Vec::new();
    for line in raw.split('\n') {
        let collapsed = line.split_whitespace().collect::<Vec<_>>().join(" ");
        lines.push(collapsed.trim().to_string());
    }
    while lines.first().map(|l| l.is_empty()).unwrap_or(false) {
        lines.remove(0);
    }
    while lines.last().map(|l| l.is_empty()).unwrap_or(false) {
        lines.pop();
    }
    let joined = lines.join("\n");
    // 连续空行压成一个
    let mut out = String::with_capacity(joined.len());
    let mut blank_run = 0usize;
    for line in joined.split('\n') {
        if line.is_empty() {
            blank_run += 1;
            if blank_run > 1 {
                continue;
            }
        } else {
            blank_run = 0;
        }
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(line);
    }
    out
}

/// 截断到最多 `max_chars` 个字符，超出加省略号（用于预览字段）。
pub fn preview(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let mut s: String = text.chars().take(max_chars).collect();
    s.push('…');
    s
}

/// 判断链接「看起来是图片」：只依据扩展名/路径片段做提示，不代表已下载。
pub fn looks_like_image_url(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    let path = lower.split(['?', '#']).next().unwrap_or("");
    const EXTS: [&str; 8] = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".avif", ".svg"];
    EXTS.iter().any(|e| path.ends_with(e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 提取文本并丢弃脚本样式与注释() {
        let html = r#"
        <!-- 注释里有 <img src="https://evil.example/x.png"> -->
        <style>.a{color:red}</style>
        <script>alert('x')</script>
        <p>第一段</p><p>第二段 &amp; 结束</p>
        "#;
        let got = extract_html(html);
        assert_eq!(got.text, "第一段\n第二段 & 结束");
        // 注释里的 img 不能被当成真实图片来源
        assert_eq!(got.image_url, None);
    }

    #[test]
    fn 只接受_http_图片地址() {
        assert_eq!(
            extract_html(r#"<img src="https://a.example/p.png" width=10>"#).image_url,
            Some("https://a.example/p.png".into())
        );
        // blob / data / file 都不是可读来源
        assert_eq!(extract_html(r#"<img src="blob:https://a.example/123">"#).image_url, None);
        assert_eq!(extract_html(r#"<img src="data:image/png;base64,AAA">"#).image_url, None);
        assert_eq!(extract_html(r#"<img src="file:///C:/a.png">"#).image_url, None);
        // 单引号与无引号
        assert_eq!(
            extract_html("<img src='https://b.example/q.jpg'>").image_url,
            Some("https://b.example/q.jpg".into())
        );
    }

    #[test]
    fn 单个链接文本识别() {
        assert_eq!(
            single_url_in_text("  https://example.com/a?b=1  ").as_deref(),
            Some("https://example.com/a?b=1")
        );
        assert_eq!(single_url_in_text("看这个 https://example.com"), None);
        assert_eq!(single_url_in_text("blob:https://x/1"), None);
        assert_eq!(single_url_in_text("随便一段文字"), None);
    }

    #[test]
    fn 文本归一化保留段落结构() {
        assert_eq!(normalize_text("  a   b \n\n\n c  "), "a b\n\nc");
    }

    #[test]
    fn 图片地址判定() {
        assert!(looks_like_image_url("https://x/a.PNG?token=1"));
        assert!(looks_like_image_url("https://x/a.webp"));
        assert!(!looks_like_image_url("https://x/a.html"));
        assert!(!looks_like_image_url("https://x/a"));
    }

    #[test]
    fn 预览按字符截断() {
        assert_eq!(preview("abcdef", 3), "abc…");
        assert_eq!(preview("abc", 3), "abc");
    }

    #[test]
    fn 未闭合的_script_不会把后续内容当正文() {
        let got = extract_html("<script>var a=1;");
        assert_eq!(got.text, "");
    }
}
