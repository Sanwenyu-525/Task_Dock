//! 应用与快捷方式管理：导航偏好、已保存目标（含失效清理）、默认浏览器、导航记录。
//! 与「Agent 接入管理」职责分离：这里只管普通软件与通用目标。

import { useEffect, useState } from "react";
import {
  Star, Trash2, RefreshCw, EyeOff, Eye, Rocket, ClipboardList, Navigation, Ban, Eraser, Plus, Pencil,
} from "lucide-react";
import { useSettingsStore } from "../../store/useSettingsStore";
import { useUiStore } from "../../store/useUiStore";
import { useNavigationStore } from "../../store/useNavigationStore";
import { errorMessage } from "../../lib/errors";
import {
  navDeleteTarget, navForgetWindow, navRecentLogs, navUpdateTarget, navNavigate, navWindowMemory,
  resultMessage, TARGET_TYPE_LABELS,
  type NavLogRow, type NavTarget,
} from "../../lib/navigation";
import { ConfirmDialog, NumberInput, Select, Switch } from "../ui";
import AppPicker from "../navigation/AppPicker";
import TargetEditForm from "../apps/TargetEditForm";
import { useLocale } from "../../hooks/useLocale";
import type { MessageKey } from "../../i18n";

/** 记住的窗口身份（类名+标题），targetId → 身份；无记忆的不在表里。 */
type WinMemories = Record<string, { class_name: string; title: string }>;

/** 导航动作的易读名称；原始标识保留在 `data-action` / title 中供诊断。 */
const NAV_ACTION_KEYS: Record<string, MessageKey> = {
  open_app: "appMgmt.action.open_app",
  focus_window: "appMgmt.action.focus_window",
  open_url: "appMgmt.action.open_url",
  open_file: "appMgmt.action.open_file",
  reveal_file: "appMgmt.action.reveal_file",
  open_directory: "appMgmt.action.open_directory",
  resume_session: "appMgmt.action.resume_session",
  fallback: "appMgmt.action.fallback",
};

const TARGET_TYPE_KEYS: Record<string, MessageKey> = {
  application: "appMgmt.type.application",
  url: "appMgmt.type.url",
  file: "appMgmt.type.file",
  directory: "appMgmt.type.directory",
  agent_session: "appMgmt.type.agentSession",
};

function navActionLabel(
  action: string | null | undefined,
  t: (key: MessageKey, params?: Record<string, string | number | undefined>) => string,
): string {
  if (!action) return t("appMgmt.action.unknown");
  const key = NAV_ACTION_KEYS[action];
  return key ? t(key) : action;
}

export default function AppManagement({
  onRequestAdd,
}: {
  /** 由外层页面接管「添加应用」子页面（避免在设置页内部再叠一层弹窗）。 */
  onRequestAdd?: () => void;
} = {}) {
  const { t: tr } = useLocale();
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);
  const showToast = useUiStore((s) => s.showToast);
  const { targets, targetsLoaded, targetsError, scan, scanError, scanning, loadTargets, loadApps } =
    useNavigationStore();
  const [logs, setLogs] = useState<NavLogRow[] | null>(null);
  /** 导航记录读取失败：不能把失败当成「暂无记录」 */
  const [logsError, setLogsError] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [winMems, setWinMems] = useState<WinMemories>({});
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<NavTarget | null>(null);
  /** 页内编辑表单脏状态：切换目标/进入添加页前用于离开保护 */
  const [editorDirty, setEditorDirty] = useState(false);
  const [pendingLeave, setPendingLeave] = useState<
    { kind: "edit"; target: NavTarget } | { kind: "add" } | null
  >(null);
  const [pendingDelete, setPendingDelete] = useState<NavTarget | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  function loadLogs() {
    navRecentLogs(20)
      .then((rows) => {
        setLogs(rows);
        setLogsError(null);
      })
      .catch((e) => setLogsError(errorMessage(e)));
  }

  useEffect(() => {
    if (!targetsLoaded) loadTargets();
    loadLogs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 本页展示扫描结果，登记为扫描订阅者：离开设置页时若没有其他入口仍在展示，
  // 由 store 通知后端取消在途扫描；其他入口在用时不会被误取消。
  useEffect(() => useNavigationStore.getState().attachScanViewer(), []);

  // 窗口记忆可见化：目标清单就绪后逐个查询 application 目标记住的窗口身份
  // （类名+标题），供用户查看与清除。查询失败静默视为无记忆；
  // 分批限并发，目标很多时不打爆 IPC。targets 变化（增删/刷新）后重查保持新鲜。
  useEffect(() => {
    if (!targetsLoaded) return;
    let cancelled = false;
    const apps = targets.filter((t) => t.target_type === "application");
    (async () => {
      const BATCH = 4;
      for (let i = 0; i < apps.length; i += BATCH) {
        const batch = apps.slice(i, i + BATCH);
        const found = await Promise.all(
          batch.map(async (t) => {
            try {
              const m = await navWindowMemory(t.id);
              return m ? ([t.id, m] as const) : null;
            } catch {
              return null; // 查询失败 = 无记忆，不打扰用户
            }
          }),
        );
        if (cancelled) return;
        setWinMems((prev) => {
          const next = { ...prev };
          // 先清掉本批旧值（目标可能已无记忆），再写入本批结果
          for (const t of batch) delete next[t.id];
          for (const r of found) if (r) next[r[0]] = r[1];
          return next;
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [targetsLoaded, targets]);

  // 失效检测说明：浏览器环境无法同步探测本地路径；目标失效由后端在
  // running_state=unavailable（任务关联视图）与导航失败记录中如实呈现。

  const browsers = targets.filter((t) => t.target_type === "application" && t.category === "browser");

  async function refresh() {
    // 用本次调用的返回值判定结果，不靠读旧 store 状态；并发刷新时以最后一次为准。
    const [targetsOutcome, scanOutcome] = await Promise.all([
      loadTargets(true),
      loadApps(true),
    ]);
    loadLogs();
    const state = useNavigationStore.getState();
    const problems: string[] = [];
    if (targetsOutcome === "error")
      problems.push(
        tr("appMgmt.refresh.targets", {
          error: state.targetsError ?? tr("appMgmt.refresh.readFailed"),
        }),
      );
    if (scanOutcome === "error")
      problems.push(
        tr("appMgmt.refresh.scan", {
          error: state.scanError ?? tr("appMgmt.refresh.scanFailed"),
        }),
      );
    if (problems.length > 0) {
      // 重试只执行确实失败的那一项：已成功的请求不重复发起。
      const targetsNeedRetry = targetsOutcome === "error";
      const scanNeedRetry = scanOutcome === "error";
      showToast(tr("appMgmt.refresh.partial", { problems: problems.join("; ") }), {
        kind: "warning",
        action: {
          label: tr("appMgmt.refresh.retry"),
          run: () => {
            if (targetsNeedRetry && !scanNeedRetry) void refreshTargetsOnly();
            else if (scanNeedRetry && !targetsNeedRetry) void refreshScanOnly();
            else void refresh();
          },
        },
      });
      return;
    }
    // 只有两项都由本次调用真正完成，才可以提示整体成功。
    if (targetsOutcome === "ok" && scanOutcome === "ok") {
      showToast(tr("appMgmt.refresh.done"), { kind: "success" });
      return;
    }
    // stale（被更新请求取代/已有在途请求）与 cancelled（扫描被取消）都不是本次成功：
    // 只陈述真实情况，不宣称「全部刷新完成」，也不重复提示成功。
    const notes: string[] = [];
    if (targetsOutcome === "stale") notes.push(tr("appMgmt.refresh.targetsStale"));
    if (scanOutcome === "stale") notes.push(tr("appMgmt.refresh.scanStale"));
    if (scanOutcome === "cancelled") notes.push(tr("appMgmt.refresh.scanCancelled"));
    showToast(tr("appMgmt.refresh.shared", { detail: notes.join("; ") }), { kind: "info" });
  }

  /** 定向重试：只刷新目标清单（扫描已成功或不属于失败项）。 */
  async function refreshTargetsOnly() {
    const outcome = await loadTargets(true);
    if (outcome === "ok") {
      showToast(tr("appMgmt.refresh.done"), { kind: "success" });
      return;
    }
    if (outcome !== "error") return; // stale：由其他刷新落地
    const reason = useNavigationStore.getState().targetsError ?? tr("appMgmt.refresh.readFailed");
    showToast(
      tr("appMgmt.refresh.partial", {
        problems: tr("appMgmt.refresh.targets", { error: reason }),
      }),
      {
        kind: "warning",
        action: { label: tr("appMgmt.refresh.retry"), run: () => void refreshTargetsOnly() },
      },
    );
  }

  /** 定向重试：只重新扫描（目标清单已成功或不属于失败项）。 */
  async function refreshScanOnly() {
    const outcome = await loadApps(true);
    if (outcome === "ok") {
      showToast(tr("appMgmt.refresh.scanDone"), { kind: "success" });
      return;
    }
    if (outcome === "cancelled") {
      showToast(tr("appMgmt.refresh.scanCancelled"), { kind: "info" });
      return;
    }
    if (outcome !== "error") return; // stale：由在途扫描负责
    const reason = useNavigationStore.getState().scanError ?? tr("appMgmt.refresh.scanFailed");
    showToast(
      tr("appMgmt.refresh.partial", {
        problems: tr("appMgmt.refresh.scan", { error: reason }),
      }),
      {
        kind: "warning",
        action: { label: tr("appMgmt.refresh.retry"), run: () => void refreshScanOnly() },
      },
    );
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
    if (onRequestAdd) onRequestAdd();
    else setAddOpen(true);
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
    if (onRequestAdd) onRequestAdd();
    else setAddOpen(true);
  }

  if (!settings) return null;

  const visible = targets.filter((t) => showHidden || !t.hidden);

  return (
    <div className="app-management">
      {/* 导航偏好 */}
      <div className="panel-block">
        <div className="panel-block-head">
          <span><Navigation size={12} /> {tr("appMgmt.prefs.title")}</span>
        </div>
        <div className="setting-row">
          <span>{tr("appMgmt.prefs.reuseWindow")}</span>
          <Switch
            checked={settings.nav_prefer_focus}
            ariaLabel={tr("appMgmt.prefs.reuseWindow")}
            onChange={(v) => update({ nav_prefer_focus: v })}
          />
        </div>
        <div className="setting-row">
          <span>{tr("appMgmt.prefs.launchNotRunning")}</span>
          <Switch
            checked={settings.nav_allow_launch}
            ariaLabel={tr("appMgmt.prefs.launchNotRunning")}
            onChange={(v) => update({ nav_allow_launch: v })}
          />
        </div>
        <div className="setting-row">
          <span>{tr("appMgmt.prefs.fallback")}</span>
          <Switch
            checked={settings.nav_fallback}
            ariaLabel={tr("appMgmt.prefs.fallback")}
            onChange={(v) => update({ nav_fallback: v })}
          />
        </div>
        <div className="setting-row">
          <span>{tr("appMgmt.prefs.rememberWindow")}</span>
          <Switch
            checked={settings.nav_remember_window}
            ariaLabel={tr("appMgmt.prefs.rememberWindow")}
            onChange={(v) => update({ nav_remember_window: v })}
          />
        </div>
        <div className="setting-row">
          <span>{tr("appMgmt.prefs.workspaceMax", { max: settings.nav_workspace_max })}</span>
          <NumberInput
            value={settings.nav_workspace_max}
            min={1}
            max={20}
            ariaLabel={tr("appMgmt.prefs.workspaceMax", { max: settings.nav_workspace_max })}
            onChange={(v) => update({ nav_workspace_max: v })}
          />
        </div>
        <div className="setting-row">
          <span>{tr("appMgmt.prefs.defaultBrowser")}</span>
          <Select
            ariaLabel={tr("appMgmt.prefs.defaultBrowser")}
            size="sm"
            triggerClassName="settings-select-trigger"
            value={settings.nav_default_browser}
            options={[
              { value: "", label: tr("appMgmt.prefs.systemDefault") },
              ...browsers.map((b) => ({ value: b.app_key, label: b.display_name })),
            ]}
            onChange={(v) => update({ nav_default_browser: v })}
          />
        </div>
      </div>

      {/* 已保存目标 */}
      <div className="panel-block">
        <div className="panel-block-head">
          <span>{tr("appMgmt.targets.savedHeader", { count: visible.length })}</span>
          <div className="btn-group">
            <button
              className="btn sm primary"
              onClick={requestAdd}
            >
              <Plus size={12} /> {tr("appMgmt.targets.addApp")}
            </button>
            <button
              className="btn sm"
              onClick={() => setShowHidden((v) => !v)}
              data-tip={
                showHidden ? tr("appMgmt.targets.hideHidden") : tr("appMgmt.targets.showHidden")
              }
              aria-label={
                showHidden ? tr("appMgmt.targets.hideHidden") : tr("appMgmt.targets.showHidden")
              }
            >
              {showHidden ? <Eye size={12} /> : <EyeOff size={12} />}
            </button>
            <button className="btn sm" onClick={refresh} disabled={scanning}>
              <RefreshCw size={12} className={scanning ? "spin" : ""} />{" "}
              {tr("appMgmt.targets.rescan")}
            </button>
          </div>
        </div>
        {scan && (
          <div className="endpoint-hint">
            {tr("appMgmt.targets.scanSummary", {
              startmenu: scan.counts.startmenu ?? 0,
              registry: scan.counts.registry ?? 0,
              uwp: scan.counts.uwp ?? 0,
              known: scan.counts.known ?? 0,
              ms: scan.duration_ms,
            })}
          </div>
        )}
        {(targetsError || scanError) && (
          // Toast 消失后仍可在此查看持续故障；重试成功后 store 自动清除
          <div className="empty-hint error-text" role="status">
            {targetsError && (
              <div>{tr("appMgmt.targets.targetsFailed", { error: targetsError })}</div>
            )}
            {scanError && <div>{tr("appMgmt.targets.scanFailed", { error: scanError })}</div>}
            <button className="btn sm" onClick={() => void refresh()}>
              {tr("appMgmt.refresh.retry")}
            </button>
          </div>
        )}
        {editing && (
          <TargetEditForm
            key={editing.id}
            target={editing}
            onClose={closeEditor}
            onSaved={async () => {
              closeEditor();
              await loadTargets(true);
            }}
            onDirtyChange={setEditorDirty}
          />
        )}
        {visible.length === 0 && (
          <div className="empty-hint">{tr("appMgmt.targets.empty")}</div>
        )}
        <div className="target-admin-list">
          {visible.slice(0, 60).map((t) => (
            <div key={t.id} className="target-admin-row">
              <div className="target-admin-main">
                <span className="target-admin-name" data-tip={t.exe_path || t.url || t.path}>
                  {t.display_name}
                </span>
                <span className="target-admin-meta">
                  {TARGET_TYPE_KEYS[t.target_type]
                    ? tr(TARGET_TYPE_KEYS[t.target_type] as MessageKey)
                    : TARGET_TYPE_LABELS[t.target_type]}
                  {t.use_count > 0 ? tr("appMgmt.targets.useCount", { count: t.use_count }) : ""}
                </span>
                {/* 窗口记忆徽标：显示该目标记住的精确窗口身份，可在操作区一键清除 */}
                {t.target_type === "application" && winMems[t.id] && (
                  <span
                    className="chip target-admin-memory"
                    title={tr("appMgmt.targets.windowTitle", {
                      title: winMems[t.id].title,
                      className: winMems[t.id].class_name,
                    })}
                  >
                    {tr("appMgmt.targets.memoryBadge")}
                  </span>
                )}
              </div>
              <div className="target-admin-ops">
                {t.target_type === "application" && winMems[t.id] && (
                  <button
                    className="icon-btn sm"
                    data-tip={tr("appMgmt.targets.clearMemory")}
                    aria-label={tr("appMgmt.targets.clearMemoryAria", {
                      name: t.display_name,
                    })}
                    onClick={async () => {
                      try {
                        await navForgetWindow(t.id);
                        setWinMems((prev) => {
                          const next = { ...prev };
                          delete next[t.id];
                          return next;
                        });
                        showToast(tr("appMgmt.targets.memoryCleared"), { kind: "success" });
                      } catch (e) {
                        showToast(
                          tr("appMgmt.targets.memoryClearFailed", { error: errorMessage(e) }),
                          { kind: "error" },
                        );
                      }
                    }}
                  >
                    <Eraser size={11} />
                  </button>
                )}
              <button
                className={`icon-btn sm ${t.favorite ? "default-on" : ""}`}
                data-tip={
                  t.favorite ? tr("appMgmt.targets.unfavorite") : tr("appMgmt.targets.favorite")
                }
                aria-label={
                  t.favorite
                    ? tr("appMgmt.targets.unfavoriteAria", { name: t.display_name })
                    : tr("appMgmt.targets.favoriteAria", { name: t.display_name })
                }
                onClick={async () => {
                  try {
                    await navUpdateTarget(t.id, { favorite: !t.favorite });
                  } catch (e) {
                    showToast(tr("appMgmt.targets.favoriteFailed", { error: errorMessage(e) }), {
                      kind: "error",
                    });
                    return;
                  }
                  const outcome = await loadTargets(true);
                  if (outcome === "error") {
                    showToast(tr("appMgmt.targets.favoriteStale"), {
                      kind: "warning",
                      action: {
                        label: tr("appMgmt.targets.retryRefresh"),
                        run: () => void loadTargets(true),
                      },
                    });
                  }
                }}
              >
                <Star size={11} fill={t.favorite ? "currentColor" : "none"} />
              </button>
              <button
                className={`icon-btn sm ${t.hidden ? "default-on" : ""}`}
                data-tip={t.hidden ? tr("appMgmt.targets.unhide") : tr("appMgmt.targets.hide")}
                aria-label={
                  t.hidden
                    ? tr("appMgmt.targets.unhideAria", { name: t.display_name })
                    : tr("appMgmt.targets.hideAria", { name: t.display_name })
                }
                onClick={async () => {
                  try {
                    await navUpdateTarget(t.id, { hidden: !t.hidden });
                  } catch (e) {
                    showToast(tr("appMgmt.targets.hideFailed", { error: errorMessage(e) }), {
                      kind: "error",
                    });
                    return;
                  }
                  const outcome = await loadTargets(true);
                  if (outcome === "error") {
                    showToast(tr("appMgmt.targets.hideStale"), {
                      kind: "warning",
                      action: {
                        label: tr("appMgmt.targets.retryRefresh"),
                        run: () => void loadTargets(true),
                      },
                    });
                  }
                }}
              >
                {t.hidden ? <EyeOff size={11} /> : <Eye size={11} />}
              </button>
              <button
                className="icon-btn sm"
                data-tip={tr("appMgmt.targets.editTip")}
                aria-label={tr("appMgmt.targets.editAria", { name: t.display_name })}
                onClick={() => requestEdit(t)}
              >
                <Pencil size={11} />
              </button>
              <button
                className="icon-btn sm"
                data-tip={tr("appMgmt.targets.testTip")}
                aria-label={tr("appMgmt.targets.testAria", { name: t.display_name })}
                onClick={async () => {
                  try {
                    const r = await navNavigate(t.id);
                    showToast(resultMessage(r, t.display_name), { kind: r.success ? "success" : "error" });
                    // 仅在后端确认成功后才刷新「最近使用」；失败时保真实状态。
                    if (r.success) await loadTargets(true);
                    // 记录读取失败不能伪装成「暂无记录」：走 loadLogs 设置可见错误态。
                    loadLogs();
                  } catch (e) {
                    showToast(tr("appMgmt.targets.launchFailed", { error: errorMessage(e) }), {
                      kind: "error",
                    });
                  }
                }}
              >
                <Rocket size={11} />
              </button>
              <button
                className="icon-btn sm"
                data-tip={tr("appMgmt.targets.deleteTip")}
                aria-label={tr("appMgmt.targets.deleteAria", { name: t.display_name })}
                onClick={() => setPendingDelete(t)}
              >
                <Trash2 size={11} />
              </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 导航记录 */}
      <div className="panel-block">
        <div className="panel-block-head">
          <span><ClipboardList size={12} /> {tr("appMgmt.logs.title")}</span>
        </div>
        {logsError && (
          <div className="empty-hint error-text" role="status">
            {tr("appMgmt.logs.failed", { error: logsError })}
            <button className="btn sm" onClick={() => void loadLogs()}>
              {tr("appMgmt.refresh.retry")}
            </button>
          </div>
        )}
        {!logsError && logs === null && (
          <div className="empty-hint">{tr("appMgmt.logs.loading")}</div>
        )}
        {!logsError && logs !== null && logs.length === 0 && (
          <div className="empty-hint">{tr("appMgmt.logs.empty")}</div>
        )}
        <div className="nav-log-list">
          {logs?.slice(0, 10).map((l) => {
            const rawAction = l.actual_action ?? l.requested_action;
            return (
              <div key={l.id} className={`nav-log-row ${l.success ? "" : "bad"}`}>
                <span className="nav-log-time">{l.created_at.slice(5, 16).replace("T", " ")}</span>
                <span className="nav-log-name" title={l.reason}>{l.target_name || l.target_id}</span>
                <span
                  className="nav-log-action"
                  data-action={rawAction}
                  title={rawAction}
                >
                  {navActionLabel(rawAction, tr)}
                </span>
                {!l.success && <span title={l.reason}><Ban size={10} /></span>}
                {l.fallback_used && (
                  <span className="nav-log-fb">{tr("appMgmt.logs.fallback")}</span>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* 添加应用：独立配置模式；有外层页面时由其渲染子页面，避免叠弹窗 */}
      {addOpen && <AppPicker standalone variant="page" onClose={() => setAddOpen(false)} />}

      {/* 编辑配置：页内表单，身份字段只读（见表单内说明） */}
      <ConfirmDialog
        open={!!pendingLeave}
        title={tr("appMgmt.leave.title")}
        detail={
          pendingLeave?.kind === "edit"
            ? tr("appMgmt.leave.detailEditing", { name: editing?.display_name ?? "" })
            : tr("appMgmt.leave.detailDirty")
        }
        confirmLabel={tr("appMgmt.leave.confirm")}
        danger
        onCancel={() => setPendingLeave(null)}
        onConfirm={applyPendingLeave}
      />

      {/* 删除确认：明确提示任务关联会被解除 */}
      <ConfirmDialog
        open={!!pendingDelete}
        title={tr("appMgmt.delete.title", { name: pendingDelete?.display_name ?? "" })}
        detail={tr("appMgmt.delete.detail")}
        confirmLabel={tr("appMgmt.delete.confirm")}
        danger
        busy={deleteBusy}
        onCancel={() => setPendingDelete(null)}
        onConfirm={async () => {
          if (!pendingDelete) return;
          setDeleteBusy(true);
          try {
            await navDeleteTarget(pendingDelete.id);
          } catch (e) {
            showToast(tr("appMgmt.delete.failed", { error: errorMessage(e) }), { kind: "error" });
            setDeleteBusy(false);
            return;
          }
          setPendingDelete(null);
          // 删除已成功：刷新失败只能标为「部分成功」，不能报成删除失败。
          const [tOutcome, lOutcome] = await Promise.all([
            loadTargets(true),
            useNavigationStore.getState().loadTaskLinks(),
          ]);
          if (tOutcome === "error" || lOutcome === "error") {
            showToast(tr("appMgmt.delete.stale"), {
              kind: "warning",
              action: {
                label: tr("appMgmt.targets.retryRefresh"),
                run: () => {
                  void Promise.all([
                    loadTargets(true),
                    useNavigationStore.getState().loadTaskLinks(),
                  ]);
                },
              },
            });
          } else if (tOutcome === "ok") {
            showToast(tr("appMgmt.delete.done"), { kind: "success" });
          }
          setDeleteBusy(false);
        }}
      />
    </div>
  );
}
