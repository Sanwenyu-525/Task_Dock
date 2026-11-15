// 工具页（第九轮职责收口）：只保留「能直接执行的效率工具 + 采集中心 + 开发工具」。
//
// 这一轮删掉的三类重复入口（都已在别处有唯一主归属）：
// - 采集与整理网格（拍照/扫描/导入/素材库）：采集中心内部已完整提供，工具页不再复制；
// - 常用工具网格（收集箱/笔记/文件互传/同步中心）：分别归工作区与「我的」；
// - 右上角通知铃铛：通知的唯一主入口在「我的」，首页保留全局快捷入口。
//
// 三组仍用不同视觉权重：采集主卡 > 效率工具白卡 > 开发工具中性网格。
import { ScrollView, StyleSheet, Text, View } from "react-native";

import { EntryRow } from "../components/EntryRow";
import { FeatureIconPlaceholder } from "../components/FeatureIconPlaceholder";
import { GlassCard } from "../components/GlassCard";
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

export function ToolsScreen({ nav }: { nav: AppNav }) {
  const { tokens } = useTheme();

  return (
    <View style={styles.root}>
      <ScreenHeader title="工具" />

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.group}>
          <SectionHeader icon="camera" title="采集" />
          {/* 采集是最高频动作：一次点击进采集中心，具体方式（拍照/扫描/导入/语音/素材库）
              都在里面，不再在工具页重复铺一层子入口。 */}
          <GlassCard style={[styles.captureCard, { borderColor: tokens.cardBorderStrong }]}>
            <EntryRow
              icon="archive"
              label="采集中心"
              helper="拍照、扫描、导入、语音速记与最近素材"
              onPress={() => nav.push("capture_home")}
            />
          </GlassCard>
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
  grid: { flexDirection: "row", flexWrap: "wrap", rowGap: space.xs },
  cell: { flexBasis: "25%" },
  listCard: { paddingHorizontal: space.md, paddingVertical: space.xxs },
  captureCard: { paddingHorizontal: space.md, paddingVertical: space.xxs, borderWidth: 1 },
  footnote: {
    fontSize: font.label,
    lineHeight: 18,
    paddingHorizontal: space.xxs,
  },
});
