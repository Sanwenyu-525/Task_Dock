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
| `integration-ready` 待集成 | 代码完成且模块级检查通过 | 负责人 `task ready` | 已登记交付提交 + 至少 1 条 `exit=0` 的检查记录 |
| `integrated` 已集成 | 改动进入快照提交 | 工具（`snapshot create` 成功） | 快照提交生成、改动全部落在声明范围 |
| `verifying` 待验收 | 代码已包含在可用产物中 | 工具（`build` 成功） | 构建成功且产物校验值已记录 |
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
| `paths` | **写入范围白名单**（文件或目录，目录以 `/` 结尾）；集成只应用这些路径 |
| `commit` + `from` | 交付提交与起点（默认 `commit^`）；多提交任务用 `--from` 指定起点 |
| `checks` | 实际执行的检查：命令 + 退出码 + 时间 + 日志路径 |
| `publicInterface` | 是否改动公共接口（IPC/类型/迁移/设置键），供集成顺序判断 |
| `needs` | 依赖的其他任务 |

交付时的最小动作：

```bash
npm run integrate -- task add --id files-rescan --owner agent-a --module 资源管理器 \
    --paths src/components/files/FilesWorkspacePanel.tsx,src/lib/filesWorkspace/interactions.ts
npm run integrate -- task check --id files-rescan --cmd "npm test -- src/components/files" --exit 0
npm run integrate -- task ready --id files-rescan --commit <交付提交>
```

规则：

- **一个交付提交只放本任务的改动**。提交里出现未声明路径时工具拒绝集成（防止把别的任务带进来）；
  确属本任务时用 `--allow-extra-paths` 显式放行，放行内容记入快照的 `ignoredPaths` 备查。
- 检查记录是负责人的声明；集成时工具还会执行一次真实的静态检查（`--check static`，默认），
  这次结果才是「快照可构建」的证据。
- 返工：`accept-failed` 后修完用 `task ready --commit <修复提交> --from <上一交付提交>`，
  让补丁只覆盖修复内容，再进入下一个快照。

## 4. 统一集成（snapshot）

```bash
npm run integrate -- snapshot bootstrap --base <稳定提交>     # 只登记基线，不叠加任务
npm run integrate -- snapshot bootstrap --base <提交> --force  # 基线不可构建且尚无任务集成时重新登记
npm run integrate -- snapshot create --tasks a,b,c [--check static|none] [--dry-run]
npm run integrate -- snapshot create --all-ready              # 所有「待集成」任务
```

> 基线提交必须自己先能通过检查。历史提交是定时提交（可能夹带别人的半成品），所以
> `bootstrap` 之后应立刻 `build` 一次做基线体检；若构建失败且还没有任务被集成，用
> `snapshot bootstrap --base <另一个提交> --force` 重新登记新基线（旧记录保留，不被覆盖）。
> 已有任务集成后不允许重置基线——那会丢失任务关联。

`snapshot create` 的执行顺序（任一步不满足即拒绝，退出码 2，保留现场）：

1. **任务资格**：状态为待集成（或返工后带新交付），有交付提交与写入范围；
2. **基线**：`--base` 显式指定，或默认「上一个快照的提交」。**首次集成必须显式给 `--base`**，
   不允许拿共享工作区 `HEAD` 当基线；
3. **路径核对**：交付提交的改动必须全部落在声明范围；新增/删除/改名的两侧都要在范围内；
4. **交集检查**：同批选中任务之间写入范围有交集即拒绝（交集文件只能有一个所有者），
   确需同批用 `--allow-overlap` 并在记录中留痕；
5. **工作区**：`<仓库父目录>/<仓库名>-integration`，分支 `integration`。
   目录已存在但不是本仓库登记的工作区、或状态不干净 → 拒绝，绝不覆盖他人现场；
6. **应用补丁**：对每个任务 `git diff <from>..<commit> -- <声明路径>` 后 `git apply --index --3way`；
   冲突 → 拒绝并提示先读双方 diff；
7. **越界复核**：应用后工作区改动必须仍在声明范围内；
8. **集成检查**：`--check static`（默认）在集成工作区执行 `tsc --noEmit && vite build`，
   经构建调度器排队（label `integration-<快照>-static`），失败则不提交快照；
9. **生成快照提交**，提交信息带任务关联（可从 commit 反查任务）：

```
integration: 3 项已集成任务（snap-02）

TaskDock-Snapshot: snap-02
TaskDock-Base: <基线提交>
TaskDock-Tasks: files-rescan=<提交> tasks-filter=<提交> window-snap=<提交>
TaskDock-Check: npm run build:raw exit=0
```

记录写入 `tmp/integration/snapshots/<快照>.json`（任务的 commit / paths / ignoredPaths /
checks / note）。`snapshot create` 不会改动 `main`，也不会创建或删除任何任务分支。

## 5. 统一构建（build）

```bash
npm run integrate -- build --snapshot snap-02 --platform desktop
npm run integrate -- build --snapshot snap-02 --platform web|android
npm run integrate -- build --snapshot snap-02 --platform desktop --dry-run   # 只打印计划
```

| 平台 | 配置 | 命令（经调度器） | 产物 |
|---|---|---|---|
| `desktop` | `release-nsis-msi` | `npm run tauri:raw -- build` | `bundle/nsis/*.exe`、`bundle/msi/*.msi` |
| `web` | `frontend-dist` | `npm run build:raw`（tsc + vite） | `dist/`（目录摘要 + 文件清单摘要） |
| `android` | `apk-release` | `npm --prefix apps/mobile run build:android` | `apk/release/*.apk` |

构建要点：

- **干净快照工作区**：在集成工作区执行 `git checkout --detach <快照提交>` 后构建，构建前要求工作区干净；
  其他 Agent 在主工作区的未提交改动、乃至 `main` 上更晚的提交都不会进入产物。
  （`integration` 分支保留「最新快照提交」，工作区在构建期间是 detached HEAD；每次 `snapshot create`
  会把分支重新指向新基线再提交，因此分支与快照始终一一对应。）
- **磁盘与缓存**：桌面构建 `CARGO_TARGET_DIR=<主仓库>/src-tauri/target-integration`（绝对路径，
  与主工作区 target 分开，避免跨 checkout 指纹反复失效）；构建前复用 `build-guard precheck`；
- **调度**：一律经 `scripts/build-sched.mjs run`（label `integration-<构建ID>`），与其他会话共享
  全局并发与槽位，不另造锁；
- **复用**：复用键 = `快照提交 | 平台 | 配置`。已有成功构建且产物校验值一致时直接复用，
  不因「另一个 Agent 也要验收」再跑一遍；`--force` 才重建；
- **依赖**：集成工作区没有 `node_modules` 时，仅在 `package-lock.json` 与主工作区逐字节一致、
  且 `package.json` 的依赖段（dependencies / devDependencies 等）一致时建立 junction；
  不一致则拒绝并提示独立安装（脚本或元数据差异不影响已装依赖，单独放行）；
- **移动端输入**：`apps/mobile/android/` 不入库，集成工作区缺失时明确拒绝并提示先 `expo prebuild`，
  不会静默产出不可信产物。

构建记录（`tmp/integration/builds/<构建ID>/build.json`）字段：

```json
{
  "id": "b02-desktop-r1", "snapshot": "snap-02", "commit": "<40 位 SHA>", "shortCommit": "<7 位>",
  "dirty": false, "platform": "desktop", "config": "release-nsis-msi",
  "status": "succeeded", "exitCode": 0, "startedAt": "...", "finishedAt": "...", "durationMs": 123456,
  "tasks": [{ "id": "files-rescan", "commit": "...", "module": "资源管理器", "owner": "agent-a" }],
  "command": ["npm", "run", "tauri:raw", "--", "build"],
  "cwd": "<集成工作区>", "targetDir": "<target-integration>", "logPath": "tmp/integration/builds/.../build.log",
  "artifacts": [{ "name": "Task Dock_0.5.0_x64-setup.exe", "kind": "file", "bytes": 7650000,
                  "sha256": "<64 位>", "copiedTo": "tmp/integration/builds/b02-desktop-r1/artifacts/..." }]
}
```

产物按原名复制到构建目录，构建失败同样写记录（含退出码与日志尾部），失败也是证据。

## 6. 多 Agent 联合验收

统一版本 = 一个 `buildId`（例如 `b02-desktop-r1`）。所有验收结论都必须绑定这个 `buildId` 与 commit。

```bash
npm run integrate -- accept --build b02-desktop-r1 --task files-rescan --status pass \
    --evidence tmp/acceptance/files-rescan/evidence.json
npm run integrate -- accept --build b02-desktop-r1 --task tasks-filter --status fail \
    --note "筛选后列表不刷新" --repro "1) 输入关键词 2) 清空 3) 列表仍为旧结果"
```

- 每个任务写自己的 `<构建目录>/acceptance/<任务>.json`，**互不覆盖**；多条记录可同时存在；
- `fail` 必须写原因；`blocked` / `not-run` 保持任务为待验收；
- 验收必须落在运行证据上（通道与边界见 ACCEPTANCE_ROUTING.md），不能只凭源码或构建成功宣称通过；
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
| `npm run integrate -- task ...` | 登记、检查、就绪、查看 |
| `npm run integrate -- snapshot bootstrap\|create` | 基线 / 增量快照 |
| `npm run integrate -- build --snapshot <id> --platform <p>` | 统一构建（含复用与 dry-run） |
| `npm run integrate -- accept --build <id> --task <id> --status <s>` | 写验收结论 |
| `npm run integrate:test` | 本机制的自动化用例（临时仓库，不碰真实工作区） |

| 退出码 | 含义 |
|---|---|
| 0 | 成功（含「复用已有构建」；dry-run 也返回 0） |
| 1 | 用法/环境错误（参数缺失、任务不存在、首次集成没给 `--base`） |
| 2 | 前置条件拒绝（状态不符、路径越界、交集、冲突、工作区不干净、证据路径不存在） |
| 3 | 执行失败（集成静态检查失败、构建失败） |
| 4 | 状态/IO 异常（记录读写失败、未预期错误） |

注：`task check --exit <非 0>` 会把记录写入台账，但命令本身返回 2（便于脚本在失败检查后立即停）；
`task ready` 要求至少一条 `exit=0` 记录与交付提交，否则返回 2。

## 10. 记录位置与清理

| 内容 | 位置 | 是否入库 |
|---|---|---|
| 任务、快照、构建、验收记录 | `tmp/integration/{tasks,snapshots,builds,logs}/` | 否（`tmp/` 已 gitignore） |
| 集成工作区 | `<仓库父目录>/<仓库名>-integration`（分支 `integration`） | 否（独立 checkout） |
| 桌面构建缓存 | `src-tauri/target-integration/` | 否（`target-*` 规则） |
| 任务关联的持久记录 | 快照提交信息里的 `TaskDock-*` 行 | 是（随 commit 走） |

清理：

```bash
# 集成工作区（确认没有 Agent 正在验收该分支后）
git worktree remove ../task_dock-integration        # 不带 --force；被占用会被拒绝
git branch -d integration                           # 仅在快照已合入需要的位置后

# 桌面构建缓存（按 build-guard 归属规则，人工确认后）
node scripts/build-guard.mjs cleanup --dir <主仓库绝对路径>/src-tauri/target-integration --dry-run
node scripts/build-guard.mjs cleanup --dir <主仓库绝对路径>/src-tauri/target-integration --execute
```

`tmp/integration` 是本地台账，不作为唯一事实来源：**代码状态以快照提交为准，任务与构建的对应关系
以提交信息 + `build.json` 为准**。清理本地台账不会改变已生成的快照提交。

## 11. 它不做什么

- 不推送、不打标签、不合并到 `main`、不改任何任务分支；
- 不替代人工判断：`--allow-overlap`、`--allow-extra-paths` 都是显式留痕的例外，不默认放宽；
- 不创建 Worktree 给每个 Agent（那仍由 AGENTS.md §3.1 / §3.5 按冲突判定）；
- 不新增后台服务/常驻进程：所有命令都是一次性 CLI，读写的只是 JSON 与 Git 对象；
- 不修改构建看板界面，不实现 Relay。
