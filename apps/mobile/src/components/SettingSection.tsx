// 设置类分区块：图标底板 + 标题的卡片容器。从 SettingsScreen 的私有 Section 泛化，
// 供设置页与推送页（同步/通知）共用；头部右侧可挂徽标。
// 图标与一级页的 SectionHeader / 任务分组头同一套 AppIcon 语言，不再用色条。
import type { ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";

import { useTheme } from "../theme/ThemeProvider";
import { font, space } from "../theme/tokens";

import { GlassCard } from "./GlassCard";
import { AppIcon, type IconName } from "./icons/AppIcon";

export function SettingSection({
  icon,
  title,
  trailing,
  children,
}: {
  icon: IconName;
  title: string;
  trailing?: ReactNode;
  children: ReactNode;
}) {
  const { tokens } = useTheme();

  return (
    <GlassCard style={styles.section}>
      <View style={styles.head}>
        <View style={styles.headRow}>
          <View style={[styles.iconTile, { backgroundColor: tokens.accentSoft }]}>
            <AppIcon name={icon} size={14} color={tokens.accent} />
          </View>
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
  iconTile: {
    width: 24,
    height: 24,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  title: {
    fontSize: font.title,
    fontWeight: "700",
  },
});
