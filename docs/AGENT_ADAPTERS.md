# Agent Adapter 接入说明

Task Dock 用统一的 `AgentEvent` 模型接入所有 AI 编程 Agent。任何 Agent 只要能把状态
推送进来，就能被监控；UI 不绑定任何具体 Agent 的实现。

## 一、统一事件模型

```json
{
  "source_id": "codex",            // 必填，已注册来源（codex/qoder/workbuddy/mock）
  "session_id": "0199…",           // 必填，Agent 侧会话 ID，≤128 字符 [A-Za-z0-9-_.:@/]
  "run_id": "run-123",             // 可选，执行轮次 ID
  "task_title": "重构登录模块",     // 可选，轮次标题（元数据，非 Prompt）
  "state": "running",              // 必填：idle/running/waiting/completed/failed/disconnected
  "message": "codex hook: PreToolUse",  // 可选，≤500 字符简短说明
  "pending_items": ["检查覆盖率"],   // 可选，≤20 条待处理事项（completed 时常用）
  "occurred_at": "2026-10-25T05:47:25Z"  // 可选，缺省用服务端接收时间
}
```

语义约定：
- **running**：Agent 正在执行；
- **waiting**：等待人工处理（权限确认、问题澄清等）——会发「介入」通知；
- **completed**：**执行轮次结束**，不代表关联的普通任务完成；
- **failed**：执行失败；**disconnected**：连接中断或状态不可确认；
- 状态过期（默认 15 分钟无更新）自动转 `disconnected`，不会把任务判定为成功。

### 1.1 来源归属由服务端判定（v0.5，客户端无法伪造）

事件载荷里**没有**「这是真实还是压测」的字段，也**不采信**客户端自报的 `transport`。
归属（`EventOrigin`）由服务端在摄取入口判定，只看三个客户端改不了的输入：

| 归属 | 判定依据 | 对真实侧的影响 |
| --- | --- | --- |
| `real` | 已注册的真实来源（`agent_sources.category='real'`） | 可改状态、进行动中心、弹系统通知 |
| `selftest` | 会话 ID 使用保留前缀 `taskdock-selftest-` | **完全隔离**：不改真实状态、不进行动中心、不弹通知 |
| `benchmark` | 来源 `bench`（服务端注册、UI 隐藏）或会话/轮次同时使用 `http-perf-` 前缀 | 同上，隔离 |
| `mock` | 来源 `mock`（模拟适配器） | 同上，隔离（UI 另行标注「模拟」） |

因此：
- 自测与压测脚本**必须**使用隔离来源（`bench`）或保留前缀，否则会污染真实状态；
  `scripts/perf/ingest-load.mjs` 默认 `--source bench`，显式指定非 `bench` 来源会被拒绝
  （除非加 `--allow-real-source`）。
- **同一条闸门覆盖内存采样链路**：`scripts/perf/memory-probe.mjs` 与
  `scripts/perf/memory-scenario.py` 默认同为 `bench`，非 `bench` 必须显式
  `--allow-real-source`；两个套件脚本（`memory-af-suite.sh` / `memory-notify-suite.sh`）
  用 `SOURCE=bridge` 时会自动追加该标志。
- 例外说明（不是后门）：要测「系统通知路径」的内存成本，只能用 `real` 归属的事件
  （服务端只对 `real` 产生通知）。此时隔离性由**隔离实例**保证——独立数据目录 /
  APPDATA / 端口，用完即弃，绝不接触用户真实库；测完的库整体丢弃。
- 适配器**不要**自己实现归属判断，也不要在载荷里加自定义「测试」标记——那类标记不可信，
  服务端不采信。

## 二、两种通用接入通道（任何 Agent 可用）

### 1. 本地 HTTP 接入（推荐有网络能力的 Agent）

```
POST http://127.0.0.1:47821/api/v1/events
Authorization: Bearer <http_token>      # 令牌见「设置 → Agent 接入」
Content-Type: application/json
```

- 请求体可为单个事件对象或事件数组；单事件响应
  `{"accepted": n, "merged": 0|1, "sampled": 0|1, "rejected": 0, "queued": bool}`；
  数组批量保持全成功/全失败（任一非法整批 400）。
- 仅绑定回环地址；请求体上限 64KB；健康检查 `GET /api/v1/health`（无需鉴权）。
- 过载保护：连接 64 / 活跃请求 32，超限 `429 + Retry-After`；
  管线队列满时关键事件返回 `503 + Retry-After`，**客户端应重试**；非关键事件可能返回
  `sampled: 1`（显式降级，调用方可感知）。
- 关键状态（waiting/completed/failed/disconnected）永不合并；running 允许按轮次合并。
- 端口与令牌在设置中修改（端口修改后约 1 秒内自动重绑）。

示例：
```bash
curl -s -X POST http://127.0.0.1:47821/api/v1/events \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"source_id":"qoder","session_id":"s-1","run_id":"r-1","state":"running","task_title":"编写单测"}'
```

### 2. 文件投递（无网络能力的 Agent / 钩子脚本）

向 `%APPDATA%\com.taskdock.desktop\agent-inbox\` 写入 `.json` 文件（单个事件或数组）。
写入方应**先写 `.tmp` 再 rename**；Task Dock 只处理 mtime 超过 300ms 的稳定文件。
单文件上限默认 4 MiB、每轮最多 200 个文件；解析失败移入 `failed/` 指数退避重试。
服务端按 `event_id`/内容签名幂等，HTTP 与文件重复投递不会产生双份状态。

## 三、Codex CLI 接入（原生 Hook CLI）

Codex 支持生命周期 Hooks（`~/.codex/hooks.json`）。Task Dock 内置安装器：

1. 「Agent → Codex 卡片 → 安装钩子」会：
   - 在 `~/.codex/hooks.json` 写入原生命令
     `"<安装目录>\task-dock.exe" --agent-hook --source codex --event <Event>`；
   - 合并写入（保留用户/第三方已有条目，写入前备份，幂等可重复安装）；
   - 旧版 PowerShell 脚本只做卸载清理与兼容检测，不再用于新安装。
2. Hook CLI 被 Codex 调用时从 stdin 读取 JSON，提取会话 ID/标题等元数据后：
   - **优先** POST 本地 HTTP 端点（连接 700ms / 读写 1200ms 超时）；
   - 失败则**原子写入**文件投递目录，使用同一稳定 `event_id`（sha256 内容哈希），
     跨通道重复由服务端幂等吸收；
   - 任何失败都静默退出 0：旁路观测绝不阻塞或中断 Codex。
3. 事件映射：

| Codex 钩子事件 | Task Dock 状态 |
|---|---|
| SessionStart / UserPromptSubmit / PreToolUse / PostToolUse | running |
| PermissionRequest | waiting |
| Stop | completed |

4. 安装后需重启 Codex CLI 会话；如 Codex 要求信任钩子，按其提示确认。

> **性能说明**：旧实现每事件启动一次 PowerShell（约 300ms+ 冷启动）；
> 原生 CLI 单次进程约 10ms，且不需要额外脚本文件。映射与安装协议保持一致，
> 不修改 Codex 官方 Hook 协议本身。

## 三点五、DSH / OpenCode 插件桥接

安装器向宿主插件目录写入桥接插件（可一键卸载）：

- 有界队列 200、单并发发送、`AbortController` 2.5s 超时；
- 非关键 running 按 `session_id + state` 合并，关键事件插队；
- 429/503 与网络错误指数退避（上限 30s）；
- 关键事件发送失败 → 原子写文件回退；仍失败则回队；
- 定时器 `unref()`：Task Dock 未运行时不会卡住或延迟宿主退出。

> **App Server 路线（未采用，原因记录）**：`codex app-server` 提供 stdio JSON-RPC
> （参考 mxyhi/AgentMonitor，MIT），功能更全（线程恢复、中断回合等），但需要随 Codex
> 版本维护完整协议客户端；本机无 Codex 安装可供联调，为避免「未验证即宣称可用」，
> 第一版采用 Hooks 路线，App Server 列入后续扩展（见 ROADMAP.md）。

## 四、Qoder / WorkBuddy（历史调研已被实现取代）

> **更正（2026-11-03）**：以下「未找到官方接口」的结论已过时。当前代码中
> `agents/qoder.rs`、`agents/workbuddy.rs`、`agents/trae.rs` 均已按官方 Hooks 文档实现
> 多配置目录安装（国际版/CN、WorkBuddy 多根），安装前统一快照、失败一致性恢复。
> 保留原文仅用于记录历史结论；以代码为准。

- 旧结论：两者均**未找到公开、稳定的官方状态接口或生命周期钩子文档**。
- 旧可用路径：通过通用通道上报（`source_id` 分别为 `qoder` / `workbuddy`）。
- 现状：官方 Hooks 配置写入 + 真实事件验证；未收到真实事件的来源不得显示为「已接入」。

## 四点四、Trae Hooks 实测更正（2026-11-04）

历史记录称 Trae「hook 链路已验证」，本机复核推翻该结论：

- **真实事件为 0**：`agent_events` 中 `source_id='trae'` 的记录只有 `taskdock-selftest-trae`（自测），
  `origin='real'` 的事件从未出现；`agent_sources.verified` 由旧版本自测写入，属假阳性。
  健康状态改为按 `origin='real'` 取最近真实事件，只有 `verified` 位而没有真实事件时显示
  `self-test-only`（仅自测通过 · 待真实事件）。
- **CN 版进程名**：本机实际产品是 `Trae CN.exe`（`%LOCALAPPDATA%\Programs\Trae CN`，product.json
  v1.107.1，dataFolderName `.trae-cn`），进程匹配只写 `Trae` 会始终得到 0 个运行实例。
- **全局 Hooks 需开启**：`@byted-icube/ai-modules-chat` 的 Context Asset 逻辑以
  `config.global_hooks_enabled ?? false` 判断，全局 hook 文件为
  `<userHome>/<dataFolderName>/hooks.json`，默认关闭且需用户在 Trae 内开启；
  只写文件不会产生事件。接入向导弹窗会明确提示这一点，不再宣称「已接入」。
- **命令解析**：`"<exe>" --agent-hook` 在 PowerShell 直接执行会报
  `Unexpected token '--agent-hook'`（本机实测），直接 CreateProcess 可执行；Trae 因此使用
  专用构造器 `cmd.exe /c call "<exe>" ...`，不改为每个事件加 PowerShell 包装，也不影响
  Codex/Qoder/WorkBuddy 的命令。

## 四点五、通用 Agent 覆盖矩阵（2026-11-03）

| 来源 ID | 产品形态 | 接入方式 | 说明 |
|---|---|---|---|
| `codex` | Codex CLI / App | 官方 Hooks（`~/.codex/hooks.json`） | 本轮未重跑真机事件，历史联调证据不当作本轮结果 |
| `opencode` | OpenCode CLI | 官方插件桥接 | 事件走本地 HTTP / 文件投递 |
| `deepseek-harness` | DSH | 官方插件桥接 | 插件目录可逆卸载 |
| `qoder` | Qoder IDE / CLI / QoderWork | 官方 Hooks（多配置根） | 未验证形态不共用事件表 |
| `workbuddy` | WorkBuddy / CodeBuddy | 官方 Hooks（多配置根） | 安装前统一快照 |
| `trae` | Trae 国际版 / CN | 官方 Hooks（按版本独立配置路径） | 多目录事务化安装；2026-11-04 复核：真实事件未验证，全局 Hooks 需在 Trae 内开启 |
| `zcode` | ZCode 桌面端 / CLI | 官方配置式 Hooks（`~/.zcode/cli/config.json` → `hooks.events`） | 2026-11-04 升级：安装时自动 `hooks.enabled=true`；保留 mcp/plugins/第三方 hooks |
| `claude-code` | Claude Code CLI | 官方 Hooks（`~/.claude/settings.json`） | 新增；信任确认由 Claude 自身完成 |
| `cursor` | Cursor IDE | 官方 Hooks（用户级 `~/.cursor/hooks.json`） | 新增；不改项目级配置 |
| `gemini-cli` | Gemini CLI | 官方 Hooks（`~/.gemini/settings.json`） | 新增；不覆盖 IDE 插件形态 |
| `windsurf` | Windsurf / Cascade | 仅安装/运行发现 | 走 bridge |
| `cline` / `roo-code` / `continue` / `augment` | VS Code 扩展 | 扩展安装发现 | 不写配置 |
| `copilot` | Copilot CLI / IDE | CLI 运行 + 扩展安装发现 | 不写配置 |
| `antigravity` / `kiro` / `aider` / `openhands` / `openclaw` | CLI / 桌面 | 安装/运行发现 | 官方事件接口未核实，走 bridge |

**能力判定规则**：只有官方文档明确的事件接口才写配置；二进制中出现事件名只是能力线索，
不代表官方支持或真实执行成功。所有新增来源均已登记 `agent_sources`，未登记来源的事件会被拒绝。

## 四点六、ZCode 配置式 Hooks（2026-11-04）

ZCode 的用户配置 `~/.zcode/cli/config.json` 支持配置式 hooks，Task Dock 已从「仅发现」
升级为官方 Hooks 接入：

```json
{
  "hooks": {
    "enabled": true,
    "events": {
      "SessionStart": [
        { "hooks": [ { "type": "command", "command": "cmd.exe /c call \"<task-dock.exe>\" --agent-hook --source zcode --event SessionStart", "timeout": 10 } ] }
      ]
    }
  }
}
```

- **事件全集**：SessionStart / UserPromptSubmit / PreToolUse / PermissionRequest /
  PostToolUse / PostToolUseFailure / Stop（与 `zcode.cjs` 和官方 `diagnosing-hooks` 指南一致）。
- **默认关闭**：配置式 hooks 必须 `hooks.enabled = true` 才执行；安装器会写入该字段，
  并在 `config_status` 中回报 `hooks_enabled`。
- **嵌套布局**：事件写在 `hooks.events.<Event>`，不是 `hooks.<Event>`；Task Dock 使用
  `HooksLayout::NestedEvents`，与 Claude 兼容产品（扁平 `hooks.<Event>`）区分。
- **保留用户配置**：写入前备份（最近 5 份）、原子替换、失败回滚；保留 `mcp` / `plugins` /
  `timeoutMs` / 第三方 hooks。卸载只移除 Task Dock 条目与空事件键，**不删除**
  `hooks.enabled` / `timeoutMs` 等用户级设置。
- **生效时机**：配置仅在 ZCode 新会话启动时加载；已打开的会话不会热更新。
  安装后需新开一个 ZCode 会话，事件才会进入 Task Dock。
- **命令构造**：ZCode 在 Windows 上经 ComSpec（cmd.exe）执行 command hooks；使用
  `cmd.exe /c call "<exe>" ...` 避免引号被 cmd 当作路径的一部分（与 Codex 相同）。
- **状态映射**：SessionStart → idle；UserPromptSubmit / PreToolUse / PostToolUse /
  PostToolUseFailure → running；PermissionRequest → waiting；Stop → completed。

> 当前验证边界：配置写入/备份/回滚/幂等有自动化测试；尚未在新开的真实 ZCode 会话中
> 观察到宿主事件，因此不宣称「已真实联调」。

## 四点七、发现与监控页搜索约定（2026-11-04）

- 搜索字段固定为**显示名称 + `source_id`**，大小写不敏感、忽略首尾空格、中文按连续子串匹配；
  不提供「Code → Codex」之类隐性别名。
- 「运行监控」与「接入管理」各一个搜索框，状态相互独立、互不清空；搜索是显式查找，
  可越过「需关注」筛选命中空闲 Agent 的历史会话，清空搜索后恢复当前筛选范围。
- 搜索只派生自已加载数据（扫描结果 / 快照），**不得**因输入触发后端扫描；扫描按钮仍是
  「接入管理」唯一的数据更新入口。
- 无结果文案必须区分「搜索无匹配」与「没有安装 Agent」；通知定位优先于筛选：定位时清除
  会遮挡目标的搜索条件，保证目标会话可见。

**2026-11-05 补充（历史会话与搜索范围）**

- 运行监控搜索在名称 / `source_id` 之外，还匹配**会话标题、external_id 与轮次任务标题**；
  历史关键词搜索走 `agent_history_sessions({ keyword })`，结果进入独立的「历史搜索结果」区，
  每条保留真实 `source_id` 与实例标签（不伪造实例），点击可直接展开该会话的轮次。
  仍不做隐式别名，搜索也不触发扫描。
- 实时监控快照（`agent_snapshot`）只用于实时会话、实例与状态，其 200/300 条上限
  **不再是历史可访问范围或数量口径**。历史分区展开时才按 10 条/页拉取列表，
  `next_cursor` 为 null 表示没有更多；数量显示后端 `total`。
- 历史入口不依赖快照：展开某个来源时调用 `agent_history_groups({ sourceId })`，
  一次 SQL 聚合返回该来源下**每个真实实例**以及「未关联实例」的历史会话数。
  快照里已经没有近期会话、但历史库仍有记录的实例会以真实 `instance_key` /
  `display_name` 补出入口；来源全部离线时同样可进入历史。分组查询只返回计数与
  实例标识，不加载历史明细来构建树；超过上限时 `truncated=true`，界面如实提示，
  不静默截断。分组按确定序返回（计数降序 + 实例键/实例行 ID 升序，两次查询的
  可见子集不重排）；截断时提示区提供「搜索历史记录」入口——关键词搜索与按 ID
  定位都不依赖分组，可访问被截掉分组里的全部历史（2026-11-06 Round 4 补充）。
- 历史列表更新提示（2026-11-06，Round 4）：展开的历史分区订阅 `agent-changed`
  （组件级订阅，分区关闭/面板卸载即退订），同源事件按 800ms 去抖合并后做一次
  `limit=1` 头部探测；头部变化只显示「有新的历史记录 · 更新」轻量提示——不自动
  刷新、不清除已加载分页、不打断滚动。点击「更新」重载首页，并把仍在展开、
  掉出已加载页的会话保留在列表顶部（按 id 去重，不虚增 total）。页面隐藏时
  暂停探测，恢复可见后补探一次；无轮询、无 interval。
- 实时/历史口径统一：`agent_history_sessions` 等查询默认 `includeLive=false`，
  由 SQL 按轮次语义排除实时会话（存在 `origin='real'` 且状态为
  `running` / `waiting`，或 1 小时内 `failed` / `disconnected` 的轮次），与前端
  `liveState` 判定一致；不再用 `session.status='idle'` 近似。`agent_history_session(id)`
  精确定位时 `include_live=true`，实时会话仍可通过通知/搜索定位打开。同一请求的
  `COUNT(*)` 与分页在同一读事务内执行，避免实时状态变化造成「总数与页内容不一致」
  或首页为空但仍有后续页。
- 隐藏来源（如压测 `bench`）与已删除来源不进入历史列表/分组/搜索；来源被删除后其
  会话不可再检索，也不伪造占位来源。
- 会话轮次展开时才调用 `agent_history_runs({ sessionId, cursor, limit })`，同样返回
  准确 `total` 与 `next_cursor`，不随快照一次拉全部轮次。轮次历史默认排除实时轮次
  （`running`/`waiting` 或 1 小时内 `failed`/`disconnected`），实时轮次仍由快照渲染，
  `COUNT` 与历史列表同口径。
- 历史查询支持 `sourceId` / `instanceId` / `unassigned` / `status` / `keyword` 筛选，
  `sessionId` 可精确定位单条会话；游标由后端签发且不透明，非法游标返回校验错误，
  不会静默重排。翻页期间新插入的更晚记录只会落在游标之前，不造成重复。
- 通知定位到历史会话/轮次时会显式展开对应分区并保留展开状态；快照未命中时用
  `agent_history_session(sessionId)` 按会话行 ID 定位，再展开真实 source / instance
  （实例未知时归入未关联实例，不伪造实例）。目标不在第一页时按游标有上限地补页
  （最多 10 页），避免一次定位拉取整段历史。

**2026-11-06 Round 5 补充（实时快照容量与事件生命周期）**

- `agent_snapshot` 的明细仍有界：最多 200 个实时会话、300 个实时轮次； completed
  不占实时明细容量。`live_summary` 在同一只读事务与同一个 1 小时窗口内返回全库及
  `by_source` 的实时会话/轮次数、各状态数、截断标志和会话续页游标。监控树、胶囊、
  标题状态和来源接入标记使用全量计数，不把快照样本量误当作真实数量；若来源的会话
  全在首屏容量外，仍会显示为已接入。
- `sessions_truncated=true` 时，Agent 页用
  `agent_history_sessions({ liveOnly: true, cursor, limit })` 从快照末项继续 keyset
  分页；单次只显示一页。单会话实时轮次超出快照时，调用
  `agent_history_runs({ sessionId, liveOnly: true, cursor, limit })` 翻页，实时模式只保留
  当前页，不把全部活动轮次累积进前端状态。`liveOnly` 优先于 `includeLive`；普通历史
  查询仍默认排除实时项。新增字段和可选查询参数没有 SQLite schema 或迁移变化。
- 历史更新探测共享一个 `agent-changed` 原生监听；相同筛选共用 `limit=1` 探测，事件
  以 800ms 去抖，不同筛选的在途探测最多 3 个。面板隐藏时暂停并在恢复后补查；最后
  一个消费者卸载后释放监听与待执行计时器。监听注册失败不会清空历史分页，界面显示
  固定错误并保留手动刷新/重试入口；没有新增轮询。

**2026-11-06 Round 5 二次验收整改（agent-changed 契约统一）**
- `cleanup_stale()` 不再单独发送 `{ stale_cleanup }`，而是复用 `stale_cleanup_payload()` 按正常批量事件同一契约发送：`source_id` / `sources`（去重）/ `session_id`（单轮次为该轮次会话，多来源为空）/ `run_id` / `state=disconnected` / `states={ disconnected: n }` / `batch=n` / `changed=true` / `deduplicated=false` / `late=false` / `stale_cleanup=n`。stale 仍不推断任务成功/失败。
- 前端 `lib/bridge.ts:normalizeAgentChangedPayload()` 做运行时校验：非对象、`sources`/`source_id` 类型非法、无信号返回 null（调用方忽略不抛 TypeError、不刷新）；`sources` 缺失时由 `source_id` 兜底，两者均缺失（仅旧 `{ stale_cleanup }`）规范为全局事件（`sources=[]`）使所有分区与实时摘要刷新；`states` 非对象、`stale_cleanup` 非数字亦视为非法。`onAgentChanged` 与 App / HistoryPanel / `useAgentHistory` 均经该归一化，不再直接访问 `payload.sources.includes`。

## 五、新增一个 Adapter 的步骤

1. 在 `agents/` 新增模块，实现 `AgentAdapter` trait（只需 `id()` 与 `spawn()`）；
2. 在 `spawn` 中把外部事件转换为 `AgentEvent`，调用 `hub.ingest(&event)`；
3. 在 `lib.rs` setup 中按需启动；如需新来源，先在 `agent_sources` 注册（含 verified 标注）；
4. 遵守校验规则：ID 字符集、长度上限、不携带 Prompt/代码内容。

## 六、Mock Adapter（测试用）

「Agent → 模拟控制台」可触发一次模拟会话（completed / failed / waiting_only），
依次产生 running → waiting → running → 终态 的跃迁与通知，用于在无真实 Agent 的
环境验证 UI、托盘、通知与任务关联。所有模拟数据在 UI 与通知中均标注「模拟」。

## 七、MCP 规划中心数据访问（2026-11-06）

- 外部 MCP 客户端通过 `task-dock.exe --mcp-server` stdio 子命令进入本机 loopback
  bridge；`mcp_server_enabled` 默认关闭。设置页显示独立的开关，并从 bridge 运行态读取
  是否监听和实际端口，不用开关值冒充运行状态。
- MCP 只开放用户自建规划项目、功能、步骤、里程碑、进度及 Agent 会话关联；不开放
  任务、剪贴板正文、内置路线图或任意 SQL。`readonly` 是用户显式选择的全项目只读；
  `project_rw` 的读写都限制在显式授权项目，创建项目后仅创建者 Agent 自动获得该项目授权。
- 设置页可创建身份、调整 scope、授予/撤销项目、轮换/撤销凭据、生成 Claude Code、
  Codex CLI、Cursor、Trae、generic 配置片段，并分页查看审计摘要。新身份默认 `disabled`。
  Token 明文只在创建或轮换命令的响应返回一次，数据库只存 SHA-256；前端只在当前创建
  区域内存态显示，关闭该区域会清除。任何配置片段由用户自行粘贴，Task Dock 不代写
  第三方客户端配置文件。
- MCP 成功写入与成功审计在同一立即写事务内提交；同一身份、工具和 `requestId` 用
  参数摘要检测重放/冲突，并在当前 scope 与项目授权通过后才返回旧结果。失败时业务
  写入与成功审计一起回滚，提交待验收的状态更新和可选说明也作为单一事务完成。
- 规划功能详情展示关联 Agent 与真实会话状态，Agent 会话详情可反向定位功能；解除关联
  只将关系标记为 `unlinked` 并保留记录。不存在匹配真实会话时状态显示「未知」，且不允许
  跳转。
- 审计分页 API 只返回身份名、工具、对象 ID、时间、成败、授权结果和粗粒度错误分类；
  不返回 `detail`、`request_id` 或 `result_json`。**数据库中的 `result_json` 仍保存写入
 结果以支持幂等重放，并随本地数据库备份；目前没有配置保留周期或自动清理策略**，
  因此审计正文保留期/存储增长仍需后续确定。
- bridge 生命周期由设置更新通知驱动，活动监听异常退出或启动失败时每秒轻量检查/重试；成功监听、关闭释放与进程退出路径在代码中实现，但本轮没有完成真实 MCP 客户端联调、故障重试演练或残留子进程验收。
  未在具体客户端中实测的配置/连接步骤标记为未验证。
