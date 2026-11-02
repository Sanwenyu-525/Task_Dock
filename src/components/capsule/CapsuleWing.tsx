//! 液态融合翼片的可见表面层。
//!
//! 只画外形，不做任何布局与交互：轮廓来自 `lib/capsuleShape.ts` 的唯一定义，
//! 与 Rust `SetWindowRgn` 的区域使用同一套采样点（见该模块头部说明）。
//!
//! ## 四层材质（全部是同一条轮廓的填充，天然被轮廓裁剪）
//!
//! 1. `cap-wing-face`：**跨厚度**三段冷蓝白渐变（near → mid → far）。停靠期根窗口
//!    透明，翼片必须自带不透明表面，否则深色桌面上会「整个消失」；因此渐变两端
//!    都是实色，透明感由分层高光制造，不靠降低 alpha。
//! 2. `cap-wing-shade`：贴边一侧的窄暗部（环境遮蔽）。它让翼片看起来是「从边缘
//!    弯出来」的曲面，而不是一张贴在屏幕上的贴纸。
//! 3. `cap-wing-haze`：中部环境色反射（accent 的低透明度径向渐变），只做冷色倾向，
//!    不参与轮廓表达。
//! 4. `cap-wing-spec`：内侧高光带——只在内侧边缘 3px 内可见，肩部沿 `v` 方向自然
//!    淡出（贴边尖端 `v≈0`，因此完全消失），这是「玻璃边缘」的主要来源。
//!
//! 另有一条 `cap-wing-rim` 描边：**沿边方向渐变**（两端 0.05 → 中段 0.62），
//! 贴边那一段由 `wingRimPath` 直接不画。它是一道细的轮廓高光，不是整圈边框。
//!
//! 渐变方向按停靠边换算：`near→far` 永远是「屏幕边缘 → 屏幕内部」，因此四边
//! 共用一套语义 Token，换方向不换材质。
//!
//! 不使用 `filter: drop-shadow`：SVG 视口会被裁切，投影在视口边界处断成一条直角
//! 切口，反而制造出「矩形窗口」的痕迹。立体感由分层渐变承担（静态，无每帧计算）。

import { useId, useMemo } from "react";
import type { SnapEdge } from "../../lib/edgeSnap";
import { wingPath, wingRimPath, wingShape } from "../../lib/capsuleShape";

interface Axis {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export default function CapsuleWing({ edge }: { edge: SnapEdge }) {
  // useId 含 ":" 等字符，直接拼进 url(#…) 会失效，这里过滤成安全字符
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const shape = useMemo(() => wingShape(edge, 1), [edge]);
  const face = useMemo(() => wingPath(shape.outline), [shape]);
  const rim = useMemo(() => wingRimPath(shape.outline), [shape]);
  const { w, h } = shape.box;
  const vertical = edge === "left" || edge === "right";

  // 跨厚度轴：offset 0 = 贴屏幕边缘，1 = 屏幕内部
  const across: Axis = vertical
    ? edge === "left"
      ? { x1: 0, y1: 0, x2: w, y2: 0 }
      : { x1: w, y1: 0, x2: 0, y2: 0 }
    : edge === "top"
      ? { x1: 0, y1: 0, x2: 0, y2: h }
      : { x1: 0, y1: h, x2: 0, y2: 0 };
  // 沿边轴：用于轮廓高光在两端淡出
  const along: Axis = vertical
    ? { x1: 0, y1: 0, x2: 0, y2: h }
    : { x1: 0, y1: 0, x2: w, y2: 0 };

  return (
    <svg
      className="cap-wing"
      viewBox={`0 0 ${w} ${h}`}
      width={w}
      height={h}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id={`${uid}-face`} gradientUnits="userSpaceOnUse" {...across}>
          <stop offset="0" className="cap-stop-near" />
          <stop offset="0.52" className="cap-stop-mid" />
          <stop offset="1" className="cap-stop-far" />
        </linearGradient>
        <linearGradient id={`${uid}-shade`} gradientUnits="userSpaceOnUse" {...across}>
          <stop offset="0" className="cap-stop-shade" />
          <stop offset="0.26" className="cap-stop-clear" />
        </linearGradient>
        <radialGradient id={`${uid}-haze`} cx="50%" cy="50%" r="62%">
          <stop offset="0" className="cap-stop-haze" />
          <stop offset="1" className="cap-stop-clear" />
        </radialGradient>
        <linearGradient id={`${uid}-spec`} gradientUnits="userSpaceOnUse" {...across}>
          <stop offset="0" className="cap-stop-clear" />
          <stop offset="0.52" className="cap-stop-clear" />
          <stop offset="0.88" className="cap-stop-spec-soft" />
          <stop offset="1" className="cap-stop-spec" />
        </linearGradient>
        <linearGradient id={`${uid}-rim`} gradientUnits="userSpaceOnUse" {...along}>
          <stop offset="0" className="cap-stop-rim-ends" />
          <stop offset="0.14" className="cap-stop-rim-mid" />
          <stop offset="0.86" className="cap-stop-rim-mid" />
          <stop offset="1" className="cap-stop-rim-ends" />
        </linearGradient>
      </defs>
      <path className="cap-wing-face" d={face} fill={`url(#${uid}-face)`} />
      <path className="cap-wing-shade" d={face} fill={`url(#${uid}-shade)`} />
      <path className="cap-wing-haze" d={face} fill={`url(#${uid}-haze)`} />
      <path className="cap-wing-spec" d={face} fill={`url(#${uid}-spec)`} />
      <path
        className="cap-wing-rim"
        d={rim}
        fill="none"
        stroke={`url(#${uid}-rim)`}
        strokeWidth={0.75}
        strokeLinecap="round"
      />
    </svg>
  );
}
