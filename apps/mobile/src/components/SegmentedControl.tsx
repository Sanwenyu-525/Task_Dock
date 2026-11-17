// 通用分段控件：选中块会滑动到目标位置，避免切换主题时整块闪烁。
// 选项内容由调用方渲染（设置页用它放主题预览），组件只负责轨道、指示器与无障碍语义。
//
// 2026-11-17 整改：指示器从 spring 改为定长 easing——任务页快速连续切换筛选时，
// 弹簧回弹会让整块列表跟着"晃一下"，是筛选闪动的来源之一。
// 未接入分段不再被 React Native 的 disabled 吞掉点击，而是回调 onDisabledPress，
// 由页面给出「暂未开放」的明确说明（旧实现点上去毫无反馈）。
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Animated, Easing, Pressable, StyleSheet, Text, View } from "react-native";

import { useReduceMotion } from "../theme/MotionProvider";
import { useTheme } from "../theme/ThemeProvider";
import { font, radius, space } from "../theme/tokens";

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  /** 未接入的分段：占位但不可选中（不切换、不响应点击，读屏标记 disabled） */
  disabled?: boolean;
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  renderSegment,
  accessibilityLabel,
  emphasis = "soft",
  size = "regular",
  onDisabledPress,
}: {
  options: SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  renderSegment?: (option: SegmentOption<T>, selected: boolean) => ReactNode;
  accessibilityLabel: string;
  /** soft = 白底胶囊 + 蓝字（设置页）；accent = 蓝底白字（工作区/任务分段） */
  emphasis?: "soft" | "accent";
  /** compact = 一级页面顶部的状态筛选，高度 40dp 左右 */
  size?: "regular" | "compact";
  /**
   * 未接入分段被点击时的反馈。提供后该分段仍可被点按（但不切换），
   * 由页面 toast/说明告诉用户"为什么点了没反应"，而不是静默无响应。
   */
  onDisabledPress?: (option: SegmentOption<T>) => void;
}) {
  const { tokens } = useTheme();
  const reduceMotion = useReduceMotion();
  const [trackWidth, setTrackWidth] = useState(0);
  const compact = size === "compact";
  const padding = compact ? 3 : space.xs;
  const index = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  const position = useRef(new Animated.Value(index)).current;

  useEffect(() => {
    if (reduceMotion) {
      position.setValue(index);
      return;
    }
    // 定长过渡而不是弹簧：连续快速切换时不会出现回弹/过冲，列表不会跟着"晃"
    const animation = Animated.timing(position, {
      toValue: index,
      duration: 180,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [index, position, reduceMotion]);

  const innerWidth = Math.max(0, trackWidth - padding * 2);
  const segmentWidth = options.length > 0 ? innerWidth / options.length : 0;

  const indicatorStyle = useMemo(
    () => ({
      width: segmentWidth,
      transform: [{ translateX: Animated.multiply(position, segmentWidth) }],
    }),
    [position, segmentWidth],
  );

  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={accessibilityLabel}
      onLayout={(event) => setTrackWidth(event.nativeEvent.layout.width)}
      style={[
        styles.track,
        {
          backgroundColor: tokens.track,
          borderColor: tokens.cardBorder,
          padding,
          borderRadius: compact ? radius.control : radius.control + 4,
        },
      ]}
    >
      {segmentWidth > 0 ? (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.indicator,
            {
              top: padding,
              bottom: padding,
              left: padding,
              backgroundColor: emphasis === "accent" ? tokens.accentFill : tokens.cardSolid,
              borderColor: emphasis === "accent" ? tokens.accentFill : tokens.accentSoft,
            },
            indicatorStyle,
          ]}
        />
      ) : null}
      {options.map((option) => {
        const disabled = option.disabled === true;
        const selected = !disabled && option.value === value;
        // disabled 不交给 Pressable：RN 会把 disabled 的段落的点击完全吞掉，
        // 用户点「项目任务 / 团队任务」得不到任何反馈。这里改为自己拦截，
        // 保留可聚焦（读屏仍能读出"暂未接入"）并回调 onDisabledPress。
        const blocked = disabled && Boolean(onDisabledPress);
        return (
          <Pressable
            key={option.value}
            accessibilityRole="radio"
            accessibilityLabel={disabled ? `${option.label}，移动端暂未接入` : option.label}
            accessibilityState={{ checked: selected, disabled }}
            accessibilityHint={disabled ? "该功能暂未开放，轻点可查看说明" : undefined}
            disabled={disabled && !onDisabledPress}
            onPress={() => {
              if (disabled) {
                onDisabledPress?.(option);
                return;
              }
              onChange(option.value);
            }}
            hitSlop={compact ? { top: 6, bottom: 6 } : undefined}
            style={({ pressed }) => [
              styles.segment,
              compact ? styles.segmentCompact : null,
              { opacity: blocked && pressed ? 0.55 : 1 },
            ]}
          >
            {renderSegment ? (
              renderSegment(option, selected)
            ) : (
              <Text
                numberOfLines={1}
                // 320dp + 1.5 倍字号下，「项目任务 / 团队任务」这类 4 字分段会被裁切；
                // 允许在必要时等比缩小（最低 0.8），保证文案完整可读而不是被截断。
                adjustsFontSizeToFit
                minimumFontScale={0.8}
                style={[
                  styles.label,
                  compact ? styles.labelCompact : null,
                  {
                    color: disabled
                      ? tokens.faint
                      : selected
                        ? emphasis === "accent"
                          ? tokens.onAccent
                          : tokens.accent
                        : tokens.muted,
                  },
                  selected ? styles.labelActive : null,
                  // 未接入分段再降一档不透明度：与正常可用的分段在视觉上拉开差距，
                  // 不只靠颜色，避免"看起来能点"的误解
                  disabled ? styles.labelDisabled : null,
                ]}
              >
                {option.label}
              </Text>
            )}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    flexDirection: "row",
    padding: space.xs,
    borderRadius: radius.control + 4,
    borderWidth: StyleSheet.hairlineWidth,
  },
  indicator: {
    position: "absolute",
    borderRadius: radius.control,
    borderWidth: 1,
  },
  segment: {
    flex: 1,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: space.xs,
    paddingVertical: space.xs,
  },
  segmentCompact: {
    minHeight: 32,
    paddingVertical: 2,
  },
  label: {
    fontSize: font.meta,
    fontWeight: "600",
  },
  labelCompact: {
    fontSize: font.meta,
  },
  labelActive: {
    fontWeight: "700",
  },
  labelDisabled: {
    opacity: 0.62,
  },
});
