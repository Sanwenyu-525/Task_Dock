// 开发者工具数据层测试：真实 SQLite（node:sqlite harness）+ kv 设置，不改写业务 SQL。
// 覆盖片段软删除/恢复、请求历史脱敏、资源收藏与打开计数、最近使用与取色历史的真实落库。
import { beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, openDatabase } from "../database";
import {
  createSnippet,
  deleteSnippet,
  getSnippet,
  listDeletedSnippets,
  listSnippetLanguages,
  listSnippets,
  purgeSnippet,
  restoreSnippet,
  touchSnippetUse,
  updateSnippet,
} from "../snippets";
import {
  clearHistory,
  deleteRequest,
  listRequests,
  saveRequest,
  touchRequestUse,
} from "../toolRequests";
import {
  createResource,
  deleteResource,
  getResource,
  listResourceCategories,
  listResources,
  touchResourceOpen,
  updateResource,
} from "../toolResources";
import {
  clearColors,
  clearRecentTools,
  listRecentTools,
  listSavedColors,
  recordColor,
  recordToolUse,
  removeColor,
  subscribeRecentTools,
  toggleColorFavorite,
} from "../toolUsage";
import { emptyDraft, newRow, type RequestDraft } from "../../domain/tools/apiRequest";

beforeEach(async () => {
  await closeDatabase();
  await openDatabase();
});

async function snippet(title: string, language = "typescript") {
  return createSnippet({
    title,
    language,
    content: `const ${title} = 1;`,
    tags: ["demo", "task"],
    favorite: false,
    pinned: false,
  });
}

describe("代码片段仓储", () => {
  it("创建后可按置顶/收藏/最近使用排序并统计语言", async () => {
    const first = await snippet("alpha");
    const second = await snippet("beta", "sql");
    await updateSnippet(first.id, { favorite: true });
    await updateSnippet(second.id, { pinned: true });
    const list = await listSnippets();
    expect(list.map((item) => item.title)).toEqual(["beta", "alpha"]);
    expect(list[1].tags).toEqual(["demo", "task"]);
    expect(await listSnippetLanguages()).toEqual(
      expect.arrayContaining([
        { language: "sql", count: 1 },
        { language: "typescript", count: 1 },
      ]),
    );
  });

  it("软删除进入回收站，恢复后重新可见，彻底删除只针对回收站", async () => {
    const item = await snippet("trash-me");
    await deleteSnippet(item.id);
    expect((await listSnippets()).map((row) => row.id)).not.toContain(item.id);
    expect((await listDeletedSnippets()).map((row) => row.id)).toEqual([item.id]);
    expect(await getSnippet(item.id)).not.toBeNull();

    await restoreSnippet(item.id);
    expect((await listSnippets()).map((row) => row.id)).toContain(item.id);
    expect(await listDeletedSnippets()).toEqual([]);

    await deleteSnippet(item.id);
    await purgeSnippet(item.id);
    expect(await getSnippet(item.id)).toBeNull();
  });

  it("使用只推进 last_used_at，不改变内容更新时间", async () => {
    const item = await snippet("touch");
    const before = (await getSnippet(item.id))!;
    await new Promise((resolve) => setTimeout(resolve, 5));
    await touchSnippetUse(item.id);
    const after = (await getSnippet(item.id))!;
    expect(after.lastUsedAt).not.toBeNull();
    expect(after.updatedAt).toBe(before.updatedAt);
  });
});

function draftWithSecret(): RequestDraft {
  const draft = emptyDraft();
  return {
    ...draft,
    method: "POST",
    url: "https://api.example.com/v1/items",
    headers: [
      { ...newRow("header"), name: "Authorization", value: "Bearer super-secret-token" },
      { ...newRow("header"), name: "Accept", value: "application/json" },
    ],
    bodyKind: "json",
    body: '{"password":"hunter2"}',
  };
}

describe("API 请求仓储", () => {
  it("收藏与历史分开存，历史写入前脱敏敏感 Header 与 JSON 密钥", async () => {
    const saved = await saveRequest("saved", draftWithSecret(), { name: "创建条目" });
    expect(saved.draft.headers[0].value).toContain("••••");
    expect(JSON.stringify(saved.draft)).not.toContain("super-secret-token");
    expect(JSON.stringify(saved.draft)).not.toContain("hunter2");
    expect(saved.draft.headers[1].value).toBe("application/json");

    await saveRequest("history", draftWithSecret(), { name: "自动历史" });
    await saveRequest("history", draftWithSecret(), {});
    expect((await listRequests("saved")).map((row) => row.id)).toEqual([saved.id]);
    expect((await listRequests("history")).length).toBe(2);
  });

  it("清空历史不影响收藏；删除与使用时间各自独立", async () => {
    const saved = await saveRequest("saved", draftWithSecret(), { name: "保留" });
    await saveRequest("history", draftWithSecret(), {});
    await clearHistory();
    expect(await listRequests("history")).toEqual([]);
    expect((await listRequests("saved")).map((row) => row.id)).toEqual([saved.id]);

    await touchRequestUse(saved.id);
    expect((await listRequests("saved"))[0].lastUsedAt).not.toBeNull();
    await deleteRequest(saved.id);
    expect(await listRequests("saved")).toEqual([]);
  });
});

describe("项目资料 / GitHub 资源仓储", () => {
  it("按 kind 分开查询，收藏与打开计数落库，删除后列表隐藏", async () => {
    const doc = await createResource({
      kind: "doc",
      title: "接口文档",
      url: "https://example.com/api",
      category: "接口",
      storage: "online",
    });
    await createResource({
      kind: "github",
      title: "task-dock",
      url: "https://github.com/example/task-dock",
      category: "GitHub",
    });

    expect((await listResources("doc")).map((row) => row.id)).toEqual([doc.id]);
    expect((await listResources("github")).length).toBe(1);
    expect(await listResourceCategories("doc")).toContain("接口");

    await updateResource(doc.id, { favorite: true, note: "先看鉴权" });
    await touchResourceOpen(doc.id);
    const updated = (await getResource(doc.id))!;
    expect(updated.favorite).toBe(true);
    expect(updated.note).toBe("先看鉴权");
    expect(updated.openCount).toBe(1);
    expect(updated.lastOpenedAt).not.toBeNull();

    await deleteResource(doc.id);
    expect(await listResources("doc")).toEqual([]);
    expect((await getResource(doc.id))?.deletedAt).not.toBeNull();
  });
});

describe("工具使用与取色历史", () => {
  it("最近使用去重并置顶，上限 12，且订阅者收到通知", async () => {
    let notified = 0;
    const unsubscribe = subscribeRecentTools(() => {
      notified += 1;
    });
    try {
      await recordToolUse("tool.snippet");
      await recordToolUse("tool.json");
      await recordToolUse("tool.snippet");
      const recent = await listRecentTools();
      expect(recent.map((row) => row.id)).toEqual(["tool.snippet", "tool.json"]);
      expect(recent[0].count).toBe(2);
      expect(notified).toBeGreaterThanOrEqual(2);

      for (let index = 0; index < 15; index += 1) {
        await recordToolUse(`tool.extra.${index}`);
      }
      expect((await listRecentTools()).length).toBe(12);
    } finally {
      unsubscribe();
      await clearRecentTools();
    }
  });

  it("取色历史规范化十六进制、保留收藏，并可移除/清空", async () => {
    await recordColor("#ff0000", "相册");
    await recordColor("#00FF00", "素材库");
    expect((await listSavedColors()).map((row) => row.hex)).toEqual(["#00FF00", "#FF0000"]);

    await toggleColorFavorite("#FF0000");
    expect((await listSavedColors()).find((row) => row.hex === "#FF0000")?.favorite).toBe(true);

    // 再次记录同一颜色不丢收藏状态
    await recordColor("#FF0000");
    expect((await listSavedColors()).find((row) => row.hex === "#FF0000")?.favorite).toBe(true);

    await removeColor("#00FF00");
    expect((await listSavedColors()).map((row) => row.hex)).toEqual(["#FF0000"]);
    await clearColors();
    expect(await listSavedColors()).toEqual([]);
  });
});
