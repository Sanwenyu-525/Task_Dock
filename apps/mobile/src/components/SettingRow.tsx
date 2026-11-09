// 静态信息行：label 在左、value 在右（设置页「关于」、同步页只读字段共用）。
import { StyleSheet, Text, View } from "react-native";

import { useTheme } from "../theme/ThemeProvider";
import { font, space } from "../theme/tokens";

export function SettingRow({
  label,
  value,
  valueTone = "default",
}: {
  label: string;
  value: string;
  /** default=正文强调；muted=次级信息（未配置、规划项的值） */
  valueTone?: "default" | "muted";
}) {
  const { tokens } = useTheme();

  return (
    <View style={styles.line}>
      <Text style={[styles.label, { color: tokens.muted }]}>{label}</Text>
      <Text
        numberOfLines={1}
        style={[styles.value, { color: valueTone === "muted" ? tokens.muted : tokens.text }]}
      >
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  line: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: space.md,
    minHeight: 26,
  },
  label: {
    fontSize: font.body,
  },
  value: {
    flexShrink: 1,
    fontSize: font.body,
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
    textAlign: "right",
  },
});
