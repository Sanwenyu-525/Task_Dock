// 任务详情（A 组新增）：只展示本机 tasks 表的真实字段，不造进度百分比、负责人或所属项目。
//
// 数据边界：
// - 状态、优先级、分类、标签、截止/提醒、重复规则、创建/更新时间、描述、附件全部来自本机；
// - 数据库没有 progress 字段，页面不显示完成度百分比，只用状态与截止信息表达；
// - 附件按 ownerEntity="task" / ownerId 查询，没有附件时不渲染该区块；
// - 完成/恢复、编辑、删除走 db/taskUpdate 与 db/tasks 的真实接口；写操作后回调
//   onDataChanged 通知 Shell 刷新列表与小组件快照。
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { AppBar } from "../components/AppBar";
import { AttachmentStrip } from "../components/AttachmentStrip";
import { ClampedText } from "../components/ClampedText";
import { ConfirmSheet } from "../components/ConfirmSheet";
import { GlassCard } from "../components/GlassCard";
import { AppIcon, type IconName } from "../components/icons/AppIcon";
import { PressableScale } from "../components/PressableScale";
import { TaskEditorSheet, type TaskSubmitOutcome } from "../components/TaskEditorSheet";
import { useToast } from "../feedback/ToastProvider";
import { getSetting } from "../db/kv";
import { deleteTask, getTask, toggleTask, updateTask } from "../db/tasks";
import { formatDue } from "../domain/taskQuery";
import { describeRecurrence, parseRecurrence } from "../domain/recurrence";
import type { NewTaskInput, Priority, Task } from "../domain/types";
import { describeError } from "../lib/errors";
import type { Nav } from "../lib/nav";
import { notifyWidgetDataChanged } from "../lib/widgetSnapshot";
import { useWindowInsets } from "../lib/insets";
import { rescheduleAllReminders, SNOOZE_SETTING_KEY } from "../notifications/reminderEngine";
import { cancelReminder, scheduleReminder } from "../notifications/reminders";
import { useTheme } from "../theme/ThemeProvider";
import { font, radius, space } from "../theme/tokens";

const PRIORITY_LABEL: Record<Priority, string> = {
  0: "无",
  1: "低",
  2: "中",
  3: "高",
};

/** 完整日期时间：列表摘要用相对时间，详情页需要可读的绝对时刻 */
function formatDateTime(ms: number | null): string {
  if (ms == null || Number.isNaN(ms)) return "—";
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function TaskDetailScreen({
  taskId,
  nav,
  onDataChanged,
}: {
  taskId: string;
  nav: Nav;
  onDataChanged: () => void;
}) {
  const { tokens } = useTheme();
  const insets = useWindowInsets();

  const [task, setTask] = useState<Task | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);

  const { showToast } = useToast();

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    if (!taskId) {
      setLoading(false);
      setError("缺少有效的任务 id，无法打开详情。");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const next = await getTask(taskId);
      if (!mounted.current) return;
      setTask(next);
      if (!next) setError("这条任务不存在或已被删除。");
    } catch (reason) {
      if (!mounted.current) return;
      setError(describeError(reason));
    } finally {
      if (!mounted.current) return;
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleToggle = useCallback(async () => {
    if (!task || busy) return;
    setBusy(true);
    try {
      const outcome = await toggleTask(task.id);
      if (!outcome.task) {
        // 任务在切换前已被删除：详情页不能继续展示旧数据
        showToast("任务已不存在", "danger", "bottom");
        nav.back();
        return;
      }

      // 数据库已经给出更新后的任务（期次推进时含新的 dueAt / remindAt），
      // 必须立刻写回详情页；旧实现只弹 toast 不更新 state，详情会一直显示上一期日期。
      setTask(outcome.task);

      // 提醒排期是派生副作用：它失败不能把已经成功的完成操作说成失败。
      try {
        if (outcome.advanced) {
          // 期次推进后提醒时间变了：重建排期（引擎按 (task_id, occurrence) 幂等）
          await rescheduleAllReminders();
          const nextDue = formatDue(outcome.advanced.toDueAt, Date.now());
          showToast(nextDue ? `已完成本期，下次 ${nextDue}` : "已完成本期", "success", "bottom");
        } else if (outcome.task.status === "completed") {
          await cancelReminder(task.id);
        } else if (outcome.task.remindAt != null && outcome.task.remindAt > Date.now()) {
          const snooze = (await getSetting(SNOOZE_SETTING_KEY)) !== "0";
          await scheduleReminder(task.id, outcome.task.title, outcome.task.remindAt, snooze);
        }
      } catch (reason) {
        showToast(
          `任务状态已更新，但提醒排期失败：${describeError(reason)}`,
          "warn",
          "bottom",
        );
      }

      notifyWidgetDataChanged();
      onDataChanged();
    } catch (reason) {
      showToast(`操作失败：${describeError(reason)}`, "danger", "bottom");
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [busy, nav, onDataChanged, showToast, task]);

  const handleDelete = useCallback(async () => {
    if (!task || busy) return;
    setBusy(true);
    try {
      await deleteTask(task.id);
      await cancelReminder(task.id);
      notifyWidgetDataChanged();
      onDataChanged();
      showToast("任务已删除", "info", "bottom");
      nav.back();
    } catch (reason) {
      showToast(`删除失败：${describeError(reason)}`, "danger", "bottom");
      if (mounted.current) setBusy(false);
    }
  }, [busy, nav, onDataChanged, showToast, task]);

  const handleEditSubmit = useCallback(
    async (input: NewTaskInput): Promise<TaskSubmitOutcome> => {
      if (!task) return { ok: false, message: "任务已不存在" };
      let updated: Task | null;
      try {
        // 三态契约：category 不由编辑弹层提供，这里不传该键（省略=不改），
        // 避免把既有分类误清空；tags/description 按既有列表页同款补丁显式给出。
        updated = await updateTask(task.id, {
          title: input.title,
          description: input.description ?? "",
          priority: input.priority ?? 0,
          dueAt: input.dueAt ?? null,
          remindAt: input.remindAt ?? null,
          advanceMinutes: input.advanceMinutes ?? null,
          tags: input.tags ?? null,
          ...(input.recurrenceRule !== undefined
            ? { recurrenceRule: input.recurrenceRule }
            : {}),
        });
      } catch (reason) {
        // 数据没写进去：弹层保持打开，用户输入原样保留
        return { ok: false, message: describeError(reason) };
      }

      if (!updated) {
        showToast("任务已不存在", "danger", "bottom");
        await load();
        return { ok: false, message: "任务已不存在，可能已被删除" };
      }

      // 数据已落库：先更新页面，再处理派生的提醒排期
      setTask(updated);
      notifyWidgetDataChanged();
      onDataChanged();

      let notice: string | undefined;
      try {
        await rescheduleAllReminders();
      } catch (reason) {
        notice = `任务已保存，但提醒重建失败：${describeError(reason)}`;
      }
      showToast(notice ?? "任务已更新", notice ? "warn" : "success", "bottom");
      // 关闭弹层由 TaskEditorSheet 在 ok=true 时统一执行，避免"失败也关"
      return { ok: true, notice };
    },
    [load, onDataChanged, showToast, task],
  );

  const now = Date.now();
  const done = task?.status === "completed";
  const recurrence = task ? parseRecurrence(task.recurrenceRule) : null;
  const recurrenceLabel = recurrence ? describeRecurrence(recurrence) : "不重复";

  let reminderLabel: string | null = null;
  if (task?.advanceMinutes != null) {
    reminderLabel = `提前 ${task.advanceMinutes} 分钟提醒`;
  } else if (task?.remindAt != null) {
    reminderLabel = formatDue(task.remindAt, now) ?? "提醒时间已设置";
  }

  return (
    <View style={styles.root}>
      <AppBar title="任务详情" onBack={nav.back} />

      {loading ? (
        <ActivityIndicator style={styles.center} color={tokens.accent} />
      ) : !task ? (
        <View style={styles.center}>
          <GlassCard style={styles.stateCard}>
            <AppIcon name="error" color={tokens.danger} size={32} />
            <Text style={[styles.stateTitle, { color: tokens.text }]}>
              {error ?? "任务不存在或已被删除"}
            </Text>
            <PressableScale
              onPress={() => void load()}
              accessibilityLabel="重试读取任务"
              style={styles.stateActionPress}
              contentStyle={[styles.stateAction, { backgroundColor: tokens.accentFill }]}
            >
              <Text style={[styles.stateActionText, { color: tokens.onAccent }]}>重试</Text>
            </PressableScale>
            <PressableScale
              onPress={nav.back}
              accessibilityLabel="返回任务列表"
              style={styles.stateActionPress}
              contentStyle={[styles.stateActionGhost, { borderColor: tokens.cardBorder }]}
            >
              <Text style={[styles.stateActionGhostText, { color: tokens.text }]}>返回列表</Text>
            </PressableScale>
          </GlassCard>
        </View>
      ) : (
        <>
          <ScrollView
            contentContainerStyle={styles.content}
            showsVerticalScrollIndicator={false}
          >
            {/* 标题 + 状态 */}
            <GlassCard style={styles.titleCard}>
              <View style={styles.titleRow}>
                <Text numberOfLines={3} style={[styles.title, { color: tokens.text }]}>
                  {task.title}
                </Text>
                <View
                  style={[
                    styles.statusPill,
                    {
                      backgroundColor: done ? tokens.okSoft : tokens.accentSoft,
                    },
                  ]}
                >
                  <AppIcon
                    name={done ? "success" : "pending"}
                    color={done ? tokens.ok : tokens.accentText}
                    size={14}
                  />
                  <Text
                    style={[
                      styles.statusText,
                      { color: done ? tokens.ok : tokens.accentText },
                    ]}
                  >
                    {done ? "已完成" : "未完成"}
                  </Text>
                </View>
              </View>
              <View style={styles.metaRow}>
                <View style={[styles.metaChip, { backgroundColor: tokens.track }]}>
                  <Text style={[styles.metaText, { color: tokens.muted }]}>
                    优先级 · {PRIORITY_LABEL[task.priority]}
                  </Text>
                </View>
                {task.tags.map((tag) => (
                  <View key={tag} style={[styles.metaChip, { backgroundColor: tokens.track }]}>
                    <Text numberOfLines={1} style={[styles.metaText, { color: tokens.textSoft }]}>
                      #{tag}
                    </Text>
                  </View>
                ))}
              </View>
            </GlassCard>

            {/* 真实字段明细 */}
            <GlassCard style={styles.infoCard}>
              <InfoRow icon="tag" label="分类" value={task.category ?? "未分类"} />
              <InfoRow
                divider
                icon="clock"
                label="截止时间"
                value={formatDue(task.dueAt, now) ?? "无截止时间"}
              />
              <InfoRow
                divider
                icon="alarm"
                label="提醒"
                value={reminderLabel ?? "不提醒"}
              />
              <InfoRow divider icon="calendarDays" label="重复规则" value={recurrenceLabel} />
              <InfoRow divider icon="info" label="创建时间" value={formatDateTime(task.createdAt)} />
              <InfoRow divider icon="refresh" label="更新时间" value={formatDateTime(task.updatedAt)} />
            </GlassCard>

            {/* 描述正文 */}
            <GlassCard style={styles.descCard}>
              <Text style={[styles.cardLabel, { color: tokens.muted }]}>描述</Text>
              {task.description.trim() ? (
                <ClampedText
                  text={task.description.trim()}
                  maxLines={6}
                  style={[styles.descText, { color: tokens.textSoft }]}
                />
              ) : (
                <Text style={[styles.descEmpty, { color: tokens.muted }]}>没有补充描述。</Text>
              )}
            </GlassCard>

            {/* 附件：按任务归属查询，无附件时组件自身不渲染 */}
            <AttachmentStrip
              ownerEntity="task"
              ownerId={task.id}
              refreshKey={task.rev}
              onChanged={onDataChanged}
            />
          </ScrollView>

          {/* 底部操作区：完成/恢复 + 编辑 + 删除 */}
          <View
            style={[
              styles.actionBar,
              {
                paddingBottom: Math.max(insets.bottom, space.md) + space.sm,
                borderTopColor: tokens.separator,
                backgroundColor: tokens.card,
              },
            ]}
          >
            <PressableScale
              onPress={() => void handleToggle()}
              accessibilityRole="button"
              accessibilityLabel={done ? "恢复为待办" : "标记为完成"}
              disabled={busy}
              style={styles.togglePress}
              contentStyle={[
                styles.toggleButton,
                { backgroundColor: done ? tokens.track : tokens.accentFill },
              ]}
            >
              <AppIcon
                name={done ? "pending" : "success"}
                color={done ? tokens.text : tokens.onAccent}
                size={18}
              />
              <Text
                style={[
                  styles.toggleText,
                  { color: done ? tokens.text : tokens.onAccent },
                ]}
              >
                {done ? "恢复待办" : "标记完成"}
              </Text>
            </PressableScale>

            {/* 图标按钮不铺底色：底色是「内容入口」的记号，动作再染上就会和入口磁贴抢注意力。
                动作只靠图标颜色表达层级，危险动作用 danger 图标色，不铺 dangerSoft 粉底。 */}
            <PressableScale
              onPress={() => setEditorOpen(true)}
              accessibilityRole="button"
              accessibilityLabel="编辑任务"
              accessibilityHint="打开标题、优先级、截止与提醒编辑"
              disabled={busy}
              style={styles.iconActionPress}
              contentStyle={styles.iconAction}
            >
              <AppIcon name="edit" color={tokens.textSoft} size={20} />
            </PressableScale>

            <PressableScale
              onPress={() => setDeleteOpen(true)}
              accessibilityRole="button"
              accessibilityLabel="删除任务"
              accessibilityState={{ disabled: busy }}
              disabled={busy}
              style={styles.iconActionPress}
              contentStyle={styles.iconAction}
            >
              <AppIcon name="delete" color={tokens.danger} size={20} />
            </PressableScale>
          </View>
        </>
      )}

      {/* 删除确认：与任务列表共用同一个确认弹层（ConfirmSheet） */}
      <ConfirmSheet
        visible={deleteOpen}
        title="删除这条任务？"
        message="删除后会从任务列表移除，本机提醒一并取消。"
        confirmLabel="删除任务"
        busy={busy}
        onConfirm={() => void handleDelete()}
        onRequestClose={() => {
          if (busy) return;
          setDeleteOpen(false);
        }}
        accessibilityLabel="删除任务确认"
      />

      <TaskEditorSheet
        visible={editorOpen}
        mode="edit"
        task={task}
        onClose={() => setEditorOpen(false)}
        onSubmit={handleEditSubmit}
      />
    </View>
  );
}

function InfoRow({
  icon,
  label,
  value,
  divider = false,
}: {
  icon: IconName;
  label: string;
  value: string;
  divider?: boolean;
}) {
  const { tokens } = useTheme();
  return (
    <View
      style={[
        styles.infoRow,
        divider ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: tokens.separator } : null,
      ]}
    >
      <AppIcon name={icon} color={tokens.faint} size={16} />
      <Text numberOfLines={1} style={[styles.infoLabel, { color: tokens.muted }]}>
        {label}
      </Text>
      {/* 右侧值统一右对齐：不同长度的值（「未分类」「无截止时间」「2026-11-17 09:30」）
          在视觉上落在同一条基线上；长文本允许换到第三行，但左侧标签宽度固定，不会被挤压 */}
      <Text numberOfLines={3} style={[styles.infoValue, { color: tokens.text }]}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, justifyContent: "center", alignItems: "center", padding: space.lg },
  stateCard: { width: "100%", maxWidth: 360, padding: space.lg, gap: space.md, alignItems: "center" },
  stateTitle: { fontSize: font.title, fontWeight: "600", textAlign: "center", lineHeight: 22 },
  stateActionPress: { width: "100%" },
  stateAction: {
    minHeight: 44,
    justifyContent: "center",
    alignItems: "center",
    borderRadius: radius.chip,
    paddingHorizontal: space.lg,
  },
  stateActionText: { fontSize: font.body, fontWeight: "700" },
  stateActionGhost: {
    minHeight: 44,
    justifyContent: "center",
    alignItems: "center",
    borderRadius: radius.chip,
    paddingHorizontal: space.lg,
    borderWidth: StyleSheet.hairlineWidth,
  },
  stateActionGhostText: { fontSize: font.body, fontWeight: "600" },
  content: {
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: space.xxl,
    gap: space.md,
  },
  titleCard: { padding: space.lg, gap: space.sm + 2 },
  titleRow: { flexDirection: "row", alignItems: "flex-start", gap: space.md },
  title: { flex: 1, fontSize: font.section, fontWeight: "700", letterSpacing: -0.2, lineHeight: 24 },
  statusPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.xs,
    paddingHorizontal: space.sm,
    paddingVertical: 4,
    borderRadius: radius.chip,
  },
  statusText: { fontSize: font.label, fontWeight: "700" },
  metaRow: { flexDirection: "row", flexWrap: "wrap", gap: space.xs },
  metaChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: space.sm,
    paddingVertical: 3,
    borderRadius: radius.chip,
  },
  metaText: { fontSize: font.label, fontWeight: "600" },
  infoCard: { paddingHorizontal: space.lg, paddingVertical: space.xs },
  infoRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    minHeight: 46,
  },
  infoLabel: { width: 76, fontSize: font.meta },
  infoValue: {
    flex: 1,
    fontSize: font.body,
    fontWeight: "600",
    lineHeight: 20,
    // 右对齐 + 靠右收口：值长度不同也不会参差，长文本在右侧自然换行
    textAlign: "right",
    flexShrink: 1,
  },
  descCard: { padding: space.lg, gap: space.xs },
  cardLabel: { fontSize: font.meta, fontWeight: "600" },
  descText: { fontSize: font.reading, lineHeight: 23 },
  descEmpty: { fontSize: font.meta, lineHeight: 20 },
  actionBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingTop: space.sm + 2,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  togglePress: { flex: 1 },
  toggleButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: space.sm,
    minHeight: 48,
    borderRadius: radius.row,
    paddingHorizontal: space.md,
  },
  toggleText: { fontSize: font.body, fontWeight: "700" },
  iconActionPress: {},
  iconAction: {
    width: 48,
    height: 48,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.row,
  },
  sheetTitle: { fontSize: font.title, fontWeight: "700", paddingBottom: space.xs },
  sheetBody: { fontSize: font.meta, lineHeight: 19, paddingBottom: space.md },
  sheetActions: { flexDirection: "row", gap: space.sm },
  sheetCancelPress: { flex: 1 },
  sheetCancel: {
    minHeight: 48,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.row,
  },
  sheetCancelText: { fontSize: font.body, fontWeight: "600" },
  sheetDeletePress: { flex: 1 },
  sheetDelete: {
    minHeight: 48,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.row,
  },
  sheetDeleteText: { fontSize: font.body, fontWeight: "700" },
});
