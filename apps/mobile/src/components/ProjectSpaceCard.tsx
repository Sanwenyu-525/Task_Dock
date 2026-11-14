// Project Workspace 项目卡：字段全部来自真实数据（docs/WORKSPACE_PROJECTS.md §2）。
// 进度只在有事项统计时显示；没有统计就显示状态/数量，不推算百分比。
// 当前手机端还没有 workspace_projects 的同步链路，因此页面先渲染 ProjectSpacePlaceholder，
// 卡片组件保留结构，等数据接入后直接替换占位，不必重写布局。
import { StyleSheet, Text, View } from "react-native";

import {
  WORKSPACE_PROJECT_KIND_LABEL,
  WORKSPACE_PROJECT_STATUS_LABEL,
  describeProjectCardInteraction,
  projectProgressPercent,
  type WorkspaceProjectSummary,
} from "../domain/workspace";
import { useTheme } from "../theme/ThemeProvider";
import { font, radius, space } from "../theme/tokens";

import { GlassCard } from "./GlassCard";
import { IconTile } from "./IconTile";
import { type IconName } from "./icons/AppIcon";
import { PressableScale } from "./PressableScale";

const KIND_ICON: Record<WorkspaceProjectSummary["kind"], IconName> = {
  development: "code",
  game: "tools",
  ai_comic: "sparkles",
  general: "project",
};

export function ProjectSpaceCard({
  project,
  width,
  onPress,
}: {
  project: WorkspaceProjectSummary;
  width: number;
  onPress?: () => void;
}) {
  const { tokens } = useTheme();
  const progress = projectProgressPercent(project);

  const body = (
    <GlassCard style={[styles.card, { width }]}>
      <View style={styles.cardInner}>
        <IconTile name={KIND_ICON[project.kind]} size={38} />
        <Text numberOfLines={2} style={[styles.name, { color: tokens.text }]}>
          {project.name}
        </Text>
        <Text style={[styles.kind, { color: tokens.muted }]}>
          {WORKSPACE_PROJECT_KIND_LABEL[project.kind]} ·{" "}
          {WORKSPACE_PROJECT_STATUS_LABEL[project.status]}
        </Text>
        {progress != null ? (
          <>
            <View style={[styles.track, { backgroundColor: tokens.track }]}>
              <View
                style={[styles.fill, { width: `${progress}%`, backgroundColor: tokens.accent }]}
              />
            </View>
            <Text style={[styles.progressText, { color: tokens.accentText }]}>{progress}%</Text>
          </>
        ) : project.itemTotal != null ? (
          <Text style={[styles.progressText, { color: tokens.textSoft }]}>
            {project.itemDone ?? 0}/{project.itemTotal} 项已完成
          </Text>
        ) : (
          <Text style={[styles.progressText, { color: tokens.muted }]}>暂无事项统计</Text>
        )}
      </View>
    </GlassCard>
  );

  const interaction = describeProjectCardInteraction(project.name, Boolean(onPress));

  // 没有 onPress 就是纯展示：不声明 button 角色，也不留可点击热区。
  if (!onPress) {
    return (
      <View
        accessible
        accessibilityRole={interaction.accessibilityRole}
        accessibilityLabel={interaction.accessibilityLabel}
        accessibilityState={interaction.accessibilityState}
      >
        {body}
      </View>
    );
  }

  // 有 onPress 才绑定真实点击；这里不再只包一个空 View 冒充按钮。
  return (
    <PressableScale
      onPress={onPress}
      accessibilityLabel={interaction.accessibilityLabel}
      accessibilityHint="打开项目详情"
      style={styles.press}
      scaleTo={0.97}
    >
      {body}
    </PressableScale>
  );
}

/**
 * 真实数据未同步时的紧凑占位（约 72dp）：只说明状态，不重复模块标题「项目空间」。
 * 不渲染演示项目名、版本号、成员、百分比，也不提供假跳转。
 */
export function ProjectSpacePlaceholder() {
  const { tokens } = useTheme();

  return (
    <GlassCard
      level="primary"
      style={styles.placeholder}
      accessibilityLabel="项目数据尚未同步到手机"
    >
      <IconTile name="project" size={44} />
      <View style={styles.placeholderText}>
        <Text style={[styles.placeholderTitle, { color: tokens.text }]}>
          项目数据尚未同步到手机
        </Text>
        <Text numberOfLines={1} style={[styles.placeholderHint, { color: tokens.muted }]}>
          接入后在这里查看项目与事项
        </Text>
      </View>
    </GlassCard>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.card,
  },
  press: {},
  cardInner: {
    padding: space.md,
    gap: 6,
    minHeight: 142,
    justifyContent: "flex-start",
  },
  name: {
    fontSize: font.body,
    fontWeight: "700",
    lineHeight: 19,
  },
  kind: {
    fontSize: font.label,
    fontWeight: "600",
  },
  track: {
    height: 6,
    borderRadius: 3,
    overflow: "hidden",
    marginTop: space.xs,
  },
  fill: {
    height: 6,
    borderRadius: 3,
  },
  progressText: {
    fontSize: font.label,
    fontWeight: "700",
    marginTop: 2,
  },
  placeholder: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 76,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
    gap: space.md,
  },
  placeholderText: {
    flex: 1,
    gap: 2,
  },
  placeholderTitle: {
    fontSize: font.body,
    fontWeight: "700",
  },
  placeholderHint: {
    fontSize: font.label,
  },
});
