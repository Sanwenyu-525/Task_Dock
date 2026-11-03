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
  notifyReadyCalls: 0,
  magnetConfigCalls: [],
  magnetDockCalls: [],
  undockAnchorCalls: [],
  undockAnchorApplied: false,
  undockAnchorCancelled: 0,
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
  world.notifyReadyCalls = 0;
  world.magnetConfigCalls = [];
  world.magnetDockCalls = [];
  world.undockAnchorCalls = [];
  world.undockAnchorApplied = false;
  world.undockAnchorCancelled = 0;
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
import {
  snapMoveGuard,
  measureTitlebarHeight,
  resetTitlebarHeightCache,
  TITLEBAR_HEIGHT_CSS,
} from "../lib/edgeSnap";

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
  overlayMock.blocking = false;
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

  it("窗口小于胶囊容器时先撑到 404×440（否则面板放不下）", async () => {
    world.size = { width: 280, height: 140 }; // minimal 模式
    mount();
    await advance(50);
    await dockLeft();

    expect(world.sizeCalls.at(-1)).toEqual({ w: 404, h: 440 });
    expect(phase()).toBe("docked-visible");
  });

  it("Aero Snap 半屏尺寸（1280×690）在停靠时归一为容器 404×440", async () => {
    world.pos = { x: 20, y: 300 };
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

  it("菜单/对话框在场时暂停自动收起，弹层关闭后恢复自动收起", async () => {
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
    await advance(900);
    // 弹层在场时不得自动收起
    expect(phase()).toBe("docked-revealed");

    overlayMock.blocking = false; // 弹层关闭
    await advance(900);
    expect(phase()).toBe("docked-hidden");
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
