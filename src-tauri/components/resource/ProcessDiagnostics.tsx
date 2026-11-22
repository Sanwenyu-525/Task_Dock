//! 进程诊断：本应用进程指标 + 按需展开的开发相关进程列表。
//!
//! 安全边界（与后端命令一一对应）：
//! - 只读：不结束、不挂起、不修改任何进程；
//! - 按需：只在用户展开或面板显式请求时加载一次，不轮询、不注册监听器；
//! - 归属：PID / 父进程链 / 镜像路径为证据，名称匹配仅作线索；
//! - 状态：只表达观察结果，不构成「应该结束」的建议。
//!
//! 数据由资源管理面板持有（内存分区也要用同一份 WebView2 子进程数据），
//! 本组件只负责呈现、展开/收起与排序。
//!
//! 2026-11-14：进程行改为两级信息。默认只显示名称、CPU/内存数值和一行身份；
//! 占用条、相对占比与归属依据在行内展开。列表不再内部限高滚动，页面只有一
//! 个滚动容器，滚轮指向始终明确。

import { useEffect, useRef, useState } from "react";
import { ChevronDown, ListTree, RefreshCw } from "lucide-react";
import {
  type ResourceProcessAssociation,
  type ResourceProcessBasis,
  type ResourceProcessDiagnostics,
  type ResourceProcessRow,
  type ResourceProcessSnapshot,
  type ResourceProcessStatus,
  type ResourceSnapshot,
} from "../../lib/bridge";
import { formatBytes } from "../../lib/clipboardUi";
import { formatDuration } from "../../lib/format";
import { resourceStamp, sampleWindowSeconds } from "../../lib/resourceTime";
import { formatPercent, relativePercent } from "../../lib/resourceMetrics";
import { useLocale } from "../../hooks/useLocale";
import type { MessageKey } from "../../i18n";
import { MiniMeter } from "./charts";

export interface ProcessDiagnosticsProps {
  /** 概览快照自带自身进程指标：进程列表未加载前也能展示真实数据。 */
  snapshot: ResourceSnapshot | null;
  snapshotLoading: boolean;
  data: ResourceProcessDiagnostics | null;
  loading: boolean;
  error: string | null;
  /** 首次加载（面板负责忙碌去重）。 */
  onLoad: () => void;
  onRefresh: () => void;
  /** 页面级刷新信号：只在本分区可见时递增。 */
  refreshSignal?: number;
}

type SortKey = "cpu" | "memory";

const ASSOCIATION_LABELS: Record<ResourceProcessAssociation, MessageKey> = {
  self: "settings.resourceCleanup.association.self",
  managed_child: "settings.resourceCleanup.association.managedChild",
  project_dev: "settings.resourceCleanup.association.projectDev",
  external_tool: "settings.resourceCleanup.association.externalTool",
  unknown_owner: "settings.resourceCleanup.association.unknownOwner",
};

const BASIS_LABELS: Record<ResourceProcessBasis, MessageKey> = {
  self: "settings.resourceCleanup.basis.self",
  parent_chain: "settings.resourceCleanup.basis.parentChain",
  image_path: "settings.resourceCleanup.basis.imagePath",
  name_and_path: "settings.resourceCleanup.basis.nameAndPath",
  unverified: "settings.resourceCleanup.basis.unverified",
};

const STATUS_LABELS: Record<ResourceProcessStatus, MessageKey> = {
  normal: "settings.resourceCleanup.processStatus.normal",
  high_usage: "settings.resourceCleanup.processStatus.highUsage",
  exited: "settings.resourceCleanup.processStatus.exited",
  unknown: "settings.resourceCleanup.processStatus.unknown",
};

function uptimeLabel(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return null;
  return formatDuration(seconds * 1000);
}

/** 进程行：默认两级；占用条与归属依据只在展开后出现。 */
function ProcessLine({
  row,
  maxMemory,
  expanded,
  onToggle,
}: {
  row: ResourceProcessRow;
  maxMemory: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useLocale();
  const uptime = uptimeLabel(row.uptimeSecs);
  const memoryRelative = relativePercent(row.workingSetBytes, maxMemory);
  const cpuText =
    row.cpuPercent === null
      ? t("settings.resourceCleanup.processUnknownValue")
      : `${row.cpuPercent.toFixed(1)}%`;
  const memoryText =
    row.workingSetBytes === null
      ? t("settings.resourceCleanup.processUnknownValue")
      : formatBytes(row.workingSetBytes);
  const identity = [
    t("settings.resourceCleanup.processPid", { pid: row.pid }),
    uptime ? t("settings.resourceCleanup.processUptime", { duration: uptime }) : null,
    t(STATUS_LABELS[row.status]),
  ]
    .filter((part): part is string => Boolean(part))
    .join(" · ");

  return (
    <li className={`resource-process-row${expanded ? " is-open" : ""}`}>
      <button
        type="button"
        className="resource-process-toggle"
        aria-expanded={expanded}
        aria-label={t(
          expanded ? "resource.process.collapseAria" : "resource.process.expandAria",
          { name: row.name },
        )}
        onClick={onToggle}
      >
        <span className="resource-process-line1">
          <strong className="resource-process-name" data-tip={row.name}>
            {row.name}
          </strong>
          <span className="resource-process-values">
            <span>
              <em>{t("settings.resourceCleanup.processCpuLabel")}</em>
              {cpuText}
            </span>
            <span>
              <em>{t("settings.resourceCleanup.processMemoryLabel")}</em>
              {memoryText}
            </span>
          </span>
        </span>
        <span className="resource-process-line2">
          <span className="resource-process-chip">{t(ASSOCIATION_LABELS[row.association])}</span>
          <span className="resource-process-identity" data-tip={identity}>
            {identity}
          </span>
          <ChevronDown
            size={12}
            className={`resource-process-chevron${expanded ? " is-open" : ""}`}
            aria-hidden="true"
          />
        </span>
      </button>
      {expanded && (
        <div className="resource-process-detail">
          <div className="resource-process-bar">
            <span className="resource-process-bar-label">
              {t("settings.resourceCleanup.processCpuLabel")}
            </span>
            <MiniMeter
              percent={row.cpuPercent}
              tone="neutral"
              ariaLabel={t("resource.aria.processCpu", {
                name: row.name,
                percent: cpuText,
              })}
            />
            <span className="resource-process-bar-note">{cpuText}</span>
          </div>
          <div className="resource-process-bar">
            <span className="resource-process-bar-label">
              {t("settings.resourceCleanup.processMemoryLabel")}
            </span>
            <MiniMeter
              percent={memoryRelative}
              tone="neutral"
              ariaLabel={t("resource.aria.processMemory", {
                name: row.name,
                percent:
                  formatPercent(memoryRelative) ||
                  t("settings.resourceCleanup.processUnknownValue"),
              })}
            />
            <span className="resource-process-bar-note">
              {memoryRelative === null
                ? ""
                : t("resource.process.memoryRelative", {
                    percent: formatPercent(memoryRelative) ?? "",
                  })}
            </span>
          </div>
          <dl className="resource-process-detail-meta">
            <div>
              <dt>{t("resource.process.detailBasis")}</dt>
              <dd>{t(BASIS_LABELS[row.associationBasis])}</dd>
            </div>
            <div>
              <dt>{t("settings.resourceCleanup.processMemoryLabel")}</dt>
              <dd>{memoryText}</dd>
            </div>
          </dl>
          <p className="resource-process-detail-note">{t("resource.process.detailNote")}</p>
        </div>
      )}
    </li>
  );
}

/** 排序是纯展示逻辑：不改变归属判定与状态，只调整列表顺序。 */
function sortRows(rows: ResourceProcessRow[], key: SortKey): ResourceProcessRow[] {
  return [...rows].sort((left, right) => {
    const leftValue = key === "cpu" ? left.cpuPercent : left.workingSetBytes;
    const rightValue = key === "cpu" ? right.cpuPercent : right.workingSetBytes;
    const delta = (rightValue ?? -1) - (leftValue ?? -1);
    if (delta !== 0) return delta;
    return left.name.localeCompare(right.name);
  });
}

export default function ProcessDiagnostics({
  snapshot,
  snapshotLoading,
  data,
  loading,
  error,
  onLoad,
  onRefresh,
  refreshSignal = 0,
}: ProcessDiagnosticsProps) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const [sort, setSort] = useState<SortKey>("cpu");
  /** 展开态按进程身份记忆：排序变化不丢失，重采样后同一进程仍保持展开。 */
  const [expandedRows, setExpandedRows] = useState<ReadonlySet<string>>(() => new Set());
  const prevSignalRef = useRef(refreshSignal);

  /** 页头刷新只在列表已展开时生效：未展开不应触发新的进程枚举。 */
  useEffect(() => {
    if (prevSignalRef.current === refreshSignal) return;
    prevSignalRef.current = refreshSignal;
    if (open) onRefresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshSignal]);

  function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (!data) onLoad();
  }

  function toggleRow(key: string) {
    setExpandedRows((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const selfRow: ResourceProcessRow | null =
    data?.processes.find((row) => row.association === "self") ?? null;
  const self: ResourceProcessSnapshot | null = selfRow ?? snapshot?.process ?? null;
  const others = sortRows(
    data?.processes.filter((row) => row.association !== "self") ?? [],
    sort,
  );
  /** 内存条的分母：当前列表中最大的有效工作集（不是系统内存）。 */
  const maxMemory = others.reduce(
    (max, row) => Math.max(max, row.workingSetBytes ?? 0),
    0,
  );
  const sampled = resourceStamp(selfRow ? data?.sampledAt : snapshot?.sampledAt);
  const selfUptime = self ? uptimeLabel(self.uptimeSecs) : null;
  const cpuWindow = sampleWindowSeconds(data?.cpuWindowMs);

  return (
    <section className="resource-diagnostics" aria-labelledby="resource-diagnostics-title">
      <div className="resource-diagnostics-head">
        <div className="resource-diagnostics-title-row">
          <h3 className="resource-cleanup-heading" id="resource-diagnostics-title">
            {t("settings.resourceCleanup.processTitle")}
          </h3>
          <span className="resource-diagnostics-note" data-tip={t("settings.resourceCleanup.processDesc")}>
            {t("settings.resourceCleanup.processDesc")}
          </span>
        </div>
        <div className="resource-diagnostics-actions">
          {open && (
            <button
              type="button"
              className="btn sm resource-icon-text-btn"
              onClick={onRefresh}
              disabled={loading}
              aria-label={t("settings.resourceCleanup.processRefresh")}
              data-tip={t("settings.resourceCleanup.processRefresh")}
            >
              <RefreshCw size={12} className={loading ? "spin" : undefined} aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            className="btn sm"
            onClick={toggle}
            aria-expanded={open}
          >
            <ListTree size={12} aria-hidden="true" />{" "}
            {t(
              open
                ? "settings.resourceCleanup.processHide"
                : "settings.resourceCleanup.processLoad",
            )}
          </button>
        </div>
      </div>

      {self ? (
        <div className="resource-process-self">
          <div className="resource-process-self-head">
            <strong className="resource-process-name" data-tip={self.name}>
              {self.name}
            </strong>
            <span className="resource-process-chip">
              {t("settings.resourceCleanup.association.self")}
            </span>
            <span className={`resource-process-status status-${self.status}`}>
              {t(STATUS_LABELS[self.status])}
            </span>
            <span className="resource-process-sampled" data-tip={sampled?.full}>
              {sampled
                ? t("resource.time.updated", { time: sampled.time })
                : t("settings.resourceCleanup.sampledAtUnknown")}
            </span>
          </div>
          <dl className="resource-process-self-grid">
            <div>
              <dt>{t("settings.resourceCleanup.processPidLabel")}</dt>
              <dd>{self.pid}</dd>
            </div>
            <div>
              <dt>{t("settings.resourceCleanup.processCpuLabel")}</dt>
              <dd>
                {self.cpuPercent === null
                  ? t("settings.resourceCleanup.processUnknownValue")
                  : `${self.cpuPercent.toFixed(1)}%`}
              </dd>
            </div>
            <div>
              <dt>{t("settings.resourceCleanup.processMemoryLabel")}</dt>
              <dd>
                {self.workingSetBytes === null
                  ? t("settings.resourceCleanup.processUnknownValue")
                  : formatBytes(self.workingSetBytes)}
              </dd>
            </div>
            <div>
              <dt>{t("settings.resourceCleanup.processUptimeLabel")}</dt>
              <dd>{selfUptime ?? t("settings.resourceCleanup.processUnknownValue")}</dd>
            </div>
          </dl>
        </div>
      ) : (
        <p className="setting-note" role="status">
          {t(
            snapshotLoading
              ? "settings.resourceCleanup.processLoading"
              : "settings.resourceCleanup.processSelfUnavailable",
          )}
        </p>
      )}

      {open && (
        <div className="resource-process-list-block">
          <div className="resource-process-list-head">
            <span className="resource-process-list-count">
              {t("resource.process.listCount", { count: others.length })}
            </span>
            <div
              className="resource-process-sort"
              role="group"
              aria-label={t("resource.process.sortGroup")}
            >
              <button
                type="button"
                className={`resource-sort-btn${sort === "cpu" ? " is-active" : ""}`}
                aria-pressed={sort === "cpu"}
                onClick={() => setSort("cpu")}
              >
                {t("resource.process.sortCpuShort")}
              </button>
              <button
                type="button"
                className={`resource-sort-btn${sort === "memory" ? " is-active" : ""}`}
                aria-pressed={sort === "memory"}
                onClick={() => setSort("memory")}
              >
                {t("resource.process.sortMemoryShort")}
              </button>
            </div>
          </div>
          {loading && (
            <p className="setting-note" role="status">
              {t("settings.resourceCleanup.processLoading")}
            </p>
          )}
          {error && (
            <div className="setting-note resource-cleanup-error" role="alert">
              {t("settings.resourceCleanup.processFailed", { error })}
              <button type="button" className="btn sm" onClick={onRefresh} disabled={loading}>
                {t("common.retry")}
              </button>
            </div>
          )}
          {data && !data.supported && (
            <p className="setting-note" role="status">
              {t("settings.resourceCleanup.processUnsupported")}
            </p>
          )}
          {data?.supported && others.length === 0 && !loading && (
            <p className="setting-note" role="status">
              {t("settings.resourceCleanup.processEmpty")}
            </p>
          )}
          {others.length > 0 && (
            <>
              <ul
                className="resource-process-list"
                aria-label={t("resource.process.listAria", { count: others.length })}
              >
                {others.map((row) => {
                  const key = `${row.pid}-${row.name}`;
                  return (
                    <ProcessLine
                      key={key}
                      row={row}
                      maxMemory={maxMemory}
                      expanded={expandedRows.has(key)}
                      onToggle={() => toggleRow(key)}
                    />
                  );
                })}
              </ul>
              <p className="setting-note resource-process-list-note">
                {t("resource.process.listNote")}
              </p>
            </>
          )}
          {data?.truncated && (
            <p className="setting-note">
              {t("settings.resourceCleanup.processTruncated", { count: data.processes.length })}
            </p>
          )}
          {data && data.omittedExternal > 0 && (
            <p className="setting-note">
              {t("settings.resourceCleanup.processOmittedExternal", {
                count: data.omittedExternal,
              })}
            </p>
          )}
          {data && data.omittedUnknown > 0 && (
            <p className="setting-note">
              {t("settings.resourceCleanup.processOmittedUnknown", {
                count: data.omittedUnknown,
              })}
            </p>
          )}
          <p className="setting-note">
            {t("settings.resourceCleanup.processSafetyNote")}
            {cpuWindow !== null
              ? ` ${t("settings.resourceCleanup.processCpuNote", { window: cpuWindow })}`
              : ""}
          </p>
        </div>
      )}
    </section>
  );
}
