// 冲突处理：数据驱动的解决界面。当前独立模式不会产生冲突（没有第二台设备），
// 真实状态是空态 + 规则说明；版本卡与逐字段合并随同步接入后启用。
import { StyleSheet, Text, View } from "react-native";

import { AppBar } from "../components/AppBar";
import { Badge } from "../components/Badge";
import { EmptyState } from "../components/EmptyState";
import { GlassCard } from "../components/GlassCard";
import type { Nav } from "../lib/nav";
import { useTheme } from "../theme/ThemeProvider";
import { font, space } from "../theme/tokens";

export function ConflictScreen({ nav }: { nav: Nav }) {
  const { tokens } = useTheme();

  return (
    <View style={styles.container}>
      <AppBar title="处理冲突" badge={<Badge label="规划中" />} onBack={nav.back} />

      <View style={[styles.explainer, { backgroundColor: tokens.accentSoft }]}>
        <Text style={[styles.explainerText, { color: tokens.text }]}>
          同一任务在两台设备被修改时，这里会并列展示两版内容，请选择保留哪一版；
          选择后会写入新 revision 并记录解决方式。
        </Text>
      </View>

      <EmptyState
        title="暂无需要处理的冲突"
        hint="冲突只在两台设备同时修改同一条数据时出现；先完成配对与同步，才会产生待处理的冲突"
      />

      <GlassCard style={styles.ruleCard}>
        <Text style={[styles.ruleTitle, { color: tokens.text }]}>冲突判定规则</Text>
        <Text style={[styles.ruleText, { color: tokens.textSoft }]}>
          以修改前的 revision（base_rev）判定：双端都改过的字段才冲突；截止时间、提醒、重复规则
          永远不会自动取某一端覆盖（不使用 last-write-wins）。
        </Text>
      </GlassCard>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  explainer: {
    marginHorizontal: space.lg,
    marginTop: space.md,
    padding: space.md,
    borderRadius: 16,
  },
  explainerText: {
    fontSize: font.body,
    lineHeight: 19,
  },
  ruleCard: {
    marginHorizontal: space.lg,
    marginTop: space.md,
    padding: space.md,
    gap: space.xs,
  },
  ruleTitle: {
    fontSize: font.body,
    fontWeight: "600",
  },
  ruleText: {
    fontSize: font.body,
    lineHeight: 19,
  },
});
