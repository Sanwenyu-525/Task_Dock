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
- **配置 fail-closed**：每次采集前重新调用 `Settings::load_clipboard`。键缺失沿用默认
  （兼容旧库）；JSON 损坏、类型错误、数值越界或数据库读取失败返回 `ClipboardConfigError`，
  本次事件不读取剪贴板、不入库，日志按 60 秒限频记录（只含键名与错误类别，不含值）。
  监听线程本身保持运行，用户在设置中修复后可继续，不需要重启应用。

### 事件处置与去重水位（第四轮整改）

采集线程对每条事件先做**处置判定**，再决定是否读取剪贴板。判定函数
`platform::classify_event(event_sequence, last_captured, self_write)` 是纯函数，
返回三种结果：

| 判定 | 条件 | 计数器 | 是否读取剪贴板 |
|---|---|---|---|
| `SelfWrite` | 事件序列号命中本进程写入水位（回绕安全） | `self_write_events` | 否 |
| `Superseded` | 事件序列号不晚于**读取水位**（`last_captured`） | `superseded_events` | 否 |
| `Read` | 其余情况 | `captured`（读成功）/ `empty_events`（读为空） | 是 |

要点：

- 去重水位取自**读取时刻**的序列号，而不是事件通知时刻的序列号。事件通知与真正读取
  之间内容可能被覆盖，按事件序列号去重会把同一份剪贴板状态记两遍（并抬高 `copy_count`），
  按读取水位去重则保证「一份剪贴板状态只入库一次」。
- **自写判定先于覆盖判定**：自写通知既可能被水位覆盖，也可能是更早的重复通知；
  先判自写才能把「本进程自己写的」与「用户重复复制」在计数器里分开归因。
- 读取结果为 `ClipboardRead::Empty`（内容已被其它程序清空或不可解析）时计入
  `empty_events` 并记录日志，不入库、不崩溃——此时用户内容已被覆盖，不可恢复。
- 判定结果全部有计数器，**没有静默丢弃路径**；这是第四轮整改的直接动因：
  整改前 `observed_events` 与 `captured` 的差额无法解释，验收中无法判定是
  「被丢弃」还是「被记录」。

诊断：`clipboard_status.monitor` 返回 `observed_events`、`merged_events`、`captured`、
`recorded`、`duplicates`、`skipped`、`dropped_events`、`dropped_contents`、`failed`、
`self_write_events`、`superseded_events`、`empty_events`、
`peak_event_queue`、`peak_content_queue`、`max_capture_latency_ms`、
`max_process_latency_ms` 与队列容量；只含计数，不含任何剪贴板内容。

计数可对账（第四轮新增，用于验收核对）：

```
observed_events = dropped_events + merged_events + superseded_events
                + self_write_events + captured + empty_events + skipped
```

- `observed_events`：监听线程收到的 `WM_CLIPBOARDUPDATE` 通知数。
- `dropped_events`：事件队列溢出被丢弃的最旧事件数。
- `merged_events`：队列合并时被丢弃的中间事件数（只保留最新序列号）。
- `skipped`：判定为需要读取、但因配置 fail-closed 或剪贴板被占用而未读取的事件数。
- `captured`：成功读取到内容的事件数（`recorded`/`duplicates` 是入库阶段的另一层计数）。

第四轮真机验收实测：`observed_events 10 = captured 5 + self_write_events 5`，
`superseded_events 0`、`empty_events 0`、`dropped_events 0`、`merged_events 0`、`skipped 0`，
完全对账——这在整改前是不可能做到的（当时存在无计数、无日志的静默丢弃路径）。

## 二、读取的格式与优先级

| 格式 | 处理 |
|---|---|
| `CF_HDROP` | 文件列表，解析宽字符路径，最多 200 条；优先级最高 |
| `PNG`（注册格式） | 直接解码 RGBA；文件大小 ≤64 MB。全透明 PNG（Windows 由 32bpp BI_RGB DIB 合成）按“不使用 Alpha”改写为不透明并重编码，避免保存/粘贴出全透明图 |
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

问题：应用自身复制条目 / 逐项粘贴 / 恢复快照都会触发监听，产生自记录；若只提高
去重阈值，用户随后复制的相同内容会被误判为重试而丢失 `copy_count`，因此不做阈值掩盖。

实现（两类写入统一登记）：

1. **锁内原子登记**：所有自写——单项复制、整组富文本/文件复制、逐项粘贴、恢复——
   都在进程级 `ACCESS_LOCK` 内完成写入，并在**同一把锁内**把最终序列号
   `fetch_max` 到 `Arc<AtomicU32>`（`write_guarded_notifying` / `finish_restore`）。
   写入失败不登记。
2. **采集侧锁内复核**：采集线程在打开剪贴板前，于同一把 `ACCESS_LOCK` 内比较
   `is_own_write_sequence(event, self_write)`（即 `event <= self_write`），命中直接跳过。
   这样不会出现“采集线程抢在登记之前读取”而重复记录本进程写入。
3. **以内容为准**：序列号在合成格式/延迟渲染下会继续增长，粘贴的写前检查、
   写后确认与恢复都以锁内内容比较为准；序列号只作快速变化检测。
4. **来源应用过滤**：读取后若来源 exe 等于当前进程 exe，直接跳过（兜底，不作为主判据）。

恢复不是无条件写入：`restore_if_own_content` 先确认当前内容仍等于本任务最后写入，
才写回快照并登记；用户后来复制的内容只会得到 `KeepUserCopy`，绝不被恢复覆盖。

真机证据（2026-10-29 修复前运行的图文混合粘贴）：分组 4 项整组粘贴完成后，
历史行数保持 7、分组保持 2、4 个条目的 `copy_count` 均未变化；说明自写没有被重复采集。

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

### 配置损坏（fail-closed）

- 剪贴板设置与全局 `Settings::load` 分离：损坏的剪贴板键会先从整包设置中剔除，
  不会让任务/Agent 的端口、主题、通知等回退默认。
- `Settings::load_clipboard` 区分四类：键缺失（默认值，兼容旧库）、JSON 损坏、
  类型错误、数值越界；另有数据库读取失败。后四类使 `capture_allowed=false`。
- 损坏时：监听线程继续运行但不读取、不入库；`clipboard_status` 返回
  `enabled=false`、`paused=true`、`configError{kind,keys}`；抽屉显示
  “配置异常，自动记录已暂停”，绝不显示“监听中”。
- 限频日志：最多 60 秒一条，只含错误类别与键名，不含设置值/正文。
- 修复入口：设置页“修复配置”只重写无法解析的键，并把原始值合并备份到
  `clipboard_config_corrupt_backup`；修复后保持暂停。“修复并恢复记录”才显式
  恢复 `enabled=true / paused=false`。数据库错误无法靠重写键修复，UI 如实说明。

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
10. 剪贴板配置损坏时采用 fail-closed：自动记录停止，必须由用户在设置中显式修复；
   数据库读取失败无法通过修复键值解决，需排查数据库本身。
11. 全透明 PNG 的“按不透明处理”是启发式：若应用真的复制了一张完全透明的图片，
    会被显示为不透明；这一取舍避免 Windows 常见合成路径产生看不见的截图。
