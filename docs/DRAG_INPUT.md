# 通用跨应用拖入（Universal Drag Input）

> 目标：让 Task Dock 能接收**任何外部应用拖出来的内容**（网页图片、网页链接、选中文本、
> HTML 片段、Outlook 附件这类虚拟文件、截图软件位图），并按真实类型落进「最近暂存」
> 或投递到目录卡片，同时**零回归**原有的本地文件拖入、文件拖出与复制/移动语义。
>
> 本文是架构与契约文档。任务级验收证据见
> `tmp/acceptance/universal-drag/report.md`；诊断字段与错误码见
> [DIAGNOSTICS.md](DIAGNOSTICS.md) §23；暂存架语义见 [shelf/README.md](shelf/README.md)。

## 1. 为什么必须改底层（问题不是「前端没处理」）

审计结论来自 vendored 源码，不是推测：

| 证据 | 位置 | 含义 |
|---|---|---|
| wry 只用 `CF_HDROP` | `wry-0.57.1/src/webview2/drag_drop.rs` | `DragEnter` 里 `iterate_filenames` 失败即 `return Ok(())` + `DROPEFFECT_NONE`，`Drop` 不回调 |
| wry 枚举全部子窗口注册 | 同上（`EnumChildWindows` + `RevokeDragDrop`/`RegisterDragDrop`） | 鼠标下命中的是 WebView 子窗口，替换主窗口注册没用 |
| wry 关闭 WebView2 内部拖放 | `wry-0.57.1/src/webview2/mod.rs:167` `SetAllowExternalDrop(false)` | HTML5 `drop` 事件也不会触发 |

也就是说：网页图片/URL/文本/虚拟文件在**原生事件层**就被吞掉，前端既收不到回调，
诊断里也没有任何记录——这正是「ChatGPT 生成的图片拖不进最近暂存」的真实根因。
因此 `dragDropEnabled: false` 这类改配置的办法都不可用（它会让资源管理器真实路径拖入一起失效）。

## 2. 新架构总览

```text
外部应用（Chrome / Edge / ChatGPT / Outlook / 截图工具 / Explorer）
        │  OLE IDataObject（CF_HDROP / PNG / CF_DIB(V5) / HTML Format /
        │                 CF_UNICODETEXT / UniformResourceLocatorW /
        │                 FileGroupDescriptorW + FileContents）
        ▼
① 原生输入适配层  src-tauri/src/dragdrop/windows_ole.rs
   IDropTarget（主窗 + 全部子 HWND，RevokeDragDrop → RegisterDragDrop）
   DragEnter/Over/Leave：只分类（classify），不读大块数据，Over 50ms 节流
   Drop：在同一次调用内完成全部 GetData（OLE 契约）→ 落到暂存区
        │  事件 taskdock://drag-probe / drag-accepted / drag-payload
        ▼
② 分类与标准化层  src-tauri/src/dragdrop/{classify,text,names,virtual_files}.rs
   9 级优先阶梯（真实路径 > 虚拟文件 > PNG 字节 > URL/HTML > 纯文本 > DIB 兜底）
        │
        ▼
③ 暂存区（后端独占）  src-tauri/src/dragdrop/stage.rs
   data_dir/drag-incoming/<op>/<NN>-<cleaned-name>；*.part → sync → 原子改名
   TTL 10 分钟 / 最多 8 会话 / 退出清理 + 启动 sweep；前端只拿 operationId
        │  命令 drag_payload_commit_shelf / drag_payload_commit_directory
        ▼
④ 提交与持久化  src-tauri/src/dragdrop/commit.rs
   最近暂存 → shelf::add_reference / add_managed / add_managed_from / add_link / add_text
   目录卡片 → shelf::fsops::drop_paths（沿用既有复制/移动与冲突策略）
        │
        ▼
⑤ 前端仲裁（唯一）  src/lib/fileDrop.ts + src/lib/dragPayload.ts
   双通道订阅（内置 tauri://drag-* 与 taskdock://drag-*），单消费者按优先级 claim
   落点由坐标命中决定（data-drop-target / data-drop-zone），探测结果**只影响提示**
```

## 3. 原生输入适配层（Windows OLE）

- **接管方式**：`install(app, label, hwnd, state)` 在主窗口与 `EnumChildWindows` 枚举到的
  所有子窗口上 `RevokeDragDrop` + `RegisterDragDrop`，替换 wry 的处理器。
  任何一步失败都会把已接管窗口**保持原样**并在诊断里记 `DRAG_NATIVE_BRIDGE_FAILED`，
  行为退化为「只支持本地路径」（与改动前一致，fail-safe）。
- **线程模型**：`IDropTarget` 回调在 UI 线程；虚拟文件流**不在** UI 线程读取。
  `Drop` 内用 `IGlobalInterfaceTable.RegisterInterfaceInGlobal` 把 `IStream` 编组，
  `ReleaseStgMedium` 之后交给常驻 MTA worker 线程 `GetInterfaceFromGlobal` 流式写盘
  （64KB 分块、上限、`sync_all`、原子改名）。没有 `CoMarshalInterThreadInterfaceInStream`
  绑定，因此不走全局流编组。
- **生命周期**：`ReleaseStgMedium` 在所有分支都会被调用；暂存目录在 `Drop` 成功后才创建；
  进程退出（`RunEvent::Exit`）调用 `DragDropState::clear()`，启动时 `sweep()` 清理孤儿目录。
- **一次拖放只消费一次**：`SESSION` 在 `Drop` 开头 `take()`；提交时 `StagedOp::take` 幂等，
  已消费的 `operation_id` 再提交返回 `Conflict` + `DRAG_OPERATION_EXPIRED`。
- **坐标**：`POINTL` → `ScreenToClient(顶层 hwnd)` → 物理像素；前端按 `devicePixelRatio`
  换算成 CSS 像素。`ScreenToClient` 失败时给 `null`（不猜 `(0,0)`）。

## 4. 类型分类（`classify.rs`）

| 顺序 | 判据 | 结果 |
|---|---|---|
| 1 | `CF_HDROP` 且路径非空 | `local-files`（保持引用/托管语义，不复制） |
| 2 | `FileGroupDescriptorW` + `FileContents` | `virtual-files`（流式写盘为托管副本） |
| 3 | 注册格式 `PNG` 且字节头合法 | `image`（PNG 直通） |
| 4 | `UniformResourceLocatorW` / `text/uri-list` | `url`（`is_image` 由扩展名判定） |
| 5 | `HTML Format` | `html`（安全解析出文本与首个图片地址，**不保留富文本**） |
| 6 | `CF_UNICODETEXT` | `text`（或从文本里识别出的单个 URL） |
| 7 | 本地路径 + 虚拟文件同时存在 | `mixed`（按分项计数，目录侧只看文件类） |
| 8 | `CF_DIB` / `CF_DIBV5` | `image`（DIB→PNG，**兜底**：它常是拖拽预览缩略图） |
| 9 | 其它 | `unsupported`（带 `formats` 名称与 `DRAG_FORMAT_UNSUPPORTED`） |

`CF_DIB` 排在最后是有意的：很多来源同时提供「预览位图」和「真实内容」，把预览当原图
会静默降低质量。

## 5. 载荷协议（前后端同源）

`DragPayloadView`（Rust `#[serde(tag = "kind", rename_all = "kebab-case")]` ↔ TS 判别式联合）：

```text
local-files { paths, count } | virtual-files { items, count } | image { items, count }
url { url, isImage } | html { textPreview, hadImage, imageUrl? }
text { textPreview, chars } | mixed { parts[] }
unsupported { formats, reason, code }
```

- 预览字段有界（文本 512KB / HTML 1MB / 条数 32），**正文与字节始终留在后端**；
- `DragProbe`（`kind/count/canShelf/canDirectory/formats`）只用于提示，`formats` 只有名字；
- 命令：`drag_bridge_status`、`drag_payload_commit_shelf`、`drag_payload_commit_directory`、
  `drag_payload_discard`、`drag_report_client_issue`；参数一律 camelCase，路径不落前端。

## 6. 落点语义（两个接收区）

| 类型 | 最近暂存 | 目录卡片 |
|---|---|---|
| 本地文件/文件夹 | 引用（或托管，遵循“添加即复制”开关） | 复制 / 移动（沿用既有策略与冲突处理） |
| 虚拟文件 | 托管副本（流式） | 导出为真实文件（流式，同语义） |
| 图片字节 | 托管 PNG | 导出为 PNG |
| 网页链接 | 链接条目 | **拒绝**：`此内容不能直接投递到文件夹` |
| 纯文本 / HTML | 文本条目（HTML 提取纯文本） | **拒绝**（不做隐式转换） |
| 混合 | 按分项分别入库 | 仅文件类分项投递，其余丢弃并计入 `skipped` |
| 未识别 | 拒绝 + 诊断 | 拒绝 + 诊断 |

「移动并删除源文件」只对**真实本地路径**生效。虚拟文件、浏览器数据、暂存副本永远没有
「源文件」可删，因此不会因为目标卡片配置了 move 就执行无意义的删除。

## 7. 安全与资源上限（集中在 `dragdrop/mod.rs`）

| 项 | 上限 |
|---|---|
| 单批条目 | `MAX_ITEMS = 32` |
| 本地路径 | `MAX_LOCAL_PATHS = 500`（与 `shelf_add_paths` 一致） |
| 文本 | `MAX_TEXT_BYTES = 512KB`（与 `shelf::MAX_TEXT_BYTES` 对齐） |
| HTML | `MAX_HTML_BYTES = 1MB` |
| 图片 | `MAX_IMAGE_BYTES = 64MB` + 像素数校验 |
| 虚拟文件 | 单条 2GB / 单批 4GB（与 `shelf` 托管上限一致） |
| 暂存会话 | TTL 10 分钟 / 并发 8 / `COMMIT_WAIT` 20s |
| 高频事件 | `DragOver` 50ms 节流，`enter/over/leave` 不写诊断 |

- 文件名统一经 `names::sanitize_file_name`（路径穿越、保留名、长度、非法字符、`.`/`..`）；
- 虚拟文件写盘用 `open_part` → `write_all` → `sync_all` → `fsync` 后 `finalize`，
  失败路径 `drop_part` 清理；目标路径由「暂存目录 + 清洗后的名字」拼接，不接受来源给出的
  任何目录信息；符号链接/重解析点不会被跟随（只写新建文件）；
- 不执行外部内容：HTML 只做文本提取，不保留脚本/属性，不加载远程资源；
- 不做自动下载：`DRAG_REMOTE_FETCH_DENIED`/`FAILED` 仅作为错误码预留；
  `blob:`/`data:`/`file:` URL 一律不当作可读来源；
- 日志只记录类型、格式名、计数、字节数、耗时、错误码——不记录正文、URL、路径、图片字节。

## 8. 与既有架构的边界（不重复建设）

- 拖入仲裁仍由 `src/lib/fileDrop.ts` 单消费者决定；原生桥只是把更丰富的事件喂给它；
- 暂存条目仍由 `shelf` 入库（`add_reference`/`add_managed`/`add_managed_from`/`add_link`/
  `add_text`），**没有第二套存储**；
- 目录投递仍走 `shelf::fsops::drop_paths`，复制/移动/冲突/结果条口径不变；
- 文件拖出（`shelf/drag_out.rs` 的 `DoDragDrop`）完全未改。

## 9. 已知差异与限制

1. 接管 `IDropTarget` 后无法复刻 Tauri 内置 Drop 分支里的 `scopes.allow_file(path)`
   （assetProtocol 放行）。当前 asset scope 仅覆盖 `$APPDATA/audio/voice-packs/**`，
   暂存架图片预览走 `shelf_read_image` 命令，不受影响；若未来有页面直接用
   `asset://` 显示拖入文件，需要另行放行。
2. `CF_DIB` 兜底路径的像素上限（宽高各 16384、总像素 6400 万）是保守估计，
   超限按 `DRAG_IMAGE_DECODE_FAILED` 拒绝而不是压缩。
3. 纯前端预览（`textPreview`）只用于提示与确认，**不是**入库内容；入库内容由后端
   按 `operationId` 读取，避免预览截断被当成全文。
4. 原生桥只在 Windows 生效；非 Windows 平台 `bridge_active()` 返回 false，
   前端自动退回 Tauri 内置事件（仅本地路径）。

## 10. 第二轮独立验收与修复（2026-11-13）

本轮在 `agent/universal-drag`（基线 `547cd30`）上独立复验上一轮成果，不重写分层，
只修复实测发现的问题。

### 10.1 实测发现并修复

| 问题 | 根因 | 修复 |
|---|---|---|
| 谎报 TYMED 的来源会让拖入回调崩溃（`STATUS_ACCESS_VIOLATION`） | 校验出 `medium.tymed` 不符后仍调用 `ReleaseStgMedium`；该 API 按被谎报的 tymed 释放，本身就会解引用错误指针 | 类型不符时**不释放**、直接拒绝并放弃这个 medium：宁可泄漏一个违约 medium，也不在 `DoDragDrop` 内崩溃 |
| `FileGroupDescriptorW` 缓冲区比 `4+620×N` 大时被整块放弃 → 附件被同批 HTML/文本旁路顶替 | `read_hglobal` 对超过 cap 的 HGLOBAL 一律返回 `None` | 新增 `read_hglobal_prefix`：只读头部；解析器仍按真实长度报 `Truncated`/`TooMany`。**2026-11-14 更正**：此处 `620` 是当时的错误假设，SDK 单条实际为 **592**，见 §12 |
| 虚拟文件「声明大小」可信，实际写入总量无上限 | 只用描述符声明值校验 | 增加本批**实际写入总量** `MAX_VIRTUAL_TOTAL_BYTES`，逐条扣减；谎报大小无法突破 |
| 短 ASCII 文本被误判为 UTF-16（`abc\0\0`） | 判据「零字节数 > 总长/4」对短文本不成立 | 改为「偶数长度 + 至少一半高字节为 0」；非法 UTF-8 再尝试 UTF-16LE（无 BOM 的中文 `CF_UNICODETEXT`） |
| 拖入阶段 `skipped` 未进入提交报告 / 失败被重复计数 | `snapshot` 不含 `skipped`；`skipped += failures.len()` | `StagedOp::skipped()` 进入提交报告；`skipped` 与 `failures` 分开 |
| `drag_bridge_status` 只能看到 `active`，无法判断 WebView 子窗口是否接管 | 未暴露窗口数 | 新增 `windows`：`active=true, windows=1` 说明子窗口可能仍走 wry 旧处理器 |
| 不支持内容只显示笼统文案 | 未使用后端已脱敏的 `reason` | 有 `reason` 时优先展示（仍不含正文/路径） |

### 10.2 受控 OLE 测试源

`src-tauri/src/dragdrop/ole_test_source.rs`（仅 `cfg(test)` 编译）实现真实的
`IDataObject` / `IEnumFORMATETC` / `IStream`，可构造 `CF_UNICODETEXT`、`HTML Format`、
`PNG`、`FileGroupDescriptorW` + `FileContents(TYMED_ISTREAM)`，以及两种**故意违反 TYMED
契约**的数据对象。生产代码经 `EnumFormatEtc → GetData → ReleaseStgMedium` 的真实 COM
路径读取，不是对读取函数打桩。

覆盖：文本分类、HTML 提取、PNG 解码重编码、虚拟文件双流写盘与文件名清洗、描述符尾部
填充、错误 TYMED 不崩溃、`FileContents` 返回 HGLOBAL 时失败而非崩溃、流读取超过本批额度
时中止并清理 `.part`。

**边界**：不覆盖 `RegisterDragDrop` 接管、WebView2 窗口链与真实鼠标时序，不能替代真机。

### 10.3 真机状态

验收时会话仍处于锁屏（`LockApp` 运行），物理拖拽、真实系统 DPI、多显示器均为
**UNVERIFIED**；结论与阻塞原因见 `tmp/acceptance/universal-drag/report.md` 第二轮章节。

## 11. 第三轮：虚拟文件索引、会话并发与注册失败恢复（2026-11-13 夜）

本轮不重写架构，只修上一轮独立审查发现的边界缺陷。

### 11.1 本轮修复

| 问题 | 根因 | 修复 |
|---|---|---|
| 多虚拟文件来源只支持内存块时，回退读取会失败或串内容 | `obtain_content` 的 ISTREAM 路径带 `lindex=index`，HGLOBAL 回退却走 `read_hglobal`（固定 `lindex=-1`） | 新增 `read_hglobal_index(obj, cf, index, cap)`；流与内存回退**共用同一个 `lindex`**；`FileContents` 的索引就是描述符顺序 |
| 内存块回退路径把虚拟文件上限从 2GB 悄悄压到 64MB，且错误码不准确 | 复用 `MAX_IMAGE_BYTES` 作为 cap | 新增 `MAX_MEMORY_CONTENT_BYTES`（64MB）与 `DRAG_MEMORY_CONTENT_TOO_LARGE`；文案带实际上限。**内存块无法流式写盘，超过上限明确拒绝，不伪称支持 2GB**；大文件必须由来源提供 `TYMED_ISTREAM` |
| 来源忽略 TYMED 请求时行为不一致 | 只核对 `medium.tymed != 请求值` 就失败 | 按 `medium.tymed` **实际类型**分派：请求 ISTREAM 却拿到 HGLOBAL 时按内存块读取；拿到谎报类型时不释放、不放行（见 §10.1） |
| 描述符声明有 N 项、来源只给部分 `FileContents` 时只有笼统「读取失败」 | 索引缺失与读取失败共用一个码 | 新增 `DRAG_VIRTUAL_INDEX_INVALID`（含「第 N 项」，N 是计数不是内容）；能读的照常落盘，缺的逐项报告 |
| 后台读取与 `discard`/TTL/上限淘汰存在竞争：取消后仍可能写盘并重建暂存目录 | 后台线程不核对会话是否已被释放；`stage::open_part` 会 `ensure_dir` | `StagedOp::consumed` 兼作取消标记；`stage_pending` 每项写盘前核对，取消时回收**所有**未消费的 GIT cookie；`read_stream_to_file` 每 64KB 核对并删 `.part`；收尾再删一次目录 |
| 会话上限淘汰可能删掉正在写盘的会话 | 只按 `created_at` 选最老 | 优先淘汰 `Ready/Failed` 或已消费的会话，全部仍在读时才淘汰最老 |
| `enqueue` 投递失败时 job（含流 cookie）被丢弃 | `mpsc::SendError` 被忽略 | 从 `SendError` 取回 job 同步执行，绝不丢内容、不泄漏 GIT 项 |
| 注册失败无法区分顶层/子窗口，失败窗口可能被当成已接管 | `install` 只返回成功数 | `InstallReport { total, installed, failed, recovered, top_level_ok }`；失败重试一次，仍失败如实计入；部分失败写 `DRAG_NATIVE_BRIDGE_PARTIAL` 诊断；`drag_bridge_status.failedWindows` 暴露失败数 |
| 重复安装会重复撤销/注册，可能无界保留旧接口 | 无卸载入口 | `uninstall_registered` 幂等：句柄与接口成对保存，**撤销成功才释放**；主窗 `Destroyed` 时调用 `uninstall_native_bridge` |
| 前端单个全局 `pending` 被第二轮拖入覆盖，两轮都丢 | 单槽变量 | 改为 `Map<operationId, session>`：上限 8（对齐 `MAX_STAGE_OPS`）、TTL 10 分钟（对齐 `STAGE_TTL`）、每会话一个定时器；注销只释放该消费者的会话；重复 payload 只交付一次且不误发 discard；已释放 operationId 去重 |
| 提交失败的诊断只看到通用 `CONFLICT`/`NOT_FOUND` | `commit` 用自然语言报错 | 错误文本前缀稳定码（`DRAG_OPERATION_EXPIRED` / `DRAG_PAYLOAD_PENDING`），命令层用 `stable_drag_code` 提取为 `error_code`；新增 `DRAG_PAYLOAD_PENDING`（仍在读取，可重试） |

### 11.2 `FileContents` 读取规则（本轮定稿）

1. 先按 `{ cfFormat: FileContents, lindex: i, tymed: TYMED_ISTREAM }` 取流；
   **2026-11-14 更正**：`i` 必须是**原始描述符序号**，不是跳过无效项后的数组下标；见 §12；
2. 流成功 → 注册进 GIT，后台 MTA 线程 64KB 分块写盘（单条 ≤2GB、整批 ≤4GB、实际写入总量计费）；
3. 流不可用 → 按**同一个 `lindex`** 以 `TYMED_HGLOBAL` 回退；成功即按内存块复制
   （单条 ≤64MB、单次拖入所有内存块合计 ≤128MB）；落盘按描述符声明长度截断，去掉块尾部填充；
4. 来源返回的 `medium.tymed` 与实际不符：**不释放**该 medium（按谎报类型释放会 AV），拒绝并放弃；
5. 两条路径都不存在该索引（`DV_E_FORMATETC`/`DV_E_LINDEX`）→ `DRAG_VIRTUAL_INDEX_INVALID`；
   其它 `GetData` 错误或内容为空 → `DRAG_VIRTUAL_FILE_READ_FAILED`；
6. 内存块超限 → `DRAG_MEMORY_CONTENT_TOO_LARGE`。

**无法防御的违约来源**：若来源把 HGLOBAL 谎报成 `TYMED_ISTREAM` 且给出非空 `pstm`，校验
只能通过调用接口（AddRef）完成，而对假指针调用本身就会 AV；Windows 没有可靠的
「指针是否为接口」API。ISTREAM 分支依赖来源遵守 OLE 契约，列为残余风险。

### 11.3 前端会话表

- `pending: Map<string, PendingDropSession>`，上限 `8`，超限淘汰最老并调用 `dragPayloadDiscard`；
- 每会话 TTL `10 分钟`，到点未收到 payload → 释放后端暂存；
- `accepted` 重复到达不覆盖；`payload` 按 operationId 精确交付；已交付的 operationId 记录在**有界**去重表（32），重复 payload 不二次交付、也不 discard（consumer 可能正在提交）；
- 消费者注销只释放自己的会话；全部退订时释放所有会话；
- `discardOperation` 同一 operationId 只发一次 IPC，并写一条 DEBUG 诊断（只含 reason 与 operationId）。

### 11.4 注册恢复的平台限制

OLE 没有「取回上一个 `IDropTarget`」的 API，`RevokeDragDrop` 之后无法恢复 wry 的处理器。
因此注册失败时只能：重试一次、如实计数、保留未撤销成功的接口对象、在状态与诊断里暴露
`failedWindows`。**这不等于 fail-safe**：失败窗口在本进程内没有拖入处理器，直到下次成功安装。
安装发生在 WebView 创建之后，隔离实例实测覆盖顶层 + 6 个 WebView 子窗口（`windows=7`）；
之后由 WebView2 新建的弹窗/DevTools 窗口不在接管范围内（设计边界）。

### 11.5 测试与真机状态

受控 OLE 测试源新增：多文件 HGLOBAL（按索引区分内容）、流/内存混合、同一索引同时提供两种
表示（验证流优先）、部分索引缺失、空 HGLOBAL、内存超限、HGLOBAL 尾部填充、打开前取消与
**读取中途取消**；另有安装账目纯函数测试（全成功/顶层失败/子窗口失败/全失败/重试恢复/
重复安装）、「放弃会话后后台不再写盘」「提交期间目录不被孤儿清扫删除」。
前端新增 12 个交错/乱序/注销/重复/未知/上限/TTL/慢会话/显式取消/已释放再 accepted 用例。

独立只读审查发现并修复了一个**既存 P1**：`take_for_commit` 把会话移出注册表后，并发新拖入的
`sweep_orphans` 会把正在复制的暂存目录当孤儿删除。现在提交期间会话 id 进入 `committing`
集合（RAII `CommitGuard` 保证所有返回路径解除），孤儿清扫将其视为活跃。

真机仍 `ENVIRONMENT BLOCKED`（锁屏），物理拖拽与第三方应用兼容性为 UNVERIFIED。
结果明细见 `tmp/acceptance/universal-drag/report.md` 第三轮章节。

## 12. 第四轮：FILEDESCRIPTORW 标准长度与原始索引（2026-11-14）

本轮不重写架构，只修协议层两个真实缺陷，并核查格式优先级。基线 `dbf83ce` + 第三轮未提交
改动；改动仍集中在 `dragdrop` 模块。

### 12.1 修复

| 问题 | 根因 | 修复 |
|---|---|---|
| 合法的 596 字节单文件 `FILEGROUPDESCRIPTORW` 被判「虚拟文件描述符不完整」 | `FILEDESCRIPTORW_LEN = 620`，把并不属于 `FILEDESCRIPTORW` 的 `cAlternateFileName[14]` 算进长度 | 以 `windows` crate 0.62 的 SDK 绑定为准改为 **592**；单文件组 `4+592=596`；多文件步长 592；描述符前缀上限 `4+32×592`；`DragEnter/Over` 计数只读 4 字节头 |
| 跳过空名/目录/超限描述符后，`FileContents` 读到错位内容 | 解析结果过滤后，`collect_virtual` 用**过滤后数组下标**当 `lindex` | `VirtualFileDesc.original_index` 保留原始序号；`collect_virtual` 用 `desc.original_index` 取流/内存块；失败原因里的「第 N 项」也用原始序号 |
| 描述符解析失败被误当成「没有虚拟文件」而静默走旁路格式 | 分类只看格式存在性 | 计数头仍决定 `VirtualFiles`；正文损坏时 `collect_virtual` 产出 `DRAG_PAYLOAD_INVALID`（含可读原因），不静默丢弃整个拖入 |

### 12.2 ABI 验证（不依赖生产常量）

- `windows::Win32::UI::Shell::FILEDESCRIPTORW`（`repr(C, packed(1))`）：
  `size_of = 592`，`FILEGROUPDESCRIPTORW = 596`；
  `dwFileAttributes` 偏移 **36**、`nFileSizeHigh` **64**、`nFileSizeLow` **68**、
  `cFileName` **72**、长度 **260 WCHAR**。
- 独立测试样本按 592/596/1188 手工构造，覆盖：单文件、双文件、三文件、合法尾部填充、
  少一字节截断、只有 4 字节数量头、数量为零、超上限、`u32::MAX` 恶意数量、
  中文文件名、非法路径字符、大小未知、超大声明、原始索引跳过。
- 受控 OLE 源改用 **SDK 结构本身**构造描述符（不再复制生产常量）；源时间接证明
  596 字节组可被真实 COM 路径读取。
- 真实世界边界：尾部填充只按声明长度截断；描述符声明大小仍是上界，实际写入总量
  另受 `MAX_VIRTUAL_TOTAL_BYTES` 约束（§11.2 不变）。

### 12.3 原始索引测试

受控 OLE 新增：目录在第 0 项（带诱饵内容）、`a.txt` 第 1 项、`b.png` 第 2 项；
断言只落盘 `a.txt`/`b.png`，诱饵内容从未被读；中间超限文件、连续空名/目录、
首个有效项在最后、缺失索引按原始序号报告、头部声明 2 项但正文截断时
`DRAG_PAYLOAD_INVALID` 且不静默降级。

### 12.4 格式优先级与回退策略（核查结论）

1. 阶梯不变：真实路径 > 虚拟文件（`FileGroupDescriptorW`+`FileContents`）> 命名 PNG >
   URL/HTML > 纯文本 > DIB 兜底；同一批同时出现虚拟文件与 PNG/HTML/URL/DIB 时，
   虚拟文件优先（新增用例钉住）。
2. 描述符损坏不会静默丢弃：仍按 `VirtualFiles` 受理，失败逐项报告并带稳定码。
3. **不做「虚拟文件失败→自动存 PNG/DIB」回退**：拖入里的 PNG/DIB 很可能只是同一对象的
   拖拽预览图，自动保存会违反「不得重复保存同一个逻辑对象」，也会把预览冒充原图。
   HTML 图片地址同样不自动下载。完全失败时返回 `DRAG_PAYLOAD_INVALID` /
   `DRAG_VIRTUAL_FILE_READ_FAILED` 等准确码，由用户重试或检查来源。
4. 本地路径 + 虚拟文件同批时，虚拟文件失败不影响本地路径条目（各自独立处理）。
5. 只有 ANSI `FileGroupDescriptor`（无 W 版本）时明确返回
   `DRAG_FORMAT_UNSUPPORTED`（原因含 ANSI），不再让同批 HTML/文本/PNG 静默顶替；
   本地路径仍优先。条数超限使用独立码 `DRAG_TOO_MANY_ITEMS`，不与字节/像素上限混用。

### 12.5 测试与证据

- `dragdrop::`：**122 passed / 0 failed**（本轮新增 27 条）；
- 全量 lib：**1787 passed / 0 failed / 8 ignored**；
- 独立验收后的补充修复：ANSI-only 描述符明确不支持、目录卡片失败不被 `dirBlocked`
  覆盖、图片读取错误码按原因区分、迟到载荷不清新会话读取态、条数超限独立码等
  （详见报告 §A6）；
- 测试 exe 仍需 `mt.exe` 嵌入 comctl32 v6 清单（工装限制，见 `docs/TESTING.md`）；
- UI 文件数与错误反馈的截图/测试见 `tmp/acceptance/universal-drag-protocol/report.md`。
- 真机（Explorer/Chrome/Edge/Outlook/ChatGPT 网页图片、DPI、多显示器）仍为
  **UNVERIFIED / USER VERIFICATION PENDING**，受控 OLE 与 jsdom 不能替代。

## 13. 主动粘贴当前剪贴板（v51，2026-11-14）

拖入解决的是「从来源拖过来」；本节解决「已经复制，打开收集箱按 Ctrl+V」。
两者共享暂存架持久化与错误码，但**输入适配器不同**：粘贴不经过 OLE 拖入会话，
也不依赖剪贴板历史监听是否开启。

### 13.1 命令与数据流

`commands::shelf::shelf_paste_current(storage_mode?, group_id?)`：

1. 在阻塞线程调用 `clipboard::platform::read_clipboard(true)`，读取**当下**的系统剪贴板
   （`true` 表示用户主动粘贴时忽略「不进入剪贴板历史」标记，与编辑器 Ctrl+V 同义）；
2. `shelf::ingest::ClipboardIntake::from_read` 把读取结果映射为与平台无关的输入；
3. `shelf::ingest::save` 复用 `add_reference` / `add_managed` / `add_managed_png` /
   `add_link` / `add_text`，不新建第二套存储；
4. 返回 `ShelfPasteReport`：`operation_id/source/content_kind/added/added_ids/failed/
   skipped/duplicates/success/partial/requires_user_action/code/retryable`。

空内容、剪贴板被占用、格式不支持、超出上限都以 `success=false` 的结构化报告返回，
不抛 IPC 错误；只有内部任务异常才 `Err`。

### 13.2 格式优先级与保存语义

沿用 `clipboard::engine::classify`：**文件列表 > 图片字节 > URL > HTML > 文本**。

| 剪贴板内容 | 保存方式 | 说明 |
|---|---|---|
| `CF_HDROP` 文件/多文件 | `reference` 或 `managed` 逐条保存 | 单条失败不阻断其他；同一批按路径去重 |
| 文件夹 | 始终 `reference` | 即使选择托管也不复制目录内容 |
| PNG / DIB / DIBV5 | `add_managed_png` 独立托管副本 | 真实字节落盘；不依赖剪贴板历史资产 |
| URL | `add_link` | 只存链接，不下载 |
| HTML（正文非空） | 安全提取纯文本后 `add_text` | 不保留脚本/样式/属性 |
| HTML-only + 图片地址 | `add_link` | 明确是链接，不冒充原图 |
| 纯文本/代码片段 | `add_text` | 保留原始换行与缩进（仅去首尾空白） |
| 虚拟文件（`FileGroupDescriptorW`/`FileContents`） | **暂不支持主动粘贴** | 剪贴板无可靠的按 `lindex` 单块读取 API；返回 `CLIPBOARD_UNSUPPORTED`，不静默当作空。拖入通道仍完整支持 |
| 空/无法识别 | `CLIPBOARD_EMPTY` / `CLIPBOARD_UNSUPPORTED` | 明确反馈 |

不做「图片 URL 自动下载」「DIB 预览冒充原图」「虚拟文件失败→自动存 PNG」等降级。
同一操作内路径去重；与已有条目同路径/同正文时**不阻止**显式重复粘贴，只在
`duplicates` 中计数并提示（区分「一次按键的重复事件」与「用户明确再次粘贴」）。

### 13.3 Ctrl+V 焦点规则

实现：`src/lib/pasteShortcut.ts`，胶囊「文件」子页与完整暂存架共用。

- 只消费 **Ctrl+V**；`Ctrl+Shift+V`（纯文本粘贴）、`Ctrl+Alt+V`、`Ctrl+Win+V` 放行；
- `INPUT` / `TEXTAREA` / `SELECT` / `contenteditable`（含祖先/子节点）内不消费；
- 菜单、对话框、模态等弹层打开时不消费；胶囊自身用于 Esc 的 drawer 层
  （`blocksAutoHide:false`）不算弹层；
- `defaultPrevented`、输入法组合（`isComposing`/229）、长按 `repeat`、在途操作
  （busy）不消费；
- 组件卸载即移除 window 监听；只在实际消费时 `preventDefault()`。

### 13.4 入口与反馈

- 胶囊「最近暂存」标题行新增剪贴板粘贴图标（22px，与 `+`/「查看全部」同排），
  带 `aria-label` 与 `data-tip`（含 Ctrl+V）。结构化状态行在**最近暂存之后**
  渲染，出现/消失不推动已有文件行；成功/空/占用/超限/不支持分别有短标题与稳定码，
  部分失败可展开原因、可跳诊断。
- 完整暂存架工具条新增独立粘贴按钮（添加 → 粘贴 → 搜索 → 筛选 → 更多）。
  「从剪贴板历史添加」仍在添加菜单中，文案与「粘贴当前剪贴板」明确区分。
- 工具条「⋯」菜单提供资源管理器右键发送开关。

### 13.5 全局收集与系统右键发送

- 系统热键 `collect_to_shelf`（默认 `Ctrl+Alt+G`，可在设置中改）：读取当前剪贴板、
  引用模式入库，广播 `taskdock://shelf-collected`（只含计数/稳定码）并唤出主窗口。
- 资源管理器右键「发送到 Task Dock」：HKCU 动词
  `Software\Classes\*\shell\TaskDockShelf` 与 `Directory\shell\TaskDockShelf`，
  命令 `<exe> --send-to-shelf "%1"`，`MultiSelectModel=Document`；不加管理员权限、
  不改文件关联。单实例插件把第二实例 argv 转交现有实例；首实例在暂存架就绪后消费。
  用户可在暂存架「⋯」菜单启用/停用，停用删除本应用创建的键。
- 真实 Explorer 菜单、多文件、长路径、被移动后的旧注册项仍需 Windows 真机验收；
  当前单元测试只覆盖参数解析、命令引用与键名生成，不写用户注册表。
