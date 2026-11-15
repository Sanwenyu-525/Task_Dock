// 采集配额：数量 / 单件大小 / 合计大小的唯一来源。
//
// 为什么单独成文件：UI 预检（采集页批量导入）、数据库守卫（addStashItem）、
// 原生分享（Kotlin）三处必须用同一组上限，否则会出现「界面显示还能加、入库却失败」，
// 或者「先复制进私有存储再被 UI 隐藏」。这里只放纯函数，便于单测覆盖边界。
export const MAX_CAPTURE_ITEMS = 9;
export const MAX_CAPTURE_ITEM_BYTES = 50 * 1024 * 1024;
export const MAX_CAPTURE_TOTAL_BYTES = 200 * 1024 * 1024;

export type QuotaRejectReason = "count" | "item_size" | "total_size";

export interface QuotaCandidate {
  size?: number | null;
  name?: string | null;
}

export interface QuotaAccept {
  index: number;
  /** 来源声明的大小；未知按 0 记账，落盘后再以真实字节校验 */
  size: number;
}

export interface QuotaRejection {
  index: number;
  name: string;
  reason: QuotaRejectReason;
  /** 被拒项的声明大小（未知为 0） */
  size: number;
}

export interface QuotaDecision {
  accepted: QuotaAccept[];
  rejected: QuotaRejection[];
  /** 接收后本次采集的合计字节 */
  acceptedBytes: number;
  /** 拒绝项声明的字节合计（用于提示「还有 X MB 未加入」） */
  rejectedBytes: number;
}

export interface QuotaInput {
  /** 当前已暂存的项数 */
  itemCount: number;
  /** 当前已暂存的合计字节 */
  usedBytes: number;
  candidates: readonly QuotaCandidate[];
  maxItems?: number;
  maxItemBytes?: number;
  maxTotalBytes?: number;
}

function normalizeSize(size: number | null | undefined): number {
  return typeof size === "number" && Number.isFinite(size) && size > 0 ? size : 0;
}

/**
 * 纯函数：按时序决定哪些候选可以加入本次采集。
 *
 * 规则：
 * - 先到先得：前面的项占满名额/额度后，后面的项被拒（不跳过后面的小文件去挑大文件）；
 * - 数量上限优先判定：已达上限的项直接 `count`，不再做大小判断（提示更贴近用户操作）；
 * - 大小未知（content:// 常见）按 0 记账，允许通过预检，真实字节由存储层与 DB 守卫兜底；
 * - 单件超限与合计超限分别给出不同理由，UI 才能说清「换小文件」还是「先移除一些」。
 */
export function planCaptureBatch(input: QuotaInput): QuotaDecision {
  const maxItems = input.maxItems ?? MAX_CAPTURE_ITEMS;
  const maxItemBytes = input.maxItemBytes ?? MAX_CAPTURE_ITEM_BYTES;
  const maxTotalBytes = input.maxTotalBytes ?? MAX_CAPTURE_TOTAL_BYTES;

  let count = Math.max(0, Math.floor(input.itemCount));
  let bytes = Math.max(0, input.usedBytes);
  const accepted: QuotaAccept[] = [];
  const rejected: QuotaRejection[] = [];
  let rejectedBytes = 0;

  input.candidates.forEach((candidate, index) => {
    const size = normalizeSize(candidate.size);
    const name = (candidate.name ?? "").trim();
    if (count >= maxItems) {
      rejected.push({ index, name, reason: "count", size });
      rejectedBytes += size;
      return;
    }
    if (size > maxItemBytes) {
      rejected.push({ index, name, reason: "item_size", size });
      rejectedBytes += size;
      return;
    }
    if (bytes + size > maxTotalBytes) {
      rejected.push({ index, name, reason: "total_size", size });
      rejectedBytes += size;
      return;
    }
    accepted.push({ index, size });
    count += 1;
    bytes += size;
  });

  return { accepted, rejected, acceptedBytes: bytes, rejectedBytes };
}

export function describeQuotaRejection(reason: QuotaRejectReason): string {
  switch (reason) {
    case "count":
      return `一次最多 ${MAX_CAPTURE_ITEMS} 项`;
    case "item_size":
      return `单个不能超过 ${Math.round(MAX_CAPTURE_ITEM_BYTES / (1024 * 1024))}MB`;
    case "total_size":
      return `合计不能超过 ${Math.round(MAX_CAPTURE_TOTAL_BYTES / (1024 * 1024))}MB`;
  }
}

/** 暂存合计字节：UI 与上限判定共用，避免两处各算一遍。 */
export function stashTotalBytes(items: readonly { size: number }[]): number {
  return items.reduce((sum, item) => sum + normalizeSize(item.size), 0);
}
