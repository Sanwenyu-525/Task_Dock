import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Check, Copy, FolderOpen, Loader2, Pencil, Play, Plus, Trash2 } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  onWorkflowRunProgress,
  onWorkspaceRestoreProgress,
  shelfCheckExists,
  shelfGetItem,
  shelfList,
  workflowList,
  workspaceList,
  type ScenarioAppTarget,
  type ScenarioDetail,
  type ScenarioEnterItemResult,
  type ScenarioEnterResult,
  type ScenarioSaveInput,
  type ScenarioSummary,
  type ShelfItem,
  type SnapshotSummary,
  type Workflow,
} from "../../lib/bridge";
import { navListTargets, type NavTarget } from "../../lib/navigation";
import { createSubscriptionScope } from "../../lib/subscriptions";
import { errorMessage } from "../../lib/errors";
import { useScenarioStore, scenarioItemProgressKey, type ScenarioAsyncStatus } from "../../store/useScenarioStore";
import ContextHelpButton from "../help/ContextHelpButton";
import { Combobox, ConfirmDialog, EmptyState, Popover, SearchField, Select } from "../ui";
import "./scenario-workspace.css";

interface ScenarioDraft {
  id?: string;
  name: string;
  icon: string;
  apps: ScenarioAppTarget[];
  urlsText: string;
  /** 文件夹条目：主入口是系统文件选择器（多选），手动输入只是补充。 */
  folders: string[];
  snapshotId: string;
  linkedWorkflowId: string;
  shelfItemIds: string[];
}

const EMPTY_DRAFT: ScenarioDraft = {
  name: "",
  icon: "",
  apps: [],
  urlsText: "",
  folders: [],
  snapshotId: "",
  linkedWorkflowId: "",
  shelfItemIds: [],
};
const MANUAL_APP_TARGET = "__use_executable_path__";
const NO_ASSOCIATION = "__no_association__";
const SHELF_PAGE_SIZE = 100;

/** 场景图标预设：覆盖工作 / 创作 / 生活 / 休息等常见场景语义，点选写入 icon 字段（后端仍按 4 字符截断兜底）。 */
const SCENARIO_ICONS = [
  "💼", "🖥️", "💻", "📊", "✍️", "📚", "🎨", "🎬", "🎮", "🎵",
  "🧠", "🔬", "🛠️", "⚙️", "📅", "📝", "🌐", "☁️", "🧩", "🚀",
  "🏠", "☕", "🌙", "🌅", "🏃", "🧘", "💤", "📦",
] as const;

function shelfKindLabel(kind: ShelfItem["kind"]): string {
  return kind === "folder" ? "文件夹" : "文件";
}

function shelfModeLabel(mode: ShelfItem["storage_mode"]): string {
  return mode === "managed" ? "托管副本" : "引用路径";
}

function shelfAvailability(item: Pick<ShelfItem, "exists_state" | "storage_mode">): string {
  if (item.exists_state === "missing") return item.storage_mode === "managed" ? "托管文件缺失" : "原路径失效";
  if (item.exists_state === "unknown") return "尚未检查";
  return "可用";
}

function draftFromDetail(detail: ScenarioDetail): ScenarioDraft {
  return {
    id: detail.id,
    name: detail.name,
    icon: detail.icon ?? "",
    apps: detail.apps.map((app) => ({ ...app })),
    urlsText: detail.urls.join("\n"),
    folders: [...detail.folders],
    snapshotId: detail.snapshotId ?? "",
    linkedWorkflowId: detail.linkedWorkflowId ?? "",
    shelfItemIds: detail.shelfItemIds ?? [],
  };
}

function lines(value: string): string[] {
  return value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
}

function saveInput(draft: ScenarioDraft): ScenarioSaveInput {
  return {
    ...(draft.id ? { id: draft.id } : {}),
    name: draft.name,
    icon: draft.icon || null,
    apps: draft.apps,
    urls: lines(draft.urlsText),
    folders: draft.folders,
    snapshotId: draft.snapshotId || null,
    linkedWorkflowId: draft.linkedWorkflowId || null,
    shelfItemIds: draft.shelfItemIds,
  };
}

/** 系统文件夹选择器返回值归一化：null（用户取消）/ 单个 / 多个。 */
function normalizeDialogPaths(picked: string | string[] | null): string[] {
  if (picked == null) return [];
  return (Array.isArray(picked) ? picked : [picked]).map((p) => p.trim()).filter(Boolean);
}

function progressLabel(status: ScenarioAsyncStatus): string {
  switch (status) {
    case "accepted": return "已受理";
    case "running": return "运行中";
    case "completed": return "已完成";
    case "partial": return "部分成功";
    case "failed": return "失败";
    case "cancelled": return "已取消";
  }
}

function itemPresentation(
  item: ScenarioEnterItemResult,
  progress: { status: ScenarioAsyncStatus; detail: string } | undefined,
  enterCancelled = false,
): { status: ScenarioAsyncStatus; label: string; detail: string } {
  if (item.status === "skipped") {
    return { status: "partial", label: "已跳过", detail: item.detail ?? "该项未执行" };
  }
  if (item.status === "failed") {
    // 本次进入被用户取消时，后端的取消项 detail 是受控契约文案（含「取消」），
    // 按「已取消」呈现而不是失败；真实执行失败照旧显示失败。
    if (enterCancelled && (item.detail ?? "").includes("取消")) {
      return { status: "cancelled", label: "已取消", detail: item.detail ?? "" };
    }
    return { status: "failed", label: "失败", detail: item.detail ?? "该项执行失败" };
  }
  if (item.kind === "snapshot" || item.kind === "workflow") {
    const current = progress ?? { status: "accepted" as const, detail: "后台操作已受理，等待进度事件" };
    return { status: current.status, label: progressLabel(current.status), detail: current.detail };
  }
  return { status: "completed", label: "已完成", detail: item.detail ?? "" };
}

function resultState(
  items: ScenarioEnterItemResult[],
  progressByItem: Record<string, { status: ScenarioAsyncStatus; detail: string }>,
  result?: Pick<ScenarioEnterResult, "cancelled" | "timedOut">,
): { status: ScenarioAsyncStatus; label: string } {
  if (result?.cancelled) return { status: "cancelled", label: "已取消" };
  if (result?.timedOut) return { status: "failed", label: "已超时" };
  const presentations = items.map((item) =>
    itemPresentation(
      item,
      item.kind === "snapshot" || item.kind === "workflow"
        ? progressByItem[scenarioItemProgressKey(item.kind, item.label)]
        : undefined,
      result?.cancelled === true,
    ),
  );
  if (presentations.some((item) => item.status === "running")) return { status: "running", label: "运行中" };
  if (presentations.some((item) => item.status === "accepted")) return { status: "accepted", label: "已受理" };
  if (presentations.some((item) => item.status === "cancelled")) return { status: "cancelled", label: "已取消" };
  if (presentations.some((item) => item.status === "failed")) return { status: "failed", label: "失败" };
  if (presentations.some((item) => item.status === "partial")) return { status: "partial", label: "部分成功" };
  return { status: "completed", label: "已完成" };
}

/** 取消/超时后的整体摘要：已处理数与计划总数，并明确「已启动项不回滚」。 */
function stopSummary(result: ScenarioEnterResult): string | null {
  if (!result.cancelled && !result.timedOut) return null;
  const reason = result.cancelled ? "已取消" : "已超时";
  return `${reason}：已处理 ${result.items.length}/${result.total} 项，剩余项未执行；已启动的应用、网页与现场恢复不会被关闭。`;
}

export default function ScenarioWorkspaceView({ onBack }: { onBack: () => void }) {
  const summaries = useScenarioStore((s) => s.summaries);
  const loading = useScenarioStore((s) => s.loading);
  const loaded = useScenarioStore((s) => s.loaded);
  const error = useScenarioStore((s) => s.error);
  const enteringId = useScenarioStore((s) => s.enteringId);
  const cancellingId = useScenarioStore((s) => s.cancellingId);
  const results = useScenarioStore((s) => s.results);
  const progressByItem = useScenarioStore((s) => s.progressByItem);
  const load = useScenarioStore((s) => s.load);
  const openEditor = useScenarioStore((s) => s.openEditor);
  const closeEditor = useScenarioStore((s) => s.closeEditor);
  const save = useScenarioStore((s) => s.save);
  const remove = useScenarioStore((s) => s.remove);
  const duplicate = useScenarioStore((s) => s.duplicate);
  const enter = useScenarioStore((s) => s.enter);
  const cancelEnter = useScenarioStore((s) => s.cancelEnter);
  const applyRestoreProgress = useScenarioStore((s) => s.applyRestoreProgress);
  const applyWorkflowProgress = useScenarioStore((s) => s.applyWorkflowProgress);

  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState<ScenarioDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [actionId, setActionId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ScenarioSummary | null>(null);
  const [snapshots, setSnapshots] = useState<SnapshotSummary[] | null>(null);
  const [workflows, setWorkflows] = useState<Workflow[] | null>(null);
  const [targets, setTargets] = useState<NavTarget[] | null>(null);
  const [shelfSearch, setShelfSearch] = useState("");
  const [shelfCandidates, setShelfCandidates] = useState<ShelfItem[]>([]);
  const [selectedShelfItems, setSelectedShelfItems] = useState<Record<string, ShelfItem | null>>({});
  const [shelfFileOffset, setShelfFileOffset] = useState(0);
  const [shelfFolderOffset, setShelfFolderOffset] = useState(0);
  const [shelfFileTotal, setShelfFileTotal] = useState(0);
  const [shelfFolderTotal, setShelfFolderTotal] = useState(0);
  const [shelfLoading, setShelfLoading] = useState(false);
  const [shelfError, setShelfError] = useState<string | null>(null);
  const shelfRequestId = useRef(0);
  const [refError, setRefError] = useState<string | null>(null);
  const [viewError, setViewError] = useState<string | null>(null);
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const iconAnchorRef = useRef<HTMLButtonElement | null>(null);
  const [folderManual, setFolderManual] = useState("");

  useEffect(() => {
    const scope = createSubscriptionScope();
    scope.add(onWorkspaceRestoreProgress(applyRestoreProgress));
    scope.add(onWorkflowRunProgress(applyWorkflowProgress));
    void load();
    return () => scope.dispose();
  }, [applyRestoreProgress, applyWorkflowProgress, load]);

  useEffect(() => {
    let alive = true;
    Promise.allSettled([workspaceList(), workflowList(), navListTargets()]).then((results) => {
      if (!alive) return;
      const [snapshotResult, workflowResult, targetResult] = results;
      if (snapshotResult.status === "fulfilled") setSnapshots(snapshotResult.value);
      else setRefError((prev) => [prev, `工作现场加载失败：${errorMessage(snapshotResult.reason)}`].filter(Boolean).join("；"));
      if (workflowResult.status === "fulfilled") setWorkflows(workflowResult.value);
      else setRefError((prev) => [prev, `工作流加载失败：${errorMessage(workflowResult.reason)}`].filter(Boolean).join("；"));
      if (targetResult.status === "fulfilled") setTargets(targetResult.value);
      else setRefError((prev) => [prev, `应用目标加载失败：${errorMessage(targetResult.reason)}`].filter(Boolean).join("；"));
    });
    return () => { alive = false; };
  }, []);

  const editingSceneId = draft?.id ?? null;
  const isEditingScenario = draft !== null;
  useEffect(() => {
    if (!isEditingScenario) {
      shelfRequestId.current += 1;
      setShelfCandidates([]);
      setShelfLoading(false);
      setShelfError(null);
      return;
    }
    const requestId = ++shelfRequestId.current;
    const timer = window.setTimeout(() => {
      void (async () => {
        setShelfLoading(true);
        setShelfError(null);
        setShelfCandidates([]);
        setShelfFileOffset(0);
        setShelfFolderOffset(0);
        setShelfFileTotal(0);
        setShelfFolderTotal(0);
        try {
          const [files, folders] = await Promise.all([
            shelfList({ kind: "file", search: shelfSearch.trim() || undefined, limit: SHELF_PAGE_SIZE, offset: 0 }),
            shelfList({ kind: "folder", search: shelfSearch.trim() || undefined, limit: SHELF_PAGE_SIZE, offset: 0 }),
          ]);
          if (requestId !== shelfRequestId.current) return;
          const items = [...files.items, ...folders.items];
          const exists = items.length ? await shelfCheckExists(items.map((item) => item.id)) : [];
          if (requestId !== shelfRequestId.current) return;
          const existsById = new Map(exists.map((item) => [item.id, item.exists_state]));
          setShelfCandidates(items.map((item) => ({
            ...item,
            exists_state: (existsById.get(item.id) as ShelfItem["exists_state"] | undefined) ?? item.exists_state,
          })));
          setShelfFileOffset(files.items.length);
          setShelfFolderOffset(folders.items.length);
          setShelfFileTotal(files.total);
          setShelfFolderTotal(folders.total);
        } catch (e) {
          if (requestId === shelfRequestId.current) setShelfError(errorMessage(e));
        } finally {
          if (requestId === shelfRequestId.current) setShelfLoading(false);
        }
      })();
    }, 220);
    return () => window.clearTimeout(timer);
  }, [isEditingScenario, editingSceneId, shelfSearch]);

  useEffect(() => {
    const ids = draft?.shelfItemIds ?? [];
    if (ids.length === 0) {
      setSelectedShelfItems({});
      return;
    }
    let alive = true;
    void Promise.all(ids.map(async (id) => {
      try {
        return [id, await shelfGetItem(id)] as const;
      } catch {
        return [id, null] as const;
      }
    })).then(async (entries) => {
      const existingIds = entries.filter((entry) => entry[1] !== null).map((entry) => entry[0]);
      const states = existingIds.length ? await shelfCheckExists(existingIds).catch(() => []) : [];
      if (!alive) return;
      const stateById = new Map(states.map((item) => [item.id, item.exists_state]));
      setSelectedShelfItems(Object.fromEntries(entries.map(([id, item]) => [
        id,
        item ? { ...item, exists_state: (stateById.get(id) as ShelfItem["exists_state"] | undefined) ?? item.exists_state } : null,
      ])));
    });
    return () => { alive = false; };
  }, [editingSceneId, draft?.shelfItemIds.join("\u001f")]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return summaries;
    return summaries.filter((scene) =>
      [scene.name, scene.icon ?? ""].some((value) => value.toLocaleLowerCase().includes(needle)),
    );
  }, [query, summaries]);

  const beginCreate = () => {
    closeEditor();
    setDraft({ ...EMPTY_DRAFT });
    setViewError(null);
  };

  const beginEdit = async (id: string) => {
    setViewError(null);
    setActionId(id);
    try {
      const detail = await openEditor(id);
      setDraft(draftFromDetail(detail));
    } catch (e) {
      setViewError(errorMessage(e));
    } finally {
      setActionId(null);
    }
  };

  const cancelEdit = () => {
    setDraft(null);
    closeEditor();
    setViewError(null);
  };

  const loadMoreShelf = async () => {
    if (!draft || shelfLoading) return;
    const requestId = ++shelfRequestId.current;
    setShelfLoading(true);
    setShelfError(null);
    try {
      const [files, folders] = await Promise.all([
        shelfFileOffset < shelfFileTotal
          ? shelfList({ kind: "file", search: shelfSearch.trim() || undefined, limit: SHELF_PAGE_SIZE, offset: shelfFileOffset })
          : Promise.resolve({ items: [], total: shelfFileTotal }),
        shelfFolderOffset < shelfFolderTotal
          ? shelfList({ kind: "folder", search: shelfSearch.trim() || undefined, limit: SHELF_PAGE_SIZE, offset: shelfFolderOffset })
          : Promise.resolve({ items: [], total: shelfFolderTotal }),
      ]);
      if (requestId !== shelfRequestId.current) return;
      const items = [...files.items, ...folders.items];
      const exists = items.length ? await shelfCheckExists(items.map((item) => item.id)) : [];
      if (requestId !== shelfRequestId.current) return;
      const existsById = new Map(exists.map((item) => [item.id, item.exists_state]));
      setShelfCandidates((current) => [
        ...current,
        ...items.map((item) => ({
          ...item,
          exists_state: (existsById.get(item.id) as ShelfItem["exists_state"] | undefined) ?? item.exists_state,
        })),
      ]);
      setShelfFileOffset((offset) => offset + files.items.length);
      setShelfFolderOffset((offset) => offset + folders.items.length);
    } catch (e) {
      if (requestId === shelfRequestId.current) setShelfError(errorMessage(e));
    } finally {
      if (requestId === shelfRequestId.current) setShelfLoading(false);
    }
  };

  const toggleShelfItem = (id: string) => {
    setDraft((current) => {
      if (!current) return current;
      const selected = current.shelfItemIds.includes(id);
      return {
        ...current,
        shelfItemIds: selected
          ? current.shelfItemIds.filter((itemId) => itemId !== id)
          : [...current.shelfItemIds, id],
      };
    });
  };

  /** 系统文件夹选择器（多选）：选中的路径并入清单，去重保序；用户取消（null）静默返回。 */
  const browseFolders = async () => {
    setViewError(null);
    let picked: string | string[] | null;
    try {
      picked = await openDialog({ directory: true, multiple: true, title: "选择文件夹" });
    } catch (e) {
      setViewError(`文件夹选择失败：${errorMessage(e)}`);
      return;
    }
    const paths = normalizeDialogPaths(picked);
    if (paths.length === 0) return;
    setDraft((current) => {
      if (!current) return current;
      const seen = new Set(current.folders);
      const merged = [...current.folders];
      for (const path of paths) {
        if (!seen.has(path)) {
          seen.add(path);
          merged.push(path);
        }
      }
      return { ...current, folders: merged };
    });
  };

  const addFolderManual = () => {
    const path = folderManual.trim();
    if (!path) return;
    setDraft((current) => {
      if (!current || current.folders.includes(path)) return current;
      return { ...current, folders: [...current.folders, path] };
    });
    setFolderManual("");
  };

  const removeFolder = (path: string) => {
    setDraft((current) => (current ? { ...current, folders: current.folders.filter((item) => item !== path) } : current));
  };

  const saveDraft = async () => {
    if (!draft || saving) return;
    setSaving(true);
    setViewError(null);
    try {
      await save(saveInput(draft));
      setDraft(null);
    } catch (e) {
      setViewError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const perform = async (id: string, action: () => Promise<unknown>) => {
    setViewError(null);
    setActionId(id);
    try {
      await action();
    } catch (e) {
      setViewError(errorMessage(e));
    } finally {
      setActionId(null);
    }
  };

  if (draft) {
    const appOptions = [
      { value: MANUAL_APP_TARGET, label: "使用 exe 路径" },
      ...(targets ?? [])
        .filter((target) => target.target_type === "application")
        .map((target) => ({ value: target.id, label: target.display_name || target.id })),
    ];
    return (
      <section className="scenario-workspace">
        <header className="scenario-head">
          <button type="button" className="icon-btn sm" aria-label="返回场景列表" onClick={cancelEdit}>
            <ArrowLeft size={14} aria-hidden="true" />
          </button>
          <div className="scenario-heading">
            <h2 className="wf-title">{draft.id ? "编辑场景" : "新建场景"}</h2>
            <p className="wf-subtitle">场景只保存引用与启动清单，删除场景不会删除关联的真实文件。</p>
          </div>
        </header>

        <div className="scenario-form">
          <div className="form-grid">
            <div className="form-field">
              <label className="form-label" htmlFor="scenario-name">名称</label>
              <input id="scenario-name" className="input" maxLength={40} value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })} autoFocus />
            </div>
            <div className="form-field">
              <span className="form-label" id="scenario-icon-label">图标（可选）</span>
              <button type="button" ref={iconAnchorRef} className="input scenario-icon-trigger"
                aria-label={draft.icon ? `场景图标 ${draft.icon}，点击更换` : "选择场景图标"}
                aria-haspopup="dialog" aria-expanded={iconPickerOpen}
                onClick={() => setIconPickerOpen((open) => !open)}>
                {draft.icon ? <span className="scenario-icon-value" aria-hidden="true">{draft.icon}</span> : <span className="scenario-icon-placeholder">点击选择</span>}
              </button>
              <Popover open={iconPickerOpen} onOpenChange={setIconPickerOpen} anchorRef={iconAnchorRef}
                layer="menu" placement="bottom-start" role="dialog" ariaLabel="选择场景图标">
                <div className="scenario-icon-grid">
                  {SCENARIO_ICONS.map((emoji) => (
                    <button key={emoji} type="button" className={`scenario-icon-option${draft.icon === emoji ? " is-selected" : ""}`}
                      aria-label={`图标 ${emoji}`} aria-pressed={draft.icon === emoji}
                      onClick={() => { setDraft({ ...draft, icon: emoji }); setIconPickerOpen(false); }}>
                      {emoji}
                    </button>
                  ))}
                </div>
                {draft.icon ? (
                  <button type="button" className="btn sm scenario-icon-clear"
                    onClick={() => { setDraft({ ...draft, icon: "" }); setIconPickerOpen(false); }}>
                    清除图标
                  </button>
                ) : null}
              </Popover>
            </div>
          </div>

          <div className="scenario-section-head">
            <h3>应用目标</h3>
            <button type="button" className="btn sm" onClick={() => setDraft({ ...draft, apps: [...draft.apps, {}] })}>
              <Plus size={13} aria-hidden="true" /> 添加应用
            </button>
          </div>
          {draft.apps.length === 0 ? <p className="wf-hint-text">可添加已登记应用目标，或填写 exe 路径。</p> : null}
          {draft.apps.map((app, index) => (
            <div className="scenario-app-row" key={`${index}-${app.targetId ?? app.exePath ?? "new"}`}>
              <div className="form-field">
                <span className="form-label">应用 {index + 1}</span>
                <Combobox
                  value={app.targetId ?? MANUAL_APP_TARGET}
                  options={appOptions}
                  onChange={(targetId) => setDraft({ ...draft, apps: draft.apps.map((item, i) => i === index ? targetId === MANUAL_APP_TARGET ? { ...item, targetId: undefined } : { ...item, targetId, exePath: undefined } : item) })}
                  placeholder={targets ? "搜索已登记应用" : "应用目标加载中…"}
                  ariaLabel={`选择场景应用 ${index + 1}`}
                  emptyText="没有已登记应用"
                />
              </div>
              <div className="form-field">
                <label className="form-label" htmlFor={`scenario-app-name-${index}`}>显示名称（可选）</label>
                <input id={`scenario-app-name-${index}`} className="input" value={app.displayName ?? ""}
                  onChange={(event) => setDraft({ ...draft, apps: draft.apps.map((item, i) => i === index ? { ...item, displayName: event.target.value } : item) })} />
              </div>
              <button type="button" className="icon-btn sm" aria-label={`删除应用 ${index + 1}`} onClick={() => setDraft({ ...draft, apps: draft.apps.filter((_, i) => i !== index) })}>
                <Trash2 size={13} aria-hidden="true" />
              </button>
              {!app.targetId ? (
                <div className="form-field scenario-app-path">
                  <label className="form-label" htmlFor={`scenario-app-path-${index}`}>exe 路径（未登记目标时必填）</label>
                  <input id={`scenario-app-path-${index}`} className="input" maxLength={500} value={app.exePath ?? ""}
                    onChange={(event) => setDraft({ ...draft, apps: draft.apps.map((item, i) => i === index ? { ...item, exePath: event.target.value } : item) })} />
                </div>
              ) : null}
              {!app.targetId ? (
                <div className="form-field scenario-app-path">
                  <label className="form-label" htmlFor={`scenario-app-args-${index}`}>启动参数（可选）</label>
                  <input id={`scenario-app-args-${index}`} className="input" maxLength={500} value={app.args ?? ""}
                    onChange={(event) => setDraft({ ...draft, apps: draft.apps.map((item, i) => i === index ? { ...item, args: event.target.value } : item) })} />
                </div>
              ) : null}
            </div>
          ))}

          <div className="form-field">
            <label className="form-label" htmlFor="scenario-urls">网页（每行一个 http/https 地址）</label>
            <textarea id="scenario-urls" className="input scenario-textarea" rows={3} value={draft.urlsText}
              onChange={(event) => setDraft({ ...draft, urlsText: event.target.value })} />
          </div>
          <div className="scenario-section-head">
            <h3>文件夹 <span className="scenario-shelf-count">{draft.folders.length}</span></h3>
            <button type="button" className="btn sm" onClick={() => void browseFolders()}>
              <FolderOpen size={13} aria-hidden="true" /> 浏览添加…
            </button>
          </div>
          {draft.folders.length > 0 ? (
            <ul className="scenario-folder-list" aria-label="已选择的文件夹">
              {draft.folders.map((folder) => (
                <li key={folder} className="scenario-folder-row">
                  <span className="scenario-folder-path">{folder}</span>
                  <button type="button" className="icon-btn sm" aria-label={`移除文件夹 ${folder}`}
                    onClick={() => removeFolder(folder)}>
                    <Trash2 size={13} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="wf-hint-text">还没有文件夹。点击「浏览添加」从系统选择，或在下方手动输入路径。</p>
          )}
          <div className="form-field scenario-folder-manual">
            <input id="scenario-folder-manual" className="input" value={folderManual}
              aria-label="手动添加文件夹路径"
              placeholder="手动输入文件夹路径，回车添加（可选）"
              onChange={(event) => setFolderManual(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addFolderManual(); } }} />
          </div>

          <div className="scenario-shelf-section">
            <div className="scenario-section-head">
              <h3>关联暂存文件 / 文件夹 <span className="scenario-shelf-count">{draft.shelfItemIds.length}</span></h3>
            </div>
            <p className="wf-hint-text">只保存暂存架条目 ID，不复制或移动文件。路径失效时保留关联并显示失效状态；同一条目一次只能关联一个场景。</p>
            {draft.shelfItemIds.length > 0 ? (
              <ul className="scenario-shelf-selected" aria-label="已关联的暂存条目">
                {draft.shelfItemIds.map((id) => {
                  const item = selectedShelfItems[id] ?? shelfCandidates.find((candidate) => candidate.id === id) ?? null;
                  return (
                    <li key={id} className={`scenario-shelf-row${item?.exists_state === "missing" ? " is-missing" : ""}`}>
                      <span className="scenario-shelf-item-name">{item?.display_name ?? "暂存条目暂不可用"}</span>
                      <span className="scenario-shelf-item-meta">
                        {item ? `${shelfKindLabel(item.kind)} · ${shelfModeLabel(item.storage_mode)} · ${shelfAvailability(item)}` : "关联 ID 保留"}
                      </span>
                      <button type="button" className="icon-btn sm" aria-label={`移除关联 ${item?.display_name ?? id}`}
                        onClick={() => toggleShelfItem(id)}>
                        <Trash2 size={13} aria-hidden="true" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : <p className="wf-hint-text">尚未关联暂存条目。</p>}
            <SearchField value={shelfSearch} onChange={setShelfSearch} ariaLabel="搜索暂存文件和文件夹"
              placeholder="按暂存条目名称搜索" className="scenario-shelf-search" />
            {shelfError ? <p className="wf-error-text" role="alert">暂存架条目加载失败：{shelfError}</p> : null}
            {shelfLoading && shelfCandidates.length === 0 ? <p className="wf-empty-steps" role="status">正在读取暂存架条目…</p> : null}
            {(() => {
              const available = shelfCandidates.filter((item) => item.scene_id === null || item.scene_id === editingSceneId);
              return available.length > 0 ? (
                <ul className="scenario-shelf-candidates" aria-label="可关联的暂存文件和文件夹">
                  {available.map((item) => {
                    const selected = draft.shelfItemIds.includes(item.id);
                    return (
                      <li key={item.id}>
                        <button type="button" className={`scenario-shelf-option${selected ? " is-selected" : ""}`}
                          aria-pressed={selected} onClick={() => toggleShelfItem(item.id)}>
                          <span className="scenario-shelf-option-icon" aria-hidden="true">{selected ? <Check size={13} /> : <Plus size={13} />}</span>
                          <span className="scenario-shelf-item-name">{item.display_name}</span>
                          <span className={`scenario-shelf-item-meta${item.exists_state === "missing" ? " is-missing" : ""}`}>
                            {shelfKindLabel(item.kind)} · {shelfModeLabel(item.storage_mode)} · {shelfAvailability(item)}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : !shelfLoading ? <p className="wf-hint-text">没有可关联的暂存文件或文件夹；其他场景已关联的条目不会显示。</p> : null;
            })()}
            {(shelfFileOffset < shelfFileTotal || shelfFolderOffset < shelfFolderTotal) ? (
              <button type="button" className="btn sm" disabled={shelfLoading} onClick={() => void loadMoreShelf()}>
                {shelfLoading ? <Loader2 size={13} className="spin" aria-hidden="true" /> : null}
                {shelfLoading ? "加载中…" : "加载更多暂存条目"}
              </button>
            ) : null}
          </div>

          <div className="form-grid">
            <div className="form-field">
              <span className="form-label">关联工作现场</span>
              <Select ariaLabel="关联工作现场" value={draft.snapshotId || NO_ASSOCIATION} options={[{ value: NO_ASSOCIATION, label: "不关联" }, ...(snapshots ?? []).map((snapshot) => ({ value: snapshot.id, label: snapshot.name }))]}
                placeholder={snapshots ? "不关联现场" : "工作现场加载中…"} onChange={(snapshotId) => setDraft({ ...draft, snapshotId: snapshotId === NO_ASSOCIATION ? "" : snapshotId })} block />
            </div>
            <div className="form-field">
              <span className="form-label">关联工作流</span>
              <Select ariaLabel="关联工作流" value={draft.linkedWorkflowId || NO_ASSOCIATION} options={[{ value: NO_ASSOCIATION, label: "不关联" }, ...(workflows ?? []).map((workflow) => ({ value: workflow.id, label: workflow.name }))]}
                placeholder={workflows ? "不关联工作流" : "工作流加载中…"} onChange={(linkedWorkflowId) => setDraft({ ...draft, linkedWorkflowId: linkedWorkflowId === NO_ASSOCIATION ? "" : linkedWorkflowId })} block />
            </div>
          </div>
          <p className="scenario-shelf-note" role="note">复制场景不会转移已关联条目；删除场景只解除 ID 关联，不删除暂存架记录或真实文件。</p>
          {refError ? <p className="wf-error-text" role="status">{refError}</p> : null}
          {viewError || error ? <p className="wf-error-text" role="alert">{viewError ?? error}</p> : null}
          <div className="wf-editor-actions">
            <button type="button" className="btn" onClick={cancelEdit} disabled={saving}>取消</button>
            <button type="button" className="btn primary" onClick={() => void saveDraft()} disabled={saving || !draft.name.trim()}>
              {saving ? <Loader2 size={13} className="spin" aria-hidden="true" /> : null} 保存场景
            </button>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="scenario-workspace">
      <header className="scenario-head">
        <button type="button" className="icon-btn sm" aria-label="返回工作流列表" onClick={onBack}>
          <ArrowLeft size={14} aria-hidden="true" />
        </button>
        <div className="scenario-heading">
          <h2 className="wf-title">场景工作区</h2>
          <p className="wf-subtitle">把工作现场、应用、网页、文件夹和工作流组合成可重复进入的场景。</p>
        </div>
        <ContextHelpButton articleId="help.workflows.scenes" />
        <button type="button" className="btn primary" onClick={beginCreate}>
          <Plus size={14} aria-hidden="true" /> 新建场景
        </button>
      </header>

      <SearchField value={query} onChange={setQuery} ariaLabel="搜索场景" placeholder="搜索场景名称" className="scenario-search" />
      {error || viewError ? <p className="wf-error-text" role="alert">{viewError ?? error}</p> : null}
      {refError ? <p className="wf-error-text" role="status">{refError}</p> : null}
      {loading && !loaded ? <p className="wf-empty-steps"><Loader2 size={13} className="spin" aria-hidden="true" /> 加载场景…</p> : null}
      {loaded && summaries.length === 0 ? (
        <EmptyState
          framed
          title="还没有场景"
          hint="创建场景后，可以在工作流步骤中选择它。"
        />
      ) : null}
      {loaded && summaries.length > 0 && filtered.length === 0 ? <p className="wf-empty-steps">没有匹配的场景。</p> : null}

      <div className="planning-cards scenario-cards">
        {filtered.map((scene) => {
          const result = results[scene.id];
          const state = result ? resultState(result.items, progressByItem, result) : null;
          const summary = result ? stopSummary(result) : null;
          const entering = enteringId === scene.id;
          return (
            <article className="task-card planning-card scenario-card" key={scene.id}>
              <div className="scenario-card-head">
                <span className="scenario-icon" aria-hidden="true">{scene.icon || "◇"}</span>
                <div className="scenario-heading">
                  <h3 className="planning-card-title">{scene.name}</h3>
                  <p className="wf-card-desc">{scene.appCount} 个应用 · {scene.urlCount} 个网页 · {scene.folderCount} 个文件夹</p>
                </div>
                {state ? <span className={`scenario-status tone-${state.status}`} role="status">{state.label}</span> : null}
              </div>
              {result ? (
                <ol className="scenario-results" aria-label={`${scene.name} 进入结果`}>
                  {result.items.map((item, index) => {
                    const progress = item.kind === "snapshot" || item.kind === "workflow"
                      ? progressByItem[scenarioItemProgressKey(item.kind, item.label)]
                      : undefined;
                    const shown = itemPresentation(item, progress, result.cancelled === true);
                    return (
                      <li className={`scenario-result tone-${shown.status}`} key={`${item.kind}-${index}`}>
                        <span className="scenario-result-name">{item.kind} · {item.label}</span>
                        <span className="scenario-result-state">{shown.label}</span>
                        {shown.detail ? <span className="scenario-result-detail">{shown.detail}</span> : null}
                      </li>
                    );
                  })}
                </ol>
              ) : null}
              {summary ? <p className="wf-hint-text scenario-stop-summary" role="status">{summary}</p> : null}
              {entering ? <p className="wf-empty-steps" role="status"><Loader2 size={13} className="spin" aria-hidden="true" /> 正在进入场景…</p> : null}
              <div className="scenario-actions">
                <button type="button" className="btn primary sm" disabled={enteringId !== null || actionId !== null}
                  onClick={() => void perform(scene.id, () => enter(scene.id))}>
                  {entering ? <Loader2 size={13} className="spin" aria-hidden="true" /> : <Play size={13} aria-hidden="true" />} 进入
                </button>
                {entering ? (
                  <button type="button" className="btn sm" disabled={cancellingId !== null}
                    aria-label={`取消进入 ${scene.name}`}
                    onClick={() => void cancelEnter(scene.id)}>
                    取消
                  </button>
                ) : null}
                {/* 进入期间禁用全部卡片的编辑/复制/删除：避免改到正在进入的配置，
                    也避免删除在途场景（后端删除守卫同样会拒绝）。 */}
                <button type="button" className="icon-btn sm" aria-label={`编辑 ${scene.name}`} disabled={enteringId !== null || actionId !== null} onClick={() => void beginEdit(scene.id)}>
                  <Pencil size={13} aria-hidden="true" />
                </button>
                <button type="button" className="icon-btn sm" aria-label={`复制 ${scene.name}`} disabled={enteringId !== null || actionId !== null} onClick={() => void perform(scene.id, () => duplicate(scene.id))}>
                  <Copy size={13} aria-hidden="true" />
                </button>
                <button type="button" className="icon-btn sm" aria-label={`删除 ${scene.name}`} disabled={enteringId !== null || actionId !== null} onClick={() => setDeleteTarget(scene)}>
                  <Trash2 size={13} aria-hidden="true" />
                </button>
                <span className="flex-spacer" />
                {scene.lastEnteredAt ? <span className="scenario-last-entered">上次进入：{new Date(scene.lastEnteredAt).toLocaleString()}</span> : null}
              </div>
            </article>
          );
        })}
      </div>

      <ConfirmDialog open={deleteTarget !== null} danger title="删除场景？"
        detail={deleteTarget ? `将删除场景「${deleteTarget.name}」的配置。关联的工作现场、工作流、暂存架条目和真实文件不会被删除。` : undefined}
        confirmLabel="删除场景" onCancel={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (!deleteTarget) return;
          const target = deleteTarget;
          setDeleteTarget(null);
          void perform(target.id, () => remove(target.id));
        }} />
    </section>
  );
}
