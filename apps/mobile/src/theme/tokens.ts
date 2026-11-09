// 设计 Token：与桌面端语义 Token 同源，但手机端改成「无阴影、实色表面、色块分区」
// 的触摸优先体系——半透明卡片叠 Android elevation 会在真机上把阴影从卡片内部透出来
// （浅色模式下表现为卡片里嵌一个矩形白/灰框），所以这里所有表面都是不透明色。
//
// 命名约定：按「用途」而不是「颜色」命名。`accent` 用于文字/图标/描边，
// `accentFill` 用于需要承载白色文字的表面——两者分开是因为同一个蓝既当链接文字
// 又当按钮底色时，只改一个值就会有一边掉到 4.5:1 以下。
export type ColorScheme = "light" | "dark";
/** 用户偏好：跟随系统 / 强制浅色 / 强制深色 */
export type ThemeMode = "system" | "light" | "dark";

export interface Palette {
  /** 窗口底：页面背景 */
  bg: string;
  /** 次级底：Tab 栏、输入区等略高于窗口底的表面 */
  bgAccent: string;
  /** 一级卡片表面：不透明，保证叠 elevation 也不会透出阴影层 */
  card: string;
  /** 需要完全遮住下层内容时的合成色；现在与 card 同值，保留语义给滑删层 */
  cardSolid: string;
  /** 已完成行的表面：带一点成功色倾向，让「已处理」在列表里一眼可分 */
  cardDone: string;
  /** 卡片 hairline 边框 */
  cardBorder: string;
  /** 卡片顶部内高光：实色表面上的一条亮边，纯装饰 */
  cardHighlight: string;
  /** 弹层底板 */
  sheet: string;
  /** 弹层遮罩 */
  overlay: string;
  /** 恒暗表面：取景器、演示底板等无论主题如何都保持深色的区域 */
  ink: string;
  /** 压在 ink 上的文字：两套主题同一个值（ink 本身就恒暗，跟着主题改会掉到不可读） */
  inkText: string;
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
  /** 完成勾选符号的颜色：深色模式下 ok 本身很亮，白勾会糊，必须换深色符号 */
  onOk: string;
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
        bg: "#F3F5FA",
        bgAccent: "#E9EEF8",
        card: "#FFFFFF",
        cardSolid: "#FFFFFF",
        cardDone: "#F2FAF6",
        cardBorder: "#E4E8F0",
        cardHighlight: "rgba(255,255,255,0.9)",
        sheet: "#FFFFFF",
        overlay: "rgba(9,14,26,0.46)",
        ink: "#121826",
        inkText: "#B7C2D6",
        text: "#0F172A",
        textSoft: "#3D4A5F",
        muted: "#5D6B80",
        faint: "#94A1B5",
        accent: "#3A5BEF",
        accentFill: "#3A5BEF",
        accentSoft: "rgba(58,91,239,0.10)",
        onAccent: "#FFFFFF",
        ok: "#0E8F63",
        okSoft: "rgba(14,143,99,0.10)",
        onOk: "#FFFFFF",
        warn: "#A2620A",
        warnSoft: "rgba(162,98,10,0.10)",
        danger: "#C0332B",
        dangerFill: "#C0332B",
        dangerSoft: "rgba(192,51,43,0.10)",
        onDanger: "#FFFFFF",
        track: "#EEF1F7",
        separator: "#E7EBF3",
      }
    : {
        bg: "#080D16",
        bgAccent: "#0E1522",
        card: "#121A28",
        cardSolid: "#121A28",
        cardDone: "#101F1B",
        cardBorder: "rgba(148,180,226,0.14)",
        cardHighlight: "rgba(255,255,255,0.05)",
        sheet: "#141C2B",
        overlay: "rgba(2,6,16,0.66)",
        ink: "#0A1120",
        inkText: "#B7C2D6",
        text: "#E9EFFA",
        textSoft: "#C2CFE2",
        muted: "#93A5BD",
        faint: "#6C7F99",
        accent: "#8FA8FF",
        accentFill: "#3A5BEF",
        accentSoft: "rgba(143,168,255,0.16)",
        onAccent: "#FFFFFF",
        ok: "#37D399",
        okSoft: "rgba(55,211,153,0.14)",
        onOk: "#06251A",
        warn: "#F0B354",
        warnSoft: "rgba(240,179,84,0.14)",
        danger: "#FF8078",
        dangerFill: "#B93A31",
        dangerSoft: "rgba(255,128,120,0.14)",
        onDanger: "#FFFFFF",
        track: "rgba(148,180,226,0.12)",
        separator: "rgba(148,180,226,0.10)",
      };

export const space = { xxs: 2, xs: 4, sm: 8, md: 12, lg: 16, xl: 22, xxl: 30 };
export const radius = { card: 20, row: 16, control: 12, sheet: 28, chip: 999 };
export const font = {
  display: 30,
  stat: 26,
  title: 16,
  /** 阅读面（笔记正文/摘要）：比通用正文大一号，长文本可读性优先 */
  reading: 15,
  body: 13,
  meta: 12,
  label: 11,
};
