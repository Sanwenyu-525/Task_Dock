//! 场景步骤回执解析（纯函数）：`workflow_run_steps.result` → 逐项明细。
//!
//! 后端契约见 `enter_for_workflow` / `build_scene_step_receipt`（scenario.rs）：
//! result 为含 `outcome` 与 `items` 的 JSON。解析必须容错——null / 空串 / 非法
//! JSON / 缺 items 一律返回 null，绝不 throw；旧结构（items 只有 index/kind/
//! status，无 label/detail/outcome）也能展示：label 回退 `kind #index`，detail
//! 为空，outcome 由 items 状态推导。绝不伪造数据：未知状态原样透出。

export interface SceneReceiptItem {
  index: number;
  kind: string;
  label: string;
  /** ok | skipped | failed（未知值原样保留，展示层兜底） */
  status: string;
  detail: string | null;
}

export interface SceneReceipt {
  summary: string;
  scene_id: string | null;
  scene_name: string | null;
  total: number;
  processed: number;
  cancelled: boolean;
  timed_out: boolean;
  outcome: "completed" | "partial" | "cancelled";
  items: SceneReceiptItem[];
}

/** 条目状态 → 展示文案（与 WORKFLOW_STEP_STATUS_LABELS 同口径）。 */
export const SCENE_ITEM_STATUS_LABELS: Record<string, string> = {
  ok: "成功",
  skipped: "已跳过",
  failed: "失败",
  cancelled: "已取消",
};

export function sceneItemStatusLabel(status: string): string {
  return SCENE_ITEM_STATUS_LABELS[status] ?? status;
}

/** 条目状态 → 语义色 kind（配合 styles.css 的 kind-* 类）。 */
export function sceneItemStatusKind(status: string): "success" | "danger" | "muted" {
  switch (status) {
    case "ok":
      return "success";
    case "failed":
      return "danger";
    default:
      return "muted";
  }
}

export function parseSceneReceipt(result: string | null): SceneReceipt | null {
  if (!result) return null;
  let value: unknown;
  try {
    value = JSON.parse(result);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.items)) return null;
  const items: SceneReceiptItem[] = [];
  raw.items.forEach((entry, i) => {
    if (typeof entry !== "object" || entry === null) return;
    const it = entry as Record<string, unknown>;
    const kind = typeof it.kind === "string" && it.kind ? it.kind : "unknown";
    const index = typeof it.index === "number" ? it.index : i + 1;
    items.push({
      index,
      kind,
      label: typeof it.label === "string" && it.label ? it.label : `${kind} #${index}`,
      status: typeof it.status === "string" && it.status ? it.status : "unknown",
      detail: typeof it.detail === "string" && it.detail ? it.detail : null,
    });
  });
  // 旧回执无 outcome：由 items 状态推导（旧结构只写成功路径，推导仅为兜底）。
  const outcome =
    raw.outcome === "completed" || raw.outcome === "partial" || raw.outcome === "cancelled"
      ? raw.outcome
      : items.some((it) => it.status === "failed" || it.status === "skipped")
        ? "partial"
        : "completed";
  return {
    summary: typeof raw.summary === "string" ? raw.summary : "",
    scene_id: typeof raw.scene_id === "string" && raw.scene_id ? raw.scene_id : null,
    scene_name: typeof raw.scene_name === "string" && raw.scene_name ? raw.scene_name : null,
    total: typeof raw.total === "number" ? raw.total : items.length,
    processed: typeof raw.processed === "number" ? raw.processed : items.length,
    cancelled: raw.cancelled === true,
    timed_out: raw.timed_out === true,
    outcome,
    items,
  };
}
