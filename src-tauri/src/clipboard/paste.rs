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
use std::sync::{mpsc, Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use super::engine;
use super::platform::{
    self, ClipboardMatch, ClipboardPayload, RestoreOutcome, Snapshot, SnapshotState, TargetWindow,
    WriteGuard, WriteOutcome,
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
    /// 按键正在投递：已写入剪贴板、即将/正在调用 SendInput。
    /// 这一状态必须在按键之前落库——它是「可能已经产生外部副作用」的崩溃锚点。
    Dispatching,
    InputSent,
    Settling,
    /// 仅在存在可验证的接收信号时使用；当前第三方应用普遍不提供。
    Confirmed,
    /// 动作已发送，但没有可靠证据表明目标已接收。
    Unverified,
    Failed,
    /// 内容确实不可用（读取失败/文件已删除），本项不发送也不进待处理队列。
    Skipped,
    /// 按键可能已经发出、也可能没有：不能自动重发，必须用户确认后才能再试。
    Uncertain,
    Cancelled,
}

impl ItemState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Preparing => "preparing",
            Self::ClipboardWritten => "clipboard_written",
            Self::Dispatching => "dispatching",
            Self::InputSent => "input_sent",
            Self::Settling => "settling",
            Self::Confirmed => "confirmed",
            Self::Unverified => "unverified",
            Self::Failed => "failed",
            Self::Skipped => "skipped",
            Self::Uncertain => "uncertain",
            Self::Cancelled => "cancelled",
        }
    }

    fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Confirmed
                | Self::Unverified
                | Self::Failed
                | Self::Skipped
                | Self::Uncertain
                | Self::Cancelled
        )
    }

    /// 这一项是否会占用「待处理」队列：只有确认/未确认/跳过/不确定/取消 不再重发。
    #[allow(dead_code)]
    fn consumed(self) -> bool {
        matches!(
            self,
            Self::Confirmed | Self::Unverified | Self::Skipped | Self::Uncertain | Self::Cancelled
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
    fn target_pid(&self, hwnd: isize) -> Option<u32>;
    /// 目标当前是否处于前台。运行期只读取，绝不主动激活（SetForegroundWindow 只在
    /// 用户点击开始时执行一次）。
    fn is_foreground(&self, hwnd: isize) -> bool;
    /// 用户点击「开始」时主动把目标置前一次；自动循环中不得再次调用。
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
    /// 按键可能已发出但结果不可证明的条目：不自动重发，必须用户确认。
    pub uncertain: Vec<String>,
    pub restored: bool,
    pub user_took_over: bool,
    /// 暂停原因：user_switched / target_closed / hwnd_reused / focus_denied。
    pub pause_reason: Option<&'static str>,
    /// 失败原因码（与诊断契约的 error_code 同形），供前端与诊断区分场景。
    pub reason_code: Option<&'static str>,
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

/// 目标窗口的运行期状态。四种情况必须分开处理，不能统一归成「聚焦失败」：
/// 用户切走要暂停并可继续；窗口关闭/句柄复用必须停止；权限或焦点保护要给出可操作提示。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TargetIssue {
    Closed,
    Reused,
    NotForeground,
}

fn inspect_target(io: &dyn PasteIo, target: &TargetWindow) -> Option<TargetIssue> {
    match io.target_pid(target.hwnd) {
        None => Some(TargetIssue::Closed),
        // HWND 会被系统复用：句柄还在但换了进程，绝不能再往里发按键。
        Some(pid) if pid != target.pid => Some(TargetIssue::Reused),
        Some(_) if !io.is_foreground(target.hwnd) => Some(TargetIssue::NotForeground),
        Some(_) => None,
    }
}

/// 纯状态机：不访问数据库、不直接调用 Win32，测试可完整构造竞态。
///
/// 前台策略（本函数的核心约束）：
/// - 只在进入循环前调用一次 `io.focus`（等价于用户点击开始时的那一次主动激活）；
/// - 循环内只读 `is_foreground`，绝不再次激活窗口；
/// - 目标不在前台时**暂停**而不是失败：剩余条目原样保留，等用户明确继续。
/// 测试与只读调用使用的宽容版本：状态回调失败只记录、不阻断。
#[allow(dead_code)]
pub(crate) fn run_plan(
    io: &dyn PasteIo,
    plan: &PastePlan,
    cancel: &AtomicBool,
    load: &mut dyn FnMut(&str) -> AppResult<LoadedPayload>,
    progress: &mut dyn FnMut(&PasteProgress),
) -> PasteRunOutcome {
    // 测试与只读调用不需要持久化：把不可失败的回调适配成可失败的空实现。
    let mut tolerant = |p: &PasteProgress| -> AppResult<()> {
        progress(p);
        Ok(())
    };
    run_plan_with(io, plan, cancel, load, &mut tolerant)
}

/// 与 `run_plan` 相同，但状态回调可以失败：调用方用它在 SendInput **之前**
/// 把 `dispatching` 落库。持久化失败必须阻止按键，否则崩溃后无法判断是否已发送。
pub(crate) fn run_plan_with(
    io: &dyn PasteIo,
    plan: &PastePlan,
    cancel: &AtomicBool,
    load: &mut dyn FnMut(&str) -> AppResult<LoadedPayload>,
    progress: &mut dyn FnMut(&PasteProgress) -> AppResult<()>,
) -> PasteRunOutcome {
    let snapshot = io.snapshot();
    let baseline = snapshot.payload.clone();
    let mut last_seq = snapshot.sequence;
    let mut last_payload: Option<ClipboardPayload> = None;
    let mut sent = plan.sent_start;
    let mut skipped = 0i64;
    let mut remaining = plan.item_ids.clone();
    let mut notes: Vec<String> = Vec::new();
    // 粘贴前快照读不全（格式不支持/读取失败）与「剪贴板为空」是不同事实：
    // 前者意味着原内容无法恢复，必须如实提前说明，不能等到失败时才发现。
    match snapshot.state {
        SnapshotState::Captured | SnapshotState::Empty => {}
        SnapshotState::Unsupported => {
            notes.push("粘贴前剪贴板包含无法完整保存的格式，粘贴后无法恢复原内容".into())
        }
        SnapshotState::Unreadable => notes.push("粘贴前无法读取剪贴板，原内容可能无法恢复".into()),
    }
    let mut states: Vec<(String, ItemState)> = Vec::new();
    let mut status = "completed";
    let mut user_took_over = false;
    let mut wrote_any = false;
    let mut last_kind: Option<String> = None;
    let mut pause_reason: Option<&'static str> = None;
    let mut reason_code: Option<&'static str> = None;
    let mut uncertain: Vec<String> = Vec::new();
    // 状态落库失败的记录点：一旦写入失败，下一步可能基于错误现场继续执行，
    // 所以要在循环顶部与按键之前检查它，必要时安全停下。
    let persist_error: std::cell::RefCell<Option<String>> = std::cell::RefCell::new(None);

    // 唯一一次主动激活。这里是「用户点击开始」对应的动作：之后整个自动循环
    // 只读取前台状态，不再调用 SetForegroundWindow，用户切走不会被抢回来。
    if let Err(e) = io.focus(plan.target.hwnd, plan.target.pid, cancel) {
        if canceled(cancel) {
            status = "cancelled";
            reason_code = Some("USER_CANCELLED");
            notes.push("用户取消，尚未写入任何内容".into());
        } else {
            status = "failed";
            let code = match inspect_target(io, &plan.target) {
                Some(TargetIssue::Closed) => "TARGET_CLOSED",
                Some(TargetIssue::Reused) => "TARGET_HWND_REUSED",
                _ => "FOCUS_DENIED",
            };
            reason_code = Some(code);
            notes.push(format!("无法把目标窗口切到前台（{code}）：{e}"));
        }
    }

    let set_state = |states: &mut Vec<(String, ItemState)>,
                     progress: &mut dyn FnMut(&PasteProgress) -> AppResult<()>,
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
                ItemState::ClipboardWritten
                    | ItemState::Dispatching
                    | ItemState::InputSent
                    | ItemState::Settling
            )
        {
            let p = PasteProgress {
                item_id: id,
                index,
                state,
                sent,
                total: plan.total,
                remaining,
                note,
            };
            if let Err(e) = progress(&p) {
                // 不在这里 break：调用点各不相同，统一由循环顶部/按键前的检查处置。
                if persist_error.borrow().is_none() {
                    *persist_error.borrow_mut() = Some(e.to_string());
                }
            }
        }
    };

    for (idx, id) in plan.item_ids.iter().enumerate() {
        // 启动前置失败（无法置前/已取消）时一次都不进入写入阶段。
        if status != "completed" {
            break;
        }
        if canceled(cancel) {
            status = "cancelled";
            break;
        }
        if let Some(e) = persist_error.borrow().clone() {
            status = "failed";
            reason_code = Some("PASTE_STATE_PERSIST_FAILED");
            notes.push(format!(
                "第 {} 项之前的状态未能写入数据库（{e}）：已停止，避免在状态不明的情况下继续发送",
                idx + 1
            ));
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
                        "无法确认剪贴板内容（读取失败或格式无法验证），已停止且本次未写入任何内容"
                            .into(),
                    );
                    break;
                }
                Some(ClipboardMatch::Different) => {
                    status = "failed";
                    user_took_over = true;
                    notes.push("检测到剪贴板被其他程序更新，已停止并保留最新内容".into());
                    break;
                }
                // 没有可比对基准（粘贴前就读不到/格式不支持）：只能说明无法验证，
                // 不能据此断言用户接管。
                None => {
                    status = "failed";
                    notes.push(
                        "检测到剪贴板状态变化，但粘贴前内容无法比较，已停止且本次未写入任何内容"
                            .into(),
                    );
                    break;
                }
            }
        }
        match inspect_target(io, &plan.target) {
            Some(TargetIssue::Closed) => {
                status = "failed";
                reason_code = Some("TARGET_CLOSED");
                notes.push(format!("第 {} 项前目标窗口已关闭，剩余条目已保留", idx + 1));
                break;
            }
            Some(TargetIssue::Reused) => {
                status = "failed";
                reason_code = Some("TARGET_HWND_REUSED");
                notes.push(format!(
                    "第 {} 项前目标句柄已被其他窗口复用（进程身份不符），已停止发送",
                    idx + 1
                ));
                break;
            }
            Some(TargetIssue::NotForeground) => {
                // 用户切到别的应用：立即暂停，绝不把按键发到他当前正在用的软件。
                status = "paused";
                pause_reason = Some("user_switched");
                reason_code = Some("PASTE_PAUSED_USER_SWITCHED");
                notes.push(format!(
                    "第 {} 项前检测到目标窗口不在前台（用户已切换应用），粘贴已暂停，剩余条目全部保留",
                    idx + 1
                ));
                break;
            }
            None => {}
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
                notes.push(format!("第 {} 项已跳过（内容不可用）：{e}", idx + 1));
                set_state(
                    &mut states,
                    progress,
                    id,
                    idx,
                    ItemState::Skipped,
                    sent,
                    &remaining,
                    Some("内容不可用，未发送"),
                );
                continue;
            }
        };

        // 读取（尤其图片解码）可能耗时较久：写入剪贴板前再确认一次前台。
        // 这里只读状态，不激活窗口；用户已切走就暂停，避免污染他的剪贴板。
        if !io.is_foreground(plan.target.hwnd) {
            status = "paused";
            pause_reason = Some("user_switched");
            reason_code = Some("PASTE_PAUSED_USER_SWITCHED");
            notes.push(format!(
                "第 {} 项读取后目标已不在前台，已暂停（本项未写入剪贴板）",
                idx + 1
            ));
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
            Ok(WriteOutcome::Written {
                seq: final_seq,
                effective,
                degraded,
            }) => {
                last_seq = final_seq;
                // 比对与自写登记一律以「剪贴板上实际存在的形态」为准：
                // 辅助格式没写成时剪贴板里本来就没有它，拿原形态去比
                // 会把「我们自己少写了一个格式」误判成用户接管而中止粘贴。
                if !degraded.is_empty() {
                    notes.push(format!(
                        "第 {} 项部分格式写入失败（{}），已按其余可用格式粘贴",
                        idx + 1,
                        degraded.join("、")
                    ));
                }
                let degraded_note = if degraded.is_empty() {
                    None
                } else {
                    Some(format!("部分格式写入失败（{}）", degraded.join("、")))
                };
                last_payload = Some(effective.clone());
                wrote_any = true;
                io.note_self_write(final_seq);
                // 序列号不是安全证据：发送按键前必须以内容为准。
                // 若用户在这次写入后立刻复制了新内容，绝不发送按键、绝不覆盖。
                // 「读不到」先重试再判定，避免被本进程采集线程的短暂占用误判为用户接管。
                match match_settled(io, &effective, cancel) {
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
                // 注意：这里**不**把本项从 remaining 移除。剪贴板已写入但按键还没发，
                // 用户随后切走或取消时本项仍应留在待处理队列（重写剪贴板不会造成重复粘贴）。
                set_state(
                    &mut states,
                    progress,
                    id,
                    idx,
                    ItemState::ClipboardWritten,
                    sent,
                    &remaining,
                    degraded_note.as_deref(),
                );
            }
            Ok(WriteOutcome::SequenceChanged) => {
                status = "failed";
                // Content 守卫判定为可靠不同 → 用户/其他程序确实更新了剪贴板；
                // Sequence 守卫只能证明序列号变了，无法证明内容被换，不能指控用户接管。
                let verified_different = matches!(guard, WriteGuard::Content(_));
                if verified_different {
                    user_took_over = true;
                    notes.push(format!(
                        "第 {} 项写入前检测到剪贴板已被其他程序更新，本项未写入、也未覆盖新内容",
                        idx + 1
                    ));
                } else {
                    notes.push(format!(
                        "第 {} 项写入前剪贴板状态已变化（粘贴前内容无法完整比较），本项未写入、也未覆盖新内容",
                        idx + 1
                    ));
                }
                set_state(
                    &mut states,
                    progress,
                    id,
                    idx,
                    ItemState::Failed,
                    sent,
                    &remaining,
                    Some(if verified_different {
                        "剪贴板已变化，拒绝覆盖"
                    } else {
                        "剪贴板状态已变化，拒绝覆盖"
                    }),
                );
                break;
            }
            Ok(WriteOutcome::Unverifiable) => {
                // 「读不出可靠内容」不是「用户接管」：没有写入、没有执行 EmptyClipboard，
                // 仅停止并如实报告无法验证，让调用方决定是否重试。
                status = "failed";
                notes.push(format!(
                    "第 {} 项写入前无法验证剪贴板当前内容（图片格式读取失败或不受支持），本项未写入、也未覆盖新内容",
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
                    Some("无法验证剪贴板内容，拒绝覆盖"),
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

        // 按键前最后一道门：进程身份 + 前台。两者都只读，绝不激活窗口。
        match inspect_target(io, &plan.target) {
            Some(TargetIssue::Closed) => {
                status = "failed";
                reason_code = Some("TARGET_CLOSED");
                notes.push(format!(
                    "第 {} 项按键前目标窗口已关闭（内容已写入剪贴板，未发送按键，条目保留）",
                    idx + 1
                ));
                break;
            }
            Some(TargetIssue::Reused) => {
                status = "failed";
                reason_code = Some("TARGET_HWND_REUSED");
                notes.push(format!(
                    "第 {} 项按键前目标句柄已被其他窗口复用，未发送按键，条目保留",
                    idx + 1
                ));
                break;
            }
            Some(TargetIssue::NotForeground) => {
                status = "paused";
                pause_reason = Some("user_switched");
                reason_code = Some("PASTE_PAUSED_USER_SWITCHED");
                set_state(
                    &mut states,
                    progress,
                    id,
                    idx,
                    ItemState::ClipboardWritten,
                    sent,
                    &remaining,
                    Some("目标已不在前台，按键未发送"),
                );
                notes.push(format!(
                    "第 {} 项已写入剪贴板但目标不在前台，已暂停（按键未发送，未影响你当前的应用）",
                    idx + 1
                ));
                break;
            }
            None => {}
        }
        // 崩溃窗口锚点：先把「正在发送」落库（同事务写任务进度 + 逐项状态 + retry_safe=0），
        // 再调用 SendInput。这样进程被杀后能凭这条记录判定「可能已送达」。
        set_state(
            &mut states,
            progress,
            id,
            idx,
            ItemState::Dispatching,
            sent,
            &remaining,
            Some("Ctrl+V 即将发送"),
        );
        if let Some(e) = persist_error.borrow().clone() {
            status = "failed";
            reason_code = Some("PASTE_STATE_PERSIST_FAILED");
            // 按键还没发出去：条目保持在 clipboard_written（可安全重写剪贴板，不退化成 uncertain）。
            set_state(
                &mut states,
                progress,
                id,
                idx,
                ItemState::ClipboardWritten,
                sent,
                &remaining,
                Some("发送状态未落库，按键未发送"),
            );
            notes.push(format!(
                "第 {} 项发送前无法持久化发送状态（{e}）：按键未发送，条目保留在待处理队列",
                idx + 1
            ));
            break;
        }
        if let Err(e) = io.send_paste(plan.target.hwnd, plan.target.pid) {
            // 发送 API 失败 ≠ 目标一定没收到：这一项既不能算成功，也不能留在
            // 待处理里被自动重发（可能造成重复粘贴）。转 uncertain，等用户确认。
            if !io.is_foreground(plan.target.hwnd) {
                status = "paused";
                pause_reason = Some("user_switched");
                reason_code = Some("PASTE_PAUSED_USER_SWITCHED");
                notes.push(format!(
                    "第 {} 项发送瞬间目标已不在前台，已暂停（按键可能未发送）",
                    idx + 1
                ));
                break;
            }
            status = "failed";
            reason_code = Some("PASTE_KEY_SEND_FAILED");
            uncertain.push(id.clone());
            remaining.retain(|r| r != id);
            set_state(
                &mut states,
                progress,
                id,
                idx,
                ItemState::Uncertain,
                sent,
                &remaining,
                Some("Ctrl+V 发送失败，结果不确定，不会自动重发"),
            );
            notes.push(format!(
                "第 {} 项按键发送失败：{e}（内容已写入剪贴板，结果不确定，不会自动重发）",
                idx + 1
            ));
            break;
        }
        // 只有 send_paste 真实返回成功后才标记「按键已发送」：
        // 发送 API 失败时不得让前端看到 InputSent。「已消费」也只在按键发出后成立。
        let sent_at = Instant::now();
        remaining.retain(|r| r != id);
        // InputSent 落库必须与计数 +1、剩余剔除在同一事务内一致提交：
        // 这里把 next_sent（= sent+1）交给进度回调，由专用事务函数断言恰好递增 1。
        // Settling 只是后续观察阶段，不再回写计数。
        let next_sent = sent + 1;
        set_state(
            &mut states,
            progress,
            id,
            idx,
            ItemState::InputSent,
            next_sent,
            &remaining,
            None,
        );
        sent = next_sent;
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
        // 等待窗口 = max(观察窗口 settle, 距下一次按键的剩余间隔)。
        // 旧实现先睡 settle（interval/2）再睡一整段 interval，单项实际成本约
        // 1.5×interval（文字 525ms/图片 1800ms 即由此而来）；两项本来就重叠，
        // 取并集后按键间隔仍满足 interval、两次写入之间仍满足 settle，不做任何
        // 低于安全下限的压缩。最后一项没有「下一次按键」，只保留 settle，
        // 由循环外的 finishing 阶段继续兜住目标异步消费。
        let settle = plan.timing.settle_for(&kind);
        let has_next = idx + 1 < plan.item_ids.len();
        let gap_left = if has_next {
            plan.timing
                .interval_for(&kind)
                .saturating_sub(sent_at.elapsed().as_millis() as u64)
        } else {
            0
        };
        let waited = sleep_cancelable(io, settle.max(gap_left), cancel);
        last_kind = Some(kind.clone());
        if !waited || canceled(cancel) {
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
    }

    if status == "completed" && canceled(cancel) {
        status = "cancelled";
    }
    // 循环里任何一次状态落库失败，都不能把任务记成「完成」。
    if status == "completed" && persist_error.borrow().is_some() {
        let detail = persist_error.borrow().clone().unwrap_or_default();
        status = "failed";
        reason_code = Some("PASTE_STATE_PERSIST_FAILED");
        notes.push(format!(
            "任务状态未能完整落库（{detail}）：已按停止处理，请查看逐项状态"
        ));
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
        let no_snapshot_note = || match snapshot.state {
            SnapshotState::Empty => "粘贴前剪贴板为空，未做恢复",
            SnapshotState::Unsupported => "粘贴前剪贴板格式不支持完整保存，未做恢复",
            SnapshotState::Unreadable => "粘贴前无法读取剪贴板，未做恢复",
            SnapshotState::Captured => "粘贴前剪贴板内容不可用，未做恢复",
        };
        match last_payload.as_ref() {
            Some(last) => match io.restore_if_own_content(&snapshot, last) {
                Ok(RestoreOutcome::Restored) => {
                    restored = true;
                    notes.push("已恢复粘贴前的剪贴板内容".into());
                }
                Ok(RestoreOutcome::KeepUserCopy) => {
                    notes.push("粘贴期间剪贴板被其他程序更新，未恢复原内容（保留最新内容）".into())
                }
                Ok(RestoreOutcome::NoSnapshot) => notes.push(no_snapshot_note().into()),
                Err(e) => notes.push(format!("恢复原剪贴板失败：{e}")),
            },
            None => notes.push(no_snapshot_note().into()),
        }
    }

    PasteRunOutcome {
        status,
        sent,
        skipped,
        remaining,
        uncertain,
        restored,
        user_took_over,
        pause_reason,
        reason_code,
        notes,
        states,
    }
}

struct Active {
    job_id: String,
    cancel: Arc<AtomicBool>,
}

/// 粘贴工作线程句柄。`tid` 用于识别「这个句柄是不是我自己的」，
/// 线程结束时据此把自己的槽位清空。
struct Worker {
    tid: std::thread::ThreadId,
    handle: JoinHandle<()>,
}

/// 可等待的工作线程槽：登记句柄 → 线程结束自清理 → 停止时按时限等待。
///
/// 退出流程必须能等到粘贴线程真正结束，否则进程被杀会留下「永远运行中」
/// 的任务和被残留粘贴内容覆盖的用户剪贴板。
#[derive(Clone)]
struct WorkerSlot {
    inner: Arc<Mutex<Option<Worker>>>,
}

impl WorkerSlot {
    fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(None)),
        }
    }

    fn register(&self, tid: std::thread::ThreadId, handle: JoinHandle<()>) {
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        *guard = Some(Worker { tid, handle });
    }

    /// 线程体结束时调用：只清理属于自己的槽位。
    fn clear(&self, tid: std::thread::ThreadId) {
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if guard.as_ref().map(|w| w.tid == tid).unwrap_or(false) {
            *guard = None;
        }
    }

    fn running(&self) -> bool {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_some()
    }

    /// 等待线程结束并回收句柄。返回 false 表示超时（线程仍在运行）。
    fn wait(&self, timeout: Duration) -> bool {
        let worker = {
            let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            guard.take()
        };
        let Some(worker) = worker else {
            return true;
        };
        let deadline = Instant::now() + timeout;
        while !worker.handle.is_finished() {
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let _ = worker.handle.join();
        true
    }
}

/// 粘贴管理器：同一时刻只允许一个活动队列，避免两个线程互相抢剪贴板。
pub struct PasteManager {
    db: Arc<Db>,
    root: PathBuf,
    app: AppHandle,
    self_write: Arc<AtomicU32>,
    active: Arc<Mutex<Option<Active>>>,
    worker: WorkerSlot,
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

/// 校验目标窗口（存在、PID 身份、非本应用、权限允许），供 UI 预检、跳转与启动共用。
///
/// `expected_pid` 是用户选中窗口时记录的进程号。HWND 会被系统复用，只比对句柄
/// 可能把按键发到另一个进程；传入时必须与当前句柄的真实 PID 完全一致。
pub fn precheck_target(target_hwnd: isize, expected_pid: Option<u32>) -> AppResult<TargetWindow> {
    let target = platform::window_target(target_hwnd)
        .ok_or_else(|| AppError::Validation("目标窗口不存在或已关闭".into()))?;
    if let Some(pid) = expected_pid {
        if pid != target.pid {
            return Err(AppError::Validation(
                "目标窗口已关闭或句柄被其他窗口复用，请刷新窗口列表后重新选择".into(),
            ));
        }
    }
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
            worker: WorkerSlot::new(),
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

    pub fn precheck(
        &self,
        target_hwnd: isize,
        expected_pid: Option<u32>,
    ) -> AppResult<TargetWindow> {
        precheck_target(target_hwnd, expected_pid)
    }

    /// 启动整组粘贴。`item_ids` 必须按分组展示顺序传入。
    pub fn start(
        &self,
        group_id: &str,
        target_hwnd: isize,
        expected_pid: Option<u32>,
        item_ids: &[String],
    ) -> AppResult<PasteStartReport> {
        if item_ids.is_empty() {
            return Err(AppError::Validation("没有可粘贴的内容".into()));
        }
        let target = self.precheck(target_hwnd, expected_pid)?;
        self.begin(group_id, target, item_ids.to_vec(), None)
    }

    /// 继续未完成的粘贴任务：只重发 `remaining_items`，累计 sent/total 保持不变。
    pub fn resume(
        &self,
        job_id: &str,
        target_hwnd: isize,
        expected_pid: Option<u32>,
    ) -> AppResult<PasteStartReport> {
        // 续跑前先把「发送阶段崩溃」的条目收敛成 uncertain：它们可能已经送达，
        // 既不能当待处理项自动重发，也不能从剩余队列里悄悄留在原地。
        store::reconcile_dispatching_items(&self.db, job_id)?;
        let mut job = store::get_paste_job(&self.db, job_id)?;
        let uncertain = job.uncertain_items.clone();
        job.remaining_items.retain(|id| !uncertain.contains(id));
        if job.remaining_items.is_empty() {
            return Err(AppError::Validation(
                "该任务没有剩余项目（不确定项需逐项确认后手动重发）".into(),
            ));
        }
        let target = self.precheck(target_hwnd, expected_pid)?;
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
                // 历史任务可能没有逐项记录：按当前剩余顺序补登，已有行不动。
                store::seed_paste_items(&self.db, id, &item_ids, *total - item_ids.len() as i64)?;
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
                store::seed_paste_items(&self.db, &id, &item_ids, 0)?;
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
        let worker_slot = self.worker.clone();
        let job_for_thread = job_id.clone();
        let plan = PastePlan {
            target,
            item_ids: item_ids.clone(),
            total,
            sent_start: sent,
            timing,
        };
        // 握手：工作线程先等父线程登记句柄再开工，
        // 否则「线程刚起来就退出」与「父线程刚要登记」会交错，
        // 退出流程可能漏掉一个仍在运行的粘贴线程。
        let (go_tx, go_rx) = mpsc::sync_channel::<()>(0);
        let spawned = std::thread::Builder::new()
            .name("clipboard-paste".into())
            .spawn(move || {
                if go_rx.recv().is_err() {
                    // 父线程没能登记句柄（启动失败），直接退出，不做任何写剪贴板的动作。
                    return;
                }
                let tid = std::thread::current().id();
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
                    if let Err(e) = store::finish_paste_job(
                        &fail_db,
                        &fail_job,
                        "failed",
                        sent,
                        &remaining,
                        &[],
                        message,
                        false,
                    ) {
                        tracing::error!("线程 panic 后仍无法保存任务状态 {fail_job}: {e}");
                    }
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
                // 线程收尾：清掉自己的句柄槽，避免留下已结束线程的句柄。
                worker_slot.clear(tid);
            });
        match spawned {
            Ok(handle) => {
                self.worker.register(handle.thread().id(), handle);
                // 登记完成后才放行工作线程。
                let _ = go_tx.send(());
            }
            Err(e) => {
                let mut guard = self.active.lock().unwrap_or_else(|x| x.into_inner());
                if guard.as_ref().map(|a| a.job_id == job_id).unwrap_or(false) {
                    *guard = None;
                }
                if let Err(finish_err) = store::finish_paste_job(
                    &self.db,
                    &job_id,
                    "failed",
                    sent,
                    &item_ids,
                    &[],
                    "无法创建粘贴线程，任务未开始",
                    false,
                ) {
                    tracing::error!("创建线程失败后仍无法保存任务状态 {job_id}: {finish_err}");
                }
                return Err(AppError::Io(e));
            }
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

    /// 是否有正在运行（或刚结束尚未登记清理）的粘贴工作线程。
    pub fn worker_running(&self) -> bool {
        self.worker.running()
    }

    /// 停止粘贴工作线程：取消当前任务，并在时限内等待线程真正收尾。
    ///
    /// 退出流程必须走这里：线程若在应用退出时仍在写剪贴板，
    /// 会留下「任务永远运行中」和「用户剪贴板被残留内容覆盖」两个问题。
    /// 返回 true 表示线程已在时限内结束。
    pub fn stop(&self, timeout: Duration) -> bool {
        self.cancel_all();
        let stopped = self.worker.wait(timeout);
        if !stopped {
            tracing::warn!(
                "粘贴工作线程未在 {}ms 内结束，放弃等待（进程退出时由系统回收）",
                timeout.as_millis()
            );
        }
        stopped
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
    let mut last_reason: Option<String> = None;
    for attempt in 0..3 {
        if canceled(cancel) {
            return Err(AppError::Validation("已取消".into()));
        }
        // 复用导航的聚焦实现：内部已校验句柄有效、恢复最小化、置前并核实前台。
        // 失败原因必须保留，不能统一吞成「切换失败」。
        match crate::navigation::window_manager::focus_window(hwnd) {
            Ok(_) => {}
            Err(e) => last_reason = Some(e.reason_cn().to_string()),
        }
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
    Err(AppError::Validation(match last_reason {
        Some(reason) => format!("无法将目标窗口切换到前台：{reason}"),
        None => "无法将目标窗口切换到前台（可能被系统焦点保护拦截）".into(),
    }))
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

    fn target_pid(&self, hwnd: isize) -> Option<u32> {
        platform::window_pid(hwnd)
    }

    fn is_foreground(&self, hwnd: isize) -> bool {
        platform::is_foreground(hwnd)
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
        if let Ok(WriteOutcome::Written { seq, degraded, .. }) = &outcome {
            tracing::debug!("逐项粘贴：写入剪贴板完成 seq={seq} 降级格式={degraded:?}");
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

/// 收尾事件状态选择（纯函数，便于无 Tauri 句柄的测试断言）。
///
/// 持久化失败时禁止广播 `completed`/`paused`/`cancelled` 等正常终态：返回明确表示
/// 「结果尚未可靠保存」的 `finish_persist_failed` 状态与原因码
/// `PASTE_JOB_FINISH_PERSIST_FAILED`；成功时原样保留运行结果状态与原因码。
fn finish_event_status(
    persist_failed: bool,
    outcome: &PasteRunOutcome,
) -> (&'static str, Option<&'static str>) {
    if persist_failed {
        (
            "finish_persist_failed",
            Some("PASTE_JOB_FINISH_PERSIST_FAILED"),
        )
    } else {
        (outcome.status, outcome.reason_code)
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
    let mut progress = |p: &PasteProgress| -> AppResult<()> {
        // 任务进度与逐项状态在同一个事务里落地：崩溃后不会出现「任务说发了、条目还 pending」。
        // 这里返回 Err 会被 run_plan_with 当成停止信号（发送前那一步尤其关键）。
        // InputSent 走专用事务：计数 +1、剩余剔除、逐项状态一致提交并断言递增 1。
        let persist = if p.state == ItemState::InputSent {
            store::record_paste_input_sent_step(
                &db,
                &job_id,
                p.sent,
                p.remaining,
                p.item_id,
                p.note,
            )
        } else {
            store::record_paste_step(
                &db,
                &job_id,
                p.sent,
                p.remaining,
                p.item_id,
                p.state.as_str(),
                p.note,
            )
        };
        persist.map_err(|e| {
            tracing::error!(
                "逐项粘贴状态落库失败 job={} item={} state={}: {e}",
                job_id,
                p.item_id,
                p.state.as_str()
            );
            e
        })?;
        if let Err(e) = app.emit(
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
        ) {
            // UI 事件失败不代表粘贴失败：数据库已经是权威事实，只记日志。
            tracing::warn!("粘贴进度事件发送失败（已落库）: {e}");
        }
        Ok(())
    };

    let outcome = run_plan_with(&io, &plan, &cancel, &mut load, &mut progress);

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
        "paused" => message.push_str("；已暂停，剩余条目可继续"),
        "failed" => message.push_str("；任务已停止"),
        _ => {}
    }
    if !outcome.uncertain.is_empty() {
        message.push_str(&format!(
            "；{} 项结果不确定（按键可能已发送），不会自动重发",
            outcome.uncertain.len()
        ));
    }
    if !outcome.notes.is_empty() {
        message.push('。');
        message.push_str(&outcome.notes.join("；"));
    }

    // uncertain 在数据库里是「历史累积集合」，不是「本轮集合」：finish 返回合并后的总数。
    let mut finish_persist_err: Option<String> = None;
    let uncertain_total = match store::finish_paste_job(
        &db,
        &job_id,
        outcome.status,
        outcome.sent,
        &outcome.remaining,
        &outcome.uncertain,
        &message,
        outcome.restored,
    ) {
        Ok(total) => total,
        Err(e) => {
            // 结束状态保存失败：不能假装任务已经正常收尾。
            tracing::error!("粘贴任务收尾失败 job={job_id}: {e}");
            let _ = app.emit(
                "clipboard-paste-diagnostic",
                serde_json::json!({
                    "jobId": job_id,
                    "severity": "error",
                    "code": "PASTE_JOB_FINISH_PERSIST_FAILED",
                    "message": e.to_string(),
                }),
            );
            finish_persist_err = Some(e.to_string());
            outcome.uncertain.len()
        }
    };
    // active 槽只是进程内互斥守卫，跟踪当前工作线程；工作线程正在收尾，清槽只释放
    // 内存互斥、不代表数据库已保存。DB 里任务仍是原状态（通常 running），下次启动
    // 由 `recover_stale_paste_jobs` 识别为 interrupted。这里清槽不会掩盖持久化失败。
    if let Ok(mut guard) = active.lock() {
        if guard.as_ref().map(|a| a.job_id == job_id).unwrap_or(false) {
            *guard = None;
        }
    }
    let persist_failed = finish_persist_err.is_some();
    let (event_status, event_reason) = finish_event_status(persist_failed, &outcome);
    let mut event = serde_json::json!({
        "jobId": job_id,
        "status": event_status,
        "sent": outcome.sent,
        "total": total,
        "pending": outcome.remaining.len(),
        "message": message,
        "restored": outcome.restored,
        "userTookOver": outcome.user_took_over,
        "pauseReason": outcome.pause_reason,
        "reasonCode": event_reason,
        "uncertain": uncertain_total,
        "confirmed": outcome.confirmed(),
        "unverified": outcome.unverified(),
    });
    if let Some(detail) = finish_persist_err {
        // 持久化失败：禁止广播 completed/paused/cancelled 等正常终态。事件保留原始
        // jobId、真实 sent/total/pending、失败原因码与诊断详情；前端只认失败态。
        event["diagnostic"] = serde_json::Value::String(detail);
    }
    let _ = app.emit("clipboard-paste", event);
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
        foreground: Cell<bool>,
        pid_override: Cell<Option<u32>>,
        focus_calls: Cell<u32>,
        drop_foreground_after_writes: Cell<usize>,
        focus_error: RefCell<Option<String>>,
        send_fails: Cell<bool>,
        force_sequence_changed: Cell<bool>,
        external_after_writes: Cell<usize>,
        takeover_before_send_after_writes: Cell<usize>,
        settle_after_writes: Cell<usize>,
        unavailable_reads: Cell<u32>,
        guard_unverifiable: Cell<bool>,
        snapshot_state: Cell<SnapshotState>,
        snapshot_payload: RefCell<Option<ClipboardPayload>>,
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
                foreground: Cell::new(true),
                pid_override: Cell::new(None),
                focus_calls: Cell::new(0),
                drop_foreground_after_writes: Cell::new(0),
                focus_error: RefCell::new(None),
                send_fails: Cell::new(false),
                force_sequence_changed: Cell::new(false),
                external_after_writes: Cell::new(0),
                takeover_before_send_after_writes: Cell::new(0),
                settle_after_writes: Cell::new(0),
                unavailable_reads: Cell::new(0),
                guard_unverifiable: Cell::new(false),
                snapshot_state: Cell::new(SnapshotState::Captured),
                snapshot_payload: RefCell::new(Some(baseline_payload())),
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
                payload: self.snapshot_payload.borrow().clone(),
                state: self.snapshot_state.get(),
            }
        }

        fn target_pid(&self, _hwnd: isize) -> Option<u32> {
            if let Some(pid) = self.pid_override.get() {
                return Some(pid);
            }
            if self.target_alive.get() {
                Some(4242)
            } else {
                None
            }
        }

        fn is_foreground(&self, _hwnd: isize) -> bool {
            self.foreground.get()
        }

        fn focus(&self, _hwnd: isize, _pid: u32, _cancel: &AtomicBool) -> AppResult<()> {
            self.focus_calls.set(self.focus_calls.get() + 1);
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
            if self.guard_unverifiable.get() {
                return Ok(WriteOutcome::Unverifiable);
            }
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
            if self.drop_foreground_after_writes.get() == self.applied.get() {
                // 模拟写入完成后、按键发出前用户切到了别的应用
                self.foreground.set(false);
            }
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
            Ok(WriteOutcome::Written {
                seq: final_seq,
                effective: payload.clone(),
                degraded: Vec::new(),
            })
        }

        fn send_paste(&self, _hwnd: isize, _pid: u32) -> AppResult<()> {
            self.timeline.borrow_mut().push("send".into());
            if !self.foreground.get() {
                return Err(AppError::Validation("目标已失去前台".into()));
            }
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
        // 观察窗口已分段可取消：按时间线窗口求和验证「图片的观察窗口比文本长」。
        // 窗口 = settle（等目标消费）+ interval（距下一次写入），与分段方式无关。
        let window_ms = |timeline: &Vec<String>, from: &str, to: &str| -> u64 {
            let start = timeline
                .iter()
                .position(|e| e == from)
                .expect("起始写入事件");
            let end = timeline
                .iter()
                .position(|e| e == to)
                .expect("下一次写入事件");
            timeline[start..end]
                .iter()
                .filter_map(|e| e.strip_prefix("sleep:"))
                .filter_map(|v| v.parse::<u64>().ok())
                .sum()
        };
        let timeline = io.timeline.borrow();
        let text_window = window_ms(&timeline, "write:a", "write:b");
        let image_window = window_ms(&timeline, "write:b", "write:c");
        drop(timeline);
        assert!(
            image_window > text_window,
            "图片的观察窗口应比文本长：image={image_window}ms text={text_window}ms"
        );
        // 等待窗口取 settle 与 interval 的并集（旧实现两者相加，单项成本约 1.5×interval）。
        assert_eq!(image_window, 1200, "图片窗口 = max(settle 600, interval 1200)");
        assert!(
            text_window >= 350,
            "文本窗口仍不得低于 interval 350ms，不允许压到不可靠的固定 100ms"
        );
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
        assert_eq!(outcome.reason_code, Some("FOCUS_DENIED"));
        assert_eq!(outcome.remaining, vec!["a".to_string(), "b".to_string()]);
        assert_eq!(io.applied.get(), 0);
        assert_eq!(io.focus_calls.get(), 1, "启动时只主动激活一次");
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
    fn send_failure_marks_item_uncertain_and_never_auto_resends() {
        let io = FakeIo::new(1);
        io.send_fails.set(true);
        let p = plan(&["a", "b"], timing());
        let mut load = loader(&[("a", KIND_TEXT), ("b", KIND_TEXT)]);
        let cancel = AtomicBool::new(false);
        let outcome = run_plan(&io, &p, &cancel, &mut load, &mut noop_progress);
        assert_eq!(outcome.status, "failed");
        assert_eq!(outcome.reason_code, Some("PASTE_KEY_SEND_FAILED"));
        assert_eq!(outcome.sent, 0, "发送 API 失败不能计入已发送");
        assert_eq!(outcome.uncertain, vec!["a".to_string()]);
        assert_eq!(
            outcome.remaining,
            vec!["b".to_string()],
            "未处理项保留；不确定项单列，不能混回待处理队列被自动重发"
        );
        assert_eq!(io.applied.get(), 1);
        assert!(outcome.restored, "写入过剪贴板时仍应尝试恢复");
        assert_eq!(
            outcome
                .states
                .iter()
                .find(|(id, _)| id == "a")
                .map(|(_, s)| *s),
            Some(ItemState::Uncertain),
            "按键发送失败必须标记 uncertain，不能谎称成功也不能谎称完全失败"
        );
    }

    #[test]
    fn user_switch_pauses_without_stealing_foreground() {
        let io = FakeIo::new(1);
        let p = plan(&["a", "b", "c", "d"], timing());
        let mut load = loader(&[
            ("a", KIND_TEXT),
            ("b", KIND_TEXT),
            ("c", KIND_TEXT),
            ("d", KIND_TEXT),
        ]);
        let cancel = AtomicBool::new(false);
        let mut progress = |pr: &PasteProgress| {
            if pr.item_id == "b" && pr.state == ItemState::Settling {
                io.foreground.set(false);
            }
        };
        let outcome = run_plan(&io, &p, &cancel, &mut load, &mut progress);
        assert_eq!(outcome.status, "paused");
        assert_eq!(outcome.pause_reason, Some("user_switched"));
        assert_eq!(outcome.reason_code, Some("PASTE_PAUSED_USER_SWITCHED"));
        assert_eq!(outcome.sent, 2);
        assert_eq!(
            outcome.remaining,
            vec!["c".to_string(), "d".to_string()],
            "暂停必须保留全部未处理项"
        );
        assert_eq!(
            io.focus_calls.get(),
            1,
            "整个自动循环只允许一次主动激活（用户点开始那一次）"
        );
        assert_eq!(io.applied.get(), 2, "用户切走后不得再写入剪贴板");
    }

    #[test]
    fn foreground_loss_between_write_and_key_keeps_item_for_resume() {
        let io = FakeIo::new(1);
        io.drop_foreground_after_writes.set(1);
        let p = plan(&["a", "b"], timing());
        let mut load = loader(&[("a", KIND_TEXT), ("b", KIND_TEXT)]);
        let cancel = AtomicBool::new(false);
        let outcome = run_plan(&io, &p, &cancel, &mut load, &mut noop_progress);
        assert_eq!(outcome.status, "paused");
        assert_eq!(outcome.sent, 0, "按键未发出，不得计入已发送");
        assert_eq!(
            outcome.remaining,
            vec!["a".to_string(), "b".to_string()],
            "已写剪贴板但未发按键的条目仍在待处理队列，继续时会重写同一内容"
        );
        assert!(outcome.uncertain.is_empty(), "未发按键不属于结果不确定");
        assert_eq!(io.applied.get(), 1);
    }

    #[test]
    fn hwnd_reuse_stops_with_distinct_reason_code() {
        let io = FakeIo::new(1);
        io.pid_override.set(Some(9999));
        let p = plan(&["a"], timing());
        let mut load = loader(&[("a", KIND_TEXT)]);
        let cancel = AtomicBool::new(false);
        let outcome = run_plan(&io, &p, &cancel, &mut load, &mut noop_progress);
        assert_eq!(outcome.status, "failed");
        assert_eq!(outcome.reason_code, Some("TARGET_HWND_REUSED"));
        assert_eq!(io.writes.borrow().len(), 0, "身份不符时绝不写入剪贴板");
    }

    #[test]
    fn unavailable_item_is_recorded_as_skipped_state() {
        let io = FakeIo::new(1);
        let p = plan(&["a", "missing"], timing());
        let mut load = loader(&[("a", KIND_TEXT)]);
        let cancel = AtomicBool::new(false);
        let outcome = run_plan(&io, &p, &cancel, &mut load, &mut noop_progress);
        assert_eq!(
            outcome
                .states
                .iter()
                .find(|(id, _)| id == "missing")
                .map(|(_, s)| *s),
            Some(ItemState::Skipped),
            "读取失败必须留下 skipped 记录，不能静默消失"
        );
        assert!(outcome.notes.iter().any(|n| n.contains("已跳过")));
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

    #[test]
    fn unverifiable_write_guard_stops_without_claiming_user_takeover() {
        // 只有 DIB/损坏图片格式导致无法解码时，写入守卫只能返回「无法验证」：
        // 既不能覆盖，也不能谎报成「剪贴板已被其他程序更新」。
        let io = FakeIo::new(7);
        io.guard_unverifiable.set(true);
        let p = plan(&["a", "b"], timing());
        let mut load = loader(&[("a", KIND_TEXT), ("b", KIND_TEXT)]);
        let cancel = AtomicBool::new(false);
        let outcome = run_plan(&io, &p, &cancel, &mut load, &mut noop_progress);
        assert_eq!(outcome.status, "failed");
        assert!(!outcome.user_took_over, "无法验证不等于用户接管");
        assert_eq!(outcome.sent, 0);
        assert_eq!(
            io.applied.get(),
            0,
            "无法验证时绝不能执行 EmptyClipboard/写入"
        );
        assert_eq!(
            outcome.remaining,
            vec!["a".to_string(), "b".to_string()],
            "未写入的条目必须保留在待处理列表"
        );
        assert!(
            outcome.notes.iter().any(|n| n.contains("无法验证")),
            "notes={:?}",
            outcome.notes
        );
        assert!(
            outcome
                .states
                .iter()
                .any(|(id, state)| id == "a" && *state == ItemState::Failed),
            "失败必须定位到第 1 项：{:?}",
            outcome.states
        );
        assert!(
            !io.timeline.borrow().iter().any(|e| e == "send"),
            "未写入时绝不发送按键"
        );
    }

    #[test]
    fn unreadable_snapshot_is_reported_but_paste_continues_safely() {
        // 快照读不到 ≠ 剪贴板为空 ≠ 用户接管：序列号守卫仍能保证不覆盖未知内容。
        let io = FakeIo::new(3);
        io.snapshot_state.set(SnapshotState::Unreadable);
        *io.snapshot_payload.borrow_mut() = None;
        let p = plan(&["a", "b"], timing());
        let mut load = loader(&[("a", KIND_TEXT), ("b", KIND_TEXT)]);
        let cancel = AtomicBool::new(false);
        let outcome = run_plan(&io, &p, &cancel, &mut load, &mut noop_progress);
        assert_eq!(outcome.status, "completed");
        assert_eq!(outcome.sent, 2);
        assert!(!outcome.user_took_over);
        assert!(
            outcome
                .notes
                .iter()
                .any(|n| n.contains("粘贴前无法读取剪贴板")),
            "notes={:?}",
            outcome.notes
        );
    }

    #[test]
    fn sequence_change_without_comparable_baseline_is_not_user_takeover() {
        // 粘贴前就取不到可比对内容时，序列号增长可能只是系统合成格式，
        // 只能如实报告「无法比较」，不能指控用户接管。
        let io = FakeIo::new(5);
        io.snapshot_state.set(SnapshotState::Unsupported);
        *io.snapshot_payload.borrow_mut() = None;
        io.seq.set(6);
        let p = plan(&["a", "b"], timing());
        let mut load = loader(&[("a", KIND_TEXT), ("b", KIND_TEXT)]);
        let cancel = AtomicBool::new(false);
        let outcome = run_plan(&io, &p, &cancel, &mut load, &mut noop_progress);
        assert_eq!(outcome.status, "failed");
        assert!(!outcome.user_took_over);
        assert_eq!(io.applied.get(), 0);
        assert!(
            outcome.notes.iter().any(|n| n.contains("无法比较")),
            "notes={:?}",
            outcome.notes
        );
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
            source_kind: "owner".into(),
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
            // 与截图同一应用会话中的文字说明：「截图 A→文字→截图 B」必须保留顺序
            source_app: "snippingtool.exe".into(),
            source_title: "截图工具".into(),
            source_kind: "owner".into(),
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
        assert!(a.group_id.is_none(), "首张图片只成为候选");
        let gid = b.group_id.clone().expect("同来源第二张图片应与候选成组");
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

    /// §九-8：退出时必须能等到粘贴工作线程真正结束，
    /// 否则会留下「永远运行中」的任务和被残留内容覆盖的用户剪贴板。
    #[test]
    fn worker_slot_waits_for_thread_to_finish() {
        let slot = WorkerSlot::new();
        let flag = Arc::new(AtomicBool::new(false));
        let flag2 = flag.clone();
        let handle = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(120));
            flag2.store(true, Ordering::SeqCst);
        });
        slot.register(handle.thread().id(), handle);
        assert!(slot.running(), "线程存活期间槽位必须报告有工作线程");

        assert!(slot.wait(Duration::from_secs(5)), "线程应按时结束");
        assert!(flag.load(Ordering::SeqCst), "等待返回时线程必须已跑完");
        assert!(!slot.running(), "等待结束后槽位必须清空");
    }

    /// 超时不得谎报成功：退出流程据此知道线程仍在运行。
    #[test]
    fn worker_slot_reports_timeout_for_stuck_thread() {
        let slot = WorkerSlot::new();
        let handle = std::thread::spawn(|| {
            std::thread::sleep(Duration::from_secs(30));
        });
        slot.register(handle.thread().id(), handle);
        assert!(
            !slot.wait(Duration::from_millis(120)),
            "线程未结束时必须返回 false（超时），不得谎报已收尾"
        );
    }

    /// 发送前必须先把 `dispatching` 落库；这一步失败时**绝不能调用 SendInput**，
    /// 否则崩溃窗口里没人知道按键到底发出去没有。
    #[test]
    fn dispatch_state_persist_failure_aborts_before_send() {
        let io = FakeIo::new(1);
        let p = plan(&["a", "b"], timing());
        let mut load = loader(&[("a", "text"), ("b", "text")]);
        let mut seen: Vec<(String, ItemState)> = Vec::new();
        let mut progress = |pr: &PasteProgress| -> AppResult<()> {
            seen.push((pr.item_id.to_string(), pr.state));
            if pr.state == ItemState::Dispatching {
                return Err(AppError::Validation("数据库只读，无法写入发送状态".into()));
            }
            Ok(())
        };
        let outcome = run_plan_with(&io, &p, &AtomicBool::new(false), &mut load, &mut progress);

        assert_eq!(outcome.status, "failed");
        assert_eq!(
            outcome.reason_code,
            Some("PASTE_STATE_PERSIST_FAILED"),
            "必须用稳定码说明是持久化失败，而不是粘贴失败"
        );
        assert!(
            io.timeline.borrow().iter().all(|t| t != "send"),
            "发送状态没落库就发按键会造成无法追溯的重复粘贴"
        );
        assert!(seen.iter().any(|(_, st)| *st == ItemState::Dispatching));
        assert!(
            outcome
                .states
                .iter()
                .any(|(id, st)| id == "a" && *st == ItemState::ClipboardWritten),
            "按键没发出去：条目必须留在可安全重试的位置（clipboard_written），不能标 uncertain"
        );
        assert!(outcome.uncertain.is_empty(), "没发按键就不存在「结果不确定」");
    }

    /// 线程正常结束后自清理槽位：不留下已结束线程的句柄。
    #[test]
    fn worker_slot_clears_itself_when_thread_ends() {
        let slot = WorkerSlot::new();
        let slot2 = slot.clone();
        let (go_tx, go_rx) = mpsc::sync_channel::<()>(0);
        let handle = std::thread::spawn(move || {
            // 与生产代码一致：先等父线程登记句柄再清理，避免竞态。
            let _ = go_rx.recv();
            let tid = std::thread::current().id();
            slot2.clear(tid);
        });
        let tid = handle.thread().id();
        slot.register(tid, handle);
        let _ = go_tx.send(());
        let deadline = Instant::now() + Duration::from_secs(5);
        while slot.running() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(!slot.running(), "线程结束后槽位必须自行清空");
    }

    /// 3.5：结束状态持久化失败时，事件状态必须关闭成 `finish_persist_failed`，
    /// 禁止广播 completed/paused/cancelled 等正常终态；成功时原样保留终态。
    #[test]
    fn finish_event_status_fails_closed_when_persist_failed() {
        let outcome = PasteRunOutcome {
            status: "completed",
            sent: 1,
            skipped: 0,
            remaining: vec![],
            uncertain: vec!["甲".into()],
            restored: true,
            user_took_over: false,
            pause_reason: None,
            reason_code: None,
            notes: vec![],
            states: vec![],
        };
        let (status, reason) = finish_event_status(true, &outcome);
        assert_eq!(status, "finish_persist_failed");
        assert_eq!(reason, Some("PASTE_JOB_FINISH_PERSIST_FAILED"));
        assert!(
            !["completed", "paused", "cancelled"].contains(&status),
            "持久化失败不得广播正常终态"
        );
        let (status2, reason2) = finish_event_status(false, &outcome);
        assert_eq!(status2, "completed");
        assert_eq!(reason2, None);
    }

    /// 3.4：InputSent 进度必须携带已 +1 的 sent，Settling 不再推进计数。
    #[test]
    fn input_sent_progress_carries_incremented_sent_before_settling() {
        let io = FakeIo::new(2);
        let p = plan(&["a", "b"], timing());
        let mut load = loader(&[("a", "text"), ("b", "text")]);
        let mut seen: Vec<(ItemState, i64)> = Vec::new();
        let mut progress = |pr: &PasteProgress| -> AppResult<()> {
            seen.push((pr.state, pr.sent));
            Ok(())
        };
        let outcome = run_plan_with(&io, &p, &AtomicBool::new(false), &mut load, &mut progress);
        assert_eq!(outcome.status, "completed");
        let first_input = seen
            .iter()
            .find(|(s, _)| *s == ItemState::InputSent)
            .expect("必须有 InputSent 进度");
        assert_eq!(first_input.1, 1, "InputSent 进度必须携带已 +1 的 sent");
        let last_settle = seen
            .iter()
            .find(|(s, _)| *s == ItemState::Settling)
            .expect("必须有 Settling 进度");
        assert_eq!(last_settle.1, first_input.1, "Settling 不得再推进计数");
    }

    /// 3.1：崩溃恢复后的续跑计划只来自剩余队列；崩溃锚点/不确定项不进计划，
    /// FakeIo 发送次数等于剩余项数，不补发任何崩溃/不确定项。
    #[test]
    fn resume_after_recovery_only_sends_remaining_items_zero_extra_send() {
        let io = FakeIo::new(2);
        let p = plan(&["b"], timing());
        let mut load = loader(&[("b", "text")]);
        let outcome = run_plan(&io, &p, &AtomicBool::new(false), &mut load, &mut noop_progress);
        assert_eq!(outcome.status, "completed");
        let sends = io
            .timeline
            .borrow()
            .iter()
            .filter(|t| t.as_str() == "send")
            .count();
        assert_eq!(sends, 1, "续跑只发送剩余项，不补发崩溃/不确定项");
    }
}
