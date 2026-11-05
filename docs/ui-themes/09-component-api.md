# 09 · 组件 API（v0.6）

> 全部基元位于 `src/components/ui/`，由 `src/components/ui/index.ts` 统一导出。
> 本文只描述**对外契约**；视觉令牌见 [01-design-spec.md](01-design-spec.md)，
> 交互与键盘约定见 [08-interaction-spec.md](08-interaction-spec.md)。

```ts
import {
  Select, Combobox, DropdownMenu, Popover, DateTimePicker, DatePicker, NumberInput,
  Tooltip, Dialog, ConfirmDialog, Checkbox, Switch,
  useOverlayLayer, useFocusTrap, useFocusRestore,
} from "../components/ui";
```

---

## 1. Select

单选下拉。焦点**始终留在触发按钮**，展开态用 `aria-activedescendant` 指向高亮项
（Select-Only Combobox 模式）。

```ts
interface SelectOption<T extends string = string> {
  value: T;
  label: string;
  disabled?: boolean;   // 不可高亮、不可选中
  icon?: ReactNode;     // 触发按钮与选项前的前缀图形
  hint?: string;        // 选项右侧的补充说明
}

interface SelectProps<T extends string = string> {
  value: T | "" | null | undefined;
  options: ReadonlyArray<SelectOption<T>>;
  onChange: (value: T) => void;
  placeholder?: string;              // 默认 "请选择"
  disabled?: boolean;
  ariaLabel?: string;                // 触发按钮的可访问名
  id?: string;
  className?: string;                // 外层容器
  triggerClassName?: string;         // 触发按钮本身
  size?: "sm" | "md";                // 默认 "md"
  placement?: "bottom-start" | "bottom-end" | "top-start" | "top-end";
  block?: boolean;                   // true = 触发按钮撑满容器宽度
}
```

要点：

- `value` 允许 `""` / `null` / `undefined` 表示「未选择」，触发按钮显示 `placeholder`。
- `onChange` **只在用户真正选中时触发**，打开/关闭不触发——避免父组件把「打开」
  当成「改值」。
- 禁用项渲染为 `aria-disabled="true"`，键盘导航会跳过。

## 2. Combobox

带搜索的可筛选下拉。与 `Select` 共享 `SelectOption` 与同一套键盘契约。

```ts
interface ComboboxProps<T extends string = string> {
  value: T | "" | null | undefined;
  options: ReadonlyArray<SelectOption<T>>;
  onChange: (value: T) => void;
  searchPlaceholder?: string;
  emptyText?: string;                // 无匹配时的提示文案
  ariaLabel?: string;
  id?: string;
  disabled?: boolean;
  className?: string;
  size?: "sm" | "md";
  filter?: (option: SelectOption<T>, query: string) => boolean; // 自定义过滤
  placeholder?: string;
}
```

要点：

- 输入框内可打字过滤；`↑↓` 移动高亮，`Enter` 选中，`Esc` 清空输入并收起。
- `filter` 缺省为「label 与 query 不区分大小写包含」。

## 3. DropdownMenu

操作菜单。支持普通项与**单选组**两种形态。

```ts
interface DropdownMenuItem {
  key: string;
  label: string;
  icon?: ReactNode;
  description?: string;   // 第二行说明文字
  trailing?: ReactNode;   // 右侧尾部内容（快捷键、计数等）
  disabled?: boolean;
  danger?: boolean;       // 危险项（删除等）用错误色
  radio?: boolean;        // 渲染为 menuitemradio
  checked?: boolean;      // radio 组的选中态
  onSelect?: () => void;  // 不传则整个菜单为纯展示
}

interface DropdownMenuProps {
  trigger: (props: DropdownMenuTriggerProps) => ReactNode; // 触发器由调用方渲染
  items: ReadonlyArray<DropdownMenuItem>;
  menuLabel?: string;      // role="menu" 的可访问名
  placement?: "bottom-start" | "bottom-end" | "top-start" | "top-end";
  matchWidth?: boolean;    // 弹出层宽度跟随触发器
  className?: string;
  disabled?: boolean;
  onOpenChange?: (open: boolean) => void;
}

interface DropdownMenuTriggerProps {
  ref: (el: HTMLElement | null) => void;  // 必须挂到触发元素上（定位锚点）
  expanded: boolean;                       // → aria-expanded
  onClick: () => void;
  onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => void;
}
```

要点：

- `trigger` 是**渲染函数**而不是元素：菜单需要拿到触发器的 DOM 引用做定位，
  也需要接管键盘事件。调用方必须把 `props.ref` 挂到真实元素上。
- 展开后焦点**进入菜单**（`role="menu"` / `menuitem` / `menuitemradio`），
  与 `Select` 的「焦点留在触发器」不同——这是 ARIA 两种模式的既定差异。
- `items` 为空数组时不渲染触发器（避免出现点不开的空菜单）。

## 4. Popover

锚定式浮层。**只负责定位与承载**，内容由调用方提供。

```ts
interface PopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  anchorRef: RefObject<HTMLElement | null>;
  children: ReactNode;
  placement?: Placement;          // 默认 "bottom-start"
  className?: string;
  layer?: OverlayKind | null;     // null = 不参与 Escape 弹层栈（提示条）
  matchWidth?: boolean;           // 最小宽度跟随锚点
  offsetPx?: number;              // 默认 6
  role?: string;
  ariaLabel?: string;
  id?: string;
  style?: CSSProperties;
  onKeyDown?: (e: ReactKeyboardEvent<HTMLDivElement>) => void;
  restoreFocus?: boolean;         // 默认 true；提示条必须 false
  dismissOnOutsidePress?: boolean;// 默认 true；提示条必须 false
}
```

要点：

- 浮层通过 `createPortal` 渲染到 `document.body`，**不受内容面板裁剪影响**。
- 定位中间件固定为 `offset → flip → shift → size`，底部空间不足自动向上翻转。
- `layer={null}` 表示「不注册进弹层栈」：提示条用这种模式，
  避免 Escape 把提示条当成一层去关（也会挡住「Esc 隐藏窗口」）。

## 5. DateTimePicker

日期 + 时间选择（日历网格 + 时分输入）。

```ts
interface DateTimePickerProps {
  value: string;             // "YYYY-MM-DDTHH:mm"（本地时间）
  onChange: (value: string) => void;
  onClear?: () => void;       // 传入才显示「清除」按钮
  placeholder?: string;
  ariaLabel?: string;
  id?: string;
  disabled?: boolean;
  className?: string;
  size?: "sm" | "md";
  clearable?: boolean;
  minuteStep?: number;        // 分钟步进，默认 5
}
```

**数据语义（不允许为了美观破坏）**：

| 规则 | 说明 |
| --- | --- |
| 值格式 | 一律 `YYYY-MM-DDTHH:mm`，**本地时间**，不带秒、不带时区后缀 |
| 转换 | 与后端交互走 ISO 字符串，转换在 `src/lib/format.ts` 的 `to/fromLocalInputValue` |
| 编辑既有值 | **不截断秒**——从 ISO 读入时若带秒，只取到分，回写时不产生新的秒偏移 |
| 未触碰字段 | 打开日历但没改动的日期字段**保持原值**，不重置为今天 |
| 提醒与截止 | 两个时间互相独立，改一个不影响另一个 |
| 校验 | 非法值（如 2 月 30 日、25:00）拒绝提交并给出提示，不写脏数据 |

解析与日历网格的纯函数在 `src/lib/datetime.ts`（`parseLocalInput` / `formatLocalInput` /
`parseLooseInput` / `monthGrid` / `shiftDay` / `shiftMonth`）。

## 5.1 DatePicker（纯日期）

只处理 `YYYY-MM-DD`，**不携带时间语义、不转 UTC**。日历面板与 DateTimePicker 共用
`CalendarGrid`（月份切换、周标题、选中/今天、方向键、PageUp/PageDown、Home/End、Enter/Space）。

```ts
interface DatePickerProps {
  value: string;              // "YYYY-MM-DD"；空串 = 未设置
  onChange: (value: string) => void;
  placeholder?: string;       // 默认 "YYYY-MM-DD"
  ariaLabel?: string;
  disabled?: boolean;
  clearable?: boolean;        // 默认 true；底部「清除」
  size?: "sm" | "md";
  className?: string;
}
```

**交互与数据规则**：

| 规则 | 说明 |
| --- | --- |
| 开关 | 点输入框展开；日历图标可开可关；点外部或 Escape 只关日历（复用 Popover + overlayStack） |
| 选择 | 选日期立即 `onChange` 并关闭；底部「清除」提交空串，「今天」取本地今天；无确认按钮 |
| 手输 | 接受 `2026-11-04` / `2026/11/4`，Enter 或失焦时规范化为 `YYYY-MM-DD`；非法输入只提示、不回调 |
| 防重 | 值未变不重复回调；开关日历、切月不触发 `onChange` |
| 校验 | 纯字符串年月日校验（闰年、月天数、跨年），不经 `Date`/UTC，避免时区偏移 |
| 布局 | 面板 272px；下方空间不足自动上翻；窄窗由 Popover 的 size 中间件收敛；仍放不下时日历区内部滚动、底部操作固定；不改变主窗口尺寸 |

纯函数在 `src/lib/datetime.ts`（`todayIsoDate` / `parseDateInput` / `isValidIsoDate`）。

## 5.2 DatePicker / DateTimePicker 视觉规格（2026-11-05 统一）

两者**只统一视觉语言，不统一提交语义**：纯日期选中即提交并关闭；日期时间需选日期与时间，
底部提供「清空 / 现在」，不额外强制确认按钮。差异属有意设计。

共享结构（`src/styles-ui.css`，全部走语义 Token，不复制第二套）：

| 部件 | 规格 |
| --- | --- |
| 触发器 `.ui-date-trigger` | `inline-flex`、gap 6px、`--input-font-size`、圆角 `--radius-control`、表面 `--control-face`/`--control-shadow`，hover/active/focus/disabled 与 Select 触发器一致；`size-sm` 高度 26px / 字号 12px，`md` 高度 30px / 字号 13px |
| 面板 `.ui-date-panel` | 宽 `min(272px, calc(100vw - 24px))`、gap 8px、padding 4px；超出可视区由 Popover 翻转并在内部滚动，底部操作固定 |
| 日格 `.ui-cal-day` | 高 28px、字号 11.5px、圆角 7px；hover 走 `--menu-hover`，active/选中走 `--menu-active-face`，`focus-visible` 用 accent 内描边 |
| 周标题 / 月份切换 | 周标题由 Intl 生成；月份切换复用 `.icon-btn.sm`（22×22） |
| 底部操作 `.ui-date-actions` | 上边框 `--divider`、`space-between`：左侧为次要操作「清除 / 清空」（`.ui-date-link`），右侧为强调操作「今天 / 现在」（`.ui-date-link.is-accent`），字号 11px |
| 主题 | 深浅主题与两套视觉预设均复用同一套 Token；不写硬编码颜色 |

实现提示：全局样式层顺序为 `base → theme → ui → menu → ntf → widget-window`，
`widget-window` 层存在未限定作用域的 `button` 重置，会压过 `@layer ui` 内的按钮样式。
日期组件因此在 `styles-ui.css` 末尾保留一段**非分层**的重置块（仅作用于上述类名），
后续若把该全局 `button` 重置收敛到 `.widget-window` 作用域内，可删除这段兜底。

## 6. NumberInput

数值输入，带步进按钮。

```ts
interface NumberInputProps {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  id?: string;
  className?: string;         // 外层
  inputClassName?: string;    // 输入框本身
  ariaLabel?: string;
  size?: "sm" | "md";
  suffix?: ReactNode;         // 单位后缀，如 "px" / "天"
  showSteppers?: boolean;     // 默认 true
}
```

要点：

- 基于原生 `<input type="number">`，但隐藏了浏览器自带的步进箭头（改用自绘按钮），
  避免出现两套外观。
- 越界时按 `min`/`max` 夹取后回写，`onChange` 收到的永远是合法值。

## 7. Dialog / ConfirmDialog

```ts
interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg";
  className?: string;
  ariaLabel?: string;
  dismissOnScrim?: boolean;   // 默认 true
  panelClassName?: string;
}

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  detail?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;           // 危险操作：确认按钮用错误色
  busy?: boolean;             // 提交中：禁用按钮并显示等待态
  onConfirm: () => void;
  onCancel: () => void;
}
```

要点：

- 弹窗是**模态**：遮罩吞掉底层点击，焦点被 `useFocusTrap` 关在弹窗内，
  关闭后焦点回到打开它的元素。
- `ConfirmDialog` 在弹层栈里是 `dialog` 层，优先级高于菜单与抽屉。

## 8. Checkbox / Switch

```ts
interface CheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: ReactNode;
  disabled?: boolean;
  id?: string;
  className?: string;
  ariaLabel?: string;
}

interface SwitchProps { /* 同上，语义为开关 */ }
```

两者都渲染成真实可聚焦控件：Checkbox 用 `role="checkbox"`，Switch 用 `role="switch"`
+ `aria-checked`，支持空格切换。

## 9. Tooltip

**全局单实例**的控件提示层，不是一个可包裹的组件。

```tsx
// App.tsx 挂一次即可
<TooltipLayer />
```

用法是给任意元素加 `data-tip`：

```tsx
<button className="icon-btn" data-tip="刷新" aria-label="刷新">…</button>
```

规则：

- 悬停 350 ms 后出现，移开即消失；键盘聚焦立即出现。
- 提示条**不抢焦点**（`restoreFocus=false`）、**不吞外部点击**（`dismissOnOutsidePress=false`）。
- 原生 `title` 与 `data-tip` 不要同时出现在同一元素上。

## 10. 弹层基础设施（overlay.ts / overlayStack.ts）

```ts
// 在 overlayStack.ts
type OverlayKind = "dialog" | "sublayer" | "menu" | "drawer";
registerOverlay(entry): () => void;   // 返回注销函数
overlayStack(): readonly OverlayEntry[];
topOverlay(): OverlayEntry | undefined;
hasOverlay(kind?): boolean;
setWindowEscapeHandler(fn: (() => void) | null): void; // 栈空时 Escape 的动作

// 在 overlay.ts（React Hook）
useOverlayLayer(kind, active, onClose, rootRef?): void;
useFocusTrap(active, rootRef): void;
useFocusRestore(active): void;
scrollIntoViewIfNeeded(container, item): void;
```

- `useOverlayLayer` 把组件注册进全局栈；`kind` 决定 Escape 优先级：
  `dialog(3) > sublayer(2) > menu(1) > drawer(0)`。
- `useFocusTrap` 用于模态（弹窗、抽屉）：Tab 焦点在容器内循环。
- `useFocusRestore` 用于「关闭后把焦点还给触发元素」；提示条**不要**用它。

---

## 11. 使用约定

1. **不要在业务组件里直接写原生 `<select>`**：一律用 `Select` / `Combobox`。
   `src/styles-themes.test.ts` 会对 `src/` 做守卫。
2. **不要写裸 `z-index` 数字**：用 `styles-ui.css` 里的 `--z-*` 刻度。
3. **新弹层必须调 `useOverlayLayer`**：否则 Escape 不会关它，而是直接隐藏窗口。
4. **图标按钮必须给 `aria-label`**：窄窗下文字标签会隐藏，可访问名不能丢。
   提示文案同时放 `data-tip`。
5. **新控件必须覆盖 9 种状态**（Default/Hover/Pressed/Focus-visible/Selected/
   Disabled/Loading/Error/Empty），见 [08-interaction-spec.md](08-interaction-spec.md) 第 4 节。

### 复用约束（10 条，2026-11-04）

1. 新建 UI 前先查 `src/components/ui/` 与 `index.ts`；已有组件能覆盖就**扩展 props**，不复制第二版。
2. 再查设计系统基础样式（`.surface-card`、`.input-embedded`、`.search-box`、`.icon-btn`、
   `--interactive` / `--selected`）与语义 Token；能用既有结构就不新增平行类。
3. 同语义重复出现时优先合并；只有**业务语义不同**（即使颜色相同）才允许独立实现。
4. 公共组件只承担通用职责：布局/交互/视觉；业务状态枚举、取数、持久化、请求过滤一律留在业务层。
5. 新公共组件必须有导出的 Props 类型与最小单测（结构、ARIA、禁用态、主题/尺寸变体）。
6. 新增 CSS 前先查重：优先补公共组件块或页面级宽度/密度差异；不新增第二套卡片、输入、焦点环。
7. 焦点环只允许一层：容器负责唯一高亮，内层 `input` 用 `.input-embedded` 不重复绘制。
8. 修样式冲突靠**收敛选择器与语义 Token**，不靠提高 specificity、`!important` 或叠加覆盖规则。
9. 不因「看起来相似」强行合并不同业务状态映射；徽标文案与状态枚举仍由业务层决定。
10. 迁移页面时保留原有搜索/筛选/持久化/键盘逻辑；只替换视觉与结构，逐页判定语义是否相同。

---

## 12. CollapsibleSection（可折叠分组，2026-11-04）

`src/components/ui/CollapsibleSection.tsx`，由设置页 `Section` 的交互模式抽象而来，
外观与设置页折叠分组一致（`.collapsible-section*`，全部使用现有语义 Token）。

**职责**：只负责「标题行 + 可展开内容」的结构与交互，不承载业务、不读写存储。

**Props**：
`title`（纯文本）、`icon?`、`description?`、`badge?`、`actions?`（标题右侧操作区）、
`expanded?` + `onExpandedChange?`（受控，优先）、`defaultExpanded?`（非受控）、
`disabled?`、`id?`（稳定 `aria-controls` 前缀）、`className?`、`children`。

**焦点**：内容区聚焦时点标题折叠，焦点先收回触发按钮；受控父组件从外部收起时，
布局阶段检查 `document.activeElement` 并回收焦点（用聚焦标记 + 一次 layout effect，
不注册 document 监听、不用定时器）。内容容器始终存在，折叠时 `hidden` 且不渲染子节点，
`aria-controls` 始终指向真实节点。

**持久化约定**：组件**不写 localStorage**。需要跨会话记忆时由调用方用
`src/lib/collapsibleState.ts`（版本化结构、损坏/不可用回退默认值、只接受声明键），
分组 ID 用稳定英文标识，禁止用中文标题做键。

**适用**：设置项分组、接入/桥接等低频大区块的渐进披露。
**不适用**：单条列表项的内联展开（如 Agent 卡片详情）、高频切换的筛选面板；
不要为复用给每个列表项再套一层大卡片外壳。

**标题区结构（2026-11-05）**：标题区固定为两层，避免按卡片高度或固定偏移做补丁：

- 标题行 `.collapsible-title-row`：`[图标] [标题] [badge]` 的 `.collapsible-title` + `.collapsible-chevron`；
- 描述 `.collapsible-desc`：标题行的下一个兄弟节点，位于 `.collapsible-text` 内。

箭头只与标题行中心对齐（`align-items: center`），不再与「标题 + 描述」整体垂直居中；
描述与箭头横向同列但处于下一行，不做绝对定位。无描述时高度仍为单行标题；
标题或描述换行由 flex 布局自适应，箭头 `flex: 0 0 auto` 不被挤压。
依赖 DOM 位置的测试与样式覆盖应使用 `.collapsible-title-row`，不要再假定箭头是按钮的最后一个子节点。

**设置页已迁移（2026-11-04）**：`SettingsPanel.tsx` 的局部 `Section` 已改为
`CollapsibleSection` 的薄适配层；`settingsSections.ts` 与既有存储键保持不变，
跨页定位改用 `[data-collapsible-section="settings-<id>"]` 并自动展开目标分组。
业务操作、默认折叠与用户偏好均未重置。

## 13. SearchField（搜索输入，2026-11-04）

`src/components/ui/SearchField.tsx`。只做输入交互与视觉，**不负责过滤、请求、防抖或匹配算法**。

```ts
interface SearchFieldProps {
  value: string;
  onChange: (value: string) => void;      // 只回传字符串
  ariaLabel: string;                      // 必填
  placeholder?: string;
  clearLabel?: string;                    // 默认「清除搜索」
  icon?: ReactNode;                       // 缺省 Search 图标
  onClear?: () => void;                   // 先 onChange("")，再回调
  onKeyDown?: (e: ReactKeyboardEvent<HTMLInputElement>) => void;
  disabled?: boolean;
  autoFocus?: boolean;
  size?: "compact" | "default";           // 13px / 12px（均用输入 Token）
  className?: string;
  inputRef?: RefObject<HTMLInputElement | null>;
}
```

要点：容器复用 `.search-box` 表面 + `.ui-search` 尺寸，输入挂 `.input-embedded`，
焦点环只由容器 `:focus-within` 表达（含两套预设的玻璃/内凹样式）；清空按钮始终占位，
出现/消失不改变输入宽度。Escape 只转发给调用方；输入法组合输入期间不转发按键。
`SearchField` 未覆盖带自动补全的 `Combobox`：后者保留自身键盘与过滤语义。

**胶囊外观变体（2026-11-05）**：传 `size="compact"` 并追加 `className="ui-search--capsule"`
即可让贴边工具面板复用同一组件，而不复制输入结构。该变体只把表面、高度与圆角映射到
`--cap-*` / `--input-height-sm`；焦点仍只由容器表达。贴边面板的应用搜索（`AppsLite`）
已使用该变体，快速添加任务输入则复用 `.cap-input + .input-embedded`，两者都不得在内层
`input` 上再画背景、边框或焦点阴影。

**字号（2026-11-05 补充，全局 compact 档）**：`SearchField` 的 compact 档不再使用
sm 档 12px，改用常规档 `--input-font-size`（13px）+ `--input-line-height`（1.45）。
真实 Chromium 实测（AppPicker）：12px 时 font box 约 11px，13px 时约 12px，原生 caret
视觉高度随之恢复；容器由清空按钮 22px + 垂直留白 4px 维持 26px，`min-height:26px`
兜底，Notes/Clipboard/AppPicker 等工具栏行高不变。聚焦仍只由容器 `:focus-within`
表达，内层 `input` 不得出现第二个焦点环。胶囊搜索（`.ui-search--capsule`）高度为
`--input-height-sm`（30px），字号同样走 compact 全局规则，不单独设值。

## 14. StatusBadge（状态徽标，2026-11-04）

`src/components/ui/StatusBadge.tsx`。只负责语义色、尺寸、图标与长文案换行。

```ts
type StatusTone = "neutral" | "info" | "success" | "warning" | "danger";
interface StatusBadgeProps {
  tone: StatusTone;
  size?: "sm" | "md";        // 9px / 10px
  icon?: ReactNode;
  children: ReactNode;
  className?: string;
  dataTip?: string;          // 统一 data-tip，不用原生 title
}
```

颜色只引用 `--status-*` / `--accent` / `--text-tertiary`。业务状态到 tone 的映射
（如 Agent 健康状态、规划状态、收集箱状态）必须留在业务组件，不写进本组件。

## 15. 卡片分层（2026-11-04）

| 结构 | 职责 | 不负责 |
|---|---|---|
| `.surface-card` | 卡面：`--card-face` 背景、`--radius-card` 圆角、`--card-shadow` 阴影 | 交互、选中、业务状态 |
| `.surface-card--interactive` | 整卡可点击：hover 阴影抬升 + 1px 位移、`focus-visible` 焦点环、`cursor:pointer` | 选中识别 |
| `.surface-card--selected` | 选中识别：`--accent-soft` 衬底 + 识别环，不改变卡片深度 | hover 抬升、状态色 |
| `.task-card` | 兼容旧引用的任务卡选择器，共享 `.surface-card` 卡面 + `--task-flow` 变体 + 自身内边距 | 新组件不应再新增同类兼容选择器 |
| `.panel-block` | 设置/表单里的小块容器：1px 边框 + 卡片圆角 + `--surface-raised`，属于轻量分区而非可交互卡 | 折叠、选中、整卡点击 |
| `CollapsibleSection` | 大区块渐进披露的完整外壳（标题行 + 卡面 + 内容区） | 列表项内联展开、业务持久化 |

规则：
- 普通卡片一律 `.surface-card`；可点击追加 `--interactive`，选中追加 `--selected`，不复制卡面。
- 纯布局容器（栅格、分组、工具条）**不加卡面/边框/阴影**；单条列表详情用内联展开，不套大折叠外壳。
- 禁止新建与 `.surface-card` 重复的 `GlobalCard` 或页面级卡片基类；页面只允许补宽度/密度/内容结构。
- 删除局部卡面定义前先用引用检索确认无使用；状态色与卡面职责分离，不把 `--status-*` 写进卡面基类。

## 16. 输入框 Typography 与原生光标（2026-11-04）

Token 位于 `src/styles-ui.css` 的 `@layer ui :root`，所有文本输入共用：

| Token | 值 | 用途 |
|---|---|---|
| `--input-font-size-sm` | 12px | 高度受限的微输入（设置数字输入、日期/时间）；SearchField compact 已提升到常规档 13px |
| `--input-font-size` | 13px | 常规单行/多行文本输入（默认档） |
| `--input-font-size-lg` | 14px | 大号输入预留档（全局搜索等） |
| `--input-line-height` | 1.45 | 统一输入行高，与正文一致 |
| `--input-height-sm` | 30px | 胶囊搜索/快捷输入等紧凑单行控件高度 |
| `--input-caret-color` | `var(--accent)` | 原生光标颜色，随主题切换 |

规则：
- 原生光标高度跟随字体度量（≈ `font-size`），`caret-color` **只改颜色**；光标偏小必须回到字号与行高，禁止伪元素、假光标、动画或 JS 模拟。
- 常规输入 13px；紧凑输入不低于 12px。高度差由 padding / 控件高度承担，不能靠压低字号。
- 焦点环只由容器 `:focus-within` 提供一层；内层 `input` 不写 `outline` / `box-shadow`，聚焦不改变控件尺寸。
- 新增输入先查 `SearchField`、`.input-embedded` 与本 Token 表，不另造字号或焦点样式；`caret-color` 不用于修高度。
