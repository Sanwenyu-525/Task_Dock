# 桌面端响应式布局规范（2026-11-16）

> 适用：`src/` 下所有桌面端功能页（任务、Agent、文件、资源、剪贴板、工作台各工作区）。
> 本文只定义**共享能力与接入方法**，不规定某个页面必须几列。
> 主题色、圆角、边框、阴影继续复用 `styles-themes.css` / `styles-ui.css`，本规范不新增第二套视觉 Token。

## 1. 两条硬规则

1. **按内容区真实宽度响应，不按窗口宽度响应。**
   大型工作台同时存在左侧主导航、页内筛选侧栏、中央内容区、右侧详情检查器。
   窗口 1920 时内容区可能只剩 900；窗口 800 时内容区可能只剩 420。
   因此禁止在功能页里写 `@media (min-width: 1280px)` 来决定卡片列数。
2. **容器不能查询自己。**
   容器查询的匹配规则是「查询容器自身尺寸 → 命中它的**后代**」。
   声明 `container-type` 的元素如果又写依赖自身宽度的 `@container` 规则，规则永远不会命中。
   正确的结构是：**外层 frame 声明容器，内层布局作为后代响应。**

```html
<!-- 正确 -->
<div class="ui-page-frame">        <!-- container-type: inline-size -->
  <div class="ui-adaptive-grid">…</div>  <!-- 后代，可被 @container ui-page 命中 -->
</div>

<!-- 错误：自引用，@container 不会生效 -->
<div class="my-page" style="container-type: inline-size">
  <!-- 在这里改 .my-page 自己的列数，永远不会命中 -->
</div>
```

## 2. 共享几何 Token

定义在 `src/styles.css` 的 `:root` 末尾。页面可覆盖单个变量，但不得复制一套新数字。

| Token | 默认 | 用途 |
|---|---|---|
| `--layout-gap-compact` | `6px` | 紧凑密度下的卡片/工具项间距 |
| `--layout-gap` | `8px` | 默认卡片/网格间距 |
| `--layout-gap-comfort` | `12px` | 舒适密度下的留白 |
| `--layout-row-min` | `34px` | 列表行、工具栏控件的最小高度 |
| `--layout-card-min` | `280px` | 卡片最小合理宽度（列数由它算出） |
| `--layout-card-max` | `560px` | 超宽容器下单卡最大宽度，避免一行只有一张巨卡 |
| `--layout-hit-target` | `32px` | 图标/操作按钮最小命中区域 |
| `--layout-sidebar-min` | `200px` | 可调侧栏最小宽度 |
| `--layout-sidebar-max` | `340px` | 可调侧栏最大宽度 |
| `--layout-page-pad` | `14px` | 页面内容内边距 |
| `--layout-media-max-h` | `240px` | 列表/检查器图片预览最大高度 |

字号不在本规范新增变量：标题、正文、辅助文字继续使用现有 `--text-*` 与组件字号层级。

## 3. 共享原语（`src/styles-ui.css`）

| 类名 | 作用 |
|---|---|
| `.ui-page-frame` | 页面内容区查询容器（`container-name: ui-page`）。只测量，不因自身宽度改自己的布局。 |
| `.ui-adaptive-grid` | 自适应卡片网格：`repeat(auto-fill, minmax(var(--ui-card-min, 280px), 1fr))`；`<520px` 强制单列，避免临界抖动。 |
| `.ui-toolbar-row` | 可换行工具栏；子项 `.ui-toolbar-spacer` 吃掉剩余空间，换行后动作组仍右对齐。 |
| `.ui-content-pad` | 统一页面内边距，默认走 `--layout-page-pad`。 |

页面级覆盖示例（只调最小宽度，不新增断点）：

```css
.clipboard-page .ui-page-frame {
  --ui-card-min: 300px;   /* 剪贴板卡片有标题+摘要+操作行 */
  --ui-grid-gap: 10px;
}
```

窄内容区单列规则只作用于 `.ui-adaptive-grid` 后代，因此容器声明者和被查询者是不同元素。

## 4. 可调整分栏：`WorkspaceSplit`

`src/workbench/WorkspaceSplit.tsx` + `workspaceSplit.css`。

```tsx
<WorkspaceSplit
  id="clipboard"                 // 稳定标识，用于宽度记忆；不要用标题文案
  sidebar={filtersOpen ? <Filters /> : null}
  sidebarLabel="剪贴板筛选"
  defaultWidth={236}
  minWidth={200}
  maxWidth={340}
>
  <MainContent />
</WorkspaceSplit>
```

行为约定：

- **查询容器**：外层 `.workspace-split-frame` 声明 `container-type: inline-size; container-name: workspace-split`；内层 `.workspace-split` 只做 grid。
- `>= 880px`：侧栏使用用户保存宽度（`min/max` 已夹紧）。
- `560–879px`：侧栏列宽 `min(var(--workspace-split-sidebar), 38%)`，主区至少 62%，分隔条仍可拖动。
- `< 560px`：上下分区，侧栏变成顶部筛选区（`max-height: 42%`，自身可滚动），分隔条 `display: none`，**8px 网格列与命中区一起消失**。
- `sidebar={null}` 时渲染 `.workspace-split.is-single`，主区占满。
- 宽度只在**指针拖动、方向键/Home/End/Enter、双击**时写入 `localStorage`（键 `taskdock.workspace.split.<id>`）。
  窄窗只是视觉降级，不回写保存值；窗口恢复后回到用户设定宽度。
- 分隔条是 `role="separator"`，带 `aria-valuemin/max/now`、`aria-controls`（指向侧栏 `id`），可 Tab 聚焦。
- 拖动期间 `body.workspace-split-resizing` 负责全局光标与禁止选中。

**不要**给 `.workspace-split` 自己加 `container-type`，也不要让页面在 `@container workspace-split` 里改 `.workspace-split` 自身。

## 5. 推荐的内容宽度区间

这是**内容区宽度**与布局密度的建议，不是统一断点，也不要求所有页面列数一致：

| 内容宽度 | 推荐布局 |
|---|---|
| `< 520px` | 紧凑单列；工具栏换行；侧栏折叠或转为顶部筛选 |
| `520–839px` | 单列或双列；侧栏可折叠；检查器改为覆盖/下置 |
| `840–1319px` | 双列或三列；可显示页内筛选侧栏 |
| `>= 1320px` | 宽屏内容布局：更大预览、更多正文、允许 3–4 列或检查器常驻 |

落地方式：用 `--ui-card-min` 与 `auto-fill` 让列数自然算出；只有「必须换一种结构」（如侧栏上下分区、检查器覆盖）才写 `@container`。

## 6. 页面接入清单

1. 页面根节点外包 `.ui-page-frame`（或页面自己声明一个**祖先**查询容器）。
2. 卡片区域使用 `.ui-adaptive-grid`，按内容密度覆盖 `--ui-card-min` / `--ui-grid-gap`。
3. 需要页内导航/筛选时使用 `WorkspaceSplit`，不要自建可拖动分栏。
4. 工具栏使用 `.ui-toolbar-row` + `.ui-toolbar-spacer`；窄容器下允许换行，不隐藏关键操作。
5. 详情检查器：
   - 宽内容区（建议 `>= 1120px`）常驻右栏；窄内容区改为覆盖层或下置面板。
   - 检查器内部必须可滚动（`min-height: 0` + `overflow: auto`），不能把主区挤到不可用。
6. 图片预览高度用 `clamp()` + 内容区单位（`cqi`）或 `--layout-media-max-h`，不要在窄卡片里固定 240px。
7. 长文本：`overflow-wrap: anywhere` + 行数 clamp；长路径/URL 用 `text-overflow: ellipsis`，不得撑破网格。
8. 不使用 `ResizeObserver` 重复测量：布局交给 CSS 容器查询；只有业务确实需要数值（如灯箱定位）时才在单一位置订阅。

## 7. 验证方式

- **jsdom 不能验证真实 CSS 布局**：组件测试只能断言结构、类名、ARIA 与内联变量。
- 真实渲染走查：
  ```bash
  npm run build
  node scripts/make-preview.mjs
  node scripts/serve-preview.mjs   # http://localhost:4173/preview.html
  ```
  用 Playwright 在 `800 / 1024 / 1280 / 1600 / 1920` 等**窗口测试尺寸**截图，并同时检查：
  左侧导航展开/收起、页内筛选展开/收起、右侧检查器开/关、深色主题、125%/150% 缩放。
- Windows 真机还需覆盖 DPI 缩放、贴边吸附与多显示器；这些不能用预览截图替代。

## 8. 反模式

- 在功能页写死 `grid-template-columns: repeat(4, 1fr)`。
- 用 `@media (min-width: 1600px)` 决定内部卡片列数。
- 给查询容器自身写 `@container` 规则。
- 窄窗直接 `display: none` 掉筛选/检查器功能（可以换形态，不能消失）。
- 为响应式新增第二套颜色/圆角/阴影变量。
- 用 `setTimeout`/`ResizeObserver` 轮询宽度来切换布局类名。

## 9. 变更记录

- **2026-11-16**：新增几何 Token、`.ui-page-frame` / `.ui-adaptive-grid` / `.ui-toolbar-row` / `.ui-content-pad`；
  修复 `WorkspaceSplit` 容器查询自引用（查询容器移到 `.workspace-split-frame`），补齐窄容器上下分区、
  中等宽度 38% 侧栏封顶、分隔条键盘操作与宽度记忆；剪贴板页接入三档密度与右栏检查器。
- **2026-11-20**：统一窗口 chrome 档位事实源（见 §10）；登记 ≤560 图标轨兜底带常量；更正两处
  与实际阈值漂移的注释（未改任何断点数值）。
- **2026-11-24**：工作台首页页头与卡片标题行改判 `@container wb-content`（见 §11）；窗口级
  `@media (max-width: 560px)` 中的首页规则迁走，该块只留窗口 chrome；项目卡网格最小列改为
  `minmax(min(200px, 100%), 1fr)`，修复内容区被压到 220px 时 11px 横向溢出；首页名称省略号
  接入统一 `data-tip` 提示（§11.3）。

## 10. 窗口 chrome 档位与顶栏收纳（2026-11-20）

本节只描述**窗口等宽结构**（顶栏工具收纳、右栏显隐）；页面卡片列数、页头换行仍按
`@container wb-content` 容器宽度响应（见 §1、§5），两套口径不得混用。

### 10.1 档位事实源对照

唯一 TS 事实源：`src/lib/layoutMetrics.ts`。CSS 媒体查询在 `src/workbench/workbench.css`
末尾「窗口档位与顶栏空间分配」一节；`layoutMetrics.test.ts` 有契约守卫。

| 档位 | TS 常量 / 判定 | CSS 视口查询 | 口径 | 一致性 |
|---|---|---|---|---|
| `full` | ≥ `WINDOW_TIERS.compact`（1100） | 基础块（无查询） | 排他下界 | 一致 |
| `compact` | 900–1099，`<1100` | `@media (max-width: 1099px)` | 排他下界，查询写 `阈值−1` | 一致 |
| `narrow` | 780–899，`<900` | `@media (max-width: 899px)` | 排他下界，查询写 `阈值−1` | 一致 |
| `cramped` | `<780` | `@media (max-width: 779px)` | 排他下界，查询写 `阈值−1` | 一致 |
| 图标轨子带 | `ULTRA_NARROW_WIDTH = 560`，`isUltraNarrow(width)`（≤560） | `@media (max-width: 560px)` 顶栏块；同阈值另用于导航极窄规则与主窗页头兜底 | **inclusive 上界**，查询写 560 | 本次登记 |
| 状态栏降级 | 不登记为窗口档位 | `@media (max-width: 760px)` | 独立密度断点 | 仅文档登记 |

两种阈值口径不可混用：`WINDOW_TIERS.*` 是「低于该值进入下一档」的排他下界（CSS `X−1`）；
`ULTRA_NARROW_WIDTH` 是媒体查询的 inclusive 上界（CSS `560`）。

### 10.2 560 图标轨档位的处置

- **决定**：登记为独立常量 `ULTRA_NARROW_WIDTH = 560` 与判定函数 `isUltraNarrow(width)`，
  **不新增第五个 `WindowTier`**：≤560 在 `windowTier` 里仍归入 `cramped`。
- **理由**：560 规则同时覆盖工作台顶栏/导航极窄布局，以及主窗（400×560）页头的视口兜底
  （主窗没有 `.wb-content` 容器，容器查询不生效），并不等价于工作台窗口档位；四档枚举只描述
  窗口等宽 chrome 主档。
- **可达性**：Rust 侧 `clamp_floor` 在小屏可用区不足时跟随可用区（≥320 DIP），远程桌面/
  极小屏上工作台窗口可以落到 560 以下，该兜底带是真实可达的，不是死代码。
- 560 块内核心操作不被 `display:none`：窗口控制绝对钉在右上，搜索收成 32px 图标按钮，
  「更多」入口保留；契约由 `layoutMetrics.test.ts` 守卫。

### 10.3 顶栏逐档收纳规则

不变量：图标按钮与窗口控制 `flex: 0 0 auto`，永不被 flex 压缩；项目选择器可收缩但保留合理
最小宽度；任何退出都以「收进更多菜单 / 保持可点」为前提，不隐藏功能；窗口变大后内联恢复
（纯 CSS 档位，不做 JS 宽度轮询）。

| 档位 | 顶栏行为 |
|---|---|
| `full` ≥1100 | 品牌 + 项目选择器 + 搜索 + 快速创建 + 收集入口 + 右栏开关 + 主题/预设/置顶内联 + 窗口控制全量显示 |
| `compact` 900–1099 | 隐藏搜索快捷键提示、品牌名、创建按钮文案；右栏由 JS 收起 |
| `narrow` 780–899 | 外观工具组（主题 / 视觉预设 / 置顶）整体收进「更多」菜单；搜索 basis 200、项目选择器 170（min 140） |
| `cramped` 560–779 | 顶栏换行，项目选择器独占第二行；搜索 basis 160 |
| 图标轨 ≤560 | 窗口控制绝对定位右上；搜索收成 32px 图标；工具组绝对定位第二行右侧；项目选择器整行；「更多」菜单仍是外观工具唯一入口 |

退出优先级（低优先信息先退）：品牌名 → 搜索快捷键 → 创建文案 → 外观工具组。

### 10.4 「更多」菜单清单与复用契约

- 组件：`src/workbench/WorkbenchToolbarMore.tsx`，经 `DropdownMenu`（`placement="bottom-end"`）
  渲染，定位走共享 Popover 定位核心；组件内不手写 `getBoundingClientRect` / `window.innerWidth`
  做边界计算。
- 菜单项顺序：明暗主题三选（浅色 / 深色 / 跟随系统）→ 分隔线 → 视觉预设二选（柔光玻璃 /
  梦幻渐变）→ 分隔线 → 置顶切换。
- 复用同一份逻辑：`useThemeMenuItems` / `usePresetMenuItems` / `useWorkbenchPin`，与内联的
  `WorkbenchThemeMenu` / `WorkbenchPresetMenu` / `WorkbenchPinButton` 共用设置写入管道与置顶
  状态；不存在第二套 theme/preset/pin 实现。
- 回归测试：`src/workbench/WorkbenchToolbarMore.test.tsx`（触发器语义、展开顺序与分隔线、
  主题/预设写入、置顶 no-op 兜底、再次点击与 Esc 关闭）。

### 10.5 边界与未纳入档位模型的视口规则

- `@media (max-width: 760px)`：状态栏密度降级（次要文案/磁盘状态隐藏）与创建按钮文案，
  不是窗口档位，不登记进 `WINDOW_TIERS`。
- `@media (max-width: 560px)` 窗口级块：**只**服务窗口 chrome（顶栏换行、窗口控制、搜索收纳、
  标题栏工具）。2026-11-24 起首页页头/卡片标题行不再放在这里，改判 `@container wb-content`
  （见 §11.1）；该注释此前把「页面页头换行兜底」也归入此块，已随迁移更正。
- 页面 1440 阅读宽封顶（`.wb-home` / `.wb-project`）、卡片网格降列仍走容器查询；窄内容区
  （`<900px` 容器宽）解除封顶。

### 10.6 本次更正（不推翻既有行为）

- 更正注释：`WorkbenchToolbarMore` 原注释写「960 DIP（原生最小尺寸）/ 780 DIP 收纳」，
  与实际不符；外观工具收纳阈值是 **`<900 DIP`**（CSS `899px`，`WINDOW_TIERS.narrow = 900`）。
  本次只更正注释，**断点数值未改**。
- 更正注释：`workbench.css` 原注释写「JS compact（<1000px）」；实际阈值是 **`<1100 DIP`**
  （`shouldCollapseWorkbenchDetail` / `WINDOW_TIERS.compact`）。

## 11. 工作台首页：内容区判据与长内容（2026-11-24）

背景缺陷：`.wb-home-head` / `.wb-home-date` / `.wb-home-greeting` / `.wb-panel-head*` 的窄宽
规则写在文件末尾的窗口级 `@media (max-width: 560px)`。窗口 1100 时 JS 会收起右栏（`compact`），
导航 + 右栏仍可能把 `.wb-content` 压到 400 左右，而窗口宽度 ≥560 使规则不命中，结果问候语被
日期胶囊挤成极窄一列、标题与日期在同一行互相压盖。**判据错了，不是规则数值错了。**

### 11.1 判据迁移（只迁首页规则）

- 全部首页页头与卡片标题规则移入 `@container wb-content (max-width: 560px)`，继续复用
  `.wb-content` 已有的 `container-type: inline-size; container-name: wb-content`。
  这处与 `.wb-home-grid` 单列那处是**同一档**（同为 `wb-content ≤560`：一处管页头换行与
  卡片标题行，一处管列数），改阈值必须两处一起改；不新增断点，也不与 940/560 的六列/单列
  网格分档冲突（两者同源同档，只是各自负责的组件不同）。
- 迁移清单：`.wb-home-head`（`flex-wrap: wrap` + `align-items: flex-start`）、
  `.wb-home-head-main`（`flex: 1 1 100%`）、`.wb-home-date`（`order: 2`、`white-space: normal`、
  `line-height: 1.45`、`max-width: 100%`）、`.wb-home-greeting`（24px）、`.wb-panel-head`
  （`flex-wrap: wrap`、`row-gap: 6px`、`align-items: flex-start`）、`.wb-panel-head h3`
  （`flex: 1 1 auto; min-width: 0; white-space: normal; overflow-wrap: anywhere`）、
  `.wb-panel-head h3 > svg`（`flex: 0 0 auto`，图标不挤文字）、`.wb-panel-more` /
  `.wb-panel-count`（`flex: 0 0 auto; margin-left: auto; white-space: nowrap`）、
  `.wb-panel`（`padding: 14px`）、`.wb-home-slot`（`padding: 14px 12px 18px`）。
- 新增基础规则：`.wb-home-head-text { flex: 1 1 auto; min-width: 0 }`（文字列可收缩）、
  `.wb-home-date-text { min-width: 0; overflow-wrap: anywhere }`（长英文日期换行不撑宽）、
  `.wb-panel-head h3 { min-width: 0 }`。`.wb-home-date` 基础态补 `max-width: 100%; min-width: 0`，
  日期胶囊永远不会把页面撑宽。
- **不迁移**：顶栏窗口控制、搜索收纳、「更多」菜单仍按窗口宽度（§10），它们相对窗口定位，
  与内容容器无关。
- 网格架构保持不变：`.wb-home-grid`（940px→6 列 / 默认 2 列 / 560px→1 列）与 `.ui-adaptive-grid`
  原样复用，首页业务组件未重写。

### 11.2 名称省略号的可查看途径

`.wb-row-title` / `.wb-pcard-name` / `.wb-wf-name` 保留省略号，但溢出时接入既有
`src/lib/nameTip.ts`：`syncTruncatedTip(host, selector, text)` 只在**实际被截断**时写
`data-tip`，`clearTip` 在 `mouseleave` / `blur` 清除；提示渲染走全局 `TooltipLayer`
（`data-tip`，350ms 悬停延迟，键盘 Tab 立即显示）。事件挂在行内按钮上而不是内层文字，
**不改变原有点击行为**（点击仍导航），也不需要固定卡片宽度。中文、长英文、路径与特殊字符
都按 `overflow-wrap: anywhere` 断行后再判断是否截断。

### 11.3 首页时间与本地化

- 日期不再直接读系统语言：`formatLocalizedDate(now, { year/month/day/weekday })` 走
  `src/i18n/format.ts`，跟随 Task Dock 的 `taskdock.locale`。
- `useLocalNow()` 只在跨整点边界时推进一次（单个 `timeout`、卸载清除，不轮询）；`focusTasks`
  的 `useMemo` 依赖加入 `dayKey`（`YYYY-M-D`），跨午夜后「今天/已逾期」判定随之刷新，
  不会永久停留在过期快照。

### 11.4 验收口径

窗口 900 且 `nav 320 + detail 400` 使内容区压到 374–400 时：页头两行（问候语独占一行、日期
下移）、卡片单列、标题不被截断、页面无横向滚动。另覆盖 400 / 800 / 1024 / 1280 / 1600 / 1920
与英文、深色。脚本 `tmp/acceptance/boot-home-responsive/home-shots.mjs`（13 视图）+
`home-tooltip.mjs`（截断提示的悬停/键盘两条路径）。jsdom 只能验证 CSS 契约文本，
列数/换行/是否溢出必须真实浏览器取证。
