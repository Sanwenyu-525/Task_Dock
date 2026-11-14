// 工作区（第七轮布局）：项目空间 / 我的工作区。
// 顺序：Header → 分段 → 我的项目空间 → 常用工具 → 协作动态 → 文件集合。
//
// 数据边界（重要）：
// - 手机端目前没有 workspace_projects / workspace_items 的同步链路，
//   因此「我的项目空间」只渲染紧凑占位，不填演示项目、版本、成员或百分比。
// - 协作动态同理：本机笔记/文件互传活动不会被伪装成团队协作动态。
// - 真实可用的只有移动端已有能力：收集箱、笔记、文件互传、同步中心。
//
// 第七轮视觉：不再用整块浅蓝容器包住真实工具；常用工具直接以渐变图标底板网格
// 落在页面底上，真实入口比项目/协作占位更醒目。占位改成虚线空状态，不再是大白卡。
import { useState } from "react";
import { ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";

import { FeatureIconPlaceholder } from "../components/FeatureIconPlaceholder";
import { FileCollectionCard } from "../components/FileCollectionCard";
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
  // Android 的 font_scale 是 float32：1.3 实际为 1.29999995，不能用 >= 1.3
  const { fontScale } = useWindowDimensions();
  const stackFiles = fontScale > 1.25;
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
          size="compact"
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
              <View style={styles.toolGrid}>
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
            </View>

            <View style={styles.group}>
              <SectionHeader icon="users" title="协作动态" />
              {/* 没有卡片外壳，避免一条很宽的空卡；占位只说明状态 */}
              <View style={styles.activityPlaceholder}>
                <FeatureIconPlaceholder
                  icon="users"
                  hint="项目活动尚未同步到手机"
                  variant="inline"
                />
              </View>
            </View>

            <View style={styles.group}>
              <SectionHeader icon="folders" title="文件集合" />
              <View style={stackFiles ? styles.filesColumn : styles.filesRow}>
                <FileCollectionCard
                  icon="transfer"
                  label="文件互传"
                  caption="打开互传"
                  layout={stackFiles ? "row" : "column"}
                  onPress={() => nav.push("files")}
                />
                <FileCollectionCard
                  icon="fileStack"
                  label="文件暂存架"
                  layout={stackFiles ? "row" : "column"}
                />
                <FileCollectionCard
                  icon="package"
                  label="项目资源"
                  layout={stackFiles ? "row" : "column"}
                />
              </View>
            </View>
          </>
        ) : (
          <>
            <View style={styles.group}>
              <SectionHeader icon="briefcase" title="我的工作区" />
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
    paddingTop: space.sm,
    paddingBottom: space.xxl,
    gap: space.section,
  },
  /** 模块内：标题与内容 12dp（模块之间由 content 的 20dp 负责） */
  group: { gap: space.md },
  toolGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
  },
  activityPlaceholder: {
    paddingHorizontal: 2,
  },
  filesRow: { flexDirection: "row", gap: space.sm, alignItems: "stretch" },
  filesColumn: { gap: space.sm },
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
