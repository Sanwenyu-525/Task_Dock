# 01 · 视觉设计规范（v0.6）

> 适用范围：Task Dock 完整模式（400×560 基线窗口）下的全部界面元素。
> 两套视觉预设共享同一套结构与尺寸，只在**表面材质、边光、发光、圆角**上分化。
> 视觉第一依据是 `docs/ui-themes/images/` 中的两张效果图；本文把效果图翻译成可实现的 Token。

---

## 1. 设计目标与硬约束

| 目标 | 落地方式 |
| --- | --- |
| 轻盈、安静、可长期常驻 | 低饱和渐变、无外框、窄侧栏、克制的阴影 |
| 文字永远优先 | 卡片表面不透明度 ≥ 0.66（浅色）/ 中性暗底 ≥ 0.6（深色）；正文对比度 ≥ 4.5:1 |
| 两套语言但不重复代码 | 一套语义 Token，两套赋值；组件 CSS 只写一次 |
| 窄幅工具而非后台系统 | 侧栏 62px（<384px 时 46px 仅图标），不做宽屏侧边栏 |
| Windows 真实可用 | 原生材质 + Win32 圆角区域；CSS 只做可控的视觉近似 |

**不做的事**：彩虹渐变、大面积彩色装饰、常驻动画、全窗口 `backdrop-filter`、为截图而牺牲列表密度。

---

## 2. 统一结构

```
┌──────────────────────────────────────────────┐
│ 标题栏  orb · 状态点 · Task Dock   菜单/窗口键 │  36px
├──────┬───────────────────────────────────────┤
│ 导航 │ 内容区                                 │
│ 62px │ 统计 → 快速添加 → 筛选 → 列表           │
│      │                                        │
│  +   │                                        │
└──────┴───────────────────────────────────────┘
```

- 窗口圆角：梦幻渐变 `18px`，液态玻璃 `20px`（同时下发给 Win32 区域裁剪）。
- 标题栏与内容区之间**没有分隔线**，靠留白与层级区分；导航轨与内容区之间没有硬边框，只有一层极淡的渐变底。
- 导航轨宽度固定，不随内容伸缩；窄窗时只隐藏文字，不改变图标尺寸。

### 尺寸基线（逻辑像素）

| 元素 | 值 |
| --- | --- |
| 标题栏高度 | 36（padding 9/6 + 内容 24） |
| 导航项 | 宽 50 / 高 46，圆角 12，图标 18，标签 9.5 |
| 统计卡 | 高约 39，圆角 13，单行「数值 20/600 + 标签 11.5」，无图标；≤384px 18/11 |
| 快速添加行 | 高 34，圆角 9，按钮 8/600/11 |
| 筛选药丸 | 高 24，圆角 7/9，字号 11 |
| 任务卡 | 圆角 13，无左色条（方案 D，见 §12），标题 12.5/500 |
| 设置分组 | 圆角 13，内边距 12 |

---

## 3. Token 体系

Token 定义在 `src/styles-themes.css`，命名沿用 v0.5 的语义变量（`--surface-*`、`--border-*`、`--accent*`），
新增材质与层级变量。**新增变量一律以「用途」命名，不以颜色命名。**

### 3.1 层级

| Token | 用途 |
| --- | --- |
| `--window-fill` | 窗口底（渐变或半透明渐变，可被原生材质透出） |
| `--window-edge` | 窗口内边光（替代 1px 外框） |
| `--decor` | 背景装饰层（单个伪元素上的 4 个径向渐变） |
| `--card-face` / `--card-shadow` | 一级表面：统计卡、任务卡、设置分组 |
| `--control-face` / `--control-shadow` | 二级表面：输入框、快速添加、预设卡 |
| `--pill-face` / `--pill-active-*` | 分段控件容器与选中药丸 |
| `--rail-*` | 导航轨：底、悬停、选中、指示条 |
| `--accent-gradient` | 主按钮（解析/创建） |
| `--orb-gradient` / `--orb-face` | 品牌球与空状态气泡 |

### 3.2 圆角与间距

| Token | 梦幻渐变 | 液态玻璃 |
| --- | --- | --- |
| `--radius-window` | 18 | 20 |
| `--radius-card` | 13 | 13 |
| `--radius-control` | 9 | 9 |

间距节奏：4 / 6 / 8 / 10 / 12。统计卡容器间距 7、卡内数值与标签间距 6，内容区左右内边距 10，导航轨内边距 6。

---

## 4. 预设 A · 梦幻渐变（Dream Gradient）

**关键词**：柔和蓝紫粉、无明显外框、轻量毛玻璃、柔和悬浮、低对比装饰。

### 4.1 色板（浅色）

| 角色 | 值 |
| --- | --- |
| 窗口渐变 | `#FBFCFF → #F5F3FF (34%) → #FDF4FA (68%) → #F7FAFF`，158° |
| 装饰 | 蓝 `#BED6FF` / 紫 `#D4CBFF` / 粉 `#F9D5EA`，径向渐变，仅出现在四角 |
| 主文本 | `#22263C`（对比度 12.4:1） |
| 次文本 | `#59607A`（7.0:1） |
| 弱文本 | `#8A90A8`（4.6:1） |
| 强调 | `#6366F1`，悬停 `#4F46E5`，弱底 `rgba(99,102,241,.10)` |
| 卡片 | 白 86% → 62% 竖向渐变 + `0 0 0 1px rgba(255,255,255,.6)` + 柔紫阴影 |
| 选中导航 | 淡紫药丸 `rgba(99,102,241,.14→.08)` + 左侧 2.5×20 指示条 |

### 4.2 深色

窗口 `#171A2B → #1E1728`，装饰降到 28–38% 不透明，卡片 `rgba(255,255,255,.075→.035)`，
主文本 `#E9EAF6`，强调 `#A5A8FF`。深色下**不使用彩色投影**，只用 1px 白色低透明描边表达层级。

### 4.3 交互

- 悬停：卡片内亮 1 级 + 阴影加深（不位移）。
- 按下：`scale(.98)`（`prefers-reduced-motion` 下取消）。
- 选中：药丸底色 + 文字转强调色 + 加粗；**不使用彩色描边**（避免双层边框感）。

---

## 5. 预设 B · 液态玻璃（Liquid Glass）

**关键词**：通透、边缘高光、内部反射、玻璃胶囊、柔和光晕、蓝紫粉微妙过渡。

### 5.1 真实与模拟的分界（重要）

| 效果 | 实现 | 性质 |
| --- | --- | --- |
| 桌面透出与模糊 | Windows Mica（Win11 ≥22000）/ Acrylic（Win10 ≥18034），由 `window-vibrancy` 应用 | **真实原生材质** |
| 窗口圆角裁剪 | `SetWindowRgn(CreateRoundRectRgn)` + `DWMWA_WINDOW_CORNER_PREFERENCE` | **真实原生** |
| 半透明 tint、渐变、内高光、色散边 | CSS 渐变与多重 `box-shadow` | CSS 模拟 |
| 玻璃胶囊、柔光选中、气泡折射 | CSS 渐变 + 内阴影 + 外发光 | CSS 模拟 |
| 实时折射 / 位移模糊 | 未实现 | 明确不做（见 04 性能） |

> 我们不声称用 CSS 复刻 macOS Liquid Glass。这里的「液态玻璃」是**在 Windows 原生材质之上**，
> 用可控的 CSS 层还原其视觉语言（通透、边光、胶囊、柔光）。

### 5.2 色板（浅色）

| 角色 | 值 |
| --- | --- |
| 窗口 | `rgba(255,255,255,.84) → rgba(242,245,255,.72) → rgba(252,241,250,.74)` |
| 卡片 | 白 86% → 74% → 66% + `inset 0 1px 0 rgba(255,255,255,.92)` |
| 选中胶囊 | 白 82% → 55% 竖向渐变 + `inset 0 1px 0 #fff` + 柔紫外发光 `0 6px 16px -8px rgba(99,102,241,.5)` |
| 主文本 | `#232840` / `#565D78` / `#767D96` |
| 强调 | `#6366F1`，渐变按钮 `#8F8FF8 → #6366F1 → #A855F7` |
| 品牌球 | 锥形渐变（蓝紫粉青），模拟玻璃球体色散 |

### 5.3 深色

窗口 `rgba(34,38,58,.84) → rgba(24,31,49,.84)`；卡片 = 白色 15% 高光层叠在 `rgba(40,45,66,.72)` 中性暗底上
（**关键**：先给中性底再叠白，避免壁纸颜色把卡片染绿/染黄）；主文本 `#EDEFFA`。

### 5.4 降级规则

| 触发条件 | 表现 |
| --- | --- |
| 原生材质不可用（Win10 早期/被策略禁用） | `data-material="solid"`，窗口不透明度提到 96–97%，卡片 88–95%，玻璃语言保留 |
| 系统「减少透明效果」 | 同上，并清除原生效果 |
| 高对比度 | 装饰层隐藏（`--decor-opacity:0`），卡片改实心，边框改 `currentColor` |
| 减少动态 | 只保留颜色/阴影过渡的 0 时长切换，取消位移与缩放 |

---

## 6. 组件规范

### 6.1 导航（两套共用结构）

- **六个入口**：任务 / Agent / 行动 / **剪贴板** / 历史 / 设置，顺序取自
  `useUiStore` 的 `TAB_ORDER`（导航渲染与 Ctrl+1…6 共用同一份定义）。
- 图标 18px，线性 `stroke-width 1.75`；标签 9.5px，行高 1.1，居中。
- 选中：梦幻=淡色药丸 + 左侧指示条；液态=玻璃胶囊 + 内高光 + 柔光。
- 徽标：右上角 13px 圆形，错误色（需介入）或强调色（待完成），1.5px 与底同色的描边。
- 底部「添加」用分隔线与主导航分开，悬停转强调色。
  （2026-11-01 调整：底部入口改为**纯图标方形按钮**——去掉「添加」文字，加号不再带
  强调色圆角底块，直接居中于按钮面（白色高光面）；悬停只换按钮面与图标色。可访问名仍由
  `aria-label="快速添加任务"` 提供，`data-tip` 保留。）
- **低高度时导航区可滚动**，但六个入口必须全部可达，且不得遮挡底部「添加」——
  由 `scripts/layout-regression.mjs` 的 `elementFromPoint` 命中测试守住。
- 窄窗（≤ 384px）收起为纯图标轨，可访问名由 `aria-label` 兜底。

### 6.2 统计卡

三卡等宽等高（`flex:1`），单行水平居中：左侧数值、右侧标签；**数值前不再放图标**
（图标语义与标签重复，已移除）。

- 数值 20px / 600 / 行高 1.1，`font-variant-numeric: tabular-nums`，0→999 切换不抖动；
  窄窗（≤384px）降为 18px，不继续无限缩字号。
- 标签约 11.5px / 行高 1.2，`--text-secondary`，单行 `nowrap` + 省略号，不换行撑高卡片；
  窄窗 11px。
- 数值与标签同基线（`align-items: baseline`），间距 6px，窄窗收 4px；
  卡内 padding 9/4/8，窄窗 8/2/7。
- 默认全部中性色（数值 `--text-primary`、标签 `--text-secondary`）；
  **仅逾期 >0 时数值转 `--status-error`**，0 值不加 `warn` 类，也不靠图标或描边强调。
- 与其它一级表面共用 `--card-face` / `--card-shadow`，不加额外阴影或边框；
  逾期卡是按钮（`role="button"`），Enter / Space 可激活，点击目标 ≥22×22。

### 6.3 快速添加

单行胶囊容器：左侧星标图标 → 输入 → 主按钮。
主按钮使用 `--accent-gradient`，`inset 0 1px 0 rgba(255,255,255,.4)` 顶高光；液态玻璃下按钮同样走渐变（玻璃语言里的"实体玻璃珠"）。
解析结果预览沿用 v0.5 结构，仅换表面。

### 6.4 筛选

- 主行：5 个日期视图，容器 `--pill-face`，选中白药丸 + 强调文字。
- 次行：状态组容器透明，选中为半透明白药丸；排序为白药丸样式的 `Select` 基元
  （**不再使用原生 `<select>`**，见 08 交互规范）。
- 两行合计高度 ≤ 56px，不占常驻搜索框高度。

### 6.5 空状态

纯 CSS/SVG 插画：主气泡（62px，内高光 + 底部反光 + 外发光）+ 4 个卫星气泡 + 2 个星芒 + 底部云团。
全部为静态渐变，**无位图、无动画、无 `backdrop-filter`**；深色下降低白色不透明度并加强描边。

### 6.6 预设选择卡（设置页）

两列卡片：上部 44px 迷你界面预览（含侧轨、三张卡、一行列表），下部名称 + 一句定位。
选中态：`0 0 0 1.5px accent` 环 + 右上角实心圆点。悬停 `translateY(-1px)`（减少动态下取消）。

### 6.7 浮层（菜单 / 下拉 / 弹窗 / 提示条）

两套预设共用**同一套 DOM 结构与行为**，差异只落在 Token 上。

| 层 | 梦幻渐变 | 液态玻璃 |
| --- | --- | --- |
| 表面 | 柔和浅色背景，10–12px 圆角，轻投影，**无明显黑边** | 半透明玻璃面 + 细内高光 + 边缘轻微反射 |
| 选中态 | 淡紫 | 蓝紫柔光 |
| 描边 | 极淡（`--menu-border`） | 边缘反射线，非实心边框 |

硬性约束：

- **弹层表面必须不透明**（`--menu-face` / `--dialog-face` 不带 alpha）。
  玻璃感来自高光与边缘反射，**不是**半透明盖在深色正文上。
- **不对整个弹出菜单叠加实时 `backdrop-filter`**：菜单里只画一层静态渐变/高光。
  实时模糊铺满整个菜单在高 DPI 下代价极高，且会拖垮文字对比度。
  这两条由 `src/styles-themes.test.ts` 守住。
- 选中态不能只靠颜色，必须有形状或图标佐证（如勾选标记）。
- 浮层圆角、阴影、进场动效由 Token 驱动；两套预设共用同一份动效时长。

---

## 7. 可读性红线

1. 正文/标题对比度 ≥ 4.5:1，辅助文字 ≥ 4.5:1（弱化但可读），禁用纯装饰性文字。
2. 任何半透明表面上，正文不得直接压在壁纸色上：卡片必须有不透明基底（≥ 0.6）。
3. 字号下限：正文 12.5，辅助 10，导航标签 9.5（仅用于 ≤4 字的导航标签）；
   统计卡标签 ≥11（当前 11.5，窄窗 11）。
4. 点击目标 ≥ 22×22（标题栏图标 24，导航项 50×46）。
5. 深色主题下不使用纯黑 `#000` 与纯白正文 `#fff`（避免光晕与硬边）。

---

## 8. 与效果图的已知差异

| 效果图 | 实现 | 原因 |
| --- | --- | --- |
| 窗口外有明显投影 | 无外投影，改用内边光 + 底部内阴影 | 透明窗口在 Win32 圆角区域裁剪后，外部阴影会被裁掉（03 详述） |
| 侧栏宽约 78/700 | 62/400 | 窄幅工具，需给统计卡与筛选留空间 |
| 卡片几乎全透明 | 浅色 86%→66% | 真实壁纸下文字对比度会失效（用户明确禁止牺牲可读性） |
| 空状态有折射高光 | 渐变模拟的静态高光 | 实时折射需要 WebGL/着色器，收益不抵性能风险（04 详述） |

---

## 9. color-mix 常量化重构（2026-10-31 追加）

`src/styles-themes.css` 已从「手写 rgba」重构为「基础色常量 + `color-mix` 派生」（本次不改任何
视觉值；上文第 4/5 节的色板字面量仍为有效渲染值，读法见下）：

- **常量**：每个「预设×明暗」主组合块头部声明 `--c-paper / --c-night / --c-ink / --c-accent /
  --c-accent-deep / --c-danger` 六个基础色；其余块（弹层/胶囊/降级/结构层）经 CSS 级联引用。
  **全站改色从这些常量开始**（如液态玻璃 accent 冷调化这类改动，预期只改常量行）。
- **派生公式**：`rgba(C, a)` ≡ `color-mix(in srgb, var(--c-x) N%, transparent)`（N = a×100），
  sRGB 混透明渲染严格等价；本文各色板表的 `rgba(…)` 字面量此后应读作「对应常量 + 该百分比」。
- **token 别名**：值与常量相等的 `--accent / --icon-accent / --rail-active-bar / --accent-hover /
  --pill-active-text / --rail-active-text / --menu-active-text / --menu-danger` 已改写为
  `var(--c-*)` 引用。
- **保留手写字面量**（有意不常量化）：一次性装饰渐变 stop（--window-fill/--decor/--orb-gradient
  等艺术层）、阴影色相（钢蓝系，如 `72,82,160`）、accent 变体（`129,140,248` / `139,124,246` /
  `148,162,255`）——单次使用强转常量只增加间接层；这些随艺术层手调。
- **边界**：跨预设/裸 `:root` 上下文只派生 paper/night（全预设同值）；accent/ink/danger 分预设
  变值，仅在选择器精确锁定单一「预设×明暗」的块内派生。
- **等价性证据**：转换前后 804 条声明逐 (上下文, 变量) 归一化比对 0 差异
  （`tmp/acceptance/agent-alert-colormix-20261031/verify-parity.mjs`，2026-10-31 运行，退出码 0）。

---

## 10. 圆角半径对齐与主窗滚动条（2026-10-31 追加）

- **圆角对齐**：`--radius-window` 必须与 `PRESET_WINDOW_RADIUS`（`lib/theme.ts`，逻辑像素）
  一致——它是**可见**圆角。液态玻璃显式声明 `--radius-window: 20px`（dream 为 18px），
  两套预设都声明该 token（`styles-themes.test.ts`）。
  **2026-11-01 更正**：原生 Win32 区域半径 = CSS 物理半径 **− 2px**（`REGION_AA_INSET`），
  不再要求与 CSS 相等。`SetWindowRgn` 无抗锯齿；等半径时 GDI 硬边会切进 WebView 的平滑弧线，
  形成「第二圈阶梯状轮廓」。内收后区域是 CSS 圆角的透明超集，可见外轮廓与主题覆盖只由
  CSS 弧线定义；四角 ≤2px 透明命中区。
  **2026-11-01 晚更正（本条前半段被真机推翻）**：内收方案仍会与 DWM 的圆角裁剪相交，
  留下透明月牙与内圈阶梯。主窗已改为 **整窗矩形区域 + `DWMWCP_DONOTROUND`**，可见圆角
  完全由 CSS 18/20px 抗锯齿弧定义（渐变覆盖到边缘）。`--radius-window` 仍是唯一定义
  「可见圆角」的 token；胶囊/右键菜单弹窗继续用区域裁剪。
  **2026-11-01 深夜二轮更正（矩形方案被真机推翻，恢复圆角区域）**：整窗矩形区域在非激活态
  会让 WebView2 按窗口矩形回填白色，灰底 200 下四角出现纯白三角。主窗改为
  **逐行像素支撑区域**（`main_region_rgn()`：`css_support_left` 按行取 CSS 圆角触及的
  首个像素，连续行合并为矩形并集）+ `DWMWCP_DONOTROUND`：区域恰好覆盖 CSS 抗锯齿支撑
  形状、不覆盖透明像素，定义真实原生圆角，CSS 只负责抗锯齿边缘；删除
  `WM_NCHITTEST` 子类化。DWM 原生圆角固定 8 DIP，无法满足 18/20px 设计半径。
  `--radius-window` 仍驱动 CSS 填充/边光/描边层，改预设时同步下发 `apply_window_radius`。
- **主窗滚动条**：内容滚动容器使用透明轨道 + 6px 圆角 thumb
  （`styles.css` `.dock-window ::-webkit-scrollbar`，thumb =
  `color-mix(in srgb, var(--text-tertiary) 35%, transparent)`），与右键菜单同款；
  默认系统滚动条的亮灰轨道会在圆角窗口边缘形成白色竖条。滚动能力不隐藏。
- **幽灵溢出**：≤384px 窄窗断点的导航轨间距由 3px 收到 2px，消除 340px 高窗口下
  `rail-items` 只滚 2px 的原生滚动条（等同于 context-menu 的 +2px 容差先例）。
- **glass 原生材质（2026-10-31 晚更正）**：Win11 + 区域裁剪时 Mica/Acrylic 与 legacy
  blur 都会越过区域圆角留下暗楔，默认后端改为 `css`（不挂原生材质）；玻璃由
  `--window-fill` 的半透明渐变承担（liquid 76–86% 不透明，dream 为不透明）。
  `data-material=glass` / `data-native-glass=true` 保持不变，设置页文案标注
  「CSS 半透明玻璃（原生模糊已停用）」。

---

## 11. 立体材质层（2026-11-01 追加）

目标：在既有「预设 × 明暗 × 材质」体系上补齐**高度层级**，让窗口、卡片、控件与浮层
有可感知但克制的前后关系；不新增第三套主题，不改组件结构与业务逻辑。

### 11.1 四层高度

| 层 | 承载对象 | 视觉表达 |
| --- | --- | --- |
| Window | `.dock-window` | 顶部受光 + 1px 内边光 + 底部内侧厚度；无窗口外投影（见 03 §4） |
| Surface | 统计卡 / 任务卡 / 剪贴板卡 / 历史卡 / 行动卡 / Agent 区块 / 设置分组 | 顶部内高光 + 底部沉降 + 低透明外投影 |
| Raised | 导航选中胶囊、选中药丸、主按钮、预设卡 | 顶高光 + 外环 + 更实的近距投影；选中上浮 1px |
| Overlay | 菜单 / 下拉 / 弹窗 / Tooltip | 不透明表面 + 更强羽化投影；不叠加实时模糊 |

**方向性约定**：光源在左上。凸起表面「顶部亮、底部暗」；输入容器反过来做**内凹**
（顶部沉降 + 底部反光）。按下时阴影切换为内凹并回落 0.5px，形成短暂压入反馈。
`prefers-reduced-motion` 下取消位移与缩放。

### 11.2 新增与改写的 Token

四个「预设 × 明暗」上下文都声明同一套名称（`styles-themes.test.ts` 新增守卫）：

| Token | 用途 |
| --- | --- |
| `--header-wash` | 标题栏顶部受光带（静态渐变，不随滚动/时间变化） |
| `--inset-face` | 输入容器/独立文本控件的内凹表面 |
| `--inset-shadow` / `--inset-shadow-hover` / `--inset-shadow-focus` / `--inset-shadow-sm` | 内凹层级（默认 / 悬停 / 聚焦 / 小面积） |
| `--shadow-overlay` | 弹窗、确认框、吸附反馈条的浮层投影 |

同时改写既有 Token 的取值：`--window-fill`（四角氛围光 + 底部光）、`--window-edge`
（四层内边光）、`--card-face` / `--card-shadow(-hover)`、`--control-shadow(-hover/
-press/-focus)`、`--rail-active-face` / `--rail-active-shadow` / `--rail-active-bar`、
`--pill-active-face` / `--pill-active-shadow`、`--menu-shadow` / `--dialog-shadow`、
`--orb-shadow`。组件 CSS 不复制，只消费 Token；结构覆盖集中在 `styles-themes.css`
第 15 节「立体材质层」。

### 11.3 两套预设的材质差异

| 项 | 梦幻渐变 | 液态玻璃 |
| --- | --- | --- |
| 窗口 | 蓝紫粉四角氛围光叠在不透明底上（浅色）/ 深靛紫底（深色） | 冰蓝白半透明渐变 + 冷色氛围光；`--decor` 增加一条**静态斜向折射光带** |
| 卡片 | 白 94%→74%（浅）/ 白 9.5%→3.5%（深），柔和紫/黑投影 | 白 93%→76%（浅）/ 冷板岩 60%→52%（深），顶部高光 + 冷蓝投影 |
| 透明度收敛 | 不透明 | 浅色 0.88–0.95、深色 0.90–0.93（较 v0.6 的 0.76–0.86 更「实」，降低壁纸文字透出） |
| 弹层 | 不透明表面 + 紫调投影 | 不透明表面 + 冷调投影 + 内高光 |

> **仍然不做**：窗口外投影（透明窗口区域裁切会吃掉外阴影）、全窗口 `backdrop-filter`
> （WebView2 中代价高且无法模糊窗口背后的桌面）、常驻光影动画。玻璃的「模糊感」由
> 半透明 tint + 静态高光承担，不声称等同原生 Mica。

### 11.4 生效范围

任务 / Agent / 行动 / 剪贴板 / 历史 / 设置六个页面，标题栏、左侧导航、筛选药丸、
快速添加、剪贴板搜索与条目卡、菜单/下拉/对话框/Tooltip、吸附反馈条，以及胶囊**面板**
与选中态。胶囊轨道表面在并行会话中正由 `CapsuleWing` 的 SVG 轮廓接管，本轮的 Token
（面板阴影、选中态、图标底）继续生效，但轨道外形以该并行变更为准；胶囊仍要求
「根窗口透明、胶囊自身不透明底」的分层关系不变，本轮不改 `--capsule-face` 的实色约束。

### 11.5 验证口径

- 浏览器 harness（不代表原生窗口）：四组合任务/剪贴板/设置/菜单静态走查；
  `scripts/theme-perf.mjs` 2026-11-01 最终构建后实测空闲 3s 主线程 4.9–5.7ms、0 次布局、
  8–10 次样式重算、0 个 `backdrop-filter`、0 个 CSS filter；主题切换 20 次 39.5–45.5ms。
- 原生窗口：四组合已在真实 Tauri 窗口（debug 构建 + 隔离数据目录）截图；受控纯色背景
  像素分析因当前会话存在其他置顶窗口，基线无效 → 圆角像素判定记 `UNVERIFIED`，
  不以 `GetWindowRgn` 成功代替。胶囊/吸附状态机的完整交互回归受并发实例与并行
  `CapsuleWing` 重设计影响，本轮不重复验证，见任务验收报告。

---

## 12. 任务卡方案 D · 柔和分层玻璃卡（2026-11-02 追加）

任务卡重绘（任务卡效果图方案 D），只改视觉与交互反馈，不改任务面板结构与业务逻辑。
本节取代此前「任务卡带常驻左色条」的旧规范（尺寸基线表已同步更正）。

### 12.1 视觉

- **优先级色条移除**：`.task-item` 不再有 `border-left` 色条（base 层与 theme 层的
  `.task-item.priority-*` 规则已删除）。同一优先级连续排列不再出现连续色线。
- **优先级唯一载体是 `.priority-tag`**：P0 红 / P1 橙 / P2 蓝 / P3 中性灰，
  语义色沿用 `--p0`…`--p3`；不通过整卡背景色、色点或色条重复表达。
- **卡面材质**：`background: var(--task-flow), var(--card-face)` ——
  新增任务卡专用 Token `--task-flow`（四个「预设 × 明暗」上下文各一份取值，
  `styles-themes.test.ts` 令牌同名守卫覆盖）：静态双渐变（右下径向 + 斜向线性），
  形成「中部向右侧渐起」的轻微流线光带；dream 偏紫罗兰、liquid 偏冰蓝，深色降 alpha。
  顶部内高光、底部沉降与 1px 边缘反射继续由 `--card-shadow` 承担，卡间用间距 + 轻阴影区分。
- 不新增伪元素、常驻动画、`backdrop-filter`；高对比度（`prefers-contrast: more`）下
  `--task-flow` 收敛为 `none`。

### 12.2 交互态

| 状态 | 规范 |
| --- | --- |
| 默认 | 稳定玻璃面，无常驻选中标记；卡片本体无单击动作，不伪装成按钮 |
| Hover | `--card-shadow-hover` 抬一档 + 上浮 1px（第 15 节约定）；隐藏快捷操作（编辑/上下文）按既有 hover/focus-within 逻辑显现；过渡 120–160ms |
| Pressed | 只落在真实控件：完成按钮与关联目标按钮轻微缩放（0.9 / 0.94），图标按钮沿用 `.icon-btn:active` 的 0.94 缩放；不给整卡按压缩放 |
| 键盘焦点 | 全局 `:focus-visible` 焦点环；`:focus-within` 显现隐藏快捷操作（既有机制），鼠标 hover 与键盘焦点共用显现逻辑但不共用选中态高亮 |
| 完成态 | 勾选圈变绿 + 打勾，标题删除线；整卡 opacity 0.72 弱化但保持可读；完成后在默认「未完成」筛选下退出列表（Toast 撤销机制不变） |
| 逾期态 | 仅 `.task-due.overdue` 用 `--status-error`；整卡不染红、无常驻闪烁动画；完成后的任务不再带逾期强调（`isOverdue` 只对 pending 生效） |

编辑进入方式不变：双击 `.task-main` 或编辑按钮打开 `TaskEditor`；不做卡片内联编辑。
关联目标图标、任务上下文、工作区启动按钮的按压反馈与跳转行为不变。

### 12.3 验证口径

- 自动化：`src/components/tasks/TaskItem.test.tsx`（完成/失败 Toast、双击与按钮编辑、
  上下文、关联目标只导航、busy 防连点）+ `styles-themes.test.ts` 令牌同名守卫。
- 浏览器 harness：四组合静态走查 + computed style 断言（`border-left-width: 0px`、
  逾期色 `rgb(239,68,68)`、未逾期为 tertiary 灰）、Tab 焦点路径、`prefers-reduced-motion`
  下 transform/transition 收敛、高对比度下 `--task-flow: none`。证据见
  `tmp/acceptance/task-card-scheme-d/`。紧凑模式（380px）与 14 卡密度走查同轮覆盖。
  原生 Tauri 窗口截图未在本轮执行（预览 harness 与原生窗口的窗面合成差异已知，
  任务卡为内容层组件，不受窗口材质影响）。

---

## 13. 表面 Token 类型与矩形圆角（2026-11-02 追加）

### 13.1 Token 有两类，混用会静默失效

| 类型 | Token | 允许用法 |
| --- | --- | --- |
| `<image>` | `--surface-base`（= `--window-fill`）、`--surface-raised`（= `--card-face`）、`--control-face` | 只做整面 `background` / `background-image` |
| `<color>` | `--surface-overlay`、`--accent-soft`、`--border-*`、`--text-*`、`--status-*` | 可进 `color-mix()`、可作 `border-color` / `background-color` |

两套预设下 `--surface-base` / `--surface-raised` 解析成多层径向渐变，**不是颜色**。把它们
写进 `color-mix(…, var(--surface-base))` 会在 computed-value time 变非法值，CSS 直接丢弃
**整条声明**——没有报错、没有回退，元素实际「没有底色」。`color-mix` 的第一个参数和后续
参数一样受限，`color-mix(in srgb, var(--accent) 10%, var(--surface-raised))` 同样失效。
半透明底一律从 `<color>` token 出发（`--surface-overlay` / `--accent-soft` /
`color-mix(… var(--accent) N%, transparent)`）。

- 状态变体（`.warn` / `.danger` 等）只补 `background-color`，让基类的 `--surface-raised`
  高光层继续存在；写成 `background:` 简写会连带抹掉高光层。
- 回归守卫：`src/styles-themes.test.ts` 的 `imageTokenInColorMix()`（按括号深度精确取
  `color-mix()` 实参，不用跨声明的正则，避免误判 `linear-gradient(color-mix(…)…, var(--window-fill))`
  这类合法的「渐变里嵌透明混色」写法）扫描三个样式文件，禁止 `<image>` token 入 `color-mix()`。

### 13.2 小控件不用窗口渐变当局部底

`--surface-base` 是**窗口级**四层氛围光渐变。把它设给一个 24px 高的输入框或小卡片，等于
把整窗渐变压缩进该盒，色块与窗口任意局部都不一致。局部表面按层级选：
窗口面 `--surface-base` → 卡片/区块面 `--surface-raised` → 控件面 `--control-face` /
`--accent-soft` → 浮层 `--surface-overlay`。已有全局 `input` 规则
（`src/styles.css:183-195`）负责背景/描边/圆角并在 hover/focus 升级到 `--border-strong`，
行内特化只改字号与内距，不重抄这四条。

### 13.3 圆角跟「表面边界」走，不跟「元素类型」走

- **左右留白 ⇒ 它是独立表面** ⇒ 四角必须切：区块级用 `--radius-card`，条/控件级用
  `--radius-control`（吸顶日标签、批量条、详情头、拆分条、完整页提示条同族）。
- **通栏贴到容器边缘 ⇒ 它是连续容器的一部分** ⇒ 保持直角（抽屉内提示条、贴边标题栏）。
- 加了 `margin-left/right` 就必须同时加 `border-radius`；只留白不切角会在留白里悬一块
  直角矩形，比全直角更突兀。
- 不是所有矩形都是问题：胶囊（`--radius-pill` / 999px）、状态微标签、原生裁切的 SVG 轨道
  按自身功能规范处理，不并入上述族；也不给所有组件统一加 `border-radius` 或
  `overflow: hidden` 掩盖根因。
- `.clip-tabs` 的下划线式选中态与紧邻其下的分段药丸筛选行**刻意不同形**：都改成药丸会让
  两行外观几乎重复、层级反而更难读。视图切换用下划线、筛选器用分段药丸是现状规范。

### 13.4 吸顶行自带不透明底

滚动容器内 `position: sticky` 的行必须有高不透明度底色（`--surface-overlay`，四套预设×明暗
均 ≥92%）才能挡住穿过它滚动的卡片。不要用 `backdrop-filter` 代替遮挡：它让每个常驻吸顶行
多一层 GPU 模糊，且在 `material-solid` 下语义错误。吸顶行需要全出血时用负 `margin` +
等值负 `top`，并只写一次 `padding`。

---

## 14. 全局卡片基础表面 · surface-card（2026-11-04 追加）

把「一套卡面」从各页面收回到 theme 层：页面只保留信息结构、尺寸与状态色。
`.task-card` 不删除、不批量改引用，作为兼容别名并入基础规则。

### 14.1 三层职责

| 层 | 类 / Token | 负责 | 不负责 |
| --- | --- | --- | --- |
| 基础 | `.surface-card` | `--radius-card`、`--card-face`、`--card-shadow`（顶部内高光 / 底部沉降 / 1px 边缘反射）、默认过渡 | 高度、内边距、布局、是否可点击 |
| 方案 D 变体 | `.surface-card--task` | 在卡面上叠加静态流线高光 `--task-flow`，只给任务 / 规划族 | 不默认下发给其它卡片 |
| 交互变体 | `.surface-card--interactive` | 真·整卡可点击：`cursor`、hover 阴影 + 1px 抬升、键盘焦点 outline；离开动画（`.leaving` / `.is-leaving`）期间不位移 | 不改变选中态 |
| 交互变体 | `.surface-card--selected` | 真选中：`--accent-soft` 衬底 + `0 0 0 1px var(--accent)` 识别环，深度保持默认值 | 不覆盖业务状态色 |

基础类不写 `height / padding / overflow / display`，所以同一材质可以服务应用瓦片，也可以
服务多行历史卡：**统一材质 ≠ 统一尺寸**，卡片间距、列数与按钮布局仍按各自页面。

### 14.2 新页面接入方式

1. 卡根节点追加 `.surface-card`，删掉自己的 `border-radius / background / border / box-shadow`；
2. 整卡可点击 → 再加 `--interactive`；整卡不可点（按钮都在卡内）→ 只留基础类，不伪造 hover 抬升；
3. 可选中 → 选中时追加 `--selected`，与 hover 分开表达；原 `selected` 业务类可保留作状态钩子；
4. 只有任务 / 规划族用 `--task`，其它卡片保持纯玻璃卡面；
5. 卡自身的 `padding / gap / flex / 状态色 / 动画生命周期` 继续留在业务选择器里。

### 14.3 历史日期分组（吸顶标签）

日期分组统一为**居中文字 + 两侧 1px 细线**的分隔形态（今天 / 近 3 天 / 近 7 天 / 具体日期同一套）：

- `.history-day-label` 是 `sticky; top: -10px` 的 flex 行，`::before` / `::after` 各为一条
  `flex: 1 1 0`、`height: 1px`、`background: var(--border-subtle)` 的细线，等长延展到容器左右边缘，
  与文字垂直居中对齐（`align-items: center`）；文字左右各留 10px 间距。
- 标签容器**不铺整行底色，文字块也不带局部底**（`.history-day-label-text` 只有 `padding`、
  无 `background` / `border-radius`），文字用 `--text-secondary` 保持正文级对比。
- 吸顶遮挡由整条 `.history-day-label-mask` 负责：`position: absolute; inset: 0; z-index: -1`，
  以 `--capsule-face`（四套预设×明暗均不透明的窗口底）兜底，再以 `background-attachment: fixed`
  在固定视口坐标重绘 `--window-fill` 窗口渐变，`::before` 复刻 `--decor` 并按预设自身的
  `--decor-opacity` 衰减。固定坐标系与占满视口的 `.dock-window` 一致，因此不会与周围出现色带或接缝。
- `top: -10px` 抵消 `.tab-content` 的 `padding-top`：`top: 0` 会把标题钉在滚动区可视顶端下方 10px，
  滚上去的卡片从这条缝里露出来（与 `.clip-detail-head` 同一手法）。`top` 只在吸附时生效，不改正常流布局。
- 取舍：原生材质（Mica / 桌面透出）无法用 CSS 复刻，遮罩以 `--capsule-face` 实色承接，
  因此 frosted / clear 下比周围少一点桌面色偏；dream-gradient 与 frosted 两套主预设的深浅主题均无色带。
- 不引入 `backdrop-filter`；`--surface-base` / `--surface-overlay` 分别是 `<image>` 与带 alpha 的
  颜色，不能拿来当吸顶底。
- 标签容器 `pointer-events: none`、文字块 `pointer-events: auto`：细线所在的透明带不拦截指针，
  卡片从标签下方滚过时 hover / 点击 / 焦点反馈不被吸顶遮挡挡掉。
- 320 窄窗下文字块允许收缩换行（`flex: 0 1 auto; min-width: 0`），细线保留 `min-width: 12px`，
  不会被长日期文案挤没。

### 14.4 状态语义边界（不合并成 `.active`）

| 语义 | 载体 |
| --- | --- |
| 优先级 / 逾期 | `.priority-tag`、`.task-due`（P0–P3 标签与文字色） |
| 历史未读 | `.history-unread-dot` 标题行首小圆点；不再用左侧色条（那是优先级语义） |
| 历史 hover | `.history-item:hover` 只做轻阴影 + 1px 低对比内描边，`transform: none`；列表阅读锚点不随悬停位移 |
| 暂存架勾选 / 笔记当前项 | `.surface-card--selected` 识别环 |
| 剪贴板选中 / 按下 / 删除 | 专用 `--clip-*` 材质，不走通用 `--selected` |
| 项目识别 / Agent 运行状态 / 工作流禁用 | 各自专用 class，保持原语义 |

### 14.5 保留专用材质（不迁移）

- **剪贴板** `.clip-item / .clip-group-card`：方向性高光、按下、选中、离场动画是一套专用设计，
  只共享圆角 / 阴影 Token，不接通用交互变体。
- **工具面板** `.clip-selectbar`、`.shelf-selectbar`、`.shelf-detail`、`.clip-detail-head`、
  `.picker-*`：工具 / 浮层表面，不是内容卡。
- **容器与装饰**：`.planning-project-list`（滚动容器）、`.planning-project-hero`（项目色叠层）、
  `.planning-project-item.is-active`（accent 渐变识别）。
- **控件**：`.preset-card`、`.manual-add-form`、`.app-*` 设置控件按控件规范。
- **应用瓦片** `.apps-tile`：归属应用卡片会话的独立瓦片，本轮不改。

### 14.6 已知限制

`--focus-ring` 内引用 `--surface-base`，而后者在预设下是渐变（`<image>`），
`box-shadow: var(--focus-ring)` 会在计算值阶段整条失效。新增的 `.surface-card--interactive`
改用 `outline: 2px solid var(--accent)` 保证键盘焦点可见；旧 `.task-card:focus-visible`
未改，后续统一焦点环时应改用 `<color>` 版本 Token。

### 14.7 本轮接入清单（2026-11-04）

| 模块 | 接入方式 | 保留的独立部分 |
| --- | --- | --- |
| 历史卡 `.history-item` | `surface-card` + `surface-card--interactive` | 事件类型 / 通知类型 / 时间 / 未读圆点 / 展开详情 |
| 收集箱 `.inbox-item` | `surface-card` | `.is-done` 弱化状态与信息结构 |
| 文件暂存 `.shelf-item` | `surface-card`；选中时 `surface-card--selected` | `.missing`、固定 / 收藏 / 来源徽标；拖拽与详情面板 |
| 笔记 `.notes-item` | `surface-card` + `surface-card--interactive`；当前项 `--selected` | 列表宽度、标题截断、摘要行 |
| 微件 `.widget-card` | `surface-card`（不接 `--interactive`） | 拖拽 / 尺寸网格 / 卡内控件 |
| Agent 来源 `.discovery-card` | `surface-card` | `.not-installed` 状态与来源说明布局 |

未接入：`.apps-tile`（应用卡片会话归属）、`.overview-card`（统计卡尺寸与布局差异大）、
`.planning-project-*`（容器 / 色叠层 / accent 渐变识别）、`.preset-card` 与表单控件（控件层）。

### 14.8 微件页职责与桌面表面（2026-11-05）

- **职责**：微件页 = 工作台，承载已启用微件的启停、桌面显示、置顶、尺寸、条目上限、排序与
  卡内展开配置；微件库 = 只负责添加，仅列未启用项与依赖状态，提供「添加到工作台 / 添加到
  桌面」，全部添加后只保留简洁完成态。库中不再重复管理表单。
- **卡片头部**：左侧拖动手柄 + 名称 + 必要运行态；右侧桌面显示开关、配置展开、停用。
  置顶 / 尺寸 / 条目上限 / 位置重置收进卡内展开区，不新增模态弹窗。
- **状态独立**：桌面显示开关只写 `desktop.visible`，停用只写 `enabled`；关闭看板卡片不影响
  桌面窗口，反之亦然。
- **布局**：`.widgets-grid` 使用 `align-items: start`，卡片按内容自然高度；≤620px 单列、
  ≤900px 两列、≥1180px 四列（md 跨 2 列可并排），不为填满窗口拉伸内容。
- **桌面表面**：仅在 `.wd-root` 作用域新增 `--wd-control-face / -hover / -border` 与
  `--wd-cell-face`，操作按钮、统计格改为低对比中性面 + inset 描边；主内容保持透明。
  不改全局 `--control-face` 语义，不影响主窗口按钮。
- **列表反馈**：hover 6% / active 10% 中性底，`focus-visible` 用 2px accent 焦点环，
  disabled 明确弱化；不使用 `--accent-soft` 整行实心高亮，hover 不改行高、图标与文字不位移。
- **桌面预设**：高度按内容密度收紧（today-tasks md 340×220、next-reminder 320×145、
  agent-status 340×190、quick-actions 340×126、focus-timer 300×128、efficiency 320×150）；
  预设只在新建 / 切换尺寸时生效，用户自定义尺寸优先，内容变化不触发自动 resize。
