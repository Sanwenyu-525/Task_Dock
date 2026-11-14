//! 把暂存会话**提交**到两个真实落点：最近暂存（shelf 库）与目录目标卡片。
//!
//! 分工（不重复建设）：
//! - 暂存架条目一律复用 `shelf::add_reference` / `add_managed` / `add_managed_from` /
//!   `add_link` / `add_text`：配额、磁盘余量、流式复制、原子改名、缩略图、
//!   去重与分组全部沿用既有实现；
//! - 目录投递一律复用 `fsops::drop_paths`：冲突策略（skip/rename）、复制/移动、
//!   日志与批处理报告都沿用既有实现；
//! - 本模块只负责「把暂存条目翻译成既有入参」，不新写任何文件搬运逻辑。
//!
//! 安全边界：
//! - 暂存条目里的 `path` 只可能来自后端自己的暂存目录（UUID 会话目录下），
//!   前端无法指定；`LocalPath` 则来自 OLE `CF_HDROP` 的真实路径；
//! - 网页链接 / 文本 / HTML **不产生文件**，因此目录落点直接拒绝，
//!   不做「悄悄写一个 .txt」的隐式转换；
//! - 提交成功或失败都会删除暂存目录，`operation_id` 一次消费后即失效。

use std::path::Path;

use serde::Serialize;

use crate::commands::shelf::ShelfFailedEntry;
use crate::error::{AppError, AppResult};
use crate::shelf::drop_targets;
use crate::shelf::fsops::{self, DropReport};
use crate::shelf::{self, ShelfItem, ShelfState, MODE_MANAGED, MODE_REFERENCE};

use super::payload::{DragPayloadView, PayloadFailure};
use super::stage;
use super::{codes, DragDropState, OpPhase, StagedItem, StagedKind};

/// 提交期间把会话目录登记为「活跃」，离开作用域（正常/提前返回/panic）时解除。
///
/// 根因：`take_for_commit` 会把会话移出注册表，但目录还要被复制/移动；此时
/// 新拖入触发的孤儿清扫只认注册表，会把正在复制的目录删掉。
struct CommitGuard<'a> {
    state: &'a DragDropState,
    id: &'a str,
}

impl<'a> CommitGuard<'a> {
    fn new(state: &'a DragDropState, id: &'a str) -> Self {
        Self { state, id }
    }
}

impl Drop for CommitGuard<'_> {
    fn drop(&mut self) {
        self.state.finish_commit(self.id);
    }
}

/// 目录落点拒绝非文件类型时的稳定文案（不含任何来源内容）。
const DIR_UNSUPPORTED_MSG: &str = 
    "此内容不能直接投递到文件夹：链接与文本不会自动生成文件。请先拖入最近暂存";

/// 统一提交报告：暂存架与目录卡片共用一份结构，前端按 `kind` 分流展示。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DragCommitReport {
    pub operation_id: String,
    /// `local-files` | `virtual-files` | `image` | `url` | `text` | `html` | `mixed`
    pub kind: String,
    pub added: Vec<ShelfItem>,
    pub failed: Vec<ShelfFailedEntry>,
    /// 拖入阶段就失败/丢弃的条目（与 `failed` 分开：这些从未进入提交）。
    pub failures: Vec<PayloadFailure>,
    pub skipped: usize,
}

/// 提交前的统一校验：会话必须存在、已读取完成、且未被消费。
fn take_ready_op(
    state: &DragDropState,
    operation_id: &str,
) -> AppResult<std::sync::Arc<super::StagedOp>> {
    let Some(op) = state.get(operation_id) else {
        return Err(AppError::NotFound(format!(
            "{}：{}",
            super::codes::DRAG_OPERATION_EXPIRED,
            operation_id
        )));
    };
    if op.snapshot().0 == OpPhase::Reading {
        // 仍在读流：**不**消费会话，让前端重试；此时 take 会把条目吞掉。
        // 前缀稳定码让诊断中心能按码聚合，而不是只看到通用 UNAVAILABLE。
        return Err(AppError::Unavailable(format!(
            "{}：拖入内容仍在读取，请稍后重试",
            super::codes::DRAG_PAYLOAD_PENDING
        )));
    }
    state.take_for_commit(operation_id).ok_or_else(|| {
        AppError::Conflict(format!(
            "{}：该拖入内容已被处理，请勿重复提交",
            super::codes::DRAG_OPERATION_EXPIRED
        ))
    })
}

/// 提交到「最近暂存」。
///
/// `storage_mode` 只影响**真实本地路径**（`reference` 不复制 / `managed` 复制）；
/// 虚拟文件与图片字节本来就是后端副本，必须托管，忽略该参数。
pub fn commit_to_shelf(
    st: &ShelfState,
    drop_state: &DragDropState,
    operation_id: &str,
    storage_mode: &str,
    group_id: Option<&str>,
) -> AppResult<DragCommitReport> {
    commit_to_shelf_with(
        &st.db,
        &st.root,
        &st.copy_gate,
        drop_state,
        operation_id,
        storage_mode,
        group_id,
    )
}

/// 与 [`commit_to_shelf`] 同实现，但只依赖 `Db`/根目录/复制闸。
///
/// 拆出来是为了让「非路径内容真正入库」可以用真实 SQLite + 临时目录验证，
/// 不必构造 `tauri::AppHandle`（`ShelfState` 需要它才能启动自动清理线程）。
pub(crate) fn commit_to_shelf_with(
    db: &crate::db::Db,
    root: &Path,
    gate: &std::sync::Arc<crate::shelf::CopyGate>,
    drop_state: &DragDropState,
    operation_id: &str,
    storage_mode: &str,
    group_id: Option<&str>,
) -> AppResult<DragCommitReport> {
    if !matches!(storage_mode, MODE_REFERENCE | MODE_MANAGED) {
        return Err(AppError::Validation(format!(
            "未知存储模式: {storage_mode}"
        )));
    }
    let op = take_ready_op(drop_state, operation_id)?;
    let _commit = CommitGuard::new(drop_state, &op.id);
    let (phase, items, failures, view) = op.snapshot();
    let kind = view
        .as_ref()
        .map(|v| v.kind().to_string())
        .unwrap_or_else(|| "unsupported".into());

    let mut added: Vec<ShelfItem> = Vec::new();
    let mut failed: Vec<ShelfFailedEntry> = Vec::new();
    // 拖入阶段已经丢弃/失败的条目（超量、目录项、读取失败）不属于提交失败，
    // 但必须如实出现在报告里，否则「部分成功」会被说成「全部成功」。
    let skipped = op.skipped();

    if phase == OpPhase::Failed && items.is_empty() {
        // 全部失败：如实返回失败，不制造「0 条成功」的假象。
        stage::remove_dir(&op.dir);
        return Ok(DragCommitReport {
            operation_id: op.id.clone(),
            kind,
            added,
            failed,
            failures,
            skipped,
        });
    }

    for item in &items {
        match item {
            StagedItem::LocalPath { path } => {
                let _permit = gate.acquire();
                let result = if storage_mode == MODE_MANAGED {
                    shelf::add_managed(db, root, path, "drag", group_id)
                } else {
                    shelf::add_reference(db, root, path, "drag", group_id)
                };
                match result {
                    Ok(item) => added.push(item),
                    Err(e) => failed.push(failed_entry(path.clone(), &e)),
                }
            }
            StagedItem::Staged {
                path,
                name,
                kind: item_kind,
                ..
            } => {
                // 图片与虚拟文件都走「无原始路径」的托管入口；
                // **绝不**把暂存临时路径写成 original_path。
                let _permit = gate.acquire();
                let display = match item_kind {
                    StagedKind::Image => Some(name.as_str()),
                    StagedKind::VirtualFile => Some(name.as_str()),
                };
                match shelf::add_managed_from(db, root, path, display, "drag", group_id)
                {
                    Ok(item) => added.push(item),
                    Err(e) => failed.push(failed_entry(name.clone(), &e)),
                }
            }
            StagedItem::Text { text, from_html } => {
                let source = if *from_html { "drag-html" } else { "drag" };
                match shelf::add_text(db, text, source, group_id) {
                    Ok(item) => added.push(item),
                    Err(e) => failed.push(failed_entry("文本内容".into(), &e)),
                }
            }
            StagedItem::Url { url, .. } => match shelf::add_link(db, url, group_id) {
                Ok(item) => added.push(item),
                Err(e) => failed.push(failed_entry("网页链接".into(), &e)),
            },
        }
    }

    // 无论成功与否都清理暂存目录：已托管的条目在 shelf 目录里另有副本。
    stage::remove_dir(&op.dir);

    Ok(DragCommitReport {
        operation_id: op.id.clone(),
        kind,
        added,
        failed,
        failures,
        skipped,
    })
}

/// 提交到「目录目标卡片」。
///
/// 只有会变成真实文件的类型可以投递（本地路径 / 虚拟文件 / 图片字节）；
/// 链接、文本、HTML 明确拒绝，绝不隐式生成文件。
pub fn commit_to_directory(
    st: &ShelfState,
    drop_state: &DragDropState,
    operation_id: &str,
    target_id: &str,
    batch_id: &str,
) -> AppResult<DropReport> {
    let op = take_ready_op(drop_state, operation_id)?;
    let _commit = CommitGuard::new(drop_state, &op.id);
    let (phase, items, _failures, view) = op.snapshot();

    let allow = view
        .as_ref()
        .map(|v| v.can_drop_to_directory())
        .unwrap_or(false)
        || items.iter().any(|i| {
            matches!(
                i,
                StagedItem::LocalPath { .. } | StagedItem::Staged { .. }
            )
        });
    if phase == OpPhase::Failed && items.is_empty() {
        stage::remove_dir(&op.dir);
        return Err(AppError::Validation(format!(
            "{}：{}",
            super::codes::DRAG_NO_READABLE_CONTENT,
            "拖入内容没有可投递的文件"
        )));
    }
    if !allow {
        stage::remove_dir(&op.dir);
        return Err(AppError::Validation(format!(
            "{}：{DIR_UNSUPPORTED_MSG}",
            codes::DRAG_TARGET_UNAVAILABLE
        )));
    }

    let target = drop_targets::get(&st.db, target_id)?;
    let mut paths: Vec<String> = Vec::new();
    for item in &items {
        match item {
            StagedItem::LocalPath { path } => paths.push(path.clone()),
            StagedItem::Staged { path, name, .. } => {
                // 防御：只接受仍在本会话暂存目录内的副本（防止被替换成指向别处的链接）。
                if !staged_path_in_session(&op.dir, path) {
                    tracing::warn!("暂存副本不在会话目录内，已跳过");
                    continue;
                }
                paths.push(path.to_string_lossy().to_string());
                let _ = name;
            }
            // 文本/链接不产生文件：直接忽略，由上面的 `allow` 决定整体是否拒绝。
            _ => {}
        }
    }
    if paths.is_empty() {
        stage::remove_dir(&op.dir);
        return Err(AppError::Validation(format!(
            "{}：{DIR_UNSUPPORTED_MSG}",
            codes::DRAG_TARGET_UNAVAILABLE
        )));
    }

    // 复用既有投递实现：冲突策略、复制/移动、报告与诊断都在 fsops 里。
    let report = fsops::drop_paths(&st.db, &st.root, &target, &paths, batch_id);
    stage::remove_dir(&op.dir);
    report
}

fn failed_entry(label: String, e: &AppError) -> ShelfFailedEntry {
    ShelfFailedEntry {
        path: label,
        reason: e.to_string(),
        code: Some(e.code().to_string()),
        category: Some(e.category().as_str().to_string()),
    }
}

/// 目录落点的可用性预判（供命令层在真正 copy 之前给出稳定错误码）。
pub fn can_drop_to_directory(view: Option<&DragPayloadView>, items: &[StagedItem]) -> bool {
    if let Some(view) = view {
        if view.can_drop_to_directory() {
            return true;
        }
    }
    items
        .iter()
        .any(|i| matches!(i, StagedItem::LocalPath { .. } | StagedItem::Staged { .. }))
}

/// 暂存副本的物理路径是否仍在本会话目录内（防止被替换成指向别处的链接）。
pub fn staged_path_in_session(dir: &Path, path: &Path) -> bool {
    let Ok(canon_dir) = std::fs::canonicalize(dir) else {
        return false;
    };
    let Ok(canon_path) = std::fs::canonicalize(path) else {
        return false;
    };
    canon_path.starts_with(&canon_dir)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;
    use crate::dragdrop::payload::DragPayloadView;
    use crate::dragdrop::{DragDropState, DragProbe, StagedItem, StagedKind};
    use crate::shelf::{CopyGate, ListFilter, KIND_IMAGE, KIND_LINK, KIND_TEXT};
    use std::path::PathBuf;
    use std::sync::Arc;

    /// 临时目录：只在系统临时区，结束即删。
    struct TempRoot(PathBuf);

    impl TempRoot {
        fn new() -> Self {
            let dir =
                std::env::temp_dir().join(format!("taskdock-commit-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn filter() -> ListFilter {
        ListFilter {
            search: None,
            kind: "all".into(),
            group_id: "all".into(),
            favorite_only: false,
            limit: 50,
            offset: 0,
            sort: "recent".into(),
        }
    }

    fn staged_op(ds: &DragDropState, view: DragPayloadView, items: Vec<StagedItem>) -> String {
        let probe = DragProbe::from_view(&view, Vec::new());
        let op = ds.begin(probe, None, view);
        op.finish(items, Vec::new(), 0);
        op.id.clone()
    }

    #[test]
    fn 链接会话真正落库为链接条目() {
        let tmp = TempRoot::new();
        let db = Db::open_in_memory().unwrap();
        let root = tmp.path().join("shelf-root");
        let gate = Arc::new(CopyGate::new());
        let ds = DragDropState::new(tmp.path().join("incoming"));
        let url = "https://example.com/page";
        let op_id = staged_op(
            &ds,
            DragPayloadView::Url {
                url: url.into(),
                is_image: false,
            },
            vec![StagedItem::Url {
                url: url.into(),
                is_image: false,
            }],
        );

        let report =
            commit_to_shelf_with(&db, &root, &gate, &ds, &op_id, "reference", None).unwrap();
        assert_eq!(report.added.len(), 1, "{:?}", report.failed);
        assert_eq!(report.added[0].kind, KIND_LINK);
        assert_eq!(report.added[0].content.as_deref(), Some(url));

        // 从数据库重新读：证明不是只在返回结构里「看起来成功」。
        let page = crate::shelf::list(&db, &filter()).unwrap();
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].id, report.added[0].id);
        let persisted = crate::shelf::get_item(&db, &report.added[0].id).unwrap();
        assert_eq!(persisted.kind, KIND_LINK);
        assert_eq!(persisted.content.as_deref(), Some(url));
    }

    #[test]
    fn 文本会话真正落库并能读回正文() {
        let tmp = TempRoot::new();
        let db = Db::open_in_memory().unwrap();
        let root = tmp.path().join("shelf-root");
        let gate = Arc::new(CopyGate::new());
        let ds = DragDropState::new(tmp.path().join("incoming"));
        let text = "从网页拖入的一段正文";
        let op_id = staged_op(
            &ds,
            DragPayloadView::Text {
                text_preview: text.into(),
                chars: text.chars().count(),
            },
            vec![StagedItem::Text {
                text: text.into(),
                from_html: false,
            }],
        );

        let report =
            commit_to_shelf_with(&db, &root, &gate, &ds, &op_id, "reference", None).unwrap();
        assert_eq!(report.added.len(), 1, "{:?}", report.failed);
        assert_eq!(report.added[0].kind, KIND_TEXT);
        let (read, truncated) =
            crate::shelf::read_text(&db, &root, &report.added[0].id).unwrap();
        assert_eq!(read, text);
        assert!(!truncated);
    }

    #[test]
    fn 图片会话落成托管副本且没有伪造原始路径() {
        let tmp = TempRoot::new();
        let db = Db::open_in_memory().unwrap();
        let root = tmp.path().join("shelf-root");
        let gate = Arc::new(CopyGate::new());
        let ds = DragDropState::new(tmp.path().join("incoming"));
        let png = crate::clipboard::image::encode_png(
            &[255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255],
            2,
            2,
        )
        .unwrap();
        let view = DragPayloadView::Image {
            items: Vec::new(),
            count: 1,
        };
        let probe = DragProbe::from_view(&view, Vec::new());
        let op = ds.begin(probe, None, view);
        let staged = crate::dragdrop::stage::write_bytes(&op.dir, "01-pic.png", &png).unwrap();
        op.finish(
            vec![StagedItem::Staged {
                path: staged,
                name: "pic.png".into(),
                size: png.len() as u64,
                kind: StagedKind::Image,
                mime: Some("image/png".into()),
                width: Some(2),
                height: Some(2),
            }],
            Vec::new(),
            0,
        );

        let report =
            commit_to_shelf_with(&db, &root, &gate, &ds, &op.id, "reference", None).unwrap();
        assert_eq!(report.added.len(), 1, "{:?}", report.failed);
        let item = &report.added[0];
        assert_eq!(item.kind, KIND_IMAGE);
        assert_eq!(item.storage_mode, MODE_MANAGED);
        // 绝不允许把暂存临时路径写成 original_path。
        assert!(item.original_path.is_none());
        let managed = item.managed_path.as_ref().expect("托管路径");
        assert!(
            root.join(managed).exists(),
            "托管副本必须真实存在: {managed}"
        );
        // 暂存目录已被清理（内容已托管）。
        assert!(!op.dir.exists());
    }
}
