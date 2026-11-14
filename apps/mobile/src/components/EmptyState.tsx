// 空态：给「下一步做什么」而不是只说「这里没有内容」。
// 第四轮：装饰圆环换成 32dp 语义图标 + 柔和底板（同一套 AppIcon），空态也有明确含义。
import { StyleSheet, Text, View } from "react-native";

import { useTheme } from "../theme/ThemeProvider";
import { font, space } from "../theme/tokens";

import { AppIcon, type IconName } from "./icons/AppIcon";
import { PressableScale } from "./PressableScale";

export function EmptyState({
  icon = "inbox",
  title,
  hint,
  actionLabel,
  onAction,
}: {
  icon?: IconName;
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
        style={[styles.orb, { backgroundColor: tokens.tileBase, borderColor: tokens.tileBorder }]}
      >
        <AppIcon name={icon} size={32} color={tokens.accent} />
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
    width: 64,
    height: 64,
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: space.xs,
  },
  title: {
    fontSize: font.title,
    fontWeight: "600",
  },
  hint: {
    fontSize: font.meta,
    lineHeight: 20,
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
