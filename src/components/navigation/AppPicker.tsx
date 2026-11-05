//! 应用选择器：从已安装软件 / 当前窗口 / 手动登记中选择关联目标。
//!
//! 数据策略：打开时用 store 缓存的扫描结果（后端另有 5 分钟缓存），
//! 不做全量重扫；「刷新」按钮才触发强制扫描。

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import "./appPicker.css";
import {
  X, RefreshCw, Plus, Star, Clock, Monitor, AppWindow, ArrowLeft, Check,
} from "lucide-react";
import SearchField from "../ui/SearchField";
import AgentIcon from "../ui/AgentIcon";
import AppIcon from "../ui/AppIcon";
import { searchApps, APP_PAGE_SIZE } from "../../lib/appSearch";
import { useNavigationStore, type RefreshOutcome } from "../../store/useNavigationStore";
import { useUiStore } from "../../store/useUiStore";
import { useAgentsStore } from "../../store/useAgentsStore";
import { useTasksStore } from "../../store/useTasksStore";
import type { AgentSession } from "../../lib/bridge";
import { errorMessage } from "../../lib/errors";
import { reportError } from "../../lib/errorReport";
import { useFocusTrap, useOverlayLayer } from "../ui/overlay";
import {
  navLinkTask, navListWindows, navListTargetWindows, navListTargets, navLinkTaskWindow, navPickTaskWindow, navPickWindowIdentity, navSaveTarget, navSaveWindowTarget, navSaveAgentSessionTarget, navUpdateTarget,
  CATEGORY_LABELS,
  type DiscoveredApp, type NavTarget, type TargetInput, type WindowInfo, type TaskNavLink,
} from "../../lib/navigation";

const CATEGORY_ORDER = ["all", "browser", "im", "music", "dev", "file", "uwp", "other"];

/**
 * 明显的卸载/更新/后台组件：后端扫描已给出 `tier`，这里保留名称兜底，
 * 用于兼容旧缓存或测试数据（无 tier 字段时按名称判断）。
 */
const BACKGROUND_COMPONENT_NAME =
  /^(unins|setup|updater?$|installer)|(卸载程序|卸载工具|更新程序|安装程序|后台服务|驱动组件)/i;

/** 高级项：默认折叠，可点「显示高级项」查看；不删除、不影响已保存目标。 */
function isAdvancedApp(a: DiscoveredApp): boolean {
  return a.tier ? a.tier === "advanced" : BACKGROUND_COMPONENT_NAME.test(a.display_name);
}

/** 把来源级诊断翻译成用户能理解的一句话（细节仍留在调试字段里）。 */
function scanIssueText(diagnostics?: Record<string, number>): string {
  if (!diagnostics) return "";
  const parts: string[] = [];
  if ((diagnostics.startmenu_truncated ?? 0) > 0) parts.push("开始菜单快捷方式超出本次扫描上限");
  if ((diagnostics.uwp_scan_failed ?? 0) > 0) parts.push("应用商店来源读取失败");
  if ((diagnostics.uwp_truncated ?? 0) > 0) parts.push("应用商店条目超出本次扫描上限");
  return parts.join("；");
}

/** 上次扫描时间：无法解析时返回空串，不伪造时间。 */
function formatScanTime(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** 扫描结果 → 保存目标入参（单个添加与批量添加共用，避免两套字段映射）。 */
function discoveredToInput(a: DiscoveredApp): TargetInput {
  return {
    target_type: "application",
    display_name: a.display_name,
    exe_path: a.exe_path,
    launch_args: a.launch_args,
    working_dir: a.working_dir,
    app_user_model_id: a.app_user_model_id,
    window_title_hint: a.window_title_hint,
    category: a.category,
    overwrite_name: false,
  };
}

/**
 * 稳定的空数组引用：zustand v5 用严格相等比较 selector 结果，
 * 在 selector 里 `?? []` 每次都会新建数组，会触发无限重渲染（白屏的经典成因）。
 */
const EMPTY_SESSIONS: AgentSession[] = [];

interface Props {
  /** 关联模式：非空 = 选择后直接关联该任务 */
  taskId?: string | null;
  /** 重新选择某条现有关联的窗口。 */
  windowLink?: TaskNavLink | null;
  /** 选择模式：返回已保存的目标（不关联任务） */
  onSelect?: (target: NavTarget) => void;
  /**
   * 独立配置模式：保存目标、不关联任务，保存后刷新共享目标列表并返回结果。
   * 与任务关联模式共用同一套 `navSaveTarget` 后端接口。
   */
  standalone?: boolean;
  /**
   * page：主内容区子页面（无遮罩、无焦点陷阱，顶部返回、底部批量添加常驻）；
   * modal：既有弹层（任务关联 / 更换窗口）。默认 modal，保持旧调用方行为。
   */
  variant?: "modal" | "page";
  onClose: () => void;
}

export default function AppPicker({
  taskId,
  windowLink,
  onSelect,
  standalone,
  variant = "modal",
  onClose,
}: Props) {
  const showToast = useUiStore((s) => s.showToast);
  const {
    scan, scanning, scanError, scanProgress, scanPartial,
    loadApps, targets, targetsLoaded, targetsError, loadTargets,
    linksError, loadTaskLinks,
  } = useNavigationStore();
  const taskMode = !!taskId;
  const standaloneMode = !taskMode && !!standalone;
  const isPage = variant === "page";
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [manualOpen, setManualOpen] = useState(false);
  const [windows, setWindows] = useState<WindowInfo[] | null>(null);
  /** 窗口枚举失败：不能转换成空数组，否则会误导为「没有可选择的窗口」 */
  const [windowsError, setWindowsError] = useState<string | null>(null);
  const [agentOpen, setAgentOpen] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  // 搜索结果分页：不固定只给前 80 条，滚动/加载更多继续取完整已发现集合
  const [visibleCount, setVisibleCount] = useState(APP_PAGE_SIZE);
  // 重复添加「已被隐藏」的已保存目标时，先确认恢复显示，避免用户以为没添加成功
  const [restoreTarget, setRestoreTarget] = useState<NavTarget | null>(null);
  // 子页面视图：发现列表 / 当前运行窗口 / 手动添加（都在同一内容区切换，不叠弹层）
  // 更换现有关联窗口时没有「发现/添加」语义，直接进入窗口选择页。
  const [pageView, setPageView] = useState<"discover" | "windows" | "manual">(() =>
    isPage && windowLink ? "windows" : "discover",
  );
  // 多选：只保存选中的应用，未提交前不改动已添加列表
  const [selectedKeys, setSelectedKeys] = useState<ReadonlySet<string>>(new Set());
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchError, setBatchError] = useState<string | null>(null);
  // 当前窗口选择页：单选单个窗口 + 选择快捷方式类型，提交前不改动任何目标。
  const [selectedWindow, setSelectedWindow] = useState<WindowInfo | null>(null);
  const [windowMode, setWindowMode] = useState<"focus" | "launch">("focus");
  const [windowNotice, setWindowNotice] = useState<string | null>(null);
  // 默认隐藏明显的卸载/更新等后台组件，保留入口可查看（不悄悄吞掉结果）
  const [showAdvanced, setShowAdvanced] = useState(false);
  const sessions = useAgentsStore((s) => s.snapshot?.sessions ?? EMPTY_SESSIONS);
  const modalRef = useRef<HTMLDivElement>(null);

  // 弹层栈：关联目标选择器是模态对话框。Escape 只关它，
  // 不会越过它去关外层（任务编辑器），更不会把主窗口藏进托盘。
  // 子页面不是弹层：不能注册遮罩/焦点陷阱，否则会拦截页面内正常操作。
  useOverlayLayer("dialog", !isPage, onClose, modalRef);
  useFocusTrap(!isPage, modalRef);

  /**
   * 目标/关联已保存成功，但界面刷新失败时的统一反馈：不能把刷新失败当成整体成功。
   * - ok：正常提示成功；
   * - stale：已有更新的刷新在途/已落地，本次结果被取代，不重复提示；
   * - error：保留成功事实 + 明确「列表刷新失败」，并提供只读的重试刷新（不会重复写入）。
   */
  function finishWithRefresh(
    successMessage: string,
    outcome: RefreshOutcome,
    retry: () => Promise<RefreshOutcome>,
    kind: "success" | "info" = "success",
  ) {
    if (outcome === "ok") {
      showToast(successMessage, { kind });
      return;
    }
    if (outcome === "stale") return;
    showToast(`${successMessage}，但列表刷新失败`, {
      kind: "warning",
      action: {
        label: "重试刷新",
        run: () => {
          void retry().then(
            (next) => {
              if (next === "ok") showToast("列表已刷新", { kind: "success" });
              else if (next === "error") showToast("刷新仍未成功，请稍后再试", { kind: "error" });
            },
            (e) => showToast(`刷新失败：${errorMessage(e)}`, { kind: "error" }),
          );
        },
      },
    });
  }

  /**
   * 只读取已保存目标（用于「已添加/已隐藏」状态），不触发本机软件扫描。
   * 扫描必须由用户点击「扫描本机应用 / 重新扫描」主动发起；
   * 已有会话内扫描结果直接展示，挂载/切页都不自动刷新。
   */
  useEffect(() => {
    if (!targetsLoaded) void loadTargets();
  }, [targetsLoaded, loadTargets]);

  useEffect(() => {
    if (windowLink) {
      setWindows(null);
      setWindowsError(null);
      if (isPage) {
        setSelectedWindow(null);
        setWindowMode("focus");
        setPageView("windows");
      }
      // 按目标身份取窗口：进程树匹配可覆盖微信/QQ/酷狗等宿主子进程窗口
      void refreshWindows(windowLink.target.id);
    }
  }, [windowLink, isPage]);

  /** 枚举窗口：失败保留错误文案（不清成空列表），并提供重试入口。 */
  async function refreshWindows(targetId?: string) {
    setWindowsError(null);
    try {
      const list = targetId
        ? await navListTargetWindows(targetId)
        : await navListWindows();
      setWindows(list);
    } catch (e) {
      setWindowsError(errorMessage(e));
    }
  }

  /** 扫描进度文案：只展示真实信息（已发现数 + 已完成来源数），不编造百分比。 */
  function scanProgressText(): string {
    if (!scanProgress || scanProgress.sourcesTotal <= 0) return "";
    return `已发现 ${scanProgress.discovered} 个 · 已扫描来源 ${scanProgress.sourcesDone}/${scanProgress.sourcesTotal}`;
  }

  /**
   * 扫描状态提示（页面与弹层共用）：
   * 未扫描时给主动扫描引导；扫描中在可用列表区域水平+垂直居中；失败可重试。
   */
  function renderScanGate() {
    let content: ReactNode = null;
    if (scanFailedFresh) {
      content = (
        <div className="empty-hint error-text" role="alert">
          应用扫描失败：{scanError}
          <button className="btn sm" onClick={() => void loadApps(true)}>
            扫描本机应用
          </button>
        </div>
      );
    } else if (scanUnscanned) {
      content = (
        <div className="picker-unscanned" role="status">
          <div className="picker-unscanned-title">尚未扫描本机应用</div>
          <div className="picker-unscanned-desc">
            点击「扫描本机应用」查找可以添加的桌面程序，也可以直接从当前窗口选择或手动添加
          </div>
          <button className="btn primary sm" onClick={() => void loadApps(true)}>
            扫描本机应用
          </button>
        </div>
      );
    } else if (scanRefreshing) {
      const progress = scanProgressText();
      // 两行结构：第一行是动作与图标，第二行是真实进度（已发现数 / 来源数）。
      // 不塞进同一行，避免窄窗与高 DPI 下拥挤、错位换行。
      content = (
        <div className="empty-hint picker-scanning" role="status">
          <span className="picker-scanning-line">
            <RefreshCw size={12} className="spin" /> 正在扫描本机应用…
          </span>
          {progress && <span className="picker-scan-progress">{progress}</span>}
        </div>
      );
    }
    if (!content) return null;
    return <div className="picker-scan-state">{content}</div>;
  }

  /** 已有结果时的失败 / 部分成功提示：区分「上次结果仍可用」与「仅有部分结果」。 */
  function renderScanNotices() {
    if (!scan) return null;
    return (
      <>
        {scanError && (
          <div className="empty-hint error-text" role={scanPartial ? "alert" : "status"}>
            {scanPartial
              ? `扫描未完成，当前仅显示已发现的部分结果（不完整）：${scanError}`
              : `扫描刷新失败，当前显示上次结果：${scanError}`}
            <button className="btn sm" onClick={() => void loadApps(true)}>
              重试
            </button>
          </div>
        )}
        {scanIncomplete && (
          <div className="empty-hint picker-scan-warn" role="status">
            应用发现可能不完整：{scanIssue}。
            <button className="btn sm" onClick={() => void loadApps(true)}>
              重新扫描
            </button>
          </div>
        )}
      </>
    );
  }

  /** 结果摘要：数量 + 上次扫描时间 + 是否正在刷新，细节留在 diagnostics。 */
  function renderScanSummary(total: number) {
    if (!scan) return null;
    return (
      <div className="picker-count" role="status">
        共 {total} 个{query.trim() ? "匹配" : "可添加"}应用
        {scan.scanned_at ? ` · 上次扫描 ${formatScanTime(scan.scanned_at)}` : ""}
        {scanning
          ? scanProgressText()
            ? ` · 正在扫描（${scanProgressText()}）`
            : " · 正在扫描…"
          : ""}
        {scanIncomplete ? " · 部分来源失败" : ""}
      </div>
    );
  }

  // 窗口列表刷新后，若选中的窗口已消失（关闭/标题变化），清空选择并提示重选，
  // 避免把旧 HWND 当成仍然有效的窗口提交。
  useEffect(() => {
    if (pageView !== "windows" || !selectedWindow || !windows) return;
    const stillThere = windows.some(
      (w) => w.hwnd === selectedWindow.hwnd && w.title === selectedWindow.title,
    );
    if (!stillThere) {
      setSelectedWindow(null);
      setWindowNotice("所选窗口已关闭或标题已变化，请重新选择");
    }
  }, [windows, pageView, selectedWindow]);

  // 已保存目标 → 已关联去重（同任务已关联的标记，不重复加）。
  // 注意：selector 必须返回稳定引用（zustand v5 严格相等），新 Set 在 useMemo 里建。
  const linksByTask = useNavigationStore((s) => s.linksByTask);
  const linkedKeys = useMemo(
    () => new Set((linksByTask[taskId ?? ""] ?? []).map((l) => l.target.app_key)),
    [linksByTask, taskId],
  );

  // 与选择器/应用中心/胶囊共用同一套搜索规则（中文连续子串、英文大小写、身份绑定别名）
  const apps = useMemo(() => {
    // invalid 项后端已不返回；这里再挡一次，兼容旧缓存/测试数据。
    const list = (scan?.apps ?? []).filter((a) => a.tier !== "invalid");
    const byKey = new Map(list.map((a) => [a.app_key, a]));
    const searchable = list.map((a) => ({
      key: a.app_key,
      displayName: a.display_name,
      // 已保存目标的自定义名也参与搜索，但不替换扫描到的展示名
      customName: targets.find(
        (t) => t.target_type === "application" && t.app_key === a.app_key,
      )?.display_name,
      category: a.category,
      exePath: a.exe_path,
      identity: a.app_key,
    }));
    return searchApps(searchable, query, { category })
      .map((s) => byKey.get(s.key))
      .filter((a): a is DiscoveredApp => !!a);
  }, [scan, query, category, targets]);

  // 搜索词/分类变化后回到第一页，避免“加载更多”残留导致列表跳动。
  // 渐进扫描批次不再重置分页：扫描期间已展开的条目不会被后续批次或最终收敛折回。
  useEffect(() => {
    setVisibleCount(APP_PAGE_SIZE);
  }, [query, category]);

  const visibleApps = apps.slice(0, visibleCount);
  const hasMore = apps.length > visibleApps.length;
  const scanIssue = scanIssueText(scan?.diagnostics);
  const scanIncomplete = scanIssue.length > 0;
  // 扫描状态：未扫描 / 扫描中 / 失败（无旧结果）/ 已有结果（可能伴随失败或部分成功）
  const scanUnscanned = scan === null && !scanning && scanError === null;
  const scanFailedFresh = scan === null && !scanning && scanError !== null;
  const scanRefreshing = scan === null && scanning;

  // 子页面：已添加状态与高级筛选（默认隐藏后台组件，可一键查看，不伪造结果）
  const savedByKey = useMemo(() => {
    const map = new Map<string, NavTarget>();
    for (const t of targets) {
      // 指定窗口快捷方式不占用「普通应用」的已添加状态：同一程序仍可再添加普通快捷方式。
      if (t.target_type === "application" && (t.shortcut_kind ?? "app") === "app") {
        map.set(t.app_key, t);
      }
    }
    return map;
  }, [targets]);
  const hiddenByDefault = useMemo(
    () => apps.filter(isAdvancedApp),
    [apps],
  );
  const pageApps = useMemo(
    () => (showAdvanced ? apps : apps.filter((a) => !isAdvancedApp(a))),
    [apps, showAdvanced],
  );
  const pageVisible = pageApps.slice(0, visibleCount);
  const pageHasMore = pageApps.length > pageVisible.length;

  // 扫描结果变化后剔除已不存在身份的选中项，避免批量提交提交到失效条目。
  // 渐进扫描期间列表尚不完整，暂不裁剪，否则已选中的应用会在新批次到达前被误删。
  useEffect(() => {
    if (!isPage || scanning) return;
    const valid = new Set((scan?.apps ?? []).map((a) => a.app_key));
    setSelectedKeys((prev) => {
      const next = new Set([...prev].filter((k) => valid.has(k)));
      return next.size === prev.size ? prev : next;
    });
  }, [scan, isPage, scanning]);

  const runningApps = useMemo(() => {
    const set = new Set<string>();
    for (const t of targets) {
      if (t.target_type === "application") set.add(t.app_key);
    }
    return set;
  }, [targets]);

  async function pickDiscovered(a: DiscoveredApp) {
    if (busyKey) return;
    setBusyKey(a.app_key);
    try {
      const input: TargetInput = discoveredToInput(a);
      const existing = targets.find(
        (x) => x.target_type === "application" && x.app_key === a.app_key,
      );
      const t = await navSaveTarget(input);
      // 已保存但被隐藏：先确认恢复显示，不把它误报成「已添加」后关闭
      if (!taskMode && existing?.hidden) {
        setRestoreTarget(t);
        return;
      }
      // 独立配置模式复用后端「同 app_key 幂等」语义：已存在的目标不会产生重复行。
      await afterPick(
        t,
        taskMode
          ? `已关联「${t.display_name}」`
          : existing
            ? `「${t.display_name}」已在快捷列表中`
            : `已添加「${t.display_name}」`,
        existing && !taskMode ? "info" : "success",
      );
    } catch (e) {
      reportError(e, { operation: "保存应用目标" });
    } finally {
      setBusyKey(null);
    }
  }

  async function restoreHidden() {
    if (!restoreTarget) return;
    try {
      // 只取消隐藏，不提交名称/收藏/启动参数，避免覆盖用户自定义配置
      await navUpdateTarget(restoreTarget.id, { hidden: false });
      const outcome = await loadTargets(true);
      finishWithRefresh("已恢复显示", outcome, () => loadTargets(true));
      onClose();
    } catch (e) {
      showToast(`恢复显示失败：${errorMessage(e)}`, { kind: "error" });
    }
  }

  /** 子页面多选：点击切换，已添加且未隐藏的条目不参与选择（避免重复添加）。 */
  function toggleSelect(key: string) {
    if (batchBusy) return;
    setBatchError(null);
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  /**
   * 批量添加：逐个保存并统计，部分失败时保留失败项选中并如实提示，
   * 不用「全部成功」掩盖部分失败，也不因失败清空已保存的目标。
   */
  async function addSelected() {
    if (batchBusy || selectedKeys.size === 0) return;
    setBatchBusy(true);
    setBatchError(null);
    const items = (scan?.apps ?? []).filter((a) => selectedKeys.has(a.app_key));
    const added: string[] = [];
    const restored: string[] = [];
    const duplicates: string[] = [];
    const failed: Array<{ key: string; reason: string }> = [];
    for (const a of items) {
      try {
        const existing = targets.find(
          (x) =>
            x.target_type === "application" &&
            x.app_key === a.app_key &&
            (x.shortcut_kind ?? "app") === "app",
        );
        if (existing) {
          // 已在列表但被隐藏：按用户本次「添加」意图恢复显示，只改 hidden，不动自定义字段
          if (existing.hidden) {
            await navUpdateTarget(existing.id, { hidden: false });
            restored.push(a.display_name);
          } else {
            duplicates.push(a.display_name);
          }
        } else {
          await navSaveTarget(discoveredToInput(a));
          added.push(a.display_name);
        }
      } catch (e) {
        failed.push({ key: a.app_key, reason: `${a.display_name}：${errorMessage(e)}` });
      }
    }
    // 批量写入已结束，最后统一刷新一次：刷新失败是独立结果，不能算作某个应用添加失败，
    // 也不能用「全部成功」掩盖；已保存的数据不受影响，重试只刷新、不会重复创建。
    const refreshOutcome = await loadTargets(true);
    setBatchBusy(false);
    const summaryText =
      `已添加 ${added.length} 个应用` +
      `${restored.length ? `，恢复显示 ${restored.length} 个` : ""}` +
      `${duplicates.length ? `，${duplicates.length} 个已在列表中` : ""}`;
    const refreshFailure = refreshOutcome === "error" ? "列表刷新失败，当前显示可能不是最新" : "";

    if (failed.length > 0) {
      // 部分成功：保留失败项继续可重试，已成功的从选中集合移除
      setSelectedKeys(new Set(failed.map((f) => f.key).filter((k) => k)));
      setBatchError(
        `${summaryText}；${failed.length} 个失败：${failed.map((f) => f.reason).join("；")}` +
          (refreshFailure ? `；${refreshFailure}` : ""),
      );
      showToast(
        `部分应用添加失败（${failed.length} 个），详见页面提示`,
        { kind: "error" },
      );
      return;
    }

    if (refreshOutcome === "error") {
      finishWithRefresh(summaryText, refreshOutcome, () => loadTargets(true), "success");
      setSelectedKeys(new Set());
      onClose();
      return;
    }
    if (refreshOutcome === "stale") {
      // 刷新被更新的请求取代：写入已完成，让最新一次的刷新结果落地即可。
      setSelectedKeys(new Set());
      onClose();
      return;
    }
    showToast(summaryText, { kind: "success" });
    setSelectedKeys(new Set());
    onClose();
  }

  /** 同程序普通应用快捷方式（不含指定窗口快捷方式）。 */
  function plainTargetForExe(path: string): NavTarget | undefined {
    return targets.find(
      (t) =>
        t.target_type === "application" &&
        (t.shortcut_kind ?? "app") === "app" &&
        (t.exe_path ?? "").toLowerCase() === path.toLowerCase(),
    );
  }

  /** 是否已存在完全相同的指定窗口快捷方式（类名+标题+exe）。 */
  function windowShortcutExists(w: WindowInfo): boolean {
    return targets.some((t) => {
      if (t.target_type !== "application" || (t.shortcut_kind ?? "app") !== "window") return false;
      const bound = t.bound_window_identity;
      return (
        !!bound &&
        !!w.exe_path &&
        bound.class_name === w.class_name &&
        bound.title === w.title &&
        bound.exe_path.toLowerCase() === w.exe_path.toLowerCase()
      );
    });
  }

  /**
   * 当前窗口选择页的「确认添加」：只保存配置，不聚焦、不启动、不切走用户当前窗口。
   * - 优先切换到此窗口：后端一次性解析稳定身份落库（同身份复用，同程序多窗口各自独立）；
   * - 仅添加应用：只保存普通应用快捷方式，不绑定任何窗口身份。
   */
  async function confirmWindowAdd() {
    const w = selectedWindow;
    if (!w || busyKey) return;
    if (!w.exe_path) {
      setWindowNotice("无法识别该窗口所属程序（权限受限），不能添加；请改用手动登记 EXE");
      return;
    }
    setBusyKey(`window:${w.hwnd}`);
    setWindowNotice(null);
    // 提交前判定：保存后 targets 尚未刷新，避免把「刚保存」误判成「已存在」。
    const already =
      windowMode === "focus" ? windowShortcutExists(w) : !!plainTargetForExe(w.exe_path);
    try {
      const name = w.title.split(/ [-–·] /)[0].slice(0, 60) || "窗口应用";
      let t: NavTarget;
      if (windowMode === "focus") {
        t = await navSaveWindowTarget(w.hwnd);
      } else {
        const existing = plainTargetForExe(w.exe_path);
        t =
          existing ??
          (await navSaveTarget({
            target_type: "application",
            display_name: name,
            exe_path: w.exe_path,
            overwrite_name: false,
          }));
      }
      const outcome = await loadTargets(true);
      finishWithRefresh(
        already
          ? `「${t.display_name}」已在快捷列表中`
          : windowMode === "focus"
            ? `已添加「${t.display_name}」并绑定当前窗口`
            : `已添加「${t.display_name}」（不绑定窗口）`,
        outcome,
        () => loadTargets(true),
        already ? "info" : "success",
      );
      setSelectedWindow(null);
      setPageView("discover");
    } catch (e) {
      // 保存失败：留在当前页并保留选择，方便重试；不吞掉后端的具体原因。
      setWindowNotice(`添加失败：${errorMessage(e)}`);
      showToast(`添加失败：${errorMessage(e)}`, { kind: "error" });
    } finally {
      setBusyKey(null);
    }
  }

  async function afterPick(t: NavTarget, msg: string, kind: "success" | "info" = "success") {
    if (taskId) {
      // 已关联过则提示而非重复关联
      if (linkedKeys.has(t.app_key)) {
        showToast(`「${t.display_name}」已关联该任务`, { kind: "info" });
        onClose();
        return;
      }
      // 第一阶段：关联。失败时目标已保存，必须分别说明，不能误报为保存失败。
      try {
        await navLinkTask(taskId, t.id, false, "default");
      } catch (e) {
        showToast(`已保存「${t.display_name}」，但关联任务失败：${errorMessage(e)}`, {
          kind: "error",
        });
        onClose();
        return;
      }
      // 第二阶段：界面刷新。刷新失败不得抹掉第一阶段的成功事实。
      const linksOutcome = await loadTaskLinks();
      await useTasksStore.getState().refresh();
      finishWithRefresh(msg, linksOutcome, loadTaskLinks, kind);
      onClose();
      return;
    }

    if (onSelect) {
      onSelect(t);
      onClose();
      return;
    }
    if (standaloneMode) {
      // 独立配置：保存后共享目标列表立即更新（工具面板下一帧就能看到）
      const outcome = await loadTargets(true);
      finishWithRefresh(msg, outcome, () => loadTargets(true), kind);
      onClose();
      return;
    }
    onClose();
  }

  /**
   * 把 Agent 会话登记为可信目标并关联任务。
   * 只传 (source_id, session_id)：会话身份由后端查库核验，
   * 前端不构造路径、不编造显示名。
   */
  async function pickAgentSession(s: AgentSession) {
    if (busyKey) return;
    const key = `${s.source_id}:${s.external_id}`;
    setBusyKey(key);
    try {
      const t = await navSaveAgentSessionTarget(s.source_id, s.external_id);
      await afterPick(t, `已关联会话「${t.display_name}」`);
    } catch (e) {
      reportError(e, { operation: "关联会话" });
    } finally {
      setBusyKey(null);
    }
  }

  async function pickWindow(w: WindowInfo) {
    if (!w.exe_path) {
      showToast("该窗口无法识别所属程序（权限受限），请手动登记 exe 路径", { kind: "error" });
      return;
    }
    if (busyKey) return;
    setBusyKey(String(w.hwnd));
    try {
      if (windowLink) {
        await navPickTaskWindow(windowLink.id, w.hwnd);
        const outcome = await loadTaskLinks();
        finishWithRefresh("已更新任务窗口选择", outcome, loadTaskLinks);
        onClose();
        return;
      }
      const name = w.title.split(/ [-–·] /)[0].slice(0, 60) || "窗口应用";
      // 查询现有应用，避免选择窗口时覆盖共用目标的启动参数。
      const existing = (await navListTargets(true)).find(
        (t) =>
          t.target_type === "application" &&
          (t.shortcut_kind ?? "app") === "app" &&
          (t.exe_path ?? "").toLowerCase() === w.exe_path!.toLowerCase(),
      );
      const t = existing ?? await navSaveTarget({
        target_type: "application",
        display_name: name,
        exe_path: w.exe_path,
        overwrite_name: false,
      });
      if (taskId) {
        await navLinkTaskWindow(taskId, t.id, w.hwnd);
        const outcome = await loadTaskLinks();
        finishWithRefresh(`已为任务选择「${w.title}」`, outcome, loadTaskLinks);
        onClose();
      } else {
        await navPickWindowIdentity(t.id, w.hwnd);
        await afterPick(
          t,
          taskMode
            ? `已选择「${t.display_name}」`
            : existing
              ? `「${t.display_name}」已在快捷列表中`
              : `已添加「${t.display_name}」`,
          existing && !taskMode ? "info" : "success",
        );
      }
    } catch (e) {
      showToast(`未能记录窗口身份：${errorMessage(e)}`, { kind: "error" });
    } finally {
      setBusyKey(null);
    }
  }

  if (isPage) {
    return (
      <div className="app-picker-page" role="region" aria-label="添加应用">
        <header className="app-picker-page-head">
          <button
            type="button"
            className="icon-btn sm"
            aria-label={
              windowLink ? "返回任务编辑" : pageView === "discover" ? "返回应用列表" : "返回添加应用"
            }
            onClick={() => {
              // 更换现有关联窗口是单层子页，返回直接回任务编辑，不经过「添加应用」。
              if (windowLink || pageView === "discover") onClose();
              else setPageView("discover");
            }}
          >
            <ArrowLeft size={15} />
          </button>
          <span className="app-picker-page-title">
            {windowLink
              ? `为「${windowLink.target.display_name}」选择窗口`
              : pageView === "discover"
                ? "添加应用"
                : pageView === "windows"
                  ? "从当前窗口选择"
                  : "手动添加"}
          </span>
          {pageView === "discover" && selectedKeys.size > 0 && (
            <span className="picker-selected-count" role="status">已选 {selectedKeys.size}</span>
          )}
          <span className="flex-spacer" />
          {pageView === "discover" && (
            <div className="app-picker-page-tools">
              {scan !== null && (
                <button className="btn sm" onClick={() => void loadApps(true)} disabled={scanning}>
                  <RefreshCw size={12} className={scanning ? "spin" : ""} />
                  {scanning ? "扫描中…" : "重新扫描"}
                </button>
              )}
              <button
                className="btn sm"
                onClick={() => {
                  setSelectedWindow(null);
                  setWindowNotice(null);
                  setWindowMode("focus");
                  setPageView("windows");
                  void refreshWindows();
                }}
              >
                <Monitor size={12} /> 从当前窗口选择
              </button>
              <button className="btn sm" onClick={() => setPageView("manual")}>
                <Plus size={12} /> 手动添加
              </button>
            </div>
          )}
        </header>

        {pageView === "windows" && (
          <>
            <div className="app-picker-page-body">
              <ol className="picker-window-steps">
                <li>① 选择窗口</li>
                {!windowLink && <li>② 选择快捷方式类型</li>}
                <li>{windowLink ? "② 确认更换" : "③ 确认添加"}</li>
              </ol>
              <div className="endpoint-hint">
                {windowLink
                  ? "只更新这条关联的窗口身份，不会切换你当前的窗口。记录类名、标题与程序，不保存 HWND；窗口关闭或标题变化后需要重新选择。"
                  : "添加只保存配置，不会切换你当前的窗口。指定窗口快捷方式会记录类名、标题与程序，不保存 HWND；窗口关闭或标题变化后需要重新选择，不会静默切换到同程序的其他窗口。仅添加应用不绑定窗口，启动时按程序打开/聚焦；部分单实例应用可能只激活已有窗口。"}
              </div>
              {windowNotice && (
                <div className="empty-hint picker-window-notice" role="status">{windowNotice}</div>
              )}
              {windowsError && (
                <div className="empty-hint error-text" role="alert">
                  读取窗口失败：{windowsError}
                  <button className="btn sm" onClick={() => void refreshWindows()}>重试</button>
                </div>
              )}
              {!windows && !windowsError && <div className="empty-hint">正在读取窗口…</div>}
              {!windowsError && windows?.length === 0 && (
                <div className="empty-hint">没有可交互的窗口</div>
              )}
              {!windowsError && (
                <div className="picker-window-page-list" role="radiogroup" aria-label="选择窗口">
                  {windows?.map((w) => {
                    const selected = selectedWindow?.hwnd === w.hwnd;
                    const unavailable = !w.exe_path;
                    return (
                      <button
                        key={w.hwnd}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        aria-disabled={unavailable}
                        disabled={!!busyKey}
                        className={`picker-window-row ${selected ? "is-selected" : ""} ${unavailable ? "is-unavailable" : ""}`}
                        onClick={() => {
                          if (unavailable) {
                            setSelectedWindow(null);
                            setWindowNotice("无法识别该窗口所属程序（权限受限），不能添加；请改用手动登记 EXE");
                            return;
                          }
                          setSelectedWindow(w);
                          setWindowNotice(null);
                        }}
                      >
                        <AppIcon
                          exePath={w.exe_path ?? undefined}
                          name={w.title}
                          size={28}
                        />
                        <span className="picker-window-info">
                          <span className="picker-window-title" data-tip={w.title}>{w.title}</span>
                          <span className="picker-window-exe">
                            {w.exe_path
                              ? w.exe_path.split("\\").pop()
                              : "无法识别所属程序（权限受限），不能添加"}
                          </span>
                        </span>
                        <span className="picker-window-check" aria-hidden="true">
                          {selected && <Check size={14} />}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
              {!windowLink && (
                <div className="picker-window-mode" role="radiogroup" aria-label="快捷方式类型">
                <div className="picker-window-mode-title">快捷方式类型</div>
                <button
                  type="button"
                  role="radio"
                  aria-checked={windowMode === "focus"}
                  className={`picker-mode-option ${windowMode === "focus" ? "is-selected" : ""}`}
                  disabled={!!busyKey}
                  onClick={() => setWindowMode("focus")}
                >
                  <span className="picker-mode-name">优先切换到此窗口（推荐）</span>
                  <span className="picker-mode-desc">
                    绑定当前窗口的稳定身份；窗口可用时优先聚焦它，不覆盖同程序其他窗口。
                  </span>
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={windowMode === "launch"}
                  className={`picker-mode-option ${windowMode === "launch" ? "is-selected" : ""}`}
                  disabled={!!busyKey}
                  onClick={() => setWindowMode("launch")}
                >
                  <span className="picker-mode-name">仅添加应用，不绑定窗口</span>
                  <span className="picker-mode-desc">
                    只保存程序启动目标，不记录窗口身份；不会强制新开窗口。
                  </span>
                </button>
                </div>
              )}
            </div>
            <div className="app-picker-page-foot">
              <button
                className="btn sm"
                onClick={() => void refreshWindows(windowLink?.target.id)}
                disabled={!!busyKey}
              >
                刷新窗口
              </button>
              <span className="flex-spacer" />
              <button
                className="btn primary sm"
                disabled={!selectedWindow || !!busyKey}
                onClick={() => void (windowLink ? pickWindow(selectedWindow!) : confirmWindowAdd())}
              >
                {busyKey
                  ? windowLink
                    ? "更新中…"
                    : "添加中…"
                  : windowLink
                    ? "使用此窗口"
                    : "确认添加"}
              </button>
            </div>
          </>
        )}

        {pageView === "manual" && (
          <div className="app-picker-page-body">
            <ManualAddForm
              onSaved={async (t, msg) => {
                const existed = targets.some(
                  (x) =>
                    x.target_type === t.target_type &&
                    x.app_key === t.app_key &&
                    (x.shortcut_kind ?? "app") === "app",
                );
                // 保存已成功；刷新失败必须单独说明，不能静默当成整体成功。
                const outcome = await loadTargets(true);
                finishWithRefresh(
                  existed ? `「${t.display_name}」已在快捷列表中` : msg,
                  outcome,
                  () => loadTargets(true),
                  existed ? "info" : "success",
                );
                setPageView("discover");
              }}
            />
          </div>
        )}

        {pageView === "discover" && (
          <>
            <div className="picker-search-row">
              <SearchField
                className="picker-search"
                size="compact"
                autoFocus
                value={query}
                onChange={setQuery}
                placeholder="搜索已安装软件…"
                ariaLabel="搜索应用"
              />
            </div>

            <div className="picker-cats-scroll">
              <div className="seg-group subtle picker-cats" role="group" aria-label="分类筛选">
                {CATEGORY_ORDER.map((c) => (
                  <button
                    key={c}
                    className={`seg-btn ${category === c ? "active" : ""}`}
                    aria-pressed={category === c}
                    onClick={() => setCategory(c)}
                  >
                    {c === "all" ? "全部" : CATEGORY_LABELS[c] ?? c}
                  </button>
                ))}
              </div>
            </div>

            <div className="app-picker-page-body">
              {batchError && (
                <div className="empty-hint error-text" role="alert">{batchError}</div>
              )}
              {targetsError && (
                <div className="empty-hint error-text" role="alert">
                  已保存目标读取失败：{targetsError}
                  <button className="btn sm" onClick={() => void loadTargets(true)}>重试</button>
                </div>
              )}
              {taskMode && linksError && (
                <div className="empty-hint error-text" role="status">
                  关联信息读取失败：{linksError}；当前显示上次结果，可能不是最新
                  <button className="btn sm" onClick={() => void loadTaskLinks()}>重试</button>
                </div>
              )}
              {renderScanGate()}
              {scan !== null && (
                <>
                  {renderScanNotices()}
                  <div className="picker-count" role="status">
                    共 {pageApps.length} 个{query.trim() ? "匹配" : "可添加"}应用
                    {scan.scanned_at ? ` · 上次扫描 ${formatScanTime(scan.scanned_at)}` : ""}
                    {scanning
                      ? scanProgressText()
                        ? ` · 正在扫描（${scanProgressText()}）`
                        : " · 正在扫描…"
                      : ""}
                    {scanIncomplete ? " · 部分来源失败" : ""}
                    {hiddenByDefault.length > 0 && !showAdvanced && (
                      <button
                        className="link-btn picker-advanced"
                        onClick={() => setShowAdvanced(true)}
                      >
                        显示高级项（{hiddenByDefault.length}）
                      </button>
                    )}
                    {showAdvanced && (
                      <button
                        className="link-btn picker-advanced"
                        onClick={() => setShowAdvanced(false)}
                      >
                        隐藏高级项
                      </button>
                    )}
                  </div>
                  {pageApps.length === 0 ? (
                    <div className="empty-hint">
                      {query.trim()
                        ? `没有匹配「${query.trim()}」的应用；可换个关键词，或手动添加`
                        : apps.length > 0
                          ? "当前只显示常用应用；点「显示高级项」查看被默认隐藏的后台组件"
                          : scanning
                            // 后续来源还在扫描：不能提前宣称「扫描完成」
                            ? "正在扫描，暂未发现可添加的应用…"
                            : scanPartial
                              ? "扫描未完成，暂未发现可添加的应用；可重试扫描"
                              : "扫描完成，未发现可添加的应用；可从当前窗口选择或手动添加"}
                    </div>
                  ) : (
                    <>
                      <div className="app-picker-page-grid" role="listbox" aria-label="已安装软件" aria-multiselectable="true">
                        {pageVisible.map((a) => {
                          const saved = savedByKey.get(a.app_key);
                          const already = !!saved && !saved.hidden;
                          const selected = selectedKeys.has(a.app_key);
                          return (
                            <button
                              key={a.app_key}
                              type="button"
                              role="option"
                              aria-selected={selected}
                              className={`picker-app ${selected ? "selected" : ""} ${already ? "is-saved" : ""}`}
                              disabled={already || batchBusy}
                              onClick={() => toggleSelect(a.app_key)}
                              data-tip={a.display_name}
                            >
                              <AppIcon appKey={a.app_key} name={a.display_name} size={30} />
                              <span className="picker-app-name">{a.display_name}</span>
                              <span className="picker-app-meta">
                                {already ? "已添加" : selected ? "已选" : saved?.hidden ? "已隐藏" : a.source === "uwp" ? "商店" : ""}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                      {pageHasMore && (
                        <button
                          className="btn sm picker-more"
                          onClick={() => setVisibleCount((v) => v + APP_PAGE_SIZE)}
                        >
                          加载更多（已显示 {pageVisible.length} / {pageApps.length}）
                        </button>
                      )}
                    </>
                  )}
                </>
              )}
            </div>

            <div className="app-picker-page-foot">
              <button className="btn sm" onClick={onClose}>取消</button>
              <span className="flex-spacer" />
              <button
                className="btn primary sm"
                disabled={selectedKeys.size === 0 || batchBusy}
                onClick={() => void addSelected()}
              >
                {batchBusy
                  ? "添加中…"
                  : selectedKeys.size > 0
                    ? `添加已选应用（${selectedKeys.size}）`
                    : "添加已选应用"}
              </button>
            </div>
          </>
        )}
      </div>
    );
  }

  if (windowLink) {
    // 后端已按进程身份过滤；这里不再用 exe 路径相等二次裁掉子进程窗口
    const matches = windows;
    return (
      <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        <div className="modal app-picker" ref={modalRef} tabIndex={-1} role="dialog" aria-modal="true"
        aria-label={standaloneMode ? "添加应用与快捷方式" : "选择关联目标"} onMouseDown={(e) => e.stopPropagation()}>
          <div className="modal-head"><span>为 {windowLink.target.display_name} 选择窗口</span>
            <button className="icon-btn sm" onClick={onClose} aria-label="关闭"><X size={14} /></button>
          </div>
          <div className="modal-body picker-window-list">
            {!windows && !windowsError && <div className="empty-hint">正在读取窗口…</div>}
            {windowsError && (
              <div className="empty-hint error-text" role="alert">
                读取窗口失败：{windowsError}
                <button className="btn sm" onClick={() => void refreshWindows(windowLink.target.id)}>
                  重试
                </button>
              </div>
            )}
            {!windowsError && matches?.length === 0 && <div className="empty-hint">没有可选择的窗口</div>}
            {!windowsError && matches?.map((w) => <button key={w.hwnd} className="picker-window-item" disabled={!!busyKey} onClick={() => pickWindow(w)}>{w.title}</button>)}
            <button className="btn sm" onClick={() => void refreshWindows(windowLink.target.id)}>刷新窗口</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal app-picker" ref={modalRef} tabIndex={-1} role="dialog" aria-modal="true"
        aria-label={standaloneMode ? "添加应用与快捷方式" : "选择关联目标"} onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span><AppWindow size={14} /> {taskMode ? "选择关联目标（将关联到任务）" : standaloneMode ? "添加应用与快捷方式" : "选择应用"}</span>
          <button className="icon-btn sm" onClick={onClose} aria-label="关闭"><X size={14} /></button>
        </div>
        <div className="modal-body">
          {/* 搜索 + 刷新 */}
          <div className="picker-search-row">
            <SearchField
              className="picker-search"
              size="compact"
              autoFocus
              value={query}
              onChange={setQuery}
              placeholder="搜索已安装软件…"
              ariaLabel="搜索应用"
            />
            {scan !== null && (
              <button
                className="btn sm"
                onClick={() => loadApps(true)}
                disabled={scanning}
                title="重新扫描开始菜单 / 注册表 / 应用商店（不扫描全盘）"
              >
                <RefreshCw size={12} className={scanning ? "spin" : ""} /> {scanning ? "扫描中…" : "重新扫描"}
              </button>
            )}
            <button className="btn sm" onClick={() => setManualOpen((v) => !v)}>
              <Plus size={12} /> 手动添加
            </button>
          </div>

          {/* 分类筛选 */}
          <div className="seg-group subtle picker-cats" role="group" aria-label="分类筛选">
            {CATEGORY_ORDER.map((c) => (
              <button
                key={c}
                className={`seg-btn ${category === c ? "active" : ""}`}
                onClick={() => setCategory(c)}
              >
                {c === "all" ? "全部" : CATEGORY_LABELS[c] ?? c}
              </button>
            ))}
          </div>

          {/* 最近使用 / 收藏（已保存目标） */}
          {!query && category === "all" && targets.length > 0 && (
            <div className="picker-recent">
              {targets
                .filter((t) => !t.hidden && (t.favorite || t.use_count > 0))
                .sort((a, b) => Number(b.favorite) - Number(a.favorite) || b.use_count - a.use_count)
                .slice(0, 6)
                .map((t) => (
                  <button
                    key={t.id}
                    className="chip picker-chip"
                    onClick={() =>
                      busyKey ||
                      afterPick(
                        t,
                        taskMode
                          ? `已关联「${t.display_name}」`
                          : `「${t.display_name}」已在快捷列表中`,
                        taskMode ? "success" : "info",
                      )
                    }
                  >
                    {t.favorite ? <Star size={10} /> : <Clock size={10} />}
                    {t.display_name}
                    {linkedKeys.has(t.app_key) ? " ✓" : ""}
                  </button>
                ))}
            </div>
          )}

          {/* 当前窗口快捷区 */}
          <div className="picker-windows">
            <button
              className="link-btn"
              onClick={() => {
                if (windows) {
                  setWindows(null);
                  setWindowsError(null);
                } else {
                  void refreshWindows();
                }
              }}
            >
              <Monitor size={11} /> {windows ? "收起当前窗口列表" : "从当前运行的窗口选择…"}
            </button>
            {windowsError && !windowLink && (
              <div className="empty-hint error-text" role="alert">
                读取窗口失败：{windowsError}
                <button className="btn sm" onClick={() => void refreshWindows()}>
                  重试
                </button>
              </div>
            )}
            {windows && (
              <div className="picker-window-list">
                {windows.length === 0 && <div className="empty-hint">无可交互窗口</div>}
                {windows.slice(0, 12).map((w) => (
                  <button key={w.hwnd} className="picker-window-item" onClick={() => pickWindow(w)}>
                    <span className="picker-window-title">{w.title.slice(0, 48)}</span>
                    <span className="picker-window-exe">{w.exe_path?.split("\\").pop()}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {restoreTarget && (
            <div className="empty-hint error-text" role="alert">
              「{restoreTarget.display_name}」已在快捷列表中但被隐藏。
              <button className="btn sm" onClick={() => void restoreHidden()}>
                恢复显示
              </button>
            </div>
          )}

          {targetsError && (
            // 已保存目标读取失败：不能等同「尚未配置」，给重试入口
            <div className="empty-hint error-text" role="alert">
              已保存目标读取失败：{targetsError}
              <button className="btn sm" onClick={() => void loadTargets(true)}>
                重试
              </button>
            </div>
          )}

          {taskMode && linksError && (
            // 关联读取失败：不能等同「没有关联」；旧映射可能过期，标明并提供重试
            <div className="empty-hint error-text" role="status">
              关联信息读取失败：{linksError}；当前显示上次结果，可能不是最新
              <button className="btn sm" onClick={() => void loadTaskLinks()}>
                重试
              </button>
            </div>
          )}

          {/* Agent 会话快捷区（v0.4：会话可作为导航目标，支持恢复/工作区跳转）
              应用配置模式只管理普通应用/网址/目录，不混入 Agent 会话。 */}
          {!standaloneMode && (
          <div className="picker-windows">
            <button className="link-btn" onClick={() => setAgentOpen((v) => !v)}>
              <AgentIcon size={11} /> {agentOpen ? "收起 Agent 会话" : "从 Agent 会话选择…"}
            </button>
            {agentOpen && (
              <div className="picker-window-list">
                {sessions.length === 0 && (
                  <div className="empty-hint">暂无已观测的 Agent 会话（需先有真实事件上报）</div>
                )}
                {sessions.slice(0, 12).map((s) => {
                  const key = `${s.source_id}:${s.external_id}`;
                  return (
                    <button
                      key={s.id}
                      className="picker-window-item"
                      disabled={!!busyKey}
                      onClick={() => pickAgentSession(s)}
                      title={`${s.source_id} · ${s.external_id}`}
                    >
                      <span className="picker-window-title">
                        {s.title || s.external_id}
                      </span>
                      <span className="picker-window-exe">
                        {busyKey === key ? "登记中…" : s.source_id}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          )}

          {/* 应用列表 */}
          <div className="picker-list" role="listbox" aria-label="已安装软件">
            {renderScanGate()}
            {scan !== null && (
              <>
                {renderScanNotices()}
                {renderScanSummary(apps.length)}
                {apps.length === 0 ? (
                  <div className="empty-hint">
                    {query.trim()
                      ? `没有匹配「${query.trim()}」的应用；可换个关键词，或手动添加`
                      : scanning
                        // 后续来源还在扫描：不能提前宣称「扫描完成」
                        ? "正在扫描，暂未发现可添加的应用…"
                        : scanPartial
                          ? "扫描未完成，暂未发现可添加的应用；可重试扫描"
                          : "扫描完成，未发现可添加的应用；可点「手动添加」登记任意 EXE / 网址 / 目录"}
                  </div>
                ) : (
                  <>
                    {visibleApps.map((a) => {
                      const linked = linkedKeys.has(a.app_key);
                      const running = runningApps.has(a.app_key);
                      return (
                        <button
                          key={a.app_key}
                          className={`picker-app ${linked ? "linked" : ""}`}
                          role="option"
                          aria-selected={linked}
                          disabled={!!busyKey}
                          onClick={() => pickDiscovered(a)}
                          title={a.exe_path || a.app_user_model_id}
                        >
                          <AppIcon appKey={a.app_key} name={a.display_name} size={26} />
                          <span className="picker-app-name">{a.display_name}</span>
                          <span className="picker-app-meta">
                            {linked && "已关联"}
                            {!linked && running && "已保存"}
                            {a.source === "uwp" && " · 商店"}
                          </span>
                        </button>
                      );
                    })}
                    {hasMore && (
                      <button
                        className="btn sm picker-more"
                        onClick={() => setVisibleCount((v) => v + APP_PAGE_SIZE)}
                      >
                        加载更多（已显示 {visibleApps.length} / {apps.length}）
                      </button>
                    )}
                  </>
                )}
              </>
            )}
          </div>

          {/* 手动添加 */}
          {manualOpen && (
            <ManualAddForm
              onSaved={async (t, msg) => {
                setManualOpen(false);
                const existed = targets.some(
                  (x) =>
                    x.target_type === t.target_type &&
                    x.app_key === t.app_key &&
                    (x.shortcut_kind ?? "app") === "app",
                );
                await afterPick(
                  t,
                  existed && !taskMode ? `「${t.display_name}」已在快捷列表中` : msg,
                  existed && !taskMode ? "info" : "success",
                );
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/** 手动登记：EXE / 网址 / 目录（后端逐项安全校验，非法输入直接报错）。 */
function ManualAddForm({
  onSaved,
}: {
  onSaved: (t: NavTarget, msg: string) => Promise<void> | void;
}) {
  const [kind, setKind] = useState<"application" | "url" | "directory">("application");
  const [value, setValue] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  async function save() {
    if (busy) return;
    setBusy(true);
    try {
      const input: TargetInput =
        kind === "application"
          ? { target_type: "application", display_name: name.trim() || value.split("\\").pop() || "应用", exe_path: value.trim() }
          : kind === "url"
            ? { target_type: "url", display_name: name.trim() || value.trim(), url: value.trim() }
            : { target_type: "directory", display_name: name.trim() || value.split("\\").pop() || "目录", path: value.trim() };
      const t = await navSaveTarget(input);
      await onSaved(t, `已添加并关联「${t.display_name}」`);
    } catch (e) {
      reportError(e, { operation: "添加应用目标" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="manual-add-form">
      <div className="seg-group subtle" role="group" aria-label="目标类型">
        <button className={`seg-btn ${kind === "application" ? "active" : ""}`} onClick={() => setKind("application")}>程序 EXE</button>
        <button className={`seg-btn ${kind === "url" ? "active" : ""}`} onClick={() => setKind("url")}>网址</button>
        <button className={`seg-btn ${kind === "directory" ? "active" : ""}`} onClick={() => setKind("directory")}>文件夹</button>
      </div>
      <input
        className="input sm"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={
          kind === "application"
            ? "C:\\Program Files\\App\\App.exe（绝对路径）"
            : kind === "url"
              ? "https://…（仅 http/https）"
              : "D:\\Projects\\my-project（绝对路径）"
        }
        aria-label="目标路径或网址"
      />
      <input
        className="input sm"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="显示名称（可选）"
        aria-label="显示名称"
      />
      <button className="btn sm primary" onClick={save} disabled={busy || !value.trim()}>
        {busy ? "校验中…" : "添加"}
      </button>
      <div className="endpoint-hint">解释器（cmd/PowerShell 等）与危险协议会被拒绝</div>
    </div>
  );
}
