# 构建资源调度器（build-sched）使用与原理

多会话/AI 并行开发时，真正会互相伤害的不是代码，而是**构建**：`cargo build`、`tauri build`、
`npm run build`、Gradle、整包测试同时起跑，会争同一份 Cargo target、同一个 `dist/`、同一块
内存。16GB 机器上两个重型构建并行就足以把系统压到卡死。

本调度器提供**一个跨进程、跨 Worktree、跨 AI 会话的全局构建闸门**：
所有高资源构建走同一个入口，按分类槽位与全局构建并发（最多 3 个 heavy/medium/light）排队，
靠操作系统级原子操作互斥，崩溃后能安全回收。**代码开发仍然完全并行**——被排队的只是构建。

入口：`node scripts/build-sched.mjs`（npm 别名 `npm run sched`），零新增依赖、纯 Node ESM，
复用既有的 [build-guard.mjs](../scripts/build-guard.mjs)（磁盘/缓存守卫）。

---

## 1. 为什么不是「写进 AGENTS.md 就够了」

AGENTS.md 只是行为规范：它约束**愿意遵守的**会话。真实事故来自三类动作：

1. 另一个会话（甚至另一个工具）并不知道规范存在，直接 `cargo build`；
2. 会话知道规范，但"我先跑一次再看"——两个会话同时这么想就撞上了；
3. 会话崩溃/被关掉，锁或半成品留在原地，后续所有人被卡死或被误导。

所以真正的互斥必须落在**文件系统的原子操作**上，而不是文档。AGENTS.md 里那一条的作用是
"让标准入口成为默认路径"（见第 9 节），强制协调由本调度器负责。

## 2. 快速开始

```powershell
# 看现在能不能跑、别人在跑什么
npm run sched:status           # 槽位 + 全局构建并发 + 排队
npm run sched:queue            # 队列（按有效优先级）

# 提交一个构建（必须用 -- 把真实命令隔开）
node scripts/build-sched.mjs run -- npm run build:raw
node scripts/build-sched.mjs run --priority P0 --label "verify-fix" -- cargo build
node scripts/build-sched.mjs run --class light -- npm run lint

# cargo 走专门子命令：自动切到 src-tauri/（遵守 rust-toolchain.toml 固定的 MSVC 工具链）
npm run cargo -- test --lib clipboard::
node scripts/build-sched.mjs cargo -- --priority P0 test --lib clipboard::

# 运维
npm run sched:history          # 退出码 / 等待时长 / 运行时长 / 失败原因
npm run sched:doctor           # 自诊断（只读）
node scripts/build-sched.mjs doctor --reap   # 才会真正回收槽位/清理残留
node scripts/build-sched.mjs cancel --id l-mwh7jtaw-12b733
npm run sched:dev              # 开发服务器/端口盘点（只读）
npm run sched:config           # 有效配置（含来源）
```

`package.json` 已把标准入口接到调度器上，AI 会话通常不需要记原始命令行：

| npm 入口 | 实际执行 | 分类 |
|---|---|---|
| `npm run dev` | `run --class dev --priority P2 --label desktop-vite -- vite` | dev（占 dev 槽位） |
| `npm run preview` | `run --class dev --priority P2 --label desktop-preview -- vite preview` | dev（占 dev 槽位） |
| `npm run build` | `run --priority P1 --label desktop-build -- npm run build:raw`（`tsc --noEmit && vite build`） | medium |
| `npm run tauri` | `run --priority P0 --label tauri -- npm run tauri:raw`（`tauri`，含 `beforeBuildCommand: npm run build`） | heavy |
| `npm run test` | `run --priority P1 --label desktop-test -- npm run test:raw`（`vitest run`） | medium |
| `npm run cargo` | `cargo` 子命令（cwd=`src-tauri/`） | 按子命令判定（`cargo build` heavy / `cargo check` medium） |
| `npm run tauri -- dev`（桌面端开发调试，长驻） | `run --class dev --label tauri-dev -- npx tauri dev` | dev（占 dev 槽位） |

`*-raw` 后缀是"绕过调度器直接执行"的逃生门，只在调度器自身故障排查时使用；
`build-guard`、`worktree-guard`、`icons`、`help:check` 等既有轻量脚本保持原样。

## 3. 命令参考

### 3.1 `run`

```
node scripts/build-sched.mjs run [选项] -- <命令> [参数...]
```

| 选项 | 说明 |
|---|---|
| `--priority P0..P3` | 优先级，默认 P1（见 4.4） |
| `--class light\|medium\|heavy\|dev` | 显式覆盖自动分类（只在该分类确实合适时用） |
| `--label <文字>` | 在 `queue`/`status` 中显示的任务名（建议写清用途，便于他人看懂） |
| `--wait-timeout <分>` | 排队等待上限，默认取 `defaultWaitTimeoutMin`（20 分钟），`0` = 不限 |
| `--run-timeout <分>` | 运行上限，默认 `0`（不限）；超时会终止**本任务自己的**子进程树 |
| `--cwd <路径>` | 执行目录（默认当前目录） |
| `--no-dedupe` | 关闭等价任务合并 |
| `--no-tee` | 子进程输出只写日志，不转发终端（日志更干净） |
| `--detach-child` | 子进程脱离本进程控制台（仅用于构造"父进程死了构建还在跑"的验收场景，见 5.5） |
| `--shell-raw` | 允许含引号/换行的参数交给 `cmd.exe` 原样解析（慎用） |

行为要点：
- **非交互**：不读 stdin、不弹窗，适合任何自动化/AI 会话；
- 子进程的环境变量、工作目录、`argv` 原样传递，**退出码原样返回**；
- stdout/stderr 双写：转发到终端（`--no-tee` 可关）+ 落到 `state/logs/<taskId>.log`（超限截断，不无限增长）；
- 日志尾部固定有一行机器可读结论：`sched: exit=0 status=succeeded class=medium reason=-`。

### 3.2 `status` / `queue` / `history`

```powershell
node scripts/build-sched.mjs status              # 人读
node scripts/build-sched.mjs status --json       # 程序读（槽位、活动台账/全局并发、队列、配置摘要）
node scripts/build-sched.mjs status --verbose    # 额外做持有者身份校验 + dev 盘点（较慢）
node scripts/build-sched.mjs history --limit 20
```

`history` 每条含 `status`、`exitCode`、`waitMs`、`runMs`、`reason`、`worktree`、`globalAtStart`。
2026-11-16 起不再有 `minAvailMb` / `memDuringRun` / `budgetAtStart` 等内存与预算字段（旧条目保留原样）。

### 3.3 `cancel`

```powershell
node scripts/build-sched.mjs cancel <任务ID或前缀>              # 默认最多等 15 s 让持有者收尾
node scripts/build-sched.mjs cancel <任务ID或前缀> --wait 3     # 只等 3 s
```

取消用**标记文件**（`state/cancel/<taskId>`）而不是改别人的记录：写别人的 JSON 会和持有者
的写操作打架。持有者在轮询里看到标记后终止自己的**子进程树**并退出码 4；排队中的任务下一轮
轮询直接按取消退出，不会再启动构建。

CLI 自己的退出码：任务已到终态（多为 `cancelled`）→ 0；持有者在 `--wait` 内没有响应 → 3
（请求已持久化，持有者下轮仍会处理）。

**防止误判死进程**：CLI 不会因为一次探活失败就把任务写成 `cancelled`。只有同时满足
「身份取证判定提交进程已退出」**且**「该记录 ≥15 s 没有任何更新」才直接替它收尾；等待过程中
还会再取证一次（≥6 s 无更新才收尾）。否则只保留取消请求——真活着但被误判的提交进程会照常
按 4 退出，不会被"假取消"（历史缺陷：单次探活把活着的提交进程的任务标成 cancelled，它随后
覆盖回 running 继续跑，导致取消被静默吞掉）。

### 3.4 `doctor`

```powershell
node scripts/build-sched.mjs doctor          # 只读诊断（状态目录、配置、槽位、日志、dev 冲突）
node scripts/build-sched.mjs doctor --reap   # 执行回收：陈旧槽位、提交进程已死的残留记录
```

默认**只诊断不动手**：不删文件、不杀进程。加 `--reap` 才会回收，且回收仍受第 5 节的证据约束。

### 3.5 `dev`

```powershell
node scripts/build-sched.mjs dev             # 人读
node scripts/build-sched.mjs dev --json
```

盘点 Tauri Dev / Vite / esbuild / cargo 等常驻进程：所属工作区、端口、父链，并报四类 findings：
`port-shared`（端口被非预期进程占用）、`duplicate-vite`（同工作区重复启动）、
`dev-cargo-concurrent`（dev 期间跑重型 cargo）、`cross-worktree-port`（不同 Worktree 抢同一端口）。
**只读**：发现重复只报告，不替你杀进程。

### 3.6 `cargo`

```powershell
npm run cargo -- test --lib mobile_sync::          # 无 -- 时参数全部原样给 cargo
node scripts/build-sched.mjs cargo -- --priority P0 build   # 有 -- 时前面是调度选项
```

固定 `cwd = src-tauri/`：`AGENTS.md` 与 `docs/DEVELOPMENT.md` 都要求 cargo 在 `src-tauri/` 内运行
（从仓库根用 `--manifest-path` 会绕开 `rust-toolchain.toml` 固定的 MSVC 工具链）。

### 3.7 退出码

| 退出码 | 含义 |
|---|---|
| 0 | 子进程成功 |
| 其它数字 | **子进程自己的退出码原样透传**（代码失败的诊断信息与直接执行时完全一致） |
| 3 | 等待资源超时 / 运行超时 |
| 4 | 被取消（`cancel`） |
| 5 | 调度器自身错误（配置非法、状态目录不可写等） |
| 6 | 磁盘 precheck 阻塞（复用 build-guard 的空间阈值） |

判读原则（对应 AGENTS.md「必须区分代码错误、资源不足、超时和调度错误」）：

- `exit=1` + 日志里有编译器/测试错误 → **代码错误**；
- `exit=3` + `status=failed` 且 `reason` 含「槽位」/「全局构建并发已满」→ **资源排队（槽位/全局名额）**，不是代码问题；
- `exit=101`（rustc/cargo OOM）→ 内存不再参与准入，**属于运行期 OOM**：按 11 节处理（局部检查或减少并发）；
- `exit=3` 且 `reason` 含「超时」→ **超时**；
- `exit=5/6` → **调度层/磁盘**问题，先 `doctor`。

### 3.8 构建入口清单与 `:raw` 逃生口（2026-11-15 第二轮审计）

审计范围：根 `package.json` 与 `apps/mobile/package.json` 的**全部**脚本。原则是
"高资源构建一律不得无意绕过调度器"，同时保留一组**明确标注**的轻量/常驻/交互式入口。

| 入口 | 分类 | 是否经调度器 | 说明 |
|---|---|---|---|
| `npm run dev` → `-- vite`（label `desktop-vite`） | dev | ✅ | 2026-11-15 第二轮纳管（主 Agent 授权）：显式 `--class dev`，占 dev 槽位（并发 2） |
| `npm run preview` → `-- vite preview`（label `desktop-preview`） | dev | ✅ | 同上；`vite preview` 是常驻静态预览服务，分类表已修正为 dev（`rule vite-preview`） |
| `npm run build` → `build:raw`（`tsc --noEmit && vite build`） | medium | ✅ | 单层包装，`--priority P1 --label desktop-build`，内层直通，不会双重排队 |
| `npm run tauri -- build` → `tauri:raw` | heavy | ✅ | `--priority P0 --label tauri`；内层 `npm run build` 由 `TASKDOCK_SCHED_TASK_ID` 判定为嵌套直通 |
| `npm run test` → `test:raw`（`vitest run`） | medium | ✅ | `--priority P1 --label desktop-test` |
| `npm run cargo -- <子命令>` | 由 cargo 分类表决定 | ✅ | `build-sched cargo` 子命令，固定 `cwd=src-tauri` |
| `apps/mobile`：`build:android`（gradlew assembleRelease） | heavy（P0） | ✅ | `--cwd android`，与桌面端共享同一份槽位/全局名额台账 |
| `apps/mobile`：`android`（expo run:android）/ `prebuild` | heavy | ✅ | 会拉起 Gradle/Xcode |
| `apps/mobile`：`typecheck`（tsc --noEmit）/ `test`（vitest run） | medium | ✅ | |
| `apps/mobile`：`start`（expo start） | dev | ✅ | 占 dev 槽位 |
| `npm run test:watch` | dev（watch） | ❌（豁免） | 交互式长期运行，人工 Ctrl+C 结束；与 `dev` 不同，它没有稳定的"服务身份"可盘点 |
| `npm run help:check` / `test:scripts` / `icons*` / `guard:*` / `worktree*` / `sched:*` | light | ❌（豁免） | 只读或轻量元数据操作；`sched:*` 再经 `run` 会自锁 |

**为什么 `dev`/`preview` 要显式 `--class dev`**：`vite` 与 `vite preview` 都是"不 Ctrl+C 就不
退出"的常驻服务。仅靠分类表推断风险有二：① `vite preview` 早期被判成 `light`（`rule
vite-other`），会占轻量槽位并与另一条轻量任务同时拉起两个预览服务抢 4173 端口；②
`vite --version` 这类一次性命令确实是 light，若一律靠"命令里有没有 vite"来判会误伤。显式
`--class dev` 把意图写在入口里，分类表也同步修正（`vite preview` → dev），两层一致。

**`dev`/`preview` 经调度器后的行为差异**（运维须知）：`npm run dev` 现在会**在 dev 槽位里
排队**——dev 槽位并发 2，第 3 个 dev 服务要等前一个退出；端口冲突仍是操作者责任（调度器不分配
端口）。想跳过排队只在排障时用 `npm run dev:raw` / `npm run preview:raw`。

**`*:raw` 是排障逃生口，不是日常入口**：`dev:raw` / `preview:raw` / `build:raw` / `tauri:raw` /
`test:raw` / `build:android:raw` / `android:raw` / `prebuild:raw` / `typecheck:raw` /
`start:raw` 只在"调度器自身坏了、需要绕过它定位问题"时使用，用之前先 `sched:status` +
`sched:doctor`；**任何文档与脚本都不得把它们作为推荐命令**（`scripts/build-sched-acceptance.test.mjs`
的「补充C1/C2/C3/C5」用例会静态校验这条规则：根目录 `dev`/`preview`/`build`/`test`/`tauri`
必须经调度器且各自有 `:raw`；新增高资源入口若既不接调度器、也不进豁免名单，套件会直接失败）。

## 4. 资源模型

### 4.1 任务分类（配置项可调）

| 分类 | 槽位并发（默认） | 预计峰值（默认） | 典型任务 |
|---|---|---|---|
| `heavy` | 1 | 6000 MB | `cargo build`/`cargo test --all`、`tauri build`、release 构建、Gradle 构建、组合命令 |
| `medium` | 1 | 3000 MB | `vite build`、整工程 `tsc`、`cargo check`、较大范围测试 |
| `light` | 2 | 800 MB | ESLint/Prettier、单模块类型检查、小范围测试、`build-guard precheck` |
| `dev` | 2 | 3000 MB | `tauri dev`、`vite`（常驻，独立槽位，见第 8 节） |

分类由 `scripts/sched/classify.mjs` 依据**命令链**判定，而不是看命令里有没有 "build"：

- npm 脚本会被展开（`npm run build:` → `tsc … && vite build`）并递归解析（≤3 层），组合命令取最高档；
- `cargo` 子命令按名字判定（`build`/`install`/`test` 重型，`check`/`clippy` 中型）；
- `tauri build` 重型，`tauri dev` 属 dev；
- 未知命令**保守归 heavy**（宁可多排一次队，也不把高资源任务误判成轻量）；
- `node -e` 等无法识别的极短脚本归 light（否则每次探测都会被当重型排队）。

### 4.2 准入约束：全局构建并发 + 分类槽位（内存维度已全部删除）

> **2026-11-16 变更（本轮）**：按用户要求，**「按物理内存估算的全局预算」已整体删除**——
> 不再读物理内存总量/可用量、不再按 `estimate*Mb` 预计峰值记账、不再有 `reservedMb`、
> 不再有 `budgetEnabled` / `systemReserveMb` / `allowReserveBreach` 与配套危险授权，
> 也不再往 `status` / `history` 里写内存与预算证据。`scripts/sched/mem.mjs` 与
> `scripts/sched/budget.mjs` 一并移除，后者精简为 `scripts/sched/admission.mjs`（只保留台账与并发判定）。
>
> **当前准入只有三条**：① 全局构建并发上限（heavy/medium/light 合计最多 3 个在跑）；
> ② 各分类槽位并发；③ 同分类内按优先级/入队顺序排队。**没有任何内存维度**。
>
> 历史：2026-11-15 晚已删除「实时可用内存门槛」（原约束 A，见 10.5）；本轮再把约束 B 删除，
> 因此 10.1–10.6 中涉及的预算数字与判定表均为**当时的记录**，不再代表当前行为。

**约束 C：全局构建并发上限（2026-11-16 新增）**

```
名额上限 globalConcurrency（默认 3，配置校验要求 >= 1）
已占名额 = reservations/*.json 中 taskClass ∈ {heavy, medium, light} 的条目数
          （排队任务还没有台账，不占名额；phase=releasing 也算占用，宁可少放行一个）
放行 ⇔ 已占名额 < globalConcurrency
```

- 语义就是"最多 3 个构建"的那把锁：第 4 个构建**排队**，任一构建收尾时删除自己的台账
  （`releaseReservation`）即**自动释放名额**，不需要人工解锁；崩溃残留由
  `reclaimStaleReservations` 按"持有者已证明退出 + 子进程已证明结束"回收，证明不了就 fail-closed
  继续占名额（`doctor --reap` 处置）。
- 判定位置：`acquireAdmission()`（`scripts/sched/admission.mjs`）在 `.admission` 临界区内完成，
  与分类槽位共用同一把跨进程锁（5.7）——两个进程不可能同时认为"还剩最后一个名额"，
  也不会出现"先占槽位再发现名额不够"（拿到名额前不写台账，拒绝时无需回滚）。
- **dev 常驻服务不计入**：沿用第 8 节"dev 不占一次性构建锁"的契约，由 `devConcurrency` 单独限流。
  **dev 任务既不吃名额，也不被名额拒绝**（判定的 `applies=false`）——否则"3 个构建在跑"会顺带把
  `npm run tauri dev` 堵住，不是这条锁的本意。未纳管的 `npm run dev` 不占名额也不受任何准入约束
  （12 节限制 8）。
- 排队原因写进 `waitReason` / `queue` / `status`："全局构建并发已满（3/3）：正在运行 h-…(heavy)、…；
  任一构建结束会自动释放名额，按优先级排队即可"；`status` / `doctor` 有一行
  "全局构建并发 x/y 个构建在跑"（满额时 `status` 额外告警"已满，后续构建将排队"）。
- 准入证据：`history.jsonl` 的 `globalAtStart: { active, cap }` 记录准入那一刻在跑的构建数（**含本次**），
  可事后复核"有没有放出第 4 个"。
- 调大/调小：`build-sched.config.json` 或 `TASKDOCK_SCHED_GLOBAL_CONCURRENCY`；`0`/负数会被配置校验
  拒绝（不会静默变成"不限制"）。

**边界情况（实现必须逐条满足）**

1. 名额只按活动台账条目计数，不读任何内存读数（内存已不是准入维度）；
2. 名额满即排队；`waitReason` 只写名额/槽位/优先级原因，不再出现"预算不足/本机装不下"；
3. `globalConcurrency` 必须 >= 1，非法值被配置校验拒绝而不是当作"不限制"；
4. 台账只为**即将启动**的任务创建，排队任务不占名额；
5. 崩溃残留的回收条件：持有进程"已证明退出" **且** 记录的子进程"已证明结束"；子进程仍存活
   或身份 `unknown` → fail-closed 继续占名额（由 `doctor --reap` 用命令行签名取证处置）；
6. 名额与槽位在同一个临界区完成（5.7）：名额已满不会先占槽位卡住别人；槽位拿不到会回滚台账；
7. `detached` 且没有 childPid 的残留**不自动回收**（无法证明脱离控制台的子进程已退出）；
8. 释放台账校验 `(pid, 进程创建时间, nonce)`，PID 被系统复用也不会释放别人的名额；
9. Dev 常驻服务占 dev 槽位、**不占**全局构建并发名额；未纳管的 `npm run dev` 既不占槽位也不占名额，
   只能靠 `sched dev` 点名发现（12 节限制 8）。

### 4.3 排队与准入循环（每 `pollMs` 一轮）

1. `housekeeping`：归档提交进程已死的残留记录、清理过期终态记录；
2. 重新计算本任务的有效优先级与全局并发名额（约束 C）；
3. 槽位有空位 → 申请（见第 5 节）；槽位被占但"名额与优先级都没问题"→ 按 `reclaimProbeMs` 节流做一次
   **持有者是否已死**的取证，能做安全回收就回收；
4. 拿到槽位后**二次校验优先级**（避免低优先级抢在同刻入队的高优先级前面），有冲突就让出重排；
5. 名额不足或槽位已满 → 记 `queued`，把具体原因写进记录的 `waitReason` 并在终端打印
   （每 15s 复述一次，不静默）。

**跨分类不头阻塞**：重型在等槽位/名额时，轻量检查仍可跑，反之亦然——这是 16GB 机器上避免整体停滞的关键。

### 4.4 优先级与防饥饿

| 级别 | 语义 |
|---|---|
| P0 | 阻塞当前开发的关键验证（同时只应该有 1 个） |
| P1 | 常规构建（默认） |
| P2 | 集成测试 |
| P3 | 非紧急全量检查 |

排序键 = (有效优先级, 入队时间)。有效优先级 = `max(0, 基础优先级 - ⌊等待时长 / agingStepMs⌋)`，
默认每 5 分钟自动提升一级：P3 等待 15 分钟后就与 P0 同级，并凭"更早入队"先跑。
**同分类内**才比较优先级，跨分类互不影响。

## 5. 跨进程互斥原理
### 5.1 状态目录

```
<git-common-dir>/taskdock-build-sched/
├── slots/heavy-1/{owner.json,heartbeat}
├── slots/.admission/{owner.json,heartbeat}   准入临界区（毫秒级持有，见 5.7）
├── reservations/<taskId>.json                活动台账（占全局构建名额，见 5.7）
├── queue/<taskId>.json
├── cancel/<taskId>
├── logs/<taskId>.log
├── history.jsonl
├── reclaim-log.jsonl
└── config.json             (可选)
```

落点由 `git rev-parse --path-format=absolute --git-common-dir` 决定，实测在主干
（`D:/Develop/task_dock`）与任意 linked worktree 下**都返回同一个** `D:/Develop/task_dock/.git`，
所以不同 Worktree 天然竞争同一批槽位。放在 `.git/` 下的另一个好处：不受 `git clean`、
`git checkout`、切分支影响，也不会被误提交。`TASKDOCK_BUILD_SCHED_HOME` 可整体覆盖（验收测试
与隔离实验用）。

### 5.2 互斥原语：`mkdir` + 租约

- 申请槽位 = `mkdir slots/heavy-1`。NTFS 上 `mkdir` 对已存在目录返回 `EEXIST`，是**原子**的，
  没有"先检查再创建"的竞态（不依赖任何 sleep）；
- **槽位目录本身就是锁**：它从取到槽位那一刻存在，覆盖到子进程结束、退出码回填、槽位释放为止，
  不是"启动前打个标记就删"；
- 目录里 `owner.json` 记录持有者：`taskId`、`pid`、进程创建时间、nonce、开始时间、label、
  以及**子进程**的 pid/命令行/近似创建时间；`heartbeat` 每 3s 刷新一次（独立文件，写入代价极小）。

### 5.3 为什么不用「PID 是否存在」判定锁有效性

Windows 会复用 PID。`PID 1234 存活`不能证明"还是原来那个会话"。因此身份 = **(pid, 进程创建时间, 心跳)**：

- 进程不存在 → `gone`（可回收）；
- 存在但创建时间对得上 → `same`（**绝不回收**）；
- 无法取证（CIM 查询失败、记录缺创建时间）→ `unknown` → **fail-closed**：不回收，报出原因等人工/`doctor` 介入；
- 创建时间用 `process.uptime()` 反推（不查 PowerShell，省掉每次提交约 1 秒），比对时给 2s 容差。

### 5.4 安全回收契约（崩溃恢复的全部规则）

回收一个**非空槽位**必须同时满足：

1. **持有者已证明退出**（`gone`，或 `unknown` 但心跳停滞超过 `hungReclaimMs`=180s 的"挂起"判定）；
2. **它记录的子进程先被处置**：用命令行签名比对确认是调度器自己 spawn 的那个构建进程（
   去引号、统一斜杠、转小写、剥掉 `cmd.exe`/`chcp` 包装前缀后，与记录双向包含即视为同一目标），
   匹配才 `taskkill /T /F` 终止进程树；**任何一条证据缺失或对不上就拒绝终止**——宁可卡住等人介入，
   也绝不误杀其他会话的进程；
3. **回收动作本身只有一个赢家**：`rename(slotDir, «slotDir».reclaim-<nonce>)` 成功后立刻反注册，
   输的一方看到 `ENOENT` 就放弃，不会出现"两人同时回收同一把锁、各自以为自己独占"；
4. 回收过程写 `reclaim-log.jsonl`（谁、为什么、动了哪个 pid、结果），并把崩溃遗留的任务记录归档为
   `failed`（`recoveredBy: slot-reclaim`），使 `queue`/`history` 不再显示幽灵运行中任务。

**绝不按固定时间删锁**：心跳停滞只是"值得做一次取证"的触发条件，不是删除依据。

#### 5.4.1 后台自愈扫描（2026-11-15 新增）

原实现只在**竞争同一个槽位**时才做回收。于是崩溃留下的槽位会一直挂着：本机实测 `heavy-1` 挂了
16 分钟、`dev-1` 挂了 2.5 小时；更糟的是如果留下的是准入临界区 `slots/.admission`，**所有分类**连
"抢槽位"这一步都进不去，等待者只能干等到 `--wait-timeout`（默认 20 分钟）超时。

现在每次 `run` 的等待循环里每 ≤30s（含进程启动首轮）调用 `reapStaleSlots()`（`scripts/sched/lock.mjs`），
扫描 `slots/*` 与 `slots/.admission`，但只做**保守回收**：

| 条件 | 行为 |
|---|---|
| 心跳新鲜（< `leaseTtlMs`=45s） | 跳过，连取证都不做（CIM 是 200–400ms 的重操作） |
| 持有者身份 `unknown` | 不动（fail-closed） |
| 持有者已死 + 无子进程（或子进程已结束） | 回收（`rename` + 反注册，写 `reclaim-log.jsonl`） |
| 持有者已死但登记的构建子进程**仍存活** | **不回收、不终止**，报"留待竞争路径或 doctor --reap" |
| 持有者存活但心跳停滞 > `hungReclaimMs` | 后台扫描**不按挂起回收**；竞争路径/`doctor --reap` 才可处置 |

已有的竞争路径行为不变（它仍会在签名比对通过后终止孤儿构建进程树）。

### 5.5 Windows 控制台生命周期（实测结论，决定回收边界）

用探针实测（`node` 父进程 `Start-Process` 隐藏窗口启动子进程，杀父进程后观察子进程）：

| 子进程方式 | 父进程被强杀后 | 说明 |
|---|---|---|
| 常规 spawn（共享控制台） | **子进程随之退出** | 控制台关闭时同控制台进程收到 close 事件并被终止 |
| `detached: true` | **子进程继续运行** | 独立进程组/控制台 |

因此：

- 调度器崩溃/被杀时，常规构建子进程通常**跟着一起死**——危险窗口比想象中短；
- 真正需要孤儿回收的是**脱离控制台的守护型构建**（Gradle daemon、Tauri 应用、被工具自行
  `detach` 的进程，以及 `--detach-child` 构造的场景）；
- 这也解释了验收 4 为什么必须用 `--detach-child`：否则"父进程死了旧构建还在跑"这个前提在
  Windows 上根本构造不出来，测到的会是"子进程也死了"。

### 5.6 嵌套调用直通（避免自锁）

`src-tauri/tauri.conf.json` 的 `beforeBuildCommand` 是 `npm run build`，而 `npm run tauri`
本身已进调度器。内层若再排队，就会"自己等自己"直到超时。因此调度器在环境变量里标记
`TASKDOCK_SCHED_TASK_ID`，检测到自己**已在某个调度任务内部**时，内层命令**直通执行**
（输出直连终端、退出码原样返回、不再排队），外层任务的资源账已经覆盖它。

### 5.7 准入原子性：活动台账与分类槽位在同一临界区

「先占槽位、再发现名额已满」会卡死槽位；「先查名额、再慢慢抢槽位」会让两个进程都以为自己拿到了
最后一个名额。因此准入是一次**跨进程原子事务**，临界区就是 `slots/.admission`（同样是 `mkdir`
原子性 + 租约，复用 5.2 那套机制，不另造锁体系）：

```
① mkdir slots/.admission ── 拿不到 → 本轮放弃，下一 pollMs 再试（非阻塞，不等待阻塞式锁）
② 回收崩溃残留台账（只做便宜的存活性判断；证明不了就不动，fail-closed）
③ 读 reservations/*.json 计数 heavy/medium/light 条目，按 4.2 约束 C 判定全局名额
④ 名额已满 → 立刻退出临界区，**不碰槽位**
⑤ 写 reservations/<taskId>.json（写入失败 → 退出，不碰槽位）
⑥ 逐个 mkdir slots/<class>-<n>；拿到 → 提交；拿不到 → 回滚 ⑤ 的台账
⑦ 释放临界区
```

`reservations/<taskId>.json` 字段：

| 字段 | 含义 |
|---|---|
| `taskId` / `taskClass` | 谁、哪一类（用于统计全局构建名额，不再有任何内存估算） |
| `ownerPid` / `ownerStartTime` / `ownerStartTimeSource` | 提交进程身份（PID 复用防护） |
| `nonce` | 释放/回滚时的所有权凭据 |
| `childPid` / `childCmdSignature` | 真实构建子进程身份（命令行签名用于取证比对） |
| `detached` | 子进程是否脱离控制台（决定崩溃后能否自动回收） |
| `heartbeatAt` / `createdAt` / `phase` | 心跳、创建时间、`queued\|starting\|running\|releasing` |

- **释放**：校验 `(ownerPid, ownerStartTime, nonce)` 全部相符才删文件——PID 复用不会释放别人的台账；
- **崩溃回收**：持有进程必须"已证明退出"，且 `childPid` 已不存在，才回收。`childPid` 尚未登记
  （崩在 spawn 与登记之间）时，额外要求 `detached !== true` 且没有该进程的存活子进程，并等待
  `reservationOrphanGraceMs`（默认 180s）；任一条不满足就**继续占用**，把原因写进 `doctor`；
- **不做的事**：不按固定时间删台账、不因为心跳停滞就假定持有者已死、不自动处置 `detached`
  的孤儿（这些交给 `doctor --reap` 的签名取证）；
- 台账在 `.git` 公共目录下，**多 Worktree / 多会话共享同一份**，无中央守护进程。

## 6. 队列与状态机

状态：`queued` → `running` → `succeeded` / `failed` / `cancelled`；`waiting_resources` 仅作为
**历史记录兼容状态**保留（2026-11-16 删除内存预算后不再产生新记录，等待统一显示为 `queued`）。

- **跨进程并发安全**：每条记录一个 JSON 文件，写入走 `tmp + fsync + rename` 原子替换；
  多个进程只写自己的记录，**不写别人的**；历史是 append-only 的 `jsonl`，超 2×上限时压缩（不无限增长）。
  Windows 上 `rename` 覆盖"正被其他进程打开"的文件会返回 `EPERM/EBUSY`（杀软、索引、
  另一个调度进程在同时读这条记录都会触发），因此替换做了退避重试（累计约 2 s），仍失败则退化为
  原地覆盖写——宁可短暂失去原子性，也不让状态写不进去（读方本来就把半写文件当"记录不存在"，
  下一轮轮询会重写）。
- **提交进程退出不留永久任务**：任一轮 `housekeeping` 会发现"心跳过期（> leaseTtl）且进程已退出"的
  活跃记录，排队中的归档 `cancelled`，运行中的（且槽位已不再由它持有）归档 `failed`；
  `doctor --reap` 可立即清理。
- **等待期不阻塞智能体**：提交进程就是等待者本身；等待期间用户/智能体可以继续做别的（读代码、
  写文档、改别的模块）。想要"提交后立刻干别的事"，用 `--wait-timeout 0` + 后台终端，或直接
  `Start-Process` 一个后台任务。
- **失败可诊断**：每条失败都带 `status/exit/reason` 与日志路径；`waitReason` 写明具体原因与当前占用
  （例如 `全局构建并发已满（3/3）：正在运行 h-…(heavy)、m-…(medium)、l-…(light)`）。
  从未启动的任务（等待超时/被取消）没有子进程输出，调度器会在收尾时补写一份摘要日志，避免
  `history` 给出的日志路径指向不存在的文件。

## 7. 去重（结果共享）的边界

等价判定 = 以下全部逐字节/逐项相同：命令 argv、工作区绝对路径（小写）、相关环境变量
（`CARGO_TARGET_DIR`、`CARGO_BUILD_JOBS`、`RUSTFLAGS`、`NODE_ENV`、`CI` 等）、
`package.json`/`package-lock.json`/`Cargo.toml`/`Cargo.lock`/`rust-toolchain.toml`/`vite.config.ts`/
`tsconfig.json`/`build-sched.config.json` 的内容哈希、`git HEAD`、`git status`（含未跟踪文件）内容哈希、
`cargo`/`rustc`/`node` 版本。

**只附加到"正在运行、且提交进程仍存活"的等价任务**，且共享其真实退出码与日志路径；
**从不复用已结束的历史结果**——"构建产物是否仍然有效"无法证明，宁可不复用。

因此：两个会话同时提交 `npm run build` 只跑一次；一旦任一方改了源码/依赖/参数/工具链，
指纹立刻不同，各自执行。`--no-dedupe` 可强制不复用。

## 8. 开发服务器与缓存

- 常驻 dev 服务器**不占**一次性构建锁，也**不占**全局构建并发名额（`globalConcurrency` 只统计
  heavy/medium/light），只用 `dev` 槽位（并发 2）限流；
- `sched dev` 只读盘点：重复 Vite、端口冲突、同工作区多实例、dev 与重型 cargo 并发；
  **不同 Worktree 不允许共用同一 dev 端口**（那是"错误共享不兼容服务"，findings 会点名）；
- Cargo target 目录策略不变：共享 target 靠文件锁串行（本来就安全），隔离时用绝对路径
  `CARGO_TARGET_DIR` 指向 `src-tauri/target-<task>` 并 `build-guard register`，**不要**
  为"让构建干净"随手 `cargo clean`（`build-guard` 的归属标记就是为防误删他人缓存）；
- sccache：本次**未评估/未启用**（未实测收益，且要先保证互斥与准入生效），见验收报告"下一阶段优化"。

## 9. 与既有工具的关系

| 既有设施 | 关系 |
|---|---|
| `scripts/build-guard.mjs`（磁盘/缓存守卫） | **复用**：`run` 前跑同一套 `precheck` 阈值（exit 2 → 调度器 exit 6）；缓存回收仍由它的 `cleanup` 负责 |
| `scripts/worktree-guard.mjs` | 不变。它管"目录与冲突"，本调度器管"构建并发与槽位"，互不替代 |
| `scripts/watch-dev-processes.ps1` | 不变（观察/窄条件终止）。`sched dev` 是它的只读替代视图，不做终止 |
| `scripts/perf/gate-run.sh` | **已接入（2026-11-15）**：所有门禁步经 `run`/`cargo` 子命令排队；cargo 步改用 `cargo` 子命令（`cwd=src-tauri/`，不再用 `--manifest-path`）。`GATE_DRY_RUN=1` 零资源核对路由，`GATE_NO_SCHED=1` 仅在调度器故障时排障用 |
| `AGENTS.md` §3.4/§5 | 已增补"高资源构建统一入口"与"子智能体同规则"，细节指向本文档 |

## 10. 配置

优先级（后者覆盖前者）：内置默认值 → 仓库根 `build-sched.config.json` → 状态目录 `config.json`
→ 环境变量 `TASKDOCK_SCHED_<UPPER_SNAKE>`。未知字段与非法数值会被**拒绝并报错**（不静默忽略）。

| 键 | 默认 | 说明 |
|---|---|---|
| `heavyConcurrency` / `mediumConcurrency` / `lightConcurrency` / `devConcurrency` | 1 / 1 / 2 / 2 | 槽位数 |
| `globalConcurrency` | 3 | **全局构建并发上限（约束 C，2026-11-16）**：heavy/medium/light 同时在跑的构建不超过该值，第 N+1 个排队，任一结束自动释放名额；dev 常驻服务不计入（由 `devConcurrency` 单独限流）。必须 >= 1 |
| `pollMs` | 1000 | 准入轮询间隔 |
| `heartbeatMs` / `leaseTtlMs` / `reclaimProbeMs` / `hungReclaimMs` | 3000 / 45000 / 3000 / 180000 | 心跳、租约过期、取证节流、挂起判定 |
| `cargoJobs` | 2 | cargo 编译并行度（16GB 机器上的保守值） |
| `defaultWaitTimeoutMin` / `defaultRunTimeoutMin` | 20 / 0 | 默认等待/运行上限 |
| `agingStepMs` | 300000 | 老化台阶（5 分钟升一级） |
| `logMaxMb` / `historyMaxEntries` / `finishedRetentionMs` | 32 / 500 / 60000 | 日志上限、历史上限、终态记录保留 |
| `reservationOrphanGraceMs` | 180000 | 崩溃残留台账"无 childPid"时的回收宽限（有 childPid 时按子进程是否存活判定） |
| `diskPrecheck` | true | 复用 build-guard 的磁盘预检 |
| `dedupe` | true | 等价任务合并 |

调优建议（16GB 机器）：真正需要调的只有全局并发（`globalConcurrency`，默认 3）与各分类槽位；
内存既不是准入门槛也不是记账对象，`status`/`history` 也不再采集内存读数。若构建因内存不足失败，
按 11 节"运行期 OOM"处理（局部检查、降低 `cargoJobs`、等机器空闲），不要指望调度器替你把内存挡住。

> **历史记录说明**：10.1–10.6 是 2026-11-15 至 2026-11-16 的决策与实测记录；其中**内存门槛**与
> **全局预算 / 危险授权**相关字段、配置、展示，已于 2026-11-16 按用户要求整体删除（见 10.7）。
> 这些段落保留原文仅用于追溯，不再代表当前行为；当前规则以 4.2 与 10.7 为准。

### 10.1 2026-11-15 本机覆盖：取消"静态分类下限"，改为按预计峰值准入（**已被 10.5 取代**）

现象：本机 16 GB 中约 13 GB 被其他程序长期占用，可用长期只有 1–2 GB；而 `light` 类（tsc /
vitest / `node --test`，实际峰值约 0.8–1 GB）因"分类下限 2560 + 滞回 1024"被要求 3.56 GB，
连只需要 1–2 GB 的检查也无法启动。

处置（**本机覆盖，写入状态目录 `config.json`，不入库**；仓库默认值不变）：

```json
{ "heavyMinAvailMb": 3072, "mediumMinAvailMb": 1536,
  "lightMinAvailMb": 1024, "hysteresisMb": 256, "estimateMediumMb": 2400 }
```

效果（约束 A 的实际门槛 = `max(分类下限, 预计峰值) + 滞回`）：

| 类 | 旧门槛 | 新门槛 | 说明 |
|---|---|---|---|
| light | 3.56 GB | **1.28 GB** | 只做 fs 只读/单测，1.3 GB 空闲即可跑 |
| medium | 5.00 GB | **2.66 GB** | `vite build`/`cargo check`，按 2.34 GB 峰值 + 256 MB 余量 |
| heavy | 7.00 GB | **6.26 GB** | 完整编译/打包，仍按 6000 MB 峰值 |

**没有关闭准入**：静态下限被压到接近零（1–3 GB），但每个任务仍按自己的预计峰值准入，且约束 B
（全局预算 12.63 GB）不变。这样"1–2 GB 的检查"能跑，"6 GB 的编译"不会在 1 GB 空闲时被放进来把
机器打到 OOM。若某类任务实测峰值更低，用 `history` 的 `minAvailMb` 作依据再调 `estimate*Mb`；
个别任务可用 `--estimate-mb` 单独指定。

副作用与回退：本机 `config.json` 删除即回到仓库默认（门槛 6144/4096/2560、滞回 1024、
`estimateMediumMb` 3000）。改动后 `node --test scripts/build-sched.test.mjs` **27/27 通过**。

**同日实测补充（重要，别把上限当成"没有门槛"）**：

| 任务 | 实测 | 结论 |
|---|---|---|
| `tsc --noEmit`（`--estimate-mb 1200`，P0，空闲 1.3–1.5 GB） | **exit 0，24 s 通过** | 1–2 GB 级检查在低压下确实能跑，这就是本次调低门槛的目的 |
| `vitest run` 4 文件（light，空闲 ~1 GB） | **exit 0，63 测试通过，37 s** | 同上 |
| `cargo check --tests`（estimate 2400，空闲 3.07 GB 时准入） | **exit 101**：`memory allocation of 2097152 bytes failed` + `STATUS_STACK_BUFFER_OVERRUN` | **不是代码错误，是 rustc 被 OOM 打断**。本仓库 `cargo check --tests` 实测峰值 > 3 GB |

由此定的口径（本机）：
- 静态下限压到近零只对"小于 2 GB 的检查"有意义；**编译类任务仍必须按自己的真实峰值准入**，
  否则就是把 OOM 当成"构建失败"来浪费 10 分钟。
- `cargo check` / `cargo check --tests` 本机实测需要 **≥5 GB 空闲**，用 `--estimate-mb 5200`
  显式声明，不再借用 `estimateMediumMb=2400`。等 `history` 里积累到成功的 `minAvailMb`
  再回调这个值。

### 10.2 危险授权与配置风险（2026-11-15 第三轮；**2026-11-16 已随预算整体删除**）

**为什么有这一层**：2026-11-15 19:22 本机 `config.json` 被外部会话改成
`budgetEnabled=false` + 各类门槛/估算 1 MB，`status` 一度显示"全局预算：已关闭"，且已有 heavy 任务
在这套被关闭的门槛下开跑。配置文件一行 `false` 就能静默让整个跨分类预算失效，属于安全边界缺陷，
因此把"削弱安全边界"的动作统一收进**一个显式、可审计的危险授权**，而不是散落成多个开关。

**唯一入口**：环境变量 `TASKDOCK_SCHED_DANGER_AUTH`，逗号/竖线/空白分隔，大小写不敏感，只认三个令牌：

| 令牌 | 允许的事 | 未持令牌时 |
|---|---|---|
| `budget-off` | 真正关闭跨分类全局预算（`budgetEnabled=false`） | 配置里的 `false` 被**忽略**、强制 `true`，并写 problem + P1 风险 |
| `reserve-breach` | 允许 `allowReserveBreach=true` 突破系统保留 | 强制 `false` |
| `reserve-lower` | 允许 `systemReserveMb` 低于 `recommendedSystemReserveMb`（含 0） | 有效值**回到 `recommendedSystemReserveMb` 基线**（不写回配置文件） |

要点：

- **只对当前进程/当次任务有效**，不写回任何配置文件；不带该变量的后续任务自动回到安全边界。
- `status` 新增三行：「⚠ 预算关闭依据 / 安全余量被下调 … 减少 X MB / 配置来源」；`--json` 增加
  `danger`（`tokens`、`budgetOffRequested/Authorized`、`reserveLowerRequested/Authorized`、
  `reserveBreachRequested/Authorized`）、`configSources`、`configRisks`。
- `doctor` 把 `configRisks` 逐条列出（当前值 / 默认或基线值 / 覆盖来源 / 原因 / 是否影响运行中任务）；
  存在 **P0**（配置不可读、预算被关、门槛低于安全下限）时退出码 **5**（`EXIT.internal`），
  仅 P1 风险时仍为 0 但会打印。
- `history` 的 `budgetAtStart` 带 `budgetEnabled`、`budgetOffAuthorized`、`dangerAuth`、
  `reserveBaselineMb`、`reserveReducedMb`、`configSources`：**事后可判断某次任务是否在关预算/降保留
  的授权下准入**，不会与正常调度混为一谈。
- 安全下限 `SANITY_FLOORS`：estimateHeavy≥2000、estimateMedium≥600、estimateLight≥200、
  systemReserve≥0（低于 0 非法）；低于即 P1/P0（2026-11-15 晚：内存门槛相关下限随功能一并删除）。
- 未知字段、坏 JSON 也会被 `doctor` 点名（P1/P0），不再静默忽略。

**本机覆盖的事实记录（2026-11-15 第三轮 `status --json` 实测）**：状态目录实际为
`heavyMinAvailMb 3072 / mediumMinAvailMb 512 / lightMinAvailMb 256 / hysteresisMb 128 /
estimateMediumMb 2400`，`systemReserveMb=3072`、`recommendedSystemReserveMb=3072`。与 10.1 的
2026-11-15 第二轮快照（1536/1024/256/estimate 2400）不一致，以本节实测为准；10.1 保留为历史记录不改写。

### 10.3 2026-11-15 本机覆盖：关闭约束 A（实时可用内存门槛），保留排队与预算（**已被 10.5 取代**）

用户诉求（连续第三轮）：**不要按"当前可用内存"拦人**，但要**保留排队**——1–2 GB 的检查不该因为
"分类下限 / 固定峰值"被 4–6 GB 的门槛挡住，同时也不希望退化成"谁都能同时起构建"。

为什么前两轮"删门槛"没生效（事实记录，避免再次误判）：

- 10.1 的覆盖只压低了**分类下限**，而实际门槛是 `max(分类下限, 预计峰值) + 滞回`；
  `estimateHeavyMb=6000` 从未被改，所以 heavy 门槛一直 ≈ 6 GB（本轮 `status` 实测 5.98 GB）。
- 机器覆盖文件 `config.json` 在 10.2 之后**仍然存在**（创建 19:21:40、改写 19:31:56），
  "删掉文件"这一步没有落到当前状态目录上；即使删掉，也只会回到仓库默认（门槛更高）。

本轮处置（新增**一等公民开关**，不再靠改阈值糊弄）：

- `scripts/sched/config.mjs` 新增布尔字段 `memoryAdmissionEnabled`（默认 `true`，仓库默认不变）。
- `scripts/sched/mem.mjs` `evaluateMemoryAdmission()` 在该字段为 `false` 时直接放行，
  返回 `bypassed: true`、`floorMb: 0`，原因写明"内存准入门槛已关闭"。
- **仍然生效的**：分类槽位并发（heavy/medium/light/dev）、优先级 + 老化排队、
  跨分类全局预算（`totalMb - systemReserveMb`，本机 12.63 GB）。
- `pressureLevel()` 在该字段为 `false` 时返回 `level="disabled"`，`status` 的"压力"行不再
  声称"新任务全部等待"；`status` 额外打印一行 ⚠ 与 `内存准入=已关闭`；槽位/策略的门槛列显示
  "关闭"；`configRisks()` 记一条 **P1**（`memoryAdmissionEnabled`），`doctor` 会列出。

本机 `config.json` 现在**只有这一个键**（10.1/10.2 记录的阈值覆盖已一并移除，避免"看起来像偷偷
调低阈值"）：

```json
{ "memoryAdmissionEnabled": false }
```

风险与依据（不掩盖）：

- 约束 A 存在的理由见 10.1 的实测：`cargo check --tests` 在 3.07 GB 空闲时 **exit 101
  （rustc OOM）**。关闭后这类任务在低内存下会直接开跑，可能得到"内存分配失败"的假失败，
  或拖慢系统；本机 16 GB 中长期被其他程序占住 10 GB 以上。
- 因此口径仍是：**编译类任务建议照实声明 `--estimate-mb`**（如 5200），让全局预算的预留台账
  与等待原因保持真实；`history` 里的 `budgetAtStart` 仍能看出是否在关闭状态下准入。

回退：删除 `config.json`（或把该键改回 `true`）即恢复约束 A，仓库默认行为不受影响。
单测：`node --test scripts/build-sched.test.mjs` 覆盖"关闭后放行 / 默认仍拦截 / 风险项可见"。

### 10.4 2026-11-15 事故复盘：没有构建在跑，队列却一直等（槽位不自愈）

**现象**：当日 13:26–14:11，多会话同时报"medium 槽位已满（1/1）"并等待到超时（`history` 实测
wait 896s / 1433s / 1486s 后 `提交进程已退出` / `调度进程已退出`），但 `status` 里**没有任何子进程在跑**。

**根因**（四层叠加）：

1. 单槽位串行被一个超长任务占满：`cargo test -j 1 --lib file_workspace` 跑了 **781s**，
   并在最低可用 **95 MB** 时 exit 101（rustc/测试 OOM）。这一条就足够让后续 6–8 个 medium 任务排队。
2. 它挂了以后**槽位不释放**：调度进程 PID 21864 随之消失，`medium-1` 目录留成僵尸；
   后来者看到的就是"槽位已满"，明明没人在构建。
3. 回收**只在有人抢同一个槽位时**发生。没人抢就一直挂着：`heavy-1`（13:52 启动的 apk-release，
   PID 62040 + gradle 48132 在 9 秒内双双死亡）挂了 16 分钟；`dev-1`（08:32 启动的 vite，
   PID 22024 + 28060 早已消失）挂了 2.5 小时。
4. 取证失败即 fail-closed：`history` 里留下 `无法确认进程身份（PID 62040 存在，但无法读取创建时间
   （CIM 查询失败））`——这种"证据不足"会一路卡到超时，没有任何自我恢复路径。

**修复**（`scripts/sched/lock.mjs` / `scripts/sched/runner.mjs` / `scripts/sched/proc.mjs`）：

- `reapStaleSlots()`（5.4.1）：等待循环每 ≤30s 扫描槽位与 `slots/.admission`，只回收
  "持有者已死 + 子进程已结束"的；子进程仍活着一律不动、不杀；`unknown` 不动；挂起不按回收。
- `tryReclaim()` 增加 `allowHungReclaim` / `allowChildKill` 两个开关，把"竞争路径可杀、后台扫描不杀"
  这条边界写进代码，而不是靠调用方自觉。
- `probeProcess()` 在 CIM 失败或读不到 `StartTime` 时回退 `Get-Process`：能拿到创建时间就仍可排除
  PID 复用；拿不到仍是 `unknown`。"不存在"的结论永远只由 `isPidAlive()` 给出。
- `doctor --reap` 在本次事后清理中实际回收了 `dev-1` / `heavy-1` 两具僵尸槽位（4 个 PID 全部确认
  不存在后才动手）。

**验证**：单测 `node --test scripts/build-sched.test.mjs` **47/47**（新增 2 例：回收/不回收边界，
含 `.admission`）；跨进程验收 `scripts/build-sched-acceptance.test.mjs` **41/41**（含崩溃恢复、
孤儿构建进程树回收的原有断言未放宽）。另外用隔离状态目录（`TASKDOCK_BUILD_SCHED_HOME`）做了两次
真机端到端取证：

- 造一个"持有者已死、无子进程"的 `dev-1` 槽位 → 新任务首轮扫描输出
  `后台扫描：回收槽位 dev-1（持有者已退出…）`，槽位目录消失；
- 造一个"持有者已死、但登记的构建子进程仍在运行"的 `dev-1` 槽位 → 输出
  `后台扫描：槽位 dev-1 暂不回收——…构建子进程 PID … 仍存活…`，槽位保留、子进程未被终止。

### 10.5 2026-11-15 删除实时可用内存门槛（约束 A 整体移除；其中保留的预算已于 2026-11-16 删除）

**决定**：用户在 10.3 之后再次明确要求"把门槛给我删了"。10.3 的"总闸开关"只是旁路，配置/状态/代码
里仍留着一整套门槛字段与展示；本次直接**删除**，不留开关。

**删除的东西**：

- `scripts/sched/config.mjs`：删掉 `memoryAdmissionEnabled`、`heavyMinAvailMb`、`mediumMinAvailMb`、
  `lightMinAvailMb`、`hysteresisMb`、`safetyReserveMb` 六个键（以及对应的 `SANITY_FLOORS`、
  滞回一致性校验、`configRisks` 的"门槛被关闭/被改小"条目）。写到配置里的这些字段现在会作为
  **未知字段**被拒绝（P1），不会静默生效——防止门槛以任何形式悄悄回来。
- `scripts/sched/mem.mjs`：删掉 `evaluateMemoryAdmission()`、`memoryFloorForClass()`、
  `pressureLevel()`、`isMemoryAdmissionEnabled()`；保留内存采样（写 `status` / `history`）。
- `scripts/sched/queue.mjs`：`evaluateEligibility()` 只剩槽位、预算、优先级三类阻塞；
  `statusLabel()` 只看 `lastBudgetOk`。
- `scripts/sched/runner.mjs`：等待循环不再有"内存不足 → waiting_resources"分支，不再需要
  `memoryWaitSeen` / `lastMemoryOk`。
- `scripts/build-sched.mjs`：`status` 去掉"压力"行、门槛列、"内存准入=已关闭"告警；内存行注明
  "仅展示，不参与准入"；`config`/`doctor` 自动不再出现这些键。
- 本机状态目录 `config.json`（内容只有 `{"memoryAdmissionEnabled": false}`）**已删除**，状态目录
  现在没有任何覆盖配置（`配置来源：内置默认值`）。

**保留的东西（用户明确要求保留排队）**：分类槽位并发（heavy/medium 各 1、light/dev 各 2）、
P0–P3 优先级 + 老化、等价任务去重、跨分类全局预算（本机硬上限 12.63 GB）。

**后果（如实记录）**：可用内存不足不再让任务等待；低内存下重型编译会照常启动，可能以
`exit 101`（rustc/cargo OOM）失败，或让机器变慢。这是用户的选择；槽位并发与预算仍限制同时
运行的构建数量。若某次构建 OOM，按 11 节"运行期 OOM"处理（局部检查/降低 `cargoJobs`/等空闲）。

**验证**：单测 `node --test scripts/build-sched.test.mjs` **42/42**（删除 5 组门槛用例，
新增"已删除字段必须报未知字段"的回归守卫）；跨进程验收
`node --test scripts/build-sched-acceptance.test.mjs` **41/41**。真机 `sched:status` 输出 6 个槽位
全 free、无门槛列，`config` 不再列出任何门槛字段。

**回退**：改动未提交（工作区可 `git diff` 复核）；需要恢复时从 git 历史取回上述文件即可，
本机无需再写任何 `config.json`。

### 10.6 2026-11-16 新增全局构建并发上限 3（约束 C）

> 本节为加入并发锁时的记录；其中提到的 `scripts/sched/budget.mjs` 已在同日第二轮删除预算时
> 精简为 `scripts/sched/admission.mjs`，`budgetSnapshot().global` 相应改为
> `admissionSnapshot().global`（见 10.7）。判定逻辑与边界未变。

**需求**（用户原话）："加一个锁最多三个构建，之后的构建需要排队，构建完自动释放位置。"

**实现选择：不新建第二套锁。** 名额计数直接复用既有的 `reservations/*.json` 台账，判定放在
`acquireAdmission()` 的 `.admission` 临界区里（预算判定之后、写预留之前）。理由：
① 预留与槽位已经在同一临界区完成（5.7），再引入一把独立锁只会多一个"锁与台账不同步"的故障源；
② "构建结束"本来就以删除预留为收尾动作，名额归还是**既有退出路径的一部分**，不需要额外的解锁调用，
   取消/超时/崩溃都走同一条收尾逻辑；
③ 排队任务不写预留，因此"名额 = 真正在跑/正在启动的构建"，不会因为排队人多把自己饿死。

**落点**：`scripts/sched/config.mjs`（`globalConcurrency`，默认 3）、`scripts/sched/budget.mjs`
（`planGlobalConcurrency()` + `acquireAdmission` 的约束 C 分支 + `budgetSnapshot().global`）、
`scripts/sched/queue.mjs`（`evaluateEligibility` 增加 `capBlockers`/`capBlocked`）、
`scripts/sched/runner.mjs`（`globalAtStart` 证据、名额满时也做残留预留取证）、
`scripts/build-sched.mjs`（`status`/`doctor`/`queue` 展示）。

**边界**：dev 常驻服务不占名额（沿用"dev 不占一次性构建锁"）；未纳管进程不受约束；崩溃残留预留
fail-closed 占名额，需要 `doctor --reap` 或等取证回收；`globalConcurrency` 非法值（0/负数）由配置
校验拒绝，不会静默变成不限制。

**验证**：`node --test scripts/build-sched.test.mjs` **48/48**（新增 5 例：分类口径守卫、
计数/dev 不计入/重入、dev 请求不被拒、配置校验、第 4 个的等待原因）；跨进程 `验收12`
（heavy+medium+light 各 1 个 + 第 4 个 light：任意时刻 `maxOverlap=3`、第 4 个在名额满时不启动、
有构建结束后自动启动、结束后 `slots` 与 `reservations` 均清空、每个任务的
`globalAtStart.active <= 3`），连跑 4 次稳定通过。全量跨进程套件 **42/42**。

### 10.7 2026-11-16 删除按物理内存估算的全局预算（约束 B 整体移除）

**需求**（用户原话）："把这个按内存的调度器删掉"，澄清后明确选择：**保留 3 并发锁（约束 C），
删除内存准入（约束 B）**；明确否决"整个调度器删掉"与"换成独立 3 并发锁"。

**删除的东西**：
- `scripts/sched/budget.mjs`：整体删除（`computeBudget` / `budgetWarning` / `planAdmission` /
  `sumReserved` / `maxEstimateMb` / `budgetSnapshot` / `planGlobalConcurrency` 等）。
- `scripts/sched/mem.mjs`：整体删除（物理内存探测、采样、压力等级、展示格式化）。
- `scripts/sched/config.mjs`：删掉 `budgetEnabled`、`systemReserveMb`、`recommendedSystemReserveMb`、
  `allowReserveBreach`、`estimateHeavyMb/MediumMb/LightMb`、`memorySampleMs`；删掉
  `DANGER_AUTH_ENV` / `DANGER_TOKENS` / `parseDangerTokens` / `SANITY_FLOORS` 及 `loadConfig` 的
  危险授权段；`configRisks` 只保留"配置不可读 / 环境变量覆盖 / 未知字段"三类；`concurrencyForClass`
  从 `mem.mjs` 迁入。
- `scripts/sched/queue.mjs`：`evaluateEligibility({home,task,tasks,cfg})` 不再接收 `mem`，阻塞维度
  只剩槽位、全局并发、优先级；`statusLabel` 只产出 `queued`/`running`。
- `scripts/sched/runner.mjs`：去掉预计峰值、内存采样器、`budgetAtStart`、`memDuringWait` /
  `memDuringRun`；`worthProbing` 只看 `slotOnlyBlocked || capBlocked`。
- `scripts/build-sched.mjs`：去掉 `--estimate-mb`、`status`/`history` 的内存与预算展示、
  `doctor` 的预算检查；`status --json` 用 `admission` 替代 `budget`/`memory`；`config` 不再打印
  危险授权。
- 台账：`reservations/*.json` 不再有 `reservedMb`，只作为"谁占了一个全局构建名额"的活动台账；
  崩溃回收、心跳、身份校验、`phase` 语义不变。

**保留的东西**：排队、P0–P3 + 老化、分类槽位（heavy 1 / medium 1 / light 2 / dev 2）、
`globalConcurrency=3`、等价任务去重、取消、等待/运行超时、崩溃残留槽位与台账安全回收、
`sched` 各命令、`apps/mobile` 入口包装。

**兼容性**：机器状态目录 `<git-common-dir>/taskdock-build-sched/config.json` 与仓库
`build-sched.config.json` 均不存在，因此没有旧配置需要迁移；若他机配置里仍写上述已删除字段，
`loadConfig` 会按"未知字段"报 P1 并拒绝（不会静默生效）。`status --json` 的 `budget`/`memory`
键消失，改用 `admission`；`history.jsonl` 旧条目里的预算字段保留原样（append-only，不重写历史）。

**行为后果**：内存不再拦人也不再有"本机装不下"的不可准入判定；低内存下重型构建照常启动，
可能以 `exit 101`（rustc/cargo OOM）失败。并发上限仍把 heavy/medium/light 的同时构建限制在 3 个，
所以"三个重活一起把机器打爆"仍受约束，但 3 个重型叠加不再被内存预算额外挡住。

**验证**（2026-11-16，本机）：
- 单测 `node --test scripts/build-sched.test.mjs`：**34/34 通过**（约 3s；48→34，删除预算公式/
  档位/超卖/allowReserveBreach/配置安全共 14 例，改写全局并发、配置未知字段、台账、崩溃回收用例，
  导入改为 `admission.mjs`）。
- 跨进程 `node --test scripts/build-sched-acceptance.test.mjs`：**19/19 通过**（约 71s；
  42→19，删除预算 1–12、补充B1–B3、配置安全 1–7 与"验收3 内存 3GB"，重写"验收10 等待超时"
  为占满两个 light 槽位制造排队，"验收12"去掉 `--estimate-mb` 并保留 3 并发锁验证）。
- 真机：`node scripts/build-sched.mjs config` 只剩非内存配置（`globalConcurrency 3` 等）；
  `status` 显示"全局构建并发：1/3""活动台账：2 条"，正在跑的其他会话任务未受影响。

**回退**：本次改动未提交（工作区 `git diff` 可复核）；需要恢复时从 git 历史取回
`scripts/sched/budget.mjs`、`scripts/sched/mem.mjs` 及相关调用即可。本机无旧配置文件需要恢复。

## 11. 故障处理手册

| 症状 | 处置 |
|---|---|
| 一直 `queued` | `status` 看谁在跑、槽位/全局名额占用；`queue` 看前面有谁。属正常排队，别绕过 |
| `status` 显示槽位被占、但根本没有构建在跑 | 后台自愈扫描（5.4.1）会在 ≤30s 内回收"持有者已死 + 子进程已结束"的槽位；仍不回收说明子进程或持有者无法证明死亡，用 `doctor` 看原因、`doctor --reap` 处置 |
| `exit=3` 且 reason 含「槽位」/「全局构建并发已满」 | 正常排队：等前面的构建收尾会自动释放；急事可用更高优先级，或把任务拆小；不要绕过调度器 |
| `exit=101` / `memory allocation ... failed`（rustc/cargo） | 内存已不再参与准入，这是**运行期 OOM**：改用局部检查（单 crate `cargo check`）、降低 `cargoJobs`，或等机器空闲再跑；不要把它当代码错误 |
| `exit=3` 且 reason 含「超时」 | 任务太长：拆小（`cargo check` → 单 crate 检查），或用 `--wait-timeout 0` 并放后台 |
| 任务一直不结束但槽位显示被某 pid 持有 | `status --verbose` 看身份校验；确认那是**活着**的构建就等着；确认已死则 `doctor --reap` |
| 怀疑被别人的构建拖垮 | `status` 看活动台账与全局并发；`sched dev` 看常驻服务。**不要**自行杀别人进程 |
| `doctor` 报 P2「提交进程已退出」 | `doctor --reap`（只清理已证明死亡的残留） |
| 怀疑磁盘满导致失败 | `npm run guard:report`；调度器 `exit=6` 就是磁盘预检拦住的 |
| 失败任务给的日志路径是空的/只有几行 `#` 注释 | 这是"从未启动"的任务：收尾时调度器会补写摘要（status/exit/reason/waitMs）。看 `reason` 判断是槽位/名额排队超时还是运行超时 |
| 机器极慢时偶发"记录读不到/状态没更新" | Windows 上 `rename` 覆盖被占用文件会返回 `EPERM/EBUSY`；写入已做退避重试（约 2 s）并在耗尽后退化为原地覆盖写，不需要人工干预；若持续出现则用 `doctor` 查是否有进程长期占着 `state/queue` |
| `cancel` 返回 0 但任务其实还在跑 | 只有"身份取证 + 记录静默 ≥15 s"才会被 CLI 直接收尾；若提交进程真的活着，它会在下一轮轮询按退出码 4 结束。用 `queue`/`history` 复核状态，不要手动删 `state/cancel/` 标记 |

## 12. 已知限制（有意不做的事）

1. **不做常驻服务/守护进程**：没有中央队列服务，谁提交谁等待，所以"提交后进程退出"的任务不会被执行
   ——这是刻意取舍（低资源占用、无单点故障），需要长任务时用后台终端。
2. **不跨机器**：槽位活在本地 `.git` 目录，多机并行不在覆盖范围。
3. **不替代真正的构建缓存**：去重只共享"正在跑的同一次构建"，不做产物缓存（sccache/增量策略未评估）。
4. **不做 dev 服务器的自动复用/重启**：`sched dev` 只盘点+报告，动手仍需人/会话决定。
5. **默认只回收"能证明已死"的东西**：`unknown` 一律 fail-closed，可能出现"需要人工介入才能解锁"的
   情形（`doctor` 会明确指出）。
6. **`npm run test` / `npm run dev` / `npm run preview` 现在都会经过调度器**：其他会话若发现测试
   要排队、或 dev 服务要等另一个 dev 退出，请读本文档第 4 节，而不是改回直接 `vitest run` /
   `vite`——绕过调度器正是本项目要解决的问题（排障时才有 `*:raw`）。
7. **`dev`/`preview` 纳管后，端口仍是操作者责任**：调度器分配槽位不分配端口；两个会话各自的
   `npm run dev` 会先后排队拿到 dev 槽位，但都默认 5173 端口时第二个仍会冲突。改端口用
   `npm run dev -- --port 5180`（参数透传给脚本体）。
7. **`scripts/perf/gate-run.sh` 已接入调度器，但"完整跑一遍门禁"仍未在真机验证**：2026-11-15 把
   cargo/前端门禁全部改为经 `run` / `cargo` 子命令排队（`bash -n` 与 `GATE_DRY_RUN=1` 路由核对
   已通过，路由证据见 `tmp/acceptance/taskdock-full-acceptance-20261115/scheduler/`）。2026-11-16
   删除内存预算后，门禁不再有"预算不足"排队，但仍受全局并发 3 的约束；低内存下 `cargo clippy` /
   `cargo test --release` **可能 OOM**（exit 101），所以"改完之后整串门禁仍然通过"这一点仍是
   `NOT TESTED`。`GATE_NO_SCHED=1` 保留为调度器故障时的逃生门。
8. **未纳管的 dev 服务器不在活动台账里**：`npm run dev`（直接 `vite`）不经调度器，不占槽位/名额，
   只能靠 `sched dev` 点名发现。需要纳管时用
   `node scripts/build-sched.mjs run --class dev -- npm run tauri dev`（占 dev 槽位）。
9. **`apps/mobile` 的构建入口已接入调度器（2026-11-15 第二轮）**：`start` / `android` /
   `prebuild` / `typecheck` / `test` / `build:android` 全部包了
   `node ../../scripts/build-sched.mjs run --label ... -- <原始命令>`，APK 发布包固定
   `--class heavy --priority P0 --label apk-release --cwd android`。`*:raw` 保留为排障逃生口。
   注意：**本轮没有真正构建 APK**（本机可用内存 1–3.6 GB、且存在非分页池泄漏），所以
   "改完之后 `assembleRelease` 仍能成功"这一点是 `NOT TESTED`／`ENVIRONMENT BLOCKED`，
   由主 Agent 在资源允许时统一排队验证。

## 13. 验收证据

跨进程行为验收（需求第 1–9 项 + 补充A「嵌套不自锁」+ 验收10「等待资源超时层级判定」+
验收11「子进程失败原因可查询」共 13 例全部通过，第 10 项真机构建
`ENVIRONMENT BLOCKED`）与真机资源数据见
[tmp/acceptance/build-sched/report.md](../tmp/acceptance/build-sched/report.md)；
自动化测试：`npm run sched:acceptance`（跨进程，约 1 分钟）与 `npm run test:scripts`。
**2026-11-16 追加**：新增 `验收12`（全局构建并发上限 3）与 5 例单测（`build-sched.test.mjs` 合计 48 例），
见 10.6；跨进程套件总数由 41 例增至 42 例。
**2026-11-16 第二轮（删除内存预算后）**：跨进程套件裁剪为 **19/19 通过**（约 71s），单测
**34/34 通过**（约 3s）；删除预算 1–12、补充B1–B3、配置安全 1–7 与"验收3 内存 3GB"；重写
"验收10"为占满两个 light 槽位制造排队并验证 `exit=3`；"验收12"去掉 `--estimate-mb` 后
仍验证第 4 个构建排队、任一结束自动释放名额；结束时 `reservations` 清空。真机 `sched:status`
显示"全局构建并发：1/3""活动台账：2 条"，其他会话运行中的任务未受影响。详见 10.7。
验收期间机器长期被其他会话的 dev/cargo 占用，曾出现的时序敏感失败与处置（含两处真实缺陷：
取消误判、Windows `rename` 写冲突）见报告 §8.2。
