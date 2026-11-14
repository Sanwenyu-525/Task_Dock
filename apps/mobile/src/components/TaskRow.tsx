// 任务行：完成态用「勾选弹入 + 标题删除线渐显 + 文字变弱」表达，不做瞬间切换。
//
// 交互分区（第三轮整改，防误触）：
//   - 左侧 44dp 勾选热区：只切换完成/恢复，做了什么都看得见；
//   - 行主体：打开已有任务编辑弹层（复用 TaskEditorSheet），不再整行切换完成；
//   - 长按行主体：打开动作表；向左滑动：露出删除。
// 三个热区互不重叠，也不靠 hitSlop 互相侵入，避免「想查看却把任务点完了」。
import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import { Animated, Pressable, StyleSheet, Text, View } from "react-native";

import { describeRecurrence, parseRecurrence } from "../domain/recurrence";
import {
  taskRowAction,
  type TaskRowGesture,
  type TaskRowHit,
} from "../domain/taskRowAction";
import { formatDue } from "../domain/taskQuery";
import type { Task } from "../domain/types";
import { duration, easeOut, useReduceMotion } from "../theme/MotionProvider";
import { useTheme } from "../theme/ThemeProvider";
import { font, space } from "../theme/tokens";

import { Glyph } from "./Glyph";
import { SwipeRow, type SwipeRowApi } from "./SwipeRow";

const PRIORITY_LABEL: Record<number, string> = { 1: "低优先级", 2: "中优先级", 3: "高优先级" };
/** 入场 stagger 只给前 9 行，滚动时新挂载的行不再重复动画 */
const STAGGER_LIMIT = 8;
/** 勾选命中区：44dp 见方，不与行主体重叠 */
const CHECK_HIT = 44;

/** 截止时间前的小时钟：11px 表盘 + 时针/分针，和原型的时间胶囊同一语义 */
function ClockGlyph({ color }: { color: string }) {
  return (
    <View style={styles.clock}>
      <View style={[styles.clockFace, { borderColor: color }]} />
      <View style={[styles.clockHandHour, { backgroundColor: color }]} />
      <View style={[styles.clockHandMinute, { backgroundColor: color }]} />
    </View>
  );
}

function TaskRowBase({
  task,
  now,
  entranceIndex,
  onToggle,
  onOpenEditor,
  onOpenActions,
  onDelete,
}: {
  task: Task;
  now: number;
  entranceIndex: number;
  onToggle: (task: Task) => void;
  /** 轻点行主体：打开同一个 TaskEditorSheet 的编辑态 */
  onOpenEditor: (task: Task) => void;
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

  /** 唯一的路由入口：热区 + 手势 → 动作（契约见 domain/taskRowAction.ts） */
  const handleHit = useCallback(
    (hit: TaskRowHit, gesture: TaskRowGesture, api: SwipeRowApi) => {
      const action = taskRowAction(hit, gesture);
      if (action === "toggle") {
        onToggle(task);
        return;
      }
      // 滑删打开时，第一次点击只负责收起滑层，不跳编辑器/动作表
      if (api.isOpen()) {
        api.close();
        return;
      }
      if (action === "openActions") onOpenActions(task);
      else onOpenEditor(task);
    },
    [onOpenActions, onOpenEditor, onToggle, task],
  );

  return (
    <Animated.View style={enterStyle}>
      <SwipeRow
        onAction={() => onDelete(task)}
        actionLabel="删除"
        actionAccessibilityLabel={`删除任务 ${task.title}`}
        surface={done ? tokens.cardDone : undefined}
      >
        {(api) => (
          <View style={styles.row}>
            {/* 勾选：独立热区，只负责完成/恢复 */}
            <Pressable
              accessibilityRole="checkbox"
              accessibilityLabel={done ? `恢复任务：${task.title}` : `完成任务：${task.title}`}
              accessibilityHint={
                done ? "轻点恢复为待办，不会打开任务内容" : "轻点标记完成，不会打开任务内容"
              }
              accessibilityState={{ checked: done }}
              onPress={() => handleHit("checkbox", "press", api)}
              style={({ pressed }) => [styles.checkHit, { opacity: pressed ? 0.62 : 1 }]}
            >
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
            </Pressable>

            {/* 行主体：打开编辑；长按动作表 */}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`任务：${task.title}${done ? "，已完成" : ""}`}
              accessibilityHint="轻点编辑任务，长按打开更多操作，向左滑动可删除"
              accessibilityActions={[{ name: "longpress", label: "打开任务操作" }]}
              onAccessibilityAction={(event) => {
                if (event.nativeEvent.actionName === "longpress") onOpenActions(task);
              }}
              onPress={() => handleHit("body", "press", api)}
              onLongPress={() => handleHit("body", "longPress", api)}
              delayLongPress={320}
              style={({ pressed }) => [styles.body, { opacity: pressed ? 0.72 : 1 }]}
            >
              <View style={styles.titleRow}>
                {/*
                  删除线直接落在标题上：真机验证过「透明字 + textDecorationColor」的
                  覆盖层在 Fabric 下不画线（decoration 跟随 color 变成透明），
                  于是改为完成态直接给 title 加 decoration，颜色淡入仍由 checkbox 承担。
                */}
                <Animated.Text
                  numberOfLines={2}
                  style={[
                    styles.title,
                    { color: titleColor },
                    done
                      ? { textDecorationLine: "line-through", textDecorationColor: tokens.muted }
                      : null,
                  ]}
                >
                  {task.title}
                </Animated.Text>
                {/* 行主体进编辑：右侧箭头让「不是整行打卡」这件事看得见 */}
                <View style={styles.openHint}>
                  <Glyph name="chevron" color={tokens.faint} size={13} />
                </View>
              </View>

              <View style={styles.meta}>
                {task.priority > 0 ? (
                  <View
                    style={[
                      styles.badge,
                      {
                        backgroundColor:
                          task.priority >= 3
                            ? tokens.dangerSoft
                            : task.priority === 2
                              ? tokens.warnSoft
                              : tokens.track,
                      },
                    ]}
                  >
                    <Text
                      style={[
                        styles.badgeText,
                        { color: task.priority >= 2 ? priorityColor : tokens.muted },
                      ]}
                    >
                      {PRIORITY_LABEL[task.priority] ?? "低优先级"}
                    </Text>
                  </View>
                ) : null}

                {due ? (
                  overdue ? (
                    // 逾期是「需要留意」而不是错误：用与分组头一致的琥珀色，
                    // 红色留给优先级/删除这类真正危险或高优先的语义
                    <View style={[styles.badge, { backgroundColor: tokens.warnSoft }]}>
                      <Text style={[styles.badgeText, { color: tokens.warn }]}>{due}</Text>
                    </View>
                  ) : done ? (
                    // 已完成的行不再强调截止时间，淡化为普通说明文字
                    <Text style={[styles.metaText, { color: tokens.muted }]}>{due}</Text>
                  ) : (
                    // 未完成：截止时间做成蓝底时间胶囊（原型形态），比裸文本更易扫读
                    <View style={[styles.badge, { backgroundColor: tokens.accentSoft }]}>
                      <ClockGlyph color={tokens.accentText} />
                      <Text style={[styles.badgeText, { color: tokens.accentText }]}>{due}</Text>
                    </View>
                  )
                ) : null}

                {repeatLabel ? (
                  <View style={[styles.badge, { backgroundColor: tokens.accentSoft }]}>
                    <Text style={[styles.badgeText, { color: tokens.accentText }]}>
                      重复 · {repeatLabel}
                    </Text>
                  </View>
                ) : null}

                {/* 提醒时间与截止时间相同（旧版新建逻辑会这样写）时不重复展示 */}
                {!done && task.remindAt != null && task.remindAt > now && task.remindAt !== task.dueAt ? (
                  <Text style={[styles.metaText, { color: tokens.muted }]}>
                    提醒 {formatDue(task.remindAt, now)}
                  </Text>
                ) : null}

                {task.tags.slice(0, 2).map((tag) => (
                  <View key={tag} style={[styles.badge, { backgroundColor: tokens.track }]}>
                    <Text numberOfLines={1} style={[styles.badgeText, { color: tokens.textSoft }]}>
                      #{tag}
                    </Text>
                  </View>
                ))}
                {task.tags.length > 2 ? (
                  <Text style={[styles.metaText, { color: tokens.muted }]}>
                    +{task.tags.length - 2}
                  </Text>
                ) : null}
              </View>
            </Pressable>
          </View>
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
    paddingLeft: space.xs,
    paddingRight: space.md,
  },
  checkHit: {
    width: CHECK_HIT,
    height: CHECK_HIT,
    alignItems: "center",
    justifyContent: "center",
  },
  check: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 1.6,
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
    gap: 3,
    paddingTop: 11,
    paddingBottom: space.sm,
    paddingRight: space.xs,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space.xs,
  },
  title: {
    flexShrink: 1,
    fontSize: font.title,
    fontWeight: "600",
    lineHeight: 22,
    maxWidth: "100%",
  },
  openHint: {
    marginLeft: "auto",
    paddingLeft: 2,
    paddingTop: 4,
  },
  meta: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flexWrap: "wrap",
  },
  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 7,
  },
  badgeText: {
    fontSize: font.label,
    fontWeight: "600",
  },
  clock: {
    width: 10,
    height: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  clockFace: {
    width: 10,
    height: 10,
    borderRadius: 5,
    borderWidth: 1.2,
  },
  clockHandHour: {
    position: "absolute",
    left: 4.4,
    top: 2.2,
    width: 1.2,
    height: 3.2,
    borderRadius: 0.6,
  },
  clockHandMinute: {
    position: "absolute",
    left: 5,
    top: 4.4,
    width: 3.2,
    height: 1.2,
    borderRadius: 0.6,
  },
  metaText: {
    fontSize: font.meta,
  },
});
