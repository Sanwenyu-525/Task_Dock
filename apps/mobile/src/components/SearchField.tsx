// 搜索框：任务页与收集箱共用。放大镜与清除按钮都是绘制的，不引图标库，
// 与 TabBar/FAB 的画法保持一致；命中区按 44dp 补齐。
import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { useTheme } from "../theme/ThemeProvider";
import { font, radius, space } from "../theme/tokens";

export function SearchField({
  value,
  onChangeText,
  placeholder,
  accessibilityLabel,
}: {
  value: string;
  onChangeText: (text: string) => void;
  placeholder: string;
  accessibilityLabel: string;
}) {
  const { tokens } = useTheme();
  const [focused, setFocused] = useState(false);

  return (
    <View
      style={[
        styles.root,
        {
          backgroundColor: tokens.bgAccent,
          borderColor: focused ? tokens.accent : tokens.cardBorder,
        },
      ]}
    >
      <View pointerEvents="none" style={styles.glyph}>
        <View style={[styles.lens, { borderColor: tokens.muted }]} />
        <View style={[styles.handle, { backgroundColor: tokens.muted }]} />
      </View>

      <TextInput
        accessibilityLabel={accessibilityLabel}
        value={value}
        onChangeText={onChangeText}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder={placeholder}
        placeholderTextColor={tokens.muted}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        style={[styles.input, { color: tokens.text }]}
      />

      {value.length > 0 ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="清除搜索"
          onPress={() => onChangeText("")}
          hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}
          style={({ pressed }) => [styles.clear, { opacity: pressed ? 0.55 : 1 }]}
        >
          <Text style={[styles.clearGlyph, { color: tokens.muted }]}>×</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    minHeight: 44,
    paddingHorizontal: space.md,
    borderRadius: radius.control,
    borderWidth: StyleSheet.hairlineWidth,
  },
  glyph: {
    width: 13,
    height: 13,
    justifyContent: "center",
    alignItems: "center",
  },
  lens: {
    width: 10,
    height: 10,
    borderRadius: 5,
    borderWidth: 1.5,
  },
  handle: {
    position: "absolute",
    right: 0,
    bottom: 0,
    width: 5,
    height: 1.5,
    borderRadius: 1,
    transform: [{ rotate: "45deg" }],
  },
  input: {
    flex: 1,
    minHeight: 44,
    paddingVertical: 0,
    fontSize: font.title,
  },
  clear: {
    minWidth: 32,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  clearGlyph: {
    fontSize: 22,
    lineHeight: 24,
  },
});
