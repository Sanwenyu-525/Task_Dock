# 开发效率中枢——架构与数据契约

更新：2026-11-12（Round 1）。基线 commit `55288a8`（迁移 v47）。本文是**实现契约**：前端与后端
按此并行开发，以代码与测试为最终事实源；偏离时必须回写本文。

## 1. 统一上下文概念模型

概念（非全部建表）：**Development Project**（登记的开发项目，Round 1 建表）、**Development
Context**（当前项目 + 当前任务 + 派生 git 摘要，由设置键 + probe 派生，不建表）、**Task
Association**（复用 `workbench_current_task` / planning feature_agent_links）、**Evidence
Record**（验收记录的 evidence 数组，Round 1 手工登记）、**Acceptance Record**（Round 1 建表，
追加式）、**Handoff Pack**（Round 1 建表，按任务版本化）。

复用清单（审计证据见 `tmp/acceptance/dev-efficiency-p1/audit-baseline.md`）：
- 当前任务锚点：设置键 `workbench_current_task`（P0 已交付）
- 素材聚合：`task_context`（commands/context.rs:99）只读视图
- 隐私脱敏：`diagnostics/privacy.rs` 的 `sanitize_message/sanitize_metadata`
- 导出参照：`clipboard_export_for_agent`（manifest/warnings 模式）
- 规划状态：`planned/in_progress/review/completed/blocked/paused`（planning.rs:28）
- Agent 六态：`agents/mod.rs:249`；管线有界（pipeline.rs）

## 2. 迁移 v48（唯一迁移，Round 1 一次性合入三张表）

在 `MIGRATIONS` 末尾追加 `(48, r#"..."#)`，SQL：

```sql
CREATE TABLE dev_projects (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_dev_projects_root_path ON dev_projects(root_path);

CREATE TABLE dev_handoff_packs (
  id TEXT PRIMARY KEY NOT NULL,
  task_id TEXT,
  title TEXT NOT NULL,
  version INTEGER NOT NULL,
  content_md TEXT NOT NULL,
  source_summary TEXT NOT NULL DEFAULT '{}',
  secret_scan TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_dev_handoff_packs_task ON dev_handoff_packs(task_id, version);
CREATE INDEX idx_dev_handoff_packs_recent ON dev_handoff_packs(created_at);

CREATE TABLE dev_acceptance_records (
  id TEXT PRIMARY KEY NOT NULL,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('task','planning_feature')),
  subject_id TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('pass','fail','blocked','not_verified')),
  summary TEXT NOT NULL DEFAULT '',
  evidence TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_dev_acceptance_records_subject
  ON dev_acceptance_records(subject_kind, subject_id, created_at);
```

- 风格遵循既有表（TEXT UUID 主键、ISO8601 TEXT 时间、CHECK 枚举、`idx_<表>_<列>`）。
- `dev_acceptance_records` **只插入不更新不删除**（历史不可无痕覆盖）；更正 = 新记录。
- 迁移测试仿 v47 范例（db/mod.rs:4079）：新库直建 + 断言版本；无旧库升级分支（全新表，不重建）。
- `BACKUP_TABLES`（commands/backup.rs:173）登记三张新表：`dev_projects`（class 重要、quick、
  restore 在 scenarios 类之后）、`dev_handoff_packs`、`dev_acceptance_records`。注意 v47 迁移
  `dev_projects` 与既有表无外键依赖；handoff packs 的 task_id 弱关联（任务删除后保留包，前端
  如实展示失效，与 `workbench_current_task` 失效口径一致）。

## 3. 设置键（新增一个，镜像任务锚点）

`workbench_current_project`：`application_settings` K/V，值为 `dev_projects.id`（UUID 字符串），
空 = 未设置；只由用户显式设置。三步：`Settings` 字段（db/mod.rs:2260 附近，serde default 空串）
+ `ALLOWED_KEYS`（settings.rs:123）+ `validate_setting` 分支（非空时：≤64 字符、无控制字符，
镜像 `workbench_current_task` 的校验 settings.rs:317）。项目被删除时**不**自动清键（读侧如实
展示失效，与任务锚点口径一致）。

## 4. IPC 命令契约（新模块 `commands/dev_workbench.rs`，注册进 lib.rs generate_handler）

DTO 全部 `#[serde(rename_all = "camelCase")]`。错误走 `AppError`（NotFound 用结构化码）。

| 命令 | 入参 | 返回 | 说明 |
|---|---|---|---|
| `dev_project_list` | – | `{ projects: DevProject[] }` | 按 name 排序；附 `exists`（root_path 是否仍为存在的目录） |
| `dev_project_save` | `{ id?: string \| null, name, rootPath, note? }` | `{ project: DevProject }` | id 空=新建（UUID）；rootPath 必须绝对路径且目录存在（否则 InvalidInput）；root_path 唯一索引冲突 → Conflict |
| `dev_project_delete` | `{ id }` | `{ ok: true }` | 删除项目（不清理 current 设置键） |
| `dev_project_probe` | `{ rootPath }` | `DevGitInfo` | 只读 git 探测，见 §5 |
| `dev_handoff_save` | `{ taskId?: string \| null, title, contentMd, sourceSummary? }` | `{ pack: DevHandoffPack }` | version = 同 (taskId 非空 ? taskId : title) 下 max+1；sourceSummary 由前端序列化为 JSON 字符串 |
| `dev_handoff_list` | `{ taskId?: string \| null, limit? }` | `{ packs: DevHandoffPack[] }` | created_at 倒序，默认 limit 20，上限 100 |
| `dev_handoff_get` | `{ id }` | `{ pack }` | 不存在 → NOT_FOUND |
| `dev_handoff_delete` | `{ id }` | `{ ok: true }` | 允许删（用户自己的草稿/版本） |
| `dev_handoff_secret_scan` | `{ texts: string[] }` | `{ findings: SecretFinding[] }` | 见 §6；只返回类型与位置，绝不回显密文 |
| `dev_acceptance_record_create` | `{ subjectKind, subjectId, verdict, summary, evidence?: string[] }` | `{ record: DevAcceptanceRecord }` | 只插入；evidence 序列化为 JSON 数组字符串落库 |
| `dev_acceptance_record_list` | `{ subjectKind?, subjectId?, limit? }` | `{ records: DevAcceptanceRecord[] }` | created_at 倒序，默认 50，上限 200 |

DTO：
```ts
DevProject { id, name, rootPath, note, createdAt, updatedAt, exists }
DevGitInfo { status: 'ok'|'not_a_repo'|'git_unavailable'|'path_missing',
             branch: string|null, detached: boolean, isWorktree: boolean,
             mainRepoPath: string|null, headSha: string|null,
             dirtyCount: number|null, probedAt: string }
DevHandoffPack { id, taskId: string|null, title, version, contentMd,
                 sourceSummary: string, secretScan: string, createdAt }
DevAcceptanceRecord { id, subjectKind, subjectId, verdict, summary,
                      evidence: string[], createdAt }
// 更正（2026-11-13，独立验收 P1-1）：evidence 为字符串数组（后端 Vec<String>），
// 初版契约误写为 string 导致前端按整串渲染的隐患，已修复并补真实形状测试
SecretFinding { textIndex: number, line: number, kind: string }
```

前端桥接：全部经 `src/lib/bridge.ts` 追加箭头包装（命名与命令同名，camelCase 参数），类型在
bridge.ts 内定义并导出；不得绕过 bridge 直接 invoke。

## 5. 只读 git 探测（新模块 `src-tauri/src/devwork/git.rs`）

- 不引入 git2 依赖；`std::process::Command` 参数数组调用，无 shell、无字符串拼接；Windows 下
  `CREATE_NO_WINDOW`（0x08000000，参照仓库既有进程调用写法）。
- 顺序：① path 不存在/非目录 → `path_missing`；② `git rev-parse --is-inside-work-tree`
  失败且 stderr 含 "not a git repository" → `not_a_repo`；git 可执行文件缺失（NotFound）→
  `git_unavailable`；③ 并行 unnecessary——串行执行：`rev-parse --abbrev-ref HEAD`（值
  `HEAD` → detached）、`rev-parse HEAD`、`rev-parse --path-format=absolute --git-common-dir`
  与 `--git-dir` 比较判 worktree（不同 → isWorktree，mainRepoPath 取
  `git worktree list --porcelain` 首块 `worktree ` 行）、`status --porcelain` 行数（dirtyCount，
  无上限截断但统计上限 5000 行防异常输出）。
- 单条命令超时 2s（spawn + try_wait 轮询，超时 kill 且该字段置 null/降级，不整体失败）。
- 不做任何写操作；不接受 checkout/stash/push 等。探测结果不落库（按需查询，可缓存于前端
  session 内存，TTL 由前端控制）。

## 6. 敏感内容扫描（新模块 `src-tauri/src/devwork/secrets.rs`）

对每个 text 逐行扫描，命中返回 `{ textIndex, line, kind }`，kind ∈ `private_key | aws_key_id |
github_token | sk_token | jwt | generic_assignment`。规则：
- `-----BEGIN ... PRIVATE KEY-----`（含 RSA/EC/OPENSSH/PGP/DSA 变体）→ private_key
- `AKIA[0-9A-Z]{16}` → aws_key_id
- `\bgh[pousr]_[A-Za-z0-9]{20,}\b` → github_token
- `\bsk-(ant-)?[A-Za-z0-9_-]{20,}\b` → sk_token
- 三段 base64 JWT（`eyJ`…`.`…`.`）→ jwt
- `(?i)(api[_-]?key|secret|token|password|passwd|pwd|credential)\s*[:=]\s*\S{8,}` →
  generic_assignment（排除值本身是占位符如 `${...}`、`***`）
输出绝不包含命中原文（无 snippet 字段）；单文件行数上限 20000 行，超出截断并在 result 附
`truncated: true`（塞进 findings 数组外层由命令层返回 `{ findings, truncated }`）。
测试：每类至少 1 正例 + 1 反例（普通代码不误报：`token_count`、`Authorization: Bearer <user>`
文档示例等按反例口径定夺）。

## 7. 前端落点（Round 1，全部挂既有页面，不新增导航入口）

- **DevWorkbenchPanel**（`src/components/workbench/DevWorkbenchPanel.tsx`）新增三块（新组件文件，
  面板内挂载）：
  - `DevProjectContext.tsx`（区域 A2「开发现场」）：当前项目选择（下拉 dev_projects + 新建/
    编辑/删除/设为当前，写 `workbench_current_project` 设置）、git 摘要行（分支 · dirty 数 ·
    worktree 标记，来自 probe，打开面板时探测一次 + 手动刷新按钮，30s 内不重复探测）、项目
    目录不存在/未识别时如实显示降级态；「打开项目目录」按钮走既有 opener 能力。
  - `DevHandoffSection.tsx`（「任务交接包」）：从当前任务（无任务则允许无任务草稿）生成交接包：
    12 节模板表单（项目背景/任务目标/实现情况/修改范围/关联代码路径/技术限制/依赖任务/验收
    标准/关联截图与问题/测试要求/禁止事项/结果汇报格式）+ 资料选择（task_context 聚合只读
    字段 + 用户勾选 notes/shelf 条目名）→ 预览 Markdown → secret scan（发现项列出类型+行号，
    不回显内容，用户自行修正）→ 一键复制（navigator.clipboard）+ 保存版本；版本列表（同任务
    最近 5 版，可查看/复制/删除）。
  - `DevAcceptanceSection.tsx`（「验收工作台」）：对当前任务或其关联 planning feature 显示派生
    状态（§8 映射）+ acceptance_criteria 清单 + 手工证据登记（命令/结果文本，作为 evidence
    数组项）+ 四按钮（通过/不通过/阻塞/未验证，附 summary 必填）追加记录；历史记录倒序展示；
    「生成返工提示词」= 由失败记录 summary + 任务标题生成文本并复制；「创建返工任务」调用既有
    tasks_create（标题带返工前缀）。
  - 交接到 Agent 不自动提交任何外部系统：第一版只有复制/导出到本地剪贴板。
- **TaskContextDrawer**：头部加「生成交接包」按钮（跳到 DevWorkbenchPanel 交接区并聚焦，经
  既有导航机制，不新增导航目标）。
- **TasksLite（胶囊）**：当前项目已设置时在头部显示 `项目名 · 分支` 紧凑 chip（probe 失败显示
  项目名），不新增 pane、不新增请求节流外的轮询。
- featureCatalog `core.dev-workbench` 条目：把 missingFeatures 中「项目上下文关联」移到
  delivered/描述更新（只改这一条，verdict 保持如实：UI 交付 = partial，真机未验）。
- i18n：zh-CN/en-US 同步新增 key（i18n.test.ts 键集一致性）。
- 样式：只复用语义 Token 与 `src/components/ui/` 原语；确需新增类，追加到 styles.css 末尾
  「dev workbench」注释块，不写裸 z-index、不写原生 select。

## 8. 验收状态派生（纯函数，前端 `src/lib/acceptanceStatus.ts` + vitest）

输入：planning feature 状态（有关联时）| 任务 status（pending|completed）| 最近验收记录 verdict
（可空）。输出：`待开发|开发中|待验收|验收中|验收不通过|已验收|已阻塞`。

规则（优先级从上到下）：
1. 有验收记录：pass→已验收；fail→验收不通过；blocked→已阻塞；not_verified→待验收（并标注
   证据不足）。
2. planning 关联：planned→待开发；in_progress→开发中；blocked→已阻塞；review→待验收；
   completed→已验收；paused→已阻塞。
3. 仅任务：pending→待开发；completed→待验收。
4. 无任务无关联→「未关联」（不显示状态按钮）。
Agent 会话 running/waiting 不改变派生状态（只作为面板展示信息）；自动化测试结果通过与否
**不**自动写入验收记录（Round 1 人工登记；自动归集属功能⑥后续轮）。

## 9. 测试矩阵（Round 1）

- Rust：迁移 v48（建表/索引/约束/版本断言 + 失败回滚不影响既有）；dev_workbench 命令
  CRUD/权限参数校验/NotFound/Conflict；git.rs 探测（进程 mock：对临时 git init 的真实临时
  仓库探测 + 非 git 目录 + 不存在路径 + git 缺失模拟 via PATH 注入假可执行文件或 cfg 跳过并
  标 NOT VERIFIED）；secrets.rs 正反例。
- 前端：acceptanceStatus 派生纯函数全分支；DevProjectContext/DevHandoffSection/
  DevAcceptanceSection 组件测试（加载/空态/错误态/重复点击防抖/设置写入与失效关联如实展示）；
  bridge 新命令类型；i18n 键集；TaskContextDrawer 入口；TasksLite chip。
- 集成回归：`npm run build`（tsc 全量）、定向 vitest、`cargo test --lib` 定向 + 全量。
- 真机（本机 Windows）：真实 git 仓库探测、胶囊 chip、面板三区块交互——按通道 C/E 记录；
  无法执行项如实标 NOT VERIFIED。

## 10. 边界与不做清单（Round 1）

不做：自动识别前台 IDE 项目（功能①第三层）、浏览器标签恢复、自动执行测试命令、Git 写操作、
交接包自动提交给外部 Agent、问题复现包（功能⑤，Phase 3）、情境化操作规则引擎（功能⑦，
Phase 3）、环境监控（功能⑥，Phase 2）、Worktree 关联表（功能④实体层，Phase 2）。
