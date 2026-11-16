//! 应用退出前的正文保存握手状态机。
//!
//! Rust 发出 `app-before-exit` 后，在有限时间内等待工作台回执；收到 `true` 才继续
//! 原有退出排空，收到 `false`/超时则取消本次退出并把控制权交回给用户重试。
//! 该模块只持有回执状态，不依赖 Tauri，便于对超时与重复回执做单元测试。

use std::sync::Mutex;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WaitError {
    Timeout,
}

struct Pending {
    request_id: u64,
    result: Option<bool>,
}

pub struct ExitHandshake {
    pending: Mutex<Option<Pending>>,
}

impl ExitHandshake {
    pub const fn new() -> Self {
        Self {
            pending: Mutex::new(None),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Option<Pending>> {
        self.pending.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// 开始一次握手；已有未完成请求时拒绝，避免两个退出流程并行。
    pub fn begin(&self, request_id: u64) -> bool {
        let mut pending = self.lock();
        if pending.is_some() {
            return false;
        }
        *pending = Some(Pending {
            request_id,
            result: None,
        });
        true
    }

    /// 记录工作台回执。只有请求号匹配且尚未回执时才接受；先到的回执为准。
    pub fn complete(&self, request_id: u64, ok: bool) -> bool {
        let mut pending = self.lock();
        match pending.as_mut() {
            Some(entry) if entry.request_id == request_id && entry.result.is_none() => {
                entry.result = Some(ok);
                true
            }
            _ => false,
        }
    }

    /// 取消未完成握手（保存失败、超时或退出被取消）。
    pub fn cancel(&self, request_id: u64) {
        let mut pending = self.lock();
        if pending
            .as_ref()
            .is_some_and(|entry| entry.request_id == request_id)
        {
            *pending = None;
        }
    }

    fn take_result(&self, request_id: u64) -> Option<bool> {
        let mut pending = self.lock();
        let ready = pending.as_ref().and_then(|entry| {
            (entry.request_id == request_id)
                .then_some(entry.result)
                .flatten()
        });
        if ready.is_some() {
            *pending = None;
        }
        ready
    }

    /// 有界等待回执；超时返回 `Timeout`，不会无限阻塞退出流程。
    pub async fn wait(
        &self,
        request_id: u64,
        timeout: Duration,
    ) -> Result<bool, WaitError> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(ok) = self.take_result(request_id) {
                return Ok(ok);
            }
            let now = Instant::now();
            if now >= deadline {
                self.cancel(request_id);
                return Err(WaitError::Timeout);
            }
            let remaining = deadline.saturating_duration_since(now);
            tokio::time::sleep(remaining.min(Duration::from_millis(25))).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn accepts_matching_true_ack() {
        let handshake = ExitHandshake::new();
        assert!(handshake.begin(7));
        assert!(handshake.complete(7, true));
        assert_eq!(
            handshake.wait(7, Duration::from_millis(100)).await,
            Ok(true)
        );
    }

    #[tokio::test]
    async fn accepts_matching_false_ack() {
        let handshake = ExitHandshake::new();
        assert!(handshake.begin(8));
        assert!(handshake.complete(8, false));
        assert_eq!(
            handshake.wait(8, Duration::from_millis(100)).await,
            Ok(false)
        );
    }

    #[tokio::test]
    async fn wrong_and_duplicate_acks_are_rejected() {
        let handshake = ExitHandshake::new();
        assert!(handshake.begin(9));
        assert!(!handshake.complete(10, true));
        assert!(handshake.complete(9, true));
        assert!(!handshake.complete(9, false));
        assert_eq!(
            handshake.wait(9, Duration::from_millis(100)).await,
            Ok(true)
        );
    }

    #[tokio::test]
    async fn no_ack_times_out_without_blocking_forever() {
        let handshake = ExitHandshake::new();
        assert!(handshake.begin(11));
        assert_eq!(
            handshake.wait(11, Duration::from_millis(40)).await,
            Err(WaitError::Timeout)
        );
        // 超时已清理，下一次退出请求可以重新开始。
        assert!(handshake.begin(12));
    }

    #[test]
    fn concurrent_begin_is_rejected() {
        let handshake = ExitHandshake::new();
        assert!(handshake.begin(13));
        assert!(!handshake.begin(14));
        handshake.cancel(13);
        assert!(handshake.begin(15));
    }
}
