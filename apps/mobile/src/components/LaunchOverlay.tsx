// 冷启动动画：原生启动图是一张「清单骨架」静态图，这里从同一帧开始演：
//   三行任务依次填充 → 首行勾选弹入 → 字标上移 → 数据就绪后整体下沉淡出。
//
// 几何必须与 scripts/gen-splash.mjs 里的常量逐项一致：原生图隐藏时 JS 首帧必须已经
// 画出同样的骨架，否则会看到一次尺寸/位置跳变。改动任何一项都要同步生成脚本并重跑
// `npx expo prebuild --platform android`（原生图才生效）。
import { useCallback, useEffect, useRef, useState } from "react";
import { Animated, StyleSheet, Text, View, useColorScheme } from "react-native";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";

import { duration, easeOut, useReduceMotion } from "../theme/MotionProvider";
import { font, palette } from "../theme/tokens";

// ---- 与 gen-splash.mjs 同步的几何（dp） ----
const PLATE = 80;
const PLATE_RADIUS = 22;
const BORDER = 1;
const DOT = 12;
const DOT_X = 14;
const ROW_CY = [26, 40, 54];
const BAR_X = 31;
const BAR_H = 7;
const BAR_W = [30, 35, 24];

/** 骨架行/点用 muted 叠加透明度，与原生图的合成色对应 */
const TRACK_OPACITY = { light: 0.38, dark: 0.35 };

const ROW_STAGGER = 80;
const CHECK_DELAY = 300;
const WORD_DELAY = 380;
const CAPTION_DELAY = 460;
/** 最短展示时长：动画本身就要 ~560ms，避免开库过快时画面只看半截 */
const MIN_VISIBLE = 640;
const EXIT_DURATION = 180;

export function LaunchOverlay({
  ready,
  onDone,
}: {
  /** 数据与主题已就绪，可以进入主界面 */
  ready: boolean;
  /** 退场动画播完（或减少动效时直接结束）后回调，由调用方卸载本组件 */
  onDone: () => void;
}) {
  const reduceMotion = useReduceMotion();
  const systemScheme = useColorScheme();
  const scheme = systemScheme === "dark" ? "dark" : "light";
  const tokens = palette(scheme);

  // 三个进度值放在同一个 ref 里：数组必须稳定，否则任意一次 setState 都会重启动画
  const rowFills = useRef([
    new Animated.Value(0),
    new Animated.Value(0),
    new Animated.Value(0),
  ]).current;
  const check = useRef(new Animated.Value(0)).current;
  const word = useRef(new Animated.Value(0)).current;
  const caption = useRef(new Animated.Value(0)).current;
  const exit = useRef(new Animated.Value(0)).current;
  const [minElapsed, setMinElapsed] = useState(false);
  const splashHidden = useRef(false);

  // 原生图 → JS 首帧：等一帧再隐藏，保证含骨架的画面已经提交
  const handleLayout = useCallback(() => {
    if (splashHidden.current) return;
    splashHidden.current = true;
    requestAnimationFrame(() => SplashScreen.hide());
  }, []);

  useEffect(() => {
    if (reduceMotion) {
      rowFills.forEach((value) => value.setValue(1));
      check.setValue(1);
      word.setValue(1);
      caption.setValue(1);
      return;
    }

    const animations = [
      ...rowFills.map((value, index) =>
        Animated.timing(value, {
          toValue: 1,
          delay: index * ROW_STAGGER,
          duration: duration.base,
          easing: easeOut,
          useNativeDriver: true,
        }),
      ),
      Animated.spring(check, {
        toValue: 1,
        delay: CHECK_DELAY,
        useNativeDriver: true,
        damping: 14,
        stiffness: 240,
        mass: 0.8,
      }),
      Animated.timing(word, {
        toValue: 1,
        delay: WORD_DELAY,
        duration: 240,
        easing: easeOut,
        useNativeDriver: true,
      }),
      Animated.timing(caption, {
        toValue: 1,
        delay: CAPTION_DELAY,
        duration: 220,
        easing: easeOut,
        useNativeDriver: true,
      }),
    ];
    Animated.parallel(animations).start();
    return () => {
      animations.forEach((animation) => animation.stop());
    };
  }, [caption, check, reduceMotion, rowFills, word]);

  // 最短展示：动画播完前不放行；减少动效时立即放行
  useEffect(() => {
    if (reduceMotion) {
      setMinElapsed(true);
      return;
    }
    const timer = setTimeout(() => setMinElapsed(true), MIN_VISIBLE);
    return () => clearTimeout(timer);
  }, [reduceMotion]);

  useEffect(() => {
    if (!ready || !minElapsed) return;
    if (reduceMotion) {
      onDone();
      return;
    }
    const animation = Animated.timing(exit, {
      toValue: 1,
      duration: EXIT_DURATION,
      easing: easeOut,
      useNativeDriver: true,
    });
    animation.start(({ finished }) => {
      if (finished) onDone();
    });
    return () => animation.stop();
  }, [exit, minElapsed, onDone, ready, reduceMotion]);

  const exitStyle = reduceMotion
    ? null
    : {
        opacity: exit.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }),
        transform: [
          { translateY: exit.interpolate({ inputRange: [0, 1], outputRange: [0, 6] }) },
          { scale: exit.interpolate({ inputRange: [0, 1], outputRange: [1, 0.985] }) },
        ],
      };

  const checkScale = check.interpolate({ inputRange: [0, 1], outputRange: [0.3, 1] });
  const checkRotate = check.interpolate({ inputRange: [0, 1], outputRange: ["-12deg", "0deg"] });

  return (
    <Animated.View
      pointerEvents="none"
      onLayout={handleLayout}
      style={[styles.root, { backgroundColor: tokens.bg }, exitStyle]}
    >
      {ready ? null : <StatusBar style={scheme === "dark" ? "light" : "dark"} />}
      <View style={styles.stage}>
        <View
          style={[
            styles.plate,
            { backgroundColor: tokens.card, borderColor: tokens.cardBorder },
          ]}
        >
          {ROW_CY.map((centerY, index) => {
            const track = (
              <>
                <View
                  style={[
                    styles.trackDot,
                    {
                      left: DOT_X,
                      backgroundColor: tokens.muted,
                      opacity: TRACK_OPACITY[scheme],
                    },
                  ]}
                />
                <View
                  style={[
                    styles.trackBar,
                    {
                      left: BAR_X,
                      width: BAR_W[index],
                      backgroundColor: tokens.muted,
                      opacity: TRACK_OPACITY[scheme],
                    },
                  ]}
                />
              </>
            );
            const fillColor = index === 0 ? tokens.accentFill : tokens.textSoft;

            return (
              <View key={index} style={[styles.row, { top: centerY - DOT / 2 }]}>
                {track}
                <Animated.View
                  style={[
                    styles.fillBar,
                    {
                      left: BAR_X,
                      width: BAR_W[index],
                      backgroundColor: fillColor,
                      transform: [
                        {
                          // scaleX 默认绕中心缩放，补一段位移把左端锚定
                          translateX: rowFills[index].interpolate({
                            inputRange: [0, 1],
                            outputRange: [-BAR_W[index] / 2, 0],
                          }),
                        },
                        { scaleX: rowFills[index] },
                      ],
                    },
                  ]}
                />
                {index === 0 ? (
                  <Animated.View
                    style={[
                      styles.checkDot,
                      {
                        left: DOT_X,
                        backgroundColor: tokens.accentFill,
                        opacity: check,
                        transform: [{ scale: checkScale }, { rotate: checkRotate }],
                      },
                    ]}
                  >
                    <View
                      style={[styles.checkShort, { backgroundColor: tokens.onAccent }]}
                    />
                    <View
                      style={[styles.checkLong, { backgroundColor: tokens.onAccent }]}
                    />
                  </Animated.View>
                ) : null}
              </View>
            );
          })}
        </View>

        <Animated.View
          style={[
            styles.words,
            {
              opacity: word,
              transform: [
                { translateY: word.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }) },
              ],
            },
          ]}
        >
          <Text style={[styles.wordmark, { color: tokens.text }]}>TaskDock</Text>
          <Animated.Text style={[styles.caption, { color: tokens.muted, opacity: caption }]}>
            正在打开本地数据…
          </Animated.Text>
        </Animated.View>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
    // TabBar 带 elevation，会从启动层背景里“浮”出来；启动层必须压过它。
    // 全屏视图的 elevation 阴影落在屏幕外，不会产生可见投影。
    zIndex: 1000,
    elevation: 1000,
  },
  // 只占骨架大小：字标绝对定位在下方，保证骨架中心始终在屏幕中心，
  // 与原生启动图（居中的一张图）完全重合。
  stage: {
    width: PLATE,
    height: PLATE,
  },
  plate: {
    width: PLATE,
    height: PLATE,
    borderRadius: PLATE_RADIUS,
    borderWidth: BORDER,
  },
  row: {
    position: "absolute",
    left: 0,
    right: 0,
    height: DOT,
  },
  trackDot: {
    position: "absolute",
    top: 0,
    width: DOT,
    height: DOT,
    borderRadius: DOT / 2,
  },
  trackBar: {
    position: "absolute",
    top: (DOT - BAR_H) / 2,
    height: BAR_H,
    borderRadius: BAR_H / 2,
  },
  fillBar: {
    position: "absolute",
    top: (DOT - BAR_H) / 2,
    height: BAR_H,
    borderRadius: BAR_H / 2,
  },
  checkDot: {
    position: "absolute",
    top: 0,
    width: DOT,
    height: DOT,
    borderRadius: DOT / 2,
    alignItems: "center",
    justifyContent: "center",
  },
  // 勾选符号：两根圆头短杆拼成，避免 Unicode 字形在不同 ROM 上渲染不一致
  checkShort: {
    position: "absolute",
    left: 2.8,
    top: 6.45,
    width: 2.9,
    height: 1.9,
    borderRadius: 0.95,
    transform: [{ rotate: "43.6deg" }],
  },
  checkLong: {
    position: "absolute",
    left: 4.16,
    top: 5.15,
    width: 5.78,
    height: 1.9,
    borderRadius: 0.95,
    transform: [{ rotate: "-52.7deg" }],
  },
  words: {
    position: "absolute",
    top: PLATE + 20,
    left: -100,
    right: -100,
    alignItems: "center",
    gap: 6,
  },
  wordmark: {
    fontSize: font.stat,
    fontWeight: "800",
    letterSpacing: -0.4,
  },
  caption: {
    fontSize: font.meta,
  },
});
