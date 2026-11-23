//! 分镜模块（C2）：每集多个镜头，字段含编号、描述、角色、场景、台词、景别、运镜、
//! 预计时长、状态、备注；增删改查 + 排序。归档只读；失败可见 + 可重试。
//!
//! 镜头↔素材的唯一正式关联由「素材版本 → 镜头」（`comic_media_versions.shot_id`）维护：
//! 本面板只**展示**关联结果、按需预览大图，不再要求用户手填素材版本 ID；
//! 历史 `asset_refs_json`（实际存的是文件路径）按只读兼容展示，保存时不提交也不清空。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Select, type SelectOption } from "../../../components/ui";
import { basename } from "../../../lib/filesWorkspace/pathUtils";
import type { CreativeModuleProps } from "../types";
import {
  comicCharacterList,
  comicMediaList,
  comicSceneList,
  comicEpisodeList,
  comicShotDelete,
  comicShotList,
  comicShotReorder,
  comicShotSave,
} from "./ipc";
import {
  MEDIA_KIND_LABELS,
  MEDIA_STATUS_LABELS,
  SHOT_STATUS_LABELS,
  type ComicCharacter,
  type ComicEpisode,
  type ComicMediaVersion,
  type ComicScene,
  type ComicShot,
  type ShotStatus,
} from "./types";
import { ArchivedBanner, errorText, Field, LoadError } from "./shared";
import { MediaPreview, MediaThumb } from "./MediaPreview";

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
  note: "",
};

export function ShotsPanel({ projectId, archived, onNotice, switchModule }: CreativeModuleProps) {
  const [episodes, setEpisodes] = useState<ComicEpisode[]>([]);
  const [characters, setCharacters] = useState<ComicCharacter[]>([]);
  const [scenes, setScenes] = useState<ComicScene[]>([]);
  const [shots, setShots] = useState<ComicShot[]>([]);
  const [media, setMedia] = useState<ComicMediaVersion[]>([]);
  const [activeEpisodeId, setActiveEpisodeId] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<ShotDraft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deleteArmed, setDeleteArmed] = useState(false);
  /** 展开查看的素材版本（大图 + 标注 + 修改意见）；null = 未展开。 */
  const [previewVersionId, setPreviewVersionId] = useState<string | null>(null);

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
        // 素材版本是镜头↔素材的正式关联来源：随镜头一起刷新，保证两页数据一致。
        const [shotResult, mediaResult] = await Promise.all([
          comicShotList(projectId, episodeId),
          comicMediaList(projectId),
        ]);
        if (token !== seqRef.current) return;
        setShots(shotResult.shots ?? []);
        setMedia(mediaResult.versions ?? []);
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
    setCreating(false);
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
      note: shot.note,
    });
    setPreviewVersionId(null);
    setSaveError(null);
    setDeleteArmed(false);
  }

  function resetDetail(openForCreate: boolean) {
    setSelectedId(null);
    setCreating(openForCreate);
    setDraft(EMPTY_DRAFT);
    setPreviewVersionId(null);
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
    // 角色/场景为弱引用：档案被删除后草稿里可能残留失效 ID，保存前按当前清单裁剪，
    // 避免不可见的悬空引用把后端归属校验卡住。
    const knownCharacterIds = new Set(characters.map((character) => character.id));
    const characterIds = draft.characterIds.filter((id) => knownCharacterIds.has(id));
    const sceneId =
      draft.sceneId && scenes.some((scene) => scene.id === draft.sceneId)
        ? draft.sceneId
        : null;
    setSaving(true);
    setSaveError(null);
    try {
      const result = await comicShotSave({
        id: selectedId,
        projectId,
        episodeId: activeEpisodeId,
        shotNo: draft.shotNo.trim() ? Number(draft.shotNo) : null,
        description: draft.description,
        characterIds,
        sceneId,
        dialogue: draft.dialogue,
        shotSize: draft.shotSize,
        cameraMove: draft.cameraMove,
        durationSec,
        status: draft.status,
        // 素材关联只由「素材版本 → 镜头」维护：不提交 assetRefs，后端在 None 时保留历史列原值。
        assetRefs: null,
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
      resetDetail(false);
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
  const editorOpen = creating || selected !== null;

  /** 当前镜头关联的素材版本（正式关联：`shot_id`）。 */
  const shotMedia = useMemo(
    () => (selectedId ? media.filter((version) => version.shotId === selectedId) : []),
    [media, selectedId],
  );
  const previewVersion = shotMedia.find((version) => version.id === previewVersionId) ?? null;

  const mediaCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const version of media) {
      if (!version.shotId) continue;
      counts.set(version.shotId, (counts.get(version.shotId) ?? 0) + 1);
    }
    return counts;
  }, [media]);

  /**
   * 历史 `asset_refs_json` 里实际存的是文件路径：按 file_path 匹配素材版本后只读展示，
   * 已经通过 `shot_id` 关联到本镜头的版本不再重复列出。
   */
  const legacyOnlyRefs = useMemo(() => {
    const refs = selected?.assetRefs ?? [];
    const linkedIds = new Set(shotMedia.map((version) => version.id));
    return refs.map((ref) => {
      const matched = media.find((version) => version.filePath === ref) ?? null;
      return { ref, matched, duplicated: matched ? linkedIds.has(matched.id) : false };
    }).filter((item) => !item.duplicated);
  }, [media, selected, shotMedia]);

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
                    {mediaCounts.get(shot.id) ? ` · ${mediaCounts.get(shot.id)} 个素材版本` : ""}
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

        {!editorOpen && !loading && (
          <p className="ws-empty">从左侧选择镜头，或为当前剧集加一个镜头。</p>
        )}

        {editorOpen && (
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

            <fieldset className="comic-check-group comic-shot-media">
              <legend className="comic-field-label">
                关联素材版本
                <em className="comic-field-hint">
                  由「素材与产物」的版本选择关联镜头维护，本页只读展示
                </em>
              </legend>

              {!selectedId && (
                <p className="ws-meta">保存镜头后，到「素材与产物」把版本关联到本镜头即可在此查看。</p>
              )}
              {selectedId && shotMedia.length === 0 && (
                <p className="ws-meta">本镜头还没有关联素材版本。</p>
              )}

              {shotMedia.length > 0 && (
                <ul className="ws-list comic-shot-media-list">
                  {shotMedia.map((version) => (
                    <li key={version.id}>
                      <div className="comic-shot-media-row">
                        <MediaThumb
                          path={version.filePath}
                          kind={version.mediaKind}
                          exists={version.fileExists}
                          placeholder={version.fileExists ? undefined : "文件缺失"}
                        />
                        <span className="comic-row-text">
                          <span className="comic-row-title">
                            {version.versionLabel || "未命名版本"} ·{" "}
                            {MEDIA_KIND_LABELS[version.mediaKind]}
                          </span>
                          <span className="ws-meta">
                            {MEDIA_STATUS_LABELS[version.status]}
                            {!version.fileExists ? " · 文件缺失" : ""}
                          </span>
                        </span>
                        <button
                          type="button"
                          className="ws-btn ws-btn-quiet"
                          aria-expanded={previewVersionId === version.id}
                          onClick={() =>
                            setPreviewVersionId((current) =>
                              current === version.id ? null : version.id,
                            )
                          }
                        >
                          {previewVersionId === version.id ? "收起" : "查看"}
                        </button>
                      </div>
                      {previewVersion?.id === version.id && (
                        <div className="comic-shot-media-detail">
                          <div className="comic-detail-stage">
                            <MediaPreview
                              path={version.filePath}
                              kind={version.mediaKind}
                              exists={version.fileExists}
                              label={version.versionLabel}
                            />
                          </div>
                          <p className="ws-meta">
                            修改意见：{version.reviewNote || "（未填写）"}
                          </p>
                          <p className="ws-meta ws-path">{version.filePath}</p>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}

              <div className="ws-form-actions">
                <button
                  type="button"
                  className="ws-btn"
                  disabled={!selectedId}
                  onClick={() => switchModule("assets")}
                >
                  去素材与产物管理
                </button>
              </div>

              {legacyOnlyRefs.length > 0 && (
                <div className="comic-legacy-refs">
                  <p className="ws-meta">
                    历史素材引用（只读）：早期版本把文件路径直接写在该字段，共{" "}
                    {legacyOnlyRefs.length} 条，不自动迁移也不会被清空。
                  </p>
                  <ul className="ws-list">
                    {legacyOnlyRefs.map((item) => (
                      <li key={item.ref} className="ws-meta comic-legacy-ref" title={item.ref}>
                        {item.matched
                          ? `路径已匹配素材版本「${item.matched.versionLabel || item.matched.id}」，但该版本未关联到本镜头`
                          : `未匹配到素材版本：${basename(item.ref)}`}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </fieldset>

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
                disabled={archived || saving || !selectedId}
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
