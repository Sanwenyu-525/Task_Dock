# 一键工作流（v0.9）

把用户确认过的导航目标 / 任务创建 / 场景进入 / 工作现场恢复编排为**可重复执行的白名单动作序列**。
事实优先级与总体约束见仓库根 `AGENTS.md`；本文只记录工作流模块的架构与契约。

- 入口：完整模式左侧导航「工作流」（Ctrl+7）；场景工作区嵌在工作流页内，不新增导航入口
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
| `enter_scene` | `scene_id` | 调用场景服务逐项进入；工作现场恢复等待真实终态，结果写入步骤回执 | 场景存在；场景/工作流关系图无循环且不超过 3 层 |

安全边界：

- **没有任意 Shell / PowerShell / 脚本下载执行**；步骤类型在 SQL CHECK 与 Rust 枚举双层白名单；
- 前端只传目标 / 快照 **ID**，路径由后端从数据库读取并在执行前重新校验（复用导航模块既有安全层）；
- 参数校验共用 `validate_step`（保存时引用存在性检查 + 执行时重校验，目标可能已被删除）；
- 单工作流步骤数上限 50（`MAX_STEPS`）。
- 场景步骤编辑器从真实场景列表选择 ID；保存和运行前均重验，场景被删除后工作流不能继续运行该步骤。
- 场景/工作流关联组成有向图：保存关联与运行前都会检查直接/间接循环，最多 3 层嵌套。
  **层数口径（2026-11-06 明确）**：一层 = 一条「场景 → 场景关联工作流」边；工作流步骤「进入场景」不计层。
  因此 `场景A → 工作流B → 场景C → 工作流D` 为 2 层；三层允许，第四条关联工作流边在保存与运行前均拒绝。
  校验从图中每个节点起算，保证任一入口（直接进入场景 / 直接运行工作流）展开后都不超过上限。
  进入场景的工作流步骤不会递归启动场景关联工作流，结果明确记为跳过并使该步骤失败，避免抢占全局单运行槽。

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
- **桌面互斥**：会抢焦点的步骤（open_app / open_url / open_path / enter_scene / restore_workspace）
  在工作现场恢复运行期间等待（轮询 `restore_status`，上限 30s）；超时该步骤失败并
  如实提示，不与恢复争夺焦点。
- **panic 隔离**：单步 `catch_unwind`，执行器异常退出一律记为该步骤 failed；
  槽 guard 为 RAII，引擎线程无论正常 / 取消 / panic 都释放槽。
- **事件推送**：状态迁移点 emit `workflow-run-progress`（payload = 完整运行详情）；
  前端面板挂载期间订阅（`createSubscriptionScope` 引用计数），隐藏时不轮询，
  重新挂载用 `workflow_active` 按需查询。事件缓冲由 Tauri 事件通道承担，无自建队列。
- 工作流内进入场景复用 `scenario` 服务并传递取消位；关联现场恢复走现有恢复门禁，等待恢复槽退出后读取逐项持久化结果。失败、跳过、未知结果不会标成场景步骤成功。
- **场景步骤回执契约（2026-11-08）**：`enter_for_workflow` 正常进入后一律返回
  `Ok(ScenarioEnterResult)`（gate 冲突、场景不存在等仍为 `Err`），不再把部分失败/取消
  压成一行错误文字；执行器用 `build_scene_step_receipt` 把步骤 `result` 写为含
  `summary / scene_id / scene_name / total / processed / cancelled / timed_out / outcome /
  items[]` 的 JSON（items 每项 `{index, kind, label, status, detail}`，只含展示名、状态与
  原因，不落窗口标题/路径/HWND）。引擎按 `outcome` 判定步骤：`completed` → succeeded；
  `partial` → failed（`result` 照常保留，随后按 `on_error` 停止/继续）；`cancelled` →
  cancelled 并取消剩余步骤与运行；无 `outcome` 字段的回执完全走原成功分支（兼容旧
  执行器与旧运行记录，前端解析容错见第 6 节）。

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

## 6. 场景工作区与结果语义

- 场景管理位于工作流页内，提供列表、搜索、创建/编辑、删除、复制、进入和逐项结果；工作流编辑器可选择真实场景。
- 手动进入场景时，同步应用/网页/文件夹结果使用 `ok / skipped / failed`；现场与关联工作流的 `ok` 只表示已受理。界面订阅现有 `workspace-restore-progress` / `workflow-run-progress` 事件展示运行中、完成、失败、取消或部分成功，不新增常驻轮询。
- 场景删除只删除场景定义，不删除其关联工作现场、工作流或真实文件；现场和工作流软引用按既有规则处理。
- 场景编辑器通过 `shelf_items.scene_id` 持久化暂存文件/文件夹关联；一个条目同一时刻归属一个场景，保存时在立即事务中校验并更新所有权。路径失效时仍保留稳定 shelf ID；复制场景不转移关联；删除场景只解除关联，不删除暂存记录或真实文件。该字段已随暂存架表进入备份清单，无需新增迁移。
- 工作现场恢复仍按 `workspace-restore-progress` 每项反馈并经单恢复槽执行；已发出的应用启动不能撤回。工作流内等待取消时会向当前恢复操作发取消请求并等待其退出；120 秒超时只停止等待，不强杀系统操作。恢复应用时先按窗口身份查找并唤醒已有窗口，找不到才尝试启动；启动请求与窗口确认使用不同验证级别。
- 当前快照记录 exe、窗口类名和标题用于身份匹配，不保存窗口矩形、尺寸、显示器或 DPI，因此当前能力不包含窗口位置/大小恢复。多显示器与 DPI 几何恢复、窗口消失/重启后的实际结果仍未验证；本轮没有进行真机操作。
- 现有工作现场详情展开显示条目和上次结果/验证级别，恢复期间按事件显示逐项结果；场景编辑器只选择快照，不复制另一套快照预览。
- 场景步骤逐项回执展示（2026-11-08）：运行详情对 `enter_scene` 解析 `result` JSON 并在
  步骤卡片内渲染嵌套清单（`src/components/workflows/receipt.ts` 纯解析：null/空串/非法
  JSON/缺 items 返回 null 绝不 throw；旧结构 label 回退 `kind #index`、detail 为空、
  outcome 由状态推导）。取消回执只含已处理项并注明「剩余 N 项未执行」，不伪造
  skipped/failed；旧运行记录（result 为空或旧 JSON）退回现有 detail 文案。定义预览
  `display.ts` 的 enter_scene 同步改为「场景 <id> /（待选择场景）」，删除过期的
  「场景工作区未集成」占位文案。

## 7. 测试与验收状态

- 历史基线（场景步骤接入前）：`cargo test --lib` 734 通过（含工作流 32 项：CRUD / 校验拒绝 / 事务回滚 /
  排序 / 运行生命周期与保留 / interrupted 恢复 / 顺序与失败策略 / 暂停继续 / 取消 /
  桌面互斥可取消 / 槽互斥与防迟到清理 / panic 隔离）。
- 历史基线（场景 UI 接入前）：`npx vitest run` 1117 通过（含 useWorkflowsStore 13 项、导航契约与快捷键契约）；`npm run build`（tsc strict + vite）通过。
- 2026-11-06 本轮新增场景 UI / `enter_scene` / 循环与深度保护的验证结果，以本轮实际命令为准；Rust 验证受共享 Cargo 编译占用影响时不得标记通过。
- 真机窗口跳转 / 现场恢复步骤联动 / 深浅主题走查：**NOT VERIFIED**（待真机验收，
  见 `tmp/acceptance/one-click-workflows/report.md`）。
