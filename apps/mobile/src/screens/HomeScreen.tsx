// 首页 / 工作台（A 组重构）：品牌区 → 欢迎区 → 今日概览 → 当前进度 → 待处理任务 →
// 快捷入口 → 最近动态。
//
// 数据边界：所有数字来自本机 tasks / notes / captures / capture_assets 表；
// 移动端没有项目、看板、Agent、进度百分比字段，因此不显示「进行中项目」、
// 不推算任务进度，完成率只表达「已完成 / 全部任务」的真实比例。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";

import { BrandMark } from "../components/BrandMark";
import { EmptyState } from "../components/EmptyState";
import { GlassCard } from "../components/GlassCard";
import { HeaderIconButton } from "../components/HeaderIconButton";
import { IconTile } from "../components/IconTile";
import { AppIcon, type IconName } from "../components/icons/AppIcon";
import { MetricTile } from "../components/MetricTile";
import { PressableScale } from "../components/PressableScale";
import { ProgressBar } from "../components/ProgressBar";
import { SectionHeader } from "../components/SectionHeader";
import { useToast } from "../feedback/ToastProvider";
import { WorkbenchEntryGrid } from "../components/entry/WorkbenchEntryGrid";
import { listAssets } from "../db/captureAssets";
import { listCaptures } from "../db/captures";
import { listNotes } from "../db/notes";
import { listTasks } from "../db/tasks";
import {
  countTasks,
  formatDue,
  formatRelative,
  sortTasks,
} from "../domain/taskQuery";
import type { Capture, Note, Task } from "../domain/types";
import { homeGreeting } from "../domain/workspace";
import {
  commitEntryMove,
  commitEntryOrder,
  commitEntryVisibility,
  resetEntryLayout,
  useEntryLayout,
} from "../lib/entryLayoutStore";
import {
  entriesForIds,
  entryTargetOf,
  type EntryId,
  type MobileEntry,
} from "../lib/entryRegistry";
import { describeError } from "../lib/errors";
import type { AppNav } from "../lib/nav";
import { useTheme } from "../theme/ThemeProvider";
import { font, radius, space } from "../theme/tokens";

/** 卡片内只显示一字优先级标签，完整语义由任务页承担 */
const PRIORITY_SHORT: Record<number, string> = { 1: "低", 2: "中", 3: "高" };

type ActivityKind = "task" | "note" | "capture";

interface ActivityEntry {
  id: string;
  kind: ActivityKind;
  title: string;
  snippet: string;
  at: number;
}

const ACTIVITY_ICON: Record<ActivityKind, IconName> = {
  task: "tasks",
  note: "note",
  capture: "inbox",
};

export function HomeScreen({
  version,
  nav,
}: {
  version: number;
  nav: AppNav;
  /** 收集箱徽标计数：主归属在工作区，首页不再铺收集箱磁贴；保留入参契约不破坏 Shell 接线 */
  inboxCount?: number;
}) {
  const { tokens } = useTheme();
  const { width, fontScale } = useWindowDimensions();
  const narrow = width < 360;
  // ≤340dp（320dp 窄屏）概览磁贴改两行两列；只改布局比例，不整体缩小字号
  const statsTwoCol = width <= 340;
  // 320dp 或大字号时品牌块变窄/隐藏，长句改用同义短句，保证一行读完
  const brandSize = fontScale > 1.25 ? 0 : narrow ? 40 : 50;
  const tagline =
    narrow || fontScale > 1.25
      ? "专注重要的事，高效推进。"
      : "专注重要的事，高效推进每一个任务。";

  const [tasks, setTasks] = useState<Task[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [captures, setCaptures] = useState<Capture[]>([]);
  const [stashCount, setStashCount] = useState(0);
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
      const [nextTasks, nextNotes, nextCaptures, nextAssets] = await Promise.all([
        listTasks(),
        listNotes(),
        listCaptures(),
        listAssets("saved"),
      ]);
      if (!mounted.current || request !== requestSeq.current) return;
      setTasks(nextTasks);
      setNotes(nextNotes);
      setCaptures(nextCaptures);
      setStashCount(nextAssets.length);
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

  const counts = useMemo(() => countTasks(tasks, now), [tasks, now]);
  const completionRatio =
    counts.total > 0 ? Math.max(0, Math.min(1, counts.completed / counts.total)) : 0;
  const completionPercent = Math.round(completionRatio * 100);

  const pendingTop3 = useMemo(
    () => sortTasks(tasks.filter((task) => task.status === "pending")).slice(0, 3),
    [tasks],
  );

  /** 最近动态：任务 / 笔记 / 采集记录按更新时间合并，取前 5 条；不混入文件互传等其它实体 */
  const activity = useMemo<ActivityEntry[]>(() => {
    const taskEntries: ActivityEntry[] = tasks.map((task) => ({
      id: task.id,
      kind: "task",
      title: task.title.trim() || "未命名任务",
      snippet: task.description.trim().replace(/\s+/g, " ").slice(0, 60),
      at: task.updatedAt,
    }));
    const noteEntries: ActivityEntry[] = notes.map((note) => {
      const body = note.body.trim();
      return {
        id: note.id,
        kind: "note",
        title: note.title.trim() || body.split("\n")[0]?.slice(0, 24) || "无标题笔记",
        snippet: body.replace(/\s+/g, " ").slice(0, 60),
        at: note.updatedAt,
      };
    });
    const captureEntries: ActivityEntry[] = captures.map((capture) => ({
      id: capture.id,
      kind: "capture",
      title: capture.content.split("\n")[0]?.slice(0, 24) || "速记",
      snippet: capture.content.replace(/\s+/g, " ").slice(0, 60),
      at: capture.createdAt,
    }));
    return [...taskEntries, ...noteEntries, ...captureEntries]
      .sort((a, b) => b.at - a.at)
      .slice(0, 5);
  }, [tasks, notes, captures]);

  const openActivity = useCallback(
    (entry: ActivityEntry) => {
      if (entry.kind === "task") {
        nav.push("task_detail", undefined, undefined, entry.id);
        return;
      }
      if (entry.kind === "note") {
        nav.push("note_editor", entry.id);
        return;
      }
      nav.push("inbox");
    },
    [nav],
  );

  const openTaskDetail = useCallback(
    (task: Task) => nav.push("task_detail", undefined, undefined, task.id),
    [nav],
  );

  // —— 工作台入口（可自定义）——
  // 显示哪些入口、什么顺序全部来自 lib/entryLayoutStore（本机 kv 持久化）；
  // 页面不再自己维护入口数组，长按磁贴进入编辑态，「管理」进独立管理页。
  const layout = useEntryLayout();
  const visibleEntries = useMemo(
    () => entriesForIds(layout.config.visible),
    [layout.config.visible],
  );
  const [editingEntries, setEditingEntries] = useState(false);
  const [entryDragActive, setEntryDragActive] = useState(false);

  const { showToast: showEntryToast } = useToast();

  const openEntry = useCallback(
    (entry: MobileEntry) => {
      const launch = entryTargetOf(entry);
      if (!launch) return;
      if (launch.kind === "route") nav.push(launch.route);
      else if (launch.kind === "tab") nav.openTab(launch.tab);
      else nav.openCreateTask();
    },
    [nav],
  );

  const reorderEntries = useCallback(
    async (nextOrder: EntryId[]) => {
      try {
        await commitEntryOrder(nextOrder);
      } catch (error) {
        showEntryToast(`顺序未保存：${describeError(error)}`, "danger");
      }
    },
    [showEntryToast],
  );

  const removeEntry = useCallback(
    async (entry: MobileEntry) => {
      try {
        await commitEntryVisibility(entry.id as EntryId, false);
        showEntryToast(`已移除「${entry.label}」，仍可在全部功能里找回`);
        if (visibleEntries.length <= 1) setEditingEntries(false);
      } catch (error) {
        showEntryToast(`未保存：${describeError(error)}`, "danger");
      }
    },
    [showEntryToast, visibleEntries.length],
  );

  const moveEntry = useCallback(
    async (entry: MobileEntry, delta: number) => {
      try {
        await commitEntryMove(entry.id as EntryId, delta);
      } catch (error) {
        showEntryToast(`顺序未保存：${describeError(error)}`, "danger");
      }
    },
    [showEntryToast],
  );

  const restoreDefaultEntries = useCallback(async () => {
    try {
      await resetEntryLayout();
      showEntryToast("已恢复默认布局");
    } catch (error) {
      showEntryToast(`恢复失败：${describeError(error)}`, "danger");
    }
  }, [showEntryToast]);

  const badgeForEntry = useCallback(
    (id: string) => (id === "stash" ? stashCount : undefined),
    [stashCount],
  );

  return (
    <View style={styles.root}>
      {/* 品牌区：BrandMark + 名称 + 搜索 + 通知铃铛 */}
      <View style={styles.header}>
        <BrandMark size={36} />
        <View style={styles.headerTitle}>
          <Text numberOfLines={1} style={[styles.headerTitleText, { color: tokens.text }]}>
            工作台
          </Text>
          <Text numberOfLines={1} style={[styles.headerSub, { color: tokens.muted }]}>
            任务 · 采集 · 笔记
          </Text>
        </View>
        <HeaderIconButton
          icon="search"
          accessibilityLabel="搜索任务"
          onPress={() => nav.openTab("tasks")}
        />
        <HeaderIconButton
          icon="bell"
          accessibilityLabel="通知"
          onPress={() => nav.push("notifications")}
        />
      </View>

      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        // 编辑态拖拽磁贴时先关掉页面滚动，避免手势与滚动争抢
        scrollEnabled={!entryDragActive}
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
            {/* 今日概览：待处理 / 今日到期 / 已完成 / 完成率，全部来自 tasks 表真实计数 */}
            <View style={styles.section}>
              <SectionHeader icon="stats" title="今日概览" />
              <View style={styles.statsRow}>
                <View style={[styles.statCell, statsTwoCol ? styles.statCellHalf : null]}>
                  <MetricTile
                    variant="stat"
                    icon="pending"
                    value={counts.pending}
                    label="待处理任务"
                    tone="accent"
                  />
                </View>
                <View style={[styles.statCell, statsTwoCol ? styles.statCellHalf : null]}>
                  <MetricTile
                    variant="stat"
                    icon="calendar"
                    value={counts.dueToday}
                    label="今日到期"
                    tone="alt"
                  />
                </View>
                <View style={[styles.statCell, statsTwoCol ? styles.statCellHalf : null]}>
                  <MetricTile
                    variant="stat"
                    icon="success"
                    value={counts.completed}
                    label="已完成"
                    tone="ok"
                  />
                </View>
                <View style={[styles.statCell, statsTwoCol ? styles.statCellHalf : null]}>
                  <MetricTile
                    variant="stat"
                    icon="stats"
                    value={completionPercent}
                    label="完成率"
                    tone="neutral"
                  />
                </View>
              </View>
            </View>

            {/* 当前进度：真实完成率进度条；整卡进任务页，不进入任何项目空间 */}
            <PressableScale
              onPress={() => nav.openTab("tasks")}
              accessibilityLabel={`今日任务完成度 ${completionPercent}%，查看全部任务`}
              accessibilityHint="打开任务页"
              style={styles.progressPress}
              contentStyle={styles.progressCard}
            >
              <View style={styles.progressHeader}>
                <AppIcon name="stats" color={tokens.accent} size={20} />
                <Text style={[styles.progressTitle, { color: tokens.text }]}>当前进度</Text>
                <View style={styles.progressAction}>
                  <Text style={[styles.progressActionText, { color: tokens.accentText }]}>
                    查看全部
                  </Text>
                  <AppIcon name="chevronRight" color={tokens.accent} size={14} />
                </View>
              </View>
              <ProgressBar value={completionRatio} label={`${completionPercent}%`} />
              <Text style={[styles.progressHint, { color: tokens.muted }]}>
                今日任务完成度 · 共 {counts.total} 项，已完成 {counts.completed} 项
              </Text>
            </PressableScale>

            {/* 待处理任务：前 3 条真实未完成任务，轻点进详情；右侧查看全部回任务页 */}
            <View style={styles.section}>
              <SectionHeader
                icon="tasks"
                title={counts.pending > 0 ? `待处理任务 · ${counts.pending}` : "待处理任务"}
                actionLabel="查看全部"
                onAction={() => nav.openTab("tasks")}
              />
              {pendingTop3.length === 0 ? (
                <Text style={[styles.emptyText, { color: tokens.muted }]}>
                  手上的事都处理完了，先歇一会儿。
                </Text>
              ) : (
                <GlassCard style={styles.listCard}>
                  {pendingTop3.map((task, index) => {
                    const overdue = task.dueAt != null && task.dueAt < now;
                    const due = formatDue(task.dueAt, now);
                    return (
                      <View key={task.id}>
                        {index > 0 ? (
                          <View style={[styles.divider, { backgroundColor: tokens.separator }]} />
                        ) : null}
                        <PressableScale
                          onPress={() => openTaskDetail(task)}
                          accessibilityLabel={`任务：${task.title}`}
                          accessibilityHint="轻点查看任务详情"
                          style={styles.pendingPress}
                          contentStyle={styles.pendingRow}
                        >
                          <View style={styles.pendingMain}>
                            <Text
                              numberOfLines={2}
                              style={[styles.pendingTitle, { color: tokens.text }]}
                            >
                              {task.title}
                            </Text>
                            <View style={styles.metaRow}>
                              {task.priority > 0 ? (
                                <View
                                  style={[
                                    styles.metaChip,
                                    {
                                      backgroundColor:
                                        task.priority >= 3 ? tokens.dangerSoft : tokens.warnSoft,
                                    },
                                  ]}
                                >
                                  <Text
                                    style={[
                                      styles.metaText,
                                      {
                                        color:
                                          task.priority >= 3 ? tokens.danger : tokens.warn,
                                      },
                                    ]}
                                  >
                                    {PRIORITY_SHORT[task.priority]}
                                  </Text>
                                </View>
                              ) : null}
                              {task.category ? (
                                <View
                                  style={[
                                    styles.metaChip,
                                    { backgroundColor: tokens.accentSoft },
                                  ]}
                                >
                                  <Text
                                    numberOfLines={1}
                                    style={[styles.metaText, { color: tokens.accentText }]}
                                  >
                                    {task.category}
                                  </Text>
                                </View>
                              ) : null}
                              {due ? (
                                <View
                                  style={[
                                    styles.metaChip,
                                    {
                                      backgroundColor: overdue
                                        ? tokens.warnSoft
                                        : tokens.accentSoft,
                                    },
                                  ]}
                                >
                                  <AppIcon
                                    name="clock"
                                    color={overdue ? tokens.warn : tokens.accentText}
                                    size={12}
                                  />
                                  <Text
                                    style={[
                                      styles.metaText,
                                      { color: overdue ? tokens.warn : tokens.accentText },
                                    ]}
                                  >
                                    {due}
                                  </Text>
                                </View>
                              ) : null}
                            </View>
                          </View>
                          <AppIcon name="chevronRight" color={tokens.faint} size={16} />
                        </PressableScale>
                      </View>
                    );
                  })}
                </GlassCard>
              )}
            </View>

            {/* 快捷入口：入口与顺序由用户配置决定；长按磁贴或点「管理」进入编辑/管理 */}
            <View style={styles.section}>
              <SectionHeader
                icon="tools"
                title={editingEntries ? "快捷入口 · 编辑中" : "快捷入口"}
                actionLabel={editingEntries ? "完成" : "管理"}
                onAction={
                  editingEntries
                    ? () => setEditingEntries(false)
                    : () => nav.push("entry_manager")
                }
              />
              {editingEntries ? (
                <Text style={[styles.entryHint, { color: tokens.muted }]}>
                  拖动磁贴调整顺序，点 × 移除；点磁贴可用上移 / 下移 / 移除。改完点右上「完成」。
                </Text>
              ) : null}
              {visibleEntries.length === 0 ? (
                <GlassCard style={styles.entryEmptyCard}>
                  <EmptyState
                    icon="tools"
                    title="工作台还没有入口"
                    hint="功能都还在：从「全部功能」里挑几个常用的加回来，或者恢复默认布局。"
                  />
                  <View style={styles.entryEmptyActions}>
                    <PressableScale
                      onPress={() => nav.push("all_features")}
                      accessibilityLabel="打开全部功能"
                      style={styles.entryEmptyActionPress}
                      contentStyle={[
                        styles.entryEmptyPrimary,
                        { backgroundColor: tokens.accentFill },
                      ]}
                      scaleTo={0.97}
                    >
                      <Text style={[styles.entryEmptyPrimaryLabel, { color: tokens.onAccent }]}>
                        全部功能
                      </Text>
                    </PressableScale>
                    <PressableScale
                      onPress={() => void restoreDefaultEntries()}
                      accessibilityLabel="恢复默认布局"
                      style={styles.entryEmptyActionPress}
                      contentStyle={[
                        styles.entryEmptySecondary,
                        { backgroundColor: tokens.card, borderColor: tokens.cardBorder },
                      ]}
                      scaleTo={0.97}
                    >
                      <Text
                        style={[styles.entryEmptySecondaryLabel, { color: tokens.accentText }]}
                      >
                        恢复默认
                      </Text>
                    </PressableScale>
                  </View>
                </GlassCard>
              ) : (
                <WorkbenchEntryGrid
                  entries={visibleEntries}
                  editing={editingEntries}
                  columns={narrow ? 2 : 4}
                  contentWidth={width - space.lg * 2}
                  badgeFor={badgeForEntry}
                  onOpen={openEntry}
                  onLongPress={() => setEditingEntries(true)}
                  onReorder={(nextOrder) => void reorderEntries(nextOrder)}
                  onRemove={(entry) => void removeEntry(entry)}
                  onMove={(entry, delta) => void moveEntry(entry, delta)}
                  onDragActiveChange={setEntryDragActive}
                />
              )}
            </View>

            {/* 最近动态：任务 / 笔记 / 采集合并的真实时间线，纯列表行 */}
            <View style={styles.section}>
              <SectionHeader icon="activity" title="最近动态" />
              {activity.length === 0 ? (
                <Text style={[styles.emptyText, { color: tokens.muted }]}>
                  还没有任务、笔记或速记；写下第一条后，这里会显示最近更新的内容。
                </Text>
              ) : (
                <View style={styles.activityList}>
                  {activity.map((entry, index) => (
                    <View key={`${entry.kind}-${entry.id}`}>
                      {index > 0 ? (
                        <View style={[styles.divider, { backgroundColor: tokens.separator }]} />
                      ) : null}
                      <PressableScale
                        onPress={() => openActivity(entry)}
                        accessibilityLabel={`${entry.kind === "task" ? "任务" : entry.kind === "note" ? "笔记" : "速记"}：${entry.title}`}
                        style={styles.activityPress}
                        contentStyle={styles.activityRow}
                      >
                        <IconTile name={ACTIVITY_ICON[entry.kind]} size={36} />
                        <View style={styles.activityBody}>
                          <Text numberOfLines={1} style={[styles.activityTitle, { color: tokens.text }]}>
                            {entry.title}
                          </Text>
                          {entry.snippet ? (
                            <Text numberOfLines={1} style={[styles.activitySnippet, { color: tokens.muted }]}>
                              {entry.snippet}
                            </Text>
                          ) : null}
                        </View>
                        <Text style={[styles.activityTime, { color: tokens.muted }]}>
                          {formatRelative(entry.at, now)}
                        </Text>
                      </PressableScale>
                    </View>
                  ))}
                </View>
              )}
            </View>
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    minHeight: 56,
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingHorizontal: space.lg,
  },
  headerTitle: { flex: 1, gap: 1 },
  headerTitleText: {
    fontSize: font.page,
    fontWeight: "800",
    letterSpacing: -0.4,
    lineHeight: font.page + 6,
  },
  headerSub: { fontSize: font.meta, lineHeight: 16 },
  content: {
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
    paddingBottom: space.xxl,
    gap: space.lg,
  },
  section: { gap: space.md },
  hero: {
    // 通栏：抵消页面左右内边距，让浅蓝渐变贴住屏幕两侧
    marginHorizontal: -space.lg,
    paddingHorizontal: space.lg,
    paddingVertical: space.lg - 2,
    minHeight: 118,
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
    borderRadius: radius.chip,
    opacity: 0.7,
  },
  heroOrbSmall: {
    position: "absolute",
    right: 104,
    bottom: -48,
    width: 108,
    height: 108,
    borderRadius: radius.chip,
  },
  heroText: { flex: 1, gap: 6 },
  greeting: {
    fontSize: font.hero,
    fontWeight: "800",
    letterSpacing: -0.6,
    lineHeight: font.hero + 8,
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
  statsRow: { flexDirection: "row", flexWrap: "wrap", gap: space.sm, alignItems: "stretch" },
  statCell: { flexGrow: 0, flexShrink: 1, flexBasis: "25%" },
  statCellHalf: { flexBasis: "50%" },
  progressPress: {},
  progressCard: {
    padding: space.lg,
    gap: space.sm + 2,
  },
  progressHeader: { flexDirection: "row", alignItems: "center", gap: space.sm },
  progressTitle: { fontSize: font.section, fontWeight: "700", letterSpacing: -0.2 },
  progressAction: {
    marginLeft: "auto",
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
  },
  progressActionText: { fontSize: font.meta, fontWeight: "600" },
  progressHint: { fontSize: font.label, lineHeight: 17 },
  listCard: { paddingHorizontal: space.md, paddingVertical: space.xxs },
  pendingPress: {},
  pendingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    minHeight: 58,
    paddingVertical: space.sm + 2,
  },
  pendingMain: { flex: 1, gap: 3 },
  pendingTitle: { fontSize: font.title, fontWeight: "600", lineHeight: 22 },
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
  emptyText: { fontSize: font.meta, lineHeight: 20, paddingVertical: space.xs },
  entryHint: { fontSize: font.label, lineHeight: 16 },
  entryEmptyCard: { paddingVertical: space.xs },
  entryEmptyActions: {
    flexDirection: "row",
    justifyContent: "center",
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingBottom: space.md,
  },
  entryEmptyActionPress: { flexGrow: 0 },
  entryEmptyPrimary: {
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: space.lg,
    borderRadius: 999,
  },
  entryEmptyPrimaryLabel: { fontSize: font.body, fontWeight: "600" },
  entryEmptySecondary: {
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: space.lg,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
  },
  entryEmptySecondaryLabel: { fontSize: font.body, fontWeight: "600" },
  activityList: {},
  divider: { height: StyleSheet.hairlineWidth },
  activityPress: {},
  activityRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    minHeight: 58,
    paddingVertical: space.sm + 2,
  },
  activityBody: { flex: 1, gap: 2 },
  activityTitle: { fontSize: font.body, fontWeight: "600" },
  activitySnippet: { fontSize: font.label },
  activityTime: { fontSize: font.label, flexShrink: 0 },
});
