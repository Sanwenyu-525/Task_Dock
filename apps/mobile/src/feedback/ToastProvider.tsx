// 全局唯一的 Toast 状态：页面只调用 showToast，不再各自 setState / 渲染。
// Provider 挂在 App 根部，Shell 内只渲染一个 ToastHost；切换 Tab / 进入二级页不会销毁队列。
// ToastScope 让 Shell 能标记消息来源页：隐藏 Tab 页的异步操作晚到时，不会突然弹在当前页面上。
// 状态与动作拆成两个 Context：页面只订阅稳定的动作，不会因为弹出一条 Toast 就整页重渲染。
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from "react";

import {
  createToastState,
  toastDuration,
  toastPriority,
  toastReducer,
  type ToastAction,
  type ToastItem,
  type ToastPlacement,
  type ToastState,
  type ToastTone,
} from "./toastQueue";

interface ToastActions {
  showToast: (
    text: string,
    tone?: ToastTone,
    placement?: ToastPlacement,
    scope?: string,
  ) => void;
  dismissToast: (id: number) => void;
  clearToasts: () => void;
  setActiveScope: (scope: string) => void;
  /**
   * 只同步 ref、不 dispatch：Shell 在 render 阶段调用，保证新页面挂载时的
   * showToast 已经看到新 scope；队列清理由随后的 setActiveScope effect 完成。
   */
  syncActiveScope: (scope: string) => void;
}

const ToastActionsContext = createContext<ToastActions | null>(null);
const ToastStateContext = createContext<ToastState | null>(null);
const ToastScopeContext = createContext<string>("global");

export function ToastScope({ scope, children }: { scope: string; children: ReactNode }) {
  return <ToastScopeContext.Provider value={scope}>{children}</ToastScopeContext.Provider>;
}

/** 页面布局注册需要知道自己的 scope；不改变 useToast 的公开调用方式。 */
export function useToastScope(): string {
  return useContext(ToastScopeContext);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(
    (prev: ToastState, action: ToastAction) => toastReducer(prev, action),
    undefined,
    createToastState,
  );
  const seq = useRef(0);
  const activeScope = useRef("global");
  // 已经派发过 scopeChange 的页面；syncActiveScope 只改 ref，不消费这个标记。
  const clearedScope = useRef<string | null>(null);

  const showToast = useCallback(
    (text: string, tone: ToastTone = "info", placement?: ToastPlacement, scope = "global") => {
      const trimmed = text.trim();
      if (!trimmed) return;
      // 页面已经不可见时，晚到的成功/错误提示直接丢弃，避免隐藏页消息串台。
      if (scope !== "global" && scope !== activeScope.current) return;
      seq.current += 1;
      const item: ToastItem = {
        id: seq.current,
        text: trimmed,
        tone,
        placement,
        scope,
        durationMs: toastDuration(tone),
        priority: toastPriority(tone),
        createdAt: Date.now(),
        rev: 0,
      };
      dispatch({ type: "enqueue", item });
    },
    [],
  );

  const dismissToast = useCallback((id: number) => dispatch({ type: "dismiss", id }), []);
  const clearToasts = useCallback(() => dispatch({ type: "clear" }), []);

  const setActiveScope = useCallback((scope: string) => {
    activeScope.current = scope;
    // 初始挂载也执行一次：新页面可能在 effect 之前已经产生了首条提示。
    if (clearedScope.current === scope) return;
    clearedScope.current = scope;
    // 切换页面后旧页面的排队提示不再有意义，直接清掉；当前已显示的消息允许播完。
    dispatch({ type: "scopeChange", scope });
  }, []);

  const syncActiveScope = useCallback((scope: string) => {
    // 仅 ref，不 dispatch；供 Shell 在 render 阶段提前同步，消除挂载首帧竞态。
    activeScope.current = scope;
  }, []);

  const actions = useMemo(
    () => ({ showToast, dismissToast, clearToasts, setActiveScope, syncActiveScope }),
    [showToast, dismissToast, clearToasts, setActiveScope, syncActiveScope],
  );

  return (
    <ToastActionsContext.Provider value={actions}>
      <ToastStateContext.Provider value={state}>{children}</ToastStateContext.Provider>
    </ToastActionsContext.Provider>
  );
}

export function useToast(): ToastActions {
  const actions = useContext(ToastActionsContext);
  const scope = useContext(ToastScopeContext);
  if (!actions) throw new Error("useToast 必须在 ToastProvider 内使用");

  const scopedShowToast = useCallback(
    (text: string, tone: ToastTone = "info", placement?: ToastPlacement) => {
      actions.showToast(text, tone, placement, scope);
    },
    [actions.showToast, scope],
  );

  return useMemo(
    () => ({ ...actions, showToast: scopedShowToast }),
    [actions, scopedShowToast],
  );
}

/** 只有 ToastHost 需要订阅队列状态；页面用 useToast 即可，避免每条提示触发整页渲染。 */
export function useToastState(): ToastState {
  const state = useContext(ToastStateContext);
  if (!state) throw new Error("useToastState 必须在 ToastProvider 内使用");
  return state;
}
