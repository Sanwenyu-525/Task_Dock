//! 外部拖入数据的**分类阶梯**（纯函数，可在无 COM 环境下完整单测）。
//!
//! 输入是「系统提供了哪些格式 + 少量已采样内容」，输出是唯一一个可投递类型。
//! 这里集中了本任务最重要的一条经验：**候选格式不等于该读的格式**。
//!
//! 真实第三方应用会顺手塞很多「旁路格式」：
//! - 资源管理器拖文件时同时给 `CF_UNICODETEXT`（内容是文件路径文本）；
//! - 浏览器拖任何东西都会带一份 `CF_DIB`（那是**跟随光标的拖拽预览图**，
//!   不是用户要的原图）；同时给 `text/html` / `text/uri-list`；
//! - Outlook 拖附件给 `FileGroupDescriptorW` + `FileContents`。
//!
//! 因此优先级不是按「格式是否高级」排，而是按**证据强度**排：
//! 真实路径 > 虚拟文件 > 命名图片字节 > URL/HTML > 纯文本 > DIB（最后兜底）。
//! 顺序有单测钉住，改顺序必须先改用例。

use crate::dragdrop::payload::{DragPayloadView, MixedPart, PayloadItemView};
use crate::dragdrop::text::{extract_html, looks_like_image_url, normalize_text, preview, single_url_in_text};
use crate::dragdrop::{codes, MAX_TEXT_BYTES};

/// 图片字节的来源格式（决定后续怎么转 PNG）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageSource {
    /// 已注册的 `PNG` / `image/png` 命名格式：本身就是完整 PNG 字节。
    Png,
    /// `CF_DIB` / `CF_DIBV5`：需要按 BITMAPINFOHEADER 解析后重新编码 PNG。
    Dib,
}

/// 分类结论。**不含字节**，只描述类型与必要的元信息。
#[derive(Debug, Clone, PartialEq)]
pub enum Classification {
    /// 真实本地路径（文件或文件夹），沿用既有引用/托管语义。
    LocalFiles { paths: Vec<String> },
    /// OLE 虚拟文件描述符，条数已知，内容稍后从流里读。
    VirtualFiles { count: usize },
    Image(ImageSource),
    Url { url: String, is_image: bool },
    Html { text: String, image_url: Option<String> },
    Text(String),
    /// 同一拖放确实包含多种可投递类型（例如「本地文件 + 虚拟文件」）。
    Mixed {
        local_paths: Vec<String>,
        virtual_count: usize,
    },
    Unsupported { reason: String, code: &'static str },
}

impl Classification {
    /// 转成前端视图（图片/虚拟文件的条目名在暂存完成后才确定，
    /// 这里只给「会有什么」，用于 enter/over 与失败提示）。
    pub fn to_probe_view(&self) -> DragPayloadView {
        match self {
            Classification::LocalFiles { paths } => DragPayloadView::LocalFiles {
                paths: paths.clone(),
                count: paths.len(),
            },
            Classification::VirtualFiles { count } => DragPayloadView::VirtualFiles {
                items: Vec::new(),
                count: *count,
            },
            Classification::Image(_) => DragPayloadView::Image {
                items: Vec::new(),
                count: 1,
            },
            Classification::Url { url, is_image } => DragPayloadView::Url {
                url: url.clone(),
                is_image: *is_image,
            },
            Classification::Html { text, image_url } => DragPayloadView::Html {
                text_preview: preview(text, 120),
                had_image: image_url.is_some(),
                image_url: image_url.clone(),
            },
            Classification::Text(text) => DragPayloadView::Text {
                text_preview: preview(text, 120),
                chars: text.chars().count(),
            },
            Classification::Mixed {
                local_paths,
                virtual_count,
            } => DragPayloadView::Mixed {
                parts: vec![
                    MixedPart {
                        kind: "local-files".into(),
                        count: local_paths.len(),
                        label: format!("{} 个本地文件", local_paths.len()),
                    },
                    MixedPart {
                        kind: "virtual-files".into(),
                        count: *virtual_count,
                        label: format!("{virtual_count} 个虚拟文件"),
                    },
                ],
            },
            Classification::Unsupported { reason, code } => DragPayloadView::Unsupported {
                formats: Vec::new(),
                reason: reason.clone(),
                code: (*code).to_string(),
            },
        }
    }
}

/// 系统侧观测到的原始事实（全部已在 `windows_ole` 里做有界采样）。
#[derive(Debug, Clone, Default)]
pub struct DragFacts {
    /// 系统报告的格式名（原样，仅用于诊断；最多保留前若干个）。
    pub formats: Vec<String>,
    /// `CF_HDROP` 解析出的路径（可能为空）。
    pub hdrop_paths: Vec<String>,
    /// `FileGroupDescriptorW/A` 中的描述符数量。
    pub file_descriptor_count: usize,
    /// 是否提供 `PNG` / `image/png` 这类**完整图片字节**格式。
    pub has_png_bytes: bool,
    /// 是否提供 `CF_DIB` / `CF_DIBV5`（可能只是拖拽预览图）。
    pub has_dib: bool,
    /// `CF_UNICODETEXT` 的内容（已截断到上限）。
    pub text: Option<String>,
    /// `HTML Format` 的内容（已截断到上限）。
    pub html: Option<String>,
    /// `text/uri-list` 或 `UniformResourceLocator(W)` 的内容。
    pub url: Option<String>,
}

/// 从 `text/uri-list` 里取第一个非注释、http(s) 的行。
fn first_uri_from_list(raw: &str) -> Option<String> {
    raw.lines()
        .map(|l| l.trim())
        .find(|l| !l.is_empty() && !l.starts_with('#'))
        .and_then(crate::dragdrop::text::normalize_http_url)
}

/// 主分类阶梯（顺序即语义，见模块注释）。
pub fn classify(facts: &DragFacts) -> Classification {
    let formats = || facts.formats.clone();

    // 1) 真实路径：证据最强，且必须压制同批的文本/URL 旁路格式
    //    （资源管理器拖文件时 `CF_UNICODETEXT` 就是路径文本，绝不能变成文本条目）。
    let has_local = !facts.hdrop_paths.is_empty();
    if has_local && facts.file_descriptor_count == 0 {
        return Classification::LocalFiles {
            paths: facts.hdrop_paths.clone(),
        };
    }
    // 2) 本地文件 + 虚拟文件同批出现：明确交给用户决定，不擅自二选一。
    if has_local && facts.file_descriptor_count > 0 {
        return Classification::Mixed {
            local_paths: facts.hdrop_paths.clone(),
            virtual_count: facts.file_descriptor_count,
        };
    }
    // 3) 虚拟文件（邮件附件、Outlook 等）。
    if facts.file_descriptor_count > 0 {
        return Classification::VirtualFiles {
            count: facts.file_descriptor_count,
        };
    }
    // 4) 命名图片格式 = 真正的图片字节。
    if facts.has_png_bytes {
        return Classification::Image(ImageSource::Png);
    }
    // 5) URL：uri-list / UniformResourceLocator / 单行 URL 文本 / HTML 里的图片地址。
    let url_candidate = facts
        .url
        .as_deref()
        .and_then(first_uri_from_list)
        .or_else(|| {
            facts
                .url
                .as_deref()
                .and_then(crate::dragdrop::text::normalize_http_url)
        })
        .or_else(|| facts.text.as_deref().and_then(single_url_in_text));
    if let Some(url) = url_candidate {
        return Classification::Url {
            is_image: looks_like_image_url(&url),
            url,
        };
    }
    // 6) HTML 富文本：只提取纯文本 + 首个图片地址。
    if let Some(raw) = facts.html.as_deref() {
        let extract = extract_html(raw);
        if !extract.text.trim().is_empty() || extract.image_url.is_some() {
            // HTML 里只有图片地址、没有正文：当成「图片链接」而不是空文本。
            if extract.text.trim().is_empty() {
                if let Some(url) = extract.image_url.clone() {
                    return Classification::Url {
                        is_image: true,
                        url,
                    };
                }
            }
            return Classification::Html {
                text: extract.text,
                image_url: extract.image_url,
            };
        }
    }
    // 7) 纯文本：长度上限与暂存架 `MAX_TEXT_BYTES` 对齐。
    if let Some(raw) = facts.text.as_deref() {
        let normalized = normalize_text(raw);
        if !normalized.trim().is_empty() {
            if normalized.len() > MAX_TEXT_BYTES {
                return Classification::Unsupported {
                    reason: "文本超过单条上限，请改用文件方式拖入".into(),
                    code: codes::DRAG_SIZE_LIMIT_EXCEEDED,
                };
            }
            return Classification::Text(normalized);
        }
    }
    // 8) DIB 兜底：没有其它任何内容时才当作图片（否则多半是拖拽预览图）。
    if facts.has_dib {
        return Classification::Image(ImageSource::Dib);
    }
    // 9) 明确不支持。
    if facts.formats.is_empty() {
        return Classification::Unsupported {
            reason: codes::message(codes::DRAG_NO_READABLE_CONTENT).into(),
            code: codes::DRAG_NO_READABLE_CONTENT,
        };
    }
    let _ = formats();
    Classification::Unsupported {
        reason: format!(
            "来源提供了 {} 种格式（{}），但都不是可读取的内容类型",
            facts.formats.len(),
            facts.formats.iter().take(3).cloned().collect::<Vec<_>>().join("、")
        ),
        code: codes::DRAG_FORMAT_UNSUPPORTED,
    }
}

/// 把分类结果补全成前端视图（暂存完成后由 `commit`/`windows_ole` 调用）。
pub fn view_with_items(base: DragPayloadView, items: Vec<PayloadItemView>) -> DragPayloadView {
    match base {
        DragPayloadView::VirtualFiles { .. } => DragPayloadView::VirtualFiles {
            count: items.len(),
            items,
        },
        DragPayloadView::Image { .. } => DragPayloadView::Image {
            count: items.len(),
            items,
        },
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts() -> DragFacts {
        DragFacts::default()
    }

    #[test]
    fn 资源管理器拖文件时压制路径文本旁路() {
        // 真实场景：CF_HDROP + CF_UNICODETEXT(路径) + FileNameW
        let f = DragFacts {
            formats: vec!["CF_HDROP".into(), "CF_UNICODETEXT".into(), "FileNameW".into()],
            hdrop_paths: vec!["C:\\a\\报表.pdf".into()],
            text: Some("C:\\a\\报表.pdf".into()),
            ..facts()
        };
        match classify(&f) {
            Classification::LocalFiles { paths } => assert_eq!(paths.len(), 1),
            other => panic!("应识别为本地文件，实际 {other:?}"),
        }
    }

    #[test]
    fn 浏览器图片拖拽按_HTML_而不是拖拽预览_DIB() {
        // 真实场景：text/html + text/uri-list + CF_DIB(预览图)。DIB 不得抢占。
        let f = DragFacts {
            formats: vec!["HTML Format".into(), "text/uri-list".into(), "CF_DIB".into()],
            html: Some(r#"<img src="https://cdn.example/cat.png" width="120">"#.into()),
            url: Some("https://cdn.example/cat.png".into()),
            has_dib: true,
            ..facts()
        };
        match classify(&f) {
            // uri-list 先命中：图片地址，明确标成 is_image
            Classification::Url { url, is_image } => {
                assert_eq!(url, "https://cdn.example/cat.png");
                assert!(is_image);
            }
            other => panic!("应识别为图片链接，实际 {other:?}"),
        }
    }

    #[test]
    fn 只有_HTML_没有正文但有图片时按图片链接() {
        let f = DragFacts {
            formats: vec!["HTML Format".into(), "CF_DIB".into()],
            html: Some(r#"<p>  </p><img src="https://x.example/i.jpg">"#.into()),
            has_dib: true,
            ..facts()
        };
        match classify(&f) {
            Classification::Url { url, is_image } => {
                assert!(is_image);
                assert_eq!(url, "https://x.example/i.jpg");
            }
            other => panic!("实际 {other:?}"),
        }
    }

    #[test]
    fn blob_地址不被当成可读图片() {
        let f = DragFacts {
            formats: vec!["HTML Format".into(), "text/uri-list".into()],
            html: Some(r#"<img src="blob:https://chat.example/9f1">"#.into()),
            url: Some("blob:https://chat.example/9f1".into()),
            ..facts()
        };
        // 没有任何 http(s) 来源 → 不能冒充「已拿到图片」
        match classify(&f) {
            Classification::Unsupported { code, .. } => {
                assert_eq!(code, codes::DRAG_FORMAT_UNSUPPORTED);
            }
            other => panic!("blob 地址不得被当作图片或链接，实际 {other:?}"),
        }
    }

    #[test]
    fn 邮件附件走虚拟文件而不是文本() {
        let f = DragFacts {
            formats: vec!["FileGroupDescriptorW".into(), "FileContents".into()],
            file_descriptor_count: 2,
            text: Some("附件".into()),
            ..facts()
        };
        assert_eq!(classify(&f), Classification::VirtualFiles { count: 2 });
    }

    #[test]
    fn 本地文件与虚拟文件同批时给出混合() {
        let f = DragFacts {
            formats: vec!["CF_HDROP".into(), "FileGroupDescriptorW".into()],
            hdrop_paths: vec!["C:\\a\\b.txt".into()],
            file_descriptor_count: 1,
            ..facts()
        };
        match classify(&f) {
            Classification::Mixed {
                local_paths,
                virtual_count,
            } => {
                assert_eq!(local_paths.len(), 1);
                assert_eq!(virtual_count, 1);
            }
            other => panic!("实际 {other:?}"),
        }
    }

    #[test]
    fn 命名_PNG_格式才是图片字节() {
        let f = DragFacts {
            formats: vec!["PNG".into()],
            has_png_bytes: true,
            ..facts()
        };
        assert_eq!(classify(&f), Classification::Image(ImageSource::Png));
    }

    #[test]
    fn 只有_DIB_的截图工具仍能识别为图片() {
        let f = DragFacts {
            formats: vec!["CF_DIB".into()],
            has_dib: true,
            ..facts()
        };
        assert_eq!(classify(&f), Classification::Image(ImageSource::Dib));
    }

    #[test]
    fn 纯文本代码片段走文本() {
        let f = DragFacts {
            formats: vec!["CF_UNICODETEXT".into()],
            text: Some("fn main() {\n    println!(\"hi\");\n}".into()),
            ..facts()
        };
        match classify(&f) {
            Classification::Text(t) => assert!(t.starts_with("fn main()")),
            other => panic!("实际 {other:?}"),
        }
    }

    #[test]
    fn 单行链接文本识别为链接() {
        let f = DragFacts {
            formats: vec!["CF_UNICODETEXT".into()],
            text: Some(" https://example.com/path ".into()),
            ..facts()
        };
        match classify(&f) {
            Classification::Url { url, is_image } => {
                assert_eq!(url, "https://example.com/path");
                assert!(!is_image);
            }
            other => panic!("实际 {other:?}"),
        }
    }

    #[test]
    fn 空格式与空白文本明确不支持() {
        let empty = classify(&facts());
        match empty {
            Classification::Unsupported { code, .. } => {
                assert_eq!(code, codes::DRAG_NO_READABLE_CONTENT)
            }
            other => panic!("实际 {other:?}"),
        }
        let blank = DragFacts {
            formats: vec!["私有格式".into()],
            text: Some("   \n\t ".into()),
            ..facts()
        };
        match classify(&blank) {
            Classification::Unsupported { code, .. } => {
                assert_eq!(code, codes::DRAG_FORMAT_UNSUPPORTED)
            }
            other => panic!("实际 {other:?}"),
        }
    }

    #[test]
    fn 超长文本被拒绝而不是截断入库() {
        let f = DragFacts {
            formats: vec!["CF_UNICODETEXT".into()],
            text: Some("x".repeat(MAX_TEXT_BYTES + 1)),
            ..facts()
        };
        match classify(&f) {
            Classification::Unsupported { code, .. } => {
                assert_eq!(code, codes::DRAG_SIZE_LIMIT_EXCEEDED)
            }
            other => panic!("实际 {other:?}"),
        }
    }

    #[test]
    fn 探测视图的目录投递能力符合语义() {
        let views = [
            Classification::LocalFiles {
                paths: vec!["C:\\a".into()],
            }
            .to_probe_view(),
            Classification::VirtualFiles { count: 1 }.to_probe_view(),
            Classification::Image(ImageSource::Png).to_probe_view(),
            Classification::Text("abc".into()).to_probe_view(),
            Classification::Url {
                url: "https://a".into(),
                is_image: false,
            }
            .to_probe_view(),
            Classification::Html {
                text: "abc".into(),
                image_url: None,
            }
            .to_probe_view(),
        ];
        assert!(views[0].can_drop_to_directory());
        assert!(views[1].can_drop_to_directory());
        assert!(views[2].can_drop_to_directory());
        // 文本/链接/HTML 不得隐式变成文件
        assert!(!views[3].can_drop_to_directory());
        assert!(!views[4].can_drop_to_directory());
        assert!(!views[5].can_drop_to_directory());
        for v in &views {
            assert!(v.can_stage(), "{:?} 应可进暂存架", v.kind());
        }
    }
}
