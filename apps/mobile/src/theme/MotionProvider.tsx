// 动效基础：统一时长/曲线，并把系统「减少动态效果」收敛成一条 Context。
//
// 为什么用 Provider 而不是每个组件各调一次 AccessibilityInfo：任务列表可能同时挂
// 几十个行组件，逐个订阅会生成等量的原生监听器；这里只在根部订阅一次。
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { AccessibilityInfo, Easing } from "react-native";

/** 常用时长（ms）。数值克制：列表动效一律 ≤ 300，避免拖动时产生拖影。 */
export const duration = {
  fast: 140,
  base: 200,
  list: 260,
  toast: 2400,
};

/** 标准减速曲线：起步快、收尾稳，适合「进入」类动画 */
export const easeOut = Easing.bezier(0.22, 0.61, 0.36, 1);

/** 弹层上滑的弹簧参数（Animated.spring） */
export const sheetSpring = {
  damping: 26,
  stiffness: 260,
  mass: 0.9,
} as const;

const ReduceMotionContext = createContext(false);

export function MotionProvider({ children }: { children: ReactNode }) {
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    let alive = true;
    // 读不到系统偏好时按「允许动画」处理：这是偏好探测，失败不应该阻塞界面。
    void AccessibilityInfo.isReduceMotionEnabled()
      .then((enabled) => {
        if (alive) setReduceMotion(enabled);
      })
      .catch(() => undefined);

    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", (enabled) => {
      setReduceMotion(enabled);
    });

    return () => {
      alive = false;
      subscription.remove();
    };
  }, []);

  const value = reduceMotion;
  return <ReduceMotionContext.Provider value={value}>{children}</ReduceMotionContext.Provider>;
}

/**
 * 系统是否开启「减少动态效果」。
 * 为 true 时所有位移/弹簧都必须退化为直接呈现，只保留必要的透明度变化（或不变化）。
 */
export function useReduceMotion(): boolean {
  return useContext(ReduceMotionContext);
}
