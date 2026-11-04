//! 应用与快捷方式管理：导航偏好、已保存目标（含失效清理）、默认浏览器、导航记录。
//! 与「Agent 接入管理」职责分离：这里只管普通软件与通用目标。

import { useEffect, useState } from "react";
import {
  Star, Trash2, RefreshCw, EyeOff, Eye, Rocket, ClipboardList, Navigation, Ban, Eraser, Plus, Pencil,
} from "lucide-react";
import { useSettingsStore } from "../../store/useSettingsStore";
import { useUiStore } from "../../store/useUiStore";
import { useNavigationStore } from "../../store/useNavigationStore";
import {
  navDeleteTarget, navForgetWindow, navRecentLogs, navUpdateTarget, navNavigate, navWindowMemory,
  resultMessage, TARGET_TYPE_LABELS,
  type NavLogRow, type NavTarget,
} from "../../lib/navigation";
import { ConfirmDialog, Dialog, NumberInput, Select, Switch } from "../ui";
import AppPicker from "../navigation/AppPicker";

/** 记住的窗口身份（类名+标题），targetId → 身份；无记忆的不在表里。 */
type WinMemories = Record<string, { class_name: string; title: string }>;

export default function AppManagement() {
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);
  const showToast = useUiStore((s) => s.showToast);
  const { targets, targetsLoaded, loadTargets, scan, scanning, loadApps } = useNavigationStore();
  const [logs, setLogs] = useState<NavLogRow[] | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [winMems, setWinMems] = useState<WinMemories>({});
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<NavTarget | null>(null);
  const [pendingDelete, setPendingDelete] = useState<NavTarget | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  useEffect(() => {
    if (!targetsLoaded) loadTargets();
    navRecentLogs(20).then(setLogs).catch(() => setLogs([]));
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
    await Promise.all([loadTargets(true), loadApps(true)]);
    navRecentLogs(20).then(setLogs).catch(() => {});
    showToast("应用清单已刷新", { kind: "success" });
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
        <label className="setting-row">
          <span>默认浏览器</span>
          <Select
            ariaLabel="默认浏览器"
            size="sm"
            value={settings.nav_default_browser}
            options={[
              { value: "", label: "系统默认" },
              ...browsers.map((b) => ({ value: b.app_key, label: b.display_name })),
            ]}
            onChange={(v) => update({ nav_default_browser: v })}
          />
        </label>
      </div>

      {/* 已保存目标 */}
      <div className="panel-block">
        <div className="panel-block-head">
          <span>已保存的目标（{visible.length}）</span>
          <div className="btn-group">
            <button className="btn sm primary" onClick={() => setAddOpen(true)}>
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
        {visible.length === 0 && (
          <div className="empty-hint">暂无目标；点上方「添加应用」，或从任务编辑器登记应用/网址/目录</div>
        )}
        <div className="target-admin-list">
          {visible.slice(0, 60).map((t) => (
            <div key={t.id} className="target-admin-row">
              <span className="target-admin-name" data-tip={t.exe_path || t.url || t.path}>
                {t.display_name}
              </span>
              <span className="target-admin-type">{TARGET_TYPE_LABELS[t.target_type]}</span>
              <span className="target-admin-uses">{t.use_count > 0 ? `${t.use_count} 次` : ""}</span>
              {/* 窗口记忆徽标：显示该目标记住的精确窗口身份，可一键清除 */}
              {t.target_type === "application" && winMems[t.id] && (
                <>
                  <span
                    className="chip"
                    title={`窗口: ${winMems[t.id].title}（类名 ${winMems[t.id].class_name}）`}
                  >
                    窗口记忆
                  </span>
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
                        showToast(String(e), { kind: "error" });
                      }
                    }}
                  >
                    <Eraser size={11} />
                  </button>
                </>
              )}
              <button
                className={`icon-btn sm ${t.favorite ? "default-on" : ""}`}
                data-tip={t.favorite ? "取消收藏" : "收藏"}
                aria-label={t.favorite ? `取消收藏 ${t.display_name}` : `收藏 ${t.display_name}`}
                onClick={async () => {
                  await navUpdateTarget(t.id, { favorite: !t.favorite }).catch((e) => showToast(String(e), { kind: "error" }));
                  await loadTargets(true);
                }}
              >
                <Star size={11} />
              </button>
              <button
                className={`icon-btn sm ${t.hidden ? "default-on" : ""}`}
                data-tip={t.hidden ? "取消隐藏" : "隐藏（不显示在选择器）"}
                aria-label={t.hidden ? `取消隐藏 ${t.display_name}` : `隐藏 ${t.display_name}`}
                onClick={async () => {
                  await navUpdateTarget(t.id, { hidden: !t.hidden }).catch((e) => showToast(String(e), { kind: "error" }));
                  await loadTargets(true);
                }}
              >
                {t.hidden ? <EyeOff size={11} /> : <Eye size={11} />}
              </button>
              <button
                className="icon-btn sm"
                data-tip="编辑配置"
                aria-label={`编辑 ${t.display_name}`}
                onClick={() => setEditing(t)}
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
                    setLogs(await navRecentLogs(20).catch(() => []));
                  } catch (e) {
                    showToast(String(e), { kind: "error" });
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
          ))}
        </div>
      </div>

      {/* 导航记录 */}
      <div className="panel-block">
        <div className="panel-block-head">
          <span><ClipboardList size={12} /> 最近导航记录</span>
        </div>
        {logs === null && <div className="empty-hint">加载中…</div>}
        {logs !== null && logs.length === 0 && <div className="empty-hint">暂无记录</div>}
        <div className="nav-log-list">
          {logs?.slice(0, 10).map((l) => (
            <div key={l.id} className={`nav-log-row ${l.success ? "" : "bad"}`}>
              <span className="nav-log-time">{l.created_at.slice(5, 16).replace("T", " ")}</span>
              <span className="nav-log-name" title={l.reason}>{l.target_name || l.target_id}</span>
              <span className="nav-log-action">{l.actual_action ?? l.requested_action}</span>
              {!l.success && <span title={l.reason}><Ban size={10} /></span>}
              {l.fallback_used && <span className="nav-log-fb">降级</span>}
            </div>
          ))}
        </div>
      </div>

      {/* 添加应用：独立配置模式，不关联任务；保存后共享目标列表自动刷新 */}
      {addOpen && <AppPicker standalone onClose={() => setAddOpen(false)} />}

      {/* 编辑配置（身份字段不可改，见弹窗内说明） */}
      <TargetEditDialog
        target={editing}
        onClose={() => setEditing(null)}
        onSaved={async () => {
          setEditing(null);
          await loadTargets(true);
        }}
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
            await Promise.all([loadTargets(true), useNavigationStore.getState().loadTaskLinks()]);
            showToast("目标已删除", { kind: "success" });
            setPendingDelete(null);
          } catch (e) {
            showToast(String(e), { kind: "error" });
          } finally {
            setDeleteBusy(false);
          }
        }}
      />
    </div>
  );
}

/** 编辑已保存目标：仅允许修改后端白名单字段；程序路径/网址/身份键保持只读。 */
function TargetEditDialog({
  target,
  onClose,
  onSaved,
}: {
  target: NavTarget | null;
  onClose: () => void;
  onSaved: () => Promise<void> | void;
}) {
  const showToast = useUiStore((s) => s.showToast);
  const [name, setName] = useState("");
  const [args, setArgs] = useState("");
  const [cwd, setCwd] = useState("");
  const [titleHint, setTitleHint] = useState("");
  const [favorite, setFavorite] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!target) return;
    setName(target.display_name);
    setArgs(target.launch_args);
    setCwd(target.working_dir);
    setTitleHint(target.window_title_hint);
    setFavorite(target.favorite);
    setHidden(target.hidden);
  }, [target]);

  if (!target) return null;
  const targetId = target.id;
  const isApp = target.target_type === "application";
  const identity = isApp ? target.exe_path : target.target_type === "url" ? target.url : target.path;

  async function save() {
    const trimmed = name.trim();
    if (!trimmed) {
      showToast("显示名称不能为空", { kind: "error" });
      return;
    }
    setBusy(true);
    try {
      const patch = {
        display_name: trimmed,
        favorite,
        hidden,
        ...(isApp
          ? {
              launch_args: args.trim(),
              working_dir: cwd.trim(),
              window_title_hint: titleHint.trim(),
            }
          : {}),
      };
      // 身份字段（EXE 路径 / 网址 / 目录）不在后端白名单内，前端不伪造。
      await navUpdateTarget(targetId, patch);
      showToast("配置已保存", { kind: "success" });
      await onSaved();
    } catch (e) {
      showToast(String(e), { kind: "error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="编辑应用配置"
      size="md"
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>取消</button>
          <button className="btn primary" onClick={save} disabled={busy}>保存</button>
        </>
      }
    >
      <div className="target-edit-form">
        <label className="target-edit-field">
          <span>显示名称</span>
          <input
            className="input"
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
            aria-label="显示名称"
          />
        </label>
        <div className="endpoint-hint">
          目标身份：{identity || "—"}。路径/网址属于身份字段，不能在此修改；如需更换请新增目标后删除旧项。
        </div>
        {isApp && (
          <>
            <label className="target-edit-field">
              <span>启动参数</span>
              <input
                className="input"
                value={args}
                onChange={(e) => setArgs(e.target.value)}
                placeholder="留空表示无参数"
                aria-label="启动参数"
              />
            </label>
            <label className="target-edit-field">
              <span>工作目录</span>
              <input
                className="input"
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
                placeholder="留空表示使用程序所在目录"
                aria-label="工作目录"
              />
            </label>
            <label className="target-edit-field">
              <span>窗口标题匹配提示</span>
              <input
                className="input"
                value={titleHint}
                onChange={(e) => setTitleHint(e.target.value)}
                placeholder="用于多窗口时优先匹配，可留空"
                aria-label="窗口标题匹配提示"
              />
            </label>
          </>
        )}
        <div className="setting-row">
          <span>收藏（工具面板优先展示）</span>
          <Switch checked={favorite} ariaLabel="收藏" onChange={setFavorite} />
        </div>
        <div className="setting-row">
          <span>隐藏（不显示在选择器与工具面板）</span>
          <Switch checked={hidden} ariaLabel="隐藏" onChange={setHidden} />
        </div>
      </div>
    </Dialog>
  );
}
