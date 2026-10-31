//! Smart Dock Capsule（智能状态胶囊）+ 吸附反馈视觉层。
//!
//! 只渲染，不做决策；状态来自 useEdgeSnapStore（useEdgeSnap 引擎唯一写入）。
//! 信息来自既有 store（不引入任何新轮询）：
//! - 待办数：useTasksStore.stats.pending（事件驱动刷新的 TaskStats）；
//! - Agent 状态：useAgentsStore.snapshot + liveSummary() 聚合。
//! 数据未加载显示中性占位（–），异常状态（failed/waiting）提升视觉优先级，
//! 不闪烁、不暴露任务标题/Agent 名称/剪贴板内容/路径。
//!
//! 方位语义（关键）：隐藏窗口滑出后，**留在屏幕内的部分**与停靠边相反——
//! left 停靠的窗口向左滑出，露出的是窗口自身最右侧的窄区。因此胶囊的
//! CSS 定位是「停靠边的对侧」：capsule-left 在窗口右缘（贴屏幕左边）。
//! 胶囊 CSS 厚度 = --snap-capsule-t（32px）；隐藏坐标用
//! capsuleStripPhysical(scale) = round(32 × DPI) 物理像素，两者严格对应，
//! 内容不会被窗口边界裁切。
//!
//! 视觉约束：无系统 Toast、无音效、无循环动画；reduced-motion 由全局
//! CSS 媒体查询收敛。提示统一 data-tip（TooltipLayer），不用原生 title。

import { useEffect } from "react";
import { ChevronRight, ListTodo, Magnet } from "lucide-react";
import { SNAP_FEEDBACK_MS, candidateHintText, dockFeedbackText } from "../lib/edgeSnap";
import {
  capsuleAriaLabel,
  capsuleModel,
  type CapsuleInfo,
} from "../lib/capsuleModel";
import { useEdgeSnapStore } from "../store/useEdgeSnapStore";
import { useTasksStore } from "../store/useTasksStore";
import { useAgentsStore } from "../store/useAgentsStore";

/** 隐藏态状态胶囊：品牌标识 + 待办数 + Agent 运行数/状态点 + 展开箭头。 */
function DockCapsule({ edge, onReveal }: { edge: string; onReveal: (() => void) | null }) {
  // 窄订阅：只取需要的字段，避免全局重渲染
  const pending = useTasksStore((s) => s.stats?.pending ?? null);
  const snapshot = useAgentsStore((s) => s.snapshot);
  const info: CapsuleInfo = capsuleModel(pending, snapshot);
  const vertical = edge === "left" || edge === "right";

  return (
    <button
      type="button"
      className={[
        "snap-capsule",
        vertical ? "capsule-v" : "capsule-h",
        `capsule-${edge}`,
        info.alert ? `capsule-alert-${info.alert}` : "",
      ]
        .filter(Boolean)
        .join(" ")}
      aria-label={capsuleAriaLabel(edge, info)}
      data-tip="展开 Task Dock"
      onClick={() => onReveal?.()}
    >
      <Magnet size={11} className="capsule-brand" aria-hidden="true" />
      <span className="capsule-stat" aria-hidden="true">
        <ListTodo size={10} />
        <span className="capsule-num">{info.pendingLabel}</span>
      </span>
      <span className="capsule-stat" aria-hidden="true">
        <span className={`capsule-dot dot-${info.worst}`} />
        <span className="capsule-num">{info.agentLabel}</span>
      </span>
      {/* 展开指示：箭头始终朝向屏幕内部（方向由 edge 类旋转） */}
      <ChevronRight size={11} className="capsule-chevron" aria-hidden="true" />
    </button>
  );
}

export default function SnapOverlay() {
  const phase = useEdgeSnapStore((s) => s.phase);
  const candidateEdge = useEdgeSnapStore((s) => s.candidateEdge);
  const magnetized = useEdgeSnapStore((s) => s.magnetized);
  const dockedEdge = useEdgeSnapStore((s) => s.dockedEdge);
  const feedback = useEdgeSnapStore((s) => s.feedback);
  const reveal = useEdgeSnapStore((s) => s.reveal);

  // 「已吸附」反馈 1.2s 自动消失（重复停靠时 seq 变化会重置定时器）
  useEffect(() => {
    if (!feedback) return;
    const t = window.setTimeout(() => {
      useEdgeSnapStore.getState().clearFeedback();
    }, SNAP_FEEDBACK_MS);
    return () => window.clearTimeout(t);
  }, [feedback]);

  return (
    <>
      {/* 拖近边缘：主题色高亮 + 提示（纯装饰，不拦截拖拽指针）；
          magnetized = 进入磁吸区（≤28px），比 28–42 预览带更强的吸附趋势 */}
      {phase === "candidate" && candidateEdge && (
        <>
          <div className={`snap-glow snap-glow-${candidateEdge}`} aria-hidden="true" />
          <div
            className={`snap-hint snap-hint-${candidateEdge}${magnetized ? " snap-hint-magnet" : ""}`}
            aria-hidden="true"
          >
            <Magnet size={12} aria-hidden="true" />
            <span>{candidateHintText(candidateEdge)}</span>
          </div>
        </>
      )}

      {/* 停靠状态低调提示：停靠边内侧 2px 主题色细线。
          仅新停靠（docked-visible）播放一次锁边脉冲；唤出（revealed）不重复反馈 */}
      {dockedEdge && phase !== "docked-hidden" && (
        <div
          className={`snap-dock-line snap-dock-line-${dockedEdge}${
            phase === "docked-visible" ? " snap-dock-line-fresh" : ""
          }`}
          aria-hidden="true"
        />
      )}

      {/* 停靠确认反馈（仅停靠完成瞬间，1.2s） */}
      {feedback && (
        <div className={`snap-feedback snap-feedback-${feedback.edge}`} role="status">
          <Magnet size={12} aria-hidden="true" />
          <span>{dockFeedbackText(feedback.edge)}</span>
        </div>
      )}

      {/* 隐藏态状态胶囊：短胶囊替换旧的全高触发条，点击立即展开
          （悬停展开由引擎的驻留确认统一处理，避免 DOM/CSS 命中与
            物理窗口坐标不一致导致的抖动） */}
      {phase === "docked-hidden" && dockedEdge && (
        <DockCapsule edge={dockedEdge} onReveal={reveal} />
      )}
    </>
  );
}
