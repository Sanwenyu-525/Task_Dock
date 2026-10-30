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
