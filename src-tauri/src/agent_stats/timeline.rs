//! Agent 轮次时间线：纯函数、无数据库依赖，只做「可复核的时长口径」。
//!
//! 口径（与 UI 文案一致，禁止把推测当准确值）：
//! - **总运行跨度**：`agent_runs.started_at`（首个已受理事件时间）到「`ended_at`
//!   （首个终态事件）、`last_event_at`（最后已受理事件）、最后一个已确认事件」三者中最晚
//!   端点的墙钟跨度；跨统计窗口时按窗口裁剪。取最晚端点是为了让跨度始终覆盖已确认的
//!   执行/等待区间（终态可能被后续事件修正，窗口归属事件也可能晚于 `last_event_at`）。
//! - **执行时长**：仅在 `running` 事件可靠（evidence=observed、confidence≥0.6）
//!   且相邻两事件间隔不超过 `max_gap_ms` 时，把该区间计入执行。
//! - **等待时长**：同上，按 `waiting` 事件区间计入（权限/输入/通知等待都映射到 waiting）。
//! - **空闲区间**：`idle` 事件区间单独统计，不并入执行或等待。
//! - **未知区间**：证据类型为 process/manual、置信度不足、状态无法识别，
//!   或事件间隔超过上限（Agent 可能已崩溃/静默）时，一律记 Unknown，绝不推测为执行。
//! - **未关闭尾部**：最后一个事件仍是运行/等待且轮次没有终态时，从最后事件到
//!   `now` 的时间单独作为「进行中（未确认）」，不计入执行/等待。
//! - **终态**：只有 completed/failed 且能关联到可靠的终态事件时才计入失败率分母；
//!   disconnected 视为中断（结果未知），运行中/无终态事件一律不计。
//!
//! 时间顺序：按服务端受理序号 `ingest_seq` 升序回放，并用事件时间水位丢弃
//! 「比已回放事件更旧」的迟到事件（与 `agents::ingest_core` 的水位规则一致）。

/// 单个状态区间超过该上限就无法确认 Agent 仍在执行（可能崩溃/静默/离线）。
pub const MAX_PLAUSIBLE_GAP_MS: i64 = 4 * 3600 * 1000;
/// 非终态轮次最后事件超过该时长仍无新事件：标记「疑似中断」。
pub const STALE_OPEN_MS: i64 = 2 * 3600 * 1000;
/// 低于该置信度的事件不参与时长计算。
pub const MIN_RELIABLE_CONFIDENCE: f64 = 0.6;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum StateKind {
    Running,
    Waiting,
    Idle,
    Completed,
    Failed,
    Disconnected,
    Unknown,
}

/// 统一状态字符串 → 内部状态类别（未知状态返回 `Unknown`，不猜测）。
pub fn state_kind(state: &str) -> StateKind {
    match state.trim().to_ascii_lowercase().as_str() {
        "running" | "working" | "active" => StateKind::Running,
        "waiting" | "wait" | "paused" | "authorization" | "input" => StateKind::Waiting,
        "idle" => StateKind::Idle,
        "completed" | "done" | "complete" => StateKind::Completed,
        "failed" | "error" => StateKind::Failed,
        "disconnected" | "offline" | "stale" | "interrupted" => StateKind::Disconnected,
        _ => StateKind::Unknown,
    }
}

#[derive(Debug, Clone)]
pub struct RawEvent {
    pub state: String,
    /// 事件发生时间（毫秒时间戳）；无法解析时为 None（只计入数据质量，不参与时长）。
    pub occurred_ms: Option<i64>,
    /// observed | process | manual（服务端写入值）
    pub evidence_type: String,
    pub confidence: f64,
    /// 服务端受理序号：回放顺序的唯一权威。
    pub ingest_seq: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SliceKind {
    Exec,
    Wait,
    Idle,
    Unknown,
}

/// 已裁剪到统计窗口内的状态区间。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Slice {
    pub start_ms: i64,
    pub end_ms: i64,
    pub kind: SliceKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Terminal {
    /// 有可靠 completed 终态事件
    Completed,
    /// 有可靠 failed 终态事件
    Failed,
    /// 已断开（Agent 意外退出/超时），结果未知，不计入失败率
    Interrupted,
    /// 轮次仍在运行/等待
    Unresolved,
    /// 状态声称结束但拿不到可靠终态事件
    UnknownTerminal,
}

#[derive(Debug, Clone, Default)]
pub struct RunFlags {
    /// 首个可确认事件不是 running/waiting（开始前的执行无法确认）
    pub missing_start: bool,
    /// 非终态且最后事件已过 stale 阈值，或终态缺结束时间
    pub missing_end: bool,
    /// 非终态尾部超过 stale 阈值：疑似 Agent 崩溃/静默退出
    pub stale_open: bool,
    /// 轮次没有任何事件明细（无法计算执行/等待）
    pub no_event_detail: bool,
    /// 事件按会话内时间窗归属到轮次（当前多数 Hook 不提供 run_id）
    pub window_attributed: bool,
    pub late_events: u32,
    pub unknown_timestamp_events: u32,
    /// 同一轮次连续重复的同状态事件（心跳/重复上报）
    pub coalesced_events: u32,
    /// 因证据/置信度不足未计入执行/等待的区间数
    pub unreliable_intervals: u32,
    /// 超长空档时长（不明，未计入执行/等待）
    pub gap_unknown_ms: i64,
    /// 时长中含推测成分（未关闭尾部/窗口归属）
    pub estimated: bool,
}

#[derive(Debug, Clone)]
pub struct RunInput {
    pub status: String,
    pub started_ms: Option<i64>,
    pub ended_ms: Option<i64>,
    pub last_event_ms: Option<i64>,
    pub events: Vec<RawEvent>,
}

#[derive(Debug, Clone, Copy)]
pub struct Range {
    pub from_ms: i64,
    pub to_ms: i64,
}

#[derive(Debug, Clone)]
pub struct AnalyzedRun {
    /// 已裁剪到窗口的状态区间（调用方据此汇总与分桶）
    pub slices: Vec<Slice>,
    pub span_ms: i64,
    pub span_known: bool,
    /// 非终态轮次最后事件 → now 的未确认尾部（不计入执行/等待）
    pub open_tail_ms: i64,
    pub terminal: Terminal,
    /// 终态是否由可靠事件确认（失败率只统计确认过的）
    pub terminal_verified: bool,
    pub flags: RunFlags,
    pub first_state: Option<String>,
    pub last_state: Option<String>,
    /// 实际参与时长计算的事件数
    pub events_used: usize,
    /// 最后确认事件时间（UI 展示「最后事件」）
    pub last_observed_ms: Option<i64>,
}

fn reliable(e: &RawEvent) -> bool {
    // 旧数据 evidence_type 为空时按 observed 兼容（列默认值即 observed）
    (e.evidence_type.is_empty() || e.evidence_type == "observed")
        && e.confidence >= MIN_RELIABLE_CONFIDENCE
}

fn clip(start: i64, end: i64, range: Range) -> Option<(i64, i64)> {
    let s = start.max(range.from_ms);
    let e = end.min(range.to_ms);
    if e > s {
        Some((s, e))
    } else {
        None
    }
}

/// 回放事件并按水位丢弃迟到事件（返回按时间递增的已受理事件）。
fn replay<'a>(events: &'a [RawEvent], flags: &mut RunFlags) -> Vec<(i64, &'a RawEvent)> {
    let mut sorted: Vec<&RawEvent> = events.iter().collect();
    sorted.sort_by_key(|e| e.ingest_seq);
    let mut applied: Vec<(i64, &RawEvent)> = Vec::new();
    let mut watermark: Option<i64> = None;
    for e in sorted {
        let Some(t) = e.occurred_ms else {
            flags.unknown_timestamp_events += 1;
            continue;
        };
        if let Some(w) = watermark {
            if t < w {
                flags.late_events += 1;
                continue;
            }
        }
        if let Some((_, prev)) = applied.last() {
            if state_kind(&prev.state) == state_kind(&e.state) {
                flags.coalesced_events += 1;
            }
        }
        applied.push((t, e));
        watermark = Some(t);
    }
    applied
}

pub fn analyze_run(input: &RunInput, range: Range, now_ms: i64, max_gap_ms: i64) -> AnalyzedRun {
    let mut flags = RunFlags::default();
    let status = state_kind(&input.status);
    let applied = replay(&input.events, &mut flags);

    flags.no_event_detail = applied.is_empty();
    flags.window_attributed = false; // 由调用方在窗口归属时置位
    let mut slices: Vec<Slice> = Vec::new();
    let mut events_used = 0usize;

    for (i, (t, e)) in applied.iter().enumerate() {
        let Some((next_t, _)) = applied.get(i + 1) else {
            break;
        };
        let kind = state_kind(&e.state);
        let mut slice_kind = match kind {
            StateKind::Running => Some(SliceKind::Exec),
            StateKind::Waiting => Some(SliceKind::Wait),
            StateKind::Idle => Some(SliceKind::Idle),
            StateKind::Completed | StateKind::Failed | StateKind::Disconnected => None,
            StateKind::Unknown => Some(SliceKind::Unknown),
        };
        // 终态事件之后的时间不再属于该轮次执行/等待
        let Some(mut sk) = slice_kind.take() else {
            continue;
        };
        events_used += 1;
        let raw_dur = next_t - t;
        if matches!(sk, SliceKind::Exec | SliceKind::Wait | SliceKind::Idle) && !reliable(e) {
            sk = SliceKind::Unknown;
            flags.unreliable_intervals += 1;
        }
        if raw_dur > max_gap_ms {
            // 超长空档：Agent 可能崩溃/离线，不能当执行
            sk = SliceKind::Unknown;
            if let Some((s, en)) = clip(*t, *next_t, range) {
                flags.gap_unknown_ms += en - s;
            }
        }
        if let Some((s, en)) = clip(*t, *next_t, range) {
            slices.push(Slice {
                start_ms: s,
                end_ms: en,
                kind: sk,
            });
        }
    }

    // 首个事件状态：非运行/等待说明开始前已有执行未观测到
    if let Some((_, first)) = applied.first() {
        flags.missing_start = !matches!(
            state_kind(&first.state),
            StateKind::Running | StateKind::Waiting
        );
    } else {
        flags.missing_start = true;
    }

    // 未关闭尾部：不计入执行，只作为「进行中（未确认）」
    let last_observed_ms = applied.last().map(|(t, _)| *t);
    let mut open_tail_ms = 0i64;
    let terminal_status = matches!(
        status,
        StateKind::Completed | StateKind::Failed | StateKind::Disconnected
    );
    if !terminal_status {
        if let Some(lt) = last_observed_ms {
            let tail_end = now_ms.min(range.to_ms);
            let tail_start = lt.max(range.from_ms);
            if tail_end > tail_start {
                open_tail_ms = tail_end - tail_start;
                flags.estimated = true;
                if open_tail_ms > STALE_OPEN_MS {
                    flags.stale_open = true;
                }
            }
        }
    }

    // 终态判定
    let (terminal, terminal_verified) = match status {
        StateKind::Completed | StateKind::Failed => {
            let expected = status;
            let found = applied
                .iter()
                .rev()
                .map(|(_, e)| e)
                .find(|e| state_kind(&e.state) == expected && reliable(e));
            match found {
                Some(_) => (
                    if expected == StateKind::Completed {
                        Terminal::Completed
                    } else {
                        Terminal::Failed
                    },
                    true,
                ),
                None => {
                    flags.missing_end = true;
                    (Terminal::UnknownTerminal, false)
                }
            }
        }
        StateKind::Disconnected => (Terminal::Interrupted, false),
        _ => (Terminal::Unresolved, false),
    };

    // 跨度：started_at → 终态/最后事件中最晚的端点，按窗口裁剪。
    // 取最晚端点而不是只看 ended_at：ended_at 可能停留在首个终态（后续 completed→failed
    // 修正），会话时间窗归属的事件也可能晚于轮次行记录的 last_event_at；
    // 否则「执行/等待」会比「总运行跨度」还长，出现自相矛盾的口径。
    let applied_last = applied.last().map(|(t, _)| *t);
    let start = input.started_ms.or(applied.first().map(|(t, _)| *t));
    let end_observed = if terminal_status {
        [input.ended_ms, applied_last, input.last_event_ms]
            .into_iter()
            .flatten()
            .max()
    } else {
        [input.last_event_ms, applied_last]
            .into_iter()
            .flatten()
            .max()
    };
    let mut span_ms = 0i64;
    let mut span_known = false;
    if let (Some(s), Some(e)) = (start, end_observed) {
        if e >= s {
            span_known = true;
            if let Some((cs, ce)) = clip(s, e, range) {
                span_ms = ce - cs;
            }
        }
    }
    if !terminal_status && last_observed_ms.is_none() {
        // 非终态却没有任何可确认事件：结束未知
        flags.missing_end = true;
    }
    if terminal_status && end_observed.is_none() {
        flags.missing_end = true;
    }

    AnalyzedRun {
        slices,
        span_ms,
        span_known,
        open_tail_ms,
        terminal,
        terminal_verified,
        flags,
        first_state: applied.first().map(|(_, e)| e.state.clone()),
        last_state: applied.last().map(|(_, e)| e.state.clone()),
        events_used,
        last_observed_ms,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIN: i64 = 60_000;
    const HOUR: i64 = 60 * MIN;

    fn ev(state: &str, t: i64, seq: i64) -> RawEvent {
        RawEvent {
            state: state.into(),
            occurred_ms: Some(t),
            evidence_type: "observed".into(),
            confidence: 1.0,
            ingest_seq: seq,
        }
    }

    fn run(
        status: &str,
        started: i64,
        ended: Option<i64>,
        last: Option<i64>,
        events: Vec<RawEvent>,
    ) -> RunInput {
        RunInput {
            status: status.into(),
            started_ms: Some(started),
            ended_ms: ended,
            last_event_ms: last,
            events,
        }
    }

    fn total(a: &AnalyzedRun, kind: SliceKind) -> i64 {
        a.slices
            .iter()
            .filter(|s| s.kind == kind)
            .map(|s| s.end_ms - s.start_ms)
            .sum()
    }

    #[test]
    fn completed_run_exec_and_span() {
        let t0 = 1_000_000_000_000;
        let input = run(
            "completed",
            t0,
            Some(t0 + 10 * MIN),
            Some(t0 + 10 * MIN),
            vec![ev("running", t0, 1), ev("completed", t0 + 10 * MIN, 2)],
        );
        let a = analyze_run(
            &input,
            Range {
                from_ms: t0,
                to_ms: t0 + HOUR,
            },
            t0 + HOUR,
            MAX_PLAUSIBLE_GAP_MS,
        );
        assert_eq!(total(&a, SliceKind::Exec), 10 * MIN);
        assert_eq!(total(&a, SliceKind::Wait), 0);
        assert_eq!(a.span_ms, 10 * MIN);
        assert!(a.span_known);
        assert_eq!(a.terminal, Terminal::Completed);
        assert!(a.terminal_verified);
        assert_eq!(a.open_tail_ms, 0);
        assert!(!a.flags.missing_start);
    }

    #[test]
    fn waiting_then_resume_splits_exec_and_wait() {
        let t0 = 1_000_000_000_000;
        let input = run(
            "completed",
            t0,
            Some(t0 + 60 * MIN),
            Some(t0 + 60 * MIN),
            vec![
                ev("running", t0, 1),
                ev("waiting", t0 + 5 * MIN, 2),
                ev("running", t0 + 25 * MIN, 3),
                ev("completed", t0 + 60 * MIN, 4),
            ],
        );
        let a = analyze_run(
            &input,
            Range {
                from_ms: t0,
                to_ms: t0 + 2 * HOUR,
            },
            t0 + 2 * HOUR,
            MAX_PLAUSIBLE_GAP_MS,
        );
        assert_eq!(total(&a, SliceKind::Exec), 5 * MIN + 35 * MIN);
        assert_eq!(total(&a, SliceKind::Wait), 20 * MIN);
        assert!(a.terminal_verified);
    }

    #[test]
    fn failed_run_is_verified_terminal() {
        let t0 = 1_000_000_000_000;
        let input = run(
            "failed",
            t0,
            Some(t0 + 3 * MIN),
            Some(t0 + 3 * MIN),
            vec![ev("running", t0, 1), ev("failed", t0 + 3 * MIN, 2)],
        );
        let a = analyze_run(
            &input,
            Range {
                from_ms: t0,
                to_ms: t0 + HOUR,
            },
            t0 + HOUR,
            MAX_PLAUSIBLE_GAP_MS,
        );
        assert_eq!(a.terminal, Terminal::Failed);
        assert!(a.terminal_verified);
        assert_eq!(total(&a, SliceKind::Exec), 3 * MIN);
    }

    #[test]
    fn disconnected_is_interrupted_not_failure() {
        let t0 = 1_000_000_000_000;
        let input = run(
            "disconnected",
            t0,
            Some(t0 + 2 * MIN),
            Some(t0 + 2 * MIN),
            vec![ev("running", t0, 1), ev("disconnected", t0 + 2 * MIN, 2)],
        );
        let a = analyze_run(
            &input,
            Range {
                from_ms: t0,
                to_ms: t0 + HOUR,
            },
            t0 + HOUR,
            MAX_PLAUSIBLE_GAP_MS,
        );
        assert_eq!(a.terminal, Terminal::Interrupted);
        assert!(!a.terminal_verified);
        assert_eq!(total(&a, SliceKind::Exec), 2 * MIN);
    }

    #[test]
    fn duplicate_events_are_flagged_but_do_not_double_count() {
        let t0 = 1_000_000_000_000;
        let input = run(
            "completed",
            t0,
            Some(t0 + 10 * MIN),
            Some(t0 + 10 * MIN),
            vec![
                ev("running", t0, 1),
                ev("running", t0 + 2 * MIN, 2),
                ev("running", t0 + 2 * MIN, 3), // 完全重复（dedupe 未命中的旧数据）
                ev("completed", t0 + 10 * MIN, 4),
            ],
        );
        let a = analyze_run(
            &input,
            Range {
                from_ms: t0,
                to_ms: t0 + HOUR,
            },
            t0 + HOUR,
            MAX_PLAUSIBLE_GAP_MS,
        );
        assert_eq!(total(&a, SliceKind::Exec), 10 * MIN);
        assert_eq!(a.flags.coalesced_events, 2);
    }

    #[test]
    fn late_event_cannot_rewind_state() {
        let t0 = 1_000_000_000_000;
        let input = run(
            "completed",
            t0,
            Some(t0 + 10 * MIN),
            Some(t0 + 10 * MIN),
            vec![
                ev("running", t0, 1),
                ev("waiting", t0 + 10 * MIN, 2),
                ev("running", t0 + 3 * MIN, 3), // 迟到事件：时间更旧、受理更晚
                ev("completed", t0 + 12 * MIN, 4),
            ],
        );
        let a = analyze_run(
            &input,
            Range {
                from_ms: t0,
                to_ms: t0 + HOUR,
            },
            t0 + HOUR,
            MAX_PLAUSIBLE_GAP_MS,
        );
        assert_eq!(a.flags.late_events, 1);
        assert_eq!(total(&a, SliceKind::Wait), 2 * MIN);
        assert_eq!(total(&a, SliceKind::Exec), 10 * MIN);
    }

    #[test]
    fn missing_end_event_is_open_tail_and_excluded() {
        let t0 = 1_000_000_000_000;
        let now = t0 + 5 * HOUR;
        let input = run(
            "running",
            t0,
            None,
            Some(t0 + 30 * MIN),
            vec![ev("running", t0, 1), ev("running", t0 + 30 * MIN, 2)],
        );
        let a = analyze_run(
            &input,
            Range {
                from_ms: t0,
                to_ms: now,
            },
            now,
            MAX_PLAUSIBLE_GAP_MS,
        );
        assert_eq!(a.terminal, Terminal::Unresolved);
        assert_eq!(
            total(&a, SliceKind::Exec),
            30 * MIN,
            "只统计有事件确认的区间"
        );
        assert!(a.open_tail_ms > 0);
        assert!(a.flags.stale_open);
        assert_eq!(a.span_ms, 30 * MIN);
    }

    #[test]
    fn missing_start_flags_terminal_only_run() {
        let t0 = 1_000_000_000_000;
        let input = run(
            "completed",
            t0,
            Some(t0),
            Some(t0),
            vec![ev("completed", t0, 1)],
        );
        let a = analyze_run(
            &input,
            Range {
                from_ms: t0 - HOUR,
                to_ms: t0 + HOUR,
            },
            t0 + HOUR,
            MAX_PLAUSIBLE_GAP_MS,
        );
        assert!(a.flags.missing_start);
        assert_eq!(a.terminal, Terminal::Completed);
        assert_eq!(total(&a, SliceKind::Exec), 0);
        assert_eq!(a.span_ms, 0);
    }

    #[test]
    fn long_gap_becomes_unknown_not_exec() {
        let t0 = 1_000_000_000_000;
        let input = run(
            "completed",
            t0,
            Some(t0 + 10 * HOUR),
            Some(t0 + 10 * HOUR),
            vec![ev("running", t0, 1), ev("completed", t0 + 10 * HOUR, 2)],
        );
        let a = analyze_run(
            &input,
            Range {
                from_ms: t0,
                to_ms: t0 + 12 * HOUR,
            },
            t0 + 12 * HOUR,
            MAX_PLAUSIBLE_GAP_MS,
        );
        assert_eq!(total(&a, SliceKind::Exec), 0);
        assert_eq!(total(&a, SliceKind::Unknown), 10 * HOUR);
        assert_eq!(a.flags.gap_unknown_ms, 10 * HOUR);
    }

    #[test]
    fn low_confidence_or_process_evidence_is_unknown() {
        let t0 = 1_000_000_000_000;
        let mut e1 = ev("running", t0, 1);
        e1.evidence_type = "process".into();
        let mut e2 = ev("running", t0 + 5 * MIN, 2);
        e2.confidence = 0.3;
        let input = run(
            "completed",
            t0,
            Some(t0 + 10 * MIN),
            Some(t0 + 10 * MIN),
            vec![e1, e2, ev("completed", t0 + 10 * MIN, 3)],
        );
        let a = analyze_run(
            &input,
            Range {
                from_ms: t0,
                to_ms: t0 + HOUR,
            },
            t0 + HOUR,
            MAX_PLAUSIBLE_GAP_MS,
        );
        assert_eq!(total(&a, SliceKind::Exec), 0);
        assert_eq!(a.flags.unreliable_intervals, 2);
        assert_eq!(total(&a, SliceKind::Unknown), 10 * MIN);
    }

    #[test]
    fn unparseable_timestamp_is_counted_not_guessed() {
        let t0 = 1_000_000_000_000;
        let mut bad = ev("running", t0, 2);
        bad.occurred_ms = None;
        let input = run(
            "completed",
            t0,
            Some(t0 + 5 * MIN),
            Some(t0 + 5 * MIN),
            vec![ev("running", t0, 1), bad, ev("completed", t0 + 5 * MIN, 3)],
        );
        let a = analyze_run(
            &input,
            Range {
                from_ms: t0,
                to_ms: t0 + HOUR,
            },
            t0 + HOUR,
            MAX_PLAUSIBLE_GAP_MS,
        );
        assert_eq!(a.flags.unknown_timestamp_events, 1);
        assert_eq!(total(&a, SliceKind::Exec), 5 * MIN);
    }

    #[test]
    fn cross_midnight_is_clipped_to_window() {
        // 30 分钟执行跨统计窗口起点：只计窗口内部分
        let midnight = 1_000_000_000_000;
        let t0 = midnight - 20 * MIN;
        let input = run(
            "completed",
            t0,
            Some(t0 + 30 * MIN),
            Some(t0 + 30 * MIN),
            vec![ev("running", t0, 1), ev("completed", t0 + 30 * MIN, 2)],
        );
        let a = analyze_run(
            &input,
            Range {
                from_ms: midnight,
                to_ms: midnight + HOUR,
            },
            midnight + HOUR,
            MAX_PLAUSIBLE_GAP_MS,
        );
        assert_eq!(total(&a, SliceKind::Exec), 10 * MIN);
        assert_eq!(a.span_ms, 10 * MIN);
    }

    #[test]
    fn concurrent_runs_are_isolated() {
        let t0 = 1_000_000_000_000;
        let a_run = run(
            "completed",
            t0,
            Some(t0 + 10 * MIN),
            Some(t0 + 10 * MIN),
            vec![ev("running", t0, 1), ev("completed", t0 + 10 * MIN, 2)],
        );
        let b_run = run(
            "failed",
            t0 + 2 * MIN,
            Some(t0 + 4 * MIN),
            Some(t0 + 4 * MIN),
            vec![
                ev("running", t0 + 2 * MIN, 3),
                ev("failed", t0 + 4 * MIN, 4),
            ],
        );
        let r = Range {
            from_ms: t0,
            to_ms: t0 + HOUR,
        };
        let aa = analyze_run(&a_run, r, t0 + HOUR, MAX_PLAUSIBLE_GAP_MS);
        let bb = analyze_run(&b_run, r, t0 + HOUR, MAX_PLAUSIBLE_GAP_MS);
        assert_eq!(total(&aa, SliceKind::Exec), 10 * MIN);
        assert_eq!(total(&bb, SliceKind::Exec), 2 * MIN);
        assert_eq!(aa.terminal, Terminal::Completed);
        assert_eq!(bb.terminal, Terminal::Failed);
    }

    #[test]
    fn terminal_without_event_is_unverified() {
        let t0 = 1_000_000_000_000;
        let input = run(
            "completed",
            t0,
            Some(t0 + 5 * MIN),
            Some(t0 + 5 * MIN),
            vec![],
        );
        let a = analyze_run(
            &input,
            Range {
                from_ms: t0,
                to_ms: t0 + HOUR,
            },
            t0 + HOUR,
            MAX_PLAUSIBLE_GAP_MS,
        );
        assert_eq!(a.terminal, Terminal::UnknownTerminal);
        assert!(!a.terminal_verified);
        assert_eq!(a.span_ms, 5 * MIN, "没有明细时仍可用轮次起止跨度");
    }

    #[test]
    fn corrected_terminal_does_not_truncate_confirmed_activity() {
        // completed 之后被修正为 failed：ended_at 停留在首个终态（10 分），
        // 后续事件（12 分）仍是该轮次的已确认活动，跨度必须覆盖到最晚端点。
        let t0 = 1_000_000_000_000;
        let input = run(
            "failed",
            t0,
            Some(t0 + 10 * MIN),
            Some(t0 + 12 * MIN),
            vec![
                ev("running", t0, 1),
                ev("completed", t0 + 10 * MIN, 2),
                ev("failed", t0 + 12 * MIN, 3),
            ],
        );
        let a = analyze_run(
            &input,
            Range {
                from_ms: t0,
                to_ms: t0 + HOUR,
            },
            t0 + HOUR,
            MAX_PLAUSIBLE_GAP_MS,
        );
        assert_eq!(a.terminal, Terminal::Failed);
        assert_eq!(a.span_ms, 12 * MIN);
        assert!(total(&a, SliceKind::Exec) <= a.span_ms);
    }

    #[test]
    fn span_covers_window_attributed_event_past_last_event_at() {
        // 无 run_id 的事件按会话时间窗归属，可能晚于轮次行记录的 last_event_at（10 分）：
        // 跨度必须覆盖到最后一个已确认事件，否则执行会比跨度长。
        let t0 = 1_000_000_000_000;
        let input = run(
            "running",
            t0,
            None,
            Some(t0 + 10 * MIN),
            vec![ev("running", t0, 1), ev("running", t0 + 30 * MIN, 2)],
        );
        let a = analyze_run(
            &input,
            Range {
                from_ms: t0,
                to_ms: t0 + HOUR,
            },
            t0 + HOUR,
            MAX_PLAUSIBLE_GAP_MS,
        );
        assert_eq!(a.span_ms, 30 * MIN);
        assert!(total(&a, SliceKind::Exec) <= a.span_ms);
    }

    #[test]
    fn large_event_stream_is_linear_and_bounded() {
        let t0 = 1_000_000_000_000;
        let mut events = Vec::with_capacity(100_000);
        for i in 0..100_000i64 {
            events.push(ev("running", t0 + i * 100, i));
        }
        events.push(ev("completed", t0 + 100_000 * 100, 100_000));
        let input = run(
            "completed",
            t0,
            Some(t0 + 100_000 * 100),
            Some(t0 + 100_000 * 100),
            events,
        );
        let started = std::time::Instant::now();
        let a = analyze_run(
            &input,
            Range {
                from_ms: t0,
                to_ms: t0 + 4 * HOUR,
            },
            t0 + 4 * HOUR,
            MAX_PLAUSIBLE_GAP_MS,
        );
        assert_eq!(total(&a, SliceKind::Exec), 100_000 * 100);
        assert_eq!(a.flags.coalesced_events, 99_999);
        assert!(
            started.elapsed().as_millis() < 2000,
            "10 万事件回放应保持线性，实际 {:?}",
            started.elapsed()
        );
    }
}
