// 卡片表面：三级层次，全部实色，不使用半透明玻璃。
//
// - primary：需要「被看见」的重点卡（今日专注、设备状态、项目摘要）。强一档的描边 + 极轻阴影，
//   只是把卡片抬起来一点点，不做装饰性投影。
// - secondary（默认）：普通内容组（工具组、入口组、列表组）。白底 + hairline，不抢焦点。
// - tertiary：放在页面底上、不想要边框的轻量容器（图标组、辅助信息）。用 bgAccent 做分区，
//   避免「卡片里再套卡片」。
//
// 历史约束：半透明卡片 + elevation 会让阴影从卡片内部透出来（真机表现为卡里嵌一个矩形框），
// 因此这里所有表面都是不透明的，阴影只允许出现在 primary 上。
import type { ReactNode } from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";

import { cardShadow } from "../theme/shadows";
import { useTheme } from "../theme/ThemeProvider";
import { radius } from "../theme/tokens";

export type CardLevel = "primary" | "secondary" | "tertiary";

export function GlassCard({
  children,
  style,
  level = "secondary",
  solid = false,
  accessibilityLabel,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  level?: CardLevel;
  /** 需要完全遮住下层内容时用不透明合成色（普通卡片不要开） */
  solid?: boolean;
  accessibilityLabel?: string;
}) {
  const { tokens, scheme } = useTheme();

  const surface =
    level === "primary"
      ? { backgroundColor: solid ? tokens.cardSolid : tokens.card, borderColor: tokens.cardBorderStrong }
      : level === "secondary"
        ? { backgroundColor: solid ? tokens.cardSolid : tokens.card, borderColor: tokens.cardBorder }
        : { backgroundColor: tokens.bgAccent, borderColor: "transparent" };

  return (
    <View
      accessible={accessibilityLabel != null}
      accessibilityLabel={accessibilityLabel}
      style={[styles.card, surface, level === "primary" ? cardShadow(scheme) : null, style]}
    >
      {level !== "tertiary" ? (
        <View
          pointerEvents="none"
          style={[styles.highlight, { backgroundColor: tokens.cardHighlight }]}
        />
      ) : null}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.card,
    borderWidth: StyleSheet.hairlineWidth,
    // 内嵌面板是直角的，不裁剪会把卡片圆角顶成方形
    overflow: "hidden",
  },
  highlight: {
    position: "absolute",
    top: 0,
    left: 14,
    right: 14,
    height: StyleSheet.hairlineWidth,
  },
});
