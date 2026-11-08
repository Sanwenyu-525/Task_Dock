// 任务页：统计 → 筛选 → 分组列表（同一 FlatList 内用分组头切分，不做嵌套列表）。
// 交互约定：轻点完成、左右滑动删除、长按打开动作表；编辑与新建共用 TaskEditorSheet。
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
import { PressableScale } from "../components/PressableScale";
import { SearchField } from "../components/SearchField";
import { StatCard, type StatTone } from "../components/StatCard";
import { TaskEditorSheet } from "../components/TaskEditorSheet";
import { TaskGroupHeader } from "../components/TaskGroupHeader";
import { TaskRow } from "../components/TaskRow";
import { Toast, type ToastMessage, type ToastTone } from "../components/Toast";
import { createTask, deleteTask, listTasks, toggleTask, updateTask } from "../db/tasks";
import { countTasks, formatDue, matchesQuery, selectTasks } from "../domain/taskQuery";
import { describeRecurrence, parseRecurrence } from "../domain/recurrence";
import type { NewTaskInput, Task, TaskFilter } from "../domain/types";
import { describeError } from "../lib/errors";
import { rescheduleAllReminders } from "../notifications/reminderEngine";
import { cancelReminder, scheduleReminder } from "../notifications/reminders";
import { useReduceMotion } from "../theme/MotionProvider";
import { useTheme } from "../theme/ThemeProvider";
import { floatingShadow } from "../theme/shadows";
import { font, radius, space } from "../theme/tokens";

import { buildTaskSections, flattenSections, type TaskListRow } from "./taskGroups";

const FILTERS: { key: TaskFilter; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "pending", label: "待办" },
  { key: "today", label: "今天" },
  { key: "overdue", label: "已过期" },
  { key: "completed", label: "已完成" },
];

const EMPTY_COPY: Record<TaskFilter, { title: string; hint: string }> = {
  all: { title: "还没有任务", hint: "点右下角 + 记下第一件事；还没想清楚的先丢进收集箱" },
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

export function TasksScreen({ version = 0 }: { version?: number }) {
  const { tokens, scheme } = useTheme();
  const reduceMotion = useReduceMotion();
  const { width } = useWindowDimensions();
  const narrow = width < 380;

  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<TaskFilter>("all");
  const [query, setQuery] = useState("");
  const [now, setNow] = useState(() => Date.now());

  const [editorState, setEditorState] = useState<{ mode: "create" } | { mode: "edit"; task: Task }>(
    { mode: "create" },
  );
  const [editorOpen, setEditorOpen] = useState(false);
  const [actionTask, setActionTask] = useState<Task | null>(null);
  const [actionOpen, setActionOpen] = useState(false);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const toastSeq = useRef(0);

  const showToast = useCallback((text: string, tone: ToastTone = "info") => {
    toastSeq.current += 1;
    setToast({ id: toastSeq.current, text, tone });
  }, []);
  const dismissToast = useCallback(() => setToast(null), []);

  const animateLayout = useCallback(() => {
    if (reduceMotion) return;
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
  }, [reduceMotion]);

  const refresh = useCallback(
    async (animated = false) => {
      try {
        const next = await listTasks();
        // 配置必须紧贴数据提交：提前调用会被其它状态更新消费掉
        if (animated) animateLayout();
        setTasks(next);
      } catch (error) {
        showToast(`读取任务失败：${describeError(error)}`, "danger");
      } finally {
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
  const rows = useMemo(() => flattenSections(buildTaskSections(visible, now)), [visible, now]);

  const handleToggle = useCallback(
    async (task: Task) => {
      try {
        const outcome = await toggleTask(task.id);
        if (outcome.advanced) {
          // 期次推进后提醒时间变了：重建排期（引擎按 (task_id, occurrence) 幂等）
          await rescheduleAllReminders();
          const next = formatDue(outcome.advanced.toDueAt, Date.now());
          showToast(next ? `已完成本期，下次 ${next}` : "已完成本期", "success");
        } else if (outcome.task) {
          if (outcome.task.status === "completed") await cancelReminder(task.id);
          else if (outcome.task.remindAt != null && outcome.task.remindAt > Date.now()) {
            await scheduleReminder(task.id, outcome.task.title, outcome.task.remindAt);
          }
        }
      } catch (error) {
        showToast(`操作失败：${describeError(error)}`, "danger");
      }
      await refresh(true);
    },
    [refresh, showToast],
  );

  const handleDelete = useCallback(
    async (task: Task) => {
      try {
        await deleteTask(task.id);
        await cancelReminder(task.id);
        showToast("任务已删除");
      } catch (error) {
        showToast(`删除失败：${describeError(error)}`, "danger");
      }
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
          const scheduled = await scheduleReminder(task.id, task.title, input.remindAt);
          if (!scheduled) {
            showToast("提醒未排期：系统通知权限未开启，任务已保存", "warn");
          }
        }
        showToast("任务已添加", "success");
      } catch (error) {
        showToast(`保存失败：${describeError(error)}`, "danger");
      }
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
          // 三态：undefined=不改、null=清空、字符串=写入。编辑器总会显式给出该键。
          ...(input.recurrenceRule !== undefined
            ? { recurrenceRule: input.recurrenceRule }
            : {}),
        });
        if (!updated) {
          showToast("任务已不存在", "danger");
        } else {
          // 改了提醒时间要重建排期；引擎内部按 (task_id, occurrence) 幂等，不会重复弹。
          await rescheduleAllReminders();
          showToast("任务已更新", "success");
        }
      } catch (error) {
        showToast(`更新失败：${describeError(error)}`, "danger");
      }
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
        hint: rule ? `${describeRecurrence(rule)}：只推进到下一期，不进入已完成` : undefined,
      },
      { key: "edit", label: "编辑任务", hint: "标题、优先级、截止时间、重复与提醒" },
      { key: "delete", label: "删除任务", tone: "danger", hint: "删除后不再出现在任务列表" },
    ];
  }, [actionTask]);

  const handleSheetAction = useCallback(
    (key: string) => {
      const task = actionTask;
      setActionOpen(false);
      if (!task) return;
      if (key === "toggle") {
        void handleToggle(task);
        return;
      }
      if (key === "edit") {
        setEditorState({ mode: "edit", task });
        setEditorOpen(true);
        return;
      }
      if (key === "delete") void handleDelete(task);
    },
    [actionTask, handleDelete, handleToggle],
  );

  const openCreate = useCallback(() => {
    setEditorState({ mode: "create" });
    setEditorOpen(true);
  }, []);

  const renderRow = useCallback(
    ({ item }: ListRenderItemInfo<TaskListRow>) => {
      if (item.type === "section") {
        return (
          <TaskGroupHeader
            title={item.section.title}
            count={item.section.tasks.length}
            hint={item.section.hint}
            tone={item.section.tone}
          />
        );
      }
      return (
        <TaskRow
          task={item.task}
          now={now}
          entranceIndex={item.entranceIndex}
          onToggle={handleToggle}
          onOpenActions={handleOpenActions}
          onDelete={handleDelete}
        />
      );
    },
    [handleDelete, handleOpenActions, handleToggle, now],
  );

  const keyExtractor = useCallback(
    (row: TaskListRow) =>
      row.type === "section" ? `section-${row.section.key}` : `task-${row.task.id}`,
    [],
  );

  // 统计色只在「有问题」时启用强调色：0 项逾期不该整片飘红
  const statTone = (value: number, tone: StatTone): StatTone => (value > 0 ? tone : "neutral");

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

  const listHeader = (
    <View style={styles.header}>
      <View style={styles.titleBlock}>
        <Text accessibilityRole="header" style={[styles.screenTitle, { color: tokens.text }]}>
          任务
        </Text>
        <Text style={[styles.screenSubtitle, { color: tokens.muted }]}>
          独立模式 · 数据只在本机
        </Text>
      </View>

      <View style={styles.stats}>
        <StatCard
          label="待办"
          value={counts.pending}
          tone="accent"
          style={narrow ? styles.statNarrow : undefined}
        />
        <StatCard
          label="今天到期"
          value={counts.dueToday}
          tone={statTone(counts.dueToday, "warn")}
          style={narrow ? styles.statNarrow : undefined}
        />
        <StatCard
          label="已过期"
          value={counts.overdue}
          tone={statTone(counts.overdue, "danger")}
          style={narrow ? styles.statNarrow : undefined}
        />
        <StatCard
          label="已完成"
          value={counts.completed}
          tone={statTone(counts.completed, "ok")}
          style={narrow ? styles.statNarrow : undefined}
        />
      </View>

      <SearchField
        value={query}
        onChangeText={setQuery}
        placeholder="搜索标题、描述或标签"
        accessibilityLabel="搜索任务"
      />

      {searching ? (
        <Text style={[styles.searchHint, { color: tokens.muted }]}>
          找到 {visible.length} 项
          {filter === "all" ? "" : `（当前筛选：${FILTERS.find((f) => f.key === filter)?.label}）`}
        </Text>
      ) : null}
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
    </View>
  );

  return (
    <View style={styles.container}>
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

      <PressableScale
        onPress={openCreate}
        accessibilityLabel="新建任务"
        accessibilityHint="打开新建任务面板"
        style={styles.fab}
        contentStyle={[
          styles.fabInner,
          { backgroundColor: tokens.accentFill },
          floatingShadow(scheme),
        ]}
      >
        <View style={styles.fabGlyph}>
          <View style={[styles.fabBar, styles.fabBarH, { backgroundColor: tokens.onAccent }]} />
          <View style={[styles.fabBar, styles.fabBarV, { backgroundColor: tokens.onAccent }]} />
        </View>
      </PressableScale>

      <Toast toast={toast} onDismiss={dismissToast} bottomOffset={space.lg + 68} />

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
  titleBlock: {
    gap: 2,
  },
  screenTitle: {
    fontSize: font.display,
    fontWeight: "700",
    letterSpacing: -0.5,
  },
  screenSubtitle: {
    fontSize: font.meta,
  },
  searchHint: {
    fontSize: font.meta,
  },
  stats: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: space.sm,
  },
  // 320dp 窄屏改成两列：4 张卡并排时标签会被压到换行或截断
  statNarrow: {
    flexBasis: "48%",
  },
  filterScroll: {
    marginHorizontal: -space.lg,
  },
  filterRow: {
    flexDirection: "row",
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingVertical: space.xxs,
  },
  listContent: {
    paddingHorizontal: space.lg,
    paddingBottom: 120,
  },
  rowGap: {
    height: space.sm,
  },
  fab: {
    position: "absolute",
    right: space.lg,
    bottom: space.lg,
  },
  fabInner: {
    width: 56,
    height: 56,
    borderRadius: radius.chip,
    alignItems: "center",
    justifyContent: "center",
  },
  fabGlyph: {
    width: 24,
    height: 24,
    alignItems: "center",
    justifyContent: "center",
  },
  fabBar: {
    position: "absolute",
    borderRadius: 1,
  },
  fabBarH: {
    left: 2,
    top: 11.1,
    width: 20,
    height: 1.8,
  },
  fabBarV: {
    left: 11.1,
    top: 2,
    width: 1.8,
    height: 20,
  },
});
