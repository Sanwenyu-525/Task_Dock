//! 文件工作区内的「回收站」数据源视图（v68）。
//!
//! 定位：**不是第三套文件管理器**。它复用文件工作区的外壳（导航、布局、
//! 语义 Token、虚拟列表交互），但数据来自本地 SQLite 索引，操作走
//! `recycle_restore/purge/empty` 专用命令——普通文件工作区永远不能直接操作
//! `$Recycle.Bin`。
//!
//! 性能约束：
//! - 4 万条记录不一次性加载：滚动按 400 条分页 + 窗口化渲染，DOM 只保留可视行；
//! - 搜索/排序/筛选全部在 SQL 完成，前端不做全量过滤；
//! - 打开只读缓存；同步是显式后台动作，进度走事件，不阻塞列表浏览。

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";

import {
  recycleEmpty,
  recycleList,
  recyclePurge,
  recycleRestore,
  recycleStats,
  recycleSync,
  recycleSyncCancel,
  recycleSyncStatus,
  fsJobCancel,
  fsJobStatus,
  isFileJobTerminal,
  onRecycleJobProgress,
  onRecycleSyncDone,
  onRecycleSyncProgress,
  type FileJobSnapshot,
  type RecycleItem,
  type RecyclePage,
  type RecycleQuery,
  type RecycleScanProgress,
  type RecycleStats,
  type RecycleSyncStatus,
  type RecycleSyncSummary,
} from "../../lib/bridge";
import { normalizeError } from "../../lib/errors";
import { startOperation } from "../../lib/diagnostics";
import { formatModified, formatSize } from "../../lib/filesWorkspace/fileMeta";
import { useLocale } from "../../hooks/useLocale";
import { useUiStore } from "../../store/useUiStore";
import { Checkbox } from "../ui/Toggle";
import { Dialog, ConfirmDialog } from "../ui/Dialog";
import PointerMenu from "../ui/PointerMenu";
import SearchField from "../ui/SearchField";
import Select from "../ui/Select";

import "./recycle.css";

const ROW_H = 30;
const PAGE_SIZE = 400;
const MAX_CACHED_PAGES = 6;

/** 孤儿 `$R` 没有可解析的删除时间，用占位符而不是 1970 年伪装成真实数据。 */
function formatDeleted(ms: number): string {
  return ms > 0 ? formatModified(ms) : "—";
}

type SortKey = "deleted" | "size" | "name" | "path" | "volume";
type KindKey = "all" | "file" | "folder";

/** 永久删除的实际语义：完整删除 / 只移出索引（异常项）/ 两者混合。 */
type PurgeScope = "full" | "indexOnly" | "mixed";

const SORT_OPTIONS: Array<{ value: SortKey; zh: string; en: string }> = [
  { value: "deleted", zh: "删除时间", en: "Deleted" },
  { value: "size", zh: "大小", en: "Size" },
  { value: "name", zh: "文件名", en: "Name" },
  { value: "path", zh: "原始路径", en: "Path" },
  { value: "volume", zh: "磁盘", en: "Volume" },
];

/** 固定定位菜单：复用 DropdownMenu 的零尺寸触发器，避免自造浮层。 */
function FreeMenu({
  x,
  y,
  items,
  menuLabel,
  onClose,
}: {
  x: number;
  y: number;
  items: ReadonlyArray<{
    key: string;
    label: string;
    icon?: ReactNode;
    disabled?: boolean;
    danger?: boolean;
    onSelect?: () => void;
  }>;
  menuLabel: string;
  onClose: () => void;
}) {
  // 指针定位、Portal、Escape（进弹层栈，绝不触发窗口级隐藏）、外部点击与焦点陷阱
  // 全部交给 PointerMenu；本组件只保留回收站菜单的项渲染与动作顺序。
  const firstEnabled = items.findIndex((item) => !item.disabled);
  return (
    <PointerMenu
      open
      x={x}
      y={y}
      label={menuLabel}
      onClose={onClose}
      className="rc-ctx-menu"
      minWidth={140}
    >
      {items.map((item, index) => (
        <button
          key={item.key}
          type="button"
          role="menuitem"
          className={`rc-ctx-item${item.danger ? " is-danger" : ""}`}
          disabled={item.disabled}
          {...(index === firstEnabled ? { "data-autofocus": true } : {})}
          onClick={() => {
            onClose();
            item.onSelect?.();
          }}
        >
          {item.icon}
          <span>{item.label}</span>
        </button>
      ))}
    </PointerMenu>
  );
}

export default function RecycleWorkspaceView() {
  const { t, locale } = useLocale();
  const showToast = useUiStore((s) => s.showToast);

  const [stats, setStats] = useState<RecycleStats | null>(null);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState<KindKey>("all");
  const [volume, setVolume] = useState<string>("all");
  const [sort, setSort] = useState<SortKey>("deleted");
  const [dir, setDir] = useState<"asc" | "desc">("desc");
  const [sizeFilter, setSizeFilter] = useState<"all" | "100mb" | "1gb">("all");
  const [ageFilter, setAgeFilter] = useState<"all" | "7d" | "30d" | "1y">("all");

  const [pages, setPages] = useState<Record<number, RecycleItem[]>>({});
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [firstLoaded, setFirstLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [queryMs, setQueryMs] = useState<number | null>(null);

  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(480);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inflightRef = useRef<Map<number, number>>(new Map());
  const generationRef = useRef(0);

  // 选择与页面缓存解耦：ID 集合是语义唯一来源，选中时的元数据快照保证
  // 页面被 6 页窗口淘汰后，批量恢复/永久删除仍能覆盖完整选择范围。
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectedMeta, setSelectedMeta] = useState<Map<string, RecycleItem>>(new Map());
  const [anchorId, setAnchorId] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detailSnapshot, setDetailSnapshot] = useState<RecycleItem | null>(null);

  const [sync, setSync] = useState<RecycleSyncStatus | null>(null);
  const [syncProgress, setSyncProgress] = useState<RecycleScanProgress | null>(null);
  const [syncSummary, setSyncSummary] = useState<RecycleSyncSummary | null>(null);

  const [job, setJob] = useState<FileJobSnapshot | null>(null);
  const jobRef = useRef<FileJobSnapshot | null>(null);
  const jobOpRef = useRef<ReturnType<typeof startOperation> | null>(null);
  const jobPollMissesRef = useRef(0);
  const [jobTrackingLost, setJobTrackingLost] = useState(false);
  const [jobCancelBusy, setJobCancelBusy] = useState(false);

  const [confirm, setConfirm] = useState<
    | { kind: "restore"; ids: string[] }
    | { kind: "purge"; ids: string[]; scope: PurgeScope }
    | { kind: "empty" }
    | null
  >(null);
  const [restoreConflict, setRestoreConflict] = useState<"skip" | "rename">("skip");
  const [emptyVolumes, setEmptyVolumes] = useState<Set<string>>(new Set());
  const [emptyAck, setEmptyAck] = useState(false);

  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; id: string } | null>(null);

  /** 任务终态同时结束诊断操作；pending/running/cancelling 继续等待真实事件。 */
  const settleJobOp = useCallback(
    (snapshot: FileJobSnapshot) => {
      const op = jobOpRef.current;
      if (!op || !isFileJobTerminal(snapshot)) return;
      jobOpRef.current = null;
      const remaining = Math.max(0, snapshot.total - snapshot.done);
      if (snapshot.status === "cancelled") {
        op.cancel(t("fw.recycle.jobCancelled", { ok: snapshot.ok, remaining }));
      } else if (snapshot.status === "failed") {
        op.fail(new Error(snapshot.message ?? t("fw.recycle.jobFailed")));
      } else if (snapshot.status === "partial") {
        op.fail(
          { code: "FS_OP_PARTIAL", message: t("fw.recycle.jobFinishedPartial", { ok: snapshot.ok, failed: snapshot.failed, skipped: snapshot.skipped }) },
          { stage: "job", severity: "WARN" },
        );
      } else {
        op.success({
          message: t("fw.recycle.jobDone", { ok: snapshot.ok, failed: snapshot.failed }),
          metadata: {
            total: snapshot.total,
            ok: snapshot.ok,
            failed: snapshot.failed,
            skipped: snapshot.skipped,
          },
        });
      }
    },
    [t],
  );

  const applyJob = useCallback(
    (snapshot: FileJobSnapshot) => {
      jobRef.current = snapshot;
      setJob(snapshot);
      settleJobOp(snapshot);
    },
    [settleJobOp],
  );

  const beginJob = useCallback((snapshot: FileJobSnapshot) => {
    jobPollMissesRef.current = 0;
    setJobTrackingLost(false);
    setJobCancelBusy(false);
    jobRef.current = snapshot;
    setJob(snapshot);
  }, []);

  const requestJobCancel = useCallback(async () => {
    const current = jobRef.current;
    if (
      !current ||
      isFileJobTerminal(current) ||
      current.cancelRequested ||
      current.status === "cancelling" ||
      jobCancelBusy
    ) {
      return;
    }
    setJobCancelBusy(true);
    try {
      const effective = await fsJobCancel(current.id);
      if (!effective) {
        showToast(t("fw.queue.cancelNotEffective"), { kind: "warning" });
      } else {
        const next = { ...current, cancelRequested: true };
        jobRef.current = next;
        setJob(next);
      }
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), { kind: "error" });
    } finally {
      setJobCancelBusy(false);
    }
  }, [jobCancelBusy, showToast, t]);


  const isZh = locale.startsWith("zh");
  const numberOf = useMemo(() => new Intl.NumberFormat(locale), [locale]);

  // ── 查询构造（全部在后端 SQL 执行）───────────────────────────────────
  const query = useMemo<RecycleQuery>(() => {
    const now = Date.now();
    const minSize = sizeFilter === "100mb" ? 100 * 1024 ** 2 : sizeFilter === "1gb" ? 1024 ** 3 : null;
    const after =
      ageFilter === "7d" ? now - 7 * 86400_000
        : ageFilter === "30d" ? now - 30 * 86400_000
          : ageFilter === "1y" ? now - 365 * 86400_000
            : null;
    return {
      search,
      kind,
      volume: volume === "all" ? null : volume,
      sort,
      dir,
      minSize,
      deletedAfterMs: after,
      limit: PAGE_SIZE,
    };
  }, [search, kind, volume, sort, dir, sizeFilter, ageFilter]);

  const queryKey = useMemo(() => JSON.stringify(query), [query]);

  const fetchPage = useCallback(
    async (offset: number, q: RecycleQuery) => {
      if (inflightRef.current.has(offset)) return;
      const generation = generationRef.current;
      inflightRef.current.set(offset, generation);
      setLoading(true);
      try {
        const page: RecyclePage = await recycleList({
          ...q,
          offset,
          limit: PAGE_SIZE,
          // 统计只在首页/刷新时取：翻页不需要，也不该触发全表聚合。
          includeStats: offset === 0,
        });
        if (generation !== generationRef.current) return;
        setPages((prev) => {
          const next = { ...prev, [offset]: page.items };
          const keys = Object.keys(next)
            .map(Number)
            .sort((a, b) => Math.abs(a - offset) - Math.abs(b - offset));
          while (keys.length > MAX_CACHED_PAGES) {
            const far = keys.pop();
            if (far !== undefined) delete next[far];
          }
          return next;
        });
        setTotal(page.total);
        if (page.stats) setStats(page.stats);
        setQueryMs(page.queryMs);
        setLoadError(null);
        setFirstLoaded(true);
      } catch (e) {
        if (generation === generationRef.current) {
          setLoadError(e instanceof Error ? e.message : String(e));
          setFirstLoaded(true);
        }
      } finally {
        if (inflightRef.current.get(offset) === generation) {
          inflightRef.current.delete(offset);
        }
        if (generation === generationRef.current) setLoading(false);
      }
    },
    [],
  );

  // 查询条件变化：清空缓存 + 回到顶部 + 加载第一页。
  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput.trim()), 220);
    return () => clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    generationRef.current += 1;
    inflightRef.current.clear();
    setPages({});
    setTotal(0);
    setQueryMs(null);
    setSelectedIds(new Set());
    setSelectedMeta(new Map());
    setAnchorId(null);
    setDetailId(null);
    setDetailSnapshot(null);
    setCtxMenu(null);
    setScrollTop(0);
    setFirstLoaded(false);
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    void fetchPage(0, query);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryKey]);

  // 初次进入：读缓存统计（毫秒级），随后按需增量同步。
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [s, status] = await Promise.all([recycleStats(), recycleSyncStatus()]);
        if (!alive) return;
        setStats(s);
        setSync(status);
        // 空索引：首次建立索引必须显式触发；已有缓存只做节流增量同步。
        void recycleSync(s.indexedAtMs === 0).then((next) => alive && setSync(next));
      } catch (e) {
        if (alive) setLoadError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // 同步/任务事件。
  useEffect(() => {
    let alive = true;
    const unlisteners: Array<Promise<unknown>> = [];
    unlisteners.push(
      onRecycleSyncProgress((p) => {
        if (alive) setSyncProgress(p);
      }),
    );
    unlisteners.push(
      onRecycleSyncDone((summary) => {
        if (!alive) return;
        setSyncSummary(summary);
        setSyncProgress(null);
        setSync((prev) => (prev ? { ...prev, running: false } : prev));
        // 同步后索引可能已变，详情快照不再可信。
        setDetailId(null);
        setDetailSnapshot(null);
        void recycleStats().then((s) => alive && setStats(s));
        void fetchPage(0, { ...query, offset: 0 });
        showToast(t("fw.recycle.syncDone", { count: summary.volumes.length }), { kind: "success" });
      }),
    );
    unlisteners.push(
      onRecycleJobProgress((snapshot) => {
        if (!alive) return;
        if (snapshot.kind !== "restore" && snapshot.kind !== "purge" && snapshot.kind !== "empty") return;
        // 同一视图同时只跟一个任务；别的窗口/视图的任务事件不能覆盖当前在途任务。
        const current = jobRef.current;
        if (current && current.id !== snapshot.id && !isFileJobTerminal(current)) return;
        applyJob(snapshot);
      }),
    );
    return () => {
      alive = false;
      for (const p of unlisteners) void p.then((fn) => (fn as () => void)?.());
    };
  }, [applyJob, fetchPage, query, showToast, t]);

  // 任务兜底轮询：pending/running/cancelling 都轮询，终态后立即停止。
  useEffect(() => {
    if (!job || isFileJobTerminal(job) || jobTrackingLost) return;
    let alive = true;
    let polling = false;
    const timer = setInterval(() => {
      if (polling) return;
      polling = true;
      void fsJobStatus(job.id)
        .then((next) => {
          if (!alive) return;
          jobPollMissesRef.current = 0;
          applyJob(next);
        })
        .catch((err) => {
          if (!alive) return;
          // 只有后端明确 NotFound 才计入“任务不存在”；网络/服务抖动不算。
          const error = normalizeError(err);
          if (error.code === "NOT_FOUND" || error.category === "not_found") {
            jobPollMissesRef.current += 1;
            if (jobPollMissesRef.current >= 2) {
              setJobTrackingLost(true);
              showToast(t("fw.queue.jobLost"), { kind: "warning" });
            }
          } else {
            jobPollMissesRef.current = 0;
          }
        })
        .finally(() => {
          polling = false;
        });
    }, 700);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [applyJob, job?.id, job?.status, jobTrackingLost, showToast, t]);

  // 终态刷新列表与统计（只刷新缓存，不触发扫描）；清掉已删除行的旧选择。
  useEffect(() => {
    if (!job || !isFileJobTerminal(job)) return;
    setSelectedIds(new Set());
    setSelectedMeta(new Map());
    setAnchorId(null);
    setDetailId(null);
    setDetailSnapshot(null);
    setCtxMenu(null);
    void fetchPage(0, { ...query, offset: 0 });
    void recycleStats().then((s) => setStats(s));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.id, job?.status]);

  // 视口测量。
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setViewportH(Math.max(el.clientHeight, 120));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const visibleStart = Math.max(0, Math.floor(scrollTop / ROW_H) - 6);
  const visibleEnd = Math.min(total, Math.ceil((scrollTop + viewportH) / ROW_H) + 6);
  const neededPageStart = Math.floor(visibleStart / PAGE_SIZE) * PAGE_SIZE;

  // 滚动到未缓存页时补拉。
  useEffect(() => {
    if (!firstLoaded || total === 0) return;
    if (!pages[neededPageStart] && neededPageStart < total && !inflightRef.current.has(neededPageStart)) {
      void fetchPage(neededPageStart, query);
    }
    // 预取下一页，滚到底部时不出现空白等待。
    const next = neededPageStart + PAGE_SIZE;
    if (next < total && !pages[next] && !inflightRef.current.has(next)) {
      void fetchPage(next, query);
    }
  }, [neededPageStart, pages, total, firstLoaded, fetchPage, query]);

  const visibleRows = useMemo(() => {
    const rows: Array<{ item: RecycleItem; index: number }> = [];
    for (let index = visibleStart; index < visibleEnd; index += 1) {
      const pageStart = Math.floor(index / PAGE_SIZE) * PAGE_SIZE;
      const item = pages[pageStart]?.[index - pageStart];
      if (item) rows.push({ item, index });
    }
    return rows;
  }, [pages, visibleStart, visibleEnd]);

  /** 只在当前缓存页里找最新版本；找不到说明该页已被窗口淘汰。 */
  const findCachedItem = useCallback(
    (id: string): RecycleItem | null => {
      for (const items of Object.values(pages)) {
        const hit = items.find((item) => item.id === id);
        if (hit) return hit;
      }
      return null;
    },
    [pages],
  );

  const detailItem = useMemo(() => {
    if (!detailId) return null;
    const cached = findCachedItem(detailId);
    if (cached) return cached;
    // 页面淘汰后回退到打开详情时的快照：详情不消失，也不会串到别的行。
    return detailSnapshot && detailSnapshot.id === detailId ? detailSnapshot : null;
  }, [detailId, detailSnapshot, findCachedItem]);

  // 选择范围只由 selectedIds 决定，元数据来自选中时的快照，不再依赖页面缓存。
  const selectedItems = useMemo(() => {
    const items: RecycleItem[] = [];
    for (const id of selectedIds) {
      const hit = selectedMeta.get(id);
      if (hit) items.push(hit);
    }
    return items;
  }, [selectedIds, selectedMeta]);

  // 元数据不可读 / `$R` 丢失 / 孤儿项目没有可恢复的原始路径：只允许永久删除，
  // 不把「恢复必失败」的项目送进任务队列。
  const restorableIds = useMemo(
    () => selectedItems.filter((item) => item.state === "present").map((item) => item.id),
    [selectedItems],
  );

  // 异常项（missing_data / unreadable）在后端只做索引移除，UI 必须如实说明。
  const selectedAnomalyCount = selectedItems.filter((item) => item.state !== "present").length;
  const selectedAllAnomaly = selectedItems.length > 0 && selectedAnomalyCount === selectedItems.length;

  const allVolumes = stats?.volumes ?? [];

  // ── 选择 ────────────────────────────────────────────────────────────
  /** 唯一的选择写入口：selectedMeta 只保留 selectedIds 中存在的键。 */
  const commitSelection = useCallback(
    (ids: Set<string>, added: readonly RecycleItem[] = []) => {
      setSelectedIds(ids);
      setSelectedMeta((prev) => {
        const next = new Map<string, RecycleItem>();
        for (const id of ids) {
          const hit = prev.get(id);
          if (hit) next.set(id, hit);
        }
        for (const item of added) {
          if (ids.has(item.id)) next.set(item.id, item);
        }
        return next;
      });
    },
    [],
  );

  const openDetail = (item: RecycleItem) => {
    setDetailId(item.id);
    setDetailSnapshot(item);
  };

  const closeDetail = () => {
    setDetailId(null);
    setDetailSnapshot(null);
  };

  const onRowClick = (e: ReactMouseEvent<HTMLDivElement>, item: RecycleItem, index: number) => {
    openDetail(item);
    if (e.shiftKey && anchorId) {
      const anchorIndex = (() => {
        for (const [start, items] of Object.entries(pages)) {
          const idx = items.findIndex((x) => x.id === anchorId);
          if (idx >= 0) return Number(start) + idx;
        }
        return -1;
      })();
      if (anchorIndex >= 0) {
        const lo = Math.min(anchorIndex, index);
        const hi = Math.max(anchorIndex, index);
        const next = new Set(selectedIds);
        const added: RecycleItem[] = [];
        for (let i = lo; i <= hi; i += 1) {
          const start = Math.floor(i / PAGE_SIZE) * PAGE_SIZE;
          const hit = pages[start]?.[i - start];
          if (hit) {
            next.add(hit.id);
            added.push(hit);
          }
        }
        commitSelection(next, added);
        return;
      }
    }
    if (e.ctrlKey || e.metaKey) {
      const next = new Set(selectedIds);
      if (next.has(item.id)) next.delete(item.id);
      else next.add(item.id);
      commitSelection(next, [item]);
      setAnchorId(item.id);
      return;
    }
    commitSelection(new Set([item.id]), [item]);
    setAnchorId(item.id);
  };

  const toggleSelectAllPage = (checked: boolean) => {
    const pageStart = Math.floor(visibleStart / PAGE_SIZE) * PAGE_SIZE;
    const items = pages[pageStart] ?? [];
    const next = new Set(selectedIds);
    for (const item of items) {
      if (checked) next.add(item.id);
      else next.delete(item.id);
    }
    commitSelection(next, items);
  };

  // ── 操作 ────────────────────────────────────────────────────────────
  const askRestore = (ids: string[]) => {
    if (!ids.length) return;
    setRestoreConflict("skip");
    setConfirm({ kind: "restore", ids });
  };

  /** 解析待删除项的当前状态：先缓存页，再选中快照，最后详情快照。 */
  const purgeScopeOf = (ids: string[]): PurgeScope => {
    let known = 0;
    let anomaly = 0;
    for (const id of ids) {
      const hit =
        findCachedItem(id) ??
        selectedMeta.get(id) ??
        (detailSnapshot && detailSnapshot.id === id ? detailSnapshot : null);
      if (!hit) continue;
      known += 1;
      if (hit.state !== "present") anomaly += 1;
    }
    if (known === 0 || anomaly === 0) return "full";
    return anomaly === known ? "indexOnly" : "mixed";
  };

  const askPurge = (ids: string[]) => {
    if (!ids.length) return;
    setConfirm({ kind: "purge", ids, scope: purgeScopeOf(ids) });
  };

  const runRestore = async (ids: string[], conflict: "skip" | "rename") => {
    const op = startOperation("file", "recycle_restore", {
      component: "回收站",
      metadata: { count: ids.length, conflict },
    });
    jobOpRef.current = op;
    try {
      op.stage("job");
      const snapshot = await recycleRestore(ids, conflict, op.id);
      beginJob(snapshot);
      settleJobOp(snapshot);
    } catch (e) {
      op.fail(e);
      showToast(e instanceof Error ? e.message : String(e), { kind: "error" });
    }
  };

  const runPurge = async (ids: string[]) => {
    const op = startOperation("file", "recycle_purge", {
      component: "回收站",
      metadata: { count: ids.length },
    });
    jobOpRef.current = op;
    try {
      op.stage("job");
      const snapshot = await recyclePurge(ids, op.id);
      beginJob(snapshot);
      settleJobOp(snapshot);
    } catch (e) {
      op.fail(e);
      showToast(e instanceof Error ? e.message : String(e), { kind: "error" });
    }
  };

  const runEmpty = async (volumes: string[]) => {
    const op = startOperation("file", "recycle_empty", {
      component: "回收站",
      metadata: { volumes: volumes.length },
    });
    jobOpRef.current = op;
    try {
      op.stage("job");
      const snapshot = await recycleEmpty(volumes, op.id);
      beginJob(snapshot);
      settleJobOp(snapshot);
    } catch (e) {
      op.fail(e);
      showToast(e instanceof Error ? e.message : String(e), { kind: "error" });
    }
  };

  const startSync = async (force: boolean) => {
    try {
      const status = await recycleSync(force);
      setSync(status);
      if (status.running) setSyncSummary(null);
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), { kind: "error" });
    }
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.closest("input, textarea, [contenteditable='true']")) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
      e.preventDefault();
      toggleSelectAllPage(true);
      return;
    }
    if (e.key === "Delete" || e.key === "Backspace") {
      if (selectedIds.size === 0) return;
      e.preventDefault();
      askPurge([...selectedIds]);
    }
  };

  const statsText = stats
    ? t("fw.recycle.statsLine", {
        items: numberOf.format(stats.items),
        files: numberOf.format(stats.files),
        folders: numberOf.format(stats.folders),
        bytes: formatSize(stats.knownBytes),
      })
    : t("fw.recycle.loadingStats");

  const lastSyncText = stats?.lastSyncMs
    ? formatModified(stats.lastSyncMs)
    : t("fw.recycle.neverSynced");

  const syncLabel = sync?.running
    ? t("fw.recycle.syncing", { done: sync.volumesDone, total: sync.volumesTotal })
    : stats?.state === "partial"
      ? t("fw.recycle.partial")
      : stats?.state === "offline"
        ? t("fw.recycle.offline")
        : t("fw.recycle.cached");

  const jobBusy = Boolean(job && !isFileJobTerminal(job) && !jobTrackingLost);
  const emptyCandidates = allVolumes.filter((v) => v.items > 0);
  const emptySelected = emptyCandidates.filter((v) => emptyVolumes.has(v.volume));
  const emptyAllSelected = emptyCandidates.length > 0 && emptySelected.length === emptyCandidates.length;
  const emptyScopeText =
    emptySelected.length === 0
      ? t("fw.recycle.emptyScopeNone")
      : emptyAllSelected
        ? t("fw.recycle.emptyScopeAll", { count: emptySelected.length })
        : emptySelected.map((v) => v.volume).join("、");
  const emptyItemCount = emptySelected.reduce((sum, v) => sum + v.items, 0);
  const emptyKnownBytes = emptySelected.reduce((sum, v) => sum + v.knownBytes, 0);
  const emptyScopeCaveat =
    stats && (stats.state === "partial" || stats.state === "offline")
      ? t("fw.recycle.emptyScopePartial")
      : null;
  const emptyListText = search
    ? t("fw.recycle.emptySearch")
    : stats?.state === "offline"
      ? t("fw.recycle.emptyListOffline")
      : stats?.state === "partial"
        ? t("fw.recycle.emptyListPartial")
        : stats?.indexedAtMs === 0
          ? t("fw.recycle.emptyListNoIndex")
          : t("fw.recycle.emptyList");

  return (
    <div className="rc-view" onKeyDown={onKeyDown} tabIndex={-1}>
      {/* 统计条：只占一行，不挤压列表 */}
      <div className="rc-stats" role="status" aria-live="polite">
        <div className="rc-stats-main">
          <span className="rc-stats-items">{statsText}</span>
          {stats && stats.unknownSize > 0 && (
            <span className="rc-stats-muted" data-tip={t("fw.recycle.unknownSizeHint")}>
              {t("fw.recycle.unknownSize", { count: stats.unknownSize })}
            </span>
          )}
        </div>
        <div className="rc-stats-side">
          {loading && <span className="rc-stats-muted">{t("fw.recycle.loading")}</span>}
          <span className={`rc-state${sync?.running ? " is-busy" : ""}`}>{syncLabel}</span>
          <span className="rc-stats-muted">{t("fw.recycle.lastSync", { time: lastSyncText })}</span>
          {queryMs !== null && (
            <span className="rc-stats-muted">{t("fw.recycle.queryMs", { ms: queryMs })}</span>
          )}
        </div>
      </div>

      {/* 同步进度 */}
      {sync?.running && syncProgress && (
        <div className="rc-progress" role="status">
          <div className="rc-progress-text">
            {t("fw.recycle.progressVolume", {
              volume: syncProgress.volume,
              done: syncProgress.done,
              total: syncProgress.total,
            })}
          </div>
          <button type="button" className="btn sm" onClick={() => void recycleSyncCancel()}>
            {t("fw.recycle.cancelSync")}
          </button>
        </div>
      )}

      {/* 工具栏 */}
      <div className="rc-toolbar">
        <SearchField
          value={searchInput}
          onChange={setSearchInput}
          ariaLabel={t("fw.recycle.search")}
          placeholder={t("fw.recycle.searchPlaceholder")}
          size="compact"
          className="rc-search"
        />
        <Select
          value={kind}
          onChange={(v) => setKind(v as KindKey)}
          ariaLabel={t("fw.recycle.kind")}
          options={[
            { value: "all", label: t("fw.recycle.kindAll") },
            { value: "file", label: t("fw.recycle.kindFile") },
            { value: "folder", label: t("fw.recycle.kindFolder") },
          ]}
        />
        <Select
          value={volume}
          onChange={setVolume}
          ariaLabel={t("fw.recycle.volume")}
          options={[
            { value: "all", label: t("fw.recycle.allVolumes") },
            ...allVolumes.map((v) => ({ value: v.volume, label: `${v.volume} (${v.items})` })),
          ]}
        />
        <Select
          value={sort}
          onChange={(v) => setSort(v as SortKey)}
          ariaLabel={t("fw.recycle.sort")}
          options={SORT_OPTIONS.map((o) => ({ value: o.value, label: isZh ? o.zh : o.en }))}
        />
        <button
          type="button"
          className="btn sm"
          aria-label={t("fw.recycle.toggleDir")}
          data-tip={dir === "desc" ? t("fw.recycle.desc") : t("fw.recycle.asc")}
          onClick={() => setDir(dir === "desc" ? "asc" : "desc")}
        >
          {dir === "desc" ? "↓" : "↑"}
        </button>
        <Select
          value={sizeFilter}
          onChange={(v) => setSizeFilter(v as typeof sizeFilter)}
          ariaLabel={t("fw.recycle.sizeFilter")}
          options={[
            { value: "all", label: t("fw.recycle.anySize") },
            { value: "100mb", label: t("fw.recycle.over100mb") },
            { value: "1gb", label: t("fw.recycle.over1gb") },
          ]}
        />
        <Select
          value={ageFilter}
          onChange={(v) => setAgeFilter(v as typeof ageFilter)}
          ariaLabel={t("fw.recycle.ageFilter")}
          options={[
            { value: "all", label: t("fw.recycle.anyTime") },
            { value: "7d", label: t("fw.recycle.last7d") },
            { value: "30d", label: t("fw.recycle.last30d") },
            { value: "1y", label: t("fw.recycle.lastYear") },
          ]}
        />

        <div className="rc-actions">
          <button type="button" className="btn sm" onClick={() => void startSync(true)} disabled={sync?.running}>
            {t("fw.recycle.sync")}
          </button>
          <button
            type="button"
            className="btn sm"
            disabled={restorableIds.length === 0 || jobBusy}
            onClick={() => askRestore(restorableIds)}
          >
            {t("fw.recycle.restore")}
          </button>
          <button
            type="button"
            className="btn sm danger"
            disabled={selectedIds.size === 0 || jobBusy}
            onClick={() => askPurge([...selectedIds])}
          >
            {selectedAllAnomaly ? t("fw.recycle.purgeIndexOnly") : t("fw.recycle.purge")}
          </button>
          <button
            type="button"
            className="btn sm danger"
            disabled={!stats || stats.items === 0 || jobBusy}
            onClick={() => {
              setEmptyAck(false);
              setEmptyVolumes(new Set(allVolumes.filter((v) => v.items > 0).map((v) => v.volume)));
              setConfirm({ kind: "empty" });
            }}
          >
            {t("fw.recycle.empty")}
          </button>
        </div>
      </div>

      {/* 任务进度与结果 */}
      {job && (
        <div
          className={`rc-job${
            job.status === "failed"
              ? " is-failed"
              : job.status === "partial"
                ? " is-warning"
                : job.status === "cancelled"
                  ? " is-cancelled"
                  : ""
          }`}
          role="status"
        >
          <span className="rc-job-text">
            {job.kind === "restore"
              ? t("fw.recycle.jobRestore")
              : job.kind === "purge"
                ? t("fw.recycle.jobPurge")
                : t("fw.recycle.jobEmpty")} ·{" "}
            {jobTrackingLost
              ? t("fw.queue.jobLost")
              : job.status === "pending"
                ? t("fw.recycle.jobQueued")
                : job.status === "cancelling"
                  ? t("fw.recycle.jobCancelling", { ok: job.ok, failed: job.failed, remaining: Math.max(0, job.total - job.done) })
                  : job.status === "running"
                    ? t("fw.recycle.jobRunning", { done: job.done, total: job.total, ok: job.ok, failed: job.failed })
                    : job.status === "cancelled"
                      ? t("fw.recycle.jobCancelledResult", { ok: job.ok, failed: job.failed, remaining: Math.max(0, job.total - job.done) })
                      : job.status === "partial"
                        ? t("fw.recycle.jobFinishedPartial", { ok: job.ok, failed: job.failed, skipped: job.skipped })
                        : job.status === "failed"
                          ? t("fw.recycle.jobFailedResult", { ok: job.ok, failed: job.failed, message: job.message ?? "" })
                          : t("fw.recycle.jobFinished", { ok: job.ok, failed: job.failed, skipped: job.skipped })}
            {/* 取消/部分完成/失败必须带出任务级说明：清空在启动后取消时，
                「部分项目已永久删除」不能被读成「已回滚」。 */}
            {isFileJobTerminal(job) && job.status !== "completed" && job.message
              ? ` · ${job.message}`
              : ""}
          </span>
          {job.indexPending ? (
            <span className="rc-job-index" title={job.message ?? undefined}>
              {t("fw.recycle.indexPending", { count: job.indexPending })}
            </span>
          ) : null}
          {!jobTrackingLost && jobBusy && job.cancelable && !job.cancelRequested && job.status !== "cancelling" && (
            <button type="button" className="btn sm" disabled={jobCancelBusy} onClick={() => void requestJobCancel()}>
              {job.status === "pending" ? t("fw.recycle.cancelQueuedJob") : t("fw.recycle.cancelJob")}
            </button>
          )}
          {job.failures.length > 0 && (
            <span className="rc-job-failures" data-tip={job.failures.slice(0, 12).map((f) => `${f.label}: ${f.code ?? f.status}`).join("\n")}>
              {t("fw.recycle.failures", { count: job.failures.length })}
            </span>
          )}
        </div>
      )}

      {/* 列表 + 详情 */}
      <div className="rc-main">
        <div className="rc-list-wrap">
          <div className="rc-head" aria-hidden="true">
            <span />
            <span>{t("fw.recycle.colName")}</span>
            <span>{t("fw.recycle.colPath")}</span>
            <span className="rc-col-time">{t("fw.recycle.colDeleted")}</span>
            <span className="rc-col-size">{t("fw.recycle.colSize")}</span>
            <span className="rc-col-volume">{t("fw.recycle.colVolume")}</span>
          </div>
          <div
            className="rc-scroll"
            ref={scrollRef}
            role="listbox"
            aria-multiselectable="true"
            aria-label={t("fw.recycle.listLabel")}
            onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
          >
            <div className="rc-canvas" style={{ height: Math.max(total * ROW_H, ROW_H) }}>
              {visibleRows.map(({ item, index }) => (
                <div
                  key={item.id}
                  role="option"
                  aria-selected={selectedIds.has(item.id)}
                  className={`rc-row${selectedIds.has(item.id) ? " is-selected" : ""}${
                    detailId === item.id ? " is-active" : ""
                  }`}
                  style={{ transform: `translateY(${index * ROW_H}px)` }}
                  onClick={(e) => onRowClick(e, item, index)}
                  onDoubleClick={() => {
                    // 数据缺失/元数据损坏的条目不可能恢复：双击不得发起必失败的任务。
                    if (item.state === "present") askRestore([item.id]);
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    if (!selectedIds.has(item.id)) commitSelection(new Set([item.id]), [item]);
                    openDetail(item);
                    setCtxMenu({ x: e.clientX, y: e.clientY, id: item.id });
                  }}
                >
                  <span className="rc-cell-check" onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      checked={selectedIds.has(item.id)}
                      ariaLabel={t("fw.recycle.selectItem", { name: item.name })}
                      onChange={(checked) => {
                        const next = new Set(selectedIds);
                        if (checked) next.add(item.id);
                        else next.delete(item.id);
                        commitSelection(next, [item]);
                      }}
                    />
                  </span>
                  <span className={`rc-cell-name${item.isDir ? " is-dir" : ""}`} title={item.name}>
                    {item.name}
                  </span>
                  <span className="rc-cell-path" title={item.originalPath}>
                    {item.originalPath}
                  </span>
                  <span className="rc-cell-time">{formatDeleted(item.deletedMs)}</span>
                  <span className="rc-cell-size">{item.isDir ? "—" : formatSize(item.size)}</span>
                  <span className="rc-cell-volume">{item.volume}</span>
                  {item.state !== "present" && (
                    <span
                      className="rc-cell-warn"
                      data-tip={item.state === "missing_data" ? t("fw.recycle.missingData") : t("fw.recycle.unreadable")}
                    >
                      !
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
          {firstLoaded && total === 0 && (
            <div className="rc-empty" role="status">
              {loadError ?? emptyListText}
            </div>
          )}
          {!firstLoaded && <div className="rc-empty" role="status">{t("fw.recycle.loading")}</div>}
          {loadError && total > 0 && <div className="rc-error" role="alert">{loadError}</div>}
        </div>

        {/* 详情：复用文件工作区右侧详情语言 */}
        {detailItem && (
          <aside className="rc-detail" aria-label={t("fw.recycle.detail")}>
            <div className="rc-detail-head">
              <span className="rc-detail-title" title={detailItem.name}>
                {detailItem.name}
              </span>
              <button
                type="button"
                className="icon-btn sm"
                aria-label={t("fw.recycle.closeDetail")}
                onClick={closeDetail}
              >
                ×
              </button>
            </div>
            <dl className="rc-detail-list">
              <dt>{t("fw.recycle.detailType")}</dt>
              <dd>{detailItem.isDir ? t("fw.recycle.kindFolder") : t("fw.recycle.kindFile")}</dd>
              <dt>{t("fw.recycle.detailSize")}</dt>
              <dd>{detailItem.isDir ? t("fw.recycle.unknown") : formatSize(detailItem.size)}</dd>
              <dt>{t("fw.recycle.detailDeleted")}</dt>
              <dd>{formatDeleted(detailItem.deletedMs)}</dd>
              <dt>{t("fw.recycle.detailVolume")}</dt>
              <dd>{detailItem.volume}</dd>
              <dt>{t("fw.recycle.detailState")}</dt>
              <dd>
                {detailItem.state === "present"
                  ? t("fw.recycle.statePresent")
                  : detailItem.state === "missing_data"
                    ? t("fw.recycle.missingData")
                    : t("fw.recycle.unreadable")}
              </dd>
            </dl>
            <div className="rc-detail-path-label">{t("fw.recycle.detailPath")}</div>
            <div className="rc-detail-path">{detailItem.originalPath}</div>
            {detailItem.anomaly && <div className="rc-detail-anomaly">{detailItem.anomaly}</div>}
            {detailItem.state !== "present" && (
              <div className="rc-detail-anomaly">{t("fw.recycle.indexOnlyHint")}</div>
            )}
            <div className="rc-detail-actions">
              {/* 异常项无法恢复（数据已缺失），不提供必然失败的按钮。 */}
              {detailItem.state === "present" && (
                <button type="button" className="btn sm" onClick={() => askRestore([detailItem.id])}>
                  {t("fw.recycle.restore")}
                </button>
              )}
              <button type="button" className="btn sm danger" onClick={() => askPurge([detailItem.id])}>
                {detailItem.state === "present"
                  ? t("fw.recycle.purge")
                  : t("fw.recycle.purgeIndexOnly")}
              </button>
            </div>
          </aside>
        )}
      </div>

      {/* 选中数量提示 */}
      {selectedIds.size > 0 && (
        <div className="rc-selection-bar" role="status">
          <span>{t("fw.recycle.selected", { count: selectedIds.size })}</span>
          <button type="button" className="btn sm" onClick={() => commitSelection(new Set())}>
            {t("fw.recycle.clearSelection")}
          </button>
        </div>
      )}

      {ctxMenu && (
        <FreeMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          menuLabel={t("fw.recycle.menuLabel")}
          onClose={() => setCtxMenu(null)}
          items={[
            {
              key: "restore",
              label: t("fw.recycle.restore"),
              disabled: restorableIds.length === 0,
              onSelect: () => askRestore(restorableIds),
            },
            {
              key: "purge",
              label: selectedAllAnomaly ? t("fw.recycle.purgeIndexOnly") : t("fw.recycle.purge"),
              danger: true,
              onSelect: () => askPurge([...selectedIds]),
            },
          ]}
        />
      )}

      {/* 恢复确认：同名冲突策略必须显式选择 */}
      <Dialog
        open={confirm?.kind === "restore"}
        onClose={() => setConfirm(null)}
        title={t("fw.recycle.restoreTitle", { count: confirm?.kind === "restore" ? confirm.ids.length : 0 })}
        size="sm"
        footer={
          <>
            <button type="button" className="btn" onClick={() => setConfirm(null)}>
              {t("common.cancel")}
            </button>
            <button
              type="button"
              className="btn primary"
              onClick={() => {
                if (confirm?.kind !== "restore") return;
                const ids = confirm.ids;
                setConfirm(null);
                void runRestore(ids, restoreConflict);
              }}
            >
              {t("fw.recycle.restoreConfirm")}
            </button>
          </>
        }
      >
        <p className="rc-dialog-note">{t("fw.recycle.restoreBody")}</p>
        <div className="rc-radio-list">
          <label className="rc-radio">
            <input
              type="radio"
              name="rc-conflict"
              checked={restoreConflict === "skip"}
              onChange={() => setRestoreConflict("skip")}
            />
            <span>
              <strong>{t("fw.recycle.conflictSkip")}</strong>
              <em>{t("fw.recycle.conflictSkipHint")}</em>
            </span>
          </label>
          <label className="rc-radio">
            <input
              type="radio"
              name="rc-conflict"
              checked={restoreConflict === "rename"}
              onChange={() => setRestoreConflict("rename")}
            />
            <span>
              <strong>{t("fw.recycle.conflictRename")}</strong>
              <em>{t("fw.recycle.conflictRenameHint")}</em>
            </span>
          </label>
        </div>
      </Dialog>

      {/* 永久删除确认：异常项只移出索引，说明必须在操作前讲清 */}
      <ConfirmDialog
        open={confirm?.kind === "purge"}
        title={
          confirm?.kind === "purge" && confirm.scope === "indexOnly"
            ? t("fw.recycle.purgeIndexOnlyTitle", { count: confirm.ids.length })
            : t("fw.recycle.purgeTitle", { count: confirm?.kind === "purge" ? confirm.ids.length : 0 })
        }
        detail={
          confirm?.kind === "purge" && confirm.scope === "indexOnly"
            ? t("fw.recycle.purgeBodyIndexOnly")
            : confirm?.kind === "purge" && confirm.scope === "mixed"
              ? t("fw.recycle.purgeBodyMixed")
              : t("fw.recycle.purgeBody")
        }
        confirmLabel={
          confirm?.kind === "purge" && confirm.scope === "indexOnly"
            ? t("fw.recycle.purgeIndexOnly")
            : t("fw.recycle.purgeConfirm")
        }
        danger
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          if (confirm?.kind !== "purge") return;
          const ids = confirm.ids;
          setConfirm(null);
          void runPurge(ids);
        }}
      />

      {/* 清空回收站：二次确认 + 逐卷选择 + 明确不可恢复 */}
      <Dialog
        open={confirm?.kind === "empty"}
        onClose={() => setConfirm(null)}
        title={t("fw.recycle.emptyTitle", { scope: emptyScopeText })}
        size="sm"
        footer={
          <>
            <button type="button" className="btn" onClick={() => setConfirm(null)}>
              {t("common.cancel")}
            </button>
            <button
              type="button"
              className="btn danger"
              disabled={!emptyAck || emptyVolumes.size === 0}
              onClick={() => {
                const volumes = [...emptyVolumes];
                setConfirm(null);
                void runEmpty(volumes);
              }}
            >
              {t("fw.recycle.emptyConfirm")}
            </button>
          </>
        }
      >
        <p className="rc-dialog-note rc-danger-note">
          {emptySelected.length === 0
            ? t("fw.recycle.emptyBodyNone")
            : t("fw.recycle.emptyBody", {
                scope: emptyScopeText,
                items: numberOf.format(emptyItemCount),
                bytes: formatSize(emptyKnownBytes),
              })}
        </p>
        {emptyScopeCaveat && <p className="rc-dialog-note">{emptyScopeCaveat}</p>}
        <div className="rc-volume-list">
          {allVolumes.map((v) => (
            <Checkbox
              key={v.volume}
              checked={emptyVolumes.has(v.volume)}
              disabled={v.items === 0}
              ariaLabel={t("fw.recycle.volumeCheck", { volume: v.volume })}
              onChange={(checked) => {
                const next = new Set(emptyVolumes);
                if (checked) next.add(v.volume);
                else next.delete(v.volume);
                setEmptyVolumes(next);
              }}
              label={`${v.volume} · ${t("fw.recycle.volumeSummary", {
                items: v.items,
                bytes: formatSize(v.knownBytes),
              })}`}
            />
          ))}
        </div>
        <Checkbox
          checked={emptyAck}
          onChange={setEmptyAck}
          ariaLabel={t("fw.recycle.emptyAck")}
          label={t("fw.recycle.emptyAck")}
        />
      </Dialog>

      {syncSummary && syncSummary.volumes.length > 0 && (
        <div className="rc-sync-summary" role="status">
          {syncSummary.volumes.map((v) => (
            <span key={v.volume}>
              {v.volume}: {v.items} · +{v.added} ~{v.updated} -{v.removed}
              {v.errorCode ? ` · ${v.errorCode}` : ""}
            </span>
          ))}
          <button type="button" className="btn sm" onClick={() => setSyncSummary(null)}>
            {t("common.close")}
          </button>
        </div>
      )}
    </div>
  );
}
