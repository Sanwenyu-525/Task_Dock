// 首页 / 工作台（第七轮布局）：欢迎区 → 今日专注 → 三张独立统计磁贴 →
// 无卡片的最近内容列表 → 浅蓝快捷磁贴 → AI 占位说明。
// 所有数字来自手机本地库（tasks/notes/captures）；没有进度字段的任务不推算百分比。
//
// 与参考图对齐的关键结构：
// - 欢迎区不再是一张白卡，而是通栏浅蓝渐变 + 右侧品牌块；
// - 今日专注把「模块标题」收进卡片内部，避免标题与卡内「当前专注」重复；
// - 效率概览从一张卡三段改成三张独立磁贴；
// - 最近内容不再套白色大卡，列表行直接落在页面底上；
// - 快捷入口改成四张浅蓝磁贴，不再是一整块浅蓝容器。
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";

import { BrandMark } from "../components/BrandMark";
import { GlassCard } from "../components/GlassCard";
import { HeaderIconButton } from "../components/HeaderIconButton";
import { IconTile } from "../components/IconTile";
import { AppIcon } from "../components/icons/AppIcon";
import { MetricTile } from "../components/MetricTile";
import { PressableScale } from "../components/PressableScale";
import { QuickTile } from "../components/QuickTile";
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

/** 卡片内只显示一字标签，完整程度由任务页承担；避免把注意力从任务标题上拉走 */
const PRIORITY_SHORT: Record<number, string> = { 1: "低", 2: "中", 3: "高" };

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
  // 窄屏保留一枚品牌块（右侧不再发空）；大字号时彻底隐藏，把宽度让给问候语。
  const { width, fontScale } = useWindowDimensions();
  const narrowWelcome = width < 360;
  const brandSize = fontScale > 1.25 ? 0 : narrowWelcome ? 40 : 50;
  // 320dp 或 130% 以上字号时品牌块会隐藏/变窄，长句在部分系统字体上会孤字换行；
  // 这两种情况都用同义短句，保证一行读完。
  const shortTagline = narrowWelcome || fontScale > 1.25;
  const tagline = shortTagline
    ? "专注重要的事，高效推进。"
    : "专注重要的事，高效推进每一个任务。";
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
        {/* 欢迎区：通栏蓝青渐变 + 品牌块，只承担问候与一句话价值主张 */}
        <View
          style={[
            styles.hero,
            {
              backgroundImage: `linear-gradient(118deg, ${tokens.card} 0%, ${tokens.accentWash} 52%, ${tokens.accentWashAlt} 100%)`,
            },
          ]}
        >
          <View
            pointerEvents="none"
            style={[styles.heroOrbLarge, { backgroundColor: tokens.accentWashAlt }]}
          />
          <View
            pointerEvents="none"
            style={[styles.heroOrbSmall, { backgroundColor: tokens.accentSoft }]}
          />
          <View style={styles.heroText}>
            <Text numberOfLines={2} style={[styles.greeting, { color: tokens.text }]}>
              {homeGreeting(new Date(now).getHours())}
            </Text>
            <Text numberOfLines={2} style={[styles.tagline, { color: tokens.textSoft }]}>
              {tagline}
            </Text>
          </View>
          {brandSize > 0 ? (
            <View style={styles.heroBrand}>
              <BrandMark size={brandSize} />
            </View>
          ) : null}
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
            {/* 今日专注：模块标题收进卡片，任务标题是整页第一视觉焦点 */}
            {focus ? (
              <PressableScale
                onPress={() => nav.openTab("tasks")}
                accessibilityLabel={`今日专注：${focus.title}`}
                accessibilityHint="打开任务页处理"
                style={styles.focusPress}
              >
                <GlassCard level="primary" style={styles.focusCard}>
                  <View style={styles.focusHeader}>
                    <AppIcon name="focus" color={tokens.accent} size={20} />
                    <Text style={[styles.focusKicker, { color: tokens.text }]}>今日专注</Text>
                    <View style={[styles.focusStatus, { backgroundColor: tokens.accentSoft }]}>
                      <View style={[styles.statusDot, { backgroundColor: tokens.accent }]} />
                      <Text style={[styles.focusStatusText, { color: tokens.accentText }]}>
                        待处理
                      </Text>
                    </View>
                  </View>

                  <View style={styles.focusMain}>
                    <View style={styles.focusBody}>
                      <Text numberOfLines={2} style={[styles.focusTitle, { color: tokens.text }]}>
                        {focus.title}
                      </Text>

                      {focus.priority > 0 || focus.dueAt != null || focus.category ? (
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
                                  {
                                    color:
                                      focus.priority >= 3 ? tokens.danger : tokens.warn,
                                  },
                                ]}
                              >
                                {PRIORITY_SHORT[focus.priority]}
                              </Text>
                            </View>
                          ) : null}
                          {focus.category ? (
                            <View style={[styles.metaChip, { backgroundColor: tokens.accentSoft }]}>
                              <AppIcon name="tag" color={tokens.accentText} size={12} />
                              <Text
                                numberOfLines={1}
                                style={[styles.metaText, { color: tokens.accentText }]}
                              >
                                {focus.category}
                              </Text>
                            </View>
                          ) : null}
                          {focus.dueAt != null ? (
                            <View
                              style={[
                                styles.metaChip,
                                {
                                  backgroundColor: overdueFocus
                                    ? tokens.warnSoft
                                    : tokens.accentSoft,
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
                    </View>

                    <View style={[styles.focusAction, { backgroundColor: tokens.accentFill }]}>
                      <AppIcon name="chevronRight" color={tokens.onAccent} size={20} />
                    </View>
                  </View>

                  <View style={[styles.focusFooter, { borderTopColor: tokens.separator }]}>
                    <Text numberOfLines={1} style={[styles.focusHint, { color: tokens.muted }]}>
                      任务页可查看全部待办 · {counts.pending} 项
                    </Text>
                    <Text style={[styles.focusLink, { color: tokens.accentText }]}>去处理</Text>
                  </View>
                </GlassCard>
              </PressableScale>
            ) : (
              <GlassCard level="primary" style={styles.focusCard}>
                <View style={styles.focusHeader}>
                  <AppIcon name="focus" color={tokens.accent} size={20} />
                  <Text style={[styles.focusKicker, { color: tokens.text }]}>今日专注</Text>
                </View>
                <View style={styles.emptyFocus}>
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
            {/* 三张独立磁贴：等高、等间距，图标只做语义提示，不使用大面积鲜艳背景 */}
            <View style={styles.statsRow}>
              <MetricTile
                variant="stat"
                icon="pending"
                value={counts.pending}
                label="待办任务"
                tone="accent"
              />
              <MetricTile
                variant="stat"
                icon="calendar"
                value={counts.dueToday}
                label="今日到期"
                tone="alt"
              />
              <MetricTile
                variant="stat"
                icon="success"
                value={counts.completed}
                label="已完成"
                tone="ok"
              />
            </View>

            <SectionHeader
              icon="note"
              title="最近内容"
              actionLabel="更多"
              onAction={() => nav.push("notes")}
            />
            {recent.length === 0 ? (
              <Text style={[styles.emptyText, { color: tokens.muted }]}>
                还没有笔记或速记。写下第一条后，这里会显示最近更新的内容。
              </Text>
            ) : (
              <View style={styles.recentList}>
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
                          <Text
                            numberOfLines={1}
                            style={[styles.recentSnippet, { color: tokens.muted }]}
                          >
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
                <View style={[styles.listEnd, { backgroundColor: tokens.separator }]} />
              </View>
            )}

            <SectionHeader icon="tools" title="快捷入口" />
            <View style={styles.quickRow}>
              <QuickTile icon="add" label="新建任务" onPress={nav.openCreateTask} />
              <QuickTile
                icon="inbox"
                label="收集箱"
                badge={inboxCount}
                onPress={() => nav.push("inbox")}
              />
              <QuickTile icon="note" label="笔记" onPress={() => nav.push("notes")} />
              <QuickTile icon="transfer" label="文件互传" onPress={() => nav.push("files")} />
            </View>

            {/* AI 助手仍只有说明，不渲染输入框/推荐/发送按钮 */}
            <View
              accessible
              accessibilityLabel="AI 助手，移动端暂未接入"
              accessibilityState={{ disabled: true }}
              style={styles.aiNote}
            >
              <AppIcon name="sparkles" color={tokens.faint} size={16} />
              <Text style={[styles.aiText, { color: tokens.muted }]}>
                AI 助手 · 移动端暂未接入
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
    gap: space.lg + 2,
  },
  hero: {
    // 通栏：抵消页面左右内边距，让浅蓝渐变贴住屏幕两侧
    marginHorizontal: -space.lg,
    paddingHorizontal: space.lg,
    paddingVertical: space.lg,
    minHeight: 124,
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    overflow: "hidden",
  },
  heroOrbLarge: {
    position: "absolute",
    right: -44,
    top: -64,
    width: 190,
    height: 190,
    borderRadius: 95,
    opacity: 0.7,
  },
  heroOrbSmall: {
    position: "absolute",
    right: 104,
    bottom: -48,
    width: 108,
    height: 108,
    borderRadius: 54,
  },
  heroText: { flex: 1, gap: 6 },
  greeting: {
    fontSize: font.hero,
    fontWeight: "800",
    letterSpacing: -0.6,
    lineHeight: 34,
  },
  tagline: { fontSize: font.meta, lineHeight: 19 },
  heroBrand: { alignSelf: "center" },
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
    gap: space.md,
  },
  focusHeader: { flexDirection: "row", alignItems: "center", gap: space.sm },
  focusKicker: { fontSize: font.section - 1, fontWeight: "700", letterSpacing: -0.2 },
  focusStatus: {
    marginLeft: "auto",
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: space.sm,
    paddingVertical: 3,
    borderRadius: radius.chip,
  },
  statusDot: { width: 5, height: 5, borderRadius: 3 },
  focusStatusText: { fontSize: font.label, fontWeight: "700" },
  focusMain: { flexDirection: "row", alignItems: "center", gap: space.md },
  focusBody: { flex: 1, gap: space.sm },
  focusTitle: { fontSize: 21, fontWeight: "700", lineHeight: 29, letterSpacing: -0.2 },
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
  focusAction: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  focusFooter: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingTop: space.sm + 2,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  focusHint: { flexShrink: 1, fontSize: font.label, lineHeight: 17 },
  focusLink: { marginLeft: "auto", fontSize: font.label, fontWeight: "700" },
  emptyFocus: { alignItems: "flex-start", gap: space.sm },
  statsRow: { flexDirection: "row", gap: space.sm, alignItems: "stretch" },
  emptyText: { fontSize: font.meta, lineHeight: 20, paddingVertical: space.xs },
  recentList: {},
  divider: { height: StyleSheet.hairlineWidth },
  listEnd: { height: StyleSheet.hairlineWidth },
  recentPress: {},
  recentRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    minHeight: 58,
    paddingVertical: space.sm + 2,
  },
  recentBody: { flex: 1, gap: 2 },
  recentTitle: { fontSize: font.body, fontWeight: "600" },
  recentSnippet: { fontSize: font.label },
  recentTime: { fontSize: font.label, flexShrink: 0 },
  quickRow: { flexDirection: "row", gap: space.sm },
  aiNote: {
    minHeight: 24,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 2,
  },
  aiText: { fontSize: font.label },
});
