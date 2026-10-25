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

export const useTasksStore = create<{
  tasks: Task[];
  /** 全局统计（跨所有筛选视图，极简模式/徽标/概览用） */
  stats: TaskStats | null;
  filter: TaskFilter;
  loading: boolean;
  setFilter: (f: TaskFilter) => void;
  load: (filter?: TaskFilter) => Promise<void>;
  loadStats: () => Promise<void>;
  /** 刷新列表 + 统计（事件通知、跨页面联动用） */
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
  refresh: async () => {
    await Promise.all([get().load(), get().loadStats()]);
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
