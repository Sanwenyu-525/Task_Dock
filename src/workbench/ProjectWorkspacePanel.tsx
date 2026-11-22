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
  BookOpen,
  CheckCircle2,
  FolderKanban,
  FolderOpen,
  GitBranch,
  Link2,
  Loader2,
  Plus,
  RefreshCw,
  Settings2,
  Trash2,
} from "lucide-react";

import WorkbenchPageHeader from "./WorkbenchPageHeader";
import NovelManuscriptPanel from "./NovelManuscriptPanel";
import CreativeModuleHost from "./creative/CreativeModuleHost";
import type { CreativeModuleId } from "./creative/types";
import Select from "../components/ui/Select";
import CollapsibleSection from "../components/ui/CollapsibleSection";
import SectionNavigation from "../components/ui/SectionNavigation";
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
import { pickFolder } from "../lib/filesWorkspace/folderPicker";
import { formatLocalizedDateTime } from "../i18n/format";
import {
  useWorkspaceDevContext,
  useWorkspaceProjectContext,
  useWorkspaceTaskPicker,
  type TaskPickerStatus,
} from "../workspace/useWorkspaceProjectContext";
import { scopeWorkspaceContext } from "../workspace/workspaceContextScope";
import ProjectLayoutEditor from "../workspace/ProjectLayoutEditor";
import { ProjectProgressCard, ProjectResourcesCard } from "../workspace/ProjectWorkspaceExtras";
import { workspaceProfileIcon } from "../workspace/workspaceProfileIcons";
import {
  CAPABILITY_STATE_LABEL,
  WORKSPACE_CAPABILITIES,
  WORKSPACE_PROFILES,
  canInvokeCapability,
  hasNavGroups,
  resolveModuleOrder,
  resolveNavGroups,
  resolveWorkspaceProfile,
  type WorkspaceCard,
  type WorkspaceModuleId,
  type WorkspaceNavGroupView,
  type WorkspaceProfile,
} from "../workspace/workspaceProfiles";
import "./ProjectWorkspacePanel.css";

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

/**
 * 壳层自己渲染的通用模块（内容写在下面各 `activeModule === ...` 分支里）。
 * 其余模块都是专业领域模块，统一交给 `CreativeModuleHost` 按 `kind` 分桶装配：
 * 这样五条开发线只写自己的内容组件，不必改本文件。
 */
const BUILTIN_MODULES = new Set<WorkspaceModuleId>([
  "overview",
  "manuscript",
  "items",
  "links",
  "settings",
]);

const STAGE_HINT: Record<WorkspaceKind, string> = {
  development: "阶段（如 api / ui / 联调）",
  game: "阶段（如 关卡 / 系统 / 美术）",
  ai_comic: "阶段（episode 或 shot）",
  novel: "阶段（如 章节 / 卷 / 人物）",
  general: "阶段（可空）",
};

export type ProjectPanelNoticeKind = "ok" | "error" | "info";
export type ProjectPanelNavResult = "switched" | "pending" | "blocked";

/** 导航键盘契约已收编进公共 SectionNavigation（<nav> + aria-current，
 *  方向键只移焦点、Enter/Space 原生激活），见 docs/ui-themes/15-section-navigation.md。 */

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
  onSelectProject: (id: string | null) => Promise<boolean> | void;
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
  /**
   * 向统一工作台注册「项目切换离开前」守卫：正文模块有脏稿时，项目选择必须先
   * await 落盘；返回 false 则取消本次项目切换。壳层只保存回调，不重建导航状态机。
   */
  registerProjectLeaveGuard?: (guard: (() => Promise<boolean>) | null) => void;
  /**
   * 向壳层注册「当前模块」读取器：关闭诊断需要知道卡在哪个模块（正文/概览/…）。
   * 只读模块 ID，不含正文或项目数据；壳层关闭协调器安装一次、经 ref 调用。
   */
  registerCloseModule?: (read: (() => string) | null) => void;
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
  registerProjectLeaveGuard,
  registerCloseModule,
}: ProjectWorkspacePanelProps) {
  const selectedId = project?.id ?? null;
  const profile = useMemo(() => resolveWorkspaceProfile(project?.kind), [project?.kind]);
  const context = useWorkspaceProjectContext(selectedId, profile);
  // 首渲染隔离：项目切换那一帧不渲染上一个项目的数据。
  const ctx = scopeWorkspaceContext(context, selectedId, profile);
  const devContext = useWorkspaceDevContext(project?.devProjectId ?? null);

  const [localModule, setLocalModule] = useState<WorkspaceModuleId | null>(null);
  const [moduleSaveFailed, setModuleSaveFailed] = useState(false);
  const [layoutEditorOpen, setLayoutEditorOpen] = useState(false);
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
  /** 正文模块注册的落盘回调；null 表示当前未挂载正文编辑器。 */
  const manuscriptFlushRef = useRef<(() => Promise<boolean>) | null>(null);
  const activeModuleRef = useRef<WorkspaceModuleId>("overview");

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

  // 展示层导航分组（只有小说声明；其他类型返回空数组，继续平铺导航）。
  const groupedNav = hasNavGroups(profile);
  const navGroups = useMemo(
    () => resolveNavGroups(profile, ctx.layout),
    [profile, ctx.layout],
  );
  const activeGroup = useMemo(
    () => navGroups.find((group) => group.modules.some((m) => m.id === activeModule)) ?? null,
    [navGroups, activeModule],
  );
  /** 记住每个分组上次停留的子模块：在「设定/推进」间往返不会总跳回第一个。 */
  const lastGroupModuleRef = useRef<Record<string, WorkspaceModuleId>>({});
  useEffect(() => {
    if (!activeGroup) return;
    lastGroupModuleRef.current[activeGroup.id] = activeModule;
  }, [activeGroup, activeModule]);

  const picker = useWorkspaceTaskPicker(
    activeModule === "links" && Boolean(selectedId),
    ctx.links.map((l) => l.taskId),
  );
  /** 已关联任务与「可关联任务」共用同一套搜索/状态筛选。 */
  const filteredLinks = useMemo(() => {
    const query = picker.query.trim().toLowerCase();
    return ctx.links.filter((link: WorkspaceTaskLink) => {
      if (query && !link.title.toLowerCase().includes(query)) return false;
      if (picker.status === "completed") return link.status === "completed";
      if (picker.status === "pending") return link.status !== "completed";
      return true;
    });
  }, [ctx.links, picker.query, picker.status]);

  activeModuleRef.current = activeModule;
  const registerManuscriptFlush = useCallback(
    (flush: (() => Promise<boolean>) | null) => {
      manuscriptFlushRef.current = flush;
    },
    [],
  );
  const projectLeaveGuardRef = useRef<() => Promise<boolean>>(async () => true);
  projectLeaveGuardRef.current = async () => {
    if (activeModuleRef.current !== "manuscript") return true;
    const flush = manuscriptFlushRef.current;
    return flush ? flush() : true;
  };
  // 壳层切换项目前调用该守卫；失败时项目选择取消，正文面板与草稿保持原状。
  useEffect(() => {
    if (!registerProjectLeaveGuard) return;
    registerProjectLeaveGuard(() => projectLeaveGuardRef.current());
    return () => registerProjectLeaveGuard(null);
  }, [registerProjectLeaveGuard]);
  // 关闭诊断上下文：只暴露模块 ID（不含正文），壳层在关闭事务开始时读取。
  useEffect(() => {
    if (!registerCloseModule) return;
    registerCloseModule(() => activeModuleRef.current);
    return () => registerCloseModule(null);
  }, [registerCloseModule]);

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
      // 离开正文模块前必须先完成正文落盘；失败则不切换，保留原页面与草稿。
      if (m !== activeModule && activeModule === "manuscript") {
        const flush = manuscriptFlushRef.current;
        if (flush && !(await flush())) return;
      }
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
    [activeModule, context, onNotice],
  );

  const switchModuleRef = useRef(switchModule);
  switchModuleRef.current = switchModule;

  /**
   * 一级分组切换：所有模块跳转仍然统一经过 `switchModule`（含正文 flush 与
   * 布局保存），不直接 setLocalModule。分组内上次停留的模块仍可见时优先回到它。
   */
  const switchGroup = useCallback(
    (group: WorkspaceNavGroupView) => {
      if (group.modules.some((m) => m.id === activeModule)) return;
      const remembered = lastGroupModuleRef.current[group.id];
      const target = group.modules.some((m) => m.id === remembered)
        ? (remembered as WorkspaceModuleId)
        : group.defaultModule;
      void switchModule(target);
    },
    [activeModule, switchModule],
  );

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

  const pickEditRoot = useCallback(async () => {
    const result = await pickFolder({
      title: "选择项目工作目录",
      defaultPath: editRoot || project?.rootPath || undefined,
    });
    if (result.status === "ok") {
      setEditRoot(result.path);
      return;
    }
    if (result.status === "invalid") {
      const reason =
        result.reason === "notFound"
          ? "目录不存在"
          : result.reason === "notDir"
            ? "选择的不是文件夹"
            : `无法读取目录${result.message ? `：${result.message}` : ""}`;
      onNotice("error", `未选择工作目录：${reason}`);
    }
  }, [editRoot, project, onNotice]);

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
      const switched = await Promise.resolve(onSelectProject(list[0]?.id ?? null));
      if (switched === false) {
        onNotice("error", "项目已删除，但切换被正文保存守卫取消；请保存后重试");
        return;
      }
      setConfirmDelete(false);
      setEditing(false);
      onNotice("ok", "项目已删除；外部文件、全局任务与共享资源未受影响");
    } catch (e) {
      onNotice("error", `删除项目失败：${errorMessage(e)}`);
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
    // 「后续创作功能」是纯说明卡片：只列该类型 planned/unavailable 的能力，
    // 不带任何动作，因此在 planned 状态下也允许渲染；其余卡片仍受
    // canInvokeCapability 闸门约束（planned/unavailable 不得给出可点击入口）。
    if (card.body === "roadmap") {
      const pending = profile.capabilities
        .map((id) => WORKSPACE_CAPABILITIES[id])
        .filter((c) => c.state === "planned" || c.state === "unavailable");
      return (
        <>
          {pending.length === 0 && <div className="ws-empty">本类型暂无登记的计划能力</div>}
          {pending.map((c) => (
            <div key={c.id} className="ws-row">
              <span className="ws-flex">{c.label}</span>
              <span className="ws-badge">{CAPABILITY_STATE_LABEL[c.state]}</span>
            </div>
          ))}
          <div className="ws-meta">
            本阶段只接入项目类型与既有事项/任务关联；以上能力尚无适配器，不提供可点击入口。
          </div>
        </>
      );
    }
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
      case "note":
        if (!project) return null;
        return project.note ? (
          <div className="ws-meta">{project.note}</div>
        ) : (
          <div className="ws-empty">未填写项目简介；可在「项目设置」的备注里补充。</div>
        );
      case "items":
        return (
          <>
            {ctx.items.length === 0 && <div className="ws-empty">暂无事项</div>}
            {ctx.items.slice(0, 6).map((it) => (
              <div key={it.id} className="ws-row">
                <span className="ws-flex" title={it.title}>{it.title}</span>
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
                <span className="ws-flex" title={l.title}>{l.title}</span>
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
                <span className="ws-flex" title={it.title}>{it.title}</span>
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

  /**
   * 小说概览（2026-11-20）：真实统计 + 快捷操作 + 「项目信息与简介 / 写作事项 /
   * 任务关联」三张紧凑卡片。计划中能力不再占用概览，统一收进项目设置的高级信息。
   */
  const renderNovelOverview = () => {
    if (!project) return null;
    const doing = ctx.items.filter((it) => {
      const status = it.status as string;
      return status === "doing" || status === "in_progress";
    }).length;
    const done = ctx.items.filter((it) => it.status === "done").length;
    return (
      <>
        <section className="ws-overview ws-overview-novel" aria-label="项目概览与快捷入口">
          <div className="ws-overview-hero">
            <div className="ws-overview-hero-main">
              <strong className="ws-overview-hero-title">继续写作</strong>
              <p className="ws-meta">
                正文按章保存到本地数据库；设定与推进用于组织人物、世界观、写作事项与关联任务。
              </p>
            </div>
            <div className="ws-overview-actions">
              <button
                type="button"
                className="ws-btn ws-btn-primary"
                onClick={() => void switchModule("manuscript")}
              >
                <BookOpen size={12} /> 开始写作
              </button>
              <button type="button" className="ws-btn" onClick={() => void switchModule("items")}>
                <Plus size={12} /> 新增写作事项
              </button>
              <button type="button" className="ws-btn" onClick={() => void switchModule("links")}>
                <Link2 size={12} /> 关联任务
              </button>
              <button
                type="button"
                className="ws-btn"
                disabled={!project.rootPath || !project.rootExists}
                data-tip={
                  !project.rootPath
                    ? "未设置工作目录，可在项目设置中指定"
                    : !project.rootExists
                      ? "工作目录不存在，可在项目设置中重新指定"
                      : "在系统文件管理器中打开"
                }
                onClick={() => void openFolder(project.rootPath)}
              >
                <FolderOpen size={12} /> 打开工作目录
              </button>
            </div>
          </div>
          <div className="ws-overview-stats" aria-label="项目统计">
            <div className="ws-stat">
              <strong>{ctx.items.length}</strong>
              <span>写作事项</span>
            </div>
            <div className="ws-stat">
              <strong>{doing}</strong>
              <span>进行中</span>
            </div>
            <div className="ws-stat">
              <strong>{done}</strong>
              <span>已完成</span>
            </div>
            <div className="ws-stat">
              <strong>{ctx.links.length}</strong>
              <span>关联任务</span>
            </div>
          </div>
          {project.rootPath && !project.rootExists && (
            <div className="ws-state" data-tone="error">
              工作目录不存在（登记仍保留，可在项目设置中重新指定）
            </div>
          )}
        </section>

        <ProjectProgressCard projectId={selectedId} archived={project.status === "archived"} />

        <div className="ws-overview-grid ui-adaptive-grid ws-overview-grid--natural">
          <section className="ws-card ws-overview-card" aria-label="项目信息与简介">
            <header className="ws-card-head">
              <h3>项目信息</h3>
              <span className="ws-badge ws-badge-soft">小说</span>
            </header>
            <div className="ws-fact-list">
              <div className="ws-fact"><span>状态</span><strong>{project.status === "archived" ? "已归档" : "进行中"}</strong></div>
              <div className="ws-fact">
                <span>工作目录</span>
                {project.rootPath ? (
                  <span className="ws-path ws-path-clamp" data-tip={project.rootPath}>{project.rootPath}</span>
                ) : (
                  <strong>未设置</strong>
                )}
                {project.rootPath && project.rootExists && (
                  <button
                    type="button"
                    className="ws-btn ws-btn-quiet"
                    aria-label="打开工作目录"
                    onClick={() => void openFolder(project.rootPath)}
                  >
                    <FolderOpen size={12} />
                  </button>
                )}
              </div>
              <div className="ws-fact"><span>创建</span><strong>{formatLocalizedDateTime(project.createdAt)}</strong></div>
              <div className="ws-fact"><span>最近更新</span><strong>{formatLocalizedDateTime(project.updatedAt)}</strong></div>
            </div>
            <div className="ws-note-block">
              <span className="ws-note-label">项目简介</span>
              {project.note ? (
                <p className="ws-note-text">{project.note}</p>
              ) : (
                <p className="ws-meta">未填写项目简介；可在「项目设置」的备注里补充。</p>
              )}
            </div>
          </section>

          <section className="ws-card ws-overview-card" aria-label="写作事项">
            <header className="ws-card-head">
              <h3>写作事项</h3>
              <span className="ws-card-actions">
                <span className="ws-meta">{ctx.items.length} 项</span>
                <button
                  type="button"
                  className="ws-btn ws-btn-quiet"
                  aria-label="打开写作事项"
                  onClick={() => void switchModule("items")}
                >
                  打开
                </button>
              </span>
            </header>
            {ctx.status === "loading" ? (
              <div className="ws-state" data-tone="muted"><Loader2 size={12} className="ws-spin" /> 正在加载…</div>
            ) : ctx.items.length === 0 ? (
              <div className="ws-overview-card-empty">
                <p className="ws-meta">还没有写作事项。它用于记录章节、卷或线索的推进状态。</p>
                <button type="button" className="ws-btn" onClick={() => void switchModule("items")}>
                  <Plus size={12} /> 新增写作事项
                </button>
              </div>
            ) : (
              <ul className="ws-compact-list">
                {ctx.items.slice(0, 5).map((it) => (
                  <li key={it.id} className="ws-compact-row">
                    <span className="ws-flex" title={it.title}>{it.title}</span>
                    {it.stage && <span className="ws-badge">{it.stage}</span>}
                    <span className="ws-badge">{ITEM_STATUS_LABEL[it.status] ?? it.status}</span>
                  </li>
                ))}
              </ul>
            )}
            {ctx.items.length > 5 && (
              <div className="ws-meta">仅显示前 5 项，共 {ctx.items.length} 项</div>
            )}
          </section>

          <section className="ws-card ws-overview-card" aria-label="任务关联">
            <header className="ws-card-head">
              <h3>任务关联</h3>
              <span className="ws-card-actions">
                <span className="ws-meta">{ctx.links.length} 个</span>
                <button
                  type="button"
                  className="ws-btn ws-btn-quiet"
                  aria-label="打开任务关联"
                  onClick={() => void switchModule("links")}
                >
                  打开
                </button>
              </span>
            </header>
            {ctx.status === "loading" ? (
              <div className="ws-state" data-tone="muted"><Loader2 size={12} className="ws-spin" /> 正在加载…</div>
            ) : ctx.links.length === 0 ? (
              <div className="ws-overview-card-empty">
                <p className="ws-meta">还没有关联任务。关联只建立弱引用，不会复制或删除全局任务。</p>
                <button type="button" className="ws-btn" onClick={() => void switchModule("links")}>
                  <Link2 size={12} /> 关联任务
                </button>
              </div>
            ) : (
              <ul className="ws-compact-list">
                {ctx.links.slice(0, 5).map((l) => (
                  <li key={l.taskId} className="ws-compact-row">
                    <span className="ws-flex" title={l.title}>{l.title}</span>
                    <span className="ws-badge">{l.status}</span>
                  </li>
                ))}
              </ul>
            )}
            {ctx.links.length > 5 && (
              <div className="ws-meta">仅显示前 5 个，共 {ctx.links.length} 个</div>
            )}
          </section>
        </div>
      </>
    );
  };

  if (!project) {
    return (
      <section className="wb-project wb-project-empty ui-page-frame" aria-label="项目工作空间">
        <WorkbenchPageHeader
          icon={FolderKanban}
          title="项目工作空间"
          subtitle="项目只用于组织专业模块（开发 / 游戏 / AI 漫剧 / 小说 / 通用）"
        />
        <div className="wb-empty-state">
          <span className="wb-empty-icon" aria-hidden="true">
            <FolderKanban size={24} />
          </span>
          <h3 className="wb-empty-title">还没有工作空间项目</h3>
          <p className="wb-empty-desc">
            项目只用于把开发、游戏、AI 漫剧、小说等专业模块组织在一起。任务、Agent、收集与暂存、剪贴板、开发工作台都不需要项目即可使用。
          </p>
          <div className="wb-empty-actions">
            <button className="ws-btn ws-btn-primary" onClick={onCreateProject}>
              <Plus size={12} /> 新建项目
            </button>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="wb-project ui-page-frame" aria-label="项目工作空间" aria-busy={ctx.status === "loading"}>
      {/* 项目页头（2026-11-15 统一为 WorkbenchPageHeader）：项目名作标题、
          登记信息作副标题、类型与状态作 meta，避免「页面标题 + 项目名」两层大标题。 */}
      <WorkbenchPageHeader
        icon={workspaceProfileIcon(profile.icon)}
        title={project.name}
        meta={
          <>
            <span className="ws-badge ws-badge-soft">{profile.label}</span>
            <span className={`ws-badge ws-badge-${project.status === "archived" ? "planned" : "available"}`}>
              {project.status === "archived" ? "已归档" : "进行中"}
            </span>
          </>
        }
        subtitle={
          <>
            事项 {ctx.items.length} · 关联任务 {ctx.links.length}
            {project.rootPath ? (
              <>
                {" · 根目录 "}
                <span className="ws-header-path" data-tip={project.rootPath}>
                  {project.rootPath}
                </span>
              </>
            ) : (
              " · 未设置根目录"
            )}
          </>
        }
        actions={
          project.devProjectId ? (
            <button className="ws-btn" onClick={onNavigateWorkbench}>
              <ArrowUpRight size={12} /> 开发工作台
            </button>
          ) : null
        }
      />
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

      {/* 导航语义：一级是分组（或平铺模块）入口，二级是组内模块入口，选中态用
          aria-current="page"；布局按钮是普通操作，独立于导航容器。导航项来自
          navGroups / modules 数据结构，不写死。键盘：Tab 逐个聚焦、Enter/Space
          原生激活、方向键/Home/End 只移焦点（内置于 SectionNavigation，
          docs/ui-themes/15-section-navigation.md）。 */}
      <div className="ws-tabs ui-toolbar-row">
        <SectionNavigation
          items={
            groupedNav
              ? navGroups.map((group) => ({ id: group.id, label: group.label }))
              : modules.map((m) => ({ id: m.id, label: m.label }))
          }
          activeId={groupedNav ? activeGroup?.id ?? "" : activeModule}
          onSelect={(id) => {
            if (groupedNav) {
              const group = navGroups.find((g) => g.id === id);
              if (group) switchGroup(group);
            } else {
              // id 来自上方 modules 列表，域就是 WorkspaceModuleId
              void switchModule(id as WorkspaceModuleId);
            }
          }}
          aria-label="工作空间模块"
        />
        {ctx.status === "loading" && (
          <span className="ws-tab-loading"><Loader2 size={12} className="ws-spin" /> 加载中</span>
        )}
        <span className="ws-tabs-spacer" />
        <button
          type="button"
          className="ws-btn ws-btn-quiet ws-layout-trigger"
          aria-label="编辑模块布局"
          data-tip="排序 / 显隐（按项目保存）"
          onClick={() => setLayoutEditorOpen(true)}
        >
          <Settings2 size={13} aria-hidden="true" />
          布局
        </button>
      </div>
      {groupedNav && activeGroup && activeGroup.modules.length > 1 && (
        <SectionNavigation
          items={activeGroup.modules.map((m) => ({ id: m.id, label: m.label }))}
          activeId={activeModule}
          onSelect={(id) => void switchModule(id as WorkspaceModuleId)}
          aria-label={`${activeGroup.label}子模块`}
          size="sm"
        />
      )}
      <ProjectLayoutEditor
        open={layoutEditorOpen}
        profile={profile}
        layout={ctx.layout}
        archived={project.status === "archived"}
        onClose={() => setLayoutEditorOpen(false)}
        onSave={(layout) => context.saveLayout(layout)}
        onNotice={(message, kind) =>
          onNotice(kind === "success" ? "ok" : kind === "error" ? "error" : "info", message)
        }
      />
      {moduleSaveFailed && (
        <div className="ws-meta" data-tone="warn">当前模块位置未保存成功（仅影响下次打开时的默认模块）</div>
      )}

      {activeModule === "overview" &&
        (profile.kind === "novel" ? (
          renderNovelOverview()
        ) : (
          <>
            <section className="ws-overview" aria-label="项目概览与快捷入口">
              <div className="ws-overview-stats">
                <div className="ws-stat">
                  <strong>{ctx.items.length}</strong>
                  <span>事项</span>
                </div>
                <div className="ws-stat">
                  <strong>{ctx.items.filter((it) => it.status === "done").length}</strong>
                  <span>已完成</span>
                </div>
                <div className="ws-stat">
                  <strong>{ctx.links.length}</strong>
                  <span>关联任务</span>
                </div>
                <div className="ws-stat">
                  <strong>
                    {
                      ctx.items.filter((it) => {
                        const status = it.status as string;
                        return status === "doing" || status === "in_progress";
                      }).length
                    }
                  </strong>
                  <span>进行中</span>
                </div>
              </div>
              <div className="ws-overview-actions">
                <button type="button" className="ws-btn" onClick={() => void switchModule("items")}>
                  <Plus size={12} /> 新增事项
                </button>
                <button type="button" className="ws-btn" onClick={() => void switchModule("links")}>
                  <Link2 size={12} /> 关联任务
                </button>
                {project?.devProjectId && (
                  <button
                    type="button"
                    className="ws-btn ws-btn-primary"
                    onClick={() => onOpenDevWorkbench(project.devProjectId!)}
                  >
                    <GitBranch size={12} /> 开发工作台
                  </button>
                )}
                {project?.rootPath && project.rootExists && (
                  <button type="button" className="ws-btn" onClick={() => void openFolder(project.rootPath)}>
                    <FolderOpen size={12} /> 打开目录
                  </button>
                )}
              </div>
              {project && (
                <p className="ws-overview-meta">
                  创建于 {formatLocalizedDateTime(project.createdAt)} · 最近更新{" "}
                  {formatLocalizedDateTime(project.updatedAt)}
                </p>
              )}
            </section>
            <ProjectProgressCard
              projectId={selectedId}
              archived={project.status === "archived"}
            />
            <div className="ws-overview-grid ui-adaptive-grid">
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
          </>
        ))}

      {activeModule === "items" && (
        <div className="ws-module-panel ws-items-panel">
          <div className="ws-form-row ws-items-form">
            <input
              className="ws-input ws-items-title"
              placeholder="事项标题"
              aria-label="事项标题"
              value={newItemTitle}
              onChange={(e) => setNewItemTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void addItem();
              }}
            />
            <input
              className="ws-input ws-items-stage"
              placeholder={STAGE_HINT[profile.kind]}
              aria-label="阶段"
              value={newItemStage}
              onChange={(e) => setNewItemStage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void addItem();
              }}
            />
            <button
              type="button"
              className="ws-btn ws-btn-primary ws-items-add"
              onClick={() => void addItem()}
              disabled={!newItemTitle.trim()}
            >
              <Plus size={12} /> 添加
            </button>
          </div>
          <div className="ws-list-head">
            <span>共 {ctx.items.length} 项</span>
            <span className="ws-meta">点击状态可切换；删除只影响本项目事项。</span>
          </div>
          <div className="ws-list ws-item-list">
            {ctx.items.map((it) => (
              <div key={it.id} className="ws-row ws-item-row">
                <span className="ws-flex ws-item-title" title={it.title}>{it.title}</span>
                {it.stage && <span className="ws-badge ws-item-stage">{it.stage}</span>}
                <button
                  type="button"
                  className="ws-btn ws-status-btn"
                  data-status={it.status}
                  onClick={() => void cycleItemStatus(it)}
                  data-tip="点击切换状态"
                  aria-label={`切换「${it.title}」状态`}
                >
                  {ITEM_STATUS_LABEL[it.status] ?? it.status}
                </button>
                <button
                  type="button"
                  className="ws-btn ws-btn-quiet"
                  onClick={() => void removeItem(it)}
                  aria-label={`删除事项「${it.title}」`}
                  data-tip="删除事项"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
            {ctx.status === "loading" && <div className="ws-empty">正在加载事项…</div>}
            {ctx.status !== "loading" && ctx.items.length === 0 && (
              <div className="ws-empty">
                还没有写作事项。上方填写标题（可附阶段，如章节 / 卷 / 线索）即可添加。
              </div>
            )}
          </div>
        </div>
      )}

      {activeModule === "manuscript" && project && (
        <NovelManuscriptPanel
          key={project.id}
          projectId={project.id}
          archived={project.status === "archived"}
          onNotice={onNotice}
          registerFlush={registerManuscriptFlush}
        />
      )}

      {/* 专业领域模块（人物 / 世界观 / 资源 / 构建 / 剧集 / 分镜 / 里程碑 /
          资料 / Git / Agent）：按 kind 从注册表取实现；key 带项目 ID，
          切项目即重挂，杜绝跨项目残留状态。 */}
      {project && !BUILTIN_MODULES.has(activeModule) && (
        <CreativeModuleHost
          key={`${project.id}:${activeModule}`}
          moduleId={activeModule as CreativeModuleId}
          kind={profile.kind}
          projectId={project.id}
          projectName={project.name}
          archived={project.status === "archived"}
          rootPath={project.rootPath || null}
          rootExists={project.rootExists}
          devProjectId={project.devProjectId}
          onNotice={onNotice}
          switchModule={(id) => void switchModule(id as WorkspaceModuleId)}
        />
      )}

      {activeModule === "links" && (
        <div className="ws-module-panel ws-links-panel">
          <div className="ws-form-row ws-links-toolbar">
            <input
              className="ws-input ws-links-search"
              placeholder="搜索任务（标题）"
              aria-label="搜索任务"
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
            <span className="ws-meta ws-links-count">
              已关联 {ctx.links.length} · 可关联 {picker.tasks.length}
            </span>
          </div>

          <section className="ws-links-section" aria-label="已关联任务">
            <div className="ws-list-head">
              <span>已关联</span>
              <span className="ws-badge">{filteredLinks.length === ctx.links.length ? ctx.links.length : `${filteredLinks.length}/${ctx.links.length}`}</span>
              <span className="ws-meta">取消关联只解除弱引用，不删除全局任务。</span>
            </div>
            <div className="ws-list">
              {filteredLinks.map((l: WorkspaceTaskLink) => (
                <div key={l.taskId} className="ws-row ws-link-row">
                  <span className="ws-flex" title={l.title}>{l.title}</span>
                  <span className="ws-badge">{l.status}</span>
                  <button
                    type="button"
                    className="ws-btn"
                    onClick={() => void removeTaskLink(l.taskId)}
                  >
                    <Link2 size={12} /> 取消关联
                  </button>
                </div>
              ))}
              {ctx.links.length === 0 && (
                <div className="ws-empty">
                  还没有关联任务。可在下方「可关联任务」中搜索并建立关联；原任务不会被复制或移动。
                </div>
              )}
              {ctx.links.length > 0 && filteredLinks.length === 0 && (
                <div className="ws-empty">没有符合当前搜索 / 状态筛选的已关联任务。</div>
              )}
            </div>
          </section>

          <section className="ws-links-section" aria-label="可关联任务">
            <div className="ws-list-head">
              <span>可关联任务</span>
              <span className="ws-badge">{picker.tasks.length}</span>
              <span className="ws-meta">按需查询，不一次加载全部历史任务。</span>
            </div>
            <div className="ws-list">
              {picker.loading && <div className="ws-empty"><Loader2 size={12} className="ws-spin" /> 正在查询任务…</div>}
              {picker.error && <div className="ws-notice" data-tone="error">查询任务失败：{picker.error}</div>}
              {!picker.loading &&
                picker.tasks.map((t) => (
                  <div key={t.id} className="ws-row ws-link-row">
                    <span className="ws-flex" title={t.title}>{t.title}</span>
                    {t.status === "completed" && <span className="ws-badge">已完成</span>}
                    <button type="button" className="ws-btn" onClick={() => void addTaskLink(t.id)}>
                      <Plus size={12} /> 关联
                    </button>
                  </div>
                ))}
              {!picker.loading && !picker.error && picker.tasks.length === 0 && (
                <div className="ws-empty">没有匹配的可关联任务（已排除已关联项）。</div>
              )}
            </div>
          </section>

          <div className="ws-form-actions">
            {picker.canLoadMore && (
              <button type="button" className="ws-btn" onClick={picker.loadMore}>加载更多（最多 200 条）</button>
            )}
            <button type="button" className="ws-btn" onClick={picker.reload}>重新查询</button>
            <span className="ws-meta">
              {picker.atWindowLimit
                ? "已到 200 条查询上限：更早的任务请用搜索定位（不会漏掉匹配结果）"
                : "按需查询，不一次加载全部历史任务"}
            </span>
          </div>
        </div>
      )}

      {activeModule === "settings" && (
        <div className="ws-settings">
          <section className="ws-card ws-settings-info">
            <header className="ws-card-head">
              <h3>项目信息</h3>
              {!editing && <span className="ws-badge ws-badge-soft">{profile.label}</span>}
            </header>
            {!editing ? (
              <>
                <div className="ws-fact-list">
                  <div className="ws-fact"><span>名称</span><strong>{project.name}</strong></div>
                  <div className="ws-fact"><span>类型</span><strong>{profile.label}</strong></div>
                  <div className="ws-fact"><span>状态</span><strong>{project.status === "archived" ? "已归档" : "进行中"}</strong></div>
                  <div className="ws-fact">
                    <span>工作目录</span>
                    {project.rootPath ? (
                      <span className="ws-path ws-path-clamp" data-tip={project.rootPath}>{project.rootPath}</span>
                    ) : (
                      <strong>未设置</strong>
                    )}
                  </div>
                  <div className="ws-fact"><span>开发项目</span><strong>{project.devProjectName ?? "未关联"}</strong></div>
                </div>
                <div className="ws-note-block">
                  <span className="ws-note-label">备注</span>
                  {project.note ? (
                    <p className="ws-note-text">{project.note}</p>
                  ) : (
                    <p className="ws-meta">未填写备注。</p>
                  )}
                </div>
                <div className="ws-form-actions">
                  <button type="button" className="ws-btn" onClick={startEdit}>编辑项目信息</button>
                  <button type="button" className="ws-btn" onClick={() => void archiveToggle()}>
                    {project.status === "archived" ? "恢复为进行中" : "归档项目"}
                  </button>
                </div>
              </>
            ) : (
              <>
                <input className="ws-input" value={editName} placeholder="项目名称" aria-label="项目名称" onChange={(e) => setEditName(e.target.value)} />
                <div className="ws-gap" />
                <Select
                  value={editKind}
                  options={KIND_OPTIONS}
                  onChange={(v) => setEditKind(v as WorkspaceKind)}
                  block
                  ariaLabel="工作空间类型"
                />
                <div className="ws-gap" />
                <div className="wb-path-picker">
                  <div
                    className="ws-input wb-path-value"
                    data-empty={editRoot ? "false" : "true"}
                    data-tip={editRoot || undefined}
                  >
                    {editRoot || "尚未选择目录"}
                  </div>
                  <button type="button" className="ws-btn" onClick={() => void pickEditRoot()}>
                    <FolderOpen size={12} /> 选择目录
                  </button>
                  {editRoot && (
                    <button
                      type="button"
                      className="ws-btn"
                      aria-label="清除工作目录"
                      onClick={() => setEditRoot("")}
                    >
                      清除
                    </button>
                  )}
                </div>
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
                  aria-label="项目备注"
                  value={editNote}
                  onChange={(e) => setEditNote(e.target.value)}
                />
                <div className="ws-form-actions">
                  <button type="button" className="ws-btn ws-btn-primary" disabled={busy} onClick={() => void saveEdit()}>
                    <CheckCircle2 size={12} /> 保存
                  </button>
                  <button type="button" className="ws-btn" onClick={() => setEditing(false)}>取消</button>
                  {devProjects.length === 0 && (
                    <button type="button" className="ws-btn" onClick={() => void onRefreshDevProjects()}>
                      <RefreshCw size={12} /> 刷新开发项目
                    </button>
                  )}
                </div>
              </>
            )}
          </section>

          <ProjectResourcesCard
            projectId={selectedId}
            archived={project.status === "archived"}
            onNotice={(message, kind) =>
              onNotice(kind === "success" ? "ok" : kind === "error" ? "error" : "info", message)
            }
          />

          <CollapsibleSection
            className="ws-cap-section"
            title={`能力与实现说明（${profile.label}）`}
            description="四项状态（可用 / 受限 / 计划中 / 未接入）来自声明式能力清单，入口按状态闸门渲染。"
            badge={<span className="ws-badge ws-badge-soft">声明式</span>}
            defaultExpanded={false}
          >
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
          </CollapsibleSection>

          <section className="ws-card ws-danger-zone" aria-label="危险操作">
            <header className="ws-card-head">
              <h3>危险操作</h3>
              <span className="ws-badge ws-badge-unavailable">不可恢复</span>
            </header>
            <p className="ws-meta">
              删除项目会移除本项目的事项、关联、章节与专业模块数据；外部文件、全局任务、
              知识库与共享能力不受影响。
            </p>
            {!confirmDelete ? (
              <button type="button" className="ws-btn ws-btn-danger" onClick={() => setConfirmDelete(true)}>
                <Trash2 size={12} /> 删除项目
              </button>
            ) : (
              <div className="ws-confirm" role="alertdialog" aria-label="确认删除项目">
                <AlertCircle size={14} />
                <span>
                  删除后不可恢复；项目下的计划、功能、步骤与历史将一并删除；外部文件、全局任务、
                  知识库与共享能力不受影响。
                </span>
                <button type="button" className="ws-btn ws-btn-danger" disabled={busy} onClick={() => void deleteProject()}>
                  确认删除
                </button>
                <button type="button" className="ws-btn" onClick={() => setConfirmDelete(false)}>取消</button>
              </div>
            )}
          </section>
        </div>
      )}
    </section>
  );
}
