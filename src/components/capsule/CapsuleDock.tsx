//! 分类胶囊外壳：轨道 + 功能面板。
//!
//! 结构（与 Win32 区域一一对应，见 `lib/capsuleLayout.ts`）：
//!   [ 轨道 56×400 ][ 间隙 8 ][ 面板 340×440 ]
//!
//! 关键约束（v0.7）：
//! - **窗口在停靠期间不移动、不缩放**，展开/收起只切 Win32 区域；
//!   因此这里不做任何定位计算，轨道与面板用固定尺寸 + flex 顺序排列即可。
//! - 轨道永远在停靠边一侧（left→左、right→右、top→上、bottom→下），
//!   面板永远朝屏幕内部展开；`cap-h` 时二者上下排列。
//! - 折叠态只挂载轨道（面板不渲染，也就没有多余的可聚焦元素）。
//! - 极简吸附态（`docked-tab`）只挂载 `EdgeTab`；形态过渡期间轨道与标签
//!   同时存在，由 `styles.css` 的 `.is-to-tab` / `.is-from-tab` 做交叉过渡。

import { useCallback, useEffect, useState, type ComponentType } from "react";
import CapsuleRail, { CATEGORY_LABELS } from "./CapsuleRail";
import CapsuleLeaveGuard from "./CapsuleLeaveGuard";
import EdgeTab from "./EdgeTab";
import TasksLite from "./TasksLite";
import AgentsLite from "./AgentsLite";
import ClipboardLite from "./ClipboardLite";
import InboxLite from "./InboxLite";
import AppsLite from "./AppsLite";
import FocusCapsuleBadge from "../focus/FocusCapsuleBadge";
import { PanelCloseProvider } from "./panelClose";
import { railStatus, railAriaLabel } from "../../lib/capsuleModel";
import type { CapsuleCategory } from "../../lib/capsuleModel";
import { useEdgeSnapStore } from "../../store/useEdgeSnapStore";
import { useCapsuleStore } from "../../store/useCapsuleStore";
import { useTasksStore } from "../../store/useTasksStore";
import { useAgentsStore } from "../../store/useAgentsStore";
import { useCaptureStore } from "../../store/useCaptureStore";
import { registerOverlay } from "../../lib/overlayStack";
import { useEdgeTabMenuActions } from "../../hooks/useEdgeTabMenuActions";

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
  const collapseToTab = useEdgeSnapStore((s) => s.collapseToTab);
  const tabTransition = useEdgeSnapStore((s) => s.tabTransition);
  const panelExiting = useEdgeSnapStore((s) => s.panelExiting);
  const feedback = useEdgeSnapStore((s) => s.feedback);
  const active = useCapsuleStore((s) => s.active);
  const setActive = useCapsuleStore((s) => s.setActive);
  const stats = useTasksStore((s) => s.stats);
  const snapshot = useAgentsStore((s) => s.snapshot);
  const inboxCount = useCaptureStore((s) => s.inboxCount);
  const inboxCountLoaded = useCaptureStore((s) => s.inboxCountLoaded);

  const expanded = phase === "docked-revealed";
  // 稳定形态：docked-tab 且没有过渡 → 只画标签；过渡中同时保留轨道与标签做交叉淡入淡出。
  const stableTab = phase === "docked-tab" && tabTransition === null;
  const transitioning = tabTransition !== null;
  // 未加载（false）传 null：徽标显示中性，不把未知伪装成 0
  const status = railStatus(stats, snapshot, Date.now(), inboxCountLoaded ? inboxCount : null);
  const [pulse, setPulse] = useState(0);

  // 极简标签右键菜单的动作桥：菜单窗口只发命令，恢复/形态切换/解除仍走
  // 本组件挂载的这套吸附引擎（唯一状态机），不复制第二套窗口状态管理。
  useEdgeTabMenuActions();

  // 异常提示音（waiting/failed）已统一由 audioNotification 服务接管：它订阅后端
  // `audio-event`（真实事件 ID），负责去重、冷却、队列与 TTS，不再从胶囊状态派生第二套规则。

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
  // 面板可见性：展开态恒有内容；离场阶段（phase 已推进）仍保留挂载做收合动画，
  // 否则「展开 → 收为标签」会在动画开始前面板瞬间消失。
  const panelMounted = (expanded || panelExiting) && !transitioning;
  const activeCategory: CapsuleCategory | null = panelMounted ? active : null;
  const Panel = activeCategory ? PANELS[activeCategory] : null;

  return (
    <div
      className={[
        "capsule-dock",
        vertical ? "dock-v" : "dock-h",
        `edge-${edge}`,
        expanded ? "is-expanded" : "is-collapsed",
        stableTab ? "is-tab" : "",
        transitioning ? `is-${tabTransition}` : "",
        pulse ? "is-snap" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-pulse={pulse || undefined}
      role="region"
      aria-label={railAriaLabel(edge, status)}
    >
      {!stableTab && (
        <CapsuleRail
          edge={edge}
          status={status}
          active={active}
          expanded={expanded}
          onSelect={onSelect}
          onCollapse={closePanel}
          onForm={formSwitch ? () => formSwitch("full") : undefined}
          onTab={collapseToTab ?? undefined}
        />
      )}
      {Panel && activeCategory && (
        <section
          key={activeCategory}
          className={`capsule-panel panel-${edge}${panelExiting ? " is-closing" : ""}`}
          aria-label={`${CATEGORY_LABELS[activeCategory]}面板`}
          /* 离场阶段只剩 160ms 的收合动画且 pointer-events:none：同步置 inert，
             键盘/读屏也不再进入一块已经不可交互、正在消失的面板。 */
          inert={panelExiting}
        >
          {/* 专注状态徽标：无活动会话时返回 null，不占位、不新增轮询 */}
          <FocusCapsuleBadge className="capsule-focus-slot" />
          {/* 胶囊内的未保存草稿确认：全局确认条在 inert 的完整窗口里，面板内必须
              有一份可见入口，否则拦截后的导航看起来像没反应。 */}
          <CapsuleLeaveGuard />
          {/* 统一的右上角关闭入口：五个面板共用同一个收起动作（closePanel），
              不新增第二套关闭状态机；provider 只作用于面板子树。 */}
          <PanelCloseProvider onClose={closePanel}>
            <Panel />
          </PanelCloseProvider>
        </section>
      )}
      {(stableTab || transitioning) && (
        <EdgeTab
          edge={edge}
          tone={status.agentsLoaded ? status.agentTone : "unknown"}
          appear={
            tabTransition === "to-tab" ? "in" : tabTransition === "from-tab" ? "out" : "idle"
          }
        />
      )}
    </div>
  );
}
