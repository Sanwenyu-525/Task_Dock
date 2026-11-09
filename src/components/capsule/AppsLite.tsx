//! 应用面板（胶囊内，对照 `docs/design-refs/v07/停靠效果图/04-apps.png`）。
//!
//! 复用既有 `nav_list_targets` 缓存与 `nav_navigate`（窗口识别 / 启动 / 聚焦
//! 全在后端），胶囊内不实现第二套启动逻辑。
//!
//! 真实性约束：
//! - 列表只来自用户**已配置**的快捷目标，不预置微信 / Chrome / VS Code；
//! - 应用图标走统一的 `AppIcon`（后端按需提取 Windows 真实图标），
//!   网址/文件夹没有可执行文件，仍用「稳定色相 + 首字母」圆点；
//! - 搜索框做的是对已加载目标的本地过滤（真实可用），不是装饰；
//! - 启动失败如实提示后端返回的 `reason`，不显示「已启动」。

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Eye, LayoutGrid, Loader2, Plus, Power, Search, SquareX, Star, X } from "lucide-react";
import {
  navCloseTargetWindows, navDeleteTarget, navKillTargetProcesses, navNavigate,
  navQuitTargetProcesses, navTargetRunningStates, navUpdateTarget, avatarHue, resultMessage,
  type NavTarget,
} from "../../lib/navigation";
import { normalizeError } from "../../lib/errors";
import { searchApps, sortTargetsForDisplay } from "../../lib/appSearch";
import {
  buildAppGrid,
  filterAppGrid,
  moveAppGridBy,
  moveAppGridId,
  readAppGridOrder,
  writeAppGridOrder,
  type AppGridEntry,
} from "../../lib/appGridOrder";
import { onAppGridOrderApplied, schedulePreferencesMirror } from "../../lib/userPreferences";
import { clearTip, syncTruncatedTip } from "../../lib/nameTip";
import AppIcon from "../ui/AppIcon";
import { SearchField } from "../ui";
import { useNavigationStore } from "../../store/useNavigationStore";
import { openAppsAdd, openAppsManager } from "./actions";
import { EmptyState, PanelHead } from "./PanelKit";

/** 启动异常 → 可读原因：按稳定错误码区分权限/缺失/超时，不展示堆栈或原始路径。 */
function launchFailureReason(raw: unknown): string {
  const err = normalizeError(raw, "nav_navigate");
  switch (err.code) {
    case "PERMISSION_DENIED":
      return "没有权限启动该应用";
    case "NOT_FOUND":
      return "应用或窗口不存在";
    case "TIMEOUT":
      return "启动超时，请稍后重试";
    case "SERVICE_UNAVAILABLE":
    case "SERVICE_OVERLOADED":
      return "启动服务暂不可用，请稍后重试";
    default:
      return err.reason || err.message || "启动失败";
  }
}

export default function AppsLite() {
  const targets = useNavigationStore((s) => s.targets);
  const targetsLoaded = useNavigationStore((s) => s.targetsLoaded);
  const targetsError = useNavigationStore((s) => s.targetsError);
  const loadTargets = useNavigationStore((s) => s.loadTargets);
  const loadTaskLinks = useNavigationStore((s) => s.loadTaskLinks);
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  /** 启动中的目标 id 集合：与完整应用中心一致，每个目标各自表达状态，
      不再用单个 busyId 让「A 启动中」看起来像「B 也不能点」。 */
  const [launchingIds, setLaunchingIds] = useState<ReadonlySet<string>>(new Set());
  /** 同步锁：setState 到重渲染之间仍可能连点，用 ref 保证同一目标只发一次请求。 */
  const launchingRef = useRef<Set<string>>(new Set());
  /** 运行态快照（与完整应用中心同源命令）：驱动磁贴状态点与「运行中」快捷区。
      按需查询不轮询；查询失败保持旧值静默降级（无点无快捷区），不用错误打扰小面板。 */
  const [runningStates, setRunningStates] = useState<Record<string, string>>({});
  /** 关闭窗口的在途目标：与 launchingIds 同一套防重入纪律。 */
  const [closingIds, setClosingIds] = useState<ReadonlySet<string>>(new Set());
  const closingRef = useRef<Set<string>>(new Set());
  /** 请求退出（WM_QUIT）同一时刻只允许一个在途；记录在途目标，只给该 chip 显示忙碌态。 */
  const [quitId, setQuitId] = useState<string | null>(null);
  const quitRef = useRef(false);
  /** 退出应用不配合（WM_QUIT 被忽略）时的强制结束确认：破坏性动作必须先确认。 */
  const [pendingKill, setPendingKill] = useState<NavTarget | null>(null);
  const [killBusy, setKillBusy] = useState(false);
  /** 启动后的运行态补查定时器：卸载即清，非常驻轮询。 */
  const stateRecheckTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  /** 用户手动网格顺序（含加号伪 id）；null = 使用自然顺序。 */
  const [savedOrder, setSavedOrder] = useState<string[] | null>(() => readAppGridOrder());
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropHint, setDropHint] = useState<{ id: string; after: boolean } | null>(null);
  const dragIdRef = useRef<string | null>(null);
  /**
   * 拖放结束后浏览器可能补发一次 click。不能用「距上次 drop 的时间窗」判断：
   * 那会把拖完后立刻点击的**其他**应用也一起吞掉。真实点击一定先有 pointerdown
   * （键盘激活则是 keydown），补发的 click 两者都没有——用这个事实区分。
   */
  const suppressClickRef = useRef(false);
  /** 待确认删除的目标：胶囊窗口被 Win32 区域裁成 340×440，不能复用完整面板的浮层删除框，
      改为面板内确认条（同一套确认语义与后端删除命令）。 */
  const [pendingDelete, setPendingDelete] = useState<NavTarget | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  /** 恢复显示（隐藏 → 可见）：逐个按钮忙碌态；只改 hidden，不动名称/收藏/启动参数。 */
  const [restoreBusyId, setRestoreBusyId] = useState<string | null>(null);
  /** 后端删除成功但刷新失败时，本地先隐藏该项，避免旧缓存把「已删除」显示回来。 */
  const [removedIds, setRemovedIds] = useState<ReadonlySet<string>>(new Set());
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const deleteTriggerRef = useRef<HTMLButtonElement | null>(null);
  const restoreFocusRef = useRef(false);
  const hadPendingRef = useRef(false);
  const killCancelRef = useRef<HTMLButtonElement | null>(null);
  const killTriggerRef = useRef<HTMLButtonElement | null>(null);
  const restoreKillFocusRef = useRef(false);
  const hadKillRef = useRef(false);
  // 单条反馈只保留一个计时器：新反馈覆盖旧反馈时先取消旧计时器，
  // 自然结束后置空，避免连续启动/失败把已结束的 ID 一直累积。
  const noticeTimer = useRef<number | null>(null);

  // 按需加载（不轮询、不每次 render 请求）：未加载时补一次；
  // 已加载时复用共享 Store，跨入口的增删/隐藏/恢复都已在写入处刷新，
  // 重新打开胶囊不会重复请求。刷新失败保留旧数据并由重试按钮显式触发。
  // 失败不自动重发：避免 targetsError 变化触发循环请求。
  useEffect(() => {
    if (!targetsLoaded) void loadTargets();
  }, [targetsLoaded, loadTargets]);

  useEffect(() => {
    return () => {
      if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
      noticeTimer.current = null;
      for (const t of stateRecheckTimers.current) window.clearTimeout(t);
      stateRecheckTimers.current = [];
    };
  }, []);

  // 备份恢复会替换 localStorage 中的网格顺序：已挂载的面板同步重读，
  // 不必重启应用。订阅在卸载时解除，不产生常驻监听。
  useEffect(
    () =>
      onAppGridOrderApplied(() => {
        setSavedOrder(readAppGridOrder());
      }),
    [],
  );

  // 确认条打开时焦点落在「取消」；取消关闭后还给触发删除的按钮。
  // 删除成功时触发按钮已随列表移除，不再抢焦点。
  useEffect(() => {
    if (pendingDelete) {
      hadPendingRef.current = true;
      cancelRef.current?.focus();
    } else if (hadPendingRef.current) {
      hadPendingRef.current = false;
      if (restoreFocusRef.current) {
        restoreFocusRef.current = false;
        deleteTriggerRef.current?.focus();
      }
    }
  }, [pendingDelete]);

  // 强制结束确认条同一套焦点规则：打开落在「取消」，取消后还给触发退出的按钮。
  useEffect(() => {
    if (pendingKill) {
      hadKillRef.current = true;
      killCancelRef.current?.focus();
    } else if (hadKillRef.current) {
      hadKillRef.current = false;
      if (restoreKillFocusRef.current) {
        restoreKillFocusRef.current = false;
        killTriggerRef.current?.focus();
      }
    }
  }, [pendingKill]);

  const flash = (msg: string) => {
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    setNotice(msg);
    noticeTimer.current = window.setTimeout(() => {
      setNotice((n) => (n === msg ? null : n));
      noticeTimer.current = null;
    }, 2600);
  };

  // 只展示普通应用快捷方式：网址/文件夹单独分区，Agent 会话不进入应用网格。
  const visible = useMemo(
    () => targets.filter(
      (t) => !t.hidden && t.target_type === "application" && !removedIds.has(t.id),
    ),
    [targets, removedIds],
  );

  const extras = useMemo(
    () =>
      targets.filter(
        (t) =>
          !t.hidden &&
          !removedIds.has(t.id) &&
          (t.target_type === "url" || t.target_type === "directory" || t.target_type === "file"),
      ),
    [targets, removedIds],
  );

  // 默认顺序沿用应用中心的规则：收藏优先 → 最近使用 → 名称。
  // `last_used_at` / `use_count` 仍来自后端真实计数，这里只做展示排序。
  const ranked = useMemo(() => sortTargetsForDisplay(visible), [visible]);

  const rankedExtras = useMemo(
    () => sortTargetsForDisplay(extras, { recent: false }),
    [extras],
  );

  // 与选择器/应用中心共用同一套搜索规则（中文连续子串、英文大小写、身份绑定别名），
  // 数据范围是「已配置集合」，不是扫描到的全部应用。应用与网址/文件夹都参与搜索，
  // 不再在展示层截断——完整列表由固定高度的内容区滚动承载。
  const filtered = useMemo(() => {
    const q = query.trim();
    if (!q) return { apps: ranked, extras: rankedExtras };
    const filter = (list: NavTarget[]) => {
      const byId = new Map(list.map((t) => [t.id, t]));
      return searchApps(
        list.map((t) => ({
          key: t.id,
          displayName: t.display_name,
          category: t.category,
          exePath: t.exe_path || t.url || t.path,
          identity: t.app_key,
        })),
        q,
      )
        .map((s) => byId.get(s.key))
        .filter((t): t is NavTarget => !!t);
    };
    // 应用网格保持用户手动顺序（未手动排序时就是自然顺序），搜索只过滤不重排；
    // 网址/文件夹没有手动排序语义，仍按收藏 → 名称。
    return {
      apps: filter(ranked),
      extras: sortTargetsForDisplay(filter(rankedExtras), { recent: false }),
    };
  }, [ranked, rankedExtras, query]);

  const extraList = filtered.extras;

  /** 完整网格（所有应用 + 加号），手动顺序在此生效。 */
  const fullGrid = useMemo(
    () => buildAppGrid(ranked, savedOrder),
    [ranked, savedOrder],
  );
  /**
   * 置顶规则（2026-11-09 用户反馈，按优先级）：
   * 1）收藏应用**最前**：收藏是用户显式选择，不能被运行中分组挤到后面；
   * 2）运行中的应用（有窗口或仅后台进程）其次：点击后不再因「最近使用」冒泡沉底；
   * 3）其余保持原顺序（自然顺序或用户手动顺序），加号仍在末尾。
   * 组内沿用当前顺序（手动排序时即手动顺序）；只改展示顺序，不改后端数据与
   * 手动排序本身。
   */
  const displayGrid = useMemo(() => {
    const isRunning = (t: NavTarget) =>
      runningStates[t.id] === "has_window" || runningStates[t.id] === "process_only";
    const apps = fullGrid.filter(
      (entry): entry is Extract<AppGridEntry<NavTarget>, { type: "app" }> => entry.type === "app",
    );
    const favorites = apps.filter((entry) => entry.app.favorite);
    const running = apps.filter((entry) => !entry.app.favorite && isRunning(entry.app));
    const rest = apps.filter((entry) => !entry.app.favorite && !isRunning(entry.app));
    // 没有收藏也没有运行中：保持完整网格原样（含手动顺序与加号位置）
    if (favorites.length === 0 && running.length === 0) return fullGrid;
    const add = fullGrid.filter((entry) => entry.type === "add");
    return [...favorites, ...running, ...rest, ...add];
  }, [fullGrid, runningStates]);
  const fullOrder = useMemo(() => displayGrid.map((entry) => entry.id), [displayGrid]);
  /** 搜索命中的应用 id；null = 不过滤。 */
  const matchedIds = useMemo(
    () => (query.trim() ? new Set(filtered.apps.map((t) => t.id)) : null),
    [filtered.apps, query],
  );
  // 加号跟随它前面仍匹配的应用：前面的项被过滤掉时自然前移，不固定跳到末尾。
  const gridEntries = useMemo(
    () => filterAppGrid(displayGrid, matchedIds),
    [displayGrid, matchedIds],
  );

  /** 运行态快照查询：与完整应用中心同一命令、同一口径（后端按 exe 身份 +
      祖先链判定），面板打开时查一次，启动/关闭/退出后刷新。
      返回本次快照：关闭/退出后的结果文案要用最新状态判断「是否仍在后台运行」。 */
  const fetchRunningStates = useCallback(async (): Promise<Record<string, string>> => {
    const ids = visible.filter((t) => t.target_type === "application").map((t) => t.id);
    if (ids.length === 0) {
      setRunningStates({});
      return {};
    }
    try {
      const states = await navTargetRunningStates(ids);
      setRunningStates(states);
      return states;
    } catch {
      // 小面板不弹错误：状态属于增强信息，失败时保持旧值（无点无快捷区）。
      return {};
    }
  }, [visible]);

  // 面板挂载查一次运行态（targetsLoaded 后 visible 才有意义；已加载时立即可查）。
  useEffect(() => {
    if (targetsLoaded) void fetchRunningStates();
  }, [targetsLoaded, fetchRunningStates]);

  // 面板展开期间每 10s 刷新一次运行态：托盘驻留应用在外部被频繁开关，
  // 只靠挂载时查一次会越放越陈旧（对不上系统托盘）。单一定时器、卸载即清
  // （面板收起即卸载），不产生重复轮询，也不在面板关闭后继续跑。
  useEffect(() => {
    const timer = setInterval(() => {
      void fetchRunningStates();
    }, 10_000);
    return () => clearInterval(timer);
  }, [fetchRunningStates]);

  /** 慢启动补查：后端启动确认最多等 5s，酷狗类应用窗口常晚于返回出现，
      2.5s / 6s 两次单发补查让状态点与「运行中」区跟上真实情况。 */
  const scheduleStateRecheck = useCallback(() => {
    for (const delay of [2500, 6000]) {
      const timer = setTimeout(() => {
        stateRecheckTimers.current = stateRecheckTimers.current.filter((x) => x !== timer);
        void fetchRunningStates();
      }, delay);
      stateRecheckTimers.current.push(timer);
    }
  }, [fetchRunningStates]);

  /** 启动状态按 id 记录：不同应用互不阻塞，同一应用在途时忽略重复请求。 */
  const markLaunching = (id: string, on: boolean) => {
    const next = new Set(launchingRef.current);
    if (on) next.add(id);
    else next.delete(id);
    launchingRef.current = next;
    setLaunchingIds(next);
  };

  const markClosing = (id: string, on: boolean) => {
    const next = new Set(closingRef.current);
    if (on) next.add(id);
    else next.delete(id);
    closingRef.current = next;
    setClosingIds(next);
  };

  const launch = async (id: string, name: string) => {
    // 同一目标在途：忽略重复请求（按钮此时已禁用，这里兜住 setState 前的连点）。
    // 其他目标不受影响：后端每次导航是独立的 spawn_blocking 任务，没有全局串行锁，
    // 因此不需要像单槽位 busyId 那样把整组应用一起锁住。
    if (launchingRef.current.has(id)) return;
    markLaunching(id, true);
    try {
      const res = await navNavigate(id);
      // 与完整面板共用同一结果解释：请求启动 ≠ 已确认启动，请求聚焦 ≠ 已获得焦点，
      // 后端只报 requested-unverified 时如实显示「未核实」，不自行判成功。
      flash(resultMessage(res, name));
      if (res.success) {
        // 成功后刷新共享目标，让网格的「最近使用优先」排序反映真实后端计数。
        // 刷新失败只影响排序展示，不能把已成功的启动说成失败（错误由共享 store 记录）。
        void loadTargets(true);
        // 启动请求返回时后端通常已确认窗口/进程：立即补查一次，绿点不必等到
        // 2.5s 的慢启动补查才出现；窗口晚于返回出现的情况仍由定时补查兜住。
        void fetchRunningStates();
        // 窗口可能晚于启动返回出现：补查让状态点与「运行中」区跟上真实状态。
        scheduleStateRecheck();
      }
    } catch (e) {
      flash(`${name}：${launchFailureReason(e)}`);
    } finally {
      markLaunching(id, false);
    }
  };

  // 「没有配置」与「读取失败」必须分开：targetsError 存在时绝不把旧清单/空清单
  // 伪装成「尚未配置快捷应用」。读取失败且从未成功 → 错误空态（可重试）；
  // 失败但已有旧清单 → 旧清单保留 + 错误提示条。
  // 已隐藏目标仍在权威数据内（list 时 include_hidden=true），这里按原始 targets
  // 计数区分「从未配置 / 全部隐藏 / 仅 Agent 会话」，绝不自动取消隐藏。
  const hiddenRelevant = useMemo(
    () =>
      targets.filter(
        (t) =>
          t.hidden &&
          !removedIds.has(t.id) &&
          (t.target_type === "application" ||
            t.target_type === "url" ||
            t.target_type === "file" ||
            t.target_type === "directory"),
      ),
    [targets, removedIds],
  );
  const loadError = targetsError !== null;
  const isLoading = !targetsLoaded && !loadError;
  /** 隐藏项按类型拆分：文案必须说清隐藏的是应用还是网址/文件夹/文件，
      不能把「网址全隐藏」误报成「应用均处于隐藏状态」。 */
  const hiddenApps = useMemo(
    () => hiddenRelevant.filter((t) => t.target_type === "application"),
    [hiddenRelevant],
  );
  const hiddenAuxCount = hiddenRelevant.length - hiddenApps.length;
  const hiddenSummary =
    hiddenApps.length > 0 && hiddenAuxCount === 0
      ? "已添加的应用均处于隐藏状态"
      : hiddenApps.length === 0
        ? "已添加的网址 / 文件夹 / 文件均处于隐藏状态"
        : "已添加的快捷目标均处于隐藏状态";
  const hasAgentOnly = useMemo(
    () =>
      targetsLoaded &&
      !loadError &&
      ranked.length === 0 &&
      extras.length === 0 &&
      hiddenRelevant.length === 0 &&
      targets.some((t) => !removedIds.has(t.id) && t.target_type === "agent_session"),
    [targetsLoaded, loadError, ranked.length, extras.length, hiddenRelevant.length, targets, removedIds],
  );
  const allHidden = targetsLoaded && !loadError && ranked.length === 0 && extras.length === 0 && hiddenRelevant.length > 0;
  const neverConfigured = targetsLoaded && !loadError && ranked.length === 0 && extras.length === 0 && hiddenRelevant.length === 0 && !hasAgentOnly;
  const loadFailedFresh = loadError && !targetsLoaded;
  const loadFailedStale = loadError && targetsLoaded;

  const requestDelete = (t: NavTarget, trigger: HTMLButtonElement) => {
    if (deleteBusy || launchingRef.current.has(t.id)) return;
    deleteTriggerRef.current = trigger;
    restoreFocusRef.current = false;
    // 删除与强制结束是两个破坏性确认，同一时刻只保留一个。
    setPendingKill(null);
    setPendingDelete(t);
  };

  const cancelDelete = () => {
    if (deleteBusy) return;
    restoreFocusRef.current = true;
    setPendingDelete(null);
  };

  const confirmDelete = async () => {
    if (!pendingDelete || deleteBusy) return;
    const target = pendingDelete;
    setDeleteBusy(true);
    try {
      await navDeleteTarget(target.id);
    } catch (e) {
      const err = normalizeError(e, "nav_delete_target");
      if (err.code === "NOT_FOUND") {
        // 目标已被其他入口删除：等价于删除完成，刷新共享列表并如实提示。
        setRemovedIds((prev) => new Set(prev).add(target.id));
        setPendingDelete(null);
        const [tOutcome, lOutcome] = await Promise.all([loadTargets(true), loadTaskLinks()]);
        if (tOutcome === "ok" && lOutcome === "ok") setRemovedIds(new Set());
        flash(tOutcome === "error" || lOutcome === "error"
          ? "该快捷目标已不存在，但列表刷新失败"
          : "该快捷目标已不存在，列表已刷新");
      } else {
        // 删除失败必须保留应用项，不把配置从列表里误删。
        flash(`删除失败：${err.reason || err.message || "未知错误"}`);
      }
      setDeleteBusy(false);
      return;
    }
    // 删除已成功：先本地隐藏，刷新失败也不回退成「删除失败」。
    setRemovedIds((prev) => new Set(prev).add(target.id));
    setPendingDelete(null);
    const [tOutcome, lOutcome] = await Promise.all([loadTargets(true), loadTaskLinks()]);
    if (tOutcome === "ok" && lOutcome === "ok") setRemovedIds(new Set());
    flash(tOutcome === "error" || lOutcome === "error"
      ? "目标已删除，但列表刷新失败"
      : "目标已删除");
    setDeleteBusy(false);
  };

  /** 隐藏项恢复显示：只改 hidden，不触碰名称/收藏/启动参数；失败保留原隐藏态。 */
  const restoreHiddenItem = async (t: NavTarget) => {
    if (restoreBusyId) return;
    setRestoreBusyId(t.id);
    try {
      await navUpdateTarget(t.id, { hidden: false });
      const outcome = await loadTargets(true);
      flash(outcome === "error" ? "已恢复显示，但列表刷新失败" : `已恢复显示「${t.display_name}」`);
    } catch (e) {
      const err = normalizeError(e, "nav_update_target");
      flash(`恢复显示失败：${err.reason || err.message || "未知错误"}`);
    } finally {
      setRestoreBusyId(null);
    }
  };

  /** 优雅关闭该应用的全部顶层窗口（WM_CLOSE）：与完整面板卡片按钮同一命令；
      应用弹「是否保存」时窗口仍在，按结果如实提示。托盘类应用把关闭实现为
      隐藏到托盘：后端按「句柄消失或转为不可见」判成功，这里补一句仍在后台运行，
      避免用户以为关闭没生效。 */
  const closeWindow = async (t: NavTarget) => {
    if (closingRef.current.has(t.id)) return;
    markClosing(t.id, true);
    // 先给即时反馈：后端核实窗口消失最长要等 2s，这段时间不能像什么都没发生。
    flash(`正在关闭「${t.display_name}」的窗口…`);
    try {
      const r = await navCloseTargetWindows(t.id);
      const states = await fetchRunningStates();
      if (r.requested === 0) {
        flash(`「${t.display_name}」当前没有打开的窗口`);
      } else if (r.stillOpen.length > 0) {
        flash(`「${t.display_name}」还有 ${r.stillOpen.length} 个窗口未关闭（可能等待确认或需要权限）`);
      } else if (states[t.id] === "process_only") {
        flash(`已关闭「${t.display_name}」的窗口（应用仍在后台运行）`);
      } else {
        flash(`已关闭「${t.display_name}」的 ${r.closed} 个窗口`);
      }
    } catch (e) {
      const err = normalizeError(e, "nav_close_target_windows");
      flash(`关闭「${t.display_name}」的窗口失败：${err.reason || err.message || "未知错误"}`);
    } finally {
      markClosing(t.id, false);
    }
  };

  /** 请求应用自行退出（向其线程投递 WM_QUIT，等价托盘「退出」）：应用走自己的
      保存/清理/移除托盘路径。不配合的（部分托盘/Electron 应用忽略 WM_QUIT）
      如实报未完全退出，并直接给出「强制结束」确认入口——否则小面板里没有
      任何能把应用真正关掉的办法。 */
  const quitApp = async (t: NavTarget, trigger?: HTMLButtonElement) => {
    if (quitRef.current) return;
    quitRef.current = true;
    setQuitId(t.id);
    flash(`正在退出「${t.display_name}」…`);
    try {
      const r = await navQuitTargetProcesses(t.id);
      await fetchRunningStates();
      if (r.processTotal === 0) {
        flash(`「${t.display_name}」当前没有在运行的进程`);
      } else if (r.processExited < r.processTotal) {
        flash(`「${t.display_name}」未完全退出（${r.processExited}/${r.processTotal}）`);
        // 应用不响应 WM_QUIT：提供破坏性但可控的收尾手段，必须经确认条。
        killTriggerRef.current = trigger ?? null;
        restoreKillFocusRef.current = false;
        setPendingDelete(null);
        setPendingKill(t);
      } else {
        flash(`已退出「${t.display_name}」`);
      }
    } catch (e) {
      const err = normalizeError(e, "nav_quit_target_processes");
      flash(`退出「${t.display_name}」失败：${err.reason || err.message || "未知错误"}`);
    } finally {
      quitRef.current = false;
      setQuitId(null);
    }
  };

  const cancelKill = () => {
    if (killBusy) return;
    restoreKillFocusRef.current = true;
    setPendingKill(null);
  };

  /** 强制结束进程（TerminateProcess）：破坏性动作，只在确认条确认后执行；
      结果如实区分「已结束 / 无权限或已退出 / 没有可结束的进程」。 */
  const confirmKill = async () => {
    if (!pendingKill || killBusy) return;
    const target = pendingKill;
    setKillBusy(true);
    try {
      const r = await navKillTargetProcesses(target.id);
      if (r.matched === 0) {
        flash(`「${target.display_name}」当前没有可结束的进程`);
      } else if (r.killed < r.matched) {
        flash(`已结束「${target.display_name}」的 ${r.killed}/${r.matched} 个进程，其余无权限或已退出`);
      } else {
        flash(`已强制结束「${target.display_name}」的 ${r.killed} 个进程`);
      }
      await fetchRunningStates();
    } catch (e) {
      const err = normalizeError(e, "nav_kill_target_processes");
      flash(`强制结束「${target.display_name}」失败：${err.reason || err.message || "未知错误"}`);
    } finally {
      setKillBusy(false);
      setPendingKill(null);
    }
  };

  /** 运行中的应用（has_window 或仅后台进程）：驱动磁贴状态点与「运行中」快捷区。
      只认真实快照，unavailable（配置失效）不算运行中。 */
  const runningApps = useMemo(
    () =>
      visible.filter(
        (t) => runningStates[t.id] === "has_window" || runningStates[t.id] === "process_only",
      ),
    [visible, runningStates],
  );

  // ── 网格排序（应用 + 加号共用）──────────────────────────────
  // 只用原生 HTML5 拖放与键盘移动，不引入拖拽库，也不把加号做成绝对定位浮层。
  const commitOrder = (next: string[]) => {
    if (next.length === 0) return;
    writeAppGridOrder(next);
    setSavedOrder(next);
    // 排序属于用户偏好：防抖镜像到 preferences.json，随完整/快速备份迁移。
    schedulePreferencesMirror();
    flash("顺序已保存");
  };

  const isDropAfter = (event: ReactDragEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return event.clientX > rect.left + rect.width / 2;
  };

  const onDragStart = (event: ReactDragEvent<HTMLElement>, id: string) => {
    dragIdRef.current = id;
    setDragId(id);
    // 新一轮拖拽开始：清掉上一轮可能残留的「补发 click」防护。
    suppressClickRef.current = false;
    event.dataTransfer.effectAllowed = "move";
    // Firefox/WebView 需要 setData 才会真正开始拖拽；内容本身不参与业务。
    event.dataTransfer.setData("text/plain", id);
  };

  const onDragOver = (event: ReactDragEvent<HTMLElement>, id: string) => {
    const dragged = dragIdRef.current;
    if (!dragged || dragged === id) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const after = isDropAfter(event);
    setDropHint((prev) =>
      prev?.id === id && prev.after === after ? prev : { id, after },
    );
  };

  const endDrag = () => {
    dragIdRef.current = null;
    setDragId(null);
    setDropHint(null);
    // 拖拽结束（含取消）：浏览器可能补发一次 click，它没有新的 pointerdown。
    // 置位不会影响真实点击——真实点击的 pointerdown 会先把标记清掉。
    suppressClickRef.current = true;
  };

  const onDrop = (event: ReactDragEvent<HTMLElement>, targetId: string) => {
    const dragged = dragIdRef.current;
    if (!dragged || dragged === targetId) {
      endDrag();
      return;
    }
    event.preventDefault();
    const after = isDropAfter(event);
    commitOrder(moveAppGridId(fullOrder, dragged, targetId, after));
    endDrag();
  };

  /**
   * 拖放后浏览器补发的 click：没有新的 pointerdown（键盘激活也没有 keydown）。
   * 只有这种情况忽略一次；真实点击/键盘激活会先清掉标记，因此拖完立刻点其他应用
   * 或加号都能正常生效，不需要再移动一次鼠标。
   */
  const shouldIgnoreClick = () => {
    if (!suppressClickRef.current) return false;
    suppressClickRef.current = false;
    return true;
  };

  const onOrderKeyDown = (event: ReactKeyboardEvent<HTMLElement>, id: string) => {
    if (!event.altKey) return;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const next = moveAppGridBy(fullOrder, id, event.key === "ArrowLeft" ? -1 : 1);
    if (next.every((value, index) => value === fullOrder[index])) return;
    commitOrder(next);
  };

  const dropClass = (id: string) => {
    if (dropHint?.id !== id) return "";
    return dropHint.after ? "is-drop-after" : "is-drop-before";
  };

  return (
    <>
      <PanelHead title="应用" sub="常用应用 · 快捷启动与窗口切换" layout="inline" />

      <SearchField
        value={query}
        onChange={setQuery}
        placeholder="搜索已配置的快捷应用…"
        ariaLabel="搜索快捷应用"
        clearLabel="清除应用搜索"
        size="compact"
        className="cap-search ui-search--capsule"
      />

      {pendingDelete && (
        <div className="cap-confirm" role="alertdialog" aria-label="确认删除快捷目标">
          <p className="cap-confirm-text">
            从快捷列表删除「{pendingDelete.display_name}」？
            <span>只删除 task_dock 中的快捷目标，不会卸载应用或删除程序文件；相关任务关联会一并解除。</span>
          </p>
          <div className="cap-confirm-actions">
            <button
              ref={cancelRef}
              type="button"
              className="cap-mini"
              onClick={cancelDelete}
              disabled={deleteBusy}
            >
              取消
            </button>
            <button
              type="button"
              className="cap-mini cap-confirm-danger"
              onClick={() => void confirmDelete()}
              disabled={deleteBusy || launchingIds.has(pendingDelete.id)}
            >
              删除
            </button>
          </div>
        </div>
      )}

      {pendingKill && (
        <div className="cap-confirm" role="alertdialog" aria-label="确认强制结束应用进程">
          <p className="cap-confirm-text">
            强制结束「{pendingKill.display_name}」？
            <span>将结束该应用的全部进程（含托盘/后台），不走应用自身的保存流程，未保存的数据会丢失。</span>
          </p>
          <div className="cap-confirm-actions">
            <button
              ref={killCancelRef}
              type="button"
              className="cap-mini"
              onClick={cancelKill}
              disabled={killBusy}
            >
              取消
            </button>
            <button
              type="button"
              className="cap-mini cap-confirm-danger"
              onClick={() => void confirmKill()}
              disabled={killBusy}
            >
              强制结束
            </button>
          </div>
        </div>
      )}

      <div className="cap-list cap-list--apps">
        {isLoading && (
          <EmptyState
            icon={<Loader2 size={22} strokeWidth={1.6} className="spin" aria-hidden="true" />}
            text="正在读取快捷应用…"
          />
        )}

        {loadFailedFresh && (
          <EmptyState
            icon={<LayoutGrid size={22} strokeWidth={1.6} aria-hidden="true" />}
            text="快捷应用读取失败"
            actionLabel="重试"
            onAction={() => void loadTargets()}
          />
        )}

        {loadFailedStale && (
          <div className="cap-item cap-error-row" role="alert">
            <span className="cap-error-text">刷新失败，显示的是上次结果</span>
            <button type="button" className="cap-mini" aria-label="重试读取快捷应用" onClick={() => void loadTargets()}>
              重试
            </button>
          </div>
        )}

        {neverConfigured && !query.trim() && (
          <EmptyState
            icon={<LayoutGrid size={22} strokeWidth={1.6} aria-hidden="true" />}
            text="尚未配置快捷应用"
            actionLabel="添加应用"
            onAction={() => openAppsAdd()}
            className="cap-empty--centered"
          />
        )}

        {allHidden && !query.trim() && (
          <>
            <EmptyState
              icon={<Eye size={22} strokeWidth={1.6} aria-hidden="true" />}
              // 文案按真实隐藏对象区分：网址/文件夹被隐藏时不能说成「应用均隐藏」。
              text={hiddenSummary}
              // 网格整体收起时加号也随之消失，这里保留同一个添加入口（不是第二套流程）。
              actionLabel="添加应用"
              onAction={() => openAppsAdd()}
            />
            <div className="cap-recent" data-testid="hidden-restore-list">
              <span className="cap-recent-title">已隐藏（共 {hiddenRelevant.length}）</span>
              <span className="cap-recent-list">
                {hiddenRelevant.map((t) => (
                  <button
                    type="button"
                    key={t.id}
                    className="cap-recent-chip"
                    aria-label={`恢复显示 ${t.display_name}`}
                    disabled={restoreBusyId === t.id}
                    onClick={() => void restoreHiddenItem(t)}
                  >
                    <i
                      className="cap-recent-dot"
                      style={{ "--app-hue": String(avatarHue(t.app_key || t.display_name)) } as CSSProperties}
                      aria-hidden="true"
                    >
                      {(t.display_name || "?").slice(0, 1).toUpperCase()}
                    </i>
                    <span>{t.display_name}</span>
                    <span>{restoreBusyId === t.id ? "恢复中…" : "恢复显示"}</span>
                  </button>
                ))}
              </span>
            </div>
          </>
        )}

        {hasAgentOnly && !query.trim() && (
          <EmptyState
            icon={<LayoutGrid size={22} strokeWidth={1.6} aria-hidden="true" />}
            text="Agent 会话在 Agent 面板中管理"
          />
        )}

        {targetsLoaded && !loadFailedFresh && !neverConfigured && !allHidden && !hasAgentOnly && (
          <div
            className="cap-app-grid"
            aria-label="应用网格，拖动或在项目上按 Alt+左右方向键调整顺序"
            // 真实按下 / 键盘激活会先经过捕获阶段，清掉拖放后的「补发 click」防护。
            onPointerDownCapture={() => {
              suppressClickRef.current = false;
            }}
            onKeyDownCapture={() => {
              suppressClickRef.current = false;
            }}
          >
            {gridEntries.map((entry) => {
              if (entry.type === "add") {
                return (
                  <button
                    key={entry.id}
                    type="button"
                    data-grid-id={entry.id}
                    className={`cap-app cap-app-add ${dragId === entry.id ? "is-dragging" : ""} ${dropClass(entry.id)}`}
                    aria-label="添加应用"
                    draggable
                    onDragStart={(e) => onDragStart(e, entry.id)}
                    onDragEnd={endDrag}
                    onDragOver={(e) => onDragOver(e, entry.id)}
                    onDragLeave={(e) => {
                      const related = e.relatedTarget;
                      if (related instanceof Node && e.currentTarget.contains(related)) return;
                      setDropHint((hint) => (hint?.id === entry.id ? null : hint));
                    }}
                    onDrop={(e) => onDrop(e, entry.id)}
                    onKeyDown={(e) => onOrderKeyDown(e, entry.id)}
                    onClick={() => {
                      if (shouldIgnoreClick()) return;
                      openAppsAdd();
                    }}
                  >
                    <span className="cap-app-avatar is-add" aria-hidden="true">
                      <Plus size={18} strokeWidth={2.4} />
                    </span>
                    <span className="cap-app-name">添加</span>
                  </button>
                );
              }
              const t = entry.app;
              const busy = launchingIds.has(t.id);
              const running = runningStates[t.id];
              const hasWindow = running === "has_window";
              const isRunning = hasWindow || running === "process_only";
              return (
                <div
                  key={t.id}
                  data-grid-id={t.id}
                  className={`cap-app-slot ${dragId === t.id ? "is-dragging" : ""} ${dropClass(t.id)} ${isRunning ? "has-actions" : ""}`}
                  onDragOver={(e) => onDragOver(e, t.id)}
                  onDragLeave={(e) => {
                    const related = e.relatedTarget;
                    if (related instanceof Node && e.currentTarget.contains(related)) return;
                    setDropHint((hint) => (hint?.id === t.id ? null : hint));
                  }}
                  onDrop={(e) => onDrop(e, t.id)}
                >
                  <button
                    type="button"
                    data-grid-id={t.id}
                    className="cap-app"
                    aria-label={`启动 ${t.display_name}`}
                    aria-busy={busy}
                    disabled={busy}
                    draggable={!busy}
                    onDragStart={(e) => onDragStart(e, t.id)}
                    onDragEnd={endDrag}
                    onKeyDown={(e) => onOrderKeyDown(e, t.id)}
                    onClick={() => {
                      if (shouldIgnoreClick()) return;
                      void launch(t.id, t.display_name);
                    }}
                    // 只有名称真的被两行 clamp 截断时才挂提示：完整显示时不再弹同名浮层，
                    // 避免提示条压住相邻磁贴；路径不作为名称提示。
                    onMouseEnter={(e) => {
                      if (!busy) syncTruncatedTip(e.currentTarget, ".cap-app-name", t.display_name);
                    }}
                    onMouseLeave={(e) => clearTip(e.currentTarget)}
                    onFocus={(e) => {
                      if (!busy) syncTruncatedTip(e.currentTarget, ".cap-app-name", t.display_name);
                    }}
                    onBlur={(e) => clearTip(e.currentTarget)}
                  >
                    <span className="cap-app-icon">
                      <AppIcon targetId={t.id} name={t.display_name} size={34} />
                      {/* 收藏角标：与右下运行状态点同一套角标语言（绝对定位、不占布局），
                          放在图标左上角，避免和运行中的绿色圆点混淆。 */}
                      {t.favorite && (
                        <Star
                          size={11}
                          strokeWidth={0}
                          className="cap-app-fav"
                          fill="currentColor"
                          aria-hidden="true"
                        />
                      )}
                      {/* 运行状态点与「运行中」快捷区、运行中置顶、完整面板徽标
                          同一口径：有窗口或仅有后台进程（托盘驻留）都算运行中。
                          只显示 has_window 会让托盘应用看起来「打开了却没有绿点」。 */}
                      {(runningStates[t.id] === "has_window" ||
                        runningStates[t.id] === "process_only") && (
                        <i className="cap-app-dot" aria-hidden="true" />
                      )}
                      {busy && (
                        <Loader2
                          size={17}
                          strokeWidth={2.2}
                          className="spin cap-app-spinner"
                          aria-hidden="true"
                        />
                      )}
                    </span>
                    <span className="cap-app-name">{t.display_name}</span>
                  </button>
                  {/* 运行中磁贴：名称区一条动作条（关闭窗口 / 退出应用），
                      悬停/键盘聚焦时名称淡出、动作条淡入；与「运行中」区同一套
                      命令与反馈，仅后台进程没有窗口可关。未运行磁贴不渲染动作条，
                      名称与角落删除保持原样。 */}
                  {isRunning && (
                    <div className="cap-app-actions">
                      {hasWindow && (
                        <button
                          type="button"
                          className="cap-app-act"
                          data-tip="关闭窗口"
                          aria-label={`关闭 ${t.display_name} 的窗口`}
                          disabled={busy || closingIds.has(t.id)}
                          onClick={() => void closeWindow(t)}
                        >
                          {closingIds.has(t.id) ? (
                            <Loader2 size={13} className="spin" aria-hidden="true" />
                          ) : (
                            <SquareX size={13} aria-hidden="true" />
                          )}
                        </button>
                      )}
                      <button
                        type="button"
                        className="cap-app-act"
                        data-tip="退出应用"
                        aria-label={`退出 ${t.display_name}`}
                        disabled={busy || quitId !== null}
                        onClick={(e) => void quitApp(t, e.currentTarget)}
                      >
                        {quitId === t.id ? (
                          <Loader2 size={13} className="spin" aria-hidden="true" />
                        ) : (
                          <Power size={13} aria-hidden="true" />
                        )}
                      </button>
                    </div>
                  )}
                  {/* 删除是启动的并列兄弟按钮，绝不嵌套在启动按钮内。
                      列表管理动作固定在磁贴右上角，与运行态动作条分开。 */}
                  <button
                    type="button"
                    className="cap-app-del"
                    aria-label={`从快捷列表删除 ${t.display_name}`}
                    disabled={busy}
                    onClick={(e) => requestDelete(t, e.currentTarget)}
                  >
                    <X size={12} aria-hidden="true" />
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {/* 运行中快捷区：关闭窗口（优雅）、退出应用（WM_QUIT）一键直达；
            退出不配合时在同一面板给出「强制结束」确认条（破坏性动作，必须确认），
            不再要求跳到完整面板才能把应用真正关掉。 */}
        {targetsLoaded && !loadFailedFresh && runningApps.length > 0 && (
          <div className="cap-recent" data-testid="running-list">
            <span className="cap-recent-title">运行中（{runningApps.length}）</span>
            <span className="cap-recent-list cap-run-list">
              {runningApps.map((t) => {
                const hasWindow = runningStates[t.id] === "has_window";
                return (
                  <span key={t.id} className="cap-recent-chip cap-run-chip">
                    <button
                      type="button"
                      className="cap-run-main"
                      aria-label={`启动或聚焦 ${t.display_name}`}
                      disabled={launchingIds.has(t.id)}
                      onClick={() => void launch(t.id, t.display_name)}
                    >
                      <AppIcon targetId={t.id} name={t.display_name} size={16} />
                      <span className="cap-run-name">{t.display_name}</span>
                    </button>
                    {hasWindow && (
                      <button
                        type="button"
                        className="cap-chip-btn"
                        data-tip="关闭窗口"
                        aria-label={`关闭 ${t.display_name} 的窗口`}
                        disabled={closingIds.has(t.id)}
                        onClick={() => void closeWindow(t)}
                      >
                        {closingIds.has(t.id) ? (
                          <Loader2 size={12} className="spin" aria-hidden="true" />
                        ) : (
                          <SquareX size={12} aria-hidden="true" />
                        )}
                      </button>
                    )}
                    <button
                      type="button"
                      className="cap-chip-btn"
                      data-tip="退出应用"
                      aria-label={`退出 ${t.display_name}`}
                      disabled={quitId !== null}
                      onClick={(e) => void quitApp(t, e.currentTarget)}
                    >
                      {quitId === t.id ? (
                        <Loader2 size={12} className="spin" aria-hidden="true" />
                      ) : (
                        <Power size={12} aria-hidden="true" />
                      )}
                    </button>
                  </span>
                );
              })}
            </span>
          </div>
        )}

        {extras.length > 0 && !loadFailedFresh && extraList.length > 0 && (
          <div className="cap-recent">
            <span className="cap-recent-title">
              {query.trim() ? "匹配的网址 / 文件夹 / 文件" : "网址 / 文件夹 / 文件"}
            </span>
            <span className="cap-recent-list">
              {extraList.map((t) => (
                <button
                  type="button"
                  key={t.id}
                  className="cap-recent-chip"
                  aria-label={`打开 ${t.display_name}`}
                  disabled={launchingIds.has(t.id)}
                  onClick={() => void launch(t.id, t.display_name)}
                  // 与磁贴同一规则：只在名称被省略时提示完整名称，不把网址/路径弹成浮层。
                  onMouseEnter={(e) => syncTruncatedTip(e.currentTarget, ".cap-recent-name", t.display_name)}
                  onMouseLeave={(e) => clearTip(e.currentTarget)}
                  onFocus={(e) => syncTruncatedTip(e.currentTarget, ".cap-recent-name", t.display_name)}
                  onBlur={(e) => clearTip(e.currentTarget)}
                >
                  <i
                    className="cap-recent-dot"
                    style={{ "--app-hue": String(avatarHue(t.app_key || t.display_name)) } as CSSProperties}
                    aria-hidden="true"
                  >
                    {(t.display_name || "?").slice(0, 1).toUpperCase()}
                  </i>
                  <span className="cap-recent-name">{t.display_name}</span>
                </button>
              ))}
            </span>
          </div>
        )}

        {query.trim() && filtered.apps.length === 0 && extraList.length === 0 && !loadFailedFresh && (
          <EmptyState
            icon={<Search size={20} strokeWidth={1.6} aria-hidden="true" />}
            text="没有匹配的应用"
          />
        )}
      </div>

      <div className="cap-foot">
        <span className="cap-foot-note">{notice ?? "点击即启动或聚焦已有窗口"}</span>
        <button type="button" className="cap-link" onClick={openAppsManager}>
          管理
        </button>
      </div>
    </>
  );
}
