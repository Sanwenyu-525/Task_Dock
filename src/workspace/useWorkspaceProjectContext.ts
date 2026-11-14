//! 工作空间项目上下文：**带代次的异步读写**（P0-03 / P1-02，2026-11-13）。
//!
//! ## 为什么单独成层
//! 原 `WorkspaceApp.loadProjectData()` 直接 `await` 三个请求后写组件状态。快速从
//! 项目 A 切到 B 时，A 的响应会覆盖 B 的界面；更糟的是「A 的写操作完成后再刷新
//! 列表」会把 A 的事项写进 B 的 state。这里把「当前项目」变成一份显式上下文：
//!
//! 1. **代次（generation）**：项目切换即 `gen++`；每个异步回调在落地前比对
//!    `gen === current` 且 `pid === currentProjectId`，过期响应直接丢弃（不 setState）。
//! 2. **项目归属**：写操作以**点击时**捕获的项目 ID 为目标，绝不读取最新
//!    `selectedId`；结果只回灌到同一项目，切走后不再触碰新项目 state。
//! 3. **状态隔离**：加载态/错误态按代次保存，切换项目立即清空，旧项目的失败
//!    不会污染新项目，也不会把新项目的数据清空。
//! 4. **写保护**：传入的事项/关联若属于其他项目，本轮操作直接拒绝（stale），
//!    避免「切换瞬间的残留点击」把 A 的数据写进 B。
//!
//! 前端防竞态不是后端约束的替代品：`workspace_*` 命令仍然按 projectId 归属读写，
//! 本层只保证 UI 不被过期响应污染。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { errorMessage } from "../lib/errors";
import {
  devProjectList,
  devProjectProbe,
  listTasks,
  workspaceInstanceGet,
  workspaceInstanceSave,
  workspaceItemDelete,
  workspaceItemList,
  workspaceItemSave,
  workspaceTaskLinkAdd,
  workspaceTaskLinkList,
  workspaceTaskUnlink,
  type DevGitInfo,
  type DevProject,
  type Task,
  type WorkspaceInstance,
  type WorkspaceItem,
  type WorkspaceItemStatus,
  type WorkspaceTaskLink,
} from "../lib/bridge";
import {
  parseWorkspaceLayout,
  withActiveModule,
  type WorkspaceLayoutConfig,
  type WorkspaceModuleId,
  type WorkspaceProfile,
} from "./workspaceProfiles";

export type WorkspaceLoadStatus = "idle" | "loading" | "ready" | "error";
/** 异步写操作结果：ok=已落地并同步 UI；stale=目标项目已切走（结果丢弃）；failed=真实失败。 */
export type WorkspaceActionResult = "ok" | "stale" | "failed";

interface ProjectContextState {
  projectId: string | null;
  status: WorkspaceLoadStatus;
  error: string | null;
  items: WorkspaceItem[];
  links: WorkspaceTaskLink[];
  instance: WorkspaceInstance | null;
}

const EMPTY: ProjectContextState = {
  projectId: null,
  status: "idle",
  error: null,
  items: [],
  links: [],
  instance: null,
};

export interface WorkspaceProjectContext {
  projectId: string | null;
  status: WorkspaceLoadStatus;
  error: string | null;
  items: WorkspaceItem[];
  links: WorkspaceTaskLink[];
  instance: WorkspaceInstance | null;
  layout: WorkspaceLayoutConfig;
  /** `true` = 磁盘上的 layout_json 损坏/旧版本，已安全回退默认布局。 */
  layoutRepaired: boolean;
  reload: () => Promise<void>;
  /** 切换模块：只更新 activeModule，保留 moduleOrder/hiddenModules（旧实现传 "{}"）。 */
  saveModule: (module: WorkspaceModuleId) => Promise<WorkspaceActionResult>;
  addItem: (input: { title: string; stage: string }) => Promise<WorkspaceActionResult>;
  cycleItemStatus: (item: WorkspaceItem) => Promise<WorkspaceActionResult>;
  removeItem: (item: WorkspaceItem) => Promise<WorkspaceActionResult>;
  addTaskLink: (taskId: string) => Promise<WorkspaceActionResult>;
  removeTaskLink: (taskId: string) => Promise<WorkspaceActionResult>;
  /** 已落地到「上一个项目」的写操作提示（切走后不写入新项目，但如实告知）。 */
  lastStaleNotice: string | null;
  clearStaleNotice: () => void;
}

const ITEM_STATUSES: WorkspaceItemStatus[] = ["todo", "doing", "blocked", "done", "archived"];

/**
 * 项目上下文 hook。
 *
 * @param projectId 当前选中的项目（null = 未选择）
 * @param profile   当前项目的 Profile（决定默认模块 / 布局解析）
 */
export function useWorkspaceProjectContext(
  projectId: string | null,
  profile: WorkspaceProfile,
): WorkspaceProjectContext {
  const [state, setState] = useState<ProjectContextState>(EMPTY);
  const [lastStaleNotice, setLastStaleNotice] = useState<string | null>(null);

  // 代次 + 当前项目：所有异步回调的落地判据。ref 而非 state，避免闭包读到旧值。
  const genRef = useRef(0);
  const projectRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const profileRef = useRef(profile);
  profileRef.current = profile;
  /** 最新落地状态：异步写操作读它，而不是渲染闭包（避免切换那一帧拿到旧项目布局）。 */
  const stateRef = useRef(state);
  stateRef.current = state;
  /** 模块保存串行链：同一项目的连续切换按点击顺序落库，最后一次点击生效。 */
  const moduleSaveChainRef = useRef<Promise<unknown>>(Promise.resolve());

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const isCurrent = useCallback((gen: number, pid: string) => {
    return mountedRef.current && genRef.current === gen && projectRef.current === pid;
  }, []);

  const loadInto = useCallback(
    async (pid: string, gen: number): Promise<void> => {
      try {
        const [inst, items, links] = await Promise.all([
          workspaceInstanceGet(pid),
          workspaceItemList(pid),
          workspaceTaskLinkList(pid),
        ]);
        if (!isCurrent(gen, pid)) return;
        setState({
          projectId: pid,
          status: "ready",
          error: null,
          items: items.items,
          links: links.links,
          instance: inst.instance,
        });
      } catch (e) {
        if (!isCurrent(gen, pid)) return;
        setState((s) =>
          s.projectId === pid
            ? { ...s, status: "error", error: errorMessage(e) }
            : { projectId: pid, status: "error", error: errorMessage(e), items: [], links: [], instance: null },
        );
      }
    },
    [isCurrent],
  );

  // 项目切换：代次前进 + 立即清空（旧项目的内容不得短暂显示在新项目名下）
  useEffect(() => {
    projectRef.current = projectId;
    genRef.current += 1;
    const gen = genRef.current;
    setLastStaleNotice(null);
    if (!projectId) {
      setState(EMPTY);
      return;
    }
    setState({ projectId, status: "loading", error: null, items: [], links: [], instance: null });
    void loadInto(projectId, gen);
  }, [projectId, loadInto]);

  // 只接受属于当前代次的写入结果：过期结果不刷新、不报错、不触碰新项目
  const commitRefresh = useCallback(
    async (pid: string, gen: number, parts: { items?: boolean; links?: boolean }) => {
      try {
        const [items, links] = await Promise.all([
          parts.items ? workspaceItemList(pid) : Promise.resolve(null),
          parts.links ? workspaceTaskLinkList(pid) : Promise.resolve(null),
        ]);
        if (!isCurrent(gen, pid)) return;
        setState((s) => {
          if (s.projectId !== pid) return s;
          return {
            ...s,
            items: items ? items.items : s.items,
            links: links ? links.links : s.links,
          };
        });
      } catch (e) {
        if (!isCurrent(gen, pid)) return;
        setState((s) => (s.projectId === pid ? { ...s, error: errorMessage(e) } : s));
      }
    },
    [isCurrent],
  );

  /** 写操作统一入口：目标项目/代次在调用瞬间捕获，之后切换不会改写新项目。 */
  const runWrite = useCallback(
    async (
      label: string,
      pid: string,
      gen: number,
      fn: () => Promise<unknown>,
      refresh: { items?: boolean; links?: boolean },
    ): Promise<WorkspaceActionResult> => {
      if (!isCurrent(gen, pid)) return "stale";
      try {
        await fn();
      } catch (e) {
        if (!isCurrent(gen, pid)) {
          // 写入本身可能已落库：如实提示「结果未回显」，绝不假装成功
          setLastStaleNotice(`${label}已在原项目执行，当前项目界面不更新`);
          return "stale";
        }
        setState((s) => (s.projectId === pid ? { ...s, error: errorMessage(e) } : s));
        return "failed";
      }
      if (!isCurrent(gen, pid)) {
        setLastStaleNotice(`${label}已写入原项目；已切换到其他项目，结果不再回显`);
        return "stale";
      }
      await commitRefresh(pid, gen, refresh);
      return "ok";
    },
    [commitRefresh, isCurrent],
  );

  const snapshot = useCallback(() => {
    const pid = projectRef.current;
    const gen = genRef.current;
    return { pid, gen };
  }, []);

  const reload = useCallback(async () => {
    const { pid, gen } = snapshot();
    if (!pid) return;
    setState((s) => (s.projectId === pid ? { ...s, status: "loading", error: null } : s));
    await loadInto(pid, gen);
  }, [loadInto, snapshot]);

  const saveModule = useCallback(
    async (module: WorkspaceModuleId): Promise<WorkspaceActionResult> => {
      const { pid, gen } = snapshot();
      if (!pid) return "stale";

      const run = async (): Promise<WorkspaceActionResult> => {
        // 只使用**该项目自己**的布局。项目切换那一帧 stateRef 可能还是旧项目：
        // 此时重新读服务端实例，绝不把 A 的布局写进 B。
        let layoutJson =
          stateRef.current.projectId === pid ? stateRef.current.instance?.layoutJson : null;
        if (layoutJson === null) {
          try {
            const fetched = await workspaceInstanceGet(pid);
            if (!isCurrent(gen, pid)) return "stale";
            layoutJson = fetched.instance.layoutJson;
            setState((s) => (s.projectId === pid ? { ...s, instance: fetched.instance } : s));
          } catch (e) {
            if (!isCurrent(gen, pid)) return "stale";
            setState((s) => (s.projectId === pid ? { ...s, error: errorMessage(e) } : s));
            return "failed";
          }
        }
        const layout = parseWorkspaceLayout(layoutJson, profileRef.current).layout;
        const next = withActiveModule(layout, module);
        return runWrite(
          "模块切换",
          pid,
          gen,
          async () => {
            const saved = await workspaceInstanceSave({
              projectId: pid,
              activeModule: module,
              // 保留既有布局：只替换 activeModule，不再传 "{}"
              layoutJson: JSON.stringify(next),
            });
            if (!isCurrent(gen, pid)) return;
            setState((s) => (s.projectId === pid ? { ...s, instance: saved.instance } : s));
          },
          {},
        );
      };

      // 串行执行：连续点击 A→B 时后一次读到前一次落库的布局，最终 activeModule
      // 是用户最后一次选择，且 moduleOrder/hiddenModules 不会被旧值覆盖。
      const queued = moduleSaveChainRef.current.then(run, run);
      moduleSaveChainRef.current = queued.then(
        () => undefined,
        () => undefined,
      );
      return queued;
    },
    [isCurrent, runWrite, snapshot],
  );

  const addItem = useCallback(
    async (input: { title: string; stage: string }): Promise<WorkspaceActionResult> => {
      const { pid, gen } = snapshot();
      const title = input.title.trim();
      if (!pid || !title) return "stale";
      // 新事项排在当前项目已有事项之后；切换瞬间不拿别的项目的长度。
      const sortOrder = stateRef.current.projectId === pid ? stateRef.current.items.length : 0;
      return runWrite(
        "添加事项",
        pid,
        gen,
        async () => {
          await workspaceItemSave({
            id: null,
            projectId: pid,
            parentId: null,
            title,
            stage: input.stage.trim() || null,
            status: "todo",
            sortOrder,
            metadataJson: "{}",
          });
        },
        { items: true },
      );
    },
    [runWrite, snapshot],
  );

  const cycleItemStatus = useCallback(
    async (item: WorkspaceItem): Promise<WorkspaceActionResult> => {
      const { pid, gen } = snapshot();
      // 归属校验：切换瞬间的残留点击不得把 A 的事项写到 B
      if (!pid || item.projectId !== pid) return "stale";
      const idx = ITEM_STATUSES.indexOf(item.status);
      const next = ITEM_STATUSES[(idx + 1) % ITEM_STATUSES.length];
      return runWrite(
        "修改事项状态",
        pid,
        gen,
        async () => {
          await workspaceItemSave({
            id: item.id,
            projectId: pid,
            parentId: item.parentId,
            title: item.title,
            stage: item.stage || null,
            status: next,
            sortOrder: item.sortOrder,
            metadataJson: item.metadataJson,
          });
        },
        { items: true },
      );
    },
    [runWrite, snapshot],
  );

  const removeItem = useCallback(
    async (item: WorkspaceItem): Promise<WorkspaceActionResult> => {
      const { pid, gen } = snapshot();
      if (!pid || item.projectId !== pid) return "stale";
      return runWrite("删除事项", pid, gen, () => workspaceItemDelete(item.id), { items: true });
    },
    [runWrite, snapshot],
  );

  const addTaskLink = useCallback(
    async (taskId: string): Promise<WorkspaceActionResult> => {
      const { pid, gen } = snapshot();
      if (!pid || !taskId) return "stale";
      return runWrite("关联任务", pid, gen, () => workspaceTaskLinkAdd(pid, taskId), { links: true });
    },
    [runWrite, snapshot],
  );

  const removeTaskLink = useCallback(
    async (taskId: string): Promise<WorkspaceActionResult> => {
      const { pid, gen } = snapshot();
      if (!pid || !taskId) return "stale";
      return runWrite("取消关联", pid, gen, () => workspaceTaskUnlink(pid, taskId), { links: true });
    },
    [runWrite, snapshot],
  );

  const layoutInfo = useMemo(
    () => parseWorkspaceLayout(state.instance?.layoutJson, profile),
    [state.instance?.layoutJson, profile],
  );

  return {
    projectId: state.projectId,
    status: state.status,
    error: state.error,
    items: state.items,
    links: state.links,
    instance: state.instance,
    layout: layoutInfo.layout,
    layoutRepaired: layoutInfo.repaired,
    reload,
    saveModule,
    addItem,
    cycleItemStatus,
    removeItem,
    addTaskLink,
    removeTaskLink,
    lastStaleNotice,
    clearStaleNotice: () => setLastStaleNotice(null),
  };
}

// ── 开发项目上下文（P1-02 7.3：Git 探测必须用开发项目根目录）──────────────

export type DevContextStatus = "idle" | "loading" | "ready" | "missing" | "error";

export interface WorkspaceDevContext {
  status: DevContextStatus;
  devProject: DevProject | null;
  probe: DevGitInfo | null;
  error: string | null;
  /** 失效原因（未关联 / 登记已删除 / 目录失效 / 非 Git），用于 UI 如实展示。 */
  reason: string | null;
  refresh: () => Promise<void>;
}

/**
 * 按 **dev_projects 登记的 rootPath** 探测 Git：工作空间自己的 rootPath 是
 * 「项目工作目录」，与开发仓库目录是两个概念，不能混用（旧实现直接拿
 * `selected.rootPath` 探测，非 Git 的工作目录会永远显示 not_a_repo）。
 */
export function useWorkspaceDevContext(devProjectId: string | null): WorkspaceDevContext {
  const [state, setState] = useState<{
    status: DevContextStatus;
    devProject: DevProject | null;
    probe: DevGitInfo | null;
    error: string | null;
    reason: string | null;
  }>({ status: "idle", devProject: null, probe: null, error: null, reason: null });
  const genRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(async (id: string | null) => {
    genRef.current += 1;
    const gen = genRef.current;
    const current = () => mountedRef.current && genRef.current === gen;
    if (!id) {
      setState({ status: "idle", devProject: null, probe: null, error: null, reason: null });
      return;
    }
    setState({ status: "loading", devProject: null, probe: null, error: null, reason: null });
    try {
      const list = await devProjectList();
      if (!current()) return;
      const dev = list.projects.find((p) => p.id === id) ?? null;
      if (!dev) {
        setState({
          status: "missing",
          devProject: null,
          probe: null,
          error: null,
          reason: "关联的开发项目已不存在，请在设置页重新关联",
        });
        return;
      }
      if (!dev.exists) {
        setState({
          status: "missing",
          devProject: dev,
          probe: null,
          error: null,
          reason: "开发项目根目录不存在（可能被移动或删除），Git 探测已跳过",
        });
        return;
      }
      const probe = await devProjectProbe(dev.rootPath);
      if (!current()) return;
      setState({ status: "ready", devProject: dev, probe, error: null, reason: null });
    } catch (e) {
      if (!current()) return;
      setState({ status: "error", devProject: null, probe: null, error: errorMessage(e), reason: null });
    }
  }, []);

  useEffect(() => {
    void load(devProjectId);
  }, [devProjectId, load]);

  return {
    ...state,
    refresh: () => load(devProjectId),
  };
}

// ── 任务选择（P1-02 7.2：待办 + 已完成、按需搜索、有界分页）───────────────

export const TASK_PICKER_PAGE_SIZE = 40;
export const TASK_PICKER_MAX_LIMIT = 200;
const TASK_SEARCH_DEBOUNCE_MS = 220;

export type TaskPickerStatus = "all" | "pending" | "completed";

export interface TaskPickerState {
  tasks: Task[];
  loading: boolean;
  error: string | null;
  query: string;
  setQuery: (q: string) => void;
  status: TaskPickerStatus;
  setStatus: (s: TaskPickerStatus) => void;
  limit: number;
  /** 本页之后服务端是否可能还有数据（按**服务端返回条数**判断，不是过滤后的可显示条数）。 */
  canLoadMore: boolean;
  /** 已经到达 200 条查询窗口上限：只能靠搜索缩小范围，必须明确告知用户。 */
  atWindowLimit: boolean;
  loadMore: () => void;
  reload: () => void;
}

/**
 * 「可关联任务」选择器：默认只取 40 条，搜索/加载更多按需扩大（后端上限 200）。
 *
 * 不一次拉全量历史：`list_tasks` 支持 status/search/limit，本 hook 只消费这三个
 * 参数；切换查询或状态时重置窗口，避免把旧查询的结果混进新查询。
 */
export function useWorkspaceTaskPicker(enabled: boolean, linkedIds: string[]): TaskPickerState {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [status, setStatus] = useState<TaskPickerStatus>("all");
  const [limit, setLimit] = useState(TASK_PICKER_PAGE_SIZE);
  const [tasks, setTasks] = useState<Task[]>([]);
  /** 服务端**过滤前**返回的条数：canLoadMore 的唯一依据。 */
  const [serverCount, setServerCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const genRef = useRef(0);

  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(query.trim()), TASK_SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [query]);

  // 新查询/新状态：重置分页窗口
  useEffect(() => {
    setLimit(TASK_PICKER_PAGE_SIZE);
  }, [debounced, status]);

  const linkedKey = linkedIds.join(",");

  useEffect(() => {
    if (!enabled) return;
    genRef.current += 1;
    const gen = genRef.current;
    let cancelled = false;
    setLoading(true);
    setError(null);
    // 在途期间旧的计数不再可信：先清零，避免用上一页/上一查询的条数判断加载更多。
    setServerCount(0);
    void listTasks({
      status,
      search: debounced || undefined,
      limit,
      sort: "created",
    })
      .then((list) => {
        if (cancelled || genRef.current !== gen) return;
        // 服务端窗口条数（过滤已关联之前）：40 条里已关联 39 条，仍可能有下一页。
        setServerCount(list.length);
        const linked = new Set(linkedKey ? linkedKey.split(",") : []);
        setTasks(list.filter((t) => !linked.has(t.id)));
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled || genRef.current !== gen) return;
        setTasks([]);
        setServerCount(0);
        setError(errorMessage(e));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, debounced, status, limit, linkedKey, tick]);

  // 只有「服务端返回满一页」才可能还有下一页；用可显示条数会让「本页大部分已关联」
  // 误判为没有更多（P1-B 根因）。200 是后端 list_tasks 的硬上限。
  const canLoadMore = serverCount >= limit && limit < TASK_PICKER_MAX_LIMIT;
  const atWindowLimit = limit >= TASK_PICKER_MAX_LIMIT && serverCount >= TASK_PICKER_MAX_LIMIT;

  return {
    tasks,
    loading,
    error,
    query,
    setQuery,
    status,
    setStatus,
    limit,
    canLoadMore,
    atWindowLimit,
    loadMore: () => setLimit((l) => Math.min(TASK_PICKER_MAX_LIMIT, l + TASK_PICKER_PAGE_SIZE)),
    reload: () => setTick((t) => t + 1),
  };
}
