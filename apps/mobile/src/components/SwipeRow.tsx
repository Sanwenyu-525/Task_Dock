// 滑删容器：卡片向左或向右拖出，对应一侧露出红色删除底，松手按位移/速度吸附开合。
// 双向都支持是为了兼顾「右滑删除」的直觉与常见的「左滑露出右侧操作」，同时避开
// 安卓边缘返回手势区域——手势从卡片内部开始，不依赖屏幕边缘。
//
// 为什么红底放在卡片「下面」且卡片用不透明合成色：卡片本身是半透明的，红底若和
// 卡片重叠会透出一层粉雾。用 cardSolid（等价于 card 叠在 bg 上的结果）既能完全遮住
// 红底，视觉上又与半透明卡片一致。
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
}: {
  children: (api: SwipeRowApi) => ReactNode;
  onAction: () => void;
  actionLabel: string;
  actionAccessibilityLabel: string;
}) {
  const { tokens } = useTheme();
  const reduceMotion = useReduceMotion();
  const translateX = useRef(new Animated.Value(0)).current;
  const openSideRef = useRef<0 | -1 | 1>(0);
  const startRef = useRef(0);
  // 只用于无障碍状态与红底可点击性，不参与位移计算
  const [openSide, setOpenSide] = useState<0 | -1 | 1>(0);

  const animateTo = useCallback(
    (to: number) => {
      const side: 0 | -1 | 1 = to < 0 ? -1 : to > 0 ? 1 : 0;
      openSideRef.current = side;
      setOpenSide(side);
      if (reduceMotion) {
        translateX.setValue(to);
        return;
      }
      Animated.spring(translateX, {
        toValue: to,
        useNativeDriver: true,
        damping: 26,
        stiffness: 300,
        mass: 0.85,
      }).start();
    },
    [reduceMotion, translateX],
  );

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => false,
        // 只有明确的横向滑动才从子级（Pressable）手里接管，纵向滚动继续交给 FlatList
        onMoveShouldSetPanResponderCapture: (_event, gesture) =>
          Math.abs(gesture.dx) > 10 && Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.6,
        onPanResponderGrant: () => {
          translateX.stopAnimation((value) => {
            startRef.current = value;
          });
        },
        onPanResponderMove: (_event, gesture) => {
          const next = Math.max(
            -ACTION_WIDTH,
            Math.min(ACTION_WIDTH, startRef.current + gesture.dx),
          );
          translateX.setValue(next);
        },
        onPanResponderTerminationRequest: () => false,
        onPanResponderRelease: (_event, gesture) => {
          const offset = startRef.current + gesture.dx;
          const startSide: -1 | 0 | 1 =
            startRef.current === 0 ? 0 : startRef.current < 0 ? -1 : 1;

          if (offset < -ACTION_WIDTH * OPEN_RATIO) {
            animateTo(-ACTION_WIDTH);
            return;
          }
          if (offset > ACTION_WIDTH * OPEN_RATIO) {
            animateTo(ACTION_WIDTH);
            return;
          }
          if (Math.abs(gesture.vx) > 0.5) {
            const direction: -1 | 1 = gesture.vx < 0 ? -1 : 1;
            // 已打开时反向甩动只关闭，不允许一步翻到另一侧
            const target = startSide !== 0 && direction !== startSide ? 0 : direction * ACTION_WIDTH;
            animateTo(target);
            return;
          }
          animateTo(0);
        },
        onPanResponderTerminate: () => animateTo(0),
      }),
    [animateTo, translateX],
  );

  const api = useMemo<SwipeRowApi>(
    () => ({
      close: () => animateTo(0),
      isOpen: () => openSideRef.current !== 0,
    }),
    [animateTo],
  );

  // panel: -1 = 左侧红底（右滑露出），1 = 右侧红底（左滑露出）
  const actionZone = (panel: -1 | 1) => {
    // 与位移方向相反：卡片左移露出右侧红底
    const active = openSide === -panel;
    return (
      <View
        style={[
          styles.actionZone,
          panel === -1 ? styles.actionLeft : styles.actionRight,
          {
            backgroundColor: tokens.dangerFill,
            pointerEvents: active ? "auto" : "none",
          },
        ]}
        importantForAccessibility={active ? "auto" : "no-hide-descendants"}
        accessibilityElementsHidden={!active}
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
      </View>
    );
  };

  return (
    <View style={styles.container}>
      {/* 左右各一块红底，哪一侧滑开就只让那一侧可点、可读 */}
      {actionZone(-1)}
      {actionZone(1)}

      <Animated.View
        style={[
          styles.front,
          {
            backgroundColor: tokens.cardSolid,
            borderColor: tokens.cardBorder,
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
    borderRadius: radius.row,
    // 内容滑出时裁掉超出卡片的部分，红色底才只从两侧露出
    overflow: "hidden",
  },
  actionZone: {
    position: "absolute",
    top: 0,
    bottom: 0,
    width: ACTION_WIDTH,
  },
  actionLeft: {
    left: 0,
  },
  actionRight: {
    right: 0,
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
    borderRadius: radius.row,
    borderWidth: StyleSheet.hairlineWidth,
  },
  highlight: {
    position: "absolute",
    top: 0,
    left: 12,
    right: 12,
    height: StyleSheet.hairlineWidth,
  },
});
