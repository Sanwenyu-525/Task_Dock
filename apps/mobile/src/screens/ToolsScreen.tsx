// 工具页：现有移动端工具的统一入口 + 未移植桌面能力的图标占位。
// 不是桌面工具面板的复制：能用的一律连现有页面，不能用的只占位。
//
// 第三轮口径（去重）：上一版「常用工具」与「收集与暂存」重复列出收集箱/文件互传/暂存架，
// 页面因此拖长一倍。现在每个能力只出现一次：
// - 常用工具：收集箱 / 笔记 / 文件互传 / 同步中心（全部真实）；
// - 效率工具：快速笔记（直接新建笔记）/ 剪贴板 / 文件暂存架 / 工作流（占位）；
// - 开发工具：代码片段 / API 调试 / JSON 格式化 / 正则测试（占位）。
import { ScrollView, StyleSheet, View } from "react-native";

import { FeatureIconPlaceholder } from "../components/FeatureIconPlaceholder";
import { GlassCard } from "../components/GlassCard";
import { HeaderIconButton } from "../components/HeaderIconButton";
import { IconEntry } from "../components/IconEntry";
import { ScreenHeader } from "../components/ScreenHeader";
import { SectionHeader } from "../components/SectionHeader";
import type { AppNav } from "../lib/nav";
import { space } from "../theme/tokens";

const DEV_TOOLS = [
  { icon: "code", label: "代码片段" },
  { icon: "api", label: "API 调试" },
  { icon: "doc", label: "JSON 格式化" },
  { icon: "search", label: "正则测试" },
] as const;

const EFFICIENCY_TOOLS = [
  { icon: "clipboard", label: "剪贴板" },
  { icon: "shelf", label: "文件暂存架" },
  { icon: "sparkle", label: "工作流" },
] as const;

export function ToolsScreen({ nav, inboxCount }: { nav: AppNav; inboxCount: number }) {
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
          <SectionHeader icon="grid" title="常用工具" />
          <GlassCard style={styles.gridCard}>
            <View style={styles.grid}>
              <IconEntry
                icon="inbox"
                label="收集箱"
                badge={inboxCount}
                onPress={() => nav.push("inbox")}
              />
              <IconEntry icon="doc" label="笔记" onPress={() => nav.push("notes")} />
              <IconEntry icon="transfer" label="文件互传" onPress={() => nav.push("files")} />
              <IconEntry icon="sync" label="同步中心" onPress={() => nav.push("sync")} />
            </View>
          </GlassCard>
        </View>

        <View style={styles.group}>
          <SectionHeader icon="clipboard" title="效率工具" />
          <GlassCard style={styles.gridCard}>
            <View style={styles.grid}>
              {/* 快速笔记 = 直接新建，不是「笔记」列表的第二个人口 */}
              <IconEntry
                icon="plus"
                label="快速笔记"
                onPress={() => nav.push("note_editor")}
              />
              {EFFICIENCY_TOOLS.map((tool) => (
                <View key={tool.label} style={styles.cell}>
                  <FeatureIconPlaceholder icon={tool.icon} label={tool.label} compact />
                </View>
              ))}
            </View>
          </GlassCard>
        </View>

        <View style={styles.group}>
          <SectionHeader icon="code" title="开发工具" />
          <GlassCard style={styles.gridCard} accessibilityLabel="开发工具，移动端暂未接入">
            <View style={styles.grid}>
              {DEV_TOOLS.map((tool) => (
                <View key={tool.label} style={styles.cell}>
                  <FeatureIconPlaceholder icon={tool.icon} label={tool.label} compact />
                </View>
              ))}
            </View>
          </GlassCard>
        </View>
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
  cell: { flexBasis: "25%" },
});
