//! 分镜模块（C2）：每集多个镜头，字段含编号、描述、角色、场景、台词、景别、运镜、
//! 预计时长、状态、素材引用、备注；增删改查 + 排序。归档只读；失败可见 + 可重试。

import { useCallback, useEffect, useRef, useState } from "react";
import { Select, type SelectOption } from "../../../components/ui";
import type { CreativeModuleProps } from "../types";
import {
  comicCharacterList,
  comicSceneList,
  comicEpisodeList,
  comicShotDelete,
  comicShotList,
  comicShotReorder,
  comicShotSave,
} from "./ipc";
import {
  SHOT_STATUS_LABELS,
  type ComicCharacter,
  type ComicEpisode,
  type ComicScene,
  type ComicShot,
  type ShotStatus,
} from "./types";
import { ArchivedBanner, errorText, Field, LoadError } from "./shared";

const STATUS_OPTIONS: SelectOption<ShotStatus>[] = (
  Object.keys(SHOT_STATUS_LABELS) as ShotStatus[]
).map((value) => ({ value, label: SHOT_STATUS_LABELS[value] }));

interface ShotDraft {
  shotNo: string;
  description: string;
  characterIds: string[];
  sceneId: string;
  dialogue: string;
  shotSize: string;
  cameraMove: string;
  durationSec: string;
  status: ShotStatus;
  assetRefs: string;
  note: string;
}

const EMPTY_DRAFT: ShotDraft = {
  shotNo: "",
  description: "",
  characterIds: [],
  sceneId: "",
  dialogue: "",
  shotSize: "",
  cameraMove: "",
  durationSec: "",
  status: "todo",
  assetRefs: "",
  note: "",
};

export function ShotsPanel({ projectId, archived, onNotice }: CreativeModuleProps) {
  const [episodes, setEpisodes] = useState<ComicEpisode[]>([]);
  const [characters, setCharacters] = useState<ComicCharacter[]>([]);
  const [scenes, setScenes] = useState<ComicScene[]>([]);
  const [shots, setShots] = useState<ComicShot[]>([]);
  const [activeEpisodeId, setActiveEpisodeId] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ShotDraft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deleteArmed, setDeleteArmed] = useState(false);

  const seqRef = useRef(0);

  const loadEpisodes = useCallback(async () => {
    const token = ++seqRef.current;
    try {
      const [episodeResult, characterResult, sceneResult] = await Promise.all([
        comicEpisodeList(projectId),
        comicCharacterList(projectId),
        comicSceneList(projectId),
      ]);
      if (token !== seqRef.current) return;
      const episodeList = episodeResult.episodes ?? [];
      setEpisodes(episodeList);
      setCharacters(characterResult.characters ?? []);
      setScenes(sceneResult.scenes ?? []);
      setActiveEpisodeId((current) => current || episodeList[0]?.id || "");
    } catch (error) {
      if (token !== seqRef.current) return;
      setLoadError(errorText(error));
    }
  }, [projectId]);

  const loadShots = useCallback(
    async (episodeId: string) => {
      if (!episodeId) {
        setShots([]);
        return;
      }
      const token = ++seqRef.current;
      setLoading(true);
      try {
        const result = await comicShotList(projectId, episodeId);
        if (token !== seqRef.current) return;
        setShots(result.shots ?? []);
        setLoadError(null);
      } catch (error) {
        if (token !== seqRef.current) return;
        setLoadError(errorText(error));
      } finally {
        if (token === seqRef.current) setLoading(false);
      }
    },
    [projectId],
  );

  useEffect(() => {
    void loadEpisodes();
  }, [loadEpisodes]);

  useEffect(() => {
    void loadShots(activeEpisodeId);
  }, [loadShots, activeEpisodeId]);

  function selectShot(shot: ComicShot) {
    setSelectedId(shot.id);
    setDraft({
      shotNo: shot.shotNo > 0 ? String(shot.shotNo) : "",
      description: shot.description,
      characterIds: shot.characterIds,
      sceneId: shot.sceneId ?? "",
      dialogue: shot.dialogue,
      shotSize: shot.shotSize,
      cameraMove: shot.cameraMove,
      durationSec: shot.durationSec > 0 ? String(shot.durationSec) : "",
      status: shot.status,
      assetRefs: shot.assetRefs.join(", "),
      note: shot.note,
    });
    setSaveError(null);
    setDeleteArmed(false);
  }

  function startNew() {
    setSelectedId(null);
    setDraft(EMPTY_DRAFT);
    setSaveError(null);
    setDeleteArmed(false);
  }

  function toggleCharacter(characterId: string) {
    setDraft((prev) => ({
      ...prev,
      characterIds: prev.characterIds.includes(characterId)
        ? prev.characterIds.filter((id) => id !== characterId)
        : [...prev.characterIds, characterId],
    }));
  }

  const sceneOptions: SelectOption<string>[] = [
    { value: "", label: "未指定场景" },
    ...scenes.map((scene) => ({ value: scene.id, label: scene.name })),
  ];

  const episodeOptions: SelectOption<string>[] = episodes.map((episode) => ({
    value: episode.id,
    label: `第 ${episode.episodeNo} 集 · ${episode.title}`,
  }));

  async function saveShot() {
    if (archived || saving) return;
    if (!activeEpisodeId) {
      setSaveError("请先选择所属剧集");
      return;
    }
    const duration = draft.durationSec.trim();
    const durationSec = duration === "" ? null : Number(duration);
    if (durationSec !== null && (Number.isNaN(durationSec) || durationSec < 0)) {
      setSaveError("预计时长必须是不小于 0 的数字");
      return;
    }
    const assetRefs = draft.assetRefs
      .split(/[,，;；]/)
      .map((part) => part.trim())
      .filter(Boolean);
    setSaving(true);
    setSaveError(null);
    try {
      const result = await comicShotSave({
        id: selectedId,
        projectId,
        episodeId: activeEpisodeId,
        shotNo: draft.shotNo.trim() ? Number(draft.shotNo) : null,
        description: draft.description,
        characterIds: draft.characterIds,
        sceneId: draft.sceneId || null,
        dialogue: draft.dialogue,
        shotSize: draft.shotSize,
        cameraMove: draft.cameraMove,
        durationSec,
        status: draft.status,
        assetRefs,
        note: draft.note,
      });
      onNotice("ok", selectedId ? "镜头已更新" : `已新建镜头 #${result.shot.shotNo}`);
      await loadShots(activeEpisodeId);
      selectShot(result.shot);
    } catch (error) {
      setSaveError(errorText(error));
      onNotice("error", `保存镜头失败：${errorText(error)}`);
    } finally {
      setSaving(false);
    }
  }

  async function removeShot() {
    if (!selectedId || archived || saving) return;
    if (!deleteArmed) {
      setDeleteArmed(true);
      return;
    }
    setSaving(true);
    try {
      await comicShotDelete(selectedId);
      onNotice("ok", "镜头已删除");
      startNew();
      await loadShots(activeEpisodeId);
    } catch (error) {
      onNotice("error", `删除镜头失败：${errorText(error)}`);
    } finally {
      setSaving(false);
      setDeleteArmed(false);
    }
  }

  async function moveShot(index: number, direction: -1 | 1) {
    if (archived || saving || !activeEpisodeId) return;
    const target = index + direction;
    if (target < 0 || target >= shots.length) return;
    const reordered = [...shots];
    const [moved] = reordered.splice(index, 1);
    reordered.splice(target, 0, moved);
    setSaving(true);
    try {
      const result = await comicShotReorder(
        projectId,
        activeEpisodeId,
        reordered.map((shot) => shot.id),
      );
      setShots(result.shots ?? reordered);
      onNotice("ok", "镜头顺序已保存");
    } catch (error) {
      onNotice("error", `排序失败：${errorText(error)}`);
      await loadShots(activeEpisodeId);
    } finally {
      setSaving(false);
    }
  }

  const sceneName = (sceneId: string | null) =>
    scenes.find((scene) => scene.id === sceneId)?.name ?? "未指定场景";

  const selected = shots.find((shot) => shot.id === selectedId) ?? null;

  return (
    <div className="comic-layout">
      <aside className="comic-pane comic-pane-list" aria-label="镜头列表">
        <div className="comic-toolbar">
          <Select
            value={activeEpisodeId}
            options={episodeOptions}
            onChange={setActiveEpisodeId}
            placeholder="选择剧集"
            ariaLabel="剧集"
            disabled={archived || episodeOptions.length === 0}
          />
          <button type="button" className="ws-btn ws-btn-primary" disabled={archived || !activeEpisodeId} onClick={startNew}>
            加镜头
          </button>
        </div>

        {loadError && <LoadError message={loadError} onRetry={() => void loadShots(activeEpisodeId)} />}
        {loading && !loadError && <p className="ws-empty">加载中…</p>}

        <ul className="ws-list">
          {shots.map((shot, index) => (
            <li key={shot.id}>
              <div className={`comic-list-row${shot.id === selectedId ? " is-active" : ""}`}>
                <button
                  type="button"
                  className="comic-row-main"
                  onClick={() => selectShot(shot)}
                >
                  <span className="comic-row-title">
                    镜头 {shot.shotNo} · {shot.description || "（无描述）"}
                  </span>
                  <span className="ws-meta">
                    {SHOT_STATUS_LABELS[shot.status]} · {sceneName(shot.sceneId)} ·{" "}
                    {shot.durationSec > 0 ? `${shot.durationSec}s` : "时长未定"}
                  </span>
                </button>
                <span className="comic-row-actions">
                  <button
                    type="button"
                    className="ws-btn ws-btn-quiet"
                    aria-label="上移"
                    disabled={archived || index === 0}
                    onClick={() => void moveShot(index, -1)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="ws-btn ws-btn-quiet"
                    aria-label="下移"
                    disabled={archived || index === shots.length - 1}
                    onClick={() => void moveShot(index, 1)}
                  >
                    ↓
                  </button>
                </span>
              </div>
            </li>
          ))}
          {!loading && shots.length === 0 && !loadError && (
            <li className="ws-empty">本集暂无镜头，点击「加镜头」开始。</li>
          )}
        </ul>
      </aside>

      <div className="comic-pane comic-pane-detail">
        {archived && <ArchivedBanner />}

        {!selected && !loading && (
          <p className="ws-empty">从左侧选择镜头，或为当前剧集加一个镜头。</p>
        )}

        {selected && (
          <div className="comic-form">
            <div className="ws-grid">
              <Field label="镜头编号" htmlFor="comic-shot-no" hint="留空自动顺延">
                <input
                  id="comic-shot-no"
                  type="number"
                  min={1}
                  className="ws-input"
                  disabled={archived || saving}
                  value={draft.shotNo}
                  onChange={(event) => setDraft({ ...draft, shotNo: event.target.value })}
                />
              </Field>
              <Field label="镜头状态">
                <Select
                  value={draft.status}
                  options={STATUS_OPTIONS}
                  onChange={(value) => setDraft({ ...draft, status: value })}
                  ariaLabel="镜头状态"
                  disabled={archived || saving}
                />
              </Field>
            </div>

            <Field label="镜头描述" htmlFor="comic-shot-desc">
              <textarea
                id="comic-shot-desc"
                className="ws-textarea"
                rows={3}
                disabled={archived || saving}
                value={draft.description}
                onChange={(event) => setDraft({ ...draft, description: event.target.value })}
              />
            </Field>

            <Field label="台词" htmlFor="comic-shot-dialogue">
              <textarea
                id="comic-shot-dialogue"
                className="ws-textarea"
                rows={2}
                disabled={archived || saving}
                value={draft.dialogue}
                onChange={(event) => setDraft({ ...draft, dialogue: event.target.value })}
              />
            </Field>

            <div className="ws-grid">
              <Field label="景别" htmlFor="comic-shot-size">
                <input
                  id="comic-shot-size"
                  type="text"
                  className="ws-input"
                  placeholder="如：远景 / 中景 / 特写"
                  disabled={archived || saving}
                  value={draft.shotSize}
                  onChange={(event) => setDraft({ ...draft, shotSize: event.target.value })}
                />
              </Field>
              <Field label="运镜说明" htmlFor="comic-shot-camera">
                <input
                  id="comic-shot-camera"
                  type="text"
                  className="ws-input"
                  placeholder="如：固定机位 / 推镜 / 跟拍"
                  disabled={archived || saving}
                  value={draft.cameraMove}
                  onChange={(event) => setDraft({ ...draft, cameraMove: event.target.value })}
                />
              </Field>
            </div>

            <div className="ws-grid">
              <Field label="预计时长（秒）" htmlFor="comic-shot-duration">
                <input
                  id="comic-shot-duration"
                  type="number"
                  min={0}
                  step={0.5}
                  className="ws-input"
                  disabled={archived || saving}
                  value={draft.durationSec}
                  onChange={(event) => setDraft({ ...draft, durationSec: event.target.value })}
                />
              </Field>
              <Field label="场景">
                <Select
                  value={draft.sceneId}
                  options={sceneOptions}
                  onChange={(value) => setDraft({ ...draft, sceneId: value })}
                  ariaLabel="场景"
                  disabled={archived || saving}
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

            <Field label="素材引用" htmlFor="comic-shot-assets" hint="素材版本 ID，逗号分隔，可选">
              <input
                id="comic-shot-assets"
                type="text"
                className="ws-input"
                disabled={archived || saving}
                value={draft.assetRefs}
                onChange={(event) => setDraft({ ...draft, assetRefs: event.target.value })}
              />
            </Field>

            <Field label="备注" htmlFor="comic-shot-note">
              <textarea
                id="comic-shot-note"
                className="ws-textarea"
                rows={2}
                disabled={archived || saving}
                value={draft.note}
                onChange={(event) => setDraft({ ...draft, note: event.target.value })}
              />
            </Field>

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
                onClick={() => void saveShot()}
              >
                {saving ? "保存中…" : "保存镜头"}
              </button>
              <button
                type="button"
                className={`ws-btn ws-btn-danger${deleteArmed ? " is-armed" : ""}`}
                disabled={archived || saving}
                onClick={() => void removeShot()}
              >
                {deleteArmed ? "再次点击确认删除" : "删除镜头"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
