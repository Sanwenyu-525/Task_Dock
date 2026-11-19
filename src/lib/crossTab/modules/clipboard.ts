//! 剪贴板 → 工作篮适配：只读既有历史，不新增系统剪贴板监听。
//!
//! 映射规则：
//! - text / url / html 读取完整正文（列表接口只有预览）；
//! - image 只保存稳定引用（`clipboardItemId`），不复制 Base64；
//! - files 按路径拆成独立条目，保留原始顺序；
//! - 历史被清理 / 图片失效 / 路径失效由后端执行前再次校验并给出明确失败。

import { clipboardItem as fetchClipboardItem } from "../../../lib/bridge";
import type { ClipboardItem } from "../../../lib/contracts/models";
import { addItems } from "../transferClient";
import type { TransferAddReport, TransferItemInput } from "../types";

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function titleOf(item: ClipboardItem): string {
  const title = (item.title || item.preview || "").trim();
  if (title) return title.slice(0, 200);
  if (item.kind === "image") return "剪贴板图片";
  return item.kind === "files" ? "剪贴板文件" : "剪贴板内容";
}

export function mapClipboardItem(item: ClipboardItem): TransferItemInput[] {
  const base = {
    sourceModule: "clipboard" as const,
    sourceId: item.id,
    title: titleOf(item),
    description: item.source_app || item.source_title || "",
  };

  if (item.kind === "image") {
    return [
      {
        ...base,
        itemType: "image",
        payload: { clipboardItemId: item.id, width: item.image_width, height: item.image_height },
      },
    ];
  }

  if (item.kind === "files") {
    const paths = (item.file_paths ?? []).filter((path) => path.trim().length > 0);
    if (paths.length === 0) {
      return [{ ...base, itemType: "clipboard", payload: { clipboardItemId: item.id } }];
    }
    return paths.map((path) => ({
      itemType: "file",
      sourceModule: "clipboard" as const,
      sourceId: `${item.id}:${path}`,
      title: basename(path),
      description: path,
      payload: { path, clipboardItemId: item.id },
    }));
  }

  if (item.kind === "url") {
    return [
      {
        ...base,
        itemType: "url",
        content: item.text,
        payload: { url: item.text, clipboardItemId: item.id },
      },
    ];
  }

  if (item.kind === "html") {
    return [
      {
        ...base,
        itemType: "richtext",
        content: item.text || item.html,
        payload: { clipboardItemId: item.id },
      },
    ];
  }

  return [
    {
      ...base,
      itemType: "text",
      content: item.text,
      payload: { clipboardItemId: item.id },
    },
  ];
}

/** 批量加入：逐条读取完整内容；单条读取失败不阻断其他条目。 */
export async function addClipboardItemsToTray(ids: string[]): Promise<{
  report: TransferAddReport | null;
  failed: Array<{ id: string; message: string }>;
}> {
  const inputs: TransferItemInput[] = [];
  const failed: Array<{ id: string; message: string }> = [];
  for (const id of ids) {
    try {
      const item = await fetchClipboardItem(id);
      inputs.push(...mapClipboardItem(item));
    } catch (error) {
      failed.push({ id, message: error instanceof Error ? error.message : String(error) });
    }
  }
  if (inputs.length === 0) return { report: null, failed };
  const report = await addItems(inputs);
  return { report, failed };
}
