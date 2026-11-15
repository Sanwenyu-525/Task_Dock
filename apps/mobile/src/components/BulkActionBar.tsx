// 底部批量操作栏：多选态固定在页面底部的动作条（不是 Modal）。
//
// 职责边界：只负责展示「已选 N 项」与一排动作按钮并回调 onPress，不做任何业务判断；
// 能否点击、动作含义、确认弹层都由调用方决定。
//
// 布局约定：白卡 + 顶部 hairline + 底部安全区；动作按钮 44dp 热区，图标 18 + 文字 12。
// 出现时调用方要给列表内容区补 paddingBottom = BULK_ACTION_BAR_HEIGHT + insets.bottom，
// 避免最后一行被操作栏盖住。
import { Pressable, StyleSheet, Text, View } from "react-native";

import { useWindowInsets } from "../lib/insets";
import { useTheme } from "../theme/ThemeProvider";
import { font, space } from "../theme/tokens";

import { AppIcon, type IconName } from "./icons/AppIcon";

/** 动作栏本体高度（不含底部安全区）：44dp 热区 + 上下各 8dp 内边距。 */
export const BULK_ACTION_BAR_HEIGHT = 44 + space.sm * 2;

export interface BulkAction {
  key: string;
  label: string;
  icon: IconName;
  tone?: "danger" | "default";
  onPress: () => void;
  disabled?: boolean;
}

export function BulkActionBar({
  selectedCount,
  actions,
  onCancel,
}: {
  selectedCount: number;
  actions: BulkAction[];
  /** 可选：左侧退出多选的取消按钮（44dp 热区）；不传则不渲染 */
  onCancel?: () => void;
}) {
  const { tokens } = useTheme();
  const insets = useWindowInsets();

  return (
    <View
      accessibilityRole="toolbar"
      accessibilityLabel="批量操作"
      style={[
        styles.bar,
        {
          backgroundColor: tokens.card,
          borderTopColor: tokens.separator,
          paddingBottom: insets.bottom + space.sm,
        },
      ]}
    >
      <View style={styles.left}>
        {onCancel ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="退出多选"
            onPress={onCancel}
            hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
            style={({ pressed }) => [styles.cancel, { opacity: pressed ? 0.6 : 1 }]}
          >
            <AppIcon name="close" color={tokens.muted} size={22} />
          </Pressable>
        ) : null}
        <Text numberOfLines={1} style={[styles.count, { color: tokens.muted }]}>
          已选 {selectedCount} 项
        </Text>
      </View>

      <View style={styles.actions}>
        {actions.map((action) => {
          const danger = action.tone === "danger";
          const color = action.disabled
            ? tokens.faint
            : danger
              ? tokens.danger
              : tokens.accentText;
          return (
            <Pressable
              key={action.key}
              accessibilityRole="button"
              accessibilityLabel={action.label}
              accessibilityState={{ disabled: action.disabled === true }}
              disabled={action.disabled}
              onPress={action.onPress}
              style={({ pressed }) => [
                styles.action,
                { opacity: action.disabled ? 0.4 : pressed ? 0.6 : 1 },
              ]}
            >
              <AppIcon name={action.icon} color={color} size={18} />
              <Text numberOfLines={1} style={[styles.actionLabel, { color }]}>
                {action.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  left: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.xs,
    flexShrink: 1,
    minWidth: 0,
  },
  cancel: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    marginLeft: -space.xs,
  },
  count: {
    fontSize: font.meta,
    fontWeight: "600",
    flexShrink: 1,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.xs,
    marginLeft: "auto",
  },
  action: {
    minWidth: 44,
    minHeight: 44,
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: space.xxs,
    paddingHorizontal: space.sm,
  },
  actionLabel: {
    fontSize: font.label,
    fontWeight: "600",
  },
});
