import { create } from "zustand";
import {
  createFromQuickAdd,
  createTask,
  deleteTask,
  listTasks,
  taskStats,
  toggleTask,
  updateTask,
  type RecurrenceRuleInput,
  type Task,
  type TaskFilter,
  type TaskInput,
  type TaskStats,
} from "../lib/bridge";
import { errorMessage } from "../lib/errors";

/** 轻量列表的在途请求代际：只认最后一次，旧响应不覆盖新列表 */
let liteSeq = 0;

/**
 * 轻量列表的查询范围：与面板分段一一对应。
 * 每个范围都由后端**先按真实条件过滤、排序，再 LIMIT**，
 * 今日/日程不再从「前 12 条 pending」里本地筛选，避免被逾期/无期限任务截断。
 */
export type TaskLiteScope = "all" | "pending" | "today" | "scheduled" | "completed";

/**
 * 每个范围对应的真实查询（全部复用 list_tasks，不另建 SQL）：
 * - all       最近创建的真实任务（含已完成）
 * - pending   未完成
 * - today     本地今天到期且未完成（后端 view=due_today）
 * - scheduled 有截止时间且未完成（后端 view=scheduled，只看 due_at；sort=scheduled
 *   让未逾期/未来任务排在逾期之前，避免积压的逾期任务占满 12 条把今天与未来挡住）
 * - completed 已完成，按完成时间倒序
 * limit:12 与面板实际展示量一致（后端 clamp 1..=200）。
 */
const LITE_QUERY: Record<TaskLiteScope, TaskFilter> = {
  all: { view: "all", status: "all", sort: "created", limit: 12 },
  pending: { view: "all", status: "pending", sort: "due", limit: 12 },
  today: { view: "due_today", status: "pending", sort: "due", limit: 12 },
  scheduled: { view: "scheduled", status: "pending", sort: "scheduled", limit: 12 },
  completed: { view: "all", status: "completed", sort: "completed", limit: 12 },
};

export const useTasksStore = create<{
  tasks: Task[];
  /** 全局统计（跨所有筛选视图，极简模式/徽标/概览用） */
  stats: TaskStats | null;
  filter: TaskFilter;
  loading: boolean;
  /** 列表读取/刷新失败原因；null = 无错误。失败时旧 tasks 原样保留，绝不显示成「暂无任务」 */
  error: string | null;
  /** 统计读取失败原因；失败时不更新 stats，避免伪装成已刷新 */
  statsError: string | null;
  setFilter: (f: TaskFilter) => void;
  load: (filter?: TaskFilter) => Promise<void>;
  loadStats: () => Promise<void>;
  /**
   * 胶囊面板的轻量列表：按 `liteScope` 取回的一小份真实结果，
   * 不加载工作区与历史。null = 面板没打开（不多付一次 IPC）。
   * 展示顺序由面板自己算，store 只保留后端顺序。
   */
  lite: Task[] | null;
  /** 当前 `lite` 数据对应的查询范围（成功写入后才更新） */
  liteScope: TaskLiteScope;
  /**
   * 最近一次请求的目标范围（可能在途或失败）。与 `liteScope` 分开：
   * 面板切回刚离开的分段时要据此重新确认，否则在途响应会把旧范围数据作废，
   * 而面板误以为「已有数据」不再请求，最终停在空白。
   */
  liteTarget: TaskLiteScope;
  liteLoading: boolean;
  /** 轻量列表最近一次查询的错误；null = 无错误。失败时旧 lite 原样保留 */
  liteError: string | null;
  /** 读一次轻量列表（可按分段指定范围；force 用于写入后的强制刷新） */
  loadLite: (scope?: TaskLiteScope, opts?: { force?: boolean }) => Promise<void>;
  /** 面板卸载：作废在途请求并释放轻量列表 */
  releaseLite: () => void;
  /** 刷新列表 + 统计；面板打开时顺带刷新轻量列表 */
  refresh: () => Promise<void>;
  create: (input: TaskInput) => Promise<Task>;
  quickCreate: (
    text: string,
    dueAt: string | null,
    recurrence: RecurrenceRuleInput | null,
    advanceMinutes: number | null,
  ) => Promise<Task>;
  update: (id: string, input: TaskInput) => Promise<Task>;
  toggle: (id: string) => Promise<Task>;
  remove: (id: string) => Promise<void>;
}>((set, get) => ({
  tasks: [],
  stats: null,
  filter: { view: "today", status: "pending", sort: "due" },
  loading: false,
  error: null,
  statsError: null,
  lite: null,
  liteScope: "all",
  liteTarget: "all",
  liteLoading: false,
  liteError: null,
  setFilter: (f) => {
    set({ filter: { ...get().filter, ...f } });
    // 失败落在 store.error，由任务面板内联展示；这里不让 Promise 逃逸
    void get().load().catch(() => {});
  },
  load: async (filter) => {
    const f = filter ?? get().filter;
    set({ loading: true });
    try {
      const tasks = await listTasks(f);
      set({ tasks, filter: f, loading: false, error: null });
    } catch (e) {
      set({ loading: false, error: errorMessage(e) });
      throw e;
    }
  },
  loadStats: async () => {
    try {
      const stats = await taskStats();
      set({ stats, statsError: null });
    } catch (e) {
      // 统计失败不更新旧值也不打断 UI：面板据此显示「统计未刷新」而不是假装成功
      set({ statsError: errorMessage(e) });
    }
  },
  loadLite: async (scope, opts) => {
    const target = scope ?? get().liteTarget;
    // 同范围请求在途时合并为一次：快速重复点击分段不叠加 IPC。
    // 写入后的 refresh 传 force，确保拿到落库后的新结果。
    if (!opts?.force && get().liteLoading && target === get().liteTarget) return;
    const seq = ++liteSeq;
    set({ liteLoading: true, liteTarget: target });
    try {
      const lite = await listTasks(LITE_QUERY[target]);
      if (seq !== liteSeq) return; // 已有更新的请求，丢弃这次响应
      set({ lite, liteScope: target, liteLoading: false, liteError: null });
    } catch (e) {
      if (seq !== liteSeq) return;
      // 失败不清除已成功数据：有旧列表则保留展示并由面板叠加错误提示，
      // 没有旧列表（lite === null）时面板显示错误空态。两者都可重试，
      // 绝不把失败伪装成「暂无任务」。liteScope 保持旧值，面板据范围不一致
      // 停用旧数据的空态判断。
      set({ liteLoading: false, liteError: errorMessage(e) });
    }
  },
  releaseLite: () => {
    liteSeq += 1; // 卸载后回来的响应一律作废
    set({
      lite: null,
      liteScope: "all",
      liteTarget: "all",
      liteLoading: false,
      liteError: null,
    });
  },
  refresh: async () => {
    // 刷新失败由 load() 写入 error 状态并在面板内联展示，不向上抛异常：
    // 否则定时刷新/事件刷新会产生未处理 rejection，且会把「写入成功但刷新失败」误报成写入失败。
    const jobs: Promise<unknown>[] = [get().load().catch(() => {}), get().loadStats()];
    // 只有面板打开过（lite !== null）才多查一次；主窗口日常刷新不多付 IPC。
    // 保持面板当前的分段范围（liteTarget），force 确保写入后拿到新结果；
    // 避免刷新把「已完成」列表换成最近待办，或被在途请求合并成旧数据。
    if (get().lite !== null) jobs.push(get().loadLite(undefined, { force: true }));
    await Promise.all(jobs);
  },
  create: async (input) => {
    const t = await createTask(input);
    await get().refresh();
    return t;
  },
  quickCreate: async (text, dueAt, recurrence, advanceMinutes) => {
    const t = await createFromQuickAdd(text, dueAt, recurrence, advanceMinutes);
    await get().refresh();
    return t;
  },
  update: async (id, input) => {
    const t = await updateTask(id, input);
    await get().refresh();
    return t;
  },
  toggle: async (id) => {
    const t = await toggleTask(id);
    await get().refresh();
    return t;
  },
  remove: async (id) => {
    await deleteTask(id);
    await get().refresh();
  },
}));
