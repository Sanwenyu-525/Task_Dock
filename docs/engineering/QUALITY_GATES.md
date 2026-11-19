# 质量门禁（QUALITY GATES）

| 项目 | 内容 |
|---|---|
| 文档状态 | 生效（Phase 1，待评审；Phase 2 落地工具） |
| 最后更新 | 2026-11-19 |
| 适用范围 | 全项目 CI/本地提交前检查 |
| 相关 | [架构守卫设计](../refactoring/REFACTOR_ROADMAP.md#phase-2自动化架构守卫) |

---

## 1. 门禁分层

| 门禁 | 触发 | 当前策略 |
|---|---|---|
| 类型检查 | 提交前 | `npm run typecheck`（strict）强制 |
| 单元测试 | 提交前 | `npm test` 强制；`cargo test` 强制 |
| 格式 | 提交前 | `cargo fmt --check` 强制；前端格式工具待引入 |
| Lint | 提交前 | ESLint/Biome 待评估引入 |
| 架构守卫 | 提交前 | **报告模式 → 逐步强制**（见 §3） |
| 契约测试 | 提交前 | 待建立（Phase 2/3） |
| 集成/真机 | 交付/验收 | 走 Integration Snapshot + Build Scheduler，真机按 ACCEPTANCE_ROUTING |

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
- 性能结论附可复核条件；`#[ignore]` 套件不计普通通过。
- 环境失败记 `ENVIRONMENT BLOCKED`，不标通过也不臆断为代码缺陷。
