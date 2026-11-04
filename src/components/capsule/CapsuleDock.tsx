//! 分类胶囊外壳：轨道 + 功能面板。
//!
//! 结构（与 Win32 区域一一对应，见 `lib/capsuleLayout.ts`）：
//!   [ 轨道 56×400 ][ 间隙 12 ][ 面板 340×440 ]
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
import InboxLite from "./InboxLite";
import AppsLite from "./AppsLite";
import FocusCapsuleBadge from "../focus/FocusCapsuleBadge";
import { railStatus, railAriaLabel } from "../../lib/capsuleModel";
import type { CapsuleCategory } from "../../lib/capsuleModel";
import { useEdgeSnapStore } from "../../store/useEdgeSnapStore";
import { useCapsuleStore } from "../../store/useCapsuleStore";
import { useTasksStore } from "../../store/useTasksStore";
import { useAgentsStore } from "../../store/useAgentsStore";
import { useCaptureStore } from "../../store/useCaptureStore";
import { registerOverlay } from "../../lib/overlayStack";
import { playAgentAlert } from "../../lib/agentAlert";

/** 面板映射：轨道四类 + Agent（仅顶部状态球入口，仍打开 AgentsLite）。 */
const PANELS: Record<CapsuleCategory, ComponentType> = {
  tasks: TasksLite,
  inbox: InboxLite,
  agents: AgentsLite,
  clipboard: ClipboardLite,
  apps: AppsLite,
};

export default function CapsuleDock() {
  const phase = useEdgeSnapStore((s) => s.phase);
  const edge = useEdgeSnapStore((s) => s.dockedEdge);
  const reveal = useEdgeSnapStore((s) => s.reveal);
  const collapse = useEdgeSnapStore((s) => s.collapse);
  const formSwitch = useEdgeSnapStore((s) => s.formSwitch);
  const feedback = useEdgeSnapStore((s) => s.feedback);
  const active = useCapsuleStore((s) => s.active);
  const setActive = useCapsuleStore((s) => s.setActive);
  const stats = useTasksStore((s) => s.stats);
  const snapshot = useAgentsStore((s) => s.snapshot);
  const inboxCount = useCaptureStore((s) => s.inboxCount);
  const inboxCountLoaded = useCaptureStore((s) => s.inboxCountLoaded);

  const expanded = phase === "docked-revealed";
  // 未加载（false）传 null：徽标显示中性，不把未知伪装成 0
  const status = railStatus(stats, snapshot, Date.now(), inboxCountLoaded ? inboxCount : null);
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

  // 收起只切相位，不改分类：`active` 恒有值，「哪个分类」与「面板是否可见」
  // 不再由同一个字段兼职，因此不会出现「相位已展开、分类已清空」的中间帧。
  const closePanel = useCallback(() => {
    collapse?.();
  }, [collapse]);

  // Escape：作为最低优先级弹层注册，一次 Esc 只收面板、不隐藏窗口。
  // blocksAutoHide=false：本层不阻止引擎的「光标离开 450ms 自动收起」——
  // 它只是 Esc 归属，不代表用户正在菜单/对话框里交互。
  useEffect(() => {
    if (!expanded) return;
    return registerOverlay({ kind: "drawer", onEscape: closePanel, blocksAutoHide: false });
  }, [expanded, closePanel]);

  const onSelect = (c: CapsuleCategory) => {
    if (expanded) {
      // 再次点击当前分类 = 收起面板；点其他分类只换内容，不重新展开
      if (active === c) closePanel();
      else setActive(c);
      return;
    }
    // 折叠态：先记住分类，由引擎在区域写入成功后推进相位
    setActive(c);
    reveal?.();
  };

  if (!edge) return null;
  const vertical = edge === "left" || edge === "right";
  // 面板可见性只看相位：分类恒有值，展开态不存在「没有面板内容」的空白态
  const activeCategory: CapsuleCategory | null = expanded ? active : null;
  const Panel = activeCategory ? PANELS[activeCategory] : null;

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
        onForm={formSwitch ? () => formSwitch("full") : undefined}
      />
      {Panel && activeCategory && (
        <section
          key={activeCategory}
          className={`capsule-panel panel-${edge}`}
          aria-label={`${CATEGORY_LABELS[activeCategory]}面板`}
        >
          {/* 专注状态徽标：无活动会话时返回 null，不占位、不新增轮询 */}
          <FocusCapsuleBadge className="capsule-focus-slot" />
          <Panel />
        </section>
      )}
    </div>
  );
}
