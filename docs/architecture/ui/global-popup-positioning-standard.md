# TaskDock 全局弹出层定位规范（v1.0 · 2026-11-19）

> 状态：**已实施基线**。本文是弹层定位的唯一架构规范；审计结论见
> [global-popup-positioning-audit.md](global-popup-positioning-audit.md)。
>
> 适用范围：主窗口、工作台窗口、各页面内**页面级弹出层**（锚定下拉、操作菜单、
> 大型内容面板、指针右键菜单、工具提示）。模态框、内嵌展开面板、拖拽跟随层、
> 原生独立窗口不适用本规范，见 §11「保留特殊实现清单」。

## 1. 设计原则

1. **定位引擎全局统一**：所有页面级弹层只允许经 `src/components/ui/Popover.tsx`
   与 `src/components/ui/PointerMenu.tsx` 定位；禁止业务组件自行计算窗口边界。
2. **策略按弹层类型区分**：同一定位引擎，不同的默认 `side/alignment/尺寸策略`；
   类型差异写在本规范的功能矩阵里，不写进业务代码。
3. **定位结果由三者共同决定**：触发元素位置与尺寸、弹层实测尺寸、窗口可用空间。
   任何「只按触发器宽度」「只按固定常数」的定位都是错误实现。
4. **优先遵循设计对齐，空间不足时智能调整**：显式 `alignment` 先保持对齐再平移；
   `alignment="auto"` 才允许在 start/end 之间切换。主方向始终允许上下/左右翻转。
5. **结果必须落在可用窗口内**：`collisionPadding` 默认 8px；所有定位路径（含指针菜单、
   居中退化、提示条）都必须在窗口内，且优先级为「不越界 > 保持对齐 > 保持主方向」。
6. **定位逻辑可测试**：策略与几何计算集中在纯函数模块；组件只做 DOM 适配与生命周期。
7. **业务组件不重复实现边界计算**：`clientX/clientY + innerWidth/innerHeight + clamp`
   只能出现在定位基元里。
8. **定位与视觉分离**：定位只写 `left/top/transform` 与尺寸 CSS 变量；
   圆角、阴影、入场动画由组件样式与语义 Token 负责。
9. **组件职责单一**：`Popover` 不感知业务；`Select/Combobox/DropdownMenu` 只声明
   策略与内容；业务页面不直接调用 floating-ui。
10. **新增弹层必须复用统一基础设施**：新组件先查 `ui/`，扩展 props 而不是复制第二版。

## 2. 弹出层功能矩阵

| 类型 | 默认 side | 默认 alignment | 宽度策略 | 高度策略 | 特殊要求 |
|---|---|---|---|---|---|
| 普通 Select | bottom | **start** | `min-width = max(trigger, menuMinWidth)`；`max-width = min(420, 可用宽)`；内容更宽时自然增长 | 可用高（列表内滚动） | 显式 `align="end"` 保留右对齐；`alignment="auto"` 可在边缘切换 |
| Combobox | bottom | **start** | 同 Select（`matchWidth`） | 可用高（结果列表滚动） | 过滤后高度变化必须重算；输入焦点不因重定位丢失 |
| 操作菜单 DropdownMenu | bottom | **end** | 内容宽 + 可选 `menuMinWidth`；`max-width = min(320, 可用宽)` | 可用高（`.ui-menu` 滚动） | 保留显式 placement；顶栏右侧用 end，左侧导航用 `right-end` |
| 大型内容面板（布局抽屉 / 帮助面板） | bottom | start/end 按触发点 | 独立宽度上限（默认 420，可 `maxWidth` 覆盖） | 独立 `maxHeight` | 不得用 Select 的宽度规则；必须声明 `maxWidth/maxHeight` |
| 全局搜索下拉 | bottom | start | `maxWidth=560`；面板随可用宽收缩 | `maxHeight=min(可用高, 520)` | 保留输入框 Portal 与 anchorRef；面板不得横向裁剪 |
| 日期/时间选择器 | bottom | start | 日历固定宽（不匹配触发器） | 日历固定高 + 可用高收敛 | 保留日历尺寸与键盘网格 |
| Tooltip | 依内容位置（默认 top） | center | 最大 240px | 自然高度，两行截断 | 避开窗口边缘；不抢焦点、不参与弹层栈 |
| 右键菜单（指针） | 指针右下 | start | `minWidth` 按业务；`maxWidth = 可用宽` | `maxHeight = 可用高`（滚动） | 右/下空间不足向左/上翻转；四边收敛 |
| 分割线比例菜单（指针特例） | 指针右下 | start | 内容宽 | 可用高 | **不抢焦点**：焦点留在分割线，方向键继续调比例 |
| 模态窗口 | 视口 | center | 独立 | 独立 | 不属于锚定定位，走 `.ui-dialog-mask` |
| 内嵌展开面板 | 按业务容器 | 按设计 | 父容器 | 父容器 | 不 Portal，不套用窗口边界 |

## 3. 统一定位参数

实现于 `src/components/ui/positioning.ts`（纯函数，不依赖 DOM）：

```ts
export type PopupSide = "top" | "bottom" | "left" | "right";
export type PopupAlignment = "start" | "center" | "end" | "auto";

export interface PopupPositionConfig {
  side?: PopupSide;              // 首选主方向，默认 bottom
  alignment?: PopupAlignment;    // 首选对齐，默认按调用方声明（Popover 缺省 start）
  offset?: number;               // 与触发器的间距，默认 6
  collisionPadding?: number;     // 与窗口边缘的最小距离，默认 8
  matchAnchorWidth?: boolean;    // 最小宽度跟随触发器（Select/Combobox）
  minWidth?: number;
  maxWidth?: number;
  maxHeight?: number;
  allowFlip?: boolean;           // 允许主方向翻转，默认 true
  allowAlignmentFlip?: boolean;  // 允许 start/end 切换；默认 = alignment === "auto"
}
```

`Popover` 在保持向后兼容的前提下扩展了这些字段：

```ts
interface PopoverProps {
  placement?: Placement;        // 旧接口：完整 placement 字符串，仍然有效
  side?: PopupSide;             // 新接口：主方向
  alignment?: PopupAlignment;   // 新接口：对齐（含 auto）
  collisionPadding?: number;    // 默认 8
  minWidth?: number;
  maxWidth?: number;
  maxHeight?: number;
  allowFlip?: boolean;          // 默认 true
  allowAlignmentFlip?: boolean; // 默认 alignment === "auto"
  // …其余字段不变
}
```

解析优先级：`side/alignment` > `placement` 拆解 > 组件默认值。
`alignment === "center"` 映射为 floating-ui 的 `"bottom" | "top" | "left" | "right"`；
其余映射为 `"side-start" / "side-end"`。**不新建第二套配置体系**。

## 4. 全局对齐规则

| 对齐 | 几何定义 | 适用 |
|---|---|---|
| `start` | 弹层左/上边缘与触发器左/上边缘对齐 | 普通选择列表、搜索列表、表单下拉、大部分大型面板 |
| `end` | 弹层右/下边缘与触发器右/下边缘对齐 | 顶栏右侧快速创建、右侧工具按钮、靠近窗口右缘的操作菜单 |
| `center` | 弹层中心与触发器中心对齐 | 明确要求居中展开的菜单、Tooltip、标题栏工具 |
| `auto` | 先按首选位置尝试；start 放不下→end，end 放不下→start；两者都放不下→选需要平移最少的一侧，再 clamp | 位置不固定、跨断点复用的触发器 |

规则：

1. **显式对齐优先**：`start/end/center` 在空间不足时由 `shift` 沿交叉轴平移，
   **不切换对齐**；平移量必须最小，且保证不越界。
2. **auto 才允许切换对齐**：实现为 floating-ui `flipAlignment: true`，
   由 `detectOverflow` 用实测尺寸选择首个不溢出的 placement。
3. **不能按「窗口左半/右半」粗暴决定对齐**：还取决于弹层宽度与触发器宽度；
   auto 必须交给几何计算，不允许业务代码写 `x < innerWidth / 2 ? start : end`。
4. **翻转优先于平移**：主方向空间不足时先翻到对侧；对侧也不足时，选可用空间更大的一侧，
   再对尺寸与坐标做收敛。
5. **禁止用固定 transform 偏移掩盖定位问题**：`translateX(-50%)` 这类只能用于
   「本来就是居中布局」的模态/装饰层；锚定弹层不得用固定偏移修补。

## 5. 定位引擎架构

```
UI Positioning Infrastructure
│
├── positioning.ts            纯函数：空间/对齐/尺寸/指针/居中（无 DOM、可单测）
│     ├── calculatePopupAvailableSpace()
│     ├── resolvePopupAlignment()
│     ├── resolvePopupPlacement()
│     ├── constrainPopupSize()
│     ├── resolvePointerMenuPosition()
│     └── centerPopupInViewport()
│
├── Popover.tsx               锚定弹层适配器：配置解析 + floating-ui 生命周期 + Portal + 栈
│     └── 内部 autoUpdate = 唯一的定位生命周期（不新增重复 Hook）
│
├── PointerMenu.tsx           指针菜单适配器：测量 → 纯函数定位 → Portal + 栈 + 键盘
│
├── Select / Combobox / DropdownMenu / DatePicker / DateTimePicker / Tooltip / TooltipLayer
│     └── 只声明策略与内容，不计算坐标
│
└── GlobalSearchDialog / FilesWorkspacePanel 抽屉 / TargetMenu / ShelfContextMenu / 回收站 / 分割线菜单
      └── 业务适配：选择正确的矩阵行 + 必要的业务特例
```

职责边界：

- **`positioning.ts` 不读 DOM**：输入矩形/视口/配置，输出决策与夹取后的坐标。
- **`Popover` 是唯一锚定几何执行者**：floating-ui 负责实测、翻转、平移与尺寸变量；
  纯函数负责尺寸上限与提示条/指针/居中这类「非 floating-ui 路径」。
- **`PointerMenu` 是唯一指针几何执行者**：锚点是坐标而不是元素，因此不使用
  floating-ui 的 reference；用 `resolvePointerMenuPosition` 计算最终 left/top。

### 5.1 方法契约

```ts
calculatePopupAvailableSpace({ anchor, viewport, side, offset, padding })
  → { top, bottom, left, right, main, cross }
```
- `top/bottom/left/right` 是各方向「扣除 collisionPadding 与 offset 后」的净空间；
- `main` 是按 `side` 取的主方向净空间，`cross` 是交叉轴可用长度（视口减两侧 padding）。

```ts
resolvePopupAlignment({ anchorLeft, anchorWidth, popupWidth, viewportWidth,
                       alignment, padding })
  → { alignment: "start"|"center"|"end", left, shifted }
```
- `auto`：start 可容纳 → start；否则 end 可容纳 → end；否则 center 可容纳 → center；
  都不行 → 选「需要夹取最少」的一侧并 `shifted=true`。
- 显式对齐：计算目标 left 后夹取；`shifted` 表示是否被夹取。

```ts
resolvePopupPlacement({ anchor, popup, viewport, config })
  → { side, alignment, left, top, availableWidth, availableHeight,
      flipped, aligned, shifted, constrained }
```
- `popup` 尺寸未知时传 `{width:0,height:0}`：不翻转，只按 `side` 输出主方向坐标；
- 主方向放不下且对侧更大 → `flipped=true`；
- `availableWidth/Height` 用于 `constrainPopupSize`；
- `aligned` = 最终对齐 ≠ 请求对齐；`shifted` = 交叉轴发生夹取。

```ts
constrainPopupSize({ anchorWidth, availableWidth, availableHeight, config })
  → { minWidth, maxWidth, maxHeight }
```
- `maxWidth = min(config.maxWidth ?? ∞, availableWidth)`；
- `minWidth = max(config.minWidth ?? 0, matchAnchorWidth ? anchorWidth : 0)`；
- **当 `minWidth > maxWidth` 时取 `maxWidth`**：不越界优先于「至少和触发器一样宽」；
- 高度同理，且不低于 72px（保证至少一行可见）。

```ts
resolvePointerMenuPosition({ x, y }, { width, height }, viewport, padding)
  → { left, top, flippedX, flippedY }
```
- 默认从指针右下展开；
- `x + width > viewport.width - padding` → 向左展开（`left = x - width`）；
- `y + height > viewport.height - padding` → 向上展开（`top = y - height`）；
- 最后四边夹取；菜单大于视口时由调用方限制尺寸，坐标取 `padding`。

```ts
centerPopupInViewport({ width, height }, viewport, padding)
  → { left, top }
```
- 仅供「锚点不可见/无锚点」的退化路径使用，不用于普通锚定弹层。

## 6. 定位生命周期与动态尺寸

`Popover` 内部 `useFloating.whileElementsMounted(autoUpdate)` 是唯一生命周期：

- `ancestorScroll: true`（页面滚动跟随）；
- `ancestorResize: true`（父容器尺寸变化）；
- `elementResize: true`（**锚点**与**弹层**尺寸变化，基于 ResizeObserver）；
- `layoutShift: true`（布局位移）。

必须覆盖的动态场景：

| 场景 | 机制 |
|---|---|
| 菜单内容异步加载（搜索结果、任务列表） | `elementResize` → 弹层尺寸变化重算 |
| 列表过滤后高度变化 | 同上，并配合 `--popover-max-h` |
| 窗口缩放 / 最大化 | `ancestorResize` + `window` resize（autoUpdate 内部） |
| DPI 缩放 / 多显示器切换 | WebView2 的 CSS viewport 随窗口 DIP 变化 → resize 重算；见 §7 |
| 触发器尺寸变化（文字变长、字号档位） | `elementResize` |
| 页面滚动 | `ancestorScroll` |
| 字体加载导致文本宽度变化 | `elementResize`（宽度变化）+ `size` 重算 |
| 内容展开/折叠 | `elementResize` |

**禁止**：只在打开时算一次；用 `setTimeout`/固定延时代替 ResizeObserver；
在 `positionOverride` 路径关闭监听后不补自己的监听。

> `positionOverride` 是业务特例逃生口（提示条）：使用时调用方必须自己保证
> 「锚点尺寸、弹层尺寸、窗口尺寸」三者变化都会重新测量；`TooltipLayer` 用
> `ResizeObserver` + `window.resize` 完成，且滚动时直接隐藏提示条（不跟随）。

## 7. 坐标系与 Tauri WebView

- **唯一坐标体系：CSS 布局视口**。`position: fixed` 的 `left/top` 与
  `getBoundingClientRect()` 同属该体系；`window.innerWidth/innerHeight`、
  `document.documentElement.clientWidth/clientHeight` 均可用。
- 不使用 `visualViewport`：桌面 WebView2 不做页面捏合缩放，`visualViewport`
  与布局视口一致；若未来启用浏览器缩放，必须整体切换坐标来源，**不允许混用**。
- `transform` 祖先会改变 `fixed` 的包含块：`Popover` 的 Portal 目标只能是
  `document.body` 或 `.ui-dialog-mask`（两者都没有 transform/filter），
  **不得**把弹层 Portal 进任何带 `transform` 的宿主（如 `.ui-popover-host`）。
- 多显示器/DPI：Tauri 窗口逻辑尺寸是 DIP，WebView2 CSS px 与 DIP 1:1 对应；
  切换显示器触发 resize → autoUpdate 重算。真机验收覆盖 100%/125%/150%/200%。

## 8. Portal、层级与嵌套

1. **Portal 归属**：锚点在 `.ui-dialog-mask` 内 → 挂进该遮罩（与对话框同一层叠上下文）；
   否则挂 `document.body`。判定只认 `findOverlayPortal`，业务不得自建 Portal 目标。
2. **层级**：弹层外壳 `z-index: var(--z-menu)`；模态 `--z-dialog`；提示条不进栈。
   禁止裸 `z-index` 数字。
3. **弹层栈**：所有可交互弹层必须 `useOverlayLayer("menu"/"dialog"/…)`；
   一次 Escape 只关最内/最高优先级一层。
4. **嵌套**：
   - Dialog 内 Select：菜单挂遮罩 → DOM 包含 → Escape 先关菜单；
   - Popover 内再开 Popover：内层后注册，同优先级取后注册者 → Escape 先关内层；
   - 外层关闭时必须同步卸载内层（内层由外层内容树渲染，随外层卸载）；
   - 焦点恢复只在 `isConnected` 时执行，避免恢复到已卸载节点。
5. **关闭清理**：卸载时注销栈条目、移除 document/window 监听、断开 ResizeObserver；
   Portal 节点随 React 卸载自动移除，禁止手工 `removeChild`。

## 9. 动画与定位协调

- 定位外壳与动画内层分离：`.ui-popover-host` 只承载 `transform` 定位，
  `.ui-popover` 负责 `ui-pop-in`。
- 动画 origin 由最终 placement 决定：
  - `bottom-*` → `top left/center/right`；
  - `top-*` → `bottom left/center/right`；
  - `left-*` → `right …`；`right-*` → `left …`；
  - 居中对齐（无后缀）→ 对应轴的中心。
- 入场位移方向随主方向：底部展开向下 2px、顶部展开向上 2px、左/右同理；
  翻转后必须使用翻转后的方向，不能固定 `translateY(-2px)`。
- 首帧不允许出现在旧/错误位置：`PointerMenu` 在测量完成前 `visibility:hidden`，
  同一 layout effect 内写最终坐标后再显示。
- 重新定位不允许闪烁：坐标更新走同一帧的 `transform`/`left-top` 写入，
  不触发额外动画；`prefers-reduced-motion` 下关闭入场动画。

## 10. 测试要求

### 10.1 纯函数单测（`positioning.test.ts`，node 环境）

必须覆盖：触发器在窗口四角与中心；弹层比触发器宽；弹层比可用空间宽；
下方空间不足；上下都不足；左右都不足；窄窗口/极窄窗口；不同 padding；
不同 alignment/side；指针菜单四边翻转；居中退化。

### 10.2 组件测试（jsdom + 伪造几何）

- `Popover.edge.test.tsx`：上下翻转、对齐收敛、视口边界、动态内容高度/宽度、
  窗口缩放、滚动、锚点尺寸变化、卸载与监听清理。
- `Select.test.tsx` / `Combobox.test.tsx` / `DropdownMenu.test.tsx`：
  默认对齐、显式对齐、宽度策略、键盘与焦点不退化。
- `PointerMenu.test.tsx`：右下角翻转、尺寸变化重定位、Escape 不隐藏窗口、
  外部点击关闭、焦点恢复。
- 几何断言必须验证 `left/right/top/bottom` 与触发器/窗口边界的关系，
  不能只断言 CSS 类名或 `data-placement`。

### 10.3 真实 UI 验收

自动化测试不能替代真机：窗口最大化/窄窗/快速缩放/多显示器/DPI 125%–200%、
系统级窗口区域裁剪（胶囊/投屏）、真实滚动容器内的右键菜单。证据保存到
`tmp/acceptance/global-popup-positioning/`。

## 11. 保留特殊实现清单（不得强行统一）

| 实现 | 理由 | 约束 |
|---|---|---|
| `ContextMenuApp`（`context-menu.html`） | 独立透明原生窗口；高度由 Rust `fit_context_menu` 收放并按锚点定位 | 只保证窗口内布局不溢出；不得改成 DOM Portal |
| 投屏工具栏「更多」面板 | 独立 `toolbar.html` 窗口，菜单是窗口布局的一部分（side/compact/bottom 三种模式） | 由窗口尺寸与 CSS 约束；不改用页面 Popover |
| 通知窗口 / Tab 提示窗口 | 原生独立窗口 | 不适用 |
| `Dialog` / `ImageLightbox` / `ShelfImageLightbox` | 模态，视口居中，独立层叠上下文 | 走 `.ui-dialog-mask`，不接 `placement` |
| `CollapsibleSection` 等内嵌展开 | 参与父容器布局与滚动 | 不 Portal |
| 拖拽跟随层（`DropPreview`、`CapsuleDragCursor`、比例提示） | 即时视觉反馈，不可交互 | 不接弹层栈 |
| 分割线比例菜单的焦点策略 | 焦点留在分割线，方向键继续调比例 | 用 `PointerMenu trapFocus={false}`，不得改成抢焦点菜单 |

特殊实现必须有：① 明确业务理由；② 对应测试；③ 在本清单登记。

## 12. 工程规范（新增/修改弹层的硬约束）

1. 新增普通下拉菜单**必须**使用 `Select` / `Combobox` / `DropdownMenu`；
   指针右键菜单**必须**使用 `PointerMenu`；大型面板**必须**使用 `Popover` +
   显式 `maxWidth/maxHeight`。
2. **禁止**业务页面出现 `window.innerWidth/innerHeight` 与
   `getBoundingClientRect()` 组合的边界计算；禁止自写 `clamp`。
3. **禁止**通过随意调整 `left/right/top/bottom` 或固定 `transform` 修补定位；
   定位问题必须回到基元修策略。
4. 新增弹层必须声明默认 `side` 与 `alignment`，并在组件注释里写明所属矩阵行。
5. 所有弹层必须考虑窗口缩放与动态内容尺寸：不得关闭 `autoUpdate`；
   例外走 `positionOverride` 时必须在调用方补 `ResizeObserver`。
6. 不得为普通下拉重复引入定位依赖；`@floating-ui/react` 是唯一允许的库。
7. 不得破坏弹层栈、焦点管理、键盘操作；新增菜单必须注册 `useOverlayLayer`。
8. 特殊定位必须有明确业务理由、对应测试，并登记到 §11。
9. 测试不得只断言类名；几何断言必须包含与触发器/窗口边界的距离。
10. 删除测试来「修复」失败是事故；未运行的测试不得标记通过。

## 13. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-11-19 | 建立规范；`Popover` 增加 `side/alignment/collisionPadding/尺寸上限/allowFlip`；新增 `positioning.ts` 与 `PointerMenu`；Select 默认对齐改为 start，Combobox 显式 start；TargetMenu、暂存区、回收站、分割线菜单迁移到统一基元；修正动画 origin 与全局搜索面板宽度。 |
| 2026-11-19 | 补充：`DropdownMenu` 暴露 `flipToSide`；以零尺寸锚点复用 DropdownMenu 的文件行/空白右键菜单设 `flipToSide={false}`，长菜单只在指针附近上下翻转并由可用高度滚动，不再跳到指针左侧/右侧。 |
