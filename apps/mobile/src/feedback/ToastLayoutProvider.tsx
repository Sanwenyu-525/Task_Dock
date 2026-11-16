// 页面级 Toast 锚点注册：页面把实际测量到的固定操作区交给宿主，
// 宿主只使用「当前活动页面」的锚点，隐藏 Tab 的测量不会串台。
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { LayoutChangeEvent } from "react-native";

import { useToastScope } from "./ToastProvider";
import {
  EMPTY_TOAST_LAYOUT,
  activeToastLayout,
  clearToastLayout,
  updateToastLayout,
  type ToastLayouts,
  type ToastPageLayout,
} from "./toastLayout";
import type { ToastPlacement } from "./toastQueue";

interface ToastLayoutState {
  activeScope: string;
  layout: ToastPageLayout;
}

interface ToastLayoutActions {
  update: (scope: string, patch: ToastPageLayout) => void;
  clear: (scope: string) => void;
}

const ToastLayoutStateContext = createContext<ToastLayoutState>({
  activeScope: "global",
  layout: EMPTY_TOAST_LAYOUT,
});
const ToastLayoutActionsContext = createContext<ToastLayoutActions | null>(null);

export function ToastLayoutProvider({
  activeScope,
  children,
}: {
  activeScope: string;
  children: ReactNode;
}) {
  const [layouts, setLayouts] = useState<ToastLayouts>({});

  const update = useCallback((scope: string, patch: ToastPageLayout) => {
    setLayouts((prev) => updateToastLayout(prev, scope, patch));
  }, []);

  const clear = useCallback((scope: string) => {
    setLayouts((prev) => clearToastLayout(prev, scope));
  }, []);

  const actions = useMemo(() => ({ update, clear }), [update, clear]);
  const state = useMemo(
    () => ({ activeScope, layout: activeToastLayout(layouts, activeScope) }),
    [activeScope, layouts],
  );

  return (
    <ToastLayoutActionsContext.Provider value={actions}>
      <ToastLayoutStateContext.Provider value={state}>
        {children}
      </ToastLayoutStateContext.Provider>
    </ToastLayoutActionsContext.Provider>
  );
}

/** 只有 ToastHost 需要订阅活动页锚点；页面不会因为别页测量而重渲染。 */
export function useActiveToastLayout(): ToastPageLayout {
  return useContext(ToastLayoutStateContext).layout;
}

/** 页面注册锚点：动作稳定、不订阅状态，onLayout 不会触发页面自身重渲染。 */
export function useToastLayoutRegistration() {
  const scope = useToastScope();
  const actions = useContext(ToastLayoutActionsContext);

  const update = actions?.update;
  const clear = actions?.clear;

  const setTopInset = useCallback(
    (height: number) => update?.(scope, { topInset: height }),
    [scope, update],
  );
  const setBottomBar = useCallback(
    (height: number, aboveKeyboard: boolean) =>
      update?.(scope, { bottomBarHeight: height, bottomBarAboveKeyboard: aboveKeyboard }),
    [scope, update],
  );
  const clearBottomBar = useCallback(
    () => update?.(scope, { bottomBarHeight: undefined, bottomBarAboveKeyboard: undefined }),
    [scope, update],
  );
  const setDefaultPlacement = useCallback(
    (placement: ToastPlacement) => update?.(scope, { defaultPlacement: placement }),
    [scope, update],
  );

  useEffect(() => {
    if (!clear) return;
    return () => clear(scope);
  }, [clear, scope]);

  return useMemo(
    () => ({ setTopInset, setBottomBar, clearBottomBar, setDefaultPlacement }),
    [setTopInset, setBottomBar, clearBottomBar, setDefaultPlacement],
  );
}

/** 固定顶部操作区测量：把高度（不是 Y 坐标）上报给当前页 scope。 */
export function useToastTopAnchor() {
  const { setTopInset } = useToastLayoutRegistration();
  const onLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const height = Math.round(event.nativeEvent.layout.height);
      if (height > 0) setTopInset(height);
    },
    [setTopInset],
  );
  return { onLayout };
}

/**
 * 固定底部操作区测量：enabled=false 时清除登记（例如 Files 的 dock 在错误态隐藏）。
 * aboveKeyboard 表示该操作区在键盘弹出时会整体上移，Toast 需要同时避开两者。
 */
export function useToastBottomAnchor(enabled = true, aboveKeyboard = false) {
  const { setBottomBar, clearBottomBar } = useToastLayoutRegistration();
  const onLayout = useCallback(
    (event: LayoutChangeEvent) => {
      if (!enabled) return;
      const height = Math.round(event.nativeEvent.layout.height);
      if (height > 0) setBottomBar(height, aboveKeyboard);
    },
    [aboveKeyboard, enabled, setBottomBar],
  );

  useEffect(() => {
    if (!enabled) clearBottomBar();
  }, [clearBottomBar, enabled]);

  return { onLayout };
}

/** 页面默认位置：顶部固定操作区过高时（如任务筛选区）默认落到底部。 */
export function useToastPagePlacement(placement: ToastPlacement) {
  const { setDefaultPlacement } = useToastLayoutRegistration();
  useEffect(() => {
    setDefaultPlacement(placement);
  }, [placement, setDefaultPlacement]);
}
