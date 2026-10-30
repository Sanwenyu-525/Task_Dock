//! 进程级退出信号：先停接入方（HTTP 监听 / 文件投递），再由管线排空并落盘暂存。
//! 只由应用退出路径置位；置位后适配器不再接受新工作。

use std::sync::atomic::{AtomicBool, Ordering};

use tokio::sync::Notify;

static STOP: AtomicBool = AtomicBool::new(false);
static NOTIFY: Notify = Notify::const_new();

/// 通知所有接入适配器停止（幂等）。
pub fn begin() {
    STOP.store(true, Ordering::SeqCst);
    NOTIFY.notify_waiters();
}

pub fn is_set() -> bool {
    STOP.load(Ordering::Acquire)
}

/// 等待退出信号；已置位时立即返回。
pub async fn wait() {
    if is_set() {
        return;
    }
    let notified = NOTIFY.notified();
    tokio::pin!(notified);
    // 先注册再复查，避免「创建 future 之后、真正 poll 之前」漏掉 notify_waiters。
    notified.as_mut().enable();
    if is_set() {
        return;
    }
    notified.await;
}

#[cfg(test)]
pub(crate) fn reset_for_test() {
    STOP.store(false, Ordering::SeqCst);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn wait_wakes_registered_and_late_waiters() {
        reset_for_test();
        assert!(!is_set());
        let waiter = tokio::spawn(async { wait().await });
        tokio::time::sleep(Duration::from_millis(20)).await;
        begin();
        tokio::time::timeout(Duration::from_secs(2), waiter)
            .await
            .expect("已注册等待者必须被唤醒")
            .unwrap();
        assert!(is_set());
        tokio::time::timeout(Duration::from_millis(200), wait())
            .await
            .expect("置位后新等待者必须立即返回");
        reset_for_test();
    }
}
