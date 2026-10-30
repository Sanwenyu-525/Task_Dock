//! 恢复操作槽：进程内任意时刻最多一个后台恢复。
//!
//! 约束：
//! - 每次恢复有唯一 `operation_id`；释放槽只认自己的 id，旧任务绝不能清掉新任务；
//! - 已有操作时先请求取消，并等待它真正退出后才允许新操作进入；
//! - 槽的释放交给 RAII guard：正常结束、取消、失败、panic 都会走到 `finish`；
//! - 「取消已请求」与「已结束」是两个独立状态（`running` 仍为 true，直到线程退出）。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

struct Slot {
    op_id: String,
    snapshot_id: String,
    cancel: Arc<AtomicBool>,
}

#[derive(Debug, Clone, Default)]
pub struct GateStatus {
    pub running: bool,
    pub snapshot_id: Option<String>,
    pub operation_id: Option<String>,
    pub cancel_requested: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SlotBusy {
    pub waited_ms: u128,
}

pub struct RestoreGate {
    slot: Mutex<Option<Slot>>,
    released: Condvar,
}

impl RestoreGate {
    pub const fn new() -> Self {
        Self {
            slot: Mutex::new(None),
            released: Condvar::new(),
        }
    }

    /// 申请恢复槽。若已有操作：先置取消位，并等待其退出（最多 `wait`）。
    /// 超时仍占用则返回 Busy —— 绝不允许两个恢复同时运行。
    pub fn begin(
        &self,
        op_id: &str,
        snapshot_id: &str,
        wait: Duration,
    ) -> Result<Arc<AtomicBool>, SlotBusy> {
        let started = Instant::now();
        let mut guard = self.slot.lock().unwrap_or_else(|e| e.into_inner());
        if guard.is_some() {
            if let Some(s) = guard.as_ref() {
                s.cancel.store(true, Ordering::Release);
            }
            let deadline = started + wait;
            while guard.is_some() {
                let now = Instant::now();
                if now >= deadline {
                    break;
                }
                let (g, _) = self
                    .released
                    .wait_timeout(guard, deadline - now)
                    .unwrap_or_else(|e| e.into_inner());
                guard = g;
            }
            if guard.is_some() {
                return Err(SlotBusy {
                    waited_ms: started.elapsed().as_millis(),
                });
            }
        }
        let cancel = Arc::new(AtomicBool::new(false));
        *guard = Some(Slot {
            op_id: op_id.to_string(),
            snapshot_id: snapshot_id.to_string(),
            cancel: cancel.clone(),
        });
        Ok(cancel)
    }

    /// 只释放自己的槽；返回是否匹配。过期 operation 的清理不会影响新操作。
    pub fn finish(&self, op_id: &str) -> bool {
        let mut guard = self.slot.lock().unwrap_or_else(|e| e.into_inner());
        let matches = guard.as_ref().map(|s| s.op_id == op_id).unwrap_or(false);
        if matches {
            *guard = None;
            self.released.notify_all();
        }
        matches
    }

    pub fn request_cancel(&self, op_id: Option<&str>) -> bool {
        let guard = self.slot.lock().unwrap_or_else(|e| e.into_inner());
        match guard.as_ref() {
            Some(s) if op_id.is_none() || op_id == Some(s.op_id.as_str()) => {
                s.cancel.store(true, Ordering::Release);
                true
            }
            _ => false,
        }
    }

    pub fn status(&self) -> GateStatus {
        let guard = self.slot.lock().unwrap_or_else(|e| e.into_inner());
        match guard.as_ref() {
            Some(s) => GateStatus {
                running: true,
                snapshot_id: Some(s.snapshot_id.clone()),
                operation_id: Some(s.op_id.clone()),
                cancel_requested: s.cancel.load(Ordering::Acquire),
            },
            None => GateStatus::default(),
        }
    }
}

impl Default for RestoreGate {
    fn default() -> Self {
        Self::new()
    }
}

/// 持槽 guard：drop 时按 operation_id 释放，panic/取消/失败同样生效。
pub struct SlotGuard<'a> {
    gate: &'a RestoreGate,
    op_id: String,
}

impl<'a> SlotGuard<'a> {
    pub fn new(gate: &'a RestoreGate, op_id: impl Into<String>) -> Self {
        Self {
            gate,
            op_id: op_id.into(),
        }
    }
}

impl Drop for SlotGuard<'_> {
    fn drop(&mut self) {
        self.gate.finish(&self.op_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::panic::AssertUnwindSafe;

    fn short() -> Duration {
        Duration::from_millis(120)
    }

    #[test]
    fn begin_waits_until_previous_operation_exits() {
        let gate = std::sync::Arc::new(RestoreGate::new());
        let c1 = gate.begin("op1", "snap-a", short()).unwrap();
        c1.store(false, Ordering::Release);
        let g = gate.clone();
        let waiter = std::thread::spawn(move || g.begin("op2", "snap-b", Duration::from_secs(2)));
        std::thread::sleep(Duration::from_millis(200));
        assert!(gate.status().running, "旧操作未退出前不得进入新操作");
        assert!(gate.finish("op1"));
        let c2 = waiter.join().unwrap().unwrap();
        assert!(!c2.load(Ordering::Acquire));
        let st = gate.status();
        assert_eq!(st.operation_id.as_deref(), Some("op2"));
        assert_eq!(st.snapshot_id.as_deref(), Some("snap-b"));
    }

    #[test]
    fn cancel_then_restart_waits_for_real_exit() {
        let gate = std::sync::Arc::new(RestoreGate::new());
        let _c1 = gate.begin("op1", "snap-a", short()).unwrap();
        assert!(gate.request_cancel(None));
        let st = gate.status();
        assert!(st.running, "取消请求不等于完成");
        assert!(st.cancel_requested);

        let g = gate.clone();
        let waiter = std::thread::spawn(move || g.begin("op2", "snap-a", Duration::from_secs(2)));
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(
            gate.status().operation_id.as_deref(),
            Some("op1"),
            "新操作必须等旧线程真正退出"
        );
        assert!(gate.finish("op1"));
        waiter.join().unwrap().unwrap();
        assert_eq!(gate.status().operation_id.as_deref(), Some("op2"));
    }

    #[test]
    fn stale_operation_cannot_release_new_slot() {
        let gate = RestoreGate::new();
        let _c1 = gate.begin("op1", "snap-same", short()).unwrap();
        assert!(gate.finish("op1"));
        let _c2 = gate.begin("op2", "snap-same", short()).unwrap();
        // 旧线程迟到的清理不得释放新槽（旧实现只比较 snapshot_id，会误清）
        assert!(!gate.finish("op1"));
        assert_eq!(gate.status().operation_id.as_deref(), Some("op2"));
    }

    #[test]
    fn two_snapshots_compete_without_overlap() {
        let gate = RestoreGate::new();
        let _c1 = gate.begin("op1", "snap-a", short()).unwrap();
        let busy = gate.begin("op2", "snap-b", Duration::from_millis(40));
        assert!(busy.is_err(), "不同快照也不能并发恢复");
        assert_eq!(gate.status().operation_id.as_deref(), Some("op1"));
        assert!(gate.finish("op1"));
        let _c2 = gate.begin("op2", "snap-b", short()).unwrap();
        assert_eq!(gate.status().snapshot_id.as_deref(), Some("snap-b"));
    }

    #[test]
    fn slot_is_released_when_worker_panics() {
        let gate = RestoreGate::new();
        let _c = gate.begin("op-panic", "snap-a", short()).unwrap();
        let result = std::panic::catch_unwind(AssertUnwindSafe(|| {
            let _guard = SlotGuard::new(&gate, "op-panic");
            panic!("模拟恢复线程异常退出");
        }));
        assert!(result.is_err());
        assert!(!gate.status().running, "panic 后必须释放槽（guard drop）");
    }

    #[test]
    fn guard_releases_only_matching_operation() {
        let gate = RestoreGate::new();
        let c = gate.begin("op1", "snap-a", short()).unwrap();
        {
            let _guard = SlotGuard::new(&gate, "op1");
            assert!(gate.status().running);
        }
        assert!(!gate.status().running);
        assert!(!c.load(Ordering::Acquire));
    }

    /// 手动性能采样：取消 → 等待旧线程真正退出 → 新操作接管的交接延迟。
    /// `cargo test --release --lib bench_cancel_restart -- --ignored --nocapture`
    #[test]
    #[ignore = "性能采样：需手动运行"]
    fn bench_cancel_restart_handover_latency() {
        use std::time::Instant;

        let gate = std::sync::Arc::new(RestoreGate::new());
        let mut samples = Vec::new();
        let rounds = 50;
        for i in 0..rounds {
            let op = format!("op-{i}");
            let cancel = gate.begin(&op, "snap", Duration::from_secs(2)).unwrap();
            let worker_gate = gate.clone();
            let worker_op = op.clone();
            let worker = std::thread::spawn(move || {
                while !cancel.load(Ordering::Acquire) {
                    std::thread::sleep(Duration::from_micros(100));
                }
                // 模拟恢复线程在项间退出所需的收尾时间
                std::thread::sleep(Duration::from_micros(500));
                assert!(worker_gate.finish(&worker_op));
            });
            std::thread::sleep(Duration::from_millis(1));
            gate.request_cancel(None);
            let next_op = format!("next-{i}");
            let started = Instant::now();
            let _next = gate
                .begin(&next_op, "snap", Duration::from_secs(2))
                .expect("旧操作退出后新操作应接管");
            samples.push(started.elapsed().as_secs_f64() * 1000.0);
            assert!(gate.finish(&next_op));
            worker.join().unwrap();
        }
        samples.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let pct = |p: f64| samples[((samples.len() as f64 - 1.0) * p).round() as usize];
        println!(
            "workspace_restore_cancel_restart rounds={rounds} p50={:.3}ms p95={:.3}ms max={:.3}ms",
            pct(0.5),
            pct(0.95),
            samples[samples.len() - 1]
        );
        assert!(pct(0.95) < 100.0, "交接延迟不应接近 5s 超时上限");
    }
}
