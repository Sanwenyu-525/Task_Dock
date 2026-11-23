//! 素材与产物版本模块（C4）：本地图片/视频路径导入、关联镜头/角色/场景、
//! 候选/采用/拒收状态、修改意见、多版本共存；同一镜头采用版本唯一。
//!
//! 本轮（2026-11-23 第二轮精修）：
//! - 导入表单的「关联类型 / 关联对象」是一个强一致状态机：换类型立即清空旧 ID，
//!   数据刷新后重新校验 ID 是否仍属于当前类型的有效选项，提交前再校验一次，
//!   绝不允许把上一类型残留的 ID 提交到后端；
//! - 列表给出缩略图 + 关联对象 + 状态 + 文件缺失；详情按需解码大图（视频/其它占位）；
//! - 同一镜头可挑两个图片版本并排比较，并直接从比较面板执行采用。
//!
//! 未接入 AI 生成模型，本面板不渲染任何「生成」按钮；归档只读。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { Columns2, X } from "lucide-react";
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
import { MediaPreview, MediaThumb } from "./MediaPreview";

type TargetKind = "shot" | "character" | "scene";

const KIND_OPTIONS: SelectOption<MediaKind>[] = (
  Object.keys(MEDIA_KIND_LABELS) as MediaKind[]
).map((value) => ({ value, label: MEDIA_KIND_LABELS[value] }));

const TARGET_KIND_OPTIONS: SelectOption<TargetKind>[] = [
  { value: "shot", label: "关联镜头" },
  { value: "character", label: "关联角色" },
  { value: "scene", label: "关联场景" },
];

const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif"];
const VIDEO_EXTENSIONS = ["mp4", "m4v", "mov", "webm", "mkv", "avi"];

/** 由扩展名推断素材类型：选择文件后自动对齐，避免「图片选了视频类型」。 */
export function mediaKindOfPath(path: string): MediaKind {
  const ext = path.split(/[\\/]/).pop()?.split(".").pop()?.toLowerCase() ?? "";
  if (IMAGE_EXTENSIONS.includes(ext)) return "image";
  if (VIDEO_EXTENSIONS.includes(ext)) return "video";
  return "other";
}

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
  const [picking, setPicking] = useState(false);

  /** 轻量比较：最多两个版本，且必须属于同一个镜头。 */
  const [compareIds, setCompareIds] = useState<string[]>([]);

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

  const targetOptions: SelectOption<string>[] = useMemo(
    () =>
      targetKind === "shot"
        ? shots.map((shot) => ({
            value: shot.id,
            label: `镜头 ${shot.shotNo} · ${shot.description || "（无描述）"}`,
          }))
        : targetKind === "character"
          ? characters.map((character) => ({ value: character.id, label: character.name }))
          : scenes.map((scene) => ({ value: scene.id, label: scene.name })),
    [targetKind, shots, characters, scenes],
  );

  /** 选项键：只在「当前类型下可选 ID 集合」变化时才触发重新校验。 */
  const targetOptionKey = useMemo(
    () => targetOptions.map((option) => option.value).join("|"),
    [targetOptions],
  );

  // 关联对象在刷新后可能已被删除或不再属当前类型：立即清空，避免下一次提交带上失效 ID。
  useEffect(() => {
    if (!targetId) return;
    if (targetOptions.some((option) => option.value === targetId)) return;
    setTargetId("");
    setSaveError("原关联对象已不存在或不属于当前关联类型，请重新选择");
  }, [targetId, targetOptionKey, targetOptions]);

  function changeTargetKind(next: TargetKind) {
    if (next === targetKind) return;
    setTargetKind(next);
    // 关键：换类型的同一帧里清掉旧 ID，绝不把镜头 ID 留给角色/场景使用。
    setTargetId("");
    setSaveError(null);
  }

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

  async function pickFile() {
    if (archived || saving || picking) return;
    setPicking(true);
    try {
      const selected = await openFileDialog({
        multiple: false,
        directory: false,
        title: "选择本地素材文件（只登记路径，不复制文件）",
        filters: [
          { name: "图片", extensions: IMAGE_EXTENSIONS },
          { name: "视频", extensions: VIDEO_EXTENSIONS },
        ],
      });
      if (typeof selected !== "string") return;
      setFilePath(selected);
      setMediaKind(mediaKindOfPath(selected));
    } catch (error) {
      setSaveError(`选择文件失败：${errorText(error)}`);
    } finally {
      setPicking(false);
    }
  }

  async function importVersion() {
    if (archived || saving) return;
    // 提交前再校验一次：targetId 必须仍在「当前关联类型」的有效选项里。
    const validIds = new Set(targetOptions.map((option) => option.value));
    if (!targetId) {
      setSaveError("请选择要关联的镜头、角色或场景");
      return;
    }
    if (!validIds.has(targetId)) {
      setTargetId("");
      setSaveError("关联对象已失效（可能已删除或不属于当前类型），请重新选择");
      return;
    }
    if (!filePath.trim()) {
      setSaveError("素材路径不能为空（登记本地绝对路径引用）");
      return;
    }
    setSaving(true);
    setSaveError(null);
    const submitted = {
      targetKind,
      targetId,
      filePath: filePath.trim(),
      mediaKind,
      versionLabel,
      reviewNote,
    };
    try {
      await comicMediaImport({
        projectId,
        shotId: submitted.targetKind === "shot" ? submitted.targetId : null,
        characterId: submitted.targetKind === "character" ? submitted.targetId : null,
        sceneId: submitted.targetKind === "scene" ? submitted.targetId : null,
        filePath: submitted.filePath,
        mediaKind: submitted.mediaKind,
        versionLabel: submitted.versionLabel || null,
        reviewNote: submitted.reviewNote || null,
      });
      onNotice("ok", "素材版本已导入（仅登记路径，未复制文件）");
      setShowImport(false);
      setTargetId("");
      setFilePath("");
      setVersionLabel("");
      setReviewNote("");
      await loadAll();
    } catch (error) {
      // 失败保留用户输入（目标、路径、标注、意见都不清），只提示错误。
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
      setCompareIds((prev) => prev.filter((id) => id !== version.id));
      await loadAll();
    } catch (error) {
      onNotice("error", `删除失败：${errorText(error)}`);
    } finally {
      setSaving(false);
      setDeleteArmedId(null);
    }
  }

  const selected = versions.find((version) => version.id === selectedId) ?? null;

  const comparable = (version: ComicMediaVersion) =>
    version.mediaKind === "image" && Boolean(version.shotId) && version.fileExists;

  function toggleCompare(version: ComicMediaVersion) {
    if (!comparable(version)) return;
    setCompareIds((prev) => {
      if (prev.includes(version.id)) return prev.filter((id) => id !== version.id);
      // 只允许同镜头：换镜头时以新镜头为准重开一组，避免跨镜头「比较」。
      const sameShot = prev.filter((id) => {
        const item = versions.find((candidate) => candidate.id === id);
        return item?.shotId === version.shotId;
      });
      return [...sameShot, version.id].slice(-2);
    });
    setSaveError(null);
  }

  const compareVersions = compareIds
    .map((id) => versions.find((version) => version.id === id))
    .filter((version): version is ComicMediaVersion => Boolean(version));
  const compareReady = compareVersions.length === 2;

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
                  onChange={changeTargetKind}
                  ariaLabel="关联类型"
                  disabled={saving}
                />
              </Field>
              <Field label="关联对象">
                <Select
                  value={targetId}
                  options={targetOptions}
                  onChange={setTargetId}
                  placeholder={targetOptions.length === 0 ? "当前类型下没有可关联对象" : "选择对象"}
                  ariaLabel="关联对象"
                  disabled={saving || targetOptions.length === 0}
                />
              </Field>
            </div>
            <Field label="本地文件绝对路径" htmlFor="comic-media-path">
              <div className="comic-path-row">
                <input
                  id="comic-media-path"
                  type="text"
                  className="ws-input ws-path"
                  disabled={saving}
                  value={filePath}
                  placeholder="如：D:/comic/shot-a1.png"
                  onChange={(event) => {
                    setFilePath(event.target.value);
                    setMediaKind(mediaKindOfPath(event.target.value));
                  }}
                />
                <button
                  type="button"
                  className="ws-btn"
                  disabled={saving || picking}
                  onClick={() => void pickFile()}
                >
                  {picking ? "选择中…" : "浏览…"}
                </button>
              </div>
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
              <div
                className={`comic-list-row${version.id === selectedId ? " is-active" : ""}`}
              >
                <button
                  type="button"
                  className="comic-row-main comic-row-with-thumb"
                  onClick={() => {
                    setSelectedId(version.id);
                    setSaveError(null);
                  }}
                >
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
                      {targetSummary(version)} · {MEDIA_STATUS_LABELS[version.status]}
                      {!version.fileExists ? " · 文件缺失" : ""}
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  className={`ws-btn ws-btn-quiet comic-compare-toggle${
                    compareIds.includes(version.id) ? " is-on" : ""
                  }`}
                  aria-pressed={compareIds.includes(version.id)}
                  aria-label={`对比 ${version.versionLabel || version.id}`}
                  data-tip={comparable(version) ? "加入比较" : "只有同一镜头的图片版本可比较"}
                  disabled={archived || !comparable(version)}
                  onClick={() => toggleCompare(version)}
                >
                  <Columns2 size={13} aria-hidden="true" />
                </button>
              </div>
            </li>
          ))}
          {!loading && versions.length === 0 && !loadError && (
            <li className="ws-empty">暂无素材版本，导入本地图片或视频开始管理。</li>
          )}
        </ul>
      </aside>

      <div className="comic-pane comic-pane-detail">
        {archived && <ArchivedBanner />}

        {compareReady && (
          <section className="ws-card comic-compare" aria-label="版本比较">
            <div className="comic-compare-head">
              <h3 className="ws-subhead">版本比较 · {targetSummary(compareVersions[0])}</h3>
              <button
                type="button"
                className="ws-btn ws-btn-quiet"
                aria-label="关闭比较"
                data-tip="关闭比较"
                onClick={() => setCompareIds([])}
              >
                <X size={13} aria-hidden="true" />
              </button>
            </div>
            <div className="comic-compare-grid">
              {compareVersions.map((version) => (
                <article key={version.id} className="comic-compare-pane">
                  <div className="comic-compare-meta">
                    <span className="comic-row-title">
                      {version.versionLabel || "未命名版本"}
                    </span>
                    <span
                      className={`ws-badge${
                        version.status === "adopted"
                          ? " ws-badge-available"
                          : version.status === "rejected"
                            ? " ws-badge-soft"
                            : ""
                      }`}
                    >
                      {MEDIA_STATUS_LABELS[version.status]}
                    </span>
                  </div>
                  <div className="comic-compare-stage">
                    <MediaPreview
                      path={version.filePath}
                      kind={version.mediaKind}
                      exists={version.fileExists}
                      label={version.versionLabel}
                    />
                  </div>
                  <p className="ws-meta comic-compare-note">
                    {version.reviewNote || "（未填写修改意见）"}
                  </p>
                  <button
                    type="button"
                    className="ws-btn ws-btn-primary"
                    disabled={archived || saving || version.status === "adopted"}
                    onClick={() => void adoptVersion(version)}
                  >
                    {version.status === "adopted" ? "当前采用" : "采用此版本"}
                  </button>
                </article>
              ))}
            </div>
            <p className="ws-meta">
              比较只并排显示两张已登记图片，不做像素差异计算；采用后同镜头其余版本回到候选。
            </p>
          </section>
        )}

        {compareIds.length === 1 && (
          <p className="ws-meta">已选 1 个版本，再选同一镜头的另一个图片版本即可并排比较。</p>
        )}

        {!selected && !loading && !compareReady && (
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

            <div className="comic-detail-stage">
              <MediaPreview
                path={selected.filePath}
                kind={selected.mediaKind}
                exists={selected.fileExists}
                label={selected.versionLabel}
              />
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
