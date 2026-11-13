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
