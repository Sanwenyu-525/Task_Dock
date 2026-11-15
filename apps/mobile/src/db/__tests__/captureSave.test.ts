// 采集转正与附件仓储测试：真实 SQL（node:sqlite harness）跑 db 层原样代码。
// 覆盖：三种保存去向、附件归属、暂存清空、client_id 幂等、转任务后附件跟随。
import { beforeEach, describe, expect, it } from "vitest";

import type { StashedItem } from "../../domain/types";
import { listAttachments, listAttachmentsForTransfer, setAttachmentTransferState } from "../attachments";
import { addCapture, promoteCapture } from "../captures";
import { saveCapture } from "../captureSave";
import { addStashItem, clearStash, listStash, removeStashItem, updateStashItem } from "../captureStash";
import { closeDatabase, getDatabase, openDatabase } from "../database";
import { listTasks } from "../tasks";
import { listNotes } from "../notes";

async function open() {
  await openDatabase();
}

async function stashOne(kind: StashedItem["kind"] = "image", name = "photo.jpg"): Promise<StashedItem> {
  return addStashItem({
    kind,
    mime: kind === "image" ? "image/jpeg" : kind === "audio" ? "audio/mp4" : "application/pdf",
    name,
    localUri: `file:///data/capture/${name}`,
    size: 1024,
    source: kind === "audio" ? "voice" : "camera",
    durationMs: kind === "audio" ? 72_000 : null,
  });
}

beforeEach(async () => {
  await closeDatabase();
});

describe("saveCapture → 收集箱", () => {
  it("落收集箱 + 挂附件 + 清空暂存 + 登记 outbox", async () => {
    await open();
    const item = await stashOne();
    const result = await saveCapture({
      destination: "capture",
      text: "",
      items: [item],
      clientId: "cap-1",
      now: new Date(2026, 10, 14, 9, 5).getTime(),
    });

    expect(result.destination).toBe("capture");
    expect(result.content).toBe("照片 1 张 · 11-14 09:05");
    expect(result.attachmentCount).toBe(1);

    const attachments = await listAttachments("capture", result.captureId ?? "");
    expect(attachments).toHaveLength(1);
    expect(attachments[0].kind).toBe("image");
    expect(attachments[0].transferState).toBe("pending");
    expect(await listStash()).toHaveLength(0);

    const outbox = await getDatabase().getAllAsync<{ entity: string }>(
      "SELECT entity FROM outbox",
    );
    expect(outbox).toEqual([{ entity: "capture" }]);
  });

  it("同一 clientId 重复保存不重复建条目、不重复挂附件", async () => {
    await open();
    const item = await stashOne();
    const first = await saveCapture({ destination: "capture", text: "记一句", items: [item], clientId: "cap-dup" });
    const second = await saveCapture({ destination: "capture", text: "记一句", items: [item], clientId: "cap-dup" });

    expect(second.duplicated).toBe(true);
    expect(second.captureId).toBe(first.captureId);
    const captures = await getDatabase().getAllAsync<{ id: string }>("SELECT id FROM captures");
    expect(captures).toHaveLength(1);
    expect(await listAttachments("capture", first.captureId ?? "")).toHaveLength(1);
  });

  it("没有文字也没有附件时拒绝保存（不产生空记录）", async () => {
    await open();
    await expect(saveCapture({ destination: "capture", text: "   ", items: [] })).rejects.toThrow(
      /请输入内容/,
    );
  });
});

describe("saveCapture → 任务 / 笔记", () => {
  it("任务：首行做标题，附件归属任务", async () => {
    await open();
    const items = [await stashOne("image"), await stashOne("audio", "voice.m4a")];
    const text = "整理会议照片\n把要点补到周报";
    const result = await saveCapture({ destination: "task", text, items });

    const tasks = await listTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe("整理会议照片");
    expect(tasks[0].description).toContain("把要点补到周报");
    expect(result.taskId).toBe(tasks[0].id);
    expect(await listAttachments("task", tasks[0].id)).toHaveLength(2);
    expect(await listStash()).toHaveLength(0);
  });

  it("笔记：正文与标题落库，附件归属笔记", async () => {
    await open();
    const item = await stashOne("file", "report.pdf");
    const result = await saveCapture({ destination: "note", text: "报告要点\n- 三页", items: [item] });
    const notes = await listNotes();
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toBe("报告要点");
    expect(notes[0].body).toContain("- 三页");
    expect(await listAttachments("note", notes[0].id)).toHaveLength(1);
    expect(result.noteId).toBe(notes[0].id);
  });

  it("只有录音、未写文字时：正文用附件标题，不伪造转写", async () => {
    await open();
    const item = await stashOne("audio", "voice.m4a");
    const result = await saveCapture({ destination: "capture", text: "", items: [item] });
    expect(result.content).toContain("语音 1:12");
    const attachments = await listAttachments("capture", result.captureId ?? "");
    expect(attachments[0].transcript).toBeNull();
  });
});

describe("收集箱转任务：附件跟随而不是复制", () => {
  it("转任务后附件 owner 变为 task，文件路径不变", async () => {
    await open();
    const item = await stashOne("image");
    const saved = await saveCapture({ destination: "capture", text: "看图", items: [item], clientId: "cap-p" });
    const captureId = saved.captureId ?? "";
    const before = await listAttachments("capture", captureId);
    expect(before).toHaveLength(1);

    const taskId = await promoteCapture(captureId);
    expect(taskId).not.toBeNull();
    expect(await listAttachments("capture", captureId)).toHaveLength(0);
    const after = await listAttachments("task", taskId ?? "");
    expect(after).toHaveLength(1);
    expect(after[0].localUri).toBe(before[0].localUri);
  });
});

describe("附件传送状态机", () => {
  it("pending/failed 会进入待传送列表，sent/skipped 不会", async () => {
    await open();
    const saved = await saveCapture({
      destination: "capture",
      text: "两个附件",
      items: [await stashOne(), await stashOne("image", "b.jpg")],
      clientId: "cap-t",
    });
    const attachments = await listAttachments("capture", saved.captureId ?? "");
    expect(await listAttachmentsForTransfer()).toHaveLength(2);

    await setAttachmentTransferState(attachments[0].id, "sent", { remoteFileId: "a".repeat(32) });
    await setAttachmentTransferState(attachments[1].id, "failed", { error: "网络中断" });
    const pending = await listAttachmentsForTransfer();
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(attachments[1].id);

    await setAttachmentTransferState(attachments[1].id, "skipped");
    expect(await listAttachmentsForTransfer()).toHaveLength(0);
  });
});

describe("采集暂存", () => {
  it("写入、改说明、删除都落库", async () => {
    await open();
    const item = await stashOne();
    expect(await listStash()).toHaveLength(1);

    await updateStashItem(item.id, { note: "备注", transcript: "要点" });
    const [updated] = await listStash();
    expect(updated.note).toBe("备注");
    expect(updated.transcript).toBe("要点");

    await removeStashItem(item.id);
    expect(await listStash()).toHaveLength(0);
  });

  it("clearStash 清空所有暂存行", async () => {
    await open();
    await stashOne("image");
    await stashOne("file", "a.pdf");
    await clearStash();
    expect(await listStash()).toHaveLength(0);
  });
});

describe("addCapture 兼容既有调用", () => {
  it("纯文本收集箱仍可用，并保持幂等", async () => {
    await open();
    const first = await addCapture("只看文字", "cid-text");
    expect(first.capture?.content).toBe("只看文字");
    const second = await addCapture("只看文字", "cid-text");
    expect(second.duplicated).toBe(true);
  });
});
