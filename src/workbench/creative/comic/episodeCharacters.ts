//! 每集角色形象合并（纯函数，2026-11-23 第三阶段）。
//!
//! 语义（与后端 `ComicEpisodeCharacterOverride` 一致）：
//! - 全局 `ComicCharacter` 是基础事实来源；覆盖只描述「这一集」；
//! - 覆盖字段为空 ⇒ 必须回落到全局值，绝不允许「清空本集形象」把角色档案清空；
//! - 参考图同理：只有本集专用参考图非空时才替换全局参考图；
//! - `sources` 明确标注每个字段实际来自哪里，界面据此显示「本集 / 全局」。
//!
//! 这个函数不读 IPC、不改数据，只做合并，便于单测与两个面板复用。

import type {
  ComicCharacter,
  ComicEpisodeCharacterOverride,
  EffectiveEpisodeCharacter,
} from "./types";

function hasText(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

export function getEffectiveEpisodeCharacter(
  character: ComicCharacter,
  override: ComicEpisodeCharacterOverride | null,
): EffectiveEpisodeCharacter {
  const roleFromOverride = hasText(override?.roleInEpisode);
  const appearanceFromOverride = hasText(override?.appearanceDescription);
  const refImageFromOverride = hasText(override?.refImagePath);

  return {
    character,
    override,
    usingOverride: override !== null,
    role: roleFromOverride ? override!.roleInEpisode : character.role,
    appearanceLabel: override?.appearanceLabel ?? "",
    appearanceDescription: appearanceFromOverride
      ? override!.appearanceDescription
      : character.description,
    costumeDescription: override?.costumeDescription ?? "",
    hairStyleDescription: override?.hairStyleDescription ?? "",
    stateDescription: override?.stateDescription ?? "",
    visualPromptOverride: override?.visualPromptOverride ?? "",
    refImagePath: refImageFromOverride ? override!.refImagePath : character.refImagePath,
    refImageExists: refImageFromOverride
      ? override!.refImageExists
      : character.refImageExists,
    usingOverrideRefImage: refImageFromOverride,
    sources: {
      role: roleFromOverride ? "override" : "base",
      appearanceDescription: appearanceFromOverride ? "override" : "base",
      costumeDescription: hasText(override?.costumeDescription) ? "override" : "none",
      hairStyleDescription: hasText(override?.hairStyleDescription) ? "override" : "none",
      stateDescription: hasText(override?.stateDescription) ? "override" : "none",
    },
  };
}

/** 按角色 ID 建索引，供列表/选择器 O(1) 查覆盖。 */
export function indexOverrides(
  overrides: ComicEpisodeCharacterOverride[],
): Map<string, ComicEpisodeCharacterOverride> {
  const map = new Map<string, ComicEpisodeCharacterOverride>();
  for (const override of overrides) map.set(override.characterId, override);
  return map;
}

/** 只合并「本集出场名单」内的角色，顺序保持剧集名单顺序。 */
export function effectiveCharactersForEpisode(
  characters: ComicCharacter[],
  episodeCharacterIds: string[],
  overrides: ComicEpisodeCharacterOverride[],
): EffectiveEpisodeCharacter[] {
  const byId = new Map(characters.map((character) => [character.id, character]));
  const overrideById = indexOverrides(overrides);
  const out: EffectiveEpisodeCharacter[] = [];
  for (const id of episodeCharacterIds) {
    const character = byId.get(id);
    if (!character) continue;
    out.push(getEffectiveEpisodeCharacter(character, overrideById.get(id) ?? null));
  }
  return out;
}

/** 本集形象摘要：用于分镜选择器/角色卡副标题，避免在 JSX 里散落三元表达式。 */
export function episodeLookLabel(effective: EffectiveEpisodeCharacter): string {
  if (effective.usingOverride && hasText(effective.appearanceLabel)) {
    return `本集形象：${effective.appearanceLabel}`;
  }
  if (effective.usingOverride) return "本集形象已调整";
  return "沿用全局形象";
}
