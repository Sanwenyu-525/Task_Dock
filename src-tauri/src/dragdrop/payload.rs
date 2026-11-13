//! 拖入载荷的**对外视图**：前端只拿得到这些字段。
//!
//! 设计约束：
//! - 判别式显式（`kind`），每种来源一个变体，前端用 TS 联合类型窄化；
//! - 只带**有界预览**（文本前 N 字符、条数、字节数），绝不把整段文本、
//!   图片字节或后端暂存路径塞进 IPC；
//! - `local-files` 保留原始路径：它是既有 `shelf_add_paths` /
//!   `shelf_drop_to_directory` 的入参，旧行为必须逐字不变。

use serde::Serialize;

use crate::dragdrop::{codes, StagedItem, StagedKind};

/// 载荷里单条可投递项目（虚拟文件 / 图片）。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PayloadItemView {
    pub name: String,
    pub size: u64,
    /// `virtual-file` | `image`
    pub item_kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
}

/// 失败明细：稳定错误码 + 触发它的格式名（格式名来自系统，本身不含内容）。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PayloadFailure {
    pub code: String,
    /// `virtual-file` | `image` | `format`
    pub scope: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
    /// 已脱敏的人读原因（不含路径、不含正文）。
    pub reason: String,
}

/// 混合载荷的一支（只用于「同一个拖放里确实有多种可投递类型」）。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MixedPart {
    pub kind: String,
    pub count: usize,
    /// 前端可直接展示的短标签，例如「2 个虚拟文件」。
    pub label: String,
}

/// 拖入载荷的前端视图。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum DragPayloadView {
    /// 真实本地文件/文件夹（可含目录）。`paths` 是唯一会进入文件操作的类型。
    LocalFiles {
        paths: Vec<String>,
        count: usize,
    },
    /// Windows OLE 虚拟文件（邮件附件等），已流式落成暂存副本。
    VirtualFiles {
        items: Vec<PayloadItemView>,
        count: usize,
    },
    /// 图片字节（PNG / DIB），已落成 PNG 暂存副本。
    Image {
        items: Vec<PayloadItemView>,
        count: usize,
    },
    /// 网页链接；`isImage` 表示「看起来是图片地址」，仅用于提示，
    /// **不代表已下载图片**。
    Url {
        url: String,
        is_image: bool,
    },
    /// 网页富文本：只保留安全提取后的纯文本与可能的图片地址。
    Html {
        text_preview: String,
        had_image: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        image_url: Option<String>,
    },
    /// 纯文本（选中文本、代码片段、Markdown）。
    Text {
        text_preview: String,
        chars: usize,
    },
    /// 同一拖放里同时有多种可投递内容，需要用户/落点决定怎么处理。
    Mixed {
        parts: Vec<MixedPart>,
    },
    /// 明确不支持：带错误码，前台必须如实拒绝，不得静默丢弃。
    Unsupported {
        formats: Vec<String>,
        reason: String,
        code: String,
    },
}

impl DragPayloadView {
    /// 判别式字符串，与 TS 侧 `payload.kind` 一一对应。
    pub fn kind(&self) -> &'static str {
        match self {
            DragPayloadView::LocalFiles { .. } => "local-files",
            DragPayloadView::VirtualFiles { .. } => "virtual-files",
            DragPayloadView::Image { .. } => "image",
            DragPayloadView::Url { .. } => "url",
            DragPayloadView::Html { .. } => "html",
            DragPayloadView::Text { .. } => "text",
            DragPayloadView::Mixed { .. } => "mixed",
            DragPayloadView::Unsupported { .. } => "unsupported",
        }
    }

    pub fn count(&self) -> usize {
        match self {
            DragPayloadView::LocalFiles { count, .. }
            | DragPayloadView::VirtualFiles { count, .. }
            | DragPayloadView::Image { count, .. } => *count,
            DragPayloadView::Mixed { parts } => parts.iter().map(|p| p.count).sum(),
            DragPayloadView::Url { .. }
            | DragPayloadView::Html { .. }
            | DragPayloadView::Text { .. }
            | DragPayloadView::Unsupported { .. } => 1,
        }
    }

    /// 能否直接投递到真实目录。
    ///
    /// 只有「会变成真实文件」的类型可以：本地路径、虚拟文件、图片字节。
    /// 网页链接 / 文本 / HTML **默认不生成文件**（不做隐式转换），
    /// 目录卡片必须据此拒绝，而不是先承诺成功再悄悄落一个 .txt。
    pub fn can_drop_to_directory(&self) -> bool {
        match self {
            DragPayloadView::LocalFiles { .. }
            | DragPayloadView::VirtualFiles { .. }
            | DragPayloadView::Image { .. } => true,
            DragPayloadView::Mixed { parts } => parts.iter().any(|p| {
                matches!(p.kind.as_str(), "local-files" | "virtual-files" | "image")
            }),
            _ => false,
        }
    }

    /// 能否进入暂存架（全部可识别类型都可以：文本/链接本身就是条目）。
    pub fn can_stage(&self) -> bool {
        !matches!(self, DragPayloadView::Unsupported { .. })
    }
}

/// 拖入过程中的**类型探测**：`enter`/`over` 阶段只做分类，不读大块数据。
///
/// 字段刻意保持精简：高频事件不能携带格式全表或内容。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DragProbe {
    /// 与 `DragPayloadView::kind()` 同值；无法识别时为 `unsupported`。
    pub kind: String,
    /// 可投递条目数（本地文件为路径数，虚拟文件为描述符数，图片计 1）。
    pub count: usize,
    pub can_shelf: bool,
    pub can_directory: bool,
    /// 系统实际提供的格式名（**只有名字**，不含内容）；最多 8 项，
    /// 用于诊断「来源到底给了什么」，也是不支持时的唯一线索。
    pub formats: Vec<String>,
}

impl DragProbe {
    pub fn from_view(view: &DragPayloadView, formats: Vec<String>) -> Self {
        let mut formats = formats;
        formats.truncate(8);
        Self {
            kind: view.kind().to_string(),
            count: view.count(),
            can_shelf: view.can_stage(),
            can_directory: view.can_drop_to_directory(),
            formats,
        }
    }

    /// 未收到任何可读内容时的探测结果（cursor 必须是「禁止」）。
    pub fn nothing(formats: Vec<String>) -> Self {
        let mut formats = formats;
        formats.truncate(8);
        Self {
            kind: "unsupported".into(),
            count: 0,
            can_shelf: false,
            can_directory: false,
            formats,
        }
    }
}

/// 暂存完成后，用**真实条目**补全分类阶段给出的视图。
///
/// 纯函数：不碰磁盘、不碰 COM，因此可以完整单测。规则：
/// - `local-files` 用真实路径列表重算（Drop 时已填，这里只对齐计数）；
/// - `virtual-files` / `image` 用真实条目替换；一条都没落成时**不得**
///   报「0 个」成功，而是退化为 `unsupported` 并带上失败码；
/// - `mixed` 按真实条目重算两支；
/// - 其余（url/html/text）本来就是单条，原样返回。
pub fn finalize_view(
    base: &DragPayloadView,
    items: &[StagedItem],
    failures: &[PayloadFailure],
) -> DragPayloadView {
    let staged: Vec<PayloadItemView> = items
        .iter()
        .filter_map(|item| match item {
            StagedItem::Staged {
                name,
                size,
                kind,
                mime,
                width,
                height,
                ..
            } => Some(PayloadItemView {
                name: name.clone(),
                size: *size,
                item_kind: kind.as_str().to_string(),
                mime: mime.clone(),
                width: *width,
                height: *height,
            }),
            _ => None,
        })
        .collect();

    let unsupported = || {
        let code = failures
            .first()
            .map(|f| f.code.clone())
            .unwrap_or_else(|| codes::DRAG_NO_READABLE_CONTENT.to_string());
        let reason = failures
            .first()
            .map(|f| f.reason.clone())
            .unwrap_or_else(|| codes::message(codes::DRAG_NO_READABLE_CONTENT).into());
        DragPayloadView::Unsupported {
            formats: base
                .formats_of()
                .unwrap_or_default(),
            reason,
            code,
        }
    };

    match base {
        DragPayloadView::LocalFiles { .. } => {
            let paths: Vec<String> = items
                .iter()
                .filter_map(|i| match i {
                    StagedItem::LocalPath { path } => Some(path.clone()),
                    _ => None,
                })
                .collect();
            DragPayloadView::LocalFiles {
                count: paths.len(),
                paths,
            }
        }
        DragPayloadView::VirtualFiles { .. } => {
            if staged.is_empty() {
                unsupported()
            } else {
                DragPayloadView::VirtualFiles {
                    count: staged.len(),
                    items: staged,
                }
            }
        }
        DragPayloadView::Image { .. } => {
            if staged.is_empty() {
                unsupported()
            } else {
                DragPayloadView::Image {
                    count: staged.len(),
                    items: staged,
                }
            }
        }
        DragPayloadView::Mixed { .. } => {
            let local = items
                .iter()
                .filter(|i| matches!(i, StagedItem::LocalPath { .. }))
                .count();
            let virtual_files = staged
                .iter()
                .filter(|i| i.item_kind == StagedKind::VirtualFile.as_str())
                .count();
            let images = staged
                .iter()
                .filter(|i| i.item_kind == StagedKind::Image.as_str())
                .count();
            let mut parts = Vec::new();
            if local > 0 {
                parts.push(MixedPart {
                    kind: "local-files".into(),
                    count: local,
                    label: format!("{local} 个本地文件"),
                });
            }
            if virtual_files > 0 {
                parts.push(MixedPart {
                    kind: "virtual-files".into(),
                    count: virtual_files,
                    label: format!("{virtual_files} 个虚拟文件"),
                });
            }
            if images > 0 {
                parts.push(MixedPart {
                    kind: "image".into(),
                    count: images,
                    label: format!("{images} 张图片"),
                });
            }
            if parts.is_empty() {
                unsupported()
            } else {
                DragPayloadView::Mixed { parts }
            }
        }
        other => other.clone(),
    }
}

impl DragPayloadView {
    /// 视图里携带的原始格式名（只有不支持变体保存了它）。
    pub fn formats_of(&self) -> Option<Vec<String>> {
        match self {
            DragPayloadView::Unsupported { formats, .. } => Some(formats.clone()),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dragdrop::StagedKind;
    use std::path::PathBuf;

    fn staged(name: &str, kind: StagedKind, size: u64) -> StagedItem {
        StagedItem::Staged {
            path: PathBuf::from(format!("C:\\tmp\\{name}")),
            name: name.to_string(),
            size,
            kind,
            mime: None,
            width: None,
            height: None,
        }
    }

    #[test]
    fn 本地文件视图只带路径与计数() {
        let base = DragPayloadView::LocalFiles {
            paths: vec![],
            count: 0,
        };
        let items = vec![
            StagedItem::LocalPath {
                path: "C:\\a.txt".into(),
            },
            StagedItem::LocalPath {
                path: "C:\\b.txt".into(),
            },
        ];
        let got = finalize_view(&base, &items, &[]);
        match got {
            DragPayloadView::LocalFiles { paths, count } => {
                assert_eq!(count, 2);
                assert_eq!(paths.len(), 2);
            }
            other => panic!("实际 {other:?}"),
        }
    }

    #[test]
    fn 虚拟文件用真实条目补全() {
        let base = DragPayloadView::VirtualFiles {
            items: vec![],
            count: 2,
        };
        let items = vec![
            staged("a.pdf", StagedKind::VirtualFile, 10),
            staged("b.docx", StagedKind::VirtualFile, 20),
        ];
        match finalize_view(&base, &items, &[]) {
            DragPayloadView::VirtualFiles { items, count } => {
                assert_eq!(count, 2);
                assert_eq!(items[0].name, "a.pdf");
                assert_eq!(items[1].item_kind, "virtual-file");
            }
            other => panic!("实际 {other:?}"),
        }
    }

    #[test]
    fn 图片全部失败时不得报成功() {
        let base = DragPayloadView::Image {
            items: vec![],
            count: 1,
        };
        let failures = vec![PayloadFailure {
            code: codes::DRAG_IMAGE_DECODE_FAILED.into(),
            scope: "image".into(),
            format: Some("CF_DIB".into()),
            reason: "无法解码".into(),
        }];
        match finalize_view(&base, &[], &failures) {
            DragPayloadView::Unsupported { code, reason, .. } => {
                assert_eq!(code, codes::DRAG_IMAGE_DECODE_FAILED);
                assert_eq!(reason, "无法解码");
            }
            other => panic!("实际 {other:?}"),
        }
    }

    #[test]
    fn 混合视图按真实条目重算() {
        let base = DragPayloadView::Mixed {
            parts: vec![MixedPart {
                kind: "virtual-files".into(),
                count: 9,
                label: "9".into(),
            }],
        };
        let items = vec![
            StagedItem::LocalPath {
                path: "C:\\a".into(),
            },
            staged("x.pdf", StagedKind::VirtualFile, 5),
            staged("y.png", StagedKind::Image, 6),
        ];
        match finalize_view(&base, &items, &[]) {
            DragPayloadView::Mixed { parts } => {
                let total: usize = parts.iter().map(|p| p.count).sum();
                assert_eq!(total, 3);
                assert!(parts.iter().any(|p| p.kind == "image"));
            }
            other => panic!("实际 {other:?}"),
        }
    }

    #[test]
    fn 文本与链接视图原样保留() {
        let text = DragPayloadView::Text {
            text_preview: "abc".into(),
            chars: 3,
        };
        assert_eq!(finalize_view(&text, &[], &[]), text);
        let url = DragPayloadView::Url {
            url: "https://a.b".into(),
            is_image: true,
        };
        assert_eq!(finalize_view(&url, &[], &[]), url);
    }

    #[test]
    fn 目录投递能力语义() {
        assert!(DragPayloadView::LocalFiles {
            paths: vec![],
            count: 0
        }
        .can_drop_to_directory());
        assert!(!DragPayloadView::Text {
            text_preview: String::new(),
            chars: 0
        }
        .can_drop_to_directory());
    }

    #[test]
    fn 不支持视图不可暂存() {
        let v = DragPayloadView::Unsupported {
            formats: vec!["私有格式".into()],
            reason: "x".into(),
            code: codes::DRAG_FORMAT_UNSUPPORTED.into(),
        };
        assert!(!v.can_stage());
        assert!(!v.can_drop_to_directory());
    }
}
