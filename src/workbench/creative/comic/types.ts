//! AI 漫剧工作空间（C1）前端类型：与 `comic_workspace.rs` 序列化结构一一对应。
//!
//! 约束见 `../types.ts`：本目录只读共享契约；命令参数 camelCase。

export type EpisodeStatus =
  | "draft"
  | "scripting"
  | "storyboard"
  | "producing"
  | "reviewing"
  | "done";

export type ShotStatus = "todo" | "doing" | "blocked" | "done";

export type MediaKind = "image" | "video" | "other";

export type MediaStatus = "candidate" | "adopted" | "rejected";

export interface ComicEpisode {
  id: string;
  projectId: string;
  episodeNo: number;
  title: string;
  synopsis: string;
  script: string;
  status: EpisodeStatus;
  progress: number;
  characterIds: string[];
  shotCount: number;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface ComicShot {
  id: string;
  projectId: string;
  episodeId: string;
  shotNo: number;
  description: string;
  characterIds: string[];
  sceneId: string | null;
  dialogue: string;
  shotSize: string;
  cameraMove: string;
  durationSec: number;
  status: ShotStatus;
  assetRefs: string[];
  note: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface ComicCharacter {
  id: string;
  projectId: string;
  name: string;
  role: string;
  description: string;
  refImagePath: string;
  refImageExists: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface ComicScene {
  id: string;
  projectId: string;
  name: string;
  description: string;
  refImagePath: string;
  refImageExists: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface ComicMediaVersion {
  id: string;
  projectId: string;
  shotId: string | null;
  characterId: string | null;
  sceneId: string | null;
  filePath: string;
  /** 读时计算：引用路径当前是否存在；false = 文件缺失，前端降级提示。 */
  fileExists: boolean;
  mediaKind: MediaKind;
  versionLabel: string;
  status: MediaStatus;
  reviewNote: string;
  source: "imported" | "planned";
  createdAt: string;
  updatedAt: string;
}

export const EPISODE_STATUS_LABELS: Record<EpisodeStatus, string> = {
  draft: "草稿",
  scripting: "剧本",
  storyboard: "分镜",
  producing: "制作中",
  reviewing: "审核中",
  done: "完成",
};

export const SHOT_STATUS_LABELS: Record<ShotStatus, string> = {
  todo: "待办",
  doing: "进行中",
  blocked: "阻塞",
  done: "完成",
};

export const MEDIA_KIND_LABELS: Record<MediaKind, string> = {
  image: "图片",
  video: "视频",
  other: "其他",
};

export const MEDIA_STATUS_LABELS: Record<MediaStatus, string> = {
  candidate: "候选",
  adopted: "采用",
  rejected: "已拒收",
};
