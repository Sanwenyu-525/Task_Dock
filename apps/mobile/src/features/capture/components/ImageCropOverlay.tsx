// 图片预览与基础裁剪的共用组件：处理页与文档扫描页都用这一份，避免两套矩形逻辑漂移。
//
// 坐标约定：CropFraction 是 0..1 的相对矩形；转换到源图像素由调用方按 asset.width/height 换算。
import { useCallback, useMemo, useRef, useState } from "react";
import {
  Animated,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
} from "react-native";

import { space } from "../../../theme/tokens";

export interface CropFraction {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const CROP_DEFAULT: CropFraction = { x: 0.1, y: 0.1, w: 0.8, h: 0.8 };

function distanceOf(touches: ReadonlyArray<{ pageX: number; pageY: number }>): number {
  return Math.hypot(touches[0].pageX - touches[1].pageX, touches[0].pageY - touches[1].pageY);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 双指缩放 + 放大后拖动；缩放回到 1 时不保留偏移。 */
export function ZoomableImage({ uri }: { uri: string }) {
  const scale = useRef(new Animated.Value(1)).current;
  const translateX = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(0)).current;
  const values = useRef({ scale: 1, x: 0, y: 0 });
  const gesture = useRef({ startDistance: 0, startScale: 1, startX: 0, startY: 0, touchX: 0, touchY: 0 });
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [zoomed, setZoomed] = useState(false);

  const apply = useCallback(
    (nextScale: number, nextX: number, nextY: number) => {
      const limitX = Math.max(0, (size.width * (nextScale - 1)) / 2);
      const limitY = Math.max(0, (size.height * (nextScale - 1)) / 2);
      const x = clamp(nextX, -limitX, limitX);
      const y = clamp(nextY, -limitY, limitY);
      values.current = { scale: nextScale, x, y };
      scale.setValue(nextScale);
      translateX.setValue(x);
      translateY.setValue(y);
      setZoomed(nextScale > 1.02);
    },
    [scale, size.height, size.width, translateX, translateY],
  );

  const reset = useCallback(() => apply(1, 0, 0), [apply]);

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (event) => {
          const touches = event.nativeEvent.touches;
          if (touches.length >= 2) {
            gesture.current.startDistance = distanceOf(touches);
            gesture.current.startScale = values.current.scale;
          } else if (touches.length === 1) {
            gesture.current.touchX = touches[0].pageX;
            gesture.current.touchY = touches[0].pageY;
            gesture.current.startX = values.current.x;
            gesture.current.startY = values.current.y;
          }
        },
        onPanResponderMove: (event) => {
          const touches = event.nativeEvent.touches;
          if (touches.length >= 2 && gesture.current.startDistance > 0) {
            const scaleNext = clamp(
              gesture.current.startScale * (distanceOf(touches) / gesture.current.startDistance),
              1,
              5,
            );
            apply(scaleNext, values.current.x, values.current.y);
          } else if (touches.length === 1 && values.current.scale > 1.02) {
            apply(
              values.current.scale,
              gesture.current.startX + (touches[0].pageX - gesture.current.touchX),
              gesture.current.startY + (touches[0].pageY - gesture.current.touchY),
            );
          }
        },
        onPanResponderRelease: () => {
          if (values.current.scale <= 1.02) reset();
        },
      }),
    [apply, reset],
  );

  return (
    <View
      style={styles.previewImageWrap}
      onLayout={(event: LayoutChangeEvent) => {
        const { width, height } = event.nativeEvent.layout;
        setSize({ width, height });
      }}
      {...responder.panHandlers}
    >
      <Animated.Image
        source={{ uri }}
        resizeMode="contain"
        style={[StyleSheet.absoluteFill, { transform: [{ scale }, { translateX }, { translateY }] }]}
      />
      {zoomed ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="重置缩放"
          onPress={reset}
          style={styles.zoomReset}
        >
          <Text style={styles.zoomResetText}>1:1</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** 自由矩形裁剪框：拖动移动，右下角把手缩放；通过 onChange 回传相对矩形。 */
export function ImageCropOverlay({
  fraction,
  onChange,
  display,
  hint,
}: {
  fraction: CropFraction;
  onChange: (next: CropFraction) => void;
  display: { x: number; y: number; width: number; height: number };
  hint?: string;
}) {
  const start = useRef({ ...fraction });
  const mode = useRef<"move" | "resize">("move");

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (event) => {
          const { pageX, pageY } = event.nativeEvent;
          const handleX = display.x + (fraction.x + fraction.w) * display.width;
          const handleY = display.y + (fraction.y + fraction.h) * display.height;
          mode.current = Math.hypot(pageX - handleX, pageY - handleY) <= 56 ? "resize" : "move";
          start.current = { ...fraction };
        },
        onPanResponderMove: (_event, gesture) => {
          if (display.width <= 0 || display.height <= 0) return;
          const dx = gesture.dx / display.width;
          const dy = gesture.dy / display.height;
          if (mode.current === "move") {
            const x = clamp(start.current.x + dx, 0, 1 - start.current.w);
            const y = clamp(start.current.y + dy, 0, 1 - start.current.h);
            onChange({ ...start.current, x, y });
            return;
          }
          const w = clamp(start.current.w + dx, 0.2, 1 - start.current.x);
          const h = clamp(start.current.h + dy, 0.2, 1 - start.current.y);
          onChange({ ...start.current, w, h });
        },
      }),
    [display.height, display.width, fraction, onChange],
  );

  const left = display.x + fraction.x * display.width;
  const top = display.y + fraction.y * display.height;
  const width = fraction.w * display.width;
  const height = fraction.h * display.height;

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      <View pointerEvents="none" style={[styles.cropDim, { left: 0, right: 0, top: 0, height: top }]} />
      <View
        pointerEvents="none"
        style={[styles.cropDim, { left: 0, right: 0, top: top + height, bottom: 0 }]}
      />
      <View pointerEvents="none" style={[styles.cropDim, { left: 0, top, width: left, height }]} />
      <View pointerEvents="none" style={[styles.cropDim, { left: left + width, right: 0, top, height }]} />
      <View pointerEvents="none" style={[styles.cropFrame, { left, top, width, height }]}>
        <View style={styles.cropHandle} />
      </View>
      <View style={StyleSheet.absoluteFill} {...responder.panHandlers} />
      <Text style={styles.cropHint}>{hint ?? "拖动矩形移动，右下角缩放"}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  previewImageWrap: { width: "100%", height: "100%" },
  zoomReset: {
    position: "absolute",
    right: space.md,
    top: space.md,
    paddingHorizontal: space.sm,
    minHeight: 30,
    borderRadius: 999,
    backgroundColor: "rgba(0,0,0,0.45)",
    alignItems: "center",
    justifyContent: "center",
  },
  zoomResetText: { color: "#FFFFFF", fontSize: 11, fontWeight: "700" },
  cropDim: { position: "absolute", backgroundColor: "rgba(4,10,20,0.55)" },
  cropFrame: { position: "absolute", borderWidth: 1.5, borderColor: "#FFFFFF" },
  cropHandle: {
    position: "absolute",
    right: -14,
    bottom: -14,
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 2,
    borderColor: "#FFFFFF",
    backgroundColor: "rgba(22,119,255,0.65)",
  },
  cropHint: {
    position: "absolute",
    left: space.md,
    bottom: space.md,
    color: "#FFFFFF",
    fontSize: 11,
    backgroundColor: "rgba(0,0,0,0.4)",
    paddingHorizontal: space.sm,
    paddingVertical: 3,
    borderRadius: 6,
  },
});
