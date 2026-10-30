//! Agent 管理中心：运行监控（真实 Agent→实例→会话→轮次层级）
//! 与 接入管理（自动发现、向导、通用桥接、自定义来源）两个分区。
//!
//! 语义：
//! - 「已安装 ≠ 已连接」；健康状态只由真实事件证据决定
//! - 会话未携带实例信息时直接挂在 Agent 下，不伪造实例
//! - Agent 结束一轮执行 ≠ 普通任务完成；失联 ≠ 失败

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Bot, RefreshCw, Power, PowerOff, ExternalLink, Copy, CheckCircle2, AlertTriangle,
  ShieldQuestion, ListChecks, Radar, PlugZap, Trash2, Plus, ChevronRight, ChevronDown,
  Activity, X, Eye, EyeOff, CircleSlash, MonitorUp,
} from "lucide-react";
import {
  adapterInstall, adapterPreview, adapterUninstall, adapterVerify,
  createSource, deleteSource, discoveryScan, getAgentInboxDir, openAgentSession,
  pendingItemsToTasks, setSourceEnabled,
  type DiscoveredAgent,
} from "../../lib/bridge";
import { navAgentAction, navAgentCapabilities, type AgentNavCapabilities } from "../../lib/navigation";
import { useAgentsStore } from "../../store/useAgentsStore";
import { useUiStore } from "../../store/useUiStore";
import { useSettingsStore } from "../../store/useSettingsStore";
import { useTasksStore } from "../../store/useTasksStore";
import { AGENT_STATE_LABELS, formatBetween, formatRelative } from "../../lib/format";
import { buildTree, liveSummary, type TreeAgent, type TreeSession } from "../../lib/agentTree";
import { copyText } from "../../lib/clipboard";

const HEALTH_LABELS: Record<string, string> = {
  live: "已连接 · 事件实时",
  stale: "状态已过期",
  "awaiting-first-event": "已配置 · 待事件验证",
  "no-events": "未收到事件",
  unregistered: "未注册",
};

const KIND_LABELS: Record<string, string> = {
  transport: "官方 Hooks",
  plugin: "插件桥接",
  discovery: "安装发现",
  manual: "手动",
  mock: "模拟",
  stub: "未验证",
};

/** 运行监控的状态筛选。 */
const MONITOR_FILTERS = [
  { id: "attention", label: "需关注" },
  { id: "all", label: "全部" },
] as const;

type WizardStep = "preview" | "installing" | "verifying" | "result";

interface WizardState {
  agent: DiscoveredAgent;
  step: WizardStep;
  preview: Record<string, unknown> | null;
  result: unknown;
  error: string;
}

type Section = "monitor" | "onboard";

export default function AgentPanel() {
  const snapshot = useAgentsStore((s) => s.snapshot);
  const load = useAgentsStore((s) => s.load);
  const settings = useSettingsStore((s) => s.settings);
  const showToast = useUiStore((s) => s.showToast);
  const refreshTasks = useTasksStore((s) => s.refresh);
  const [scan, setScan] = useState<DiscoveredAgent[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [wizard, setWizard] = useState<WizardState | null>(null);
  const [inboxDir, setInboxDir] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [section, setSection] = useState<Section>("monitor");
  const [monitorFilter, setMonitorFilter] = useState<(typeof MONITOR_FILTERS)[number]["id"]>("attention");

  const runScan = useCallback(async () => {
    setScanning(true);
    try {
      setScan(await discoveryScan());
    } catch (e) {
      showToast(`扫描失败: ${String(e)}`, { kind: "error" });
    } finally {
      setScanning(false);
    }
  }, [showToast]);

  useEffect(() => {
    if (!scan) runScan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const tree = useMemo(() => (snapshot ? buildTree(snapshot) : []), [snapshot]);
  const summary = liveSummary(snapshot);

  const connectedSources = useMemo(
    () =>
      (snapshot?.sources ?? []).filter((s) =>
        (snapshot?.instances ?? []).some((i) => i.source_id === s.id) ||
        (snapshot?.sessions ?? []).some((x) => x.source_id === s.id),
      ).length,
    [snapshot],
  );

  const visibleAgents = useMemo(() => {
    if (monitorFilter === "all") return tree;
    return tree.filter((a) => a.liveState !== "idle");
  }, [tree, monitorFilter]);

  // ── 向导动作 ──
  async function openWizard(agent: DiscoveredAgent) {
    setWizard({ agent, step: "preview", preview: null, result: null, error: "" });
    try {
      const preview = await adapterPreview(agent.source_id);
      setWizard((w) => (w ? { ...w, preview } : w));
    } catch (e) {
      setWizard((w) => (w ? { ...w, error: String(e) } : w));
    }
  }
  async function wizardInstall() {
    if (!wizard) return;
    setWizard({ ...wizard, step: "installing", error: "" });
    try {
      const result = await adapterInstall(wizard.agent.source_id);
      setWizard((w) => (w ? { ...w, step: "verifying" } : w));
      const verify = await adapterVerify(wizard.agent.source_id);
      setWizard((w) => (w ? { ...w, step: "result", result: { install: result, verify } } : w));
      await Promise.all([runScan(), load()]);
    } catch (e) {
      setWizard((w) => (w ? { ...w, step: "result", error: String(e) } : w));
    }
  }
  async function wizardUninstall(agentId: string) {
    try {
      await adapterUninstall(agentId);
      showToast("已卸载 Task Dock 写入的配置（第三方配置保留）", { kind: "success" });
      await Promise.all([runScan(), load()]);
    } catch (e) {
      showToast(String(e), { kind: "error" });
    }
  }
  async function reVerify(agentId: string) {
    try {
      const r = await adapterVerify(agentId);
      const ok = (r as { ok?: boolean }).ok;
      showToast(
        ok ? "链路验证通过：测试事件已抵达数据库" : `验证未通过：${(r as { reason?: string }).reason ?? "未知原因"}`,
        { kind: ok ? "success" : "error" },
      );
      await Promise.all([runScan(), load()]);
    } catch (e) {
      showToast(String(e), { kind: "error" });
    }
  }

  /** Agent 待处理事项 → 普通任务；同步任务列表与统计。 */
  async function onPendingToTasks(items: string[]) {
    try {
      const created = await pendingItemsToTasks(items);
      await refreshTasks();
      showToast(`已创建 ${created.length} 个任务`, { kind: "success" });
    } catch (e) {
      showToast(String(e), { kind: "error" });
    }
  }

  async function onCopyInbox() {
    try {
      const dir = inboxDir || (await getAgentInboxDir());
      setInboxDir(dir);
      const ok = await copyText(dir);
      showToast(ok ? "投递目录已复制" : `投递目录：${dir}`, { kind: ok ? "success" : "info" });
    } catch (e) {
      showToast(String(e), { kind: "error" });
    }
  }

  if (!snapshot) {
    return <div className="empty-hint">加载中…</div>;
  }

  return (
    <div className="agents-panel">
      {/* ══ 分区切换 ══ */}
      <div className="seg-group agents-section-switch" role="tablist" aria-label="Agent 分区">
        <button
          className={`seg-btn ${section === "monitor" ? "active" : ""}`}
          role="tab"
          aria-selected={section === "monitor"}
          onClick={() => setSection("monitor")}
        >
          <Activity size={12} /> 运行监控
        </button>
        <button
          className={`seg-btn ${section === "onboard" ? "active" : ""}`}
          role="tab"
          aria-selected={section === "onboard"}
          onClick={() => setSection("onboard")}
        >
          <PlugZap size={12} /> 接入管理
        </button>
      </div>

      {section === "monitor" && (
        <>
          {/* ══ 状态摘要 ══ */}
          <div className="agent-summary">
            <div className={`summary-card s-running ${summary.running ? "" : "muted"}`} title="正在执行的轮次">
              <span className="summary-value">{summary.running}</span>
              <span className="summary-label">运行中</span>
            </div>
            <div className={`summary-card s-waiting ${summary.waiting ? "" : "muted"}`} title="等待人工介入">
              <span className="summary-value">{summary.waiting}</span>
              <span className="summary-label">等待介入</span>
            </div>
            <div className={`summary-card s-error ${summary.failed ? "" : "muted"}`} title="近期报告失败的轮次">
              <span className="summary-value">{summary.failed}</span>
              <span className="summary-label">异常</span>
            </div>
            <div className="summary-card muted" title="已产生会话/实例的来源">
              <span className="summary-value">{connectedSources}</span>
              <span className="summary-label">已连接来源</span>
            </div>
          </div>

          <div className="filter-bar primary">
            <div className="seg-group subtle" role="group" aria-label="监控筛选">
              {MONITOR_FILTERS.map((f) => (
                <button
                  key={f.id}
                  className={`seg-btn ${monitorFilter === f.id ? "active" : ""}`}
                  onClick={() => setMonitorFilter(f.id)}
                >
                  {f.label}
                </button>
              ))}
            </div>
            <span className="flex-spacer" />
            <button className="btn sm" onClick={load} title="重新加载快照">
              <RefreshCw size={12} /> 刷新
            </button>
          </div>

          {/* ══ 监控树 ══ */}
          {visibleAgents.length === 0 && (
            <div className="empty-state">
              <div className="empty-icon"><Bot size={22} /></div>
              <div className="empty-title">没有需要关注的 Agent</div>
              <div className="empty-hint">
                {monitorFilter === "attention"
                  ? "各 Agent 空闲中；接入后真实事件到达会自动出现在这里"
                  : "尚无 Agent 会话；到「接入管理」接入第一个 Agent"}
              </div>
            </div>
          )}
          <div className="monitor-tree">
            {visibleAgents.map((agent) => (
              <AgentNode
                key={agent.id}
                agent={agent}
                expanded={expanded}
                setExpanded={setExpanded}
                onPendingToTasks={onPendingToTasks}
                showToast={showToast}
              />
            ))}
          </div>
        </>
      )}

      {section === "onboard" && (
        <>
          {/* ══ 自动发现 ══ */}
          <div className="panel-block">
            <div className="panel-block-head">
              <span><Radar size={12} /> Agent 自动发现</span>
              <button className="btn sm" onClick={runScan} disabled={scanning}>
                <RefreshCw size={12} className={scanning ? "spin" : ""} /> {scanning ? "扫描中…" : "扫描"}
              </button>
            </div>
            {scan === null && <div className="empty-hint">扫描中…</div>}
            {scan !== null && scan.length === 0 && (
              <div className="empty-hint">未发现已安装的 Agent；可先安装 Codex / Trae 等后重新扫描</div>
            )}
            {scan !== null && (
              <div className="discovery-grid">
                {scan.map((a) => (
                  <div key={a.source_id} className={`discovery-card ${a.installed ? "" : "not-installed"}`}>
                    <div className="source-head">
                      <span className="source-name"><Bot size={13} /> {a.display_name}</span>
                      <span className={`health-badge h-${a.health_state}`}>
                        {a.verified ? <CheckCircle2 size={11} /> : a.health_state === "no-events" ? <ShieldQuestion size={11} /> : <Activity size={11} />}
                        {HEALTH_LABELS[a.health_state] ?? a.health_state}
                      </span>
                    </div>
                    <div className="discovery-facts">
                      <span>{a.installed ? `已安装${a.version ? ` · ${a.version.slice(0, 24)}` : ""}` : "未安装"}</span>
                      <span>运行实例 {a.running_instances.length}</span>
                      <span>{KIND_LABELS[a.transport_kind] ?? a.transport_kind}</span>
                    </div>
                    <div className="discovery-events">
                      {a.supported_events.length > 0
                        ? `事件：${a.supported_events.slice(0, 5).join(" / ")}${a.supported_events.length > 5 ? " …" : ""}`
                        : a.transport_kind === "discovery" ? "无自动事件通道（进程识别）" : "通用 HTTP / 文件"}
                    </div>
                    <div className="discovery-last">
                      {a.last_event_at ? `最近事件 ${formatRelative(a.last_event_at)}` : "尚无事件证据（状态未知，不推断）"}
                    </div>
                    <div className="source-actions">
                      {a.transport_kind !== "manual" && a.transport_kind !== "discovery" && (
                        <button className="btn sm primary" onClick={() => openWizard(a)} disabled={!a.installed}>
                          <PlugZap size={12} /> {a.configured ? "重新接入" : "接入"}
                        </button>
                      )}
                      {a.configured && a.transport_kind !== "manual" && (
                        <>
                          <button className="btn sm" onClick={() => reVerify(a.source_id)}>验证</button>
                          <button className="btn sm" onClick={() => wizardUninstall(a.source_id)}>卸载钩子</button>
                        </>
                      )}
                      {a.registered && (
                        <button
                          className={`btn sm ${a.enabled ? "" : "primary"}`}
                          onClick={async () => {
                            try {
                              await setSourceEnabled(a.source_id, !a.enabled);
                              await Promise.all([runScan(), load()]);
                            } catch (e) {
                              showToast(String(e), { kind: "error" });
                            }
                          }}
                        >
                          {a.enabled ? <PowerOff size={12} /> : <Power size={12} />}
                          {a.enabled ? "禁用" : "启用"}
                        </button>
                      )}
                    </div>
                    {a.limitations.length > 0 && (
                      <div className="discovery-limits" title={a.limitations.join("\n")}>
                        <AlertTriangle size={10} /> {a.limitations[0]}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
            <div className="endpoint-hint bridge-note">
              <AlertTriangle size={11} /> 「已安装」仅代表在本机检测到安装，不等于已连接；
              连接状态以真实事件证据（健康徽标）为准。
            </div>
          </div>

          {/* ══ 通用桥接（不支持自动接入的 Agent）══ */}
          <div className="panel-block">
            <div className="panel-block-head">
              <span>通用桥接（任意 Agent · HTTP / 文件投递）</span>
              <button className="btn sm" onClick={onCopyInbox}>
                <Copy size={12} /> 复制目录
              </button>
            </div>
            <EndpointInfo
              port={settings?.http_port ?? 47821}
              token={settings?.http_token ?? ""}
              showToast={showToast}
            />
          </div>

          {/* ══ 自定义来源 ══ */}
          <CustomSourceForm
            onCreated={async () => {
              await Promise.all([load(), runScan()]);
            }}
            showToast={showToast}
          />
        </>
      )}

      {/* ══ 接入向导弹窗 ══ */}
      {wizard && (
        <WizardModal
          state={wizard}
          onClose={() => setWizard(null)}
          onInstall={wizardInstall}
          onRetryVerify={async () => {
            try {
              const verify = await adapterVerify(wizard.agent.source_id);
              setWizard((w) => (w ? { ...w, step: "result", result: { verify } } : w));
              await Promise.all([runScan(), load()]);
            } catch (e) {
              setWizard((w) => (w ? { ...w, error: String(e) } : w));
            }
          }}
          onCancel={async () => {
            if (wizard.step === "result") await wizardUninstall(wizard.agent.source_id);
            setWizard(null);
          }}
        />
      )}
    </div>
  );
}

// ── 通用接入信息（Token 默认遮盖） ──

function EndpointInfo({
  port,
  token,
  showToast,
}: {
  port: number;
  token: string;
  showToast: (m: string, o?: { kind?: "info" | "success" | "error" }) => void;
}) {
  const [revealed, setRevealed] = useState(false);
  return (
    <div className="endpoint-info">
      <div>
        <span className="endpoint-label">HTTP 端点</span>
        <code>POST http://127.0.0.1:{port}/api/v1/events</code>
      </div>
      <div>
        <span className="endpoint-label">鉴权</span>
        <code className="token-code">
          Authorization: Bearer {revealed ? token : `${token.slice(0, 4)}${"•".repeat(Math.max(6, Math.min(20, token.length - 4)))}`}
        </code>
        <button
          className="icon-btn sm"
          data-tip={revealed ? "隐藏令牌" : "显示令牌"}
          aria-label={revealed ? "隐藏令牌" : "显示令牌"}
          onClick={() => setRevealed((v) => !v)}
        >
          {revealed ? <EyeOff size={11} /> : <Eye size={11} />}
        </button>
        <button
          className="icon-btn sm"
          data-tip="复制完整令牌"
          aria-label="复制完整令牌"
          onClick={async () => {
            const ok = await copyText(token);
            showToast(ok ? "令牌已复制" : "复制失败，请手动选择", { kind: ok ? "success" : "error" });
          }}
        >
          <Copy size={11} />
        </button>
      </div>
      <div>
        <span className="endpoint-label">文件投递</span>
        <code>%APPDATA%\com.taskdock.desktop\agent-inbox\*.json</code>
      </div>
      <div className="endpoint-hint">
        <AlertTriangle size={11} /> 仅绑定回环地址；事件 JSON：source_id / session_id / run_id? /
        state(running|waiting|completed|failed) / transport?
      </div>
    </div>
  );
}

// ── 监控树节点 ──

/** 跳转结果 → Toast（成功/降级/失败都如实反馈）。 */
function toastNavResult(showToast: (m: string, o?: { kind?: "info" | "success" | "error" }) => void, r: { success: boolean; reason?: string; fallback_used: boolean; verification_level: string }, name: string) {
  const v = r.verification_level === "window-confirmed" ? "已确认窗口"
    : r.verification_level === "process-spawned" ? "进程已启动"
    : r.verification_level === "launch-requested" ? "已请求启动"
    : r.verification_level === "delegated" ? "已交系统处理"
    : r.verification_level === "requested-unverified" ? "已请求，未核实"
    : "";
  if (!r.success) {
    showToast(`「${name}」${r.reason ?? "操作失败"}`, { kind: "error" });
    return;
  }
  showToast(`「${name}」${v}${r.fallback_used ? `（降级：${r.reason ?? ""}）` : ""}`, { kind: "success" });
}

function AgentNode({
  agent,
  expanded,
  setExpanded,
  onPendingToTasks,
  showToast,
}: {
  agent: TreeAgent;
  expanded: Record<string, boolean>;
  setExpanded: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  onPendingToTasks: (items: string[]) => Promise<void>;
  showToast: (m: string, o?: { kind?: "info" | "success" | "error" }) => void;
}) {
  const open = !!expanded[agent.id];
  const [caps, setCaps] = useState<AgentNavCapabilities | null>(null);

  // 展开时才探测跳转能力（证据化：探测结果随本机安装状态变化）
  useEffect(() => {
    if (open && !caps) {
      navAgentCapabilities(agent.id).then(setCaps).catch(() => setCaps(null));
    }
  }, [open, agent.id, caps]);

  return (
    <div className={`tree-agent attention-${agent.liveState}`}>
      {/* 行容器为 div：展开按钮与导航操作按钮是兄弟节点（修复 button 嵌套） */}
      <div className="tree-row tree-agent-row">
        <button
          className="tree-row-main"
          onClick={() => setExpanded((e) => ({ ...e, [agent.id]: !e[agent.id] }))}
          aria-expanded={open}
        >
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <span className={`agent-dot state-${agent.liveState}`} />
          <strong>{agent.name}</strong>
          <span className="tree-meta">
            {agent.activeCount > 0 ? `${agent.activeCount} 活跃` : AGENT_STATE_LABELS[agent.liveState] ?? "空闲"}
          </span>
        </button>
        <button
          className="icon-btn sm"
          data-tip={caps?.can_launch.supported ? `打开 ${agent.name}` : caps ? caps.can_launch.note : "探测跳转能力…"}
          aria-label={`打开 ${agent.name} 应用`}
          disabled={!caps?.can_launch.supported}
          onClick={async () => {
            try {
              const r = await navAgentAction(agent.id, "open_app");
              toastNavResult(showToast, r, agent.name);
            } catch (e) {
              showToast(String(e), { kind: "error" });
            }
          }}
        >
          <ExternalLink size={12} />
        </button>
      </div>
      {open && (
        <div className="tree-children">
          {agent.instances.map((inst) => (
            <div key={inst.id} className="tree-instance">
              <div className="tree-row">
                <button
                  className="tree-row-main"
                  onClick={() => setExpanded((e) => ({ ...e, [`${agent.id}/${inst.id}`]: !e[`${agent.id}/${inst.id}`] }))}
                  aria-expanded={!!expanded[`${agent.id}/${inst.id}`]}
                >
                  {expanded[`${agent.id}/${inst.id}`] ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                  <span className="tree-inst-key" title={inst.key}>{inst.key}</span>
                  <span className="tree-meta">{inst.sessions.length} 会话</span>
                </button>
                <button
                  className="icon-btn sm"
                  data-tip={`唤醒 ${agent.name} 实例窗口`}
                  aria-label={`唤醒 ${agent.name} 实例窗口`}
                  disabled={!caps?.can_focus_window.supported}
                  onClick={async () => {
                    try {
                      const r = await navAgentAction(agent.id, "focus_window");
                      toastNavResult(showToast, r, `${agent.name} 实例`);
                    } catch (e) {
                      showToast(String(e), { kind: "error" });
                    }
                  }}
                >
                  <MonitorUp size={12} />
                </button>
              </div>
              {expanded[`${agent.id}/${inst.id}`] && (
                <div className="tree-children">
                  {inst.sessions.map((sess) => (
                    <SessionNode
                      key={sess.id}
                      agentId={agent.id}
                      agentName={agent.name}
                      session={sess}
                      expanded={expanded}
                      setExpanded={setExpanded}
                      onPendingToTasks={onPendingToTasks}
                      showToast={showToast}
                      canResume={caps?.can_resume_session.supported ?? false}
                      resumeNote={caps?.can_resume_session.note ?? ""}
                      canFocus={caps?.can_focus_window.supported ?? false}
                    />
                  ))}
                </div>
              )}
            </div>
          ))}
          {agent.unassignedSessions.length > 0 && (
            <div className="tree-instance">
              <div className="tree-row unassigned-head" title="事件未携带实例信息，保持真实关系">
                <CircleSlash size={11} />
                <span className="tree-inst-key">未关联实例</span>
                <span className="tree-meta">{agent.unassignedSessions.length} 会话</span>
              </div>
              {agent.unassignedSessions.map((sess) => (
                <SessionNode
                  key={sess.id}
                  agentId={agent.id}
                  agentName={agent.name}
                  session={sess}
                  expanded={expanded}
                  setExpanded={setExpanded}
                  onPendingToTasks={onPendingToTasks}
                  showToast={showToast}
                  canResume={caps?.can_resume_session.supported ?? false}
                  resumeNote={caps?.can_resume_session.note ?? ""}
                  canFocus={caps?.can_focus_window.supported ?? false}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SessionNode({
  agentId,
  agentName,
  session,
  expanded,
  setExpanded,
  onPendingToTasks,
  showToast,
  canResume,
  resumeNote,
  canFocus,
}: {
  agentId: string;
  agentName: string;
  session: TreeSession;
  expanded: Record<string, boolean>;
  setExpanded: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  onPendingToTasks: (items: string[]) => Promise<void>;
  showToast: (m: string, o?: { kind?: "info" | "success" | "error" }) => void;
  canResume: boolean;
  resumeNote: string;
  canFocus: boolean;
}) {
  const open = !!expanded[session.id];
  // 能力未知（caps 未加载）时保守显示「跳转」；后端会诚实降级并在 Toast 说明
  const jumpSupported = canResume || canFocus;
  return (
    <div className={`tree-session attention-${session.liveState}`}>
      {/* 行容器 div + 兄弟按钮：展开只负责展开，跳转只负责跳转（修复嵌套 button） */}
      <div className="tree-row">
        <button
          className="tree-row-main"
          onClick={() => setExpanded((e) => ({ ...e, [session.id]: !e[session.id] }))}
          aria-expanded={open}
        >
          {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          <span className={`session-state state-${session.liveState}`}>
            {AGENT_STATE_LABELS[session.liveState] ?? "未知"}
          </span>
          <span className="tree-title">{session.title || session.externalId.slice(0, 24)}</span>
          <span className="tree-meta">{session.runs.length} 轮 · {formatRelative(session.lastSeen)}</span>
        </button>
        <button
          className="icon-btn sm"
          data-tip={canResume ? `恢复会话 — ${resumeNote}` : jumpSupported ? "该 Agent 暂不支持精准恢复会话，将尝试唤醒/启动应用" : "探测跳转能力…"}
          aria-label={canResume ? `恢复会话 ${session.externalId}` : `打开 ${agentName}`}
          onClick={async (e) => {
            e.stopPropagation();
            try {
              await openAgentSession(agentId, session.externalId);
              showToast(
                canResume ? "已发起会话恢复（在新终端进程中）" : "已按能力降级执行（详见提示）",
                { kind: "success" },
              );
            } catch (err) {
              showToast(String(err), { kind: "info" });
            }
          }}
        >
          <ExternalLink size={12} />
        </button>
      </div>
      {open && (
        <div className="tree-children">
          {session.runs.map((run) => (
            <div key={run.id} className={`run-item state-${run.status}`}>
              <span className={`agent-dot state-${run.status}`} />
              <div className="run-main">
                <div className="run-title">
                  <span className="run-source">{run.externalRunId?.slice(0, 10) ?? "自动轮次"}</span>
                  {run.taskTitle || "（无标题）"}
                </div>
                <div className="run-meta">
                  {AGENT_STATE_LABELS[run.status] ?? "未知"} · {formatBetween(run.startedAt, run.endedAt)} · 活动 {formatRelative(run.updatedAt)}
                </div>
                {run.pending.length > 0 && (
                  <div className="run-pending">
                    <ListChecks size={11} /> {run.pending.length} 个待处理事项
                    <button className="btn sm" onClick={() => onPendingToTasks(run.pending)}>
                      转为任务
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── 自定义来源表单 ──

/** 迁移预置的来源 ID（不列入可删除的自定义来源）。 */
const PRESET_SOURCE_IDS = new Set([
  "mock", "codex", "trae", "workbuddy", "qoder",
  "deepseek-harness", "opencode", "zcode", "bridge",
]);

function CustomSourceForm({ onCreated, showToast }: { onCreated: () => Promise<void>; showToast: (m: string, o?: { kind?: "info" | "success" | "error" }) => void }) {
  const [open, setOpen] = useState(false);
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const snapshot = useAgentsStore((s) => s.snapshot);

  const mySources = useMemo(
    () =>
      (snapshot?.sources ?? [])
        .filter((x) => !PRESET_SOURCE_IDS.has(x.id))
        .map((x) => ({ id: x.id, display_name: x.display_name })),
    [snapshot],
  );

  return (
    <div className="panel-block">
      <div className="panel-block-head">
        <span>自定义来源（动态注册）</span>
        <button className="btn sm" onClick={() => setOpen(!open)}>
          {open ? <X size={12} /> : <Plus size={12} />} {open ? "收起" : "添加"}
        </button>
      </div>
      {open && (
        <div className="custom-source-form">
          <input className="input sm" placeholder="来源 ID（如 my-agent）" value={id} onChange={(e) => setId(e.target.value)} />
          <input className="input sm" placeholder="显示名称" value={name} onChange={(e) => setName(e.target.value)} />
          <button
            className="btn sm primary"
            disabled={busy || !id.trim() || !name.trim()}
            onClick={async () => {
              setBusy(true);
              try {
                await createSource(id.trim(), name.trim());
                showToast(`已注册来源 ${id.trim()}：可用 HTTP/文件以 source_id=${id.trim()} 上报`, { kind: "success" });
                setId("");
                setName("");
                await onCreated();
              } catch (e) {
                showToast(String(e), { kind: "error" });
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "注册中…" : "注册"}
          </button>
        </div>
      )}
      {mySources.length > 0 && (
        <div className="custom-source-list">
          {mySources.map((s) => (
            <span key={s.id} className="chip">
              {s.display_name}（{s.id}）
              <button
                className="icon-btn sm"
                data-tip="删除来源（保留关联任务与历史链接）"
                aria-label={`删除来源 ${s.id}`}
                onClick={async () => {
                  try {
                    await deleteSource(s.id, false);
                    showToast(`已删除来源 ${s.id}（普通任务不受影响）`, { kind: "success" });
                    await onCreated();
                  } catch (e) {
                    showToast(String(e), { kind: "error" });
                  }
                }}
              >
                <Trash2 size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ── 接入向导弹窗 ──

function WizardModal({
  state,
  onClose,
  onInstall,
  onRetryVerify,
  onCancel,
}: {
  state: WizardState;
  onClose: () => void;
  onInstall: () => Promise<void>;
  onRetryVerify: () => Promise<void>;
  onCancel: () => Promise<void>;
}) {
  const p = state.preview ?? {};
  const files = (p.hook_files as string[] | undefined) ?? (p.plugin_file ? [p.plugin_file as string] : (p.plugin_dir ? [p.plugin_dir as string] : []));
  const events = (p.events as string[] | undefined) ?? [];
  const verify = (state.result as { verify?: { ok?: boolean; reason?: string; note?: string; received_at?: string } } | null)?.verify;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wizard-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span><PlugZap size={14} /> 接入 {state.agent.display_name}</span>
          <button className="icon-btn sm" onClick={onClose} aria-label="关闭"><X size={14} /></button>
        </div>
        <div className="modal-body">
          {state.step === "preview" && (
            <>
              <div className="wizard-step-tag">第 1 步 · 配置预览（尚未写入任何文件）</div>
              <ul className="wizard-preview">
                <li>将修改的文件：{files.length ? files.map((f) => <code key={f}>{f}</code>) : "无"}</li>
                <li>注册事件：{events.length ? events.join(" · ") : "（无自动事件通道）"}</li>
                <li>写入前自动备份，第三方 hooks 原样保留，失败自动回滚</li>
                {(p.limitations as string[] | undefined)?.map((l, i) => (
                  <li key={i} className="wizard-warn"><AlertTriangle size={11} /> {l}</li>
                ))}
              </ul>
              {state.error && <div className="wizard-error">{state.error}</div>}
              <div className="wizard-actions">
                <button className="btn" onClick={onCancel}>取消</button>
                <button className="btn primary" onClick={onInstall} disabled={!state.preview}>
                  确认并安装
                </button>
              </div>
            </>
          )}
          {state.step === "installing" && <div className="empty-hint">正在写入配置（备份 → 原子写入 → 校验）…</div>}
          {state.step === "verifying" && <div className="empty-hint">正在执行真实链路验证（Hook 脚本 → Task Dock → 数据库）…</div>}
          {state.step === "result" && (
            <>
              <div className="wizard-step-tag">第 3 步 · 接入结果</div>
              {state.error ? (
                <div className="wizard-error"><AlertTriangle size={12} /> {state.error}</div>
              ) : verify ? (
                <div className={verify.ok ? "wizard-ok" : "wizard-warn"}>
                  {verify.ok ? (
                    <>
                      <CheckCircle2 size={13} /> 链路验证通过：测试事件已真实抵达数据库（{verify.received_at ?? ""}）
                      <div className="wizard-note">{verify.note}</div>
                    </>
                  ) : (
                    <>
                      <AlertTriangle size={13} /> 验证未通过：{verify.reason}
                      <button className="btn sm" onClick={onRetryVerify}>重试验证</button>
                    </>
                  )}
                </div>
              ) : null}
              <div className="wizard-actions">
                <button className="btn" onClick={onCancel}>回滚（卸载刚安装的配置）</button>
                <button className="btn primary" onClick={onClose}>完成</button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
