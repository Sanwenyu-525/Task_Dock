// 任务页：统计 → 筛选 → 分组列表（同一 FlatList 内用分组头切分，不做嵌套列表）。
// 交互约定：勾选完成/恢复、轻点行主体打开编辑、长按动作表、向左滑动删除；编辑与新建共用 TaskEditorSheet。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  LayoutAnimation,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type ListRenderItemInfo,
} from "react-native";

import { ActionSheet, type SheetAction } from "../components/ActionSheet";
import { Chip } from "../components/Chip";
import { EmptyState } from "../components/EmptyState";
import { HeaderIconButton } from "../components/HeaderIconButton";
import { SearchField } from "../components/SearchField";
import { ScreenHeader } from "../components/ScreenHeader";
import { TaskEditorSheet } from "../components/TaskEditorSheet";
import { TaskGroupHeader } from "../components/TaskGroupHeader";
import { TaskRow } from "../components/TaskRow";
import {
  Toast,
  type ToastMessage,
  type ToastPlacement,
  type ToastTone,
} from "../components/Toast";
import { getSetting } from "../db/kv";
import { createTask, deleteTask, listTasks, toggleTask, updateTask } from "../db/tasks";
import { countTasks, formatDue, matchesQuery, selectTasks } from "../domain/taskQuery";
import { describeRecurrence, parseRecurrence } from "../domain/recurrence";
import type { NewTaskInput, Task, TaskFilter } from "../domain/types";
import { describeError } from "../lib/errors";
import { shouldConsumeCreateSignal } from "../lib/nav";
import { notifyWidgetDataChanged } from "../lib/widgetSnapshot";
import { rescheduleAllReminders, SNOOZE_SETTING_KEY } from "../notifications/reminderEngine";
import { cancelReminder, scheduleReminder } from "../notifications/reminders";
import { useReduceMotion } from "../theme/MotionProvider";
import { useTheme } from "../theme/ThemeProvider";
import { font, radius, space } from "../theme/tokens";

import { buildTaskSections, flattenSections, type SectionKey, type TaskListRow } from "./taskGroups";

const FILTERS: { key: TaskFilter; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "pending", label: "未完成" },
  { key: "today", label: "今天" },
  { key: "overdue", label: "逾期" },
  { key: "completed", label: "已完成" },
];

const EMPTY_COPY: Record<TaskFilter, { title: string; hint: string }> = {
  all: { title: "还没有任务", hint: "点右上角 + 记下第一件事；还没想清楚的先丢进收集箱" },
  pending: { title: "没有待办任务", hint: "手上的事都处理完了，先歇一会儿" },
  today: { title: "今天没有到期任务", hint: "没有卡在今天的事，可以推进别的工作" },
  overdue: { title: "没有逾期任务", hint: "保持这个节奏，别让截止日期追上来" },
  completed: { title: "还没有完成的任务", hint: "完成第一件后，这里会慢慢累积你的记录" },
};

/** 统一的列表分隔：模块级组件，避免每次渲染都产生新的组件类型导致整表重挂载 */
function RowSeparator() {
  return <View style={styles.rowGap} />;
}

/** 动作表副标题：截止时间 + 重复规则，避免用户在动作表里看不出这是循环任务 */
function actionSubtitle(task: Task, now: number): string {
  const due = formatDue(task.dueAt, now) ?? "无截止时间";
  const rule = parseRecurrence(task.recurrenceRule);
  return rule ? `${due} · ${describeRecurrence(rule)}` : due;
}

/** 页头副标题：今天 + 月日 + 星期，仅展示日期用途，不再是每秒跳动的时钟。 */
function formatDayLabel(now: number): string {
  const date = new Date(now);
  const weekday = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][date.getDay()];
  return `今天 ${date.getMonth() + 1}月${date.getDate()}日 ${weekday}`;
}

export function TasksScreen({
  version = 0,
  openCreateSignal = 0,
  onConsumeCreateSignal,
}: {
  version?: number;
  /** 首页/工作区快捷入口发出的「打开新建」信号；0 = 无信号 */
  openCreateSignal?: number;
  /** 消费后由 Shell 立刻归零，避免页面卸载重挂时再次打开弹层 */
  onConsumeCreateSignal?: () => void;
}) {
  const { tokens } = useTheme();
  const reduceMotion = useReduceMotion();
  // 大字号/320dp 下四个统计项并排会截断：改为两列两行
  const { width, fontScale } = useWindowDimensions();
  const twoColumnStats = fontScale > 1.15 || width < 360;
  // Android 的 font_scale 以 float32 传到 RN，1.3 实际是 1.29999995，不能用 >= 1.3
  const largeFont = fontScale > 1.25;

  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<TaskFilter>("all");
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  /** 折叠的分组：只影响展示，计数与分组头始终保留 */
  const [collapsed, setCollapsed] = useState<ReadonlySet<SectionKey>>(() => new Set());

  const [editorState, setEditorState] = useState<{ mode: "create" } | { mode: "edit"; task: Task }>(
    { mode: "create" },
  );
  const [editorOpen, setEditorOpen] = useState(false);
  const [actionTask, setActionTask] = useState<Task | null>(null);
  const [actionOpen, setActionOpen] = useState(false);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const toastSeq = useRef(0);
  const refreshSeq = useRef(0);
  const mounted = useRef(true);

  const showToast = useCallback(
    (text: string, tone: ToastTone = "info", placement?: ToastPlacement) => {
      toastSeq.current += 1;
      setToast({ id: toastSeq.current, text, tone, placement });
    },
    [],
  );
  const dismissToast = useCallback(() => setToast(null), []);

  const animateLayout = useCallback(() => {
    if (reduceMotion) return;
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
  }, [reduceMotion]);

  const toggleSection = useCallback(
    (key: SectionKey) => {
      // 折叠是列表结构变化，用布局动画补上高度过渡；减少动态效果时直接切
      animateLayout();
      setCollapsed((previous) => {
        const next = new Set(previous);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
    },
    [animateLayout],
  );

  const refresh = useCallback(
    async (animated = false) => {
      const request = ++refreshSeq.current;
      try {
        const next = await listTasks();
        // 过期请求（连续操作/快速切页）不能覆盖最新列表
        if (!mounted.current || request !== refreshSeq.current) return;
        // 配置必须紧贴数据提交：提前调用会被其它状态更新消费掉
        if (animated) animateLayout();
        setTasks(next);
      } catch (error) {
        if (!mounted.current || request !== refreshSeq.current) return;
        showToast(`读取任务失败：${describeError(error)}`, "danger");
      } finally {
        if (!mounted.current || request !== refreshSeq.current) return;
        setNow(Date.now());
        setLoading(false);
      }
    },
    [animateLayout, showToast],
  );

  // version 变化代表外部数据可能已变（收集箱转入、前台恢复）
  useEffect(() => {
    void refresh();
  }, [refresh, version]);

  // 卸载时让在途请求失效，避免异步结果写已卸载组件
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      refreshSeq.current += 1;
    };
  }, []);

  // 跨过零点 / 提醒到点后，「今天」「已过期」要跟着变，不能让列表停留在旧判定
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const visible = useMemo(
    () => selectTasks(tasks.filter((task) => matchesQuery(task, query)), filter, now),
    [tasks, filter, now, query],
  );
  const counts = useMemo(() => countTasks(tasks, now), [tasks, now]);
  const rows = useMemo(
    () => flattenSections(buildTaskSections(visible, now), collapsed),
    [collapsed, visible, now],
  );

  const handleToggle = useCallback(
    async (task: Task, placement: ToastPlacement = "top") => {
      try {
        const outcome = await toggleTask(task.id);
        if (outcome.advanced) {
          // 期次推进后提醒时间变了：重建排期（引擎按 (task_id, occurrence) 幂等）
          await rescheduleAllReminders();
          const next = formatDue(outcome.advanced.toDueAt, Date.now());
          showToast(next ? `已完成本期，下次 ${next}` : "已完成本期", "success", placement);
        } else if (outcome.task) {
          if (outcome.task.status === "completed") await cancelReminder(task.id);
          else if (outcome.task.remindAt != null && outcome.task.remindAt > Date.now()) {
            const snooze = (await getSetting(SNOOZE_SETTING_KEY)) !== "0";
            await scheduleReminder(task.id, outcome.task.title, outcome.task.remindAt, snooze);
          }
        }
      } catch (error) {
        showToast(`操作失败：${describeError(error)}`, "danger", placement);
      }
      // 任务数据变了：小组件快照随后台去抖刷新（内部去重，连续操作只推一次）
      notifyWidgetDataChanged();
      await refresh(true);
    },
    [refresh, showToast],
  );

  const handleDelete = useCallback(
    async (task: Task, placement: ToastPlacement = "top") => {
      try {
        await deleteTask(task.id);
        await cancelReminder(task.id);
        showToast("任务已删除", "info", placement);
      } catch (error) {
        showToast(`删除失败：${describeError(error)}`, "danger", placement);
      }
      // 任务数据变了：小组件快照随后台去抖刷新（内部去重，连续操作只推一次）
      notifyWidgetDataChanged();
      await refresh(true);
    },
    [refresh, showToast],
  );

  const handleOpenActions = useCallback((task: Task) => {
    setActionTask(task);
    setActionOpen(true);
  }, []);

  const handleCreate = useCallback(
    async (input: NewTaskInput) => {
      try {
        const task = await createTask(input);
        if (input.remindAt != null) {
          const snooze = (await getSetting(SNOOZE_SETTING_KEY)) !== "0";
          const scheduled = await scheduleReminder(task.id, task.title, input.remindAt, snooze);
          if (!scheduled) {
            showToast("提醒未排期：系统通知权限未开启，任务已保存", "warn", "bottom");
          }
        }
        showToast("任务已添加", "success", "bottom");
      } catch (error) {
        showToast(`保存失败：${describeError(error)}`, "danger", "bottom");
      }
      // 任务数据变了：小组件快照随后台去抖刷新（内部去重，连续操作只推一次）
      notifyWidgetDataChanged();
      await refresh(true);
    },
    [refresh, showToast],
  );

  const handleUpdate = useCallback(
    async (original: Task, input: NewTaskInput) => {
      try {
        // 三态契约：编辑弹层里选「无」就是显式清空，所以这里一律显式传值，
        // 用 null 表示清空、而不是省略键（省略会被数据层理解为「保持不变」）。
        const updated = await updateTask(original.id, {
          title: input.title,
          description: input.description ?? "",
          priority: input.priority ?? 0,
          dueAt: input.dueAt ?? null,
          remindAt: input.remindAt ?? null,
          advanceMinutes: input.advanceMinutes ?? null,
          tags: input.tags ?? null,
          // 三态：undefined=不改、null=清空、字符串=写入。编辑器总会显式给出该键。
          ...(input.recurrenceRule !== undefined
            ? { recurrenceRule: input.recurrenceRule }
            : {}),
        });
        if (!updated) {
          showToast("任务已不存在", "danger", "bottom");
        } else {
          // 改了提醒时间要重建排期；引擎内部按 (task_id, occurrence) 幂等，不会重复弹。
          await rescheduleAllReminders();
          showToast("任务已更新", "success", "bottom");
        }
      } catch (error) {
        showToast(`更新失败：${describeError(error)}`, "danger", "bottom");
      }
      // 任务数据变了：小组件快照随后台去抖刷新（内部去重，连续操作只推一次）
      notifyWidgetDataChanged();
      await refresh(true);
    },
    [refresh, showToast],
  );

  const handleEditorSubmit = useCallback(
    (input: NewTaskInput) => {
      if (editorState.mode === "edit") void handleUpdate(editorState.task, input);
      else void handleCreate(input);
    },
    [editorState, handleCreate, handleUpdate],
  );

  const closeEditor = useCallback(() => setEditorOpen(false), []);

  const sheetActions = useMemo<SheetAction[]>(() => {
    if (!actionTask) return [];
    const rule = parseRecurrence(actionTask.recurrenceRule);
    return [
      {
        key: "toggle",
        label:
          actionTask.status === "pending"
            ? rule
              ? "完成本期"
              : "标记为完成"
            : "标记为未完成",
        tone: "primary",
        icon: actionTask.status === "pending" ? "success" : "pending",
        hint: rule ? `${describeRecurrence(rule)}：只推进到下一期，不进入已完成` : undefined,
      },
      {
        key: "edit",
        label: "编辑任务",
        icon: "edit",
        hint: "标题、优先级、截止时间、重复与提醒",
      },
      {
        key: "delete",
        label: "删除任务",
        tone: "danger",
        icon: "delete",
        hint: "删除后不再出现在任务列表",
      },
    ];
  }, [actionTask]);

  const handleSheetAction = useCallback(
    (key: string) => {
      const task = actionTask;
      setActionOpen(false);
      if (!task) return;
      if (key === "toggle") {
        void handleToggle(task, "bottom");
        return;
      }
      if (key === "edit") {
        setEditorState({ mode: "edit", task });
        setEditorOpen(true);
        return;
      }
      if (key === "delete") void handleDelete(task, "bottom");
    },
    [actionTask, handleDelete, handleToggle],
  );

  const openCreate = useCallback(() => {
    setEditorState({ mode: "create" });
    setEditorOpen(true);
  }, []);

  /** 轻点任务主体：打开同一个编辑弹层，不新增第二套详情页 */
  const openEditor = useCallback((task: Task) => {
    setEditorState({ mode: "edit", task });
    setEditorOpen(true);
  }, []);

  // 首页「新建任务」快捷入口：切到任务栏后直接打开同一个 TaskEditorSheet。
  // 打开一次就通知 Shell 归零；否则页面切走再切回（组件重挂载）会重复消费旧信号。
  const lastCreateSignal = useRef(0);
  useEffect(() => {
    if (!shouldConsumeCreateSignal(openCreateSignal, lastCreateSignal.current)) return;
    lastCreateSignal.current = openCreateSignal;
    openCreate();
    onConsumeCreateSignal?.();
  }, [onConsumeCreateSignal, openCreate, openCreateSignal]);

  const renderRow = useCallback(
    ({ item }: ListRenderItemInfo<TaskListRow>) => {
      if (item.type === "section") {
        return (
          <TaskGroupHeader
            title={item.section.title}
            count={item.section.tasks.length}
            hint={item.section.hint}
            hintTone={item.section.hintTone}
            tone={item.section.tone}
            collapsed={collapsed.has(item.section.key)}
            onPress={() => toggleSection(item.section.key)}
          />
        );
      }
      return (
        <TaskRow
          task={item.task}
          now={now}
          entranceIndex={item.entranceIndex}
          onToggle={handleToggle}
          onOpenEditor={openEditor}
          onOpenActions={handleOpenActions}
          onDelete={handleDelete}
        />
      );
    },
    [collapsed, handleDelete, handleOpenActions, handleToggle, now, openEditor, toggleSection],
  );

  const keyExtractor = useCallback(
    (row: TaskListRow) =>
      row.type === "section" ? `section-${row.section.key}` : `task-${row.task.id}`,
    [],
  );

  // 统计色只在「有问题」时启用强调色：0 项逾期不该整片飘红
  const overdueTone = counts.overdue > 0 ? tokens.warn : tokens.textSoft;
  const editorTask = editorState.mode === "edit" ? editorState.task : null;
  const trimmedQuery = query.trim();
  const searching = trimmedQuery.length > 0;
  const emptyCopy = searching
    ? {
        title: "没有匹配的任务",
        hint: `没有标题或备注包含「${trimmedQuery}」的任务；搜索同时匹配描述与标签`,
      }
    : EMPTY_COPY[filter];
  const showCreateAction = !searching && (filter === "all" || filter === "pending");

  const toggleSearch = useCallback(() => {
    if (searchOpen) setQuery("");
    setSearchOpen((open) => !open);
  }, [searchOpen]);

  const listHeader = (
    <View style={styles.header}>
      {/* 130% 以上字号：五个胶囊横排会超出屏幕且看不出还能滑动，改成换行排布，
          保证「已完成」也直接可见、可点。常规字号仍用横向滚动，保持单行高度。 */}
      {largeFont ? (
        <View style={styles.filterWrap} accessibilityLabel="任务筛选">
          {FILTERS.map((item) => (
            <Chip
              key={item.key}
              label={item.label}
              active={filter === item.key}
              accessibilityLabel={`筛选 ${item.label}`}
              onPress={() => setFilter(item.key)}
            />
          ))}
        </View>
      ) : (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          accessibilityLabel="任务筛选"
          style={styles.filterScroll}
          contentContainerStyle={styles.filterRow}
        >
          {FILTERS.map((item) => (
            <Chip
              key={item.key}
              label={item.label}
              active={filter === item.key}
              accessibilityLabel={`筛选 ${item.label}`}
              onPress={() => setFilter(item.key)}
            />
          ))}
        </ScrollView>
      )}

      {searchOpen ? (
        <SearchField
          value={query}
          onChangeText={setQuery}
          placeholder="搜索任务、标签、分类"
          accessibilityLabel="搜索任务"
        />
      ) : null}

      {/* 紧凑统计条：四个真实计数，替代上一版四张高统计卡 */}
      <View
        style={[
          styles.statsStrip,
          { backgroundColor: tokens.bgAccent },
          twoColumnStats ? styles.statsWrap : null,
        ]}
      >
        {[
          { key: "pending", label: "待办", value: counts.pending, color: tokens.accentText },
          { key: "today", label: "今天", value: counts.dueToday, color: tokens.accentText },
          { key: "overdue", label: "逾期", value: counts.overdue, color: overdueTone },
          { key: "completed", label: "完成", value: counts.completed, color: tokens.ok },
        ].map((item, index) => (
          <View
            key={item.key}
            style={[
              styles.statItem,
              twoColumnStats ? styles.statHalf : null,
              index > 0 && !twoColumnStats
                ? [styles.statDivider, { borderLeftColor: tokens.separator }]
                : null,
            ]}
            accessibilityLabel={`${item.label} ${item.value} 项`}
          >
            <Text numberOfLines={1} style={[styles.statLabel, { color: tokens.muted }]}>
              {item.label}
            </Text>
            <Text numberOfLines={1} style={[styles.statValue, { color: item.color }]}>
              {item.value}
            </Text>
          </View>
        ))}
      </View>

      {searching ? (
        <Text style={[styles.searchHint, { color: tokens.muted }]}>
          找到 {visible.length} 项
          {filter === "all" ? "" : `（当前筛选：${FILTERS.find((f) => f.key === filter)?.label}）`}
        </Text>
      ) : null}
    </View>
  );

  return (
    <View style={styles.container}>
      <ScreenHeader
        title="任务"
        subtitle={formatDayLabel(now)}
        right={
          <>
            <HeaderIconButton
              icon="search"
              accessibilityLabel={searchOpen ? "关闭任务搜索" : "搜索任务"}
              onPress={toggleSearch}
            />
            <HeaderIconButton
              icon="add"
              accessibilityLabel="新建任务"
              onPress={openCreate}
            />
          </>
        }
      />

      {loading ? (
        <ActivityIndicator style={styles.loading} color={tokens.accent} />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={keyExtractor}
          renderItem={renderRow}
          ListHeaderComponent={listHeader}
          ListEmptyComponent={
            <EmptyState
              icon="tasks"
              title={emptyCopy.title}
              hint={emptyCopy.hint}
              actionLabel={searching ? "清除搜索" : showCreateAction ? "新建任务" : "查看全部任务"}
              onAction={
                searching
                  ? () => setQuery("")
                  : showCreateAction
                    ? openCreate
                    : () => setFilter("all")
              }
            />
          }
          contentContainerStyle={styles.listContent}
          ItemSeparatorComponent={RowSeparator}
          showsVerticalScrollIndicator={false}
          initialNumToRender={14}
          maxToRenderPerBatch={12}
          windowSize={7}
          removeClippedSubviews
        />
      )}

      <Toast
        toast={toast}
        onDismiss={dismissToast}
        placement="top"
        bottomOffset={space.lg + 32}
      />

      <ActionSheet
        visible={actionOpen}
        title={actionTask?.title ?? ""}
        subtitle={actionTask ? actionSubtitle(actionTask, now) : undefined}
        actions={sheetActions}
        onAction={handleSheetAction}
        onRequestClose={() => setActionOpen(false)}
      />

      <TaskEditorSheet
        visible={editorOpen}
        mode={editorState.mode}
        task={editorTask}
        onClose={closeEditor}
        onSubmit={handleEditorSubmit}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  loading: { marginTop: space.xl },
  header: {
    paddingTop: space.sm,
    gap: space.md,
    paddingBottom: space.xs,
  },
  searchHint: {
    fontSize: font.meta,
  },
  statsStrip: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    borderRadius: radius.row,
    paddingVertical: space.xs,
    paddingHorizontal: space.xxs,
    rowGap: space.xs,
  },
  statsWrap: {
    rowGap: space.xs,
  },
  statItem: {
    flexBasis: "25%",
    flexGrow: 1,
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "center",
    gap: 4,
    paddingHorizontal: 2,
  },
  statDivider: {
    borderLeftWidth: StyleSheet.hairlineWidth,
  },
  statHalf: {
    flexBasis: "50%",
  },
  statLabel: {
    fontSize: font.label,
  },
  statValue: {
    fontSize: font.section,
    fontWeight: "800",
    fontVariant: ["tabular-nums"],
  },
  filterScroll: {
    marginHorizontal: -space.lg,
  },
  filterWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: space.sm,
  },
  filterRow: {
    flexDirection: "row",
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingVertical: space.xxs,
  },
  listContent: {
    paddingHorizontal: space.lg,
    paddingBottom: 32,
  },
  rowGap: {
    height: space.sm,
  },
});
