// 附件归属生命周期回归（2026-11-17 移动端全量收口 DEF-M01）。
//
// 缺陷：deleteTask / deleteNote / deleteCapture 只软删除业务行，附件行保持 pending；
// 而「待传附件」查询不校验归属，导致：
// - 用户删除任务后，前台自动传送仍会把该任务的照片上传到桌面端（本机已删除的内容被外发）；
// - 同步页 / 诊断中心的「待传 N」永远降不到 0。
//
// 修复口径是「只隐藏，不销毁」：待传查询排除归属已被软删除的附件，
// 但附件行与本地字节保留，用户的原始素材不因删除业务记录而被删除。
//
// 用真实 SQL 跑 db 层原样代码（node:sqlite harness），不 mock 仓储函数。
import { beforeEach, describe, expect, it } from "vitest";

import type { StashedItem } from "../../domain/types";
import { countAttachmentsForTransfer, listAttachmentsForTransfer } from "../attachments";
import { addStashItem } from "../captureStash";
import { saveCapture } from "../captureSave";
import { deleteCapture, promoteCapture } from "../captures";
import { closeDatabase, getDatabase, openDatabase } from "../database";
import { deleteNote } from "../notes";
import { deleteTask } from "../tasks";

async function open() {
  await openDatabase();
}

async function stashOne(name = "photo.jpg"): Promise<StashedItem> {
  return addStashItem({
    kind: "image",
    mime: "image/jpeg",
    name,
    localUri: `file:///data/capture/${name}`,
    size: 1024,
    source: "camera",
  });
}

/** 读取附件行的软删除状态：用于证明「只隐藏、不销毁」 */
async function attachmentRowCount(): Promise<number> {
  const row = await getDatabase().getFirstAsync<{ n: number }>(
    "SELECT COUNT(*) AS n FROM attachments",
  );
  return row?.n ?? 0;
}

beforeEach(async () => {
  await closeDatabase();
});

describe("附件归属：业务记录删除后不再进入待传队列", () => {
  it("删除任务后：附件不计入待传，但附件行与本地路径保留", async () => {
    await open();
    const saved = await saveCapture({
      destination: "task",
      text: "带照片的任务",
      items: [await stashOne("task-photo.jpg")],
      clientId: "owner-task",
    });
    expect(saved.taskId).toBeTruthy();
    expect(await countAttachmentsForTransfer()).toBe(1);

    await deleteTask(saved.taskId!);

    expect(await countAttachmentsForTransfer()).toBe(0);
    expect(await listAttachmentsForTransfer()).toHaveLength(0);
    // 原始素材不能被删除：附件行仍在，localUri 仍指向原文件
    expect(await attachmentRowCount()).toBe(1);
    const row = await getDatabase().getFirstAsync<{ local_uri: string; deleted_at: number | null }>(
      "SELECT local_uri, deleted_at FROM attachments",
    );
    expect(row?.deleted_at).toBeNull();
    expect(row?.local_uri).toContain("task-photo.jpg");
  });

  it("删除笔记后：附件不计入待传，但附件行保留", async () => {
    await open();
    const saved = await saveCapture({
      destination: "note",
      text: "带图片的笔记",
      items: [await stashOne("note-photo.jpg")],
      clientId: "owner-note",
    });
    expect(saved.noteId).toBeTruthy();
    expect(await countAttachmentsForTransfer()).toBe(1);

    await deleteNote(saved.noteId!);

    expect(await countAttachmentsForTransfer()).toBe(0);
    expect(await attachmentRowCount()).toBe(1);
  });

  it("删除收集箱条目后：附件不再待传", async () => {
    await open();
    const saved = await saveCapture({
      destination: "capture",
      text: "",
      items: [await stashOne("inbox-photo.jpg")],
      clientId: "owner-capture",
    });
    expect(saved.captureId).toBeTruthy();

    await deleteCapture(saved.captureId!);

    expect(await countAttachmentsForTransfer()).toBe(0);
    expect(await listAttachmentsForTransfer()).toHaveLength(0);
    expect(await attachmentRowCount()).toBe(1);
  });

  it("收集箱转任务后：附件随归属迁移，仍然可待传", async () => {
    await open();
    const saved = await saveCapture({
      destination: "capture",
      text: "转任务的照片",
      items: [await stashOne("promote-photo.jpg")],
      clientId: "owner-promote",
    });
    const taskId = await promoteCapture(saved.captureId!);
    expect(taskId).toBeTruthy();

    const pending = await listAttachmentsForTransfer();
    expect(pending).toHaveLength(1);
    expect(pending[0].ownerEntity).toBe("task");
    expect(pending[0].ownerId).toBe(taskId);
    expect(await countAttachmentsForTransfer()).toBe(1);
  });

  it("只删除一条业务记录，不影响其它归属的待传附件", async () => {
    await open();
    const taskSave = await saveCapture({
      destination: "task",
      text: "会被删除的任务",
      items: [await stashOne("doomed.jpg")],
      clientId: "mixed-task",
    });
    await saveCapture({
      destination: "note",
      text: "保留的笔记",
      items: [await stashOne("kept.jpg")],
      clientId: "mixed-note",
    });
    expect(await countAttachmentsForTransfer()).toBe(2);

    await deleteTask(taskSave.taskId!);

    const pending = await listAttachmentsForTransfer();
    expect(pending).toHaveLength(1);
    expect(pending[0].name).toContain("kept");
    expect(await countAttachmentsForTransfer()).toBe(1);
  });
});
