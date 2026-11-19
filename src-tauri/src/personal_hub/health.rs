//! 进程内 HealthMonitor：连续失败计数与降级标记（P1）。
//!
//! 只做可取消、有上限的状态统计；不启动轮询线程，不持有 Win32 句柄。

use crate::personal_hub::types::HubConfig;

#[derive(Debug)]
pub struct HealthMonitor {
    consecutive_failures: u32,
    threshold: u32,
    last_check_succeeded: bool,
}

impl HealthMonitor {
    pub fn new(config: &HubConfig) -> Self {
        Self {
            consecutive_failures: 0,
            threshold: config.health_failure_threshold.max(1),
            last_check_succeeded: true,
        }
    }

    pub fn record_success(&mut self) {
        self.consecutive_failures = 0;
        self.last_check_succeeded = true;
    }

    pub fn record_failure(&mut self) {
        self.consecutive_failures = self.consecutive_failures.saturating_add(1);
        self.last_check_succeeded = false;
    }

    pub fn is_degraded(&self) -> bool {
        self.consecutive_failures >= self.threshold
    }

    pub fn consecutive_failures(&self) -> u32 {
        self.consecutive_failures
    }

    pub fn reset(&mut self) {
        self.consecutive_failures = 0;
        self.last_check_succeeded = true;
    }

    pub fn last_check_succeeded(&self) -> bool {
        self.last_check_succeeded
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn consecutive_failures_cross_threshold() {
        let cfg = HubConfig {
            health_failure_threshold: 2,
            ..HubConfig::default()
        };
        let mut m = HealthMonitor::new(&cfg);
        assert!(!m.is_degraded());
        m.record_failure();
        assert!(!m.is_degraded());
        m.record_failure();
        assert!(m.is_degraded());
        assert_eq!(m.consecutive_failures(), 2);
        m.record_success();
        assert!(!m.is_degraded());
        assert_eq!(m.consecutive_failures(), 0);
    }

    #[test]
    fn threshold_is_never_zero() {
        let cfg = HubConfig {
            health_failure_threshold: 0,
            ..HubConfig::default()
        };
        let mut m = HealthMonitor::new(&cfg);
        m.record_failure();
        assert!(m.is_degraded());
    }
}
