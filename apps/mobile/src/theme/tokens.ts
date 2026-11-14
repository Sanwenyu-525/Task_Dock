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
  /** 弱文本：只用于不承载信息的装饰性文字与图标（对白底 ≥ 3:1） */
  faint: string;
  /** 品牌蓝：图标、装饰、非文本强调。白底 4.1:1，**不可用于小字号文字** */
  accent: string;
  /** 功能蓝：小字号文字/链接/标签，白底 ≥ 5:1；深色模式用亮蓝 */
  accentText: string;
  /** 强调填充色（承载白字，白字对比度 ≥ 4.5:1） */
  accentFill: string;
  accentSoft: string;
  /** 辅助青蓝：用于装饰性色块、图标底板与分区标识（不承载正文） */
  accentAlt: string;
  /** 浅蓝水洗底：装饰渐变块、占位图标底板的合成色 */
  accentWash: string;
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

// 蓝青专业版（2026-11-13 用户最终确认的视觉方案）：
// 白/浅蓝底 + 蓝青强调；色值集中在语义 Token，组件不得散落字面量。
export const palette = (scheme: ColorScheme): Palette =>
  scheme === "light"
    ? {
        bg: "#F7FAFE",
        bgAccent: "#EEF5FD",
        card: "#FFFFFF",
        cardSolid: "#FFFFFF",
        cardDone: "#EFFBF9",
        cardBorder: "#E8EDF4",
        cardHighlight: "rgba(255,255,255,0.9)",
        sheet: "#FFFFFF",
        overlay: "rgba(9,20,38,0.46)",
        ink: "#0E1A2B",
        inkText: "#B7C7DA",
        text: "#172033",
        textSoft: "#3C4B63",
        muted: "#5E6D82",
        faint: "#7D8DA4",
        accent: "#1677FF",
        accentText: "#0B5FCF",
        accentFill: "#0D66E0",
        accentSoft: "rgba(22,119,255,0.10)",
        accentAlt: "#35B8F5",
        accentWash: "#EAF4FF",
        onAccent: "#FFFFFF",
        ok: "#0A7A6F",
        okSoft: "rgba(25,198,194,0.12)",
        onOk: "#FFFFFF",
        warn: "#8A5006",
        warnSoft: "rgba(183,106,11,0.10)",
        danger: "#BE332B",
        dangerFill: "#BE332B",
        dangerSoft: "rgba(201,58,50,0.10)",
        onDanger: "#FFFFFF",
        track: "#EEF3FA",
        separator: "#E8EDF4",
      }
    : {
        bg: "#080E1A",
        bgAccent: "#0D1523",
        card: "#111A28",
        cardSolid: "#111A28",
        cardDone: "#0E211F",
        cardBorder: "rgba(140,175,220,0.14)",
        cardHighlight: "rgba(255,255,255,0.05)",
        sheet: "#131C2B",
        overlay: "rgba(2,6,14,0.66)",
        ink: "#0A1220",
        inkText: "#B7C7DA",
        text: "#E9F0FB",
        textSoft: "#C0CDE0",
        muted: "#8FA2BA",
        faint: "#7A8DA6",
        accent: "#7FB3FF",
        accentText: "#8CC0FF",
        accentFill: "#0D66E0",
        accentSoft: "rgba(127,179,255,0.16)",
        accentAlt: "#67C8F7",
        accentWash: "rgba(53,184,245,0.14)",
        onAccent: "#FFFFFF",
        ok: "#3ED6C6",
        okSoft: "rgba(62,214,198,0.14)",
        onOk: "#06231F",
        warn: "#F0B45B",
        warnSoft: "rgba(240,180,91,0.14)",
        danger: "#FF837C",
        dangerFill: "#B5342C",
        dangerSoft: "rgba(255,131,124,0.14)",
        onDanger: "#FFFFFF",
        track: "rgba(140,175,220,0.12)",
        separator: "rgba(140,175,220,0.10)",
      };

export const space = { xxs: 2, xs: 4, sm: 8, md: 12, lg: 16, section: 20, xl: 22, xxl: 30 };
export const radius = { card: 20, row: 16, control: 12, tile: 12, sheet: 28, chip: 999 };
// 字阶（2026-11-13 第三轮）：正文从 13 提到 14、辅助说明 12→13、标签 11→12，
// 11sp 只留给 TabBar 这类纯导航短词；字号只能由语义角色决定，组件不得自造数值。
export const font = {
  /** 一级页面标题 */
  page: 24,
  /** 启动层/引导的展示字 */
  display: 30,
  /** 统计数字 */
  stat: 26,
  /** 模块标题（区域标题、卡片标题） */
  section: 17,
  /** 任务/条目标题 */
  title: 16,
  /** 阅读面（笔记正文/摘要）：比通用正文大一号，长文本可读性优先 */
  reading: 15,
  /** 普通正文 */
  body: 14,
  /** 辅助说明 / 元信息 */
  meta: 13,
  /** 标签、胶囊、徽标文字 */
  label: 12,
  /** TabBar 等纯导航短词：唯一允许的 11sp，靠加粗与选中色保证识别 */
  tab: 11,
};
