// 全局 Toast 的纯逻辑层：不依赖 React / RN，便于做队列、去重、优先级与计时测试。
// 页面只产生 ToastItem；Provider 维护唯一队列；ToastHost 负责唯一渲染与动画。

export type ToastTone = "info" | "success" | "warn" | "danger";

/** 语义位置：顶部避开标题栏，底部避开安全区/键盘/固定操作区。 */
export type ToastPlacement = "top" | "bottom";

export interface ToastItem {
  id: number;
  text: string;
  tone: ToastTone;
  /** 单条覆盖默认位置；未传时由 Host 使用页面默认位置。 */
  placement?: ToastPlacement;
  /** 来源页 scope；隐藏 Tab 页的晚到消息据此丢弃。 */
  scope?: string;
  /** 阅读时长（ms），由 tone 决定，调用方通常不需要传。 */
  durationMs: number;
  /** 越大越优先：danger 3 / warn 2 / info|success 1。 */
  priority: number;
  createdAt: number;
  /** 同一条消息被重复触发时自增；Host 用它重置计时器，但不重播入场动画。 */
  rev: number;
}

export interface ToastState {
  current: ToastItem | null;
  queue: ToastItem[];
}

export type ToastAction =
  | { type: "enqueue"; item: ToastItem; now?: number }
  | { type: "dismiss"; id: number }
  | { type: "clear" };

/** 自动消失时长：成功更短，错误给足阅读时间。 */
export const TOAST_DURATION_MS: Record<ToastTone, number> = {
  info: 2400,
  success: 2000,
  warn: 3200,
  danger: 4200,
};

/** 同文案同类型的合并窗口：连续点击不会刷屏。 */
export const TOAST_DEDUPE_MS = 1500;

/** 队列上限：只保留最近 4 条待显示，避免无限堆积。 */
export const TOAST_QUEUE_LIMIT = 4;

export function toastPriority(tone: ToastTone): number {
  return tone === "danger" ? 3 : tone === "warn" ? 2 : 1;
}

export function toastDuration(tone: ToastTone): number {
  return TOAST_DURATION_MS[tone];
}

export function createToastState(): ToastState {
  return { current: null, queue: [] };
}

function sameMessage(a: ToastItem, b: Pick<ToastItem, "text" | "tone">): boolean {
  return a.text === b.text && a.tone === b.tone;
}

function recent(item: ToastItem, now: number): boolean {
  return now - item.createdAt <= TOAST_DEDUPE_MS;
}

/** 待显示队列按优先级降序；同优先级保持先进先出。 */
function sortQueue(queue: ToastItem[]): ToastItem[] {
  return queue.slice().sort((a, b) => b.priority - a.priority || a.id - b.id);
}

export function toastReducer(
  state: ToastState,
  action: ToastAction,
  now = Date.now(),
): ToastState {
  switch (action.type) {
    case "enqueue": {
      const incoming = action.item;
      const at = action.now ?? now;
      // 与当前或排队中的同文案同类型合并：当前条只重置计时，排队条只更新时间。
      if (state.current && sameMessage(state.current, incoming) && recent(state.current, at)) {
        return {
          ...state,
          current: {
            ...state.current,
            rev: state.current.rev + 1,
            createdAt: at,
          },
        };
      }
      const queued = state.queue.find((item) => sameMessage(item, incoming) && recent(item, at));
      if (queued) {
        return {
          ...state,
          queue: state.queue.map((item) =>
            item.id === queued.id ? { ...item, rev: item.rev + 1, createdAt: at } : item,
          ),
        };
      }

      // 错误/警告可以抢占当前的低优先级成功提示，避免被成功消息淹没。
      if (state.current && incoming.priority > state.current.priority) {
        return {
          current: incoming,
          queue: sortQueue([...state.queue, state.current]).slice(0, TOAST_QUEUE_LIMIT),
        };
      }
      if (!state.current) {
        return { current: incoming, queue: state.queue };
      }
      return {
        current: state.current,
        queue: sortQueue([...state.queue, incoming]).slice(0, TOAST_QUEUE_LIMIT),
      };
    }
    case "dismiss": {
      if (!state.current || state.current.id !== action.id) return state;
      return {
        current: state.queue[0] ?? null,
        queue: state.queue.slice(1),
      };
    }
    case "clear":
      return createToastState();
    default:
      return state;
  }
}
