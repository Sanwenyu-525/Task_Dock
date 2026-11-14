// 区域标题：图标 + 标题 + 右侧动作（真实入口才有 onPress；未实现时只给文字/图标，不伪装成按钮）。
import { Pressable, StyleSheet, Text, View } from "react-native";

import { useTheme } from "../theme/ThemeProvider";
import { font, space } from "../theme/tokens";

import { Glyph, type GlyphName } from "./Glyph";

export function SectionHeader({
  icon,
  title,
  actionLabel,
  onAction,
}: {
  icon: GlyphName;
  title: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  const { tokens } = useTheme();

  return (
    <View style={styles.row}>
      <Glyph name={icon} color={tokens.accent} size={18} />
      <Text accessibilityRole="header" style={[styles.title, { color: tokens.text }]}>
        {title}
      </Text>
      {actionLabel ? (
        onAction ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={actionLabel}
            onPress={onAction}
            hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}
            style={({ pressed }) => [styles.action, { opacity: pressed ? 0.6 : 1 }]}
          >
            <Text style={[styles.actionText, { color: tokens.accentText }]}>{actionLabel}</Text>
            <Glyph name="chevron" color={tokens.accent} size={14} />
          </Pressable>
        ) : (
          <Text style={[styles.actionText, styles.actionMuted, { color: tokens.faint }]}>
            {actionLabel}
          </Text>
        )
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minHeight: 24,
  },
  title: {
    fontSize: font.section,
    fontWeight: "700",
    letterSpacing: -0.2,
    flexShrink: 1,
  },
  action: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    marginLeft: "auto",
    minHeight: 44,
    paddingLeft: space.sm,
  },
  actionMuted: {
    marginLeft: "auto",
    paddingLeft: space.sm,
    alignSelf: "center",
  },
  actionText: {
    fontSize: font.meta,
    fontWeight: "600",
  },
});
