# 编码规范（CODING STANDARDS）

| 项目 | 内容 |
|---|---|
| 文档状态 | 生效（Phase 1，待评审） |
| 最后更新 | 2026-11-19 |
| 适用范围 | 全项目 |
| 上级 | [目标架构](../architecture/TARGET_ARCHITECTURE.md) |
| 优先级 | 与 `AGENTS.md` 冲突时以 `AGENTS.md` 为准 |

---

## 1. 模块边界

每个模块必须明确并在 `index.ts` / `mod.rs` 公开出口中体现：

- 职责、公开接口、私有实现、依赖模块、被依赖模块；
- 数据所有权、状态所有权、生命周期、错误处理方式；
- 禁止访问其他模块内部文件（只经公开出口/接口）。

共享枢纽文件（同时写必须唯一所有者串行）：`src/lib/bridge.ts`、`navigationRegistry.ts`、`featureCatalog.ts`、`useUiStore.ts`、`src-tauri/src/lib.rs`、`commands/mod.rs`、`db/mod.rs`、全局样式与主题 Token、i18n、依赖与构建配置、数据库迁移与版本定义。

## 2. IPC 规范

- 业务 IPC 统一经 `src/lib/bridge.ts`；导航经 `src/lib/navigation.ts`。
- 参数 camelCase，Rust 侧 `rename_all = "camelCase"`；新增命令同步前端类型与 Rust 签名。
- 统一调用契约 `invokeCommand<T extends keyof CommandContracts>`（参数/返回类型、错误处理、取消、超时、日志追踪、多窗口上下文、旧调用兼容），详见 [IPC_ARCHITECTURE.md](../architecture/IPC_ARCHITECTURE.md)。
- 事件 `subscribeEvent<T>` 必须有 Unsubscribe 与清理路径。
- 命令层 thin，复杂编排下沉 Application，SQL 下沉 Repository。

## 3. 错误处理

继承现有 `AppError`，统一 ErrorCode/Category/Severity/Retryable/OperationId/CorrelationId/UserMessage/TechnicalDetail。详见 [ERROR_HANDLING.md](ERROR_HANDLING.md)。

- 用户错误提示与技术日志分离；取消不算普通失败；不吞异常；不重复记录；不记敏感信息；异步错误有明确处理路径。

## 4. 异步与并发

详见 [CONCURRENCY.md](CONCURRENCY.md)。要点：

- 可取消、超时、有界队列、并发限制、重复请求合并、幂等、资源释放、锁粒度、队列积压处理、后台任务监控。
- Rust：不跨 `.await` 持锁，长阻塞用 `spawn_blocking`，无界任务禁止。
- 前端：组件卸载后异步处理，避免重复请求/订阅/过期响应覆盖。

## 5. 数据库

继承现有 SQLite 设计。统一数据访问入口、事务边界、迁移机制、连接管理、错误映射；索引策略、查询性能分析、完整性约束、备份恢复、版本兼容。历史迁移只追加不改。详见 [DATABASE_ARCHITECTURE.md](../architecture/DATABASE_ARCHITECTURE.md)。

## 6. CSS

- 保留两套视觉预设 × 明暗 × 材质三正交维度；只用语义 Token（`styles-themes.css`/`styles-ui.css`），不硬编码颜色/圆角/阴影。
- 新弹层接入 `overlayStack.ts`；覆盖 320/400 窄窗、不同 DPI、深浅主题。
- 长文本截断/换行而非撑破布局；`-webkit-line-clamp` 必须与 `overflow:hidden` 同声明。
- 不为 CSS 重构改变已确认视觉设计。

## 7. 安全

见 [SECURITY.md](../architecture/SECURITY.md)。最小权限、路径校验、SQL 参数化、TLS/SPKI、配对授权、敏感信息不落日志/可提交文件。

## 8. 按需加载（前端强制）

页面只能经 `featureRegistry.ts` 登记，`FeatureView` 首次可见加载；禁 `React.lazy`；页面隐藏停轮询；策略 `keep`/`release`；`preload: "idle"` 仅一个。见 [FRONTEND_ARCHITECTURE.md](../architecture/FRONTEND_ARCHITECTURE.md) §2 与 `docs/ON_DEMAND_LOADING.md`。

## 9. 命名与注释

- 既有注释与文案保持原语言风格；默认简体中文。
- 范围最小：不整文件格式化、不顺手清理、不升级无关依赖。

## 10. 工具链现状与演进

- 当前：TypeScript strict、`npm test`（vitest）、`cargo fmt/clippy`（人工）、多个守卫脚本。
- 缺失：ESLint/Prettier/Biome（评估引入，先衡量维护成本/体积/兼容性）、循环依赖与架构边界检查（Phase 2 自建）。
- 不因引入工具改变既有代码风格或大范围格式化。
