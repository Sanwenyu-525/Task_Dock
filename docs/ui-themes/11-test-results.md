# 11 · v0.6 测试结果

> 测试日期：**2026-10-30** · 环境：Windows 11（build 26100）· 125% DPI ·
> Node 22.22.3 · Rust 1.95.0 (MSVC) · Vitest 3.2.7 · Playwright 1.64.1
>
> 原则：**不以模拟冒充真实**。浏览器 harness 截图与 Windows Release 原生截图
> 分开记录（见第 5 节）；未验证项逐条列出，不做推测性结论。

---

## 1. 自动化测试

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 前端类型检查 | `npx tsc --noEmit` | ✅ 通过，0 错误 |
| 前端单元测试 | `npx vitest run` | ✅ **36 文件 / 260 用例通过**（0 failed） |
| 前端构建 | `npm run build` | ✅ 通过（JS 534.88 kB / gzip 163.14 kB；CSS 114.91 kB / gzip 19.52 kB） |
| Rust 单元测试 | `cd src-tauri && cargo test --release` | ✅ lib **449 passed / 0 failed / 3 ignored**；集成 **1 passed**（其余 15 项为真机验收工具，按惯例 ignored） |
| Release 构建 | `npm run tauri build -- --no-bundle` | ✅ 通过（`src-tauri/target/release/task-dock.exe`） |
| 视觉走查（基线矩阵） | `node scripts/visual-themes.mjs` | ✅ 18 场景全部通过，退出码 0 |
| 视觉走查（v0.6 交互场景） | `node scripts/visual-v06.mjs` | ✅ **26 场景全部通过**：0 横向溢出、0 元素越界、0 导航项裁剪、0 运行期错误 |
| 布局回归矩阵 | `node scripts/layout-regression.mjs` | ✅ **37 组合全部达标**，退出码 0 |
| 性能走查 | `node scripts/theme-perf.mjs` | ✅ 空闲 3 s 主线程 0.2–0.3 ms、布局 0 次、样式重算 0 次、`backdrop-filter` **0 个**、`css-filter` 0 个、常驻动画 **0 个**、主题切换 20 次 0–0.2 ms |

> Rust 集成测试里的 `ignored` 是真机验收工具（真实剪贴板、真实窗口操作），
> 按惯例需显式环境变量才会执行，不计入自动门禁。

### 1.1 v0.6 新增/改写的前端用例

| 文件 | 用例 | 覆盖点 |
| --- | --- | --- |
| `src/components/ui/Select.test.tsx` | 9 | 触发器 combobox 语义 / 点击展开 / ↑↓+Enter 选择 / 禁用项不可选 / **Esc 只关菜单且焦点回触发器** / 外部点击关闭 / Home·End / Tab 正常离开 / **长列表滚动到可见区** |
| `src/components/ui/DropdownMenu.test.tsx` | 11 | `aria-expanded` / 方向键跳过禁用项 / Enter 触发并收起 / Home·End / 字母键定位 / 禁用项 / 单选组 `menuitemradio`+`aria-checked` / Esc 只关本层 |
| `src/components/ui/Popover.edge.test.tsx` | 3 | 下方空间充足时向下展开 / **底部空间不足自动向上翻转** / 浮层挂在 `document.body` 不受内容区裁剪 |
| `src/components/ui/overlayEscape.test.tsx` | 7 | **Escape 优先级：确认框 > 子弹层 > 菜单 > 抽屉 > 主窗口** / 无弹层时才隐藏到托盘 / 抽屉开着时菜单先关 / 连续按 Esc 逐层关闭 / 菜单关闭后焦点回到触发按钮 |
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
| 3 | 一个 Escape 只做一次关闭动作（确认框→子弹层→菜单→抽屉→主窗口） | `overlayEscape.test.tsx` 7 例 | ✅ |
| 4 | 剪贴板成为侧边栏第 6 项，完整模式在内容区呈现；抽屉模式保留任务关联 | `FullView.test.tsx` + `ClipboardPanel.test.tsx` + `ClipboardDrawer.test.tsx` + `useUiStore.test.ts` | ✅ |
| 5 | 剪贴板业务只有一份加载/监听/操作逻辑 | `ClipboardWorkspace` 被页面与抽屉共用；`useClipboardStore.live.test.ts` 断言单监听 | ✅ |
| 6 | 日期时间数据语义不被破坏（不截断秒、不改未触碰字段、截止与提醒独立、可清空、校验） | `DateTimePicker.test.tsx` 10 例 | ✅ |
| 7 | 快捷键与焦点恢复、弹层互斥 | `useGlobalShortcuts.test.tsx` 8 例 + `overlayEscape.test.tsx` | ✅ |
| 8 | 六个侧边栏入口在各种高度下可达，且不遮挡底部快速添加 | `layout-regression.mjs` 37 组合（含 380px 低高度） | ✅ |
| 9 | 320/340/400/500 宽度无横向溢出 | `layout-regression.mjs` + `visual-v06.mjs`（`overflowX === 0`） | ✅ |
| 10 | 高频剪贴板更新下性能不退化 | `useClipboardStore.live.test.ts`（300ms 去抖合并）+ 页面按需加载（不在页不订阅） | ✅ |
| 11 | 两套主题的视觉与交互一致 | `visual-v06.mjs` 26 场景 × 两套预设 | ✅ |

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
| dream-gradient | 0.3 ms | 0 | 0 | 0 | 0 | 0 | 0.1 ms |
| liquid-glass | 0.2 ms | 0 | 0 | 0 | 0 | 0 | 0.2 ms |
| dream-dark | 0.3 ms | 0 | 0 | 0 | 0 | 0 | 0 ms |
| glass-dark | 0.3 ms | 0 | 0 | 0 | 0 | 0 | 0.1 ms |

对照验收标准：空闲 3 s 主线程占用 < 1%、布局 0 次、`backdrop-filter` 0 个、
常驻动画 ≤ 1、切换 20 次 < 100 ms —— **全部满足，余量很大**。

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

---

## 5. 原生窗口截图（**与 harness 分开标记**）

| 类别 | 目录 / 命名 | 性质 |
| --- | --- | --- |
| 浏览器 harness | `docs/screenshots/v06/*.png`（**无** `native-` 前缀） | 真实 `dist` 产物 + IPC mock + 模拟壁纸，2× 缩放。**只验证 CSS 布局与配色** |
| **Windows Release 原生** | `docs/screenshots/v06/native-*.png` | 真实 Release 程序的 Win32 窗口，**桌面合成像素**。可验证圆角、材质、层级 |

本轮原生取证（`scripts/native-verify.ps1` + `scripts/capture-native-set.ps1`）：

| 原生截图 | 预设 / 明暗 | `region_probe` | 四角像素差 |
| --- | --- | --- | --- |
| `native-dream-light.png` | 梦幻 / 浅 | `00001` | 0.0 / 0.0 / 0.0 / 0.0 ✅ |
| `native-dream-dark.png` | 梦幻 / 深 | `00001` | 0.0 / 0.0 / 0.0 / 0.0 ✅ |
| `native-glass-light.png` | 液态 / 浅 | `00001` | 0.0 / 0.0 / 0.0 / 0.0 ✅ |
| `native-glass-dark.png` | 液态 / 深 | `00001` | 0.0 / 0.0 / 0.0 / 0.0 ✅ |

> `region_probe = 00001` 表示四个角点**都在 Win32 窗口区域之外**（被裁掉），
> 区域尺寸 = 窗口尺寸；角点像素与窗外桌面逐像素一致（差值 0.0），
> 说明圆角是「被裁掉的透明区域」而不是深色直角块。

原生图可用于验证**圆角裁剪、原生材质透出、窗口层级**；
harness 图用于验证 **CSS 布局、配色、弹层层级、交互状态**。两者互不替代。

---

## 6. 明确未验证项

| 项 | 原因 | 复现方法 |
| --- | --- | --- |
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

- 需求点名的 **11 组验收点全部有可执行证据**（自动化用例或走查脚本），无一条靠推测。
- 前端 **36 文件 / 260 用例**与 Rust **449 + 1 用例**全部通过，0 失败。
- 视觉走查 **26（v0.6 交互）+ 16（基线）场景**全部达标；
  布局回归 **37 组合**全部达标（六入口可达、快速添加不被遮挡、无横向溢出）。
- 剪贴板侧边栏化后**没有出现重复监听**（单监听断言通过），
  **没有复制第二套加载/操作逻辑**（页面与抽屉共用 `ClipboardWorkspace`）。
- **未验证项已在第 6 节逐条列出**并给出复现步骤，不用推测代替结论。
