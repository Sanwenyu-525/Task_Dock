//! 吸附反馈视觉层（拖拽候选提示 / 停靠细线 / 已吸附反馈）。
//!
//! v0.7 起**不再渲染隐藏态胶囊**：分类胶囊是停靠期的完整界面（`CapsuleDock`），
//! 窗口在停靠期间不再滑出屏幕，也不再被裁成一条窄条。本组件只保留拖拽阶段的
//! 反馈——那时窗口是完整可见的普通窗口，叠加层不会被区域裁掉。
//!
//! 方位语义（关键，未变）：拖拽到边缘时窗口仍完整可见，`snap-glow` 与
//! `snap-dock-line` 都按停靠边贴窗口边缘绘制，指示"松开后贴到哪条边"。

import { useEffect } from "react";
import { Magnet } from "lucide-react";
import { SNAP_FEEDBACK_MS } from "../lib/edgeSnap";
import { useEdgeSnapStore } from "../store/useEdgeSnapStore";

export default function SnapOverlay() {
  const phase = useEdgeSnapStore((s) => s.phase);
  const candidateEdge = useEdgeSnapStore((s) => s.candidateEdge);
  const feedback = useEdgeSnapStore((s) => s.feedback);

  // 「已吸附」反馈 1.2s 自动消失（重复停靠时 seq 变化会重置定时器）。
  // 胶囊态不画提示气泡（区域外不可见），反馈由 CapsuleDock 的短促脉冲承担。
  useEffect(() => {
    if (!feedback) return;
    const t = window.setTimeout(() => {
      useEdgeSnapStore.getState().clearFeedback();
    }, SNAP_FEEDBACK_MS);
    return () => window.clearTimeout(t);
  }, [feedback]);

  const dragging = phase === "candidate";

  return (
    <>
      {/* 拖近边缘：主题色光晕（纯装饰，不拦截拖拽指针） */}
      {dragging && candidateEdge && (
        <div className={`snap-glow snap-glow-${candidateEdge}`} aria-hidden="true" />
      )}

      {/* 停靠细线：拖拽相位沿候选边高亮，提示"松开即贴到这里" */}
      {dragging && candidateEdge && (
        <div
          className={`snap-dock-line snap-dock-line-${candidateEdge} snap-dock-line-hot`}
          aria-hidden="true"
        />
      )}

      {/* 停靠确认反馈（仅拖拽相位可读；停靠后由胶囊脉冲表达） */}
      {dragging && feedback && (
        <div className={`snap-feedback snap-feedback-${feedback.edge}`} role="status">
          <Magnet size={12} aria-hidden="true" />
          <span>松开吸附到{feedback.edge === "left" ? "左" : feedback.edge === "right" ? "右" : feedback.edge === "top" ? "上" : "下"}侧</span>
        </div>
      )}
    </>
  );
}
