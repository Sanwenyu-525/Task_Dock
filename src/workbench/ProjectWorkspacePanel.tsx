//! 项目工作空间内容面板（U0）：从旧 `WorkspaceApp` 迁移出的**内容区**。
//!
//! 与旧实现的差异（架构收敛，不是重写业务）：
//! - 不再自带窗口顶栏与项目列表侧栏：全局导航、项目选择器、右栏都由
//!   `WorkbenchShell` 统一提供，避免出现第二套导航外壳；
//! - 「在开发工作台打开」不再跨窗口请求主窗口：同一个工作台窗口内直接写
//!   `workbench_current_project` 并切到开发工作台路由，结果由 shell 的导航门禁返回；
//! - 项目 CRUD 仍走原有 `workspace_project_*` 命令；删除后由 shell 选择回退项目。
//!
//! 数据一致性约束保持不变：切换项目立即清空并只接受当前代次结果（数据层
//! `useWorkspaceProjectContext` + `scopeWorkspaceContext`），写操作以点击时的项目
//! 为目标，切走后不写入新项目。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { openPath as openSystemPath } from "@tauri-apps/plugin-opener";
import {
  AlertCircle,
  ArrowUpRight,
  CheckCircle2,
  FolderOpen,
  GitBranch,
  Link2,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";

import Select from "../components/ui/Select";
import {
  agentSnapshot,
  workspaceProjectDelete,
  workspaceProjectSave,
  workspaceProjectSetStatus,
  type DevProject,
  type WorkspaceKind,
  type WorkspaceProject,
  type WorkspaceTaskLink,
} from "../lib/bridge";
import { errorMessage } from "../lib/errors";
import {
  useWorkspaceDevContext,
  useWorkspaceProjectContext,
  useWorkspaceTaskPicker,
  type TaskPickerStatus,
} from "../workspace/useWorkspaceProjectContext";
import { scopeWorkspaceContext } from "../workspace/workspaceContextScope";
import {
  CAPABILITY_STATE_LABEL,
  WORKSPACE_CAPABILITIES,
  WORKSPACE_PROFILES,
  canInvokeCapability,
  resolveModuleOrder,
  resolveWorkspaceProfile,
  type WorkspaceCard,
  type WorkspaceModuleId,
  type WorkspaceProfile,
} from "../workspace/workspaceProfiles";

const KIND_OPTIONS: { value: WorkspaceKind; label: string }[] = (
  Object.values(WORKSPACE_PROFILES) as WorkspaceProfile[]
).map((p) => ({ value: p.kind, label: p.label }));

const ITEM_STATUS_LABEL: Record<string, string> = {
  todo: "待办",
  doing: "进行中",
  blocked: "受阻",
  done: "完成",
  archived: "归档",
};

const STAGE_HINT: Record<WorkspaceKind, string> = {
  development: "阶段（如 api / ui / 联调）",
  game: "阶段（如 关卡 / 系统 / 美术）",
  ai_comic: "阶段（episode 或 shot）",
  general: "阶段（可空）",
};

export type ProjectPanelNoticeKind = "ok" | "error" | "info";
export type ProjectPanelNavResult = "switched" | "pending" | "blocked";

interface AgentSummary {
  running: number;
  waiting: number;
  failed: number;
  truncated: boolean;
  at: string;
}

export interface ProjectWorkspacePanelProps {
  project: WorkspaceProject | null;
  devProjects: DevProject[];
  /** 重新读取项目列表（创建/保存/归档/删除后由 shell 统一持有列表）。 */
  onProjectsChanged: () => Promise<WorkspaceProject[]>;
  /** 选择项目（null = 无项目）。 */
  onSelectProject: (id: string | null) => void;
  onRefreshDevProjects: () => Promise<void>;
  /** 切到开发工作台路由；返回值来自 shell 的导航门禁。 */
  onNavigateWorkbench: () => ProjectPanelNavResult;
  /** 打开开发工作台事务（项目上下文提交/回滚由 shell 统一处理）。 */
  onOpenDevWorkbench: (devProjectId: string) => void;
  /** 打开「新建项目」弹层（唯一实现在 shell）。 */
  onCreateProject: () => void;
  /** 外部请求切到某模块（如右栏「项目设置」）；token 变化触发一次。 */
  moduleRequest?: { token: number; module: WorkspaceModuleId } | null;
  onNotice: (kind: ProjectPanelNoticeKind, text: string) => void;
}

export default function ProjectWorkspacePanel({
  project,
  devProjects,
  onProjectsChanged,
  onSelectProject,
  onRefreshDevProjects,
  onNavigateWorkbench,
  onOpenDevWorkbench,
  onCreateProject,
  moduleRequest = null,
  onNotice,
}: ProjectWorkspacePanelProps) {
  const selectedId = project?.id ?? null;
  const profile = useMemo(() => resolveWorkspaceProfile(project?.kind), [project?.kind]);
  const context = useWorkspaceProjectContext(selectedId, profile);
  // 首渲染隔离：项目切换那一帧不渲染上一个项目的数据。
  const ctx = scopeWorkspaceContext(context, selectedId, profile);
  const devContext = useWorkspaceDevContext(project?.devProjectId ?? null);

  const [localModule, setLocalModule] = useState<WorkspaceModuleId | null>(null);
  const [moduleSaveFailed, setModuleSaveFailed] = useState(false);
  const [newItemTitle, setNewItemTitle] = useState("");
  const [newItemStage, setNewItemStage] = useState("");
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [editKind, setEditKind] = useState<WorkspaceKind>("general");
  const [editRoot, setEditRoot] = useState("");
  const [editDev, setEditDev] = useState("");
  const [editNote, setEditNote] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [agents, setAgents] = useState<AgentSummary | null>(null);
  const [agentLoading, setAgentLoading] = useState(false);
  const [agentError, setAgentError] = useState<string | null>(null);

  const mountedRef = useRef(true);
  const selectedIdRef = useRef<string | null>(selectedId);
  selectedIdRef.current = selectedId;
  /** 模块点击序号：异步保存完成后只让最后一次点击更新本地状态。 */
  const moduleClickSeqRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const modules = useMemo(
    () => resolveModuleOrder(profile, ctx.layout),
    [profile, ctx.layout],
  );
  const activeModule: WorkspaceModuleId = useMemo(() => {
    const requested = localModule ?? ctx.layout.activeModule;
    return modules.some((m) => m.id === requested) ? requested : modules[0]?.id ?? "overview";
  }, [localModule, ctx.layout.activeModule, modules]);

  const picker = useWorkspaceTaskPicker(
    activeModule === "links" && Boolean(selectedId),
    ctx.links.map((l) => l.taskId),
  );

  // 项目切换：清空模块覆盖与一次性交互状态（旧项目的编辑表单不得套到新项目）。
  useEffect(() => {
    setLocalModule(null);
    setModuleSaveFailed(false);
    setEditing(false);
    setConfirmDelete(false);
    setNewItemTitle("");
    setNewItemStage("");
  }, [selectedId]);

  const loadAgents = useCallback(async () => {
    setAgentLoading(true);
    setAgentError(null);
    try {
      const snap = await agentSnapshot();
      if (!mountedRef.current) return;
      const sums = snap.live_summary;
      setAgents({
        running: sums?.running ?? snap.runs.filter((r) => r.status === "running").length,
        waiting: sums?.waiting ?? snap.sessions.filter((s) => s.status === "waiting").length,
        failed: sums?.failed ?? snap.runs.filter((r) => r.status === "failed").length,
        truncated: Boolean(sums?.sessions_truncated || sums?.runs_truncated),
        at: new Date().toLocaleTimeString(),
      });
    } catch (e) {
      if (mountedRef.current) setAgentError(errorMessage(e));
    } finally {
      if (mountedRef.current) setAgentLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAgents();
  }, [loadAgents]);

  // 数据层提示「写入已落到上一个项目」时如实转达。
  useEffect(() => {
    if (!ctx.lastStaleNotice) return;
    onNotice("info", ctx.lastStaleNotice);
    ctx.clearStaleNotice();
  }, [ctx.lastStaleNotice, ctx, onNotice]);

  const switchModule = useCallback(
    async (m: WorkspaceModuleId) => {
      const seq = moduleClickSeqRef.current + 1;
      moduleClickSeqRef.current = seq;
      setLocalModule(m);
      const result = await context.saveModule(m);
      if (moduleClickSeqRef.current !== seq) return;
      if (result === "failed") {
        setModuleSaveFailed(true);
        onNotice("error", "模块位置未保存：下次打开会回到上次成功保存的模块");
      } else if (result === "stale") {
        setModuleSaveFailed(false);
      } else {
        setModuleSaveFailed(false);
        setLocalModule(null);
      }
    },
    [context, onNotice],
  );

  const switchModuleRef = useRef(switchModule);
  switchModuleRef.current = switchModule;

  // 外部模块定位（如右栏「项目设置」）：只认 token 变化，避免 layout 变化
  // 反复把用户手动切换的模块重置回请求值。
  const moduleRequestToken = moduleRequest?.token ?? 0;
  useEffect(() => {
    if (!moduleRequest) return;
    if (!modules.some((m) => m.id === moduleRequest.module)) return;
    void switchModuleRef.current(moduleRequest.module);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在 token 变化时消费一次
  }, [moduleRequestToken]);

  const addItem = useCallback(async () => {
    if (!selectedId) return;
    const title = newItemTitle.trim();
    if (!title) {
      onNotice("error", "事项标题不能为空");
      return;
    }
    const result = await context.addItem({ title, stage: newItemStage });
    if (result === "ok") {
      setNewItemTitle("");
      setNewItemStage("");
    } else if (result === "failed") {
      onNotice("error", "添加事项失败，内容仍保留在输入框");
    } else {
      onNotice("info", "项目已切换，本次输入未提交");
    }
  }, [selectedId, newItemTitle, newItemStage, context, onNotice]);

  const cycleItemStatus = useCallback(
    async (item: Parameters<typeof context.cycleItemStatus>[0]) => {
      const result = await context.cycleItemStatus(item);
      if (result === "failed") onNotice("error", "修改事项状态失败");
      if (result === "stale") onNotice("info", "项目已切换，本次操作未提交");
    },
    [context, onNotice],
  );

  const removeItem = useCallback(
    async (item: Parameters<typeof context.removeItem>[0]) => {
      const result = await context.removeItem(item);
      if (result === "failed") onNotice("error", "删除事项失败");
      if (result === "stale") onNotice("info", "项目已切换，本次操作未提交");
    },
    [context, onNotice],
  );

  const addTaskLink = useCallback(
    async (taskId: string) => {
      const result = await context.addTaskLink(taskId);
      if (result === "failed") onNotice("error", "关联任务失败");
      if (result === "stale") onNotice("info", "项目已切换，本次关联未提交");
    },
    [context, onNotice],
  );

  const removeTaskLink = useCallback(
    async (taskId: string) => {
      const result = await context.removeTaskLink(taskId);
      if (result === "failed") onNotice("error", "取消关联失败");
      if (result === "stale") onNotice("info", "项目已切换，本次关联未提交");
    },
    [context, onNotice],
  );

  const openFolder = useCallback(
    async (path: string) => {
      if (!path) return;
      try {
        await openSystemPath(path);
      } catch (e) {
        onNotice("error", `打开目录失败：${errorMessage(e)}`);
      }
    },
    [onNotice],
  );

  const openDevWorkbench = useCallback(() => {
    if (!project) return;
    if (!project.devProjectId) {
      onNotice("error", "该项目未关联开发项目；请先在项目设置里关联");
      return;
    }
    // 上下文提交与导航在同一事务里由 shell 处理：取消/失败不改变当前开发项目。
    onOpenDevWorkbench(project.devProjectId);
  }, [project, onOpenDevWorkbench, onNotice]);

  const saveEdit = useCallback(async () => {
    if (!project) return;
    const targetId = project.id;
    setBusy(true);
    try {
      await workspaceProjectSave({
        id: targetId,
        name: editName.trim() || project.name,
        kind: editKind,
        rootPath: editRoot.trim() || null,
        devProjectId: editDev.trim() || null,
        note: editNote.trim() || null,
      });
      await onProjectsChanged();
      if (selectedIdRef.current !== targetId) {
        onNotice("info", "上一项目的修改已保存；当前已切换到其他项目");
        return;
      }
      setEditing(false);
      await context.reload();
      onNotice("ok", "项目信息已保存");
    } catch (e) {
      onNotice("error", `保存项目失败：${errorMessage(e)}`);
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, [project, editName, editKind, editRoot, editDev, editNote, onProjectsChanged, context, onNotice]);

  const archiveToggle = useCallback(async () => {
    if (!project) return;
    const next = project.status === "archived" ? "active" : "archived";
    try {
      await workspaceProjectSetStatus(project.id, next);
      await onProjectsChanged();
      onNotice("ok", next === "archived" ? "已归档（数据与外部文件不受影响）" : "已恢复为进行中");
    } catch (e) {
      onNotice("error", `${next === "archived" ? "归档" : "恢复"}失败：${errorMessage(e)}`);
    }
  }, [project, onProjectsChanged, onNotice]);

  const deleteProject = useCallback(async () => {
    if (!project) return;
    setBusy(true);
    try {
      await workspaceProjectDelete(project.id);
      const list = await onProjectsChanged();
      onSelectProject(list[0]?.id ?? null);
      setConfirmDelete(false);
      setEditing(false);
      onNotice("ok", "已删除工作空间登记；外部文件与关联任务未受影响");
    } catch (e) {
      onNotice("error", `删除登记失败：${errorMessage(e)}`);
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, [project, onProjectsChanged, onSelectProject, onNotice]);

  const startEdit = useCallback(() => {
    if (!project) return;
    setEditName(project.name);
    setEditKind(project.kind);
    setEditRoot(project.rootPath);
    setEditDev(project.devProjectId ?? "");
    setEditNote(project.note);
    setEditing(true);
    setConfirmDelete(false);
  }, [project]);

  const gitSummary = useMemo(() => {
    const probe = devContext.probe;
    if (!project?.devProjectId) return { tone: "muted" as const, text: "未关联开发项目" };
    if (!devContext.devProject) {
      return {
        tone: "error" as const,
        text: devContext.reason ?? (devContext.error ? `读取失败：${devContext.error}` : "正在读取开发项目…"),
      };
    }
    if (!probe) {
      return {
        tone: "muted" as const,
        text: devContext.status === "loading" ? "正在探测 Git…" : devContext.reason ?? "未获取到 Git 摘要",
      };
    }
    switch (probe.status) {
      case "ok": {
        const parts = [
          probe.detached ? "detached HEAD" : `分支 ${probe.branch ?? "（未知）"}`,
          probe.dirtyCount === null ? "未提交变更数未统计" : `未提交 ${probe.dirtyCount}`,
        ];
        if (probe.isWorktree) parts.push("worktree");
        return { tone: "ok" as const, text: parts.join(" · ") };
      }
      case "not_a_repo":
        return { tone: "warn" as const, text: "开发项目根目录不是 Git 仓库（请检查登记的路径）" };
      case "git_unavailable":
        return { tone: "warn" as const, text: "未检测到可用的 Git 命令" };
      case "path_missing":
        return { tone: "error" as const, text: "开发项目根目录不存在" };
      default:
        return { tone: "muted" as const, text: `未知状态：${String(probe.status)}` };
    }
  }, [project?.devProjectId, devContext]);

  const itemCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const it of ctx.items) counts[it.status] = (counts[it.status] ?? 0) + 1;
    return counts;
  }, [ctx.items]);

  const cardBody = (card: WorkspaceCard) => {
    const cap = WORKSPACE_CAPABILITIES[card.capability];
    const usable = canInvokeCapability(profile.kind, card.capability);
    if (!usable) {
      return (
        <div className="ws-state" data-tone="muted">
          <span className="ws-badge">{CAPABILITY_STATE_LABEL[cap.state]}</span>
          <span>{cap.fallback ?? "该能力当前不可用"}</span>
        </div>
      );
    }
    switch (card.body) {
      case "project":
        if (!project) return null;
        return (
          <>
            <div className="ws-row"><span>类型</span><strong>{profile.label}</strong></div>
            <div className="ws-row"><span>状态</span><strong>{project.status === "archived" ? "已归档" : "进行中"}</strong></div>
            <div className="ws-row"><span>事项</span><strong>{ctx.items.length}</strong></div>
            <div className="ws-row"><span>关联任务</span><strong>{ctx.links.length}</strong></div>
            <div className="ws-row">
              <span>工作目录</span>
              <span className="ws-path">{project.rootPath || "未设置"}</span>
              {project.rootPath && project.rootExists && (
                <button className="ws-btn" onClick={() => void openFolder(project.rootPath)}>
                  <FolderOpen size={12} /> 打开
                </button>
              )}
            </div>
            {project.rootPath && !project.rootExists && (
              <div className="ws-state" data-tone="error">工作目录不存在（登记仍保留，可重新指定路径）</div>
            )}
          </>
        );
      case "items":
        return (
          <>
            {ctx.items.length === 0 && <div className="ws-empty">暂无事项</div>}
            {ctx.items.slice(0, 6).map((it) => (
              <div key={it.id} className="ws-row">
                <span className="ws-flex">{it.title}</span>
                {it.stage && <span className="ws-badge">{it.stage}</span>}
                <span className="ws-badge">{ITEM_STATUS_LABEL[it.status] ?? it.status}</span>
              </div>
            ))}
            {ctx.items.length > 0 && (
              <div className="ws-meta">
                {Object.entries(itemCounts).map(([k, v]) => `${ITEM_STATUS_LABEL[k] ?? k} ${v}`).join(" · ")}
              </div>
            )}
          </>
        );
      case "links":
        return (
          <>
            {ctx.links.length === 0 && <div className="ws-empty">暂无关联任务</div>}
            {ctx.links.slice(0, 6).map((l) => (
              <div key={l.taskId} className="ws-row">
                <span className="ws-flex">{l.title}</span>
                <span className="ws-badge">{l.status}</span>
              </div>
            ))}
            {ctx.links.length > 6 && <div className="ws-meta">共 {ctx.links.length} 条关联</div>}
          </>
        );
      case "devProject":
        if (!project?.devProjectId) {
          return (
            <div className="ws-state" data-tone="muted">
              <span>未关联开发项目</span>
              <button className="ws-btn" onClick={() => void switchModule("settings")}>去关联</button>
            </div>
          );
        }
        return (
          <>
            <div className="ws-row">
              <span>名称</span>
              <strong>{devContext.devProject?.name ?? project.devProjectName ?? "（已失效）"}</strong>
            </div>
            <div className="ws-row">
              <span>开发仓库</span>
              <span className="ws-path">{devContext.devProject?.rootPath ?? "—"}</span>
            </div>
            {devContext.status === "missing" && (
              <div className="ws-state" data-tone="error">{devContext.reason}</div>
            )}
            {devContext.status === "error" && (
              <div className="ws-state" data-tone="error">读取开发项目失败：{devContext.error}</div>
            )}
            {devContext.devProject && !devContext.devProject.exists && (
              <div className="ws-state" data-tone="error">开发项目根目录不存在</div>
            )}
            <div className="ws-dev-actions">
              <button className="ws-btn ws-btn-primary" onClick={() => void openDevWorkbench()}>
                <GitBranch size={12} /> 在开发工作台打开
              </button>
              {devContext.status === "ready" && (
                <button className="ws-btn" onClick={() => void devContext.refresh()}>
                  <RefreshCw size={12} /> 重新探测
                </button>
              )}
            </div>
          </>
        );
      case "git":
        return (
          <>
            <div className="ws-state" data-tone={gitSummary.tone}>{gitSummary.text}</div>
            {devContext.probe?.status === "ok" && (
              <div className="ws-meta">
                {devContext.probe.headSha ? `HEAD ${devContext.probe.headSha.slice(0, 8)} · ` : ""}
                探测于 {new Date(devContext.probe.probedAt).toLocaleTimeString()}
                {devContext.devProject ? ` · ${devContext.devProject.rootPath}` : ""}
              </div>
            )}
          </>
        );
      case "agents":
        return (
          <>
            {agentLoading && (
              <div className="ws-state" data-tone="muted"><Loader2 size={12} className="ws-spin" /> 正在读取 Agent 实时快照…</div>
            )}
            {agentError && <div className="ws-state" data-tone="error">读取失败：{agentError}</div>}
            {agents && !agentLoading && (
              <>
                <div className="ws-agent-grid">
                  <div><strong>{agents.running}</strong><span>运行中</span></div>
                  <div><strong>{agents.waiting}</strong><span>等待</span></div>
                  <div><strong>{agents.failed}</strong><span>失败</span></div>
                </div>
                <div className="ws-meta">
                  来源：AgentHub 实时快照（只读）· {agents.at}
                  {agents.truncated ? " · 明细已截断，计数为全量" : ""}
                </div>
              </>
            )}
            <button className="ws-btn" onClick={() => void loadAgents()} disabled={agentLoading}>
              <RefreshCw size={12} /> 刷新
            </button>
          </>
        );
      case "acceptance":
        return (
          <>
            <div className="ws-state" data-tone="muted">{cap.fallback}</div>
            <button className="ws-btn" onClick={() => onNavigateWorkbench()}>
              <ArrowUpRight size={12} /> 去开发工作台验收
            </button>
          </>
        );
      case "progress": {
        const episodes = ctx.items.filter((it) => it.stage.toLowerCase() === "episode");
        const shots = ctx.items.filter((it) => it.stage.toLowerCase() === "shot");
        return (
          <>
            <div className="ws-row"><span>剧集（stage=episode）</span><strong>{episodes.length}</strong></div>
            <div className="ws-row"><span>镜头（stage=shot）</span><strong>{shots.length}</strong></div>
            {shots.length === 0 && episodes.length === 0 && (
              <div className="ws-empty">在「剧集与镜头」里用阶段 episode / shot 建条目</div>
            )}
            {shots.slice(0, 6).map((it) => (
              <div key={it.id} className="ws-row">
                <span className="ws-flex">{it.title}</span>
                <span className="ws-badge">{ITEM_STATUS_LABEL[it.status] ?? it.status}</span>
              </div>
            ))}
            <div className="ws-meta">{cap.fallback}</div>
          </>
        );
      }
      case "build":
      case "assets":
      case "characters":
      case "generate":
      default:
        return (
          <div className="ws-state" data-tone="muted">
            <span className="ws-badge">{CAPABILITY_STATE_LABEL[cap.state]}</span>
            <span>{cap.fallback ?? "未接入"}</span>
          </div>
        );
    }
  };

  if (!project) {
    return (
      <section className="wb-project wb-project-empty" aria-label="项目工作空间">
        <div className="ws-placeholder">
          <h2>项目工作空间</h2>
          <p>任务、Agent、收集与暂存、剪贴板、开发工作台都不需要项目即可使用。</p>
          <p>项目只用于组织专业模块（开发 / 游戏 / AI 漫剧 / 通用）。</p>
          <button className="ws-btn ws-btn-primary" onClick={onCreateProject}>
            <Plus size={12} /> 新建项目
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="wb-project" aria-label="项目工作空间" aria-busy={ctx.status === "loading"}>
      {project.status === "archived" && (
        <div className="ws-notice" data-tone="info">
          该项目已归档，事项与关联仍可查看；恢复为进行中后可继续日常使用。
        </div>
      )}
      {ctx.error && (
        <div className="ws-notice" data-tone="error" role="alert">
          <AlertCircle size={13} />
          <span>读取项目数据失败：{ctx.error}</span>
          <button className="ws-btn" onClick={() => void context.reload()}>重试</button>
        </div>
      )}

      <div className="ws-tabs" role="tablist" aria-label="工作空间模块">
        {modules.map((m) => (
          <button
            key={m.id}
            role="tab"
            aria-selected={activeModule === m.id}
            className={`ws-tab ${activeModule === m.id ? "is-active" : ""}`}
            onClick={() => void switchModule(m.id)}
          >
            {m.label}
          </button>
        ))}
        {ctx.status === "loading" && (
          <span className="ws-tab-loading"><Loader2 size={12} className="ws-spin" /> 加载中</span>
        )}
      </div>
      {moduleSaveFailed && (
        <div className="ws-meta" data-tone="warn">当前模块位置未保存成功（仅影响下次打开时的默认模块）</div>
      )}

      {activeModule === "overview" && (
        <div className="ws-grid">
          {profile.homeCards.map((card) => {
            const cap = WORKSPACE_CAPABILITIES[card.capability];
            return (
              <section className="ws-card" key={card.id} aria-label={card.title}>
                <header className="ws-card-head">
                  <h3>{card.title}</h3>
                  <span className={`ws-badge ws-badge-${cap.state}`}>{CAPABILITY_STATE_LABEL[cap.state]}</span>
                </header>
                {ctx.status === "loading" && card.body !== "agents" && card.body !== "git" ? (
                  <div className="ws-state" data-tone="muted">
                    <Loader2 size={12} className="ws-spin" /> 正在加载…
                  </div>
                ) : (
                  cardBody(card)
                )}
              </section>
            );
          })}
        </div>
      )}

      {activeModule === "items" && (
        <div>
          <div className="ws-form-row">
            <input
              className="ws-input ws-flex-2"
              placeholder="事项标题"
              value={newItemTitle}
              onChange={(e) => setNewItemTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void addItem();
              }}
            />
            <input
              className="ws-input"
              placeholder={STAGE_HINT[profile.kind]}
              value={newItemStage}
              onChange={(e) => setNewItemStage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void addItem();
              }}
            />
            <button className="ws-btn ws-btn-primary" onClick={() => void addItem()} disabled={!newItemTitle.trim()}>
              <Plus size={12} /> 添加
            </button>
          </div>
          <div className="ws-list">
            {ctx.items.map((it) => (
              <div key={it.id} className="ws-row">
                <span className="ws-flex">{it.title}</span>
                {it.stage && <span className="ws-badge">{it.stage}</span>}
                <button
                  className="ws-btn"
                  onClick={() => void cycleItemStatus(it)}
                  data-tip="点击切换状态"
                  aria-label={`切换「${it.title}」状态`}
                >
                  {ITEM_STATUS_LABEL[it.status] ?? it.status}
                </button>
                <button
                  className="ws-btn ws-btn-quiet"
                  onClick={() => void removeItem(it)}
                  aria-label={`删除事项「${it.title}」`}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
            {ctx.status === "loading" && <div className="ws-empty">正在加载事项…</div>}
            {ctx.status !== "loading" && ctx.items.length === 0 && (
              <div className="ws-empty">暂无事项；上方输入标题即可添加。</div>
            )}
          </div>
        </div>
      )}

      {activeModule === "links" && (
        <div>
          <div className="ws-form-row">
            <input
              className="ws-input ws-flex"
              placeholder="搜索任务（标题）"
              value={picker.query}
              onChange={(e) => picker.setQuery(e.target.value)}
            />
            <Select
              value={picker.status}
              options={[
                { value: "all", label: "全部" },
                { value: "pending", label: "待办" },
                { value: "completed", label: "已完成" },
              ]}
              onChange={(v) => picker.setStatus(v as TaskPickerStatus)}
              ariaLabel="任务状态筛选"
            />
          </div>

          <h4 className="ws-subhead">已关联（{ctx.links.length}）</h4>
          <div className="ws-list">
            {ctx.links.map((l: WorkspaceTaskLink) => (
              <div key={l.taskId} className="ws-row">
                <span className="ws-flex">{l.title}</span>
                <span className="ws-badge">{l.status}</span>
                <button className="ws-btn" onClick={() => void removeTaskLink(l.taskId)}>
                  <Link2 size={12} /> 取消关联
                </button>
              </div>
            ))}
            {ctx.links.length === 0 && <div className="ws-empty">暂无关联任务</div>}
          </div>

          <h4 className="ws-subhead">可关联任务</h4>
          <div className="ws-list">
            {picker.loading && <div className="ws-empty"><Loader2 size={12} className="ws-spin" /> 正在查询任务…</div>}
            {picker.error && <div className="ws-notice" data-tone="error">查询任务失败：{picker.error}</div>}
            {!picker.loading &&
              picker.tasks.map((t) => (
                <div key={t.id} className="ws-row">
                  <span className="ws-flex">{t.title}</span>
                  {t.status === "completed" && <span className="ws-badge">已完成</span>}
                  <button className="ws-btn" onClick={() => void addTaskLink(t.id)}>
                    <Plus size={12} /> 关联
                  </button>
                </div>
              ))}
            {!picker.loading && !picker.error && picker.tasks.length === 0 && (
              <div className="ws-empty">没有匹配的可关联任务（已排除已关联项）</div>
            )}
          </div>
          <div className="ws-form-actions">
            {picker.canLoadMore && (
              <button className="ws-btn" onClick={picker.loadMore}>加载更多（最多 200 条）</button>
            )}
            <button className="ws-btn" onClick={picker.reload}>重新查询</button>
            <span className="ws-meta">
              {picker.atWindowLimit
                ? "已到 200 条查询上限：更早的任务请用搜索定位（不会漏掉匹配结果）"
                : "按需查询，不一次加载全部历史任务"}
            </span>
          </div>
        </div>
      )}

      {activeModule === "settings" && (
        <>
          <section className="ws-card">
            <header className="ws-card-head"><h3>项目信息</h3></header>
            {!editing ? (
              <>
                <div className="ws-row"><span>名称</span><strong>{project.name}</strong></div>
                <div className="ws-row"><span>类型</span><strong>{profile.label}</strong></div>
                <div className="ws-row"><span>状态</span><strong>{project.status === "archived" ? "已归档" : "进行中"}</strong></div>
                <div className="ws-row"><span>工作目录</span><span className="ws-path">{project.rootPath || "—"}</span></div>
                <div className="ws-row"><span>开发项目</span><strong>{project.devProjectName ?? "—"}</strong></div>
                <div className="ws-row"><span>备注</span><strong>{project.note || "—"}</strong></div>
                <div className="ws-form-actions">
                  <button className="ws-btn" onClick={startEdit}>编辑</button>
                  <button className="ws-btn" onClick={() => void archiveToggle()}>
                    {project.status === "archived" ? "恢复" : "归档"}
                  </button>
                  <button className="ws-btn ws-btn-danger" onClick={() => setConfirmDelete(true)}>
                    <Trash2 size={12} /> 删除登记
                  </button>
                </div>
                {confirmDelete && (
                  <div className="ws-confirm" role="alertdialog" aria-label="确认删除工作空间登记">
                    <AlertCircle size={14} />
                    <span>删除登记后不可恢复；外部文件、原始任务与开发项目不受影响。</span>
                    <button className="ws-btn ws-btn-danger" disabled={busy} onClick={() => void deleteProject()}>
                      确认删除
                    </button>
                    <button className="ws-btn" onClick={() => setConfirmDelete(false)}>取消</button>
                  </div>
                )}
              </>
            ) : (
              <>
                <input className="ws-input" value={editName} placeholder="项目名称" onChange={(e) => setEditName(e.target.value)} />
                <div className="ws-gap" />
                <Select
                  value={editKind}
                  options={KIND_OPTIONS}
                  onChange={(v) => setEditKind(v as WorkspaceKind)}
                  block
                  ariaLabel="工作空间类型"
                />
                <div className="ws-gap" />
                <input
                  className="ws-input"
                  placeholder="工作目录（绝对路径）"
                  value={editRoot}
                  onChange={(e) => setEditRoot(e.target.value)}
                />
                <div className="ws-gap" />
                <Select
                  value={editDev}
                  options={devProjects.map((d) => ({
                    value: d.id,
                    label: `${d.name}${d.exists ? "" : "（目录失效）"}`,
                    hint: d.rootPath,
                  }))}
                  onChange={(v) => setEditDev(v)}
                  block
                  placeholder="不关联开发项目"
                  ariaLabel="关联开发项目"
                />
                <div className="ws-meta">Git 探测与开发工作台都使用这里登记的开发项目根目录。</div>
                <div className="ws-gap" />
                <textarea
                  className="ws-textarea"
                  placeholder="备注"
                  value={editNote}
                  onChange={(e) => setEditNote(e.target.value)}
                />
                <div className="ws-form-actions">
                  <button className="ws-btn ws-btn-primary" disabled={busy} onClick={() => void saveEdit()}>
                    <CheckCircle2 size={12} /> 保存
                  </button>
                  <button className="ws-btn" onClick={() => setEditing(false)}>取消</button>
                  {devProjects.length === 0 && (
                    <button className="ws-btn" onClick={() => void onRefreshDevProjects()}>
                      <RefreshCw size={12} /> 刷新开发项目
                    </button>
                  )}
                </div>
              </>
            )}
          </section>

          <section className="ws-card">
            <header className="ws-card-head">
              <h3>能力清单（{profile.label}）</h3>
              <span className="ws-badge ws-badge-soft">声明式</span>
            </header>
            <div className="ws-cap-list">
              {profile.capabilities.map((id) => {
                const cap = WORKSPACE_CAPABILITIES[id];
                return (
                  <div className="ws-cap" key={id}>
                    <div className="ws-cap-head">
                      <strong>{cap.label}</strong>
                      <span className={`ws-badge ws-badge-${cap.state}`}>{CAPABILITY_STATE_LABEL[cap.state]}</span>
                    </div>
                    <div className="ws-meta">{cap.summary}</div>
                    <div className="ws-meta">实现：{cap.provider}</div>
                    {cap.condition && <div className="ws-meta">条件：{cap.condition}</div>}
                    {cap.fallback && cap.state !== "available" && (
                      <div className="ws-meta" data-tone="warn">降级：{cap.fallback}</div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        </>
      )}
    </section>
  );
}
