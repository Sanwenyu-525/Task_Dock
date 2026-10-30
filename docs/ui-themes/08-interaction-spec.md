# 08 · 交互规范（v0.6）

> 适用范围：Task Dock 全部交互控件（按钮、输入框、搜索框、开关、单选、菜单、
> 弹窗、日期时间选择、提示条、滚动条、反馈提示）。
>
> 两条主线：
> 1. **两套视觉预设共用同一套结构与行为**——梦幻渐变与液态玻璃的差异只落在
>    Token（颜色 / 透明度 / 圆角 / 阴影 / 高光 / 动画）上，DOM 结构、ARIA 语义、
>    键盘契约完全一致。
> 2. **一个 Escape 只做一次关闭动作**——弹层栈统一调度，优先级固定。

---

## 1. 控件基元清单

全部基元在 `src/components/ui/`，通过 `src/components/ui/index.ts` 统一导出。

| 基元 | 文件 | 职责 |
| --- | --- | --- |
| `Select` | `Select.tsx` | 单选下拉（Select-Only Combobox） |
| `Combobox` | `Combobox.tsx` | 带搜索的可筛选下拉 |
| `DropdownMenu` | `DropdownMenu.tsx` | 操作菜单（含单选组） |
| `Popover` | `Popover.tsx` | 锚定式浮层（定位 / 翻转 / 边界收敛） |
| `DateTimePicker` | `DateTimePicker.tsx` | 日期时间选择（日历 + 时分） |
| `Dialog` / `ConfirmDialog` | `Dialog.tsx` | 普通弹窗 / 危险操作确认 |
| `Checkbox` / `Switch` | `Toggle.tsx` | 选择 / 开关 |
| `NumberInput` | `NumberInput.tsx` | 数值输入（带步进按钮） |
| `Tooltip` | `TooltipLayer.tsx` | 控件提示（全局单实例） |
| 弹层基础设施 | `overlay.ts` | 弹层栈注册、焦点陷阱、焦点恢复、滚动到可见区 |

API 细节见 [09-component-api.md](09-component-api.md)。

### 1.1 已替换的原生控件

项目内**不再存在原生 `<select>`**（`grep '<select' src` 无命中）。
逐项替换位置：

| 位置 | 控件 |
| --- | --- |
| `tasks/TasksPanel.tsx` | 排序、筛选（来源 / 状态 / 优先级） |
| `tasks/TaskEditor.tsx` | 优先级、分类、状态、重复规则；提醒时间用 `DateTimePicker` |
| `tasks/QuickAdd.tsx` | 提醒时间用 `DateTimePicker` |
| `history/HistoryPanel.tsx` | 来源筛选、类型筛选 |
| `actions/ActionCenterPanel.tsx` | 类型、来源、任务、优先级筛选 |
| `settings/SettingsPanel.tsx` | 主题 / 材质 / 端口 / 保留天数 / 队列容量等 |
| `settings/AppManagement.tsx` | 来源筛选、分类、跳转方式 |
| `clipboard/TaskLinkBar.tsx`、`clipboard/WorkspaceLinkBar.tsx` | 关联目标用 `Combobox` |
| `agents/MockControls.tsx` | 来源选择 |
| `context/TaskContextDrawer.tsx` | 勾选筛选用 `Checkbox` |

### 1.2 控件提示

- 图标按钮统一用 `data-tip`（主题化提示条），**不再使用原生 `title`**——
  原生提示是操作系统样式，无法适配两套预设与深色主题。
- 纯文本截断提示（`<span title="完整路径">`）仍保留原生 `title`：
  那是「显示被截断内容」的标准做法，不是控件提示。
- 提示条由 **全局单实例** `TooltipLayer` 承载（事件委托），不随控件数量增长。
- 提示条不参与 Escape 弹层栈，也**不抢焦点**。

---

## 2. 键盘契约

### 2.1 Select / Combobox

焦点**始终留在触发按钮**上，用 `aria-activedescendant` 指向当前高亮项。

| 按键 | 行为 |
| --- | --- |
| `Enter` / `Space` | 展开；已展开时选中当前高亮项 |
| `↑` / `↓` | 移动高亮（**跳过禁用项**）；未展开时展开并定位到已选项的相邻项 |
| `Home` / `End` | 跳到首个 / 末个可用项 |
| `Esc` | 只关闭当前菜单，焦点回到触发按钮 |
| `Tab` | 收起菜单并**正常离开**（不拦截焦点移动） |
| 字母键 | 前缀快速定位（600 ms 内连续输入合并） |

`Combobox` 额外支持输入过滤；`↑↓` 在有输入时用于移动高亮，`Enter` 选中。

### 2.2 DropdownMenu

展开后焦点交给菜单项（`role="menu"` / `menuitem` / `menuitemradio`）。

| 按键 | 行为 |
| --- | --- |
| `↑` / `↓` | 移动高亮，跳过禁用项 |
| `Home` / `End` | 跳首尾可用项 |
| `Enter` / `Space` | 触发当前高亮项并收起 |
| `Esc` | 只关闭本菜单，焦点回到触发器 |
| `Tab` | 收起菜单并正常离开 |
| 字母键 | 按标签前缀快速定位 |

禁用项：渲染为 `aria-disabled="true"`，不可高亮、不可触发。
单选组：渲染为 `menuitemradio` + `aria-checked`，展开时默认落在已选项。

### 2.3 弹层栈与 Escape 优先级

```
最上层确认框(dialog) → 子弹层(sublayer) → 下拉菜单(menu) → 临时抽屉(drawer) → 主窗口
```

- 全局只有一个 Escape 分发器（`src/lib/overlayStack.ts`，模块加载即安装），
  在 **capture 阶段**消费按键：命中栈顶后同步摘除该层并
  `preventDefault + stopPropagation + stopImmediatePropagation`。
- **一次 Escape 只会关闭一层**，绝不会「菜单关了窗口也跟着藏进托盘」。
- 栈空时，Escape 走窗口级动作（隐藏到托盘）。
- 同种类嵌套按 **DOM 嵌套深度**判定内层优先（React 的 effect 是子先于父执行的，
  只看注册顺序会让外层反超内层）。

### 2.4 焦点恢复

| 场景 | 行为 |
| --- | --- |
| 菜单 / 下拉关闭 | 焦点回到触发按钮 |
| 模态弹窗关闭 | 焦点回到打开它的元素 |
| 弹层打开期间 `Tab` | 焦点在弹层内循环（`useFocusTrap`） |
| 提示条关闭 | **不夺回焦点**（否则用户 Tab 走会被拽回原控件） |

---

## 3. 定位规则

浮层定位统一交给 `@floating-ui/react`（**只做定位这一件事**，不引入整套 UI 框架）：

| 中间件 | 作用 |
| --- | --- |
| `offset(6)` | 与锚点保持间距 |
| `flip({padding:8, fallbackAxisSideDirection:"start"})` | 底部空间不足时**向上弹出** |
| `shift({padding:8, crossAxis:true})` | 窄窗口内沿轴向平移，不溢出边界 |
| `size({padding:8})` | 把可用高度/宽度写进 `--popover-max-h/-w`，长列表在浮层内滚动 |
| `strategy:"fixed"` | 浮层相对视口定位，不受祖先 `overflow` 裁剪 |
| `autoUpdate` | 监听祖先滚动 / 缩放 / 元素尺寸变化后重算 |

浮层统一 `createPortal` 到 `document.body`，因此**不会被内容面板的裁剪或层叠上下文关住**。

### 3.1 层级刻度

刻度集中定义在 `src/styles-ui.css`，业务样式里不再写裸 `z-index` 数字：

```
--z-content: 1  <  --z-sticky: 5  <  --z-drawer: 60  <  --z-modal: 70
              <  --z-modal-top: 80  <  --z-menu: 900  <  --z-dialog: 940  <  --z-toast: 980
```

**禁止通过无限提高 z-index 规避结构问题。**
`.dock-window > .titlebar` 与 `.dock-window > .dock-body` 保持 `z-index: auto`，
不建立层叠上下文——否则浮层会被关在内容面板里，永远压在模态遮罩之下。
这条约束由 `src/styles-themes.test.ts` 守住。

---

## 4. 控件状态

每个交互控件都必须覆盖下列状态，且**同一类控件的状态表现一致**：

| 状态 | 要求 |
| --- | --- |
| Default | 表面色取自 `--control-face`，描边取自 `--border-subtle` |
| Hover | 背景提亮一档（`--surface-hover`），过渡 ≤ 140 ms |
| Pressed | 背景压暗一档（`--control-shadow-press`），**不改变元素尺寸**（不引起布局跳动） |
| Focus-visible | 保留键盘焦点环（`--control-shadow-focus`），**不得为了美观取消** |
| Selected | 用预设的强调色（梦幻渐变=淡紫，液态玻璃=蓝紫），并有形状或图标佐证，不能只靠颜色 |
| Disabled | 降不透明度并禁用指针事件，**保留可读的对比度**，不用 `cursor:not-allowed` 之外的花哨样式 |
| Loading | 用「呼吸」代替持续旋转（`prefers-reduced-motion` 下彻底静止） |
| Error | 错误色 + 文案说明，不能只靠红色 |
| Empty | 空状态插画 + 明确的下一步动作，不能是空白 |

### 4.1 视觉细节约定

- **弹层表面必须不透明**：`--menu-face` / `--dialog-face` 不带 alpha。
  玻璃感来自高光与边缘反射，不来自半透明盖在深色正文上（否则文字对比度塌掉）。
- **不对整个弹出菜单叠加实时 `backdrop-filter`**：菜单里只画一层静态渐变/高光。
  这条由 `src/styles-themes.test.ts` 守住。
- 内容区里的卡片允许半透明（`--card-face`），但**不要给所有小控件叠加玻璃特效**。
- 深色主题与 Solid 材质下同样保证文字对比度。

### 4.2 无障碍与环境适配

- 尊重 `prefers-reduced-motion: reduce`：关闭入场动画与过渡。
- 尊重 `prefers-contrast: more`：装饰隐藏、描边加强（`CanvasText` / `Canvas`）。
- 焦点环只对键盘可见（`:focus-visible`），鼠标点击不残留。
- 状态变化用 `aria-*` 表达（`aria-expanded` / `aria-pressed` / `aria-checked` /
  `aria-selected` / `aria-activedescendant` / `aria-disabled`）。

---

## 5. 性能约定

- 整份样式表**无常驻动画**；背景装饰是单个伪元素上的静态渐变层（一次绘制，空闲 0 帧）。
- 弹层浮出动画 ≤ 100 ms，只做 `opacity` / `translateY`，不动 `width` / `height`。
- 提示条全局单实例，悬停延迟 350 ms，不常驻。
- 剪贴板变更监听全局单例（引用计数），高频采集事件合并为一次刷新（300 ms 去抖）。
