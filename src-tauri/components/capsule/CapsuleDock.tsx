//! 分类胶囊外壳：轨道 + 功能面板。
//!
//! 结构（与 Win32 区域一一对应，见 `lib/capsuleLayout.ts`）：
//!   [ 轨道 56×446 ][ 间隙 8 ][ 面板 340×440 ]
//!
//! 关键约束（v0.7）：
//! - **窗口在停靠期间不移动、不缩放**，展开/收起只切 Win32 区域；
//!   因此这里不做任何定位计算，轨道与面板用固定尺寸 + flex 顺序排列即可。
//! - 轨道永远在停靠边一侧（left→左、right→右、top→上、bottom→下），
//!   面板永远朝屏幕内部展开；`cap-h` 时二者上下排列。
//! - 折叠态只挂载轨道（面板不渲染，也就没有多余的可聚焦元素）。
//! - 极简吸附态（`docked-tab`）只挂载 `EdgeTab`；形态过渡期间轨道与标签
//!   同时存在，由 `styles.css` 的 `.is-to-tab` / `.is-from-tab` 做交叉过渡。

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
  type RefObject,
} from "react";
import CapsuleRail, { CATEGORY_LABELS } from "./CapsuleRail";
import CapsuleLeaveGuard from "./CapsuleLeaveGuard";
import EdgeTab from "./EdgeTab";
import PanelResizeHandle from "./PanelResizeHandle";
import TasksLite from "./TasksLite";
import AgentsLite from "./AgentsLite";
import ClipboardLite from "./ClipboardLite";
import InboxLite from "./InboxLite";
import AppsLite from "./AppsLite";
import PlanningLite from "./PlanningLite";
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
import { openWorkbenchHome } from "../../lib/workbenchNav";
import { errorMessage } from "../../lib/errors";
import { logEvent } from "../../lib/diagnostics";

/**
 * 把引擎的面板宽度写到面板的 CSS 变量。
 *
 * 单独订阅 `panelWidth` 而不是让 CapsuleDock 订阅：拖拽时宽度逐帧变化，
 * 只重渲染这个返回 null 的小组件，六类面板内容（任务/剪贴板/应用…）
 * 不会跟着每帧重渲染。变量写在 DOM style 上、不受 React style prop 管控，
 * 面板因数据更新重渲染时也不会把值弹回旧宽度。
 */
function PanelWidthStyle({ panelRef }: { panelRef: RefObject<HTMLElement | null> }) {
  const width = useEdgeSnapStore((s) => s.panelWidth);
  useLayoutEffect(() => {
    panelRef.current?.style.setProperty("--cap-panel-w", `${width}px`);
  }, [panelRef, width]);
  return null;
}

/** 面板映射：轨道五类 + Agent（仅顶部状态球入口，仍打开 AgentsLite）。 */
const PANELS: Record<CapsuleCategory, ComponentType> = {
  tasks: TasksLite,
  inbox: InboxLite,
  agents: AgentsLite,
  clipboard: ClipboardLite,
  apps: AppsLite,
  roadmap: PlanningLite,
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
  // 直接入口失败反馈（P1-03）：胶囊可能处于折叠态，不能只依赖主窗口 Toast。
  // 失败写入轨道按钮自身（红色 +「!」+ 提示气泡 + aria-live），折叠态同样可见。
  const [directError, setDirectError] = useState<{ id: string; message: string } | null>(null);
  const directErrorTimer = useRef<number | null>(null);
  const mountedRef = useRef(true);
  /** 面板根节点：PanelWidthStyle 把引擎宽度写到它的 CSS 变量上。 */
  const panelRef = useRef<HTMLElement | null>(null);
  /**
   * 挂载即写入初始宽度：子组件的 layout effect 可能早于父级 host ref 的挂载
   * （挂载首帧 `panelRef.current` 仍为 null），回调 ref 负责补上这一帧，避免
   * 面板先按 CSS 默认 340 画一帧再跳到真实宽度。
   */
  const attachPanel = useCallback((node: HTMLElement | null) => {
    panelRef.current = node;
    if (node) {
      node.style.setProperty(
        "--cap-panel-w",
        `${useEdgeSnapStore.getState().panelWidth}px`,
      );
    }
  }, []);

  // 极简标签右键菜单的动作桥已上移到 `App` 常驻挂载（形态收敛后同一通道还
  // 承载托盘「打开完整工作台」动作；托盘触发时主窗可能不在胶囊形态，
  // 挂载在胶囊组件会让托盘动作失去监听者）。

  // 异常提示音（waiting/failed）已统一由 audioNotification 服务接管：它订阅后端
  // `audio-event`（真实事件 ID），负责去重、冷却、队列与 TTS，不再从胶囊状态派生第二套规则。

  // 吸附成功反馈：短促脉冲（只动一次，不循环）
  useEffect(() => {
    if (!feedback) return;
    setPulse(feedback.seq);
    const t = window.setTimeout(() => setPulse(0), 620);
    return () => window.clearTimeout(t);
  }, [feedback]);

  // 直接入口失败提示 8s 自动消退；卸载时清定时器，避免卸载后 setState
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (directErrorTimer.current !== null) window.clearTimeout(directErrorTimer.current);
    };
  }, []);

  /**
   * 直接入口（唯一大型工作台）：
   * 不再只「打开窗口」就当作成功 —— 必须等工作台回执（窗口已就绪/导航已生效）。
   * 打开失败不再 `catch(() => {})`：胶囊通常在折叠态，主窗口 Toast 看不见。
   * 失败写到按钮自身（红点 + 提示 + aria-live），并进入既有诊断通道。
   */
  const openDirectEntry = useCallback((id: string) => {
    if (directErrorTimer.current !== null) {
      window.clearTimeout(directErrorTimer.current);
      directErrorTimer.current = null;
    }
    setDirectError(null);
    const fail = (message: string) => {
      if (!mountedRef.current) return;
      setDirectError({ id, message });
      logEvent({
        level: "WARN",
        module: "workspace-window",
        action: "open-direct-entry",
        event: "direct-entry-failed",
        message,
      });
      directErrorTimer.current = window.setTimeout(() => {
        if (mountedRef.current) setDirectError(null);
      }, 8000);
    };
    void openWorkbenchHome()
      .then((outcome) => {
        // pending 表示工作台已弹出未保存确认条：不算打开失败，也不宣称已切页。
        if (outcome.status === "succeeded" || outcome.status === "pending") return;
        fail(outcome.error ?? "打开工作台失败");
      })
      .catch((e) => {
        fail(errorMessage(e));
      });
  }, []);

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
          directEntryError={directError}
          onDirectEntry={openDirectEntry}
        />
      )}
      {Panel && activeCategory && (
        <section
          key={activeCategory}
          ref={attachPanel}
          className={`capsule-panel panel-${edge}${panelExiting ? " is-closing" : ""}`}
          aria-label={`${CATEGORY_LABELS[activeCategory]}面板`}
          /* 仅供样式层做容器查询（应用网格列数按面板实际宽度收敛）：
             data 值不参与任何业务判断，不落库、不经 IPC。 */
          data-panel={activeCategory}
          /* 离场阶段只剩 160ms 的收合动画且 pointer-events:none：同步置 inert，
             键盘/读屏也不再进入一块已经不可交互、正在消失的面板。 */
          inert={panelExiting}
        >
          {/* 面板宽度 → CSS 变量（拖拽时只重渲染这个空组件，不重渲染面板内容） */}
          <PanelWidthStyle panelRef={panelRef} />
          {/* 专注状态徽标：无活动会话时返回 null，不占位、不新增轮询 */}
          <FocusCapsuleBadge className="capsule-focus-slot" />
          {/* 胶囊内的未保存草稿确认：全局确认条在 inert 的完整窗口里，面板内必须
              有一份可见入口，否则拦截后的导航看起来像没反应。 */}
          <CapsuleLeaveGuard />
          {/* 统一的右上角关闭入口：六个面板共用同一个收起动作（closePanel），
              不新增第二套关闭状态机；provider 只作用于面板子树。 */}
          <PanelCloseProvider onClose={closePanel}>
            <Panel />
          </PanelCloseProvider>
          {/* 面板宽度拖拽手柄：只在展开态、且引擎已注入 resizePanel 时渲染
              （面板收起/离场时不留下可聚焦的死控件）。 */}
          {expanded && !panelExiting && <PanelResizeHandle edge={edge} />}
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
