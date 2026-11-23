//! 角色与场景参考模块（C3）：角色设定、场景设定、参考图路径引用；
//! 剧集↔角色、镜头↔角色、镜头↔场景关系在剧集/分镜面板维护，本模块负责档案本体。
//! 归档只读；失败可见 + 可重试。
//!
//! 参考图（2026-11-23 第二轮）：沿用既有 `ref_image_path` 字段，只补「文件选择器 →
//! 缩略图 → 大图预览 → 缺失提醒」；不新增字段、不改数据结构，也不影响其它字段编辑。

import { useCallback, useEffect, useRef, useState } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { ImagePlus, Trash2 } from "lucide-react";
import type { CreativeModuleProps } from "../types";
import {
  comicCharacterDelete,
  comicCharacterList,
  comicCharacterSave,
  comicSceneDelete,
  comicSceneList,
  comicSceneSave,
} from "./ipc";
import type { ComicCharacter, ComicScene } from "./types";
import { ArchivedBanner, errorText, Field, LoadError } from "./shared";
import { MediaPreview, MediaThumb } from "./MediaPreview";

const REF_IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif"];

type Selection =
  | { kind: "character"; id: string }
  | { kind: "scene"; id: string }
  | null;

interface CharacterDraft {
  name: string;
  role: string;
  description: string;
  refImagePath: string;
}

interface SceneDraft {
  name: string;
  description: string;
  refImagePath: string;
}

const EMPTY_CHARACTER: CharacterDraft = {
  name: "",
  role: "",
  description: "",
  refImagePath: "",
};

const EMPTY_SCENE: SceneDraft = {
  name: "",
  description: "",
  refImagePath: "",
};

interface ReferenceImageFieldProps {
  inputId: string;
  value: string;
  /** 已保存记录的文件存在性；草稿改了路径时按「待保存后校验」处理。 */
  exists: boolean;
  /** 草稿路径与已保存记录一致（否则存在性是未知的，不能当作缺失报警）。 */
  saved: boolean;
  disabled: boolean;
  picking: boolean;
  onPick: () => void;
  onChange: (next: string) => void;
}

/** 参考图字段：缩略图 + 路径 + 选择/预览/清除；缺失只提醒，不自动清空路径。 */
function ReferenceImageField({
  inputId,
  value,
  exists,
  saved,
  disabled,
  picking,
  onPick,
  onChange,
}: ReferenceImageFieldProps) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const missing = saved && Boolean(value) && !exists;
  const knownExists = saved ? exists : true;

  return (
    <div className="comic-field">
      <span className="comic-field-label">
        参考图
        <em className="comic-field-hint">绝对路径引用，不复制文件</em>
      </span>
      <div className="comic-ref-row">
        <MediaThumb
          path={value}
          kind="image"
          exists={knownExists}
          placeholder="未设置参考图"
        />
        <input
          id={inputId}
          type="text"
          className="ws-input ws-path"
          aria-label="参考图路径"
          disabled={disabled}
          value={value}
          placeholder="如：D:/comic/character-ref.png"
          onChange={(event) => onChange(event.target.value)}
        />
        <button
          type="button"
          className="ws-btn"
          disabled={disabled || picking}
          onClick={onPick}
        >
          <ImagePlus size={13} aria-hidden="true" />
          {picking ? "选择中…" : "选择图片"}
        </button>
        <button
          type="button"
          className="ws-btn ws-btn-quiet"
          aria-expanded={previewOpen}
          disabled={!value.trim()}
          onClick={() => setPreviewOpen((open) => !open)}
        >
          {previewOpen ? "收起" : "预览"}
        </button>
        <button
          type="button"
          className="ws-btn ws-btn-quiet"
          aria-label="清除参考图"
          data-tip="清除参考图路径"
          disabled={disabled || !value}
          onClick={() => {
            setPreviewOpen(false);
            onChange("");
          }}
        >
          <Trash2 size={13} aria-hidden="true" />
        </button>
      </div>
      {missing && (
        <p className="ws-meta" data-tone="error" role="status">
          参考图文件缺失：路径当前不存在（文件被移动或删除）。字段保留，重新选择图片即可替换。
        </p>
      )}
      {previewOpen && value.trim() && (
        <div className="comic-detail-stage">
          <MediaPreview path={value} kind="image" exists={knownExists} label="参考图" />
        </div>
      )}
    </div>
  );
}

export function CharactersPanel({ projectId, archived, onNotice }: CreativeModuleProps) {
  const [characters, setCharacters] = useState<ComicCharacter[]>([]);
  const [scenes, setScenes] = useState<ComicScene[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [selection, setSelection] = useState<Selection>(null);
  const [characterDraft, setCharacterDraft] = useState<CharacterDraft>(EMPTY_CHARACTER);
  const [sceneDraft, setSceneDraft] = useState<SceneDraft>(EMPTY_SCENE);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [pickingRef, setPickingRef] = useState(false);

  const seqRef = useRef(0);

  const loadAll = useCallback(async () => {
    const token = ++seqRef.current;
    setLoading(true);
    try {
      const [characterResult, sceneResult] = await Promise.all([
        comicCharacterList(projectId),
        comicSceneList(projectId),
      ]);
      if (token !== seqRef.current) return;
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

  function selectCharacter(character: ComicCharacter) {
    setSelection({ kind: "character", id: character.id });
    setCharacterDraft({
      name: character.name,
      role: character.role,
      description: character.description,
      refImagePath: character.refImagePath,
    });
    setSaveError(null);
    setDeleteArmed(false);
  }

  function selectScene(scene: ComicScene) {
    setSelection({ kind: "scene", id: scene.id });
    setSceneDraft({
      name: scene.name,
      description: scene.description,
      refImagePath: scene.refImagePath,
    });
    setSaveError(null);
    setDeleteArmed(false);
  }

  function startNewCharacter() {
    setSelection({ kind: "character", id: "" });
    setCharacterDraft(EMPTY_CHARACTER);
    setSaveError(null);
    setDeleteArmed(false);
  }

  function startNewScene() {
    setSelection({ kind: "scene", id: "" });
    setSceneDraft(EMPTY_SCENE);
    setSaveError(null);
    setDeleteArmed(false);
  }

  async function saveCharacter() {
    if (archived || saving) return;
    if (!characterDraft.name.trim()) {
      setSaveError("角色名称不能为空");
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const result = await comicCharacterSave({
        id: selection?.id || null,
        projectId,
        name: characterDraft.name,
        role: characterDraft.role,
        description: characterDraft.description,
        refImagePath: characterDraft.refImagePath || null,
      });
      onNotice("ok", selection?.id ? "角色已更新" : `已新建角色「${result.character.name}」`);
      await loadAll();
      selectCharacter(result.character);
    } catch (error) {
      setSaveError(errorText(error));
      onNotice("error", `保存角色失败：${errorText(error)}`);
    } finally {
      setSaving(false);
    }
  }

  async function saveScene() {
    if (archived || saving) return;
    if (!sceneDraft.name.trim()) {
      setSaveError("场景名称不能为空");
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const result = await comicSceneSave({
        id: selection?.id || null,
        projectId,
        name: sceneDraft.name,
        description: sceneDraft.description,
        refImagePath: sceneDraft.refImagePath || null,
      });
      onNotice("ok", selection?.id ? "场景已更新" : `已新建场景「${result.scene.name}」`);
      await loadAll();
      selectScene(result.scene);
    } catch (error) {
      setSaveError(errorText(error));
      onNotice("error", `保存场景失败：${errorText(error)}`);
    } finally {
      setSaving(false);
    }
  }

  async function removeSelected() {
    if (!selection?.id || archived || saving) return;
    if (!deleteArmed) {
      setDeleteArmed(true);
      return;
    }
    setSaving(true);
    try {
      if (selection.kind === "character") {
        await comicCharacterDelete(selection.id);
      } else {
        await comicSceneDelete(selection.id);
      }
      onNotice("ok", "已删除");
      setSelection(null);
      await loadAll();
    } catch (error) {
      onNotice("error", `删除失败：${errorText(error)}`);
    } finally {
      setSaving(false);
      setDeleteArmed(false);
    }
  }

  const isCharacter = selection?.kind === "character";

  /** 已保存记录：用于区分「保存过的路径存在性」与「草稿里刚改的新路径」。 */
  const savedCharacter =
    characters.find((character) => character.id === selection?.id) ?? null;
  const savedScene = scenes.find((scene) => scene.id === selection?.id) ?? null;

  async function pickRefImage(target: "character" | "scene") {
    if (archived || saving || pickingRef) return;
    setPickingRef(true);
    setSaveError(null);
    try {
      const selectedPath = await openFileDialog({
        multiple: false,
        directory: false,
        title: "选择参考图（只登记路径，不复制文件）",
        filters: [{ name: "图片", extensions: REF_IMAGE_EXTENSIONS }],
      });
      if (typeof selectedPath !== "string") return;
      if (target === "character") {
        setCharacterDraft((prev) => ({ ...prev, refImagePath: selectedPath }));
      } else {
        setSceneDraft((prev) => ({ ...prev, refImagePath: selectedPath }));
      }
    } catch (error) {
      const message = `选择图片失败：${errorText(error)}`;
      setSaveError(message);
      onNotice("error", message);
    } finally {
      setPickingRef(false);
    }
  }

  return (
    <div className="comic-layout">
      <aside className="comic-pane comic-pane-list" aria-label="角色与场景列表">
        <div className="comic-toolbar">
          <button type="button" className="ws-btn" disabled={archived} onClick={startNewCharacter}>
            新角色
          </button>
          <button type="button" className="ws-btn" disabled={archived} onClick={startNewScene}>
            新场景
          </button>
        </div>

        {loadError && <LoadError message={loadError} onRetry={() => void loadAll()} />}
        {loading && !loadError && <p className="ws-empty">加载中…</p>}

        <h3 className="ws-subhead">角色</h3>
        <ul className="ws-list">
          {characters.map((character) => (
            <li key={character.id}>
              <button
                type="button"
                className={`comic-list-row comic-row-main${
                  selection?.kind === "character" && selection.id === character.id ? " is-active" : ""
                }`}
                onClick={() => selectCharacter(character)}
              >
                <span className="comic-row-title">{character.name}</span>
                <span className="ws-meta">
                  {character.role || "未定位"}
                  {character.refImagePath && !character.refImageExists ? " · 参考图缺失" : ""}
                </span>
              </button>
            </li>
          ))}
          {!loading && characters.length === 0 && <li className="ws-empty">暂无角色。</li>}
        </ul>

        <h3 className="ws-subhead">场景</h3>
        <ul className="ws-list">
          {scenes.map((scene) => (
            <li key={scene.id}>
              <button
                type="button"
                className={`comic-list-row comic-row-main${
                  selection?.kind === "scene" && selection.id === scene.id ? " is-active" : ""
                }`}
                onClick={() => selectScene(scene)}
              >
                <span className="comic-row-title">{scene.name}</span>
                <span className="ws-meta">
                  {scene.description || "未填写描述"}
                  {scene.refImagePath && !scene.refImageExists ? " · 参考图缺失" : ""}
                </span>
              </button>
            </li>
          ))}
          {!loading && scenes.length === 0 && <li className="ws-empty">暂无场景。</li>}
        </ul>
      </aside>

      <div className="comic-pane comic-pane-detail">
        {archived && <ArchivedBanner />}

        {!selection && !loading && (
          <p className="ws-empty">从左侧选择角色或场景，或新建档案。</p>
        )}

        {selection && isCharacter && (
          <div className="comic-form">
            <Field label="角色名称" htmlFor="comic-char-name">
              <input
                id="comic-char-name"
                type="text"
                className="ws-input"
                disabled={archived || saving}
                value={characterDraft.name}
                onChange={(event) => setCharacterDraft({ ...characterDraft, name: event.target.value })}
              />
            </Field>
            <Field label="角色定位" htmlFor="comic-char-role" hint="如：小前锋 / 后卫 / 对手">
              <input
                id="comic-char-role"
                type="text"
                className="ws-input"
                disabled={archived || saving}
                value={characterDraft.role}
                onChange={(event) => setCharacterDraft({ ...characterDraft, role: event.target.value })}
              />
            </Field>
            <Field label="角色设定" htmlFor="comic-char-desc">
              <textarea
                id="comic-char-desc"
                className="ws-textarea"
                rows={4}
                disabled={archived || saving}
                value={characterDraft.description}
                onChange={(event) =>
                  setCharacterDraft({ ...characterDraft, description: event.target.value })
                }
              />
            </Field>
            <ReferenceImageField
              inputId="comic-char-ref"
              value={characterDraft.refImagePath}
              exists={savedCharacter?.refImageExists ?? false}
              saved={
                Boolean(savedCharacter) &&
                savedCharacter?.refImagePath === characterDraft.refImagePath
              }
              disabled={archived || saving}
              picking={pickingRef}
              onPick={() => void pickRefImage("character")}
              onChange={(next) =>
                setCharacterDraft({ ...characterDraft, refImagePath: next })
              }
            />

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
                onClick={() => void saveCharacter()}
              >
                {saving ? "保存中…" : "保存角色"}
              </button>
              <button
                type="button"
                className={`ws-btn ws-btn-danger${deleteArmed ? " is-armed" : ""}`}
                disabled={archived || saving || !selection.id}
                onClick={() => void removeSelected()}
              >
                {deleteArmed ? "再次点击确认删除" : "删除角色"}
              </button>
            </div>
          </div>
        )}

        {selection && !isCharacter && (
          <div className="comic-form">
            <Field label="场景名称" htmlFor="comic-scene-name">
              <input
                id="comic-scene-name"
                type="text"
                className="ws-input"
                disabled={archived || saving}
                value={sceneDraft.name}
                onChange={(event) => setSceneDraft({ ...sceneDraft, name: event.target.value })}
              />
            </Field>
            <Field label="场景设定" htmlFor="comic-scene-desc">
              <textarea
                id="comic-scene-desc"
                className="ws-textarea"
                rows={4}
                disabled={archived || saving}
                value={sceneDraft.description}
                onChange={(event) =>
                  setSceneDraft({ ...sceneDraft, description: event.target.value })
                }
              />
            </Field>
            <ReferenceImageField
              inputId="comic-scene-ref"
              value={sceneDraft.refImagePath}
              exists={savedScene?.refImageExists ?? false}
              saved={Boolean(savedScene) && savedScene?.refImagePath === sceneDraft.refImagePath}
              disabled={archived || saving}
              picking={pickingRef}
              onPick={() => void pickRefImage("scene")}
              onChange={(next) => setSceneDraft({ ...sceneDraft, refImagePath: next })}
            />

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
                onClick={() => void saveScene()}
              >
                {saving ? "保存中…" : "保存场景"}
              </button>
              <button
                type="button"
                className={`ws-btn ws-btn-danger${deleteArmed ? " is-armed" : ""}`}
                disabled={archived || saving || !selection.id}
                onClick={() => void removeSelected()}
              >
                {deleteArmed ? "再次点击确认删除" : "删除场景"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
