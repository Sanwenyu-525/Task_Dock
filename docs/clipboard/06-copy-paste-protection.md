# 06 · 复制、逐项粘贴与剪贴板保护

> 代码位置：`src-tauri/src/commands/clipboard.rs`（复制命令）、
> `src-tauri/src/clipboard/paste.rs`（粘贴队列与状态机）、`platform.rs`（写入/快照/SendInput）、
> `engine.rs`（整组富文本）
> 界面：`src/components/clipboard/PastePanel.tsx`
> 本文描述 v0.5 整改后的真实实现；未验证项在 §七 明确列出。

## 一、单项复制

`clipboard_copy_item`：

1. 读取完整条目；
2. `paste::payload_for_item` 生成载荷：
   - `image`：从资产文件读取 PNG；缺失报“图片文件缺失”；
   - `files`：过滤仍存在的路径；全部不存在报“原文件已不存在”；
   - `html`：写 `text + CF_HTML`；文本为空则由 HTML 提取纯文本；
   - `text`/`url`：写纯文本。
3. `platform::write_payload` 写系统剪贴板；
4. 记录 `self_write` 序列号，避免监听自记录；
5. `bump_copy` 更新使用次数/最近时间；广播 `clipboard-changed`；
6. 返回 `CopyReport { mode, bytes, warnings, sequence, item_count }`。

文件条目若部分路径失效，复制仍成功，但返回“N 个文件路径已不存在”的警告。

### 写入并发与安全边界

所有 Task Dock 的剪贴板访问（采集读取、快照、内容比较、单项/整组复制、逐项粘贴、
恢复）共用进程级 `ACCESS_LOCK`（`platform.rs`）。它覆盖每一次
`OpenClipboard → 读取/写入 → CloseClipboard` 的完整窗口；等待目标窗口、
焦点轮询、条目间隔、`SendInput` 都在锁外，目标应用无响应不会阻塞用户复制。

**为什么需要进程内锁**（真机验收发现并修复）：同一进程的两个线程各自
`OpenClipboard`/`CloseClipboard` 会互相使对方已取得的 `GetClipboardData` 句柄失效。
修复前粘贴线程写入成功后，采集线程可能在验证读取时打开/关闭剪贴板，导致
“实际 text=None”而被误判为用户接管，并可能在按键前后干扰目标读取。串行化后
真机逐项粘贴 3/3 稳定通过（见 §七与 10 文档）。

写入统一走 `write_guarded`，守卫在 `OpenClipboard` 持锁期间判定：

```
ACCESS_LOCK
  → OpenClipboard（10×12 ms 重试）
  → 守卫判定（持有剪贴板锁）
      Content(载荷)   内容仍等于自己的上一次写入/初始快照 → 允许
      Sequence(seq)   初始剪贴板无内容可比时，序列号未变 → 允许
      Unconditional   用户主动复制 → 允许
      不满足          → CloseClipboard，返回 SequenceChanged，不 EmptyClipboard
  → EmptyClipboard + SetClipboardData
  → CloseClipboard
  → 读取最终序列号（必须在 Close 之后；锁内读到的值可能偏小）
  → ACCESS_LOCK 释放
```

- **内容守卫优先于序列号**：Windows 会在 `CloseClipboard` 之后继续为合成/延迟渲染
  格式递增序列号，序列号变化不等于剪贴板被用户换掉。逐项粘贴与恢复都以内容比较
  为准，避免把系统行为误判为“用户接管”而中断正常粘贴。
- `write_payload`（用户主动复制）等价于 `Unconditional`，仍受 `ACCESS_LOCK`，
  不会与逐项粘贴互相覆盖。
- `restore_if_own_content(snapshot, last_written)`：在锁内比较当前内容是否仍等于
  本任务最后一次写入；不等则返回 `KeepUserCopy`，**绝不调用 EmptyClipboard**。
- `snapshot()` 在同一次访问锁内读取内容，并在 `CloseClipboard` 之后读取序列号。
- 逐项粘贴使用 `write_guarded_notifying`：写入成功后的自写序列号在**同一个访问锁内**
  用 `fetch_max` 登记。采集线程的 `read_clipboard_for_event` 也必须在同一把锁内
  复核 `event_sequence <= self_write` 后才打开剪贴板，避免本进程在写入后再次占用
  剪贴板、干扰目标的 `WM_PASTE`。
- 若无法打开剪贴板（被其他程序占用），返回“剪贴板被其他程序占用，请稍后重试”，
  不进入半写入状态。

## 二、整组复制

### 富文本模式 `clipboard_copy_group_rich`

- 按组内 `position` 顺序拼接，条目之间 `<hr/>`（纯文本 `---`）。
- text：转义并保留换行（`<br/>`）；url：`<a href>`；html：使用已清洗片段；
  image：PNG → base64 data URI，总内嵌预算 6 MB。
- 超出预算或图片文件缺失：写入占位符 `[图片：预览]` 并返回警告，不静默丢失。
- 同时写 CF_UNICODETEXT + CF_HTML；目标不支持 HTML 时系统/应用会退回纯文本，
  报告固定提示“已写入富文本；目标应用若不支持 HTML 将退回纯文本”。
- 明确不声称“目标应用显示为富文本”——这无法自动验证。

### 文件模式 `clipboard_copy_group_files`

- 收集组内 `files` 条目的现存路径 + `image` 条目的本地 PNG 缓存路径。
- 文本/HTML/URL 条目不进入文件列表，返回“第 N 项不是文件/图片”的警告。
- 图片使用 Task Dock 缓存路径，清理历史后路径失效；返回固定警告。
- 若没有任何可用文件，报“分组内没有可复制的文件或图片”。
- 通过 `CF_HDROP` 一次写入多文件，目标应用按文件列表接收。

## 三、逐项粘贴队列

### 启动前校验（`precheck_target`）

- 目标窗口存在且可读取 PID；
- 不是本应用自身；
- 目标进程未提权，或本应用同样提权（UIPI）。否则返回
  “目标应用以管理员权限运行……请以管理员身份重启 Task Dock 后重试”。

### 互斥与任务记录

- `PasteManager::begin` 在锁内检查活动任务；已有任务时拒绝启动（不排队、不并发写剪贴板）。
- 新任务写入 `clipboard_paste_jobs`：分组、目标标题/exe、总数、状态 `running`。
- 继续任务：只重发 `remaining_items`，累计 `sent/total` 保持不变；无剩余项时报错。
- 已写入但未确认的条目不会因为“未确认”被自动重发；只有仍在 remaining 的条目会继续。

### 条目状态机

每个条目至少经历以下状态，状态写入任务进度事件（前端逐项展示）：

| 状态 | 含义 | 允许的下一步 |
|---|---|---|
| `pending` | 尚未处理 | preparing |
| `preparing` | 读取内容、检查目标 | failed / cancelled / 写入 |
| `clipboard_written` | 剪贴板已写入本项 | input_sent / failed |
| `input_sent` | `SendInput` 返回成功 | settling |
| `settling` | 观察窗口，等待目标异步读取 | unverified / cancelled / failed |
| `confirmed` | 目标已确认接收 | **当前实现不会到达**（无可靠系统信号） |
| `unverified` | 动作已发送，接收无法验证 | 终态 |
| `failed` | 写入/按键/目标校验失败 | 终态（保存原因） |
| `cancelled` | 用户取消 | 终态 |

关键约束：

- `InputSent` **永远不等于** `confirmed`；没有可靠完成信号时统一以 `unverified` 结束。
- `confirmed` 仅为将来接入可验证完成信号保留，当前没有任何代码路径会设置它；
  逐项进度里 `confirmed=0` 是正常且诚实的结果。
- 失败/取消的条目带序号与原因；被跳过的条目从 remaining 移除并计入 `skipped`。

### 执行循环（后台线程 `clipboard-paste`）

对每个条目：

1. 检查取消标志；
2. 每项开始前用内容比较确认剪贴板仍是本进程上一次写入（首项与快照内容比对）。
   内容不同说明用户或其他程序已复制新内容：立即 `failed` 停止，备注
   “检测到剪贴板被其他程序更新，已停止并保留最新内容”，不再写剪贴板、不做恢复。
   若暂时读不到（`Unavailable`），先重试再判定，避免把短暂占用误判为用户接管；
3. 检查目标窗口是否仍存在（`window_pid`），关闭则 `failed` 停止；
   HWND 会被系统复用，后续聚焦与按键前都用启动时记录的 PID 复核窗口归属；
4. 读取条目；不存在/内容不可用则计入 `skipped`、从 remaining 移除并继续；
5. 激活目标窗口：`focus_window` + 10×60 ms 轮询确认前台，最多 3 轮（轮间 150 ms）；
   进入时与轮询中均复核 PID，失败则按是否取消标记 `cancelled`/`failed`，停止；
6. `write_guarded(payload, WriteGuard::Content(上次写入或快照))` 在访问锁内比较内容
   并写入；不匹配 `SequenceChanged`，`failed` 停止，**该项先从 remaining 移除**
   （已尝试写入的条目不会盲目重发）；
7. 写入成功后在同一个访问锁内登记 `self_write`（`write_guarded_notifying`），
   采集线程不会为这次自写再次打开剪贴板；
8. 发送按键前用 `clipboard_match` 确认剪贴板仍是本项内容（最多 5 次、40+30n ms 退避）：
   `Different` → 不发按键、不覆盖、`failed` 停止；`Unavailable` 重试后仍不可读 →
   不发按键并如实报告；`Same` → 再做一次最终门（窗口 PID 仍匹配且仍在前台）后
   `SendInput` 发送 Ctrl+V；PID 不匹配或失焦 → 不发送、`failed` 停止（仍不重发该项）；
9. **成功发送按键后才 `sent += 1`**，更新任务并广播进度；
10. 等待该类型的间隔（默认：文本 350 ms、HTML 600 ms、文件 900 ms、图片 1200 ms；
    可在 100–5000 ms 配置），等待按 100 ms 分片以响应取消。

取消在循环边界、焦点轮询、间隔等待中均生效；取消后不再发送新按键。

### 按类型间隔与收尾

- 图片/文件粘贴需要目标应用异步解码或读取，间隔更保守；间隔不是“成功判定”，
  只是降低连续写入导致目标只读到最后一帧的概率。
- 最后一项发送后进入**独立收尾阶段**：按最后类型等待 `settling`（至少 250 ms；
  取消时最多 300 ms），确保最后一张图/文件仍有机会被目标读取，再决定是否恢复。
- 单项观察窗口 `settle_for = clamp(interval/2, 120..900 ms)`；
  收尾窗口 `finishing_for = max(settle, 250 ms)`。
- 单纯提高间隔不能替代状态机与收尾：本项目同时实现了逐项状态、写入前序列号校验、
  取消清理与收尾阶段；间隔只是节奏参数。

### 结束与恢复

- 仅当 `wrote_any` 且未检测到用户接管时尝试恢复原剪贴板（未写过则无需恢复）。
- 检测到用户/其他程序接管（写入后内容比较为 `Different`）时：**跳过恢复**，
  用户内容保持不动。
- `restore_if_own_content(snapshot, last_written)`：
  - 当前内容仍等于本次任务最后一次写入 → 在同一访问锁内写入快照，`Restored`；
  - 内容不同 → `KeepUserCopy`，**绝不覆盖**；
  - 快照为空/格式不支持 → `NoSnapshot`；
  - 剪贴板被占用无法确认 → 返回明确错误，不尝试写入。
- 恢复结果写入任务备注与最终消息。
- 最终状态：`completed` / `cancelled` / `failed`（用户取消优先于完成判定）。
- 结束文案固定包含：
  **“已发送 N/M 项粘贴动作；目标应用是否接收无法自动验证”**，
  并附加跳过数、取消/停止、恢复结果与逐项失败原因。
- 结束后清空活动任务锁；前端可重新启动或继续。

### 失败与中断

- 目标窗口关闭：`failed`，备注“目标窗口已关闭”。
- 无法前台化：`failed`，备注“无法将目标窗口切换到前台（可能被系统焦点保护拦截）”。
- 写入/按键失败：`failed`，备注具体条目与错误；已写入项不会自动重发。
- 应用退出或崩溃：启动维护把残留 `running` 标记为 `interrupted`；
  任务记录与 remaining 保留，可在 UI 选择目标后继续。
- 恢复失败：不改变任务发送计数，仅在消息中说明。

## 四、剪贴板快照与恢复的边界

| 场景 | 行为 |
|---|---|
| 原剪贴板为文本/HTML/图片/文件 | 内存快照（图片 PNG + RGBA、文件路径、文本/HTML），内容在访问锁内读取、序列号在 Close 后读取 |
| 原剪贴板为空或私有格式 | `NoSnapshot`，不恢复并明确提示 |
| 粘贴期间用户复制了新内容 | 下一项写入前内容比较不同 → `failed` 停止并保留用户内容；不执行恢复 |
| 粘贴期间其他程序写入后又被清空 | 内容不再是本进程写入 → 不恢复（保守策略） |
| 用户在内容比较与写入之间复制 | 比较与 `EmptyClipboard` 同持 `OpenClipboard`，其他进程无法插入；若已变化则 `SequenceChanged`，不写 |
| 两个粘贴任务并发 | `PasteManager` 互斥，第二个被拒绝；不会并发写剪贴板 |
| 粘贴期间触发清理 | 自动清理在粘贴进行中跳过；手动 `clipboard_cleanup` 返回“粘贴进行中，暂不清理”，避免删除正在逐项读取的条目/资产 |
| 应用在粘贴中崩溃 | 不做恢复（进程已退出）；下次启动仅标记任务中断 |
| 恢复内容为文件列表 | 只恢复当时仍存在的路径 |

**已知有损情况**：

- 私有格式（如 Office 内部剪贴板对象、设计软件图层）无法快照，恢复时丢失；
- 富文本只保留清洗后的 HTML 片段与纯文本，原始 CF_HTML 头部/额外格式不保留；
- 图片快照统一转 PNG，原始 DIB 色彩配置/透明度细节可能变化；
- 多格式写入若部分格式失败（例如 PNG 成功、CF_DIB 失败），整体按“任一格式成功即成功”
  处理；只有目标应用实际只接受失败的那个格式时才会表现为未接收，任务不会报告细节。
  当前实现只写入内存复制的句柄，失败通常是全局性的（打开/清空剪贴板失败），
  部分成功属于罕见路径，未做逐格式回滚；
- 文件列表只保留路径，不保留文件内容本身。

以上均属于“有损恢复”，任务消息会说明是否恢复以及未恢复原因；不会静默宣称完整恢复。
无法无损恢复时选择**停止恢复并说明**，而不是覆盖用户内容。

## 五、兼容性适配

- **文本**：`CF_UNICODETEXT`，兼容绝大多数输入框、编辑器、终端。
- **富文本**：`CF_HTML` + 纯文本回退；不支持 HTML 的应用显示纯文本（不保证样式）。
- **图片**：同时写 PNG 与 `CF_DIB`，提高对只认 DIB 的传统应用兼容性；
  采集时对 Windows 由 32bpp BI_RGB DIB 合成的全透明 PNG 做不透明归一化，
  避免历史与粘贴出的截图不可见（只影响“所有像素 Alpha 均为 0”的图，部分透明保持原样）；
  仍拒绝图片的应用无法自动识别（按键已发送但目标未接收）。
- **文件**：`CF_HDROP` 宽字符路径；目标必须是支持文件粘贴的应用（资源管理器、
  聊天软件文件输入框等）。纯文本路径作为辅助格式。
- **UIPI**：目标提权且本应用未提权时拒绝并说明原因，不尝试绕过。
- **焦点保护**：Windows 前台锁定/焦点窃取保护可能阻止激活；任务失败并说明，
  不使用固定延迟假装成功。
- **应用层接收**：2026-10-29 在未锁屏的真实 Windows 桌面上完成第三方矩阵（见 §七）：
  记事本、资源管理器、Chromium/Edge 文本与富文本、VS Code 均通过独立读回验证；
  微信因本机为已登录的真实用户会话、Agent 应用因停在登录/引导页，如实记为
  `ENVIRONMENT BLOCKED / NOT VERIFIED`。不把格式层单元测试当作应用层兼容性证明。

## 六、诚实性约束（实现层面）

1. `sent` 只在 `SendInput` 调用成功后递增；不把“写入剪贴板”当作“粘贴成功”。
2. 最终消息不使用“粘贴成功”措辞，固定说明“目标应用是否接收无法自动验证”。
3. 目标应用拒绝某格式（如不接受图片）无法被系统 API 观测；该情况会表现为
   “动作已发送、目标未接收”，不会伪造成功。
4. 每个失败/跳过都带条目序号与原因；任务记录持久化，重启后可审计。
5. 取消/失败后不继续发送；下一项写入前比较剪贴板内容，用户中途复制的新内容不会被队列覆盖。
6. 当前不存在可靠的“目标已接收”信号，因此 `confirmed` 计数恒为 0；
   这不是缺陷隐瞒，而是确认能力边界。
7. 恢复仅在剪贴板仍是本任务最后写入时进行；任何外部写入都会让恢复降级为
   `KeepUserCopy` 并在消息中说明。

## 七、真机验收状态

2026-10-29 在**未锁屏**的 Windows 11 真实桌面上完成了逐项粘贴、取消、继续、收尾与恢复：

| 证据 | 结果 |
|---|---|
| 真机验收脚本（46 项，真实系统剪贴板 + 真实目标窗口） | **46/46 PASS**；含 C3 记事本真实接收 3 项且顺序正确、C5 原剪贴板恢复、C10 目标关闭停止、C11 用户中途复制不被覆盖、C12 目标不接受图片时只报“动作已发送” |
| 第三方矩阵：记事本（3 项有序）/ 资源管理器（CF_HDROP）/ Edge textarea / Edge contenteditable 富文本 / VS Code（真实保存回磁盘） | **5/5 PASS**，每项均由独立进程读回（SendKeys 复制、文件落盘、CDP DOM） |
| 微信 | **ENVIRONMENT BLOCKED / NOT VERIFIED**：本机 Weixin 为已登录的真实用户会话，注入按键可能写入用户正在进行的聊天，无隔离实例，按安全原则不自动化 |
| Agent 类应用（Trae CN） | **NOT VERIFIED**：隔离实例停在登录/引导窗口，`--goto` 无法进入编辑区，自动化输入无法确认落点 |

补充说明：VS Code 首轮粘贴落在欢迎页，任务如实报告 `sent=2/2、confirmed=0`，文件未变化；
用 `--goto` 聚焦到文件编辑区后第二轮才通过。这说明“未确认”不是装饰性字段。

### 2026-10-29 第二轮：真实图文混合粘贴（修复前 / 修复后）

构造分组 **截图A（红）→ 截图B（绿）→ 文字C → 截图D（蓝）**，对 Edge
`contenteditable` 测试页执行整组粘贴：

- Task Dock 侧 `completed`、`sent=4/4`、`restored=true`；
- 目标 DOM 顺序为 `IMG → IMG → 文字（TEXT-C-20261029-middle）→ IMG`，
  `paste` 事件类型为 `Files / Files / text/plain / Files`；
- 剪贴板恢复为原哨兵文本；历史 7→7 条、分组 2→2、4 个条目 `copy_count` 未变；
- 图片字节与隔离库 `clipboard/images/<id>.png` 逐字节一致。

**但像素审计发现真实缺陷**：三张图在目标里 Alpha 全为 0。把目标 `<img>` 保存后
用 System.Drawing 复核（每 5 px 采样 5760 点、不透明点 0），中心 RGBA 分别为
`255,255,255,0` / `40,160,60,0` / `40,70,200,0`，左上角 RGB 为红/绿/蓝。
即“图文顺序正确”掩盖了“三张图全透明”。根因是 Windows 会从 32bpp BI_RGB DIB
合成 Alpha 全 0 的 PNG，`read_png` 原样保存绕过了 `dib_to_rgba` 的兜底。
已新增 `image::normalize_clipboard_png` 与 3 个单元测试（全透明→不透明重编码；
部分透明保持；有可见像素时字节不变），`read_png` 统一走该入口。

**修复后的真机复验未完成**：工作站进入锁屏（`WTSInfoEx.SessionFlags=0`、
`LogonUI` 存在、剪贴板写入 `ERROR_ACCESS_DENIED=5`），无法安全操作 GUI，
记为 **ENVIRONMENT BLOCKED / NOT VERIFIED**。因此本轮不得声称“图文混合粘贴已通过”，
最终判定见 `11-final-release-acceptance.md`。

仍未验证（不得声称通过）：

- 微信与 Agent 类应用的接收行为；
- 修复 Alpha 归一化后的图文混合粘贴真机复验（锁屏阻塞，见上）；
- 图片/文件粘贴到图形界面应用（仅验证了记事本拒绝图片时如实报告）；
- 长时间、高频连续粘贴的稳定性（已有 200 条历史列表性能与队列压测，但不等于长时挂机）；
- 多显示器/不同 DPI 下的焦点与坐标行为。
