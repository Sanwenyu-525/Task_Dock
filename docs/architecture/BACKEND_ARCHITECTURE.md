# 后端架构（BACKEND ARCHITECTURE）

| 项目 | 内容 |
|---|---|
| 文档状态 | 生效（Phase 1，待评审） |
| 最后更新 | 2026-11-19 |
| 适用范围 | Rust 后端 `src-tauri/src/` |
| 上级 | [目标架构](TARGET_ARCHITECTURE.md) |
| 事实依据 | [当前架构审计](CURRENT_STATE_AUDIT.md) §2.2/§3.2/§4.2/§4.3 |

---

## 1. 分层职责（后端）

| 层 | 职责 | 禁止 |
|---|---|---|
| Commands (Interface) | Tauri IPC 入口：参数接收、必要校验、DTO 转换、调用下层、返回结果 | 不承担复杂业务编排、不直接写业务 SQL |
| Application | 用例执行、事务边界、跨领域流程（复杂用例才有） | 不依赖 UI/Tauri Command；不控制具体 SQL 方言 |
| Domain | 业务规则、实体、值对象、领域服务、状态机 | 不 import rusqlite/Tauri/Win32（纯） |
| Infrastructure | SQLite、文件系统、网络技术实现；Repository 实现 | 不被 Domain 依赖（Domain 定义 trait，Infrastructure 实现） |
| Platform | Win32 / DWM / WinRT 平台 API | 不承载业务规则 |
| App | 依赖装配、生命周期、窗口、插件注册 | 不写业务逻辑 |

**裁剪原则**：简单 CRUD（单个表、无跨实体规则）允许 Command → Repository 直连，不强制经过 Application/Domain 全套。只有涉及事务编排、跨实体规则、状态机的用例才引入 Application。

## 2. lib.rs 上帝文件拆分（P0）

现状：2859 行，57 mod 声明，run() 约 1600 行，17 处 manage，764 条命令注册，托盘/窗口/事件/退出握手/CLI/单测混杂。

目标拆分（全部 `pub(crate)` 内部重组，不改对外命令名与行为）：

| 目标模块 | 承接内容 | 现函数/行号 |
|---|---|---|
| `app/bootstrap.rs` | 插件注册、状态装配 | `lib.rs:583-615`、`660-1140` |
| `app/commands.rs` | `generate_handler!` 唯一注册处 | `lib.rs:1283` |
| `app/windows.rs` | 窗口创建、几何、restore | `lib.rs:370,621,2350` |
| `app/tray.rs` | 托盘创建与刷新 | `lib.rs:212-306` |
| `app/lifecycle.rs` | 启动意图、退出握手、on_window_event | `lib.rs:141-170,2193-2230,2378` |
| `app/cli.rs` | `agentctl` | `lib.rs:2493` |
| `lib.rs` | 仅保留 mod 声明 + `run()` 编排 | `lib.rs:572` |

迁移法：先建新模块并把函数体搬过去，`lib.rs` 保留薄包装；全部测试通过、无行为变化后再删包装。

## 3. db/mod.rs 与数据边界（P0）

现状：7010 行；`MIGRATIONS: &[(i64,&str)]` 混合内联 SQL 与 `crate::*::MIGRATION_N` 外部常量；版本 v78；单写连接 + 3 只读连接，WAL；`with_read/with_conn/with_transaction` 被命令直接调用。

目标：

```
Db (保留公开 API 作为 Facade)
  ├── ConnectionManager      连接/读写池/WAL 配置（从 open/configure_writer 提取）
  ├── migrations/
  │     v01.sql ... v78.sql   每版本一文件，include_str! 引用
  └── repositories/
        tasks_repo.rs  clipboard_repo.rs  backup_repo.rs ...
        trait XxxRepository { ... }   Domain 定义 trait，此处实现
```

**迁移红线（不可破坏）**：
- `MIGRATIONS` 版本号 1→78、顺序、`user_version` 语义、表结构完全不变；
- 文件化只改"SQL 文本从内联字符串变为 include_str! 文件"，不改 SQL 内容；
- 备份表清单（143 张）可数据化为常量数组，但不删任何表；
- 用隔离测试库做全版本迁移回放，验证备份与恢复；不碰生产库、不清用户数据。

Application Service 迁移（Command 去 SQL）：优先 `commands/tasks.rs`(98 处)、`backup.rs`(170 处)、`data.rs`(108 处)。每个模块：定义 Repository trait → 实现 → Command 改为调用 → 测试行为不变。

## 4. 命令层规范

- `generate_handler!` 只在 `app/commands.rs` 出现一次。
- 39 个未注册的 `#[tauri::command]`（803 宏 - 764 注册）需复核：死代码则删除，遗漏注册则补上，记入审计报告。
- 命令命名参数 camelCase（前端），Rust 侧 `#[serde(rename_all = "camelCase")]`；新增命令同步前端类型与 Rust 签名。
- 命令内不记录敏感正文（剪贴板/密钥/路径），错误经 `AppError` 统一映射。

## 5. 异步并发规范

- 不跨 `.await` 持有 `std::sync::Mutex` 或不必要的 tokio 锁。
- `agents/pipeline.rs:632,650`：`shutdown()` 持 `shutdown_lock` 跨 `wait_for_stopped().await` → 缩小锁粒度（只在取/置标志时加锁，等待在锁外）。
- 长阻塞（Argon2 KDF、文件扫描、OCR）用 `spawn_blocking`；不占 Tokio 异步执行器。
- 有界队列 + 超时 + 可取消；任务退出与应用关闭关系明确（当前 pipeline 的 `spawn_blocking` 无取消语义，超时只报告不取消写入——需在文档中如实标注）。
- 37 处 shell 调用（含 `powershell.exe`/`cmd.exe`）：结构化参数、不拼 shell 字符串；逐一验证参数来源，保留并扩展元字符拒绝测试。

## 6. 安全规范（摘要，详见 SECURITY.md）

- CSP 现有 `'unsafe-inline'` 是放宽项，评估用 nonce/hash 收敛；不降低现有防护。
- Capability 按窗口隔离已到位；主窗 `default.json` 权限面偏宽，逐命令收敛。
- 路径校验统一 `canonicalize` + 边界检查（防符号链接逃逸，如 `mobile_sync/files.rs:255` 的 `starts_with` 需先 canonicalize）。
- SQL 一律参数化；`format!` 仅用于编译期常量列名；动态过滤来源需复核。
- origin 服务端判定机制保留（`agents/mod.rs`）；事件载荷客户端不可提升来源。

## 7. 测试要求

- `cargo test` 需先 `npm run build` 生成 dist；在 `src-tauri/` 内运行，不用 `--manifest-path`。
- `cargo fmt --check`、`cargo clippy` 无新增告警。
- 迁移回放测试（隔离库）、Repository 契约测试、Command→Service→Repository 集成测试。
- `#[ignore]` 的性能/真机套件不计入普通通过结论。
