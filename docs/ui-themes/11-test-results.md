# 11 · v0.6 测试结果

> 测试日期：**2026-10-31** · 环境：Windows 11（build 26100）· 125% DPI ·
> Node 24.18.0 · Rust stable GNU/MSVC 双工具链 · Vitest 3.2.7 · Playwright 1.64.1
>
> **当前 Windows 会话处于锁屏状态**：前端与浏览器 harness 结果有效；
> 原生窗口像素/窗口操作无法取证，相关结论一律标 `UNVERIFIED`（见第 5、6 节）。
>
> 原则：**不以模拟冒充真实**。浏览器 harness 截图与 Windows Release 原生截图
> 分开记录（见第 5 节）；未验证项逐条列出，不做推测性结论。

---

## 1. 自动化测试

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 前端类型检查 | `npx tsc --noEmit` | ✅ 0 错误（含并行的剪贴板加固工作新文件 `src/test/powershellScripts.test.ts`） |
| 前端单元测试 | `npx vitest run` | ✅ **40 文件 / 290 用例通过**（0 failed；新增 `overlayStack` 9 例等） |
| 前端构建 | `npm run build` | ✅ 通过（`main` 300.99 kB / gzip 90.18 kB，主题页 235.16 kB / gzip 74.25 kB，`context-menu` 4.54 kB；单一 CSS 120.80 kB / gzip 20.07 kB） |
| Rust 单元测试 | `cd src-tauri && cargo +stable-x86_64-pc-windows-msvc test` | ⚠️ **472 passed / 3 failed / 3 ignored**（详见 1.2；3 条失败均为锁屏会话下导航置前被拒的环境阻塞，不在 v0.6 改动模块） |
| Release 构建 | `npm run tauri build -- --no-bundle` | ✅ 通过（2026-10-31 01:35，14m25s；产物 `src-tauri/target/release/task-dock.exe`，15,793,664 B） |
| 视觉走查（v0.7 全矩阵） | `node scripts/visual-v07.mjs` | ✅ **32 场景 + 4 交互全部通过**：`failed: []`、0 横向溢出、0 越界、0 运行期错误 |
| 视觉走查（v0.6 交互场景） | `node scripts/visual-v06.mjs` | ✅ 26 场景全部通过（历史轮次） |
| 布局回归矩阵 | `node scripts/layout-regression.mjs` | ✅ 37 组合全部达标（历史轮次） |
| 性能走查 | `node scripts/theme-perf.mjs` | ✅ 空闲 3 s 主线程 5.7–6.3 ms、布局 0 次、样式重算 9 次、`backdrop-filter` **0 个**、`css-filter` 0 个、常驻动画 1 个（Agent 等待态状态点，v0.5 既有）、主题切换 20 次 28–33 ms |

> Rust 集成测试里的 `ignored` 是真机验收工具（真实剪贴板、真实窗口操作），
> 按惯例需显式环境变量才会执行，不计入自动门禁。

### 1.2 Rust 测试明细（MSVC；锁屏会话）

GNU 工具链在 `cargo test` 链接 cdylib 时会报
`error: export ordinal too large`（MinGW 导出序号上限），测试二进制无法生成，
因此本轮用 MSVC 工具链执行：

```
test result: FAILED. 472 passed; 3 failed; 3 ignored
failures:
  navigation::router::tests::launch_disallowed_reports_failure_or_focus_only
  navigation::router::tests::notepad_launch_focuses_existing_window_of_owned_process
  navigation::router::tests::own_process_window_is_enumerated_and_focus_reported_truthfully
```

单测单独复跑（`--nocapture`）得到的现场：

```
ENVIRONMENT-BLOCKED [own_process_window_is_enumerated_and_focus_reported_truthfully]
  Windows 前台锁定拒绝置前（本测试进程不具备前台资格，需在交互会话前台复跑）
REAL-DESKTOP hwnd=13894032 已被产品窗口枚举看到；focus_window 回报=foreground-denied
assertion left: None, right: Some("focus_window")
```

原因分层：

- 当前会话锁屏，`SetForegroundWindow` 被系统拒绝，`focus_window` 返回
  `ForegroundDenied`，这是环境事实，测试自身也打印了 `ENVIRONMENT-BLOCKED`；
- 失败断言在「路由器决策」层：产品在置前失败时返回 `actual_action = None`，
  而测试要求「窗口已存在 → 决策必须是 `focus_window`」。这是**导航模块**的
  语义/测试契约问题，v0.6 未改动 `navigation/`；本轮不把它伪造成通过，
  也不在圆角整改里顺手改导航语义；
- 该组用例需要在未锁屏的交互桌面上复跑才能得到最终结论（见第 6 节）。

### 1.3 Release 构建

重建命令与产物路径：

```bash
npm run tauri build -- --no-bundle
# 产物：src-tauri/target/release/task-dock.exe
```

结果：✅ 通过。`Finished release profile [optimized] target(s) in 14m 25s`，
产物时间 **2026-10-31 01:35**，大小 **15,793,664 B**，
SHA-256 `FAFF0D9BB84E6B5897BE29353D16E235781B75744F589ED6E4C8B67BD8922F56`。
该产物包含本轮 `window_shape`/`effective_backend` 修复，但**原生窗口取证仍受锁屏限制**
（见第 5、6 节），旧产物（10-30 23:50）的截图不能代表本次修复。

### 1.4 v0.6 新增/改写的前端用例

| 文件 | 用例 | 覆盖点 |
| --- | --- | --- |
| `src/components/ui/Select.test.tsx` | 9 | 触发器 combobox 语义 / 点击展开 / ↑↓+Enter 选择 / 禁用项不可选 / **Esc 只关菜单且焦点回触发器** / 外部点击关闭 / Home·End / Tab 正常离开 / **长列表滚动到可见区** |
| `src/components/ui/DropdownMenu.test.tsx` | 11 | `aria-expanded` / 方向键跳过禁用项 / Enter 触发并收起 / Home·End / 字母键定位 / 禁用项 / 单选组 `menuitemradio`+`aria-checked` / Esc 只关本层 |
| `src/components/ui/Popover.edge.test.tsx` | 3 | 下方空间充足时向下展开 / **底部空间不足自动向上翻转** / 浮层挂在 `document.body` 不受内容区裁剪 |
| `src/components/ui/overlayEscape.test.tsx` | 7 | **Escape 优先级与 z 序一致：确认框 > 菜单 > 子弹层 > 模态 > 抽屉 > 主窗口** / 无弹层时才隐藏到托盘 / 抽屉开着时菜单先关 / 连续按 Esc 逐层关闭 / 菜单关闭后焦点回到触发按钮 |
| `src/components/ui/DateTimePicker.test.tsx` | 10 | 本地时间展示 / **仅打开浮层不改值（不截断秒）** / 截止与提醒互相独立 / 清除时间 / 非法日期拒绝 / 未触碰字段保持原值 / 键盘输入 |
| `src/components/ui/TooltipLayer.test.tsx` | 4 | 悬停显示 / 聚焦显示 / **关闭不抢焦点** / **Esc 收起提示条但不吞按键** |
| `src/hooks/useGlobalShortcuts.test.tsx` | 8 | Ctrl+1…6 映射六页 / Ctrl+7 无效 / Ctrl+K / 输入框内不劫持 / 完整模式 Ctrl+Shift+C 切页 / 紧凑模式开关抽屉 / 卸载后不响应 |
| `src/store/useUiStore.test.ts` | 5 | 抽屉与上下文抽屉互斥 / 关联模式携带任务 / **切标签页不打开抽屉** / 关联版本号自增 |
| `src/components/TitleBar.test.tsx` | 3 | **完整模式无剪贴板按钮** / 紧凑模式保留并可开合 / 极简模式保留并可开合 |
| `src/components/clipboard/ClipboardPanel.test.tsx` | 9 | 主页面渲染 / 类型筛选重新拉取 / 搜索防抖后按关键词拉取 / 不在剪贴板页时不加载 |
| `src/store/useClipboardStore.live.test.ts` | 4 | **页面与抽屉并存时只建立一个后端监听** / 引用计数归零才退订 / 高频事件合并为一次刷新 |
| `src/styles-themes.test.ts` | 10 | 原生 `<select>` 守卫 / 弹层表面不透明 / 弹层无整层实时 `backdrop-filter` / `--z-*` 单调 / 无裸 `z-index` / 焦点环未被取消 / reduced-motion / 高对比度 |

---

## 2. 需求验收点逐条核对

| # | 需求点 | 验证方式 | 结果 |
| --- | --- | --- | --- |
| 1 | 所有 `<select>` 换成统一基元（深层设置页 / 任务编辑器 / 关联目标 / 剪贴板内部都不漏） | `styles-themes.test.ts` 扫描 `src/` 无原生 `<select>` | ✅ |
| 2 | 下拉支持鼠标点击开合、外部点击关闭、↑↓/Enter/Space/Home/End、Tab 正常离开、禁用项不可选、选中可辨识、底部空间不足向上翻转、窄窗不溢出、ARIA 正确、焦点恢复 | `Select` 9 例 + `DropdownMenu` 11 例 + `Popover.edge` 3 例 | ✅ |
| 3 | 一个 Escape 只做一次关闭动作（确认框→菜单→子弹层→模态→抽屉→主窗口） | `overlayEscape.test.tsx` 7 例 + `overlayStack.test.ts` 9 例 | ✅ |
| 4 | 剪贴板成为侧边栏第 6 项，完整模式在内容区呈现；抽屉模式保留任务关联 | `FullView.test.tsx` + `ClipboardPanel.test.tsx` + `ClipboardDrawer.test.tsx` + `useUiStore.test.ts` | ✅ |
| 5 | 剪贴板业务只有一份加载/监听/操作逻辑 | `ClipboardWorkspace` 被页面与抽屉共用；`useClipboardStore.live.test.ts` 断言单监听 | ✅ |
| 6 | 日期时间数据语义不被破坏（不截断秒、不改未触碰字段、截止与提醒独立、可清空、校验） | `DateTimePicker.test.tsx` 10 例 | ✅ |
| 7 | 快捷键与焦点恢复、弹层互斥 | `useGlobalShortcuts.test.tsx` 8 例 + `overlayEscape.test.tsx` | ✅ |
| 8 | 六个侧边栏入口在各种高度下可达，且不遮挡底部快速添加 | `layout-regression.mjs` 37 组合（含 380px 低高度） | ✅ |
| 9 | 320/340/400/500 宽度无横向溢出 | `layout-regression.mjs` + `visual-v06.mjs`（`overflowX === 0`） | ✅ |
| 10 | 高频剪贴板更新下性能不退化 | `useClipboardStore.live.test.ts`（300ms 去抖合并）+ 页面按需加载（不在页不订阅） | ✅ |
| 11 | 两套主题的视觉与交互一致 | `visual-v07.mjs` 32 场景 + 4 交互；`visual-v06.mjs` 26 场景 | ✅ |
| 12 | 圆角无黑楔/黑边/直角残留（原生） | `check-corners.py` 独立基线判定 | ❌ **UNVERIFIED（锁屏）**；修复前为 `FAIL`，见 12 号报告 |
| 13 | 最小化/托盘/恢复/缩放/最大化/主题/材质切换（原生） | `native-verify.ps1 -MinimizeCycle/-ResizeTo` | ❌ **UNVERIFIED（锁屏）** |

---

## 3. 布局回归矩阵（37 组合）

抽样维度：宽度 320/340/400/500 × 高度 380/460/560/760 × DPR 1/1.25/1.5 ×
预设（梦幻/液态）× 明暗 × 材质（solid/glass）× 模式（full/compact/minimal）。

每组合在页面内断言：

| 断言 | 含义 | 结果 |
| --- | --- | --- |
| `overflowX === 0` | 无横向溢出 | 37/37 ✅ |
| `entryCount === 6` | 六个侧边栏入口齐全 | 37/37 ✅ |
| `entriesReachable` | 低高度下导航区可滚动，六项**全部可达** | 37/37 ✅ |
| `addVisible === true` | 底部快速添加按钮可见 | 37/37 ✅ |
| `addCovered === false` | `elementFromPoint` 命中测试：**按钮未被侧边栏遮挡** | 37/37 ✅ |
| `errors` 为空 | 运行期无 console error / pageerror | 37/37 ✅ |

产物：`docs/screenshots/v06/layout-audit.json` + `layout-*.png`。

### 3.1 性能走查（`scripts/theme-perf.mjs`）

四个组合（梦幻/液态 × 浅/深）实测：

| 组合 | 空闲主线程 | 空闲布局次数 | 空闲样式重算 | `backdrop-filter` | `css-filter` | 常驻动画 | 主题切换 20 次 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| dream-gradient | 6.3 ms | 0 | 9 | 0 | 0 | 1 | 32.7 ms |
| liquid-glass | 6.0 ms | 0 | 9 | 0 | 0 | 1 | 29.5 ms |
| dream-dark | 5.7 ms | 0 | 9 | 0 | 0 | 1 | 28.5 ms |
| glass-dark | 6.1 ms | 0 | 9 | 0 | 0 | 1 | 28.4 ms |

对照验收标准：空闲 3 s 主线程占用 < 1%、布局 0 次、`backdrop-filter` 0 个、
常驻动画 ≤ 1、切换 20 次 < 100 ms —— **全部满足，余量很大**。

> 唯一常驻动画是 Agent「等待中」状态点的 `pulse`（`src/styles.css` 的 `@keyframes pulse`，
> v0.5 既有，`git diff HEAD -- src/styles.css` 无改动）。实测把它取消后：空闲主线程
> 3.2 ms、样式重算降到 1 次，说明余量开销来自状态点动画与状态轮询，与 v0.6 的
> 组件拆分/剪贴板页面无关——剪贴板主页面单独测得同一水平（5.9 ms / 0 布局 / 8 次重算）。

> 关键点：弹层菜单**没有**整层实时 `backdrop-filter`（全页 0 个），
> 玻璃感来自静态渐变与高光绘制；浮层浮出动画只做 `opacity`/`translateY`。

---

## 4. 视觉走查（浏览器 harness）

### 4.1 v0.6 交互场景（26 场景）

需求点名的七个场景 × 两套预设 × 明暗：

| 场景 | 梦幻渐变 | 液态玻璃 |
| --- | --- | --- |
| 任务页 + 排序菜单展开 | `dream-light/dark-tasks-sort-menu.png` | `glass-light/dark-tasks-sort-menu.png` |
| 设置页 + 主题下拉展开 | `dream-light/dark-settings-theme-select.png` | `glass-light/dark-settings-theme-select.png` |
| 日期时间选择浮层 | `dream-light/dark-datetime-overlay.png` | `glass-light/dark-datetime-overlay.png` |
| 剪贴板主页面 | `dream-light/dark-clipboard-page.png` | `glass-light/dark-clipboard-page.png` |
| 剪贴板关联抽屉 | `dream-light/dark-clipboard-link-drawer.png` | `glass-light/dark-clipboard-link-drawer.png` |
| 深色主题菜单（标题栏） | `dream-dark-titlebar-menu.png` | `glass-dark-titlebar-menu.png` |
| 320px 窄布局 | `dream-light-320-narrow.png` | `glass-light-320-narrow.png` |

自动断言（`scripts/visual-v06.mjs`）：`overflowX === 0`、关键元素不越出视口、
**六个导航项不被裁掉**、快速添加按钮可见、运行期 0 错误。
26 个场景全部通过。

### 4.2 基线矩阵（18 场景）

`scripts/visual-themes.mjs`：两套预设 × 明暗 × 材质 × 宽度（含 320/340 窄窗、
solid 回退、空状态、60 条任务密度、极简/紧凑模式、设置页预设卡、剪贴板主页面），
全部 `scrollWidth - clientWidth === 0`、关键元素无越界、0 运行期错误。

### 4.3 v0.7 全矩阵（32 场景 + 4 交互）

`scripts/visual-v07.mjs` / `docs/screenshots/v07/audit-v07.json`：

| 维度 | 覆盖 | 结果 |
| --- | --- | --- |
| 场景 | 梦幻/液态 × 浅/深 × 320/340/380/400/500 宽 × 任务/剪贴板/设置/空状态/标题栏菜单/排序/日期/关联抽屉 | 32/32 |
| 溢出 | `overflowX === 0 && overflowY === 0` | 32/32 |
| 越界 | `offscreen = []`、`blank = false` | 32/32 |
| 运行期错误 | `errors = []` | 32/32 |
| 侧栏 | 6 项、全部有可访问名称；>384px 时文字标签可见 | 32/32 |
| 剪贴板整页 | 320/340 宽 `clip.integrated = true` | 全部 |
| 交互 | 日期弹层 / 编辑器 / 抽屉的 Escape 链路；添加按钮 hover/focus | 4/4 |
| 汇总 | `failed: []` | ✅ |

Escape 实测（两套主题一致）：

```
dtOpen:true, dtClosed:true, editorKept:true, editorClosed:true,
drawerOpen:true, drawerZ:"80", drawerClosed:true, editorKeptAfterDrawer:true
```

---

## 5. 原生窗口截图（**与 harness 分开标记**）

| 类别 | 目录 / 命名 | 性质 |
| --- | --- | --- |
| 浏览器 harness | `docs/screenshots/v06/*.png`（**无** `native-` 前缀） | 真实 `dist` 产物 + IPC mock + 模拟壁纸，2× 缩放。**只验证 CSS 布局与配色** |
| **Windows Release 原生** | `docs/screenshots/v06/native-*.png`（**修复前旧图，圆角结论已作废**） | 真实 Release 程序的 Win32 窗口，**桌面合成像素**。可验证圆角、材质、层级；但旧图缺独立基线，不能作为本轮通过证据 |

> **撤回**：上一版的「四角像素差 0.0 ✅」表格无效，已删除。旧脚本用同一帧的
> 窗外像素与窗内角块自比，且没有独立背景基线，真机截图（黑月牙、灰边、白晕）
> 已将其证伪。专项报告见 [12-v06-window-corners.md](12-v06-window-corners.md)。

本轮 v0.7 原生取证（`scripts/corner-lab.ps1`，修复前构建）：

| 原生证据 | 预设 / 材质 | 分析器结论 | 关键读数 |
| --- | --- | --- | --- |
| `lab-glass-region-dwm.json` | 液态玻璃 / glass（Mica） | `FAIL`（exit 1） | 四角 44–45 个深色像素、49 个非背景像素；底/右 1px 描边 |
| `lab-solid-region-dwm.json` | 梦幻 / solid | `FAIL`（exit 1） | 四角 40–42 个非背景像素；右下半径 31.75 vs 22 |
| `lab-resize-solid-region-dwm.json` | 梦幻 / solid（缩放链路） | `FAIL`（exit 1） | 与上同 |
| `lab-v071-solid-region-dwm.json` | 锁屏会话采集 | `FAIL` + `UNVERIFIED` | 基线 `0,0,0` 无效，分析器拒绝 PASS |

`region_probe = 00001 bounds=0,0,500,700` 只说明区域已设置，**不能证明最终像素**；
DWM 读数（`system_backdrop=2`、`corner_preference=2`、`border_color` 读取失败）
与像素结论共同支撑第 12 号报告的根因。

修复后的原生像素验收当前为 **`UNVERIFIED`**（锁屏，无法建立有效基线）。

harness 图用于验证 **CSS 布局、配色、弹层层级、交互状态**；
原生图用于验证**圆角裁剪、原生材质透出、窗口层级**。两者互不替代。

---

## 6. 明确未验证项

| 项 | 原因 | 复现方法 |
| --- | --- | --- |
| **修复后原生圆角像素（Solid / Glass）** | 会话锁屏（LogonUI 运行中），屏幕捕获全黑，无有效背景基线 | 解锁后跑 `native-verify.ps1` + `check-corners.py`，见 12 号报告第 9 节 |
| **原生最小化/托盘/恢复/缩放/最大化/主题/材质切换** | 需要未锁屏的真实桌面交互 | `native-verify.ps1 -MinimizeCycle`、`-ResizeTo` 后重采 |
| **导航置前 3 条 Rust 用例** | 锁屏使 `SetForegroundWindow` 被拒；产品在置前失败时 `actual_action=None`，与测试契约不符 | 在交互桌面前台复跑 `navigation::router::tests::*` |
| Windows 10 真机 | 本机仅 Windows 11 | 在 Win10 上执行 `scripts/native-verify.ps1` 取证 |
| 100% / 150% DPI | 本机显示缩放为 125% | 改显示缩放后重跑取证，核对 `--radius` 与 CSS 半径一致 |
| Dev 模式（`npm run tauri dev`） | 本轮只验证 Release | 执行后人工核对 |
| 拖动 / 贴边吸附 / 缩放的交互回归 | 环境无法稳定模拟桌面拖拽 | 手工拖至屏幕边缘验证收起条与展开 |
| 托盘菜单 / 全局热键 | 需人工点击托盘 | 托盘右键切主题切模式；`Ctrl+Alt+T` 显示/隐藏 |
| 隐藏状态下切换窗口模式后 WebView2 子窗口尺寸跟随 | v0.5 既有行为，本轮未改动 | 切到紧凑/极简后观察外框与内容尺寸 |
| 长时间常驻的内存与 GPU 曲线 | 需长时间挂机 | 挂机 8 小时后看任务管理器与性能计数器 |
| 真机剪贴板读写、逐项粘贴 | v0.5 已完成真机验收（46/46、真实剪贴板 3/3） | 见 `docs/clipboard/11-final-release-acceptance.md` |

---

## 7. 结论

- 需求点名的 **13 组验收点全部有可执行证据**（自动化用例或走查脚本），无一条靠推测；
  浏览器层新增 v0.7 **32 场景 + 4 交互**全绿。
- 前端 **40 文件 / 290 用例全部通过**。
- Rust **472 通过 / 3 失败 / 3 ignored**：3 条失败均为锁屏会话下导航置前被拒的环境阻塞
  （测试自身打印 `ENVIRONMENT-BLOCKED`），不属于 v0.6 圆角改动模块，也不伪造成通过。
- **圆角结论已重写**：旧的 `0.0 ✅ PASS` 撤回；修复前真机证据为 `FAIL`，
  修复后原生像素验收为 `UNVERIFIED`（锁屏），在解锁并得到 `PASS` 前不宣称修复完成。
- 视觉走查 **32（v0.7 全矩阵）+ 26（v0.6 交互）+ 18（基线）场景**全部达标；
  布局回归 **37 组合**全部达标（六入口可达、快速添加不被遮挡、无横向溢出）。
- 剪贴板侧边栏化后**没有出现重复监听**（单监听断言通过），
  **没有复制第二套加载/操作逻辑**（页面与抽屉共用 `ClipboardWorkspace`）。
- **未验证项已在第 6 节逐条列出**并给出复现步骤，不用推测代替结论。
