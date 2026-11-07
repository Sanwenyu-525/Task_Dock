# 资源管理与智能清理

更新日期：2026-11-06

## 范围与状态

资源管理是完整面板左侧的**常驻一级导航入口**（`resource`，位于「设置」上方，`locked` 不可隐藏/排序）。页面按需读取应用缓存、应用自身 CPU/内存/运行时长、系统内存、所在磁盘概览与应用数据占用分布，并提供只读进程诊断与可测量的应用内存缓存释放。所有采样由页面进入或点击刷新触发，不增加后台扫描器或常驻定时器。

页面内分四个分区（不是四个一级导航）：

| 分区 | 数据来源 | 说明 |
|---|---|---|
| 概览 | `resource_snapshot` + 最近一次磁盘扫描 | 磁盘总量/已用/剩余、应用缓存、可安全清理量、系统内存、应用内存与 CPU、采样时间 |
| 磁盘 | `resource_cleanup_preview` / `resource_cleanup_execute` / `resource_disk_usage` | 三个固定清理类别（扫描→选择→确认）+ 应用数据目录的只读占用分布 |
| 内存 | `resource_snapshot` + `resource_process_diagnostics` + `resource_memory_catalog` / `resource_memory_release` | 系统/应用/WebView2 子进程内存口径 + 可回收缓存目录与真实释放 |
| 进程 | `resource_process_diagnostics` | 本应用、子进程、项目开发进程、外部工具、归属不明；可按 CPU/内存排序 |

设置页「数据与资源 → 资源管理」只保留一个入口卡片（标题 + 一句说明 + 「打开资源管理」），点击切换到资源管理 Tab；设置页不再内嵌完整页面。分区首次访问才挂载并请求，来回切换不重复采样；页面卸载后忽略在途响应，无定时器与轮询。

指标含义与边界：

- **应用缓存**：`AudioService` 语音缓存 + 剪贴板/暂存架缩略图 + 暂存架 `.part` 残留的已知总量；任一来源读取失败即整体标记 `partial`/`unavailable`，不把不完整统计当作完整值。
- **可安全清理量**：只来自「磁盘」分区最近一次扫描的预览合计；未扫描时显示「扫描后显示」，打开页面不会自动扫描，也不把 0 当成可清理量。
- **应用 CPU**：`GetProcessTimes` 内核 + 用户态累计时间的两次差分，按整机逻辑核心容量折算（0–100%）。冷启动无基线时，后端在 blocking worker 内做一次约 200 ms 的短窗口采样并返回真实值；响应中的 `process.cpuWindowMs` 即该窗口。低值只代表窗口内占用低，不代表进程无活动。
- **应用内存 / 运行时长**：工作集与私有字节来自 `GetProcessMemoryInfo`，运行时长来自进程创建时间；读取失败显示「未知」。
- **系统内存**：`GlobalMemoryStatusEx` 的物理内存总量与可用量。整机口径，已与应用自身指标分栏展示；不从可用内存推算「可以释放多少」。
- **WebView2 子进程**：进程诊断中 `managed_child` 且名称匹配 `msedgewebview2` 的行，工作集之和；共享页可能重复计数，界面明确标注只作规模参考。
- **磁盘**：应用数据目录所在卷的可用/总容量（`GetDiskFreeSpaceExW`）；「已用」= 总量 − 可用，与「Task Dock 缓存总量」「可清理量」分栏展示，三者不混用。
- **数据更新时间**：后端返回的 `sampledAt` 本地时间；缺失时显示「数据更新时间未知」。刷新失败会清空旧值，不把过期指标当作当前状态。

后端固定三个清理类别：`temporary`、`tts`、`orphan_thumbnails`。`temporary` 仅扫描暂存架 `files/`、`images/`、`thumbs/` 中由应用生成的规范 UUID `.part` 原子写入残留；只将超过 24 小时且身份可验证的文件列为候选，较新的文件显示为受保护。Agent spool、备份恢复、用户偏好与其他来源不进入清理白名单。

## 应用数据占用分布（只读）

`resource_disk_usage` 只统计应用自己的目录，不递归整个磁盘、不进入用户目录、不跟随符号链接或 reparse point：

| 条目 | 路径 | 归属 |
|---|---|---|
| `tts_cache` | `audio-cache/tts`（便携）或 `app_cache_dir/audio/tts`（安装） | `regenerable` |
| `clipboard_images` / `clipboard_thumbs` | `clipboard/images`、`clipboard/thumbs` | `persistent` |
| `shelf_files` / `shelf_images` / `shelf_thumbs` | `shelf/*` | `persistent` |
| `agent_inbox` | `agent-inbox` | `persistent` |
| `backups` | `backups` | `persistent` |
| `diagnostics` | `diagnostics` | `persistent` |
| `database` | `task-dock.db` + `-wal` / `-shm` | `persistent` |

上限：单次最多检查 20,000 个条目、3 秒预算、递归深度 6；超限返回 `truncated` 与 `partial`，数值只代表已检查子集。`persistent` 类别在界面上没有删除入口；清理只发生在三个可清理类别的预览与确认之后。

## 内存管理（可测量、可验证）

只有本进程自己持有、且可按需重建的缓存才进入可释放目录：

| 来源 | 内容 | 重建方式 |
|---|---|---|
| `tts_memory` | 合成语音内存缓冲（`MemCache`，上限 16 条 / 8 MB / 5 分钟 TTL） | 再次合成时自动重建；磁盘 TTS 缓存不受影响 |
| `app_icons` | 应用图标内存缓存（data URL，上限 512 条） | 下次请求图标时重新提取 |

边界（产品硬约束，均有单测/代码约束）：

- 不调用 `EmptyWorkingSet` / `SetProcessWorkingSetSize` 等工作集裁剪，不强制 GC、不清系统文件缓存、不结束任何进程；
- 释放只清空缓存副本：正在播放/返回中的语音由 `Arc` 单独持有，不会中断；
- 释放前后按同一口径统计，`releasedBytes` 是实际释放量；没有可释放对象时只显示「当前没有可安全释放的应用缓存」，不显示无操作的按钮；
- 释放后重新读取目录并刷新页面快照（工作集与缓存都可能变化）。

## 目录归属与分类

| 类别 | 归属与扫描范围 | 删除边界 |
|---|---|---|
| `temporary` | 暂存架 `files/`、`images/`、`thumbs/` 直接子项中规范 UUID 命名的 `.part` 文件 | 仅处理应用生成命名，常规文件、边界内路径、身份可验证且超过 24 小时的文件；通过 Shelf 独占文件闸确认没有活跃 producer；不扫描 `.tmp`、子目录或其他模块 |
| `tts` | `AudioService` 管理的本地 `audio/tts` 缓存目录 | 仅接受服务 Key 文件名和本服务 `.tmp-*` 命名；临时残留须已超过 24 小时；与合成、预生成、读取及语音设置清理共用 AudioService 缓存锁 |
| `orphan_thumbnails` | 剪贴板和暂存架各自的 `thumbs/` 直接子项 | 仅接受规范 UUID `.png`；剪贴板引用查 `clipboard_assets.path`，暂存架引用查 `shelf_items` 中的图片条目 ID；绝不扫描 `images/` 或 `files/` |

不扫描 `%TEMP%`、用户原文件、下载目录、回收站、Agent 会话/事件、备份恢复文件、工作流数据、语音包导入文件或构建缓存。不得把相似扩展名当作所有权证明。

## 命令与预览生命周期

数据流为 `ResourceCleanupSection → bridge.ts → Tauri commands/resource_cleanup.rs → ResourceCleanupState`。四个命令为 `resource_snapshot`、`resource_cleanup_preview`、`resource_cleanup_execute`、`resource_process_diagnostics`。前端只传固定类别和服务端生成的 `previewId`，不传删除路径；日志不记录候选路径。

- 预览只读；后端保存候选身份，5 分钟过期，最多保留 32 个预览，并在后续请求时回收过期记录。
- 预览与执行共用非阻塞作业闸；并发请求返回 `CLEANUP_BUSY`，不会排队启动第二个清理作业。
- 执行只接受当前预览中已扫描的类别；预览一次性消费，过期、重复或越权类别请求被拒绝。
- 每个来源目录最多检查 10,000 个条目，并在条目间检查 5 秒扫描预算。达到上限返回 `partial` / `SCAN_LIMIT_REACHED`；展示的候选量与字节只是已检查子集，不冒充完整目录统计。单次阻塞的文件系统调用本身无法被此预算强制中断。
- 报告分别返回估算字节与实际释放字节；仅成功标记并删除的文件计入释放量。缺失、变更、被引用、占用或路径不安全的文件不会计为成功；类别失败不会阻止其他安全独立类别。

## 进程诊断（只读）

定位是轻量诊断，不是任务管理器替代品：

- **只读**：不结束、不挂起、不修改任何进程；没有自动结束外部进程的入口，也不在后台常驻 `watch-dev-processes.ps1`。
- **按需**：`resource_process_diagnostics` 只在用户点击「查看开发相关进程」或刷新时调用一次；前端不轮询，卸载时忽略在途响应。
- **不读取命令行**：归属判定只使用 PID、父进程链、可执行文件镜像路径；镜像路径不返回前端、不写日志。
- **有界**：进程表快照最多 4096 项，指标候选最多 120 个，返回行最多 40 行，超出时 `truncated=true` 并在界面提示「仅显示前 N 个」。

归属分级（`association` + `associationBasis`）：

| 分级 | 判定证据 | 界面文案 |
|---|---|---|
| `self` | 当前进程 PID | 本应用 |
| `managed_child` | 父进程链可达本应用 | 应用子进程 |
| `project_dev` | 镜像路径位于工程目录内；或父链上存在本应用/工程进程 | 项目开发进程 |
| `external_tool` | 名称匹配已知开发工具，但镜像路径不在工程目录内 | 外部开发工具 |
| `unknown_owner` | 名称像开发工具但无法读取路径；或路径在工程内但不是已知工具名 | 归属不明 |

进程名、项目路径或父进程 PID 匹配只作**关联线索**，不直接判定所有权；工程目录匹配仅在开发构建中启用（`CARGO_MANIFEST_DIR`，release 构建不含开发者路径）。

状态（`status`）只表达可解释的观察结果：

- `normal`：指标可读且窗口内 CPU 低于阈值；
- `high_usage`：窗口内 CPU ≥ 70%（整机核心口径）——仅提示占用较高，不代表异常，也不建议结束进程；
- `exited`：进程在采样期间已退出；
- `unknown`：进程存在但指标无法读取（权限/受限进程）。

非 Windows 平台返回 `supported: false`，界面明确提示「当前平台暂不支持进程诊断」，不伪造空列表。

## 图表口径与阈值（2026-11-06）

资源管理页面采用「图表 + 数值」仪表盘，图表全部是 React + CSS/原生 SVG 静态绘制，不引入图表库、不使用 Canvas 循环或常驻动画。

统一计算在 `src/lib/resourceMetrics.ts`（有 18 条纯函数用例）：

- 磁盘/系统内存使用率：`(total - available) / total * 100`，总量必须 > 0 且有限，结果限制 0–100；
- 未知/非法输入（null、NaN、Infinity、负数、总量 0）返回 `unknown`，界面显示「暂不可用」，**不当成 0%**；
- 可用量异常大于总量时按已用 0 处理，不出现负使用率；
- 展示保留一位小数，环形弧度与中心百分比使用同一个数值；
- 阈值集中配置：`<80%` 正常（青绿）、`80–<90%` 关注（琥珀）、`>=90%` 紧张（红），文字状态同步显示，不只靠颜色；
- 颜色为 `.resource-page` 作用域的语义 Token（`--chart-track`、`--chart-c1..c8`），深色主题有独立取值。

口径边界：

| 图表 | 分母 | 说明 |
|---|---|---|
| 概览磁盘环形 / 磁盘页横向条 | 卷总容量 | 整机口径；与「应用缓存总量」「可清理量」分栏，不混用 |
| 概览内存环形 / 内存页横向条 | 系统物理内存总量 | 整机口径，文案明确写「系统物理内存」 |
| 应用数据占用分布 | 已统计的 Task Dock 应用数据总量（`resource_disk_usage.totalBytes`） | 不是整盘文件类型分布；`truncated`/`partial` 时标注「仅已扫描部分」 |
| 可回收缓存来源占比 | 两项可回收缓存之和 | 不代表系统内存占用来源 |
| 进程 CPU 条 | 接口返回的整机核心归一化百分比 | 单次采样观测，不作为异常结论 |
| 进程内存条 | 当前列表中的最大工作集 | 只表达相对长度，标注「不是系统内存占比」 |

工作集 / 私有内存 / WebView2 子进程是三个不同口径，页面并列展示，不做合计 100% 的堆叠图。

内存释放文案为「已清空 N 应用内存缓存」，并说明「物理内存变化由操作系统与运行时管理，不保证立即下降相同容量」；不调用工作集裁剪、不强制 GC、不结束进程。

刷新作用域：页头「刷新」= 重读系统快照 + **当前分区**的专属数据（磁盘分布 / 内存目录 / 进程列表），隐藏分区不会被连带重扫；清理完成只额外刷新磁盘分布；进程列表仍保留自己的「刷新进程列表」。

## 并发与文件安全

- Shelf 的添加 producer 持有共享 `CopyGate` 许可直到文件及缩略图写入、数据库登记完成；资源清理与 `shelf::cleanup_expired` 获得同一闸的独占维护许可。维护请求遇到活跃 producer 时快速返回 `CLEANUP_BUSY`，维护期间新的写入等待。
- 剪贴板缩略图预览和执行持有既有 `ClipboardRuntime.capture_gate`，并检查活跃粘贴；资源执行顺序为采集闸 → Shelf 文件闸 → 数据库 → 文件系统。
- 缩略图删除使用 SQLite `BEGIN IMMEDIATE` 保留写入权，事务内重新检查引用，再验证文件属性、大小、修改时间和文件身份，避免扫描后新增引用导致误删。
- Shelf 的历史 `purge_orphan_files` 同样要求两组引用查询完整；任一查询失败立即返回错误。生产调用方持有 Shelf 独占文件闸；每个候选删除前还在 writer 事务中复查其 `managed_path` 或图片条目引用。
- Windows 通过 `OPEN_REPARSE_POINT` 检查路径，拒绝 reparse point、目录和叶文件替换；按卷序列号/文件索引、大小、修改时间与完整最终路径复核。删除期间持有候选直接父目录（应用管理类别目录）的不共享写入/删除句柄，叶文件句柄拒绝所有共享句柄，并对同一句柄设置删除标记。父目录重命名定向测试通过；应用类别目录上方的祖先目录未被锁定，不宣称覆盖所有命名空间竞态。忙碌句柄跳过，其他 OS 错误按失败报告。
- 非 Windows 构建不执行文件删除，保守返回 skipped。句柄和命名空间保证依赖 Windows 文件系统语义；网络/特殊文件系统若不能打开并校验类别目录和叶文件，也会跳过。未宣称覆盖所有可能的文件系统内部竞态。
- 所有清理作业在 Tauri blocking worker 执行；不在 WebView 主线程扫描目录。

## 验收与限制

核心测试位于 `src-tauri/src/resource_cleanup/`（含 `probes.rs` 真机只读探针与 `diagnostics.rs` 归属分级）、`src-tauri/src/fs_safety.rs`、`src-tauri/src/audio/cache.rs` 和 `src-tauri/src/shelf/tests.rs`；前端用例在 `ResourceCleanupSection.test.tsx`、`SettingsPanel.test.tsx`、`AudioSettings.test.tsx`。用例覆盖预览过期/单次消费、并发作业闸、临时文件所有权与年龄、扫描上限、引用查询失败与复查、同路径替换、打开文件占用、Shelf producer/maintenance 互斥、父目录重命名防护、CPU 归一化、归属分级（自身/子进程/路径锚点/名称线索/未验证路径）与候选数量上限。测试结论以当次 Windows Cargo 输出为准。

清理功能的验收报告与原始命令日志位于 `tmp/acceptance/resource-cleaner/`；资源管理 UI 补全的验收产物位于 `tmp/acceptance/resource-management-ui/`。Cargo 定向测试通过自动化用例锁定；真实 Tauri 窗口下的浅/深主题、320/400 窄窗、高 DPI 走查以验收报告记录的命令与截图为准，自动化 DOM 测试不替代该证据。共享工作树的其他模块测试编译错误可能阻断测试，具体命令与退出码以验收报告记录为准。

已知限制：

- 不提供执行中取消：删除按候选逐个进行，单个文件操作会安全结束；界面不显示无法兑现的取消按钮。
- 归属判定不读取命令行、不解析 PEB 工作目录；无法读取镜像路径的进程归为「归属不明」，不做更激进的猜测。
- 进程列表把整机范围内的已知开发工具名一并列出（标注为外部开发工具），不声称它们与本项目有关。
