//! 投屏窗口控制器：Session ↔ 原生控制栏窗口的生命周期与动作入口。
//!
//! 不是渲染层：不创建 React 节点，只把「会话状态」翻译成后端窗口命令。
//! 所有动作都以 sessionId 为唯一参数，绝不读取全局 activeSession / active_device。
//!
//! 原生窗口的创建时机由 Rust 侧 `vd_start` 的生命周期钩子决定（等 scrcpy HWND
//! 真正出现后才创建）；本控制器只做幂等的 attach/update/destroy 与用户动作转发，
//! 因此页面卸载不会错误关闭投屏窗口。

import {
  vdFocus,
  vdProjectionDispatch,
  vdStop,
  vdToolbarAttach,
  vdToolbarDestroy,
  vdToolbarDetach,
  vdToolbarScreenshot,
  vdToolbarUpdate,
  type ProjectionNavigationAction,
  type VdScreenshot,
} from "../../../lib/bridge";

export interface ProjectionWindowController {
  attach(sessionId: string): Promise<void>;
  detach(sessionId: string): Promise<void>;
  update(sessionId: string): Promise<void>;
  destroy(sessionId: string): Promise<void>;

  navigate(sessionId: string, action: ProjectionNavigationAction): Promise<number>;
  screenshot(sessionId: string): Promise<VdScreenshot>;
  close(sessionId: string): Promise<void>;
  restoreFocus(sessionId: string): Promise<void>;
}

class NativeProjectionWindowController implements ProjectionWindowController {
  /** 已确认 ready 的会话：重复 attach 直接幂等返回，不重复创建窗口。 */
  private readonly ready = new Set<string>();
  private readonly inFlight = new Map<string, Promise<void>>();

  attach(sessionId: string): Promise<void> {
    if (this.ready.has(sessionId)) {
      return Promise.resolve();
    }
    const existing = this.inFlight.get(sessionId);
    if (existing) {
      return existing;
    }
    const task = vdToolbarAttach(sessionId)
      .then((state) => {
        // pending 仍可能失败降级；只有 ready 才进入幂等缓存，允许之后重试。
        if (state === "ready") {
          this.ready.add(sessionId);
        }
      })
      .catch(() => {
        // 窗口服务未就绪或会话已结束时静默：主界面仍有 scrcpy 窗口可用。
      })
      .finally(() => {
        this.inFlight.delete(sessionId);
      });
    this.inFlight.set(sessionId, task);
    return task;
  }

  async detach(sessionId: string): Promise<void> {
    this.ready.delete(sessionId);
    try {
      await vdToolbarDetach(sessionId);
    } catch {
      // 幂等：会话已结束时后端返回 false，不需要用户处理。
    }
  }

  async update(sessionId: string): Promise<void> {
    try {
      await vdToolbarUpdate(sessionId);
    } catch {
      // 窗口已销毁时忽略；下一次 attach 会重新建立绑定。
    }
  }

  async destroy(sessionId: string): Promise<void> {
    this.ready.delete(sessionId);
    try {
      await vdToolbarDestroy(sessionId);
    } catch {
      // 幂等清理：重复 destroy 不报错。
    }
  }

  async navigate(
    sessionId: string,
    action: ProjectionNavigationAction,
  ): Promise<number> {
    // 一体化架构统一入口：后端先做 Session 归属/挂载校验，再复用 vd_nav。
    const result = await vdProjectionDispatch(sessionId, action);
    // 控制栏不抢焦点：动作完成后把键盘焦点还给手机画面。
    await this.restoreFocus(sessionId);
    return result.display_id;
  }

  async screenshot(sessionId: string): Promise<VdScreenshot> {
    // 后端复用 vd_screenshot 的 Android 投屏链路，并把结果广播给主窗口预览。
    const shot = await vdToolbarScreenshot(sessionId);
    await this.restoreFocus(sessionId);
    return shot;
  }

  async close(sessionId: string): Promise<void> {
    await vdStop(sessionId);
    this.ready.delete(sessionId);
  }

  async restoreFocus(sessionId: string): Promise<void> {
    try {
      await vdFocus(sessionId);
    } catch {
      // 系统可能因前台锁拒绝切换；不把焦点恢复失败当成动作失败。
    }
  }
}

export const projectionWindowController: ProjectionWindowController =
  new NativeProjectionWindowController();

// ── 可见性状态机（单一定时器，避免多个 setTimeout 相互覆盖）──────

export type ToolbarVisibilityState = "visible" | "hidden" | "locked";

export interface ToolbarVisibilityController {
  getState(): ToolbarVisibilityState;
  showToolbar(): void;
  hideToolbar(): void;
  lockToolbar(): void;
  unlockToolbar(): void;
  scheduleToolbarHide(delayMs?: number): void;
  cancelToolbarHide(): void;
  subscribe(listener: (state: ToolbarVisibilityState) => void): () => void;
  dispose(): void;
}

/**
 * 控制栏可见性状态机：同一时刻最多一个隐藏定时器。
 * 锁定态不自动隐藏；手动 hide 仍然生效（用户明确要求收起）。
 */
export function createToolbarVisibilityController(
  defaultHideDelayMs = 2600,
): ToolbarVisibilityController {
  let state: ToolbarVisibilityState = "visible";
  let timer: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Set<(state: ToolbarVisibilityState) => void>();

  const emit = () => {
    for (const listener of listeners) {
      listener(state);
    }
  };
  const setState = (next: ToolbarVisibilityState) => {
    if (state === next) return;
    state = next;
    emit();
  };
  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return {
    getState: () => state,
    showToolbar() {
      clearTimer();
      setState("visible");
    },
    hideToolbar() {
      clearTimer();
      setState("hidden");
    },
    lockToolbar() {
      clearTimer();
      setState("locked");
    },
    unlockToolbar() {
      clearTimer();
      setState("visible");
    },
    scheduleToolbarHide(delayMs = defaultHideDelayMs) {
      if (state === "locked" || state === "hidden") return;
      clearTimer();
      timer = setTimeout(() => {
        timer = null;
        setState("hidden");
      }, Math.max(0, delayMs));
    },
    cancelToolbarHide() {
      clearTimer();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      clearTimer();
      listeners.clear();
    },
  };
}

const visibilityControllers = new Map<string, ToolbarVisibilityController>();

/** 每个 Session 一个可见性状态机；键仍是 sessionId，避免多窗口串台。 */
export function toolbarVisibilityFor(
  sessionId: string,
): ToolbarVisibilityController {
  let controller = visibilityControllers.get(sessionId);
  if (!controller) {
    controller = createToolbarVisibilityController();
    visibilityControllers.set(sessionId, controller);
  }
  return controller;
}

export function disposeToolbarVisibility(sessionId: string): void {
  visibilityControllers.get(sessionId)?.dispose();
  visibilityControllers.delete(sessionId);
}
