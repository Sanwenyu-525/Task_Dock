# 后续可扩展模块清单

以下模块**不影响第一版核心（任务管理 + Agent 监控）的可靠性**，按优先级排序。

## 近期（v0.2）

| 模块 | 说明 | 依赖 |
|---|---|---|
| Codex App Server 适配器 | 通过 `codex app-server` stdio JSON-RPC 获得线程恢复、中断回合、完整对话事件（参考 mxyhi/AgentMonitor，MIT） | 真实 Codex 环境联调 |
| Claude Code 适配器 | `~/.claude/settings.json` Hooks + 通用接入（模式已验证：code-light-ai，MIT） | 无 |
| Cursor 适配器 | 待官方接口确认 | 官方文档 |
| Qoder / WorkBuddy 专用适配器 | 待官方 Hooks/API 确认（当前走通用接入） | 厂商确认 |
| Agent 人工介入收件箱 | waiting 状态聚合作战台：一键跳转、批量处理、稍后提醒 | v0.1 通知历史 |
| 任务依赖关系 | tasks 表增加 depends_on；完成前置任务时提示 | schema v2 迁移 |

## 中期（v0.3）

| 模块 | 说明 |
|---|---|
| 番茄钟 / 专注模式 | 参考 deephud（MIT）的计时器与统计设计；任务可直接开始专注 |
| 执行历史时间轴 | agent_runs + agent_events 的可视化时间轴（按天分组、时长统计） |
| 任务完成率统计 | 按日/周/月的完成率、逾期率、分类分布图表 |
| Agent 工作时长统计 | 按来源/会话统计运行时长、等待时长、失败率 |
| 通知静音规则 | 按时间段、来源、级别静音（当前仅全局开关） |
| 自定义全局快捷键 | 设置界面录制快捷键（当前固定 Ctrl+Alt+T / Ctrl+Shift+Space） |

## 远期（v1.0）

| 模块 | 说明 |
|---|---|
| 多语言（i18n） | 界面文案抽取，英文支持 |
| 窗口微件库 | 迷你图表、今日进度环等可选微件 |
| 插件系统 | 第三方 Adapter / 视图插件（WASM 或动态库，需沙箱设计） |
| 数据同步（可选） | 用户显式选择的自托管同步（WebDAV/文件），默认永不开启 |
| macOS / Linux 打包 | 架构已预留（窗口/托盘逻辑跨平台），需补齐 Vibrancy/AppIndicator 细节 |

## 技术债

- HTTP 接入暂无限流；多用户场景需加速率限制（当前仅本机回环，风险低）。
- 文件投递为轮询（1s）；事件量增大后可换 `notify` crate（MIT）事件驱动。
- 重复任务的「每周多日 + 隔周」依赖 anchor 列，导入旧数据时需兼容（v1 导出已含 anchor）。
