//! 应用与快捷方式管理：导航偏好、已保存目标（含失效清理）、默认浏览器、导航记录。
//! 与「Agent 接入管理」职责分离：这里只管普通软件与通用目标。

import { useEffect, useState } from "react";
import {
  Star, Trash2, RefreshCw, EyeOff, Eye, Rocket, ClipboardList, Navigation, Ban, Eraser,
} from "lucide-react";
import { useSettingsStore } from "../../store/useSettingsStore";
import { useUiStore } from "../../store/useUiStore";
import { useNavigationStore } from "../../store/useNavigationStore";
import {
  navDeleteTarget, navForgetWindow, navRecentLogs, navUpdateTarget, navNavigate, navWindowMemory,
  resultMessage, TARGET_TYPE_LABELS,
  type NavLogRow,
} from "../../lib/navigation";
import { NumberInput, Select, Switch } from "../ui";

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
            <button className="btn sm" onClick={() => setShowHidden((v) => !v)} title={showHidden ? "隐藏已隐藏项" : "显示隐藏项"}>
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
          <div className="empty-hint">暂无目标；在任务编辑器「添加目标」或应用选择器中登记</div>
        )}
        <div className="target-admin-list">
          {visible.slice(0, 60).map((t) => (
            <div key={t.id} className="target-admin-row">
              <span className="target-admin-name" title={t.exe_path || t.url || t.path}>
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
                data-tip="测试跳转"
                aria-label={`测试跳转 ${t.display_name}`}
                onClick={async () => {
                  try {
                    const r = await navNavigate(t.id);
                    showToast(resultMessage(r, t.display_name), { kind: r.success ? "success" : "error" });
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
                onClick={async () => {
                  await navDeleteTarget(t.id).catch((e) => showToast(String(e), { kind: "error" }));
                  await Promise.all([loadTargets(true), useNavigationStore.getState().loadTaskLinks()]);
                }}
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
    </div>
  );
}
