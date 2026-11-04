//! Agent 管理中心：运行监控（真实 Agent→实例→会话→轮次层级）
//! 与 接入管理（自动发现、向导、通用桥接、自定义来源）两个分区。
//!
//! 语义：
//! - 「已安装 ≠ 已连接」；健康状态只由真实事件证据决定
//! - 会话未携带实例信息时直接挂在 Agent 下，不伪造实例
//! - Agent 结束一轮执行 ≠ 普通任务完成；失联 ≠ 失败

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  RefreshCw, Power, PowerOff, ExternalLink, Copy, CheckCircle2, AlertTriangle,
  ShieldQuestion, ListChecks, Radar, PlugZap, Trash2, Plus, ChevronRight, ChevronDown,
  Activity, X, Eye, EyeOff, CircleSlash, MonitorUp, BarChart3, Search,
} from "lucide-react";
import AgentIcon from "../ui/AgentIcon";
import {
  adapterInstall, adapterPreview, adapterUninstall, adapterVerify,
  createSource, deleteSource, discoveryScan, getAgentInboxDir, openAgentSession,
  pendingItemsToTasks, setSourceEnabled,
  type DiscoveredAgent,
} from "../../lib/bridge";
import { navAgentAction, navAgentCapabilities, type AgentNavCapabilities } from "../../lib/navigation";
import { useAgentsStore } from "../../store/useAgentsStore";
import { errorMessage } from "../../lib/errors";
import { useUiStore } from "../../store/useUiStore";
import { useSettingsStore } from "../../store/useSettingsStore";
import { useTasksStore } from "../../store/useTasksStore";
import { AGENT_STATE_LABELS, formatBetween, formatDue, formatRelative } from "../../lib/format";
import { buildTree, liveSummary, type TreeAgent, type TreeSession } from "../../lib/agentTree";
import { copyText } from "../../lib/clipboard";
import { reportError } from "../../lib/errorReport";
import AgentStatsView from "./stats/AgentStatsView";

// 徽标只描述「接入证据强度」，不把已安装 / 已配置 / 验证通过 / 已连接混为一谈。
// 文案尽量短，窄卡片下优先让徽标换行，而不是挤压 Agent 名称。
const HEALTH_LABELS: Record<string, string> = {
  live: "已连接 · 实时",
  "recent-event": "最近有真实事件",
  "recent-unconfigured": "曾有真实事件 · 未配置",
  stale: "状态已过期",
  "transport-verified": "通道已验证 · 待真实事件",
  "awaiting-first-event": "已配置 · 待真实事件",
  // 只有自测/旧版本写入的 verified 位，没有任何 origin=real 事件
  "self-test-only": "仅自测通过 · 待真实事件",
  "history-only": "历史接入记录",
  "no-events": "未收到事件",
  disabled: "已禁用",
  unregistered: "未注册",
};

/** 展开区的完整状态解释：只说证据，不推断在线。 */
const HEALTH_DETAILS: Record<string, string> = {
  live: "已连接并在时效窗口内持续收到宿主真实事件",
  "recent-event": "在时效窗口内收到过宿主真实事件",
  "recent-unconfigured": "在时效窗口内收到过真实事件，但当前未写入 Task Dock 配置",
  stale: "曾收到真实事件，但已超出时效窗口，不代表当前仍连接",
  "transport-verified": "自测事件已写入数据库，尚未收到宿主真实事件",
  "awaiting-first-event": "接入配置已写入，但尚未收到任何事件",
  "self-test-only": "仅有自测或旧版验证记录，没有宿主真实事件",
  "history-only": "仅有历史接入记录，当前无可用证据",
  "no-events": "未收到任何事件，接入状态未知",
  disabled: "来源已禁用，不再接收事件",
  unregistered: "尚未注册到 Task Dock",
};

/** 名称 / source_id 子串匹配：大小写不敏感、中文按连续子串、忽略首尾空格。 */
function matchesSource(query: string, name: string, id: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return `${name} ${id}`.toLowerCase().includes(q);
}

const KIND_LABELS: Record<string, string> = {
  transport: "官方 Hooks",
  hooks: "官方 Hooks",
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

type Section = "monitor" | "stats" | "onboard";

export default function AgentPanel() {
  const snapshot = useAgentsStore((s) => s.snapshot);
  const snapshotError = useAgentsStore((s) => s.snapshotError);
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
  // 两处搜索状态相互独立；只在本已加载的数据上派生，不触发后端扫描。
  const [monitorQuery, setMonitorQuery] = useState("");
  const [discoverQuery, setDiscoverQuery] = useState("");

  const runScan = useCallback(async () => {
    setScanning(true);
    try {
      setScan(await discoveryScan());
    } catch (e) {
      reportError(e, { operation: "扫描 Agent" });
    } finally {
      setScanning(false);
    }
  }, []);

  useEffect(() => {
    if (!scan) runScan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const tree = useMemo(() => (snapshot ? buildTree(snapshot) : []), [snapshot]);
  const summary = liveSummary(snapshot);

  // 桌面通知「定位本轮」：展开 Agent/实例/会话，滚动并短暂高亮到具体轮次。
  // 定位目标由 App 在收到 notification-navigate 后写入，处理完立即消费清除。
  const agentFocus = useUiStore((s) => s.agentFocus);
  const clearAgentFocus = useUiStore((s) => s.clearAgentFocus);
  /** 定位未命中次数：通知可能先于快照刷新到达，短暂等待树更新后再放弃 */
  const focusMissRef = useRef(0);

  useEffect(() => {
    if (!agentFocus) {
      focusMissRef.current = 0;
      return;
    }
    if (tree.length === 0) return; // 快照未就绪时保留目标，等下一次树更新
    const found = findSessionInTree(tree, agentFocus.sessionId);
    if (!found) {
      // 新会话刚入库时快照还没刷新：给几次树更新机会，避免静默丢失定位。
      focusMissRef.current += 1;
      if (focusMissRef.current >= 6) {
        focusMissRef.current = 0;
        clearAgentFocus(); // 约 6 次快照刷新后仍无此会话：视为已清理，不伪造定位
      }
      return;
    }
    focusMissRef.current = 0;
    setSection("monitor");
    setMonitorFilter("all");
    // 通知定位优先于任何筛选：清空搜索，确保即使当前条件把目标 Agent 过滤掉也能显示。
    setMonitorQuery("");
    setExpanded((e) => {
      const next: Record<string, boolean> = {
        ...e,
        [found.agentId]: true,
        [found.session.id]: true,
      };
      if (found.instanceId) next[`${found.agentId}/${found.instanceId}`] = true;
      return next;
    });
    let cancelled = false;
    let frame = 0;
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        if (cancelled) return;
        const runId = agentFocus.refId;
        const el =
          (runId && document.querySelector(`[data-agent-run-id="${runId}"]`)) ||
          document.querySelector(`[data-agent-session-id="${found.session.id}"]`);
        if (el) {
          const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
          el.scrollIntoView?.({ block: "center", behavior: reduced ? "auto" : "smooth" });
          if (!reduced && el.animate) {
            el.animate(
              [
                { boxShadow: "0 0 0 0 rgba(79, 125, 186, 0)" },
                { boxShadow: "0 0 0 2px rgba(79, 125, 186, 0.55)" },
                { boxShadow: "0 0 0 0 rgba(79, 125, 186, 0)" },
              ],
              { duration: 1200, easing: "ease-out" },
            );
          }
        }
        // 滚动/高亮已发起后再消费目标，避免清除状态提前触发 cleanup 取消动画帧。
        clearAgentFocus();
      });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [agentFocus, tree, clearAgentFocus]);

  const connectedSources = useMemo(
    () =>
      (snapshot?.sources ?? []).filter((s) =>
        (snapshot?.instances ?? []).some((i) => i.source_id === s.id) ||
        (snapshot?.sessions ?? []).some((x) => x.source_id === s.id),
      ).length,
    [snapshot],
  );

  const visibleAgents = useMemo(() => {
    return tree.filter((a) => {
      // 「需关注」只看真实执行状态：软件在运行但未接入不算需要关注
      if (monitorFilter !== "all" && a.liveState === "idle") return false;
      return matchesSource(monitorQuery, a.name, a.id);
    });
  }, [tree, monitorFilter, monitorQuery]);

  const monitorSearching = monitorQuery.trim().length > 0;

  // 运行监控与「接入管理」共用同一次扫描结果，不额外起第二套发现逻辑
  const discoveryBySource = useMemo(() => {
    const m = new Map<string, DiscoveredAgent>();
    for (const d of scan ?? []) m.set(d.source_id, d);
    return m;
  }, [scan]);

  // 接入管理搜索：同样只在本已加载的扫描结果上派生，扫描按钮才是唯一的数据更新入口。
  const visibleSources = useMemo(
    () => (scan ?? []).filter((d) => matchesSource(discoverQuery, d.display_name, d.source_id)),
    [scan, discoverQuery],
  );
  const discoverSearching = discoverQuery.trim().length > 0;

  // ── 向导动作 ──
  async function openWizard(agent: DiscoveredAgent) {
    setWizard({ agent, step: "preview", preview: null, result: null, error: "" });
    try {
      const preview = await adapterPreview(agent.source_id);
      setWizard((w) => (w ? { ...w, preview } : w));
    } catch (e) {
      setWizard((w) => (w ? { ...w, error: errorMessage(e) } : w));
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
      setWizard((w) => (w ? { ...w, step: "result", error: errorMessage(e) } : w));
    }
  }
  async function wizardUninstall(agentId: string) {
    try {
      await adapterUninstall(agentId);
      showToast("已卸载 Task Dock 写入的配置（第三方配置保留）", { kind: "success" });
      await Promise.all([runScan(), load()]);
    } catch (e) {
      showToast(`卸载 Agent 配置失败：${errorMessage(e)}`, { kind: "error" });
    }
  }
  async function reVerify(agentId: string) {
    try {
      const r = await adapterVerify(agentId);
      const ok = (r as { ok?: boolean }).ok;
      // 自测事件 ≠ 宿主真实事件：文案必须区分，不能显示成「接入成功」
      showToast(
        ok
          ? "自测链路通过：测试事件已写入数据库（不代表宿主已产生真实事件）"
          : `验证未通过：${(r as { reason?: string }).reason ?? "未知原因"}`,
        { kind: ok ? "success" : "error" },
      );
      await Promise.all([runScan(), load()]);
    } catch (e) {
      showToast(`重新验证 Agent 失败：${errorMessage(e)}`, { kind: "error" });
    }
  }

  /** Agent 待处理事项 → 普通任务；同步任务列表与统计。 */
  async function onPendingToTasks(items: string[]) {
    try {
      const created = await pendingItemsToTasks(items);
      await refreshTasks();
      showToast(`已创建 ${created.length} 个任务`, { kind: "success" });
    } catch (e) {
      reportError(e, { operation: "创建任务" });
    }
  }

  async function onCopyInbox() {
    try {
      const dir = inboxDir || (await getAgentInboxDir());
      setInboxDir(dir);
      const ok = await copyText(dir);
      showToast(ok ? "投递目录已复制" : `投递目录：${dir}`, { kind: ok ? "success" : "info" });
    } catch (e) {
      reportError(e, { operation: "读取投递目录" });
    }
  }

  if (!snapshot) {
    // 快照读取失败 ≠ 正在加载：给出真实错误与重试，避免无限「加载中」
    return snapshotError ? (
      <div className="empty-hint error-text" role="alert">
        读取 Agent 状态失败：{snapshotError}
        <button className="btn sm" onClick={() => void load()}>
          重试
        </button>
      </div>
    ) : (
      <div className="empty-hint">加载中…</div>
    );
  }

  return (
    <div className="agents-panel">
      {snapshotError && (
        // 保留旧快照但明确标记可能过期；持续故障不依赖一次性 Toast
        <div className="empty-hint error-text" role="status">
          Agent 状态同步失败，下方显示的数据可能不是最新：{snapshotError}
          <button className="btn sm" onClick={() => void load()}>
            重试
          </button>
        </div>
      )}
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
          className={`seg-btn ${section === "stats" ? "active" : ""}`}
          role="tab"
          aria-selected={section === "stats"}
          onClick={() => setSection("stats")}
        >
          <BarChart3 size={12} /> 统计
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
            <div className="search-box agents-search">
              <Search size={12} aria-hidden="true" />
              <input
                className="input-embedded"
                aria-label="搜索 Agent 名称或来源 ID"
                placeholder="搜索名称 / ID"
                value={monitorQuery}
                onChange={(e) => setMonitorQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    // stopPropagation：别让 Escape 冒泡到窗口级「隐藏到托盘」
                    e.stopPropagation();
                    setMonitorQuery("");
                  }
                }}
              />
              {monitorSearching && (
                <button
                  className="icon-btn sm"
                  data-tip="清空搜索"
                  aria-label="清空搜索"
                  onClick={() => setMonitorQuery("")}
                >
                  <X size={11} />
                </button>
              )}
            </div>
            <span className="flex-spacer" />
            <button className="btn sm" onClick={load} title="重新加载快照">
              <RefreshCw size={12} /> 刷新
            </button>
          </div>

          {/* ══ 监控树 ══ */}
          {visibleAgents.length === 0 && (
            <div className="empty-state">
              <div className="empty-icon"><AgentIcon size={22} /></div>
              <div className="empty-title">
                {monitorSearching ? "没有匹配的 Agent" : "没有需要关注的 Agent"}
              </div>
              <div className="empty-hint">
                {monitorSearching
                  ? `没有名称或来源 ID 匹配「${monitorQuery.trim()}」；清空搜索可恢复${monitorFilter === "attention" ? "「需关注」" : "「全部」"}范围内的结果`
                  : monitorFilter === "attention"
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
                discovery={discoveryBySource.get(agent.id)}
                onConnect={
                  discoveryBySource.has(agent.id)
                    ? () => {
                        const d = discoveryBySource.get(agent.id)!;
                        setSection("onboard");
                        void openWizard(d);
                      }
                    : undefined
                }
              />
            ))}
          </div>
        </>
      )}

      {section === "stats" && <AgentStatsView />}

      {section === "onboard" && (
        <>
          {/* ══ 自动发现 ══ */}
          <div className="panel-block">
            <div className="panel-block-head">
              <span><Radar size={12} /> Agent 自动发现</span>
            </div>
            {/* 工具栏：宽时并排，窄时搜索框占满一行、扫描按钮换行，不互相挤压 */}
            <div className="agents-toolbar">
              <div className="search-box agents-search">
                <Search size={12} aria-hidden="true" />
                <input
                  className="input-embedded"
                  aria-label="搜索 Agent 名称或来源 ID"
                  placeholder="搜索名称 / source_id"
                  value={discoverQuery}
                  onChange={(e) => setDiscoverQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      e.stopPropagation();
                      setDiscoverQuery("");
                    }
                  }}
                />
                {discoverSearching && (
                  <button
                    className="icon-btn sm"
                    data-tip="清空搜索"
                    aria-label="清空搜索"
                    onClick={() => setDiscoverQuery("")}
                  >
                    <X size={11} />
                  </button>
                )}
              </div>
              <button className="btn sm" onClick={runScan} disabled={scanning}>
                <RefreshCw size={12} className={scanning ? "spin" : ""} />{" "}
                {scanning ? "扫描中…" : "扫描"}
              </button>
            </div>
            {scan === null && <div className="empty-hint">扫描中…</div>}
            {scan !== null && scan.length === 0 && (
              <div className="empty-hint">未发现已安装的 Agent；可先安装 Codex / Trae 等后重新扫描</div>
            )}
            {scan !== null && scan.length > 0 && visibleSources.length === 0 && (
              <div className="empty-hint">
                没有名称或 source_id 匹配「{discoverQuery.trim()}」；清空搜索可显示全部 {scan.length} 个来源
              </div>
            )}
            {visibleSources.length > 0 && (
              <div className="discovery-grid">
                {visibleSources.map((a) => (
                  <SourceCard
                    key={a.source_id}
                    agent={a}
                    onConnect={() => openWizard(a)}
                    onVerify={() => reVerify(a.source_id)}
                    onUninstall={() => wizardUninstall(a.source_id)}
                    onChanged={async () => {
                      await Promise.all([runScan(), load()]);
                    }}
                    showToast={showToast}
                  />
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
              setWizard((w) => (w ? { ...w, error: errorMessage(e) } : w));
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

// ── Agent 来源卡 ──
// 信息三层：默认 = 名称/健康/安装/实例/最近真实事件；动作层 = 接入·验证·启用禁用·详情；
// 展开层 = 版本/接入方式/Hooks/事件类型/自测证据/限制/卸载。技术细节不铺在默认视图。

function SourceCard({
  agent,
  onConnect,
  onVerify,
  onUninstall,
  onChanged,
  showToast,
}: {
  agent: DiscoveredAgent;
  onConnect: () => void;
  onVerify: () => Promise<void>;
  onUninstall: () => Promise<void>;
  onChanged: () => Promise<void>;
  showToast: (m: string, o?: { kind?: "info" | "success" | "error" }) => void;
}) {
  const [detailOpen, setDetailOpen] = useState(false);
  const [busy, setBusy] = useState<"verify" | "toggle" | "uninstall" | null>(null);
  const detailId = `agent-source-detail-${agent.source_id}`;
  const canInstall = agent.transport_kind !== "manual" && agent.transport_kind !== "discovery";
  const healthLabel = HEALTH_LABELS[agent.health_state] ?? agent.health_state;
  const healthDetail = HEALTH_DETAILS[agent.health_state] ?? "无额外状态说明";
  const eventsText =
    agent.supported_events.length > 0
      ? agent.supported_events.join(" · ")
      : agent.transport_kind === "discovery"
        ? "无自动事件通道（仅进程识别）"
        : "通用 HTTP / 文件投递";
  const badgeIcon =
    agent.health_state === "live" || agent.health_state === "recent-event" ? (
      <CheckCircle2 size={11} />
    ) : agent.health_state === "stale" ? (
      <AlertTriangle size={11} />
    ) : agent.health_state === "disabled" ? (
      <CircleSlash size={11} />
    ) : agent.health_state === "no-events" ||
      agent.health_state === "unregistered" ||
      agent.health_state === "history-only" ? (
      <ShieldQuestion size={11} />
    ) : (
      <Activity size={11} />
    );

  async function toggleEnabled() {
    setBusy("toggle");
    try {
      await setSourceEnabled(agent.source_id, !agent.enabled);
      await onChanged();
    } catch (e) {
      showToast(`更新接入开关失败：${errorMessage(e)}`, { kind: "error" });
    } finally {
      setBusy(null);
    }
  }
  async function verify() {
    setBusy("verify");
    try {
      await onVerify();
    } finally {
      setBusy(null);
    }
  }
  async function uninstall() {
    setBusy("uninstall");
    try {
      await onUninstall();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className={`discovery-card surface-card ${agent.installed ? "" : "not-installed"}`}>
      {/* 名称与徽标都可换行：空间不足时徽标整体换行，不截断名称 */}
      <div className="source-head">
        <span className="source-name" data-tip={agent.display_name}>
          <AgentIcon size={13} /> {agent.display_name}
        </span>
        <span className={`health-badge h-${agent.health_state}`} data-tip={healthDetail}>
          {badgeIcon}
          {healthLabel}
        </span>
      </div>

      {/* 第一层：安装状态 / 运行实例 / 最近真实事件（自然高度，不内部滚动） */}
      <div className="discovery-body">
        <div className="discovery-facts">
          <span>{agent.installed ? "已安装" : "未安装"}</span>
          <span>运行实例 {agent.running_instances.length}</span>
          <span className={agent.last_real_event_at ? "fact-strong" : "fact-muted"}>
            {agent.last_real_event_at
              ? `最近真实事件 ${formatRelative(agent.last_real_event_at)}`
              : "尚无真实事件"}
          </span>
        </div>
      </div>

      {/* 第二层：主操作（接入）· 次要（验证）· 启用禁用 · 详情；两两成组，换行时整组下移 */}
      <div className="source-actions">
        <div className="source-action-group">
          {canInstall && (
            <button
              className="btn sm primary"
              aria-label={`${agent.configured ? "重新接入" : "接入"} ${agent.display_name}`}
              onClick={onConnect}
              disabled={!agent.installed || busy !== null}
            >
              <PlugZap size={12} />
              {agent.configured ? "重新接入" : "接入"}
            </button>
          )}
          {agent.configured && agent.transport_kind !== "manual" && (
            <button
              className="btn sm"
              aria-label={`验证 ${agent.display_name} 的自测链路`}
              onClick={verify}
              disabled={busy !== null}
            >
              {busy === "verify" ? <RefreshCw size={12} className="spin" /> : null}
              {busy === "verify" ? "验证中…" : "验证"}
            </button>
          )}
        </div>
        <div className="source-action-group">
          {agent.registered && (
            <button
              className="btn sm source-action-toggle"
              aria-label={`${agent.enabled ? "禁用" : "启用"} ${agent.display_name}`}
              onClick={toggleEnabled}
              disabled={busy !== null}
            >
              {busy === "toggle" ? (
                <RefreshCw size={12} className="spin" />
              ) : agent.enabled ? (
                <PowerOff size={12} />
              ) : (
                <Power size={12} />
              )}
              {agent.enabled ? "禁用" : "启用"}
            </button>
          )}
          <button
            className="btn sm source-detail-toggle"
            aria-expanded={detailOpen}
            aria-controls={detailId}
            onClick={() => setDetailOpen((v) => !v)}
          >
            {detailOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />} 详情
          </button>
        </div>
      </div>

      {/* 第三层：展开后的完整证据 */}
      {detailOpen && (
        <div className="discovery-detail" id={detailId}>
          <div className="discovery-detail-row">
            <span className="discovery-detail-label">健康状态</span>
            <span className="discovery-detail-value">{healthDetail}</span>
          </div>
          <div className="discovery-detail-row">
            <span className="discovery-detail-label">版本</span>
            <span className="discovery-detail-value">{agent.version ?? "未识别"}</span>
          </div>
          <div className="discovery-detail-row">
            <span className="discovery-detail-label">接入方式</span>
            <span className="discovery-detail-value">
              {KIND_LABELS[agent.transport_kind] ?? agent.transport_kind}
            </span>
          </div>
          <div className="discovery-detail-row">
            <span className="discovery-detail-label">Hooks 配置</span>
            <span className="discovery-detail-value">
              {agent.configured ? "已写入（Task Dock 管理）" : "未写入"}
              {agent.transport_verified ? " · 自测通道通过" : ""}
            </span>
          </div>
          {agent.config_homes.length > 0 && (
            <div className="discovery-detail-row">
              <span className="discovery-detail-label">配置目录</span>
              <span className="discovery-detail-value"><code>{agent.config_homes[0]}</code></span>
            </div>
          )}
          <div className="discovery-detail-row">
            <span className="discovery-detail-label">事件类型</span>
            <span className="discovery-detail-value">{eventsText}</span>
          </div>
          <div className="discovery-detail-row">
            <span className="discovery-detail-label">最近事件</span>
            <span className="discovery-detail-value">
              {agent.last_event_at
                ? `含自测/手动：${formatRelative(agent.last_event_at)}（${formatDue(agent.last_event_at)}）`
                : "尚未收到任何事件"}
              {agent.last_real_event_at
                ? ` · 真实：${formatRelative(agent.last_real_event_at)}（${formatDue(agent.last_real_event_at)}）`
                : ""}
            </span>
          </div>
          {agent.limitations.length > 0 && (
            <div className="discovery-limits">
              <AlertTriangle size={11} />
              <span>{agent.limitations.join("；")}</span>
            </div>
          )}
          {agent.configured && canInstall && (
            <button className="btn sm danger" onClick={uninstall} disabled={busy !== null}>
              {busy === "uninstall" ? <RefreshCw size={12} className="spin" /> : <Trash2 size={12} />}
              {busy === "uninstall" ? "卸载中…" : "卸载钩子"}
            </button>
          )}
        </div>
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

/** 桌面通知「定位本轮」：在监控树里找到内部会话行 ID 对应的 Agent/实例/会话。 */
function findSessionInTree(
  tree: TreeAgent[],
  sessionId: string,
): { agentId: string; instanceId: string | null; session: TreeSession } | null {
  for (const agent of tree) {
    for (const inst of agent.instances) {
      const session = inst.sessions.find((s) => s.id === sessionId);
      if (session) return { agentId: agent.id, instanceId: inst.id, session };
    }
    const unassigned = agent.unassignedSessions.find((s) => s.id === sessionId);
    if (unassigned) return { agentId: agent.id, instanceId: null, session: unassigned };
  }
  return null;
}

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
  discovery,
  onConnect,
}: {
  agent: TreeAgent;
  expanded: Record<string, boolean>;
  setExpanded: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  onPendingToTasks: (items: string[]) => Promise<void>;
  showToast: (m: string, o?: { kind?: "info" | "success" | "error" }) => void;
  discovery?: DiscoveredAgent;
  onConnect?: () => void;
}) {
  const open = !!expanded[agent.id];
  const [caps, setCaps] = useState<AgentNavCapabilities | null>(null);

  // 三个正交维度：软件是否安装/运行（discovery）、监控是否接入（connected/health）、
  // 当前是否在执行（liveState）。进程存在绝不推导为「正在执行」。
  const softwareStatus = useMemo(() => {
    const running = discovery?.running_instances?.length ?? 0;
    if (!discovery) return agent.connected ? null : "未发现安装信息";
    if (running > 0 && !agent.connected) return "运行中 · 监控未连接";
    if (!discovery.installed) return "未安装";
    if (running === 0 && !agent.connected) return "已安装 · 未运行";
    if (!agent.connected) return "未接入监控";
    if (discovery.health_state === "stale") return "已接入 · 事件过期";
    if (discovery.health_state === "disabled") return "接入已停用";
    if (!discovery.real_event_seen) return "已配置 · 待真实事件";
    if (discovery.health_state === "self-test-only") return "仅自测通过 · 待真实事件";
    return null;
  }, [agent.connected, discovery]);

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
            {agent.activeCount > 0
              ? `${agent.activeCount} 活跃`
              : softwareStatus ?? AGENT_STATE_LABELS[agent.liveState] ?? "空闲"}
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
              showToast(`打开 Agent 失败：${errorMessage(e)}`, { kind: "error" });
            }
          }}
        >
          <ExternalLink size={12} />
        </button>
      </div>
      {open && !agent.connected && (
        <div className="tree-children">
          <div className="tree-row">
            <span className="tree-inst-key">
              {softwareStatus ?? "暂无接入证据"}
              {discovery?.health_state === "self-test-only" ? "（历史自测事件不计为真实接入）" : ""}
            </span>
            <span className="flex-spacer" />
            {onConnect && (
              <button className="btn sm" onClick={onConnect} data-tip="到接入管理配置 Hook">
                <PlugZap size={12} /> 接入
              </button>
            )}
          </div>
          {discovery?.limitations?.length ? (
            <div className="empty-hint">{discovery.limitations[0]}</div>
          ) : null}
        </div>
      )}
      {open && agent.connected && (
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
                      showToast(`聚焦 Agent 窗口失败：${errorMessage(e)}`, { kind: "error" });
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
    <div className={`tree-session attention-${session.liveState}`} data-agent-session-id={session.id}>
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
            <div
              key={run.id}
              className={`task-card run-item state-${run.status}`}
              data-agent-run-id={run.id}
            >
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
                showToast(`注册 Agent 来源失败：${errorMessage(e)}`, { kind: "error" });
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
                    showToast(`删除 Agent 来源失败：${errorMessage(e)}`, { kind: "error" });
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
