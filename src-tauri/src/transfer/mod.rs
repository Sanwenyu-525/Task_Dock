//! 全局跨 Tab 联动的数据层与执行层。
//!
//! 分层：
//! - [`store`]：工作篮条目的增删改查、去重、正文分级存储、排序与生命周期；
//! - [`batches`]：一次批量发送的真实结果、进度聚合、撤销信息；
//! - [`execute`]：目标 = 文件工作区 的预览与执行（写文本/图片/URL、复制/移动文件）；
//! - [`context`]：跨窗口上下文（当前模块/项目/任务/目录）；
//! - [`links`]：没有归属表的实体关联（其余关系复用既有表）。
//!
//! 硬约束：
//! - 不新增第二套文件复制/移动/删除：全部经 `fsops` / `file_workspace`；
//! - 不新增剪贴板监听：图片与文本只按 id 读取既有缓存；
//! - 不存二进制；实体只存 id；
//! - 所有写操作返回真实结果，事件只用于刷新。

pub mod batches;
pub mod context;
pub mod execute;
pub mod links;
pub mod schema;
pub mod store;

#[cfg(test)]
mod tests;

use serde::{Deserialize, Serialize};

/// 条目正文内联上限（字节）。超过后写入 `transfer_contents`。
pub const MAX_INLINE_CONTENT: usize = 64 * 1024;
/// 条目正文总上限（字节）：再大就拒绝，并提示另存为文件。
pub const MAX_CONTENT: usize = 512 * 1024;
/// 标题上限（字符）。
pub const MAX_TITLE_CHARS: usize = 200;
/// 描述上限（字符）。
pub const MAX_DESCRIPTION_CHARS: usize = 400;
/// 单次批量加入上限。
pub const MAX_ADD_BATCH: usize = 200;
/// 列表单页上限。
pub const MAX_LIST_LIMIT: u32 = 200;
/// 列表默认条数。
pub const DEFAULT_LIST_LIMIT: u32 = 80;
/// 批次保留条数（只淘汰终态批次）。
pub const MAX_BATCH_HISTORY: usize = 30;
/// 发送成功后保留天数（设置项缺省）。
pub const DEFAULT_SENT_RETENTION_DAYS: i64 = 7;
/// 过期条目保留天数。
pub const EXPIRED_RETENTION_DAYS: i64 = 30;
/// 失败明细上限（批次结果）。
pub const MAX_FAILURES: usize = 200;

/// 条目类型白名单（与迁移中的 CHECK 一致）。
pub const ITEM_TYPES: &[&str] = &[
    "text", "richtext", "image", "file", "directory", "url", "clipboard", "task", "project",
    "planning", "knowledge", "capture",
];

/// 来源模块白名单。
pub const SOURCE_MODULES: &[&str] = &[
    "clipboard", "files", "tasks", "projects", "planning", "knowledge", "capture", "mobile",
    "resource", "shelf", "tray", "manual",
];

/// 目标模块白名单（文件目标之外目前由前端动作层执行）。
pub const TARGET_MODULES: &[&str] = &[
    "files", "tasks", "projects", "planning", "knowledge", "shelf", "capture",
];

/// 实体类型白名单。
pub const ENTITY_TYPES: &[&str] = &[
    "task",
    "workspace_project",
    "planning_project",
    "planning_feature",
    "planning_step",
    "knowledge_doc",
    "capture",
    "shelf_item",
    "clipboard_item",
    "file",
];

/// 关系类型白名单。
pub const RELATIONS: &[&str] = &["reference", "attachment", "parent", "derived"];

/// 判断字符串是否在白名单内（大小写敏感，值均为小写常量）。
pub fn is_allowed(list: &[&str], value: &str) -> bool {
    list.contains(&value)
}

/// 稳定去重键：`类型|来源|来源 id`；无来源 id 时由调用方传入内容哈希。
pub fn dedupe_key(item_type: &str, source_module: &str, source_id: &str, fallback: &str) -> String {
    let identity = if source_id.trim().is_empty() {
        fallback.to_string()
    } else {
        source_id.trim().to_string()
    };
    format!("{item_type}|{source_module}|{identity}")
}

/// 内容哈希（SHA-256，十六进制）：只用于去重键与诊断，不用于展示。
pub fn content_hash(text: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(text.as_bytes());
    format!("{:x}", hasher.finalize())
}

/// 条目（IPC 视图）。`payload` 直接是 JSON 对象，前端无需二次解析字符串。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferItem {
    pub id: String,
    pub item_type: String,
    pub source_module: String,
    pub source_id: String,
    pub title: String,
    pub description: String,
    pub content: String,
    pub payload: serde_json::Value,
    pub sort_order: f64,
    pub pinned: bool,
    pub status: String,
    pub error_code: String,
    pub error_message: String,
    pub last_target: String,
    pub created_at: String,
    pub updated_at: String,
    pub sent_at: Option<String>,
    pub expires_at: Option<String>,
    /// 运行时校验结果（不落库）：引用是否仍可用。
    pub available: bool,
    /// 不可用原因（仅当 `available=false`）。
    pub unavailable_reason: String,
}

/// 加入请求。`id` 可选：撤销删除时复用原 id（仍会做去重检查）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferItemInput {
    #[serde(default)]
    pub id: Option<String>,
    pub item_type: String,
    pub source_module: String,
    #[serde(default)]
    pub source_id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub payload: serde_json::Value,
    #[serde(default)]
    pub pinned: bool,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TransferFilter {
    #[serde(default)]
    pub item_types: Vec<String>,
    #[serde(default)]
    pub source_modules: Vec<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub search: Option<String>,
    #[serde(default)]
    pub pinned_only: bool,
    #[serde(default)]
    pub limit: Option<u32>,
    #[serde(default)]
    pub offset: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferPage {
    pub items: Vec<TransferItem>,
    pub total: i64,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TransferItemPatch {
    pub title: Option<String>,
    pub description: Option<String>,
    pub content: Option<String>,
    pub pinned: Option<bool>,
    /// 只允许 `ready` / `expired`（其余状态由批次执行维护）。
    pub status: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferAddReport {
    pub items: Vec<TransferItem>,
    pub duplicates: usize,
    pub rejected: Vec<TransferRejection>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferRejection {
    pub title: String,
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferRemoveReport {
    pub removed: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferCounts {
    pub total: i64,
    pub ready: i64,
    pub failed: i64,
    pub pinned: i64,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferTarget {
    pub module: String,
    #[serde(rename = "ref", default)]
    pub target_ref: String,
}

impl TransferTarget {
    pub fn new(module: impl Into<String>, target_ref: impl Into<String>) -> Self {
        Self {
            module: module.into(),
            target_ref: target_ref.into(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferOptions {
    #[serde(default = "default_conflict")]
    pub conflict: String,
    #[serde(default = "default_text_format")]
    pub text_format: String,
    #[serde(default = "default_text_mode")]
    pub text_mode: String,
    #[serde(default = "default_file_operation")]
    pub file_operation: String,
    #[serde(default = "default_url_mode")]
    pub url_mode: String,
    /// 发送成功后保留天数覆盖（0 = 使用默认）。
    #[serde(default)]
    pub sent_retention_days: Option<i64>,
}

fn default_conflict() -> String {
    "rename".into()
}
fn default_text_format() -> String {
    "txt".into()
}
fn default_text_mode() -> String {
    "separate".into()
}
fn default_file_operation() -> String {
    "copy".into()
}
fn default_url_mode() -> String {
    "url".into()
}

impl Default for TransferOptions {
    fn default() -> Self {
        Self {
            conflict: default_conflict(),
            text_format: default_text_format(),
            text_mode: default_text_mode(),
            file_operation: default_file_operation(),
            url_mode: default_url_mode(),
            sent_retention_days: None,
        }
    }
}

impl TransferOptions {
    /// 校验枚举值，拒绝未知策略（不做「猜一个」降级）。
    pub fn validate(&self) -> crate::error::AppResult<()> {
        if !matches!(self.conflict.as_str(), "skip" | "rename" | "overwrite") {
            return Err(crate::error::AppError::Validation(format!(
                "未知冲突策略: {}（允许 skip/rename/overwrite）",
                self.conflict
            )));
        }
        if !matches!(self.text_format.as_str(), "txt" | "md") {
            return Err(crate::error::AppError::Validation(
                "文本格式只允许 txt/md".into(),
            ));
        }
        if !matches!(self.text_mode.as_str(), "separate" | "merge") {
            return Err(crate::error::AppError::Validation(
                "文本保存模式只允许 separate/merge".into(),
            ));
        }
        if !matches!(self.file_operation.as_str(), "copy" | "move") {
            return Err(crate::error::AppError::Validation(
                "文件操作只允许 copy/move".into(),
            ));
        }
        if !matches!(self.url_mode.as_str(), "url" | "markdown") {
            return Err(crate::error::AppError::Validation(
                "链接保存方式只允许 url/markdown".into(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetValidation {
    pub valid: bool,
    pub message: String,
    pub display_name: String,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PreviewCounts {
    pub text: usize,
    pub richtext: usize,
    pub image: usize,
    pub file: usize,
    pub directory: usize,
    pub url: usize,
    pub clipboard: usize,
    pub entity: usize,
    pub unsupported: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewConflict {
    pub name: String,
    pub resolution: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewUnsupported {
    pub item_id: String,
    pub title: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferPreview {
    pub target_module: String,
    pub target_ref: String,
    pub target_valid: bool,
    pub target_message: String,
    pub counts: PreviewCounts,
    pub planned_files: usize,
    pub conflicts: Vec<PreviewConflict>,
    pub unsupported: Vec<PreviewUnsupported>,
    pub warnings: Vec<String>,
    pub move_removes_sources: usize,
    pub estimated_bytes: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchEntry {
    pub item_id: String,
    pub label: String,
    pub status: String,
    #[serde(default)]
    pub code: String,
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub target: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferBatch {
    pub id: String,
    pub target_module: String,
    pub target_ref: String,
    pub operation: String,
    pub status: String,
    pub total: usize,
    pub ok: usize,
    pub failed: usize,
    pub skipped: usize,
    pub job_ids: Vec<String>,
    pub entries: Vec<BatchEntry>,
    pub undo_state: String,
    pub undo_reason: String,
    pub message: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchUndoResult {
    pub batch_id: String,
    pub ok: bool,
    pub moved: usize,
    pub message: String,
}
