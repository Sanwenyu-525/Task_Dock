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
//! - 添加复用 `AppPicker standalone`；编辑复用共享 `TargetEditDialog`；
//!   本页只做删除确认与刷新，不写第二套保存逻辑。

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle, FolderOpen, Link2, Loader2, MoreHorizontal, Pencil, Plus, RefreshCw,
  Rocket, Search, Star, Trash2, X, EyeOff, Eye,
} from "lucide-react";
import { useUiStore } from "../../store/useUiStore";
import { useNavigationStore } from "../../store/useNavigationStore";
import {
  navDeleteTarget, navNavigate, navTargetRunningStates, navUpdateTarget,
  resultMessage, stateBadge, TARGET_TYPE_LABELS,
  type NavTarget,
} from "../../lib/navigation";
import { searchApps } from "../../lib/appSearch";
import AppIcon from "../ui/AppIcon";
import { ConfirmDialog, DropdownMenu } from "../ui";
import AppPicker from "../navigation/AppPicker";
import TargetEditDialog from "../settings/TargetEditDialog";

type AppFilter = "all" | "favorite" | "recent" | "running";

const FILTERS: ReadonlyArray<{ id: AppFilter; label: string }> = [
  { id: "all", label: "全部" },
  { id: "favorite", label: "收藏" },
  { id: "recent", label: "最近使用" },
  { id: "running", label: "运行中" },
];

/** 「运行中」只认真实快照；`unavailable` 是配置失效，不算运行中。 */
const RUNNING_STATES = new Set(["has_window", "process_only"]);

export default function AppsPanel() {
  const showToast = useUiStore((s) => s.showToast);
  const requestAppConfig = useUiStore((s) => s.requestAppConfig);
  const setTab = useUiStore((s) => s.setTab);
  const {
    targets, targetsLoaded, targetsError, loadTargets, loadTaskLinks,
  } = useNavigationStore();

  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<AppFilter>("all");
  const [runningStates, setRunningStates] = useState<Record<string, string>>({});
  const [statesError, setStatesError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<NavTarget | null>(null);
  const [pendingDelete, setPendingDelete] = useState<NavTarget | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [launchingIds, setLaunchingIds] = useState<ReadonlySet<string>>(new Set());

  const apps = useMemo(
    () => targets.filter((t) => t.target_type === "application" && !t.hidden),
    [targets],
  );
  const extras = useMemo(
    () => targets.filter((t) => !t.hidden && (t.target_type === "url" || t.target_type === "directory" || t.target_type === "file")),
    [targets],
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
      setStatesError(String(e));
    }
  }, []);

  useEffect(() => {
    if (!targetsLoaded) return;
    void fetchRunningStates();
  }, [targetsLoaded, appIdsKey, fetchRunningStates]);

  const visibleApps = useMemo(() => {
    const byRecent = (a: NavTarget, b: NavTarget) =>
      (b.last_used_at ?? "").localeCompare(a.last_used_at ?? "");
    const byName = (a: NavTarget, b: NavTarget) => a.display_name.localeCompare(b.display_name, "zh");

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
      list = list.filter((t) => t.favorite).sort((a, b) => byRecent(a, b) || byName(a, b));
    } else if (filter === "recent") {
      list = list.filter((t) => !!t.last_used_at).sort((a, b) => byRecent(a, b) || byName(a, b));
    } else if (filter === "running") {
      list = list.filter((t) => RUNNING_STATES.has(runningStates[t.id]));
    } else {
      list = [...list].sort(
        (a, b) => Number(b.favorite) - Number(a.favorite) || byRecent(a, b) || byName(a, b),
      );
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
    return [...matched].sort(
      (a, b) => Number(b.favorite) - Number(a.favorite) || a.display_name.localeCompare(b.display_name, "zh"),
    );
  }, [extras, query]);

  const markLaunching = (id: string, on: boolean) =>
    setLaunchingIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

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
        await loadTargets(true);
        await fetchRunningStates();
      }
    } catch (e) {
      showToast(`「${t.display_name}」启动失败：${String(e)}`, { kind: "error" });
    } finally {
      markLaunching(t.id, false);
    }
  }

  async function toggleFavorite(t: NavTarget) {
    try {
      await navUpdateTarget(t.id, { favorite: !t.favorite });
      await loadTargets(true);
    } catch (e) {
      showToast(`收藏操作失败：${String(e)}`, { kind: "error" });
    }
  }

  async function toggleHidden(t: NavTarget) {
    try {
      await navUpdateTarget(t.id, { hidden: !t.hidden });
      await loadTargets(true);
      await fetchRunningStates();
    } catch (e) {
      showToast(`隐藏操作失败：${String(e)}`, { kind: "error" });
    }
  }

  async function refreshAll(showSuccess: boolean) {
    await loadTargets(true);
    await fetchRunningStates();
    const error = useNavigationStore.getState().targetsError;
    if (error) {
      showToast(`刷新失败：${error}`, { kind: "error" });
      return;
    }
    if (showSuccess) showToast("应用清单已刷新", { kind: "success" });
  }

  /** 次要操作统一走菜单，避免每个网格堆一排按钮。 */
  function menuItems(t: NavTarget) {
    return [
      {
        key: "edit",
        label: "编辑配置",
        icon: <Pencil size={12} aria-hidden="true" />,
        onSelect: () => setEditing(t),
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

  function renderTile(t: NavTarget) {
    const running = runningStates[t.id];
    const badge = RUNNING_STATES.has(running) ? stateBadge(running) : null;
    const busy = launchingIds.has(t.id);
    const title = t.exe_path || t.url || t.path || t.display_name;
    return (
      <div className="apps-tile" key={t.id}>
        <button
          type="button"
          className="apps-tile-main"
          onClick={() => void launch(t)}
          disabled={busy}
          data-tip={busy ? "启动中…" : title}
          aria-label={`启动 ${t.display_name}`}
        >
          <AppIcon
            targetId={t.id}
            name={t.display_name}
            size={28}
            enabled={t.target_type === "application"}
            className="apps-tile-avatar"
          />
          <span className="apps-tile-text">
            <span className="apps-tile-name">{t.display_name}</span>
            {badge && (
              <span className={`apps-tile-state is-${badge.tone}`}>{badge.label}</span>
            )}
            {running === "unavailable" && (
              <span className="apps-tile-state is-bad">程序不可用</span>
            )}
          </span>
          {busy && <Loader2 size={13} className="spin" aria-hidden="true" />}
        </button>
        <div className="apps-tile-actions">
          {renderStar(t)}
          <button
            type="button"
            className="icon-btn sm"
            data-tip="启动 / 聚焦窗口"
            aria-label={`启动 ${t.display_name}`}
            onClick={() => void launch(t)}
            disabled={busy}
          >
            <Rocket size={12} aria-hidden="true" />
          </button>
          <span className="flex-spacer" />
          <DropdownMenu
            trigger={({ ref, expanded, onClick, onKeyDown }) => (
              <button
                ref={ref}
                type="button"
                className="icon-btn sm"
                aria-label={`更多操作：${t.display_name}`}
                aria-haspopup="menu"
                aria-expanded={expanded}
                onClick={onClick}
                onKeyDown={onKeyDown}
              >
                <MoreHorizontal size={13} aria-hidden="true" />
              </button>
            )}
            items={menuItems(t)}
            menuLabel={`应用操作：${t.display_name}`}
            placement="bottom-end"
          />
        </div>
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
          data-tip={t.url || t.path || t.display_name}
          aria-label={`打开 ${t.display_name}`}
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
              aria-label={`更多操作：${t.display_name}`}
              aria-haspopup="menu"
              aria-expanded={expanded}
              onClick={onClick}
              onKeyDown={onKeyDown}
            >
              <MoreHorizontal size={13} aria-hidden="true" />
            </button>
          )}
          items={menuItems(t)}
          menuLabel={`网址/文件夹操作：${t.display_name}`}
          placement="bottom-end"
        />
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
          <h2 className="wf-title">应用</h2>
          <p className="wf-subtitle">快捷启动与窗口切换</p>
        </div>
        <div className="wf-head-actions">
          <button
            type="button"
            className="btn"
            onClick={() => {
              // 复用设置页的一次性配置意图；消费后清除，不反复自动弹出
              requestAppConfig("manage");
              setTab("settings");
            }}
            data-tip="打开设置中的应用管理"
            aria-label="管理应用"
          >
            管理
          </button>
          <button type="button" className="btn primary" onClick={() => setAddOpen(true)}>
            <Plus size={13} aria-hidden="true" /> 添加应用
          </button>
        </div>
      </header>

      <div className="filter-bar primary apps-filter-bar">
        <div className="seg-group subtle" role="group" aria-label="应用筛选">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              className={`seg-btn ${filter === f.id ? "active" : ""}`}
              aria-pressed={filter === f.id}
              onClick={() => setFilter(f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <span className="flex-spacer" />
        <div className="picker-search apps-search">
          <Search size={13} aria-hidden="true" />
          <input
            value={query}
            placeholder="搜索应用名称"
            aria-label="搜索应用名称"
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button
              type="button"
              className="icon-btn sm"
              aria-label="清除搜索"
              onClick={() => setQuery("")}
            >
              <X size={12} aria-hidden="true" />
            </button>
          )}
        </div>
        <button
          type="button"
          className="btn sm"
          onClick={() => void refreshAll(true)}
          data-tip="刷新目标列表与运行状态（不重新扫描软件）"
          aria-label="刷新应用清单"
        >
          <RefreshCw size={12} aria-hidden="true" /> 刷新
        </button>
      </div>

      {statesError && filter === "running" && (
        <div className="wf-error-text" role="status">
          运行状态查询失败：{statesError}
          <button type="button" className="link-btn" onClick={() => void fetchRunningStates()}>
            重试
          </button>
        </div>
      )}

      {!targetsLoaded && !targetsError && (
        <div className="wf-empty-steps">
          <Loader2 size={13} className="spin" aria-hidden="true" /> 加载中…
        </div>
      )}

      {targetsError && (
        <div className="wf-error-block" role="alert">
          <span><AlertTriangle size={13} aria-hidden="true" /> 应用清单加载失败：{targetsError}</span>
          <button type="button" className="btn sm" onClick={() => void refreshAll(false)}>
            重试
          </button>
        </div>
      )}

      {targetsError === null && targetsLoaded && noAppsAtAll && (
        <div className="wf-empty">
          <p className="wf-hint-text">还没有配置应用。添加后会立即出现在这里，也会同步到胶囊与设置页。</p>
          <button type="button" className="btn primary" onClick={() => setAddOpen(true)}>
            <Plus size={13} aria-hidden="true" /> 添加应用
          </button>
        </div>
      )}

      {targetsLoaded && !noAppsAtAll && visibleApps.length === 0 && visibleExtras.length === 0 && (
        <div className="wf-empty-steps">
          {filter === "recent"
            ? "还没有最近使用记录；启动一次应用后会按真实使用时间排序。"
            : filter === "running"
              ? "当前没有检测到正在运行的应用。"
              : filter === "favorite"
                ? "还没有收藏的应用。"
                : `没有匹配「${query.trim()}」的应用。`}
        </div>
      )}

      {targetsLoaded && !noAppsAtAll && (
        <div className="apps-grid" aria-label="应用快捷方式">
          {visibleApps.map(renderTile)}
          {/* 网格末尾常驻添加入口；不受筛选/搜索/数量影响 */}
          <button
            type="button"
            className="apps-tile apps-tile-add"
            onClick={() => setAddOpen(true)}
            aria-label="添加应用"
          >
            <Plus size={16} aria-hidden="true" />
            <span>添加应用</span>
          </button>
        </div>
      )}

      {visibleExtras.length > 0 && (
        <section className="apps-extras" aria-label="网址与文件夹">
          <h3 className="apps-section-title">网址与文件夹</h3>
          <div className="apps-extra-list">{visibleExtras.map(renderExtraRow)}</div>
        </section>
      )}

      <TargetEditDialog
        target={editing}
        onClose={() => setEditing(null)}
        onSaved={async () => {
          setEditing(null);
          await refreshAll(false);
        }}
      />

      <ConfirmDialog
        open={!!pendingDelete}
        title={`从快捷列表删除「${pendingDelete?.display_name ?? ""}」？`}
        detail="该目标的所有任务关联会一并解除（任务本身不受影响）。删除后如需恢复，需要重新添加。"
        confirmLabel="删除"
        danger
        busy={deleteBusy}
        onCancel={() => setPendingDelete(null)}
        onConfirm={async () => {
          if (!pendingDelete) return;
          setDeleteBusy(true);
          try {
            await navDeleteTarget(pendingDelete.id);
            await Promise.all([loadTargets(true), loadTaskLinks()]);
            await fetchRunningStates();
            showToast("目标已删除", { kind: "success" });
            setPendingDelete(null);
          } catch (e) {
            showToast(`删除失败：${String(e)}`, { kind: "error" });
          } finally {
            setDeleteBusy(false);
          }
        }}
      />
    </div>
  );
}
