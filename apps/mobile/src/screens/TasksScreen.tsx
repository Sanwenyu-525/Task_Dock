// 任务页（A 组重构）：范围分段 → 状态分段 → 日期筛选 → 分组列表。
// 分组不是「标题 + 一堆独立白卡」，而是「浅色分组条 + 连续白卡行」，
// 更接近参考图的开发任务管理视觉；交互契约不变：
// 勾选完成/恢复、轻点行主体进任务详情、长按动作表、向左滑动删除；编辑与新建共用 TaskEditorSheet。
//
// 数据边界：移动端只有本机任务，「项目任务 / 团队任务」没有数据链路，分段保留为降饱和禁用占位，
// 不切换、不造假列表；卡片不显示负责人（无对应字段）。
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentRef } from "react";
import {
  ActivityIndicator,
  FlatList,
  LayoutAnimation,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type ListRenderItemInfo,
} from "react-native";

import { ActionSheet, type SheetAction } from "../components/ActionSheet";
import { Chip } from "../components/Chip";
import { ConfirmSheet } from "../components/ConfirmSheet";
import { EmptyState } from "../components/EmptyState";
import { HeaderIconButton } from "../components/HeaderIconButton";
import { SearchField } from "../components/SearchField";
import { ScreenHeader } from "../components/ScreenHeader";
import { SegmentedControl, type SegmentOption } from "../components/SegmentedControl";
import { TaskEditorSheet, type TaskSubmitOutcome } from "../components/TaskEditorSheet";
import { TaskGroupHeader } from "../components/TaskGroupHeader";
import { TaskRow } from "../components/TaskRow";
import { type IconName } from "../components/icons/AppIcon";
import { useToast } from "../feedback/ToastProvider";
import { useToastPagePlacement } from "../feedback/ToastLayoutProvider";
import type { ToastPlacement } from "../feedback/toastQueue";
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
import type { AppNav } from "../lib/nav";
import { shouldConsumeCreateSignal, shouldConsumeSignal } from "../lib/nav";
import { notifyWidgetDataChanged } from "../lib/widgetSnapshot";
import { rescheduleAllReminders, SNOOZE_SETTING_KEY } from "../notifications/reminderEngine";
import { cancelReminder, scheduleReminder } from "../notifications/reminders";
import { useReduceMotion } from "../theme/MotionProvider";
import { useTheme } from "../theme/ThemeProvider";
import { font, space } from "../theme/tokens";

import { buildTaskSections, flattenSections, type SectionKey, type TaskListRow } from "./taskGroups";

/** 任务范围：只有「我的任务」有本机数据；项目/团队分段是禁用占位，不切换、不造假列表 */
type TaskScope = "mine" | "project" | "team";

const SCOPE_OPTIONS: SegmentOption<TaskScope>[] = [
  { value: "mine", label: "我的任务" },
  { value: "project", label: "项目任务", disabled: true },
  { value: "team", label: "团队任务", disabled: true },
];

/**
 * 未开放范围的反馈文案：移动端没有项目/团队的数据链路，
 * 不能伪装成可用筛选项，但点上去必须有明确说明（旧实现是 disabled 静默吞点击）。
 */
const SCOPE_UNAVAILABLE_COPY: Record<Exclude<TaskScope, "mine">, string> = {
  project: "项目任务暂未开放：移动端目前只支持个人任务，项目数据请在桌面端查看。",
  team: "团队任务暂未开放：移动端目前只支持个人任务，团队协作请在桌面端使用。",
};

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
  nav,
  openCreateSignal = 0,
  onConsumeCreateSignal,
  focusSearchSignal = 0,
  onConsumeSearchSignal,
}: {
  version?: number;
  /** Shell 注入的导航对象；用于轻点行主体进入任务详情 */
  nav?: AppNav;
  /** 首页/工作区快捷入口发出的「打开新建」信号；0 = 无信号 */
  openCreateSignal?: number;
  /** 消费后由 Shell 立刻归零，避免页面卸载重挂时再次打开弹层 */
  onConsumeCreateSignal?: () => void;
  /** 首页放大镜发出的「聚焦搜索框」信号；0 = 无信号 */
  focusSearchSignal?: number;
  onConsumeSearchSignal?: () => void;
}) {
  const { tokens } = useTheme();
  const reduceMotion = useReduceMotion();

  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [scope, setScope] = useState<TaskScope>("mine");
  const [statusFilter, setStatusFilter] = useState<TaskStatusFilter>("all");
  const [periodFilter, setPeriodFilter] = useState<TaskPeriodFilter>("any");
  const [query, setQuery] = useState("");
  const [now, setNow] = useState(() => Date.now());
  /**
   * 入场 stagger 只服务"首次进入页面"：数据首次到达后一帧就把开关关掉，
   * 之后筛选/滚动导致的重新挂载都不再播放入场动画（旧实现每次重挂都飞入一次）。
   */
  const [entranceEnabled, setEntranceEnabled] = useState(true);
  /** 折叠的分组：只影响展示，计数与分组头始终保留 */
  const [collapsed, setCollapsed] = useState<ReadonlySet<SectionKey>>(() => new Set());

  const [editorState, setEditorState] = useState<{ mode: "create" } | { mode: "edit"; task: Task }>(
    { mode: "create" },
  );
  const [editorOpen, setEditorOpen] = useState(false);
  const [actionTask, setActionTask] = useState<Task | null>(null);
  const [actionOpen, setActionOpen] = useState(false);
  /** 删除统一走确认弹层：列表滑删 / 动作表删除 / 详情删除语义一致 */
  const [deleteTarget, setDeleteTarget] = useState<Task | null>(null);
  const [deleting, setDeleting] = useState(false);
  const searchRef = useRef<ComponentRef<typeof TextInput> | null>(null);
  const refreshSeq = useRef(0);
  const mounted = useRef(true);
  const entranceDone = useRef(false);

  const { showToast } = useToast();
  // 任务页顶部筛选区在列表内随内容滚动；默认把 Toast 放到底部，避免遮挡分段/日期筛选。
  useToastPagePlacement("bottom");

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
        // 首屏入场只播一次：等这一帧真正画出来后再关闭开关，
        // 之后的筛选切换/虚拟列表重挂载都不会再让整列任务重新"飞入"。
        if (!entranceDone.current) {
          entranceDone.current = true;
          requestAnimationFrame(() => {
            if (mounted.current) setEntranceEnabled(false);
          });
        }
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
    async (task: Task, placement: ToastPlacement = "bottom") => {
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

  /** 先确认再删除：列表滑删与动作表删除共用同一个入口，不再出现"一处直接删一处要确认" */
  const requestDelete = useCallback((task: Task) => {
    setActionOpen(false);
    setDeleteTarget(task);
  }, []);

  const handleDelete = useCallback(async () => {
    const task = deleteTarget;
    if (!task) return;
    setDeleting(true);
    try {
      await deleteTask(task.id);
      await cancelReminder(task.id);
      showToast("任务已删除", "info", "bottom");
      setDeleteTarget(null);
    } catch (error) {
      // 失败时保留确认弹层，用户可以直接重试或取消
      showToast(`删除失败：${describeError(error)}`, "danger", "bottom");
    } finally {
      if (mounted.current) setDeleting(false);
    }
    // 任务数据变了：小组件快照随后台去抖刷新（内部去重，连续操作只推一次）
    notifyWidgetDataChanged();
    await refresh(true);
  }, [deleteTarget, refresh, showToast]);

  const handleOpenActions = useCallback((task: Task) => {
    setActionTask(task);
    setActionOpen(true);
  }, []);

  /**
   * 新建任务：数据库写入与通知排期严格分开。
   * 旧实现把 scheduleReminder 也包在同一个 try 里——通知权限/排期失败会被当成"保存失败"，
   * 用户重试就会创建出重复任务。现在只有写库失败才算失败。
   */
  const handleCreate = useCallback(
    async (input: NewTaskInput): Promise<TaskSubmitOutcome> => {
      let task: Task;
      try {
        task = await createTask(input);
      } catch (error) {
        return { ok: false, message: describeError(error) };
      }

      let notice: string | undefined;
      if (input.remindAt != null) {
        try {
          const snooze = (await getSetting(SNOOZE_SETTING_KEY)) !== "0";
          const scheduled = await scheduleReminder(task.id, task.title, input.remindAt, snooze);
          if (!scheduled) notice = "任务已保存，但提醒未排期：系统通知权限未开启";
        } catch (error) {
          notice = `任务已保存，但提醒排期失败：${describeError(error)}`;
        }
      }

      notifyWidgetDataChanged();
      await refresh(true);
      showToast(notice ?? "任务已添加", notice ? "warn" : "success", "bottom");
      return { ok: true, notice };
    },
    [refresh, showToast],
  );

  const handleUpdate = useCallback(
    async (original: Task, input: NewTaskInput): Promise<TaskSubmitOutcome> => {
      let updated: Task | null;
      try {
        // 三态契约：编辑弹层里选「无」就是显式清空，所以这里一律显式传值，
        // 用 null 表示清空、而不是省略键（省略会被数据层理解为「保持不变」）。
        updated = await updateTask(original.id, {
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
      } catch (error) {
        return { ok: false, message: describeError(error) };
      }

      if (!updated) {
        notifyWidgetDataChanged();
        await refresh(true);
        return { ok: false, message: "任务已不存在，可能已被删除" };
      }

      // 数据已落库。提醒重建失败同样不能回滚成"更新失败"，否则用户会重复提交。
      let notice: string | undefined;
      try {
        await rescheduleAllReminders();
      } catch (error) {
        notice = `任务已保存，但提醒重建失败：${describeError(error)}`;
      }

      notifyWidgetDataChanged();
      await refresh(true);
      showToast(notice ?? "任务已更新", notice ? "warn" : "success", "bottom");
      return { ok: true, notice };
    },
    [refresh, showToast],
  );

  const handleEditorSubmit = useCallback(
    async (input: NewTaskInput): Promise<TaskSubmitOutcome> => {
      if (editorState.mode === "edit") return handleUpdate(editorState.task, input);
      return handleCreate(input);
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
      if (key === "delete") {
        requestDelete(task);
      }
    },
    [actionTask, handleToggle, requestDelete],
  );

  const openCreate = useCallback(() => {
    setEditorState({ mode: "create" });
    setEditorOpen(true);
  }, []);

  /** 轻点任务主体：进入任务详情页；编辑入口在详情页或长按动作表，列表不再直接开编辑弹层 */
  const openDetail = useCallback(
    (task: Task) => {
      nav?.push("task_detail", undefined, undefined, task.id);
    },
    [nav],
  );

  // 首页「新建任务」快捷入口：切到任务栏后直接打开同一个 TaskEditorSheet。
  // 打开一次就通知 Shell 归零；否则页面切走再切回（组件重挂载）会重复消费旧信号。
  const lastCreateSignal = useRef(0);
  useEffect(() => {
    if (!shouldConsumeCreateSignal(openCreateSignal, lastCreateSignal.current)) return;
    lastCreateSignal.current = openCreateSignal;
    openCreate();
    onConsumeCreateSignal?.();
  }, [onConsumeCreateSignal, openCreate, openCreateSignal]);

  /**
   * 首页放大镜 → 聚焦搜索框。
   *
   * 这里不用导航参数，也不用 setTimeout：信号由 Shell 传递、页面消费后归零。
   * 页面从 display:none 变为可见的同一帧里，原生输入框可能还没完成布局，
   * 所以先同步 focus 一次，下一帧再补一次（对齐键盘弹出时机）。
   * 只消费一次，不会在之后每次重渲染时抢焦点。
   */
  const lastSearchSignal = useRef(0);
  useEffect(() => {
    if (!shouldConsumeSignal(focusSearchSignal, lastSearchSignal.current)) return;
    lastSearchSignal.current = focusSearchSignal;
    searchRef.current?.focus();
    requestAnimationFrame(() => {
      if (mounted.current) searchRef.current?.focus();
    });
    onConsumeSearchSignal?.();
  }, [focusSearchSignal, onConsumeSearchSignal]);

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
          // 首屏之后不再入场：筛选切换/虚拟列表重挂载不应该让整列任务重新飞入
          entranceIndex={entranceEnabled ? item.entranceIndex : -1}
          last={item.position === "last" || item.position === "only"}
          onToggle={handleToggle}
          onOpenEditor={openDetail}
          onOpenActions={handleOpenActions}
          onDelete={requestDelete}
        />
      );
    },
    [collapsed, entranceEnabled, handleOpenActions, handleToggle, now, openDetail, requestDelete, toggleSection],
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
    // 输入框常驻：放大镜只负责聚焦，不再控制显示/隐藏，也不清空已有查询。
    // 从其他页面返回时用户正在用的搜索条件必须保留。
    searchRef.current?.focus();
  }, []);

  const listHeader = (
    <View style={styles.header}>
      {/* 范围分段：项目/团队无数据链路，禁用占位不切换；点按给出明确说明 */}
      <SegmentedControl
        options={SCOPE_OPTIONS}
        value={scope}
        onChange={setScope}
        accessibilityLabel="任务范围"
        emphasis="soft"
        size="compact"
        onDisabledPress={(option) => {
          const key = option.value === "project" ? "project" : "team";
          showToast(SCOPE_UNAVAILABLE_COPY[key], "info", "bottom");
        }}
      />

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

      {/* 搜索框常驻在筛选栏下方：不再由右上角放大镜决定是否出现 */}
      <SearchField
        inputRef={searchRef}
        value={query}
        onChangeText={setQuery}
        placeholder="搜索任务标题、标签或备注"
        accessibilityLabel="搜索任务"
      />

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
              accessibilityLabel="聚焦任务搜索框"
              accessibilityHint="输入框常驻在筛选栏下方，这里只是把光标放进去"
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

      {/* 删除确认：与任务详情使用同一个确认弹层，避免两个入口要求不一致 */}
      <ConfirmSheet
        visible={deleteTarget != null}
        title="删除这条任务？"
        message={
          deleteTarget
            ? `「${deleteTarget.title}」会从任务列表移除，本机提醒一并取消。`
            : ""
        }
        confirmLabel="删除任务"
        busy={deleting}
        onConfirm={() => void handleDelete()}
        onRequestClose={() => {
          if (deleting) return;
          setDeleteTarget(null);
        }}
        accessibilityLabel="删除任务确认"
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
