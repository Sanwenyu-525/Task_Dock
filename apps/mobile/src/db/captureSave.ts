// 采集转正：把暂存项保存成收集箱条目 / 任务 / 笔记。
//
// 关键约束（与根 AGENTS.md §3 数据层规则一致）：
// - 业务表写入、附件行、清空暂存必须在同一事务：任一步失败整体回滚，
//   用户不会看到「条目建了但附件丢了」或「暂存清了但条目没建」的中间态；
// - client_id 幂等：同一个采集会话重复保存只会落一条收集箱记录；
// - 附件只落本机私有存储引用，不进同步载荷；transfer_state 一律从 pending 开始，
//   是否自动传送到电脑由同步设置决定（默认不自动）。
import type { StashedItem } from "../domain/types";
import { assertCaptureContent, insertCaptureInTx } from "./captures";
import { getDatabase } from "./database";
import { insertAttachmentInTx, type NewAttachmentInput } from "./attachments";
import { insertNoteInTx } from "./notes";
import { buildTask, insertTaskInTx } from "./tasks";
import { AppError } from "../lib/errors";
import { newId } from "../lib/id";
import { autoCaptureTitle, taskTitleFromText } from "../lib/capture/summary";

export type SaveDestination = "capture" | "task" | "note";

export interface SaveCaptureInput {
  destination: SaveDestination;
  /** 用户输入的正文；为空时用附件元信息生成标题（不能是空白） */
  text: string;
  items: readonly StashedItem[];
  /** 采集会话幂等键：进入采集中心时生成一次，重试复用 */
  clientId?: string;
  /** 笔记标题（destination=note 时可选） */
  noteTitle?: string;
  /** 当前时间，测试可注入 */
  now?: number;
}

export interface SaveCaptureResult {
  destination: SaveDestination;
  /** 真正落库的正文（可能是自动生成的附件标题） */
  content: string;
  captureId?: string;
  taskId?: string;
  noteId?: string;
  attachmentCount: number;
  /** true 表示 client_id 已存在、本次没有新建收集箱条目 */
  duplicated?: boolean;
}

function toAttachmentInput(item: StashedItem): NewAttachmentInput {
  return {
    kind: item.kind,
    mime: item.mime,
    name: item.name,
    localUri: item.localUri,
    size: item.size,
    width: item.width,
    height: item.height,
    durationMs: item.durationMs,
    transcript: item.transcript,
  };
}

/**
 * 保存一次采集。
 *
 * 三种去向共用同一套附件处理：先确定归属 id，再在事务里插业务行 + 附件行 + 删除暂存行。
 * 暂存行的文件字节不会被删除——它已转成附件，仍指向同一个私有存储文件。
 */
export async function saveCapture(input: SaveCaptureInput): Promise<SaveCaptureResult> {
  const now = input.now ?? Date.now();
  const db = getDatabase();
  const text = input.text.trim();
  const autoTitle = autoCaptureTitle(input.items, now);
  const content = text || autoTitle;
  if (!content) {
    throw new AppError("validation", "请输入内容，或先拍照、选图、录音、添加文件");
  }
  // 收集箱正文上限与桌面端一致；任务/笔记没有这个限制，但仍按同一口径保护同步链路。
  assertCaptureContent(content);

  let result: SaveCaptureResult | null = null;

  await db.withTransactionAsync(async () => {
    if (input.destination === "capture") {
      const inserted = await insertCaptureInTx(
        db,
        { content, clientId: input.clientId ?? newId("cap"), createdAt: now },
        now,
      );
      // 幂等命中：同一次采集已保存过，不再重复挂附件（否则同一文件会被登记两次）
      if (!inserted.duplicated) {
        for (const item of input.items) {
          await insertAttachmentInTx(db, "capture", inserted.capture.id, toAttachmentInput(item), now);
        }
      }
      result = {
        destination: "capture",
        content: inserted.capture.content,
        captureId: inserted.capture.id,
        attachmentCount: inserted.duplicated ? 0 : input.items.length,
        duplicated: inserted.duplicated,
      };
    } else if (input.destination === "task") {
      const title = taskTitleFromText(text, autoTitle || "未命名任务");
      const task = buildTask(
        { title, description: text && autoTitle ? `${text}\n\n${autoTitle}` : text },
        now,
      );
      await insertTaskInTx(db, task, now);
      for (const item of input.items) {
        await insertAttachmentInTx(db, "task", task.id, toAttachmentInput(item), now);
      }
      result = {
        destination: "task",
        content: title,
        taskId: task.id,
        attachmentCount: input.items.length,
      };
    } else {
      const explicitTitle = (input.noteTitle ?? "").trim();
      // 有用户文字：标题取首行；只有附件：标题留空，正文用附件标题（列表会显示摘要）
      const title = explicitTitle || (text ? taskTitleFromText(text, "") : "");
      const note = {
        id: newId("n"),
        title,
        body: text || autoTitle,
        pinned: false,
        favorited: false,
        createdAt: now,
        updatedAt: now,
        rev: 0,
        serverRev: 0,
      };
      await insertNoteInTx(db, note, now);
      for (const item of input.items) {
        await insertAttachmentInTx(db, "note", note.id, toAttachmentInput(item), now);
      }
      result = {
        destination: "note",
        content: note.body,
        noteId: note.id,
        attachmentCount: input.items.length,
      };
    }

    // 清空暂存行（字节已由附件持有；直接删行，不删文件）
    await db.runAsync("DELETE FROM capture_stash");
  });

  if (!result) throw new AppError("storage", "保存失败：没有生成任何记录");
  const saved: SaveCaptureResult = result;
  return saved;
}
