//! 剪贴板 → Agent 桥接：能力探测 + 本地导出包。
//!
//! 本模块只做两件事：
//! 1. 列出可用的 Agent 目标及其「窗口可唤醒」证据（复用导航层的动态探测）；
//! 2. 把文本/图片/有序分组/任务上下文转换成结构化本地文件，供用户**手动**附加给 Agent。
//!
//! 绝不自动上传、绝不自动发送：导出目录写完即返回路径，是否交给 Agent 由用户决定。

use std::path::Path;

use serde::Serialize;

use super::store;
use super::{ClipboardItem, KIND_FILES, KIND_HTML, KIND_IMAGE, KIND_URL};
use crate::db::Db;
use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Serialize)]
pub struct AgentCapability {
    pub supported: bool,
    /// verified-interface / window-present / local-export / unsupported-interface / unverified
    pub evidence: String,
    pub note: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentClipboardTarget {
    pub source_id: String,
    pub display_name: String,
    pub installed: bool,
    /// 当前是否已有可交互窗口（能力探测证据）
    pub window_present: bool,
    /// exe-found / window-present / not-installed
    pub evidence: String,
    pub note: String,
    /// 经过验证、且不绕过权限的结构化发送接口
    pub direct_send: AgentCapability,
    /// 官方文件导入接口
    pub file_import: AgentCapability,
    /// 由用户手动选择窗口后逐项粘贴（SendInput；接收情况无法验证）
    pub desktop_paste: AgentCapability,
    /// 本地导出包（始终可用，不自动上传）
    pub export: AgentCapability,
    /// direct / import / paste / export / none
    pub recommended: String,
}

/// 能力矩阵只依据可核验事实：当前没有任何 Agent 提供
/// 经过验证、用户授权的结构化「剪贴板直达」本地接口；
/// 因此最高档只能到「用户手动触发桌面粘贴」或「本地导出包」。
fn capability_matrix(
    installed: bool,
    window_present: bool,
) -> (
    AgentCapability,
    AgentCapability,
    AgentCapability,
    AgentCapability,
    &'static str,
) {
    let direct_send = AgentCapability {
        supported: false,
        evidence: "unsupported-interface".into(),
        note: "未发现经用户授权、稳定且可验证的本地发送接口；不会绕过权限或使用未公开协议".into(),
    };
    let file_import = AgentCapability {
        supported: false,
        evidence: "unverified".into(),
        note: "未验证到官方文件导入接口；导出包需要用户在 Agent 中手动附加".into(),
    };
    let desktop_paste = if window_present {
        AgentCapability {
            supported: true,
            evidence: "window-present".into(),
            note: "可在分组详情中手动选择该窗口逐项粘贴；只代表按键动作已发送，接收无法自动验证"
                .into(),
        }
    } else if installed {
        AgentCapability {
            supported: false,
            evidence: "exe-found".into(),
            note: "已安装但当前没有可交互窗口；启动并聚焦后可在分组详情中手动逐项粘贴".into(),
        }
    } else {
        AgentCapability {
            supported: false,
            evidence: "not-installed".into(),
            note: "未安装，无法桌面粘贴或发送".into(),
        }
    };
    let export = AgentCapability {
        supported: true,
        evidence: "local-export".into(),
        note: "导出 Markdown + 图片 + manifest 到本地；不会自动上传或发送".into(),
    };
    let recommended = if window_present { "paste" } else { "export" };
    (direct_send, file_import, desktop_paste, export, recommended)
}

/// 列出剪贴板导出可配合的 Agent；不在此列表中的程序仍可手动选择导出的文件。
pub fn targets(db: &Db) -> Vec<AgentClipboardTarget> {
    let mut out = Vec::new();
    for d in crate::agents::discovery::scan_all(db) {
        if d.source_id == "bridge" {
            continue;
        }
        let caps = crate::navigation::agent_navigation::capabilities(&d.source_id);
        let evidence = caps.can_focus_window.evidence.clone();
        let window_present = evidence == "window-present";
        let (direct_send, file_import, desktop_paste, export, recommended) =
            capability_matrix(d.installed, window_present);
        out.push(AgentClipboardTarget {
            source_id: d.source_id.clone(),
            display_name: d.display_name.clone(),
            installed: d.installed,
            window_present,
            note: if !d.installed {
                "未安装".into()
            } else if window_present {
                "窗口可用：可手动逐项粘贴，或导出本地包".into()
            } else {
                "已安装但当前无窗口；可导出本地包后手动附加".into()
            },
            evidence,
            direct_send,
            file_import,
            desktop_paste,
            export,
            recommended: recommended.into(),
        });
    }
    out
}

#[derive(Debug, Clone, Serialize)]
pub struct ExportPackage {
    pub dir: String,
    pub markdown_path: String,
    pub manifest_path: String,
    pub files: Vec<String>,
    pub item_count: i64,
    pub summary: String,
    pub warnings: Vec<String>,
}

fn task_context(db: &Db, task_id: &str) -> AppResult<Option<(String, String)>> {
    db.with_conn(|conn| {
        use rusqlite::OptionalExtension;
        Ok(conn
            .query_row(
                "SELECT title, description FROM tasks WHERE id = ?1",
                rusqlite::params![task_id],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
            )
            .optional()?)
    })
}

fn escape_md(s: &str) -> String {
    s.replace('`', "\\`")
}

struct Writer {
    markdown: String,
    files: Vec<String>,
    warnings: Vec<String>,
}

fn append_item(
    w: &mut Writer,
    item: &ClipboardItem,
    idx: usize,
    image_png: Option<Vec<u8>>,
    dir: &Path,
) -> AppResult<()> {
    w.markdown.push_str(&format!(
        "## {}. {} · {}\n\n",
        idx + 1,
        kind_label(&item.kind),
        item.created_at
    ));
    if !item.source_app.is_empty() {
        w.markdown
            .push_str(&format!("- 来源：`{}`\n", escape_md(&item.source_app)));
    }
    if !item.source_title.is_empty() {
        w.markdown.push_str(&format!(
            "- 窗口：{}\n",
            item.source_title.replace('\n', " ")
        ));
    }
    if item.favorite {
        w.markdown.push_str("- 已收藏\n");
    }
    w.markdown.push('\n');

    match item.kind.as_str() {
        KIND_IMAGE => {
            if let Some(png) = image_png {
                let name = format!("{:03}-image.png", idx + 1);
                std::fs::write(dir.join(&name), png)?;
                w.files.push(name.clone());
                w.markdown
                    .push_str(&format!("![{}]({})\n\n", escape_md(&item.preview), name));
            } else {
                w.warnings
                    .push(format!("第 {} 项图片文件缺失，导出包中仅为占位", idx + 1));
                w.markdown
                    .push_str(&format!("[图片缺失：{}]\n\n", item.preview));
            }
        }
        KIND_FILES => {
            w.markdown
                .push_str("文件列表（仅记录路径，未复制文件本体）：\n");
            for p in &item.file_paths {
                w.markdown.push_str(&format!("- `{}`\n", escape_md(p)));
            }
            w.markdown.push('\n');
            w.warnings
                .push("文件条目仅导出路径清单；需要文件本体请使用「复制文件」".into());
        }
        KIND_HTML => {
            if !item.text.trim().is_empty() {
                w.markdown.push_str("```text\n");
                w.markdown.push_str(&item.text);
                w.markdown.push_str("\n```\n\n");
            }
            if !item.html.trim().is_empty() {
                w.markdown.push_str("HTML 片段（已消毒）：\n\n```html\n");
                w.markdown.push_str(&item.html);
                w.markdown.push_str("\n```\n\n");
            }
        }
        KIND_URL => {
            let url = item.text.trim();
            w.markdown.push_str(&format!("<{url}>\n\n"));
        }
        _ => {
            w.markdown.push_str("```text\n");
            w.markdown.push_str(&item.text);
            w.markdown.push_str("\n```\n\n");
        }
    }
    Ok(())
}

fn kind_label(kind: &str) -> &'static str {
    match kind {
        KIND_IMAGE => "图片",
        KIND_FILES => "文件",
        KIND_HTML => "富文本",
        KIND_URL => "链接",
        _ => "文本",
    }
}

/// 导出条目或分组为本地包；`app_data` 为应用数据目录。
/// 组按展示顺序导出，图片复制为独立 PNG 文件，Markdown 中保留实际顺序。
pub fn export_package(
    db: &Db,
    root: &Path,
    app_data: &Path,
    target_type: &str,
    target_id: &str,
    task_id: Option<&str>,
) -> AppResult<ExportPackage> {
    let (items, title, group_mode): (Vec<ClipboardItem>, String, Option<String>) = match target_type
    {
        "item" => {
            let item = store::get_item(db, target_id)?;
            let title = item.preview.clone();
            (vec![item], title, None)
        }
        "group" => {
            let group = store::get_group(db, target_id)?;
            if group.items.is_empty() {
                return Err(AppError::Validation("分组为空，无法导出".into()));
            }
            (group.items, group.name, Some(group.mode))
        }
        _ => return Err(AppError::Validation("未知导出类型".into())),
    };

    let export_id = uuid::Uuid::new_v4().to_string();
    let dir = app_data
        .join("clipboard-exports")
        .join(&export_id[..8.min(export_id.len())]);
    std::fs::create_dir_all(&dir)?;

    let mut w = Writer {
        markdown: String::new(),
        files: Vec::new(),
        warnings: Vec::new(),
    };
    w.markdown.push_str("# Task Dock 剪贴板导出\n\n");
    w.markdown
        .push_str(&format!("- 标题：{}\n", title.replace('\n', " ")));
    w.markdown
        .push_str(&format!("- 导出时间：{}\n", crate::agents::now_iso()));
    w.markdown.push_str(&format!("- 条目数：{}\n", items.len()));
    if let Some(mode) = &group_mode {
        w.markdown.push_str(&format!(
            "- 分组方式：{}\n",
            if mode == "auto" {
                "自动收集"
            } else {
                "手动"
            }
        ));
    }
    if let Some(task_id) = task_id {
        match task_context(db, task_id)? {
            Some((t, d)) => {
                w.markdown
                    .push_str(&format!("- 关联任务：{}\n", t.replace('\n', " ")));
                if !d.trim().is_empty() {
                    w.markdown.push_str("\n## 任务描述\n\n");
                    w.markdown.push_str(d.trim());
                    w.markdown.push('\n');
                }
            }
            None => w
                .warnings
                .push("关联任务已不存在，导出包未包含任务上下文".into()),
        }
    }
    w.markdown.push('\n');
    w.markdown
        .push_str("> 本导出包仅保存在本机；Task Dock 不会自动上传或自动发送给任何 Agent。\n\n");

    for (idx, item) in items.iter().enumerate() {
        let png = if item.kind == KIND_IMAGE {
            store::image_png(db, root, &item.id)
        } else {
            None
        };
        append_item(&mut w, item, idx, png, &dir)?;
    }

    let markdown_path = dir.join("clipboard.md");
    std::fs::write(&markdown_path, &w.markdown)?;

    let manifest = serde_json::json!({
        "exported_at": crate::agents::now_iso(),
        "target_type": target_type,
        "target_id": target_id,
        "title": title,
        "task_id": task_id,
        "items": items.iter().map(|i| serde_json::json!({
            "id": i.id,
            "kind": i.kind,
            "preview": i.preview,
            "byte_size": i.byte_size,
            "source_app": i.source_app,
            "created_at": i.created_at,
        })).collect::<Vec<_>>(),
        "files": w.files,
        "warnings": w.warnings,
        "note": "本地导出；Task Dock 不自动上传或发送给 Agent",
    });
    let manifest_path = dir.join("manifest.json");
    std::fs::write(&manifest_path, serde_json::to_string_pretty(&manifest)?)?;

    let mut files: Vec<String> = vec![
        markdown_path.to_string_lossy().into_owned(),
        manifest_path.to_string_lossy().into_owned(),
    ];
    for name in &w.files {
        files.push(dir.join(name).to_string_lossy().into_owned());
    }
    Ok(ExportPackage {
        dir: dir.to_string_lossy().into_owned(),
        markdown_path: markdown_path.to_string_lossy().into_owned(),
        manifest_path: manifest_path.to_string_lossy().into_owned(),
        files,
        item_count: items.len() as i64,
        summary: format!("已导出 {} 项到本地目录；未发送给任何 Agent", items.len()),
        warnings: w.warnings,
    })
}

/// 供前端在导出前确认统计（不读取正文）。
pub fn export_preview(db: &Db, target_type: &str, target_id: &str) -> AppResult<serde_json::Value> {
    let items: Vec<ClipboardItem> = match target_type {
        "item" => vec![store::get_item(db, target_id)?],
        "group" => store::get_group(db, target_id)?.items,
        _ => return Err(AppError::Validation("未知导出类型".into())),
    };
    let images = items.iter().filter(|i| i.kind == KIND_IMAGE).count();
    Ok(serde_json::json!({
        "items": items.len(),
        "images": images,
        "bytes": items.iter().map(|i| i.byte_size).sum::<i64>(),
        "kinds": items.iter().map(|i| i.kind.clone()).collect::<Vec<_>>(),
        "note": "导出仅写本地文件，不自动上传",
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clipboard::{store::ClipboardFilter, CapturedContent, CapturedImage};
    use std::path::PathBuf;

    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!("td-agent-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&p).unwrap();
            Self(p)
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn text(text: &str) -> CapturedContent {
        CapturedContent {
            kind: "text".into(),
            text: text.into(),
            html: String::new(),
            preview: String::new(),
            file_paths: vec![],
            image: None,
            source_app: "notepad.exe".into(),
            source_title: "记事本".into(),
            byte_size: 0,
        }
    }

    fn image() -> CapturedContent {
        let (w, h) = (16u32, 12u32);
        let rgba = vec![200u8; (w * h * 4) as usize];
        CapturedContent {
            kind: "image".into(),
            text: String::new(),
            html: String::new(),
            preview: String::new(),
            file_paths: vec![],
            image: Some(CapturedImage {
                png: crate::clipboard::image::encode_png(&rgba, w, h).unwrap(),
                width: w,
                height: h,
                rgba,
            }),
            source_app: "snippingtool.exe".into(),
            source_title: "截图工具".into(),
            byte_size: 0,
        }
    }

    #[test]
    fn agent_capability_matrix_is_honest() {
        let (direct, import, paste, export, recommended) = capability_matrix(true, true);
        assert!(!direct.supported, "没有验证过的接口就不能宣称直接发送");
        assert!(!import.supported);
        assert!(paste.supported);
        assert!(export.supported);
        assert_eq!(recommended, "paste");

        let (_, _, paste, _, recommended) = capability_matrix(true, false);
        assert!(!paste.supported, "没有窗口就不能宣称桌面粘贴可用");
        assert_eq!(recommended, "export");

        let (_, _, paste, export, _) = capability_matrix(false, false);
        assert!(!paste.supported);
        assert!(export.supported, "导出始终是可用降级路径");
    }

    #[test]
    fn export_group_keeps_order_and_copies_images() {
        let db = Db::open_in_memory().unwrap();
        let root = Temp::new();
        let data = Temp::new();
        let s = crate::db::Settings {
            clipboard_auto_group: false,
            ..Default::default()
        };
        let a = store::record_capture(&db, &root.0, &text("第一段"), &s).unwrap();
        let b = store::record_capture(&db, &root.0, &image(), &s).unwrap();
        let g = store::create_manual_group(&db, "资料", &[a.item.id.clone(), b.item.id.clone()])
            .unwrap();
        let pkg = export_package(&db, &root.0, &data.0, "group", &g.id, None).unwrap();
        assert_eq!(pkg.item_count, 2);
        let md = std::fs::read_to_string(&pkg.markdown_path).unwrap();
        assert!(md.find("第一段").unwrap() < md.find("已收藏").unwrap_or(usize::MAX));
        assert_eq!(pkg.files.len(), 3, "markdown + manifest + 1 张图片");
        assert!(pkg.files.iter().any(|f| f.ends_with("-image.png")));
        assert!(md.contains("不会自动上传"));
        assert!(pkg.summary.contains("未发送"));
        let empty = store::list_items(&db, &ClipboardFilter::default()).unwrap();
        assert_eq!(empty.len(), 2);
    }

    #[test]
    fn export_item_with_task_context() {
        let db = Db::open_in_memory().unwrap();
        let root = Temp::new();
        let data = Temp::new();
        let s = crate::db::Settings::default();
        let a = store::record_capture(&db, &root.0, &text("会议纪要"), &s).unwrap();
        db.with_conn(|c| {
            c.execute(
                "INSERT INTO tasks (id, title, description, created_at, updated_at)
                 VALUES ('t1', '周会', '讨论发布计划', 'now', 'now')",
                [],
            )?;
            Ok(())
        })
        .unwrap();
        let pkg = export_package(&db, &root.0, &data.0, "item", &a.item.id, Some("t1")).unwrap();
        let md = std::fs::read_to_string(&pkg.markdown_path).unwrap();
        assert!(md.contains("周会"));
        assert!(md.contains("讨论发布计划"));
        assert!(pkg.warnings.is_empty());
    }
}
