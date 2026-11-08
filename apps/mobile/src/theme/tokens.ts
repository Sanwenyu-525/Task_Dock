// 设计 Token：与桌面端语义 Token 同源（色值取自现有 PoC，保证与桌面视觉一致）。
// 只放可复现的基础值，不放任何业务逻辑，后续可整体迁入 shared/。
//
// 命名约定：按「用途」而不是「颜色」命名。`accent` 用于文字/图标/描边，
// `accentFill` 用于需要承载白色文字的表面——两者分开是因为同一个蓝色既当
// 链接文字又当按钮底色时，只改一个值就会有一边掉到 4.5:1 以下。
export type ColorScheme = "light" | "dark";
/** 用户偏好：跟随系统 / 强制浅色 / 强制深色 */
export type ThemeMode = "system" | "light" | "dark";

export interface Palette {
  /** 窗口底：页面与列表背景 */
  bg: string;
  /** 次级底：Tab 栏、分组头等略高于窗口底的表面 */
  bgAccent: string;
  /** 一级卡片表面（半透明，透出窗口底） */
  card: string;
  /**
   * 卡片的不透明合成色：等价于 `card` 叠在 `bg` 上的最终颜色。
   * 只给「下面必须完全遮住内容」的场景用（任务行滑删时红底在卡片下方），
   * 其余卡片仍用半透明 `card`，保证液态玻璃的透光感。
   */
  cardSolid: string;
  /** 卡片 hairline 边框 */
  cardBorder: string;
  /** 卡片顶部内高光：液态玻璃的边光，纯装饰 */
  cardHighlight: string;
  /** 弹层底板：必须接近不透明，避免正文压在列表文字上 */
  sheet: string;
  /** 弹层遮罩 */
  overlay: string;
  text: string;
  /** 正文次级文本：说明文字用，比 muted 更实，保证 4.5:1 */
  textSoft: string;
  muted: string;
  /** 弱文本：只用于不承载信息的装饰性文字 */
  faint: string;
  /** 强调色（文字 / 图标 / 描边） */
  accent: string;
  /** 强调填充色（白字对比度 ≥ 4.5:1） */
  accentFill: string;
  accentSoft: string;
  onAccent: string;
  ok: string;
  okSoft: string;
  warn: string;
  warnSoft: string;
  danger: string;
  dangerFill: string;
  dangerSoft: string;
  onDanger: string;
  track: string;
  separator: string;
}

export const palette = (scheme: ColorScheme): Palette =>
  scheme === "light"
    ? {
        bg: "#F2F5F9",
        bgAccent: "#E9EFF8",
        card: "rgba(255,255,255,0.74)",
        cardSolid: "#FCFDFE",
        cardBorder: "rgba(15,23,42,0.08)",
        cardHighlight: "rgba(255,255,255,0.92)",
        sheet: "rgba(250,252,255,0.985)",
        overlay: "rgba(8,14,26,0.44)",
        text: "#0F172A",
        textSoft: "#3A465C",
        muted: "#5F6F86",
        faint: "#93A3B8",
        accent: "#2F6FE0",
        accentFill: "#2F6FE0",
        accentSoft: "rgba(47,111,224,0.12)",
        onAccent: "#FFFFFF",
        ok: "#177B55",
        okSoft: "rgba(23,123,85,0.12)",
        warn: "#9A6400",
        warnSoft: "rgba(154,100,0,0.12)",
        danger: "#BE3A30",
        dangerFill: "#BE3A30",
        dangerSoft: "rgba(190,58,48,0.12)",
        onDanger: "#FFFFFF",
        track: "rgba(15,23,42,0.07)",
        separator: "rgba(15,23,42,0.07)",
      }
    : {
        bg: "#080E1B",
        bgAccent: "#101827",
        card: "rgba(24,33,52,0.72)",
        cardSolid: "#151E2E",
        cardBorder: "rgba(148,180,226,0.16)",
        cardHighlight: "rgba(255,255,255,0.055)",
        sheet: "rgba(16,24,39,0.99)",
        overlay: "rgba(2,6,16,0.62)",
        text: "#E7EEF9",
        textSoft: "#C2CFE1",
        muted: "#93A5BD",
        faint: "#6C7F99",
        accent: "#7FAEFF",
        accentFill: "#2F6FE0",
        accentSoft: "rgba(127,174,255,0.18)",
        onAccent: "#FFFFFF",
        ok: "#3DD598",
        okSoft: "rgba(61,213,152,0.16)",
        warn: "#F0B354",
        warnSoft: "rgba(240,179,84,0.16)",
        danger: "#FF7A70",
        dangerFill: "#B93A31",
        dangerSoft: "rgba(255,122,112,0.16)",
        onDanger: "#FFFFFF",
        track: "rgba(148,180,226,0.14)",
        separator: "rgba(148,180,226,0.10)",
      };

export const space = { xxs: 2, xs: 4, sm: 8, md: 12, lg: 16, xl: 22, xxl: 30 };
export const radius = { card: 18, row: 14, control: 11, sheet: 24, chip: 999 };
export const font = {
  display: 26,
  stat: 24,
  title: 15,
  body: 13,
  meta: 12,
  label: 11,
  tiny: 10,
};
/** 可点击元素的最小边长：安卓无障碍建议 ≥ 44dp，图标按钮额外用 hitSlop 补足 */
export const hit = { min: 44 };
