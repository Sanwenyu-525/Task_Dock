# 06 · 实施报告（v0.6 双视觉主题与侧边栏 UI 重构）

> 范围：视觉预设系统、左侧导航重构、窗口圆角与材质一致性修复、性能与降级处理、测试与文档。
> 不含任何与本次任务无关的新功能；既有业务逻辑（任务/Agent/行动/历史/剪贴板/导航/备份）全部保留。

---

## 1. 改动文件清单

### 1.1 后端（Rust）

| 文件 | 改动 | 说明 |
| --- | --- | --- |
| `src-tauri/src/db/mod.rs` | 新增 `Settings.visual_preset` + `default_visual_preset()` | 旧库缺键走默认值 `dream-gradient` |
| `src-tauri/src/commands/settings.rs` | 白名单 + 枚举校验 + 单测 | 只接受 `dream-gradient` / `liquid-glass` |
| `src-tauri/src/window_shape.rs` | **新增文件** | Win32 圆角区域裁剪 + DWM 角偏好 + 半径管理 + 区域缓存 + 延迟重算 + 诊断开关 + 单测 |
| `src-tauri/src/commands/system.rs` | 新增 `apply_window_radius` 命令 | 前端按预设下发圆角半径 |
| `src-tauri/src/lib.rs` | 启动落圆角、resize/DPI 重算、注册命令 | 见 03 文档 |

### 1.2 前端

| 文件 | 改动 |
| --- | --- |
| `src/lib/theme.ts` | 新增 `VisualPreset`、`resolveVisualPreset`、`presetRadius`、`hasNativeGlass`、`PRESET_LABELS` |
| `src/lib/bridge.ts` | `Settings.visual_preset`；新增 `applyWindowRadius` |
| `src/store/useSettingsStore.ts` | 预设应用、`data-native-glass`、材质重探测、`shapeApplied` |
| `src/App.tsx` | 窗口 class 改用 `materialInfo.resolved`（实际材质） |
| `src/components/FullView.tsx` | 横向标签 → **左侧垂直导航轨**（图标+文字+徽标+底部快捷入口） |
| `src/components/TitleBar.tsx` | 品牌球、Agent 状态点、**视觉预设菜单**、图标权重收敛 |
| `src/components/tasks/TasksPanel.tsx` | 统计卡语义色调、**空状态插画**（纯 CSS/SVG） |
| `src/components/tasks/QuickAdd.tsx` | 主按钮材质类名（渐变 + 顶高光） |
| `src/components/settings/SettingsPanel.tsx` | **视觉主题选择卡**（含迷你界面预览） |
| `src/styles-themes.css` | **新增文件**：Token 层（预设 × 明暗 × 材质）+ 结构层（导航轨/标题栏/空状态/预设卡/响应式） |
| `src/main.tsx` | 引入新样式文件（在 `styles.css` 之后，保证覆盖顺序） |

### 1.3 测试与脚本

| 文件 | 说明 |
| --- | --- |
| `src/lib/theme.test.ts` | 预设解析、圆角映射、原生玻璃判定（+6 例） |
| `src/store/useSettingsStore.test.ts` | **新增**：材质管道与预设切换回归（4 例） |
| `src/components/FullView.test.tsx` | **新增**：左侧导航结构与徽标口径（5 例） |
| `scripts/visual-themes.mjs` | **新增**：双预设视觉走查（16 个场景 + 布局审计） |
| `scripts/theme-perf.mjs` | **新增**：主题性能测量 |
| `scripts/native-verify.ps1` | **新增**：原生窗口取证（桌面合成像素 + PrintWindow + 应用日志） |
| `scripts/capture-native.ps1` | **新增**：仅抓屏版本 |
| `scripts/native-probe.ps1` | **新增**：窗口可见性/尺寸探测 |
| `scripts/dump-windows.ps1` | **新增**：顶层窗口枚举（诊断用） |
| `scripts/check-corners.py` | **新增**：圆角几何校验（角点像素 vs 桌面像素） |
| `scripts/seed-settings.py` | **新增**：验收用设置写入（含 `window_rect=x,y,w,h` 特殊形式） |
| `scripts/capture-native-set.ps1` | **新增**：四组主题的原生批量取证 |
| `scripts/diagnose-corner.ps1` | **新增**：圆角机制诊断矩阵（区域/DWM 开关 × solid/glass） |
| `scripts/full-screen.ps1` | **新增**：整屏抓取（诊断用） |
| `scripts/make-preview.mjs` | 增加 `preset` / `tasks=empty` 参数、剪贴板夹具 |

---

## 2. 关键实现细节

### 2.1 主题管道（唯一入口）

```
用户操作（设置页 / 标题栏 / 托盘）
  → useSettingsStore.update(patch) / syncExternal(patch)
  → Rust update_settings（逐键校验后落库）
  → applyPresetToDom()  → html[data-preset] + apply_window_radius(18|20)
  → applyThemeToDom()   → html[data-theme]
  → applyMaterial()     → apply_window_material(实际请求) → html[data-material] / [data-native-glass]
```

所有路径共用这一条管道，没有第二条写 DOM 的路径，也没有第二套 CSS。

### 2.2 材质降级的三个条件

`resolveMaterial(requested, flags)`：

1. 设置为 `solid` → solid；
2. 系统高对比度 → solid；
3. 系统减少透明 → solid；
4. 原生材质 `applied === false` → solid。

降级时 Rust 端同时清除原生效果，前端 `data-material=solid`，界面改用不透明表面；
**液态玻璃预设的不透明版本仍然保留玻璃渐变与内高光**，只是不透明（见 `styles-themes.css` 第 5 节）。

### 2.3 侧边栏

- 宽度 62px；`max-width: 384px` 时收敛为 46px 且隐藏文字（仅图标）。
- 选中态：梦幻渐变 = 淡色药丸 + 2.5×20 左侧指示条；液态玻璃 = 玻璃胶囊 + 内高光 + 柔光。
- 徽标：13px 圆形，1.5px 与底同色描边；沿用任务统计 / 行动中心口径，**行动中心关闭时归零**。
- 底部「添加」：切到任务页并聚焦快速添加（与 Ctrl+K 一致）。
- `aria-current="page"` 保留，键盘可达性不变。

### 2.4 窗口圆角

- Rust：`SetWindowRgn(CreateRoundRectRgn)` + `DWMWA_WINDOW_CORNER_PREFERENCE=ROUND`。
- 半径：梦幻 18 / 液态 20（逻辑像素），按 `scale_factor` 换算物理像素。
- resize 与 DPI 变化时重算；`APPLYING` 原子标志防重入；region 所有权按 `SetWindowRgn` 返回值处理。

### 2.5 性能

- 无常驻动画、无 `requestAnimationFrame` 循环、**0 个 `backdrop-filter`**。
- 背景装饰是单个 `::before` 上的 4 个径向渐变（一次绘制）。
- 实测空闲 3s 主线程 6.4–8.9 ms、布局 0 次；切换主题 20 次 29–63 ms。

---

## 3. 已修复的缺陷

| 缺陷（v0.5） | 根因 | 修复 |
| --- | --- | --- |
| 四角黑色直角 | DWM 系统背景按整窗矩形绘制，CSS `border-radius` 裁不掉 | Win32 窗口区域裁剪（见 03 文档），并用 `GetWindowRgn` 客观验证 |
| 窗口尺寸逐次放大 25% | 前端保存物理像素，后端按逻辑像素还原 | `restore_window` 改用 `PhysicalSize`/`PhysicalPosition` |
| 启动瞬间窗口被滑出屏幕 | 设置未加载时 `snap_enabled` 默认 true，贴边吸附先生效一次并把位置持久化 | 设置到达前不启用贴边吸附（`settings?.snap_enabled === true`） |
| 界面 class 用请求材质而非实际材质 | `App.tsx` 用 `settings.material` | 改用 `materialInfo.resolved` |
| 系统关闭「减少透明」后原生材质不恢复 | `applyMaterial(false)` 不探测，且降级时清除了原生效果 | 每次重算都真探测并按需清除/应用 |
| 旧库缺 `visual_preset` 可能写入空预设 | 前端直接透传设置值 | `resolveVisualPreset` 统一回退，前后端默认值一致 |
| 横向标签挤压窄窗内容 | 顶部 5 个标签 + 徽标 | 改左侧导航，窄窗收敛为图标轨 |

---

## 4. 已知限制

| # | 限制 | 说明 / 规避 |
| --- | --- | --- |
| 1 | 无外部投影 | 窗口区域裁剪后 DWM 不再绘制外部阴影，改用内边光 + 底部内阴影表达悬浮 |
| 2 | Win10 圆角边缘有锯齿 | `SetWindowRgn` 是硬边；Win11 由 `DWMWCP_ROUND` 补足抗锯齿 |
| 3 | Mica 跟随系统明暗 | 应用浅色 + 系统深色时，玻璃底色会偏；可接受，未做强制同步 |
| 4 | 液态玻璃不是 macOS Liquid Glass 的完整复刻 | 折射/实时模糊未实现（性能与稳定性取舍），已在 01 文档声明边界 |
| 5 | 预览 harness 与真实窗口的差异 | harness 用 IPC mock + 静态壁纸；真实桌面颜色不可控，玻璃观感会有差异 |
| 6 | 深色玻璃在彩色壁纸上偏色 | 卡片已叠中性暗底（≥0.6）保证文字对比度 |
| 7 | `styles.css` 中 `.tabs` / `.tab` 规则已成死代码 | v0.6 改为侧边栏后无人引用；为避免误删风险本轮保留，后续可清理 |
| 8 | 原生窗口 100%/150% DPI、Win10、Dev 模式未在本机覆盖 | 见 05/07 文档的未验证清单 |
| 9 | 启动有约 2 秒延迟 | v0.5 既有行为：`setup` 在主线程调用 `apply_window_material`，其内部 `run_on_main_thread` 会等 2 秒超时。建议改为「不阻塞地排队应用材质」，或直接依赖前端 `load()` 的那次调用（本轮未改动，避免牵动材质时序） |

---

## 5. 回归结论（逐项）

### 已实现

- 双视觉预设（梦幻渐变 / 液态玻璃）× 明暗（浅/深/系统）× 材质（solid/glass）
- 统一左侧垂直导航（图标+文字、选中态、徽标、底部快捷入口、窄窗图标模式）
- 标题栏品牌球、状态点、模式/明暗/预设三组菜单、剪贴板、最小化、隐藏到托盘
- 统计卡、快速添加、筛选/排序、空状态插画、任务列表全部按新皮肤重绘
- 设置页预设选择卡 + 即时切换 + 持久化 + 旧库安全默认
- 原生材质状态与界面状态一致（实际值驱动）
- Win32 圆角裁剪（四角黑色直角已消除）
- 响应式：400px 完整、340px/320px 图标轨，极简/紧凑模式保持原用途
- 降级：原生不可用、高对比度、减少透明、减少动态
- 性能：无 backdrop-filter、无常驻动画、空闲近零开销

### 已测试通过

- `npx tsc --noEmit` ✅
- `npx vitest run` ✅（36 文件 / 260 项全绿）
- `cd src-tauri && cargo test --release` ✅（lib 449 passed / 0 failed / 3 ignored；集成 1 passed）
- `npm run build` ✅
- `npm run tauri build -- --no-bundle` ✅（Release 可执行文件产出）
- `node scripts/visual-themes.mjs` ✅（18 场景，0 溢出、0 运行错误）
- `node scripts/theme-perf.mjs` ✅
- `scripts/native-verify.ps1` + `scripts/check-corners.py` ✅（4 组原生截图：`region_probe=00001` 四角已被 Win32 区域裁掉；角点像素与桌面**完全一致**，diff = 0.0；`ontop_check` 差值 0）

### 尚未验证（本环境无法执行）

- Windows 10 真机、Dev 模式（`npm run tauri dev`）
- 100% / 150% DPI（本机为 125%）
- 交互行为：窗口拖动、贴边吸附、托盘菜单、热键在真实桌面上的手工回归
- 长时间常驻的内存/GPU 占用曲线
- 真实彩色壁纸下的玻璃观感主观评估

详见 [07-visual-acceptance.md](07-visual-acceptance.md) 的逐项清单与复现方法。
