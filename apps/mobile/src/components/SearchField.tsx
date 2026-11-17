// 搜索框：任务页与收集箱共用。放大镜与清除按钮统一走 AppIcon（同一套线性图标），
// 命中区按 44dp 补齐。
//
// 2026-11-17 整改：输入框常驻，不再由放大镜控制显示/隐藏。
// 为了让首页的放大镜能跨页面真正聚焦到输入框，组件接受外部 ref 与 autoFocus
import { useState, type ComponentRef, type RefObject } from "react";
import { Pressable, StyleSheet, TextInput, View } from "react-native";

import { useTheme } from "../theme/ThemeProvider";
import { font, radius, space } from "../theme/tokens";

import { AppIcon } from "./icons/AppIcon";

export function SearchField({
  value,
  onChangeText,
  placeholder,
  accessibilityLabel,
  inputRef,
  autoFocus = false,
}: {
  value: string;
  onChangeText: (text: string) => void;
  placeholder: string;
  accessibilityLabel: string;
  /** 外部持有输入框实例，用于跨页面/页内快捷按钮聚焦 */
  inputRef?: RefObject<ComponentRef<typeof TextInput> | null>;
  /** 仅首次挂载时生效；页面已挂载时用 inputRef.focus() 更可靠 */
  autoFocus?: boolean;
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
        <AppIcon name="search" color={tokens.muted} size={18} />
      </View>

      <TextInput
        ref={inputRef}
        autoFocus={autoFocus}
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
        underlineColorAndroid="transparent"
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
          <AppIcon name="close" color={tokens.muted} size={16} />
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
    width: 18,
    height: 18,
    justifyContent: "center",
    alignItems: "center",
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
});
