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
import { useUiStore } from "./store/useUiStore";
import { useNavigationStore } from "./store/useNavigationStore";
import { useEdgeSnap, useWindowPersistence } from "./hooks/useEdgeSnap";
import { useGlobalShortcuts } from "./hooks/useGlobalShortcuts";
import TitleBar from "./components/TitleBar";
import MinimalView from "./components/MinimalView";
import CompactView from "./components/CompactView";
import FullView from "./components/FullView";
import TaskEditor from "./components/tasks/TaskEditor";
import WorkspaceLauncher from "./components/navigation/WorkspaceLauncher";
import ClipboardDrawer from "./components/clipboard/ClipboardDrawer";
import TaskContextDrawer from "./components/context/TaskContextDrawer";
import Toast from "./components/Toast";
import TooltipLayer from "./components/ui/TooltipLayer";
import { createSubscriptionScope } from "./lib/subscriptions";
import { setWindowEscapeHandler } from "./lib/overlayStack";
import {
  onAgentChanged,
  onAppReady,
  onFocusQuickAdd,
  onModeChanged,
  onNotification,
  onReminderFired,
  onThemeChanged,
} from "./lib/bridge";

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
  // 用**实际生效**的材质上 class：原生 Mica/Acrylic 回退 solid 时，
  // 界面必须跟随降级，不能继续渲染半透明表面（v0.5 缺陷修复）。
  const material = materialInfo?.resolved ?? settings?.material ?? "solid";

  useEdgeSnap(snapEnabled);
  useWindowPersistence();

  useEffect(() => {
    loadSettings();
    refreshTasks();
    loadAgents();
    loadNavLinks();
    loadNavTargets();
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
    // 新通知/新事件：任务列表（含 Agent 建的任务）与全局统计都要刷新
    scope.add(onNotification(() => {
      scheduleTaskRefresh();
      if (useSettingsStore.getState().settings?.actions_enabled !== false) {
        scheduleActionsRefresh();
      }
    }));
    scope.add(onFocusQuickAdd(() => bumpQuickAdd()));
    scope.add(onModeChanged((m) => {
      // 尺寸/持久化由后端完成；这里只同步 UI（不触发数据刷新，
      // 三视图常驻挂载，切换不丢内容状态）
      syncExternal({ mode: m });
    }));
    scope.add(onThemeChanged((t) => {
      // 托盘路径：后端已写库，这里同步 store 并应用 DOM 主题
      syncExternal({ theme: t });
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

  // 应用内快捷键：Ctrl+1…6 切标签（完整模式）、Ctrl+K 快速添加、Ctrl+Shift+C 剪贴板
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
    <div className={`dock-window mode-${mode} material-${material}`}>
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
      <Toast />
      <TooltipLayer />
    </div>
  );
}
