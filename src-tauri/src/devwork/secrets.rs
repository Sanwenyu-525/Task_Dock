//! 敏感内容扫描：交接文档入库前的凭证嗅探（AI 交接包可能带出环境变量/配置）。
//!
//! 边界与隐私：
//! - 输出只含「位置（text_index/line）+ 类型」，绝不包含命中原文；
//! - 只做保守的高置信匹配，不宣称能识别全部密码与令牌；
//! - 占位符排除：`${VAR}`、`***`、`<placeholder>` 这类文档常见写法不误报；
//! - 通用赋值规则复用剪贴板引擎同族正则（clipboard::engine），语义一致。

use serde::Serialize;
use std::sync::OnceLock;
use regex::Regex;

/// 单条命中：只含位置与类型，不含原文。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SecretFinding {
    /// 命中第几个输入文本（从 0 开始）。
    pub text_index: usize,
    /// 命中行号（从 1 开始）。
    pub line: usize,
    /// 命中类型（private_key / aws_key_id / github_token / sk_token / jwt /
    /// generic_assignment）。
    pub kind: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanOutcome {
    pub findings: Vec<SecretFinding>,
    /// true = 某个输入超过单文本行数上限，扫描提前停止（结果不完整）。
    pub truncated: bool,
}

/// 单个输入文本的扫描行数上限：交接文档可能很长，但逐行正则不能无限开销。
const MAX_LINES_PER_TEXT: usize = 20_000;

/// 静态编译正则（与 clipboard::engine 同款 OnceLock 惯例，进程内只编译一次）。
struct Patterns {
    private_key: Regex,
    aws_key_id: Regex,
    github_token: Regex,
    sk_token: Regex,
    jwt: Regex,
    generic_assignment: Regex,
}

fn patterns() -> &'static Patterns {
    static PATTERNS: OnceLock<Patterns> = OnceLock::new();
    PATTERNS.get_or_init(|| Patterns {
        private_key: Regex::new(r"-----BEGIN (RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----")
            .expect("私钥正则"),
        aws_key_id: Regex::new(r"\bAKIA[0-9A-Z]{16}\b").expect("AWS 密钥正则"),
        github_token: Regex::new(r"\bgh[pousr]_[A-Za-z0-9]{20,}\b").expect("GitHub 令牌正则"),
        sk_token: Regex::new(r"\bsk-(ant-)?[A-Za-z0-9_-]{20,}\b").expect("sk 令牌正则"),
        jwt: Regex::new(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b")
            .expect("JWT 正则"),
        // 不加 \b 前缀：DB_PASSWORD / MY_SECRET 这类下划线前缀写法是交接文档
        // 的高频形态（_ 与字母之间无词边界），宁可保守多报也不漏报。
        generic_assignment: Regex::new(
            r"(?i)(api[_-]?key|secret|token|password|passwd|pwd|credential)\s*[:=]\s*(\S{8,})",
        )
        .expect("凭据赋值正则"),
    })
}

/// 单行的命中类型。一行多条命中只报告一次（按优先级取第一个）：
/// 结构化令牌（私钥/云凭证/JWT）优先于宽泛的赋值形态，避免同一行重复报警。
fn classify_line(line: &str) -> Option<&'static str> {
    let p = patterns();
    if p.private_key.is_match(line) {
        return Some("private_key");
    }
    if p.aws_key_id.is_match(line) {
        return Some("aws_key_id");
    }
    if p.github_token.is_match(line) {
        return Some("github_token");
    }
    if p.sk_token.is_match(line) {
        return Some("sk_token");
    }
    if p.jwt.is_match(line) {
        return Some("jwt");
    }
    // 通用凭据赋值：值以占位符开头（${VAR} / *** / <...>）不算真实凭证。
    if let Some(caps) = p.generic_assignment.captures(line) {
        if let Some(value) = caps.get(2) {
            let v = value.as_str();
            if !(v.starts_with("${") || v.starts_with("***") || v.starts_with('<')) {
                return Some("generic_assignment");
            }
        }
    }
    None
}

/// 扫描一组文本。逐 text 逐行；单个文本超过 `MAX_LINES_PER_TEXT` 行时停止该
/// 文本并置 truncated（其余文本继续扫描）。
pub fn scan(texts: &[String]) -> ScanOutcome {
    let mut findings = Vec::new();
    let mut truncated = false;
    for (text_index, text) in texts.iter().enumerate() {
        for (idx, line) in text.lines().enumerate() {
            if idx >= MAX_LINES_PER_TEXT {
                truncated = true;
                break;
            }
            if let Some(kind) = classify_line(line) {
                findings.push(SecretFinding {
                    text_index,
                    line: idx + 1,
                    kind: kind.to_string(),
                });
            }
        }
    }
    ScanOutcome {
        findings,
        truncated,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_private_key_blocks() {
        let out = scan(&["-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----".into()]);
        assert_eq!(out.findings.len(), 1);
        assert_eq!(out.findings[0].kind, "private_key");
        assert_eq!(out.findings[0].line, 1);
        assert_eq!(out.findings[0].text_index, 0);

        // 其他前缀变体（OPENSSH / EC / 无前缀）
        for head in [
            "-----BEGIN OPENSSH PRIVATE KEY-----",
            "-----BEGIN EC PRIVATE KEY-----",
            "-----BEGIN PRIVATE KEY-----",
            "-----BEGIN PGP PRIVATE KEY-----",
            "-----BEGIN DSA PRIVATE KEY-----",
        ] {
            let out = scan(&[head.to_string()]);
            assert!(
                out.findings.iter().any(|f| f.kind == "private_key"),
                "{head} 必须命中"
            );
        }
        // 普通文本不得误报
        assert!(scan(&["-----BEGIN CERTIFICATE-----".to_string()])
            .findings
            .is_empty());
    }

    #[test]
    fn detects_aws_access_key_ids() {
        let out = scan(&["aws_access_key_id = AKIAIOSFODNN7EXAMPLE".into()]);
        assert_eq!(out.findings.len(), 1);
        assert_eq!(out.findings[0].kind, "aws_key_id");
        // 长度/字符集不符不得误报
        assert!(scan(&["AKIAshort".to_string()]).findings.is_empty());
        assert!(scan(&["AKIAIOSFODNN7EXAMPL3x".to_string()]).findings.is_empty());
    }

    #[test]
    fn detects_github_tokens() {
        let out = scan(&["token: ghp_0123456789abcdefghij0123456789abcd".into()]);
        // ghp_… 满足 github_token；同一行 token: 赋值也满足 generic_assignment，
        // 但一行只报一次，取优先级更高的 github_token。
        assert_eq!(out.findings.len(), 1);
        assert_eq!(out.findings[0].kind, "github_token");
        // 过短的 gh_ 前缀不算（<20 位）
        assert!(scan(&["ghp_short".to_string()]).findings.is_empty());
    }

    #[test]
    fn detects_sk_tokens() {
        let out = scan(&["OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz123456".into()]);
        assert_eq!(out.findings.len(), 1);
        assert_eq!(out.findings[0].kind, "sk_token");
        // anthropic 形态
        let out = scan(&["sk-ant-api03-abcdefghijklmnopqrstuvwxyz".into()]);
        assert_eq!(out.findings.len(), 1);
        assert_eq!(out.findings[0].kind, "sk_token");
    }

    #[test]
    fn detects_jwt() {
        let jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jGWNHkTaOQ";
        let out = scan(&[format!("Authorization: Bearer {jwt}")]);
        assert_eq!(out.findings.len(), 1);
        assert_eq!(out.findings[0].kind, "jwt");
        // 两段式不是 JWT
        assert!(scan(&["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0".to_string()])
            .findings
            .is_empty());
    }

    #[test]
    fn detects_generic_credential_assignment() {
        for line in [
            "api_key = \"super-secret-value-123\"",
            "DB_PASSWORD=hunter2hunter2",
            "my_secret: 0123456789abcdef",
            "credential=abcdefgh",
            "AUTH_TOKEN: \"averylongtokenvalue\"",
        ] {
            let out = scan(&[line.to_string()]);
            assert!(
                out.findings.iter().any(|f| f.kind == "generic_assignment"),
                "{line} 必须命中 generic_assignment"
            );
        }
    }

    #[test]
    fn placeholders_and_documents_do_not_trigger_generic_assignment() {
        // 占位符与文档写法不得误报
        for line in [
            "API_KEY=${API_KEY}",
            "api_key = ***",
            "password: <your-password-here>",
            "token_count",
            "Authorization: Bearer <token>",
            "secret",
            "token: \"\"",
            "pwd=short",
        ] {
            let out = scan(&[line.to_string()]);
            assert!(
                out.findings.is_empty(),
                "{line} 不得误报，实际 {:?}",
                out.findings
            );
        }
    }

    #[test]
    fn output_never_contains_matched_text() {
        let secret = "AKIAIOSFODNN7EXAMPLE";
        let out = scan(&[format!("key={secret}")]);
        assert_eq!(out.findings.len(), 1);
        let serialized = serde_json::to_string(&out).unwrap();
        assert!(
            !serialized.contains(secret),
            "输出绝不能包含命中原文：{serialized}"
        );
    }

    #[test]
    fn multi_text_indices_and_line_numbers_are_correct() {
        let texts = vec![
            "safe line\npassword=abcdef12345\nstill safe".to_string(),
            "jwt: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpM".to_string(),
        ];
        let out = scan(&texts);
        assert_eq!(out.findings.len(), 2);
        assert_eq!(out.findings[0].text_index, 0);
        assert_eq!(out.findings[0].line, 2);
        assert_eq!(out.findings[0].kind, "generic_assignment");
        assert_eq!(out.findings[1].text_index, 1);
        assert_eq!(out.findings[1].line, 1);
        assert_eq!(out.findings[1].kind, "jwt");
    }

    #[test]
    fn oversized_text_is_truncated_but_others_still_scanned() {
        // 第一个文本超过行数上限：truncated=true，该文本停止扫描；
        // 第二个文本的命中仍要报告。
        let mut big = String::new();
        for i in 0..(MAX_LINES_PER_TEXT + 10) {
            big.push_str(&format!("line-{i}\n"));
        }
        big.push_str("password=abcdef12345\n");
        let texts = vec![big, "password=abcdef67890".to_string()];
        let out = scan(&texts);
        assert!(out.truncated, "超限文本必须置 truncated");
        // 超限文本的命中行在 20000 行之后，不得出现
        assert!(
            !out.findings.iter().any(|f| f.text_index == 0),
            "超限文本停止后不得再产出命中"
        );
        assert!(
            out.findings
                .iter()
                .any(|f| f.text_index == 1 && f.kind == "generic_assignment"),
            "其他文本必须继续扫描"
        );
    }

    #[test]
    fn empty_input_yields_no_findings() {
        let out = scan(&[]);
        assert!(out.findings.is_empty());
        assert!(!out.truncated);
        let out = scan(&[String::new(), "".to_string()]);
        assert!(out.findings.is_empty());
        assert!(!out.truncated);
    }
}
