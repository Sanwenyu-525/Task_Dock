// 采集可靠性回归：会话隔离、任务/笔记幂等、草稿恢复、附件状态恢复、暂存上限守卫。
// 用真实 SQL 跑 db 层原样代码（node:sqlite harness），不 mock 仓储函数。
import { beforeEach, describe, expect, it } from "vitest";

import type { StashedItem } from "../../domain/types";
import {
  countAttachmentsForTransfer,
  listAttachments,
  resetInterruptedUploads,
  setAttachmentTransferState,
} from "../attachments";
import { saveCapture } from "../captureSave";
import { addStashItem, listStash } from "../captureStash";
import { closeDatabase, openDatabase } from "../database";
import { listNotes } from "../notes";
import { listTasks } from "../tasks";
import { clearCaptureDraft, loadCaptureDraft, saveCaptureDraft } from "../../lib/capture/draft";

async function open() {
  await openDatabase();
}

function stashInput(name: string, size = 1024, kind: StashedItem["kind"] = "image") {
  return {
    kind,
    mime: kind === "image" ? "image/jpeg" : "application/pdf",
    name,
    localUri: `file:///data/capture/${name}`,
    size,
    source: "album" as const,
  };
}

async function stash(name: string, size = 1024, kind: StashedItem["kind"] = "image") {
  return addStashItem(stashInput(name, size, kind));
}

beforeEach(async () => {
  await closeDatabase();
});

describe("P0-01 暂存会话隔离", () => {
  it("保存会话 A 只删除 A 的暂存行，会话 B / 分享中途接入的内容完整保留", async () => {
    await open();
    const a = await stash("session-a.jpg");
    const b = await stash("session-b.pdf", 2048, "file");
    const shared = await stash("shared-mid.jpg");

    const result = await saveCapture({
      destination: "capture",
      text: "",
      items: [a],
      clientId: "session-a",
    });

    expect(result.attachmentCount).toBe(1);
    const remaining = await listStash();
    expect(remaining.map((item) => item.id).sort()).toEqual([b.id, shared.id].sort());
    // 文件字节仍指向同一个私有存储文件，不能把别人的内容删掉
    expect(remaining.find((item) => item.id === b.id)?.localUri).toBe(b.localUri);
  });

  it("纯文本保存（无附件）不清空任何暂存项", async () => {
    await open();
    const a = await stash("keep.jpg");
    const b = await stash("keep.pdf", 1024, "file");

    await saveCapture({ destination: "capture", text: "只写一句话", items: [], clientId: "text-only" });

    expect((await listStash()).map((item) => item.id).sort()).toEqual([a.id, b.id].sort());
  });

  it("保存失败不删除暂存（事务回滚后用户仍能继续）", async () => {
    await open();
    const a = await stash("rollback.jpg");
    await expect(
      saveCapture({ destination: "capture", text: "x".repeat(4001), items: [a], clientId: "too-long" }),
    ).rejects.toBeTruthy();
    expect(await listStash()).toHaveLength(1);
    // 没有产生收集箱条目
    const captures = await (await import("../database")).getDatabase().getAllAsync(
      "SELECT id FROM captures",
    );
    expect(captures).toHaveLength(0);
  });
});

describe("P0-05 任务与笔记保存幂等", () => {
  it("同一 clientId 保存任务两次：只建一条任务、附件不重复", async () => {
    await open();
    const item = await stash("task-photo.jpg");
    const input = { destination: "task" as const, text: "写周报", items: [item], clientId: "task-1" };

    const first = await saveCapture(input);
    const second = await saveCapture(input);

    expect(second.duplicated).toBe(true);
    expect(second.taskId).toBe(first.taskId);
    expect(await listTasks()).toHaveLength(1);
    expect(await listAttachments("task", first.taskId ?? "")).toHaveLength(1);
  });

  it("同一 clientId 保存笔记三次：只建一条笔记", async () => {
    await open();
    const item = await stash("note.pdf", 4096, "file");
    const input = { destination: "note" as const, text: "会议记录", items: [item], clientId: "note-1" };

    const first = await saveCapture(input);
    await saveCapture(input);
    const third = await saveCapture(input);

    expect(third.duplicated).toBe(true);
    expect(third.noteId).toBe(first.noteId);
    expect(await listNotes()).toHaveLength(1);
    expect(await listAttachments("note", first.noteId ?? "")).toHaveLength(1);
  });

  it("收集箱同样经 capture_commits 命中，不重复插附件", async () => {
    await open();
    const item = await stash("cap.jpg");
    const input = { destination: "capture" as const, text: "", items: [item], clientId: "cap-idem" };
    const first = await saveCapture(input);
    // 进程被杀后重试：内存里仍是同一批 items 对象，暂存行已被前一次消费
    const second = await saveCapture(input);
    expect(second.duplicated).toBe(true);
    expect(second.captureId).toBe(first.captureId);
    expect(await listAttachments("capture", first.captureId ?? "")).toHaveLength(1);
  });

  it("失败的提交不写入幂等登记：同一个 clientId 仍可重试成功", async () => {
    await open();
    await expect(
      saveCapture({ destination: "task", text: "", items: [], clientId: "retry" }),
    ).rejects.toBeTruthy();
    const item = await stash("retry.jpg");
    const ok = await saveCapture({
      destination: "task",
      text: "重试成功",
      items: [item],
      clientId: "retry",
    });
    expect(ok.taskId).toBeTruthy();
    expect(await listTasks()).toHaveLength(1);
  });
});

describe("P0-02 暂存数量守卫", () => {
  it("已有 9 项时第 10 项被数据库拒绝，行数保持 9", async () => {
    await open();
    for (let i = 0; i < 9; i += 1) await stash(`p${i}.jpg`);
    await expect(stash("p9.jpg")).rejects.toBeTruthy();
    expect(await listStash()).toHaveLength(9);
  });

  it("单件超过 50MB 被拒绝", async () => {
    await open();
    await expect(stash("huge.pdf", 51 * 1024 * 1024, "file")).rejects.toBeTruthy();
    expect(await listStash()).toHaveLength(0);
  });
});

describe("P1-03 附件状态机恢复", () => {
  it("重启把 uploading 复位成 failed 可重试，pending 不受影响", async () => {
    await open();
    const item = await stash("upload.jpg");
    const saved = await saveCapture({
      destination: "capture",
      text: "",
      items: [item],
      clientId: "upload",
    });
    const attachmentId = (await listAttachments("capture", saved.captureId ?? ""))[0].id;
    await setAttachmentTransferState(attachmentId, "uploading");

    const changed = await resetInterruptedUploads();
    const rows = await listAttachments("capture", saved.captureId ?? "");

    expect(changed).toBe(1);
    expect(rows[0].transferState).toBe("failed");
    expect(rows[0].transferError).toContain("上次传输中断");
    // failed 仍计入待传送（用户可重试），不会从同步页消失
    expect(await countAttachmentsForTransfer()).toBe(1);
  });
});

describe("P0-04 采集草稿恢复", () => {
  it("写入后可读回文字与保存目标（在同一连接内）", async () => {
    await open();
    // 说明：harness 每次 openDatabase 使用新的内存库，无法在单测里模拟「进程重启后
    // 仍读回同一文件」；真实持久化由真机验收覆盖（杀进程后重开采集中心）。
    await saveCaptureDraft({ text: "还没保存的想法", destination: "task" });

    const draft = await loadCaptureDraft();
    expect(draft?.text).toBe("还没保存的想法");
    expect(draft?.destination).toBe("task");
  });

  it("清空草稿后不留空记录；损坏的 JSON 不会阻塞采集中心", async () => {
    await open();
    await saveCaptureDraft({ text: "temp", destination: "capture" });
    await clearCaptureDraft();
    expect(await loadCaptureDraft()).toBeNull();

    const { setSetting } = await import("../kv");
    await setSetting("capture.draft", "{not-json");
    expect(await loadCaptureDraft()).toBeNull();
  });

  it("去掉首尾空白后为空的草稿视为没有草稿", async () => {
    await open();
    await saveCaptureDraft({ text: "   ", destination: "note" });
    expect(await loadCaptureDraft()).toBeNull();
  });
});
