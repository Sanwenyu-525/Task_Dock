// 工具页（第七轮布局）：现有移动端工具的统一入口 + 未移植桌面能力的图标占位。
// 不是桌面工具面板的复制：能用的一律连现有页面，不能用的只占位。
//
// 三组不再使用同一种浅蓝容器：
// - 常用工具：无边框网格，真实入口的渐变底板最醒目；
// - 效率工具：一张白色列表卡（快速笔记可直接用，其余为禁用行）；
// - 开发工具：无容器中性网格，整组视觉权重最低。
// 数据与跳转语义完全沿用旧实现。
import { ScrollView, StyleSheet, Text, View } from "react-native";

import { EntryRow } from "../components/EntryRow";
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
  { icon: "snippet", label: "代码片段" },
  { icon: "api", label: "API 调试" },
  { icon: "json", label: "JSON 格式化" },
  { icon: "regex", label: "正则测试" },
] as const;

const EFFICIENCY_TOOLS = [
  { icon: "clipboard", label: "剪贴板" },
  { icon: "fileStack", label: "文件暂存架" },
  { icon: "workflow", label: "工作流" },
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
        </View>

        <View style={styles.group}>
          <SectionHeader icon="zap" title="效率工具" />
          <GlassCard style={styles.listCard}>
            {/* 快速笔记 = 直接新建，不是「笔记」列表的第二个人口 */}
            <EntryRow
              icon="noteNew"
              label="快速笔记"
              helper="直接新建一条笔记，不经过列表"
              onPress={() => nav.push("note_editor")}
            />
            {EFFICIENCY_TOOLS.map((tool) => (
              <EntryRow
                key={tool.label}
                icon={tool.icon}
                label={tool.label}
                helper="移动端暂未接入"
                divider
              />
            ))}
          </GlassCard>
        </View>

        <View style={styles.group}>
          <SectionHeader icon="codeTerminal" title="开发工具" />
          <View style={styles.grid} accessibilityLabel="开发工具，移动端暂未接入">
            {DEV_TOOLS.map((tool) => (
              <View key={tool.label} style={styles.cell}>
                <FeatureIconPlaceholder icon={tool.icon} label={tool.label} compact />
              </View>
            ))}
          </View>
        </View>

        <Text style={[styles.footnote, { color: tokens.muted }]}>
          灰色图标是桌面端已有、移动端尚未接入的能力；带蓝底的入口都可以直接使用。
        </Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: {
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
    paddingBottom: space.xxl,
    gap: space.section,
  },
  /** 模块内标题与内容 12dp；模块之间 20dp */
  group: { gap: space.md },
  grid: { flexDirection: "row", flexWrap: "wrap" },
  cell: { flexBasis: "25%" },
  listCard: { paddingHorizontal: space.md, paddingVertical: space.xxs },
  footnote: {
    fontSize: font.label,
    lineHeight: 18,
    paddingHorizontal: space.xxs,
  },
});
