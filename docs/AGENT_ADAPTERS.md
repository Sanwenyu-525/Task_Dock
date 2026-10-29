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

## 四、Qoder / WorkBuddy（未验证接口，诚实标注）

- 调研结论：两者均**未找到公开、稳定的官方状态接口或生命周期钩子文档**。
  按需求「禁止通过猜测伪造状态」，这两个来源在 UI 中标注为「未验证」stub。
- 可用路径：通过上述任一通用通道上报（`source_id` 分别为 `qoder` / `workbuddy`），
  例如 Qoder 的终端插件、外部脚本、CI 回调都可以 POST 状态。
- 待办：向 Qoder / WorkBuddy 官方确认 hooks / 本地 API 支持后，再实现专用 Adapter。

## 五、新增一个 Adapter 的步骤

1. 在 `agents/` 新增模块，实现 `AgentAdapter` trait（只需 `id()` 与 `spawn()`）；
2. 在 `spawn` 中把外部事件转换为 `AgentEvent`，调用 `hub.ingest(&event)`；
3. 在 `lib.rs` setup 中按需启动；如需新来源，先在 `agent_sources` 注册（含 verified 标注）；
4. 遵守校验规则：ID 字符集、长度上限、不携带 Prompt/代码内容。

## 六、Mock Adapter（测试用）

「Agent → 模拟控制台」可触发一次模拟会话（completed / failed / waiting_only），
依次产生 running → waiting → running → 终态 的跃迁与通知，用于在无真实 Agent 的
环境验证 UI、托盘、通知与任务关联。所有模拟数据在 UI 与通知中均标注「模拟」。
