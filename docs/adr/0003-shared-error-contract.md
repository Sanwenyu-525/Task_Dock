# ADR-0003 建立跨端统一错误契约，三端 AppError 归一

| 项目 | 内容 |
|---|---|
| 状态 | Accepted |
| 日期 | 2026-11-19 |

## 1. 背景
审计 P0-2：Rust/桌面/移动各有一套同名 `AppError`，码集/字段/语义不一致，前端白名单有后端不产生的码。

## 2. 当前问题
错误信息跨端不一致；错误提示与日志混杂；新增码无统一登记。

## 3. 决策
建立跨端错误码单一事实源（`shared/contracts/error-codes.json` 或等价表），统一 ErrorCode/Category/Severity/Retryable/OperationId/CorrelationId/UserMessage/TechnicalDetail；三端码集由该表派生，配契约测试。继承现有 `AppError` 理念，不新造机制。

## 4. 备选方案
A. 各端独立（现状）；B. 统一契约（选中）；C. 全端单一运行时错误类（跨语言不可行）。

## 5. 选择原因
B 保证一致性与可测试性，又不要求跨语言共享运行时代码。

## 6. 优点
错误语义统一；契约可测；用户提示可本地化。

## 7. 缺点
需维护码表；迁移期需兼容映射。

## 8. 影响模块
`error.rs`、`src/lib/errors.ts`、`apps/mobile/src/lib/errors.ts`、`errorReport.ts`、`i18n/errors.ts`。

## 9. 迁移计划
见 ERROR_HANDLING.md §5；旧码映射保留至无引用。

## 10. 测试要求
三端错误码契约测试；敏感信息不落日志测试；取消语义测试。

## 11. 回滚条件
契约测试无法对齐或改动用户可见错误提示时暂停。
