// 任务行：完成态用「勾选弹入 + 标题删除线渐显 + 文字变弱」表达，不做瞬间切换；
// 左右滑动都露出红色删除底，长按打开动作表。行内容与动画都留在本组件内，
// 列表只负责给数据与回调，避免父级每次刷新都重建行组件。
import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import { Animated, Pressable, StyleSheet, Text, View } from "react-native";

import { describeRecurrence, parseRecurrence } from "../domain/recurrence";
import { formatDue } from "../domain/taskQuery";
import type { Task } from "../domain/types";
import { duration, easeOut, useReduceMotion } from "../theme/MotionProvider";
import { useTheme } from "../theme/ThemeProvider";
import { font, radius, space } from "../theme/tokens";

import { SwipeRow, type SwipeRowApi } from "./SwipeRow";

const PRIORITY_LABEL: Record<number, string> = { 1: "低", 2: "中", 3: "高" };
/** 入场 stagger 只给前 9 行，滚动时新挂载的行不再重复动画 */
const STAGGER_LIMIT = 8;

function TaskRowBase({
  task,
  now,
  entranceIndex,
  onToggle,
  onOpenActions,
  onDelete,
}: {
  task: Task;
  now: number;
  entranceIndex: number;
  onToggle: (task: Task) => void;
  onOpenActions: (task: Task) => void;
  onDelete: (task: Task) => void;
}) {
  const { tokens } = useTheme();
  const reduceMotion = useReduceMotion();
  const done = task.status === "completed";
  const rawDue = formatDue(task.dueAt, now);
  // formatDue 会自己加「已过期 · 」前缀，已完成的任务不该再提示过期，这里把它去掉
  const due = done && rawDue ? rawDue.replace(/^已过期 · /, "") : rawDue;
  const overdue = !done && task.dueAt != null && task.dueAt < now;
  // 重复规则解析失败时不显示徽标：宁可少一行说明，也不给用户看 "undefined"
  const repeatLabel = useMemo(() => {
    const rule = parseRecurrence(task.recurrenceRule);
    return rule ? describeRecurrence(rule) : null;
  }, [task.recurrenceRule]);
  const priorityColor =
    task.priority >= 3 ? tokens.danger : task.priority === 2 ? tokens.warn : tokens.muted;

  const enter = useRef(
    new Animated.Value(reduceMotion || entranceIndex > STAGGER_LIMIT ? 1 : 0),
  ).current;
  const appeared = useRef(false);
  const progress = useRef(new Animated.Value(done ? 1 : 0)).current;
  const pop = useRef(new Animated.Value(1)).current;
  // 记录上一次完成态：只有"从未完成变成完成"才弹入，避免已完成行滚动复用时反复弹跳
  const previousDone = useRef(done);

  // 入场的 delay 由行序号决定；只跑一次，避免父级刷新（每分钟 now 变化）时重播
  useEffect(() => {
    if (appeared.current) return;
    appeared.current = true;
    if (reduceMotion || entranceIndex > STAGGER_LIMIT) {
      enter.setValue(1);
      return;
    }
    const animation = Animated.timing(enter, {
      toValue: 1,
      duration: duration.list,
      delay: entranceIndex * 22,
      easing: easeOut,
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [enter, entranceIndex, reduceMotion]);

  // 入场动画进行中用户开启「减少动态效果」时立刻落定，不能让残留位移继续播放
  useEffect(() => {
    if (!reduceMotion) return;
    enter.stopAnimation();
    enter.setValue(1);
  }, [enter, reduceMotion]);

  useEffect(() => {
    const justCompleted = done && !previousDone.current;
    previousDone.current = done;

    if (reduceMotion) {
      progress.setValue(done ? 1 : 0);
      pop.setValue(1);
      return;
    }
    const fade = Animated.timing(progress, {
      toValue: done ? 1 : 0,
      duration: duration.list,
      easing: easeOut,
      useNativeDriver: false,
    });
    fade.start();
    if (!justCompleted) {
      return () => fade.stop();
    }
    // 勾选弹入：从略小回弹到原尺寸，只在刚完成的那一刻播放
    pop.setValue(0.82);
    const bounce = Animated.spring(pop, {
      toValue: 1,
      useNativeDriver: false,
      damping: 12,
      stiffness: 300,
      mass: 0.6,
    });
    bounce.start();
    return () => {
      fade.stop();
      bounce.stop();
    };
  }, [done, pop, progress, reduceMotion]);

  const enterStyle = useMemo(
    () => ({
      opacity: enter,
      transform: [
        {
          translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }),
        },
      ],
    }),
    [enter],
  );

  const checkBorder = useMemo(
    () =>
      progress.interpolate({
        inputRange: [0, 1],
        outputRange: [tokens.muted, tokens.ok],
      }),
    [progress, tokens.muted, tokens.ok],
  );
  const checkBackground = useMemo(
    () =>
      progress.interpolate({
        inputRange: [0, 1],
        outputRange: ["rgba(0,0,0,0)", tokens.ok],
      }),
    [progress, tokens.ok],
  );
  const markStyle = useMemo(
    () => ({
      opacity: progress,
      transform: [
        { scale: progress.interpolate({ inputRange: [0, 1], outputRange: [0.4, 1] }) },
      ],
    }),
    [progress],
  );
  // 标题颜色按状态直接给静态值：颜色插值在真机（深色主题）上没能落到文字上，
  // 已完成行的标题会退回默认黑、在深色卡片上几乎不可读；删除线仍用 opacity 淡入。
  const titleColor = done ? tokens.muted : tokens.text;

  const handlePress = useCallback(
    (api: SwipeRowApi) => {
      if (api.isOpen()) {
        api.close();
        return;
      }
      onToggle(task);
    },
    [onToggle, task],
  );

  const handleLongPress = useCallback(
    (api: SwipeRowApi) => {
      if (api.isOpen()) {
        api.close();
        return;
      }
      onOpenActions(task);
    },
    [onOpenActions, task],
  );

  return (
    <Animated.View style={enterStyle}>
      <SwipeRow
        onAction={() => onDelete(task)}
        actionLabel="删除"
        actionAccessibilityLabel={`删除任务 ${task.title}`}
      >
        {(api) => (
          <Pressable
            accessibilityRole="checkbox"
            accessibilityLabel={`任务：${task.title}${done ? "，已完成" : ""}`}
            accessibilityHint={
              done
                ? "轻点恢复为待办，长按打开更多操作，左右滑动可删除"
                : "轻点标记完成，长按打开更多操作，左右滑动可删除"
            }
            accessibilityState={{ checked: done }}
            accessibilityActions={[{ name: "longpress", label: "打开任务操作" }]}
            onAccessibilityAction={(event) => {
              if (event.nativeEvent.actionName === "longpress") onOpenActions(task);
            }}
            onPress={() => handlePress(api)}
            onLongPress={() => handleLongPress(api)}
            delayLongPress={320}
            style={({ pressed }) => [styles.row, { opacity: pressed ? 0.72 : 1 }]}
          >
            <View importantForAccessibility="no-hide-descendants" style={styles.checkWrap}>
              <Animated.View
                style={[
                  styles.check,
                  {
                    borderColor: checkBorder,
                    backgroundColor: checkBackground,
                    transform: [{ scale: pop }],
                  },
                ]}
              >
                <Animated.Text style={[styles.checkMark, { color: tokens.onOk }, markStyle]}>
                  ✓
                </Animated.Text>
              </Animated.View>
            </View>

            <View style={styles.body}>
              <View style={styles.titleWrap}>
                <Animated.Text numberOfLines={2} style={[styles.title, { color: titleColor }]}>
                  {task.title}
                </Animated.Text>
                {/*
                  删除线用一层同排版、透明字的文本叠在上面：Text 的 textDecorationLine
                  无法插值，但可以整层淡入，且天然覆盖换行后的每一行。
                */}
                <Animated.Text
                  importantForAccessibility="no"
                  numberOfLines={2}
                  style={[
                    styles.title,
                    styles.strike,
                    { opacity: progress, textDecorationColor: tokens.muted },
                  ]}
                >
                  {task.title}
                </Animated.Text>
              </View>

              <View style={styles.meta}>
                {task.priority > 0 ? (
                  <View style={[styles.badge, { backgroundColor: tokens.track }]}>
                    <View style={[styles.dot, { backgroundColor: priorityColor }]} />
                    <Text style={[styles.badgeText, { color: tokens.muted }]}>
                      {PRIORITY_LABEL[task.priority] ?? "低"}
                    </Text>
                  </View>
                ) : null}

                {due ? (
                  <Text style={[styles.metaText, { color: overdue ? tokens.danger : tokens.muted }]}>
                    {due}
                  </Text>
                ) : null}

                {repeatLabel ? (
                  <Text style={[styles.metaText, { color: tokens.muted }]}>
                    重复 · {repeatLabel}
                  </Text>
                ) : null}

                {/* 提醒时间与截止时间相同（旧版新建逻辑会这样写）时不重复展示 */}
                {!done && task.remindAt != null && task.remindAt > now && task.remindAt !== task.dueAt ? (
                  <Text style={[styles.metaText, { color: tokens.muted }]}>
                    提醒 {formatDue(task.remindAt, now)}
                  </Text>
                ) : null}

                {task.tags.length > 0 ? (
                  <Text
                    numberOfLines={1}
                    style={[styles.metaText, styles.tag, { color: tokens.muted }]}
                  >
                    #{task.tags[0]}
                  </Text>
                ) : null}
              </View>
            </View>
          </Pressable>
        )}
      </SwipeRow>
    </Animated.View>
  );
}

/** 列表项数量可能上千，memo 掉避免父级刷新时全量重渲染 */
export const TaskRow = memo(TaskRowBase);

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space.md,
    paddingHorizontal: space.md,
    paddingVertical: space.md - 1,
  },
  checkWrap: {
    paddingTop: 1,
  },
  check: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "center",
  },
  checkMark: {
    fontSize: 13,
    fontWeight: "700",
    lineHeight: 16,
  },
  body: {
    flex: 1,
    gap: 4,
  },
  titleWrap: {
    position: "relative",
    // 让标题按内容宽度收缩：删除线只划在文字上，而不是整行横线
    alignItems: "flex-start",
  },
  title: {
    fontSize: font.title,
    fontWeight: "500",
    lineHeight: 21,
    maxWidth: "100%",
  },
  strike: {
    position: "absolute",
    top: 0,
    left: 0,
    maxWidth: "100%",
    color: "transparent",
    textDecorationLine: "line-through",
  },
  meta: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    flexWrap: "wrap",
  },
  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: radius.chip,
  },
  dot: {
    width: 5,
    height: 5,
    borderRadius: 3,
  },
  badgeText: {
    fontSize: font.label,
  },
  metaText: {
    fontSize: font.meta,
  },
  tag: {
    flexShrink: 1,
  },
});
