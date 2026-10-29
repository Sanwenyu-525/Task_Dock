# v0.4 缺陷整改复验记录

日期：2026-10-29。基线 HEAD：e31cc91，修改尚未提交。

本次接续时共享工作区同时存在大量 v0.5、剪贴板、性能模块改动；以下结果针对当前工作树，不能全部归因于本轮整改。

## 已实施

重复规则脏字段追踪、原位事务更新及提醒计划保留；v6 任务窗口身份与降级策略；任务卡/工作区传递关联 ID；显式记忆保护；Agent 身份并集计数与手工所有权升级。设计见 ARCHITECTURE.md 对应章节。

## 2026-10-29 实际执行

| 命令 | 退出码 | 结果 |
|---|---:|---|
| npm test | 0 | 16 文件，109 项通过 |
| npm run build | 0 | TypeScript 与 Vite 通过（依赖重装前） |
| cargo fmt --all -- --check | 0 | 通过 |
| cargo clippy --all-targets -- -D warnings | 0 | 通过 |
| cargo test --lib | 0 | 242 项通过 |
| cargo test | 1 | 241 通过；1 项记事本焦点测试被 Windows 前台锁拒绝 |
| cargo test -- --test-threads=1 | 0 | 242 项通过；10 项集成/压测工具 ignored；完整日志 src-tauri/target/acceptance-tests.log |
| cargo check | 0 | 通过 |
| npm ci | 1 | esbuild.exe 被占用，EPERM；依赖重装未完成 |
| npm run tauri build | 1 | 重装失败后本地 tauri CLI 缺失 |
| npm install --ignore-scripts | 0 | 依赖恢复；占用的旧临时目录清理产生 EPERM 警告 |

依赖恢复后已重新启动安装包构建，日志位于 .acceptance-backup/remediation-build.log；尚不能据此认定构建完成。

新增回归覆盖普通字段编辑、独立提醒/截止编辑、weekly 多日、monthly 月末规则、until/anchor/ID 保留、主动修改与取消、编辑后补偿调度、任务窗口独立/清除/非法身份、显式窗口唯一匹配/句柄变化/标题变化/降级、自动记忆保护、关联顺序与计数、窗口配置备份恢复、v5→v6 迁移。

## 尚未闭合

Chrome 双窗口、VS Code 双项目及交替跳转的真实 Task Dock 端到端验证；NSIS/MSI 安装与升级迁移；三模式/主题/窄窗口视觉回归；真实休眠；真实 Agent 接入；旧版真实备份恢复。本轮单测和记事本测试不能代替这些证据。

发布结论：**FAIL（发布验收尚未通过）**。当前 npm ci 和打包失败，可复现发布构建尚未闭合，任务级窗口导航必要端到端证据不足。既有最终报告的 CONDITIONAL PASS 不适用于本轮修改后的工作树。
