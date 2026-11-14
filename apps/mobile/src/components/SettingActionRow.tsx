// 可点设置行：左侧 label（+可选 helper 说明），右侧任意尾部内容（徽标/开关/值）+可选用法箭头。
// 命中区 ≥44dp；不带 onPress 时退化为静态行（尾部内容仍可交互，比如开关）。
import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { useTheme } from "../theme/ThemeProvider";
import { font, space } from "../theme/tokens";

import { AppIcon } from "./icons/AppIcon";

export function SettingActionRow({
  label,
  helper,
  trailing,
  chevron = false,
  onPress,
  disabled = false,
  accessibilityLabel,
  accessibilityHint,
}: {
  label: string;
  helper?: string;
  trailing?: ReactNode;
  chevron?: boolean;
  onPress?: () => void;
  disabled?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
}) {
  const { tokens } = useTheme();

  const body = (
    <>
      <View style={styles.leading}>
        <Text numberOfLines={1} style={[styles.label, { color: disabled ? tokens.muted : tokens.text }]}>
          {label}
        </Text>
        {helper ? (
          <Text numberOfLines={2} style={[styles.helper, { color: tokens.muted }]}>
            {helper}
          </Text>
        ) : null}
      </View>
      {trailing ? <View style={styles.trailing}>{trailing}</View> : null}
      {chevron ? <AppIcon name="chevronRight" color={tokens.faint} size={16} /> : null}
    </>
  );

  if (!onPress) {
    return <View style={styles.row}>{body}</View>;
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.row, { opacity: disabled ? 0.5 : pressed ? 0.7 : 1 }]}
    >
      {body}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingVertical: space.xs,
  },
  leading: {
    flex: 1,
    gap: 2,
  },
  label: {
    fontSize: font.body,
    fontWeight: "500",
  },
  helper: {
    fontSize: font.label,
    lineHeight: 15,
  },
  trailing: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
  },
});
