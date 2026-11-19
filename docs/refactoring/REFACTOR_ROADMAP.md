# 重构路线图（REFACTOR ROADMAP）

| 项目 | 内容 |
|---|---|
| 文档状态 | 生效（Phase 1，待评审） |
| 最后更新 | 2026-11-19 |
| 适用范围 | 全项目重构执行顺序 |
| 上级 | [目标架构](../architecture/TARGET_ARCHITECTURE.md) |
| 配套 | [模块迁移矩阵](MODULE_MIGRATION_MATRIX.md)、[进度](REFACTOR_PROGRESS.md) |

---

## 阶段门禁（不可跳过）

```
Phase 0 审计 ──✓ 完成（2026-11-19）
   ↓
Phase 1 方案/规范/ADR ──← 当前，完成后需架构评审
   ↓
Phase 2 自动化守卫（报告模式建基线）
   ↓
Phase 3 基础设施重构
   ↓
Phase 4 业务模块重构
   ↓
Phase 5 前端/移动端治理
   ↓
Phase 6 整体验收（统一构建/测试/性能/安全/真机）
```

每阶段完成标准见本文各节；评审未通过不进入下一阶段。

---

## Phase 0：完整架构审计 ✅

交付：`CURRENT_STATE_AUDIT.md`（当前架构报告、模块目录、依赖图、超大型文件分析、重复代码、问题分级、风险清单、所有权调整）。**未修改业务代码。**

## Phase 1：架构方案和规范（当前）

交付：
- `TARGET_ARCHITECTURE.md` + 前端/后端/移动端/数据库/IPC/事件/模块依赖分架构文档；
- `DESIGN_PATTERNS.md`、`SECURITY.md`；
- `CODING_STANDARDS.md`、`ERROR_HANDLING.md`、`CONCURRENCY.md`、`RESOURCE_LIFECYCLE.md`、`TESTING_STRATEGY.md`、`QUALITY_GATES.md`；
- `docs/adr/README.md` + ADR 0002–0006；
- 本路线图 + 模块迁移矩阵 + 进度文档。

**门禁**：架构评审通过（检查文档与源码一致、决策有 ADR、无重复定义规范）。

## Phase 2：自动化架构守卫（核心交付）

建立 `scripts/architecture/`：

| 文件 | 职责 |
|---|---|
| `architecture-rules.json` | 规则配置 + 路径范围 + 例外（理由/退出条件） |
| `architecture-guard.mjs` | 主检查器：循环依赖、跨层反向依赖、UI 直连 DB、Domain 依赖 React/Tauri、Repository 依赖 UI、跨模块私有访问、页面未登记 registry、事件无释放、IPC 无类型契约、重复错误模型、未登记依赖、废弃 API 使用 |
| `dependency-graph.mjs` | 生成模块依赖图（输出 JSON/Mermaid） |
| `module-boundary-check.mjs` | 模块边界与公开出口检查 |
| `duplicate-source-check.mjs` | 重复源码树/重复实现检测 |
| `architecture-guard.test.mjs` | 守卫自身单测（node:test） |

先以报告模式运行，输出基线 `tmp/acceptance/architecture-governance/baseline.json`，不阻断构建（ADR-0005）。

## Phase 3：基础设施重构（第一批）

按模块迁移矩阵执行，每个模块提供：现有文件/函数清单、目标文件、函数迁移对照表、接口兼容方案、测试方案、回滚方案。

| 批次 | 模块 | 要点 |
|---|---|---|
| 3.1 | IPC Bridge | 保留 `bridge.ts` 导出，内部按域拆；建 `contracts/commands.ts`；收敛多出口 |
| 3.2 | Rust 数据库层 | 迁移文件化（红线 ADR-0004）；ConnectionManager；Repository trait |
| 3.3 | Rust 应用入口 | `lib.rs` 拆 app/bootstrap·commands·windows·lifecycle·cli |
| 3.4 | 错误处理 | 跨端错误码表；三端归一（ADR-0003）；errorReport 去 store 依赖 |
| 3.5 | 事件系统 | 统一 subscribeEvent/Unsubscribe；清理无释放监听 |
| 3.6 | 资源生命周期 | 取消/超时/释放规范化；修 pipeline 持锁跨 await |

## Phase 4：业务模块重构（第二批）

依次、独立执行，不同时改大量公共底层：Tasks → Files → Clipboard → Agents → Workspace → Vault → Workflows → Mobile Sync → Resource Cleanup → Recycle Bin。每个模块 Command 去 SQL、Application/Repository 化、状态机化（复杂流程）。

## Phase 5：前端与移动端治理（第三批）

- 前端：Store/Hooks/Services 职责收敛；Feature Registry/Navigation Registry 治理；Platform Adapter；Overlay Stack；CSS Token（保持按需加载）。
- 大型 UI 组件：`FilesWorkspacePanel`、`WorkbenchShell`、`FullView`、剪贴板页面、资源页面、Agent 页面、工作空间页面（组件/Hook/Service/Store 分清）。
- 移动端：本地 DB、安全通信、配对、同步、后台、文件传输、投屏；跨端协议统一契约 + 兼容性测试。

## Phase 6：整体验收

统一构建（Integration Snapshot + Build Scheduler）、全量测试、性能、安全、真机验收。所有结论以当次构建为准，不用历史结果冒充。

---

## 执行方法（强制）

1. 每次只改一个清晰架构边界（先拆内部保留导出 → 迁调用方 → 测试 → 无旧引用后废弃兼容层）。
2. Strangler Pattern：新旧短期共存，禁止长期双实现/双写，兼容层有退出条件。
3. 行为不变五要素：输入/业务规则/输出/数据格式/用户体验。发现 Bug 单独登记，不偷改。
4. 数据安全：隔离测试库，保留迁移历史，不动生产库、不清用户数据，验证备份恢复。
5. Agent 协作：主 Agent 统一决策/所有权/集成/验收；子 Agent 独立模块；公共接口变更主 Agent 批准；统一走 Integration Snapshot + Build Scheduler。

## 报告要求

每个重构任务写入 `tmp/acceptance/architecture-governance/<task>/`，含 20 项（任务目标→回滚方式），结论只用：通过 / 部分通过 / 不通过 / 证据不足。未执行测试明确标注。
