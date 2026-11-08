// 一级卡片表面：半透明底 + hairline 边框 + 顶部内高光 + 极轻阴影。
// 抽取成基元是为了让统计卡、收集箱卡片、设置分组共享同一套表面语义，
// 避免各页各写一份 rgba 值导致深浅模式下「有的透、有的糊」。
import type { ReactNode } from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";

import { useTheme } from "../theme/ThemeProvider";
import { cardShadow } from "../theme/shadows";
import { radius } from "../theme/tokens";

export function GlassCard({
  children,
  style,
  solid = false,
  accessibilityLabel,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  /** 需要完全遮住下层内容时用不透明合成色（普通卡片不要开） */
  solid?: boolean;
  accessibilityLabel?: string;
}) {
  const { tokens, scheme } = useTheme();

  return (
    <View
      accessible={accessibilityLabel != null}
      accessibilityLabel={accessibilityLabel}
      style={[
        styles.card,
        {
          backgroundColor: solid ? tokens.cardSolid : tokens.card,
          borderColor: tokens.cardBorder,
        },
        cardShadow(scheme),
        style,
      ]}
    >
      <View
        pointerEvents="none"
        style={[styles.highlight, { backgroundColor: tokens.cardHighlight }]}
      />
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.card,
    borderWidth: StyleSheet.hairlineWidth,
    // 内嵌面板（设置页的白底块）是直角的，不裁剪会把卡片圆角顶成方形
    overflow: "hidden",
  },
  highlight: {
    position: "absolute",
    top: 0,
    left: 12,
    right: 12,
    height: StyleSheet.hairlineWidth,
  },
});
