# 07 · 视觉验收（实际运行截图与证据）

> 原则：**视觉验收的第一依据是需求给出的两张效果图**，业务行为的第一依据是现有代码与测试。
> 本文只记录**真实产生的截图**与其可复现的判定方法，不做无证据的结论。

---

## 1. 证据类型说明

| 类型 | 目录 | 说明 | 可否作为原生窗口验收 |
| --- | --- | --- | --- |
| 浏览器 harness 截图 | `docs/screenshots/v06/*.png`（非 `native-` 前缀） | 真实 `dist` 产物 + IPC mock + 模拟壁纸，2× 缩放 | ❌ 只能验证 CSS 布局与配色 |
| **原生窗口截图** | `docs/screenshots/v06/native-*.png` | 真实 Release 程序的 Win32 窗口，**桌面合成像素** | ✅ 可验证圆角、材质、层级 |
| 圆角几何校验 | `scripts/check-corners.py` 输出 | 独立背景基线 + 圆角外像素/深色连通块/半径/描边联合判定 | ✅ 客观判定（缺基线则 UNVERIFIED） |

原生截图环境：**Windows 11（build 26100）· 125% DPI · 1920×1440 逻辑分辨率的 2560×1440 屏幕 · Release 构建**。

> **两类截图必须分开看**：harness 图是「Web 内容渲染结果」，用于检查布局、配色、
> 弹层层级与交互状态；原生图是「真实 Win32 窗口的桌面合成像素」，额外用于检查
> 圆角裁剪、原生材质透出与窗口层级。harness 图**不能**替代原生验收，
> 原生图也**不能**覆盖同分辨率下的 CSS 细节走查。

---

## 2. 原生窗口证据（核心）

> **注意**：本节的原生截图采集于 v0.6 修复前。图中四角的黑楔、灰边与白晕正是
> 第 3 节撤回的缺陷，不能用它们证明圆角通过；它们只用于核对布局、标题栏结构与层级。
> 修复后的原生像素验收当前为 `UNVERIFIED`（会话锁屏），见第 3.3 与第 6 节。

### 2.1 梦幻渐变 · 浅色

![梦幻渐变浅色](../screenshots/v06/native-dream-light.png)

- 左侧垂直导航（任务/Agent/行动/**剪贴板**/历史/设置）+ 底部「添加」
- 标题栏：品牌球 + Agent 状态点 + 模式/明暗/预设三组菜单 + 最小化 + 关闭
  （**完整模式不再有剪贴板按钮**，剪贴板入口在左侧导航第 4 项）
- 三张统计卡（图标语义色）、快速添加（渐变「解析」按钮）、日期/状态筛选、排序
- 空状态玻璃气泡插画

### 2.2 梦幻渐变 · 深色

![梦幻渐变深色](../screenshots/v06/native-dream-dark.png)

### 2.3 液态玻璃 · 浅色

![液态玻璃浅色](../screenshots/v06/native-glass-light.png)

窗口可见桌面透出（右下角带出壁纸的暖色调），卡片为半透明玻璃面 + 顶部内高光。

### 2.4 液态玻璃 · 深色

![液态玻璃深色](../screenshots/v06/native-glass-dark.png)

### 2.5 极简模式（原生窗口自身绘制内容）

![极简模式](../screenshots/v06/native-minimal-printwindow.png)

极简模式保持原有用途：**待办数 / 下次到期 / 全局空闲状态**一行三块，
标题栏只保留品牌、剪贴板、最小化、关闭（明暗与预设菜单按需隐藏，避免 280px 宽度溢出）。
紧凑/极简没有左侧导航，剪贴板入口仍由标题栏按钮提供。
圆角同样生效。

> 注：原生窗口在「隐藏状态下切换尺寸」时，本机观察到 WebView2 子窗口尺寸未跟随外框
> （外框 500×700，内容按极简尺寸 350×175 绘制）。这是 v0.5 既有行为，与本次视觉重构无关，
> 已列入第 6 节未验证项；harness 侧的极简/紧凑布局截图见第 4 节。

---

## 3. 四角黑色直角：旧结论撤回与重验

> **撤回声明（2026-10-31）**：本节原先的「四角平均差 0.0 / ✅ PASS」结论**无效，已撤回**。
> 旧脚本把**同一张截图内**的窗口角块与窗外桌面块互相比对——两者是同一批像素，
> 即使四角是黑色直角、黑楔或灰边，差值也恒为 0；同时它把 `GetWindowRgn` 返回成功
> 当作通过条件，无法发现 DWM/Mica 在区域之外继续绘制。真机截图已证伪该结论
> （右下黑月牙、右上黑楔 + 灰边 + 白晕）。
>
> 专项报告、根因和修复记录见 **[12-v06-window-corners.md](12-v06-window-corners.md)**。

### 3.1 新判定方法（独立背景基线）

`scripts/corner-lab.ps1` 先把整屏铺成受控纯色并截取**基线帧**（此时应用窗口隐藏），
再显示窗口截取**可见帧**；`scripts/check-corners.py` 要求：

1. 基线帧在窗口四角与远处都必须等于预期纯色，否则 `UNVERIFIED`；
2. 在窗口矩形内比较「窗口外、圆角内」像素与基线，统计非背景像素与深色连通块；
3. 检查 1px 描边/外扩阴影，从可见/基线差分拟合实际半径；
4. 联合 `GetWindowRgn`/`GetRgnBox`/`PtInRegion` 与 DWM 读数；
5. 缺少基线、窗口位置异常 → `UNVERIFIED`；**绝不因为 `GetWindowRgn` 成功而 PASS**。

退出码：`0` PASS、`1` FAIL、`2` 无 FAIL 但有 UNVERIFIED。

### 3.2 旧证据在新标准下的结论

| 证据 | 结论 | 原因 |
| --- | --- | --- |
| `docs/screenshots/v06/native-dream-light.png` | `UNVERIFIED`（exit 2） | 缺少对应的 lab 元数据与独立基线，无法重验 |
| `docs/screenshots/v07/lab-glass-region-dwm.json` | `FAIL`（exit 1） | 四角各 44–45 个深色像素、49 个非背景像素；底/右 1px 描边 |
| `docs/screenshots/v07/lab-solid-region-dwm.json` | `FAIL`（exit 1） | 四角 40–42 个非背景像素；右下半径 31.75 vs 22；底/右 1px 描边 |
| `docs/screenshots/v07/lab-resize-solid-region-dwm.json` | `FAIL`（exit 1） | 缩放链路同样未裁净 |
| `docs/screenshots/v07/lab-v071-solid-region-dwm.json` | `FAIL` + `UNVERIFIED` | 锁屏采集基线为 `0,0,0`，分析器正确拒绝 |

放大证据：`docs/screenshots/v07/corners/before-glass-*.png`、
`docs/screenshots/v07/corners/before-solid-*.png`；
分析 JSON 见同目录 `*-analysis.json`。

### 3.3 修复后的原生验收状态

修复代码（区域缓存/重入、blur 后端、DWM 边框）与浏览器层回归已完成，
但**修复后的原生窗口像素验收为 `UNVERIFIED`**：当前 Windows 会话被锁屏，
屏幕捕获为全黑，无法建立有效基线。解锁后执行：

```powershell
powershell -ExecutionPolicy Bypass -NoProfile -File scripts/native-verify.ps1 `
  -Out docs/screenshots/v07/lab-solid-region-dwm.png -Material solid -Preset dream-gradient
powershell -ExecutionPolicy Bypass -NoProfile -File scripts/native-verify.ps1 `
  -Out docs/screenshots/v07/lab-glass-region-dwm.png -Material glass -Preset liquid-glass -Backend blur
python scripts/check-corners.py docs/screenshots/v07/lab-*-region-dwm.json
```

只有在新的原生采集上得到 exit 0，本节的圆角项才能标记通过；
在此之前保留 `UNVERIFIED`。

---

## 4. 浏览器 harness 走查矩阵

| 截图 | 预设 / 明暗 / 材质 / 宽度 | 验证点 |
| --- | --- | --- |
| `dream-light-400.png` | 梦幻 / 浅 / glass / 400 | 基线布局 |
| `dream-dark-400.png` | 梦幻 / 深 / glass / 400 | 深色层级 |
| `glass-light-400.png` | 液态 / 浅 / glass / 400 | 玻璃语言 |
| `glass-dark-400.png` | 液态 / 深 / glass / 400 | 深色玻璃 |
| `dream-light-400-solid.png` | 梦幻 / 浅 / solid / 400 | 原生不可用时的回退 |
| `glass-light-400-solid.png` | 液态 / 浅 / solid / 400 | 玻璃语义的**不透明**版本 |
| `dream-light-340.png` | 梦幻 / 浅 / glass / 340 | 导航收敛为仅图标 |
| `glass-light-320.png` | 液态 / 浅 / glass / 320 | 极窄窗 |
| `dream-empty-400.png` | 梦幻 / 浅 / glass / 400 | 空状态插画 |
| `glass-empty-400.png` | 液态 / 浅 / glass / 400 | 空状态 + 玻璃 |
| `dream-empty-dark.png` | 梦幻 / 深 / glass / 400 | 深色空状态 |
| `glass-many-400.png` | 液态 / 浅 / glass / 400 | 60 条任务的密度 |
| `settings-presets.png` | 梦幻 / 浅 / glass / 400 | 设置页预设选择卡 |
| `glass-light-tasks.png` | 液态 / 浅 / glass / 400 | 常规任务列表 |
| `dream-minimal-280.png` | 梦幻 / 浅 / glass / 280 | 极简模式未受影响 |
| `glass-compact-400.png` | 液态 / 浅 / glass / 400 | 紧凑模式未受影响 |
| `dream-clipboard-page.png` | 梦幻 / 浅 / glass / 400 | **剪贴板主页面**（侧边栏第 4 入口） |
| `glass-clipboard-page.png` | 液态 / 浅 / glass / 400 | **剪贴板主页面**（侧边栏第 4 入口） |

自动化判定（`scripts/visual-themes.mjs`）：18 个场景全部
`scrollWidth - clientWidth = 0`、关键元素无越界、运行期 0 错误。

### 4.1 v0.6 交互场景走查（`scripts/visual-v06.mjs`）

需求点名的七个场景，**两套预设 × 明暗**各出图：

| 场景 | 梦幻渐变 · 浅 | 梦幻渐变 · 深 | 液态玻璃 · 浅 | 液态玻璃 · 深 |
| --- | --- | --- | --- | --- |
| 任务页 + 排序菜单展开 | `dream-light-tasks-sort-menu.png` | `dream-dark-tasks-sort-menu.png` | `glass-light-tasks-sort-menu.png` | `glass-dark-tasks-sort-menu.png` |
| 设置页 + 主题下拉展开 | `dream-light-settings-theme-select.png` | `dream-dark-settings-theme-select.png` | `glass-light-settings-theme-select.png` | `glass-dark-settings-theme-select.png` |
| 日期时间选择浮层 | `dream-light-datetime-overlay.png` | `dream-dark-datetime-overlay.png` | `glass-light-datetime-overlay.png` | `glass-dark-datetime-overlay.png` |
| 剪贴板主页面 | `dream-light-clipboard-page.png` | `dream-dark-clipboard-page.png` | `glass-light-clipboard-page.png` | `glass-dark-clipboard-page.png` |
| 剪贴板关联抽屉 | `dream-light-clipboard-link-drawer.png` | `dream-dark-clipboard-link-drawer.png` | `glass-light-clipboard-link-drawer.png` | `glass-dark-clipboard-link-drawer.png` |
| 深色主题菜单 | `dream-dark-titlebar-menu.png` | — | `glass-dark-titlebar-menu.png` | — |
| 320px 窄布局 | `dream-light-320-narrow.png` | — | `glass-light-320-narrow.png` | — |

> 剪贴板**主页面**与**关联抽屉**分别出图：v0.6 起两者是不同形态
> （页面 = 侧边栏第 4 项；抽屉 = 任务关联的临时面板），
> 合并成一张图会掩盖两者的层级差异。

### 4.2 v0.6 布局回归走查（`scripts/layout-regression.mjs`）

37 个组合的审计产物：`docs/screenshots/v06/layout-audit.json` + `layout-*.png`。
断言见 [05-test-plan.md](05-test-plan.md) 第 2.3 节（六个入口可达、快速添加不被遮挡、
无横向溢出、运行期 0 错误）。

---

## 5. 与效果图的对照

| 效果图特征 | 实现情况 | 说明 |
| --- | --- | --- |
| 左侧竖排导航，图标在上、文字在下 | ✅ 一致 | 宽度按 400px 基线压缩到 62px |
| 选中项有淡色底 + 左侧竖条 | ✅ 一致 | 梦幻渐变用淡紫药丸；液态玻璃用玻璃胶囊 |
| 顶部标题栏：品牌 + 右侧图标组 | ✅ 一致 | 增加了预设切换入口与 Agent 状态点 |
| 三张统计卡（图标/数字/标签） | ✅ 一致 | 语义色只作用于图标与逾期标签 |
| 快速添加 + 渐变主按钮 | ✅ 一致 | 按钮走 `--accent-gradient` |
| 筛选药丸 + 搜索 + 排序 | ✅ 一致 | 容器与选中态分离，减少重复背景 |
| 空状态气泡插画 | ⚠️ 近似 | 纯 CSS/SVG 静态实现，无实时折射 |
| 窗口外有明显投影 | ❌ 未实现 | 窗口区域裁剪后 DWM 不绘制外部阴影（03 文档说明） |
| 玻璃卡片更透 | ⚠️ 取舍 | 为保证文字对比度，浅色卡片不透明度提到 74–86% |

---

## 6. 未验证项（明确标记，不虚构通过）

| 项 | 原因 | 复现方法 |
| --- | --- | --- |
| **修复后原生圆角像素（Solid / Glass）** | 当前 Windows 会话被锁屏（LogonUI 运行中），屏幕捕获为全黑，无法建立有效背景基线 | `scripts/native-verify.ps1` + `scripts/check-corners.py`，见 12 号报告第 9 节 |
| **原生最小化 / 托盘隐藏 / 恢复 / 缩放 / 最大化还原** | 需要未锁屏的真实桌面交互 | `native-verify.ps1 -MinimizeCycle`、`-ResizeTo` 后重跑像素分析 |
| **原生主题切换 / 显示模式切换 / 材质切换后的圆角** | 同上 | 逐项切换后各采一帧，四角必须仍 PASS |
| Windows 10 真机 | 本机仅 Windows 11 | 在 Win10 上执行 03 文档第 8 节的取证脚本 |
| 100% / 150% DPI | 本机显示缩放为 125% | 改显示缩放后重跑取证脚本，并核对 `--radius` 与 CSS 半径一致 |
| Dev 模式（`npm run tauri dev`） | 本轮只验证 Release | 执行 `npm run tauri dev` 后人工核对 |
| 拖动 / 贴边吸附 / 缩放的交互回归 | 当前环境无法稳定模拟桌面拖拽 | 手工：拖动窗口至屏幕边缘，确认收起条与展开；拖动改尺寸，确认圆角与内容同步 |
| 隐藏状态下切换窗口模式后 WebView2 子窗口尺寸跟随 | 本机观察到外框 500×700 而内容按 350×175 绘制（v0.5 既有行为） | 切换到紧凑/极简后观察窗口外框与内容尺寸是否一致 |
| 托盘菜单 / 全局热键 | 需要人工点击托盘 | 托盘右键切主题、切模式；`Ctrl+Alt+T` 显示/隐藏 |
| 长时间常驻的内存与 GPU 曲线 | 需要长时间挂机观察 | 挂机 8 小时后查看任务管理器与性能计数器 |
| 真实彩色壁纸下的主观玻璃观感 | 桌面壁纸不可控 | 在 colorful 壁纸上人工评估（可参考 harness 的模拟壁纸图） |

---

## 7. 结论

- 需求给出的两张效果图所定义的**结构**（左侧竖排导航、图标+文字、三统计卡、快速添加主入口、
  药丸筛选、空状态插画、标题栏图标组）已在两套预设中一致实现，并有实际运行截图。
- 旧的四角 `0.0 ✅ PASS` 结论已撤回：它用同帧像素自比、且缺少独立背景基线，
  已被真机黑角截图与新的分析器证伪（详见第 3 节与 [12 号专项报告](12-v06-window-corners.md)）。
- 黑角的根因已定位（Mica/DWM SystemBackdrop 越过 `SetWindowRgn`、区域缓存/重入失效、
  DWM 默认 1px 边框），修复代码与浏览器层回归已完成；
  **修复后的原生像素验收仍为 `UNVERIFIED`**（会话锁屏），在解锁并得到 `PASS` 前
  不宣称黑角已修复。
- 两套预设、明暗、材质三种维度在浏览器 harness 中可任意组合且保持一致视觉语言；
  原生主题/材质切换与 Solid 回退的真机呈现列在第 6 节未验证项。
- 性能实测：空闲近零开销、0 个 `backdrop-filter`、无常驻动画。
- 未验证项已在第 6 节逐条列出，均给出可执行的复现步骤，不以推测代替结论。
