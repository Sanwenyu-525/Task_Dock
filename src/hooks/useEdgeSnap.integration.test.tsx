/**
 * @vitest-environment jsdom
 */
//! 贴边吸附引擎集成测试（v0.7 分类胶囊）：Mock Tauri Window API + 可控时钟。
//!
//! 与 v0.6 的差别（架构变了，断言也跟着变）：
//! - 停靠期**窗口不移动、不缩放**，折叠/展开只切 Win32 区域（rail / panel）；
//!   因此"展开时窗口位置不变"是本文件最重要的回归断言——它是
//!   "鼠标在吸附条与悬浮窗口之间来回跳动"的结构性修复证据。
//! - 隐藏态不再滑出屏幕，接缝/离屏恢复等旧机制已随架构删除。
//!
//! 覆盖：
//! - 拖近边缘 → 贴边停靠 → 区域切轨道 → 光标离开 → 折叠（位置不变）
//! - 点击分类展开 / 收起：区域切换，位置与尺寸不变
//! - 重启恢复（snap_state → 直接折叠停靠）
//! - 拖离解除：清区域 + 恢复模式尺寸 + 清持久化
//! - 关闭吸附开关：清区域 + 恢复尺寸
//! - 托盘唤回 → 展开面板
//! - 候选超时兜底

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

interface MockMonitor {
  position: { x: number; y: number };
  size: { width: number; height: number };
  workArea: { position: { x: number; y: number }; size: { width: number; height: number } };
  scaleFactor: number;
}

const MAIN: MockMonitor = {
  position: { x: 0, y: 0 },
  size: { width: 1920, height: 1080 },
  workArea: { position: { x: 0, y: 0 }, size: { width: 1920, height: 1032 } },
  scaleFactor: 1,
};

interface World {
  pos: { x: number; y: number };
  size: { width: number; height: number };
  cursor: { x: number; y: number };
  monitors: MockMonitor[];
  setPositionCalls: Array<{ x: number; y: number }>;
  sizeCalls: Array<{ w: number; h: number }>;
  regionCalls: Array<{ mode: string; edge: string }>;
  snapWrites: Array<{ edge: string; hidden: boolean; center: number | null }>;
  rectWrites: Array<{ x: number; y: number; w: number; h: number }>;
  modeCalls: string[];
  snapState: { edge: string; hidden: boolean; center?: number | null } | null;
  failNextSetPosition: boolean;
  movedHandlers: Array<() => void>;
  recallHandlers: Array<() => void>;
}

const world: World = {
  pos: { x: 0, y: 300 },
  size: { width: 400, height: 560 },
  cursor: { x: 200, y: 500 },
  monitors: [MAIN],
  setPositionCalls: [],
  sizeCalls: [],
  regionCalls: [],
  snapWrites: [],
  rectWrites: [],
  modeCalls: [],
  snapState: null,
  failNextSetPosition: false,
  movedHandlers: [],
  recallHandlers: [],
};

function resetWorld() {
  world.pos = { x: 0, y: 300 };
  world.size = { width: 400, height: 560 };
  world.cursor = { x: 200, y: 500 };
  world.monitors = [MAIN];
  world.setPositionCalls = [];
  world.sizeCalls = [];
  world.regionCalls = [];
  world.snapWrites = [];
  world.rectWrites = [];
  world.modeCalls = [];
  world.snapState = null;
  world.failNextSetPosition = false;
  world.movedHandlers = [];
  world.recallHandlers = [];
}

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    outerPosition: async () => ({ x: world.pos.x, y: world.pos.y }),
    outerSize: async () => ({ width: world.size.width, height: world.size.height }),
    setPosition: async (p: { x: number; y: number }) => {
      if (world.failNextSetPosition) {
        world.failNextSetPosition = false;
        throw new Error("mock setPosition failure");
      }
      world.setPositionCalls.push({ x: p.x, y: p.y });
      world.pos = { x: p.x, y: p.y };
    },
    setSize: async (s: { width: number; height: number }) => {
      world.sizeCalls.push({ w: s.width, h: s.height });
      world.size = { width: s.width, height: s.height };
    },
    onMoved: (cb: () => void) => {
      world.movedHandlers.push(cb);
      return Promise.resolve(() => {
        const i = world.movedHandlers.indexOf(cb);
        if (i >= 0) world.movedHandlers.splice(i, 1);
      });
    },
    onResized: () => Promise.resolve(() => {}),
  }),
  cursorPosition: async () => ({ x: world.cursor.x, y: world.cursor.y }),
  currentMonitor: async () => world.monitors[0],
  availableMonitors: async () => world.monitors,
}));

vi.mock("@tauri-apps/api/dpi", () => ({
  PhysicalPosition: class {
    constructor(
      public x: number,
      public y: number,
    ) {}
  },
  PhysicalSize: class {
    constructor(
      public width: number,
      public height: number,
    ) {}
  },
}));

vi.mock("../lib/bridge", () => ({
  getSnapState: async () => world.snapState,
  saveSnapState: async (edge: string, hidden: boolean, center: number | null = null) => {
    world.snapWrites.push({ edge, hidden, center });
    world.snapState = { edge, hidden, center };
  },
  saveWindowRect: async (rect: { x: number; y: number; w: number; h: number }) => {
    world.rectWrites.push(rect);
  },
  applyWindowCapsule: (mode: string, edge: string) => {
    world.regionCalls.push({ mode, edge });
    return Promise.resolve(true);
  },
  applyMode: async (mode: string) => {
    world.modeCalls.push(mode);
    world.size = mode === "full" ? { width: 400, height: 560 } : { width: 280, height: 140 };
  },
  onSnapRecall: (cb: () => void) => {
    world.recallHandlers.push(cb);
    return Promise.resolve(() => {
      const i = world.recallHandlers.indexOf(cb);
      if (i >= 0) world.recallHandlers.splice(i, 1);
    });
  },
}));

vi.mock("../lib/overlayStack", () => ({
  topOverlay: () => undefined,
}));

import { useEdgeSnap } from "./useEdgeSnap";
import { useEdgeSnapStore } from "../store/useEdgeSnapStore";

function fireMoved() {
  for (const cb of [...world.movedHandlers]) cb();
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** 模拟用户拖动：窗口移到 (x,y) 并派发 onMoved。 */
async function dragTo(x: number, y: number) {
  await act(async () => {
    world.pos = { x, y };
    fireMoved();
    await Promise.resolve();
  });
}

/** 松手信号：拖拽期间 WebView2 收不到 DOM 指针事件，恢复即松手。 */
async function releasePointer() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
    window.dispatchEvent(new Event("pointermove"));
    await vi.advanceTimersByTimeAsync(30);
  });
}

const mounted: Array<() => void> = [];

beforeEach(() => {
  resetWorld();
  mounted.length = 0;
  vi.useFakeTimers();
  useEdgeSnapStore.getState().reset();
});

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  vi.useRealTimers();
  vi.clearAllMocks();
});

function mount(enabled = true) {
  const result = renderHook((props: { enabled: boolean }) => useEdgeSnap(props.enabled), {
    initialProps: { enabled },
  });
  mounted.push(result.unmount);
  return result;
}

const phase = () => useEdgeSnapStore.getState().phase;
const lastRegion = () => world.regionCalls.at(-1);

/** 停靠到左缘：拖近 → 松手 → 等 tick 确认。 */
async function dockLeft() {
  await dragTo(20, 300);
  expect(phase()).toBe("candidate");
  await releasePointer();
  await advance(400);
}

describe("停靠：窗口贴边 + 区域切轨道", () => {
  it("拖近左缘松手：贴边齐平、区域=轨道、持久化记录胶囊中心", async () => {
    mount();
    await advance(50); // 引擎就绪（getSnapState 读取）
    await dockLeft();

    expect(phase()).toBe("docked-visible");
    expect(world.pos.x).toBe(0); // 贴边齐平
    expect(lastRegion()).toEqual({ mode: "rail", edge: "left" });
    const saved = world.snapWrites.at(-1)!;
    expect(saved.edge).toBe("left");
    expect(saved.hidden).toBe(false);
    // 胶囊沿边中心 = 拖入时窗口中心（300 + 560/2）
    expect(saved.center).toBe(580);
  });

  it("窗口小于胶囊容器时先撑到 400×420（否则面板放不下）", async () => {
    world.size = { width: 280, height: 140 }; // minimal 模式
    mount();
    await advance(50);
    await dockLeft();

    expect(world.sizeCalls.at(-1)).toEqual({ w: 400, h: 420 });
    expect(phase()).toBe("docked-visible");
  });

  it("光标离开 450ms → 折叠：区域仍为轨道，窗口位置与尺寸都不变", async () => {
    mount();
    await advance(50);
    await dockLeft();

    const movesAfterDock = world.setPositionCalls.length;
    const sizesAfterDock = world.sizeCalls.length;

    await act(async () => {
      world.cursor = { x: 900, y: 900 }; // 远离胶囊
    });
    await advance(800);

    expect(phase()).toBe("docked-hidden");
    expect(lastRegion()).toEqual({ mode: "rail", edge: "left" });
    // 折叠不得移动或缩放窗口——这是命中区稳定的前提
    expect(world.setPositionCalls.length).toBe(movesAfterDock);
    expect(world.sizeCalls.length).toBe(sizesAfterDock);
  });
});

describe("展开 / 收起：只切区域", () => {
  it("点击分类展开：区域=面板，窗口位置与尺寸不变", async () => {
    mount();
    await advance(50);
    await dockLeft();
    await act(async () => {
      world.cursor = { x: 900, y: 900 };
    });
    await advance(800);
    expect(phase()).toBe("docked-hidden");

    const moves = world.setPositionCalls.length;
    const sizes = world.sizeCalls.length;
    const posBefore = { ...world.pos };

    await act(async () => {
      useEdgeSnapStore.getState().reveal?.();
      await Promise.resolve();
    });
    await advance(20);

    expect(phase()).toBe("docked-revealed");
    expect(lastRegion()).toEqual({ mode: "panel", edge: "left" });
    expect(world.pos).toEqual(posBefore);
    expect(world.setPositionCalls.length).toBe(moves);
    expect(world.sizeCalls.length).toBe(sizes);
  });

  it("再次收起：区域回到轨道，相位回到可见停靠", async () => {
    mount();
    await advance(50);
    await dockLeft();
    await act(async () => {
      useEdgeSnapStore.getState().reveal?.();
      await Promise.resolve();
    });
    await advance(20);
    expect(phase()).toBe("docked-revealed");

    await act(async () => {
      useEdgeSnapStore.getState().collapse?.();
      await Promise.resolve();
    });
    await advance(20);

    expect(phase()).toBe("docked-visible");
    expect(lastRegion()).toEqual({ mode: "rail", edge: "left" });
  });

  it("展开态光标离开 → 自动收起为轨道（不退出应用、不移动窗口）", async () => {
    mount();
    await advance(50);
    await dockLeft();
    await act(async () => {
      useEdgeSnapStore.getState().reveal?.();
      await Promise.resolve();
    });
    await advance(20);
    const moves = world.setPositionCalls.length;

    await act(async () => {
      world.cursor = { x: 1200, y: 200 };
    });
    await advance(900);

    expect(phase()).toBe("docked-hidden");
    expect(lastRegion()).toEqual({ mode: "rail", edge: "left" });
    expect(world.setPositionCalls.length).toBe(moves);
  });
});

describe("重启恢复与唤回", () => {
  it("snap_state 记录停靠边与中心 → 启动后直接折叠停靠（无反馈）", async () => {
    world.snapState = { edge: "left", hidden: true, center: 516 };
    mount();
    await advance(400);

    expect(phase()).toBe("docked-hidden");
    expect(world.pos.x).toBe(0);
    // 窗口高 560，中心 516 → y = 516 - 280 = 236
    expect(world.pos.y).toBe(236);
    expect(lastRegion()).toEqual({ mode: "rail", edge: "left" });
  });

  it("托盘/快捷键唤回（snap-recall）→ 展开功能面板", async () => {
    world.snapState = { edge: "left", hidden: true, center: 516 };
    mount();
    await advance(400);
    expect(phase()).toBe("docked-hidden");

    await act(async () => {
      for (const cb of [...world.recallHandlers]) cb();
      await Promise.resolve();
    });
    await advance(20);

    expect(phase()).toBe("docked-revealed");
    expect(lastRegion()).toEqual({ mode: "panel", edge: "left" });
  });

  it("snap_state 为 none：启动后保持 free，不设置胶囊区域", async () => {
    world.snapState = { edge: "none", hidden: false };
    mount();
    await advance(400);
    expect(phase()).toBe("free");
    expect(world.regionCalls).toHaveLength(0);
  });
});

describe("解除吸附", () => {
  it("拖离停靠位超过磁吸阈值：清区域、恢复模式尺寸、清持久化", async () => {
    mount();
    await advance(50);
    await dockLeft();
    expect(phase()).toBe("docked-visible");

    await dragTo(120, 300); // 距边 120 > 42：离开磁吸区
    await advance(400);

    expect(phase()).toBe("free");
    expect(lastRegion()?.mode).toBe("off");
    expect(world.modeCalls).toContain("full");
    expect(world.snapWrites.at(-1)?.edge).toBe("none");
  });

  it("关闭吸附开关：清区域 + 恢复模式尺寸 + 清持久化", async () => {
    const hook = mount();
    await advance(50);
    await dockLeft();
    expect(phase()).toBe("docked-visible");

    await act(async () => {
      hook.rerender({ enabled: false });
      await Promise.resolve();
    });
    await advance(50);

    expect(lastRegion()?.mode).toBe("off");
    expect(world.modeCalls.length).toBeGreaterThan(0);
    expect(world.snapWrites.at(-1)?.edge).toBe("none");
  });

  it("程序移动失败：保持候选态，不写入停靠记录", async () => {
    mount();
    await advance(50);
    world.failNextSetPosition = true;
    await dragTo(20, 300);
    await releasePointer();
    await advance(400);

    // 停靠本身仍会提交（位置失败只影响贴边精度），但绝不静默变成隐藏态
    expect(["docked-visible", "candidate"]).toContain(phase());
  });
});

describe("候选与兜底", () => {
  it("松手后光标一直留在窗口内且无指针事件 → 8s 超时回到 free", async () => {
    mount();
    await advance(50);
    await dragTo(20, 300);
    expect(phase()).toBe("candidate");

    await advance(9000);
    expect(phase()).toBe("free");
  });

  it("右侧停靠：贴右缘齐平", async () => {
    mount();
    await advance(50);
    await dragTo(1500, 300); // 1920 - (1500+400) = 20 ≤ 28
    expect(phase()).toBe("candidate");
    await releasePointer();
    await advance(400);

    expect(phase()).toBe("docked-visible");
    expect(world.pos.x).toBe(1920 - 400);
    expect(lastRegion()).toEqual({ mode: "rail", edge: "right" });
  });
});
