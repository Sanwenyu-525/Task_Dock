// 全局 Toast 纯逻辑测试：队列顺序、去重、上限、错误优先级与手动关闭。
import { describe, expect, it } from "vitest";

import {
  TOAST_DEDUPE_MS,
  TOAST_DURATION_MS,
  TOAST_QUEUE_LIMIT,
  createToastState,
  toastReducer,
  type ToastItem,
  type ToastTone,
} from "../toastQueue";

let seq = 0;
function item(
  text: string,
  tone: ToastTone = "info",
  now = 1000,
  extra: Pick<Partial<ToastItem>, "scope" | "placement"> = {},
): ToastItem {
  seq += 1;
  return {
    id: seq,
    text,
    tone,
    placement: extra.placement,
    scope: extra.scope,
    durationMs: TOAST_DURATION_MS[tone],
    priority: tone === "danger" ? 3 : tone === "warn" ? 2 : 1,
    createdAt: now,
    rev: 0,
  };
}

function add(state = createToastState(), next = item("已保存", "success")) {
  return toastReducer(state, { type: "enqueue", item: next, now: next.createdAt });
}

describe("toastQueue", () => {
  it("空队列直接显示第一条，后续按 FIFO 排队", () => {
    const first = item("第一条", "info", 1000);
    const second = item("第二条", "success", 1100);
    let state = add(createToastState(), first);
    expect(state.current?.text).toBe("第一条");
    state = toastReducer(state, { type: "dismiss", id: first.id });
    state = toastReducer(state, { type: "enqueue", item: second, now: 1100 });
    expect(state.current?.text).toBe("第二条");
    expect(state.queue).toHaveLength(0);
  });

  it("同文案同类型在 1.5s 内合并，只重置计时不重播动画", () => {
    const first = item("已保存", "success", 1000, {
      scope: "tab:notes",
      placement: "top",
    });
    let state = add(createToastState(), first);
    state = toastReducer(
      state,
      {
        type: "enqueue",
        item: item("已保存", "success", 1000 + TOAST_DEDUPE_MS - 1, {
          scope: "tab:notes",
          placement: "top",
        }),
        now: 1000 + TOAST_DEDUPE_MS - 1,
      },
    );
    expect(state.queue).toHaveLength(0);
    expect(state.current?.id).toBe(first.id);
    expect(state.current?.rev).toBe(1);
  });

  it("同文案同类型但不同位置不合并：新消息保留自己的底部位置", () => {
    const first = item("已保存", "success", 1000, {
      scope: "tab:notes",
      placement: "top",
    });
    let state = add(createToastState(), first);
    state = toastReducer(state, {
      type: "enqueue",
      item: item("已保存", "success", 1100, {
        scope: "tab:notes",
        placement: "bottom",
      }),
      now: 1100,
    });
    expect(state.current?.placement).toBe("top");
    expect(state.queue).toHaveLength(1);
    expect(state.queue[0].placement).toBe("bottom");

    state = toastReducer(state, { type: "dismiss", id: state.current!.id });
    expect(state.current?.placement).toBe("bottom");
  });

  it("同文案同类型但不同 scope 不合并，队列不串台", () => {
    const first = item("已保存", "success", 1000, {
      scope: "tab:notes",
      placement: "top",
    });
    let state = add(createToastState(), first);
    state = toastReducer(state, {
      type: "enqueue",
      item: item("已保存", "success", 1100, {
        scope: "tab:tasks",
        placement: "top",
      }),
      now: 1100,
    });
    expect(state.current?.scope).toBe("tab:notes");
    expect(state.queue).toHaveLength(1);
    expect(state.queue[0].scope).toBe("tab:tasks");
  });

  it("超过合并窗口的相同文案仍作为新消息排队", () => {
    const first = item("已保存", "success", 1000);
    let state = add(createToastState(), first);
    state = toastReducer(
      state,
      { type: "enqueue", item: item("已保存", "success", 1000 + TOAST_DEDUPE_MS + 1), now: 1000 + TOAST_DEDUPE_MS + 1 },
    );
    expect(state.queue).toHaveLength(1);
    expect(state.current?.id).toBe(first.id);
  });

  it("同文案不同类型不合并：danger 抢占当前 warn", () => {
    let state = add(createToastState(), item("同步失败", "warn", 1000));
    state = toastReducer(state, { type: "enqueue", item: item("同步失败", "danger", 1100), now: 1100 });
    expect(state.current?.tone).toBe("danger");
    expect(state.queue).toHaveLength(1);
    expect(state.queue[0].tone).toBe("warn");
  });

  it("warn 排在 success 前；danger 到来时抢占当前 info", () => {
    let state = add(createToastState(), item("当前", "info", 1000));
    state = toastReducer(state, { type: "enqueue", item: item("成功", "success", 1100), now: 1100 });
    state = toastReducer(state, { type: "enqueue", item: item("警告", "warn", 1200), now: 1200 });
    state = toastReducer(state, { type: "enqueue", item: item("错误", "danger", 1300), now: 1300 });
    expect(state.current?.tone).toBe("danger");
    expect(state.queue.map((entry) => entry.tone)).toEqual(["warn", "info", "success"]);
  });

  it("队列上限为 4，溢出时丢弃低优先级消息", () => {
    let state = add(createToastState(), item("当前", "info", 1000));
    for (let i = 0; i < 6; i += 1) {
      state = toastReducer(state, {
        type: "enqueue",
        item: item(`排队-${i}`, "info", 1100 + i),
        now: 1100 + i,
      });
    }
    expect(state.queue).toHaveLength(TOAST_QUEUE_LIMIT);
    expect(state.current?.text).toBe("当前");
  });

  it("danger 抢占当前的低优先级提示，并保留被抢占消息", () => {
    const info = item("自动保存完成", "success", 1000);
    let state = add(createToastState(), info);
    const danger = item("同步失败", "danger", 1100);
    state = toastReducer(state, { type: "enqueue", item: danger, now: 1100 });
    expect(state.current?.text).toBe("同步失败");
    expect(state.queue.some((entry) => entry.id === info.id)).toBe(true);
  });

  it("手动关闭只接受当前条，旧计时器不能关掉新消息", () => {
    const first = item("第一条", "info", 1000);
    let state = add(createToastState(), first);
    state = toastReducer(state, { type: "enqueue", item: item("第二条", "success", 1100), now: 1100 });
    state = toastReducer(state, { type: "dismiss", id: first.id });
    expect(state.current?.text).toBe("第二条");
    // 旧 id 再次到达时 state 不变
    const before = state;
    state = toastReducer(state, { type: "dismiss", id: first.id });
    expect(state).toBe(before);
  });

  it("连续 dismiss 按 FIFO 推进，直至清空", () => {
    let state = add(createToastState(), item("一", "info", 1000));
    state = toastReducer(state, { type: "enqueue", item: item("二", "info", 1100), now: 1100 });
    state = toastReducer(state, { type: "enqueue", item: item("三", "info", 1200), now: 1200 });
    state = toastReducer(state, { type: "dismiss", id: state.current!.id });
    expect(state.current?.text).toBe("二");
    state = toastReducer(state, { type: "dismiss", id: state.current!.id });
    expect(state.current?.text).toBe("三");
    state = toastReducer(state, { type: "dismiss", id: state.current!.id });
    expect(state.current).toBeNull();
  });

  it("清空会同时清掉当前与排队消息", () => {
    let state = add(createToastState(), item("一", "info", 1000));
    state = toastReducer(state, { type: "enqueue", item: item("二", "danger", 1100), now: 1100 });
    state = toastReducer(state, { type: "clear" });
    expect(state.current).toBeNull();
    expect(state.queue).toHaveLength(0);
  });

  it("切换页面只清排队消息，当前已显示的消息可以播完", () => {
    let state = add(createToastState(), item("正在显示", "info", 1000));
    state = toastReducer(state, { type: "enqueue", item: item("旧页排队", "success", 1100), now: 1100 });
    state = toastReducer(state, { type: "clearQueue" });
    expect(state.current?.text).toBe("正在显示");
    expect(state.queue).toHaveLength(0);
  });

  it("scopeChange 只保留新页面与 global 排队消息，旧页消息不串台", () => {
    let state = add(createToastState(), item("旧页当前", "info", 1000, { scope: "tab:home" }));
    state = toastReducer(state, {
      type: "enqueue",
      item: item("旧页排队", "success", 1100, { scope: "tab:home" }),
      now: 1100,
    });
    state = toastReducer(state, {
      type: "enqueue",
      item: item("新页排队", "success", 1200, { scope: "tab:tasks" }),
      now: 1200,
    });
    state = toastReducer(state, {
      type: "enqueue",
      item: item("全局提示", "info", 1300, { scope: "global" }),
      now: 1300,
    });
    state = toastReducer(state, { type: "scopeChange", scope: "tab:tasks" });
    expect(state.current?.text).toBe("旧页当前");
    expect(state.queue.map((entry) => entry.text)).toEqual(["新页排队", "全局提示"]);
  });

  it("四种 tone 的阅读时长符合产品口径", () => {
    expect(TOAST_DURATION_MS.info).toBe(2400);
    expect(TOAST_DURATION_MS.success).toBe(2000);
    expect(TOAST_DURATION_MS.warn).toBe(3200);
    expect(TOAST_DURATION_MS.danger).toBe(4200);
  });
});
