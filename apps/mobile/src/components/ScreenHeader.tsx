// 一级页面顶栏：左侧标题（可带副标题），右侧动作插槽；高度 56dp，不参与纵向滚动。
// 第七轮：参考图顶栏与页面共用浅蓝底，不再画一条贯穿全屏的分割线。
import type { ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";

import { useTheme } from "../theme/ThemeProvider";
import { font, space } from "../theme/tokens";

export const SCREEN_HEADER_HEIGHT = 56;

export function ScreenHeader({
  title,
  subtitle,
  right,
}: {
  title: string;
  subtitle?: string;
  right?: ReactNode;
}) {
  const { tokens } = useTheme();

  return (
    <View style={styles.bar}>
      <View style={styles.titleBlock}>
        <Text accessibilityRole="header" numberOfLines={1} style={[styles.title, { color: tokens.text }]}>
          {title}
        </Text>
        {subtitle ? (
          <Text numberOfLines={1} style={[styles.subtitle, { color: tokens.muted }]}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {right ? <View style={styles.right}>{right}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    minHeight: SCREEN_HEADER_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingHorizontal: space.lg,
  },
  titleBlock: {
    flex: 1,
    gap: 1,
  },
  title: {
    fontSize: font.page,
    fontWeight: "800",
    letterSpacing: -0.4,
    lineHeight: font.page + 6,
  },
  subtitle: {
    fontSize: font.meta,
    lineHeight: 16,
  },
  right: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.xs,
  },
});
