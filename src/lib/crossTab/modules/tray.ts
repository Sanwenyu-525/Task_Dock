//! 工作篮自身动作：加入工作篮、发送到文件工作区、关联项目、打开位置、复制内容。
//!
//! 这些动作是「统一发送入口」的首批真实动作：菜单按 `ActionRegistry` 的声明筛选，
//! 页面不硬编码任何一条；执行失败必须返回真实错误，不能吞掉后显示成功。

import { fsReveal } from "../../bridge";
import { copyText } from "../../clipboard";
import { t as i18n } from "../../../i18n";
import { ensureAction, unregisterAction } from "../actionRegistry";
import { addItems, createEntityLink, DEFAULT_OPTIONS, executeTransfer } from "../transferClient";
import type { ActionResult, TransferItem, TransferItemInput, TransferTarget } from "../types";

export const ADD_TO_TRAY_ACTION = "tray.addToTray";
export const SEND_TO_FILES_ACTION = "tray.sendToFiles";
export const LINK_TO_PROJECT_ACTION = "tray.linkToProject";
export const OPEN_LOCATION_ACTION = "tray.openLocation";
export const COPY_CONTENT_ACTION = "tray.copyContent";

const ALL_TYPES: string[] = [];
const FILE_TYPES = ["file", "directory"];
const TEXT_TYPES = ["text", "richtext", "url", "clipboard"];

function pathOf(item: TransferItem): string {
  const path = item.payload?.path;
  return typeof path === "string" ? path : "";
}

function textOf(item: TransferItem): string {
  if (item.content.trim()) return item.content;
  const url = item.payload?.url;
  if (typeof url === "string" && url.trim()) return url;
  return pathOf(item) || item.description || item.title;
}

function toInputs(items: TransferItem[]): TransferItemInput[] {
  return items.map((item) => ({
    itemType: item.itemType,
    sourceModule: item.sourceModule || "tray",
    sourceId: item.sourceId,
    title: item.title,
    description: item.description,
    content: item.content,
    payload: item.payload,
    pinned: item.pinned,
  }));
}

async function addToTray(items: TransferItem[]): Promise<ActionResult> {
  try {
    const report = await addItems(toInputs(items));
    const added = report.items.length;
    const extra = report.duplicates + report.rejected.length;
    return {
      ok: added > 0,
      message:
        added > 0
          ? extra > 0
            ? i18n("transfer.addedPartial", { count: added, extra })
            : i18n("transfer.added", { count: added })
          : i18n("transfer.addFailedAll", { count: report.rejected.length }),
    };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

async function sendToFiles(items: TransferItem[], target?: TransferTarget): Promise<ActionResult> {
  if (!target?.ref) return { ok: false, message: i18n("transfer.targetRequired") };
  try {
    const batch = await executeTransfer(
      items.map((item) => item.id),
      target,
      DEFAULT_OPTIONS,
    );
    return {
      ok: true,
      message: i18n("transfer.started", { count: batch.total }),
      batchId: batch.id,
    };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

async function linkToProject(items: TransferItem[], target?: TransferTarget): Promise<ActionResult> {
  if (!target?.ref) return { ok: false, message: i18n("transfer.targetRequired") };
  let linked = 0;
  const failures: string[] = [];
  for (const item of items) {
    const sourceType =
      item.itemType === "task"
        ? "task"
        : item.itemType === "knowledge"
          ? "knowledge_doc"
          : item.itemType === "capture"
            ? "capture"
            : item.itemType === "planning"
              ? "planning_feature"
              : "file";
    const sourceId = item.itemType === "file" || item.itemType === "directory" ? pathOf(item) : item.sourceId;
    if (!sourceId) {
      failures.push(item.title || item.id);
      continue;
    }
    try {
      await createEntityLink({
        sourceType,
        sourceId,
        targetType: "workspace_project",
        targetId: target.ref,
        relation: "reference",
        label: item.title,
        metadata: { source: "transfer_tray" },
      });
      linked += 1;
    } catch (error) {
      failures.push(`${item.title}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return {
    ok: linked > 0,
    message:
      linked > 0
        ? failures.length > 0
          ? i18n("transfer.linkedPartial", { count: linked, failed: failures.length })
          : i18n("transfer.linked", { count: linked })
        : i18n("transfer.linkFailed"),
  };
}

async function openLocation(items: TransferItem[]): Promise<ActionResult> {
  const path = items.map(pathOf).find((value) => value.length > 0);
  if (!path) return { ok: false, message: i18n("transfer.noLocation") };
  try {
    await fsReveal(path);
    return { ok: true, message: i18n("transfer.revealed") };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

async function copyContent(items: TransferItem[]): Promise<ActionResult> {
  const body = items
    .map((item) => textOf(item).trim())
    .filter((value) => value.length > 0)
    .join("\n\n");
  if (!body) return { ok: false, message: i18n("transfer.copyFailed") };
  const ok = await copyText(body);
  return {
    ok,
    message: ok
      ? i18n("transfer.copied", { count: items.length })
      : i18n("transfer.copyFailed"),
  };
}

/** 幂等安装（多窗口 / 重复初始化都安全）。 */
export function installTrayActions(): void {
  ensureAction({
    actionId: ADD_TO_TRAY_ACTION,
    title: i18n("transfer.actionAddToTray"),
    description: i18n("transfer.actionAddToTrayHint"),
    supportedItemTypes: ALL_TYPES,
    sourceModules: [],
    targetModules: [],
    run: (payload) => addToTray(payload.items),
  });
  ensureAction({
    actionId: SEND_TO_FILES_ACTION,
    title: i18n("transfer.sendToFiles"),
    description: i18n("transfer.actionSendToFilesHint"),
    supportedItemTypes: ALL_TYPES,
    sourceModules: [],
    targetModules: ["files"],
    requiresTarget: true,
    run: (payload) => sendToFiles(payload.items, payload.target),
  });
  ensureAction({
    actionId: LINK_TO_PROJECT_ACTION,
    title: i18n("transfer.actionLinkProject"),
    description: i18n("transfer.actionLinkProjectHint"),
    supportedItemTypes: ["task", "knowledge", "capture", "planning", "file", "directory", "text", "richtext"],
    sourceModules: [],
    targetModules: ["projects"],
    requiresTarget: true,
    run: (payload) => linkToProject(payload.items, payload.target),
  });
  ensureAction({
    actionId: OPEN_LOCATION_ACTION,
    title: i18n("transfer.actionOpenLocation"),
    description: i18n("transfer.actionOpenLocationHint"),
    supportedItemTypes: FILE_TYPES,
    sourceModules: [],
    targetModules: [],
    run: (payload) => openLocation(payload.items),
  });
  ensureAction({
    actionId: COPY_CONTENT_ACTION,
    title: i18n("transfer.actionCopyContent"),
    description: i18n("transfer.actionCopyContentHint"),
    supportedItemTypes: TEXT_TYPES,
    sourceModules: [],
    targetModules: [],
    run: (payload) => copyContent(payload.items),
  });
}

export function uninstallTrayActions(): void {
  for (const id of [
    ADD_TO_TRAY_ACTION,
    SEND_TO_FILES_ACTION,
    LINK_TO_PROJECT_ACTION,
    OPEN_LOCATION_ACTION,
    COPY_CONTENT_ACTION,
  ]) {
    unregisterAction(id);
  }
}
