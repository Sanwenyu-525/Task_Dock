# 04 · 监听、平台适配与隐私安全

> 代码位置：`src-tauri/src/clipboard/platform.rs`、`engine.rs`、`mod.rs`
> 唯一触碰 Win32 剪贴板的模块是 `platform.rs`；其余模块只处理数据。

## 一、监听实现

采集链路分为三个线程，消息线程只做入队：

| 线程 | 职责 |
|---|---|
| `clipboard-monitor` | 消息专用窗口（`HWND_MESSAGE`）+ `AddClipboardFormatListener` + `GetMessage`；收到 `WM_CLIPBOARDUPDATE` 只把序列号/时间戳放入有界事件队列 |
| `clipboard-capture` | 合并事件（只处理最新序列号）→ 读取剪贴板 → 标记/来源/敏感过滤 → 图片 PNG 编码 → 放入有界内容队列 |
| `clipboard-worker` | 内容入库（SQLite、资产落盘）、自动分组、广播 `clipboard-changed` |

- 事件驱动，不轮询；停止时 `RemoveClipboardFormatListener` + `DestroyWindow` + `PostQuitMessage`。
- 事件队列容量 64（丢弃最旧，`dropped_events` 计数）；内容队列容量 8 条且 ≤128 MB
  （丢弃最旧，`dropped_contents` 计数）。事件合并只保留最新序列号（`merged_events` 计数），
  避免处理过期的中间快照。
- Windows 剪贴板内容**不可重放**：被丢弃的事件无法补读当时内容；这是有界内存的明确代价，
  通过计数暴露，不宣称零丢失。
- 每次事件重新读取设置，暂停/停用立即生效。
- 读取失败（剪贴板被占用）使用 10 次 × 12 ms 的 `OpenClipboard` 重试；
  仍失败计入 `skipped`（原因“剪贴板被其他程序占用”），不记录、不崩溃。
- 单条内容处理用 `catch_unwind` 隔离；解析/入库 panic 只计入 `failed`，不终止线程。
- 监听启动失败只记录警告并降级（`monitoring=false`），不阻塞应用启动。

诊断：`clipboard_status.monitor` 返回 `observed_events`、`merged_events`、`captured`、
`recorded`、`duplicates`、`skipped`、`dropped_events`、`dropped_contents`、`failed`、
`peak_event_queue`、`peak_content_queue`、`max_capture_latency_ms`、
`max_process_latency_ms` 与队列容量；只含计数，不含任何剪贴板内容。

## 二、读取的格式与优先级

| 格式 | 处理 |
|---|---|
| `CF_HDROP` | 文件列表，解析宽字符路径，最多 200 条；优先级最高 |
| `PNG`（注册格式） | 直接解码 RGBA；文件大小 ≤64 MB |
| `CF_DIBV5` / `CF_DIB` | 无 PNG 时解码 DIB（支持自底向上/自顶向下、BI_BITFIELDS），转 PNG |
| `HTML Format` | 提取 `StartFragment`/`EndFragment` 片段；头部损坏时从第一个 `<` 退化提取；≤512 KB |
| `CF_UNICODETEXT` | UTF-16 → UTF-8，去除结尾 NUL；≤512 KB |

类型判定（`engine::classify`）优先级：**files > image > URL > html > text**。
URL 判定：`http://` / `https://`、无空白、≤4096 字符、不含引号/尖括号。
纯空白内容不记录。

混合内容处理：

- 同时存在文件与文本时按**文件**记录（文件列表是主要语义）。
- 图片与文本同时存在时按**图片**记录（保留截图主内容）。
- HTML 与文本同时存在时按 HTML 记录，纯文本作为回退/搜索内容保留。
- 不识别/无法安全解析的私有格式不记录（宁可缺失，不存乱码）。

## 三、写入

`platform::write_payload` 支持：

- **Text**：`CF_UNICODETEXT`；若有 HTML，同时写 `HTML Format`（自动生成 CF_HTML 头，
  含 `StartHTML/EndHTML/StartFragment/EndFragment` 字节偏移）。任一格式成功即视为写入成功。
- **Image**：优先写 PNG 注册格式；同时写 `CF_DIB`（由 RGBA 或 PNG 解码生成），
  兼容只认 DIB 的传统应用。
- **Files**：`CF_HDROP`（宽字符路径，绝对路径且存在，≤200 条），辅助写纯文本路径；
  文件格式成功即视为成功。

写入返回 `GetClipboardSequenceNumber()`，调用方记入 `self_write`。
`OpenClipboard` 失败返回“剪贴板被其他程序占用，请稍后重试”。

## 四、自我写入隔离

问题：应用自身复制条目 / 逐项粘贴会触发监听，产生自记录。

两层防护：

1. **序列号隔离**：写入后保存序列号到 `Arc<AtomicU32>`；监听事件序列号
   ≤ 该值时跳过（监听处理函数保留序列号参数用于该判断）。
2. **来源应用过滤**：读取后若来源 exe 等于当前进程 exe，直接跳过。

即使粘贴队列连续写入，也不会生成“无穷自记录”。

## 五、隐私控制

### 系统/应用敏感标记

读取前检查：

- `ExcludeClipboardContentFromMonitorProcessing`
- `Clipboard Viewer Ignore`
- `CanIncludeInClipboardHistory = 0`

命中任一即跳过，日志只写“系统或应用标记：不参与剪贴板监听”，不含内容。
这覆盖 Windows 常见的密码管理器/浏览器隐私标记，但**不能保证**所有应用都会设置。

### 高置信敏感特征过滤（默认开启）

`engine::sensitive_reason` 只匹配高置信模式：

- PEM 私钥头（`-----BEGIN ... PRIVATE KEY-----`）；
- AWS Access Key（`AKIA` + 16 位大写字母数字）；
- GitHub Token（`ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_` + 36 位）；
- Slack Token（`xoxb-`/`xoxa-`/`xoxp-`/`xoxr-`/`xoxs-` + 片段）。

命中后整条内容不记录，日志只写原因。**明确不宣称**能识别全部密码、验证码、
银行卡号或自定义令牌；需要更强保护时应关闭监听或使用应用排除名单。

### 来源推断与未知来源

- 来源应用是**推断值**：采集时读取前台窗口的进程 exe，不保证等于实际复制该内容的程序
  （复制动作可能来自后台程序、脚本、远程会话，或前台窗口已切换）。
- 读取不到或为空时记为 `unknown`，界面显示“未知来源”，不猜测、不冒充。
- 来源未知且敏感过滤开启时，额外启用保守凭据模式（`password=…`、`Authorization: Bearer/Basic`、
  JSON 凭据字段），命中整条跳过；来源已知时不启用该保守模式，避免误伤普通文本。
- 高置信模式（私钥/AWS/GitHub/Slack Token）与来源无关，始终过滤。
- 来源仅用于展示、排除名单与审计，不作为安全边界；用户不应把“来源显示为某应用”当作
  内容可信的证明。

### 应用排除名单

- 设置项 `clipboard_exclude_apps`：逗号/分号/换行分隔的 exe 名，可写完整路径；
  比较时统一取 basename（大小写不敏感），因此 `C:\Tools\KeePass.exe` 与 `keepass.exe` 等价。
- 读取后按来源 exe 文件名精确匹配；命中跳过。
- 来源应用来自前台窗口的进程 exe（`navigation::window_manager::exe_path_of`）。
- 排除名单不是安全边界：只覆盖能推断出来源的应用；无法识别来源的复制不受其保护，
  此时应使用全局暂停/停用。

### 全局暂停与停用

- `clipboard_enabled=false`：监听线程仍在，但事件处理直接返回（不读取、不记录）。
- `clipboard_paused=true`：临时暂停，保留总开关偏好；界面显示“已暂停”。
- 抽屉状态区分：已停用 / 已暂停 / 监听未启动 / 监听中。

### 日志与错误

- 采集日志：`kind`、字节数、是否新建、是否分组；**不含正文**。
- 跳过日志：原因（系统标记/排除名单/敏感特征），不含内容。
- 错误日志：`AppError` 文本；不拼接剪贴板正文。
- 粘贴日志：状态、已发送/总数、跳过数、是否恢复；不含每个条目的正文。
- Agent 导出只在本地写文件，日志记录数量/目录，不上传。

## 六、大小与资源边界

| 限制 | 值 | 超限行为 |
|---|---|---|
| 单条文本/HTML | 512 KB | 监听读取直接跳过（超限不记录）；入库前按 UTF-8 边界截断 |
| 单张图片 | 64 MB | 不记录 |
| 文件数 | 200 | 截断到前 200 |
| 缩略图 | 最长边 192 px | 区域平均缩放 |
| 自动分组条目 | 300/组 | 下一张截图开新组 |
| 事件队列 | 64 条 | 丢最旧并计数（`dropped_events`） |
| 内容队列 | 8 条 / 128 MB | 丢最旧并计数（`dropped_contents`） |
| 采集队列日志/诊断 | 只含计数 | 不记录正文/路径/图片 |

读取时 `read_handle` 复制句柄内存；图片解码失败则回退 DIB；仍失败则不记录。
快照只保留一份当前剪贴板内容（内存中），不落库，不做无限缓存。
内容队列的字节上限按文本/HTML/预览/来源/文件路径/图片 RGBA 估算，
保证极端连拍时内存有上界。

## 七、非 Windows 降级

`#[cfg(not(windows))]` 提供编译桩：

- `read_clipboard` 返回 `Empty`；`snapshot` 无 payload；
- `write_payload` / `send_ctrl_v` 返回明确错误；
- `ClipboardMonitor::start` 返回错误，运行时 `monitoring=false`。

界面不会伪装监听可用；跨平台构建仅保证编译与明确降级。

## 八、已知限制（诚实记录）

1. 无法读取所有私有剪贴板格式（如部分 Office 专有格式、设计软件内部对象）；
   这些内容不会进入历史。
2. 敏感过滤基于固定模式，**不保证**识别全部密码/令牌；这是设计边界，不是缺陷隐瞒。
3. 系统标记依赖来源应用主动设置；未设置的应用无法被自动识别为敏感。
4. 剪贴板被其他程序长时间独占时可能读取失败，该次复制不记录。
5. 大图片（接近 64 MB）解码会占用相应内存；已通过上限约束，但瞬时内存仍可能较高。
6. 文件条目记录的是路径，不复制文件内容；原文件移动/删除后条目仍在，但复制会跳过或报错。
7. 高频复制可能触发有界队列丢弃（事件或内容）；Windows 剪贴板不可回放，
   被丢弃的内容不会出现在历史中，只能通过 `clipboard_status.monitor` 的计数发现。
8. 来源是前台窗口推断值，可能不准确；来源未知时按更保守的凭据模式过滤，但仍不保证识别全部敏感内容。
9. 监听已暂停/停用期间发生的复制不会补录；恢复后只记录新事件。
