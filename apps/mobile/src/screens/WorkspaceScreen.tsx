// 工作区：项目空间 / 我的工作区 两个分段。
// 顺序：Header → 分段 → 我的项目空间 → 常用工具 → 协作动态 → 文件集合。
//
// 数据边界（重要）：
// - 手机端目前没有 workspace_projects / workspace_items 的同步链路，
//   因此「我的项目空间」只渲染紧凑占位，不填演示项目、版本、成员或百分比。
// - 协作动态同理：本机笔记/文件互传活动不会被伪装成团队协作动态。
// - 真实可用的只有移动端已有能力：收集箱、笔记、文件互传、同步中心。
//
// 第四轮口径（视觉）：分组容器改成无边框浅蓝面板；文件集合保留三张白卡（「卡片」与
// 「分组容器」是两种层级，不能都做成白卡）；占位图标用中性底板，与真实入口一眼可分。
import { useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";

import { FeatureIconPlaceholder } from "../components/FeatureIconPlaceholder";
import { FileCollectionCard } from "../components/FileCollectionCard";
import { GlassCard } from "../components/GlassCard";
import { IconEntry } from "../components/IconEntry";
import { ProjectSpacePlaceholder } from "../components/ProjectSpaceCard";
import { ScreenHeader } from "../components/ScreenHeader";
import { SectionHeader } from "../components/SectionHeader";
import { SegmentedControl, type SegmentOption } from "../components/SegmentedControl";
import type { AppNav } from "../lib/nav";
import { useTheme } from "../theme/ThemeProvider";
import { font, space } from "../theme/tokens";

type WorkspaceTab = "projects" | "mine";

const TABS: SegmentOption<WorkspaceTab>[] = [
  { value: "projects", label: "项目空间" },
  { value: "mine", label: "我的工作区" },
];

/** 我的工作区：桌面端独立能力，手机端只有图标占位（不渲染无数据的空详情页） */
const MINE_ENTRIES = [
  { icon: "scene", label: "场景工作区" },
  { icon: "terminal", label: "开发工作台" },
  { icon: "site", label: "工作现场" },
  { icon: "workflow", label: "工作流" },
] as const;

export function WorkspaceScreen({
  nav,
  inboxCount,
}: {
  nav: AppNav;
  inboxCount: number;
}) {
  const { tokens } = useTheme();
  const [tab, setTab] = useState<WorkspaceTab>("projects");

  return (
    <View style={styles.root}>
      <ScreenHeader title="工作区" />

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <SegmentedControl
          options={TABS}
          value={tab}
          onChange={setTab}
          accessibilityLabel="工作区分段切换"
          emphasis="accent"
        />

        {tab === "projects" ? (
          <>
            <View style={styles.group}>
              <SectionHeader icon="project" title="我的项目空间" />
              <ProjectSpacePlaceholder />
            </View>

            <View style={styles.group}>
              {/* 没有用户自定义置顶配置，标题不能用「置顶工具」暗示可排序；
                  四项是固定常用入口，编辑按钮也就不展示。 */}
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
                  <IconEntry
                    icon="transfer"
                    label="文件互传"
                    onPress={() => nav.push("files")}
                  />
                  <IconEntry icon="sync" label="同步中心" onPress={() => nav.push("sync")} />
                </View>
              </GlassCard>
            </View>

            <View style={styles.group}>
              <SectionHeader icon="users" title="协作动态" />
              <GlassCard level="tertiary" style={styles.inlineCard}>
                {/* 模块标题已经写了「协作动态」，占位里只说明状态 */}
                <FeatureIconPlaceholder
                  icon="users"
                  hint="项目活动尚未同步到手机"
                  variant="inline"
                />
              </GlassCard>
            </View>

            <View style={styles.group}>
              <SectionHeader icon="folders" title="文件集合" />
              <View style={styles.filesRow}>
                <FileCollectionCard
                  icon="transfer"
                  label="文件互传"
                  caption="打开互传"
                  onPress={() => nav.push("files")}
                />
                <FileCollectionCard icon="fileStack" label="文件暂存架" />
                <FileCollectionCard icon="package" label="项目资源" />
              </View>
            </View>
          </>
        ) : (
          <>
            <View style={styles.group}>
              <SectionHeader icon="briefcase" title="我的工作区" />
              <GlassCard level="tertiary" style={styles.gridCard}>
                <View style={styles.entryGrid}>
                  {MINE_ENTRIES.map((entry) => (
                    <View key={entry.label} style={styles.entryCell}>
                      <FeatureIconPlaceholder
                        icon={entry.icon}
                        label={entry.label}
                        variant="grid"
                      />
                    </View>
                  ))}
                </View>
              </GlassCard>
              <Text style={[styles.footnote, { color: tokens.muted }]}>
                这四项需要桌面端的工作区数据，手机端暂只保留入口图标。
              </Text>
            </View>
          </>
        )}
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
  /** 模块内：标题与内容 12dp（模块之间由 content 的 20dp 负责） */
  group: { gap: space.md },
  gridCard: { paddingHorizontal: space.sm, paddingVertical: space.xs },
  grid: { flexDirection: "row", flexWrap: "wrap" },
  inlineCard: { paddingHorizontal: space.md, paddingVertical: 0 },
  filesRow: { flexDirection: "row", gap: space.sm, alignItems: "stretch" },
  entryGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    rowGap: space.xs,
  },
  entryCell: {
    flexBasis: "50%",
    flexGrow: 0,
  },
  footnote: {
    fontSize: font.label,
    lineHeight: 18,
    paddingHorizontal: space.xxs,
  },
});
