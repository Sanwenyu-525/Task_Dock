//! AI 漫剧工作空间（C1）IPC 类型化包装：唯一出口是共享契约的 `creativeInvoke`。
//!
//! 约束（见 `../ipc.ts`）：参数 camelCase；禁止在组件里直接 `invoke`；
//! 命令名必须与 `lib.rs` `generate_handler!` 登记一致（注册由集成负责人完成）。

import { creativeInvoke } from "../ipc";
import { capabilitySkillList } from "../../../lib/bridge";
import type {
  ComicCharacter,
  ComicEpisode,
  ComicEpisodeCharacterOverride,
  ComicGenerationRecordInput,
  ComicGenerationRun,
  ComicMediaVersion,
  ComicOverviewStats,
  ComicPromptPreview,
  ComicPromptTemplate,
  ComicPromptVersion,
  ComicScene,
  ComicShot,
  ComicSkillOption,
  ComicSkillSnapshot,
  EpisodeStatus,
  MediaKind,
  MediaStatus,
  PromptCategory,
  ShotStatus,
} from "./types";

// ── 剧集 ──────────────────────────────────────────────────────────────

export function comicEpisodeList(projectId: string) {
  return creativeInvoke<{ episodes: ComicEpisode[] }>("comic_episode_list", {
    projectId,
  });
}

export function comicEpisodeGet(id: string) {
  return creativeInvoke<{ episode: ComicEpisode }>("comic_episode_get", { id });
}

export interface EpisodeSaveInput {
  id?: string | null;
  projectId: string;
  episodeNo?: number | null;
  title: string;
  synopsis: string;
  script: string;
  status: EpisodeStatus;
  progress: number;
  characterIds?: string[] | null;
  sortOrder?: number | null;
}

export function comicEpisodeSave(input: EpisodeSaveInput) {
  return creativeInvoke<{ episode: ComicEpisode }>("comic_episode_save", {
    id: input.id ?? null,
    projectId: input.projectId,
    episodeNo: input.episodeNo ?? null,
    title: input.title,
    synopsis: input.synopsis,
    script: input.script,
    status: input.status,
    progress: input.progress,
    characterIds: input.characterIds ?? null,
    sortOrder: input.sortOrder ?? null,
  });
}

export function comicEpisodeDelete(id: string) {
  return creativeInvoke<{ ok: boolean }>("comic_episode_delete", { id });
}

export function comicEpisodeReorder(projectId: string, episodeIds: string[]) {
  return creativeInvoke<{ episodes: ComicEpisode[] }>("comic_episode_reorder", {
    projectId,
    episodeIds,
  });
}

// ── 分镜 ──────────────────────────────────────────────────────────────

export function comicShotList(projectId: string, episodeId?: string | null) {
  return creativeInvoke<{ shots: ComicShot[] }>("comic_shot_list", {
    projectId,
    episodeId: episodeId ?? null,
  });
}

export function comicShotGet(id: string) {
  return creativeInvoke<{ shot: ComicShot }>("comic_shot_get", { id });
}

export interface ShotSaveInput {
  id?: string | null;
  projectId: string;
  episodeId: string;
  shotNo?: number | null;
  description: string;
  characterIds?: string[] | null;
  sceneId?: string | null;
  dialogue: string;
  shotSize: string;
  cameraMove: string;
  durationSec?: number | null;
  status: ShotStatus;
  assetRefs?: string[] | null;
  note: string;
  sortOrder?: number | null;
}

export function comicShotSave(input: ShotSaveInput) {
  return creativeInvoke<{ shot: ComicShot }>("comic_shot_save", {
    id: input.id ?? null,
    projectId: input.projectId,
    episodeId: input.episodeId,
    shotNo: input.shotNo ?? null,
    description: input.description,
    characterIds: input.characterIds ?? null,
    sceneId: input.sceneId ?? null,
    dialogue: input.dialogue,
    shotSize: input.shotSize,
    cameraMove: input.cameraMove,
    durationSec: input.durationSec ?? null,
    status: input.status,
    assetRefs: input.assetRefs ?? null,
    note: input.note,
    sortOrder: input.sortOrder ?? null,
  });
}

export function comicShotDelete(id: string) {
  return creativeInvoke<{ ok: boolean }>("comic_shot_delete", { id });
}

export function comicShotReorder(
  projectId: string,
  episodeId: string,
  shotIds: string[],
) {
  return creativeInvoke<{ shots: ComicShot[] }>("comic_shot_reorder", {
    projectId,
    episodeId,
    shotIds,
  });
}

// ── 角色 ──────────────────────────────────────────────────────────────

export function comicCharacterList(projectId: string) {
  return creativeInvoke<{ characters: ComicCharacter[] }>("comic_character_list", {
    projectId,
  });
}

export interface CharacterSaveInput {
  id?: string | null;
  projectId: string;
  name: string;
  role: string;
  description: string;
  refImagePath?: string | null;
  sortOrder?: number | null;
}

export function comicCharacterSave(input: CharacterSaveInput) {
  return creativeInvoke<{ character: ComicCharacter }>("comic_character_save", {
    id: input.id ?? null,
    projectId: input.projectId,
    name: input.name,
    role: input.role,
    description: input.description,
    refImagePath: input.refImagePath ?? null,
    sortOrder: input.sortOrder ?? null,
  });
}

export function comicCharacterDelete(id: string) {
  return creativeInvoke<{ ok: boolean }>("comic_character_delete", { id });
}

// ── 场景 ──────────────────────────────────────────────────────────────

export function comicSceneList(projectId: string) {
  return creativeInvoke<{ scenes: ComicScene[] }>("comic_scene_list", { projectId });
}

export interface SceneSaveInput {
  id?: string | null;
  projectId: string;
  name: string;
  description: string;
  refImagePath?: string | null;
  sortOrder?: number | null;
}

export function comicSceneSave(input: SceneSaveInput) {
  return creativeInvoke<{ scene: ComicScene }>("comic_scene_save", {
    id: input.id ?? null,
    projectId: input.projectId,
    name: input.name,
    description: input.description,
    refImagePath: input.refImagePath ?? null,
    sortOrder: input.sortOrder ?? null,
  });
}

export function comicSceneDelete(id: string) {
  return creativeInvoke<{ ok: boolean }>("comic_scene_delete", { id });
}

// ── 项目概览统计（项目中枢专业摘要）────────────────────────────────────

/**
 * 漫剧项目概览统计：后端一次只读聚合，只按 `projectId` 作用域统计，
 * 不加载剧集/分镜/素材行，也不扫描外部素材目录。
 */
export function comicOverviewStats(projectId: string) {
  return creativeInvoke<ComicOverviewStats>("comic_overview_stats", { projectId });
}

// ── 素材与产物版本 ────────────────────────────────────────────────────

export function comicMediaList(projectId: string, shotId?: string | null) {
  return creativeInvoke<{ versions: ComicMediaVersion[] }>("comic_media_list", {
    projectId,
    shotId: shotId ?? null,
  });
}

export interface MediaImportInput {
  id?: string | null;
  projectId: string;
  shotId?: string | null;
  characterId?: string | null;
  sceneId?: string | null;
  filePath: string;
  mediaKind: MediaKind;
  versionLabel?: string | null;
  reviewNote?: string | null;
  /** 可选：本次导入的素材由哪条外部生成记录产出（必须同项目/同镜头/同剧集）。 */
  generationRunId?: string | null;
}

export function comicMediaImport(input: MediaImportInput) {
  return creativeInvoke<{ version: ComicMediaVersion }>("comic_media_import", {
    id: input.id ?? null,
    projectId: input.projectId,
    shotId: input.shotId ?? null,
    characterId: input.characterId ?? null,
    sceneId: input.sceneId ?? null,
    filePath: input.filePath,
    mediaKind: input.mediaKind,
    versionLabel: input.versionLabel ?? null,
    reviewNote: input.reviewNote ?? null,
    generationRunId: input.generationRunId ?? null,
  });
}

export function comicMediaSave(
  id: string,
  patch: { versionLabel?: string | null; status?: MediaStatus | null; reviewNote?: string | null },
) {
  return creativeInvoke<{ version: ComicMediaVersion }>("comic_media_save", {
    id,
    versionLabel: patch.versionLabel ?? null,
    status: patch.status ?? null,
    reviewNote: patch.reviewNote ?? null,
  });
}

export function comicMediaAdopt(id: string) {
  return creativeInvoke<{ version: ComicMediaVersion }>("comic_media_adopt", { id });
}

export function comicMediaDelete(id: string) {
  return creativeInvoke<{ ok: boolean }>("comic_media_delete", { id });
}

// ── 每集角色形象覆盖（v96）────────────────────────────────────────────

export function comicEpisodeCharacterOverrideList(projectId: string, episodeId: string) {
  return creativeInvoke<{ overrides: ComicEpisodeCharacterOverride[] }>(
    "comic_episode_character_override_list",
    { projectId, episodeId },
  );
}

export interface EpisodeCharacterOverrideInput {
  projectId: string;
  episodeId: string;
  characterId: string;
  roleInEpisode: string;
  appearanceLabel: string;
  appearanceDescription: string;
  costumeDescription: string;
  hairStyleDescription: string;
  stateDescription: string;
  visualPromptOverride: string;
  refImagePath: string;
}

export function comicEpisodeCharacterOverrideSave(input: EpisodeCharacterOverrideInput) {
  return creativeInvoke<{ record: ComicEpisodeCharacterOverride }>(
    "comic_episode_character_override_save",
    { ...input },
  );
}

export function comicEpisodeCharacterOverrideDelete(
  projectId: string,
  episodeId: string,
  characterId: string,
) {
  return creativeInvoke<{ ok: boolean }>("comic_episode_character_override_delete", {
    projectId,
    episodeId,
    characterId,
  });
}

// ── 提示词模板 / 版本 / 渲染（v96）────────────────────────────────────

export function comicPromptTemplateList(projectId: string) {
  return creativeInvoke<{ templates: ComicPromptTemplate[] }>("comic_prompt_template_list", {
    projectId,
  });
}

export interface PromptTemplateSaveInput {
  id?: string | null;
  projectId: string;
  name: string;
  category: PromptCategory;
  description: string;
}

export function comicPromptTemplateSave(input: PromptTemplateSaveInput) {
  return creativeInvoke<{ template: ComicPromptTemplate }>("comic_prompt_template_save", {
    id: input.id ?? null,
    projectId: input.projectId,
    name: input.name,
    category: input.category,
    description: input.description,
  });
}

export function comicPromptVersionList(templateId: string) {
  return creativeInvoke<{ versions: ComicPromptVersion[] }>("comic_prompt_version_list", {
    templateId,
  });
}

export interface PromptVersionCreateInput {
  templateId: string;
  content: string;
  variablesJson: string;
  changeNote: string;
}

export function comicPromptVersionCreate(input: PromptVersionCreateInput) {
  return creativeInvoke<{ version: ComicPromptVersion }>("comic_prompt_version_create", {
    templateId: input.templateId,
    content: input.content,
    variablesJson: input.variablesJson,
    changeNote: input.changeNote,
  });
}

export function comicPromptVersionSetDefault(templateId: string, versionId: string) {
  return creativeInvoke<{ version: ComicPromptVersion }>(
    "comic_prompt_version_set_default",
    { templateId, versionId },
  );
}

export function comicPromptRender(input: {
  projectId: string;
  promptVersionId: string;
  episodeId: string;
  shotId?: string | null;
}) {
  return creativeInvoke<{ preview: ComicPromptPreview }>("comic_prompt_render", {
    projectId: input.projectId,
    promptVersionId: input.promptVersionId,
    episodeId: input.episodeId,
    shotId: input.shotId ?? null,
  });
}

// ── Skill 快照（v96）：复用能力中心 Skill，不复制第二套目录 ─────────────

/** 只读投影能力中心 Skill：字段裁剪 + 保留声明版本/启用/丢失/作用域事实。 */
export async function comicSkillList(): Promise<ComicSkillOption[]> {
  const skills = await capabilitySkillList({});
  return (skills ?? []).map((skill) => ({
    id: skill.id,
    name: skill.name,
    description: skill.description,
    declaredVersion: skill.version,
    scope: skill.scope,
    projectId: skill.projectId,
    enabled: skill.enabled,
    missing: skill.missing,
    riskLevel: skill.riskLevel,
    updatedAt: skill.updatedAt,
  }));
}

export function comicSkillSnapshotCapture(projectId: string, skillId: string) {
  return creativeInvoke<{ snapshot: ComicSkillSnapshot }>("comic_skill_snapshot_capture", {
    projectId,
    skillId,
  });
}

export function comicSkillSnapshotList(projectId: string, skillId?: string | null) {
  return creativeInvoke<{ snapshots: ComicSkillSnapshot[] }>("comic_skill_snapshot_list", {
    projectId,
    skillId: skillId ?? null,
  });
}

export function comicSkillSnapshotGet(snapshotId: string) {
  return creativeInvoke<{ snapshot: ComicSkillSnapshot }>("comic_skill_snapshot_get", {
    snapshotId,
  });
}

// ── 外部生成记录（v96）────────────────────────────────────────────────

export function comicGenerationRecordCreate(input: ComicGenerationRecordInput) {
  return creativeInvoke<{ run: ComicGenerationRun }>("comic_generation_record_create", {
    input,
  });
}

export function comicGenerationRecordList(
  projectId: string,
  episodeId?: string | null,
  shotId?: string | null,
) {
  return creativeInvoke<{ runs: ComicGenerationRun[] }>("comic_generation_record_list", {
    projectId,
    episodeId: episodeId ?? null,
    shotId: shotId ?? null,
  });
}
