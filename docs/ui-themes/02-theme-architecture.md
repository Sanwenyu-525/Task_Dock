# 02 · 主题系统与状态管理

> 目标：**不建立第二套冲突的主题系统**。v0.5 已有的 `theme`（明暗）与 `material`（材质）保持原语义，
> v0.6 只新增一个正交维度 `visual_preset`（设计语言），三者共同决定界面。

---

## 1. 三个维度

| 维度 | 取值 | 语义 | 持久化键 | DOM 载体 |
| --- | --- | --- | --- | --- |
| 视觉预设 | `dream-gradient` / `liquid-glass` | 设计语言：表面、边光、发光、圆角 | `visual_preset` | `html[data-preset]` |
| 明暗 | `light` / `dark` / `system` | 色板明暗 | `theme` | `html[data-theme]` |
| 材质 | `solid` / `glass` | 是否用原生材质透出桌面 | `material` | `html[data-material]`（**实际生效值**） |

补充标记：

- `html[data-native-glass="true|false"]`：原生 Mica/Acrylic 是否真的在起作用。
  与 `data-material` 的区别是：`data-material=glass` 表示**界面按玻璃语言渲染**，
  `data-native-glass=true` 表示**背后真的有系统模糊**。液态玻璃的降级样式按后者判断。
- `html[data-reduced-motion]`：仅作验收可观测标记，样式收敛由 CSS 媒体查询完成。

### 关系矩阵（有效性）

| 预设 | material=solid | material=glass + 原生可用 | material=glass + 原生不可用 |
| --- | --- | --- | --- |
| dream-gradient | 纯 CSS 柔和渐变底 | 渐变叠加在 Mica 上（更透） | 自动按 solid 渲染（`data-material=solid`） |
| liquid-glass | 高不透明度玻璃语言（96%） | 真玻璃：原生模糊 + CSS tint/边光 | 高不透明度玻璃语言（96%） |

> 结论：**预设决定"长什么样"，材质决定"后面有没有桌面"，明暗决定"亮还是暗"**。
> 任何组合都不会出现不可读界面。

---

## 2. 数据流

```
设置页 / 标题栏 / 托盘
        │  update(patch) │ syncExternal(patch)
        ▼                ▼
   useSettingsStore ──► update_settings (Rust) ──► SQLite application_settings
        │
        ├─ applyPresetToDom()  → html[data-preset] + apply_window_radius(r)
        ├─ applyThemeToDom()   → html[data-theme]（system 解析为 light/dark）
        └─ applyMaterial()     → apply_window_material(实际请求)
                                 → html[data-material] = resolveMaterial(...)
                                 → html[data-native-glass]
                                 → materialInfo（供设置页展示降级原因）
```

所有入口最终都收敛到同一个 Store，**没有第二条写 DOM 的路径**。

---

## 3. 关键设计决策

### 3.1 界面 class 用「实际材质」而不是「请求材质」

v0.5 的缺陷：`App.tsx` 用 `settings.material` 上 `material-glass` class，
但原生材质可能已回退 `solid`，于是界面仍是半透明，文字直接压在壁纸上。

v0.6 修复：

```tsx
const material = materialInfo?.resolved ?? settings?.material ?? "solid";
<div className={`dock-window mode-${mode} material-${material}`}>
```

`materialInfo.resolved` 由 `resolveMaterial(requested, flags)` 计算，flags 含
高对比度、减少透明、原生是否真正应用。**界面永远跟随实际状态**。

### 3.2 每次重算都重新探测原生材质

旧实现 `reapplyFromSystem()` 调用 `applyMaterial(false)`（不探测），
当用户关闭「减少透明效果」后，CSS 恢复半透明但原生效果仍处于被清除状态 →
窗口变成「半透明但没有模糊」的脏状态。

现在 `applyMaterial()` **无条件**调用 `applyWindowMaterial(requested)`：

- `glass` → Rust 端重新 `apply_mica` / `apply_acrylic`（幂等）；
- `solid` → Rust 端 `clear_mica` + `clear_acrylic`。

代价：一次 IPC + 主线程 Win32 调用，仅在设置切换或系统偏好变化时发生（低频）。

### 3.3 旧库与脏值的安全默认

| 场景 | 行为 |
| --- | --- |
| 旧库没有 `visual_preset` 键 | Rust `#[serde(default = "default_visual_preset")]` → `dream-gradient`；前端 `resolveVisualPreset(undefined)` 同样回退 |
| 数据库里是未知字符串 | Rust 端 `update_settings` 白名单拒绝写入；即便被外部改库，前端 `resolveVisualPreset` 仍回退 |
| 整行设置损坏 | `Settings::load` 的 `unwrap_or_default()` 保持既有行为（全部默认值） |
| 窗口圆角下发失败 | 仅记录在 `materialInfo.shapeApplied`，CSS 圆角仍在，不阻塞界面 |

### 3.4 切换不重置业务状态

主题相关操作只做三件事：写设置、改 `document.documentElement.dataset`、调用窗口命令。
不触碰 `useTasksStore` / `useAgentsStore` / `useClipboardStore` / `useUiStore`，
因此任务列表、Agent 会话、剪贴板选中项、当前 tab 与滚动位置都保持不变。

已由 `useSettingsStore.test.ts` 覆盖（切换预设后仅调用 `updateSettings` 与 `applyWindowRadius`）。

---

## 4. DOM 与样式分层

```
src/styles.css           v0.5 组件样式（Agent / 历史 / 剪贴板 / 弹窗…）
src/styles-themes.css    v0.6 Token 层 + 结构层（预设 × 明暗 × 材质）
```

- `main.tsx` 先引入 `styles.css` 再引入 `styles-themes.css`，后者在同优先级下覆盖。
- 老组件没有改一行 CSS：它们引用 `--surface-*` / `--border-*` / `--accent*`，
  这些变量在预设块里被重新赋值，于是自动获得新皮肤。
- 需要改结构的地方（去掉 1px 外框、卡片材质、导航轨）才写选择器覆盖，且集中在一个文件里。

Token 覆盖顺序（后者胜出）：

```
:root（= dream 浅色，首帧不闪）
:root[data-preset="dream-gradient"][data-theme="dark"]
:root[data-preset="liquid-glass"]
:root[data-preset="liquid-glass"][data-theme="dark"]
[data-native-glass="false"], [data-material="solid"]  → 可读性兜底
@media (prefers-contrast: more)                       → 强制对比度
```

---

## 5. 文件清单

| 文件 | 变更 |
| --- | --- |
| `src-tauri/src/db/mod.rs` | `Settings.visual_preset` + `default_visual_preset()` |
| `src-tauri/src/commands/settings.rs` | 白名单 + `enum_of(["dream-gradient","liquid-glass"])` + 测试 |
| `src-tauri/src/window_shape.rs` | 新增：圆角区域裁剪与 DWM 角偏好 |
| `src-tauri/src/commands/system.rs` | `apply_window_radius` 命令 |
| `src-tauri/src/lib.rs` | 启动时按预设落圆角、resize/DPI 变化重算、注册命令 |
| `src/lib/theme.ts` | `VisualPreset` 类型、`resolveVisualPreset`、`presetRadius`、`hasNativeGlass` |
| `src/lib/bridge.ts` | `Settings.visual_preset`、`applyWindowRadius` |
| `src/store/useSettingsStore.ts` | 预设应用、材质重探测、`data-native-glass`、`shapeApplied` |
| `src/App.tsx` | 用 `materialInfo.resolved` 上 class |
| `src/components/FullView.tsx` | 横向标签 → 左侧导航轨 |
| `src/components/TitleBar.tsx` | 品牌球 + 预设菜单 + 图标权重 |
| `src/components/tasks/*` | 统计卡色调、空状态插画、按钮材质 |
| `src/components/settings/SettingsPanel.tsx` | 预设选择卡（含迷你预览） |
| `src/styles-themes.css` | 新增：Token 与结构层 |

---

## 6. 立体层级 Token（2026-11-01 追加）

v0.7 在原有三维（预设 / 明暗 / 材质）之上只新增**高度维度**，不改变状态机：

- 每个「预设 × 明暗」块同时声明 `--header-wash`、`--inset-face`、`--inset-shadow`、
  `--inset-shadow-hover`、`--inset-shadow-focus`、`--inset-shadow-sm`、`--shadow-overlay`；
  `styles-themes.test.ts` 守卫四个上下文同名，避免某套主题缺一层高度。
- 既有 `--card-shadow` / `--control-shadow*` / `--rail-active-shadow` / `--pill-active-shadow`
  / `--menu-shadow` / `--dialog-shadow` 的**取值**被重写，组件选择器不变。
- 结构层集中在 `styles-themes.css` 第 15 节：窗口受光、导航上浮/按下、卡片悬停抬升、
  输入内凹、按钮/分段/预设卡凸起、状态标签、胶囊厚度、吸附反馈条。所有规则只消费 Token。
- 明确不做：窗口外投影、全窗口 `backdrop-filter`、常驻光影动画、按帧更新装饰层。
  这与 03 的透明窗口区域约束、04 的性能约束保持一致。

验收边界：浏览器 harness 与真实 Tauri 窗口截图只能证明各自层级；
受控背景像素分析与胶囊状态机回归须在无并发实例、无其他置顶窗口的会话中单独执行。

---

## 7. 四种预设与清透前景（2026-11-04 追加）

> §1 的矩阵写于只有两种预设时；本节记录当前事实，旧矩阵中「两套预设」的表述以本节为准，
> 两种旧预设的名称、令牌与行为未改变。

### 7.1 预设与独立视觉

| 预设 | 窗口半径 | 视觉职责 |
| --- | --- | --- |
| `dream-gradient` | 18 | 低饱和蓝紫粉渐变 + 四角氛围光，不追求透出桌面 |
| `liquid-glass` | 20 | 高不透明度玻璃语言，原生材质可用时叠加 Mica/Acrylic |
| `frosted` | 20 | 柔光玻璃：磨砂可读面 + 中等透出 |
| `clear` | 20 | 清透玻璃：窗口外壳高度透明，内容容器单独成玻璃层 |

四种预设各自保留独立令牌块，**不得互相合并**；`frosted` 与 `liquid-glass` 是两套语言，
`clear` 也不得套用前两者的高不透明度兜底。

### 7.2 清透前景是正交维度（只改前景，不改窗口透明度）

- 持久化键 `clear_foreground`，取值 `auto` / `dark` / `light`，DOM 载体 `html[data-clear-fg]`。
- 仅 `clear` 预设生效；`auto` 跟随 `data-theme`，`dark` / `light` 为手动覆盖。
- 选择器只允许覆盖**前景色板与配对表面**：`--text-primary/secondary/tertiary`、菜单面、
  以及 `--card-face` / `--control-face` / `--inset-face` / `--pill-*` / `--rail-*` / `--surface-hover`。
- 任何前景覆盖块**禁止**改写 `--window-fill`、`--window-edge`、`--decor-opacity`、`--glass-tint`：
  窗口外壳透明度属于预设，不属于前景。`styles-themes.test.ts` 守卫该约束。

### 7.3 前景与表面必须成对（可读性不靠蒙层）

裸改文字色会产生「深色字压在透明白卡上 / 浅色字压在透明深卡上」，背景一变就不可读。
因此清透前景的强制色板必须成对声明：

- `data-clear-fg="dark"` → 深色文字 + 浅色玻璃表面（白系 `rgba(255,255,255,…)`）；
- `data-clear-fg="light"` → 浅色文字 + 深色玻璃表面（深蓝黑系）。

配对表面按**最坏底色**取值（深色文字按纯黑桌面、浅色文字按纯白桌面合成），
`styles-themes.test.ts` 以 WCAG 对比度 ≥ 4.5:1 校验，避免在极端壁纸上再次不可读。
表面仍是半透明（不是加不透明蒙层）：窗口外壳维持预设的高透明度，只有内容容器成层。

### 7.4 窗口根节点重新绑定前景色

`styles-notifications.css` 的 `body { color: #f0f5ff }` 是无 `@layer` 的全局规则，
优先级高于任何 `@layer`，会压掉主题层的 `body { color: var(--text-primary) }`。
因此 `.dock-window { color: var(--text-primary) }` 在窗口根节点重新绑定，
让清透前景与明暗主题真正生效；**不要**通过修改通知样式表解决（通知窗口另有配色契约）。

### 7.5 材质 IPC 必须串行

`materialEpoch` 只能让前端忽略过期响应，不能撤销 Rust 端已经执行的窗口材质修改。
`useSettingsStore` 以单条 Promise 链串行化 `apply_window_material`：旧请求未返回前不发新请求，
排队期间又有更新则跳过中间态，保证落地顺序与最后一次设置一致；不引入全局调度框架。

验收边界：浏览器 harness 与真实 Tauri 窗口截图只能证明各自层级；
受控背景像素分析与胶囊状态机回归须在无并发实例、无其他置顶窗口的会话中单独执行。
