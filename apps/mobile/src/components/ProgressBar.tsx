// 进度条：只表达真实比例（0..1），不做数字跳动动画、不内置示例值。
// 用在首页「整体进度」、任务详情、暂存架容量这类有真实统计的位置。
import { StyleSheet, Text, View } from "react-native";

import { useTheme } from "../theme/ThemeProvider";
import { font, radius, space } from "../theme/tokens";

export function ProgressBar({
  value,
  label,
  tone = "accent",
  height = 8,
}: {
  /** 0..1；非法值按 0 处理，不猜百分比 */
  value: number;
  /** 右侧读数（如 "68%"），由调用方用真实统计算出 */
  label?: string;
  tone?: "accent" | "ok" | "warn";
  height?: number;
}) {
  const { tokens } = useTheme();
  const ratio = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
  const fill =
    tone === "ok" ? tokens.ok : tone === "warn" ? tokens.warn : tokens.accentFill;

  return (
    <View style={styles.wrap}>
      <View
        accessibilityRole="progressbar"
        accessibilityValue={{ min: 0, max: 100, now: Math.round(ratio * 100) }}
        style={[styles.track, { height, backgroundColor: tokens.track }]}
      >
        <View style={[styles.fill, { width: `${ratio * 100}%`, backgroundColor: fill }]} />
      </View>
      {label ? <Text style={[styles.label, { color: tokens.muted }]}>{label}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: "row", alignItems: "center", gap: space.sm },
  track: {
    flex: 1,
    borderRadius: radius.chip,
    overflow: "hidden",
  },
  fill: { height: "100%", borderRadius: radius.chip },
  label: { fontSize: font.label, fontWeight: "600" },
});
