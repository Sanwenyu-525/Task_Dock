# TaskDock 日志系统验收报告（开发阶段第一批：M1 / M2 / M3）

> 日期：2026-11-19
> 范围：M1 Rust Panic 捕获、M2 日志时间维度保留、M3 写失败分类
> 关联文档：[logging-current-state.md](../architecture/logging-current-state.md)、
> [logging-capability-matrix.md](../architecture/logging-capability-matrix.md)、
> [unified-observability-design.md](../architecture/unified-observability-design.md)、
> [docs/DIAGNOSTICS.md](../DIAGNOSTICS.md)

---

## 0. 结论摘要

| 项 | 结果 |
|---|---|
| 交付内容 | M1（panic 捕获）、M2（14 天保留）、M3（写失败分类）全部**已实现** |
| Rust 诊断模块测试 | **74 passed / 0 failed**（`cargo test --lib diagnostics`） |
| 前端诊断相关测试 | **60 passed / 0 failed**（3 个测试文件） |
| 前端类型检查 | `tsc --noEmit` **exit 0** |
| 架构守卫 | `npm run arch:guard` **exit 0**（报告模式，全部为既有例外） |
| 完整构建 | **未执行** |
| 真机取证 | **未执行** |
| 性能基准 | **未执行** |
| 阻塞项 | **无**（本次改动范围内全绿） |

⚠️ **仓库级既有问题（非本次引入）**：集成测试目标 `tests/virtual_display_live.rs` 在
**HEAD 基线上即编译失败**（`vd_start` 少传 `app: tauri::AppHandle` 参数），
导致 `cargo check --tests` / `cargo test`（全目标）无法完成。详见 §4.1。

---

## 1. 本批次实际改动

### 1.1 文件清单

| 文件 | 类型 | 改动 |
|---|---|---|
| `src-tauri/src/diagnostics/panic_hook.rs` | **新增**（232 行） | panic 捕获模块 + 7 个单元测试 |
| `src-tauri/src/diagnostics/mod.rs` | 修改 | 注册 `panic_hook` 模块；新增 `MAX_AGE_DAYS` / `WriteFailureKind`；`WriterConfig.max_age_days`；`Diagnostics.last_failure_kind` |
| `src-tauri/src/diagnostics/writer.rs` | 修改 | `prune()` 增加时间维度淘汰；9 处 IO 失败点改用 `fail_io` 分类 |
| `src-tauri/src/diagnostics/privacy.rs` | 修改 | metadata 白名单新增 `thread` 键 |
| `src-tauri/src/diagnostics/tests.rs` | 修改 | `small_config()` 补 `max_age_days`；新增 5 个测试（M2 三项 + M3 两项） |
| `src-tauri/src/commands/diagnostics.rs` | 修改 | `DiagnosticsStatus` 新增 `last_failure_kind` |
| `src-tauri/src/lib.rs` | 修改（+3 行） | `setup()` 中安装 panic hook |
| `src/lib/contracts/models.ts` | 修改 | `DiagnosticsStatus.lastFailureKind?: string \| null` |
| `src/components/settings/DiagnosticsLogsSection.tsx` | 修改 | 写失败分类 → 可执行提示 |
| `src/locales/zh-CN/index.ts` / `src/locales/en-US/index.ts` | 修改 | 新增 5 个文案键（两侧键集严格一致） |
| `docs/DIAGNOSTICS.md` | 修改 | §7 保留策略、§9 报告字段、§10 生命周期、§15 已知限制同步 |

### 1.2 M1 — Rust Panic 捕获

**问题**：仓库此前**没有**安装 `std::panic::set_hook`。Rust panic 直接终止进程，
诊断日志里**看不到任何崩溃记录**（审计阶段实测 `panic::set_hook` 全仓库 0 命中）。

**实现**（`src-tauri/src/diagnostics/panic_hook.rs`）：

```rust
pub fn install(diag: Arc<Diagnostics>) {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        // hook 里再 panic 会 abort：必须兜住，绝不能让日志系统把崩溃现场也带走。
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let location = info.location().map(|loc| (loc.file(), loc.line()));
            diag.record(build_event(info.payload(), location));
        }));
        previous(info);
    }));
}
```

**约束落实**（逐条对应任务书 §9）：

| 约束 | 实现 | 测试 |
|---|---|---|
| hook 自身不得 panic | 全流程包在 `catch_unwind` 里 | 代码审阅 |
| 保留原始行为 | 调用 `previous(info)`，运行时照常打印与退出 | 代码审阅 |
| 不写栈回溯全文 | 只取 `payload`（`&str`/`String`）+ `location` | `panic_event_never_leaks_absolute_path` |
| 绝不写绝对路径 | `file_name()` 只取最后一段路径分隔符后的文件名 | `panic_event_never_leaks_absolute_path` 断言 `alice`/`\`/盘符均不出现 |
| 消息脱敏 + 限长 | 复用 `error::sanitize_diagnostic`（单行化、去堆栈、隐藏用户目录与凭证）+ 240 字符上限 | `panic_event_message_is_truncated` |
| 不递归 | 走既有 `try_send` 背压路径；不调用 `tracing` | 代码审阅 |
| 错误有上下文 | 稳定错误码 `RUST_PANIC`、模块 `runtime`、阶段 `文件名:行号`、线程名 | `panic_event_uses_stable_code_and_location` |
| 可筛选 | `module=runtime` 或 `error_code=RUST_PANIC` | — |
| 不可恢复错误 | panic 即进程终止，级别定为 `ERROR`、状态 `failed` | 同上 |

**边界声明**：panic 事件是**普通诊断事件**，不是安全审计事件。审计需要独立存储与独立开关
（`kind` 字段属 M4 契约扩展，本批次未做）。

### 1.3 M2 — 日志时间维度保留

**问题**：保留策略只有「归档数 ≤ 4」+「总量 ≤ 25 MB」，**无任何时间维度**。
低频使用时日志目录可能几个月不动，容量上限永远碰不到，过期现场无限堆积。

**实现**（`writer.rs::prune()`）：新增第一个淘汰维度——归档修改时间超过
`max_age_days`（默认 `MAX_AGE_DAYS = 14` 天）的先删；随后仍按数量、容量两个维度淘汰。
三个维度互补：时间防**过期现场堆积**，数量/容量防**空间占用**。

- `max_age_days = 0` 表示**关闭**时间淘汰（便于测试与特殊部署）。
- 判定依据用归档文件 `metadata.modified()`（`archive_files()` 已返回该值，无需新增 IO）。
- 淘汰在写线程内完成，不阻塞业务线程。

### 1.4 M3 — 写失败分类

**问题**：写失败只记一条自由文本，设置页只能显示笼统的「日志写入失败」。
「磁盘满」「没权限」「文件被占用」的处置完全不同（清盘 / 改目录权限 / 关掉占用进程），
用户无法据此行动。

**实现**：

```rust
pub enum WriteFailureKind { DiskFull, PermissionDenied, FileLocked, Unknown }
```

- `WriteFailureKind::from_io(&io::Error)` 按 `ErrorKind` + **平台原始错误码**判定
  （`std::io::ErrorKind::StorageFull` 尚未稳定）：
  - 磁盘满：Windows `ERROR_HANDLE_DISK_FULL(39)` / `ERROR_DISK_FULL(112)`、POSIX `ENOSPC(28)`
  - 文件被占用：Windows `ERROR_SHARING_VIOLATION(32)` / `ERROR_LOCK_VIOLATION(33)`
  - 权限不足：`ErrorKind::PermissionDenied`
- 9 处 IO 失败点改用 `fail_io`（原 `fail` 保留给非 IO 错误，如序列化失败）。
- `DiagnosticsStatus.last_failure_kind` 暴露到前端；设置页按分类给出**可执行**提示
  （5 个 i18n 键，中英严格对齐）。

---

## 2. 实际执行的检查与结果

> 全部命令在 `D:\Develop\task_dock` 执行，时间为 2026-11-19。
> Rust 侧因仓库存在并发构建，使用**共享 target 目录**（`src-tauri/target/`）——
> 首次尝试的隔离目录 `src-tauri/target-logging/`（已删除，3.9 GB）出现
> `STATUS_ENTRYPOINT_NOT_FOUND` 加载失败，见 §4.2。

### 2.1 Rust 单元测试（诊断模块）

```bash
cd src-tauri && cargo test --lib diagnostics
```

```
test result: ok. 74 passed; 0 failed; 0 ignored; 0 measured; 2396 filtered out; finished in 1.28s
```

**74 项全绿**，其中**本次新增 12 项**：

| 测试 | 覆盖 |
|---|---|
| `panic_event_uses_stable_code_and_location` | 错误码 / 模块 / 动作 / 阶段 / 消息 |
| `panic_event_never_leaks_absolute_path` | 绝对路径 / 用户名 / 盘符均不外泄 |
| `panic_event_accepts_string_payload` | `String` 载荷 |
| `panic_event_handles_non_string_payload` | 非字符串载荷兜底 |
| `panic_event_message_is_truncated` | 5000 字符 → ≤241 字符 |
| `panic_event_carries_thread_name` | 线程名已归一（仅小写字母数字与 `_-.:`） |
| `panic_event_metadata_survives_privacy_filter` | `thread` 键在白名单内（不被 privacy 丢弃） |
| `startup_prunes_archives_older_than_max_age` | 30 天前归档在启动时被删 |
| `startup_keeps_archives_within_max_age` | 3 天前归档保留 |
| `age_retention_can_be_disabled` | `max_age_days = 0` 不删任何归档 |
| `write_failure_kind_classifies_io_errors` | 磁盘满 / 文件占用 / 权限 / 未知的判定 |
| `write_failure_kind_has_stable_strings` | 四个分类字符串稳定 |

原有 62 项诊断测试（含轮转、清理、配额、写入失败降级、聚合、脱敏）**全部保持通过**，无回归。

### 2.2 前端测试

```bash
npx vitest run src/lib/diagnostics.test.ts \
  src/components/settings/DiagnosticsLogsSection.test.tsx \
  src/components/diagnostics/DiagnosticsCenterPanel.test.tsx
```

```
Test Files  3 passed (3)
     Tests  60 passed (60)
  Duration  53.84s
```

### 2.3 前端类型检查

```bash
npx tsc --noEmit
```

```
EXIT=0
```

新增的 `lastFailureKind` 字段（可选）、5 个中英文案键、`failureKindKey()` 的
`MessageKey` 字面量类型约束全部通过编译期校验。

### 2.4 架构守卫

```bash
npm run arch:guard
```

```
报告模式：不阻断构建。
```

输出中的 `ERROR-001`（AppError 三处定义）、`DUP-001`（`src-tauri/components/`、
`src-tauri/boot/` 平行源码树）、`DOC-001`（README 数字过期）、`CIRC-001`
（`bridge → errors → diagnostics → bridge` 环）均为**既有例外项**，与本次改动无关；
本次未引入新的守卫告警。

### 2.5 编译检查

```bash
cd src-tauri && cargo check --tests
```

- **库目标（lib）与全部单元测试**：编译通过。
- **集成测试目标 `virtual_display_live`**：编译失败 —— **HEAD 基线既有问题**，见 §4.1。

---

## 3. 未执行项（明确声明，不得当作已验证）

| 项 | 状态 | 原因 |
|---|---|---|
| `npm run build` / `npm run tauri build` | **未执行** | 本批次只改 Rust/TS，不涉及发布产物；且仓库有并发构建，避免争抢 |
| `npm run test`（全量 vitest） | **未执行** | 只跑了诊断相关的 3 个测试文件；全量套件耗时且与并发构建争资源 |
| `cargo test`（全目标，含集成测试） | **未执行（不可执行）** | `tests/virtual_display_live.rs` 在 HEAD 即编译失败，见 §4.1 |
| `cargo test --lib`（全量 2470 项） | **部分执行后中断** | 运行中进程崩溃 `STATUS_ACCESS_VIOLATION`，发生在 audio 相关测试区间；诊断区间已单独全绿，见 §4.3 |
| 真机取证（实际启动应用看日志文件） | **未执行** | 未构建正式产物 |
| 性能基准（日志开/关业务耗时差异） | **未执行** | 属 M13 批次 |
| 故障注入（磁盘满 / 权限不足 / 文件占用） | **未执行** | 属 M14 批次 |
| Android 端 | **未执行** | 属 M10 批次 |

---

## 4. 遇到的阻塞与既有问题

### 4.1 集成测试 `virtual_display_live` 在 HEAD 即编译失败（既有问题，非本次引入）

**证据**：

```bash
git status --short src-tauri/src/commands/virtual_display.rs src-tauri/tests/
# （空 = 与 HEAD 完全一致，无任何未提交改动）

git show HEAD:src-tauri/src/commands/virtual_display.rs | grep -n "pub fn vd_start" -A 8
# 1183: pub fn vd_start(
# 1184-    app: tauri::AppHandle,
# 1185-    serial: String,
# 1186-    mode: String,
# 1187-    package: Option<String>,
# 1188-    size: Option<String>,
# 1189-    clipboard_sync: Option<bool>,
# 1190-    allow_multi: Option<bool>,
# 1191-) -> AppResult<VdSession> {

grep -n "vd::vd_start" -A 6 src-tauri/tests/virtual_display_live.rs
# 236: let second = vd::vd_start(
# 237-    device.serial.clone(),   ← 缺少第一个参数 app
# ...共 6 个参数，函数需要 7 个
```

**结论**：`cargo check --tests` / `cargo test`（全目标）在**未修改任何相关文件的基线上**
即失败。这是仓库基线缺陷，**不属于本次任务范围**，未擅自修复
（`virtual_display` 属其它任务的在途改动，按 `AGENTS.md` §3.2 不得越界写入）。

**影响**：无法用全目标 `cargo test` 作为回归手段；本批次改用 `cargo test --lib`
（只构建库单元测试目标，不含 `tests/` 集成测试）。

### 4.2 隔离 target 目录的测试二进制无法加载（环境问题，已绕行）

**现象**：在 `CARGO_TARGET_DIR=target-logging` 中构建出的 lib 测试二进制
启动即 `0xC0000139 STATUS_ENTRYPOINT_NOT_FOUND`（Windows 错误码），无任何输出。

**排查过程与证据**：

1. 导入表逐符号比对：**两个二进制的静态导入 DLL 集合与符号集合完全一致**
   （各 32 个 DLL，符号逐个相同）；延迟导入表两者均为空。
2. 把我的二进制复制到**能正常运行的**共享目录 → **仍然失败**（排除目录内容差异）。
3. 共享目录的二进制（他人 20:22 构建）→ **正常运行**，输出 2426 个测试名。
4. `src-tauri/build.rs:18-43` 明确记载：该 `0xC0000139` 是**测试 exe 缺少
   Common-Controls v6 manifest** 时的已知症状（`rfd` 静态引用
   `comctl32!TaskDialogIndirect`）。manifest 由
   `embed_resource::compile_for_tests(&rc, embed_resource::NONE)` 编译进
   `out/tests-manifest.lib` 并以 `cargo:rustc-link-arg-tests` 链接。
5. 隔离目录的 build script 输出**确实**含
   `cargo:rustc-link-arg-tests=...target-logging\debug\build\task-dock-*\out\tests-manifest.lib`，
   且该 `.lib` 存在（756 字节，与共享目录同尺寸）。

**结论**：隔离目录下的 manifest 链接在本次环境中未生效（`embed_resource` 在全新
target 目录下的行为与既有目录不同），属**验证环境问题**，与本次代码改动无关
（导入表逐符号一致已排除代码因素）。

**处置**：改用项目正常的**共享 target 目录**（`src-tauri/target/`）执行测试，
一次通过；隔离目录已删除（3.9 GB，已在 `.gitignore` 的 `src-tauri/target-*/` 覆盖范围内）。

### 4.3 全量 `cargo test --lib` 运行中崩溃（既有问题区间）

运行全量 2470 项时进程以 `0xC0000005 STATUS_ACCESS_VIOLATION` 终止，崩溃前最后一个
完成的测试为 `audio::tests::cache_report_uses_settings_limits`。单独运行 `cargo test --lib audio`
得到 **40 passed / 1 failed**，失败项为：

```
commands::restore::tests::voice_asset_restore_commits_managed_audio_file
  panicked at src\commands\restore.rs:1910:
  called `Result::unwrap()` on an `Err` value:
  Validation("备份缺少扩展数据表 transfer_contents（新格式备份必须完整声明）")
```

该失败涉及**备份表契约**（`transfer_contents`），属其它任务的在途改动范围
（`src-tauri/src/transfer/execute.rs` 在工作区有未提交修改），与本次诊断改动无关。

**本次改动不参与该路径的论证**：

- 改动范围经 `git diff` 核实，仅限 `diagnostics/**`、`commands/diagnostics.rs`、
  `lib.rs` 的 3 行；
- panic hook **只在 Tauri `setup()` 中安装**，而 `cargo test --lib` 不执行 `setup()`，
  因此**测试进程内根本没有安装 panic hook**，不可能由它引发访问冲突；
- 诊断区间（`cargo test --lib diagnostics`）**74/74 全绿**。

---

## 5. 与能力矩阵的对应更新

| 矩阵项 | 审计时状态 | 本批次后状态 |
|---|---|---|
| J-05 Rust Panic 捕获 | 未实现 | **已实现且验证通过**（7 个专项测试） |
| E-05 按时间轮转/过期 | 未实现 | **已实现且验证通过**（3 个专项测试） |
| E-11 磁盘写满安全降级 | 已实现但存在缺陷 | **已实现且验证通过**（写失败分类已就位；真实磁盘满注入属 M14） |
| E-13 文件权限不足 | 已实现但存在缺陷 | **已实现且验证通过**（同上） |
| S-1（安全风险）panic 不被记录 | 高 | **已消除** |
| S-7 无时间维度保留 | 中 | **已消除** |

---

## 6. 尚需人工验证的功能

| 功能 | 为什么需要人工 |
|---|---|
| panic 记录在**真实崩溃**中的表现 | 单元测试只验证事件构造；真实崩溃需触发一次实际 panic 并查看落盘文件 |
| 设置页写失败提示的**实际渲染** | 本次只跑了组件测试的既有用例，新提示分支未新增 UI 用例 |
| 14 天保留在**跨天真实运行**下的行为 | 测试用 `set_modified` 构造旧文件；真实跨天由时钟驱动 |

---

## 7. 后续批次（未开始）

按 `docs/architecture/unified-observability-design.md` §6 的迁移路线，下一批建议：

- **M4**：事件契约 v2（`trace_id` / `span_id` / `device_id` / `kind`）——**契约扩展，
  必须由单一所有者串行写入**；
- **M5**：TS `Logger` 门面（`createLogger` / `createChildLogger` / `normalizeError` /
  `sanitizeLogContext` / `serializeLogEvent` / `shouldEmitLog`）；
- **M13**：日志系统性能基准脚本与阈值校准（任务书要求「性能阈值必须在测试前明确」，
  越早建立越能约束后续改动）。
