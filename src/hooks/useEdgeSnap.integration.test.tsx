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
  /** 接下来 N 次 currentMonitor() 返回 null（窗口尚未显示/显示器暂不可用） */
  monitorNullCalls: number;
  setPositionCalls: Array<{ x: number; y: number }>;
  /** setPosition 调用次数（含失败），用于验证失败路径不会逐 tick 重发。 */
  positionAttempts: number;
  sizeCalls: Array<{ w: number; h: number }>;
  regionCalls: Array<{ mode: string; edge: string }>;
  snapWrites: Array<{ edge: string; hidden: boolean; center: number | null }>;
  rectWrites: Array<{ x: number; y: number; w: number; h: number }>;
  modeCalls: string[];
  /** applyMode 失败（模拟解除后尺寸恢复失败） */
  failApplyMode: boolean;
  /** 接下来 N 次 applyMode 被原生拖拽循环吞掉：返回成功但窗口尺寸不变 */
  swallowModeSizeCalls: number;
  snapState: { edge: string; hidden: boolean; center?: number | null } | null;
  /** 持续移动失败（真机形态：setPosition 被系统拒绝，用于验证不写幻影基准） */
  failSetPosition: boolean;
  /** 持续缩放失败（模拟区域撑容器时 setSize 被系统拒绝） */
  failSetSize: boolean;
  /** 第 N 次 setSize 调用失败（1 起算）；null = 不按序号失败（用于回滚失败用例） */
  setSizeFailAt: number | null;
  /** 接下来 N 次 apply_window_capsule 返回 false（区域未应用/回读校验失败） */
  regionFailures: number;
  /** 指定形态的区域写入**一直**返回 false（模拟后端对该形态持续拒绝） */
  regionFailMode: string | null;
  /** 指定形态的区域 IPC 永不返回（模拟 invoke 挂起，用于超时用例） */
  regionHangMode: string | null;
  /** 挂起的区域请求：测试可手动 resolve，验证迟到响应不会覆盖新状态 */
  regionHangs: Array<{ mode: string; resolve: (v: boolean) => void }>;
  movedHandlers: Array<() => void>;
  recallHandlers: Array<() => void>;
}

const world: World = {
  pos: { x: 0, y: 300 },
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
  setSizeFailAt: null,
  regionFailures: 0,
  regionFailMode: null,
  regionHangMode: null,
  regionHangs: [],
  movedHandlers: [],
  recallHandlers: [],
};

function resetWorld() {
  world.pos = { x: 0, y: 300 };
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
  world.setSizeFailAt = null;
  world.regionFailures = 0;
  world.regionFailMode = null;
  world.regionHangMode = null;
  world.regionHangs = [];
  world.movedHandlers = [];
  world.recallHandlers = [];
}

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    outerPosition: async () => ({ x: world.pos.x, y: world.pos.y }),
    outerSize: async () => ({ width: world.size.width, height: world.size.height }),
    setPosition: async (p: { x: number; y: number }) => {
      world.positionAttempts += 1;
      if (world.failSetPosition) throw new Error("mock setPosition rejected");
      world.setPositionCalls.push({ x: p.x, y: p.y });
      world.pos = { x: p.x, y: p.y };
    },
    setSize: async (s: { width: number; height: number }) => {
      world.sizeCalls.push({ w: s.width, h: s.height });
      const callNo = world.sizeCalls.length;
      if (world.failSetSize || (world.setSizeFailAt !== null && callNo >= world.setSizeFailAt)) {
        throw new Error("mock setSize rejected");
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
  cursorPosition: async () => ({ x: world.cursor.x, y: world.cursor.y }),
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
  saveSnapState: async (edge: string, hidden: boolean, center: number | null = null) => {
    world.snapWrites.push({ edge, hidden, center });
    world.snapState = { edge, hidden, center };
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
import { snapMoveGuard } from "../lib/edgeSnap";

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
  snapMoveGuard.reset();
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

  it("Aero Snap 半屏尺寸（1280×690）在停靠时归一为容器 400×420", async () => {
    world.pos = { x: 20, y: 300 };
    world.size = { width: 1280, height: 690 }; // Windows 先把窗口吸成左半屏
    mount();
    await advance(50);
    await dragTo(20, 300);
    await releasePointer();
    await advance(400);

    expect(phase()).toBe("docked-visible");
    expect(world.size).toEqual({ width: 400, height: 420 });
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
    // 停靠时窗口归一为容器高 420，中心 516 → y = 516 - 210 = 306
    expect(world.pos.y).toBe(306);
    expect(world.size).toEqual({ width: 400, height: 420 });
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
    expect(world.size).toEqual({ width: 400, height: 420 }); // 停靠容器

    world.swallowModeSizeCalls = 1; // 第一次 applyMode 返回成功但尺寸未变
    await dragTo(120, 300);
    await advance(2200);

    expect(phase()).toBe("free");
    expect(world.modeCalls.filter((m) => m === "full").length).toBeGreaterThanOrEqual(2);
    expect(world.size).toEqual({ width: 400, height: 560 }); // full 模式已真正恢复
    // 任何写入都不得是胶囊容器尺寸
    expect(world.rectWrites.some((r) => r.w === 400 && r.h === 420)).toBe(false);
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
    expect(world.size).toEqual({ width: 400, height: 420 });
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
    // 冷却后自动重试成功解除，再拖向另一条边才进入新边候选
    await advance(2200);
    expect(phase()).toBe("free");
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
    expect(world.sizeCalls.at(-1)).toEqual({ w: 280, h: 140 }); // 不遗留 400×420
    expect(world.setPositionCalls).toHaveLength(0);
    expect(world.regionCalls).toHaveLength(0);
    expect(world.snapWrites).toHaveLength(0);
  });

  it("resize 失败、move 成功、region 失败：恢复原位置，不重复 setSize", async () => {
    world.size = { width: 280, height: 140 };
    world.failSetSize = true;
    world.regionFailMode = "rail";
    mount();
    await advance(50);
    await dragTo(20, 300);
    await releasePointer();
    await advance(400);

    expect(phase()).toBe("candidate");
    expect(world.setPositionCalls.at(-1)).toEqual({ x: 20, y: 300 });
    // 尺寸从未改变（setSize 一直失败）：回滚只能尝试撑容器，绝不能发恢复尺寸
    expect(world.sizeCalls.every((c) => c.w === 400 && c.h === 420)).toBe(true);
    // 每一次 rail 失败后都必须紧跟一次 off 校准
    const modes = world.regionCalls.map((c) => c.mode);
    for (let i = 0; i < modes.length; i += 1) {
      if (modes[i] === "rail") expect(modes[i + 1]).toBe("off");
    }
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
    expect(world.pos.x).toBe(1920 - 400);
    expect(lastRegion()).toEqual({ mode: "rail", edge: "right" });
  });
});
