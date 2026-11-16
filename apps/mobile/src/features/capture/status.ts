// 采集素材的总体状态：把「素材状态 + 各目的地状态」收敛成一个明确标签，
// 不再用一个含糊的 status 字段混指上传/相册/暂存架。
//
// 10 种状态（key 稳定，供 UI 与测试使用）：
//   staged                未保存（staging 里，尚未确认保存/发送）
//   local_only            仅本机
//   album_saved           已存相册
//   sent_inbox            已发送电脑（文件收件箱）
//   in_shelf              已加入桌面暂存架
//   uploaded_shelf_failed 已上传电脑，但加入暂存架失败
//   waiting_desktop       等待电脑连接
//   working               处理中（有目的地处于 running）
//   failed                有失败
//   cancelled             已取消
//
// 优先级：处理中 > 暂存架成功 > 上传成功但暂存架失败 > 收件箱成功 > 相册成功 >
// 失败 > 取消 > 等待连接 > 仅本机。上传成功永远优先于失败展示，避免「实际已上传」
// 被另一目的地的失败掩盖；取消是明确的用户动作，不能再被残留的 pending 盖成“等待电脑”。
import type {
  CaptureAsset,
  CaptureDestination,
  CaptureDestinationKind,
} from "../../db/captureAssets";

export type CaptureStatusKey =
  | "staged"
  | "local_only"
  | "album_saved"
  | "sent_inbox"
  | "in_shelf"
  | "uploaded_shelf_failed"
  | "waiting_desktop"
  | "working"
  | "failed"
  | "cancelled";

export type CaptureStatusTone = "ok" | "warn" | "danger" | "muted" | "accent";

export interface CaptureStatus {
  key: CaptureStatusKey;
  label: string;
  tone: CaptureStatusTone;
}

const STATUS_LABELS: Record<CaptureStatusKey, { label: string; tone: CaptureStatusTone }> = {
  staged: { label: "未保存", tone: "warn" },
  local_only: { label: "仅本机", tone: "muted" },
  album_saved: { label: "已存相册", tone: "ok" },
  sent_inbox: { label: "已发电脑", tone: "ok" },
  in_shelf: { label: "已入暂存架", tone: "ok" },
  uploaded_shelf_failed: { label: "已上传·暂存架失败", tone: "warn" },
  waiting_desktop: { label: "等待电脑", tone: "warn" },
  working: { label: "处理中", tone: "accent" },
  failed: { label: "有失败", tone: "danger" },
  cancelled: { label: "已取消", tone: "muted" },
};

function stateOf(
  items: CaptureDestination[],
  kind: CaptureDestinationKind,
): CaptureDestination["state"] | null {
  return items.find((item) => item.destination === kind)?.state ?? null;
}

export function captureStatusOf(asset: CaptureAsset, items: CaptureDestination[]): CaptureStatus {
  const build = (key: CaptureStatusKey): CaptureStatus => ({ key, ...STATUS_LABELS[key] });
  if (asset.state === "staged") return build("staged");

  const states = items.map((item) => item.state);
  if (states.includes("running")) return build("working");

  const shelf = stateOf(items, "shelf");
  const desktop = stateOf(items, "desktop");
  const album = stateOf(items, "album");

  if (shelf === "done") return build("in_shelf");
  if (desktop === "done" && shelf === "failed") return build("uploaded_shelf_failed");
  if (desktop === "done") return build("sent_inbox");
  if (album === "done") return build("album_saved");
  if (states.includes("failed")) return build("failed");
  if (states.includes("cancelled")) return build("cancelled");
  if (desktop === "pending" || shelf === "pending") return build("waiting_desktop");
  return build("local_only");
}
