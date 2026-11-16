//! 小说 B2 前端领域模型（与 Rust `novel_workspace.rs` 序列化字段一一对应，camelCase）。

/** 人物状态白名单（与后端 CHARACTER_STATUSES 一致）。 */
export type CharacterStatus = "unknown" | "active" | "missing" | "dead";

export const CHARACTER_STATUS_LABELS: Record<CharacterStatus, string> = {
  unknown: "未出场",
  active: "在世",
  missing: "失踪",
  dead: "死亡",
};

/** 人物关系类型白名单（与后端 RELATION_TYPES 一致）。 */
export type RelationType =
  | "family"
  | "friend"
  | "enemy"
  | "mentor"
  | "lover"
  | "colleague"
  | "other";

export const RELATION_TYPE_LABELS: Record<RelationType, string> = {
  family: "亲属",
  friend: "好友",
  enemy: "敌对",
  mentor: "师徒",
  lover: "恋人",
  colleague: "同事",
  other: "其他",
};

/** 世界观设定类型白名单（与后端 WORLDVIEW_KINDS 一致）。 */
export type WorldviewKind =
  | "location"
  | "faction"
  | "event"
  | "item"
  | "ability"
  | "custom";

export const WORLDVIEW_KIND_LABELS: Record<WorldviewKind, string> = {
  location: "地点",
  faction: "国家/组织/势力",
  event: "历史事件",
  item: "物品道具",
  ability: "能力与规则体系",
  custom: "自定义",
};

/** 引用实体类型（与后端 ENTITY_TYPES 一致）。 */
export type EntityType = "character" | "worldview";

export interface NovelCharacter {
  id: string;
  projectId: string;
  name: string;
  aliases: string;
  intro: string;
  appearance: string;
  background: string;
  motivation: string;
  faction: string;
  status: CharacterStatus;
  notes: string;
  tags: string[];
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface NovelCharacterRelation {
  id: string;
  projectId: string;
  fromCharacterId: string;
  toCharacterId: string;
  relationType: RelationType;
  description: string;
  fromName: string;
  toName: string;
  createdAt: string;
  updatedAt: string;
}

export interface NovelWorldviewEntry {
  id: string;
  projectId: string;
  kind: WorldviewKind;
  name: string;
  description: string;
  tags: string[];
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface NovelEntityRef {
  id: string;
  projectId: string;
  entityType: EntityType;
  entityId: string;
  entityName: string;
  chapterId: string;
  chapterTitle: string;
  note: string;
  createdAt: string;
}

/** 章节摘要（复用 v58 `novel_chapter_list`，引用选择器用；不含正文）。 */
export interface NovelChapterSummary {
  id: string;
  projectId: string;
  volumeId: string | null;
  title: string;
  wordCount: number;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

/** 人物表单草稿（编辑中状态，未保存不落库）。 */
export interface CharacterDraft {
  name: string;
  aliases: string;
  intro: string;
  appearance: string;
  background: string;
  motivation: string;
  faction: string;
  status: CharacterStatus;
  notes: string;
  tags: string[];
}

/** 世界观表单草稿。 */
export interface WorldviewDraft {
  kind: WorldviewKind;
  name: string;
  description: string;
  tags: string[];
}
