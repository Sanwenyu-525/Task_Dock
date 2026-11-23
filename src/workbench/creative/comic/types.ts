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

/**
 * 漫剧项目概览统计（项目中枢「专业工作进展」摘要）。
 *
 * 与 `comic_workspace.rs::ComicOverviewStats` 一一对应：后端整表聚合，
 * 前端不遍历剧集/分镜/素材。`updatedAt` 是五张领域表的最近更新时间，
 * 空项目为 `null`（后端不拿查询时间冒充数据更新时间）。
 */
export interface ComicOverviewStats {
  projectId: string;
  episodeCount: number;
  completedEpisodeCount: number;
  shotCount: number;
  completedShotCount: number;
  pendingShotCount: number;
  doingShotCount: number;
  blockedShotCount: number;
  characterCount: number;
  sceneCount: number;
  mediaCount: number;
  adoptedMediaCount: number;
  updatedAt: string | null;
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
  /** 可选：本次素材由哪条外部生成记录产出（v96）。 */
  generationRunId: string | null;
  /** 读时拼装：`提供商 · 模型 · 版本`；无关联时为 null。 */
  generationLabel: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * 每集角色形象覆盖（v96）：只描述「这一集」。
 *
 * `character` 是全局基础档案（唯一事实来源）；覆盖字段为空时必须回落到基础档案，
 * 绝不允许「清空覆盖 = 清空角色」。
 */
export interface ComicEpisodeCharacterOverride {
  id: string;
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
  refImageExists: boolean;
  character: ComicCharacter;
  createdAt: string;
  updatedAt: string;
}

/** 合并后的有效角色视图：字段来源明确区分（base / override）。 */
export interface EffectiveEpisodeCharacter {
  character: ComicCharacter;
  override: ComicEpisodeCharacterOverride | null;
  /** 本集是否使用了专用形象覆盖。 */
  usingOverride: boolean;
  role: string;
  appearanceLabel: string;
  appearanceDescription: string;
  costumeDescription: string;
  hairStyleDescription: string;
  stateDescription: string;
  visualPromptOverride: string;
  refImagePath: string;
  refImageExists: boolean;
  /** 参考图是否来自本集专用覆盖（而不是全局档案）。 */
  usingOverrideRefImage: boolean;
  /** 每个字段的实际来源，供界面标注「本集 / 全局」。 */
  sources: {
    role: "base" | "override";
    appearanceDescription: "base" | "override";
    costumeDescription: "override" | "none";
    hairStyleDescription: "override" | "none";
    stateDescription: "override" | "none";
  };
}

export type PromptCategory =
  | "character_reference"
  | "scene_reference"
  | "storyboard"
  | "image_generation"
  | "video_generation"
  | "inpaint"
  | "other";

export interface ComicPromptTemplate {
  id: string;
  projectId: string;
  name: string;
  category: PromptCategory;
  description: string;
  versionCount: number;
  defaultVersionId: string | null;
  defaultVersionNo: number | null;
  defaultContentHash: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ComicPromptVersion {
  id: string;
  templateId: string;
  versionNo: number;
  content: string;
  variablesJson: string;
  contentHash: string;
  changeNote: string;
  isDefault: boolean;
  createdAt: string;
}

export interface ComicPromptContextCharacter {
  id: string;
  name: string;
  role: string;
  baseDescription: string;
  appearanceLabel: string;
  appearanceDescription: string;
  costumeDescription: string;
  hairStyleDescription: string;
  stateDescription: string;
  /** 本集专属视觉提示词补充（v99）：只在渲染本集时进入角色块，不写回全局档案。 */
  visualPromptOverride: string;
  refImagePath: string;
  usingOverride: boolean;
}

export interface ComicPromptContextScene {
  id: string;
  name: string;
  description: string;
  refImagePath: string;
}

export interface ComicPromptContextShot {
  id: string;
  shotNo: number;
  description: string;
}

export interface ComicPromptContext {
  projectId: string;
  episodeId: string;
  shotId: string | null;
  variables: Record<string, string>;
  characters: ComicPromptContextCharacter[];
  scenes: ComicPromptContextScene[];
  shot: ComicPromptContextShot | null;
}

export interface ComicPromptPreview {
  promptVersionId: string;
  templateId: string;
  templateName: string;
  versionNo: number;
  contentHash: string;
  requiredVariables: string[];
  rendered: string;
  context: ComicPromptContext;
}

export interface ComicSkillSnapshot {
  id: string;
  projectId: string;
  sourceSkillId: string;
  skillName: string;
  declaredVersion: string;
  contentHash: string;
  contentSnapshot: string;
  filesManifestJson: string;
  /** 附属文件清单的 SHA-256（v99）；历史快照可能为空串（当时未计算，不猜测）。 */
  filesManifestHash: string;
  /** 完整快照指纹（v99）：来源 Skill + 内容 Hash + 声明版本 + 附属清单 Hash。 */
  snapshotFingerprint: string;
  fileCount: number;
  createdAt: string;
}

/** 能力中心 Skill 的只读投影（不复制 Skill 存储，只用于选择与展示）。 */
export interface ComicSkillOption {
  id: string;
  name: string;
  description: string;
  declaredVersion: string;
  scope: string;
  projectId: string | null;
  enabled: boolean;
  missing: boolean;
  riskLevel: string;
  updatedAt: string;
}

export interface ComicGenerationRun {
  id: string;
  projectId: string;
  episodeId: string;
  episodeTitle: string;
  shotId: string | null;
  shotNo: number | null;
  promptVersionId: string;
  promptTemplateName: string;
  promptVersionNo: number;
  /** 登记当时提示词版本的内容 Hash（v99）。 */
  promptContentHashSnapshot: string;
  skillSnapshotId: string | null;
  skillName: string | null;
  skillDeclaredVersion: string | null;
  /** 外部工具实际收到的提示词（用户确认提交，不是登记时重新渲染的结果）。 */
  renderedPromptSnapshot: string;
  /** 渲染上下文摘要 JSON（角色/场景/镜头/变量名），空串表示未保存。 */
  contextSnapshotJson: string;
  skillContentHashSnapshot: string;
  modelProvider: string;
  modelName: string;
  modelVersion: string;
  parametersJson: string;
  seed: string;
  inputMediaIds: string[];
  /** 由媒体版本反查：这条记录产出的素材（可能 0..N 个）。 */
  outputMediaIds: string[];
  externalJobId: string;
  note: string;
  createdAt: string;
}

export interface ComicGenerationRecordInput {
  projectId: string;
  episodeId: string;
  shotId?: string | null;
  promptVersionId: string;
  /** 必填：外部 AI 实际使用的最终提示词（可粘贴/微调，后端不重新渲染覆盖）。 */
  renderedPromptSnapshot: string;
  skillSnapshotId?: string | null;
  modelProvider: string;
  modelName: string;
  modelVersion: string;
  parametersJson?: string | null;
  seed: string;
  inputMediaIds?: string[] | null;
  externalJobId: string;
  note: string;
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

export const PROMPT_CATEGORY_LABELS: Record<PromptCategory, string> = {
  character_reference: "角色参考",
  scene_reference: "场景参考",
  storyboard: "分镜",
  image_generation: "图片生成",
  video_generation: "视频生成",
  inpaint: "局部重绘",
  other: "其他",
};

/** 与后端 `COMIC_PROMPT_VARIABLES` 保持一致：渲染只做纯文本替换。 */
export const COMIC_PROMPT_VARIABLES = [
  "project.name",
  "episode.title",
  "episode.synopsis",
  "episode.script",
  "characters.block",
  "scene.block",
  "shot.description",
  "shot.dialogue",
  "shot.shot_size",
  "shot.camera_move",
] as const;

/** 内容 Hash 短标识（前 8 位），用于「声明版本 + 实际内容版本」并列展示。 */
export function shortHash(hash: string | null | undefined): string {
  if (!hash) return "—";
  const trimmed = hash.trim();
  return trimmed.length > 8 ? trimmed.slice(0, 8) : trimmed;
}
