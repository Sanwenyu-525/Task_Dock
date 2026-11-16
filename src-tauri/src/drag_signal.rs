//! 拖拽相位信号：原生窗口过程 → 前端拖拽光标会话的**唯一**协议。
//!
//! ## 为什么需要代次（generation）
//! `WM_ENTERSIZEMOVE` / `WM_EXITSIZEMOVE` 是窗口级事实，但信号到达前端是异步的。
//! 只按「收到结束信号就结束全部会话」处理会有跨会话竞态：
//!
//! 1. 第一次拖动结束，原生投递结束信号；
//! 2. 信号尚未被前端消费；
//! 3. 用户立即按下第二次拖动，前端建立新会话（`grabbing`）；
//! 4. 旧结束信号此刻才送达，把**新会话**结束掉 → 鼠标还按着，抓手指针却没了。
//!
//! 单靠原生侧「处理消息时是否仍在移动循环」挡不住这段窗口期。因此每次
//! `WM_ENTERSIZEMOVE` 递增一个代次，开始/结束都带上同一个代次；前端只结束
//! **代次匹配**的会话，未绑定代次的会话不受任何原生结束信号影响。
//!
//! ## 会话令牌（token）：把 start 精确归属到发起它的那次按下
//! 只靠代次仍有一个缺口：迟到的**旧 start** 可能在新会话建立之后才到达，前端
//! 无法判断它属于旧拖拽还是当前这次按下。窗口过程本身不知道前端会话身份，
//! 所以由前端在 `pointerdown` 时先发 `arm_drag_session(token)`（这个时刻系统
//! 移动循环尚未开始，命令一定先于 `start_dragging` 执行），窗口过程在下一次
//! `WM_ENTERSIZEMOVE` 取出该 hwnd 的待用 token，并原样附在 start/end 载荷里。
//!
//! 前端因此不再需要在模态循环里做一次 `drag_loop_active` IPC 查询：token 命中
//! 就直接绑定/收尾，迟到的旧事件带着旧 token，天然不会误伤新会话。代次与
//! `drag_loop_active` 查询保留为**没有 token 的载荷**（旧协议/降级）的兜底。
//!
//! token 只用于本机同一窗口的一次按下：限制长度 64、字符集 `[A-Za-z0-9_-]`，
//! 3 秒未消费即作废（双击最大化等没有进入移动循环的按下不会留下幽灵身份）。
//!
//! ## 事件与载荷
//! 窗口级事件（`emit` 到该窗口，不广播，天然不串台）：
//!
//! ```text
//! event: "window-drag"
//! payload: { "phase": "start" | "end", "generation": 1, "token": "..." }
//! ```
//!
//! `token` 可能缺省（旧协议或没有经过 `arm_drag_session` 的循环）；前端按代次兜底。
//!
//! 两段原生实现共用本协议：
//! - 主窗：`magnetic.rs`（已有 `WM_MOVING` 子类化，不重复安装）；
//! - 微件窗口：`drag_watch.rs`（轻量相位监视，不含磁吸状态机）。

use serde::Serialize;

/// 窗口级拖拽相位事件名（只发给发出它的那个窗口）。
pub const DRAG_EVENT: &str = "window-drag";

/// 相位：移动循环开始 / 结束。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DragPhase {
    Start,
    End,
}

/// 事件载荷。`generation` 单调递增，同一轮拖拽的开始与结束必须一致。
///
/// `token` 是前端在按下时预置的会话身份（见模块文档）；缺省时前端退回代次关联。
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct DragEvent {
    pub phase: DragPhase,
    pub generation: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
}

impl DragEvent {
    pub fn start(generation: u64) -> Self {
        Self { phase: DragPhase::Start, generation, token: None }
    }

    pub fn end(generation: u64) -> Self {
        Self { phase: DragPhase::End, generation, token: None }
    }

    /// 附上本次按下的会话身份；`None` 时保持缺省（旧协议/无身份循环）。
    pub fn with_token(mut self, token: Option<String>) -> Self {
        self.token = token;
        self
    }
}

/// 前端预置的按下身份：注册表按 hwnd 存一项，窗口过程在 `WM_ENTERSIZEMOVE`
/// 取走。只在本机、同一窗口、一次按下的窗口期内有效。
#[cfg(windows)]
mod armed {
    use std::sync::Mutex;
    use std::time::{Duration, Instant};

    /// 未消费的 token 最多保留 3 秒：双击最大化等不进入移动循环的按下不应
    /// 把身份留给下一次无关的循环。
    const TTL: Duration = Duration::from_secs(3);

    /// 与前端生成规则一致：base36 时间戳 + 序号 + 随机后缀，远小于上限。
    const MAX_LEN: usize = 64;

    struct ArmedToken {
        token: String,
        armed_at: Instant,
    }

    static ARMED: Mutex<Vec<(isize, ArmedToken)>> = Mutex::new(Vec::new());

    fn valid(token: &str) -> bool {
        !token.is_empty()
            && token.len() <= MAX_LEN
            && token
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    }

    fn prune(list: &mut Vec<(isize, ArmedToken)>) {
        list.retain(|(_, armed)| armed.armed_at.elapsed() <= TTL);
    }

    /// 预置一次按下的会话身份；同一 hwnd 的新身份覆盖旧身份。
    pub fn arm(hwnd: isize, token: String) {
        if hwnd == 0 || !valid(&token) {
            return;
        }
        let mut list = ARMED.lock().unwrap_or_else(|e| e.into_inner());
        prune(&mut list);
        list.retain(|(h, _)| *h != hwnd);
        list.push((hwnd, ArmedToken { token, armed_at: Instant::now() }));
    }

    /// 取出并消费指定窗口的待用身份。
    pub fn take(hwnd: isize) -> Option<String> {
        let mut list = ARMED.lock().unwrap_or_else(|e| e.into_inner());
        prune(&mut list);
        let index = list.iter().position(|(h, _)| *h == hwnd)?;
        Some(list.remove(index).1.token)
    }
}

/// 预置一次按下的会话身份（非 Windows 无操作）。
#[cfg(windows)]
pub fn arm_token(hwnd: isize, token: String) {
    armed::arm(hwnd, token);
}

#[cfg(not(windows))]
pub fn arm_token(_hwnd: isize, _token: String) {}

/// 取出并消费指定窗口的待用身份（非 Windows 恒为 None）。
#[cfg(windows)]
pub fn take_token(hwnd: isize) -> Option<String> {
    armed::take(hwnd)
}

#[cfg(not(windows))]
pub fn take_token(_hwnd: isize) -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_is_attached_only_when_present() {
        assert_eq!(DragEvent::start(3).with_token(None).token, None);
        assert_eq!(
            DragEvent::end(4).with_token(Some("a-1".to_string())).token.as_deref(),
            Some("a-1")
        );
    }

    #[cfg(windows)]
    #[test]
    fn armed_token_is_scoped_to_window_and_consumed_once() {
        // 使用不会与真实窗口冲突的诊断句柄；arm/take 只读写本模块的注册表。
        let hwnd = 0x7FFF_0001_isize;
        arm_token(hwnd, "d-test-01".to_string());
        assert_eq!(take_token(hwnd).as_deref(), Some("d-test-01"));
        assert_eq!(take_token(hwnd), None);
        // 另一个窗口不会取到本窗口的身份。
        assert_eq!(take_token(hwnd + 1), None);
    }

    #[cfg(windows)]
    #[test]
    fn invalid_token_is_rejected() {
        let hwnd = 0x7FFF_0002_isize;
        arm_token(hwnd, String::new());
        arm_token(hwnd, "含中文的令牌".to_string());
        arm_token(hwnd, "x".repeat(65));
        assert_eq!(take_token(hwnd), None);
    }
}
