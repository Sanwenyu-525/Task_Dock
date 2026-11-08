// 任务编辑/新建弹层：标题、优先级、截止、提醒四段，全部用相对选项，
// 不引日期选择器依赖。由旧 QuickAddModal 演进而来，新建与编辑共用同一份表单，
// 差异只在「编辑时把原值映射回选项，映射不到就提供『保持原定』」。
import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";

import {
  buildRecurrencePreset,
  describeRecurrence,
  parseRecurrence,
  presetOf,
  serializeRecurrence,
  type RecurrencePreset,
} from "../domain/recurrence";
import { formatDue } from "../domain/taskQuery";
import type { NewTaskInput, Priority, Task } from "../domain/types";
import { useTheme } from "../theme/ThemeProvider";
import { font, radius, space } from "../theme/tokens";

import { BottomSheet } from "./BottomSheet";
import { Chip } from "./Chip";

type DueKey = "none" | "today" | "tomorrow" | "weekend" | "keep";
type RemindKey = "none" | "10m" | "1h" | "tomorrow9" | "keep";
/** custom 规则会被归一化成 keep（保持原定），因此选中态只有预设与 keep */
type RepeatKey = RecurrencePreset | "keep";

/** 选项与真实时间戳允许的匹配误差：小于一分钟时仍认为「就是今天/明天」 */
const MATCH_TOLERANCE_MS = 60_000;

const PRIORITIES: { key: Priority; label: string }[] = [
  { key: 0, label: "无" },
  { key: 1, label: "低" },
  { key: 2, label: "中" },
  { key: 3, label: "高" },
];

const BASE_DUE: { key: DueKey; label: string }[] = [
  { key: "none", label: "无截止" },
  { key: "today", label: "今天" },
  { key: "tomorrow", label: "明天" },
  { key: "weekend", label: "本周末" },
];

const BASE_REMIND: { key: RemindKey; label: string }[] = [
  { key: "none", label: "不提醒" },
  { key: "10m", label: "10 分钟后" },
  { key: "1h", label: "1 小时后" },
  { key: "tomorrow9", label: "明天 9:00" },
];

const BASE_REPEAT: { key: RepeatKey; label: string }[] = [
  { key: "none", label: "不重复" },
  { key: "daily", label: "每天" },
  { key: "weekly", label: "每周" },
  { key: "monthly", label: "每月" },
  { key: "workday", label: "工作日" },
];

/** 当天 23:59：截止只表达「哪一天之前」，不逼用户选具体时分 */
function endOfDay(now: number, dayOffset: number): number {
  const date = new Date(now);
  date.setDate(date.getDate() + dayOffset);
  date.setHours(23, 59, 0, 0);
  return date.getTime();
}

/** 本周末＝最近的周日 23:59；今天就是周日时取今天 */
function endOfWeek(now: number): number {
  const weekday = new Date(now).getDay();
  return endOfDay(now, (7 - weekday) % 7);
}

function tomorrowMorning(now: number): number {
  const date = new Date(now);
  date.setDate(date.getDate() + 1);
  date.setHours(9, 0, 0, 0);
  return date.getTime();
}

function resolveDue(key: DueKey, task: Task | null, now: number): number | null {
  switch (key) {
    case "today":
      return endOfDay(now, 0);
    case "tomorrow":
      return endOfDay(now, 1);
    case "weekend":
      return endOfWeek(now);
    case "keep":
      return task?.dueAt ?? null;
    case "none":
    default:
      return null;
  }
}

function resolveReminder(key: RemindKey, task: Task | null, now: number): number | null {
  switch (key) {
    case "10m":
      return now + 10 * 60_000;
    case "1h":
      return now + 60 * 60_000;
    case "tomorrow9":
      return tomorrowMorning(now);
    case "keep":
      return task?.remindAt ?? null;
    case "none":
    default:
      return null;
  }
}

/** 只在时间戳与选项结果完全一致时才回选该选项，否则提供「保持原定」，避免静默改时间 */
function dueKeyFor(task: Task): DueKey {
  if (task.dueAt == null) return "none";
  const now = Date.now();
  const buckets: { key: DueKey; value: number }[] = [
    { key: "today", value: endOfDay(now, 0) },
    { key: "tomorrow", value: endOfDay(now, 1) },
    { key: "weekend", value: endOfWeek(now) },
  ];
  const matched = buckets.find(
    (bucket) => Math.abs(bucket.value - (task.dueAt ?? 0)) <= MATCH_TOLERANCE_MS,
  );
  return matched?.key ?? "keep";
}

function remindKeyFor(task: Task): RemindKey {
  if (task.remindAt == null) return "none";
  const now = Date.now();
  const buckets: { key: RemindKey; value: number }[] = [
    { key: "10m", value: now + 10 * 60_000 },
    { key: "1h", value: now + 60 * 60_000 },
    { key: "tomorrow9", value: tomorrowMorning(now) },
  ];
  const matched = buckets.find(
    (bucket) => Math.abs(bucket.value - (task.remindAt ?? 0)) <= MATCH_TOLERANCE_MS,
  );
  return matched?.key ?? "keep";
}

function keepDueLabel(task: Task, now: number): string {
  const formatted = formatDue(task.dueAt, now);
  return formatted ? `保持 ${formatted.replace("已过期 · ", "")}` : "保持原定";
}

function keepRemindLabel(task: Task, now: number): string {
  const formatted = formatDue(task.remindAt, now);
  // 提醒时间已过去时 formatDue 会带「已过期」前缀，这里只保留时刻本身
  return formatted ? `保持 ${formatted.replace("已过期 · ", "")}` : "保持原定";
}

export function TaskEditorSheet({
  visible,
  mode,
  task,
  onClose,
  onSubmit,
}: {
  visible: boolean;
  mode: "create" | "edit";
  /** 仅编辑模式使用；新建传 null */
  task: Task | null;
  onClose: () => void;
  onSubmit: (input: NewTaskInput) => void;
}) {
  const { tokens } = useTheme();
  const [title, setTitle] = useState("");
  const [priority, setPriority] = useState<Priority>(0);
  const [dueKey, setDueKey] = useState<DueKey>("none");
  const [remindKey, setRemindKey] = useState<RemindKey>("none");
  const [repeatKey, setRepeatKey] = useState<RepeatKey>("none");

  // 每次打开都按当前任务重算初值；关闭期间不动，避免把用户未保存的输入冲掉
  useEffect(() => {
    if (!visible) return;
    if (mode === "edit" && task) {
      setTitle(task.title);
      setPriority(task.priority);
      setDueKey(dueKeyFor(task));
      setRemindKey(remindKeyFor(task));
      // 重复规则以截止时间为基准（没有截止则用当前），与新建时生成规则的基准一致；
      // 无法被预设精确表达时落到「保持原定」，让选中态与实际规则一致
      const preset = presetOf(parseRecurrence(task.recurrenceRule), task.dueAt ?? Date.now());
      setRepeatKey(preset === "custom" ? "keep" : preset);
      return;
    }
    setTitle("");
    setPriority(0);
    setDueKey("none");
    setRemindKey("none");
    setRepeatKey("none");
  }, [mode, task, visible]);

  // 「保持原定」是否出现取决于原任务能否被四个相对选项精确表达，而不是取决于当前选中项：
  // 否则用户点一下「今天」后原值就再也选不回去了。
  const hasKeepDue = mode === "edit" && task != null && dueKeyFor(task) === "keep";
  const hasKeepRemind = mode === "edit" && task != null && remindKeyFor(task) === "keep";
  // 原规则无法被预设精确表达时，必须留一个「保持原定」，否则用户只改标题就会丢掉重复
  const hasKeepRepeat =
    mode === "edit" &&
    task != null &&
    presetOf(parseRecurrence(task.recurrenceRule), task.dueAt ?? Date.now()) === "custom";

  const dueOptions = useMemo(() => {
    if (!hasKeepDue || !task) return BASE_DUE;
    // 文案里的时间只在打开弹层时格式化一次，不需要逐分钟刷新
    return [...BASE_DUE, { key: "keep" as DueKey, label: keepDueLabel(task, Date.now()) }];
  }, [hasKeepDue, task]);

  const remindOptions = useMemo(() => {
    if (!hasKeepRemind || !task) return BASE_REMIND;
    return [...BASE_REMIND, { key: "keep" as RemindKey, label: keepRemindLabel(task, Date.now()) }];
  }, [hasKeepRemind, task]);

  const repeatOptions = useMemo(() => {
    if (!hasKeepRepeat || !task) return BASE_REPEAT;
    const rule = parseRecurrence(task.recurrenceRule);
    return [
      ...BASE_REPEAT,
      { key: "keep" as RepeatKey, label: rule ? `保持 ${describeRecurrence(rule)}` : "保持原定" },
    ];
  }, [hasKeepRepeat, task]);

  const canSave = title.trim().length > 0;

  const submit = () => {
    const text = title.trim();
    if (!text) return;
    const at = Date.now();
    const editing = mode === "edit" ? task : null;
    let dueAt = resolveDue(dueKey, editing, at);
    // 选了重复却没有截止时间：用今天兜底。否则规则没有基准，完成时只能以「现在」
    // 为起点推算，用户看到的「每周」可能落在与预期不同的星期。
    if (repeatKey !== "none" && repeatKey !== "keep" && dueAt == null) {
      dueAt = endOfDay(at, 0);
    }
    const recurrenceRule =
      repeatKey === "keep"
        ? editing?.recurrenceRule ?? null
        : repeatKey === "none"
          ? null
          : serializeRecurrence(buildRecurrencePreset(repeatKey, dueAt ?? at, at));

    onSubmit({
      title: text,
      priority,
      dueAt,
      remindAt: resolveReminder(remindKey, editing, at),
      recurrenceRule,
      // 编辑时描述必须显式带上，否则三态更新之外的路径会把它清空
      description: editing ? editing.description : undefined,
    });
    onClose();
  };

  return (
    <BottomSheet
      visible={visible}
      onRequestClose={onClose}
      keyboardAware
      maxHeightRatio={0.88}
      accessibilityLabel={mode === "edit" ? "编辑任务" : "新建任务"}
    >
      {/* 操作按钮放顶部：Android 上键盘弹出后底部按钮会被完全遮挡（真机实测） */}
      <View style={styles.headerRow}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="取消"
          onPress={onClose}
          hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}
          style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
        >
          <Text style={[styles.headerAction, { color: tokens.muted }]}>取消</Text>
        </Pressable>
        <Text style={[styles.heading, { color: tokens.text }]}>
          {mode === "edit" ? "编辑任务" : "新建任务"}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={mode === "edit" ? "保存修改" : "保存任务"}
          accessibilityState={{ disabled: !canSave }}
          disabled={!canSave}
          onPress={submit}
          hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}
          style={({ pressed }) => ({ opacity: !canSave ? 0.45 : pressed ? 0.6 : 1 })}
        >
          <Text
            style={[
              styles.headerAction,
              styles.headerActionPrimary,
              { color: canSave ? tokens.accent : tokens.muted },
            ]}
          >
            保存
          </Text>
        </Pressable>
      </View>

      <ScrollView
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.body}
      >
        <TextInput
          accessibilityLabel="任务标题"
          value={title}
          onChangeText={setTitle}
          placeholder="要做什么？"
          placeholderTextColor={tokens.muted}
          autoFocus={mode === "create"}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="done"
          onSubmitEditing={submit}
          style={[
            styles.input,
            {
              color: tokens.text,
              backgroundColor: tokens.bgAccent,
              borderColor: tokens.cardBorder,
            },
          ]}
        />

        <Text style={[styles.section, { color: tokens.muted }]}>优先级</Text>
        <View style={styles.row}>
          {PRIORITIES.map((item) => (
            <Chip
              key={item.key}
              label={item.label}
              active={priority === item.key}
              accessibilityLabel={`优先级 ${item.label}`}
              onPress={() => setPriority(item.key)}
            />
          ))}
        </View>

        <Text style={[styles.section, { color: tokens.muted }]}>截止时间</Text>
        <View style={styles.row}>
          {dueOptions.map((item) => (
            <Chip
              key={item.key}
              label={item.label}
              active={dueKey === item.key}
              accessibilityLabel={`截止 ${item.label}`}
              onPress={() => setDueKey(item.key)}
            />
          ))}
        </View>

        <Text style={[styles.section, { color: tokens.muted }]}>重复</Text>
        <View style={styles.row}>
          {repeatOptions.map((item) => (
            <Chip
              key={item.key}
              label={item.label}
              active={repeatKey === item.key}
              accessibilityLabel={`重复 ${item.label}`}
              onPress={() => setRepeatKey(item.key)}
            />
          ))}
        </View>
        <Text style={[styles.note, { color: tokens.muted }]}>
          重复任务点完成时不会进入「已完成」，而是把截止时间推进到下一期（与桌面端一致）。
        </Text>

        <Text style={[styles.section, { color: tokens.muted }]}>提醒</Text>
        <View style={styles.row}>
          {remindOptions.map((item) => (
            <Chip
              key={item.key}
              label={item.label}
              active={remindKey === item.key}
              accessibilityLabel={`提醒 ${item.label}`}
              onPress={() => setRemindKey(item.key)}
            />
          ))}
        </View>
        <Text style={[styles.note, { color: tokens.muted }]}>
          提醒依赖系统通知权限，未授权时任务仍会保存，只是到点不会弹通知。
        </Text>
      </ScrollView>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingBottom: space.sm,
  },
  heading: {
    fontSize: 17,
    fontWeight: "700",
  },
  headerAction: {
    fontSize: font.title,
  },
  headerActionPrimary: {
    fontWeight: "700",
  },
  body: {
    gap: space.sm,
    paddingBottom: space.sm,
  },
  input: {
    borderRadius: radius.control,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    fontSize: font.title,
    minHeight: 46,
  },
  section: {
    fontSize: font.label,
    fontWeight: "600",
    letterSpacing: 0.2,
    marginTop: space.sm,
  },
  row: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: space.sm,
  },
  note: {
    fontSize: font.label,
    lineHeight: 16,
    marginTop: space.xs,
  },
});
