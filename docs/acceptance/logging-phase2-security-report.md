# 日志系统第二阶段（logging-phase2）安全验收报告

- 报告日期：2026-11-20（UTC+8）
- 运行模式：**Dev 功能验收（Debug 模块级定向测试 + 静态检查）+ Android 真机安全验收**；
  非 Release 正式验收，无 buildId。Android 文件级证据取自 Debug 变体，最终 Release 仅验证启动与
  数据保留（非 debuggable、无 root）。
- 工作目录：`D:\Develop\task_dock`；Git HEAD：收尾测试时为 `5b6c671`；运行期外部定时提交推进至
  `fc1c629`（非本任务操作），共享工作区约 89 条在途改动，本报告只对第二阶段安全相关声明路径下结论。
- 检查依据：`AGENTS.md` §4 架构红线、§7 报告口径；`tmp/acceptance/logging-phase2/interfaces.md`
  §2.1/§2.2；`unified-observability-design.md` §4.3（审计）/§4.4（Trace）；`DIAGNOSTICS.md`
  §6（隐私红线）/§24（级别与隐私）/§25.1/§25.3。

> 口径：测试代码存在不等于测试通过；未执行写「未执行」，环境阻塞写 `ENVIRONMENT BLOCKED`，
> 证据不足写「证据不足」。安全结论只覆盖本任务声明路径；其他在途改动的安全性不在本报告范围。

---

## 1. 任务范围

本报告验收第二阶段与安全/隐私直接相关的五条线：

1. **脱敏闭环**：桌面 Rust / JS / Android 原生三侧对 token、密钥、指纹、配对码、IP 等敏感值
   的脱敏规则与执行顺序；Android 原生侧先脱敏，Logcat 与文件共用同一份结果。
2. **Trace 与鉴权隔离**：`trace_id` 只做诊断关联，绝不参与认证/授权/设备信任；外部传入 ID
   严格校验，非法值不透传。
3. **安全审计统一视图**：多源审计的来源标识、覆盖状态、不可读来源显式标注；不把不同库伪装成
   同一物理表；审计存储与诊断 JSONL 物理分离。
4. **导出授权**：诊断包并入安全审计段须用户显式勾选（默认关闭）；取消/关闭不落地文件；
   未授权导出不触碰审计表。
5. **Android 日志边界**：沙盒目录、容量上限、队列背压、崩溃文件留存与隐私字段处理。

**不在范围**：其他模块的安全审计实现评审；MCP 工具权限模型本体；Vault 加解密本体；
Release 签名/安装包安全；正式 Release 真机安全走查（Debug 真机已做，见 §5.5）。

## 2. 检查依据与方法

- 冻结契约 `interfaces.md`：Trace 形态与校验、审计事件清单与脱敏红线、导出授权边界。
- 代码核对：`diagnostics/trace.rs`、`diagnostics/mod.rs`、`security_audit/adapter.rs`、
  `diagnostics/query.rs`、`apps/mobile/modules/logger/`、`apps/mobile/src/lib/safeLog.ts`。
- 证据优先级：原始测试日志 > 子任务 report.md > 文档；数字以当次输出为准。
- 方法：定向 Rust/JS/Kotlin 测试 + 源码走读；初稿未启动 Dev 实例；17:36 补做隔离 Dev 实例的
  安全审计 UI/导出授权走查（§6、§9）；18:20 后补做 Android 真机安全验收（§5.5）；不做渗透测试。

## 3. 环境

- Windows 本地 PC，PowerShell 7.6.4；Android 真机 vivo V2323A / Android 16 / API 36 / arm64
  已连接并完成 Debug 文件级 + Release 安装/启动验收（§5.5）。
- **D: 盘 ENOSPC 事故**：当日 D: 盘写满至 0 字节，主智能体删除可再生构建产物
  `src-tauri/target/debug`（约 8.0 GB）后恢复约 7.0 GB；部分复测仅前台控制台通过，落盘日志
  为阻塞记录，不作为失败证据。详见验收总报告 §3.2。
- **整 `cargo test --lib` 被其他任务在途未跟踪文件
  `src-tauri/src/agent_access/tests_v82_rest.rs`（非 ASCII 字节串语法错误）阻塞**：
  ENVIRONMENT BLOCKED，非本任务缺陷；`mcp::protocol` Rust 单测同受牵连未在绿构执行。

## 4. 命令与结果（安全相关定向证据）

| # | 命令（工作目录 `D:\Develop\task_dock`） | 退出码 | 结果 | 证据 |
|---|---|---|---|---|
| 1 | `cargo test --lib security_audit` | 0 | 16 passed / 0 failed / 0 ignored（2552 filtered），12.02s | `security-audit/cargo-test-3.log` |
| 2 | `cargo test --lib diagnostics::trace` | 0 | 5 passed / 0 failed / 0 ignored（2563 filtered） | `trace-id/cargo-test-trace.txt` |
| 3 | `cargo test --lib mobile_sync` | 0 | 90 passed / 0 failed / 0 ignored（2478 filtered），77.89s | `trace-id/cargo-test-mobile-sync.txt` |
| 4 | `vitest run src/lib/diagnostics.test.ts` | 0 | 1 文件 40 passed | `trace-id/frontend-diagnostics-test.txt` |
| 5 | `vitest run` `apps/mobile` `safeLog.test.ts` | 0 | 1 文件 **14 passed** | `android-safelog-js-test.log` |
| 6 | `vitest run` `apps/mobile` 全量 | 0 | 86 文件 926 passed | `android-logger/js-all-tests.txt` |
| 7 | Gradle `:logger:testDebugUnitTest` Kotlin 单测 | 0 | BUILD SUCCESSFUL；**SafeLogTest 16 / FileLogSinkTest 12 = 28**，failures=0 errors=0 | `android-safelog-kotlin-test.log`；模块 `build/test-results/TEST-*.xml` |
| 8 | `cargo test --lib diagnostics::query` | 0 | 13 passed / 0 failed（含授权段脱敏、无审计段委托用例） | `export-preview/test-query-pass.log` |
| 9 | `npm run typecheck`（主智能体） | 0 | 无类型错误 | 主会话静态检查记录 |
| 10 | `npm run cargo -- check --lib`（主智能体） | 0 | lib 编译通过；36 条既有警告，无新增阻断 | 主会话静态检查记录 |
| 11 | `cargo test --lib mcp`（既有套件对照） | 101 | 71 passed / 1 既有失败（`tool_defs_are_complete_and_unique`，`taskdock_collab_create_issue` schema 在途，非本任务引入）；与安全审计路径无关 | `metrics/test-mcp.log`；`final/rust-targeted.log` |

\* 该既有失败不计入本报告安全结论。

## 5. 已验证的安全事实

### 5.1 脱敏规则与执行顺序

- **桌面侧**：诊断事件经 `privacy` 规则表脱敏（token / 密钥 / 指纹 / 配对码 / 密码类键值、
  长路径与命令行截断等）；规则表为第一阶段已验证基座，本阶段未改动规则本体。
- **Android 侧（本阶段新增，重点核对）**：
  - `LoggerModule.write` **先在原生侧独立清洗** tag、message、metadata；Logcat 输出与
    `FileLogSink` 写文件**共用同一份清洗结果**，不存在「JS 未脱敏 → 原生落明文」的绕过路径。
  - metadata 解析失败时只丢弃 metadata，不丢弃整条日志，也不把原始 metadata 写入文件。
  - Kotlin `RULES` 与 JS `REDACT_RULES` **同序同规则**；双侧各有对照矩阵用例（**14 个 JS
    定向用例 + Kotlin SafeLogTest 16 个用例**覆盖各规则类）。
  - **真机缺陷与修复（P1）**：metadata 键名本身就是凭据类别时，值未脱敏；真机探针
    `password=P@ssw0rd` 原样落盘。已在 Kotlin/JS 双侧新增 `SENSITIVE_METADATA_KEY`，键名命中
    `authorization/token/password/passwd/secret/api[_-]?key/apikey/auth/sig/key` 时值统一
    `[redacted]`；复测 `password/token/api_key/email=[redacted]`、`path=[path]`、nested 丢弃，
    原始敏感串 `P@ssw0rd|raw-api-key|SECRET-abc123|leak@example.com` 在 Logcat 与文件中 0 命中。
- **traceId 不落敏感值**：审计投影中 `correlation_id` / `request_id` 必须过 16-hex 校验才
  写入 `traceId` 字段；校验失败置空，不把原始请求值透传进诊断事件。

### 5.2 Trace 与认证/授权隔离

- `validate_external_id` 限定 16 位小写 hex（`^[0-9a-f]{16}$`）：大写、非 hex、长度不足/
  超长、空串一律返回 `None`，调用方丢弃并 `new_trace_id()` 重新生成——不报错、不拒绝业务、
  不透传非法原值；事件 `normalize()` 二次校验兜底。
- 鉴权路径（`authenticate_device`、MCP token 校验、设备信任、SPKI 校验、管线 origin 判定）
  **完全不读取 trace_id**。隔离用例 `trace_value_does_not_change_authentication_outcome`
  验证：无效令牌 + 携带 traceId 仍 401；有效令牌 + 畸形 trace 仍 200。
- trace 会话表（`trace_sessions`，进程内有界 32 条）只在同步链路内共享诊断标识；设备撤销后
  不主动清理，进程重启即清空，不跨进程留存。

### 5.3 审计来源标识与覆盖状态

- 统一视图条目 `id = <source>:<原始 id>`；**不把不同库伪装成同一物理表**，前端可按来源区分。
- 来源状态枚举：`available` / `empty` / `locked` / `notWired` / `error`；不可读来源在
  `sources[]` 显式标注并附 `note`，**不返回空列表冒充「无事件」**。

| 来源 | 状态 | 安全说明 |
|---|---|---|
| `securityAuditLog`（主库 v82） | available | 只读连接；`DEVICE_REVOKED` → `deviceRevoked`；pairing/auth/mcp 直通；其余 `other` |
| `mcpAuditLog`（主库 v37） | available | 只读；`authz=0` → `denied`，`success=1 && authz=1` → `ok`，其余 → `failed` |
| `vault` | 条件接入 | trait 已接线；`Unlocked` 才读审计；`Locked`/`Recovery`/`NoVault` → `locked`；读取异常 → `error`；未解锁不返回空列表 |
| `personalHub` | notWired | Hub 独立进程运行；主进程未托管 Hub State，Named Pipe 无审计读取方法；`ph_audit_log` 仅在独立进程 `hub.db` 内可写；**未绕过去直连他人库文件**，`HubAuditReader` trait 预留待协议扩展 |
| 远控 | 不适用 | 仓库无远控功能模块；未新增来源、未伪造事件 |

- **存储分离**：审计事件不写入诊断 JSONL；普通日志清理路径（writer `clear`/`prune`）只动
  `diagnostics-*.jsonl`，物理上不可能删除审计表；审计清理只能由用户显式触发（二次确认），
  启动路径不调用 prune。

### 5.4 导出授权与有界性

- 诊断包预览 `export_preview` 只读扫描，**不生成文件、不落盘、不打开数据库连接**。
- 并入安全审计段**须用户在导出预览对话框显式勾选**（默认关闭）；未勾选时完全不触碰审计表。
- 取消、关闭、Escape、点击遮罩均不产生导出文件；预览为空结果时确认按钮禁用。
- 导出有界：命中事件上限 5000 条；审计段请求上限 100 条；`BufWriter` 流式落盘 + 临时文件
  rename 原子替换；审计查询失败标记 `error` 并降级保留其它报告内容，不使整份导出失败。
- 授权段在报告中按脱敏规则输出；用例覆盖「无审计段委托」与「授权段脱敏」两条路径。

### 5.5 Android 日志边界

- 目录固定 `context.filesDir/logs`，不写外部存储、无额外权限要求；崩溃文件共用同一目录。
- 容量：单文件软目标 2 MB、归档 3 个、总量 ≤6 MB、保留 7 天；活动文件硬上限 4 MB；队列
  256 条、高级别（WARN/ERROR）预留 32 条；队列满优先丢 TRACE/DEBUG/INFO，按级别计数丢弃，
  绝不阻塞调用线程、绝不因队列满崩溃。
- 写失败（磁盘满等）只递增丢弃/失败计数，不抛错、不阻塞业务。
- **真机实测（vivo V2323A / Android 16，Debug 文件级）**：
  - 脱敏探针：修复前 `metadata.password` 泄漏 `P@ssw0rd`；修复后
    `password/token/api_key/email=[redacted]`、`path=[path]`、nested 丢弃、`ok` 保留；Logcat
    与文件一致，原始敏感串 0 命中（`final/android-device.md` §3.1）。
  - 15,000 条（3×5,000，480 字符）后仅 3 个文件：
    `app.1=2,097,693`、`app.2=2,097,649`、`app.log=1,893,528`，总量 **6,092,322 B**；
    最旧一代被替换（`rotate-probe3` 在 `app.2` 0 条、`app.1` 1,532 条）。
  - `am crash` 生成 `crash-20261120-183856-11044.txt`（650 B，10 帧），仅
    time/thread/exception/message/frames，无敏感路径；重启恢复。
  - 最终 Release 非 debuggable，`run-as` 拒绝、无 root，文件内容未直接复核；但 Release 冷启动
    623 ms、Logcat「应用启动」与覆盖安装保留 SQLite/5 条任务已确认（`final/android-device.md` §4）。

### 5.6 修改文件与关键位置（安全相关）

| 层 | 文件 | 关键位置/职责 |
|---|---|---|
| Rust Trace | `src-tauri/src/diagnostics/trace.rs` | `validate_external_id` 16-hex 校验；`new_trace_id`/`new_span_id`；线程局部上下文 |
| Rust 事件契约 | `src-tauri/src/diagnostics/mod.rs:226` | `trace_id: Option<String>`；`normalize()` 二次校验；`stage` 事件不挂 trace |
| Rust 审计适配 | `src-tauri/src/security_audit/adapter.rs` | 四源投影、来源状态枚举、`id=<source>:<原始 id>`、vault 运行态判定、`HubAuditReader` 预留 |
| Rust 导出 | `src-tauri/src/diagnostics/query.rs` | 只读预览；审计段显式授权；5000/100 条上限；流式落盘与原子替换 |
| Android 原生 | `apps/mobile/modules/logger/android/src/main/java/dev/taskdock/modules/logger/` | `LoggerModule.kt`（原生先脱敏，Logcat/文件共用结果）；`SafeLog.kt`（入口/规则）；`FileLogSink.kt`（沙盒/容量/队列背压）；`CrashHandler.kt`（崩溃写文件） |
| Android JS | `apps/mobile/src/lib/safeLog.ts` | `REDACT_RULES` 与 Kotlin 同序；统一入口与对照测试 |

## 6. 未验证 / 证据不足项

| 项 | 原因 | 影响 |
|---|---|---|
| vault 解锁态真实 `VaultState` 读取审计 | 验收环境无解锁 Vault 会话；`Unlocked` 分支仅由适配层用例构造 | 真实解锁后的读取、过滤与错误转换路径待复核 |
| ~~Android 真机/模拟器行为~~ **已真机验证（Debug 文件级 + Release 启动，范围限定）** | Debug 变体可读沙盒；Release 非 debuggable/无 root，文件内容不能直接读取 | 真机落盘内容、文件权限、崩溃写出与脱敏已取得 Debug 证据；Release 包内文件、7 天清理、低电量/后台限制、不同 ROM 未覆盖 |
| MCP 协议层 Rust 单测 | 受在途编译错误阻塞（ENVIRONMENT BLOCKED） | MCP 外部传入 trace 校验路径未在绿构回归 |
| 审计写入失败可靠性 | 本阶段未注入「审计写入失败」故障；设计要求高风险操作失败时诊断日志记 ERROR（`SECURITY_AUDIT_WRITE_FAILED`） | 写入失败不阻塞业务的降级路径仅有设计契约，缺本阶段故障注入证据 |
| Dev 实例完整视觉矩阵 | 诊断中心安全审计三视图、导出授权切换/取消已 Dev 实测；320/400 窄窗、深浅主题、焦点顺序未走查 | 完整窗口视觉矩阵仍证据不足 |
| Release 正式安全项 | 已出当前工作树临时 Release APK 并安装，但非集成快照、无 buildId；lint 因磁盘满跳过 | 签名、安装/升级/卸载、生产资源加载、日志文件权限的正式验收仍未执行 |

## 7. P0–P3 问题清单

### P0

- **未在本任务定向证据中发现 P0**（无敏感值泄露落盘、无鉴权绕过、无审计表被诊断清理路径
  删除的证据）。证据边界：整库测试阻塞、Release 包内文件未直接读取；Android 真机 Debug 文件级
  与最终 Release 启动已覆盖（§5.5），不能据此排除其他在途改动引入的安全问题。

### P1

| # | 现象 | 根因 | 影响 | 证据 |
|---|---|---|---|---|
| P1-1 | 整库安全相关 Rust 单测无法全量回归 | 其他任务在途未跟踪文件 `tests_v82_rest.rs` 语法错误阻塞测试目标编译 | 鉴权/审计牵连链路未在绿构全量验证；阻塞解除后需复测 | 总报告 §3.3 |
| P1-2 | 审计写入失败降级路径缺故障注入证据 | 本阶段未设计磁盘满/DB 不可用注入用例 | 高风险操作审计丢失时的 ERROR 告警链路未取证 | §6 |
| P1-3 | **真机发现 metadata 键名型凭据未脱敏（已修复）**：`password=P@ssw0rd` 原样落盘 | `SafeLog.kt` / `safeLog.ts` 只对消息文本按赋值形态脱敏，metadata 仅按值类型截断，未检查键名类别 | 若调用方把凭据放进 metadata（如 `password`/`token`/`api_key`），会以明文写入 Logcat 与文件 | 修复：双侧 `SENSITIVE_METADATA_KEY`；复测 `[redacted]` 且原始串 0 命中；Kotlin 28 + JS 14；`final/android-device.md` §3.1 |

### P2

| # | 现象 | 根因 | 影响 | 证据 |
|---|---|---|---|---|
| P2-1 | personalHub 审计源未接线 | 独立进程无主进程只读管道 | Hub 侧审计事件暂不出现在统一视图；状态如实标注 `notWired`，未伪造数据 | `security-audit/report.md` §6 |
| P2-2 | 审计口径偏差：vault `total` 受 1000 条上限约束；mcp COUNT 仅时间边界、过滤在内存层 | 适配层有界读取设计 | 超大库下列表计数与全量过滤存在偏差；已在文档与报告明示 | `security-audit/report.md` §8 |
| P2-3 | ~~Android 真机脱敏实际表现未取证~~ **已真机验证并修复 P1-3** | 初稿无设备；后续连接 vivo V2323A | 真机探针先发现 metadata 键名泄漏，修复后复测 `[redacted]`、原始串 0 命中 | `final/android-device.md` §3.1 |

### P3

| # | 现象 | 根因 | 影响 | 证据 |
|---|---|---|---|---|
| P3-1 | 审计来源扩展（Hub 接线）后需补用例与前端联调 | 协议/State 扩展未排期 | 接入时须回归来源状态枚举与标识前缀 | §5.3 |
| P3-2 | 既有 MCP 工具定义失败用例（schema 在途） | 非本任务引入 | 不影响本报告安全结论，但 mcp 套件未全绿 | `metrics/test-mcp.log` |

## 8. 遗留风险

1. **阻塞解除后复测**：`tests_v82_rest.rs` 修复后，须重跑 `security_audit`、`mobile_sync`、
   `mcp::protocol`、`diagnostics` 全量，并复核鉴权隔离用例仍通过。
2. **Hub 审计接线风险**：将来通过 Named Pipe 暴露只读审计方法时，须复用现有只读适配层与
   来源标识约定，避免跨进程直连 `hub.db` 文件。
3. **真机隐私复核（已完成 Debug 文件级）**：Android Debug 变体已抓 Logcat 与 `filesDir/logs`
   文件样本，确认无明文敏感值，并修复 metadata 键名泄漏（P1-3）。最终 Release 非 debuggable、
   无 root，包内文件内容未直接复核；上线前如条件允许，应在可调试的生产等价包或设备管理通道
   再抽一次样本。本次 JVM 单测不能替代该复核，但真机 Debug 样本已覆盖主要脱敏路径。
4. **导出授权 UI 链路（已 Dev 实测）**：默认关闭、勾选审计后重新预估（5 条/5.5 KB →
   6 条/6.3 KB）、取消不落盘均已验证；「确认导出」后的原生保存与实际文件脱敏仍须补测。
5. **完整视觉矩阵**：320/400 窄窗、深浅主题、键盘/Escape 焦点顺序未走查，不能替代
   Release/真机安全验收。

## 9. 结论

**通过（Dev 功能验收 + Android 真机安全验收，范围限定；P1-2 故障注入缺口与 Release 正式验收除外）。**

- 已验证：三侧脱敏规则对照、Android 原生侧先脱敏且 Logcat/文件共用结果、metadata 键名凭据
  `[redacted]`（真机 P1-3 修复并复测）、trace 与鉴权隔离、审计来源标识与状态枚举、存储分离、
  导出显式授权与有界性；收尾复验 `security_audit` 16 passed、`mobile_sync` 90 passed、
  `mcp` 71 passed / 1 既有 schema 失败、`diagnostics` 109 passed / 2 ignored，均为定向测试。
- Android 真机补充（`final/android-device.md`）：vivo V2323A / Android 16；Debug 文件级验证
  脱敏、轮转（15,000 条后 3 文件/6,092,322 B）、崩溃文件（650 B，无敏感路径）、启动日志；
  最终 Release 冷启动 623 ms、Logcat「应用启动」、覆盖安装保留 SQLite/5 条任务。
- 未达到「正式 Release 通过」：Release 包内文件内容（非 debuggable、无 root）、7 天清理、
  低电量/后台限制、不同 ROM、vault 解锁态真实会话、Release 签名/升级/卸载、完整 Dev 视觉矩阵
  未取证；personalHub 源按延期处理；**P1-2 审计写入失败故障注入仍缺证据**；整库安全回归仍被
  其他任务未跟踪测试阻塞。
- 本结论不覆盖其他在途改动，不构成生产包安全验收结论。

## 10. 证据路径清单

仓库内（`D:\Develop\task_dock\tmp\acceptance\logging-phase2\`）：

- `security-audit/report.md`；`cargo-test-3.log`（16 passed）
- `final/dev-ui.md`；`final/dev-ui/security.png`（安全审计四来源状态）；
  `final/dev-ui/export-preview-default.png` / `export-preview-audit.png`（授权切换）
- `trace-id/report.md`；`cargo-test-trace.txt`（5 passed）；`cargo-test-mobile-sync.txt`
  （90 passed）；`frontend-diagnostics-test.txt`（40 passed）
- `android-logger/report.md`；`gradle-test-9.txt`（历史）；**最新**：
  `android-safelog-kotlin-test.log`（28 用例：SafeLog 16 / FileLogSink 12）、
  `android-safelog-js-test.log`（14 passed）、模块 `build/test-results/TEST-*.xml`
- `final/android-device.md`；`final/android-device/`、`final/android-device-release/`；
  `final/android-build-release-final.log`（最终 Release APK 33,513,751 B /
  SHA256 `B3D6C6F2…9BEECE`）
- `export-preview/report.md`；`test-query-pass.log`（13 passed）
- `metrics/` 目录 `test-mcp.log`（71 passed / 1 既有 failed）；`report.md` 兜底副本：
  `C:\Users\ASUS\AppData\Local\DoubaoWork\User Data\Profile 1\.doubaowork\agent_mode\workspace\.sessions\38455111763599362\agents\s_000tJuwvV4g\report.md`

代码位置：

- `src-tauri/src/diagnostics/trace.rs`、`src-tauri/src/diagnostics/mod.rs`（trace_id 契约）
- `src-tauri/src/security_audit/adapter.rs`（四源投影与状态）
- `src-tauri/src/diagnostics/query.rs`（只读预览与有界导出）
- `apps/mobile/modules/logger/android/src/main/java/dev/taskdock/modules/logger/`
  （`SafeLog.kt` / `FileLogSink.kt` / `LoggerModule.kt` / `CrashHandler.kt`）
- `apps/mobile/src/lib/safeLog.ts`
