# 资源管理与智能清理

更新日期：2026-11-06

## 范围与状态

资源管理位于「设置 → 资源管理」。面板按需读取应用缓存、系统内存和所在磁盘概览；内存指标暂返回未知（`null`）。资源扫描由用户触发，不增加后台扫描器或常驻定时器。

后端固定三个类别：`temporary`、`tts`、`orphan_thumbnails`。`temporary` 仅扫描暂存架 `files/`、`images/`、`thumbs/` 中由应用生成的规范 UUID `.part` 原子写入残留；只将超过 24 小时且身份可验证的文件列为候选，较新的文件显示为受保护。Agent spool、备份恢复、用户偏好与其他来源不进入清理白名单。

## 目录归属与分类

| 类别 | 归属与扫描范围 | 删除边界 |
|---|---|---|
| `temporary` | 暂存架 `files/`、`images/`、`thumbs/` 直接子项中规范 UUID 命名的 `.part` 文件 | 仅处理应用生成命名，常规文件、边界内路径、身份可验证且超过 24 小时的文件；通过 Shelf 独占文件闸确认没有活跃 producer；不扫描 `.tmp`、子目录或其他模块 |
| `tts` | `AudioService` 管理的本地 `audio/tts` 缓存目录 | 仅接受服务 Key 文件名和本服务 `.tmp-*` 命名；临时残留须已超过 24 小时；与合成、预生成、读取及语音设置清理共用 AudioService 缓存锁 |
| `orphan_thumbnails` | 剪贴板和暂存架各自的 `thumbs/` 直接子项 | 仅接受规范 UUID `.png`；剪贴板引用查 `clipboard_assets.path`，暂存架引用查 `shelf_items` 中的图片条目 ID；绝不扫描 `images/` 或 `files/` |

不扫描 `%TEMP%`、用户原文件、下载目录、回收站、Agent 会话/事件、备份恢复文件、工作流数据、语音包导入文件或构建缓存。不得把相似扩展名当作所有权证明。

## 命令与预览生命周期

数据流为 `ResourceCleanupSection → bridge.ts → Tauri commands/resource_cleanup.rs → ResourceCleanupState`。三个命令为 `resource_snapshot`、`resource_cleanup_preview`、`resource_cleanup_execute`。前端只传固定类别和服务端生成的 `previewId`，不传删除路径；日志不记录候选路径。

- 预览只读；后端保存候选身份，5 分钟过期，最多保留 32 个预览，并在后续请求时回收过期记录。
- 预览与执行共用非阻塞作业闸；并发请求返回 `CLEANUP_BUSY`，不会排队启动第二个清理作业。
- 执行只接受当前预览中已扫描的类别；预览一次性消费，过期、重复或越权类别请求被拒绝。
- 每个来源目录最多检查 10,000 个条目，并在条目间检查 5 秒扫描预算。达到上限返回 `partial` / `SCAN_LIMIT_REACHED`；展示的候选量与字节只是已检查子集，不冒充完整目录统计。单次阻塞的文件系统调用本身无法被此预算强制中断。
- 报告分别返回估算字节与实际释放字节；仅成功标记并删除的文件计入释放量。缺失、变更、被引用、占用或路径不安全的文件不会计为成功；类别失败不会阻止其他安全独立类别。

## 并发与文件安全

- Shelf 的添加 producer 持有共享 `CopyGate` 许可直到文件及缩略图写入、数据库登记完成；资源清理与 `shelf::cleanup_expired` 获得同一闸的独占维护许可。维护请求遇到活跃 producer 时快速返回 `CLEANUP_BUSY`，维护期间新的写入等待。
- 剪贴板缩略图预览和执行持有既有 `ClipboardRuntime.capture_gate`，并检查活跃粘贴；资源执行顺序为采集闸 → Shelf 文件闸 → 数据库 → 文件系统。
- 缩略图删除使用 SQLite `BEGIN IMMEDIATE` 保留写入权，事务内重新检查引用，再验证文件属性、大小、修改时间和文件身份，避免扫描后新增引用导致误删。
- Shelf 的历史 `purge_orphan_files` 同样要求两组引用查询完整；任一查询失败立即返回错误。生产调用方持有 Shelf 独占文件闸；每个候选删除前还在 writer 事务中复查其 `managed_path` 或图片条目引用。
- Windows 通过 `OPEN_REPARSE_POINT` 检查路径，拒绝 reparse point、目录和叶文件替换；按卷序列号/文件索引、大小、修改时间与完整最终路径复核。删除期间持有候选直接父目录（应用管理类别目录）的不共享写入/删除句柄，叶文件句柄拒绝所有共享句柄，并对同一句柄设置删除标记。父目录重命名定向测试通过；应用类别目录上方的祖先目录未被锁定，不宣称覆盖所有命名空间竞态。忙碌句柄跳过，其他 OS 错误按失败报告。
- 非 Windows 构建不执行文件删除，保守返回 skipped。句柄和命名空间保证依赖 Windows 文件系统语义；网络/特殊文件系统若不能打开并校验类别目录和叶文件，也会跳过。未宣称覆盖所有可能的文件系统内部竞态。
- 所有清理作业在 Tauri blocking worker 执行；不在 WebView 主线程扫描目录。

## 验收与限制

核心测试位于 `src-tauri/src/resource_cleanup/`、`src-tauri/src/fs_safety.rs`、`src-tauri/src/audio/cache.rs` 和 `src-tauri/src/shelf/tests.rs`；前端用例在 `ResourceCleanupSection.test.tsx`、`AudioSettings.test.tsx`、`SettingsPanel.test.tsx`。用例覆盖预览过期/单次消费、并发作业闸、临时文件所有权与年龄、扫描上限、引用查询失败与复查、同路径替换、打开文件占用、Shelf producer/maintenance 互斥和父目录重命名防护。测试结论以当次 Windows Cargo 输出为准。

本轮验收报告与原始命令日志位于 `tmp/acceptance/resource-cleaner/`。真实 Tauri 窗口下的浅/深主题、窄窗、高 DPI 和系统层交互仍需 Windows 原生走查；自动化 DOM 测试不替代该证据。共享工作树的其他模块测试编译错误可能阻断 Cargo 测试，具体命令与退出码以验收报告记录为准。
