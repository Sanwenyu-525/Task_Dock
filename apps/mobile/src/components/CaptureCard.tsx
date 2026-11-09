// 收集箱卡片：内容为主，时间与两个动作收在底部同一行；动作按钮 44dp 命中区。
// 转任务/删除后由父级置 exiting，卡片淡出完成后才通知移除，避免列表「整块闪一下」。
import { memo, useEffect, useMemo, useRef } from "react";
import { Animated, Pressable, StyleSheet, Text, View } from "react-native";

import { formatRelative } from "../domain/taskQuery";
import type { Capture } from "../domain/types";
import { duration, easeOut, useReduceMotion } from "../theme/MotionProvider";
import { useTheme } from "../theme/ThemeProvider";
import { font, space } from "../theme/tokens";

import { GlassCard } from "./GlassCard";

const STAGGER_LIMIT = 8;

function CaptureCardBase({
  capture,
  now,
  exiting,
  entranceIndex,
  onPromote,
  onDelete,
  onExited,
}: {
  capture: Capture;
  now: number;
  exiting: boolean;
  entranceIndex: number;
  onPromote: (capture: Capture) => void;
  onDelete: (capture: Capture) => void;
  onExited: (id: string) => void;
}) {
  const { tokens } = useTheme();
  const reduceMotion = useReduceMotion();
  const enter = useRef(
    new Animated.Value(reduceMotion || entranceIndex > STAGGER_LIMIT ? 1 : 0),
  ).current;
  const exit = useRef(new Animated.Value(0)).current;
  const appeared = useRef(false);

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

  // 入场动画进行中用户开启「减少动态效果」时立刻落定
  useEffect(() => {
    if (!reduceMotion) return;
    enter.stopAnimation();
    enter.setValue(1);
  }, [enter, reduceMotion]);

  useEffect(() => {
    if (!exiting) return;
    if (reduceMotion) {
      onExited(capture.id);
      return;
    }
    const animation = Animated.timing(exit, {
      toValue: 1,
      duration: duration.base,
      easing: easeOut,
      useNativeDriver: true,
    });
    animation.start(({ finished }) => {
      if (finished) onExited(capture.id);
    });
    return () => animation.stop();
  }, [capture.id, exit, exiting, onExited, reduceMotion]);

  // 插值节点只在两个动画值上建一次，避免每分钟刷新相对时间时重建动画图
  const animatedStyle = useMemo(
    () => ({
      opacity: Animated.multiply(
        enter,
        exit.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }),
      ),
      transform: [
        {
          translateY: Animated.add(
            enter.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }),
            exit.interpolate({ inputRange: [0, 1], outputRange: [0, -6] }),
          ),
        },
        { scale: exit.interpolate({ inputRange: [0, 1], outputRange: [1, 0.98] }) },
      ],
    }),
    [enter, exit],
  );

  return (
    <Animated.View style={animatedStyle}>
      <GlassCard style={styles.card}>
        <Text style={[styles.content, { color: tokens.text }]}>{capture.content}</Text>
        <View style={styles.footer}>
          <Text style={[styles.time, { color: tokens.muted }]}>
            {formatRelative(capture.createdAt, now)}
          </Text>
          <View style={styles.actions}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`把「${capture.content}」转为任务`}
              accessibilityHint="转为任务后这条记录会从收集箱移除"
              disabled={exiting}
              onPress={() => onPromote(capture)}
              style={({ pressed }) => [styles.action, { opacity: pressed ? 0.65 : 1 }]}
            >
              <Text style={[styles.actionText, { color: tokens.accent }]}>转任务</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`删除收集「${capture.content}」`}
              disabled={exiting}
              onPress={() => onDelete(capture)}
              style={({ pressed }) => [styles.action, { opacity: pressed ? 0.65 : 1 }]}
            >
              <Text style={[styles.actionText, { color: tokens.danger }]}>删除</Text>
            </Pressable>
          </View>
        </View>
      </GlassCard>
    </Animated.View>
  );
}

export const CaptureCard = memo(CaptureCardBase);

const styles = StyleSheet.create({
  card: {
    padding: space.md,
    gap: space.sm + 2,
  },
  content: {
    fontSize: font.title,
    lineHeight: 21,
  },
  footer: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.sm,
  },
  time: {
    flexShrink: 1,
    fontSize: font.meta,
  },
  actions: {
    flexDirection: "row",
    gap: space.sm,
  },
  action: {
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: space.sm,
  },
  actionText: {
    fontSize: font.meta,
    fontWeight: "600",
  },
});
