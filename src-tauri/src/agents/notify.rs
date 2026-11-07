//! OS 通知的跨批次治理。
//!
//! 数据库中的通知历史逐条保留（同事务提交，不因限流丢失），这里只决定
//! 「哪些弹出到桌面」：
//! - 双额度限流：等待/失败等关键通知与完成/提醒等普通通知各自拥有独立的
//!   `burst_max` 窗口额度。普通通知（哪怕跨批次）刷满自己的额度后，关键
//!   通知仍可弹出，不会被挤进摘要；两类额度都有上界，不会无限弹窗；
//! - 完成合并：同一批/同一窗口的高频完成合并为一条摘要，避免刷屏；
//! - 被抑制的通知在窗口结束时汇总一条摘要（调度器每秒调用 `flush`），
//!   摘要本身也每窗口最多一条。
//!
//! 纯逻辑、无 Tauri 依赖，便于单元测试。

use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy)]
pub struct NotificationPolicy {
    /// 窗口内最多独立弹窗数（1~20）
    pub burst_max: u32,
    /// 限流窗口
    pub window: Duration,
    /// 高频完成是否合并为摘要
    pub aggregate_done: bool,
}

impl Default for NotificationPolicy {
    fn default() -> Self {
        Self {
            burst_max: 3,
            window: Duration::from_secs(60),
            aggregate_done: true,
        }
    }
}

impl NotificationPolicy {
    pub fn from_settings(settings: &crate::db::Settings) -> Self {
        Self {
            burst_max: settings.notify_burst_max.clamp(1, 20),
            window: Duration::from_secs(settings.notify_rate_window_secs.clamp(10, 3600) as u64),
            aggregate_done: settings.notify_done_aggregate,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct NotifyItem {
    pub kind: String,
    pub title: String,
    pub body: String,
    /// 关联对象（agent_runs.id）；用于自定义通知窗口「查看详情」跳转。
    pub ref_id: Option<String>,
    /// 来源 Agent（agent_sources.id）。
    pub source_id: Option<String>,
    /// 所属会话（agent_sessions.id）。
    pub session_id: Option<String>,
    /// 事件附带的原因/错误摘要（失败/等待卡展开详情用；不写入通知历史正文）。
    pub detail: Option<String>,
}

impl NotifyItem {
    pub fn new(kind: &str, title: &str, body: &str) -> Self {
        Self {
            kind: kind.into(),
            title: title.into(),
            body: body.into(),
            ..Default::default()
        }
    }

    /// 附带回执原因（失败错误、等待原因），只供通知窗口模板展示。
    pub fn with_detail(mut self, detail: Option<String>) -> Self {
        self.detail = detail;
        self
    }

    /// 携带跳转元数据的完整构造（ingest / 断连清理使用）。
    pub fn with_ref(
        mut self,
        ref_id: Option<String>,
        source_id: Option<String>,
        session_id: Option<String>,
    ) -> Self {
        self.ref_id = ref_id;
        self.source_id = source_id;
        self.session_id = session_id;
        self
    }

    /// 关键类型（等待/失败/断连）：使用独立的保底弹窗额度，
    /// 不与可合并的普通通知（完成、执行中、提醒）争抢，也不会被它们挤占。
    fn is_critical(&self) -> bool {
        !self.is_aggregateable()
    }

    /// 可合并类型：同一批出现多条时合并为一条摘要（执行中、完成、任务提醒）。
    fn is_aggregateable(&self) -> bool {
        matches!(
            self.kind.as_str(),
            "agent_running" | "agent_done" | "reminder"
        )
    }
}

/// 一个允许弹出的桌面通知：自定义通知窗口的渲染载荷。
/// OS toast 兜底只使用 title/body；结构化字段仅供窗口模板使用。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Popup {
    pub kind: String,
    pub title: String,
    pub body: String,
    pub ref_id: Option<String>,
    pub source_id: Option<String>,
    pub session_id: Option<String>,
    /// 事件原因/错误摘要（仅通知窗口模板使用，不进入 OS toast）。
    pub detail: Option<String>,
    /// 受理时间（RFC3339，本地展示「刚刚 / N 分钟前」）。
    pub created_at: String,
}

impl Popup {
    /// 由已放行的载荷构造展示卡（历史补录汇总等不经 NotifyGate 的摘要也复用同一结构）。
    pub(crate) fn from_item(item: &NotifyItem, created_at: String) -> Self {
        Self {
            kind: item.kind.clone(),
            title: item.title.clone(),
            body: item.body.clone(),
            ref_id: item.ref_id.clone(),
            source_id: item.source_id.clone(),
            session_id: item.session_id.clone(),
            detail: item.detail.clone(),
            created_at,
        }
    }

    fn digest_popup(n: u32, created_at: String) -> Self {
        Self {
            kind: "digest".into(),
            title: "Agent 通知摘要".into(),
            body: format!("另有 {n} 条通知已记录到收件箱（已合并，避免打扰）"),
            ref_id: None,
            source_id: None,
            session_id: None,
            detail: None,
            created_at,
        }
    }
}

#[derive(Debug, Default)]
pub struct NotifyGate {
    window_start: Option<Instant>,
    /// 本窗口内普通（可合并）通知已弹出的条数
    emitted: u32,
    /// 本窗口内关键（等待/失败/断连）通知已弹出的条数——独立保底额度
    emitted_critical: u32,
    /// 本窗口内被抑制、尚未汇总的通知数
    pending: u32,
    /// 本窗口是否已经发过摘要（每窗口最多一条）
    digest_sent: bool,
}

impl NotifyGate {
    pub fn new() -> Self {
        Self::default()
    }

    /// 处理一批已提交的通知；返回应弹出的桌面通知。
    /// 调用方负责静音/开关过滤——静音时不应调用本方法，否则会消耗额度。
    pub fn plan(
        &mut self,
        now: Instant,
        policy: &NotificationPolicy,
        items: &[NotifyItem],
    ) -> Vec<Popup> {
        let mut popups = self.roll_window(now, policy);

        // 关键通知（等待/失败/断连）走独立保底额度，优先弹出；
        // 完成与任务提醒合并后走普通额度。
        let mut critical: Vec<&NotifyItem> = Vec::new();
        let mut aggregateable: Vec<&NotifyItem> = Vec::new();
        for item in items {
            if item.is_critical() {
                critical.push(item);
            } else {
                aggregateable.push(item);
            }
        }
        for item in critical {
            self.emit_or_suppress(&mut popups, item, policy, true);
        }

        for (kind, group) in group_by_kind(aggregateable) {
            if policy.aggregate_done && group.len() > 1 {
                let (title, body) = summary_for(&kind, &group);
                let merged = NotifyItem::new(&kind, &title, &body);
                self.emit_or_suppress(&mut popups, &merged, policy, false);
            } else {
                for item in group {
                    self.emit_or_suppress(&mut popups, item, policy, false);
                }
            }
        }

        if self.pending > 0 && !self.digest_sent {
            popups.push(self.digest());
        }
        popups
    }

    /// 调度器周期调用：窗口结束后把尾部被抑制的通知汇总弹出（每窗口最多一条）。
    pub fn flush(&mut self, now: Instant, policy: &NotificationPolicy) -> Option<Popup> {
        let expired = self
            .window_start
            .map(|s| now.duration_since(s) >= policy.window)
            .unwrap_or(true);
        if !expired {
            return None;
        }
        let popup = if self.pending > 0 {
            Some(self.digest())
        } else {
            None
        };
        self.roll_window(now, policy);
        popup
    }

    fn emit_or_suppress(
        &mut self,
        popups: &mut Vec<Popup>,
        item: &NotifyItem,
        policy: &NotificationPolicy,
        critical: bool,
    ) {
        // 关键与普通通知各用一份 burst_max 额度：普通通知刷满自己的额度后，
        // 关键通知仍可及时弹出；两类额度均有上界。
        let emitted = if critical {
            &mut self.emitted_critical
        } else {
            &mut self.emitted
        };
        if *emitted < policy.burst_max {
            *emitted += 1;
            popups.push(Popup::from_item(item, crate::agents::now_iso()));
        } else {
            self.pending += 1;
        }
    }

    fn digest(&mut self) -> Popup {
        let n = self.pending;
        self.pending = 0;
        self.digest_sent = true;
        Popup::digest_popup(n, crate::agents::now_iso())
    }

    /// 窗口结束时先汇总尾部，再重置额度。
    fn roll_window(&mut self, now: Instant, policy: &NotificationPolicy) -> Vec<Popup> {
        let expired = self
            .window_start
            .map(|s| now.duration_since(s) >= policy.window)
            .unwrap_or(true);
        if !expired {
            return Vec::new();
        }
        let tail = if self.pending > 0 {
            Some(self.digest())
        } else {
            None
        };
        self.window_start = Some(now);
        self.emitted = 0;
        self.emitted_critical = 0;
        self.digest_sent = false;
        tail.into_iter().collect()
    }
}

/// 按 kind 分组（保持首次出现顺序），用于把同类通知合并成一条摘要。
fn group_by_kind(items: Vec<&NotifyItem>) -> Vec<(String, Vec<&NotifyItem>)> {
    let mut groups: Vec<(String, Vec<&NotifyItem>)> = Vec::new();
    for item in items {
        match groups.iter_mut().find(|(kind, _)| *kind == item.kind) {
            Some((_, list)) => list.push(item),
            None => groups.push((item.kind.clone(), vec![item])),
        }
    }
    groups
}

/// 同类多条通知的摘要文案。
fn summary_for(kind: &str, group: &[&NotifyItem]) -> (String, String) {
    let n = group.len();
    let bodies: Vec<&str> = group.iter().take(3).map(|i| i.body.as_str()).collect();
    match kind {
        "reminder" => (
            "任务提醒汇总".to_string(),
            format!("{} 个任务提醒 · {}", n, bodies.join("；")),
        ),
        "agent_running" => (
            "Agent 批量执行中".to_string(),
            format!("{} 个轮次正在执行 · {}", n, bodies.join("；")),
        ),
        _ => (
            "Agent 批量完成".to_string(),
            format!("{} 个轮次已完成 · {}", n, bodies.join("；")),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy(burst: u32, window_secs: u64, aggregate: bool) -> NotificationPolicy {
        NotificationPolicy {
            burst_max: burst,
            window: Duration::from_secs(window_secs),
            aggregate_done: aggregate,
        }
    }

    fn failure(i: usize) -> NotifyItem {
        NotifyItem::new("agent_failed", "Agent 执行失败", &format!("失败 {}", i))
    }

    fn done(i: usize) -> NotifyItem {
        NotifyItem::new("agent_done", "Agent 本轮执行完成", &format!("完成 {}", i))
    }

    fn waiting(i: usize) -> NotifyItem {
        NotifyItem::new("agent_waiting", "Agent 等待处理", &format!("等待 {}", i))
    }

    fn running(i: usize) -> NotifyItem {
        NotifyItem::new("agent_running", "Agent 正在执行", &format!("执行 {}", i))
    }

    #[test]
    fn running_notifications_are_aggregateable_not_critical() {
        // v0.7 通知系统：执行中属普通优先级——同批多条合并为摘要，
        // 且占用普通额度，不挤占等待/失败/断连的保底额度。
        let p = policy(2, 60, true);
        let mut gate = NotifyGate::new();
        let popups = gate.plan(Instant::now(), &p, &[running(1), running(2), failure(9)]);
        assert_eq!(popups[0].title, "Agent 执行失败", "失败走保底额度优先弹出");
        assert!(
            popups.iter().any(|p| p.title == "Agent 批量执行中"),
            "多条执行中合并为一条摘要"
        );
        assert_eq!(popups.len(), 2);
    }

    fn reminder(i: usize) -> NotifyItem {
        NotifyItem::new("reminder", "任务提醒", &format!("提醒 {}", i))
    }

    #[test]
    fn many_reminders_collapse_into_one_summary() {
        let p = policy(3, 60, true);
        let mut gate = NotifyGate::new();
        let popups = gate.plan(
            Instant::now(),
            &p,
            &[
                reminder(1),
                reminder(2),
                reminder(3),
                reminder(4),
                reminder(5),
            ],
        );
        assert_eq!(popups.len(), 1, "一批到期提醒只弹一条摘要");
        assert_eq!(popups[0].title, "任务提醒汇总");
        assert!(popups[0].body.contains("5 个任务提醒"));
    }

    #[test]
    fn reminders_do_not_displace_waiting_notifications() {
        let p = policy(2, 60, true);
        let mut gate = NotifyGate::new();
        let popups = gate.plan(Instant::now(), &p, &[reminder(1), reminder(2), waiting(3)]);
        assert_eq!(popups[0].title, "Agent 等待处理", "等待输入优先于任务提醒");
        assert!(
            popups.iter().any(|p| p.title == "任务提醒汇总"),
            "提醒仍以摘要形式送达"
        );
    }

    #[test]
    fn single_reminder_stays_prompt() {
        let p = policy(3, 60, true);
        let mut gate = NotifyGate::new();
        let popups = gate.plan(Instant::now(), &p, &[reminder(1)]);
        assert_eq!(popups.len(), 1);
        assert_eq!(popups[0].title, "任务提醒");
    }

    #[test]
    fn global_limit_spans_batches_and_digests_once() {
        let p = policy(2, 60, true);
        let t0 = Instant::now();
        let mut gate = NotifyGate::new();

        let first = gate.plan(t0, &p, &[failure(1), failure(2)]);
        assert_eq!(first.len(), 2, "窗口内前两条独立弹出");

        let second = gate.plan(t0 + Duration::from_secs(1), &p, &[failure(3), failure(4)]);
        assert_eq!(second.len(), 1, "跨批次超限后只弹一条摘要");
        assert!(second[0].body.contains('2'), "摘要应包含被抑制数量");

        let third = gate.plan(t0 + Duration::from_secs(2), &p, &[failure(5)]);
        assert!(third.is_empty(), "同一窗口摘要只发一次");
    }

    #[test]
    fn waiting_and_failure_are_prioritized_and_prompt() {
        let p = policy(2, 60, true);
        let mut gate = NotifyGate::new();
        let t0 = Instant::now();
        let popups = gate.plan(t0, &p, &[done(1), done(2), done(3), waiting(9), failure(8)]);
        assert_eq!(popups[0].title, "Agent 等待处理", "等待优先于完成");
        assert_eq!(popups[1].title, "Agent 执行失败", "失败优先于完成");
        assert!(
            popups.iter().any(|p| p.title == "Agent 批量完成"),
            "完成走普通额度，合并为一条摘要"
        );
    }

    #[test]
    fn critical_not_starved_by_exhausted_low_budget() {
        // P1 回归：普通通知先刷满额度，之后到达的失败/等待仍必须独立弹出
        let p = policy(2, 60, false);
        let t0 = Instant::now();
        let mut gate = NotifyGate::new();
        let first = gate.plan(t0, &p, &[done(1), done(2)]);
        assert_eq!(first.len(), 2, "普通通知用满自己的额度");

        let second = gate.plan(t0 + Duration::from_secs(1), &p, &[failure(9)]);
        assert_eq!(second.len(), 1, "关键通知走保底额度，不被挤进摘要");
        assert_eq!(second[0].body, "失败 9");

        let third = gate.plan(t0 + Duration::from_secs(2), &p, &[waiting(7)]);
        assert_eq!(third.len(), 1);
        assert_eq!(third[0].title, "Agent 等待处理");
    }

    #[test]
    fn critical_budget_is_bounded_too() {
        // 保底额度也有上界：超出的关键通知进入摘要，不无限弹窗
        let p = policy(2, 60, true);
        let mut gate = NotifyGate::new();
        let popups = gate.plan(
            Instant::now(),
            &p,
            &[failure(1), failure(2), failure(3), failure(4)],
        );
        assert_eq!(
            popups
                .iter()
                .filter(|p| p.title == "Agent 执行失败")
                .count(),
            2
        );
        assert!(popups.last().unwrap().body.contains("已合并"));
    }

    #[test]
    fn high_frequency_completions_collapse_into_one_popup() {
        let p = policy(3, 60, true);
        let mut gate = NotifyGate::new();
        let popups = gate.plan(
            Instant::now(),
            &p,
            &[done(1), done(2), done(3), done(4), done(5)],
        );
        assert_eq!(popups.len(), 1);
        assert!(popups[0].body.contains("5 个轮次已完成"));
        assert_eq!(popups[0].title, "Agent 批量完成");
    }

    #[test]
    fn single_completion_is_prompt() {
        let p = policy(3, 60, true);
        let mut gate = NotifyGate::new();
        let popups = gate.plan(Instant::now(), &p, &[done(1)]);
        assert_eq!(popups.len(), 1);
        assert_eq!(popups[0].title, "Agent 本轮执行完成");
    }

    #[test]
    fn aggregation_disabled_shows_individual_completions_up_to_limit() {
        let p = policy(3, 60, false);
        let mut gate = NotifyGate::new();
        let popups = gate.plan(
            Instant::now(),
            &p,
            &[done(1), done(2), done(3), done(4), done(5)],
        );
        assert_eq!(
            popups
                .iter()
                .filter(|p| p.title == "Agent 本轮执行完成")
                .count(),
            3
        );
        assert!(popups.last().unwrap().body.contains("已合并"));
    }

    #[test]
    fn tail_digest_flushes_after_window_expiry() {
        let p = policy(1, 10, true);
        let t0 = Instant::now();
        let mut gate = NotifyGate::new();
        gate.plan(t0, &p, &[failure(1), failure(2)]);
        // 同一窗口内继续抑制，但不重复摘要
        let mid = gate.plan(t0 + Duration::from_secs(3), &p, &[failure(3)]);
        assert!(mid.is_empty());
        assert!(gate.flush(t0 + Duration::from_secs(5), &p).is_none());
        let tail = gate.flush(t0 + Duration::from_secs(11), &p);
        let tail = tail.expect("窗口结束应汇总尾部通知");
        assert!(
            tail.body.contains('1'),
            "尾部摘要只统计首次摘要之后被抑制的通知"
        );
        assert!(gate.flush(t0 + Duration::from_secs(12), &p).is_none());
    }

    #[test]
    fn window_rollover_restores_full_budget() {
        let p = policy(1, 10, true);
        let t0 = Instant::now();
        let mut gate = NotifyGate::new();
        assert_eq!(gate.plan(t0, &p, &[failure(1)]).len(), 1);
        let suppressed = gate.plan(t0 + Duration::from_secs(1), &p, &[failure(2)]);
        assert_eq!(suppressed.len(), 1, "超出额度只发摘要");
        assert_eq!(suppressed[0].title, "Agent 通知摘要");
        let next = gate.plan(t0 + Duration::from_secs(12), &p, &[failure(3)]);
        assert_eq!(next.len(), 1, "新窗口恢复独立弹窗额度");
        assert_eq!(next[0].body, "失败 3");
    }

    #[test]
    fn empty_batch_never_consumes_budget() {
        let p = policy(1, 60, true);
        let mut gate = NotifyGate::new();
        let t0 = Instant::now();
        assert!(gate.plan(t0, &p, &[]).is_empty());
        assert_eq!(
            gate.plan(t0 + Duration::from_secs(1), &p, &[waiting(1)])
                .len(),
            1
        );
    }
}
