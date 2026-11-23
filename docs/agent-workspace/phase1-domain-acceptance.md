# 专业领域 Phase 1（Novel + Comic）架构修复验收报告

日期：2026-11-23
范围：Novel / Comic 的事务、幂等、操作生命周期、Manifest 授权、业务校验、revision、数据最小化、分页与 MCP Schema。
结论：**架构修复与定向验收通过**；正式安装包/桌面视觉验收未执行，不标记 Release 已验收。
Game / General / Development 保持 `planned`，未注册空实现。

## 1. 原始问题与根因

### 1.1 MCP 写操作自锁

调用链实际为：

```text
mcp::tools::run_tool_call
  → db.with_transaction          // 已持有 Db.writer: Mutex<Connection>
    → agent_access::domain_mcp::call(..., Some(write_conn))
      → 忽略 write_conn，调用 novel::update_chapter_content / comic::update_media
        → domains::idempotency::execute
          → store::cache_claim
            → db.with_conn      // 再次请求同一 writer 锁
```

`Db::writer` 是 `Mutex<Connection>`；外层事务未提交前内层 `with_conn` 永久等待，形成自锁。
单元测试中表现为超时/Hang，而不是业务错误。

根因不是某一个函数，而是**事务所有权不唯一**：入口层与领域包装层都认为自己拥有事务。

### 1.2 四入口重复 Operation / 幂等身份

CLI、REST、MCP 已在外层创建 `AgentOperation`，领域 `idempotency::execute` 又创建操作和守卫；
REST 幂等占位没有和业务提交绑定；MCP 外层审计身份与领域请求身份不一致。
结果是同一写入可能出现两条操作、两次 revision、或响应缓存与业务提交不一致。

### 1.3 权限与类型泄露

Novel/Comic 读核心先 `ensure_domain` 再查 `ProjectsRead`，未授权 Agent 可以通过
「项目类型不匹配」推断项目类型；Manifest 也存在无授权构建入口。
`DomainKind::as_str()` 被同时用于领域名和 `workspace_projects.kind`，导致
`ai_comic`（数据库类型）与 `comic`（领域名）混用。

### 1.4 Comic 校验分散

IPC、MCP、REST、文件导入各自校验 `version_label` / `review_note` / `status`；
文件导入把 `review_note` 放宽到 256KiB，`adopted` 可以通过 update 接口绕过独立 adopt。
revision 读取也没有统一：`updatedAt` 曾使用 revision 计数器的 `counter_at`。

## 2. 实际架构调用链（修复后）

### 2.1 MCP（事务归 `run_tool_call`）

```text
tools/call
  → mcp::tools::run_tool_call
    → request_id_of(args)                     // camelCase requestId
    → 授权/身份刷新
    → db.with_transaction(conn)               // 唯一事务边界
      → agent_access::domain_mcp::call(conn, principal, op_id, args, Some(conn))
        → novel::update_chapter_content_in_conn(conn, ..., &NoGuard)
          → policy::resolve_authorized_project(conn, read/write)  // 授权 → 类型 → 归属
          → commands::project_workspace::novel_chapter_save_content_in_conn(conn, ...)
          → revision::bump_revision_from(conn, ...)
        → 返回 (summary, revision)
      → 外层 audit / operation complete / PlanningChanged 广播
```

`domain_mcp::call` 对写操作**只使用传入的 `Connection`**，不再调用任何会
`db.with_conn` / `db.with_read` / `db.with_transaction` 的领域公开包装。
缺少 `write_conn` 返回 `AppError::Unavailable`，不 panic。

MCP 幂等由 `run_tool_call` 的审计重放负责：同一 `requestId` 重放不创建第二份 Operation，
`authorize_replay` 对三个领域写工具重新校验项目 grant 与 `projects.write`。

### 2.2 REST（事务归领域包装，guard 来自外层）

```text
agent_access::rest::dispatch
  → 外层 RequestCacheGuard + OperationGuard（CompositeGuard）
  → domain_rest::handle(db, principal, method, rest, query, body, guard)
    → PUT 章节正文
      → novel::update_chapter_content_with_guard(db, ..., guard)
        → db.with_transaction(conn)
          → guard.check(conn)                 // 缓存占位 + 外层操作
          → update_chapter_content_in_conn(conn, ..., guard)
          → guard.complete(conn)              // 缓存 committed + 操作终态
```

`domain_rest::handle` 不重新生成 request_id；HTTP `Idempotency-Key` 由 REST 外层生成
`AgentRequestCache` 占位并与业务事务绑定。`X-Request-Id` 只作追踪，不能替代幂等键。
PUT 与 POST 支持 `Idempotency-Key`；PATCH/GET 不支持。

### 2.3 CLI（事务归 `idempotency::execute` 的独立执行模板）

```text
agent_access::cli::execute_with_request
  → operations::try_start(Operation)         // 外层唯一 Operation
  → OperationGuard
  → domain_cli::execute(request_id, guard, limit, offset)
    → novel::update_chapter_content_with_request(...)
      → domains::idempotency::execute(...)
        → cache_claim（独立入口）
        → db.with_transaction(conn)
          → StackedGuard.check（cache + 外层 OperationGuard）
          → 领域 *_in_conn 核心
          → guard.complete（cache committed + 操作终态）
```

CLI 的 `request_id` 来自 `--request-id` 或入口生成一次；领域内部不再随机生成。
`classify_cli_write` 的资源 ID 只从 `--chapter-id` / `--media-id` 读取，
`write_project_hint` 同时识别 `--project` 与 `--project-id`。

### 2.4 文件导入

```text
domain_import::validate_envelope
  → 共用 commands::comic_workspace::validate_media_meta
  → ImportLeaseGuard + 领域 *_in_conn
  → 业务事务、revision、失败回滚
```

文件导入与 MCP/REST/CLI 使用同一业务核心，不再维护第二套长度/状态/trim 规则。

## 3. 事务和幂等修复方案

1. **唯一事务所有权**：
   - MCP：`run_tool_call` 的 `db.with_transaction`；
   - REST：`*_with_guard` 内的事务；
   - CLI：`idempotency::execute` 的独立执行事务；
   - 文件：`domain_import` 的导入租约事务。
2. **唯一 Operation**：
   - MCP：`run_tool_call` 的 `operations::try_start`；
   - REST：`begin_rest_operation`；
   - CLI：`cli::execute_with_request` 的 `try_start`；
   - 领域 `idempotency::execute` 只叠加守卫，不创建 Operation。
3. **唯一幂等身份**：
   - MCP：`requestId`（camelCase，`request_id_of` 读取）；
   - REST：`Idempotency-Key` + 请求指纹；
   - CLI：入口 `request_id`；
   - 领域核心不生成第二个随机 ID。
4. **事务内禁止嵌套 Db**：领域 `*_in_conn` 只接收 `&Connection`；MCP 写操作缺失连接
   返回 `Unavailable`。`NoGuard` 只用于 MCP 外层已持有 Operation/审计的场景。
5. **Committed 恢复**：`CacheClaim::Committed` 使用缓存中的
   `(operation_kind, operation_id)` 调用 `recover`；Novel/Comic 恢复读取已提交业务行，
   不重新执行、不推进 revision。指针缺失时返回 `IDEMPOTENCY_RECOVERY_REQUIRED`，
   而不是泛化成功/失败。

## 4. 权限修复

- 唯一 Manifest 入口：`manifest::build_for_principal(db, principal, project_ref)`；
  MCP/REST/CLI 全部使用。
- 判定顺序固定：

```text
解析项目根
→ 身份/scope/能力（ProjectsRead 或 ProjectsWrite）
→ 项目 grant
→ 项目 kind（DomainKind::parse，未知拒绝，不回退 general）
→ 项目 status（写 active；读允许 archived）
→ 资源归属（真实 project_id == 授权根）
→ 业务读写
```

- 未授权时错误与项目类型无关；跨项目资源统一为 `资源不可访问`，不泄露存在性。
- Manifest 响应：`project.kind` 是数据库真实类型（`ai_comic`），`domain` 是领域名（`comic`）。
- 真实 RegisteredAgent 覆盖：无 grant、他项目 grant、readonly、disabled、revoked、
  类型不匹配、跨项目资源。`two_agents_concurrent...` 覆盖并发授权下的 revision 竞争。

## 5. 业务校验修复

`commands::comic_workspace::validate_media_meta` 是唯一规则：

- `version_label` ≤ 240 字符；
- `review_note` ≤ 4000 字符；
- `status` 仅 `candidate` / `rejected`；
- `adopted` 只能通过独立 `comic.media.adopt`，update 明确拒绝；
- 首尾空白 trim，拒绝控制字符。

IPC、MCP、REST、CLI、文件导入全部调用同一函数；`comic_media_save_in_conn` 开头再次调用，
保证绕过 IPC 包装的入口也不能放宽。文件导入的 review_note 不再使用 256KiB 上限。

## 6. revision 与数据 DTO 修复

- `read_revision_snapshot` 的 `updated_at` 恒取业务行 `updated_at`，不再使用
  revision 计数器的 `counter_at`。
- Agent 写入使用 `bump_revision_from`：校验 effective revision → 业务写入 → revision 推进，
  全部在同一事务。
- UI 命令层通过 `revision::note_ui_write` 在同一业务事务推进版本：
  `novel_chapter_save_impl`、`novel_chapter_save_content_impl`、`comic_media_save_impl`、
  `comic_media_adopt_impl`。即使 Agent 从未建立基线，首次 UI 修改后读取也是 revision=1。
- Novel：列表/详情/正文均带 revision；`novel.chapter.get` 只返回元信息，正文由
  `novel.chapter.content.read` 独立返回。
- Comic：新增 `comic.media.get`；列表/详情/update/adopt 均带 revision；adopt 同时推进
  新采用版本与被替换旧版本的 revision。
- Agent DTO 与 Tauri IPC DTO 分离；未修改原有 IPC 契约。

## 7. 分页、路径安全与性能

- 列表默认 `limit=50`，最大 200，返回 `total` / `has_more` / `next_offset`。
- Novel 章节列表补 `COUNT(*)` + `LIMIT/OFFSET`（上限 5000）；Comic episode/shot/media
  三个分页查询；MCP/REST/CLI 全部透传 limit/offset。
- 素材路径不输出本机绝对目录：`AgentFileRef` 只给项目根内相对路径、存在状态、文件类型；
  无法安全转换时字段为空，不给绝对路径，也不开放任意文件读取。
- 剧集列表不返回完整 `script`；章节详情不返回完整正文。

## 8. 文件变更清单（本轮）

代码：

- `src-tauri/src/agent_access/mod.rs`（`Page.next_offset`、`tests_domain` 注册）
- `src-tauri/src/agent_access/service.rs`
- `src-tauri/src/agent_access/cli.rs`
- `src-tauri/src/agent_access/operations.rs`
- `src-tauri/src/agent_access/rest.rs`
- `src-tauri/src/agent_access/domain_cli.rs`
- `src-tauri/src/agent_access/domain_import.rs`
- `src-tauri/src/agent_access/domain_mcp.rs`
- `src-tauri/src/agent_access/domain_rest.rs`
- `src-tauri/src/agent_access/domains/manifest.rs`
- `src-tauri/src/agent_access/domains/policy.rs`
- `src-tauri/src/agent_access/domains/idempotency.rs`
- `src-tauri/src/agent_access/domains/novel.rs`
- `src-tauri/src/agent_access/domains/comic.rs`
- `src-tauri/src/agent_access/domains/revision.rs`
- `src-tauri/src/agent_access/tests_domain.rs`（新增）
- `src-tauri/src/agent_access/tests_v82_rest.rs`（追加）
- `src-tauri/src/mcp/tools.rs`
- `src-tauri/src/commands/project_workspace.rs`
- `src-tauri/src/commands/comic_workspace.rs`

文档：

- `docs/agent-workspace/architecture.md`
- `docs/agent-workspace/feature-matrix.md`
- `docs/agent-workspace/permission-model.md`
- `docs/agent-workspace/synchronization.md`
- `docs/agent-workspace/rest-api-specification.md`
- `docs/agent-workspace/test-plan.md`
- `docs/agent-workspace/development-progress.md`
- `docs/agent-workspace/phase1-domain-acceptance.md`（本报告）

## 9. 数据库变化与兼容性

本轮**没有新增迁移**，没有修改已发布 schema。复用的既有表和契约：

- `agent_resource_revisions`（revision 基线与推进）；
- `agent_operations`（Operation 生命周期）；
- `agent_request_cache`（REST/CLI 幂等）；
- 业务表 `novel_chapters`、`comic_media_versions` 等。

兼容性：

- 原有 Tauri IPC 命令签名和数据形状未变；
- Agent 专用 DTO 是新增/内部形状，不替换 IPC DTO；
- 旧数据库没有 revision 行时，首次 Agent 读为 0；UI 首次写入会建立 revision=1；
- 旧 `comic_media_versions` 的 `file_path` 不迁移，Agent 读取时按项目根安全转换。

## 10. 实际测试命令、退出码和结果

测试二进制由 `npm run cargo -- test --lib --no-run` 生成（exit 0，54 warnings）。
因另一并行任务在途修改 `build.rs` 的 test manifest，直接把 deps 下 exe 运行会报
`0xc0000139`；本轮把同一二进制复制到 `C:\Windows\Temp\td2\td2.exe` 并伴随同名 manifest 运行。
这是 Windows 测试加载器问题，不是产品代码失败；未修改 `build.rs`。

| 范围 | 过滤名 | 结果 | 退出码 |
|---|---|---|---|
| 领域 / 四入口 / 权限 / revision / 分页 / 路径 | `agent_access::tests_domain` | 18 passed / 0 failed（7.37s） | 0 |
| domains 模块 | `agent_access::domains` | 33 passed / 0 failed（10.01s） | 0 |
| 文件导入 | `agent_access::domain_import::tests` | 10 passed / 0 failed（2.54s） | 0 |
| MCP Schema | `agent_access::domain_mcp::tests` | 4 passed / 0 failed | 0 |
| 领域幂等 | `agent_access::domains::idempotency::tests` | 2 passed / 0 failed | 0 |
| CLI 写操作 | `agent_access::cli::create_gate_tests` | 6 passed / 0 failed | 0 |
| CLI 资源分类 | `agent_access::cli::operation_tests` | 3 passed / 0 failed | 0 |
| REST 真实 HTTP | `agent_access::tests_v82_rest::rest_put_*`、`rest_comic_*` | 3 passed / 0 failed | 0 |
| 受影响命令层 | `commands::project_workspace::` + `commands::comic_workspace::` | 13 + 17 passed / 0 failed | 0 |
| MCP 模块 | `mcp::` | 91 passed / 0 failed（29.00s） | 0 |
| Agent Access 全量 | `agent_access::` | 304 passed / 0 failed（135.53s） | 0 |
| Rust lib 全量 | 全部 lib 用例 | 见 §10.1 | - |
| 前端类型 | `npm run typecheck` | 0 errors | 0 |
| 架构检查 | `npm run arch:guard` | exit 0；存在既有 DUP-001 平行源码树告警，非本轮新增 | 0 |

### 10.1 Rust lib 全量

完整 lib 套件共 3128 条。`--test-threads=4` 与默认线程均启动过全量运行，但在本轮时间窗口内
分别只完成 183 / 74 条；`--skip agent_access::` 的剩余用例也未跑完，已主动停止。
因此**不宣称 `cargo test --lib` 全量通过**。受影响面已分别全量执行：

- `agent_access::` 304/0，135.53s；
- `mcp::` 91/0，29.00s；
- `commands::project_workspace::` 13/0；
- `commands::comic_workspace::` 17/0。

日志：`tmp/phase1-lib-full.log`、`tmp/phase1-lib-full-default.log`、`tmp/phase1-lib-rest.log`。

`cargo check --lib --tests` 本轮 exit 101：阻塞点是其他 Agent 在途的
`tests/virtual_display_live.rs`（`vd::vd_start` 参数漂移，10 个 E0061/E0308），
不是本任务代码。按规范标记 `ENVIRONMENT BLOCKED`，不修改该文件。

### 10.2 首轮失败与修复（未隐瞒）

- `agent_access::tests_domain` 首轮 8/7：MCP 重放授权未识别领域工具；测试把 Operation
  `action` 当成领域 op id（实际是 MCP 工具名）；UI 修改前无 revision 基线；Manifest
  错误类型/文案断言过窄。修复代码 + 测试口径后 18/0。
- `agent_access::domains` 首轮 26/7：测试 fixture 使用数据库 CHECK 不允许的
  `comic_episodes.status='todo'`、`comic_media_versions.source='import'`；改为
  `draft` / `imported` 后 33/0。
- `agent_access::` 全量首轮 301/2：`comic.media.update` Manifest 缺 `File` 接口；
  `media_update_cannot_set_adopted` 期望错误包含 `comic.media.adopt`。
  修复注册接口与专门错误提示后 304/0。
- 并发用例首轮断言读错 MCP 结果外层形状（错误 JSON 在 `content[0].text`）；
  改为解析嵌套文本后通过，产品逻辑一成一冲突。

## 11. 剩余风险

1. **Release 未验收**：没有构建安装包，未执行升级/卸载、代码签名、生产资源加载。
2. **桌面 UI 未视觉走查**：UI 写 revision 通过命令层真实函数验证，但没有驱动 Tauri IPC
   事件循环和真实窗口。
3. **多进程并发未压测**：并发测试是单进程多线程 + SQLite 唯一写连接；
   跨进程 CLI/REST/MCP 同时写同一 revision 未做真实压测。
4. **集成测试编译阻塞**：`tests/virtual_display_live.rs` 属其他 Agent 在途改动，
   全量 `cargo test` 不能编译；本轮不修改、不代提交。
5. **文件导入范围**：只支持三种更新型领域操作；不支持删除/创建/批量写入。
6. **Game / General / Development**：保持 planned，没有空实现注册为 available。
7. **无 revision 行的历史资源**：首次读 revision=0 是稳定基线；首次 UI 写入才建立 1。
   依赖「UI 改后立即可见」的调用方应读取 `updatedAt` 与 revision，不得只缓存旧值。

## 12. 最终验收结论

- P0 MCP 死锁：**修复并通过真实 MCP 写测试**（非仅代码存在）。
- 四入口事务/Operation/幂等：**修复并通过定向测试**；一次外部写只有一条 Operation，
  REST 同 Key 重放/冲突/响应丢失恢复通过。
- 权限/Manifest：**修复并通过真实 RegisteredAgent 矩阵**。
- Comic 校验：**下沉并通过 candidate/rejected/adopted/长度/控制字符测试**。
- revision/DTO：**修复并通过 UI/Agent 双向、并发、adopt 新旧版本测试**。
- 分页/Schema/路径安全：**通过定向测试**。
- Novel + Comic Phase 1：**架构验收通过**（Debug 测试二进制 + 定向四入口）。
- Release：**未验收**；Game/General/Development 未接入，不能宣称五领域完成。

## 13. 交付提交与共享文件竞态

- 主交付提交：`d8039f3 fix(agent-access): 修复 Novel/Comic 领域四入口事务与权限契约`
  （28 files，+4429/-788），仅包含本任务 Agent Access 代码与文档。
- `src-tauri/src/commands/comic_workspace.rs` 的本轮改动（校验下沉、UI revision、错误提示）
  在并行开发中被另一 Agent 的提交 `89b3642 fix(comic): C3-R1 ...` 一并带入。
  发现时该文件已 clean；按共享工作区纪律**没有 reset/revert/重复提交**，本轮测试运行的是
  该文件当前内容。这是共享工作区的提交竞态，不是本任务主动代交他人文件；文件最终内容与
  本报告描述一致。
- 未提交 `tmp/`、`target/`、测试证据日志、`db/mod.rs`、`clipboard/*`、`build.rs`、
  `tests/virtual_display_live.rs` 或其他 Agent 的移动端/文件工作区改动。

## 14. 复验记录（2026-11-24）

复验前 HEAD 为 `2e9b098`，本任务 `agent_access`、`mcp/tools.rs`、`commands/project_workspace.rs`
与 `docs/agent-workspace` 路径均无未提交改动。测试二进制
`task_dock_lib-3ba143d4234e1361.exe` 生成于 2026-11-24 00:51:58，晚于本轮全部相关源码修改
（`tests_domain.rs` 00:49:44、`comic.rs` 00:44:31、`comic_workspace.rs` 00:49:40），
复验运行的是交付提交对应的代码内容。

| 范围 | 过滤名 | 结果 | 退出码 |
|---|---|---|---|
| Agent Access 全量 | `agent_access::` | 304 passed / 0 failed，154.47s | 0 |
| MCP 模块 | `mcp::` | 91 passed / 0 failed，39.10s | 0 |
| 项目命令层 | `commands::project_workspace::` | 13 passed / 0 failed，6.71s | 0 |
| Comic 命令层 | `commands::comic_workspace::` | 17 passed / 0 failed，11.68s | 0 |
| Rust lib 编译 | `cargo check --lib` | 通过，53 warnings | 0 |
| 前端类型 | `npm run typecheck` | 0 errors | 0 |
| 架构检查 | `npm run arch:guard` | 报告模式，exit 0；仅既有告警 | 0 |
| lib + 集成测试编译 | `cargo check --lib --tests` | **未通过** | 101 |

`cargo check --lib --tests` 仍阻塞于其他 Agent 在途的 `tests/virtual_display_live.rs`
（`vd::vd_start` 参数漂移，10 个 E0061/E0308）；本轮未修改该文件，结论保持
`ENVIRONMENT BLOCKED`。Rust lib 全量 3128 条本轮未重跑，不能宣称全仓回归通过。

复验日志：`tmp/accept-phase1-agent-access.log`、`tmp/accept-phase1-mcp.log`、
`tmp/accept-phase1-check-lib.log`、`tmp/accept-phase1-check-lib-tests.log`。

复验结论：Novel + Comic Phase 1 的 Agent Access、MCP 与受影响命令层复跑全部通过；
Release 与桌面 UI 验收仍未执行，边界与 §11、§12 一致。
