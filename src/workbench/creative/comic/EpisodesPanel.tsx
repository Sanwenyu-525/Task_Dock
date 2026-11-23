//! 剧集与剧本模块（C1 / C3）：剧集列表、编号、标题、简介、剧本正文、状态、进度、
//! 出场角色关联与排序；本集角色形象覆盖编辑（v96）。
//!
//! ## 本轮（2026-11-23 第三阶段）
//! - 全局角色档案仍是基础事实来源：每集只写 `comic_episode_character_overrides`，
//!   不改 `comic_characters`；
//! - 出场角色复选框仍是**唯一的**本集名单（复用 `comic_episodes.character_ids_json`），
//!   卡片只负责展示/编辑「这一集」的形象；
//! - 移出本集前先检查本集镜头引用；后端也会拒绝，前端提前给出「还有几个镜头」；
//! - 归档只读；失败可见 + 可重试；切项目由壳层换 key 重挂。
//!
//! 2026-11-23 第二轮：按剧集派生镜头统计（总数 / 待办 / 进行中 / 阻塞 / 完成 +
//! 镜头完成比例）。统计只读真实镜头数据，不新增持久化字段，也不覆盖剧集制作进度。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { Select, type SelectOption } from "../../../components/ui";
import type { CreativeModuleProps } from "../types";
import {
  comicCharacterList,
  comicEpisodeCharacterOverrideDelete,
  comicEpisodeCharacterOverrideList,
  comicEpisodeCharacterOverrideSave,
  comicEpisodeDelete,
  comicEpisodeList,
  comicEpisodeReorder,
  comicEpisodeSave,
  comicShotList,
} from "./ipc";
import {
  EPISODE_STATUS_LABELS,
  type ComicCharacter,
  type ComicEpisode,
  type ComicEpisodeCharacterOverride,
  type ComicShot,
  type EpisodeStatus,
} from "./types";
import {
  getEffectiveEpisodeCharacter,
  indexOverrides,
  episodeLookLabel,
} from "./episodeCharacters";
import { buildEpisodeShotStats, EMPTY_EPISODE_STATS } from "./shotStats";
import { ArchivedBanner, errorText, Field, LoadError } from "./shared";
import { MediaThumb } from "./MediaPreview";

const STATUS_OPTIONS: SelectOption<EpisodeStatus>[] = (
  Object.keys(EPISODE_STATUS_LABELS) as EpisodeStatus[]
).map((value) => ({ value, label: EPISODE_STATUS_LABELS[value] }));

const REF_IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif"];

interface EpisodeDraft {
  title: string;
  episodeNo: string;
  synopsis: string;
  script: string;
  status: EpisodeStatus;
  progress: string;
  characterIds: string[];
}

const EMPTY_DRAFT: EpisodeDraft = {
  title: "",
  episodeNo: "",
  synopsis: "",
  script: "",
  status: "draft",
  progress: "0",
  characterIds: [],
};

interface AppearanceDraft {
  roleInEpisode: string;
  appearanceLabel: string;
  appearanceDescription: string;
  costumeDescription: string;
  hairStyleDescription: string;
  stateDescription: string;
  visualPromptOverride: string;
  refImagePath: string;
}

const EMPTY_APPEARANCE: AppearanceDraft = {
  roleInEpisode: "",
  appearanceLabel: "",
  appearanceDescription: "",
  costumeDescription: "",
  hairStyleDescription: "",
  stateDescription: "",
  visualPromptOverride: "",
  refImagePath: "",
};

function appearanceDraftOf(
  override: ComicEpisodeCharacterOverride | null,
): AppearanceDraft {
  if (!override) return { ...EMPTY_APPEARANCE };
  return {
    roleInEpisode: override.roleInEpisode,
    appearanceLabel: override.appearanceLabel,
    appearanceDescription: override.appearanceDescription,
    costumeDescription: override.costumeDescription,
    hairStyleDescription: override.hairStyleDescription,
    stateDescription: override.stateDescription,
    visualPromptOverride: override.visualPromptOverride,
    refImagePath: override.refImagePath,
  };
}

export function EpisodesPanel({ projectId, archived, onNotice }: CreativeModuleProps) {
  const [episodes, setEpisodes] = useState<ComicEpisode[]>([]);
  const [characters, setCharacters] = useState<ComicCharacter[]>([]);
  const [shots, setShots] = useState<ComicShot[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<EpisodeDraft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deleteArmed, setDeleteArmed] = useState(false);

  /** 本集形象覆盖（只允许当前剧集；切剧集立即重载）。 */
  const [overrides, setOverrides] = useState<ComicEpisodeCharacterOverride[]>([]);
  const [overrideLoading, setOverrideLoading] = useState(false);
  const [overrideError, setOverrideError] = useState<string | null>(null);
  const [editingCharacterId, setEditingCharacterId] = useState<string | null>(null);
  const [appearanceDraft, setAppearanceDraft] = useState<AppearanceDraft>(EMPTY_APPEARANCE);
  const [appearanceSaving, setAppearanceSaving] = useState(false);
  const [appearanceError, setAppearanceError] = useState<string | null>(null);
  const [resetArmedId, setResetArmedId] = useState<string | null>(null);
  const [pickingRef, setPickingRef] = useState(false);

  const seqRef = useRef(0);
  const overrideSeqRef = useRef(0);

  const loadAll = useCallback(async () => {
    const token = ++seqRef.current;
    setLoading(true);
    try {
      const [episodeResult, characterResult, shotResult] = await Promise.all([
        comicEpisodeList(projectId),
        comicCharacterList(projectId),
        comicShotList(projectId, null),
      ]);
      if (token !== seqRef.current) return;
      setEpisodes(episodeResult.episodes ?? []);
      setCharacters(characterResult.characters ?? []);
      setShots(shotResult.shots ?? []);
      setLoadError(null);
    } catch (error) {
      if (token !== seqRef.current) return;
      setLoadError(errorText(error));
    } finally {
      if (token === seqRef.current) setLoading(false);
    }
  }, [projectId]);

  /** 加载当前剧集角色覆盖；空剧集/未保存剧集直接清空，避免串集。 */
  const loadEpisodeCharacterOverrides = useCallback(
    async (episodeId: string): Promise<void> => {
      const token = ++overrideSeqRef.current;
      if (!episodeId) {
        setOverrides([]);
        setOverrideError(null);
        return;
      }
      setOverrideLoading(true);
      try {
        const result = await comicEpisodeCharacterOverrideList(projectId, episodeId);
        if (token !== overrideSeqRef.current) return;
        setOverrides(result.overrides ?? []);
        setOverrideError(null);
      } catch (error) {
        if (token !== overrideSeqRef.current) return;
        setOverrideError(errorText(error));
      } finally {
        if (token === overrideSeqRef.current) setOverrideLoading(false);
      }
    },
    [projectId],
  );

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  useEffect(() => {
    if (!selectedId || creating) {
      setOverrides([]);
      setEditingCharacterId(null);
      return;
    }
    void loadEpisodeCharacterOverrides(selectedId);
  }, [selectedId, creating, loadEpisodeCharacterOverrides]);

  function selectEpisode(episode: ComicEpisode) {
    setCreating(false);
    setSelectedId(episode.id);
    setDraft({
      title: episode.title,
      episodeNo: episode.episodeNo > 0 ? String(episode.episodeNo) : "",
      synopsis: episode.synopsis,
      script: episode.script,
      status: episode.status,
      progress: String(episode.progress),
      characterIds: episode.characterIds,
    });
    setSaveError(null);
    setDeleteArmed(false);
    setEditingCharacterId(null);
    setAppearanceError(null);
    setResetArmedId(null);
  }

  function resetDetail(openForCreate: boolean) {
    setSelectedId(null);
    setCreating(openForCreate);
    setDraft(EMPTY_DRAFT);
    setSaveError(null);
    setDeleteArmed(false);
    setOverrides([]);
    setEditingCharacterId(null);
    setAppearanceError(null);
    setResetArmedId(null);
  }

  function startNew() {
    resetDetail(true);
  }

  function toggleCharacter(characterId: string) {
    setDraft((prev) => ({
      ...prev,
      characterIds: prev.characterIds.includes(characterId)
        ? prev.characterIds.filter((id) => id !== characterId)
        : [...prev.characterIds, characterId],
    }));
    setSaveError(null);
  }

  async function saveEpisode() {
    if (archived || saving) return;
    if (!draft.title.trim()) {
      setSaveError("剧集标题不能为空");
      return;
    }
    const progress = Number.parseInt(draft.progress, 10);
    if (Number.isNaN(progress) || progress < 0 || progress > 100) {
      setSaveError("制作进度必须在 0–100 之间");
      return;
    }
    const episodeNo = draft.episodeNo.trim();
    // 角色为弱引用：角色被删除后 JSON 里可能残留失效 ID，保存前按当前清单裁剪，
    // 避免不可见的悬空引用把后端归属校验卡住。
    const knownCharacterIds = new Set(characters.map((character) => character.id));
    const characterIds = draft.characterIds.filter((id) => knownCharacterIds.has(id));

    // P0：移出本集前先查本集镜头引用。后端仍会拒绝，这里提前给出「还有几个镜头」。
    const savedRoster = new Set(selected?.characterIds ?? []);
    const removedIds = [...savedRoster].filter((id) => !characterIds.includes(id));
    for (const removedId of removedIds) {
      const referenceCount = shots.filter(
        (shot) =>
          shot.episodeId === selectedId &&
          (shot.characterIds ?? []).includes(removedId),
      ).length;
      if (referenceCount > 0) {
        const name = characters.find((item) => item.id === removedId)?.name ?? removedId;
        setSaveError(
          `角色「${name}」仍被本集 ${referenceCount} 个镜头引用，不能移出本集；` +
            "请先在「分镜」模块修改这些镜头的出场角色",
        );
        return;
      }
    }

    setSaving(true);
    setSaveError(null);
    try {
      const result = await comicEpisodeSave({
        id: selectedId,
        projectId,
        episodeNo: episodeNo ? Number.parseInt(episodeNo, 10) : null,
        title: draft.title,
        synopsis: draft.synopsis,
        script: draft.script,
        status: draft.status,
        progress,
        characterIds,
      });
      onNotice("ok", selectedId ? "剧集已更新" : `已新建剧集「${result.episode.title}」`);
      await loadAll();
      selectEpisode(result.episode);
      // 出场名单可能变化：重新拉覆盖（新加入的角色没有覆盖，移出的不返回）。
      await loadEpisodeCharacterOverrides(result.episode.id);
    } catch (error) {
      setSaveError(errorText(error));
      onNotice("error", `保存剧集失败：${errorText(error)}`);
    } finally {
      setSaving(false);
    }
  }

  async function removeEpisode() {
    if (!selectedId || archived || saving) return;
    if (!deleteArmed) {
      setDeleteArmed(true);
      return;
    }
    setSaving(true);
    try {
      await comicEpisodeDelete(selectedId);
      onNotice("ok", "剧集已删除");
      resetDetail(false);
      await loadAll();
    } catch (error) {
      onNotice("error", `删除剧集失败：${errorText(error)}`);
    } finally {
      setSaving(false);
      setDeleteArmed(false);
    }
  }

  async function moveEpisode(index: number, direction: -1 | 1) {
    if (archived || saving) return;
    const target = index + direction;
    if (target < 0 || target >= episodes.length) return;
    const reordered = [...episodes];
    const [moved] = reordered.splice(index, 1);
    reordered.splice(target, 0, moved);
    setSaving(true);
    try {
      const result = await comicEpisodeReorder(
        projectId,
        reordered.map((episode) => episode.id),
      );
      setEpisodes(result.episodes ?? reordered);
      onNotice("ok", "剧集顺序已保存");
    } catch (error) {
      onNotice("error", `排序失败：${errorText(error)}`);
      await loadAll();
    } finally {
      setSaving(false);
    }
  }

  /** 保存本集形象覆盖：只提交覆盖字段，绝不写回全局角色档案。 */
  async function saveEpisodeCharacterOverride(characterId: string): Promise<void> {
    if (archived || appearanceSaving) return;
    if (!selectedId) {
      setAppearanceError("请先保存剧集，再编辑本集形象");
      return;
    }
    setAppearanceSaving(true);
    setAppearanceError(null);
    try {
      const result = await comicEpisodeCharacterOverrideSave({
        projectId,
        episodeId: selectedId,
        characterId,
        roleInEpisode: appearanceDraft.roleInEpisode,
        appearanceLabel: appearanceDraft.appearanceLabel,
        appearanceDescription: appearanceDraft.appearanceDescription,
        costumeDescription: appearanceDraft.costumeDescription,
        hairStyleDescription: appearanceDraft.hairStyleDescription,
        stateDescription: appearanceDraft.stateDescription,
        visualPromptOverride: appearanceDraft.visualPromptOverride,
        refImagePath: appearanceDraft.refImagePath,
      });
      setOverrides((prev) => {
        const rest = prev.filter((item) => item.characterId !== characterId);
        return [...rest, result.record];
      });
      const name = characters.find((item) => item.id === characterId)?.name ?? "角色";
      onNotice("ok", `已保存「${name}」的本集形象（全局档案未修改）`);
    } catch (error) {
      setAppearanceError(errorText(error));
      onNotice("error", `保存本集形象失败：${errorText(error)}`);
    } finally {
      setAppearanceSaving(false);
    }
  }

  /** 删除本集覆盖 = 恢复全局档案；只删本集覆盖，不删全局角色。 */
  async function resetEpisodeCharacterOverride(characterId: string): Promise<void> {
    if (archived || appearanceSaving) return;
    if (!selectedId) return;
    if (resetArmedId !== characterId) {
      setResetArmedId(characterId);
      return;
    }
    setAppearanceSaving(true);
    setAppearanceError(null);
    try {
      await comicEpisodeCharacterOverrideDelete(projectId, selectedId, characterId);
      setOverrides((prev) => prev.filter((item) => item.characterId !== characterId));
      setEditingCharacterId(null);
      setAppearanceDraft({ ...EMPTY_APPEARANCE });
      const name = characters.find((item) => item.id === characterId)?.name ?? "角色";
      onNotice("ok", `已恢复「${name}」的全局形象`);
    } catch (error) {
      setAppearanceError(errorText(error));
      onNotice("error", `恢复全局形象失败：${errorText(error)}`);
    } finally {
      setAppearanceSaving(false);
      setResetArmedId(null);
    }
  }

  function startEditAppearance(
    character: ComicCharacter,
    override: ComicEpisodeCharacterOverride | null,
  ) {
    setEditingCharacterId(character.id);
    setAppearanceDraft(appearanceDraftOf(override));
    setAppearanceError(null);
    setResetArmedId(null);
  }

  async function pickOverrideRefImage() {
    if (archived || appearanceSaving || pickingRef) return;
    setPickingRef(true);
    try {
      const selected = await openFileDialog({
        multiple: false,
        directory: false,
        title: "选择本集专用参考图（只登记路径，不复制文件）",
        filters: [{ name: "图片", extensions: REF_IMAGE_EXTENSIONS }],
      });
      if (typeof selected !== "string") return;
      setAppearanceDraft((prev) => ({ ...prev, refImagePath: selected }));
    } catch (error) {
      setAppearanceError(`选择图片失败：${errorText(error)}`);
    } finally {
      setPickingRef(false);
    }
  }

  const selected = episodes.find((episode) => episode.id === selectedId) ?? null;
  const editorOpen = creating || selected !== null;
  const savedRoster = useMemo(
    () => new Set(selected?.characterIds ?? []),
    [selected],
  );
  const overrideById = useMemo(() => indexOverrides(overrides), [overrides]);

  /** 派生统计：只依赖真实镜头数据，不落库、不覆盖剧集进度。 */
  const shotStats = useMemo(() => buildEpisodeShotStats(shots), [shots]);
  const selectedStats = selected ? (shotStats.get(selected.id) ?? EMPTY_EPISODE_STATS) : null;
  const shotRatioSuffix = (episodeId: string) => {
    const stats = shotStats.get(episodeId);
    return stats ? `（完成 ${stats.doneRatio}%）` : "";
  };

  const draftCharacters = draft.characterIds
    .map((id) => characters.find((character) => character.id === id))
    .filter((character): character is ComicCharacter => Boolean(character));

  return (
    <div className="comic-layout">
      <aside className="comic-pane comic-pane-list" aria-label="剧集列表">
        <div className="comic-toolbar">
          <button type="button" className="ws-btn ws-btn-primary" disabled={archived} onClick={startNew}>
            新建剧集
          </button>
        </div>

        {loadError && <LoadError message={loadError} onRetry={() => void loadAll()} />}
        {loading && !loadError && <p className="ws-empty">加载中…</p>}

        <ul className="ws-list">
          {episodes.map((episode, index) => (
            <li key={episode.id}>
              <div
                className={`comic-list-row${episode.id === selectedId ? " is-active" : ""}`}
              >
                <button
                  type="button"
                  className="comic-row-main"
                  onClick={() => selectEpisode(episode)}
                >
                  <span className="comic-row-title">
                    第 {episode.episodeNo} 集 · {episode.title}
                  </span>
                  <span className="ws-meta">
                    {EPISODE_STATUS_LABELS[episode.status]} · 进度 {episode.progress}% ·{" "}
                    {episode.shotCount} 个镜头
                    {shotRatioSuffix(episode.id)}
                  </span>
                </button>
                <span className="comic-row-actions">
                  <button
                    type="button"
                    className="ws-btn ws-btn-quiet"
                    aria-label="上移"
                    disabled={archived || index === 0}
                    onClick={() => void moveEpisode(index, -1)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="ws-btn ws-btn-quiet"
                    aria-label="下移"
                    disabled={archived || index === episodes.length - 1}
                    onClick={() => void moveEpisode(index, 1)}
                  >
                    ↓
                  </button>
                </span>
              </div>
            </li>
          ))}
          {!loading && episodes.length === 0 && !loadError && (
            <li className="ws-empty">暂无剧集，点击「新建剧集」开始。</li>
          )}
        </ul>
      </aside>

      <div className="comic-pane comic-pane-detail">
        {archived && <ArchivedBanner />}

        {!editorOpen && !loading && (
          <p className="ws-empty">从左侧选择剧集，或新建剧集与剧本。</p>
        )}

        {editorOpen && (
          <div className="comic-form">
            <div className="ws-grid">
              <Field label="剧集标题" htmlFor="comic-ep-title">
                <input
                  id="comic-ep-title"
                  type="text"
                  className="ws-input"
                  disabled={archived || saving}
                  value={draft.title}
                  onChange={(event) => setDraft({ ...draft, title: event.target.value })}
                />
              </Field>
              <Field label="集号" htmlFor="comic-ep-no" hint="留空自动顺延">
                <input
                  id="comic-ep-no"
                  type="number"
                  min={1}
                  className="ws-input"
                  disabled={archived || saving}
                  value={draft.episodeNo}
                  onChange={(event) => setDraft({ ...draft, episodeNo: event.target.value })}
                />
              </Field>
            </div>

            <Field label="剧情简介" htmlFor="comic-ep-synopsis">
              <textarea
                id="comic-ep-synopsis"
                className="ws-textarea"
                rows={3}
                disabled={archived || saving}
                value={draft.synopsis}
                onChange={(event) => setDraft({ ...draft, synopsis: event.target.value })}
              />
            </Field>

            <Field label="剧本内容" htmlFor="comic-ep-script">
              <textarea
                id="comic-ep-script"
                className="ws-textarea comic-script"
                rows={10}
                disabled={archived || saving}
                value={draft.script}
                onChange={(event) => setDraft({ ...draft, script: event.target.value })}
              />
            </Field>

            <div className="ws-grid">
              <Field label="剧集状态">
                <Select
                  value={draft.status}
                  options={STATUS_OPTIONS}
                  onChange={(value) => setDraft({ ...draft, status: value })}
                  ariaLabel="剧集状态"
                  disabled={archived || saving}
                />
              </Field>
              <Field label="制作进度" htmlFor="comic-ep-progress">
                <input
                  id="comic-ep-progress"
                  type="number"
                  min={0}
                  max={100}
                  className="ws-input"
                  disabled={archived || saving}
                  value={draft.progress}
                  onChange={(event) => setDraft({ ...draft, progress: event.target.value })}
                />
              </Field>
            </div>

            {selectedStats && (
              <section className="comic-episode-stats" aria-label="本集镜头统计">
                <div className="comic-stats-head">
                  <span className="comic-field-label">镜头完成情况</span>
                  <span className="ws-meta">来自本集真实镜头状态</span>
                </div>
                <div className="comic-stats-grid">
                  <span>
                    镜头总数 <strong>{selectedStats.total}</strong>
                  </span>
                  <span>
                    待办 <strong>{selectedStats.todo}</strong>
                  </span>
                  <span>
                    进行中 <strong>{selectedStats.doing}</strong>
                  </span>
                  <span>
                    阻塞 <strong>{selectedStats.blocked}</strong>
                  </span>
                  <span>
                    已完成 <strong>{selectedStats.done}</strong>
                  </span>
                </div>
                <div
                  className="comic-stats-bar"
                  role="img"
                  aria-label={`镜头完成比例 ${selectedStats.doneRatio}%`}
                >
                  <span style={{ width: `${selectedStats.doneRatio}%` }} />
                </div>
                <p className="ws-meta">
                  镜头完成比例 {selectedStats.doneRatio}%（{selectedStats.done}/
                  {selectedStats.total}）；仅由分镜状态派生，不写入也不覆盖上方「制作进度」。
                </p>
              </section>
            )}

            {characters.length > 0 && (
              <fieldset className="comic-check-group">
                <legend className="comic-field-label">
                  出场角色
                  <em className="comic-field-hint">
                    勾选即加入本集名单；分镜只能选择这里的角色
                  </em>
                </legend>
                <div className="comic-check-grid">
                  {characters.map((character) => (
                    <label key={character.id} className="comic-check">
                      <input
                        type="checkbox"
                        checked={draft.characterIds.includes(character.id)}
                        disabled={archived || saving}
                        onChange={() => toggleCharacter(character.id)}
                      />
                      <span>{character.name}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            )}

            {characters.length === 0 && (
              <p className="ws-meta">
                本项目还没有全局角色。请先到「角色与场景」建立角色档案，再回到本集勾选出场。
              </p>
            )}

            <section className="comic-character-cards" aria-label="本集角色形象">
              <div className="comic-stats-head">
                <span className="comic-field-label">本集角色形象</span>
                <span className="ws-meta">
                  只影响这一集；未填写时自动沿用全局档案
                </span>
              </div>

              {overrideLoading && <p className="ws-meta">加载本集形象…</p>}
              {overrideError && (
                <p className="ws-notice" data-tone="error" role="alert">
                  <span>{overrideError}</span>
                  <button
                    type="button"
                    className="ws-btn"
                    onClick={() => selectedId && void loadEpisodeCharacterOverrides(selectedId)}
                  >
                    重试
                  </button>
                </p>
              )}

              {draftCharacters.length === 0 && (
                <p className="ws-meta">
                  本集还没有出场角色。先在上方勾选角色并保存剧集，之后即可设置本集服装、发型与状态。
                </p>
              )}

              <div className="comic-character-card-grid">
                {draftCharacters.map((character) => {
                  const override = overrideById.get(character.id) ?? null;
                  const effective = getEffectiveEpisodeCharacter(character, override);
                  const canEdit =
                    !archived &&
                    !creating &&
                    selected !== null &&
                    savedRoster.has(character.id);
                  const editing = editingCharacterId === character.id;
                  return (
                    <article className="comic-character-card" key={character.id}>
                      <div className="comic-character-card-head">
                        <MediaThumb
                          path={effective.refImagePath}
                          kind="image"
                          exists={effective.refImageExists}
                          placeholder={effective.refImagePath ? "参考图缺失" : "无参考图"}
                        />
                        <div className="comic-character-card-title">
                          <strong>{character.name}</strong>
                          <span className="ws-meta">
                            {character.role ? `全局定位：${character.role}` : "未填写全局定位"}
                          </span>
                          <span className="ws-meta comic-character-global">
                            全局基础设定：{character.description || "（未填写）"}
                          </span>
                          <span className="comic-character-badge" data-tone={override ? "override" : "base"}>
                            {override
                              ? `本集形象${effective.appearanceLabel ? `：${effective.appearanceLabel}` : "已调整"}`
                              : episodeLookLabel(effective)}
                          </span>
                          {effective.usingOverrideRefImage && (
                            <span className="ws-meta">使用本集专用参考图</span>
                          )}
                        </div>
                      </div>

                      <dl className="comic-character-facts">
                        <div>
                          <dt>本集外貌</dt>
                          <dd>
                            {effective.sources.appearanceDescription === "override"
                              ? effective.appearanceDescription
                              : "沿用全局基础设定"}
                          </dd>
                        </div>
                        <div>
                          <dt>本集服装</dt>
                          <dd>{effective.costumeDescription || "未设置"}</dd>
                        </div>
                        <div>
                          <dt>本集状态</dt>
                          <dd>{effective.stateDescription || "未设置"}</dd>
                        </div>
                      </dl>

                      <div className="comic-character-card-actions">
                        <button
                          type="button"
                          className="ws-btn"
                          disabled={!canEdit || appearanceSaving || saving}
                          aria-expanded={editing}
                          onClick={() =>
                            editing
                              ? setEditingCharacterId(null)
                              : startEditAppearance(character, override)
                          }
                        >
                          {editing ? "收起编辑" : "编辑本集形象"}
                        </button>
                        <button
                          type="button"
                          className="ws-btn ws-btn-quiet"
                          disabled={archived || saving}
                          onClick={() => toggleCharacter(character.id)}
                        >
                          移出本集
                        </button>
                        {override && (
                          <button
                            type="button"
                            className={`ws-btn ws-btn-danger${
                              resetArmedId === character.id ? " is-armed" : ""
                            }`}
                            disabled={!canEdit || appearanceSaving || saving}
                            onClick={() => void resetEpisodeCharacterOverride(character.id)}
                          >
                            {resetArmedId === character.id ? "再次点击确认恢复" : "恢复全局形象"}
                          </button>
                        )}
                      </div>

                      {!canEdit && !creating && (
                        <p className="ws-meta">
                          该角色尚未进入已保存的本集名单：先勾选并保存剧集，再编辑本集形象。
                        </p>
                      )}
                      {creating && (
                        <p className="ws-meta">新建剧集保存后，才能编辑本集形象覆盖。</p>
                      )}

                      {editing && (
                        <div className="comic-appearance-editor">
                          <div className="ws-grid">
                            <Field label="本集形象名称" htmlFor={`ov-label-${character.id}`} hint="如：高中时期">
                              <input
                                id={`ov-label-${character.id}`}
                                type="text"
                                className="ws-input"
                                disabled={archived || appearanceSaving}
                                value={appearanceDraft.appearanceLabel}
                                onChange={(event) =>
                                  setAppearanceDraft({
                                    ...appearanceDraft,
                                    appearanceLabel: event.target.value,
                                  })
                                }
                              />
                            </Field>
                            <Field label="本集定位" htmlFor={`ov-role-${character.id}`} hint="留空沿用全局定位">
                              <input
                                id={`ov-role-${character.id}`}
                                type="text"
                                className="ws-input"
                                disabled={archived || appearanceSaving}
                                value={appearanceDraft.roleInEpisode}
                                onChange={(event) =>
                                  setAppearanceDraft({
                                    ...appearanceDraft,
                                    roleInEpisode: event.target.value,
                                  })
                                }
                              />
                            </Field>
                          </div>

                          <Field label="本集外貌调整" htmlFor={`ov-appearance-${character.id}`}>
                            <textarea
                              id={`ov-appearance-${character.id}`}
                              className="ws-textarea"
                              rows={2}
                              placeholder="留空则沿用全局基础设定"
                              disabled={archived || appearanceSaving}
                              value={appearanceDraft.appearanceDescription}
                              onChange={(event) =>
                                setAppearanceDraft({
                                  ...appearanceDraft,
                                  appearanceDescription: event.target.value,
                                })
                              }
                            />
                          </Field>

                          <div className="ws-grid">
                            <Field label="本集服装" htmlFor={`ov-costume-${character.id}`}>
                              <input
                                id={`ov-costume-${character.id}`}
                                type="text"
                                className="ws-input"
                                placeholder="如：蓝白校服"
                                disabled={archived || appearanceSaving}
                                value={appearanceDraft.costumeDescription}
                                onChange={(event) =>
                                  setAppearanceDraft({
                                    ...appearanceDraft,
                                    costumeDescription: event.target.value,
                                  })
                                }
                              />
                            </Field>
                            <Field label="本集发型" htmlFor={`ov-hair-${character.id}`}>
                              <input
                                id={`ov-hair-${character.id}`}
                                type="text"
                                className="ws-input"
                                placeholder="如：自然短发"
                                disabled={archived || appearanceSaving}
                                value={appearanceDraft.hairStyleDescription}
                                onChange={(event) =>
                                  setAppearanceDraft({
                                    ...appearanceDraft,
                                    hairStyleDescription: event.target.value,
                                  })
                                }
                              />
                            </Field>
                          </div>

                          <Field label="本集状态" htmlFor={`ov-state-${character.id}`}>
                            <input
                              id={`ov-state-${character.id}`}
                              type="text"
                              className="ws-input"
                              placeholder="如：正常状态 / 受伤 / 成年"
                              disabled={archived || appearanceSaving}
                              value={appearanceDraft.stateDescription}
                              onChange={(event) =>
                                setAppearanceDraft({
                                  ...appearanceDraft,
                                  stateDescription: event.target.value,
                                })
                              }
                            />
                          </Field>

                          <Field
                            label="本集形象提示词"
                            htmlFor={`ov-prompt-${character.id}`}
                            hint="只保存文本，不调用模型"
                          >
                            <textarea
                              id={`ov-prompt-${character.id}`}
                              className="ws-textarea"
                              rows={2}
                              disabled={archived || appearanceSaving}
                              value={appearanceDraft.visualPromptOverride}
                              onChange={(event) =>
                                setAppearanceDraft({
                                  ...appearanceDraft,
                                  visualPromptOverride: event.target.value,
                                })
                              }
                            />
                          </Field>

                          <div className="comic-path-row">
                            <span className="comic-field-label">本集专用参考图</span>
                            <span className="ws-path">
                              {appearanceDraft.refImagePath || "未设置（沿用全局参考图）"}
                            </span>
                            <button
                              type="button"
                              className="ws-btn"
                              disabled={archived || appearanceSaving || pickingRef}
                              onClick={() => void pickOverrideRefImage()}
                            >
                              {pickingRef ? "选择中…" : "选择图片"}
                            </button>
                            {appearanceDraft.refImagePath && (
                              <button
                                type="button"
                                className="ws-btn ws-btn-quiet"
                                disabled={archived || appearanceSaving}
                                onClick={() =>
                                  setAppearanceDraft({ ...appearanceDraft, refImagePath: "" })
                                }
                              >
                                清除
                              </button>
                            )}
                          </div>

                          {appearanceError && (
                            <p className="ws-notice" data-tone="error" role="alert">
                              <span>{appearanceError}</span>
                            </p>
                          )}

                          <div className="ws-form-actions">
                            <button
                              type="button"
                              className="ws-btn ws-btn-primary"
                              disabled={archived || appearanceSaving}
                              onClick={() => void saveEpisodeCharacterOverride(character.id)}
                            >
                              {appearanceSaving ? "保存中…" : "保存本集形象"}
                            </button>
                            <button
                              type="button"
                              className="ws-btn"
                              disabled={appearanceSaving}
                              onClick={() => {
                                setEditingCharacterId(null);
                                setAppearanceError(null);
                              }}
                            >
                              取消
                            </button>
                            <button
                              type="button"
                              className="ws-btn ws-btn-quiet"
                              disabled={archived || appearanceSaving}
                              onClick={() => startEditAppearance(character, override)}
                            >
                              重置为已保存值
                            </button>
                          </div>
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>
            </section>

            {saveError && (
              <p className="ws-notice" data-tone="error" role="alert">
                <span>{saveError}</span>
              </p>
            )}

            <div className="ws-form-actions">
              <button
                type="button"
                className="ws-btn ws-btn-primary"
                disabled={archived || saving}
                onClick={() => void saveEpisode()}
              >
                {saving ? "保存中…" : "保存剧集"}
              </button>
              <button
                type="button"
                className={`ws-btn ws-btn-danger${deleteArmed ? " is-armed" : ""}`}
                disabled={archived || saving || !selectedId}
                onClick={() => void removeEpisode()}
              >
                {deleteArmed ? "再次点击确认删除" : "删除剧集"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
