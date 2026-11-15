//! 统一大型完整工作台外壳（U0）。
//!
//! 窗口职责（唯一大型功能宿主，label = `workspace`）：
//! - 左侧全局导航：**唯一入口注册中心** `navigationRegistry`（与主面板/胶囊同一份
//!   ID、显隐与排序），本文件不声明第二份入口数组；
//! - 顶部上下文：当前功能、当前项目/类型、开发任务、搜索/命令、Agent 工作状态；
//! - 中央内容：复用既有业务面板，不复制业务实现；每个功能独立错误边界；
//! - 可选右侧上下文：项目/开发项目/Agent 真实状态，可隐藏，宽度持久化；
//! - 无项目可用：任务、Agent、收集与暂存、剪贴板、应用、工作流、诊断、设置等
//!   通用功能不要求先创建项目。
//!
//! 跨窗口导航：Rust 入队 + 事件快路径；本窗口挂载/收到事件/重新聚焦时拉取队列，
//! 完成路由（或未保存门禁）后回执真实状态。**不把事件送达当作导航成功**。
//!
//! 状态所有权：
//! - 业务数据：既有 Rust 命令 + SQLite（本文件不持有副本）；
//! - 全局工作上下文：`workbench_current_project` / `workspace_active_project`；
//! - 窗口级 UI：本窗口的 `useUiStore`（独立 WebView，天然隔离）与本地 state；
//! - 持久化布局：`workbench_layout`（本文件经 `workbenchLayout.ts` 串行写入）。

import {
  Fragment,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import {
  GripVertical,
  Inbox,
  Layers,
  LayoutDashboard,
  ListTodo,
  MoreHorizontal,
  PanelRight,
  Plus,
  RotateCcw,
  Search,
  Settings2,
  X as CloseIcon,
} from "lucide-react";

import DeferredView from "../components/DeferredView";
import ErrorBoundary from "../components/ErrorBoundary";
import TabLeaveGuard from "../components/TabLeaveGuard";
import Toast from "../components/Toast";
import TooltipLayer from "../components/ui/TooltipLayer";
import WindowResizeGrips from "../components/WindowResizeGrips";
import { Dialog, DropdownMenu, Select } from "../components/ui";
import TasksPanel from "../components/tasks/TasksPanel";
import AgentPanel from "../components/agents/AgentPanel";
import ActionCenterPanel from "../components/actions/ActionCenterPanel";
import ClipboardPanel from "../components/clipboard/ClipboardPanel";
import ClipboardDrawer from "../components/clipboard/ClipboardDrawer";
import CollectionPanel from "../components/collection/CollectionPanel";
import { WIDGET_SOURCES } from "../components/widgets/liveSources";
import { GlobalSearchDialog } from "../components/global-search/GlobalSearchDialog";
import MobilePairingDialog from "../components/mobile/MobilePairingDialog";
import TaskContextDrawer from "../components/context/TaskContextDrawer";
import { attachDragCursorSession } from "../lib/dragCursorSession";

import WorkbenchHome from "./WorkbenchHome";
import WorkbenchContextPane from "./WorkbenchContextPane";
import WorkbenchThemeMenu from "./WorkbenchThemeMenu";
import WorkbenchPresetMenu from "./WorkbenchPresetMenu";
import WorkbenchWindowControls from "./WorkbenchWindowControls";
import { WorkbenchDetailHostProvider } from "./pageDetail";

import { useLocale } from "../hooks/useLocale";
import { useNavDragSort } from "../hooks/useNavDragSort";
import { useNavOrderDraft } from "../hooks/useNavOrderDraft";
import { useTasksStore } from "../store/useTasksStore";
import { useActionsStore, attentionCount } from "../store/useActionsStore";
import { useCaptureStore } from "../store/useCaptureStore";
import { useSettingsStore } from "../store/useSettingsStore";
import { useAgentsStore } from "../store/useAgentsStore";
import { useUiStore, type Tab, type TabSwitchResult } from "../store/useUiStore";
import { useHotkeysRuntime } from "../store/useHotkeysStore";
import { useGlobalSearchStore } from "../store/useGlobalSearchStore";
import { useCommittedNavigationLayout, setNavigationEntryVisible } from "../lib/navigationLayout";
import { safeTabForHiddenEntry } from "../lib/navVisibility";
import {
  entriesForSurface,
  isEntrySortable,
  lockedEntryIds,
  navEntry,
  navLabel,
  type NavEntry,
} from "../lib/navigationRegistry";
import {
  WORKBENCH_DETAIL_WIDTH_MAX,
  WORKBENCH_DETAIL_WIDTH_MIN,
  WORKBENCH_NAV_WIDTH_MAX,
  WORKBENCH_NAV_WIDTH_MIN,
  isWorkbenchRoute,
  normalizeProjectId,
  selectWorkbenchLayout,
  setWorkbenchDetailOpen,
  setWorkbenchDetailWidth,
  setWorkbenchNavWidth,
  setWorkbenchProject,
  setWorkbenchRoute,
  useWorkbenchLayout,
  useWorkbenchLayoutReady,
  type WorkbenchRoute,
} from "../lib/workbenchLayout";
import {
  devProjectList,
  fetchTask,
  onSettingsChanged,
  onWorkbenchNavigate,
  resourceSnapshot,
  workbenchNavAck,
  workbenchTakeNav,
  workbenchUiReady,
  workspaceProjectList,
  workspaceProjectSave,
  workspaceSetActiveProject,
  type DevProject,
  type WorkbenchNavRequest,
  type WorkbenchNavStatus,
  type WorkspaceKind,
  type WorkspaceProject,
} from "../lib/bridge";
import { formatBytes } from "../lib/clipboardUi";
import { createActiveProjectWriter, type ActiveProjectWriter } from "../workspace/activeProjectWriter";
import { resolveWorkspaceProfile, WORKSPACE_PROFILES } from "../workspace/workspaceProfiles";
import { errorMessage } from "../lib/errors";
import { logEvent } from "../lib/diagnostics";
import { WorkbenchPageActiveContext } from "../lib/windowHost";

const ProjectWorkspacePanel = lazy(() => import("./ProjectWorkspacePanel"));
const DevWorkbenchPanel = lazy(() => import("../components/workbench/DevWorkbenchPanel"));
const AppsPanel = lazy(() => import("../components/apps/AppsPanel"));
const WidgetsPanel = lazy(() => import("../components/widgets/WidgetsPanel"));
const MobileTransferPanel = lazy(() => import("../components/mobile/MobileTransferPanel"));
const WorkflowsPanel = lazy(() => import("../components/workflows/WorkflowsPanel"));
const HistoryPanel = lazy(() => import("../components/history/HistoryPanel"));
const PlanningCenterPanel = lazy(() => import("../components/roadmap/PlanningCenterPanel"));
const SettingsPanel = lazy(() => import("../components/settings/SettingsPanel"));
const HelpCenterPanel = lazy(() => import("../components/help/HelpCenterPanel"));
const DiagnosticsCenterPanel = lazy(() => import("../components/diagnostics/DiagnosticsCenterPanel"));
const ResourceManagementPanel = lazy(() => import("../components/resource/ResourceManagementPanel"));
const FilesWorkspacePanel = lazy(() => import("../components/files/FilesWorkspacePanel"));

/** 左侧入口（与主窗口共用注册中心；声明顺序无关于展示顺序）。 */
const LEFT_ENTRIES = entriesForSurface("left");

/**
 * 拖拽结束后的 click 守卫窗口（毫秒）。
 *
 * 指针拖拽松手后浏览器仍会在原元素上补一个 click；它不是「打开页面」的意图。
 * 与设置页 `NavigationVisibilitySection` 的 300ms 同量级，留一点余量覆盖
 * WebView2 在慢帧下的补发延迟。
 */
const NAV_DRAG_CLICK_GUARD_MS = 350;

const KIND_OPTIONS = (Object.values(WORKSPACE_PROFILES) as Array<{ kind: WorkspaceKind; label: string }>).map(
  (profile) => ({ value: profile.kind, label: profile.label }),
);

type ProjectModuleRequest = { token: number; module: "overview" | "items" | "links" | "settings" };

/** 单个功能的错误边界：一个页面渲染异常只影响自己的槽位。 */
function RouteBoundary({
  id,
  label,
  resetKey,
  children,
}: {
  id: string;
  label?: string;
  /** 页面重新进入时变化 → 自动清除旧错误并重试一次（不跨页面残留）。 */
  resetKey?: unknown;
  children: ReactNode;
}) {
  return (
    <ErrorBoundary scope={`工作台/${id}`} variant="compact" resetKey={resetKey ?? id} label={label}>
      {children}
    </ErrorBoundary>
  );
}

/**
 * 功能槽位：复用主面板的 `.tab-content-*` 页面骨架（页面内部滚动/贴顶筛选等
 * 依赖这些类），但去掉主窗口的 560px 阅读宽度限制（工作台是宽屏宿主）。
 * DeferredView 保证首次访问前不挂载、访问后保活（切页不丢草稿与滚动位置）。
 *
 * 错误边界必须**在槽位内部**：它一旦接替渲染，就会替换掉外层 `hidden`
 * 槽位节点；若边界放在槽位外，失败页会一直留在 `.wb-content` 里与后续
 * 页面纵向堆叠（多个页面同时「暂时无法显示」）。放在内部后，隐藏槽位
 * 仍然持有失败态，切页时随 `hidden` 一起消失；重新进入页面时
 * `resetKey` 变化会自动重试一次。
 */
function RouteSlot({
  id,
  active,
  label,
  children,
}: {
  id: string;
  active: boolean;
  label: string;
  children: ReactNode;
}) {
  return (
    <DeferredView active={active}>
      <WorkbenchPageActiveContext.Provider value={active}>
        <div className={`tab-content tab-content-${id} wb-route`} hidden={!active}>
          <RouteBoundary id={id} label={label} resetKey={active}>
            {children}
          </RouteBoundary>
        </div>
      </WorkbenchPageActiveContext.Provider>
    </DeferredView>
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export default function WorkbenchShell() {
  const { t } = useLocale();
  const settingsReady = useWorkbenchLayoutReady();
  const settingsError = useSettingsStore((s) => s.loadError);
  const loadSettings = useSettingsStore((s) => s.load);
  const storedLayout = useWorkbenchLayout();

  const tab = useUiStore((s) => s.tab);
  const setTab = useUiStore((s) => s.setTab);
  const setCollectionSub = useUiStore((s) => s.setCollectionSub);
  const bumpQuickAdd = useUiStore((s) => s.bumpQuickAdd);
  const showToast = useUiStore((s) => s.showToast);

  const stats = useTasksStore((s) => s.stats);
  const actionFeed = useActionsStore((s) => s.feed);
  const inboxCount = useCaptureStore((s) => s.inboxCount);
  const refreshInboxCount = useCaptureStore((s) => s.refreshInboxCount);
  const actionsPaused = useSettingsStore((s) => s.settings?.actions_paused === true);
  const actionsEnabled = actionFeed?.enabled !== false && !actionsPaused;

  // ── 窗口级路由状态 ───────────────────────────────────────────────────
  // `useUiStore.tab` 是功能路由的唯一事实源（窗口内独立 store）；`atHome` 只是
  // 首页开关（首页不是逻辑 Tab，不参与快捷键/注册中心 ID）。业务组件调用 setTab
  // 时由下面 effect 自动离开首页并同步外壳。
  const [atHome, setAtHome] = useState(true);
  const [routeHydrated, setRouteHydrated] = useState(false);
  const [projectHydrated, setProjectHydrated] = useState(false);
  const route: WorkbenchRoute = atHome ? "home" : isWorkbenchRoute(tab) ? tab : "tasks";

  // ── 布局（宽度/右栏/上次路由） ────────────────────────────────────────
  const [navWidth, setNavWidth] = useState(224);
  const [detailWidth, setDetailWidth] = useState(320);
  const [detailOpen, setDetailOpen] = useState(true);
  const [compact, setCompact] = useState(false);
  const navWidthRef = useRef(navWidth);
  navWidthRef.current = navWidth;
  const detailWidthRef = useRef(detailWidth);
  detailWidthRef.current = detailWidth;

  // ── 项目列表（shell 唯一持有；面板/首页只消费） ──────────────────────
  const [projects, setProjects] = useState<WorkspaceProject[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [devProjects, setDevProjects] = useState<DevProject[]>([]);
  const selectedIdRef = useRef<string | null>(selectedId);
  selectedIdRef.current = selectedId;
  const projectsRef = useRef<WorkspaceProject[]>(projects);
  projectsRef.current = projects;

  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createKind, setCreateKind] = useState<WorkspaceKind>("general");
  const [createRoot, setCreateRoot] = useState("");
  const [createNote, setCreateNote] = useState("");
  const [createBusy, setCreateBusy] = useState(false);
  const [moduleRequest, setModuleRequest] = useState<ProjectModuleRequest | null>(null);
  const moduleRequestSeq = useRef(0);

  // 导航/项目 hydration 只执行一次；跨窗口导航优先于持久化路由。
  const navAppliedRef = useRef(false);
  const navAppliedProjectRef = useRef(false);
  const routeHydratedRef = useRef(false);
  const projectHydratedRef = useRef(false);
  const handledNavRef = useRef<Set<number>>(new Set());
  /**
   * 活跃项目的「选择意图」序号：用户手动选择/导航提交都会推进。
   * 写入队列只保证最后一次**值**落库；序号用于让迟到导航提交识别自己是否已被
   * 更新的显式选择取代，避免「页面切到 A、持久化却是 B」。
   */
  const projectIntentSeq = useRef(0);

  const toastError = useCallback(
    (key: "workbench.layoutSaveFailed" | "workbench.projectRecordFailed", error: unknown) => {
      showToast(t(key, { error: errorMessage(error) }), {
        kind: "error",
        code: key,
      });
    },
    [showToast, t],
  );
  const toastErrorRef = useRef(toastError);
  toastErrorRef.current = toastError;

  /** 页面提示 → 统一 Toast（项目的 `ok` 语义映射为 success）。 */
  const showNotice = useCallback(
    (kind: "ok" | "error" | "info", text: string) => {
      showToast(text, { kind: kind === "ok" ? "success" : kind });
    },
    [showToast],
  );

  const refreshInboxSoon = useCallback(() => {
    void refreshInboxCount();
  }, [refreshInboxCount]);

  useEffect(() => {
    refreshInboxSoon();
  }, [refreshInboxSoon]);

  // ── 设置加载（主题/导航布局/动作开关都来自它） ────────────────────────
  useEffect(() => {
    void loadSettings().catch(() => {
      // 失败原因由 settingsError 在启动页如实展示，不在这里吞成成功。
    });
  }, [loadSettings]);

  // 工作台是独立 WebView，不能假定主窗口 store 已经加载过业务数据。
  // 这里只做一次权威读取（任务与统计 / Agent 快照 / 行动中心计数）；
  // 不注册提醒、Agent 或微件订阅，避免第二套后台调度。
  useEffect(() => {
    void useTasksStore.getState().refresh().catch(() => {});
    void useAgentsStore.getState().load().catch(() => {});
    void useActionsStore.getState().load().catch(() => {});
  }, []);

  // ── 布局 hydration：只在设置首次就绪时套用一次 ────────────────────────
  useEffect(() => {
    if (!settingsReady || routeHydratedRef.current) return;
    routeHydratedRef.current = true;
    setNavWidth(storedLayout.navWidth);
    setDetailWidth(storedLayout.detailWidth);
    setDetailOpen(storedLayout.detailOpen);
    if (navAppliedRef.current) {
      setRouteHydrated(true);
      return;
    }
    if (storedLayout.route === "home") {
      setAtHome(true);
    } else {
      setAtHome(false);
      // 恢复上次路由不是「用户导航」：直接落到目标页，不弹草稿确认
      // （页面在首次激活前未挂载，不存在可丢失的草稿）。
      setTab(storedLayout.route as Tab, { force: true });
    }
    setRouteHydrated(true);
  }, [settingsReady, setTab, storedLayout]);

  // 用户的页面切换（任意来源：导航、任务上下文、通知跳转）都会离开首页。
  const lastTabRef = useRef(tab);
  useEffect(() => {
    if (tab === lastTabRef.current) return;
    lastTabRef.current = tab;
    setAtHome(false);
  }, [tab]);

  // 路由持久化：设置就绪且完成 hydration 后，任何路由变化都串行落库。
  useEffect(() => {
    if (!settingsReady || !routeHydrated) return;
    void setWorkbenchRoute(route).catch((e) => toastErrorRef.current("workbench.layoutSaveFailed", e));
  }, [route, settingsReady, routeHydrated]);

  // 窄窗自动收起右栏（不改变用户偏好；宽窗恢复时按配置显示）。
  // 1180×760 默认窗口在 125% DPI 下是 944×608 CSS px：三栏在这里只剩
  // ~392px 主内容，任务页筛选行会被挤到换行/横向滚动。阈值取 1100：
  // 原生 1280×820@125%（1024 CSS）也必须收起右栏——1000 的旧阈值会让
  // 200 导航 + 320 详情 + 主内容最小宽度超出视口，右栏被裁到屏幕外
  // （2026-11-15 原生窗口验收发现）。窗口放大后自动按用户偏好恢复三栏。
  useEffect(() => {
    const measure = () => setCompact(window.innerWidth < 1100);
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  // ── 项目列表读写 ────────────────────────────────────────────────────
  const refreshProjects = useCallback(async (): Promise<WorkspaceProject[]> => {
    try {
      const response = await workspaceProjectList();
      setProjects(response.projects);
      return response.projects;
    } catch (e) {
      showToast(`读取项目列表失败：${errorMessage(e)}`, { kind: "error" });
      return [];
    } finally {
      setProjectsLoading(false);
    }
  }, [showToast]);

  const refreshDevProjects = useCallback(async () => {
    try {
      const response = await devProjectList();
      setDevProjects(response.projects);
    } catch (e) {
      // 非致命：关联下拉为空，但如实提示（不静默）。
      showToast(`读取开发项目登记失败：${errorMessage(e)}`, { kind: "warning" });
    }
  }, [showToast]);

  useEffect(() => {
    void refreshProjects();
    void refreshDevProjects();
  }, [refreshProjects, refreshDevProjects]);

  const activeWriterRef = useRef<ActiveProjectWriter | null>(null);
  if (!activeWriterRef.current) {
    activeWriterRef.current = createActiveProjectWriter(
      async (value) => {
        await workspaceSetActiveProject(value);
      },
      (error, superseded) => {
        // 用户可见错误由本文件的 submit 调用方处理；这里只留诊断，避免同一失败
        // 既弹 Toast 又由导航回执报告一次。
        if (superseded) return;
        logEvent({
          level: "WARN",
          module: "workbench",
          action: "active-project",
          event: "write-failed",
          message: errorMessage(error),
        });
      },
    );
  }

  const selectProject = useCallback(
    (id: string | null) => {
      // 显式改选项目本身就是「取消当前待决导航」：不取消的话，用户确认旧导航
      // 会在稍后覆盖这次选择，造成 UI 与持久化不一致。
      if (useUiStore.getState().pendingTab) {
        useUiStore.getState().cancelPendingTab();
      }
      projectIntentSeq.current += 1;
      const intent = projectIntentSeq.current;
      const previous = selectedIdRef.current;
      setSelectedId(id);
      // 选择即所有权：串行写入，最后一次选择最终落库（旧写入不会覆盖新选择）。
      void activeWriterRef.current?.submit(id).then((result) => {
        if (result.error) {
          // 只有本次仍是最后一次意图时才回滚 UI；已被更新选择取代时不打扰用户。
          if (projectIntentSeq.current === intent) {
            setSelectedId(previous);
            toastErrorRef.current("workbench.projectRecordFailed", result.error);
          }
          return;
        }
        if (!result.applied) return;
        void setWorkbenchProject(id).catch((e) =>
          toastErrorRef.current("workbench.projectRecordFailed", e),
        );
      });
    },
    [],
  );

  // 项目 hydration：布局记录 → 活跃项目设置 → 无项目（都无效时保持未选择）。
  useEffect(() => {
    if (!settingsReady || projectsLoading || projectHydratedRef.current) return;
    projectHydratedRef.current = true;
    setProjectHydrated(true);
    if (navAppliedProjectRef.current) return;
    const settings = useSettingsStore.getState().settings;
    const stored = selectWorkbenchLayout(settings);
    const active = settings?.workspace_active_project ?? "";
    const candidate = [stored.projectId, active].find(
      (id): id is string => Boolean(id) && projects.some((p) => p.id === id),
    );
    setSelectedId(candidate ?? null);
  }, [settingsReady, projectsLoading, projects]);

  // 列表刷新后校验当前选择：项目被其他窗口删除时降级为未选择（不显示幽灵项目）。
  useEffect(() => {
    if (projectsLoading || !selectedId) return;
    if (!projects.some((p) => p.id === selectedId)) {
      setSelectedId(null);
    }
  }, [projects, projectsLoading, selectedId]);

  const selected = useMemo(
    () => projects.find((p) => p.id === selectedId) ?? null,
    [projects, selectedId],
  );

  // ── 导航操作 ────────────────────────────────────────────────────────
  const goRoute = useCallback(
    (next: WorkbenchRoute): TabSwitchResult => {
      if (next === "home") {
        // 首页不卸载任何页面（DeferredView 保活），未保存草稿不会被丢弃。
        setAtHome(true);
        return "switched";
      }
      setAtHome(false);
      // 新导航取代仍停在 pending 的旧导航：旧事务按 cancelled 收敛，避免它的
      // 调用方（如跨窗口导航）只能等到超时。
      if (useUiStore.getState().pendingTab) {
        useUiStore.getState().cancelPendingTab();
      }
      return setTab(next as Tab);
    },
    [setTab],
  );

  const openEntry = useCallback(
    (entry: NavEntry): TabSwitchResult => {
      if (entry.tabs.length > 1) {
        const sub = useUiStore.getState().collectionSub;
        if (sub === "notes") {
          const result = goRoute(entry.tabs[0]);
          if (result === "switched") setCollectionSub("notes");
          return result;
        }
        return goRoute(sub);
      }
      const target = entry.tabs[0];
      return target ? goRoute(target) : "blocked";
    },
    [goRoute, setCollectionSub],
  );

  /**
   * 同窗口「打开开发工作台」事务：
   * - 用户取消 pending：不改 `workbench_current_project`；
   * - 确认后才提交上下文；提交失败把页面退回原路由；
   * - 没有草稿时先切页、再提交，失败回退。
   * 与跨窗口协议共用同一语义：导航成功之前不写全局上下文。
   */
  const requestDevWorkbench = useCallback(
    (devProjectId: string) => {
      const previousTab = useUiStore.getState().tab;
      const previous =
        useSettingsStore.getState().settings?.workbench_current_project ?? "";
      const commit = async () => {
        await useSettingsStore
          .getState()
          .update({ workbench_current_project: devProjectId });
      };
      const settle = async (resolution: "confirmed" | "cancelled") => {
        if (resolution === "cancelled") {
          showToast("已取消切换：开发项目上下文未改变", { kind: "info" });
          return;
        }
        try {
          await commit();
        } catch (e) {
          useUiStore.getState().setTab(previousTab, { force: true });
          showToast(`切换开发项目失败：${errorMessage(e)}`, { kind: "error" });
        }
      };
      // 新请求取代旧 pending：旧事务按 cancelled 收敛（不写上下文）。
      if (useUiStore.getState().pendingTab) {
        useUiStore.getState().cancelPendingTab();
      }
      const result = useUiStore.getState().setTab("workbench", {
        onResolve: (resolution) => {
          void settle(resolution);
        },
      });      if (result === "switched") {
        void commit().catch(async (e) => {
          useUiStore.getState().setTab(previousTab, { force: true });
          await useSettingsStore
            .getState()
            .update({ workbench_current_project: previous })
            .catch(() => {});
          showToast(`切换开发项目失败：${errorMessage(e)}`, { kind: "error" });
        });
      } else if (result === "pending") {
        showToast("有未保存内容：确认后将进入开发工作台", { kind: "info" });
      } else {
        showToast(t("workbench.navBlocked"), { kind: "warning" });
      }
    },
    [showToast, t],
  );

  const openDevWorkbenchForProject = useCallback(
    async (project: WorkspaceProject | null) => {
      if (!project) {
        showToast("请先选择工作空间项目", { kind: "warning" });
        return;
      }
      if (!project.devProjectId) {
        showToast("该项目未关联开发项目；请先在项目设置里关联", { kind: "error" });
        return;
      }
      requestDevWorkbench(project.devProjectId);
    },
    [showToast, requestDevWorkbench],
  );

  const openProjectSettings = useCallback(() => {
    moduleRequestSeq.current += 1;
    const result = goRoute("workspace");
    if (result === "switched") {
      setModuleRequest({ token: moduleRequestSeq.current, module: "settings" });
    }
  }, [goRoute]);

  const openCreateProject = useCallback(() => {
    setCreateOpen(true);
  }, []);

  const submitCreateProject = useCallback(async () => {
    const name = createName.trim();
    if (!name) {
      showToast("项目名称不能为空", { kind: "error" });
      return;
    }
    if (
      createRoot.trim() &&
      !/^[a-zA-Z]:[\\/]/.test(createRoot.trim()) &&
      !createRoot.trim().startsWith("\\\\")
    ) {
      showToast("根目录必须是绝对路径（如 D:\\\\Projects\\\\demo）", { kind: "error" });
      return;
    }
    setCreateBusy(true);
    try {
      const response = await workspaceProjectSave({
        id: null,
        name,
        kind: createKind,
        rootPath: createRoot.trim() || null,
        devProjectId: null,
        note: createNote.trim() || null,
      });
      await refreshProjects();
      selectProject(response.project.id);
      setCreateOpen(false);
      setCreateName("");
      setCreateRoot("");
      setCreateNote("");
      setCreateKind("general");
      goRoute("workspace");
      showToast(`已创建「${response.project.name}」`, { kind: "success" });
    } catch (e) {
      showToast(`创建项目失败：${errorMessage(e)}`, { kind: "error" });
    } finally {
      setCreateBusy(false);
    }
  }, [
    createName,
    createRoot,
    createKind,
    createNote,
    refreshProjects,
    selectProject,
    goRoute,
    showToast,
  ]);

  // ── 跨窗口导航：拉取 + 应用 + 回执 ───────────────────────────────────
  const ackNav = useCallback(
    (requestId: number, status: WorkbenchNavStatus, error: string | null = null) => {
      void workbenchNavAck({ requestId, status, error }).catch((e) => {
        logEvent({
          level: "WARN",
          module: "workbench-nav",
          action: "ack",
          event: "ack-failed",
          message: errorMessage(e),
        });
      });
    },
    [],
  );

  const applyNavRef = useRef<(request: WorkbenchNavRequest) => Promise<void>>(async () => {});
  applyNavRef.current = async (request: WorkbenchNavRequest) => {
    if (handledNavRef.current.has(request.requestId)) return;
    handledNavRef.current.add(request.requestId);
    if (handledNavRef.current.size > 64) handledNavRef.current.clear();

    // 新导航取代仍停在 pending 的旧事务：旧请求按 cancelled 收敛，避免它的
    // 调用方只能等到超时，也避免用户确认旧确认条时覆盖新目标。
    if (useUiStore.getState().pendingTab) {
      useUiStore.getState().cancelPendingTab();
    }

    const target = request.target;
    if (!isWorkbenchRoute(target.tab)) {
      ackNav(request.requestId, "failed", t("workbench.navUnknown", { tab: String(target.tab) }));
      return;
    }
    // 对象级定位必须真的有消费者：objectId 当前只承载三类**工作台窗口内**的
    // 一次性意图（规划功能聚焦 / 诊断操作链 / 应用页添加弹层），其余宁可明确
    // 拒绝，也不能悄悄丢掉 ID 却回执「已精确定位」。sub 只支持收集与暂存子页。
    const unsupported = target.objectId
      ? target.tab !== "roadmap" &&
        target.tab !== "diagnostics" &&
        !(target.tab === "apps" && target.objectId === "add")
        ? "工作台暂不支持对象级定位（objectId），请使用页面/项目/任务入口"
        : target.tab === "roadmap" && !target.projectId
          ? "规划功能定位需要项目上下文（projectId）"
          : null
      : target.sub && target.tab !== "inbox" && target.tab !== "shelf"
        ? "sub 仅支持收集与暂存入口"
        : target.taskId && target.tab !== "tasks" && target.tab !== "workbench"
          ? "taskId 仅支持任务页或开发工作台"
          : null;
    if (unsupported) {
      ackNav(request.requestId, "failed", unsupported);
      return;
    }
    navAppliedRef.current = true;
    routeHydratedRef.current = true;
    setRouteHydrated(true);

    const previousTab = useUiStore.getState().tab;
    const previousProjectId = selectedIdRef.current;
    const previousActive = useSettingsStore.getState().settings?.workspace_active_project ?? "";
    const targetProject = normalizeProjectId(target.projectId);

    let projectCommitted = false;
    const commitProject = async (): Promise<string | null> => {
      if (!targetProject) return null;
      // 导航提交也走唯一串行队列：不能绕过 latest-wins 直接 invoke，否则快速
      // 手动改选后，较慢的导航写入可能最后落库并覆盖新选择。
      projectIntentSeq.current += 1;
      const result = await activeWriterRef.current!.submit(targetProject);
      if (result.error) return errorMessage(result.error);
      if (!result.applied) {
        return "项目选择已被更新的选择取代，请重试";
      }
      projectCommitted = true;
      navAppliedProjectRef.current = true;
      projectHydratedRef.current = true;
      setProjectHydrated(true);
      setSelectedId(targetProject);
      void setWorkbenchProject(targetProject).catch(() => {});
      // 目标项目可能刚在其他窗口创建：刷新列表，避免头部显示「未选择项目」。
      void refreshProjects();
      return null;
    };
    const rollbackProject = async () => {
      if (!projectCommitted) return;
      projectIntentSeq.current += 1;
      const result = await activeWriterRef.current!.submit(previousActive || null);
      if (result.error) {
        logEvent({
          level: "WARN",
          module: "workbench-nav",
          action: "rollback-project",
          event: "rollback-failed",
          message: errorMessage(result.error),
        });
      }
      setSelectedId(previousProjectId);
    };
    const applySub = () => {
      if (!target.sub) return;
      const sub = target.sub;
      if (sub === "inbox" || sub === "shelf" || sub === "notes") {
        setCollectionSub(sub);
      }
    };
    /**
     * 对象级定位意图：写入**本窗口**的一次性意图 store（不是主窗的）——
     * PlanningWorkspace/DiagnosticsCenterPanel/AppsPanel 消费 token，挂载或
     * 已在页时各消费一次。放在 commitProject 之后：意图携带的 projectId 已是
     * 权威活跃项目；导航失败/取消不会走到这里，意图不残留。
     */
    const applyObjectIntent = () => {
      const objectId = target.objectId;
      if (!objectId) return;
      const ui = useUiStore.getState();
      if (target.tab === "roadmap") {
        ui.requestRoadmapFocus({ projectId: targetProject as string, featureId: objectId });
      } else if (target.tab === "diagnostics") {
        ui.requestDiagnosticsOperation(objectId);
      } else if (target.tab === "apps" && objectId === "add") {
        // 应用页添加弹层：AppsPanel 消费 token（自带脏编辑器守卫与单弹层状态）。
        ui.requestAppsAdd();
      }
    };
    /**
     * taskId 精确定位：当前列表只是缓存，可能被筛选/分页/冷启动截断。
     * 列表中没有时按 ID 读取真实任务；读取失败就明确回执失败，不能把
     * 「页面上没找到」包装成导航成功。
     */
    const focusTask = async (): Promise<string | null> => {
      const taskId = target.taskId;
      if (!taskId) return null;
      let task = useTasksStore
        .getState()
        .tasks.find((item) => String(item.id) === taskId);
      if (!task) {
        logEvent({
          level: "INFO",
          module: "workbench-nav",
          action: "focus-task",
          event: "task-not-in-list",
          message: taskId,
        });
        try {
          task = await fetchTask(taskId);
        } catch (e) {
          return `无法定位任务 ${taskId}：${errorMessage(e)}`;
        }
      }
      useUiStore.getState().openContext(task);
      return null;
    };

    if (target.tab === "home") {
      const projectError = await commitProject();
      if (projectError) {
        ackNav(request.requestId, "failed", `切换项目失败：${projectError}`);
        return;
      }
      setAtHome(true);
      ackNav(request.requestId, "succeeded");
      return;
    }

    let resolved = false;
    const finish = async (resolution: "confirmed" | "cancelled") => {
      if (resolved) return;
      resolved = true;
      if (resolution === "cancelled") {
        ackNav(request.requestId, "cancelled");
        return;
      }
      const projectError = await commitProject();
      if (projectError) {
        // 上下文没写成功：把页面退回原路由，避免「看着新页面却是旧项目」。
        useUiStore.getState().setTab(previousTab, { force: true });
        ackNav(request.requestId, "failed", `切换项目失败：${projectError}`);
        return;
      }
      setAtHome(false);
      applySub();
      const taskError = await focusTask();
      if (taskError) {
        // 页面已切换，但目标对象没有真实可见：回执失败并给出具体原因。
        ackNav(request.requestId, "failed", taskError);
        return;
      }
      applyObjectIntent();
      ackNav(request.requestId, "succeeded");
    };

    const result = setTab(target.tab as Tab, {
      onResolve: (resolution) => {
        void finish(resolution);
      },
    });
    if (result === "switched") {
      await finish("confirmed");
      return;
    }
    if (result === "pending") {
      // 不是终态：确认/取消后由 onResolve 回最终结果（用户可见确认条在工作台内）。
      ackNav(request.requestId, "pending");
      return;
    }
    // blocked：保存中，不改上下文、不切页。
    await rollbackProject();
    ackNav(request.requestId, "failed", t("workbench.navBlocked"));
  };

  useEffect(() => {
    let disposed = false;
    // 一次事件可能面对多条排队请求（页面重载/HMR 期间错过 ping，或连续快速导航）。
    // 逐条处理到空，避免队首处理完后剩余请求一直等到下一次聚焦/事件；上限与
    // Rust 侧队列容量一致，防止异常情况下无限循环。每条请求都会在 applyNav
    // 内回执并被 Rust 清出队列。
    const pull = async () => {
      for (let i = 0; i < 8; i += 1) {
        const request = await workbenchTakeNav().catch((e) => {
          logEvent({
            level: "WARN",
            module: "workbench-nav",
            action: "take-nav",
            event: "take-failed",
            message: errorMessage(e),
          });
          return null;
        });
        if (disposed || !request) return;
        await applyNavRef.current(request);
        if (disposed) return;
      }
    };
    // 先登记事件，再拉队列：两者都覆盖，且按 requestId 去重。
    let unlistenEvent: (() => void) | null = null;
    void onWorkbenchNavigate((request) => {
      void applyNavRef.current(request);
    })
      .then((unlisten) => {
        if (disposed) unlisten();
        else unlistenEvent = unlisten;
      })
      .catch(() => {});
    // Rust 在窗口已存在时会额外执行一次页面内 ping：即使 Tauri 事件因页面重载
    // 丢失，也能立刻拉取队列，而不是等下一次窗口聚焦。
    const onPing = () => pull();
    window.addEventListener("taskdock-workbench-nav-ping", onPing);
    pull();

    let unlistenFocus: (() => void) | null = null;
    try {
      const current = getCurrentWindow();
      void current
        .onFocusChanged(({ payload }) => {
          if (payload) pull();
        })
        .then((unlisten) => {
          if (disposed) unlisten();
          else unlistenFocus = unlisten;
        })
        .catch(() => {});
    } catch {
      // 非 Tauri 环境（浏览器预览/单测）：没有窗口焦点事件；队列在挂载时已拉取一次。
    }

    return () => {
      disposed = true;
      window.removeEventListener("taskdock-workbench-nav-ping", onPing);
      unlistenEvent?.();
      unlistenFocus?.();
    };
  }, []);

  // 旧 IPC `open_project_workspace_window` 已在 Rust 侧转换为同一条导航队列请求；
  // 不再监听 `project-selected`（该事件会绕过草稿门禁直接改路由/项目）。

  // 主题/预设/材质跨窗口同步 + 设置键广播（只带键名）。
  useEffect(() => {
    const unlisteners: Array<() => void> = [];
    let disposed = false;
    // 设置广播修订号：倒序/重复的旧事件不覆盖新设置。
    let lastSettingsRevision = 0;
    const track = (listener: Promise<() => void>) => {
      void listener
        .then((stop) => {
          if (disposed) stop();
          else unlisteners.push(stop);
        })
        .catch(() => {});
    };
    track(
      listen<string>("theme-changed", (event) => {
        useSettingsStore.getState().syncExternal({ theme: event.payload });
      }),
    );
    track(
      listen<string>("visual-preset-changed", (event) => {
        useSettingsStore.getState().syncExternal({ visual_preset: event.payload });
      }),
    );
    track(
      listen<string>("material-changed", () => {
        // 材质读取包含原生能力探测，统一走完整重读（不猜测 resolved 值）。
        void useSettingsStore.getState().load();
      }),
    );
    track(
      onSettingsChanged((payload) => {
        if (typeof payload.revision === "number") {
          if (payload.revision <= lastSettingsRevision) return;
          lastSettingsRevision = payload.revision;
        }
        // 本窗口自己的写入已同步到 store；只对来源为其他窗口的变更重读。
        if (payload.origin === "workspace") return;
        void useSettingsStore.getState().load();
      }),
    );
    return () => {
      disposed = true;
      unlisteners.forEach((stop) => stop());
    };
  }, []);

  // 顶栏是 `data-tauri-drag-region="deep"` 的整条拖动区：挂主窗同一套拖拽光标
  // 会话（悬停 grab、按住拖动期间 grabbing）。原生 `window-drag` 相位由 Rust
  // `drag_watch` 发到本窗口，松手即复位，不依赖用户在指针上再动一次。
  const topbarRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const node = topbarRef.current;
    if (!node) return;
    const session = attachDragCursorSession(node, { deepRegion: true });
    return () => session.dispose();
  }, []);

  // 应用内快捷键：与主窗口同一运行时，但分发到本窗口 store（Ctrl+数字/Ctrl+K）。
  useHotkeysRuntime();
  // ── 派生数据 ────────────────────────────────────────────────────────
  // 排序草稿的基准是**已提交**配置（与设置页一致）：乐观意图叠加在它上面，
  // 读事实源才能正确计算下一步与失败回滚。
  const committedLayout = useCommittedNavigationLayout();
  const lockedIds = lockedEntryIds("left");
  const currentEntry = atHome ? undefined : LEFT_ENTRIES.find((entry) => entry.tabs.includes(tab));

  // 固定入口判定与注册中心同一份元数据：锁定入口（设置）与未知 ID 不参与排序。
  const isFixedNavEntry = useCallback((id: string) => {
    const entry = navEntry(id);
    return !entry || !isEntrySortable(entry, "left");
  }, []);
  const onNavOrderError = useCallback(
    (message: string) => {
      // 草稿层已把界面回滚到已提交顺序，这里只负责把失败原因说清楚。
      showToast(t("nav.saveFailed", { error: message }), { kind: "error" });
    },
    [showToast, t],
  );
  const navDraft = useNavOrderDraft(
    "left",
    committedLayout.left,
    isFixedNavEntry,
    onNavOrderError,
    committedLayout.leftGroups,
  );
  const navOrderIds = navDraft.ids;
  const leftGroups = navDraft.leftGroups;
  const moveNavEntry = navDraft.move;
  const moveNavEntryTo = navDraft.moveTo;

  const navListRef = useRef<HTMLDivElement | null>(null);
  // 拖拽结束后浏览器补发的 click 不能变成页面跳转（与设置页同一语义）。
  const navDragEndedAtRef = useRef(0);
  // 隐藏入口：复用设置页同一条 `navigation_layout` 写入链路。一次只处理一个
  // 入口，避免快速连点时两个「读-改-写」互相覆盖；进入 pending 期间保持 busy，
  // 用户取消后才释放（取消不得写隐藏配置）。
  const [hidingId, setHidingId] = useState<string | null>(null);
  const hidingBusyRef = useRef(false);
  // 排序后的焦点恢复与位置播报都按稳定 ID 处理，不依赖索引。
  const navFocusRef = useRef<string | null>(null);
  const navPendingAnnounceRef = useRef<string | null>(null);
  const [navAnnouncement, setNavAnnouncement] = useState("");

  const navDrag = useNavDragSort({
    listRef: navListRef,
    orderIds: navOrderIds,
    isFixed: isFixedNavEntry,
    disabled: hidingId !== null,
    onDrop: (id, toIndex) => {
      navDragEndedAtRef.current = Date.now();
      if (!moveNavEntryTo(id, toIndex)) return;
      navPendingAnnounceRef.current = id;
    },
    onCancel: () => {
      navDragEndedAtRef.current = Date.now();
      setNavAnnouncement(t("nav.dragCancelled"));
    },
  });

  // 隐藏动作的提交段：先把仍由本实例拥有的排序意图 flush 到 SQLite，再复用
  // 设置页唯一的显隐写入函数。顺序意图与显隐是同一条配置，先落顺序可避免
  // 隐藏写入覆盖刚完成的拖拽结果。
  const commitHideEntry = useCallback(
    async (entry: NavEntry) => {
      setHidingId(entry.id);
      try {
        await navDraft.flush();
        await setNavigationEntryVisible("left", entry.id, false);
        showToast(t("nav.hiddenToast", { label: navLabel(entry, t) }), { kind: "info" });
      } catch (error) {
        showToast(t("nav.hideFailed", { error: errorMessage(error) }), { kind: "error" });
      } finally {
        hidingBusyRef.current = false;
        setHidingId(null);
      }
    },
    [navDraft, showToast, t],
  );

  /**
   * 点击 ×：非当前页直接隐藏；当前页先走 `setTab` 门禁离开，只有真正切换成功
   * （同步 switched 或用户 confirmed）后才写隐藏配置。`setTab` 对同步成功不回调
   * `onResolve`，因此两个分支必须分别处理且用 `settled` 防重复提交。用户取消时
   * 只释放忙碌态，不写配置、不改页面，编辑内容仍在。
   */
  const requestHideEntry = useCallback(
    (entry: NavEntry) => {
      if (hidingBusyRef.current || navDrag.draggingId) return;
      hidingBusyRef.current = true;
      setHidingId(entry.id);
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        void commitHideEntry(entry);
      };
      const abort = () => {
        if (settled) return;
        settled = true;
        hidingBusyRef.current = false;
        setHidingId(null);
      };
      const isCurrent = !atHome && entry.tabs.includes(tab);
      if (!isCurrent) {
        finish();
        return;
      }
      // 用「去掉当前入口后」的有效布局选安全页，避免 safeTab 又选回正在隐藏的
      // 页面；排序意图优先于已提交顺序，和屏幕上的实际位置保持一致。
      const effective = {
        ...committedLayout,
        left: navOrderIds.filter((id) => id !== entry.id),
      };
      const target = safeTabForHiddenEntry(effective, useUiStore.getState().collectionSub);
      const result = useUiStore.getState().setTab(target, {
        onResolve: (resolution) => {
          if (resolution === "confirmed") finish();
          else abort();
        },
      });
      if (result === "switched") {
        // 合并入口的「快速笔记」子页没有独立 Tab：切页后恢复 notes，行为与
        // FullView 隐藏当前入口时一致。
        if (
          useUiStore.getState().collectionSub === "notes" &&
          (target === "inbox" || target === "shelf")
        ) {
          setCollectionSub("notes");
        }
        finish();
      } else if (result !== "pending") {
        // blocked：store 已提示（保存中）；也必须释放忙碌态。
        abort();
      }
    },
    [
      atHome,
      commitHideEntry,
      committedLayout,
      navDrag.draggingId,
      navOrderIds,
      setCollectionSub,
      tab,
    ],
  );

  // 键盘排序（Alt+↑/↓）：React 搬动节点会让焦点落回 body，渲染后按稳定 ID 还原。
  const onNavEntryKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>, id: string) => {
      if (!event.altKey) return;
      const delta = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
      if (delta === 0) return;
      event.preventDefault();
      event.stopPropagation();
      if (!moveNavEntry(id, delta)) return;
      navFocusRef.current = id;
      navPendingAnnounceRef.current = id;
    },
    [moveNavEntry],
  );

  useLayoutEffect(() => {
    const id = navFocusRef.current;
    if (!id) return;
    navFocusRef.current = null;
    navListRef.current
      ?.querySelector<HTMLElement>(`[data-nav-entry="${id}"]`)
      ?.focus({ preventScroll: true });
  }, [navOrderIds]);

  useEffect(() => {
    const id = navPendingAnnounceRef.current;
    if (!id) return;
    navPendingAnnounceRef.current = null;
    const index = navOrderIds.indexOf(id);
    const entry = navEntry(id);
    if (index < 0 || !entry) return;
    setNavAnnouncement(
      t("nav.movedTo", {
        label: navLabel(entry, t),
        index: index + 1,
        total: navOrderIds.length,
      }),
    );
  }, [navOrderIds, t]);

  // 渲染顺序严格来自 `navigation_layout.left`（未落库意图优先）：锁定入口固定在
  // 底部区域，不进入可拖拽列表。
  const entriesToRender = navOrderIds
    .filter((id) => !lockedIds.includes(id))
    .map((id) => navEntry(id))
    .filter((entry): entry is NavEntry => entry !== undefined);
  const fixedEntries = lockedIds
    .map((id) => navEntry(id))
    .filter((entry): entry is NavEntry => entry !== undefined);
  const hiddenEntries = LEFT_ENTRIES.filter((entry) => !navOrderIds.includes(entry.id));

  // 导航分节：只把连续且同属一个分组的入口归为一段。分组归属来自
  // `navigation_layout.leftGroups`（跨组拖拽时与顺序一起落库）；缺省按注册中心
  // 分组回退。因此跨组后入口真正归入落点分组，侧栏不会反复出现同一个标题。
  const navSections = useMemo(() => {
    type NavSectionKey = "core" | "flow" | "system";
    const sectionOf = (entry: NavEntry): NavSectionKey => {
      const group = leftGroups?.[entry.id] ?? entry.group;
      if (group === "system") return "system";
      if (group === "core") return "core";
      return "flow";
    };
    const labels: Record<NavSectionKey, string> = {
      core: t("nav.group.core"),
      flow: t("nav.group.flow"),
      system: t("nav.group.system"),
    };
    const sections: Array<{
      key: string;
      section: NavSectionKey;
      label: string;
      items: NavEntry[];
    }> = [];
    for (const entry of entriesToRender) {
      const section = sectionOf(entry);
      const last = sections[sections.length - 1];
      if (!last || last.section !== section) {
        // 标题最多出现一次；段首入口 ID 仍用于稳定 key。
        sections.push({
          key: `${section}-${entry.id}`,
          section,
          label: labels[section],
          items: [],
        });
      }
      sections[sections.length - 1].items.push(entry);
    }
    return sections;
  }, [entriesToRender, leftGroups, t]);

  const counts = {
    intervention: actionsEnabled ? actionFeed?.counts.intervention ?? 0 : 0,
    attention: actionsEnabled ? attentionCount(actionFeed) : 0,
    pending: stats?.pending ?? 0,
    inbox: inboxCount,
  };

  const routeLabel = atHome
    ? t("workbench.home")
    : currentEntry
      ? navLabel(currentEntry, t)
      : t("nav.tasks");

  const projectOptions = useMemo(
    () => [
      { value: "", label: t("workbench.noProject") },
      ...projects.map((project) => ({
        value: project.id,
        label: project.name,
        hint: resolveWorkspaceProfile(project.kind).label,
      })),
    ],
    [projects, t],
  );

  const contextVisible = detailOpen && !compact;

  // 页面级详情栏宿主：右栏关闭或窄窗降级时节点卸载，ref 回调自动回到 null，
  // 页面据此不再投送详情（不需要每页各写一遍 detailOpen 判断）。用 state 而不是
  // ref 是为了让宿主变化能触发消费方重渲染 —— portal 只在有真实节点时挂载。
  const [detailHost, setDetailHost] = useState<HTMLDivElement | null>(null);

  // ── 分栏拖拽（指针）与键盘调整 ───────────────────────────────────────
  const beginResize = useCallback(
    (kind: "nav" | "detail", event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const startX = event.clientX;
      const start = kind === "nav" ? navWidthRef.current : detailWidthRef.current;
      document.body.classList.add("wb-resizing");
      const onMove = (moveEvent: PointerEvent) => {
        const delta =
          kind === "nav" ? moveEvent.clientX - startX : startX - moveEvent.clientX;
        const next =
          kind === "nav"
            ? clamp(start + delta, WORKBENCH_NAV_WIDTH_MIN, WORKBENCH_NAV_WIDTH_MAX)
            : clamp(start + delta, WORKBENCH_DETAIL_WIDTH_MIN, WORKBENCH_DETAIL_WIDTH_MAX);
        if (kind === "nav") setNavWidth(next);
        else setDetailWidth(next);
      };
      const onUp = () => {
        document.body.classList.remove("wb-resizing");
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        const value = kind === "nav" ? navWidthRef.current : detailWidthRef.current;
        const save = kind === "nav" ? setWorkbenchNavWidth(value) : setWorkbenchDetailWidth(value);
        void save.catch((e) => toastErrorRef.current("workbench.layoutSaveFailed", e));
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp, { once: true });
    },
    [],
  );

  const nudgePane = useCallback((kind: "nav" | "detail", delta: number) => {
    if (kind === "nav") {
      const next = clamp(navWidthRef.current + delta, WORKBENCH_NAV_WIDTH_MIN, WORKBENCH_NAV_WIDTH_MAX);
      setNavWidth(next);
      void setWorkbenchNavWidth(next).catch((e) =>
        toastErrorRef.current("workbench.layoutSaveFailed", e),
      );
    } else {
      const next = clamp(
        detailWidthRef.current + delta,
        WORKBENCH_DETAIL_WIDTH_MIN,
        WORKBENCH_DETAIL_WIDTH_MAX,
      );
      setDetailWidth(next);
      void setWorkbenchDetailWidth(next).catch((e) =>
        toastErrorRef.current("workbench.layoutSaveFailed", e),
      );
    }
  }, []);

  const toggleContext = useCallback(() => {
    const next = !detailOpen;
    setDetailOpen(next);
    void setWorkbenchDetailOpen(next).catch((e) =>
      toastErrorRef.current("workbench.layoutSaveFailed", e),
    );
  }, [detailOpen]);

  const searchOpen = useGlobalSearchStore((s) => s.openSearch);

  // ── 底部状态栏（一次性真实数据；失败/非 Tauri 环境只隐藏对应项，不显示假值） ──
  // sessions 字段在旧快照/部分 mock 里可能缺失：可选链降级为「不显示」。
  const agentSessionCount = useAgentsStore((s) => s.snapshot?.sessions?.length ?? null);
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [statusDisk, setStatusDisk] = useState<{ volume: string; free: string } | null>(null);
  useEffect(() => {
    let disposed = false;
    // 版本与磁盘都是可选富信息：预览/单测等非 Tauri 环境 invoke 会拒绝，
    // 这里按「取不到就不渲染」降级，属于展示层的可选数据而非业务结果。
    void getVersion()
      .then((version) => {
        if (!disposed) setAppVersion(version);
      })
      .catch(() => {});
    void resourceSnapshot()
      .then((snapshot) => {
        if (disposed) return;
        // 数据目录所在卷排首位（后端约定）；取第一个有可用空间的卷。
        const disk = snapshot.disks.find((item) => item.availableBytes !== null);
        if (disk && disk.availableBytes !== null) {
          setStatusDisk({ volume: disk.volume, free: formatBytes(disk.availableBytes) });
        }
      })
      .catch(() => {});
    return () => {
      disposed = true;
    };
  }, []);

  // ── 启动门：设置 + 路由 hydration 完成前不渲染假页面 ────────────────
  const booted = settingsReady && routeHydrated && projectHydrated;
  const readySent = useRef(false);
  useEffect(() => {
    if (!booted || readySent.current) return;
    readySent.current = true;
    // 启动路径的窗口是**隐藏创建**的（避免先看到空白窗口）：这里确认首帧可渲染
    // 后让后端显示窗口并聚焦。手动打开/已可见时后端是 no-op，可安全重复调用。
    void workbenchUiReady().catch(() => {});
  }, [booted]);
  if (!booted) {
    const failed = Boolean(settingsError);
    return (
      <div className="wb-boot" role={failed ? "alert" : "status"}>
        <div className="wb-boot-card">
          <p>
            {failed
              ? t("workbench.shellLoadFailed", { error: settingsError ?? "" })
              : t("workbench.loading")}
          </p>
          {failed && (
            <button
              type="button"
              className="btn sm"
              onClick={() => {
                void loadSettings().catch(() => {});
              }}
            >
              <RotateCcw size={12} aria-hidden="true" /> {t("common.retry")}
            </button>
          )}
        </div>
      </div>
    );
  }

  const rootStyle = {
    "--wb-nav-width": `${navWidth}px`,
    "--wb-detail-width": `${detailWidth}px`,
  } as CSSProperties;

  return (
    <div className={`wb-root${compact ? " is-compact" : ""}`} style={rootStyle}>
      <nav className="wb-nav" aria-label={t("workbench.navAria")}>
        <div className="wb-nav-items" ref={navListRef}>
          <button
            type="button"
            className={`wb-nav-item${atHome ? " active" : ""}`}
            aria-current={atHome ? "page" : undefined}
            onClick={() => goRoute("home")}
          >
            <span className="wb-nav-icon">
              <LayoutDashboard size={18} strokeWidth={1.75} aria-hidden="true" />
            </span>
            <span className="wb-nav-label">{t("workbench.home")}</span>
          </button>
          <div className="wb-nav-sep" role="presentation" />
          {navDrag.dropLineTop !== null && (
            <div
              className="wb-nav-drop-line"
              style={{ top: navDrag.dropLineTop }}
              aria-hidden="true"
            />
          )}
          {navSections.map((section) => (
            <Fragment key={section.key}>
              <div
                className={`wb-nav-group${navDrag.draggingId ? " is-dragging" : ""}`}
                role="presentation"
              >
                {section.label}
              </div>
              {section.items.map((entry) => {
                const active = !atHome && entry.tabs.includes(tab);
                const count = entry.badge ? counts[entry.badge] : 0;
                const label = navLabel(entry, t);
                const dragging = navDrag.draggingId === entry.id;
                const shift = navDrag.shifts.get(entry.id) ?? 0;
                const translate = dragging ? navDrag.offsetY : shift;
                return (
                  <div
                    key={entry.id}
                    role="button"
                    tabIndex={0}
                    className={`wb-nav-item has-grip${active ? " active" : ""}${dragging ? " is-dragging" : ""}`}
                    aria-current={active ? "page" : undefined}
                    aria-label={count > 0 ? t("nav.labelWithCount", { label, count }) : label}
                    data-nav-entry={entry.id}
                    style={translate !== 0 ? { transform: `translateY(${translate}px)` } : undefined}
                    onClick={() => {
                      // 拖拽松手后的补发 click 不是「打开页面」的意图。
                      if (Date.now() - navDragEndedAtRef.current < NAV_DRAG_CLICK_GUARD_MS) return;
                      openEntry(entry);
                    }}
                    onKeyDown={(event) => {
                      // 行内的 × 是独立控件：Enter / Space 归它，不再触发整行导航。
                      if (event.target !== event.currentTarget) return;
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        event.stopPropagation();
                        if (Date.now() - navDragEndedAtRef.current < NAV_DRAG_CLICK_GUARD_MS) return;
                        openEntry(entry);
                        return;
                      }
                      onNavEntryKeyDown(event, entry.id);
                    }}
                  >
                    <span
                      className="wb-nav-grip"
                      data-nav-grip
                      aria-hidden="true"
                      onPointerDown={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        navDrag.beginDrag(event, entry.id);
                      }}
                      onClick={(event) => {
                        event.stopPropagation();
                      }}
                    >
                      <GripVertical size={15} strokeWidth={2} />
                    </span>
                    <span className="wb-nav-icon">
                      <entry.icon size={18} strokeWidth={1.75} aria-hidden="true" />
                    </span>
                    <span className="wb-nav-label">{label}</span>
                    {count > 0 && (
                      <em className={`wb-nav-badge${entry.badge === "pending" ? " is-subtle" : ""}`}>
                        {count > 99 ? "99+" : count}
                      </em>
                    )}
                    {/* 行尾操作区固定占位：只切换透明度，悬停时行宽度不会跳变。
                        拖拽只从左侧手柄启动，× 的任何事件都不冒泡到行。 */}
                    <span
                      className="wb-nav-actions"
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => event.stopPropagation()}
                    >
                      <button
                        type="button"
                        className="wb-nav-hide"
                        data-nav-hide
                        aria-label={t("nav.hideAria", { label })}
                        disabled={hidingId !== null || navDrag.draggingId !== null}
                        onPointerDown={(event) => {
                          // 阻止任何拖拽会话（包括行内指针事件）从 × 区域启动。
                          event.stopPropagation();
                        }}
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          if (navDrag.draggingId) return;
                          requestHideEntry(entry);
                        }}
                      >
                        <CloseIcon size={15} strokeWidth={2} aria-hidden="true" />
                      </button>
                    </span>
                  </div>
                );
              })}
            </Fragment>
          ))}
        </div>

        {/* 键盘排序结果播报：只报最终位置，不在每一步都打断读屏。 */}
        <span className="sr-only" aria-live="polite" aria-atomic="true">
          {navAnnouncement}
        </span>

        <div className="wb-nav-foot">
          {hiddenEntries.length > 0 && (
            <DropdownMenu
              menuLabel={t("nav.hiddenMenu")}
              placement="right-end"
              trigger={({ ref, expanded, onClick, onKeyDown }) => (
                <button
                  ref={ref}
                  type="button"
                  className="wb-nav-item"
                  aria-haspopup="menu"
                  aria-expanded={expanded}
                  aria-label={t("workbench.moreAria")}
                  data-tip={t("workbench.more")}
                  onClick={onClick}
                  onKeyDown={onKeyDown}
                >
                  <MoreHorizontal size={18} aria-hidden="true" />
                  <span className="wb-nav-label">{t("workbench.more")}</span>
                </button>
              )}
              items={[
                ...hiddenEntries.map((entry) => ({
                  key: entry.id,
                  label: navLabel(entry, t),
                  icon: <entry.icon size={14} strokeWidth={1.6} />,
                  radio: true,
                  checked: entry.tabs.includes(tab) && !atHome,
                  onSelect: () => {
                    openEntry(entry);
                  },
                })),
                {
                  key: "__customize-navigation",
                  label: t("nav.customize"),
                  icon: <Settings2 size={14} />,
                  onSelect: () => {
                    goRoute("settings");
                  },
                },
              ]}
            />
          )}
          {fixedEntries.map((entry) => {
            const active = !atHome && entry.tabs.includes(tab);
            const label = navLabel(entry, t);
            return (
              <button
                key={entry.id}
                type="button"
                className={`wb-nav-item${active ? " active" : ""}`}
                aria-current={active ? "page" : undefined}
                aria-label={label}
                onClick={() => {
                  openEntry(entry);
                }}
              >
                <span className="wb-nav-icon">
                  <entry.icon size={18} strokeWidth={1.75} aria-hidden="true" />
                </span>
                <span className="wb-nav-label">{label}</span>
              </button>
            );
          })}
        </div>
      </nav>

      <div
        className="wb-resizer wb-resizer-nav"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整导航栏宽度"
        aria-valuemin={WORKBENCH_NAV_WIDTH_MIN}
        aria-valuemax={WORKBENCH_NAV_WIDTH_MAX}
        aria-valuenow={Math.round(navWidth)}
        tabIndex={0}
        onPointerDown={(event) => beginResize("nav", event)}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft") {
            event.preventDefault();
            nudgePane("nav", -16);
          } else if (event.key === "ArrowRight") {
            event.preventDefault();
            nudgePane("nav", 16);
          }
        }}
      />

      <div className="wb-main">
        {/* 顶栏同时是自绘标题栏：工作台窗口 decorations(false)，这里用 `deep`
            声明整条顶栏为拖动区；Tauri 的拖动脚本会跳过按钮/带 tabindex 的
            可交互元素，因此搜索、创建、项目选择与右端窗口按钮都不会丢点击。 */}
        <header
          ref={topbarRef}
          className="wb-topbar ui-drag-surface ui-drag-session"
          data-tauri-drag-region="deep"
        >
          <div className="wb-topbar-brand">
            <span className="wb-brand-mark" aria-hidden="true">
              <Layers size={13} strokeWidth={2} />
            </span>
            <span className="wb-brand-name">TaskDock</span>
          </div>
          {/* 路由标题只保留可访问名：页面自身已有 `WorkbenchPageHeader` 的大标题，
              顶栏再显示一次会形成「顶栏标题 / 页面标题 / 卡片标题」三层重复。
              视觉上顶栏只承担「品牌 + 工作空间 + 全局动作」三件事（对齐效果图）。 */}
          <h1 id="wb-page-heading" className="sr-only">
            {routeLabel}
          </h1>
          <div className="wb-topbar-context">
            <Select
              value={selectedId ?? ""}
              options={projectOptions}
              onChange={(value) => selectProject(value || null)}
              placeholder={t("workbench.noProject")}
              ariaLabel={t("workbench.projectsTitle")}
              size="sm"
              menuMinWidth={240}
            />
          </div>
          <div className="wb-topbar-actions">
            <button
              type="button"
              className="wb-search-field"
              aria-label={t("workbench.search")}
              data-tip={`${t("workbench.search")} (Ctrl+Shift+F)`}
              onClick={searchOpen}
            >
              <Search size={13} aria-hidden="true" />
              <span className="wb-search-ph">{t("workbench.searchPlaceholder")}</span>
              <kbd className="wb-search-kbd">{t("workbench.searchHint")}</kbd>
            </button>
            <DropdownMenu
              menuLabel={t("workbench.createAria")}
              placement="bottom-end"
              trigger={({ ref, expanded, onClick, onKeyDown }) => (
                <button
                  ref={ref}
                  type="button"
                  className="wb-create-btn"
                  aria-haspopup="menu"
                  aria-expanded={expanded}
                  aria-label={t("workbench.createAria")}
                  onClick={onClick}
                  onKeyDown={onKeyDown}
                >
                  <Plus size={14} aria-hidden="true" />
                  <span>{t("workbench.create")}</span>
                </button>
              )}
              items={[
                {
                  key: "new-task",
                  label: t("workbench.createTask"),
                  icon: <ListTodo size={14} />,
                  onSelect: () => {
                    goRoute("tasks");
                    bumpQuickAdd();
                  },
                },
                {
                  key: "new-project",
                  label: t("workbench.createProject"),
                  icon: <Plus size={14} />,
                  onSelect: openCreateProject,
                },
                {
                  key: "collect",
                  label: t("workbench.openCollection"),
                  icon: <Inbox size={14} />,
                  onSelect: () => {
                    setCollectionSub("inbox");
                    goRoute("inbox");
                  },
                },
              ]}
            />
            <button
              type="button"
              className={`wb-icon-btn${detailOpen ? " is-on" : ""}`}
              aria-label={t("workbench.contextToggle")}
              aria-pressed={detailOpen}
              data-tip={t("workbench.context")}
              onClick={toggleContext}
            >
              <PanelRight size={15} aria-hidden="true" />
            </button>
            {/* 明暗主题：顶栏即标题栏，切主题不该只能绕到设置页（与主窗口
                标题栏的「明暗」菜单同一语义，写库走同一设置管道）。 */}
            <WorkbenchThemeMenu />
            {/* 视觉主题（柔光玻璃 / 梦幻渐变）：与明暗正交，改的是
                `visual_preset`；工作台圆角随预设变化由 windowFrame 重算。 */}
            <WorkbenchPresetMenu />
          </div>
          <WorkbenchWindowControls />
        </header>

        <div className="wb-workarea">
          <WorkbenchDetailHostProvider host={detailHost}>
          <main className="wb-content" aria-labelledby="wb-page-heading">
            <TabLeaveGuard />
            <WorkbenchPageActiveContext.Provider value={route === "home"}>
              <div className="wb-home-slot wb-route" hidden={route !== "home"}>
                <WorkbenchHome
                  projects={projects}
                  projectsLoading={projectsLoading}
                  onNavigate={(next) => {
                    openCreateProjectIfNeeded(next);
                  }}
                  onSelectProjectAndOpen={(id) => {
                    selectProject(id);
                    goRoute("workspace");
                  }}
                  onCreateProject={openCreateProject}
                  onQuickAddTask={() => {
                    goRoute("tasks");
                    bumpQuickAdd();
                  }}
                />
              </div>
            </WorkbenchPageActiveContext.Provider>

            <Suspense
              fallback={
                <div className="panel-loading" role="status" aria-label={t("nav.loading")} />
              }
            >
              <RouteSlot label={t("nav.workspace")} id="workspace" active={route === "workspace"}>
                  <ProjectWorkspacePanel
                    project={selected}
                    devProjects={devProjects}
                    onProjectsChanged={refreshProjects}
                    onSelectProject={(id) => selectProject(id)}
                    onRefreshDevProjects={refreshDevProjects}
                    onNavigateWorkbench={() => goRoute("workbench")}
                    onOpenDevWorkbench={requestDevWorkbench}
                    onCreateProject={openCreateProject}
                    onNotice={showNotice}
                    moduleRequest={moduleRequest}
                  />
                </RouteSlot>

              <RouteSlot label={t("nav.files")} id="files" active={route === "files"}>
                  <FilesWorkspacePanel project={selected} />
                </RouteSlot>

              <RouteSlot label={t("nav.workbench")} id="workbench" active={route === "workbench"}>
                  <DevWorkbenchPanel />
                </RouteSlot>

              <RouteSlot label={t("nav.tasks")} id="tasks" active={route === "tasks"}>
                  <TasksPanel />
                </RouteSlot>

              <RouteSlot label={t("nav.agents")} id="agents" active={route === "agents"}>
                  <AgentPanel />
                </RouteSlot>

              <RouteSlot label={t("nav.actions")} id="actions" active={route === "actions"}>
                  <ActionCenterPanel />
                </RouteSlot>

              <RouteSlot label={t("nav.clipboard")} id="clipboard" active={route === "clipboard"}>
                  <ClipboardPanel />
                </RouteSlot>

              <RouteSlot label={t("nav.collection")} id={tab === "shelf" ? "shelf" : "inbox"} active={route === "inbox" || route === "shelf"}>
                  <CollectionPanel />
                </RouteSlot>

              <RouteSlot label={t("nav.apps")} id="apps" active={route === "apps"}>
                  <AppsPanel />
                </RouteSlot>

              <RouteSlot label={t("nav.widgets")} id="widgets" active={route === "widgets"}>
                  <WidgetsPanel sources={WIDGET_SOURCES} />
                </RouteSlot>

              <RouteSlot label={t("nav.mobile")} id="mobile" active={route === "mobile"}>
                  <MobileTransferPanel />
                </RouteSlot>

              <RouteSlot label={t("nav.workflows")} id="workflows" active={route === "workflows"}>
                  <WorkflowsPanel />
                </RouteSlot>

              <RouteSlot label={t("nav.history")} id="history" active={route === "history"}>
                  <HistoryPanel />
                </RouteSlot>

              <RouteSlot label={t("nav.roadmap")} id="roadmap" active={route === "roadmap"}>
                  <PlanningCenterPanel />
                </RouteSlot>

              <RouteSlot label={t("nav.help")} id="help" active={route === "help"}>
                  <HelpCenterPanel />
                </RouteSlot>

              <RouteSlot label={t("nav.diagnostics")} id="diagnostics" active={route === "diagnostics"}>
                  <DiagnosticsCenterPanel />
                </RouteSlot>

              <RouteSlot label={t("nav.resource")} id="resource" active={route === "resource"}>
                  <ResourceManagementPanel />
                </RouteSlot>

              <RouteSlot label={t("nav.settings")} id="settings" active={route === "settings"}>
                  <SettingsPanel />
                </RouteSlot>
            </Suspense>
          </main>

          {contextVisible && (
            <>
              <div
                className="wb-resizer wb-resizer-detail"
                role="separator"
                aria-orientation="vertical"
                aria-label="调整上下文栏宽度"
                aria-valuemin={WORKBENCH_DETAIL_WIDTH_MIN}
                aria-valuemax={WORKBENCH_DETAIL_WIDTH_MAX}
                aria-valuenow={Math.round(detailWidth)}
                tabIndex={0}
                onPointerDown={(event) => beginResize("detail", event)}
                onKeyDown={(event) => {
                  if (event.key === "ArrowLeft") {
                    event.preventDefault();
                    nudgePane("detail", 16);
                  } else if (event.key === "ArrowRight") {
                    event.preventDefault();
                    nudgePane("detail", -16);
                  }
                }}
              />
              <WorkbenchContextPane
                project={selected}
                onOpenProject={() => goRoute("workspace")}
                onOpenProjectSettings={openProjectSettings}
                onOpenDevWorkbench={() => void openDevWorkbenchForProject(selected)}
                onOpenTask={() => goRoute("tasks")}
                onNotice={showNotice}
                detailSlot={<div className="wb-detail-slot" ref={setDetailHost} />}
              />
            </>
          )}
          </WorkbenchDetailHostProvider>
        </div>

        <footer className="wb-statusbar" role="contentinfo">
          {agentSessionCount !== null && (
            <span className="wb-status-item">
              {t("workbench.statusAgentSessions", { count: agentSessionCount })}
            </span>
          )}
          {statusDisk && (
            <span className="wb-status-item">
              {t("workbench.statusDiskFree", { volume: statusDisk.volume, free: statusDisk.free })}
            </span>
          )}
          {appVersion && (
            <span className="wb-status-item wb-status-end">
              {t("workbench.statusVersion", { version: appVersion })}
            </span>
          )}
        </footer>
      </div>

      {/* 四角缩放命中层：workspace 窗口与主窗同样用 SetWindowRgn 裁圆角，
          原生 4×4 角热区恰好落在被裁掉的像素上，不补这层四角就无法斜向缩放。
          复用主窗口同一组件与同一 12px 热区（跨端契约见 styles-themes.css
          与 Rust `window_cursor::GRIP_CSS`），不新增第二套手势实现。 */}
      <WindowResizeGrips />

      <GlobalSearchDialog />
      <MobilePairingDialog />
      <TaskContextDrawer />
      <ClipboardDrawer />
      <Toast />
      <TooltipLayer />

      <Dialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title={t("workbench.newProject")}
        size="sm"
        ariaLabel={t("workbench.newProject")}
        footer={
          <>
            <button type="button" className="btn" onClick={() => setCreateOpen(false)}>
              {t("common.cancel")}
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={createBusy}
              onClick={() => void submitCreateProject()}
            >
              {createBusy ? t("common.loading") : t("common.confirm")}
            </button>
          </>
        }
      >
        <div className="wb-create-form">
          <label>
            <span>项目名称</span>
            <input
              className="ws-input"
              value={createName}
              autoFocus
              onChange={(event) => setCreateName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void submitCreateProject();
              }}
            />
          </label>
          <label>
            <span>项目类型</span>
            <Select
              value={createKind}
              options={KIND_OPTIONS}
              onChange={(value) => setCreateKind(value)}
              block
              ariaLabel="项目类型"
            />
          </label>
          <label>
            <span>工作目录（绝对路径，可空）</span>
            <input
              className="ws-input"
              value={createRoot}
              onChange={(event) => setCreateRoot(event.target.value)}
            />
          </label>
          <label>
            <span>备注</span>
            <textarea
              className="ws-input"
              value={createNote}
              onChange={(event) => setCreateNote(event.target.value)}
            />
          </label>
        </div>
      </Dialog>
    </div>
  );

  /** 首页快捷入口：项目页需要先有项目时不强制跳转，直接打开新建弹层。 */
  function openCreateProjectIfNeeded(next: WorkbenchRoute) {
    if (next === "workspace" && !selected && projects.length === 0) {
      setCreateOpen(true);
      return;
    }
    goRoute(next);
  }
}
