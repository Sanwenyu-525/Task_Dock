// 空态：给「下一步做什么」而不是只说「这里没有内容」。
// 装饰圆环只用边框与低透明底色，不引入图片资源。
import { StyleSheet, Text, View } from "react-native";

import { useTheme } from "../theme/ThemeProvider";
import { font, space } from "../theme/tokens";

import { PressableScale } from "./PressableScale";

export function EmptyState({
  title,
  hint,
  actionLabel,
  onAction,
}: {
  title: string;
  hint: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  const { tokens } = useTheme();

  return (
    <View style={styles.wrap}>
      <View
        importantForAccessibility="no-hide-descendants"
        style={[styles.orb, { borderColor: tokens.accentSoft, backgroundColor: tokens.accentSoft }]}
      >
        <View style={[styles.orbDot, { backgroundColor: tokens.accent }]} />
      </View>
      <Text style={[styles.title, { color: tokens.text }]}>{title}</Text>
      <Text style={[styles.hint, { color: tokens.muted }]}>{hint}</Text>
      {actionLabel && onAction ? (
        <PressableScale
          onPress={onAction}
          accessibilityLabel={actionLabel}
          style={styles.actionPress}
          contentStyle={[styles.action, { backgroundColor: tokens.accentFill }]}
        >
          <Text style={[styles.actionText, { color: tokens.onAccent }]}>{actionLabel}</Text>
        </PressableScale>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: "center",
    paddingVertical: space.xl + space.sm,
    paddingHorizontal: space.lg,
    gap: space.sm,
  },
  orb: {
    width: 46,
    height: 46,
    borderRadius: 23,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: space.xs,
  },
  orbDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    opacity: 0.75,
  },
  title: {
    fontSize: font.title,
    fontWeight: "600",
  },
  hint: {
    fontSize: font.meta,
    lineHeight: 18,
    textAlign: "center",
    maxWidth: 260,
  },
  actionPress: {
    marginTop: space.sm,
  },
  action: {
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: space.lg,
    borderRadius: 999,
  },
  actionText: {
    fontSize: font.title,
    fontWeight: "600",
  },
});
