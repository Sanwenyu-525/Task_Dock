//! 快速捕获窗口的生命周期状态机（纯函数）。
//!
//! 背景：旧实现只要收到 `WindowEvent::Focused(false)`、且窗口可见就隐藏。这条规则
//! 把四种完全不同的情形混成一种：
//!
//! 1. 窗口刚 `show()`、尚未拿到焦点（Windows 前台锁拒绝激活时会一直停在这里）；
//! 2. 焦点从顶层窗口交给自己的 WebView2 子窗口（父窗口收到 `WM_KILLFOCUS`，
//!    tao 照样抛 `Focused(false)`，但窗口仍在前台、仍可输入）；
//! 3. 用户真的切到别的程序；
//! 4. 我们自己 `hide()` 引起的失焦。
//!
//! 把 1/2 当成 (3) 处理，就会出现「窗口一闪而过」或「点了输入框才活过来」。
//! 本模块只做状态判定：什么时候允许自动隐藏、什么时候该尝试激活。真实窗口操作
//! （show / hide / SetForegroundWindow）留在 `mod.rs`，状态在这里可单测。
//!
//! 关键不变式：
//! - **只有进入过 `Active`**，之后的失焦才允许自动隐藏（`FocusLost` 在
//!   `Showing`/`AwaitingFocus` 一律忽略）；
//! - 每次显示开启新周期，激活预算重置；预算耗尽后不再调用 `SetForegroundWindow`，
//!   窗口保持可见并提示用户点击输入区（不做无界重试，也没有后台轮询）；
//! - `Closing` 是幂等终态：重复关闭、关闭期间的失焦事件都不会再次触发隐藏。

/// 窗口生命周期阶段。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    /// 未显示（启动即隐藏，或上次显示已结束）。
    Hidden,
    /// 已请求显示，窗口尚未确认可见。
    Showing,
    /// 窗口可见但尚未确认成为前台窗口（可能被系统前台锁拒绝）。
    AwaitingFocus,
    /// 窗口可见且已确认在前台。
    Active,
    /// 正在隐藏（`hide()` 调用中或已请求隐藏）。
    Closing,
}

/// 生命周期事件。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Signal {
    /// 显式显示请求（热键 / 收集箱入口）。
    Show,
    /// 窗口已真正可见（`IsWindowVisible` 为真）。
    Revealed,
    /// 请求把窗口提到前台（显示流程或用户显式操作）。
    Activate,
    /// 已确认成为前台窗口（`Focused(true)` 或激活核实成功）。
    FocusGained,
    /// 顶层窗口失焦（可能是子窗口接管焦点，也可能是用户切走）。
    FocusLost,
    /// 用户主动关闭（Escape / 关闭按钮 / 热键收起 / 保存成功）。
    Dismiss,
    /// 隐藏实际完成（`hide()` 返回后）。
    Hidden,
}

/// 状态机给出的动作。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    /// 无需窗口操作。
    None,
    /// 调用一次前台激活（受预算限制，绝不无界重试）。
    AttemptActivation,
    /// 执行隐藏；`restore_focus` 表示是否把焦点还给唤起前的窗口。
    Hide { restore_focus: bool },
}

/// 单个显示周期内允许的激活尝试次数。
///
/// 热键唤起通常一次成功；显式点击「快速记录」时若窗口已可见但不在前台，需要一次
/// 补激活。给到 2 次足够覆盖这两种情况，又不会在系统拒绝时反复抢焦点。
pub const MAX_ACTIVATION_ATTEMPTS: u8 = 2;

/// 生命周期状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LifecycleState {
    pub phase: Phase,
    /// 本显示周期已发出的激活请求次数。
    pub attempts: u8,
    /// 显示周期序号（每次从 Hidden 进入 Showing 时 +1，便于诊断）。
    pub show_seq: u64,
}

impl LifecycleState {
    pub const fn initial() -> Self {
        Self {
            phase: Phase::Hidden,
            attempts: 0,
            show_seq: 0,
        }
    }

    /// 是否处于「可以安全地自动隐藏」的阶段。
    pub fn auto_hide_allowed(&self) -> bool {
        self.phase == Phase::Active
    }

    fn with_phase(self, phase: Phase) -> Self {
        Self { phase, ..self }
    }
}

/// 状态转移（纯函数）。
///
/// 返回 `(新状态, 动作)`。动作只表达「该做什么」，由调用方执行；这样状态机本身
/// 不依赖 Tauri/Win32，可以在任何平台上单测。
pub fn step(state: LifecycleState, signal: Signal) -> (LifecycleState, Action) {
    use Action::{AttemptActivation, Hide, None as Idle};
    use Phase::{Active, AwaitingFocus, Closing, Hidden, Showing};

    match signal {
        // 显示：开启新周期，重置激活预算
        Signal::Show => match state.phase {
            // 只登记「开始显示」：真正的激活要等窗口可见后（Revealed）才发，
            // 否则会对一个尚未出现的窗口调用 SetForegroundWindow。
            Hidden => (
                LifecycleState {
                    phase: Showing,
                    attempts: 0,
                    show_seq: state.show_seq.wrapping_add(1),
                },
                Idle,
            ),
            // 已可见时再次显式打开：只做一次补激活，绝不收起
            Showing | AwaitingFocus | Active => {
                (state.with_phase(state.phase), attempt(state).1)
            }
            Closing => (state, Idle),
        },

        Signal::Revealed => match state.phase {
            // 显示流程里 show() 已完成，等待焦点确认；这次激活同样计入预算，
            // 保证「后端显示 + 前端补救」合计不超过每轮上限。
            Showing => attempt(state.with_phase(AwaitingFocus)),
            _ => (state, Idle),
        },

        // 激活请求：预算内才真正调用系统 API
        Signal::Activate => match state.phase {
            Showing | AwaitingFocus => attempt(state),
            // 已在前台时用户显式再点一次入口：给一次补激活预算（可能被其他
            // 置顶窗口压住），仍然只尝试一次。
            Active => (
                LifecycleState {
                    attempts: 1,
                    ..state
                },
                AttemptActivation,
            ),
            Hidden | Closing => (state, Idle),
        },

        Signal::FocusGained => match state.phase {
            Showing | AwaitingFocus | Active => (state.with_phase(Active), Idle),
            Hidden | Closing => (state, Idle),
        },

        // 关键闸门：未进入过 Active 的失焦一律忽略（刚显示 / 子窗口接管焦点）
        Signal::FocusLost => match state.phase {
            Active => (
                state.with_phase(Closing),
                Hide {
                    restore_focus: false,
                },
            ),
            _ => (state, Idle),
        },

        // 主动关闭：可见、未结束的周期都可以关闭；焦点还给唤起前的窗口
        Signal::Dismiss => match state.phase {
            Showing | AwaitingFocus | Active => (
                state.with_phase(Closing),
                Hide { restore_focus: true },
            ),
            Hidden | Closing => (state, Idle),
        },

        Signal::Hidden => match state.phase {
            Closing | Showing | AwaitingFocus | Active => (
                LifecycleState {
                    phase: Hidden,
                    attempts: 0,
                    show_seq: state.show_seq,
                },
                Idle,
            ),
            Hidden => (state, Idle),
        },
    }
}

/// 预算内的激活：只有真正发出尝试才计数。
fn attempt(state: LifecycleState) -> (LifecycleState, Action) {
    if state.attempts >= MAX_ACTIVATION_ATTEMPTS {
        (state, Action::None)
    } else {
        (
            LifecycleState {
                attempts: state.attempts + 1,
                ..state
            },
            Action::AttemptActivation,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(signals: &[Signal]) -> (LifecycleState, Vec<Action>) {
        let mut state = LifecycleState::initial();
        let mut actions = Vec::new();
        for &signal in signals {
            let (next, action) = step(state, signal);
            state = next;
            actions.push(action);
        }
        (state, actions)
    }

    fn last(signals: &[Signal]) -> (LifecycleState, Action) {
        let (state, actions) = run(signals);
        (state, *actions.last().expect("至少一步"))
    }

    #[test]
    fn initial_state_is_hidden_without_attempts() {
        let state = LifecycleState::initial();
        assert_eq!(state.phase, Phase::Hidden);
        assert_eq!(state.attempts, 0);
        assert!(!state.auto_hide_allowed());
    }

    #[test]
    fn show_opens_new_cycle_without_activating_hidden_window() {
        let (state, action) = step(LifecycleState::initial(), Signal::Show);
        assert_eq!(state.phase, Phase::Showing);
        assert_eq!(state.show_seq, 1);
        assert_eq!(state.attempts, 0, "窗口可见前不发激活请求");
        assert_eq!(action, Action::None);
        // 可见之后才激活
        let (state, action) = step(state, Signal::Revealed);
        assert_eq!(state.phase, Phase::AwaitingFocus);
        assert_eq!(state.attempts, 1);
        assert_eq!(action, Action::AttemptActivation);
    }

    #[test]
    fn revealed_window_waits_for_focus_without_hiding() {
        let (state, actions) = run(&[Signal::Show, Signal::Revealed]);
        assert_eq!(state.phase, Phase::AwaitingFocus);
        // Show 只登记显示；窗口可见后才发激活
        assert_eq!(actions, vec![Action::None, Action::AttemptActivation]);
        // 刚显示就收到 Focused(false)：绝不能隐藏
        let (state, action) = step(state, Signal::FocusLost);
        assert_eq!(state.phase, Phase::AwaitingFocus);
        assert_eq!(action, Action::None);
    }

    #[test]
    fn focus_loss_before_active_never_hides() {
        for signals in [
            vec![Signal::Show, Signal::FocusLost],
            vec![Signal::Show, Signal::Revealed, Signal::FocusLost],
        ] {
            let (state, actions) = run(&signals);
            assert_ne!(state.phase, Phase::Closing, "未激活过的失焦不得关闭");
            assert!(!actions.contains(&Action::Hide { restore_focus: false }));
            assert!(state.phase == Phase::Showing || state.phase == Phase::AwaitingFocus);
        }
    }

    #[test]
    fn active_window_hides_on_real_focus_loss_without_stealing_focus() {
        let (state, action) = last(&[
            Signal::Show,
            Signal::Revealed,
            Signal::FocusGained,
            Signal::FocusLost,
        ]);
        assert_eq!(state.phase, Phase::Closing);
        assert_eq!(action, Action::Hide { restore_focus: false });
    }

    #[test]
    fn dismiss_from_every_visible_phase_hides_and_restores_focus() {
        for signals in [
            vec![Signal::Show, Signal::Dismiss],
            vec![Signal::Show, Signal::Revealed, Signal::Dismiss],
            vec![
                Signal::Show,
                Signal::Revealed,
                Signal::FocusGained,
                Signal::Dismiss,
            ],
        ] {
            let (state, action) = last(&signals);
            assert_eq!(state.phase, Phase::Closing);
            assert_eq!(action, Action::Hide { restore_focus: true });
        }
    }

    #[test]
    fn closing_is_idempotent() {
        let (state, _) = run(&[Signal::Show, Signal::Dismiss]);
        for signal in [
            Signal::Dismiss,
            Signal::FocusLost,
            Signal::FocusGained,
            Signal::Show,
            Signal::Activate,
            Signal::Revealed,
        ] {
            let (next, action) = step(state, signal);
            assert_eq!(next.phase, Phase::Closing, "signal={signal:?}");
            assert_eq!(action, Action::None, "signal={signal:?}");
        }
        // Hidden 事件才收敛回起点
        let (state, action) = step(state, Signal::Hidden);
        assert_eq!(state.phase, Phase::Hidden);
        assert_eq!(action, Action::None);
    }

    #[test]
    fn hidden_after_close_resets_for_next_cycle() {
        let state = run(&[Signal::Show, Signal::Dismiss, Signal::Hidden]).0;
        assert_eq!(state.phase, Phase::Hidden);
        assert_eq!(state.attempts, 0);
        let (state, action) = step(state, Signal::Show);
        assert_eq!(state.phase, Phase::Showing);
        assert_eq!(state.show_seq, 2, "重新唤起必须开启新周期");
        assert_eq!(action, Action::None, "窗口可见前不激活");
        let (state, action) = step(state, Signal::Revealed);
        assert_eq!(state.phase, Phase::AwaitingFocus);
        assert_eq!(action, Action::AttemptActivation);
    }

    #[test]
    fn activation_attempts_are_bounded_per_cycle() {
        let mut state = step(LifecycleState::initial(), Signal::Show).0;
        state = step(state, Signal::Revealed).0;
        // Revealed 已消耗一次预算，此后只剩 MAX-1 次
        let mut attempts = state.attempts;
        for _ in 0..10 {
            let (next, action) = step(state, Signal::Activate);
            state = next;
            if action == Action::AttemptActivation {
                attempts += 1;
            }
        }
        assert_eq!(attempts, MAX_ACTIVATION_ATTEMPTS, "不得无界抢焦点");
        assert_eq!(state.phase, Phase::AwaitingFocus, "拒绝聚焦时窗口保持可见");
    }

    #[test]
    fn explicit_show_while_visible_never_hides() {
        let state = run(&[
            Signal::Show,
            Signal::Revealed,
            Signal::FocusGained,
            Signal::Show,
        ])
        .0;
        assert_eq!(state.phase, Phase::Active);
    }

    #[test]
    fn hide_action_only_happens_once() {
        let (_, actions) = run(&[
            Signal::Show,
            Signal::Revealed,
            Signal::FocusGained,
            Signal::FocusLost,
            Signal::FocusLost,
            Signal::Dismiss,
        ]);
        let hides = actions
            .iter()
            .filter(|a| matches!(a, Action::Hide { .. }))
            .count();
        assert_eq!(hides, 1, "隐藏只执行一次，重复事件不重复隐藏");
    }

    #[test]
    fn late_focus_events_after_hidden_are_ignored() {
        let state = run(&[
            Signal::Show,
            Signal::Revealed,
            Signal::FocusGained,
            Signal::FocusLost,
            Signal::Hidden,
        ])
        .0;
        for signal in [Signal::FocusLost, Signal::FocusGained, Signal::Activate] {
            let (next, action) = step(state, signal);
            assert_eq!(next, state);
            assert_eq!(action, Action::None);
        }
    }
}
