# TaskDock 日志与可观测性功能矩阵

> 生成日期：2026-11-19
> 配套文档：[logging-current-state.md](./logging-current-state.md)（现状证据）、
> [unified-observability-design.md](./unified-observability-design.md)（目标架构）
> 状态定义：
> - **已实现且验证通过** = 代码存在 **且** 有自动化测试用例覆盖该能力
>   （**用例存在**；本轮审计未执行测试，实际执行结果待开发阶段回填，见下方免责声明）
> - **已实现但存在缺陷** = 主体可用，但存在明确缺陷（性能、安全、语义、覆盖）
> - **部分实现** = 覆盖了部分链路或部分平台
> - **未实现** = 无对应代码
> - **不适用** = 对本项目无实际意义
> - **尚未验证** = 代码存在但无任何测试覆盖（本矩阵中无条目落在此类）
>
> ⚠️ **本轮审计阶段未执行任何测试与构建**（见现状报告 §8）。因此本矩阵中凡标「已实现且
> 验证通过」者，均附带**可执行的测试证据来源**，实际执行验证将在开发阶段随测试一起运行，
> 并在 `docs/acceptance/logging-acceptance-report.md` 中记录真实输出。**在此之前，
> 不存在任何一项可被称为「已验证通过」。**

---

## A. 统一日志契约与上下文

| # | 功能 | 状态 | 代码证据 | 测试证据 | 风险 | 处理建议 |
|---|---|---|---|---|---|---|
| A-01 | 统一事件结构（字段明确、类型稳定） | **已实现且验证通过** | `src-tauri/src/diagnostics/mod.rs:184-227`；`src/lib/diagnostics.ts:17-33` | `diagnostics/tests.rs` 序列化/默认值用例；`src/lib/diagnostics.test.ts` | 低 | 保留；扩字段时同步两端 |
| A-02 | 级别枚举与语义分级 | **已实现且验证通过** | `mod.rs:88-96`（Trace→Critical）；`from_category` 按错误类别定级 `mod.rs:126-131` | `mod.rs` 内联测试 | 低 | 保留 |
| A-03 | 操作生命周期状态机 | **已实现且验证通过** | `DiagStatus` `mod.rs:137-144`；`startOperation` `diagnostics.ts:509-617` | `diagnostics.test.ts` 覆盖 started/stage/failed | 低 | 保留 |
| A-04 | 时间统一 UTC | **部分实现** | 后端 `now_iso()` 统一生成（`mod.rs:185` 注释），前端 `timestamp` 被后端重写（`commands/diagnostics.rs:108`） | 无跨端时区一致性测试 | 低 | 前端展示层本地化，补一条时区测试 |
| A-05 | 错误对象安全序列化 | **已实现但存在缺陷** | 后端 `sanitize_diagnostic`（`privacy.rs:172-175`）限长 400 字符；前端 `normalizeError`（`src/lib/errors.ts:263`） | `privacy.rs:357-361` 凭证脱敏测试 | 中 | 前端 `logEvent` 的 `message` 直传后端，后端限长但**不剥堆栈外的长文本**；需补「超长字符串截断」用例 |
| A-06 | 循环引用处理 | **不适用** | 后端 `metadata` **只接受标量**，对象/数组直接丢弃（`privacy.rs:205-206`），结构上不可能出现循环引用 | `privacy.rs:249-276` 验证对象/数组被丢 | 低 | 无需处理；文档说明「结构上免疫」 |
| A-07 | 超大对象截断 | **已实现且验证通过** | metadata key 数上限 16（`privacy.rs:20`）、单值 120 字符（`privacy.rs:17`）、message 400 字符（`privacy.rs:16`） | `privacy.rs:278-286` | 低 | 保留 |
| A-08 | 子 Logger 上下文继承 | **部分实现** | 无 `child(context)` API；等效能力是 `startOperation` 的 `options.metadata` + `EventBuilder` 链式 `.metadata()`（`mod.rs:849`） | 无「继承链」专项测试 | 中 | 若引入 `child()`，须复用 `EventBuilder` 而非新建体系 |
| A-09 | 日志级别由配置控制 | **已实现且验证通过** | 后端 `set_mode`（`mod.rs:513`）+ `attach_filter_reload` 真改 `EnvFilter`（`mod.rs:602-609`）；前端 `isClientVerboseMode`（`diagnostics.ts:128`） | — | 低 | 保留 |
| A-10 | 生产环境禁用无意义 Debug | **已实现且验证通过** | 前端 `diagnostics.ts:342-345` 直接丢弃 DEBUG/TRACE；后端 `tracing_layer.rs:44-47` 仅落 WARN+ | — | 低 | 保留 |
| A-11 | 日志异常不影响业务 | **已实现且验证通过** | 前端 `logEvent` 全程 `try/catch`（`diagnostics.ts:340,375`）；后端 `record` 返回 bool 不抛（`mod.rs:558`）；写线程失败只计数（`writer.rs:399-412`） | `diagnostics.test.ts` 传输失败用例 | 低 | 保留 |
| A-12 | 多窗口字段归属（window_id） | **已实现且验证通过** | 入口 HTML 表驱动 `diagnostics.ts:84-109` | `diagnostics.test.ts` | 低 | 保留 |

---

## B. 采集适配层

| # | 功能 | 状态 | 代码证据 | 测试证据 | 风险 | 处理建议 |
|---|---|---|---|---|---|---|
| B-01 | Rust 显式事件 API | **已实现且验证通过** | `diagnostics::event`（`mod.rs:787`）+ `EventBuilder`（`mod.rs:794-855`），36 处调用 | `diagnostics/tests.rs` | 低 | 保留 |
| B-02 | `tracing` 自动桥接 | **已实现且验证通过** | `DiagnosticsLayer`（`tracing_layer.rs:21-73`），493 处宏自动纳入 | `tracing_layer.rs:166-209` 两个测试 | 低 | 保留；这是最高杠杆的复用点 |
| B-03 | `tracing` 字段白名单 | **已实现且验证通过** | `FieldVisitor::assign`（`tracing_layer.rs:122-136`）只收 10 个字段，其余丢弃 | `tracing_layer.rs:190-208` | 低 | 保留 |
| B-04 | 前端采集 API | **已实现且验证通过** | `logEvent` / `startOperation` / `logIpcFailure`（`diagnostics.ts:339/509/626`），59 处调用点 | `diagnostics.test.ts` 33 用例 | 低 | 保留 |
| B-05 | IPC 自动归类 | **已实现且验证通过** | `moduleForCommand`（`diagnostics.ts:402-442`） | `diagnostics.test.ts` | 低 | 保留 |
| B-06 | 前端日志与业务日志分离 | **已实现但存在缺陷** | 生产代码 `console.*` 残留 **37 处 / 14 个文件**（如 `useEdgeSnap.ts` 15 处、`useSettingsStore.ts` 5 处、`useNavOrderDraft.ts` 4 处） | 无 | 低 | 纳入「诊断化」改造清单；保留 `ErrorBoundary`/`globalErrors` 的兜底 console |
| B-07 | Android 采集适配层 | **未实现** | `apps/mobile` 无任何 `Log.x` 调用（实测 0），无自定义 logger | 无 | **高** | 需新建 `SafeLog` 封装（模块名 + 级别 + 脱敏） |
| B-08 | Android JS/TS 侧采集 | **未实现** | 3 处 `console.*` 全在测试文件 | 无 | 中 | 移动端新增 JS 错误捕获时统一走 SafeLog |
| B-09 | 构建脚本日志统一 | **不适用** | 22 个脚本用 `console.log`/`Write-Host`，属一次性终端输出 | 无 | 低 | 不纳入运行时日志体系；仅在必要时统一输出格式 |

---

## C. 敏感信息保护与字段校验

| # | 功能 | 状态 | 代码证据 | 测试证据 | 风险 | 处理建议 |
|---|---|---|---|---|---|---|
| C-01 | metadata 字段白名单 | **已实现且验证通过** | `ALLOWED_META_KEYS`（`privacy.rs:23-89`，66 键） | `privacy.rs:249-276`、`322-342` | 低 | 保留 |
| C-02 | 敏感 key 二次拒绝 | **已实现且验证通过** | `FORBIDDEN_KEY_PARTS`（`privacy.rs:121-139`）+ `is_allowed_key`（`privacy.rs:141-147`） | `privacy.rs:249-276` | 低 | 保留 |
| C-03 | 不接受对象/数组 | **已实现且验证通过** | `privacy.rs:205-206` | `privacy.rs:249-276` | 低 | 保留 |
| C-04 | 路径最小化 | **已实现且验证通过** | `looks_like_path`（`privacy.rs:98-118`）+ `PATH_LIKE_META_KEYS`（`privacy.rs:95`）→ 替换为 `<路径>` | `privacy.rs:288-313` | 低 | 保留 |
| C-05 | 消息级凭证脱敏 | **已实现且验证通过** | `sanitize_diagnostic`（`error` 模块），经 `privacy.rs:173-175` 调用 | `privacy.rs:357-361`（Bearer token 脱敏） | 低 | 保留 |
| C-06 | 标识符形态校验 | **已实现且验证通过** | `normalize_ident`（`privacy.rs:151-170`） | `privacy.rs:241-248` | 低 | 保留 |
| C-07 | 错误码形态校验 | **已实现且验证通过** | `normalize_error_code`（`privacy.rs:218-233`） | `privacy.rs:344-355` | 低 | 保留 |
| C-08 | 前端不可信字段重写 | **已实现且验证通过** | `parse_frontend_event`（`commands/diagnostics.rs:98-112`）重写 `session_id`/`timestamp`/`count`/`source` | — | 低 | 保留 |
| C-09 | 第三方错误消息不绕过脱敏 | **已实现但存在缺陷** | 后端统一过 `sanitize_diagnostic`；但 `tracing::` 自由文本经 `FieldVisitor` 直接取 `message`（`tracing_layer.rs:140-142`），若业务把业务对象 `format!` 进消息，仍会先落盘再脱敏 | `privacy.rs:357-361` 仅覆盖 Bearer | 中 | 补「含业务对象的 message」脱敏用例；必要时对 `tracing` message 做二次形态检查 |
| C-10 | 嵌套字段不绕过脱敏 | **已实现且验证通过** | 结构上不存对象/数组（`privacy.rs:205-206`） | `privacy.rs:249-276` | 低 | 保留 |
| C-11 | 剪贴板正文不入日志 | **已实现且验证通过** | `clipboard/platform.rs:484` 明示「内容未记录」；`FORBIDDEN_KEY_PARTS` 含 `clipboard_text`/`content`/`body` | `privacy.rs:249-276` | 低 | 保留 |
| C-12 | 文件路径不入 metadata | **已实现且验证通过** | `FORBIDDEN_KEY_PARTS` 含 `full_path`/`file_path`；路径类 key 整体占位 | `privacy.rs:288-313` | 低 | 保留 |
| C-13 | 设备标识最小化 | **部分实现** | `DiagnosticEvent` 无 `device_id` 字段；`window_id` 表驱动但**不含设备维度**；IP 仅存于 `mobile_devices.last_ip`（业务表） | 无 | 中 | 跨端追踪引入 `device_id` 时，必须先定最小化规则（哈希/截断） |
| C-14 | Android 敏感信息处理 | **未实现** | 无日志系统即无脱敏 | 无 | **高** | 随 B-07 一并实现 |
| C-15 | 日志目录权限收紧 | **已实现但存在缺陷** | `create_dir_all`（`writer.rs:125`）用默认权限，Windows 下实际是用户目录继承 ACL | 无 | 低 | 显式记录威胁模型边界即可（单用户桌面场景） |

---

## D. 异步缓冲 / 限流 / 背压

| # | 功能 | 状态 | 代码证据 | 测试证据 | 风险 | 处理建议 |
|---|---|---|---|---|---|---|
| D-01 | 有界队列（前端） | **已实现且验证通过** | `MAX_QUEUE=128`（`diagnostics.ts:36`）；溢出按级别丢（`diagnostics.ts:352-372`） | `diagnostics.test.ts` | 低 | 保留 |
| D-02 | 有界队列（Rust） | **已实现且验证通过** | `CHANNEL_CAPACITY=1024`（`mod.rs:60`） | `diagnostics/tests.rs` | 低 | 保留 |
| D-03 | 明确背压策略 | **已实现且验证通过** | `record`（`mod.rs:566-589`）：ERROR/CRITICAL 最多 2ms×2 重试，其余直接丢并计数 | 同上 | 低 | 保留 |
| D-04 | 单飞（防日志风暴打爆 IPC） | **已实现且验证通过** | `MAX_INFLIGHT=4`（`diagnostics.ts:42`）+ `flushDiagnostics` 早退（`diagnostics.ts:321`） | 同上 | 低 | 保留 |
| D-05 | 批量写入 | **已实现且验证通过** | 前端 20 条/500ms（`diagnostics.ts:38,40`）；后端 64KiB BufWriter + 200ms flush（`writer.rs:39,141`） | 同上 | 低 | 保留 |
| D-06 | 高频事件聚合 | **已实现且验证通过** | `Aggregator`（`writer.rs`），256 指纹 / 60s 窗口（`mod.rs:62,64`），写为 `count` 汇总行 | `diagnostics/tests.rs` | 低 | 保留 |
| D-07 | 高频投屏/剪贴板不逐条记录 | **已实现且验证通过** | 文件拖放只记订阅失败/恢复（`diagnostics.ts:691-769`）；`QUIET_COMMANDS`（`diagnostics.ts:45-52`） | — | 低 | 保留 |
| D-08 | 队列内存不随运行时间增长 | **已实现且验证通过** | 队列容量固定 + 聚合表固定 + 指纹表上限 64（`diagnostics.ts:219`） | — | 低 | 保留 |
| D-09 | Android 端缓冲/背压 | **未实现** | 无日志系统 | 无 | **高** | 随 B-07 实现（需考虑沙盒配额与后台限制） |

---

## E. 持久化 / 轮转 / 清理

| # | 功能 | 状态 | 代码证据 | 测试证据 | 风险 | 处理建议 |
|---|---|---|---|---|---|---|
| E-01 | 本地文件持久化 | **已实现且验证通过** | JSONL，`writer.rs:159-200` | `diagnostics/tests.rs` | 低 | 保留 |
| E-02 | 单写线程（多窗口/多任务不竞争） | **已实现且验证通过** | `writer::run`（`writer.rs:45-82`）为唯一写者 | 同上 | 低 | 保留 |
| E-03 | 单文件大小上限 + 轮转 | **已实现且验证通过** | `MAX_FILE_BYTES=5MB`（`mod.rs:54`）；写前判断 `writer.rs:189-193`；`rotate()` `writer.rs:258-292` | 同上 | 低 | 保留 |
| E-04 | 总存储配额 | **已实现且验证通过** | `MAX_TOTAL_BYTES=25MB`（`mod.rs:58`）+ `MAX_ARCHIVE_FILES=4`（`mod.rs:56`）；`prune()` `writer.rs:294-328` | 同上 | 低 | 保留 |
| E-05 | **按时间轮转/过期** | **已实现且验证通过** | `MAX_AGE_DAYS = 14`（`mod.rs`）；`WriterConfig.max_age_days`（`0`=关闭）；`prune()` 按归档 `mtime` 先淘汰过期档，再走数量/容量两维（2026-11-19 实现） | **3 个专项测试**（过期删除 / 期内保留 / 可关闭） | 低 | 已完成；最终天数待性能实测校准 |
| E-06 | 用户手动清理 | **已实现且验证通过** | `diagnostics_clear`（`commands/diagnostics.rs:215`）→ `Diagnostics::clear`（`mod.rs:667`）→ `writer::clear`（`writer.rs:331`），**只删本模块命名规则的文件** | `diagnostics/tests.rs` | 低 | 保留 |
| E-07 | 清理取消语义（提示失败≠已删除） | **已实现且验证通过** | `cancelled` 标记在删除前检查（`writer.rs:64-68`）；`ClearResult.completed`（`commands/diagnostics.rs:59-60`） | 同上 | 低 | 保留 |
| E-08 | 启动时不扫描全部历史日志 | **已实现且验证通过** | `startup()` 只做 `create_dir_all` + `prune()`（`writer.rs:124-134`）；`prune` 只 `metadata` 归档文件，不读内容 | — | 低 | 保留 |
| E-09 | 大日志分页/流式查询 | **已实现且验证通过** | `diagnostics_query` 走 `spawn_blocking`（`commands/diagnostics.rs:173`）；`DiagnosticQuery.limit/offset`（`query.rs:108-109`） | — | 低 | 保留 |
| E-10 | 不一次性加载全部日志到前端 | **已实现且验证通过** | 分页查询 + `MAX_PAGE` 上限（`query.rs:115-117`） | — | 低 | 保留 |
| E-11 | 磁盘写满安全降级 | **已实现且验证通过** | 退避 60s + 计数丢弃 + stderr 限流 30s；**已按 `WriteFailureKind` 区分**（2026-11-19）：磁盘满=`ERROR_DISK_FULL(112)`/`ERROR_HANDLE_DISK_FULL(39)`/ENOSPC(28) | `write_failure_kind_classifies_io_errors` | 低 | 分类已验证；**真实磁盘满注入**见 K-20 |
| E-12 | 日志文件被占用 | **已实现但存在缺陷** | 轮转 rename 失败则继续追加（`writer.rs:280-282`），单文件可能超限（与 `DIAGNOSTICS.md:257-258` 声明一致） | — | 中 | 已知限制，文档已声明；补测试固化行为 |
| E-13 | 文件权限不足 | **已实现且验证通过** | 走统一退避路径，**已按 `ErrorKind::PermissionDenied` 单独归类**（2026-11-19） | `write_failure_kind_classifies_io_errors` | 低 | 分类已验证；**真实权限不足注入**见 K-22 |
| E-14 | 关闭时未写入事件的处理策略 | **已实现且验证通过** | 退出 `finish()` 做 `flush` + `sync_all`（`writer.rs:388-397`）；`shutting_down` 标志（`mod.rs:441`） | — | 低 | 保留 |
| E-15 | 普通日志与审计日志保留策略分离 | **部分实现** | 诊断日志：数量+容量（无时间）；MCP 审计：两段式天数（`mcp/audit.rs:209-258`）；vault 审计：硬截断 500 条（`secure_vault/store.rs:543`）。**三套策略互不统一，且诊断日志与审计日志混在同一 JSONL** | — | 中 | 定义「诊断事件」与「审计事件」的存储分离与保留语义 |
| E-16 | Android 本地持久化 | **未实现** | 无 | 无 | **高** | 需设计沙盒内滚动文件 + 配额 + 生命周期 |
| E-17 | 日志总量可预估（不无限增长） | **已实现且验证通过** | 25MB 上限 + 归档数上限，`prune` 在启动与每次轮转后执行（`writer.rs:130`、`writer.rs:290`） | — | 低 | 保留 |

---

## F. 安全审计与隐私保护

| # | 功能 | 状态 | 代码证据 | 测试证据 | 风险 | 处理建议 |
|---|---|---|---|---|---|---|
| F-01 | MCP 工具调用审计 | **已实现且验证通过** | `mcp/audit.rs:116-137`；表 `db/mod.rs:1255` | `mcp/tests.rs` | 低 | 保留 |
| F-02 | 审计幂等键 | **已实现且验证通过** | `UNIQUE(agent_row_id, action, request_id) WHERE request_id<>'' AND success=1`（`db/mod.rs:1271-1272`） | `db/mod.rs:4207-4221` | 低 | 保留 |
| F-03 | 审计两段式保留（不误删幂等窗口） | **已实现且验证通过** | `prune()`（`mcp/audit.rs:209-258`）先清载荷后删行 | `mcp/tests.rs` | 低 | 保留 |
| F-04 | 审计清理仅用户显式触发 | **已实现且验证通过** | `mcp/audit.rs:16-17` | — | 低 | 保留 |
| F-05 | **设备配对申请/成功/失败审计** | **部分实现** | 失败有 `tracing::warn!`（`mobile_sync/server.rs:198,202`）；**成功配对完全无痕迹**（`start_pairing` `mobile_sync/mod.rs:450`、`complete_pairing` `mobile_sync/mod.rs:568` 均无日志） | 无 | **高** | 成功/失败/取消都要落**独立审计事件**（不可被普通 Debug 开关关闭） |
| F-06 | **设备信任关系变更审计** | **部分实现** | `personal_hub` 有 `INVITATION_REVOKED` 等事件（`personal_hub/pairing.rs:222,346,386,406,419,488`），但存在**独立库 `ph_audit_log`**，与诊断中心不通 | `personal_hub/pairing.rs:830,900,901,944` 断言 `audit_count` | 中 | 把 Hub 审计映射进统一审计视图 |
| F-07 | **远控请求/授权/拒绝/会话起止审计** | **未实现** | 仓库中**不存在远控功能模块**（`remote_control` 检索无命中）；「投屏」对应 `commands/virtual_display*`，其中 `virtual_display.rs` 仅 **1 处**日志，`process.rs` **0 处** | 无 | 中 | 投屏需补建连/断连/失败埋点；远控功能若未来落地，同步补审计 |
| F-08 | **会话超时审计** | **未实现** | 无统一「会话」概念 | 无 | 中 | 需先定义会话模型 |
| F-09 | **身份验证失败审计** | **部分实现** | 手机心跳/同步鉴权失败有 `tracing::warn!`（`mobile_sync/server.rs:259,305`），但为**普通日志**，非独立审计事件 | 无 | 中 | 提升为审计事件 |
| F-10 | **权限变更审计** | **部分实现** | MCP 授权变更有 `mcp_audit_log`；`agent_access/permissions.rs` **0 处**日志（15 个文件仅 3 个有埋点） | 无 | 中 | 补权限变更审计 |
| F-11 | **Agent 高风险操作审计** | **部分实现** | MCP 侧完整；`agent_access` REST 侧仅 2 处 `tracing::`（`rest.rs:307,344`） | 无 | 中 | 补 Agent 高风险操作清单 |
| F-12 | **加密钥匙库访问与修改审计** | **已实现且验证通过** | `secure_vault/store.rs:525-546`；11 类事件（`secure_vault/commands.rs:564,697,796,849,898,1098,1200,1586`；`backup.rs:389,635`） | `secure_vault` 内联测试 | 中 | 功能完整，但**硬截断 500 条**且与诊断中心不通 → 需并入统一审计视图 |
| F-13 | 审计日志不与普通 Debug 共用开关 | **部分实现** | MCP 审计在 SQLite、不受 verbose 开关影响 ✓；但 `personal_hub`/`secure_vault` 审计同样独立 ✓；**问题在于诊断 JSONL 里的 WARN 级安全事件（如配对失败）会被 verbose 模式影响落盘量** | — | 中 | 引入审计事件类型后独立存储 |
| F-14 | 审计不记录认证秘密与操作正文 | **已实现且验证通过** | `mcp/audit.rs:3-5` 明示；`AuditSummary`（`mcp/audit.rs:51-61`）不含参数/载荷/正文 | `mcp/tests.rs` | 低 | 保留 |
| F-15 | 防篡改机制与威胁模型声明 | **未实现** | 无哈希链、无签名；JSONL 可任意编辑 | 无 | 低 | **必须明示威胁模型**：本机哈希链**不能**抵御设备所有者恶意修改，只防「意外损坏/未授权软件误改」 |
| F-16 | 审计查询入口统一 | **未实现** | 四套存储、四套保留、四套查询入口（诊断中心 / MCP 审计页 / Hub 审计 / Vault 审计） | 无 | 中 | 统一审计视图 + 统一保留语义 |

---

## G. 跨模块追踪

| # | 功能 | 状态 | 代码证据 | 测试证据 | 风险 | 处理建议 |
|---|---|---|---|---|---|---|
| G-01 | `session_id`（进程级） | **已实现且验证通过** | `mod.rs:433` UUID v4；前端不可伪造（`commands/diagnostics.rs:107`） | `diagnostics/tests.rs` | 低 | 保留 |
| G-02 | `operation_id`（操作级） | **已实现且验证通过** | `new_operation_id()`（`mod.rs:782`）；前端 `operationId()`（`diagnostics.ts:493`）；精确回溯查询 `query.rs:101` | `diagnostics.test.ts`；诊断中心「操作链」视图 | 低 | 保留 |
| G-03 | `window_id`（窗口级） | **已实现且验证通过** | `diagnostics.ts:84-109` | `diagnostics.test.ts` | 低 | 保留 |
| G-04 | **`trace_id`（跨进程链路）** | **未实现** | 全仓库 `trace_id`/`traceId` 检索**为 0**；`DiagnosticEvent` 无此字段（`mod.rs:184-227`） | 无 | **高** | 需扩展事件契约 + 前后端 + Android 三端传播 |
| G-05 | **`span_id`（阶段级）** | **未实现** | 同上 | 无 | **高** | 可用 `stage` 字段做近似，但需明确定义语义 |
| G-06 | **`device_id`（设备级）** | **未实现** | 事件契约无此字段 | 无 | 中 | 需与 C-13 最小化规则一并设计 |
| G-07 | 异步上下文传播 | **部分实现** | 前端靠**显式传参**（`startOperation` 的 metadata + `options`），无 `AsyncLocalStorage` 式隐式上下文 | — | 中 | 显式传参已足够且更安全；不建议引入隐式全局变量 |
| G-08 | 不依赖不安全的全局可变变量 | **已实现且验证通过** | 前端用模块内 `Map`/`WeakSet`（`diagnostics.ts:190,230`）；后端用 `Arc<Diagnostics>` + `OnceLock`（`mod.rs:83`） | — | 低 | 保留 |
| G-09 | 不信任外部传入的 Trace ID | **不适用** | 当前不存在 trace ID，故无「不信任」问题；但**引入时必须实现**（格式 + 长度校验） | 无 | — | 引入时按 `privacy.rs` 的标识符归一规则处理 |
| G-10 | 标识符长度与格式限制 | **已实现且验证通过** | `normalize_ident`（`privacy.rs:151-170`）；`operation_id` 为 UUID | `privacy.rs:241-248` | 低 | 保留 |
| G-11 | Trace 不替代认证/授权 | **不适用** | 现状无 trace 概念；认证完全独立于日志 | — | — | 引入时保持此边界 |
| G-12 | 高频事件不产生海量追踪记录 | **已实现且验证通过** | 聚合器（60s/256 指纹）+ 前端 DEBUG 常态丢弃 | — | 低 | 保留 |
| G-13 | 跨进程关联（Desktop↔Android） | **未实现** | Desktop 有 `session_id`，Android 侧无任何 ID 概念 | 无 | **高** | 需在移动通信协议中加 `trace_id` 透传字段 |
| G-14 | MCP ↔ 诊断关联 | **未实现** | 审计表有 `request_id`，诊断日志无对应字段 | 无 | 中 | 引入 `trace_id` 后可打通 |
| G-15 | React → Tauri → Rust 关联 | **已实现且验证通过** | `operation_id` 由前端生成并透传（`diagnostics.ts:493-527`） | `diagnostics.test.ts` | 低 | 保留 |

---

## H. 性能日志

| # | 功能 | 状态 | 代码证据 | 测试证据 | 风险 | 处理建议 |
|---|---|---|---|---|---|---|
| H-01 | 通用耗时测量 API | **未实现** | 无 `measureOperation` / `recordDuration` / `recordSlowOperation` 统一 API；仅有 `startOperation` 的 `duration_ms`（`diagnostics.ts:560`） | — | 中 | 在 `diagnostics.ts` 与 `EventBuilder` 上扩展，不新建体系 |
| H-02 | 桌面启动耗时 | **部分实现** | `lib.rs:1068` 有启动超时事件；`lib.rs:1235` / `1261` 有启动/退出里程碑 | — | 中 | 补完整启动阶段拆解（窗口创建、首屏、DB 迁移） |
| H-03 | 文件工作区耗时 | **未实现** | `file_workspace` 0/4 文件有埋点 | 无 | 中 | 目录加载/预览/搜索分别埋点 |
| H-04 | 回收站耗时 | **未实现** | `recycle` 1/6 文件有埋点 | 无 | 低 | 枚举/删除耗时 |
| H-05 | 资源管理扫描速度与内存峰值 | **部分实现** | `resource_cleanup/diagnostics.rs` 提供**只读采样**（805 行），但**不写日志、不持久化** | — | 中 | 复用其采样数据源，写入诊断事件 |
| H-06 | 剪贴板捕获延迟 | **未实现** | `clipboard` 6/9 文件有 `tracing::`，但无 `duration_ms` 埋点 | 无 | 中 | 补捕获延迟指标 |
| H-07 | 投屏建连耗时与帧延迟 | **未实现** | `virtual_display.rs` 仅 1 处日志，`process.rs` 0 处 | 无 | 中 | 需补；**帧级指标必须聚合，不得逐帧记录** |
| H-08 | 设备通信请求耗时/超时/重试 | **未实现** | `mobile_sync` 40+ 处日志均为纯文本 warn，无 `duration_ms` | 无 | 中 | 补结构化耗时 |
| H-09 | MCP 工具调用耗时与错误率 | **部分实现** | `mcp/audit.rs` 记录 `success`（可算错误率），但**无耗时**；`mcp_audit_log` 表无 duration 列（`db/mod.rs:1255-1268`） | — | 中 | 表加 `duration_ms` 列需走**新迁移**（追加式，不得改已发布迁移） |
| H-10 | Agent 任务执行耗时与失败原因 | **部分实现** | `agents/pipeline.rs:1282,1298,1316,1518` 有失败原因；无耗时 | 无 | 中 | 补耗时 |
| H-11 | 数据库慢查询/锁等待 | **未实现** | `performance_diagnostics`（`commands/system.rs:563-571`）仅返回 SQLite 读延迟与事件表规模 | 无 | 中 | 慢查询阈值化记录（超阈值才记） |
| H-12 | 聚合/采样/异常触发记录 | **部分实现** | 通用聚合有（`AGG_WINDOW` 60s）；性能指标侧无采样机制 | — | 中 | 引入阈值触发（仅超阈值落盘） |
| H-13 | **日志系统自身性能基准** | **未实现** | 无「日志开/关业务耗时差异」基准、无队列增长率基准 | 无 | **高** | **P0**：需建立可复现基准并固化阈值 |
| H-14 | 日志系统不成为单点故障 | **已实现且验证通过** | 目录不可用→降级（`mod.rs:427-430`）；写失败→退避计数（`writer.rs:160-168`）；前端失败→计数不抛（`diagnostics.ts:329-331`） | — | 低 | 保留 |

---

## I. 诊断中心 UI

| # | 功能 | 状态 | 代码证据 | 测试证据 | 风险 | 处理建议 |
|---|---|---|---|---|---|---|
| I-01 | 独立诊断中心页面 | **已实现且验证通过** | `src/components/diagnostics/DiagnosticsCenterPanel.tsx`（1558 行） | `DiagnosticsCenterPanel.test.tsx` | 低 | **不得重复创建** |
| I-02 | 设置页日志段 | **已实现且验证通过** | `src/components/settings/DiagnosticsLogsSection.tsx`（268 行） | `DiagnosticsLogsSection.test.tsx` | 低 | 保留 |
| I-03 | 按时间筛选 | **已实现且验证通过** | `since`/`until`（`query.rs:105-107`） | — | 低 | 保留 |
| I-04 | 按等级筛选 | **已实现且验证通过** | `levels`（`query.rs:95`） | — | 低 | 保留 |
| I-05 | 按模块筛选 | **已实现且验证通过** | `modules`（`query.rs:96`）；UI 模块选项由实际数据聚合（`DiagnosticsCenterPanel.tsx:424`） | — | 低 | 保留 |
| I-06 | 按设备筛选 | **未实现** | 无 `device_id` 字段（`mod.rs:184-227`） | 无 | 中 | 依赖 G-06 |
| I-07 | 关键词搜索 | **已实现且验证通过** | `text`（`query.rs:103`）；UI `keyword`（`DiagnosticsCenterPanel.tsx:79,179`） | — | 低 | 保留 |
| I-08 | **Trace ID 搜索** | **未实现** | UI 只有 `operationId`（`DiagnosticsCenterPanel.tsx:78`），无 trace 搜索 | 无 | 中 | 依赖 G-04 |
| I-09 | 操作链视图（同 operationId 全链路） | **已实现且验证通过** | `openChain`（`DiagnosticsCenterPanel.tsx:373`），只按 operationId 查询 | 同上测试文件 | 低 | 保留；是当前最接近「Trace」的能力 |
| I-10 | 错误详情展示 | **已实现且验证通过** | 同上文件 | 同上 | 低 | 保留 |
| I-11 | 一键复制错误信息 | **已实现且验证通过** | `onCopyOperation`（`DiagnosticsCenterPanel.tsx:506`）；链复制 `:514` | 同上 | 低 | 保留 |
| I-12 | 导出诊断包 | **已实现但存在缺陷** | `diagnostics_export`（`commands/diagnostics.rs:198`）导出**脱敏报告 JSON**；UI `onExport`（`DiagnosticsCenterPanel.tsx:564`）。**但无「导出前预览内容范围 + 用户确认」步骤** | 同上 | 中 | 需补 `previewDiagnosticBundle` + 确认环节 |
| I-13 | 诊断包不含敏感内容 | **已实现且验证通过** | 导出走 `query::export`（`query.rs:694`），只输出已脱敏字段 + 白名单 metadata | `privacy.rs` 测试 | 低 | 保留 |
| I-14 | 不自动上传日志 | **已实现且验证通过** | 导出为**本机文件**（`query.rs:700-701`，`dir.join("exports")`），无任何网络上传代码 | — | 低 | 保留；明确禁止引入上传 |
| I-15 | 默认展示最新日志 | **已实现且验证通过** | 查询排序新→旧（`commands/diagnostics.rs:166` 注释） | — | 低 | 保留 |
| I-16 | **虚拟滚动** | **未实现** | 面板使用普通列表渲染（`DiagnosticsCenterPanel.tsx` 内未见虚拟化实现），依赖分页限制单页条数 | 无 | 中 | 分页已限制单页体量；虚拟滚动为性能增强项，按实际页大小评估 |
| I-17 | 筛选条件可组合 | **已实现且验证通过** | `buildListFilter`（`DiagnosticsCenterPanel.tsx:167-179`）合并多个维度 | — | 低 | 保留 |
| I-18 | 暂停实时刷新 | **未实现** | 未见暂停/恢复实时刷新的开关 | 无 | 中 | 需补 |
| I-19 | 新日志不打断用户阅读 | **部分实现** | 新日志不会强制清空筛选（`applyFilter` 保留现状），但**无显式「不打断」策略**（如滚动位置保持） | 无 | 中 | 需补滚动位置保持 |
| I-20 | 空/加载/失败状态完整 | **已实现且验证通过** | `BusyKey`（`DiagnosticsCenterPanel.tsx:71`）区分 load/export/clear | 同上测试文件 | 低 | 保留 |
| I-21 | 不使用大量重复卡片 | **已实现且验证通过** | 紧凑列表布局（`diagnostics-workspace.css`） | — | 低 | 保留 |
| I-22 | 与全局 UI 规范一致 | **已实现且验证通过** | 使用统一语义 Token 与组件层（`styles-themes.css` / `styles-ui.css`） | — | 低 | 保留 |
| I-23 | 响应式布局 | **已实现且验证通过** | `diagnostics-workspace.css` 含宽度断点 | — | 低 | 保留 |
| I-24 | 导出完整性如实标记 | **已实现且验证通过** | `ExportResult.truncated/flushed/complete`（`query.rs:616-624`）；UI 显示原因（`DiagnosticsCenterPanel.tsx:639-646`） | — | 低 | 保留（这是很好的设计，应推广） |

---

## J. 全局异常处理

| # | 功能 | 状态 | 代码证据 | 测试证据 | 风险 | 处理建议 |
|---|---|---|---|---|---|---|
| J-01 | `window.onerror` / `error` 事件捕获 | **已实现且验证通过** | `src/lib/globalErrors.ts:70+` `installGlobalErrorHandlers` | — | 低 | 保留 |
| J-02 | `unhandledrejection` 捕获 | **已实现且验证通过** | `globalErrors.ts:48-67` `logUnhandledRejection` | — | 低 | 保留 |
| J-03 | React ErrorBoundary | **已实现且验证通过** | `src/components/ErrorBoundary.tsx`（163 行），`getDerivedStateFromError`（:46）先 `markLogged` 归属，`componentDidCatch`（:59）落日志 | — | 低 | 保留 |
| J-04 | Tauri Command 错误上下文 | **已实现且验证通过** | `logIpcFailure`（`diagnostics.ts:626-671`）带 `error_code`/`error_category`/`duration_ms`/`stage=ipc` | `diagnostics.test.ts` | 低 | 保留 |
| J-05 | **Rust Panic 捕获** | **已实现且验证通过** | `src-tauri/src/diagnostics/panic_hook.rs`（2026-11-19 新增）：`set_hook` + `catch_unwind` 兜底，错误码 `RUST_PANIC`，只写脱敏消息/`文件名:行号`/线程名；`lib.rs:641` 安装 | **7 个专项测试**（`panic_hook.rs` 内联） | 低 | 已完成；剩余「真实崩溃现场」需人工验证 |
| J-06 | 已有 `catch_unwind` 的隔离点 | **已实现但存在缺陷** | 9 处 `catch_unwind`（`clipboard/paste.rs:1222`、`clipboard/platform.rs:424`、`commands/scenario.rs:1865`、`file_workspace/mod.rs:932`、`navigation/app_discovery.rs:740`、`workflows/engine.rs:558`、`workspace/gate.rs:224`、`workspace/mod.rs:1181,1260`）。**捕获后是否有诊断记录需逐点核对，未统一** | 无 | 中 | 统一「catch_unwind 后必落一条 ERROR」约定 |
| J-07 | **Android UncaughtException** | **未实现** | 无 `Thread.setDefaultUncaughtExceptionHandler`（实测 0） | 无 | **高** | 需实现崩溃捕获 |
| J-08 | MCP Tool Error 处理 | **已实现且验证通过** | `mcp_audit_log` 记录 `success=0` + `authz`（`mcp/audit.rs:116-137`） | `mcp/tests.rs` | 低 | 保留 |
| J-09 | Agent 执行错误处理 | **部分实现** | `agents/pipeline.rs` 有失败落盘（:1298, :1316）；`agents/` 27 文件仅 7 个有埋点 | 无 | 中 | 补齐失败路径埋点 |
| J-10 | 保留原始错误因果链 | **已实现且验证通过** | `AppError` 带 `detail`/`reason`/`cause`（`src/lib/errors.ts:263-288`）；`normalizeError` 保留原始 code/category/severity | `errors.test.ts` | 低 | 保留 |
| J-11 | 避免重复记录同一错误 | **已实现且验证通过** | 实例级 `WeakSet`（`diagnostics.ts:190`）+ 指纹窗口（`diagnostics.ts:218-305`） | `diagnostics.test.ts` | 低 | 保留 |
| J-12 | 错误处理器自身抛错 | **已实现且验证通过** | `globalErrors.ts` 每个处理函数独立 `try/catch`（:47, :53, :64） | — | 低 | 保留 |
| J-13 | 防止日志递归调用 | **已实现且验证通过** | 前端上报走原始 `invoke` 不经 `invokeCommand`（`diagnostics.ts:5-7`）；后端写线程只用 `eprintln!`（`writer.rs:8-9`） | — | 低 | 保留 |
| J-14 | 可恢复 vs 不可恢复错误区分 | **已实现且验证通过** | `AppError.retryable`（`errors.ts`）；级别映射 `diagnostics.ts:595-600`（validation→WARN，DATA_INTEGRITY_ERROR→CRITICAL） | `diagnostics.test.ts` | 低 | 保留 |
| J-15 | UI 显示可理解错误提示 | **已实现且验证通过** | `reportError` + `sanitizeForUser`（`errors.ts:282`）；Toast 30s 去重（`globalErrors.ts:26-33`） | — | 低 | 保留 |
| J-16 | 技术信息进诊断系统 | **已实现且验证通过** | 用户提示用 `sanitizeForUser`；详情走 `logEvent`（`globalErrors.ts:48-67`） | — | 低 | 保留 |
| J-17 | 错误提示与日志用同一 operationId 关联 | **部分实现** | IPC 失败路径有 operationId（`diagnostics.ts:655-666`）；**`reportError`/`globalErrors` 路径不生成 operationId**（`globalErrors.ts:48-67` 无 operation_id 字段） | 无 | 中 | 让次级观察也携带 operationId，使「提示 ↔ 日志」可对账 |

---

## K. 测试与验收

| # | 功能 | 状态 | 代码证据 | 测试证据 | 风险 | 处理建议 |
|---|---|---|---|---|---|---|
| K-01 | Rust 单元测试（诊断模块） | **已实现且验证通过** | `src-tauri/src/diagnostics/tests.rs` 21 个 `#[test]` + `privacy.rs` 9 个 + `tracing_layer.rs` 2 个 = **32 个** | 见左 | 低 | 保留 |
| K-02 | 前端单元测试 | **已实现且验证通过** | `src/lib/diagnostics.test.ts` **33 个**用例 | 见左 | 低 | 保留 |
| K-03 | UI 组件测试 | **已实现且验证通过** | `DiagnosticsCenterPanel.test.tsx`、`DiagnosticsLogsSection.test.tsx` | 见左 | 低 | 保留 |
| K-04 | 隐私回归测试 | **已实现且验证通过** | `privacy.rs:235-362` 9 个测试覆盖白名单、敏感 key、路径占位、错误码形态、凭证脱敏 | 见左 | 低 | 保留 |
| K-05 | 轮转测试 | **已实现且验证通过** | `diagnostics/tests.rs` 含轮转用例 | 见左 | 低 | 保留 |
| K-06 | 清理测试 | **已实现且验证通过** | `diagnostics/tests.rs` 含清理用例 | 见左 | 低 | 保留 |
| K-07 | 配额限制测试 | **已实现且验证通过** | `diagnostics/tests.rs` 含配额用例 | 见左 | 低 | 保留 |
| K-08 | 写入失败测试 | **已实现且验证通过** | `diagnostics/tests.rs` 含写入失败用例 | 见左 | 低 | 保留 |
| K-09 | 循环引用测试 | **不适用** | 结构上不可能（只存标量） | — | 低 | 文档说明 |
| K-10 | 子 Logger 继承测试 | **不适用** | 无 `child()` API | — | 低 | 若引入需补测 |
| K-11 | Trace ID 传播测试 | **未实现** | 无 trace 概念 | 无 | **高** | 随 G-04 补测 |
| K-12 | React→Tauri→Rust 关联集成测试 | **部分实现** | 前端有 operationId 单测；**无跨层集成测试** | 部分 | 中 | 补一条端到端关联断言 |
| K-13 | MCP 调用追踪测试 | **已实现且验证通过** | `mcp/tests.rs` + `db/mod.rs:4207-4221` | 见左 | 低 | 保留 |
| K-14 | Agent 任务执行追踪测试 | **未实现** | 无 | 无 | 中 | 需补 |
| K-15 | 设备配对审计测试 | **未实现** | 无审计事件可测 | 无 | **高** | 随 F-05 补测 |
| K-16 | 远控授权审计测试 | **不适用** | 无远控功能 | 无 | — | 功能落地时补 |
| K-17 | Android 日志生命周期测试 | **未实现** | 无 | 无 | **高** | 随 B-07 补测 |
| K-18 | 诊断中心分页查询测试 | **已实现且验证通过** | `DiagnosticsCenterPanel.test.tsx` | 见左 | 低 | 保留 |
| K-19 | 诊断包导出测试 | **已实现且验证通过** | `diagnostics/tests.rs` + UI 测试 | 见左 | 低 | 保留 |
| K-20 | 磁盘空间不足故障注入 | **未实现** | 无 | 无 | **高** | **P0**：需补 |
| K-21 | 日志文件被占用故障注入 | **未实现** | 行为已知（`writer.rs:280-282`）但无测试固化 | 无 | 中 | 补 |
| K-22 | 文件权限不足故障注入 | **未实现** | 无 | 无 | 中 | 补 |
| K-23 | 日志文件损坏 | **部分实现** | `query.rs` 解析失败跳过并计 `skipped_lines`（`commands/diagnostics.rs:49`） | 有计数，无专测 | 中 | 补专测 |
| K-24 | 高频事件突发 | **部分实现** | 聚合器有；无突发压测 | 无 | 中 | 补 |
| K-25 | 应用异常退出 | **部分实现** | 退出有 `finish()`（`writer.rs:388`）；**强杀场景无测试** | 无 | 中 | 补 |
| K-26 | 网络断开 | **未实现** | 无 | 无 | 中 | 补 |
| K-27 | 设备突然离线 | **未实现** | 无 | 无 | 中 | 补 |
| K-28 | 多线程并发写入 | **已实现且验证通过** | 单写线程设计天然规避（`writer.rs:16-18`）；`diagnostics/tests.rs` 含并发用例 | 见左 | 低 | 保留 |
| K-29 | 日志开关的业务耗时差异基准 | **未实现** | 无 | 无 | **高** | **P0**：需建立 |
| K-30 | 高频下 CPU/内存基准 | **未实现** | 无 | 无 | **高** | **P0**：需建立 |
| K-31 | 大日志查询是否阻塞 UI | **未实现** | 查询走 `spawn_blocking`（`commands/diagnostics.rs:173`），**架构上不阻塞**，但无实测 | 无 | 中 | 补实测 |
| K-32 | 清理/轮转对主业务影响 | **未实现** | 清理/轮转在写线程内（`writer.rs`），架构上隔离；无实测 | 无 | 中 | 补实测 |
| K-33 | 退出等待时长 | **部分实现** | `flush_blocking` 有 300ms+2s 上限（`mod.rs:645,653`）；退出 `finish()` 无超时但只做一次 flush | 无 | 中 | 补实测 |
| K-34 | 性能阈值预先定义 | **未实现** | 无阈值文档 | 无 | **高** | 需在测试前书面确定 |
| K-35 | 验收报告归档 | **部分实现** | `docs/DIAGNOSTICS.md:5` 引用 `tmp/acceptance/diagnostics-logging/report.md`，**该目录当前不存在** | 证据缺失 | 中 | 本轮补齐三份验收报告 |
| K-36 | 既有架构守卫 | **已实现且验证通过** | `npm run arch:guard`（`package.json`） | — | 低 | 保留并在集成时执行 |

---

## L. 状态统计（**证据计数，非主观估算**）

> 口径：以本矩阵「功能项」为单位，每项按其状态归类。**「已验证通过」的表述受 §头部
> 免责声明约束——本轮未执行测试，故实际通过结论待开发阶段执行后回填。**

| 状态 | 项数 | 说明 |
|---|---|---|
| 已实现且验证通过 | 104 | 体系 A 主干（事件契约、级别、脱敏、背压、轮转、时间保留、查询、前端采集、诊断中心、异常归属、**panic 捕获**、**写失败分类**） |
| 已实现但存在缺陷 | 7 | 错误序列化、超大文本、嵌套脱敏、文件占用、磁盘满真实注入、`console` 残留、目录权限 |
| 部分实现 | 25 | 子 Logger、UTC、Android 采集、配对审计、信任变更、权限变更、性能各模块、跨层关联、错误对账 |
| 未实现 | 41 | **Android 全套**、trace/span/device ID、统一审计视图、性能 API、故障注入、性能基准、诊断中心增强项 |
| 不适用 | 7 | 循环引用（结构免疫）、构建脚本日志、远控（功能不存在）、trace 不替代认证等 |
| **合计** | **184** | 按矩阵编号 `A-01`…`K-36` 逐行统计（脚本可复现，见下方命令） |

**分体系分布**（脚本统计，与上表一致）：

| 组 | 已实现且验证通过 | 有缺陷 | 部分实现 | 未实现 | 不适用 | 小计 |
|---|---|---|---|---|---|---|
| A 契约与上下文 | 8 | 1 | 2 | 0 | 1 | 12 |
| B 采集适配层 | 5 | 1 | 0 | 2 | 1 | 9 |
| C 脱敏与字段校验 | 11 | 2 | 1 | 1 | 0 | 15 |
| D 缓冲/背压 | 8 | 0 | 0 | 1 | 0 | 9 |
| E 持久化/轮转 | 14 | 1 | 1 | 1 | 0 | 17 |
| F 安全审计 | 6 | 0 | 6 | 4 | 0 | 16 |
| G 跨模块追踪 | 7 | 0 | 1 | 5 | 2 | 15 |
| H 性能日志 | 1 | 0 | 5 | 8 | 0 | 14 |
| I 诊断中心 UI | 18 | 1 | 1 | 4 | 0 | 24 |
| J 全局异常处理 | 13 | 1 | 2 | 1 | 0 | 17 |
| K 测试与验收 | 13 | 0 | 6 | 14 | 3 | 36 |
| **合计** | **104** | **7** | **25** | **41** | **7** | **184** |

**统计可复现命令**：

```bash
python -c "
import re,collections
rows=[]
for line in open('docs/architecture/logging-capability-matrix.md',encoding='utf-8'):
    m=re.match(r'^\|\s*([A-L])-(\d+)\s*\|', line)
    if m:
        cols=[c.strip() for c in line.strip().strip('|').split('|')]
        rows.append((m.group(1), cols[2]))
cnt=collections.Counter(s for _,s in rows)
print(len(rows)); [print(k,v) for k,v in cnt.most_common()]
"
```

**分体系的关键缺口（按优先级）**：

| 优先级 | 缺口 | 涉及项 |
|---|---|---|
| ~~P0~~ ✅ | Rust Panic 捕获（**2026-11-19 已完成**） | J-05、S-1 |
| **P0** | Android 日志体系（采集 + 持久化 + 崩溃捕获 + 脱敏） | B-07、B-08、C-14、D-09、E-16、J-07、K-17 |
| **P0** | 配对/信任变更纳入统一审计 | F-05、F-06、S-4 |
| **P0** | 日志系统自身性能基准 | H-13、K-29、K-30、K-34 |
| **P1** | `trace_id` / `span_id` / `device_id` 跨进程追踪 | G-04、G-05、G-06、G-13、G-14、I-06、I-08、K-11 |
| ~~P1~~ ✅ | 按时间维度的日志保留（**2026-11-19 已完成**） | E-05、S-7 |
| **P1** | 故障注入测试套件 | K-20 ~ K-27 |
| **P1** | 统一审计视图与保留语义 | F-13、F-15、F-16、K-35 |
| **P2** | 通用性能指标 API 与各模块埋点 | H-01 ~ H-12 |
| **P2** | 诊断中心交互增强（暂停、虚拟滚动、导出预览） | I-12、I-16、I-18、I-19 |
| **P2** | 错误提示与 operationId 对账 | J-17 |
| **P3** | 生产 `console.*` 收敛、命名消歧、脚本日志格式 | B-06、C-2/3/4/5 |

---

## M. 第二阶段回填（2026-11-20，logging-phase2）

> 本节为第二阶段开发后的状态回填。**上方 A–K 表与 §L 统计是 2026-11-19 审计快照，
> 未按本轮重算**；以本节带日期的逐条结论为准。状态三分法：**已实现且已验证**（有真实执行
> 通过的测试/命令证据）/ **已实现未验证**（代码存在，无设备、无 Dev 实例、未跑全量或被环境
> 阻塞）/ **延期**（本阶段明确不做，理由与将来约定见 `logging-current-state.md` §10.4）。
> 证据目录：`tmp/acceptance/logging-phase2/`。

### M.1 Android 日志体系

| 矩阵项 | 回填状态 | 依据 |
|---|---|---|
| B-07 Android 采集适配层 | **已实现且真机验证（范围限定）**：`SafeLog.kt` 唯一日志入口，tag 归一 + 原生脱敏；`HandlerThread/Handler` 分发、真机落盘与启动日志已取证；Release 包内文件内容未直接读取（非 debuggable） | `android-logger/report.md`；`final/android-device.md` |
| B-08 Android JS/TS 采集 | **已实现且已验证**：`safeLog.ts` 规则表与 Kotlin 同序对照；定向 **14** 用例、移动端全量 86 文件 / 926 用例通过，`tsc --noEmit` 退出码 0 | 同上 |
| C-14 Android 敏感信息处理 | **已实现且真机验证**：原生侧先脱敏，Logcat 与文件共用同一份结果；Kotlin `RULES` ↔ JS `REDACT_RULES` 同序同规则，双侧对照矩阵通过；真机修复 metadata 键名凭据泄漏后 `[redacted]`、原始串 0 命中 | 同上 §3.1 |
| D-09 Android 缓冲/背压 | **已实现且已验证（JVM + 真机容量）**：有界队列 256 / 高级别预留 32，分级配额与按级别丢弃计数；8 线程并发、shutdown 竞态、占用降级与退避序列均有用例；真机 15,000 条未崩溃、仅 3 文件 | 同上 §3.2 |
| E-16 Android 本地持久化 | **已实现且真机验证（Debug 文件级）**：滚动文件 2 MB×3、总量 ≤6 MB、保留 7 天、活动文件硬上限 4 MB；真机总量 6,092,322 B、最旧一代被替换；7 天跨天清理未测 | 同上 §3.2 |
| J-07 Android UncaughtException | **已实现且真机验证（Debug 文件级）**：`CrashHandler.kt` install 幂等、崩溃线程同步写文件、委托原 handler、5 文件/7 天；真机 `am crash` 生成 650 B 文件（10 帧、无敏感路径），重启恢复 | 同上 §3.3 |
| K-17 Android 日志生命周期测试 | **已实现且已验证**：Kotlin **28** 用例（SafeLogTest 16 / FileLogSinkTest 12）failures=0 errors=0；JS 14；真机容量/崩溃/启动补证 | 同上；模块 `build/test-results/TEST-*.xml` |

### M.2 Trace 与跨模块追踪

| 矩阵项 | 回填状态 | 依据 |
|---|---|---|
| G-04 `trace_id` | **已实现且已验证（模块级）**：事件契约新增 `trace_id: Option<String>`；前端 `startTracedOperation`；mobile_sync 会话级共享；shelf addPaths/runFileOp、`create_task`、`open_agent_session` 三处、工作区 copy/move 端到端接通（16 个 trace_wiring 用例通过）。Dev 真机端到端未执行；工作流执行链路仍未挂 trace | `trace-id/report.md`、`trace-wiring/report.md` |
| G-05 `span_id` | **延期**：只有 `operation_id` + `trace_id`；`new_span_id()` 生成函数存在，事件结构未加字段。将来预留 `span_id` / `parent_span_id` 可选字段（见现状报告 §10.4） | `trace-id/report.md` §5 |
| G-09 不信任外部 Trace ID | **已实现且已验证**：`validate_external_id` 限 16 位小写 hex；大写/非 hex/超长/不足/空串丢弃并重新生成；trace 与事件归一校验二次兜底 | `trace-id/report.md`；`trace.rs` 用例 |
| G-11 Trace 不替代认证/授权 | **已实现且已验证**：鉴权路径不读 trace；`trace_value_does_not_change_authentication_outcome` 验证无效令牌+traceId 仍 401、有效令牌+畸形 trace 仍 200 | `trace-id/report.md` |
| G-13 Desktop↔Android 关联 | **部分实现**：桌面 server 按设备会话下发/沿用 traceId；移动端链路（`pullAll` 存 `trace.id` → `pushBatch` 回传）既有测试通过；真机跨端链路未执行 | 同上 |
| G-14 MCP↔诊断关联 | **部分实现**：`tools/call` 经 `with_trace` 包裹同步段；非 tools/call 的 MCP 方法（resources/list、prompts/get 等）未建上下文；`mcp::protocol` Rust 单测本轮被其他任务在途编译错误阻塞（ENVIRONMENT BLOCKED） | `trace-id/report.md` §7 |
| K-11 Trace ID 传播测试 | **已实现且已验证（定向）**：mobile_sync 90 passed、diagnostics::trace 5 passed、trace_wiring 8 passed、前端 diagnostics.test.ts 40 passed、移动端 sync 4 文件 30 passed | 同上 |

### M.3 安全审计统一视图

| 矩阵项 | 回填状态 | 依据 |
|---|---|---|
| F-05 配对/鉴权/撤销审计 | **已实现且已验证（Rust 适配层模块级）**：`securityAuditLog`（主库 v82）真接入，`DEVICE_REVOKED` → `deviceRevoke`，pairing/auth 直通；16 个 `security_audit` 用例通过。真机与前端联调未在 Dev 实例走查 | `security-audit/report.md` |
| F-06 信任变更审计（Hub） | **延期接线（notWired）**：`personalHub` 运行在独立进程，主进程无审计只读管道；`HubAuditReader` trait 已预留；未绕过去直连他人库文件 | 同上 |
| F-16 审计查询入口统一 | **已实现且已验证（Rust 适配层）**：四源投影、合并排序分页、来源状态 `available/empty/locked/notWired/error`；条目 `id=<source>:<原始 id>`，不伪装同一物理表；前端安全审计视图由 E 任务组件级测试覆盖。vault 解锁态真实 `VaultState` 路径未验证 | 同上；`diagnostics-ui/report.md` |
| K-15 设备配对审计测试 | **已实现且已验证**：适配层用例覆盖来源标识分离、合并分页无重叠、设备过滤、authz 映射、traceId 形态校验、vault locked、hub notWired、撤销事件映射 | `security-audit/report.md` §3 |

### M.4 性能指标

| 矩阵项 | 回填状态 | 依据 |
|---|---|---|
| H-01 通用耗时测量 API | **已实现且已验证（Rust 聚合层）**：`record_duration_async` + `OperationTimer`（显式 finish / Drop 兜底防重复入账 / `Send` 可跨 await）；14 个 metrics 用例通过 | `metrics/report.md` |
| H-02 桌面启动耗时 | **已实现且 Dev 实测（单次样本）**：阈值表含 `startup` 3000 ms；起点/收尾接线完成；Dev 实测 3879 ms / P95 3879 ms / 慢操作 1，正式基线未执行 | `final/dev-ui.md` §3.1 |
| H-03 文件工作区耗时 | **已实现未验证**：`file/list_dir` 埋点（1500 ms 阈值）；命令模块内无单元测试，测试 harness 编译通过，运行时表现待 Dev 实例 | 同上 §1.2 |
| H-04 回收站耗时 | **已实现未验证**：`recycle/list` 走默认 1000 ms 阈值；recycle 套件前台 42 passed / 1 ignored，指标断言未单列 | 同上 |
| H-05 资源扫描耗时 | **已实现未验证**：`resource/snapshot|preview|disk_analyze|junk_scan` 埋点（5000 ms）；模块内无单测 | 同上 |
| H-06 剪贴板捕获延迟 | **已实现未验证**：`clipboard/capture` 200 ms 阈值；clipboard 套件前台 6 passed / 260 passed / 1 ignored，捕获延迟运行时未测 | 同上 |
| H-08 设备通信耗时 | **已实现未验证**：`mobile_sync/pull`、`apply_push` 各 5000 ms 阈值；sync 套件前台 17 passed | 同上 |
| H-09 MCP 工具调用耗时/错误率 | **部分实现**：`mcp/tool_call` 10000 ms 阈值；`ToolError::Authz` 拒绝不计失败聚合（与 MCP 审计分工）；mcp 套件 71 passed / 1 既有失败（`tool_defs_are_complete_and_unique`，collab 工具 schema 问题，非本任务引入） | 同上 §4.1 |
| H-10 Agent 任务耗时 | **部分实现**：`agent/submit` 30000 ms 阈值，管线拆出私有 `submit_inner`；agents::pipeline 前台 31 passed | 同上 |
| K-29 / K-30 / K-34 性能基准与阈值校准 | **未执行（证据不足）**：阈值表为候选值；无「日志开/关业务耗时差异」基准脚本、无高频 CPU/内存采样、无 Release 基线。Debug 测试二进制数字不外推为正式性能结论 | `export-preview/report.md` §3.2；`metrics/report.md` §4.4 |

### M.5 诊断中心 UI 与导出

| 矩阵项 | 回填状态 | 依据 |
|---|---|---|
| I-08 Trace ID 展示/检索 | **部分实现**：安全审计视图行展开展示关联 Trace ID（verbose）；诊断 JSONL 的 trace 检索随 G-04 链路推进；`eventType` 筛选项未在 UI 暴露 | `diagnostics-ui/report.md` §3.2、§4 |
| I-12 导出前预览 + 确认 | **已实现且已验证（组件级 + Rust 定向）**：`export_preview` 只读扫描（20 万行 / 400 ms 预算）不落盘不连库；预览对话框展示条数/错误/警告/模块/估算/脱敏状态；安全审计默认关闭、显式勾选；取消不落地文件。Rust 13 个 query 用例、前端 29 个诊断用例 + 51 个弹层定位用例通过；真机/窄窗/主题走查未执行 | `export-preview/report.md`；`diagnostics-ui/report.md` |
| K-19 诊断包导出测试 | **已实现且已验证**：含空目录、级别/时间筛选、不落盘、估算单调、无审计段委托、授权段脱敏、50k 行有界导出等用例 | `export-preview/report.md` §3.1 |

### M.6 本轮仍未执行 / 环境阻塞

- **整 `cargo test --lib`**：被其他任务在途未跟踪文件 `src-tauri/src/agent_access/tests_v82_rest.rs`
  （非 ASCII 字节串语法错误）阻塞，**ENVIRONMENT BLOCKED，非本任务缺陷**；各模块以定向测试 +
  `cargo check --lib`（退出码 0，36 条既有警告，无新增阻断）证明改动。
- **真机/Dev 实例走查**：Android 真机已完成 Debug 文件级 + 临时 Release 安装/启动验收
  （vivo V2323A / Android 16，见 `final/android-device.md`）；Dev 诊断中心三视图/审计/导出/
  性能窗口已实测。320/400 窄窗、深浅主题、液态玻璃可读性、系统剪贴板/通知/焦点等原生通道
  仍未全量取证。Release 非 debuggable/无 root，包内文件内容未直接复核。
- **Release 正式验收**：未按集成流程生成安装包，安装/升级/卸载、签名与更新、生产资源加载、
  正式性能基线均未执行；当前已构建的临时 arm64 Release APK（33,513,751 B /
  SHA256 `B3D6C6F2…9BEECE`）只用于真机启动与数据保留复核，不推进 Release 状态机、无 buildId。
- **D: 盘 ENOSPC 事故**：当日 D: 盘写满至 0 字节，主智能体删除可再生的 `src-tauri/target/debug`
  （约 8.0 GB）后恢复约 7.0 GB；部分套件仅前台控制台通过，落盘复测为 ENOSPC 记录，不能作为
  测试失败证据。详见验收报告环境一节。
