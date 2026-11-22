# 生活效率系统 v1 工程修复：测试执行记录

执行时间：2026-11-22（GMT+8）。工作目录：仓库根 `D:/Develop/task_dock`，移动端为
`apps/mobile`，Rust 经 `npm run cargo -- <参数>` 在 `src-tauri` 执行（共享 target 排队，不抢锁）。
下表只记录**实际执行过**的命令；退出码来自 shell，测试数来自 vitest/cargo 输出。

| # | 命令 | 退出码 | 实际结果 |
|---|---|---:|---|
| 1 | `npm run typecheck` | 0 | `tsc --noEmit` 通过，无错误 |
| 2 | `npm test -- src/components/life/LifePanel.test.tsx` | 0 | 1 文件 / 16 用例通过（原 5 + 新增 11） |
| 3 | `npm run build` | 0 | `tsc --noEmit && vite build` 成功；仅有既存 chunk >500kB 提示 |
| 4 | `npm run arch:guard` | 0 | 报告模式通过；既存 DUP-001/CIRC-001 例外未新增 |
| 5 | `cd apps/mobile && npm run typecheck` | 0 | `tsc --noEmit` 通过，无错误 |
| 6 | `cd apps/mobile && npm test -- src/domain/__tests__/lifeMoney.test.ts` | 0 | 1 文件 / 12 用例通过（含 6 组共享向量） |
| 7 | `cd apps/mobile && npm test -- src/db/__tests__/life.test.ts` | 0 | 1 文件 / 12 用例通过（含新增生活待办 SQL 过滤用例） |
| 8 | `cd apps/mobile && npm test -- src/db/__tests__/lifeSyncReliability.test.ts` | 0 | 1 文件 / 14 用例通过 |
| 9 | `cd apps/mobile && npm test -- src/lib/life/__tests__/receiptTransfer.test.ts` | 0 | 1 文件 / 3 用例通过 |
| 10 | `cd apps/mobile && npm test -- src/lib/life/__tests__/requestGeneration.test.ts` | 0 | 1 文件 / 4 用例通过（新增代际控制测试） |
| 11 | `npm run cargo -- test --lib commands::life` | 0 | 29 用例通过，0 失败（含 13 个新增/改写用例） |
| 12 | `npm run cargo -- test --lib mobile_sync::life_sync` | 0 | **0 用例匹配**：现行测试路径为 `mobile_sync::sync::*`，该过滤器是历史遗留，命令本身不报错也未验证任何行为 |
| 13 | `npm run cargo -- test --lib mobile_sync::sync::tests::life` | 0 | 1 用例通过（`life_item_same_name_conflict_returns_desktop_record`） |
| 14 | `npm run cargo -- test --lib mobile_sync::sync::life_sync::tests` | 0 | 1 用例通过（新增：历史数量 0 的同步复制兼容） |

## 本轮曾失败并已修复

| 失败 | 原因 | 处理 |
|---|---|---|
| 移动端 `货币规范化与精度` 用例抛「金额必须指定货币」 | 共享 JSON 的 `currency_decimals` 段用了 `currency` 字段，测试读取 `input` | 统一为 `input`，JSON 复验可解析，重跑 12/12 通过 |
| 桌面 `事件级票据定位` 用例断言 `lifeEventDetail("ev-b", {focusLinkId})` 失败 | 该 IPC 只接收 `eventId` 一个参数，`focusLinkId` 是前端详情状态 | 修正断言为 `toHaveBeenCalledWith("ev-b")`，焦点另由 `.life-link-row.is-focused` 断言，重跑 16/16 通过 |
| 首次 `cargo test` 报 `target\debug\.cargo-lock 拒绝访问` | 另一会话持有共享 Cargo target | 不终止他人进程，等待后重跑成功；未使用隔离 `CARGO_TARGET_DIR` |

## 未执行 / 未验证

- Release 正式包、安装包升级/卸载、真实双设备端到端同步：本次未执行，不标通过。
- 移动端 RN 页面级端到端渲染测试（LifeScreen 快速切换、已完成展开）：仓库无现成屏幕级渲染夹具；
  代际控制由 `requestGeneration` 单测覆盖，页面接线经代码审查，未宣称端到端验证。
- 全量 vitest / 全量 `cargo test --lib`：未在本轮执行（耗时且含与本次无关的用例），只执行上表定向命令。
