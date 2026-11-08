// 表面阴影：Android 只认 elevation，iOS 走 shadow*，两套取值都保持「几乎看不见」。
// 单独成文件是为了不在每个组件里重复写 5 个阴影属性，也避免各页阴影强度漂移。
import type { ViewStyle } from "react-native";

import type { ColorScheme } from "./tokens";

/** 一级卡片（任务行、收集箱卡片、设置分组） */
export function cardShadow(scheme: ColorScheme): ViewStyle {
  return scheme === "dark"
    ? {
        shadowColor: "#000000",
        shadowOpacity: 0.3,
        shadowRadius: 10,
        shadowOffset: { width: 0, height: 4 },
        elevation: 2,
      }
    : {
        shadowColor: "#0F172A",
        shadowOpacity: 0.05,
        shadowRadius: 8,
        shadowOffset: { width: 0, height: 2 },
        elevation: 1,
      };
}

/** 悬浮层（FAB、底部弹层）：需要明确脱离列表，但不做夸张投影 */
export function floatingShadow(scheme: ColorScheme): ViewStyle {
  return scheme === "dark"
    ? {
        shadowColor: "#000000",
        shadowOpacity: 0.55,
        shadowRadius: 18,
        shadowOffset: { width: 0, height: -6 },
        elevation: 14,
      }
    : {
        shadowColor: "#0F172A",
        shadowOpacity: 0.16,
        shadowRadius: 18,
        shadowOffset: { width: 0, height: -8 },
        elevation: 12,
      };
}
