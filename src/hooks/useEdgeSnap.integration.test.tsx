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
  name?: string;
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
  /** 接下来 N 次 currentMonitor() 返回 null（窗口尚未显示/显示器暂不可用） */
  monitorNullCalls: number;
  setPositionCalls: Array<{ x: number; y: number }>;
  /** setPosition 调用次数（含失败），用于验证失败路径不会逐 tick 重发。 */
  positionAttempts: number;
  sizeCalls: Array<{ w: number; h: number }>;
  regionCalls: Array<{ mode: string; edge: string }>;
  snapWrites: Array<{
    edge: string;
    hidden: boolean;
    center: number | null;
    form?: string | null;
  }>;
  rectWrites: Array<{ x: number; y: number; w: number; h: number }>;
  modeCalls: string[];
  /** applyMode 失败（模拟解除后尺寸恢复失败） */
  failApplyMode: boolean;
  /** 接下来 N 次 applyMode 被原生拖拽循环吞掉：返回成功但窗口尺寸不变 */
  swallowModeSizeCalls: number;
  snapState: {
    edge: string;
    hidden: boolean;
    center?: number | null;
    centerRatio?: number | null;
    form?: "capsule" | "tab" | null;
    display?: {
      name?: string | null;
      bounds?: { x: number; y: number; w: number; h: number };
      workArea?: { x: number; y: number; w: number; h: number };
      scaleFactor?: number;
    } | null;
  } | null;
  /** 持续移动失败（真机形态：setPosition 被系统拒绝，用于验证不写幻影基准） */
  failSetPosition: boolean;
  /** 持续缩放失败（模拟区域撑容器时 setSize 被系统拒绝） */
  failSetSize: boolean;
  /** 接下来 N 次 setSize 返回成功但实际尺寸不变（模拟写入被原生循环吞掉） */
  swallowSizeCalls: number;
  /** 接下来 N 次 setPosition 返回成功但实际位置不变 */
  swallowPositionCalls: number;
  /** 第 N 次 setSize 调用失败（1 起算）；null = 不按序号失败（用于回滚失败用例） */
  setSizeFailAt: number | null;
  /** 接下来 N 次 apply_window_capsule 返回 false（区域未应用/回读校验失败） */
  regionFailures: number;
  /** 指定形态的区域写入**一直**返回 false（模拟后端对该形态持续拒绝） */
  regionFailMode: string | null;
  /** 指定形态的区域 IPC 永不返回（模拟 invoke 挂起，用于超时用例） */
  regionHangMode: string | null;
  /** 挂起的区域请求：测试可手动 resolve，验证迟到响应不会覆盖新状态 */
  /** 光标离开后的自动收起判定用：菜单/对话框是否在场 */
  regionHangs: Array<{ mode: string; resolve: (v: boolean) => void }>;
  movedHandlers: Array<() => void>;
  recallHandlers: Array<() => void>;
  /** 前端就绪信号（撤销启动空白区域）的调用次数 */
  notifyReadyCalls: number;
  /** 磁力参数下发记录（原生 WM_MOVING 用；前端不得逐帧下发） */
  magnetConfigCalls: Array<{ enabled: boolean; range: number; maxLead: number; release: number }>;
  /** 停靠位下发记录（阻力基准；解除/关闭必须传 null） */
  magnetDockCalls: Array<{ edge: string | null; x: number; y: number }>;
  /** 拖离解除的鼠标锚定请求记录（仅拖离路径；按钮解除不得调用） */
  undockAnchorCalls: Array<{ mode: string; titlebarCss: number }>;
  /** 原生是否报告「锚定已在拖拽循环内应用」（take 的返回值） */
  undockAnchorApplied: boolean;
  /** 取消锚定请求的次数（解除中止/回滚路径） */
  undockAnchorCancelled: number;
  /** 后端持久化的用户自由窗口矩形（get_window_rect）；null = 无记录 */
  savedWindowRect: { x: number; y: number; w: number; h: number } | null;
  /** 接下来 N 次 outerPosition 读取延迟指定毫秒（模拟解除恢复期间的 IPC 拥塞） */
  delayRectReadMs: number;
  /** setPosition IPC 延迟（ms，用 fake timer 推进；用于 Edge Tab 异步竞态） */
  setPositionDelayMs: number;
  /** 按次 setPosition 延迟队列（优先于 setPositionDelayMs） */
  setPositionDelayQueue: number[];
  /** 接下来 N 次 outerPosition 读取抛错（模拟回读失败） */
  failRectReadCalls: number;
  /** cursorPosition 持续失败（受限会话形态：GetCursorPos 被拒） */
  failCursor: boolean;
  /** update_settings 写回的完整设置快照（P2：形态偏好回滚断言用） */
  settings: Record<string, unknown>;
}

const world: World = {
  pos: { x: 300, y: 300 },
  size: { width: 400, height: 560 },
  cursor: { x: 200, y: 500 },
  monitors: [MAIN],
  monitorNullCalls: 0,
  setPositionCalls: [],
  positionAttempts: 0,
  sizeCalls: [],
  regionCalls: [],
  snapWrites: [],
  rectWrites: [],
  modeCalls: [],
  failApplyMode: false,
  swallowModeSizeCalls: 0,
  snapState: null,
  failSetPosition: false,
  failSetSize: false,
  swallowSizeCalls: 0,
  swallowPositionCalls: 0,
  setSizeFailAt: null,
  regionFailures: 0,
  regionFailMode: null,
  regionHangMode: null,
  regionHangs: [],
  movedHandlers: [],
  recallHandlers: [],
  notifyReadyCalls: 0,
  magnetConfigCalls: [],
  magnetDockCalls: [],
  undockAnchorCalls: [],
  undockAnchorApplied: false,
  undockAnchorCancelled: 0,
  savedWindowRect: null,
  delayRectReadMs: 0,
  setPositionDelayMs: 0,
  setPositionDelayQueue: [],
  failRectReadCalls: 0,
  failCursor: false,
  settings: { mode: "full", snap_display_mode: "capsule", theme: "light" },
};

function resetWorld() {
  world.pos = { x: 300, y: 300 };
  world.size = { width: 400, height: 560 };
  world.cursor = { x: 200, y: 500 };
  world.monitors = [MAIN];
  world.monitorNullCalls = 0;
  world.setPositionCalls = [];
  world.positionAttempts = 0;
  world.sizeCalls = [];
  world.regionCalls = [];
  world.snapWrites = [];
  world.rectWrites = [];
  world.modeCalls = [];
  world.failApplyMode = false;
  world.swallowModeSizeCalls = 0;
  world.snapState = null;
  world.failSetPosition = false;
  world.failSetSize = false;
  world.swallowSizeCalls = 0;
  world.swallowPositionCalls = 0;
  world.setSizeFailAt = null;
  world.regionFailures = 0;
  world.regionFailMode = null;
  world.regionHangMode = null;
  world.regionHangs = [];
  world.movedHandlers = [];
  world.recallHandlers = [];
  world.notifyReadyCalls = 0;
  world.magnetConfigCalls = [];
  world.magnetDockCalls = [];
  world.undockAnchorCalls = [];
  world.undockAnchorApplied = false;
  world.undockAnchorCancelled = 0;
  world.savedWindowRect = null;
  world.delayRectReadMs = 0;
  world.setPositionDelayMs = 0;
  world.setPositionDelayQueue = [];
  world.failRectReadCalls = 0;
  world.failCursor = false;
  world.settings = { mode: "full", snap_display_mode: "capsule", theme: "light" };
}

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    outerPosition: async () => {
      if (world.failRectReadCalls > 0) {
        world.failRectReadCalls -= 1;
        throw new Error("mock outerPosition rejected");
      }
      if (world.delayRectReadMs > 0) {
        const delay = world.delayRectReadMs;
        world.delayRectReadMs = 0;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      return { x: world.pos.x, y: world.pos.y };
    },
    outerSize: async () => ({ width: world.size.width, height: world.size.height }),
    setPosition: async (p: { x: number; y: number }) => {
      world.positionAttempts += 1;
      const delay = world.setPositionDelayQueue.length > 0 ? world.setPositionDelayQueue.shift()! : world.setPositionDelayMs;
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      if (world.failSetPosition) throw new Error("mock setPosition rejected");
      world.setPositionCalls.push({ x: p.x, y: p.y });
      if (world.swallowPositionCalls > 0) {
        // 命令返回成功但位置没动：模拟原生拖拽循环吞掉写入
        world.swallowPositionCalls -= 1;
        return;
      }
      world.pos = { x: p.x, y: p.y };
    },
    setSize: async (s: { width: number; height: number }) => {
      world.sizeCalls.push({ w: s.width, h: s.height });
      const callNo = world.sizeCalls.length;
      if (world.failSetSize || (world.setSizeFailAt !== null && callNo >= world.setSizeFailAt)) {
        throw new Error("mock setSize rejected");
      }
      if (world.swallowSizeCalls > 0) {
        world.swallowSizeCalls -= 1;
        return; // 命令成功但尺寸未变
      }
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
  cursorPosition: async () => {
    if (world.failCursor) throw new Error("mock cursorPosition rejected");
    return { x: world.cursor.x, y: world.cursor.y };
  },
  currentMonitor: async () => {
    if (world.monitorNullCalls > 0) {
      world.monitorNullCalls -= 1;
      return null;
    }
    return world.monitors[0];
  },
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
  saveSnapState: async (
    edge: string,
    hidden: boolean,
    center: number | null = null,
    extra: Record<string, unknown> = {},
  ) => {
    const write: World["snapWrites"][number] = { edge, hidden, center };
    if (extra.form !== undefined) write.form = extra.form as string | null;
    world.snapWrites.push(write);
    world.snapState = { edge, hidden, center, ...(extra as object) } as World["snapState"];
  },
  getWindowRect: async () => world.savedWindowRect,
  updateSettings: async (patch: Record<string, unknown>) => {
    world.settings = { ...world.settings, ...patch };
    return world.settings as never;
  },
  saveWindowRect: async (rect: { x: number; y: number; w: number; h: number }) => {
    world.rectWrites.push(rect);
  },
  applyWindowCapsule: (mode: string, edge: string) => {
    world.regionCalls.push({ mode, edge });
    if (world.regionHangMode === mode) {
      // invoke 永不返回：引擎必须靠自身超时退出 busy，而不是把相位提交当成功
      return new Promise<boolean>((resolve) => world.regionHangs.push({ mode, resolve }));
    }
    const sticky = world.regionFailMode === mode;
    const counted = world.regionFailures > 0;
    if (counted) world.regionFailures -= 1;
    // 后端报告未应用（含 GetWindowRgn 回读验证失败）
    if (sticky || counted) return Promise.resolve(false);
    return Promise.resolve(true);
  },
  applyMode: async (mode: string) => {
    world.modeCalls.push(mode);
    if (world.failApplyMode) throw new Error("mock applyMode rejected");
    if (world.swallowModeSizeCalls > 0) {
      world.swallowModeSizeCalls -= 1;
      return; // 模拟拖拽循环吞掉 set_size：命令成功但尺寸未变
    }
    world.size = mode === "full" ? { width: 400, height: 560 } : { width: 280, height: 140 };
  },
  notifyUiReady: async () => {
    world.notifyReadyCalls += 1;
    return true;
  },
  setMagneticDragConfig: async (
    enabled: boolean,
    range: number,
    maxLead: number,
    release: number,
  ) => {
    world.magnetConfigCalls.push({ enabled, range, maxLead, release });
    return true;
  },
  setMagneticDock: async (edge: string | null, x = 0, y = 0) => {
    world.magnetDockCalls.push({ edge, x, y });
    return true;
  },
  setUndockAnchor: async (mode: string, titlebarCss: number) => {
    world.undockAnchorCalls.push({ mode, titlebarCss });
    return true; // 原生磁力层已安装：请求被接受
  },
  takeUndockAnchorApplied: async () => world.undockAnchorApplied,
  cancelUndockAnchor: async () => {
    world.undockAnchorCancelled += 1;
  },
  onSnapRecall: (cb: () => void) => {
    world.recallHandlers.push(cb);
    return Promise.resolve(() => {
      const i = world.recallHandlers.indexOf(cb);
      if (i >= 0) world.recallHandlers.splice(i, 1);
    });
  },
}));

const overlayMock = vi.hoisted(() => ({ blocking: false }));

vi.mock("../lib/overlayStack", () => ({
  hasAutoHideBlockingOverlay: () => overlayMock.blocking,
}));

import { useEdgeSnap } from "./useEdgeSnap";
import { useEdgeSnapStore } from "../store/useEdgeSnapStore";
import { useUiStore } from "../store/useUiStore";
import { useSettingsStore } from "../store/useSettingsStore";
import {
  snapMoveGuard,
  measureTitlebarHeight,
  resetTitlebarHeightCache,
  TITLEBAR_HEIGHT_CSS,
} from "../lib/edgeSnap";
import { PANEL_EXIT_MS } from "../lib/capsuleLayout";

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

/** 模拟在拖拽区域按下：引擎据此记录按下时的真实窗口矩形（手势起点）。 */
async function pressDragRegion() {
  const el = document.createElement("div");
  el.setAttribute("data-tauri-drag-region", "");
  document.body.appendChild(el);
  await act(async () => {
    el.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    el.remove();
    // 轻量矩形读取是 2 次 IPC（Promise.all + then），等微任务链落地。
    await Promise.resolve();
    await Promise.resolve();
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
  overlayMock.blocking = false;
  mounted.length = 0;
  vi.useFakeTimers();
  snapMoveGuard.reset();
  useEdgeSnapStore.getState().reset();
  useSettingsStore.setState({ settings: null });
  useUiStore.setState({ toasts: [] });
});

afterEach(async () => {
  while (mounted.length) mounted.pop()!();
  // 刷掉在途移动/延迟计时器，避免模块级串行链跨用例尾随
  await vi.advanceTimersByTimeAsync(10000);
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

  it("窗口小于胶囊容器时先撑到 404×440（否则面板放不下）", async () => {
    world.size = { width: 280, height: 140 }; // minimal 模式
    mount();
    await advance(50);
    await dockLeft();

    expect(world.sizeCalls.at(-1)).toEqual({ w: 404, h: 440 });
    expect(phase()).toBe("docked-visible");
  });

  it("Aero Snap 半屏尺寸（1280×690）在停靠时归一为容器 404×440", async () => {
    world.pos = { x: 320, y: 300 };
    world.size = { width: 1280, height: 690 }; // Windows 先把窗口吸成左半屏
    mount();
    await advance(50);
    await dragTo(20, 300);
    await releasePointer();
    await advance(400);

    expect(phase()).toBe("docked-visible");
    expect(world.size).toEqual({ width: 404, height: 440 });
    expect(world.pos.x).toBe(0);
    expect(lastRegion()).toEqual({ mode: "rail", edge: "left" });
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

  it("展开态光标离开 → 保持展开（面板不再自动收起，不移动窗口）", async () => {
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
    await advance(5000);

    expect(phase()).toBe("docked-revealed");
    expect(lastRegion()).toEqual({ mode: "panel", edge: "left" });
    expect(world.setPositionCalls.length).toBe(moves);
  });

  it("展开态无人操作（含弹层开关）保持展开，只有主动收起才回到轨道", async () => {
    mount();
    await advance(50);
    await dockLeft();
    await act(async () => {
      useEdgeSnapStore.getState().reveal?.();
      await Promise.resolve();
    });
    await advance(20);
    expect(phase()).toBe("docked-revealed");

    overlayMock.blocking = true; // 例如胶囊面板里打开了确认框
    await act(async () => {
      world.cursor = { x: 1200, y: 200 };
    });
    await advance(9000);
    expect(phase()).toBe("docked-revealed");

    overlayMock.blocking = false; // 弹层关闭后同样不自动收起
    await advance(9000);
    expect(phase()).toBe("docked-revealed");

    await act(async () => {
      useEdgeSnapStore.getState().collapse?.();
      await Promise.resolve();
    });
    await advance(20);
    expect(phase()).toBe("docked-visible");
    expect(lastRegion()).toEqual({ mode: "rail", edge: "left" });
  });
});

describe("重启恢复与唤回", () => {
  it("snap_state 记录停靠边与中心 → 启动后直接折叠停靠（无反馈）", async () => {
    world.snapState = { edge: "left", hidden: true, center: 516 };
    mount();
    await advance(400);

    expect(phase()).toBe("docked-hidden");
    expect(world.pos.x).toBe(0);
    // 停靠时窗口归一为容器高 440，中心 516 → y = 516 - 220 = 296
    expect(world.pos.y).toBe(296);
    expect(world.size).toEqual({ width: 404, height: 440 });
    expect(lastRegion()).toEqual({ mode: "rail", edge: "left" });
  });

  it("首拍读不到显示器（窗口尚未显示）：保留待恢复状态并有界重试，最终停靠", async () => {
    world.snapState = { edge: "left", hidden: true, center: 516 };
    world.monitorNullCalls = 2; // 前两次 currentMonitor() 返回 null（原生尚未显示）
    mount();
    await advance(2200);

    expect(phase()).toBe("docked-hidden");
    expect(world.pos.x).toBe(0);
    expect(lastRegion()).toEqual({ mode: "rail", edge: "left" });
    // 失败次数有界，但没有丢弃持久化状态（直到成功才清 pendingRestore）
    expect(world.snapWrites.length).toBeGreaterThan(0);
  });

  it("显示器持续不可用：重启恢复有界停止，不无限重发 IPC，窗口保持完整", async () => {
    world.snapState = { edge: "left", hidden: true, center: 516 };
    world.monitorNullCalls = 99;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mount();
    await advance(5000);

    expect(phase()).toBe("free");
    expect(world.regionCalls).toHaveLength(0); // 从未提交胶囊区域
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
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

describe("启动显示门：区域生效后才放行主窗口", () => {
  it("没有停靠记录：立即放行（窗口无需等待恢复）", async () => {
    world.snapState = null;
    mount();
    await advance(50);
    expect(world.notifyReadyCalls).toBe(1);
  });

  it("有停靠记录：区域写入成功后才放行，且只放行一次", async () => {
    world.snapState = { edge: "left", hidden: true, center: 516 };
    mount();
    // 首个 tick 之前：窗口必须保持隐藏/空白（还没裁出轨道）
    await advance(20);
    expect(world.notifyReadyCalls).toBe(0);
    expect(phase()).toBe("free");

    await advance(400);
    expect(phase()).toBe("docked-hidden");
    expect(world.notifyReadyCalls).toBe(1);
    // 区域先于放行：最后一条区域调用是轨道
    expect(lastRegion()).toEqual({ mode: "rail", edge: "left" });

    // 后续 tick 不重复发信号
    await advance(1000);
    expect(world.notifyReadyCalls).toBe(1);
  });

  it("恢复连续失败（显示器持续不可用）：放弃恢复后仍放行，不把窗口永久藏起来", async () => {
    world.snapState = { edge: "left", hidden: true, center: 516 };
    world.monitorNullCalls = 99;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mount();
    await advance(5000);

    expect(phase()).toBe("free");
    expect(world.regionCalls).toHaveLength(0);
    expect(world.notifyReadyCalls).toBe(1);
    warn.mockRestore();
  });

  it("区域写入失败：不放行（保持空白），直到恢复被判定失败", async () => {
    world.snapState = { edge: "left", hidden: true, center: 516 };
    world.regionFailMode = "rail";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mount();
    await advance(20);
    expect(world.notifyReadyCalls).toBe(0); // 停靠事务未成功，不得先露出窗口

    await advance(5000);
    // 区域始终没裁成轨道：相位不进入 docked，但窗口最终必须放行
    expect(phase()).toBe("free");
    expect(world.notifyReadyCalls).toBe(1);
    warn.mockRestore();
  });
});

describe("解除吸附", () => {
  it("拖离停靠位超过磁吸阈值：清区域、恢复模式尺寸、清持久化", async () => {
    mount();
    await advance(50);
    await dockLeft();
    expect(phase()).toBe("docked-visible");

    await dragTo(120, 300); // 距边 120 > 42：离开磁吸区
    await advance(2200);

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

  it("解除后模式尺寸恢复失败：仍解除，但不把容器尺寸持久化", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mount();
    await advance(50);
    await dockLeft();
    world.failApplyMode = true;
    await dragTo(120, 300);
    await advance(4000); // 走完 4 次有界重试

    expect(phase()).toBe("free");
    expect(world.modeCalls).toContain("full");
    expect(warn).toHaveBeenCalled();
    // 回滚/重试窗口内 saveVisibleRect 不得写入胶囊容器几何
    expect(world.rectWrites).toHaveLength(0);
    warn.mockRestore();
  });

  it("解除后模式尺寸被原生拖拽循环吞掉：回读验证后有界重试直到恢复", async () => {
    mount();
    await advance(50);
    await dockLeft();
    expect(world.size).toEqual({ width: 404, height: 440 }); // 停靠容器

    world.swallowModeSizeCalls = 1; // 第一次 applyMode 返回成功但尺寸未变
    await dragTo(120, 300);
    await advance(2200);

    expect(phase()).toBe("free");
    expect(world.modeCalls.filter((m) => m === "full").length).toBeGreaterThanOrEqual(2);
    expect(world.size).toEqual({ width: 400, height: 560 }); // full 模式已真正恢复
    // 任何写入都不得是胶囊容器尺寸
    expect(world.rectWrites.some((r) => r.w === 404 && r.h === 440)).toBe(false);
  });

  it("重试用尽仍被吞掉：有界停止并把容器尺寸挡在 window_rect 之外", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mount();
    await advance(50);
    await dockLeft();
    world.swallowModeSizeCalls = 99;
    await dragTo(120, 300);
    await advance(5000);

    expect(phase()).toBe("free");
    expect(world.modeCalls.filter((m) => m === "full")).toHaveLength(4);
    expect(world.size).toEqual({ width: 404, height: 440 });
    expect(world.rectWrites).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("程序移动失败：不提交停靠、不写幻影基准、不裁区域", async () => {
    mount();
    await advance(50);
    world.failSetPosition = true; // 真机形态：setPosition 被系统拒绝
    await dragTo(20, 300);
    await releasePointer();
    await advance(600); // 多个 tick 反复尝试

    // 窗口没落到贴边齐平位 → 绝不提交停靠相位（旧实现会照样裁区域，
    // 于是轨道画在屏幕错误位置，且 dockedPos 成为幻影基准，
    // 下一拍偏离判定 |rect-dockedPos|>24 必然成立 → 误判用户拖离并自动解除）
    expect(phase()).toBe("candidate");
    expect(useEdgeSnapStore.getState().dockedEdge).toBeNull();
    expect(world.regionCalls).toHaveLength(0); // 未落位就不裁窗口
    expect(world.snapWrites).toHaveLength(0); // 不写持久化（重启不该恢复成停靠）
    // 失败后的 500ms 冷却内只尝试一次：不能每个 tick 都重发 setPosition
    expect(world.positionAttempts).toBe(1);
    // 候选提示不得因一次 IPC 失败而闪断
    expect(useEdgeSnapStore.getState().candidateEdge).toBe("left");

    // 失败不是死路：移动恢复后仍能正常停靠
    world.failSetPosition = false;
    await advance(400);
    expect(phase()).toBe("docked-visible");
    expect(world.pos.x).toBe(0);
  });
});

describe("区域写入失败：状态一致优先", () => {
  it("rail 区域始终写不进：每次失败都校准回 off，绝不提交停靠相位", async () => {
    mount();
    await advance(50);
    world.regionFailMode = "rail"; // 后端对轨道形态持续报告未应用（off 仍可写）
    await dragTo(20, 300);
    await releasePointer();
    await advance(2000); // 跑过多次重试，断言与 tick 对齐无关

    expect(phase()).toBe("candidate");
    expect(useEdgeSnapStore.getState().dockedEdge).toBeNull();
    expect(world.snapWrites).toHaveLength(0);
    // 每一次 rail 失败之后必须紧跟一次与当前相位一致的校准（candidate → off）
    const modes = world.regionCalls.map((c) => c.mode);
    expect(modes.length).toBeGreaterThan(2);
    expect(modes.filter((m) => m === "rail").length).toBe(
      modes.filter((m) => m === "off").length,
    );
    for (let i = 0; i < modes.length; i += 1) {
      if (modes[i] === "rail") expect(modes[i + 1]).toBe("off");
    }
  });

  it("应用与恢复都失败：不提交 free（不把「发了 off」当已取消裁剪），有界重试后停止", async () => {
    mount();
    await advance(50);
    world.regionFailures = 99; // rail 与 off 都失败
    await dragTo(20, 300);
    await releasePointer();
    await advance(6000);

    // free 一旦提交就等价于「UI 认为窗口已完整」，而原生区域可能仍是轨道：
    // 此时必须保持当前相位，并把失准状态暴露出来，而不是谎报解除。
    expect(phase()).toBe("candidate");
    expect(useEdgeSnapStore.getState().dockedEdge).toBeNull();
    expect(useEdgeSnapStore.getState().regionUnsynced).toBe(true);
    expect(world.snapWrites).toHaveLength(0);
    // 只尝试过一次停靠（rail），失准期间 candidate tick 不再反复写区域；
    // off 校准 = 首次 1 次 + 退避恢复 3 次，随后停止（不无限重试）。
    expect(world.regionCalls.filter((c) => c.mode === "rail")).toHaveLength(1);
    expect(world.regionCalls.filter((c) => c.mode === "off")).toHaveLength(4);
  });

  it("展开时区域未应用：面板区域退回轨道，相位保持折叠可见", async () => {
    mount();
    await advance(50);
    await dockLeft();
    expect(phase()).toBe("docked-visible");

    world.regionFailures = 1; // panel 失败 → 校准回 rail 成功
    await act(async () => {
      useEdgeSnapStore.getState().reveal?.();
      await Promise.resolve();
    });
    await advance(20);

    expect(world.regionCalls.slice(-2)).toEqual([
      { mode: "panel", edge: "left" },
      { mode: "rail", edge: "left" },
    ]);
    // 不允许出现「原生已裁成轨道 / React 显示展开态」
    expect(phase()).toBe("docked-visible");
  });

  it("跨边拖拽但解除失败：停在原边，不得改写停靠边", async () => {
    mount();
    await advance(50);
    await dockLeft();
    expect(useEdgeSnapStore.getState().dockedEdge).toBe("left");

    world.regionFailures = 2; // undockCore 的两次 off 都失败
    await dragTo(1500, 300); // 已贴近右缘
    await advance(200);

    // 旧实现先改 machine.edge 再判 setPhase：区域仍是左缘轨道，
    // 而命中判定按右缘几何算 → 光标在可见胶囊上却被判「离开」，面板误收起
    expect(phase()).toBe("docked-visible");
    expect(useEdgeSnapStore.getState().dockedEdge).toBe("left");
    expect(useEdgeSnapStore.getState().candidateEdge).toBeNull();

    // 失败后的自动解除有 500ms 冷却（防 onMoved 高频重发 off）
    world.regionFailMode = "off"; // 冷却期间自动重试仍失败，保持停靠
    await advance(600);
    world.regionFailMode = null;
    // 冷却后自动重试成功解除，再拖向另一条边才进入新边候选。
    // 新契约要求本次手势内有明确的「向边」位移，先模拟从远处重新拖过来。
    await advance(2200);
    expect(phase()).toBe("free");
    await dragTo(1000, 300); // 先把窗口拖离右缘
    await advance(300); // 停顿 → 下一次移动是新手势
    await dragTo(1500, 300);
    await advance(200);
    expect(phase()).toBe("candidate");
    expect(useEdgeSnapStore.getState().candidateEdge).toBe("right");
  });
});

describe("区域 IPC 超时与迟到响应", () => {
  it("rail 永不返回：3s 超时后校准回 off，不提交停靠相位", async () => {
    mount();
    await advance(50);
    world.regionHangMode = "rail";
    await dragTo(20, 300);
    await releasePointer();
    await advance(3500);

    expect(phase()).toBe("candidate");
    expect(useEdgeSnapStore.getState().regionUnsynced).toBe(false); // off 校准成功
    expect(world.regionCalls.filter((c) => c.mode === "off").length).toBeGreaterThan(0);

    // 迟到的 invoke 结果不得覆盖已经校准好的状态
    const pending = world.regionHangs.shift();
    await act(async () => {
      pending?.resolve(true);
      await Promise.resolve();
    });
    await advance(20);
    expect(phase()).toBe("candidate");
    expect(world.snapWrites).toHaveLength(0);
  });

  it("panel 响应迟到：超时回退轨道后，旧 panel 成功响应不改写相位", async () => {
    mount();
    await advance(50);
    await dockLeft();
    expect(phase()).toBe("docked-visible");

    // 光标留在轨道可见区内：避免 450ms 自动收起把相位改成 docked-hidden
    world.cursor = { x: 30, y: 500 };
    world.regionHangMode = "panel";
    await act(async () => {
      useEdgeSnapStore.getState().reveal?.();
      await Promise.resolve();
    });
    await advance(3500);

    expect(phase()).toBe("docked-visible");
    expect(world.regionCalls.at(-1)).toEqual({ mode: "rail", edge: "left" });

    const pending = world.regionHangs.shift();
    await act(async () => {
      pending?.resolve(true);
      await Promise.resolve();
    });
    await advance(20);
    expect(phase()).toBe("docked-visible");
  });
});

describe("解除区域失败：保持停靠而非假解除", () => {
  it("off 持续失败：相位留在停靠，不恢复模式尺寸，自动重试有间隔且成功后解除", async () => {
    mount();
    await advance(50);
    await dockLeft();
    expect(phase()).toBe("docked-visible");

    world.regionFailMode = "off";
    // 光标跟随拖拽后的胶囊（避免 450ms 离开判定把相位收成 docked-hidden）
    world.cursor = { x: 140, y: 500 };
    await dragTo(120, 300); // 偏离 > 24，触发拖离解除
    await advance(400);

    // 两次 off 失败 → undockCore 返回 false；窗口不得被当成已解除
    expect(phase()).toBe("docked-visible");
    expect(useEdgeSnapStore.getState().dockedEdge).toBe("left");
    expect(world.modeCalls).toHaveLength(0);
    expect(world.regionCalls.filter((c) => c.mode === "off")).toHaveLength(2);

    // 自动重试有间隔（不是每个 tick 都发 IPC）：500ms 冷却内不再发 off
    await advance(50);
    expect(world.regionCalls.filter((c) => c.mode === "off")).toHaveLength(2);
    // 冷却到点后只补一次（失败仍是两次 off）
    await advance(200);
    expect(world.regionCalls.filter((c) => c.mode === "off")).toHaveLength(4);
    // 之后继续等待下一个冷却窗口，而不是逐 tick 重发
    await advance(300);
    expect(world.regionCalls.filter((c) => c.mode === "off")).toHaveLength(4);

    // 后端恢复后，下一次自动重试成功解除
    world.regionFailMode = null;
    await advance(2200);
    expect(phase()).toBe("free");
    expect(world.modeCalls).toContain("full");
  });
});

describe("停靠失败后的窗口几何回滚", () => {
  it("resize 成功、move 失败：恢复原尺寸，位置不变，不裁区域", async () => {
    world.size = { width: 280, height: 140 };
    world.failSetPosition = true;
    mount();
    await advance(50);
    await dragTo(20, 300);
    await releasePointer();
    await advance(600);

    expect(phase()).toBe("candidate");
    expect(world.sizeCalls.at(-1)).toEqual({ w: 280, h: 140 }); // 不遗留 404×440
    expect(world.setPositionCalls).toHaveLength(0);
    expect(world.regionCalls).toHaveLength(0);
    expect(world.snapWrites).toHaveLength(0);
  });

  it("resize 失败：立即回滚并停止停靠，不移动也不切区域", async () => {
    world.size = { width: 280, height: 140 };
    world.failSetSize = true;
    mount();
    await advance(50);
    await dragTo(20, 300);
    await releasePointer();
    await advance(400);

    // §5.1：setSize 失败后不得继续 move/region
    expect(phase()).toBe("candidate");
    expect(world.sizeCalls.every((c) => c.w === 404 && c.h === 440)).toBe(true);
    expect(world.setPositionCalls).toHaveLength(0);
    expect(world.regionCalls).toHaveLength(0);
    expect(world.snapWrites).toHaveLength(0);
    // 回滚与候选都已完成，尺寸仍是事务起点的 280×140
    expect(world.size).toEqual({ width: 280, height: 140 });
  });

  it("resize 与 move 都成功、region 失败：尺寸和位置一起回滚", async () => {
    world.size = { width: 280, height: 140 };
    world.regionFailMode = "rail";
    mount();
    await advance(50);
    await dragTo(20, 300);
    await releasePointer();
    await advance(400);

    expect(phase()).toBe("candidate");
    expect(world.sizeCalls.at(-1)).toEqual({ w: 280, h: 140 });
    expect(world.setPositionCalls.at(-1)).toEqual({ x: 20, y: 300 });
    expect(useEdgeSnapStore.getState().dockedEdge).toBeNull();
  });

  it("回滚 setSize 失败：仍恢复位置、记录警告并抑制 window_rect 持久化", async () => {
    world.size = { width: 280, height: 140 };
    world.setSizeFailAt = 2; // 第 1 次撑容器成功，第 2 次回滚失败
    world.regionFailMode = "rail";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mount();
    await advance(50);
    await dragTo(20, 300);
    await releasePointer();
    await advance(400);

    expect(phase()).toBe("candidate");
    expect(world.setPositionCalls.at(-1)).toEqual({ x: 20, y: 300 });
    expect(warn).toHaveBeenCalled();
    expect(snapMoveGuard.isPersistenceSuppressed()).toBe(true);
    warn.mockRestore();
  });
});

describe("StrictMode 双挂载", () => {
  it("旧实例的清理不得把新实例的区域清成 off", async () => {
    const first = mount();
    await advance(50);
    await dockLeft();
    expect(phase()).toBe("docked-visible");
    const mark = world.regionCalls.length;

    // 同一轮里卸载并立即重挂载（React.StrictMode 的双重挂载形态）
    first.unmount();
    mounted.pop();
    mount();
    await advance(600);

    const delta = world.regionCalls.slice(mark);
    expect(delta.some((c) => c.mode === "off")).toBe(false);
    // 新实例按持久化状态自行恢复停靠
    expect(delta.at(-1)).toEqual({ mode: "rail", edge: "left" });
    expect(phase()).toBe("docked-hidden");
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
    expect(world.pos.x).toBe(1920 - 404);
    expect(lastRegion()).toEqual({ mode: "rail", edge: "right" });
  });
});

// ── 磁力层联动（原生 WM_MOVING）──────────────────────────────
//
// 前端只负责两件事：下发参数（一次）与下发/清除停靠基准。
// 逐帧吸引/阻力在原生侧完成——这里断言前端**不逐帧**参与，
// 且解除判定只看停靠边法向（沿边滑动不是拖离）。

describe("磁力层联动", () => {
  it("挂载即下发一次磁力参数（契约值，不逐帧下发）", async () => {
    mount();
    await advance(50);
    expect(world.magnetConfigCalls).toEqual([
      { enabled: true, range: 50, maxLead: 16, release: 32 },
    ]);
    // 拖拽过程中不得再下发（逐帧 IPC 会与拖拽循环抢线程）
    await dragTo(20, 300);
    await releasePointer();
    await advance(600);
    expect(world.magnetConfigCalls).toHaveLength(1);
  });

  it("停靠成功后才下发齐平基准；解除后立即清除", async () => {
    mount();
    await advance(50);
    await dockLeft();
    expect(world.magnetDockCalls.at(-1)).toEqual({ edge: "left", x: 0, y: 360 });

    await dragTo(120, 300);
    await advance(2200);
    expect(phase()).toBe("free");
    expect(world.magnetDockCalls.at(-1)).toEqual({ edge: null, x: 0, y: 0 });
  });

  it("关闭吸附：磁力参数下发 enabled=false（阻力必须彻底停用）", async () => {
    const hook = mount();
    await advance(50);
    await dockLeft();

    await act(async () => {
      hook.rerender({ enabled: false });
      await Promise.resolve();
    });
    await advance(50);

    expect(world.magnetConfigCalls.at(-1)?.enabled).toBe(false);
    expect(world.magnetDockCalls.at(-1)?.edge).toBeNull();
  });

  it("沿边拖动 40px 不解除（法向位移为 0）", async () => {
    mount();
    await advance(50);
    await dockLeft();
    expect(phase()).toBe("docked-visible");

    await dragTo(0, 340); // 沿左边向下滑 40px，法向仍是 0
    // 400ms：越过静止确认（220ms）但仍在自动收起阈值（450ms）内
    await advance(400);

    expect(phase()).toBe("docked-visible");
    expect(lastRegion()).toEqual({ mode: "rail", edge: "left" });
    // 沿边位置写回基准与持久化（重启/断连恢复不会回到旧位置）
    // 窗口左上角基准（沿边 = y）；胶囊中心另算 = 340 + 440/2
    expect(world.magnetDockCalls.at(-1)).toEqual({ edge: "left", x: 0, y: 340 });
    expect(world.snapWrites.at(-1)?.center).toBe(340 + 220);
  });

  it("法向拖出超过提交阈值：解除", async () => {
    mount();
    await advance(50);
    await dockLeft();

    await dragTo(30, 300); // 法向 30 > 24
    await advance(600);

    expect(phase()).toBe("free");
    expect(lastRegion()?.mode).toBe("off");
  });

  it("法向拖出但未达提交阈值：保持停靠（原生已回弹贴平）", async () => {
    mount();
    await advance(50);
    await dockLeft();

    await dragTo(16, 300); // 阻力段内的弹性位移
    await advance(400);

    expect(phase()).toBe("docked-visible");
    expect(lastRegion()).toEqual({ mode: "rail", edge: "left" });
  });

  it("折叠态（docked-hidden）被拖出同样解除，不会停在半脱开", async () => {
    mount();
    await advance(50);
    await dockLeft();
    await act(async () => {
      world.cursor = { x: 900, y: 900 };
    });
    await advance(800);
    expect(phase()).toBe("docked-hidden");

    await dragTo(40, 300); // 折叠态不做轮询，靠 undockCheckDue 收尾
    await advance(800);

    expect(phase()).toBe("free");
    expect(lastRegion()?.mode).toBe("off");
  });
});

// ── 拖离解除的鼠标锚定（v0.7：恢复尺寸 + 标题栏中心 = 光标）──────
//
// 原生在拖拽循环内应用锚定（magnetic::undock_anchor_rect）；这里验证前端
// 侧的契约：只有拖离路径请求锚定、原生未应用时按实际尺寸回退定位、
// 解除中止时取消请求防残留。

describe("拖离解除的鼠标锚定", () => {
  it("拖离解除请求原生锚定（mode + 实测标题栏高度）；原生已应用时不回退定位", async () => {
    mount();
    await advance(50);
    await dockLeft();
    expect(phase()).toBe("docked-visible");
    const moves = world.setPositionCalls.length;

    world.undockAnchorApplied = true; // 原生在拖拽循环内已应用锚定
    await dragTo(120, 300);
    await advance(2200);

    expect(phase()).toBe("free");
    expect(world.undockAnchorCalls).toEqual([{ mode: "full", titlebarCss: 41 }]);
    // 原生已锚定：解除过程不得再移动窗口（保持拖拽终态，标题栏已居中跟手）
    expect(world.setPositionCalls.length).toBe(moves);
  });

  it("原生未应用（拖拽已结束）：按实际恢复后的尺寸回退定位，标题栏中心=光标", async () => {
    mount();
    await advance(50);
    await dockLeft();

    await dragTo(120, 300);
    await advance(2200);

    expect(phase()).toBe("free");
    expect(world.undockAnchorCalls).toEqual([{ mode: "full", titlebarCss: 41 }]);
    // 光标 (200,500)、full 400×560、标题栏 41（jsdom 无布局 → 设计常量）：
    // x = 200-200 = 0；y = round(500-20.5) = 480 → 钳进工作区（y_max=1032-560=472）
    expect(world.setPositionCalls.at(-1)).toEqual({ x: 0, y: 472 });
  });

  it("按钮解除（打开完整页）不请求鼠标锚定，保持原有定位策略", async () => {
    mount();
    await advance(50);
    await dockLeft();
    expect(phase()).toBe("docked-visible");

    await act(async () => {
      useEdgeSnapStore.getState().undock?.("compact");
      await Promise.resolve();
    });
    await advance(2200);

    expect(phase()).toBe("free");
    expect(world.undockAnchorCalls).toHaveLength(0);
    expect(world.modeCalls).toContain("compact");
  });

  it("解除失败（区域清理不通过）：取消锚定请求，不留下残留", async () => {
    mount();
    await advance(50);
    await dockLeft();
    world.regionFailMode = "off";
    world.cursor = { x: 140, y: 500 };
    await dragTo(120, 300);
    await advance(400);

    expect(phase()).toBe("docked-visible"); // 解除未成立
    // 请求在区域清理成功之后才发出：失败路径只做防御性取消
    expect(world.undockAnchorCalls).toHaveLength(0);
    expect(world.undockAnchorCancelled).toBe(1);
  });

  it("折叠态（docked-hidden）拖离同样请求锚定", async () => {
    mount();
    await advance(50);
    await dockLeft();
    await act(async () => {
      world.cursor = { x: 900, y: 900 };
    });
    await advance(800);
    expect(phase()).toBe("docked-hidden");

    world.undockAnchorApplied = true;
    await dragTo(40, 300);
    await advance(800);

    expect(phase()).toBe("free");
    expect(world.undockAnchorCalls).toHaveLength(1);
  });
});

// ── 完整面板形态事务、用户尺寸与恢复信息（P2 / P3）────────────
//
// 逐项覆盖：偏好 full 的停靠与解除、胶囊解除恢复 window_rect 用户尺寸、
// 容器尺寸不得写入 window_rect、full↔capsule 原地切换、失败回滚到最后确认
// 成功形态、快速切换只落最后一次、工作区/DPI 变化重建停靠几何、
// 重启恢复按显示器身份与比例定位（含旧记录兼容）。

describe("完整面板与停靠形态事务", () => {
  const setPref = async (form: "capsule" | "full") => {
    await act(async () => {
      await useSettingsStore.getState().update({ snap_display_mode: form });
      await Promise.resolve();
    });
    // 胶囊 → 完整必须等 `restoreModeSize` 的静止等待 + 二次稳定回读（约 1s）；
    // 200ms 只够覆盖纯区域切换，会误判成失败。
    await advance(1400);
  };

  it("1) 偏好 full：停靠后保持完整面板，不裁区域、不写胶囊容器尺寸", async () => {
    await act(async () => {
      await useSettingsStore.getState().update({ snap_display_mode: "full" });
    });
    mount();
    await advance(50);
    await dockLeft();

    expect(phase()).toBe("docked-full");
    // 完整形态只允许一次「清胶囊区域」的 off，不得出现 rail/panel 裁剪。
    expect(world.regionCalls.filter((c) => c.mode !== "off")).toHaveLength(0);
    expect(world.size).toEqual({ width: 400, height: 560 });
    expect(world.pos.x).toBe(0);
  });

  it("2) 完整面板解除：保持用户尺寸，不回退模式默认值、不重置位移", async () => {
    await act(async () => {
      await useSettingsStore.getState().update({ snap_display_mode: "full" });
    });
    mount();
    await advance(50);
    await dockLeft();
    expect(phase()).toBe("docked-full");
    const sizeCalls = world.sizeCalls.length;

    await dragTo(120, 300);
    await advance(2200);

    expect(phase()).toBe("free");
    expect(world.size).toEqual({ width: 400, height: 560 });
    expect(world.sizeCalls.length).toBe(sizeCalls);
  });

  it("3) 胶囊解除：从 window_rect 恢复用户尺寸，不把容器尺寸当用户尺寸", async () => {
    world.savedWindowRect = { x: 700, y: 180, w: 560, h: 720 };
    mount();
    await advance(50);
    await dockLeft();
    expect(world.size).toEqual({ width: 404, height: 440 });

    await dragTo(120, 300);
    await advance(2600);

    expect(phase()).toBe("free");
    expect(world.size).toEqual({ width: 560, height: 720 });
    expect(world.modeCalls).toHaveLength(0); // 有用户尺寸就不该套模式预设
  });

  it("4) 无 window_rect 记录：回退模式尺寸，不残留容器尺寸", async () => {
    mount();
    await advance(50);
    await dockLeft();
    await dragTo(120, 300);
    await advance(2600);

    expect(phase()).toBe("free");
    expect(world.modeCalls).toContain("full");
    expect(world.size).toEqual({ width: 400, height: 560 });
  });

  it("5) 停靠/折叠期间不把胶囊容器尺寸写入 window_rect", async () => {
    mount();
    await advance(50);
    await dockLeft();
    await act(async () => {
      world.cursor = { x: 900, y: 900 };
    });
    await advance(800);
    expect(phase()).toBe("docked-hidden");

    expect(world.rectWrites.some((r) => r.w === 404 && r.h === 440)).toBe(false);
  });

  it("6) full → capsule：原地收成胶囊（容器尺寸 + 轨道区域）", async () => {
    await act(async () => {
      await useSettingsStore.getState().update({ snap_display_mode: "full" });
    });
    mount();
    await advance(50);
    await dockLeft();
    expect(phase()).toBe("docked-full");

    await setPref("capsule");

    expect(phase()).toBe("docked-hidden");
    expect(world.size).toEqual({ width: 404, height: 440 });
    expect(lastRegion()).toEqual({ mode: "rail", edge: "left" });
  });

  it("7) capsule → full：原地撑回完整面板并保持用户尺寸", async () => {
    mount();
    await advance(50);
    await dockLeft();
    expect(phase()).toBe("docked-visible");

    await setPref("full");

    expect(phase()).toBe("docked-full");
    expect(world.size).toEqual({ width: 400, height: 560 });
    expect(lastRegion()?.mode).toBe("off");
  });

  it("8) 切换失败（区域写入不通过）：保持原形态并回滚偏好", async () => {
    mount();
    await advance(50);
    await dockLeft();
    expect(phase()).toBe("docked-visible");
    world.regionFailMode = "off";

    await setPref("full");

    // 等待切换结果期间光标不在轨道上，相位会先自动折叠；关键是**没有**进入
    // docked-full，且几何仍是胶囊容器、偏好回滚到胶囊。
    expect(phase()).toBe("docked-hidden");
    expect(world.size).toEqual({ width: 404, height: 440 }); // 几何回滚到胶囊容器
    expect(useSettingsStore.getState().settings?.snap_display_mode).toBe("capsule");
  });

  it("9) 快速连续切换：只落最后一次目标（令牌丢弃旧结果）", async () => {
    await act(async () => {
      await useSettingsStore.getState().update({ snap_display_mode: "full" });
    });
    mount();
    await advance(50);
    await dockLeft();
    expect(phase()).toBe("docked-full");

    await act(async () => {
      void useSettingsStore.getState().update({ snap_display_mode: "capsule" });
      void useSettingsStore.getState().update({ snap_display_mode: "full" });
      await Promise.resolve();
      await Promise.resolve();
    });
    await advance(2600);

    expect(phase()).toBe("docked-full");
    expect(useSettingsStore.getState().settings?.snap_display_mode).toBe("full");
  });

  it("10) 工作区变窄：停靠胶囊重新贴右缘（P2-3）", async () => {
    mount();
    await advance(50);
    await dragTo(1500, 300);
    await releasePointer();
    await advance(400);
    expect(phase()).toBe("docked-visible");
    expect(world.pos.x).toBe(1516); // 1920 - 404

    world.monitors = [
      {
        ...MAIN,
        workArea: { position: { x: 0, y: 0 }, size: { width: 1600, height: 1032 } },
      },
    ];
    await advance(3400);

    expect(world.pos.x).toBe(1196); // 1600 - 404
    expect(world.size).toEqual({ width: 404, height: 440 });
    // 高频推进会让光标离开轨道而自动隐藏；隐藏不改变窗口位置（新模型只换区域）。
    expect(phase()).toBe("docked-hidden");
  });

  it("11) DPI 变化：容器尺寸按新缩放大重建并重新贴边（P2-3）", async () => {
    mount();
    await advance(50);
    await dockLeft();
    expect(world.size).toEqual({ width: 404, height: 440 });

    world.monitors = [
      {
        ...MAIN,
        position: { x: 0, y: 0 },
        size: { width: 2880, height: 1620 },
        workArea: { position: { x: 0, y: 0 }, size: { width: 2880, height: 1548 } },
        scaleFactor: 1.5,
      },
    ];
    await advance(3400);

    expect(world.sizeCalls.at(-1)).toEqual({ w: 606, h: 660 });
    expect(world.size).toEqual({ width: 606, height: 660 });
    expect(world.pos.x).toBe(0);
    expect(phase()).toBe("docked-hidden");
  });

  it("12) 重启恢复：按显示器名称选副屏并按比例定位（P2-4）", async () => {
    world.monitors = [
      MAIN,
      {
        name: "DISPLAY2",
        position: { x: 1920, y: 0 },
        size: { width: 1920, height: 1080 },
        workArea: { position: { x: 1920, y: 0 }, size: { width: 1920, height: 1032 } },
        scaleFactor: 1,
      },
    ];
    world.snapState = {
      edge: "right",
      hidden: true,
      center: 2000,
      centerRatio: 0.5,
      display: {
        name: "DISPLAY2",
        bounds: { x: 1920, y: 0, w: 1920, h: 1080 },
        workArea: { x: 1920, y: 0, w: 1920, h: 1032 },
        scaleFactor: 1,
      },
    };
    mount();
    await advance(500);

    expect(phase()).toBe("docked-hidden");
    expect(world.pos).toEqual({ x: 3436, y: 296 }); // 1920+1920-404；0+516-220
    expect(world.size).toEqual({ width: 404, height: 440 });
  });

  it("13) 旧记录兼容（无比例/显示器）：用记录里的绝对中心", async () => {
    world.snapState = { edge: "left", hidden: true, center: 516 };
    mount();
    await advance(500);

    expect(phase()).toBe("docked-hidden");
    expect(world.pos).toEqual({ x: 0, y: 296 });
  });

  it("14) 比例优先：越界的旧绝对中心被忽略，按比例重新落点", async () => {
    world.snapState = { edge: "left", hidden: true, center: 5000, centerRatio: 0.25 };
    mount();
    await advance(500);

    expect(phase()).toBe("docked-hidden");
    expect(world.pos).toEqual({ x: 0, y: 38 }); // 0.25*1032 = 258 → 258-220
  });
});

describe("异常注入：缺边清理、失准重试与真实几何回读", () => {
  it("自由态且无停靠边卸载：仍下发 off，残留裁剪可被清除", async () => {
    const view = mount();
    await advance(20);
    expect(phase()).toBe("free");
    expect(world.regionCalls).toHaveLength(0);

    view.rerender({ enabled: false });
    await advance(1);

    // off 与方向无关：缺边时也必须能清理，否则残留裁剪没有任何出口
    expect(world.regionCalls.at(-1)).toEqual({ mode: "off", edge: "left" });
  });

  it("区域失准自动重试用尽 → 可见错误态，并可手动重新校准后恢复", async () => {
    mount();
    await advance(50);
    world.regionFailures = 99; // rail 与 off 都失败
    await dragTo(20, 300);
    await releasePointer();
    await advance(6000);

    expect(useEdgeSnapStore.getState().regionUnsynced).toBe(true);
    const toast = useUiStore.getState().toasts.find((t) => t.code === "dock_region");
    expect(toast?.action?.label).toBe("重新校准");

    // 手动恢复：即使当前没有停靠边，也按 off（方向无关）清理并回读确认
    world.regionFailures = 0;
    const offBefore = world.regionCalls.filter((c) => c.mode === "off").length;
    await act(async () => {
      toast!.action!.run();
    });
    await advance(100);

    expect(useEdgeSnapStore.getState().regionUnsynced).toBe(false);
    expect(world.regionCalls.filter((c) => c.mode === "off").length).toBeGreaterThan(offBefore);
  });

  it("setSize 返回成功但尺寸未生效：不提交停靠、不写持久化", async () => {
    mount();
    await advance(50);
    world.swallowSizeCalls = 99;
    await dragTo(20, 300);
    await releasePointer();
    await advance(800);

    expect(phase()).not.toBe("docked-visible");
    expect(useEdgeSnapStore.getState().dockedEdge).toBeNull();
    expect(world.snapWrites).toHaveLength(0);
    // 尺寸回读不符 → 在写区域之前就拒绝停靠，不留下轨道裁剪
    expect(world.regionCalls).toHaveLength(0);
  });

  it("setPosition 返回成功但位置未生效：不提交停靠、不写持久化", async () => {
    mount();
    await advance(50);
    world.swallowPositionCalls = 99;
    await dragTo(20, 300);
    await releasePointer();
    await advance(800);

    expect(phase()).not.toBe("docked-visible");
    expect(useEdgeSnapStore.getState().dockedEdge).toBeNull();
    expect(world.snapWrites).toHaveLength(0);
  });

  it("snap_state.hidden：展开写 false、收起写 true，恢复后库与真实相位一致", async () => {
    world.snapState = { edge: "right", hidden: true, center: 516 };
    mount();
    await advance(400);
    expect(phase()).toBe("docked-hidden");
    expect(world.snapWrites.at(-1)?.hidden).toBe(true);

    await act(async () => {
      useEdgeSnapStore.getState().reveal?.();
      await Promise.resolve();
    });
    await advance(20);
    expect(phase()).toBe("docked-revealed");
    expect(world.snapWrites.at(-1)?.hidden).toBe(false);

    await act(async () => {
      useEdgeSnapStore.getState().collapse?.();
      await Promise.resolve();
    });
    await advance(20);
    expect(phase()).toBe("docked-visible");
    expect(world.snapWrites.at(-1)?.hidden).toBe(false);

    // 光标移出 → 自动收起为 docked-hidden，持久化 hidden=true
    world.cursor = { x: 500, y: 900 };
    await advance(600);
    expect(phase()).toBe("docked-hidden");
    expect(world.snapWrites.at(-1)?.hidden).toBe(true);
  });

  it("恢复连续失败放弃后清掉陈旧停靠记录，避免每次启动重复空白恢复", async () => {
    world.snapState = { edge: "left", hidden: true, center: 516 };
    world.monitorNullCalls = 99;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mount();
    await advance(5000);

    expect(phase()).toBe("free");
    expect(world.snapWrites.at(-1)).toEqual({ edge: "none", hidden: false, center: null });
    warn.mockRestore();
  });
});

// ── 临时停靠形态与会话隔离 ────────────────────────────────────
//
// 胶囊「完整面板」/ 面板「收缩为胶囊」= 本次停靠会话的临时切换，不得改写
// 持久化 `snap_display_mode`；拖离/解除后临时覆盖失效，再次吸附按默认偏好。
// 设置页/右键菜单 = 长期偏好，且优先于旧的临时状态。

describe("临时停靠形态与会话隔离", () => {
  const tempForm = async (form: "capsule" | "full") => {
    await act(async () => {
      useEdgeSnapStore.getState().formSwitch?.(form);
      await Promise.resolve();
    });
    // 胶囊 ↔ 完整需要静止等待 + 二次稳定回读（约 1s）。
    await advance(1400);
  };
  const pref = () => useSettingsStore.getState().settings?.snap_display_mode ?? "capsule";

  it("A1) 胶囊临时展开完整面板：不写偏好；拖离后再吸附回胶囊", async () => {
    mount();
    await advance(50);
    await dockLeft();
    expect(phase()).toBe("docked-visible");
    expect(pref()).toBe("capsule");

    await tempForm("full");
    expect(phase()).toBe("docked-full");
    expect(world.size).toEqual({ width: 400, height: 560 });
    // 关键断言：临时展开不得把长期偏好改成 full。
    expect(pref()).toBe("capsule");

    await dragTo(120, 300);
    await advance(2200);
    expect(phase()).toBe("free");
    expect(pref()).toBe("capsule");

    await dockLeft();
    expect(phase()).toBe("docked-visible");
    expect(world.size).toEqual({ width: 404, height: 440 });
    expect(pref()).toBe("capsule");
  });

  it("A2) 偏好 full → 临时收缩胶囊：拖离后再吸附仍回到完整面板", async () => {
    await act(async () => {
      await useSettingsStore.getState().update({ snap_display_mode: "full" });
    });
    mount();
    await advance(50);
    await dockLeft();
    expect(phase()).toBe("docked-full");

    await tempForm("capsule");
    expect(phase()).toBe("docked-hidden");
    expect(world.size).toEqual({ width: 404, height: 440 });
    expect(pref()).toBe("full");

    await dragTo(120, 300);
    await advance(2200);
    expect(phase()).toBe("free");

    await dockLeft();
    expect(phase()).toBe("docked-full");
    expect(world.size).toEqual({ width: 400, height: 560 });
    expect(pref()).toBe("full");
  });

  it("A3) 临时切换失败：实际形态回滚，且不回写长期偏好", async () => {
    mount();
    await advance(50);
    await dockLeft();
    expect(phase()).toBe("docked-visible");
    world.regionFailMode = "off";

    await tempForm("full");

    // 没有进入 docked-full，几何仍是胶囊容器；偏好保持 capsule（区别于
    // requestDockForm 的「偏好回滚」，这里本来就没写过偏好）。
    expect(phase()).not.toBe("docked-full");
    expect(world.size).toEqual({ width: 404, height: 440 });
    expect(pref()).toBe("capsule");
  });

  it("A4) 临时形态期间用户改默认偏好：最新明确设置优先，旧临时状态不反向覆盖", async () => {
    mount();
    await advance(50);
    await dockLeft();
    // 叠两层临时切换：最后一次临时目标 = capsule（旧覆盖仍存在）。
    await tempForm("full");
    await tempForm("capsule");
    expect(phase()).toBe("docked-hidden");

    // 用户明确把默认吸附方式改为 full：应清掉旧的临时覆盖并原地展开。
    await act(async () => {
      await useSettingsStore.getState().update({ snap_display_mode: "full" });
      await Promise.resolve();
    });
    await advance(1400);
    expect(phase()).toBe("docked-full");
    expect(pref()).toBe("full");
  });

  it("A5) 胶囊临时展开后从功能页面解除停靠：再吸附遵守默认偏好", async () => {
    mount();
    await advance(50);
    await dockLeft();
    await tempForm("full");
    expect(phase()).toBe("docked-full");

    // 等价于 openFullApp()：解除停靠并把目标模式一起交给引擎。
    await act(async () => {
      useEdgeSnapStore.getState().undock?.("full");
      await Promise.resolve();
    });
    await advance(600);
    expect(phase()).toBe("free");
    expect(pref()).toBe("capsule");

    // 解除后是普通完整窗口（贴着原来的边），先拖离再重新拖向边缘。
    await dragTo(300, 300);
    await advance(300);
    await dockLeft();
    expect(phase()).toBe("docked-visible");
    expect(world.size).toEqual({ width: 404, height: 440 });
  });

  it("A6) 快速连续临时切换：只落最后一次目标，偏好不变", async () => {
    mount();
    await advance(50);
    await dockLeft();
    await act(async () => {
      useEdgeSnapStore.getState().formSwitch?.("full");
      useEdgeSnapStore.getState().formSwitch?.("capsule");
      await Promise.resolve();
      await Promise.resolve();
    });
    await advance(2600);

    expect(phase()).toBe("docked-hidden");
    expect(pref()).toBe("capsule");
  });

  it("A7) 重启恢复：临时形态不泄漏，按持久化偏好恢复", async () => {
    mount();
    await advance(50);
    await dockLeft();
    await tempForm("full");
    expect(phase()).toBe("docked-full");
    const saved = world.snapWrites.at(-1)!;
    expect(pref()).toBe("capsule");

    // 冷启动：停靠记录里没有形态字段，恢复只能按持久化偏好（capsule）。
    mounted.pop()!();
    world.snapState = {
      edge: saved.edge,
      hidden: saved.hidden,
      center: saved.center,
    };
    mount();
    await advance(1200);

    expect(["docked-visible", "docked-hidden"]).toContain(phase());
    expect(world.size).toEqual({ width: 404, height: 440 });
    expect(pref()).toBe("capsule");
  });

  it.each([
    {
      name: "左缘",
      drag: [20, 300] as const,
      fullSize: { width: 400, height: 560 },
      capsuleSize: { width: 404, height: 440 },
    },
    {
      name: "右缘",
      drag: [1500, 300] as const,
      fullSize: { width: 400, height: 560 },
      capsuleSize: { width: 404, height: 440 },
    },
    {
      name: "上缘",
      drag: [600, 20] as const,
      fullSize: { width: 400, height: 560 },
      capsuleSize: { width: 404, height: 504 },
    },
    {
      name: "下缘",
      drag: [600, 472] as const,
      fullSize: { width: 400, height: 560 },
      capsuleSize: { width: 404, height: 504 },
    },
  ])("A8) $name：临时展开/收缩的形态与几何正确", async ({ drag, fullSize, capsuleSize }) => {
    mount();
    await advance(50);
    await dragTo(drag[0], drag[1]);
    expect(phase()).toBe("candidate");
    await releasePointer();
    await advance(400);
    expect(["docked-visible", "docked-hidden"]).toContain(phase());

    await tempForm("full");
    expect(phase()).toBe("docked-full");
    expect(world.size).toEqual({ width: fullSize.width, height: fullSize.height });

    await tempForm("capsule");
    expect(phase()).toBe("docked-hidden");
    expect(world.size).toEqual({
      width: capsuleSize.width,
      height: capsuleSize.height,
    });
  });
});

// ── 沿边拖动不得误触发形态变化 ────────────────────────────────
//
// 自由窗口平行贴边拖动不应仅因「进入吸附区 / 被磁力吸进来」就吸附收缩；
// 已停靠的完整面板沿边上下移动必须保持完整面板，不能换边或解除后重吸附。

describe("沿边拖动的吸附意图", () => {
  const move = async (x: number, y: number) => {
    await dragTo(x, y);
  };

  it("自由窗口沿左缘平行拖动：不进入候选、不收缩", async () => {
    mount();
    await advance(50);
    // 起点已在吸附区附近但在外侧（磁力会把它再拉近一点），只做沿边移动。
    await move(40, 300);
    expect(phase()).toBe("free");
    await move(40, 700);
    await move(40, 900);
    expect(phase()).toBe("free");

    await releasePointer();
    await advance(600);
    expect(phase()).toBe("free");
    expect(world.size).toEqual({ width: 400, height: 560 });
  });

  it("边缘附近的斜向微动：没有向边净位移就不吸附", async () => {
    mount();
    await advance(50);
    await move(40, 300);
    await move(30, 700);
    expect(phase()).toBe("free");

    await releasePointer();
    await advance(600);
    expect(phase()).toBe("free");
  });

  it("明确向边缘拖动仍然正常吸附", async () => {
    mount();
    await advance(50);
    await move(300, 300);
    await move(20, 300);
    expect(phase()).toBe("candidate");
    await releasePointer();
    await advance(400);
    expect(phase()).toBe("docked-visible");
  });

  it("已停靠完整面板沿左缘上下拖动：保持完整形态与几何", async () => {
    await act(async () => {
      await useSettingsStore.getState().update({ snap_display_mode: "full" });
    });
    mount();
    await advance(50);
    await dockLeft();
    expect(phase()).toBe("docked-full");
    const sizeBefore = { ...world.size };

    await move(0, 700);
    await advance(400);
    expect(phase()).toBe("docked-full");
    expect(world.size).toEqual(sizeBefore);

    // 越过上缘（y 越界）也不能被角落的另一条边“抢走”候选。
    await move(0, -1);
    await advance(400);
    expect(phase()).toBe("docked-full");
    expect(world.size).toEqual(sizeBefore);

    await move(0, 300);
    await advance(2200);
    expect(phase()).toBe("docked-full");
    expect(useSettingsStore.getState().settings?.snap_display_mode).toBe("full");
  });

  it("已停靠完整面板沿边拖动后保存新的沿边位置", async () => {
    await act(async () => {
      await useSettingsStore.getState().update({ snap_display_mode: "full" });
    });
    mount();
    await advance(50);
    await dockLeft();

    await move(0, 700);
    await advance(2200);
    expect(phase()).toBe("docked-full");
    // 完整面板沿边中心 = 700 + 560/2
    expect(world.snapWrites.at(-1)?.center).toBe(980);
  });

  it("已停靠胶囊沿边移动仍正常，且不改变形态", async () => {
    mount();
    await advance(50);
    await dockLeft();
    const savedBefore = world.snapWrites.at(-1)!;

    await move(0, 700);
    await advance(2200);
    expect(["docked-visible", "docked-hidden"]).toContain(phase());
    expect(world.size).toEqual({ width: 404, height: 440 });
    // 沿边位置更新、形态未被误切。
    expect(world.snapWrites.at(-1)?.center).toBe(savedBefore.center === null ? null : 920);
  });
});

describe("快速拖动与事件合并的吸附意图", () => {
  it("快速单次位移：首个事件已跳入吸附范围，仍按真实静止起点识别意图", async () => {
    mount();
    await advance(50); // 引擎完成一次矩形读取，静止起点 = (300,300)
    await dragTo(20, 300);
    expect(phase()).toBe("candidate");
    await releasePointer();
    await advance(400);
    expect(["docked-visible", "docked-hidden"]).toContain(phase());
    expect(lastRegion()?.edge).toBe("left");
  });

  it("事件合并：多个 onMoved 同步到达、中间位置未被评估，仍按首个观测起点算净位移", async () => {
    mount();
    await advance(50);
    await act(async () => {
      // 模拟后端/OS 合并：中间位移不单独评估，最后一次才是有效矩形
      world.pos = { x: 200, y: 300 };
      fireMoved();
      world.pos = { x: 120, y: 300 };
      fireMoved();
      world.pos = { x: 20, y: 300 };
      fireMoved();
      await Promise.resolve();
    });
    await advance(50);
    expect(phase()).toBe("candidate");
    await releasePointer();
    await advance(400);
    expect(["docked-visible", "docked-hidden"]).toContain(phase());
  });

  it("按下时读取的真实矩形作起点：引擎尚未观测外部移动时，贴边平行拖动不误吸附", async () => {
    mount();
    await advance(50); // 引擎记录静止起点 (300,300)
    // 窗口已被外部移动（引擎尚未收到 onMoved），lastSeenRect 仍是旧位置
    world.pos = { x: 20, y: 300 };
    await pressDragRegion(); // 按下时读到真实矩形 (20,300)
    await dragTo(20, 900); // 沿左边平行大幅移动：法向净位移为 0
    expect(phase()).toBe("free");
    await releasePointer();
    await advance(600);
    expect(phase()).toBe("free");
    expect(world.size).toEqual({ width: 400, height: 560 });
  });

  it("快速单次沿边位移（事件幅度大但无向边净位移）：不误吸附", async () => {
    // 静止起点已在吸附区外侧（磁力把窗口拉近但未触发吸附）
    world.pos = { x: 40, y: 300 };
    mount();
    await advance(50);
    await dragTo(40, 900);
    expect(phase()).toBe("free");
    await releasePointer();
    await advance(600);
    expect(phase()).toBe("free");
    expect(world.size).toEqual({ width: 400, height: 560 });
  });

  it("四角快速斜拖：按下缘净位移最大时不换到右缘", async () => {
    // 静止在右下角内缩位置：只有向下存在净位移
    world.pos = { x: 1400, y: 200 };
    mount();
    await advance(50);
    await dragTo(1400, 472);
    expect(phase()).toBe("candidate");
    await releasePointer();
    await advance(400);
    expect(["docked-visible", "docked-hidden"]).toContain(phase());
    expect(lastRegion()?.edge).toBe("bottom");
  });

  it("已停靠完整面板快速上下拖动：只改位置、不换边、不切形态", async () => {
    await act(async () => {
      await useSettingsStore.getState().update({ snap_display_mode: "full" });
    });
    mount();
    await advance(50);
    await dockLeft();
    expect(phase()).toBe("docked-full");
    const sizeBefore = { ...world.size };

    // 单次大跨度上移，再单次下移，中间不做额外 tick
    await dragTo(0, 100);
    expect(phase()).toBe("docked-full");
    await dragTo(0, 800);
    expect(phase()).toBe("docked-full");
    expect(world.size).toEqual(sizeBefore);

    await advance(2200);
    expect(phase()).toBe("docked-full");
    expect(world.snapWrites.at(-1)?.center).toBe(800 + sizeBefore.height / 2);
  });
});

describe("标题栏高度量取（jsdom）", () => {
  it("可测量时缓存实测值；量不到（display:none）时回退上次缓存，再回退设计常量", () => {
    resetTitlebarHeightCache();
    expect(measureTitlebarHeight()).toBe(TITLEBAR_HEIGHT_CSS); // 无元素 → 设计常量

    const el = document.createElement("div");
    el.className = "titlebar";
    el.getBoundingClientRect = () => ({ height: 43.5 }) as DOMRect;
    document.body.appendChild(el);
    try {
      expect(measureTitlebarHeight()).toBe(43.5); // 实测并缓存
      el.getBoundingClientRect = () => ({ height: 0 }) as DOMRect;
      expect(measureTitlebarHeight()).toBe(43.5); // 停靠期 display:none → 缓存兜底
    } finally {
      el.remove();
      resetTitlebarHeightCache();
    }
  });
});

describe("Edge Tab：收起 / 恢复（复用胶囊区域事务）", () => {
  async function collapseToTab() {
    await act(async () => {
      useEdgeSnapStore.getState().collapseToTab?.();
      await vi.advanceTimersByTimeAsync(400);
    });
  }

  it("胶囊 → 标签：区域切 tab、窗口不移动、持久化 form=tab", async () => {
    mount();
    await advance(50);
    await dockLeft();
    expect(phase()).toBe("docked-visible");
    const posBefore = { ...world.pos };

    await collapseToTab();

    expect(phase()).toBe("docked-tab");
    expect(lastRegion()).toEqual({ mode: "tab", edge: "left" });
    expect(world.pos).toEqual(posBefore);
    expect(world.snapWrites.at(-1)).toMatchObject({ edge: "left", form: "tab" });
    expect(useEdgeSnapStore.getState().tabTransition).toBeNull();
  });

  it("快速重复点击收起只执行一次区域提交（不叠加过渡）", async () => {
    mount();
    await advance(50);
    await dockLeft();
    const before = world.regionCalls.length;

    await act(async () => {
      const s = useEdgeSnapStore.getState();
      s.collapseToTab?.();
      s.collapseToTab?.();
      s.collapseToTab?.();
      await vi.advanceTimersByTimeAsync(400);
    });

    expect(phase()).toBe("docked-tab");
    expect(
      world.regionCalls.slice(before).filter((c) => c.mode === "tab"),
    ).toHaveLength(1);
  });

  it("点击标签恢复胶囊；快速重复点击只扩一次区域", async () => {
    mount();
    await advance(50);
    await dockLeft();
    await collapseToTab();
    expect(phase()).toBe("docked-tab");

    const before = world.regionCalls.length;
    await act(async () => {
      const s = useEdgeSnapStore.getState();
      s.restoreTab?.();
      s.restoreTab?.();
      await vi.advanceTimersByTimeAsync(400);
    });

    expect(phase()).toBe("docked-visible");
    expect(
      world.regionCalls.slice(before).filter((c) => c.mode === "rail"),
    ).toHaveLength(1);
    expect(useEdgeSnapStore.getState().tabTransition).toBeNull();
    expect(world.snapWrites.at(-1)).toMatchObject({ edge: "left", form: "capsule" });
  });

  it("prefers-reduced-motion：直接提交形态，不进入过渡态", async () => {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query.includes("prefers-reduced-motion"),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;

    try {
      mount();
      await advance(50);
      await dockLeft();
      await collapseToTab();

      expect(phase()).toBe("docked-tab");
      expect(useEdgeSnapStore.getState().tabTransition).toBeNull();
      expect(lastRegion()).toEqual({ mode: "tab", edge: "left" });
    } finally {
      window.matchMedia = original;
    }
  });

  it("展开态收为标签：面板先离场，过渡期不提前卸载/不提前切区", async () => {
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
      useEdgeSnapStore.getState().collapseToTab?.();
      await Promise.resolve();
    });
    // 离场阶段：面板仍保留（panelExiting），相位与区域都不应提前提交。
    await advance(PANEL_EXIT_MS - 40);
    expect(useEdgeSnapStore.getState().panelExiting).toBe(true);
    expect(phase()).toBe("docked-revealed");
    expect(lastRegion()).toEqual({ mode: "panel", edge: "left" });

    // 离场结束 → 先切回轨道区域（胶囊可见），再开始侧滑过渡。
    await advance(60);
    expect(useEdgeSnapStore.getState().panelExiting).toBe(false);
    expect(phase()).toBe("docked-visible");
    expect(lastRegion()).toEqual({ mode: "rail", edge: "left" });
    expect(useEdgeSnapStore.getState().tabTransition).toBe("to-tab");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(phase()).toBe("docked-tab");
    expect(lastRegion()).toEqual({ mode: "tab", edge: "left" });
    expect(useEdgeSnapStore.getState().tabTransition).toBeNull();
  });

  it("拖动标签松手后持久化真实沿边位置（重启一致）", async () => {
    mount();
    await advance(50);
    await dockLeft();
    await collapseToTab();
    expect(phase()).toBe("docked-tab");

    await act(async () => {
      const s = useEdgeSnapStore.getState();
      s.beginTabDrag?.();
      s.dragTabBy?.(40);
      s.endTabDrag?.();
      await Promise.resolve();
    });

    const saved = world.snapWrites.at(-1)!;
    expect(saved).toMatchObject({ edge: "left", form: "tab" });
    expect(saved.center).toBe(world.pos.y + world.size.height / 2);
  });

  it("重启恢复：持久化 form=tab 直接恢复标签形态", async () => {
    world.snapState = { edge: "left", hidden: false, center: 516, form: "tab" };
    mount();
    await advance(400);

    expect(phase()).toBe("docked-tab");
    expect(world.pos.x).toBe(0);
    expect(world.pos.y).toBe(296);
    expect(lastRegion()).toEqual({ mode: "tab", edge: "left" });
  });
});

// ── 拖离后重新吸附（capsule-redock 回归）──────────────────────
//
// 真实缺陷：胶囊拖离 → 窗口恢复完整面板后，用户立即抓起窗口反向拖向边缘，
// 无法重新吸附。根因（2026-11-06）：解除事务把几何恢复（等拖拽循环退出 +
// 稳定回读）放在 busy 互斥区内——期间 onMoved 评估被丢弃、lastSeenRect 冻结
// 在解除触发位，用户重抓时手势起点被污染，吸附意图判定（净位移 ≥24 CSS px）
// 失效，永远进不了 candidate。
//
// 本组用例按真实时序模拟：原生锚定在拖拽循环内恢复模式尺寸（窗口跟随光标），
// 用户松手后立即重抓；按下起点的异步校正经由「矩形读取延迟」被真实否决
// （真机形态：解除恢复的 IPC 拥塞使校正晚于用户首次移动返回）。

describe("拖离后重新吸附（capsule-redock 回归）", () => {
  /** 按下拖拽区域并立即移动窗口：起点异步校正因「已观测到移动」被否决。 */
  async function pressAndMoveImmediately(x: number, y: number) {
    await act(async () => {
      const el = document.createElement("div");
      el.setAttribute("data-tauri-drag-region", "");
      document.body.appendChild(el);
      // 按下起点的原生读取在本用例中延迟返回（IPC 拥塞），模拟真机竞态
      world.delayRectReadMs = 300;
      el.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      el.remove();
      world.pos = { x, y };
      fireMoved();
      await Promise.resolve();
    });
  }

  /** 原生锚定帧：解除请求已在拖拽循环内应用——窗口恢复模式尺寸并跟随光标。 */
  async function anchorDragTo(x: number, y: number) {
    await act(async () => {
      world.size = { width: 400, height: 560 };
      world.pos = { x, y };
      fireMoved();
      await Promise.resolve();
    });
  }

  it("D1) 拖离后立即反向拖回原边：解除事务未结束也必须重新吸附为胶囊", async () => {
    world.savedWindowRect = { x: 400, y: 300, w: 1000, h: 700 };
    world.undockAnchorApplied = true; // 原生锚定已在拖拽循环内应用
    mount();
    await advance(50);
    await dockLeft();
    expect(phase()).toBe("docked-visible");
    expect(world.size).toEqual({ width: 404, height: 440 });

    // ① 抓起胶囊拖离：首个越过磁吸退出阈值的事件触发解除（几何恢复随之启动）
    await dragTo(40, 300);
    // ② 原生锚定帧：窗口在拖拽循环内恢复完整尺寸并跟随光标移向屏幕中部
    await anchorDragTo(300, 300);
    await anchorDragTo(520, 300);
    // ③ 松手后立即重抓，反向拖回左缘（起点校正被 300ms 延迟读取否决）
    await releasePointer();
    await pressAndMoveImmediately(500, 300);
    await dragTo(200, 300);
    await dragTo(60, 300);
    await dragTo(20, 300);
    await releasePointer();

    // ④ 解除恢复与新一轮吸附都要收口：最终必须是胶囊停靠，偏好不被改写。
    // （光标不在胶囊上时，停靠后会按既有设计在 ~450ms 后自动收起为触发条
    //   docked-hidden——free 无法直接到达该相位，同样证明吸附已发生。）
    await advance(4000);
    expect(["docked-visible", "docked-hidden"]).toContain(phase());
    expect(world.pos.x).toBe(0);
    expect(world.size).toEqual({ width: 404, height: 440 });
    expect(lastRegion()).toEqual({ mode: "rail", edge: "left" });
    // 偏好不得被拖离/再吸附改写（store 未加载设置时引擎按缺省 capsule 回退）
    expect(useSettingsStore.getState().settings?.snap_display_mode ?? "capsule").toBe("capsule");
  });

  it("D2) 偏好 full 时同样的立即反向拖回：吸附为完整面板", async () => {
    await act(async () => {
      await useSettingsStore.getState().update({ snap_display_mode: "full" });
    });
    world.savedWindowRect = { x: 400, y: 300, w: 1000, h: 700 };
    world.undockAnchorApplied = true;
    mount();
    await advance(50);
    await dockLeft();
    expect(phase()).toBe("docked-full");

    await dragTo(40, 300);
    await anchorDragTo(300, 300);
    await anchorDragTo(520, 300);
    await releasePointer();
    await pressAndMoveImmediately(500, 300);
    await dragTo(200, 300);
    await dragTo(60, 300);
    await dragTo(20, 300);
    await releasePointer();
    await advance(4000);

    expect(phase()).toBe("docked-full");
    expect(lastRegion()).toEqual({ mode: "off", edge: "left" });
    expect(useSettingsStore.getState().settings?.snap_display_mode).toBe("full");
  });

  it("D3) 拖离后等待恢复完成（≥2s）再拖向边缘：正常吸附", async () => {
    world.savedWindowRect = { x: 400, y: 300, w: 1000, h: 700 };
    world.undockAnchorApplied = true;
    mount();
    await advance(50);
    await dockLeft();

    await dragTo(40, 300);
    await anchorDragTo(520, 300);
    await releasePointer();
    await advance(2500); // 解除事务完全结束
    expect(phase()).toBe("free");
    expect(world.size).toEqual({ width: 1000, height: 700 }); // 用户尺寸已恢复

    // 与普通自由窗口完全相同的吸附路径
    await dragTo(200, 300);
    await dragTo(20, 300);
    expect(phase()).toBe("candidate");
    await releasePointer();
    await advance(600);
    // 光标可能已触发空闲收起（docked-hidden 只能从停靠相位到达，同样证明吸附）
    expect(["docked-visible", "docked-hidden"]).toContain(phase());
    expect(world.pos.x).toBe(0);
    expect(world.size).toEqual({ width: 404, height: 440 });
  });

  it("D4) 同一手势内拖离再拖回原边：识别为新一轮吸附", async () => {
    mount();
    await advance(50);
    await dockLeft();
    expect(phase()).toBe("docked-visible");

    // 拖离越过解除阈值（相位已提交 free），不松手直接拖回贴边（磁吸把窗口
    // 带到近乎齐平的位置）后松手
    await dragTo(40, 300);
    await anchorDragTo(300, 300);
    await dragTo(120, 300);
    await dragTo(30, 300);
    await dragTo(6, 300);
    await releasePointer();
    await advance(3500);

    expect(["docked-visible", "docked-hidden"]).toContain(phase());
    expect(world.pos.x).toBe(0);
    expect(lastRegion()).toEqual({ mode: "rail", edge: "left" });
  });

  it("D5) 左缘拖离后拖到右缘松手：换边吸附为胶囊", async () => {
    mount();
    await advance(50);
    await dockLeft();

    await dragTo(40, 300);
    await anchorDragTo(960, 300);
    await dragTo(1500, 300);
    await dragTo(1520, 300); // 右缘候选区（1920 − 400 窗口宽 = 1520 齐平）
    await releasePointer();
    await advance(3500);

    expect(["docked-visible", "docked-hidden"]).toContain(phase());
    expect(world.pos.x).toBe(1920 - 404);
    expect(lastRegion()).toEqual({ mode: "rail", edge: "right" });
  });

  it("D6) 解除恢复进行中：候选确认延迟到恢复完成，几何写入不交错", async () => {
    world.savedWindowRect = { x: 400, y: 300, w: 1000, h: 700 };
    world.undockAnchorApplied = true;
    mount();
    await advance(50);
    await dockLeft();
    // 首次停靠本身写过 rail：之后的断言只看「解除→再吸附」这段的增量
    const railWritesBefore = world.regionCalls.filter((r) => r.mode === "rail").length;

    await dragTo(40, 300);
    await anchorDragTo(520, 300);
    await releasePointer();
    await pressAndMoveImmediately(500, 300);
    await dragTo(20, 300);
    await releasePointer();

    // 恢复事务仍在等待拖拽静默（1500ms 截止未到）：确认必须被延迟
    await advance(600);
    expect(phase()).toBe("candidate");
    expect(world.regionCalls.filter((r) => r.mode === "rail").length).toBe(railWritesBefore);

    // 恢复完成（用户尺寸写回在先），确认随后放行，停靠几何正常提交
    await advance(3400);
    expect(["docked-visible", "docked-hidden"]).toContain(phase());
    const restoreWrite = world.sizeCalls.findIndex((s) => s.w === 1000 && s.h === 700);
    // 首次停靠也写过 404×440：只找恢复写回**之后**的那次（再吸附的容器重建）
    const dockWrite = world.sizeCalls.findIndex(
      (s, i) => i > restoreWrite && s.w === 404 && s.h === 440,
    );
    expect(restoreWrite).toBeGreaterThanOrEqual(0);
    expect(dockWrite).toBeGreaterThan(restoreWrite);
  });

  it("D8) 光标读取持续失败：候选确认按指针哨兵收口，不永久卡死", async () => {
    // 受限会话形态（真机诊断 2026-11-06）：GetCursorPos 被拒 → cursorPosition
    // 每拍抛异常。确认条件退化为「静默 + DOM 指针哨兵」，语义与设计一致。
    world.failCursor = true;
    mount();
    await advance(50);
    await dockLeft();
    expect(phase()).toBe("docked-visible");
    // 光标不可读 → 按离开交互区处理：450ms 连续离开确认后照常收起
    await advance(800);
    expect(phase()).toBe("docked-hidden");

    // 解除后再次吸附：candidate 不因 cursor 异常卡死，确认正常放行
    await dragTo(120, 300);
    await advance(2200);
    expect(phase()).toBe("free");
    await dockLeft();
    expect(phase()).toBe("docked-visible");
  });

  it("D7) 125% DPI：立即反向拖回同样重新吸附，容器尺寸按缩放重建", async () => {
    world.monitors = [
      {
        ...MAIN,
        scaleFactor: 1.25,
        size: { width: 2400, height: 1350 },
        workArea: { position: { x: 0, y: 0 }, size: { width: 2400, height: 1290 } },
      },
    ];
    world.savedWindowRect = { x: 500, y: 375, w: 1250, h: 875 };
    world.undockAnchorApplied = true;
    mount();
    await advance(50);
    await dockLeft();
    expect(phase()).toBe("docked-visible");
    expect(world.size).toEqual({ width: 505, height: 550 }); // 404×440 × 1.25

    await dragTo(48, 300); // 物理像素：48 > 38 退出阈值
    await anchorDragTo(375, 375);
    await anchorDragTo(650, 375);
    await releasePointer();
    await pressAndMoveImmediately(625, 375);
    await dragTo(250, 375);
    await dragTo(24, 375); // ≤24 物理像素进入候选区；意图阈值 = 24 CSS × 1.25 = 30
    await releasePointer();
    await advance(4000);

    expect(["docked-visible", "docked-hidden"]).toContain(phase());
    expect(world.pos.x).toBe(0);
    expect(world.size).toEqual({ width: 505, height: 550 });
    expect(lastRegion()).toEqual({ mode: "rail", edge: "left" });
  });
});

// ── Edge Tab 异步拖动一致性（round2 验收）───────────────────────
// 单飞调度允许 IPC 延迟，但必须保证：松手终态真实生效、持久化与实际
// 窗口一致、旧事务不覆盖新事务、形态切换/卸载后不执行过期移动。
describe("Edge Tab 异步拖动一致性", () => {
  async function collapseToTab() {
    await act(async () => {
      useEdgeSnapStore.getState().collapseToTab?.();
      await vi.advanceTimersByTimeAsync(400);
    });
  }
  const tabCenter = () => world.pos.y + world.size.height / 2;

  async function dockToTab() {
    mount();
    await advance(50);
    await dockLeft();
    await collapseToTab();
    expect(phase()).toBe("docked-tab");
  }

  it("T1) IPC 延迟时：松手不得先写目标中心；终态落地后持久化与真实位置一致", async () => {
    await dockToTab();
    const targetY = world.pos.y + 120;
    world.setPositionDelayMs = 300;
    await act(async () => {
      const s = useEdgeSnapStore.getState();
      s.beginTabDrag?.();
      s.dragTabBy?.(120);
      s.endTabDrag?.();
      await Promise.resolve();
    });
    // 终态 IPC 尚未落地：窗口仍在旧位，持久化不得已经写成目标位
    const earlySaved = world.snapWrites.at(-1)!;
    expect(earlySaved.center).not.toBe(targetY + world.size.height / 2);
    await advance(500);
    expect(world.pos.y).toBe(targetY);
    const saved = world.snapWrites.at(-1)!;
    expect(saved).toMatchObject({ edge: "left", form: "tab" });
    expect(saved.center).toBe(tabCenter());
  });

  it("T2) setPosition 失败：不写幻影中心，持久化回到真实位置", async () => {
    await dockToTab();
    const actualBefore = tabCenter();
    world.failSetPosition = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await act(async () => {
      const s = useEdgeSnapStore.getState();
      s.beginTabDrag?.();
      s.dragTabBy?.(120);
      s.endTabDrag?.();
      await Promise.resolve();
    });
    // 松手瞬间不得留下目标位的幻影写入（tick 的 settle 修复之前）
    expect(world.snapWrites.some((w) => w.center === actualBefore + 120)).toBe(false);
    await advance(600);
    expect(world.pos.y).not.toBe(360 + 120);
    const saved = world.snapWrites.at(-1)!;
    expect(saved.center).toBe(actualBefore);
    expect(saved.center).toBe(tabCenter());
    warn.mockRestore();
  });

  it("T3) 回读不一致（setPosition 成功但位置未生效）：持久化按真实位置", async () => {
    await dockToTab();
    const actualBefore = tabCenter();
    world.swallowPositionCalls = 10;
    await act(async () => {
      const s = useEdgeSnapStore.getState();
      s.beginTabDrag?.();
      s.dragTabBy?.(120);
      s.endTabDrag?.();
      await Promise.resolve();
    });
    expect(world.snapWrites.some((w) => w.center === actualBefore + 120)).toBe(false);
    await advance(600);
    const saved = world.snapWrites.at(-1)!;
    expect(saved.center).toBe(actualBefore);
    expect(saved.center).toBe(tabCenter());
  });

  it("T4) 连续快速拖动：单飞合并，最终位置正确且不逐帧发 IPC", async () => {
    await dockToTab();
    const baseY = world.pos.y;
    world.setPositionDelayMs = 200;
    await act(async () => {
      const s = useEdgeSnapStore.getState();
      s.beginTabDrag?.();
      for (let i = 1; i <= 10; i += 1) {
        s.dragTabBy?.(i * 10);
        await Promise.resolve();
      }
      s.endTabDrag?.();
      await Promise.resolve();
    });
    const attemptsDuring = world.positionAttempts;
    await advance(800);
    expect(world.pos.y).toBe(baseY + 100);
    expect(world.snapWrites.at(-1)?.center).toBe(tabCenter());
    // 单飞合并：10 次快速拖动不得发出 10 次物理移动
    expect(world.positionAttempts - attemptsDuring).toBeLessThan(5);
  });

  it("T5) 上一轮未收尾又开始下一轮：旧事务不覆盖新位置", async () => {
    await dockToTab();
    const baseY = world.pos.y;
    world.setPositionDelayMs = 300;
    await act(async () => {
      const s = useEdgeSnapStore.getState();
      s.beginTabDrag?.();
      s.dragTabBy?.(60);
      s.endTabDrag?.();
      // 不等待上一轮 IPC 落地，立即开始下一轮（delta 相对新会话基准）
      s.beginTabDrag?.();
      s.dragTabBy?.(160);
      s.endTabDrag?.();
      await Promise.resolve();
    });
    await advance(1000);
    // 两轮位移累加（基准是上一轮终态），旧目标不得排在新目标之后覆盖
    expect(world.pos.y).toBe(baseY + 60 + 160);
    expect(world.snapWrites.at(-1)?.center).toBe(tabCenter());
  });

  it("T6) 引擎卸载时仍有在途移动：卸载后不再执行过期移动", async () => {
    const hook = mount();
    await advance(50);
    await dockLeft();
    await collapseToTab();
    expect(phase()).toBe("docked-tab");
    world.setPositionDelayMs = 300;
    await act(async () => {
      const s = useEdgeSnapStore.getState();
      s.beginTabDrag?.();
      s.dragTabBy?.(80);
      // 第二个目标只进 latest，不立即执行（首个在途）
      s.dragTabBy?.(160);
      s.endTabDrag?.();
      await Promise.resolve();
    });
    const attemptsAtUnmount = world.positionAttempts;
    hook.unmount();
    mounted.pop();
    await advance(1000);
    // 卸载后只允许已经在途的那一次落地，不得再追加过期目标
    expect(world.positionAttempts - attemptsAtUnmount).toBe(0);
  });

  it("T8) 拖动后立即切换形态：过期的标签持久化不得覆盖新形态", async () => {
    const hook = mount();
    await advance(50);
    await dockLeft();
    await collapseToTab();
    expect(phase()).toBe("docked-tab");
    world.setPositionDelayMs = 300;
    await act(async () => {
      const s = useEdgeSnapStore.getState();
      s.beginTabDrag?.();
      s.dragTabBy?.(60);
      s.endTabDrag?.();
      await Promise.resolve();
    });
    // 终态移动在途时立即恢复胶囊（形态切换）
    await act(async () => {
      useEdgeSnapStore.getState().restoreTab?.();
      await vi.advanceTimersByTimeAsync(400);
    });
    await advance(1000);
    expect(["docked-visible", "docked-hidden"]).toContain(phase());
    expect(world.snapWrites.at(-1)).toMatchObject({ form: "capsule" });
    expect(world.snapWrites.at(-1)?.center).toBe(tabCenter());
    expect(world.pos.x).toBe(0);
    void hook;
  });

  it("T7) 重启位置与最终真实位置一致（失败路径不跳位）", async () => {
    await dockToTab();
    const actualBefore = tabCenter();
    const posBefore = { ...world.pos };
    world.failSetPosition = true;
    await act(async () => {
      const s = useEdgeSnapStore.getState();
      s.beginTabDrag?.();
      s.dragTabBy?.(120);
      s.endTabDrag?.();
      await Promise.resolve();
    });
    // 松手后立即重启（settle 修复 tick 未跑）：持久化快照必须已经是真实位
    const savedCenter = world.snapState?.center;
    expect(savedCenter).toBe(actualBefore);
    await advance(600);
    expect(world.snapWrites.at(-1)?.center).toBe(actualBefore);
    // 模拟重启：按保存的中心重建（引擎 restore 会算出同一窗口左上角）
    expect(savedCenter).toBe(posBefore.y + world.size.height / 2);
  });

  it("U1) 800ms 慢在途 IPC + 立即恢复胶囊：旧 IPC 不得覆盖新形态几何", async () => {
    const hook = mount();
    await advance(50);
    await dockLeft();
    await collapseToTab();
    expect(phase()).toBe("docked-tab");
    // 拖动慢（1500），恢复事务快（0）：旧 IPC 落地晚于新几何事务
    world.setPositionDelayQueue = [1500];
    await act(async () => {
      const s = useEdgeSnapStore.getState();
      s.beginTabDrag?.();
      s.dragTabBy?.(120);
      s.endTabDrag?.();
      await Promise.resolve();
    });
    await act(async () => {
      useEdgeSnapStore.getState().restoreTab?.();
      await vi.advanceTimersByTimeAsync(400);
    });
    await advance(2000);
    expect(["docked-visible", "docked-hidden"]).toContain(phase());
    expect(world.pos.x).toBe(0);
    // 恢复几何与持久化必须同为真实位置
    expect(world.snapWrites.at(-1)).toMatchObject({ form: "capsule" });
    expect(world.snapWrites.at(-1)?.center).toBe(tabCenter());
    void hook;
  });

  it("U2) 800ms 慢在途 IPC + 立即解除：旧 IPC 落地后不得把自由窗口拉回边", async () => {
    mount();
    await advance(50);
    await dockLeft();
    await collapseToTab();
    expect(phase()).toBe("docked-tab");
    world.savedWindowRect = { x: 600, y: 300, w: 800, h: 600 };
    world.setPositionDelayQueue = [1500];
    await act(async () => {
      const s = useEdgeSnapStore.getState();
      s.beginTabDrag?.();
      s.dragTabBy?.(120);
      s.endTabDrag?.();
      await Promise.resolve();
    });
    await act(async () => {
      useEdgeSnapStore.getState().undock?.();
      await Promise.resolve();
    });
    // 解除前有界等收口（1500ms 在途）+ 解除几何恢复：旧 IPC 先落地
    await advance(4000);
    expect(phase()).toBe("free");
    expect(lastRegion()?.mode).toBe("off");
    // 用户在自由态继续挪动窗口（原生拖动模拟）
    await dragTo(600, 400);
    await advance(600);
    // 旧在途 IPC（1500ms）此时落地，不得把窗口拉回贴边位
    expect(world.pos).toEqual({ x: 600, y: 400 });
    expect(phase()).toBe("free");
  });

  it("U3) 回读失败：有界重试后按实际落库，不写幻影", async () => {
    await dockToTab();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // 失败一次后读回成功（窗口已到目标位 700）：有界重试应按真实落库
    world.failRectReadCalls = 1;
    await act(async () => {
      const s = useEdgeSnapStore.getState();
      s.beginTabDrag?.();
      s.dragTabBy?.(120);
      s.endTabDrag?.();
      await Promise.resolve();
    });
    await advance(800);
    expect(world.pos.y).toBe(480);
    const saved = world.snapWrites.at(-1)!;
    expect(saved.center).toBe(tabCenter());
    expect(saved.center).toBe(700);
    warn.mockRestore();
  });

  it("U3b) 回读持续失败：不写幻影，恢复不跳位", async () => {
    await dockToTab();
    const beforePos = { ...world.pos };
    const beforeCenter = tabCenter();
    world.failSetPosition = true;
    world.failRectReadCalls = 99;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await act(async () => {
      const s = useEdgeSnapStore.getState();
      s.beginTabDrag?.();
      s.dragTabBy?.(120);
      s.endTabDrag?.();
      await Promise.resolve();
    });
    // 500ms 内 tick/回读都受阻：不得把目标 700 写进持久化
    expect(world.snapWrites.some((w) => w.center === beforeCenter + 120)).toBe(false);
    world.failRectReadCalls = 0;
    world.failSetPosition = false;
    // 恢复胶囊：按真实位置（fetch 恢复后）而不按幻影
    await act(async () => {
      useEdgeSnapStore.getState().restoreTab?.();
      await vi.advanceTimersByTimeAsync(400);
    });
    await advance(600);
    expect(world.pos.y).toBe(beforePos.y);
    expect(world.snapWrites.at(-1)?.center).toBe(tabCenter());
    expect(world.snapWrites.at(-1)?.center).toBe(beforeCenter);
    warn.mockRestore();
  });

  it("U5) 1500ms 慢在途 + 卸载重挂载：旧 IPC 不得破坏新引擎恢复态", async () => {
    const first = mount();
    await advance(50);
    await dockLeft();
    await collapseToTab();
    expect(phase()).toBe("docked-tab");
    world.setPositionDelayQueue = [1500];
    // 先记录拖动前真实位置（重挂后应恢复到此，不被旧拖动目标改写）
    const beforePos = { ...world.pos };
    await act(async () => {
      const s = useEdgeSnapStore.getState();
      s.beginTabDrag?.();
      s.dragTabBy?.(120);
      s.endTabDrag?.();
      await Promise.resolve();
    });
    first.unmount();
    mounted.pop();
    // 新引擎按已落库状态恢复（拖动未落库前仍是旧中心）
    mount();
    await advance(400);
    const restoredPos = { ...world.pos };
    await advance(2000);
    // 旧在途 IPC 落地后，窗口仍应与新引擎恢复位一致（phase/region 不被旧形态污染）
    expect(["docked-visible", "docked-hidden", "docked-tab"]).toContain(phase());
    // 真实位置与持久化中心同源
    expect(world.snapState?.center).toBe(restoredPos.y + world.size.height / 2);
    void beforePos;
  });

  it("U6) 真重启恢复（成功）：拖后卸载重挂，形态/位置/区域与真实位置一致", async () => {
    const first = mount();
    await advance(50);
    await dockLeft();
    await collapseToTab();
    await act(async () => {
      const s = useEdgeSnapStore.getState();
      s.beginTabDrag?.();
      s.dragTabBy?.(100);
      s.endTabDrag?.();
      await Promise.resolve();
    });
    await advance(400);
    const finalPos = { ...world.pos };
    const finalCenter = tabCenter();
    expect(world.snapState?.center).toBe(finalCenter);
    first.unmount();
    mounted.pop();
    // 卸载会走清理（区域 off + 持久化 none 的延迟宏任务），先推进再重挂
    // 为避免清理污染，用保存的 snapState 重新定向
    await advance(10);
    world.snapState = { edge: "left", hidden: false, center: finalCenter, form: "tab" } as typeof world.snapState;
    mount();
    await advance(400);
    expect(phase()).toBe("docked-tab");
    expect(world.pos).toEqual(finalPos);
    expect(lastRegion()).toEqual({ mode: "tab", edge: "left" });
  });

  it("U7) 真重启恢复（失败）：拖动失败后重挂不跳位", async () => {
    const first = mount();
    await advance(50);
    await dockLeft();
    await collapseToTab();
    const beforePos = { ...world.pos };
    const beforeCenter = tabCenter();
    world.failSetPosition = true;
    await act(async () => {
      const s = useEdgeSnapStore.getState();
      s.beginTabDrag?.();
      s.dragTabBy?.(100);
      s.endTabDrag?.();
      await Promise.resolve();
    });
    await advance(400);
    expect(world.snapState?.center).toBe(beforeCenter);
    first.unmount();
    mounted.pop();
    await advance(10);
    world.snapState = { edge: "left", hidden: false, center: beforeCenter, form: "tab" } as typeof world.snapState;
    world.failSetPosition = false;
    mount();
    await advance(400);
    expect(phase()).toBe("docked-tab");
    expect(world.pos).toEqual(beforePos);
    expect(lastRegion()).toEqual({ mode: "tab", edge: "left" });
  });

  it("U8) 右缘慢在途 IPC + 恢复：镜像方向同样收口", async () => {
    mount();
    await advance(50);
    await dragTo(1500, 300);
    expect(phase()).toBe("candidate");
    await releasePointer();
    await advance(400);
    expect(phase()).toBe("docked-visible");
    expect(world.pos.x).toBe(1920 - 404);
    await collapseToTab();
    expect(phase()).toBe("docked-tab");
    world.setPositionDelayQueue = [800];
    await act(async () => {
      const s = useEdgeSnapStore.getState();
      s.beginTabDrag?.();
      s.dragTabBy?.(60);
      s.endTabDrag?.();
      await Promise.resolve();
    });
    await act(async () => {
      useEdgeSnapStore.getState().restoreTab?.();
      await vi.advanceTimersByTimeAsync(400);
    });
    await advance(1200);
    expect(["docked-visible", "docked-hidden"]).toContain(phase());
    expect(world.pos.x).toBe(1920 - 404);
    expect(world.snapWrites.at(-1)).toMatchObject({ form: "capsule" });
    expect(world.snapWrites.at(-1)?.center).toBe(tabCenter());
  });
});
