//! 创作工作台 IPC 唯一调用点（2026-11-16，集成负责人维护）。
//!
//! ## 为什么不在 bridge.ts 里逐条加
//! `src/lib/bridge.ts` 是公共契约文件，五条线并行开发时同时改它必然互相覆盖。
//! 因此本文件是五条线专业命令的**唯一 invoke 出口**，由集成负责人独占维护；
//! 各领域在自己的 `ipc.ts` 里声明**命令名 + 参数/返回类型**，调用本函数。
//!
//! 约束：
//! 1. 参数一律 camelCase（Tauri 会把 camelCase 映射到 Rust 的 snake_case 形参）；
//! 2. 命令名必须与 `src-tauri/src/lib.rs` `generate_handler!` 中登记的一致；
//! 3. 禁止在专业模块组件里直接 `import { invoke }`，只允许经 `creativeInvoke`。

import { invoke } from "@tauri-apps/api/core";

/** 统一的专业命令调用入口。失败时抛出后端 `AppError` 序列化后的错误。 */
export function creativeInvoke<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  return invoke<T>(command, args);
}
