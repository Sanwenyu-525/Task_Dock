# Agent Adapter 开发指南

面向未来为 Task Dock 新增 Agent 接入的开发者。目标：**一个新 Agent 从调研到可验证接入 ≤ 半天**。

## 一、分层模型（必须理解）

```
Agent 来源 (agent_sources)        —— 品牌/产品，如 codex、trae
   └─ 实例 (agent_instances)      —— 同一 Agent 的多个安装/进程实例
        └─ 会话 (agent_sessions)  —— Agent 侧会话（来源+外部 ID 唯一）
             └─ 轮次 (agent_runs) —— 一次执行（同会话可多轮）
                  └─ 事件 (agent_events) —— 状态流水（幂等，dedupe_key 唯一）
```

铁律：
1. **没有实际事件证据，状态必须显示未知**——绝不能由「进程在跑」「配置存在」推断为运行中或已完成（`source_health` 的 `no-events`/`awaiting-first-event` 态即为此设计）。
2. 事件只携带状态元数据（来源/会话/轮次/状态/短说明），**禁止携带 Prompt、聊天正文、代码、密钥**。
3. verified 只能由真实事件置位（`ingest_core` 内 transport≠mock 自动处理），Mock 永远不置位。

## 二、接入方式选型（按优先级）

| 方式 | 适用 | 实现 |
|---|---|---|
| 官方生命周期 Hooks（Claude 兼容组结构） | Codex/Trae/WorkBuddy/Qoder 及一切同格式产品 | 复用 `hooks_install.rs`，见 §三 |
| 宿主插件事件 | OpenCode（TS 插件）、DSH（JS 插件） | 写插件文件到官方插件目录，见 §四 |
| 通用桥接 | 无官方接口的 Agent | 引导使用 HTTP / 文件投递（source_id=自定义来源），UI 明示「状态由对方上报」 |
| 仅发现 | 有安装无接口 | 只实现 detect（zcode 模式），UI 显示未知态 |

> Claude 兼容组结构（经本机 Codex 0.130 / Claude Code / Trae / WorkBuddy / Qoder 多方实证）：
> ```json
> { "hooks": { "<Event>": [ { "matcher"?: "", "hooks": [ { "type": "command", "command": "...", "timeout"?: 10 } ] } ] } }
> ```
> ⚠️ v0.1 的教训：把 `{type, command}` 直接放进事件数组是**无效格式**，宿主不会执行。

## 三、新增一个 Hooks 型适配器（以 Trae 为例）

1. **调研（1-2h）**：确认官方文档中的配置文件路径（用户级/项目级）、JSON 结构、事件名、stdin 载荷字段、生效条件（如 WorkBuddy 需 /hooks 面板确认）。若二进制可定位，用事件名做**能力核验**（参考 `managed::scan_events_cached`，结果按 exe 路径+大小+mtime 缓存）。
2. **新建 `src-tauri/src/agents/<name>.rs`**：

```rust
use super::managed::{self, DetectionReport, HooksAdapter};

pub const EVENTS: &[&str] = &["SessionStart", /* …按官方文档 */];

pub fn hooks_files() -> Vec<std::path::PathBuf> {
    vec![super::hooks_install::home_dir().join(".<name>").join("hooks.json")]
}

fn detect_impl(r: &mut DetectionReport) {
    let home = super::hooks_install::home_dir().join(".<name>");
    r.installed = home.exists();
    if home.exists() { r.config_homes.push(home.to_string_lossy().to_string()); }
    r.running_instances = managed::find_processes(&["<ProcName>"]);
}

pub fn adapter() -> HooksAdapter {
    HooksAdapter {
        source_id: "<name>",            // = agent_sources.id = 事件里的 source_id
        display_name: "<Name>",
        docs_url: "https://…",
        hooks_files,
        events: || EVENTS.iter().map(|s| s.to_string()).collect(),
        detect_impl,
        limitations: vec!["如实写明限制".into()],
        timeout_secs: 10,
    }
}
```

3. **注册**：`managed.rs` 的 `all_adapters()` 加一行；`db/mod.rs` 迁移 v2 的 INSERT 列表加来源（升级路径），或用户经 UI「自定义来源」动态注册。
4. **verify 已免费获得**：`HooksAdapter::verify` 以与宿主相同的方式调用 hook 脚本并轮询数据库——**配置文件存在不算数，必须有事件证据**。
5. **测试**：`hooks_install::tests` 的四个安全测试模板（第三方保留/幂等/仅删自身/损坏拒改）+ 用临时目录跑 `install_hooks(&tmp, &[spec("Stop")])`。

## 四、新增一个插件型适配器

参照 `opencode.rs`（TS）或 `dsh.rs`（JS）：
- 插件文件**只新增**、拒绝覆盖非本项目同名文件（`PLUGIN_MARKER` 识别）；
- 插件内把官方事件映射为统一事件（见下方映射表），POST 本地 ingest，**任何异常静默失败**（监控不得阻塞宿主）；
- `verify` 用 `opencode::reqwest_like_post` 以插件相同方式打一次真实上报。

## 五、事件映射约定

| 统一 state | 语义 | 典型来源事件 |
|---|---|---|
| running | 正在执行 | SessionStart、UserPromptSubmit、PreToolUse、PostToolUse、session.created |
| waiting | 等待人工（**不得自动批准**） | PermissionRequest、Notification、permission.asked、approval/request |
| completed | 本轮执行结束 | Stop、SessionEnd、session.idle、agent/status=idle |
| failed | 执行失败 | session.error、agent/error、PostToolUseFailure（若宿主单独提供） |
| disconnected | 心跳超时（仅由 `cleanup_stale_core` 判定） | — |
| idle | 空闲 | — |

事件 JSON（HTTP/文件投递通用）：

```json
{
  "source_id": "codex",            // 必填，已注册来源
  "session_id": "<Agent 侧会话>",   // 必填
  "run_id": "<可选，缺失走会话内轮次状态机>",
  "state": "running",              // 必填
  "task_title": "…",               // 可选 ≤200
  "message": "…",                  // 可选 ≤500
  "pending_items": ["…"],          // 可选 ≤20
  "occurred_at": "RFC3339",        // 可选，缺失用接收时间
  "transport": "hook|plugin|http|file|manual|mock",
  "event_id": "<可选，提供则按其幂等>",
  "instance_id": "<可选，多实例区分>",
  "parent_run_id": "<可选，子 Agent>"
}
```

## 六、调试与联调（无头 CLI）

```bash
task-dock.exe --agentctl scan                 # 四层发现
task-dock.exe --agentctl preview <id> 2>/dev/null || --agentctl install <id>
task-dock.exe --agentctl verify <id>          # 真实链路验证（必须 ok:true）
task-dock.exe --agentctl events 20            # 事件流水（带 transport）
task-dock.exe --agentctl post <source> <state> # 直接上报调试
task-dock.exe --agentctl uninstall <id>       # 可逆卸载（第三方保留）
```

先跑 `cargo test`（52 项），再用真实 Agent 做一次完整生命周期联调（等待/完成/失败各一次），最后在 AGENT_COVERAGE_MATRIX.md 如实登记——**未真实联调的一律写「待验证」**。

## 七、常见坑（本项目实际踩过）

1. **PowerShell 脚本编码**：脚本必须 UTF-8 带 BOM 且建议纯 ASCII——Windows PowerShell 5.1 对无 BOM 文件按 ANSI 解析，中文注释会破坏语法。
2. **大二进制能力扫描**：Agent CLI 动辄 200MB+，逐字节滑窗在 debug 构建下不可用；用 regex 字面量 + 文件缓存（`scan_events_cached`）。
3. **版本探测副作用**：IDE 启动器（如 Trae 的 cursor.cmd）`--version` 可能拉起整个 IDE——只探测纯 CLI。
4. **Windows 原子写**：`std::fs::rename` 不覆盖既有文件；顺序 = 写临时文件 → 备份原文件 → 删原 → rename，失败从备份回滚。
5. **hook 幂等**：同一事件重试（同 occurred_at 同内容）会被 dedupe_key 挡掉；不同轮次天然时间不同，不会误伤。
