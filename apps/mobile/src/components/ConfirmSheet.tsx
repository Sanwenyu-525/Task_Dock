// 危险操作确认弹层：任务列表、任务详情等删除入口共用同一份确认语义与按钮排布。
//
// 为什么抽出来：旧实现里「详情页二次确认、列表滑删直接删」两套体验并存，
// 同一件事在不同入口的要求不一样，用户无法形成稳定预期。统一到这里之后，
// 所有删除都必须经过一次明确确认（不引入"撤销"这种更依赖时机的机制）。
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";

import { useTheme } from "../theme/ThemeProvider";
import { font, radius, space } from "../theme/tokens";

import { BottomSheet } from "./BottomSheet";
import { PressableScale } from "./PressableScale";

export function ConfirmSheet({
  visible,
  title,
  message,
  confirmLabel,
  cancelLabel = "取消",
  busy = false,
  onConfirm,
  onRequestClose,
  accessibilityLabel,
}: {
  visible: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  /** 确认动作进行中：按钮显示加载并禁止重复点击 */
  busy?: boolean;
  onConfirm: () => void;
  onRequestClose: () => void;
  accessibilityLabel: string;
}) {
  const { tokens } = useTheme();

  return (
    <BottomSheet
      visible={visible}
      onRequestClose={onRequestClose}
      accessibilityLabel={accessibilityLabel}
    >
      <Text style={[styles.title, { color: tokens.text }]}>{title}</Text>
      <Text style={[styles.body, { color: tokens.muted }]}>{message}</Text>
      <View style={styles.actions}>
        <PressableScale
          onPress={onRequestClose}
          accessibilityRole="button"
          accessibilityLabel={cancelLabel}
          accessibilityState={{ disabled: busy }}
          disabled={busy}
          style={styles.actionPress}
          contentStyle={[styles.action, { backgroundColor: tokens.track }]}
        >
          <Text style={[styles.actionText, { color: tokens.text }]}>{cancelLabel}</Text>
        </PressableScale>
        <PressableScale
          onPress={onConfirm}
          accessibilityRole="button"
          accessibilityLabel={confirmLabel}
          accessibilityState={{ disabled: busy }}
          disabled={busy}
          style={styles.actionPress}
          contentStyle={[styles.action, { backgroundColor: tokens.dangerFill }]}
        >
          {busy ? (
            <ActivityIndicator size="small" color={tokens.onDanger} />
          ) : (
            <Text style={[styles.actionText, styles.confirmText, { color: tokens.onDanger }]}>
              {confirmLabel}
            </Text>
          )}
        </PressableScale>
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: font.title, fontWeight: "700", paddingBottom: space.xs },
  body: { fontSize: font.meta, lineHeight: 19, paddingBottom: space.md },
  actions: { flexDirection: "row", gap: space.sm },
  actionPress: { flex: 1 },
  action: {
    minHeight: 48,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.row,
  },
  actionText: { fontSize: font.body, fontWeight: "600" },
  confirmText: { fontWeight: "700" },
});
