import { useCallback, useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { RotateCcw } from "lucide-react";
import { useSettingsStore } from "./store/useSettingsStore";
import { useTasksStore } from "./store/useTasksStore";
import { useAgentsStore, scheduleAgentRefresh } from "./store/useAgentsStore";
import {
  useActionsStore,
  scheduleActionsRefresh,
  cancelActionsRefresh,
  shouldRefreshActions,
} from "./store/useActionsStore";
import { useUiStore, type Tab } from "./store/useUiStore";
import { useNavigationStore } from "./store/useNavigationStore";
import { useEdgeSnap, useWindowPersistence } from "./hooks/useEdgeSnap";
import { useHotkeysRuntime } from "./store/useHotkeysStore";
import TitleBar from "./components/TitleBar";
import MinimalView from "./components/MinimalView";
import CompactView from "./components/CompactView";
import FullView from "./components/FullView";
import DeferredView from "./components/DeferredView";
import WorkspaceLauncher from "./components/navigation/WorkspaceLauncher";
import { GlobalSearchDialog } from "./components/global-search/GlobalSearchDialog";
import MobilePairingDialog from "./components/mobile/MobilePairingDialog";
import OnboardingOverlay from "./components/onboarding/OnboardingOverlay";
import ClipboardDrawer from "./components/clipboard/ClipboardDrawer";
import TaskContextDrawer from "./components/context/TaskContextDrawer";
import Toast from "./components/Toast";
import TooltipLayer from "./components/ui/TooltipLayer";
import SnapOverlay from "./components/SnapOverlay";
import { reportError } from "./lib/errorReport";
import CapsuleDock from "./components/capsule/CapsuleDock";
import DockFormToggle from "./components/capsule/DockFormToggle";
import WindowResizeGrips from "./components/WindowResizeGrips";
import WidgetDesktopBridge from "./components/widgets/WidgetDesktopBridge";
import { useEdgeSnapStore } from "./store/useEdgeSnapStore";
import { isCapsuleMode, measureTitlebarHeight } from "./lib/edgeSnap";
import { resolveWindowMode } from "./lib/windowMode";
import { createSubscriptionScope } from "./lib/subscriptions";
import { setWindowEscapeHandler } from "./lib/overlayStack";
import {
  notifyUiReady,
  normalizeAgentChangedPayload,
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
import { useAudioNotifications } from "./lib/audioNotification";
import { useLocale } from "./hooks/useLocale";
import { bootReady, bootStage } from "./boot/bootProtocol";

/**
 * 启动占位（设置加载门）：设置尚未加载完成时，外壳不渲染「默认模式 + 默认导航」。
 *
 * 为什么需要：`mode` 与 `navigation_layout` 都来自设置。若在设置到达前先按默认值
 * 渲染，用户会看到完整面板与默认导航闪一下，再跳到真实模式/排序（P2 闪烁缺陷）。
 * 因此设置未就绪时只渲染中性占位，就绪后再按真实配置挂载视图。
 *
 * 边界：读取失败不能让窗口永久空白 —— `loadError` 非空时显示原因与重试入口
 * （重试走 `useSettingsStore.load`，成功后自动进入正常界面）。
 */
function ShellBootState({ error, onRetry }: { error: string | null; onRetry: () => void }) {
  const { t } = useLocale();
  return (
    <div className="shell-boot" role={error ? "alert" : "status"}>
      <div className="shell-boot-card">
        <p className="shell-boot-text">
          {error ? t("shell.bootFailed", { error }) : t("shell.booting")}
        </p>
        {error && (
          <button type="button" className="btn sm" onClick={onRetry}>
            <RotateCcw size={12} aria-hidden="true" /> {t("common.retry")}
          </button>
        )}
      </div>
    </div>
  );
}

export default function App() {
  // 统一音频通知服务：主窗口唯一调度所有者（Agent/任务/日程 → 提示音 + TTS）。
  useAudioNotifications();
  const settings = useSettingsStore((s) => s.settings);
  const settingsLoadError = useSettingsStore((s) => s.loadError);
  const materialInfo = useSettingsStore((s) => s.materialInfo);
  const loadSettings = useSettingsStore((s) => s.load);
  const syncExternal = useSettingsStore((s) => s.syncExternal);
  const refreshTasks = useTasksStore((s) => s.refresh);
  const loadAgents = useAgentsStore((s) => s.load);
  const bumpQuickAdd = useUiStore((s) => s.bumpQuickAdd);
  const loadNavLinks = useNavigationStore((s) => s.loadTaskLinks);
  const loadNavTargets = useNavigationStore((s) => s.loadTargets);
  const loadActions = useActionsStore((s) => s.load);

  // 显示模式是外壳唯一的视图判据：非法/缺失值必须在渲染前收敛，否则三个
  // `.view-slot` 可能同时不是 active（只剩标题栏与窗口背景的空白窗口）。
  const mode = resolveWindowMode(settings?.mode);
  // 设置就绪门：`mode` 与 `navigation_layout` 都来自设置。设置未到达前不挂载任何
  // 模式视图（只渲染中性占位），避免「先显示默认完整面板与默认导航、再跳到真实
  // 配置」的启动闪烁；读取失败时由占位提供原因与重试入口，不会永久空白。
  const settingsReady = settings !== null;
  // 设置未加载完成前**不启用**贴边吸附：否则启动瞬间会按默认值 true 生效，
  // 可能把窗口滑出屏幕（并把该位置持久化），随后又因设置到达而停用。
  const snapEnabled = settings?.snap_enabled === true;
  // 吸附视觉层（候选提示 / 停靠细线）：引擎把 phase 写入 store。
  // 停靠期（docked-*）：窗口被 Win32 区域裁成分类胶囊（轨道 / 轨道+面板），
  // 主界面整块隐藏，只渲染 CapsuleDock —— 避免"看不见但可聚焦"的残留控件。
  const snapPhase = useEdgeSnapStore((s) => s.phase);
  const dockedEdge = useEdgeSnapStore((s) => s.dockedEdge);
  // 胶囊模式只看停靠相位（不看 edge）：停靠期 Win32 仍可能裁成轨道，缺边时若
  // 回退显示主界面，完整工作区控件就会落进翼片区域（右侧只露一条翼片却带着
  // 开关/隐藏图标/页面文字）。缺边是瞬时不一致态，宁可不渲染任何内容。
  const capsuleMode = isCapsuleMode(snapPhase);
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

  // 启动占位的重试：与启动路径同一入口，成功后 settings 就绪、外壳自动进入正常界面。
  const retrySettings = useCallback(() => {
    void Promise.resolve(loadSettings()).catch((e) =>
      reportError(e, { operation: "读取设置", retry: () => loadSettings() }),
    );
  }, [loadSettings]);

  // 启动协议 ready 信号（tmp/acceptance/startup-experience-v1/BOOT_PROTOCOL.md §3）：
  // 设置落定即 React 接管 —— 成功 → 露出真实工作区；失败 → 露出 ShellBootState
  // 错误 + 重试 UI，两者都该移除预 React 启动占位。bootReady 幂等，重复调用无副作用；
  // watchdog API 缺失时它还有直接移除占位的双保险。
  const settingsSettled = settings !== null || settingsLoadError !== null;
  useEffect(() => {
    if (!settingsSettled) return;
    bootStage("settings"); // 阶段信号：设置读取落定（只记时间，不写诊断）
    bootReady();
  }, [settingsSettled]);

  // 行动中心开关：关闭时停止定时刷新并清空聚合（Agent 事件仍照常入库）；
  // 重新开启后立即补一次聚合，无需重启应用。启动加载与事件刷新都按消费者
  // 门控：入口隐藏、行动页未打开、主界面停靠时不为不可见的徽标付聚合查询
  // （重新出现消费者时由 FullView / ActionCenterPanel 的恢复路径补刷新）。
  const actionsEnabled = settings?.actions_enabled ?? true;
  const actionsPaused = settings?.actions_paused ?? false;
  const settingsLoaded = settings !== null;
  useEffect(() => {
    if (!settingsLoaded) return;
    if (!actionsEnabled) {
      // 长期停用：清空聚合（与既有语义一致）。
      cancelActionsRefresh();
      useActionsStore.setState({ feed: null, error: null });
    } else if (actionsPaused) {
      // 临时暂停：只取消在途的自动刷新，**保留已加载的历史/通知**。
      cancelActionsRefresh();
    } else if (shouldRefreshActions()) {
      void loadActions();
    }
  }, [actionsEnabled, actionsPaused, settingsLoaded, loadActions]);

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
    scope.add(onAgentChanged((rawPayload) => {
      // 运行时校验：非法载荷忽略，stale 旧载荷规范为全局 disconnected 刷新。
      const payload = normalizeAgentChangedPayload(rawPayload);
      if (!payload || payload.changed === false) return;
      const states = payload.states ?? {};
      const critical = ["waiting", "failed", "completed", "disconnected"].some(
        (k) => (states[k] ?? 0) > 0,
      );
      // 统一调度：节流 + 单飞 + 合并，100 条事件不再触发 100 次全量快照
      scheduleAgentRefresh(critical ? "critical" : "normal");
      // 行动中心：同一批事件只触发一次去抖聚合（与 Agent 快照互不阻塞）
      if (shouldRefreshActions()) scheduleActionsRefresh();
    }));
    scope.add(onReminderFired(() => {
      scheduleTaskRefresh();
      if (shouldRefreshActions()) scheduleActionsRefresh();
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
      if (shouldRefreshActions()) scheduleActionsRefresh();
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
      // refreshTasks 已包含 loadStats（useTasksStore.refresh），不再重复发一次统计 IPC
      refreshTasks();
      loadAgents();
      loadNavLinks();
    }));
    // 卸载/热更新时释放全部监听（Promise 未兑现的会在兑现后立即反订阅）
    return () => {
      if (taskRefreshTimer !== null) window.clearTimeout(taskRefreshTimer);
      scope.dispose();
    };
  }, [loadAgents, refreshTasks, bumpQuickAdd, syncExternal, loadNavLinks]);

  // 卸载（或热更新）时清掉未执行的行动中心刷新调度，避免遗留定时器
  useEffect(() => () => cancelActionsRefresh(), []);

  // 自定义快捷键：应用内（app_local）按键在前端按配置分发，系统级（system_global）
  // 由 Rust 侧常驻注册；录制期间不触发任何动作，旧全局监听已移除避免重复触发。
  useHotkeysRuntime();

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
          {/* CSS 隐藏非当前项；DeferredView 让非当前模式在**首次激活前**不挂载，
             首次激活后永久保留（切换保留内容状态与滚动位置，与常驻方案一致） */}
          <div className={`view-slot ${mode === "minimal" ? "active" : ""}`}>
            <DeferredView active={settingsReady && mode === "minimal"}>
              <MinimalView />
            </DeferredView>
          </div>
          <div className={`view-slot ${mode === "compact" ? "active" : ""}`}>
            <DeferredView active={settingsReady && mode === "compact"}>
              <CompactView />
            </DeferredView>
          </div>
          <div className={`view-slot ${mode === "full" ? "active" : ""}`}>
            {/* 启动占位只在设置未就绪时出现；它**不计入一次视图激活**
                （DeferredView 的 active 仍要求 settingsReady），否则用户的真实模式
                是极简/紧凑时，FullView 会在隐藏槽里白挂载一次（多付一次导航渲染
                与任务查询）。 */}
            {!settingsReady && (
              <ShellBootState error={settingsLoadError} onRetry={retrySettings} />
            )}
            <DeferredView active={settingsReady && mode === "full"}>
              <FullView />
            </DeferredView>
          </div>
          <ClipboardDrawer />
          <TaskContextDrawer />
        </div>
        <WorkspaceLauncher />
        <GlobalSearchDialog />
        {/* 手机配对：标题栏快捷入口与设置分区共用的唯一弹层实例。 */}
        <MobilePairingDialog />
        {/* 首次使用引导：页内卡片形态，仅完整模式且未完成时自我呈现（可跳过、
            可从帮助中心重新打开）；停靠/胶囊期随 dock-app inert 一并失效。 */}
        <OnboardingOverlay />
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
      {/* 桌面微件的唯一数据所有者：主窗口常驻，负责按布局创建/销毁独立窗口、
          推送带 revision 的快照并落盘几何。胶囊/停靠期（dock-app inert）仍需运行。 */}
      <WidgetDesktopBridge />
    </div>
  );
}
