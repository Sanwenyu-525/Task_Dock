//! 提示词与 Skill 模块（C3 / v96）：提示词模板、不可变版本、纯文本渲染预览、
//! Skill 内容快照与「声明版本 vs 实际内容版本」区分。
//!
//! ## 边界（诚实声明）
//! - 只做提示词与版本管理、预览、Skill 快照与外部生成追溯；
//! - **不调用任何图像/视频生成模型**，`comic.generate` 仍为 unavailable；
//! - 旧版本只读：保存永远追加新版本，切换默认版本走事务；
//! - Skill 列表来自能力中心（`capability_skill_list`），本模块不复制第二套 Skill 存储。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Select, type SelectOption } from "../../../components/ui";
import { copyText } from "../../../lib/clipboard";
import type { CreativeModuleProps } from "../types";
import {
  comicEpisodeList,
  comicPromptRender,
  comicPromptTemplateList,
  comicPromptTemplateSave,
  comicPromptVersionCreate,
  comicPromptVersionList,
  comicPromptVersionSetDefault,
  comicShotList,
  comicSkillList,
  comicSkillSnapshotCapture,
  comicSkillSnapshotGet,
  comicSkillSnapshotList,
} from "./ipc";
import {
  COMIC_PROMPT_VARIABLES,
  PROMPT_CATEGORY_LABELS,
  shortHash,
  type ComicEpisode,
  type ComicPromptPreview,
  type ComicPromptTemplate,
  type ComicPromptVersion,
  type ComicShot,
  type ComicSkillOption,
  type ComicSkillSnapshot,
  type PromptCategory,
} from "./types";
import { ArchivedBanner, errorText, Field, LoadError } from "./shared";

const CATEGORY_OPTIONS: SelectOption<PromptCategory | "all">[] = [
  { value: "all", label: "全部分类" },
  ...(Object.keys(PROMPT_CATEGORY_LABELS) as PromptCategory[]).map((value) => ({
    value,
    label: PROMPT_CATEGORY_LABELS[value],
  })),
];

const VARIABLE_OPTIONS = COMIC_PROMPT_VARIABLES;

const VARIABLE_HINTS: Record<string, string> = {
  "project.name": "漫剧项目名称",
  "episode.title": "当前剧集标题",
  "episode.synopsis": "当前剧集剧情简介",
  "episode.script": "当前剧集剧本正文（原文，含换行）",
  "characters.block": "本集出场角色（全局档案 + 本集形象覆盖，由后端组装）",
  "scene.block": "镜头场景设定；剧集级预览时为项目全部场景",
  "shot.description": "当前镜头描述（未选镜头时为空）",
  "shot.dialogue": "当前镜头台词",
  "shot.shot_size": "景别（如远景 / 中景 / 特写）",
  "shot.camera_move": "运镜说明",
};

function parseVariables(json: string): string[] {
  try {
    const value = JSON.parse(json);
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}

function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

export function PromptsPanel({ projectId, archived, onNotice }: CreativeModuleProps) {
  // ── 提示词模板 ─────────────────────────────────────────────────────
  const [templates, setTemplates] = useState<ComicPromptTemplate[]>([]);
  const [categoryFilter, setCategoryFilter] = useState<PromptCategory | "all">("all");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [creatingTemplate, setCreatingTemplate] = useState(false);
  const [metaDraft, setMetaDraft] = useState({
    name: "",
    category: "other" as PromptCategory,
    description: "",
  });
  const [versions, setVersions] = useState<ComicPromptVersion[]>([]);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [contentDraft, setContentDraft] = useState("");
  const [changeNote, setChangeNote] = useState("");
  const [requiredVariables, setRequiredVariables] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // ── 预览 ───────────────────────────────────────────────────────────
  const [episodes, setEpisodes] = useState<ComicEpisode[]>([]);
  const [previewEpisodeId, setPreviewEpisodeId] = useState("");
  const [previewShots, setPreviewShots] = useState<ComicShot[]>([]);
  const [previewShotId, setPreviewShotId] = useState("");
  const [preview, setPreview] = useState<ComicPromptPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  /** 选择变化后旧预览被清除，明确提示「已过期」而不是让用户误读旧内容。 */
  const [previewStale, setPreviewStale] = useState(false);
  const [previewCopied, setPreviewCopied] = useState(false);
  const copyTimerRef = useRef<number | null>(null);
  const previewKeyRef = useRef("");
  /**
   * 「模板已创建、v1 失败」恢复时用：下一次加载空版本列表要保留用户已输入的正文，
   * 而不是把编辑区清空（否则用户还得重新敲一遍才能重试 v1）。
   */
  const draftPreserveRef = useRef<{
    content: string;
    variables: string[];
    note: string;
  } | null>(null);
  /** 首次创建模板成功但 v1 失败时的持久提示（不随版本列表刷新被清掉）。 */
  const [recoveryNotice, setRecoveryNotice] = useState<string | null>(null);

  // ── Skill / 快照 ───────────────────────────────────────────────────
  const [skills, setSkills] = useState<ComicSkillOption[]>([]);
  const [skillQuery, setSkillQuery] = useState("");
  const [skillError, setSkillError] = useState<string | null>(null);
  const [snapshots, setSnapshots] = useState<ComicSkillSnapshot[]>([]);
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [selectedSnapshotId, setSelectedSnapshotId] = useState<string | null>(null);
  const [snapshotDetail, setSnapshotDetail] = useState<ComicSkillSnapshot | null>(null);
  const [capturing, setCapturing] = useState(false);

  const [rightMode, setRightMode] = useState<"template" | "skill">("template");

  const seqRef = useRef(0);
  const versionSeqRef = useRef(0);

  const loadTemplates = useCallback(async () => {
    const token = ++seqRef.current;
    setLoading(true);
    try {
      const [templateResult, episodeResult, snapshotResult] = await Promise.all([
        comicPromptTemplateList(projectId),
        comicEpisodeList(projectId),
        comicSkillSnapshotList(projectId),
      ]);
      if (token !== seqRef.current) return;
      const list = templateResult.templates ?? [];
      setTemplates(list);
      const episodeList = episodeResult.episodes ?? [];
      setEpisodes(episodeList);
      setPreviewEpisodeId((current) => current || episodeList[0]?.id || "");
      setSnapshots(snapshotResult.snapshots ?? []);
      setLoadError(null);
    } catch (error) {
      if (token !== seqRef.current) return;
      setLoadError(errorText(error));
    } finally {
      if (token === seqRef.current) setLoading(false);
    }
  }, [projectId]);

  const loadSkills = useCallback(async () => {
    try {
      const list = await comicSkillList();
      setSkills(list);
      setSkillError(null);
    } catch (error) {
      setSkillError(errorText(error));
    }
  }, []);

  useEffect(() => {
    void loadTemplates();
    void loadSkills();
  }, [loadTemplates, loadSkills]);

  useEffect(() => {
    if (!previewEpisodeId) {
      setPreviewShots([]);
      setPreviewShotId("");
      return;
    }
    let cancelled = false;
    comicShotList(projectId, previewEpisodeId)
      .then((result) => {
        if (cancelled) return;
        setPreviewShots(result.shots ?? []);
        setPreviewShotId("");
      })
      .catch((error) => {
        if (cancelled) return;
        setPreviewShots([]);
        setPreviewError(errorText(error));
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, previewEpisodeId]);

  /**
   * 预览失效：模板/版本/剧集/镜头任一变化，下方的旧渲染结果必须清除，
   * 绝不允许「上面选了 v3、下面还显示 v2 的旧预览」。
   */
  useEffect(() => {
    const key = [
      selectedTemplateId ?? "",
      selectedVersionId ?? "",
      previewEpisodeId,
      previewShotId,
    ].join("|");
    if (previewKeyRef.current && previewKeyRef.current !== key) {
      setPreview(null);
      setPreviewStale(true);
      setPreviewCopied(false);
    }
    previewKeyRef.current = key;
  }, [selectedTemplateId, selectedVersionId, previewEpisodeId, previewShotId]);

  useEffect(
    () => () => {
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    },
    [],
  );

  /** 选中模板后加载版本；默认选中默认版本，否则最新版本。 */
  const loadVersions = useCallback(
    async (templateId: string, preferVersionId?: string) => {
      const token = ++versionSeqRef.current;
      try {
        const result = await comicPromptVersionList(templateId);
        if (token !== versionSeqRef.current) return;
        const list = result.versions ?? [];
        setVersions(list);
        const preferred =
          list.find((version) => version.id === preferVersionId) ??
          list.find((version) => version.isDefault) ??
          list[0] ??
          null;
        if (preferred) {
          setSelectedVersionId(preferred.id);
          setContentDraft(preferred.content);
          setRequiredVariables(parseVariables(preferred.variablesJson));
          setChangeNote("");
        } else {
          // 空模板：若刚从「创建 v1 失败」恢复，保留用户已输入的正文供直接重试。
          const preserved = draftPreserveRef.current;
          draftPreserveRef.current = null;
          setSelectedVersionId(null);
          setContentDraft(preserved?.content ?? "");
          setRequiredVariables(preserved?.variables ?? []);
          setChangeNote(preserved?.note ?? "");
          if (preserved) {
            // 正文已恢复，提示由 recoveryNotice 常驻展示，无需再写入 saveError。
            return;
          }
        }
        setSaveError(null);
      } catch (error) {
        if (token !== versionSeqRef.current) return;
        setVersions([]);
        setSaveError(errorText(error));
      }
    },
    [],
  );

  useEffect(() => {
    if (!selectedTemplateId) return;
    void loadVersions(selectedTemplateId);
  }, [selectedTemplateId, loadVersions]);

  const selectedTemplate =
    templates.find((template) => template.id === selectedTemplateId) ?? null;
  const defaultVersion = versions.find((version) => version.isDefault) ?? null;
  const selectedVersion =
    versions.find((version) => version.id === selectedVersionId) ?? null;
  const filteredTemplates = useMemo(
    () =>
      categoryFilter === "all"
        ? templates
        : templates.filter((template) => template.category === categoryFilter),
    [templates, categoryFilter],
  );
  const filteredSkills = useMemo(() => {
    const query = skillQuery.trim().toLowerCase();
    if (!query) return skills;
    return skills.filter(
      (skill) =>
        skill.name.toLowerCase().includes(query) ||
        skill.description.toLowerCase().includes(query),
    );
  }, [skills, skillQuery]);
  const selectedSkill = skills.find((skill) => skill.id === selectedSkillId) ?? null;
  const skillSnapshots = useMemo(
    () =>
      selectedSkillId
        ? snapshots.filter((snapshot) => snapshot.sourceSkillId === selectedSkillId)
        : snapshots,
    [snapshots, selectedSkillId],
  );
  const selectedSnapshot =
    snapshotDetail ??
    snapshots.find((snapshot) => snapshot.id === selectedSnapshotId) ??
    null;

  function startNewTemplate() {
    setRightMode("template");
    setCreatingTemplate(true);
    setSelectedTemplateId(null);
    setSelectedVersionId(null);
    setVersions([]);
    setContentDraft("");
    setRequiredVariables([]);
    setChangeNote("");
    setMetaDraft({ name: "", category: "other", description: "" });
    setSaveError(null);
    setPreview(null);
    setPreviewError(null);
    setRecoveryNotice(null);
  }

  function selectTemplate(template: ComicPromptTemplate) {
    setRightMode("template");
    setCreatingTemplate(false);
    setRecoveryNotice(null);
    setSelectedTemplateId(template.id);
    setMetaDraft({
      name: template.name,
      category: template.category,
      description: template.description,
    });
    setPreview(null);
    setPreviewError(null);
  }

  function toggleRequiredVariable(name: string) {
    setRequiredVariables((prev) =>
      prev.includes(name) ? prev.filter((item) => item !== name) : [...prev, name],
    );
  }

  async function saveTemplate(createFirstVersion: boolean) {
    if (archived || saving) return;
    if (!metaDraft.name.trim()) {
      setSaveError("模板名称不能为空");
      return;
    }
    if (createFirstVersion && !contentDraft.trim()) {
      setSaveError("提示词正文不能为空（或直接创建空模板，稍后再建版本）");
      return;
    }
    setSaving(true);
    setSaveError(null);
    // 「创建模板 + v1」是两次调用：第二步失败时模板已经存在，必须退出创建态并
    // 载入该模板，否则用户会停留在永远失败的「新建」界面（只能刷新页面才能恢复）。
    let savedTemplate: ComicPromptTemplate | null = null;
    try {
      const saved = await comicPromptTemplateSave({
        id: creatingTemplate ? null : selectedTemplateId,
        projectId,
        name: metaDraft.name,
        category: metaDraft.category,
        description: metaDraft.description,
      });
      savedTemplate = saved.template;
      if (createFirstVersion) {
        await comicPromptVersionCreate({
          templateId: saved.template.id,
          content: contentDraft,
          variablesJson: JSON.stringify(requiredVariables),
          changeNote: changeNote || "v1 初始版本",
        });
        onNotice("ok", `已创建模板「${saved.template.name}」并保存 v1`);
      } else {
        onNotice("ok", creatingTemplate ? `已创建模板「${saved.template.name}」` : "模板信息已保存");
      }
      setCreatingTemplate(false);
      await loadTemplates();
      setSelectedTemplateId(saved.template.id);
      setMetaDraft({
        name: saved.template.name,
        category: saved.template.category,
        description: saved.template.description,
      });
      await loadVersions(saved.template.id);
      setPreview(null);
    } catch (error) {
      if (savedTemplate) {
        const recoveryError =
          `模板「${savedTemplate.name}」已创建，但首个版本保存失败：${errorText(error)}。` +
          "可直接在右侧重试「创建新版本（v1）」，无需刷新页面。";
        // 版本列表随后由 selectedTemplateId 的 effect 加载；用 ref 把用户已输入的正文
        // 带过那一次「空版本列表」刷新，避免编辑区被清空（提示也一并保留）。
        draftPreserveRef.current = {
          content: contentDraft,
          variables: requiredVariables,
          note: changeNote,
        };
        setCreatingTemplate(false);
        setRecoveryNotice(recoveryError);
        setMetaDraft({
          name: savedTemplate.name,
          category: savedTemplate.category,
          description: savedTemplate.description,
        });
        await loadTemplates();
        setSelectedTemplateId(savedTemplate.id);
        onNotice("error", `模板已创建，但 v1 保存失败：${errorText(error)}`);
      } else {
        setSaveError(errorText(error));
        onNotice("error", `保存模板失败：${errorText(error)}`);
      }
    } finally {
      setSaving(false);
    }
  }

  async function createVersion() {
    if (archived || saving) return;
    if (!selectedTemplate) {
      setSaveError("请先选择或创建模板");
      return;
    }
    if (!contentDraft.trim()) {
      setSaveError("提示词正文不能为空");
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const result = await comicPromptVersionCreate({
        templateId: selectedTemplate.id,
        content: contentDraft,
        variablesJson: JSON.stringify(requiredVariables),
        changeNote,
      });
      onNotice(
        "ok",
        `已创建 v${result.version.versionNo}（Hash ${shortHash(result.version.contentHash)}）；旧版本未修改`,
      );
      await loadTemplates();
      await loadVersions(selectedTemplate.id, result.version.id);
      setPreview(null);
      // 重试 v1 成功后，之前「模板已创建但 v1 失败」的提示不再需要。
      setRecoveryNotice(null);
    } catch (error) {
      setSaveError(errorText(error));
      onNotice("error", `创建版本失败：${errorText(error)}`);
    } finally {
      setSaving(false);
    }
  }

  async function setDefaultVersion(version: ComicPromptVersion) {
    if (archived || saving || !selectedTemplate) return;
    setSaving(true);
    setSaveError(null);
    try {
      await comicPromptVersionSetDefault(selectedTemplate.id, version.id);
      onNotice("ok", `已将 v${version.versionNo} 设为默认版本`);
      await loadTemplates();
      await loadVersions(selectedTemplate.id, version.id);
    } catch (error) {
      setSaveError(errorText(error));
      onNotice("error", `切换默认版本失败：${errorText(error)}`);
    } finally {
      setSaving(false);
    }
  }

  function selectVersion(version: ComicPromptVersion) {
    setSelectedVersionId(version.id);
    setContentDraft(version.content);
    setRequiredVariables(parseVariables(version.variablesJson));
    setChangeNote("");
    setSaveError(null);
  }

  async function runPreview() {
    if (!selectedTemplate || !selectedVersionId || !previewEpisodeId) {
      setPreviewError("请选择模板版本与剧集后再预览");
      return;
    }
    setPreviewing(true);
    setPreviewError(null);
    try {
      const result = await comicPromptRender({
        projectId,
        promptVersionId: selectedVersionId,
        episodeId: previewEpisodeId,
        shotId: previewShotId || null,
      });
      setPreview(result.preview);
      setPreviewStale(false);
      setPreviewCopied(false);
      onNotice("ok", "已按真实上下文渲染提示词预览（只读，未写入任何数据）");
    } catch (error) {
      setPreview(null);
      setPreviewError(errorText(error));
    } finally {
      setPreviewing(false);
    }
  }

  /** 复制渲染结果：统一走 Task Dock 受控剪贴板，成功/失败都如实反馈。 */
  async function copyPreview() {
    const text = preview?.rendered ?? "";
    if (!text.trim()) {
      setPreviewError("预览为空，无法复制");
      return;
    }
    setPreviewError(null);
    const ok = await copyText(text);
    if (!ok) {
      onNotice("error", "复制失败：剪贴板被占用或系统拒绝写入");
      return;
    }
    setPreviewCopied(true);
    onNotice("ok", "已复制提示词到剪贴板");
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    copyTimerRef.current = window.setTimeout(() => {
      setPreviewCopied(false);
      copyTimerRef.current = null;
    }, 2000);
  }

  async function captureSkill(skill: ComicSkillOption) {
    if (archived || capturing) return;
    setCapturing(true);
    setSkillError(null);
    try {
      const result = await comicSkillSnapshotCapture(projectId, skill.id);
      onNotice(
        "ok",
        `已捕获「${result.snapshot.skillName}」内容快照（Hash ${shortHash(result.snapshot.contentHash)}）`,
      );
      const list = await comicSkillSnapshotList(projectId);
      setSnapshots(list.snapshots ?? []);
      setSelectedSnapshotId(result.snapshot.id);
      setSnapshotDetail(result.snapshot);
      setRightMode("skill");
    } catch (error) {
      setSkillError(errorText(error));
      onNotice("error", `捕获 Skill 快照失败：${errorText(error)}`);
    } finally {
      setCapturing(false);
    }
  }

  async function viewSnapshot(snapshot: ComicSkillSnapshot) {
    setSelectedSnapshotId(snapshot.id);
    setSnapshotDetail(null);
    setRightMode("skill");
    try {
      const result = await comicSkillSnapshotGet(snapshot.id);
      setSnapshotDetail(result.snapshot);
    } catch (error) {
      setSkillError(errorText(error));
    }
  }

  const previewEpisodeOptions: SelectOption<string>[] = episodes.map((episode) => ({
    value: episode.id,
    label: `第 ${episode.episodeNo} 集 · ${episode.title}${episode.characterIds.length === 0 ? "（无出场角色）" : ""}`,
  }));
  const previewShotOptions: SelectOption<string>[] = [
    { value: "", label: "整集（不指定镜头）" },
    ...previewShots.map((shot) => ({
      value: shot.id,
      label: `镜头 ${shot.shotNo} · ${shot.description || "（无描述）"}`,
    })),
  ];

  return (
    <div className="comic-layout">
      <aside className="comic-pane comic-pane-list" aria-label="提示词与 Skill 导航">
        <div className="comic-toolbar">
          <button
            type="button"
            className="ws-btn ws-btn-primary"
            disabled={archived}
            onClick={startNewTemplate}
          >
            新建模板
          </button>
        </div>

        {loadError && <LoadError message={loadError} onRetry={() => void loadTemplates()} />}
        {loading && !loadError && <p className="ws-empty">加载中…</p>}

        <section className="comic-prompts-section" aria-label="提示词模板">
          <div className="comic-stats-head">
            <span className="comic-field-label">提示词模板</span>
            <span className="ws-meta">{templates.length} 个</span>
          </div>
          <Select
            value={categoryFilter}
            options={CATEGORY_OPTIONS}
            onChange={(value) => setCategoryFilter(value as PromptCategory | "all")}
            ariaLabel="提示词分类筛选"
            disabled={loading}
          />
          <ul className="ws-list">
            {filteredTemplates.map((template) => (
              <li key={template.id}>
                <button
                  type="button"
                  className={`comic-list-row${template.id === selectedTemplateId && !creatingTemplate ? " is-active" : ""}`}
                  onClick={() => selectTemplate(template)}
                >
                  <span className="comic-row-main">
                    <span className="comic-row-title">{template.name}</span>
                    <span className="ws-meta">
                      {PROMPT_CATEGORY_LABELS[template.category]} ·{" "}
                      {template.defaultVersionNo
                        ? `默认 v${template.defaultVersionNo}`
                        : "尚无版本"}{" "}
                      · {template.versionCount} 个版本
                    </span>
                  </span>
                </button>
              </li>
            ))}
            {!loading && filteredTemplates.length === 0 && (
              <li className="ws-empty">
                {templates.length === 0
                  ? "还没有提示词模板，点击「新建模板」开始。"
                  : "当前分类下没有模板，切换分类筛选。"}
              </li>
            )}
          </ul>
        </section>

        {selectedTemplate && (
          <section className="comic-prompts-section" aria-label="版本历史">
            <div className="comic-stats-head">
              <span className="comic-field-label">版本历史</span>
              <span className="ws-meta">旧版本只读</span>
            </div>
            <ul className="ws-list">
              {versions.map((version) => (
                <li key={version.id}>
                  <div
                    className={`comic-list-row${version.id === selectedVersionId ? " is-active" : ""}`}
                  >
                    <button
                      type="button"
                      className="comic-row-main"
                      onClick={() => selectVersion(version)}
                    >
                      <span className="comic-row-title">
                        v{version.versionNo}
                        {version.isDefault ? " · 默认" : ""}
                      </span>
                      <span className="ws-meta">
                        Hash {shortHash(version.contentHash)} ·{" "}
                        {version.changeNote || "无修改说明"}
                      </span>
                    </button>
                    {!version.isDefault && (
                      <span className="comic-row-actions">
                        <button
                          type="button"
                          className="ws-btn ws-btn-quiet"
                          disabled={archived || saving}
                          onClick={() => void setDefaultVersion(version)}
                        >
                          设为默认
                        </button>
                      </span>
                    )}
                  </div>
                </li>
              ))}
              {versions.length === 0 && (
                <li className="ws-empty">该模板还没有版本，在右侧创建 v1。</li>
              )}
            </ul>
          </section>
        )}

        <section className="comic-prompts-section" aria-label="Skill 列表">
          <div className="comic-stats-head">
            <span className="comic-field-label">能力中心 Skill</span>
            <span className="ws-meta">只读引用</span>
          </div>
          <input
            type="search"
            className="ws-input"
            placeholder="搜索 Skill 名称或说明"
            value={skillQuery}
            onChange={(event) => setSkillQuery(event.target.value)}
            aria-label="搜索 Skill"
          />
          {skillError && (
            <p className="ws-notice" data-tone="info" role="status">
              <span>Skill 列表加载失败：{skillError}</span>
              <button type="button" className="ws-btn" onClick={() => void loadSkills()}>
                重试
              </button>
            </p>
          )}
          <ul className="ws-list">
            {filteredSkills.map((skill) => (
              <li key={skill.id}>
                <button
                  type="button"
                  className={`comic-list-row${skill.id === selectedSkillId ? " is-active" : ""}`}
                  onClick={() => {
                    setRightMode("skill");
                    setSelectedSkillId(skill.id);
                    setSelectedSnapshotId(null);
                    setSnapshotDetail(null);
                  }}
                >
                  <span className="comic-row-main">
                    <span className="comic-row-title">{skill.name}</span>
                    <span className="ws-meta">
                      声明版本 {skill.declaredVersion || "未声明"} ·{" "}
                      {skill.enabled ? "已启用" : "已禁用"}
                      {skill.missing ? " · 文件丢失" : ""} · {skill.scope}
                    </span>
                  </span>
                </button>
              </li>
            ))}
            {filteredSkills.length === 0 && (
              <li className="ws-empty">
                {skills.length === 0
                  ? "能力中心还没有 Skill；本模块不创建第二套 Skill 目录。"
                  : "没有匹配的 Skill。"}
              </li>
            )}
          </ul>
        </section>

        <section className="comic-prompts-section" aria-label="Skill 历史快照">
          <div className="comic-stats-head">
            <span className="comic-field-label">Skill 历史快照</span>
            <span className="ws-meta">{skillSnapshots.length} 个</span>
          </div>
          <ul className="ws-list">
            {skillSnapshots.map((snapshot) => (
              <li key={snapshot.id}>
                <button
                  type="button"
                  className={`comic-list-row${snapshot.id === selectedSnapshotId ? " is-active" : ""}`}
                  onClick={() => void viewSnapshot(snapshot)}
                >
                  <span className="comic-row-main">
                    <span className="comic-row-title">{snapshot.skillName}</span>
                    <span className="ws-meta">
                      声明 {snapshot.declaredVersion || "未声明"} · 内容{" "}
                      {shortHash(snapshot.contentHash)} · {snapshot.fileCount} 个文件
                    </span>
                  </span>
                </button>
              </li>
            ))}
            {skillSnapshots.length === 0 && (
              <li className="ws-empty">
                还没有快照。选择 Skill 后点「捕获当前版本」，快照不可修改。
              </li>
            )}
          </ul>
        </section>
      </aside>

      <div className="comic-pane comic-pane-detail">
        {archived && <ArchivedBanner />}

        {rightMode === "template" && !selectedTemplate && !creatingTemplate && (
          <p className="ws-empty">
            从左侧选择提示词模板，或新建模板。版本只追加、不修改；预览只读。
          </p>
        )}

        {rightMode === "template" && (selectedTemplate || creatingTemplate) && (
          <div className="comic-form">
            <div className="ws-grid">
              <Field label="模板名称" htmlFor="prompt-name">
                <input
                  id="prompt-name"
                  type="text"
                  className="ws-input"
                  disabled={archived || saving}
                  value={metaDraft.name}
                  onChange={(event) => setMetaDraft({ ...metaDraft, name: event.target.value })}
                />
              </Field>
              <Field label="分类">
                <Select
                  value={metaDraft.category}
                  options={(Object.keys(PROMPT_CATEGORY_LABELS) as PromptCategory[]).map(
                    (value) => ({ value, label: PROMPT_CATEGORY_LABELS[value] }),
                  )}
                  onChange={(value) => setMetaDraft({ ...metaDraft, category: value })}
                  ariaLabel="提示词分类"
                  disabled={archived || saving}
                />
              </Field>
            </div>

            <Field label="模板说明" htmlFor="prompt-desc">
              <textarea
                id="prompt-desc"
                className="ws-textarea"
                rows={2}
                disabled={archived || saving}
                value={metaDraft.description}
                onChange={(event) =>
                  setMetaDraft({ ...metaDraft, description: event.target.value })
                }
              />
            </Field>

            {recoveryNotice && (
              <p className="ws-notice" data-tone="error" role="alert">
                <span>{recoveryNotice}</span>
              </p>
            )}

            <div className="ws-form-actions">
              {creatingTemplate ? (
                <>
                  <button
                    type="button"
                    className="ws-btn ws-btn-primary"
                    disabled={archived || saving}
                    onClick={() => void saveTemplate(true)}
                  >
                    {saving ? "保存中…" : "创建模板并保存 v1"}
                  </button>
                  <button
                    type="button"
                    className="ws-btn"
                    disabled={archived || saving}
                    onClick={() => void saveTemplate(false)}
                  >
                    只创建空模板
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="ws-btn"
                  disabled={archived || saving}
                  onClick={() => void saveTemplate(false)}
                >
                  {saving ? "保存中…" : "保存模板信息"}
                </button>
              )}
            </div>

            {(selectedTemplate || creatingTemplate) && (
              <>
                <div className="comic-prompt-version-head">
                  <span className="comic-field-label">
                    提示词正文
                    <em className="comic-field-hint">
                      {creatingTemplate
                        ? "新模板暂无版本：填写正文后随模板一起创建 v1"
                        : `正在基于 v${selectedVersion?.versionNo ?? "—"} 编辑；保存会创建新版本`}
                    </em>
                  </span>
                  <span className="ws-meta">
                    当前默认：{defaultVersion ? `v${defaultVersion.versionNo}` : "无"} ·
                    已选 v{selectedVersion?.versionNo ?? "—"} · Hash{" "}
                    {shortHash(selectedVersion?.contentHash)}
                  </span>
                </div>

                <textarea
                  className="ws-textarea comic-prompt-body"
                  rows={14}
                  aria-label="提示词正文"
                  disabled={archived || saving}
                  value={contentDraft}
                  onChange={(event) => setContentDraft(event.target.value)}
                />

                <details className="comic-prompt-vars">
                  <summary>变量说明（只做纯文本占位符替换，不执行任何代码）</summary>
                  <ul className="ws-list">
                    {VARIABLE_OPTIONS.map((name) => (
                      <li key={name} className="ws-meta">
                        <code>{`{{${name}}}`}</code> — {VARIABLE_HINTS[name]}
                      </li>
                    ))}
                  </ul>
                </details>

                <fieldset className="comic-check-group">
                  <legend className="comic-field-label">
                    必填变量
                    <em className="comic-field-hint">
                      勾选后：模板用到该变量且本集/镜头没有内容时，渲染会明确报错
                    </em>
                  </legend>
                  <div className="comic-check-grid">
                    {VARIABLE_OPTIONS.map((name) => (
                      <label key={name} className="comic-check">
                        <input
                          type="checkbox"
                          checked={requiredVariables.includes(name)}
                          disabled={archived || saving}
                          onChange={() => toggleRequiredVariable(name)}
                        />
                        <span>{name}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>

                <Field label="修改说明" htmlFor="prompt-change-note">
                  <input
                    id="prompt-change-note"
                    type="text"
                    className="ws-input"
                    placeholder="写清楚这次改了什么，便于回溯"
                    disabled={archived || saving}
                    value={changeNote}
                    onChange={(event) => setChangeNote(event.target.value)}
                  />
                </Field>

                {saveError && (
                  <p className="ws-notice" data-tone="error" role="alert">
                    <span>{saveError}</span>
                  </p>
                )}

                {selectedTemplate && (
                  <div className="ws-form-actions">
                    <button
                      type="button"
                      className="ws-btn ws-btn-primary"
                      disabled={archived || saving || !contentDraft.trim()}
                      onClick={() => void createVersion()}
                    >
                      {saving ? "保存中…" : `创建新版本（v${(versions[0]?.versionNo ?? 0) + 1}）`}
                    </button>
                    <button
                      type="button"
                      className="ws-btn"
                      disabled={archived || saving || !selectedVersion}
                      onClick={() => selectedVersion && selectVersion(selectedVersion)}
                    >
                      放弃修改，回到已选版本
                    </button>
                  </div>
                )}

                {selectedTemplate && (
                <section className="comic-prompt-preview" aria-label="提示词预览">
                  <div className="comic-stats-head">
                    <span className="comic-field-label">按真实数据预览</span>
                    <span className="ws-meta">只读：不写库、不调用模型</span>
                  </div>
                  <div className="ws-grid">
                    <Field label="剧集">
                      <Select
                        value={previewEpisodeId}
                        options={previewEpisodeOptions}
                        onChange={setPreviewEpisodeId}
                        placeholder="选择剧集"
                        ariaLabel="预览剧集"
                        disabled={previewing || episodes.length === 0}
                      />
                    </Field>
                    <Field label="镜头" hint="可选；不选则按整集上下文">
                      <Select
                        value={previewShotId}
                        options={previewShotOptions}
                        onChange={setPreviewShotId}
                        ariaLabel="预览镜头"
                        disabled={previewing || previewShots.length === 0}
                      />
                    </Field>
                  </div>
                  <p className="ws-meta">
                    预览使用已保存的 v{selectedVersion?.versionNo ?? "—"}，不包含上方未保存的修改。
                  </p>
                  <div className="ws-form-actions">
                    <button
                      type="button"
                      className="ws-btn"
                      disabled={previewing || !previewEpisodeId || !selectedVersionId}
                      onClick={() => void runPreview()}
                    >
                      {previewing ? "渲染中…" : "渲染预览"}
                    </button>
                  </div>

                  {previewError && (
                    <p className="ws-notice" data-tone="error" role="alert">
                      <span>{previewError}</span>
                    </p>
                  )}

                  {previewStale && !preview && (
                    <p className="ws-notice" data-tone="info" role="status">
                      <span>选择已变化，之前的预览已过期并被清除，请重新渲染。</span>
                    </p>
                  )}

                  {preview && (
                    <div className="comic-prompt-preview-result">
                      <div className="comic-stats-head">
                        <span className="ws-meta">
                          模板「{preview.templateName}」v{preview.versionNo} · Hash{" "}
                          {shortHash(preview.contentHash)} · 角色{" "}
                          {preview.context.characters.length} 个 · 场景{" "}
                          {preview.context.scenes.length} 个
                          {preview.context.shot
                            ? ` · 镜头 ${preview.context.shot.shotNo}`
                            : " · 整集"}
                        </span>
                        <button
                          type="button"
                          className="ws-btn ws-btn-quiet"
                          disabled={!preview.rendered.trim()}
                          onClick={() => void copyPreview()}
                        >
                          {previewCopied ? (
                            <>
                              <Check size={13} aria-hidden="true" /> 已复制
                            </>
                          ) : (
                            <>
                              <Copy size={13} aria-hidden="true" /> 复制提示词
                            </>
                          )}
                        </button>
                      </div>
                      {preview.context.characters.length > 0 && (
                        <p className="ws-meta">
                          实际使用角色：
                          {preview.context.characters
                            .map((character) =>
                              character.usingOverride
                                ? `${character.name}（本集形象${character.appearanceLabel ? `：${character.appearanceLabel}` : ""}）`
                                : `${character.name}（全局形象）`,
                            )
                            .join("、")}
                        </p>
                      )}
                      <pre className="comic-prompt-pre">{preview.rendered}</pre>
                    </div>
                  )}
                </section>
                )}
              </>
            )}

            {creatingTemplate && (
              <p className="ws-meta">
                新模板还没有版本：填写正文后点「创建模板并保存 v1」；也可先创建空模板。
              </p>
            )}
          </div>
        )}

        {rightMode === "skill" && (
          <div className="comic-form">
            {!selectedSkill && !selectedSnapshot && (
              <p className="ws-empty">
                从左侧选择 Skill 查看声明版本与内容，或选择历史快照查看不可变内容。
              </p>
            )}

            {selectedSkill && (
              <section className="comic-prompt-skill" aria-label="Skill 详情">
                <div className="comic-stats-head">
                  <span className="comic-field-label">能力中心 Skill</span>
                  <span className="ws-meta">复用 capability_skills，不复制存储</span>
                </div>
                <h3 className="comic-prompt-skill-name">{selectedSkill.name}</h3>
                <p className="ws-meta">{selectedSkill.description || "（无说明）"}</p>
                <dl className="comic-character-facts">
                  <div>
                    <dt>声明版本（SKILL.md）</dt>
                    <dd>{selectedSkill.declaredVersion || "未声明"}</dd>
                  </div>
                  <div>
                    <dt>启用 / 丢失</dt>
                    <dd>
                      {selectedSkill.enabled ? "已启用" : "已禁用"} ·{" "}
                      {selectedSkill.missing ? "文件丢失" : "文件存在"}
                    </dd>
                  </div>
                  <div>
                    <dt>作用域</dt>
                    <dd>{selectedSkill.scope}</dd>
                  </div>
                  <div>
                    <dt>风险等级</dt>
                    <dd>{selectedSkill.riskLevel}</dd>
                  </div>
                </dl>
                <p className="ws-meta">
                  声明版本来自 SKILL.md frontmatter；Task Dock 的实际内容版本以快照 Hash 为准。
                  扫描会覆盖能力中心当前记录，因此不能把当前 Skill ID 当历史版本。
                </p>
                <div className="ws-form-actions">
                  <button
                    type="button"
                    className="ws-btn ws-btn-primary"
                    disabled={archived || capturing || !selectedSkill.enabled || selectedSkill.missing}
                    onClick={() => void captureSkill(selectedSkill)}
                  >
                    {capturing ? "捕获中…" : "捕获当前版本为快照"}
                  </button>
                </div>
                {(!selectedSkill.enabled || selectedSkill.missing) && (
                  <p className="ws-meta">
                    {!selectedSkill.enabled
                      ? "Skill 已禁用：不能捕获为可用版本，请先到能力中心启用。"
                      : "Skill 文件已丢失：不能捕获，请先重新扫描或重新导入。"}
                  </p>
                )}
              </section>
            )}

            {selectedSnapshot && (
              <section className="comic-prompt-snapshot" aria-label="Skill 快照内容">
                <div className="comic-stats-head">
                  <span className="comic-field-label">不可变内容快照</span>
                  <span className="ws-meta">只读</span>
                </div>
                <p className="ws-meta">
                  {selectedSnapshot.skillName} · 声明版本{" "}
                  {selectedSnapshot.declaredVersion || "未声明"} · 实际内容{" "}
                  {shortHash(selectedSnapshot.contentHash)} · {selectedSnapshot.fileCount} 个文件 ·{" "}
                  {selectedSnapshot.createdAt}
                </p>
                <pre className="comic-prompt-pre">{selectedSnapshot.contentSnapshot}</pre>
                <details className="comic-prompt-vars">
                  <summary>文件清单（路径 + 大小 + SHA-256 指纹）</summary>
                  <pre className="comic-prompt-pre comic-prompt-manifest">
                    {prettyJson(selectedSnapshot.filesManifestJson)}
                  </pre>
                </details>
                <p className="ws-meta">
                  本轮只有 SKILL.md 正文会装配进提示词上下文；附属文件记录不可变指纹，
                  原始 Skill 更新或删除都不会改变这份快照。
                </p>
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
