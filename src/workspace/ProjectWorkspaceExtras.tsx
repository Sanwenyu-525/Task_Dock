//! 通用项目「进度」与「资源关联」：接入 v69 后端命令，不新建第二套笔记/会话存储。
//!
//! - 进度：只读 `workspace_project_progress`，事项与关联任务分开计算；没有数据时
//!   显示「暂无可计算进度」，不把 0 项包装成 0% 或 100%。
//! - 资源：笔记用 `notes_list` 选择既有笔记 ID，会话用现有 Agent 快照选择既有会话 ID，
//!   产物只登记绝对路径；解除只删关联，不删除目标。
//! - 归档项目：读取允许，新增/解除按后端 fail-closed 规则禁用。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link2, Loader2, RefreshCw, Unlink } from "lucide-react";

import Select from "../components/ui/Select";
import SearchField from "../components/ui/SearchField";
import { ConfirmDialog } from "../components/ui/Dialog";
import {
  notesList,
  workspaceProjectProgress,
  workspaceResourceList,
  workspaceResourceRemove,
  workspaceResourceSave,
  type AgentSession,
  type NoteSummary,
  type WorkspaceProjectProgress,
  type WorkspaceResourceKind,
  type WorkspaceResourceLink,
  type WorkspaceResourcePage,
} from "../lib/bridge";
import { errorMessage } from "../lib/errors";
import { formatLocalizedDateTime } from "../i18n/format";
import { useAgentsStore, scheduleAgentRefresh } from "../store/useAgentsStore";

const RESOURCE_PAGE_SIZE = 50;
const EMPTY_SESSIONS: AgentSession[] = [];

const KIND_LABEL: Record<WorkspaceResourceKind, string> = {
  note: "笔记",
  agent_session: "Agent 会话",
  artifact: "产物",
};

function pathName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function short(text: string, limit = 48): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

interface Notice {
  (message: string, kind?: "success" | "warning" | "error"): void;
}

// ── 项目进度 ──────────────────────────────────────────────────────────

export function ProjectProgressCard({
  projectId,
  archived,
}: {
  projectId: string | null;
  archived: boolean;
}) {
  const [progress, setProgress] = useState<WorkspaceProjectProgress | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generationRef = useRef(0);

  const load = useCallback(async () => {
    if (!projectId) {
      setProgress(null);
      setError(null);
      return;
    }
    const generation = ++generationRef.current;
    setLoading(true);
    try {
      const result = await workspaceProjectProgress(projectId);
      if (generation !== generationRef.current) return;
      setProgress(result);
      setError(null);
    } catch (e) {
      if (generation !== generationRef.current) return;
      // 保留旧数据并标出“可能过期”，不把错误伪装成 0 进度。
      setError(errorMessage(e));
    } finally {
      if (generation === generationRef.current) setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const itemsPercent = progress?.itemsPercent;
  const tasksPercent = progress?.linkedTasksPercent;

  return (
    <div className="ws-card ws-progress-card">
      <div className="ws-card-head">
        <h3>项目进度</h3>
        <span className="ws-card-actions">
          {loading && <Loader2 size={12} className="ws-spin" aria-hidden="true" />}
          <button
            type="button"
            className="ws-btn ws-btn-quiet"
            aria-label="刷新项目进度"
            data-tip="刷新项目进度"
            onClick={() => void load()}
            disabled={!projectId || loading}
          >
            <RefreshCw size={13} aria-hidden="true" />
          </button>
        </span>
      </div>
      {error && (
        <p className="ws-meta" data-tone="error" role="alert">
          {error}{progress ? "（以下为上一次读取结果，可能已过期）" : ""}
        </p>
      )}
      {!progress ? (
        <p className="ws-empty" role="status">{loading ? "正在读取进度…" : "暂无可计算进度"}</p>
      ) : (
        <div className="ws-progress-body">
          <div className="ws-progress-row">
            <span className="ws-progress-label">事项</span>
            <span className="ws-progress-value">
              {itemsPercent === null ? "暂无可计算进度" : `${itemsPercent}%`}
            </span>
            <div
              className="ws-progress-track"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={itemsPercent ?? undefined}
              aria-label="事项完成度"
            >
              <span style={{ width: `${itemsPercent ?? 0}%` }} />
            </div>
            <span className="ws-progress-sub">
              完成 {progress.itemsDone} · 待办 {progress.itemsTodo} · 进行 {progress.itemsDoing} · 受阻{" "}
              {progress.itemsBlocked} · 共 {progress.itemsTotal} 项
              {progress.itemsArchived > 0 ? `（归档 ${progress.itemsArchived} 项不计入分母）` : ""}
            </span>
          </div>
          <div className="ws-progress-row">
            <span className="ws-progress-label">关联任务</span>
            <span className="ws-progress-value">
              {tasksPercent === null ? "暂无可计算进度" : `${tasksPercent}%`}
            </span>
            <div
              className="ws-progress-track"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={tasksPercent ?? undefined}
              aria-label="关联任务完成度"
            >
              <span style={{ width: `${tasksPercent ?? 0}%` }} />
            </div>
            <span className="ws-progress-sub">
              已完成 {progress.linkedTasksCompleted} / 共 {progress.linkedTasksTotal} 个关联任务
            </span>
          </div>
          {archived && <p className="ws-meta">项目已归档：进度只读。</p>}
        </div>
      )}
    </div>
  );
}

// ── 项目资源 ──────────────────────────────────────────────────────────

export function ProjectResourcesCard({
  projectId,
  archived,
  onNotice,
}: {
  projectId: string | null;
  archived: boolean;
  onNotice?: Notice;
}) {
  const [filter, setFilter] = useState<WorkspaceResourceKind | "all">("all");
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<WorkspaceResourcePage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generationRef = useRef(0);

  const [addKind, setAddKind] = useState<WorkspaceResourceKind>("note");
  const [noteQuery, setNoteQuery] = useState("");
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [notesLoading, setNotesLoading] = useState(false);
  const [noteId, setNoteId] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [artifactPath, setArtifactPath] = useState("");
  const [artifactLabel, setArtifactLabel] = useState("");
  const [saving, setSaving] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<WorkspaceResourceLink | null>(null);

  const sessions = useAgentsStore((state) => state.snapshot?.sessions ?? EMPTY_SESSIONS);

  const reload = useCallback(
    async (nextOffset: number, kind: WorkspaceResourceKind | "all") => {
      if (!projectId) {
        setPage(null);
        setError(null);
        return;
      }
      const generation = ++generationRef.current;
      setLoading(true);
      try {
        const result = await workspaceResourceList(
          projectId,
          kind === "all" ? null : kind,
          nextOffset,
          RESOURCE_PAGE_SIZE,
        );
        if (generation !== generationRef.current) return;
        setPage(result);
        setError(null);
      } catch (e) {
        if (generation !== generationRef.current) return;
        // 保留旧列表并标注可能过期，不清空用户可见数据。
        setError(errorMessage(e));
      } finally {
        if (generation === generationRef.current) setLoading(false);
      }
    },
    [projectId],
  );

  useEffect(() => {
    void reload(offset, filter);
  }, [offset, filter, reload]);

  // 切项目：重置分页与筛选，避免把上一个项目的页码带过去。
  useEffect(() => {
    setOffset(0);
    setPage(null);
    setError(null);
    setNoteId("");
    setSessionId("");
    setArtifactPath("");
    setArtifactLabel("");
    setRemoveTarget(null);
  }, [projectId]);

  useEffect(() => {
    if (addKind !== "note") return;
    let cancelled = false;
    const timer = setTimeout(() => {
      setNotesLoading(true);
      void notesList({ query: noteQuery.trim() || null, limit: 20, offset: 0 })
        .then((items) => {
          if (!cancelled) setNotes(items);
        })
        .catch(() => {
          if (!cancelled) setNotes([]);
        })
        .finally(() => {
          if (!cancelled) setNotesLoading(false);
        });
    }, 220);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [addKind, noteQuery]);

  useEffect(() => {
    if (addKind !== "agent_session") return;
    // 只读取现有快照，不启动/发送任何 Agent 会话。
    scheduleAgentRefresh("normal");
  }, [addKind]);

  const pageItems = page?.links ?? [];
  const total = page?.total ?? 0;

  const noteOptions = useMemo(
    () =>
      notes.map((note) => ({
        value: note.id,
        label: short(note.title || note.excerpt || note.id, 40),
      })),
    [notes],
  );

  const sessionOptions = useMemo(
    () =>
      sessions.slice(0, 200).map((session) => ({
        value: session.id,
        label: short(`[${session.source_id}] ${session.title || session.external_id}（${session.status}）`, 48),
      })),
    [sessions],
  );

  const add = async () => {
    if (!projectId || archived || saving) return;
    let kind: WorkspaceResourceKind = addKind;
    let target = "";
    let label = "";
    if (addKind === "note") {
      const note = notes.find((item) => item.id === noteId);
      if (!note) {
        onNotice?.("请先选择一个笔记", "warning");
        return;
      }
      target = note.id;
      label = note.title || short(note.excerpt, 40) || note.id;
    } else if (addKind === "agent_session") {
      const session = sessions.find((item) => item.id === sessionId);
      if (!session) {
        onNotice?.("请先选择一个 Agent 会话", "warning");
        return;
      }
      target = session.id;
      label = `[${session.source_id}] ${session.title || session.external_id}`;
    } else {
      target = artifactPath.trim();
      if (!target) {
        onNotice?.("请填写产物绝对路径", "warning");
        return;
      }
      kind = "artifact";
      label = artifactLabel.trim() || pathName(target);
    }
    setSaving(true);
    try {
      await workspaceResourceSave({ projectId, kind, target, label, note: "" });
      onNotice?.("已登记项目资源", "success");
      setNoteId("");
      setSessionId("");
      setArtifactPath("");
      setArtifactLabel("");
      setOffset(0);
      await reload(0, filter);
    } catch (e) {
      onNotice?.(errorMessage(e), "error");
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!projectId || !removeTarget || archived) return;
    const target = removeTarget;
    setRemoveTarget(null);
    try {
      await workspaceResourceRemove(projectId, target.id);
      onNotice?.("已解除关联（目标本身未删除）", "success");
      const nextOffset = pageItems.length === 1 && offset > 0 ? Math.max(0, offset - RESOURCE_PAGE_SIZE) : offset;
      setOffset(nextOffset);
      await reload(nextOffset, filter);
    } catch (e) {
      onNotice?.(errorMessage(e), "error");
    }
  };

  if (!projectId) {
    return null;
  }

  return (
    <div className="ws-card ws-resources-card">
      <div className="ws-card-head">
        <h3>项目资源</h3>
        <span className="ws-meta">只登记关联，原内容仍由原模块/目录持有</span>
      </div>
      {error && (
        <p className="ws-meta" data-tone="error" role="alert">
          {error}{page ? "（列表为上一次读取结果，可能已过期）" : ""}
        </p>
      )}
      {archived && <p className="ws-meta">项目已归档：资源只读，不能新增或解除关联。</p>}

      {/* 添加 */}
      {!archived && (
        <div className="ws-resource-add">
          <Select
            ariaLabel="资源类型"
            size="sm"
            value={addKind}
            options={[
              { value: "note", label: "笔记" },
              { value: "agent_session", label: "Agent 会话" },
              { value: "artifact", label: "产物路径" },
            ]}
            onChange={(value) => {
              setAddKind(value as WorkspaceResourceKind);
              setNoteId("");
              setSessionId("");
            }}
          />
          {addKind === "note" && (
            <>
              <SearchField
                value={noteQuery}
                onChange={setNoteQuery}
                ariaLabel="搜索笔记"
                placeholder="搜索现有笔记…"
                size="compact"
              />
              <Select
                ariaLabel="选择笔记"
                size="sm"
                value={noteId}
                options={[
                  { value: "", label: notesLoading ? "读取笔记…" : noteOptions.length ? "选择笔记…" : "没有可用笔记" },
                  ...noteOptions,
                ]}
                onChange={setNoteId}
              />
            </>
          )}
          {addKind === "agent_session" && (
            <Select
              ariaLabel="选择 Agent 会话"
              size="sm"
              value={sessionId}
              options={[
                { value: "", label: sessionOptions.length ? "选择会话…" : "暂无本地会话快照" },
                ...sessionOptions,
              ]}
              onChange={setSessionId}
            />
          )}
          {addKind === "artifact" && (
            <>
              <input
                className="ws-input ws-resource-path"
                value={artifactPath}
                placeholder="D:\产物\报告.pdf（只登记路径）"
                aria-label="产物绝对路径"
                onChange={(e) => setArtifactPath(e.target.value)}
              />
              <input
                className="ws-input ws-resource-label"
                value={artifactLabel}
                placeholder="显示名称（可选）"
                aria-label="产物显示名称"
                onChange={(e) => setArtifactLabel(e.target.value)}
              />
            </>
          )}
          <button type="button" className="ws-btn ws-btn-primary" disabled={saving} onClick={() => void add()}>
            {saving ? <Loader2 size={13} className="ws-spin" aria-hidden="true" /> : <Link2 size={13} aria-hidden="true" />}
            关联
          </button>
        </div>
      )}

      {/* 筛选与分页 */}
      <div className="ws-resource-toolbar">
        <Select
          ariaLabel="筛选资源类型"
          size="sm"
          value={filter}
          options={[
            { value: "all", label: "全部类型" },
            { value: "note", label: "笔记" },
            { value: "agent_session", label: "Agent 会话" },
            { value: "artifact", label: "产物" },
          ]}
          onChange={(value) => {
            setFilter(value as WorkspaceResourceKind | "all");
            setOffset(0);
          }}
        />
        <span className="ws-meta">
          {loading ? "读取中…" : `共 ${total} 条`}
          {page && total > RESOURCE_PAGE_SIZE ? ` · 第 ${Math.floor(offset / RESOURCE_PAGE_SIZE) + 1} 页` : ""}
        </span>
        <span className="ws-resource-pager">
          <button
            type="button"
            className="ws-btn ws-btn-quiet"
            disabled={loading || offset === 0}
            onClick={() => setOffset(Math.max(0, offset - RESOURCE_PAGE_SIZE))}
          >
            上一页
          </button>
          <button
            type="button"
            className="ws-btn ws-btn-quiet"
            disabled={loading || !page?.hasMore}
            onClick={() => setOffset(offset + RESOURCE_PAGE_SIZE)}
          >
            下一页
          </button>
        </span>
      </div>

      {pageItems.length === 0 ? (
        <p className="ws-empty" role="status">{loading ? "正在读取资源关联…" : "还没有登记项目资源"}</p>
      ) : (
        <ul className="ws-resource-list">
          {pageItems.map((link) => (
            <li key={link.id} className={`ws-resource-row${link.targetExists ? "" : " is-missing"}`}>
              <span className={`ws-resource-kind is-${link.kind}`}>{KIND_LABEL[link.kind]}</span>
              <span className="ws-resource-main">
                <span className="ws-resource-label" title={link.label}>{link.label}</span>
                <span className="ws-resource-target" title={link.target}>{short(link.target, 72)}</span>
              </span>
              {!link.targetExists && (
                <span className="ws-resource-missing" data-tip="目标当前不可用；关联仍保留">
                  当前不可用
                </span>
              )}
              <span className="ws-resource-time">{formatLocalizedDateTime(link.updatedAt)}</span>
              <button
                type="button"
                className="ws-btn ws-btn-quiet"
                aria-label={`解除与 ${link.label} 的关联`}
                data-tip="解除关联（不删除目标）"
                disabled={archived}
                onClick={() => setRemoveTarget(link)}
              >
                <Unlink size={13} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={Boolean(removeTarget)}
        title="解除资源关联？"
        detail={`将解除「${removeTarget?.label ?? ""}」与当前项目的关联；目标笔记/会话/产物本身不会被删除。`}
        confirmLabel="解除关联"
        onCancel={() => setRemoveTarget(null)}
        onConfirm={() => void remove()}
      />
    </div>
  );
}
