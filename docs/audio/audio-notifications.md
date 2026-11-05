# 统一提示音与语音播报（v0.13，2026-11-04）

> 状态：已实现。范围只包含「提示音 + 本地系统 TTS + 本地缓存」，不接入云端 TTS、
> 不引入大模型、不扩展语音助手。跨平台仅保留接口边界；本轮只支持 Windows WinRT。

## 1. 架构与唯一调度者

```
Agent 状态迁移 / 任务到期 / 日程提醒
        │ Rust `emit_to("main", "audio-event", { items })`
        ▼
前端 `AudioNotificationService`（App 根组件唯一挂载）
  ├─ 去重（eventId）→ 合并（done 窗口）→ 有界优先级队列 → 串行播放
  ├─ 提示音引擎（Web Audio 合成音调，无音频资源包）
  └─ TTS 引擎（invoke `tts_synthesize`）
         ├─ 持久缓存命中 → 直接播放
         ├─ 内存缓存命中 → 直接播放
         └─ 未命中 → WinRT 合成 → 原子写缓存（仅白名单短语）→ 播放
```

- **只有 `AudioNotificationService` 调度音频**：业务组件不创建 `Audio`、不持有 TTS 实例；
  设置页试听也走同一服务（`previewTone` / `previewSpeech`）。
- `useAudioNotifications()` 只在 `App.tsx` 调用一次；`globalThis.__TD_AUDIO_OWNER__` 阻止同一
  WebView 重复挂载。后端 `audio-event` 一律 `emit_to("main", ...)`，只投递主窗口；停靠胶囊、
  通知窗口、桌面微件窗等其它 WebView 不接收该事件，也不挂载该服务，因此不会重复播放
  （跨窗口唯一性由后端定向投递保证，不依赖单个 WebView 内的全局变量）。
- Rust 只负责「事件广播、合成、缓存、统计」，不播放音频、不阻塞 UI 与主流程；音频失败不影响
  事件入库与通知历史。
- 不新增轮询：完全事件驱动，设置变更通过 Zustand 订阅即时应用。

## 2. 事件与调度规则

后端事件 `audio-event` 载荷（camelCase）：

```json
{ "items": [ { "eventId": "...", "kind": "agent_done", "sourceName": "...", "taskTitle": "..." } ] }
```

| 来源 | eventId | 说明 |
|---|---|---|
| Agent 通知（waiting/failed/completed/disconnected） | `notification_history.id` | 真实数据库行 |
| Agent 开始执行（running 且状态迁移） | `run:{run_row_id}:agent_started:{uuid}` | 无通知也有事件 |
| 任务到期 / 日程提醒 | `reminder:{task_id}:{occurrence}` | 同一期只播一次 |
| 失联扫描 | `stale:{uuid}` | 每次断连唯一 |

- **去重**：以 `eventId` 为准，1024 条 / 10 分钟窗口；不按文本去重。
- **合并**：窗口由**首条** `agent_done` 开启并固定 600ms，后续完成事件不延长终点；缓冲只保留
  「首条事件 + 计数」（`DONE_BATCH_LIMIT=128` 封顶），超限只累加计数、不保留原始对象，
  窗口结束生成一条「多个任务已完成」。等待/失败/到期不合并、不受完成窗口阻塞；
  合并只影响音频，不影响通知历史与业务数据。
- **优先级**：等待(4) > 失败(3) > 任务到期/提醒(2) > 完成(1) > 开始/断连(0)。
- **有界队列**：最多 24 条；队列满时丢弃低优先级或同优先级新事件并计数，普通事件不会饿死
  高优先级。
- **串行播放**：一次只播一条；同一事件先提示音后语音，以提示音最后一个振荡器的
  `onended` 为真实结束信号后才发起合成/播放，计时器只作兜底，绝不叠音；试听占用同一通道。
- **音量 0**：提示音与语音各自 0% 即完全静音（不创建节点、不合成、不播放），
  不给 0 音量补最小振幅；播放中把任一音量调到 0 会立即停止对应通道。
- **取消**：全局静音、关闭 TTS、播放中切换声音/语速、退出均会中止当前播放并清空待播；
  取消提示音立即 `osc.stop(0)` 并断开节点；取消语音立即 `pause()` 并释放 `src`；
  队列中已过期的完成事件在 `QUEUE_TTL` 后丢弃。
- **过期提醒打扰边界**：`overdue_grace_hours` 是「过期后仍允许补提醒」的补偿窗口（小时）。
  准时或窗口内的到期提醒正常发声；**超出窗口**的提醒仍按业务规则入库并推进重复任务期次，
  但 `audio=false`、不补播旧提醒。`notify_reminder=false` 只关闭桌面弹窗，不关闭声音
  （不按 `popup=false` 简单过滤，两者是独立字段）。

## 3. WinRT TTS 选型

- 使用 `windows` 0.62.2（与剪贴板 OCR 共用，不新增第二套绑定）的
  `Windows.Media.SpeechSynthesis.SpeechSynthesizer`，Cargo features：
  `Media_Core`、`Media_SpeechSynthesis`。
- 语音枚举：`SpeechSynthesizer::AllVoices()` → `Id` / `DisplayName` / `Language` / `Gender`。
- 合成：`SetVoice` → `Options().SetSpeakingRate(rate/100)` →
  `SynthesizeTextToStreamAsync` → `DataReader.LoadAsync` → `ReadBytes`；单次上限 32 MB，
  超时 20s，超时取消。
- COM：所有 WinRT 调用都投递到同一条常驻工作线程 `TtsWorker`（`taskdock-tts`），该线程
  **只初始化一次** `CoInitializeEx(COINIT_MULTITHREADED)`，仅在线程结束（应用退出）时配对
  释放；`RPC_E_CHANGED_MODE` 等初始化失败会以结构化 `unsupported` 错误返回。
  - **不要**改成「每次调用 Init/Uninit」（2026-11-04 真机取证）：`windows-core` 的
    `FactoryCache` 是进程级静态并 `forget` 激活工厂指针，进程内最后一个 COM 套间被
    `CoUninitialize` 拆除后该指针失效，再次初始化后调用 `AllVoices` 直接
    `STATUS_ACCESS_VIOLATION`（同一线程连续两次枚举第二次必崩；保持 COM 初始化则正常）。
  - 常驻线程同时天然保证「任意时刻只有一次合成在跑」，退出时由设置退出标志取消在途合成
    后 join，避免带半成品状态退出。
  - **按需启动**（2026-11-05）：`AudioService` 构造只准备磁盘缓存，不创建线程、不
    `CoInitializeEx`；首次真正需要合成/枚举/试听时才在互斥锁内创建一次，并发首次调用共用
    同一条线程。未启用 TTS 的用户启动路径零 COM 成本；初始化失败同样保留实例并以
    `unsupported` 结构化错误返回，不反复重建线程。
- **不启动 PowerShell 子进程**，每次播报都走进程内 API。
- 非 Windows 平台返回 `unsupported` 结构化错误，不做静默降级；本轮不实现 macOS/Linux。

## 4. 声音选择与男女声

- 默认 `tts_voice_gender=auto`，优先系统中文声音；不硬编码任何具体语音名。
- 解析顺序（后端 `tts::resolve_voice`）：
  1. 指定 `voice_id` 且存在于系统 → 精确使用；
  2. `gender=male/female` → 第一个匹配性别的中文语音；
  3. 任意中文语音；
  4. 系统第一个可用语音（标记 `voiceFallback=true`）。
- 无法满足性别偏好时**不伪造选项、不变调**，只是回退并在设置页展示提示；缺少中文男声/女声时
  显示「去 Windows 设置安装语音」，其它声音仍可用。
- 选中语音与实际播放必须一致：设置页切换性别会清空显式 `voice_id`；切换具体语音会同步
  `tts_voice_gender`。合成时按解析后的实际 `voice.id + language + rate` 计算缓存 Key。
- 设置页列出全部系统语音（名称、语言、性别、可用状态），不可用项禁用；已保存但系统已移除的
  语音保留为「当前系统未找到」，不静默改动用户选择。

## 5. 缓存设计

### 5.1 Key 与失效

```
key = SHA-256( format_version, voice_id, language, rate, text )[0..16] → 32 hex
文件名 = <key>.<wav|mp3|audio>
```

- 参与 Key：引擎/格式版本、**实际语音 ID**、语言、语速、文本。
- **音量不参与 Key**：音量只在播放阶段调整，改音量不会重新合成。
- 语速由合成阶段决定（`SetSpeakingRate`），因此必须参与 Key。
- 切换声音/语速 → Key 变化，旧语音不会被复用。
- 格式/引擎版本变化 → 所有旧 Key 失效；旧文件由 LRU 自然回收。
- 文件名不含原文，也不写任何明文播报内容到日志。

### 5.2 目录、写入与清理

- 正式路径：`app_cache_dir/audio/tts/`（自动创建）；隔离运行
  `TASK_DOCK_DATA_DIR` 时使用 `<data>/audio-cache/tts/`，避免污染用户缓存。
- 写入：同目录临时文件 `.tmp-*` → 删除旧目标 → 原子 rename；写失败只影响缓存，不影响本次播放。
- 读取失败/损坏：命中时做**最小格式校验**（扩展名与内容类型、WAV 头 `RIFF/WAVE`、长度与
  `fmt `/`data` 块存在且文件不小于 44 字节），损坏条目立即删除并返回未命中，随后重新合成；
  不做全量解码，保持读性能。
- 删除语义（`clear` / `evict_to` / `remove_entry`）：删除成功才计入释放字节与驱逐数；
  文件不存在视为索引修正（不算释放），权限/占用失败则保留条目并继续处理其它条目，
  结束后按实际磁盘重算总量；绝不删除缓存目录之外的文件，也不假装已释放空间。
- 容量：默认 50 MB（1–2048 可配置）；超限按 mtime（LRU）驱逐，命中触碰 mtime 最多 60 秒一次。
- 清理：只删除缓存扩展名与 `.tmp-*`，不触碰用户其它文件；统计与清理均为 O(文件数)，不建 DB 结构。

### 5.3 固定短语 vs 动态文本

持久缓存白名单（`FIXED_PHRASES`）：

- 任务已完成 / 多个任务已完成 / 需要你的操作 / 执行失败 / 任务提醒时间到 / 日程提醒时间到

- 仅当最终播报文本**完全等于**白名单短语且请求 `persist=true` 时才落盘；带来源名或任务标题的
  动态文本默认不持久化（避免密钥/个人信息/剪贴板敏感内容落盘），只进入内存缓存。
- 内存缓存：16 条 / 8 MB / TTL 5 分钟；关闭磁盘缓存后仍可用于短生命周期复用。
- 后端会二次校验白名单：即使前端误传 `persist=true`，动态文本也不会写入磁盘。

## 6. 预生成

- 首次开启 TTS、切换声音、语速或缓存开关时，服务异步顺序预生成 6 条固定短语。
- 不阻塞启动与 UI；不并行拉起多个合成；真实播报优先（预生成在播放期间让路）。
- 已有有效缓存的短语命中即返回，不重复合成；关闭 TTS 后取消剩余预生成。
- 预生成失败只记录诊断，真正播报时重新尝试，不作为播报前置依赖。

## 7. 设置与默认值

| 键 | 默认 | 说明 |
|---|---|---|
| `audio_sound_enabled` | true | 提示音总开关 |
| `audio_sound_volume` | 70 | 0–100 |
| `audio_sound_agent_*` | started=false, done/waiting/failed/task_due/reminder=true, disconnected=false | 按事件开关 |
| `tts_enabled` | **false** | TTS 总开关 |
| `tts_voice_gender` | auto | auto/female/male |
| `tts_voice_id` | "" | 空=自动 |
| `tts_volume` | 80 | 0–100 |
| `tts_rate` | 100 | 50–200 |
| `tts_speak_source` | true | 播报来源名称 |
| `tts_speak_title` | false | 播报任务标题（敏感，默认关） |
| `tts_agent_*` | 同音效默认 | 按事件播报开关 |
| `tts_cache_enabled` | true | 固定短语持久缓存 |
| `tts_cache_max_mb` | 50 | 1–2048 |

- 提示音与 TTS 总开关彼此独立，同时服从 `notify_muted`；暂停静音会停止当前音频，但不清通知
  历史、不停提醒调度、不停 Agent 采集。
- 旧键 `agent_alert_sound=false`（且无新事件键）只映射关闭 waiting/failed 提示音，避免升级后
  突然响铃；不连带关闭其它默认事件。
- 所有新键已加入 `ALLOWED_KEYS` 与 `validate_setting`；未新增数据表，因此不涉及
  `BACKUP_TABLES`。

## 8. IPC 命令

| 命令 | 用途 |
|---|---|
| `tts_list_voices` | 枚举系统语音、中文男/女声可用性、平台 |
| `tts_synthesize` | 合成/取缓存，返回 data URL、实际语音、是否命中、耗时 |
| `tts_cache_stats` | 容量、文件数、命中/未命中/写入/驱逐、内存命中 |
| `tts_cache_clear` | 一键清理并返回释放字节与文件数 |

合成与枚举均在 `spawn_blocking` 中执行，不阻塞 Tauri 主线程。

## 9. 已知限制与失败处理

| 场景 | 行为 |
|---|---|
| 无中文语音 | 回退任意可用语音并标记 fallback；无语音则结构化 `no_voice` |
| 缺中文男/女声 | 设置页明示不可用并提示安装；不伪造、不变调 |
| TTS API 不可用 / 非 Windows | `unsupported`，不初始化引擎 |
| 无音频输出设备 | `<audio>` 播放失败只记诊断（失败计入 `ttsFail`，不伪造成功），不影响业务 |
| 缓存目录无写权限 / 磁盘满 | 写失败仅跳过缓存，本次仍播放合成结果 |
| 缓存文件损坏 | 最小格式校验失败 → 删除条目并重新合成，不把坏音频交给播放器 |
| 缓存删除被占用/拒绝 | 保留条目、不计释放，容量统计按实际磁盘重算 |
| 合成中取消/切换声音/语速 | generation/epoch 校验丢弃旧结果，不播放旧声音或旧参数音频 |
| 音量 0 | 完全不发声，不创建音频节点、不发起合成；试听返回 `silent_tone`/`silent_speech` 并提示单通道静音，不报成功 |
| `AudioContext.resume()` 失败 | 3s 超时/异常明确 reject，不把自动播放失败当作播放成功 |
| 睡眠恢复 | 事件驱动，不补播；超补偿窗口的旧提醒只入库/推进、不发声 |
| 退出 | 服务 `dispose()` 停止播放、取消预生成、关闭 AudioContext；Rust 退出时取消在途合成并 join 常驻线程 |

## 10. 验证与证据

- 自动化：`src/lib/audioNotification.test.ts`、`src-tauri/src/audio/{cache,tts,mod}.rs` 单测、
  `commands/settings.rs` 校验测试、`db/mod.rs` 旧配置迁移测试。
- 真机取证：`src-tauri/tests/audio_winrt_manual.rs`（`#[ignore]`），输出语音元数据、首次合成
  与缓存命中耗时，证据见 `tmp/acceptance/audio-tts-cache/`。
- 本机语音可用性与真实听感以验收报告「已验证/未验证」为准；未安装的性别如实标注未验证。

## 11. 2026-11-04 第二轮修复与更正记录

> 本轮结论由「部分通过」更正为下表状态；历史记录保留。以下只列真实改动与可复核证据，
> 未执行项在验收报告中标注「未验证」。

### 11.1 P1 修复

| 编号 | 根因 | 修复 |
|---|---|---|
| P1-01 音效/TTS 重叠 | 时长混用秒与毫秒（`(n-1)*gap + 360`）估算完成时刻 | 统一秒单位 `TONE_NOTE_SECONDS`；以最后一个振荡器 `onended` 为真实结束，服务 `await` 后才合成；计时器仅兜底；abort 立即 `stop(0)`+`disconnect`+清监听器 |
| P1-02 音量 0 仍发声 | `Math.max(0.02, 0.15*v/100)` 给 0 补最小振幅 | `toneGain()`：0 → 0，其余线性 `0.15*v/100`；服务层 0% 跳过排程/合成；播放中调 0 立即 abort 对应通道；试听同规则 |
| P1-03 完成合并无界 | `push(...)` + 每个新事件重置定时器 | 首条开启固定 600ms 窗口、不再延长；只保留首条 + 计数，`DONE_BATCH_LIMIT=128` 封顶；超限只累加计数；waiting/failed 不经完成窗口；销毁/静音清理定时器与缓冲 |
| P1-04 超窗旧提醒发声 | `audio-event` 只按通知插入结果过滤 | `FiredNotify.audio` 仅窗口内为 true；超窗仍入库/推进重复任务但 `audio=false`；`notify_reminder=false` 保留声音仅关弹窗；音频事件定向 `emit_to("main")` |

### 11.2 P2 修复

| 编号 | 修复 |
|---|---|
| P2-01 切换声音/语速仍播旧语音 | 三通道 controller 分离 + `speechEpoch`；合成前捕获 epoch，回来时 epoch 或 voice/gender/rate/音量变化则计 `ttsCancelled` 且不播；关闭 TTS 只停语音、不影响提示音；不重建服务 |
| P2-02 缓存损坏检测不足 | 命中时最小 WAV 校验（`RIFF/WAVE`、长度、`fmt `/`data`），不做全量解码；损坏即删条目并 miss |
| P2-03 删除失败统计不一致 | `DeleteOutcome{Deleted,Missing,Failed}`；仅 Deleted 计释放/驱逐，Missing 修正索引，Failed 保留条目；结束 `recompute_total()` |
| P2-04 AudioContext 生命周期 | 单例复用、`dispose()` 关闭并置空；`resume()` 3s 超时与异常明确失败；节点/监听器清理；播放失败不误计成功 |

### 11.3 诊断语义

- `AudioDiagnostics` 新增 `ttsCancelled`、`synthesizing`、`speaking`，区分「合成中 / 等待队列中 /
  实际播放中」；只有真实播放完成才计 `ttsOk`/`played`，取消既不计成功也不计失败。

### 11.4 本轮证据（`tmp/acceptance/audio-tts-cache/`）

- `vitest-round2-2026-11-04.txt`：2 文件 38/38 通过（服务 33 + 设置 5，22:55）。
- `cargo-audio-round2-2026-11-04.txt`：`cargo test --lib audio::` 17/17。
- `cargo-scheduler-round2-2026-11-04.txt`：`cargo test --lib scheduler::` 15/15（含超窗静默、
  仅关弹窗保留声音）。
- `cargo-settings-round2-2026-11-04.txt`：`cargo test --lib commands::settings` 6/6。
- `winrt-manual-round2-2026-11-04.txt`：`audio_winrt_manual` 4/4（首次 66606 B/56 ms，
  命中 6 ms，语音+语速 4 条目，4 线程并发 `writes=1 hits=3`）。
- `tsc-round2-2026-11-04.txt`：仅外部会话文件 `GlobalSearchDialog.tsx` TS2345；
  `vite-build-round2-2026-11-04.txt`：打包成功（1825 modules，6.25s）。
- 详表见 `tmp/acceptance/audio-tts-cache/report-round2-2026-11-04.md`。

## 12. 2026-11-05 第三轮修复记录

> 本轮只做增量核查与修复；第二轮 P1/P2 修复经复核仍在代码中，不重复实现。以下均为
> 当轮真实改动。

| 编号 | 事实与根因 | 修复 |
|---|---|---|
| P2-01 TTS 提前初始化 | `AudioService::new()` 无条件 `TtsWorker::new()`，启动路径创建 WinRT 线程并最多阻塞 5s 等 COM | `worker: Mutex<Option<Arc<TtsWorker>>>` 懒加载；锁内单次创建，并发首次复用；失败保留实例并结构化返回；`shutdown()` 只释放已创建线程。常驻线程单次 `CoInitializeEx` 不变 |
| P2-03 工作线程无界积压 | `TtsWorker` 使用无界 `mpsc::channel`，满载时静默排队 | 改为 `sync_channel(16)` + `try_send`；满载立即返回 `TtsError::Busy`（`code=busy`，可重试），不阻塞调用线程、不新增第二套队列；关闭后请求返回 `synthesis_failed` |
| P2-02 试听音量 0 误报成功 | `previewTone` 音量 0 返回 `ok=true`；`previewSpeech` 音量 0 仍合成并返回成功 | 音量 0 直接返回 `silent_tone` / `silent_speech`，不播放、不合成；设置页显示明确单通道静音提示；全局静音仍优先返回 `muted` |
| 缓存边界 | `rescan()` 把目录内任意 `.wav/.mp3/.audio` 纳入索引，可能误删用户文件 | 只索引 32 位小写十六进制 Key + 允许扩展名的本服务文件；用户文件不进索引、不被清理 |

### 12.1 试听结果语义

| 场景 | `code` | UI 提示 |
|---|---|---|
| 全部静音 | `muted` | 已开启全部静音，试听被跳过 |
| 提示音通道 0% | `silent_tone` | 提示音音量为 0%，未播放，请调高后再试听 |
| 语音通道 0% | `silent_speech` | 语音音量为 0%，未合成也未播放，请调高后再试听 |
| 正在播报 | `busy` | 正在播报通知，请稍后再试听 |
| 成功 | `ok` | 试听完成（含实际语音名/回退标记） |

### 12.2 第三轮证据

- 见 `tmp/acceptance/audio-tts-cache/report-round3-2026-11-05.md` 与同目录 `*-round3-*`。
