// 悬浮层阴影：只有 FAB、底部弹层、浮动 Tab 栏、以及「一级卡片」这类真正需要抬起的表面才用。
//
// 历史约束（仍然有效）：半透明卡片 + elevation 会让阴影从卡片内部透出来，表现为卡里嵌一个
// 矩形框。现在所有卡片表面都是不透明的，因此给一级卡片加一层极轻的 elevation 是安全的；
// 阴影只承担「这张卡比别的更重要」这一件事，不做装饰性投影，也不叠加在大面积彩色底上。
import type { ViewStyle } from "react-native";

import type { ColorScheme } from "./tokens";

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

/** 浮起的小表面（浮动 Tab 栏）：阴影要柔和、方向一致 */
export function barShadow(scheme: ColorScheme): ViewStyle {
  return scheme === "dark"
    ? {
        shadowColor: "#000000",
        shadowOpacity: 0.45,
        shadowRadius: 16,
        shadowOffset: { width: 0, height: 6 },
        elevation: 10,
      }
    : {
        shadowColor: "#0F172A",
        shadowOpacity: 0.1,
        shadowRadius: 16,
        shadowOffset: { width: 0, height: 6 },
        elevation: 8,
      };
}

/**
 * 一级卡片的轻阴影：只比白卡「厚一点」，用来区分今日专注 / 设备状态这类重点卡片。
 * 深色模式不给彩色阴影，只留 1dp 的暗投影，避免在深底上出现一圈灰边。
 */
export function cardShadow(scheme: ColorScheme): ViewStyle {
  return scheme === "dark"
    ? {
        shadowColor: "#000000",
        shadowOpacity: 0.35,
        shadowRadius: 8,
        shadowOffset: { width: 0, height: 2 },
        elevation: 3,
      }
    : {
        shadowColor: "#1B4B8F",
        shadowOpacity: 0.08,
        shadowRadius: 10,
        shadowOffset: { width: 0, height: 3 },
        elevation: 3,
      };
}
