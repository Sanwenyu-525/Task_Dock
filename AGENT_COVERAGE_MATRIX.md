# Agent 覆盖矩阵（v0.2）

> 「已实现」= 检测/接入/卸载代码落地并有自动化测试；「已真实联调」= 在本机以真实配置文件 + 真实链路（hook 脚本或插件上报 → 本地 ingest → 数据库）验证通过。未达「真实联调」的一律标记待验证，不计入通过数。

| Agent（产品形态） | 官方文档 | 检测方式 | 接入方式 | 版本要求 | 支持的事件 | 已实现 | 已真实联调 | 当前限制 |
|---|---|---|---|---|---|---|---|---|
| **Codex**（CLI/App，共用 ~/.codex） | github.com/openai/codex | CODEX_HOME/`~/.codex` 配置根 + `where`/`%LOCALAPPDATA%\OpenAI\Codex\bin\codex.exe` + tasklist(codex.exe) + 注册表 | `$CODEX_HOME/hooks.json` 官方组结构 `{hooks:{Event:[{hooks:[{type:command,command,timeout}]}]}}`；安装前对 codex.exe 做事件名二进制核验（带缓存） | 本机实测 codex-cli 0.130.0-alpha.5；hooks 事件以二进制核验结果为准 | SessionStart、UserPromptSubmit、PreToolUse、PostToolUse、PermissionRequest、Stop、Notification（二进制实测 7 个全支持） | ✅ | ✅ hook→HTTP→DB 链路（`--agentctl verify codex` → ok） | App Server（JSON-RPC）路线未纳入；App 与 CLI 共用 hooks.json，无法区分来源形态 |
| **Trae**（IDE 国际版 + Trae CN） | docs.trae.ai/ide/hook-configuration-reference | `~/.trae`、`~/.trae-cn` 配置根 + Programs 目录 + tasklist(Trae.exe) | 双配置根各写 `hooks.json`（Claude 兼容组结构） | 本机 Trae 3.17.8/国际版；事件名按官方文档 | SessionStart、UserPromptSubmit、PreToolUse、PostToolUse、Stop、Notification | ✅ | ✅ hook 链路 | 事件名未做二进制核验（IDE 主程序为 Electron 多文件，按官方文档基线）；版本探测会拉起 IDE，已禁用 |
| **WorkBuddy**（桌面端/AI 版/CodeBuddy 三配置根） | workbuddy.ai/docs/zh/cli/hooks | `~/.workbuddy`、`~/.workbuddy-ai`、`~/.codebuddy` + Programs(WorkBuddy/WorkBuddyAI) + tasklist | 各配置根 `settings.json` 的 `hooks` 键（Claude 兼容；Windows 下 hook 经 Git Bash 执行，命令行为 powershell 兼容） | 本机双安装；事件按官方 Hooks 参考（27+ 中的核心 8 个） | SessionStart、SessionEnd、UserPromptSubmit、PreToolUse、PostToolUse、PermissionRequest、Stop、Notification | ✅ | ✅ hook 链路 | **官方安全机制：外部写入需在 CLI `/hooks` 面板人工确认才生效**；桌面端/CLI/SDK 为不同产品形态，仅 hooks 为共同接口 |
| **Qoder**（IDE + CLI 共用 hooks） | docs.qoder.cn/qoder/hooks | `~/.qoder` + Programs(Qoder/Qoder CN) + `where qoder` | `~/.qoder/settings.json` 的 `hooks` 键（Claude 兼容；官方亦支持 http 处理器，本项目用可审计的 command 型） | 本机 Qoder CN 安装；官方文档确认事件集 | SessionStart、SessionEnd、UserPromptSubmit、PreToolUse、PostToolUse、PermissionRequest、Stop、Notification | ✅ | ✅ hook 链路 | 国际版与 CN 版共用 `~/.qoder`；官方明示「配置可见 ≠ Hook 已加载执行」，以真实事件为准 |
| **DeepSeek Harness**（DSH 桌面端/CLI） | github.com/libukai/awesome-deepseek-harness | `~/.dsh` + Programs(DeepSeek Harness) + tasklist | `~/.dsh/plugins/task-dock-bridge/` 宿主插件（package.json + lib/index.js，随宿主自动加载；参照本机 dsh-task-chime 现成实现） | 无正式版本承诺 | agent/status（idle→completed、error→failed）、agent/error、approval/request（→waiting）、subagent/start、subagent/end | ✅ | ✅ plugin→HTTP→DB 链路 | 插件事件字段以本机参考实现为准，无官方稳定性承诺；需重启 DSH 加载 |
| **OpenCode**（CLI/TUI） | opencode.ai/docs/plugins | `~/.config/opencode` + `where opencode` + tasklist(opencode-cli) | `~/.config/opencode/plugins/task-dock-bridge.ts`（启动自动加载；拒绝覆盖非本项目同名文件） | 本机 npm 全局安装且运行中 | session.created、session.idle（→completed）、session.error（→failed）、permission.asked（→waiting）、tool.execute.before | ✅ | ✅ plugin 链路 | session.idle 表示一轮回复结束≠整个任务完成；需重启 OpenCode 会话加载 |
| **ZCode**（桌面端 + CLI） | 无公开 hooks 文档（本机 zcode.cjs 实测：事件=SessionStart/UserPromptSubmit/PreToolUse/PermissionRequest/PostToolUse/PostToolUseFailure/Stop，由插件 `hooks/hooks.json` 提供，类型 command/process） | `~/.zcode` + Programs(ZCode) + tasklist | **不自动安装**：第三方本地注册插件无官方文档，风险高；提供通用桥接（HTTP/文件，source_id=zcode） | — | 无自动事件通道 | ⚠️ 仅发现+桥接 | ❌ 待验证（明确不计入通过数） | 插件市场自动注册未验证；无法读取真实执行状态时显示「未知」 |
| 通用桥接（任意 Agent） | — | — | HTTP `POST 127.0.0.1:47821/api/v1/events`（Bearer 令牌）/ 文件投递 agent-inbox | — | 任意状态事件 | ✅ | ✅（bridge 来源已收真实事件） | 需 Agent 侧自行上报 |

**真实联调通过计数：6 / 7**（Codex、Trae、WorkBuddy、Qoder、DSH、OpenCode；ZCode 待验证不计入）。

范围外但已勘明格式（按用户指示移出本轮）：Claude Code（`~/.claude/settings.json`，本机 v2.1.186）、Cursor（`~/.cursor/hooks.json`，`version:1` + camelCase 事件）、Gemini CLI（未见官方 hooks）。

---

## Agent 跳转/导航能力矩阵（v0.4 新增）

> 「证据」列说明能力如何被核验：`baseline-verified` = 本机真实版本实测；`exe-found` = 当次动态定位到可执行文件；`cli-help-probed` = 运行时探测 CLI 帮助文本；`unsupported-interface` = 无官方接口，诚实标记不支持（不臆造 Deep Link）；`not-installed` = 本机未安装。「真机验证」= 在本机 Windows 桌面会话真实执行过（cargo test 真机用例 + 手动验收），未验证的一律如实标注。

| Agent | 启动软件（L1） | 唤醒窗口（L2） | 打开工作区（L3） | 恢复会话（L4） | 证据 | 真机验证 | 已知限制 |
|---|---|---|---|---|---|---|---|
| Codex CLI | ✅ | ✅ | ❌ 无此接口 | ✅ `codex resume <id>` | baseline-verified（0.130.0-alpha.5） | ✅（单测真实 spawn） | resume 在新终端进程打开；多实例时无法定位原终端窗口 |
| Codex App（无 CLI） | ✅（App 数据目录存在时） | ✅（按标题提示） | ❌ | ❌ 降级为唤醒窗口 | exe-found / not-installed 动态 | ⚠️ 待真机验证 | App 与 CLI 会话库共用 ~/.codex，但无法从 App 反查会话窗口 |
| OpenCode | ✅ | ✅ | ❌ | ⚠️ 动态：CLI 帮助确认支持会话 ID 参数才启用；否则降级打开 TUI | cli-help-probed（1h 缓存） | ❌ 待真机验证（探测逻辑有单测，真实 resume 命令未在本机跑过） | 仅装了 CLI 才有 L4；resume 无 ID 支持时只能打开会话选择器 |
| Trae / Trae CN | ✅ | ✅ | ⚠️ `trae <dir>`（VS Code 系 CLI 惯例，帮助文本未逐项核验） | ❌ 诚实不支持 → 降级启动/唤醒 | cli-convention | ❌ 待真机验证 | 多窗口时唤醒「其中一个」并如实标注，不冒充精准实例 |
| Qoder | ✅ | ✅ | ⚠️ `qoder <dir>`（同上） | ❌ 诚实不支持 | cli-convention | ❌ 待真机验证 | IDE 与 CLI 为不同形态；CLI 可恢复 ≠ IDE 可恢复，两者分开判定 |
| WorkBuddy / CodeBuddy | ✅ | ✅ | ❌ | ❌ 诚实不支持 | exe-found | ❌ 待真机验证 | 官方参数/协议未核实，仅做启动与窗口唤醒 |
| DeepSeek Harness | ✅（CLI 在 PATH 时） | ✅ | ❌ | ❌ 诚实不支持 | exe-found | ❌ 待真机验证 | 桌面端无会话定位接口 |
| ZCode | ✅（exe 定位时） | ✅ | ❌ | ❌ 诚实不支持 | exe-found | ❌ 待真机验证 | 无公开会话接口 |
| 自定义 Agent | 手动登记为应用目标后 ✅ | ✅ | — | ❌（不信任事件携带的命令） | 用户确认配置 | ❌ 待真机验证 | 只使用用户在「应用与快捷方式」里确认过的启动配置 |
