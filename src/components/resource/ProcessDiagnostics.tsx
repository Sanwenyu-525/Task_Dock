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

import { useEffect, useRef, useState } from "react";
import { ListTree, RefreshCw } from "lucide-react";
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
import { formatDuration, formatLocalStamp } from "../../lib/format";
import { formatPercent, relativePercent } from "../../lib/resourceMetrics";
import { useLocale } from "../../hooks/useLocale";
import type { MessageKey } from "../../i18n";
import { Select } from "../ui";
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

function sampledLabel(iso: string | null | undefined): string | null {
  const stamp = formatLocalStamp(iso);
  return stamp ? `${stamp.date} ${stamp.time} ${stamp.zone}` : null;
}

/** 进程行：名称截断、指标等宽；不渲染命令行、路径或任何敏感信息。
 *  CPU 条用接口的整机归一化百分比；内存条只表达「相对当前列表最大值」的长度。 */
function ProcessLine({ row, maxMemory }: { row: ResourceProcessRow; maxMemory: number }) {
  const { t } = useLocale();
  const uptime = uptimeLabel(row.uptimeSecs);
  const memoryRelative = relativePercent(row.workingSetBytes, maxMemory);
  return (
    <li className="resource-process-row">
      <div className="resource-process-main">
        <span className="resource-process-name" data-tip={row.name}>
          {row.name}
        </span>
        <span className="resource-process-meta">
          {t("settings.resourceCleanup.processPid", { pid: row.pid })}
          {uptime ? ` · ${t("settings.resourceCleanup.processUptime", { duration: uptime })}` : ""}
        </span>
      </div>
      <div className="resource-process-metrics">
        <span>
          {t("settings.resourceCleanup.processCpu", {
            value:
              row.cpuPercent === null
                ? t("settings.resourceCleanup.processUnknownValue")
                : `${row.cpuPercent.toFixed(1)}%`,
          })}
        </span>
        <span>
          {t("settings.resourceCleanup.processMemory", {
            value:
              row.workingSetBytes === null
                ? t("settings.resourceCleanup.processUnknownValue")
                : formatBytes(row.workingSetBytes),
          })}
        </span>
      </div>
      <div className="resource-process-tags">
        <span
          className="resource-process-chip"
          data-tip={t(BASIS_LABELS[row.associationBasis])}
        >
          {t(ASSOCIATION_LABELS[row.association])}
        </span>
        <span className={`resource-process-status status-${row.status}`}>
          {t(STATUS_LABELS[row.status])}
        </span>
      </div>
      <div className="resource-process-bars">
        <div className="resource-process-bar">
          <span className="resource-process-bar-label">
            {t("settings.resourceCleanup.processCpuLabel")}
          </span>
          <MiniMeter
            percent={row.cpuPercent}
            tone="neutral"
            ariaLabel={t("resource.aria.processCpu", {
              name: row.name,
              percent:
                row.cpuPercent === null
                  ? t("settings.resourceCleanup.processUnknownValue")
                  : `${row.cpuPercent.toFixed(1)}%`,
            })}
          />
          <span className="resource-process-bar-note">
            {row.cpuPercent === null
              ? t("settings.resourceCleanup.processUnknownValue")
              : `${row.cpuPercent.toFixed(1)}%`}
          </span>
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
                formatPercent(memoryRelative) || t("settings.resourceCleanup.processUnknownValue"),
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
      </div>
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
  const sampled = sampledLabel(selfRow ? data?.sampledAt : snapshot?.sampledAt);
  const selfUptime = self ? uptimeLabel(self.uptimeSecs) : null;

  return (
    <section className="resource-diagnostics" aria-labelledby="resource-diagnostics-title">
      <div className="resource-cleanup-section-head">
        <h3 className="resource-cleanup-heading" id="resource-diagnostics-title">
          {t("settings.resourceCleanup.processTitle")}
        </h3>
        <div className="resource-diagnostics-actions">
          {open && (
            <button
              type="button"
              className="btn sm"
              onClick={onRefresh}
              disabled={loading}
            >
              <RefreshCw size={12} className={loading ? "spin" : undefined} aria-hidden="true" />{" "}
              {t("settings.resourceCleanup.processRefresh")}
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
      <p className="setting-note">{t("settings.resourceCleanup.processDesc")}</p>

      {self ? (
        <div className="resource-process-self">
          <div className="resource-process-self-head">
            <span className="resource-process-name" data-tip={self.name}>
              {self.name}
            </span>
            <span className="resource-process-tags">
              <span className="resource-process-chip">
                {t("settings.resourceCleanup.association.self")}
              </span>
              <span className={`resource-process-status status-${self.status}`}>
                {t(STATUS_LABELS[self.status])}
              </span>
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
          <span className="resource-process-sampled">
            {sampled
              ? t("settings.resourceCleanup.sampledAt", { time: sampled })
              : t("settings.resourceCleanup.sampledAtUnknown")}
          </span>
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
          <div className="resource-process-sort">
            <span className="resource-overview-label">
              {t("resource.process.sortLabel")}
            </span>
            <Select
              ariaLabel={t("resource.process.sortLabel")}
              size="sm"
              value={sort}
              options={[
                { value: "cpu", label: t("resource.process.sortCpu") },
                { value: "memory", label: t("resource.process.sortMemory") },
              ]}
              onChange={(value) => setSort(value as SortKey)}
            />
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
              <div className="resource-process-list-head">
                <span className="resource-overview-label">
                  {t("resource.process.listCount", { count: others.length })}
                </span>
                <span className="resource-process-list-note">
                  {t("resource.process.listNote")}
                </span>
              </div>
              <ul
                className="resource-process-list"
                tabIndex={0}
                aria-label={t("resource.process.listAria", { count: others.length })}
              >
                {others.map((row) => (
                  <ProcessLine
                    key={`${row.pid}-${row.name}`}
                    row={row}
                    maxMemory={maxMemory}
                  />
                ))}
              </ul>
              <p className="setting-note">{t("resource.process.relativeNote")}</p>
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
            {data && data.cpuWindowMs > 0
              ? ` ${t("settings.resourceCleanup.processCpuNote", { window: data.cpuWindowMs })}`
              : ""}
          </p>
        </div>
      )}
    </section>
  );
}
