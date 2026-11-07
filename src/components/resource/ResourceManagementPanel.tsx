//! 资源管理：完整面板的常驻一级页面。
//!
//! 结构：概览 / 磁盘 / 内存 / 进程 四个内部分区（不是四个一级导航）。
//! 生命周期约束：
//! - 页面挂载时只取一次资源快照；切换分区不重复请求（分区按首次访问挂载并保持）；
//! - 磁盘清理、磁盘分布、内存目录、进程列表都在各自首次进入时按需请求；
//! - 没有定时器/轮询；卸载后忽略在途响应；
//! - 手动刷新与失败重试走「最新请求优先」，不再用忙碌标志拦下必要的重新加载
//!   （StrictMode 双挂载会永久停在 loading，见 `lib/asyncResource` 模块文档）。

import { useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { HardDrive, RefreshCw } from "lucide-react";
import {
  resourceProcessDiagnostics,
  resourceSnapshot,
  type ResourceSnapshot,
} from "../../lib/bridge";
import { useAsyncResource } from "../../lib/asyncResource";
import { formatBytes } from "../../lib/clipboardUi";
import { computeUsage, formatPercent } from "../../lib/resourceMetrics";
import { useLocale } from "../../hooks/useLocale";
import type { MessageKey } from "../../i18n";
import ResourceCleanupSection from "../settings/ResourceCleanupSection";
import ProcessDiagnostics from "./ProcessDiagnostics";
import DiskStoragePanel from "./DiskStoragePanel";
import MemorySegment from "./MemorySegment";
import OverviewSegment from "./OverviewSegment";
import RuntimeModulesSection from "./RuntimeModulesSection";
import { PRESSURE_LEVEL_KEYS, UsageBar } from "./charts";

const SEGMENTS = ["overview", "modules", "disk", "memory", "process"] as const;
type Segment = (typeof SEGMENTS)[number];

const SEGMENT_LABELS: Record<Segment, MessageKey> = {
  overview: "resource.segment.overview",
  modules: "resource.segment.modules",
  disk: "resource.segment.disk",
  memory: "resource.segment.memory",
  process: "resource.segment.process",
};

export default function ResourceManagementPanel() {
  const { t } = useLocale();
  const [segment, setSegment] = useState<Segment>("overview");
  /** 首次访问后保持挂载：再次切回不重新请求，也不丢扫描结果。 */
  const [visited, setVisited] = useState<ReadonlySet<Segment>>(() => new Set(["overview"]));

  /** 概览指标与磁盘/内存分区共用的系统快照。 */
  const snapshot = useAsyncResource("resource:snapshot", resourceSnapshot);
  /** 进程列表：默认不请求，进程分区展开或内存分区首次进入时按需加载。 */
  const processes = useAsyncResource("resource:processes", resourceProcessDiagnostics, {
    immediate: false,
  });
  const { reload: reloadProcesses } = processes;
  /** 磁盘页扫描出的可清理字节；概览共用，避免为用户看不见的操作再扫一次。 */
  const [cleanableBytes, setCleanableBytes] = useState<number | null>(null);
  /** 磁盘分布重新统计的令牌：清理完成或「磁盘分区可见时的页头刷新」才递增。 */
  const [storageToken, setStorageToken] = useState(0);
  /** 内存/进程分区的页头刷新信号：只在对应分区可见时递增，隐藏分区不被重扫。 */
  const [memorySignal, setMemorySignal] = useState(0);
  const [processSignal, setProcessSignal] = useState(0);

  const { reload: reloadSnapshot } = snapshot;
  /**
   * 页面级刷新（页头唯一入口）：总是重读系统快照，并只刷新**当前分区**的专属数据。
   * 隐藏分区的详情（磁盘分布 / 内存目录 / 进程列表）不因这次点击被重扫。
   */
  const refreshCurrent = () => {
    reloadSnapshot();
    if (segment === "disk") setStorageToken((token) => token + 1);
    else if (segment === "memory") setMemorySignal((signal) => signal + 1);
    else if (segment === "process") setProcessSignal((signal) => signal + 1);
  };

  /** 清理完成后：缓存与磁盘占用都变了，快照 + 磁盘分布都必须刷新。 */
  const refreshAfterCleanup = () => {
    reloadSnapshot();
    setStorageToken((token) => token + 1);
  };

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
          onClick={refreshCurrent}
          disabled={snapshot.loading}
          aria-label={t("resource.refresh")}
        >
          <RefreshCw
            size={12}
            className={snapshot.loading ? "spin" : undefined}
            aria-hidden="true"
          />{" "}
          {t(snapshot.loading ? "settings.resourceCleanup.refreshing" : "resource.refresh")}
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
              snapshot={snapshot.data}
              loading={snapshot.loading}
              error={snapshot.error}
              cleanableBytes={cleanableBytes}
              onOpenDisk={() => selectSegment("disk")}
              onRefresh={snapshot.reload}
            />
          )}
        </div>

        {/* 功能运行：只读状态快照来自后端生命周期探针；暂停/恢复写既有设置键。 */}
        <div
          role="tabpanel"
          id="resource-panel-modules"
          aria-labelledby="resource-tab-modules"
          hidden={segment !== "modules"}
        >
          {visited.has("modules") && <RuntimeModulesSection />}
        </div>

        <div
          role="tabpanel"
          id="resource-panel-disk"
          aria-labelledby="resource-tab-disk"
          hidden={segment !== "disk"}
        >
          {visited.has("disk") && (
            <div className="resource-disk">
              <DiskVolumeBar snapshot={snapshot.data} loading={snapshot.loading} />
              <ResourceCleanupSection
                onPreviewChange={setCleanableBytes}
                onSnapshotInvalidated={refreshAfterCleanup}
              />
              <DiskStoragePanel refreshToken={storageToken} />
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
              snapshot={snapshot.data}
              snapshotLoading={snapshot.loading}
              processes={processes.data}
              processesLoading={processes.loading}
              onLoadProcesses={reloadProcesses}
              onRefreshSnapshot={snapshot.reload}
              refreshSignal={memorySignal}
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
              snapshot={snapshot.data}
              snapshotLoading={snapshot.loading}
              data={processes.data}
              loading={processes.loading}
              error={processes.error}
              onLoad={reloadProcesses}
              onRefresh={reloadProcesses}
              refreshSignal={processSignal}
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

/**
 * 磁盘分区顶部的整机使用率条：复用与概览相同的公式与三档语义色。
 * 与「应用数据占用」是不同口径，因此单独成条，不与缓存分布混在一起。
 */
function DiskVolumeBar({
  snapshot,
  loading,
}: {
  snapshot: ResourceSnapshot | null;
  loading: boolean;
}) {
  const { t } = useLocale();
  const disk = snapshot?.disks[0] ?? null;
  const usage = computeUsage(disk?.totalBytes ?? null, disk?.availableBytes ?? null);
  const pending = loading && !snapshot;
  const unavailable = t("settings.resourceCleanup.unavailable");
  return (
    <UsageBar
      usedPercent={pending ? null : usage.usedPercent}
      level={pending ? "unknown" : usage.level}
      size="md"
      label={t("resource.overview.diskRingTitle")}
      value={
        pending
          ? t("resource.reading")
          : `${formatPercent(usage.usedPercent) ?? unavailable} · ${t(PRESSURE_LEVEL_KEYS[usage.level])}`
      }
      ariaLabel={t("resource.aria.diskBar", {
        percent: formatPercent(usage.usedPercent) ?? unavailable,
        used: usage.usedBytes === null ? unavailable : formatBytes(usage.usedBytes),
        free: usage.availableBytes === null ? unavailable : formatBytes(usage.availableBytes),
        total: usage.totalBytes === null ? unavailable : formatBytes(usage.totalBytes),
        level: t(PRESSURE_LEVEL_KEYS[usage.level]),
      })}
      detail={
        disk && usage.totalBytes !== null && usage.availableBytes !== null
          ? `${t("resource.overview.ringFree", { free: formatBytes(usage.availableBytes) })} · ${t(
              "resource.overview.ringTotal",
              { total: formatBytes(usage.totalBytes) },
            )}${disk.volume ? ` · ${disk.volume}` : ""}`
          : unavailable
      }
    />
  );
}
