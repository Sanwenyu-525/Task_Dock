//! 诊断中心：完整模式左侧导航的独立页面入口（默认隐藏，用户可在「导航自定义」开启）。
//!
//! 边界与约束：
//! - **薄视图**：状态、摘要、查询、导出、清理全部复用 `lib/bridge.ts` 的 diagnostics*
//!   API；前端不重写日志扫描、聚合、恢复判定与导出逻辑。
//! - **两种查询模式**：
//!   1. 异常列表（默认）：`anomaliesOnly: true`，级别最低 WARN；
//!   2. 操作链：只按 `operationId` 查询（不传 levels / anomaliesOnly），拿 DEBUG/INFO
//!      全量事件并按时间升序渲染。列表筛选条件绝不带入操作链查询。
//! - **按需加载**：只在页面可见时请求一次；筛选/刷新/清理后显式再请求。
//!   不注册定时器、不做后台轮询；页面隐藏时递增请求序号丢弃在途响应。
//! - **失败 ≠ 空**：读取失败显示「读取失败：<原因>」并提供重试；只有成功且 0 条时才进入空态。
//! - **清理需二次确认**：确认后调用后端；CONFLICT / TIMEOUT 等错误原样展示，不自动重试。
//! - 视觉只用语义 Token；窄窗（320/400）下筛选换行、列表两行、长文本截断、无横向滚动。

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  FolderOpen,
  Link2,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import { useLocale } from "../../hooks/useLocale";
import { useFullViewVisible } from "../../hooks/useMainUiVisible";
import { useUiStore } from "../../store/useUiStore";
import { ConfirmDialog, Select } from "../ui";
import { errorMessage } from "../../lib/errors";
import {
  diagnosticsClear,
  diagnosticsExport,
  diagnosticsOpenDir,
  diagnosticsQuery,
  diagnosticsStatus,
  diagnosticsSummary,
  type DiagnosticEventRecord,
  type DiagnosticLevel,
  type DiagnosticPage,
  type DiagnosticQuery,
  type DiagnosticStatusValue,
  type DiagnosticSummary,
  type DiagnosticSummaryGroup,
  type DiagnosticsStatus,
} from "../../lib/bridge";
import { setClientVerboseMode } from "../../lib/diagnostics";
import type { MessageKey } from "../../i18n";

const PAGE_SIZE = 30;
const CHAIN_LIMIT = 200;
const RANGE_HOURS: Record<RangeKey, number> = {
  "1h": 1,
  "24h": 24,
  "7d": 24 * 7,
  all: 0,
};

type RangeKey = "1h" | "24h" | "7d" | "all";
type LevelKey = "ALL" | "WARN" | "ERROR" | "CRITICAL";

interface FilterDraft {
  range: RangeKey;
  module: string;
  level: LevelKey;
  errorCode: string;
  operationId: string;
  keyword: string;
}

const INITIAL_FILTER: FilterDraft = {
  range: "24h",
  module: "ALL",
  level: "ALL",
  errorCode: "ALL",
  operationId: "",
  keyword: "",
};

/** 操作链视图状态：`matched` 用于说明命中数，`items` 已按时间升序。 */
interface ChainState {
  operationId: string;
  items: DiagnosticEventRecord[];
  matched: number;
  truncated: boolean;
  skipped: number;
  loading: boolean;
  error: string | null;
}

/** 导出结果：`complete` / `flushIssue` 来自后端导出契约（旧后端缺省时按 truncated 推断）。 */
type ExportOutcome = {
  path: string;
  bytes: number;
  records: number;
  truncated: boolean;
  complete?: boolean;
  flushIssue?: string | null;
};

/** 清理结果：`completed=false` 表示超时/取消，日志未被删除。 */
type ClearOutcome = {
  removedBytes: number;
  completed?: boolean;
  status: DiagnosticsStatus;
};

const FLUSH_ISSUE_KEYS: Record<string, MessageKey> = {
  queue_full: "diagnosticsCenter.export.reason.queue_full",
  timeout: "diagnosticsCenter.export.reason.timeout",
  not_flushed: "diagnosticsCenter.export.reason.not_flushed",
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 列表时间只保留「月-日 时:分:秒」，完整值放 data-tip。 */
function shortTime(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(iso);
  if (!match) return iso;
  return `${match[2]}-${match[3]} ${match[4]}:${match[5]}:${match[6]}`;
}

/** 操作链左列：保留毫秒，便于看清同一次操作内的事件先后。 */
function timeWithMs(iso: string): string {
  const match = /T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?/.exec(iso);
  if (!match) return iso;
  const ms = (match[4] ?? "0").padEnd(3, "0");
  return `${match[1]}:${match[2]}:${match[3]}.${ms}`;
}

function levelClass(level: DiagnosticLevel): string {
  return `diag-center-level diag-center-level-${level.toLowerCase()}`;
}

function groupKey(group: DiagnosticSummaryGroup): string {
  return `${group.module}|${group.action}|${group.errorCode ?? "-"}`;
}

function sinceForRange(range: RangeKey): string | undefined {
  const hours = RANGE_HOURS[range];
  if (!hours) return undefined;
  return new Date(Date.now() - hours * 3_600_000).toISOString();
}

function hasActiveFilter(draft: FilterDraft): boolean {
  return (
    draft.range !== INITIAL_FILTER.range ||
    draft.module !== INITIAL_FILTER.module ||
    draft.level !== INITIAL_FILTER.level ||
    draft.errorCode !== INITIAL_FILTER.errorCode ||
    draft.operationId.trim() !== "" ||
    draft.keyword.trim() !== ""
  );
}

/** 异常列表查询：级别最低 WARN（anomaliesOnly），`offset` 省略时用于导出。 */
function buildListFilter(draft: FilterDraft, offset?: number): DiagnosticQuery {
  return {
    levels: draft.level === "ALL" ? undefined : [draft.level],
    modules: draft.module === "ALL" ? undefined : [draft.module],
    errorCodes: draft.errorCode === "ALL" ? undefined : [draft.errorCode],
    operationId: draft.operationId.trim() ? draft.operationId.trim() : undefined,
    text: draft.keyword.trim() ? draft.keyword.trim() : undefined,
    since: sinceForRange(draft.range),
    anomaliesOnly: true,
    limit: offset === undefined ? undefined : PAGE_SIZE,
    offset,
  };
}

/** 按 `Date.parse` 升序；解析失败的放末尾，相同时间保持原序（稳定排序）。 */
function sortByTimeAsc(items: DiagnosticEventRecord[]): DiagnosticEventRecord[] {
  return items
    .map((item, index) => {
      const at = Date.parse(item.timestamp);
      return { item, index, at: Number.isFinite(at) ? at : Number.MAX_SAFE_INTEGER };
    })
    .sort((left, right) => left.at - right.at || left.index - right.index)
    .map((entry) => entry.item);
}

/** metadata 只做键值列表展示；对象/数组序列化为字符串，绝不再拼接额外敏感字段。 */
function metadataEntries(
  metadata?: Record<string, unknown>,
): Array<[string, string]> {
  if (!metadata) return [];
  return Object.entries(metadata)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => {
      if (typeof value === "string") return [key, value];
      try {
        return [key, JSON.stringify(value) ?? String(value)];
      } catch {
        return [key, String(value)];
      }
    });
}

const TERMINAL_STATUSES: ReadonlySet<DiagnosticStatusValue> = new Set([
  "success",
  "failed",
  "cancelled",
] as const);

export default function DiagnosticsCenterPanel() {
  const { t } = useLocale();
  const showToast = useUiStore((s) => s.showToast);
  const fullVisible = useFullViewVisible();
  const advancedId = useId();

  const [status, setStatus] = useState<DiagnosticsStatus | null>(null);
  const [health, setHealth] = useState<DiagnosticSummary | null>(null);
  const [summary, setSummary] = useState<DiagnosticSummary | null>(null);
  const [page, setPage] = useState<DiagnosticPage | null>(null);
  const [offset, setOffset] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [cleared, setCleared] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [chain, setChain] = useState<ChainState | null>(null);
  const [lastExport, setLastExport] = useState<{
    path: string;
    complete: boolean;
    truncated: boolean;
    flushIssue: string | null;
  } | null>(null);

  const [draft, setDraft] = useState<FilterDraft>(INITIAL_FILTER);
  // 只有「已应用」的筛选会触发请求：输入框打字不产生 IPC。
  const [applied, setApplied] = useState<FilterDraft>(INITIAL_FILTER);

  /** 请求序号：快速切换筛选时丢弃过期响应（不做无上限排队）。 */
  const requestSeq = useRef(0);
  /** 操作链请求序号：与列表互不覆盖；返回列表/隐藏页面时递增以丢弃在途响应。 */
  const chainSeq = useRef(0);

  const load = useCallback(
    async (nextOffset: number) => {
      const seq = ++requestSeq.current;
      setBusy("load");
      try {
        const listFilter = buildListFilter(applied, nextOffset);
        // 分面摘要不按模块/错误码收窄，否则选中后下拉只剩自己、无法再切换。
        const facetFilter = buildListFilter(
          { ...applied, module: "ALL", errorCode: "ALL" },
          undefined,
        );
        const [nextStatus, nextHealth, nextFacets, nextPage] = await Promise.all([
          diagnosticsStatus(),
          diagnosticsSummary({ since: sinceForRange("24h"), anomaliesOnly: true }),
          diagnosticsSummary(facetFilter),
          diagnosticsQuery(listFilter),
        ]);
        if (seq !== requestSeq.current) return;
        setStatus(nextStatus);
        setHealth(nextHealth);
        setSummary(nextFacets);
        setPage(nextPage);
        setOffset(nextOffset);
        setLoadError(null);
        setLoaded(true);
        setClientVerboseMode(nextStatus.mode === "verbose");
      } catch (e) {
        if (seq !== requestSeq.current) return;
        // 读取失败绝不能退化成「没有日志」：清空数据并进入独立错误态。
        setLoadError(errorMessage(e));
        setStatus(null);
        setHealth(null);
        setSummary(null);
        setPage(null);
      } finally {
        if (seq === requestSeq.current) setBusy(null);
      }
    },
    [applied],
  );

  // 只在完整面板可见（页面真正显示）时加载；隐藏/卸载时递增序号丢弃在途响应。
  useEffect(() => {
    if (!fullVisible) {
      requestSeq.current += 1;
      chainSeq.current += 1;
      setBusy(null);
      // 隐藏期间丢弃在途响应；重新可见时回到异常列表，避免停留在过期的加载态。
      setChain(null);
      return;
    }
    void load(0);
    return () => {
      requestSeq.current += 1;
      chainSeq.current += 1;
    };
  }, [fullVisible, load]);

  function applyFilter(next: FilterDraft) {
    setCleared(false);
    setDraft(next);
    setApplied(next);
  }

  function resetFilter() {
    applyFilter(INITIAL_FILTER);
  }

  function onRefresh() {
    setCleared(false);
    if (chain) {
      void openChain(chain.operationId);
      return;
    }
    void load(offset);
  }

  /** 操作链查询：只按 operationId，绝不带列表的 levels / anomaliesOnly / 时间范围。 */
  async function openChain(operationId: string) {
    const seq = ++chainSeq.current;
    setChain({
      operationId,
      items: [],
      matched: 0,
      truncated: false,
      skipped: 0,
      loading: true,
      error: null,
    });
    try {
      const next = await diagnosticsQuery({
        operationId,
        limit: CHAIN_LIMIT,
        offset: 0,
      });
      if (seq !== chainSeq.current) return;
      setChain({
        operationId,
        items: sortByTimeAsc(next.items),
        matched: next.matched,
        truncated: next.truncated,
        skipped: next.skipped,
        loading: false,
        error: null,
      });
    } catch (e) {
      if (seq !== chainSeq.current) return;
      setChain({
        operationId,
        items: [],
        matched: 0,
        truncated: false,
        skipped: 0,
        loading: false,
        error: errorMessage(e),
      });
    }
  }

  function closeChain() {
    chainSeq.current += 1;
    setChain(null);
  }

  function clearOperationFilter() {
    applyFilter({ ...draft, operationId: "" });
  }

  const moduleOptions = useMemo(() => {
    const options = [{ value: "ALL", label: t("diagnosticsCenter.filter.moduleAll") }];
    const seen = new Set<string>();
    for (const item of summary?.byModule ?? []) {
      seen.add(item.key);
      options.push({ value: item.key, label: `${item.key} (${item.count})` });
    }
    // 当前选中项必须始终可选，否则筛选后下拉会显示占位符。
    if (draft.module !== "ALL" && !seen.has(draft.module)) {
      options.push({ value: draft.module, label: draft.module });
    }
    return options;
  }, [summary, draft.module, t]);

  const codeOptions = useMemo(() => {
    const options = [{ value: "ALL", label: t("diagnosticsCenter.filter.codeAll") }];
    const seen = new Set<string>();
    for (const item of summary?.byCode ?? []) {
      seen.add(item.key);
      options.push({ value: item.key, label: `${item.key} (${item.count})` });
    }
    if (draft.errorCode !== "ALL" && !seen.has(draft.errorCode)) {
      options.push({ value: draft.errorCode, label: draft.errorCode });
    }
    return options;
  }, [summary, draft.errorCode, t]);

  const levelOptions = useMemo(
    () => [
      { value: "ALL", label: t("diagnosticsCenter.filter.levelAll") },
      { value: "WARN", label: "WARN" },
      { value: "ERROR", label: "ERROR" },
      { value: "CRITICAL", label: "CRITICAL" },
    ],
    [t],
  );

  const rangeOptions = useMemo(
    () => [
      { value: "1h", label: t("diagnosticsCenter.range.1h") },
      { value: "24h", label: t("diagnosticsCenter.range.24h") },
      { value: "7d", label: t("diagnosticsCenter.range.7d") },
      { value: "all", label: t("diagnosticsCenter.range.all") },
    ],
    [t],
  );

  /** 最近 24 小时的最近异常（按 lastSeen，而非聚合次数排序）。 */
  const latestAnomaly = useMemo(() => {
    let latest: DiagnosticSummaryGroup | null = null;
    let latestAt = Number.NEGATIVE_INFINITY;
    for (const group of health?.groups ?? []) {
      const at = Date.parse(group.lastSeen);
      if (!Number.isFinite(at)) continue;
      if (at > latestAt) {
        latest = group;
        latestAt = at;
      }
    }
    return latest;
  }, [health]);

  /** 从摘要分组回填「已恢复」：事件行本身没有恢复判定，摘要才有。 */
  const recoveredGroups = useMemo(() => {
    const map = new Set<string>();
    for (const group of summary?.groups ?? []) {
      if (group.recovered) map.add(groupKey(group));
    }
    return map;
  }, [summary]);

  async function copyText(text: string, okMessage: string) {
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error(t("diagnosticsCenter.list.clipboardUnavailable"));
      }
      await navigator.clipboard.writeText(text);
      showToast(okMessage, { kind: "success" });
    } catch (e) {
      setActionError(errorMessage(e));
    }
  }

  async function onCopyOperation(operationId: string) {
    await copyText(operationId, t("diagnosticsCenter.list.copyOperationOk"));
  }

  /** 操作链脱敏摘要：只输出 timestamp/level/stage/action/status/duration/message。 */
  async function onCopyChainSummary() {
    if (!chain || chain.items.length === 0) return;
    const lines = [
      t("diagnosticsCenter.chain.copyTitle", { operationId: chain.operationId }),
    ];
    for (const item of chain.items) {
      lines.push(
        [
          item.timestamp,
          item.level,
          `stage=${item.stage ?? "-"}`,
          `action=${item.action}`,
          `status=${item.status ?? item.event}`,
          `duration=${item.duration_ms !== undefined ? `${item.duration_ms}ms` : "-"}`,
          `message=${item.message ?? "-"}`,
        ].join(" "),
      );
    }
    await copyText(lines.join("\n"), t("diagnosticsCenter.chain.copySummaryOk"));
  }

  async function onCopySummary() {
    const lines: string[] = [`Task Dock ${t("diagnosticsCenter.title")}`];
    if (status) {
      lines.push(
        `session=${status.sessionId} mode=${status.mode} files=${status.files.length} size=${formatBytes(status.totalBytes)} written=${status.written} dropped=${status.dropped} aggregated=${status.aggregated} failures=${status.failures}`,
      );
    }
    if (health) {
      lines.push(
        `errors24h=${health.errors} warnings24h=${health.warnings} generatedAt=${health.generatedAt}${health.truncated ? " (truncated)" : ""}`,
      );
    }
    if (summary) {
      lines.push(
        `errors=${summary.errors} warnings=${summary.warnings} total=${summary.total} scanned=${summary.scanned}${summary.truncated ? " (truncated)" : ""}`,
      );
      for (const group of summary.groups.slice(0, 15)) {
        lines.push(
          `${group.level} ${group.module}/${group.action} code=${group.errorCode ?? "-"} count=${group.count} last=${group.lastSeen}${group.recovered ? " recovered" : ""}${group.sampleMessage ? ` :: ${group.sampleMessage}` : ""}`,
        );
      }
    }
    if (lines.length === 1) return;
    await copyText(lines.join("\n"), t("diagnosticsCenter.toast.copied"));
  }

  async function onExport() {
    setBusy("export");
    setActionError(null);
    try {
      const filter = buildListFilter(applied);
      delete filter.offset;
      delete filter.limit;
      const result = (await diagnosticsExport(filter)) as ExportOutcome;
      const complete = result.complete ?? !result.truncated;
      setLastExport({
        path: result.path,
        complete,
        truncated: result.truncated,
        flushIssue: result.flushIssue ?? null,
      });
      showToast(
        t("diagnosticsCenter.toast.exported", {
          records: result.records,
          size: formatBytes(result.bytes),
        }),
        { kind: complete ? "success" : "warning" },
      );
    } catch (e) {
      // 原样展示后端错误（磁盘满、权限不足等），不做静默重试。
      setActionError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function onOpenDir() {
    setActionError(null);
    try {
      await diagnosticsOpenDir();
    } catch (e) {
      setActionError(errorMessage(e));
    }
  }

  async function onClear() {
    setBusy("clear");
    setActionError(null);
    try {
      const result = (await diagnosticsClear()) as ClearOutcome;
      setStatus(result.status);
      setConfirmClear(false);
      if (result.completed === false) {
        // 后端已超时/取消：日志未被删除，不自动重试。
        showToast(t("diagnosticsCenter.toast.clearIncomplete"), { kind: "warning" });
      } else {
        showToast(
          t("diagnosticsCenter.toast.cleared", { size: formatBytes(result.removedBytes) }),
          { kind: "success" },
        );
        setCleared(true);
        closeChain();
      }
      await load(0);
    } catch (e) {
      // CONFLICT / TIMEOUT 等并发清理错误：展示后端原文，不重试。
      const message = errorMessage(e);
      setActionError(message);
      setConfirmClear(false);
      showToast(message, { kind: "error" });
    } finally {
      setBusy(null);
    }
  }

  /** 导出报告不完整时的原因（flushIssue + 截断），用于可解释警告。 */
  const exportIncompleteReason = useMemo(() => {
    if (!lastExport || lastExport.complete) return null;
    const reasons: string[] = [];
    if (lastExport.flushIssue) {
      const key = FLUSH_ISSUE_KEYS[lastExport.flushIssue];
      reasons.push(key ? t(key) : t("diagnosticsCenter.export.reason.unknown"));
    }
    if (lastExport.truncated) reasons.push(t("diagnosticsCenter.export.reason.truncated"));
    if (reasons.length === 0) reasons.push(t("diagnosticsCenter.export.reason.unknown"));
    return reasons.join(" ");
  }, [lastExport, t]);

  const verboseMinutes =
    status?.mode === "verbose" && status.verboseRemainingMs > 0
      ? Math.ceil(status.verboseRemainingMs / 60_000)
      : 0;

  const capacityPercent =
    status && status.maxTotalBytes > 0
      ? Math.max(0, Math.min(100, Math.round((status.totalBytes / status.maxTotalBytes) * 100)))
      : 0;
  // 容量占用是正常运维信号，不是错误：≥60% 用提示色，接近上限也只提示自动轮转。
  const capacityTone = capacityPercent >= 60 ? "is-warn" : "is-neutral";

  const filtered = hasActiveFilter(applied);
  const noLogsAtAll =
    !!status &&
    status.totalBytes === 0 &&
    status.written === 0 &&
    (page?.scanned ?? 0) === 0;
  const loading = busy === "load";

  const chainStarted =
    chain?.items.some((item) => item.status === "started" || item.event === "started") ?? false;
  const chainTerminal =
    chain?.items.some((item) => item.status && TERMINAL_STATUSES.has(item.status)) ?? false;
  /** 中间阶段是 DEBUG：普通模式下不会落盘，链路里自然看不到。 */
  const chainHasStages = chain?.items.some((item) => item.event === "stage") ?? false;

  function renderCopyButton(value: string, label: string, iconSize = 11) {
    const tip = `${t("common.copy")} ${label}`;
    return (
      <button
        type="button"
        className="icon-btn sm"
        aria-label={tip}
        data-tip={tip}
        onClick={() => void copyText(value, t("common.copied"))}
      >
        <Copy size={iconSize} aria-hidden="true" />
      </button>
    );
  }

  function renderDetails(item: DiagnosticEventRecord) {
    const meta = metadataEntries(item.metadata);
    return (
      <dl className="diag-center-details">
        <div className="diag-center-detail diag-center-detail-wide">
          <dt>{t("diagnosticsCenter.list.timestamp")}</dt>
          <dd className="diag-center-mono diag-center-message">{item.timestamp}</dd>
        </div>
        <div className="diag-center-detail diag-center-detail-wide">
          <dt>{t("diagnosticsCenter.list.operation")}</dt>
          {item.operation_id ? (
            <dd className="diag-center-op">
              <span className="diag-center-mono diag-center-ellipsis" data-tip={item.operation_id}>
                {item.operation_id}
              </span>
              <button
                type="button"
                className="icon-btn sm"
                aria-label={t("diagnosticsCenter.list.copyOperation")}
                data-tip={t("diagnosticsCenter.list.copyOperation")}
                onClick={() => void onCopyOperation(item.operation_id!)}
              >
                <Copy size={11} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="btn sm"
                onClick={() => void openChain(item.operation_id!)}
              >
                <Link2 size={11} aria-hidden="true" />
                <span>{t("diagnosticsCenter.list.chain")}</span>
              </button>
            </dd>
          ) : (
            <dd className="diag-center-detail-note">
              {t("diagnosticsCenter.list.noOperation")}
            </dd>
          )}
        </div>
        <div className="diag-center-detail">
          <dt>{t("diagnosticsCenter.list.session")}</dt>
          <dd className="diag-center-op">
            <span className="diag-center-mono diag-center-ellipsis" data-tip={item.session_id}>
              {item.session_id}
            </span>
            {renderCopyButton(item.session_id, t("diagnosticsCenter.list.session"))}
          </dd>
        </div>
        <div className="diag-center-detail">
          <dt>{t("diagnosticsCenter.list.window")}</dt>
          {item.window_id ? (
            <dd className="diag-center-op">
              <span
                className="diag-center-mono diag-center-ellipsis"
                data-tip={item.window_id}
              >
                {item.window_id}
              </span>
              {renderCopyButton(item.window_id, t("diagnosticsCenter.list.window"))}
            </dd>
          ) : (
            <dd className="diag-center-mono">{t("diagnosticsCenter.list.none")}</dd>
          )}
        </div>
        <div className="diag-center-detail">
          <dt>{t("diagnosticsCenter.list.stage")}</dt>
          <dd className="diag-center-mono">
            {item.stage ?? t("diagnosticsCenter.list.none")}
          </dd>
        </div>
        <div className="diag-center-detail">
          <dt>{t("diagnosticsCenter.list.duration")}</dt>
          <dd className="diag-center-mono">
            {item.duration_ms !== undefined
              ? `${item.duration_ms} ms`
              : t("diagnosticsCenter.list.none")}
          </dd>
        </div>
        <div className="diag-center-detail">
          <dt>{t("diagnosticsCenter.list.errorCategory")}</dt>
          <dd className="diag-center-mono diag-center-ellipsis">
            {item.error_category ?? t("diagnosticsCenter.list.none")}
          </dd>
        </div>
        <div className="diag-center-detail">
          <dt>{t("diagnosticsCenter.list.retryCount")}</dt>
          <dd className="diag-center-mono">
            {item.retry_count !== undefined
              ? item.retry_count
              : t("diagnosticsCenter.list.none")}
          </dd>
        </div>
        <div className="diag-center-detail">
          <dt>{t("diagnosticsCenter.list.source")}</dt>
          <dd className="diag-center-mono">{item.source}</dd>
        </div>
        <div className="diag-center-detail diag-center-detail-wide">
          <dt>{t("diagnosticsCenter.list.metadata")}</dt>
          <dd>
            {meta.length === 0 ? (
              <span className="diag-center-detail-note">
                {t("diagnosticsCenter.list.metadataEmpty")}
              </span>
            ) : (
              <dl className="diag-center-meta">
                {meta.map(([key, value]) => (
                  <div className="diag-center-meta-row" key={key}>
                    <dt className="diag-center-ellipsis" data-tip={key}>
                      {key}
                    </dt>
                    <dd className="diag-center-meta-value">
                      <span className="diag-center-ellipsis" data-tip={value}>
                        {value}
                      </span>
                      {renderCopyButton(value, key, 10)}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </dd>
        </div>
        <div className="diag-center-detail diag-center-detail-wide">
          <dt>{t("diagnosticsCenter.list.message")}</dt>
          <dd className="diag-center-message">
            {item.message ?? t("diagnosticsCenter.list.none")}
          </dd>
        </div>
      </dl>
    );
  }

  function renderChain() {
    if (!chain) return null;
    return (
      <section className="diag-center-chain" aria-label={t("diagnosticsCenter.chain.title")}>
        <div className="diag-center-chain-head">
          <button type="button" className="btn sm" onClick={closeChain}>
            <ArrowLeft size={12} aria-hidden="true" />
            <span>{t("diagnosticsCenter.chain.back")}</span>
          </button>
          <h2 className="diag-center-section-title">{t("diagnosticsCenter.chain.title")}</h2>
        </div>
        <div className="diag-center-chain-meta">
          <span
            className="diag-center-mono diag-center-ellipsis"
            data-tip={chain.operationId}
          >
            {chain.operationId}
          </span>
          <button
            type="button"
            className="icon-btn sm"
            aria-label={t("diagnosticsCenter.chain.copy")}
            data-tip={t("diagnosticsCenter.chain.copy")}
            onClick={() => void onCopyOperation(chain.operationId)}
          >
            <Copy size={11} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="btn sm"
            onClick={() => void onCopyChainSummary()}
            disabled={chain.loading || chain.items.length === 0}
          >
            <Copy size={11} aria-hidden="true" />
            <span>{t("diagnosticsCenter.chain.copySummary")}</span>
          </button>
          {!chain.loading && !chain.error && (
            <span className="diag-center-list-meta">
              {t("diagnosticsCenter.chain.meta", {
                count: chain.items.length,
                matched: chain.matched,
              })}
            </span>
          )}
        </div>

        {chain.loading ? (
          <div className="diag-center-state">{t("diagnosticsCenter.chain.loading")}</div>
        ) : chain.error ? (
          <div className="diag-center-state is-error" role="alert">
            <AlertTriangle size={13} aria-hidden="true" />
            <span>{t("diagnosticsCenter.chain.error", { error: chain.error })}</span>
            <button
              type="button"
              className="btn sm"
              onClick={() => void openChain(chain.operationId)}
            >
              {t("common.retry")}
            </button>
          </div>
        ) : chain.items.length === 0 ? (
          <div className="diag-center-state">
            <strong>{t("diagnosticsCenter.chain.empty")}</strong>
          </div>
        ) : (
          <>
            {!chainStarted && (
              <div className="diag-center-note is-warn" role="status">
                <AlertTriangle size={13} aria-hidden="true" />
                <span>{t("diagnosticsCenter.chain.noStart")}</span>
              </div>
            )}
            {!chainTerminal && (
              <div className="diag-center-note is-warn" role="status">
                <AlertTriangle size={13} aria-hidden="true" />
                <span>{t("diagnosticsCenter.chain.noTerminal")}</span>
              </div>
            )}
            {!chainHasStages && (
              <div className="diag-center-note" role="status">
                <span>{t("diagnosticsCenter.chain.noStages")}</span>
              </div>
            )}
            <ol className="diag-center-timeline" aria-label={t("diagnosticsCenter.chain.title")}>
              {chain.items.map((item, index) => {
                const isFailed =
                  item.status === "failed" ||
                  item.level === "ERROR" ||
                  item.level === "CRITICAL";
                const isSuccess = item.status === "success";
                const statusText = item.status ?? item.event;
                return (
                  <li className="diag-center-timeline-item" key={`${item.timestamp}-${index}`}>
                    <span
                      className="diag-center-timeline-time diag-center-mono"
                      data-tip={item.timestamp}
                    >
                      {timeWithMs(item.timestamp)}
                    </span>
                    <span className="diag-center-timeline-axis" aria-hidden="true">
                      <span
                        className={`diag-center-timeline-node${isFailed ? " is-error" : isSuccess ? " is-success" : ""}`}
                      />
                    </span>
                    <span className="diag-center-timeline-body">
                      <span className="diag-center-timeline-line">
                        <span className={levelClass(item.level)}>{item.level}</span>
                        {item.stage && (
                          <span className="diag-center-timeline-stage">{item.stage}</span>
                        )}
                        <span
                          className={`diag-center-timeline-status${isFailed ? " is-error" : isSuccess ? " is-success" : ""}`}
                        >
                          {statusText}
                        </span>
                        {item.duration_ms !== undefined && (
                          <span className="diag-center-timeline-duration diag-center-mono">
                            {item.duration_ms} ms
                          </span>
                        )}
                      </span>
                      <span className="diag-center-timeline-message">
                        {item.message ?? item.action}
                      </span>
                    </span>
                  </li>
                );
              })}
            </ol>
          </>
        )}

        {!chain.loading &&
          !chain.error &&
          (chain.truncated || chain.skipped > 0 || chain.matched > chain.items.length) && (
            <div className="diag-center-note">
              {chain.matched > chain.items.length && (
                <span>
                  {t("diagnosticsCenter.chain.limit", {
                    matched: chain.matched,
                    count: chain.items.length,
                  })}
                </span>
              )}
              {chain.truncated && <span>{t("diagnosticsCenter.chain.truncated")}</span>}
              {chain.skipped > 0 && (
                <span>
                  {t("diagnosticsCenter.chain.skipped", { count: chain.skipped })}
                </span>
              )}
            </div>
          )}
      </section>
    );
  }

  return (
    <div className="diag-center page-fill">
      <header className="diag-center-head">
        <div className="diag-center-head-text">
          <div className="diag-center-title-row">
            <h1 className="diag-center-title">{t("diagnosticsCenter.title")}</h1>
            <span
              className={`diag-center-mode${status?.mode === "verbose" ? " is-verbose" : ""}`}
              data-tip={t("diagnosticsCenter.mode.readonlyHint")}
            >
              <span className="diag-center-mode-dot" aria-hidden="true" />
              <span>
                {status
                  ? status.mode === "verbose"
                    ? t("diagnosticsCenter.overview.modeVerbose")
                    : t("diagnosticsCenter.overview.modeNormal")
                  : t("diagnosticsCenter.overview.mode")}
              </span>
              {verboseMinutes > 0 && (
                <span>
                  {t("diagnosticsCenter.overview.remaining", { minutes: verboseMinutes })}
                </span>
              )}
            </span>
          </div>
          <p className="diag-center-subtitle">{t("diagnosticsCenter.subtitle")}</p>
        </div>
        <div className="diag-center-actions">
          <button
            type="button"
            className="btn sm"
            onClick={onRefresh}
            disabled={chain ? chain.loading : loading || !fullVisible}
            aria-label={t("diagnosticsCenter.action.refresh")}
            data-tip={t("diagnosticsCenter.action.refresh")}
          >
            <RefreshCw
              size={12}
              className={(chain ? chain.loading : loading) ? "spin" : undefined}
              aria-hidden="true"
            />
            <span>{t("diagnosticsCenter.action.refresh")}</span>
          </button>
          <button type="button" className="btn sm" onClick={() => void onCopySummary()}>
            <Copy size={12} aria-hidden="true" />
            <span>{t("diagnosticsCenter.action.copySummary")}</span>
          </button>
          <button
            type="button"
            className="btn sm"
            onClick={() => void onExport()}
            disabled={busy === "export"}
          >
            <Download size={12} aria-hidden="true" />
            <span>{t("diagnosticsCenter.action.export")}</span>
          </button>
        </div>
      </header>

      <div className="page-scroll diag-body">
        {loadError && (
          <div className="diag-center-state is-error" role="alert">
            <AlertTriangle size={13} aria-hidden="true" />
            <span>{t("diagnosticsCenter.list.error", { error: loadError })}</span>
            <button type="button" className="btn sm" onClick={() => void load(offset)}>
              {t("common.retry")}
            </button>
          </div>
        )}
        {actionError && (
          <div className="diag-center-state is-error" role="alert">
            <AlertTriangle size={13} aria-hidden="true" />
            <span>{actionError}</span>
          </div>
        )}
        {status?.degraded && (
          <div className="diag-center-note is-warn" role="status">
            <AlertTriangle size={13} aria-hidden="true" />
            <span>
              {t("diagnosticsCenter.overview.degraded")}
              {status.lastError ? ` (${status.lastError})` : ""}
            </span>
          </div>
        )}
        {cleared && (
          <div className="diag-center-state is-success" role="status">
            <span>{t("diagnosticsCenter.list.cleared")}</span>
          </div>
        )}

        <section className="diag-center-overview" aria-label={t("diagnosticsCenter.overview.title")}>
          <h2 className="diag-center-section-title">{t("diagnosticsCenter.overview.title")}</h2>
          <div className="diag-center-metrics">
            <div className="diag-center-metric">
              <span className="diag-center-metric-label">
                {t("diagnosticsCenter.overview.errors")}
              </span>
              <span className="diag-center-metric-value is-error">
                {health ? health.errors : "—"}
              </span>
            </div>
            <div className="diag-center-metric">
              <span className="diag-center-metric-label">
                {t("diagnosticsCenter.overview.warnings")}
              </span>
              <span className="diag-center-metric-value is-warn">
                {health ? health.warnings : "—"}
              </span>
            </div>
            <div className="diag-center-metric diag-center-metric-wide">
              <span className="diag-center-metric-label">
                {t("diagnosticsCenter.overview.latest")}
              </span>
              <span className="diag-center-metric-value">
                {latestAnomaly ? (
                  <span className="diag-center-latest" data-tip={latestAnomaly.lastSeen}>
                    <span className={levelClass(latestAnomaly.level)}>{latestAnomaly.level}</span>
                    <span className="diag-center-ellipsis">
                      {latestAnomaly.module}/{latestAnomaly.action}
                    </span>
                    <span className="diag-center-mono">
                      {shortTime(latestAnomaly.lastSeen)}
                    </span>
                  </span>
                ) : health ? (
                  t("diagnosticsCenter.overview.latestNone")
                ) : (
                  "—"
                )}
              </span>
            </div>
            <div
              className="diag-center-metric diag-center-metric-wide diag-center-metric-capacity"
            >
              <span className="diag-center-metric-label">
                {t("diagnosticsCenter.overview.capacity")}
              </span>
              <span className="diag-center-capacity-text diag-center-mono">
                {status
                  ? `${formatBytes(status.totalBytes)} / ${formatBytes(status.maxTotalBytes)}`
                  : "—"}
              </span>
              <div
                className={`diag-center-capacity-track ${capacityTone}`}
                role="progressbar"
                aria-label={t("diagnosticsCenter.overview.capacityAria", {
                  percent: capacityPercent,
                })}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={capacityPercent}
              >
                <span
                  className="diag-center-capacity-fill"
                  style={{ width: `${capacityPercent}%` }}
                />
              </div>
              {capacityPercent > 90 && (
                <span className="diag-center-capacity-note">
                  {t("diagnosticsCenter.overview.capacityNote")}
                </span>
              )}
            </div>
          </div>
        </section>

        {!chain && (
          <section className="diag-center-filters" aria-label={t("diagnosticsCenter.filter.title")}>
            <h2 className="diag-center-section-title">{t("diagnosticsCenter.filter.title")}</h2>
            <div className="diag-center-filter-grid">
              <div className="diag-center-field">
                <span className="diag-center-field-label">
                  {t("diagnosticsCenter.filter.range")}
                </span>
                <Select
                  value={draft.range}
                  options={rangeOptions}
                  onChange={(value) => setDraft({ ...draft, range: value as RangeKey })}
                  ariaLabel={t("diagnosticsCenter.filter.range")}
                  size="sm"
                  align="start"
                  block
                />
              </div>
              <div className="diag-center-field">
                <span className="diag-center-field-label">
                  {t("diagnosticsCenter.filter.level")}
                </span>
                <Select
                  value={draft.level}
                  options={levelOptions}
                  onChange={(value) => setDraft({ ...draft, level: value as LevelKey })}
                  ariaLabel={t("diagnosticsCenter.filter.level")}
                  size="sm"
                  align="start"
                  block
                />
              </div>
              <div className="diag-center-field">
                <span className="diag-center-field-label">
                  {t("diagnosticsCenter.filter.module")}
                </span>
                <Select
                  value={draft.module}
                  options={moduleOptions}
                  onChange={(value) => setDraft({ ...draft, module: value })}
                  ariaLabel={t("diagnosticsCenter.filter.module")}
                  size="sm"
                  align="start"
                  block
                />
              </div>
              <div className="diag-center-field">
                <span className="diag-center-field-label">
                  {t("diagnosticsCenter.filter.keyword")}
                </span>
                <input
                  className="diag-center-input"
                  type="search"
                  value={draft.keyword}
                  placeholder={t("diagnosticsCenter.filter.keywordPlaceholder")}
                  aria-label={t("diagnosticsCenter.filter.keyword")}
                  onChange={(event) => setDraft({ ...draft, keyword: event.target.value })}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") applyFilter(draft);
                  }}
                />
              </div>
              <div className="diag-center-filter-actions">
                <button type="button" className="btn sm" onClick={() => applyFilter(draft)}>
                  {t("diagnosticsCenter.filter.apply")}
                </button>
                <button type="button" className="btn sm" onClick={resetFilter}>
                  {t("diagnosticsCenter.filter.reset")}
                </button>
              </div>
            </div>

            <button
              type="button"
              className="diag-center-advanced-toggle"
              aria-expanded={advancedOpen}
              aria-controls={advancedId}
              onClick={() => setAdvancedOpen((open) => !open)}
            >
              {advancedOpen ? (
                <ChevronDown size={11} aria-hidden="true" />
              ) : (
                <ChevronRight size={11} aria-hidden="true" />
              )}
              <span>{t("diagnosticsCenter.filter.advanced")}</span>
            </button>
            {advancedOpen && (
              <div className="diag-center-advanced" id={advancedId}>
                <div className="diag-center-filter-grid">
                  <div className="diag-center-field">
                    <span className="diag-center-field-label">
                      {t("diagnosticsCenter.filter.code")}
                    </span>
                    <Select
                      value={draft.errorCode}
                      options={codeOptions}
                      onChange={(value) => setDraft({ ...draft, errorCode: value })}
                      ariaLabel={t("diagnosticsCenter.filter.code")}
                      size="sm"
                      align="start"
                      block
                    />
                  </div>
                  <div className="diag-center-field">
                    <span className="diag-center-field-label">
                      {t("diagnosticsCenter.filter.operation")}
                    </span>
                    <input
                      className="diag-center-input diag-center-mono"
                      type="text"
                      value={draft.operationId}
                      placeholder={t("diagnosticsCenter.filter.operationPlaceholder")}
                      aria-label={t("diagnosticsCenter.filter.operation")}
                      onChange={(event) =>
                        setDraft({ ...draft, operationId: event.target.value })
                      }
                      onKeyDown={(event) => {
                        if (event.key === "Enter") applyFilter(draft);
                      }}
                    />
                  </div>
                </div>
              </div>
            )}
          </section>
        )}

        {!chain && lastExport && (
          <div className="diag-center-export">
            <span className="diag-center-export-label">
              {t("diagnosticsCenter.export.last")}
            </span>
            <span className="diag-center-mono diag-center-ellipsis" data-tip={lastExport.path}>
              {lastExport.path}
            </span>
            <span
              className={`diag-center-flag ${lastExport.complete ? "is-ok" : "is-warn"}`}
              data-tip={exportIncompleteReason ?? undefined}
            >
              {lastExport.complete
                ? t("diagnosticsCenter.export.complete")
                : t("diagnosticsCenter.export.incompleteFlag")}
            </span>
            {exportIncompleteReason && (
              <div className="diag-center-note is-warn" role="status">
                <AlertTriangle size={13} aria-hidden="true" />
                <span>
                  {t("diagnosticsCenter.export.incomplete", {
                    reason: exportIncompleteReason,
                  })}
                </span>
              </div>
            )}
          </div>
        )}

      {chain ? (
          renderChain()
        ) : (
          <section className="diag-center-list" aria-label={t("diagnosticsCenter.list.title")}>
            <div className="diag-center-list-head">
              <h2 className="diag-center-section-title">{t("diagnosticsCenter.list.title")}</h2>
              {page && (
                <span className="diag-center-list-meta">
                  {t("diagnosticsCenter.list.pageInfo", {
                    shown: page.items.length,
                    matched: page.matched,
                  })}
                </span>
              )}
            </div>

            {applied.operationId.trim() && (
              <div className="diag-center-op-chip">
                <span className="diag-center-op-chip-label">
                  {t("diagnosticsCenter.filter.operationChip")}
                </span>
                <span
                  className="diag-center-mono diag-center-ellipsis"
                  data-tip={applied.operationId.trim()}
                >
                  {applied.operationId.trim()}
                </span>
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => void openChain(applied.operationId.trim())}
                >
                  <Link2 size={11} aria-hidden="true" />
                  <span>{t("diagnosticsCenter.filter.viewChain")}</span>
                </button>
                <button
                  type="button"
                  className="btn sm"
                  onClick={clearOperationFilter}
                >
                  <X size={11} aria-hidden="true" />
                  <span>{t("diagnosticsCenter.filter.clearOperation")}</span>
                </button>
              </div>
            )}

            {loadError ? null : !loaded ? (
              <div className="diag-center-state">{t("diagnosticsCenter.list.loading")}</div>
            ) : page && page.items.length > 0 ? (
              <ul className="diag-center-rows">
                {page.items.map((item: DiagnosticEventRecord, index) => {
                  const rowKey = `${item.timestamp}-${index}`;
                  const isOpen = expanded === rowKey;
                  const recovered = recoveredGroups.has(
                    `${item.module}|${item.action}|${item.error_code ?? "-"}`,
                  );
                  return (
                    <li key={rowKey} className="diag-center-row-item">
                      <button
                        type="button"
                        className="diag-center-row"
                        aria-expanded={isOpen}
                        aria-label={
                          isOpen
                            ? t("diagnosticsCenter.list.collapse")
                            : t("diagnosticsCenter.list.expand")
                        }
                        onClick={() => setExpanded(isOpen ? null : rowKey)}
                      >
                        {isOpen ? (
                          <ChevronDown size={12} aria-hidden="true" />
                        ) : (
                          <ChevronRight size={12} aria-hidden="true" />
                        )}
                        <span className="diag-center-row-body">
                          <span className="diag-center-row-line">
                            <span className={levelClass(item.level)}>{item.level}</span>
                            <span className="diag-center-row-module diag-center-ellipsis">
                              {item.module}/{item.action}
                            </span>
                            <span
                              className="diag-center-row-time"
                              data-tip={item.timestamp}
                            >
                              {shortTime(item.timestamp)}
                            </span>
                            {item.count > 1 && (
                              <span className="diag-center-row-count">×{item.count}</span>
                            )}
                          </span>
                          <span className="diag-center-row-line is-sub">
                            {item.error_code && (
                              <span className="diag-center-row-code">{item.error_code}</span>
                            )}
                            <span className="diag-center-row-message diag-center-ellipsis">
                              {item.message ?? item.action}
                            </span>
                            {recovered && (
                              <span className="diag-center-row-recovered">
                                {t("diagnosticsCenter.list.recovered")}
                              </span>
                            )}
                          </span>
                        </span>
                      </button>
                      {isOpen && renderDetails(item)}
                    </li>
                  );
                })}
              </ul>
            ) : filtered ? (
              <div className="diag-center-state diag-center-state-empty">
                <strong>{t("diagnosticsCenter.list.emptyFiltered")}</strong>
                <span>{t("diagnosticsCenter.list.emptyFilteredHint")}</span>
                <button type="button" className="btn sm" onClick={resetFilter}>
                  {t("diagnosticsCenter.filter.reset")}
                </button>
              </div>
            ) : cleared ? (
              // 清理成功后即使页面已滚到列表，也要在列表位置明确说明「只删日志、不删业务数据」。
              <div className="diag-center-state is-success">
                <strong>{t("diagnosticsCenter.list.cleared")}</strong>
              </div>
            ) : noLogsAtAll ? (
              <div className="diag-center-state">
                <strong>{t("diagnosticsCenter.list.empty")}</strong>
                <span>{t("diagnosticsCenter.list.emptyNoLogsHint")}</span>
              </div>
            ) : (
              <div className="diag-center-state">
                <strong>{t("diagnosticsCenter.list.empty")}</strong>
                <span>{t("diagnosticsCenter.list.emptyHint")}</span>
              </div>
            )}

            {!loadError && (page?.truncated || (page?.skipped ?? 0) > 0) && (
              <div className="diag-center-note">
                {page?.truncated && <span>{t("diagnosticsCenter.list.truncated")}</span>}
                {(page?.skipped ?? 0) > 0 && (
                  <span>{t("diagnosticsCenter.list.skipped", { count: page!.skipped })}</span>
                )}
              </div>
            )}

            <div className="diag-center-pager">
              <button
                type="button"
                className="btn sm"
                onClick={() => void load(Math.max(0, offset - PAGE_SIZE))}
                disabled={offset === 0 || loading}
              >
                {t("diagnosticsCenter.list.prev")}
              </button>
              <button
                type="button"
                className="btn sm"
                onClick={() => void load(offset + PAGE_SIZE)}
                disabled={!page || page.matched <= offset + page.items.length || loading}
              >
                {t("diagnosticsCenter.list.next")}
              </button>
            </div>
          </section>
        )}

        <section className="diag-center-manage" aria-label={t("diagnosticsCenter.manage.title")}>
          <h2 className="diag-center-section-title">{t("diagnosticsCenter.manage.title")}</h2>
          <div className="diag-center-manage-actions">
            <button type="button" className="btn sm" onClick={() => void onOpenDir()}>
              <FolderOpen size={12} aria-hidden="true" />
              <span>{t("diagnosticsCenter.action.openDir")}</span>
            </button>
            <button
              type="button"
              className="btn sm danger"
              onClick={() => setConfirmClear(true)}
              disabled={busy === "clear"}
            >
              <Trash2 size={12} aria-hidden="true" />
              <span>{t("diagnosticsCenter.action.clear")}</span>
            </button>
          </div>
        </section>
      </div>

      <ConfirmDialog
        open={confirmClear}
        title={t("diagnosticsCenter.clear.title")}
        detail={t("diagnosticsCenter.clear.detail")}
        confirmLabel={t("diagnosticsCenter.clear.confirm")}
        danger
        busy={busy === "clear"}
        onConfirm={() => void onClear()}
        onCancel={() => setConfirmClear(false)}
      />
    </div>
  );
}
