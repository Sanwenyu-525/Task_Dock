//! AI 漫剧工作空间（C1）IPC 类型化包装：唯一出口是共享契约的 `creativeInvoke`。
//!
//! 约束（见 `../ipc.ts`）：参数 camelCase；禁止在组件里直接 `invoke`；
//! 命令名必须与 `lib.rs` `generate_handler!` 登记一致（注册由集成负责人完成）。

import { creativeInvoke } from "../ipc";
import type {
  ComicCharacter,
  ComicEpisode,
  ComicMediaVersion,
  ComicScene,
  ComicShot,
  EpisodeStatus,
  MediaKind,
  MediaStatus,
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
