//! AI 漫剧工作空间专业后端（C1，2026-11-16）：剧集 / 分镜 / 角色场景 / 产物版本。
//!
//! ## 归属
//! 本文件由**漫剧线**独占编写；`commands/mod.rs`、`db/mod.rs`、`lib.rs`、`backup.rs`
//! 由集成负责人维护，本文件不得修改它们。
//!
//! ## 约定
//! - 命令命名前缀 `comic_`，形参见 `project_workspace.rs`（`*_impl(db, ...)` + 薄 `#[tauri::command]`）。
//! - 写入门禁：`kind = ai_comic` 且 `status = active`；读取允许归档项目（归档 = 只读）。
//! - 素材只存**路径引用 + 元数据**，不复制用户原始文件；文件失效时读侧返回 `file_exists=false`，
//!   前端降级为「文件缺失」提示，不崩溃、不静默清理引用。
//! - 删除剧集/镜头/角色/场景/版本只删本地元数据行，**绝不删除、移动、重命名用户素材原文件**。
//! - AI 生成能力本轮**未接入**：不提供生成命令；导入命令只接受 `source = imported`，
//!   不伪造已生成产物。

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::Arc;
use tauri::State;

use crate::agents::now_iso;
use crate::db::Db;
use crate::error::{AppError, AppResult};

/// v61：剧集 / 分镜 / 角色 / 场景 / 素材版本（漫剧 C1）。
///
/// 关系：
/// - `comic_episodes.project_id` → `workspace_projects` 级联；
/// - `comic_shots.episode_id` → `comic_episodes` 级联，`project_id` 级联；
/// - `comic_characters` / `comic_scenes.project_id` 级联；
/// - `comic_media_versions` 可挂到镜头（级联）/ 角色 / 场景（置空）；
/// - 剧集↔角色、镜头↔角色用 JSON 数组列承载（契约冻结表清单外不新增关系表）；
/// - 镜头↔场景用 `scene_id` 单外键。
pub const MIGRATION_61: (i64, &'static str) = (
    61,
    r#"
-- v61（漫剧 C1）：剧集 / 分镜 / 角色 / 场景 / 素材版本。
CREATE TABLE comic_episodes (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES workspace_projects(id) ON DELETE CASCADE,
  episode_no INTEGER NOT NULL DEFAULT 0 CHECK (episode_no >= 0),
  title TEXT NOT NULL,
  synopsis TEXT NOT NULL DEFAULT '',
  script TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','scripting','storyboard','producing','reviewing','done')),
  progress INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  character_ids_json TEXT NOT NULL DEFAULT '[]',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_comic_episodes_project
  ON comic_episodes(project_id, sort_order, created_at);

CREATE TABLE comic_characters (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES workspace_projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  ref_image_path TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_comic_characters_project
  ON comic_characters(project_id, sort_order, created_at);

CREATE TABLE comic_scenes (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES workspace_projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  ref_image_path TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_comic_scenes_project
  ON comic_scenes(project_id, sort_order, created_at);

CREATE TABLE comic_shots (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES workspace_projects(id) ON DELETE CASCADE,
  episode_id TEXT NOT NULL REFERENCES comic_episodes(id) ON DELETE CASCADE,
  shot_no INTEGER NOT NULL DEFAULT 0 CHECK (shot_no >= 0),
  description TEXT NOT NULL DEFAULT '',
  character_ids_json TEXT NOT NULL DEFAULT '[]',
  scene_id TEXT REFERENCES comic_scenes(id) ON DELETE SET NULL,
  dialogue TEXT NOT NULL DEFAULT '',
  shot_size TEXT NOT NULL DEFAULT '',
  camera_move TEXT NOT NULL DEFAULT '',
  duration_sec REAL NOT NULL DEFAULT 0 CHECK (duration_sec >= 0),
  status TEXT NOT NULL DEFAULT 'todo'
    CHECK (status IN ('todo','doing','blocked','done')),
  asset_refs_json TEXT NOT NULL DEFAULT '[]',
  note TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_comic_shots_episode
  ON comic_shots(episode_id, sort_order, created_at);
CREATE INDEX idx_comic_shots_project
  ON comic_shots(project_id, sort_order, created_at);
CREATE INDEX idx_comic_shots_scene ON comic_shots(scene_id);

CREATE TABLE comic_media_versions (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES workspace_projects(id) ON DELETE CASCADE,
  shot_id TEXT REFERENCES comic_shots(id) ON DELETE CASCADE,
  character_id TEXT REFERENCES comic_characters(id) ON DELETE SET NULL,
  scene_id TEXT REFERENCES comic_scenes(id) ON DELETE SET NULL,
  file_path TEXT NOT NULL,
  media_kind TEXT NOT NULL DEFAULT 'image'
    CHECK (media_kind IN ('image','video','other')),
  version_label TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'candidate'
    CHECK (status IN ('candidate','adopted','rejected')),
  review_note TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'imported'
    CHECK (source IN ('imported','planned')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_comic_media_shot ON comic_media_versions(shot_id, created_at);
CREATE INDEX idx_comic_media_project ON comic_media_versions(project_id, created_at);
-- 同一镜头同一时刻只能有一个 adopted（角色/场景参考图不参与采用互斥）。
CREATE UNIQUE INDEX idx_comic_media_adopted_shot
  ON comic_media_versions(shot_id)
  WHERE status = 'adopted' AND shot_id IS NOT NULL;
"#,
);

/// v96：漫剧 C3——每集角色形象覆盖、提示词模板/不可变版本、Skill 快照、外部生成追溯。
///
/// 关系与边界：
/// - 覆盖表 `UNIQUE(episode_id, character_id)`：全局 `comic_characters` 仍是基础事实来源，
///   覆盖只描述「这一集」的服装/发型/状态，删除覆盖即恢复全局；
/// - 提示词版本只增不改：`UNIQUE(template_id, version_no)` + 部分唯一索引保证同模板只有一个默认版本；
///   生成记录对版本是 `ON DELETE RESTRICT`，被引用的版本无法删除；
/// - Skill 快照对 `capability_skills` **不建外键**：原始 Skill 删除/重建不能带走历史快照；
/// - `comic_media_versions.generation_run_id` 反向关联生成记录（一个记录可对多个输出素材）。
///
/// 兼容回填（迁移内、幂等）：历史镜头可能引用了角色，但剧集出场名单尚未登记。
/// 先按 `剧集名单 ∪ 该集全部镜头角色` 去重、且只保留当前项目真实存在的角色，
/// 回填 `comic_episodes.character_ids_json`，之后才启用严格校验。
pub const MIGRATION_96: (i64, &'static str) = (
    96,
    r#"
-- 每集角色形象覆盖（v96）：只覆盖本集，不写回全局角色档案。
CREATE TABLE comic_episode_character_overrides (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES workspace_projects(id) ON DELETE CASCADE,
  episode_id TEXT NOT NULL REFERENCES comic_episodes(id) ON DELETE CASCADE,
  character_id TEXT NOT NULL REFERENCES comic_characters(id) ON DELETE CASCADE,
  role_in_episode TEXT NOT NULL DEFAULT '',
  appearance_label TEXT NOT NULL DEFAULT '',
  appearance_description TEXT NOT NULL DEFAULT '',
  costume_description TEXT NOT NULL DEFAULT '',
  hair_style_description TEXT NOT NULL DEFAULT '',
  state_description TEXT NOT NULL DEFAULT '',
  visual_prompt_override TEXT NOT NULL DEFAULT '',
  ref_image_path TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(episode_id, character_id)
);
CREATE INDEX idx_comic_ep_char_overrides_episode
  ON comic_episode_character_overrides(episode_id, created_at);
CREATE INDEX idx_comic_ep_char_overrides_project
  ON comic_episode_character_overrides(project_id, updated_at);

-- 提示词模板元信息（v96）：正文只在版本表，防止「改模板顺手改掉历史正文」。
CREATE TABLE comic_prompt_templates (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES workspace_projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'other'
    CHECK (category IN ('character_reference','scene_reference','storyboard',
                        'image_generation','video_generation','inpaint','other')),
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_comic_prompt_templates_name
  ON comic_prompt_templates(project_id, name);

-- 提示词版本（v96）：只插入新版本，不提供更新/删除入口；默认版本同模板唯一。
CREATE TABLE comic_prompt_versions (
  id TEXT PRIMARY KEY NOT NULL,
  template_id TEXT NOT NULL REFERENCES comic_prompt_templates(id) ON DELETE CASCADE,
  version_no INTEGER NOT NULL CHECK (version_no > 0),
  content TEXT NOT NULL,
  variables_json TEXT NOT NULL DEFAULT '[]',
  content_hash TEXT NOT NULL,
  change_note TEXT NOT NULL DEFAULT '',
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  created_at TEXT NOT NULL,
  UNIQUE(template_id, version_no)
);
CREATE UNIQUE INDEX idx_comic_prompt_versions_default
  ON comic_prompt_versions(template_id)
  WHERE is_default = 1;

-- Skill 内容快照（v96）：source_skill_id 故意不建外键，原始 Skill 删除不影响历史。
CREATE TABLE comic_skill_snapshots (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES workspace_projects(id) ON DELETE CASCADE,
  source_skill_id TEXT NOT NULL,
  skill_name TEXT NOT NULL,
  declared_version TEXT NOT NULL DEFAULT '',
  content_hash TEXT NOT NULL,
  content_snapshot TEXT NOT NULL,
  files_manifest_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  UNIQUE(project_id, source_skill_id, content_hash)
);
CREATE INDEX idx_comic_skill_snapshots_project
  ON comic_skill_snapshots(project_id, created_at);

-- 外部生成记录（v96）：只登记真实发生的外部生成，不伪造成功、不调用模型。
CREATE TABLE comic_generation_runs (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES workspace_projects(id) ON DELETE CASCADE,
  episode_id TEXT NOT NULL REFERENCES comic_episodes(id) ON DELETE CASCADE,
  shot_id TEXT REFERENCES comic_shots(id) ON DELETE SET NULL,
  prompt_version_id TEXT NOT NULL
    REFERENCES comic_prompt_versions(id) ON DELETE RESTRICT,
  skill_snapshot_id TEXT REFERENCES comic_skill_snapshots(id) ON DELETE RESTRICT,
  rendered_prompt_snapshot TEXT NOT NULL,
  skill_content_hash_snapshot TEXT NOT NULL DEFAULT '',
  model_provider TEXT NOT NULL DEFAULT '',
  model_name TEXT NOT NULL DEFAULT '',
  model_version TEXT NOT NULL DEFAULT '',
  parameters_json TEXT NOT NULL DEFAULT '{}',
  seed TEXT NOT NULL DEFAULT '',
  input_media_ids_json TEXT NOT NULL DEFAULT '[]',
  external_job_id TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_comic_generation_runs_project
  ON comic_generation_runs(project_id, created_at);
CREATE INDEX idx_comic_generation_runs_episode
  ON comic_generation_runs(episode_id, created_at);
CREATE INDEX idx_comic_generation_runs_shot
  ON comic_generation_runs(shot_id, created_at);

ALTER TABLE comic_media_versions
  ADD COLUMN generation_run_id TEXT REFERENCES comic_generation_runs(id) ON DELETE SET NULL;
CREATE INDEX idx_comic_media_generation
  ON comic_media_versions(generation_run_id);

-- 兼容回填：剧集出场名单 ∪ 本集全部镜头角色（去重、只保留本项目真实角色）。
-- 只在 JSON 合法时重写；非法历史值保持原样（读侧本来就按空数组降级），
-- 避免迁移因单条脏数据整体失败。
UPDATE comic_episodes
SET character_ids_json = (
  SELECT json_group_array(DISTINCT cid)
  FROM (
    SELECT je.value AS cid
    FROM json_each(comic_episodes.character_ids_json) AS je
    UNION
    SELECT js.value AS cid
    FROM comic_shots AS sh, json_each(sh.character_ids_json) AS js
    WHERE sh.episode_id = comic_episodes.id
      AND json_valid(sh.character_ids_json) = 1
  )
  WHERE cid IS NOT NULL
    AND cid <> ''
    AND EXISTS (
      SELECT 1 FROM comic_characters c
      WHERE c.id = cid AND c.project_id = comic_episodes.project_id
    )
)
WHERE json_valid(character_ids_json) = 1
  AND EXISTS (
    SELECT 1 FROM comic_shots sh
    WHERE sh.episode_id = comic_episodes.id
      AND json_valid(sh.character_ids_json) = 1
  );
"#,
);

/// 漫剧第三阶段返工（v99）：Skill 快照身份 + 生成记录提示词快照。
///
/// 解决的问题：
/// 1. 旧 `UNIQUE(project_id, source_skill_id, content_hash)` 让「只改 SKILL.md 声明版本」
///    或「只改附属文件」的捕获直接复用旧快照，返回过期元数据；
///    新身份 = `snapshot_fingerprint`（来源 Skill + 正文 Hash + 声明版本 + 附属清单 Hash）。
/// 2. 生成记录缺少「实际使用提示词」的独立落库字段，历史记录的提示词 Hash 只能靠联表推断。
/// 3. 历史生成记录的提示词快照此前没有任何数据库级不可变约束。
///
/// 数据安全：
/// - 快照表重建不丢行：旧表整行暂存 TEMP → 新表按**原 id** 回填 → 自检行数与 id 集合；
/// - `comic_generation_runs.skill_snapshot_id` 的外键在事务内无法关闭，改用
///   `PRAGMA defer_foreign_keys` 把检查推迟到提交：新表回填后引用重新成立，
///   迁移失败则整体回滚，不会留下半套表；
/// - 历史快照的 `files_manifest_hash` 记为 `''`（当时没有算过，不猜测、不回填假值），
///   指纹按同一 `json_array` 口径回填，保证历史行身份稳定且互不冲突。
pub const MIGRATION_99: (i64, &'static str) = (
    99,
    r#"
PRAGMA defer_foreign_keys = ON;

-- 1) Skill 快照表重建（保留全部历史行与原 id）
DROP TABLE IF EXISTS temp._v99_comic_skill_snapshots;
CREATE TEMP TABLE _v99_comic_skill_snapshots AS SELECT * FROM comic_skill_snapshots;

DROP TABLE comic_skill_snapshots;
CREATE TABLE comic_skill_snapshots (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES workspace_projects(id) ON DELETE CASCADE,
  source_skill_id TEXT NOT NULL,
  skill_name TEXT NOT NULL,
  declared_version TEXT NOT NULL DEFAULT '',
  content_hash TEXT NOT NULL,
  content_snapshot TEXT NOT NULL,
  files_manifest_json TEXT NOT NULL DEFAULT '[]',
  files_manifest_hash TEXT NOT NULL DEFAULT '',
  snapshot_fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(project_id, source_skill_id, snapshot_fingerprint)
);
INSERT INTO comic_skill_snapshots
  (id, project_id, source_skill_id, skill_name, declared_version, content_hash,
   content_snapshot, files_manifest_json, files_manifest_hash, snapshot_fingerprint, created_at)
SELECT id, project_id, source_skill_id, skill_name, declared_version, content_hash,
       content_snapshot, files_manifest_json, '',
       json_array(source_skill_id, content_hash, declared_version, ''), created_at
FROM temp._v99_comic_skill_snapshots;
CREATE INDEX idx_comic_skill_snapshots_project
  ON comic_skill_snapshots(project_id, created_at);

-- 自检：行数一致且 id 集合无缺失；任一不满足让 CHECK 失败，整个迁移回滚。
DROP TABLE IF EXISTS temp._v99_guard;
CREATE TEMP TABLE _v99_guard (ok INTEGER NOT NULL CHECK (ok = 1));
INSERT INTO temp._v99_guard
SELECT CASE WHEN
  (SELECT COUNT(*) FROM comic_skill_snapshots)
    = (SELECT COUNT(*) FROM temp._v99_comic_skill_snapshots)
  AND NOT EXISTS (
    SELECT id FROM temp._v99_comic_skill_snapshots
    EXCEPT
    SELECT id FROM comic_skill_snapshots
  )
  THEN 1 ELSE 0 END;
DROP TABLE temp._v99_guard;
DROP TABLE temp._v99_comic_skill_snapshots;

-- 2) 生成记录：提示词内容 Hash 与实际提示词快照的不可变约束
ALTER TABLE comic_generation_runs
  ADD COLUMN prompt_content_hash_snapshot TEXT NOT NULL DEFAULT '';
ALTER TABLE comic_generation_runs
  ADD COLUMN context_snapshot_json TEXT NOT NULL DEFAULT '';
-- 历史行回填：版本不可变，联表取当时的内容 Hash 是事实值；取不到则保持空串。
UPDATE comic_generation_runs
SET prompt_content_hash_snapshot = COALESCE((
  SELECT v.content_hash FROM comic_prompt_versions v
  WHERE v.id = comic_generation_runs.prompt_version_id
), '')
WHERE prompt_content_hash_snapshot = '';

DROP TRIGGER IF EXISTS trg_comic_generation_prompt_snapshot_immutable;
CREATE TRIGGER trg_comic_generation_prompt_snapshot_immutable
BEFORE UPDATE OF rendered_prompt_snapshot ON comic_generation_runs
WHEN OLD.rendered_prompt_snapshot <> NEW.rendered_prompt_snapshot
BEGIN
  SELECT RAISE(ABORT, '生成记录的提示词快照不可修改');
END;

-- 恢复到立即外键检查：若重建后的引用不成立，此处即失败并回滚。
PRAGMA defer_foreign_keys = OFF;
"#,
);

// ── 常量与上限 ─────────────────────────────────────────────────────────
const MAX_TITLE_CHARS: usize = 240;
const MAX_LONG_TEXT_CHARS: usize = 4000;
const MAX_SCRIPT_BYTES: usize = 8 * 1024 * 1024;
const MAX_PATH_CHARS: usize = 4096;
const MAX_REF_COUNT: usize = 50;
const MAX_ASSET_REFS: usize = 20;
/// 列表默认限量（契约 §3.9）。
const MAX_LIST_ROWS: i64 = 200;

const EPISODE_STATUSES: &[&str] = &[
    "draft",
    "scripting",
    "storyboard",
    "producing",
    "reviewing",
    "done",
];
const SHOT_STATUSES: &[&str] = &["todo", "doing", "blocked", "done"];
const MEDIA_KINDS: &[&str] = &["image", "video", "other"];
const MEDIA_IMPORT_STATUSES: &[&str] = &["candidate", "rejected"];

// v96 上限：文本字段一律有长度 + 控制字符校验；提示词正文与 Skill 快照单独按字节限流。
const MAX_PROMPT_NAME_CHARS: usize = 120;
const MAX_PROMPT_BODY_CHARS: usize = 200_000;
const MAX_PROMPT_BODY_BYTES: usize = 512 * 1024;
const MAX_CHANGE_NOTE_CHARS: usize = 2_000;
const MAX_GENERATION_NOTE_CHARS: usize = 2_000;
const MAX_MODEL_FIELD_CHARS: usize = 120;
const MAX_EXTERNAL_JOB_CHARS: usize = 240;
const MAX_SEED_CHARS: usize = 120;
const MAX_JSON_BYTES: usize = 64 * 1024;
const MAX_SKILL_SNAPSHOT_BYTES: usize = 1024 * 1024;
const MAX_SKILL_MANIFEST_FILES: usize = 500;
const MAX_SKILL_MANIFEST_FILE_BYTES: u64 = 16 * 1024 * 1024;
/// 单次捕获的文件指纹总预算：超过后只记大小、不再读取内容，避免超大 Skill 目录拖死 UI。
const MAX_SKILL_MANIFEST_TOTAL_BYTES: u64 = 64 * 1024 * 1024;
const MAX_OVERRIDE_PROMPT_CHARS: usize = 20_000;
/// 参考图在提示词中的固定占位文本（v99）：外部生成工具无法读取本机绝对路径，
/// 直接拼路径既无用又会把用户机器目录泄漏给第三方模型，因此只给可执行的动作说明。
/// 本机界面仍可从结构化上下文的 `refImagePath` 查看真实路径。
const REFERENCE_IMAGE_BLOCK_LINE: &str = "参考图：已在 Task Dock 关联，请在外部生成工具手动上传";
/// 生成记录上下文摘要最多保留的角色/场景条数：超出时写 `truncated=true`，
/// 明确标注被裁剪，而不是悄悄丢数据。
const MAX_CONTEXT_SNAPSHOT_ITEMS: usize = 50;
const PROMPT_CATEGORIES: &[&str] = &[
    "character_reference",
    "scene_reference",
    "storyboard",
    "image_generation",
    "video_generation",
    "inpaint",
    "other",
];

/// 漫剧提示词允许的占位符集合（本轮固定，不引入模板语言）。
///
/// 只做文本替换：禁止 eval / 动态代码 / 函数调用 / 任意路径读取。
const COMIC_PROMPT_VARIABLES: &[&str] = &[
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
];

// ── 返回模型 ──────────────────────────────────────────────────────────

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ComicEpisode {
    pub id: String,
    pub project_id: String,
    pub episode_no: i64,
    pub title: String,
    pub synopsis: String,
    pub script: String,
    pub status: String,
    pub progress: i64,
    pub character_ids: Vec<String>,
    pub shot_count: i64,
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ComicShot {
    pub id: String,
    pub project_id: String,
    pub episode_id: String,
    pub shot_no: i64,
    pub description: String,
    pub character_ids: Vec<String>,
    pub scene_id: Option<String>,
    pub dialogue: String,
    pub shot_size: String,
    pub camera_move: String,
    pub duration_sec: f64,
    pub status: String,
    pub asset_refs: Vec<String>,
    pub note: String,
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ComicCharacter {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub role: String,
    pub description: String,
    pub ref_image_path: String,
    pub ref_image_exists: bool,
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ComicScene {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub description: String,
    pub ref_image_path: String,
    pub ref_image_exists: bool,
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ComicMediaVersion {
    pub id: String,
    pub project_id: String,
    pub shot_id: Option<String>,
    pub character_id: Option<String>,
    pub scene_id: Option<String>,
    pub file_path: String,
    /// 读时计算：引用路径当前是否存在；缺失不清理，由前端降级提示。
    pub file_exists: bool,
    pub media_kind: String,
    pub version_label: String,
    pub status: String,
    pub review_note: String,
    pub source: String,
    /// 可选的外部生成记录关联（v96）：删除素材版本不会删除生成历史。
    pub generation_run_id: Option<String>,
    /// 读时拼装：`提供商 · 模型 · 版本`，供列表直接展示；无关联时为 None。
    pub generation_label: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// 每集角色形象覆盖（v96）：只描述「这一集」，全局 `ComicCharacter` 仍是基础事实来源。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ComicEpisodeCharacterOverride {
    pub id: String,
    pub project_id: String,
    pub episode_id: String,
    pub character_id: String,
    pub role_in_episode: String,
    pub appearance_label: String,
    pub appearance_description: String,
    pub costume_description: String,
    pub hair_style_description: String,
    pub state_description: String,
    pub visual_prompt_override: String,
    pub ref_image_path: String,
    pub ref_image_exists: bool,
    /// 基础角色档案：与覆盖字段分开返回，前端合并时不得用空覆盖清空基础值。
    pub character: ComicCharacter,
    pub created_at: String,
    pub updated_at: String,
}

/// 提示词模板（含默认版本摘要，避免前端为每个模板再查一次版本列表）。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ComicPromptTemplate {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub category: String,
    pub description: String,
    pub version_count: i64,
    pub default_version_id: Option<String>,
    pub default_version_no: Option<i64>,
    pub default_content_hash: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ComicPromptVersion {
    pub id: String,
    pub template_id: String,
    pub version_no: i64,
    pub content: String,
    pub variables_json: String,
    pub content_hash: String,
    pub change_note: String,
    pub is_default: bool,
    pub created_at: String,
}

/// 提示词渲染上下文中的角色：明确标注是否使用了本集覆盖。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ComicPromptContextCharacter {
    pub id: String,
    pub name: String,
    pub role: String,
    pub base_description: String,
    pub appearance_label: String,
    pub appearance_description: String,
    pub costume_description: String,
    pub hair_style_description: String,
    pub state_description: String,
    /// 本集专属的视觉提示词补充（v99）：只在渲染本集时进入角色块，
    /// 绝不写回 `comic_characters.description`，也不影响其它剧集。
    pub visual_prompt_override: String,
    pub ref_image_path: String,
    pub using_override: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ComicPromptContextScene {
    pub id: String,
    pub name: String,
    pub description: String,
    pub ref_image_path: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ComicPromptContextShot {
    pub id: String,
    pub shot_no: i64,
    pub description: String,
}

/// 渲染上下文的可核验来源：变量 + 实际使用的角色/场景/镜头。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ComicPromptContext {
    pub project_id: String,
    pub episode_id: String,
    pub shot_id: Option<String>,
    pub variables: BTreeMap<String, String>,
    pub characters: Vec<ComicPromptContextCharacter>,
    pub scenes: Vec<ComicPromptContextScene>,
    pub shot: Option<ComicPromptContextShot>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ComicPromptPreview {
    pub prompt_version_id: String,
    pub template_id: String,
    pub template_name: String,
    pub version_no: i64,
    pub content_hash: String,
    pub required_variables: Vec<String>,
    pub rendered: String,
    pub context: ComicPromptContext,
}

/// Skill 不可变内容快照（v96，v99 增加完整快照指纹）。
///
/// `content_hash` 是**实际装配内容**（SKILL.md 正文）的 SHA-256，与能力中心登记的
/// 「原始文件 hash」区分；`files_manifest_hash` 是附属文件清单的 SHA-256；
/// `snapshot_fingerprint` 由「来源 Skill + 正文 Hash + 声明版本 + 附属清单 Hash」
/// 规范化组成，是快照身份的唯一判定依据（只改声明版本或附属文件也会产生新快照）。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ComicSkillSnapshot {
    pub id: String,
    pub project_id: String,
    pub source_skill_id: String,
    pub skill_name: String,
    pub declared_version: String,
    pub content_hash: String,
    pub content_snapshot: String,
    pub files_manifest_json: String,
    pub files_manifest_hash: String,
    pub snapshot_fingerprint: String,
    pub file_count: i64,
    pub created_at: String,
}

/// 外部生成记录（v96）：追溯一次真实外部生成用了哪个提示词版本 / Skill 快照。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ComicGenerationRun {
    pub id: String,
    pub project_id: String,
    pub episode_id: String,
    pub episode_title: String,
    pub shot_id: Option<String>,
    pub shot_no: Option<i64>,
    pub prompt_version_id: String,
    pub prompt_template_name: String,
    pub prompt_version_no: i64,
    /// 登记当时该提示词版本的内容 Hash（版本不可变，单独落库便于离线核对）。
    pub prompt_content_hash_snapshot: String,
    pub skill_snapshot_id: Option<String>,
    pub skill_name: Option<String>,
    pub skill_declared_version: Option<String>,
    /// 外部工具**实际收到**的提示词正文（用户确认后提交，不是登记时重新渲染的结果）。
    pub rendered_prompt_snapshot: String,
    /// 渲染上下文的 JSON 快照（角色/场景/镜头/变量），空串表示未保存。
    pub context_snapshot_json: String,
    pub skill_content_hash_snapshot: String,
    pub model_provider: String,
    pub model_name: String,
    pub model_version: String,
    pub parameters_json: String,
    pub seed: String,
    pub input_media_ids: Vec<String>,
    /// 该记录产出的素材版本（由 `comic_media_versions.generation_run_id` 反查）。
    pub output_media_ids: Vec<String>,
    pub external_job_id: String,
    pub note: String,
    pub created_at: String,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ComicGenerationRecordInput {
    pub project_id: String,
    pub episode_id: String,
    pub shot_id: Option<String>,
    pub prompt_version_id: String,
    /// 必填：外部 AI 实际使用的最终提示词。允许用户粘贴/微调后的版本，
    /// 后端**不得**用重新渲染的结果覆盖或截断它。
    pub rendered_prompt_snapshot: String,
    pub skill_snapshot_id: Option<String>,
    pub model_provider: String,
    pub model_name: String,
    pub model_version: String,
    pub parameters_json: Option<String>,
    pub seed: String,
    pub input_media_ids: Option<Vec<String>>,
    pub external_job_id: String,
    pub note: String,
}

// ── 命令响应包装 ───────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct ComicEpisodeList {
    pub episodes: Vec<ComicEpisode>,
}
#[derive(Serialize)]
pub struct ComicEpisodeGot {
    pub episode: ComicEpisode,
}
#[derive(Serialize)]
pub struct ComicEpisodeSaved {
    pub episode: ComicEpisode,
}
#[derive(Serialize)]
pub struct ComicShotList {
    pub shots: Vec<ComicShot>,
}
#[derive(Serialize)]
pub struct ComicShotGot {
    pub shot: ComicShot,
}
#[derive(Serialize)]
pub struct ComicShotSaved {
    pub shot: ComicShot,
}
#[derive(Serialize)]
pub struct ComicCharacterList {
    pub characters: Vec<ComicCharacter>,
}
#[derive(Serialize)]
pub struct ComicCharacterSaved {
    pub character: ComicCharacter,
}
#[derive(Serialize)]
pub struct ComicSceneList {
    pub scenes: Vec<ComicScene>,
}
#[derive(Serialize)]
pub struct ComicSceneSaved {
    pub scene: ComicScene,
}
#[derive(Serialize)]
pub struct ComicMediaList {
    pub versions: Vec<ComicMediaVersion>,
}
#[derive(Serialize)]
pub struct ComicMediaSaved {
    pub version: ComicMediaVersion,
}
#[derive(Serialize)]
pub struct ComicEpisodeCharacterOverrideList {
    pub overrides: Vec<ComicEpisodeCharacterOverride>,
}
#[derive(Serialize)]
pub struct ComicEpisodeCharacterOverrideSaved {
    pub record: ComicEpisodeCharacterOverride,
}
#[derive(Serialize)]
pub struct ComicPromptTemplateList {
    pub templates: Vec<ComicPromptTemplate>,
}
#[derive(Serialize)]
pub struct ComicPromptTemplateSaved {
    pub template: ComicPromptTemplate,
}
#[derive(Serialize)]
pub struct ComicPromptVersionList {
    pub versions: Vec<ComicPromptVersion>,
}
#[derive(Serialize)]
pub struct ComicPromptVersionSaved {
    pub version: ComicPromptVersion,
}
#[derive(Serialize)]
pub struct ComicPromptPreviewGot {
    pub preview: ComicPromptPreview,
}
#[derive(Serialize)]
pub struct ComicPromptContextGot {
    pub context: ComicPromptContext,
}
#[derive(Serialize)]
pub struct ComicSkillSnapshotList {
    pub snapshots: Vec<ComicSkillSnapshot>,
}
#[derive(Serialize)]
pub struct ComicSkillSnapshotSaved {
    pub snapshot: ComicSkillSnapshot,
}
#[derive(Serialize)]
pub struct ComicGenerationRunList {
    pub runs: Vec<ComicGenerationRun>,
}
#[derive(Serialize)]
pub struct ComicGenerationRunSaved {
    pub run: ComicGenerationRun,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComicOk {
    pub ok: bool,
}

/// 漫剧项目概览统计（项目中枢「专业工作进展」摘要）。
///
/// 口径（全部来自整表聚合，不加载剧集 / 分镜 / 素材行）：
/// - `episode_count` / `completed_episode_count`：剧集总数与 `status = 'done'`；
/// - `shot_count` 与四个状态计数：镜头真实状态 `todo` / `doing` / `blocked` / `done`；
/// - `character_count` / `scene_count` / `media_count` / `adopted_media_count`；
/// - `updated_at`：五张领域表最近一次 `updated_at`；空项目为 `None`
///   （不拿「查询时间」冒充数据更新时间）。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ComicOverviewStats {
    pub project_id: String,
    pub episode_count: i64,
    pub completed_episode_count: i64,
    pub shot_count: i64,
    pub completed_shot_count: i64,
    pub pending_shot_count: i64,
    pub doing_shot_count: i64,
    pub blocked_shot_count: i64,
    pub character_count: i64,
    pub scene_count: i64,
    pub media_count: i64,
    pub adopted_media_count: i64,
    pub updated_at: Option<String>,
}

// ── 校验与门禁 ─────────────────────────────────────────────────────────

fn validate_enum(value: &str, field: &str, allowed: &[&str]) -> AppResult<String> {
    let value = value.trim();
    if allowed.contains(&value) {
        Ok(value.to_string())
    } else {
        Err(AppError::Validation(format!(
            "{} 只允许 {} 之一，收到 {:?}",
            field,
            allowed.join(" | "),
            value
        )))
    }
}

fn validate_text(
    value: &str,
    field: &str,
    max_chars: usize,
    allow_empty: bool,
) -> AppResult<String> {
    let value = value.trim();
    if value.is_empty() && !allow_empty {
        return Err(AppError::Validation(format!("{field}不能为空")));
    }
    if value.chars().count() > max_chars {
        return Err(AppError::Validation(format!(
            "{field}超过 {max_chars} 字符"
        )));
    }
    if value.chars().any(|c| c.is_control()) {
        return Err(AppError::Validation(format!("{field}含非法控制字符")));
    }
    Ok(value.to_string())
}

/// 多行文本（形象描述 / 服装 / 发型 / 状态 / 修改说明）：允许换行与制表符，
/// 其余控制字符一律拒绝；保留内部空行，只去首尾空白。
fn validate_multiline_text(
    value: &str,
    field: &str,
    max_chars: usize,
    allow_empty: bool,
) -> AppResult<String> {
    let value = value.trim();
    if value.is_empty() && !allow_empty {
        return Err(AppError::Validation(format!("{field}不能为空")));
    }
    if value.chars().count() > max_chars {
        return Err(AppError::Validation(format!(
            "{field}超过 {max_chars} 字符"
        )));
    }
    if value
        .chars()
        .any(|c| c.is_control() && c != '\n' && c != '\t')
    {
        return Err(AppError::Validation(format!("{field}含非法控制字符")));
    }
    Ok(value.to_string())
}

/// 提示词正文：允许换行/制表符，保留作者排版；按字符数与字节数双重限流。
/// 不做 HTML 转义、不做 Markdown 处理——这里只保存作者原文。
fn validate_prompt_body(raw: &str) -> AppResult<String> {
    if raw.trim().is_empty() {
        return Err(AppError::Validation("提示词正文不能为空".into()));
    }
    let normalized = raw.replace("\r\n", "\n");
    if normalized.len() > MAX_PROMPT_BODY_BYTES {
        return Err(AppError::Validation(format!(
            "提示词正文超过 {} KiB 上限",
            MAX_PROMPT_BODY_BYTES / 1024
        )));
    }
    if normalized.chars().count() > MAX_PROMPT_BODY_CHARS {
        return Err(AppError::Validation(format!(
            "提示词正文超过 {MAX_PROMPT_BODY_CHARS} 字符"
        )));
    }
    if normalized
        .chars()
        .any(|c| (c.is_control() && c != '\n' && c != '\t') || c == '\r')
    {
        return Err(AppError::Validation("提示词正文含非法控制字符".into()));
    }
    Ok(normalized)
}

/// 本轮允许的占位符集合（固定 12 项）。
fn comic_prompt_variable_set() -> BTreeSet<String> {
    COMIC_PROMPT_VARIABLES
        .iter()
        .map(|value| value.to_string())
        .collect()
}

/// 解析版本的「必填变量声明」。只接受 JSON 字符串数组，成员必须是本轮允许的占位符；
/// 去重后按声明顺序返回，落库时序列化为规范 JSON。
fn parse_prompt_variables(raw: &str) -> AppResult<Vec<String>> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Ok(Vec::new());
    }
    let value: serde_json::Value = serde_json::from_str(raw)
        .map_err(|_| AppError::Validation("变量声明必须是合法的 JSON 数组".into()))?;
    let Some(items) = value.as_array() else {
        return Err(AppError::Validation("变量声明必须是合法的 JSON 数组".into()));
    };
    let allowed = comic_prompt_variable_set();
    let mut out: Vec<String> = Vec::new();
    for item in items {
        let Some(name) = item.as_str() else {
            return Err(AppError::Validation("变量声明只能包含字符串".into()));
        };
        let name = name.trim();
        if name.is_empty() {
            return Err(AppError::Validation("变量名不能为空".into()));
        }
        if !allowed.contains(name) {
            return Err(AppError::Validation(format!(
                "未知变量声明「{name}」：请使用变量说明中的占位符"
            )));
        }
        if !out.iter().any(|existing| existing == name) {
            out.push(name.to_string());
        }
    }
    Ok(out)
}

/// 参数 JSON：必须是合法 JSON（对象/数组/标量均可），限 64 KiB。
/// 返回规范化的紧凑 JSON，避免同一语义因空白不同被当成不同输入。
fn validate_parameters_json(raw: Option<&str>) -> AppResult<String> {
    let raw = raw.unwrap_or("{}").trim();
    let raw = if raw.is_empty() { "{}" } else { raw };
    if raw.len() > MAX_JSON_BYTES {
        return Err(AppError::Validation("生成参数 JSON 超过 64 KiB".into()));
    }
    let value: serde_json::Value = serde_json::from_str(raw)
        .map_err(|_| AppError::Validation("生成参数必须是合法 JSON".into()))?;
    Ok(serde_json::to_string(&value)?)
}

/// 角色显示名：用于错误提示（角色已被删除时回退 ID，绝不静默）。
fn character_name(conn: &Connection, character_id: &str) -> AppResult<String> {
    let name: Option<String> = conn
        .query_row(
            "SELECT name FROM comic_characters WHERE id = ?1",
            params![character_id],
            |row| row.get(0),
        )
        .optional()?;
    Ok(name.unwrap_or_else(|| character_id.to_string()))
}

/// 统计某剧集中引用指定角色的镜头数（用于「移出本集」前的守卫）。
fn count_shots_referencing(
    conn: &Connection,
    episode_id: &str,
    character_id: &str,
) -> AppResult<i64> {
    let mut stmt =
        conn.prepare("SELECT character_ids_json FROM comic_shots WHERE episode_id = ?1")?;
    let rows = stmt.query_map(params![episode_id], |row| row.get::<_, String>(0))?;
    let mut count = 0i64;
    for row in rows {
        let raw = row?;
        if parse_id_array(&raw).iter().any(|id| id == character_id) {
            count += 1;
        }
    }
    Ok(count)
}

/// 分镜角色的强校验（P0）：剧集属于本项目、角色属于本项目，
/// 且每个角色都必须已经在当前剧集的出场名单 `character_ids_json` 里。
///
/// 前端过滤只是体验层；这里才是数据完整性的最后一道门。
fn ensure_episode_characters_belong(
    conn: &Connection,
    project_id: &str,
    episode_id: &str,
    character_ids: &[String],
) -> AppResult<()> {
    ensure_episode_belongs(conn, project_id, episode_id)?;
    ensure_characters_belong(conn, project_id, character_ids)?;
    if character_ids.is_empty() {
        return Ok(());
    }
    let raw: String = conn.query_row(
        "SELECT character_ids_json FROM comic_episodes WHERE id = ?1",
        params![episode_id],
        |row| row.get(0),
    )?;
    let roster = parse_id_array(&raw);
    for character_id in character_ids {
        if roster.iter().any(|id| id == character_id) {
            continue;
        }
        let name = character_name(conn, character_id)?;
        return Err(AppError::Validation(format!(
            "角色「{name}」不在本集出场名单，不能用于本集分镜；请先在「剧集」模块把该角色加入本集"
        )));
    }
    Ok(())
}

/// 剧本正文：只做字节大小与 NUL 校验，不去首尾空白（缩进/空行属于作者内容）。
fn validate_script_body(raw: &str) -> AppResult<String> {    if raw.len() > MAX_SCRIPT_BYTES {
        return Err(AppError::Validation(format!(
            "剧本内容超过 {} MiB 上限",
            MAX_SCRIPT_BYTES / (1024 * 1024)
        )));
    }
    if raw.contains('\0') {
        return Err(AppError::Validation("剧本内容含非法控制字符".into()));
    }
    Ok(raw.to_string())
}

fn validate_ref_path(raw: &str, field: &str) -> AppResult<String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Ok(String::new());
    }
    if raw.len() > MAX_PATH_CHARS {
        return Err(AppError::Validation(format!("{field}路径过长")));
    }
    if raw.chars().any(|c| c.is_control()) {
        return Err(AppError::Validation(format!("{field}路径含非法控制字符")));
    }
    if !Path::new(raw).is_absolute() {
        return Err(AppError::Validation(format!("{field}必须是绝对路径")));
    }
    Ok(raw.to_string())
}

fn validate_id_list(
    raw: Option<Vec<String>>,
    field: &str,
    max: usize,
) -> AppResult<Vec<String>> {
    let Some(raw) = raw else {
        return Ok(Vec::new());
    };
    let mut out = Vec::with_capacity(raw.len());
    for item in raw {
        let item = item.trim().to_string();
        if item.is_empty() {
            continue;
        }
        if item.chars().count() > 64 || item.chars().any(|c| c.is_control()) {
            return Err(AppError::Validation(format!("{field}格式非法")));
        }
        if !out.iter().any(|x| x == &item) {
            out.push(item);
        }
    }
    if out.len() > max {
        return Err(AppError::Validation(format!("{field}最多关联 {max} 项")));
    }
    Ok(out)
}

/// 历史素材引用（`comic_shots.asset_refs_json`）兼容校验。
///
/// 该列在历史数据里实际保存**文件绝对路径**（见 `dev-instance` 库 32/32 条命中素材版本
/// `file_path`），不是素材版本 ID；旧校验按 64 字符截断会让这些镜头无法保存。
/// 本轮它只作为只读兼容列：新前端不提交、后端不清空，仅当旧客户端显式提交时才按
/// 「路径或 ID」的宽口径校验后原样保留。
fn validate_legacy_asset_refs(raw: Option<Vec<String>>) -> AppResult<Option<Vec<String>>> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    let mut out = Vec::with_capacity(raw.len());
    for item in raw {
        let item = item.trim().to_string();
        if item.is_empty() {
            continue;
        }
        if item.chars().count() > MAX_PATH_CHARS || item.chars().any(|c| c.is_control()) {
            return Err(AppError::Validation("素材引用格式非法".into()));
        }
        if !out.iter().any(|x| x == &item) {
            out.push(item);
        }
    }
    if out.len() > MAX_ASSET_REFS {
        return Err(AppError::Validation(format!(
            "素材引用最多关联 {MAX_ASSET_REFS} 项"
        )));
    }
    Ok(Some(out))
}

fn parse_id_array(raw: &str) -> Vec<String> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) else {
        return Vec::new();
    };
    let Some(arr) = value.as_array() else {
        return Vec::new();
    };
    arr.iter()
        .filter_map(|v| v.as_str().map(|s| s.to_string()))
        .filter(|s| !s.is_empty())
        .collect()
}

fn serialize_id_array(items: &[String]) -> AppResult<String> {
    serde_json::to_string(items).map_err(AppError::from)
}

fn validate_sort_order(value: i64) -> AppResult<i64> {
    if !(-1_000_000..=1_000_000).contains(&value) {
        return Err(AppError::Validation("排序值超出范围".into()));
    }
    Ok(value)
}

fn file_exists(path: &str) -> bool {
    !path.is_empty() && Path::new(path).exists()
}

/// 漫剧专用门禁：只有 `kind = ai_comic` 的项目可读写；
/// `require_active` 为 true 时（所有写入）还要求 `status = active`；读取允许归档。
fn ensure_comic_project(
    conn: &Connection,
    project_id: &str,
    require_active: bool,
) -> AppResult<()> {
    let (kind, status): (String, String) = conn
        .query_row(
            "SELECT kind, status FROM workspace_projects WHERE id = ?1",
            params![project_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound(format!("工作空间项目不存在: {project_id}")))?;
    if kind != "ai_comic" {
        return Err(AppError::Validation(
            "该操作仅对 AI 漫剧项目开放".to_string(),
        ));
    }
    if require_active && status != "active" {
        return Err(AppError::Validation(
            "项目已归档，剧集/分镜/角色/素材只读；恢复为进行中后才能修改".to_string(),
        ));
    }
    Ok(())
}

pub(crate) fn owner_project_id(conn: &Connection, table: &str, id: &str) -> AppResult<String> {
    let sql = format!("SELECT project_id FROM {table} WHERE id = ?1");
    conn.query_row(&sql, params![id], |row| row.get(0))
        .optional()?
        .ok_or_else(|| AppError::NotFound("记录不存在或已被删除".into()))
}

fn ensure_episode_belongs(
    conn: &Connection,
    project_id: &str,
    episode_id: &str,
) -> AppResult<()> {
    let owner: Option<String> = conn
        .query_row(
            "SELECT project_id FROM comic_episodes WHERE id = ?1",
            params![episode_id],
            |r| r.get(0),
        )
        .optional()?;
    match owner {
        Some(owner) if owner == project_id => Ok(()),
        Some(_) => Err(AppError::Validation("剧集不属于当前项目".into())),
        None => Err(AppError::Validation("剧集不存在".into())),
    }
}

fn ensure_scene_belongs(
    conn: &Connection,
    project_id: &str,
    scene_id: &str,
) -> AppResult<()> {
    let owner: Option<String> = conn
        .query_row(
            "SELECT project_id FROM comic_scenes WHERE id = ?1",
            params![scene_id],
            |r| r.get(0),
        )
        .optional()?;
    match owner {
        Some(owner) if owner == project_id => Ok(()),
        Some(_) => Err(AppError::Validation("场景不属于当前项目".into())),
        None => Err(AppError::Validation("场景不存在".into())),
    }
}

fn ensure_characters_belong(
    conn: &Connection,
    project_id: &str,
    character_ids: &[String],
) -> AppResult<()> {
    for cid in character_ids {
        let owner: Option<String> = conn
            .query_row(
                "SELECT project_id FROM comic_characters WHERE id = ?1",
                params![cid],
                |r| r.get(0),
            )
            .optional()?;
        match owner {
            Some(owner) if owner == project_id => continue,
            Some(_) => return Err(AppError::Validation("关联角色不属于当前项目".into())),
            None => return Err(AppError::Validation("关联角色不存在".into())),
        }
    }
    Ok(())
}

fn next_sort(conn: &Connection, table: &str, project_id: &str) -> AppResult<i64> {
    let sql = format!(
        "SELECT COALESCE(MAX(sort_order), -1) FROM {table} WHERE project_id = ?1"
    );
    let max: i64 = conn.query_row(&sql, params![project_id], |r| r.get(0))?;
    Ok(max.saturating_add(1))
}

fn next_episode_no(conn: &Connection, project_id: &str) -> AppResult<i64> {
    let max: i64 = conn.query_row(
        "SELECT COALESCE(MAX(episode_no), 0) FROM comic_episodes WHERE project_id = ?1",
        params![project_id],
        |r| r.get(0),
    )?;
    Ok(max.saturating_add(1))
}

fn next_shot_no(conn: &Connection, episode_id: &str) -> AppResult<i64> {
    let max: i64 = conn.query_row(
        "SELECT COALESCE(MAX(shot_no), 0) FROM comic_shots WHERE episode_id = ?1",
        params![episode_id],
        |r| r.get(0),
    )?;
    Ok(max.saturating_add(1))
}

// ── 剧集 ──────────────────────────────────────────────────────────────

fn row_to_episode(conn: &Connection, row: &rusqlite::Row<'_>) -> rusqlite::Result<ComicEpisode> {
    let id: String = row.get("id")?;
    let character_ids_json: String = row.get("character_ids_json")?;
    let shot_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM comic_shots WHERE episode_id = ?1",
            params![id],
            |r| r.get(0),
        )
        .unwrap_or(0);
    Ok(ComicEpisode {
        id,
        project_id: row.get("project_id")?,
        episode_no: row.get("episode_no")?,
        title: row.get("title")?,
        synopsis: row.get("synopsis")?,
        script: row.get("script")?,
        status: row.get("status")?,
        progress: row.get("progress")?,
        character_ids: parse_id_array(&character_ids_json),
        shot_count,
        sort_order: row.get("sort_order")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn read_episode(conn: &Connection, id: &str) -> AppResult<ComicEpisode> {
    conn.query_row(
        "SELECT id, project_id, episode_no, title, synopsis, script, status, progress,
                character_ids_json, sort_order, created_at, updated_at
         FROM comic_episodes WHERE id = ?1",
        params![id],
        |row| row_to_episode(conn, row),
    )
    .optional()?
    .ok_or_else(|| AppError::NotFound("剧集不存在或已被删除".into()))
}

pub fn comic_episode_list_impl(db: &Db, project_id: &str) -> AppResult<Vec<ComicEpisode>> {
    db.with_read(|conn| {
        let (rows, _total) = comic_episode_list_page_in_conn(
            conn,
            project_id,
            MAX_LIST_ROWS as u32,
            0,
        )?;
        Ok(rows)
    })
}

/// 剧集分页读取（Agent 领域入口共用；调用方持有读连接）。
/// 返回 `(当前页, 真实总数)`；行模型仍含 `script`，Agent DTO 负责裁掉正文。
pub(crate) fn comic_episode_list_page_in_conn(
    conn: &Connection,
    project_id: &str,
    limit: u32,
    offset: u32,
) -> AppResult<(Vec<ComicEpisode>, u32)> {
    ensure_comic_project(conn, project_id, false)?;
    let total: i64 = conn.query_row(
        "SELECT COUNT(*) FROM comic_episodes WHERE project_id = ?1",
        params![project_id],
        |r| r.get(0),
    )?;
    let mut stmt = conn.prepare(
        "SELECT id, project_id, episode_no, title, synopsis, script, status, progress,
                character_ids_json, sort_order, created_at, updated_at
         FROM comic_episodes WHERE project_id = ?1
         ORDER BY sort_order, created_at, id
         LIMIT ?2 OFFSET ?3",
    )?;
    let rows = stmt.query_map(
        params![project_id, limit as i64, offset as i64],
        |row| row_to_episode(conn, row),
    )?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(AppError::from)?);
    }
    Ok((out, total.max(0) as u32))
}

pub fn comic_episode_get_impl(db: &Db, id: &str) -> AppResult<ComicEpisode> {
    db.with_read(|conn| {
        let project_id = owner_project_id(conn, "comic_episodes", id)?;
        ensure_comic_project(conn, &project_id, false)?;
        read_episode(conn, id)
    })
}

#[allow(clippy::too_many_arguments)]
pub fn comic_episode_save_impl(
    db: &Db,
    id: Option<String>,
    project_id: String,
    episode_no: Option<i64>,
    title: String,
    synopsis: String,
    script: String,
    status: String,
    progress: i64,
    character_ids: Option<Vec<String>>,
    sort_order: Option<i64>,
) -> AppResult<ComicEpisode> {
    let project_id = project_id.trim().to_string();
    if project_id.is_empty() {
        return Err(AppError::Validation("项目 ID 不能为空".into()));
    }
    let title = validate_text(&title, "剧集标题", MAX_TITLE_CHARS, false)?;
    let synopsis = validate_text(&synopsis, "剧情简介", MAX_LONG_TEXT_CHARS, true)?;
    let script = validate_script_body(&script)?;
    let status = validate_enum(&status, "剧集状态", EPISODE_STATUSES)?;
    if !(0..=100).contains(&progress) {
        return Err(AppError::Validation("制作进度必须在 0–100 之间".into()));
    }
    let episode_no = episode_no.unwrap_or(0).max(0);
    let character_ids = validate_id_list(character_ids, "出场角色", MAX_REF_COUNT)?;
    let character_ids_json = serialize_id_array(&character_ids)?;
    let id = id
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let saved_id = db.with_conn(|conn| {
        ensure_comic_project(conn, &project_id, true)?;
        ensure_characters_belong(conn, &project_id, &character_ids)?;
        let now = now_iso();
        match id {
            None => {
                let order = match sort_order {
                    Some(value) => validate_sort_order(value)?,
                    None => next_sort(conn, "comic_episodes", &project_id)?,
                };
                let no = if episode_no == 0 {
                    next_episode_no(conn, &project_id)?
                } else {
                    episode_no
                };
                let id = uuid::Uuid::new_v4().to_string();
                conn.execute(
                    "INSERT INTO comic_episodes
                     (id, project_id, episode_no, title, synopsis, script, status, progress,
                      character_ids_json, sort_order, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)",
                    params![
                        id,
                        project_id,
                        no,
                        title,
                        synopsis,
                        script,
                        status,
                        progress,
                        character_ids_json,
                        order,
                        now
                    ],
                )?;
                Ok::<String, AppError>(id)
            }
            Some(id) => {
                let existing: Option<(String, i64, String)> = conn
                    .query_row(
                        "SELECT project_id, sort_order, character_ids_json
                         FROM comic_episodes WHERE id = ?1",
                        params![id],
                        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                    )
                    .optional()?;
                let Some((owner, current_order, current_characters)) = existing else {
                    return Err(AppError::NotFound("剧集不存在或已被删除".into()));
                };
                if owner != project_id {
                    return Err(AppError::Validation("剧集不属于当前项目".into()));
                }
                // P0：仍有镜头引用时不允许把角色移出本集名单（否则镜头会出现不可解释的
                // 「角色不在本集」状态）。形象覆盖保留不删：重新加入本集时用户的自定义还在。
                let previous_ids = parse_id_array(&current_characters);
                for removed in previous_ids
                    .iter()
                    .filter(|cid| !character_ids.contains(cid))
                {
                    let referencing = count_shots_referencing(conn, &id, removed)?;
                    if referencing > 0 {
                        let name = character_name(conn, removed)?;
                        return Err(AppError::Validation(format!(
                            "角色「{name}」仍被本集 {referencing} 个镜头引用，不能移出本集；\
                             请先在「分镜」模块修改这些镜头的出场角色"
                        )));
                    }
                }
                let order = match sort_order {
                    Some(value) => validate_sort_order(value)?,
                    None => current_order,
                };
                let no = if episode_no == 0 {
                    conn.query_row(
                        "SELECT episode_no FROM comic_episodes WHERE id = ?1",
                        params![id],
                        |r| r.get(0),
                    )?
                } else {
                    episode_no
                };
                conn.execute(
                    "UPDATE comic_episodes
                     SET episode_no = ?2, title = ?3, synopsis = ?4, script = ?5,
                         status = ?6, progress = ?7, character_ids_json = ?8,
                         sort_order = ?9, updated_at = ?10
                     WHERE id = ?1 AND project_id = ?11",
                    params![
                        id,
                        no,
                        title,
                        synopsis,
                        script,
                        status,
                        progress,
                        character_ids_json,
                        order,
                        now,
                        project_id
                    ],
                )?;
                Ok::<String, AppError>(id)
            }
        }
    })?;
    db.with_read(|conn| read_episode(conn, &saved_id))
}

pub fn comic_episode_delete_impl(db: &Db, id: &str) -> AppResult<()> {
    db.with_conn(|conn| {
        let project_id = owner_project_id(conn, "comic_episodes", id)?;
        ensure_comic_project(conn, &project_id, true)?;
        // 镜头与镜头下素材版本由外键级联删除；用户素材原文件不动。
        conn.execute("DELETE FROM comic_episodes WHERE id = ?1", params![id])?;
        Ok(())
    })
}

/// 剧集排序：按传入 ID 顺序重写 sort_order；ID 必须全部属于本项目。
pub fn comic_episode_reorder_impl(
    db: &Db,
    project_id: &str,
    episode_ids: Vec<String>,
) -> AppResult<Vec<ComicEpisode>> {
    let project_id = project_id.trim().to_string();
    if project_id.is_empty() {
        return Err(AppError::Validation("项目 ID 不能为空".into()));
    }
    db.with_transaction(|conn| {
        ensure_comic_project(conn, &project_id, true)?;
        for (index, episode_id) in episode_ids.iter().enumerate() {
            let owner: Option<String> = conn
                .query_row(
                    "SELECT project_id FROM comic_episodes WHERE id = ?1",
                    params![episode_id],
                    |r| r.get(0),
                )
                .optional()?;
            match owner {
                Some(owner) if owner == project_id => {}
                Some(_) => return Err(AppError::Validation("剧集不属于当前项目".into())),
                None => return Err(AppError::NotFound("剧集不存在或已被删除".into())),
            }
            conn.execute(
                "UPDATE comic_episodes SET sort_order = ?2, updated_at = ?3 WHERE id = ?1",
                params![episode_id, index as i64, now_iso()],
            )?;
        }
        Ok(())
    })?;
    comic_episode_list_impl(db, &project_id)
}

// ── 分镜 ──────────────────────────────────────────────────────────────

fn row_to_shot(row: &rusqlite::Row<'_>) -> rusqlite::Result<ComicShot> {
    let character_ids_json: String = row.get("character_ids_json")?;
    let asset_refs_json: String = row.get("asset_refs_json")?;
    Ok(ComicShot {
        id: row.get("id")?,
        project_id: row.get("project_id")?,
        episode_id: row.get("episode_id")?,
        shot_no: row.get("shot_no")?,
        description: row.get("description")?,
        character_ids: parse_id_array(&character_ids_json),
        scene_id: row.get("scene_id")?,
        dialogue: row.get("dialogue")?,
        shot_size: row.get("shot_size")?,
        camera_move: row.get("camera_move")?,
        duration_sec: row.get("duration_sec")?,
        status: row.get("status")?,
        asset_refs: parse_id_array(&asset_refs_json),
        note: row.get("note")?,
        sort_order: row.get("sort_order")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn read_shot(conn: &Connection, id: &str) -> AppResult<ComicShot> {
    conn.query_row(
        "SELECT id, project_id, episode_id, shot_no, description, character_ids_json,
                scene_id, dialogue, shot_size, camera_move, duration_sec, status,
                asset_refs_json, note, sort_order, created_at, updated_at
         FROM comic_shots WHERE id = ?1",
        params![id],
        row_to_shot,
    )
    .optional()?
    .ok_or_else(|| AppError::NotFound("镜头不存在或已被删除".into()))
}

pub fn comic_shot_list_impl(
    db: &Db,
    project_id: &str,
    episode_id: Option<String>,
) -> AppResult<Vec<ComicShot>> {
    db.with_read(|conn| {
        let (rows, _total) = comic_shot_list_page_in_conn(
            conn,
            project_id,
            episode_id.as_deref(),
            MAX_LIST_ROWS as u32,
            0,
        )?;
        Ok(rows)
    })
}

/// 分镜分页读取（Agent 领域入口共用；调用方持有读连接）。
pub(crate) fn comic_shot_list_page_in_conn(
    conn: &Connection,
    project_id: &str,
    episode_id: Option<&str>,
    limit: u32,
    offset: u32,
) -> AppResult<(Vec<ComicShot>, u32)> {
    ensure_comic_project(conn, project_id, false)?;
    if let Some(episode_id) = episode_id.filter(|s| !s.is_empty()) {
        ensure_episode_belongs(conn, project_id, episode_id)?;
    }
    let total: i64 = conn.query_row(
        "SELECT COUNT(*) FROM comic_shots
         WHERE project_id = ?1 AND (?2 IS NULL OR episode_id = ?2)",
        params![project_id, episode_id],
        |r| r.get(0),
    )?;
    let mut stmt = conn.prepare(
        "SELECT id, project_id, episode_id, shot_no, description, character_ids_json,
                scene_id, dialogue, shot_size, camera_move, duration_sec, status,
                asset_refs_json, note, sort_order, created_at, updated_at
         FROM comic_shots
         WHERE project_id = ?1 AND (?2 IS NULL OR episode_id = ?2)
         ORDER BY episode_id, sort_order, created_at, id
         LIMIT ?3 OFFSET ?4",
    )?;
    let rows = stmt.query_map(
        params![project_id, episode_id, limit as i64, offset as i64],
        row_to_shot,
    )?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(AppError::from)?);
    }
    Ok((out, total.max(0) as u32))
}

pub fn comic_shot_get_impl(db: &Db, id: &str) -> AppResult<ComicShot> {
    db.with_read(|conn| {
        let project_id = owner_project_id(conn, "comic_shots", id)?;
        ensure_comic_project(conn, &project_id, false)?;
        read_shot(conn, id)
    })
}

#[allow(clippy::too_many_arguments)]
pub fn comic_shot_save_impl(
    db: &Db,
    id: Option<String>,
    project_id: String,
    episode_id: String,
    shot_no: Option<i64>,
    description: String,
    character_ids: Option<Vec<String>>,
    scene_id: Option<String>,
    dialogue: String,
    shot_size: String,
    camera_move: String,
    duration_sec: Option<f64>,
    status: String,
    asset_refs: Option<Vec<String>>,
    note: String,
    sort_order: Option<i64>,
) -> AppResult<ComicShot> {
    let project_id = project_id.trim().to_string();
    if project_id.is_empty() {
        return Err(AppError::Validation("项目 ID 不能为空".into()));
    }
    let episode_id = episode_id.trim().to_string();
    if episode_id.is_empty() {
        return Err(AppError::Validation("镜头必须归属剧集".into()));
    }
    let description = validate_text(&description, "镜头描述", MAX_LONG_TEXT_CHARS, true)?;
    let dialogue = validate_text(&dialogue, "台词", MAX_LONG_TEXT_CHARS, true)?;
    let shot_size = validate_text(&shot_size, "景别", MAX_TITLE_CHARS, true)?;
    let camera_move = validate_text(&camera_move, "运镜说明", MAX_LONG_TEXT_CHARS, true)?;
    let note = validate_text(&note, "备注", MAX_LONG_TEXT_CHARS, true)?;
    let status = validate_enum(&status, "镜头状态", SHOT_STATUSES)?;
    let duration_sec = duration_sec.unwrap_or(0.0).max(0.0);
    if !duration_sec.is_finite() {
        return Err(AppError::Validation("预计时长非法".into()));
    }
    let character_ids = validate_id_list(character_ids, "出场角色", MAX_REF_COUNT)?;
    // `asset_refs_json` 是历史遗留列（实际存的是文件绝对路径，不是素材版本 ID）。
    // 正式关联已统一为 `comic_media_versions.shot_id`：新前端不再提交该字段，
    // 因此 `None` 必须「保持原值」，不能写成空数组清空历史引用。
    let asset_refs = validate_legacy_asset_refs(asset_refs)?;
    let scene_id = match scene_id {
        None => None,
        Some(raw) => {
            let raw = raw.trim().to_string();
            if raw.is_empty() {
                None
            } else {
                Some(raw)
            }
        }
    };
    let character_ids_json = serialize_id_array(&character_ids)?;
    let id = id
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let saved_id = db.with_conn(|conn| {
        ensure_comic_project(conn, &project_id, true)?;
        // P0：分镜只能引用「本集出场名单」内的角色；跨集/未登记角色一律拒绝。
        // 历史数据已在 v96 迁移中按「剧集名单 ∪ 本集镜头角色」回填，不会被新校验卡住。
        ensure_episode_characters_belong(conn, &project_id, &episode_id, &character_ids)?;
        if let Some(scene_id) = scene_id.as_deref() {
            ensure_scene_belongs(conn, &project_id, scene_id)?;
        }
        let now = now_iso();
        match id {
            None => {
                let order = match sort_order {
                    Some(value) => validate_sort_order(value)?,
                    None => next_sort(conn, "comic_shots", &project_id)?,
                };
                let no = match shot_no {
                    Some(value) if value > 0 => value,
                    _ => next_shot_no(conn, &episode_id)?,
                };
                // 新建镜头没有历史引用：未提交时按空数组落库。
                let asset_refs_json = match &asset_refs {
                    Some(refs) => serialize_id_array(refs)?,
                    None => "[]".to_string(),
                };
                let id = uuid::Uuid::new_v4().to_string();
                conn.execute(
                    "INSERT INTO comic_shots
                     (id, project_id, episode_id, shot_no, description, character_ids_json,
                      scene_id, dialogue, shot_size, camera_move, duration_sec, status,
                      asset_refs_json, note, sort_order, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
                              ?15, ?16, ?16)",
                    params![
                        id,
                        project_id,
                        episode_id,
                        no,
                        description,
                        character_ids_json,
                        scene_id,
                        dialogue,
                        shot_size,
                        camera_move,
                        duration_sec,
                        status,
                        asset_refs_json,
                        note,
                        order,
                        now
                    ],
                )?;
                Ok::<String, AppError>(id)
            }
            Some(id) => {
                let existing: Option<(String, i64, String)> = conn
                    .query_row(
                        "SELECT project_id, sort_order, asset_refs_json
                         FROM comic_shots WHERE id = ?1",
                        params![id],
                        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                    )
                    .optional()?;
                let Some((owner, current_order, current_asset_refs)) = existing else {
                    return Err(AppError::NotFound("镜头不存在或已被删除".into()));
                };
                if owner != project_id {
                    return Err(AppError::Validation("镜头不属于当前项目".into()));
                }
                // 未提交素材引用时沿用原值（历史路径引用只读保留，绝不清空）。
                let asset_refs_json = match &asset_refs {
                    Some(refs) => serialize_id_array(refs)?,
                    None => current_asset_refs,
                };
                let order = match sort_order {
                    Some(value) => validate_sort_order(value)?,
                    None => current_order,
                };
                let no = match shot_no.filter(|v| *v > 0) {
                    Some(value) => value,
                    None => conn.query_row(
                        "SELECT shot_no FROM comic_shots WHERE id = ?1",
                        params![id],
                        |r| r.get(0),
                    )?,
                };
                conn.execute(
                    "UPDATE comic_shots
                     SET episode_id = ?2, shot_no = ?3, description = ?4,
                         character_ids_json = ?5, scene_id = ?6, dialogue = ?7,
                         shot_size = ?8, camera_move = ?9, duration_sec = ?10, status = ?11,
                         asset_refs_json = ?12, note = ?13, sort_order = ?14, updated_at = ?15
                     WHERE id = ?1 AND project_id = ?16",
                    params![
                        id,
                        episode_id,
                        no,
                        description,
                        character_ids_json,
                        scene_id,
                        dialogue,
                        shot_size,
                        camera_move,
                        duration_sec,
                        status,
                        asset_refs_json,
                        note,
                        order,
                        now,
                        project_id
                    ],
                )?;
                Ok::<String, AppError>(id)
            }
        }
    })?;
    db.with_read(|conn| read_shot(conn, &saved_id))
}

pub fn comic_shot_delete_impl(db: &Db, id: &str) -> AppResult<()> {
    db.with_conn(|conn| {
        let project_id = owner_project_id(conn, "comic_shots", id)?;
        ensure_comic_project(conn, &project_id, true)?;
        // 素材版本由外键级联删除元数据行；用户素材原文件不动。
        conn.execute("DELETE FROM comic_shots WHERE id = ?1", params![id])?;
        Ok(())
    })
}

/// 镜头排序：限定在同一剧集内，按传入 ID 顺序重写 sort_order。
pub fn comic_shot_reorder_impl(
    db: &Db,
    project_id: &str,
    episode_id: &str,
    shot_ids: Vec<String>,
) -> AppResult<Vec<ComicShot>> {
    let project_id = project_id.trim().to_string();
    let episode_id = episode_id.trim().to_string();
    if project_id.is_empty() || episode_id.is_empty() {
        return Err(AppError::Validation("项目与剧集不能为空".into()));
    }
    db.with_transaction(|conn| {
        ensure_comic_project(conn, &project_id, true)?;
        ensure_episode_belongs(conn, &project_id, &episode_id)?;
        for (index, shot_id) in shot_ids.iter().enumerate() {
            let row: Option<(String, String)> = conn
                .query_row(
                    "SELECT project_id, episode_id FROM comic_shots WHERE id = ?1",
                    params![shot_id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            match row {
                Some((owner, ep)) if owner == project_id && ep == episode_id => {}
                Some(_) => return Err(AppError::Validation("镜头不属于当前剧集".into())),
                None => return Err(AppError::NotFound("镜头不存在或已被删除".into())),
            }
            conn.execute(
                "UPDATE comic_shots SET sort_order = ?2, updated_at = ?3 WHERE id = ?1",
                params![shot_id, index as i64, now_iso()],
            )?;
        }
        Ok(())
    })?;
    comic_shot_list_impl(db, &project_id, Some(episode_id.to_string()))
}

// ── 角色 ──────────────────────────────────────────────────────────────

fn row_to_character(row: &rusqlite::Row<'_>) -> rusqlite::Result<ComicCharacter> {
    let ref_image_path: String = row.get("ref_image_path")?;
    Ok(ComicCharacter {
        id: row.get("id")?,
        project_id: row.get("project_id")?,
        name: row.get("name")?,
        role: row.get("role")?,
        description: row.get("description")?,
        ref_image_exists: file_exists(&ref_image_path),
        ref_image_path,
        sort_order: row.get("sort_order")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn read_character(conn: &Connection, id: &str) -> AppResult<ComicCharacter> {
    conn.query_row(
        "SELECT id, project_id, name, role, description, ref_image_path, sort_order,
                created_at, updated_at
         FROM comic_characters WHERE id = ?1",
        params![id],
        row_to_character,
    )
    .optional()?
    .ok_or_else(|| AppError::NotFound("角色不存在或已被删除".into()))
}

pub fn comic_character_list_impl(
    db: &Db,
    project_id: &str,
) -> AppResult<Vec<ComicCharacter>> {
    db.with_read(|conn| {
        ensure_comic_project(conn, project_id, false)?;
        let mut stmt = conn.prepare(
            "SELECT id, project_id, name, role, description, ref_image_path, sort_order,
                    created_at, updated_at
             FROM comic_characters WHERE project_id = ?1
             ORDER BY sort_order, created_at, id
             LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![project_id, MAX_LIST_ROWS], row_to_character)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(AppError::from)?);
        }
        Ok(out)
    })
}

pub fn comic_character_save_impl(
    db: &Db,
    id: Option<String>,
    project_id: String,
    name: String,
    role: String,
    description: String,
    ref_image_path: Option<String>,
    sort_order: Option<i64>,
) -> AppResult<ComicCharacter> {
    let project_id = project_id.trim().to_string();
    if project_id.is_empty() {
        return Err(AppError::Validation("项目 ID 不能为空".into()));
    }
    let name = validate_text(&name, "角色名称", MAX_TITLE_CHARS, false)?;
    let role = validate_text(&role, "角色定位", MAX_LONG_TEXT_CHARS, true)?;
    let description = validate_text(&description, "角色设定", MAX_LONG_TEXT_CHARS, true)?;
    let ref_image_path = validate_ref_path(
        ref_image_path.as_deref().unwrap_or_default(),
        "参考图",
    )?;
    let id = id
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let saved_id = db.with_conn(|conn| {
        ensure_comic_project(conn, &project_id, true)?;
        let now = now_iso();
        match id {
            None => {
                let order = match sort_order {
                    Some(value) => validate_sort_order(value)?,
                    None => next_sort(conn, "comic_characters", &project_id)?,
                };
                let id = uuid::Uuid::new_v4().to_string();
                conn.execute(
                    "INSERT INTO comic_characters
                     (id, project_id, name, role, description, ref_image_path, sort_order,
                      created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
                    params![id, project_id, name, role, description, ref_image_path, order, now],
                )?;
                Ok::<String, AppError>(id)
            }
            Some(id) => {
                let existing: Option<(String, i64)> = conn
                    .query_row(
                        "SELECT project_id, sort_order FROM comic_characters WHERE id = ?1",
                        params![id],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .optional()?;
                let Some((owner, current_order)) = existing else {
                    return Err(AppError::NotFound("角色不存在或已被删除".into()));
                };
                if owner != project_id {
                    return Err(AppError::Validation("角色不属于当前项目".into()));
                }
                let order = match sort_order {
                    Some(value) => validate_sort_order(value)?,
                    None => current_order,
                };
                conn.execute(
                    "UPDATE comic_characters
                     SET name = ?2, role = ?3, description = ?4, ref_image_path = ?5,
                         sort_order = ?6, updated_at = ?7
                     WHERE id = ?1 AND project_id = ?8",
                    params![id, name, role, description, ref_image_path, order, now, project_id],
                )?;
                Ok::<String, AppError>(id)
            }
        }
    })?;
    db.with_read(|conn| read_character(conn, &saved_id))
}

pub fn comic_character_delete_impl(db: &Db, id: &str) -> AppResult<()> {
    db.with_transaction(|conn| {
        let project_id = owner_project_id(conn, "comic_characters", id)?;
        ensure_comic_project(conn, &project_id, true)?;
        // 删除全局角色的同事务清理（P0）：剧集出场名单、镜头角色列表、本集形象覆盖。
        // 不清理会留下无法解释的悬空 ID（前端只能降级展示，用户无法判断数据是否有效）。
        // 素材版本的 character_id 由外键置空。
        prune_character_refs(conn, "comic_episodes", "character_ids_json", &project_id, id)?;
        prune_character_refs(conn, "comic_shots", "character_ids_json", &project_id, id)?;
        conn.execute(
            "DELETE FROM comic_episode_character_overrides WHERE character_id = ?1",
            params![id],
        )?;
        conn.execute(
            "DELETE FROM comic_characters WHERE id = ?1 AND project_id = ?2",
            params![id, project_id],
        )?;
        Ok(())
    })
}

/// 从 `table.column` 的 JSON ID 数组里移除指定角色；只有真正变化时才写回。
/// 表名/列名来自本文件内的字面量，不接受外部输入。
fn prune_character_refs(
    conn: &Connection,
    table: &str,
    json_column: &str,
    project_id: &str,
    character_id: &str,
) -> AppResult<()> {
    let sql = format!("SELECT id, {json_column} FROM {table} WHERE project_id = ?1");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![project_id], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut updates: Vec<(String, String)> = Vec::new();
    for row in rows {
        let (row_id, raw) = row?;
        let ids = parse_id_array(&raw);
        if !ids.iter().any(|existing| existing == character_id) {
            continue;
        }
        let filtered: Vec<String> = ids
            .into_iter()
            .filter(|existing| existing != character_id)
            .collect();
        updates.push((row_id, serialize_id_array(&filtered)?));
    }
    drop(stmt);
    for (row_id, json) in updates {
        let sql = format!("UPDATE {table} SET {json_column} = ?2 WHERE id = ?1");
        conn.execute(&sql, params![row_id, json])?;
    }
    Ok(())
}

// ── 每集角色形象覆盖（v96）────────────────────────────────────────────

const OVERRIDE_COLUMNS: &str = "id, project_id, episode_id, character_id, role_in_episode, \
    appearance_label, appearance_description, costume_description, hair_style_description, \
    state_description, visual_prompt_override, ref_image_path, created_at, updated_at";

fn read_override(
    conn: &Connection,
    episode_id: &str,
    character_id: &str,
) -> AppResult<Option<ComicEpisodeCharacterOverride>> {
    let sql = format!(
        "SELECT {OVERRIDE_COLUMNS} FROM comic_episode_character_overrides
         WHERE episode_id = ?1 AND character_id = ?2"
    );
    let row = conn
        .query_row(&sql, params![episode_id, character_id], |row| {
            let ref_image_path: String = row.get("ref_image_path")?;
            Ok((
                row.get::<_, String>("id")?,
                row.get::<_, String>("project_id")?,
                row.get::<_, String>("episode_id")?,
                row.get::<_, String>("character_id")?,
                row.get::<_, String>("role_in_episode")?,
                row.get::<_, String>("appearance_label")?,
                row.get::<_, String>("appearance_description")?,
                row.get::<_, String>("costume_description")?,
                row.get::<_, String>("hair_style_description")?,
                row.get::<_, String>("state_description")?,
                row.get::<_, String>("visual_prompt_override")?,
                ref_image_path,
                row.get::<_, String>("created_at")?,
                row.get::<_, String>("updated_at")?,
            ))
        })
        .optional()?;
    let Some((
        id,
        project_id,
        episode_id,
        character_id,
        role_in_episode,
        appearance_label,
        appearance_description,
        costume_description,
        hair_style_description,
        state_description,
        visual_prompt_override,
        ref_image_path,
        created_at,
        updated_at,
    )) = row
    else {
        return Ok(None);
    };
    Ok(Some(ComicEpisodeCharacterOverride {
        id,
        project_id,
        episode_id,
        character_id: character_id.clone(),
        role_in_episode,
        appearance_label,
        appearance_description,
        costume_description,
        hair_style_description,
        state_description,
        visual_prompt_override,
        ref_image_exists: file_exists(&ref_image_path),
        ref_image_path,
        character: read_character(conn, &character_id)?,
        created_at,
        updated_at,
    }))
}

/// 只返回「当前剧集有效出场角色」的覆盖记录；移出本集的角色即使保留覆盖行也不返回，
/// 避免前端把非出场角色当成可编辑对象。
pub fn comic_episode_character_override_list_impl(
    db: &Db,
    project_id: &str,
    episode_id: &str,
) -> AppResult<Vec<ComicEpisodeCharacterOverride>> {
    db.with_read(|conn| {
        ensure_comic_project(conn, project_id, false)?;
        ensure_episode_belongs(conn, project_id, episode_id)?;
        let raw: String = conn.query_row(
            "SELECT character_ids_json FROM comic_episodes WHERE id = ?1",
            params![episode_id],
            |row| row.get(0),
        )?;
        let mut out = Vec::new();
        for character_id in parse_id_array(&raw) {
            if let Some(record) = read_override(conn, episode_id, &character_id)? {
                out.push(record);
            }
        }
        Ok(out)
    })
}

/// 保存本集形象覆盖：事务内按 `(episode_id, character_id)` Upsert，只动覆盖表，
/// 绝不修改全局 `comic_characters`，也不影响其它剧集。
#[allow(clippy::too_many_arguments)]
pub fn comic_episode_character_override_save_impl(
    db: &Db,
    project_id: &str,
    episode_id: &str,
    character_id: &str,
    role_in_episode: String,
    appearance_label: String,
    appearance_description: String,
    costume_description: String,
    hair_style_description: String,
    state_description: String,
    visual_prompt_override: String,
    ref_image_path: String,
) -> AppResult<ComicEpisodeCharacterOverride> {
    let project_id = project_id.trim().to_string();
    let episode_id = episode_id.trim().to_string();
    let character_id = character_id.trim().to_string();
    if project_id.is_empty() || episode_id.is_empty() || character_id.is_empty() {
        return Err(AppError::Validation("项目、剧集与角色不能为空".into()));
    }
    let role_in_episode =
        validate_text(&role_in_episode, "本集定位", MAX_LONG_TEXT_CHARS, true)?;
    let appearance_label =
        validate_text(&appearance_label, "本集形象名称", MAX_TITLE_CHARS, true)?;
    let appearance_description = validate_multiline_text(
        &appearance_description,
        "本集外貌",
        MAX_LONG_TEXT_CHARS,
        true,
    )?;
    let costume_description = validate_multiline_text(
        &costume_description,
        "本集服装",
        MAX_LONG_TEXT_CHARS,
        true,
    )?;
    let hair_style_description = validate_multiline_text(
        &hair_style_description,
        "本集发型",
        MAX_LONG_TEXT_CHARS,
        true,
    )?;
    let state_description = validate_multiline_text(
        &state_description,
        "本集状态",
        MAX_LONG_TEXT_CHARS,
        true,
    )?;
    let visual_prompt_override = validate_multiline_text(
        &visual_prompt_override,
        "本集形象提示词",
        MAX_OVERRIDE_PROMPT_CHARS,
        true,
    )?;
    let ref_image_path = validate_ref_path(&ref_image_path, "本集参考图")?;

    db.with_transaction(|conn| {
        ensure_comic_project(conn, &project_id, true)?;
        ensure_episode_belongs(conn, &project_id, &episode_id)?;
        ensure_character_belongs(conn, &project_id, &character_id)?;
        let raw: String = conn.query_row(
            "SELECT character_ids_json FROM comic_episodes WHERE id = ?1",
            params![episode_id],
            |row| row.get(0),
        )?;
        if !parse_id_array(&raw).iter().any(|id| id == &character_id) {
            let name = character_name(conn, &character_id)?;
            return Err(AppError::Validation(format!(
                "角色「{name}」不在本集出场名单，请先在剧集中加入该角色再编辑本集形象"
            )));
        }
        let now = now_iso();
        conn.execute(
            "INSERT INTO comic_episode_character_overrides
             (id, project_id, episode_id, character_id, role_in_episode, appearance_label,
              appearance_description, costume_description, hair_style_description,
              state_description, visual_prompt_override, ref_image_path, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13)
             ON CONFLICT(episode_id, character_id) DO UPDATE SET
               role_in_episode = excluded.role_in_episode,
               appearance_label = excluded.appearance_label,
               appearance_description = excluded.appearance_description,
               costume_description = excluded.costume_description,
               hair_style_description = excluded.hair_style_description,
               state_description = excluded.state_description,
               visual_prompt_override = excluded.visual_prompt_override,
               ref_image_path = excluded.ref_image_path,
               updated_at = excluded.updated_at",
            params![
                uuid::Uuid::new_v4().to_string(),
                project_id,
                episode_id,
                character_id,
                role_in_episode,
                appearance_label,
                appearance_description,
                costume_description,
                hair_style_description,
                state_description,
                visual_prompt_override,
                ref_image_path,
                now
            ],
        )?;
        read_override(conn, &episode_id, &character_id)?
            .ok_or_else(|| AppError::NotFound("本集形象覆盖保存后未找到记录".into()))
    })
}

/// 删除本集覆盖 = 恢复全局档案；全局角色与其它剧集覆盖不受影响（幂等）。
pub fn comic_episode_character_override_delete_impl(
    db: &Db,
    project_id: &str,
    episode_id: &str,
    character_id: &str,
) -> AppResult<()> {
    let project_id = project_id.trim().to_string();
    let episode_id = episode_id.trim().to_string();
    let character_id = character_id.trim().to_string();
    if project_id.is_empty() || episode_id.is_empty() || character_id.is_empty() {
        return Err(AppError::Validation("项目、剧集与角色不能为空".into()));
    }
    db.with_conn(|conn| {
        ensure_comic_project(conn, &project_id, true)?;
        ensure_episode_belongs(conn, &project_id, &episode_id)?;
        ensure_character_belongs(conn, &project_id, &character_id)?;
        conn.execute(
            "DELETE FROM comic_episode_character_overrides
             WHERE episode_id = ?1 AND character_id = ?2",
            params![episode_id, character_id],
        )?;
        Ok(())
    })
}

// ── 场景 ──────────────────────────────────────────────────────────────

fn row_to_scene(row: &rusqlite::Row<'_>) -> rusqlite::Result<ComicScene> {
    let ref_image_path: String = row.get("ref_image_path")?;
    Ok(ComicScene {
        id: row.get("id")?,
        project_id: row.get("project_id")?,
        name: row.get("name")?,
        description: row.get("description")?,
        ref_image_exists: file_exists(&ref_image_path),
        ref_image_path,
        sort_order: row.get("sort_order")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn read_scene(conn: &Connection, id: &str) -> AppResult<ComicScene> {
    conn.query_row(
        "SELECT id, project_id, name, description, ref_image_path, sort_order,
                created_at, updated_at
         FROM comic_scenes WHERE id = ?1",
        params![id],
        row_to_scene,
    )
    .optional()?
    .ok_or_else(|| AppError::NotFound("场景不存在或已被删除".into()))
}

pub fn comic_scene_list_impl(db: &Db, project_id: &str) -> AppResult<Vec<ComicScene>> {
    db.with_read(|conn| {
        ensure_comic_project(conn, project_id, false)?;
        let mut stmt = conn.prepare(
            "SELECT id, project_id, name, description, ref_image_path, sort_order,
                    created_at, updated_at
             FROM comic_scenes WHERE project_id = ?1
             ORDER BY sort_order, created_at, id
             LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![project_id, MAX_LIST_ROWS], row_to_scene)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(AppError::from)?);
        }
        Ok(out)
    })
}

pub fn comic_scene_save_impl(
    db: &Db,
    id: Option<String>,
    project_id: String,
    name: String,
    description: String,
    ref_image_path: Option<String>,
    sort_order: Option<i64>,
) -> AppResult<ComicScene> {
    let project_id = project_id.trim().to_string();
    if project_id.is_empty() {
        return Err(AppError::Validation("项目 ID 不能为空".into()));
    }
    let name = validate_text(&name, "场景名称", MAX_TITLE_CHARS, false)?;
    let description = validate_text(&description, "场景设定", MAX_LONG_TEXT_CHARS, true)?;
    let ref_image_path = validate_ref_path(
        ref_image_path.as_deref().unwrap_or_default(),
        "参考图",
    )?;
    let id = id
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let saved_id = db.with_conn(|conn| {
        ensure_comic_project(conn, &project_id, true)?;
        let now = now_iso();
        match id {
            None => {
                let order = match sort_order {
                    Some(value) => validate_sort_order(value)?,
                    None => next_sort(conn, "comic_scenes", &project_id)?,
                };
                let id = uuid::Uuid::new_v4().to_string();
                conn.execute(
                    "INSERT INTO comic_scenes
                     (id, project_id, name, description, ref_image_path, sort_order,
                      created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
                    params![id, project_id, name, description, ref_image_path, order, now],
                )?;
                Ok::<String, AppError>(id)
            }
            Some(id) => {
                let existing: Option<(String, i64)> = conn
                    .query_row(
                        "SELECT project_id, sort_order FROM comic_scenes WHERE id = ?1",
                        params![id],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .optional()?;
                let Some((owner, current_order)) = existing else {
                    return Err(AppError::NotFound("场景不存在或已被删除".into()));
                };
                if owner != project_id {
                    return Err(AppError::Validation("场景不属于当前项目".into()));
                }
                let order = match sort_order {
                    Some(value) => validate_sort_order(value)?,
                    None => current_order,
                };
                conn.execute(
                    "UPDATE comic_scenes
                     SET name = ?2, description = ?3, ref_image_path = ?4, sort_order = ?5,
                         updated_at = ?6
                     WHERE id = ?1 AND project_id = ?7",
                    params![id, name, description, ref_image_path, order, now, project_id],
                )?;
                Ok::<String, AppError>(id)
            }
        }
    })?;
    db.with_read(|conn| read_scene(conn, &saved_id))
}

pub fn comic_scene_delete_impl(db: &Db, id: &str) -> AppResult<()> {
    db.with_conn(|conn| {
        let project_id = owner_project_id(conn, "comic_scenes", id)?;
        ensure_comic_project(conn, &project_id, true)?;
        conn.execute("DELETE FROM comic_scenes WHERE id = ?1", params![id])?;
        Ok(())
    })
}

// ── 素材与产物版本 ────────────────────────────────────────────────────

fn row_to_media(row: &rusqlite::Row<'_>) -> rusqlite::Result<ComicMediaVersion> {
    let file_path: String = row.get("file_path")?;
    let provider: Option<String> = row.get("gen_provider")?;
    let model: Option<String> = row.get("gen_model")?;
    let model_version: Option<String> = row.get("gen_version")?;
    let parts: Vec<&str> = [provider.as_deref(), model.as_deref(), model_version.as_deref()]
        .into_iter()
        .flatten()
        .filter(|value| !value.trim().is_empty())
        .collect();
    let generation_label = if parts.is_empty() {
        None
    } else {
        Some(parts.join(" · "))
    };
    Ok(ComicMediaVersion {
        id: row.get("id")?,
        project_id: row.get("project_id")?,
        shot_id: row.get("shot_id")?,
        character_id: row.get("character_id")?,
        scene_id: row.get("scene_id")?,
        file_exists: file_exists(&file_path),
        file_path,
        media_kind: row.get("media_kind")?,
        version_label: row.get("version_label")?,
        status: row.get("status")?,
        review_note: row.get("review_note")?,
        source: row.get("source")?,
        generation_run_id: row.get("generation_run_id")?,
        generation_label,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

const MEDIA_COLUMNS: &str = "m.id, m.project_id, m.shot_id, m.character_id, m.scene_id, \
    m.file_path, m.media_kind, m.version_label, m.status, m.review_note, m.source, \
    m.generation_run_id, m.created_at, m.updated_at, \
    g.model_provider AS gen_provider, g.model_name AS gen_model, g.model_version AS gen_version";

const MEDIA_JOINS: &str =
    "LEFT JOIN comic_generation_runs g ON g.id = m.generation_run_id";

pub(crate) fn read_media(conn: &Connection, id: &str) -> AppResult<ComicMediaVersion> {
    let sql = format!(
        "SELECT {MEDIA_COLUMNS} FROM comic_media_versions m {MEDIA_JOINS} WHERE m.id = ?1"
    );
    conn.query_row(&sql, params![id], row_to_media)
        .optional()?
        .ok_or_else(|| AppError::NotFound("素材版本不存在或已被删除".into()))
}

pub fn comic_media_list_impl(
    db: &Db,
    project_id: &str,
    shot_id: Option<String>,
) -> AppResult<Vec<ComicMediaVersion>> {
    db.with_read(|conn| {
        let (rows, _total) = comic_media_list_page_in_conn(
            conn,
            project_id,
            shot_id.as_deref(),
            MAX_LIST_ROWS as u32,
            0,
        )?;
        Ok(rows)
    })
}

/// 素材版本分页读取（Agent 领域入口共用；调用方持有读连接）。
///
/// `shot_id` 给定时必须先确认镜头属于当前项目，避免跨项目探测。
pub(crate) fn comic_media_list_page_in_conn(
    conn: &Connection,
    project_id: &str,
    shot_id: Option<&str>,
    limit: u32,
    offset: u32,
) -> AppResult<(Vec<ComicMediaVersion>, u32)> {
    ensure_comic_project(conn, project_id, false)?;
    if let Some(shot_id) = shot_id.filter(|s| !s.is_empty()) {
        let owner: Option<String> = conn
            .query_row(
                "SELECT project_id FROM comic_shots WHERE id = ?1",
                params![shot_id],
                |r| r.get(0),
            )
            .optional()?;
        match owner {
            Some(owner) if owner == project_id => {}
            Some(_) => return Err(AppError::Validation("镜头不属于当前项目".into())),
            None => return Err(AppError::NotFound("镜头不存在".into())),
        }
    }
    let total: i64 = conn.query_row(
        "SELECT COUNT(*) FROM comic_media_versions
         WHERE project_id = ?1 AND (?2 IS NULL OR shot_id = ?2)",
        params![project_id, shot_id],
        |r| r.get(0),
    )?;
    let sql = format!(
        "SELECT {MEDIA_COLUMNS} FROM comic_media_versions m {MEDIA_JOINS}
         WHERE m.project_id = ?1 AND (?2 IS NULL OR m.shot_id = ?2)
         ORDER BY m.created_at, m.id
         LIMIT ?3 OFFSET ?4"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(
        params![project_id, shot_id, limit as i64, offset as i64],
        row_to_media,
    )?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(AppError::from)?);
    }
    Ok((out, total.max(0) as u32))
}

/// 导入本地素材：只登记绝对路径引用，不复制大文件；目标三选一（镜头/角色/场景）。
///
/// 保留原签名供既有调用方使用；需要关联外部生成记录时走
/// `comic_media_import_with_run_impl`（IPC 命令 `comic_media_import` 已暴露该可选参数）。
#[allow(clippy::too_many_arguments)]
pub fn comic_media_import_impl(
    db: &Db,
    id: Option<String>,
    project_id: String,
    shot_id: Option<String>,
    character_id: Option<String>,
    scene_id: Option<String>,
    file_path: String,
    media_kind: String,
    version_label: Option<String>,
    review_note: Option<String>,
) -> AppResult<ComicMediaVersion> {
    comic_media_import_with_run_impl(
        db,
        id,
        project_id,
        shot_id,
        character_id,
        scene_id,
        file_path,
        media_kind,
        version_label,
        review_note,
        None,
    )
}

/// 导入素材并可选关联生成记录：记录必须属于当前项目、同一镜头、同一剧集。
#[allow(clippy::too_many_arguments)]
pub fn comic_media_import_with_run_impl(
    db: &Db,
    id: Option<String>,
    project_id: String,
    shot_id: Option<String>,
    character_id: Option<String>,
    scene_id: Option<String>,
    file_path: String,
    media_kind: String,
    version_label: Option<String>,
    review_note: Option<String>,
    generation_run_id: Option<String>,
) -> AppResult<ComicMediaVersion> {
    let project_id = project_id.trim().to_string();
    if project_id.is_empty() {
        return Err(AppError::Validation("项目 ID 不能为空".into()));
    }
    let file_path = validate_ref_path(&file_path, "素材路径")?;
    if file_path.is_empty() {
        return Err(AppError::Validation("素材路径不能为空".into()));
    }
    let media_kind = validate_enum(&media_kind, "素材类型", MEDIA_KINDS)?;
    let version_label = validate_text(
        version_label.as_deref().unwrap_or_default(),
        "版本标注",
        MAX_TITLE_CHARS,
        true,
    )?;
    let review_note = validate_text(
        review_note.as_deref().unwrap_or_default(),
        "修改意见",
        MAX_LONG_TEXT_CHARS,
        true,
    )?;
    let shot_id = normalize_target(shot_id)?;
    let character_id = normalize_target(character_id)?;
    let scene_id = normalize_target(scene_id)?;
    let target_count = shot_id.is_some() as usize
        + character_id.is_some() as usize
        + scene_id.is_some() as usize;
    if target_count != 1 {
        return Err(AppError::Validation(
            "素材必须且只能关联到一个镜头、角色或场景".into(),
        ));
    }
    let generation_run_id = match generation_run_id {
        None => None,
        Some(value) => {
            let value = value.trim().to_string();
            if value.is_empty() {
                None
            } else if value.chars().count() > 64 || value.chars().any(|c| c.is_control()) {
                return Err(AppError::Validation("生成记录 ID 格式非法".into()));
            } else {
                Some(value)
            }
        }
    };

    let saved_id = db.with_conn(|conn| {
        ensure_comic_project(conn, &project_id, true)?;
        if let Some(shot_id) = shot_id.as_deref() {
            ensure_shot_belongs(conn, &project_id, shot_id)?;
        }
        if let Some(character_id) = character_id.as_deref() {
            ensure_character_belongs(conn, &project_id, character_id)?;
        }
        if let Some(scene_id) = scene_id.as_deref() {
            ensure_scene_belongs(conn, &project_id, scene_id)?;
        }
        if let Some(run_id) = generation_run_id.as_deref() {
            ensure_generation_run_links(conn, &project_id, run_id, shot_id.as_deref())?;
        }
        let now = now_iso();
        let id = id
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        match id {
            None => {
                let id = uuid::Uuid::new_v4().to_string();
                conn.execute(
                    "INSERT INTO comic_media_versions
                     (id, project_id, shot_id, character_id, scene_id, file_path, media_kind,
                      version_label, status, review_note, source, generation_run_id,
                      created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'candidate', ?9, 'imported',
                              ?10, ?11, ?11)",
                    params![
                        id,
                        project_id,
                        shot_id,
                        character_id,
                        scene_id,
                        file_path,
                        media_kind,
                        version_label,
                        review_note,
                        generation_run_id,
                        now
                    ],
                )?;
                Ok::<String, AppError>(id)
            }
            Some(id) => {
                let existing: Option<(String, Option<String>)> = conn
                    .query_row(
                        "SELECT project_id, generation_run_id
                         FROM comic_media_versions WHERE id = ?1",
                        params![id],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )
                    .optional()?;
                let Some((owner, current_run)) = existing else {
                    return Err(AppError::NotFound("素材版本不存在或已被删除".into()));
                };
                if owner != project_id {
                    return Err(AppError::Validation("素材版本不属于当前项目".into()));
                }
                // 更新关联目标时同样校验归属，禁止把版本指向其它项目的镜头/角色/场景。
                if let Some(shot_id) = shot_id.as_deref() {
                    ensure_shot_belongs(conn, &project_id, shot_id)?;
                }
                if let Some(character_id) = character_id.as_deref() {
                    ensure_character_belongs(conn, &project_id, character_id)?;
                }
                if let Some(scene_id) = scene_id.as_deref() {
                    ensure_scene_belongs(conn, &project_id, scene_id)?;
                }
                // 未显式提交时保留原关联；但换目标后原关联必须仍然自洽。
                let effective_run = generation_run_id.clone().or(current_run);
                if let Some(run_id) = effective_run.as_deref() {
                    ensure_generation_run_links(conn, &project_id, run_id, shot_id.as_deref())?;
                }
                conn.execute(
                    "UPDATE comic_media_versions
                     SET shot_id = ?2, character_id = ?3, scene_id = ?4, file_path = ?5,
                         media_kind = ?6, version_label = ?7, review_note = ?8,
                         generation_run_id = ?9, updated_at = ?10
                     WHERE id = ?1 AND project_id = ?11",
                    params![
                        id,
                        shot_id,
                        character_id,
                        scene_id,
                        file_path,
                        media_kind,
                        version_label,
                        review_note,
                        effective_run,
                        now,
                        project_id
                    ],
                )?;
                Ok::<String, AppError>(id)
            }
        }
    })?;
    db.with_read(|conn| read_media(conn, &saved_id))
}

fn normalize_target(raw: Option<String>) -> AppResult<Option<String>> {
    match raw {
        None => Ok(None),
        Some(value) => {
            let value = value.trim().to_string();
            if value.is_empty() {
                Ok(None)
            } else if value.chars().count() > 64 || value.chars().any(|c| c.is_control()) {
                Err(AppError::Validation("关联目标格式非法".into()))
            } else {
                Ok(Some(value))
            }
        }
    }
}

fn ensure_shot_belongs(
    conn: &Connection,
    project_id: &str,
    shot_id: &str,
) -> AppResult<()> {
    let owner: Option<String> = conn
        .query_row(
            "SELECT project_id FROM comic_shots WHERE id = ?1",
            params![shot_id],
            |r| r.get(0),
        )
        .optional()?;
    match owner {
        Some(owner) if owner == project_id => Ok(()),
        Some(_) => Err(AppError::Validation("镜头不属于当前项目".into())),
        None => Err(AppError::Validation("镜头不存在".into())),
    }
}

fn ensure_character_belongs(
    conn: &Connection,
    project_id: &str,
    character_id: &str,
) -> AppResult<()> {
    let owner: Option<String> = conn
        .query_row(
            "SELECT project_id FROM comic_characters WHERE id = ?1",
            params![character_id],
            |r| r.get(0),
        )
        .optional()?;
    match owner {
        Some(owner) if owner == project_id => Ok(()),
        Some(_) => Err(AppError::Validation("角色不属于当前项目".into())),
        None => Err(AppError::Validation("角色不存在".into())),
    }
}

/// 素材与生成记录的关联校验（v99）：
///
/// - 记录必须属于当前项目；
/// - 导入目标必须是镜头（角色/场景参考图不接受生成记录）；
/// - 镜头级记录：目标镜头必须与记录镜头一致；
/// - 整集级记录（`shot_id = NULL`）：目标镜头必须属于记录剧集，可关联本集任意镜头的产物；
/// - 任何情况下都不允许跨项目、跨剧集关联。
fn ensure_generation_run_links(
    conn: &Connection,
    project_id: &str,
    generation_run_id: &str,
    shot_id: Option<&str>,
) -> AppResult<()> {
    let row: Option<(String, String, Option<String>)> = conn
        .query_row(
            "SELECT project_id, episode_id, shot_id FROM comic_generation_runs WHERE id = ?1",
            params![generation_run_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    let Some((owner, run_episode, run_shot)) = row else {
        return Err(AppError::NotFound("生成记录不存在或已被删除".into()));
    };
    if owner != project_id {
        return Err(AppError::Validation("生成记录不属于当前项目".into()));
    }
    let Some(target_shot) = shot_id else {
        return Err(AppError::Validation(
            "生成记录只能关联到镜头素材；当前导入目标不是镜头".into(),
        ));
    };
    // 一次查询同时确认镜头存在、属于当前项目，并拿到所属剧集。
    let target_episode: Option<String> = conn
        .query_row(
            "SELECT episode_id FROM comic_shots WHERE id = ?1 AND project_id = ?2",
            params![target_shot, project_id],
            |r| r.get(0),
        )
        .optional()?;
    let Some(target_episode) = target_episode else {
        return Err(AppError::Validation(
            "目标镜头不存在或不属于当前项目".into(),
        ));
    };
    match run_shot.as_deref() {
        Some(run_shot) if run_shot == target_shot => {}
        Some(_) => {
            return Err(AppError::Validation(
                "生成记录关联的镜头与素材目标镜头不一致".into(),
            ));
        }
        // 整集级记录：允许同集任意镜头，但跨集一律拒绝。
        None => {}
    }
    if target_episode != run_episode {
        return Err(AppError::Validation(
            "生成记录关联的剧集与镜头所属剧集不一致".into(),
        ));
    }
    Ok(())
}

/// 素材版本元信息编辑：版本标注 / 修改意见 / 候选-拒收状态。采用状态走 `adopt` 命令。
///
/// 校验统一在 `comic_media_save_in_conn` 内完成：IPC、Agent 领域、文件导入
/// 共用同一套规则，入口层不再各写一份。这里只负责事务边界与回读。
pub fn comic_media_save_impl(
    db: &Db,
    id: &str,
    version_label: Option<String>,
    status: Option<String>,
    review_note: Option<String>,
) -> AppResult<ComicMediaVersion> {
    db.with_transaction(|conn| {
        let previous_at: String = conn.query_row(
            "SELECT updated_at FROM comic_media_versions WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )?;
        let (_project_id, saved_at) = comic_media_save_in_conn(
            conn,
            id,
            version_label.unwrap_or_default(),
            status,
            review_note.unwrap_or_default(),
        )?;
        // UI 写入与 Agent 领域核心共用业务校验，但只有 UI 包装层推进版本；
        // 领域核心在自己的事务里推进，避免重复 +1。
        crate::agent_access::domains::revision::note_ui_write(
            conn,
            "comic.media_version",
            id,
            &previous_at,
            &saved_at,
        )?;
        Ok(())
    })?;
    db.with_read(|conn| read_media(conn, id))
}

/// 素材版本元信息业务校验（所有入口唯一事实源）。
///
/// - `version_label` ≤ 240 字符，允许空串；
/// - `review_note` ≤ 4000 字符，允许空串；
/// - `status` 只允许 candidate / rejected；`adopted` 必须走独立 adopt 操作；
/// - 统一 trim 首尾空白并拒绝控制字符。
pub(crate) fn validate_media_meta(
    version_label: &str,
    status: Option<&str>,
    review_note: &str,
) -> AppResult<(String, Option<String>, String)> {
    let version_label = validate_text(version_label, "版本标注", MAX_TITLE_CHARS, true)?;
    let review_note = validate_text(review_note, "修改意见", MAX_LONG_TEXT_CHARS, true)?;
    let status = match status {
        None => None,
        Some(value) => {
            if value.trim() == "adopted" {
                return Err(AppError::Validation(
                    "素材状态 adopted 只能通过独立的 comic.media.adopt 操作设置（candidate | rejected）"
                        .into(),
                ));
            }
            Some(validate_enum(value, "素材状态", MEDIA_IMPORT_STATUSES)?)
        }
    };
    Ok((version_label, status, review_note))
}

/// 素材版本元信息写入的事务内实现（Agent 领域层复用）。
///
/// 校验也在这里完成，调用方不得在入口层重复实现规则或放宽上限。
/// 返回 `(project_id, saved_at)`，供领域层做归属校验与 revision 推进。
pub(crate) fn comic_media_save_in_conn(
    conn: &rusqlite::Connection,
    id: &str,
    version_label: String,
    status: Option<String>,
    review_note: String,
) -> AppResult<(String, String)> {
    let (version_label, status, review_note) =
        validate_media_meta(&version_label, status.as_deref(), &review_note)?;
    let project_id = owner_project_id(conn, "comic_media_versions", id)?;
    ensure_comic_project(conn, &project_id, true)?;
    let now = now_iso();
    match status {
        Some(status) => conn.execute(
            "UPDATE comic_media_versions
             SET version_label = ?2, status = ?3, review_note = ?4, updated_at = ?5
             WHERE id = ?1",
            params![id, version_label, status, review_note, now],
        )?,
        None => conn.execute(
            "UPDATE comic_media_versions
             SET version_label = ?2, review_note = ?3, updated_at = ?4
             WHERE id = ?1",
            params![id, version_label, review_note, now],
        )?,
    };
    Ok((project_id, now))
}

/// 标记采用：同一镜头下其余版本回到候选；未关联镜头的参考素材不能采用。
pub fn comic_media_adopt_impl(db: &Db, id: &str) -> AppResult<ComicMediaVersion> {
    db.with_transaction(|conn| {
        let previous_at: String = conn.query_row(
            "SELECT updated_at FROM comic_media_versions WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )?;
        let (_project_id, _shot_id, saved_at, replaced) =
            comic_media_adopt_in_conn(conn, id)?;
        crate::agent_access::domains::revision::note_ui_write(
            conn,
            "comic.media_version",
            id,
            &previous_at,
            &saved_at,
        )?;
        // 被本次采用替代的旧版本也发生了变化（adopted → candidate）。
        for (old_id, old_updated_at) in replaced {
            crate::agent_access::domains::revision::note_ui_write(
                conn,
                "comic.media_version",
                &old_id,
                &old_updated_at,
                &saved_at,
            )?;
        }
        Ok(())
    })?;
    db.with_read(|conn| read_media(conn, id))
}

/// 采用素材版本的事务内实现（Agent 领域层复用）。
///
/// 返回 `(project_id, shot_id, saved_at, replaced)`：
/// `replaced` 是被本次操作从 adopted 降回 candidate 的旧版本及其**变更前**的
/// `updated_at`；领域层必须对这些资源**一并推进 revision**（文档 §7.4）。
pub(crate) fn comic_media_adopt_in_conn(
    conn: &rusqlite::Connection,
    id: &str,
) -> AppResult<(String, String, String, Vec<(String, String)>)> {
    let project_id = owner_project_id(conn, "comic_media_versions", id)?;
    ensure_comic_project(conn, &project_id, true)?;
    let shot_id: Option<String> = conn
        .query_row(
            "SELECT shot_id FROM comic_media_versions WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound("素材版本不存在或已被删除".into()))?;
    let Some(shot_id) = shot_id else {
        return Err(AppError::Validation(
            "未关联镜头的参考素材不能标记为采用版本".into(),
        ));
    };
    let replaced: Vec<(String, String)> = {
        let mut stmt = conn.prepare(
            "SELECT id, updated_at FROM comic_media_versions
             WHERE shot_id = ?1 AND status = 'adopted' AND id != ?2",
        )?;
        let rows = stmt.query_map(params![shot_id, id], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect::<Result<Vec<(String, String)>, _>>()?
    };
    let now = now_iso();
    conn.execute(
        "UPDATE comic_media_versions
         SET status = 'candidate', updated_at = ?2
         WHERE shot_id = ?1 AND status = 'adopted' AND id != ?3",
        params![shot_id, now, id],
    )?;
    conn.execute(
        "UPDATE comic_media_versions
         SET status = 'adopted', updated_at = ?2 WHERE id = ?1",
        params![id, now],
    )?;
    Ok((project_id, shot_id, now, replaced))
}

pub fn comic_media_delete_impl(db: &Db, id: &str) -> AppResult<()> {
    db.with_conn(|conn| {
        let project_id = owner_project_id(conn, "comic_media_versions", id)?;
        ensure_comic_project(conn, &project_id, true)?;
        // 只删元数据行；登记引用的用户原文件保留在原位。
        conn.execute("DELETE FROM comic_media_versions WHERE id = ?1", params![id])?;
        Ok(())
    })
}

// ── 项目概览统计（项目中枢「专业工作进展」摘要）────────────────────────

/// 漫剧项目概览统计：单次只读聚合，不遍历剧集/分镜/素材，也不触碰外部素材目录。
///
/// 隔离：每条 SQL 都带 `project_id = ?1`，不同项目的记录不可能混入计数。
/// 门禁：复用 `ensure_comic_project`（`require_active = false`，归档项目仍可读概览）。
pub fn comic_overview_stats_impl(db: &Db, project_id: &str) -> AppResult<ComicOverviewStats> {
    let project_id = project_id.trim().to_string();
    if project_id.is_empty() {
        return Err(AppError::Validation("项目 ID 不能为空".into()));
    }
    db.with_read(|conn| {
        ensure_comic_project(conn, &project_id, false)?;

        let (episode_count, completed_episode_count): (i64, i64) = conn.query_row(
            "SELECT COUNT(*),
                    COALESCE(SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END), 0)
             FROM comic_episodes WHERE project_id = ?1",
            params![project_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;

        let (shot_count, completed_shot_count, pending_shot_count, doing_shot_count, blocked_shot_count): (
            i64,
            i64,
            i64,
            i64,
            i64,
        ) = conn.query_row(
            "SELECT COUNT(*),
                    COALESCE(SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN status = 'todo' THEN 1 ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN status = 'doing' THEN 1 ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END), 0)
             FROM comic_shots WHERE project_id = ?1",
            params![project_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )?;

        let character_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM comic_characters WHERE project_id = ?1",
            params![project_id],
            |r| r.get(0),
        )?;
        let scene_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM comic_scenes WHERE project_id = ?1",
            params![project_id],
            |r| r.get(0),
        )?;

        let (media_count, adopted_media_count): (i64, i64) = conn.query_row(
            "SELECT COUNT(*),
                    COALESCE(SUM(CASE WHEN status = 'adopted' THEN 1 ELSE 0 END), 0)
             FROM comic_media_versions WHERE project_id = ?1",
            params![project_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;

        // 最近一次领域数据更新时间；全空时 MAX 为 NULL，如实返回 None。
        // 五个 `updated_at` 都是同一 ISO8601 写入格式，字符串比较即时间先后。
        let updated_at: Option<String> = conn.query_row(
            "SELECT MAX(updated_at) FROM (
                 SELECT MAX(updated_at) AS updated_at FROM comic_episodes WHERE project_id = ?1
                 UNION ALL SELECT MAX(updated_at) FROM comic_shots WHERE project_id = ?1
                 UNION ALL SELECT MAX(updated_at) FROM comic_characters WHERE project_id = ?1
                 UNION ALL SELECT MAX(updated_at) FROM comic_scenes WHERE project_id = ?1
                 UNION ALL SELECT MAX(updated_at) FROM comic_media_versions WHERE project_id = ?1
             )",
            params![project_id],
            |r| r.get::<_, Option<String>>(0),
        )?;

        Ok(ComicOverviewStats {
            project_id,
            episode_count,
            completed_episode_count,
            shot_count,
            completed_shot_count,
            pending_shot_count,
            doing_shot_count,
            blocked_shot_count,
            character_count,
            scene_count,
            media_count,
            adopted_media_count,
            updated_at,
        })
    })
}

// ── 提示词模板与不可变版本（v96）──────────────────────────────────────

const PROMPT_VERSION_COLUMNS: &str = "id, template_id, version_no, content, variables_json, \
    content_hash, change_note, is_default, created_at";

fn row_to_prompt_version(row: &rusqlite::Row<'_>) -> rusqlite::Result<ComicPromptVersion> {
    Ok(ComicPromptVersion {
        id: row.get("id")?,
        template_id: row.get("template_id")?,
        version_no: row.get("version_no")?,
        content: row.get("content")?,
        variables_json: row.get("variables_json")?,
        content_hash: row.get("content_hash")?,
        change_note: row.get("change_note")?,
        is_default: row.get::<_, i64>("is_default")? != 0,
        created_at: row.get("created_at")?,
    })
}

fn read_prompt_version(conn: &Connection, id: &str) -> AppResult<ComicPromptVersion> {
    let sql = format!(
        "SELECT {PROMPT_VERSION_COLUMNS} FROM comic_prompt_versions WHERE id = ?1"
    );
    conn.query_row(&sql, params![id], row_to_prompt_version)
        .optional()?
        .ok_or_else(|| AppError::NotFound("提示词版本不存在或已被删除".into()))
}

fn read_prompt_template(conn: &Connection, id: &str) -> AppResult<ComicPromptTemplate> {
    conn.query_row(
        "SELECT t.id, t.project_id, t.name, t.category, t.description, t.created_at, t.updated_at,
                (SELECT COUNT(*) FROM comic_prompt_versions v WHERE v.template_id = t.id),
                (SELECT v.id FROM comic_prompt_versions v
                  WHERE v.template_id = t.id AND v.is_default = 1),
                (SELECT v.version_no FROM comic_prompt_versions v
                  WHERE v.template_id = t.id AND v.is_default = 1),
                (SELECT v.content_hash FROM comic_prompt_versions v
                  WHERE v.template_id = t.id AND v.is_default = 1)
         FROM comic_prompt_templates t WHERE t.id = ?1",
        params![id],
        |row| {
            Ok(ComicPromptTemplate {
                id: row.get(0)?,
                project_id: row.get(1)?,
                name: row.get(2)?,
                category: row.get(3)?,
                description: row.get(4)?,
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
                version_count: row.get(7)?,
                default_version_id: row.get(8)?,
                default_version_no: row.get(9)?,
                default_content_hash: row.get(10)?,
            })
        },
    )
    .optional()?
    .ok_or_else(|| AppError::NotFound("提示词模板不存在或已被删除".into()))
}

pub fn comic_prompt_template_list_impl(
    db: &Db,
    project_id: &str,
) -> AppResult<Vec<ComicPromptTemplate>> {
    db.with_read(|conn| {
        ensure_comic_project(conn, project_id, false)?;
        let mut stmt = conn.prepare(
            "SELECT t.id, t.project_id, t.name, t.category, t.description,
                    t.created_at, t.updated_at,
                    (SELECT COUNT(*) FROM comic_prompt_versions v WHERE v.template_id = t.id),
                    (SELECT v.id FROM comic_prompt_versions v
                      WHERE v.template_id = t.id AND v.is_default = 1),
                    (SELECT v.version_no FROM comic_prompt_versions v
                      WHERE v.template_id = t.id AND v.is_default = 1),
                    (SELECT v.content_hash FROM comic_prompt_versions v
                      WHERE v.template_id = t.id AND v.is_default = 1)
             FROM comic_prompt_templates t
             WHERE t.project_id = ?1
             ORDER BY t.updated_at DESC, t.name COLLATE NOCASE
             LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![project_id, MAX_LIST_ROWS], |row| {
            Ok(ComicPromptTemplate {
                id: row.get(0)?,
                project_id: row.get(1)?,
                name: row.get(2)?,
                category: row.get(3)?,
                description: row.get(4)?,
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
                version_count: row.get(7)?,
                default_version_id: row.get(8)?,
                default_version_no: row.get(9)?,
                default_content_hash: row.get(10)?,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(AppError::from)?);
        }
        Ok(out)
    })
}

pub fn comic_prompt_template_save_impl(
    db: &Db,
    id: Option<String>,
    project_id: String,
    name: String,
    category: String,
    description: String,
) -> AppResult<ComicPromptTemplate> {
    let project_id = project_id.trim().to_string();
    if project_id.is_empty() {
        return Err(AppError::Validation("项目 ID 不能为空".into()));
    }
    let name = validate_text(&name, "模板名称", MAX_PROMPT_NAME_CHARS, false)?;
    let category = validate_enum(&category, "提示词分类", PROMPT_CATEGORIES)?;
    let description =
        validate_multiline_text(&description, "模板说明", MAX_LONG_TEXT_CHARS, true)?;
    let id = id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    let saved_id = db.with_transaction(|conn| {
        ensure_comic_project(conn, &project_id, true)?;
        let conflict: Option<String> = conn
            .query_row(
                "SELECT id FROM comic_prompt_templates
                 WHERE project_id = ?1 AND lower(name) = lower(?2)",
                params![project_id, name],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(existing) = conflict {
            if Some(&existing) != id.as_ref() {
                return Err(AppError::Validation(format!(
                    "模板名称「{name}」已存在，请换一个名称"
                )));
            }
        }
        let now = now_iso();
        match id {
            None => {
                let new_id = uuid::Uuid::new_v4().to_string();
                conn.execute(
                    "INSERT INTO comic_prompt_templates
                     (id, project_id, name, category, description, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
                    params![new_id, project_id, name, category, description, now],
                )?;
                Ok::<String, AppError>(new_id)
            }
            Some(id) => {
                let owner: Option<String> = conn
                    .query_row(
                        "SELECT project_id FROM comic_prompt_templates WHERE id = ?1",
                        params![id],
                        |row| row.get(0),
                    )
                    .optional()?;
                match owner {
                    Some(owner) if owner == project_id => {}
                    Some(_) => {
                        return Err(AppError::Validation("提示词模板不属于当前项目".into()));
                    }
                    None => return Err(AppError::NotFound("提示词模板不存在或已被删除".into())),
                }
                // 只更新元信息：正文永远在版本表里，改模板不能改历史正文。
                conn.execute(
                    "UPDATE comic_prompt_templates
                     SET name = ?2, category = ?3, description = ?4, updated_at = ?5
                     WHERE id = ?1 AND project_id = ?6",
                    params![id, name, category, description, now, project_id],
                )?;
                Ok::<String, AppError>(id)
            }
        }
    })?;
    db.with_read(|conn| read_prompt_template(conn, &saved_id))
}

pub fn comic_prompt_version_list_impl(
    db: &Db,
    template_id: &str,
) -> AppResult<Vec<ComicPromptVersion>> {
    db.with_read(|conn| {
        let template = read_prompt_template(conn, template_id)?;
        ensure_comic_project(conn, &template.project_id, false)?;
        let sql = format!(
            "SELECT {PROMPT_VERSION_COLUMNS} FROM comic_prompt_versions
             WHERE template_id = ?1 ORDER BY version_no DESC LIMIT ?2"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params![template_id, MAX_LIST_ROWS], row_to_prompt_version)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(AppError::from)?);
        }
        Ok(out)
    })
}

/// 创建新版本：事务内取下一个版本号、清旧默认、插入新默认。
/// 不提供任何「更新旧版本正文」的入口；`content` 原样保存（仅规范化换行）。
pub fn comic_prompt_version_create_impl(
    db: &Db,
    template_id: &str,
    content: String,
    variables_json: String,
    change_note: String,
) -> AppResult<ComicPromptVersion> {
    let template_id = template_id.trim().to_string();
    if template_id.is_empty() {
        return Err(AppError::Validation("模板 ID 不能为空".into()));
    }
    let content = validate_prompt_body(&content)?;
    // 创建即校验占位符：未知变量/未闭合不能落库，避免历史版本到渲染时才失败。
    parse_comic_prompt_template(&content, &comic_prompt_variable_set())?;
    let variables = parse_prompt_variables(&variables_json)?;
    let variables_json = serde_json::to_string(&variables)?;
    let change_note = validate_multiline_text(
        &change_note,
        "修改说明",
        MAX_CHANGE_NOTE_CHARS,
        true,
    )?;
    let content_hash = crate::capability::content_hash(content.as_bytes());

    let saved_id = db.with_transaction(|conn| {
        let template = read_prompt_template(conn, &template_id)?;
        ensure_comic_project(conn, &template.project_id, true)?;
        let next_no: i64 = conn.query_row(
            "SELECT COALESCE(MAX(version_no), 0) + 1 FROM comic_prompt_versions
             WHERE template_id = ?1",
            params![template_id],
            |row| row.get(0),
        )?;
        let now = now_iso();
        let id = uuid::Uuid::new_v4().to_string();
        // 默认版本唯一：先把同模板其它版本降级，再插入新默认版本（同一事务）。
        conn.execute(
            "UPDATE comic_prompt_versions SET is_default = 0 WHERE template_id = ?1",
            params![template_id],
        )?;
        conn.execute(
            "INSERT INTO comic_prompt_versions
             (id, template_id, version_no, content, variables_json, content_hash,
              change_note, is_default, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, ?8)",
            params![
                id,
                template_id,
                next_no,
                content,
                variables_json,
                content_hash,
                change_note,
                now
            ],
        )?;
        conn.execute(
            "UPDATE comic_prompt_templates SET updated_at = ?2 WHERE id = ?1",
            params![template_id, now],
        )?;
        Ok::<String, AppError>(id)
    })?;
    db.with_read(|conn| read_prompt_version(conn, &saved_id))
}

pub fn comic_prompt_version_set_default_impl(
    db: &Db,
    template_id: &str,
    version_id: &str,
) -> AppResult<ComicPromptVersion> {
    let template_id = template_id.trim().to_string();
    let version_id = version_id.trim().to_string();
    if template_id.is_empty() || version_id.is_empty() {
        return Err(AppError::Validation("模板与版本 ID 不能为空".into()));
    }
    db.with_transaction(|conn| {
        let version = read_prompt_version(conn, &version_id)?;
        if version.template_id != template_id {
            return Err(AppError::Validation("版本不属于该提示词模板".into()));
        }
        let template = read_prompt_template(conn, &template_id)?;
        ensure_comic_project(conn, &template.project_id, true)?;
        conn.execute(
            "UPDATE comic_prompt_versions SET is_default = 0 WHERE template_id = ?1",
            params![template_id],
        )?;
        conn.execute(
            "UPDATE comic_prompt_versions SET is_default = 1 WHERE id = ?1 AND template_id = ?2",
            params![version_id, template_id],
        )?;
        conn.execute(
            "UPDATE comic_prompt_templates SET updated_at = ?2 WHERE id = ?1",
            params![template_id, now_iso()],
        )?;
        read_prompt_version(conn, &version_id)
    })
}

// ── 提示词渲染（纯文本占位符，无模板语言）─────────────────────────────

/// 模板片段：普通文本原样保留，变量按名称替换。
enum ComicPromptSegment {
    Text(String),
    Variable(String),
}

/// 解析并校验模板占位符：未知变量、未闭合、空占位符、非法字符都在这里拒绝。
/// 创建版本与渲染共用同一套解析，避免「能存进去但渲染才炸」。
fn parse_comic_prompt_template(
    template: &str,
    allowed_variables: &BTreeSet<String>,
) -> AppResult<Vec<ComicPromptSegment>> {
    let mut segments = Vec::new();
    let mut rest = template;
    while let Some(start) = rest.find("{{") {
        if start > 0 {
            segments.push(ComicPromptSegment::Text(rest[..start].to_string()));
        }
        let after = &rest[start + 2..];
        let Some(end) = after.find("}}") else {
            return Err(AppError::Validation(
                "提示词存在未闭合的变量占位符（缺少 }}）".into(),
            ));
        };
        let name = after[..end].trim();
        if name.is_empty() {
            return Err(AppError::Validation("提示词存在空的变量占位符 {{}}".into()));
        }
        if !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_')
        {
            return Err(AppError::Validation(format!(
                "变量名「{name}」含非法字符，只允许字母、数字、下划线和小圆点"
            )));
        }
        if !allowed_variables.contains(name) {
            return Err(AppError::Validation(format!(
                "未知变量 {{{{{name}}}}}：本轮只支持 {}",
                COMIC_PROMPT_VARIABLES.join(" / ")
            )));
        }
        segments.push(ComicPromptSegment::Variable(name.to_string()));
        rest = &after[end + 2..];
    }
    if !rest.is_empty() {
        segments.push(ComicPromptSegment::Text(rest.to_string()));
    }
    Ok(segments)
}

/// 渲染提示词：只做 `{{name}}` 文本替换。
///
/// 安全边界：不 eval、不执行代码、不调用函数、不读文件；未知变量与缺失变量都返回
/// 明确校验错误；占位符之外的文本（中文、换行、缩进、标点）原样保留，不做转义。
fn render_comic_prompt_template(
    template: &str,
    variables: &BTreeMap<String, String>,
    allowed_variables: &BTreeSet<String>,
) -> AppResult<String> {
    let segments = parse_comic_prompt_template(template, allowed_variables)?;
    render_comic_prompt_segments(&segments, variables)
}

/// 按已解析片段渲染：与解析共用同一份结果，避免「解析一次、校验一次、渲染再解析」口径漂移。
fn render_comic_prompt_segments(
    segments: &[ComicPromptSegment],
    variables: &BTreeMap<String, String>,
) -> AppResult<String> {
    let mut out = String::new();
    for segment in segments {
        match segment {
            ComicPromptSegment::Text(text) => out.push_str(text),
            ComicPromptSegment::Variable(name) => {
                let Some(value) = variables.get(name) else {
                    return Err(AppError::Validation(format!("缺少变量 {name} 的值")));
                };
                out.push_str(value);
            }
        }
    }
    Ok(out)
}

/// 模板**实际用到**的变量集合（来自解析结果，而不是原始字符串匹配）。
///
/// 关键修复（v99）：`{{ shot.dialogue }}` 这类带空格的合法占位符解析后变量名会 trim，
/// 若用 `content.contains("{{shot.dialogue}}")` 判断会被误判为「未使用」，
/// 导致必填校验被绕过、空内容也能渲染。
fn prompt_segment_variables(segments: &[ComicPromptSegment]) -> BTreeSet<String> {
    segments
        .iter()
        .filter_map(|segment| match segment {
            ComicPromptSegment::Variable(name) => Some(name.clone()),
            ComicPromptSegment::Text(_) => None,
        })
        .collect()
}

/// 在连接上构建真实上下文（供预览与生成记录共用，避免两套拼装逻辑）。
fn build_comic_prompt_context_conn(
    conn: &Connection,
    project_id: &str,
    episode_id: &str,
    shot_id: Option<&str>,
) -> AppResult<ComicPromptContext> {
    let project_name: String = conn.query_row(
        "SELECT name FROM workspace_projects WHERE id = ?1",
        params![project_id],
        |row| row.get(0),
    )?;
    let episode = read_episode(conn, episode_id)?;
    if episode.project_id != project_id {
        return Err(AppError::Validation("剧集不属于当前项目".into()));
    }

    let shot = match shot_id.map(str::trim).filter(|value| !value.is_empty()) {
        None => None,
        Some(shot_id) => {
            let shot = read_shot(conn, shot_id)?;
            if shot.project_id != project_id {
                return Err(AppError::Validation("镜头不属于当前项目".into()));
            }
            if shot.episode_id != episode_id {
                return Err(AppError::Validation("镜头不属于当前剧集".into()));
            }
            Some(shot)
        }
    };

    // 角色：全局档案 + 本集覆盖合并；空覆盖不得清空基础值。
    let mut characters = Vec::new();
    for character_id in &episode.character_ids {
        let base = match read_character(conn, character_id) {
            Ok(character) => character,
            Err(AppError::NotFound(_)) => continue,
            Err(error) => return Err(error),
        };
        let override_row = read_override(conn, episode_id, character_id)?;
        let (role, appearance_label, appearance_description, costume, hair, state, visual, ref_image) =
            match &override_row {
                Some(row) => (
                    if row.role_in_episode.trim().is_empty() {
                        base.role.clone()
                    } else {
                        row.role_in_episode.clone()
                    },
                    row.appearance_label.clone(),
                    row.appearance_description.clone(),
                    row.costume_description.clone(),
                    row.hair_style_description.clone(),
                    row.state_description.clone(),
                    row.visual_prompt_override.clone(),
                    if row.ref_image_path.trim().is_empty() {
                        base.ref_image_path.clone()
                    } else {
                        row.ref_image_path.clone()
                    },
                ),
                None => (
                    base.role.clone(),
                    String::new(),
                    String::new(),
                    String::new(),
                    String::new(),
                    String::new(),
                    String::new(),
                    base.ref_image_path.clone(),
                ),
            };
        characters.push(ComicPromptContextCharacter {
            id: base.id.clone(),
            name: base.name.clone(),
            role,
            base_description: base.description.clone(),
            appearance_label,
            appearance_description,
            costume_description: costume,
            hair_style_description: hair,
            state_description: state,
            visual_prompt_override: visual,
            ref_image_path: ref_image,
            using_override: override_row.is_some(),
        });
    }

    let mut block_lines: Vec<String> = Vec::new();
    for character in &characters {
        let mut lines = vec![format!("【角色】{}", character.name)];
        if !character.role.trim().is_empty() {
            lines.push(format!("定位：{}", character.role.trim()));
        }
        if !character.base_description.trim().is_empty() {
            lines.push(format!("基础设定：{}", character.base_description.trim()));
        }
        if !character.appearance_label.trim().is_empty() {
            lines.push(format!("本集形象：{}", character.appearance_label.trim()));
        }
        if !character.appearance_description.trim().is_empty() {
            lines.push(format!("本集外貌：{}", character.appearance_description.trim()));
        }
        if !character.costume_description.trim().is_empty() {
            lines.push(format!("本集服装：{}", character.costume_description.trim()));
        }
        if !character.hair_style_description.trim().is_empty() {
            lines.push(format!("本集发型：{}", character.hair_style_description.trim()));
        }
        if !character.state_description.trim().is_empty() {
            lines.push(format!("本集状态：{}", character.state_description.trim()));
        }
        if !character.visual_prompt_override.trim().is_empty() {
            lines.push(format!(
                "本集视觉提示词补充：{}",
                character.visual_prompt_override.trim()
            ));
        }
        if !character.ref_image_path.trim().is_empty() {
            lines.push(REFERENCE_IMAGE_BLOCK_LINE.to_string());
        }
        block_lines.push(lines.join("\n"));
    }
    let characters_block = block_lines.join("\n\n");

    // 场景：有镜头时只装配该镜头场景；剧集级（无镜头）装配项目全部场景。
    let scenes = if let Some(shot) = shot.as_ref() {
        match shot.scene_id.as_deref() {
            Some(scene_id) => vec![read_scene(conn, scene_id)?],
            None => Vec::new(),
        }
    } else {
        comic_scene_list_conn(conn, project_id)?
    };
    let scene_block = scenes
        .iter()
        .map(|scene| {
            let mut lines = vec![format!("【场景】{}", scene.name)];
            if !scene.description.trim().is_empty() {
                lines.push(format!("设定：{}", scene.description.trim()));
            }
            if !scene.ref_image_path.trim().is_empty() {
                lines.push(REFERENCE_IMAGE_BLOCK_LINE.to_string());
            }
            lines.join("\n")
        })
        .collect::<Vec<_>>()
        .join("\n\n");

    let mut variables = BTreeMap::new();
    variables.insert("project.name".to_string(), project_name);
    variables.insert("episode.title".to_string(), episode.title.clone());
    variables.insert("episode.synopsis".to_string(), episode.synopsis.clone());
    variables.insert("episode.script".to_string(), episode.script.clone());
    variables.insert("characters.block".to_string(), characters_block);
    variables.insert("scene.block".to_string(), scene_block);
    variables.insert(
        "shot.description".to_string(),
        shot.as_ref().map(|item| item.description.clone()).unwrap_or_default(),
    );
    variables.insert(
        "shot.dialogue".to_string(),
        shot.as_ref().map(|item| item.dialogue.clone()).unwrap_or_default(),
    );
    variables.insert(
        "shot.shot_size".to_string(),
        shot.as_ref().map(|item| item.shot_size.clone()).unwrap_or_default(),
    );
    variables.insert(
        "shot.camera_move".to_string(),
        shot.as_ref().map(|item| item.camera_move.clone()).unwrap_or_default(),
    );

    Ok(ComicPromptContext {
        project_id: project_id.to_string(),
        episode_id: episode_id.to_string(),
        shot_id: shot.as_ref().map(|item| item.id.clone()),
        variables,
        characters,
        scenes: scenes
            .into_iter()
            .map(|scene| ComicPromptContextScene {
                id: scene.id,
                name: scene.name,
                description: scene.description,
                ref_image_path: scene.ref_image_path,
            })
            .collect(),
        shot: shot.map(|item| ComicPromptContextShot {
            id: item.id,
            shot_no: item.shot_no,
            description: item.description,
        }),
    })
}

fn comic_scene_list_conn(conn: &Connection, project_id: &str) -> AppResult<Vec<ComicScene>> {
    let mut stmt = conn.prepare(
        "SELECT id, project_id, name, description, ref_image_path, sort_order,
                created_at, updated_at
         FROM comic_scenes WHERE project_id = ?1
         ORDER BY sort_order, created_at, id LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![project_id, MAX_LIST_ROWS], row_to_scene)?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(AppError::from)?);
    }
    Ok(out)
}

/// 同一模板的版本渲染：校验归属 → 构建上下文 → 必填检查 → 渲染。
fn render_prompt_version_conn(
    conn: &Connection,
    project_id: &str,
    version: &ComicPromptVersion,
    episode_id: &str,
    shot_id: Option<&str>,
) -> AppResult<ComicPromptPreview> {
    let template = read_prompt_template(conn, &version.template_id)?;
    if template.project_id != project_id {
        return Err(AppError::Validation("提示词版本不属于当前项目".into()));
    }
    let context = build_comic_prompt_context_conn(conn, project_id, episode_id, shot_id)?;
    let required = parse_prompt_variables(&version.variables_json)?;
    let allowed = comic_prompt_variable_set();
    // 只解析一次：必填校验与渲染共用同一份片段集合。
    let segments = parse_comic_prompt_template(&version.content, &allowed)?;
    let used_variables = prompt_segment_variables(&segments);
    for name in &required {
        // 只对「模板里真正用到的」必填变量做空值检查：声明了但没用到不影响渲染。
        if !used_variables.contains(name.as_str()) {
            continue;
        }
        let empty = context
            .variables
            .get(name)
            .map(|value| value.trim().is_empty())
            .unwrap_or(true);
        if empty {
            return Err(AppError::Validation(format!(
                "必填变量「{name}」在当前剧集/镜头没有内容，无法渲染"
            )));
        }
    }
    let rendered = render_comic_prompt_segments(&segments, &context.variables)?;
    Ok(ComicPromptPreview {
        prompt_version_id: version.id.clone(),
        template_id: template.id,
        template_name: template.name,
        version_no: version.version_no,
        content_hash: version.content_hash.clone(),
        required_variables: required,
        rendered,
        context,
    })
}

pub fn build_comic_prompt_context_impl(
    db: &Db,
    project_id: &str,
    episode_id: &str,
    shot_id: Option<&str>,
) -> AppResult<ComicPromptContext> {
    db.with_read(|conn| {
        ensure_comic_project(conn, project_id, false)?;
        ensure_episode_belongs(conn, project_id, episode_id)?;
        build_comic_prompt_context_conn(conn, project_id, episode_id, shot_id)
    })
}

/// 渲染预览是只读操作：不写库、不改版本、不产生生成记录。
pub fn comic_prompt_render_impl(
    db: &Db,
    project_id: &str,
    prompt_version_id: &str,
    episode_id: &str,
    shot_id: Option<&str>,
) -> AppResult<ComicPromptPreview> {
    let project_id = project_id.trim().to_string();
    if project_id.is_empty() {
        return Err(AppError::Validation("项目 ID 不能为空".into()));
    }
    db.with_read(|conn| {
        ensure_comic_project(conn, &project_id, false)?;
        ensure_episode_belongs(conn, &project_id, episode_id)?;
        let version = read_prompt_version(conn, prompt_version_id)?;
        render_prompt_version_conn(conn, &project_id, &version, episode_id, shot_id)
    })
}

// ── Skill 不可变内容快照（v96）────────────────────────────────────────

fn skill_scope_allows_project(summary: &crate::capability::skills::SkillSummary, project_id: &str) -> bool {
    let access = crate::capability::skills::SkillAccessContext {
        project_id: Some(project_id),
        // 工作区级 Skill 复用 workspace_projects.id；当前漫剧项目本身就是该工作区。
        workspace_id: Some(project_id),
        agent_row_id: None,
    };
    crate::capability::skills::is_applicable(
        &summary.scope,
        summary.project_id.as_deref(),
        summary.workspace_id.as_deref(),
        summary.agent_id.as_deref(),
        &access,
    )
}

/// 保存文件清单：路径 + 是否目录 + 大小 + 可读文件的 SHA-256。
///
/// 本轮只有 SKILL.md 正文会被装配进提示词上下文，附属文件不装配；
/// 因此这里保存不可变指纹而不是整包文件内容，避免把 64 MiB 目录塞进数据库。
fn build_skill_files_manifest(
    dir: &Path,
    files: &[crate::capability::skills::SkillFile],
) -> String {
    let mut out = Vec::new();
    let mut budget = MAX_SKILL_MANIFEST_TOTAL_BYTES;
    for file in files.iter().take(MAX_SKILL_MANIFEST_FILES) {
        let mut entry = serde_json::Map::new();
        entry.insert("path".into(), serde_json::Value::String(file.path.clone()));
        entry.insert("isDir".into(), serde_json::Value::Bool(file.is_dir));
        entry.insert("sizeBytes".into(), serde_json::Value::from(file.size_bytes));
        if !file.is_dir {
            let size = if file.size_bytes > 0 {
                file.size_bytes as u64
            } else {
                0
            };
            if file.size_bytes < 0 || size > MAX_SKILL_MANIFEST_FILE_BYTES {
                entry.insert("sha256".into(), serde_json::Value::Null);
                entry.insert("skipped".into(), serde_json::Value::String("too_large".into()));
            } else if size > budget {
                entry.insert("sha256".into(), serde_json::Value::Null);
                entry.insert(
                    "skipped".into(),
                    serde_json::Value::String("budget_exhausted".into()),
                );
            } else {
                match std::fs::read(dir.join(&file.path)) {
                    Ok(bytes) => {
                        budget = budget.saturating_sub(bytes.len() as u64);
                        entry.insert(
                            "sha256".into(),
                            serde_json::Value::String(crate::capability::content_hash(&bytes)),
                        );
                    }
                    Err(_) => {
                        entry.insert("sha256".into(), serde_json::Value::Null);
                        entry.insert(
                            "skipped".into(),
                            serde_json::Value::String("unreadable".into()),
                        );
                    }
                }
            }
        }
        out.push(serde_json::Value::Object(entry));
    }
    serde_json::to_string(&out).unwrap_or_else(|_| "[]".to_string())
}

/// 完整快照指纹（v99）：规范化 JSON 数组 `[来源 Skill, 正文 Hash, 声明版本, 附属清单 Hash]`。
///
/// 用 JSON 数组而不是分隔符拼接，避免字段本身含分隔符时产生歧义；
/// 迁移 v99 对历史行用相同的 `json_array(...)` 口径回填（历史行附属清单 Hash 记空串，
/// 因为没有在旧行上重新计算，也不允许猜测）。
fn skill_snapshot_fingerprint(
    source_skill_id: &str,
    content_hash: &str,
    declared_version: &str,
    files_manifest_hash: &str,
) -> AppResult<String> {
    serde_json::to_string(&[
        source_skill_id,
        content_hash,
        declared_version,
        files_manifest_hash,
    ])
    .map_err(|_| AppError::Validation("Skill 快照指纹计算失败".into()))
}

fn row_to_skill_snapshot(row: &rusqlite::Row<'_>) -> rusqlite::Result<ComicSkillSnapshot> {
    let manifest: String = row.get("files_manifest_json")?;
    let file_count = serde_json::from_str::<serde_json::Value>(&manifest)
        .ok()
        .and_then(|value| {
            value.as_array().map(|items| {
                items
                    .iter()
                    .filter(|item| {
                        item.get("isDir").and_then(|flag| flag.as_bool()) != Some(true)
                    })
                    .count() as i64
            })
        })
        .unwrap_or(0);
    Ok(ComicSkillSnapshot {
        id: row.get("id")?,
        project_id: row.get("project_id")?,
        source_skill_id: row.get("source_skill_id")?,
        skill_name: row.get("skill_name")?,
        declared_version: row.get("declared_version")?,
        content_hash: row.get("content_hash")?,
        content_snapshot: row.get("content_snapshot")?,
        files_manifest_json: manifest,
        files_manifest_hash: row.get("files_manifest_hash")?,
        snapshot_fingerprint: row.get("snapshot_fingerprint")?,
        file_count,
        created_at: row.get("created_at")?,
    })
}

const SKILL_SNAPSHOT_COLUMNS: &str = "id, project_id, source_skill_id, skill_name, declared_version, \
    content_hash, content_snapshot, files_manifest_json, files_manifest_hash, \
    snapshot_fingerprint, created_at";

fn read_skill_snapshot(conn: &Connection, id: &str) -> AppResult<ComicSkillSnapshot> {
    let sql = format!(
        "SELECT {SKILL_SNAPSHOT_COLUMNS} FROM comic_skill_snapshots WHERE id = ?1"
    );
    conn.query_row(&sql, params![id], row_to_skill_snapshot)
        .optional()?
        .ok_or_else(|| AppError::NotFound("Skill 快照不存在或已被删除".into()))
}

/// 捕获 Skill 当前内容为不可变快照。
///
/// 身份判定（v99）不再只看正文 Hash：`snapshot_fingerprint` 由
/// 「来源 Skill + 正文 Hash + SKILL.md 声明版本 + 附属文件清单 Hash」规范化组成。
/// 因此只改声明版本、或只改附属文件，也会产出新的快照行，不会复用带着旧元数据的记录；
/// 四项都相同才复用（幂等）。历史快照只追加、不更新。
///
/// 注意：本轮只有 SKILL.md 正文装配进上下文；附属文件只保存清单指纹，不保存正文，
/// 也不参与模型调用——不要在文案或记录里宣称附件正文已被快照。
pub fn comic_skill_snapshot_capture_impl(
    db: &Db,
    project_id: &str,
    skill_id: &str,
) -> AppResult<ComicSkillSnapshot> {
    let project_id = project_id.trim().to_string();
    let skill_id = skill_id.trim().to_string();
    if project_id.is_empty() || skill_id.is_empty() {
        return Err(AppError::Validation("项目与 Skill ID 不能为空".into()));
    }
    db.with_read(|conn| ensure_comic_project(conn, &project_id, true))?;
    let detail = crate::capability::skills::get_impl(db, &skill_id)?;
    let summary = detail.summary;
    if !summary.enabled {
        return Err(AppError::Validation(
            "Skill 已禁用，不能捕获为可用版本；请先在能力中心启用".into(),
        ));
    }
    if summary.missing {
        return Err(AppError::Validation(
            "Skill 文件已丢失，不能捕获；请先在能力中心重新扫描或重新导入".into(),
        ));
    }
    if !skill_scope_allows_project(&summary, &project_id) {
        return Err(AppError::Validation(
            "该 Skill 的作用域不允许当前项目使用".into(),
        ));
    }
    // 来源目录必须是绝对路径：否则 `get_impl` 会把进程当前目录当 Skill 目录扫描，
    // 文件清单可能混入无关文件名。内容已在库内，缺失目录只影响附属文件指纹。
    if summary.source_path.trim().is_empty() || !Path::new(&summary.source_path).is_absolute() {
        return Err(AppError::Validation(
            "Skill 来源目录无效（必须是绝对路径），不能捕获快照".into(),
        ));
    }
    if detail.content.len() > MAX_SKILL_SNAPSHOT_BYTES {
        return Err(AppError::Validation(format!(
            "Skill 正文超过 {} KiB，无法保存快照",
            MAX_SKILL_SNAPSHOT_BYTES / 1024
        )));
    }
    let content_hash = crate::capability::content_hash(detail.content.as_bytes());
    let manifest = build_skill_files_manifest(Path::new(&summary.source_path), &detail.files);
    let files_manifest_hash = crate::capability::content_hash(manifest.as_bytes());
    let source_skill_id = summary.id.clone();
    let skill_name = summary.name.clone();
    let declared_version = summary.version.clone();
    let snapshot_fingerprint = skill_snapshot_fingerprint(
        &source_skill_id,
        &content_hash,
        &declared_version,
        &files_manifest_hash,
    )?;

    db.with_transaction(|conn| {
        ensure_comic_project(conn, &project_id, true)?;
        let existing: Option<String> = conn
            .query_row(
                "SELECT id FROM comic_skill_snapshots
                 WHERE project_id = ?1 AND source_skill_id = ?2 AND snapshot_fingerprint = ?3",
                params![project_id, source_skill_id, snapshot_fingerprint],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(id) = existing {
            return read_skill_snapshot(conn, &id);
        }
        let id = uuid::Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO comic_skill_snapshots
             (id, project_id, source_skill_id, skill_name, declared_version, content_hash,
              content_snapshot, files_manifest_json, files_manifest_hash, snapshot_fingerprint,
              created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                id,
                project_id,
                source_skill_id,
                skill_name,
                declared_version,
                content_hash,
                detail.content,
                manifest,
                files_manifest_hash,
                snapshot_fingerprint,
                now_iso()
            ],
        )?;
        read_skill_snapshot(conn, &id)
    })
}

pub fn comic_skill_snapshot_list_impl(
    db: &Db,
    project_id: &str,
    skill_id: Option<&str>,
) -> AppResult<Vec<ComicSkillSnapshot>> {
    db.with_read(|conn| {
        ensure_comic_project(conn, project_id, false)?;
        let skill_id = skill_id.map(str::trim).filter(|value| !value.is_empty());
        let sql = format!(
            "SELECT {SKILL_SNAPSHOT_COLUMNS} FROM comic_skill_snapshots
             WHERE project_id = ?1 AND (?2 IS NULL OR source_skill_id = ?2)
             ORDER BY created_at DESC, id DESC LIMIT ?3"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(
            params![project_id, skill_id, MAX_LIST_ROWS],
            row_to_skill_snapshot,
        )?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(AppError::from)?);
        }
        Ok(out)
    })
}

pub fn comic_skill_snapshot_get_impl(db: &Db, snapshot_id: &str) -> AppResult<ComicSkillSnapshot> {
    db.with_read(|conn| {
        let snapshot = read_skill_snapshot(conn, snapshot_id)?;
        ensure_comic_project(conn, &snapshot.project_id, false)?;
        Ok(snapshot)
    })
}

// ── 外部生成记录（v96）────────────────────────────────────────────────

const GENERATION_RUN_COLUMNS: &str = "r.id, r.project_id, r.episode_id, e.title AS episode_title, \
    r.shot_id, s.shot_no AS shot_no, r.prompt_version_id, t.name AS template_name, \
    v.version_no AS version_no, r.prompt_content_hash_snapshot, r.skill_snapshot_id, \
    k.skill_name AS skill_name, \
    k.declared_version AS skill_declared_version, r.rendered_prompt_snapshot, \
    r.context_snapshot_json, r.skill_content_hash_snapshot, r.model_provider, r.model_name, \
    r.model_version, r.parameters_json, r.seed, r.input_media_ids_json, r.external_job_id, \
    r.note, r.created_at, \
    (SELECT COALESCE(json_group_array(m.id), '[]') FROM comic_media_versions m \
      WHERE m.generation_run_id = r.id) AS output_media_ids_json";

const GENERATION_RUN_JOINS: &str = "FROM comic_generation_runs r \
    JOIN comic_episodes e ON e.id = r.episode_id \
    JOIN comic_prompt_versions v ON v.id = r.prompt_version_id \
    JOIN comic_prompt_templates t ON t.id = v.template_id \
    LEFT JOIN comic_shots s ON s.id = r.shot_id \
    LEFT JOIN comic_skill_snapshots k ON k.id = r.skill_snapshot_id";

fn row_to_generation_run(row: &rusqlite::Row<'_>) -> rusqlite::Result<ComicGenerationRun> {
    let media_ids_json: String = row.get("input_media_ids_json")?;
    let output_media_ids_json: String = row.get("output_media_ids_json")?;
    Ok(ComicGenerationRun {
        id: row.get("id")?,
        project_id: row.get("project_id")?,
        episode_id: row.get("episode_id")?,
        episode_title: row.get("episode_title")?,
        shot_id: row.get("shot_id")?,
        shot_no: row.get("shot_no")?,
        prompt_version_id: row.get("prompt_version_id")?,
        prompt_template_name: row.get("template_name")?,
        prompt_version_no: row.get("version_no")?,
        prompt_content_hash_snapshot: row.get("prompt_content_hash_snapshot")?,
        skill_snapshot_id: row.get("skill_snapshot_id")?,
        skill_name: row.get("skill_name")?,
        skill_declared_version: row.get("skill_declared_version")?,
        rendered_prompt_snapshot: row.get("rendered_prompt_snapshot")?,
        context_snapshot_json: row.get("context_snapshot_json")?,
        skill_content_hash_snapshot: row.get("skill_content_hash_snapshot")?,
        model_provider: row.get("model_provider")?,
        model_name: row.get("model_name")?,
        model_version: row.get("model_version")?,
        parameters_json: row.get("parameters_json")?,
        seed: row.get("seed")?,
        input_media_ids: parse_id_array(&media_ids_json),
        output_media_ids: parse_id_array(&output_media_ids_json),
        external_job_id: row.get("external_job_id")?,
        note: row.get("note")?,
        created_at: row.get("created_at")?,
    })
}

fn read_generation_run(conn: &Connection, id: &str) -> AppResult<ComicGenerationRun> {
    let sql = format!("SELECT {GENERATION_RUN_COLUMNS} {GENERATION_RUN_JOINS} WHERE r.id = ?1");
    conn.query_row(&sql, params![id], row_to_generation_run)
        .optional()?
        .ok_or_else(|| AppError::NotFound("生成记录不存在或已被删除".into()))
}

/// 生成记录附带的上下文摘要（v99）：只保存「当时用了哪些角色/场景/镜头」，
/// 不复制剧本正文等大字段。参考图路径属于本地库内数据，可供本机界面核对；
/// 它不会进入提示词正文（参考图在提示词里只用固定占位说明）。
fn build_comic_context_snapshot_json(context: &ComicPromptContext) -> String {
    let truncated =
        context.characters.len() > MAX_CONTEXT_SNAPSHOT_ITEMS
            || context.scenes.len() > MAX_CONTEXT_SNAPSHOT_ITEMS;
    let characters: Vec<serde_json::Value> = context
        .characters
        .iter()
        .take(MAX_CONTEXT_SNAPSHOT_ITEMS)
        .map(|character| {
            serde_json::json!({
                "id": character.id,
                "name": character.name,
                "role": character.role,
                "usingOverride": character.using_override,
                "visualPromptOverride": character.visual_prompt_override,
                "refImagePath": character.ref_image_path,
            })
        })
        .collect();
    let scenes: Vec<serde_json::Value> = context
        .scenes
        .iter()
        .take(MAX_CONTEXT_SNAPSHOT_ITEMS)
        .map(|scene| {
            serde_json::json!({
                "id": scene.id,
                "name": scene.name,
                "refImagePath": scene.ref_image_path,
            })
        })
        .collect();
    serde_json::json!({
        "projectId": context.project_id,
        "episodeId": context.episode_id,
        "shotId": context.shot_id,
        "characters": characters,
        "scenes": scenes,
        "shot": context.shot.as_ref().map(|shot| serde_json::json!({
            "id": shot.id,
            "shotNo": shot.shot_no,
        })),
        "variableKeys": context.variables.keys().collect::<Vec<_>>(),
        "truncated": truncated,
    })
    .to_string()
}

/// 登记一次真实发生的外部生成。
///
/// 追溯原则（v99）：提示词快照 = 用户提交的「外部工具实际收到的文本」，
/// 后端不再重新渲染并覆盖它；只校验归属（项目/剧集/镜头/版本）与长度，
/// 中文、换行、标点原样保存，超限直接报错而不是静默截断。
/// Skill 只保存内容 Hash 与快照外键，不复制正文。
pub fn comic_generation_record_create_impl(
    db: &Db,
    input: ComicGenerationRecordInput,
) -> AppResult<ComicGenerationRun> {
    let project_id = input.project_id.trim().to_string();
    let episode_id = input.episode_id.trim().to_string();
    if project_id.is_empty() || episode_id.is_empty() {
        return Err(AppError::Validation("项目与剧集不能为空".into()));
    }
    let prompt_version_id = input.prompt_version_id.trim().to_string();
    if prompt_version_id.is_empty() {
        return Err(AppError::Validation(
            "必须选择本次生成使用的提示词版本（可追溯性要求）".into(),
        ));
    }
    let shot_id = input
        .shot_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let skill_snapshot_id = input
        .skill_snapshot_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let model_provider =
        validate_text(&input.model_provider, "模型提供商", MAX_MODEL_FIELD_CHARS, true)?;
    let model_name = validate_text(&input.model_name, "模型名称", MAX_MODEL_FIELD_CHARS, true)?;
    let model_version =
        validate_text(&input.model_version, "模型版本", MAX_MODEL_FIELD_CHARS, true)?;
    let seed = validate_text(&input.seed, "随机种子", MAX_SEED_CHARS, true)?;
    let external_job_id = validate_text(
        &input.external_job_id,
        "外部任务 ID",
        MAX_EXTERNAL_JOB_CHARS,
        true,
    )?;
    let note = validate_multiline_text(&input.note, "生成备注", MAX_GENERATION_NOTE_CHARS, true)?;
    let parameters_json = validate_parameters_json(input.parameters_json.as_deref())?;
    let input_media_ids = validate_id_list(input.input_media_ids, "输入素材", MAX_REF_COUNT)?;
    let rendered_prompt_snapshot = validate_prompt_body(&input.rendered_prompt_snapshot)
        .map_err(|_| {
            AppError::Validation(
                "实际使用的提示词不能为空、不能超过长度上限，也不能含非法控制字符".into(),
            )
        })?;

    db.with_transaction(|conn| {
        ensure_comic_project(conn, &project_id, true)?;
        ensure_episode_belongs(conn, &project_id, &episode_id)?;
        if let Some(shot_id) = shot_id.as_deref() {
            ensure_shot_belongs(conn, &project_id, shot_id)?;
            let shot_episode: String = conn.query_row(
                "SELECT episode_id FROM comic_shots WHERE id = ?1",
                params![shot_id],
                |row| row.get(0),
            )?;
            if shot_episode != episode_id {
                return Err(AppError::Validation(
                    "生成记录的镜头不属于所选剧集".into(),
                ));
            }
        }
        for media_id in &input_media_ids {
            let owner: Option<String> = conn
                .query_row(
                    "SELECT project_id FROM comic_media_versions WHERE id = ?1",
                    params![media_id],
                    |row| row.get(0),
                )
                .optional()?;
            match owner {
                Some(owner) if owner == project_id => {}
                Some(_) => {
                    return Err(AppError::Validation("输入素材不属于当前项目".into()));
                }
                None => return Err(AppError::Validation("输入素材不存在".into())),
            }
        }
        let version = read_prompt_version(conn, &prompt_version_id)?;
        let template = read_prompt_template(conn, &version.template_id)?;
        if template.project_id != project_id {
            return Err(AppError::Validation("提示词版本不属于当前项目".into()));
        }
        // 只为上下文摘要读取真实数据；提示词正文用用户提交的实际内容，绝不重新渲染覆盖。
        let context =
            build_comic_prompt_context_conn(conn, &project_id, &episode_id, shot_id.as_deref())?;
        let context_snapshot_json = build_comic_context_snapshot_json(&context);
        let prompt_content_hash_snapshot = version.content_hash.clone();
        let (skill_hash, snapshot_project) = match skill_snapshot_id.as_deref() {
            Some(snapshot_id) => {
                let snapshot = read_skill_snapshot(conn, snapshot_id)?;
                (snapshot.content_hash, Some(snapshot.project_id))
            }
            None => (String::new(), None),
        };
        if let Some(snapshot_project) = snapshot_project {
            if snapshot_project != project_id {
                return Err(AppError::Validation(
                    "Skill 快照不属于当前项目".into(),
                ));
            }
        }
        let id = uuid::Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO comic_generation_runs
             (id, project_id, episode_id, shot_id, prompt_version_id,
              prompt_content_hash_snapshot, skill_snapshot_id, rendered_prompt_snapshot,
              context_snapshot_json, skill_content_hash_snapshot, model_provider,
              model_name, model_version, parameters_json, seed, input_media_ids_json,
              external_job_id, note, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16,
                     ?17, ?18, ?19)",
            params![
                id,
                project_id,
                episode_id,
                shot_id,
                prompt_version_id,
                prompt_content_hash_snapshot,
                skill_snapshot_id,
                rendered_prompt_snapshot,
                context_snapshot_json,
                skill_hash,
                model_provider,
                model_name,
                model_version,
                parameters_json,
                seed,
                serialize_id_array(&input_media_ids)?,
                external_job_id,
                note,
                now_iso()
            ],
        )?;
        read_generation_run(conn, &id)
    })
}

pub fn comic_generation_record_list_impl(
    db: &Db,
    project_id: &str,
    episode_id: Option<&str>,
    shot_id: Option<&str>,
) -> AppResult<Vec<ComicGenerationRun>> {
    db.with_read(|conn| {
        ensure_comic_project(conn, project_id, false)?;
        let episode_id = episode_id.map(str::trim).filter(|value| !value.is_empty());
        let shot_id = shot_id.map(str::trim).filter(|value| !value.is_empty());
        if let Some(episode_id) = episode_id {
            ensure_episode_belongs(conn, project_id, episode_id)?;
        }
        if let Some(shot_id) = shot_id {
            ensure_shot_belongs(conn, project_id, shot_id)?;
        }
        let sql = format!(
            "SELECT {GENERATION_RUN_COLUMNS} {GENERATION_RUN_JOINS}
             WHERE r.project_id = ?1 AND (?2 IS NULL OR r.episode_id = ?2)
               AND (?3 IS NULL OR r.shot_id = ?3)
             ORDER BY r.created_at DESC, r.id DESC LIMIT ?4"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(
            params![project_id, episode_id, shot_id, MAX_LIST_ROWS],
            row_to_generation_run,
        )?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(AppError::from)?);
        }
        Ok(out)
    })
}

// ── 薄包装（注册进 lib.rs 由集成负责人完成） ─────────────────────────────

#[tauri::command]
pub fn comic_episode_list(
    db: State<'_, Arc<Db>>,
    project_id: String,
) -> AppResult<ComicEpisodeList> {
    Ok(ComicEpisodeList {
        episodes: comic_episode_list_impl(&db, &project_id)?,
    })
}

#[tauri::command]
pub fn comic_episode_get(db: State<'_, Arc<Db>>, id: String) -> AppResult<ComicEpisodeGot> {
    Ok(ComicEpisodeGot {
        episode: comic_episode_get_impl(&db, &id)?,
    })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn comic_episode_save(
    db: State<'_, Arc<Db>>,
    id: Option<String>,
    project_id: String,
    episode_no: Option<i64>,
    title: String,
    synopsis: String,
    script: String,
    status: String,
    progress: i64,
    character_ids: Option<Vec<String>>,
    sort_order: Option<i64>,
) -> AppResult<ComicEpisodeSaved> {
    Ok(ComicEpisodeSaved {
        episode: comic_episode_save_impl(
            &db,
            id,
            project_id,
            episode_no,
            title,
            synopsis,
            script,
            status,
            progress,
            character_ids,
            sort_order,
        )?,
    })
}

#[tauri::command]
pub fn comic_episode_delete(db: State<'_, Arc<Db>>, id: String) -> AppResult<ComicOk> {
    comic_episode_delete_impl(&db, &id)?;
    Ok(ComicOk { ok: true })
}

#[tauri::command]
pub fn comic_episode_reorder(
    db: State<'_, Arc<Db>>,
    project_id: String,
    episode_ids: Vec<String>,
) -> AppResult<ComicEpisodeList> {
    Ok(ComicEpisodeList {
        episodes: comic_episode_reorder_impl(&db, &project_id, episode_ids)?,
    })
}

#[tauri::command]
pub fn comic_shot_list(
    db: State<'_, Arc<Db>>,
    project_id: String,
    episode_id: Option<String>,
) -> AppResult<ComicShotList> {
    Ok(ComicShotList {
        shots: comic_shot_list_impl(&db, &project_id, episode_id)?,
    })
}

#[tauri::command]
pub fn comic_shot_get(db: State<'_, Arc<Db>>, id: String) -> AppResult<ComicShotGot> {
    Ok(ComicShotGot {
        shot: comic_shot_get_impl(&db, &id)?,
    })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn comic_shot_save(
    db: State<'_, Arc<Db>>,
    id: Option<String>,
    project_id: String,
    episode_id: String,
    shot_no: Option<i64>,
    description: String,
    character_ids: Option<Vec<String>>,
    scene_id: Option<String>,
    dialogue: String,
    shot_size: String,
    camera_move: String,
    duration_sec: Option<f64>,
    status: String,
    asset_refs: Option<Vec<String>>,
    note: String,
    sort_order: Option<i64>,
) -> AppResult<ComicShotSaved> {
    Ok(ComicShotSaved {
        shot: comic_shot_save_impl(
            &db,
            id,
            project_id,
            episode_id,
            shot_no,
            description,
            character_ids,
            scene_id,
            dialogue,
            shot_size,
            camera_move,
            duration_sec,
            status,
            asset_refs,
            note,
            sort_order,
        )?,
    })
}

#[tauri::command]
pub fn comic_shot_delete(db: State<'_, Arc<Db>>, id: String) -> AppResult<ComicOk> {
    comic_shot_delete_impl(&db, &id)?;
    Ok(ComicOk { ok: true })
}

#[tauri::command]
pub fn comic_shot_reorder(
    db: State<'_, Arc<Db>>,
    project_id: String,
    episode_id: String,
    shot_ids: Vec<String>,
) -> AppResult<ComicShotList> {
    Ok(ComicShotList {
        shots: comic_shot_reorder_impl(&db, &project_id, &episode_id, shot_ids)?,
    })
}

#[tauri::command]
pub fn comic_character_list(
    db: State<'_, Arc<Db>>,
    project_id: String,
) -> AppResult<ComicCharacterList> {
    Ok(ComicCharacterList {
        characters: comic_character_list_impl(&db, &project_id)?,
    })
}

#[tauri::command]
pub fn comic_character_save(
    db: State<'_, Arc<Db>>,
    id: Option<String>,
    project_id: String,
    name: String,
    role: String,
    description: String,
    ref_image_path: Option<String>,
    sort_order: Option<i64>,
) -> AppResult<ComicCharacterSaved> {
    Ok(ComicCharacterSaved {
        character: comic_character_save_impl(
            &db,
            id,
            project_id,
            name,
            role,
            description,
            ref_image_path,
            sort_order,
        )?,
    })
}

#[tauri::command]
pub fn comic_character_delete(db: State<'_, Arc<Db>>, id: String) -> AppResult<ComicOk> {
    comic_character_delete_impl(&db, &id)?;
    Ok(ComicOk { ok: true })
}

#[tauri::command]
pub fn comic_scene_list(
    db: State<'_, Arc<Db>>,
    project_id: String,
) -> AppResult<ComicSceneList> {
    Ok(ComicSceneList {
        scenes: comic_scene_list_impl(&db, &project_id)?,
    })
}

#[tauri::command]
pub fn comic_scene_save(
    db: State<'_, Arc<Db>>,
    id: Option<String>,
    project_id: String,
    name: String,
    description: String,
    ref_image_path: Option<String>,
    sort_order: Option<i64>,
) -> AppResult<ComicSceneSaved> {
    Ok(ComicSceneSaved {
        scene: comic_scene_save_impl(
            &db,
            id,
            project_id,
            name,
            description,
            ref_image_path,
            sort_order,
        )?,
    })
}

#[tauri::command]
pub fn comic_scene_delete(db: State<'_, Arc<Db>>, id: String) -> AppResult<ComicOk> {
    comic_scene_delete_impl(&db, &id)?;
    Ok(ComicOk { ok: true })
}

#[tauri::command]
pub fn comic_media_list(
    db: State<'_, Arc<Db>>,
    project_id: String,
    shot_id: Option<String>,
) -> AppResult<ComicMediaList> {
    Ok(ComicMediaList {
        versions: comic_media_list_impl(&db, &project_id, shot_id)?,
    })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn comic_media_import(
    db: State<'_, Arc<Db>>,
    id: Option<String>,
    project_id: String,
    shot_id: Option<String>,
    character_id: Option<String>,
    scene_id: Option<String>,
    file_path: String,
    media_kind: String,
    version_label: Option<String>,
    review_note: Option<String>,
    generation_run_id: Option<String>,
) -> AppResult<ComicMediaSaved> {
    Ok(ComicMediaSaved {
        version: comic_media_import_with_run_impl(
            &db,
            id,
            project_id,
            shot_id,
            character_id,
            scene_id,
            file_path,
            media_kind,
            version_label,
            review_note,
            generation_run_id,
        )?,
    })
}

#[tauri::command]
pub fn comic_media_save(
    db: State<'_, Arc<Db>>,
    id: String,
    version_label: Option<String>,
    status: Option<String>,
    review_note: Option<String>,
) -> AppResult<ComicMediaSaved> {
    Ok(ComicMediaSaved {
        version: comic_media_save_impl(&db, &id, version_label, status, review_note)?,
    })
}

#[tauri::command]
pub fn comic_media_adopt(db: State<'_, Arc<Db>>, id: String) -> AppResult<ComicMediaSaved> {
    Ok(ComicMediaSaved {
        version: comic_media_adopt_impl(&db, &id)?,
    })
}

#[tauri::command]
pub fn comic_media_delete(db: State<'_, Arc<Db>>, id: String) -> AppResult<ComicOk> {
    comic_media_delete_impl(&db, &id)?;
    Ok(ComicOk { ok: true })
}

// ── v96 薄包装：每集形象覆盖 / 提示词 / Skill 快照 / 生成记录 ────────────

#[tauri::command]
pub fn comic_episode_character_override_list(
    db: State<'_, Arc<Db>>,
    project_id: String,
    episode_id: String,
) -> AppResult<ComicEpisodeCharacterOverrideList> {
    Ok(ComicEpisodeCharacterOverrideList {
        overrides: comic_episode_character_override_list_impl(&db, &project_id, &episode_id)?,
    })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn comic_episode_character_override_save(
    db: State<'_, Arc<Db>>,
    project_id: String,
    episode_id: String,
    character_id: String,
    role_in_episode: String,
    appearance_label: String,
    appearance_description: String,
    costume_description: String,
    hair_style_description: String,
    state_description: String,
    visual_prompt_override: String,
    ref_image_path: String,
) -> AppResult<ComicEpisodeCharacterOverrideSaved> {
    Ok(ComicEpisodeCharacterOverrideSaved {
        record: comic_episode_character_override_save_impl(
            &db,
            &project_id,
            &episode_id,
            &character_id,
            role_in_episode,
            appearance_label,
            appearance_description,
            costume_description,
            hair_style_description,
            state_description,
            visual_prompt_override,
            ref_image_path,
        )?,
    })
}

#[tauri::command]
pub fn comic_episode_character_override_delete(
    db: State<'_, Arc<Db>>,
    project_id: String,
    episode_id: String,
    character_id: String,
) -> AppResult<ComicOk> {
    comic_episode_character_override_delete_impl(
        &db,
        &project_id,
        &episode_id,
        &character_id,
    )?;
    Ok(ComicOk { ok: true })
}

#[tauri::command]
pub fn comic_prompt_template_list(
    db: State<'_, Arc<Db>>,
    project_id: String,
) -> AppResult<ComicPromptTemplateList> {
    Ok(ComicPromptTemplateList {
        templates: comic_prompt_template_list_impl(&db, &project_id)?,
    })
}

#[tauri::command]
pub fn comic_prompt_template_save(
    db: State<'_, Arc<Db>>,
    id: Option<String>,
    project_id: String,
    name: String,
    category: String,
    description: String,
) -> AppResult<ComicPromptTemplateSaved> {
    Ok(ComicPromptTemplateSaved {
        template: comic_prompt_template_save_impl(
            &db,
            id,
            project_id,
            name,
            category,
            description,
        )?,
    })
}

#[tauri::command]
pub fn comic_prompt_version_list(
    db: State<'_, Arc<Db>>,
    template_id: String,
) -> AppResult<ComicPromptVersionList> {
    Ok(ComicPromptVersionList {
        versions: comic_prompt_version_list_impl(&db, &template_id)?,
    })
}

#[tauri::command]
pub fn comic_prompt_version_create(
    db: State<'_, Arc<Db>>,
    template_id: String,
    content: String,
    variables_json: String,
    change_note: String,
) -> AppResult<ComicPromptVersionSaved> {
    Ok(ComicPromptVersionSaved {
        version: comic_prompt_version_create_impl(
            &db,
            &template_id,
            content,
            variables_json,
            change_note,
        )?,
    })
}

#[tauri::command]
pub fn comic_prompt_version_set_default(
    db: State<'_, Arc<Db>>,
    template_id: String,
    version_id: String,
) -> AppResult<ComicPromptVersionSaved> {
    Ok(ComicPromptVersionSaved {
        version: comic_prompt_version_set_default_impl(&db, &template_id, &version_id)?,
    })
}

#[tauri::command]
pub fn comic_prompt_context_get(
    db: State<'_, Arc<Db>>,
    project_id: String,
    episode_id: String,
    shot_id: Option<String>,
) -> AppResult<ComicPromptContextGot> {
    Ok(ComicPromptContextGot {
        context: build_comic_prompt_context_impl(
            &db,
            &project_id,
            &episode_id,
            shot_id.as_deref(),
        )?,
    })
}

#[tauri::command]
pub fn comic_prompt_render(
    db: State<'_, Arc<Db>>,
    project_id: String,
    prompt_version_id: String,
    episode_id: String,
    shot_id: Option<String>,
) -> AppResult<ComicPromptPreviewGot> {
    Ok(ComicPromptPreviewGot {
        preview: comic_prompt_render_impl(
            &db,
            &project_id,
            &prompt_version_id,
            &episode_id,
            shot_id.as_deref(),
        )?,
    })
}

#[tauri::command]
pub fn comic_skill_snapshot_capture(
    db: State<'_, Arc<Db>>,
    project_id: String,
    skill_id: String,
) -> AppResult<ComicSkillSnapshotSaved> {
    Ok(ComicSkillSnapshotSaved {
        snapshot: comic_skill_snapshot_capture_impl(&db, &project_id, &skill_id)?,
    })
}

#[tauri::command]
pub fn comic_skill_snapshot_list(
    db: State<'_, Arc<Db>>,
    project_id: String,
    skill_id: Option<String>,
) -> AppResult<ComicSkillSnapshotList> {
    Ok(ComicSkillSnapshotList {
        snapshots: comic_skill_snapshot_list_impl(&db, &project_id, skill_id.as_deref())?,
    })
}

#[tauri::command]
pub fn comic_skill_snapshot_get(
    db: State<'_, Arc<Db>>,
    snapshot_id: String,
) -> AppResult<ComicSkillSnapshotSaved> {
    Ok(ComicSkillSnapshotSaved {
        snapshot: comic_skill_snapshot_get_impl(&db, &snapshot_id)?,
    })
}

#[tauri::command]
pub fn comic_generation_record_create(
    db: State<'_, Arc<Db>>,
    input: ComicGenerationRecordInput,
) -> AppResult<ComicGenerationRunSaved> {
    Ok(ComicGenerationRunSaved {
        run: comic_generation_record_create_impl(&db, input)?,
    })
}

#[tauri::command]
pub fn comic_generation_record_list(
    db: State<'_, Arc<Db>>,
    project_id: String,
    episode_id: Option<String>,
    shot_id: Option<String>,
) -> AppResult<ComicGenerationRunList> {
    Ok(ComicGenerationRunList {
        runs: comic_generation_record_list_impl(
            &db,
            &project_id,
            episode_id.as_deref(),
            shot_id.as_deref(),
        )?,
    })
}

/// 漫剧项目概览统计（项目中枢专业摘要；只读，不触发任何领域写入）。
#[tauri::command]
pub fn comic_overview_stats(
    db: State<'_, Arc<Db>>,
    project_id: String,
) -> AppResult<ComicOverviewStats> {
    comic_overview_stats_impl(&db, &project_id)
}

// ── 测试 ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::backup::{BackupKind, BackupSources, read_bundle, write_bundle};
    use crate::commands::data::{self, ImportOptions};
    use crate::commands::project_workspace::{
        workspace_project_save_impl, workspace_project_set_status_impl, WorkspaceProject,
    };

    fn create_comic_project(db: &Db, name: &str) -> WorkspaceProject {
        workspace_project_save_impl(db, None, name.to_string(), "ai_comic".into(), None, None, None)
            .expect("创建漫剧项目")
    }

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "td-comic-{}-{}",
            tag,
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).expect("创建临时目录");
        dir
    }

    /// 构造验收基线：2 集、每集 3 镜头、3 角色、2 场景、2+ 素材版本。
    ///
    /// 注意顺序：v96 起分镜角色必须在剧集出场名单内，因此先建角色，再用
    /// `character_ids` 建剧集，最后建镜头。历史库由迁移回填，不依赖此顺序。
    fn seed_fixture_data(db: &Db) -> FixtureIds {
        let project = create_comic_project(db, "测试漫剧");

        let c1 = comic_character_save_impl(
            db, None, project.id.clone(), "黑发少年".into(), "小前锋".into(),
            "196cm，25 号球衣".into(), None, None,
        )
        .unwrap();
        let c2 = comic_character_save_impl(
            db, None, project.id.clone(), "队友".into(), "后卫".into(),
            "组织进攻".into(), None, None,
        )
        .unwrap();
        let c3 = comic_character_save_impl(
            db, None, project.id.clone(), "对手队长".into(), "中锋".into(),
            "内线支柱".into(), None, None,
        )
        .unwrap();
        let s1 = comic_scene_save_impl(
            db, None, project.id.clone(), "篮球场".into(), "室内体育馆".into(), None, None,
        )
        .unwrap();
        let s2 = comic_scene_save_impl(
            db, None, project.id.clone(), "更衣室".into(), "赛后走廊".into(), None, None,
        )
        .unwrap();

        let roster = Some(vec![c1.id.clone(), c2.id.clone()]);
        let ep1 = comic_episode_save_impl(
            db, None, project.id.clone(), Some(1), "第一集".into(),
            "开场简介".into(), "第一场剧本正文。".into(), "scripting".to_string(), 30,
            roster.clone(), None,
        )
        .unwrap();
        let ep2 = comic_episode_save_impl(
            db, None, project.id.clone(), Some(2), "第二集".into(),
            "中段简介".into(), "第二场剧本正文。".into(), "draft".to_string(), 10,
            roster, None,
        )
        .unwrap();

        let mut shots = Vec::new();
        for (episode, label) in [(&ep1, "A"), (&ep2, "B")] {
            for i in 1..=3 {
                let shot = comic_shot_save_impl(
                    db, None, project.id.clone(), episode.id.clone(), Some(i),
                    format!("{label}-镜头{i}描述"),
                    Some(vec![c1.id.clone(), c2.id.clone()]),
                    Some(s1.id.clone()),
                    format!("{label}-镜头{i}台词"),
                    "中景".into(), "固定机位".into(), Some(3.5),
                    "todo".to_string(), None, format!("{label}-镜头{i}备注"), None,
                )
                .unwrap();
                shots.push(shot);
            }
        }

        let v1 = comic_media_import_impl(
            db, None, project.id.clone(), Some(shots[0].id.clone()), None, None,
            "C:/fixtures/shot-a1-v1.png".into(), "image".to_string(), Some("v1".into()),
            Some("初稿构图".into()),
        )
        .unwrap();
        let v2 = comic_media_import_impl(
            db, None, project.id.clone(), Some(shots[0].id.clone()), None, None,
            "C:/fixtures/shot-a1-v2.png".into(), "image".to_string(), Some("v2".into()),
            Some("调整后".into()),
        )
        .unwrap();

        FixtureIds {
            project,
            episodes: vec![ep1, ep2],
            characters: vec![c1, c2, c3],
            scenes: vec![s1, s2],
            shots,
            versions: vec![v1, v2],
        }
    }

    struct FixtureIds {
        project: WorkspaceProject,
        episodes: Vec<ComicEpisode>,
        characters: Vec<ComicCharacter>,
        scenes: Vec<ComicScene>,
        shots: Vec<ComicShot>,
        versions: Vec<ComicMediaVersion>,
    }

    #[test]
    fn comic_crud_ordering_relations_adoption_and_script_persist() {
        let db = Db::open_in_memory().unwrap();
        let fx = seed_fixture_data(&db);

        // 剧集与镜头按默认顺序持久；每集 3 镜头。
        let episodes = comic_episode_list_impl(&db, &fx.project.id).unwrap();
        assert_eq!(episodes.len(), 2);
        assert_eq!(episodes[0].title, "第一集");
        assert_eq!(episodes[0].script, "第一场剧本正文。");
        assert_eq!(episodes[0].shot_count, 3);
        assert_eq!(episodes[1].shot_count, 3);

        let shots_ep1 = comic_shot_list_impl(
            &db,
            &fx.project.id,
            Some(fx.episodes[0].id.clone()),
        )
        .unwrap();
        assert_eq!(shots_ep1.len(), 3);
        assert_eq!(
            shots_ep1[0].character_ids,
            vec![fx.characters[0].id.clone(), fx.characters[1].id.clone()]
        );
        assert_eq!(shots_ep1[0].scene_id, Some(fx.scenes[0].id.clone()));

        // 重排剧集：逆序后重新读出，顺序必须持久。
        comic_episode_reorder_impl(
            &db,
            &fx.project.id,
            vec![fx.episodes[1].id.clone(), fx.episodes[0].id.clone()],
        )
        .unwrap();
        let reordered = comic_episode_list_impl(&db, &fx.project.id).unwrap();
        assert_eq!(reordered[0].id, fx.episodes[1].id);
        assert_eq!(reordered[1].id, fx.episodes[0].id);

        // 重排镜头：同集内逆序持久。
        comic_shot_reorder_impl(
            &db,
            &fx.project.id,
            &fx.episodes[0].id,
            vec![
                shots_ep1[2].id.clone(),
                shots_ep1[1].id.clone(),
                shots_ep1[0].id.clone(),
            ],
        )
        .unwrap();
        let shots_after = comic_shot_list_impl(
            &db,
            &fx.project.id,
            Some(fx.episodes[0].id.clone()),
        )
        .unwrap();
        assert_eq!(shots_after[0].id, shots_ep1[2].id);

        // 剧本保存与恢复：改名 + 改剧本后 get 逐字返回。
        let updated = comic_episode_save_impl(
            &db,
            Some(fx.episodes[0].id.clone()),
            fx.project.id.clone(),
            Some(1),
            "第一集（修订）".into(),
            "修订简介".into(),
            "修订后的剧本正文。".into(),
            "storyboard".to_string(),
            55,
            // 第一集镜头仍引用 c1/c2：移出任一角色都会被守卫拒绝，这里保留完整名单。
            Some(vec![
                fx.characters[0].id.clone(),
                fx.characters[1].id.clone(),
            ]),
            None,
        )
        .unwrap();
        assert_eq!(updated.title, "第一集（修订）");
        let got = comic_episode_get_impl(&db, &fx.episodes[0].id).unwrap();
        assert_eq!(got.script, "修订后的剧本正文。");
        assert_eq!(got.progress, 55);
        assert_eq!(
            got.character_ids,
            vec![
                fx.characters[0].id.clone(),
                fx.characters[1].id.clone()
            ]
        );

        // 采用唯一：v2 采用后，v1 回到候选；同镜头不能有第二个 adopted。
        comic_media_adopt_impl(&db, &fx.versions[1].id).unwrap();
        let list = comic_media_list_impl(&db, &fx.project.id, Some(shots_ep1[0].id.clone()))
            .unwrap();
        let adopted: Vec<_> = list.iter().filter(|v| v.status == "adopted").collect();
        assert_eq!(adopted.len(), 1);
        assert_eq!(adopted[0].id, fx.versions[1].id);
        let v1 = db
            .with_read(|conn| read_media(conn, &fx.versions[0].id))
            .unwrap();
        assert_eq!(v1.status, "candidate");

        // 切项目隔离：另一项目看不到本项目数据。
        let other = create_comic_project(&db, "另一部漫剧");
        assert!(comic_episode_list_impl(&db, &other.id).unwrap().is_empty());
        assert!(comic_shot_list_impl(&db, &other.id, None).unwrap().is_empty());
        assert!(comic_character_list_impl(&db, &other.id).unwrap().is_empty());
        assert!(comic_scene_list_impl(&db, &other.id).unwrap().is_empty());
        assert!(comic_media_list_impl(&db, &other.id, None).unwrap().is_empty());
    }

    #[test]
    fn comic_commands_reject_non_comic_kind_and_enforce_archived_read_only() {
        let db = Db::open_in_memory().unwrap();
        let comic = create_comic_project(&db, "漫剧");
        let ep = comic_episode_save_impl(
            &db, None, comic.id.clone(), None, "第一集".into(),
            "".into(), "剧本".into(), "draft".to_string(), 0, None, None,
        )
        .unwrap();
        let shot = comic_shot_save_impl(
            &db, None, comic.id.clone(), ep.id.clone(), None, "镜头".into(),
            None, None, "".into(), "".into(), "".into(), None, "todo".to_string(), None, "".into(), None,
        )
        .unwrap();

        // 非 ai_comic 项目：读写一律拒绝。
        for kind in ["game", "development", "general", "novel"] {
            let p = workspace_project_save_impl(
                &db, None, kind.into(), kind.into(), None, None, None,
            )
            .unwrap();
            assert!(comic_episode_list_impl(&db, &p.id).is_err(), "{kind} 不应读剧集");
            assert!(comic_episode_save_impl(
                &db, None, p.id.clone(), None, "偷渡集".into(), "".into(), "".into(),
                "draft".to_string(), 0, None, None,
            ).is_err(), "{kind} 不应写剧集");
            assert!(comic_shot_list_impl(&db, &p.id, None).is_err(), "{kind} 不应读镜头");
            assert!(comic_character_list_impl(&db, &p.id).is_err(), "{kind} 不应读角色");
            assert!(comic_scene_list_impl(&db, &p.id).is_err(), "{kind} 不应读场景");
            assert!(comic_media_list_impl(&db, &p.id, None).is_err(), "{kind} 不应读素材");
        }

        // 归档：读取允许，所有写入拒绝。
        workspace_project_set_status_impl(&db, &comic.id, "archived".into()).unwrap();
        assert_eq!(comic_episode_list_impl(&db, &comic.id).unwrap().len(), 1);
        assert_eq!(comic_shot_list_impl(&db, &comic.id, None).unwrap().len(), 1);
        assert!(comic_episode_save_impl(
            &db, Some(ep.id.clone()), comic.id.clone(), None, "改名".into(), "".into(), "".into(),
            "draft".to_string(), 0, None, None,
        ).is_err());
        assert!(comic_episode_delete_impl(&db, &ep.id).is_err());
        assert!(comic_shot_save_impl(
            &db, Some(shot.id.clone()), comic.id.clone(), ep.id.clone(), None, "改名".into(),
            None, None, "".into(), "".into(), "".into(), None, "todo".to_string(), None, "".into(), None,
        ).is_err());
        assert!(comic_shot_delete_impl(&db, &shot.id).is_err());
        assert!(comic_character_save_impl(
            &db, None, comic.id.clone(), "偷渡角色".into(), "".into(), "".into(), None, None,
        ).is_err());
        assert!(comic_media_import_impl(
            &db, None, comic.id.clone(), Some(shot.id.clone()), None, None,
            "C:/x.png".into(), "image".to_string(), None, None,
        ).is_err());

        // 恢复 active 后可写。
        workspace_project_set_status_impl(&db, &comic.id, "active".into()).unwrap();
        comic_episode_delete_impl(&db, &ep.id).unwrap();
        let violations: i64 = db
            .with_read(|conn| {
                Ok(conn.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |r| {
                    r.get(0)
                })?
                )
            })
            .unwrap();
        assert_eq!(violations, 0);
    }

    #[test]
    fn comic_missing_media_path_degrades_without_crash() {
        let db = Db::open_in_memory().unwrap();
        let fx = seed_fixture_data(&db);

        // 引用路径为不存在的位置：读侧必须返回 file_exists=false，而不是报错/崩溃。
        let missing = comic_media_import_impl(
            &db, None, fx.project.id.clone(), Some(fx.shots[0].id.clone()), None, None,
            "C:/definitely/not/existing/shot-missing.png".into(), "image".to_string(),
            Some("缺失版本".into()), None,
        )
        .unwrap();
        assert!(!missing.file_exists, "不存在路径必须标记为文件缺失");

        let list = comic_media_list_impl(&db, &fx.project.id, Some(fx.shots[0].id.clone())).unwrap();
        let row = list.iter().find(|v| v.id == missing.id).unwrap();
        assert!(!row.file_exists);
        // fixture 路径同样不存在，也应降级而不是报错。
        assert!(list.iter().all(|v| !v.file_exists || v.file_path.is_empty()));

        // 角色/场景参考图空路径不报错。
        let chars = comic_character_list_impl(&db, &fx.project.id).unwrap();
        assert!(chars.iter().all(|c| !c.ref_image_exists));
        let scenes = comic_scene_list_impl(&db, &fx.project.id).unwrap();
        assert!(scenes.iter().all(|s| !s.ref_image_exists));
    }

    #[test]
    fn comic_tables_roundtrip_in_full_and_quick_backup() {
        let db = Db::open_in_memory().unwrap();
        let fx = seed_fixture_data(&db);
        comic_media_adopt_impl(&db, &fx.versions[1].id).unwrap();

        for kind in [BackupKind::Full, BackupKind::Quick] {
            let dir = temp_dir("roundtrip");
            let target = dir.join("backup.json");
            write_bundle(&db, BackupSources::default(), &target, kind).unwrap();
            let staging = dir.join("staging");
            let read = read_bundle(&target, &staging).unwrap();

            let dst = Db::open_in_memory().unwrap();
            let parsed = data::validate_bundle(&dst, &read.data, &read.rows_dir).unwrap();
            data::import_parsed_with(
                &dst,
                parsed,
                &ImportOptions { allow_extended: true, commit_marker: None },
            )
            .unwrap();

            let restored = comic_episode_list_impl(&dst, &fx.project.id).unwrap();
            assert_eq!(restored.len(), 2, "{:?} 恢复后剧集丢失", kind);
            assert_eq!(restored[0].script, "第一场剧本正文。");
            let restored_shots = comic_shot_list_impl(&dst, &fx.project.id, None).unwrap();
            assert_eq!(restored_shots.len(), 6, "{:?} 恢复后镜头丢失", kind);
            assert_eq!(restored_shots[0].character_ids.len(), 2);
            let restored_chars = comic_character_list_impl(&dst, &fx.project.id).unwrap();
            assert_eq!(restored_chars.len(), 3, "{:?} 恢复后角色丢失", kind);
            let restored_scenes = comic_scene_list_impl(&dst, &fx.project.id).unwrap();
            assert_eq!(restored_scenes.len(), 2, "{:?} 恢复后场景丢失", kind);
            let restored_media = comic_media_list_impl(&dst, &fx.project.id, None).unwrap();
            assert_eq!(restored_media.len(), 2, "{:?} 恢复后素材版本丢失", kind);
            let adopted: Vec<_> = restored_media.iter().filter(|v| v.status == "adopted").collect();
            assert_eq!(adopted.len(), 1, "{:?} 采用状态必须随备份还原", kind);
            std::fs::remove_dir_all(&dir).ok();
        }
    }

    // ── V1 收口验收：隔离文件库 + 真实临时素材文件的全流程 ──────────────────────

    /// 隔离数据目录 / 素材目录：优先取验收环境变量，缺省回退系统临时目录，保证测试可独立复跑。
    fn v1_isolated_dirs() -> (std::path::PathBuf, std::path::PathBuf) {
        let data = std::env::var("COMIC_V1_DATA_DIR")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|_| temp_dir("v1-data"));
        let fixtures = std::env::var("COMIC_V1_FIXTURE_DIR")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|_| temp_dir("v1-fixtures"));
        std::fs::remove_dir_all(&data).ok();
        std::fs::create_dir_all(&data).expect("创建隔离数据目录");
        std::fs::create_dir_all(&fixtures).expect("创建素材夹具目录");
        (data, fixtures)
    }

    fn write_v1_fixture(dir: &Path, name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, bytes).expect("写入素材夹具");
        path
    }

    #[test]
    fn comic_long_script_roundtrip_without_truncation() {
        let db = Db::open_in_memory().unwrap();
        let project = create_comic_project(&db, "长剧本漫剧");
        // 多行、含标点与空白的长文本：往返必须逐字一致，不截断、不去首尾空白。
        let long_script = (1..=1200)
            .map(|i| format!("第 {} 行：林野在三分线外接球起跳，篮网应声落网。\n", i))
            .collect::<String>();
        let episode = comic_episode_save_impl(
            &db, None, project.id.clone(), None, "长剧本集".into(),
            "简介".into(), long_script.clone(), "scripting".into(), 0, None, None,
        )
        .unwrap();
        let got = comic_episode_get_impl(&db, &episode.id).unwrap();
        assert_eq!(got.script, long_script, "剧本往返必须逐字一致");
        assert_eq!(got.script.len(), long_script.len(), "剧本字节长度不得变化");
        assert!(got.script.starts_with("第 1 行："), "开头换行与缩进必须保留");
        assert!(got.script.ends_with("落网。\n"), "结尾换行必须保留");
    }

    #[test]
    fn comic_v1_full_flow_isolated_db_with_real_files() {
        let (data_dir, fixture_dir) = v1_isolated_dirs();
        let db_path = data_dir.join("task-dock.db");
        let db = Db::open(&db_path).expect("打开隔离文件库");

        // 1. 创建漫剧项目 → 剧集（长剧本）→ 三个分镜。
        let project = create_comic_project(&db, "验收漫剧 V1");
        let long_script = (1..=600)
            .map(|i| format!("镜头铺垫 {}：少年突破分球，内线接应上篮。\n", i))
            .collect::<String>();
        let episode = comic_episode_save_impl(
            &db, None, project.id.clone(), None, "第 1 集 · 真实的起点".into(),
            "开场简介".into(), long_script.clone(), "scripting".into(), 20, None, None,
        )
        .unwrap();
        let episode_again = comic_episode_get_impl(&db, &episode.id).unwrap();
        assert_eq!(episode_again.script, long_script, "剧本往返逐字一致");

        let mut shots = Vec::new();
        for i in 1..=3 {
            shots.push(
                comic_shot_save_impl(
                    &db, None, project.id.clone(), episode.id.clone(), Some(i),
                    format!("镜头 {} 描述", i), None, None, format!("镜头 {} 台词", i),
                    "中景".into(), "推镜".into(), Some(2.5), "todo".into(), None,
                    "备注".into(), None,
                )
                .unwrap(),
            );
        }

        // 2. 角色 / 场景，并关联到剧集与镜头。
        let c1 = comic_character_save_impl(
            &db, None, project.id.clone(), "黑发少年".into(), "小前锋".into(),
            "196cm，25 号球衣".into(), None, None,
        )
        .unwrap();
        let c2 = comic_character_save_impl(
            &db, None, project.id.clone(), "队友".into(), "后卫".into(),
            "组织进攻".into(), None, None,
        )
        .unwrap();
        let s1 = comic_scene_save_impl(
            &db, None, project.id.clone(), "篮球场".into(), "室内体育馆".into(), None, None,
        )
        .unwrap();
        let s2 = comic_scene_save_impl(
            &db, None, project.id.clone(), "更衣室".into(), "赛后走廊".into(), None, None,
        )
        .unwrap();

        comic_episode_save_impl(
            &db, Some(episode.id.clone()), project.id.clone(), None, "第 1 集 · 真实的起点".into(),
            "开场简介".into(), long_script.clone(), "storyboard".into(), 35,
            Some(vec![c1.id.clone(), c2.id.clone()]), None,
        )
        .unwrap();
        comic_shot_save_impl(
            &db, Some(shots[0].id.clone()), project.id.clone(), episode.id.clone(), None,
            "镜头 1 描述".into(), Some(vec![c1.id.clone()]), Some(s1.id.clone()),
            "开场台词".into(), "中景".into(), "推镜".into(), Some(2.5), "todo".into(),
            None, "备注".into(), None,
        )
        .unwrap();

        // 3. 镜头逆序重排：sort_order 必须连续、不重复。
        comic_shot_reorder_impl(
            &db, &project.id, &episode.id,
            vec![shots[2].id.clone(), shots[1].id.clone(), shots[0].id.clone()],
        )
        .unwrap();
        let shots_ep = comic_shot_list_impl(&db, &project.id, Some(episode.id.clone())).unwrap();
        assert_eq!(shots_ep[0].id, shots[2].id);
        let raw_orders: Vec<i64> = db
            .with_read(|conn| {
                let mut stmt = conn.prepare(
                    "SELECT sort_order FROM comic_shots WHERE episode_id = ?1 ORDER BY sort_order",
                )?;
                let rows = stmt.query_map(params![episode.id], |r| r.get(0))?;
                Ok(rows.filter_map(|x| x.ok()).collect::<Vec<i64>>())
            })
            .unwrap();
        assert_eq!(raw_orders, vec![0, 1, 2], "重排后 sort_order 必须连续且不重复");

        // 4. 真实素材文件：导入两个版本，file_exists=true，source 固定 imported。
        let f1 = write_v1_fixture(&fixture_dir, "shot-h1-v1.png", b"FIXTURE-V1-CONTENT-0001");
        let f2 = write_v1_fixture(&fixture_dir, "shot-h1-v2.png", b"FIXTURE-V2-CONTENT-0002");
        let f3 = write_v1_fixture(&fixture_dir, "shot-h2-v1.png", b"FIXTURE-V3-CONTENT-0003");
        let f4 = write_v1_fixture(&fixture_dir, "char-c2-ref.png", b"FIXTURE-V4-CONTENT-0004");
        let f5 = write_v1_fixture(&fixture_dir, "scene-s1-ref.png", b"FIXTURE-V5-CONTENT-0005");

        let m1 = comic_media_import_impl(
            &db, None, project.id.clone(), Some(shots[0].id.clone()), None, None,
            f1.to_string_lossy().into(), "image".into(), Some("v1".into()), Some("初稿".into()),
        )
        .unwrap();
        let m2 = comic_media_import_impl(
            &db, None, project.id.clone(), Some(shots[0].id.clone()), None, None,
            f2.to_string_lossy().into(), "image".into(), Some("v2".into()), Some("调整后".into()),
        )
        .unwrap();
        let m3 = comic_media_import_impl(
            &db, None, project.id.clone(), Some(shots[1].id.clone()), None, None,
            f3.to_string_lossy().into(), "image".into(), Some("v1".into()), None,
        )
        .unwrap();
        let m4 = comic_media_import_impl(
            &db, None, project.id.clone(), None, Some(c2.id.clone()), None,
            f4.to_string_lossy().into(), "image".into(), Some("角色参考".into()), None,
        )
        .unwrap();
        let m5 = comic_media_import_impl(
            &db, None, project.id.clone(), None, None, Some(s1.id.clone()),
            f5.to_string_lossy().into(), "image".into(), Some("场景参考".into()), None,
        )
        .unwrap();
        for m in [&m1, &m2, &m3, &m4, &m5] {
            assert!(m.file_exists, "真实夹具文件必须标记存在");
            assert_eq!(m.source, "imported", "导入来源必须是 imported");
        }

        // 5. 采用 v2：v1 回到候选，同镜头只能有一个 adopted（DB 唯一索引 + 事务双保险）。
        comic_media_adopt_impl(&db, &m2.id).unwrap();
        let list_h1 = comic_media_list_impl(&db, &project.id, Some(shots[0].id.clone())).unwrap();
        let adopted: Vec<_> = list_h1.iter().filter(|v| v.status == "adopted").collect();
        assert_eq!(adopted.len(), 1, "同镜头不能同时存在多个采用版本");
        assert_eq!(adopted[0].id, m2.id);
        assert_eq!(
            list_h1.iter().find(|v| v.id == m1.id).unwrap().status,
            "candidate"
        );

        // 拒收 v1，再恢复候选。
        comic_media_save_impl(&db, &m1.id, None, Some("rejected".into()), None).unwrap();
        assert_eq!(
            comic_media_save_impl(&db, &m1.id, None, Some("candidate".into()), None)
                .unwrap()
                .status,
            "candidate"
        );

        // 6. 回退：重新采用 v1，v2 回到候选，仍只有一个 adopted。
        comic_media_adopt_impl(&db, &m1.id).unwrap();
        let list_h1 = comic_media_list_impl(&db, &project.id, Some(shots[0].id.clone())).unwrap();
        let adopted: Vec<_> = list_h1.iter().filter(|v| v.status == "adopted").collect();
        assert_eq!(adopted.len(), 1, "回退后只能有一个采用版本");
        assert_eq!(adopted[0].id, m1.id);
        assert_eq!(
            list_h1.iter().find(|v| v.id == m2.id).unwrap().status,
            "candidate"
        );

        // 7. 再替换回 v2：唯一采用约束依然成立。
        comic_media_adopt_impl(&db, &m2.id).unwrap();
        let list_h1 = comic_media_list_impl(&db, &project.id, Some(shots[0].id.clone())).unwrap();
        assert_eq!(
            list_h1.iter().filter(|v| v.status == "adopted").count(),
            1
        );

        // 8. 删除角色 c2：镜头/剧集不得误删；素材角色引用置空；剧集/镜头 JSON 弱引用保留（读侧降级）。
        comic_character_delete_impl(&db, &c2.id).unwrap();
        assert_eq!(
            comic_shot_list_impl(&db, &project.id, None).unwrap().len(),
            3,
            "删除角色不得误删镜头"
        );
        let m4_after = comic_media_list_impl(&db, &project.id, None)
            .unwrap()
            .into_iter()
            .find(|v| v.id == m4.id)
            .unwrap();
        assert_eq!(m4_after.character_id, None, "角色删除后素材角色引用必须置空");
        let episode_after = comic_episode_get_impl(&db, &episode.id).unwrap();
        assert!(
            !episode_after.character_ids.contains(&c2.id),
            "删除全局角色必须同时清理剧集出场名单，不留悬空 ID"
        );

        // 9. 删除场景 s1：镜头 scene_id 置空，镜头保留；素材场景引用置空。
        comic_scene_delete_impl(&db, &s1.id).unwrap();
        assert_eq!(
            comic_shot_list_impl(&db, &project.id, None).unwrap().len(),
            3,
            "删除场景不得误删镜头"
        );
        let h1 = comic_shot_get_impl(&db, &shots[0].id).unwrap();
        assert_eq!(h1.scene_id, None, "场景删除后镜头场景外键必须置空");
        let m5_after = comic_media_list_impl(&db, &project.id, None)
            .unwrap()
            .into_iter()
            .find(|v| v.id == m5.id)
            .unwrap();
        assert_eq!(m5_after.scene_id, None, "场景删除后素材场景引用必须置空");

        // 10. 删除镜头 h1：其素材版本级联删除元数据行；原文件必须原样保留。
        comic_shot_delete_impl(&db, &shots[0].id).unwrap();
        let media_left = comic_media_list_impl(&db, &project.id, None).unwrap();
        assert!(
            media_left.iter().all(|v| v.shot_id != Some(shots[0].id.clone())),
            "镜头删除后其素材版本元数据必须级联清理"
        );
        assert!(f1.exists() && f2.exists(), "镜头删除不得删除素材原文件");
        assert_eq!(std::fs::read(&f1).unwrap(), b"FIXTURE-V1-CONTENT-0001");
        assert_eq!(std::fs::read(&f2).unwrap(), b"FIXTURE-V2-CONTENT-0002");

        // 11. 直接删除素材版本记录：原文件保留且内容不变。
        comic_media_delete_impl(&db, &m3.id).unwrap();
        assert!(f3.exists(), "删除素材记录不得删除原文件");
        assert_eq!(std::fs::read(&f3).unwrap(), b"FIXTURE-V3-CONTENT-0003");

        // 12. 文件缺失：读侧 file_exists=false，不报错、不崩溃、不清理引用。
        let missing = comic_media_import_impl(
            &db, None, project.id.clone(), Some(shots[1].id.clone()), None, None,
            "C:/definitely/not/existing/shot-missing.png".into(), "image".into(),
            Some("缺失版本".into()), None,
        )
        .unwrap();
        assert!(!missing.file_exists);

        // 13. 项目隔离：另一漫剧项目列表为空；跨项目引用一律拒绝。
        let other = create_comic_project(&db, "另一部漫剧");
        assert!(comic_episode_list_impl(&db, &other.id).unwrap().is_empty());
        assert!(comic_shot_list_impl(&db, &other.id, None).unwrap().is_empty());
        assert!(comic_character_list_impl(&db, &other.id).unwrap().is_empty());
        assert!(comic_scene_list_impl(&db, &other.id).unwrap().is_empty());
        assert!(comic_media_list_impl(&db, &other.id, None).unwrap().is_empty());
        assert!(comic_shot_save_impl(
            &db, None, other.id.clone(), episode.id.clone(), None, "偷渡镜头".into(),
            None, None, "".into(), "".into(), "".into(), None, "todo".into(), None, "".into(), None,
        )
        .is_err(), "跨项目镜头归属必须拒绝");
        assert!(comic_episode_save_impl(
            &db, None, other.id.clone(), None, "偷渡剧集".into(), "".into(), "".into(),
            "draft".into(), 0, Some(vec![c1.id.clone()]), None,
        )
        .is_err(), "跨项目角色引用必须拒绝");
        assert!(comic_media_import_impl(
            &db, None, other.id.clone(), Some(shots[1].id.clone()), None, None,
            f3.to_string_lossy().into(), "image".into(), None, None,
        )
        .is_err(), "跨项目镜头素材关联必须拒绝");

        // 14. 归档只读：读取允许，所有写入拒绝；恢复 active 后可写。
        workspace_project_set_status_impl(&db, &project.id, "archived".into()).unwrap();
        assert!(!comic_episode_list_impl(&db, &project.id).unwrap().is_empty());
        assert!(comic_episode_save_impl(
            &db, Some(episode.id.clone()), project.id.clone(), None, "改名".into(), "".into(), "".into(),
            "draft".into(), 0, None, None,
        )
        .is_err());
        assert!(comic_episode_delete_impl(&db, &episode.id).is_err());
        assert!(comic_episode_reorder_impl(&db, &project.id, vec![episode.id.clone()]).is_err());
        assert!(comic_shot_save_impl(
            &db, Some(shots[1].id.clone()), project.id.clone(), episode.id.clone(), None, "改名".into(),
            None, None, "".into(), "".into(), "".into(), None, "todo".into(), None, "".into(), None,
        )
        .is_err());
        assert!(comic_shot_delete_impl(&db, &shots[1].id).is_err());
        assert!(comic_shot_reorder_impl(
            &db, &project.id, &episode.id, vec![shots[1].id.clone()],
        )
        .is_err());
        assert!(comic_character_save_impl(
            &db, None, project.id.clone(), "偷渡角色".into(), "".into(), "".into(), None, None,
        )
        .is_err());
        assert!(comic_character_delete_impl(&db, &c1.id).is_err());
        assert!(comic_scene_save_impl(
            &db, None, project.id.clone(), "偷渡场景".into(), "".into(), None, None,
        )
        .is_err());
        assert!(comic_scene_delete_impl(&db, &s2.id).is_err());
        let archived_media = comic_media_list_impl(&db, &project.id, None).unwrap();
        let archived_media_id = archived_media
            .iter()
            .find(|v| v.shot_id.is_some())
            .expect("归档前应存在镜头关联素材")
            .id
            .clone();
        assert!(comic_media_import_impl(
            &db, None, project.id.clone(), Some(shots[1].id.clone()), None, None,
            f3.to_string_lossy().into(), "image".into(), None, None,
        )
        .is_err());
        assert!(comic_media_save_impl(&db, &archived_media_id, None, Some("rejected".into()), None).is_err());
        assert!(comic_media_adopt_impl(&db, &archived_media_id).is_err());
        assert!(comic_media_delete_impl(&db, &archived_media_id).is_err());

        workspace_project_set_status_impl(&db, &project.id, "active".into()).unwrap();

        // 15. 外键完整性：无悬空外键。
        let violations: i64 = db
            .with_read(|conn| {
                Ok(conn.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |r| {
                    r.get(0)
                })?
                )
            })
            .unwrap();
        assert_eq!(violations, 0, "外键完整性检查必须通过");
    }

    #[test]
    fn comic_media_import_update_rejects_cross_project_target() {
        let db = Db::open_in_memory().unwrap();
        let own = create_comic_project(&db, "本项目漫剧");
        let other = create_comic_project(&db, "他项目漫剧");

        let own_ep = comic_episode_save_impl(
            &db, None, own.id.clone(), None, "本项目剧集".into(), "".into(), "".into(),
            "draft".into(), 0, None, None,
        )
        .unwrap();
        let own_shot = comic_shot_save_impl(
            &db, None, own.id.clone(), own_ep.id.clone(), None, "本项目镜头".into(),
            None, None, "".into(), "".into(), "".into(), None, "todo".into(), None, "".into(), None,
        )
        .unwrap();
        let other_ep = comic_episode_save_impl(
            &db, None, other.id.clone(), None, "他项目剧集".into(), "".into(), "".into(),
            "draft".into(), 0, None, None,
        )
        .unwrap();
        let other_shot = comic_shot_save_impl(
            &db, None, other.id.clone(), other_ep.id.clone(), None, "他项目镜头".into(),
            None, None, "".into(), "".into(), "".into(), None, "todo".into(), None, "".into(), None,
        )
        .unwrap();

        let fixture = temp_dir("v1-media-update");
        let file = write_v1_fixture(&fixture, "update.png", b"UPDATE-PAYLOAD");
        let version = comic_media_import_impl(
            &db, None, own.id.clone(), Some(own_shot.id.clone()), None, None,
            file.to_string_lossy().into(), "image".into(), Some("v1".into()), None,
        )
        .unwrap();

        // 把本项目版本改挂到他项目镜头：必须拒绝，不得跨项目串引用。
        assert!(comic_media_import_impl(
            &db, Some(version.id.clone()), own.id.clone(), Some(other_shot.id.clone()), None, None,
            file.to_string_lossy().into(), "image".into(), Some("v2".into()), None,
        )
        .is_err());
        // 改挂回本项目镜头仍然成功。
        let updated = comic_media_import_impl(
            &db, Some(version.id.clone()), own.id.clone(), Some(own_shot.id.clone()), None, None,
            file.to_string_lossy().into(), "image".into(), Some("v2".into()), None,
        )
        .unwrap();
        assert_eq!(updated.shot_id, Some(own_shot.id.clone()));
        std::fs::remove_dir_all(&fixture).ok();
    }

    #[test]
    fn comic_shot_save_keeps_legacy_asset_refs_when_not_submitted() {
        let db = Db::open_in_memory().unwrap();
        let project = create_comic_project(&db, "历史引用兼容漫剧");
        let episode = comic_episode_save_impl(
            &db, None, project.id.clone(), None, "第 1 集".into(), "".into(), "".into(),
            "draft".into(), 0, None, None,
        )
        .unwrap();
        let shot = comic_shot_save_impl(
            &db, None, project.id.clone(), episode.id.clone(), None, "镜头".into(),
            None, None, "".into(), "".into(), "".into(), None, "todo".into(), None, "".into(), None,
        )
        .unwrap();
        assert!(shot.asset_refs.is_empty(), "新建镜头默认没有历史引用");

        // 历史数据里的 asset_refs_json 是文件绝对路径（远超旧校验 64 字符上限）。
        let legacy_path = "D:/one drive/OneDrive/桌面/小说/最后一种打法/资源/漫剧/产出/第一卷/第01集/镜头/S01/视觉稿/S01-U01-R4_keyframe.png";
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE comic_shots SET asset_refs_json = ?2 WHERE id = ?1",
                params![shot.id, format!(r#"["{}"]"#, legacy_path)],
            )?;
            Ok(())
        })
        .unwrap();

        // 新前端不再提交该字段：None 必须保留原值，绝不能被写成空数组。
        let kept = comic_shot_save_impl(
            &db, Some(shot.id.clone()), project.id.clone(), episode.id.clone(), None,
            "镜头改名".into(), None, None, "".into(), "".into(), "".into(), None, "todo".into(),
            None, "".into(), None,
        )
        .unwrap();
        assert_eq!(kept.description, "镜头改名");
        assert_eq!(kept.asset_refs, vec![legacy_path.to_string()], "历史引用不得被清空");

        let raw: String = db
            .with_read(|conn| {
                Ok(conn.query_row(
                    "SELECT asset_refs_json FROM comic_shots WHERE id = ?1",
                    params![shot.id],
                    |r| r.get(0),
                )?)
            })
            .unwrap();
        assert!(raw.contains("S01-U01-R4_keyframe.png"), "落库值必须是原路径");

        // 旧客户端显式提交时按「路径或 ID」宽口径接受（不再因长度被拒）。
        let rewritten = comic_shot_save_impl(
            &db, Some(shot.id.clone()), project.id.clone(), episode.id.clone(), None,
            "镜头改名".into(), None, None, "".into(), "".into(), "".into(), None, "todo".into(),
            Some(vec!["D:/another/very/long/path/that/exceeds/the/old/sixty/four/char/limit/frame.png".into()]),
            "".into(), None,
        )
        .unwrap();
        assert_eq!(rewritten.asset_refs.len(), 1);
    }

    #[test]
    fn comic_media_list_and_adopt_stay_scoped_to_one_shot() {
        let db = Db::open_in_memory().unwrap();
        let project = create_comic_project(&db, "采用唯一性漫剧");
        let episode = comic_episode_save_impl(
            &db, None, project.id.clone(), None, "第 1 集".into(), "".into(), "".into(),
            "draft".into(), 0, None, None,
        )
        .unwrap();
        let shot_a = comic_shot_save_impl(
            &db, None, project.id.clone(), episode.id.clone(), None, "镜头 A".into(),
            None, None, "".into(), "".into(), "".into(), None, "todo".into(), None, "".into(), None,
        )
        .unwrap();
        let shot_b = comic_shot_save_impl(
            &db, None, project.id.clone(), episode.id.clone(), None, "镜头 B".into(),
            None, None, "".into(), "".into(), "".into(), None, "todo".into(), None, "".into(), None,
        )
        .unwrap();

        let fixture = temp_dir("v1-adopt-scope");
        let file_a = write_v1_fixture(&fixture, "a.png", b"A");
        let file_b = write_v1_fixture(&fixture, "b.png", b"B");
        let file_c = write_v1_fixture(&fixture, "c.png", b"C");
        let a1 = comic_media_import_impl(
            &db, None, project.id.clone(), Some(shot_a.id.clone()), None, None,
            file_a.to_string_lossy().into(), "image".into(), Some("A-1".into()), None,
        )
        .unwrap();
        let a2 = comic_media_import_impl(
            &db, None, project.id.clone(), Some(shot_a.id.clone()), None, None,
            file_b.to_string_lossy().into(), "image".into(), Some("A-2".into()), None,
        )
        .unwrap();
        let b1 = comic_media_import_impl(
            &db, None, project.id.clone(), Some(shot_b.id.clone()), None, None,
            file_c.to_string_lossy().into(), "image".into(), Some("B-1".into()), None,
        )
        .unwrap();

        comic_media_adopt_impl(&db, &a1.id).unwrap();
        comic_media_adopt_impl(&db, &a2.id).unwrap();
        comic_media_adopt_impl(&db, &b1.id).unwrap();

        // 同镜头内采用唯一；不同镜头互不影响。
        let list_a = comic_media_list_impl(&db, &project.id, Some(shot_a.id.clone())).unwrap();
        assert_eq!(list_a.iter().filter(|v| v.status == "adopted").count(), 1);
        assert_eq!(
            list_a.iter().find(|v| v.status == "adopted").map(|v| v.id.clone()),
            Some(a2.id.clone())
        );
        let list_b = comic_media_list_impl(&db, &project.id, Some(shot_b.id.clone())).unwrap();
        assert_eq!(list_b.len(), 1);
        assert_eq!(list_b[0].status, "adopted");
        assert_eq!(list_b[0].id, b1.id);

        // 未关联镜头的参考素材不能采用。
        let version_ref = comic_media_import_impl(
            &db, None, project.id.clone(), None, None, None,
            file_a.to_string_lossy().into(), "image".into(), Some("参考".into()), None,
        );
        assert!(version_ref.is_err(), "三选一目标为空必须拒绝");

        std::fs::remove_dir_all(&fixture).ok();
    }

    // ── v96 测试：每集形象覆盖 / 分镜名单 / 迁移回填 ─────────────────────

    #[allow(clippy::too_many_arguments)]
    fn save_override(
        db: &Db,
        project_id: &str,
        episode_id: &str,
        character_id: &str,
        role: &str,
        label: &str,
        appearance: &str,
        costume: &str,
        state: &str,
    ) -> ComicEpisodeCharacterOverride {
        comic_episode_character_override_save_impl(
            db,
            project_id,
            episode_id,
            character_id,
            role.to_string(),
            label.to_string(),
            appearance.to_string(),
            costume.to_string(),
            String::new(),
            state.to_string(),
            String::new(),
            String::new(),
        )
        .unwrap()
    }

    /// 带「本集视觉提示词补充」的形象覆盖（v99），用于验证补充只进本集上下文。
    #[allow(clippy::too_many_arguments)]
    fn save_override_with_visual(
        db: &Db,
        project_id: &str,
        episode_id: &str,
        character_id: &str,
        role: &str,
        label: &str,
        appearance: &str,
        costume: &str,
        visual_prompt: &str,
        state: &str,
    ) -> ComicEpisodeCharacterOverride {
        comic_episode_character_override_save_impl(
            db,
            project_id,
            episode_id,
            character_id,
            role.to_string(),
            label.to_string(),
            appearance.to_string(),
            costume.to_string(),
            String::new(),
            state.to_string(),
            visual_prompt.to_string(),
            String::new(),
        )
        .unwrap()
    }

    #[test]
    fn comic_episode_character_overrides_are_isolated_and_global_stays_intact() {
        let db = Db::open_in_memory().unwrap();
        let project = create_comic_project(&db, "形象覆盖漫剧");
        let c1 = comic_character_save_impl(
            &db, None, project.id.clone(), "林远".into(), "主角".into(),
            "18 岁，黑色短发，运动型身材".into(), None, None,
        )
        .unwrap();
        let c2 = comic_character_save_impl(
            &db, None, project.id.clone(), "配角".into(), "队友".into(),
            "基础设定".into(), None, None,
        )
        .unwrap();
        let ep1 = comic_episode_save_impl(
            &db, None, project.id.clone(), Some(1), "第一集".into(), "".into(), "".into(),
            "draft".into(), 0, Some(vec![c1.id.clone(), c2.id.clone()]), None,
        )
        .unwrap();
        let ep2 = comic_episode_save_impl(
            &db, None, project.id.clone(), Some(2), "第二集".into(), "".into(), "".into(),
            "draft".into(), 0, Some(vec![c1.id.clone()]), None,
        )
        .unwrap();

        // 同一角色在两集拥有不同形象。
        save_override(
            &db, &project.id, &ep1.id, &c1.id, "学生", "高中时期", "16 岁，短发", "蓝白校服", "正常状态",
        );
        save_override(
            &db, &project.id, &ep2.id, &c1.id, "成年", "成年时期", "26 岁，短发", "深色夹克", "成熟状态",
        );
        save_override(
            &db, &project.id, &ep1.id, &c2.id, "", "队友形象", "", "训练服", "",
        );

        let ep1_overrides =
            comic_episode_character_override_list_impl(&db, &project.id, &ep1.id).unwrap();
        let ep2_overrides =
            comic_episode_character_override_list_impl(&db, &project.id, &ep2.id).unwrap();
        assert_eq!(ep1_overrides.len(), 2);
        assert_eq!(ep2_overrides.len(), 1, "第二集只返回本集出场角色的覆盖");
        let first = ep1_overrides.iter().find(|item| item.character_id == c1.id).unwrap();
        let second = ep2_overrides.iter().find(|item| item.character_id == c1.id).unwrap();
        assert_eq!(first.appearance_label, "高中时期");
        assert_eq!(first.costume_description, "蓝白校服");
        assert_eq!(second.appearance_label, "成年时期");
        assert_eq!(second.costume_description, "深色夹克");
        // 覆盖记录必须同时带基础角色档案（前端合并的事实来源）。
        assert_eq!(first.character.description, "18 岁，黑色短发，运动型身材");

        // 修改第二集不影响第一集。
        save_override(
            &db, &project.id, &ep2.id, &c1.id, "成年", "成年时期（修订）", "27 岁", "风衣", "受伤",
        );
        let first_again =
            comic_episode_character_override_list_impl(&db, &project.id, &ep1.id).unwrap();
        assert_eq!(
            first_again.iter().find(|item| item.character_id == c1.id).unwrap().appearance_label,
            "高中时期"
        );

        // 全局角色档案完全未被覆盖污染。
        let global = comic_character_list_impl(&db, &project.id).unwrap();
        let global_c1 = global.iter().find(|item| item.id == c1.id).unwrap();
        assert_eq!(global_c1.description, "18 岁，黑色短发，运动型身材");
        assert_eq!(global_c1.role, "主角");
        assert!(global_c1.ref_image_path.is_empty());

        // 覆盖未填字段不应写回全局（空字符串也只是本集空值）。
        let blank = save_override(&db, &project.id, &ep1.id, &c2.id, "", "", "", "", "");
        assert!(blank.appearance_description.is_empty());
        let global_c2 = global.iter().find(|item| item.id == c2.id).unwrap();
        assert_eq!(global_c2.description, "基础设定");

        // 删除覆盖 = 恢复全局；不影响其它剧集覆盖。
        comic_episode_character_override_delete_impl(&db, &project.id, &ep1.id, &c1.id).unwrap();
        let after_reset =
            comic_episode_character_override_list_impl(&db, &project.id, &ep1.id).unwrap();
        assert!(after_reset.iter().all(|item| item.character_id != c1.id));
        let ep2_after =
            comic_episode_character_override_list_impl(&db, &project.id, &ep2.id).unwrap();
        assert_eq!(ep2_after.len(), 1, "删除第一集覆盖不得影响第二集");
        // 全局角色仍然存在。
        assert_eq!(comic_character_list_impl(&db, &project.id).unwrap().len(), 2);

        // 非本集角色不能写覆盖。
        assert!(comic_episode_character_override_save_impl(
            &db, &project.id, &ep2.id, &c2.id, "".into(), "偷渡".into(), "".into(),
            "".into(), "".into(), "".into(), "".into(), "".into(),
        )
        .is_err(), "不在本集名单的角色不能保存形象覆盖");

        // 控制字符/超长文本被拒绝。
        assert!(comic_episode_character_override_save_impl(
            &db, &project.id, &ep1.id, &c1.id, "".into(), "标题\u{0007}".into(), "".into(),
            "".into(), "".into(), "".into(), "".into(), "".into(),
        )
        .is_err());

        // 跨项目读取拒绝。
        let other = create_comic_project(&db, "另一部");
        assert!(comic_episode_character_override_list_impl(&db, &other.id, &ep1.id).is_err());

        // 归档只读：读取允许，写入/删除拒绝。
        workspace_project_set_status_impl(&db, &project.id, "archived".into()).unwrap();
        assert_eq!(
            comic_episode_character_override_list_impl(&db, &project.id, &ep1.id).unwrap().len(),
            1
        );
        assert!(comic_episode_character_override_save_impl(
            &db, &project.id, &ep1.id, &c1.id, "".into(), "归档偷渡".into(), "".into(),
            "".into(), "".into(), "".into(), "".into(), "".into(),
        )
        .is_err());
        assert!(
            comic_episode_character_override_delete_impl(&db, &project.id, &ep1.id, &c2.id).is_err()
        );
    }

    #[test]
    fn comic_shots_only_accept_episode_roster_and_removal_is_guarded() {
        let db = Db::open_in_memory().unwrap();
        let project = create_comic_project(&db, "分镜角色约束");
        let c1 = comic_character_save_impl(
            &db, None, project.id.clone(), "本集角色".into(), "".into(), "".into(), None, None,
        )
        .unwrap();
        let c2 = comic_character_save_impl(
            &db, None, project.id.clone(), "他集角色".into(), "".into(), "".into(), None, None,
        )
        .unwrap();
        let ep = comic_episode_save_impl(
            &db, None, project.id.clone(), None, "第一集".into(), "".into(), "".into(),
            "draft".into(), 0, Some(vec![c1.id.clone()]), None,
        )
        .unwrap();

        // 后端拒绝不在本集名单的角色（不能只靠前端过滤）。
        let rejected = comic_shot_save_impl(
            &db, None, project.id.clone(), ep.id.clone(), None, "跨集镜头".into(),
            Some(vec![c2.id.clone()]), None, "".into(), "".into(), "".into(), None,
            "todo".into(), None, "".into(), None,
        )
        .unwrap_err();
        assert!(
            format!("{rejected}").contains("不在本集出场名单"),
            "错误必须说明角色不在本集名单: {rejected}"
        );

        // 本集角色可以保存。
        let shot = comic_shot_save_impl(
            &db, None, project.id.clone(), ep.id.clone(), None, "正常镜头".into(),
            Some(vec![c1.id.clone()]), None, "".into(), "".into(), "".into(), None,
            "todo".into(), None, "".into(), None,
        )
        .unwrap();

        // 仍有镜头引用时，不允许把角色移出本集名单。
        let blocked = comic_episode_save_impl(
            &db, Some(ep.id.clone()), project.id.clone(), None, "第一集".into(), "".into(),
            "".into(), "draft".into(), 0, Some(vec![]), None,
        )
        .unwrap_err();
        assert!(format!("{blocked}").contains("仍被本集"), "{blocked}");

        // 先删镜头，再移出角色即可。
        comic_shot_delete_impl(&db, &shot.id).unwrap();
        let updated = comic_episode_save_impl(
            &db, Some(ep.id.clone()), project.id.clone(), None, "第一集".into(), "".into(),
            "".into(), "draft".into(), 0, Some(vec![]), None,
        )
        .unwrap();
        assert!(updated.character_ids.is_empty());

        // 删除全局角色：同一事务清理剧集名单、镜头角色与覆盖，不留悬空 ID。
        // 形象覆盖只接受当前出场角色，因此先把角色重新加入本集名单再保存覆盖。
        comic_episode_save_impl(
            &db, Some(ep.id.clone()), project.id.clone(), None, "第一集".into(), "".into(),
            "".into(), "draft".into(), 0, Some(vec![c1.id.clone()]), None,
        )
        .unwrap();
        save_override(
            &db, &project.id, &ep.id, &c1.id, "学生", "高中", "", "校服", "",
        );
        comic_shot_save_impl(
            &db, None, project.id.clone(), ep.id.clone(), None, "引用镜头".into(),
            Some(vec![c1.id.clone()]), None, "".into(), "".into(), "".into(), None,
            "todo".into(), None, "".into(), None,
        )
        .unwrap();
        comic_character_delete_impl(&db, &c1.id).unwrap();

        let episode_after = comic_episode_get_impl(&db, &ep.id).unwrap();
        assert!(episode_after.character_ids.is_empty(), "剧集名单必须清理");
        let shots_after = comic_shot_list_impl(&db, &project.id, Some(ep.id.clone())).unwrap();
        assert!(shots_after.iter().all(|item| item.character_ids.is_empty()));
        assert_eq!(
            comic_episode_character_override_list_impl(&db, &project.id, &ep.id).unwrap().len(),
            0,
            "角色删除后本集形象覆盖必须清理"
        );
        let violations: i64 = db
            .with_read(|conn| {
                Ok(conn.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |r| {
                    r.get(0)
                })?)
            })
            .unwrap();
        assert_eq!(violations, 0);
    }

    #[test]
    fn comic_v96_migration_backfills_legacy_shot_characters_into_episode_roster() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        let idx = crate::db::MIGRATIONS
            .iter()
            .position(|(version, _)| *version == 96)
            .expect("v96 必须已注册");
        crate::db::apply_migrations(&conn, 0, &crate::db::MIGRATIONS[..idx]).unwrap();

        // 历史数据：剧集名单为空，但镜头已经引用角色（含一个已不存在的角色 ID）。
        conn.execute(
            "INSERT INTO workspace_projects
             (id, name, kind, status, root_path, dev_project_id, note, created_at, updated_at)
             VALUES ('p-legacy','老库漫剧','ai_comic','active','',NULL,'','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')",
            [],
        )
        .unwrap();
        for (id, name) in [("c1", "角色一"), ("c2", "角色二")] {
            conn.execute(
                "INSERT INTO comic_characters
                 (id, project_id, name, role, description, ref_image_path, sort_order, created_at, updated_at)
                 VALUES (?1,'p-legacy',?2,'','','',0,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')",
                params![id, name],
            )
            .unwrap();
        }
        conn.execute(
            "INSERT INTO comic_episodes
             (id, project_id, episode_no, title, synopsis, script, status, progress,
              character_ids_json, sort_order, created_at, updated_at)
             VALUES ('e1','p-legacy',1,'第一集','','','draft',0,'[]',0,
                     '2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO comic_episodes
             (id, project_id, episode_no, title, synopsis, script, status, progress,
              character_ids_json, sort_order, created_at, updated_at)
             VALUES ('e2','p-legacy',2,'第二集','','','draft',0,'[\"c2\"]',1,
                     '2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')",
            [],
        )
        .unwrap();
        for (id, episode, chars) in [
            ("s1", "e1", "[\"c1\",\"ghost\"]"),
            ("s2", "e1", "[\"c2\"]"),
            ("s3", "e1", "[\"c1\"]"),
        ] {
            conn.execute(
                "INSERT INTO comic_shots
                 (id, project_id, episode_id, shot_no, description, character_ids_json,
                  scene_id, dialogue, shot_size, camera_move, duration_sec, status,
                  asset_refs_json, note, sort_order, created_at, updated_at)
                 VALUES (?1,'p-legacy',?2,1,'',?3,NULL,'','','',0,'todo','[]','',0,
                         '2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')",
                params![id, episode, chars],
            )
            .unwrap();
        }

        // 应用剩余迁移（含 v96）：回填必须发生，且只保留真实角色。
        let current = crate::db::MIGRATIONS[idx - 1].0;
        crate::db::apply_migrations(&conn, current, &crate::db::MIGRATIONS[idx..]).unwrap();
        let raw_e1: String = conn
            .query_row(
                "SELECT character_ids_json FROM comic_episodes WHERE id='e1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let ids_e1 = parse_id_array(&raw_e1);
        assert_eq!(ids_e1.len(), 2, "去重后应有两个角色: {raw_e1}");
        assert!(ids_e1.contains(&"c1".to_string()));
        assert!(ids_e1.contains(&"c2".to_string()));
        assert!(!ids_e1.contains(&"ghost".to_string()), "不存在的角色必须被过滤");
        let raw_e2: String = conn
            .query_row(
                "SELECT character_ids_json FROM comic_episodes WHERE id='e2'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(parse_id_array(&raw_e2), vec!["c2".to_string()]);

        // 新表与唯一约束存在；被生成记录引用的版本无法删除（RESTRICT）。
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN
                 ('comic_episode_character_overrides','comic_prompt_templates',
                  'comic_prompt_versions','comic_skill_snapshots','comic_generation_runs')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 5, "v96 五张新表必须创建");
        let media_cols: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('comic_media_versions')
                 WHERE name='generation_run_id'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(media_cols, 1, "素材版本必须新增 generation_run_id 列");
    }

    // ── v96 测试：提示词版本 / 渲染 / Skill 快照 / 生成记录 ───────────────

    #[test]
    fn comic_prompt_versions_are_immutable_default_is_unique_and_render_uses_real_context() {
        let db = Db::open_in_memory().unwrap();
        let project = create_comic_project(&db, "提示词漫剧");
        let character = comic_character_save_impl(
            &db, None, project.id.clone(), "林远".into(), "主角".into(),
            "18 岁，黑色短发，运动型身材".into(), None, None,
        )
        .unwrap();
        let ep1 = comic_episode_save_impl(
            &db, None, project.id.clone(), Some(1), "第一集".into(),
            "开场简介".into(), "第一场剧本。\n第二行。".into(), "scripting".into(), 10,
            Some(vec![character.id.clone()]), None,
        )
        .unwrap();
        let ep2 = comic_episode_save_impl(
            &db, None, project.id.clone(), Some(2), "第二集".into(), "".into(), "".into(),
            "draft".into(), 0, Some(vec![character.id.clone()]), None,
        )
        .unwrap();
        let scene = comic_scene_save_impl(
            &db, None, project.id.clone(), "篮球场".into(), "室内体育馆".into(), None, None,
        )
        .unwrap();
        let shot = comic_shot_save_impl(
            &db, None, project.id.clone(), ep1.id.clone(), Some(1), "少年起跳投篮".into(),
            Some(vec![character.id.clone()]), Some(scene.id.clone()), "传球！".into(),
            "中景".into(), "推镜".into(), Some(2.0), "todo".into(), None, "".into(), None,
        )
        .unwrap();
        save_override_with_visual(
            &db, &project.id, &ep1.id, &character.id, "学生", "高中时期", "", "蓝白校服",
            "左脸有一道浅疤，右手缠着白色绷带", "右手受伤",
        );

        let template = comic_prompt_template_save_impl(
            &db, None, project.id.clone(), "角色参考模板".into(),
            "character_reference".into(), "用于角色定妆".into(),
        )
        .unwrap();
        // 模板同名拒绝（同项目唯一）。
        assert!(comic_prompt_template_save_impl(
            &db, None, project.id.clone(), "角色参考模板".into(), "other".into(), "".into(),
        )
        .is_err());

        let v1_content = "项目：{{project.name}}\n剧集：{{episode.title}}\n\n{{characters.block}}\n\n场景：{{scene.block}}\n画面：{{shot.description}}";
        let v1 = comic_prompt_version_create_impl(
            &db, &template.id, v1_content.into(),
            r#"["project.name","characters.block"]"#.into(), "初始版本".into(),
        )
        .unwrap();
        assert_eq!(v1.version_no, 1);
        assert!(v1.is_default);
        assert_eq!(v1.content, v1_content, "正文必须原样保存（含换行）");
        assert_eq!(
            v1.content_hash,
            crate::capability::content_hash(v1_content.as_bytes()),
            "内容 Hash 必须是 SHA-256"
        );
        assert_eq!(template.version_count, 0, "模板列表是快照，创建版本后应重新读取");

        let v2_content = format!("{v1_content}\n补充：保持人物一致。");
        let v2 = comic_prompt_version_create_impl(
            &db, &template.id, v2_content.clone(), "[]".into(), "补充一致性要求".into(),
        )
        .unwrap();
        assert_eq!(v2.version_no, 2);
        assert!(v2.is_default);

        // 旧版本正文绝不变化。
        let versions = comic_prompt_version_list_impl(&db, &template.id).unwrap();
        assert_eq!(versions.len(), 2);
        assert_eq!(versions[0].version_no, 2, "版本历史按版本号倒序");
        let v1_after = versions.iter().find(|item| item.id == v1.id).unwrap();
        assert_eq!(v1_after.content, v1_content);
        assert!(!v1_after.is_default);
        assert_eq!(
            versions.iter().filter(|item| item.is_default).count(),
            1,
            "同一模板只能有一个默认版本"
        );

        // 切换默认版本：事务内保证唯一。
        let switched = comic_prompt_version_set_default_impl(&db, &template.id, &v1.id).unwrap();
        assert!(switched.is_default);
        let versions = comic_prompt_version_list_impl(&db, &template.id).unwrap();
        assert_eq!(versions.iter().filter(|item| item.is_default).count(), 1);
        assert_eq!(versions.iter().find(|item| item.is_default).unwrap().id, v1.id);

        // 非法输入：未知占位符 / 未闭合 / 非法变量声明 / 未知必填变量。
        assert!(comic_prompt_version_create_impl(
            &db, &template.id, "{{hack.code}}".into(), "[]".into(), "".into(),
        )
        .is_err());
        assert!(comic_prompt_version_create_impl(
            &db, &template.id, "{{project.name".into(), "[]".into(), "".into(),
        )
        .is_err());
        assert!(comic_prompt_version_create_impl(
            &db, &template.id, "{{project.name}}".into(), "{not-json}".into(), "".into(),
        )
        .is_err());
        assert!(comic_prompt_version_create_impl(
            &db, &template.id, "{{project.name}}".into(), r#"["unknown.var"]"#.into(), "".into(),
        )
        .is_err());

        // 渲染使用真实数据：全局基础设定 + 本集服装 + 场景 + 镜头，且保留中文/换行。
        let preview =
            comic_prompt_render_impl(&db, &project.id, &v1.id, &ep1.id, Some(&shot.id)).unwrap();
        assert_eq!(preview.template_name, "角色参考模板");
        assert_eq!(preview.version_no, 1);
        assert!(preview.rendered.contains("项目：提示词漫剧"));
        assert!(preview.rendered.contains("剧集：第一集"));
        assert!(preview.rendered.contains("【角色】林远"));
        assert!(preview.rendered.contains("基础设定：18 岁，黑色短发，运动型身材"));
        assert!(preview.rendered.contains("本集服装：蓝白校服"));
        assert!(preview.rendered.contains("本集状态：右手受伤"));
        assert!(
            preview.rendered.contains("本集视觉提示词补充：左脸有一道浅疤，右手缠着白色绷带"),
            "本集视觉提示词补充必须进入第一集角色块"
        );
        assert!(preview.rendered.contains("【场景】篮球场"));
        assert!(preview.rendered.contains("画面：少年起跳投篮"));
        assert!(preview.rendered.contains('\n'));
        assert!(!preview.rendered.contains("{{"));
        assert_eq!(preview.context.characters.len(), 1);
        assert!(preview.context.characters[0].using_override);
        assert_eq!(
            preview.context.characters[0].visual_prompt_override,
            "左脸有一道浅疤，右手缠着白色绷带"
        );
        assert_eq!(preview.context.scenes.len(), 1);
        assert_eq!(preview.context.shot.as_ref().unwrap().shot_no, 1);

        // 第二集没有形象覆盖：不能出现第一集的补充，也不能被写回全局档案。
        let ep2_preview =
            comic_prompt_render_impl(&db, &project.id, &v1.id, &ep2.id, None).unwrap();
        assert!(
            !ep2_preview.rendered.contains("浅疤") && !ep2_preview.rendered.contains("绷带"),
            "第一集的视觉补充绝不能泄漏到第二集"
        );
        assert!(!ep2_preview.context.characters[0].using_override);
        assert!(ep2_preview.context.characters[0].visual_prompt_override.is_empty());
        let characters = comic_character_list_impl(&db, &project.id).unwrap();
        let global = characters.iter().find(|item| item.id == character.id).unwrap();
        assert_eq!(global.description, "18 岁，黑色短发，运动型身材");
        assert!(
            !global.description.contains("浅疤"),
            "本集补充不得污染全局角色档案"
        );

        // 剧集级预览：没有镜头时 shot 变量为空、场景装配项目全部场景。
        let episode_preview =
            comic_prompt_render_impl(&db, &project.id, &v2.id, &ep1.id, None).unwrap();
        assert!(episode_preview.context.shot.is_none());
        assert_eq!(
            episode_preview.context.variables.get("shot.description").map(String::as_str),
            Some("")
        );

        // 镜头必须属于所选剧集。
        assert!(comic_prompt_render_impl(
            &db, &project.id, &v1.id, &ep2.id, Some(&shot.id),
        )
        .is_err());

        // 必填变量在本集/镜头没有内容时明确报错。
        let required = comic_prompt_version_create_impl(
            &db, &template.id, "台词：{{shot.dialogue}}".into(),
            r#"["shot.dialogue"]"#.into(), "台词模板".into(),
        )
        .unwrap();
        let empty_shot = comic_shot_save_impl(
            &db, None, project.id.clone(), ep1.id.clone(), None, "无台词镜头".into(),
            None, None, "".into(), "".into(), "".into(), None, "todo".into(), None, "".into(), None,
        )
        .unwrap();
        let err = comic_prompt_render_impl(
            &db, &project.id, &required.id, &ep1.id, Some(&empty_shot.id),
        )
        .unwrap_err();
        assert!(format!("{err}").contains("必填变量"), "{err}");

        // 带空格的合法占位符（v99）：{{ shot.dialogue }} 解析后变量名会 trim，
        // 必填校验必须跟随解析结果，不能因为原始字符串匹配不到而放行空内容。
        let spaced = comic_prompt_version_create_impl(
            &db, &template.id, "台词：{{ shot.dialogue }}".into(),
            r#"["shot.dialogue"]"#.into(), "空格占位符".into(),
        )
        .unwrap();
        let spaced_err = comic_prompt_render_impl(
            &db, &project.id, &spaced.id, &ep1.id, Some(&empty_shot.id),
        )
        .unwrap_err();
        assert!(
            format!("{spaced_err}").contains("必填变量"),
            "带空格占位符的必填变量不能绕过校验：{spaced_err}"
        );
        let spaced_ok =
            comic_prompt_render_impl(&db, &project.id, &spaced.id, &ep1.id, Some(&shot.id))
                .unwrap();
        assert_eq!(spaced_ok.rendered, "台词：传球！");
        // 非必填变量为空允许渲染（既有语义）：camera_move 为空且未声明必填。
        let optional = comic_prompt_version_create_impl(
            &db, &template.id, "运镜：{{ shot.camera_move }}".into(), "[]".into(),
            "非必填".into(),
        )
        .unwrap();
        let optional_preview =
            comic_prompt_render_impl(&db, &project.id, &optional.id, &ep1.id, Some(&empty_shot.id))
                .unwrap();
        assert_eq!(optional_preview.rendered, "运镜：");

        // 纯函数级安全边界：不执行代码、缺变量报错、普通文本不转义。
        let allowed = comic_prompt_variable_set();
        let mut vars = BTreeMap::new();
        assert!(render_comic_prompt_template("{{project.name}}", &vars, &allowed).is_err());
        vars.insert("project.name".into(), "示例项目".into());
        assert_eq!(
            render_comic_prompt_template("项目 {{project.name}}\n第二行", &vars, &allowed).unwrap(),
            "项目 示例项目\n第二行"
        );
        assert!(render_comic_prompt_template("{{process.exit()}}", &vars, &allowed).is_err());
        assert!(render_comic_prompt_template("{{project.name", &vars, &allowed).is_err());
        assert_eq!(
            render_comic_prompt_template("普通中文 <保留> & 符号", &vars, &allowed).unwrap(),
            "普通中文 <保留> & 符号",
            "不做 HTML 转义"
        );

        // 归档：只读预览允许，创建版本/切默认拒绝。
        workspace_project_set_status_impl(&db, &project.id, "archived".into()).unwrap();
        assert!(comic_prompt_version_create_impl(
            &db, &template.id, "归档偷渡".into(), "[]".into(), "".into(),
        )
        .is_err());
        assert!(comic_prompt_version_set_default_impl(&db, &template.id, &v2.id).is_err());
        assert!(comic_prompt_render_impl(&db, &project.id, &v1.id, &ep1.id, Some(&shot.id)).is_ok());
    }

    /// 直接向能力中心表插入一条 Skill（模拟扫描结果），并落盘 SKILL.md + 附件。
    #[allow(clippy::too_many_arguments)]
    fn seed_skill(
        db: &Db,
        dir: &std::path::Path,
        id: &str,
        name: &str,
        version: &str,
        body: &str,
        scope: &str,
        project_id: Option<&str>,
        enabled: bool,
        missing: bool,
    ) {
        std::fs::create_dir_all(dir).unwrap();
        let raw = format!(
            "---\nname: {name}\ndescription: 测试 Skill\nversion: {version}\n---\n\n{body}"
        );
        std::fs::write(dir.join("SKILL.md"), raw.as_bytes()).unwrap();
        std::fs::write(dir.join("notes.md"), "附属说明（本轮不装配进上下文）").unwrap();
        let hash = crate::capability::content_hash(raw.as_bytes());
        let now = now_iso();
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO capability_skills
                 (id, name, description, source_kind, source_path, scope, project_id, enabled,
                  risk_level, risk_notes, version, format_ok, content, content_hash, missing,
                  last_seen_at, created_at, updated_at)
                 VALUES (?1, ?2, '测试 Skill', 'discovered', ?3, ?4, ?5, ?6, 'low', '[]',
                         ?7, 1, ?8, ?9, ?10, ?11, ?11, ?11)",
                params![
                    id,
                    name,
                    dir.to_string_lossy().to_string(),
                    scope,
                    project_id,
                    i64::from(enabled),
                    version,
                    body,
                    hash,
                    i64::from(missing),
                    now
                ],
            )?;
            Ok(())
        })
        .unwrap();
    }

    /// 参考图只给可执行占位说明：本地绝对路径既不进提示词，也不需要外部模型「读文件」。
    #[test]
    fn comic_prompt_render_keeps_local_absolute_paths_out_of_prompt() {
        let db = Db::open_in_memory().unwrap();
        let project = create_comic_project(&db, "路径脱敏漫剧");
        let dir = temp_dir("ref-path");
        let character_ref = dir.join("角色参考.png");
        let scene_ref = dir.join("场景参考.png");
        std::fs::write(&character_ref, b"PNG").unwrap();
        std::fs::write(&scene_ref, b"PNG").unwrap();
        let character = comic_character_save_impl(
            &db, None, project.id.clone(), "林远".into(), "主角".into(),
            "18 岁，黑色短发".into(), Some(character_ref.to_string_lossy().into()), None,
        )
        .unwrap();
        let scene = comic_scene_save_impl(
            &db, None, project.id.clone(), "篮球场".into(), "室内体育馆".into(),
            Some(scene_ref.to_string_lossy().into()), None,
        )
        .unwrap();
        let episode = comic_episode_save_impl(
            &db, None, project.id.clone(), Some(1), "第一集".into(), "".into(), "剧本".into(),
            "draft".into(), 0, Some(vec![character.id.clone()]), None,
        )
        .unwrap();
        let shot = comic_shot_save_impl(
            &db, None, project.id.clone(), episode.id.clone(), Some(1), "起跳投篮".into(),
            Some(vec![character.id.clone()]), Some(scene.id.clone()), "".into(), "".into(),
            "".into(), None, "todo".into(), None, "".into(), None,
        )
        .unwrap();
        let template = comic_prompt_template_save_impl(
            &db, None, project.id.clone(), "路径模板".into(), "storyboard".into(), "".into(),
        )
        .unwrap();
        let version = comic_prompt_version_create_impl(
            &db, &template.id,
            "{{characters.block}}\n\n{{scene.block}}\n\n画面：{{shot.description}}".into(),
            r#"["characters.block","scene.block","shot.description"]"#.into(), "v1".into(),
        )
        .unwrap();

        let preview =
            comic_prompt_render_impl(&db, &project.id, &version.id, &episode.id, Some(&shot.id))
                .unwrap();
        let dir_text = dir.to_string_lossy().to_string();
        assert!(
            !preview.rendered.contains(&dir_text),
            "提示词不能包含本机目录：{}",
            preview.rendered
        );
        assert!(!preview.rendered.contains("角色参考.png"));
        assert!(!preview.rendered.contains("场景参考.png"));
        assert_eq!(
            preview.rendered.matches("参考图：已在 Task Dock 关联，请在外部生成工具手动上传").count(),
            2,
            "角色与场景都应使用同一句可执行占位说明"
        );
        // 结构化上下文仍保留真实路径供本机界面查看。
        assert_eq!(
            preview.context.characters[0].ref_image_path,
            character_ref.to_string_lossy().to_string()
        );
        assert_eq!(
            preview.context.scenes[0].ref_image_path,
            scene_ref.to_string_lossy().to_string()
        );
        // 其它变量不受影响。
        assert!(preview.rendered.contains("【角色】林远"));
        assert!(preview.rendered.contains("【场景】篮球场"));
        assert!(preview.rendered.contains("画面：起跳投篮"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn comic_skill_snapshots_are_immutable_and_reuse_same_content() {
        let db = Db::open_in_memory().unwrap();
        let project = create_comic_project(&db, "Skill 快照漫剧");
        let dir = temp_dir("skill-snapshot");
        let body = "这是 Skill 正文。\n包含中文与换行。";
        seed_skill(
            &db, &dir, "skill-1", "分镜助手", "1.0.0", body,
            "project", Some(&project.id), true, false,
        );

        let first = comic_skill_snapshot_capture_impl(&db, &project.id, "skill-1").unwrap();
        assert_eq!(first.skill_name, "分镜助手");
        assert_eq!(first.declared_version, "1.0.0");
        assert_eq!(first.content_snapshot, body, "快照必须是实际使用的正文");
        assert_eq!(
            first.content_hash,
            crate::capability::content_hash(body.as_bytes()),
            "快照 Hash 是实际内容版本"
        );
        assert!(first.file_count >= 2, "文件清单应包含 SKILL.md 与附件");
        assert!(first.files_manifest_json.contains("SKILL.md"));
        assert!(first.files_manifest_json.contains("sha256"));

        // 同内容重复捕获 → 复用同一条快照（幂等）。
        let again = comic_skill_snapshot_capture_impl(&db, &project.id, "skill-1").unwrap();
        assert_eq!(again.id, first.id);
        assert_eq!(
            comic_skill_snapshot_list_impl(&db, &project.id, None).unwrap().len(),
            1
        );

        // 只改 SKILL.md 声明版本（正文不变）→ 必须产生新快照，不能复用旧元数据。
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE capability_skills SET version = '1.1.0' WHERE id = 'skill-1'",
                params![],
            )?;
            Ok(())
        })
        .unwrap();
        let version_changed = comic_skill_snapshot_capture_impl(&db, &project.id, "skill-1").unwrap();
        assert_ne!(version_changed.id, first.id, "声明版本变化必须产生新快照");
        assert_eq!(version_changed.declared_version, "1.1.0");
        assert_eq!(
            version_changed.content_hash, first.content_hash,
            "正文未变，内容 Hash 必须保持一致"
        );
        assert_eq!(
            version_changed.files_manifest_hash, first.files_manifest_hash,
            "附属文件未变，清单 Hash 必须一致"
        );
        assert_ne!(
            version_changed.snapshot_fingerprint, first.snapshot_fingerprint,
            "声明版本进入指纹，指纹必须变化"
        );
        let first_after_version = comic_skill_snapshot_get_impl(&db, &first.id).unwrap();
        assert_eq!(first_after_version.declared_version, "1.0.0", "历史快照元数据不可被改写");
        assert_eq!(first_after_version.snapshot_fingerprint, first.snapshot_fingerprint);

        // 只改附属文件（正文与声明版本不变）→ 文件清单 Hash 与指纹都变化。
        std::fs::write(dir.join("notes.md"), "附属说明已更新（本轮仍不装配进上下文）").unwrap();
        let files_changed = comic_skill_snapshot_capture_impl(&db, &project.id, "skill-1").unwrap();
        assert_ne!(files_changed.id, version_changed.id);
        assert_eq!(files_changed.content_hash, first.content_hash);
        assert_eq!(files_changed.declared_version, "1.1.0");
        assert_ne!(
            files_changed.files_manifest_hash, first.files_manifest_hash,
            "附属文件变化必须体现在清单 Hash"
        );
        assert_ne!(
            files_changed.snapshot_fingerprint, version_changed.snapshot_fingerprint
        );
        assert!(files_changed.files_manifest_json.contains("notes.md"));
        // 完全相同的快照重复捕获仍然复用（四项都一致时幂等）。
        let same_again = comic_skill_snapshot_capture_impl(&db, &project.id, "skill-1").unwrap();
        assert_eq!(same_again.id, files_changed.id);
        let first_after_files = comic_skill_snapshot_get_impl(&db, &first.id).unwrap();
        assert_eq!(first_after_files.files_manifest_hash, first.files_manifest_hash);
        assert_eq!(first_after_files.files_manifest_json, first.files_manifest_json);

        // 内容变化 → 新快照；旧快照正文不变。
        let body2 = "这是更新后的 Skill 正文。\n新版本。";
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE capability_skills SET content = ?1 WHERE id = 'skill-1'",
                params![body2],
            )?;
            Ok(())
        })
        .unwrap();
        let second = comic_skill_snapshot_capture_impl(&db, &project.id, "skill-1").unwrap();
        assert_ne!(second.id, first.id);
        assert_ne!(second.content_hash, first.content_hash, "正文变化必须产生新内容 Hash");
        let first_after = comic_skill_snapshot_get_impl(&db, &first.id).unwrap();
        assert_eq!(first_after.content_snapshot, body, "历史快照不得被覆盖");
        assert_eq!(
            comic_skill_snapshot_list_impl(&db, &project.id, Some("skill-1"))
                .unwrap()
                .len(),
            4
        );

        // 原始 Skill 删除不影响历史快照（无级联外键）。
        db.with_conn(|conn| {
            conn.execute("DELETE FROM capability_skills WHERE id = 'skill-1'", params![])?;
            Ok(())
        })
        .unwrap();
        assert_eq!(
            comic_skill_snapshot_get_impl(&db, &first.id).unwrap().content_snapshot,
            body
        );
        assert_eq!(
            comic_skill_snapshot_list_impl(&db, &project.id, None).unwrap().len(),
            4
        );

        // 禁用 / 丢失 / 作用域不符都拒绝捕获。
        let dir_disabled = temp_dir("skill-disabled");
        seed_skill(
            &db, &dir_disabled, "skill-disabled", "禁用 Skill", "1.0.0", "禁用",
            "project", Some(&project.id), false, false,
        );
        assert!(comic_skill_snapshot_capture_impl(&db, &project.id, "skill-disabled").is_err());

        let dir_missing = temp_dir("skill-missing");
        seed_skill(
            &db, &dir_missing, "skill-missing", "丢失 Skill", "1.0.0", "丢失",
            "project", Some(&project.id), true, true,
        );
        assert!(comic_skill_snapshot_capture_impl(&db, &project.id, "skill-missing").is_err());

        let dir_other = temp_dir("skill-other-project");
        let other_project = create_comic_project(&db, "另一部 Skill 项目");
        seed_skill(
            &db, &dir_other, "skill-other", "他项目 Skill", "1.0.0", "他项目",
            "project", Some(&other_project.id), true, false,
        );
        assert!(comic_skill_snapshot_capture_impl(&db, &project.id, "skill-other").is_err());

        // 归档只读：捕获拒绝，读取允许。
        workspace_project_set_status_impl(&db, &project.id, "archived".into()).unwrap();
        assert!(comic_skill_snapshot_capture_impl(&db, &project.id, "skill-other").is_err());
        assert_eq!(
            comic_skill_snapshot_list_impl(&db, &project.id, None).unwrap().len(),
            4
        );
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&dir_disabled);
        let _ = std::fs::remove_dir_all(&dir_missing);
        let _ = std::fs::remove_dir_all(&dir_other);
    }

    #[test]
    fn comic_generation_records_trace_prompt_and_skill_and_link_media() {
        let db = Db::open_in_memory().unwrap();
        let project = create_comic_project(&db, "生成追溯漫剧");
        let character = comic_character_save_impl(
            &db, None, project.id.clone(), "林远".into(), "主角".into(),
            "18 岁，黑色短发".into(), None, None,
        )
        .unwrap();
        let episode = comic_episode_save_impl(
            &db, None, project.id.clone(), None, "第一集".into(), "".into(), "".into(),
            "draft".into(), 0, Some(vec![character.id.clone()]), None,
        )
        .unwrap();
        let shot = comic_shot_save_impl(
            &db, None, project.id.clone(), episode.id.clone(), None, "起跳投篮".into(),
            Some(vec![character.id.clone()]), None, "".into(), "".into(), "".into(), None,
            "todo".into(), None, "".into(), None,
        )
        .unwrap();
        let template = comic_prompt_template_save_impl(
            &db, None, project.id.clone(), "图片生成模板".into(),
            "image_generation".into(), "".into(),
        )
        .unwrap();
        let version = comic_prompt_version_create_impl(
            &db, &template.id, "{{characters.block}}\n{{shot.description}}".into(),
            r#"["characters.block","shot.description"]"#.into(), "v1".into(),
        )
        .unwrap();
        let skill_dir = temp_dir("gen-skill");
        seed_skill(
            &db, &skill_dir, "skill-gen", "生成助手", "2.0.0", "Skill 正文",
            "project", Some(&project.id), true, false,
        );
        let snapshot = comic_skill_snapshot_capture_impl(&db, &project.id, "skill-gen").unwrap();

        let fixture = temp_dir("gen-media");
        let input_path = write_v1_fixture(&fixture, "input.png", b"INPUT");
        let output_path = write_v1_fixture(&fixture, "output.png", b"OUTPUT");
        let input_media = comic_media_import_impl(
            &db, None, project.id.clone(), Some(shot.id.clone()), None, None,
            input_path.to_string_lossy().into(), "image".into(), Some("输入".into()), None,
        )
        .unwrap();

        let submitted_prompt =
            "【角色】林远\n起跳投篮（外部工具实际使用）\n参数：--ar 16:9，风格：电影感。";
        let run = comic_generation_record_create_impl(
            &db,
            ComicGenerationRecordInput {
                project_id: project.id.clone(),
                episode_id: episode.id.clone(),
                shot_id: Some(shot.id.clone()),
                prompt_version_id: version.id.clone(),
                rendered_prompt_snapshot: submitted_prompt.into(),
                skill_snapshot_id: Some(snapshot.id.clone()),
                model_provider: "Midjourney".into(),
                model_name: "v6".into(),
                model_version: "6.1".into(),
                parameters_json: Some(r#"{ "steps": 30, "ar": "16:9" }"#.into()),
                seed: "42".into(),
                input_media_ids: Some(vec![input_media.id.clone()]),
                external_job_id: "job-123".into(),
                note: "第一次外部生成".into(),
            },
        )
        .unwrap();
        assert!(run.rendered_prompt_snapshot.contains("【角色】林远"));
        assert!(run.rendered_prompt_snapshot.contains("起跳投篮"));
        // 登记内容 = 用户提交的实际文本（中文、换行、标点原样保留，不重渲染、不截断）。
        assert_eq!(run.rendered_prompt_snapshot, submitted_prompt);
        assert_eq!(run.prompt_content_hash_snapshot, version.content_hash);
        assert_eq!(run.skill_content_hash_snapshot, snapshot.content_hash);
        assert_eq!(run.skill_name.as_deref(), Some("生成助手"));
        assert_eq!(run.parameters_json, r#"{"ar":"16:9","steps":30}"#);
        assert_eq!(run.input_media_ids, vec![input_media.id.clone()]);
        assert_eq!(run.shot_no, Some(1));
        let context: serde_json::Value = serde_json::from_str(&run.context_snapshot_json).unwrap();
        assert_eq!(context["shotId"].as_str(), Some(shot.id.as_str()));
        assert_eq!(context["episodeId"].as_str(), Some(episode.id.as_str()));
        assert_eq!(context["characters"].as_array().unwrap().len(), 1);
        assert_eq!(context["truncated"].as_bool(), Some(false));

        // 空 / 纯空白 / 超长提示词必须明确拒绝，而不是静默写入空记录或截断。
        for bad_prompt in ["".to_string(), "   \n\t ".to_string()] {
            assert!(comic_generation_record_create_impl(
                &db,
                ComicGenerationRecordInput {
                    project_id: project.id.clone(),
                    episode_id: episode.id.clone(),
                    shot_id: Some(shot.id.clone()),
                    prompt_version_id: version.id.clone(),
                    rendered_prompt_snapshot: bad_prompt,
                    skill_snapshot_id: None,
                    model_provider: "".into(), model_name: "".into(), model_version: "".into(),
                    parameters_json: None, seed: "".into(), input_media_ids: None,
                    external_job_id: "".into(), note: "".into(),
                },
            )
            .is_err(), "空提示词不能登记");
        }
        let too_long = "字".repeat(MAX_PROMPT_BODY_CHARS + 1);
        assert!(comic_generation_record_create_impl(
            &db,
            ComicGenerationRecordInput {
                project_id: project.id.clone(),
                episode_id: episode.id.clone(),
                shot_id: Some(shot.id.clone()),
                prompt_version_id: version.id.clone(),
                rendered_prompt_snapshot: too_long,
                skill_snapshot_id: None,
                model_provider: "".into(), model_name: "".into(), model_version: "".into(),
                parameters_json: None, seed: "".into(), input_media_ids: None,
                external_job_id: "".into(), note: "".into(),
            },
        )
        .is_err(), "超长提示词必须拒绝而不是截断");

        // 历史快照不可修改：数据库触发器直接挡住 UPDATE。
        let tampered = db.with_conn(|conn| {
            conn.execute(
                "UPDATE comic_generation_runs SET rendered_prompt_snapshot = '被篡改' WHERE id = ?1",
                params![run.id],
            )?;
            Ok(())
        });
        assert!(tampered.is_err(), "生成记录的提示词快照必须不可修改");

        // 修改剧本 / 新建提示词版本都不会污染已有生成记录。
        comic_episode_save_impl(
            &db, Some(episode.id.clone()), project.id.clone(), None, "第一集（改稿）".into(),
            "".into(), "改稿后的剧本".into(), "draft".into(), 0,
            Some(vec![character.id.clone()]), None,
        )
        .unwrap();
        comic_prompt_version_create_impl(
            &db, &template.id, "{{characters.block}}\n{{shot.description}}\n新版补充".into(),
            "[]".into(), "v2".into(),
        )
        .unwrap();
        let stored = comic_generation_record_list_impl(&db, &project.id, None, None)
            .unwrap()
            .into_iter()
            .find(|item| item.id == run.id)
            .unwrap();
        assert_eq!(stored.rendered_prompt_snapshot, submitted_prompt);
        assert_eq!(stored.prompt_content_hash_snapshot, version.content_hash);

        // 列表按项目/剧集/镜头过滤。
        let by_project = comic_generation_record_list_impl(&db, &project.id, None, None).unwrap();
        assert_eq!(by_project.len(), 1);
        assert_eq!(
            comic_generation_record_list_impl(&db, &project.id, Some(&episode.id), Some(&shot.id))
                .unwrap()
                .len(),
            1
        );

        // 素材关联：同镜头允许一个记录对多个输出素材。
        let out1 = comic_media_import_with_run_impl(
            &db, None, project.id.clone(), Some(shot.id.clone()), None, None,
            output_path.to_string_lossy().into(), "image".into(), Some("输出 1".into()), None,
            Some(run.id.clone()),
        )
        .unwrap();
        let out2 = comic_media_import_with_run_impl(
            &db, None, project.id.clone(), Some(shot.id.clone()), None, None,
            output_path.to_string_lossy().into(), "image".into(), Some("输出 2".into()), None,
            Some(run.id.clone()),
        )
        .unwrap();
        assert_eq!(out1.generation_run_id, Some(run.id.clone()));
        assert!(out1.generation_label.as_deref().unwrap().contains("Midjourney"));
        let media = comic_media_list_impl(&db, &project.id, Some(shot.id.clone())).unwrap();
        assert!(media.iter().filter(|item| item.generation_run_id == Some(run.id.clone())).count() >= 2);
        // 反向追溯：记录能列出自己产出的素材。
        let run_with_outputs =
            comic_generation_record_list_impl(&db, &project.id, None, None).unwrap();
        let traced = run_with_outputs.iter().find(|item| item.id == run.id).unwrap();
        assert!(traced.output_media_ids.contains(&out1.id));
        assert!(traced.output_media_ids.contains(&out2.id));

        // 删除素材不删除生成历史。
        comic_media_delete_impl(&db, &out1.id).unwrap();
        assert_eq!(
            comic_generation_record_list_impl(&db, &project.id, None, None).unwrap().len(),
            1
        );
        comic_media_delete_impl(&db, &out2.id).unwrap();
        let run_after =
            comic_generation_record_list_impl(&db, &project.id, None, None).unwrap();
        assert_eq!(run_after.len(), 1);
        assert_eq!(run_after[0].rendered_prompt_snapshot, run.rendered_prompt_snapshot);

        // 整集级记录（shot_id 为空）：可关联本集任意镜头的产物，但不能跨集/跨项目。
        let shot2 = comic_shot_save_impl(
            &db, None, project.id.clone(), episode.id.clone(), Some(2), "补拍镜头".into(),
            None, None, "".into(), "".into(), "".into(), None, "todo".into(), None, "".into(), None,
        )
        .unwrap();
        let episode_run = comic_generation_record_create_impl(
            &db,
            ComicGenerationRecordInput {
                project_id: project.id.clone(),
                episode_id: episode.id.clone(),
                shot_id: None,
                prompt_version_id: version.id.clone(),
                rendered_prompt_snapshot: "整集提示词：全片统一画风".into(),
                skill_snapshot_id: Some(snapshot.id.clone()),
                model_provider: "外部工具".into(),
                model_name: "".into(),
                model_version: "".into(),
                parameters_json: None,
                seed: "".into(),
                input_media_ids: None,
                external_job_id: "job-episode".into(),
                note: "整集级生成".into(),
            },
        )
        .unwrap();
        assert!(episode_run.shot_id.is_none());
        assert_eq!(episode_run.shot_no, None);
        let ep_out_1 = comic_media_import_with_run_impl(
            &db, None, project.id.clone(), Some(shot.id.clone()), None, None,
            output_path.to_string_lossy().into(), "image".into(), Some("整集产物 1".into()), None,
            Some(episode_run.id.clone()),
        )
        .unwrap();
        let ep_out_2 = comic_media_import_with_run_impl(
            &db, None, project.id.clone(), Some(shot2.id.clone()), None, None,
            output_path.to_string_lossy().into(), "image".into(), Some("整集产物 2".into()), None,
            Some(episode_run.id.clone()),
        )
        .unwrap();
        assert_eq!(ep_out_1.generation_run_id, Some(episode_run.id.clone()));
        assert_eq!(ep_out_2.generation_run_id, Some(episode_run.id.clone()));
        let episode_run_traced = comic_generation_record_list_impl(&db, &project.id, None, None)
            .unwrap()
            .into_iter()
            .find(|item| item.id == episode_run.id)
            .unwrap();
        assert_eq!(
            episode_run_traced.output_media_ids.len(),
            2,
            "一个整集级记录可关联本集多个镜头的产物"
        );
        // 镜头级记录不能把产物挂到别的镜头。
        assert!(comic_media_import_with_run_impl(
            &db, None, project.id.clone(), Some(shot2.id.clone()), None, None,
            output_path.to_string_lossy().into(), "image".into(), Some("偷挂".into()), None,
            Some(run.id.clone()),
        )
        .is_err(), "镜头级记录只能关联自己镜头");
        // 整集级记录不能跨集。
        let ep2 = comic_episode_save_impl(
            &db, None, project.id.clone(), Some(2), "第二集".into(), "".into(), "".into(),
            "draft".into(), 0, None, None,
        )
        .unwrap();
        let ep2_shot = comic_shot_save_impl(
            &db, None, project.id.clone(), ep2.id.clone(), Some(1), "第二集镜头".into(),
            None, None, "".into(), "".into(), "".into(), None, "todo".into(), None, "".into(), None,
        )
        .unwrap();
        assert!(comic_media_import_with_run_impl(
            &db, None, project.id.clone(), Some(ep2_shot.id.clone()), None, None,
            output_path.to_string_lossy().into(), "image".into(), Some("跨集偷挂".into()), None,
            Some(episode_run.id.clone()),
        )
        .is_err(), "整集级记录不能关联其它剧集的镜头");

        // 跨项目/跨剧集/跨项目素材全部拒绝。
        let other = create_comic_project(&db, "另一部漫剧");
        let other_ep = comic_episode_save_impl(
            &db, None, other.id.clone(), None, "他项目集".into(), "".into(), "".into(),
            "draft".into(), 0, None, None,
        )
        .unwrap();
        let other_ep_shot = comic_shot_save_impl(
            &db, None, other.id.clone(), other_ep.id.clone(), Some(1), "他项目镜头".into(),
            None, None, "".into(), "".into(), "".into(), None, "todo".into(), None, "".into(), None,
        )
        .unwrap();
        let other_template = comic_prompt_template_save_impl(
            &db, None, other.id.clone(), "他项目模板".into(), "other".into(), "".into(),
        )
        .unwrap();
        let other_version = comic_prompt_version_create_impl(
            &db, &other_template.id, "{{project.name}}".into(), "[]".into(), "".into(),
        )
        .unwrap();
        assert!(comic_generation_record_create_impl(
            &db,
            ComicGenerationRecordInput {
                project_id: project.id.clone(),
                episode_id: episode.id.clone(),
                shot_id: Some(shot.id.clone()),
                prompt_version_id: other_version.id.clone(),
                rendered_prompt_snapshot: "他项目提示词".into(),
                skill_snapshot_id: None,
                model_provider: "".into(), model_name: "".into(), model_version: "".into(),
                parameters_json: None, seed: "".into(), input_media_ids: None,
                external_job_id: "".into(), note: "".into(),
            },
        )
        .is_err(), "跨项目提示词版本必须拒绝");

        assert!(comic_generation_record_create_impl(
            &db,
            ComicGenerationRecordInput {
                project_id: project.id.clone(),
                episode_id: episode.id.clone(),
                shot_id: Some(shot.id.clone()),
                prompt_version_id: version.id.clone(),
                rendered_prompt_snapshot: "【角色】林远\n同一提示词重试".into(),
                skill_snapshot_id: Some(snapshot.id.clone()),
                model_provider: "".into(), model_name: "".into(), model_version: "".into(),
                parameters_json: None, seed: "".into(), input_media_ids: None,
                external_job_id: "".into(), note: "".into(),
            },
        )
        .is_ok(), "同项目重试必须成功");
        assert!(comic_generation_record_create_impl(
            &db,
            ComicGenerationRecordInput {
                project_id: project.id.clone(),
                episode_id: other_ep.id.clone(),
                shot_id: Some(shot.id.clone()),
                prompt_version_id: version.id.clone(),
                rendered_prompt_snapshot: "跨集提示词".into(),
                skill_snapshot_id: None,
                model_provider: "".into(), model_name: "".into(), model_version: "".into(),
                parameters_json: None, seed: "".into(), input_media_ids: None,
                external_job_id: "".into(), note: "".into(),
            },
        )
        .is_err(), "镜头不属于所选剧集必须拒绝");

        assert!(comic_media_import_with_run_impl(
            &db, None, project.id.clone(), Some(shot.id.clone()), None, None,
            output_path.to_string_lossy().into(), "image".into(), Some("偷渡".into()), None,
            Some("nonexistent-run".into()),
        )
        .is_err());
        assert!(comic_media_import_with_run_impl(
            &db, None, project.id.clone(), Some(other_ep_shot.id.clone()), None, None,
            output_path.to_string_lossy().into(), "image".into(), Some("跨项目偷挂".into()), None,
            Some(episode_run.id.clone()),
        )
        .is_err(), "整集级记录也不能关联其它项目的镜头");

        // 被生成记录引用的提示词版本不能删除（RESTRICT）。
        let delete_result = db.with_conn(|conn| {
            conn.execute("DELETE FROM comic_prompt_versions WHERE id = ?1", params![version.id])?;
            Ok(())
        });
        assert!(delete_result.is_err(), "被生成记录引用的版本必须禁止删除");

        // 归档只读：登记拒绝，列表允许。
        workspace_project_set_status_impl(&db, &project.id, "archived".into()).unwrap();
        assert!(comic_generation_record_create_impl(
            &db,
            ComicGenerationRecordInput {
                project_id: project.id.clone(),
                episode_id: episode.id.clone(),
                shot_id: Some(shot.id.clone()),
                prompt_version_id: version.id.clone(),
                rendered_prompt_snapshot: "归档后不应写入".into(),
                skill_snapshot_id: None,
                model_provider: "".into(), model_name: "".into(), model_version: "".into(),
                parameters_json: None, seed: "".into(), input_media_ids: None,
                external_job_id: "".into(), note: "".into(),
            },
        )
        .is_err());
        assert!(!comic_generation_record_list_impl(&db, &project.id, None, None)
            .unwrap()
            .is_empty());

        let _ = std::fs::remove_dir_all(&fixture);
        let _ = std::fs::remove_dir_all(&skill_dir);
    }

    #[test]
    fn comic_v96_tables_roundtrip_in_full_and_quick_backup() {
        let db = Db::open_in_memory().unwrap();
        let fx = seed_fixture_data(&db);
        let character = fx.characters[0].clone();
        let episode = fx.episodes[0].clone();
        let shot = fx.shots[0].clone();

        save_override(
            &db, &fx.project.id, &episode.id, &character.id,
            "学生", "高中时期", "16 岁", "蓝白校服", "正常状态",
        );
        let template = comic_prompt_template_save_impl(
            &db, None, fx.project.id.clone(), "备份模板".into(), "storyboard".into(),
            "备份往返".into(),
        )
        .unwrap();
        let version = comic_prompt_version_create_impl(
            &db, &template.id, "{{episode.title}}\n{{characters.block}}".into(),
            r#"["episode.title"]"#.into(), "v1".into(),
        )
        .unwrap();
        let skill_dir = temp_dir("backup-skill");
        seed_skill(
            &db, &skill_dir, "skill-backup", "备份 Skill", "3.0.0", "快照正文",
            "project", Some(&fx.project.id), true, false,
        );
        let snapshot = comic_skill_snapshot_capture_impl(&db, &fx.project.id, "skill-backup").unwrap();

        let fixture_dir = temp_dir("backup-v96-media");
        let output_path = write_v1_fixture(&fixture_dir, "out.png", b"OUT");
        let run = comic_generation_record_create_impl(
            &db,
            ComicGenerationRecordInput {
                project_id: fx.project.id.clone(),
                episode_id: episode.id.clone(),
                shot_id: Some(shot.id.clone()),
                prompt_version_id: version.id.clone(),
                rendered_prompt_snapshot: "备份用例提示词：第一行\n第二行（含中文标点）。".into(),
                skill_snapshot_id: Some(snapshot.id.clone()),
                model_provider: "外部工具".into(),
                model_name: "model-x".into(),
                model_version: "1".into(),
                parameters_json: Some(r#"{"steps":20}"#.into()),
                seed: "7".into(),
                input_media_ids: None,
                external_job_id: "job-backup".into(),
                note: "备份用例".into(),
            },
        )
        .unwrap();
        let output = comic_media_import_with_run_impl(
            &db, None, fx.project.id.clone(), Some(shot.id.clone()), None, None,
            output_path.to_string_lossy().into(), "image".into(), Some("输出".into()), None,
            Some(run.id.clone()),
        )
        .unwrap();
        assert_eq!(output.generation_run_id, Some(run.id.clone()));

        for kind in [BackupKind::Full, BackupKind::Quick] {
            let dir = temp_dir("v96-roundtrip");
            let target = dir.join("backup.json");
            write_bundle(&db, BackupSources::default(), &target, kind).unwrap();
            let staging = dir.join("staging");
            let read = read_bundle(&target, &staging).unwrap();

            let dst = Db::open_in_memory().unwrap();
            let parsed = data::validate_bundle(&dst, &read.data, &read.rows_dir).unwrap();
            data::import_parsed_with(
                &dst,
                parsed,
                &ImportOptions { allow_extended: true, commit_marker: None },
            )
            .unwrap();

            let overrides = comic_episode_character_override_list_impl(
                &dst, &fx.project.id, &episode.id,
            )
            .unwrap();
            assert_eq!(overrides.len(), 1, "{kind:?} 恢复后形象覆盖丢失");
            assert_eq!(overrides[0].costume_description, "蓝白校服");
            assert_eq!(overrides[0].character.name, "黑发少年");

            let versions = comic_prompt_version_list_impl(&dst, &template.id).unwrap();
            assert_eq!(versions.len(), 1, "{kind:?} 恢复后提示词版本丢失");
            assert_eq!(versions[0].content, "{{episode.title}}\n{{characters.block}}");

            let snapshots = comic_skill_snapshot_list_impl(&dst, &fx.project.id, None).unwrap();
            assert_eq!(snapshots.len(), 1, "{kind:?} 恢复后 Skill 快照丢失");
            assert_eq!(snapshots[0].content_snapshot, "快照正文");
            assert_eq!(
                snapshots[0].snapshot_fingerprint, snapshot.snapshot_fingerprint,
                "{kind:?} 恢复后快照指纹必须一致"
            );
            assert_eq!(snapshots[0].declared_version, "3.0.0");
            assert_eq!(
                snapshots[0].files_manifest_hash, snapshot.files_manifest_hash,
                "{kind:?} 恢复后附属文件清单 Hash 必须一致"
            );

            let runs = comic_generation_record_list_impl(&dst, &fx.project.id, None, None).unwrap();
            assert_eq!(runs.len(), 1, "{kind:?} 恢复后生成记录丢失");
            assert_eq!(runs[0].skill_content_hash_snapshot, snapshot.content_hash);
            assert_eq!(runs[0].rendered_prompt_snapshot, run.rendered_prompt_snapshot);
            assert!(
                runs[0].output_media_ids.contains(&output.id),
                "{kind:?} 恢复后生成记录↔输出素材的反向追溯丢失"
            );

            let media = comic_media_list_impl(&dst, &fx.project.id, Some(shot.id.clone())).unwrap();
            let restored_output = media.iter().find(|item| item.id == output.id).unwrap();
            assert_eq!(
                restored_output.generation_run_id,
                Some(run.id.clone()),
                "{kind:?} 恢复后素材↔生成记录关联丢失"
            );
            let violations: i64 = dst
                .with_read(|conn| {
                    Ok(conn.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |r| {
                        r.get(0)
                    })?)
                })
                .unwrap();
            assert_eq!(violations, 0, "{kind:?} 恢复后外键必须完整");
            let _ = std::fs::remove_dir_all(&dir);
        }
        let _ = std::fs::remove_dir_all(&skill_dir);
        let _ = std::fs::remove_dir_all(&fixture_dir);
    }
}
