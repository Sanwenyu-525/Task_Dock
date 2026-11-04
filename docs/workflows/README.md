# 一键工作流（v0.9）

把用户确认过的导航目标 / 任务创建 / 工作现场恢复编排为**可重复执行的白名单动作序列**。
事实优先级与总体约束见仓库根 `AGENTS.md`；本文只记录工作流模块的架构与契约。

- 入口：完整模式左侧导航「工作流」（Ctrl+7）
- 前端：`src/components/workflows/`、`src/store/useWorkflowsStore.ts`、`src/lib/bridge.ts`（`workflow*` 段）
- 后端：`src-tauri/src/workflows/`（`mod.rs` 模型与校验、`store.rs` 持久化、`engine.rs` 执行引擎）、
  `src-tauri/src/commands/workflows.rs`
- 持久化：SQLite 迁移 **v23**（只追加，不改已发布迁移）

## 1. 数据模型（迁移 v23）

```
workflows            定义：id / name / description / enabled / sort_order / created_at / updated_at / last_run_at
workflow_steps       编排：step_type（CHECK 白名单）/ params(JSON) / display_order / enabled / on_error(stop|continue)
workflow_runs        运行头：status(稳定态) / current_step_index / total_steps / completed_steps / started_at / finished_at / error
workflow_run_steps   回执：status(六态) / detail / result(JSON 摘要) / started_at / finished_at / operation_id
```

- 外键级联：删工作流 → 步骤 / 运行 / 回执一并删除；`operation_id` 在**执行副作用之前**落库（幂等审计依据）。
- 步骤保存为「整表替换」原子事务（`workflow_replace_steps`）：增删改排序共用，失败整体回滚。
- 运行历史保留：每工作流最近 50 条（`prune_runs` 只删运行记录，绝不碰定义与步骤）。

### 备份登记

四表全部登记 `BACKUP_TABLES`（class=workflow）与 `EXTENDED_TABLES`，恢复依赖序：
`workflows → workflow_steps → workflow_runs → workflow_run_steps`。
完整备份全量；快速备份中**定义与步骤全量保存**（用户配置不截断），运行头与回执按
最近 20 次运行截断（`QUICK_WORKFLOW_RUN_LIMIT`，回执按运行子集过滤保证引用完整）。

## 2. 步骤类型白名单与参数校验

| 类型 | 参数 | 执行语义 | 校验 |
|---|---|---|---|
| `open_app` | `target_id` | `nav_navigate`（application 目标；优先唤醒已有窗口） | 目标存在且类型匹配，执行时重校验 |
| `open_url` | `target_id` | `nav_navigate`（url 目标） | 同上 |
| `open_path` | `target_id` | `nav_navigate`（file / directory 目标） | 同上 |
| `create_task` | `title`（必填 ≤200）、`description`（≤2000）、`priority`（0~3，默认 2）、`remind_at`（RFC3339 可选）、`advance_minutes`（0~43200） | `create_task_inner`（任务 + 提醒同事务） | 保存与执行双重校验；**每次运行创建新任务**（UI 有明确提示） |
| `restore_workspace` | `snapshot_id` | `workspace::start_restore`（统一恢复门禁），等待其真正退出后返回 | 快照存在；取消位传递给恢复；120s 超时只停止等待，**绝不强制终止系统操作** |
| `enter_scene` | `scene_id`（保留） | **依赖场景工作区模块（尚未集成）：校验层一律拒绝**，类型与参数位保留，模块就绪并经验证后再启用 | — |

安全边界：

- **没有任意 Shell / PowerShell / 脚本下载执行**；步骤类型在 SQL CHECK 与 Rust 枚举双层白名单；
- 前端只传目标 / 快照 **ID**，路径由后端从数据库读取并在执行前重新校验（复用导航模块既有安全层）；
- 参数校验共用 `validate_step`（保存时引用存在性检查 + 执行时重校验，目标可能已被删除）；
- 单工作流步骤数上限 50（`MAX_STEPS`）。

## 3. 执行状态机

### 运行整体（持久化稳定态）

```
idle ──run──▶ running ──全部步骤完成──▶ completed
               │  ▲
         pause │  │ resume
               ▼  │
             paused          （暂停：当前步骤处理到安全边界后不再推进）
               │
running/paused ──cancel──▶ cancelled   （后续步骤全部 cancelled；已启动的动作不撤销）
running ──失败且 on_error=stop──▶ failed（剩余步骤 cancelled）
running/paused ──应用异常退出──▶ interrupted（启动恢复标记，绝不自动重放）
```

- 过渡态（pausing / cancelling）**只存在于内存与事件流**；持久层只写稳定态，
  崩溃恢复不会误标。`workflow_runs.status` CHECK 约束六种稳定态。
- 步骤回执六态：`pending → running → succeeded | skipped（步骤停用）| failed | cancelled`。
- 失败策略按步骤配置：`stop`（默认，后续 cancelled）或 `continue`（记录失败继续；
  全部步骤处理完后整体仍记 `completed`，失败明细在步骤回执）。

### 引擎实现要点（engine.rs）

- **全局单槽**：进程内 `ACTIVE` Mutex<Option<ActiveRun>>，同一时刻最多一个工作流；
  申请槽与建运行在同一锁段完成（锁内只有内存读写与一次 SQLite 事务，无窗口 / 文件 /
  IPC 阻塞调用），彻底消除「双击两个请求都通过检查」的竞态；释放只认自己的 run_id。
- **控制位**：`RunControl`（paused / cancelled 原子位 + Condvar）。取消位立即打断
  暂停等待与桌面互斥等待；已进入执行的步骤如实完成（不可中断，UI 有明确说明）。
- **桌面互斥**：会抢焦点的步骤（open_app / open_url / open_path / restore_workspace）
  在工作现场恢复运行期间等待（轮询 `restore_status`，上限 30s）；超时该步骤失败并
  如实提示，不与恢复争夺焦点。
- **panic 隔离**：单步 `catch_unwind`，执行器异常退出一律记为该步骤 failed；
  槽 guard 为 RAII，引擎线程无论正常 / 取消 / panic 都释放槽。
- **事件推送**：状态迁移点 emit `workflow-run-progress`（payload = 完整运行详情）；
  前端面板挂载期间订阅（`createSubscriptionScope` 引用计数），隐藏时不轮询，
  重新挂载用 `workflow_active` 按需查询。事件缓冲由 Tauri 事件通道承担，无自建队列。

## 4. 幂等与异常恢复

- 连续双击「运行」：第二个请求被全局槽拒绝（`Conflict`，可读文案）。
- 重复重试创建任务：`create_task` 步骤**天然不幂等**——每次运行创建新任务（UI 明确
  提示）；同一次运行内每步只执行一次；`operation_id` 落库可审计「哪次运行创建了哪个任务」。
- 已运行应用重复启动：导航层自带的 `nav_prefer_focus` 偏好负责唤醒优先，工作流不额外启停进程。
- 刷新页面 / 重挂载：运行照常在后端推进（事件是推送不是页面状态），重新打开面板即恢复视图。
- 应用异常退出：下次启动 `recover_stale_runs` 把遗留 running / paused 运行标为
  `interrupted`（running 步骤标 failed 并注明「结果未知，请人工确认」、pending 标
  cancelled）；**恢复后不自动重放任何有副作用的步骤**。恢复操作幂等（无遗留行为空操作）。

## 5. 命令清单（commands/workflows.rs，16 个）

定义：`workflow_list` / `workflow_get` / `workflow_create` / `workflow_update` /
`workflow_delete` / `workflow_duplicate` / `workflow_reorder` / `workflow_replace_steps`
运行：`workflow_run`（async）/ `workflow_pause` / `workflow_resume` / `workflow_cancel` / `workflow_active`
历史：`workflow_run_detail` / `workflow_last_run` / `workflow_last_run_summary` / `workflow_list_runs`

参数 camelCase；控制类命令（pause / resume / cancel）只做槽位读写与标志置位，
**不在 IPC 线程内等待引擎**。

## 6. 与场景工作区的接口边界

- `enter_scene` 已在白名单中保留类型与参数位（`scene_id`），UI 中该选项置灰并注明依赖；
- 场景模块（其他子任务开发）就绪并经验证后，只需在 `workflows/mod.rs::validate_step`
  的 `EnterScene` 分支接入真实校验、`engine.rs::LiveExecutor` 接入真实执行，不改表结构；
- 工作流**不另建场景表**、不直接修改场景模块内部实现。

## 7. 测试与验收状态

- Rust：`cargo test --lib` 734 通过（含工作流 32 项：CRUD / 校验拒绝 / 事务回滚 /
  排序 / 运行生命周期与保留 / interrupted 恢复 / 顺序与失败策略 / 暂停继续 / 取消 /
  桌面互斥可取消 / 槽互斥与防迟到清理 / panic 隔离）。
- 前端：`npx vitest run` 1117 通过（含 useWorkflowsStore 13 项、导航契约与快捷键契约）；
  `npm run build`（tsc strict + vite）通过。
- 真机窗口跳转 / 现场恢复步骤联动 / 深浅主题走查：**NOT VERIFIED**（待真机验收，
  见 `tmp/acceptance/one-click-workflows/report.md`）。
