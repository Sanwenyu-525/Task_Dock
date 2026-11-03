//! 弹层栈：全局 Escape 关闭优先级。
//!
//! 一次 Escape 只做**当前最高优先级**的一次关闭动作，优先级与真实 z 序一致：
//!
//!   确认框(dialog) → 下拉菜单(menu) → 顶层模态(modalTop) → 子弹层(sublayer)
//!     → 模态(modal) → 临时抽屉(drawer) → 主窗口
//!
//! 弹层(menu) 的 z 是 --z-menu(900)，高于普通模态的 --z-modal(70)：
//! 任务编辑器里展开日期选择器时，Escape 必须先关日期选择器而不是编辑器。
//!
//! modalTop 对应 --z-modal-top(80)：图片灯箱这类盖在抽屉子视图之上的全屏查看层。
//! 它的 z 高于子弹层所在的抽屉(--z-drawer 60)，所以 Escape 必须先关它；
//! 若按 modal(1) 注册，「详情子视图 + 灯箱」同时在场时一次按键会把两层一起关掉。
//!
//! 只要栈里还有任何一层，主窗口就不会收到 Escape（不会被顺手藏进托盘）。
//! 关键点：Escape 分发只有一个入口（capture 阶段），不依赖各组件监听器的注册顺序，
//! 因此不会出现「菜单关掉了，窗口也跟着隐藏了」的双重消费。
//!
//! 同种类的嵌套弹层（例如「任务编辑器」里再开「关联目标」）按 DOM 嵌套深度判定，
//! 内层优先——不能只看注册顺序，React 的 effect 是子先于父执行的。

export type OverlayKind = "dialog" | "menu" | "modalTop" | "sublayer" | "modal" | "drawer";

export interface OverlayEntry {
  kind: OverlayKind;
  /** Escape 命中这一层时执行的动作（只执行一次） */
  onEscape: () => void;
  /** 该层对应的 DOM 根节点；用于判定嵌套深度（内层优先于外层）。 */
  root?: HTMLElement | null;
  /**
   * 是否阻止胶囊的「光标离开自动收起」（默认 true）。
   *
   * 胶囊面板自己也注册一层（为了 Esc 只收面板、不隐藏窗口），但它**不是**
   * 「用户正在菜单/对话框里交互」——若不区分，`topOverlay()` 恒有值，
   * 自动收起永远不触发，展开后的面板会一直停在轨道上方。
   */
  blocksAutoHide?: boolean;
}

const stack: OverlayEntry[] = [];

/**
 * 层级优先级：确认框 > 下拉菜单 > 顶层模态 > 子弹层 > 模态 > 临时抽屉。
 *
 * 优先级**按种类**判定而不是纯 LIFO，否则 React 的 effect 执行顺序
 * （子先于父）会让抽屉反超它内部的确认框，Escape 就会关错层。
 *
 * 数字与 CSS 的 z 序对齐：dialog(--z-dialog 940) 在最上，
 * menu(--z-menu 900) 高于顶层模态(--z-modal-top 80)，
 * 顶层模态高于普通模态(--z-modal 70)，模态高于抽屉(--z-drawer 60)，
 * 子弹层是抽屉内部的子视图（必须先于外层模态关闭）。
 */
const KIND_PRIORITY: Record<OverlayKind, number> = {
  dialog: 5,
  menu: 4,
  modalTop: 3,
  sublayer: 2,
  modal: 1,
  drawer: 0,
};

export function registerOverlay(entry: OverlayEntry): () => void {
  stack.push(entry);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const i = stack.indexOf(entry);
    if (i >= 0) stack.splice(i, 1);
  };
}

export function overlayStack(): readonly OverlayEntry[] {
  return stack;
}

/**
 * 嵌套深度：被其它已注册层的 DOM 根节点包含 → 属于更内层。
 *
 * React 的 effect 是「子先于父」执行的，所以嵌套弹层的注册顺序是反的
 * （内层先注册、外层后注册）。只看注册顺序会让外层反超内层，
 * 于是「任务编辑器里再开关联目标弹窗」时 Escape 会关掉编辑器而不是弹窗。
 * 用 DOM 包含关系判断深度可以纠正这一点。
 */
function nestingDepth(entry: OverlayEntry, all: readonly OverlayEntry[]): number {
  if (!entry.root) return 0;
  let depth = 0;
  for (const other of all) {
    if (other === entry) continue;
    if (other.root && other.root !== entry.root && other.root.contains(entry.root)) depth += 1;
  }
  return depth;
}

/** 最高优先级的层；同种类时取嵌套更深的（同深度取最后注册的那个）。 */
export function topOverlay(): OverlayEntry | undefined {
  let best: OverlayEntry | undefined;
  let bestPriority = -1;
  let bestDepth = -1;
  for (const e of stack) {
    const p = KIND_PRIORITY[e.kind];
    const d = nestingDepth(e, stack);
    if (p > bestPriority || (p === bestPriority && d >= bestDepth)) {
      best = e;
      bestPriority = p;
      bestDepth = d;
    }
  }
  return best;
}

export function hasOverlay(kind?: OverlayKind): boolean {
  return kind ? stack.some((e) => e.kind === kind) : stack.length > 0;
}

/**
 * 是否有**会阻止胶囊自动收起**的弹层（菜单 / 对话框 / 模态等）。
 *
 * 与 `topOverlay()` 的区别：胶囊面板自己注册的 Escape 层
 * （`blocksAutoHide: false`）不算「用户正在弹层里交互」，不得阻止自动收起。
 * 任一其他层在场都阻止——此时用户可能正在菜单/对话框里操作胶囊内容。
 */
export function hasAutoHideBlockingOverlay(): boolean {
  return stack.some((e) => e.blocksAutoHide !== false);
}

/** 测试用：清空弹层栈。 */
export function resetOverlayStack(): void {
  stack.length = 0;
}

let windowEscapeHandler: (() => void) | null = null;

/**
 * 设置「栈里没有弹层时，Escape 要做的事」——通常是隐藏窗口到托盘。
 * 由 App 启动时挂上。
 */
export function setWindowEscapeHandler(fn: (() => void) | null): void {
  windowEscapeHandler = fn;
}

/**
 * 安装 Escape 分发器。
 *
 * - capture 阶段：有弹层时吃掉 Escape 并只关闭最上层（同时阻断 React 与其它监听器）。
 * - bubble 阶段：没有任何弹层、且事件未被内层 `preventDefault` 消费时，
 *   才把 Escape 交给窗口级动作（隐藏到托盘）。
 *
 * 返回卸载函数。
 */
export function installEscapeDispatcher(win: Window = window): () => void {
  const capture = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    const top = topOverlay();
    if (!top) return;
    // 同步摘除：同一次按键绝不会连关两层
    const i = stack.indexOf(top);
    if (i >= 0) stack.splice(i, 1);
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    top.onEscape();
  };
  const bubble = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    if (e.defaultPrevented) return; // 内层（输入框等）已自行消费
    if (topOverlay()) return;
    windowEscapeHandler?.();
  };
  win.addEventListener("keydown", capture, true);
  win.addEventListener("keydown", bubble);
  return () => {
    win.removeEventListener("keydown", capture, true);
    win.removeEventListener("keydown", bubble);
  };
}

let dispatcherInstalled = false;

/**
 * 模块加载即安装分发器：保证任何弹层（哪怕出现在孤立的组件测试里）
 * 都遵守同一套 Escape 优先级，不会因为挂载顺序不同而行为不一致。
 */
export function ensureEscapeDispatcher(win: Window = window): void {
  if (dispatcherInstalled) return;
  dispatcherInstalled = true;
  installEscapeDispatcher(win);
}

if (typeof window !== "undefined") {
  ensureEscapeDispatcher(window);
}
