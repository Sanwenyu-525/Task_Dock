//! 资源管理：完整面板的一级页面（默认可见，可隐藏/排序）。
//!
//! 结构：概览 / 功能运行 / 磁盘 / 内存 / 进程 五个内部分区（不是五个一级导航）。
//! 生命周期约束：
//! - 页面挂载时只取一次资源快照；切换分区不重复请求（分区按首次访问挂载并保持）；
//! - 磁盘清理、磁盘分布、内存目录、进程列表都在各自首次进入时按需请求；
//! - 唯一的周期采样是概览的短时趋势：仅概览可见且窗口未隐藏时每 10 秒一次，
//!   最多 30 点，切换分区/停靠/卸载即停止（`hooks/useResourceTrend`）；
//! - 卸载后忽略在途响应；
//! - 手动刷新与失败重试走「最新请求优先」，不再用忙碌标志拦下必要的重新加载
//!   （StrictMode 双挂载会永久停在 loading，见 `lib/asyncResource` 模块文档）。
//!
//! 数据有效性：概览的环形与指标可能来自页面快照或趋势末端，统一由
//! `lib/resourceFreshness` 选出最新一份并标注 live/updating/historical/failed；
//! 刷新失败时绝不把更早的趋势读数当作当前值。
//!
//! 跨分区定位：`openSegment(segment, anchor)` 切换分区后按锚点滚动并移动焦点，
//! 折叠区块（空间分析/应用数据占用）在定位前展开；不使用固定延时。

import {
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { HardDrive, RefreshCw, ScanSearch, ShieldCheck } from "lucide-react";
import {
  resourceProcessDiagnostics,
  resourceSnapshot,
  type ResourceSnapshot,
} from "../../lib/bridge";
import { useAsyncResource } from "../../lib/asyncResource";
import { formatBytes } from "../../lib/clipboardUi";
import { computeUsage, formatPercent } from "../../lib/resourceMetrics";
import { pickSnapshotView } from "../../lib/resourceFreshness";
import { useLifecycleStore } from "../../store/useLifecycleStore";
import { useFullViewVisible } from "../../hooks/useMainUiVisible";
import { useResourceTrend } from "../../hooks/useResourceTrend";
import { useLocale } from "../../hooks/useLocale";
import type { MessageKey } from "../../i18n";
import ResourceCleanupSection, { type CleanupEstimate } from "../settings/ResourceCleanupSection";
import ProcessDiagnostics from "./ProcessDiagnostics";
import DiskSpaceAnalyzer from "./DiskSpaceAnalyzer";
import DiskStoragePanel from "./DiskStoragePanel";
import MemorySegment from "./MemorySegment";
import OverviewSegment from "./OverviewSegment";
import ResourceSection from "./ResourceSection";
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

/** 页头刷新的作用域说明：让用户知道这次点击会重读什么、不会触发什么。 */
const REFRESH_SCOPE: Record<Segment, MessageKey> = {
  overview: "resource.refreshScope.overview",
  modules: "resource.refreshScope.modules",
  disk: "resource.refreshScope.disk",
  memory: "resource.refreshScope.memory",
  process: "resource.refreshScope.process",
};

interface RevealRequest {
  segment: Segment;
  anchor: string;
  token: number;
}

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
  /** 磁盘分布是否正在统计：页头刷新按钮的忙碌态需要覆盖它。 */
  const [storageLoading, setStorageLoading] = useState(false);
  /** 内存/进程分区的页头刷新信号：只在对应分区可见时递增，隐藏分区不被重扫。 */
  const [memorySignal, setMemorySignal] = useState(0);
  const [processSignal, setProcessSignal] = useState(0);
  /** 同一 tick 内的重复点击不会因 React 状态尚未刷新而发出第二次高成本采样。 */
  const refreshLockRef = useRef(false);
  /** 跨分区定位请求：保留最后一次目标，供子分区展开折叠区块后复用。 */
  const [reveal, setReveal] = useState<RevealRequest | null>(null);
  const revealSeqRef = useRef(0);
  const handledRevealRef = useRef(0);
  const pageRef = useRef<HTMLDivElement>(null);

  const { reload: reloadSnapshot } = snapshot;
  const lifecycleLoading = useLifecycleStore((state) => state.loading);
  const refreshLifecycle = useLifecycleStore((state) => state.refresh);
  // 「功能运行」分区活跃 = 当前分区可见 + 完整面板未被停靠/极简模式隐藏。
  // 分区首次访问后保持挂载，但隐藏期不允许再发生生命周期 IPC。
  const fullViewVisible = useFullViewVisible();
  const modulesActive = segment === "modules" && fullViewVisible;

  /**
   * 概览短时趋势：仅概览分区可见且完整面板未隐藏时采样。
   * 面板快照作为起点（不额外发首次请求），之后每 10 秒一次、最多 30 点；
   * 切到别的分区或停靠即停止。趋势末端与环形共用同一份最新快照。
   */
  const trend = useResourceTrend({
    active: segment === "overview" && fullViewVisible,
    seed: snapshot.data,
  });
  /**
   * 概览展示哪一份快照：按采样时间取最新，并明确它是当前值、更新中还是
   * 刷新失败后的历史读数。趋势可能比页面快照新，所以不能简单写 `??`。
   */
  const snapshotView = pickSnapshotView({
    snapshot: snapshot.data,
    loading: snapshot.loading,
    error: snapshot.error,
    trendLatest: trend.latest,
  });

  /**
   * 页面级刷新（页头唯一入口）：总是重读系统快照，并只刷新**当前分区**的专属数据。
   * - 功能运行：重查后端生命周期状态（不写第二份模块状态）；
   * - 内存：系统快照 + 进程诊断（WebView2 指标）+ 内存目录；
   * - 磁盘 / 进程：各自的令牌与列表。
   * 隐藏分区的详情不因这次点击被重扫；也不会触发清理候选扫描。
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
    (segment === "disk" && storageLoading) ||
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

  /**
   * 跨分区定位：进入目标分区、滚动到锚点、把焦点移到该区块的标题/展开按钮。
   * 折叠区块的展开由目标分区自己根据 `reveal.token` 完成；这里不等待固定延时，
   * 目标节点在本次提交中已存在（折叠只卸载内容，不卸载区块容器）。
   */
  function openSegment(next: Segment, anchor: string) {
    selectSegment(next);
    revealSeqRef.current += 1;
    setReveal({ segment: next, anchor, token: revealSeqRef.current });
  }

  useLayoutEffect(() => {
    if (!reveal || reveal.segment !== segment) return;
    if (handledRevealRef.current === reveal.token) return;
    const target = pageRef.current?.querySelector<HTMLElement>(
      `[data-resource-anchor="${reveal.anchor}"]`,
    );
    if (!target) return;
    handledRevealRef.current = reveal.token;
    target.scrollIntoView?.({ block: "start" });
    const focusTarget =
      target.querySelector<HTMLElement>("[data-resource-anchor-focus]") ??
      (target.tabIndex >= 0 ? target : null);
    focusTarget?.focus({ preventScroll: true });
  }, [reveal, segment, visited]);

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

  const scopeText = t(REFRESH_SCOPE[segment]);

  return (
    <div className="resource-page page-fill" ref={pageRef}>
      <header className="resource-page-head">
        <div className="resource-page-title">
          <h2>{t("resource.title")}</h2>
        </div>
        <span
          className="resource-safety-chip"
          role="note"
          tabIndex={0}
          aria-label={t("resource.footer.safety")}
          data-tip={t("resource.footer.safety")}
        >
          <ShieldCheck size={13} aria-hidden="true" />
          <span className="resource-safety-chip-text">{t("resource.footer.short")}</span>
        </span>
        <span id="resource-refresh-scope" className="sr-only">
          {scopeText}
        </span>
        <button
          type="button"
          className="btn sm"
          onClick={() => void refreshCurrent()}
          disabled={refreshing}
          aria-label={t("resource.refresh")}
          aria-describedby="resource-refresh-scope"
          data-tip={`${t("resource.refresh")} · ${scopeText}`}
          data-refresh-scope={segment}
        >
          <RefreshCw
            size={13}
            className={refreshing ? "spin" : undefined}
            aria-hidden="true"
          />{" "}
          {t(refreshing ? "settings.resourceCleanup.refreshing" : "resource.refresh")}
        </button>
      </header>

      <div className="resource-segments" role="tablist" aria-label={t("resource.segments.aria")}>
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

      {/* 刷新作用域通过刷新按钮的 tooltip + aria-describedby 按需展示，
          不再常驻一行说明，把高度留给主要内容。 */}

      {/* 系统快照失败：概览有自己的错误块；其他分区也要明确「读取失败」，
          不能把空数据渲染成「没有卷 / 暂不可用」。 */}
      {snapshot.error && segment !== "overview" && (
        <div className="setting-note resource-cleanup-error resource-snapshot-error" role="alert">
          <span>{t("settings.resourceCleanup.snapshotFailed", { error: snapshot.error })}</span>
          <button
            type="button"
            className="btn sm"
            onClick={() => void reloadSnapshot()}
            disabled={snapshot.loading}
          >
            {t("common.retry")}
          </button>
        </div>
      )}

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
              snapshot={snapshotView.snapshot}
              loading={snapshot.loading}
              error={snapshot.error}
              freshness={snapshotView.freshness}
              sampledAt={snapshotView.sampledAt}
              cleanable={cleanable}
              trend={{ points: trend.points, failed: trend.failed }}
              onOpenDisk={(anchor) => openSegment("disk", anchor)}
              onOpenMemory={() => openSegment("memory", "reclaim")}
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
            <DiskSegment
              snapshot={snapshot.data}
              loading={snapshot.loading}
              reveal={reveal}
              storageToken={storageToken}
              storageLoadingChange={setStorageLoading}
              onPreviewChange={setCleanable}
              onSnapshotInvalidated={refreshAfterCleanup}
            />
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
    </div>
  );
}

/**
 * 磁盘分区：容量 → 清理 → 分析 → 占用。
 *
 * 信息架构按「先看容量，再做清理，最后才诊断」排列；空间分析与应用数据占用
 * 是诊断工具，默认折叠，避免整页被大段只读统计占满。定位请求到达时会先展开
 * 对应区块再滚动（展开与滚动都在布局阶段完成，页面不会先跳到折叠位置）。
 */
function DiskSegment({
  snapshot,
  loading,
  reveal,
  storageToken,
  storageLoadingChange,
  onPreviewChange,
  onSnapshotInvalidated,
}: {
  snapshot: ResourceSnapshot | null;
  loading: boolean;
  reveal: RevealRequest | null;
  storageToken: number;
  storageLoadingChange: (loading: boolean) => void;
  onPreviewChange: (estimate: CleanupEstimate) => void;
  onSnapshotInvalidated: () => void;
}) {
  const { t } = useLocale();
  const [analysisOpen, setAnalysisOpen] = useState(false);
  const [storageOpen, setStorageOpen] = useState(false);

  // 定位到折叠区块时先展开：effect 在布局阶段执行，父级的滚动随后发生。
  useLayoutEffect(() => {
    if (!reveal) return;
    if (reveal.anchor === "analysis") setAnalysisOpen(true);
    else if (reveal.anchor === "storage") setStorageOpen(true);
  }, [reveal]);

  return (
    <div className="resource-disk">
      {/* A. 磁盘容量：多卷并列，不做多个大环形。 */}
      <section
        className="resource-anchor resource-disk-volumes"
        data-resource-anchor="volumes"
        aria-labelledby="resource-disk-volumes-title"
      >
        <DiskVolumes snapshot={snapshot} loading={loading} />
      </section>

      {/* B. 清理空间：用户级与应用级保持独立后端与独立确认流程。 */}
      <section
        className="resource-anchor resource-cleaning"
        data-resource-anchor="junk"
        aria-labelledby="resource-junk-title"
      >
        <UserJunkSection onSnapshotInvalidated={onSnapshotInvalidated} />
      </section>

      <section
        className="resource-anchor resource-cleaning"
        data-resource-anchor="app-cache"
        aria-labelledby="resource-cleanup-title"
      >
        <ResourceCleanupSection
          onPreviewChange={onPreviewChange}
          onSnapshotInvalidated={onSnapshotInvalidated}
        />
      </section>

      {/* C. 空间分析：只读诊断，默认折叠。 */}
      <div className="resource-anchor" data-resource-anchor="analysis">
        <ResourceSection
          id="resource-analysis-section"
          title={t("resource.analysis.title")}
          icon={<ScanSearch size={13} />}
          description={t("resource.analysis.desc")}
          badge={t("resource.analysis.badge")}
          expanded={analysisOpen}
          onExpandedChange={setAnalysisOpen}
        >
          <DiskSpaceAnalyzer
            embedded
            defaultPath={
              snapshot?.disks[0]?.volume ? `${snapshot.disks[0].volume}\\` : null
            }
          />
        </ResourceSection>
      </div>

      {/* D. 应用数据占用：只读，区分可重新生成与必须保留。 */}
      <div className="resource-anchor" data-resource-anchor="storage">
        <ResourceSection
          id="resource-storage-section"
          title={t("resource.storage.title")}
          icon={<HardDrive size={13} />}
          description={t("resource.storage.desc")}
          badge={t("resource.storage.badge")}
          expanded={storageOpen}
          onExpandedChange={setStorageOpen}
        >
          <DiskStoragePanel
            embedded
            refreshToken={storageToken}
            onLoadingChange={storageLoadingChange}
          />
        </ResourceSection>
      </div>
    </div>
  );
}

/**
 * 所有逻辑卷：只读展示每个卷的容量与使用率。
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
    <div className="resource-disk-volumes-inner">
      <div className="resource-cleanup-section-head">
        <h3
          className="resource-cleanup-heading resource-anchor-heading"
          id="resource-disk-volumes-title"
          data-resource-anchor-focus
          tabIndex={-1}
          data-tip={t("resource.volumes.desc")}
        >
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
      {!pending && disks.length > 0 && (
        <div className="resource-volume-grid">
          {disks.map((disk) => {
            const usage = computeUsage(disk.totalBytes, disk.availableBytes);
            const kindKey = VOLUME_KIND_KEYS[disk.kind] ?? VOLUME_KIND_KEYS.unknown;
            const status = t(usageStatusKey(usage.level, usage.anomaly));
            return (
              <article className="resource-volume-card" key={disk.volume}>
                <div className="resource-volume-card-head">
                  <strong className="resource-volume-card-name">{disk.volume}</strong>
                  <span className="resource-volume-kind">{t(kindKey)}</span>
                  <span className={`resource-status-pill is-${usage.level}`}>{status}</span>
                </div>
                <UsageBar
                  usedPercent={usage.usedPercent}
                  level={usage.level}
                  size="sm"
                  label={
                    <span className="resource-volume-bar-label">
                      {t("resource.volumes.usage")}
                    </span>
                  }
                  value={
                    usage.usedPercent === null
                      ? status
                      : formatPercent(usage.usedPercent)
                  }
                  ariaLabel={t("resource.aria.diskBar", {
                    percent: formatPercent(usage.usedPercent) ?? unavailable,
                    used:
                      usage.usedBytes === null ? unavailable : formatBytes(usage.usedBytes),
                    free:
                      usage.availableBytes === null
                        ? unavailable
                        : formatBytes(usage.availableBytes),
                    total:
                      usage.totalBytes === null
                        ? unavailable
                        : formatBytes(usage.totalBytes),
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
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
