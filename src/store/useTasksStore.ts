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
import { startOperation } from "../lib/diagnostics";

/** 轻量列表的在途请求代际：只认最后一次，旧响应不覆盖新列表 */
let liteSeq = 0;

/** 主列表的在途请求代际：旧筛选/旧搜索的响应（含错误）不得覆盖新视图 */
let loadSeq = 0;

/**
 * 同一任务的完成切换单飞：双击/键盘连按在第一个请求返回前不再叠加第二次
 * `toggle_task`。失败时条目立即移除，允许用户重试；不同任务互不影响。
 * 这里放在 store 而不是各组件，胶囊、主列表与通知动作共用同一份在途状态。
 */
interface ToggleFlight {
  promise: Promise<Task>;
  /** 任一调用方要求刷新列表即刷新（主列表会传 refresh:false 自己收尾） */
  wantsRefresh: boolean;
}
const toggleFlights = new Map<string, ToggleFlight>();

/**
 * 视图身份：离场、焦点交接、快照等跨异步边界的行为只比较语义筛选，
 * 不比较对象引用——A→B→A 会生成新对象但仍是同一个视图。
 */
export function taskViewKey(f: TaskFilter): string {
  return JSON.stringify([
    f.view ?? "all",
    f.status ?? "all",
    f.category ?? "",
    f.tag ?? "",
    f.priority ?? "",
    (f.search ?? "").trim(),
    f.sort ?? "due",
    f.limit ?? "",
  ]);
}

/**
 * 轻量列表的查询范围：与面板分段一一对应。
 * 每个范围都由后端**先按真实条件过滤、排序，再 LIMIT**，
 * 今日/日程不再从「前 12 条 pending」里本地筛选，避免被逾期/无期限任务截断。
 */
export type TaskLiteScope = "all" | "pending" | "today" | "scheduled" | "overdue" | "completed";

/**
 * 每个范围对应的真实查询（全部复用 list_tasks，不另建 SQL）：
 * - all       最近创建的真实任务（含已完成）
 * - pending   未完成
 * - today     本地今天到期且未完成（后端 view=due_today）
 * - scheduled 有截止时间且未完成（后端 view=scheduled，只看 due_at；sort=scheduled
 *   让未逾期/未来任务排在逾期之前，避免积压的逾期任务占满 12 条把今天与未来挡住）
 * - overdue   已逾期且未完成（后端 view=overdue，due_at < now）
 * - completed 已完成，按完成时间倒序
 * limit:12 与面板实际展示量一致（后端 clamp 1..=200）。
 */
const LITE_QUERY: Record<TaskLiteScope, TaskFilter> = {
  all: { view: "all", status: "all", sort: "created", limit: 12 },
  pending: { view: "all", status: "pending", sort: "due", limit: 12 },
  today: { view: "due_today", status: "pending", sort: "due", limit: 12 },
  scheduled: { view: "scheduled", status: "pending", sort: "scheduled", limit: 12 },
  overdue: { view: "overdue", status: "pending", sort: "due", limit: 12 },
  completed: { view: "all", status: "completed", sort: "completed", limit: 12 },
};

/**
 * 离场快照：任务完成后该行要退出当前筛选，动画期间整表刷新可能把它抽走。
 * 面板按原索引把这一行补渲染到动画结束，结束后释放；不写回 `tasks`，
 * 也不参与分页/排序，后台刷新返回的真实列表始终是唯一数据源。
 */
export interface TaskExitHold {
  task: Task;
  index: number;
  /** 点击时紧随其后的非离场任务；刷新后据此保持前后顺序 */
  beforeId: string | null;
  /** 离场动画的起始高度（只在离场开始时量一次） */
  height: number;
  /**
   * 登记序号。同一任务可能因重复点击/撤销后再次完成而先后登记两次，
   * 先开始的动画结束时只能释放自己那一次，不能把新的离场快照一起删掉。
   */
  token: number;
}

let exitHoldToken = 0;

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
  /** 当前 `lite` 数据对应的搜索词（成功写入后才更新；"" = 未按搜索过滤）。 */
  liteSearch: string;
  /** 最近一次请求的目标搜索词（可能在途或失败），与 liteSearch 分开防「切回即空白」。 */
  liteSearchTarget: string;
  liteLoading: boolean;
  /** 轻量列表最近一次查询的错误；null = 无错误。失败时旧 lite 原样保留 */
  liteError: string | null;
  /**
   * 读一次轻量列表（可按分段指定范围与搜索词；force 用于写入后的强制刷新）。
   * 同范围+同搜索词的在途请求合并为一次；搜索词变化不被合并，立即发新请求。
   */
  loadLite: (
    scope?: TaskLiteScope,
    opts?: { force?: boolean; search?: string },
  ) => Promise<void>;
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
  /**
   * 切换完成状态。`refresh: false` 让调用方把列表刷新推迟到离场动画结束——
   * 后端写入立即提交，只有「何时同步列表」被延后，不能反过来推迟写入。
   */
  toggle: (id: string, opts?: { refresh?: boolean }) => Promise<Task>;
  remove: (id: string) => Promise<void>;
  /** 离场动画期间的补渲染快照（不进入 `tasks`） */
  exitHolds: TaskExitHold[];
  /** 登记离场快照并返回本次登记的序号，供释放时精确匹配。 */
  holdForExit: (task: Task, index: number, beforeId: string | null, height: number) => number;
  releaseExitHold: (id: string, token: number) => void;
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
  liteSearch: "",
  liteSearchTarget: "",
  liteLoading: false,
  liteError: null,
  exitHolds: [],
  setFilter: (f) => {
    // 视图变了：旧视图的离场快照不再属于新列表，立即清掉（定时器由组件自行回收）
    set({ filter: { ...get().filter, ...f }, exitHolds: [] });
    // 失败落在 store.error，由任务面板内联展示；这里不让 Promise 逃逸
    void get().load().catch(() => {});
  },
  load: async (filter) => {
    const f = filter ?? get().filter;
    const seq = ++loadSeq;
    set({ loading: true });
    try {
      const tasks = await listTasks(f);
      // 期间用户切了筛选/搜索/排序：这次响应属于过期视图，只丢弃不回写
      if (seq !== loadSeq) return;
      set({ tasks, filter: f, loading: false, error: null });
    } catch (e) {
      // 旧视图的失败同样过期：不能覆盖新视图已成功的结果与错误状态
      if (seq !== loadSeq) return;
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
    const search = (opts?.search ?? get().liteSearchTarget) || "";
    // 同范围+同搜索词请求在途时合并为一次：快速重复点击分段不叠加 IPC。
    // 搜索词变化（或范围变化）不被合并；写入后的 refresh 传 force，
    // 确保拿到落库后的新结果。
    if (
      !opts?.force &&
      get().liteLoading &&
      target === get().liteTarget &&
      search === get().liteSearchTarget
    ) {
      return;
    }
    const seq = ++liteSeq;
    set({ liteLoading: true, liteTarget: target, liteSearchTarget: search });
    try {
      const query = LITE_QUERY[target];
      const lite = await listTasks(search ? { ...query, search } : query);
      if (seq !== liteSeq) return; // 已有更新的请求，丢弃这次响应
      set({
        lite,
        liteScope: target,
        liteSearch: search,
        liteLoading: false,
        liteError: null,
      });
    } catch (e) {
      if (seq !== liteSeq) return;
      // 失败不清除已成功数据：有旧列表则保留展示并由面板叠加错误提示，
      // 没有旧列表（lite === null）时面板显示错误空态。两者都可重试，
      // 绝不把失败伪装成「暂无任务」。liteScope/liteSearch 保持旧值，
      // 面板据范围不一致停用旧数据的空态判断。
      set({ liteLoading: false, liteError: errorMessage(e) });
    }
  },
  releaseLite: () => {
    liteSeq += 1; // 卸载后回来的响应一律作废
    set({
      lite: null,
      liteScope: "all",
      liteTarget: "all",
      liteSearch: "",
      liteSearchTarget: "",
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
    // 一次用户保存 = 一个 operation_id；参数只记录阶段，不记录标题/正文。
    const op = startOperation("task", "create_task");
    try {
      op.stage("persist");
      const t = await createTask(input);
      op.success();
      await get().refresh();
      return t;
    } catch (e) {
      op.fail(e);
      throw e;
    }
  },
  quickCreate: async (text, dueAt, recurrence, advanceMinutes) => {
    const t = await createFromQuickAdd(text, dueAt, recurrence, advanceMinutes);
    await get().refresh();
    return t;
  },
  update: async (id, input) => {
    const op = startOperation("task", "update_task");
    try {
      op.stage("persist");
      const t = await updateTask(id, input);
      op.success();
      await get().refresh();
      return t;
    } catch (e) {
      op.fail(e);
      throw e;
    }
  },
  toggle: async (id, opts) => {
    // 同一任务已有在途切换：复用同一个结果，不叠加第二次状态翻转。
    const inflight = toggleFlights.get(id);
    if (inflight) {
      if (opts?.refresh !== false) inflight.wantsRefresh = true;
      return inflight.promise;
    }
    const flight = { wantsRefresh: opts?.refresh !== false } as ToggleFlight;
    const run = (async () => {
      const t = await toggleTask(id);
      // 离场动画由调用方负责收尾：写入已经落库，这里只把「同步列表」交还给它。
      // 若并发的另一个调用方要求刷新，则按更强的那次要求执行一次。
      if (flight.wantsRefresh) await get().refresh();
      return t;
    })();
    flight.promise = run;
    toggleFlights.set(id, flight);
    // 成功或失败都释放单飞条目：失败后用户可以直接重试。
    const clear = () => {
      if (toggleFlights.get(id) === flight) toggleFlights.delete(id);
    };
    run.then(clear, clear);
    return run;
  },
  remove: async (id) => {
    await deleteTask(id);
    await get().refresh();
  },
  holdForExit: (task, index, beforeId, height) => {
    const token = (exitHoldToken += 1);
    set((s) => ({
      exitHolds: [
        ...s.exitHolds.filter((h) => h.task.id !== task.id),
        { task, index: Math.max(0, index), beforeId, height, token },
      ],
    }));
    return token;
  },
  releaseExitHold: (id, token) =>
    set((s) =>
      s.exitHolds.some((h) => h.task.id === id && h.token === token)
        ? { exitHolds: s.exitHolds.filter((h) => h.task.id !== id || h.token !== token) }
        : s,
    ),
}));
