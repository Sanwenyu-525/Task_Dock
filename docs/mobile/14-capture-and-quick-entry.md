# 统一采集中心、语音速记、快捷入口与前台自动同步

> 状态：**已实现（2026-11-14）**，代码在 `apps/mobile`；构建/测试/真机验证情况见文末
> 「验证状态」。本文是正式规范，任务级证据在 `tmp/acceptance/mobile-efficiency/`。
> 历史文档 [09-share-receive.md](09-share-receive.md) 描述的是 2026-11-12 的「仅文本」实现，
> 冲突处以本文与代码为准。

## 1. 为什么做这一轮

目标不是增加功能数量，而是把手机上「发现信息 → 捕获 → 保存 → 同步 → 在电脑上继续」这条
链路的最短路径压到 1–2 步。桌面端仍是复杂编辑与文件管理的主场，手机端只负责
**采集入口、轻量处理、跨设备接续**。

三处真实缺口：

1. 拍照采集：既有相机只用于扫配对二维码，没有「拍照 → 保存」闭环；
2. 系统分享：只注册 `ACTION_SEND text/*`，图片/文件/多选被静默忽略；
3. 同步：只能进同步页点「立即同步」，写完内容必须再切页面。

## 2. 统一采集中心

页面：`src/screens/CaptureScreen.tsx`（路由 key `capture`，可从工具页、设备页、
快捷方式、系统分享、通知动作进入）。三种模式（`compose | camera | voice`）共用一条
保存流程，用户只需要学一套。

### 2.1 数据流

```
拍照 / 相册 / 文件 / 分享 / 语音 / 手输
   └─ 先落 TaskDock 私有目录（Paths.document/capture/<kind>-<newId>.<ext>）
        └─ capture_stash 行（DB，可跨重启恢复）
             └─ 保存时单事务：业务行（收集箱/任务/笔记）+ attachments 行 + 清空 capture_stash
                  ├─ 文本类实体进 outbox（既有同步通道）
                  └─ 附件独立：transfer_state=pending，按需走 /v1/files 互传
```

关键决定：

- **附件不进同步载荷、不进 outbox**：桌面端收集箱 `content` 上限 4000 码点、kind 白名单
  只有 task/idea/text/todo/link，把图片塞进文本字段既不可同步也不可恢复。附件用
  `attachments` 表 + 既有 `/v1/files` 通道，生命周期独立。
- **暂存先落库再展示**：选中的图片/录音先复制进私有目录并写 `capture_stash`，页面被系统
  回收、应用被强停后再次进入仍能看到未保存内容（不是内存态）。
- **幂等键**：页面会话生成一个 `clientId`（`cap_...`），重复点保存或失败重试不会产生
  第二条记录（`INSERT OR IGNORE` + 唯一索引，命中返回 `duplicated:true`，且不重复挂附件）。
- **附件与实体稳定关联**：`attachments.owner_entity ∈ {capture,note,task}` + `owner_id`；
  收集箱「转任务」时 `moveAttachmentsOwnerInTx` 只改归属，不复制文件字节。
- **文本为空时的标题来自真实元信息**（如「照片 2 张 · 11-14 12:03」），不生成占位假内容；
  语音没有转写时正文不会编造文字。

上限（Kotlin 与 JS 同值）：单次 9 项、单件 50MB、合计 200MB；文件名只取 basename 并清洗，
落盘名由本地生成，绝不用外部文件名拼路径（防路径穿越）。

### 2.2 保存去向

| 去向 | 结果 | 同步 |
|---|---|---|
| 收集箱 | `captures` 行（kind 恒为 `text`）+ 附件 | 文本 pull/push；附件手动/按设置传送 |
| 任务 | 首行做标题（≤60 字），其余进描述 + 附件 | 文本同步 |
| 笔记 | 首行做标题，其余进正文 + 附件 | 文本同步 |
| 发送到电脑 | 保存后立即 `transferPendingAttachments()` | 复用文件互传 v2 |

保存成功反馈明确区分「已保存到本机」与「已发送到电脑」；未配对时「同时发送到电脑」
开关会直接说明原因，不会假装发送。

## 3. 拍照与图片

- 应用内拍照：`expo-camera` `takePictureAsync({quality: 0.72})` → 复制到私有目录 →
  删除缓存原图；支持连续拍摄多张，网格预览、单张删除、重拍。
- 相册批量导入：`File.pickFileAsync({multipleFiles:true, mimeTypes:["image/*"]})`，
  多选后逐张入库（受 9 项上限约束）。
- 文件导入：同一 API + `application/*`，落 `kind=file`。
- 原图/压缩：当前保留压缩副本（质量 0.72），原图不重复保存，避免相册重复占空间；
  「保留原图」为后续增强项。
- 图片增强（边缘检测 / 透视校正 / OCR）**未实现**，不阻塞基础拍照链路，见 §8。

## 4. 语音速记

原生模块 `modules/voice-recorder`（Kotlin `MediaRecorder`）：

| 方法 | 行为 |
|---|---|
| `startRecording(fileName?)` | AAC / MPEG-4，单声道 44.1kHz 96kbps，写入 `filesDir/capture-audio/`；API 31+ 用 `MediaRecorder(context)` |
| `stopRecording()` | 返回 `{path, durationMs, size}`；状态机不允许重复 stop |
| `cancelRecording()` | 停止并删除本模块目录内的半成品；只删自己目录（`assertInsideAudioDir`） |
| `play(path)` / `stopPlayback()` | 本地试听，同一时刻只播一条 |
| `deleteFile(path)` | 仅限本模块目录，防止被 JS 传入任意路径 |

JS 侧（`src/screens/CaptureScreen.tsx` voice 模式）：运行时申请 `RECORD_AUDIO` →
录音计时（只有录音中存在 interval，离开/取消会清理）→ 停止后写入暂存 → 试听 → 保存。
录音中按返回键先取消并清理临时文件，不会留下孤儿音频。

**转写不存在**：界面明确显示「尚未转写 · 可手写要点」，用户可手写要点存
`attachments.transcript`；不调用任何云端识别，不伪造转写结果。后续接入识别服务时，
只需要填充 `transcript` 字段，不改数据契约。

## 5. 系统分享接收（增强）

`modules/share-intent` 已从「text/plain only」重写为：

- `ACTION_SEND` + `ACTION_SEND_MULTIPLE`；
- 文本：`EXTRA_TEXT`（为空时 `text/*` 取 `EXTRA_SUBJECT`），超 4000 码点截断；
- 附件：`EXTRA_STREAM`（单个/列表）或 `ClipData`，经 `ContentResolver` 查询
  `OpenableColumns` 得到 display name/size，按 mime 分类 image/audio/file；
- **流式 64KB 复制**到 `filesDir/share-intake/offer-<n>/item-N.<白名单扩展>`，边复制边计数，
  超限（9 项 / 50MB / 200MB）删除半成品并记入 `rejected`（含原因），不整体读进内存；
- 逐项捕获 `SecurityException` / `IOException`：单个失败不影响其他项；
- 签名去重（`action|type|text|uris`），`onNewIntent` 800ms 双投递窗口忽略重复；
- `takePendingShare()` 返回 `{offerId,text,truncated,originalLength,receivedAt,items,rejected}`；
  `clearPendingShare()` 只清引用、不删已交付文件（文件由采集中心接管）。

冷启动与热启动都进入**统一采集中心**（`push("capture")`），不再有独立的分享页；
`src/screens/ShareScreen.tsx` 已删除。分享进来的文件先落私有目录，用户不需要先手动保存。

`plugins/withShareTargetActivity.js` 生成独立的 SEND / SEND_MULTIPLE intent-filter
（`text/* image/* audio/* application/*`），幂等追加。

## 6. 系统快捷入口

`plugins/withShortcuts.js` 生成静态 `res/xml/shortcuts.xml`，4 个入口：

| shortcutId | 动作 | 落地 |
|---|---|---|
| `capture` | 快速采集 | 采集中心 compose |
| `camera` | 拍照采集 | 采集中心 camera 模式 |
| `voice` | 语音速记 | 采集中心 voice 模式 |
| `task` | 新建任务 | 采集中心（意图 task） |

全部指向 `modules/launch-intent` 的 `ShortcutActivity` 跳板：该 Activity 无界面
（`Theme.Translucent.NoTitleBar`、`excludeFromRecents`、`noHistory`），把 `QUICK_ACTION`
写入 SharedPreferences `taskdock_launch_action`（120s TTL），再以 MAIN/LAUNCHER +
`<package>.MainActivity` 启动应用。`LaunchIntentModule.takePendingAction()` 读取即清除，
过期失效。这样冷启动与热启动都只有一条 JS 入口，不创建重复页面实例。

未做（本轮）：快速设置磁贴、通知栏常驻快捷操作。原因：磁贴需要常驻服务/`TileService`
与权限声明，收益低于长按图标；通知栏常驻与「不做后台常驻」的边界冲突。

## 7. 前台自动同步与离线队列

`src/lib/sync/autoSync.ts`。**只在前台运行**：不注册后台任务、不做常驻轮询、
不监听网络变化、不申请前台服务。

触发点（`App.tsx`）：

- `AppState` 变 active（回前台）；
- 本地写入后 `notifyLocalChange()` → 8s 防抖；
- 采集保存成功后立即 `requestAutoSync("manual_after_save")`；
- 系统分享进入、快捷方式进入也会先走采集保存，由保存触发。

判定链（纯函数 `decideAutoSync`，可单测）：

```
开关关闭 → disabled
未配对 / 无令牌 / v1 遗留连接 → unpaired / no_token / legacy_connection
仅 Wi-Fi 且计费或无法判定 → metered_network / unknown_network（fail-closed）
已有同步在途 → in_flight（单飞）
未到退避时间 → backoff
距上次成功 < 5min → too_soon
否则 → ok
```

失败退避 30s → 60s → 120s → 300s（封顶），成功清零。同步本身复用 `engine.syncNow`
（同一把单飞锁、超时、outbox 结算），不复制同步逻辑，因此手动同步与自动同步不会并发。

设置（同步页真实开关，持久化在 `kv`）：

| 键 | 默认 | 说明 |
|---|---|---|
| `sync.auto.enabled` | `1` | 前台自动同步；与 `docs/mobile/11` 的「默认不自动」偏差见 §7.1 |
| `sync.auto.wifi_only` | `1` | 仅非计费网络；网络类型未知按计费处理 |
| `sync.auto.transfer_attachments` | `0` | 附件自动传送，默认关闭，避免向新设备静默传文件 |

状态语义严格区分：**本地保存成功**（业务行已提交、outbox 有记录）→ **等待同步**
（`pendingOps`/`pendingAttachments` 计数）→ **正在同步**（`in_sync`）→
**桌面端已确认**（`lastResult.applied` / `transfer_state=sent`）→ **失败**（`failed` +
原因 + 下次重试时间）→ **冲突**（`conflictCount`，不自动覆盖）。界面不会把
「已保存到本机」写成「已同步」。

### 7.1 与 11-background-sync-design.md 的偏差

`docs/mobile/11` 的保守默认是「默认不自动同步」。本轮改为默认开启**前台**自动同步，
理由：用户明确要求减少手动步骤，且前台同步不涉及后台常驻、不消耗待机电量、
失败静默且状态可见。安全边界不变：仍是 TLS + SPKI 固定 + 设备令牌，附件默认不自动传。
如后续需要更保守，只需把 `sync.auto.enabled` 默认值改为 `0`，无需改代码结构。

## 8. 未实现 / 下一步

| 项 | 状态 | 说明 |
|---|---|---|
| OCR / 文档边缘检测 / 透视校正 / 多图导 PDF | 未实现 | 依赖 ML Kit 或原生图像处理，收益需再评估；不阻塞基础拍照 |
| 语音离线转写 | 未实现 | 未找到可靠且可离线的系统能力；保留 `transcript` 字段与界面入口 |
| 关联已有任务/项目 | 未实现 | 手机端无 `workspace_projects` 同步链路；附件 `owner_entity` 已预留扩展 |
| 大文件断点续传 | 未实现 | 复用互传 v2 分块，但没有跨会话恢复 |
| 后台同步 | 不承诺 | Android 限制，见 11 文档 |

## 9. 验证状态

> 结论口径：自动化测试通过 / 模拟器验证 / 真机验证 / 尚未验证 四者分开记录，不互相冒充。

- 自动化：`npx tsc --noEmit` exit 0；`npx vitest run` 27 文件 / 256 例通过（2026-11-14）。
  新增用例覆盖采集标题与附件描述、保存三去向与幂等、附件传送状态机、暂存仓储、
  自动同步判定与退避、迁移 v6 形状、采集存储路径与 URI 转换。
- 构建：`npx expo prebuild --platform android` 与 `assembleDebug` 结果见
  `tmp/acceptance/mobile-efficiency/report.md`（含命令、退出码与产物路径）。
- 真机：拍照、相册多选、语音录制回放、分享多选、快捷方式冷/热启动、自动同步与附件传送
  等场景的实测状态以该报告为准；**未执行的场景如实标注「未验证」，不以构建成功替代**。

### 9.1 真机验收发现并已修复的问题（2026-11-14 第二轮）

真机（vivo，Android 16，arm64-v8a debug 包）逐项操作后暴露了 5 个真实缺陷，均已在代码层修复：

| 编号 | 现象 | 根因 | 修复位置 |
|---|---|---|---|
| D1 | 录音结束、保存前试听报「录音文件已不存在」，`files/capture-audio/` 为空 | 离开屏幕的 `useEffect` 依赖里带了 `recording`：`setRecording(false)` 触发同一 effect 的 cleanup，调用 `cancelRecording()` → `releaseAll(discard=true)` 删掉了刚录好的文件 | `CaptureScreen` 拆成 `recordingRef` + 空依赖 cleanup |
| D2 | 录音附件 `local_uri` 指向 `files/capture-audio/…`，与「统一附件目录」设计不符，且临时文件与附件共用一条命的路径 | 录音直接拿临时路径入暂存，没有走 `persistIntoCaptureStore` | `finishRecording` 先复制进 `files/capture/`（`kind=audio`），再入暂存，最后删临时文件 |
| D3 | 同一段录音试听仍报「文件不存在」 | `expo-file-system` 返回的 `file://` URI 对中文/空格做了百分号编码，JS 侧只截掉 scheme 就把 `%E8%AD…` 交给 Kotlin `File(path)` | `storage.ts` 新增 `pathFromFileUri`（解码失败退回原文），`handlePlay` 改用它 |
| D4 | 暂存卡名称显示为 `语音 0_05`（冒号被清洗） | 落盘名与展示名共用 `sanitizeFileName` | `persistIntoCaptureStore` 拆出 `displayName`（只去控制字符），落盘名仍用本地生成的 `storageName` |
| D5 | 同步页「待传附件」长期显示旧数字；文件被清理后附件仍显示「待传」 | 附件元数据与字节生命周期不一致，没有任何对账 | `attachments.markAttachmentsMissingFiles()`（启动时执行，缺失 → `failed` + 「本机文件已缺失，请重新采集」） |

附带修复：原生模块拒绝调用时 `Error.message` 里是整段
`Call to function … rejected. → Caused by: java.lang.IllegalStateException: …`，
用户看不懂；`voiceErrorText` 剥掉调用栈前缀只留业务原因（开始/结束/试听三处）。
「我的」页与设备页的「同步需手动发起」文案同步改为「前台自动同步」，避免与 §7 的行为矛盾。

修复后的测试基线：`npx vitest run` **27 文件 / 256 例**通过（新增
`src/lib/capture/__tests__/storagePaths.test.ts` 12 例：文件名清洗、扩展名映射、
存储名生成、`file://` ↔ 路径互转与解码失败回退）。

### 9.2 真机已验证 / 未验证（截至 2026-11-14 23:10）

已验证：

- 快捷方式冷启动 → 拍照采集 → 拍照 → 保存到收集箱：结果卡明示「1 个附件留在本机；
  附件不会自动上传」，DB `attachments` 有 `image/pending` 行，`capture_stash` 归零。
- 快捷方式冷启动 → 语音速记 → 录音 → 停止 → 试听（播放/停止切换正常）→ 保存：
  DB 两条 `audio/pending` 附件均指向 `files/capture/*.m4a`，文件字节与 `size` 一致。
- 热分享文本：进入采集页并把 11 字短语填进输入框，保存按钮随内容启用。
- 分享图片失败隔离：`file://` / MediaStore `content://` 注入均被逐项拒收，
  分别显示「复制文件失败」「没有读取该文件的权限」，其余输入不受影响、可继续保存。
- 同步页：待发送操作 23、待传附件 4、自动同步三项开关、后台同步「不支持常驻」、
  上次自动同步状态「等待重试冷却（manual_after_save）」均为真实库/真实状态。
- 保存为任务：输入 `task-from-capture` → 选「任务」→「创建任务」→ 结果卡「已创建任务」，
  DB `tasks.t_mwgjwpbzxd2kzbxi` 标题一致。
- 启动对账：重启后文件已丢失的旧录音附件被标为 `failed`（「本机文件已缺失，请重新采集」），
  有效附件保持 `pending`。
- 正常启动：桌面图标冷启动进入工作台（最近内容含两条语音收集）。debug 包首连 Metro
  约 15–20s，属调试链路，release 包另行验证。

未验证（不得当作已通过）：

- 相册/文件管理器真实分享图片成功入库、`ACTION_SEND_MULTIPLE` 两项以上：
  adb 注入拿不到 URI 读授权，vivo 分享面板首屏未列出 TaskDock（见报告 R1）。
- 桌面端接收（文本、附件）与文件互传成功链路：本机桌面端未运行，
  同步返回 `Failed to connect to /127.0.0.1:47899`，只能证明失败被正确显示。
- 相册批量导入、文件选择、笔记去向、清空二次确认、voice/task 快捷方式热启动。

## 变更记录

- 2026-11-14 首版：统一采集中心、拍照/相册/文件、语音速记（含未转写语义）、
  分享接收增强（SEND_MULTIPLE）、静态快捷方式、前台自动同步与附件传送状态机；
  明确与 09（文本-only）和 11（默认不自动）的差异，并列出未实现增强项。
- 2026-11-14 第二轮（真机验收后）：修复录音文件误删、录音未进统一附件目录、
  `file://` 百分号编码导致试听失败、展示名被落盘规则改写、附件缺失无对账五个缺陷；
  补齐 `pathFromFileUri` 与对账函数，测试 27 文件 / 256 例；详见 §9.1。
- 2026-11-15 第三轮（专项验收整改）：暂存只删本次 id、9 项/50MB/200MB 配额与真实字节校验、
  文字草稿（kv `capture.draft`）、v7 `capture_commits` 保存幂等、按附件 id 精确发送、
  收集箱/任务/笔记附件条（计数/缩略图/全屏预览/试听/系统预览/删除）、待推送绕过 5 分钟门槛、
  前台可取消退避定时器、`uploading` 启动复位、采集页热启动 `intentNonce`。
  真机已验证草稿恢复、camera/task 快捷动作、三类附件入口与 PDF 打开、语音录制/试听；
  系统分享、相册批量、大文件边界、双端同步仍未验证。测试 29 文件 / 283 例；详见
  `tmp/acceptance/mobile-efficiency-remediation-20261115/report.md`。
- 2026-11-16 布局修复：快速采集页「拍照 / 相册 / 语音 / 文件」四个入口把 `flex: 1` 写在
  `PressableScale` 的 `contentStyle` 上，外层 `Pressable` 仍按内容宽度收缩，整行右侧留空。
  改为 `style={styles.pickerPress}`（外层 `flex: 1`）+ `contentStyle` 只承载视觉属性，
  四格等宽铺满行宽（360dp 屏每格 76dp，320dp 屏 66dp）。`tsc --noEmit` exit 0、
  vitest 54 文件 / 561 例通过；真机视觉复核未执行（设备被并行会话占用、未出新包），详见
  `tmp/acceptance/mobile-capture-picker-row/report.md`。
  同一写法还存在于 `features/capture/CaptureReviewScreen.tsx`（裁剪模式「应用裁剪」）与
  `CaptureImportScreen.tsx`（相册/文件两按钮），本轮未改。

