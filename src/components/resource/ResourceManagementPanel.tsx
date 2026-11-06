//! 资源管理：完整面板的常驻一级页面。
//!
//! 结构：概览 / 磁盘 / 内存 / 进程 四个内部分区（不是四个一级导航）。
//! 生命周期约束：
//! - 页面挂载时只取一次资源快照；切换分区不重复请求（分区按首次访问挂载并保持）；
//! - 磁盘清理、磁盘分布、内存目录、进程列表都在各自首次进入时按需请求；
//! - 没有定时器/轮询；卸载后忽略在途响应；
//! - 同一时刻的手动刷新由 ref 去重。

import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { HardDrive, RefreshCw } from "lucide-react";
import {
  resourceProcessDiagnostics,
  resourceSnapshot,
  type ResourceProcessDiagnostics,
  type ResourceSnapshot,
} from "../../lib/bridge";
import { localizedErrorMessage } from "../../i18n/errors";
import { useLocale } from "../../hooks/useLocale";
import type { MessageKey } from "../../i18n";
import ResourceCleanupSection from "../settings/ResourceCleanupSection";
import ProcessDiagnostics from "./ProcessDiagnostics";
import DiskStoragePanel from "./DiskStoragePanel";
import MemorySegment from "./MemorySegment";
import OverviewSegment from "./OverviewSegment";

const SEGMENTS = ["overview", "disk", "memory", "process"] as const;
type Segment = (typeof SEGMENTS)[number];

const SEGMENT_LABELS: Record<Segment, MessageKey> = {
  overview: "resource.segment.overview",
  disk: "resource.segment.disk",
  memory: "resource.segment.memory",
  process: "resource.segment.process",
};

export default function ResourceManagementPanel() {
  const { t } = useLocale();
  const [segment, setSegment] = useState<Segment>("overview");
  /** 首次访问后保持挂载：再次切回不重新请求，也不丢扫描结果。 */
  const [visited, setVisited] = useState<ReadonlySet<Segment>>(() => new Set(["overview"]));

  const [snapshot, setSnapshot] = useState<ResourceSnapshot | null>(null);
  const [snapshotLoading, setSnapshotLoading] = useState(true);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  /** 磁盘页扫描出的可清理字节；概览共用，避免为用户看不见的操作再扫一次。 */
  const [cleanableBytes, setCleanableBytes] = useState<number | null>(null);
  /** 清理完成/手动刷新后递增，通知磁盘分布重新统计。 */
  const [refreshToken, setRefreshToken] = useState(0);

  const [processes, setProcesses] = useState<ResourceProcessDiagnostics | null>(null);
  const [processesLoading, setProcessesLoading] = useState(false);
  const [processesError, setProcessesError] = useState<string | null>(null);

  const mountedRef = useRef(false);
  const snapshotRequestRef = useRef(0);
  const snapshotBusyRef = useRef(false);
  const processRequestRef = useRef(0);
  const processBusyRef = useRef(false);

  const loadSnapshot = useCallback(async () => {
    if (snapshotBusyRef.current) return;
    snapshotBusyRef.current = true;
    const request = ++snapshotRequestRef.current;
    setSnapshotLoading(true);
    setSnapshotError(null);
    try {
      const result = await resourceSnapshot();
      if (!mountedRef.current || request !== snapshotRequestRef.current) return;
      setSnapshot(result);
    } catch (reason: unknown) {
      if (!mountedRef.current || request !== snapshotRequestRef.current) return;
      // 刷新失败清空旧值：不把过期指标当作当前状态。
      setSnapshot(null);
      setSnapshotError(localizedErrorMessage(reason));
    } finally {
      snapshotBusyRef.current = false;
      if (mountedRef.current && request === snapshotRequestRef.current) {
        setSnapshotLoading(false);
      }
    }
  }, []);

  const loadProcesses = useCallback(async () => {
    if (processBusyRef.current) return;
    processBusyRef.current = true;
    const request = ++processRequestRef.current;
    setProcessesLoading(true);
    setProcessesError(null);
    try {
      const result = await resourceProcessDiagnostics();
      if (!mountedRef.current || request !== processRequestRef.current) return;
      setProcesses(result);
    } catch (reason: unknown) {
      if (!mountedRef.current || request !== processRequestRef.current) return;
      setProcessesError(localizedErrorMessage(reason));
    } finally {
      processBusyRef.current = false;
      if (mountedRef.current && request === processRequestRef.current) {
        setProcessesLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void loadSnapshot();
    return () => {
      mountedRef.current = false;
      snapshotRequestRef.current += 1;
      processRequestRef.current += 1;
    };
  }, [loadSnapshot]);

  const refreshAll = useCallback(() => {
    void loadSnapshot();
    setRefreshToken((token) => token + 1);
  }, [loadSnapshot]);

  function selectSegment(next: Segment) {
    setSegment(next);
    setVisited((current) => {
      if (current.has(next)) return current;
      const result = new Set(current);
      result.add(next);
      return result;
    });
  }

  function onTabKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    const index = SEGMENTS.indexOf(segment);
    let next = index;
    if (event.key === "ArrowRight") next = (index + 1) % SEGMENTS.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + SEGMENTS.length) % SEGMENTS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = SEGMENTS.length - 1;
    else return;
    event.preventDefault();
    selectSegment(SEGMENTS[next]);
    const target = event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(
      `[data-resource-segment="${SEGMENTS[next]}"]`,
    );
    target?.focus();
  }

  return (
    <div className="resource-page">
      <header className="resource-page-head">
        <div className="resource-page-title">
          <h2>{t("resource.title")}</h2>
          <p>{t("resource.subtitle")}</p>
        </div>
        <button
          type="button"
          className="btn sm"
          onClick={refreshAll}
          disabled={snapshotLoading}
          aria-label={t("resource.refresh")}
        >
          <RefreshCw
            size={12}
            className={snapshotLoading ? "spin" : undefined}
            aria-hidden="true"
          />{" "}
          {t(snapshotLoading ? "settings.resourceCleanup.refreshing" : "resource.refresh")}
        </button>
      </header>

      <div
        className="resource-segments"
        role="tablist"
        aria-label={t("resource.segments.aria")}
      >
        {SEGMENTS.map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`resource-tab-${id}`}
            data-resource-segment={id}
            aria-selected={segment === id}
            aria-controls={`resource-panel-${id}`}
            tabIndex={segment === id ? 0 : -1}
            className={`resource-segment${segment === id ? " active" : ""}`}
            onClick={() => selectSegment(id)}
            onKeyDown={onTabKeyDown}
          >
            {t(SEGMENT_LABELS[id])}
          </button>
        ))}
      </div>

      <div className="resource-page-body">
        {/* 各分区首次访问后保持挂载：切换只切显示，不重复 IPC、不丢扫描结果。 */}
        <div
          role="tabpanel"
          id="resource-panel-overview"
          aria-labelledby="resource-tab-overview"
          hidden={segment !== "overview"}
        >
          {visited.has("overview") && (
            <OverviewSegment
              snapshot={snapshot}
              loading={snapshotLoading}
              error={snapshotError}
              cleanableBytes={cleanableBytes}
              onOpenDisk={() => selectSegment("disk")}
              onRefresh={() => void loadSnapshot()}
            />
          )}
        </div>

        <div
          role="tabpanel"
          id="resource-panel-disk"
          aria-labelledby="resource-tab-disk"
          hidden={segment !== "disk"}
        >
          {visited.has("disk") && (
            <div className="resource-disk">
              <ResourceCleanupSection
                onPreviewChange={setCleanableBytes}
                onSnapshotInvalidated={refreshAll}
              />
              <DiskStoragePanel refreshToken={refreshToken} />
            </div>
          )}
        </div>

        <div
          role="tabpanel"
          id="resource-panel-memory"
          aria-labelledby="resource-tab-memory"
          hidden={segment !== "memory"}
        >
          {visited.has("memory") && (
            <MemorySegment
              snapshot={snapshot}
              snapshotLoading={snapshotLoading}
              processes={processes}
              processesLoading={processesLoading}
              onLoadProcesses={() => void loadProcesses()}
              onRefreshSnapshot={() => void loadSnapshot()}
            />
          )}
        </div>

        <div
          role="tabpanel"
          id="resource-panel-process"
          aria-labelledby="resource-tab-process"
          hidden={segment !== "process"}
        >
          {visited.has("process") && (
            <ProcessDiagnostics
              snapshot={snapshot}
              snapshotLoading={snapshotLoading}
              data={processes}
              loading={processesLoading}
              error={processesError}
              onLoad={() => void loadProcesses()}
              onRefresh={() => void loadProcesses()}
            />
          )}
        </div>
      </div>

      <p className="setting-note resource-page-footnote">
        <HardDrive size={11} aria-hidden="true" /> {t("resource.footer.safety")}
      </p>
    </div>
  );
}
