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
import { Check, Columns2, Copy, X } from "lucide-react";
import { Select, type SelectOption } from "../../../components/ui";
import { copyText } from "../../../lib/clipboard";
import type { CreativeModuleProps } from "../types";
import {
  comicCharacterList,
  comicEpisodeList,
  comicGenerationRecordCreate,
  comicGenerationRecordList,
  comicMediaAdopt,
  comicMediaDelete,
  comicMediaImport,
  comicMediaList,
  comicMediaSave,
  comicPromptRender,
  comicPromptTemplateList,
  comicPromptVersionList,
  comicSceneList,
  comicShotList,
  comicSkillSnapshotList,
} from "./ipc";
import {
  MEDIA_KIND_LABELS,
  MEDIA_STATUS_LABELS,
  PROMPT_CATEGORY_LABELS,
  shortHash,
  type ComicCharacter,
  type ComicEpisode,
  type ComicGenerationRun,
  type ComicMediaVersion,
  type ComicPromptPreview,
  type ComicPromptTemplate,
  type ComicPromptVersion,
  type ComicScene,
  type ComicShot,
  type ComicSkillSnapshot,
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

/** 外部生成登记表单（v96）：只记录真实发生的外部生成，不触发生成。 */
interface GenerationDraft {
  episodeId: string;
  shotId: string;
  promptVersionId: string;
  skillSnapshotId: string;
  modelProvider: string;
  modelName: string;
  modelVersion: string;
  parametersJson: string;
  seed: string;
  externalJobId: string;
  note: string;
  inputMediaIds: string[];
}

const EMPTY_GENERATION: GenerationDraft = {
  episodeId: "",
  shotId: "",
  promptVersionId: "",
  skillSnapshotId: "",
  modelProvider: "",
  modelName: "",
  modelVersion: "",
  parametersJson: "{}",
  seed: "",
  externalJobId: "",
  note: "",
  inputMediaIds: [],
};

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

  // ── 外部生成记录（v96）────────────────────────────────────────────
  const [episodes, setEpisodes] = useState<ComicEpisode[]>([]);
  const [runs, setRuns] = useState<ComicGenerationRun[]>([]);
  const [promptTemplates, setPromptTemplates] = useState<ComicPromptTemplate[]>([]);
  const [promptVersions, setPromptVersions] = useState<ComicPromptVersion[]>([]);
  const [skillSnapshots, setSkillSnapshots] = useState<ComicSkillSnapshot[]>([]);
  const [showGeneration, setShowGeneration] = useState(false);
  const [generationDraft, setGenerationDraft] = useState<GenerationDraft>(EMPTY_GENERATION);
  const [generationTemplateId, setGenerationTemplateId] = useState("");
  const [generationError, setGenerationError] = useState<string | null>(null);
  /** 导入素材时可选关联的生成记录（镜头级同镜头；整集级同剧集）。 */
  const [importRunId, setImportRunId] = useState("");
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  /** 实际使用提示词：自动渲染只是初始内容，用户可以粘贴外部工具真正收到的文本。 */
  const [promptPreview, setPromptPreview] = useState<ComicPromptPreview | null>(null);
  const [promptPreviewError, setPromptPreviewError] = useState<string | null>(null);
  const [promptPreviewing, setPromptPreviewing] = useState(false);
  const [actualPrompt, setActualPrompt] = useState("");
  const [promptCopied, setPromptCopied] = useState(false);
  const copyTimerRef = useRef<number | null>(null);

  const seqRef = useRef(0);

  const loadAll = useCallback(async () => {
    const token = ++seqRef.current;
    setLoading(true);
    try {
      const [
        mediaResult,
        shotResult,
        characterResult,
        sceneResult,
        episodeResult,
        runResult,
        templateResult,
        snapshotResult,
      ] = await Promise.all([
        comicMediaList(projectId),
        comicShotList(projectId, null),
        comicCharacterList(projectId),
        comicSceneList(projectId),
        comicEpisodeList(projectId),
        comicGenerationRecordList(projectId),
        comicPromptTemplateList(projectId),
        comicSkillSnapshotList(projectId),
      ]);
      if (token !== seqRef.current) return;
      setVersions(mediaResult.versions ?? []);
      setShots(shotResult.shots ?? []);
      setCharacters(characterResult.characters ?? []);
      setScenes(sceneResult.scenes ?? []);
      const episodeList = episodeResult.episodes ?? [];
      setEpisodes(episodeList);
      setRuns(runResult.runs ?? []);
      const templates = templateResult.templates ?? [];
      setPromptTemplates(templates);
      setSkillSnapshots(snapshotResult.snapshots ?? []);
      setGenerationTemplateId((current) => current || templates[0]?.id || "");
      setGenerationDraft((current) => {
        if (current.episodeId) return current;
        return { ...current, episodeId: episodeList[0]?.id ?? "" };
      });
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

  // 模板变化 → 拉该模板版本并把默认版本作为预选（只读引用，不改默认）。
  useEffect(() => {
    if (!generationTemplateId) {
      setPromptVersions([]);
      return;
    }
    let cancelled = false;
    comicPromptVersionList(generationTemplateId)
      .then((result) => {
        if (cancelled) return;
        const list = result.versions ?? [];
        setPromptVersions(list);
        setGenerationDraft((prev) => {
          if (prev.promptVersionId && list.some((version) => version.id === prev.promptVersionId)) {
            return prev;
          }
          const fallback = list.find((version) => version.isDefault) ?? list[0] ?? null;
          return { ...prev, promptVersionId: fallback?.id ?? "" };
        });
      })
      .catch((error) => {
        if (cancelled) return;
        setPromptVersions([]);
        setGenerationError(errorText(error));
      });
    return () => {
      cancelled = true;
    };
  }, [generationTemplateId]);

  // 关联对象变化后，之前选的生成记录必然失效（必须同镜头/同剧集）。
  useEffect(() => {
    setImportRunId("");
  }, [targetId, targetKind]);

  /**
   * 剧集/镜头/版本变化 → 自动渲染提示词。
   *
   * 自动渲染只提供**初始内容**：外部 AI 可能根本没收到这份原文（用户可能改了、
   * 或工具自己加了参数），所以下面允许编辑/粘贴，登记时提交的是用户确认的实际文本。
   */
  useEffect(() => {
    if (!showGeneration) {
      setPromptPreview(null);
      setPromptPreviewError(null);
      return;
    }
    const episodeId = generationDraft.episodeId;
    const versionId = generationDraft.promptVersionId;
    if (!episodeId || !versionId) {
      setPromptPreview(null);
      setActualPrompt("");
      setPromptPreviewError(
        episodeId ? "请选择提示词版本后渲染" : "请选择剧集后渲染提示词",
      );
      return;
    }
    let cancelled = false;
    setPromptPreviewing(true);
    setPromptPreviewError(null);
    comicPromptRender({
      projectId,
      promptVersionId: versionId,
      episodeId,
      shotId: generationDraft.shotId || null,
    })
      .then((result) => {
        if (cancelled) return;
        setPromptPreview(result.preview);
        setActualPrompt(result.preview.rendered);
        setPromptCopied(false);
      })
      .catch((error) => {
        if (cancelled) return;
        setPromptPreview(null);
        setActualPrompt("");
        setPromptPreviewError(errorText(error));
      })
      .finally(() => {
        if (!cancelled) setPromptPreviewing(false);
      });
    return () => {
      cancelled = true;
    };
    // 只依赖选择项，不依赖整个草稿对象，避免输入模型名等字段时反复重新渲染。
  }, [
    projectId,
    showGeneration,
    generationDraft.episodeId,
    generationDraft.shotId,
    generationDraft.promptVersionId,
  ]);

  useEffect(
    () => () => {
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    },
    [],
  );

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

  // ── 外部生成：派生选项（只在当前剧集范围内）──────────────────────────
  const generationShots = useMemo(
    () => shots.filter((shot) => shot.episodeId === generationDraft.episodeId),
    [shots, generationDraft.episodeId],
  );
  const generationShotIds = useMemo(
    () => new Set(generationShots.map((shot) => shot.id)),
    [generationShots],
  );
  const generationMediaOptions = useMemo(
    () =>
      versions.filter(
        (version) => version.shotId && generationShotIds.has(version.shotId),
      ),
    [versions, generationShotIds],
  );
  /**
   * 可关联的生成记录（v99）：
   * - 镜头级记录（shotId 有值）：只能关联同一镜头；
   * - 整集级记录（shotId 为 null）：只能关联本集任意镜头，跨集/跨项目一律不出现。
   */
  const importRunOptions = useMemo(() => {
    if (targetKind !== "shot" || !targetId) return [];
    const targetShot = shots.find((shot) => shot.id === targetId);
    if (!targetShot) return [];
    return runs.filter(
      (run) =>
        run.shotId === targetShot.id ||
        (run.shotId === null && run.episodeId === targetShot.episodeId),
    );
  }, [runs, shots, targetKind, targetId]);

  /** 与自动渲染相比是否被修改过（提示用户「外部工具收到的可能不是原文」）。 */
  const promptDiffers = Boolean(
    promptPreview && actualPrompt.trim() !== promptPreview.rendered.trim(),
  );

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
      generationRunId: targetKind === "shot" ? importRunId : "",
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
        generationRunId: submitted.generationRunId || null,
      });
      onNotice("ok", "素材版本已导入（仅登记路径，未复制文件）");
      setShowImport(false);
      setTargetId("");
      setImportRunId("");
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

  /** 登记一次真实外部生成：提交用户确认的「实际使用提示词」，后端不再重新渲染覆盖。 */
  async function registerGeneration() {
    if (archived || saving) return;
    if (!generationDraft.episodeId) {
      setGenerationError("请选择剧集");
      return;
    }
    if (!generationDraft.promptVersionId) {
      setGenerationError("请选择提示词版本（可追溯性要求）");
      return;
    }
    if (!actualPrompt.trim()) {
      setGenerationError(
        "请填写外部工具实际收到的提示词：可先渲染预览，再粘贴/粘贴工具里真正使用的文本",
      );
      return;
    }
    const paramsRaw = generationDraft.parametersJson.trim() || "{}";
    try {
      JSON.parse(paramsRaw);
    } catch {
      setGenerationError("生成参数必须是合法 JSON");
      return;
    }
    setSaving(true);
    setGenerationError(null);
    try {
      const result = await comicGenerationRecordCreate({
        projectId,
        episodeId: generationDraft.episodeId,
        shotId: generationDraft.shotId || null,
        promptVersionId: generationDraft.promptVersionId,
        renderedPromptSnapshot: actualPrompt,
        skillSnapshotId: generationDraft.skillSnapshotId || null,
        modelProvider: generationDraft.modelProvider,
        modelName: generationDraft.modelName,
        modelVersion: generationDraft.modelVersion,
        parametersJson: paramsRaw,
        seed: generationDraft.seed,
        inputMediaIds: generationDraft.inputMediaIds,
        externalJobId: generationDraft.externalJobId,
        note: generationDraft.note,
      });
      onNotice(
        "ok",
        `已登记外部生成记录：${result.run.modelProvider || "外部工具"}${
          result.run.modelName ? ` · ${result.run.modelName}` : ""
        }`,
      );
      setShowGeneration(false);
      setGenerationDraft((prev) => ({
        ...prev,
        note: "",
        seed: "",
        externalJobId: "",
        inputMediaIds: [],
      }));
      setActualPrompt("");
      setPromptPreview(null);
      await loadAll();
      setExpandedRunId(result.run.id);
    } catch (error) {
      setGenerationError(errorText(error));
      onNotice("error", `登记外部生成失败：${errorText(error)}`);
    } finally {
      setSaving(false);
    }
  }

  /** 复制实际使用提示词：统一走 Task Dock 受控剪贴板（失败如实提示，不回退 Web API）。 */
  async function copyActualPrompt() {
    const text = actualPrompt;
    if (!text.trim()) {
      setGenerationError("提示词为空，无法复制");
      return;
    }
    setGenerationError(null);
    const ok = await copyText(text);
    if (!ok) {
      onNotice("error", "复制失败：剪贴板被占用或系统拒绝写入");
      return;
    }
    setPromptCopied(true);
    onNotice("ok", "已复制提示词到剪贴板");
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    copyTimerRef.current = window.setTimeout(() => {
      setPromptCopied(false);
      copyTimerRef.current = null;
    }, 2000);
  }

  function changeGenerationEpisode(episodeId: string) {
    setGenerationDraft((prev) => ({
      ...prev,
      episodeId,
      shotId: "",
      inputMediaIds: [],
    }));
  }

  function toggleInputMedia(mediaId: string) {
    setGenerationDraft((prev) => ({
      ...prev,
      inputMediaIds: prev.inputMediaIds.includes(mediaId)
        ? prev.inputMediaIds.filter((id) => id !== mediaId)
        : [...prev.inputMediaIds, mediaId],
    }));
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
          <button
            type="button"
            className="ws-btn"
            disabled={archived}
            aria-expanded={showGeneration}
            onClick={() => {
              setShowGeneration((value) => !value);
              setGenerationError(null);
            }}
          >
            {showGeneration ? "收起生成登记" : "登记外部生成"}
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
            {targetKind === "shot" && (
              <Field
                label="关联生成记录"
                hint={
                  importRunOptions.length === 0
                    ? "该集暂无可用生成记录"
                    : "可选：镜头级限同镜头 · 整集级限本集"
                }
              >
                <Select
                  value={importRunId}
                  options={[
                    { value: "", label: "不关联生成记录" },
                    ...importRunOptions.map((run) => ({
                      value: run.id,
                      label: `${run.shotId ? `镜头 ${run.shotNo ?? "?"}` : "整集级"} · ${
                        run.modelProvider || "外部工具"
                      }${run.modelName ? ` · ${run.modelName}` : ""} · 提示词 v${run.promptVersionNo} · ${run.createdAt.slice(0, 10)}`,
                    })),
                  ]}
                  onChange={setImportRunId}
                  ariaLabel="关联生成记录"
                  disabled={saving || importRunOptions.length === 0}
                />
              </Field>
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
                disabled={saving || !targetId || !filePath.trim()}
                onClick={() => void importVersion()}
              >
                {saving ? "导入中…" : "登记素材"}
              </button>
            </div>
          </div>
        )}

        {showGeneration && !archived && (
          <div className="ws-card comic-import-form" role="group" aria-label="登记外部生成">
            <p className="ws-meta">
              只登记真实发生的外部生成：本应用<strong>不调用</strong>图像/视频模型，
              也不会伪造生成成功。
            </p>

            <Field label="剧集">
              <Select
                value={generationDraft.episodeId}
                options={episodes.map((episode) => ({
                  value: episode.id,
                  label: `第 ${episode.episodeNo} 集 · ${episode.title}`,
                }))}
                onChange={changeGenerationEpisode}
                placeholder="选择剧集"
                ariaLabel="生成记录剧集"
                disabled={saving || episodes.length === 0}
              />
            </Field>

            <Field label="镜头" hint="可选；不选则记整集">
              <Select
                value={generationDraft.shotId}
                options={[
                  { value: "", label: "整集（不指定镜头）" },
                  ...generationShots.map((shot) => ({
                    value: shot.id,
                    label: `镜头 ${shot.shotNo} · ${shot.description || "（无描述）"}`,
                  })),
                ]}
                onChange={(value) => setGenerationDraft({ ...generationDraft, shotId: value })}
                ariaLabel="生成记录镜头"
                disabled={saving || !generationDraft.episodeId}
              />
            </Field>

            <Field label="提示词模板">
              <Select
                value={generationTemplateId}
                options={promptTemplates.map((template) => ({
                  value: template.id,
                  label: `${template.name} · ${PROMPT_CATEGORY_LABELS[template.category]}`,
                }))}
                onChange={setGenerationTemplateId}
                placeholder={promptTemplates.length === 0 ? "暂无提示词模板" : "选择模板"}
                ariaLabel="生成记录提示词模板"
                disabled={saving || promptTemplates.length === 0}
              />
            </Field>

            <Field label="提示词版本" hint="记录会保存实际使用的提示词">
              <Select
                value={generationDraft.promptVersionId}
                options={promptVersions.map((version) => ({
                  value: version.id,
                  label: `v${version.versionNo}${version.isDefault ? " · 默认" : ""} · ${shortHash(version.contentHash)}`,
                }))}
                onChange={(value) =>
                  setGenerationDraft({ ...generationDraft, promptVersionId: value })
                }
                placeholder={promptVersions.length === 0 ? "该模板暂无版本" : "选择版本"}
                ariaLabel="生成记录提示词版本"
                disabled={saving || promptVersions.length === 0}
              />
            </Field>

            <section className="comic-prompt-actual" aria-label="实际使用提示词">
              <div className="comic-stats-head">
                <span className="comic-field-label">实际使用提示词</span>
                <span className="ws-meta">
                  {promptPreview
                    ? `v${promptPreview.versionNo} · Hash ${shortHash(promptPreview.contentHash)}`
                    : "尚未渲染"}
                </span>
              </div>
              <p className="ws-meta">
                自动渲染只是初始内容；外部 AI 可能收到的是你改过或工具补过的文本，
                请粘贴/核对后再登记。登记后快照不可再修改。
              </p>
              <textarea
                className="ws-textarea comic-prompt-body"
                rows={8}
                aria-label="实际使用提示词"
                disabled={saving}
                value={actualPrompt}
                placeholder="选择剧集与版本后自动填入渲染结果，也可直接粘贴外部工具里的提示词"
                onChange={(event) => setActualPrompt(event.target.value)}
              />
              {promptDiffers && (
                <p className="ws-notice" data-tone="info" role="status">
                  <span>已修改：登记将保存当前文本（与自动渲染结果不同）。</span>
                </p>
              )}
              {promptPreviewing && <p className="ws-meta">渲染中…</p>}
              {promptPreviewError && (
                <p className="ws-notice" data-tone="error" role="alert">
                  <span>{promptPreviewError}</span>
                </p>
              )}
              <div className="ws-form-actions">
                <button
                  type="button"
                  className="ws-btn"
                  disabled={saving || !actualPrompt.trim()}
                  onClick={() => void copyActualPrompt()}
                >
                  {promptCopied ? (
                    <>
                      <Check size={13} aria-hidden="true" /> 已复制提示词
                    </>
                  ) : (
                    <>
                      <Copy size={13} aria-hidden="true" /> 复制提示词
                    </>
                  )}
                </button>
                <button
                  type="button"
                  className="ws-btn"
                  disabled={saving || !promptPreview}
                  onClick={() => {
                    if (promptPreview) setActualPrompt(promptPreview.rendered);
                  }}
                >
                  恢复为自动渲染内容
                </button>
              </div>
            </section>

            <Field label="Skill 快照" hint="可选">
              <Select
                value={generationDraft.skillSnapshotId}
                options={[
                  { value: "", label: "不使用 Skill" },
                  ...skillSnapshots.map((snapshot) => ({
                    value: snapshot.id,
                    label: `${snapshot.skillName} · ${snapshot.declaredVersion || "未声明"} · ${shortHash(snapshot.contentHash)}`,
                  })),
                ]}
                onChange={(value) =>
                  setGenerationDraft({ ...generationDraft, skillSnapshotId: value })
                }
                ariaLabel="生成记录 Skill 快照"
                disabled={saving}
              />
            </Field>

            <Field label="模型提供商" htmlFor="gen-provider">
              <input
                id="gen-provider"
                type="text"
                className="ws-input"
                placeholder="如：Midjourney / 可灵 / 即梦"
                disabled={saving}
                value={generationDraft.modelProvider}
                onChange={(event) =>
                  setGenerationDraft({ ...generationDraft, modelProvider: event.target.value })
                }
              />
            </Field>

            <Field label="模型名称" htmlFor="gen-model">
              <input
                id="gen-model"
                type="text"
                className="ws-input"
                disabled={saving}
                value={generationDraft.modelName}
                onChange={(event) =>
                  setGenerationDraft({ ...generationDraft, modelName: event.target.value })
                }
              />
            </Field>

            <Field label="模型版本" htmlFor="gen-model-version">
              <input
                id="gen-model-version"
                type="text"
                className="ws-input"
                disabled={saving}
                value={generationDraft.modelVersion}
                onChange={(event) =>
                  setGenerationDraft({ ...generationDraft, modelVersion: event.target.value })
                }
              />
            </Field>

            <Field label="参数 JSON" htmlFor="gen-params">
              <textarea
                id="gen-params"
                className="ws-textarea comic-prompt-params"
                rows={3}
                disabled={saving}
                value={generationDraft.parametersJson}
                onChange={(event) =>
                  setGenerationDraft({ ...generationDraft, parametersJson: event.target.value })
                }
              />
            </Field>

            <Field label="随机种子" htmlFor="gen-seed">
              <input
                id="gen-seed"
                type="text"
                className="ws-input"
                disabled={saving}
                value={generationDraft.seed}
                onChange={(event) =>
                  setGenerationDraft({ ...generationDraft, seed: event.target.value })
                }
              />
            </Field>

            <Field label="外部任务 ID" htmlFor="gen-job">
              <input
                id="gen-job"
                type="text"
                className="ws-input"
                disabled={saving}
                value={generationDraft.externalJobId}
                onChange={(event) =>
                  setGenerationDraft({ ...generationDraft, externalJobId: event.target.value })
                }
              />
            </Field>

            <fieldset className="comic-check-group">
              <legend className="comic-field-label">
                输入素材
                <em className="comic-field-hint">可选，限本集素材版本</em>
              </legend>
              {generationMediaOptions.length === 0 ? (
                <p className="ws-meta">本集暂无素材版本，可留空。</p>
              ) : (
                <div className="comic-check-grid">
                  {generationMediaOptions.map((version) => (
                    <label key={version.id} className="comic-check">
                      <input
                        type="checkbox"
                        checked={generationDraft.inputMediaIds.includes(version.id)}
                        disabled={saving}
                        onChange={() => toggleInputMedia(version.id)}
                      />
                      <span>
                        {version.versionLabel || "未命名版本"} ·{" "}
                        {MEDIA_KIND_LABELS[version.mediaKind]}
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </fieldset>

            <Field label="备注" htmlFor="gen-note">
              <textarea
                id="gen-note"
                className="ws-textarea"
                rows={2}
                disabled={saving}
                value={generationDraft.note}
                onChange={(event) =>
                  setGenerationDraft({ ...generationDraft, note: event.target.value })
                }
              />
            </Field>

            {generationError && (
              <p className="ws-notice" data-tone="error" role="alert">
                <span>{generationError}</span>
              </p>
            )}

            <div className="ws-form-actions">
              <button
                type="button"
                className="ws-btn ws-btn-primary"
                disabled={saving}
                onClick={() => void registerGeneration()}
              >
                {saving ? "登记中…" : "登记生成记录"}
              </button>
              <button
                type="button"
                className="ws-btn"
                disabled={saving}
                onClick={() => {
                  setShowGeneration(false);
                  setGenerationError(null);
                }}
              >
                取消
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
                      {version.generationRunId ? " · 有生成记录" : ""}
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

            {selected.generationRunId && (
              <p className="ws-meta">
                生成来源：{selected.generationLabel || "外部生成"} · 记录{" "}
                {shortHash(selected.generationRunId)}（删除素材版本不会删除生成历史）
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

        <section className="comic-generation-runs" aria-label="外部生成记录">
          <div className="comic-stats-head">
            <span className="comic-field-label">外部生成记录</span>
            <span className="ws-meta">
              {runs.length} 条 · 只追加，不提供删除入口
            </span>
          </div>
          {runs.length === 0 && (
            <p className="ws-meta">
              还没有生成记录。用「登记外部生成」记录一次真实的外部生成，之后导入产物即可关联追溯。
            </p>
          )}
          <ul className="ws-list">
            {runs.slice(0, 30).map((run) => (
              <li key={run.id} className="comic-generation-run">
                <div className="comic-generation-run-head">
                  <span className="comic-row-title">
                    {run.episodeTitle}
                    {run.shotNo ? ` · 镜头 ${run.shotNo}` : " · 整集"}
                  </span>
                  <span className="ws-meta">{run.createdAt.replace("T", " ").slice(0, 19)}</span>
                </div>
                <p className="ws-meta">
                  {run.modelProvider || "未填写提供商"}
                  {run.modelName ? ` · ${run.modelName}` : ""}
                  {run.modelVersion ? ` · ${run.modelVersion}` : ""} · 提示词「
                  {run.promptTemplateName}」v{run.promptVersionNo}
                  {run.skillName
                    ? ` · Skill ${run.skillName}（声明 ${
                        run.skillDeclaredVersion || "未声明"
                      } / 内容 ${shortHash(run.skillContentHashSnapshot)}）`
                    : " · 未使用 Skill"}
                </p>
                <p className="ws-meta">
                  种子 {run.seed || "—"} · 输入素材 {run.inputMediaIds.length} 项 · 输出素材{" "}
                  {(run.outputMediaIds ?? []).length} 项
                  {run.externalJobId ? ` · 外部任务 ${run.externalJobId}` : ""}
                </p>
                {run.note && <p className="ws-meta">备注：{run.note}</p>}
                <div className="ws-form-actions">
                  <button
                    type="button"
                    className="ws-btn ws-btn-quiet"
                    aria-expanded={expandedRunId === run.id}
                    onClick={() =>
                      setExpandedRunId((current) => (current === run.id ? null : run.id))
                    }
                  >
                    {expandedRunId === run.id ? "收起渲染快照" : "查看实际渲染提示词"}
                  </button>
                  {run.inputMediaIds.length > 0 && (
                    <button
                      type="button"
                      className="ws-btn ws-btn-quiet"
                      onClick={() => {
                        setSelectedId(run.inputMediaIds[0]);
                        setSaveError(null);
                      }}
                    >
                      查看首个输入素材
                    </button>
                  )}
                  {(run.outputMediaIds ?? []).length > 0 && (
                    <button
                      type="button"
                      className="ws-btn ws-btn-quiet"
                      onClick={() => {
                        setSelectedId(run.outputMediaIds[0]);
                        setSaveError(null);
                      }}
                    >
                      查看首个输出素材
                    </button>
                  )}
                </div>
                {expandedRunId === run.id && (
                  <>
                    <pre className="comic-prompt-pre">{run.renderedPromptSnapshot}</pre>
                    <details className="comic-prompt-vars">
                      <summary>生成参数 JSON</summary>
                      <pre className="comic-prompt-pre comic-prompt-manifest">
                        {run.parametersJson}
                      </pre>
                    </details>
                  </>
                )}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
