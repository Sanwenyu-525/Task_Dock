// 分组条：与任务行拼成一个连续分组卡，而不是「标题 + 一堆独立白卡」。
// 浅蓝 = 待办/今天，浅绿 = 已完成，浅琥珀 = 需要留意的逾期提示。
// 左侧语义图标放在实色圆底上，计数用白底胶囊，右侧折叠箭头；点击整条开合。
// 纯展示，不参与分组计算（分组在 src/screens/taskGroups.ts）。
import { memo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { useTheme } from "../theme/ThemeProvider";
import { font, radius, space } from "../theme/tokens";

import { AppIcon, type IconName } from "./icons/AppIcon";

export type GroupTone = "accent" | "warn" | "ok" | "muted";
export type GroupHintTone = "muted" | "warn";

function TaskGroupHeaderBase({
  title,
  count,
  icon,
  hint,
  hintTone = "muted",
  tone = "muted",
  collapsed = false,
  onPress,
}: {
  title: string;
  count: number;
  /** 分组语义图标；不传时用通用列表图标 */
  icon?: IconName;
  hint?: string;
  /** 补充说明的色调：warn 用于「N 项已逾期」这类需要留意的提示 */
  hintTone?: GroupHintTone;
  tone?: GroupTone;
  /** true = 该分组已折叠，任务行不显示 */
  collapsed?: boolean;
  /** 传入即整行可点，用于开合分组 */
  onPress?: () => void;
}) {
  const { tokens } = useTheme();
  const background =
    tone === "accent"
      ? tokens.accentWash
      : tone === "warn"
        ? tokens.warnSoft
        : tone === "ok"
          ? tokens.okSoft
          : tokens.bgAccent;
  const mark =
    tone === "accent"
      ? tokens.accent
      : tone === "warn"
        ? tokens.warn
        : tone === "ok"
          ? tokens.ok
          : tokens.muted;
  const markText =
    tone === "ok" ? tokens.onOk : tone === "muted" ? tokens.textSoft : tokens.onAccent;

  const content = (
    <>
      <View style={[styles.mark, { backgroundColor: tone === "muted" ? tokens.track : mark }]}>
        <AppIcon name={icon ?? "list"} color={markText} size={13} />
      </View>
      <Text style={[styles.title, { color: tokens.text }]}>{title}</Text>
      <View style={[styles.countPill, { backgroundColor: tokens.card }]}>
        <Text style={[styles.count, { color: mark }]}>{count}</Text>
      </View>
      {hint ? (
        <View
          style={[
            styles.hintPill,
            { backgroundColor: hintTone === "warn" ? tokens.warnSoft : tokens.track },
          ]}
        >
          <Text
            numberOfLines={1}
            style={[styles.hint, { color: hintTone === "warn" ? tokens.warn : tokens.muted }]}
          >
            {hint}
          </Text>
        </View>
      ) : null}
      {onPress ? (
        <View style={styles.chevronBox} pointerEvents="none">
          <AppIcon name={collapsed ? "chevronRight" : "chevronDown"} color={tokens.muted} size={16} />
        </View>
      ) : null}
    </>
  );

  const shape = {
    backgroundColor: background,
    borderTopLeftRadius: radius.row,
    borderTopRightRadius: radius.row,
    borderBottomLeftRadius: collapsed ? radius.row : 0,
    borderBottomRightRadius: collapsed ? radius.row : 0,
    borderBottomWidth: collapsed ? 0 : StyleSheet.hairlineWidth,
    borderBottomColor: tokens.separator,
  };

  if (!onPress) {
    return (
      <View
        accessible
        accessibilityRole="header"
        accessibilityLabel={`${title}，${count} 项${hint ? `，${hint}` : ""}`}
        style={[styles.row, shape]}
      >
        {content}
      </View>
    );
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${title}，${count} 项${hint ? `，${hint}` : ""}`}
      accessibilityHint={collapsed ? "展开该分组" : "折叠该分组"}
      accessibilityState={{ expanded: !collapsed }}
      onPress={onPress}
      style={({ pressed }) => [styles.row, shape, { opacity: pressed ? 0.72 : 1 }]}
    >
      {content}
    </Pressable>
  );
}

/** 分组头在每分钟 now 刷新时也会重渲染，参数全是原始值，memo 后可直接跳过 */
export const TaskGroupHeader = memo(TaskGroupHeaderBase);

const styles = StyleSheet.create({
  row: {
    minHeight: 46,
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingHorizontal: space.md,
    marginTop: space.md,
  },
  mark: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  title: {
    fontSize: font.body + 1,
    fontWeight: "700",
    letterSpacing: 0.1,
  },
  countPill: {
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    paddingHorizontal: 5,
    alignItems: "center",
    justifyContent: "center",
  },
  count: {
    fontSize: font.label,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  hintPill: {
    paddingHorizontal: space.sm,
    paddingVertical: 2,
    borderRadius: 999,
  },
  hint: {
    flexShrink: 1,
    fontSize: font.label,
    fontWeight: "600",
  },
  chevronBox: {
    marginLeft: "auto",
    width: 24,
    height: 24,
    alignItems: "center",
    justifyContent: "center",
  },
});
