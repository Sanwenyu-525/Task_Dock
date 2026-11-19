# Phase 3 基础设施重构 · 执行预案与状态

| 项目 | 内容 |
|---|---|
| 文档状态 | **方案就绪 / 执行冻结（等待稳定基线）** |
| 最后更新 | 2026-11-19 |
| 适用范围 | 第一批基础设施重构（IPC / Database / 应用入口 / 错误 / 事件 / 生命周期） |
| 上级 | [路线图](REFACTOR_ROADMAP.md)、[模块迁移矩阵](MODULE_MIGRATION_MATRIX.md) |
| 相关 ADR | 0002（渐进重构）、0003（错误契约）、0004（迁移红线）、0005（守卫） |

---

## 1. 当前状态：冻结，不执行业务代码改动

**决策**：Phase 3 的业务代码重构在本次会话**冻结**，仅交付可立即落地的执行预案。

**根因（可复现证据，2026-11-19 实测）**：

1. **工作区处于多 Agent 并行修改的中间态**：审计开始时 22 个 modified + 14 个 untracked；数分钟后已变为新的一批（`Combobox/DropdownMenu/Popover/Select/positioning.ts`、`services/`、`closeTrace.ts`、`docs/architecture/ui/`），files-workspace 那批已消失。工作区是动态共享的。
2. **基线本身编译不通过**：`npm run typecheck` 退出码 2，错误位于其他 Agent 在途文件：
   - `src/workbench/workbenchCloseGuard.ts(410,25)` TS2554
   - `src/workbench/WorkbenchShell.tsx(1195,25)` TS2349 / `(1196,16)` TS2322
   - 均为 `WorkbenchCloseGuardHandle` 返回类型与调用方函数签名不匹配，属在途改动中间态，非本任务范围。
3. **无法验证"行为不变"**：重构的第一验收标准是现有测试全绿 + typecheck 通过。基线 typecheck 已失败，无法证明我的改动是否引入新错误。
4. **目标文件是共享枢纽**：`bridge.ts`/`lib.rs`/`db/mod.rs` 属 `AGENTS.md` §3.2 定义的共享枢纽文件，必须唯一所有者串行写；且 `errorReport.ts` 有 8 个调用方，改动需全量回归。

**结论**：此时强行重构会同时违反用户三条核心原则——"保证已有功能不因架构重构退化""不能为了赶进度跳过评审""发现冲突暂停并报告"。冻结是遵守门禁，不是跳过。

**解冻条件（全部满足）**：

- [ ] 工作区 `git status` 稳定（连续两次间隔无变化），无其他 Agent 在途改动目标文件；
- [ ] `npm run typecheck` 退出码 0；`npm test` 全绿；`cargo test`（在 src-tauri/，需 dist）全绿；
- [ ] 架构评审对 Phase 1 方案签字（本会话未以工具代替人工评审）；
- [ ] 主 Agent 明确指定三个共享枢纽文件的唯一所有者并锁定串行写。

---

## 2. 一旦解冻：执行顺序与批次

严格按"一次一个边界"，每批独立提交、独立测试、独立报告。详见 §3–§7 迁移对照表。

```
3.1 IPC Bridge 内部拆分（保留 facade）
   ↓ typecheck + test
3.2 错误契约单一事实源（先文档/契约，后代码归一）
   ↓
3.3 Rust db 迁移文件化（红线，隔离库回放）
   ↓
3.4 Rust lib.rs 拆分 app/*
   ↓
3.5 事件系统统一封装
   ↓
3.6 资源生命周期 + 修 pipeline 持锁跨 await
```

**不做**：不动移动端与桌面端的强行耦合；不把简单 CRUD 强塞五层；不在无数据证据时引入 CQRS。

---

## 3. 批次 3.1：IPC Bridge 内部拆分

| 项目 | 内容 |
|---|---|
| 现有文件 | `src/lib/bridge.ts`（7027 行，1028 导出，547 invoke） |
| 命令域分布（实测） | clipboard 64、shelf 63、fs 33、workspace 30、agent 27、planning 24、workflow 18、mcp 18、mobile 12、resource 10、voice 9、task 5、tts 4、project 4，其余为窗口/工具栏命令 |
| 目标文件 | `src/lib/bridge/index.ts`（facade，re-export 全部符号）+ `bridge/{clipboard,shelf,fs,workspace,agents,planning,workflows,mcp,mobile,resources,tasks,system}.ts` + `src/lib/contracts/commands.ts` |
| 兼容方案 | `bridge.ts` 保留为 facade，公开导出**零变化**；调用方零改动；`import ... from "./bridge"` 继续可用 |
| 迁移法 | 先按域把函数体移到子文件 → `bridge.ts` 改为 re-export → typecheck → 逐域切调用方 → 全绿后评估是否删 facade |
| 测试方案 | `npm run typecheck` + `npm test`；新增契约测试比对 `CommandContracts` 与 Rust `#[tauri::command]` 签名 |
| 回滚 | 恢复 `bridge.ts` 原文件；子文件删除；无调用方改动则零风险 |
| 前置 | 基线 typecheck 全绿；bridge 未被其他 Agent 占用 |

## 4. 批次 3.2：错误契约归一（ADR-0003）

| 项目 | 内容 |
|---|---|
| 现有文件 | `src-tauri/src/error.rs`、`src/lib/errors.ts`、`apps/mobile/src/lib/errors.ts`、`errorReport.ts`、`i18n/errors.ts` |
| 已确认问题 | 三处 `AppError` 同名异义（后端 PascalCase 14 码 / 前端 17 码白名单 / 移动小写码集）；`errorReport.ts:14` 反向依赖 `useUiStore` |
| 现有函数（`errorReport.ts`） | `errorSuggestion:28`、`formatErrorForUser:63`、`runRetrySafely:76`、`logOwnedError:94`、`reportError:133`、`recordBackgroundError:155` |
| 调用方 | 8 个（App.tsx、AgentPanel、ErrorBoundary、AppPicker、SettingsPanel、diagnostics、errors、globalErrors） |
| 目标文件 | `shared/contracts/error-codes.json`（单一事实源）+ 三端码表派生文件 + 契约测试 |
| 兼容方案 | 保留 `AppError` 公开 API；旧码映射表；errorReport 修复改"事件上抛 + app 层订阅 showToast"，保持同步返回归一化错误的语义（showToast 可在同一事件循环内同步触发，不改成 await） |
| 测试方案 | 三端错误码契约测试；敏感信息不落日志测试；取消语义测试；8 个调用方回归 |
| 回滚 | 恢复 errorReport.ts 与三端 errors 文件；契约文件为新增可独立删除 |
| 前置 | 基线全绿；需特别验证 Toast 弹出行为不退化 |

## 5. 批次 3.3：Rust db 迁移文件化（ADR-0004 红线）

| 项目 | 内容 |
|---|---|
| 现有文件 | `src-tauri/src/db/mod.rs`（7010 行，`MIGRATIONS` v1→78） |
| 现有函数 | `open:2219`、`open_in_memory:2253`、`conn:2270`、`with_read:2277`、`with_conn:2544`、`open_worker_connection:2552`、`with_transaction:2565`、`apply_migrations:2696`、`configure_writer:2665`、`open_reader:2672`、`get/set_setting:2479/2491`、`seed:2419`、`migrate:2391` |
| 目标文件 | `app/state/connection_manager.rs`（提取 open/池/WAL）+ `infrastructure/sqlite/migrations/v01..v78.sql`（`include_str!`）+ `infrastructure/sqlite/repositories/`（trait + 实现） |
| 红线 | 版本号 1→78、顺序、`user_version`、表结构完全不变；SQL 文本逐字节等价；143 张备份表不删 |
| 兼容方案 | `Db` 保留全部公开 API 作为 facade；Repository 逐步承接，不一次切完 |
| 测试方案 | 隔离库 v1→v78 全版本回放；`user_version` 断言；迁移原子性（失败不推进版本，现有 `db/mod.rs:5066`）；备份 143 表恢复一致性；`cargo test` |
| 回滚 | 保留原 `MIGRATIONS` 定义；文件化可逐版本回退 |
| 前置 | `cargo test` 全绿；隔离测试库；不碰生产库 |

## 6. 批次 3.4：Rust lib.rs 拆分

| 项目 | 内容 |
|---|---|
| 现有文件 | `src-tauri/src/lib.rs`（2859 行，57 mod，764 命令注册，17 manage） |
| 现有函数 | `run:572`、`setup_tray:306`、`refresh_tray:276`、`tray_icon_bytes:212`、`tray_tooltip:227`、`restore_window:370`、`window_mostly_offscreen:2350`、`startup_intent_from_args:141`、`process_send_to:170`、`flush_workbench_before_exit:2193`、`complete_exit_handshake:2185`、`request_exit:2230`、`startup_timeout_event:2378`、`agentctl:2493` |
| 目标文件 | `app/bootstrap.rs`、`app/state.rs`、`app/commands.rs`（唯一 generate_handler!）、`app/windows.rs`、`app/tray.rs`、`app/lifecycle.rs`、`app/cli.rs`；`lib.rs` 只留 mod 声明 + `run()` 编排 |
| 兼容方案 | 全部 `pub(crate)` 内部重组；对外命令名与行为零变化；lib.rs 薄包装 |
| 测试方案 | `cargo test`；启动/退出握手真机验收；命令注册数 764 不变 |
| 回滚 | 恢复 lib.rs；新模块删除 |
| 前置 | 3.3 完成；cargo test 全绿 |

## 7. 批次 3.5–3.6：事件与生命周期

| 批次 | 现有 | 目标 | 兼容/测试 |
|---|---|---|---|
| 3.5 事件 | Tauri listen 散布；多 Set<Listener>；`diagnostics.ts:162` 动态 import 打断环 | 统一 `subscribeEvent<T>` + Unsubscribe；事件带版本 | 保留 `__resetForTests`；订阅清理测试、无环测试；守卫 CIRC-001 从例外转正 |
| 3.6 生命周期 | `pipeline.rs:632,650` 持 `shutdown_lock` 跨 `wait_for_stopped().await` | 只在置/取标志时加锁，等待移到锁外 | 幂等 shutdown 行为不变；并发测试；真机退出验收 |

---

## 8. 每批交付报告要求

按用户要求写入 `tmp/acceptance/architecture-governance/<batch>/report.md`，含 20 项（任务目标→回滚方式），结论只用：通过 / 部分通过 / 不通过 / 证据不足。未执行的测试明确标注，不用历史结果冒充。

## 9. 本会话实际执行状态

| 批次 | 状态 | 说明 |
|---|---|---|
| 3.1 Bridge（第一步：类型契约分离） | ✅ 完成（2026-11-19） | bridge.ts 7027→2785 行；新增 `contracts/models.ts`(4633) + `contracts/navigation.ts`(60)；公开导出 1028/64 零缺失；typecheck 0、137 测试通过、守卫无新增。报告：`tmp/acceptance/architecture-governance/phase3-1-ipc-contracts/report.md` |
| 3.1 Bridge（第二步：函数按域拆） | ⏸ 待开始 | 方案见 §3；`contracts/models.ts` 亦按域拆 |
| 3.2 错误 | ⏸ 冻结 | 方案见 §4 |
| 3.3 数据库 | ⏸ 冻结 | 方案见 §5 |
| 3.4 lib.rs | ⏸ 冻结 | 方案见 §6；**当前 lib.rs 正被其他 Agent 修改，不可触碰** |
| 3.5 事件 | ⏸ 冻结 | 方案见 §7 |
| 3.6 生命周期 | ⏸ 冻结 | 方案见 §7 |

**审计结论更正（2026-11-19 深入分析）**：`agents/pipeline.rs:632,650` 的 `shutdown_lock` 为 `tokio::sync::Mutex`（async mutex），跨 `.await` 持有是其设计用途，用于串行化重复 shutdown（第二次返回 `already_stopped`）。这不是 `std::sync::Mutex` 跨 await 的错误；强行改为锁外等待会破坏幂等串行语义。**本条从"待修"改为"确认正确，不改"**，Phase 0 审计的"可疑模式"判断予以更正。

**本会话业务代码改动**：仅 3.1 第一步（类型契约搬移），未改任何运行时逻辑。
