//! 资源管理分区内的稳定锚点：概览卡片跳转到磁盘/内存的具体区块。
//!
//! 这里只声明可定位目标，不包含滚动实现；滚动与焦点由
//! `ResourceManagementPanel` 在布局阶段统一处理（不使用固定延时）。

/** 磁盘分区内可定位的区块。 */
export type DiskAnchor = "volumes" | "junk" | "app-cache" | "analysis" | "storage";

/** 内存分区内可定位的区块。 */
export type MemoryAnchor = "reclaim";

/** 概览卡片可跳转的目标：分区 + 锚点。 */
export type ResourceTarget =
  | { segment: "disk"; anchor: DiskAnchor }
  | { segment: "memory"; anchor: MemoryAnchor };

/** 磁盘分区渲染顺序（也是信息架构顺序：容量 → 清理 → 分析 → 占用）。 */
export const DISK_ANCHORS: readonly DiskAnchor[] = [
  "volumes",
  "junk",
  "app-cache",
  "analysis",
  "storage",
];
