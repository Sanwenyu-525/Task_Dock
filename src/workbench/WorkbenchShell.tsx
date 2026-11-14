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
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import {
  LayoutDashboard,
  MoreHorizontal,
  PanelRight,
  Plus,
  RotateCcw,
  Search,
  Settings2,
} from "lucide-react";

import DeferredView from "../components/DeferredView";
import ErrorBoundary from "../components/ErrorBoundary";
import TabLeaveGuard from "../components/TabLeaveGuard";
import Toast from "../components/Toast";
import TooltipLayer from "../components/ui/TooltipLayer";
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

import WorkbenchHome from "./WorkbenchHome";
import WorkbenchContextPane from "./WorkbenchContextPane";

import { useLocale } from "../hooks/useLocale";
import { useTasksStore } from "../store/useTasksStore";
import { useActionsStore, attentionCount } from "../store/useActionsStore";
import { useCaptureStore } from "../store/useCaptureStore";
import { useSettingsStore } from "../store/useSettingsStore";
import { useAgentsStore } from "../store/useAgentsStore";
import { useUiStore, type Tab, type TabSwitchResult } from "../store/useUiStore";
import { useHotkeysRuntime } from "../store/useHotkeysStore";
import { useGlobalSearchStore } from "../store/useGlobalSearchStore";
import { useNavigationLayout } from "../lib/navigationLayout";import {
  entriesForSurface,
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
  onProjectWorkspaceProjectSelected,
  onSettingsChanged,
  onWorkbenchNavigate,
  workbenchNavAck,
  workbenchTakeNav,
  workspaceProjectList,
  workspaceProjectSave,
  workspaceSetActiveProject,
  type DevProject,
  type WorkbenchNavRequest,
  type WorkbenchNavStatus,
  type WorkspaceKind,
  type WorkspaceProject,
} from "../lib/bridge";
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

/** 左侧入口（与主窗口共用注册中心；声明顺序无关于展示顺序）。 */
const LEFT_ENTRIES = entriesForSurface("left");

const KIND_OPTIONS = (Object.values(WORKSPACE_PROFILES) as Array<{ kind: WorkspaceKind; label: string }>).map(
  (profile) => ({ value: profile.kind, label: profile.label }),
);

type ProjectModuleRequest = { token: number; module: "overview" | "items" | "links" | "settings" };

/** 单个功能的错误边界：一个页面渲染异常只影响自己的槽位。 */
function RouteBoundary({
  id,
  label,
  children,
}: {
  id: string;
  label?: string;
  children: ReactNode;
}) {
  return (
    <ErrorBoundary scope={`工作台/${id}`} variant="compact" resetKey={id} label={label}>
      {children}
    </ErrorBoundary>
  );
}

/**
 * 功能槽位：复用主面板的 `.tab-content-*` 页面骨架（页面内部滚动/贴顶筛选等
 * 依赖这些类），但去掉主窗口的 560px 阅读宽度限制（工作台是宽屏宿主）。
 * DeferredView 保证首次访问前不挂载、访问后保活（切页不丢草稿与滚动位置）。
 */
function RouteSlot({
  id,
  active,
  children,
}: {
  id: string;
  active: boolean;
  children: ReactNode;
}) {
  return (
    <DeferredView active={active}>
      <WorkbenchPageActiveContext.Provider value={active}>
        <div className={`tab-content tab-content-${id} wb-route`} hidden={!active}>
          {children}
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
  // ~392px 主内容，任务页筛选行会被挤到换行/横向滚动。阈值取 1000：
  // 默认尺寸下优先保证主内容宽度，右栏由顶栏按钮按需展开；窗口放大后
  // 自动按用户偏好恢复三栏。
  useEffect(() => {
    const measure = () => setCompact(window.innerWidth < 1000);
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
        if (!superseded) {
          toastErrorRef.current("workbench.projectRecordFailed", error);
        }
      },
    );
  }

  const selectProject = useCallback(
    (id: string | null) => {
      setSelectedId(id);
      // 选择即所有权：串行写入，最后一次选择最终落库（旧写入不会覆盖新选择）。
      activeWriterRef.current?.write(id);
      void setWorkbenchProject(id).catch((e) =>
        toastErrorRef.current("workbench.projectRecordFailed", e),
      );
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
      try {
        await workspaceSetActiveProject(targetProject);
        projectCommitted = true;
        navAppliedProjectRef.current = true;
        projectHydratedRef.current = true;
        setProjectHydrated(true);
        setSelectedId(targetProject);
        void setWorkbenchProject(targetProject).catch(() => {});
        // 目标项目可能刚在其他窗口创建：刷新列表，避免头部显示「未选择项目」。
        void refreshProjects();
        return null;
      } catch (e) {
        return errorMessage(e);
      }
    };
    const rollbackProject = async () => {
      if (!projectCommitted) return;
      try {
        await workspaceSetActiveProject(previousActive || null);
      } catch (e) {
        logEvent({
          level: "WARN",
          module: "workbench-nav",
          action: "rollback-project",
          event: "rollback-failed",
          message: errorMessage(e),
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
    const focusTask = () => {
      if (!target.taskId) return;
      const task = useTasksStore
        .getState()
        .tasks.find((item) => String(item.id) === target.taskId);
      if (task) {
        useUiStore.getState().openContext(task);
      } else {
        logEvent({
          level: "INFO",
          module: "workbench-nav",
          action: "focus-task",
          event: "task-not-in-list",
          message: target.taskId,
        });
      }
    };

    if (target.tab === "home") {
      const projectError = await commitProject();
      if (projectError) {
        ackNav(request.requestId, "failed", `切换项目失败：${projectError}`);
        return;
      }
      setAtHome(true);
      ackNav(request.requestId, "succeeded");
      focusTask();
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
      ackNav(request.requestId, "succeeded");
      focusTask();
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

  // 旧入口（open_project_workspace_window）仍会广播项目选择：兼容它并落到项目页。
  useEffect(() => {
    const un = onProjectWorkspaceProjectSelected((payload) => {
      const id = normalizeProjectId(payload.projectId);
      if (!id) return;
      setSelectedId(id);
      navAppliedProjectRef.current = true;
      projectHydratedRef.current = true;
      setProjectHydrated(true);
      void setWorkbenchProject(id).catch(() => {});
      goRoute("workspace");
    });
    return () => {
      void un.then((stop) => stop()).catch(() => {});
    };
  }, [goRoute]);

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

  // 应用内快捷键：与主窗口同一运行时，但分发到本窗口 store（Ctrl+数字/Ctrl+K）。
  useHotkeysRuntime();

  // ── 派生数据 ────────────────────────────────────────────────────────
  const layout = useNavigationLayout();
  const lockedIds = lockedEntryIds("left");
  const currentEntry = atHome ? undefined : LEFT_ENTRIES.find((entry) => entry.tabs.includes(tab));
  const entriesToRender = layout.left
    .filter((id) => !lockedIds.includes(id))
    .map((id) => navEntry(id))
    .filter((entry): entry is NavEntry => entry !== undefined);
  const fixedEntries = lockedIds
    .map((id) => navEntry(id))
    .filter((entry): entry is NavEntry => entry !== undefined);
  const hiddenEntries = LEFT_ENTRIES.filter((entry) => !layout.left.includes(entry.id));

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

  const currentTaskId = useSettingsStore((s) => s.settings?.workbench_current_task ?? "");
  const currentTask = useTasksStore((s) =>
    currentTaskId ? s.tasks.find((task) => String(task.id) === currentTaskId) : undefined,
  );
  const agentSummary = useAgentsStore((s) => s.snapshot?.live_summary ?? null);

  const contextVisible = detailOpen && !compact;

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

  // ── 启动门：设置 + 路由 hydration 完成前不渲染假页面 ────────────────
  const booted = settingsReady && routeHydrated && projectHydrated;
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
        <div className="wb-nav-head">
          <button
            type="button"
            className="wb-new-task"
            data-tip={t("nav.newTaskTip")}
            aria-label={t("workbench.newTask")}
            onClick={() => {
              goRoute("tasks");
              bumpQuickAdd();
            }}
          >
            <Plus size={14} aria-hidden="true" />
            <span>{t("workbench.newTask")}</span>
          </button>
        </div>

        <div className="wb-nav-items">
          <button
            type="button"
            className={`wb-nav-item${atHome ? " active" : ""}`}
            aria-current={atHome ? "page" : undefined}
            onClick={() => goRoute("home")}
          >
            <LayoutDashboard size={18} strokeWidth={1.75} aria-hidden="true" />
            <span>{t("workbench.home")}</span>
          </button>
          <div className="wb-nav-sep" role="presentation" />
          {entriesToRender.map((entry) => {
            const active = !atHome && entry.tabs.includes(tab);
            const count = entry.badge ? counts[entry.badge] : 0;
            const label = navLabel(entry, t);
            return (
              <button
                key={entry.id}
                type="button"
                className={`wb-nav-item${active ? " active" : ""}`}
                aria-current={active ? "page" : undefined}
                aria-label={count > 0 ? t("nav.labelWithCount", { label, count }) : label}
                data-tip={label}
                onClick={() => {
                  openEntry(entry);
                }}
              >
                <span className="wb-nav-icon">
                  <entry.icon size={18} strokeWidth={1.75} aria-hidden="true" />
                  {count > 0 && (
                    <em className={`wb-nav-badge${entry.badge === "pending" ? " is-subtle" : ""}`}>
                      {count > 99 ? "99+" : count}
                    </em>
                  )}
                </span>
                <span className="wb-nav-label">{label}</span>
              </button>
            );
          })}
        </div>

        <div className="wb-nav-foot">
          {hiddenEntries.length > 0 && (
            <DropdownMenu
              menuLabel={t("nav.hiddenMenu")}
              placement="bottom-start"
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
                data-tip={label}
                onClick={() => {
                  openEntry(entry);
                }}
              >
                <entry.icon size={18} strokeWidth={1.75} aria-hidden="true" />
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
        <header className="wb-topbar">
          <div className="wb-topbar-title">
            <h1 id="wb-page-heading">{routeLabel}</h1>
            {selected && (
              <span className="wb-topbar-kind">
                {resolveWorkspaceProfile(selected.kind).label}
              </span>
            )}
            {route === "workbench" && currentTask && (
              <span className="wb-topbar-task" title={currentTask.title}>
                当前任务：{currentTask.title}
              </span>
            )}
            {agentSummary && (
              <span className="wb-topbar-status" role="status">
                {t("workbench.statusAgents", {
                  running: agentSummary.running ?? 0,
                  waiting: agentSummary.waiting ?? 0,
                })}
              </span>
            )}
          </div>
          <div className="wb-topbar-actions">
            <Select
              value={selectedId ?? ""}
              options={projectOptions}
              onChange={(value) => selectProject(value || null)}
              placeholder={t("workbench.noProject")}
              ariaLabel={t("workbench.projectsTitle")}
              size="sm"
              menuMinWidth={240}
            />
            <button
              type="button"
              className="wb-icon-btn"
              aria-label={t("workbench.newProject")}
              data-tip={t("workbench.newProject")}
              onClick={openCreateProject}
            >
              <Plus size={15} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="wb-icon-btn"
              aria-label={t("workbench.search")}
              data-tip={`${t("workbench.search")} (Ctrl+Shift+F)`}
              onClick={searchOpen}
            >
              <Search size={15} aria-hidden="true" />
            </button>
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
          </div>
        </header>

        <div className="wb-workarea">
          <main className="wb-content" aria-labelledby="wb-page-heading">
            <TabLeaveGuard />
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
              />
            </div>

            <Suspense
              fallback={
                <div className="panel-loading" role="status" aria-label={t("nav.loading")} />
              }
            >
              <RouteBoundary id="workspace" label={t("nav.workspace")}>
                <RouteSlot id="workspace" active={route === "workspace"}>
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
              </RouteBoundary>

              <RouteBoundary id="workbench" label={t("nav.workbench")}>
                <RouteSlot id="workbench" active={route === "workbench"}>
                  <DevWorkbenchPanel />
                </RouteSlot>
              </RouteBoundary>

              <RouteBoundary id="tasks" label={t("nav.tasks")}>
                <RouteSlot id="tasks" active={route === "tasks"}>
                  <TasksPanel />
                </RouteSlot>
              </RouteBoundary>

              <RouteBoundary id="agents" label={t("nav.agents")}>
                <RouteSlot id="agents" active={route === "agents"}>
                  <AgentPanel />
                </RouteSlot>
              </RouteBoundary>

              <RouteBoundary id="actions" label={t("nav.actions")}>
                <RouteSlot id="actions" active={route === "actions"}>
                  <ActionCenterPanel />
                </RouteSlot>
              </RouteBoundary>

              <RouteBoundary id="clipboard" label={t("nav.clipboard")}>
                <RouteSlot id="clipboard" active={route === "clipboard"}>
                  <ClipboardPanel />
                </RouteSlot>
              </RouteBoundary>

              <RouteBoundary id="collection" label={t("nav.collection")}>
                <RouteSlot id={tab === "shelf" ? "shelf" : "inbox"} active={route === "inbox" || route === "shelf"}>
                  <CollectionPanel />
                </RouteSlot>
              </RouteBoundary>

              <RouteBoundary id="apps" label={t("nav.apps")}>
                <RouteSlot id="apps" active={route === "apps"}>
                  <AppsPanel />
                </RouteSlot>
              </RouteBoundary>

              <RouteBoundary id="widgets" label={t("nav.widgets")}>
                <RouteSlot id="widgets" active={route === "widgets"}>
                  <WidgetsPanel sources={WIDGET_SOURCES} />
                </RouteSlot>
              </RouteBoundary>

              <RouteBoundary id="mobile" label={t("nav.mobile")}>
                <RouteSlot id="mobile" active={route === "mobile"}>
                  <MobileTransferPanel />
                </RouteSlot>
              </RouteBoundary>

              <RouteBoundary id="workflows" label={t("nav.workflows")}>
                <RouteSlot id="workflows" active={route === "workflows"}>
                  <WorkflowsPanel />
                </RouteSlot>
              </RouteBoundary>

              <RouteBoundary id="history" label={t("nav.history")}>
                <RouteSlot id="history" active={route === "history"}>
                  <HistoryPanel />
                </RouteSlot>
              </RouteBoundary>

              <RouteBoundary id="roadmap" label={t("nav.roadmap")}>
                <RouteSlot id="roadmap" active={route === "roadmap"}>
                  <PlanningCenterPanel />
                </RouteSlot>
              </RouteBoundary>

              <RouteBoundary id="help" label={t("nav.help")}>
                <RouteSlot id="help" active={route === "help"}>
                  <HelpCenterPanel />
                </RouteSlot>
              </RouteBoundary>

              <RouteBoundary id="diagnostics" label={t("nav.diagnostics")}>
                <RouteSlot id="diagnostics" active={route === "diagnostics"}>
                  <DiagnosticsCenterPanel />
                </RouteSlot>
              </RouteBoundary>

              <RouteBoundary id="resource" label={t("nav.resource")}>
                <RouteSlot id="resource" active={route === "resource"}>
                  <ResourceManagementPanel />
                </RouteSlot>
              </RouteBoundary>

              <RouteBoundary id="settings" label={t("nav.settings")}>
                <RouteSlot id="settings" active={route === "settings"}>
                  <SettingsPanel />
                </RouteSlot>
              </RouteBoundary>
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
                onNotice={showNotice}
              />
            </>
          )}
        </div>
      </div>

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
