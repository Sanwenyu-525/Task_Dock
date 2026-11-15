// 采集草稿：把「输入框文字 + 保存目标」落进 kv，应用被杀后还能恢复。
//
// 为什么不用业务表：
// - 草稿不是收集箱条目，不该出现在列表、不该进 outbox；
// - 只保存用户真正输入的内容，附件字节已经在 capture_stash 里。
//
// 写频控制：调用方（CaptureScreen）负责防抖，本模块只做一次 upsert；
// 空草稿直接删除键，避免每次启动都读一份空 JSON。
import { deleteSetting, getSetting, setSetting } from "../../db/kv";

import type { SaveDestination } from "../../db/captureSave";

const KEY_CAPTURE_DRAFT = "capture.draft";

export interface CaptureDraft {
  text: string;
  destination: SaveDestination;
  updatedAt: number;
}

function asDestination(value: unknown): SaveDestination {
  return value === "task" || value === "note" ? value : "capture";
}

export async function loadCaptureDraft(): Promise<CaptureDraft | null> {
  const raw = await getSetting(KEY_CAPTURE_DRAFT);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CaptureDraft>;
    const text = typeof parsed.text === "string" ? parsed.text : "";
    if (!text.trim()) return null;
    return {
      text,
      destination: asDestination(parsed.destination),
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
    };
  } catch {
    // 损坏的草稿不应阻塞采集中心打开：清掉这条键即可
    await deleteSetting(KEY_CAPTURE_DRAFT).catch(() => undefined);
    return null;
  }
}

/** 写入草稿；文字为空时删除键（附件仍在 capture_stash，不需要草稿记录）。 */
export async function saveCaptureDraft(
  patch: { text: string; destination: SaveDestination },
  now = Date.now(),
): Promise<void> {
  if (!patch.text.trim()) {
    await clearCaptureDraft();
    return;
  }
  const draft: CaptureDraft = { text: patch.text, destination: patch.destination, updatedAt: now };
  await setSetting(KEY_CAPTURE_DRAFT, JSON.stringify(draft));
}

export async function clearCaptureDraft(): Promise<void> {
  await deleteSetting(KEY_CAPTURE_DRAFT);
}
