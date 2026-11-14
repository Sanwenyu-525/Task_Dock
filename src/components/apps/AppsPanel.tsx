//! 应用中心（完整模式左侧导航「应用」，v0.10）。
//!
//! 职责：已保存应用/网址/目录的**浏览、搜索、筛选、启动与轻量管理**。
//! 三端共用同一份数据：本页、胶囊「应用」面板、设置「应用与快捷方式」都读写
//! `useNavigationStore` + 后端 navigation 命令，不建第二份数据库。
//!
//! 边界：
//! - 只展示普通应用（`target_type === "application"`）与网址/文件夹分区；
//!   Agent 会话归 Agent 模块，不在此重复建设。
//! - 启动/聚焦完全复用 `navNavigate` + 后端 Router，不新增扫描或窗口激活实现。
//! - 「运行中」筛选来自后端 `nav_target_running_states` 的真实窗口/进程快照
//!   （打开页面或启动成功后按需查询一次，不轮询）；查询失败如实提示，不用
//!   `use_count` / `last_used_at` 推断运行态。
//! - 应用网格顺序与胶囊同源（lib/appGridOrder）：手动序为基，收藏/运行置顶只
//!   作为展示层叠加；拖动或 Alt+←/→ 调整顺序，启动不改写手动序。
//! - 添加复用 `AppPicker standalone` 子页面；编辑复用共享 `TargetEditForm` 页内表单；
//!   本页只做删除确认与刷新，不写第二套保存逻辑。

import {
  useCallback, useEffect, useMemo, useRef, useState,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  AlertTriangle, FolderOpen, LayoutGrid, Link2, Loader2, MoreHorizontal, OctagonX, Pencil, Plus,
  Power, RefreshCw, SquareX, Star, Trash2, EyeOff, Eye, X,
} from "lucide-react";
import { useUiStore } from "../../store/useUiStore";
import { useNavigationStore, type RefreshOutcome } from "../../store/useNavigationStore";
import { errorMessage, normalizeError } from "../../lib/errors";
import {
  navCloseTargetWindows, navDeleteTarget, navKillTargetProcesses, navNavigate,
  navQuitTargetProcesses, navTargetRunningStates, navUpdateTarget,
  isTargetRunning, resultMessage, stateBadge, TARGET_TYPE_LABELS,
  type NavTarget,
} from "../../lib/navigation";
import { prioritizeFavoritesAndRunning, searchApps, sortTargetsForDisplay } from "../../lib/appSearch";
import {
  buildAppGrid, filterAppGrid, moveAppGridBy, moveAppGridId,
  readAppGridOrder, writeAppGridOrder,
  type AppGridEntry,
} from "../../lib/appGridOrder";
import { onAppGridOrderApplied, schedulePreferencesMirror } from "../../lib/userPreferences";
import { useFullViewVisible } from "../../hooks/useMainUiVisible";
import { clearTip, syncTruncatedTip } from "../../lib/nameTip";
import AppIcon from "../ui/AppIcon";
import { ConfirmDialog, DropdownMenu, EmptyState, SearchField } from "../ui";
import AppPicker from "../navigation/AppPicker";
import TargetEditForm from "./TargetEditForm";
import { useLocale } from "../../hooks/useLocale";
import type { MessageKey } from "../../i18n";
import "./apps-ui.css";

type AppFilter = "all" | "favorite" | "recent" | "running";

const FILTERS: ReadonlyArray<{ id: AppFilter; labelKey: MessageKey }> = [
  { id: "all", labelKey: "apps.filter.all" },
  { id: "favorite", labelKey: "apps.filter.favorite" },
  { id: "recent", labelKey: "apps.filter.recent" },
  { id: "running", labelKey: "apps.filter.running" },
];

/**
 * 只有名称真的被省略号截断时才给卡片挂 `data-tip`（值为应用名），
 * 未截断完全不挂：避免全局 tooltip 把 exe 路径浮层压在相邻卡片文字上。
 * 判定与写入走 `lib/nameTip`（胶囊应用网格共用同一规则），并必须在
 * mouseenter / focus 事件里同步写入，全局 tooltip 的冒泡监听才能读到。
 */
function syncTruncatedNameTip(el: HTMLButtonElement, name: string) {
  syncTruncatedTip(el, ".apps-tile-name", name);
}

function clearNameTip(el: HTMLButtonElement) {
  clearTip(el);
}

export default function AppsPanel() {
  const { t: tr } = useLocale();
  const showToast = useUiStore((s) => s.showToast);
  const requestAppConfig = useUiStore((s) => s.requestAppConfig);
  const setTab = useUiStore((s) => s.setTab);
  const appsAddRequest = useUiStore((s) => s.appsAddRequest);
  const clearAppsAddRequest = useUiStore((s) => s.clearAppsAddRequest);
  const {
    targets, targetsLoaded, targetsError, loadTargets, loadTaskLinks,
  } = useNavigationStore();

  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<AppFilter>("all");
  const [runningStates, setRunningStates] = useState<Record<string, string>>({});
  const [statesError, setStatesError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<NavTarget | null>(null);
  /** 页内编辑表单是否有未保存更改；切换目标/进入添加页前据此保护 */
  const [editorDirty, setEditorDirty] = useState(false);
  /** 有未保存更改时被拦下的离开意图，确认放弃后再执行 */
  const [pendingLeave, setPendingLeave] = useState<
    { kind: "edit"; target: NavTarget } | { kind: "add" } | { kind: "manage" } | null
  >(null);
  const [pendingDelete, setPendingDelete] = useState<NavTarget | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  /** 强制结束进程是破坏性动作：先经确认弹窗（对齐删除的纪律），再调后端。 */
  const [pendingKill, setPendingKill] = useState<NavTarget | null>(null);
  const [killBusy, setKillBusy] = useState(false);
  /** 请求退出（WM_QUIT）无破坏性，不需要确认；只防并发重复触发。 */
  const [quitBusy, setQuitBusy] = useState(false);
  /** 后端删除成功但列表刷新失败时，本地先隐藏该项，避免旧缓存把已删除目标显示回来。 */
  const [removedIds, setRemovedIds] = useState<ReadonlySet<string>>(new Set());
  const [launchingIds, setLaunchingIds] = useState<ReadonlySet<string>>(new Set());
  /** 正在优雅关闭窗口的目标：防重入；与 launchingIds 同一套并发纪律。 */
  const [closingIds, setClosingIds] = useState<ReadonlySet<string>>(new Set());
  /** 哪张卡片的「更多」菜单正展开：让整卡保持 hover 态，菜单关闭后恢复 */
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  /** 启动后的运行态补查定时器：慢启动应用窗口晚于启动返回出现，靠补查
      让徽标/关闭按钮跟上真实状态；定时器可取消、卸载即清，非常驻轮询。 */
  const stateRecheckTimers = useRef<ReturnType<typeof setTimeout>[]>([]);

  // ── 网格手动排序（与胶囊 AppsLite 同一 lib/appGridOrder 数据源）──
  /** 用户手动网格顺序；null = 使用自然顺序。 */
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

  /**
   * 完整面板被 DeferredView 保活（胶囊停靠期只是 CSS 隐藏 + inert）：
   * 在胶囊里排完序回到完整面板时必须重读手动序，否则显示旧顺序。
   * 以「完整面板可见性」翻转作为重读信号（回完整模式/重新激活各触发一次），
   * 不引入定时器或事件监听。
   */
  const fullViewVisible = useFullViewVisible();
  useEffect(() => {
    setSavedOrder(readAppGridOrder());
  }, [fullViewVisible]);

  // 备份恢复会替换 localStorage 中的网格顺序：已挂载的面板同步重读，
  // 不必重启应用。订阅在卸载时解除，不产生常驻监听。
  useEffect(
    () =>
      onAppGridOrderApplied(() => {
        setSavedOrder(readAppGridOrder());
      }),
    [],
  );

  useEffect(
    () => () => {
      for (const t of stateRecheckTimers.current) clearTimeout(t);
      stateRecheckTimers.current = [];
    },
    [],
  );

  const apps = useMemo(
    () => targets.filter(
      (t) => t.target_type === "application" && !t.hidden && !removedIds.has(t.id),
    ),
    [targets, removedIds],
  );
  const extras = useMemo(
    () => targets.filter(
      (t) =>
        !t.hidden &&
        !removedIds.has(t.id) &&
        (t.target_type === "url" || t.target_type === "directory" || t.target_type === "file"),
    ),
    [targets, removedIds],
  );
  // 目标集合变化才重新查询运行态（无定时器、无轮询）
  const appIdsKey = apps.map((a) => a.id).join(",");

  useEffect(() => {
    if (!targetsLoaded) void loadTargets(true);
  }, [targetsLoaded, loadTargets]);

  const fetchRunningStates = useCallback(async () => {
    const ids = useNavigationStore.getState().targets
      .filter((t) => t.target_type === "application" && !t.hidden)
      .map((t) => t.id);
    if (ids.length === 0) {
      setRunningStates({});
      setStatesError(null);
      return;
    }
    try {
      setRunningStates(await navTargetRunningStates(ids));
      setStatesError(null);
    } catch (e) {
      // 运行态失败不影响浏览与启动，但「运行中」筛选必须如实提示
      setStatesError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    if (!targetsLoaded) return;
    void fetchRunningStates();
  }, [targetsLoaded, appIdsKey, fetchRunningStates]);

  /**
   * 完整网格（手动序为基）：自然展示顺序（收藏 → 最近 → 名称）交给
   * `buildAppGrid` 套手动序。未知 id 容错由 buildAppGrid 保证——已删除/隐藏/
   * 被过滤的应用自动跳过，新增应用追加在顺序末尾；APP_ADD_KEY（胶囊加号）
   * 不在本页渲染，但保留在顺序数组里，跨面板移动顺序时加号位置不漂移。
   */
  const fullGrid = useMemo(
    () => buildAppGrid(sortTargetsForDisplay(apps), savedOrder),
    [apps, savedOrder],
  );
  /**
   * 置顶规则（与胶囊应用面板同一函数同一规则，2026-11-09 口径）：
   * 收藏最前，运行中其次，其余保持当前顺序（手动排序时即手动顺序）。
   * 只改展示顺序，不改后端数据与手动排序本身；「全部」筛选之外的手动序不参与
   * （收藏/最近/运行中各有自己的排序规则，与胶囊无对应视图）。
   */
  const displayGrid = useMemo(() => {
    if (filter !== "all") return fullGrid;
    const appEntries = fullGrid.filter(
      (entry): entry is Extract<AppGridEntry<NavTarget>, { type: "app" }> => entry.type === "app",
    );
    const hasPinned = appEntries.some(
      (entry) => Boolean(entry.app.favorite) || isTargetRunning(runningStates, entry.app.id),
    );
    // 没有收藏也没有运行中：保持完整网格原样（含手动顺序）
    if (!hasPinned) return fullGrid;
    const add = fullGrid.filter((entry) => entry.type === "add");
    return [
      ...prioritizeFavoritesAndRunning(
        appEntries,
        (entry) => Boolean(entry.app.favorite),
        (entry) => isTargetRunning(runningStates, entry.app.id),
      ),
      ...add,
    ];
  }, [fullGrid, filter, runningStates]);
  /** 手动排序提交基准：展示顺序 id（含胶囊加号占位），与胶囊 commitOrder 同源。 */
  const fullOrder = useMemo(() => displayGrid.map((entry) => entry.id), [displayGrid]);

  const visibleApps = useMemo(() => {
    // 与应用选择器共用搜索规则（中文连续子串 / 英文大小写 / 身份绑定别名），
    // 数据范围是「已配置集合」（apps），不是扫描到的全部应用。
    let list = apps;
    if (query.trim()) {
      const byId = new Map(apps.map((t) => [t.id, t]));
      list = searchApps(
        apps.map((t) => ({
          key: t.id,
          displayName: t.display_name,
          category: t.category,
          exePath: t.exe_path,
          identity: t.app_key,
        })),
        query,
      )
        .map((s) => byId.get(s.key))
        .filter((t): t is NavTarget => !!t);
    }
    if (filter === "favorite") {
      list = sortTargetsForDisplay(list.filter((t) => t.favorite), { favorite: false });
    } else if (filter === "recent") {
      list = sortTargetsForDisplay(list.filter((t) => !!t.last_used_at), { favorite: false });
    } else if (filter === "running") {
      list = list.filter((t) => isTargetRunning(runningStates, t.id));
    } else {
      // 「全部」视图：手动序为基 + 收藏/运行置顶叠加（displayGrid），
      // 搜索只过滤不重排（与胶囊 filterAppGrid 同一函数），加号占位不渲染。
      const matched = query.trim() ? new Set(list.map((t) => t.id)) : null;
      return filterAppGrid(displayGrid, matched)
        .filter(
          (entry): entry is Extract<AppGridEntry<NavTarget>, { type: "app" }> =>
            entry.type === "app",
        )
        .map((entry) => entry.app);
    }
    return list;
  }, [apps, query, filter, runningStates, displayGrid]);

  const visibleExtras = useMemo(() => {
    const byId = new Map(extras.map((t) => [t.id, t]));
    const matched = query.trim()
      ? searchApps(
          extras.map((t) => ({
            key: t.id,
            displayName: t.display_name,
            category: t.category,
            exePath: t.url || t.path,
            identity: t.app_key,
          })),
          query,
        )
          .map((s) => byId.get(s.key))
          .filter((t): t is NavTarget => !!t)
      : extras;
    return sortTargetsForDisplay(matched, { recent: false });
  }, [extras, query]);

  const markLaunching = (id: string, on: boolean) =>
    setLaunchingIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const markClosing = (id: string, on: boolean) =>
    setClosingIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  /** 启动成功后排两次有界补查（2.5s / 6s）：后端启动确认最多等 5s，慢启动
      应用（酷狗等）的窗口常在这之后才出现，只查一次会把「窗口已打开」卡在
      旧状态。单发定时器、次数有上限、卸载即清，不做常驻轮询。 */
  function scheduleStateRecheck() {
    for (const delay of [2500, 6000]) {
      const timer = setTimeout(() => {
        stateRecheckTimers.current = stateRecheckTimers.current.filter((x) => x !== timer);
        void fetchRunningStates();
      }, delay);
      stateRecheckTimers.current.push(timer);
    }
  }

  /** 写入已成功、界面刷新失败时：保留成功事实 + 刷新失败说明 + 只读重试。 */
  function notifyRefresh(
    successMessage: string,
    outcome: RefreshOutcome,
    retry: () => Promise<RefreshOutcome>,
  ) {
    if (outcome === "ok") {
      showToast(successMessage, { kind: "success" });
      return;
    }
    // stale / cancelled 都不是失败：结果由其他请求落地，或请求被主动取消。
    if (outcome === "stale" || outcome === "cancelled") return;
    showToast(tr("apps.refreshStale", { success: successMessage }), {
      kind: "warning",
      action: {
        label: tr("apps.retryRefresh"),
        run: () => void retry().then((next) => {
          if (next === "ok") showToast(tr("apps.refreshedAgain"), { kind: "success" });
          else if (next === "error") showToast(tr("apps.refreshStillFailed"), { kind: "error" });
        }),
      },
    });
  }

  /** 启动或聚焦：复用后端 Router；只有后端确认成功才刷新「最近使用」。 */
  async function launch(t: NavTarget) {
    if (launchingIds.has(t.id)) return;
    markLaunching(t.id, true);
    try {
      const r = await navNavigate(t.id);
      showToast(resultMessage(r, t.display_name), { kind: r.success ? "success" : "error" });
      // 成功但 verification_level 可能只是 requested-unverified：提示文案由后端如实给出，
      // 前端不额外宣称「已聚焦」。
      if (r.success) {
        // 启动已成功；刷新失败只影响列表展示，不能把启动结果说成失败。
        const outcome = await loadTargets(true);
        await fetchRunningStates();
        // 窗口可能晚于启动返回出现：补查让徽标/关闭按钮跟上真实状态。
        scheduleStateRecheck();
        if (outcome === "error") {
          showToast(tr("apps.launchRefreshFailed"), {
            kind: "warning",
            action: { label: tr("apps.retryRefresh"), run: () => void loadTargets(true) },
          });
        }
      }
    } catch (e) {
      showToast(tr("apps.launchFailed", { name: t.display_name, error: errorMessage(e) }), {
        kind: "error",
      });
    } finally {
      markLaunching(t.id, false);
    }
  }

  /** 优雅关闭该应用的全部顶层窗口：后端按 exe 身份现查现关（WM_CLOSE），
      不结束进程；应用弹「是否保存」时窗口仍在，按结果如实提示。 */
  async function closeWindows(t: NavTarget) {
    if (closingIds.has(t.id)) return;
    markClosing(t.id, true);
    try {
      const r = await navCloseTargetWindows(t.id);
      if (r.requested === 0) {
        showToast(tr("apps.windowCloseNone", { name: t.display_name }), { kind: "warning" });
      } else if (r.stillOpen.length > 0) {
        showToast(
          tr("apps.windowClosePartial", { name: t.display_name, count: r.stillOpen.length }),
          { kind: "warning" },
        );
      } else {
        showToast(tr("apps.windowClosed", { name: t.display_name, count: r.closed }), {
          kind: "success",
        });
      }
      await fetchRunningStates();
    } catch (e) {
      showToast(tr("apps.windowCloseFailed", { name: t.display_name, error: errorMessage(e) }), {
        kind: "error",
      });
    } finally {
      markClosing(t.id, false);
    }
  }

  /** 强制结束该应用的全部相关进程（TerminateProcess）：破坏性动作，
      只在确认弹窗后执行；托盘驻留类应用（关窗不退进程）从这里彻底退出。 */
  async function killProcess(t: NavTarget) {
    if (killBusy) return;
    setKillBusy(true);
    try {
      const r = await navKillTargetProcesses(t.id);
      if (r.matched === 0) {
        showToast(tr("apps.processKillNone", { name: t.display_name }), { kind: "warning" });
      } else if (r.failedPids.length > 0) {
        showToast(tr("apps.processKillPartial", { name: t.display_name, count: r.failedPids.length }), {
          kind: "warning",
        });
      } else {
        showToast(tr("apps.processKilled", { name: t.display_name, count: r.killed }), {
          kind: "success",
        });
      }
      await fetchRunningStates();
    } catch (e) {
      showToast(tr("apps.processKillFailed", { name: t.display_name, error: errorMessage(e) }), {
        kind: "error",
      });
    } finally {
      setKillBusy(false);
    }
  }

  /** 请求应用自行退出（向其线程投递 WM_QUIT，等价托盘「退出」）：应用走
      自己的保存/清理/移除托盘路径，无破坏性；不配合的（自定义消息循环）
      如实报未完全退出，引导改用结束进程。 */
  async function quitProcess(t: NavTarget) {
    if (quitBusy) return;
    setQuitBusy(true);
    try {
      const r = await navQuitTargetProcesses(t.id);
      if (r.processTotal === 0) {
        showToast(tr("apps.quitNone", { name: t.display_name }), { kind: "warning" });
      } else if (r.processExited < r.processTotal) {
        showToast(
          tr("apps.quitPartial", {
            name: t.display_name,
            done: r.processExited,
            total: r.processTotal,
          }),
          { kind: "warning" },
        );
      } else {
        showToast(tr("apps.quitDone", { name: t.display_name }), { kind: "success" });
      }
      await fetchRunningStates();
    } catch (e) {
      showToast(tr("apps.quitFailed", { name: t.display_name, error: errorMessage(e) }), {
        kind: "error",
      });
    } finally {
      setQuitBusy(false);
    }
  }

  async function toggleFavorite(t: NavTarget) {
    try {
      await navUpdateTarget(t.id, { favorite: !t.favorite });
    } catch (e) {
      showToast(tr("apps.favoriteFailed", { error: errorMessage(e) }), { kind: "error" });
      return;
    }
    // 收藏已写入；刷新失败单独说明。
    const outcome = await loadTargets(true);
    notifyRefresh(t.favorite ? tr("apps.unfavorited") : tr("apps.favorited"), outcome, () => loadTargets(true));
  }

  async function toggleHidden(t: NavTarget) {
    try {
      await navUpdateTarget(t.id, { hidden: !t.hidden });
    } catch (e) {
      showToast(tr("apps.hideFailed", { error: errorMessage(e) }), { kind: "error" });
      return;
    }
    const outcome = await loadTargets(true);
    await fetchRunningStates();
    notifyRefresh(t.hidden ? tr("apps.unhidden") : tr("apps.hidden"), outcome, () => loadTargets(true));
  }

  async function refreshAll(showSuccess: boolean) {
    // 用本次调用的返回值判定结果，不读旧 store 状态推断成功。
    const outcome = await loadTargets(true);
    await fetchRunningStates();
    if (outcome === "error") {
      const reason = useNavigationStore.getState().targetsError ?? tr("apps.readFailed");
      showToast(tr("apps.refreshFailed", { reason }), {
        kind: "error",
        action: { label: tr("common.retry"), run: () => void refreshAll(showSuccess) },
      });
      return;
    }
    if (outcome === "stale") return;
    if (showSuccess) showToast(tr("apps.refreshed"), { kind: "success" });
  }

  function closeEditor() {
    setEditing(null);
    setEditorDirty(false);
  }

  /** 页内编辑：切换目标不丢改动；有未保存更改时先确认。 */
  function requestEdit(t: NavTarget) {
    if (editing?.id === t.id) return;
    if (editing && editorDirty) {
      setPendingLeave({ kind: "edit", target: t });
      return;
    }
    setEditing(t);
    setEditorDirty(false);
  }

  function requestAdd() {
    if (editing && editorDirty) {
      setPendingLeave({ kind: "add" });
      return;
    }
    closeEditor();
    setAddOpen(true);
  }

  // 胶囊「+」的一次性意图：本组件挂载/收到新 token 时才消费并清除。
  // 未挂载时意图保留在 store（异步展开窗口不丢），消费后清除（取消/返回不再自动重开）。
  useEffect(() => {
    if (!appsAddRequest) return;
    clearAppsAddRequest();
    requestAdd();
  }, [appsAddRequest, clearAppsAddRequest, requestAdd]);

  function requestManage() {
    if (editing && editorDirty) {
      setPendingLeave({ kind: "manage" });
      return;
    }
    // 复用设置页的一次性配置意图；消费后清除，不反复自动弹出
    requestAppConfig("manage");
    setTab("settings");
  }

  function applyPendingLeave() {
    const intent = pendingLeave;
    setPendingLeave(null);
    if (!intent) return;
    if (intent.kind === "edit") {
      setEditing(intent.target);
      setEditorDirty(false);
      return;
    }
    closeEditor();
    if (intent.kind === "add") {
      setAddOpen(true);
    } else {
      requestAppConfig("manage");
      setTab("settings");
    }
  }

  /** 次要操作统一走菜单，避免每个网格堆一排按钮。 */
  function menuItems(t: NavTarget) {
    return [
      {
        key: "edit",
        label: "编辑配置",
        icon: <Pencil size={12} aria-hidden="true" />,
        onSelect: () => requestEdit(t),
      },
      // 关闭窗口是高频动作，已上卡片操作区（见 renderTile），菜单不再重复。
      // 退出应用 = WM_QUIT 优雅档（等价托盘退出）；结束进程 = 强杀（破坏性，
      // 仅运行中提供且需确认弹窗）。
      ...(isTargetRunning(runningStates, t.id)
        ? [
            {
              key: "quit-app",
              label: "退出应用（自行保存并退出）",
              icon: <Power size={12} aria-hidden="true" />,
              onSelect: () => void quitProcess(t),
            },
            {
              key: "kill-process",
              label: "结束进程（强制，未保存数据将丢失）",
              icon: <OctagonX size={12} aria-hidden="true" />,
              danger: true,
              onSelect: () => setPendingKill(t),
            },
          ]
        : []),
      {
        key: "hide",
        label: t.hidden ? "取消隐藏" : "隐藏（不在胶囊与选择器显示）",
        icon: t.hidden ? <Eye size={12} aria-hidden="true" /> : <EyeOff size={12} aria-hidden="true" />,
        onSelect: () => void toggleHidden(t),
      },
      {
        key: "delete",
        label: "从快捷列表删除",
        icon: <Trash2 size={12} aria-hidden="true" />,
        danger: true,
        onSelect: () => setPendingDelete(t),
      },
    ];
  }

  // ── 网格排序（与胶囊 AppsLite 同一交互与提交语义）────────────
  // 只用原生 HTML5 拖放与键盘移动，不引入拖拽库；本页没有加号磁贴，
  // 顺序数组里的 APP_ADD_KEY 占位保留但不渲染。
  const commitOrder = (next: string[]) => {
    if (next.length === 0) return;
    writeAppGridOrder(next);
    setSavedOrder(next);
    // 排序属于用户偏好：防抖镜像到 preferences.json，随完整/快速备份迁移。
    schedulePreferencesMirror();
    showToast("顺序已保存", { kind: "success" });
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
   * 只有这种情况忽略一次；真实点击/键盘激活会先清掉标记，因此拖完立刻点其他
   * 应用都能正常启动，不需要再移动一次鼠标。
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

  function renderStar(t: NavTarget) {
    return (
      <button
        type="button"
        className={`icon-btn sm ${t.favorite ? "default-on" : ""}`}
        data-tip={t.favorite ? "取消收藏" : "收藏"}
        aria-label={t.favorite ? `取消收藏 ${t.display_name}` : `收藏 ${t.display_name}`}
        onClick={() => void toggleFavorite(t)}
      >
        <Star size={12} aria-hidden="true" fill={t.favorite ? "currentColor" : "none"} />
      </button>
    );
  }

  /** 卡片上的高频关闭入口：仅「窗口已打开」显示（与徽标同源），优雅关闭
      WM_CLOSE 不需要确认——应用自身的保存弹窗就是防线；强制结束进程仍收在
      ⋯ 菜单并要求确认（破坏性、低频）。 */
  function renderCloseWindow(t: NavTarget) {
    const closing = closingIds.has(t.id);
    return (
      <button
        type="button"
        className="icon-btn sm"
        data-tip="关闭窗口"
        aria-label={`关闭 ${t.display_name} 的窗口`}
        disabled={closing}
        onClick={() => void closeWindows(t)}
      >
        {closing ? (
          <Loader2 size={12} className="spin" aria-hidden="true" />
        ) : (
          <SquareX size={12} aria-hidden="true" />
        )}
      </button>
    );
  }

  /** 直接删除入口：与启动/收藏/菜单并列，不嵌套在任何按钮内。 */
  function renderDelete(t: NavTarget) {
    return (
      <button
        type="button"
        className="icon-btn sm apps-tile-del"
        aria-label={`从快捷列表删除 ${t.display_name}`}
        disabled={launchingIds.has(t.id)}
        onClick={(e) => {
          e.stopPropagation();
          setPendingDelete(t);
        }}
      >
        <X size={11} aria-hidden="true" />
      </button>
    );
  }

  function renderTile(t: NavTarget) {
    const running = runningStates[t.id];
    const badge = isTargetRunning(runningStates, t.id) ? stateBadge(running) : null;
    const busy = launchingIds.has(t.id);
    // 单行卡片：主区域（图标 + 名称/状态）是一个按钮，收藏/更多是并列的独立
    // 按钮（不是嵌套按钮），因此点收藏与菜单不会冒泡触发启动。
    // 卡片同时是排序项：拖动主按钮换位，落点提示挂在整个磁贴上。
    return (
      <div
        className={`apps-tile ${menuOpenId === t.id ? "is-menu-open" : ""} ${dragId === t.id ? "is-dragging" : ""} ${dropClass(t.id)}`}
        key={t.id}
        data-grid-id={t.id}
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
          className="apps-tile-main"
          onClick={() => {
            // 拖放结束的补发 click 不启动应用（见 suppressClickRef 注释）。
            if (shouldIgnoreClick()) return;
            void launch(t);
          }}
          disabled={busy}
          draggable={!busy}
          onDragStart={(e) => onDragStart(e, t.id)}
          onDragEnd={endDrag}
          onKeyDown={(e) => onOrderKeyDown(e, t.id)}
          // 只在名称被截断时由 hover/focus 同步挂 data-tip；不再把 exe 路径塞进 tooltip
          data-tip={busy ? tr("apps.launching") : undefined}
          data-tip-locked={busy ? "1" : undefined}
          onMouseEnter={(e) => {
            if (!busy) syncTruncatedNameTip(e.currentTarget, t.display_name);
          }}
          onMouseLeave={(e) => {
            if (!busy) clearNameTip(e.currentTarget);
          }}
          onFocus={(e) => {
            if (!busy) syncTruncatedNameTip(e.currentTarget, t.display_name);
          }}
          onBlur={(e) => {
            if (!busy) clearNameTip(e.currentTarget);
          }}
          aria-label={tr("apps.launchAria", { name: t.display_name })}
        >
          <AppIcon
            targetId={t.id}
            name={t.display_name}
            size={20}
            enabled={t.target_type === "application"}
            className="apps-tile-avatar"
          />
          <span className="apps-tile-text">
            <span className="apps-tile-name">{t.display_name}</span>
            {t.shortcut_kind === "window" && (
              <span className="apps-tile-state is-idle">指定窗口</span>
            )}
            {badge && (
              <span className={`apps-tile-state is-${badge.tone}`}>{badge.label}</span>
            )}
            {running === "unavailable" && (
              <span className="apps-tile-state is-bad">{tr("apps.unavailable")}</span>
            )}
          </span>
          {busy && <Loader2 size={13} className="spin" aria-hidden="true" />}
        </button>
        <div className="apps-tile-actions">
          {renderStar(t)}
          {runningStates[t.id] === "has_window" && renderCloseWindow(t)}
          <DropdownMenu
            trigger={({ ref, expanded, onClick, onKeyDown }) => (
              <button
                ref={ref}
                type="button"
                className="icon-btn sm"
                aria-label={tr("apps.moreActions", { name: t.display_name })}
                aria-haspopup="menu"
                aria-expanded={expanded}
                onClick={onClick}
                onKeyDown={onKeyDown}
              >
                <MoreHorizontal size={13} aria-hidden="true" />
              </button>
            )}
            items={menuItems(t)}
            menuLabel={tr("apps.appMenu", { name: t.display_name })}
            placement="bottom-end"
            onOpenChange={(open) =>
              setMenuOpenId((prev) => (open ? t.id : prev === t.id ? null : prev))
            }
          />
        </div>
        {/* 删除入口脱离收藏/更多所在的布局流：绝对定位在卡片右上角，
            名称截断点因此与没有删除按钮时一致，hit 区仅限按钮自身。 */}
        {renderDelete(t)}
      </div>
    );
  }

  function renderExtraRow(t: NavTarget) {
    const busy = launchingIds.has(t.id);
    const Icon = t.target_type === "url" ? Link2 : FolderOpen;
    return (
      <div className="apps-extra-row" key={t.id}>
        <button
          type="button"
          className="apps-extra-main"
          onClick={() => void launch(t)}
          disabled={busy}
          data-tip={busy ? tr("apps.launching") : undefined}
          data-tip-locked={busy ? "1" : undefined}
          onMouseEnter={(e) => {
            if (!busy) syncTruncatedNameTip(e.currentTarget, t.display_name);
          }}
          onMouseLeave={(e) => {
            if (!busy) clearNameTip(e.currentTarget);
          }}
          onFocus={(e) => {
            if (!busy) syncTruncatedNameTip(e.currentTarget, t.display_name);
          }}
          onBlur={(e) => {
            if (!busy) clearNameTip(e.currentTarget);
          }}
          aria-label={tr("apps.openAria", { name: t.display_name })}
        >
          <span className="apps-extra-icon" aria-hidden="true"><Icon size={13} /></span>
          <span className="apps-tile-name">{t.display_name}</span>
          <span className="apps-extra-type">{TARGET_TYPE_LABELS[t.target_type]}</span>
          {busy && <Loader2 size={12} className="spin" aria-hidden="true" />}
        </button>
        {renderStar(t)}
        <DropdownMenu
          trigger={({ ref, expanded, onClick, onKeyDown }) => (
            <button
              ref={ref}
              type="button"
              className="icon-btn sm"
              aria-label={tr("apps.moreActions", { name: t.display_name })}
              aria-haspopup="menu"
              aria-expanded={expanded}
              onClick={onClick}
              onKeyDown={onKeyDown}
            >
              <MoreHorizontal size={13} aria-hidden="true" />
            </button>
          )}
          items={menuItems(t)}
          menuLabel={tr("apps.extraMenu", { name: t.display_name })}
          placement="bottom-end"
        />
        {renderDelete(t)}
      </div>
    );
  }

  const noAppsAtAll = apps.length === 0 && extras.length === 0;

  // 添加应用改为内容区子页面：不覆盖主内容、不弹大 Modal；本组件保持挂载，
  // 返回时筛选/搜索状态不丢失。
  if (addOpen) {
    return <AppPicker standalone variant="page" onClose={() => setAddOpen(false)} />;
  }

  return (
    <div className="apps-panel page-fill">
      <header className="wf-head-row apps-head">
        <div>
          <h2 className="wf-title">
            <LayoutGrid size={16} aria-hidden="true" /> {tr("apps.title")}
          </h2>
          <p className="wf-subtitle">{tr("apps.subtitle")}</p>
        </div>
        <div className="wf-head-actions">
          <button
            type="button"
            className="btn"
            onClick={requestManage}
            data-tip={tr("apps.manageTip")}
            aria-label={tr("apps.manage")}
          >
            {tr("apps.manage")}
          </button>
          <button type="button" className="btn primary" onClick={requestAdd}>
            <Plus size={13} aria-hidden="true" /> {tr("apps.add")}
          </button>
        </div>
      </header>

      <div className="filter-bar primary apps-filter-bar">
        <div className="seg-group subtle" role="group" aria-label={tr("apps.filterAria")}>
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              className={`seg-btn ${filter === f.id ? "active" : ""}`}
              aria-pressed={filter === f.id}
              onClick={() => setFilter(f.id)}
            >
              {tr(f.labelKey)}
            </button>
          ))}
        </div>
        {/* 搜索与刷新作为一组换行：避免只剩刷新图标单独占一行 */}
        <div className="apps-search-row">
          <SearchField
            className="apps-search"
            size="compact"
            value={query}
            onChange={setQuery}
            placeholder={tr("apps.searchPlaceholder")}
            ariaLabel={tr("apps.searchAria")}
            clearLabel={tr("apps.clearSearch")}
          />
          <button
            type="button"
            className="icon-btn"
            onClick={() => void refreshAll(true)}
            data-tip={tr("apps.refreshTip")}
            aria-label={tr("apps.refreshAria")}
          >
            <RefreshCw size={13} aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="page-scroll apps-body">
        {editing && (
          <TargetEditForm
            key={editing.id}
            target={editing}
            onClose={closeEditor}
            onSaved={async () => {
              closeEditor();
              await refreshAll(false);
            }}
            onDirtyChange={setEditorDirty}
          />
        )}

        {statesError && filter === "running" && (
          <div className="wf-error-text" role="status">
            {tr("apps.statesFailed", { error: statesError })}
            <button type="button" className="link-btn" onClick={() => void fetchRunningStates()}>
              {tr("common.retry")}
            </button>
          </div>
        )}

        {!targetsLoaded && !targetsError && (
          <div className="wf-empty-steps">
            <Loader2 size={13} className="spin" aria-hidden="true" /> {tr("apps.loading")}
          </div>
        )}

        {targetsError && (
          <div className="wf-error-block" role="alert">
            <span><AlertTriangle size={13} aria-hidden="true" /> {tr("apps.loadFailed", { error: targetsError })}</span>
            <button type="button" className="btn sm" onClick={() => void refreshAll(false)}>
              {tr("common.retry")}
            </button>
          </div>
        )}

        {targetsError === null && targetsLoaded && noAppsAtAll && (
          <EmptyState
            framed
            icon={<LayoutGrid size={22} aria-hidden="true" />}
            hint={tr("apps.empty")}
            action={
              <button type="button" className="btn primary" onClick={requestAdd}>
                <Plus size={13} aria-hidden="true" /> {tr("apps.add")}
              </button>
            }
          />
        )}

        {targetsLoaded && !noAppsAtAll && visibleApps.length === 0 && visibleExtras.length === 0 && (
          <div className="wf-empty-steps">
            {filter === "recent"
              ? tr("apps.emptyRecent")
              : filter === "running"
                ? tr("apps.emptyRunning")
                : filter === "favorite"
                  ? tr("apps.emptyFavorite")
                  : tr("apps.emptyQuery", { query: query.trim() })}
          </div>
        )}

        {targetsLoaded && !noAppsAtAll && filter === "all" && savedOrder && (
          <p className="apps-sort-hint" role="note">
            手动排序已开启：拖动磁贴或按 Alt+←/→ 调整顺序；点击磁贴仍是启动应用。
          </p>
        )}

        {targetsLoaded && !noAppsAtAll && (
          <div
            className="apps-grid"
            aria-label={tr("apps.gridAria")}
            // 真实按下 / 键盘激活会先经过捕获阶段，清掉拖放后的「补发 click」防护。
            onPointerDownCapture={() => {
              suppressClickRef.current = false;
            }}
            onKeyDownCapture={() => {
              suppressClickRef.current = false;
            }}
          >
            {visibleApps.map(renderTile)}
          </div>
        )}

        {visibleExtras.length > 0 && (
          <section className="apps-extras" aria-label={tr("apps.extrasAria")}>
            <h3 className="apps-section-title">{tr("apps.extrasTitle")}</h3>
            <div className="apps-extra-list">{visibleExtras.map(renderExtraRow)}</div>
          </section>
        )}
      </div>

      <ConfirmDialog
        open={!!pendingLeave}
        title="放弃未保存的更改？"
        detail={
          pendingLeave?.kind === "edit"
            ? `当前「${editing?.display_name ?? ""}」的修改尚未保存，切换目标后会丢失。`
            : "当前编辑的修改尚未保存，离开后会丢失。"
        }
        confirmLabel="放弃更改"
        danger
        onCancel={() => setPendingLeave(null)}
        onConfirm={applyPendingLeave}
      />

      <ConfirmDialog
        open={!!pendingDelete}
        title={`从快捷列表删除「${pendingDelete?.display_name ?? ""}」？`}
        detail="只删除 task_dock 中的快捷目标，不会卸载应用或删除程序文件；该目标的所有任务关联会一并解除（任务本身不受影响）。删除后如需恢复，需要重新添加。"
        confirmLabel="删除"
        danger
        busy={deleteBusy || (pendingDelete ? launchingIds.has(pendingDelete.id) : false)}
        onCancel={() => setPendingDelete(null)}
        onConfirm={async () => {
          if (!pendingDelete) return;
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
              await fetchRunningStates();
              if (tOutcome === "ok" && lOutcome === "ok") setRemovedIds(new Set());
              showToast(
                tOutcome === "error" || lOutcome === "error"
                  ? "该快捷目标已不存在，但列表刷新失败"
                  : "该快捷目标已不存在，列表已刷新",
                { kind: "warning" },
              );
              setDeleteBusy(false);
              return;
            }
            // 删除失败必须保留应用项，不把配置从列表里误删。
            showToast(`删除失败：${err.reason || errorMessage(e)}`, { kind: "error" });
            setDeleteBusy(false);
            return;
          }
          // 删除已成功：先本地隐藏，刷新失败只标「部分成功」，不报成删除失败。
          setRemovedIds((prev) => new Set(prev).add(target.id));
          setPendingDelete(null);
          const [tOutcome, lOutcome] = await Promise.all([loadTargets(true), loadTaskLinks()]);
          await fetchRunningStates();
          if (tOutcome === "ok" && lOutcome === "ok") setRemovedIds(new Set());
          if (tOutcome === "error" || lOutcome === "error") {
            showToast("目标已删除，但关联列表刷新失败", {
              kind: "warning",
              action: {
                label: "重试刷新",
                run: () => void Promise.all([loadTargets(true), loadTaskLinks()]),
              },
            });
          } else if (tOutcome === "ok") {
            showToast("目标已删除", { kind: "success" });
          }
          setDeleteBusy(false);
        }}
      />

      <ConfirmDialog
        open={!!pendingKill}
        title={`强制结束「${pendingKill?.display_name ?? ""}」的进程？`}
        detail="将直接终止该应用及其子进程，不经过正常的退出流程；未保存的文档与数据会丢失。多数应用关闭窗口后仍在托盘驻留，只有确认不再需要它运行时才使用本操作。"
        confirmLabel="结束进程"
        danger
        busy={killBusy}
        onCancel={() => setPendingKill(null)}
        onConfirm={async () => {
          if (!pendingKill) return;
          const target = pendingKill;
          setPendingKill(null);
          await killProcess(target);
        }}
      />
    </div>
  );
}
