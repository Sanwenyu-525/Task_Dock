// 可点设置行：左侧 label（+可选 helper 说明），右侧任意尾部内容（徽标/开关/值）+可选用法箭头。
// 命中区 ≥44dp；不带 onPress 时退化为静态行（尾部内容仍可交互，比如开关）。
import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { useTheme } from "../theme/ThemeProvider";
import { font, space } from "../theme/tokens";

const STROKE = 1.5;

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
      {chevron ? (
        <View style={styles.chevron} pointerEvents="none">
          <View style={[styles.chevronTop, { backgroundColor: tokens.faint }]} />
          <View style={[styles.chevronBottom, { backgroundColor: tokens.faint }]} />
        </View>
      ) : null}
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
  chevron: {
    width: 16,
    height: 16,
  },
  // 两根 45° 圆头短杆在右端同一点相接成「>」（原型 chevron_right 的 16dp 缩放：
  // 4dp 宽 × 8dp 高）。位置必须用 left/top 直接指定：rotate 后 translateX 是沿杆
  // 自身轴平移，两根杆会交于中点变成「×」，而不是在端点相接。
  chevronTop: {
    position: "absolute",
    left: 5.17,
    top: 5.25,
    width: 5.66,
    height: STROKE,
    borderRadius: STROKE / 2,
    transform: [{ rotate: "45deg" }],
  },
  chevronBottom: {
    position: "absolute",
    left: 5.17,
    top: 9.25,
    width: 5.66,
    height: STROKE,
    borderRadius: STROKE / 2,
    transform: [{ rotate: "-45deg" }],
  },
});
