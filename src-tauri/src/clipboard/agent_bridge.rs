//! 剪贴板 → Agent 桥接：能力探测 + 本地导出包。
//!
//! 本模块只做两件事：
//! 1. 列出可用的 Agent 目标及其「窗口可唤醒」证据（复用导航层的动态探测）；
//! 2. 把文本/图片/有序分组/任务上下文转换成结构化本地文件，供用户**手动**附加给 Agent。
//!
//! 绝不自动上传、绝不自动发送：导出目录写完即返回路径，是否交给 Agent 由用户决定。

use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

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

/// 一次探测的可核验元数据。
///
/// `probed_at_ms` 是**生成这份列表的真实扫描完成时间**（Unix 毫秒）；命中 5 分钟缓存时
/// 它就是旧快照的时间，而不是本次响应的到达时间。前端据此区分「缓存结果」与「刚扫描」，
/// 不得把响应时间当作扫描时间展示。
#[derive(Debug, Clone, Serialize)]
pub struct AgentTargetsSnapshot {
    pub targets: Vec<AgentClipboardTarget>,
    pub probed_at_ms: i64,
    /// true = 直接复用了已有快照，本次请求没有重新扫描。
    pub cached: bool,
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

/// 探测结果缓存：`scan_all` 含登记表/安装路径/进程与窗口枚举，单次实测 17–28s。
/// 展开「Agent 兼容信息」才触发探测，缓存 5 分钟；安装/启动状态变化由用户点
/// 「重新探测」强制刷新，不做常驻轮询。
const TARGETS_TTL: Duration = Duration::from_secs(300);
/// 缓存快照：扫描完成时刻、结果、以及全局扫描序号。
type TargetsCacheEntry = (Instant, Vec<AgentClipboardTarget>, u64);
static TARGETS_CACHE: LazyLock<Mutex<Option<TargetsCacheEntry>>> =
    LazyLock::new(|| Mutex::new(None));
/// 每次真实扫描完成后递增：用来识别「请求开始后已有别的请求完成了一次扫描」。
static TARGETS_SCAN_SEQ: AtomicU64 = AtomicU64::new(0);
#[cfg(test)]
static TARGETS_SCANS: AtomicU64 = AtomicU64::new(0);

/// 列出剪贴板导出可配合的 Agent；不在此列表中的程序仍可手动选择导出的文件。
pub fn targets(db: &Db, force_refresh: bool) -> AgentTargetsSnapshot {
    let (targets, probed_at_ms, cached) = snapshot_or_scan(force_refresh, || targets_uncached(db));
    AgentTargetsSnapshot {
        targets,
        probed_at_ms,
        cached,
    }
}

fn now_unix_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 缓存快照的生成时间（Unix 毫秒）：用「当前时间 - 已过时长」而不是记录时的墙钟，
/// 避免系统时间调整让展示时间失真。
fn snapshot_unix_ms(at: Instant) -> i64 {
    // 向上取整到毫秒：截断会少减不足 1ms 的零头，让缓存时间戳比实际扫描最多晚 1ms，
    // 违反「缓存结果的时间戳不得晚于扫描时间」的契约（并行测试负载下必现）。
    now_unix_ms() - at.elapsed().as_micros().div_ceil(1000) as i64
}

/// 缓存读写的唯一入口（抽出扫描闭包便于测试缓存语义）。
///
/// 扫描期间一直持锁：普通并发请求会排队，只有第一个真正扫描，其余直接拿到同一份结果，
/// 不会出现「多个窗口同时各扫一遍」。强制刷新的并发请求按 **请求开始时的扫描序号** 合并：
/// 如果排队期间已有更新的扫描完成，直接复用该结果，避免 N 次「重新探测」排成 N 次
/// 17–28s 的全量扫描、占满后台线程。锁内没有 await，也不持有数据库连接以外的资源。
///
/// 返回值第三项 `cached` 表示本次请求是否直接命中已有快照（未重新扫描）。
fn snapshot_or_scan<F>(force_refresh: bool, scan: F) -> (Vec<AgentClipboardTarget>, i64, bool)
where
    F: FnOnce() -> Vec<AgentClipboardTarget>,
{
    // 必须在拿锁之前读取：这是「本请求开始时刻」的扫描序号基准。
    let started_after_seq = TARGETS_SCAN_SEQ.load(Ordering::Acquire);
    let mut guard = TARGETS_CACHE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some((at, cached, seq)) = guard.as_ref() {
        let reusable = if force_refresh {
            // 排队期间已有更新的扫描完成 → 本请求不必再扫一遍。
            *seq > started_after_seq
        } else {
            at.elapsed() < TARGETS_TTL
        };
        if reusable {
            return (cached.clone(), snapshot_unix_ms(*at), true);
        }
    }
    let fresh = scan();
    let at = Instant::now();
    let seq = TARGETS_SCAN_SEQ.fetch_add(1, Ordering::AcqRel) + 1;
    *guard = Some((at, fresh.clone(), seq));
    (fresh, now_unix_ms(), false)
}

#[cfg(test)]
fn reset_targets_cache() {
    *TARGETS_CACHE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
    TARGETS_SCAN_SEQ.store(0, Ordering::Release);
    TARGETS_SCANS.store(0, Ordering::Relaxed);
}

/// 把缓存快照「调旧」，用于在不等待 5 分钟的前提下验证 TTL 过期路径。
#[cfg(test)]
fn age_targets_cache(age: Duration) {
    let mut guard = TARGETS_CACHE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some((at, _, _)) = guard.as_mut() {
        *at = Instant::now().checked_sub(age).unwrap_or_else(Instant::now);
    }
}

fn targets_uncached(db: &Db) -> Vec<AgentClipboardTarget> {
    #[cfg(test)]
    TARGETS_SCANS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);

    // 空列表只代表「当前没有发现可列出的 Agent」：`scan_all` 不返回错误信号，
    // 因此这里不把空列表当作探测失败，也不会用空结果覆盖已有有效快照（调用方按需重扫）。
    let mut out = Vec::new();
    for d in crate::agents::discovery::scan_all(db) {
        if d.source_id == "bridge" {
            continue;
        }
        // 未安装的 Agent 不可能有可交互窗口，跳过窗口/CLI 探测，减少一次全量扫描的探测次数。
        let (evidence, window_present) = if d.installed {
            let caps = crate::navigation::agent_navigation::capabilities(&d.source_id);
            let evidence = caps.can_focus_window.evidence.clone();
            (evidence.clone(), evidence == "window-present")
        } else {
            ("not-installed".to_string(), false)
        };
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

/// 单次导出目录创建的最大尝试次数。完整 UUID 正常一次即成；上限只防测试/异常环境下
/// 名称生成器持续返回已存在名字时无限循环。
const EXPORT_DIR_MAX_ATTEMPTS: usize = 5;

/// 独占创建一个**全新**导出目录并返回其路径。
///
/// 安全边界（历史导出目录与用户数据不可被误删/覆盖）：
/// - 目录名默认用**完整 UUID v4**，碰撞概率可忽略；命名冲突时换名重试，绝不复用已有目录。
/// - 用 `create_dir`（独占创建）而不是 `create_dir_all`：目标已存在一定返回 `AlreadyExists`，
///   不会被当成「创建成功」。
/// - 父目录 `clipboard-exports/` 允许已存在（那是共享容器），但本函数只返回新建的子目录；
///   清理守卫只删除这个子目录，绝不向上删除父目录或历史导出。
fn unique_export_dir<F>(base: &Path, mut next_name: F) -> AppResult<PathBuf>
where
    F: FnMut() -> String,
{
    std::fs::create_dir_all(base)?;
    for _ in 0..EXPORT_DIR_MAX_ATTEMPTS {
        let candidate = base.join(next_name());
        match std::fs::create_dir(&candidate) {
            Ok(()) => return Ok(candidate),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.into()),
        }
    }
    Err(AppError::Io(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "导出目录名连续冲突，已放弃本次导出（未触碰任何已有目录）",
    )))
}

/// 导出目录的收尾守卫：写盘中途失败时删除**本次新建**的半成品目录，成功时 `commit()` 保留。
/// 路径由 `unique_export_dir` 独占创建，因此 Drop 的删除范围只可能是这次调用自己的目录，
/// 不会覆盖或删除历史导出、也不会删除其他任务正在写入的目录。
struct ExportDirGuard {
    path: PathBuf,
    keep: bool,
}

impl ExportDirGuard {
    fn create_in(base: &Path) -> AppResult<Self> {
        Ok(Self {
            path: unique_export_dir(base, || uuid::Uuid::new_v4().to_string())?,
            keep: false,
        })
    }

    fn commit(self) {
        // 消费 self 后 Drop 仍会执行，但 keep=true 时不再删除。
        let mut this = self;
        this.keep = true;
    }
}

impl Drop for ExportDirGuard {
    fn drop(&mut self) {
        if !self.keep {
            let _ = std::fs::remove_dir_all(&self.path);
        }
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

    // 目录名是完整 UUID 且独占创建：已存在的目录不会被复用，历史导出不受影响。
    // 任一步写盘失败都会在中途返回，守卫只删除这次新建的半成品目录。
    let dir_guard = ExportDirGuard::create_in(&app_data.join("clipboard-exports"))?;
    let dir = dir_guard.path.clone();

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
    // 全部文件写成功才保留目录；此前任何 `?` 提前返回都会触发 Drop 清理。
    dir_guard.commit();
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
            source_kind: "owner".into(),
            byte_size: 0,
        }
    }

    fn image() -> CapturedContent {
        image_with_seed(0)
    }

    /// 内容不同的图片（`record_capture` 会按内容去重，性能用例必须避免 10 张完全相同）。
    fn image_with_seed(seed: u8) -> CapturedContent {
        let (w, h) = (16u32, 12u32);
        let mut rgba = vec![200u8; (w * h * 4) as usize];
        rgba[0] = seed;
        rgba[1] = seed.wrapping_add(1);
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
            source_kind: "owner".into(),
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

    /// 有限、可复现的导出耗时探针：输出条目数、文件数与实测毫秒。
    /// 只用于记录当前机器/构建条件下的数字，不设时间阈值（不同机器不可比）。
    /// 用 `cargo test --lib export_timing_probe -- --nocapture` 查看 `[perf]` 行。
    #[test]
    fn export_timing_probe() {
        let db = Db::open_in_memory().unwrap();
        let root = Temp::new();
        let data = Temp::new();
        let s = crate::db::Settings {
            clipboard_auto_group: false,
            ..Default::default()
        };

        let measure = |label: &str,
                       target_type: &str,
                       target_id: &str,
                       expect_items: usize,
                       expect_files: usize| {
            let started = Instant::now();
            let pkg = export_package(&db, &root.0, &data.0, target_type, target_id, None).unwrap();
            let ms = started.elapsed().as_millis();
            println!(
                "[perf] case={label} items={} files={} elapsed_ms={ms}",
                pkg.item_count,
                pkg.files.len()
            );
            assert_eq!(pkg.item_count, expect_items as i64, "条目数不应因导出改变");
            assert_eq!(pkg.files.len(), expect_files, "文件数与格式应保持稳定");
        };

        let single = store::record_capture(&db, &root.0, &text("普通文本一条"), &s).unwrap();
        measure("single-text", "item", &single.item.id, 1, 2);

        let text_ids: Vec<String> = (0..100)
            .map(|i| {
                let body = format!("第 {i} 条文字内容，用于验证多条目导出不会重复读文件。");
                store::record_capture(&db, &root.0, &text(&body), &s)
                    .unwrap()
                    .item
                    .id
            })
            .collect();
        let text_group = store::create_manual_group(&db, "100 条文字", &text_ids).unwrap();
        measure("100-text-group", "group", &text_group.id, 100, 2);

        let small_ids: Vec<String> = (0..10)
            .map(|i| {
                store::record_capture(&db, &root.0, &image_with_seed(i), &s)
                    .unwrap()
                    .item
                    .id
            })
            .collect();
        let small_group = store::create_manual_group(&db, "10 张小图", &small_ids).unwrap();
        measure("10-small-images", "group", &small_group.id, 10, 12);

        let large_ids: Vec<String> = (0..10)
            .map(|i| {
                let (w, h) = (512u32, 512u32);
                let mut rgba = vec![180u8; (w * h * 4) as usize];
                rgba[0] = i as u8; // 避免内容去重把 10 张大图合并成 1 条
                rgba[1] = i as u8;
                let content = CapturedContent {
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
                    source_kind: "owner".into(),
                    byte_size: 0,
                };
                store::record_capture(&db, &root.0, &content, &s)
                    .unwrap()
                    .item
                    .id
            })
            .collect();
        let large_group = store::create_manual_group(&db, "10 张大图", &large_ids).unwrap();
        measure("10-large-512-images", "group", &large_group.id, 10, 12);
    }

    /// 缓存是进程级单例，相关用例串行执行，避免彼此清空/调旧快照。
    static CACHE_TEST_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

    fn lock_cache_tests() -> std::sync::MutexGuard<'static, ()> {
        CACHE_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn counting_scan(
        counter: &std::sync::atomic::AtomicU64,
    ) -> impl Fn() -> Vec<AgentClipboardTarget> + '_ {
        move || {
            counter.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            Vec::new()
        }
    }

    #[test]
    fn targets_cache_reuses_result_and_honors_force_refresh() {
        let _g = lock_cache_tests();
        reset_targets_cache();
        let scans = std::sync::atomic::AtomicU64::new(0);

        let first = snapshot_or_scan(false, counting_scan(&scans));
        assert!(first.0.is_empty());
        assert!(!first.2, "首次请求必须真实扫描");
        assert!(first.1 > 0, "必须返回真实扫描时间戳");

        let second = snapshot_or_scan(false, counting_scan(&scans));
        assert!(second.0.is_empty());
        assert!(second.2, "TTL 内必须标记为缓存结果");
        assert_eq!(
            scans.load(std::sync::atomic::Ordering::Relaxed),
            1,
            "TTL 内重复请求不应再次扫描"
        );
        assert!(second.1 <= first.1, "缓存结果的时间戳不得晚于首次扫描时间");

        assert!(snapshot_or_scan(true, counting_scan(&scans)).0.is_empty());
        assert_eq!(
            scans.load(std::sync::atomic::Ordering::Relaxed),
            2,
            "显式刷新必须重新扫描"
        );
    }

    #[test]
    fn targets_cache_expires_and_rescans() {
        let _g = lock_cache_tests();
        reset_targets_cache();
        let scans = std::sync::atomic::AtomicU64::new(0);

        snapshot_or_scan(false, counting_scan(&scans));
        age_targets_cache(TARGETS_TTL + Duration::from_secs(1));
        let after = snapshot_or_scan(false, counting_scan(&scans));
        assert_eq!(
            scans.load(std::sync::atomic::Ordering::Relaxed),
            2,
            "超过 TTL 必须重新扫描"
        );
        assert!(!after.2, "TTL 过期后的结果不是缓存命中");
    }

    #[test]
    fn empty_result_is_cached_without_being_treated_as_failure() {
        let _g = lock_cache_tests();
        reset_targets_cache();
        let scans = std::sync::atomic::AtomicU64::new(0);

        // scan_all 没有失败通道：空列表就是「当前没有可列出的 Agent」。
        let first = snapshot_or_scan(false, counting_scan(&scans));
        assert!(first.0.is_empty() && !first.2);
        let again = snapshot_or_scan(false, counting_scan(&scans));
        assert!(again.0.is_empty() && again.2);
        assert_eq!(
            scans.load(std::sync::atomic::Ordering::Relaxed),
            1,
            "空结果同样是有效快照，不应触发重扫或当作失败"
        );
    }

    #[test]
    fn concurrent_probes_scan_once_and_share_result() {
        let _g = lock_cache_tests();
        reset_targets_cache();
        let scans = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));

        let mut handles = Vec::new();
        for _ in 0..4 {
            let scans = scans.clone();
            handles.push(std::thread::spawn(move || {
                let r = snapshot_or_scan(false, || {
                    scans.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    std::thread::sleep(Duration::from_millis(30));
                    Vec::new()
                });
                assert!(r.0.is_empty());
            }));
        }
        for handle in handles {
            handle.join().unwrap();
        }
        assert_eq!(
            scans.load(std::sync::atomic::Ordering::Relaxed),
            1,
            "并发请求应共享同一次扫描"
        );
    }

    #[test]
    fn concurrent_force_refresh_is_coalesced() {
        let _g = lock_cache_tests();
        reset_targets_cache();
        let scans = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
        // 屏障保证所有线程都在第一次扫描完成前读到起始序号。
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(4));

        let mut handles = Vec::new();
        for _ in 0..4 {
            let scans = scans.clone();
            let barrier = barrier.clone();
            handles.push(std::thread::spawn(move || {
                barrier.wait();
                snapshot_or_scan(true, || {
                    scans.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    std::thread::sleep(Duration::from_millis(150));
                    Vec::new()
                })
            }));
        }
        for handle in handles {
            assert!(handle.join().unwrap().0.is_empty());
        }
        assert_eq!(
            scans.load(std::sync::atomic::Ordering::Relaxed),
            1,
            "并发的强制刷新不应排成多次全量扫描"
        );
    }

    #[test]
    fn export_dir_never_reuses_an_existing_directory() {
        let base = Temp::new();
        let existing = base.0.join("existing-export");
        std::fs::create_dir(&existing).unwrap();
        std::fs::write(existing.join("user-note.txt"), "keep me").unwrap();

        let names = std::cell::RefCell::new(vec![
            "existing-export".to_string(),
            "fresh-export".to_string(),
        ]);
        let created = unique_export_dir(&base.0, || names.borrow_mut().remove(0)).unwrap();

        assert!(created.ends_with("fresh-export"), "冲突时必须换一个新名字");
        assert_eq!(
            std::fs::read_to_string(existing.join("user-note.txt")).unwrap(),
            "keep me",
            "已存在目录及其中文件不得被复用或覆盖"
        );
        assert!(existing.exists(), "已存在目录不得被删除");
    }

    #[test]
    fn export_dir_gives_up_after_attempt_limit_and_keeps_existing_data() {
        let base = Temp::new();
        let existing = base.0.join("taken");
        std::fs::create_dir(&existing).unwrap();
        std::fs::write(existing.join("old.md"), "old export").unwrap();

        let err = unique_export_dir(&base.0, || "taken".to_string()).unwrap_err();
        assert!(
            err.to_string().contains("冲突"),
            "连续冲突必须返回明确错误: {err}"
        );
        assert!(existing.join("old.md").exists(), "失败路径不得删除已有数据");
    }

    #[test]
    fn export_dir_uses_full_uuid() {
        let base = Temp::new();
        let guard = ExportDirGuard::create_in(&base.0).unwrap();
        let name = guard
            .path
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        assert_eq!(name.len(), 36, "目录名应为完整 UUID（36 字符）");
        assert!(uuid::Uuid::parse_str(&name).is_ok());
        guard.commit();
        assert!(base.0.join(&name).is_dir(), "commit 后目录应保留");
    }

    /// 三个写盘阶段（图片 / Markdown / manifest）失败时，守卫只能删除本次新建的部分目录，
    /// 不得触碰同级的其他历史导出或用户文件。
    #[test]
    fn failed_export_stages_clean_only_own_directory() {
        let base = Temp::new();
        let history = base.0.join("history-export");
        std::fs::create_dir(&history).unwrap();
        std::fs::write(history.join("clipboard.md"), "历史导出").unwrap();

        for stage in ["image", "markdown", "manifest"] {
            let guard = ExportDirGuard::create_in(&base.0).unwrap();
            let own = guard.path.clone();
            match stage {
                // 第一张图片写到一半失败。
                "image" => std::fs::write(own.join("001-image.png"), b"partial").unwrap(),
                // 图片已写完，Markdown 写入失败。
                "markdown" => std::fs::write(own.join("001-image.png"), b"png").unwrap(),
                // Markdown 已写完，manifest 写入失败。
                _ => {
                    std::fs::write(own.join("001-image.png"), b"png").unwrap();
                    std::fs::write(own.join("clipboard.md"), "md").unwrap();
                }
            }
            drop(guard);
            assert!(!own.exists(), "{stage} 阶段失败必须清理本次半成品目录");
            assert!(
                history.join("clipboard.md").exists(),
                "{stage} 阶段失败不得删除其他历史导出"
            );
        }
    }

    #[test]
    fn concurrent_exports_create_distinct_directories() {
        let base = Temp::new();
        let base_path = std::sync::Arc::new(base.0.clone());
        let mut handles = Vec::new();
        for _ in 0..8 {
            let base_path = base_path.clone();
            handles.push(std::thread::spawn(move || {
                let guard = ExportDirGuard::create_in(&base_path).unwrap();
                let path = guard.path.clone();
                guard.commit();
                path
            }));
        }
        let mut dirs: Vec<PathBuf> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        dirs.sort();
        dirs.dedup();
        assert_eq!(dirs.len(), 8, "并发导出必须各自得到独立目录");
        assert!(dirs.iter().all(|d| d.is_dir()));
    }

    /// 真机性能探针：需要本机已安装/运行部分 Agent，结果依赖环境，故默认不参与 CI。
    /// `cd src-tauri && cargo test --lib measure_targets_cost -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn measure_targets_cost() {
        let db = Db::open_in_memory().unwrap();
        for round in 0..3 {
            let t = std::time::Instant::now();
            let list = targets(&db, false);
            println!(
                "targets round {round}: {:?}, {} agents, {} scans",
                t.elapsed(),
                list.targets.len(),
                TARGETS_SCANS.load(std::sync::atomic::Ordering::Relaxed)
            );
        }
        let t = std::time::Instant::now();
        let _ = targets(&db, true);
        println!(
            "targets forced refresh: {:?}, {} scans",
            t.elapsed(),
            TARGETS_SCANS.load(std::sync::atomic::Ordering::Relaxed)
        );
    }
}
