//! 剧集与剧本模块（C1）：剧集列表、编号、标题、简介、剧本正文、状态、进度、
//! 出场角色关联与排序。归档只读；失败可见 + 可重试；切项目由壳层换 key 重挂。

import { useCallback, useEffect, useRef, useState } from "react";
import { Select, type SelectOption } from "../../../components/ui";
import type { CreativeModuleProps } from "../types";
import {
  comicCharacterList,
  comicEpisodeDelete,
  comicEpisodeList,
  comicEpisodeReorder,
  comicEpisodeSave,
} from "./ipc";
import {
  EPISODE_STATUS_LABELS,
  type ComicCharacter,
  type ComicEpisode,
  type EpisodeStatus,
} from "./types";
import { ArchivedBanner, errorText, Field, LoadError } from "./shared";

const STATUS_OPTIONS: SelectOption<EpisodeStatus>[] = (
  Object.keys(EPISODE_STATUS_LABELS) as EpisodeStatus[]
).map((value) => ({ value, label: EPISODE_STATUS_LABELS[value] }));

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

export function EpisodesPanel({ projectId, archived, onNotice }: CreativeModuleProps) {
  const [episodes, setEpisodes] = useState<ComicEpisode[]>([]);
  const [characters, setCharacters] = useState<ComicCharacter[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<EpisodeDraft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deleteArmed, setDeleteArmed] = useState(false);

  const seqRef = useRef(0);

  const loadAll = useCallback(async () => {
    const token = ++seqRef.current;
    setLoading(true);
    try {
      const [episodeResult, characterResult] = await Promise.all([
        comicEpisodeList(projectId),
        comicCharacterList(projectId),
      ]);
      if (token !== seqRef.current) return;
      setEpisodes(episodeResult.episodes ?? []);
      setCharacters(characterResult.characters ?? []);
      setLoadError(null);
    } catch (error) {
      if (token !== seqRef.current) return;
      setLoadError(errorText(error));
    } finally {
      if (token === seqRef.current) setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

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
  }

  function resetDetail(openForCreate: boolean) {
    setSelectedId(null);
    setCreating(openForCreate);
    setDraft(EMPTY_DRAFT);
    setSaveError(null);
    setDeleteArmed(false);
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
        characterIds: draft.characterIds,
      });
      onNotice("ok", selectedId ? "剧集已更新" : `已新建剧集「${result.episode.title}」`);
      await loadAll();
      selectEpisode(result.episode);
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

  const selected = episodes.find((episode) => episode.id === selectedId) ?? null;
  const editorOpen = creating || selected !== null;

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

            {characters.length > 0 && (
              <fieldset className="comic-check-group">
                <legend className="comic-field-label">出场角色</legend>
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
