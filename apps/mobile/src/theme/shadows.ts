// 悬浮层阴影：只有 FAB、底部弹层、浮动 Tab 栏这类真正脱离页面的元素才用。
// 卡片一律不用 elevation —— 半透明/实色卡片在 Android 上叠 elevation 时，
// 阴影会从卡片内部透出，浅色模式下表现为卡片里嵌一个矩形白框（真机实测）。
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
