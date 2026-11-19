# Android 屏幕与控制（ADB + scrcpy）

- 落地日期：2026-11-14
- 最近更新：2026-11-16
- 入口：桌面端左侧导航「手机互传」→ 顶部「屏幕控制」功能区
- 技术边界：开发者模式（ADB + scrcpy）；不依赖 root、Shizuku、MediaProjection 或自研视频编码
- 相关 PoC：[`docs/validation/ANDROID_VIRTUAL_DISPLAY_POC.md`](../validation/ANDROID_VIRTUAL_DISPLAY_POC.md)

本文描述**已实现**的能力与契约；真机验证状态与已知限制见文末。实现与本文冲突时以代码为准，并按
「变更记录」追加带日期的更正。

## 1. 能力概览

| 能力 | 状态 | 说明 |
|---|---|---|
| 页面分区 | 已实现 | 手机互传页拆为「文件互传 / 屏幕控制」两个功能区；只挂载当前 pane |
| 设备发现与授权状态 | 已实现 | `adb devices -l`，合并同一物理设备的多条 transport |
| 屏幕镜像（实体屏） | 已实现 | scrcpy 默认显示；电脑与手机共享同一画面 |
| 独立虚拟屏 | 已实现 | `--new-display=1080x1920/384 --start-app=<pkg>` |
| 应用选择 | 已实现 | 默认只列可启动应用；真实应用名/包名实时搜索；用户/系统标识；无入口行禁用并说明原因 |
| 手动包名 | 已实现（默认隐藏） | 字符集与长度前后端双校验；非法时禁用创建 |
| 应用名称 | 已实现（真实元数据） | 通过设备侧 PackageManager 元数据批量获取；`vd_list_apps(includeAll=false)` 的 189 个可启动应用均有非空 label |
| 应用图标 | 已实现（真实图标） | 设备侧图标经 `adb pull` 拉取并按包名缓存为 PNG data URL；不可取时回退 AppWindow 占位 |
| 会话状态机 | 已实现 | starting / running / stopping / stopped / error / disconnected |
| 就绪判定 | 已实现 | 解析 scrcpy stdout/stderr：New display → Starting app → Texture |
| 关闭与回收 | 已实现 | WM_CLOSE → 5s 有界等待 → 强杀；Job Object 兜底 |
| 多屏实验 | 已实现（默认关闭） | 高级选项开启后最多 2 个会话；每个会话独立关闭 |
| 窗口定位 | 已实现 | 按会话 PID 找 scrcpy 顶层窗口，恢复最小化并前置 |
| 截图 | 已实现 | PrintWindow 客户区 → PNG；有效性与启发式警告分离；可存暂存架/另存 |
| 截图暂存 | 已实现 | 预览确认图片加载后才可保存；暂存架 managed item 与源会话对应 |
| 残留诊断 | 已实现（检测） | `dumpsys display` 识别 `virtual:com.android.shell`；仅在检测到残留时提供重连 |

明确不做：自研编码/WebRTC、MediaProjection 冒充虚拟屏、root/刷机、自动安装 APK、自动开启
无线调试/开发者选项、`SetParent` 嵌入 Tauri 窗口、云端远控。

## 2. 分层与文件

```
页面编排     src/components/mobile/MobileTransferPanel.tsx
             ├─ 文件互传 pane → src/components/settings/MobileSyncSection.tsx
             └─ 屏幕控制 pane → src/components/mobile/VirtualDisplaySection.tsx
投屏 UI      src/components/mobile/VirtualDisplaySection.tsx（约 900 行，只做状态编排）
             src/components/mobile/virtual-display/
               device-tools.tsx        设备卡 + 工具链 chips 与详情
               mode-picker.tsx         双模式卡片
               app-picker.tsx          应用搜索/选择/手动包名
               session-list.tsx        活动会话概览与操作
               ProjectionToolbar.tsx   投屏控制栏（独立窗口内容，动作全部经 Session 层）
               projection-window-controller.ts
                                       Session ↔ 原生控制栏生命周期 / 可见性状态机
               screenshot-preview.tsx  截图预览与保存
               advanced-section.tsx    高级设置与诊断
               format.ts               标题/状态/时长/包名校验/filterApps 等纯函数
             src/toolbar/main.tsx      控制栏窗口入口（toolbar.html）
             src/store/useVirtualDisplayStore.ts
                                       投屏启动配置（按设备 UID，切页恢复）
             src/components/mobile/virtual-display.css
             src/components/mobile/mobile-page.css
IPC 封装     src/lib/bridge.ts（Vd* 类型与命令，含 vd_session / vd_toolbar_*）
命令层       src-tauri/src/commands/virtual_display.rs
               · 参数校验（serial / package / mode / size）
               · ADB 设备/应用查询、设备身份去重、工具链探测
               · vd_probe / vd_devices / vd_list_apps / vd_start / vd_stop /
                 vd_sessions / vd_focus / vd_screenshot / vd_screenshot_export /
                 vd_diagnostics / vd_reconnect
投屏窗口伴随 src-tauri/src/commands/projection_window.rs
               · Session → scrcpy HWND / Toolbar HWND 注册表（key 只能是 session_id）
               · 窗口矩形/显示器工作区/DPI/最大化/全屏判定与外置/内置几何计算
               · 控制栏 WebView 窗口创建、跟随 watcher、全屏底部触发与延迟隐藏
               · 品牌化（标题/图标/AUMID）与焦点归还
               · vd_session / vd_toolbar_attach|detach|update|destroy /
                 vd_toolbar_set_locked|set_expanded|screenshot
会话服务层   src-tauri/src/commands/virtual_display/process.rs
               · SessionManager（start_gate + 全局 HashMap + 每会话 Mutex）
               · 状态机、日志就绪探测、启动超时、停止收尾、Job Object、窗口与截图
               · Session 生命周期钩子 → 控制栏创建/销毁与 toolbar_state
```

设计约束：

- **唯一服务**：屏幕镜像与虚拟屏共用同一个 SessionManager，不为工作空间另建投屏服务；
- 后续项目工作空间只需调用同一组命令即可引用设备会话；
- 设备序列号、包名、会话均只存在运行期内存，不写 SQLite、不新增设置键/迁移；
- TaskDock TLS 配对设备与 ADB 调试设备是两套信任身份：前者不代表后者已授权，UI 分开表达。

## 3. 两种模式

| | 屏幕镜像 `mirror` | 独立虚拟屏 `virtual` |
|---|---|---|
| scrcpy 参数 | 默认显示 | `--new-display=<WxH/DPI>` + `--start-app=<pkg>`（可选） |
| 手机实体屏 | 与电脑同一画面 | 继续运行用户自己的应用 |
| 应用选择 | 不需要 | 需要（后端校验可启动入口） |
| 默认尺寸 | — | `1080x1920/384`（PoC 真机验证组合） |
| 可选尺寸 | — | 竖屏 `1080x1920/384`、横屏 `1920x1080/384` |
| 输入法 | scrcpy 默认策略 | `--display-ime-policy=local`（支持时） |
| 剪贴板 | 默认 `--no-clipboard-autosync` | 同左；高级设置显式开关可开启 |

启动参数固定 `--no-audio`（本轮不转发音频）。scrcpy 原生窗口标题统一由
`build_projection_window_title` 生成：`TaskDock · 设备型号 · 屏幕镜像` /
`TaskDock · 设备型号 · 应用名`（应用名未知时回退「独立虚拟屏」）；标题不出现 serial、PID、
IP 或 session id，也不再使用带空格的旧品牌写法。窗口图标与 AUMID 在 scrcpy 窗口就绪后由
控制栏伴随系统重新写入（见 §16）。

模式切换只影响下一次创建，不会关闭正在运行的窗口；UI 在存在活动会话时明确提示这一点。
启动按钮反映后端 `stage`：检查环境 → 连接设备 → 创建虚拟屏 → 启动应用 → 等待视频流 → 已就绪。

## 4. 会话状态机

| 状态 | 事实来源 | UI 行为 |
|---|---|---|
| `starting` | 进程已创建，尚未收到视频流 | 显示「启动中」+ 阶段；可关闭 |
| `running` | 收到 scrcpy `Texture` 日志 | 显示「运行中」、时长；可截屏/定位/关闭 |
| `stopping` | 用户点击关闭，已发 WM_CLOSE | 显示「关闭中」；后台收尾，不阻塞其他会话 |
| `stopped` | 主动关闭 / 窗口正常关闭 / task_dock 退出 | 显示「已结束」，12s 后从列表移除 |
| `error` | 启动超时、启动阶段早退、致命 `ERROR:` | 显示可读原因，12s 后移除 |
| `disconnected` | `Device disconnected` 或运行中非 0 退出 | 显示「连接中断」及原因 |

阶段（`stage`）：`process` → `display`（虚拟屏已创建）→ `app`（应用启动指令）→
`video`（视频流已建立）→ `ready`（应用启动已确认）。

**不允许**仅凭 PID 判为成功：进程存在但 25s 内没有收到视频流会转为 `error` 并回收。虚拟屏模式
若只收到视频流、日志中没有 `Starting app`，会保留 `running` 但追加「未能确认应用已启动」警告。

进程退出后的状态由纯函数 `decide_exit_status` 决定：主动关闭（stopping）与运行中 code 0 视为
`stopped`；运行中非 0 视为 `disconnected`；启动阶段早退（即使 code 0）视为 `error`；已经判定为
`error/disconnected` 的状态不被后续退出码覆盖。强制结束只在警告中说明，不伪造错误原因。

## 5. 启动流程

1. 校验模式、serial、包名、尺寸（宽高 200–4096，DPI 120–640）。
2. 定位 adb / scrcpy（`TASK_DOCK_ADB` / `TASK_DOCK_SCRCPY` → `PATH` → SDK/winget 常见路径）。
3. 读取 `scrcpy --help`（缓存 10 分钟），虚拟屏模式必须有 `--new-display`。
4. `adb devices -l` 确认设备在线且已授权；使用后端选定的唯一 transport。
5. 虚拟屏模式检查应用是否有启动入口（`cmd package query-activities --brief`）。
6. 取得 `start_gate` 后检查重复/上限：同一设备+模式+应用只允许一个活动会话；默认上限 1，
   高级设置开启多屏后上限 2。
7. 创建进程与临时日志，尝试加入 Job Object；创建 stdout/stderr 日志线程与退出监控线程。
8. 三个线程**全部创建成功**才把会话登记进全局表，并立即返回 `starting`；前端轮询到
   `running/error/disconnected`。

线程与超时：

- 线程统一命名（`vd-log-out-*` / `vd-log-err-*` / `vd-wait-*`），使用固定 512KB 栈；
- 任一线程创建失败：调用方强杀刚启动的 scrcpy、删除临时日志、返回可解释错误，不登记会话；
- 启动超时 25s；早退时读取最后 4 行已脱敏日志生成可读错误；
- 停止先 `WM_CLOSE`，5s 未退出才强杀；`stop()` 只置 `stopping` 与截止时间后立即返回，
  收尾完全由 `wait_loop` 完成，不再额外创建“停止收尾线程”。

并发：

- `start_gate` 串行化「检查上限 → 启动进程 → 创建线程 → 登记会话」，避免并发点击创建多个进程；
- 全局会话表锁只在增删/遍历时短暂持有，进程启动、Job Object、线程创建都不在全局锁内；
- 每个会话独立的 `Mutex<Inner>` 保护 Child 与状态，停止 A 不阻塞查询或关闭 B。

## 6. 退出与异常

| 场景 | 行为 |
|---|---|
| 从 task_dock 关闭 | 标记 stopping → WM_CLOSE → 有界等待 → 强杀兜底 |
| 用户直接关 scrcpy 窗口 | 进程退出 → `stopped`（code 0）或 `disconnected`（非 0） |
| scrcpy 异常退出 | `error/disconnected` + 日志尾部 |
| ADB 中途断开 | 日志 `Device disconnected` → `disconnected`，后台回收进程 |
| 启动超时 | `error` + 明确原因，关闭窗口并在宽限期后强杀 |
| task_dock 正常退出 | `shutdown_all` 显式关闭本进程会话；Job Object 再兜底 |
| task_dock 被强杀 | Job Object (`KILL_ON_JOB_CLOSE`) 回收本进程创建的全部 scrcpy |

**只操作本进程创建的进程**：按会话记录的 PID 枚举顶层窗口，不按镜像名批量结束，不使用全局
`taskkill`。Job Object 创建/分配失败会在 `job_assigned=false` 与 `warning` 中明确提示：此时
task_dock 被强杀可能残留窗口，需要用户手动关闭；不会静默视为成功。

残留诊断：`vd_diagnostics` 读取设备 `dumpsys display`，报告 `virtual:com.android.shell` 且含
`scrcpy` 的显示；没有本模块活动会话时提示可能为异常残留。清理入口 `vd_reconnect` 仅在无本模块
会话时允许，执行 `adb -s <serial> reconnect`；UI 会明确告知可能中断其他 ADB 会话（包括手动
scrcpy），需用户确认。

## 7. 并发与多屏

- 默认 `max_sessions = 1`；高级选项「多屏实验模式」把上限放宽到 2（PoC 真机验证过双虚拟屏）。
- 上限与重复检查在 `start_gate` 内完成，避免重复点击/并发请求创建多个进程。
- 每个会话独立 ID、PID、模式、设备、状态、截图；关闭 A 不影响 B。前端按会话 ID 记录
  `closingIds`，允许同时关闭两个会话，而不是用单一全局“正在关闭”状态互斥。
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
- 选择稳定性：前端保存所选设备 UID；transport 轮换（mDNS 端口变化）时按 UID 重新定位，
  避免把新端口当成另一台手机。
- UI 只显示型号、在线状态、连接方式与「N 条连接已合并」；完整序列号/IP/UID/transport 只在
  折叠的「高级设置与诊断」中出现，并提供复制。未授权设备明确标记，不显示为已连接。

## 9. 应用选择

- 枚举：`pm list packages -3` + `-s` 区分用户/系统；`cmd package query-activities --brief`
  获取具备 LAUNCHER 入口的包（Android 版本不支持时回退为全部，并标记「无法判定」）。
- 默认只显示可启动应用；「显示无启动入口的应用」会附加原因并禁用选择。
- **应用元数据（2026-11-16 Round2）**：后端通过设备侧 `CLASSPATH=... app_process` 的
  PackageManager 查询批量获取应用 label 与 icon；图标由 `adb pull` 拉回，按包名扁平化缓存为
  `%TEMP%\task-dock-vd\appmeta\<设备UID>\icons\<package>.png`，前端以 data URL 渲染。
  缓存按设备 UID 隔离；设备切换、mDNS transport 轮换或应用刷新不会把上一台设备的结果混入。
- 缓存目录可能因 `adb pull` 目标已存在而被嵌套为 `icons/taskdock-appmeta/*.png`；
  `flatten_appmeta_icons()` 在每次拉取后把该层文件移动到 `icons/` 根，避免「有图标文件但全部
  回退占位」的静默缺陷。
- 实测（vivo V2323A / Android 16）：`vd_list_apps(includeAll=false)` 返回 189 个可启动应用，
  189 个 label、189 个 icon；`includeAll=true` 返回 573 个应用，573 个 label、189 个 icon，
  其余 384 个无可启动入口。样本：`com.android.settings` → 设置（iconLen 6902）、
  `com.android.chrome` → Chrome（7114）、`com.quark.browser` → 夸克（4178）、
  `dev.taskdock.mobile` → TaskDock（17146）。
- 搜索按应用名与包名实时过滤，大小写不敏感；支持中文名（设置/夸克）、英文名（Chrome）、
  完整包名与包名片段（`settings`）；无结果、加载、错误都有明确状态。
- 应用主名称作为主信息，包名作为辅助信息；无法解析 label 时回退「未知应用」+ 包名，
  不伪造本地化名称；图标失败回退 AppWindow，不让单个失败拖垮列表。
- 手动输入包名默认隐藏，展开后前后端都做字符集校验（ASCII 字母数字、`.`、`_`，不以 `-`
  开头，长度 ≤255）。
- 列表缓存 60s，按 transport + 设备身份约束；设备切换/transport 轮换时前端递增请求序号并
  丢弃迟到响应，不显示上一台设备的应用。
- **已知启动延迟**：缓存过期后 `vd_start` 仍会同步刷新全量 appmeta（约 189 个应用、408 个图标），
  真机曾出现 UI 点击到 running 约 21s；后端 scrcpy 实际就绪约 2.07s。该问题已记录在
  §14，当前构建未改成异步/快速缓存路径。
- 默认展示结构：不展开完整应用列表，只显示已选/最近使用/收藏与「浏览全部应用（189）」；
  搜索或浏览全部时才展开完整列表。

## 10. 窗口、截图与诊断

- `vd_focus`：按 PID 找可见、无 owner、非 tool window 的最大顶层窗口；恢复（最小化时）并
  `SetForegroundWindow`；返回 `found/focused`，系统拒绝前台时 UI 给出提示。
- `vd_screenshot`：仅 `running` 会话可用；`PrintWindow(PW_CLIENTONLY|PW_RENDERFULLCONTENT)`
  → BGRA → PNG；最小化时先恢复。最多 3 次有界重试（间隔 300ms），优先返回色彩信息足够的一帧；
  窗口不存在、客户区为空、`PrintWindow` 失败、`GetDIBits` 读取失败都返回可解释错误，不写空文件。
- 落盘后再次用 `png::Decoder` 解码校验宽高；0 或 >8192 拒绝。文件写入
  `%TEMP%\task-dock-vd\shots\`，同一会话只保留最近一张，会话结束/过期时删除。
- 截图质量是**启发式**：整幅同色或采样色数 < 8 时返回 `warning`，不判定失败（用户可能正在看
  纯色页面）；客户区小于 100×100 也追加尺寸警告。`warning` 会出现在预览横幅和 `VdScreenshot`
  中；前端只有浏览器实际 `load` 成功后才允许「加入暂存架 / 另存为」。
- 预览使用 asset protocol，scope 仅 `$TEMP/task-dock-vd/shots/**`。
- 保存：暂存架（`shelfAddPaths(..., "managed")`）或系统「另存为」对话框
  （`vd_screenshot_export` 复制到用户选择路径）。
- 截图只在用户点击时产生，没有后台周期截图、自动上传或画面写日志。
- **2026-11-16 真机证据**：虚拟屏 Settings 会话截图 `722×1284`，来源 `V2323A · 设置`；
  `img.complete=true`、`naturalWidth=722`、`naturalHeight=1284`；保存为暂存架 managed item
  `...\shelf\images\96536435-52a7-432c-8a14-add189ec871e.png`（169019 bytes）；PIL 读回
  mean≈247.6/247.7/248.7、std≈21.2/19.7/19.1，非空白。`vd_screenshot_export` 另存为
  722×1284 成功；源文件/目标目录不存在的错误应归因为目标目录错误，而不是导出链路缺陷。
  原生「另存为」系统对话框本身尚未点击验证（见 §14）。

## 11. 安全与隐私

- 不自动开启开发者选项/无线调试，不安装 APK，不重置 ADB 授权。
- ADB 连接拥有 shell 级调试与输入注入能力；UI 明确提示只连接信任设备。
- 设备 serial、IP transport、包名与会话只存运行期内存；日志读取会按当前 serial 做替换脱敏
  （`redact_line` → `<设备>`），诊断输出只含 display owner/类型并截断 160 字符。
- 默认 UI 不显示完整序列号/IP；高级诊断才展示，复制需用户主动点击。报告/文档不得写入真机
  完整序列号。
- 剪贴板同步默认关闭；开启时提示可能互相覆盖，不改变手机默认输入法或系统设置。
- 截图是用户主动操作；临时文件与会话同生命周期清理。

## 12. UI 与文案

- **页面级分区**：`MobileTransferPanel` 顶部二级 tab「文件互传 / 屏幕控制」，roving tabIndex，
  支持左右方向键/Home/End；只挂载当前 pane。切换不停止后端 scrcpy；重新进入屏幕控制页会
  重新拉取设备、工具链、应用与会话，不常驻后台轮询。
- **投屏面板四层**：
  1. 设备卡 + 工具链状态条（ADB/scrcpy/独立虚拟屏/设备授权 4 个 chips，可展开版本、路径、
     参数支持与安装建议）；
  2. 双模式卡片（MonitorSmartphone 手机屏幕镜像 / AppWindow 独立虚拟屏幕，含图标、说明、
     适用场景、选中勾、未支持原因与活动会话提示）；
  3. 启动配置（镜像只显示设备与按钮；虚拟屏才展开应用选择、方向/尺寸、创建按钮）；
  4. 正在运行的投屏（计数/上限、会话卡、定位/截图/关闭）与默认折叠的高级设置/诊断。
- 会话卡片标题：`设备 · 手机屏幕` / `设备 · 应用名`；无应用名时回退 `设备 · 独立虚拟屏`。
  UUID、PID、完整包名不进标题；包名只作为辅助事实。
- 应用选择：搜索名称/包名实时过滤、真实图标（失败回退 AppWindow）、用户/系统标签、
  无入口行禁用并显示原因、设备切换清空搜索并丢弃迟到响应；手动包名默认隐藏。
  默认不展开完整列表，只显示已选/最近使用/收藏与「浏览全部应用（189）」。
- 截图预览弹层显示来源会话、时间、尺寸与质量警告；提供加入暂存架/另存为/放弃。
- 响应式：以 `.mobile-body` 的**容器查询**为主，760/560/420 三档并按实际内容宽度收敛；
  2026-11-16 Round2 真机 WebView 实测内容宽度 320/360/400/480/600/768/900/1024/1280
  均无横向溢出；768 起双列，1280 时 workbench 内容上限 1180px，应用网格 3 列（约 218px/列）。
  窄窗两列改单列、会话操作换行、关闭按钮 min-width 76px、按钮最小高度 28px；弹层不超出视口。
  高度 1280×600/720/900 与 400×600 已验证页面级不横向溢出；400×600 启动配置需在
  `.mobile-body` 内部滚动，不是页面级滚动。
- 会话导航：返回、Home、最近任务**不再**作为 TaskDock 主界面的日常操作按钮；改由投屏窗口
  自带的独立控制栏承担（见 §16）。控制栏动作仍绑定当前 session ID；虚拟屏的 `recents`
  在控制栏禁用并说明原因，后端同样拒绝；Home/Back 按 Display ID 隔离。镜像模式 Recents
  作用于 Display 0。会话卡保留定位/截图/关闭与状态信息。
- 多屏实验开启时，会话区副标题按当前上限动态显示「最多同时运行 {max} 个」，与头部
  `{count}/{max}` 一致（2026-11-18 修复 P3 文案不一致）。
- 视觉只用语义 Token（`--radius-card`、`--surface-raised`、`--border-subtle`、`--shadow-raised`、
  `--status-*` 等），无硬编码颜色/裸 `z-index`；尊重 `prefers-reduced-motion`。
- 文案在 `zh-CN` / `en-US` 同步维护，键集合一致；本轮新增/修改键已逐项核对。
- 错误：命令失败走 `localizedErrorMessage`（英文界面回退通用文案）；会话 `error`/`warning`
  仍是后端中文自由文本，英文界面会保留中文技术细节（已知限制，见 §14）。

## 13. 测试与验收命令

工作目录：`D:\Develop\task_dock`

```powershell
# 前端类型与定向单测
node --max-old-space-size=3072 ./node_modules/typescript/bin/tsc --noEmit
npx vitest run src/components/mobile/VirtualDisplaySection.test.tsx src/components/mobile/MobileTransferPanel.test.tsx

# Rust 单测：必须经调度器并在 src-tauri/ 内运行
node scripts/build-sched.mjs cargo --priority P1 --label vd-rust-test -- test --lib commands::virtual_display

# cargo test --lib 的测试 exe 需要 Common-Controls v6 manifest（工装限制，不是产品代码问题）
# 编译完成后用 mt.exe 嵌入并直接运行测试二进制：
mt.exe -manifest src-tauri/tests.manifest -outputresource:<target>/debug/deps/task_dock_lib-*.exe;#1
# 例：Rust 25 例通过的命令见本轮报告 §10.2 / §14 证据

# 真机联调（显式启用；需 adb 设备在线，会真实启动/关闭 scrcpy 窗口）
$env:TASK_DOCK_VD_LIVE = "1"
node scripts/build-sched.mjs cargo --priority P1 --label vd-live -- test --test virtual_display_live -- --nocapture

# 构建
npm run build
```

Rust 单测覆盖：ADB 输出解析、mDNS serial 提取、设备去重（USB/直连/mDNS、同型号不合并）、
包名校验、尺寸校验、模式校验、可启动组件解析、scrcpy 日志信号、参数构造、状态辅助函数、
退出状态与强制结束警告、像素分析、PNG 校验、线程创建失败、缺失 scrcpy 启动失败、日志脱敏、
不存在窗口截图错误。

前端单测覆盖：页面级功能切换与重新挂载、空设备/未授权/工具链缺失、默认镜像与切虚拟屏、
应用名称/包名搜索与无结果、无入口禁用原因、手动包名校验、选择应用创建（标题不含包名）、
镜像创建、定位/截图预览/存暂存架/另存为、关闭中状态、高级折叠/诊断/重连/多屏开关、
多设备迟到响应丢弃、应用加载态、卸载不关闭会话与重挂载重读。

真机联调（`virtual_display_live`）覆盖：工具链/设备探测、可启动应用枚举、非法包名/尺寸拒绝、
镜像启动→就绪→定位→截图（校验画面非空白）→重复启动拦截→关闭回收、虚拟屏启动→就绪→截图、
双虚拟屏并发（第二个可启动应用存在时）、单独关闭其中一个且另一个保持运行。

真机人工验收仍需覆盖：鼠标点击/滑动、手机实体触控、中英文输入法、旋转/缩放、锁屏/解锁、
窗口定位手感、截图存入暂存架、设备断开后的状态恢复、页面切换与重新进入。
**jsdom/单测不能替代真机；编译成功也不能替代真机功能通过。**

## 14. 已知限制与未验证项

| 项 | 状态 |
|---|---|
| 启动配置缓存刷新延迟 | 2026-11-18 已修复：`vd_start` 只读现有缓存做「已知无入口」校验，应用名称/图标/入口在后台线程刷新，不再阻塞投屏启动 |
| 页面切换后的配置保持 | 2026-11-18 已修复：投屏模式/应用/尺寸/多屏与剪贴板开关提升到 `useVirtualDisplayStore`，按物理设备 UID 恢复，页面卸载不清除 |
| 多屏副标题 | 2026-11-18 已修复：会话区副标题按当前上限动态显示（最多同时运行 {max} 个） |
| 投屏控制栏原生验收 | 控制栏窗口/外置与内置位置/全屏触发带/多显示器/100–200% DPI/品牌图标与 AUMID 需要真实 scrcpy 窗口验证；本机无 Android 设备，记 `ENVIRONMENT BLOCKED`（见 §16） |
| `recents` 错误语义 | 虚拟屏 Recents 返回 `SERVICE_UNAVAILABLE` 且 `retryable=true`；不可重试能力标为可重试（P2 语义瑕疵） |
| 原生「另存为…」对话框 | 后端 `vd_screenshot_export` 已实测成功；UI 按钮的原生系统文件对话框尚未实际点击（P3 证据不足） |
| Windows 系统 DPI | 仅在当前 125% 缩放环境实测；100%/150%/200% 未逐个切换验证（不能等效推断） |
| 页面缩放 | 浏览器 80%/100%/125%/150% 的布局矩阵未执行（P3 证据不足） |
| 1440/1920 内容宽度 | 侧栏 + 上下文栏上限使 1920 物理窗口的 `.mobile-body` 为 1386px；1440/1920 **内容宽度**未单独制造，当前 workbench 上限 1180px，1920 超宽空余由上下文栏占用；不能声称 1440/1920 内容密度已验收 |
| 原生完整窗口截图 | Tauri 主窗口在特殊 HWND/前台锁状态下 PrintWindow 只截到细条；可靠证据为同一实例的真实 WebView CDP 页面截图；完整原生窗口截图证据不足 |
| 窗口定位前台 | `vd_focus` 返回 `found=true, focused=false`，toast 提示系统未允许切换前台；属 OS 前台锁，非确定代码缺陷 |
| 设备断开恢复 | 未主动断开共享真机；断线后的状态恢复未验证（不伪造） |
| 文件互传联动 | 仅完成页面视觉回归；真实上传/下载/配对/暂存箱联动未执行 |
| 应用真实图标 | 已实现并从真机缓存 408 个 PNG；但 384 个无可启动入口应用无图标，回退占位，这是能力边界不是破图 |
| 英文界面的后端自由文本 | 会话 `error/warning` 为中文技术文案；命令错误可本地化，会话详情不翻译 |
| 长时稳定性 / 内存增长 | 未验证（PoC 只做短时观察） |
| 锁屏/息屏下虚拟屏行为 | 未验证（需用户配合解锁） |
| 物理触控与电脑操作并发 | 用户此前人工补测过同时触控；本轮未重复 |
| 同应用双实例 | 证据不足（Android 任务复用行为因应用而异） |
| 其他厂商/机型 | 仅 vivo V2323A / Android 16 验证过 |
| 多屏长时资源 | 未做受控基准 |
| 横屏虚拟屏 | `1920x1080/384` 已在 scrcpy 参数层实测（2026-11-14，日志与窗口截图）；应用内该选项未做独立真机回归 |
| 截图 | PrintWindow 对 GPU 画面/受保护窗口可能失败；刚就绪的首帧可能只有背景层，`vd_screenshot` 有 3 次有界重试；纯色/低信息量只给警告，无法保证“画面一定是应用内容” |
| 无线 ADB transport 轮换 | 已按 UID 保持选择；端口变化时仍需真机确认 UI 选择与 `vd_start` serial 一致 |
| 设备切换/清空应用列表 | 前端按请求代次丢弃迟到响应已有单测；本轮未用两台真机做 UI 级设备切换复验 |

## 15. 变更记录

- 2026-11-14：从 MVP（单虚拟屏 + 包名列表）升级为双模式会话服务；新增状态机与日志就绪
  判定、设备身份去重、可启动应用枚举、应用名记忆、窗口定位、截图、残留诊断、多屏实验开关；
  关闭不再持有全局锁等待；Job Object 分配失败显式告警；新增 `tests.manifest` 使集成测试
  exe 自动带 Common-Controls v6 清单；`cargo test --lib` 产生的单测 exe 仍按
  [docs/TESTING.md](../TESTING.md) §「测试 exe 清单」用 `mt.exe` 补嵌（Cargo 只对集成测试
  应用 `rustc-link-arg-tests`，属工装限制，不是产品代码问题）。
- 2026-11-14（验收补丁）：修复 `virtual_display_live` 未实际编译通过的 `String`/`&str` 调用与
  截图断言（改为解码 PNG 校验采样颜色数，避免把空白帧当成功）；`build_args` 单测改用绝对
  不存在的 scrcpy 路径，避免本机 PATH 命中已安装 scrcpy 导致断言随环境漂移；截图命令增加
  3 次有界重试以跳过虚拟屏首帧背景层。
- 2026-11-16（产品化重构）：
  - **页面信息架构**：手机互传拆为「文件互传 / 屏幕控制」二级 tab，只挂载当前 pane；切换不停止
    会话，重新进入重新读取真实状态；不再把完整投屏表单堆在文件列表底部。
    `VirtualDisplaySection` 从 1100 行单文件重写为编排器，新增 7 个 `virtual-display/` 子组件。
  - **控制面板**：设备卡 + 工具链 chips、双模式语义卡片、精简启动配置、活动会话卡、默认折叠的
    高级设置与诊断、截图预览弹层；会话标题规则改为设备+模式/应用名，不用包名；应用搜索
    名称/包名实时过滤并绑定设备 UID，手动包名默认隐藏。
  - **后端可靠性**：新增 `start_gate` 串行化创建；stdout/stderr/wait 三个后台线程全部成功才
    登记会话，失败即强杀进程并删除日志；删除独立 stop 收尾线程，改由 `wait_loop` 依据
    `kill_deadline` 完成 WM_CLOSE→有界等待→强杀；`stop()` 立即返回不阻塞其他会话；退出状态
    由 `decide_exit_status` 纯函数统一。
  - **截图有效性**：`WindowCapture` 携带尺寸与采样信息；新增 `analyse_bgra`、
    `capture_warning`、`verify_png_file`；纯色/低信息量只返回警告，PNG 落盘后解码校验；
    会话结束则删除截图并返回 Conflict。前端在图片实际加载成功后才允许保存。
  - **会话操作**：前端用 `closingIds` 支持两个会话独立关闭；关闭按钮不再全局互斥。
  - **窄窗与状态细节**：≤760px 时工作台根网格不再使用持久化导航列宽，手机互传页激活时
    对齐到导航真实的 56px；320/400px 下投屏面板宽度为 242/318px 且无横向溢出。启动按钮在
    达到会话上限时显示「会话已达上限」，不再与「已就绪」重复；会话关闭按钮使用语义错误色
    描边，与定位/截图区分。
  - **测试**：前端 20 例（17+3），Rust 新增启动失败/日志脱敏/无窗口截图/线程失败等单测；
    `virtual_display_live` 扩展双虚拟屏并发与单独关闭断言。
  - **文档**：本节与 §1–§14 按代码现状改写；未验证项与英文自由文本限制保留在 §14。
- 2026-11-16（Round2 真机验收补充）：
  - **真实应用元数据**：`fetch_app_meta` 从设备侧 PackageManager 获取 label/icon；修复
    `adb pull` 嵌套目录导致图标全部回退的缺陷（`flatten_appmeta_icons`）。真机 189 个可启动
    应用 189 label/189 icon，573 个全部应用 573 label/189 icon。
  - **应用选择器**：默认只显示最近使用/收藏与「浏览全部应用（189）」，不默认展开 189 行；
    搜索实测中文名、英文名、完整包名、包名片段、无结果与手动包名校验均通过。
  - **导航隔离**：会话级返回/Home/最近任务按钮；虚拟屏 Recents 前后端禁用，Home/Back 按
    Display ID 隔离；镜像 Recents 返回 Display 0。详见验收报告。
  - **响应式与截图**：真实 WebView 内容宽度 320–1280 矩阵无横向溢出；高度 600/720/900
    与 400×600 内部滚动已验证；虚拟屏截图 722×1284 存暂存架与导出均成功。
  - **未修复项**：启动前 appmeta 缓存刷新延迟、页面切换后配置重置、多屏副标题文案、
    Recents 错误语义；系统 DPI/页面缩放/1440/1920 内容宽度与原生另存为对话框仍未验证。
  - **文档**：§1、§9、§10、§12、§14 按真机证据更新；没有把未验证项写成通过。
- 2026-11-18（投屏窗口伴随系统）：
  - **主界面与投屏窗口职责分离**：会话卡移除返回/Home/最近任务，新增独立控制栏窗口
    （`ProjectionToolbar` + `toolbar.html`），动作全部经 Session 层并复用 `vd_nav` /
    `vd_screenshot`；不再有全局 activeSession / killAllScrcpy 路径。
  - **窗口跟随**：`projection_window.rs` 以 session_id 为键登记 scrcpy HWND 与 Toolbar HWND；
    普通窗口外置（右→左→下→上→内部），最大化/全屏内置底部居中；全屏默认隐藏，
    鼠标进入底部触发带显示、离开延迟隐藏，锁定后不自动隐藏；DPI 与显示器工作区参与计算。
  - **品牌化**：统一 `TaskDock · 设备 · 模式/应用` 标题；Windows 标题栏/Alt+Tab/任务栏图标
    使用内嵌投屏专用图标 `icons/projection.ico`（`WM_SETICON`；源图 `projection-1024.png`，
    与主程序图标区分），窗口 AUMID 固定 `TaskDock.Projection`。
  - **性能与状态**：`vd_start` 不再同步等待 appmeta；页面切换不再重置模式/应用/尺寸/多屏配置；
    多屏副标题与实际上限一致。
  - **证据**：Rust 16 例（几何/DPI/绑定/幂等/可见性）+ 既有 25 例通过；前端新增 21 例通过；
    `npm run build` exit 0（含 `toolbar.html`）；typecheck exit 0。无 Android 设备，控制栏
    真实窗口、全屏触发、多显示器与品牌图标未做原生验收，记 `ENVIRONMENT BLOCKED`。

## 16. 投屏窗口控制栏与品牌化（2026-11-18）

### 16.1 职责边界

```
TaskDock 主窗口（工作台）
  └─ 手机互传 / 屏幕控制页
       └─ Session 管理（启动、状态、截图、关闭、诊断）
            └─ scrcpy 独立窗口  ← 画面与输入
            └─ TaskDock Toolbar 窗口（每个 Session 一个）← 返回/Home/最近任务/截屏/锁定/更多
```

- TaskDock 主窗口只负责「管理投屏会话」，不再承担手机日常导航；控制栏窗口负责「操作手机」。
- 控制栏不是静态 UI 覆盖层：它是 Tauri 独立窗口（`toolbar.html`），带 `WS_EX_TOOLWINDOW`
  与不可聚焦样式，不进 Alt+Tab/任务栏，点击不抢 scrcpy 键盘焦点。
- 所有控制以 **session_id** 为唯一键。禁止 `get_active_device` / 全局最近会话 / 按设备名查找。

### 16.2 生命周期

| 时机 | 行为 |
|---|---|
| `vd_start` 成功 | 后台线程等待 Session `running` 且 scrcpy HWND 存在（上限 30s），登记绑定 → 品牌化 → 创建控制栏 → 启动 watcher → `toolbar_state=ready` |
| 启动期窗口未找到 | 回滚到降级：`toolbar_state=unavailable` + warning；scrcpy 继续可用，会话卡提供「重试控制栏」 |
| 控制栏创建失败 | 同上，不让会话进入未知状态；不伪造 ready |
| 普通窗口 | watcher 每 120ms 只检查本 Session；状态不变不调用 `SetWindowPos`；外置优先右侧 |
| 最大化 | 控制栏进入窗口内部底部居中（工作区内） |
| 全屏 | 内部底部居中；默认隐藏；鼠标进入屏幕底部 28 逻辑 px 触发显示；离开 1.2s 后隐藏；锁定后常显 |
| 窗口移动/缩放/跨屏 | 重新读取 HWND 矩形、显示器工作区与 DPI，重算位置；DPI 100/125/150/200% 均按逻辑尺寸 × 缩放 |
| `vd_stop` / Session 结束 | 停 watcher → 销毁控制栏窗口（`destroy`）→ 移除注册表；幂等，可重复调用 |
| 应用退出 | `shutdown_all` 先清理全部控制栏，再收 scrcpy |

### 16.3 控制栏内容

- 竖向（普通窗口）：返回、Home、最近任务、更多、截屏、锁定、关闭。
- 横向（最大化/全屏）：同一组按钮横向排列。
- 「更多」展开当前 Session 信息（模式/状态/分辨率/应用/Display ID）与截图、诊断、关闭动作；
  展开只扩大控制栏窗口，不改变控制栏自身的锚点。
- 最近任务在虚拟屏（display_id > 0）下 disabled 并给出原因，绝不发送 IPC。
- 锁定状态持久在 Rust 注册表，由 watcher 决定全屏是否自动隐藏；前端只做状态镜像。
- 截屏复用 `vd_screenshot` 的 Android 投屏截图链路（新增 `vd_toolbar_screenshot` 仅做广播），
  不截 HWND，避免黑屏/遮挡/Toolbar 入镜。

### 16.4 品牌化

- `build_projection_window_title` 是唯一标题生成函数：`TaskDock · 设备型号 · 屏幕镜像` /
  `TaskDock · 设备型号 · 应用名`。
- `apply_taskdock_window_identity`：`SetWindowTextW` + `WM_SETICON(ICON_BIG/ICON_SMALL)`
  + `IPropertyStore::SetValue(PKEY_AppUserModel_ID, "TaskDock.Projection")`。
  AUMID 字符串必须用 `SHStrDupW`（CoTaskMem）分配，`SetValue`/`Commit` 完成后再
  `PropVariantClear` 释放；**不可**用 Rust 堆内存或提前 `CoTaskMemFree`，否则属性系统
  按 `CoTaskMemFree` 清理时会触发 `0xc0000374` 堆损坏（2026-11-18 真机修复）。
- 图标优先从二进制内嵌的 `icons/icon.ico` 解析（最大尺寸给 ICON_BIG、最接近 32px 给
  ICON_SMALL），失败才回退 `ExtractIconExW`；失败只追加 warning，不阻断投屏。
- 必须真机检查标题栏、Alt+Tab、任务栏三处；jsdom/单测不能替代。

### 16.5 性能

- `vd_start` 只读应用缓存做快速校验，不触发 appmeta 的 push/pull；缓存缺失时启动后后台刷新，
  失败不影响投屏。
- watcher 是每 Session 一个有界线程，只在几何/模式/可见性变化时写窗口；没有 16ms 全局轮询。
- 控制栏窗口随 Session 创建/销毁，闲置会话不保留 watcher。

### 16.6 已知风险与未验证

- 本机 `adb devices` 无设备：控制栏真实窗口、外置/内置位置、全屏触发、多显示器、
  100–200% DPI、图标与 AUMID 均**未做原生验收**，记 `ENVIRONMENT BLOCKED`。
  （2026-11-18 真机补测结果见 §16.7；多显示器、100/150/200% DPI 与双设备仍未覆盖。）
- 控制栏使用 topmost 窗口以覆盖 scrcpy 全屏；用户切换到其他应用时控制栏仍可能悬浮在
  最上层（与 scrcpy 窗口生命周期绑定，Session 关闭即销毁）。原生验收时需确认是否可接受。
- `vd_screenshot` 仍基于 `PrintWindow`，GPU/受保护窗口可能失败；无障碍/触摸注入仍需真机。

### 16.7 真机验收补记（2026-11-18，vivo V2323A）

真机（无线 ADB，scrcpy 5.0.1，单显示器 2048×1152，DPI 125%）在隔离数据目录的 debug
实例上完成以下原生验证（Win32 句柄/矩形/样式为证据，截图受透明窗口与遮挡影响仅作辅助）：

| 项目 | 结果 |
|---|---|
| 普通窗口外置 | 通过：控制栏 56×300 位于 scrcpy 右侧 8px、垂直居中 |
| 拖动跟随 | 通过：scrcpy 移到 (300,120) 后控制栏同步到 (784,502) |
| 缩放跟随 | 通过：scrcpy 600×800 时控制栏随右边缘/垂直中心更新 |
| 最大化内置 | 通过：控制栏切为 300×56 横向，位于窗口底部居中 |
| 恢复外置 | 通过：恢复后回到右侧竖排 |
| 全屏默认隐藏 | 通过：F11 全屏（style=0x0、覆盖显示器）后控制栏 `IsWindowVisible=false` |
| 底部触发显示 | 通过：光标进入底部触发带后控制栏显示 |
| 延迟隐藏 | 通过：光标离开触发带 4s 后隐藏 |
| 锁定不隐藏 | 通过：锁定后光标离开仍显示；取消锁定后恢复延迟隐藏 |
| 不抢焦点 | 通过：点击控制栏「返回」前后前台窗口始终为 scrcpy |
| 导航动作 | 通过：手机从短视频收藏页返回推荐页 |
| 品牌标题/图标 | 通过：`TaskDock · V2323A · 屏幕镜像`、`TaskDock · 投屏控制栏`；`WM_GETICON` 句柄非零 |
| 生命周期 | 通过：关闭会话后 scrcpy 退出、控制栏销毁、应用存活；再次启动创建新控制栏且无残留 |
| 切页配置保持 | 通过：虚拟屏模式经「文件互传」往返后仍选中 |

同轮发现并修复：品牌化设置 AUMID 时提前释放 `CoTaskMem` 导致创建控制栏后进程
`0xc0000374` 堆损坏；改为 `SHStrDupW` + `Commit` 后 `PropVariantClear` 后，连续两次
启动/关闭会话均稳定。**仍受环境限制未验证**：跨显示器（本机仅 1 台显示器）、
DPI 100%/150%/200%（当前 125%）、双设备控制栏隔离（仅 1 台设备）、AUMID 的任务栏
分组表现、Home/最近任务/截屏/更多按钮的逐项真机点击。

## 17. 投屏窗口一体化重构（2026-11-19，取代 §16 的独立控制栏方案）

> 本节推翻 §16 的「独立 ToolWindow 置顶控制栏」设计：§16 记录保留作为历史，
> 其中「独立窗口/外置定位/全屏自动隐藏/锁定」行为自本节起**不再存在**。

### 17.1 新窗口结构（方案 A，真机 PoC 验证）

```
scrcpy 顶层窗口（WS_OVERLAPPEDWINDOW，品牌化标题/图标/AUMID 不变）
  └─ TaskDock 导航 WebView（toolbar.html，attach 阶段转 WS_CHILD + 跨进程 SetParent）
       ├─ Side/Compact：右缘导航列（Side 落在右侧 letterbox，Compact 悬浮于视频之上）
       └─ Bottom：底部导航条（窗口高度由布局吸附）
```

- P0#1/#2/#3 消除：导航栏与手机画面同属一个顶层 HWND，其他窗口遮挡投屏时导航栏
  一起被遮挡，最小化/恢复同步；不再有 `WS_EX_TOPMOST` 独立导航窗口。
- 一体化的实现要点：`win::attach_as_child`（剥离 TOPMOST/NOACTIVATE/popup/caption →
  WS_CHILD + SetParent + SWP_FRAMECHANGED）；attach 失败降级为「无控制栏」并告警，
  绝不回退到独立置顶窗口。
- 生命周期红线：`vd_stop` / 会话结束**先销毁子窗口再停 scrcpy**（父窗口销毁会连带
  销毁跨进程子窗口，顺序反了会留下被系统强拆的孤儿）。

### 17.2 布局系统（`projection_layout.rs` 纯函数 + 集成测试 10 例）

- `calculate_projection_layout(window_size, video_size, dpi, capabilities, constraints)
  → { video_rect, navigation_rect, layout_mode }`；模式判定 Side → Bottom → Compact
  （`should_use_side_layout` / `should_use_bottom_layout` 带迟滞系数 0.96）。
- Side：ClientRect 宽度吸附为「视频宽 + 2×导航 WebView（含 Tooltip 溢出区）」，
  scrcpy 居中渲染，导航列落在右侧 letterbox，**永不遮挡视频**；
- Bottom：宽度不足时高度吸附为「视频高 + 2×底部条带」（居中口径下视频恰好贴条带顶）；
- Compact：宽高都受限时导航列悬浮在视频右缘，视频不再被压缩；
- 视频尺寸在挂载时从 scrcpy 初始 ClientRect 捕获（此刻 ClientRect == 视频纵横比），
  旋转时由 watcher 识别「非本进程发起的外框变化」重新捕获（最大化状态除外）。
- 实测基线：V2323A（1080×2400）@125% DPI，scrcpy 初始 client 577×1282 = 视频精确
  纵横比（0.450），**基线无空余宽度**——可用空间由布局主动扩展（任务书 P0#4 前提
  在基线不成立，已在方案中改为主动扩展）。

### 17.3 导航栏与 Tooltip（`projection-controls/`）

- 尺寸规范：按钮 52×52、图标 20、内边距 12、间距 8、列宽 88（逻辑 px，`projection-sizes.ts`
  与 Rust 常量同源；`getNavigationButtonSize/getNavigationContainerSize/getNavigationSpacing`）。
- **图标方向保持既有实现**（ArrowLeft/Home/List），本轮未改方向/语义。
- 一级行 = 返回 / Home / 最近任务 / 截屏 / 更多；**删除锁定按钮**（自动隐藏已随一体化
  删除）与一级 ✕（与原生窗口关闭重复）；「更多」= 会话信息 + 诊断 + 结束投屏，
  由 `getProjectionToolbarActions / filterDuplicateProjectionActions / getSecondaryProjectionActions`
  按真实能力生成。
- Tooltip：`ProjectionTooltipLayer`（WebView 内绝对定位层，pointer-events:none 永不拦截
  点击）；显示延迟 350ms / 隐藏 120ms；`resolveTooltipSide` 边缘自动翻转 + `calculateTooltipPosition`
  钳制进视口；键盘 Focus 与 disabled 原因（虚拟屏最近任务）同样显示；深浅主题走语义 Token。
- 事件协议变更：`vd-toolbar-state` 载荷改为 `{ window_mode, layout_mode, dpi_scale, session_id }`
  （旧 mode/locked/expanded/visible 停用）。

### 17.4 会话隔离与派发

- `vd_projection_dispatch(session_id, action)`：统一入口，先校验（会话运行中 + 控制栏已
  挂载），再复用 `vd_nav`；`resolve_projection_session(hwnd)` 按 HWND 反查 Session；
  `validate_projection_session` 多会话隔离防线；导航能力限制不变。
- `vd_projection_identity(session_id)`：回读标题/WM_SETICON 大小图标/AUMID 三项，
  供真机验收与诊断（`apply_projection_window_identity` / `validate_projection_window_identity`）。

### 17.5 验证状态（如实记录）

- 单元/集成：`cargo test --test projection_layout` 10/10 通过；lib 内 projection_window
  测试编译通过（运行受仓库级 0xC0000139 问题阻塞，见报告）；vitest 控制栏 15/15、
  controller 8/8、mobile 批次 55/55 通过；typecheck 0 错误；`npm run build`（含
  toolbar.html）与 `cargo build` 经调度器 exit 0。
- 真机 PoC（2026-11-18 23:15，方案可行性）：跨进程 SetParent 挂载成功、子窗口渲染正常、
  覆盖窗口时导航栏随父窗口消失（遮挡同步）、CDP 页面内点击交互正常。
- **正式真机验收 ENVIRONMENT BLOCKED**（2026-11-19 01:20）：Android 设备 TLS 断连
  （`adb devices` 列表为空），且本机存在其他会话的 task-dock 实例（r9pkg release）。
  待设备恢复后按 §16.5 同口径补做：遮挡同步、Tooltip 逐按钮、布局三模式、双会话
  隔离、`vd_projection_identity` 三项回读。
