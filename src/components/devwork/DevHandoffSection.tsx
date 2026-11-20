//! 任务交接包区块（dev workbench Round 1；Round 2a 增补「资料选择」）。
//!
//! - 12 节固定模板；空节不输出（Markdown 中略过该节，绝不输出空标题）。
//! - 初始预填：任务标题/备注 → 「任务目标」；当前项目名/分支/路径 → 「项目背景」；
//!   关联功能 acceptance_criteria → 「验收标准」。只填用户未编辑过的节，
//!   绝不覆盖已输入内容；编辑态全部在 React state，复制/保存失败不丢内容。
//! - 资料选择（Round 2a，仅有关联任务时显示）：勾选快速笔记 / 暂存架条目（各最近
//!   ≤20 条），选中条目**只以条目名**追加到「项目背景」节末尾（小标题 + bullet
//!   list），绝不带入正文内容；追加块在预览中实时生成，不写入 textarea 编辑态，
//!   用户已编辑的「项目背景」保持原样。sourceSummary 记录 selectedNotes /
//!   selectedShelfItems（id 列表）供回溯。
//! - 敏感扫描走 `dev_handoff_secret_scan`：命中只显示「节名 + 行号 + 类型」，
//!   绝不渲染命中原文。
//! - 保存为追加式版本（dev_handoff_save），contentMd 与预览严格一致；
//!   版本列表展示同 taskId 最近 5 版，支持查看/复制/删除（删除走 ConfirmDialog）。
//! - 「生成交接包」跨页入口（TaskContextDrawer）经 revealDevHandoff 滚动定位到本区块。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ClipboardList, Pencil, Plus, ScrollText, ShieldAlert, X } from "lucide-react";
import { Checkbox, Combobox, ConfirmDialog, Dialog } from "../ui";
import {
  agentHistorySessions,
  devHandoffDelete,
  devHandoffList,
  devHandoffSave,
  devHandoffSecretScan,
  fetchTask,
  notesList,
  shelfList,
  type AgentHistorySession,
  type DevHandoffPack,
  type DevProject,
  type NoteSummary,
  type SecretFinding,
  type ShelfItem,
  type Task,
} from "../../lib/bridge";
import { copyText } from "../../lib/clipboard";
import { errorMessage, normalizeError } from "../../lib/errors";
import { formatRelative } from "../../lib/format";
import { useLocale } from "../../hooks/useLocale";
import { useUiStore } from "../../store/useUiStore";
import { useSettingsStore } from "../../store/useSettingsStore";
import { fetchDevProjectListCached, probeDevGitCached } from "./DevProjectContext";
import { findFeaturesForTask, type DevLinkedFeature } from "./DevAcceptanceSection";

/** 交接包 12 节固定模板（节顺序即 Markdown 输出顺序）。 */
const HANDOFF_SECTIONS = [
  { key: "background", i18n: "devwork.handoff.sec.background" },
  { key: "goal", i18n: "devwork.handoff.sec.goal" },
  { key: "progress", i18n: "devwork.handoff.sec.progress" },
  { key: "scope", i18n: "devwork.handoff.sec.scope" },
  { key: "codePaths", i18n: "devwork.handoff.sec.codePaths" },
  { key: "constraints", i18n: "devwork.handoff.sec.constraints" },
  { key: "dependencies", i18n: "devwork.handoff.sec.dependencies" },
  { key: "criteria", i18n: "devwork.handoff.sec.criteria" },
  { key: "screenshots", i18n: "devwork.handoff.sec.screenshots" },
  { key: "testing", i18n: "devwork.handoff.sec.testing" },
  { key: "forbidden", i18n: "devwork.handoff.sec.forbidden" },
  { key: "reporting", i18n: "devwork.handoff.sec.reporting" },
] as const;

export type HandoffKey = (typeof HANDOFF_SECTIONS)[number]["key"];

/** 资料选择每组显示的条目上限（笔记 / 暂存架各取最近 20 条）。 */
const MATERIALS_LIMIT = 20;

/** Combobox 的「不关联」占位值：绝不会作为会话身份保存。 */
const SESSION_NONE = "\u0000none";

/** 敏感扫描按最终 Markdown 整篇执行：结果只显示这一个分区名。 */
const SCAN_DOCUMENT_LABEL = "完整文档";

/** 会话身份键：与后端 task_agent_links 一致（source_id + external_id）。 */
function sessionKey(s: { source_id: string; external_id: string }): string {
  return `${s.source_id}\u0000${s.external_id}`;
}

/** 一条已勾选资料：记录展示名与来源，列表重载后 bullet 仍可还原。 */
interface SelectedMaterial {
  name: string;
  kind: "note" | "shelf";
}

type HandoffSections = Record<HandoffKey, string>;

/** 任务切换时暂存的内存草稿：只保留未保存修改，避免静默丢弃。 */
interface HandoffDraft {
  title: string;
  sections: HandoffSections;
  materials: Map<string, SelectedMaterial>;
  linkedSession: AgentHistorySession | null;
  dirty: boolean;
}

function emptySections(): HandoffSections {
  return {
    background: "",
    goal: "",
    progress: "",
    scope: "",
    codePaths: "",
    constraints: "",
    dependencies: "",
    criteria: "",
    screenshots: "",
    testing: "",
    forbidden: "",
    reporting: "",
  };
}

/** 从已保存 Markdown 只读提取小节标题（摘要展示用；不参与 Markdown 生成规则）。 */
function packSectionTitles(md: string): string[] {
  return md
    .split("\n")
    .filter((line) => line.startsWith("## "))
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
}

/**
 * 生成 Markdown：空节略过（不输出空标题）；标题恒为第一行。
 * labels 由调用方按当前语言传入，保证输出与预览严格一致。
 */
export function buildHandoffMarkdown(
  title: string,
  labels: Record<HandoffKey, string>,
  sections: HandoffSections,
): string {
  const lines: string[] = [`# 任务交接包：${title}`];
  for (const s of HANDOFF_SECTIONS) {
    const body = (sections[s.key] ?? "").trim();
    if (!body) continue;
    lines.push("", `## ${labels[s.key]}`, body);
  }
  return lines.join("\n");
}

/** 跨页定位：切到工作台后滚动到交接区并短暂高亮（静态描边，无动画）。 */
export function revealDevHandoff(): void {
  // after 回调在 setTab 同步执行，面板可能尚未提交渲染：双 rAF 等 DOM 就绪
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const el = document.getElementById("dev-handoff");
      if (!el) return;
      el.scrollIntoView({ block: "start" });
      el.classList.add("dev-section-flash");
      window.setTimeout(() => el.classList.remove("dev-section-flash"), 1600);
    });
  });
}

export default function DevHandoffSection() {
  const { t } = useLocale();
  const showToast = useUiStore((s) => s.showToast);
  const taskId = useSettingsStore((s) => s.settings?.workbench_current_task ?? "") || null;
  const projectId = useSettingsStore((s) => s.settings?.workbench_current_project ?? "") || null;

  const [task, setTask] = useState<Task | null>(null);
  const [taskMissing, setTaskMissing] = useState(false);
  const [project, setProject] = useState<DevProject | null>(null);
  const [features, setFeatures] = useState<DevLinkedFeature[] | null>(null);

  // ── 资料选择（Round 2a）：两数据源各自加载、各自降级，互不阻塞 ──
  const [notes, setNotes] = useState<NoteSummary[] | null>(null);
  const [notesError, setNotesError] = useState<string | null>(null);
  const [shelfItems, setShelfItems] = useState<ShelfItem[] | null>(null);
  const [shelfError, setShelfError] = useState<string | null>(null);
  /** 已勾选资料（id → 名称/来源）。Map 保序：勾选顺序即 bullet 输出顺序。 */
  const [selectedMaterials, setSelectedMaterials] = useState<
    Map<string, SelectedMaterial>
  >(new Map());

  const [title, setTitle] = useState("");
  const [sections, setSections] = useState<HandoffSections>(emptySections);
  /** 用户编辑过的节：预填绝不覆盖。 */
  const editedRef = useRef<ReadonlySet<HandoffKey>>(new Set());
  /** 本草稿实际预填过的节：写入 sourceSummary 供回溯。 */
  const prefilledRef = useRef<ReadonlySet<HandoffKey>>(new Set());

  // ── Agent 会话关联（v50）：只登记身份，不推断、不自动执行 ──
  const [sessions, setSessions] = useState<AgentHistorySession[] | null>(null);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [sessionKeyword, setSessionKeyword] = useState("");
  /** 已选会话（保存到包上；不使用标题匹配身份）。 */
  const [linkedSession, setLinkedSession] = useState<AgentHistorySession | null>(null);
  const sessionsSeqRef = useRef(0);

  /** 会话查询：实时 + 历史统一入口；用序号丢弃过期响应，不设置轮询。 */
  const fetchSessions = useCallback((keyword: string) => {
    const seq = ++sessionsSeqRef.current;
    agentHistorySessions({
      keyword: keyword.trim() || undefined,
      includeLive: true,
      limit: 20,
    })
      .then(({ items }) => {
        if (seq !== sessionsSeqRef.current) return;
        setSessions(items);
        setSessionsError(null);
      })
      .catch((e) => {
        if (seq !== sessionsSeqRef.current) return;
        setSessions([]);
        setSessionsError(errorMessage(e));
      });
  }, []);

  useEffect(() => {
    fetchSessions("");
  }, [fetchSessions]);

  const [scan, setScan] = useState<{ findings: SecretFinding[]; truncated: boolean } | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [copying, setCopying] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [packs, setPacks] = useState<DevHandoffPack[] | null>(null);
  const [viewPackId, setViewPackId] = useState<string | null>(null);
  const [pendingDeletePackId, setPendingDeletePackId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  // ── 摘要 / 编辑两态（2026-11 治理）：默认只展示最近版本摘要，编辑面板原位展开；
  // 有未保存修改时关闭必须经确认，不静默丢弃草稿。
  const [editing, setEditing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [dirtyCloseOpen, setDirtyCloseOpen] = useState(false);

  /** 草稿修订号：每次用户编辑自增，保存回调据此判断「保存期间是否又有新修改」。 */
  const revisionRef = useRef(0);
  /** 当前草稿快照（由下方 effect 维护），任务切换时写入缓存。 */
  const draftRef = useRef<HandoffDraft>({
    title: "",
    sections: emptySections(),
    materials: new Map(),
    linkedSession: null,
    dirty: false,
  });
  /** 按 taskId 缓存未保存草稿：切换任务不清空，切回来可恢复。 */
  const draftCacheRef = useRef<Map<string, HandoffDraft>>(new Map());
  const currentTaskRef = useRef<string | null>(taskId);

  const markDirty = useCallback(() => {
    revisionRef.current += 1;
    setDirty(true);
  }, []);

  const labels = useMemo(() => {
    const out = {} as Record<HandoffKey, string>;
    for (const s of HANDOFF_SECTIONS) out[s.key] = t(s.i18n);
    return out;
  }, [t]);

  // 草稿快照：deps 不含 taskId，任务切换那次提交不会先被新任务状态覆盖。
  useEffect(() => {
    draftRef.current = {
      title,
      sections,
      materials: selectedMaterials,
      linkedSession,
      dirty,
    };
  }, [title, sections, selectedMaterials, linkedSession, dirty]);

  /**
   * 换任务：先把旧任务的未保存草稿写入内存缓存（不静默丢弃），
   * 再恢复新任务已有的草稿；其余编辑/扫描/资料状态照常清空。
   */
  useEffect(() => {
    const previousTaskId = currentTaskRef.current;
    if (previousTaskId !== taskId) {
      if (previousTaskId && draftRef.current.dirty) {
        draftCacheRef.current.set(previousTaskId, draftRef.current);
      }
      currentTaskRef.current = taskId;
    }
    setTask(null);
    setTaskMissing(false);
    setFeatures(null);
    editedRef.current = new Set();
    prefilledRef.current = new Set();
    setScan(null);
    setScanError(null);
    setCopyError(null);
    setSaveError(null);
    setViewPackId(null);
    setNotes(null);
    setNotesError(null);
    setShelfItems(null);
    setShelfError(null);
    setEditing(false);
    setDirtyCloseOpen(false);

    const cached = taskId ? draftCacheRef.current.get(taskId) : undefined;
    if (cached) {
      setTitle(cached.title);
      setSections(cached.sections);
      setSelectedMaterials(new Map(cached.materials));
      setLinkedSession(cached.linkedSession);
      setDirty(cached.dirty);
    } else {
      setTitle("");
      setSections(emptySections());
      setSelectedMaterials(new Map());
      // 换任务不清空会话候选（全局列表），但必须清空本任务已选关联
      setLinkedSession(null);
      setDirty(false);
    }
  }, [taskId]);

  // 当前任务数据：标题/备注预填来源；任务已删除时如实提示（保存退化为草稿）
  useEffect(() => {
    if (!taskId) return;
    let alive = true;
    fetchTask(taskId)
      .then((task) => {
        if (alive) setTask(task);
      })
      .catch((e) => {
        // 只把「任务本身不存在」标为失效；其它读取失败同样不预填，但不阻塞交接包
        const err = normalizeError(e);
        const missing =
          err.code === "NOT_FOUND" ||
          (err.legacy && /not[_ ]?found|不存在|no rows|未找到/i.test(err.message));
        if (alive && missing) setTaskMissing(true);
      });
    return () => {
      alive = false;
    };
  }, [taskId]);

  useEffect(() => {
    if (!taskId) return;
    let alive = true;
    // 关联功能查询失败只影响「验收标准」预填，不阻塞交接包本身（不伪造无关联）
    void findFeaturesForTask(taskId)
      .then((rows) => {
        if (alive) setFeatures(rows);
      })
      .catch(() => {
        if (alive) setFeatures([]);
      });
    return () => {
      alive = false;
    };
  }, [taskId]);

  /** 预填一个节：只在「用户未编辑 且 目前为空」时写入。 */
  const applyPrefill = useCallback((key: HandoffKey, value: string) => {
    const v = value.trim();
    if (!v) return;
    if (editedRef.current.has(key)) return;
    prefilledRef.current = new Set(prefilledRef.current).add(key);
    setSections((m) => (m[key].trim() ? m : { ...m, [key]: v }));
  }, []);

  // 任务数据到达：标题 + 任务目标预填
  useEffect(() => {
    if (!task) return;
    setTitle((cur) => (cur.trim() ? cur : task.title));
    applyPrefill(
      "goal",
      [task.title, task.description].filter((s) => s.trim()).join("\n"),
    );
  }, [task, applyPrefill]);

  // 当前项目 + Git 摘要到达：项目背景预填（名称 + 路径 + 分支/未提交摘要）
  useEffect(() => {
    if (!projectId) return;
    let alive = true;
    fetchDevProjectListCached()
      .then((rows) => {
        if (!alive) return;
        const p = rows.find((r) => r.id === projectId) ?? null;
        setProject(p);
        if (!p) return;
        return probeDevGitCached(p.rootPath)
          .then((info) => {
            if (!alive) return;
            const parts = [`项目：${p.name}`, `路径：${p.rootPath}`];
            if (info.status === "ok") {
              const gitParts: string[] = [];
              if (info.branch) gitParts.push(`分支：${info.branch}`);
              if (info.dirtyCount !== null) gitParts.push(`未提交 ${info.dirtyCount} 处`);
              if (info.isWorktree) gitParts.push("worktree");
              if (gitParts.length > 0) parts.push(gitParts.join(" · "));
            }
            applyPrefill("background", parts.join("\n"));
          })
          .catch(() => {
            if (alive) applyPrefill("background", `项目：${p.name}\n路径：${p.rootPath}`);
          });
      })
      .catch(() => {
        // 项目列表读取失败：不预填项目背景，如实留空
      });
    return () => {
      alive = false;
    };
  }, [projectId, applyPrefill]);

  // 关联功能到达：验收标准预填（取第一条非空 acceptance_criteria）
  useEffect(() => {
    if (!features) return;
    for (const f of features) {
      if (f.feature.acceptance_criteria.trim()) {
        applyPrefill("criteria", f.feature.acceptance_criteria);
        break;
      }
    }
  }, [features, applyPrefill]);

  const loadPacks = useCallback((id: string | null) => {
    return devHandoffList({ taskId: id, limit: 5 })
      .then(({ packs: rows }) => setPacks(rows))
      .catch(() => setPacks([]));
  }, []);

  useEffect(() => {
    void loadPacks(taskId);
  }, [taskId, loadPacks]);

  // ── 资料选择（Round 2a）：仅有关联任务时加载；两数据源各自失败各自降级 ──
  useEffect(() => {
    if (!taskId || taskMissing) return;
    let alive = true;
    notesList({ limit: MATERIALS_LIMIT, offset: 0 })
      .then((rows) => {
        if (alive) {
          setNotes(rows);
          setNotesError(null);
        }
      })
      .catch((e) => {
        if (alive) setNotesError(errorMessage(e));
      });
    shelfList({ limit: MATERIALS_LIMIT, sort: "recent" })
      .then((page) => {
        if (alive) {
          setShelfItems(page.items);
          setShelfError(null);
        }
      })
      .catch((e) => {
        if (alive) setShelfError(errorMessage(e));
      });
    return () => {
      alive = false;
    };
  }, [taskId, taskMissing]);

  /** 勾选/取消一条资料：取消后 Map 中移除，bullet 实时减少。 */
  const toggleMaterial = useCallback(
    (id: string, name: string, kind: SelectedMaterial["kind"], checked: boolean) => {
      setSelectedMaterials((m) => {
        const next = new Map(m);
        if (checked) next.set(id, { name, kind });
        else next.delete(id);
        return next;
      });
      markDirty();
    },
    [markDirty],
  );

  /** 全选：把当前已加载的两数据源条目全部加入（不覆盖已有勾选）。 */
  const selectAllMaterials = useCallback(() => {
    setSelectedMaterials((m) => {
      const next = new Map(m);
      for (const n of notes ?? []) {
        if (!next.has(n.id)) next.set(n.id, { name: n.title, kind: "note" });
      }
      for (const s of shelfItems ?? []) {
        if (!next.has(s.id)) next.set(s.id, { name: s.display_name, kind: "shelf" });
      }
      return next;
    });
    markDirty();
  }, [markDirty, notes, shelfItems]);

  const clearSelectedMaterials = useCallback(() => {
    setSelectedMaterials(new Map());
    markDirty();
  }, [markDirty]);

  const onSectionChange = useCallback(
    (key: HandoffKey, value: string) => {
      editedRef.current = new Set(editedRef.current).add(key);
      setSections((m) => ({ ...m, [key]: value }));
      markDirty();
    },
    [markDirty],
  );

  /**
   * 项目背景的组合值：用户编辑/预填的基础内容 + 已勾选资料的追加块（末尾）。
   * 追加块只在预览与保存内容中生成，不写回 textarea 编辑态——因此用户编辑过
   * 「项目背景」后勾选变化仍实时反映，取消勾选后基础内容原样保留。
   */
  const backgroundComposed = useMemo(() => {
    const names = [...selectedMaterials.values()].map((m) => m.name);
    if (names.length === 0) return sections.background;
    const block = [t("devwork.handoff.materialsHeading"), ...names.map((n) => `- ${n}`)].join(
      "\n",
    );
    const base = sections.background.trimEnd();
    return base ? `${base}\n\n${block}` : block;
  }, [sections.background, selectedMaterials, t]);

  const preview = useMemo(
    () =>
      buildHandoffMarkdown(title.trim() || t("devwork.handoff.untitled"), labels, {
        ...sections,
        background: backgroundComposed,
      }),
    [backgroundComposed, labels, sections, t, title],
  );

  const titleFilled = title.trim().length > 0;

  /** 扫描最终 Markdown（含标题与追加资料块），不再逐节扫描避免漏掉非节内容。 */
  const runSecretScan = useCallback(() => {
    if (scanning) return;
    setScanning(true);
    setScanError(null);
    devHandoffSecretScan([preview])
      .then((r) => setScan({ findings: r.findings, truncated: r.truncated }))
      .catch((e) => setScanError(errorMessage(e)))
      .finally(() => setScanning(false));
  }, [preview, scanning]);

  const copyMarkdown = useCallback(() => {
    if (copying) return;
    setCopying(true);
    setCopyError(null);
    copyText(preview)
      .then((ok) => {
        if (ok) {
          showToast(t("devwork.handoff.copied"), { kind: "success" });
        } else {
          // 剪贴板被拒/占用：如实报错；编辑态都在 state，内容不丢失
          setCopyError(t("devwork.handoff.copyFailed"));
        }
      })
      .finally(() => setCopying(false));
  }, [copying, preview, showToast, t]);

  const saveVersion = useCallback(() => {
    if (saving || !titleFilled) return;
    setSaving(true);
    setSaveError(null);
    const savingTaskId = taskId;
    /** 保存开始时的草稿修订号：回调里只有相等才代表没有新修改。 */
    const savedRevision = revisionRef.current;
    const sourceSummary = JSON.stringify({
      taskId,
      projectId: project?.id ?? null,
      featureIds: (features ?? []).map((f) => f.feature.id),
      prefilled: [...prefilledRef.current],
      // Round 2a：勾选资料的 id 清单（bullet 只写条目名，回溯用 id）
      selectedNotes: [...selectedMaterials.entries()]
        .filter(([, v]) => v.kind === "note")
        .map(([id]) => id),
      selectedShelfItems: [...selectedMaterials.entries()]
        .filter(([, v]) => v.kind === "shelf")
        .map(([id]) => id),
    });
    devHandoffSave({
      taskId,
      title: title.trim(),
      contentMd: preview,
      sourceSummary,
      agentSourceId: linkedSession?.source_id ?? null,
      agentSessionExternalId: linkedSession?.external_id ?? null,
    })
      .then(({ pack }) => {
        // 保存期间已切换任务：只刷新当前任务版本列表，不覆盖新任务的编辑态。
        if (currentTaskRef.current !== savingTaskId) {
          return loadPacks(currentTaskRef.current);
        }
        if (revisionRef.current === savedRevision) {
          showToast(t("devwork.handoff.saveDone", { version: pack.version }), { kind: "success" });
          setDirty(false);
          draftCacheRef.current.delete(savingTaskId ?? "");
          // 保存成功后回到摘要态：版本列表重载完成后摘要立即反映新版本
          setEditing(false);
        } else {
          // 保存期间又有编辑：旧版本已保存，但新修改仍是 dirty，留在编辑态。
          showToast(`已保存交接包 v${pack.version}，仍有新修改未保存`, { kind: "success" });
        }
        return loadPacks(savingTaskId);
      })
      .catch((e) => {
        // 保存失败不清空任何编辑态：标题、正文与预览保持原样，可重试
        setSaveError(t("devwork.handoff.saveFailed", { error: errorMessage(e) }));
      })
      .finally(() => setSaving(false));
  }, [
    features,
    linkedSession,
    loadPacks,
    preview,
    project,
    saving,
    selectedMaterials,
    showToast,
    t,
    taskId,
    title,
    titleFilled,
  ]);

  const deletePack = useCallback(() => {
    if (!pendingDeletePackId) return;
    setDeleting(true);
    devHandoffDelete(pendingDeletePackId)
      .then(() => {
        setPendingDeletePackId(null);
        setViewPackId((cur) => (cur === pendingDeletePackId ? null : cur));
        return loadPacks(taskId);
      })
      .catch((e) => {
        showToast(t("devwork.handoff.deleteFailed", { error: errorMessage(e) }), { kind: "error" });
      })
      .finally(() => setDeleting(false));
  }, [loadPacks, pendingDeletePackId, showToast, t, taskId]);

  const findingText = useCallback(
    (f: SecretFinding): string =>
      // 扫描输入只有整篇 Markdown 一个文本块：分区名固定显示「完整文档」。
      t("devwork.handoff.scanFindingItem", {
        section: SCAN_DOCUMENT_LABEL,
        line: f.line,
        kind: f.kind,
      }),
    [t],
  );

  /** 摘要视图取版本列表首条（后端按最近优先返回）；小节标题只读自已保存 Markdown。 */
  const latestPack = packs && packs.length > 0 ? packs[0] : null;
  const latestSections = useMemo(
    () => (latestPack ? packSectionTitles(latestPack.contentMd) : []),
    [latestPack],
  );

  /** 关闭编辑面板：有未保存修改先弹确认，避免静默丢弃草稿。 */
  const requestClose = useCallback(() => {
    if (dirty) setDirtyCloseOpen(true);
    else setEditing(false);
  }, [dirty]);

  /** 收起并保留草稿：只退出编辑态，dirty 与内容原样保留（再次进入可继续）。 */
  const collapseKeepDraft = useCallback(() => {
    setDirtyCloseOpen(false);
    setEditing(false);
  }, []);

  /** 放弃修改：显式清空草稿内容并回摘要（用户明确选择了丢弃，不做静默处理）。 */
  const discardDraft = useCallback(() => {
    draftCacheRef.current.delete(taskId ?? "");
    setDirtyCloseOpen(false);
    setEditing(false);
    setDirty(false);
    setTitle("");
    setSections(emptySections());
    setSelectedMaterials(new Map());
    setLinkedSession(null);
    setScan(null);
    setScanError(null);
    editedRef.current = new Set();
    prefilledRef.current = new Set();
  }, [taskId]);

  return (
    <section className="wb-card" id="dev-handoff" aria-label={t("devwork.handoff.title")}>
      <div className="wb-section-head">
        <h3 className="wb-section-title">
          <ClipboardList size={13} aria-hidden="true" /> {t("devwork.handoff.title")}
        </h3>
        <span className="flex-spacer" />
        {dirty && <span className="badge subtle">{t("notes.save.unsavedBadge")}</span>}
        {taskId ? (
          <span className="badge subtle">{t("devwork.handoff.linkedToTask")}</span>
        ) : (
          <span className="badge subtle">{t("devwork.handoff.draftBadge")}</span>
        )}
        {editing ? (
          <button
            type="button"
            className="btn sm"
            onClick={requestClose}
            data-tip={t("common.close")}
          >
            <X size={12} aria-hidden="true" /> {t("common.close")}
          </button>
        ) : (
          <button
            type="button"
            className="btn sm"
            onClick={() => setEditing(true)}
            data-tip={latestPack ? t("workbench.editTask") : t("quickAdd.create")}
          >
            {latestPack || dirty ? (
              <Pencil size={12} aria-hidden="true" />
            ) : (
              <Plus size={12} aria-hidden="true" />
            )}
            {latestPack || dirty ? t("workbench.editTask") : t("quickAdd.create")}
          </button>
        )}
      </div>

      {/* 当前任务被删除：如实提示，保存退化为无任务草稿，不静默关联（摘要/编辑两态都展示） */}
      {taskId && taskMissing && (
        <div className="wb-stale" role="alert">
          <span className="wb-stale-text">{t("devwork.acceptance.taskMissing")}</span>
        </div>
      )}

      {/* 摘要视图：最近版本的关键字段 + 更新时间 + 关联会话；无版本给创建引导 */}
      {!editing && (
        <div className="wb-handoff-summary">
          {packs === null ? (
            <div className="empty-hint" role="status">
              {t("nav.loading")}
            </div>
          ) : latestPack ? (
            <>
              <div className="wb-handoff-summary-head">
                <span className="wb-row-title" title={latestPack.title}>{latestPack.title}</span>
                <span className="badge subtle">
                  {t("devwork.handoff.packVersion", { version: latestPack.version })}
                </span>
              </div>
              <div className="wb-handoff-summary-meta">
                <span className="wb-meta-item">
                  {latestPack.agentSessionExternalId
                    ? `${t("devwork.handoff.agentSessionPack", {
                        title: latestPack.agentSessionTitle || latestPack.agentSessionExternalId,
                      })}${latestPack.agentSessionAvailable ? "" : ` · ${t("devwork.handoff.agentSessionStale")}`}`
                    : t("devwork.handoff.agentSessionNone")}
                </span>
                <span className="wb-meta-item">{formatRelative(latestPack.createdAt)}</span>
              </div>
              {latestSections.length > 0 && (
                <div className="wb-handoff-section-chips">
                  {latestSections.map((section) => (
                    <span className="wb-handoff-section-chip" key={section}>
                      {section}
                    </span>
                  ))}
                </div>
              )}
            </>
          ) : (
            <div className="wb-empty">
              <p className="wb-empty-title">{t("devwork.handoff.versionsEmpty")}</p>
              <p className="endpoint-hint">{t("devwork.handoff.hint")}</p>
            </div>
          )}
        </div>
      )}

      <div className={`wb-handoff-body${editing ? " is-open" : " is-collapsed"}`}>
      <p className="endpoint-hint">{t("devwork.handoff.hint")}</p>

      <label className="field">
        <span>{t("devwork.handoff.packTitle")}</span>
        <input
          value={title}
          onChange={(e) => {
            setTitle(e.target.value);
            markDirty();
          }}
          aria-label={t("devwork.handoff.packTitle")}
          maxLength={200}
          placeholder={task?.title ?? t("devwork.handoff.untitled")}
        />
      </label>

      {/* Agent 会话关联（v50）：只登记「交给哪个会话」，不推断身份、不自动执行 */}
      <div className="wb-accept-block wb-handoff-session">
        <div className="wb-links-title">{t("devwork.handoff.agentSessionTitle")}</div>
        <p className="endpoint-hint">{t("devwork.handoff.agentSessionHint")}</p>
        <div className="wb-accept-evidence-row">
          <input
            className="wb-accept-criteria-input"
            value={sessionKeyword}
            onChange={(e) => setSessionKeyword(e.target.value)}
            aria-label={t("devwork.handoff.agentSessionSearchPlaceholder")}
            placeholder={t("devwork.handoff.agentSessionSearchPlaceholder")}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                fetchSessions(sessionKeyword);
              }
            }}
          />
          <button
            type="button"
            className="btn sm"
            onClick={() => fetchSessions(sessionKeyword)}
          >
            {t("devwork.handoff.agentSessionSearch")}
          </button>
        </div>
        {sessionsError && (
          <div className="wb-error-row" role="alert">
            <span>{t("devwork.handoff.agentSessionLoadFailed", { error: sessionsError })}</span>
          </div>
        )}
        <Combobox
          value={linkedSession ? sessionKey(linkedSession) : ""}
          options={[
            ...(sessions ?? []).map((s) => ({
              value: sessionKey(s),
              label: `${s.title || s.external_id} · ${s.status}`,
              hint: s.source_id,
            })),
            { value: SESSION_NONE, label: t("devwork.handoff.agentSessionClear") },
          ]}
          onChange={(key) => {
            if (key === SESSION_NONE) {
              setLinkedSession(null);
            } else {
              setLinkedSession((sessions ?? []).find((s) => sessionKey(s) === key) ?? null);
            }
            markDirty();
          }}
          ariaLabel={t("devwork.handoff.agentSessionTitle")}
          searchPlaceholder={t("devwork.handoff.agentSessionSearchPlaceholder")}
          emptyText={t("devwork.handoff.agentSessionEmpty")}
          placeholder={t("devwork.handoff.agentSessionNone")}
          size="sm"
        />
        <div className="endpoint-hint">
          {linkedSession
            ? t("devwork.handoff.agentSessionLinked", {
                title: linkedSession.title || linkedSession.external_id,
              })
            : t("devwork.handoff.agentSessionRecent", { count: sessions?.length ?? 0 })}
        </div>
      </div>

      <div className="wb-handoff-grid">
        {HANDOFF_SECTIONS.slice(0, 4).map((s) => (
          <label className="field wb-handoff-field" key={s.key}>
            <span>{labels[s.key]}</span>
            <textarea
              rows={2}
              value={sections[s.key]}
              onChange={(e) => onSectionChange(s.key, e.target.value)}
              aria-label={labels[s.key]}
            />
          </label>
        ))}
      </div>

      {/* 其余 8 节默认折叠：它们仍是完整模板的一部分，但不应把首屏卡片拉到一屏高。 */}
      <details className="wb-handoff-more">
        <summary>{t("devwork.handoff.moreSections")}</summary>
        <div className="wb-handoff-grid">
          {HANDOFF_SECTIONS.slice(4).map((s) => (
            <label className="field wb-handoff-field" key={s.key}>
              <span>{labels[s.key]}</span>
              <textarea
                rows={2}
                value={sections[s.key]}
                onChange={(e) => onSectionChange(s.key, e.target.value)}
                aria-label={labels[s.key]}
              />
            </label>
          ))}
        </div>
      </details>

      {/* 资料选择（Round 2a）：仅有关联任务时显示；只选条目名，不带入正文。
          勾选结果在预览「项目背景」末尾实时生成追加块，不写回编辑态。 */}
      {taskId && !taskMissing && (
        <div className="wb-accept-block wb-materials">
          <div className="wb-links-title">
            {t("devwork.handoff.materialsTitle")}
            <span className="flex-spacer" />
            <button
              type="button"
              className="btn sm"
              disabled={(notes?.length ?? 0) + (shelfItems?.length ?? 0) === 0}
              onClick={selectAllMaterials}
            >
              {t("devwork.handoff.selectAll")}
            </button>
            <button
              type="button"
              className="btn sm"
              disabled={selectedMaterials.size === 0}
              onClick={clearSelectedMaterials}
            >
              {t("devwork.handoff.clearSelected")}
            </button>
          </div>
          <p className="endpoint-hint">{t("devwork.handoff.materialsHint")}</p>
          {notesError && (
            <div className="wb-error-row" role="alert">
              <span>{t("devwork.handoff.notesLoadFailed", { error: notesError })}</span>
            </div>
          )}
          {shelfError && (
            <div className="wb-error-row" role="alert">
              <span>{t("devwork.handoff.shelfLoadFailed", { error: shelfError })}</span>
            </div>
          )}
          <div className="wb-materials-grid">
            <div
              className="wb-materials-group"
              role="group"
              aria-label={t("devwork.handoff.notesGroup")}
            >
              <div className="wb-materials-group-title">{t("devwork.handoff.notesGroup")}</div>
              {notes === null && !notesError && (
                <div className="empty-hint" role="status">
                  {t("nav.loading")}
                </div>
              )}
              {notes !== null && notes.length === 0 && (
                <div className="endpoint-hint">{t("devwork.handoff.notesEmpty")}</div>
              )}
              {notes?.map((n) => (
                <Checkbox
                  key={n.id}
                  checked={selectedMaterials.has(n.id)}
                  onChange={(checked) => toggleMaterial(n.id, n.title, "note", checked)}
                  className="wb-materials-item"
                  label={
                    <span className="wb-materials-item-name" data-tip={n.title}>
                      {n.title}
                    </span>
                  }
                />
              ))}
            </div>
            <div
              className="wb-materials-group"
              role="group"
              aria-label={t("devwork.handoff.shelfGroup")}
            >
              <div className="wb-materials-group-title">{t("devwork.handoff.shelfGroup")}</div>
              {shelfItems === null && !shelfError && (
                <div className="empty-hint" role="status">
                  {t("nav.loading")}
                </div>
              )}
              {shelfItems !== null && shelfItems.length === 0 && (
                <div className="endpoint-hint">{t("devwork.handoff.shelfEmpty")}</div>
              )}
              {shelfItems?.map((s) => (
                <Checkbox
                  key={s.id}
                  checked={selectedMaterials.has(s.id)}
                  onChange={(checked) => toggleMaterial(s.id, s.display_name, "shelf", checked)}
                  className="wb-materials-item"
                  label={
                    <span className="wb-materials-item-name" data-tip={s.display_name}>
                      {s.display_name}
                    </span>
                  }
                />
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="wb-handoff-preview-wrap">
        <div className="wb-links-title">
          <ScrollText size={12} aria-hidden="true" /> {t("devwork.handoff.previewTitle")}
        </div>
        <pre className="wb-handoff-preview" aria-label={t("devwork.handoff.previewTitle")}>
          {preview}
        </pre>
      </div>

      {/* 敏感扫描：只显示节名/行号/类型，绝不渲染命中原文 */}
      <div className="wb-accept-block">
        <button
          type="button"
          className="btn sm"
          disabled={scanning}
          onClick={runSecretScan}
          data-tip={t("devwork.handoff.scanTip")}
        >
          <ShieldAlert size={12} aria-hidden="true" /> {t("devwork.handoff.scan")}
        </button>
        {scanError && (
          <div className="wb-error-row" role="alert">
            <span>{t("devwork.handoff.scanFailed", { error: scanError })}</span>
          </div>
        )}
        {scan && !scanError && scan.findings.length === 0 && (
          <div className="wb-scan-clean" role="status">
            {t("devwork.handoff.scanClean")}
          </div>
        )}
        {scan && scan.findings.length > 0 && (
          <div className="wb-scan-findings" role="alert">
            <div>{t("devwork.handoff.scanFindings", { count: scan.findings.length })}</div>
            <ul>
              {scan.findings.map((f, i) => (
                <li key={`${f.textIndex}:${f.line}:${f.kind}:${i}`}>{findingText(f)}</li>
              ))}
            </ul>
            {scan.truncated && <div className="endpoint-hint">{t("devwork.handoff.scanTruncated")}</div>}
          </div>
        )}
      </div>

      <div className="wb-actions wb-handoff-actions">
        <button type="button" className="btn primary sm" disabled={copying} onClick={copyMarkdown}>
          {t("devwork.handoff.copyMd")}
        </button>
        <button
          type="button"
          className="btn sm"
          disabled={saving || !titleFilled}
          onClick={saveVersion}
          data-tip={titleFilled ? undefined : t("devwork.handoff.titleRequired")}
        >
          {t("devwork.handoff.saveVersion")}
        </button>
      </div>
      {!titleFilled && (
        <div className="endpoint-hint">{t("devwork.handoff.titleRequired")}</div>
      )}
      {copyError && (
        <div className="wb-error-row" role="alert">
          <span>{copyError}</span>
        </div>
      )}
      {saveError && (
        <div className="wb-error-row" role="alert">
          <span>{saveError}</span>
        </div>
      )}
      </div>

      {/* 版本记录：同 taskId 最近 5 版；查看 / 复制 / 删除（追加式，不提供编辑）。
          编辑态始终展示；摘要态仅在确有版本时展示，避免与上方「还没有保存的版本」
          空态重复两遍。 */}
      {(editing || (packs !== null && packs.length > 0)) && (
        <div className="wb-accept-block">
          <div className="wb-links-title">{t("devwork.handoff.versionsTitle")}</div>
          {packs === null && (
            <div className="empty-hint" role="status">
              {t("nav.loading")}
            </div>
          )}
          {packs !== null && packs.length === 0 && (
            <div className="endpoint-hint">{t("devwork.handoff.versionsEmpty")}</div>
          )}
          {packs?.map((p) => (
            <div className="wb-row wb-handoff-pack" key={p.id}>
              <span className="wb-row-main">
                <span className="wb-row-title">
                  {t("devwork.handoff.packVersion", { version: p.version })} · {p.title}
                </span>
                <span className="wb-row-sub">
                  {p.agentSessionExternalId && (
                    <span>
                      {t("devwork.handoff.agentSessionPack", {
                        title: p.agentSessionTitle || p.agentSessionExternalId,
                      })}
                      {!p.agentSessionAvailable
                        ? ` · ${t("devwork.handoff.agentSessionStale")}`
                        : ""}
                    </span>
                  )}
                  <span>{formatRelative(p.createdAt)}</span>
                </span>
              </span>
              <button
                type="button"
                className="btn sm"
                aria-expanded={viewPackId === p.id}
                onClick={() => setViewPackId((cur) => (cur === p.id ? null : p.id))}
              >
                {viewPackId === p.id ? t("devwork.handoff.viewClose") : t("devwork.handoff.view")}
              </button>
              <button
                type="button"
                className="icon-btn sm"
                aria-label={t("devwork.handoff.copyPackAria", { version: p.version })}
                data-tip={t("devwork.handoff.copyMd")}
                onClick={() => {
                  void copyText(p.contentMd).then((ok) => {
                    if (ok) showToast(t("devwork.handoff.copied"), { kind: "success" });
                    else showToast(t("devwork.handoff.copyFailed"), { kind: "error" });
                  });
                }}
              >
                ⧉
              </button>
              <button
                type="button"
                className="icon-btn sm"
                aria-label={t("devwork.handoff.deletePackAria", { version: p.version })}
                data-tip={t("devwork.handoff.deletePack")}
                onClick={() => setPendingDeletePackId(p.id)}
              >
                ×
              </button>
            </div>
          ))}
          {viewPackId && (
            <pre className="wb-handoff-preview wb-handoff-pack-view" aria-live="polite">
              {packs?.find((p) => p.id === viewPackId)?.contentMd ?? ""}
            </pre>
          )}
        </div>
      )}

      <ConfirmDialog
        open={pendingDeletePackId !== null}
        title={t("devwork.handoff.deletePackTitle")}
        detail={t("devwork.handoff.deletePackDetail", {
          version: packs?.find((p) => p.id === pendingDeletePackId)?.version ?? "",
        })}
        confirmLabel={t("devwork.handoff.deletePack")}
        danger
        busy={deleting}
        onConfirm={() => void deletePack()}
        onCancel={() => setPendingDeletePackId(null)}
      />

      {/* 未保存修改关闭确认：三个明确动作——取消 / 收起并保留草稿 / 放弃修改（清空草稿）。 */}
      <Dialog
        open={dirtyCloseOpen}
        onClose={() => setDirtyCloseOpen(false)}
        size="sm"
        dismissOnScrim={false}
        ariaLabel={t("appMgmt.leave.title")}
        className="ui-confirm-mask"
        title={<span className="ui-confirm-title is-danger">{t("appMgmt.leave.title")}</span>}
        footer={
          <>
            <button
              type="button"
              className="btn"
              data-autofocus
              onClick={() => setDirtyCloseOpen(false)}
            >
              {t("common.cancel")}
            </button>
            <button type="button" className="btn" onClick={collapseKeepDraft}>
              收起并保留草稿
            </button>
            <button type="button" className="btn danger" onClick={discardDraft}>
              放弃修改
            </button>
          </>
        }
      >
        <p className="endpoint-hint">{t("appMgmt.leave.detailDirty")}</p>
      </Dialog>
    </section>
  );
}
