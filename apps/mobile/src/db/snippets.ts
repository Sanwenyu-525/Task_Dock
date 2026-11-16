// 代码片段仓储：唯一允许出现 SQL 的层。本机数据，不写 outbox、不参与同步。
//
// 一致性规则：
// - 删除是软删除（deleted_at），回收站可以恢复；恢复后 updated_at 推进，列表重新可见；
// - 每次写都推进 updated_at；「最近使用」用独立列 last_used_at，复制/分享不会改内容时间；
// - 标签以逗号分隔存 TEXT（读取时归一化），不做额外关联表：片段量级小，搜索用 LIKE 足够。
import { getDatabase } from "./database";

import type { Snippet, SnippetDraft } from "../domain/tools/snippetModel";
import { normalizeTags } from "../domain/tools/snippetModel";
import { newId } from "../lib/id";

interface SnippetRow {
  id: string;
  title: string;
  language: string;
  content: string;
  tags: string;
  favorite: number;
  pinned: number;
  created_at: number;
  updated_at: number;
  last_used_at: number | null;
  deleted_at: number | null;
}

const COLUMNS = `id, title, language, content, tags, favorite, pinned, created_at, updated_at, last_used_at, deleted_at`;

function mapRow(row: SnippetRow): Snippet {
  return {
    id: row.id,
    title: row.title,
    language: row.language,
    content: row.content,
    tags: normalizeTags(row.tags ?? ""),
    favorite: row.favorite !== 0,
    pinned: row.pinned !== 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
    deletedAt: row.deleted_at,
  };
}

/**
 * 列表查询。搜索与筛选在 SQL 里完成（避免把全部片段读进内存再过滤），
 * 排序与 domain 的 sortSnippets 保持一致：置顶 → 收藏 → 最近使用 → 更新时间。
 */
export async function listSnippets(): Promise<Snippet[]> {
  const db = getDatabase();
  const rows = await db.getAllAsync<SnippetRow>(
    `SELECT ${COLUMNS} FROM snippets
      WHERE deleted_at IS NULL
      ORDER BY pinned DESC, favorite DESC, COALESCE(last_used_at, updated_at) DESC, updated_at DESC`,
  );
  return rows.map(mapRow);
}

export async function listDeletedSnippets(): Promise<Snippet[]> {
  const db = getDatabase();
  const rows = await db.getAllAsync<SnippetRow>(
    `SELECT ${COLUMNS} FROM snippets WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC`,
  );
  return rows.map(mapRow);
}

export async function getSnippet(id: string): Promise<Snippet | null> {
  const db = getDatabase();
  const row = await db.getFirstAsync<SnippetRow>(`SELECT ${COLUMNS} FROM snippets WHERE id = ?`, [id]);
  return row ? mapRow(row) : null;
}

export async function createSnippet(draft: SnippetDraft): Promise<Snippet> {
  const db = getDatabase();
  const now = Date.now();
  const id = newId("snip");
  const tags = normalizeTags(draft.tags);
  await db.runAsync(
    `INSERT INTO snippets (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      draft.title,
      draft.language,
      draft.content,
      tags.join(","),
      draft.favorite ? 1 : 0,
      draft.pinned ? 1 : 0,
      now,
      now,
      null,
      null,
    ],
  );
  return {
    id,
    title: draft.title,
    language: draft.language,
    content: draft.content,
    tags,
    favorite: draft.favorite,
    pinned: draft.pinned,
    createdAt: now,
    updatedAt: now,
    lastUsedAt: null,
    deletedAt: null,
  };
}

export interface SnippetPatch {
  title?: string | null;
  language?: string | null;
  content?: string | null;
  tags?: string[] | null;
  favorite?: boolean | null;
  pinned?: boolean | null;
}

/** 三态更新：undefined = 不改，null = 清空/恢复默认，有值 = 写入。 */
export async function updateSnippet(id: string, patch: SnippetPatch): Promise<Snippet | null> {
  const db = getDatabase();
  const current = await getSnippet(id);
  if (!current || current.deletedAt !== null) return null;

  const assignments: string[] = [];
  const values: (string | number | null)[] = [];
  const set = (column: string, value: string | number | null): void => {
    assignments.push(`${column} = ?`);
    values.push(value);
  };

  if (patch.title !== undefined) set("title", patch.title === null ? "" : patch.title.trim());
  if (patch.language !== undefined) set("language", patch.language === null ? "text" : patch.language);
  if (patch.content !== undefined) set("content", patch.content === null ? "" : patch.content);
  if (patch.tags !== undefined) set("tags", normalizeTags(patch.tags ?? []).join(","));
  if (patch.favorite !== undefined) set("favorite", (patch.favorite ?? false) ? 1 : 0);
  if (patch.pinned !== undefined) set("pinned", (patch.pinned ?? false) ? 1 : 0);

  if (assignments.length === 0) return current;

  const now = Date.now();
  assignments.push("updated_at = ?");
  values.push(now);
  await db.runAsync(`UPDATE snippets SET ${assignments.join(", ")} WHERE id = ?`, [...values, id]);
  return getSnippet(id);
}

/** 软删除：保留行供回收站恢复。 */
export async function deleteSnippet(id: string): Promise<void> {
  const db = getDatabase();
  await db.runAsync(`UPDATE snippets SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`, [
    Date.now(),
    Date.now(),
    id,
  ]);
}

export async function restoreSnippet(id: string): Promise<Snippet | null> {
  const db = getDatabase();
  await db.runAsync(`UPDATE snippets SET deleted_at = NULL, updated_at = ? WHERE id = ?`, [Date.now(), id]);
  return getSnippet(id);
}

/** 永久删除（回收站里用户明确选择时）。 */
export async function purgeSnippet(id: string): Promise<void> {
  const db = getDatabase();
  await db.runAsync(`DELETE FROM snippets WHERE id = ? AND deleted_at IS NOT NULL`, [id]);
}

/** 复制/分享后记录一次使用；只改 last_used_at，不推进 updated_at（不改变编辑时间语义）。 */
export async function touchSnippetUse(id: string): Promise<void> {
  const db = getDatabase();
  await db.runAsync(`UPDATE snippets SET last_used_at = ? WHERE id = ? AND deleted_at IS NULL`, [Date.now(), id]);
}

/** 语言分布（筛选条只显示实际存在的语言，避免列出 17 个空选项）。 */
export async function listSnippetLanguages(): Promise<{ language: string; count: number }[]> {
  const db = getDatabase();
  const rows = await db.getAllAsync<{ language: string; count: number }>(
    `SELECT language, COUNT(*) AS count FROM snippets WHERE deleted_at IS NULL GROUP BY language ORDER BY count DESC`,
  );
  return rows.map((row) => ({ language: row.language, count: Number(row.count) || 0 }));
}
