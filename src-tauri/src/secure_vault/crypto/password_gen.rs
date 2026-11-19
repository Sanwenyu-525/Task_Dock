//! 密码生成与强度评估。
//!
//! 生成只用 OS CSPRNG + 拒绝采样（无取模偏置）；强度是**启发式**，不是安全结论。

use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};

use crate::secure_vault::error::VaultError;

const UPPER: &str = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const LOWER: &str = "abcdefghijklmnopqrstuvwxyz";
const DIGIT: &str = "0123456789";
const SYMBOL: &str = "!@#$%^&*()-_=+[]{};:,.?/";
const AMBIGUOUS: &[char] = &['0', 'O', 'o', '1', 'l', 'I', '|'];

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateOptions {
    pub length: u8,
    pub upper: bool,
    pub lower: bool,
    pub digit: bool,
    pub symbol: bool,
    #[serde(default)]
    pub exclude_ambiguous: bool,
}

impl Default for GenerateOptions {
    fn default() -> Self {
        Self {
            length: 20,
            upper: true,
            lower: true,
            digit: true,
            symbol: true,
            exclude_ambiguous: true,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedDto {
    pub password: String,
    pub charset: String,
    pub entropy_bits: u16,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StrengthDto {
    pub score: u8,
    pub level: &'static str,
    pub entropy_bits: u16,
    pub reasons: Vec<String>,
}

fn filtered(set: &str, exclude_ambiguous: bool) -> String {
    if !exclude_ambiguous {
        return set.to_string();
    }
    set.chars()
        .filter(|c| !AMBIGUOUS.contains(c))
        .collect::<String>()
}

fn pick(set: &str) -> Result<char, VaultError> {
    let bytes = set.as_bytes();
    let len = bytes.len();
    if len == 0 || len > 256 {
        return Err(VaultError::internal("password:charset"));
    }
    let limit = 256 - (256 % len);
    loop {
        let mut b = [0u8; 1];
        OsRng
            .try_fill_bytes(&mut b)
            .map_err(|e| VaultError::internal(format!("rng:{}", e)))?;
        if (b[0] as usize) < limit {
            return Ok(bytes[(b[0] as usize) % len] as char);
        }
    }
}

fn random_index(bound: usize) -> Result<usize, VaultError> {
    if bound == 0 || bound > 256 {
        return Err(VaultError::internal("password:index"));
    }
    let limit = 256 - (256 % bound);
    loop {
        let mut b = [0u8; 1];
        OsRng
            .try_fill_bytes(&mut b)
            .map_err(|e| VaultError::internal(format!("rng:{}", e)))?;
        if (b[0] as usize) < limit {
            return Ok((b[0] as usize) % bound);
        }
    }
}

pub fn generate(opts: &GenerateOptions) -> Result<GeneratedDto, VaultError> {
    if opts.length < 8 || opts.length > 64 {
        return Err(VaultError::validation("密码长度", "须在 8–64 之间"));
    }
    let mut sets: Vec<String> = Vec::new();
    if opts.upper {
        sets.push(filtered(UPPER, opts.exclude_ambiguous));
    }
    if opts.lower {
        sets.push(filtered(LOWER, opts.exclude_ambiguous));
    }
    if opts.digit {
        sets.push(filtered(DIGIT, opts.exclude_ambiguous));
    }
    if opts.symbol {
        sets.push(filtered(SYMBOL, opts.exclude_ambiguous));
    }
    if sets.len() < 2 {
        return Err(VaultError::validation("密码字符类别", "至少选择 2 类"));
    }
    if sets.iter().any(|s| s.is_empty()) {
        return Err(VaultError::validation(
            "排除易混淆字符",
            "当前组合会清空某一字符类别",
        ));
    }
    if (opts.length as usize) < sets.len() {
        return Err(VaultError::validation("密码长度", "不能小于已选类别数"));
    }

    let mut out = String::with_capacity(opts.length as usize);
    for set in &sets {
        out.push(pick(set)?);
    }
    let union: String = sets.concat();
    for _ in sets.len()..(opts.length as usize) {
        out.push(pick(&union)?);
    }

    // Fisher–Yates，保证"每类至少一个"不会被固定在开头。
    let mut chars: Vec<char> = out.chars().collect();
    for i in (1..chars.len()).rev() {
        let j = random_index(i + 1)?;
        chars.swap(i, j);
    }
    let password: String = chars.into_iter().collect();
    let entropy = (opts.length as f64 * (union.len() as f64).log2()).round() as u16;
    Ok(GeneratedDto {
        password,
        charset: union,
        entropy_bits: entropy,
    })
}

pub fn evaluate(password: &str) -> StrengthDto {
    let len = password.chars().count();
    if len == 0 {
        return StrengthDto {
            score: 0,
            level: "weak",
            entropy_bits: 0,
            reasons: vec!["密码为空".to_string()],
        };
    }
    let mut has_upper = false;
    let mut has_lower = false;
    let mut has_digit = false;
    let mut has_symbol = false;
    for c in password.chars() {
        if c.is_ascii_uppercase() {
            has_upper = true;
        } else if c.is_ascii_lowercase() {
            has_lower = true;
        } else if c.is_ascii_digit() {
            has_digit = true;
        } else {
            has_symbol = true;
        }
    }
    let mut set = 0usize;
    if has_upper {
        set += 26;
    }
    if has_lower {
        set += 26;
    }
    if has_digit {
        set += 10;
    }
    if has_symbol {
        set += 33;
    }
    let entropy = if set == 0 {
        0.0
    } else {
        len as f64 * (set as f64).log2()
    };

    let mut reasons = Vec::new();
    let mut penalty = 0.0f64;
    let lower = password.to_ascii_lowercase();
    for (word, p) in [
        ("password", 45.0),
        ("admin", 35.0),
        ("welcome", 30.0),
        ("iloveyou", 35.0),
        ("abc123", 30.0),
        ("qwerty", 30.0),
        ("asdf", 20.0),
        ("1234", 15.0),
        ("0000", 15.0),
    ] {
        if lower.contains(word) {
            penalty += p;
            reasons.push(format!("包含常见词根「{word}」"));
        }
    }
    if len < 12 {
        penalty += (12 - len) as f64 * 3.0;
        reasons.push("长度不足 12 位".to_string());
    }
    if has_digit && has_lower && !has_upper && !has_symbol {
        penalty += 5.0;
        reasons.push("仅字母+数字，类别偏少".to_string());
    }
    // 连续重复（aaa / 111）
    let mut max_run = 1usize;
    let mut run = 1usize;
    let chars: Vec<char> = password.chars().collect();
    for i in 1..chars.len() {
        if chars[i] == chars[i - 1] {
            run += 1;
            max_run = max_run.max(run);
        } else {
            run = 1;
        }
    }
    if max_run >= 3 {
        penalty += (max_run - 2) as f64 * 8.0;
        reasons.push(format!("存在 {max_run} 个连续重复字符"));
    }
    // 连续递增/递减（abcd / 4321）
    let mut seq = 1usize;
    let mut max_seq = 1usize;
    for i in 1..chars.len() {
        let prev = chars[i - 1] as i32;
        let cur = chars[i] as i32;
        if (cur - prev).abs() == 1 {
            seq += 1;
            max_seq = max_seq.max(seq);
        } else {
            seq = 1;
        }
    }
    if max_seq >= 4 {
        penalty += (max_seq - 3) as f64 * 5.0;
        reasons.push("存在连续键盘/字母序列".to_string());
    }

    let score = (entropy - penalty).clamp(0.0, 100.0).round() as u8;
    let level = match score {
        0..=39 => "weak",
        40..=59 => "fair",
        60..=79 => "good",
        _ => "strong",
    };
    if reasons.is_empty() {
        reasons.push("未发现常见弱口令特征".to_string());
    }
    StrengthDto {
        score,
        level,
        entropy_bits: entropy.round() as u16,
        reasons,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_password_matches_requested_shape() {
        let opts = GenerateOptions {
            length: 24,
            upper: true,
            lower: true,
            digit: true,
            symbol: true,
            exclude_ambiguous: true,
        };
        let out = generate(&opts).unwrap();
        assert_eq!(out.password.chars().count(), 24);
        assert!(out.password.chars().any(|c| c.is_ascii_uppercase()));
        assert!(out.password.chars().any(|c| c.is_ascii_lowercase()));
        assert!(out.password.chars().any(|c| c.is_ascii_digit()));
        assert!(out
            .password
            .chars()
            .any(|c| "!@#$%^&*()-_=+[]{};:,.?/".contains(c)));
        assert!(!out.password.chars().any(|c| AMBIGUOUS.contains(&c)));
    }

    #[test]
    fn rejects_single_category_and_short_length() {
        let base = GenerateOptions {
            length: 12,
            upper: true,
            lower: false,
            digit: false,
            symbol: false,
            exclude_ambiguous: false,
        };
        assert!(generate(&base).is_err());
        let short = GenerateOptions {
            length: 4,
            ..GenerateOptions::default()
        };
        assert!(generate(&short).is_err());
    }

    #[test]
    fn strength_penalises_obvious_weak_values() {
        assert!(evaluate("password").score < 25);
        assert!(evaluate("123456").score < 25);
        let strong = evaluate("vN7#qZ2!rT9@wP4$");
        assert!(strong.score >= 60, "{strong:?}");
    }
}
