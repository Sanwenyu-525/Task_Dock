//! Agent 管理中心：运行监控（真实 Agent→实例→会话→轮次层级）
//! 与 接入管理（自动发现、向导、通用桥接、自定义来源）两个分区。
//!
//! 语义：
//! - 「已安装 ≠ 已连接」；健康状态只由真实事件证据决定
//! - 会话未携带实例信息时直接挂在 Agent 下，不伪造实例
//! - Agent 结束一轮执行 ≠ 普通任务完成；失联 ≠ 失败
//! - 接入向导是页内视图；安装/验证/回滚运行态存于 useAgentOnboardingStore，
//!   切换主 Tab 卸载组件不丢结果、不重复执行、不误报取消。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  RefreshCw, Power, PowerOff, ExternalLink, Copy, CheckCircle2, AlertTriangle,
  ShieldQuestion, ListChecks, Radar, PlugZap, Trash2, Plus, ChevronRight, ChevronDown,
  Activity, Eye, EyeOff, CircleSlash, MonitorUp, BarChart3, ArrowLeft, Loader2,
} from "lucide-react";
import AgentIcon from "../ui/AgentIcon";
import CollapsibleSection from "../ui/CollapsibleSection";
import SearchField from "../ui/SearchField";
import StatusBadge, { type StatusTone } from "../ui/StatusBadge";
import { persistCollapsibleState, readCollapsibleState } from "../../lib/collapsibleState";
import {
  adapterUninstall, adapterVerify,
  agentHistorySession,
  createSource, deleteSource, discoveryScan, getAgentInboxDir, openAgentSession,
  pendingItemsToTasks, setSourceEnabled,
  type AgentHistorySession, type AgentInstance, type AgentRun, type AgentSource,
  type DiscoveredAgent,
} from "../../lib/bridge";
import {
  onboardBusy,
  useAgentOnboardingStore,
  type OnboardState,
} from "../../store/useAgentOnboardingStore";
import { navAgentAction, navAgentCapabilities, type AgentNavCapabilities } from "../../lib/navigation";
import { useAgentsStore } from "../../store/useAgentsStore";
import { errorMessage } from "../../lib/errors";
import { useUiStore } from "../../store/useUiStore";
import { useSettingsStore } from "../../store/useSettingsStore";
import { useTasksStore } from "../../store/useTasksStore";
import { AGENT_STATE_LABELS, formatBetween, formatDue, formatRelative } from "../../lib/format";
import { buildTree, liveSummary, type TreeAgent, type TreeRun, type TreeSession } from "../../lib/agentTree";
import {
  useAgentHistoryGroups,
  useAgentHistorySearch,
  useAgentRunHistory,
  useAgentSessionHistory,
  type AgentHistoryPageState,
} from "../../hooks/useAgentHistory";
import { copyText } from "../../lib/clipboard";
import { reportError } from "../../lib/errorReport";
import AgentStatsView from "./stats/AgentStatsView";
import { useLocale } from "../../hooks/useLocale";

// 徽标只描述「接入证据强度」，不把已安装 / 已配置 / 验证通过 / 已连接混为一谈。
// 徽标只做「一级短标签」，窄卡片下优先让徽标换行而不是挤压名称，完整证据解释放在展开区（HEALTH_DETAILS），
// 短文案不改变任何状态枚举与真实事件语义。
const HEALTH_LABELS: Record<string, string> = {
  live: "实时连接",
  "recent-event": "真实事件已验证",
  "recent-unconfigured": "有事件 · 未配置",
  stale: "已过期",
  "transport-verified": "待真实事件",
  "awaiting-first-event": "待事件",
  // 只有自测/旧版本写入的 verified 位，没有任何 origin=real 事件
  "self-test-only": "仅自测",
  "history-only": "历史记录",
  "no-events": "无事件",
  disabled: "已禁用",
  unregistered: "未注册",
};

/** 接入证据强度 → 徽标语义色；业务映射留在本页，公共组件不内置状态判断。 */
function healthTone(state: string): StatusTone {
  if (state === "live" || state === "recent-event") return "success";
  if (state === "recent-unconfigured" || state === "stale") return "warning";
  if (
    state === "transport-verified" ||
    state === "awaiting-first-event" ||
    state === "self-test-only"
  ) {
    return "info";
  }
  return "neutral";
}

/** 这些短标签本身已表达「尚无真实事件」，默认层不再重复同一句话。 */
const NO_EVENT_BADGE_STATES = new Set([
  "transport-verified",
  "awaiting-first-event",
  "self-test-only",
  "no-events",
  "unregistered",
]);

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

/** 会话/轮次标题匹配：面板搜索不仅找 Agent 名称，也能定位历史会话与任务标题。 */
function sessionMatchesQuery(session: TreeSession, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return false;
  return (
    session.title.toLowerCase().includes(q) ||
    session.externalId.toLowerCase().includes(q) ||
    session.runs.some((run) => run.taskTitle.toLowerCase().includes(q))
  );
}

/** 历史分区/历史轮次每页条数：先渲染实时项，历史按需展开、分页加载。 */
const HISTORY_PAGE = 10;
const FAILED_RECENT_MS = 60 * 60 * 1000;

/** 轮次是否属于「当前实时集合」：completed 与过期 failed/disconnected 归入历史。 */
function isLiveTreeRun(run: TreeRun): boolean {
  if (run.status === "running" || run.status === "waiting") return true;
  if (run.status === "failed" || run.status === "disconnected") {
    const at = new Date(run.updatedAt).getTime();
    return Number.isFinite(at) && Date.now() - at <= FAILED_RECENT_MS;
  }
  return false;
}

/** 后端历史轮次 → 监控树轮次（字段命名转换；不含实时判定）。 */
function toTreeRun(run: AgentRun): TreeRun {
  return {
    id: run.id,
    externalRunId: run.external_run_id,
    taskTitle: run.task_title,
    status: run.status,
    startedAt: run.started_at,
    endedAt: run.ended_at,
    updatedAt: run.updated_at,
    pending: run.pending_items,
  };
}

/**
 * 后端历史会话 → 监控树会话。历史查询不带轮次明细（轮次单独分页），
 * `runs` 为空；liveState 只用于样式，展示状态由 `displayStatus` 传真实 status。
 */
function toTreeSession(session: AgentHistorySession): TreeSession {
  return {
    id: session.id,
    externalId: session.external_id,
    title: session.title,
    status: session.status,
    lastSeen: session.last_seen_at,
    runs: [],
    liveState: "idle",
  };
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
  { id: "attention", labelKey: "agent.ui.filter.attention" },
  { id: "all", labelKey: "agent.ui.all" },
] as const;

type Section = "monitor" | "stats" | "onboard";

/** 扫描状态显式建模：`idle`（未扫）/ `scanning` / `success` / `error`，
 *  不再用 `scan === null` 同时表示「未加载」与「失败」。 */
type ScanState =
  | { status: "idle" }
  | { status: "scanning"; previous: DiscoveredAgent[] | null }
  | { status: "success"; data: DiscoveredAgent[] }
  | { status: "error"; message: string; previous: DiscoveredAgent[] | null };

/** 接入管理分组折叠偏好：稳定英文 ID + 独立 storage key，损坏时回退默认值。 */
const AGENT_SECTION_DEFAULTS = { discovery: true, bridge: false, custom: false } as const;
type AgentSectionId = keyof typeof AGENT_SECTION_DEFAULTS;
const AGENT_SECTIONS_KEY = "taskdock.agent.sections.v1";

export default function AgentPanel() {
  const { t: tr } = useLocale();
  const snapshot = useAgentsStore((s) => s.snapshot);
  const snapshotError = useAgentsStore((s) => s.snapshotError);
  const load = useAgentsStore((s) => s.load);
  const settings = useSettingsStore((s) => s.settings);
  const showToast = useUiStore((s) => s.showToast);
  const refreshTasks = useTasksStore((s) => s.refresh);
  const [scanState, setScanState] = useState<ScanState>({ status: "idle" });
  const scanSeq = useRef(0);
  const lastScanRef = useRef<DiscoveredAgent[] | null>(null);
  // 运行态在 store 中：组件卸载（切主 Tab）后仍保留步骤、结果与错误。
  const wizard = useAgentOnboardingStore((s) => s.wizard);
  const wizardRevision = useAgentOnboardingStore((s) => s.revision);
  const openWizard = useAgentOnboardingStore((s) => s.open);
  const installWizard = useAgentOnboardingStore((s) => s.install);
  const retryVerifyWizard = useAgentOnboardingStore((s) => s.retryVerify);
  const rollbackWizard = useAgentOnboardingStore((s) => s.uninstall);
  const dismissWizard = useAgentOnboardingStore((s) => s.dismiss);
  const [inboxDir, setInboxDir] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  // 若上次离开时接入操作仍在进行/结果未确认，重新进入直接回到向导页。
  const [section, setSection] = useState<Section>(() =>
    useAgentOnboardingStore.getState().wizard ? "onboard" : "monitor",
  );
  const [monitorFilter, setMonitorFilter] = useState<(typeof MONITOR_FILTERS)[number]["id"]>("attention");
  // 两处搜索状态相互独立；只在本已加载的数据上派生，不触发后端扫描。
  const [monitorQuery, setMonitorQuery] = useState("");
  const [discoverQuery, setDiscoverQuery] = useState("");
  // 历史分组截断提示的「搜索历史记录」入口：把焦点交还面板顶部唯一的搜索输入框
  // （SearchField 已有 aria-label/占位，不新增第二个输入框）。
  const monitorSearchRef = useRef<HTMLInputElement | null>(null);
  const focusMonitorSearch = useCallback(() => {
    monitorSearchRef.current?.focus();
  }, []);
  const [sectionOpen, setSectionOpen] = useState<Record<AgentSectionId, boolean>>(() =>
    readCollapsibleState(AGENT_SECTIONS_KEY, AGENT_SECTION_DEFAULTS),
  );

  const scanData =
    scanState.status === "success"
      ? scanState.data
      : scanState.status === "scanning" || scanState.status === "error"
        ? scanState.previous
        : null;
  const scanning = scanState.status === "scanning";
  const scanError = scanState.status === "error" ? scanState.message : null;

  const runScan = useCallback(async () => {
    // 请求序号：快速重复扫描 / 卸载后的迟到结果都不能覆盖最新一次
    const seq = ++scanSeq.current;
    setScanState({ status: "scanning", previous: lastScanRef.current });
    try {
      const data = await discoveryScan();
      if (seq !== scanSeq.current) return;
      lastScanRef.current = data;
      setScanState({ status: "success", data });
    } catch (e) {
      if (seq !== scanSeq.current) return;
      setScanState({
        status: "error",
        message: errorMessage(e),
        previous: lastScanRef.current,
      });
      reportError(e, { operation: "扫描 Agent" });
    }
  }, []);

  // 首次进入自动扫描；卸载后让尚未返回的扫描结果失效（不再 setState）
  useEffect(() => {
    if (scanState.status === "idle") void runScan();
  }, [scanState.status, runScan]);
  useEffect(
    () => () => {
      scanSeq.current += 1;
    },
    [],
  );

  function setSectionExpanded(sectionId: AgentSectionId, open: boolean) {
    setSectionOpen((prev) => {
      if (prev[sectionId] === open) return prev;
      const next = { ...prev, [sectionId]: open };
      persistCollapsibleState(AGENT_SECTIONS_KEY, next);
      return next;
    });
  }

  const tree = useMemo(() => (snapshot ? buildTree(snapshot) : []), [snapshot]);
  const summary = liveSummary(snapshot);

  // 桌面通知「定位本轮」：展开 Agent/实例/会话，滚动并短暂高亮到具体轮次。
  // 定位目标由 App 在收到 notification-navigate 后写入，处理完立即消费清除。
  const agentFocus = useUiStore((s) => s.agentFocus);
  const clearAgentFocus = useUiStore((s) => s.clearAgentFocus);
  /** 定位未命中次数：通知可能先于快照刷新到达，短暂等待树更新后再放弃 */
  const focusMissRef = useRef(0);
  /** 正在/已经发起后端定位的会话 ID，避免快照每次刷新重复请求 */
  const focusLookupRef = useRef<string | null>(null);
  /** 已应用过的定位 token，避免同一目标因快照刷新反复重启滚动等待 */
  const appliedFocusTokenRef = useRef<number | null>(null);
  /** 取消上一次定位的滚动等待（新通知/卸载时） */
  const focusScrollCancelRef = useRef<(() => void) | null>(null);
  /**
   * 快照外会话的后端定位结果：直接固定到对应真实分组的「历史会话」分区顶部，
   * 保证超过快照 200 上限的会话定位后立即可见（仍以历史查询的 total 为准）。
   */
  const [focusPin, setFocusPin] = useState<{
    item: AgentHistorySession;
    agentId: string;
    instanceId: string | null;
  } | null>(null);
  const treeRef = useRef(tree);
  treeRef.current = tree;

  /**
   * 等待目标行出现后滚动/高亮，再消费 agentFocus。
   * 历史会话要等后端分页返回才渲染，不能只等两帧；等待有上限（2.5s）。
   */
  function scrollToAgentTarget(
    sessionId: string,
    runId: string | null,
    onDone: () => void,
  ): () => void {
    let cancelled = false;
    let frame = 0;
    const deadline = Date.now() + 2500;
    const tick = () => {
      if (cancelled) return;
      const el =
        (runId && document.querySelector(`[data-agent-run-id="${runId}"]`)) ||
        document.querySelector(`[data-agent-session-id="${sessionId}"]`);
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
        onDone();
        return;
      }
      if (Date.now() >= deadline) {
        // 目标仍不可见（例如超出补页上限）：消费定位，不无限等待。
        onDone();
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      if (frame) cancelAnimationFrame(frame);
    };
  }

  const applyAgentFocus = useCallback(
    (target: {
      token: number;
      agentId: string;
      sessionId: string;
      instanceId: string | null;
      runId: string | null;
    }) => {
      appliedFocusTokenRef.current = target.token;
      focusMissRef.current = 0;
      setSection("monitor");
      setMonitorFilter("all");
      // 通知定位优先于任何筛选：清空搜索，确保即使当前条件把目标 Agent 过滤掉也能显示。
      setMonitorQuery("");
      setExpanded((e) => {
        const next: Record<string, boolean> = {
          ...e,
          [target.agentId]: true,
          [target.sessionId]: true,
          // 目标可能位于「历史会话」分区：显式展开并保留，避免定位后清除 focus 时折叠回去。
          [`${target.agentId}/${target.instanceId ?? "unassigned"}/history`]: true,
        };
        if (target.instanceId) next[`${target.agentId}/${target.instanceId}`] = true;
        return next;
      });
      focusScrollCancelRef.current?.();
      focusScrollCancelRef.current = scrollToAgentTarget(target.sessionId, target.runId, () => {
        focusScrollCancelRef.current = null;
        clearAgentFocus();
      });
    },
    [clearAgentFocus],
  );

  useEffect(() => {
    if (!agentFocus) {
      focusMissRef.current = 0;
      focusLookupRef.current = null;
      appliedFocusTokenRef.current = null;
      return;
    }
    if (tree.length === 0) return; // 快照未就绪时保留目标，等下一次树更新
    if (appliedFocusTokenRef.current === agentFocus.token) return;

    const sessionId = agentFocus.sessionId;
    const found = findSessionInTree(tree, sessionId);
    if (found) {
      focusLookupRef.current = null;
      applyAgentFocus({
        token: agentFocus.token,
        agentId: found.agentId,
        sessionId: found.session.id,
        instanceId: found.instanceId,
        runId: agentFocus.refId,
      });
      return;
    }

    // 快照只保留最近 200 条：未命中时按会话行 ID 精确查询后端，
    // 再展开真实的 source / instance（未知实例一律归入 unassigned，不伪造实例）。
    if (focusLookupRef.current === sessionId) return;
    focusLookupRef.current = sessionId;
    void (async () => {
      const stillCurrent = () =>
        focusLookupRef.current === sessionId &&
        useUiStore.getState().agentFocus?.sessionId === sessionId;
      try {
        const item = await agentHistorySession(sessionId);
        if (!stillCurrent()) return;
        if (!item) {
          focusLookupRef.current = null;
          focusMissRef.current += 1;
          if (focusMissRef.current >= 6) {
            focusMissRef.current = 0;
            clearAgentFocus(); // 多次刷新后仍无此会话：视为已清理，不伪造定位
          }
          return;
        }
        const agent = treeRef.current.find((a) => a.id === item.source_id);
        if (!agent) {
          // 来源不在当前快照（隐藏/已移除）：没有真实分组可展开，不伪造。
          focusLookupRef.current = null;
          focusMissRef.current = 0;
          clearAgentFocus();
          return;
        }
        // 后端已把无效/非真实实例归一为 null；有效实例即使不在实时快照里，
        // 也会由 agent_history_groups 补出真实入口，不能误归到未关联实例。
        const instanceId = item.instance_id ?? null;
        setFocusPin({
          item,
          agentId: item.source_id,
          instanceId,
        });
        applyAgentFocus({
          token: agentFocus.token,
          agentId: item.source_id,
          sessionId: item.id,
          instanceId,
          runId: agentFocus.refId,
        });
      } catch {
        if (!stillCurrent()) return;
        focusLookupRef.current = null;
        focusMissRef.current += 1;
        if (focusMissRef.current >= 6) {
          focusMissRef.current = 0;
          clearAgentFocus();
        }
      }
    })();
  }, [agentFocus, tree, applyAgentFocus, clearAgentFocus]);

  // 新的定位目标与旧「固定行」不是同一会话时移除旧固定行，避免误导。
  useEffect(() => {
    if (!agentFocus) return;
    setFocusPin((prev) => (prev && prev.item.id !== agentFocus.sessionId ? null : prev));
  }, [agentFocus?.sessionId]);

  // 组件卸载时取消尚未完成的滚动等待。
  useEffect(
    () => () => {
      focusScrollCancelRef.current?.();
      focusScrollCancelRef.current = null;
    },
    [],
  );

  const connectedSources = useMemo(
    () =>
      (snapshot?.sources ?? []).filter((s) =>
        (snapshot?.instances ?? []).some((i) => i.source_id === s.id) ||
        (snapshot?.sessions ?? []).some((x) => x.source_id === s.id),
      ).length,
    [snapshot],
  );

  const visibleAgents = useMemo(() => {
    const searching = monitorQuery.trim().length > 0;
    return tree.filter((a) => {
      // 「需关注」只看真实执行状态：软件在运行但未接入不算需要关注。
      // 但搜索是显式查找，必须能命中空闲 Agent 的历史会话，不能被当前筛选挡住。
      if (!searching && monitorFilter !== "all" && a.liveState === "idle") return false;
      if (matchesSource(monitorQuery, a.name, a.id)) return true;
      // 搜索历史会话标题 / 轮次任务标题：命中时保留该 Agent；
      // 命中项由「历史搜索结果」区按后端分页展示（不在这里伪造历史数据）。
      const q = monitorQuery.trim();
      if (!q) return false;
      return [
        ...a.instances.flatMap((inst) => inst.sessions),
        ...a.unassignedSessions,
      ].some((session) => sessionMatchesQuery(session, q));
    });
  }, [tree, monitorFilter, monitorQuery]);

  const monitorSearching = monitorQuery.trim().length > 0;
  // 历史搜索走后端分页（防抖 + 代际保护）；与实时快照刷新互不阻塞。
  // 只有打开「运行监控」分区且有搜索词时才请求，不轮询。
  const historySearch = useAgentHistorySearch(monitorQuery, section === "monitor");
  const searchHasHits =
    monitorSearching &&
    (historySearch.loading ||
      !!historySearch.error ||
      historySearch.total > 0 ||
      historySearch.items.length > 0);

  // 运行监控与「接入管理」共用同一次扫描结果，不额外起第二套发现逻辑
  const discoveryBySource = useMemo(() => {
    const m = new Map<string, DiscoveredAgent>();
    for (const d of scanData ?? []) m.set(d.source_id, d);
    return m;
  }, [scanData]);

  // 接入管理搜索：同样只在本已加载的扫描结果上派生，扫描按钮才是唯一的数据更新入口。
  const visibleSources = useMemo(
    () => (scanData ?? []).filter((d) => matchesSource(discoverQuery, d.display_name, d.source_id)),
    [scanData, discoverQuery],
  );
  // 自定义来源计数用于折叠标题行；与表单使用同一套预置 ID 排除规则
  const customSourceCount = useMemo(
    () => (snapshot?.sources ?? []).filter((x) => !PRESET_SOURCE_IDS.has(x.id)).length,
    [snapshot],
  );
  const scanBadge = scanning
    ? "扫描中…"
    : scanError
      ? "扫描失败"
      : scanData
        ? `${scanData.length} 个来源`
        : "未扫描";

  // 接入操作完成后刷新本地面板数据；运行态由 store 持有，面板卸载时跳过，
  // 重新进入时首次扫描会自动取最新状态。
  useEffect(() => {
    if (wizardRevision > 0) void runScan();
  }, [wizardRevision, runScan]);

  // ── 来源卡动作（不在向导弹窗内）──
  async function uninstallAgent(agentId: string) {
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
        {tr("agent.ui.loadFailed", { error: snapshotError })}
        <button className="btn sm" onClick={() => void load()}>
          {tr("common.retry")}
        </button>
      </div>
    ) : (
      <div className="empty-hint">{tr("common.loading")}…</div>
    );
  }

  return (
    <div className="agents-panel">
      {snapshotError && (
        // 保留旧快照但明确标记可能过期；持续故障不依赖一次性 Toast
        <div className="empty-hint error-text" role="status">
          {tr("agent.ui.syncFailed", { error: snapshotError })}
          <button className="btn sm" onClick={() => void load()}>
            {tr("common.retry")}
          </button>
        </div>
      )}
      {/* ══ 分区切换 ══ */}
      <div className="seg-group agents-section-switch" role="tablist" aria-label={tr("agent.ui.sectionAria")}>
        <button
          className={`seg-btn ${section === "monitor" ? "active" : ""}`}
          role="tab"
          aria-selected={section === "monitor"}
          onClick={() => setSection("monitor")}
        >
          <Activity size={12} /> {tr("agent.ui.monitor")}
        </button>
        <button
          className={`seg-btn ${section === "stats" ? "active" : ""}`}
          role="tab"
          aria-selected={section === "stats"}
          onClick={() => setSection("stats")}
        >
          <BarChart3 size={12} /> {tr("agent.ui.stats")}
        </button>
        <button
          className={`seg-btn ${section === "onboard" ? "active" : ""}`}
          role="tab"
          aria-selected={section === "onboard"}
          onClick={() => setSection("onboard")}
        >
          <PlugZap size={12} /> {tr("agent.ui.onboard")}
        </button>
      </div>

      {section === "monitor" && (
        <>
          {/* ══ 状态摘要 ══ */}
          <div className="agent-summary">
            <div className={`summary-card s-running ${summary.running ? "" : "muted"}`} title={tr("agent.ui.runningTip")}>
              <span className="summary-value">{summary.running}</span>
              <span className="summary-label">{tr("agent.ui.running")}</span>
            </div>
            <div className={`summary-card s-waiting ${summary.waiting ? "" : "muted"}`} title={tr("agent.ui.waitingTip")}>
              <span className="summary-value">{summary.waiting}</span>
              <span className="summary-label">{tr("agent.ui.waiting")}</span>
            </div>
            <div className={`summary-card s-error ${summary.failed ? "" : "muted"}`} title={tr("agent.ui.failedTip")}>
              <span className="summary-value">{summary.failed}</span>
              <span className="summary-label">{tr("agent.ui.failed")}</span>
            </div>
            <div className="summary-card muted" title={tr("agent.ui.sourcesTip")}>
              <span className="summary-value">{connectedSources}</span>
              <span className="summary-label">{tr("agent.ui.sources")}</span>
            </div>
          </div>

          <div className="filter-bar primary">
            <div className="seg-group subtle" role="group" aria-label={tr("agent.ui.filterAria")}>
              {MONITOR_FILTERS.map((f) => (
                <button
                  key={f.id}
                  className={`seg-btn ${monitorFilter === f.id ? "active" : ""}`}
                  onClick={() => setMonitorFilter(f.id)}
                >
                  {tr(f.labelKey)}
                </button>
              ))}
            </div>
            <SearchField
              className="agents-search"
              ariaLabel={tr("agent.ui.searchAria")}
              placeholder={tr("agent.ui.searchPlaceholder")}
              value={monitorQuery}
              onChange={setMonitorQuery}
              inputRef={monitorSearchRef}
              clearLabel={tr("agent.ui.clearSearch")}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  // stopPropagation：别让 Escape 冒泡到窗口级「隐藏到托盘」
                  e.stopPropagation();
                  setMonitorQuery("");
                }
              }}
            />
            <span className="flex-spacer" />
            <button className="btn sm" onClick={load} title={tr("agent.ui.refreshTip")}>
              <RefreshCw size={12} /> {tr("agent.ui.refresh")}
            </button>
          </div>

          {/* ══ 历史搜索结果（后端分页；与 Agent 名称过滤互不替代）══ */}
          {monitorSearching && (
            <HistorySearchResults
              state={historySearch}
              sources={snapshot.sources}
              instances={snapshot.instances}
              expanded={expanded}
              setExpanded={setExpanded}
              onPendingToTasks={onPendingToTasks}
              showToast={showToast}
              focusSessionId={agentFocus?.sessionId ?? null}
              focusRunId={agentFocus?.refId ?? null}
            />
          )}

          {/* ══ 监控树 ══ */}
          {visibleAgents.length === 0 && !searchHasHits && (
            <div className="empty-state">
              <div className="empty-icon"><AgentIcon size={22} /></div>
              <div className="empty-title">
                {monitorSearching ? tr("agent.ui.noMatch") : tr("agent.ui.noAttention")}
              </div>
              <div className="empty-hint">
                {monitorSearching
                  ? tr("agent.ui.noMatchHint", {
                      query: monitorQuery.trim(),
                      scope:
                        monitorFilter === "attention"
                          ? tr("agent.ui.scopeAttention")
                          : tr("agent.ui.scopeAll"),
                    })
                  : monitorFilter === "attention"
                    ? tr("agent.ui.idleHint")
                    : tr("agent.ui.emptyHint")}
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
                focusSessionId={agentFocus?.sessionId ?? null}
                focusRunId={agentFocus?.refId ?? null}
                focusPin={focusPin}
                onRequestSearchFocus={focusMonitorSearch}
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

      {section === "onboard" && wizard && (
        <AgentOnboardView
          state={wizard}
          onDismiss={dismissWizard}
          onRetryPreview={() => void openWizard(wizard.agent)}
          onInstall={() => void installWizard()}
          onRetryVerify={() => void retryVerifyWizard()}
          onRollback={() => void rollbackWizard()}
        />
      )}

      {section === "onboard" && !wizard && (
        <>
          {/* ══ 自动发现（默认展开；折叠标题行保留来源数量与扫描状态）══ */}
          <CollapsibleSection
            id="agent-section-discovery"
            title="Agent 自动发现"
            icon={<Radar size={12} />}
            badge={scanBadge}
            expanded={sectionOpen.discovery}
            onExpandedChange={(open) => setSectionExpanded("discovery", open)}
          >
            {/* 工具栏：宽时并排，窄时搜索框占满一行、扫描按钮换行，不互相挤压 */}
            <div className="agents-toolbar">
              <SearchField
                className="agents-search"
                ariaLabel="搜索 Agent 名称或来源 ID"
                placeholder="搜索名称 / source_id"
                value={discoverQuery}
                onChange={setDiscoverQuery}
                clearLabel="清空搜索"
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.stopPropagation();
                    setDiscoverQuery("");
                  }
                }}
              />
              <button className="btn sm" onClick={() => void runScan()} disabled={scanning}>
                <RefreshCw size={12} className={scanning ? "spin" : ""} />{" "}
                {scanning ? "扫描中…" : scanData ? "重新扫描" : "扫描"}
              </button>
            </div>

            {scanError && (
              <div className="empty-hint error-text agents-scan-error" role="alert">
                <span>
                  扫描失败：{scanError}
                  {scanData ? "；下方为上次成功结果，可能不是最新" : ""}
                </span>
                <button className="btn sm" onClick={() => void runScan()} disabled={scanning}>
                  重试
                </button>
              </div>
            )}
            {scanning && (
              <div className="empty-hint agents-scan-progress" role="status">
                {scanData ? "正在重新扫描，下方结果可能不是最新…" : "正在扫描本机 Agent…"}
              </div>
            )}
            {!scanning && scanState.status === "success" && scanData?.length === 0 && (
              <div className="empty-hint">未发现已安装的 Agent；可先安装 Codex / Trae 等后重新扫描</div>
            )}
            {scanData && scanData.length > 0 && visibleSources.length === 0 && (
              <div className="empty-hint">
                没有名称或 source_id 匹配「{discoverQuery.trim()}」；清空搜索可显示全部 {scanData.length} 个来源
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
                    onUninstall={() => uninstallAgent(a.source_id)}
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
          </CollapsibleSection>

          {/* ══ 通用桥接（默认折叠）══ */}
          <CollapsibleSection
            id="agent-section-bridge"
            title="通用桥接"
            description="HTTP / 文件投递"
            icon={<PlugZap size={12} />}
            expanded={sectionOpen.bridge}
            onExpandedChange={(open) => setSectionExpanded("bridge", open)}
          >
            <div className="bridge-body">
              <div className="bridge-actions">
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
          </CollapsibleSection>

          {/* ══ 自定义来源（默认折叠；表单随分组展开，不再有内外两层开合）══ */}
          <CollapsibleSection
            id="agent-section-custom"
            title="自定义来源"
            description="动态注册 · HTTP / 文件投递"
            icon={<Plus size={12} />}
            badge={customSourceCount > 0 ? `${customSourceCount} 个` : undefined}
            expanded={sectionOpen.custom}
            onExpandedChange={(open) => setSectionExpanded("custom", open)}
          >
            <CustomSourceForm
              onCreated={async () => {
                await Promise.all([load(), runScan()]);
              }}
              showToast={showToast}
            />
          </CollapsibleSection>
        </>
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
        <StatusBadge
          tone={healthTone(agent.health_state)}
          size="md"
          icon={badgeIcon}
          className="health-badge"
          dataTip={healthDetail}
        >
          {healthLabel}
        </StatusBadge>
      </div>

      {/* 第一层：安装状态 / 运行实例 / 最近真实事件（自然高度，不内部滚动） */}
      <div className="discovery-body">
        <div className="discovery-facts">
          <span>{agent.installed ? "已安装" : "未安装"}</span>
          <span>运行实例 {agent.running_instances.length}</span>
          {/* 有真实事件才在默认层显示时间；徽标已表达「尚无真实事件」时不重复同一句 */}
          {agent.last_real_event_at ? (
            <span className="fact-strong">最近真实事件 {formatRelative(agent.last_real_event_at)}</span>
          ) : NO_EVENT_BADGE_STATES.has(agent.health_state) ? null : (
            <span className="fact-muted">尚无真实事件</span>
          )}
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
  focusSessionId,
  focusRunId,
  focusPin,
  onRequestSearchFocus,
  discovery,
  onConnect,
}: {
  agent: TreeAgent;
  expanded: Record<string, boolean>;
  setExpanded: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  onPendingToTasks: (items: string[]) => Promise<void>;
  showToast: (m: string, o?: { kind?: "info" | "success" | "error" }) => void;
  focusSessionId: string | null;
  focusRunId: string | null;
  /** 快照外会话的后端定位结果（仅命中对应真实分组时注入） */
  focusPin?: { item: AgentHistorySession; agentId: string; instanceId: string | null } | null;
  /** 分组截断时的可操作出口：聚焦面板顶部搜索框（搜索可访问全部历史） */
  onRequestSearchFocus: () => void;
  discovery?: DiscoveredAgent;
  onConnect?: () => void;
}) {
  const open = !!expanded[agent.id];
  /** 快照外历史定位：即使快照已把该来源挤出窗口，也要能展开它真实的历史分区。 */
  const hasFocusPin = !!focusPin && focusPin.agentId === agent.id;
  const pinnedUnassigned = hasFocusPin && focusPin?.instanceId === null;
  const [caps, setCaps] = useState<AgentNavCapabilities | null>(null);

  // 历史入口分组：一次聚合查询补齐快照里没有近期会话的实例/未关联实例。
  // 实时状态变化（运行→完成/失联）时刷新；150ms 去抖，不轮询。
  const historyGroups = useAgentHistoryGroups(
    agent.id,
    open,
    `${agent.liveState}:${agent.activeCount}:${agent.sessionCount}`,
  );
  const historyByInstance = useMemo(() => {
    const map = new Map<string, number>();
    let unassigned = 0;
    for (const group of historyGroups.items) {
      if (group.instance_id) {
        map.set(group.instance_id, (map.get(group.instance_id) ?? 0) + group.count);
      } else {
        unassigned += group.count;
      }
    }
    return { map, unassigned };
  }, [historyGroups.items]);
  // 快照里没有、但历史里有的真实实例（instance_id 来自 agent_instances，不伪造）。
  const historyOnlyInstances = useMemo(
    () =>
      historyGroups.items
        .filter(
          (group) =>
            group.instance_id &&
            !agent.instances.some((inst) => inst.id === group.instance_id),
        )
        .map((group) => ({
          id: group.instance_id!,
          key: group.instance_key || group.instance_id!,
          displayName: group.display_name || group.instance_key || group.instance_id!,
          sessions: [],
          historyCount: group.count,
        })),
    [agent.instances, historyGroups.items],
  );
  const hasHistory =
    historyGroups.items.length > 0 || historyGroups.loading || !!historyGroups.error;

  // 三个正交维度：软件是否安装/运行（discovery）、监控是否接入（connected/health）、
  // 当前是否在执行（liveState）。进程存在绝不推导为「正在执行」。
  const softwareStatus = useMemo(() => {
    const running = discovery?.running_instances?.length ?? 0;
    // 历史证据与「当前接入」分开：历史可查不代表当前在线。
    if (hasHistory && !agent.connected) return "历史记录可查 · 当前无实时证据";
    if (!discovery) return agent.connected ? null : "未发现安装信息";
    if (running > 0 && !agent.connected) return "运行中 · 监控未连接";
    if (!discovery.installed) return "未安装";
    if (running === 0 && !agent.connected) return "已安装 · 未运行";
    if (!agent.connected) return "未接入监控";
    if (discovery.health_state === "stale") return "已接入 · 事件过期";
    if (discovery.health_state === "disabled") return "接入已停用";
    // self-test-only 必然 real_event_seen=false：必须先判断，否则永远落到「待真实事件」而丢失自测语义
    if (discovery.health_state === "self-test-only") return "仅自测通过 · 待真实事件";
    if (!discovery.real_event_seen) return "已配置 · 待真实事件";
    return null;
  }, [agent.connected, discovery, hasHistory]);

  // 已写入配置但尚未收到真实事件时，把第一条阻塞限制直接显示在默认行下方。
  // Trae 的「需在 Trae 内开启全局 Hooks」属于用户必须手动完成的步骤，不能只藏在详情里。
  const healthHint = useMemo(() => {
    if (!discovery || agent.connected) return null;
    const state = discovery.health_state;
    if (
      state === "awaiting-first-event" ||
      state === "transport-verified" ||
      state === "self-test-only"
    ) {
      return discovery.limitations[0] ?? null;
    }
    return null;
  }, [agent.connected, discovery]);

  // 展开时才探测跳转能力（证据化：探测结果随本机安装状态变化）
  useEffect(() => {
    if (open && !caps) {
      navAgentCapabilities(agent.id).then(setCaps).catch(() => setCaps(null));
    }
  }, [open, agent.id, caps]);

  // 展示用实例集合 = 快照实例（附历史数量）+ 历史里存在但快照没有的真实实例。
  const displayInstances = [
    ...agent.instances.map((inst) => ({
      inst,
      historyCount: historyByInstance.map.get(inst.id),
    })),
    ...historyOnlyInstances.map((inst) => ({
      inst: {
        id: inst.id,
        key: inst.key,
        displayName: inst.displayName,
        sessions: [],
      },
      historyCount: inst.historyCount,
    })),
  ];
  const unassignedLive = agent.unassignedSessions.filter(
    (session) => session.liveState !== "idle",
  ).length;
  const unassignedHistoryCount = historyByInstance.unassigned;
  const showUnassigned =
    agent.unassignedSessions.length > 0 || pinnedUnassigned || unassignedHistoryCount > 0;

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
      {healthHint && (
        <div className="empty-hint agent-health-hint" role="status">
          {healthHint}
        </div>
      )}
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
      {open && (agent.connected || hasFocusPin || hasHistory) && (
        <div className="tree-children">
          {displayInstances.map(({ inst, historyCount }) => {
            const liveCount = inst.sessions.filter(
              (session) => session.liveState !== "idle",
            ).length;
            const totalCount =
              historyCount === undefined
                ? inst.sessions.length
                : liveCount + historyCount;
            return (
            <div key={inst.id} className="tree-instance">
              <div className="tree-row">
                <button
                  className="tree-row-main"
                  onClick={() => setExpanded((e) => ({ ...e, [`${agent.id}/${inst.id}`]: !e[`${agent.id}/${inst.id}`] }))}
                  aria-expanded={!!expanded[`${agent.id}/${inst.id}`]}
                >
                  {expanded[`${agent.id}/${inst.id}`] ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                  <span className="tree-inst-key" title={inst.key}>{inst.key}</span>
                  <span className="tree-meta">{totalCount} 会话</span>
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
                  <SessionList
                    ownerKey={`${agent.id}/${inst.id}`}
                    sourceId={agent.id}
                    instanceId={inst.id}
                    agentId={agent.id}
                    agentName={agent.name}
                    sessions={inst.sessions}
                    historyCount={historyCount}
                    expanded={expanded}
                    setExpanded={setExpanded}
                    focusSessionId={focusSessionId}
                    focusRunId={focusRunId}
                    pinnedSession={
                      focusPin && focusPin.agentId === agent.id && focusPin.instanceId === inst.id
                        ? focusPin.item
                        : null
                    }
                    onPendingToTasks={onPendingToTasks}
                    showToast={showToast}
                    canResume={caps?.can_resume_session.supported ?? false}
                    resumeNote={caps?.can_resume_session.note ?? ""}
                    canFocus={caps?.can_focus_window.supported ?? false}
                  />
                </div>
              )}
            </div>
            );
          })}
          {showUnassigned && (
            <div className="tree-instance">
              <div className="tree-row unassigned-head" title="事件未携带实例信息，保持真实关系">
                <CircleSlash size={11} />
                <span className="tree-inst-key">未关联实例</span>
                <span className="tree-meta">
                  {Math.max(
                    agent.unassignedSessions.length,
                    pinnedUnassigned ? 1 : 0,
                    unassignedLive + unassignedHistoryCount,
                  )}{" "}
                  会话
                </span>
              </div>
              <SessionList
                ownerKey={`${agent.id}/unassigned`}
                sourceId={agent.id}
                instanceId={null}
                agentId={agent.id}
                agentName={agent.name}
                sessions={agent.unassignedSessions}
                historyCount={unassignedHistoryCount}
                expanded={expanded}
                setExpanded={setExpanded}
                focusSessionId={focusSessionId}
                focusRunId={focusRunId}
                pinnedSession={
                  focusPin && focusPin.agentId === agent.id && focusPin.instanceId === null
                    ? focusPin.item
                    : null
                }
                onPendingToTasks={onPendingToTasks}
                showToast={showToast}
                canResume={caps?.can_resume_session.supported ?? false}
                resumeNote={caps?.can_resume_session.note ?? ""}
                canFocus={caps?.can_focus_window.supported ?? false}
              />
            </div>
          )}
          {historyGroups.error && (
            <div className="empty-hint error-text" role="status">
              历史入口读取失败：{historyGroups.error}
              <button className="btn sm" onClick={historyGroups.reload}>
                重试
              </button>
            </div>
          )}
          {historyGroups.truncated && (
            // P2-02：截断不只提示，还给出可操作出口——搜索不依赖分组，可访问全部历史。
            <div className="empty-hint">
              历史实例过多，列表仅显示部分实例（前 {historyGroups.items.length} 个分组），
              可用搜索访问全部历史
              <button
                type="button"
                className="btn sm"
                aria-label="搜索历史记录"
                onClick={onRequestSearchFocus}
              >
                搜索历史记录
              </button>
            </div>
          )}
          {historyGroups.loading && !agent.connected && displayInstances.length === 0 && (
            <div className="empty-hint">正在读取历史入口…</div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * 会话列表：实时会话来自快照（保持事件驱动刷新），历史会话在展开时调用后端
 * keyset 分页，数量用后端 COUNT。快照 200 条上限之外的历史会话因此仍可访问，
 * 且不会为数百条历史生成隐藏 DOM。
 */
function SessionList({
  ownerKey,
  sourceId,
  instanceId,
  agentId,
  agentName,
  sessions,
  historyCount,
  expanded,
  setExpanded,
  focusSessionId,
  focusRunId,
  pinnedSession,
  onPendingToTasks,
  showToast,
  canResume,
  resumeNote,
  canFocus,
}: {
  ownerKey: string;
  /** 真实来源 ID（历史查询的 sourceId） */
  sourceId: string;
  /** 真实实例行 ID；null 表示「未关联实例」分组 */
  instanceId: string | null;
  agentId: string;
  agentName: string;
  sessions: TreeSession[];
  /** 后端历史分组 COUNT（不含实时会话）；未加载完成时为 undefined */
  historyCount?: number;
  expanded: Record<string, boolean>;
  setExpanded: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  focusSessionId: string | null;
  focusRunId: string | null;
  /** 后端按 ID 定位到的快照外会话（仅所属真实分组接收） */
  pinnedSession?: AgentHistorySession | null;
  onPendingToTasks: (items: string[]) => Promise<void>;
  showToast: (m: string, o?: { kind?: "info" | "success" | "error" }) => void;
  canResume: boolean;
  resumeNote: string;
  canFocus: boolean;
}) {
  const live = sessions.filter((s) => s.liveState !== "idle");
  const focusInHistory =
    !!focusSessionId &&
    (pinnedSession?.id === focusSessionId ||
      sessions.some((s) => s.liveState === "idle" && s.id === focusSessionId));
  const historyKey = `${ownerKey}/history`;
  const historyOpen = !!expanded[historyKey] || focusInHistory;
  const history = useAgentSessionHistory({
    sourceId,
    instanceId,
    unassigned: instanceId === null,
    enabled: historyOpen,
    pageSize: HISTORY_PAGE,
  });
  // P3-01「有新的历史记录 · 更新」：刷新前记住本列表中处于展开状态的历史会话；
  // 刷新后掉出已加载页的保留在列表顶部（按 id 去重、复用旧 item 对象），保证
  // 「不突然改变当前展开的会话」。后端 total 仍为准，保留项只是展示补充；
  // 用户折叠该会话或它重新进入已加载页后自动移除。
  const retainedRef = useRef<Map<string, AgentHistorySession>>(new Map());
  // 折叠态数量来自右侧一次聚合查询（AgentNode 层），展开后由分页 total 接管。
  // 后端历史查询与 COUNT 已排除实时会话，这里不再前端过滤，避免「total 未过滤、
  // 列表被过滤」造成数量与首屏不一致。
  const displayTotal = historyOpen
    ? history.loaded && !history.error
      ? history.total
      : historyCount
    : historyCount;
  const liveIds = new Set(live.map((s) => s.id));
  const historyItems = history.items;
  // 保留项：仍在展开状态、且不在当前已加载页中的历史会话（Map 键即 id，天然去重）。
  const retainedItems: AgentHistorySession[] = [];
  for (const [id, item] of retainedRef.current) {
    if (!expanded[id] || historyItems.some((n) => n.id === id)) continue;
    retainedItems.push(item);
  }
  // 快照外定位结果固定在最前；若后端分页/保留项已包含同一条则按 id 去重。
  const pinnedItem =
    pinnedSession &&
    !liveIds.has(pinnedSession.id) &&
    !retainedItems.some((item) => item.id === pinnedSession.id) &&
    !historyItems.some((item) => item.id === pinnedSession.id)
      ? pinnedSession
      : null;
  const shownHistory = [
    ...(pinnedItem ? [{ item: pinnedItem, session: toTreeSession(pinnedItem) }] : []),
    ...retainedItems.map((item) => ({ item, session: toTreeSession(item) })),
    ...historyItems.map((item) => ({ item, session: toTreeSession(item) })),
  ];

  /** 点击「有新的历史记录 · 更新」：立即消除提示并按正常分页重拉；已展开的
   *  历史会话先记入保留集合，刷新后若掉出第一页仍显示在列表顶部。 */
  function onUpdateHistory() {
    retainedRef.current = new Map(
      history.items.filter((item) => !!expanded[item.id]).map((item) => [item.id, item]),
    );
    history.markSeen();
    history.reload();
  }

  // 通知定位：目标可能不在第一页；按游标有上限地加载，最多 10 页（100 条），
  // 不因一次定位请求整段历史。
  const focusLoads = useRef(0);
  useEffect(() => {
    focusLoads.current = 0;
  }, [focusSessionId]);
  useEffect(() => {
    if (!focusSessionId || !historyOpen) return;
    if (history.loading || history.loadingMore || !history.hasMore) return;
    if (history.items.some((s) => s.id === focusSessionId)) return;
    if (focusLoads.current >= 10) return;
    focusLoads.current += 1;
    void history.loadMore();
  }, [focusSessionId, historyOpen, history]);

  const renderSession = (
    session: TreeSession,
    runCount?: number,
    displayStatus?: string,
    contextLabel?: string,
  ) => (
    <SessionNode
      key={session.id}
      agentId={agentId}
      agentName={agentName}
      session={session}
      expanded={expanded}
      setExpanded={setExpanded}
      displayStatus={displayStatus}
      runCount={runCount}
      contextLabel={contextLabel}
      focusRunId={focusSessionId === session.id ? focusRunId : null}
      onPendingToTasks={onPendingToTasks}
      showToast={showToast}
      canResume={canResume}
      resumeNote={resumeNote}
      canFocus={canFocus}
    />
  );

  return (
    <>
      {live.map((session) => renderSession(session))}
      <button
        type="button"
        className="tree-row tree-history-toggle"
        aria-label="历史会话分区"
        aria-expanded={historyOpen}
        onClick={() => setExpanded((e) => ({ ...e, [historyKey]: !historyOpen }))}
      >
        {historyOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        <span className="tree-inst-key">
          历史会话
          {displayTotal !== null && <span className="tree-meta"> {displayTotal}</span>}
        </span>
        <span className="tree-meta">
          {historyOpen
            ? history.loading
              ? "加载中…"
              : `已加载 ${shownHistory.length} 条 · 实时 ${live.length} 条单列`
            : historyCount === undefined
              ? "展开加载完整历史"
              : live.length > 0
                ? `实时 ${live.length} · 历史 ${historyCount}`
                : `共 ${historyCount} 条历史`}
        </span>
      </button>
      {historyOpen && history.hasNewer && (
        // 轻量提示按钮：不新增浮层、不抢键盘焦点，点击后手动刷新。
        <button
          type="button"
          className="btn sm tree-history-newer"
          aria-label="有新的历史记录，点击更新历史列表"
          onClick={onUpdateHistory}
        >
          有新的历史记录 · 更新
        </button>
      )}
      {historyOpen && history.error && (
        <div className="empty-hint error-text" role="alert">
          历史会话加载失败：{history.error}
          <button className="btn sm" onClick={history.reload}>
            重试
          </button>
        </div>
      )}
      {historyOpen && !history.error && history.loading && (
        <div className="empty-hint">正在加载历史会话…</div>
      )}
      {historyOpen &&
        !history.error &&
        !history.loading &&
        shownHistory.length === 0 && <div className="empty-hint">暂无历史会话</div>}
      {historyOpen &&
        shownHistory.map(({ item, session }) =>
          renderSession(
            session,
            item.run_count,
            item.status,
            pinnedItem && pinnedItem.id === item.id && item.instance_id && instanceId === null
              ? `${agentName} · 实例 ${item.instance_id.slice(0, 8)}…`
              : undefined,
          ),
        )}
      {historyOpen && history.hasMore && (
        <button
          type="button"
          className="btn sm tree-history-more"
          onClick={() => void history.loadMore()}
          disabled={history.loadingMore}
        >
          {history.loadingMore ? "加载中…" : "显示更多历史"}
        </button>
      )}
    </>
  );
}

/** 历史搜索结果：后端搜索 + 分页，条目携带真实来源/实例标签，不伪造实例关系。 */
function HistorySearchResults({
  state,
  sources,
  instances,
  expanded,
  setExpanded,
  onPendingToTasks,
  showToast,
  focusSessionId,
  focusRunId,
}: {
  state: AgentHistoryPageState<AgentHistorySession> & { query: string };
  sources: AgentSource[];
  instances: AgentInstance[];
  expanded: Record<string, boolean>;
  setExpanded: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  onPendingToTasks: (items: string[]) => Promise<void>;
  showToast: (m: string, o?: { kind?: "info" | "success" | "error" }) => void;
  focusSessionId: string | null;
  focusRunId: string | null;
}) {
  const sourceNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of sources) map.set(s.id, s.display_name);
    return map;
  }, [sources]);
  const instanceNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const i of instances) map.set(i.id, i.display_name || i.instance_key || i.id);
    return map;
  }, [instances]);

  // 防抖尚未完成/空搜索词时不显示空结果，避免「输入中」闪成无命中。
  const active = state.query.length > 0;
  return (
    <div className="tree-agent history-search-results" role="region" aria-label="历史搜索结果">
      <div className="tree-row unassigned-head">
        <span className="tree-inst-key">历史搜索结果</span>
        <span className="tree-meta">
          {!active
            ? "输入中…"
            : state.loading
              ? "搜索中…"
              : state.error
                ? "搜索失败"
                : `共 ${state.total} 条`}
        </span>
      </div>
      {active && state.error && (
        <div className="empty-hint error-text" role="alert">
          历史搜索失败：{state.error}
          <button className="btn sm" onClick={state.reload}>
            重试
          </button>
        </div>
      )}
      {active && !state.error && !state.loading && state.items.length === 0 && (
        <div className="empty-hint">没有匹配的历史会话</div>
      )}
      {active &&
        state.items.map((item) => {
          const agentName = sourceNames.get(item.source_id) ?? item.source_id;
          const instanceName = item.instance_id
            ? (instanceNames.get(item.instance_id) ?? "未知实例")
            : "未关联实例";
          return (
            <SessionNode
              key={item.id}
              agentId={item.source_id}
              agentName={agentName}
              session={toTreeSession(item)}
              expanded={expanded}
              setExpanded={setExpanded}
              displayStatus={item.status}
              runCount={item.run_count}
              contextLabel={`${agentName} · ${instanceName}`}
              focusRunId={focusSessionId === item.id ? focusRunId : null}
              onPendingToTasks={onPendingToTasks}
              showToast={showToast}
              canResume={false}
              resumeNote=""
              canFocus={false}
            />
          );
        })}
      {active && state.hasMore && (
        <button
          type="button"
          className="btn sm tree-history-more"
          onClick={() => void state.loadMore()}
          disabled={state.loadingMore}
        >
          {state.loadingMore ? "加载中…" : "显示更多结果"}
        </button>
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
  searchHit = false,
  displayStatus,
  runCount,
  contextLabel,
  focusRunId,
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
  searchHit?: boolean;
  /** 真实状态（历史条目用）；缺省沿用实时 liveState */
  displayStatus?: string;
  /** 轮次总数（历史条目用后端 run_count）；缺省用快照内轮次数 */
  runCount?: number;
  /** 搜索结果中的真实来源/实例标签 */
  contextLabel?: string;
  focusRunId: string | null;
  onPendingToTasks: (items: string[]) => Promise<void>;
  showToast: (m: string, o?: { kind?: "info" | "success" | "error" }) => void;
  canResume: boolean;
  resumeNote: string;
  canFocus: boolean;
}) {
  const open = !!expanded[session.id];
  // 能力未知（caps 未加载）时保守显示「跳转」；后端会诚实降级并在 Toast 说明
  const jumpSupported = canResume || canFocus;
  const status = displayStatus ?? session.liveState;
  return (
    <div
      className={`tree-session attention-${session.liveState}${searchHit ? " is-search-hit" : ""}`}
      data-agent-session-id={session.id}
    >
      {/* 行容器 div + 兄弟按钮：展开只负责展开，跳转只负责跳转（修复嵌套 button） */}
      <div className="tree-row">
        <button
          className="tree-row-main"
          onClick={() => setExpanded((e) => ({ ...e, [session.id]: !e[session.id] }))}
          aria-expanded={open}
        >
          {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          <span className={`session-state state-${status}`}>
            {AGENT_STATE_LABELS[status] ?? "未知"}
          </span>
          {contextLabel && (
            <span className="run-source" title={contextLabel}>
              {contextLabel}
            </span>
          )}
          <span className="tree-title">{session.title || session.externalId.slice(0, 24)}</span>
          <span className="tree-meta">
            {runCount ?? session.runs.length} 轮 · {formatRelative(session.lastSeen)}
          </span>
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
          <RunList
            sessionId={session.id}
            runs={session.runs}
            focusRunId={focusRunId}
            onPendingToTasks={onPendingToTasks}
          />
        </div>
      )}
    </div>
  );
}

/**
 * 轮次列表：实时轮次来自快照；历史轮次在展开时调用后端分页（准确 total + 游标）。
 * 快照 run 上限（300）之外的历史轮次因此仍可访问。
 */
function RunList({
  sessionId,
  runs,
  focusRunId,
  onPendingToTasks,
}: {
  sessionId: string;
  runs: TreeRun[];
  focusRunId: string | null;
  onPendingToTasks: (items: string[]) => Promise<void>;
}) {
  const history = useAgentRunHistory(sessionId, true, HISTORY_PAGE);
  const [open, setOpen] = useState(false);
  const live = runs.filter(isLiveTreeRun);
  const snapshotHistory = runs.filter((run) => !isLiveTreeRun(run));
  // 后端历史轮次查询默认排除实时轮次，COUNT 与列表同口径；这里不再前端过滤，
  // 否则会出现「列表少了但 total 仍含实时轮次」的数量不一致。
  const backendHistory = history.items.map(toTreeRun);
  // 首屏加载中/失败时先用快照内的历史轮次兜底，避免面板空白；
  // 成功后以分页结果为准，避免把快照上限当成完整历史。
  const backendReady = !history.loading && !history.error;
  const historyRuns = backendReady ? backendHistory : snapshotHistory;
  const total = backendReady ? history.total : snapshotHistory.length;

  // 通知定位：目标可能不在第一页；有上限地按游标加载（最多 10 页）。
  const focusLoads = useRef(0);
  useEffect(() => {
    focusLoads.current = 0;
  }, [focusRunId]);
  useEffect(() => {
    if (!focusRunId) return;
    if (historyRuns.some((r) => r.id === focusRunId)) {
      setOpen(true);
      return;
    }
    if (!backendReady || history.loadingMore || !history.hasMore) return;
    if (focusLoads.current >= 10) return;
    focusLoads.current += 1;
    void history.loadMore();
  }, [focusRunId, historyRuns, backendReady, history.loadingMore, history.hasMore, history]);

  const renderRun = (run: TreeRun) => (
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
  );

  return (
    <>
      {live.map(renderRun)}
      <button
        type="button"
        className="tree-history-toggle tree-history-toggle--runs"
        aria-label="历史轮次分区"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        历史轮次
        {!history.loading && !history.error && (
          <span className="tree-meta"> {total}</span>
        )}
        {history.loading && <span className="tree-meta"> 加载中…</span>}
      </button>
      {open && history.error && (
        <div className="empty-hint error-text" role="alert">
          历史轮次加载失败：{history.error}
          <button className="btn sm" onClick={history.reload}>
            重试
          </button>
        </div>
      )}
      {open && !history.error && !history.loading && historyRuns.length === 0 && (
        <div className="empty-hint">暂无历史轮次</div>
      )}
      {open && historyRuns.map(renderRun)}
      {open && backendReady && history.hasMore && (
        <button
          type="button"
          className="btn sm tree-history-more"
          onClick={() => void history.loadMore()}
          disabled={history.loadingMore}
        >
          {history.loadingMore ? "加载中…" : "显示更多轮次"}
        </button>
      )}
    </>
  );
}

// ── 自定义来源表单 ──

/** 迁移预置的来源 ID（不列入可删除的自定义来源）。 */
const PRESET_SOURCE_IDS = new Set([
  "mock", "codex", "trae", "workbuddy", "qoder",
  "deepseek-harness", "opencode", "zcode", "bridge",
]);

function CustomSourceForm({ onCreated, showToast }: { onCreated: () => Promise<void>; showToast: (m: string, o?: { kind?: "info" | "success" | "error" }) => void }) {
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

  // 表单随外层分组展开，本层不再维护「添加 / 收起」，避免内外两层开合打架
  return (
    <>
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
      <div className="endpoint-hint custom-source-note">
        自定义来源不写入任何宿主配置；注册后用 HTTP / 文件投递上报，source_id 必须与注册值一致。
      </div>
      {mySources.length > 0 ? (
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
      ) : (
        <div className="empty-hint">尚未注册自定义来源</div>
      )}
    </>
  );
}

// ── 接入向导（页内视图）──
// 不再使用 modal-backdrop：内容进入「接入管理」分区，与列表共用同一个内容区。
// 安装 / 验证 / 回滚的运行态在 store 中，离开页面不会取消，也不会重复触发。

function AgentOnboardView({
  state,
  onDismiss,
  onRetryPreview,
  onInstall,
  onRetryVerify,
  onRollback,
}: {
  state: OnboardState;
  onDismiss: () => void;
  onRetryPreview: () => void;
  onInstall: () => void;
  onRetryVerify: () => void;
  onRollback: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const busy = onboardBusy(state);
  const p = state.preview ?? {};
  const files =
    (p.hook_files as string[] | undefined) ??
    (p.plugin_file ? [p.plugin_file as string] : p.plugin_dir ? [p.plugin_dir as string] : []);
  const events = (p.events as string[] | undefined) ?? [];
  const verify = state.verify;

  // 页内视图没有焦点陷阱：进入时把焦点放在区域容器，Escape 仅在非运行态返回。
  useEffect(() => {
    containerRef.current?.focus();
  }, []);

  return (
    <div
      ref={containerRef}
      className="agent-onboard-view wf-subpage"
      role="region"
      aria-label={`接入向导：${state.agent.display_name}`}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !busy) {
          e.stopPropagation();
          onDismiss();
        }
      }}
    >
      <header className="wf-subpage-head">
        <button
          type="button"
          className="btn sm"
          onClick={onDismiss}
          disabled={busy}
          aria-label="返回接入列表"
          data-tip={busy ? "安装 / 验证进行中，完成后可返回；切换主 Tab 不会取消操作" : undefined}
        >
          <ArrowLeft size={13} aria-hidden="true" /> 返回接入列表
        </button>
        <h2 className="wf-subpage-title">接入 {state.agent.display_name}</h2>
        {busy ? (
          <span className="wf-subpage-note" role="status">
            <Loader2 size={12} className="spin" aria-hidden="true" />{" "}
            {state.step === "uninstalling" ? "正在回滚…" : "操作进行中，离开此页或切换主 Tab 不会取消"}
          </span>
        ) : null}
      </header>

      {state.step === "preview" && (
        <>
          <div className="wizard-step-tag">第 1 步 · 配置预览（尚未写入任何文件）</div>
          <ul className="wizard-preview">
            <li>将修改的文件：{files.length ? files.map((f) => <code key={f}>{f}</code>) : "无"}</li>
            <li>注册事件：{events.length ? events.join(" · ") : "（无自动事件通道）"}</li>
            <li>写入前自动备份，第三方 hooks 原样保留，失败自动回滚</li>
            {(p.limitations as string[] | undefined)?.map((l, i) => (
              <li key={i} className="wizard-warn">
                <AlertTriangle size={11} /> {l}
              </li>
            ))}
          </ul>
          {state.previewError ? (
            <div className="wizard-error" role="alert">
              <AlertTriangle size={12} /> 配置预览失败：{state.previewError}
              <button className="btn sm" onClick={onRetryPreview}>
                重新预览
              </button>
            </div>
          ) : null}
          <div className="wizard-actions">
            <button className="btn" onClick={onDismiss}>
              取消
            </button>
            <button className="btn primary" onClick={onInstall} disabled={!state.preview}>
              确认并安装
            </button>
          </div>
          <div className="wizard-note">
            安装会写入上方列出的第三方配置文件；这是本步骤唯一的写入授权，确认后才执行。
          </div>
        </>
      )}

      {state.step === "installing" && (
        <div className="empty-hint" role="status">
          <Loader2 size={13} className="spin" aria-hidden="true" /> 正在写入配置（备份 → 原子写入 → 校验）…
        </div>
      )}
      {state.step === "verifying" && (
        <div className="empty-hint" role="status">
          <Loader2 size={13} className="spin" aria-hidden="true" /> 正在执行真实链路验证（Hook 脚本 → Task Dock → 数据库）…
        </div>
      )}
      {state.step === "uninstalling" && (
        <div className="empty-hint" role="status">
          <Loader2 size={13} className="spin" aria-hidden="true" /> 正在卸载 Task Dock 写入的配置（第三方配置保留）…
        </div>
      )}

      {state.step === "result" && (
        <>
          <div className="wizard-step-tag">第 3 步 · 接入结果</div>
          {state.installError ? (
            <div className="wizard-error" role="alert">
              <AlertTriangle size={12} /> 安装失败：{state.installError}
              <div className="wizard-note">若已写入部分内容，后端已按契约自动回滚；可返回列表重新扫描确认。</div>
            </div>
          ) : null}
          {state.installOk && verify ? (
            <div className={verify.ok ? "wizard-ok" : "wizard-warn"} role={verify.ok ? "status" : "alert"}>
              {verify.ok ? (
                <>
                  <CheckCircle2 size={13} /> 链路验证通过：测试事件已真实抵达数据库（{verify.received_at ?? ""}）
                  <div className="wizard-note">
                    {verify.note ?? "自测事件只证明链路可达，不代表宿主已产生真实事件。"}
                  </div>
                </>
              ) : (
                <>
                  <AlertTriangle size={13} /> 验证未通过：{verify.reason ?? "未知原因"}
                  <button className="btn sm" onClick={onRetryVerify} disabled={busy}>
                    重试验证
                  </button>
                </>
              )}
            </div>
          ) : null}
          {state.installOk && state.verifyError ? (
            <div className="wizard-error" role="alert">
              <AlertTriangle size={12} /> 验证失败：{state.verifyError}
              <button className="btn sm" onClick={onRetryVerify} disabled={busy}>
                重试验证
              </button>
            </div>
          ) : null}
          {state.rollbackError ? (
            <div className="wizard-error" role="alert">
              <AlertTriangle size={12} /> 回滚失败：{state.rollbackError}
              <div className="wizard-note">配置可能仍保留；可重试回滚，或到来源卡用「卸载」再次执行。</div>
            </div>
          ) : null}
          <div className="wizard-actions">
            {state.installOk ? (
              <button className="btn danger" onClick={onRollback} disabled={busy}>
                回滚（卸载刚安装的配置）
              </button>
            ) : null}
            <button className="btn primary" onClick={onDismiss} disabled={busy}>
              完成
            </button>
          </div>
        </>
      )}
    </div>
  );
}
