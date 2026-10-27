//! 应用选择器：从已安装软件 / 当前窗口 / 手动登记中选择关联目标。
//!
//! 数据策略：打开时用 store 缓存的扫描结果（后端另有 5 分钟缓存），
//! 不做全量重扫；「刷新」按钮才触发强制扫描。

import { useEffect, useMemo, useState } from "react";
import {
  X, Search, RefreshCw, Plus, Star, Clock, Globe, FolderOpen, Monitor, AppWindow, Bot,
} from "lucide-react";
import { useNavigationStore } from "../../store/useNavigationStore";
import { useUiStore } from "../../store/useUiStore";
import { useAgentsStore } from "../../store/useAgentsStore";
import type { AgentSession } from "../../lib/bridge";
import {
  navLinkTask, navListWindows, navSaveTarget, navSaveAgentSessionTarget,
  CATEGORY_LABELS, avatarHue,
  type DiscoveredApp, type NavTarget, type TargetInput, type WindowInfo,
} from "../../lib/navigation";

const CATEGORY_ORDER = ["all", "browser", "im", "music", "dev", "file", "uwp", "other"];

/**
 * 稳定的空数组引用：zustand v5 用严格相等比较 selector 结果，
 * 在 selector 里 `?? []` 每次都会新建数组，会触发无限重渲染（白屏的经典成因）。
 */
const EMPTY_SESSIONS: AgentSession[] = [];

interface Props {
  /** 关联模式：非空 = 选择后直接关联该任务 */
  taskId?: string | null;
  /** 选择模式：返回已保存的目标（不关联任务） */
  onSelect?: (target: NavTarget) => void;
  onClose: () => void;
}

export default function AppPicker({ taskId, onSelect, onClose }: Props) {
  const showToast = useUiStore((s) => s.showToast);
  const { scan, scanning, loadApps, targets } = useNavigationStore();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [manualOpen, setManualOpen] = useState(false);
  const [windows, setWindows] = useState<WindowInfo[] | null>(null);
  const [agentOpen, setAgentOpen] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const sessions = useAgentsStore((s) => s.snapshot?.sessions ?? EMPTY_SESSIONS);

  useEffect(() => {
    if (!scan) loadApps(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 已保存目标 → 已关联去重（同任务已关联的标记，不重复加）。
  // 注意：selector 必须返回稳定引用（zustand v5 严格相等），新 Set 在 useMemo 里建。
  const linksByTask = useNavigationStore((s) => s.linksByTask);
  const linkedKeys = useMemo(
    () => new Set((linksByTask[taskId ?? ""] ?? []).map((l) => l.target.app_key)),
    [linksByTask, taskId],
  );

  const apps = useMemo(() => {
    const list = scan?.apps ?? [];
    const q = query.trim().toLowerCase();
    return list.filter((a) => {
      if (category !== "all" && a.category !== category) return false;
      if (q && !a.display_name.toLowerCase().includes(q) && !a.app_key.toLowerCase().includes(q)) {
        return false;
      }
      return true;
    });
  }, [scan, query, category]);

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
      const input: TargetInput = {
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
      const t = await navSaveTarget(input);
      await afterPick(t, `已关联「${t.display_name}」`);
    } catch (e) {
      showToast(String(e), { kind: "error" });
    } finally {
      setBusyKey(null);
    }
  }

  async function afterPick(t: NavTarget, msg: string) {
    try {
      if (taskId) {
        // 已关联过则提示而非重复关联
        if (linkedKeys.has(t.app_key)) {
          showToast(`「${t.display_name}」已关联该任务`, { kind: "info" });
          onClose();
          return;
        }
        await navLinkTask(taskId, t.id, false, "default");
        await useNavigationStore.getState().loadTaskLinks();
        showToast(msg, { kind: "success" });
        onClose();
      } else if (onSelect) {
        onSelect(t);
        onClose();
      } else {
        onClose();
      }
    } catch (e) {
      // 关联失败必须可见：目标已保存，用户可重试关联
      showToast(`已保存目标，但关联失败：${String(e)}`, { kind: "error" });
    }
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
      showToast(String(e), { kind: "error" });
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
      const name = w.title.split(/ [-–·] /)[0].slice(0, 60) || "窗口应用";
      const t = await navSaveTarget({
        target_type: "application",
        display_name: name,
        exe_path: w.exe_path,
        window_title_hint: w.title.slice(0, 32),
        overwrite_name: false,
      });
      await afterPick(t, `已关联「${t.display_name}」（来自当前窗口）`);
    } catch (e) {
      showToast(String(e), { kind: "error" });
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal app-picker" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span><AppWindow size={14} /> 选择关联目标{taskId ? "（将关联到任务）" : ""}</span>
          <button className="icon-btn sm" onClick={onClose} aria-label="关闭"><X size={14} /></button>
        </div>
        <div className="modal-body">
          {/* 搜索 + 刷新 */}
          <div className="picker-search-row">
            <div className="picker-search">
              <Search size={12} />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索已安装软件…"
                aria-label="搜索应用"
              />
            </div>
            <button
              className="btn sm"
              onClick={() => loadApps(true)}
              disabled={scanning}
              title="重新扫描开始菜单 / 注册表 / 应用商店（不扫描全盘）"
            >
              <RefreshCw size={12} className={scanning ? "spin" : ""} /> {scanning ? "扫描中…" : "刷新"}
            </button>
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
                    onClick={() => busyKey || afterPick(t, `已关联「${t.display_name}」`)}
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
              onClick={async () => {
                setWindows(windows ? null : await navListWindows().catch(() => []));
              }}
            >
              <Monitor size={11} /> {windows ? "收起当前窗口列表" : "从当前运行的窗口选择…"}
            </button>
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

          {/* Agent 会话快捷区（v0.4：会话可作为导航目标，支持恢复/工作区跳转） */}
          <div className="picker-windows">
            <button className="link-btn" onClick={() => setAgentOpen((v) => !v)}>
              <Bot size={11} /> {agentOpen ? "收起 Agent 会话" : "从 Agent 会话选择…"}
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

          {/* 应用列表 */}
          <div className="picker-list" role="listbox" aria-label="已安装软件">
            {scan === null || scanning ? (
              <div className="empty-hint">{scanning ? "扫描中…" : "加载中…"}</div>
            ) : apps.length === 0 ? (
              <div className="empty-hint">没有匹配的应用；可点「手动添加」登记任意 EXE / 网址 / 目录</div>
            ) : (
              apps.slice(0, 80).map((a) => {
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
                    <span
                      className="picker-app-avatar"
                      style={{ background: `hsl(${avatarHue(a.app_key)} 55% 45%)` }}
                    >
                      {a.category === "browser" ? <Globe size={12} /> : a.category === "file" ? <FolderOpen size={12} /> : <AppWindow size={12} />}
                    </span>
                    <span className="picker-app-name">{a.display_name}</span>
                    <span className="picker-app-meta">
                      {linked && "已关联"}
                      {!linked && running && "已保存"}
                      {a.source === "uwp" && " · 商店"}
                    </span>
                  </button>
                );
              })
            )}
          </div>

          {/* 手动添加 */}
          {manualOpen && (
            <ManualAddForm
              onSaved={async (t, msg) => {
                setManualOpen(false);
                await afterPick(t, msg);
              }}
              showToast={showToast}
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
  showToast,
}: {
  onSaved: (t: NavTarget, msg: string) => Promise<void> | void;
  showToast: (m: string, o?: { kind?: "info" | "success" | "error" }) => void;
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
      showToast(String(e), { kind: "error" });
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
