// 滑删容器：内容向左拖出，右侧红色删除底色随之露出，松手按位移/速度决定吸附开合。
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
/** 横向位移超过这个比例（或甩动速度够快）就停在打开态 */
const OPEN_RATIO = 0.45;

export interface SwipeRowApi {
  close: () => void;
  isOpen: () => boolean;
}

export function SwipeRow({
  children,
  onAction,
  actionLabel,
  actionAccessibilityLabel,
  disabled = false,
}: {
  children: (api: SwipeRowApi) => ReactNode;
  onAction: () => void;
  actionLabel: string;
  actionAccessibilityLabel: string;
  /** 拖拽进行中（如收集箱输入框聚焦）时禁用，避免与页面手势抢响应 */
  disabled?: boolean;
}) {
  const { tokens } = useTheme();
  const reduceMotion = useReduceMotion();
  const translateX = useRef(new Animated.Value(0)).current;
  const openRef = useRef(false);
  const startRef = useRef(0);
  // 只用于无障碍状态与红底可点击性，不参与位移计算
  const [open, setOpen] = useState(false);

  const animateTo = useCallback(
    (to: number) => {
      const nextOpen = to !== 0;
      openRef.current = nextOpen;
      setOpen(nextOpen);
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
          !disabled && Math.abs(gesture.dx) > 10 && Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.6,
        onPanResponderGrant: () => {
          translateX.stopAnimation((value) => {
            startRef.current = value;
          });
        },
        onPanResponderMove: (_event, gesture) => {
          const next = Math.min(0, Math.max(-ACTION_WIDTH, startRef.current + gesture.dx));
          translateX.setValue(next);
        },
        onPanResponderTerminationRequest: () => false,
        onPanResponderRelease: (_event, gesture) => {
          const offset = startRef.current + gesture.dx;
          const shouldOpen = offset < -ACTION_WIDTH * OPEN_RATIO || gesture.vx < -0.45;
          animateTo(shouldOpen ? -ACTION_WIDTH : 0);
        },
        onPanResponderTerminate: () => animateTo(0),
      }),
    [animateTo, disabled, translateX],
  );

  const api = useMemo<SwipeRowApi>(
    () => ({
      close: () => animateTo(0),
      isOpen: () => openRef.current,
    }),
    [animateTo],
  );

  return (
    <View style={styles.container}>
      <View
        style={[
          styles.actionZone,
          {
            backgroundColor: tokens.dangerFill,
            pointerEvents: open ? "auto" : "none",
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
      </View>

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
        {children(api)}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderRadius: radius.row,
    // 内容滑出时裁掉超出卡片的部分，红色底才只从右侧露出
    overflow: "hidden",
  },
  actionZone: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
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
    borderRadius: radius.row,
    borderWidth: StyleSheet.hairlineWidth,
  },
});
