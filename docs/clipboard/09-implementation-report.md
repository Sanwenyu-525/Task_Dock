# 09 · 实施与验收报告（v0.5 智能剪贴板）

> 日期：2026-10-29 · 版本：0.5.0 · 平台：Windows 11 x64
> 结论先行：**P0/P1/P2 整改已落地；自动化门禁全部通过，真机验收脚本 46/46、
> 第三方应用矩阵 5/5 通过。整体判定 PASS**；微信与 Agent 类应用因环境原因
> 如实记为 `ENVIRONMENT BLOCKED / NOT VERIFIED`，不折算为通过。
> 分类证据与未解决项见 [10-remediation-acceptance.md](10-remediation-acceptance.md)；
> 未执行项不得写成“通过”。

## A. 源码审计与技术选型

审计对象：现有 Task Dock v0.4（Tauri v2 + Rust + React 19 + SQLite WAL，
`Db(Mutex<Connection>)` + `PRAGMA user_version` 迁移 + `application_settings` 键值设置）。

候选方案对比：

| 方案 | 能力 | 结论 |
|---|---|---|
| `tauri-plugin-clipboard-manager` | 文本/HTML/图片读写 | 不满足：无文件列表、无 CF_DIB、无格式监听、无来源应用、无序列号隔离 |
| `clipboard-rs` | 跨平台多格式（含文件/图片） | 可用但 HTML 偏移、忽略标记、自写入序列号、焦点/提权判断仍需平台代码；引入额外依赖收益有限 |
| CopyQ | 完整剪贴板管理器 | 外部 C++ 进程、GPL、无法嵌入本应用，排除 |
| **Win32 直连（windows-sys）** | 全格式、监听、序列号、SendInput、UIPI | **采用**：`windows-sys` 已是既有依赖；新增仅 `png`/`sha2`/`base64`（Cargo.lock 已有传递依赖） |

复用：现有 SQLite 库与迁移机制、设置存储、`AppHandle` 事件、任务表、玻璃主题组件、
桥接层（`src/lib/bridge.ts`）。未引入第二套状态/数据库，未改动任务与 Agent 主流程。

## B. 已实现功能与代码位置

| 功能 | 位置 |
|---|---|
| 剪贴板监听（三个线程 + 有界队列；消息窗口只入队） | `src-tauri/src/clipboard/platform.rs:1274`、`:1361`、`:1433` |
| 监听诊断计数（observed/merged/captured/dropped/peak/latency） | `platform.rs:191`、`:211`；`commands/clipboard.rs:534` |
| 读取优先级/格式解析（HDROP/PNG/DIBV5/DIB/HTML/Unicode） | `src-tauri/src/clipboard/platform.rs:449` 起 |
| 类型判定与去重哈希、HTML 清洗、敏感模式、保守凭据模式 | `src-tauri/src/clipboard/engine.rs`、`:211` |
| 自动分组（45s 可配、文本插入保持顺序、300/组） | `engine.rs` + `store.rs` |
| 入库/资产落盘/配额/保留期/引用安全删除 | `src-tauri/src/clipboard/store.rs` |
| 分组管理（建/关/合并/拆分/重排/改名/收藏/置顶） | `store.rs` |
| 单项与整组复制（富文本/多文件） | `commands/clipboard.rs:131`、`:159`、`:190` |
| 进程级访问锁 + 内容守卫的安全写入（含自写序列号原子登记） | `platform.rs:1122`、`:1230`、`:1237`、`:1289`、`:1313` |
| 逐项粘贴状态机、写前/写后内容确认、分类型间隔、独立收尾、取消/续跑 | `src-tauri/src/clipboard/paste.rs:209`、`:227`、`:389`、`:583` |
| 粘贴期间用户复制保护（写前+写后锁内内容比较，序列号只作快速变化检测） | `paste.rs`、`platform.rs` |
| 剪贴板快照与有损恢复说明 | `platform.rs:583`、`:1025`、`:1289` |
| 任务关联/快照关联 | `store.rs` |
| Agent 能力矩阵与本地导出（显式触发、不上传） | `src-tauri/src/clipboard/agent_bridge.rs:51` |
| IPC 命令注册（41 个，含 `clipboard_status.monitor`） | `src-tauri/src/lib.rs`、`commands/clipboard.rs` |
| 前端抽屉/分组详情/粘贴面板/任务关联/Agent 导出 | `src/components/clipboard/*`、`src/store/useClipboardStore.ts` |
| 复制预检（6 MB 图片预算、512 KB HTML 降级、文件模式提示） | `src/lib/clipboardUi.ts:56`、`:74` |
| 数据库迁移 v7（剪贴板表）+ v9（快照关联） | `src-tauri/src/db/mod.rs` |
| 性能采样/预算测试 | `src-tauri/tests/clipboard_perf.rs` |

## C. 文件变更清单（本次整改，剪贴板相关）

后端：

- `src-tauri/src/clipboard/platform.rs`：三线程采集、有界队列与计数、`filter_capture`
  纯函数、来源未知保守策略、basename 排除匹配、panic 隔离、`ACCESS_LOCK`、
  内容守卫写入、`write_guarded_notifying`（锁内登记自写序列号）、
  `restore_if_own_content`、`WriteOutcome`/`RestoreOutcome`。
- `src-tauri/src/clipboard/paste.rs`：条目状态机、写前/写后内容确认、分类型间隔、
  独立收尾、写入后立即从 remaining 移除、`PasteIo` 注入接口、16 例竞态测试。
- `src-tauri/src/clipboard/engine.rs`：`conservative_sensitive_reason` 与测试。
- `src-tauri/src/clipboard/store.rs`：图片落盘失败不留半行测试。
- `src-tauri/src/db/mod.rs`：粘贴间隔默认值测试。
- `src-tauri/src/clipboard/agent_bridge.rs`：能力矩阵（直接发送不支持 / 文件导入未验证 /
  桌面粘贴需窗口 / 本地导出可用）。
- `src-tauri/src/commands/clipboard.rs`：`clipboard_status.monitor` 暴露。
- `src-tauri/tests/clipboard_perf.rs`：队列/性能记录更新。

前端：

- `src/lib/clipboardUi.ts` + `.test.ts`：来源未知文案、`copyPreflight` 与 9 例测试。
- `src/components/clipboard/PastePanel.tsx` + `.test.tsx`：逐项状态、确认计数/未确认、
  分类型间隔提示、取消/继续。
- `src/components/clipboard/ClipboardDrawer.test.tsx`、`AgentExportPanel.test.tsx`。
- `src/components/clipboard/ClipboardGroupDetail.tsx`：复制预检提示。
- `src/components/clipboard/ClipboardDrawer.tsx`：进入任务关联模式时固定回到「历史」
  并清空选择（抽屉常驻挂载，避免上次停在「分组」导致无条目可选）。
- `src/styles.css`：关联模式抽屉 `z-index:70`（叠在任务编辑弹窗 60 之上）；
  删除确认框恢复 `pointer-events:auto`（父层为 `pointer-events:none`）。
  两处均为真机验收发现的真实 UI 缺陷，见 `10` 文档。
- `src/components/settings/SettingsPanel.tsx`：分类型间隔、来源未知保守策略说明、
  排除名单说明。

文档：更新 `02`、`04`、`05`、`06`、`07`、`08`、`09`，新增 `10-remediation-acceptance.md`；
同步 `docs/ARCHITECTURE.md`、`docs/TESTING.md`、`docs/PERFORMANCE_ARCHITECTURE.md`、`README.md`。

说明：本工作区同时存在 v0.5 其他方向（actions/context/workspace/agent pipeline、
性能文档）的改动，**不属于本次剪贴板整改**，未回退、未纳入本报告结论。

## D. 文档清单

`docs/clipboard/`：

1. `01-requirements.md`：需求与验收口径
2. `02-architecture.md`：模块划分、三线程采集、写入并发模型
3. `03-data-model.md`：表结构/索引/迁移/引用规则
4. `04-monitor-security.md`：监听、队列、格式、来源推断、隐私与限制
5. `05-grouping-engine.md`：分组状态机与不变量
6. `06-copy-paste-protection.md`：安全写入、粘贴状态机、快照/恢复边界
7. `07-ui-and-integrations.md`：抽屉 UI、复制预检、任务/Agent 能力
8. `08-testing-performance.md`：测试矩阵、性能实测、阻塞项
9. `09-implementation-report.md`：本文件
10. `10-remediation-acceptance.md`：整改分类验收（自动证明/真机证明/仅代码审查/未验证/未解决/环境阻塞）

## E. 测试结果

完整记录见 `08-testing-performance.md`，摘要：

| 检查 | 结果 |
|---|---|
| `cargo fmt --check` | 通过 |
| `cargo clippy --all-targets --all-features` | 通过，0 警告 |
| `cargo test --all-targets` | **244 passed / 0 failed / 0 ignored**（lib）；10 个 ignored 手动/真机测试 |
| `npx tsc --noEmit` | 通过 |
| `npx vitest run` | **16 文件 / 109 测试通过** |
| `npm run build` | 通过（459.80 kB JS / 67.70 kB CSS） |
| `npx tauri build`（release） | 通过，4m49s：NSIS 3.98 MiB / MSI 6.11 MiB（10:16） |
| release 剪贴板性能 | 2/2 通过，列表 p95 1.001 ms、200 连拍 2.799 s（预算 8 s） |
| 真机验收（隔离实例 + 真实剪贴板） | **46/46 PASS**（final13） |
| 第三方应用矩阵 | **5/5 PASS**（记事本/资源管理器/Edge 文本/Edge 富文本/VS Code）；微信 ENVIRONMENT BLOCKED、Agent NOT VERIFIED |

## F. 兼容性

- 格式层：CF_UNICODETEXT、CF_HTML、PNG+CF_DIB、CF_HDROP 均有单元测试与真机读回；
  内容守卫/恢复由 C11 真机证明。
- 应用层：记事本（3 项有序）、资源管理器（CF_HDROP 落盘）、Chromium/Edge
  文本框与 contenteditable 富文本、VS Code（保存后磁盘读回）均 **PASS**；
  微信（已登录真实会话）为 **ENVIRONMENT BLOCKED**，Trae CN（登录/引导页）
  为 **NOT VERIFIED**。
- 不把格式层单元测试折算为应用层兼容性证明，也不把未验证应用写成“支持”。

## G. 性能与安全

性能（release，本机 20 逻辑 CPU）：

- 1000 条文本入库 0.072 ms/条；列表 80 条 p95 2.659 ms；搜索 p95 0.746 ms；
- 300 条历史（含 100 图）列表 200 条 p95 **1.185 ms**（预算 120 ms）；
- 200 张 1080p 连拍入库+配额清理 **2.799 s**（预算 8 s），配额清理后 30.2 MB；
- 与整改前记录（5.846/6.632 s）相比更快，但主要来自文件系统热缓存，不能全部归因于代码；
- 未测量：WebView 帧率、空闲 CPU/内存、30 分钟长跑、真实监听计数采样（见 §H）。

安全与保护：

- 写入：进程级 `ACCESS_LOCK` 串行化本进程全部剪贴板访问（修复同进程线程互踩句柄）；
  内容守卫在锁内比较；不匹配绝不 `EmptyClipboard`；用户主动复制与逐项粘贴串行化。
- 粘贴：逐项状态机；`InputSent` 不升级为 `confirmed`；写入后立即从 remaining 移除，
  失败不盲目重发；写后再次锁内确认内容才发送按键；取消保留未处理项；收尾阶段结束后才恢复。
- 恢复：仅在剪贴板内容仍等于任务最后写入时恢复；外部更新 → `KeepUserCopy`，绝不覆盖。
- 监听：消息线程只入队；事件 64 / 内容 8 条 /128 MB 有界；丢弃计数；Windows 剪贴板
  不可回放已在文档声明；自写序列号在写入锁内原子登记，采集线程锁内复核。
- 隐私：全局暂停/停用、应用排除名单（basename）、系统敏感标记、高置信敏感模式、
  来源未知保守凭据模式；日志不含正文/路径/完整图片/令牌；不宣称 100% 识别。
- Agent：能力矩阵如实（直接发送不支持、文件导入未验证、桌面粘贴仅手动、导出本地）；
  无网络上传、无自动发送、不绕过权限。
- 粘贴最终文案固定为“已发送 N/M 项粘贴动作；目标应用是否接收无法自动验证”。

## H. 遗留问题（P0/P1/P2）

**已解决（原 P0）**

1. 真机剪贴板链路/逐项粘贴/第三方应用兼容性：2026-10-29 未锁屏桌面完成验收
   **46/46 PASS**，第三方矩阵 **5/5 PASS**；原锁屏阻塞已解除。
2. 同进程剪贴板访问竞态：真机复现“写入后验证读到 None 被误判为用户接管”，
   用进程级 `ACCESS_LOCK` + 内容守卫 + 锁内自写登记修复；C3（3 项有序）与
   C11（用户中途复制不被覆盖）真机通过。
3. 任务关联 UI 缺陷：关联模式抽屉被任务编辑弹窗遮罩拦截（z-index）、
   删除确认框继承 `pointer-events:none` 不可点击；均已修复，D1/D3 真机通过。

**P1（功能/性能风险，不阻断发布但必须知晓）**

4. 微信（已登录真实用户会话）与 Agent 类应用（Trae CN 登录/引导页）未验证，
   记为 `ENVIRONMENT BLOCKED / NOT VERIFIED`；未用单元测试替代。
5. 截图 PNG 编码约 95–191 ms/张（采集阶段），连续截图的真实体感受此限制。
6. 默认 512 MB 配额仅约容纳 220 张 1080p PNG 截图，长期使用会频繁触发清理。
7. WebView 帧率、空闲 CPU/常驻内存、30 分钟以上稳定性、大分组滚动、
   多显示器/DPI 未测量。
8. 图片/文件粘贴到图形界面应用未验证（仅验证记事本拒绝图片时如实报告）。
9. 富文本/图片/文件恢复均为有损（文档已声明）；私有格式不支持。
10. `clipboard_link_snapshot` 等快照关联命令已实现但未接入 UI（P2 级部分完成）。

**P2（工程/体验）**

11. 仓库无 ESLint 配置，前端 lint 未执行（未以禁用规则方式造假）。
12. 安装/卸载/签名未验证；产物未签名。
13. 前端主包 459.80 kB（gzip 137.35 kB），暂无代码分割；不影响本次功能。
14. 工作区存在非剪贴板方向的并行改动，交付前未清理，避免影响其他工作。
15. 前端测试早前在重负载下出现 5 s 超时抖动，本次全量通过（未改阈值掩盖）。

## I. 最终结论

| 维度 | 结论 |
|---|---|
| 代码实现 | **已完成**：三线程监听、访问锁与内容守卫、粘贴状态机、隐私策略、Agent 能力矩阵、UI 提示与两处真机 UI 修复 |
| 自动化测试 | **通过**：Rust 244、前端 109、fmt/clippy（0 警告）/tsc/build、release 性能预算 2/2 |
| 打包 | **通过**：NSIS 3.98 MiB / MSI 6.11 MiB（4m49s；未签名、未做安装/卸载实测） |
| 真机验收 | **通过（核心）**：46/46 + 第三方矩阵 5/5；微信/Agent 应用环境阻塞，未验证项已列明 |
| 文档 | **已完成**：01–10 与代码同步 |
| 总体 | **PASS**：核心 P0 已修复并有真机证据；未验证项与已知有损边界均如实记录，不声称“所有应用均已验证” |
