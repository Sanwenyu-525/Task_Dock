// 工具页：现有移动端工具的统一入口 + 未移植桌面能力的图标占位。
// 不是桌面工具面板的复制：能用的一律连现有页面，不能用的只占位。
//
// 第三轮口径（去重）：每个能力只出现一次。
// 第四轮口径（视觉）：三组都用「无边框浅蓝容器」而不是白卡套白卡；真实入口是浅蓝底板 + 蓝线图标，
// 占位是中性底板 + 灰线图标，底部一行说明解释这个差别，避免用户反复点灰图标。
import { ScrollView, StyleSheet, Text, View } from "react-native";

import { FeatureIconPlaceholder } from "../components/FeatureIconPlaceholder";
import { GlassCard } from "../components/GlassCard";
import { HeaderIconButton } from "../components/HeaderIconButton";
import { IconEntry } from "../components/IconEntry";
import { ScreenHeader } from "../components/ScreenHeader";
import { SectionHeader } from "../components/SectionHeader";
import type { AppNav } from "../lib/nav";
import { useTheme } from "../theme/ThemeProvider";
import { font, space } from "../theme/tokens";

const DEV_TOOLS = [
  { icon: "snippet", label: "代码片段", spokenLabel: "代码片段" },
  { icon: "api", label: "API 调试", spokenLabel: "API 调试" },
  { icon: "json", label: "JSON 格式化", spokenLabel: "JSON 格式化" },
  { icon: "regex", label: "正则测试", spokenLabel: "正则测试" },
] as const;

// 320dp 下四列单元只有 ~60dp 宽，5 个字会断行；视觉上用「暂存架」，读屏仍播报全称
const EFFICIENCY_TOOLS = [
  { icon: "clipboard", label: "剪贴板", spokenLabel: "剪贴板" },
  { icon: "fileStack", label: "暂存架", spokenLabel: "文件暂存架" },
  { icon: "workflow", label: "工作流", spokenLabel: "工作流" },
] as const;

export function ToolsScreen({ nav, inboxCount }: { nav: AppNav; inboxCount: number }) {
  const { tokens } = useTheme();

  return (
    <View style={styles.root}>
      <ScreenHeader
        title="工具"
        right={
          <HeaderIconButton
            icon="bell"
            accessibilityLabel="通知"
            onPress={() => nav.push("notifications")}
          />
        }
      />

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.group}>
          <SectionHeader icon="wrench" title="常用工具" />
          <GlassCard level="tertiary" style={styles.gridCard}>
            <View style={styles.grid}>
              <IconEntry
                icon="inbox"
                label="收集箱"
                badge={inboxCount}
                onPress={() => nav.push("inbox")}
              />
              <IconEntry icon="note" label="笔记" onPress={() => nav.push("notes")} />
              <IconEntry icon="transfer" label="文件互传" onPress={() => nav.push("files")} />
              <IconEntry icon="sync" label="同步中心" onPress={() => nav.push("sync")} />
            </View>
          </GlassCard>
        </View>

        <View style={styles.group}>
          <SectionHeader icon="zap" title="效率工具" />
          <GlassCard level="tertiary" style={styles.gridCard}>
            <View style={styles.grid}>
              {/* 快速笔记 = 直接新建，不是「笔记」列表的第二个人口 */}
              <IconEntry icon="noteNew" label="快速笔记" onPress={() => nav.push("note_editor")} />
              {EFFICIENCY_TOOLS.map((tool) => (
                <View key={tool.label} style={styles.cell}>
                  <FeatureIconPlaceholder
                    icon={tool.icon}
                    label={tool.label}
                    spokenLabel={tool.spokenLabel}
                    compact
                  />
                </View>
              ))}
            </View>
          </GlassCard>
        </View>

        <View style={styles.group}>
          <SectionHeader icon="codeTerminal" title="开发工具" />
          <GlassCard level="tertiary" accessibilityLabel="开发工具，移动端暂未接入">
            <View style={[styles.grid, styles.gridPad]}>
              {DEV_TOOLS.map((tool) => (
                <View key={tool.label} style={styles.cell}>
                  <FeatureIconPlaceholder
                    icon={tool.icon}
                    label={tool.label}
                    spokenLabel={tool.spokenLabel}
                    compact
                  />
                </View>
              ))}
            </View>
          </GlassCard>
        </View>

        <Text style={[styles.footnote, { color: tokens.muted }]}>
          灰色图标是桌面端已有、移动端尚未接入的能力；浅蓝底板的入口都可以直接使用。
        </Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: {
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: space.xxl,
    gap: space.section,
  },
  /** 模块内标题与内容 12dp；模块之间 20dp */
  group: { gap: space.md },
  gridCard: { paddingHorizontal: space.sm, paddingVertical: space.xs },
  grid: { flexDirection: "row", flexWrap: "wrap" },
  gridPad: { paddingVertical: space.xs },
  cell: { flexBasis: "25%" },
  footnote: {
    fontSize: font.label,
    lineHeight: 18,
    paddingHorizontal: space.xxs,
  },
});
