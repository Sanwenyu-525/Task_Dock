// 设置类分区块：色条 + 标题的卡片容器。从 SettingsScreen 的私有 Section 泛化，
// 供设置页与推送页（同步/通知）共用；头部右侧可挂徽标。
import type { ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";

import { useTheme } from "../theme/ThemeProvider";
import { font, space } from "../theme/tokens";

import { GlassCard } from "./GlassCard";

export function SettingSection({
  title,
  trailing,
  children,
}: {
  title: string;
  trailing?: ReactNode;
  children: ReactNode;
}) {
  const { tokens } = useTheme();

  return (
    <GlassCard style={styles.section}>
      <View style={styles.head}>
        <View style={styles.headRow}>
          <View style={[styles.bar, { backgroundColor: tokens.accent }]} />
          <Text accessibilityRole="header" style={[styles.title, { color: tokens.text }]}>
            {title}
          </Text>
        </View>
        {trailing}
      </View>
      {children}
    </GlassCard>
  );
}

const styles = StyleSheet.create({
  section: {
    padding: space.md + 2,
    gap: space.sm,
  },
  head: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.sm,
  },
  headRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
  },
  bar: {
    width: 3,
    height: 14,
    borderRadius: 2,
  },
  title: {
    fontSize: font.title,
    fontWeight: "700",
  },
});
