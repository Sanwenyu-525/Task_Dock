# 全局弹出层定位体系 · 现状审计（2026-11-19）

> 本文是「全局弹出层定位系统统一治理」的第一阶段产物：只记录**现状、问题与根因**，
> 不含目标设计。目标设计与规范见
> [global-popup-positioning-standard.md](global-popup-positioning-standard.md)。
>
> 审计方法：读取定位基元与全部直接调用方 → 全仓扫描
> `position: fixed/absolute`、`getBoundingClientRect`、`clientX/clientY`、
> `window.innerWidth/innerHeight`、`createPortal`、`placement` → 按「弹层类型」分类，
> 逐一判断它是不是定位问题，避免把所有 `absolute/fixed` 都误判为缺陷。

## 1. 现有定位基础设施

| 设施 | 位置 | 职责 | 结论 |
|---|---|---|---|
| `Popover` | `src/components/ui/Popover.tsx` | 锚定弹层的定位、Portal、翻转/收敛、外部点击、Escape 注册 | 已有统一底座，但策略全写死，缺少对齐/尺寸/指针语义 |
| `overlay.ts` | `src/components/ui/overlay.ts` | `useOverlayLayer` / `useFocusTrap` / `useFocusRestore` / `findOverlayPortal` | 可复用，无需重建 |
| `overlayStack.ts` | `src/lib/overlayStack.ts` | 全局 Escape 优先级（dialog → menu → modalTop → sublayer → modal → drawer） | 可复用；本轮需要让更多自定义菜单接入 |
| `@floating-ui/react` v0.27 | 依赖 | `useFloating` + `autoUpdate` + `offset/flip/shift/size` | 项目唯一允许的定位库，不重复引入 |
| `TooltipLayer` | `src/components/ui/TooltipLayer.tsx` | 全局 `data-tip` 事件委托 + 提示条 | **自行实现了第二套中心对齐/边界收敛**（`computeTooltipPosition`） |

`Popover` 现有实现明细：

- ✅ floating-ui 定位、`strategy: "fixed"`、`createPortal`（锚点在 `.ui-dialog-mask` 内时挂进遮罩）。
- ✅ `autoUpdate(ancestorScroll, ancestorResize, elementResize)`：窗口 resize、祖先滚动、
  锚点/弹层尺寸变化都会重算。
- ✅ `offset(6)` → `flip({padding:8, flipAlignment:false, fallbackAxisSideDirection})`
  → `shift({padding:8, crossAxis:true})` → `size({padding:8})`。
- ✅ Escape 交给全局弹层栈；外部点击/外部滚动/窗口失焦关闭；关闭后焦点恢复。
- ❌ **没有「对齐」概念**：`placement` 字符串同时编码主方向与对齐，组件无法只声明
  `alignment="auto"` 而保留主方向。
- ❌ `flipAlignment: false` 固定了 start/end：靠近窗口边缘时只能靠 `shift` 平移，
  对齐关系被破坏；也没有任何地方能让对齐按空间自动切换。
- ❌ 尺寸策略写死在 `apply()` 里：`Math.max(120, availableHeight)`、
  `Math.max(140, availableWidth)` 在极窄窗口下可能反过来撑破可用空间；
  没有 `minWidth/maxWidth/maxHeight` 的调用方接口。
- ❌ `positionOverride` 路径直接关掉 `autoUpdate`，动态尺寸只能由调用方自己监听
  （`TooltipLayer` 只监听 `window.resize`，锚点尺寸变化不重算）。
- ❌ 没有暴露「是否翻转 / 是否平移」的观测点，测试只能读 `data-placement`。

## 2. 组件级审计

### 2.1 Select（`src/components/ui/Select.tsx`）

| 项 | 现状 |
|---|---|
| 默认 placement | `bottom-end`（`align` 默认 `"end"`） |
| 菜单宽度 | `matchWidth` → `--popover-min-w` = 触发器宽；`menuMinWidth` → `--menu-min-w`；`max-width` 受 `.ui-popover` 的 420px 与 `--popover-max-w` 双重限制 |
| 定位更新 | 复用 `Popover` 的 `autoUpdate` |
| 键盘/焦点 | 焦点留在触发器，`aria-activedescendant`；Escape 只关本层；提交后回焦点 |

问题：

1. **默认右对齐与产品语义不匹配**：普通表单/筛选下拉在左对齐布局里，`end` 会让菜单
   向左溢出，窄窗口下再被 `shift` 推回，视觉上表现为「菜单比触发器更靠左」。
2. **默认值被所有调用点隐式继承**：`WorkbenchShell` 顶栏项目选择器、工作空间表单、
   资源表单、语言设置都没有显式声明对齐，任何默认值调整都会同时改变它们。
3. `menuMinWidth` 与触发器宽度取 `max` 作为 `min-width`；当可用宽度小于这个下限时，
   CSS 的 `min-width` 会压过 `max-width`，菜单会超出可用窗口（极窄窗口）。
4. `Select` 本身没有 `placement` 以外的尺寸约束入口，调用方无法声明「不要超过 N px 高」。

### 2.2 DropdownMenu（`src/components/ui/DropdownMenu.tsx`）

| 项 | 现状 |
|---|---|
| 默认 placement | `bottom-end` |
| 宽度 | 内容自然宽度 + 可选 `menuMinWidth`；`matchWidth` 默认 false |
| 高度 | `.ui-menu { max-height: var(--popover-max-h, 320px); overflow-y:auto }` |
| 键盘 | ↑↓/Home/End/Enter/Space/字母定位/Tab 关闭 |

问题：

1. 默认 `bottom-end` 是合理的「右侧操作菜单」语义，但组件没有 `alignment` 入口，
   调用方只能写完整 placement 字符串（`"bottom-start" | "bottom-end" | ...`），
   无法表达「主方向自动翻转、对齐自动选择」。
2. 位置完全依赖触发按钮所在布局；`wb-nav-foot` 的「更多」用 `right-end` 是正确特例，
   但没有规范说明「什么位置该用哪种对齐」。
3. 长菜单有滚动，但没有和「可用高度」联动的显式上限（依赖 `size` 中间件写 CSS 变量）。

### 2.3 Combobox（`src/components/ui/Combobox.tsx`）

- 没有 `placement` / `align` 入口，靠 `Popover` 默认值 → **实际默认 `bottom-start`**，
  与 `Select` 的默认 `bottom-end` **不一致**。
- `matchWidth` 固定开启，宽度规则与 Select 相同，但两个组件的对齐规则不同。
- 定位生命周期复用 Popover，无重复边界计算。✅
- 结果过滤后高度变化由 `autoUpdate` 的 `elementResize` 覆盖。✅

### 2.4 GlobalSearchDialog（`src/components/global-search/GlobalSearchDialog.tsx`）

- 下拉形态：`Popover` + `placement="bottom-start"` + `anchorRef`（顶栏搜索字段）+
  `offsetPx=6` + `restoreFocus=false`（自己管理焦点）。
- 输入行通过 `createPortal(inputRow, inputHost)` 搬进顶栏字段，搜索面板只保留分类/结果。
- 宽度：`.gs-popover { max-width: min(560px, calc(100vw - 24px)) }`，
  `.gs-dropdown-panel { width: min(560px, calc(100vw - 32px)) }`。
- 高度：`.gs-dropdown-panel { max-height: min(var(--popover-max-h,560px),520px) }`。

问题：

1. **面板宽度用的是视口而不是「本次可用宽度」**：窗口右侧空间不足时，
   外壳被 `--popover-max-w` 收窄，但内层面板仍按 `100vw - 32px` 取宽，
   结果被 `.gs-popover { overflow:hidden }` 横向裁掉，右侧内容不可见。
2. 大型内容面板没有显式的 `maxWidth/maxHeight` 配置，完全靠 CSS 约定；
   后续若复制该模式，容易再次出现「面板宽于可用空间」。
3. 输入框 Portal 与面板分离，关闭时必须显式归还焦点（已有实现），
   这属于业务特例，不能退回「所有弹层都自动 restoreFocus」。

### 2.5 Tooltip / TooltipLayer

- `Tooltip.tsx`：直接用 `Popover`，`placement="top"`（居中对齐）、`layer=null`、
  `offsetPx=6`、不参与外部点击/焦点恢复。
- `TooltipLayer.tsx`：全局单实例，`computeTooltipPosition` **自行实现**了
  「居中 → 主方向越界返回 null 交给 flip → 横跨轴 clamp」的纯函数，
  然后通过 `positionOverride` 写死 left/top，并关闭 `autoUpdate`。

问题：

1. 第二套定位算法与 `Popover` 的 flip/shift 语义并行维护，规则容易漂移。
2. `positionOverride` 只监听 `window.resize`：锚点尺寸变化（字体加载、标签变长）、
   弹层内容变化都不会重算，可能停在旧坐标。
3. `data-placement` 在 override 时写的是「请求的 placement」，不是实际落点，
   入场动画 origin 可能指向错误方向。

### 2.6 DatePicker / DateTimePicker

- 两者都用 `Popover` + `bottom-start` + `matchWidth=false`，复用同一基元。✅
- 日历面板尺寸固定，窄窗口靠 `size` 中间件与 `.ui-date-panel` 的 max-height 收敛。
- 缺少显式的 `maxHeight` 语义，仅靠 CSS 变量兜底；本轮补配置入口即可。

### 2.7 TargetMenu（`src/components/navigation/TargetMenu.tsx` + `TaskItem.tsx`）

- `TaskItem` 用 `.target-menu-backdrop`（`position:fixed; inset:0` 的点击遮罩）+
  `.target-menu-anchor`（`position:absolute; right:0; bottom:calc(100%+4px)`）把菜单
  绝对定位在任务卡内。
- 菜单本体 `useOverlayLayer("menu")` + 自己的键盘焦点管理。

问题（P1）：

1. **被父容器裁剪**：`.task-item` 在滚动列表里，菜单向上展开时超出列表可视区会被裁掉；
   任务卡靠近窗口顶部时菜单直接不可见。
2. **没有窗口边界收敛**：只有 `@media (max-width:360px)` 时把 `right:0` 改成 `left:0`，
   其余窄窗口/边缘位置没有任何翻转或收敛。
3. **高度无上限**：目标很多时菜单高于窗口，且不能滚动。
4. 遮罩 `position:fixed; inset:0; z-index:40` 是裸 z-index（违反 Token 规范），
   并会拦截整个窗口的指针事件，菜单关闭依赖遮罩点击。
5. 菜单注册了 `"menu"` 层，但 Portal 不在遮罩内；与 Popover 的层级语义不一致。

### 2.8 ShelfContextMenu（`src/components/shelf/ShelfContextMenu.tsx`）

- 自建 `createPortal` + `position:fixed` + 指针坐标；打开后 `requestAnimationFrame`
  里读一次 `getBoundingClientRect`，用 `window.innerWidth/innerHeight` 做 `clamp`。
- 已接入 `useOverlayLayer("menu")`、`useFocusTrap`、外部点击关闭。✅

问题：

1. **首帧位置是原始指针坐标**：测量发生在下一帧，靠近右下角时菜单会先出现在越界位置，
   再跳到收敛位置（可见闪烁）。
2. **尺寸只测一次**：菜单项禁用态变化、字体加载导致宽度变化后不再收敛。
3. 只做 `clamp`，不做「右边空间不足时向左展开」的翻转语义（clamp 会把菜单压到指针左侧
   以外的位置，指针与菜单的关联变弱）。
4. `padding=8`、测量与 clamp 逻辑都是本组件私有，无法被回收站/分割线菜单复用。

### 2.9 回收站 FreeMenu（`src/components/files/RecycleWorkspaceView.tsx`）

- 自建 `position:fixed`（`.rc-ctx-menu`）+ `style={{left:x, top:y}}`，
  **完全没有边界计算**。
- 用 `window.addEventListener("mousedown"/"keydown", capture)` 关闭。

问题（P1）：

1. **必然越界**：靠近窗口右/下边缘右键，菜单直接伸出窗口被裁掉。
2. **Escape 会隐藏主窗口**：菜单没有注册 `overlayStack`，`installEscapeDispatcher`
   在栈空时执行窗口级动作（隐藏到托盘），用户按 Esc 期望关菜单却把应用藏了。
3. 没有键盘导航，没有 `role=menu` 的 roving tabindex。
4. 与 FilePane 的 FreeMenu 是两套实现，定位/关闭语义不一致。

### 2.10 文件工作区（`FilePane.tsx` / `FilesWorkspacePanel.tsx`）

- `FilePane.FreeMenu`：零尺寸 `position:fixed` 触发器 + `DropdownMenu`，
  **已经复用统一基元**。✅ 但零尺寸触发器写法是私有模式，回收站没有复用。
- `FilesWorkspacePanel.SplitWithDivider` 的分割线比例菜单：
  - 直接渲染在 `.fw-split` 内（`.fw-divider-menu { position:absolute }`），
    没有 Portal，可能被文件面板的 `overflow` 裁剪。
  - 位置用 **硬编码尺寸** 估算：`window.innerWidth - 176`、`window.innerHeight - 210`；
    文案变长/DPI 变化后估算失真。
  - 没有注册 `overlayStack`：焦点在菜单按钮上按 Escape，事件不冒泡到分割线，
    菜单关不掉（或触发窗口级 Escape）。
  - 菜单打开时焦点仍留在分割线，这是**刻意的业务特例**（方向键继续调比例），
    迁移时不能破坏。
- 布局抽屉 `Popover positionOverride`：`drawerCenterOverride` 用硬编码
  `280×320` 在「锚点全部不可见」时居中；`window.innerWidth` 在 render 期读取，
  依赖 `anchorTick` 强制重渲染。可作为统一「视口居中」纯函数的首个调用方。

### 2.11 FilesWorkspacePanel 布局菜单 / 其他 Popover 调用方

- `FilesWorkspacePanel` 布局抽屉：`bottom-end` + `positionOverride`（见上）。
- `ShelfFilters`：`bottom-end`，合理（筛选按钮在暂存区右侧工具栏）。
- `ContextHelpButton`：默认 `bottom-end`，可传 placement；属于帮助气泡，尺寸小。
- `ScenarioWorkspaceView` 图标选择器：`Popover` 直接调用，默认 `bottom-start`。

这些调用方共用 `Popover`，本轮只需按新的 `alignment` 语义显式声明意图，
不需要逐个重写。

## 3. 全项目定位方式扫描与分类

扫描 `src/**/*.css` 的 `position: absolute|fixed`（共 25 个文件、约 140 处），
逐条判断业务用途后分类如下。**不把所有 absolute/fixed 都认定为定位问题**。

| 类型 | 代表实现 | 是否属于本轮治理 | 说明 |
|---|---|---|---|
| 锚定式下拉列表 | `Select` / `Combobox` / `DatePicker` | ✅ 统一到 `Popover` | 已统一，本轮补对齐/尺寸策略 |
| 锚定式操作菜单 | `DropdownMenu`、`WorkbenchShell` 快速创建/主题/预设、导航「更多」 | ✅ 统一到 `Popover` | 已统一，本轮补 `alignment` 与默认规则 |
| 大型内容面板 | `GlobalSearchDialog` 下拉形态、布局抽屉 | ✅ 统一到 `Popover` | 保留独立宽度/高度策略 |
| 鼠标指针右键菜单 | `ShelfContextMenu`、回收站 `FreeMenu`、`FilePane.FreeMenu`、分割线比例菜单 | ✅ 本轮新增 `PointerMenu` | 四套实现合并为一套指针定位 |
| 工具提示 | `TooltipLayer`、`Tooltip` | ✅ 统一算法 | 保留「瞬时、不抢焦点、不进弹层栈」差异 |
| 模态窗口 | `Dialog`、`ImageLightbox`、`ShelfImageLightbox` | ❌ 不迁移 | 视口居中、独立层叠上下文，与锚定弹层是两种产品形态 |
| 全屏面板 | `.gs-mask` 模态形态、`FullView` | ❌ 不迁移 | 视口级布局，不属于锚定定位 |
| 内嵌展开面板 | `CollapsibleSection`、任务卡内联详情 | ❌ 不迁移 | 参与父容器布局，强行 Portal 会破坏滚动与布局 |
| 拖拽跟随提示 | `DropPreview`、`CapsuleDragCursor`、`fw-divider-ratio` | ❌ 不迁移 | 跟随指针的即时视觉层，不是可交互弹层 |
| 原生系统窗口/控件 | `ContextMenuApp`（透明独立窗口，Rust `fit_context_menu` 定位）、投屏工具栏窗口、通知窗口 | ❌ 不迁移 | 坐标由 Win32/窗口后端决定；DOM 定位只在其窗口内部生效 |
| 投屏窗口内菜单 | `.projection-more`（`toolbar.html` 独立窗口内布局） | ❌ 不迁移 | 菜单是窗口布局的一部分，由窗口尺寸与 CSS 约束，不是页面弹层 |
| 页面内装饰/徽标 | `.apps-tile-actions`、`.icon-btn::after` 等 | ❌ 不迁移 | 非弹层，不参与定位治理 |

**结论**：真正的「页面级弹出层」集中在 5 类：锚定下拉、锚定操作菜单、大型面板、
指针菜单、提示条。其余 `absolute/fixed` 属于布局/装饰/原生窗口，不应被统一改造。

## 4. 根因归纳

1. **策略与几何耦合在一个组件里**：`Popover` 同时承担「用什么策略」和「怎么算坐标」，
   调用方只能通过完整 `placement` 字符串间接表达意图，导致每个新组件各自解读。
2. **缺少对齐维度**：`start/center/end/auto` 没有成为独立概念，`flipAlignment:false`
   把「保持设计对齐」和「无法自动对齐」绑死在一起。
3. **指针菜单没有基元**：每个右键菜单各自 `createPortal` + `clientX/clientY` +
   自己的 clamp，边界算法与生命周期各写一遍。
4. **动态尺寸只做了一半**：`Popover` 有 `autoUpdate`，但 `positionOverride` 调用方
   和非 Portal 菜单没有；菜单高度/宽度变化后停留在旧坐标。
5. **弹层栈覆盖不全**：`ShelfContextMenu` 已接入，回收站/分割线菜单没有，
   Escape 语义在不同菜单间不一致（关菜单 vs 隐藏窗口）。
6. **动画 origin 只按 `data-placement` 的粗粒度选择**：`[data-placement^="top"]`
   一律 `bottom left`，`[data-placement$="end"]` 一律 `top right`；
   `bottom-end`、`top-end`、居中对齐的 origin 都是错的，翻转后动画从错误方向展开。
7. **没有可观测性**：没有统一的「最终 placement / 是否翻转 / 是否平移 / 尺寸上限」
   数据出口，测试只能断言 CSS 类名或 `data-placement`，无法验证几何关系。

## 5. 审计范围外的既有改动

审计期间工作树存在其他任务的未提交改动（`FilePane.tsx`、`FilesWorkspacePanel.tsx`、
`styles-ui.css`、`docs/**` 等）。本轮只做**定点编辑**，不覆盖、不还原、不提交他人改动；
交付报告会单独列出本轮触及的文件与原因。
