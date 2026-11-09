//! 资源管理：完整面板的一级页面（默认可见，可隐藏/排序）。
//!
//! 结构：概览 / 磁盘 / 内存 / 进程 四个内部分区（不是四个一级导航）。
//! 生命周期约束：
//! - 页面挂载时只取一次资源快照；切换分区不重复请求（分区按首次访问挂载并保持）；
//! - 磁盘清理、磁盘分布、内存目录、进程列表都在各自首次进入时按需请求；
//! - 没有定时器/轮询；卸载后忽略在途响应；
//! - 手动刷新与失败重试走「最新请求优先」，不再用忙碌标志拦下必要的重新加载
//!   （StrictMode 双挂载会永久停在 loading，见 `lib/asyncResource` 模块文档）。

import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { HardDrive, RefreshCw } from "lucide-react";
import {
  resourceProcessDiagnostics,
  resourceSnapshot,
  type ResourceSnapshot,
} from "../../lib/bridge";
import { useAsyncResource } from "../../lib/asyncResource";
import { formatBytes } from "../../lib/clipboardUi";
import { computeUsage, formatPercent } from "../../lib/resourceMetrics";
import { useLifecycleStore } from "../../store/useLifecycleStore";
import { useFullViewVisible } from "../../hooks/useMainUiVisible";
import { useLocale } from "../../hooks/useLocale";
import type { MessageKey } from "../../i18n";
import ResourceCleanupSection, { type CleanupEstimate } from "../settings/ResourceCleanupSection";
import ProcessDiagnostics from "./ProcessDiagnostics";
import DiskSpaceAnalyzer from "./DiskSpaceAnalyzer";
import DiskStoragePanel from "./DiskStoragePanel";
import MemorySegment from "./MemorySegment";
import OverviewSegment from "./OverviewSegment";
import RuntimeModulesSection from "./RuntimeModulesSection";
import UserJunkSection from "./UserJunkSection";
import { USAGE_ANOMALY_DETAIL, UsageBar, usageStatusKey } from "./charts";
import { VOLUME_KIND_KEYS } from "./volumeLabels";

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
  /** 磁盘页的扫描估算（含有效期状态）；概览共用，避免为用户看不见的操作再扫一次。 */
  const [cleanable, setCleanable] = useState<CleanupEstimate>({
    totalBytes: null,
    state: "unscanned",
  });
  /** 磁盘分布重新统计的令牌：清理完成或「磁盘分区可见时的页头刷新」才递增。 */
  const [storageToken, setStorageToken] = useState(0);
  /** 内存/进程分区的页头刷新信号：只在对应分区可见时递增，隐藏分区不被重扫。 */
  const [memorySignal, setMemorySignal] = useState(0);
  const [processSignal, setProcessSignal] = useState(0);
  /** 同一 tick 内的重复点击不会因 React 状态尚未刷新而发出第二次高成本采样。 */
  const refreshLockRef = useRef(false);

  const { reload: reloadSnapshot } = snapshot;
  const lifecycleLoading = useLifecycleStore((state) => state.loading);
  const refreshLifecycle = useLifecycleStore((state) => state.refresh);
  // 「功能运行」分区活跃 = 当前分区可见 + 完整面板未被停靠/极简模式隐藏。
  // 分区首次访问后保持挂载，但隐藏期不允许再发生生命周期 IPC。
  const fullViewVisible = useFullViewVisible();
  const modulesActive = segment === "modules" && fullViewVisible;

  /**
   * 页面级刷新（页头唯一入口）：总是重读系统快照，并只刷新**当前分区**的专属数据。
   * - 功能运行：重查后端生命周期状态（不写第二份模块状态）；
   * - 内存：系统快照 + 进程诊断（WebView2 指标）+ 内存目录；
   * - 磁盘 / 进程：各自的令牌与列表。
   * 隐藏分区的详情不因这次点击被重扫。
   */
  async function refreshCurrent() {
    if (refreshLockRef.current) return;
    refreshLockRef.current = true;
    try {
      const waits: Array<Promise<unknown>> = [reloadSnapshot()];
      if (segment === "modules") waits.push(refreshLifecycle());
      else if (segment === "disk") setStorageToken((token) => token + 1);
      else if (segment === "memory") {
        setMemorySignal((signal) => signal + 1);
        waits.push(reloadProcesses());
      } else if (segment === "process") setProcessSignal((signal) => signal + 1);
      await Promise.allSettled(waits);
    } finally {
      refreshLockRef.current = false;
    }
  }

  /** 页头刷新按钮的忙碌态：只包含当前分区真正在读取的数据源。 */
  const refreshing =
    snapshot.loading ||
    (segment === "modules" && lifecycleLoading) ||
    ((segment === "memory" || segment === "process") && processes.loading);

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
    <div className="resource-page page-fill">
      <header className="resource-page-head">
        <div className="resource-page-title">
          <h2>{t("resource.title")}</h2>
          <p>{t("resource.subtitle")}</p>
        </div>
        <button
          type="button"
          className="btn sm"
          onClick={() => void refreshCurrent()}
          disabled={refreshing}
          aria-label={t("resource.refresh")}
        >
          <RefreshCw
            size={12}
            className={refreshing ? "spin" : undefined}
            aria-hidden="true"
          />{" "}
          {t(refreshing ? "settings.resourceCleanup.refreshing" : "resource.refresh")}
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

      <div className="resource-page-body page-scroll">
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
              cleanable={cleanable}
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
          {visited.has("modules") && <RuntimeModulesSection active={modulesActive} />}
        </div>

        <div
          role="tabpanel"
          id="resource-panel-disk"
          aria-labelledby="resource-tab-disk"
          hidden={segment !== "disk"}
        >
          {visited.has("disk") && (
            <div className="resource-disk">
              <DiskVolumes snapshot={snapshot.data} loading={snapshot.loading} />
              {/* 主要动作在前：用户进入磁盘页通常是为了腾空间；
                  空间分析是诊断工具，放在清理之后。 */}
              <UserJunkSection onSnapshotInvalidated={refreshAfterCleanup} />
              <DiskSpaceAnalyzer
                defaultPath={
                  snapshot.data?.disks[0]?.volume
                    ? `${snapshot.data.disks[0].volume}\\`
                    : null
                }
              />
              <ResourceCleanupSection
                onPreviewChange={setCleanable}
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
              processesError={processes.error}
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
 * 磁盘分区顶部的「所有卷」列表：只读展示每个逻辑卷的使用率。
 * 与「应用数据占用」是不同口径，因此单独成节，不与缓存分布混在一起。
 * 读不到的卷显示「暂不可用」而不是 0%；异常读数显示「读数异常」。
 */
function DiskVolumes({
  snapshot,
  loading,
}: {
  snapshot: ResourceSnapshot | null;
  loading: boolean;
}) {
  const { t } = useLocale();
  const pending = loading && !snapshot;
  const disks = snapshot?.disks ?? [];
  const unavailable = t("settings.resourceCleanup.unavailable");

  return (
    <section className="resource-disk-volumes" aria-labelledby="resource-disk-volumes-title">
      <div className="resource-cleanup-section-head">
        <h3 className="resource-cleanup-heading" id="resource-disk-volumes-title">
          {t("resource.volumes.title")}
        </h3>
        {!pending && disks.length > 0 && (
          <span className="resource-volume-count">
            {t("resource.volumes.count", { count: disks.length })}
          </span>
        )}
      </div>
      {pending && (
        <p className="setting-note" role="status">
          {t("resource.reading")}
        </p>
      )}
      {!pending && disks.length === 0 && (
        <p className="setting-note" role="status">
          {t("resource.volumes.empty")}
        </p>
      )}
      {disks.map((disk) => {
        const usage = computeUsage(disk.totalBytes, disk.availableBytes);
        const kindKey = VOLUME_KIND_KEYS[disk.kind] ?? VOLUME_KIND_KEYS.unknown;
        const status = t(usageStatusKey(usage.level, usage.anomaly));
        return (
          <UsageBar
            key={disk.volume}
            usedPercent={usage.usedPercent}
            level={usage.level}
            size="sm"
            label={
              <>
                {disk.volume}{" "}
                <span className="resource-volume-kind">{t(kindKey)}</span>
              </>
            }
            value={
              usage.usedPercent === null
                ? status
                : `${formatPercent(usage.usedPercent)} · ${status}`
            }
            ariaLabel={t("resource.aria.diskBar", {
              percent: formatPercent(usage.usedPercent) ?? unavailable,
              used: usage.usedBytes === null ? unavailable : formatBytes(usage.usedBytes),
              free:
                usage.availableBytes === null ? unavailable : formatBytes(usage.availableBytes),
              total: usage.totalBytes === null ? unavailable : formatBytes(usage.totalBytes),
              level: status,
            })}
            detail={
              usage.anomaly
                ? t(USAGE_ANOMALY_DETAIL[usage.anomaly])
                : usage.totalBytes !== null && usage.availableBytes !== null
                  ? `${t("resource.overview.ringFree", {
                      free: formatBytes(usage.availableBytes),
                    })} · ${t("resource.overview.ringTotal", {
                      total: formatBytes(usage.totalBytes),
                    })}`
                  : unavailable
            }
          />
        );
      })}
      {!pending && disks.length > 0 && (
        <p className="setting-note">{t("resource.volumes.desc")}</p>
      )}
    </section>
  );
}
