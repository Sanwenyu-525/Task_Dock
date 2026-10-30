# 09 · 组件 API（v0.6）

> 全部基元位于 `src/components/ui/`，由 `src/components/ui/index.ts` 统一导出。
> 本文只描述**对外契约**；视觉令牌见 [01-design-spec.md](01-design-spec.md)，
> 交互与键盘约定见 [08-interaction-spec.md](08-interaction-spec.md)。

```ts
import {
  Select, Combobox, DropdownMenu, Popover, DateTimePicker, NumberInput,
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
