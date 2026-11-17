// 生活同步延后项的展示口径：把内部 reason 翻译成普通用户能理解的中文，
// 并给出安全处理建议。只做展示与分类，不在此处重试或改数据库。
import type { DeferredLifeChange, LifeDeferReason, LifeEntity } from "../db/lifeSync";

export const ENTITY_LABEL: Record<LifeEntity, string> = {
  life_item: "生活商品",
  life_event: "生活记录",
  life_event_item: "购买明细",
  life_document_link: "票据关联",
};

export interface DeferReasonMeta {
  label: string;
  explanation: string;
  suggestion: string;
  /** 可交给自动重放/批量重试安全处理。 */
  autoRetryable: boolean;
  /** 允许用户单条“重新校验”，失败也不会删除数据。 */
  manualRetryable: boolean;
  tone: "wait" | "conflict" | "danger";
}

export const DEFER_REASON_META: Record<LifeDeferReason, DeferReasonMeta> = {
  dependency: {
    label: "等待关联数据",
    explanation: "这条记录依赖的商品或购买记录还没同步到本机，暂时不能落库。",
    suggestion: "保持同步即可：依赖到达后系统会自动重放，也可以点“重试”立即再检查一次。",
    autoRetryable: true,
    manualRetryable: true,
    tone: "wait",
  },
  pending_outbox: {
    label: "本机修改尚未发送",
    explanation: "本机对同一条记录还有未发送的修改，直接应用桌面版本会覆盖你刚改的内容。",
    suggestion: "先完成同步把本机修改发出去；待发送队列清空后，这条记录会恢复。",
    autoRetryable: true,
    manualRetryable: true,
    tone: "wait",
  },
  name_conflict: {
    label: "同名商品需要选择",
    explanation: "桌面端已有同名但 ID 不同的商品，直接合并可能丢失一边的购买历史。",
    suggestion: "到“处理冲突”页选择保留哪一边或关联到已有商品；关联完成后这里会自动清除。",
    autoRetryable: false,
    manualRetryable: false,
    tone: "conflict",
  },
  duplicate_link: {
    label: "票据关联已存在",
    explanation: "本机已经有一模一样的票据关联，重复创建会产生两条相同记录。",
    suggestion: "确认已有票据即可；如果原关联已被删除，可点“重新校验”再应用。",
    autoRetryable: false,
    manualRetryable: true,
    tone: "conflict",
  },
  invalid: {
    label: "数据校验未通过",
    explanation: "这条变更的字段格式或业务规则不合法，自动重试不会成功，也不会删除本机数据。",
    suggestion: "查看详情与诊断信息，回到桌面端修正后重新同步；确认无需此条时可手动忽略。",
    autoRetryable: false,
    manualRetryable: true,
    tone: "danger",
  },
};

export function reasonMeta(reason: LifeDeferReason): DeferReasonMeta {
  return DEFER_REASON_META[reason] ?? DEFER_REASON_META.invalid;
}

function fieldText(row: DeferredLifeChange, key: string): string {
  const value = row.fields[key];
  return typeof value === "string" ? value.trim() : "";
}

/** 列表标题：优先用业务名称，取不到再退回实体 + 短 ID，绝不显示整段 JSON。 */
export function deferredTitle(row: DeferredLifeChange): string {
  if (row.entity === "life_item") {
    return fieldText(row, "name") || "未命名商品";
  }
  if (row.entity === "life_event") {
    return fieldText(row, "title") || "未命名生活记录";
  }
  if (row.entity === "life_event_item") {
    return fieldText(row, "itemNameSnapshot") || "购买明细";
  }
  return fieldText(row, "documentName") || "票据关联";
}

/** 短 ID：列表足够定位，详情再展开完整 ID；不把长 UUID 挤进一行。 */
export function shortTargetId(targetId: string): string {
  if (targetId.length <= 12) return targetId;
  return `${targetId.slice(0, 8)}…`;
}

export function isAutoRetryable(row: DeferredLifeChange): boolean {
  return reasonMeta(row.reason).autoRetryable;
}

export function isManualRetryable(row: DeferredLifeChange): boolean {
  return reasonMeta(row.reason).manualRetryable;
}

/** 处理状态：让用户一眼区分“等待”与“需要你处理”，而不是统一显示同步失败。 */
export function deferredStatusLabel(row: DeferredLifeChange): string {
  if (row.reason === "dependency" || row.reason === "pending_outbox") return "等待自动恢复";
  if (row.reason === "name_conflict") return "需要选择";
  if (row.reason === "duplicate_link") return "需要确认";
  return "需要处理";
}

export function formatDeferredTime(ms: number): string {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "—";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}
