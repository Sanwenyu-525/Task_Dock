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

/** 轻量列表的在途请求代际：只认最后一次，旧响应不覆盖新列表 */
let liteSeq = 0;

export const useTasksStore = create<{
  tasks: Task[];
  /** 全局统计（跨所有筛选视图，极简模式/徽标/概览用） */
  stats: TaskStats | null;
  filter: TaskFilter;
  loading: boolean;
  setFilter: (f: TaskFilter) => void;
  load: (filter?: TaskFilter) => Promise<void>;
  loadStats: () => Promise<void>;
  /**
   * 胶囊面板的轻量列表：只有 view=all / status=all 这一份真实结果，
   * 不加载工作区与历史。null = 面板没打开（不多付一次 IPC）。
   * 展示顺序由面板自己算，store 只保留后端顺序。
   */
  lite: Task[] | null;
  liteLoading: boolean;
  /** 读一次轻量列表（胶囊面板挂载时调用） */
  loadLite: () => Promise<void>;
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
  lite: null,
  liteLoading: false,
  setFilter: (f) => {
    set({ filter: { ...get().filter, ...f } });
    get().load();
  },
  load: async (filter) => {
    const f = filter ?? get().filter;
    set({ loading: true });
    try {
      const tasks = await listTasks(f);
      set({ tasks, filter: f, loading: false });
    } catch (e) {
      set({ loading: false });
      throw e;
    }
  },
  loadStats: async () => {
    try {
      const stats = await taskStats();
      set({ stats });
    } catch {
      // 统计失败不打断 UI，保留旧值
    }
  },
  loadLite: async () => {
    const seq = ++liteSeq;
    set({ liteLoading: true });
    try {
      const lite = await listTasks({ view: "all", status: "all", sort: "due" });
      if (seq !== liteSeq) return; // 已有更新的请求，丢弃这次响应
      set({ lite, liteLoading: false });
    } catch {
      if (seq !== liteSeq) return;
      // 失败按空列表处理：显示空态，不拿旧数据冒充当前状态
      set({ lite: [], liteLoading: false });
    }
  },
  releaseLite: () => {
    liteSeq += 1; // 卸载后回来的响应一律作废
    set({ lite: null, liteLoading: false });
  },
  refresh: async () => {
    const jobs: Promise<unknown>[] = [get().load(), get().loadStats()];
    // 只有面板打开过（lite !== null）才多查一次；主窗口日常刷新不多付 IPC
    if (get().lite !== null) jobs.push(get().loadLite());
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
