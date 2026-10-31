# 05 · 测试矩阵与验收标准

> 状态取值：
> **✅ 已验证**（本环境有证据） · **⚠️ 部分验证** · **⬜ 未验证**（当前环境无法执行，已在 07 文档列出原因与复现方法）

> **2026-10-31 更正（v0.7 圆角整改）**：本文原「10-30 全部通过」的结论中，
> **原生窗口四角一项已被真机截图证伪**，现改为「修复前 FAIL / 修复后未验证」。
> 当前测试计数为前端 **40 文件 / 290 用例**、Rust **472 passed / 3 failed / 3 ignored**
> （失败为锁屏会话下的前台置前用例，非本轮改动模块）。
> 圆角验收方法、矩阵与证据见 [12-v06-window-corners.md](12-v06-window-corners.md)；
> 视觉验收结论见 [07-visual-acceptance.md](07-visual-acceptance.md)。

---

## 1. 自动化测试

| 套件 | 命令 | 覆盖点 | 状态 |
| --- | --- | --- | --- |
| 前端类型检查 | `npx tsc --noEmit` | 类型与契约（`Settings.visual_preset` 等） | ✅ 通过 |
| 前端单测 | `npx vitest run` | 主题解析、材质管道、导航、UI 基元、剪贴板页面与抽屉、既有业务组件 | ✅ **40 文件 / 290 用例通过**（2026-10-31 复测；v0.6 时为 37/264，见 1.1） |
| Rust 测试 | `cd src-tauri && cargo +stable-x86_64-pc-windows-msvc test` | 设置校验、圆角缓存/重入、区域有效性与既有后端逻辑 | ⚠️ **472 passed / 3 failed / 3 ignored**；3 例失败为锁屏会话下 `navigation::router` 前台置前用例（`ENVIRONMENT-BLOCKED`），不属于本轮改动模块，详见 11 文档 1.2 |
| 前端构建 | `npm run build` | 生产构建 | ✅ 通过 |
| Tauri Release 构建 | `npm run tauri build -- --no-bundle` | 正式构建链路 | ✅ 修复后重建通过（2026-10-31 01:35，14m25s，15,793,664 B；见 11 文档 1.3）；原生取证仍受锁屏限制 |
| 视觉走查（基线） | `node scripts/visual-themes.mjs` | 两套预设 × 明暗 × 材质 × 宽度，附布局溢出审计 | ✅ 18 场景通过 |
| 视觉走查（v0.6 交互） | `node scripts/visual-v06.mjs` | 排序菜单 / 主题下拉 / 日期浮层 / 剪贴板页 / 关联抽屉 / 深色菜单 / 320px 窄布局 | ✅ 26 场景通过 |
| 布局回归 | `node scripts/layout-regression.mjs` | 宽高 × DPR × 预设 × 明暗 × 材质 × 模式，37 组合 | ✅ 全部达标 |
| 性能走查 | `node scripts/theme-perf.mjs` | 空闲占用、布局次数、backdrop-filter 数量、切换耗时 | ✅ 通过 |
| 原生窗口取证 | `scripts/corner-lab.ps1` + `scripts/check-corners.py` | 真实 Win32 窗口截图 + 独立背景基线四角判定 | ⬜ **修复后未验证**（会话锁定）；修复前同方法实测 glass/solid 均 FAIL，见 12 文档 |

新增单测明细：

| 文件 | 用例 |
| --- | --- |
| `src/lib/theme.test.ts` | 预设解析（旧库缺失/未知值回退）、预设↔圆角映射、`hasNativeGlass` 判定 |
| `src/store/useSettingsStore.test.ts` | 旧库回退默认预设、原生材质失败 → `data-material=solid`、**系统减少透明关闭后重新探测并恢复原生材质**（v0.5 缺陷回归）、切预设只改 DOM 与圆角 |
| `src/components/FullView.test.tsx` | **六个**导航入口 + 底部快捷入口、切换面板与 `aria-current`、徽标口径、行动中心关闭时徽标归零 |
| `src-tauri/src/commands/settings.rs` | `visual_preset` 白名单枚举校验 |
| `src-tauri/src/window_shape.rs` | 半径夹取与非法值回退 |

### 1.1 v0.6 新增测试套件

| 文件 | 用例数 | 覆盖点 |
| --- | --- | --- |
| `src/components/ui/Select.test.tsx` | 9 | 点击展开 / 外部点击关闭 / ↑↓ 导航跳过禁用项 / Enter 选中 / Home·End 跳首尾 / Esc 只关本层且焦点回到触发器 / Tab 正常离开 / 长列表滚动到可见区 |
| `src/components/ui/DropdownMenu.test.tsx` | 11 | 触发器 `aria-expanded` / 方向键导航 / Enter 触发并收起 / Home·End / 字母键快速定位 / 禁用项不可选 / 单选组 `menuitemradio` + `aria-checked` / Esc 只关本层 |
| `src/components/ui/Popover.edge.test.tsx` | 3 | 下方空间充足时向下展开 / 底部空间不足时自动向上翻转 / 弹层挂在 `document.body` 上不受内容区裁剪 |
| `src/components/ui/overlayEscape.test.tsx` | 7 | 无弹层时 Escape 才交给窗口级动作（隐藏到托盘）/ 抽屉打开时只关抽屉且主窗口不受影响 / 菜单与抽屉并存时先关菜单 / **确认框优先级最高** / 子弹层优先于抽屉 / 连续按 Escape 逐层关闭、最后一层关完主窗口才收到 / 菜单关闭后焦点回到触发按钮 |
| `src/components/ui/DateTimePicker.test.tsx` | 10 | 触发器展示本地时间 / **只是打开浮层不改值（不截断秒）** / 独立改截止与提醒 / 清除时间 / 非法日期拒绝提交 / 未触碰字段保持原值 / 键盘输入可用 |
| `src/components/ui/TooltipLayer.test.tsx` | 4 | 悬停显示 / 聚焦显示 / **关闭提示条不抢焦点** / Escape 收起提示条但**不吞掉按键** |
| `src/hooks/useGlobalShortcuts.test.tsx` | 8 | Ctrl+1…6 映射到六个标签 / Ctrl+7 无效 / Ctrl+K / 输入框内不劫持 / 完整模式 Ctrl+Shift+C 切页 / 紧凑模式开关抽屉 / 卸载后不再响应 |
| `src/store/useUiStore.test.ts` | 5 | 抽屉与上下文抽屉互斥 / 关联模式携带任务并在关闭时清空 / **切标签页不打开抽屉** / 关联版本号自增 |
| `src/components/clipboard/ClipboardPanel.test.tsx` | 9 | 剪贴板主页面渲染 / 类型筛选重新拉取 / 搜索防抖后按关键词拉取 / 不在剪贴板页时不加载 |
| `src/components/clipboard/ClipboardDrawer.test.tsx` | 既有 | 抽屉形态的关联流程（回归） |
| `src/store/useClipboardStore.live.test.ts` | 4 | 高频采集事件只在防抖窗口结束后刷新一次 / **页面与抽屉同时存在时只建立一个后端监听** / 引用计数归零后才真正取消监听 / 连续采集被合并成一次刷新 |
| `src/styles-themes.test.ts` | 10 | 原生 `<select>` 守卫 / 弹层表面不透明 / 弹层无整层实时 `backdrop-filter` / `--z-*` 刻度单调 / 业务样式无裸 `z-index` / 焦点环未被取消 / reduced-motion 与高对比度媒体查询存在 |

**v0.6 后前端总计：40 个测试文件 / 290 个用例全部通过**（2026-10-31 复测）
（v0.6 当时为 37 文件 / 264 用例；新增的 3 个文件来自 v0.7 整改与并行的剪贴板加固工作）。

---

## 2. 视觉矩阵（浏览器 harness，`docs/screenshots/v06/`）

### 2.1 基线矩阵（`scripts/visual-themes.mjs`，18 场景）

| # | 预设 | 明暗 | 材质 | 宽度 | 场景 | 文件 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 梦幻渐变 | 浅 | glass | 400 | 常规任务 | `dream-light-400.png` |
| 2 | 梦幻渐变 | 深 | glass | 400 | 常规任务 | `dream-dark-400.png` |
| 3 | 液态玻璃 | 浅 | glass | 400 | 常规任务 | `glass-light-400.png` |
| 4 | 液态玻璃 | 深 | glass | 400 | 常规任务 | `glass-dark-400.png` |
| 5 | 梦幻渐变 | 浅 | solid | 400 | 原生不可用回退 | `dream-light-400-solid.png` |
| 6 | 液态玻璃 | 浅 | solid | 400 | 原生不可用回退 | `glass-light-400-solid.png` |
| 7 | 梦幻渐变 | 浅 | glass | 340 | 窄窗（图标轨） | `dream-light-340.png` |
| 8 | 液态玻璃 | 浅 | glass | 320 | 极窄窗 | `glass-light-320.png` |
| 9 | 梦幻渐变 | 浅 | glass | 400 | 空状态 | `dream-empty-400.png` |
| 10 | 液态玻璃 | 浅 | glass | 400 | 空状态 | `glass-empty-400.png` |
| 11 | 梦幻渐变 | 深 | glass | 400 | 空状态 | `dream-empty-dark.png` |
| 12 | 液态玻璃 | 浅 | glass | 400 | 大量任务（60 条） | `glass-many-400.png` |
| 13 | 梦幻渐变 | 浅 | glass | 280 | 极简模式 | `dream-minimal-280.png` |
| 14 | 液态玻璃 | 浅 | glass | 400 | 紧凑模式 | `glass-compact-400.png` |
| 15 | 梦幻渐变 | 浅 | glass | 400 | 设置页（预设卡） | `settings-presets.png` |
| 16 | 液态玻璃 | 浅 | glass | 400 | 液态玻璃任务页 | `glass-light-tasks.png` |
| 17 | 梦幻渐变 | 浅 | glass | 400 | **剪贴板主页面** | `dream-clipboard-page.png` |
| 18 | 液态玻璃 | 浅 | glass | 400 | **剪贴板主页面** | `glass-clipboard-page.png` |

### 2.2 v0.6 交互场景（`scripts/visual-v06.mjs`，26 场景）

需求点名的七个场景 × 两套预设 × 明暗（明暗各一组，深色任务页与窄布局只出一组）：

| 场景 | 文件 |
| --- | --- |
| 任务页 + 排序菜单展开 | `{dream,glass}-{light,dark}-tasks-sort-menu.png` |
| 设置页 + 主题下拉展开 | `{dream,glass}-{light,dark}-settings-theme-select.png` |
| 日期时间选择浮层 | `{dream,glass}-{light,dark}-datetime-overlay.png` |
| 剪贴板主页面 | `{dream,glass}-{light,dark}-clipboard-page.png` |
| 剪贴板关联抽屉 | `{dream,glass}-{light,dark}-clipboard-link-drawer.png` |
| 标题栏菜单（深色） | `{dream,glass}-dark-titlebar-menu.png` |
| 320px 窄布局 | `{dream,glass}-light-320-narrow.png` |

自动化断言（`scripts/visual-themes.mjs` / `scripts/visual-v06.mjs`）：

- `documentElement.scrollWidth - clientWidth === 0`（无横向溢出）
- 关键元素（统计卡/筛选组/快速添加/任务卡/导航轨/预设卡/浮层）**不得越出视口**
- **六个侧边栏入口不得被裁掉**，快速添加按钮不得被遮挡
- 收集运行期 console error / pageerror，必须为空
- 记录 `data-preset` / `data-theme` / `data-material` / `data-native-glass` 与导航轨宽度，核对降级与窄窗行为

---

### 2.3 布局回归矩阵（v0.6 新增，`scripts/layout-regression.mjs`）

37 个组合，覆盖宽度 / 高度 / DPR / 预设 / 明暗 / 材质 / 窗口模式的笛卡尔积抽样。

| 维度 | 取值 |
| --- | --- |
| 宽度 | 320 / 340 / 400 / 500 |
| 高度 | 380 / 460 / 560 / 760 |
| DPR | 1 / 1.25 / 1.5 |
| 预设 | 梦幻渐变 / 液态玻璃 |
| 明暗 | 浅 / 深 |
| 材质 | solid / glass |
| 模式 | full / compact / minimal |

页面内断言（全部通过才退出 0）：

| 断言 | 含义 |
| --- | --- |
| `overflowX === 0` | 无横向溢出 |
| `entryCount === 6` | 侧边栏六个入口都在（新增剪贴板后） |
| `entriesReachable` | 低高度时导航区可滚动，但**六个入口都可达** |
| `addVisible === true` | 底部快速添加按钮可见 |
| `addCovered === false` | 用 `document.elementFromPoint` 命中测试，确认**快速添加按钮没有被侧边栏遮住** |
| `errors` 为空 | 运行期无 console error / pageerror |

产物：`docs/screenshots/v06/layout-audit.json`（37 条）+ `layout-*.png`。
低高度（380px）下导航区会变为可滚动，但六个入口仍全部可达、快速添加按钮不被遮挡。

---

## 3. 功能回归矩阵（必须全部保持可用）

| 能力 | 验证方式 | 状态 |
| --- | --- | --- |
| 任务与自然语言解析 | `QuickAdd.test.tsx`（解析→创建→错误提示） | ✅ |
| 任务筛选 / 搜索 / 排序 | `TasksPanel.test.tsx` | ✅ |
| Agent 监控与多实例会话 | 既有 `AgentPanel` 用例 + harness 夹具 | ✅ |
| 行动中心 | `ActionCenterPanel.test.tsx` + 新增徽标口径用例 | ✅ |
| 历史记录 | `HistoryPanel.test.tsx` | ✅ |
| 智能剪贴板与批量复制粘贴 | `ClipboardDrawer.test.tsx` / `PastePanel.test.tsx` / `ClipboardPanel.test.tsx` | ✅ |
| 剪贴板作为独立侧边栏页面（v0.6） | `ClipboardPanel.test.tsx`（加载 / 筛选 / 搜索）+ `useClipboardStore.live.test.ts`（单监听） | ✅ |
| 剪贴板任务关联抽屉（v0.6 保留） | `ClipboardDrawer.test.tsx` + `useUiStore.test.ts`（互斥与关联上下文） | ✅ |
| 应用跳转与工作现场 | `AppPicker.test.tsx` / `TargetMenu.test.tsx` | ✅ |
| 系统托盘 / 热键 / 三种窗口模式 | 托盘与模式逻辑未改动；模式切换仍走 `apply_mode` | ⚠️ 逻辑未改动，未做真机交互回归 |
| 贴边吸附 | `useEdgeSnap` 未改动 | ⬜ 未验证（本环境无法交互拖拽） |
| 数据备份恢复 | 既有 Rust 用例 | ✅ |
| 主题切换不重置任务/会话/剪贴板 | `useSettingsStore.test.ts` | ✅ |
| 快捷键 Ctrl+1…6 / Ctrl+K / Ctrl+Shift+C | `useGlobalShortcuts.test.tsx`（8 例）；顺序取自 `TAB_ORDER` 单一事实源 | ✅ |
| 所有下拉 / 选择器改用统一基元 | `styles-themes.test.ts` 守卫 + `Select` / `Combobox` / `DropdownMenu` 用例 | ✅ |

---

## 4. 原生窗口矩阵

| 维度 | 目标 | 验证方式 | 状态 |
| --- | --- | --- | --- |
| Win11 | 四角无黑色直角、圆角生效 | `scripts/corner-lab.ps1` + `scripts/check-corners.py`：独立背景基线 + `GetWindowRgn` + 四角像素联合判定 | ⬜ **修复后未验证**（会话锁定）；修复前同方法实测 FAIL（glass 每角 44–45 暗像素、solid 半径 31.75 ≠ 22）→ 12 文档 |
| Win10 | 同上 + 边缘锯齿可接受 | 同上 | ⬜ 本机为 Windows 11，Win10 未覆盖 |
| Release | 正式构建可运行 | `npm run tauri build` + 启动取证 | ⚠️ 修复前构建可运行；修复后构建进行中，见 11 文档 1.3 |
| Dev | 开发模式可运行 | `npm run tauri dev` | ⬜ 未在本轮执行 |
| DPI 125%（本机） | 圆角与 CSS 半径一致 | 修复前实测 solid 半径 31.75px ≠ 期望 22px | ⬜ 修复后未验证 |
| DPI 100% / 150% | 同上 | 需切换显示缩放 | ⬜ 未覆盖 |
| 原生材质（Mica） | 桌面透出 + 高光 | 截图 + `data-native-glass` 标记 | ⚠️ Mica 在区域裁剪下会产生黑角，Win11 自动后端已改为 `blur`；修复后真机取证未验证 |
| 原生材质不可用 | 自动回退 solid，界面不透明 | harness `material=solid` 用例 + `data-material` 断言 | ✅ |
| 系统关闭透明度 | 恢复 solid，恢复后重新应用原生材质 | `useSettingsStore.test.ts` | ✅ |
| 减少动态 | 无位移/缩放动画 | CSS 媒体查询 + 视觉核对 | ✅（CSS 层） |
| 高对比度 | 装饰隐藏、描边加强 | CSS 媒体查询 | ✅（CSS 层） |
| 窗口缩放 / 拖动 / 贴边 | 圆角随尺寸与 DPI 重算 | Rust 事件处理 + 手工 | ⬜ 交互未覆盖 |

---

## 5. 判定标准

### 视觉

1. 两套预设都必须做到：**图标 + 文字**的左侧导航、选中态清晰、导航与内容之间无硬边框。
2. 统计卡、快速添加、筛选、任务卡在 **400px** 宽度下不得截断、不得挤压。
3. 正文对比度 ≥ 4.5:1；半透明表面上不得直接压文字。
4. 400px 下导航显示文字；≤ 384px 自动收敛为仅图标，且不影响右侧内容。
5. **六个**侧边栏入口齐全，且在 380px 低高度下**全部可达**、
   **不遮挡**底部快速添加按钮。

### 交互（v0.6）

6. 一个 Escape 只做一次关闭动作，优先级固定：
   确认框 > 子弹层 > 菜单 > 抽屉 > 主窗口。
7. 菜单 / 下拉的键盘契约完整：↑↓ 导航（跳过禁用项）、Enter/Space 选中、
   Home/End 跳首尾、Tab 正常离开、Esc 只关本层并**把焦点还给触发器**。
8. 弹层表面**不透明**，且**没有整层实时 `backdrop-filter`**。
9. 弹层在窗口边缘自动翻转/收敛，不越出视口；浮层不被内容区裁剪。
10. 日期时间：仅打开浮层不改值、不截断秒、截止与提醒互相独立、可清空、非法值拒绝提交。

### 主题系统

11. 切换预设即时生效（< 1 帧感知），重启后恢复。
12. 旧库/脏值一律回退到 `dream-gradient`，不出现空 `data-preset`。
13. 界面材质跟随**实际生效值**，原生材质失败时不得继续渲染半透明。
14. 关闭「减少透明效果」后原生材质必须真正恢复。

### 窗口

15. 四角无黑色直角：**必须**用「独立背景基线 + 四角像素差 + 半径拟合 + `GetWindowRgn`」联合判定；
    仅 `SetWindowRgn`/`GetWindowRgn` 成功、或缺少有效背景基线，一律记为 **UNVERIFIED**，不得判 PASS。
16. 无 1px 明显外框；保留拖动、缩放、贴边、托盘与位置恢复。
17. 圆角半径在 100/125/150% DPI 下与视觉预期一致。

### 性能

18. 空闲 3 秒主线程占用 < 1%，布局次数 0。
19. 页面 `backdrop-filter` 元素数 0，常驻动画 ≤ 1。
20. 连续切换主题 20 次 < 100 ms。

---

## 6. 回归执行顺序

```bash
npx tsc --noEmit
npx vitest run
(cd src-tauri && cargo test)
npm run build
npm run tauri build -- --no-bundle

node scripts/serve-preview.mjs        # 另开终端（提供 /preview.html 与 dist 资源）
node scripts/visual-themes.mjs        # 基线矩阵（18 场景）
node scripts/visual-v06.mjs           # v0.6 交互场景（26 场景）
node scripts/layout-regression.mjs    # 布局回归矩阵（37 组合）
node scripts/theme-perf.mjs

powershell -ExecutionPolicy Bypass -NoProfile -File scripts/corner-lab.ps1 `
  -DataDir "$env:TEMP\taskdock-corner" -Out "docs\screenshots\v07\lab-glass.png" `
  -Preset dream-gradient -Material glass
python scripts/check-corners.py docs/screenshots/v07/lab-glass-region-dwm.json
python scripts/test-check-corners.py       # 验收脚本自身的合成用例（不得误判 PASS）

powershell -ExecutionPolicy Bypass -NoProfile -File scripts/diagnose-corner.ps1 `
  -OutDir "docs\screenshots\v07\matrix" -Backends "blur,none"
```

> 原生脚本要求**未锁屏的交互式会话**；若会话锁定，`corner-lab.ps1` 会返回 UNVERIFIED，
> `check-corners.py` 在缺少有效背景基线时退出码 2，绝不会标记 PASS。
