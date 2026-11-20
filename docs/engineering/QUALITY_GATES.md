# 质量门禁（QUALITY GATES）

| 项目 | 内容 |
|---|---|
| 文档状态 | 生效（Phase 1，待评审；Phase 2 落地工具） |
| 最后更新 | 2026-11-19 |
| 适用范围 | 全项目 CI/本地提交前检查 |
| 相关 | [架构守卫设计](../refactoring/REFACTOR_ROADMAP.md#phase-2自动化架构守卫) |

---

## 1. 门禁分层

**原则：门禁强度与风险匹配。** Release 构建**不是**每个普通任务的强制门禁；
日常开发在 Dev 实例上就能完成真实的功能验证。

| 门禁 | 触发 | 当前策略 |
|---|---|---|
| 类型检查 | 提交前 | `npm run typecheck`（strict）强制 |
| 单元测试 | 提交前 | `npm test` 强制；`cargo test` 强制 |
| 格式 | 提交前 | `cargo fmt --check` 强制；前端格式工具待引入 |
| Lint | 提交前 | ESLint/Biome 待评估引入 |
| 架构守卫 | 提交前 | **报告模式 → 逐步强制**（见 §3） |
| 契约测试 | 提交前 | 待建立（Phase 2/3） |
| Dev 功能验证 | 日常开发 / 模块交付 | `npm run tauri dev` 真实桌面实例（**默认门禁**，不需安装包） |
| 集成/真机 | 按功能风险 | 走 Integration Snapshot，真机按 ACCEPTANCE_ROUTING |

### 1.1 四级门禁（按交付层级）

| 层级 | 何时触发 | 必须做什么 | 不要求做什么 |
|---|---|---|---|
| **日常开发** | 每次改动 | 定向自动化测试（受影响范围）+ 类型检查 + **Dev 实例功能验证** | 安装包、Release 构建、`buildId` |
| **模块交付** | 模块完成、`task ready` 前 | 在交付提交上**真实执行**模块级检查（`task verify`）+ Dev 实例完整链路验证 + 证据记录 | 为单个模块单独打安装包 |
| **集成验收** | 需要跨模块结论或 Release 专属结论时 | 按功能风险选择 Dev 或 Release：跨模块链路可在 Dev 上验证；安装/升级/卸载、生产资源加载、正式性能必须走 Release | 无关模块的全量端到端 |
| **正式发布** | 里程碑 / 正式交付版本 | Release 构建（Integration Snapshot → Build → Accept）+ 对应正式验收 | — |

**规则**：

- **不得把 Release 构建设为每个普通任务的强制门禁**；"要做验收"不构成先出安装包的理由。
- Dev 验收**不修改** `verifying` / `accept-passed` / `accept-failed`，**不生成** `buildId`；
  结论只写「Dev 功能验收通过 / 部分通过 / 不通过 / 证据不足」。
- 需要 Release 专属结论时**不得**用 Dev 结果顶替，反之亦然。
- 一次 Release 构建应尽量覆盖多个已完成任务；不允许每个 Agent 为自己的模块单独出包。
- 门禁不通过就修，不降级为"记录在案"。

## 2. 已有守卫（保留）

`build-guard.mjs`（产物/磁盘）、`worktree-guard.mjs`（隔离）、`rail-contract.mjs`（导航契约）、`check-entry-css.mjs`（CSS 作用域）、`on-demand-audit.mjs`（首屏体积）、`visual-audit.mjs`（视觉）。

## 3. 架构守卫三阶段（新增，核心交付）

### 阶段一：报告模式（当前，已落地）
- 统计现状、建立基线、只报告违规、不阻断构建。
- 基线：`tmp/acceptance/architecture-governance/baseline.json`（head 7485d92，25 违规 / 23 例外 / 2 有效）。
- 现有 V1–V7 记入基线例外（见 MODULE_DEPENDENCIES.md §2）。
- 使用命令：

```bash
npm run arch:guard          # 报告模式（人类可读）
npm run arch:guard:json     # 机器可读
npm run arch:deps           # 依赖图 Mermaid
npm run arch:boundary       # 模块边界检查
npm run arch:dupes          # 重复源码树检查
node --test scripts/architecture/architecture-guard.test.mjs   # 守卫自测
```

- 规则与例外在 `scripts/architecture/architecture-rules.json`；每个例外必须有 `reason` 与 `exitWhen`（单测保证）。
- 阶段升级：改 `architecture-rules.json` 的 `stage` 为 `staged`/`enforced`。

### 阶段二：新代码禁止新增违规
- 对新增/修改文件强制检查（按 git diff 范围）。
- 已治理模块启用强制检查（路径白名单）。
- 基线违规冻结，不允许增长。

### 阶段三：全局强制
- 逐模块清理历史违规，完成后升级为全局强制。
- 违规数归零或仅剩带退出条件的例外。

**禁止**：为让检查通过而大量添加忽略规则。每个例外必须有理由 + 退出条件，记入 `architecture-rules.json`。

## 4. 新增依赖评估

引入 ESLint/Prettier/Biome/dependency-cruiser 等前必须评估：维护成本、体积、兼容性、与现有工具重叠。优先复用现有依赖。不为引入工具做大范围格式化。

## 5. 文档一致性门禁

- README/架构文档的关键数字（迁移版本、备份表数、featureCatalog 数）由架构守卫校验，漂移即报告。
- 文档与源码冲突以源码为准，发现偏差更新文档（当前已知 v33/v43 漂移待修正）。

## 6. 真机与性能门禁

- 真实窗口/通知/剪贴板/DPI/多显示器/贴边必须原生验收；jsdom/单测/预览截图不能替代。
- **Dev 实例即真实运行环境**：Dev 模式跑的是真实 Tauri Debug 桌面应用（真实 WebView2、真实
  SQLite、真实 IPC、真实 Win32 窗口），可直接用于功能验收与原生验收（通道 C/E）。
- 但**正式性能结论必须走 Release**：Debug 未优化，不能出性能、内存、动画流畅度、启动耗时结论；
  安装/升级/卸载、签名与更新、生产资源加载同样只能由 Release 验收证明。
- 性能结论附可复核条件；`#[ignore]` 套件不计普通通过。
- 环境失败记 `ENVIRONMENT BLOCKED`，不标通过也不臆断为代码缺陷。
