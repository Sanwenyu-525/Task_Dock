//! 资源短时趋势：有界、可取消的前台采样。
//!
//! 设计约束：
//! - 只用既有 `resource_snapshot` IPC，不新增后端线程、不常驻后台：
//!   资源概览不可见（切到别的分区、停靠为胶囊/极简）或窗口隐藏时**不采样**；
//! - 环形缓冲最多 `capacity` 点（默认 30 点 × 10 秒 = 近 5 分钟），不无限增长；
//! - 挂载时不额外请求一次：面板自己的快照作为起点（`seed`），
//!   首个自动采样在一个周期后发生，避免 StrictMode/首次进入产生重复 IPC；
//! - 失败不伪造数据点：保留上次结果并标记 `failed`，下个周期自动重试；
//! - 同一时刻只有一个在途采样；卸载或失活后迟到的响应不再写状态。
//!
//! 趋势点只保存百分比与采样时刻，不复制整份快照历史；`latest` 单独保留
//! 最近一次成功快照，供概览环形与趋势末端使用同一份读数。

import { useCallback, useEffect, useRef, useState } from "react";
import { resourceSnapshot, type ResourceSnapshot } from "../lib/bridge";
import { computeUsage } from "../lib/resourceMetrics";

/** 自动采样间隔（毫秒）。 */
export const TREND_INTERVAL_MS = 10_000;
/** 环形缓冲容量（点）。30 × 10 秒 = 近 5 分钟。 */
export const TREND_CAPACITY = 30;

export interface ResourceTrendPoint {
  /** 采样时刻（毫秒）；用于横轴间距与排序。 */
  at: number;
  /** 后端采样时间戳（原样保留，用于同一次读取去重）。 */
  sampledAt: string;
  /** 数据目录所在卷的使用率；不可读为 null。 */
  diskPercent: number | null;
  /** 系统物理内存使用率；不可读为 null。 */
  memoryPercent: number | null;
}

export interface ResourceTrend {
  points: ResourceTrendPoint[];
  /** 最近一次成功快照（seed 或自动采样），与趋势末端同源。 */
  latest: ResourceSnapshot | null;
  /** 最近一次自动采样失败；成功一次即清除。 */
  failed: boolean;
}

export interface UseResourceTrendOptions {
  /** 仅在资源概览可见且窗口未隐藏时为 true。 */
  active: boolean;
  /** 面板已有快照：作为趋势起点，避免挂载时重复请求。 */
  seed: ResourceSnapshot | null | undefined;
  /** 采样函数（测试可注入），默认调用 bridge。 */
  sample?: () => Promise<ResourceSnapshot>;
  intervalMs?: number;
  capacity?: number;
}

/** 快照 → 趋势点：磁盘取数据目录所在卷（后端排序首项）。 */
export function toTrendPoint(snapshot: ResourceSnapshot): ResourceTrendPoint {
  const disk = snapshot.disks?.[0] ?? null;
  const diskUsage = computeUsage(disk?.totalBytes ?? null, disk?.availableBytes ?? null);
  const memoryUsage = computeUsage(
    snapshot.memory?.totalBytes ?? null,
    snapshot.memory?.availableBytes ?? null,
  );
  const parsed = Date.parse(snapshot.sampledAt);
  return {
    at: Number.isFinite(parsed) ? parsed : Date.now(),
    sampledAt: snapshot.sampledAt,
    diskPercent: diskUsage.usedPercent,
    memoryPercent: memoryUsage.usedPercent,
  };
}

function sampledMillis(snapshot: ResourceSnapshot): number {
  const parsed = Date.parse(snapshot.sampledAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function useResourceTrend({
  active,
  seed,
  sample = resourceSnapshot,
  intervalMs = TREND_INTERVAL_MS,
  capacity = TREND_CAPACITY,
}: UseResourceTrendOptions): ResourceTrend {
  const boundedCapacity = Number.isFinite(capacity)
    ? Math.max(2, Math.floor(capacity))
    : TREND_CAPACITY;
  const [state, setState] = useState<{
    points: ResourceTrendPoint[];
    latest: ResourceSnapshot | null;
  }>({ points: [], latest: null });
  const [failed, setFailed] = useState(false);

  // 每次渲染刷新引用：定时器闭包始终拿到最新采样函数与容量。
  const sampleRef = useRef(sample);
  sampleRef.current = sample;
  const capacityRef = useRef(boundedCapacity);
  capacityRef.current = boundedCapacity;

  const inFlightRef = useRef(false);
  const aliveRef = useRef(false);

  const push = useCallback((snapshot: ResourceSnapshot) => {
    setState((prev) => {
      const point = toTrendPoint(snapshot);
      const last = prev.points[prev.points.length - 1];
      const previousMillis = prev.latest ? sampledMillis(prev.latest) : 0;
      // 同一次后端读取（seed 与轮询/手动刷新拿到同一个 sampledAt）只记一个点。
      if (last && last.sampledAt === point.sampledAt) {
        return prev.latest === snapshot ? prev : { ...prev, latest: snapshot };
      }
      // 迟到响应不能把更旧的后端读数写成「最近一次」。
      if (previousMillis > point.at) return prev;
      const points = [...prev.points, point];
      return {
        points: points.slice(-capacityRef.current),
        latest: snapshot,
      };
    });
  }, []);

  // 面板快照（首次读取、手动刷新、清理后重读）同步为趋势起点。
  // 只依赖采样时间而不是对象引用：调用方在渲染函数里内联构造 seed 时，
  // 每次渲染都是新对象，按引用依赖会触发「push → 渲染 → 新 seed → push」死循环。
  const seedRef = useRef(seed);
  seedRef.current = seed;
  const seedSampledAt = seed?.sampledAt ?? null;
  useEffect(() => {
    const current = seedRef.current;
    if (current) push(current);
  }, [seedSampledAt, push]);

  useEffect(() => {
    if (!active) return;
    aliveRef.current = true;
    const timer = window.setInterval(() => {
      if (!aliveRef.current || inFlightRef.current) return;
      // 窗口隐藏时跳过本周期（不补采、不积压；恢复可见后最多等一个周期）。
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      inFlightRef.current = true;
      void sampleRef
        .current()
        .then((snapshot) => {
          if (!aliveRef.current) return;
          push(snapshot);
          setFailed(false);
        })
        .catch(() => {
          if (aliveRef.current) setFailed(true);
        })
        .finally(() => {
          inFlightRef.current = false;
        });
    }, intervalMs);
    return () => {
      aliveRef.current = false;
      window.clearInterval(timer);
    };
  }, [active, intervalMs, push]);

  return { points: state.points, latest: state.latest, failed };
}
