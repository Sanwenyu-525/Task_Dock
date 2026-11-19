# 错误处理规范（ERROR HANDLING）

| 项目 | 内容 |
|---|---|
| 文档状态 | 生效（Phase 1，待评审） |
| 最后更新 | 2026-11-19 |
| 适用范围 | 全项目 |
| 上级 | [编码规范](CODING_STANDARDS.md) |
| 事实依据 | 审计 P0-2：错误模型三处重复定义、契约不一致 |

---

## 1. 现状问题

三套 `AppError` 同名但字段/码集/语义各异：

| 端 | 文件 | 码集 |
|---|---|---|
| Rust | `src-tauri/src/error.rs:16-47` | PascalCase 14 码 |
| 桌面前端 | `src/lib/errors.ts:14-34,76-148` | 17 码白名单 |
| 移动端 | `apps/mobile/src/lib/errors.ts:22-60` | 小写码集 |

前端另有 `errorReport.ts`、`globalErrors.ts`、`i18n/errors.ts` 分担职责。后端 `meta()` 不产生前端白名单中的部分码。

## 2. 统一错误模型（目标）

继承现有 `AppError`，统一字段：

| 字段 | 含义 |
|---|---|
| ErrorCode | 稳定的机器可读码（跨端契约，单一事实源） |
| Category | 分类（validation / not_found / permission / network / storage / conflict / internal / cancelled…） |
| Severity | 严重度（info / warn / error / fatal） |
| Retryable | 是否可重试 |
| OperationId | 本次操作 ID（幂等/追踪） |
| CorrelationId | 跨端/跨调用追踪 ID |
| UserMessage | 用户可读提示（可本地化，由 i18n 提供） |
| TechnicalDetail | 技术细节（仅日志，不抛给用户） |

**单一事实源**：建立跨端错误码表 `shared/contracts/error-codes.json`（或 Markdown 表格 + 校验脚本），三端码集由其派生；契约测试校验一致性。

## 3. 错误分类与处理路径

| 类别 | 处理 |
|---|---|
| 用户输入错误 | 就地校验提示，不进错误日志 |
| 可重试（网络/忙/超时） | 带退避重试（有界），耗尽后提示 |
| 权限/安全 | fail-closed，记审计元数据，不泄露细节 |
| 数据损坏/存储 | 状态机恢复/回滚，提示用户，记详细日志 |
| 内部错误 | 统一兜底，记 TechnicalDetail，用户看通用提示 |
| 取消 | **不算失败**；单独状态，不触发错误通知，不算入失败统计 |

## 4. 规范

- 不吞异常：每个异步错误有明确处理路径；`catch` 必须要么处理要么包装上抛。
- 不重复记录：同一错误在边界记录一次（Converter），上层不重复记。
- 不记敏感信息：正文/图片/路径/密钥/令牌不进日志与错误对象。
- 用户提示与技术日志分离：UserMessage 走 i18n，TechnicalDetail 只进日志。
- 取消语义统一：TS `AbortSignal` / Rust CancellationToken，取消不当错误。
- 错误码稳定后不随意变更；废弃码保留映射。

## 5. 迁移路线（Phase 3）

1. 建立跨端错误码表与契约测试（不改运行时）。
2. 前端 `errors.ts` 保持公开 API，内部对齐码表；`errorReport.ts` 去掉对 store 的反向依赖（改事件上抛）。
3. Rust `error.rs` 补齐码表未覆盖项；`meta()` 与前端白名单对齐。
4. 移动端对齐码表；契约测试三端通过。
5. 兼容层（旧码映射）保留至无引用后废弃。

## 6. 测试要求

- 错误码映射表契约测试（三端一致）。
- 每类错误的处理路径单测（可重试/不可重试/取消）。
- 敏感信息不落日志测试（注入敏感值，断言日志无该值）。
