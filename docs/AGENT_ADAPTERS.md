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
- 「运行监控」与「接入管理」各一个搜索框，状态相互独立、互不清空；均与既有状态筛选
  （需关注/全部）取交集。
- 搜索只派生自已加载数据（扫描结果 / 快照），**不得**因输入触发后端扫描；扫描按钮仍是
  「接入管理」唯一的数据更新入口。
- 无结果文案必须区分「搜索无匹配」与「没有安装 Agent」；通知定位优先于筛选：定位时清除
  会遮挡目标的搜索条件，保证目标会话可见。

## 五、新增一个 Adapter 的步骤

1. 在 `agents/` 新增模块，实现 `AgentAdapter` trait（只需 `id()` 与 `spawn()`）；
2. 在 `spawn` 中把外部事件转换为 `AgentEvent`，调用 `hub.ingest(&event)`；
3. 在 `lib.rs` setup 中按需启动；如需新来源，先在 `agent_sources` 注册（含 verified 标注）；
4. 遵守校验规则：ID 字符集、长度上限、不携带 Prompt/代码内容。

## 六、Mock Adapter（测试用）

「Agent → 模拟控制台」可触发一次模拟会话（completed / failed / waiting_only），
依次产生 running → waiting → running → 终态 的跃迁与通知，用于在无真实 Agent 的
环境验证 UI、托盘、通知与任务关联。所有模拟数据在 UI 与通知中均标注「模拟」。
