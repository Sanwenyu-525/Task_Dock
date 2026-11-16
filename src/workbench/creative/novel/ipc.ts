//! 小说 B2 IPC 类型化包装：唯一出口是共享契约的 `creativeInvoke`。
//!
//! 约束（见 `../ipc.ts`）：参数 camelCase；禁止在组件里直接 `invoke`；
//! 命令名必须与 `lib.rs` `generate_handler!` 登记一致（注册由集成负责人完成）。

import { creativeInvoke } from "../ipc";
import type {
  CharacterDraft,
  NovelChapterSummary,
  NovelCharacter,
  NovelCharacterRelation,
  NovelEntityRef,
  NovelWorldviewEntry,
  RelationType,
  WorldviewDraft,
  WorldviewKind,
} from "./types";

// ── 人物 ─────────────────────────────────────────────────────────────

export function novelCharacterList(projectId: string) {
  return creativeInvoke<{ characters: NovelCharacter[] }>("novel_character_list", {
    projectId,
  });
}

export function novelCharacterGet(id: string) {
  return creativeInvoke<{ character: NovelCharacter }>("novel_character_get", { id });
}

export function novelCharacterSave(
  projectId: string,
  draft: CharacterDraft,
  id?: string | null,
) {
  return creativeInvoke<{ character: NovelCharacter }>("novel_character_save", {
    id: id ?? null,
    projectId,
    name: draft.name,
    aliases: draft.aliases,
    intro: draft.intro,
    appearance: draft.appearance,
    background: draft.background,
    motivation: draft.motivation,
    faction: draft.faction,
    status: draft.status,
    notes: draft.notes,
    tags: draft.tags,
    sortOrder: null,
  });
}

export function novelCharacterDelete(id: string) {
  return creativeInvoke<{ ok: true }>("novel_character_delete", { id });
}

// ── 人物关系 ──────────────────────────────────────────────────────────

export function novelCharacterRelationList(
  projectId: string,
  characterId?: string | null,
) {
  return creativeInvoke<{ relations: NovelCharacterRelation[] }>(
    "novel_character_relation_list",
    { projectId, characterId: characterId ?? null },
  );
}

export function novelCharacterRelationSave(input: {
  projectId: string;
  fromCharacterId: string;
  toCharacterId: string;
  relationType: RelationType;
  description: string;
  id?: string | null;
}) {
  return creativeInvoke<{ relation: NovelCharacterRelation }>(
    "novel_character_relation_save",
    {
      id: input.id ?? null,
      projectId: input.projectId,
      fromCharacterId: input.fromCharacterId,
      toCharacterId: input.toCharacterId,
      relationType: input.relationType,
      description: input.description,
    },
  );
}

export function novelCharacterRelationDelete(id: string) {
  return creativeInvoke<{ ok: true }>("novel_character_relation_delete", { id });
}

// ── 世界观设定 ────────────────────────────────────────────────────────

export function novelWorldviewList(projectId: string, kind?: WorldviewKind | null) {
  return creativeInvoke<{ entries: NovelWorldviewEntry[] }>("novel_worldview_list", {
    projectId,
    kind: kind ?? null,
  });
}

export function novelWorldviewGet(id: string) {
  return creativeInvoke<{ entry: NovelWorldviewEntry }>("novel_worldview_get", { id });
}

export function novelWorldviewSave(
  projectId: string,
  draft: WorldviewDraft,
  id?: string | null,
) {
  return creativeInvoke<{ entry: NovelWorldviewEntry }>("novel_worldview_save", {
    id: id ?? null,
    projectId,
    kind: draft.kind,
    name: draft.name,
    description: draft.description,
    tags: draft.tags,
    sortOrder: null,
  });
}

export function novelWorldviewDelete(id: string) {
  return creativeInvoke<{ ok: true }>("novel_worldview_delete", { id });
}

// ── 章节引用 ──────────────────────────────────────────────────────────

export function novelEntityRefList(
  projectId: string,
  entityType?: string | null,
  entityId?: string | null,
) {
  return creativeInvoke<{ refs: NovelEntityRef[] }>("novel_entity_ref_list", {
    projectId,
    entityType: entityType ?? null,
    entityId: entityId ?? null,
  });
}

export function novelEntityRefAdd(input: {
  projectId: string;
  entityType: "character" | "worldview";
  entityId: string;
  chapterId: string;
  note?: string | null;
}) {
  return creativeInvoke<{ reference: NovelEntityRef }>("novel_entity_ref_add", {
    projectId: input.projectId,
    entityType: input.entityType,
    entityId: input.entityId,
    chapterId: input.chapterId,
    note: input.note ?? null,
  });
}

export function novelEntityRefDelete(id: string) {
  return creativeInvoke<{ ok: true }>("novel_entity_ref_delete", { id });
}

/** 复用 v58 既有命令：章节摘要列表（引用选择器；不含正文）。 */
export function novelChapterList(projectId: string) {
  return creativeInvoke<{ chapters: NovelChapterSummary[] }>("novel_chapter_list", {
    projectId,
  });
}
