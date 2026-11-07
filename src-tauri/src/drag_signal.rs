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
//! ## 事件与载荷
//! 窗口级事件（`emit` 到该窗口，不广播，天然不串台）：
//!
//! ```text
//! event: "window-drag"
//! payload: { "phase": "start" | "end", "generation": 1 }
//! ```
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
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct DragEvent {
    pub phase: DragPhase,
    pub generation: u64,
}

impl DragEvent {
    pub fn start(generation: u64) -> Self {
        Self { phase: DragPhase::Start, generation }
    }

    pub fn end(generation: u64) -> Self {
        Self { phase: DragPhase::End, generation }
    }
}
