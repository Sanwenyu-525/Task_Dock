# 构建资源调度器（build-sched）使用与原理

多会话/AI 并行开发时，真正会互相伤害的不是代码，而是**构建**：`cargo build`、`tauri build`、
`npm run build`、Gradle、整包测试同时起跑，会争同一份 Cargo target、同一个 `dist/`、同一块
内存。16GB 机器上两个重型构建并行就足以把系统压到卡死。

本调度器提供**一个跨进程、跨 Worktree、跨 AI 会话的全局构建闸门**：
所有高资源构建走同一个入口，按真实可用内存准入、按分类排队、靠操作系统级原子操作互斥，
崩溃后能安全回收。**代码开发仍然完全并行**——被排队的只是构建。

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
npm run sched:status           # 槽位 + 内存 + 排队
npm run sched:queue            # 队列（按有效优先级）

# 提交一个构建（必须用 -- 把真实命令隔开）
node scripts/build-sched.mjs run -- npm run build:raw
node scripts/build-sched.mjs run --priority P0 --label "verify-fix" -- cargo build
node scripts/build-sched.mjs run --class light -- npm run lint

# cargo 走专门子命令：自动切到 src-tauri/（遵守 rust-toolchain.toml 固定的 MSVC 工具链）
npm run cargo -- test --lib clipboard::
node scripts/build-sched.mjs cargo -- --priority P0 test --lib clipboard::

# 运维
npm run sched:history          # 退出码 / 等待时长 / 运行期最低可用内存
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
| `--estimate-mb <N>` | 覆盖预计峰值，仅影响准入下限与解释文案 |
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
node scripts/build-sched.mjs status --json       # 程序读（槽位、内存、队列、配置摘要）
node scripts/build-sched.mjs status --verbose    # 额外做持有者身份校验 + dev 盘点（较慢）
node scripts/build-sched.mjs history --limit 20
```

`history` 每条含 `status`、`exitCode`、`waitMs`、`runMs`、`minAvailMb`（**运行期间最低可用内存**，
这是排查"构建是不是把机器压干了"的第一手数据）、`reason`、`worktree`。

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

判读原则（对应 AGENTS.md「必须区分代码错误、内存不足、超时和调度错误」）：

- `exit=1` + 日志里有编译器/测试错误 → **代码错误**；
- `exit=3` + `status=failed` 且 `reason` 含「内存不足」→ **资源不足**，不是代码问题；
- `exit=3` + `status=failed` 且 `reason` 含「本机装不下」→ **预算容不下该任务**：等待无意义，需更大内存或显式调 `systemReserveMb`（见 4.2）；
- `exit=3` 且 `reason` 含「超时」→ **超时**；
- `exit=5/6` → **调度层/磁盘**问题，先 `doctor`。

### 3.8 构建入口清单与 `:raw` 逃生口（2026-11-15 第二轮审计）

审计范围：根 `package.json` 与 `apps/mobile/package.json` 的**全部**脚本。原则是
"高资源构建一律不得无意绕过调度器"，同时保留一组**明确标注**的轻量/常驻/交互式入口。

| 入口 | 分类 | 是否经调度器 | 说明 |
|---|---|---|---|
| `npm run dev` → `-- vite`（label `desktop-vite`） | dev | ✅ | 2026-11-15 第二轮纳管（主 Agent 授权）：显式 `--class dev`，占 dev 槽位（并发 2）并计入预算 |
| `npm run preview` → `-- vite preview`（label `desktop-preview`） | dev | ✅ | 同上；`vite preview` 是常驻静态预览服务，分类表已修正为 dev（`rule vite-preview`） |
| `npm run build` → `build:raw`（`tsc --noEmit && vite build`） | medium | ✅ | 单层包装，`--priority P1 --label desktop-build`，内层直通，不会双重排队 |
| `npm run tauri -- build` → `tauri:raw` | heavy | ✅ | `--priority P0 --label tauri`；内层 `npm run build` 由 `TASKDOCK_SCHED_TASK_ID` 判定为嵌套直通 |
| `npm run test` → `test:raw`（`vitest run`） | medium | ✅ | `--priority P1 --label desktop-test` |
| `npm run cargo -- <子命令>` | 由 cargo 分类表决定 | ✅ | `build-sched cargo` 子命令，固定 `cwd=src-tauri` |
| `apps/mobile`：`build:android`（gradlew assembleRelease） | heavy（P0） | ✅ | `--cwd android`，与桌面端共享同一份槽位/预算台账 |
| `apps/mobile`：`android`（expo run:android）/ `prebuild` | heavy | ✅ | 会拉起 Gradle/Xcode |
| `apps/mobile`：`typecheck`（tsc --noEmit）/ `test`（vitest run） | medium | ✅ | |
| `apps/mobile`：`start`（expo start） | dev | ✅ | 占 dev 槽位并计入预算 |
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

| 分类 | 槽位并发（默认） | 启动前可用内存（默认） | 预计峰值（默认） | 典型任务 |
|---|---|---|---|---|
| `heavy` | 1 | ≥ 6144 MB | 6000 MB | `cargo build`/`cargo test --all`、`tauri build`、release 构建、Gradle 构建、组合命令 |
| `medium` | 1 | ≥ 4096 MB | 3000 MB | `vite build`、整工程 `tsc`、`cargo check`、较大范围测试 |
| `light` | 2 | ≥ 2560 MB | 800 MB | ESLint/Prettier、单模块类型检查、小范围测试、`build-guard precheck` |
| `dev` | 2 | ≥ 4096 MB | 3000 MB | `tauri dev`、`vite`（常驻，独立槽位，见第 8 节） |

分类由 `scripts/sched/classify.mjs` 依据**命令链**判定，而不是看命令里有没有 "build"：

- npm 脚本会被展开（`npm run build:` → `tsc … && vite build`）并递归解析（≤3 层），组合命令取最高档；
- `cargo` 子命令按名字判定（`build`/`install`/`test` 重型，`check`/`clippy` 中型）；
- `tauri build` 重型，`tauri dev` 属 dev；
- 未知命令**保守归 heavy**（宁可多排一次队，也不把高资源任务误判成轻量）；
- `node -e` 等无法识别的极短脚本归 light（否则每次探测都会被当重型排队）。

### 4.2 内存准入（两重**独立**约束，任一不满足都不启动）

只靠"每分类各自的槽位 + 各自读一次 `os.freemem()`"是不够的：不同分类可能同时基于同一份
（3 秒内缓存的）旧快照各自放行——Heavy 看到 7GB 可用就起 6000MB 的构建，Medium 同时看到同一
份 7GB 又起 3000MB 的构建，两者各自合格而合计 9000MB 已经超卖。因此准入被拆成两个**互不重叠**
的约束。

> ⚠ 变动前的代码证据（本轮整改前）：`scripts/sched/mem.mjs` `evaluateMemoryAdmission()` 只把
> `mem.availMb` 与"本任务自己的门槛"比较；`scripts/sched/queue.mjs` `evaluateEligibility()` 只按
> `slotUsage(home, cfg)` 数**本分类**槽位；`scripts/sched/runner.mjs` 排队循环里各进程持有自己的
> `createMemorySampler()`（`memorySampleMs`=3s 缓存）。三者叠加起来没有任何"跨分类合计"的判断。

**约束 A：实时可用内存门槛（每分类独立，阈值不下调）**

```
门槛A = max(分类下限 minAvailMb, 本任务预计峰值) + 滞回量（仅当该任务曾因内存等待过）
放行A ⇔ (os.freemem() - safetyReserveMb) ≥ 门槛A
```

`os.freemem()` 在 Windows 上是 `ullAvailPhys`（可用物理内存，含待机列表），**已经包含**所有正在
运行进程的真实占用，所以这一侧**不再叠加**其他任务的预计峰值——否则等于对同一份资源扣两次，
16GB 机器上第二个任务会永久起不来。

**约束 B：全局构建预算（所有分类共用同一个池）**

```
预算上限 budgetMb = max(0, totalMb - systemReserveMb)      ← 硬上限，不被任务峰值抬高
已预留 reservedMb = Σ reservations/*.json 的 reservedMb（phase ∈ queued|starting|running|releasing）
放行B ⇔ reservedMb + 本任务预计峰值 ≤ budgetMb
```

- `totalMb` 是物理内存**总量**（`ullTotalPhys`），不是可用内存；`systemReserveMb` 默认 3072
  （操作系统 + 常驻应用 + 文件缓存的安全垫）。16GB 机器上预算约 **12.6 GB**。
- **2026-11-15 第二轮修正**：旧公式是 `max(totalMb - systemReserveMb, 最大分类预计峰值)`。
  它在小内存机器上会把预算抬到 Heavy 峰值——8 GB 机器（保留 3072 MB）真实上限只有 5120 MB，
  旧公式却给出 6000 MB，等于**静默侵占系统保留的安全垫**，正好破坏了本预算要保护的东西。
  现在预算**严格等于** `totalMb - systemReserveMb`；装不下的任务由 `planAdmission` 判为
  `infeasible`（不可准入），原因写明"预计峰值 X > 本机预算 Y（物理 A - 系统保留 B）：本机装不下，
  不是排队问题"，并出现在 `waitReason` / `queue` / `status` 三处。
- 突破保留边界只能**显式**打开 `allowReserveBreach`（默认 `false`）：此时预算被抬到最大分类峰值，
  `computeBudget` 返回 `reserveBreached=true`、`breachMb`、`warning`，`status` 会显著打印
  "系统保留的安全垫已被侵占 XXX MB"，准入证据（`history.jsonl` 的 `budgetAtStart`）里也保留
  `hardLimitMb` 与 `reserveBreached`，事后可复核"这一跑是突破了边界的"。
- 这一侧**只**看"活动任务的预留之和"，**不读** `freemem`，因此与约束 A 不重复计算同一份资源。
- 预留只在**即将启动前**创建（拿到预算 + 拿到分类槽位是同一个临界区，见 5.7），排队中的任务
  不占预算，不会因为"排队的人很多"把自己饿死。

**设备档位判定表（默认 `systemReserveMb=3072`、重型峰值 6000 MB）**

| 物理内存 | 硬上限（物理-保留） | 重型 6000 MB | 中型 3000 MB | 轻量 800 MB |
|---|---|---|---|---|
| 4 GB (4096) | 1.00 GB | **不可准入** | **不可准入** | 准入 |
| 8 GB (8192) | 5.00 GB | **不可准入** | 准入 | 准入 |
| 16 GB (16384) | 13.00 GB | 准入 | 准入 | 准入 |
| 32 GB (32768) | 29.00 GB | 准入 | 准入 | 准入 |

"不可准入"= 这台机器永远排不上（`infeasible`），不是"再等等"；8 GB 机器上编译类任务仍可用
`--estimate-mb` 如实声明更小的峰值，或调小 `systemReserveMb`（需自担 OOM 风险）。

**两个约束的分工**

| | 约束 A | 约束 B |
|---|---|---|
| 回答的问题 | 这台机器**现在**还有没有空间？ | 我一次性批准出去的**峰值承诺**加起来有没有超过总容量？ |
| 数据源 | `freemem`（动态，已被真实占用影响） | `totalmem - 系统保留`（静态总量） |
| 粒度 | 每分类各自门槛 | 所有分类共用一个池 |
| 典型触发 | 内存被 dev server/别的构建吃掉 | Heavy+Medium+2×Dev 这类组合的**合计**超卖 |

其余参数：
- `safetyReserveMb` 默认 0（与需求给的数值严格一致，调优时再抬高）；
- 滞回 `hysteresisMb` 默认 1024：一旦某任务因内存等待过，恢复判定要在门槛 A 之上再多 1GB；
- 内存按 `memorySampleMs`（默认 3s）采样，运行期持续记录最低可用内存写进 `history`。

**边界情况（实现必须逐条满足）**

1. `freemem` 已含运行中进程占用 → 约束 B 绝不用 `freemem - Σ预计峰值`（那会重复扣减）；
2. 两个约束各自独立判定，任一不足即排队；`waitReason` 里分别写明是哪一侧不足；
3. 预算硬上限：若 `totalMb - systemReserveMb` 小于某分类的预计峰值，**不夹取**——预算保持
   `total - 保留`，该分类任务被判为不可准入（`infeasible`）并给出"需要更大内存或调小
   `systemReserveMb`"的可操作原因。想突破保留边界只能显式开 `allowReserveBreach`（默认关闭，
   开启后 `status` 显著告警、历史留证）。预算**永不**因任务峰值而自我抬高，也**不改变**约束 A
   的分类门槛（门槛不下调）；
4. 单个任务的预计峰值 > 预算 → 直接拒绝（不允许"自我放行"），原因写进 `waitReason`；
5. 预留只为**即将启动**的任务创建，排队任务不占预算；
6. 崩溃残留的回收条件：持有进程"已证明退出" **且** 记录的子进程"已证明结束"；子进程仍存活
   或身份 `unknown` → fail-closed 继续占用预算（由 `doctor --reap` 用命令行签名取证处置）；
7. 预留与槽位在同一个临界区完成（5.7）：预算不足不会先占槽位卡住别人；槽位拿不到会回滚预留；
8. `detached` 且没有 childPid 的残留**不自动回收**（无法证明脱离控制台的子进程已退出）；
9. 释放预留校验 `(pid, 进程创建时间, nonce)`，PID 被系统复用也不会释放别人的预留；
10. Dev 常驻服务：经调度器以 `--class dev` 启动的常驻服务占 dev 槽位、**计入**全局预算；
    `npm run dev` 这类**直接启动**的未纳管实例只能靠约束 A 兜住（其真实占用已体现在 `freemem`），
    由 `sched dev` 点名，见第 12 节限制 8。

### 4.3 排队与准入循环（每 `pollMs` 一轮）

1. `housekeeping`：归档提交进程已死的残留记录、清理过期终态记录；
2. 重新计算本任务的有效优先级与内存准入；
3. 槽位有空位 → 申请（见第 5 节）；槽位被占但"内存与优先级都没问题"→ 按 `reclaimProbeMs` 节流做一次
   **持有者是否已死**的取证，能做安全回收就回收；
4. 拿到槽位后**二次校验优先级**（避免低优先级抢在同刻入队的高优先级前面），有冲突就让出重排；
5. 内存不足 → 记 `waiting_resources`，把具体原因写进记录的 `waitReason` 并在终端打印（每 15s 复述一次，不静默）。

**跨分类不头阻塞**：重型在等内存时，轻量检查仍可跑，反之亦然——这是 16GB 机器上避免整体停滞的关键。

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
├── reservations/<taskId>.json                全局预算预留台账（活跃任务，见 5.7）
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

### 5.7 准入原子性：预算预留与分类槽位在同一临界区

「先占槽位、再发现预算不够」会卡死槽位；「先查预算、再慢慢抢槽位」会让两个进程都以为自己拿到了
最后一份预算。因此准入是一次**跨进程原子事务**，临界区就是 `slots/.admission`（同样是 `mkdir`
原子性 + 租约，复用 5.2 那套机制，不另造锁体系）：

```
① mkdir slots/.admission ── 拿不到 → 本轮放弃，下一 pollMs 再试（非阻塞，不等待阻塞式锁）
② 回收崩溃残留预留（只做便宜的存活性判断；证明不了就不动，fail-closed）
③ 读 reservations/*.json 求和 reservedMb，按 4.2 约束 B 判定
④ 预算不足 → 立刻退出临界区，**不碰槽位**
⑤ 写 reservations/<taskId>.json（写入失败 → 退出，不碰槽位）
⑥ 逐个 mkdir slots/<class>-<n>；拿到 → 提交；拿不到 → 回滚 ⑤ 的预留
⑦ 释放临界区
```

`reservations/<taskId>.json` 字段：

| 字段 | 含义 |
|---|---|
| `taskId` / `taskClass` / `reservedMb` | 谁、哪一类、占了多少预算 |
| `ownerPid` / `ownerStartTime` / `ownerStartTimeSource` | 提交进程身份（PID 复用防护） |
| `nonce` | 释放/回滚时的所有权凭据 |
| `childPid` / `childCmdSignature` | 真实构建子进程身份（命令行签名用于取证比对） |
| `detached` | 子进程是否脱离控制台（决定崩溃后能否自动回收） |
| `heartbeatAt` / `createdAt` / `phase` | 心跳、创建时间、`queued\|starting\|running\|releasing` |

- **释放**：校验 `(ownerPid, ownerStartTime, nonce)` 全部相符才删文件——PID 复用不会释放别人的预留；
- **崩溃回收**：持有进程必须"已证明退出"，且 `childPid` 已不存在，才回收。`childPid` 尚未登记
  （崩在 spawn 与登记之间）时，额外要求 `detached !== true` 且没有该进程的存活子进程，并等待
  `reservationOrphanGraceMs`（默认 180s）；任一条不满足就**继续占用**，把原因写进 `doctor`；
- **不做的事**：不按固定时间删预留、不因为心跳停滞就假定持有者已死、不自动处置 `detached`
  的孤儿（这些交给 `doctor --reap` 的签名取证）；
- 台账在 `.git` 公共目录下，**多 Worktree / 多会话共享同一份**，无中央守护进程。

## 6. 队列与状态机

状态：`queued` → `waiting_resources` → `running` → `succeeded` / `failed` / `cancelled`。

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
- **失败可诊断**：每条失败都带 `status/exit/reason` 与日志路径；`waitReason` 写明具体门槛与当前读数
  （例如 `可用内存 1.98 GB < medium 任务门槛 4.00 GB（分类下限 4.00 GB、预计峰值 2.93 GB、滞回 1.00 GB）`）。
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

- 常驻 dev 服务器**不占**一次性构建锁，但用 `dev` 槽位（并发 2）与内存门槛计入压力，
  避免"一边 tauri dev 一边 cargo build release"把内存吃干；
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
| `scripts/worktree-guard.mjs` | 不变。它管"目录与冲突"，本调度器管"算力与内存"，互不替代 |
| `scripts/watch-dev-processes.ps1` | 不变（观察/窄条件终止）。`sched dev` 是它的只读替代视图，不做终止 |
| `scripts/perf/gate-run.sh` | **已接入（2026-11-15）**：所有门禁步经 `run`/`cargo` 子命令排队；cargo 步改用 `cargo` 子命令（`cwd=src-tauri/`，不再用 `--manifest-path`）。`GATE_DRY_RUN=1` 零资源核对路由，`GATE_NO_SCHED=1` 仅在调度器故障时排障用 |
| `AGENTS.md` §3.4/§5 | 已增补"高资源构建统一入口"与"子智能体同规则"，细节指向本文档 |

## 10. 配置

优先级（后者覆盖前者）：内置默认值 → 仓库根 `build-sched.config.json` → 状态目录 `config.json`
→ 环境变量 `TASKDOCK_SCHED_<UPPER_SNAKE>`。未知字段与非法数值会被**拒绝并报错**（不静默忽略）。

| 键 | 默认 | 说明 |
|---|---|---|
| `heavyConcurrency` / `mediumConcurrency` / `lightConcurrency` / `devConcurrency` | 1 / 1 / 2 / 2 | 槽位数 |
| `heavyMinAvailMb` / `mediumMinAvailMb` / `lightMinAvailMb` | 6144 / 4096 / 2560 | 分类内存下限（MB） |
| `safetyReserveMb` | 0 | 额外安全余量 |
| `hysteresisMb` | 1024 | 内存恢复滞回 |
| `memorySampleMs` | 3000 | 内存采样间隔 |
| `pollMs` | 1000 | 准入轮询间隔 |
| `heartbeatMs` / `leaseTtlMs` / `reclaimProbeMs` / `hungReclaimMs` | 3000 / 45000 / 3000 / 180000 | 心跳、租约过期、取证节流、挂起判定 |
| `cargoJobs` | 2 | cargo 编译并行度（16GB 机器上的保守值） |
| `defaultWaitTimeoutMin` / `defaultRunTimeoutMin` | 20 / 0 | 默认等待/运行上限 |
| `agingStepMs` | 300000 | 老化台阶（5 分钟升一级） |
| `logMaxMb` / `historyMaxEntries` / `finishedRetentionMs` | 32 / 500 / 60000 | 日志上限、历史上限、终态记录保留 |
| `estimateHeavyMb` / `estimateMediumMb` / `estimateLightMb` | 6000 / 3000 / 800 | 预计峰值（dev 类沿用 medium 的 3000） |
| `systemReserveMb` | 3072 | 全局预算的系统保留：**硬上限** `budgetMb = max(0, totalMb - 本值)`，绝不被任务峰值抬高；0 = 用满物理内存（仅实验用） |
| `recommendedSystemReserveMb` | 3072 | **推荐保留基线**（2026-11-15 第三轮新增）：`systemReserveMb` 低于它即视为"降低安全余量"。未持危险授权时有效值被 fail-closed 收紧回基线，授权时才生效并在 `status`/`doctor`/`history` 记录减少量 |
| `allowReserveBreach` | false | **危险开关**：允许预算突破 `totalMb - systemReserveMb` 抬到最大分类峰值。开启后 `status` 显著告警、`budgetAtStart` 里留 `reserveBreached` 证据。仅在明确知晓 OOM 风险时临时打开；未持 `reserve-breach` 危险授权时该值被强制回 false |
| `budgetEnabled` | true | 跨分类全局预算开关。**配置里写 false 不会生效**：未持 `budget-off` 危险授权时被忽略并强制 true（第三轮 4.1）。仅用于故障回退 |
| `reservationOrphanGraceMs` | 180000 | 崩溃残留预留"无 childPid"时的回收宽限（有 childPid 时按子进程是否存活判定） |
| `diskPrecheck` | true | 复用 build-guard 的磁盘预检 |
| `dedupe` | true | 等价任务合并 |

调优建议（16GB 机器）：内存长期紧张时**只调低分类门槛或并发**，不要关掉准入；确认某类任务实际峰值
更低时，用 `history` 的 `minAvailMb` 作为依据再调 `estimate*Mb`。

### 10.1 2026-11-15 本机覆盖：取消"静态分类下限"，改为按预计峰值准入

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

### 10.2 危险授权与配置风险（2026-11-15 第三轮）

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
- 安全下限 `SANITY_FLOORS`：heavy≥1024、medium≥256、light≥128、estimateHeavy≥2000、
  estimateMedium≥600、estimateLight≥200、hysteresis≥16；低于即 P0。
- 未知字段、坏 JSON 也会被 `doctor` 点名（P1/P0），不再静默忽略。

**本机覆盖的事实记录（2026-11-15 第三轮 `status --json` 实测）**：状态目录实际为
`heavyMinAvailMb 3072 / mediumMinAvailMb 512 / lightMinAvailMb 256 / hysteresisMb 128 /
estimateMediumMb 2400`，`systemReserveMb=3072`、`recommendedSystemReserveMb=3072`。与 10.1 的
2026-11-15 第二轮快照（1536/1024/256/estimate 2400）不一致，以本节实测为准；10.1 保留为历史记录不改写。

## 11. 故障处理手册

| 症状 | 处置 |
|---|---|
| 一直 `waiting_resources` | `status` 看谁在跑、内存多少；`queue` 看前面有谁。属正常排队，别绕过 |
| `exit=3` 且 reason 含「内存不足」 | 等内存恢复或降级为局部检查（单模块类型检查/单测试），不要反复重试重任务 |
| `exit=3` 且 reason 含「超时」 | 任务太长：拆小（`cargo check` → 单 crate 检查），或用 `--wait-timeout 0` 并放后台 |
| 任务一直不结束但槽位显示被某 pid 持有 | `status --verbose` 看身份校验；确认那是**活着**的构建就等着；确认已死则 `doctor --reap` |
| 怀疑被别人的构建拖垮 | `status` + `history` 的 `minAvailMb`；`sched dev` 看常驻服务。**不要**自行杀别人进程 |
| `doctor` 报 P2「提交进程已退出」 | `doctor --reap`（只清理已证明死亡的残留） |
| 怀疑磁盘满导致失败 | `npm run guard:report`；调度器 `exit=6` 就是磁盘预检拦住的 |
| 失败任务给的日志路径是空的/只有几行 `#` 注释 | 这是"从未启动"的任务：收尾时调度器会补写摘要（status/exit/reason/waitMs）。看 `reason` 判断是内存不足还是等待/运行超时 |
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
   已通过，路由证据见 `tmp/acceptance/taskdock-full-acceptance-20261115/scheduler/`），但本机可用
   内存长期低于 2.5GB，`cargo clippy`/`cargo test --release` 一律排队到超时，所以"改完之后整串
   门禁仍然通过"这一点仍是 `NOT TESTED`。`GATE_NO_SCHED=1` 保留为调度器故障时的逃生门。
8. **未纳管的 dev 服务器不在预算台账里**：`npm run dev`（直接 `vite`）不经调度器，只能靠约束 A
   兜住（其真实占用已体现在 `freemem`），并由 `sched dev` 点名。需要计入全局预算时用
   `node scripts/build-sched.mjs run --class dev -- npm run tauri dev`（占 dev 槽位 + 计入预算）。
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
自动化测试：`npm run sched:acceptance`（跨进程，约 1 分钟）与 `npm run test:scripts`（含 22 例单测）。
验收期间机器长期被其他会话的 dev/cargo 占用，曾出现的时序敏感失败与处置（含两处真实缺陷：
取消误判、Windows `rename` 写冲突）见报告 §8.2。
