//! 锁定策略判定。只做纯计算，便于单测；实际执行由后端单 ticker 或窗口事件调用。

use std::time::Instant;

use crate::secure_vault::session::{LockReason, VaultSession};

pub fn should_lock_now(session: &VaultSession, now: Instant) -> Option<LockReason> {
    if !session.is_unlocked() {
        return None;
    }
    if let Some(since) = session.background_since {
        let limit = session.lock_settings.background_secs;
        if limit == 0 || now.duration_since(since).as_secs() >= limit {
            return Some(LockReason::Background);
        }
    }
    let idle_limit = session.lock_settings.idle_secs;
    if idle_limit == 0 || now.duration_since(session.last_activity).as_secs() >= idle_limit {
        return Some(LockReason::Idle);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secure_vault::session::{RuntimeState, VaultSession};

    fn unlocked() -> VaultSession {
        let mut s = VaultSession::default();
        s.runtime = RuntimeState::Unlocked;
        s
    }

    #[test]
    fn locked_session_never_triggers() {
        let s = VaultSession::default();
        assert!(should_lock_now(&s, Instant::now()).is_none());
    }

    #[test]
    fn idle_limit_triggers() {
        let mut s = unlocked();
        s.lock_settings.idle_secs = 5;
        s.last_activity = Instant::now() - std::time::Duration::from_secs(6);
        assert_eq!(should_lock_now(&s, Instant::now()), Some(LockReason::Idle));
    }

    #[test]
    fn background_limit_triggers_even_when_recent_activity() {
        let mut s = unlocked();
        s.lock_settings.background_secs = 3;
        s.background_since = Some(Instant::now() - std::time::Duration::from_secs(4));
        assert_eq!(
            should_lock_now(&s, Instant::now()),
            Some(LockReason::Background)
        );
    }

    #[test]
    fn zero_means_immediate() {
        let mut s = unlocked();
        s.lock_settings.idle_secs = 0;
        assert_eq!(should_lock_now(&s, Instant::now()), Some(LockReason::Idle));
    }
}
