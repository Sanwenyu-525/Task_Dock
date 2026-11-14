# Android 屏幕与控制（ADB + scrcpy）

- 落地日期：2026-11-14
- 入口：桌面端左侧导航「手机互传」→「Android 屏幕与控制」折叠区块
- 技术边界：开发者模式（ADB + scrcpy）；不依赖 root、Shizuku、MediaProjection 或自研视频编码
- 相关 PoC：[`docs/validation/ANDROID_VIRTUAL_DISPLAY_POC.md`](../validation/ANDROID_VIRTUAL_DISPLAY_POC.md)

本文描述**已实现**的能力与契约；真机验证状态与已知限制见文末。实现与本文冲突时以代码为准，并按
「变更记录」追加带日期的更正。

## 1. 能力概览

| 能力 | 状态 | 说明 |
|---|---|---|
| 设备发现与授权状态 | 已实现 | `adb devices -l`，合并同一物理设备的多条 transport |
| 屏幕镜像（实体屏） | 已实现 | scrcpy 默认显示；电脑与手机共享同一画面 |
| 独立虚拟屏 | 已实现 | `--new-display=1080x1920/384 --start-app=<pkg>` |
| 应用选择 | 已实现 | 仅列可启动应用；按名称/包名搜索；可显示无入口应用及原因；手动输入包名 |
| 会话状态机 | 已实现 | starting / running / stopping / stopped / error / disconnected |
| 就绪判定 | 已实现 | 解析 scrcpy stderr：New display → Starting app → Texture |
| 关闭与回收 | 已实现 | WM_CLOSE → 5s 有界等待 → 强杀；Job Object 兜底 |
| 多屏实验 | 已实现（默认关闭） | 高级选项开启后最多 2 个会话；每个会话独立关闭 |
| 窗口定位 | 已实现 | 按会话 PID 找 scrcpy 顶层窗口并前置 |
| 截图 | 已实现 | PrintWindow 客户区 → PNG；仅用户点击触发；可存暂存架/另存 |
| 残留诊断 | 已实现（检测） | `dumpsys display` 识别 `virtual:com.android.shell`；可重连 ADB 清理 |
| 本地化应用名 | 部分实现 | scrcpy 启动日志中的名称会被记住；未启动过的应用回退包名 |

明确不做：自研编码/WebRTC、MediaProjection 冒充虚拟屏、root/刷机、自动安装 APK、自动开启
无线调试/开发者选项、`SetParent` 嵌入 Tauri 窗口、云端远控。

## 2. 分层与文件

```
UI（React）  src/components/mobile/VirtualDisplaySection.tsx
             src/components/mobile/virtual-display.css
IPC 封装     src/lib/bridge.ts（Vd* 类型与命令）
命令层       src-tauri/src/commands/virtual_display.rs
               · 参数校验（serial / package / mode / size）
               · ADB 设备/应用查询、设备身份去重、工具链探测
               · vd_probe / vd_devices / vd_list_apps / vd_start / vd_stop /
                 vd_sessions / vd_focus / vd_screenshot / vd_screenshot_export /
                 vd_diagnostics / vd_reconnect
会话服务层   src-tauri/src/commands/virtual_display/process.rs
               · SessionManager（全局 HashMap + 每会话 Mutex）
               · 状态机、日志就绪探测、启动超时、停止收尾、Job Object、窗口与截图
```

设计约束：

- **唯一服务**：屏幕镜像与虚拟屏共用同一个 SessionManager，不为工作空间另建投屏服务；
- 后续项目工作空间只需调用同一组命令即可引用设备会话；
- 设备序列号、包名、会话均只存在运行期内存，不写 SQLite、不新增设置键/迁移；
- 设备连接与 task_dock 自有 TLS 配对是两套信任身份，互不复用。

## 3. 两种模式

| | 屏幕镜像 `mirror` | 独立虚拟屏 `virtual` |
|---|---|---|
| scrcpy 参数 | 默认显示 | `--new-display=<WxH/DPI>` + `--start-app=<pkg>` |
| 手机实体屏 | 与电脑同一画面 | 继续运行用户自己的应用 |
| 应用选择 | 不需要 | 需要（可启动入口校验） |
| 默认尺寸 | — | `1080x1920/384`（PoC 真机验证组合） |
| 可选尺寸 | — | 竖屏 `1080x1920/384`、横屏 `1920x1080/384` |
| 输入法 | scrcpy 默认策略 | `--display-ime-policy=local`（支持时） |
| 剪贴板 | 默认 `--no-clipboard-autosync` | 同左；显式开关可开启 |

启动参数固定 `--no-audio`（本轮不转发音频），窗口标题带 `Task Dock ·` 前缀，关闭行为不受
用户手动启动的 scrcpy 影响。

模式切换只影响下一次创建，不会关闭正在运行的窗口；UI 在存在活动会话时明确提示这一点。

## 4. 会话状态机

| 状态 | 事实来源 | UI 行为 |
|---|---|---|
| `starting` | 进程已创建 | 显示「启动中」+ 阶段；可关闭 |
| `running` | 收到 scrcpy `Texture` 日志 | 显示「运行中」、时长；可截屏/定位/关闭 |
| `stopping` | 用户点击关闭 | 显示「关闭中」；后台收尾 |
| `stopped` | 进程退出且为主动关闭/窗口正常关闭 | 显示「已结束」，12s 后从列表移除 |
| `error` | 启动超时、早退、致命 `ERROR:` | 显示可读原因，12s 后移除 |
| `disconnected` | `Device disconnected` 或非 0 退出 | 显示「连接中断」及原因 |

阶段（`stage`）：`process` → `display`（虚拟屏已创建）→ `app`（应用启动指令）→
`video`（视频流已建立）→ `ready`（应用启动已确认）。

**不允许**仅凭 PID 判为成功：进程存在但 25s 内没有收到视频流会转为 `error` 并回收。虚拟屏模式
若只收到视频流、日志中没有 `Starting app`，会保留 `running` 但追加「未能确认应用已启动」警告。

## 5. 启动流程

1. 校验模式、serial、包名、尺寸（宽高 200–4096，DPI 120–640）。
2. 定位 adb / scrcpy（`TASK_DOCK_ADB` / `TASK_DOCK_SCRCPY` → `PATH` → SDK/winget 常见路径）。
3. 读取 `scrcpy --help`（缓存 10 分钟），虚拟屏模式必须有 `--new-display`。
4. `adb devices -l` 确认设备在线且已授权；使用后端选定的唯一 transport。
5. 虚拟屏模式检查应用是否有启动入口（`cmd package query-activities --brief`）。
6. 会话上限/重复检查（同一设备+模式+应用只允许一个活动会话）。
7. 创建进程、加入 Job Object、写入运行期会话表。
8. 后台线程读取 stderr 并推进状态；`vd_start` 立即返回 `starting`，前端轮询到 `running/error`。

超时与并发：

- 启动超时 25s；早退时读取最后 4 行日志生成可读错误；
- 停止先 `WM_CLOSE`，5s 未退出才强杀；
- 全局会话表只在增删/遍历时短暂加锁；停止等待在独立线程，`vd_sessions` 始终可响应。

## 6. 退出与异常

| 场景 | 行为 |
|---|---|
| 从 task_dock 关闭 | 标记 stopping → WM_CLOSE → 有界等待 → 强杀兜底 |
| 用户直接关 scrcpy 窗口 | 进程退出 → `stopped`（code 0）或 `disconnected`（非 0） |
| scrcpy 异常退出 | `error/disconnected` + 日志尾部 |
| ADB 中途断开 | 日志 `Device disconnected` → `disconnected`，后台回收进程 |
| task_dock 正常退出 | `RunEvent::Exit` 显式关闭本进程会话；Job Object 再兜底 |
| task_dock 被强杀 | Job Object (`KILL_ON_JOB_CLOSE`) 回收本进程创建的全部 scrcpy |
| 启动被取消/超时 | 状态转 error，关闭窗口并回收进程 |

**只操作本进程创建的进程**：按记录的 PID 枚举顶层窗口，不按镜像名批量结束。
Job Object 创建/分配失败会在会话 `warning` 中明确提示，不静默视为成功。

残留诊断：`vd_diagnostics` 读取设备 `dumpsys display`，报告 `virtual:com.android.shell` 且含
`scrcpy` 的显示；没有本模块活动会话时提示可能为异常残留。清理入口 `vd_reconnect` 仅在无本模块
会话时允许，执行 `adb -s <serial> reconnect`；UI 会明确告知可能中断其他 ADB 会话（包括手动
scrcpy），需用户确认。

## 7. 并发与多屏

- 默认 `max_sessions = 1`；高级选项「多屏实验模式」把上限放宽到 2（PoC 真机验证过双虚拟屏）。
- 上限与会话表在同一个锁内检查，避免重复点击/并发请求创建多个进程。
- 每个会话独立 ID、PID、模式、设备、状态、截图；关闭 A 不影响 B。
- 同一设备同一模式同一应用的活动会话重复请求返回 `Conflict`，不会启动第二个进程。
- 多屏资源占用只做 UI 提示，不做硬性配额；长时稳定性仍需真机评估。

## 8. 设备发现与去重

- 解析 `adb devices -l`；序列号允许包含空格（mDNS transport 名）。
- 物理身份：
  - USB：serial 即身份；
  - mDNS：从 `adb-<serial>-<random>._adb-tls-connect._tcp` 提取 `<serial>`；
  - 直连 IP：`adb shell getprop ro.serialno`（缓存 5 分钟）。
- 合并规则：身份相同才合并；同型号不同身份不合并；身份无法解析的 transport 独立展示。
- 选择顺序：在线（device）优先 → USB → 直连 Wi-Fi → mDNS；同一设备只要一条在线即整体在线。
- UI 只显示型号、在线状态、连接方式与「N 条连接已合并」，不把完整序列号作为主视觉。

## 9. 应用选择

- 枚举：`pm list packages -3` + `-s` 区分用户/系统；`cmd package query-activities --brief`
  获取具备 LAUNCHER 入口的包（Android 版本不支持时回退为全部，并标记「无法判定」）。
- 默认只显示可启动应用；「显示无启动入口的应用」会附加原因并禁用选择。
- 搜索按应用名与包名（Combobox 的 label + hint）。
- 应用名：scrcpy 启动日志 `Starting app "设置" [pkg]` 中的名称会被记住并用于会话与后续列表；
  未启动过的应用回退包名（不伪造本地化名称）。
- 手动输入包名是高级选项，前后端都做字符集校验（ASCII 字母数字、`.`、`_`，不以 `-` 开头）。
- 列表缓存 60s，按 transport + 设备身份约束；设备切换/transport 轮换时前端递增请求序号并
  丢弃迟到响应，不显示上一台设备的应用。

## 10. 窗口、截图与诊断

- `vd_focus`：按 PID 找可见、无 owner、非 tool window 的最大顶层窗口；恢复（最小化时）并
  `SetForegroundWindow`；返回 `found/focused`，系统拒绝前台时 UI 给出提示。
- `vd_screenshot`：仅 `running` 会话可用；`PrintWindow(PW_CLIENTONLY|PW_RENDERFULLCONTENT)`
  → BGRA → PNG；最小化时先恢复；空画面返回明确错误。文件写入
  `%TEMP%\task-dock-vd\shots\`，同一会话只保留最近一张，会话结束/过期时删除。
- 预览使用 asset protocol，scope 仅 `$TEMP/task-dock-vd/shots/**`。
- 保存：暂存架（`shelfAddPaths(..., "managed")`）或系统「另存为」对话框
  （`vd_screenshot_export` 复制到用户选择路径）。
- 截图只在用户点击时产生，没有后台周期截图、自动上传或画面写日志。

## 11. 安全与隐私

- 不自动开启开发者选项/无线调试，不安装 APK，不重置 ADB 授权。
- ADB 连接拥有 shell 级调试与输入注入能力；UI 明确提示只连接信任设备。
- 设备 serial、IP transport、包名与会话只存运行期内存；日志/报告不记录配对码、IP 或设备完整
  序列号（诊断输出只含 display owner/类型并截断 160 字符）。
- 剪贴板同步默认关闭；开启时提示可能互相覆盖，不改变手机默认输入法或系统设置。
- 截图是用户主动操作；临时文件与会话同生命周期清理。

## 12. UI 与文案

- 区块：设备状态卡（型号/在线/连接方式/工具链/刷新）→ 模式分段（屏幕镜像/独立虚拟屏）→
  模式相关控件 → 创建 → 活动会话卡片 → 高级与诊断 → 安全提示。
- 会话卡片：应用名/包名、模式徽标、状态点、阶段、运行时长、设备型号、错误/警告、定位/截屏/关闭。
- 全部按钮连接真实 IPC；不可执行的操作禁用并给出原因，不保留假按钮。
- 窄面板（≤420px）下设置行换行、会话操作换到下一行；长名称/包名用省略号 + `data-tip`。
- 文案在 `zh-CN` / `en-US` 同步维护；状态徽标/圆角/颜色使用语义 Token。

## 13. 测试与验收命令

工作目录：`D:\Develop\task_dock`

```bash
# 前端类型与单测
node --max-old-space-size=3072 ./node_modules/typescript/bin/tsc --noEmit
npx vitest run src/components/mobile/VirtualDisplaySection.test.tsx

# Rust 单测（src-tauri 内运行；测试 exe 的 Common-Controls v6 manifest 由 build.rs 注入）
cd src-tauri && cargo test --lib commands::virtual_display -j1

# 构建
cd src-tauri && RUST_MIN_STACK=33554432 CARGO_INCREMENTAL=0 cargo build -j1
```

Rust 单测覆盖：ADB 输出解析、mDNS serial 提取、设备去重（USB/直连/mDNS、同型号不合并）、
包名校验、尺寸校验、模式校验、可启动组件解析、scrcpy 日志信号、参数构造、状态辅助函数。

真机验收需覆盖：镜像/虚拟屏双模式、鼠标点击与滑动、中英文输入、旋转/缩放、锁屏/解锁、
关闭窗口、关闭 task_dock、无线 ADB 断开、重复点击、多窗口独立关闭。**jsdom/单测不能替代真机。**

## 14. 已知限制与未验证项

| 项 | 状态 |
|---|---|
| 长时稳定性 / 内存增长 | 未验证（PoC 只做短时观察） |
| 锁屏/息屏下虚拟屏行为 | 未验证（需用户配合解锁） |
| 物理触控与电脑操作并发 | 用户此前人工补测过同时触控；本轮未重复 |
| 同应用双实例 | 证据不足（Android 任务复用行为因应用而异） |
| 其他厂商/机型 | 仅 vivo V2323A / Android 16 验证过 |
| 应用本地化名称 | 仅 scrcpy 启动过的应用能获得；其余回退包名 |
| 多屏长时资源 | 未做受控基准 |
| 横屏虚拟屏 | 参数已支持；本轮无设备，未复验 |
| 截图 | PrintWindow 对 GPU 画面/受保护窗口可能失败，失败时返回错误而非空图 |

## 15. 变更记录

- 2026-11-14：从 MVP（单虚拟屏 + 包名列表）升级为双模式会话服务；新增状态机与日志就绪
  判定、设备身份去重、可启动应用枚举、应用名记忆、窗口定位、截图、残留诊断、多屏实验开关；
  关闭不再持有全局锁等待；Job Object 分配失败显式告警；新增 `tests.manifest` 修复测试 exe
  的 `STATUS_ENTRYPOINT_NOT_FOUND`。
