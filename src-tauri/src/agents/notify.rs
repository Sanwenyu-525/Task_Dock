//! OS 通知的跨批次治理。
//!
//! 数据库中的通知历史逐条保留（同事务提交，不因限流丢失），这里只决定
//! 「哪些弹出到桌面」：
//! - 全局窗口限流：窗口内最多 `burst_max` 条独立弹窗，跨批次累计；
//! - 完成合并：同一批/同一窗口的高频完成合并为一条摘要，避免刷屏；
//! - 等待/失败优先：先于完成占用弹窗额度，保证需要介入的状态及时到达；
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotifyItem {
    pub kind: String,
    pub title: String,
    pub body: String,
}

impl NotifyItem {
    pub fn new(kind: &str, title: &str, body: &str) -> Self {
        Self {
            kind: kind.into(),
            title: title.into(),
            body: body.into(),
        }
    }

    /// 可合并类型：同一批出现多条时合并为一条摘要（完成、任务提醒）。
    fn is_aggregateable(&self) -> bool {
        matches!(self.kind.as_str(), "agent_done" | "reminder")
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Popup {
    pub title: String,
    pub body: String,
}

impl Popup {
    fn new(title: impl Into<String>, body: impl Into<String>) -> Self {
        Self {
            title: title.into(),
            body: body.into(),
        }
    }
}

#[derive(Debug, Default)]
pub struct NotifyGate {
    window_start: Option<Instant>,
    emitted: u32,
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

        // 等待/失败/断连优先占用额度；完成与任务提醒合并后使用剩余额度。
        let mut priority: Vec<&NotifyItem> = Vec::new();
        let mut aggregateable: Vec<&NotifyItem> = Vec::new();
        for item in items {
            if item.is_aggregateable() {
                aggregateable.push(item);
            } else {
                priority.push(item);
            }
        }
        for item in priority {
            self.emit_or_suppress(&mut popups, item.title.clone(), item.body.clone(), policy);
        }

        for (kind, group) in group_by_kind(aggregateable) {
            if policy.aggregate_done && group.len() > 1 {
                let (title, body) = summary_for(&kind, &group);
                self.emit_or_suppress(&mut popups, title, body, policy);
            } else {
                for item in group {
                    self.emit_or_suppress(
                        &mut popups,
                        item.title.clone(),
                        item.body.clone(),
                        policy,
                    );
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
        title: String,
        body: String,
        policy: &NotificationPolicy,
    ) {
        if self.emitted < policy.burst_max {
            self.emitted += 1;
            popups.push(Popup::new(title, body));
        } else {
            self.pending += 1;
        }
    }

    fn digest(&mut self) -> Popup {
        let n = self.pending;
        self.pending = 0;
        self.digest_sent = true;
        Popup::new(
            "Agent 通知摘要",
            format!("另有 {} 条通知已记录到收件箱（已合并，避免打扰）", n),
        )
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
            popups.iter().any(|p| p.body.contains("已合并")),
            "被抑制的通知要汇总"
        );
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
