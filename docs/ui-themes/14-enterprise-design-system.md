# TaskDock 企业级 Design System v1.0

> 2026-11-20 · 全局 UI 视觉升级设计规范与落地记录
> 适用范围：Tauri 2 桌面端全部窗口（主窗、开发工作台、文件工作区、捕获、通知、工具栏）。
> 本文是设计约束与实现事实的记录，不替代 `01-design-spec.md` 的历史材质规范；
> 两者冲突时，以本文的语义 Token 与新组件层为准，旧预设章节保留为历史参考。

## 1. 设计定位与边界

TaskDock 的气质是「安静、可信、可长时间工作的桌面中枢」，参考 Linear / Notion / Stripe Dashboard 的信息层级，而不是传统后台模板。

- **要**：白色或深色实体卡片、1px 中性边框、极轻阴影、清晰字号层级、一个品牌色只用在关键动作与选中态。
- **不要**：全屏紫色/紫色渐变、所有卡片套同一圆角+阴影+强调色、大面积半透明模糊、靠装饰制造「高级感」、只换颜色不改结构。
- **优先级**：可读性 > 一致性 > 品牌感 > 装饰性。任何材质、动画、渐变都不得牺牲文字对比与操作命中。

## 2. 色彩系统

### 2.1 中性色（Slate）

| 语义 | 浅色 | 深色 | 用途 |
|---|---|---|---|
| `--color-bg-app` | `#F5F7FA` | `#0F172A` | 窗口/页面底色 |
| `--color-bg-sidebar` | `#F8FAFC` | `#0B1220` | 导航/筛选侧栏 |
| `--color-bg-surface` | `#FFFFFF` | `#162032` | 卡片、弹窗、工具栏 |
| `--color-bg-surface-secondary` | `#F8FAFC` | `#1B2639` | 卡中卡、输入底、次级面 |
| `--color-bg-hover` | `#F1F5F9` | `#223047` | hover / 轻选中 |
| `--color-border-default` | `#E2E8F0` | `#2A3648` | 1px 分隔与卡片边 |
| `--color-text-primary` | `#111827` | `#E5EAF3` | 标题、正文主信息 |
| `--color-text-secondary` | `#475569` | `#A8B4C7` | 说明、次级信息 |
| `--color-text-muted` | `#64748B` | `#7C8AA3` | 辅助、占位、时间 |

### 2.2 品牌色（Indigo）

| 语义 | 浅色 | 深色 | 用途 |
|---|---|---|---|
| `--color-brand` | `#4F46E5` | `#818CF8` | 选中、链接、焦点环 |
| `--color-brand-hover` | `#4338CA` | `#A5B4FC` | hover |
| `--color-brand-subtle` | `#EEF2FF` | `#1E2A4A` | 轻选中底、图标底 |
| `--color-brand-text` | `#3730A3` | `#C7D2FE` | 品牌底上的文字 |

### 2.3 状态色

| 语义 | 前景 | 浅底 | 使用 |
|---|---|---|---|
| success | `#15803D` | `#F0FDF4` | 完成、在线、健康 |
| warning | `#B45309` | `#FFFBEB` | 等待、注意、临近 |
| error | `#B91C1C` | `#FEF2F2` | 失败、危险、删除 |
| info | `#1D4ED8` | `#EFF6FF` | 运行中、提示 |
| neutral | `#475569` | `#F1F5F9` | 默认徽标、未知 |

规则：状态色只表达状态，不用于装饰；同一屏内最多一个高饱和状态面。危险确认弹窗的最终按钮允许实心红，列表里的危险动作仍用描边/幽灵样式。

## 3. Token 三层结构

实现文件：`src/styles-tokens.css`，声明在 `@layer tokens`，加载顺序在 `styles.css` / `styles-themes.css` / `styles-flat.css` 之后、页面 CSS 之前。

1. **Primitive**：`--ds-slate-*`、`--ds-indigo-*`、`--ds-red-*` 等原始色阶与尺寸，不直接被业务引用。
2. **Semantic**：`--color-*`、`--radius-*`、`--elev-*`、`--space-*`、`--font-size-*`。业务只读这一层。
3. **Component**：`--btn-*`、`--input-*`、`--card-*`、`--rail-*`、`--menu-*`、`--badge-*`。组件层只读这一层，或从 Semantic 派生。

旧 Token（`--surface-*` / `--text-*` / `--accent-*` / `--card-*` / `--rail-*` / `--menu-*` / `--status-*`）全部保留为**别名**，指向新语义 Token。这样未迁移页面不需要一次性重写，也不会出现两套取值。

## 4. 字体与字号层级

| 层级 | 字号/字重 | 行高 | 使用 |
|---|---|---|---|
| Page title | 24px / 650 | 1.25 | 页面标题，每屏唯一 |
| Section title | 18px / 600 | 1.35 | 大分区标题 |
| Card title | 15px / 600 | 1.4 | 卡片标题 |
| Body | 14px / 400-500 | 1.55 | 正文、列表主信息 |
| Secondary | 13px / 400 | 1.5 | 说明、副标题 |
| Caption | 12px / 400-500 | 1.45 | 时间、计数、辅助标签 |
| Micro | 11px / 500 | 1.4 | 极小徽标、快捷键提示 |

字体栈保持系统 UI 字体：`"Segoe UI Variable", "Segoe UI", system-ui, -apple-system, sans-serif`。中文回退到系统字体，不引入网络字体。数字/构建号使用 `tabular-nums`，避免跳动。

## 5. 间距

基础刻度 4px：`--space-1:4px`、`2:8px`、`3:12px`、`4:16px`、`5:20px`、`6:24px`、`8:32px`。

- 页面左右安全边距：桌面 24px，窄窗 16px。
- 卡片内边距：`16px 18px`；紧凑列表卡 `12px 14px`。
- 卡片之间：14px（网格 gap），不低于 12px。
- 标题与内容：12px；内容与操作：10–12px。
- 表单行：12px；按钮组：8px。

## 6. 圆角与阴影

| Token | 值 | 用途 |
|---|---|---|
| `--radius-xs` | 6px | 小标签、图标底 |
| `--radius-sm` | 8px | 输入、按钮、菜单项 |
| `--radius-md` | 10px | 弹层、浮层 |
| `--radius-lg` | 12px | 卡片、区块 |
| `--radius-card` | 12px | 卡片默认 |
| `--radius-dialog` | 16px | 模态弹窗 |
| `--radius-pill` | 999px | 胶囊标签 |

阴影只做层次提示，不做装饰：

- `--elev-1`: `0 1px 2px rgba(15,23,42,.04)` — 卡片 hover/浮层静置。
- `--elev-2`: `0 4px 12px rgba(15,23,42,.10)` — 菜单、popover。
- `--elev-3`: `0 12px 32px rgba(15,23,42,.18)` — 模态。
- `--elev-4`: `0 24px 64px rgba(15,23,42,.24)` — 顶层浮层/命令面板。
- 卡片默认只用 1px 边框，不叠重阴影；禁止「每张卡都浮起来」。

## 7. 按钮

实现：`src/styles-components.css` 的 `.btn` / `.icon-btn`。

| 类型 | 高度 | 视觉 | 使用 |
|---|---|---|---|
| Primary | 32px（sm 28 / lg 36） | 品牌实心、白字、8px 圆角 | 每屏一个主动作 |
| Secondary | 32px | 白底、1px 边框、次级文字 | 常规动作 |
| Ghost | 32px | 透明、hover 浅底 | 卡片内轻动作 |
| Danger | 32px | 白底红边红字 | 列表内删除/停止 |
| Danger solid | 32px | 实心红、白字 | 确认弹窗最终确认 |
| Icon | 28/24px | 透明方块、hover 浅底 | 工具栏、卡片操作 |

规则：同一操作区不超过一个 Primary；图标按钮必须有 `aria-label` 与 `data-tip`；禁用态用显式颜色，不用 `opacity` 整体变灰；按钮文字不换行，窄窗用图标或收纳到菜单。

## 8. 输入与选择器

- 文本输入统一 32px 高、8px 圆角、1px 边框、12px 左右内边距；textarea 8/10px。
- 聚焦：`0 0 0 1px var(--color-brand), 0 0 0 3px rgba(79,70,229,.14)`，不使用外发光。
- 错误：边框 `--color-error-border`，下方 12px 错误文案，禁止只靠红色。
- Select / Combobox / DatePicker 共用 `.ui-select-trigger` 高度与边框；禁用态保留文字对比。
- 搜索框统一放大镜图标 + 占位文案；全局搜索使用命令面板，不在页面里重复造搜索。

## 9. 卡片

- 白/深色实心面，1px 中性边框，12px 圆角，`padding:16px 18px`。
- 卡片标题 15px/600，右侧最多一个次级动作或计数；标题与内容间距 12px。
- 一张页面里允许三种层次：页面底（app）、工作区面（surface）、卡中卡（surface-secondary）。不允许第四种近似白。
- 禁止所有卡片同阴影、同强调色；状态卡用左侧 2px 色条或小徽标，不整卡染色。

## 10. 导航

- 工作台导航默认 200px，可拖拽 72–320；低于名称所需宽度收成 72px 图标轨；选中项用 `--color-brand-subtle` 底 + `--color-brand-text` 字，不使用整行紫色实心。
- 行高 40px；图标 18px，文字 13px；分组标题 11px/500，颜色 `--color-text-muted`。
- 图标轨宽 72px（2026-11-20 从 96 收紧）：图标水平垂直居中，手柄与 × 为行内浮层、悬停才显现；分组标题压成 1px 分隔线；名称由 tooltip 补足。
- 窄窗 ≤560px 固定 72px 图标轨，隐藏拖拽热区；名称由 tooltip 补足。
- 页面内筛选栏使用 `--color-bg-sidebar`，与主内容用 1px 边框分隔；不铺渐变。

## 11. 顶部工具栏

- 高度 48px，实色 `--color-bg-surface`，底部 1px 边框；不使用半透明+模糊。
- 左侧品牌/项目选择，中央全局搜索，右侧主动作 + 工具图标 + 窗口控制。
- 主要动作用 Primary，工具图标 Ghost；同一行不超过一个高饱和块。
- 窄窗隐藏非必要工具，项目选择折到第二行；不允许横向滚动。

## 12. 弹窗与浮层

- 模态：`--radius-dialog`、`--elev-3`、24px 内边距；遮罩 `rgba(15,23,42,.38)`，不用重度模糊。
- 菜单/popover：`--radius-md`、`--elev-2`、1px 边框；菜单项 32px 高、8px 圆角；危险项红色文字 + 红色图标。
- 所有弹层接入 `overlayStack`，一次 Escape 只关一层；焦点进入弹层、关闭后回到触发控件。
- 位置统一由 `Popover` / `PointerMenu` 计算，禁止页面自己写 `getBoundingClientRect` 修边。

## 13. 状态标签、徽标与优先级

- Badge 默认中性：`--color-neutral-bg` 底、`--color-neutral-text` 字、1px 边框；语义变体 success/warning/error/info 只换色，不换尺寸。
- 高度 20px，12px 字，6px 圆角；计数徽标可用 pill。
- 优先级 P0/P1/P2 使用 `priority-tag`：P0 红、P1 橙、P2 蓝；只标记文字，不做整行底色。
- 状态必须同时有文字或图标，不能只靠颜色区分。

## 14. 表格与列表

- 列表行高 44–52px；主信息 14px，次信息 12px muted；行间用 1px 分隔，不用斑马纹。
- 行 hover 用 `--color-bg-hover`；选中用 `--color-bg-selected` + 左侧 2px 品牌条；不要整行品牌色。
- 列头 12px/600，`--color-text-muted`；数字右对齐、`tabular-nums`。
- 空列表给出「下一步动作」，不是只写“暂无数据”。

## 15. 交互状态

- Hover：背景提升一阶，150ms；不缩放、不位移。
- Active/Pressed：颜色再深一阶，允许 1px 内阴影；不用弹跳。
- Focus-visible：品牌色 1px + 3px 外环，键盘可达。
- Loading：按钮内 13px spinner，保留原宽度；列表用骨架或明确进度，不无限 shimmer。
- Disabled：显式 `--color-text-disabled` + `--color-bg-disabled`，鼠标 `not-allowed`。
- 动效尊重 `prefers-reduced-motion`；弹层 120–160ms，不做大面积视差。

## 16. 亮暗主题

- 主题由 `html[data-theme="light|dark"]` 驱动；两套 Semantic Token 必须同名、同层级。
- 深色不是简单反色：页面底 `#0F172A`、侧栏 `#0B1220`、卡面 `#162032`，边框 `#2A3648`；品牌色提亮到 `#818CF8`，按钮主色 `#6366F1`。
- 暗色下禁止使用固定白纸色（如预设预览内部的小卡片）；预览、缩略图也必须走语义面。
- 主题切换后所有页面、弹窗、菜单、空态必须同步，不允许残留浅色块。

## 17. 空态与错误态

- 空态：一个 40–56px 中性图标/插画，标题 15px/600，说明 13px muted，最多一个主行动。
- 错误态：左侧 2px 错误条或 `role=alert` 行，标题说清“发生了什么”，正文说清“下一步”；提供重试/返回，不暴露内部路径与堆栈。
- 破坏性确认：标题明确对象与后果，正文说明不可逆影响；默认焦点在“取消”，最终按钮实心红。

## 18. 响应式

断点以窗口内容宽度为准，优先容器查询：

| 宽度 | 行为 |
|---|---|
| ≥1280 | 导航 200–320px，详情栏 304px，卡片 2–3 列 |
| 1024–1279 | 收起详情栏，导航保留文字，卡片 2 列 |
| 561–1023 | 导航可缩，卡片 1–2 列，工具栏收纳次要图标 |
| ≤560 | 导航固定 72px 图标轨，详情栏隐藏，卡片单列 |
| ≤420 | 任务候选行改为标题一行、按钮下一行；表单全宽；页面边距 16px |
| 320 | 不出现横向滚动；标题不逐字换行；关键动作仍可点 |

已实现：`WorkbenchShell` 在 `window.innerWidth <= 560` 时使用 `WORKBENCH_NAV_WIDTH_RAIL` 渲染宽度，不写回用户偏好；任务页在 `@container (max-width:560px)` 下单列；开发工作台候选任务行在 ≤420px 换行。

## 19. 无障碍

- 文字对比：主文字 ≥ 7:1，次级 ≥ 4.5:1，muted ≥ 4.5:1（暗色同样校验）。
- 图标按钮必须有 `aria-label`；装饰图标 `aria-hidden`。
- 键盘：Tab 顺序与视觉顺序一致；Escape 关一层；菜单支持方向键；焦点环不可被 `outline:none` 清除。
- 状态变化用 `role=status` / `role=alert`；错误文案与控件通过 `aria-describedby` 关联。
- 触控目标 ≥ 28×28（桌面）/ 44×44（移动端胶囊）；不依赖 hover 才能完成操作。

## 20. 页面落地矩阵

| 区域 | 本轮落地 | 说明 |
|---|---|---|
| 工作台外壳 | 完成 | 顶栏实白、页面标题 24、卡片 15、侧栏/详情栏、窄窗图标轨 |
| 开发工作台 | 完成 | 双列卡面、任务候选行、交接表单、空态 |
| 工作台首页 | 完成 | 今日重点、Agent 状态、资源概览、快捷操作 |
| 工作空间 | 完成 | 项目卡、进度、活动列表、按钮/输入对齐 |
| 任务 | 完成 | 左栏整列卡面、筛选、列表、优先级、窄窗单列 |
| Agent | 完成 | 左栏统计/导航、树行中性化、关注态 2px 色条 |
| 应用 | 完成 | 工作区分栏卡面、分类栏、组合场景、卡片菜单 |
| 文件工作区 | 完成 | 顶栏标签、空态、侧栏、深色表面 |
| 剪贴板 | Token 对齐 | 卡片/筛选/类型徽标继承新语义；页面结构未重排 |
| 设置 | 完成 | 设置导航卡、内容卡、分组、预设预览暗色适配 |
| 其他页面 | Token 对齐 | 资源、收集、工作流、历史、项目中枢、能力中心、保险箱等继承 Token/组件；未逐页重排 |

## 21. 旧 Token 映射与迁移

| 旧名 | 新语义 | 备注 |
|---|---|---|
| `--surface` / `--surface-2` | `--color-bg-surface` / `--color-bg-surface-secondary` | 保留别名 |
| `--text-primary/secondary/tertiary` | `--color-text-primary/secondary/muted` | 保留别名 |
| `--accent` / `--accent-soft` | `--color-brand` / `--color-brand-subtle` | 保留别名 |
| `--border` / `--border-subtle` | `--color-border-default` / `--color-border-subtle` | 保留别名 |
| `--card-radius` / `--card-shadow` | `--radius-card` / `--elev-1` | 旧页面继续可用 |
| `--status-success/error/waiting/running` | 同名新状态色 | 值已校准 |

迁移顺序：

1. 新页面/改版页面只写 Semantic/Component Token，不写 hex。
2. 旧页面保持别名，优先替换 `background: linear-gradient(...)`、固定 `rgba(255,255,255,...)`、`opacity` 禁用态。
3. 删除旧 Token 定义前，必须确认 `styles-themes.css` 四预设、`styles-flat.css`、页面 CSS 中无直接引用；本轮不删除，避免破坏历史预设。

## 22. 验收标准

- `npm run build` 通过（含 `tsc --noEmit`）。
- 亮/暗 × 工作台首页、开发工作台、工作空间、任务、Agent、应用、文件、设置均有真实运行截图。
- 1440 / 1024 / 400 / 320 宽度无横向滚动；窄窗导航不挤压内容。
- 菜单、命令面板、确认弹窗在亮/暗中均使用统一圆角/阴影/边框；危险确认按钮实心红。
- 主题切换在设置页真实操作完成，刷新后保持。
- 状态色只出现在状态元素；卡片不一视同仁；无整屏紫色/紫色渐变。
- 文案与按钮不溢出、不逐字换行；长标题有 tooltip 或换行策略。

## 23. 已知限制与后续

- `styles.css` 仍有 134 处硬编码 hex、`files.css` 63 处；本轮以别名和组件层覆盖为主，未逐条替换。
- `styles-flat.css` 的旧 Token 仍保留；删除需要单独兼容性评审。
- 剪贴板、资源、工作流等页面完成 Token 对齐，但未逐页做结构重排；后续按第 20 节矩阵继续。
- `styles-flat.test.ts` 的 `@container (max-width:520px)` 断言与 HEAD 实现（560px）不一致，属既有失败，已在验收报告标注。
- 真实安装包、安装/升级/卸载、Release 性能不在本轮 Dev 功能验收范围。
