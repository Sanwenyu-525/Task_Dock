# 统一集成、统一构建与多 Agent 联合验收

本文件是 [AGENTS.md](../AGENTS.md) 第 3、5 节的展开说明，也是 `scripts/taskdock-integration.mjs`
的操作手册。它解决一个问题：**多 Agent 并行开发时，如何从「已完成任务」的代码生成一个可追溯、
可被多个 Agent 同时验收的测试版本，而不把仍在开发的改动混进去，也不为每个 Agent 重复打包。**

相关边界不变：构建排队用 [BUILD_SCHEDULER.md](BUILD_SCHEDULER.md) 的调度器；磁盘与缓存清理用
`scripts/build-guard.mjs`（[DEVELOPMENT.md](DEVELOPMENT.md) 第七章）；单任务隔离用
`scripts/worktree-guard.mjs`（DEVELOPMENT.md 第八章）；验收通道与证据格式用
[ACCEPTANCE_ROUTING.md](ACCEPTANCE_ROUTING.md) 与 `.agents/skills/taskdock-acceptance`。
本文件不重复这些内容。

## 1. 为什么需要一条独立的集成分支

本仓库的现实约束：

- 多个会话/Agent 共享同一个工作树，未提交改动默认属于其他任务；
- 存在**外部定时提交**（git log 里的 `chore: 定时提交 <时间>（N 个文件）`，不由仓库脚本产生），
  它会把这些改动整体提交进 `main`，因此 `main` 的提交不能当作「已完成任务的集合」；
- 因此不能用「当前工作区」或「main 的 HEAD」直接打包，否则未完成的功能会进入验收包。

所以引入一条**工具自有、只做加法**的集成分支线：

```
baseline 提交（人工选定，snap-01）
   └── snap-02 = base + 任务 A、B、C 的声明路径改动（快照提交）
          └── snap-03 = snap-02 + 任务 D、E 的新交付（增量叠加）
```

- 快照提交只包含**登记过的交付提交**里**声明路径**的改动，其它任务未提交/未登记的内容进不来；
- 每次快照对应唯一 commit，构建记录写死 commit + 任务清单 + 产物 sha256；
- `main` 与各任务分支不被本工具改动；快照分支不推送、不打标签。

## 2. 状态机与职责

| 状态 | 含义 | 谁推进 | 判据 |
|---|---|---|---|
| `developing` 开发中 | 正在改代码 | 任务负责人（`task add` / `task update`） | — |
| `integration-ready` 待集成 | 代码完成且模块级检查通过 | 负责人 `task ready` | 已登记交付提交 + 至少 1 条在**该交付提交上真实执行**（`source=executed`）通过的检查记录；带证据的外部检查可作补充 |
| `integrated` 已集成 | 改动进入快照提交 | 工具（`snapshot create` 成功） | 快照提交生成、改动全部落在声明范围 |
| `verifying` 待验收 | 代码已包含在可用产物中 | 工具（`build` 成功） | 构建成功、有平台可用产物、产物校验值已记录、`dirty=false` |
| `accept-passed` 验收通过 | 在指定构建版本上验收通过 | 验收 Agent（`accept --status pass`） | 有构建版本 + 验收记录（建议附证据路径） |
| `accept-failed` 验收失败 | 存在问题需返工 | 验收 Agent（`accept --status fail --note`） | 必须写失败现象 |

**「Agent 声称完成」不等于「已集成」**：只有 `snapshot create` 成功才会把任务置为已集成；只有构建
成功才会进入待验收。`accept --status blocked|not-run` 不改任务状态（未给出结论就不算通过）。

## 3. 任务交付：登记的字段

`task add` 建立记录（`tmp/integration/tasks/<id>.json`），关键字段：

| 字段 | 说明 |
|---|---|
| `id` | 小写短横线英文任务标识，全局唯一（建议与 `tmp/acceptance/<task>/` 同名） |
| `module` / `owner` | 模块与负责人（人读，用于交接与派发核对） |
| `paths` | **写入范围白名单**（文件或目录；目录按前缀覆盖，`src/foo` 覆盖 `src/foo/...`）；集成只应用这些路径 |
| `commit` + `from` | 交付提交与起点（默认 `commit^`）；多提交任务用 `--from` 指定起点，起点必须是交付提交的祖先 |
| `checks` | 检查证据：真实执行（`source=executed`，含提交/日志/工作区/耗时/调度任务）或外部登记（`source=external`，可选证据路径）；只有真实执行或带证据的外部检查可满足 `task ready` |
| `rev` | 台账修订号：每次写入 +1；写入前在任务锁内重新读取，用于发现并拒绝覆盖并发的更新 |
| `publicInterface` | 是否改动公共接口（IPC/类型/迁移/设置键），供人工复核顺序与兼容性 |
| `needs` | 依赖的其他任务；集成时用于拓扑排序与依赖校验，不在本批的依赖必须已集成 |

交付时的最小动作：

```bash
npm run integrate -- task add --id files-rescan --owner agent-a --module 资源管理器 \
    --paths src/components/files/FilesWorkspacePanel.tsx,src/lib/filesWorkspace/interactions.ts
# 真实执行：在 <仓库>-integration-verify 的干净 detached 工作区 checkout 到交付提交，
# 按该提交核对依赖，经构建调度器执行命令，日志与退出码写入台账（失败仍写记录并返回 2）
npm run integrate -- task verify --id files-rescan --commit <交付提交> --cmd "npm test -- src/components/files" \
    [--priority P1] [--class light|medium|heavy]  # 仅当命令确实轻量时显式降级，默认由调度器自动判定
npm run integrate -- task ready --id files-rescan --commit <交付提交>
```

规则：

- **一个交付提交只放本任务的改动**。提交里出现未声明路径时工具拒绝集成（防止把别的任务带进来）；
  确属本任务时用 `--allow-extra-paths` 显式放行。放行会把这些路径**真正应用**到快照，并记入
  `includedExtraPaths`；不传该开关时不会“只记录不应用”。声明路径一个都没改动的任务一律拒绝，
  防止空补丁任务被标成已集成。
- 检查记录应显式用 `--commit` 绑定它实际运行的提交；省略时工具绑定执行时的 `HEAD`。`task ready`
  只接受与交付提交相同的通过检查。这避免“在旧版本上跑过的测试”被当成新版本证据。
- **检查必须真实执行**：`task verify` 在隔离工作区 checkout 指定提交、核对依赖、经调度器运行命令，
  写 `source=executed`、`commit`、`logPath`、`exitCode`、`durationMs` 与 `schedulerTaskId`。`task check`
  是人工登记，只记 `source=external`；没有证据的手动登记可用于留痕，但不能让任务进入待集成。
  集成时工具还会执行一次真实的静态检查（`--check static`，默认），这次结果才是「快照可构建」的证据。
- **检查绑定提交**：`task verify --commit` 必须是任务当前交付提交；返工时（任务为 `accept-failed`/
  `developing`）允许先验证修复提交，但只有随后 `task ready --commit <修复提交>` 才会更新交付关联。
  验证期间任务若被改成别的交付提交，结果不会写入台账，需重新验证。不能把旧版本上的通过记录用于新版本。
- 写入范围一旦变更，工具会清空交付提交、检查、快照与验收关联并回到 `developing`，必须重新
  `task check` / `task ready`，不能事后扩大范围再沿用旧结论。
- 返工：`accept-failed` 后修完用 `task ready --commit <修复提交> --from <上一交付提交>`，
  让补丁只覆盖修复内容，再进入下一个快照。
  **例外**：如果上一次 `snapshot create` 本身失败（没有生成快照），这个任务从未进入任何快照，
  此时 `--from` 应指向**当前快照提交**（不是那次未成功的交付提交），否则增量补丁缺少上下文，
  应用时会出现假冲突。

## 4. 统一集成（snapshot）

```bash
npm run integrate -- snapshot bootstrap --base <稳定提交>     # 只登记基线，不叠加任务
npm run integrate -- snapshot bootstrap --base <提交> --force  # 基线不可构建且尚无任务集成时重新登记
npm run integrate -- snapshot create --tasks a,b,c --base <稳定提交> [--check static|none] [--dry-run]
npm run integrate -- snapshot create --all-ready --base <稳定提交>  # 首次集成必须给基线
```

> 基线提交必须自己先能通过检查。历史提交是定时提交（可能夹带别人的半成品），所以
> `bootstrap` 之后应立刻 `build` 一次做基线体检；若构建失败且还没有任务被集成，用
> `snapshot bootstrap --base <另一个提交> --force` 重新登记新基线（旧记录保留，不被覆盖）。
> 已有任务集成后不允许重置基线——那会丢失任务关联。

`snapshot create` 的执行顺序（任一步不满足即拒绝，退出码 2）：

1. **任务资格**：状态为待集成（或返工后带新交付），有交付提交与写入范围；
2. **基线**：`--base` 显式指定，或默认「上一个快照的提交」。**首次集成必须显式给 `--base`**，
   不允许拿共享工作区 `HEAD` 当基线。有上一个快照时，基线必须就是它的提交；`integration`
   分支头也必须与基线一致，拒绝回退或分叉——分支只能随快照向前推进；
3. **路径核对**：交付提交的改动必须全部落在声明范围；新增/删除/改名的两侧都要在范围内；
   声明路径一个都没改动时拒绝；`--allow-extra-paths` 会把未声明路径一并纳入补丁并记录；
4. **依赖与交集**：`needs` 依赖任务必须先于本任务应用；不在本批的依赖必须已经进入过快照。
   同批选中任务之间写入范围有交集即拒绝（交集文件只能有一个所有者）；**显式放行的额外路径与声明
   路径一起参与交集判定**，并进入快照记录与构建任务溯源。确需同批用 `--allow-overlap` 并在记录中留痕；
5. **工作区**：`<仓库父目录>/<仓库名>-integration`，分支 `integration`；必须存在且身份记录
   （`tmp/integration/worktrees/snapshot.json`）可证明它由本工具创建/登记。旧工作区没有记录时先用
   `worktree adopt --role snapshot` 做非破坏登记；缺记录/记录被改/指向其他仓库/被普通 Agent Worktree
   占用时一律拒绝，且不做 reset/clean/切分支。快照与构建/验证各用独立锁，同一时刻只有一个
   snapshot create；本次选中的任务会在任务锁内重新读取，避免旧状态进入快照；
6. **应用补丁**：对每个任务 `git diff <from>..<commit> -- <声明路径 + 放行路径>` 后
   `git apply --index --3way`；冲突 → 拒绝并提示先读双方 diff；
7. **越界复核**：应用后工作区改动必须仍在声明范围（含显式放行的路径）；
8. **集成检查**：`--check static`（默认）在集成工作区执行 `npm run typecheck`（即 `tsc --noEmit`），
   经构建调度器排队（label `integration-<快照>-static`），失败则不提交快照。该阶段**不再执行
   `vite build`**：Vite 打包由正式构建自身的 `beforeBuildCommand` 完成，避免同一份 dist 被生成两次。
   若旧快照的 `package.json` 尚未定义 `typecheck`（例如 `snap-04` 之前的提交），自动回退到本地
   `node_modules/typescript/bin/tsc --noEmit`；仍不执行 Vite。本地 TypeScript 缺失时检查失败，
   不跳过、不把“脚本不存在”当作通过。
   类型检查覆盖公共类型/接口兼容；需要运行测试的任务在 `task verify` 阶段完成，不把完整安装包构建当模块检查。
9. **生成快照提交**，提交信息带任务关联（可从 commit 反查任务）：

```
integration: 3 项已集成任务（snap-02）

TaskDock-Snapshot: snap-02
TaskDock-Base: <基线提交>
TaskDock-Tasks: files-rescan=<提交> tasks-filter=<提交> window-snap=<提交>
TaskDock-Check: npm run typecheck exit=0
```

记录写入 `tmp/integration/snapshots/<快照>.json`（任务的 commit / paths /
`includedExtraPaths` / checks / note / `baseSnapshot`）。`snapshot create` 不会改动 `main`，也不会创建或删除任何
任务分支。应用补丁或静态检查失败时，工具自有快照工作区会 `reset` 回基线并清理该工作区里由补丁
产生的未跟踪文件，**检查日志与
`tmp/integration/logs/<快照>-failure.json` 失败记录保留**，不会把半个补丁留给下一次操作；需要现场可用
`--dry-run` 加人工复现，而不是依赖残留工作区。

## 5. 验收批次与统一构建（build）

**默认不是「一个任务完成就出包」。** `task ready` 只把任务放入下一验收批；先评估再决定是否构建：

```bash
# 只读：输出待验收/新增/阻塞/复用/建议快照，不写台账、不加锁、不构建
npm run integrate -- batch plan --platform desktop [--mode batch|urgent|manual] [--min-ready 2] [--json]

npm run integrate -- build --snapshot snap-02 --platform desktop [--mode batch|urgent|manual]
npm run integrate -- build --snapshot snap-02 --platform web|android
npm run integrate -- build --snapshot snap-02 --platform desktop --dry-run   # 只打印计划
```

`batch plan` 输出：当前待验收任务数、已就绪未集成任务、上一快照累计任务、当前可纳入新增任务、
依赖/冲突阻塞任务、已有构建是否可复用、预计回归任务、推荐快照与验收范围，以及本轮是否建议正式构建。
默认 `min-ready=2`：低于 2 个可合批任务时建议继续等待；`urgent` 用于阻塞性故障/安全修复，
`manual` 用于人工指定任务或固定快照，最终都走同一条独立快照、调度器、产物校验流程，不绕过安全机制。
不新增后台轮询/常驻服务；在任务就绪、主 Agent 请求、`batch plan` 与正式构建前评估即可。

| 平台 | 配置 | 命令（经调度器） | 产物 |
|---|---|---|---|
| `desktop` | `release-nsis-msi` | `npm run tauri:raw -- build` | `bundle/nsis/*.exe`、`bundle/msi/*.msi`（至少一个本次生成的安装包） |
| `web` | `frontend-dist` | `npm run build:raw`（tsc + vite） | `dist/`（目录摘要 + 文件清单摘要） |
| `android` | `apk-release` | `npm --prefix apps/mobile run build:android` | `apk/release/*.apk` |

构建要点：

- **独立干净构建工作区**：`<仓库父目录>/<仓库名>-integration-build` 以 detached HEAD 执行
  `git checkout <快照提交>`；必须带身份记录（`tmp/integration/worktrees/build.json`）才能被切换/构建，
  缺记录时先 `worktree adopt --role build`，不会自动重建或删除。快照工作区 `<仓库名>-integration`
  只负责 `integration` 分支，验证工作区 `<仓库名>-integration-verify` 只做真实检查；三者各有锁，
  不会互相换 HEAD。构建前要求工作区干净；其他 Agent 在主工作区的未提交改动、乃至 `main` 上更晚的
  提交都不会进入产物。
- **缓存登记 fail-closed**：桌面构建创建 `target-integration` 后必须 `build-guard register` 成功才继续；
  登记失败（或缺少 `scripts/build-guard.mjs`）直接拒绝构建并写失败记录，不产生无法追踪的大缓存。
- **磁盘与缓存**：桌面构建 `CARGO_TARGET_DIR=<主仓库>/src-tauri/target-integration`（绝对路径，
  与主工作区 target 分开）；构建前复用 `build-guard precheck`；构建结束按 build-guard 规则人工回收
  （记录里的 `targetDir` 就是回收对象）。桌面 release 默认 `CARGO_BUILD_JOBS=2`（可用环境变量覆盖，
  但会被记入记录），并在构建前写入可用/总内存快照；极低内存（默认低于
  `TASKDOCK_MIN_FREE_MEM_MB=256`）直接写 `resource-error` 失败记录，不启动整包构建。
- **失败分类**：失败构建按日志与退出状态归为 `source-error` / `dependency-error` / `resource-error` /
  `environment-error` / `packaging-error` / `unknown`，写 `failureClass` 与 `failureHint`；工具**不自动
  重试**昂贵正式构建，资源类失败先等空闲/降并发再人工重试。`STATUS_STACK_BUFFER_OVERRUN` 或
  `memory allocation of ... failed` 不得误报为源码错误。
- **调度**：一律经 `scripts/build-sched.mjs run`（label `integration-<构建ID>`），与其他会话共享
  全局并发与槽位，不另造锁；`build.json` 记录 `schedulerTaskId`（若日志可解析）与日志路径。
- **复用**：复用键 = `快照提交 | 平台 | 配置 | CPU 架构 | 构建输入指纹`。输入指纹覆盖
  `package-lock.json`、根/移动端依赖段、命令与 Node/Rust/Java 工具链版本；旧记录没有指纹一律
  视为不可复用。只复用 `status=succeeded`、`dirty=false`、有平台可用产物**且重新计算校验值一致**
  的构建；空产物、失败构建、`--command` 实验构建不复用；`--force` 才重建。两个进程同时请求
  同一构建时，后到者等待锁并在取得锁后重新查复用，不重复打包。
- **成功判据**：命令退出 0 之外，还必须有平台可用产物：web 的 `dist/index.html` 非空、桌面至少
  一个本次生成的 `.exe`/`.msi`、Android 至少一个本次生成的 `.apk`；产物按构建开始时间过滤，
  避免把 `target-integration` 里的旧安装包记到当前 commit。零产物构建记 `failed`，任务不会进入
  `verifying`。
- **依赖**：每次构建（包括已存在链接/独立目录）都重新读取**构建工作区当前文件**的
  `package-lock.json` 与依赖段，和主工作区比较；一致才允许 junction 或带 `.taskdock-deps.json`
  指纹的独立安装。已存在的 junction 不因“链接还在”而直接复用；不一致时拒绝并提示在工具工作区
  用 `npm ci` 独立安装，不删除别人的依赖目录。Android 的 `apps/mobile` 按同一规则**单独**校验。
- **移动端输入**：`apps/mobile/android/` 不入库，集成构建工作区缺失时明确拒绝并提示先 `expo prebuild`，
  不会静默产出不可信产物。
- **dry-run**：只输出计划与是否已有可复用构建，不创建构建工作区、不切换 HEAD、不写记录、不改
  任务状态；任何复用/加锁/建目录都必须发生在 dry-run 返回之后。
- **中断记录（不删除、可追溯）**：构建取得锁并定 ID 后，先落一份 `status="running"` 骨架记录
  （快照、提交、平台、复用键、任务链、资源、命令、日志路径齐全，产物为空）；成功/失败收尾记录
  覆盖它。若进程在准备/排队/构建阶段被外部终止（强杀、会话结束、休眠、父进程退出），收尾
  catch 不会执行，骨架或仅 `build.log` 的目录保留现场。`status` 把 `running` 与「只有
  `build.log`、`build.json` 从未写出」的目录分别归为 `interrupted`（中断未收尾）；`build.json`
  存在但 JSON 损坏是另一类告警。**中断/损坏记录一律不删除、不容错解析**：不计入成功、不可复用、
  不参与验收覆盖与批次判定；人工核对 `build.log` 与调度器 provenance 后再决定是否重试。

构建记录（`tmp/integration/builds/<构建ID>/build.json`）字段（`tasks` 是本批增量，`snapshotChain` /
`includedTasks` 是按快照 base 链累计的完整来源，供安装包追溯）：

```json
{
  "id": "b02-desktop-r1", "snapshot": "snap-02", "commit": "<40 位 SHA>", "shortCommit": "<7 位>",
  "dirty": false, "platform": "desktop", "config": "release-nsis-msi", "mode": "batch", "experimental": false,
  "reuseKey": "<commit>|desktop|release-nsis-msi|<arch>|<inputsDigest>", "inputsDigest": "<64 位>", "arch": "x64",
  "status": "succeeded", "exitCode": 0, "startedAt": "...", "finishedAt": "...", "durationMs": 123456,
  "tasks": [{ "id": "files-rescan", "commit": "...", "module": "资源管理器", "owner": "agent-a",
              "paths": ["src/..."], "extraPaths": [] }],
  "snapshotChain": ["snap-01", "snap-02"],
  "includedTasks": [{ "id": "files-rescan", "commit": "...", "module": "资源管理器", "owner": "agent-a" }],
  "plannedAcceptance": 2, "resource": { "freeMemMB": 1024, "totalMemMB": 16384, "cpuCount": 16 },
  "failureClass": null, "failureHint": null,
  "command": ["npm", "run", "tauri:raw", "--", "build"],
  "cwd": "<仓库父目录>/<仓库名>-integration-build", "targetDir": "<target-integration>",
  "logPath": "tmp/integration/builds/.../build.log", "schedulerTaskId": "h-...",
  "artifacts": [{ "name": "Task Dock_0.5.0_x64-setup.exe", "kind": "file", "bytes": 7650000,
                  "sha256": "<64 位>", "copiedTo": "tmp/integration/builds/b02-desktop-r1/artifacts/..." }]
}
```

每个构建目录另有 `coverage.json`（覆盖率）和 `reuse-hits.jsonl`（相同输入复用命中记录）。`coverage.json`
至少包含 `newTasks` / `includedTasks` / `plannedAcceptance` / `completedAcceptance` / `firstAcceptance` /
`regressionAcceptance` / `coverageRate` / `reuseHits` / `heavyBuildExecuted` / `durationMs` /
`failureClass`；这些是 CLI/JSON 指标，不新增构建看板 UI。重复构建避免次数只统计实际 `reuse-hits`
事件，不把“理论上少构建”写成已节省。


`dirty` 是构建前后的实际测量结果，不是常量；失败构建同样写 `status=failed`、`exitCode`、
`reason` 与日志尾部/路径，失败也是证据。`--command` 构建会写 `experimental=true`，只用于测试，
不会被正式构建复用。

## 6. 多 Agent 联合验收

统一版本 = 一个 `buildId`（例如 `b02-desktop-r1`）。所有验收结论都必须绑定这个 `buildId` 与 commit。

```bash
npm run integrate -- accept --build b02-desktop-r1 --task files-rescan --status pass \
    --evidence tmp/acceptance/files-rescan/evidence.json
npm run integrate -- accept --build b02-desktop-r1 --task tasks-filter --status fail \
    --note "筛选后列表不刷新" --repro "1) 输入关键词 2) 清空 3) 列表仍为旧结果"
```

- 每个任务写自己的 `<构建目录>/acceptance/<任务>.json`，**互不覆盖**；同一 `buildId+taskId`
  重复提交时保留 `revision` 与最多 20 条 `history`，不静默抹掉旧结论；多条记录可同时存在；
- 验收资格按构建的**累计任务清单** `includedTasks` 判断，而不是要求 `build.snapshot === task.snapshot`：
  任务代码仍包含在当前构建、任务当前交付提交与构建包含的提交一致、且该交付已进入快照时，允许
  基于该 `buildId` 做首次（`kind=first`）或回归（`kind=regression`）验收。典型案例：S1 的 A/B/C
  可在包含 A–E 的 S2 安装包上验收/回归；但 S2 之后又返工、尚未进入 S2 的提交必须拒绝。
- `pass` / `fail` 还要求：构建 `status=succeeded`、`dirty=false`、有平台可用产物；任务处于
  `verifying` 或 `accept-passed`（后者用于新版本回归）；平台必须适用（移动端任务不能用桌面/Web
  构建验收，反之亦然）。失败构建、零产物构建不能写 `pass`/`fail`；
- `fail` 必须写原因；`blocked` / `not-run` 也要求任务处于可验收状态，但不改任务状态；
- 验收必须落在运行证据上（通道与边界见 ACCEPTANCE_ROUTING.md），不能只凭源码或构建成功宣称通过；
- 同一任务在旧构建上的通过记录只证明旧版本，**不会自动复制**成新构建通过；新版本需要独立记录。

- 只有与该构建相关的集成链路才做跨模块回归，不做无意义的全量端到端。

**共享资源协调**（可并行就并行，有冲突就串行）：

| 资源 | 规则 |
|---|---|
| 真实桌面窗口 / 前台焦点 / 物理鼠标键盘 | 同一时刻只允许一个 Agent 操作；需要抢前台或移动光标先取得授权 |
| 隔离实例数据目录 | 每个 Agent 用各自的 `TASK_DOCK_DATA_DIR`，不共用用户库 |
| 同一手机 / 同一 App 实例 | 串行；不能假设多个 Agent 能独立改同一实例状态 |
| 系统剪贴板 | 串行，或明确声明本轮会写入并复原有主剪贴板 |
| CDP 端口 | 先探测空闲再用；不结束别人启动的调试进程 |
| 构建产物 | 只读使用同一构建目录，不重新打包、不覆盖 artifacts |

## 7. 验收失败 → 修复 → 重新集成

```
build b02-desktop-r1 ── accept fail（记录失败构建 + 现象 + 复现）
      └── 负责人修复 → task ready（新提交）→ snapshot create（以 b02 快照为基线）
              └── build b03-desktop-r1（新记录，新 commit）
                      └── 针对失败项定向复测 + 受影响链路回归 → accept pass
```

- 旧构建记录与旧验收记录**保留**，用于追溯；不能拿旧版本的通过结论证明新版本通过；
- 修复步骤只声明实际改动过的路径，避免把无关改动带进下一个快照。

## 8. 开发与验收并行

```
snap-02 / b02-desktop-r1  ← 当前稳定验收版本（Agent A、B 在此验收）
        │
        └── snap-03 / b03-desktop-r1 ← 新集成（Agent C、D 的新任务）
```

- 验收方读取固定 `buildId` 与 commit，不受后续集成影响；
- 开发方继续在共享工作区改代码，改动在 `main` 或任务分支上，不进 `b02` 的构建目录；
- 需要真机/窗口验收的 Agent 用构建目录里的安装包或 exe，配合独立 `TASK_DOCK_DATA_DIR`；
- 同一时刻只保留一个重型构建在跑（调度器保证），避免验收机器被构建拖慢。

## 9. 命令与退出码

| 命令 | 用途 |
|---|---|
| `npm run integrate -- status [--json]` | 任务 / 快照 / 构建 / 验收汇总（只读） |
| `npm run integrate -- batch plan ...` | 只读验收批次计划（累计任务、阻塞、复用、建议） |
| `npm run integrate -- task ...` | 登记、真实执行检查（`verify`）、就绪、查看 |
| `npm run integrate -- worktree adopt\|status` | 迁移/查看工具自有工作区身份（只校验登记，不重建不重置） |
| `npm run integrate -- snapshot bootstrap\|create` | 基线 / 增量快照 |
| `npm run integrate -- build --snapshot <id> --platform <p>` | 统一构建（含复用、`--mode` 与 dry-run） |
| `npm run integrate -- accept --build <id> --task <id> --status <s>` | 写验收结论 |
| `npm run integrate:test` | 本机制的自动化用例（临时仓库，不碰真实工作区） |

| 退出码 | 含义 |
|---|---|
| 0 | 成功（含「复用已有构建」；dry-run 也返回 0） |
| 1 | 用法/环境错误（参数缺失、任务不存在、首次集成没给 `--base`） |
| 2 | 前置条件拒绝（状态不符、路径越界、交集、冲突、工作区不干净、证据路径不存在） |
| 3 | 执行失败（集成静态检查失败、构建失败） |
| 4 | 状态/IO 异常（记录读写失败、未预期错误） |

注：`task check` 是**人工登记**（`source=external`），只绑定提交与退出码，可用于留痕；无证据的登记
不能让任务进入待集成。正式资格来自 `task verify --commit <交付提交> --cmd "<真实命令>"`：它会在
隔离工作区 checkout 该提交、核对依赖、经调度器执行，并记录日志/退出码/调度任务。`--exit` 非 0 时
`task check` 仍写记录但返回 2；`task ready` 需要同一交付提交上至少一条 `source=executed`（或带
`--evidence` 的外部）通过记录，否则返回 2。

环境变量：`TASKDOCK_GIT` 可显式指定 Git 可执行文件。默认先查 `PATH`，再回落到 Windows 常见安装
位置（`C:\Program Files\Git\cmd\git.exe` 等）——不同 Agent 的 shell 未必都带 Git；构建命令里的
`node` 也统一用当前 Node 进程的可执行文件，不依赖 `PATH`。

## 10. 记录位置与清理

| 内容 | 位置 | 是否入库 |
|---|---|---|
| 任务、快照、构建、验收、真实检查日志 | `tmp/integration/{tasks,snapshots,builds,logs}/` | 否（`tmp/` 已 gitignore） |
| 构建覆盖率与复用命中 | `tmp/integration/builds/<构建ID>/{coverage.json,reuse-hits.jsonl}` | 否（`tmp/` 已 gitignore） |
| 工具工作区身份记录 | `tmp/integration/worktrees/{snapshot,build,verify}.json` | 否（`tmp/` 已 gitignore；缺记录时工具拒绝操作，可 `worktree adopt` 非破坏迁移） |
| 集成快照工作区 | `<仓库父目录>/<仓库名>-integration`（分支 `integration`） | 否（独立 checkout） |
| 集成构建工作区 | `<仓库父目录>/<仓库名>-integration-build`（detached HEAD） | 否（独立 checkout） |
| 真实检查工作区 | `<仓库父目录>/<仓库名>-integration-verify`（detached HEAD） | 否（独立 checkout） |
| 桌面构建缓存 | `src-tauri/target-integration/` | 否（`target-*` 规则） |
| 任务关联的持久记录 | 快照提交信息里的 `TaskDock-*` 行 | 是（随 commit 走） |

清理：

```bash
# 集成快照/构建/验证工作区（确认没有 Agent 正在运行对应操作后）
git worktree remove ../task_dock-integration        # 不带 --force；被占用会被拒绝
git worktree remove ../task_dock-integration-build
git worktree remove ../task_dock-integration-verify
git branch -d integration                           # 仅在快照已合入需要的位置后

# 桌面构建缓存（按 build-guard 归属规则，人工确认后）
node scripts/build-guard.mjs cleanup --dir <主仓库绝对路径>/src-tauri/target-integration --dry-run
node scripts/build-guard.mjs cleanup --dir <主仓库绝对路径>/src-tauri/target-integration --execute
```

`tmp/integration` 是本地台账，不作为唯一事实来源：**代码状态以快照提交为准，任务与构建的对应关系
以提交信息 + `build.json` 为准**。清理本地台账不会改变已生成的快照提交。

## 11. 它不做什么

- 不推送、不打标签、不合并到 `main`、不改任何任务分支；
- 不替代人工判断：`--allow-overlap`、`--allow-extra-paths` 都是显式留痕的例外；后者会真正应用
  未声明路径，使用前必须确认这些文件属于本任务，不能默认放宽；
- 不创建 Worktree 给每个 Agent（那仍由 AGENTS.md §3.1 / §3.5 按冲突判定）；
- 不新增后台服务/常驻进程：所有命令都是一次性 CLI，读写的只是 JSON 与 Git 对象；
- 不修改构建看板界面，不实现 Relay。
