// 顶栏图标按钮：44dp 热区 + 线性图标；disabled 时只降透明度、不响应点击。
import { Pressable, StyleSheet } from "react-native";

import { useTheme } from "../theme/ThemeProvider";

import { AppIcon, type IconName } from "./icons/AppIcon";

export function HeaderIconButton({
  icon,
  accessibilityLabel,
  accessibilityHint,
  onPress,
  disabled = false,
  tone = "default",
}: {
  icon: IconName;
  accessibilityLabel: string;
  /** 可选的补充说明：告诉用户点下去会发生什么（不替代 label） */
  accessibilityHint?: string;
  onPress?: () => void;
  disabled?: boolean;
  /** default = 正文色（主操作）；muted = 次要操作（如关闭搜索） */
  tone?: "default" | "muted";
}) {
  const { tokens } = useTheme();
  const color = disabled ? tokens.faint : tone === "muted" ? tokens.muted : tokens.text;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled }}
      disabled={disabled || !onPress}
      onPress={onPress}
      hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
      style={({ pressed }) => [
        styles.button,
        { opacity: disabled ? 0.4 : pressed ? 0.6 : 1 },
      ]}
    >
      <AppIcon name={icon} color={color} size={22} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
});
