//! 素材与产物版本模块（C4）：本地图片/视频路径导入、关联镜头/角色/场景、
//! 候选/采用/拒收状态、修改意见、多版本共存；同一镜头采用版本唯一。
//! 未接入 AI 生成模型，本面板不渲染任何「生成」按钮；归档只读。

import { useCallback, useEffect, useRef, useState } from "react";
import { Select, type SelectOption } from "../../../components/ui";
import type { CreativeModuleProps } from "../types";
import {
  comicCharacterList,
  comicMediaAdopt,
  comicMediaDelete,
  comicMediaImport,
  comicMediaList,
  comicMediaSave,
  comicSceneList,
  comicShotList,
} from "./ipc";
import {
  MEDIA_KIND_LABELS,
  MEDIA_STATUS_LABELS,
  type ComicCharacter,
  type ComicMediaVersion,
  type ComicScene,
  type ComicShot,
  type MediaKind,
  type MediaStatus,
} from "./types";
import { ArchivedBanner, errorText, Field, LoadError } from "./shared";

type TargetKind = "shot" | "character" | "scene";

const KIND_OPTIONS: SelectOption<MediaKind>[] = (
  Object.keys(MEDIA_KIND_LABELS) as MediaKind[]
).map((value) => ({ value, label: MEDIA_KIND_LABELS[value] }));

const TARGET_KIND_OPTIONS: SelectOption<TargetKind>[] = [
  { value: "shot", label: "关联镜头" },
  { value: "character", label: "关联角色" },
  { value: "scene", label: "关联场景" },
];

export function AssetsPanel({ projectId, archived, onNotice }: CreativeModuleProps) {
  const [versions, setVersions] = useState<ComicMediaVersion[]>([]);
  const [shots, setShots] = useState<ComicShot[]>([]);
  const [characters, setCharacters] = useState<ComicCharacter[]>([]);
  const [scenes, setScenes] = useState<ComicScene[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deleteArmedId, setDeleteArmedId] = useState<string | null>(null);

  const [showImport, setShowImport] = useState(false);
  const [targetKind, setTargetKind] = useState<TargetKind>("shot");
  const [targetId, setTargetId] = useState("");
  const [filePath, setFilePath] = useState("");
  const [mediaKind, setMediaKind] = useState<MediaKind>("image");
  const [versionLabel, setVersionLabel] = useState("");
  const [reviewNote, setReviewNote] = useState("");

  const seqRef = useRef(0);

  const loadAll = useCallback(async () => {
    const token = ++seqRef.current;
    setLoading(true);
    try {
      const [mediaResult, shotResult, characterResult, sceneResult] = await Promise.all([
        comicMediaList(projectId),
        comicShotList(projectId, null),
        comicCharacterList(projectId),
        comicSceneList(projectId),
      ]);
      if (token !== seqRef.current) return;
      setVersions(mediaResult.versions ?? []);
      setShots(shotResult.shots ?? []);
      setCharacters(characterResult.characters ?? []);
      setScenes(sceneResult.scenes ?? []);
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

  const targetOptions: SelectOption<string>[] =
    targetKind === "shot"
      ? shots.map((shot) => ({
          value: shot.id,
          label: `镜头 ${shot.shotNo} · ${shot.description || "（无描述）"}`,
        }))
      : targetKind === "character"
        ? characters.map((character) => ({ value: character.id, label: character.name }))
        : scenes.map((scene) => ({ value: scene.id, label: scene.name }));

  function targetSummary(version: ComicMediaVersion): string {
    if (version.shotId) {
      const shot = shots.find((item) => item.id === version.shotId);
      return shot ? `镜头 ${shot.shotNo}` : "镜头（已删除）";
    }
    if (version.characterId) {
      const character = characters.find((item) => item.id === version.characterId);
      return character ? `角色 · ${character.name}` : "角色（已删除）";
    }
    if (version.sceneId) {
      const scene = scenes.find((item) => item.id === version.sceneId);
      return scene ? `场景 · ${scene.name}` : "场景（已删除）";
    }
    return "未关联";
  }

  async function importVersion() {
    if (archived || saving) return;
    if (!targetId) {
      setSaveError("请选择要关联的镜头、角色或场景");
      return;
    }
    if (!filePath.trim()) {
      setSaveError("素材路径不能为空（登记本地绝对路径引用）");
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      await comicMediaImport({
        projectId,
        shotId: targetKind === "shot" ? targetId : null,
        characterId: targetKind === "character" ? targetId : null,
        sceneId: targetKind === "scene" ? targetId : null,
        filePath: filePath.trim(),
        mediaKind,
        versionLabel: versionLabel || null,
        reviewNote: reviewNote || null,
      });
      onNotice("ok", "素材版本已导入（仅登记路径，未复制文件）");
      setShowImport(false);
      setTargetId("");
      setFilePath("");
      setVersionLabel("");
      setReviewNote("");
      await loadAll();
    } catch (error) {
      setSaveError(errorText(error));
      onNotice("error", `导入素材失败：${errorText(error)}`);
    } finally {
      setSaving(false);
    }
  }

  async function adoptVersion(version: ComicMediaVersion) {
    if (archived || saving) return;
    setSaving(true);
    try {
      await comicMediaAdopt(version.id);
      onNotice("ok", `已采用「${version.versionLabel || version.id}」；同镜头其他版本已回到候选`);
      await loadAll();
    } catch (error) {
      onNotice("error", `采用失败：${errorText(error)}`);
    } finally {
      setSaving(false);
    }
  }

  async function toggleReject(version: ComicMediaVersion) {
    if (archived || saving) return;
    const nextStatus: MediaStatus = version.status === "rejected" ? "candidate" : "rejected";
    setSaving(true);
    try {
      await comicMediaSave(version.id, { status: nextStatus });
      onNotice("ok", nextStatus === "rejected" ? "已标记为拒收" : "已恢复为候选");
      await loadAll();
    } catch (error) {
      onNotice("error", `状态更新失败：${errorText(error)}`);
    } finally {
      setSaving(false);
    }
  }

  async function saveNote(version: ComicMediaVersion) {
    if (archived || saving) return;
    setSaving(true);
    try {
      await comicMediaSave(version.id, {
        versionLabel: version.versionLabel,
        reviewNote: version.reviewNote,
      });
      onNotice("ok", "修改意见已保存");
      await loadAll();
    } catch (error) {
      onNotice("error", `保存失败：${errorText(error)}`);
    } finally {
      setSaving(false);
    }
  }

  async function removeVersion(version: ComicMediaVersion) {
    if (archived || saving) return;
    if (deleteArmedId !== version.id) {
      setDeleteArmedId(version.id);
      return;
    }
    setSaving(true);
    try {
      await comicMediaDelete(version.id);
      onNotice("ok", "版本记录已删除（原文件保留在原位）");
      if (selectedId === version.id) setSelectedId(null);
      await loadAll();
    } catch (error) {
      onNotice("error", `删除失败：${errorText(error)}`);
    } finally {
      setSaving(false);
      setDeleteArmedId(null);
    }
  }

  const selected = versions.find((version) => version.id === selectedId) ?? null;

  return (
    <div className="comic-layout">
      <aside className="comic-pane comic-pane-list" aria-label="素材版本列表">
        <div className="comic-toolbar">
          <button
            type="button"
            className="ws-btn ws-btn-primary"
            disabled={archived}
            onClick={() => setShowImport((value) => !value)}
          >
            {showImport ? "收起导入" : "导入本地素材"}
          </button>
        </div>

        {showImport && !archived && (
          <div className="ws-card comic-import-form">
            <div className="ws-grid">
              <Field label="关联类型">
                <Select
                  value={targetKind}
                  options={TARGET_KIND_OPTIONS}
                  onChange={setTargetKind}
                  ariaLabel="关联类型"
                  disabled={saving}
                />
              </Field>
              <Field label="关联对象">
                <Select
                  value={targetId}
                  options={targetOptions}
                  onChange={setTargetId}
                  placeholder="选择对象"
                  ariaLabel="关联对象"
                  disabled={saving || targetOptions.length === 0}
                />
              </Field>
            </div>
            <Field label="本地文件绝对路径" htmlFor="comic-media-path">
              <input
                id="comic-media-path"
                type="text"
                className="ws-input ws-path"
                disabled={saving}
                value={filePath}
                placeholder="如：D:/comic/shot-a1.png"
                onChange={(event) => setFilePath(event.target.value)}
              />
            </Field>
            <div className="ws-grid">
              <Field label="素材类型">
                <Select
                  value={mediaKind}
                  options={KIND_OPTIONS}
                  onChange={setMediaKind}
                  ariaLabel="素材类型"
                  disabled={saving}
                />
              </Field>
              <Field label="版本标注" htmlFor="comic-media-label">
                <input
                  id="comic-media-label"
                  type="text"
                  className="ws-input"
                  disabled={saving}
                  value={versionLabel}
                  placeholder="如：v2"
                  onChange={(event) => setVersionLabel(event.target.value)}
                />
              </Field>
            </div>
            <Field label="修改意见" htmlFor="comic-media-note">
              <textarea
                id="comic-media-note"
                className="ws-textarea"
                rows={2}
                disabled={saving}
                value={reviewNote}
                onChange={(event) => setReviewNote(event.target.value)}
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
                disabled={saving || !targetId || !filePath.trim()}
                onClick={() => void importVersion()}
              >
                {saving ? "导入中…" : "登记素材"}
              </button>
            </div>
          </div>
        )}

        {loadError && <LoadError message={loadError} onRetry={() => void loadAll()} />}
        {loading && !loadError && <p className="ws-empty">加载中…</p>}

        <ul className="ws-list">
          {versions.map((version) => (
            <li key={version.id}>
              <button
                type="button"
                className={`comic-list-row comic-row-main${version.id === selectedId ? " is-active" : ""}`}
                onClick={() => {
                  setSelectedId(version.id);
                  setSaveError(null);
                }}
              >
                <span className="comic-row-title">
                  {version.versionLabel || "未命名版本"} · {MEDIA_KIND_LABELS[version.mediaKind]}
                </span>
                <span className="ws-meta">
                  {targetSummary(version)} · {MEDIA_STATUS_LABELS[version.status]}
                  {!version.fileExists ? " · 文件缺失" : ""}
                </span>
              </button>
            </li>
          ))}
          {!loading && versions.length === 0 && !loadError && (
            <li className="ws-empty">暂无素材版本，导入本地图片或视频开始管理。</li>
          )}
        </ul>
      </aside>

      <div className="comic-pane comic-pane-detail">
        {archived && <ArchivedBanner />}

        {!selected && !loading && (
          <p className="ws-empty">从左侧选择版本，或导入本地素材。</p>
        )}

        {selected && (
          <div className="comic-form">
            <div className="ws-form-row">
              <span className="ws-badge">{MEDIA_KIND_LABELS[selected.mediaKind]}</span>
              <span
                className={`ws-badge${
                  selected.status === "adopted"
                    ? " ws-badge-available"
                    : selected.status === "rejected"
                      ? " ws-badge-soft"
                      : ""
                }`}
              >
                {MEDIA_STATUS_LABELS[selected.status]}
              </span>
              <span className="ws-meta">{targetSummary(selected)}</span>
            </div>

            <Field label="文件路径" htmlFor="comic-media-detail-path">
              <input
                id="comic-media-detail-path"
                type="text"
                className="ws-input ws-path"
                readOnly
                value={selected.filePath}
              />
            </Field>
            {!selected.fileExists && (
              <p className="ws-meta" data-tone="error" role="status">
                引用路径当前不存在：文件可能被移动或删除。记录保留，待路径恢复后自动识别；不会自动清理引用。
              </p>
            )}

            <div className="ws-grid">
              <Field label="版本标注" htmlFor="comic-media-detail-label">
                <input
                  id="comic-media-detail-label"
                  type="text"
                  className="ws-input"
                  disabled={archived || saving}
                  value={selected.versionLabel}
                  onChange={(event) =>
                    setVersions((prev) =>
                      prev.map((item) =>
                        item.id === selected.id
                          ? { ...item, versionLabel: event.target.value }
                          : item,
                      ),
                    )
                  }
                />
              </Field>
              <Field label="修改意见" htmlFor="comic-media-detail-note">
                <input
                  id="comic-media-detail-note"
                  type="text"
                  className="ws-input"
                  disabled={archived || saving}
                  value={selected.reviewNote}
                  onChange={(event) =>
                    setVersions((prev) =>
                      prev.map((item) =>
                        item.id === selected.id
                          ? { ...item, reviewNote: event.target.value }
                          : item,
                      ),
                    )
                  }
                />
              </Field>
            </div>

            <div className="ws-form-actions">
              {selected.shotId && selected.status !== "adopted" && (
                <button
                  type="button"
                  className="ws-btn ws-btn-primary"
                  disabled={archived || saving}
                  onClick={() => void adoptVersion(selected)}
                >
                  标记采用
                </button>
              )}
              {selected.shotId && (
                <button
                  type="button"
                  className="ws-btn"
                  disabled={archived || saving || selected.status === "adopted"}
                  onClick={() => void toggleReject(selected)}
                >
                  {selected.status === "rejected" ? "恢复候选" : "标记拒收"}
                </button>
              )}
              <button
                type="button"
                className="ws-btn"
                disabled={archived || saving}
                onClick={() => void saveNote(selected)}
              >
                保存标注与意见
              </button>
              <button
                type="button"
                className={`ws-btn ws-btn-danger${deleteArmedId === selected.id ? " is-armed" : ""}`}
                disabled={archived || saving}
                onClick={() => void removeVersion(selected)}
              >
                {deleteArmedId === selected.id ? "再次点击确认删除" : "删除版本"}
              </button>
            </div>
            <p className="ws-meta">
              仅删除本地版本记录，不会移动或删除素材原文件；AI 生成模型本轮未接入，无自动生成入口。
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
