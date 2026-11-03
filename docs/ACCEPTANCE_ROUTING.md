# 验收方式路由

本文件定义 Task Dock 验收时「用哪条通道证明哪一层行为」。它只补充通道选择与证据口径，
不替代 [AGENTS.md](../AGENTS.md) 的 Git 安全、构建产物、性能与报告规则，也不替代
[TESTING.md](TESTING.md) 的结果记录。

核心立场：**能用程序化方式可靠验证的 Web 交互，不默认抢占用户鼠标**；但「不移动光标」不等于
「不改变应用状态」。每条结论只覆盖实际测到的那一层，跨层结论必须组合通道。

## 一、通道定义

| 通道 | 适用场景 | 能力边界 | 禁止用途 |
|---|---|---|---|
| **A 静态与自动化测试** | 纯函数、状态机、IPC 参数、SQLite 迁移、契约与类型检查（`npm test`、`cargo test`、`tsc`） | 证明代码层逻辑与契约 | 不得折算为真实 UI / 系统行为通过；`#[ignore]` 套件不得计为通过 |
| **B 隔离浏览器预览** | 视觉走查、布局溢出、主题与 DPI 近似、DOM 交互回归（`scripts/serve-preview.mjs` + Playwright） | 只是 mock IPC 的 harness 渲染，页面由 `.preview/` 与 `dist/` 提供 | 不得代表真实 WebView2、原生窗口、系统通知、系统剪贴板与前台焦点 |
| **C CDP + 真实 WebView2** | 真实运行实例中的点击 / 悬停 / 填写 / 键盘、DOM 可见性、控制台错误、交互计时（`scripts/acceptance/*.mjs`、`scripts/native-cdp.mjs`） | Playwright locator 与 mouse / keyboard 走浏览器输入管线，通常不移动系统光标；可读真实 WebView2 状态 | 不得证明 Win32 裁剪、吸附手感、系统级鼠标命中、系统通知真实展示、实际音效、桌面合成透明度与融合；页面截图不能替代桌面合成截图 |
| **D UIAutomation** | 控件树、可访问名称、enabled / disabled、文本与结构断言 | 证明可访问性结构与控件属性 | 不得证明 hover、拖拽、实际鼠标命中，也不证明像素外观 |
| **E Win32/DWM 原生** | 真实窗口区域、圆角、桌面合成、DPI / 多显示器几何、进程级资源（`scripts/native-verify.ps1`、`scripts/corner-lab.ps1`、`scripts/check-corners.py`） | 以真实 exe + 独立数据目录 + 桌面合成截图为证 | 不得用 CDP 页面截图或预览截图替代；不得在共享实例上覆盖用户数据 |
| **F 真实物理操作 / computer-use** | 必须用真实鼠标 / 键盘 / 桌面才能覆盖的吸附手感、系统级命中、通知实际可见性、第三方应用联动 | 覆盖程序化通道无法触达的物理层 | 仅在无法程序化覆盖时使用；移动光标、抢前台、操作他应用前必须取得授权；不得清理用户剪贴板或数据 |

### 输入管线与证据边界

- Playwright 的 `locator.click/hover/fill`、`mouse.move/down/up/wheel`、`keyboard.press`
  走浏览器输入管线，通常不移动系统光标，可用于 B / C。
- JS 层 `dispatchEvent()` / DOM `.click()` 绕过输入管线与命中测试，**不能**作为真实交互验收
  的充分证据。
- `page.evaluate` 只用于读状态 / 诊断（computed style、DOM 计数、invoke 读取统计）；不得绕过
  被测交互路径直接改状态再宣称通过。`scripts/acceptance/cdp-bridge.mjs` 的 `invoke` 模式属于
  准备条件或读取状态的手段，不是交互证据。
- C 通道必须先用 `scripts/acceptance/cdp-main-window.mjs` 识别主窗口（URL 分类 + Tauri 窗口
  `label === "main"` + `#root` 已挂载 + invoke 可用），不得取「第一个非 devtools 页面」。
- CDP 只连 `127.0.0.1:<port>` 回环地址，不连接来路不明的 target。
- `Tooltip hover：C / Playwright CDP / PASS` 只代表该层；CDP 页面截图 ≠ 桌面合成截图。

### 现有工具与通道对应

| 工具 | 通道 | 复用方式 |
|---|---|---|
| `npm test` / `cargo test` / `tsc -b` / `eslint src/` | A | 逻辑、契约、迁移、类型 |
| `scripts/serve-preview.mjs`、`visual-*.mjs`、`layout-regression.mjs`、`visual-audit.mjs` | B | 预热 harness 后 Playwright 走查 |
| `scripts/acceptance/cdp-main-window.mjs` | C（前置） | 全量枚举 target 并唯一确定主窗口，失败时明确报错 |
| `scripts/acceptance/joint-ui-drive.mjs` | C | locator 点击 / 填写 / 导航 / 计时 / 真实提醒 |
| `scripts/acceptance/cdp-bridge.mjs` | C | 真实 WebView2 上的 invoke 准备与读取；交互证据另算 |
| `scripts/native-cdp.mjs` | C | 附加真实 WebView2，读控制台 / DOM / 页面截图 |
| UIA 工具（PowerShell UIA / computer-use 控件树读取） | D | 结构、名称、可用状态 |
| `scripts/native-verify.ps1` + `corner-lab.ps1` + `check-corners.py` | E | 隔离实例启动、区域回读、桌面合成截图与像素审计 |
| computer-use 物理鼠标 / 键盘 | F | 需授权后覆盖手感、系统级命中、通知可见性 |
| `scripts/perf/memory-probe.mjs`、`ingest-load.mjs`、`perf/sampler.ps1` | A + E | 长跑负载 + 进程资源采样 |

## 二、路由决策顺序

1. **先定验收目标**：写清要证明的行为与失败判据，而不是「跑一遍看看」。
2. **判断行为层**：纯逻辑 / 契约；浏览器 DOM 渲染；真实 WebView2 交互；Win32 / DWM 几何与
   合成；系统级（通知、剪贴板、前台、音效）；物理手感。
3. **选最低干扰通道**：A → B → C → D → E → F，同级优先复用已有脚本，不新造工具。
4. **必要时组合**：一个目标可拆成多层，如「图片预览」= C 渲染 + A 解码 / 存储；
   「胶囊吸附」= E 几何 + F 手感；「系统通知」= A 历史 + D 结构 + F 实际可见。
5. **结论只覆盖实测**：逐项标注通道与未覆盖边界，不得用单通道结果外推到其他层。

## 三、路由示例

| 验收目标 | 主通道 | 补充通道 | 主要证据 | 不能证明 |
|---|---|---|---|---|
| 纯函数 / 迁移 / 契约 | A | — | 命令、工作目录、退出码、用例数 | 真实渲染与系统行为 |
| 弹窗 hover / 聚焦 | C | A（组件单测）、B（视觉走查） | hover 前后可见性与 `data-tip`、computed style、截图 | 桌面合成、Win32 裁剪与系统级命中 |
| 剪贴板图片预览 | C | A（解码 / 存储）、E（若需真实系统剪贴板写入） | 打开详情后的 `naturalWidth` / 像素采样 / 截图 | 第三方应用中的真实粘贴结果 |
| 胶囊四边吸附 | E | A（区域单测）、F（吸附手感） | 区域回读、区域外像素审计、桌面合成截图 | 真实拖拽手感只能由 F 覆盖 |
| 系统通知 | F | A（通知历史 / 命令）、D（控件结构） | 桌面实际可见的截图、通知控件结构、`notification_history` | CDP 不能证明通知真实展示 |
| 长时间运行内存泄漏 | E | A（HTTP 负载脚本、内存探针） | 进程 RSS / 句柄分位采样、平台期、运行条件 | 单次短采样不得表述为「无泄漏」 |
| 320px 窄窗布局 | B | A（布局与溢出单测） | 截图 + 溢出断言 | 真实 DPI 与原生窗口 |
| 全局热键唤起 | F | A（快捷键逻辑）、E（窗口几何） | 真实按键后的窗口状态与前台结果 | 程序化按键只能证明快捷键路径 |

## 四、低干扰与安全约束

- 默认不移动系统光标、不抢前台、不切换窗口；需要前台时必须说明理由并取得授权。
- 不改全局 DPI / 缩放、通知权限、系统主题与材质设置。
- 不改用户剪贴板内容：验收写入后恢复原值，或只在隔离实例内操作；恢复失败必须记录。
- 隔离实例：`TASK_DOCK_DATA_DIR` 指向本任务目录（`tmp/acceptance/<task-name>/...`）；确需
  隔离构建时用绝对路径 `CARGO_TARGET_DIR` 并登记归属，不碰正式安装实例与用户数据。
- CDP 只绑回环；先识别主窗口；不连来路不明的 target；结束关闭 browser 连接、调试端口与实例进程。
- 不与并行会话争抢鼠标 / 键盘 / 前台；同一时间只允许一个会话做物理操作。
- 证据脱敏：不写入剪贴板正文 / 图片、用户个人路径、密钥；截图需裁掉个人内容。

## 五、证据与报告

每项结论写六段：**目标 / 通道 / 实际操作 / 可观察结果 / 证据位置 / 未覆盖边界**。示例：

- `Tooltip hover：C / Playwright CDP / PASS（hover 后提示可见，截图 tooltip-20261103.png）/ 未覆盖：桌面合成`
- `胶囊右缘吸附：E / native-verify.ps1 / PASS（区域回读 + 区域外 0 越界）/ 未覆盖：真实拖拽手感`
- `系统通知：F + D / 桌面截图 + UIA / ENVIRONMENT BLOCKED（锁屏）/ 未覆盖：通知实际展示`

轻量化要求：

- 不粘贴整段 DOM / HTML；记录 targetId、URL、窗口 label、计数、耗时、退出码、截图路径即可。
- 临时证据放 `tmp/acceptance/<task-name>/`；长期证据按 [AGENTS.md](../AGENTS.md) 第 6 章归档，
  不覆盖历史验收资料。
- 任务报告的字段与分级见 [AGENTS.md](../AGENTS.md) 第 10 章，本文件不重复展开。

## 六、环境阻塞与回退

- 锁屏、前台锁拒绝、权限不足、磁盘写满、exe 被并行实例占用等记 `ENVIRONMENT BLOCKED`，
  不标记通过，也不臆断为代码缺陷。
- 回退顺序：C 调试端口不可用 → B / A 并写明缺口；E 无法启动真实实例 → 只保留 A 并写「未验证」；
  F 未获授权 → 不执行，不把其他通道结果冒充物理层。
- 同条件复跑结果一并保留；推翻历史结论时保留旧记录并新增带日期的更正。

## 七、结论口径

保持 [AGENTS.md](../AGENTS.md) 第 10 章的分级与口径：P0–P3 不变；结论只能用
**通过 / 部分通过 / 不通过 / 证据不足**；环境阻塞单列阻塞项，不混入通过率。
