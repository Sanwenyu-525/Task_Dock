// 首页 / 工作台：问候 → 今日专注 → 效率概览 → 最近内容 → 快捷入口 → AI 占位。
// 所有数字来自手机本地库（tasks/notes/captures）；没有进度字段的任务不推算百分比。
//
// 第三轮精修口径：
// - 欢迎区只负责「打招呼」，高度 76–92dp，装饰图标轻量；
// - 今日专注是首屏视觉主体（任务标题 20sp），同一屏内不再重复「待完成/状态：未完成」；
// - 效率概览只回答「多少」，数字大于标签、不加装饰底板，避免抢过今日专注；
// - 最近内容最多三条，标题/摘要各一行，长文本不会把卡片撑高。
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
import { Glyph } from "../components/Glyph";
import { HeaderIconButton } from "../components/HeaderIconButton";
import { IconEntry } from "../components/IconEntry";
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
  const { width, fontScale } = useWindowDimensions();
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
  // 320dp 或大字号下三张磁贴改成两列两行，避免「已完成」被截断
  const wrapMetrics = width < 360 || fontScale > 1.15;
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
        {/* 欢迎区：76–92dp，只承担问候与一句话价值主张，不做占半屏的插画 */}
        <View style={[styles.welcome, { backgroundColor: tokens.accentWash }]}>
          <View style={styles.welcomeText}>
            <Text style={[styles.greeting, { color: tokens.text }]}>
              {homeGreeting(new Date(now).getHours())}
            </Text>
            <Text numberOfLines={2} style={[styles.tagline, { color: tokens.textSoft }]}>
              专注重要的事，高效推进每一个任务。
            </Text>
          </View>
          <View
            style={[
              styles.decoTile,
              { backgroundColor: tokens.card, borderColor: tokens.cardBorder },
            ]}
          >
            <Glyph name="code" color={tokens.accent} size={20} />
          </View>
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
            <SectionHeader icon="target" title="今日专注" />
            {focus ? (
              <PressableScale
                onPress={() => nav.openTab("tasks")}
                accessibilityLabel={`今日专注：${focus.title}`}
                accessibilityHint="打开任务页处理"
                style={styles.focusPress}
                contentStyle={[
                  styles.focusCard,
                  { backgroundColor: tokens.card, borderColor: tokens.cardBorder },
                ]}
              >
                <View style={styles.focusTop}>
                  <View style={[styles.focusIcon, { backgroundColor: tokens.accentSoft }]}>
                    <Glyph name="target" color={tokens.accent} size={16} />
                  </View>
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
                        <Glyph
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
                    <Glyph name="chevron" color={tokens.accentText} size={13} />
                  </View>
                </View>
              </PressableScale>
            ) : (
              <GlassCard style={styles.focusCard}>
                <View style={styles.emptyFocus}>
                  <View style={[styles.focusIcon, { backgroundColor: tokens.accentSoft }]}>
                    <Glyph name="target" color={tokens.accent} size={16} />
                  </View>
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
              icon="pulse"
              title="效率概览"
              actionLabel="查看详情"
              onAction={() => nav.openTab("tasks")}
            />
            <View style={[styles.metrics, wrapMetrics ? styles.metricWrap : null]}>
              <MetricTile
                value={counts.pending}
                label="待办任务"
                tone="accent"
                style={wrapMetrics ? styles.metricHalf : undefined}
              />
              <MetricTile
                value={counts.dueToday}
                label="今日到期"
                style={wrapMetrics ? styles.metricHalf : undefined}
              />
              <MetricTile
                value={counts.completed}
                label="已完成"
                tone="ok"
                style={wrapMetrics ? styles.metricHalf : undefined}
              />
            </View>

            <SectionHeader
              icon="doc"
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
                      <View style={[styles.recentIcon, { backgroundColor: tokens.accentWash }]}>
                        <Glyph
                          name={entry.kind === "note" ? "doc" : "inbox"}
                          color={tokens.accent}
                          size={17}
                        />
                      </View>
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

            <SectionHeader icon="grid" title="快捷入口" />
            <GlassCard style={styles.quickCard}>
              <View style={styles.quickGrid}>
                <IconEntry icon="plus" label="新建任务" onPress={nav.openCreateTask} />
                <IconEntry
                  icon="inbox"
                  label="收集箱"
                  badge={inboxCount}
                  onPress={() => nav.push("inbox")}
                />
                <IconEntry icon="doc" label="笔记" onPress={() => nav.push("notes")} />
                <IconEntry icon="transfer" label="文件互传" onPress={() => nav.push("files")} />
              </View>
            </GlassCard>

            <GlassCard style={styles.aiCard}>
              {/* 仅占位：无聊天窗口、无推荐、无发送按钮；横向紧凑行高度约 56dp */}
              <FeatureIconPlaceholder
                icon="sparkle"
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
    minHeight: 80,
    borderRadius: radius.card,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
  },
  welcomeText: { flex: 1, gap: 3 },
  greeting: { fontSize: font.page, fontWeight: "800", letterSpacing: -0.4, lineHeight: 30 },
  tagline: { fontSize: font.meta, lineHeight: 19 },
  decoTile: {
    width: 40,
    height: 40,
    borderRadius: radius.control,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
  },
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
    borderRadius: radius.card,
    borderWidth: StyleSheet.hairlineWidth,
    padding: space.lg,
    gap: space.sm,
  },
  focusTop: { flexDirection: "row", alignItems: "center", gap: space.sm },
  focusIcon: {
    width: 28,
    height: 28,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
  },
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
  metrics: { flexDirection: "row", gap: space.sm },
  metricWrap: { flexWrap: "wrap", rowGap: space.sm },
  metricHalf: { flexBasis: "47%" },
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
  recentIcon: {
    width: 34,
    height: 34,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  recentBody: { flex: 1, gap: 1 },
  recentTitle: { fontSize: font.body, fontWeight: "600" },
  recentSnippet: { fontSize: font.label },
  recentTime: { fontSize: font.label, flexShrink: 0 },
  quickCard: { paddingHorizontal: space.sm, paddingVertical: space.sm },
  quickGrid: { flexDirection: "row", flexWrap: "wrap" },
  aiCard: { paddingHorizontal: space.md, paddingVertical: 0 },
});
