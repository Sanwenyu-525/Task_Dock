// 任务页（第七轮布局）：主状态分段 → 次级日期筛选 → 分组列表。
// 分组不是「标题 + 一堆独立白卡」，而是「浅色分组条 + 连续白卡行」，
// 更接近参考图的开发任务管理视觉；交互契约不变：
// 勾选完成/恢复、轻点行主体编辑、长按动作表、向左滑动删除；编辑与新建共用 TaskEditorSheet。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  LayoutAnimation,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type ListRenderItemInfo,
} from "react-native";

import { ActionSheet, type SheetAction } from "../components/ActionSheet";
import { Chip } from "../components/Chip";
import { EmptyState } from "../components/EmptyState";
import { HeaderIconButton } from "../components/HeaderIconButton";
import { SearchField } from "../components/SearchField";
import { ScreenHeader } from "../components/ScreenHeader";
import { SegmentedControl, type SegmentOption } from "../components/SegmentedControl";
import { TaskEditorSheet } from "../components/TaskEditorSheet";
import { TaskGroupHeader } from "../components/TaskGroupHeader";
import { TaskRow } from "../components/TaskRow";
import { type IconName } from "../components/icons/AppIcon";
import {
  Toast,
  type ToastMessage,
  type ToastPlacement,
  type ToastTone,
} from "../components/Toast";
import { getSetting } from "../db/kv";
import { createTask, deleteTask, listTasks, toggleTask, updateTask } from "../db/tasks";
import {
  countTasks,
  formatDue,
  matchesQuery,
  selectTasksByFilter,
} from "../domain/taskQuery";
import { describeRecurrence, parseRecurrence } from "../domain/recurrence";
import type {
  NewTaskInput,
  Task,
  TaskPeriodFilter,
  TaskStatusFilter,
} from "../domain/types";
import { describeError } from "../lib/errors";
import { shouldConsumeCreateSignal } from "../lib/nav";
import { notifyWidgetDataChanged } from "../lib/widgetSnapshot";
import { rescheduleAllReminders, SNOOZE_SETTING_KEY } from "../notifications/reminderEngine";
import { cancelReminder, scheduleReminder } from "../notifications/reminders";
import { useReduceMotion } from "../theme/MotionProvider";
import { useTheme } from "../theme/ThemeProvider";
import { font, space } from "../theme/tokens";

import { buildTaskSections, flattenSections, type SectionKey, type TaskListRow } from "./taskGroups";

/** 主筛选只放状态：日期范围是次级筛选，两者正交，不再混在同一个胶囊组里 */
const PERIOD_FILTERS: { key: TaskPeriodFilter; label: string }[] = [
  { key: "any", label: "全部日期" },
  { key: "today", label: "今天" },
  { key: "week", label: "本周" },
  { key: "later", label: "以后" },
  { key: "undated", label: "无日期" },
  { key: "overdue", label: "逾期" },
];

/** 分组语义图标：与分组头的色调一起，让长列表里的分区一眼可分 */
const SECTION_ICONS: Record<SectionKey, IconName> = {
  today: "calendarDays",
  week: "calendar",
  later: "clock",
  undated: "list",
  done: "success",
};

/** 空状态文案：先按状态，再按时间范围；不把「筛选后为空」说成「没有任务」 */
function emptyCopyFor(
  status: TaskStatusFilter,
  period: TaskPeriodFilter,
): { title: string; hint: string } {
  if (status === "completed") {
    return { title: "还没有完成的任务", hint: "完成第一件后，这里会慢慢累积你的记录" };
  }
  if (period === "overdue") {
    return { title: "没有逾期任务", hint: "保持这个节奏，别让截止日期追上来" };
  }
  if (period === "today") {
    return { title: "今天没有到期任务", hint: "没有卡在今天的事，可以推进别的工作" };
  }
  if (period === "week") {
    return { title: "本周没有到期任务", hint: "本周还没有需要收尾的事" };
  }
  if (period === "later") {
    return { title: "以后没有安排任务", hint: "把想到的事先记下来，之后再排时间" };
  }
  if (period === "undated") {
    return { title: "没有无日期任务", hint: "所有任务都已经安排了时间" };
  }
  if (status === "pending") {
    return { title: "没有待办任务", hint: "手上的事都处理完了，先歇一会儿" };
  }
  return { title: "还没有任务", hint: "点右上角 + 记下第一件事；还没想清楚的先丢进收集箱" };
}

/** 动作表副标题：截止时间 + 重复规则，避免用户在动作表里看不出这是循环任务 */
function actionSubtitle(task: Task, now: number): string {
  const due = formatDue(task.dueAt, now) ?? "无截止时间";
  const rule = parseRecurrence(task.recurrenceRule);
  return rule ? `${due} · ${describeRecurrence(rule)}` : due;
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

  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<TaskStatusFilter>("all");
  const [periodFilter, setPeriodFilter] = useState<TaskPeriodFilter>("any");
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
    () =>
      selectTasksByFilter(
        tasks.filter((task) => matchesQuery(task, query)),
        statusFilter,
        periodFilter,
        now,
      ),
    [tasks, statusFilter, periodFilter, now, query],
  );
  const counts = useMemo(() => countTasks(tasks, now), [tasks, now]);
  const rows = useMemo(
    () => flattenSections(buildTaskSections(visible, now), collapsed),
    [collapsed, visible, now],
  );

  /** 主分段直接带上真实计数：统计不再单独占一条后台 KPI 栏 */
  const statusOptions = useMemo<SegmentOption<TaskStatusFilter>[]>(
    () => [
      { value: "all", label: `全部 ${counts.total}` },
      { value: "pending", label: `未完成 ${counts.pending}` },
      { value: "completed", label: `已完成 ${counts.completed}` },
    ],
    [counts.completed, counts.pending, counts.total],
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
            icon={SECTION_ICONS[item.section.key]}
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
          last={item.position === "last" || item.position === "only"}
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

  const editorTask = editorState.mode === "edit" ? editorState.task : null;
  const trimmedQuery = query.trim();
  const searching = trimmedQuery.length > 0;
  const filtersActive = statusFilter !== "all" || periodFilter !== "any";
  const emptyCopy = searching
    ? {
        title: "没有匹配的任务",
        hint: `没有标题或备注包含「${trimmedQuery}」的任务；搜索同时匹配描述与标签`,
      }
    : emptyCopyFor(statusFilter, periodFilter);
  const emptyActionLabel = searching ? "清除搜索" : filtersActive ? "重置筛选" : "新建任务";
  const handleEmptyAction = searching
    ? () => setQuery("")
    : filtersActive
      ? () => {
          setStatusFilter("all");
          setPeriodFilter("any");
        }
      : openCreate;

  const toggleSearch = useCallback(() => {
    if (searchOpen) setQuery("");
    setSearchOpen((open) => !open);
  }, [searchOpen]);

  const listHeader = (
    <View style={styles.header}>
      <SegmentedControl
        options={statusOptions}
        value={statusFilter}
        onChange={setStatusFilter}
        accessibilityLabel="任务状态筛选"
        emphasis="accent"
        size="compact"
      />

      {/* 次级日期筛选：浅色胶囊，视觉权重低于上方分段；横向滚动，不挤成两行 */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        accessibilityLabel="按日期筛选任务"
        style={styles.filterScroll}
        contentContainerStyle={styles.filterRow}
      >
        {PERIOD_FILTERS.map((item) => (
          <Chip
            key={item.key}
            label={item.label}
            active={periodFilter === item.key}
            variant="soft"
            accessibilityLabel={`日期筛选 ${item.label}`}
            onPress={() => setPeriodFilter(item.key)}
          />
        ))}
      </ScrollView>

      {searchOpen ? (
        <SearchField
          value={query}
          onChangeText={setQuery}
          placeholder="搜索任务、标签、分类"
          accessibilityLabel="搜索任务"
        />
      ) : null}

      {searching ? (
        <Text style={[styles.searchHint, { color: tokens.muted }]}>
          找到 {visible.length} 项
          {periodFilter === "any" ? "" : `（${PERIOD_FILTERS.find((f) => f.key === periodFilter)?.label}）`}
        </Text>
      ) : null}
    </View>
  );

  return (
    <View style={styles.container}>
      <ScreenHeader
        title="任务"
        right={
          <>
            <HeaderIconButton
              icon="search"
              accessibilityLabel={searchOpen ? "关闭任务搜索" : "搜索任务"}
              onPress={toggleSearch}
            />
            <HeaderIconButton icon="add" accessibilityLabel="新建任务" onPress={openCreate} />
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
              actionLabel={emptyActionLabel}
              onAction={handleEmptyAction}
            />
          }
          contentContainerStyle={styles.listContent}
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
    paddingBottom: 32,
  },
});
