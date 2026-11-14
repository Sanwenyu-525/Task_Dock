//! 液态融合翼片（Liquid Edge Wing）几何——纯函数，可单测。
//!
//! 这是胶囊外形的**唯一参数化定义**：前端 SVG 可见轮廓、命中判定、
//! Rust `SetWindowRgn` 裁剪区域、DPI 换算全部由同一组参数与同一套采样规则导出。
//! Rust 侧 `window_shape::wing_outline` 是同一算法的镜像实现，两端各有一组
//! 金标准点位单测锁定（见 `capsuleShape.test.ts` / `window_shape.rs`）。
//!
//! ## 形状（边空间）
//!
//! 用「边空间」描述，与停靠方向解耦：`u` 沿屏幕边缘（中线为 0）、`v` 由边缘向
//! 屏幕内部（0 = 贴边、T = 翼片厚度）。形状永远满足 `v = 0` 的一侧与屏幕边缘
//! 齐平（不悬浮、不留缝）：
//!
//! ```text
//!   v = T        ┌────────────── 平直主体 ──────────────┐
//!                ╱                                      ╲
//!               ╱  三次贝塞尔，起点切线水平、终点切线水平  ╲
//!   v = 0  ────╯                                          ╰────   ← 屏幕边缘
//!          u=-L/2-S                                    u=+L/2+S
//! ```
//!
//! **与旧模型（椭圆外扩 → 垂直直壁 → 26px 圆角）的区别**：旧模型的两端是
//! 「圆角矩形 + 两个小外扩」，必然出现一条肉眼可见的直壁和两个 90° 量级的
//! 圆角，读起来就是「圆角侧栏靠到了屏幕边上」。这里改成**单段三次贝塞尔肩部**：
//!
//! - 起点 `(±L/2, T)`：与主体平边相切（切线水平），离开平边时曲率连续变化，
//!   没有「直壁突然接圆角」的折点；
//! - 终点 `(±(L/2+S), 0)`：与屏幕边缘相切（切线水平），翼片是「从边缘长出来」
//!   而不是「贴在边缘上」，因此贴边一侧天然没有边线、没有缝；
//! - 中间没有直壁、没有 90° 拐角，曲率符号在肩部中段翻转一次（S 形），
//!   这正是液态肩部的形态特征。
//!
//! 控制柄按肩宽比例给出（`WING_CREST_RATIO` / `WING_TAIL_RATIO`），保证不同 DPI
//! 下形状相似，而不是「像素换算后比例漂移」。
//!
//! ## 为什么用采样折线而不是 SVG 弧命令
//!
//! GDI 区域只能是整数多边形。若 SVG 用曲线命令、Rust 用折线，两者必然有亚像素
//! 偏差；这里让**两边都从同一个采样函数取点**（同一段数），于是「CSS 可见轮廓 =
//! Win32 区域」是构造性成立的，而不是靠容差凑。肩部 18 段时单段弦长 ≈ 3.3px、
//! 弦高误差 < 0.05px，与抗锯齿曲线无法区分。

import type { SnapEdge } from "./edgeSnap";

export interface Point {
  x: number;
  y: number;
}

/** 翼片厚度（CSS px）：垂直停靠为宽，水平停靠为高。 */
export const WING_THICKNESS_CSS = 56;
/**
 * 翼片平直主体长度（CSS px，沿边方向）：两侧肩部之间的平直段。
 *
 * 2026-11-13（P0-01）由 270 扩到 300，外框 = 300 + 2×88 = 476。扩展量等于
 * 新增「工作空间」26px 快捷入口 + 4px 间距（见 `CapsuleRail` 的 `.cap-quick`），
 * 因此**内容组两端进入肩部的深度与扩展前完全相同**（都是 30.5px），
 * 每个既有按钮相对肩部曲线的位置不变；没有缩小任何既有命中区。
 * 该数字是跨端契约：Rust `commands/system.rs::CAPSULE_LENGTH_CSS` 必须同步。
 */
export const WING_LENGTH_CSS = 300;
/**
 * 单侧液态肩部的沿边跨度（CSS px）：厚度的 1.57 倍。
 *
 * 该比例**不是估出来的**：从 `停靠效果图.png` 的规格图（300–420px / 56px）按像素
 * 量得肩宽 47px、厚 30px，比值为 1.57；对同一组像素做最小二乘拟合，得到下面两个
 * 控制柄比例，56px 厚下的 RMS 残差 1.32px。旧版 26px（0.46 倍）正是「圆角长条」
 * 观感的直接来源。
 */
export const WING_SHOULDER_CSS = 88;
/**
 * 肩部起点控制柄占肩宽的比例（沿边方向）。
 * 拟合值 0.435：离开平直主体时收得较缓，与效果图的顶端转折一致。
 * 旧版（椭圆外扩 + 竖直直壁）在这里等价于 0——曲率突变，正是折点的来源。
 */
export const WING_CREST_RATIO = 0.435;
/**
 * 肩部终点控制柄占肩宽的比例（沿边方向，从贴边尖端往回量）。
 * 拟合值 0.565：接近屏幕边缘时足够平缓，像液体在边缘摊开。
 */
export const WING_TAIL_RATIO = 0.565;
/** 每个肩部的贝塞尔采样段数（与 Rust `WING_SAMPLES` 相同）。 */
export const WING_SAMPLES = 18;
/**
 * 原生区域相对 CSS 轮廓的外扩量（物理像素）。
 *
 * `SetWindowRgn` 是二值裁剪、没有抗锯齿：区域与 CSS 轮廓重合时，GDI 硬边会
 * 切进 WebView 的平滑弧线，形成第二圈阶梯轮廓。外扩后区域成为 CSS 可见像素的
 * **超集**，可见外轮廓只由 CSS 曲线定义，代价是曲线外 ≤2px 的透明命中带
 * （与既有圆角胶囊的 `REGION_AA_INSET` 同源，不是新引入的折衷）。
 */
export const WING_AA_INSET = 2;

export interface WingMetrics {
  /** 厚度（已按 DPI 取整） */
  thickness: number;
  /** 平直主体长度（已按 DPI 取整） */
  length: number;
  /** 单侧肩部沿边跨度（已按 DPI 取整） */
  shoulder: number;
}

export interface WingBox {
  w: number;
  h: number;
}

export interface WingShape {
  metrics: WingMetrics;
  /** 轨道外框尺寸（含两侧肩部）：垂直停靠为 56×(300+2×88)=56×476 */
  box: WingBox;
  /** 局部坐标轮廓（0..box.w / 0..box.h），已按 `inflate` 外扩 */
  outline: Point[];
}

/** 与 Rust 相同的取整：四舍五入（`floor(x+0.5)`，对 .5 的处理两端一致）。 */
export const roundPx = (v: number): number => Math.floor(v + 0.5);

/**
 * 由 DPI 缩放导出几何参数。
 * 肩部至少 1px：肩宽为 0 时肩部曲线退化成一条竖直边，形状会重新变成圆角矩形。
 */
export function wingMetrics(scale: number): WingMetrics {
  const s = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const thickness = Math.max(1, roundPx(WING_THICKNESS_CSS * s));
  const length = Math.max(1, roundPx(WING_LENGTH_CSS * s));
  const shoulder = Math.max(1, roundPx(WING_SHOULDER_CSS * s));
  return { thickness, length, shoulder };
}

/**
 * 肩部贝塞尔采样：从主体端点 `(0, T)` 到贴边尖端 `(S, 0)`，含两端点。
 *
 * 控制点取 `(k·S, T)` 与 `((1−tail)·S, 0)`：两端切线都严格水平，
 * 因此与主体平边、与屏幕边缘都是 C1 相切。
 */
function shoulderCurve(shoulder: number, thickness: number): Point[] {
  const p0 = { x: 0, y: thickness };
  const p1 = { x: shoulder * WING_CREST_RATIO, y: thickness };
  const p2 = { x: shoulder * (1 - WING_TAIL_RATIO), y: 0 };
  const p3 = { x: shoulder, y: 0 };
  const pts: Point[] = [];
  for (let i = 0; i <= WING_SAMPLES; i += 1) {
    const t = i / WING_SAMPLES;
    const mt = 1 - t;
    const a = mt * mt * mt;
    const b = 3 * mt * mt * t;
    const c = 3 * mt * t * t;
    const d = t * t * t;
    pts.push({
      x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
      y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
    });
  }
  return pts;
}

/**
 * 边空间轮廓（u 沿边、v 由边缘向内），闭合多边形，不含重复的收尾点。
 *
 * 点序：左尖端 → 左肩（逆行）→ 主体两端 → 右肩 → 右尖端。
 * 首尾两点都落在 `v = 0`（屏幕边缘）上，因此 `wingRimPath` 的不闭合描边
 * 天然跳过整条贴边段。
 */
function edgeSpaceOutline(m: WingMetrics): Point[] {
  const { thickness: T, length: L, shoulder: S } = m;
  const half = L / 2;
  const curve = shoulderCurve(S, T);
  const pts: Point[] = [];
  // 左肩：尖端 → 主体（逆行采样）
  for (let i = curve.length - 1; i >= 0; i -= 1) {
    pts.push({ x: -half - curve[i].x, y: curve[i].y });
  }
  // 右肩：主体 → 尖端（i=0 是平直主体的另一端，不能跳过，否则顶边变成斜弦）
  for (let i = 0; i < curve.length; i += 1) {
    pts.push({ x: half + curve[i].x, y: curve[i].y });
  }
  return pts;
}

/** 边空间 → 轨道局部坐标（四边同一套算法，仅换映射，不换形状）。 */
function toLocal(edge: SnapEdge, p: Point, box: WingBox): Point {
  switch (edge) {
    case "bottom":
      return { x: box.w / 2 + p.x, y: box.h - p.y };
    case "top":
      return { x: box.w / 2 + p.x, y: p.y };
    case "left":
      return { x: p.y, y: box.h / 2 + p.x };
    case "right":
      return { x: box.w - p.y, y: box.h / 2 + p.x };
  }
}

/** 有向面积（屏幕坐标 y 向下时，正值 = 顺时针）。 */
export function polygonSignedArea(pts: Point[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i += 1) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/**
 * 沿外法线整体外扩（用于生成比 CSS 轮廓略大的原生区域）。
 * 平滑顶点取相邻两边法线的角平分线，并按 1/cos(半夹角) 做斜接补偿；
 * **尖点用斜切**（两个偏移点）而不是无限延长的尖刺——肩部贴边尖端的内角很小，
 * 斜接会把区域顶出 delta 的数值倍，斜切则保证「区域到轮廓的距离处处 ≤ delta」，
 * 与 AA 内收的语义一致。
 */
export function offsetPolygon(pts: Point[], delta: number): Point[] {
  if (!delta || pts.length < 3) return pts;
  const n = pts.length;
  // y 向下：有向面积为正 → 内部在有向边 (dx,dy) 的 (-dy,dx) 侧 → 外法线 = (dy,-dx)
  const sign = polygonSignedArea(pts) >= 0 ? 1 : -1;
  const normal = (a: Point, b: Point) => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    return { x: (sign * dy) / len, y: (-sign * dx) / len };
  };
  const out: Point[] = [];
  for (let i = 0; i < n; i += 1) {
    const p = pts[i];
    const n1 = normal(pts[(i - 1 + n) % n], p);
    const n2 = normal(p, pts[(i + 1) % n]);
    const dot = n1.x * n2.x + n1.y * n2.y;
    if (dot < 0.7) {
      // 尖点：斜切（与 Rust 侧同一判据、同一顺序）
      out.push({ x: p.x + n1.x * delta, y: p.y + n1.y * delta });
      out.push({ x: p.x + n2.x * delta, y: p.y + n2.y * delta });
      continue;
    }
    let nx = n1.x + n2.x;
    let ny = n1.y + n2.y;
    const len = Math.hypot(nx, ny) || 1;
    nx /= len;
    ny /= len;
    const cos = Math.max(0.5, n1.x * nx + n1.y * ny);
    out.push({ x: p.x + (nx * delta) / cos, y: p.y + (ny * delta) / cos });
  }
  return out;
}

/**
 * 生成翼片几何。
 * @param edge 停靠边（决定映射方向，形状本身四边一致）
 * @param scale DPI 缩放（1 / 1.25 / 1.5 …）
 * @param inflate 外扩量（物理像素）：可见轮廓传 0，原生区域传 `WING_AA_INSET`
 */
export function wingShape(edge: SnapEdge, scale: number, inflate = 0): WingShape {
  const metrics = wingMetrics(scale);
  const vertical = edge === "left" || edge === "right";
  const along = metrics.length + 2 * metrics.shoulder;
  const box: WingBox = vertical
    ? { w: metrics.thickness, h: along }
    : { w: along, h: metrics.thickness };
  const local = edgeSpaceOutline(metrics).map((p) => toLocal(edge, p, box));
  return { metrics, box, outline: inflate > 0 ? offsetPolygon(local, inflate) : local };
}

/** 闭合轮廓 → SVG path（`Z` 收尾）。 */
export function wingPath(outline: Point[]): string {
  if (outline.length === 0) return "";
  const f = (v: number) => (Math.round(v * 100) / 100).toString();
  return `${outline.map((p, i) => `${i === 0 ? "M" : "L"}${f(p.x)} ${f(p.y)}`).join(" ")} Z`;
}

/**
 * 轮廓描边路径：**不闭合**，即刻意跳过贴边那一段。
 * 贴边段若也描边，会在屏幕边缘画出一条 1px 亮线，正是要避免的「底部缝隙」。
 * 肩部两端点都严格落在 `v = 0`，所以这条路径的头尾都正好停在屏幕边缘上。
 */
export function wingRimPath(outline: Point[]): string {
  if (outline.length === 0) return "";
  const f = (v: number) => (Math.round(v * 100) / 100).toString();
  return outline.map((p, i) => `${i === 0 ? "M" : "L"}${f(p.x)} ${f(p.y)}`).join(" ");
}

/**
 * 翼片在「沿边坐标 u」处的可见厚度（物理像素）——布局契约的判定工具。
 *
 * 胶囊轨道是 Win32 区域裁剪窗口：按钮只有落在翼片可见轮廓内才既能看见又能点击。
 * 按钮若放到肩部收窄段，超出曲线的那部分会被 `SetWindowRgn` 直接裁掉（看起来
 * 图标缺一角、点不到）。本函数把「曲线多厚」变成可断言的数字，供
 * `capsuleLayout.test.ts` 锁定「内容组端点所需厚度 ≥ 控件边长」。
 *
 * @param scale DPI 缩放
 * @param alongFromCenter 距轨道沿边中心的距离（物理像素，取绝对值）
 */
export function wingThicknessAt(scale: number, alongFromCenter: number): number {
  const { thickness, length, shoulder } = wingMetrics(scale);
  const u = Math.abs(alongFromCenter);
  const half = length / 2;
  if (u <= half) return thickness;
  if (u >= half + shoulder) return 0;
  // x(t) = S·[1.305(t−t²) + t³] 在 [0,1] 上单调递增：二分求该 u 对应的 t，
  // 再代入 v(t) = T(1−t)²(1+2t)。与 Rust 侧同一条曲线、同一组参数。
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i += 1) {
    const mid = (lo + hi) / 2;
    const x = shoulder * (1.305 * (mid - mid * mid) + mid * mid * mid);
    if (half + x < u) lo = mid;
    else hi = mid;
  }
  const t = (lo + hi) / 2;
  return thickness * (1 - t) * (1 - t) * (1 + 2 * t);
}

/** 射线法点内判定（与 `CreatePolygonRgn` 的填充语义一致）。 */
export function pointInPolygon(p: Point, poly: Point[]): boolean {  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y) {
      const x = ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x;
      if (p.x < x) inside = !inside;
    }
  }
  return inside;
}
