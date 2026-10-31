//! 分类胶囊外壳：轨道 + 功能面板。
//!
//! 结构（与 Win32 区域一一对应，见 `lib/capsuleLayout.ts`）：
//!   [ 轨道 56×300 ][ 间隙 8 ][ 面板 336×420 ]
//!
//! 关键约束（v0.7）：
//! - **窗口在停靠期间不移动、不缩放**，展开/收起只切 Win32 区域；
//!   因此这里不做任何定位计算，轨道与面板用固定尺寸 + flex 顺序排列即可。
//! - 轨道永远在停靠边一侧（left→左、right→右、top→上、bottom→下），
//!   面板永远朝屏幕内部展开；`cap-h` 时二者上下排列。
//! - 折叠态只挂载轨道（面板不渲染，也就没有多余的可聚焦元素）。

import { useCallback, useEffect, useState, type ComponentType } from "react";
import CapsuleRail, { CATEGORY_LABELS } from "./CapsuleRail";
import TasksLite from "./TasksLite";
import AgentsLite from "./AgentsLite";
import ClipboardLite from "./ClipboardLite";
import AppsLite from "./AppsLite";
import { railStatus, railAriaLabel } from "../../lib/capsuleModel";
import type { RailCategory } from "../../lib/capsuleModel";
import { useEdgeSnapStore } from "../../store/useEdgeSnapStore";
import { useCapsuleStore } from "../../store/useCapsuleStore";
import { useTasksStore } from "../../store/useTasksStore";
import { useAgentsStore } from "../../store/useAgentsStore";
import { registerOverlay } from "../../lib/overlayStack";
import { playAgentAlert } from "../../lib/agentAlert";

const PANELS: Record<RailCategory, ComponentType> = {
  tasks: TasksLite,
  agents: AgentsLite,
  clipboard: ClipboardLite,
  apps: AppsLite,
};

export default function CapsuleDock() {
  const phase = useEdgeSnapStore((s) => s.phase);
  const edge = useEdgeSnapStore((s) => s.dockedEdge);
  const reveal = useEdgeSnapStore((s) => s.reveal);
  const collapse = useEdgeSnapStore((s) => s.collapse);
  const feedback = useEdgeSnapStore((s) => s.feedback);
  const active = useCapsuleStore((s) => s.active);
  const setActive = useCapsuleStore((s) => s.setActive);
  const select = useCapsuleStore((s) => s.select);
  const stats = useTasksStore((s) => s.stats);
  const snapshot = useAgentsStore((s) => s.snapshot);

  const expanded = phase === "docked-revealed";
  const status = railStatus(stats, snapshot);
  const [pulse, setPulse] = useState(0);

  // 异常变响：进入 waiting/failed 时响一次（同状态 60s 冷却、设置可关）。
  // 停靠期胶囊是唯一界面，这条通道归它；未停靠时由系统 Toast 负责。
  useEffect(() => {
    if (!status.agentsLoaded) return;
    if (status.agentTone === "waiting" || status.agentTone === "failed") {
      playAgentAlert(status.agentTone);
    }
  }, [status.agentsLoaded, status.agentTone]);

  // 吸附成功反馈：短促脉冲（只动一次，不循环）
  useEffect(() => {
    if (!feedback) return;
    setPulse(feedback.seq);
    const t = window.setTimeout(() => setPulse(0), 620);
    return () => window.clearTimeout(t);
  }, [feedback]);

  const closePanel = useCallback(() => {
    setActive(null);
    collapse?.();
  }, [setActive, collapse]);

  // Escape：作为最低优先级弹层注册，一次 Esc 只收面板、不隐藏窗口
  useEffect(() => {
    if (!expanded) return;
    return registerOverlay({ kind: "drawer", onEscape: closePanel });
  }, [expanded, closePanel]);

  const onSelect = (c: RailCategory) => {
    if (expanded) {
      const next = select(c);
      if (next === null) closePanel();
      return;
    }
    setActive(c);
    reveal?.();
  };

  if (!edge) return null;
  const vertical = edge === "left" || edge === "right";
  const Panel = expanded && active ? PANELS[active] : null;

  return (
    <div
      className={[
        "capsule-dock",
        vertical ? "dock-v" : "dock-h",
        `edge-${edge}`,
        expanded ? "is-expanded" : "is-collapsed",
        pulse ? "is-snap" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-pulse={pulse || undefined}
      role="region"
      aria-label={railAriaLabel(edge, status)}
    >
      <CapsuleRail
        edge={edge}
        status={status}
        active={active}
        expanded={expanded}
        onSelect={onSelect}
        onCollapse={closePanel}
      />
      {Panel && active && (
        <section
          key={active}
          className={`capsule-panel panel-${edge}`}
          aria-label={`${CATEGORY_LABELS[active]}面板`}
        >
          <Panel />
        </section>
      )}
    </div>
  );
}
