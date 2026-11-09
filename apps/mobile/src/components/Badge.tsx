// 规划状态徽标：「规划中」= 设计承诺、代码未接；「未实现」= 明确不做/未接入的能力；
// 「已接入」= 真实可用的网络/系统能力（如局域网配对），用成功色区分于规划态。
// 只做展示，不携带交互——可点的入口统一放在行/按钮上。
import { StyleSheet, Text, View } from "react-native";

import { useTheme } from "../theme/ThemeProvider";
import { font, space } from "../theme/tokens";

export type BadgeTone = "planned" | "unimplemented" | "active";

export function Badge({
  label,
  tone = "planned",
}: {
  label: string;
  tone?: BadgeTone;
}) {
  const { tokens } = useTheme();
  const background =
    tone === "planned" ? tokens.accentSoft : tone === "active" ? tokens.okSoft : tokens.track;
  const color = tone === "planned" ? tokens.accent : tone === "active" ? tokens.ok : tokens.muted;

  return (
    <View accessibilityRole="text" style={[styles.badge, { backgroundColor: background }]}>
      <Text style={[styles.label, { color }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    alignSelf: "flex-start",
    paddingHorizontal: space.sm,
    paddingVertical: 3,
    borderRadius: 999,
  },
  label: {
    fontSize: font.label,
    fontWeight: "600",
    lineHeight: font.label + 3,
  },
});
