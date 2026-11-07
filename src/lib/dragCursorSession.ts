//! 窗口拖拽光标会话（主窗标题栏 / 胶囊轨道 / 工具面板标题 / 桌面微件共用）。
//!
//! ## 为什么需要原生信号
//! `data-tauri-drag-region` 的按下会调用 `startDragging`，进入 Win32 的**系统模态
//! 移动循环**；循环期间 WebView2 收不到任何指针事件，所以松手时没有 `pointerup`。
//! 旧实现只能在「指针恢复派发」时补一条 `pointermove`（`buttons === 0`）来收尾：
//! 用户松开左键后必须再动一下鼠标，`grabbing` 才会消失——这正是要修的观感问题。
//!
//! 真正的结束信号在窗口过程里：`WM_EXITSIZEMOVE`。原生侧（主窗 `magnetic.rs`、
//! 微件 `drag_watch.rs`）在循环开始/结束时各发一次 `window-drag`
//! （载荷 `{ phase, generation }`，见 `src-tauri/src/drag_signal.rs`）。
//!
//! ## 代次（generation）解决的是跨会话竞态
//! 事件是异步的：旧拖拽的结束信号可能在用户**已经开始下一次拖拽**之后才被消费。
//! 如果收到结束就结束全部会话，就会出现「鼠标还按着、抓手指针却没了」。
//! 因此：
//!
//! - 会话在收到 `phase: "start"` 时绑定该代次（`generation`）；
//! - 只有代次**完全匹配**的 `phase: "end"` 才会结束它；
//! - 尚未绑定代次的会话（例如 `startDragging` 没走到原生循环）不受任何原生
//!   结束信号影响，继续由 `pointerup` / `pointermove` 兜底收尾。
//!
//! ## start 也必须证明「属于谁」
//! 只比较结束代次还不够：旧拖拽的 **start** 也可能迟到。若此时用户已经开始
//! 新会话 B，无条件 `bind(start.generation)` 会把旧代次写给 B，随后旧 end 就把
//! B 清掉——鼠标仍按着、抓手指针却消失。原生事件本身不携带前端会话身份，
//! 因此用两个确定性条件建立关联（不依赖延时或轮询）：
//!
//! 1. **会话快照**：只绑定「收到 start 那一刻已存在」的会话。查询期间才创建的
//!    会话不会被旧 start 认领；
//! 2. **原生实时确认**：向原生查询该代次的移动循环**此刻是否仍在运行**
//!    （`drag_loop_active`）。系统模态循环期间 WebView2 收不到指针事件，所以
//!    循环活跃时存在的会话只可能是它的发起者；循环已退出则说明这条 start 属于
//!    已经结束的拖拽，绝不绑定。
//!
//! 查询是每次原生起拖一次的 IPC 往返（不是轮询）。若结果在 end 之后才回来，
//! 说明这次拖拽的循环已经结束：直接收尾快照里的会话，而不是留下一个永远等不到
//! `pointerup` 的 grab。查询不可用时宁可不绑定，交给指针事件兜底。
//!
//! 重复的结束信号是幂等的（会话已结束后不再是活动会话，遍历不到）。
//!
//! ## 仍然保留的兜底路径
//! 不是所有拖动都走原生循环（例如没有 drag-region 的普通点击、拖动中途失焦、
//! 页面隐藏），所以 `pointerup` / `pointercancel` / `visibilitychange` 仍然结束会话；
//! `pointermove` 只认 `buttons === 0`，`blur` 只在起始 120ms 之后生效（起始内的
//! blur 是 `startDragging` 激活窗口造成的扰动，见 TooltipLayer 的实测结论）。
//!
//! ## 不会做什么
//! - 不模拟鼠标移动、不轮询、不用固定 timeout 猜拖动是否结束；
//! - 不合并窗口几何逻辑：这里只负责「按下 / 结束 / 干净摘监听」，
//!   吸附、磁力、区域裁剪仍由 `useEdgeSnap` 与原生移植层负责。
//!
//! 会话结束（任何路径）都会从活动集合移除；组件卸载时 `dispose()` 幂等，
//! 监听成对摘除，不会累积。

import { useEffect, useRef, type RefObject } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke, isTauri } from "@tauri-apps/api/core";

/** 拖拽期间加在宿主上的类名（CSS 侧统一切 `grabbing`）。 */
export const DRAG_SESSION_CLASS = "is-dragging";

/** 起始扰动窗口：这段时间内的 blur / `buttons=0` 移动不算结束。 */
const START_CHURN_MS = 120;

/**
 * 原生拖拽相位事件名（窗口级 emit，只发给发出它的那个窗口）。
 * 载荷：`{ phase: "start" | "end", generation: number }`。
 */
export const NATIVE_DRAG_EVENT = "window-drag";

/**
 * 原生查询：指定代次的系统移动循环**此刻**是否仍在运行。
 *
 * `start` / `end` 只携带代次，不携带前端会话身份；这是把 start 关联到正确
 * 会话的唯一实时事实。命令必须异步执行（`commands::system::drag_loop_active`），
 * 否则会被模态移动循环所在的主线程排队，永远只能看到「已结束」。
 */
export const NATIVE_DRAG_QUERY = "drag_loop_active";

/** 一次进行中的拖拽会话。 */
interface LiveSession {
  /** 绑定到的原生移动循环代次；`null` = 尚未收到 start（非原生拖拽路径）。 */
  generation: number | null;
  ended: boolean;
  teardown: (() => void) | null;
  /** 结束本会话（幂等，可从任意结束路径调用）。 */
  end: () => void;
}

/** 当前存活会话（同一个 webview 内最多一个在拖）。会话结束即移除。 */
const activeSessions = new Set<LiveSession>();

/** 已确认结束的最大代次：迟到的关联结果不得再绑定到已结束的循环。 */
let highestEndedGeneration = 0;

let bridgeInstalled = false;

function parseGeneration(payload: unknown): number | null {
  if (typeof payload !== "object" || payload === null) return null;
  const value = (payload as { generation?: unknown }).generation;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function parsePhase(payload: unknown): "start" | "end" | null {
  if (typeof payload !== "object" || payload === null) return null;
  const value = (payload as { phase?: unknown }).phase;
  return value === "start" || value === "end" ? value : null;
}

/** 原生移动循环是否仍在运行；查询失败时保守返回 false（不绑定，走指针兜底）。 */
async function isNativeLoopRunning(generation: number): Promise<boolean> {
  try {
    return (await invoke<boolean>(NATIVE_DRAG_QUERY, { generation })) === true;
  } catch {
    return false;
  }
}

/**
 * 把一条原生 `start` 关联到正确的会话。
 *
 * 只对**收到 start 时已存在**的会话做关联，并等待原生确认「该代次的循环仍在
 * 运行」。两个条件缺一不可：旧 start 迟到时，循环早已退出，查询必然为 false；
 * 而查询期间才出现的新会话不在快照里，不会被旧代次认领。
 */
function associateStart(generation: number): void {
  const candidates = [...activeSessions].filter((session) => !session.ended);
  if (candidates.length === 0) return;
  void isNativeLoopRunning(generation).then((running) => {
    if (!running) return;
    if (generation <= highestEndedGeneration) {
      // 查询在循环结束前受理、结果却晚于 end 返回：本次拖拽的原生循环已经结束。
      // 此时绑定代次会让会话永远等不到 pointerup，应直接收尾。
      for (const session of candidates) {
        if (!session.ended) session.end();
      }
      return;
    }
    for (const session of candidates) {
      // 已结束或已绑定（重复 start）的会话不重复认领，避免旧结果覆盖新代次。
      if (session.ended || session.generation !== null) continue;
      session.generation = generation;
    }
  });
}

/** 结束代次匹配的会话；代次不匹配的（新会话）保持不变。 */
function endMatchingSessions(generation: number): void {
  highestEndedGeneration = Math.max(highestEndedGeneration, generation);
  for (const session of [...activeSessions]) {
    if (session.ended) continue;
    if (session.generation !== generation) continue;
    session.end();
  }
}

/**
 * 安装原生拖拽相位桥：每个 webview 入口调用一次（主窗 `main.tsx`、微件 `widgets/main.tsx`）。
 * 浏览器预览没有 Tauri 运行时，直接跳过；重复调用是 no-op。
 */
export function installNativeDragBridge(): void {
  if (bridgeInstalled || !isTauri()) return;
  bridgeInstalled = true;
  void listen(NATIVE_DRAG_EVENT, (event) => {
    const generation = parseGeneration(event.payload);
    const phase = parsePhase(event.payload);
    // 协议不完整的事件不猜语义：宁可交给指针事件兜底，也不误清新会话。
    if (generation === null || phase === null) return;
    if (phase === "start") associateStart(generation);
    else endMatchingSessions(generation);
  }).catch(() => {
    // 事件系统不可用（例如集成环境未注入）：保留指针事件兜底路径
    bridgeInstalled = false;
  });
}

export interface DragCursorSessionOptions {
  /**
   * 会话状态变化。需要把「是否拖动中」画进 React 输出的组件必须订阅它：
   * React 重渲染会用 className 覆盖掉直接改的 DOM 类，二者需保持一致。
   */
  onActiveChange?: (active: boolean) => void;
}

export interface DragCursorSessionHandle {
  /** 摘除监听并结束会话（幂等；组件卸载时调用）。 */
  dispose: () => void;
}

/**
 * 在 `root` 上挂一个拖拽光标会话。
 *
 * 起拖条件与 Tauri 的 drag.js 完全一致：**事件 target 自身**带
 * `data-tauri-drag-region`（父级属性不向下传递），因此按钮、输入框、
 * 列表项这些后代元素不会被误判成拖拽手柄。
 */
export function attachDragCursorSession(
  root: HTMLElement,
  options: DragCursorSessionOptions = {},
): DragCursorSessionHandle {
  let current: LiveSession | null = null;
  let disposed = false;
  let active = false;

  const setActive = (next: boolean) => {
    if (active === next) return;
    active = next;
    if (next) root.classList.add(DRAG_SESSION_CLASS);
    else root.classList.remove(DRAG_SESSION_CLASS);
    options.onActiveChange?.(next);
  };

  /** 结束某个会话：幂等，且无论从哪条路径结束都会从活动集合移除。 */
  const finish = (session: LiveSession) => {
    if (session.ended) return;
    session.ended = true;
    activeSessions.delete(session);
    session.teardown?.();
    session.teardown = null;
    if (current === session) current = null;
    setActive(false);
  };

  const stopCurrent = () => {
    if (current) finish(current);
  };

  const start = () => {
    if (disposed) return;
    stopCurrent(); // 上一条会话若因事件缺失未收尾，先清掉再开新的

    const session: LiveSession = {
      generation: null,
      ended: false,
      teardown: null,
      end: () => finish(session),
    };
    current = session;
    activeSessions.add(session);
    setActive(true);

    const startedAt = Date.now();
    const inStartChurn = () => Date.now() - startedAt < START_CHURN_MS;
    // 结束判定统一看 `session.ended`：会话被新会话顶掉后，旧监听即使晚到也不会
    // 触碰当前状态（旧监听在同一时刻已被 teardown 摘除，这里是双保险）。
    const end = () => {
      if (session.ended) return;
      finish(session);
    };
    const endIfLate = () => {
      if (session.ended || inStartChurn()) return;
      finish(session);
    };
    const onMove = (event: PointerEvent) => {
      // 拖拽开始前最后几毫秒仍可能收到按住状态的移动事件，不能据此提前复位
      if (event.buttons === 0) endIfLate();
    };
    const onBlur = () => endIfLate();

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", end);

    session.teardown = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", end);
    };
  };

  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return; // 右键/中键不是窗口拖拽
    const target = event.target;
    if (!(target instanceof Element) || !root.contains(target)) return;
    if (!target.hasAttribute("data-tauri-drag-region")) return;
    start();
  };

  // 捕获阶段：Tauri 的 drag.js 在 mousedown 里 stopImmediatePropagation，
  // pointerdown 先于 mousedown，且捕获阶段不受其影响。
  document.addEventListener("pointerdown", onPointerDown, true);

  return {
    dispose: () => {
      disposed = true;
      document.removeEventListener("pointerdown", onPointerDown, true);
      stopCurrent();
    },
  };
}

/**
 * 把一个元素挂成拖拽会话宿主，返回它的 ref。
 *
 * 用法：`const ref = useDragRegion<HTMLElement>(); <header ref={ref} …>`。
 * 只有「事件 target 自身」带 `data-tauri-drag-region` 才不会起拖，这是
 * Tauri 的命中语义，组件里按需给背景/文字加属性即可，不需要包一层手柄。
 */
export function useDragRegion<T extends HTMLElement>(
  options: DragCursorSessionOptions = {},
): RefObject<T | null> {
  const ref = useRef<T | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const session = attachDragCursorSession(node, {
      onActiveChange: (active) => optionsRef.current.onActiveChange?.(active),
    });
    return () => session.dispose();
  }, []);

  return ref;
}

/**
 * 仅测试使用：当前活动会话数。
 *
 * 用于断言「每次拖拽结束后活动集合回到 0」；生产代码不读取该值，
 * 也不把它暴露成诊断/遥测接口。
 */
export function __activeDragSessionCount(): number {
  return activeSessions.size;
}

/**
 * 仅测试使用：重置模块级桥状态（每个用例模拟一个新的 webview）。
 *
 * 生产环境一个 webview 只有一份状态，且代次单调递增，不存在需要重置的场景。
 */
export function __resetDragBridgeStateForTests(): void {
  highestEndedGeneration = 0;
}
