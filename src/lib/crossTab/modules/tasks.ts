//! 任务模块适配器：只调用既有 `create_task` 与 `entity_link_create`，
//! 不复制任务业务逻辑。注册一次，供工作篮「创建任务」动作使用。

import { createTask } from "../../bridge";
import { t as i18n } from "../../../i18n";
import { registerAction, unregisterAction } from "../actionRegistry";
import { createEntityLink } from "../transferClient";
import type { ActionResult, TransferItem } from "../types";

const ACTION_ID = "tasks.createFromTray";
const SUPPORTED = ["text", "richtext", "url", "file", "directory"];
let installed = false;

function itemText(item: TransferItem): string {
  if (item.content) return item.content;
  const payload = item.payload ?? {};
  const path = typeof payload.path === "string" ? payload.path : "";
  const url = typeof payload.url === "string" ? payload.url : "";
  return url || path || item.description || item.title;
}

function taskTitle(items: TransferItem[]): string {
  const first = items[0];
  if (!first) return i18n("transfer.taskFallbackTitle");
  const text = itemText(first).trim().split(/\r?\n/)[0]?.trim() ?? "";
  const title = text || first.title || i18n("transfer.taskFallbackTitle");
  return title.length > 80 ? `${title.slice(0, 80)}…` : title;
}

function taskDescription(items: TransferItem[]): string {
  const parts: string[] = [];
  for (const item of items) {
    const body = itemText(item).trim();
    if (!body) continue;
    parts.push(items.length > 1 ? `【${item.title || item.itemType}】\n${body}` : body);
  }
  const joined = parts.join("\n\n");
  return joined.length > 4000 ? `${joined.slice(0, 4000)}…` : joined;
}

async function createTaskFromTray(items: TransferItem[]): Promise<ActionResult> {
  try {
    const task = await createTask({
      title: taskTitle(items),
      description: taskDescription(items),
      category: "工作篮",
      tags: ["工作篮"],
    });

    // 文件/目录引用单独建立关联；目录不是文件，后端 `file` 存在性校验会拒绝，
    // 因此只有真实文件尝试关联，目录保留在任务描述中。
    const files = items
      .filter((item) => item.itemType === "file")
      .map((item) => (typeof item.payload?.path === "string" ? item.payload.path : ""))
      .filter((path) => path.length > 0);
    let linked = 0;
    for (const path of files) {
      try {
        await createEntityLink({
          sourceType: "task",
          sourceId: task.id,
          targetType: "file",
          targetId: path,
          relation: "attachment",
          label: path.split(/[\\/]/).pop() ?? path,
          metadata: { source: "transfer_tray" },
        });
        linked += 1;
      } catch {
        // 单个文件引用失效不阻断任务创建；任务描述仍保留路径。
      }
    }

    return {
      ok: true,
      message: files.length
        ? i18n("transfer.taskCreatedWithFiles", { count: linked })
        : i18n("transfer.taskCreated"),
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/** 幂等安装：两个窗口都可能执行，但动作表进程内共享。 */
export function installTaskActions(): void {
  if (installed) return;
  installed = true;
  registerAction({
    actionId: ACTION_ID,
    title: i18n("transfer.actionCreateTask"),
    description: i18n("transfer.actionCreateTaskHint"),
    supportedItemTypes: SUPPORTED,
    sourceModules: [],
    targetModules: [],
    requiresTarget: false,
    confirmationRequired: false,
    run: (payload) => createTaskFromTray(payload.items),
  });
}

export function uninstallTaskActions(): void {
  if (!installed) return;
  installed = false;
  unregisterAction(ACTION_ID);
}

export { ACTION_ID as CREATE_TASK_ACTION_ID };
