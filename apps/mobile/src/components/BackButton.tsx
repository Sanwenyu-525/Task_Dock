// 返回按钮：44dp 热区，箭头用 View 画（与 AppBar 同一朝向与笔触）。
import { Pressable, StyleSheet } from "react-native";

import { useTheme } from "../theme/ThemeProvider";

import { Glyph } from "./Glyph";

export function BackButton({
  onPress,
  label = "返回",
}: {
  onPress: () => void;
  label?: string;
}) {
  const { tokens } = useTheme();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
      style={({ pressed }) => [styles.button, { opacity: pressed ? 0.6 : 1 }]}
    >
      <Glyph name="back" color={tokens.text} size={22} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    marginLeft: -4,
  },
});
