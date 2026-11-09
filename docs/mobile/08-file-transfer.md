# 手机文件互传 v1（2026-11-09）

> 状态：**双向文件传输已实现并在真机验证**（2026-11-09，vivo V2323A / Android 16）。
> 分块加密、分块重试、完成校验与删除闭环；后台续传、多设备并发队列、iOS 仍未实现。

## 1. 范围与入口

| 已实现（v1） | 未实现（下一轮） |
|---|---|
| 电脑 → 手机：桌面选择文件、手机下载到用户选定目录 | 后台/断点续传、多文件并发（当前严格串行） |
| 手机 → 电脑：系统文件选择、分块上传、落盘到应用数据目录 | iOS 接收目录（SAF 为 Android 专属） |
| 分块加密（XSalsa20-Poly1305）、AAD 绑定文件与序号 | 传输限速、流量统计、失败自动重试队列 |
| 完成后 SHA-256、大小、分块数校验 | 电脑端自动加入文件暂存架（当前手动「在文件夹中显示」） |
| 记录删除与磁盘副本清理；启动清理半成品 | 文件预览/缩略图 |

入口：
- 桌面端：设置 → 手机与同步 → 文件互传（发送文件 / 打开接收文件夹 / 记录列表）。
- 手机端：设置 → 手机与同步 → 文件互传（接收位置、电脑上的文件、手机上的文件、发送文件）。

## 2. 存储与数据表

桌面端根目录：`data_dir/mobile_files/`

| 子目录 | 用途 |
|---|---|
| `outbox/` | 桌面端提供给手机下载的副本（发送时复制，原文件变动不影响已提供内容） |
| `inbox/` | 手机上传完成后落盘的文件 |
| `tmp/` | 上传中的 `{id}.part` 半成品；进程启动时整体清理 |

SQLite 迁移 **v45** 新增 `mobile_files`：

```sql
CREATE TABLE mobile_files (
  id TEXT PRIMARY KEY NOT NULL,
  device_id TEXT NOT NULL DEFAULT '',
  direction TEXT NOT NULL CHECK (direction IN ('to_phone', 'to_desktop')),
  name TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size > 0),
  sha256 TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'failed')),
  stored_path TEXT NOT NULL DEFAULT '',
  chunk_size INTEGER NOT NULL,
  chunks INTEGER NOT NULL,
  received_chunks INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
```

- `stored_path` 只在桌面进程内使用，**不序列化给手机**；桌面 UI 通过命令定位文件。
- `mobile_files` 已登记 `backup::is_local_transient_table`：备份只写空 section，
  恢复忽略，避免把指向本机路径的记录迁移到另一台机器。
- 手机端不新增 SQLite 表：文件列表每次从桌面拉取，接收目录 URI 存 kv
  （`files.save_dir.v1`）。

## 3. 协议与端点

所有端点与同步接口共用 Bearer 设备令牌与同一把派生密钥
（`SHA-512("taskdock-sync-v1:" + SHA-256(token))[0..32]`）；请求/响应都是
`{v,n,d}` 加密信封，明文内嵌 AAD（方法 + 完整路径）。

| 方法 | 路径 | 请求 data | 响应 data |
|---|---|---|---|
| GET | `/v1/files` | — | `{ files: [...] }` |
| POST | `/v1/files` | `{ name, size }` | `{ file }` |
| GET | `/v1/files/{id}/chunk/{index}` | — | `{ index, data: base64 }` |
| POST | `/v1/files/{id}/chunk/{index}` | `{ data: base64 }` | `{ file }` |
| POST | `/v1/files/{id}/complete` | `{}` | `{ file }` |
| POST | `/v1/files/{id}/delete` | `{}` | `{ deleted: true }` |

AAD：
- 列表：`taskdock-sync-v1|GET|/v1/files`
- 创建：`taskdock-sync-v1|POST|/v1/files`
- 分块：`taskdock-sync-v1|{GET|POST}|/v1/files/{id}/chunk/{index}`
- 完成：`taskdock-sync-v1|POST|/v1/files/{id}/complete`
- 删除：`taskdock-sync-v1|POST|/v1/files/{id}/delete`

把分块密文换到另一个文件或另一个序号会因 AAD 不匹配而解密失败；跨端点重放同理。

## 4. 分块、上限与校验

- 单文件上限 **200 MB**，空文件拒绝；分块明文 **192 KB**。
- 请求体上限：分块 512 KB（base64 + 信封余量），其余 JSON 1 MB / 4 KB。
- 上传只接受「下一块」（`index == received_chunks`）或「上一块重写」
  （`index + 1 == received_chunks`）；后者用于手机端超时重试的幂等补偿。
  跳块返回 `409 conflict`，长度不符返回 `400 invalid_request`。
- 完成时校验：`received_chunks == chunks`、文件大小 == 声明大小、计算 SHA-256，
  然后 `tmp/{id}.part` 原子改名到 `inbox/{id}-{name}`。
- 记录删除只允许删除 `mobile_files` 根目录内的普通文件；符号链接、越界路径与
  非普通文件一律拒绝。手机端只能删除自己的上传或任意 `to_phone` 记录。

## 5. 手机端实现

- 选文件：`expo-file-system` 58 的 `File.pickFileAsync({ multipleFiles: true })`
  （Android `ACTION_OPEN_DOCUMENT`），不需要 `expo-document-picker`。
- 读分块：`File.open(FileMode.ReadOnly)` + `FileHandle.readBytes`，循环补齐；
  单次上传最多 20 个文件，严格串行。
- 接收目录：`Directory.pickDirectoryAsync()`（`ACTION_OPEN_DOCUMENT_TREE`，
  持久化 URI 授权），URI 存 kv；首次下载未选择时现场弹出。
- 写分块：`Directory.createFile(name, mimeType)` + `File.open(FileMode.WriteOnly)`；
  SAF `content://` 不支持 `ReadWrite`，下载只使用写模式。失败/取消时**先关句柄再删半成品**：
  SAF 在文件句柄未关闭时 `delete()` 会失败（真机实测），顺序反了会在用户目录留下
  大小不对的文件。
- 打开文件：`File.preview()` 交给系统查看器；不使用 `expo-sharing`。
- 取消：`client.cancel()` 只中止在途请求；分块之间可能恰好没有请求在飞，下一块会
  重新发起并继续传输（真机实测）。因此 `FilesScreen` 额外持有 `cancelRequested`，
  `fileIo` 在每块前后检查它；命中后抛 `FILE_CANCELLED_MESSAGE`，走半成品清理。
  桌面端半成品由手机端失败清理或桌面启动恢复清除。
- 布局：主操作固定在底部操作区，列表再长也不用滚到底；传输中同一位置切换为
  「已传字节 / 总字节 + 百分比 + 取消」，进度不随列表滚走。列表按「来自电脑 /
  发往电脑」分组，行内是扩展名色块 + 名称/大小/时间 + 主操作 + 删除图标；
  ready 用中性色，只有接收中（琥珀）与失败（红）上色。320dp 窄屏隐藏 ready
  状态胶囊，把宽度让给文件名与时间。支持下拉刷新。
- 文件名：`expo-file-system` 的 `File.name` 只取 URI 末段；vivo 文件管理器返回
  `document:<数字>` 而不是显示名，`uploadDisplayName()` 识别这种值后回退为
  `手机文件-YYYYMMDD-HHmmss.<扩展名>`（扩展名由 MIME 推断）。AOSP 路径式 URI 不受影响。

## 6. 安全边界

- 业务数据（文件名、大小、分块内容）全部在加密信封内；HTTP 头、端点、时间、
  请求大小仍可见（与同步 v1 相同的可信局域网假设）。
- 令牌只进 `Authorization` 头；桌面端只存 SHA-256 哈希，`stored_path` 不下发。
- 文件名在落盘前清洗：取末段、替换 Windows 非法字符、去尾部点/空格、
  规避 `CON`/`NUL`/`COM1` 等保留名，长度上限 120 字符。
- 上传临时文件只在 `tmp/`；完成前不可下载（`read_chunk` 只接受 `to_phone` 且 `ready`）。
- 日志只记录错误类别与计数，不记录文件名、路径、令牌或分块内容。

## 7. 已知限制

1. 无断点续传：进程/网络中断后重新从第一块开始（桌面端启动会清理半成品）。
2. 严格串行：同一时刻只跑一个传输，批量文件逐个执行。
3. 无文件类型限制与病毒扫描；接收目录由用户显式选择，桌面端接收目录固定在应用数据目录。
4. 200 MB 上限由手机端 JS 加密与内存约束决定；更大文件需要流式加密改造。
5. 电脑 → 手机只对 `ready` 记录可见；删除记录会同时删除磁盘副本，手机端未下载的文件
   将无法再获取。
6. iOS 未实现（接收目录选择依赖 Android SAF）。
7. vivo 文件管理器不返回原显示名：上传文件使用时间戳回退名，需在桌面重命名；
   AOSP 选择器返回路径式 URI 时可保留原名。

## 8. 验收

| 项 | 通道 | 结果 |
|---|---|---|
| Rust 数据层单测（分块/重试/完成校验/路径安全/恢复/设备隔离） | A | **9/9 PASS** |
| 桌面端前端类型检查 | A | `npx tsc --noEmit` exit 0 |
| 移动端类型检查 | A | `npx tsc --noEmit` exit 0 |
| 协议级上传/下载/删除（Node 加密客户端 → 隔离桌面端） | C | **20/20 PASS** |
| 手机端真机上传/下载/打开/删除（vivo V2323A） | D | **PASS**：640B 下载内容一致、54B 上传 SHA-256 一致、删除后桌面 0 行且目录为空 |
| 手机端 UI 真机走查（vc18） | D | **PASS**：空态、分组列表、2.4MB 下载进度、640B 打开、20MB 上传（底部进度 93% / 第 1/1 个）、取消后 SAF 半成品删除、桌面 inbox SHA-256 一致 |
| 最终 APK | — | 0.1.6 / versionCode 18，arm64-v8a，sha256 `605cbc8a…`，非 debuggable，覆盖安装后配对保持 |

真机条件与截图见 `tmp/acceptance/mobile-file-transfer/report.md` §5；
本轮 UI 走查与取消修复见 `tmp/acceptance/file-transfer-ui/report.md`。

证据与命令见 `tmp/acceptance/mobile-file-transfer/`。

## 变更记录

- 2026-11-09 首版：双向分块传输、v45 `mobile_files`、桌面设置页文件列表、
  手机文件互传页；明确断点续传、并发队列与 iOS 未实现。
- 2026-11-09 真机验收：vivo V2323A / Android 16 完成 640B 下载（SAF + 阅读器）、
  54B 上传（SHA-256 一致）、删除清理；发现 vivo 选择器返回 `document:<id>` 作为文件名，
  增加 `uploadDisplayName` 回退；最终 APK 0.1.6/vc13 sha256 `6356f581…`。
- 2026-11-09 UI 优化：手机端改为底部固定操作区（发送 / 传输进度 + 取消）、按方向分组、
  扩展名色块、状态只对接收中/失败上色、字节进度、下拉刷新与分方向空态；桌面端设置页
  文件列表按方向分组，增加状态胶囊与空态说明，窄窗隐藏 ready 胶囊并压缩间距。
  验证见 `tmp/acceptance/file-transfer-ui/report.md`。
- 2026-11-09 UI 真机走查与修复（vc18）：vivo V2323A 验证空态、列表、下载进度、打开、
  20MB 上传与取消。发现并修复 3 个真实问题：接收位置卡片在 `GlassCard` 纵向容器里
  「更改」掉行；取消只在 `client.cancel()` 时中止在途请求，分块之间会继续下载；
  SAF 半成品在句柄未关闭时删除失败。修复后 100MB 下载取消，半成品文件被删除，
  桌面 inbox 收到的 20MB 上传文件 SHA-256 与手机源文件一致。最终 APK
  0.1.6/vc18 sha256 `605cbc8a…`。
