//! 主动粘贴与统一入库：把「当前剪贴板快照」转换成暂存架条目。
//!
//! 设计边界：
//! - 只消费**用户主动触发**时读取到的剪贴板快照（`ClipboardRead`），
//!   不监听、不缓存、不依赖剪贴板历史是否开启；
//! - 保存复用 `shelf::add_*` / `add_managed_png` 的既有配额、磁盘余量、
//!   `.part` 原子改名与缩略图逻辑，不建立第二套存储；
//! - 一次操作内按路径去重，单个文件失败不阻断其余条目；
//! - 文件夹在托管模式下仍保存为引用（既有 `add_managed` 明确拒绝目录），
//!   不因用户选了托管就把目录内容复制一份。
//!
//! 该模块返回结构化 `IntakeOutcome`，命令层再补 `operation_id` 等协议字段；
//! 测试可以直接构造 `ClipboardIntake`，不触碰真实系统剪贴板。

use std::collections::HashSet;
use std::path::Path;

use crate::clipboard::platform::ClipboardRead;
use crate::clipboard::{KIND_FILES, KIND_HTML, KIND_IMAGE, KIND_TEXT, KIND_URL};
use crate::db::Db;

use super::{add_link, add_managed, add_managed_png, add_reference, add_text, ShelfItem};

/// 一次粘贴最多处理的文件路径数：与剪贴板读取上限一致，避免「读到了却存不进」。
pub const MAX_INTAKE_FILES: usize = 200;

/// 全局收集热键完成后的前端事件：只带计数与稳定码，不带正文/路径。
pub const EVENT_COLLECTED: &str = "taskdock://shelf-collected";

/// 与系统剪贴板解耦的入库输入。命令层负责把 `ClipboardRead` 映射到这里，
/// 测试可以直接构造，不需要真实剪贴板。
#[derive(Debug, Clone, PartialEq)]
pub enum ClipboardIntake {
    Files(Vec<String>),
    Image {
        png: Vec<u8>,
        width: u32,
        height: u32,
    },
    Link(String),
    /// `html` 仅用于纯文本为空时的安全降级（提取可读文本或首个 http(s) 图片地址）。
    Text {
        text: String,
        html: Option<String>,
    },
    Empty {
        reason: String,
        code: &'static str,
        retryable: bool,
    },
}

impl ClipboardIntake {
    /// 把一次实时读取结果映射为入库输入。不读取正文之外的任何系统状态。
    pub fn from_read(read: ClipboardRead) -> Self {
        let (content, sequence) = match read {
            ClipboardRead::Content { content, sequence } => (content, sequence),
            ClipboardRead::Skip(reason) => {
                let busy = reason.contains("占用");
                // `read_clipboard` 对超限文本返回 Skip，而不是 Empty；不能一律归为
                // CLIPBOARD_UNREADABLE，否则前端的「内容过大」分支永远走不到。
                let too_large = reason.contains("上限");
                let unsupported = reason.contains("不支持");
                return Self::Empty {
                    reason: reason.to_string(),
                    code: if busy {
                        "CLIPBOARD_BUSY"
                    } else if too_large {
                        "CLIPBOARD_CONTENT_TOO_LARGE"
                    } else if unsupported {
                        "CLIPBOARD_UNSUPPORTED"
                    } else {
                        "CLIPBOARD_UNREADABLE"
                    },
                    retryable: busy,
                };
            }
            ClipboardRead::Empty(reason) => {
                let too_large = reason.contains("上限");
                let virtual_only = reason.contains("虚拟文件");
                return Self::Empty {
                    reason: reason.to_string(),
                    code: if too_large {
                        "CLIPBOARD_CONTENT_TOO_LARGE"
                    } else if virtual_only {
                        "CLIPBOARD_UNSUPPORTED"
                    } else {
                        "CLIPBOARD_EMPTY"
                    },
                    retryable: false,
                };
            }
        };
        let _ = sequence;
        match content.kind.as_str() {
            KIND_FILES => {
                if content.file_paths.is_empty() {
                    return Self::Empty {
                        reason: "剪贴板文件列表为空".into(),
                        code: "CLIPBOARD_EMPTY",
                        retryable: false,
                    };
                }
                Self::Files(content.file_paths)
            }
            KIND_IMAGE => match content.image {
                Some(image) => Self::Image {
                    png: image.png,
                    width: image.width,
                    height: image.height,
                },
                None => Self::Empty {
                    reason: "剪贴板图片字节不可用".into(),
                    code: "CLIPBOARD_UNREADABLE",
                    retryable: false,
                },
            },
            KIND_URL => {
                let url = content.text.trim().to_string();
                if url.is_empty() {
                    Self::Empty {
                        reason: "剪贴板链接为空".into(),
                        code: "CLIPBOARD_EMPTY",
                        retryable: false,
                    }
                } else {
                    Self::Link(url)
                }
            }
            KIND_TEXT => Self::Text {
                text: content.text,
                html: None,
            },
            KIND_HTML => Self::Text {
                text: content.text,
                html: Some(content.html),
            },
            _ => Self::Empty {
                reason: "剪贴板内容类型暂不支持".into(),
                code: "CLIPBOARD_UNSUPPORTED",
                retryable: false,
            },
        }
    }

    pub fn content_kind(&self) -> &'static str {
        match self {
            Self::Files(paths) => {
                if paths.len() == 1 {
                    "file"
                } else {
                    "files"
                }
            }
            Self::Image { .. } => "image",
            Self::Link(_) => "link",
            Self::Text { html: Some(_), .. } => "html",
            Self::Text { .. } => "text",
            Self::Empty { .. } => "none",
        }
    }
}

/// 单条失败：只带可展示原因与稳定错误码，不含正文。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IntakeFailure {
    pub target: String,
    pub reason: String,
    pub code: String,
    pub category: String,
}

#[derive(Debug)]
pub struct IntakeOutcome {
    pub content_kind: &'static str,
    pub added: Vec<ShelfItem>,
    pub failed: Vec<IntakeFailure>,
    pub skipped: usize,
    /// 与已有条目路径/正文相同的条数（不阻止本次保存，只用于提示）。
    pub duplicates: usize,
    /// 总失败时的稳定错误码；部分成功/成功为 None。
    pub failure_code: Option<&'static str>,
    pub retryable: bool,
}

impl IntakeOutcome {
    /// 无内容/不支持时构造带稳定错误码的空结果（截图暂存等窄入口复用）。
    pub(crate) fn empty(
        kind: &'static str,
        code: &'static str,
        reason: String,
        retryable: bool,
    ) -> Self {
        Self {
            content_kind: kind,
            added: Vec::new(),
            failed: vec![IntakeFailure {
                target: String::new(),
                reason,
                code: code.into(),
                category: if retryable {
                    "service".into()
                } else {
                    "unsupported".into()
                },
            }],
            skipped: 0,
            duplicates: 0,
            failure_code: Some(code),
            retryable,
        }
    }
}

/// 把一次输入保存到暂存架。调用方必须已完成模式校验。
pub fn save(
    db: &Db,
    root: &Path,
    intake: ClipboardIntake,
    storage_mode: &str,
    source_kind: &str,
    group_id: Option<&str>,
) -> IntakeOutcome {
    let kind = intake.content_kind();
    match intake {
        ClipboardIntake::Empty {
            reason,
            code,
            retryable,
        } => IntakeOutcome::empty(kind, code, reason, retryable),
        ClipboardIntake::Files(paths) => {
            save_files(db, root, paths, storage_mode, source_kind, group_id, kind)
        }
        ClipboardIntake::Image { png, width, height } => {
            let display = if width > 0 && height > 0 {
                format!("剪贴板图片 {width}×{height}.png")
            } else {
                "剪贴板图片.png".into()
            };
            match add_managed_png(db, root, &png, &display, source_kind, group_id) {
                Ok(item) => IntakeOutcome {
                    content_kind: kind,
                    added: vec![item],
                    failed: Vec::new(),
                    skipped: 0,
                    duplicates: 0,
                    failure_code: None,
                    retryable: false,
                },
                Err(error) => single_failure(kind, &error),
            }
        }
        ClipboardIntake::Link(url) => {
            let duplicate = content_duplicate(db, super::KIND_LINK, url.trim());
            match add_link(db, &url, group_id) {
                Ok(item) => IntakeOutcome {
                    content_kind: kind,
                    added: vec![item],
                    failed: Vec::new(),
                    skipped: 0,
                    duplicates: usize::from(duplicate),
                    failure_code: None,
                    retryable: false,
                },
                Err(link_error) => {
                    // 分类器已确认是链接，但校验层可能拒绝超长/非法 URL；
                    // 此时退回文本保存，避免用户主动粘贴直接丢内容。
                    if url.trim().is_empty() {
                        single_failure(kind, &link_error)
                    } else {
                        let text_duplicate = content_duplicate(db, super::KIND_TEXT, url.trim());
                        match add_text(db, &url, source_kind, group_id) {
                            Ok(item) => IntakeOutcome {
                                content_kind: "text",
                                added: vec![item],
                                failed: Vec::new(),
                                skipped: 0,
                                duplicates: usize::from(text_duplicate),
                                failure_code: None,
                                retryable: false,
                            },
                            Err(_) => single_failure(kind, &link_error),
                        }
                    }
                }
            }
        }
        ClipboardIntake::Text { text, html } => {
            let (plain, fallback_kind) = resolve_text(text, html.as_deref());
            if plain.trim().is_empty() {
                return IntakeOutcome::empty(
                    kind,
                    "CLIPBOARD_UNSUPPORTED",
                    "剪贴板富文本没有可保存的文本内容".into(),
                    false,
                );
            }
            // HTML 只有一张图片地址：保存为链接，不下载、不冒充图片字节。
            let duplicate_kind = if fallback_kind == "html-link" {
                super::KIND_LINK
            } else {
                super::KIND_TEXT
            };
            let duplicate = content_duplicate(db, duplicate_kind, plain.trim());
            let result = if fallback_kind == "html-link" {
                add_link(db, &plain, group_id)
            } else {
                add_text(db, &plain, source_kind, group_id)
            };
            match result {
                Ok(item) => IntakeOutcome {
                    content_kind: fallback_kind,
                    added: vec![item],
                    failed: Vec::new(),
                    skipped: 0,
                    duplicates: usize::from(duplicate),
                    failure_code: None,
                    retryable: false,
                },
                Err(error) => single_failure(kind, &error),
            }
        }
    }
}

fn single_failure(kind: &'static str, error: &crate::error::AppError) -> IntakeOutcome {
    IntakeOutcome {
        content_kind: kind,
        added: Vec::new(),
        failed: vec![failure("", error)],
        skipped: 0,
        duplicates: 0,
        failure_code: Some("SHELF_PASTE_FAILED"),
        retryable: false,
    }
}

fn save_files(
    db: &Db,
    root: &Path,
    paths: Vec<String>,
    storage_mode: &str,
    source_kind: &str,
    group_id: Option<&str>,
    kind: &'static str,
) -> IntakeOutcome {
    let mut added = Vec::new();
    let mut failed = Vec::new();
    let mut skipped = 0usize;
    let mut duplicates = 0usize;
    let mut seen: HashSet<String> = HashSet::new();

    for raw in paths {
        if raw.trim().is_empty() {
            skipped += 1;
            continue;
        }
        // Windows 路径大小写不敏感；按小写归一化只用于同一次操作的重复检测，
        // 实际保存仍使用原始路径。
        let key = raw.to_lowercase();
        if !seen.insert(key) {
            skipped += 1;
            continue;
        }
        if seen.len() > MAX_INTAKE_FILES {
            skipped += 1;
            continue;
        }
        // 同路径提醒不阻止显式粘贴：用户可能就是要再存一份。
        if path_duplicate(db, &raw) {
            duplicates += 1;
        }
        let is_dir = std::fs::metadata(Path::new(&raw))
            .map(|m| m.is_dir())
            .unwrap_or(false);
        let result = if storage_mode == super::MODE_MANAGED && !is_dir {
            add_managed(db, root, &raw, source_kind, group_id)
        } else {
            // 引用模式；文件夹在托管模式下也保存目录引用。
            add_reference(db, root, &raw, source_kind, group_id)
        };
        match result {
            Ok(item) => added.push(item),
            Err(error) => failed.push(failure(&raw, &error)),
        }
    }

    // 全部路径被跳过（空路径/同一批重复/超过上限）时不能返回「无失败也无成功」：
    // 前端需要一条可解释的原因，而不是泛化的「粘贴失败」。
    if added.is_empty() && failed.is_empty() && skipped > 0 {
        failed.push(IntakeFailure {
            target: String::new(),
            reason: "没有可保存的有效路径（空路径、同一批重复或超过单次上限）".into(),
            code: "CLIPBOARD_NO_VALID_ITEMS".into(),
            category: "validation".into(),
        });
    }
    let failure_code = if added.is_empty() && !failed.is_empty() {
        Some(if failed[0].code == "CLIPBOARD_NO_VALID_ITEMS" {
            "CLIPBOARD_NO_VALID_ITEMS"
        } else {
            "SHELF_PASTE_FAILED"
        })
    } else {
        None
    };
    IntakeOutcome {
        content_kind: kind,
        added,
        failed,
        skipped,
        duplicates,
        failure_code,
        retryable: false,
    }
}

/// 同路径已有条目（大小写不敏感）。查询失败按「无重复」处理，绝不阻断粘贴。
fn path_duplicate(db: &Db, raw: &str) -> bool {
    let Ok(normalized) = super::normalize_original_path(raw) else {
        return false;
    };
    let path = normalized.to_string_lossy().to_string();
    db.with_read(|conn| {
        conn.query_row(
            "SELECT COUNT(*) FROM shelf_items WHERE original_path = ?1 COLLATE NOCASE",
            [&path],
            |r| r.get::<_, i64>(0),
        )
        .map_err(crate::error::AppError::from)
    })
    .map(|n| n > 0)
    .unwrap_or(false)
}

/// 同内容条目（文本/链接）。用于提示，不用于去重拦截。
fn content_duplicate(db: &Db, kind: &str, content: &str) -> bool {
    db.with_read(|conn| {
        conn.query_row(
            "SELECT COUNT(*) FROM shelf_items WHERE kind = ?1 AND content = ?2",
            rusqlite::params![kind, content],
            |r| r.get::<_, i64>(0),
        )
        .map_err(crate::error::AppError::from)
    })
    .map(|n| n > 0)
    .unwrap_or(false)
}

fn failure(target: &str, error: &crate::error::AppError) -> IntakeFailure {
    IntakeFailure {
        target: target.to_string(),
        reason: error.to_string(),
        code: error.code().to_string(),
        category: error.category().as_str().to_string(),
    }
}

/// 纯文本优先；纯文本为空时从 HTML 提取可读文本，再退化为首个图片链接。
/// 返回 (可保存文本, 实际内容类型)。
fn resolve_text(text: String, html: Option<&str>) -> (String, &'static str) {
    if !text.trim().is_empty() {
        return (text, "text");
    }
    let Some(html) = html else {
        return (text, "text");
    };
    let extracted = crate::dragdrop::text::extract_html(html);
    if !extracted.text.trim().is_empty() {
        return (extracted.text, "html");
    }
    if let Some(url) = extracted.image_url {
        // 只保存链接，不下载、不冒充为图片字节。
        return (url, "html-link");
    }
    (String::new(), "html")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clipboard::platform::ClipboardRead;

    struct TempRoot(std::path::PathBuf);
    impl TempRoot {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!("td-ingest-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&p).unwrap();
            Self(p)
        }
        fn shelf(&self) -> std::path::PathBuf {
            self.0.join("shelf")
        }
    }
    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn db() -> Db {
        Db::open_in_memory().unwrap()
    }

    fn write(dir: &Path, name: &str, bytes: &[u8]) -> String {
        let p = dir.join(name);
        std::fs::write(&p, bytes).unwrap();
        p.to_string_lossy().to_string()
    }

    fn tiny_png() -> Vec<u8> {
        let rgba = vec![
            200u8, 30, 30, 255, 30, 200, 30, 255, 30, 30, 200, 255, 240, 240, 240, 255,
        ];
        crate::clipboard::image::encode_png(&rgba, 2, 2).unwrap()
    }

    #[test]
    fn maps_files_and_dedupes_same_operation() {
        let tmp = TempRoot::new();
        let db = db();
        let a = write(&tmp.0, "a.txt", b"a");
        let b = write(&tmp.0, "b.png", &tiny_png());
        let out = save(
            &db,
            &tmp.shelf(),
            ClipboardIntake::Files(vec![a.clone(), a, b]),
            super::super::MODE_REFERENCE,
            "clipboard",
            None,
        );
        assert_eq!(out.added.len(), 2);
        assert_eq!(out.skipped, 1);
        assert!(out.failed.is_empty());
        assert_eq!(out.failure_code, None);
        assert_eq!(out.content_kind, "files");
    }

    #[test]
    fn folder_in_managed_mode_is_reference() {
        let tmp = TempRoot::new();
        let db = db();
        let dir = tmp.0.join("folder");
        std::fs::create_dir_all(&dir).unwrap();
        let out = save(
            &db,
            &tmp.shelf(),
            ClipboardIntake::Files(vec![dir.to_string_lossy().to_string()]),
            super::super::MODE_MANAGED,
            "clipboard",
            None,
        );
        assert_eq!(out.added.len(), 1);
        assert_eq!(out.added[0].kind, super::super::KIND_FOLDER);
        assert_eq!(out.added[0].storage_mode, super::super::MODE_REFERENCE);
    }

    #[test]
    fn missing_path_reports_partial_and_keeps_successes() {
        let tmp = TempRoot::new();
        let db = db();
        let ok = write(&tmp.0, "ok.txt", b"ok");
        let missing = tmp.0.join("missing.txt").to_string_lossy().to_string();
        let out = save(
            &db,
            &tmp.shelf(),
            ClipboardIntake::Files(vec![ok, missing.clone()]),
            super::super::MODE_REFERENCE,
            "clipboard",
            None,
        );
        assert_eq!(out.added.len(), 1);
        assert_eq!(out.failed.len(), 1);
        assert_eq!(out.failed[0].target, missing);
        assert_eq!(out.failed[0].code, "NOT_FOUND");
        assert_eq!(out.failure_code, None);
    }

    #[test]
    fn image_is_saved_as_independent_managed_png() {
        let tmp = TempRoot::new();
        let db = db();
        let out = save(
            &db,
            &tmp.shelf(),
            ClipboardIntake::Image {
                png: tiny_png(),
                width: 2,
                height: 2,
            },
            super::super::MODE_REFERENCE,
            "clipboard",
            None,
        );
        assert_eq!(out.added.len(), 1);
        let item = &out.added[0];
        assert_eq!(item.kind, super::super::KIND_IMAGE);
        assert_eq!(item.storage_mode, super::super::MODE_MANAGED);
        assert!(item.original_path.is_none());
        assert!(tmp
            .shelf()
            .join(item.managed_path.as_ref().unwrap())
            .exists());
    }

    #[test]
    fn link_and_html_text_are_saved_without_downloading() {
        let tmp = TempRoot::new();
        let db = db();
        let link = save(
            &db,
            &tmp.shelf(),
            ClipboardIntake::Link("https://example.com/a.png".into()),
            super::super::MODE_REFERENCE,
            "clipboard",
            None,
        );
        assert_eq!(link.added.len(), 1);
        assert_eq!(link.added[0].kind, super::super::KIND_LINK);

        let html = save(
            &db,
            &tmp.shelf(),
            ClipboardIntake::Text {
                text: String::new(),
                html: Some("<p>hello <b>world</b></p>".into()),
            },
            super::super::MODE_REFERENCE,
            "clipboard",
            None,
        );
        assert_eq!(html.added.len(), 1);
        assert_eq!(html.added[0].kind, super::super::KIND_TEXT);
        assert_eq!(html.content_kind, "html");
    }

    #[test]
    fn html_with_only_an_image_url_is_stored_as_link() {
        let tmp = TempRoot::new();
        let db = db();
        let out = save(
            &db,
            &tmp.shelf(),
            ClipboardIntake::Text {
                text: String::new(),
                html: Some(r#"<img src="https://example.com/p.png">"#.into()),
            },
            super::super::MODE_REFERENCE,
            "clipboard",
            None,
        );
        assert_eq!(out.added.len(), 1);
        assert_eq!(out.added[0].kind, super::super::KIND_LINK);
        assert_eq!(out.content_kind, "html-link");
    }

    #[test]
    fn empty_and_busy_reads_are_structured_without_items() {
        let empty = ClipboardIntake::from_read(ClipboardRead::Empty("剪贴板为空"));
        assert!(matches!(
            empty,
            ClipboardIntake::Empty {
                code: "CLIPBOARD_EMPTY",
                ..
            }
        ));
        let busy = ClipboardIntake::from_read(ClipboardRead::Skip("剪贴板被其他程序占用"));
        match busy {
            ClipboardIntake::Empty {
                code, retryable, ..
            } => {
                assert_eq!(code, "CLIPBOARD_BUSY");
                assert!(retryable);
            }
            other => panic!("unexpected {other:?}"),
        }
        match ClipboardIntake::from_read(ClipboardRead::Empty(
            "剪贴板只包含虚拟文件格式，暂时无法直接暂存",
        )) {
            ClipboardIntake::Empty { code, .. } => assert_eq!(code, "CLIPBOARD_UNSUPPORTED"),
            other => panic!("unexpected {other:?}"),
        }
        // 超限文本走 Skip 而不是 Empty，必须仍映射为「内容过大」。
        match ClipboardIntake::from_read(ClipboardRead::Skip("文本超过采集上限")) {
            ClipboardIntake::Empty { code, .. } => {
                assert_eq!(code, "CLIPBOARD_CONTENT_TOO_LARGE")
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn all_paths_skipped_returns_explainable_failure() {
        let tmp = TempRoot::new();
        let db = db();
        let out = save(
            &db,
            &tmp.shelf(),
            ClipboardIntake::Files(vec![String::new(), "  ".into()]),
            super::super::MODE_REFERENCE,
            "clipboard",
            None,
        );
        assert!(out.added.is_empty());
        assert_eq!(out.skipped, 2);
        assert_eq!(out.failed.len(), 1);
        assert_eq!(out.failed[0].code, "CLIPBOARD_NO_VALID_ITEMS");
        assert_eq!(out.failure_code, Some("CLIPBOARD_NO_VALID_ITEMS"));
    }

    #[test]
    fn repeated_paste_is_allowed_but_reports_duplicate() {
        let tmp = TempRoot::new();
        let db = db();
        let file = write(&tmp.0, "same.txt", b"same");
        let first = save(
            &db,
            &tmp.shelf(),
            ClipboardIntake::Files(vec![file.clone()]),
            super::super::MODE_REFERENCE,
            "clipboard",
            None,
        );
        assert_eq!(first.added.len(), 1);
        assert_eq!(first.duplicates, 0);
        let second = save(
            &db,
            &tmp.shelf(),
            ClipboardIntake::Files(vec![file]),
            super::super::MODE_REFERENCE,
            "clipboard",
            None,
        );
        // 显式重复粘贴不阻止，只提示；两条记录都存在。
        assert_eq!(second.added.len(), 1);
        assert_eq!(second.duplicates, 1);

        let text_first = save(
            &db,
            &tmp.shelf(),
            ClipboardIntake::Text {
                text: "同一段错误".into(),
                html: None,
            },
            super::super::MODE_REFERENCE,
            "clipboard",
            None,
        );
        assert_eq!(text_first.duplicates, 0);
        let text_second = save(
            &db,
            &tmp.shelf(),
            ClipboardIntake::Text {
                text: "同一段错误".into(),
                html: None,
            },
            super::super::MODE_REFERENCE,
            "clipboard",
            None,
        );
        assert_eq!(text_second.added.len(), 1);
        assert_eq!(text_second.duplicates, 1);
    }

    fn captured(
        kind: &str,
        text: &str,
        html: &str,
        files: Vec<String>,
        image: Option<crate::clipboard::CapturedImage>,
    ) -> ClipboardRead {
        ClipboardRead::Content {
            sequence: 1,
            content: Box::new(crate::clipboard::CapturedContent {
                kind: kind.into(),
                text: text.into(),
                html: html.into(),
                preview: String::new(),
                file_paths: files,
                image,
                source_app: "test".into(),
                source_title: String::new(),
                source_kind: "owner".into(),
                byte_size: 0,
            }),
        }
    }

    #[test]
    fn read_mapping_preserves_each_supported_kind() {
        let files = vec!["C:/a.txt".to_string(), "C:/b.png".to_string()];
        assert_eq!(
            ClipboardIntake::from_read(captured(
                crate::clipboard::KIND_FILES,
                "",
                "",
                files.clone(),
                None
            )),
            ClipboardIntake::Files(files)
        );

        let img = ClipboardIntake::from_read(captured(
            crate::clipboard::KIND_IMAGE,
            "",
            "",
            Vec::new(),
            Some(crate::clipboard::CapturedImage {
                png: vec![1, 2, 3],
                width: 640,
                height: 480,
                rgba: Vec::new(),
            }),
        ));
        assert!(matches!(
            img,
            ClipboardIntake::Image {
                png,
                width: 640,
                height: 480
            } if png == vec![1, 2, 3]
        ));

        assert_eq!(
            ClipboardIntake::from_read(captured(
                crate::clipboard::KIND_URL,
                " https://example.com/x ",
                "",
                Vec::new(),
                None
            )),
            ClipboardIntake::Link("https://example.com/x".into())
        );
        assert_eq!(
            ClipboardIntake::from_read(captured(
                crate::clipboard::KIND_TEXT,
                "code\nline2",
                "",
                Vec::new(),
                None
            )),
            ClipboardIntake::Text {
                text: "code\nline2".into(),
                html: None
            }
        );
        assert_eq!(
            ClipboardIntake::from_read(captured(
                crate::clipboard::KIND_HTML,
                "plain",
                "<b>plain</b>",
                Vec::new(),
                None
            )),
            ClipboardIntake::Text {
                text: "plain".into(),
                html: Some("<b>plain</b>".into())
            }
        );
        assert!(matches!(
            ClipboardIntake::from_read(captured("unknown", "", "", Vec::new(), None)),
            ClipboardIntake::Empty {
                code: "CLIPBOARD_UNSUPPORTED",
                ..
            }
        ));
    }
}
