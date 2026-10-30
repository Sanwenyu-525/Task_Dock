//! 逐项粘贴队列：整组复制 → 依次写入剪贴板 → 切换目标窗口 → 发送 Ctrl+V。
//!
//! 诚实边界：
//! - 只对「按键动作已发送」负责，目标应用是否接收无法自动验证，状态文案必须说明；
//! - 每一项都经过 `pending → preparing → clipboard_written → input_sent → settling →
//!   unverified` 状态机；没有可靠完成信号时绝不标记为 confirmed；
//! - 写入使用内容守卫 `write_guarded`：内容校验与 `EmptyClipboard` 在同一个
//!   剪贴板锁内完成，用户在此之后复制的新内容不会被覆盖；
//! - 最后一项发送后先进入独立收尾阶段（等待目标消费），再尝试恢复原剪贴板；
//! - 已经写入过剪贴板的条目不会留在待处理列表里，恢复任务时不会被盲目重发。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use super::engine;
use super::platform::{
    self, ClipboardMatch, ClipboardPayload, RestoreOutcome, Snapshot, TargetWindow, WriteGuard,
    WriteOutcome,
};
use super::store;
use super::{ClipboardItem, KIND_FILES, KIND_HTML, KIND_IMAGE};
use crate::db::{Db, Settings};
use crate::error::{AppError, AppResult};

/// 单个条目的粘贴生命周期。`InputSent` 不等于目标已接收。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ItemState {
    Pending,
    Preparing,
    ClipboardWritten,
    InputSent,
    Settling,
    /// 仅在存在可验证的接收信号时使用；当前第三方应用普遍不提供。
    Confirmed,
    /// 动作已发送，但没有可靠证据表明目标已接收。
    Unverified,
    Failed,
    Cancelled,
}

impl ItemState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Preparing => "preparing",
            Self::ClipboardWritten => "clipboard_written",
            Self::InputSent => "input_sent",
            Self::Settling => "settling",
            Self::Confirmed => "confirmed",
            Self::Unverified => "unverified",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }

    fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Confirmed | Self::Unverified | Self::Failed | Self::Cancelled
        )
    }
}

/// 按内容类型区分的粘贴节奏。图片/富文本/文件目标需要更长的消费时间。
#[derive(Debug, Clone, Copy, Serialize)]
pub struct PasteTiming {
    pub text_ms: u64,
    pub html_ms: u64,
    pub image_ms: u64,
    pub files_ms: u64,
}

impl PasteTiming {
    pub fn from_settings(s: &Settings) -> Self {
        let clamp = |v: u32| (v as u64).clamp(100, 5000);
        Self {
            text_ms: clamp(s.clipboard_paste_interval_ms),
            html_ms: clamp(s.clipboard_paste_interval_html_ms),
            image_ms: clamp(s.clipboard_paste_interval_image_ms),
            files_ms: clamp(s.clipboard_paste_interval_files_ms),
        }
    }

    pub fn interval_for(&self, kind: &str) -> u64 {
        match kind {
            KIND_IMAGE => self.image_ms,
            KIND_HTML => self.html_ms,
            KIND_FILES => self.files_ms,
            _ => self.text_ms,
        }
    }

    /// 单项发送后的观察窗口：给目标应用留出异步读取剪贴板的时间。
    pub fn settle_for(&self, kind: &str) -> u64 {
        (self.interval_for(kind) / 2).clamp(120, 900)
    }

    /// 最后一项的独立收尾时间，必须覆盖目标异步解码图片的最坏情况。
    pub fn finishing_for(&self, kind: Option<&str>) -> u64 {
        match kind {
            Some(k) => self.settle_for(k).max(250),
            None => 250,
        }
    }
}

/// 平台副作用抽象：生产实现走 Win32，测试注入可控假实现以构造竞态。
pub(crate) trait PasteIo {
    fn sequence(&self) -> u32;
    /// 只读比较当前剪贴板内容与 `expected`。
    /// 必须区分「内容不同」与「暂时读不到」：后者不能当成用户接管。
    fn clipboard_match(&self, expected: &ClipboardPayload) -> ClipboardMatch;
    fn snapshot(&self) -> Snapshot;
    fn target_alive(&self, hwnd: isize) -> bool;
    fn focus(&self, hwnd: isize, pid: u32, cancel: &AtomicBool) -> AppResult<()>;
    fn write_guarded(
        &self,
        payload: &ClipboardPayload,
        guard: WriteGuard<'_>,
    ) -> AppResult<WriteOutcome>;
    fn send_paste(&self, hwnd: isize, pid: u32) -> AppResult<()>;
    fn restore_if_own_content(
        &self,
        snapshot: &Snapshot,
        last_written: &ClipboardPayload,
    ) -> AppResult<RestoreOutcome>;
    fn note_self_write(&self, sequence: u32);
    fn sleep_ms(&self, ms: u64);
}

pub(crate) struct LoadedPayload {
    pub kind: String,
    pub payload: ClipboardPayload,
}

pub(crate) struct PastePlan {
    pub target: TargetWindow,
    pub item_ids: Vec<String>,
    pub total: i64,
    pub sent_start: i64,
    pub timing: PasteTiming,
}

pub(crate) struct PasteProgress<'a> {
    pub item_id: &'a str,
    pub index: usize,
    pub state: ItemState,
    pub sent: i64,
    pub total: i64,
    pub remaining: &'a [String],
    pub note: Option<&'a str>,
}

pub(crate) struct PasteRunOutcome {
    pub status: &'static str,
    pub sent: i64,
    pub skipped: i64,
    pub remaining: Vec<String>,
    pub restored: bool,
    pub user_took_over: bool,
    pub notes: Vec<String>,
    pub states: Vec<(String, ItemState)>,
}

impl PasteRunOutcome {
    pub fn unverified(&self) -> i64 {
        self.states
            .iter()
            .filter(|(_, s)| *s == ItemState::Unverified)
            .count() as i64
    }

    pub fn confirmed(&self) -> i64 {
        self.states
            .iter()
            .filter(|(_, s)| *s == ItemState::Confirmed)
            .count() as i64
    }
}

fn canceled(flag: &AtomicBool) -> bool {
    flag.load(Ordering::SeqCst)
}

fn sleep_cancelable(io: &dyn PasteIo, ms: u64, cancel: &AtomicBool) -> bool {
    let mut left = ms;
    while left > 0 {
        if canceled(cancel) {
            return false;
        }
        let chunk = left.min(100);
        io.sleep_ms(chunk);
        left -= chunk;
    }
    !canceled(cancel)
}

/// 在条目边界等待一个可判定的内容比对结果。
///
/// 剪贴板可能被其他程序（包括本进程的采集线程）短暂占用：`OpenClipboard` 失败
/// 只说明「读不到」，不能据此断言用户接管，否则会误停正常粘贴并留下重复内容。
/// 但重试有上限，仍然读不到时必须停下（无法确认内容就不发送按键）。
fn match_settled(
    io: &dyn PasteIo,
    payload: &ClipboardPayload,
    cancel: &AtomicBool,
) -> ClipboardMatch {
    for attempt in 0..5u64 {
        if attempt > 0 && !sleep_cancelable(io, 40 + attempt * 30, cancel) {
            return ClipboardMatch::Unavailable;
        }
        match io.clipboard_match(payload) {
            ClipboardMatch::Unavailable => continue,
            settled => return settled,
        }
    }
    ClipboardMatch::Unavailable
}

/// 纯状态机：不访问数据库、不直接调用 Win32，测试可完整构造竞态。
pub(crate) fn run_plan(
    io: &dyn PasteIo,
    plan: &PastePlan,
    cancel: &AtomicBool,
    load: &mut dyn FnMut(&str) -> AppResult<LoadedPayload>,
    progress: &mut dyn FnMut(&PasteProgress),
) -> PasteRunOutcome {
    let snapshot = io.snapshot();
    let baseline = snapshot.payload.clone();
    let mut last_seq = snapshot.sequence;
    let mut last_payload: Option<ClipboardPayload> = None;
    let mut sent = plan.sent_start;
    let mut skipped = 0i64;
    let mut remaining = plan.item_ids.clone();
    let mut notes: Vec<String> = Vec::new();
    let mut states: Vec<(String, ItemState)> = Vec::new();
    let mut status = "completed";
    let mut user_took_over = false;
    let mut wrote_any = false;
    let mut last_kind: Option<String> = None;

    let set_state = |states: &mut Vec<(String, ItemState)>,
                     progress: &mut dyn FnMut(&PasteProgress),
                     id: &str,
                     index: usize,
                     state: ItemState,
                     sent: i64,
                     remaining: &[String],
                     note: Option<&str>| {
        if let Some(entry) = states.iter_mut().find(|(i, _)| i == id) {
            entry.1 = state;
        } else {
            states.push((id.to_string(), state));
        }
        if state.is_terminal()
            || matches!(
                state,
                ItemState::ClipboardWritten | ItemState::InputSent | ItemState::Settling
            )
        {
            progress(&PasteProgress {
                item_id: id,
                index,
                state,
                sent,
                total: plan.total,
                remaining,
                note,
            });
        }
    };

    for (idx, id) in plan.item_ids.iter().enumerate() {
        if canceled(cancel) {
            status = "cancelled";
            break;
        }
        if io.sequence() != last_seq {
            // 序列号变化可能只是 Windows 为合成格式继续递增；只有内容也变了
            // 才算用户/其他程序接管。内容仍是自己最后一次写入时，刷新序列号继续。
            let reference = last_payload.as_ref().or(baseline.as_ref());
            let settled = reference.map(|p| match_settled(io, p, cancel));
            match settled {
                Some(ClipboardMatch::Same) => last_seq = io.sequence(),
                Some(ClipboardMatch::Unavailable) => {
                    status = "failed";
                    notes.push(
                        "无法读取剪贴板确认内容（被其他程序占用），已停止且未写入任何内容".into(),
                    );
                    break;
                }
                Some(ClipboardMatch::Different) | None => {
                    status = "failed";
                    user_took_over = true;
                    notes.push("检测到剪贴板被其他程序更新，已停止并保留最新内容".into());
                    break;
                }
            }
        }
        if !io.target_alive(plan.target.hwnd) {
            status = "failed";
            notes.push("目标窗口已关闭".into());
            break;
        }

        set_state(
            &mut states,
            progress,
            id,
            idx,
            ItemState::Pending,
            sent,
            &remaining,
            None,
        );
        set_state(
            &mut states,
            progress,
            id,
            idx,
            ItemState::Preparing,
            sent,
            &remaining,
            None,
        );
        let loaded = match load(id) {
            Ok(v) => v,
            Err(e) => {
                skipped += 1;
                remaining.retain(|r| r != id);
                notes.push(format!("第 {} 项已跳过：{e}", idx + 1));
                set_state(
                    &mut states,
                    progress,
                    id,
                    idx,
                    ItemState::Failed,
                    sent,
                    &remaining,
                    Some("内容不可用，已跳过"),
                );
                continue;
            }
        };

        if let Err(e) = io.focus(plan.target.hwnd, plan.target.pid, cancel) {
            if canceled(cancel) {
                status = "cancelled";
                set_state(
                    &mut states,
                    progress,
                    id,
                    idx,
                    ItemState::Cancelled,
                    sent,
                    &remaining,
                    Some("用户取消"),
                );
            } else {
                status = "failed";
                notes.push(format!("第 {} 项前失去焦点：{e}", idx + 1));
                set_state(
                    &mut states,
                    progress,
                    id,
                    idx,
                    ItemState::Failed,
                    sent,
                    &remaining,
                    Some("无法聚焦目标窗口"),
                );
            }
            break;
        }

        let kind = loaded.kind.clone();
        // 守卫以内容为准：只要剪贴板仍是自己的上一次写入（或粘贴前快照），
        // 即使序列号因 Windows 合成格式继续增长也允许写入；内容不符则绝不覆盖。
        let guard = match last_payload.as_ref().or(baseline.as_ref()) {
            Some(reference) => WriteGuard::Content(reference),
            None => WriteGuard::Sequence(last_seq),
        };
        match io.write_guarded(&loaded.payload, guard) {
            Ok(WriteOutcome::Written(final_seq)) => {
                last_seq = final_seq;
                last_payload = Some(loaded.payload.clone());
                wrote_any = true;
                io.note_self_write(final_seq);
                // 序列号不是安全证据：发送按键前必须以内容为准。
                // 若用户在这次写入后立刻复制了新内容，绝不发送按键、绝不覆盖。
                // 「读不到」先重试再判定，避免被本进程采集线程的短暂占用误判为用户接管。
                match match_settled(io, &loaded.payload, cancel) {
                    ClipboardMatch::Same => {}
                    ClipboardMatch::Different => {
                        status = "failed";
                        user_took_over = true;
                        notes.push(format!(
                            "第 {} 项写入后剪贴板已被其他程序更新，未发送按键、未覆盖新内容",
                            idx + 1
                        ));
                        set_state(
                            &mut states,
                            progress,
                            id,
                            idx,
                            ItemState::Failed,
                            sent,
                            &remaining,
                            Some("剪贴板已变化，按键未发送"),
                        );
                        break;
                    }
                    ClipboardMatch::Unavailable => {
                        if canceled(cancel) {
                            status = "cancelled";
                            set_state(
                                &mut states,
                                progress,
                                id,
                                idx,
                                ItemState::Cancelled,
                                sent,
                                &remaining,
                                Some("用户取消（按键未发送）"),
                            );
                        } else {
                            status = "failed";
                            notes.push(format!(
                                "第 {} 项写入后无法读取剪贴板确认内容，未发送按键",
                                idx + 1
                            ));
                            set_state(
                                &mut states,
                                progress,
                                id,
                                idx,
                                ItemState::Failed,
                                sent,
                                &remaining,
                                Some("无法确认剪贴板内容，按键未发送"),
                            );
                        }
                        break;
                    }
                }
                // 写入成功即视为「已消费本项」：即使后续按键失败，恢复任务时也不重发，
                // 避免目标已收到内容却再次粘贴造成重复。
                remaining.retain(|r| r != id);
                set_state(
                    &mut states,
                    progress,
                    id,
                    idx,
                    ItemState::ClipboardWritten,
                    sent,
                    &remaining,
                    None,
                );
            }
            Ok(WriteOutcome::SequenceChanged) => {
                status = "failed";
                user_took_over = true;
                notes.push(format!(
                    "第 {} 项写入前检测到剪贴板已被其他程序更新，本项未写入、也未覆盖新内容",
                    idx + 1
                ));
                set_state(
                    &mut states,
                    progress,
                    id,
                    idx,
                    ItemState::Failed,
                    sent,
                    &remaining,
                    Some("剪贴板已变化，拒绝覆盖"),
                );
                break;
            }
            Err(e) => {
                status = "failed";
                notes.push(format!("第 {} 项写入剪贴板失败：{e}", idx + 1));
                set_state(
                    &mut states,
                    progress,
                    id,
                    idx,
                    ItemState::Failed,
                    sent,
                    &remaining,
                    Some("写入剪贴板失败"),
                );
                break;
            }
        }

        set_state(
            &mut states,
            progress,
            id,
            idx,
            ItemState::InputSent,
            sent,
            &remaining,
            None,
        );
        if let Err(e) = io.send_paste(plan.target.hwnd, plan.target.pid) {
            status = "failed";
            notes.push(format!(
                "第 {} 项按键发送失败：{e}（内容已写入剪贴板，不会自动重发）",
                idx + 1
            ));
            set_state(
                &mut states,
                progress,
                id,
                idx,
                ItemState::Failed,
                sent,
                &remaining,
                Some("按键未发送，条目已从待处理中移除"),
            );
            break;
        }
        sent += 1;
        set_state(
            &mut states,
            progress,
            id,
            idx,
            ItemState::Settling,
            sent,
            &remaining,
            None,
        );
        io.sleep_ms(plan.timing.settle_for(&kind));
        last_kind = Some(kind.clone());
        if canceled(cancel) {
            status = "cancelled";
            // 按键已经发出，不能谎称失败；如实标记为未确认。
            set_state(
                &mut states,
                progress,
                id,
                idx,
                ItemState::Unverified,
                sent,
                &remaining,
                Some("用户取消（该项按键已发出，接收情况未知）"),
            );
            break;
        }
        set_state(
            &mut states,
            progress,
            id,
            idx,
            ItemState::Unverified,
            sent,
            &remaining,
            Some("没有可验证的接收信号"),
        );

        if idx + 1 < plan.item_ids.len()
            && !sleep_cancelable(io, plan.timing.interval_for(&kind), cancel)
        {
            status = "cancelled";
            break;
        }
    }

    if status == "completed" && canceled(cancel) {
        status = "cancelled";
    }

    // 收尾阶段：最后一项写入/按键后仍然给目标留出异步消费窗口，再决定是否恢复。
    let mut restored = false;
    if wrote_any && !user_took_over {
        let grace = plan.timing.finishing_for(last_kind.as_deref());
        // 取消也必须完成这段收尾（上限 900ms），否则最后一张图片可能丢失。
        let grace = if canceled(cancel) {
            grace.min(300)
        } else {
            grace
        };
        io.sleep_ms(grace);
        // 恢复本身在同一剪贴板锁内确认「内容仍是自己最后一次写入」；
        // 序列号增长不作为恢复依据，内容不符则保留用户新内容。
        match last_payload.as_ref() {
            Some(last) => match io.restore_if_own_content(&snapshot, last) {
                Ok(RestoreOutcome::Restored) => {
                    restored = true;
                    notes.push("已恢复粘贴前的剪贴板内容".into());
                }
                Ok(RestoreOutcome::KeepUserCopy) => {
                    notes.push("粘贴期间剪贴板被其他程序更新，未恢复原内容（保留最新内容）".into())
                }
                Ok(RestoreOutcome::NoSnapshot) => {
                    notes.push("粘贴前剪贴板为空或格式不支持，未做恢复".into())
                }
                Err(e) => notes.push(format!("恢复原剪贴板失败：{e}")),
            },
            None => notes.push("粘贴前剪贴板为空或格式不支持，未做恢复".into()),
        }
    }

    PasteRunOutcome {
        status,
        sent,
        skipped,
        remaining,
        restored,
        user_took_over,
        notes,
        states,
    }
}

struct Active {
    job_id: String,
    cancel: Arc<AtomicBool>,
}

/// 粘贴管理器：同一时刻只允许一个活动队列，避免两个线程互相抢剪贴板。
pub struct PasteManager {
    db: Arc<Db>,
    root: PathBuf,
    app: AppHandle,
    self_write: Arc<AtomicU32>,
    active: Arc<Mutex<Option<Active>>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PasteStartReport {
    pub job_id: String,
    pub target: TargetWindow,
    pub total: i64,
    pub interval_ms: u64,
    /// 每类内容的间隔，供 UI 如实展示
    pub intervals: PasteTiming,
}

/// 校验目标窗口（存在、非本应用、权限允许），供 UI 预检与启动共用。
pub fn precheck_target(target_hwnd: isize) -> AppResult<TargetWindow> {
    let target = platform::window_target(target_hwnd)
        .ok_or_else(|| AppError::Validation("目标窗口不存在或已关闭".into()))?;
    if target.pid == std::process::id() {
        return Err(AppError::Validation("不能把本应用作为粘贴目标".into()));
    }
    if platform::target_is_elevated(target.pid) && !platform::current_is_elevated() {
        return Err(AppError::Validation(
            "目标应用以管理员权限运行，本应用无法向其发送粘贴按键；请以管理员身份重启 Task Dock 后重试"
                .into(),
        ));
    }
    Ok(target)
}

impl PasteManager {
    pub fn new(db: Arc<Db>, root: PathBuf, app: AppHandle, self_write: Arc<AtomicU32>) -> Self {
        Self {
            db,
            root,
            app,
            self_write,
            active: Arc::new(Mutex::new(None)),
        }
    }

    pub fn active_job(&self) -> Option<String> {
        self.active
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .map(|a| a.job_id.clone())
    }

    pub fn is_active(&self) -> bool {
        self.active
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_some()
    }

    pub fn precheck(&self, target_hwnd: isize) -> AppResult<TargetWindow> {
        precheck_target(target_hwnd)
    }

    /// 启动整组粘贴。`item_ids` 必须按分组展示顺序传入。
    pub fn start(
        &self,
        group_id: &str,
        target_hwnd: isize,
        item_ids: &[String],
    ) -> AppResult<PasteStartReport> {
        if item_ids.is_empty() {
            return Err(AppError::Validation("没有可粘贴的内容".into()));
        }
        let target = self.precheck(target_hwnd)?;
        self.begin(group_id, target, item_ids.to_vec(), None)
    }

    /// 继续未完成的粘贴任务：只重发 `remaining_items`，累计 sent/total 保持不变。
    pub fn resume(&self, job_id: &str, target_hwnd: isize) -> AppResult<PasteStartReport> {
        let job = store::get_paste_job(&self.db, job_id)?;
        if job.remaining_items.is_empty() {
            return Err(AppError::Validation("该任务没有剩余项目".into()));
        }
        let target = self.precheck(target_hwnd)?;
        self.begin(
            &job.group_id,
            target,
            job.remaining_items.clone(),
            Some((job_id.to_string(), job.total, job.sent)),
        )
    }

    fn begin(
        &self,
        group_id: &str,
        target: TargetWindow,
        item_ids: Vec<String>,
        resume: Option<(String, i64, i64)>,
    ) -> AppResult<PasteStartReport> {
        let mut guard = self.active.lock().unwrap_or_else(|e| e.into_inner());
        if guard.is_some() {
            return Err(AppError::Validation(
                "已有粘贴任务进行中，请先取消或等待完成".into(),
            ));
        }
        let settings = Settings::load_clipboard(&self.db).settings;
        let timing = PasteTiming::from_settings(&settings);

        let (job_id, total, sent) = match &resume {
            Some((id, total, sent)) => {
                store::reset_paste_job(&self.db, id, *sent, &item_ids)?;
                (id.clone(), *total, *sent)
            }
            None => {
                let id = store::create_paste_job(
                    &self.db,
                    group_id,
                    &target.title,
                    &target.exe_path,
                    &item_ids,
                )?;
                (id, item_ids.len() as i64, 0)
            }
        };

        let cancel = Arc::new(AtomicBool::new(false));
        *guard = Some(Active {
            job_id: job_id.clone(),
            cancel: cancel.clone(),
        });
        drop(guard);

        let report = PasteStartReport {
            job_id: job_id.clone(),
            target: target.clone(),
            total,
            interval_ms: timing.text_ms,
            intervals: timing,
        };

        let db = self.db.clone();
        let root = self.root.clone();
        let app = self.app.clone();
        let self_write = self.self_write.clone();
        let active = self.active.clone();
        let job_for_thread = job_id.clone();
        let plan = PastePlan {
            target,
            item_ids: item_ids.clone(),
            total,
            sent_start: sent,
            timing,
        };
        let spawned = std::thread::Builder::new()
            .name("clipboard-paste".into())
            .spawn(move || {
                let fail_db = db.clone();
                let fail_app = app.clone();
                let fail_active = active.clone();
                let fail_job = job_for_thread.clone();
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
                    run_job(
                        db,
                        root,
                        app,
                        self_write,
                        active,
                        job_for_thread,
                        plan,
                        cancel,
                    );
                }));
                if result.is_err() {
                    // 线程 panic 绝不能把任务永远留在「运行中」：如实标记失败并释放互斥。
                    tracing::error!("粘贴线程异常终止，任务 {fail_job} 标记为失败");
                    let (sent, remaining) = store::get_paste_job(&fail_db, &fail_job)
                        .map(|j| (j.sent, j.remaining_items))
                        .unwrap_or((0, Vec::new()));
                    let message = "粘贴线程异常终止（内部错误）；已发送项数与目标接收情况未知";
                    let _ = store::finish_paste_job(
                        &fail_db, &fail_job, "failed", sent, &remaining, message, false,
                    );
                    if let Ok(mut guard) = fail_active.lock() {
                        if guard
                            .as_ref()
                            .map(|a| a.job_id == fail_job)
                            .unwrap_or(false)
                        {
                            *guard = None;
                        }
                    }
                    let _ = fail_app.emit(
                        "clipboard-paste",
                        serde_json::json!({
                            "jobId": fail_job,
                            "status": "failed",
                            "sent": sent,
                            "total": sent + remaining.len() as i64,
                            "pending": remaining.len(),
                            "message": message,
                        }),
                    );
                }
            });
        if let Err(e) = spawned {
            let mut guard = self.active.lock().unwrap_or_else(|x| x.into_inner());
            if guard.as_ref().map(|a| a.job_id == job_id).unwrap_or(false) {
                *guard = None;
            }
            let _ = store::finish_paste_job(
                &self.db,
                &job_id,
                "failed",
                sent,
                &item_ids,
                "无法创建粘贴线程，任务未开始",
                false,
            );
            return Err(AppError::Io(e));
        }
        Ok(report)
    }

    pub fn cancel(&self, job_id: &str) -> AppResult<()> {
        let guard = self.active.lock().unwrap_or_else(|e| e.into_inner());
        match guard.as_ref() {
            Some(a) if a.job_id == job_id => {
                a.cancel.store(true, Ordering::SeqCst);
                Ok(())
            }
            Some(_) => Err(AppError::Validation("该任务不是当前活动任务".into())),
            None => Err(AppError::NotFound("没有正在进行的粘贴任务".into())),
        }
    }

    pub fn cancel_all(&self) {
        if let Some(a) = self
            .active
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
        {
            a.cancel.store(true, Ordering::SeqCst);
        }
    }
}

pub fn payload_for_item(db: &Db, root: &Path, item: &ClipboardItem) -> AppResult<ClipboardPayload> {
    match item.kind.as_str() {
        KIND_IMAGE => {
            let png = store::image_png(db, root, &item.id)
                .ok_or_else(|| AppError::NotFound("图片文件缺失".into()))?;
            Ok(ClipboardPayload::Image {
                png,
                rgba: None,
                width: item.image_width.unwrap_or(0),
                height: item.image_height.unwrap_or(0),
            })
        }
        KIND_FILES => {
            let paths: Vec<String> = item
                .file_paths
                .iter()
                .filter(|p| Path::new(p).is_file())
                .cloned()
                .collect();
            if paths.is_empty() {
                return Err(AppError::NotFound("原文件已不存在".into()));
            }
            Ok(ClipboardPayload::Files { paths })
        }
        KIND_HTML => {
            if item.html.trim().is_empty() {
                return Err(AppError::NotFound("富文本内容为空".into()));
            }
            let text = if item.text.trim().is_empty() {
                engine::html_to_text(&item.html)
            } else {
                item.text.clone()
            };
            Ok(ClipboardPayload::Text {
                text,
                html: Some(item.html.clone()),
            })
        }
        _ => {
            if item.text.trim().is_empty() {
                return Err(AppError::NotFound("文本内容为空".into()));
            }
            Ok(ClipboardPayload::Text {
                text: item.text.clone(),
                html: None,
            })
        }
    }
}

/// HWND 会被系统复用：聚焦/按键前必须确认窗口仍属于启动时校验过的进程。
fn ensure_target_pid(actual: Option<u32>, expected: u32) -> AppResult<()> {
    match actual {
        Some(pid) if pid == expected => Ok(()),
        _ => Err(AppError::Validation(
            "目标窗口已关闭或已被其他窗口复用，已停止发送".into(),
        )),
    }
}

/// 按键前的最终门：仍是同一进程且仍在前台（写入期间焦点可能被抢走）。
fn ensure_send_target(
    actual_pid: Option<u32>,
    expected_pid: u32,
    foreground: bool,
) -> AppResult<()> {
    ensure_target_pid(actual_pid, expected_pid)?;
    if !foreground {
        return Err(AppError::Validation(
            "目标窗口已失去焦点，按键未发送".into(),
        ));
    }
    Ok(())
}

fn focus_target(hwnd: isize, pid: u32, cancel: &AtomicBool) -> AppResult<()> {
    ensure_target_pid(platform::window_pid(hwnd), pid)?;
    for attempt in 0..3 {
        if canceled(cancel) {
            return Err(AppError::Validation("已取消".into()));
        }
        let _ = crate::navigation::window_manager::focus_window(hwnd);
        for _ in 0..10 {
            ensure_target_pid(platform::window_pid(hwnd), pid)?;
            if platform::is_foreground(hwnd) {
                return Ok(());
            }
            if canceled(cancel) {
                return Err(AppError::Validation("已取消".into()));
            }
            std::thread::sleep(Duration::from_millis(60));
        }
        if attempt < 2 {
            std::thread::sleep(Duration::from_millis(150));
        }
    }
    Err(AppError::Validation(
        "无法将目标窗口切换到前台（可能被系统焦点保护拦截）".into(),
    ))
}

struct PlatformIo {
    self_write: Arc<AtomicU32>,
}

impl PasteIo for PlatformIo {
    fn sequence(&self) -> u32 {
        platform::current_sequence()
    }

    fn clipboard_match(&self, expected: &ClipboardPayload) -> ClipboardMatch {
        let result = platform::clipboard_match(expected);
        tracing::debug!("逐项粘贴：发送前内容比对 {:?}", result);
        result
    }

    fn snapshot(&self) -> Snapshot {
        platform::snapshot()
    }

    fn target_alive(&self, hwnd: isize) -> bool {
        platform::window_pid(hwnd).is_some()
    }

    fn focus(&self, hwnd: isize, pid: u32, cancel: &AtomicBool) -> AppResult<()> {
        let result = focus_target(hwnd, pid, cancel);
        if result.is_ok() {
            tracing::debug!("逐项粘贴：目标窗口已在前台 hwnd={hwnd}");
        }
        result
    }

    fn write_guarded(
        &self,
        payload: &ClipboardPayload,
        guard: WriteGuard<'_>,
    ) -> AppResult<WriteOutcome> {
        // 自写序列号在剪贴板访问锁内登记，采集线程不会在本进程写入后重复占用剪贴板。
        let outcome = platform::write_guarded_notifying(payload, guard, &self.self_write);
        if let Ok(WriteOutcome::Written(seq)) = &outcome {
            tracing::debug!("逐项粘贴：写入剪贴板完成 seq={seq}");
        }
        outcome
    }

    fn send_paste(&self, hwnd: isize, pid: u32) -> AppResult<()> {
        // HWND 复用与焦点被抢都会让按键落到别的窗口：发送前用 PID + 前台双重核对。
        ensure_send_target(
            platform::window_pid(hwnd),
            pid,
            platform::is_foreground(hwnd),
        )?;
        if let Some(fg) = platform::foreground_target() {
            tracing::debug!("逐项粘贴：按键将发往前台窗口 {} pid={}", fg.title, fg.pid);
        }
        let result = platform::send_ctrl_v();
        if result.is_ok() {
            tracing::debug!("逐项粘贴：Ctrl+V 已发送");
        }
        result
    }

    fn restore_if_own_content(
        &self,
        snapshot: &Snapshot,
        last_written: &ClipboardPayload,
    ) -> AppResult<RestoreOutcome> {
        platform::restore_if_own_content(snapshot, last_written, &self.self_write)
    }

    fn note_self_write(&self, sequence: u32) {
        platform::note_self_write_watermark(&self.self_write, sequence);
    }

    fn sleep_ms(&self, ms: u64) {
        std::thread::sleep(Duration::from_millis(ms));
    }
}

#[allow(clippy::too_many_arguments)]
fn run_job(
    db: Arc<Db>,
    root: PathBuf,
    app: AppHandle,
    self_write: Arc<AtomicU32>,
    active: Arc<Mutex<Option<Active>>>,
    job_id: String,
    plan: PastePlan,
    cancel: Arc<AtomicBool>,
) {
    let io = PlatformIo { self_write };
    let total = plan.total;
    let mut load = |id: &str| -> AppResult<LoadedPayload> {
        let item = store::get_item(&db, id)?;
        let payload = payload_for_item(&db, &root, &item)?;
        Ok(LoadedPayload {
            kind: item.kind,
            payload,
        })
    };
    let mut progress = |p: &PasteProgress| {
        let _ = store::update_paste_job(&db, &job_id, p.sent, p.remaining, "运行中");
        let _ = app.emit(
            "clipboard-paste",
            serde_json::json!({
                "jobId": job_id,
                "status": "running",
                "sent": p.sent,
                "total": p.total,
                "pending": p.remaining.len(),
                "itemId": p.item_id,
                "itemIndex": p.index,
                "itemState": p.state.as_str(),
                "message": p.note,
            }),
        );
    };

    let outcome = run_plan(&io, &plan, &cancel, &mut load, &mut progress);

    let mut message = format!(
        "已发送 {}/{} 项粘贴动作；目标应用是否接收无法自动验证",
        outcome.sent, total
    );
    if outcome.sent > 0 {
        message.push_str(&format!(
            "（{} 项未确认，{} 项有接收信号）",
            outcome.unverified(),
            outcome.confirmed()
        ));
    }
    if outcome.skipped > 0 {
        message.push_str(&format!("；跳过 {} 项（内容不可用）", outcome.skipped));
    }
    match outcome.status {
        "cancelled" => message.push_str("；用户已取消"),
        "failed" => message.push_str("；任务已停止"),
        _ => {}
    }
    if !outcome.notes.is_empty() {
        message.push('。');
        message.push_str(&outcome.notes.join("；"));
    }

    let _ = store::finish_paste_job(
        &db,
        &job_id,
        outcome.status,
        outcome.sent,
        &outcome.remaining,
        &message,
        outcome.restored,
    );
    if let Ok(mut guard) = active.lock() {
        if guard.as_ref().map(|a| a.job_id == job_id).unwrap_or(false) {
            *guard = None;
        }
    }
    let _ = app.emit(
        "clipboard-paste",
        serde_json::json!({
            "jobId": job_id,
            "status": outcome.status,
            "sent": outcome.sent,
            "total": total,
            "pending": outcome.remaining.len(),
            "message": message,
            "restored": outcome.restored,
            "userTookOver": outcome.user_took_over,
            "confirmed": outcome.confirmed(),
            "unverified": outcome.unverified(),
        }),
    );
    tracing::info!(
        "粘贴任务结束：status={} sent={}/{} skipped={} restored={} unverified={}",
        outcome.status,
        outcome.sent,
        total,
        outcome.skipped,
        outcome.restored,
        outcome.unverified()
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clipboard::KIND_TEXT;
    use std::cell::{Cell, RefCell};

    struct FakeIo {
        seq: Cell<u32>,
        snap_seq: u32,
        current: RefCell<Option<ClipboardPayload>>,
        target_alive: Cell<bool>,
        focus_error: RefCell<Option<String>>,
        send_fails: Cell<bool>,
        force_sequence_changed: Cell<bool>,
        external_after_writes: Cell<usize>,
        takeover_before_send_after_writes: Cell<usize>,
        settle_after_writes: Cell<usize>,
        unavailable_reads: Cell<u32>,
        restore_result: RefCell<RestoreOutcome>,
        applied: Cell<usize>,
        writes: RefCell<Vec<String>>,
        payloads: RefCell<Vec<ClipboardPayload>>,
        guards: RefCell<Vec<String>>,
        restores: RefCell<Vec<String>>,
        sleeps: RefCell<Vec<u64>>,
        timeline: RefCell<Vec<String>>,
    }

    fn baseline_payload() -> ClipboardPayload {
        ClipboardPayload::Text {
            text: "原剪贴板".into(),
            html: None,
        }
    }

    fn user_payload() -> ClipboardPayload {
        ClipboardPayload::Text {
            text: "用户新内容".into(),
            html: None,
        }
    }

    impl FakeIo {
        fn new(seq: u32) -> Self {
            Self {
                seq: Cell::new(seq),
                snap_seq: seq,
                current: RefCell::new(Some(baseline_payload())),
                target_alive: Cell::new(true),
                focus_error: RefCell::new(None),
                send_fails: Cell::new(false),
                force_sequence_changed: Cell::new(false),
                external_after_writes: Cell::new(0),
                takeover_before_send_after_writes: Cell::new(0),
                settle_after_writes: Cell::new(0),
                unavailable_reads: Cell::new(0),
                restore_result: RefCell::new(RestoreOutcome::Restored),
                applied: Cell::new(0),
                writes: RefCell::new(Vec::new()),
                payloads: RefCell::new(Vec::new()),
                guards: RefCell::new(Vec::new()),
                restores: RefCell::new(Vec::new()),
                sleeps: RefCell::new(Vec::new()),
                timeline: RefCell::new(Vec::new()),
            }
        }
    }

    fn payload_text(p: &ClipboardPayload) -> String {
        match p {
            ClipboardPayload::Text { text, .. } => text.clone(),
            _ => "other".into(),
        }
    }

    impl PasteIo for FakeIo {
        fn sequence(&self) -> u32 {
            self.seq.get()
        }

        fn clipboard_match(&self, expected: &ClipboardPayload) -> ClipboardMatch {
            if self.unavailable_reads.get() > 0 {
                self.unavailable_reads.set(self.unavailable_reads.get() - 1);
                return ClipboardMatch::Unavailable;
            }
            if self.current.borrow().as_ref() == Some(expected) {
                ClipboardMatch::Same
            } else {
                ClipboardMatch::Different
            }
        }

        fn snapshot(&self) -> Snapshot {
            Snapshot {
                sequence: self.snap_seq,
                payload: Some(baseline_payload()),
            }
        }

        fn target_alive(&self, _hwnd: isize) -> bool {
            self.target_alive.get()
        }

        fn focus(&self, _hwnd: isize, _pid: u32, _cancel: &AtomicBool) -> AppResult<()> {
            match self.focus_error.borrow().as_deref() {
                Some(e) => Err(AppError::Validation(e.into())),
                None => Ok(()),
            }
        }

        fn write_guarded(
            &self,
            payload: &ClipboardPayload,
            guard: WriteGuard<'_>,
        ) -> AppResult<WriteOutcome> {
            let text = payload_text(payload);
            self.guards.borrow_mut().push(match &guard {
                WriteGuard::Content(p) => format!("content:{}", payload_text(p)),
                WriteGuard::Sequence(seq) => format!("seq:{seq}"),
                WriteGuard::Unconditional => "unconditional".into(),
            });
            self.writes.borrow_mut().push(text.clone());
            self.payloads.borrow_mut().push(payload.clone());
            self.timeline.borrow_mut().push(format!("write:{text}"));
            if self.force_sequence_changed.get() {
                self.seq.set(self.seq.get() + 1);
                *self.current.borrow_mut() = Some(user_payload());
                return Ok(WriteOutcome::SequenceChanged);
            }
            let allowed = match &guard {
                WriteGuard::Unconditional => true,
                WriteGuard::Sequence(expected) => *expected == self.seq.get(),
                WriteGuard::Content(expected) => self.current.borrow().as_ref() == Some(*expected),
            };
            if !allowed {
                return Ok(WriteOutcome::SequenceChanged);
            }
            self.seq.set(self.seq.get() + 1);
            *self.current.borrow_mut() = Some(payload.clone());
            self.applied.set(self.applied.get() + 1);
            // 返回 CloseClipboard 后立刻读到的序列号；后续增长模拟延迟渲染
            let final_seq = self.seq.get();
            if self.takeover_before_send_after_writes.get() == self.applied.get() {
                self.seq.set(final_seq + 1);
                *self.current.borrow_mut() = Some(user_payload());
            } else if self.settle_after_writes.get() > 0
                && self.settle_after_writes.get() >= self.applied.get()
            {
                // 模拟 Windows 在 CloseClipboard 之后继续递增序列号，内容仍是自己的
                self.seq.set(final_seq + 3);
            }
            Ok(WriteOutcome::Written(final_seq))
        }

        fn send_paste(&self, _hwnd: isize, _pid: u32) -> AppResult<()> {
            self.timeline.borrow_mut().push("send".into());
            if self.send_fails.get() {
                return Err(AppError::Validation("按键被拦截".into()));
            }
            if self.external_after_writes.get() == self.applied.get() {
                // 模拟用户在按键已发出后复制了新内容
                self.seq.set(self.seq.get() + 1);
                *self.current.borrow_mut() = Some(user_payload());
            }
            Ok(())
        }

        fn restore_if_own_content(
            &self,
            _snapshot: &Snapshot,
            last_written: &ClipboardPayload,
        ) -> AppResult<RestoreOutcome> {
            self.timeline.borrow_mut().push("restore".into());
            if self.current.borrow().as_ref() != Some(last_written) {
                return Ok(RestoreOutcome::KeepUserCopy);
            }
            let r = *self.restore_result.borrow();
            if r == RestoreOutcome::Restored {
                // 恢复后剪贴板回到初始快照内容
                *self.current.borrow_mut() = Some(baseline_payload());
                self.seq.set(self.seq.get() + 1);
                self.restores.borrow_mut().push(payload_text(last_written));
                self.timeline.borrow_mut().push("restored".into());
            }
            Ok(r)
        }

        fn note_self_write(&self, _sequence: u32) {}

        fn sleep_ms(&self, ms: u64) {
            self.sleeps.borrow_mut().push(ms);
            self.timeline.borrow_mut().push(format!("sleep:{ms}"));
        }
    }

    fn plan(ids: &[&str], timing: PasteTiming) -> PastePlan {
        PastePlan {
            target: TargetWindow {
                hwnd: 42,
                pid: 4242,
                title: "测试窗口".into(),
                exe_path: "test.exe".into(),
            },
            item_ids: ids.iter().map(|s| s.to_string()).collect(),
            total: ids.len() as i64,
            sent_start: 0,
            timing,
        }
    }

    fn timing() -> PasteTiming {
        PasteTiming {
            text_ms: 350,
            html_ms: 600,
            image_ms: 1200,
            files_ms: 900,
        }
    }

    fn loader(
        kinds: &[(&'static str, &'static str)],
    ) -> impl FnMut(&str) -> AppResult<LoadedPayload> {
        let map: std::collections::HashMap<String, (String, String)> = kinds
            .iter()
            .map(|(id, kind)| (id.to_string(), (id.to_string(), kind.to_string())))
            .collect();
        move |id: &str| {
            let (text, kind) = map
                .get(id)
                .cloned()
                .ok_or_else(|| AppError::NotFound("missing".into()))?;
            Ok(LoadedPayload {
                kind,
                payload: ClipboardPayload::Text { text, html: None },
            })
        }
    }

    fn noop_progress(_: &PasteProgress) {}

    #[test]
    fn text_image_text_keeps_order_and_never_claims_confirmed() {
        let io = FakeIo::new(5);
        let p = plan(&["a", "b", "c"], timing());
        let mut load = loader(&[("a", KIND_TEXT), ("b", KIND_IMAGE), ("c", KIND_TEXT)]);
        let cancel = AtomicBool::new(false);
        let outcome = run_plan(&io, &p, &cancel, &mut load, &mut noop_progress);
        assert_eq!(outcome.status, "completed");
        assert_eq!(outcome.sent, 3);
        assert_eq!(
            io.writes
                .borrow()
                .iter()
                .map(|t| t.as_str())
                .collect::<Vec<_>>(),
            vec!["a", "b", "c"]
        );
        assert_eq!(outcome.confirmed(), 0, "没有接收信号时绝不能标记 confirmed");
        assert_eq!(outcome.unverified(), 3);
        assert_eq!(
            outcome
                .states
                .iter()
                .filter(|(_, s)| *s == ItemState::Unverified)
                .count(),
            3
        );
        assert!(outcome.restored);
        // 图片的观察窗口比文本长，且最后一项有独立收尾睡眠
        assert!(io.sleeps.borrow().contains(&600));
        let timeline = io.timeline.borrow();
        let last_write = timeline
            .iter()
            .rposition(|e| e == "write:c")
            .expect("最后一项写入");
        let restore = timeline.iter().rposition(|e| e == "restore").expect("恢复");
        assert!(
            timeline[last_write..restore]
                .iter()
                .any(|e| e.starts_with("sleep:")),
            "恢复前必须有独立收尾阶段"
        );
    }

    #[test]
    fn each_write_is_guarded_by_the_last_own_content() {
        let io = FakeIo::new(7);
        let p = plan(&["a", "b"], timing());
        let mut load = loader(&[("a", KIND_TEXT), ("b", KIND_TEXT)]);
        let cancel = AtomicBool::new(false);
        let outcome = run_plan(&io, &p, &cancel, &mut load, &mut noop_progress);
        assert_eq!(outcome.sent, 2);
        let guards = io.guards.borrow();
        assert_eq!(
            guards[0], "content:原剪贴板",
            "首项写入以初始快照内容为守卫"
        );
        assert_eq!(guards[1], "content:a", "后续写入以自己的上一次写入为守卫");
        assert_eq!(
            io.restores.borrow()[0],
            "b",
            "只在自己最后一次写入仍可见时恢复"
        );
    }

    #[test]
    fn cancel_preserves_unprocessed_items_and_still_finishes() {
        let io = FakeIo::new(1);
        let p = plan(&["a", "b", "c"], timing());
        let mut load = loader(&[("a", KIND_TEXT), ("b", KIND_TEXT), ("c", KIND_TEXT)]);
        let cancel = AtomicBool::new(false);
        let mut progress = |pr: &PasteProgress| {
            if pr.item_id == "a" && pr.state == ItemState::Settling {
                cancel.store(true, Ordering::SeqCst);
            }
        };
        let outcome = run_plan(&io, &p, &cancel, &mut load, &mut progress);
        assert_eq!(outcome.status, "cancelled");
        assert_eq!(outcome.sent, 1);
        assert_eq!(outcome.remaining, vec!["b".to_string(), "c".to_string()]);
        assert!(outcome.restored, "取消后仍需恢复原剪贴板");
        assert_eq!(io.applied.get(), 1, "取消后不得继续写入");
    }

    #[test]
    fn sequence_race_between_check_and_write_never_overwrites() {
        let io = FakeIo::new(3);
        let p = plan(&["a"], timing());
        let mut load = loader(&[("a", KIND_TEXT)]);
        let cancel = AtomicBool::new(false);
        io.force_sequence_changed.set(true);
        let outcome = run_plan(&io, &p, &cancel, &mut load, &mut noop_progress);
        assert_eq!(outcome.status, "failed");
        assert!(outcome.user_took_over);
        assert_eq!(io.applied.get(), 0, "序列号不匹配时不允许实际写入");
        assert_eq!(io.restores.borrow().len(), 0, "用户接管后绝不恢复");
        assert!(outcome.notes.iter().any(|n| n.contains("未写入")));
    }

    #[test]
    fn external_update_between_items_stops_without_restore() {
        let io = FakeIo::new(1);
        let p = plan(&["a", "b"], timing());
        let mut load = loader(&[("a", KIND_TEXT), ("b", KIND_TEXT)]);
        let cancel = AtomicBool::new(false);
        io.external_after_writes.set(1);
        let outcome = run_plan(&io, &p, &cancel, &mut load, &mut noop_progress);
        assert_eq!(outcome.status, "failed");
        assert!(outcome.user_took_over);
        assert_eq!(outcome.sent, 1);
        assert_eq!(io.applied.get(), 1);
        assert!(io.restores.borrow().is_empty());
    }

    #[test]
    fn post_write_sequence_settling_does_not_abort_multi_item_paste() {
        let io = FakeIo::new(20);
        // 真实 Windows 会在 CloseClipboard 后继续递增序列号；内容仍是自己的写入
        io.settle_after_writes.set(usize::MAX);
        let p = plan(&["a", "b", "c"], timing());
        let mut load = loader(&[("a", KIND_TEXT), ("b", KIND_TEXT), ("c", KIND_TEXT)]);
        let cancel = AtomicBool::new(false);
        let outcome = run_plan(&io, &p, &cancel, &mut load, &mut noop_progress);
        assert_eq!(outcome.status, "completed");
        assert_eq!(outcome.sent, 3, "序列号自然增长不得中止后续项");
        assert!(!outcome.user_took_over);
        assert!(outcome.restored, "内容确认后仍应恢复原剪贴板");
        assert_eq!(io.applied.get(), 3);
    }

    #[test]
    fn user_copy_after_write_blocks_key_and_preserves_new_content() {
        let io = FakeIo::new(30);
        io.takeover_before_send_after_writes.set(1);
        let p = plan(&["a", "b"], timing());
        let mut load = loader(&[("a", KIND_TEXT), ("b", KIND_TEXT)]);
        let cancel = AtomicBool::new(false);
        let outcome = run_plan(&io, &p, &cancel, &mut load, &mut noop_progress);
        assert_eq!(outcome.status, "failed");
        assert!(outcome.user_took_over);
        assert_eq!(outcome.sent, 0);
        assert_eq!(io.applied.get(), 1, "写入已发生，但按键不得发送");
        assert!(
            !io.timeline.borrow().iter().any(|e| e == "send"),
            "用户新复制的内容绝不能被 Ctrl+V 发出"
        );
        assert!(io.restores.borrow().is_empty(), "用户接管后绝不恢复");
        assert_eq!(
            outcome.remaining,
            vec!["a".to_string(), "b".to_string()],
            "未发送的条目不应当被标记为已消费"
        );
    }

    #[test]
    fn focus_failure_keeps_item_pending() {
        let io = FakeIo::new(1);
        *io.focus_error.borrow_mut() = Some("焦点保护".into());
        let p = plan(&["a", "b"], timing());
        let mut load = loader(&[("a", KIND_TEXT), ("b", KIND_TEXT)]);
        let cancel = AtomicBool::new(false);
        let outcome = run_plan(&io, &p, &cancel, &mut load, &mut noop_progress);
        assert_eq!(outcome.status, "failed");
        assert_eq!(outcome.remaining, vec!["a".to_string(), "b".to_string()]);
        assert_eq!(io.applied.get(), 0);
    }

    #[test]
    fn closed_target_fails_without_writes() {
        let io = FakeIo::new(1);
        io.target_alive.set(false);
        let p = plan(&["a"], timing());
        let mut load = loader(&[("a", KIND_TEXT)]);
        let cancel = AtomicBool::new(false);
        let outcome = run_plan(&io, &p, &cancel, &mut load, &mut noop_progress);
        assert_eq!(outcome.status, "failed");
        assert_eq!(io.writes.borrow().len(), 0);
    }

    #[test]
    fn reused_or_unfocused_target_is_rejected_before_pressing_keys() {
        assert!(ensure_send_target(Some(42), 42, true).is_ok());
        let reused = ensure_send_target(Some(43), 42, true).unwrap_err();
        assert!(reused.to_string().contains("复用"), "{reused}");
        let gone = ensure_send_target(None, 42, true).unwrap_err();
        assert!(gone.to_string().contains("关闭"), "{gone}");
        let unfocused = ensure_send_target(Some(42), 42, false).unwrap_err();
        assert!(unfocused.to_string().contains("焦点"), "{unfocused}");
        assert!(ensure_target_pid(Some(42), 42).is_ok());
        assert!(ensure_target_pid(Some(7), 42).is_err());
        assert!(ensure_target_pid(None, 42).is_err());
    }

    #[test]
    fn send_failure_removes_written_item_to_prevent_duplicate_paste() {
        let io = FakeIo::new(1);
        io.send_fails.set(true);
        let p = plan(&["a", "b"], timing());
        let mut load = loader(&[("a", KIND_TEXT), ("b", KIND_TEXT)]);
        let cancel = AtomicBool::new(false);
        let outcome = run_plan(&io, &p, &cancel, &mut load, &mut noop_progress);
        assert_eq!(outcome.status, "failed");
        assert_eq!(outcome.sent, 0);
        assert_eq!(outcome.remaining, vec!["b".to_string()]);
        assert_eq!(io.applied.get(), 1);
        assert!(outcome.restored, "写入过剪贴板时仍应尝试恢复");
    }

    #[test]
    fn unavailable_item_is_skipped_and_others_continue() {
        let io = FakeIo::new(1);
        let p = plan(&["a", "missing", "c"], timing());
        let mut load = loader(&[("a", KIND_TEXT), ("c", KIND_TEXT)]);
        let cancel = AtomicBool::new(false);
        let outcome = run_plan(&io, &p, &cancel, &mut load, &mut noop_progress);
        assert_eq!(outcome.status, "completed");
        assert_eq!(outcome.sent, 2);
        assert_eq!(outcome.skipped, 1);
        assert!(
            outcome.remaining.is_empty(),
            "内容不可用的条目已从待处理中移除，避免恢复任务时反复失败"
        );
        assert_eq!(outcome.states.len(), 3);
    }

    #[test]
    fn restore_failure_is_reported_honestly() {
        let io = FakeIo::new(1);
        *io.restore_result.borrow_mut() = RestoreOutcome::KeepUserCopy;
        let p = plan(&["a"], timing());
        let mut load = loader(&[("a", KIND_TEXT)]);
        let cancel = AtomicBool::new(false);
        let outcome = run_plan(&io, &p, &cancel, &mut load, &mut noop_progress);
        assert!(!outcome.restored);
        assert!(outcome.notes.iter().any(|n| n.contains("未恢复")));
    }

    #[test]
    fn per_type_intervals_and_settle_are_conservative() {
        let t = timing();
        assert_eq!(t.interval_for(KIND_TEXT), 350);
        assert_eq!(t.interval_for(KIND_IMAGE), 1200);
        assert_eq!(t.interval_for(KIND_HTML), 600);
        assert_eq!(t.interval_for(KIND_FILES), 900);
        assert_eq!(t.settle_for(KIND_IMAGE), 600);
        assert_eq!(t.settle_for(KIND_TEXT), 175);
        assert!(t.finishing_for(Some(KIND_IMAGE)) >= t.settle_for(KIND_IMAGE));

        let settings = Settings {
            clipboard_paste_interval_image_ms: 9999,
            ..Default::default()
        };
        let clamped = PasteTiming::from_settings(&settings);
        assert_eq!(clamped.image_ms, 5000, "间隔必须有上界，避免隐藏的无限等待");
    }

    #[test]
    fn resumed_plan_does_not_retry_consumed_items() {
        let io = FakeIo::new(10);
        let mut p = plan(&["b", "c"], timing());
        p.sent_start = 1;
        p.total = 3;
        let mut load = loader(&[("b", KIND_TEXT), ("c", KIND_TEXT)]);
        let cancel = AtomicBool::new(false);
        let outcome = run_plan(&io, &p, &cancel, &mut load, &mut noop_progress);
        assert_eq!(outcome.sent, 3);
        assert!(outcome.remaining.is_empty());
        assert_eq!(io.writes.borrow().len(), 2, "只重发剩余项，不重发已消费项");
    }

    #[test]
    fn unreadable_clipboard_is_retried_and_does_not_stop_the_job() {
        // 真机证据：采集线程/第三方程序短暂占用剪贴板会让 OpenClipboard 失败，
        // 旧实现把它当成「用户接管」，在第 2 项误停。
        let io = FakeIo::new(1);
        io.unavailable_reads.set(3);
        let p = plan(&["a", "b"], timing());
        let mut load = loader(&[("a", KIND_TEXT), ("b", KIND_TEXT)]);
        let cancel = AtomicBool::new(false);
        let outcome = run_plan(&io, &p, &cancel, &mut load, &mut noop_progress);
        assert_eq!(outcome.status, "completed");
        assert_eq!(outcome.sent, 2);
        assert!(!outcome.user_took_over, "读不到不等于用户接管");
        assert!(outcome.restored);
    }

    #[test]
    fn persistently_unreadable_clipboard_stops_before_sending_keys() {
        let io = FakeIo::new(1);
        io.unavailable_reads.set(1000);
        let p = plan(&["a", "b"], timing());
        let mut load = loader(&[("a", KIND_TEXT), ("b", KIND_TEXT)]);
        let cancel = AtomicBool::new(false);
        let outcome = run_plan(&io, &p, &cancel, &mut load, &mut noop_progress);
        assert_eq!(outcome.status, "failed");
        assert_eq!(outcome.sent, 0);
        assert!(!outcome.user_took_over);
        assert!(
            outcome.notes.iter().any(|n| n.contains("无法读取剪贴板")),
            "notes={:?}",
            outcome.notes
        );
        assert!(
            !io.timeline.borrow().iter().any(|e| e == "send"),
            "无法确认剪贴板内容时绝不发送按键"
        );
        assert_eq!(
            outcome.remaining,
            vec!["a".to_string(), "b".to_string()],
            "按键未发送的条目不应当被标记为已消费"
        );
        assert!(outcome.restored, "写入过剪贴板且按键未发送时应恢复原内容");
        assert_eq!(io.restores.borrow().as_slice(), ["a".to_string()]);
    }

    fn solid_capture(color: [u8; 4], w: u32, h: u32) -> crate::clipboard::CapturedContent {
        use crate::clipboard::{CapturedContent, CapturedImage};
        let rgba: Vec<u8> = color
            .iter()
            .copied()
            .cycle()
            .take((w * h * 4) as usize)
            .collect();
        CapturedContent {
            kind: crate::clipboard::KIND_IMAGE.into(),
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
    fn red_green_text_blue_pastes_each_item_in_order_with_exact_pixels() {
        use crate::clipboard::{image, store, CapturedContent, KIND_TEXT};
        let root = std::env::temp_dir().join(format!("td-paste-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let db = Db::open_in_memory().unwrap();
        let settings = crate::db::Settings::default();

        let text = CapturedContent {
            kind: KIND_TEXT.into(),
            text: "文本 C".into(),
            html: String::new(),
            preview: String::new(),
            file_paths: vec![],
            image: None,
            source_app: "notepad.exe".into(),
            source_title: "记事本".into(),
            byte_size: 0,
        };
        let colors = [
            ([220u8, 40, 40, 255], 37u32, 23u32),
            ([40, 180, 80, 255], 53, 31),
            ([40, 80, 220, 255], 61, 17),
        ];
        let a = store::record_capture(
            &db,
            &root,
            &solid_capture(colors[0].0, colors[0].1, colors[0].2),
            &settings,
        )
        .unwrap();
        let b = store::record_capture(
            &db,
            &root,
            &solid_capture(colors[1].0, colors[1].1, colors[1].2),
            &settings,
        )
        .unwrap();
        let c = store::record_capture(&db, &root, &text, &settings).unwrap();
        let d = store::record_capture(
            &db,
            &root,
            &solid_capture(colors[2].0, colors[2].1, colors[2].2),
            &settings,
        )
        .unwrap();
        let gid = a.group_id.clone().expect("首张图片应建组");
        let group = store::get_group(&db, &gid).unwrap();
        assert_eq!(
            group
                .items
                .iter()
                .map(|i| i.id.as_str())
                .collect::<Vec<_>>(),
            vec![
                a.item.id.as_str(),
                b.item.id.as_str(),
                c.item.id.as_str(),
                d.item.id.as_str()
            ],
            "A/B/C/D 顺序必须与复制顺序一致"
        );

        let mut p = plan(&[], timing());
        p.item_ids = group.items.iter().map(|i| i.id.clone()).collect();
        p.total = p.item_ids.len() as i64;
        let mut load = |id: &str| -> AppResult<LoadedPayload> {
            let item = store::get_item(&db, id)?;
            Ok(LoadedPayload {
                payload: payload_for_item(&db, &root, &item)?,
                kind: item.kind,
            })
        };
        let io = FakeIo::new(7);
        let cancel = AtomicBool::new(false);
        let outcome = run_plan(&io, &p, &cancel, &mut load, &mut noop_progress);
        assert_eq!(outcome.status, "completed");
        assert_eq!(outcome.sent, 4);
        assert_eq!(outcome.skipped, 0);
        assert!(outcome.restored);

        let payloads = io.payloads.borrow();
        assert_eq!(payloads.len(), 4);
        for (idx, (expected, w, h)) in colors.iter().enumerate() {
            let image_idx = if idx < 2 { idx } else { 3 };
            match &payloads[image_idx] {
                ClipboardPayload::Image {
                    png, width, height, ..
                } => {
                    assert_eq!((*width, *height), (*w, *h));
                    let (rgba, pw, ph) = image::decode_png_rgba(png).unwrap();
                    assert_eq!((pw, ph), (*w, *h));
                    assert_eq!(&rgba[0..4], expected.as_slice());
                    assert!(
                        rgba.chunks_exact(4).all(|px| px == expected.as_slice()),
                        "第 {} 张图片写入剪贴板的像素必须与复制时一致",
                        image_idx + 1
                    );
                }
                other => panic!("第 {} 项应为图片，实际 {:?}", image_idx + 1, other),
            }
        }
        match &payloads[2] {
            ClipboardPayload::Text { text, html } => {
                assert_eq!(text, "文本 C");
                assert!(html.is_none());
            }
            other => panic!("第 3 项应为文本，实际 {:?}", other),
        }
        let timeline = io.timeline.borrow();
        let events: Vec<&str> = timeline
            .iter()
            .filter(|e| e.starts_with("write:") || e.as_str() == "send")
            .map(String::as_str)
            .collect();
        assert_eq!(events.len(), 8, "四项各一次写入 + 一次按键");
        for chunk in events.chunks(2) {
            assert!(chunk[0].starts_with("write:"));
            assert_eq!(chunk[1], "send", "必须逐项写入后立即粘贴，不能批量发送");
        }
        let _ = std::fs::remove_dir_all(&root);
    }
}
