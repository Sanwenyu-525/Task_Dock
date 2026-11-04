import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useSettingsStore } from "./store/useSettingsStore";
import { useTasksStore } from "./store/useTasksStore";
import { useAgentsStore, scheduleAgentRefresh } from "./store/useAgentsStore";
import {
  useActionsStore,
  scheduleActionsRefresh,
  cancelActionsRefresh,
} from "./store/useActionsStore";
import { useUiStore, type Tab } from "./store/useUiStore";
import { useNavigationStore } from "./store/useNavigationStore";
import { useEdgeSnap, useWindowPersistence } from "./hooks/useEdgeSnap";
import { useGlobalShortcuts } from "./hooks/useGlobalShortcuts";
import TitleBar from "./components/TitleBar";
import MinimalView from "./components/MinimalView";
import CompactView from "./components/CompactView";
import FullView from "./components/FullView";
import TaskEditor from "./components/tasks/TaskEditor";
import WorkspaceLauncher from "./components/navigation/WorkspaceLauncher";
import { GlobalSearchDialog } from "./components/global-search/GlobalSearchDialog";
import ClipboardDrawer from "./components/clipboard/ClipboardDrawer";
import TaskContextDrawer from "./components/context/TaskContextDrawer";
import Toast from "./components/Toast";
import TooltipLayer from "./components/ui/TooltipLayer";
import SnapOverlay from "./components/SnapOverlay";
import { reportError } from "./lib/errorReport";
import CapsuleDock from "./components/capsule/CapsuleDock";
import DockFormToggle from "./components/capsule/DockFormToggle";
import WindowResizeGrips from "./components/WindowResizeGrips";
import { useEdgeSnapStore } from "./store/useEdgeSnapStore";
import { isCapsuleMode, measureTitlebarHeight } from "./lib/edgeSnap";
import { createSubscriptionScope } from "./lib/subscriptions";
import { setWindowEscapeHandler } from "./lib/overlayStack";
import {
  notifyUiReady,
  onAgentChanged,
  onAppReady,
  onFocusQuickAdd,
  onModeChanged,
  onNotification,
  onNotificationNavigate,
  onQuickCaptureCreated,
  onReminderFired,
  onReminderSnoozed,
  onSnapFormChanged,
  onThemeChanged,
  undoSnooze,
} from "./lib/bridge";
import { useCaptureStore } from "./store/useCaptureStore";

export default function App() {
  const settings = useSettingsStore((s) => s.settings);
  const materialInfo = useSettingsStore((s) => s.materialInfo);
  const loadSettings = useSettingsStore((s) => s.load);
  const syncExternal = useSettingsStore((s) => s.syncExternal);
  const refreshTasks = useTasksStore((s) => s.refresh);
  const loadStats = useTasksStore((s) => s.loadStats);
  const loadAgents = useAgentsStore((s) => s.load);
  const bumpQuickAdd = useUiStore((s) => s.bumpQuickAdd);
  const loadNavLinks = useNavigationStore((s) => s.loadTaskLinks);
  const loadNavTargets = useNavigationStore((s) => s.loadTargets);
  const loadActions = useActionsStore((s) => s.load);

  const mode = settings?.mode ?? "full";
  // 设置未加载完成前**不启用**贴边吸附：否则启动瞬间会按默认值 true 生效，
  // 可能把窗口滑出屏幕（并把该位置持久化），随后又因设置到达而停用。
  const snapEnabled = settings?.snap_enabled === true;
  // 吸附视觉层（候选提示 / 停靠细线）：引擎把 phase 写入 store。
  // 停靠期（docked-*）：窗口被 Win32 区域裁成分类胶囊（轨道 / 轨道+面板），
  // 主界面整块隐藏，只渲染 CapsuleDock —— 避免"看不见但可聚焦"的残留控件。
  const snapPhase = useEdgeSnapStore((s) => s.phase);
  const dockedEdge = useEdgeSnapStore((s) => s.dockedEdge);
  // 胶囊模式必须同时有相位与停靠边：只有相位时为 false，主界面保持可见，
  // 与 CapsuleDock 的 `edge` 判据保持同一个事实来源（不会再出现
  // 「主界面被隐藏、胶囊因缺少 edge 不渲染」的空窗口）。
  const capsuleMode = isCapsuleMode(snapPhase, dockedEdge);
  // 用**实际生效**的材质上 class：原生 Mica/Acrylic 回退 solid 时，
  // 界面必须跟随降级，不能继续渲染半透明表面（v0.5 缺陷修复）。
  const material = materialInfo?.resolved ?? settings?.material ?? "solid";

  useEdgeSnap(snapEnabled);
  useWindowPersistence();

  // 预热标题栏高度实测缓存：拖离解除的鼠标锚定需要它把光标对到标题栏中心，
  // 而停靠期主界面 display:none 量不到（回退设计常量）。主界面可见时量一次，
  // 之后无论从哪种状态解除都用上真实值。
  useEffect(() => {
    if (!capsuleMode) measureTitlebarHeight();
  }, [capsuleMode]);

  // 启动显示门：后端在「上次退出为停靠态」时先把窗口裁成 1×1 空白区域再 show，
  // 避免先露出完整主窗口再缩成胶囊。停靠恢复由 `useEdgeSnap` 在区域生效后放行；
  // 未启用吸附时这里直接放行（无恢复可等）。
  useEffect(() => {
    if (settings === null) return;
    if (snapEnabled) return;
    void notifyUiReady().catch(() => {});
  }, [settings, snapEnabled]);

  useEffect(() => {
    // 启动加载失败必须可见：设置读取失败会决定主题/导航等基础状态，给出重试入口；
    // 任务/导航读取失败由各自 store 的错误状态在对应面板展示（不在启动阶段刷 Toast）。
    void Promise.resolve(loadSettings()).catch((e) =>
      reportError(e, { operation: "读取设置", retry: () => loadSettings() }),
    );
    void refreshTasks();
    void loadAgents();
    void loadNavLinks();
    void loadNavTargets();
  }, [loadSettings, refreshTasks, loadAgents, loadNavLinks, loadNavTargets]);

  // 行动中心开关：关闭时停止定时刷新并清空聚合（Agent 事件仍照常入库）；
  // 重新开启后立即补一次聚合，无需重启应用。
  const actionsEnabled = settings?.actions_enabled ?? true;
  const settingsLoaded = settings !== null;
  useEffect(() => {
    if (!settingsLoaded) return;
    if (!actionsEnabled) {
      cancelActionsRefresh();
      useActionsStore.setState({ feed: null, error: null });
    } else {
      void loadActions();
    }
  }, [actionsEnabled, settingsLoaded, loadActions]);

  useEffect(() => {
    const scope = createSubscriptionScope();
    // 通知风暴下合并刷新：一批最多触发一次任务/导航刷新（400ms 窗口），
    // 避免每个通知批次都全量拉取任务与导航。
    let taskRefreshTimer: number | null = null;
    const scheduleTaskRefresh = () => {
      if (taskRefreshTimer !== null) return;
      taskRefreshTimer = window.setTimeout(() => {
        taskRefreshTimer = null;
        refreshTasks();
        loadNavLinks();
      }, 400);
    };
    scope.add(onAgentChanged((payload) => {
      // 全部命中幂等去重 → UI 无变化，不刷新
      if (payload?.changed === false) return;
      const states = payload?.states ?? {};
      const critical = ["waiting", "failed", "completed", "disconnected"].some(
        (k) => (states[k] ?? 0) > 0,
      );
      // 统一调度：节流 + 单飞 + 合并，100 条事件不再触发 100 次全量快照
      scheduleAgentRefresh(critical ? "critical" : "normal");
      // 行动中心：同一批事件只触发一次去抖聚合（与 Agent 快照互不阻塞）
      if (useSettingsStore.getState().settings?.actions_enabled !== false) {
        scheduleActionsRefresh();
      }
    }));
    scope.add(onReminderFired(() => {
      scheduleTaskRefresh();
      if (useSettingsStore.getState().settings?.actions_enabled !== false) {
        scheduleActionsRefresh();
      }
    }));
    // 延后成功（任务卡 / 倒计时 / 桌面通知任意入口）：统一弹带「撤销」的 Toast。
    // 撤销只作用于本次实际改动的行；行已被再次延后/编辑/触发时后端按
    // (id, snoozed_to) 条件恢复，旧撤销不会覆盖新状态（失败如实提示）。
    scope.add(onReminderSnoozed((p) => {
      scheduleTaskRefresh();
      const next = new Date(p.nextRemindAt);
      const nextLabel = Number.isNaN(next.getTime())
        ? p.nextRemindAt
        : `${next.getMonth() + 1}-${String(next.getDate()).padStart(2, "0")} ${String(next.getHours()).padStart(2, "0")}:${String(next.getMinutes()).padStart(2, "0")}`;
      useUiStore.getState().showToast(
        `已延后「${p.taskTitle}」至 ${nextLabel}`,
        {
          kind: "success",
          action: {
            label: "撤销",
            run: () => {
              undoSnooze(p.taskId, p.changed, p.insertedId)
                .then(([restored, dropped]) => {
                  if (restored === 0 && dropped === 0) {
                    useUiStore.getState().showToast(
                      "撤销已失效：提醒在延后后又被修改或触发",
                      { kind: "warning" },
                    );
                  } else {
                    useUiStore.getState().showToast("已撤销本次延后", { kind: "info" });
                  }
                  scheduleTaskRefresh();
                })
                .catch((e) =>
                  reportError(e, { operation: "撤销延后" }),
                );
            },
          },
        },
      );
    }));
    // 新通知/新事件：任务列表（含 Agent 建的任务）与全局统计都要刷新
    scope.add(onNotification(() => {
      scheduleTaskRefresh();
      if (useSettingsStore.getState().settings?.actions_enabled !== false) {
        scheduleActionsRefresh();
      }
    }));
    scope.add(onFocusQuickAdd(() => bumpQuickAdd()));
    // 快速捕获产生新条目：task / todo 会自动建任务，收集箱徽标与列表也要更新。
    // payload 以后端实现为准（仅 kind + 可选 task_id，不含正文）；这里不依赖具体字段，
    // 收到事件就按既有合并节奏刷新，避免新增第二条全量刷新路径。
    scope.add(onQuickCaptureCreated(() => {
      scheduleTaskRefresh();
      void useCaptureStore.getState().load();
    }));
    // 桌面通知「查看详情/定位本轮/通知中心」跳转：后端已激活主窗口，
    // 这里切换标签页；携带可靠 Agent ID 时把定位目标交给 AgentPanel 展开并高亮。
    // 读取 getState() 避免把 setTab 拉进依赖列表（store 引用恒定）。
    scope.add(onNotificationNavigate((p) => {
      const tab: Tab = p.tab === "history" || p.tab === "agents" || p.tab === "tasks" ? p.tab : "agents";
      const ui = useUiStore.getState();
      ui.setTab(tab);
      if (tab === "agents" && p.sourceId && p.sessionId) {
        ui.focusAgent({
          sourceId: p.sourceId,
          sessionId: p.sessionId,
          refId: p.refId ?? null,
        });
      }
    }));
    scope.add(onModeChanged((m) => {
      // 尺寸/持久化由后端完成；这里只同步 UI（不触发数据刷新，
      // 三视图常驻挂载，切换不丢内容状态）
      syncExternal({ mode: m });
    }));
    scope.add(onThemeChanged((t) => {
      // 托盘路径：后端已写库，这里同步 store 并应用 DOM 主题
      syncExternal({ theme: t });
    }));
    scope.add(onSnapFormChanged((form) => {
      // 右键菜单已持久化；这里同步偏好，吸附引擎订阅 store 后原地切换形态。
      syncExternal({ snap_display_mode: form === "full" ? "full" : "capsule" });
    }));
    scope.add(onAppReady(() => {
      refreshTasks();
      loadAgents();
      loadStats();
      loadNavLinks();
    }));
    // 卸载/热更新时释放全部监听（Promise 未兑现的会在兑现后立即反订阅）
    return () => {
      if (taskRefreshTimer !== null) window.clearTimeout(taskRefreshTimer);
      scope.dispose();
    };
  }, [loadAgents, refreshTasks, loadStats, bumpQuickAdd, syncExternal, loadNavLinks]);

  // 卸载（或热更新）时清掉未执行的行动中心刷新调度，避免遗留定时器
  useEffect(() => () => cancelActionsRefresh(), []);

  // 应用内快捷键：Ctrl+1…8 切标签（完整模式）、Ctrl+K 快速添加、Ctrl+Shift+C 剪贴板
  useGlobalShortcuts();

  // Escape 关闭优先级：弹层栈里有任何一层时由栈顶消费；
  // 只有栈空（没有任何菜单 / 抽屉 / 对话框）时，Escape 才隐藏窗口。
  useEffect(() => {
    setWindowEscapeHandler(() => {
      void getCurrentWindow().hide();
    });
    return () => setWindowEscapeHandler(null);
  }, []);

  return (
    <div
      className={`dock-window mode-${mode} material-${material}${capsuleMode ? " is-capsule" : ""}`}
    >
      {/* 主界面：停靠期整体隐藏（display:none，同时 inert），
          但保持挂载以保留三视图的内容状态与滚动位置。 */}
      <div className="dock-app" inert={capsuleMode}>
        <TitleBar />
        <div className="dock-body">
          {/* 三个模式视图常驻挂载（CSS 隐藏非当前项），切换保留内容状态与滚动位置 */}
          <div className={`view-slot ${mode === "minimal" ? "active" : ""}`}>
            <MinimalView />
          </div>
          <div className={`view-slot ${mode === "compact" ? "active" : ""}`}>
            <CompactView />
          </div>
          <div className={`view-slot ${mode === "full" ? "active" : ""}`}>
            <FullView />
          </div>
          <ClipboardDrawer />
          <TaskContextDrawer />
        </div>
        <TaskEditor />
        <WorkspaceLauncher />
        <GlobalSearchDialog />
      </div>
      {capsuleMode && <CapsuleDock />}
      {/* 完整面板停靠态：贴停靠边提供一个轻量「收缩为胶囊」入口（复用轨道按钮图标），
          不占内容布局。主界面仍然完整可见、可操作。 */}
      {snapPhase === "docked-full" && dockedEdge && <DockFormToggle edge={dockedEdge} />}
      {/* 四角缩放：圆角区域裁掉了原生角热区，由区域内热区接住（胶囊/完整面板停靠期不需要，
          停靠几何由吸附引擎维持，避免缩放把手破坏贴边齐平） */}
      {!capsuleMode && snapPhase !== "docked-full" && <WindowResizeGrips />}
      <SnapOverlay />
      <Toast />
      <TooltipLayer />
    </div>
  );
}
