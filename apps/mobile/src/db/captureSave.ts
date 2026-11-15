// 采集转正：把暂存项保存成收集箱条目 / 任务 / 笔记。
//
// 关键约束（与根 AGENTS.md §3 数据层规则一致）：
// - 业务表写入、附件行、提交登记、删除本次暂存行必须在同一事务：任一步失败整体回滚，
//   用户不会看到「条目建了但附件丢了」或「暂存清了但条目没建」的中间态；
// - client_id 幂等：同一个采集会话重复保存（双击、进程被杀后重试、DB 已提交但响应丢失）
//   只会落一条记录，三种去向共用 capture_commits 登记；
// - 只删除本次真正保存的暂存行：capture_stash 是全局表，另一个采集会话或系统分享
//   中途接入的内容可能同时存在，整表 DELETE 会丢用户数据；
// - 附件只落本机私有存储引用，不进同步载荷；transfer_state 一律从 pending 开始。
import type { SQLiteDatabase } from "expo-sqlite";

import type { StashedItem } from "../domain/types";
import { assertCaptureContent, insertCaptureInTx } from "./captures";
import { getDatabase } from "./database";
import { insertAttachmentInTx, type NewAttachmentInput } from "./attachments";
import { deleteStashItemsInTx } from "./captureStash";
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
  /** 本次新建的附件 id（显式「发送到电脑」按这些 id 精确发送） */
  attachmentIds: string[];
  attachmentCount: number;
  /** true 表示本次 client_id 已提交过，没有新建记录 */
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

interface CommitRow {
  destination: string;
  entity_id: string;
}

async function findCommitInTx(
  db: SQLiteDatabase,
  clientId: string,
): Promise<CommitRow | null> {
  return db.getFirstAsync<CommitRow>(
    "SELECT destination, entity_id FROM capture_commits WHERE client_id = ?",
    [clientId],
  );
}

async function recordCommitInTx(
  db: SQLiteDatabase,
  clientId: string,
  destination: SaveDestination,
  entityId: string,
  now: number,
): Promise<void> {
  await db.runAsync(
    `INSERT OR IGNORE INTO capture_commits (client_id, destination, entity_id, created_at)
     VALUES (?, ?, ?, ?)`,
    [clientId, destination, entityId, now],
  );
}

/** 命中幂等时读回已存在实体的正文，保证结果卡/调用方拿到真实内容而不是占位串。 */
async function readCommittedContentInTx(
  db: SQLiteDatabase,
  commit: CommitRow,
  fallback: string,
): Promise<string> {
  if (commit.destination === "capture") {
    const row = await db.getFirstAsync<{ content: string }>(
      "SELECT content FROM captures WHERE id = ?",
      [commit.entity_id],
    );
    return row?.content ?? fallback;
  }
  if (commit.destination === "task") {
    const row = await db.getFirstAsync<{ title: string }>(
      "SELECT title FROM tasks WHERE id = ?",
      [commit.entity_id],
    );
    return row?.title ?? fallback;
  }
  const row = await db.getFirstAsync<{ body: string }>(
    "SELECT body FROM notes WHERE id = ?",
    [commit.entity_id],
  );
  return row?.body ?? fallback;
}

/**
 * 保存一次采集。
 *
 * 三种去向共用同一套附件处理：先确定归属 id，再在事务里插业务行 + 附件行 +
 * 登记提交 + 删除本次暂存行。暂存行的文件字节不会被删除——它已转成附件，
 * 仍指向同一个私有存储文件。
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
    // 本次提交真正消费的暂存行：命中幂等时同样要删除（它们已被前一次提交转成附件），
    // 但绝不触碰不属于本次的暂存项。
    const consumedStashIds = input.items.map((item) => item.id);
    const commitKey = input.clientId?.trim() ? input.clientId.trim() : null;

    if (commitKey) {
      const existing = await findCommitInTx(db, commitKey);
      if (existing) {
        const committedContent = await readCommittedContentInTx(db, existing, content);
        await deleteStashItemsInTx(db, consumedStashIds);
        result = {
          destination: existing.destination as SaveDestination,
          content: committedContent,
          captureId: existing.destination === "capture" ? existing.entity_id : undefined,
          taskId: existing.destination === "task" ? existing.entity_id : undefined,
          noteId: existing.destination === "note" ? existing.entity_id : undefined,
          attachmentIds: [],
          attachmentCount: 0,
          duplicated: true,
        };
        return;
      }
    }

    if (input.destination === "capture") {
      const inserted = await insertCaptureInTx(
        db,
        { content, clientId: commitKey ?? newId("cap"), createdAt: now },
        now,
      );
      // 幂等命中（v7 之前的旧数据只有 captures.client_id）：不再重复挂附件
      let attachmentIds: string[] = [];
      if (!inserted.duplicated) {
        for (const item of input.items) {
          const attachment = await insertAttachmentInTx(
            db,
            "capture",
            inserted.capture.id,
            toAttachmentInput(item),
            now,
          );
          attachmentIds.push(attachment.id);
        }
      }
      if (commitKey) {
        await recordCommitInTx(db, commitKey, "capture", inserted.capture.id, now);
      }
      await deleteStashItemsInTx(db, consumedStashIds);
      result = {
        destination: "capture",
        content: inserted.capture.content,
        captureId: inserted.capture.id,
        attachmentIds,
        attachmentCount: attachmentIds.length,
        duplicated: inserted.duplicated,
      };
    } else if (input.destination === "task") {
      const title = taskTitleFromText(text, autoTitle || "未命名任务");
      const task = buildTask(
        { title, description: text && autoTitle ? `${text}\n\n${autoTitle}` : text },
        now,
      );
      await insertTaskInTx(db, task, now);
      const attachmentIds: string[] = [];
      for (const item of input.items) {
        const attachment = await insertAttachmentInTx(
          db,
          "task",
          task.id,
          toAttachmentInput(item),
          now,
        );
        attachmentIds.push(attachment.id);
      }
      if (commitKey) await recordCommitInTx(db, commitKey, "task", task.id, now);
      await deleteStashItemsInTx(db, consumedStashIds);
      result = {
        destination: "task",
        content: title,
        taskId: task.id,
        attachmentIds,
        attachmentCount: attachmentIds.length,
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
      const attachmentIds: string[] = [];
      for (const item of input.items) {
        const attachment = await insertAttachmentInTx(
          db,
          "note",
          note.id,
          toAttachmentInput(item),
          now,
        );
        attachmentIds.push(attachment.id);
      }
      if (commitKey) await recordCommitInTx(db, commitKey, "note", note.id, now);
      await deleteStashItemsInTx(db, consumedStashIds);
      result = {
        destination: "note",
        content: note.body,
        noteId: note.id,
        attachmentIds,
        attachmentCount: attachmentIds.length,
      };
    }
  });

  if (!result) throw new AppError("storage", "保存失败：没有生成任何记录");
  const saved: SaveCaptureResult = result;
  return saved;
}
