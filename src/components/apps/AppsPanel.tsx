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
//! - 添加复用 `AppPicker standalone` 子页面；编辑复用共享 `TargetEditForm` 页内表单；
//!   本页只做删除确认与刷新，不写第二套保存逻辑。

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle, FolderOpen, Link2, Loader2, MoreHorizontal, Pencil, Plus, RefreshCw,
  Star, Trash2, EyeOff, Eye, X,
} from "lucide-react";
import { useUiStore } from "../../store/useUiStore";
import { useNavigationStore, type RefreshOutcome } from "../../store/useNavigationStore";
import { errorMessage, normalizeError } from "../../lib/errors";
import {
  navDeleteTarget, navNavigate, navTargetRunningStates, navUpdateTarget,
  resultMessage, stateBadge, TARGET_TYPE_LABELS,
  type NavTarget,
} from "../../lib/navigation";
import { searchApps, sortTargetsForDisplay } from "../../lib/appSearch";
import AppIcon from "../ui/AppIcon";
import { ConfirmDialog, DropdownMenu, SearchField } from "../ui";
import AppPicker from "../navigation/AppPicker";
import TargetEditForm from "./TargetEditForm";
import { useLocale } from "../../hooks/useLocale";
import type { MessageKey } from "../../i18n";

type AppFilter = "all" | "favorite" | "recent" | "running";

const FILTERS: ReadonlyArray<{ id: AppFilter; labelKey: MessageKey }> = [
  { id: "all", labelKey: "apps.filter.all" },
  { id: "favorite", labelKey: "apps.filter.favorite" },
  { id: "recent", labelKey: "apps.filter.recent" },
  { id: "running", labelKey: "apps.filter.running" },
];

/** 「运行中」只认真实快照；`unavailable` 是配置失效，不算运行中。 */
const RUNNING_STATES = new Set(["has_window", "process_only"]);

/**
 * 只有名称真的被省略号截断时才给卡片挂 `data-tip`（值为应用名），
 * 未截断完全不挂：避免全局 tooltip 把 exe 路径浮层压在相邻卡片文字上。
 * 必须在 mouseenter / focus 事件里同步写入，全局 tooltip 的冒泡监听才能读到。
 */
function syncTruncatedNameTip(el: HTMLButtonElement, name: string) {
  const nameEl = el.querySelector<HTMLElement>(".apps-tile-name");
  if (nameEl && nameEl.scrollWidth > nameEl.clientWidth + 1) {
    el.dataset.tip = name;
  } else {
    delete el.dataset.tip;
  }
}

function clearNameTip(el: HTMLButtonElement) {
  delete el.dataset.tip;
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
  /** 后端删除成功但列表刷新失败时，本地先隐藏该项，避免旧缓存把已删除目标显示回来。 */
  const [removedIds, setRemovedIds] = useState<ReadonlySet<string>>(new Set());
  const [launchingIds, setLaunchingIds] = useState<ReadonlySet<string>>(new Set());
  /** 哪张卡片的「更多」菜单正展开：让整卡保持 hover 态，菜单关闭后恢复 */
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);

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
      list = list.filter((t) => RUNNING_STATES.has(runningStates[t.id]));
    } else {
      list = sortTargetsForDisplay(list);
    }
    return list;
  }, [apps, query, filter, runningStates]);

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

  function renderStar(t: NavTarget) {
    return (
      <button
        type="button"
        className={`icon-btn sm ${t.favorite ? "default-on" : ""}`}
        data-tip={t.favorite ? "取消收藏" : "收藏"}
        aria-label={t.favorite ? `取消收藏 ${t.display_name}` : `收藏 ${t.display_name}`}
        onClick={() => void toggleFavorite(t)}
      >
        <Star size={12} aria-hidden="true" />
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
    const badge = RUNNING_STATES.has(running) ? stateBadge(running) : null;
    const busy = launchingIds.has(t.id);
    // 单行卡片：主区域（图标 + 名称/状态）是一个按钮，收藏/更多是并列的独立
    // 按钮（不是嵌套按钮），因此点收藏与菜单不会冒泡触发启动。
    return (
      <div className={`apps-tile ${menuOpenId === t.id ? "is-menu-open" : ""}`} key={t.id}>
        <button
          type="button"
          className="apps-tile-main"
          onClick={() => void launch(t)}
          disabled={busy}
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
    <div className="apps-panel">
      <header className="wf-head-row apps-head">
        <div>
          <h2 className="wf-title">{tr("apps.title")}</h2>
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
        <div className="wf-empty">
          <p className="wf-hint-text">{tr("apps.empty")}</p>
          <button type="button" className="btn primary" onClick={requestAdd}>
            <Plus size={13} aria-hidden="true" /> {tr("apps.add")}
          </button>
        </div>
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

      {targetsLoaded && !noAppsAtAll && (
        <div className="apps-grid" aria-label={tr("apps.gridAria")}>
          {visibleApps.map(renderTile)}
        </div>
      )}

      {visibleExtras.length > 0 && (
        <section className="apps-extras" aria-label={tr("apps.extrasAria")}>
          <h3 className="apps-section-title">{tr("apps.extrasTitle")}</h3>
          <div className="apps-extra-list">{visibleExtras.map(renderExtraRow)}</div>
        </section>
      )}

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
    </div>
  );
}
