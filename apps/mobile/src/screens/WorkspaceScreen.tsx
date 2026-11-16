// 工作区（第七轮布局）：项目空间 / 我的工作区。
// 顺序：Header → 分段 → 我的项目空间 → 内容管理 → 协作动态 → 文件集合。
//
// 第九轮职责收口：工作区只保留「工作内容与资源」——
// - 内容管理：收集箱 + 笔记（唯一的主归属；首页可保留快捷入口）；
// - 文件集合：文件互传 + 本机素材暂存 + 项目资源（文件互传只在这一处出现，
//   不再同时放在常用工具网格里）；
// - 同步中心属于设备与系统管理，已移出工作区，主入口在「我的」。
//
// 数据边界（重要）：
// - 手机端目前没有 workspace_projects / workspace_items 的同步链路，
//   因此「我的项目空间」只渲染无数据占位面板，不填演示项目、版本、成员或百分比，也不跳转。
// - 协作动态同理：本机笔记/文件互传活动不会被伪装成团队协作动态。
import { useState } from "react";
import { ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";

import { EntryRow } from "../components/EntryRow";
import { FeatureIconPlaceholder } from "../components/FeatureIconPlaceholder";
import { FileCollectionCard } from "../components/FileCollectionCard";
import { shouldStackFileCards } from "../lib/responsiveLayout";
import { GlassCard } from "../components/GlassCard";
import { ProjectSpacePlaceholder } from "../components/ProjectSpaceCard";
import { ScreenHeader } from "../components/ScreenHeader";
import { SectionHeader } from "../components/SectionHeader";
import { SegmentedControl, type SegmentOption } from "../components/SegmentedControl";
import { AppIcon, type IconName } from "../components/icons/AppIcon";
import type { AppNav } from "../lib/nav";
import { useTheme } from "../theme/ThemeProvider";
import { font, space } from "../theme/tokens";

type WorkspaceTab = "projects" | "mine";

const TABS: SegmentOption<WorkspaceTab>[] = [
  { value: "projects", label: "项目空间" },
  { value: "mine", label: "我的工作区" },
];

/** 我的工作区入口：四项都需要桌面端工作区数据，手机端只保留不可点击的中性占位 */
const MINE_ENTRIES: ReadonlyArray<{ icon: IconName; label: string }> = [
  { icon: "scene", label: "场景工作区" },
  { icon: "terminal", label: "开发工作台" },
  { icon: "site", label: "工作现场" },
  { icon: "workflow", label: "工作流" },
];

export function WorkspaceScreen({
  nav,
  inboxCount,
}: {
  nav: AppNav;
  inboxCount: number;
}) {
  const { tokens } = useTheme();
  // Android 的 font_scale 是 float32：1.3 实际为 1.29999995，不能用 >= 1.3
  const { fontScale, width } = useWindowDimensions();
  // 320dp 三列卡片每格仅约 90dp，文件名会挤成竖排；窄屏或大字号改为纵向整行卡片。
  const stackFiles = shouldStackFileCards(width, fontScale);
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
              {/* 项目数据没有同步链路：只渲染无数据占位面板，不渲染演示项目/假进度，也不跳转 */}
              <ProjectSpacePlaceholder />
            </View>

            <View style={styles.group}>
              <SectionHeader icon="folderOpen" title="内容管理" />
              {/* 收集箱与笔记的唯一主归属在这里；首页只保留快捷入口，工具/我的不再重复目录。
                  两项用一张白卡而不是 25% 网格，避免四项网格只剩两格时右侧留出半排空白。 */}
              <GlassCard style={styles.listCard}>
                <EntryRow
                  icon="inbox"
                  label="收集箱"
                  helper="桌面端与系统分享收进来的速记，待整理"
                  trailingText={inboxCount > 0 ? `${inboxCount} 条` : undefined}
                  onPress={() => nav.push("inbox")}
                />
                <EntryRow
                  icon="note"
                  label="笔记"
                  helper="本机笔记，可与电脑双向同步"
                  divider
                  onPress={() => nav.push("notes")}
                />
              </GlassCard>
            </View>

            <View style={styles.group}>
              <SectionHeader icon="users" title="协作动态" />
              {/* 没有卡片外壳，避免一条很宽的空卡；占位只说明状态 */}
              <View
                accessible
                accessibilityLabel="项目活动尚未同步到手机"
                accessibilityState={{ disabled: true }}
                style={styles.activityPlaceholder}
              >
                <AppIcon name="users" color={tokens.faint} size={18} />
                <Text style={[styles.activityText, { color: tokens.muted }]}>
                  项目活动尚未同步到手机
                </Text>
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
                  label="本机素材暂存"
                  caption="本机采集素材"
                  layout={stackFiles ? "row" : "column"}
                  onPress={() => nav.push("capture_stash")}
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
                场景工作区、开发工作台、工作现场、工作流都需要桌面端工作区数据，手机端暂未接入。
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
  listCard: { paddingHorizontal: space.md, paddingVertical: space.xxs },
  activityPlaceholder: {
    minHeight: 32,
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingHorizontal: 2,
  },
  activityText: {
    fontSize: font.meta,
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
