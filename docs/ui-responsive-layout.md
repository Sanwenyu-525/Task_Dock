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
