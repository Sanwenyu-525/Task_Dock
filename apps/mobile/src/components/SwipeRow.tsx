// 滑删容器：卡片向左拖出，右侧露出红色删除底，松手按位移/速度吸附开合。
//
// 三个真机约束决定了实现方式：
// 1. 只保留一个方向。双向滑删会让「露出的是哪一侧」变得不可预期，也让卡片两侧
//    都要做圆角过渡；现在固定为「手指从右往左滑 → 删除按钮在右」。
// 2. 红底不能常驻可见。卡片入场动画是淡入（TaskRow 的 opacity 0→1），红底如果一直
//    挂在卡片下面，淡入过程中会透出来，看起来就是「切页时闪一下删除按钮」。
//    所以红底的透明度跟随 translateX：闭合时 0，越滑越显。
// 3. 打开后卡片右边要变直角。红底的内侧（左边）是直角，卡片右边若还是圆角，
//    两块拼在一起会露出缺口；因此右边两个圆角随开合进度插值到 0。
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { Animated, PanResponder, Pressable, StyleSheet, Text, View } from "react-native";

import { useReduceMotion } from "../theme/MotionProvider";
import { useTheme } from "../theme/ThemeProvider";
import { font, radius, space } from "../theme/tokens";

const ACTION_WIDTH = 88;
/** 横向位移超过这个比例就吸附到打开态 */
const OPEN_RATIO = 0.4;

export interface SwipeRowApi {
  close: () => void;
  isOpen: () => boolean;
}

export function SwipeRow({
  children,
  onAction,
  actionLabel,
  actionAccessibilityLabel,
  surface,
  radii,
  borderEdges,
}: {
  children: (api: SwipeRowApi) => ReactNode;
  onAction: () => void;
  actionLabel: string;
  actionAccessibilityLabel: string;
  /** 卡片表面色：完成态等需要变色时由调用方传入（必须不透明，否则红底会透出来） */
  surface?: string;
  /** 分组列表用：首行顶部直角、末行底部圆角，行与行之间只保留一条 hairline */
  radii?: {
    topLeft?: number;
    topRight?: number;
    bottomLeft?: number;
    bottomRight?: number;
  };
  /** 分组列表用：首行不画顶边，靠分组头衔接 */
  borderEdges?: {
    top?: boolean;
    bottom?: boolean;
    left?: boolean;
    right?: boolean;
  };
}) {
  const { tokens } = useTheme();
  const reduceMotion = useReduceMotion();
  const translateX = useRef(new Animated.Value(0)).current;
  /** 0 = 闭合，1 = 完全打开；只用于右侧圆角插值（JS 驱动） */
  const corner = useRef(new Animated.Value(0)).current;
  const openRef = useRef(false);
  const startRef = useRef(0);
  // 只用于无障碍状态与红底可点击性，不参与位移计算
  const [open, setOpen] = useState(false);
  const topLeft = radii?.topLeft ?? radius.row;
  const topRight = radii?.topRight ?? radius.row;
  const bottomLeft = radii?.bottomLeft ?? radius.row;
  const bottomRight = radii?.bottomRight ?? radius.row;
  const edges = {
    top: borderEdges?.top ?? true,
    bottom: borderEdges?.bottom ?? true,
    left: borderEdges?.left ?? true,
    right: borderEdges?.right ?? true,
  };

  /** 位移与圆角必须同步落值：二者由同一手势偏移推导，避免弹簧与插值各跑一套 */
  const applyOffset = useCallback(
    (value: number) => {
      translateX.setValue(value);
      corner.setValue(Math.min(1, Math.abs(value) / ACTION_WIDTH));
    },
    [corner, translateX],
  );

  const animateTo = useCallback(
    (to: number) => {
      const nextOpen = to < 0;
      openRef.current = nextOpen;
      setOpen(nextOpen);
      if (reduceMotion) {
        applyOffset(to);
        return;
      }
      Animated.parallel([
        Animated.spring(translateX, {
          toValue: to,
          // 必须与 corner 同用 JS 驱动：圆角插值挂在同一个 Animated.View 上，
          // 一旦 translateX 走 native，该节点会被标记为 native，
          // 后续 JS 驱动的圆角动画会直接抛 "moved to native" 并崩溃（真机实测）。
          useNativeDriver: false,
          damping: 26,
          stiffness: 300,
          mass: 0.85,
        }),
        Animated.timing(corner, {
          toValue: nextOpen ? 1 : 0,
          duration: 180,
          useNativeDriver: false,
        }),
      ]).start();
    },
    [applyOffset, corner, reduceMotion, translateX],
  );

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => false,
        // 只有明确的横向滑动才从子级（Pressable）手里接管，纵向滚动继续交给 FlatList。
        // 两个方向都要接管：向右滑虽然不露出删除，但如果放回 Pressable，
        // 松手会被当成一次点击，把任务误标成完成（真机实测）。
        // 位移仍然只有向左一个方向，向右拖动只是被吸收，卡片不动。
        onMoveShouldSetPanResponderCapture: (_event, gesture) =>
          Math.abs(gesture.dx) > 10 && Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.6,
        onPanResponderGrant: () => {
          translateX.stopAnimation((value) => {
            startRef.current = value;
            corner.setValue(Math.min(1, Math.abs(value) / ACTION_WIDTH));
          });
        },
        onPanResponderMove: (_event, gesture) => {
          const next = Math.max(-ACTION_WIDTH, Math.min(0, startRef.current + gesture.dx));
          applyOffset(next);
        },
        onPanResponderTerminationRequest: () => false,
        onPanResponderRelease: (_event, gesture) => {
          const offset = startRef.current + gesture.dx;
          // 甩动优先：向左甩（vx < 0）直接打开，向右甩直接关闭
          if (gesture.vx < -0.5 || (gesture.vx <= 0.5 && offset < -ACTION_WIDTH * OPEN_RATIO)) {
            animateTo(-ACTION_WIDTH);
            return;
          }
          animateTo(0);
        },
        onPanResponderTerminate: () => animateTo(0),
      }),
    [animateTo, applyOffset, corner, translateX],
  );

  const api = useMemo<SwipeRowApi>(
    () => ({
      close: () => animateTo(0),
      isOpen: () => openRef.current,
    }),
    [animateTo],
  );

  // 红底只在滑开时可见：闭合状态 opacity 为 0，卡片淡入时不会再透出红色
  const actionOpacity = useMemo(
    () =>
      translateX.interpolate({
        inputRange: [-ACTION_WIDTH, 0],
        outputRange: [1, 0],
        extrapolate: "clamp",
      }),
    [translateX],
  );

  // 右侧两个圆角随开启进度收成直角：红底左侧是直角，卡片右侧必须接得上
  const topRightRadius = useMemo(
    () => corner.interpolate({ inputRange: [0, 1], outputRange: [topRight, 0] }),
    [corner, topRight],
  );
  const bottomRightRadius = useMemo(
    () => corner.interpolate({ inputRange: [0, 1], outputRange: [bottomRight, 0] }),
    [bottomRight, corner],
  );

  return (
    <View
      style={[
        styles.container,
        {
          backgroundColor: tokens.cardSolid,
          borderTopLeftRadius: topLeft,
          borderTopRightRadius: topRight,
          borderBottomLeftRadius: bottomLeft,
          borderBottomRightRadius: bottomRight,
        },
      ]}
    >
      <Animated.View
        style={[
          styles.actionZone,
          {
            backgroundColor: tokens.dangerFill,
            opacity: actionOpacity,
            pointerEvents: open ? "auto" : "none",
            borderTopRightRadius: topRight,
            borderBottomRightRadius: bottomRight,
          },
        ]}
        importantForAccessibility={open ? "auto" : "no-hide-descendants"}
        accessibilityElementsHidden={!open}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={actionAccessibilityLabel}
          onPress={() => {
            animateTo(0);
            onAction();
          }}
          style={({ pressed }) => [styles.actionPress, { opacity: pressed ? 0.75 : 1 }]}
        >
          <Text style={[styles.actionText, { color: tokens.onDanger }]}>{actionLabel}</Text>
        </Pressable>
      </Animated.View>

      <Animated.View
        style={[
          styles.front,
          {
            backgroundColor: surface ?? tokens.cardSolid,
            borderColor: tokens.cardBorder,
            borderTopWidth: edges.top ? StyleSheet.hairlineWidth : 0,
            borderBottomWidth: edges.bottom ? StyleSheet.hairlineWidth : 0,
            borderLeftWidth: edges.left ? StyleSheet.hairlineWidth : 0,
            borderRightWidth: edges.right ? StyleSheet.hairlineWidth : 0,
            borderTopLeftRadius: topLeft,
            borderBottomLeftRadius: bottomLeft,
            borderTopRightRadius: topRightRadius,
            borderBottomRightRadius: bottomRightRadius,
            transform: [{ translateX }],
          },
        ]}
        {...responder.panHandlers}
      >
        {/* 顶部边光与 GlassCard 一致，让滑删行看起来仍是同一族卡片 */}
        <View
          pointerEvents="none"
          style={[styles.highlight, { backgroundColor: tokens.cardHighlight }]}
        />
        {children(api)}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    // 内容滑出时裁掉超出卡片的部分，红色底才只从右侧露出
    overflow: "hidden",
  },
  // 红底必须比卡片内缩 1dp：卡片描边是半透明的（cardBorder alpha≈0.16），
  // 红底一旦垫在描边正下方就会沿上下边缘透出一条红线（真机实测）。
  actionZone: {
    position: "absolute",
    top: 1,
    bottom: 1,
    right: 1,
    width: ACTION_WIDTH,
  },
  actionPress: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: space.sm,
  },
  actionText: {
    fontSize: font.body,
    fontWeight: "700",
  },
  front: {
    borderStyle: "solid",
  },
  highlight: {
    position: "absolute",
    top: 0,
    left: 12,
    right: 12,
    height: StyleSheet.hairlineWidth,
  },
});
