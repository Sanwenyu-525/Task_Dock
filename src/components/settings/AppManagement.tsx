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

/** 记住的窗口身份（类名+标题），targetId → 身份；无记忆的不在表里。 */
type WinMemories = Record<string, { class_name: string; title: string }>;

/** 导航动作的易读名称；原始标识保留在 `data-action` / title 中供诊断。 */
const NAV_ACTION_LABELS: Record<string, string> = {
  open_app: "启动应用",
  focus_window: "聚焦窗口",
  open_url: "打开网址",
  open_file: "打开文件",
  reveal_file: "定位文件",
  open_directory: "打开目录",
  resume_session: "继续会话",
  fallback: "降级处理",
};

function navActionLabel(action: string | null | undefined): string {
  if (!action) return "未知动作";
  return NAV_ACTION_LABELS[action] ?? action;
}

export default function AppManagement({
  onRequestAdd,
}: {
  /** 由外层页面接管「添加应用」子页面（避免在设置页内部再叠一层弹窗）。 */
  onRequestAdd?: () => void;
} = {}) {
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
    if (targetsOutcome === "error") problems.push(`应用清单：${state.targetsError ?? "读取失败"}`);
    if (scanOutcome === "error") problems.push(`应用扫描：${state.scanError ?? "扫描失败"}`);
    if (problems.length > 0) {
      showToast(`刷新部分失败：${problems.join("；")}`, {
        kind: "warning",
        action: { label: "重试", run: () => void refresh() },
      });
      return;
    }
    // 两次刷新都已被更新的请求取代：结果由那次请求落地，不重复提示成功。
    if (targetsOutcome === "stale" && scanOutcome === "stale") return;
    showToast("应用清单已刷新", { kind: "success" });
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
          <span><Navigation size={12} /> 导航偏好</span>
        </div>
        <div className="setting-row">
          <span>优先唤醒现有窗口（而非重复启动）</span>
          <Switch
            checked={settings.nav_prefer_focus}
            ariaLabel="优先唤醒现有窗口（而非重复启动）"
            onChange={(v) => update({ nav_prefer_focus: v })}
          />
        </div>
        <div className="setting-row">
          <span>允许启动未运行的程序</span>
          <Switch
            checked={settings.nav_allow_launch}
            ariaLabel="允许启动未运行的程序"
            onChange={(v) => update({ nav_allow_launch: v })}
          />
        </div>
        <div className="setting-row">
          <span>精准跳转失败时按层级降级（关闭则直接报错）</span>
          <Switch
            checked={settings.nav_fallback}
            ariaLabel="精准跳转失败时按层级降级（关闭则直接报错）"
            onChange={(v) => update({ nav_fallback: v })}
          />
        </div>
        <div className="setting-row">
          <span>记住上次选择的窗口（多窗口应用）</span>
          <Switch
            checked={settings.nav_remember_window}
            ariaLabel="记住上次选择的窗口（多窗口应用）"
            onChange={(v) => update({ nav_remember_window: v })}
          />
        </div>
        <div className="setting-row">
          <span>工作区批量启动数量上限（{settings.nav_workspace_max}）</span>
          <NumberInput
            value={settings.nav_workspace_max}
            min={1}
            max={20}
            ariaLabel="工作区批量启动数量上限（{settings.nav_workspace_max}）"
            onChange={(v) => update({ nav_workspace_max: v })}
          />
        </div>
        <div className="setting-row">
          <span>默认浏览器</span>
          <Select
            ariaLabel="默认浏览器"
            size="sm"
            triggerClassName="settings-select-trigger"
            value={settings.nav_default_browser}
            options={[
              { value: "", label: "系统默认" },
              ...browsers.map((b) => ({ value: b.app_key, label: b.display_name })),
            ]}
            onChange={(v) => update({ nav_default_browser: v })}
          />
        </div>
      </div>

      {/* 已保存目标 */}
      <div className="panel-block">
        <div className="panel-block-head">
          <span>已保存的目标（{visible.length}）</span>
          <div className="btn-group">
            <button
              className="btn sm primary"
              onClick={requestAdd}
            >
              <Plus size={12} /> 添加应用
            </button>
            <button
              className="btn sm"
              onClick={() => setShowHidden((v) => !v)}
              data-tip={showHidden ? "隐藏已隐藏项" : "显示隐藏项"}
              aria-label={showHidden ? "隐藏已隐藏项" : "显示隐藏项"}
            >
              {showHidden ? <Eye size={12} /> : <EyeOff size={12} />}
            </button>
            <button className="btn sm" onClick={refresh} disabled={scanning}>
              <RefreshCw size={12} className={scanning ? "spin" : ""} /> 重新扫描
            </button>
          </div>
        </div>
        {scan && (
          <div className="endpoint-hint">
            最近扫描 {scan.counts.startmenu ?? 0} 个开始菜单 / {scan.counts.registry ?? 0} 个注册表 /
            {" "}{scan.counts.uwp ?? 0} 个商店应用 / {scan.counts.known ?? 0} 个常用位置（{scan.duration_ms}ms）
          </div>
        )}
        {(targetsError || scanError) && (
          // Toast 消失后仍可在此查看持续故障；重试成功后 store 自动清除
          <div className="empty-hint error-text" role="status">
            {targetsError && <div>应用清单读取失败：{targetsError}（列表为上次结果，可能不是最新）</div>}
            {scanError && <div>应用扫描失败：{scanError}</div>}
            <button className="btn sm" onClick={() => void refresh()}>
              重试
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
          <div className="empty-hint">暂无目标；点上方「添加应用」，或从任务编辑器登记应用/网址/目录</div>
        )}
        <div className="target-admin-list">
          {visible.slice(0, 60).map((t) => (
            <div key={t.id} className="target-admin-row">
              <div className="target-admin-main">
                <span className="target-admin-name" data-tip={t.exe_path || t.url || t.path}>
                  {t.display_name}
                </span>
                <span className="target-admin-meta">
                  {TARGET_TYPE_LABELS[t.target_type]}
                  {t.use_count > 0 ? ` · ${t.use_count} 次` : ""}
                </span>
                {/* 窗口记忆徽标：显示该目标记住的精确窗口身份，可在操作区一键清除 */}
                {t.target_type === "application" && winMems[t.id] && (
                  <span
                    className="chip target-admin-memory"
                    title={`窗口: ${winMems[t.id].title}（类名 ${winMems[t.id].class_name}）`}
                  >
                    窗口记忆
                  </span>
                )}
              </div>
              <div className="target-admin-ops">
                {t.target_type === "application" && winMems[t.id] && (
                  <button
                    className="icon-btn sm"
                    data-tip="清除窗口记忆（下次导航恢复按标题匹配）"
                    aria-label={`清除窗口记忆 ${t.display_name}`}
                    onClick={async () => {
                      try {
                        await navForgetWindow(t.id);
                        setWinMems((prev) => {
                          const next = { ...prev };
                          delete next[t.id];
                          return next;
                        });
                        showToast("已清除窗口记忆", { kind: "success" });
                      } catch (e) {
                        showToast(`清除窗口记忆失败：${errorMessage(e)}`, { kind: "error" });
                      }
                    }}
                  >
                    <Eraser size={11} />
                  </button>
                )}
              <button
                className={`icon-btn sm ${t.favorite ? "default-on" : ""}`}
                data-tip={t.favorite ? "取消收藏" : "收藏"}
                aria-label={t.favorite ? `取消收藏 ${t.display_name}` : `收藏 ${t.display_name}`}
                onClick={async () => {
                  try {
                    await navUpdateTarget(t.id, { favorite: !t.favorite });
                  } catch (e) {
                    showToast(`收藏操作失败：${errorMessage(e)}`, { kind: "error" });
                    return;
                  }
                  const outcome = await loadTargets(true);
                  if (outcome === "error") {
                    showToast("已更新收藏，但列表刷新失败", {
                      kind: "warning",
                      action: { label: "重试刷新", run: () => void loadTargets(true) },
                    });
                  }
                }}
              >
                <Star size={11} />
              </button>
              <button
                className={`icon-btn sm ${t.hidden ? "default-on" : ""}`}
                data-tip={t.hidden ? "取消隐藏" : "隐藏（不显示在选择器）"}
                aria-label={t.hidden ? `取消隐藏 ${t.display_name}` : `隐藏 ${t.display_name}`}
                onClick={async () => {
                  try {
                    await navUpdateTarget(t.id, { hidden: !t.hidden });
                  } catch (e) {
                    showToast(`隐藏操作失败：${errorMessage(e)}`, { kind: "error" });
                    return;
                  }
                  const outcome = await loadTargets(true);
                  if (outcome === "error") {
                    showToast("已更新隐藏状态，但列表刷新失败", {
                      kind: "warning",
                      action: { label: "重试刷新", run: () => void loadTargets(true) },
                    });
                  }
                }}
              >
                {t.hidden ? <EyeOff size={11} /> : <Eye size={11} />}
              </button>
              <button
                className="icon-btn sm"
                data-tip="编辑配置"
                aria-label={`编辑 ${t.display_name}`}
                onClick={() => requestEdit(t)}
              >
                <Pencil size={11} />
              </button>
              <button
                className="icon-btn sm"
                data-tip="测试启动 / 聚焦窗口"
                aria-label={`测试启动 ${t.display_name}`}
                onClick={async () => {
                  try {
                    const r = await navNavigate(t.id);
                    showToast(resultMessage(r, t.display_name), { kind: r.success ? "success" : "error" });
                    // 仅在后端确认成功后才刷新「最近使用」；失败时保真实状态。
                    if (r.success) await loadTargets(true);
                    // 记录读取失败不能伪装成「暂无记录」：走 loadLogs 设置可见错误态。
                    loadLogs();
                  } catch (e) {
                    showToast(`启动失败：${errorMessage(e)}`, { kind: "error" });
                  }
                }}
              >
                <Rocket size={11} />
              </button>
              <button
                className="icon-btn sm"
                data-tip="删除目标（关联任务会同步解除）"
                aria-label={`删除 ${t.display_name}`}
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
          <span><ClipboardList size={12} /> 最近导航记录</span>
        </div>
        {logsError && (
          <div className="empty-hint error-text" role="status">
            导航记录读取失败：{logsError}
            <button className="btn sm" onClick={() => void loadLogs()}>
              重试
            </button>
          </div>
        )}
        {!logsError && logs === null && <div className="empty-hint">加载中…</div>}
        {!logsError && logs !== null && logs.length === 0 && <div className="empty-hint">暂无记录</div>}
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
                  {navActionLabel(rawAction)}
                </span>
                {!l.success && <span title={l.reason}><Ban size={10} /></span>}
                {l.fallback_used && <span className="nav-log-fb">降级</span>}
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

      {/* 删除确认：明确提示任务关联会被解除 */}
      <ConfirmDialog
        open={!!pendingDelete}
        title={`删除「${pendingDelete?.display_name ?? ""}」？`}
        detail="该目标的所有任务关联会一并解除（任务本身不受影响）。删除后如需恢复，需要在任务编辑器或应用选择器中重新添加。"
        confirmLabel="删除"
        danger
        busy={deleteBusy}
        onCancel={() => setPendingDelete(null)}
        onConfirm={async () => {
          if (!pendingDelete) return;
          setDeleteBusy(true);
          try {
            await navDeleteTarget(pendingDelete.id);
          } catch (e) {
            showToast(`删除失败：${errorMessage(e)}`, { kind: "error" });
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
            showToast("目标已删除，但关联列表刷新失败", {
              kind: "warning",
              action: {
                label: "重试刷新",
                run: () => {
                  void Promise.all([
                    loadTargets(true),
                    useNavigationStore.getState().loadTaskLinks(),
                  ]);
                },
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
