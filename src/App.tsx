import { useEffect } from "react";
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
import TitleBar from "./components/TitleBar";
import MinimalView from "./components/MinimalView";
import CompactView from "./components/CompactView";
import FullView from "./components/FullView";
import TaskEditor from "./components/tasks/TaskEditor";
import WorkspaceLauncher from "./components/navigation/WorkspaceLauncher";
import ClipboardDrawer from "./components/clipboard/ClipboardDrawer";
import TaskContextDrawer from "./components/context/TaskContextDrawer";
import Toast from "./components/Toast";
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
  const snapEnabled = settings?.snap_enabled ?? true;

  useEdgeSnap(snapEnabled);
  useWindowPersistence();

  useEffect(() => {
    loadSettings();
    refreshTasks();
    loadAgents();
    loadNavLinks();
    loadNavTargets();
    loadActions();
  }, [loadSettings, refreshTasks, loadAgents, loadNavLinks, loadNavTargets, loadActions]);

  useEffect(() => {
    const cleanups: (() => void)[] = [];
    onAgentChanged((payload) => {
      // 全部命中幂等去重 → UI 无变化，不刷新
      if (payload?.changed === false) return;
      const states = payload?.states ?? {};
      const critical = ["waiting", "failed", "completed", "disconnected"].some(
        (k) => (states[k] ?? 0) > 0,
      );
      // 统一调度：节流 + 单飞 + 合并，100 条事件不再触发 100 次全量快照
      scheduleAgentRefresh(critical ? "critical" : "normal");
      // 行动中心：同一批事件只触发一次去抖聚合（与 Agent 快照互不阻塞）
      scheduleActionsRefresh();
    }).then((u) => cleanups.push(u));
    onReminderFired(() => {
      refreshTasks();
      scheduleActionsRefresh();
    }).then((u) => cleanups.push(u));
    // 新通知/新事件：任务列表（含 Agent 建的任务）与全局统计都要刷新
    onNotification(() => {
      refreshTasks();
      loadNavLinks();
      scheduleActionsRefresh();
    }).then((u) => cleanups.push(u));
    onFocusQuickAdd(() => bumpQuickAdd()).then((u) => cleanups.push(u));
    onModeChanged((m) => {
      // 尺寸/持久化由后端完成；这里只同步 UI（不触发数据刷新，
      // 三视图常驻挂载，切换不丢内容状态）
      syncExternal({ mode: m });
    }).then((u) => cleanups.push(u));
    onThemeChanged((t) => {
      // 托盘路径：后端已写库，这里同步 store 并应用 DOM 主题
      syncExternal({ theme: t });
    }).then((u) => cleanups.push(u));
    onAppReady(() => {
      refreshTasks();
      loadAgents();
      loadStats();
      loadNavLinks();
    }).then((u) => cleanups.push(u));
    return () => cleanups.forEach((u) => u());
  }, [loadAgents, refreshTasks, loadStats, bumpQuickAdd, syncExternal, loadNavLinks]);

  // 卸载（或热更新）时清掉未执行的行动中心刷新调度，避免遗留定时器
  useEffect(() => () => cancelActionsRefresh(), []);

  // 应用内快捷键：Ctrl+1…5 切标签（完整模式）、Ctrl+K 快速添加、Ctrl+Shift+C 剪贴板
  useEffect(() => {
    const TABS = ["tasks", "agents", "actions", "history", "settings"] as const;
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey) return;
      const ui = useUiStore.getState();
      if (e.shiftKey && e.code === "KeyC") {
        e.preventDefault();
        if (ui.clipboardOpen) ui.closeClipboard();
        else ui.openClipboard();
        return;
      }
      if (e.shiftKey) return;
      const target = e.target as HTMLElement | null;
      const typing =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.tagName === "SELECT" ||
        Boolean(target?.isContentEditable);
      if (e.code === "KeyK") {
        // 输入框里保留原生编辑行为，避免抢按键
        if (typing) return;
        e.preventDefault();
        ui.bumpQuickAdd();
        return;
      }
      if (!typing && /^Digit[1-5]$/.test(e.code)) {
        if ((useSettingsStore.getState().settings?.mode ?? "full") !== "full") return;
        e.preventDefault();
        ui.setTab(TABS[Number(e.code.slice(5)) - 1]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className={`dock-window mode-${mode} material-${settings?.material ?? "glass"}`}>
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
    </div>
  );
}
