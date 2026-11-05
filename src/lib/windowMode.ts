//! 显示模式的读侧归一化（单一事实源）。
//!
//! 外壳（`App`）按 `mode` 决定哪一个 `.view-slot` 处于 `active`。三个模式之外
//! 的任意值（空串、旧版本/备份恢复带入的未知值、后端返回的损坏设置）都会让
//! **三个视图槽同时失活**：标题栏仍在、窗口背景仍在，但导航与内容区整块消失。
//!
//! 因此模式在进入 UI 前必须收敛到合法枚举：
//! - `"minimal" | "compact" | "full"` 原样返回；
//! - 缺失 / 非字符串 / 未知值 → `"full"`（安全页：导航与设置入口始终可达）。
//!
//! 只做内存归一化，不写库；持久化纠正仍由设置写入路径负责。

export type WindowMode = "minimal" | "compact" | "full";

const WINDOW_MODES: readonly WindowMode[] = ["minimal", "compact", "full"];

export function isWindowMode(value: unknown): value is WindowMode {
  return typeof value === "string" && (WINDOW_MODES as readonly string[]).includes(value);
}

export function resolveWindowMode(value: unknown): WindowMode {
  return isWindowMode(value) ? value : "full";
}
