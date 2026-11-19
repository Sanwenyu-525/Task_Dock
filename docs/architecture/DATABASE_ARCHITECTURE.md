# 数据库架构（DATABASE ARCHITECTURE）

| 项目 | 内容 |
|---|---|
| 文档状态 | 生效（Phase 1，待评审） |
| 最后更新 | 2026-11-19 |
| 适用范围 | 桌面 `src-tauri/src/db/` 及各模块 store、移动端 `apps/mobile/src/db/` |
| 上级 | [目标架构](TARGET_ARCHITECTURE.md) |
| 事实依据 | [当前架构审计](CURRENT_STATE_AUDIT.md) §4.3 |

---

## 1. 现状事实（2026-11-19 实测）

| 项 | 事实 |
|---|---|
| 主库 | `%APPDATA%\com.taskdock.desktop\task-dock.db`（`TASK_DOCK_DATA_DIR` 可覆盖） |
| 连接模型 | 单写连接 `Mutex<Connection>` + 3 只读连接（READ_POOL_SIZE=3）；WAL、`foreign_keys=ON`、`busy_timeout=5s`；只读连接 `query_only=true` |
| 迁移 | `MIGRATIONS: &[(i64,&str)]`，版本 1→78，混合内联 SQL 与 `crate::*::MIGRATION_N` 外部常量；`BEGIN IMMEDIATE` + `execute_batch` + `user_version` + `COMMIT`，失败 `ROLLBACK` |
| 事务 API | `with_transaction()`（`TransactionBehavior`）、`with_read()`（`try_lock` 跳过忙连接）、`with_conn()` |
| SQL 热点 | `db/mod.rs` 273、`clipboard/store.rs` 190、`commands/backup.rs` 170、`commands/data.rs` 108、`commands/tasks.rs` 98 处 |
| Repository 现状 | 8 个类 store 层（clipboard/notes/focus/hotkeys/quick_capture/secure_vault/workflows/agent_access），覆盖不完整 |
| 备份 | `BACKUP_TABLES` 143 张表（README 写 43，已过时）；含设置、剪贴板图片、暂存文件、preferences header |
| 移动端 | `expo-sqlite` 唯一入口在 `apps/mobile/src/db/`；Outbox 表 + 三态补丁 + 同事务 |

## 2. 数据访问规范

1. **统一入口**：UI 不直接访问数据库；业务逻辑不直接依赖 SQL。SQLite 访问集中在 `db/`（桌面）与 `apps/mobile/src/db/`（移动）。
2. **Repository 边界**：Domain 定义 Repository trait，Infrastructure 实现。Command/Service 通过 trait 访问数据，SQL 封装在实现内。
3. **Unit of Work**：多表写入、跨实体更新、备份恢复必须有明确事务边界，失败回滚，避免嵌套事务造成死锁或状态不一致。
4. **参数化**：SQL 一律用 `?1`/`params` 绑定；`format!` 仅用于编译期常量列名（如列清单常量），不插值用户输入。动态过滤来源需复核。
5. **索引策略**：新查询配索引；万级数据性能以实测为准（全局搜索未引 FTS5，README 已标注）。
6. **完整性约束**：用 CHECK/FK 表达业务不变量（如 priority、status），与 Domain 规则互补。

## 3. 迁移规范（红线）

- 历史迁移**只追加**，不改已发布迁移内容。
- `MIGRATIONS` 版本号、顺序、`user_version` 语义、表结构完全不变。
- 迁移文件化（Phase 3）只改 SQL 文本来源：内联字符串 → `include_str!("migrations/vNN.sql")`，逐字节等价。
- 每次迁移变更必须：隔离测试库全版本回放 → 验证 `user_version` → 验证备份/恢复 → 不碰生产库。
- 迁移失败必须回滚且不推进 `user_version`（现有测试 `db/mod.rs:5066,5085-5089` 覆盖）。

## 4. Repository 迁移路线

```
Db（保留公开 API 作为 Facade）
  ↓ 提取
ConnectionManager（连接/读写池/WAL）
  ↓ 建立
Repository trait（Domain 定义）+ SqliteRepository 实现（Infrastructure）
  ↓ 命令改造
Application Service 用 Repository + Unit of Work 编排
  ↓ 命令层
Command 只做 DTO 转换与调用，SQL 归零
```

优先级：`commands/tasks.rs` → `commands/backup.rs` → `commands/data.rs` → `clipboard/store.rs`（已有雏形，完善）→ capability/shelf/navigation 等。

## 5. 缓存一致性

- 只读连接 `try_lock` 跳过被长快照占用者；全部繁忙时回退阻塞（现状已实现）。
- 前端缓存（dirCache/volumeCache/fileJobs 等模块级单例）必须与数据库变更失效联动；变更通知经事件系统（带版本/释放）。
- 剪贴板缩略图缓存随条目清理失效；OCR 结果缓存同理。

## 6. 备份与恢复

- 备份覆盖 143 张业务表 + 设置 + 图片 + 暂存文件 + preferences header；旧备份缺字段保留本机值。
- 恢复有状态机，异常退出可续跑或回滚；恢复测试用隔离库。
- 备份表清单数据化后必须与旧备份兼容（新增表不影响旧备份恢复）。

## 7. 测试要求

- 迁移回放：从 v1 到 v78 逐版本应用，断言最终 schema 与 `user_version`。
- Repository 契约测试：trait 的实现满足同一组行为。
- 并发测试：多读单写、忙超时、WAL 检查点。
- 备份恢复测试：全量/快速备份 → 恢复 → 数据一致性校验。
- 故障注入：数据库 busy、磁盘满、权限不足时错误可恢复且不损坏数据。
