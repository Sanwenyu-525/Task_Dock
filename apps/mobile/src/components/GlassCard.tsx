// 一级卡片表面：实色底 + hairline 边框 + 顶部内高光。
// 这里刻意不使用 elevation：Android 上给半透明卡片加 elevation 时，阴影会从卡片内部
// 透出来（浅色模式下表现为卡里嵌一个矩形白框），实色表面 + 边框已经足够分层。
import type { ReactNode } from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";

import { useTheme } from "../theme/ThemeProvider";
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
  const { tokens } = useTheme();

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
