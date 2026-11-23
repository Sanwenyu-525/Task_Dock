//! Agent 导出的一次性确认闸门。
//!
//! 导出包是明文且可能包含正文/图片/任务描述，因此命令层要求：
//! 1. 先调用 `clipboard_export_preview` 取得目标指纹与一次性 token；
//! 2. 用户确认后，`clipboard_export_for_agent` 必须携带 token；
//! 3. token 绑定目标类型、目标 ID、任务 ID 与预览时的内容指纹，120 秒过期、单次使用。
//!
//! 这不是对「已攻陷渲染进程」的授权边界：同进程仍可先预览再导出；它的作用是把
//! “隐式直接导出”改成可审计的预览 + 明确确认，并阻止目标/内容在确认后悄悄变化。

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};

use crate::clipboard::ClipboardItem;
use crate::error::{AppError, AppResult};

pub const EXPORT_CONFIRM_TTL_SECS: u64 = 120;
const MAX_PENDING: usize = 64;

#[derive(Debug, Clone)]
struct Grant {
    target_type: String,
    target_id: String,
    task_id: Option<String>,
    signature: String,
    expires_at: Instant,
}

#[derive(Default)]
pub struct ExportGate {
    pending: HashMap<String, Grant>,
}

impl ExportGate {
    pub fn issue_at(
        &mut self,
        target_type: &str,
        target_id: &str,
        task_id: Option<&str>,
        signature: &str,
        now: Instant,
    ) -> (String, u64) {
        self.prune(now);
        // 容量有界：超出时淘汰最早过期的待确认项，避免预览堆积成无界内存。
        while self.pending.len() >= MAX_PENDING {
            if let Some(token) = self
                .pending
                .iter()
                .min_by_key(|(_, grant)| grant.expires_at)
                .map(|(token, _)| token.clone())
            {
                self.pending.remove(&token);
            } else {
                break;
            }
        }
        let token = uuid::Uuid::new_v4().simple().to_string();
        self.pending.insert(
            token.clone(),
            Grant {
                target_type: target_type.to_string(),
                target_id: target_id.to_string(),
                task_id: task_id.map(ToString::to_string),
                signature: signature.to_string(),
                expires_at: now + Duration::from_secs(EXPORT_CONFIRM_TTL_SECS),
            },
        );
        (token, EXPORT_CONFIRM_TTL_SECS)
    }

    pub fn consume_at(
        &mut self,
        token: &str,
        target_type: &str,
        target_id: &str,
        task_id: Option<&str>,
        signature: &str,
        now: Instant,
    ) -> AppResult<()> {
        let grant = self
            .pending
            .remove(token)
            .ok_or_else(|| AppError::Validation("缺少有效的导出确认，请先预览再导出".into()))?;
        if grant.expires_at <= now {
            return Err(AppError::Validation("导出确认已过期，请重新确认".into()));
        }
        if grant.target_type != target_type
            || grant.target_id != target_id
            || grant.task_id.as_deref() != task_id
            || grant.signature != signature
        {
            return Err(AppError::Validation(
                "导出目标或内容已变化，请重新预览并确认".into(),
            ));
        }
        Ok(())
    }

    fn prune(&mut self, now: Instant) {
        self.pending.retain(|_, grant| grant.expires_at > now);
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.pending.len()
    }
}

fn global_gate() -> &'static Mutex<ExportGate> {
    static GATE: OnceLock<Mutex<ExportGate>> = OnceLock::new();
    GATE.get_or_init(|| Mutex::new(ExportGate::default()))
}

/// 生成一次性确认 token 与有效期（秒）。
pub fn issue(
    target_type: &str,
    target_id: &str,
    task_id: Option<&str>,
    signature: &str,
) -> AppResult<(String, u64)> {
    let mut gate = global_gate()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    Ok(gate.issue_at(
        target_type,
        target_id,
        task_id,
        signature,
        Instant::now(),
    ))
}

/// 消费 token；目标、任务或内容指纹不匹配即失败，token 同时作废。
pub fn consume(
    token: &str,
    target_type: &str,
    target_id: &str,
    task_id: Option<&str>,
    signature: &str,
) -> AppResult<()> {
    let mut gate = global_gate()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    gate.consume_at(
        token,
        target_type,
        target_id,
        task_id,
        signature,
        Instant::now(),
    )
}

/// 预览时用于绑定“用户看到的内容”：条目顺序、ID 与导出可见元数据；不把正文/HTML
/// 写入指纹（虽然读取条目时会加载它们，指纹本身不含大文本）。
pub fn signature(items: &[ClipboardItem]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"tdclip-export-v1");
    for item in items {
        for value in [
            item.id.as_str(),
            item.kind.as_str(),
            item.title.as_str(),
            item.title_source.as_str(),
            item.preview.as_str(),
            item.source_app.as_str(),
            item.source_title.as_str(),
            item.created_at.as_str(),
        ] {
            hasher.update(value.as_bytes());
            hasher.update([0x1f]);
        }
        hasher.update(item.byte_size.to_string().as_bytes());
        hasher.update([0x1f]);
        for path in &item.file_paths {
            hasher.update(path.as_bytes());
            hasher.update([0x1f]);
        }
        hasher.update([0x1e]);
    }
    let digest = hasher.finalize();
    let mut out = String::with_capacity(64);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clipboard::ClipboardItem;

    fn item(id: &str, title: &str) -> ClipboardItem {
        ClipboardItem {
            id: id.into(),
            kind: "text".into(),
            text: String::new(),
            html: String::new(),
            preview: "preview".into(),
            title: title.into(),
            title_source: "auto".into(),
            byte_size: 12,
            source_app: "app".into(),
            source_title: "window".into(),
            source_kind: "owner".into(),
            image_width: None,
            image_height: None,
            file_paths: vec!["C:/a.txt".into()],
            favorite: false,
            pinned: false,
            copy_count: 1,
            created_at: "now".into(),
            last_seen_at: "now".into(),
            has_image: false,
            has_thumb: false,
        }
    }

    #[test]
    fn token_is_bound_single_use_and_expires() {
        let now = Instant::now();
        let mut gate = ExportGate::default();
        let sig = signature(&[item("i1", "标题")]);
        let (token, ttl) = gate.issue_at("item", "i1", Some("t1"), &sig, now);
        assert_eq!(ttl, EXPORT_CONFIRM_TTL_SECS);

        gate.consume_at(&token, "item", "i1", Some("t1"), &sig, now)
            .expect("首次确认应通过");
        assert!(gate
            .consume_at(&token, "item", "i1", Some("t1"), &sig, now)
            .is_err(), "token 必须单次使用");

        let (expired, _) = gate.issue_at("item", "i1", None, &sig, now);
        assert!(gate
            .consume_at(
                &expired,
                "item",
                "i1",
                None,
                &sig,
                now + Duration::from_secs(EXPORT_CONFIRM_TTL_SECS + 1)
            )
            .is_err());
        assert_eq!(gate.len(), 0, "过期项应在消费时移除");
    }

    #[test]
    fn token_rejects_changed_target_task_or_content() {
        let now = Instant::now();
        let mut gate = ExportGate::default();
        let sig = signature(&[item("i1", "标题")]);
        let (token, _) = gate.issue_at("item", "i1", Some("t1"), &sig, now);

        for (target_type, target_id, task_id, signature) in [
            ("group", "i1", Some("t1"), sig.as_str()),
            ("item", "i2", Some("t1"), sig.as_str()),
            ("item", "i1", Some("t2"), sig.as_str()),
            ("item", "i1", Some("t1"), "changed"),
        ] {
            assert!(
                gate.consume_at(token.as_str(), target_type, target_id, task_id, signature, now)
                    .is_err(),
                "目标/任务/内容不匹配必须失败"
            );
        }
    }

    #[test]
    fn signature_changes_with_item_metadata() {
        let a = signature(&[item("i1", "标题 A")]);
        let b = signature(&[item("i1", "标题 B")]);
        assert_ne!(a, b, "标题变化必须改变指纹");
        assert_eq!(a.len(), 64, "SHA-256 十六进制长度");
    }

    #[test]
    fn pending_tokens_are_bounded() {
        let now = Instant::now();
        let mut gate = ExportGate::default();
        let sig = signature(&[item("i1", "标题")]);
        for _ in 0..(MAX_PENDING + 8) {
            gate.issue_at("item", "i1", None, &sig, now);
        }
        assert_eq!(gate.len(), MAX_PENDING, "待确认 token 必须有界");
    }
}
