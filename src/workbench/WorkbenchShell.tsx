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
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ComponentType,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { createAppExitHandler } from "./workbenchExitGuard";
import {
  installWorkbenchCloseGuard,
  WorkbenchCloseTimeoutError,
  type WorkbenchCloseGuardHandle,
  type WorkbenchCloseState,
  type WorkbenchCloseWindow,
} from "./workbenchCloseGuard";
import { traceWorkbenchClose } from "../lib/closeTrace";
import {
  FolderOpen,
  GripVertical,
  Inbox,
  LayoutDashboard,
  ListTodo,
  MoreHorizontal,
  PanelRight,
  Plus,
  RotateCcw,
  RefreshCw,
  Search,
  Settings2,
  X as CloseIcon,
} from "lucide-react";

// TaskDock 应用图标：与 `src-tauri/icons` 同一套 01-flat-2d 资源。
// 顶栏品牌位直接展示产品图标，不再用通用线性图标冒充品牌标识。
import appMark from "../../assets/branding/icons/01-flat-2d/128x128.png";
import ErrorBoundary from "../components/ErrorBoundary";
import TabLeaveGuard from "../components/TabLeaveGuard";
import Toast from "../components/Toast";
import TooltipLayer from "../components/ui/TooltipLayer";
import WindowResizeGrips from "../components/WindowResizeGrips";
import { ConfirmDialog, Dialog, DropdownMenu, Select } from "../components/ui";
import ClipboardDrawer from "../components/clipboard/ClipboardDrawer";
import { WIDGET_SOURCES } from "../components/widgets/liveSources";
import { GlobalSearchDialog } from "../components/global-search/GlobalSearchDialog";
import MobilePairingDialog from "../components/mobile/MobilePairingDialog";
import TaskContextDrawer from "../components/context/TaskContextDrawer";
import { attachDragCursorSession } from "../lib/dragCursorSession";

import WorkbenchHome from "./WorkbenchHome";
import WorkbenchContextPane from "./WorkbenchContextPane";
import WorkbenchThemeMenu from "./WorkbenchThemeMenu";
import WorkbenchPresetMenu from "./WorkbenchPresetMenu";
import WorkbenchPinButton from "./WorkbenchPinButton";
import WorkbenchToolbarMore from "./WorkbenchToolbarMore";
import WorkbenchWindowControls from "./WorkbenchWindowControls";
import { WorkbenchDetailHostProvider } from "./pageDetail";
import "./createProjectDialog.css";

import { useLocale } from "../hooks/useLocale";
import { useNavDragSort } from "../hooks/useNavDragSort";
import { useNavOrderDraft } from "../hooks/useNavOrderDraft";
import { useTasksStore } from "../store/useTasksStore";
import { useActionsStore, attentionCount } from "../store/useActionsStore";
import { useCaptureStore } from "../store/useCaptureStore";
import { useSettingsStore } from "../store/useSettingsStore";
import { useAgentsStore } from "../store/useAgentsStore";
import { useUiStore, type Tab, type TabSwitchResult } from "../store/useUiStore";
import { useTransferStore } from "../store/useTransferStore";
import TransferPanel from "../components/transfer/TransferPanel";
import TransferDrawer from "../components/transfer/TransferDrawer";
import { updateContext } from "../lib/crossTab/transferClient";
import { resolvePanelMode } from "../lib/crossTab/panelState";
import { initializeCrossTabModules, disposeCrossTabModules } from "../lib/crossTab/initialize";
import { useFilesWorkspaceStore } from "../store/useFilesWorkspaceStore";
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
  WORKBENCH_NAV_LABEL_TRAILING_GAP,
  WORKBENCH_NAV_LABELS_COMPACT_BELOW_WIDTH,
  WORKBENCH_NAV_WIDTH_MAX,
  WORKBENCH_NAV_WIDTH_MIN,
  WORKBENCH_NAV_WIDTH_RAIL,
  isWorkbenchRoute,
  normalizeProjectId,
  resolveWorkbenchNavPresentation,
  resolveWorkbenchNavWidth,
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
// 窗口档位唯一事实源：外壳只按窗口宽度决定「顶栏工具收纳 / 右栏显隐」，
// 页面内部按内容容器宽度响应（见 docs/ui-responsive-layout.md）。
import { shouldCollapseWorkbenchDetail } from "../lib/layoutMetrics";
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
  appExitAck,
  onAppBeforeExit,
  onAppExitBlocked,
  type DevProject,
  type ResourceSnapshot,
  type WorkbenchNavRequest,
  type WorkbenchNavStatus,
  type WorkspaceKind,
  type WorkspaceProject,
} from "../lib/bridge";
import { formatBytes } from "../lib/clipboardUi";
// 底部状态栏「包信息」：构建溯源与包标识独立成组件，外壳只负责摆放。
import WorkbenchBuildStatus from "./WorkbenchBuildStatus";
import { createActiveProjectWriter, type ActiveProjectWriter } from "../workspace/activeProjectWriter";
import { resolveWorkspaceProfile, WORKSPACE_PROFILES } from "../workspace/workspaceProfiles";
import { pickFolder } from "../lib/filesWorkspace/folderPicker";
import { checkWorkspacePath } from "../lib/workspacePath";
import { errorMessage } from "../lib/errors";
import { logEvent } from "../lib/diagnostics";
import { withTimeout } from "../lib/timeout";
import { WorkbenchPageActiveContext } from "../lib/windowHost";
// 页面级按需加载：代码入口集中在 `lib/featureRegistry.ts`，本文件不再静态 import
// 任何路由面板（否则整个工作台的功能会在窗口创建时一次性下载/解析）。
import FeatureView from "../components/feature/FeatureView";
import { preloadFeature } from "../lib/featureRuntime";
import { featureIdForWorkbenchRoute, type PageFeatureId } from "../lib/featureRegistry";

/** 各页面的 props 类型（`typeof import` 是纯类型查询，不会产生运行时导入）。 */
type WorkspacePanelProps = ComponentProps<typeof import("./ProjectWorkspacePanel").default>;
type FilesPanelProps = ComponentProps<typeof import("../components/files/FilesWorkspacePanel").default>;
type WidgetsPanelProps = ComponentProps<typeof import("../components/widgets/WidgetsPanel").default>;

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
 *
 * 按需加载（docs/ON_DEMAND_LOADING.md）：
 * - 代码首次可见时才 import（`FeatureView` → `featureRuntime`），窗口启动不再
 *   下载全部页面；
 * - 实例策略来自注册表：默认 `keep`（切页保留草稿/滚动位置），只读工具页
 *   `release`（离开即卸载实例，代码仍缓存，再进入无 loading 闪烁）；
 * - 隐藏页仍挂载时由 `WorkbenchPageActiveContext=false` 通知页面停止后台活动。
 *
 * 错误边界必须**在槽位内部**：它一旦接替渲染，就会替换掉外层 `hidden`
 * 槽位节点；若边界放在槽位外，失败页会一直留在 `.wb-content` 里与后续
 * 页面纵向堆叠（多个页面同时「暂时无法显示」）。放在内部后，隐藏槽位
 * 仍然持有失败态，切页时随 `hidden` 一起消失；重新进入页面时
 * `resetKey` 变化会自动重试一次。
 */
function RouteSlot<P = Record<string, never>>({
  id,
  feature,
  active,
  label,
  children,
}: {
  id: string;
  /** 注册表中的功能 ID（`page:<tab>`）；字面量联合，拼错直接编译失败。 */
  feature: PageFeatureId;
  active: boolean;
  label: string;
  children: (Panel: ComponentType<P>) => ReactNode;
}) {
  return (
    <FeatureView<P> id={feature} active={active} label={label}>
      {(Panel) => (
        <WorkbenchPageActiveContext.Provider value={active}>
          <div className={`tab-content tab-content-${id} wb-route`} hidden={!active}>
            <RouteBoundary id={id} label={label} resetKey={active}>
              {children(Panel)}
            </RouteBoundary>
          </div>
        </WorkbenchPageActiveContext.Provider>
      )}
    </FeatureView>
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * 量取“名称完整显示所需的最小导航宽度”。
 *
 * 不依赖当前导航宽度：先给根节点挂 `data-nav-measuring`，让 CSS 把名称、徽标与
 * 宽态行网格临时恢复（同步量完立即撤销，浏览器不会画出中间态），并把名称按
 * `width: max-content` 排成文字固有宽度；再取名称文字的固有宽度（`scrollWidth`），
 * 加上行内固定轨道（手柄 / 图标 / × / 4 段列间距）、行内边距、徽标宽度与
 * 文字右缘余量。量不到（jsdom 无布局、名称缺失）返回 null，调用方回退 180px 兜底阈值。
 */
function measureWorkbenchNavLabelFit(root: HTMLElement): number | null {
  const nav = root.querySelector<HTMLElement>(".wb-nav");
  if (!nav) return null;
  root.setAttribute("data-nav-measuring", "true");
  try {
    const navStyle = getComputedStyle(nav);
    const navPadX =
      (parseFloat(navStyle.paddingLeft) || 0) + (parseFloat(navStyle.paddingRight) || 0);
    let widest = 0;
    for (const row of nav.querySelectorAll<HTMLElement>(".wb-nav-item")) {
      const label = row.querySelector<HTMLElement>(".wb-nav-label");
      if (!label || !label.firstChild) continue;
      const style = getComputedStyle(row);
      const tracks = style.gridTemplateColumns
        .trim()
        .split(/\s+/)
        .map((token) => parseFloat(token) || 0);
      if (tracks.length < 5) continue;
      const gap = parseFloat(style.columnGap) || 0;
      const rowPadX =
        (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
      // 第 3 列是名称（随容器伸缩）、第 4 列是徽标 auto 轨道；先把固定轨道与间距加总。
      const fixed = (tracks[0] ?? 0) + (tracks[1] ?? 0) + (tracks[4] ?? 0) + gap * 4 + rowPadX;
      // 名称列可能被挤到 0 宽；scrollWidth 取的是内容固有宽度（含被省略的部分）。
      const labelWidth = Math.max(label.getBoundingClientRect().width, label.scrollWidth);
      // 无真实布局（jsdom）：权重全为 0，交给兜底阈值，不把 0 当成名称宽度。
      if (labelWidth <= 0.5) continue;
      const badge = row.querySelector<HTMLElement>(".wb-nav-badge");
      const badgeWidth = badge
        ? Math.max(badge.getBoundingClientRect().width, badge.scrollWidth)
        : 0;
      widest = Math.max(widest, fixed + labelWidth + badgeWidth);
    }
    if (widest <= 0) return null;
    // 名称固有宽度 + 行内固定轨道 + 几像素余量：宽度一旦低于它，名称就会被
    // 省略号遮住，此时整列收成图标轨，不留“半个名称”的中间态。
    return Math.ceil(widest + navPadX + WORKBENCH_NAV_LABEL_TRAILING_GAP);
  } finally {
    root.removeAttribute("data-nav-measuring");
  }
}

/** 启动门读请求上限：超过即按失败处理，给出原因与重试（不无限 loading）。 */
const BOOT_READ_TIMEOUT_MS = 12_000;
/** 启动门停留超过该时长仍未完成时，在加载卡片上说明还在等哪一段。 */
const BOOT_SLOW_HINT_MS = 12_000;

type StatusDiskRow = { volume: string; free: string | null };

/** 状态栏磁盘读数：全部卷按盘符稳定排序；读不到可用空间的卷保留「暂不可用」。 */
function toStatusDisks(disks: ResourceSnapshot["disks"]): StatusDiskRow[] {
  return [...disks]
    .sort((left, right) => left.volume.toUpperCase().localeCompare(right.volume.toUpperCase()))
    .map((disk) => ({
      volume: disk.volume,
      free: disk.availableBytes === null ? null : formatBytes(disk.availableBytes),
    }));
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
  /** 关闭诊断上下文：effect 只安装一次，必须经 ref 读最新路由。 */
  const routeRef = useRef<WorkbenchRoute>(route);
  routeRef.current = route;

  // ── 布局（宽度/右栏/上次路由） ────────────────────────────────────────
  const [navWidth, setNavWidth] = useState(224);
  const [detailWidth, setDetailWidth] = useState(320);
  const [detailOpen, setDetailOpen] = useState(true);
  const [compact, setCompact] = useState(false);
  /** 极窄窗口（≤560 CSS px）：导航固定为图标轨，把宽度还给内容区。 */
  const [narrowWindow, setNarrowWindow] = useState(() => window.innerWidth <= 560);
  /** 名称完整显示所需的最小导航宽度（实测）：null = 尚未量到，用 180px 兜底阈值。 */
  const [navLabelFitWidth, setNavLabelFitWidth] = useState<number | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const navRef = useRef<HTMLElement | null>(null);
  const navWidthRef = useRef(navWidth);
  navWidthRef.current = navWidth;
  const navLabelFitRef = useRef<number | null>(navLabelFitWidth);
  navLabelFitRef.current = navLabelFitWidth;
  /** 导航分栏拖拽中：宽度吸附只在松手后发生，不打断连续跟手。 */
  const navResizingRef = useRef(false);
  const detailWidthRef = useRef(detailWidth);
  detailWidthRef.current = detailWidth;

  // ── 项目列表（shell 唯一持有；面板/首页只消费） ──────────────────────
  const [projects, setProjects] = useState<WorkspaceProject[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  /** 首次项目列表读取的真实错误：启动门据此显示原因与重试，而不是无限 loading。 */
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [devProjects, setDevProjects] = useState<DevProject[]>([]);
  const selectedIdRef = useRef<string | null>(selectedId);
  selectedIdRef.current = selectedId;
  /** 工作空间页注册的离开守卫（正文脏稿落盘）；只在项目切换时 await。 */
  const workspaceLeaveGuardRef = useRef<(() => Promise<boolean>) | null>(null);
  const registerWorkspaceLeaveGuard = useCallback(
    (guard: (() => Promise<boolean>) | null) => {
      workspaceLeaveGuardRef.current = guard;
    },
    [],
  );
  /** 工作空间页当前模块（诊断用）：关闭日志要能区分「正文页」与普通页面。 */
  const closeModuleRef = useRef<(() => string) | null>(null);
  const registerCloseModule = useCallback((read: (() => string) | null) => {
    closeModuleRef.current = read;
  }, []);
  /**
   * 关闭协调器句柄 + 统一关闭状态。
   * 标题栏、Alt+F4、保存超时提示都读这一份；组件内不再维护第二套 closing。
   */
  const closeGuardRef = useRef<WorkbenchCloseGuardHandle | null>(null);
  const [closeState, setCloseState] = useState<WorkbenchCloseState>("idle");
  const [closeMessage, setCloseMessage] = useState<string | null>(null);
  const showToastRef = useRef(showToast);
  showToastRef.current = showToast;
  const appExitHandler = useMemo(
    () =>
      createAppExitHandler({
        getFlush: () => workspaceLeaveGuardRef.current,
        ack: (requestId, ok) => appExitAck(requestId, ok),
        onError: (error) =>
          showToastRef.current(`应用退出前保存失败：${errorMessage(error)}`, {
            kind: "error",
          }),
      }),
    [],
  );
  const projectsRef = useRef<WorkspaceProject[]>(projects);
  projectsRef.current = projects;

  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createKind, setCreateKind] = useState<WorkspaceKind>("general");
  const [createRoot, setCreateRoot] = useState("");
  const [createRootPicking, setCreateRootPicking] = useState(false);
  const [createNote, setCreateNote] = useState("");
  const [createBusy, setCreateBusy] = useState(false);
  // R13: 工作目录离线确认（目录当前不存在时，允许用户明确选择「仍然保存」）。
  const [offlineRootConfirm, setOfflineRootConfirm] = useState<string | null>(null);
  const offlineRootResolveRef = useRef<((ok: boolean) => void) | null>(null);
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
    (
      key:
        | "workbench.layoutSaveFailed"
        | "workbench.projectRecordFailed"
        | "workbench.projectSwitchSaveFailed",
      error: unknown,
    ) => {
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
    const measure = () => setCompact(shouldCollapseWorkbenchDetail(window.innerWidth));
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  // 400/320 窄窗：200px 导航 + 200px 内容会让主区只剩半屏（真机截图实测）。
  // 这里只改渲染宽度、不写回用户偏好；窗口拉宽后自动恢复原导航宽度。
  useEffect(() => {
    const measure = () => setNarrowWindow(window.innerWidth <= 560);
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  // 名称折叠判据 = 实测的“名称所需宽度”：宽度低于名称所需宽度时名称会被
  // 省略号遮住，此时整列收成图标轨（见 CSS 的 data-nav-compact 规则）。
  // 折叠只看**设定的导航宽度**，不读渲染后的 getBoundingClientRect：后者带
  // DPR 小数，会与按整像素吸附的存档宽度判成两个值（如 265.5 vs 266），
  // 出现“图标态但面板仍停在宽态”的状态。
  // R13: 渲染宽度与折叠状态必须同源；否则 compact=true 时仍按旧存档宽度（96/180）
  // 渲染，形成「图标导航 + 空白侧栏」。拖拽中宽度连续跟手，松手吸附仍走
  // resolveWorkbenchNavWidth（见 beginResize / nudgePane）。
  const navPresentation = resolveWorkbenchNavPresentation(
    navWidth,
    navLabelFitWidth,
    narrowWindow,
    navResizingRef.current,
  );
  const effectiveNavWidth = navPresentation.width;
  const navLabelsCompact = navPresentation.compact;

  // ── 项目列表读写 ────────────────────────────────────────────────────
  const refreshProjects = useCallback(async (): Promise<WorkspaceProject[]> => {
    setProjectsError(null);
    try {
      // 初始化读请求必须有上限：IPC 若挂起，启动门会永远等不到 projectHydrated，
      // 表现为「窗口在但一直正在恢复工作台」。超时按失败处理并给出重试。
      const response = await withTimeout(
        workspaceProjectList(),
        BOOT_READ_TIMEOUT_MS,
        `读取项目列表超过 ${Math.round(BOOT_READ_TIMEOUT_MS / 1000)} 秒未返回`,
      );
      setProjects(response.projects);
      return response.projects;
    } catch (e) {
      const message = errorMessage(e);
      setProjectsError(message);
      showToast(`读取项目列表失败：${message}`, { kind: "error" });
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
    async (id: string | null): Promise<boolean> => {
      if (id === selectedIdRef.current) return true;
      // 显式改选项目本身就是「取消当前待决导航」：不取消的话，用户确认旧导航
      // 会在稍后覆盖这次选择，造成 UI 与持久化不一致。
      if (useUiStore.getState().pendingTab) {
        useUiStore.getState().cancelPendingTab();
      }
      projectIntentSeq.current += 1;
      const intent = projectIntentSeq.current;
      const previous = selectedIdRef.current;
      // 正文模块有脏稿时，先 await 落盘；失败或已被更新选择取代则取消本次切换。
      const guard = workspaceLeaveGuardRef.current;
      if (guard) {
        let ok = false;
        try {
          ok = await guard();
        } catch (error) {
          toastErrorRef.current("workbench.projectSwitchSaveFailed", error);
          return false;
        }
        if (!ok || projectIntentSeq.current !== intent) return false;
      }
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
      return true;
    },
    [],
  );

  // 项目 hydration：布局记录 → 活跃项目设置 → 无项目（都无效时保持未选择）。
  // 读取失败（projectsError）不视为 hydrated：列表为空是「真的没有项目」，
  // 读取失败是「还不知道有没有项目」，两者不能混为一谈。
  useEffect(() => {
    if (!settingsReady || projectsLoading || projectsError !== null || projectHydratedRef.current) {
      return;
    }
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
  }, [settingsReady, projectsLoading, projects, projectsError]);

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

  const pickCreateRoot = useCallback(async () => {
    setCreateRootPicking(true);
    try {
      const result = await pickFolder({
        title: "选择项目工作目录",
        defaultPath: createRoot || undefined,
      });
      if (result.status === "ok") {
        setCreateRoot(result.path);
        return;
      }
      if (result.status === "invalid") {
        const reason =
          result.reason === "notFound"
            ? "目录不存在"
            : result.reason === "notDir"
              ? "选择的不是文件夹"
              : `无法读取目录${result.message ? `：${result.message}` : ""}`;
        showToast(`未选择工作目录：${reason}`, { kind: "error" });
      }
    } finally {
      setCreateRootPicking(false);
    }
  }, [createRoot, showToast]);

  // R13: 工作目录离线（当前不存在）不是硬错误：让用户明确确认后再继续保存。
  const confirmOfflineRoot = useCallback(
    (path: string) =>
      new Promise<boolean>((resolve) => {
        offlineRootResolveRef.current = resolve;
        setOfflineRootConfirm(path);
      }),
    [],
  );

  const settleOfflineRoot = useCallback((ok: boolean) => {
    const resolve = offlineRootResolveRef.current;
    offlineRootResolveRef.current = null;
    setOfflineRootConfirm(null);
    resolve?.(ok);
  }, []);

  const submitCreateProject = useCallback(async () => {
    const name = createName.trim();
    if (!name) {
      showToast("项目名称不能为空", { kind: "error" });
      return;
    }
    const root = createRoot.trim();
    if (root) {
      // R13: 路径校验统一走 workspacePath 契约（绝对路径/非法字符/离线/非目录/不可访问），
      // 不再复用剪贴板的批量路径状态查询。empty/ok 直接放行；offline 只做确认。
      let result: Awaited<ReturnType<typeof checkWorkspacePath>>;
      try {
        result = await checkWorkspacePath(root);
      } catch (e) {
        showToast(`无法检查工作目录状态：${errorMessage(e)}`, { kind: "error" });
        return;
      }
      if (result.status === "invalid") {
        showToast(
          result.reason === "not-absolute"
            ? "根目录必须是绝对路径（如 D:\\\\Projects\\\\demo）"
            : "工作目录含非法字符（< > : \" | ? *）",
          { kind: "error" },
        );
        return;
      }
      if (result.status === "not-directory") {
        showToast("工作目录不是文件夹，请重新选择", { kind: "error" });
        return;
      }
      if (result.status === "inaccessible") {
        showToast("无法访问工作目录（可能是权限不足）", { kind: "error" });
        return;
      }
      if (result.status === "offline" && !(await confirmOfflineRoot(result.path))) {
        return;
      }
    }
    setCreateBusy(true);
    try {
      const response = await workspaceProjectSave({
        id: null,
        name,
        kind: createKind,
        rootPath: root || null,
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
    confirmOfflineRoot,
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

  // 关闭/退出前的正文保存握手：复用 workspaceLeaveGuardRef，不新建第二套保存器。
  // - 窗口关闭由 Tauri onCloseRequested 先 preventDefault，flush 成功才真正 close；
  // - 应用退出由 Rust 发 app-before-exit，回执失败时 Rust 取消退出并保持窗口。
  useEffect(() => {
    let disposed = false;
    const stops: Array<() => void> = [];
    const track = (subscription: Promise<() => void>) => {
      void subscription
        .then((stop) => {
          if (disposed) stop();
          else stops.push(stop);
        })
        .catch(() => {});
    };

    track(
      onAppBeforeExit((request) => {
        void appExitHandler(request.requestId);
      }),
    );
    track(
      onAppExitBlocked((reason) => {
        showToastRef.current(`应用退出已取消：${reason}`, { kind: "error" });
      }),
    );

    let guard: WorkbenchCloseGuardHandle | null = null;
    try {
      const current = getCurrentWindow();
      void installWorkbenchCloseGuard({
        window: current as unknown as WorkbenchCloseWindow,
        getFlush: () => workspaceLeaveGuardRef.current,
        // 关闭诊断：路由/模块只用于终端日志，不含正文或项目隐私。
        getContext: () => ({
          route: routeRef.current,
          module: closeModuleRef.current?.() ?? undefined,
        }),
        trace: traceWorkbenchClose,
        onStateChange: (snapshot) => {
          if (disposed) return;
          setCloseState(snapshot.state);
          if (snapshot.state === "saving" || snapshot.state === "retrying-close") {
            setCloseMessage(null);
          }
        },
        onError: (error) => {
          if (disposed) return;
          const message = errorMessage(error);
          setCloseMessage(message);
          if (error instanceof WorkbenchCloseTimeoutError) {
            // 保存仍在进行：不是保存失败，用提示而不是错误口吻。
            showToastRef.current(message, { kind: "warning" });
          } else {
            showToastRef.current(`工作台未关闭：${message}`, { kind: "error" });
          }
        },
      })
        .then((handle) => {
          if (disposed) {
            handle.stop();
            return;
          }
          guard = handle;
          closeGuardRef.current = handle;
        })
        .catch((error) => {
          if (!disposed) {
            showToastRef.current(`工作台关闭保护未启用：${errorMessage(error)}`, {
              kind: "error",
            });
          }
        });
    } catch {
      // 浏览器预览/单测不是 Tauri 环境：没有原生窗口关闭事件。
    }

    return () => {
      disposed = true;
      stops.forEach((stop) => stop());
      closeGuardRef.current = null;
      guard?.stop();
    };
  }, [appExitHandler]);


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
  // 注意：`booted` 之前组件先渲染加载卡片，顶栏尚未挂载；这里按与 `booted` 相同的
  // 三份状态做依赖，等顶栏真正出现后再挂会话。若退回 `[]`，首挂 ref 为空且永不重跑。
  const topbarRef = useRef<HTMLElement | null>(null);
  // 顶栏搜索字段同时是全局搜索下拉层的锚点：弹层挂在字段正下方，
  // 不再从页面中央弹出模态框（锚点由 Popover 负责定位/翻转/边界收敛）。
  const searchAnchorRef = useRef<HTMLDivElement | null>(null);
  // 关闭后焦点回到字段里的触发按钮：锚点容器本身不可聚焦。
  const searchTriggerRef = useRef<HTMLButtonElement | null>(null);
  // 搜索输入行由 GlobalSearchDialog portal 进字段本体（输入框只有这一处，
  // 面板里不再重复）。节点常驻，避免打开瞬间「先挂面板再搬家」重挂输入框、
  // 把刚拿到的焦点丢掉。
  const [searchInputHost, setSearchInputHost] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!settingsReady || !routeHydrated || !projectHydrated) return;
    const node = topbarRef.current;
    if (!node) return;
    const session = attachDragCursorSession(node, { deepRegion: true });
    return () => session.dispose();
  }, [settingsReady, routeHydrated, projectHydrated]);

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
  /**
   * 悬停/聚焦预加载：只预取页面**代码**，不挂载页面、不初始化业务数据。
   * 失败静默（预加载是优化手段，不能影响导航），冷却由 runtime 负责。
   */
  const preloadEntryCode = useCallback((entry: NavEntry) => {
    for (const candidate of entry.tabs) {
      if (!isWorkbenchRoute(candidate)) continue;
      const feature = featureIdForWorkbenchRoute(candidate);
      if (feature) preloadFeature(feature, "hover");
    }
  }, []);
  // 拖拽结束后浏览器补发的 click 不能变成页面跳转（与设置页同一语义）。
  // 不能只依赖时间窗：测试/慢帧下补发 click 也可能晚到；同时用一个「待消费」
  // 标记记住本次拖拽结束，页面按钮的真实 pointerdown 或键盘操作会主动清掉它。
  const navDragEndedAtRef = useRef(0);
  const navDragClickPendingRef = useRef(false);
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
      if (!moveNavEntryTo(id, toIndex)) return;
      navPendingAnnounceRef.current = id;
    },
    onDragEnd: () => {
      // 整行拖拽的松手 click 可能落在页面按钮、手柄或行内空白：统一留下
      // 一次性待消费标记 + 时间窗，只有真正拖过才设置。
      navDragEndedAtRef.current = Date.now();
      navDragClickPendingRef.current = true;
    },
    onCancel: () => {
      navDragEndedAtRef.current = Date.now();
      navDragClickPendingRef.current = true;
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
      ?.querySelector<HTMLElement>(`[data-nav-entry="${id}"] .wb-nav-page`)
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
    const seenSections = new Set<NavSectionKey>();
    for (const entry of entriesToRender) {
      const section = sectionOf(entry);
      const last = sections[sections.length - 1];
      if (!last || last.section !== section) {
        // 旧配置可能留下被隔开的重复分组段：只抑制重复标题，不重写分组归属，
        // 也不改变入口顺序；正常拖拽只会改动被拖入口，其他归属保持不变。
        const repeated = seenSections.has(section);
        sections.push({
          key: `${section}-${entry.id}`,
          section,
          label: repeated ? "" : labels[section],
          items: [],
        });
        if (!repeated) seenSections.add(section);
      }
      sections[sections.length - 1].items.push(entry);
    }
    return sections;
  }, [entriesToRender, leftGroups, t]);

  // 名称度量只跟“实际渲染出来的文字”有关：入口顺序/显隐/语言变化时才重新量。
  // fixedEntries / entriesToRender 每次渲染都是新数组，这里收敛成一个字符串，
  // 避免窗口尺寸等无关重渲染把下面的 layout effect 每帧唤醒。
  const navLabelsKey = useMemo(
    () =>
      [
        t("workbench.home"),
        ...navSections.flatMap((section) => section.items.map((entry) => navLabel(entry, t))),
        ...fixedEntries.map((entry) => navLabel(entry, t)),
        t("workbench.more"),
      ].join("\u0001"),
    [fixedEntries, navSections, t],
  );

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

  const trayOpen = useTransferStore((s) => s.panel.visible);
  const trayWidth = useTransferStore((s) => s.panel.width);
  const trayPinned = useTransferStore((s) => s.panel.pinned);
  const panelMode = useTransferStore((s) => s.panelMode);
  // 固定列与抽屉互斥：只有「固定 + 容器够宽 + 非窄窗」才是固定列。
  // TransferDrawer 在同一次渲染里按同一个 mode 判断，绝不会两个实例同时挂载。
  const trayDockVisible = trayOpen && panelMode === "dock";
  const contextVisible = detailOpen && !compact && !trayDockVisible;

  // 形态只由实测容器宽度决定（不读 window.innerWidth）：项目已有窗口档位负责
  // 「窗口 chrome」，这里量的是工作台真实内容容器，侧栏/详情栏宽度变化也算进去。
  useEffect(() => {
    const node = rootRef.current;
    const apply = (measured: number) => {
      // 窄窗档位（<1100）优先：此时三栏会把主内容挤到不可用，直接按抽屉处理。
      const available = compact ? 0 : measured;
      const mode = resolvePanelMode({
        host: "workbench",
        pinned: trayPinned,
        availableWidth: available,
      });
      useTransferStore.getState().setPanelMode(mode);
    };
    if (!node || typeof ResizeObserver === "undefined") {
      apply(window.innerWidth);
      return;
    }
    const measure = () => {
      const width = node.getBoundingClientRect().width;
      if (width > 0) apply(width);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [compact, trayPinned]);

  // 跨 Tab 模块注册（动作表 / 事件总线）在本窗口启动时装一次；两个窗口的 JS
  // 模块状态互相隔离，所以主窗口与完整工作台都必须执行。注册本身幂等。
  useEffect(() => {
    initializeCrossTabModules();
    return () => disposeCrossTabModules();
  }, []);

  // 当前模块 / 项目 / 文件目录写入跨窗口上下文：只用于推荐目标，绝不据此自动写入。
  // 上下文按窗口隔离（Rust 侧按窗口 label 各存一份），两个窗口不会互相覆盖。
  useEffect(() => {
    const pane = useFilesWorkspaceStore.getState();
    const current = pane.panes[pane.activePaneId];
    const directory =
      route === "files"
        ? current?.tabs.find((tab) => tab.tabId === current.activeTabId)?.path ?? ""
        : "";
    void updateContext({
      module: route,
      directory,
      projectId: selectedId ?? "",
    }).catch(() => {
      // 上下文是增强能力：后端暂不可用时不阻断主导航。
    });
  }, [route, selectedId]);

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
      // 松手以最后一次 move 的值为准：ref 要等下一次渲染才更新，事件之间可能差一帧。
      let live = start;
      if (kind === "nav") navResizingRef.current = true;
      document.body.classList.add("wb-resizing");
      const onMove = (moveEvent: PointerEvent) => {
        const delta =
          kind === "nav" ? moveEvent.clientX - startX : startX - moveEvent.clientX;
        const next =
          kind === "nav"
            ? clamp(start + delta, WORKBENCH_NAV_WIDTH_MIN, WORKBENCH_NAV_WIDTH_MAX)
            : clamp(start + delta, WORKBENCH_DETAIL_WIDTH_MIN, WORKBENCH_DETAIL_WIDTH_MAX);
        live = next;
        if (kind === "nav") setNavWidth(next);
        else setDetailWidth(next);
      };
      const onUp = () => {
        navResizingRef.current = false;
        document.body.classList.remove("wb-resizing");
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        if (kind === "nav") {
          // 松手才吸附：名称放不下就收成图标轨；拖拽过程中保持连续跟手，
          // 名称在过程中按 data-nav-compact 规则隐藏，不会出现被遮住的半截名称。
          // 尚未量到名称宽度时用 180px 兜底阈值，避免停在“图标态但面板很宽”。
          const resolved = resolveWorkbenchNavWidth(
            live,
            navLabelFitRef.current ?? WORKBENCH_NAV_LABELS_COMPACT_BELOW_WIDTH,
          );
          if (resolved !== live) setNavWidth(resolved);
          void setWorkbenchNavWidth(resolved).catch((e) =>
            toastErrorRef.current("workbench.layoutSaveFailed", e),
          );
          return;
        }
        void setWorkbenchDetailWidth(live).catch((e) =>
          toastErrorRef.current("workbench.layoutSaveFailed", e),
        );
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp, { once: true });
    },
    [],
  );

  const nudgePane = useCallback((kind: "nav" | "detail", delta: number) => {
    if (kind === "nav") {
      const current = navWidthRef.current;
      // 尚未量到名称宽度时用 180px 兜底阈值：与 data-nav-compact 的判据保持一致，
      // 键盘调整也不会停在“图标态但面板很宽”的中间宽度。
      const fit = navLabelFitRef.current ?? WORKBENCH_NAV_LABELS_COMPACT_BELOW_WIDTH;
      let next = clamp(current + delta, WORKBENCH_NAV_WIDTH_MIN, WORKBENCH_NAV_WIDTH_MAX);
      const fitWidth = Math.round(fit);
      if (delta > 0 && Math.round(current) < fitWidth) {
        // 图标轨 → 一步展开到“名称刚好放得下”的最小宽态。
        next = fitWidth <= WORKBENCH_NAV_WIDTH_MAX ? fitWidth : WORKBENCH_NAV_WIDTH_RAIL;
      } else if (Math.round(next) < fitWidth) {
        // 名称放不下 → 收成图标轨，不留半个名称的中间宽度。
        next = WORKBENCH_NAV_WIDTH_RAIL;
      }
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
    // 右侧只有一个栏位：打开详情就收起固定列工作篮，避免两个右侧栏同时挤压主内容。
    if (next && useTransferStore.getState().panelMode === "dock") {
      useTransferStore.getState().closePanel();
    }
    setDetailOpen(next);
    void setWorkbenchDetailOpen(next).catch((e) =>
      toastErrorRef.current("workbench.layoutSaveFailed", e),
    );
  }, [detailOpen]);

  // 工作篮宽度走面板状态（localStorage），与工作台详情栏宽度互不影响。
  const beginTrayResize = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const start = useTransferStore.getState().panel.width;
    document.body.classList.add("wb-resizing");
    const onMove = (moveEvent: PointerEvent) => {
      const next = clamp(start + (startX - moveEvent.clientX), 240, 900);
      useTransferStore.getState().resizePanel(next);
    };
    const onUp = () => {
      document.body.classList.remove("wb-resizing");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  }, []);

  const toggleTray = useCallback(() => {
    useTransferStore.getState().togglePanel();
  }, []);

  // 搜索下拉层是「字段下方展开的常驻层」而非模态框：再次点击字段即收起，
  // 快捷键 Ctrl+Shift+F 复用同一 toggle 语义（与主窗口一致）。
  const searchIsOpen = useGlobalSearchStore((s) => s.open);
  const toggleSearch = useGlobalSearchStore((s) => s.toggleSearch);

  // ── 底部状态栏（一次性真实数据；失败/非 Tauri 环境只隐藏对应项，不显示假值） ──
  // sessions 字段在旧快照/部分 mock 里可能缺失：可选链降级为「不显示」。
  const agentSessionCount = useAgentsStore((s) => s.snapshot?.sessions?.length ?? null);
  const [appVersion, setAppVersion] = useState<string | null>(null);
  // 状态栏列出后端枚举到的全部卷，而不是只取数据目录所在的主卷：不同窗口
  // 的数据目录可能不在同一个卷，只显示 disks[0] 会让两个窗口看到的卷不一致。
  // 展示顺序按盘符稳定排序（不跟随数据目录），同一台机器上各窗口一致。
  const [statusDisks, setStatusDisks] = useState<StatusDiskRow[]>([]);
  const [statusDiskLoading, setStatusDiskLoading] = useState(false);
  const statusDiskRequestRef = useRef(0);
  /** 双击锁：按钮 disabled 的渲染晚于事件，同一 tick 的第二次点击仍可能进来。 */
  const statusDiskLockRef = useRef(false);

  // 主动刷新与挂载时走同一条读取路径：复用已有的 resource_snapshot，不新增后端接口。
  // 初次读取失败保持空态（状态栏其余项照常降级）；主动刷新失败保留上次读数并提示。
  const reloadStatusDisks = useCallback(
    async (notifyFailure: boolean) => {
      if (statusDiskLockRef.current) return;
      statusDiskLockRef.current = true;
      const request = ++statusDiskRequestRef.current;
      setStatusDiskLoading(true);
      try {
        const snapshot = await resourceSnapshot();
        if (request !== statusDiskRequestRef.current) return;
        setStatusDisks(toStatusDisks(snapshot.disks));
      } catch {
        if (request !== statusDiskRequestRef.current) return;
        if (notifyFailure) {
          showNotice("error", t("workbench.statusDiskRefreshFailed"));
        }
      } finally {
        statusDiskLockRef.current = false;
        if (request === statusDiskRequestRef.current) setStatusDiskLoading(false);
      }
    },
    [showNotice, t],
  );

  useEffect(() => {
    let disposed = false;
    // 版本与磁盘都是可选富信息：预览/单测等非 Tauri 环境 invoke 会拒绝，
    // 这里按「取不到就不渲染」降级，属于展示层的可选数据而非业务结果。
    void getVersion()
      .then((version) => {
        if (!disposed) setAppVersion(version);
      })
      .catch(() => {});
    void reloadStatusDisks(false);
    return () => {
      disposed = true;
      // 卸载后让在途刷新失效，不再写入状态。
      statusDiskRequestRef.current += 1;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在挂载时读一次；主动刷新走状态栏按钮
  }, []);

  // ── 启动门：设置 + 路由 hydration 完成前不渲染假页面 ────────────────
  const booted = settingsReady && routeHydrated && projectHydrated;
  const readySent = useRef(false);

  // ── 名称宽度实测与宽度吸附（2026-11-17）────────────────────────────
  // 名称放不下时整列收成图标轨：宽态下限改为实测的“名称所需宽度”，
  // 拖拽/键盘调整后低于该宽度一律吸附到图标轨，不留“半个名称”的中间态。
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!booted || !root) return;
    let disposed = false;
    const measure = () => {
      const fit = measureWorkbenchNavLabelFit(root);
      if (disposed || fit === null) return;
      setNavLabelFitWidth((previous) => (previous === fit ? previous : fit));
    };
    measure();
    // 系统字体/回退字体就绪后文字度量可能变一两个像素，再量一次。
    void document.fonts?.ready
      .then(() => {
        if (!disposed) measure();
      })
      .catch(() => {});
    return () => {
      disposed = true;
    };
  }, [booted, navLabelsKey]);

  // 旧配置可能停在“名称被遮住”的宽度（如 180）：量到名称所需宽度后一次性
  // 吸附到合法状态（图标轨或名称态）并落库，避免每次启动都重算同一处修正。
  useEffect(() => {
    if (!booted || navResizingRef.current || narrowWindow) return;
    const fit = navLabelFitWidth ?? WORKBENCH_NAV_LABELS_COMPACT_BELOW_WIDTH;
    const resolved = resolveWorkbenchNavWidth(navWidthRef.current, fit);
    if (resolved === navWidthRef.current) return;
    setNavWidth(resolved);
    void setWorkbenchNavWidth(resolved).catch((e) =>
      toastErrorRef.current("workbench.layoutSaveFailed", e),
    );
  }, [booted, narrowWindow, navLabelFitWidth, navWidth]);
  useEffect(() => {
    if (!booted || readySent.current) return;
    readySent.current = true;
    // 启动路径的窗口是**隐藏创建**的（避免先看到空白窗口）：这里确认首帧可渲染
    // 后让后端显示窗口并聚焦。手动打开/已可见时后端是 no-op，可安全重复调用。
    // 失败必须留痕：否则「窗口一直不显示」在诊断里没有任何线索。
    void workbenchUiReady().catch((error) => {
      logEvent({
        level: "WARN",
        module: "workbench",
        action: "ui-ready",
        event: "notify-failed",
        message: errorMessage(error),
      });
    });
  }, [booted]);

  // 启动门慢启动说明：只在仍未完成时计时，完成后立刻清零。
  const [bootSlow, setBootSlow] = useState(false);
  useEffect(() => {
    if (booted) {
      setBootSlow(false);
      return;
    }
    const timer = window.setTimeout(() => setBootSlow(true), BOOT_SLOW_HINT_MS);
    return () => window.clearTimeout(timer);
  }, [booted]);

  // 空闲预加载（受限）：只预取一个「用户最可能进入」的默认页代码，且仅在启动门
  // 已完成、浏览器空闲时执行一次。预加载只下载代码，不挂载页面、不发业务请求；
  // 有其它加载在飞行时 runtime 会直接跳过（不与用户真正需要的页面抢资源）。
  useEffect(() => {
    if (!booted) return;
    let cancelled = false;
    const run = () => {
      if (!cancelled) preloadFeature("page:tasks", "idle");
    };
    if (typeof requestIdleCallback === "function") {
      const handle = requestIdleCallback(run, { timeout: 5000 });
      return () => {
        cancelled = true;
        cancelIdleCallback(handle);
      };
    }
    const timer = window.setTimeout(run, 4000);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [booted]);

  if (!booted) {
    const failed = Boolean(settingsError || projectsError);
    const failureText = settingsError
      ? t("workbench.shellLoadFailed", { error: settingsError })
      : projectsError
        ? t("workbench.projectListFailed", { error: projectsError })
        : null;
    const retry = () => {
      if (settingsError) {
        void loadSettings().catch(() => {});
      }
      if (projectsError) {
        setProjectsLoading(true);
        void refreshProjects();
      }
    };
    const pendingGates = [
      settingsReady ? null : t("workbench.bootGateSettings"),
      routeHydrated ? null : t("workbench.bootGateRoute"),
      projectHydrated ? null : t("workbench.bootGateProjects"),
    ]
      .filter((gate): gate is string => Boolean(gate))
      .join(t("workbench.bootGateSeparator"));
    return (
      <div className="wb-boot" role={failed ? "alert" : "status"}>
        <div className="wb-boot-card">
          <p>{failureText ?? t("workbench.loading")}</p>
          {failed && (
            <div className="wb-boot-actions">
              <button type="button" className="btn sm" onClick={retry}>
                <RotateCcw size={12} aria-hidden="true" /> {t("common.retry")}
              </button>
              {projectsError && !settingsError && (
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => {
                    // 显式跳过：清掉错误让 hydration 以空列表完成——这是用户
                    // 知情后的选择，不是把失败静默当成功。
                    setProjectsError(null);
                    setProjectsLoading(false);
                  }}
                >
                  {t("workbench.skipProjectList")}
                </button>
              )}
            </div>
          )}
          {!failed && bootSlow && (
            <p className="wb-boot-hint">
              {t("workbench.bootSlow", { gates: pendingGates })}
            </p>
          )}
        </div>
      </div>
    );
  }

  const rootStyle = {
    "--wb-nav-width": `${effectiveNavWidth}px`,
    "--wb-detail-width": `${detailWidth}px`,
  } as CSSProperties;

  return (
    <div
      ref={rootRef}
      className={`wb-root${compact ? " is-compact" : ""}`}
      style={rootStyle}
      data-nav-compact={navLabelsCompact ? "true" : undefined}
    >
      <nav ref={navRef} className="wb-nav" aria-label={t("workbench.navAria")}>
        <div className="wb-nav-items" ref={navListRef}>
          <button
            type="button"
            className={`wb-nav-item${atHome ? " active" : ""}`}
            aria-current={atHome ? "page" : undefined}
            data-tip={navLabelsCompact ? t("workbench.home") : undefined}
            onClick={() => goRoute("home")}
          >
            <span className="wb-nav-icon">
              <LayoutDashboard size={18} strokeWidth={1.75} aria-hidden="true" />
            </span>
            <span className="wb-nav-label">{t("workbench.home")}</span>
          </button>
          {navDrag.dropLineTop !== null && (
            <div
              className="wb-nav-drop-line"
              style={{ top: navDrag.dropLineTop }}
              aria-hidden="true"
            />
          )}
          {navSections.map((section) => (
            <Fragment key={section.key}>
              {section.label && (
                <div
                  className={`wb-nav-group${navDrag.draggingId ? " is-dragging" : ""}`}
                  role="presentation"
                >
                  {section.label}
                </div>
              )}
              {section.items.map((entry) => {
                const active = !atHome && entry.tabs.includes(tab);
                const count = entry.badge ? counts[entry.badge] : 0;
                const label = navLabel(entry, t);
                // 图标轨里徽标不画：把计数并进名称 tooltip，避免收窄后丢信息。
                const navTip = navLabelsCompact
                  ? count > 0
                    ? t("nav.labelWithCount", { label, count })
                    : label
                  : undefined;
                const dragging = navDrag.draggingId === entry.id;
                const shift = navDrag.shifts.get(entry.id) ?? 0;
                const translate = dragging ? navDrag.offsetY : shift;
                const activateEntry = () => {
                  // 拖拽松手后的补发 click 不是「打开页面」的意图。
                  // 先消费一次性标记；新的真实 pointerdown 或键盘操作会提前清掉它。
                  if (navDragClickPendingRef.current) {
                    navDragClickPendingRef.current = false;
                    return;
                  }
                  if (Date.now() - navDragEndedAtRef.current < NAV_DRAG_CLICK_GUARD_MS) return;
                  openEntry(entry);
                };
                return (
                  <div
                    key={entry.id}
                    className={`wb-nav-item has-grip${active ? " active" : ""}${dragging ? " is-dragging" : ""}`}
                    data-nav-entry={entry.id}
                    data-nav-drag-surface
                    data-tip={navTip}
                    style={translate !== 0 ? { transform: `translateY(${translate}px)` } : undefined}
                    onPointerEnter={(event) => {
                      // 只有真正落在页面按钮/行本体上才算「要打开」的意图；
                      // 划过 × 按钮不预加载（那是隐藏动作）。
                      const target = event.target as HTMLElement | null;
                      if (target?.closest("[data-nav-hide], .wb-nav-actions")) return;
                      preloadEntryCode(entry);
                    }}
                    onPointerDown={(event) => {
                      if (event.button !== 0) return;
                      const target = event.target as HTMLElement | null;
                      // × / 行尾操作区是独立控件，不能成为拖拽起点。
                      if (target?.closest("[data-nav-hide], .wb-nav-actions")) return;
                      // 新手势开始：清掉上一次拖拽留下的一次性 click 守卫，
                      // 保证短按打开页面不会被历史拖拽时间窗误伤。
                      navDragClickPendingRef.current = false;
                      navDragEndedAtRef.current = 0;
                      navDrag.beginDrag(event, entry.id);
                    }}
                    onClick={(event) => {
                      const target = event.target as HTMLElement | null;
                      // 页面按钮自己处理点击；× / 操作区已 stopPropagation。
                      // 行首手柄、行内空白点击同样属于整行点击，统一打开页面。
                      if (target?.closest("[data-nav-page], [data-nav-hide], .wb-nav-actions")) return;
                      activateEntry();
                    }}
                  >
                    {/* 行是普通布局容器；页面切换与隐藏是独立按钮，拖拽由整行
                        pointerdown 统一承接。手柄只保留视觉提示，不再是独立控件。 */}
                    <span className="wb-nav-grip" data-nav-grip aria-hidden="true">
                      <GripVertical size={13} strokeWidth={2} />
                    </span>
                    <button
                      type="button"
                      className="wb-nav-page"
                      data-nav-page
                      aria-current={active ? "page" : undefined}
                      aria-label={count > 0 ? t("nav.labelWithCount", { label, count }) : label}
                      data-tip={navTip}
                      onFocus={() => preloadEntryCode(entry)}
                      onClick={(event) => {
                        event.stopPropagation();
                        activateEntry();
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          navDragClickPendingRef.current = false;
                          navDragEndedAtRef.current = 0;
                        }
                        onNavEntryKeyDown(event, entry.id);
                      }}
                    >
                      <span className="wb-nav-icon">
                        <entry.icon size={18} strokeWidth={1.75} aria-hidden="true" />
                      </span>
                      <span className="wb-nav-label">{label}</span>
                      {count > 0 && (
                        <em className={`wb-nav-badge${entry.badge === "pending" ? " is-subtle" : ""}`}>
                          {count > 99 ? "99+" : count}
                        </em>
                      )}
                    </button>
                    {/* 行尾操作区固定占位：只切换透明度，悬停时行宽度不会跳变。
                        × 的任何事件都不冒泡到行，既不起拖也不触发页面切换。 */}
                    <span
                      className="wb-nav-actions"
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => event.stopPropagation()}
                    >
                      <button
                        type="button"
                        className="wb-nav-hide"
                        data-nav-hide
                        data-tip-skip={navLabelsCompact ? undefined : "1"}
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
                  data-tip={navLabelsCompact ? t("workbench.more") : undefined}
                  onClick={onClick}
                  onKeyDown={onKeyDown}
                >
                  <span className="wb-nav-icon">
                    <MoreHorizontal size={18} aria-hidden="true" />
                  </span>
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
                data-tip={navLabelsCompact ? label : undefined}
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
            {/* 品牌位显示 TaskDock 应用图标（与安装包/任务栏/通知同一素材），
                替代原来的通用 Layers 线性图标；图标本身已含透明圆角与留白，
                因此容器不再铺强调色底。 */}
            <span className="wb-brand-mark" aria-hidden="true">
              <img src={appMark} alt="" width={27} height={27} draggable={false} />
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
              // 顶栏左侧的项目入口：菜单左缘与触发器对齐，宽度下限 240px，
              // 靠近右缘时由定位核心收敛，不会被窗口裁掉。
              align="start"
              menuMinWidth={240}
            />
          </div>
          <div className="wb-topbar-actions">
            {/* 字段是下拉层的锚点容器：关闭态显示占位/快捷键（按钮），打开态
                由 GlobalSearchDialog 把输入行 portal 进来，本身变成可输入的搜索框——
                面板里不再有第二个输入框。 */}
            <div
              ref={searchAnchorRef}
              className={`wb-search-field${searchIsOpen ? " is-open" : ""}`}
              role="search"
              /* 字段边缘（1px 边框）本身不是交互元素：显式退出顶栏拖拽热区，
                 避免点边框时变成拖窗口。 */
              data-tauri-drag-region="false"
            >
              <div className="wb-search-inline" ref={setSearchInputHost} />
              <button
                ref={searchTriggerRef}
                type="button"
                className="wb-search-trigger"
                aria-label={t("workbench.search")}
                aria-haspopup="dialog"
                aria-expanded={searchIsOpen}
                data-tip={`${t("workbench.search")} (Ctrl+Shift+F)`}
                onClick={toggleSearch}
              >
                <Search size={13} aria-hidden="true" />
                <span className="wb-search-ph">{t("workbench.searchPlaceholder")}</span>
                <kbd className="wb-search-kbd">{t("workbench.searchHint")}</kbd>
              </button>
            </div>
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
              className={`wb-icon-btn${trayOpen ? " is-on" : ""}`}
              aria-label={t("transfer.title")}
              aria-pressed={trayOpen}
              data-tip={t("transfer.openHint")}
              onClick={toggleTray}
            >
              <Inbox size={15} aria-hidden="true" />
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
          {/* 功能工具组：主题 / 外观 / 置顶。与窗口控制组之间用一条细分隔线
              分开，整组右端不再用负外边距抵消顶栏内边距——关闭按钮与窗口
              右边保留与顶栏一致的 14px 安全留白。 */}
          <div
            className="wb-titlebar-tools"
            role="group"
            aria-label={t("workbench.titlebarTools")}
            data-tauri-drag-region="false"
          >
            {/* 外观工具组：宽窗口内联显示；窄窗口（<900 DIP）由 CSS 档位整体
                换成右侧的「更多」菜单，功能与写入管道不变。 */}
            <div className="wb-toolbar-appearance">
              {/* 明暗主题：顶栏即标题栏，切主题不该只能绕到设置页（与主窗口
                  标题栏的「明暗」菜单同一语义，写库走同一设置管道）。 */}
              <WorkbenchThemeMenu />
              {/* 视觉主题（柔光玻璃 / 梦幻渐变）：与明暗正交，改的是
                  `visual_preset`；工作台圆角随预设变化由 windowFrame 重算。 */}
              <WorkbenchPresetMenu />
              <WorkbenchPinButton />
            </div>
            <WorkbenchToolbarMore />
          </div>
          <WorkbenchWindowControls
            closeState={closeState}
            closeMessage={closeMessage}
            onRequestClose={() => {
              const handle = closeGuardRef.current;
              if (!handle) {
                // 协调器尚未装好或安装失败：宁可不动，也不绕过正文保存守卫。
                logEvent({
                  level: "WARN",
                  module: "workbench",
                  action: "window-control",
                  event: "close-guard-not-ready",
                  status: "cancelled",
                });
                return;
              }
              handle.requestClose();
            }}
          />
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
                    void selectProject(id).then((ok) => {
                      if (ok) goRoute("workspace");
                    });
                  }}
                  onCreateProject={openCreateProject}
                  onQuickAddTask={() => {
                    goRoute("tasks");
                    bumpQuickAdd();
                  }}
                />
              </div>
            </WorkbenchPageActiveContext.Provider>

            {/* 全部路由页面按需加载：窗口启动只加载导航元数据与外壳，
                页面代码在首次可见时才 import（见 docs/ON_DEMAND_LOADING.md）。 */}
            <RouteSlot<WorkspacePanelProps>
              label={t("nav.workspace")}
              id="workspace"
              feature="page:workspace"
              active={route === "workspace"}
            >
              {(Panel) => (
                <Panel
                  project={selected}
                  devProjects={devProjects}
                  onProjectsChanged={refreshProjects}
                  onSelectProject={(id) => selectProject(id)}
                  onRefreshDevProjects={refreshDevProjects}
                  onNavigateWorkbench={() => goRoute("workbench")}
                  onOpenDevWorkbench={requestDevWorkbench}
                  onCreateProject={openCreateProject}
                  onNotice={showNotice}
                  registerProjectLeaveGuard={registerWorkspaceLeaveGuard}
                  registerCloseModule={registerCloseModule}
                  moduleRequest={moduleRequest}
                />
              )}
            </RouteSlot>

            <RouteSlot<FilesPanelProps>
              label={t("nav.files")}
              id="files"
              feature="page:files"
              active={route === "files"}
            >
              {(Panel) => <Panel project={selected} />}
            </RouteSlot>

            <RouteSlot label={t("nav.workbench")} id="workbench" feature="page:workbench" active={route === "workbench"}>
              {(Panel) => <Panel />}
            </RouteSlot>

            <RouteSlot label={t("nav.tasks")} id="tasks" feature="page:tasks" active={route === "tasks"}>
              {(Panel) => <Panel />}
            </RouteSlot>

            <RouteSlot label={t("nav.life")} id="life" feature="page:life" active={route === "life"}>
              {(Panel) => <Panel />}
            </RouteSlot>

            {/* 安全保险箱：面板由并行任务开发，这里同样走统一按需加载入口，
                不允许新功能以静态 import 的方式绕过规范。 */}
            <RouteSlot label={t("nav.vault")} id="vault" feature="page:vault" active={route === "vault"}>
              {(Panel) => <Panel />}
            </RouteSlot>

            <RouteSlot label={t("nav.agents")} id="agents" feature="page:agents" active={route === "agents"}>
              {(Panel) => <Panel />}
            </RouteSlot>

            <RouteSlot label={t("nav.actions")} id="actions" feature="page:actions" active={route === "actions"}>
              {(Panel) => <Panel />}
            </RouteSlot>

            <RouteSlot label={t("nav.clipboard")} id="clipboard" feature="page:clipboard" active={route === "clipboard"}>
              {(Panel) => <Panel />}
            </RouteSlot>

            <RouteSlot
              label={t("nav.collection")}
              id={tab === "shelf" ? "shelf" : "inbox"}
              feature="page:collection"
              active={route === "inbox" || route === "shelf"}
            >
              {(Panel) => <Panel />}
            </RouteSlot>

            <RouteSlot label={t("nav.apps")} id="apps" feature="page:apps" active={route === "apps"}>
              {(Panel) => <Panel />}
            </RouteSlot>

            <RouteSlot<WidgetsPanelProps>
              label={t("nav.widgets")}
              id="widgets"
              feature="page:widgets"
              active={route === "widgets"}
            >
              {(Panel) => <Panel sources={WIDGET_SOURCES} />}
            </RouteSlot>

            <RouteSlot label={t("nav.mobile")} id="mobile" feature="page:mobile" active={route === "mobile"}>
              {(Panel) => <Panel />}
            </RouteSlot>

            <RouteSlot label={t("nav.workflows")} id="workflows" feature="page:workflows" active={route === "workflows"}>
              {(Panel) => <Panel />}
            </RouteSlot>

            <RouteSlot label={t("nav.history")} id="history" feature="page:history" active={route === "history"}>
              {(Panel) => <Panel />}
            </RouteSlot>

            <RouteSlot label={t("nav.roadmap")} id="roadmap" feature="page:roadmap" active={route === "roadmap"}>
              {(Panel) => <Panel />}
            </RouteSlot>

            <RouteSlot label={t("nav.capability")} id="capability" feature="page:capability" active={route === "capability"}>
              {(Panel) => <Panel />}
            </RouteSlot>

            <RouteSlot label={t("nav.help")} id="help" feature="page:help" active={route === "help"}>
              {(Panel) => <Panel />}
            </RouteSlot>

            <RouteSlot label={t("nav.diagnostics")} id="diagnostics" feature="page:diagnostics" active={route === "diagnostics"}>
              {(Panel) => <Panel />}
            </RouteSlot>

            <RouteSlot label={t("nav.resource")} id="resource" feature="page:resource" active={route === "resource"}>
              {(Panel) => <Panel />}
            </RouteSlot>

            <RouteSlot label={t("nav.settings")} id="settings" feature="page:settings" active={route === "settings"}>
              {(Panel) => <Panel />}
            </RouteSlot>
          </main>

          {trayDockVisible && (
            <>
              <div
                className="wb-resizer wb-resizer-tray"
                role="separator"
                aria-orientation="vertical"
                aria-label={t("transfer.resizeHandle")}
                aria-valuemin={240}
                aria-valuemax={900}
                aria-valuenow={Math.round(trayWidth)}
                tabIndex={0}
                onPointerDown={beginTrayResize}
                onKeyDown={(event) => {
                  if (event.key === "ArrowLeft") {
                    event.preventDefault();
                    useTransferStore.getState().resizePanel(
                      Math.min(900, useTransferStore.getState().panel.width + 16),
                    );
                  } else if (event.key === "ArrowRight") {
                    event.preventDefault();
                    useTransferStore.getState().resizePanel(
                      Math.max(240, useTransferStore.getState().panel.width - 16),
                    );
                  }
                }}
              />
              <div className="wb-transfer-col" style={{ width: trayWidth }}>
                <TransferPanel
                  variant="dock"
                  onClose={() => useTransferStore.getState().closePanel()}
                />
              </div>
            </>
          )}

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

        {/* 窄窗 / 未固定工作台统一抽屉形态：覆盖而非挤压主内容。 */}
        <TransferDrawer host="workbench" />

        <footer className="wb-statusbar" role="contentinfo">
          {agentSessionCount !== null && (
            <span className="wb-status-item">
              {t("workbench.statusAgentSessions", { count: agentSessionCount })}
            </span>
          )}
          {statusDisks.length > 0 && (
            <span className="wb-status-item wb-status-disk">
              <span className="wb-status-disk-text">
                {statusDisks
                  .map((disk) =>
                    disk.free === null
                      ? t("workbench.statusDiskUnavailable", { volume: disk.volume })
                      : t("workbench.statusDiskFree", { volume: disk.volume, free: disk.free }),
                  )
                  .join(" · ")}
              </span>
              {/* 主动刷新：复用 resource_snapshot，刷新期间禁用并旋转，失败保留上次读数。 */}
              <button
                type="button"
                className="wb-status-refresh"
                aria-label={t("workbench.statusDiskRefresh")}
                data-tip={t("workbench.statusDiskRefresh")}
                disabled={statusDiskLoading}
                onClick={() => void reloadStatusDisks(true)}
              >
                <RefreshCw
                  size={11}
                  className={statusDiskLoading ? "spin" : undefined}
                  aria-hidden="true"
                />
              </button>
            </span>
          )}
          {/* 包信息：同版本号的不同构建靠这里的提交与构建时间区分（截图即取证）。 */}
          <WorkbenchBuildStatus onNotice={showNotice} />
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

      <GlobalSearchDialog
        anchorRef={searchAnchorRef}
        inputHost={searchInputHost}
        returnFocusRef={searchTriggerRef}
      />
      <MobilePairingDialog />
      <TaskContextDrawer />
      <ClipboardDrawer />
      <Toast />
      <TooltipLayer />

      <Dialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title={t("workbench.newProject")}
        size="md"
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
          <div className="field-row wb-create-row">
            <label className="field wb-create-name">
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
            {/* Select 触发器本身是 <button>，不是 labelable 元素：用 div + 文本保持视觉结构，
                可访问名由 Select 的 ariaLabel 提供，避免 label 内嵌交互控件。 */}
            <div className="field wb-create-kind">
              <span>项目类型</span>
              <Select
                value={createKind}
                options={KIND_OPTIONS}
                onChange={(value) => setCreateKind(value)}
                block
                ariaLabel="项目类型"
              />
            </div>
          </div>
          <div className="field wb-create-root">
            <span>工作目录（可空）</span>
            <div className="wb-create-path-picker">
              <input
                className="ws-input wb-create-path-input"
                aria-label="工作目录（可空）"
                value={createRoot}
                placeholder="选择或输入目录，可留空"
                spellCheck={false}
                data-tip={createRoot || undefined}
                onChange={(event) => setCreateRoot(event.target.value)}
              />
              <button
                type="button"
                className="btn"
                disabled={createRootPicking || createBusy}
                onClick={() => void pickCreateRoot()}
              >
                <FolderOpen size={13} aria-hidden="true" />
                {createRootPicking ? "选择中…" : "选择目录"}
              </button>
              {createRoot && (
                <button
                  type="button"
                  className="btn"
                  disabled={createBusy}
                  aria-label="清除工作目录"
                  onClick={() => setCreateRoot("")}
                >
                  <CloseIcon size={13} aria-hidden="true" />
                </button>
              )}
            </div>
          </div>
          <label className="field">
            <span>备注</span>
            <textarea
              className="ws-textarea"
              value={createNote}
              onChange={(event) => setCreateNote(event.target.value)}
            />
          </label>
        </div>
      </Dialog>

      {/* R13: 工作目录离线确认：只有用户显式选择「仍然保存」才继续创建。
          按需挂载：Dialog 的 overlay/focus hooks 常驻会在 jsdom 下干扰其他守卫链测试。 */}
      {offlineRootConfirm !== null ? (
        <ConfirmDialog
          open
          title="工作目录不存在"
          detail="工作目录当前不存在，仍要保存吗？"
          confirmLabel="仍然保存"
          cancelLabel={t("common.cancel")}
          onConfirm={() => settleOfflineRoot(true)}
          onCancel={() => settleOfflineRoot(false)}
        />
      ) : null}
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
