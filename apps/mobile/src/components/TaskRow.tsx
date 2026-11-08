// 任务行：完成态用「勾选弹入 + 标题删除线渐显 + 文字变弱」表达，不做瞬间切换；
// 向左滑出即露出红色删除底，长按打开动作表。行内容与动画都留在本组件内，
// 列表只负责给数据与回调，避免父级每次刷新都重建行组件。
import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import { Animated, Pressable, StyleSheet, Text, View } from "react-native";

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
  const due = formatDue(task.dueAt, now);
  const overdue = !done && task.dueAt != null && task.dueAt < now;
  const priorityColor =
    task.priority >= 3 ? tokens.danger : task.priority === 2 ? tokens.warn : tokens.muted;

  const enter = useRef(
    new Animated.Value(reduceMotion || entranceIndex > STAGGER_LIMIT ? 1 : 0),
  ).current;
  const appeared = useRef(false);
  const progress = useRef(new Animated.Value(done ? 1 : 0)).current;
  const pop = useRef(new Animated.Value(1)).current;

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

  useEffect(() => {
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
    if (!done) {
      pop.setValue(1);
      return () => fade.stop();
    }
    // 勾选弹入：从略小回弹到原尺寸，只在这一刻播放，恢复待办时不回弹
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
        outputRange: [tokens.faint, tokens.ok],
      }),
    [progress, tokens.faint, tokens.ok],
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
  const titleColor = useMemo(
    () =>
      progress.interpolate({
        inputRange: [0, 1],
        outputRange: [tokens.text, tokens.muted],
      }),
    [progress, tokens.muted, tokens.text],
  );

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
                ? "轻点恢复为待办，长按打开更多操作，向左滑动可删除"
                : "轻点标记完成，长按打开更多操作，向左滑动可删除"
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
                <Animated.Text style={[styles.checkMark, markStyle]}>✓</Animated.Text>
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
    color: "#FFFFFF",
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
  },
  title: {
    fontSize: font.title,
    fontWeight: "500",
    lineHeight: 21,
  },
  strike: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
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
