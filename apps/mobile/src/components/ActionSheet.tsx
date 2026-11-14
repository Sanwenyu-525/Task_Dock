// 长按动作表：替代原生 Alert。动作竖排、危险项用 danger 色，取消按钮单独一块。
// 只负责展示与回调，不直接改数据——避免弹层里出现业务逻辑。
import { Pressable, StyleSheet, Text, View } from "react-native";

import { useTheme } from "../theme/ThemeProvider";
import { font, radius, space } from "../theme/tokens";

import { BottomSheet } from "./BottomSheet";
import { AppIcon, type IconName } from "./icons/AppIcon";

export interface SheetAction {
  key: string;
  label: string;
  hint?: string;
  tone?: "default" | "primary" | "danger";
  disabled?: boolean;
  /** 可选的行首图标；只有语义明确时才给，避免每个动作都挂图标变成装饰 */
  icon?: IconName;
}

export function ActionSheet({
  visible,
  title,
  subtitle,
  actions,
  onAction,
  onRequestClose,
  entityLabel = "任务操作",
}: {
  visible: boolean;
  title: string;
  subtitle?: string;
  actions: SheetAction[];
  onAction: (key: string) => void;
  onRequestClose: () => void;
  /** 无障碍播报的实体前缀；笔记等复用本组件时不能仍读「任务操作」 */
  entityLabel?: string;
}) {
  const { tokens } = useTheme();

  return (
    <BottomSheet
      visible={visible}
      onRequestClose={onRequestClose}
      accessibilityLabel={`${entityLabel}：${title}`}
      maxHeightRatio={0.7}
    >
      <View style={styles.header}>
        <Text numberOfLines={2} style={[styles.title, { color: tokens.text }]}>
          {title}
        </Text>
        {subtitle ? (
          <Text numberOfLines={1} style={[styles.subtitle, { color: tokens.muted }]}>
            {subtitle}
          </Text>
        ) : null}
      </View>

      <View style={[styles.group, { borderColor: tokens.separator }]}>
        {actions.map((action, index) => {
          const color =
            action.tone === "danger"
              ? tokens.danger
              : action.tone === "primary"
                ? tokens.accent
                : tokens.text;
          return (
            <Pressable
              key={action.key}
              accessibilityRole="button"
              accessibilityLabel={action.label}
              accessibilityHint={action.hint}
              accessibilityState={{ disabled: action.disabled === true }}
              disabled={action.disabled}
              onPress={() => onAction(action.key)}
              style={({ pressed }) => [
                styles.action,
                index > 0 ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: tokens.separator } : null,
                { opacity: action.disabled ? 0.4 : pressed ? 0.6 : 1 },
              ]}
            >
              {action.icon ? <AppIcon name={action.icon} color={color} size={20} /> : null}
              <View style={styles.actionBody}>
                <Text style={[styles.actionLabel, { color }]}>{action.label}</Text>
                {action.hint ? (
                  <Text style={[styles.actionHint, { color: tokens.muted }]}>{action.hint}</Text>
                ) : null}
              </View>
            </Pressable>
          );
        })}
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="取消操作"
        onPress={onRequestClose}
        style={({ pressed }) => [
          styles.cancel,
          {
            backgroundColor: tokens.track,
            borderColor: tokens.cardBorder,
            opacity: pressed ? 0.7 : 1,
          },
        ]}
      >
        <Text style={[styles.cancelLabel, { color: tokens.text }]}>取消</Text>
      </Pressable>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  header: {
    paddingBottom: space.md,
    gap: 3,
  },
  title: {
    fontSize: font.title + 1,
    fontWeight: "700",
    lineHeight: 22,
  },
  subtitle: {
    fontSize: font.meta,
  },
  group: {
    borderRadius: radius.row,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  action: {
    minHeight: 54,
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  actionBody: {
    flex: 1,
    gap: 2,
  },
  actionLabel: {
    fontSize: font.title,
    fontWeight: "600",
  },
  actionHint: {
    fontSize: font.label,
    lineHeight: 15,
  },
  cancel: {
    marginTop: space.md,
    minHeight: 48,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.row,
    borderWidth: StyleSheet.hairlineWidth,
  },
  cancelLabel: {
    fontSize: font.title,
    fontWeight: "600",
  },
});
