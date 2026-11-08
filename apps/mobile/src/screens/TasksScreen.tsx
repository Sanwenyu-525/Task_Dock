// 任务页：统计 → 筛选 → 分组列表（同一 FlatList 内用分组头切分，不做嵌套列表）。
// 交互约定：轻点完成、左滑删除、长按打开动作表；编辑与新建共用 TaskEditorSheet。
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
import { StatCard, type StatTone } from "../components/StatCard";
import { TaskEditorSheet } from "../components/TaskEditorSheet";
import { TaskGroupHeader } from "../components/TaskGroupHeader";
import { TaskRow } from "../components/TaskRow";
import { Toast, type ToastMessage, type ToastTone } from "../components/Toast";
import { createTask, deleteTask, listTasks, toggleTask } from "../db/tasks";
import { countTasks, formatDue, selectTasks } from "../domain/taskQuery";
import type { NewTaskInput, Task, TaskFilter } from "../domain/types";
import { describeError } from "../lib/errors";
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

export function TasksScreen({ version = 0 }: { version?: number }) {
  const { tokens, scheme } = useTheme();
  const reduceMotion = useReduceMotion();
  const { width } = useWindowDimensions();
  const narrow = width < 380;

  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<TaskFilter>("all");
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

  const visible = useMemo(() => selectTasks(tasks, filter, now), [tasks, filter, now]);
  const counts = useMemo(() => countTasks(tasks, now), [tasks, now]);
  const rows = useMemo(() => flattenSections(buildTaskSections(visible, now)), [visible, now]);

  const handleToggle = useCallback(
    async (task: Task) => {
      try {
        const updated = await toggleTask(task.id);
        if (updated) {
          if (updated.status === "completed") await cancelReminder(task.id);
          else if (updated.remindAt != null && updated.remindAt > Date.now()) {
            await scheduleReminder(task.id, updated.title, updated.remindAt);
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
      let createdId: string | null = null;
      try {
        // 数据层目前没有 updateTask：用「新建 + 删除旧记录」替换，保留描述；
        // 已完成任务建好后立即切回完成态，避免编辑把它变回待办。
        const created = await createTask({ ...input, description: original.description });
        createdId = created.id;
        if (original.status === "completed") {
          await toggleTask(created.id);
          await cancelReminder(created.id);
        } else if (input.remindAt != null) {
          const scheduled = await scheduleReminder(created.id, created.title, input.remindAt);
          if (!scheduled) {
            showToast("提醒未排期：系统通知权限未开启", "warn");
          }
        }
        await cancelReminder(original.id);
        await deleteTask(original.id);
        showToast("任务已更新", "success");
      } catch (error) {
        // 删除旧记录失败时撤销新记录，避免同一任务出现两条
        let rolledBack = true;
        if (createdId) {
          try {
            await deleteTask(createdId);
          } catch {
            rolledBack = false;
          }
        }
        showToast(
          rolledBack
            ? `更新失败：${describeError(error)}`
            : `更新失败，可能产生重复任务：${describeError(error)}`,
          "danger",
        );
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
    return [
      {
        key: "toggle",
        label: actionTask.status === "pending" ? "标记为完成" : "标记为未完成",
        tone: "primary",
      },
      { key: "edit", label: "编辑任务", hint: "标题、优先级、截止时间与提醒" },
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
  const emptyCopy = EMPTY_COPY[filter];
  const showCreateAction = filter === "all" || filter === "pending";

  const listHeader = (
    <View style={styles.header}>
      <View style={styles.titleBlock}>
        <Text style={[styles.screenTitle, { color: tokens.text }]}>任务</Text>
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
              actionLabel={showCreateAction ? "新建任务" : "查看全部任务"}
              onAction={showCreateAction ? openCreate : () => setFilter("all")}
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
        <Text style={[styles.fabGlyph, { color: tokens.onAccent }]}>＋</Text>
      </PressableScale>

      <Toast toast={toast} onDismiss={dismissToast} bottomOffset={space.lg + 68} />

      <ActionSheet
        visible={actionOpen}
        title={actionTask?.title ?? ""}
        subtitle={actionTask ? (formatDue(actionTask.dueAt, now) ?? "无截止时间") : undefined}
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
    fontSize: 26,
    fontWeight: "400",
    lineHeight: 30,
  },
});
