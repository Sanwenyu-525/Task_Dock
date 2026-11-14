// 首页 / 工作台：问候 → 今日专注 → 效率概览 → 最近内容 → 快捷入口 → AI 占位。
// 所有数字来自手机本地库（tasks/notes/captures）；没有进度字段的任务不推算百分比。
//
// 第三轮口径：欢迎区只负责打招呼；今日专注是首屏视觉主体；效率概览只回答「多少」。
// 第四轮口径（视觉）：
// - 欢迎区加一层蓝青柔光与品牌块，但高度仍控制在 88dp 左右，不占满首屏；
// - 今日专注升级为一级卡片（强描边 + 极轻阴影），真实任务标题是整页视觉焦点；
// - 效率概览从三张独立白卡收成「一张卡三段」，避免像后台 KPI 组件，也顺手解决 320dp 的 2+1 排列。
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";

import { GlassCard } from "../components/GlassCard";
import { FeatureIconPlaceholder } from "../components/FeatureIconPlaceholder";
import { HeaderIconButton } from "../components/HeaderIconButton";
import { IconEntry } from "../components/IconEntry";
import { IconTile } from "../components/IconTile";
import { AppIcon } from "../components/icons/AppIcon";
import { MetricTile } from "../components/MetricTile";
import { PressableScale } from "../components/PressableScale";
import { ScreenHeader } from "../components/ScreenHeader";
import { SectionHeader } from "../components/SectionHeader";
import { listCaptures } from "../db/captures";
import { listNotes } from "../db/notes";
import { listTasks } from "../db/tasks";
import { countTasks, formatDue, formatRelative } from "../domain/taskQuery";
import type { Capture, Note, Task } from "../domain/types";
import {
  buildRecentEntries,
  homeGreeting,
  pickFocusTask,
  type RecentEntry,
} from "../domain/workspace";
import { describeError } from "../lib/errors";
import type { AppNav } from "../lib/nav";
import { useTheme } from "../theme/ThemeProvider";
import { font, radius, space } from "../theme/tokens";

const PRIORITY_LABEL: Record<number, string> = { 1: "低优先级", 2: "中优先级", 3: "高优先级" };

export function HomeScreen({
  version,
  nav,
  inboxCount,
}: {
  version: number;
  nav: AppNav;
  inboxCount: number;
}) {
  const { tokens } = useTheme();
  // 窄屏 / 大字号时隐藏欢迎区的品牌块（纯装饰），把宽度让给问候语，避免「下午好，开发者」
  // 在 150% 字号下折成两行、最后一个字单独占一行。
  const { width, fontScale } = useWindowDimensions();
  const compactWelcome = width < 360 || fontScale > 1.25;
  const [tasks, setTasks] = useState<Task[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [captures, setCaptures] = useState<Capture[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  /** 防止较慢的旧请求覆盖较新的 version 刷新结果；卸载后不再写状态 */
  const requestSeq = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      requestSeq.current += 1;
    };
  }, []);

  const refresh = useCallback(async () => {
    const request = ++requestSeq.current;
    try {
      const [nextTasks, nextNotes, nextCaptures] = await Promise.all([
        listTasks(),
        listNotes(),
        listCaptures(),
      ]);
      if (!mounted.current || request !== requestSeq.current) return;
      setTasks(nextTasks);
      setNotes(nextNotes);
      setCaptures(nextCaptures);
      setError(null);
    } catch (reason) {
      if (!mounted.current || request !== requestSeq.current) return;
      setError(describeError(reason));
    } finally {
      if (!mounted.current || request !== requestSeq.current) return;
      setNow(Date.now());
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, version]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const counts = countTasks(tasks, now);
  const focus = pickFocusTask(tasks, now);
  const recent = buildRecentEntries(notes, captures, 3);
  const overdueFocus = focus?.dueAt != null && focus.dueAt < now;

  const openRecent = useCallback(
    (entry: RecentEntry) => {
      if (entry.kind === "note") {
        nav.push("note_editor", entry.id.replace(/^note-/, ""));
        return;
      }
      nav.push("inbox");
    },
    [nav],
  );

  return (
    <View style={styles.root}>
      <ScreenHeader
        title="工作台"
        right={
          <HeaderIconButton
            icon="bell"
            accessibilityLabel="通知"
            onPress={() => nav.push("notifications")}
          />
        }
      />

      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        {/* 欢迎区：轻量蓝青渐变 + 品牌块，只承担问候与一句话价值主张 */}
        <View
          style={[
            styles.welcome,
            {
              backgroundImage: `linear-gradient(120deg, ${tokens.accentWash} 0%, ${tokens.accentWashAlt} 100%)`,
            },
          ]}
        >
          <View style={styles.welcomeText}>
            <Text style={[styles.greeting, { color: tokens.text }]}>
              {homeGreeting(new Date(now).getHours())}
            </Text>
            <Text numberOfLines={2} style={[styles.tagline, { color: tokens.textSoft }]}>
              专注重要的事，高效推进每一个任务。
            </Text>
          </View>
          {compactWelcome ? null : <IconTile name="code" size={46} tone="brand" iconSize={22} />}
        </View>

        {loading ? (
          <ActivityIndicator style={styles.loading} color={tokens.accent} />
        ) : error ? (
          <GlassCard style={styles.errorCard}>
            <Text style={[styles.errorTitle, { color: tokens.danger }]}>读取本机数据失败</Text>
            <Text style={[styles.errorHint, { color: tokens.muted }]}>{error}</Text>
            <PressableScale
              onPress={() => void refresh()}
              accessibilityLabel="重试"
              style={styles.retryPress}
              contentStyle={[styles.retry, { backgroundColor: tokens.accentFill }]}
            >
              <Text style={[styles.retryText, { color: tokens.onAccent }]}>重试</Text>
            </PressableScale>
          </GlassCard>
        ) : (
          <>
            <SectionHeader icon="focus" title="今日专注" />
            {focus ? (
              <PressableScale
                onPress={() => nav.openTab("tasks")}
                accessibilityLabel={`今日专注：${focus.title}`}
                accessibilityHint="打开任务页处理"
                style={styles.focusPress}
              >
                <GlassCard level="primary" style={styles.focusCard}>
                  <View style={styles.focusTop}>
                    <IconTile name="focus" size={30} iconSize={18} />
                    <Text style={[styles.focusLabel, { color: tokens.muted }]}>当前待办</Text>
                    {focus.category ? (
                      <Text numberOfLines={1} style={[styles.focusCategory, { color: tokens.muted }]}>
                        {focus.category}
                      </Text>
                    ) : null}
                  </View>

                  <Text numberOfLines={2} style={[styles.focusTitle, { color: tokens.text }]}>
                    {focus.title}
                  </Text>

                  {focus.priority > 0 || focus.dueAt != null ? (
                    <View style={styles.metaRow}>
                      {focus.priority > 0 ? (
                        <View
                          style={[
                            styles.metaChip,
                            {
                              backgroundColor:
                                focus.priority >= 3 ? tokens.dangerSoft : tokens.warnSoft,
                            },
                          ]}
                        >
                          <Text
                            style={[
                              styles.metaText,
                              { color: focus.priority >= 3 ? tokens.danger : tokens.warn },
                            ]}
                          >
                            {PRIORITY_LABEL[focus.priority]}
                          </Text>
                        </View>
                      ) : null}
                      {focus.dueAt != null ? (
                        <View
                          style={[
                            styles.metaChip,
                            {
                              backgroundColor: overdueFocus ? tokens.warnSoft : tokens.accentSoft,
                            },
                          ]}
                        >
                          <AppIcon
                            name="clock"
                            color={overdueFocus ? tokens.warn : tokens.accentText}
                            size={12}
                          />
                          <Text
                            style={[
                              styles.metaText,
                              { color: overdueFocus ? tokens.warn : tokens.accentText },
                            ]}
                          >
                            {formatDue(focus.dueAt, now)}
                          </Text>
                        </View>
                      ) : null}
                    </View>
                  ) : null}

                  {/* 真实状态而不是编造的百分比：任务模型只有 pending/completed */}
                  <View style={[styles.focusFooter, { borderTopColor: tokens.separator }]}>
                    <Text style={[styles.focusHint, { color: tokens.muted }]}>
                      轻点打开任务页处理
                    </Text>
                    <View style={styles.openLink}>
                      <Text style={[styles.openText, { color: tokens.accentText }]}>查看任务</Text>
                      <AppIcon name="chevronRight" color={tokens.accentText} size={14} />
                    </View>
                  </View>
                </GlassCard>
              </PressableScale>
            ) : (
              <GlassCard level="primary" style={styles.focusCard}>
                <View style={styles.emptyFocus}>
                  <IconTile name="focus" size={30} iconSize={18} />
                  <Text style={[styles.focusTitle, { color: tokens.text }]}>还没有待办任务</Text>
                  <Text style={[styles.focusHint, { color: tokens.muted }]}>
                    先记下今天最重要的一件事，专注就有了落点。
                  </Text>
                  <PressableScale
                    onPress={nav.openCreateTask}
                    accessibilityLabel="新建任务"
                    style={styles.retryPress}
                    contentStyle={[styles.retry, { backgroundColor: tokens.accentFill }]}
                  >
                    <Text style={[styles.retryText, { color: tokens.onAccent }]}>新建任务</Text>
                  </PressableScale>
                </View>
              </GlassCard>
            )}

            <SectionHeader
              icon="stats"
              title="效率概览"
              actionLabel="查看详情"
              onAction={() => nav.openTab("tasks")}
            />
            {/* 一张卡三段：数字仍是主体，但不再是三张各自为政的后台 KPI 卡 */}
            <GlassCard style={styles.metricsCard}>
              <View style={styles.metricsRow}>
                <MetricTile variant="column" value={counts.pending} label="待办任务" tone="accent" />
                <View style={[styles.metricDivider, { backgroundColor: tokens.separator }]} />
                <MetricTile variant="column" value={counts.dueToday} label="今日到期" />
                <View style={[styles.metricDivider, { backgroundColor: tokens.separator }]} />
                <MetricTile variant="column" value={counts.completed} label="已完成" tone="ok" />
              </View>
            </GlassCard>

            <SectionHeader
              icon="note"
              title="最近内容"
              actionLabel="更多"
              onAction={() => nav.push("notes")}
            />
            {recent.length === 0 ? (
              <GlassCard style={styles.emptyRecent}>
                <Text style={[styles.emptyText, { color: tokens.muted }]}>
                  还没有笔记或速记。写下第一条后，这里会显示最近更新的内容。
                </Text>
              </GlassCard>
            ) : (
              <GlassCard style={styles.recentCard}>
                {recent.map((entry, index) => (
                  <View key={entry.id}>
                    {index > 0 ? (
                      <View style={[styles.divider, { backgroundColor: tokens.separator }]} />
                    ) : null}
                    <PressableScale
                      onPress={() => openRecent(entry)}
                      accessibilityLabel={`${entry.kind === "note" ? "笔记" : "速记"}：${entry.title}`}
                      accessibilityHint={entry.kind === "note" ? "打开笔记" : "打开收集箱"}
                      style={styles.recentPress}
                      contentStyle={styles.recentRow}
                    >
                      <IconTile
                        name={entry.kind === "note" ? "note" : "inbox"}
                        size={36}
                        iconSize={18}
                      />
                      <View style={styles.recentBody}>
                        <Text numberOfLines={1} style={[styles.recentTitle, { color: tokens.text }]}>
                          {entry.title}
                        </Text>
                        {entry.snippet ? (
                          <Text numberOfLines={1} style={[styles.recentSnippet, { color: tokens.muted }]}>
                            {entry.snippet}
                          </Text>
                        ) : null}
                      </View>
                      <Text style={[styles.recentTime, { color: tokens.muted }]}>
                        {formatRelative(entry.at, now)}
                      </Text>
                    </PressableScale>
                  </View>
                ))}
              </GlassCard>
            )}

            <SectionHeader icon="tools" title="快捷入口" />
            <GlassCard level="tertiary" style={styles.quickCard}>
              <View style={styles.quickGrid}>
                <IconEntry icon="add" label="新建任务" onPress={nav.openCreateTask} />
                <IconEntry
                  icon="inbox"
                  label="收集箱"
                  badge={inboxCount}
                  onPress={() => nav.push("inbox")}
                />
                <IconEntry icon="note" label="笔记" onPress={() => nav.push("notes")} />
                <IconEntry icon="transfer" label="文件互传" onPress={() => nav.push("files")} />
              </View>
            </GlassCard>

            <GlassCard style={styles.aiCard}>
              {/* 仅占位：无聊天窗口、无推荐、无发送按钮；横向紧凑行高度约 56dp */}
              <FeatureIconPlaceholder
                icon="sparkles"
                label="AI 助手"
                hint="移动端暂未接入"
                variant="inline"
              />
            </GlassCard>
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
    gap: space.lg,
  },
  welcome: {
    minHeight: 88,
    borderRadius: radius.card,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    overflow: "hidden",
  },
  welcomeText: { flex: 1, gap: 3 },
  greeting: { fontSize: font.page, fontWeight: "800", letterSpacing: -0.4, lineHeight: 30 },
  tagline: { fontSize: font.meta, lineHeight: 19 },
  loading: { marginTop: space.xl },
  errorCard: { padding: space.lg, gap: space.sm },
  errorTitle: { fontSize: font.title, fontWeight: "700" },
  errorHint: { fontSize: font.meta, lineHeight: 19 },
  retryPress: { alignSelf: "flex-start", marginTop: space.xs },
  retry: {
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: space.lg,
    borderRadius: radius.chip,
  },
  retryText: { fontSize: font.body, fontWeight: "700" },
  focusPress: {},
  focusCard: {
    padding: space.lg,
    gap: space.sm,
  },
  focusTop: { flexDirection: "row", alignItems: "center", gap: space.sm },
  focusLabel: { fontSize: font.label, fontWeight: "600" },
  focusCategory: { fontSize: font.label, flexShrink: 1, marginLeft: "auto" },
  focusTitle: { fontSize: 20, fontWeight: "700", lineHeight: 27, letterSpacing: -0.2 },
  metaRow: { flexDirection: "row", alignItems: "center", gap: space.xs, flexWrap: "wrap" },
  metaChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: space.sm,
    paddingVertical: 3,
    borderRadius: radius.chip,
  },
  metaText: { fontSize: font.label, fontWeight: "600" },
  focusFooter: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    marginTop: space.xxs,
    paddingTop: space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  focusHint: { flex: 1, fontSize: font.label, lineHeight: 17 },
  openLink: { flexDirection: "row", alignItems: "center", gap: 2 },
  openText: { fontSize: font.meta, fontWeight: "700" },
  emptyFocus: { alignItems: "flex-start", gap: space.sm },
  metricsCard: { paddingVertical: space.xs },
  metricsRow: { flexDirection: "row", alignItems: "stretch" },
  metricDivider: { width: StyleSheet.hairlineWidth, marginVertical: space.sm },
  emptyRecent: { padding: space.lg },
  emptyText: { fontSize: font.meta, lineHeight: 20 },
  recentCard: { paddingHorizontal: space.md, paddingVertical: space.xxs },
  divider: { height: StyleSheet.hairlineWidth, marginVertical: 2 },
  recentPress: {},
  recentRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm + 2,
    minHeight: 56,
    paddingVertical: space.xs,
  },
  recentBody: { flex: 1, gap: 1 },
  recentTitle: { fontSize: font.body, fontWeight: "600" },
  recentSnippet: { fontSize: font.label },
  recentTime: { fontSize: font.label, flexShrink: 0 },
  quickCard: { paddingHorizontal: space.xs, paddingVertical: space.xs },
  quickGrid: { flexDirection: "row", flexWrap: "wrap" },
  aiCard: { paddingHorizontal: space.md, paddingVertical: 0 },
});
