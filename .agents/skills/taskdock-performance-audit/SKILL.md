---
name: taskdock-performance-audit
description: "专项审计 task_dock 常驻性能与资源生命周期：用户说内存越来越高、隐藏页面后 CPU 仍高、Agent 消息积压、越来越卡或卡死时使用；先做静态生命周期检查与低侵入采样，不默认运行高成本压测。只问功能是否实现时用 taskdock-acceptance，只问视觉或原生手感时用 taskdock-ui-acceptance。"
---

# task_dock：性能、背压与资源生命周期审计

## 边界
- 默认只读，**不默认启动高负载压测**；未经用户授权不杀未知进程、不清理其他 Agent 缓存、不修改用户数据、不抢前台。
- 权威规则：根 `AGENTS.md`、`docs/PERFORMANCE_ARCHITECTURE.md`、`docs/PERFORMANCE_TESTING.md`、`docs/ACCEPTANCE_ROUTING.md`；具体代码比历史指标优先。
- 不能凭单次峰值断言泄漏，也不能凭短测无增长断言“没有泄漏”。并行开发造成的编译/资源峰值需要隔离归因。

## 工作流
1. 读取 `git status`、用户症状、历史记录和当前目标代码；选择 [references/audit-map.md](references/audit-map.md) 中**相关**路径，避免无目标全库重扫。
2. 先静态验证有界队列、过载与关键状态保留、同步阻塞、锁顺序、取消/超时、前端订阅释放、剪贴板图片缓存及后台退出回收；假设与事实分开。重点核对隐藏/折叠后的生命周期（见下）。
3. 若有权限做定量测试，先按 [references/experiment-protocol.md](references/experiment-protocol.md) 建立空闲基线、受控负载、恢复、退出阶段与条件；创建隔离数据目录，检查构建/进程归属。
4. 优先使用既有 `scripts/perf/memory-probe.mjs`、`sampler.ps1`、`ingest-load.mjs`、`analyze-memory.py`，**阅读脚本参数与副作用后才执行**。不要盲目执行 `gate-*` 或长时间 suite。并行开发诊断先只读观察 `scripts/watch-dev-processes.ps1` 的 scope/candidate 输出，不直接用 `-AutoStop`；构建缓存只用 `scripts/build-guard.mjs report` 做报告，回收必须登记且默认 dry-run。
5. 如果已有 CSV 且明确列名，可用 `scripts/summarize_csv.py` 计算 p50、p95、最大值和首末差值；需指出其只是**描述统计，不是内存泄漏判定**，也不声称性能提升。
6. 对比相同条件、记录环境/版本/采样数/采样间隔与二进制 sha256（能取得时）；单项为 P0–P3 与四种验收结论，并列出未测试的真实系统层。

## 隐藏导航与模块停用的五级判断（必查）
用户停用导航入口不等于销毁全部后台服务。按实际状态管理与依赖关系依次判断，不简单以“隐藏 Tab”为条件强制销毁共享服务：
1. 仅隐藏入口：只停导航渲染，共享服务继续运行。
2. 暂停 UI 消费：停前端订阅/轮询/快照请求，不停后端采集。
3. 停止不必要后台采样：停高频采样或昂贵探测，保留低频/惰性探测。
4. 保持共享服务：多窗口/多入口共用时保留，UI 只做节流或单飞。
5. 完全停用：仅在模块无其他依赖、无通知/定时任务依赖且用户明确关闭时才停。
审计时对每个隐藏模块写明当前代码落在哪一级；CPU 仍高但共享服务被误判为可销毁时按缺陷处理，不以“入口已隐藏”直接结论。

## 审计覆盖
- Agent 消息队列、Agent 历史记录、事件监听、后台轮询、定时器、缓存增长、异步任务取消、Tauri IPC、SQLite 连接与事务、剪贴板图片缓存、截图缩略图、语音合成缓存、微件窗口、隐藏或停用功能、窗口关闭与退出回收。
- 长期运行按可比较条件检测内存/队列增长、重复订阅/轮询、高频 IPC、UI 主线程阻塞、持续动画、后台 CPU/GPU、非活动组件重复渲染、缓存失效与引用残留；无对照与长跑不下“无泄漏”结论。

## 产物
- 参考 `assets/templates/perf-plan.template.md` 写最小方案；只保留对结论有用的图表或数值与原始证据，放 `tmp/acceptance/<task-name>/` 或 `tmp/debug/<task-name>/`。
- 报告：复现场景、样本与环境、基线/负载/恢复对比、模块根因与确定性、修复方向、回归测例、阻塞/限制。必要时再调用 `taskdock-remediation-prompt`。
