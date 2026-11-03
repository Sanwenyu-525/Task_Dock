---
name: taskdock-performance-audit
description: "专项审计 task_dock 长驻性能、内存/CPU 增长、Agent 消息积压、Tauri 阻塞、重复订阅、异步资源泄漏和退出回收；用户说性能检查、内存爆炸、越来越卡或卡死时使用。"
---

# task_dock：性能、背压与资源生命周期审计

## 边界
- 默认只读，**不默认启动高负载压测**；未经用户授权不杀未知进程、不清理其他 Agent 缓存、不修改用户数据、不抢前台。
- 权威规则：根 `AGENTS.md`、`docs/PERFORMANCE_ARCHITECTURE.md`、`docs/PERFORMANCE_TESTING.md`、`docs/ACCEPTANCE_ROUTING.md`；具体代码比历史指标优先。
- 不能凭单次峰值断言泄漏，也不能凭短测无增长断言“没有泄漏”。并行开发造成的编译/资源峰值需要隔离归因。

## 工作流
1. 读取 `git status`、用户症状、历史记录和当前目标代码；选择 [references/audit-map.md](references/audit-map.md) 中**相关**路径，避免无目标全库重扫。
2. 先静态验证有界队列、过载与关键状态保留、同步阻塞、锁顺序、取消/超时、前端订阅释放、剪贴板图片缓存及后台退出回收；假设与事实分开。
3. 若有权限做定量测试，先按 [references/experiment-protocol.md](references/experiment-protocol.md) 建立空闲基线、受控负载、恢复、退出阶段与条件；创建隔离数据目录，检查构建/进程归属。
4. 优先使用既有 `scripts/perf/memory-probe.mjs`、`sampler.ps1`、`ingest-load.mjs`、`analyze-memory.py`，**阅读脚本参数与副作用后才执行**。不要盲目执行 `gate-*` 或长时间 suite。
5. 如果已有 CSV 且明确列名，可用 `scripts/summarize_csv.py` 计算 p50、p95、最大值和首末差值；需指出其只是**描述统计，不是内存泄漏判定**，也不声称性能提升。
6. 对比相同条件、记录环境/版本/采样数/采样间隔与二进制 sha256（能取得时）；单项为 P0–P3 与四种验收结论，并列出未测试的真实系统层。

## 产物
- 参考 `assets/templates/perf-plan.template.md` 写最小方案；只保留对结论有用的图表或数值与原始证据，放 `tmp/acceptance/<task-name>/` 或 `tmp/debug/<task-name>/`。
- 报告：复现场景、样本与环境、基线/负载/恢复对比、模块根因与确定性、修复方向、回归测例、阻塞/限制。必要时再调用 `taskdock-remediation-prompt`。
