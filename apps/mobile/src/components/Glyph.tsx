// 线性图标：22dp 视框内用基础 View 绘制，与 TabBar / AppBar / FAB 同一套笔触。
// 不引入图标库：不同 ROM 会把手写字符渲染成彩色 emoji，也会让包体与授权边界变复杂。
// 所有坐标按 22dp 设计，渲染时整体按 size/22 缩放。
import { View } from "react-native";

export type GlyphName =
  | "home"
  | "check"
  | "layers"
  | "grid"
  | "user"
  | "bell"
  | "search"
  | "plus"
  | "folder"
  | "doc"
  | "inbox"
  | "sync"
  | "transfer"
  | "pin"
  | "pulse"
  | "sparkle"
  | "code"
  | "api"
  | "clipboard"
  | "workflow"
  | "shelf"
  | "target"
  | "chevron"
  | "back"
  | "device"
  | "clock"
  | "cube";

const BOX = 22;

interface ShapeProps {
  scale: number;
  color: string;
}

/** 矩形杆：x/y/w/h 按 22dp 视框给值 */
function bar(
  scale: number,
  color: string,
  x: number,
  y: number,
  w: number,
  h: number,
  rotate = 0,
  radius = 1,
  opacity = 1,
) {
  return (
    <View
      style={{
        position: "absolute",
        left: x * scale,
        top: y * scale,
        width: w * scale,
        height: h * scale,
        borderRadius: radius * scale,
        backgroundColor: color,
        opacity,
        transform: rotate ? [{ rotate: `${rotate}deg` }] : undefined,
      }}
    />
  );
}

/** 圆环（默认正圆；给 radius 可画胶囊） */
function ring(
  scale: number,
  color: string,
  x: number,
  y: number,
  d: number,
  thickness = 1.6,
  radius?: number,
) {
  return (
    <View
      style={{
        position: "absolute",
        left: x * scale,
        top: y * scale,
        width: d * scale,
        height: d * scale,
        borderRadius: (radius ?? d / 2) * scale,
        borderWidth: thickness * scale,
        borderColor: color,
      }}
    />
  );
}

/** 描边矩形 */
function outline(
  scale: number,
  color: string,
  x: number,
  y: number,
  w: number,
  h: number,
  thickness = 1.6,
  r = 3,
) {
  return (
    <View
      style={{
        position: "absolute",
        left: x * scale,
        top: y * scale,
        width: w * scale,
        height: h * scale,
        borderRadius: r * scale,
        borderWidth: thickness * scale,
        borderColor: color,
      }}
    />
  );
}

/** 实心圆点 / 色块 */
function dot(
  scale: number,
  color: string,
  x: number,
  y: number,
  w: number,
  h: number,
  r = 50,
  opacity = 1,
) {
  return (
    <View
      style={{
        position: "absolute",
        left: x * scale,
        top: y * scale,
        width: w * scale,
        height: h * scale,
        borderRadius: (r === 50 ? Math.min(w, h) / 2 : r) * scale,
        backgroundColor: color,
        opacity,
      }}
    />
  );
}

function chevron(scale: number, color: string) {
  return (
    <>
      {bar(scale, color, 7.2, 7.4, 6.6, 1.6, 45, 0.8)}
      {bar(scale, color, 7.2, 13.0, 6.6, 1.6, -45, 0.8)}
    </>
  );
}

/** 返回箭头：与 AppBar 同一朝向（指向左） */
function backArrow(scale: number, color: string) {
  return (
    <>
      {bar(scale, color, 7.4, 7.4, 6.6, 1.6, -45, 0.8)}
      {bar(scale, color, 7.4, 13.0, 6.6, 1.6, 45, 0.8)}
    </>
  );
}

export function Glyph({
  name,
  color,
  size = 22,
}: {
  name: GlyphName;
  color: string;
  size?: number;
}) {
  const scale = size / BOX;
  const p: ShapeProps = { scale, color };

  return (
    <View
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
      style={{ width: size, height: size }}
    >
      {renderGlyph(name, p)}
    </View>
  );
}

function renderGlyph(name: GlyphName, { scale, color }: ShapeProps) {
  const SW = 1.6;

  switch (name) {
    case "home":
      // 屋脊（两根 45° 短杆）+ 屋身
      return (
        <>
          {bar(scale, color, 3.9, 6.1, 8.2, 1.7, 45, 0.8)}
          {bar(scale, color, 9.9, 6.1, 8.2, 1.7, -45, 0.8)}
          {bar(scale, color, 4.9, 10.2, 1.6, 7.4, 0, 0.6)}
          {bar(scale, color, 15.5, 10.2, 1.6, 7.4, 0, 0.6)}
          {bar(scale, color, 4.9, 16.9, 12.2, 1.6, 0, 0.6)}
          {bar(scale, color, 10.2, 12.6, 1.6, 4.4, 0, 0.6)}
        </>
      );

    case "check":
      return (
        <>
          {ring(scale, color, 1.2, 1.2, 19.6, SW)}
          {bar(scale, color, 5.6, 11.6, 4.9, SW, 44, 0.8)}
          {bar(scale, color, 8.2, 9.9, 9.1, SW, -45, 0.8)}
        </>
      );

    case "layers":
      return (
        <>
          <View
            style={{
              position: "absolute",
              left: 7.4 * scale,
              top: 3.4 * scale,
              width: 7.2 * scale,
              height: 7.2 * scale,
              borderRadius: 1.4 * scale,
              borderWidth: SW * scale,
              borderColor: color,
              transform: [{ rotate: "45deg" }],
            }}
          />
          {bar(scale, color, 3.2, 11.6, 15.6, SW, 0, 0.6)}
          {bar(scale, color, 3.2, 15.9, 15.6, SW, 0, 0.6)}
        </>
      );

    case "grid":
      return (
        <>
          {outline(scale, color, 2.2, 2.2, 7.6, 7.6, SW, 2)}
          {outline(scale, color, 12.2, 2.2, 7.6, 7.6, SW, 2)}
          {outline(scale, color, 2.2, 12.2, 7.6, 7.6, SW, 2)}
          {outline(scale, color, 12.2, 12.2, 7.6, 7.6, SW, 2)}
        </>
      );

    case "user":
      return (
        <>
          {ring(scale, color, 7.1, 2.4, 7.8, SW)}
          {bar(scale, color, 3.0, 12.4, 1.7, 4.6, 0, 0.8)}
          {bar(scale, color, 17.3, 12.4, 1.7, 4.6, 0, 0.8)}
          {bar(scale, color, 4.4, 16.6, 13.2, 1.7, 0, 0.8)}
          {bar(scale, color, 2.7, 14.0, 2.8, 1.6, 45, 0.8)}
          {bar(scale, color, 16.5, 14.0, 2.8, 1.6, -45, 0.8)}
        </>
      );

    case "bell":
      return (
        <>
          {bar(scale, color, 10.2, 1.4, 1.6, 1.8, 0, 0.6)}
          <View
            style={{
              position: "absolute",
              left: 5.4 * scale,
              top: 2.6 * scale,
              width: 11.2 * scale,
              height: 9.4 * scale,
              borderWidth: SW * scale,
              borderColor: color,
              borderBottomWidth: 0,
              borderTopLeftRadius: 5.6 * scale,
              borderTopRightRadius: 5.6 * scale,
            }}
          />
          {bar(scale, color, 3.9, 12.0, 14.2, 1.6, 0, 1)}
          {bar(scale, color, 7.4, 13.8, 7.2, SW, 0, 0.8)}
          {dot(scale, color, 9.9, 13.3, 2.2, 2.2)}
        </>
      );

    case "search":
      return (
        <>
          {ring(scale, color, 2.4, 2.4, 13.4, SW)}
          {bar(scale, color, 13.6, 14.9, 6.6, 1.8, -45, 0.9)}
        </>
      );

    case "plus":
      return (
        <>
          {bar(scale, color, 2.6, 10.2, 16.8, 1.8, 0, 1)}
          {bar(scale, color, 10.2, 2.6, 1.8, 16.8, 0, 1)}
        </>
      );

    case "folder":
      return (
        <>
          {outline(scale, color, 2.0, 6.0, 18.0, 12.4, SW, 2.4)}
          {bar(scale, color, 3.6, 4.4, 7.6, 2.2, 0, 1)}
          {bar(scale, color, 4.2, 9.4, 8.6, 1.4, 0, 0.9, 0.35)}
        </>
      );

    case "doc":
      return (
        <>
          {outline(scale, color, 4.0, 2.2, 13.4, 17.6, SW, 2.4)}
          {bar(scale, color, 11.6, 2.6, 6.0, SW, 45, 0.8)}
          {bar(scale, color, 6.6, 7.8, 8.2, 1.4, 0, 0.8)}
          {bar(scale, color, 6.6, 11.4, 8.2, 1.4, 0, 0.8)}
          {bar(scale, color, 6.6, 15.0, 5.4, 1.4, 0, 0.8)}
        </>
      );

    case "inbox":
      return (
        <>
          {outline(scale, color, 2.2, 2.2, 17.6, 17.6, SW, 3)}
          {bar(scale, color, 3.4, 13.2, 5.4, SW, 0, 0.8)}
          {bar(scale, color, 13.2, 13.2, 5.4, SW, 0, 0.8)}
          {bar(scale, color, 6.6, 14.2, 3.0, SW, 60, 0.8)}
          {bar(scale, color, 8.4, 15.9, 5.2, SW, 0, 0.8)}
          {bar(scale, color, 12.6, 14.2, 3.0, SW, -60, 0.8)}
        </>
      );

    case "sync":
      return (
        <>
          {ring(scale, color, 3.0, 3.0, 16.0, SW)}
          {bar(scale, color, 13.4, 1.4, 4.6, 1.7, 0, 0.6)}
          {bar(scale, color, 16.0, 2.6, 1.7, 4.4, 0, 0.6)}
          {bar(scale, color, 4.0, 18.8, 4.6, 1.7, 0, 0.6)}
          {bar(scale, color, 4.4, 16.8, 1.7, 4.4, 0, 0.6)}
        </>
      );

    case "transfer":
      return (
        <>
          {bar(scale, color, 6.0, 3.2, 1.7, 11.6, 0, 0.8)}
          {bar(scale, color, 3.2, 6.6, 5.4, 1.7, -45, 0.6)}
          {bar(scale, color, 10.2, 6.6, 5.4, 1.7, 45, 0.6)}
          {bar(scale, color, 14.3, 7.2, 1.7, 11.6, 0, 0.8)}
          {bar(scale, color, 11.5, 15.0, 5.4, 1.7, 45, 0.6)}
          {bar(scale, color, 16.7, 15.2, 5.4, 1.7, -45, 0.6)}
        </>
      );

    case "pin":
      return (
        <>
          {ring(scale, color, 5.6, 2.2, 10.8, SW, 5.4)}
          {bar(scale, color, 10.2, 12.0, 1.7, 7.6, 0, 0.8)}
          {bar(scale, color, 6.0, 12.0, 10.0, 1.6, 0, 0.6)}
        </>
      );

    case "pulse":
      return (
        <>
          {bar(scale, color, 1.6, 12.8, 5.4, 1.7, -18, 0.8)}
          {bar(scale, color, 5.8, 10.4, 5.0, 1.7, 42, 0.8)}
          {bar(scale, color, 9.6, 7.2, 4.6, 1.7, -55, 0.8)}
          {bar(scale, color, 12.4, 12.6, 7.6, 1.7, 12, 0.8)}
          {bar(scale, color, 1.6, 17.8, 18.8, 1.4, 0, 0.7, 0.25)}
        </>
      );

    case "sparkle":
      return (
        <>
          {bar(scale, color, 10.2, 2.4, 1.7, 17.2, 0, 0.8)}
          {bar(scale, color, 2.4, 10.1, 17.2, 1.7, 0, 0.8)}
          {bar(scale, color, 6.6, 6.6, 8.8, 1.6, 45, 0.6, 0.55)}
          {bar(scale, color, 6.6, 13.8, 8.8, 1.6, -45, 0.6, 0.55)}
        </>
      );

    case "code":
      return (
        <>
          {bar(scale, color, 3.2, 7.4, 6.0, 1.6, -45, 0.7)}
          {bar(scale, color, 3.2, 13.0, 6.0, 1.6, 45, 0.7)}
          {bar(scale, color, 12.8, 7.4, 6.0, 1.6, 45, 0.7)}
          {bar(scale, color, 12.8, 13.0, 6.0, 1.6, -45, 0.7)}
        </>
      );

    case "api":
      return (
        <>
          {outline(scale, color, 1.8, 3.0, 5.6, 16.0, SW, 5.6)}
          {outline(scale, color, 14.6, 3.0, 5.6, 16.0, SW, 5.6)}
          {bar(scale, color, 10.2, 5.6, 1.6, 10.8, 0, 0.8)}
          {dot(scale, color, 6.4, 9.9, 2.0, 2.0)}
          {dot(scale, color, 13.6, 9.9, 2.0, 2.0)}
        </>
      );

    case "clipboard":
      return (
        <>
          {outline(scale, color, 3.6, 3.4, 14.8, 16.4, SW, 2.4)}
          {bar(scale, color, 7.4, 1.6, 7.2, 3.2, 0, 1.6)}
          {bar(scale, color, 6.4, 8.2, 8.8, 1.4, 0, 0.8)}
          {bar(scale, color, 6.4, 12.0, 8.8, 1.4, 0, 0.8)}
          {bar(scale, color, 6.4, 15.6, 5.6, 1.4, 0, 0.8)}
        </>
      );

    case "workflow":
      return (
        <>
          {ring(scale, color, 1.8, 1.8, 5.4, SW)}
          {ring(scale, color, 1.8, 14.8, 5.4, SW)}
          {ring(scale, color, 14.8, 8.0, 5.4, SW)}
          {bar(scale, color, 6.6, 4.2, 5.4, 1.5, 0, 0.7)}
          {bar(scale, color, 7.4, 8.4, 7.2, 1.5, 0, 0.7)}
          {bar(scale, color, 4.4, 6.8, 1.5, 8.0, 0, 0.7)}
          {bar(scale, color, 12.0, 10.8, 5.2, 1.5, 28, 0.7)}
        </>
      );

    case "shelf":
      return (
        <>
          {outline(scale, color, 3.2, 3.4, 15.6, 14.4, SW, 2.6)}
          {bar(scale, color, 3.4, 8.2, 15.2, 1.5, 0, 0.6)}
          {bar(scale, color, 7.6, 11.6, 6.8, 1.5, 0, 0.6)}
        </>
      );

    case "target":
      return (
        <>
          {ring(scale, color, 2.0, 2.0, 18.0, SW)}
          {ring(scale, color, 6.4, 6.4, 9.2, SW)}
          {dot(scale, color, 9.4, 9.4, 3.2, 3.2)}
        </>
      );

    case "chevron":
      return chevron(scale, color);

    case "back":
      return backArrow(scale, color);

    case "device":
      return (
        <>
          {outline(scale, color, 1.4, 2.4, 7.2, 14.4, 1.5, 2.2)}
          {bar(scale, color, 3.2, 14.0, 3.4, 1.2, 0, 0.6)}
          {outline(scale, color, 9.8, 7.6, 11.0, 7.6, 1.5, 1.4)}
          {bar(scale, color, 8.4, 16.2, 13.8, 1.5, 0, 0.7)}
        </>
      );

    case "clock":
      return (
        <>
          {ring(scale, color, 2.2, 2.2, 17.6, SW)}
          {bar(scale, color, 10.4, 5.8, 1.5, 6.4, 0, 0.7)}
          {bar(scale, color, 10.4, 11.0, 5.0, 1.5, 0, 0.7)}
        </>
      );

    case "cube":
      return (
        <>
          {outline(scale, color, 3.0, 3.0, 16.0, 16.0, SW, 2.4)}
          {bar(scale, color, 3.2, 8.0, 15.6, 1.4, 0, 0.6, 0.7)}
          {bar(scale, color, 8.6, 3.4, 1.4, 7.0, 0, 0.6, 0.7)}
        </>
      );

    default:
      return null;
  }
}
