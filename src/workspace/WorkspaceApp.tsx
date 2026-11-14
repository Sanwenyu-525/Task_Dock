//! 项目工作空间独立窗口（P0-02 / P0-03 / P1-01 / P1-02 / P1-03 整改版）。
//!
//! 本文件只做「组合」：项目列表、Profile 声明的导航与首页、以及数据层
//! (`useWorkspaceProjectContext`) 的渲染。异步读写、代次、过期响应全部在数据层，
//! 页面不再直接 `await` 后改 state —— 那是 P0-03 数据串乱的根因。
//!
//! 关键约束（与验收红线对应）：
//! - 切换项目立即清空并只接受当前代次的结果（不显示别的项目数据）；
//! - 所有写操作以「点击时」的项目为目标，切走后不写入新项目；
//! - 「在开发工作台打开」以主窗口回执为准，不以事件送达为准；
//! - planned / unavailable 能力不渲染可点击按钮（不假装成功）；
//! - 关闭本窗口不影响主窗口/胶囊（本窗口不持有任何主窗口生命周期的钩子）。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { openPath as openSystemPath } from "@tauri-apps/plugin-opener";
import {
  AlertCircle,
  ArrowUpRight,
  CheckCircle2,
  Clapperboard,
  Code2,
  FolderOpen,
  Gamepad2,
  GitBranch,
  Layers,
  Link2,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";

import Select from "../components/ui/Select";
import {
  agentSnapshot,
  devProjectList,
  getSettings,
  onProjectWorkspaceOpenDevWorkbenchResult,
  onProjectWorkspaceProjectSelected,
  projectWorkspaceOpenDevWorkbench,
  workspaceProjectDelete,
  workspaceProjectList,
  workspaceProjectSave,
  workspaceProjectSetStatus,
  workspaceSetActiveProject,
  type DevProject,
  type WorkspaceKind,
  type WorkspaceProject,
  type WorkspaceTaskLink,
} from "../lib/bridge";
import { errorMessage } from "../lib/errors";
import { resolveSecondaryPreset, resolveTheme, resolveVisualPreset } from "../lib/theme";
import {
  INITIAL_DEV_NAV,
  applyDevNavAck,
  applyDevNavFailure,
  applyDevNavTimeout,
  beginDevNav,
  canStartDevNav,
  type DevNavPhase,
  type DevNavTracker,
} from "./devNavRequest";
import {
  useWorkspaceDevContext,
  useWorkspaceProjectContext,
  useWorkspaceTaskPicker,
  type TaskPickerStatus,
} from "./useWorkspaceProjectContext";
import { scopeWorkspaceContext } from "./workspaceContextScope";
import { createActiveProjectWriter, type ActiveProjectWriter } from "./activeProjectWriter";
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
} from "./workspaceProfiles";

const KIND_OPTIONS: { value: WorkspaceKind; label: string }[] = (
  Object.values(WORKSPACE_PROFILES) as WorkspaceProfile[]
).map((p) => ({ value: p.kind, label: p.label }));

const PROFILE_ICON: Record<WorkspaceProfile["icon"], typeof Code2> = {
  code: Code2,
  gamepad: Gamepad2,
  clapperboard: Clapperboard,
  layers: Layers,
};

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

type NoticeKind = "ok" | "error" | "info";
interface Notice {
  kind: NoticeKind;
  text: string;
}

interface AgentSummary {
  running: number;
  waiting: number;
  failed: number;
  truncated: boolean;
  at: string;
}

type DevNavState = DevNavPhase;

/** 主窗口首个回执的超时：超过该时长仍无任何回执才提示「未回执」，不假装成功。 */
const DEV_NAV_ACK_TIMEOUT_MS = 8000;
const NOTICE_OK_TIMEOUT_MS = 2600;

export default function WorkspaceApp() {
  // ── 主题（与主窗口一致的三轴：theme / visual-preset / material）──────────
  const [themeSnap, setThemeSnap] = useState<{
    theme: string;
    visualPreset: string;
    material: string;
  } | null>(null);
  const [prefersDark, setPrefersDark] = useState(
    () => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false,
  );

  // ── 项目列表 ────────────────────────────────────────────────────────────
  const [projects, setProjects] = useState<WorkspaceProject[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [devProjects, setDevProjects] = useState<DevProject[]>([]);
  const [notice, setNotice] = useState<Notice | null>(null);

  // ── 表单状态 ────────────────────────────────────────────────────────────
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newKind, setNewKind] = useState<WorkspaceKind>("general");
  const [newRoot, setNewRoot] = useState("");
  const [newNote, setNewNote] = useState("");

  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [editKind, setEditKind] = useState<WorkspaceKind>("general");
  const [editRoot, setEditRoot] = useState("");
  const [editDev, setEditDev] = useState("");
  const [editNote, setEditNote] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);

  // ── 事项 / 任务选择 ─────────────────────────────────────────────────────
  const [newItemTitle, setNewItemTitle] = useState("");
  const [newItemStage, setNewItemStage] = useState("");
  const [localModule, setLocalModule] = useState<WorkspaceModuleId | null>(null);
  const [moduleSaveFailed, setModuleSaveFailed] = useState(false);

  // ── Agent 快照（只读，available 能力）──────────────────────────────────
  const [agents, setAgents] = useState<AgentSummary | null>(null);
  const [agentLoading, setAgentLoading] = useState(false);
  const [agentError, setAgentError] = useState<string | null>(null);

  // ── 在开发工作台打开（P0-A 请求状态机）────────────────────────────────
  const [devNav, setDevNav] = useState<DevNavState>({ state: "idle" });
  const devTrackerRef = useRef<DevNavTracker>(INITIAL_DEV_NAV);
  const devTimerRef = useRef<number | null>(null);
  const devReqSeqRef = useRef(0);

  const projectsGenRef = useRef(0);
  /** 选择序号：异步保存/创建完成时判断期间是否发生了更新的选择。 */
  const selectionSeqRef = useRef(0);
  /** 模块点击序号：异步保存完成后只让最后一次点击更新本地状态。 */
  const moduleClickSeqRef = useRef(0);
  const noticeTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  /** 选择值镜像：初始化恢复时判断「用户是否已经点过」，避免旧恢复覆盖新选择。 */
  const selectedIdRef = useRef<string | null>(null);
  selectedIdRef.current = selectedId;
  /** 活跃项目写入队列：项目选择 = 唯一写入来源，串行 latest-wins。 */
  const activeWriterRef = useRef<ActiveProjectWriter | null>(null);
  const noticeRef = useRef<(kind: NoticeKind, text: string) => void>(() => {});
  if (!activeWriterRef.current) {
    activeWriterRef.current = createActiveProjectWriter(
      async (value) => {
        await workspaceSetActiveProject(value);
      },
      (e, superseded) => {
        // 之后的用户选择已经排队：旧写入的失败不再打扰。
        if (!superseded) noticeRef.current("error", `记录活跃项目失败：${errorMessage(e)}`);
      },
    );
  }

  const selected = useMemo(
    () => projects.find((p) => p.id === selectedId) ?? null,
    [projects, selectedId],
  );
  const profile = useMemo(() => resolveWorkspaceProfile(selected?.kind), [selected?.kind]);
  const context = useWorkspaceProjectContext(selectedId, profile);
  // P1-A 首渲染隔离：项目切换的那一帧里 hook 仍持有上一个项目的 items/links。
  // 只渲染「上下文项目 === 当前选中项目」的数据；不一致时按加载中处理，
  // 不显示旧项目数据，也不给旧项目的危险操作留入口。
  const ctx = scopeWorkspaceContext(context, selectedId, profile);
  const layoutForRender = ctx.layout;
  const devContext = useWorkspaceDevContext(selected?.devProjectId ?? null);
  const modules = useMemo(
    () => resolveModuleOrder(profile, layoutForRender),
    [profile, layoutForRender],
  );
  const activeModule: WorkspaceModuleId = useMemo(() => {
    const requested = localModule ?? layoutForRender.activeModule;
    return modules.some((m) => m.id === requested) ? requested : modules[0]?.id ?? "overview";
  }, [localModule, layoutForRender.activeModule, modules]);

  const picker = useWorkspaceTaskPicker(
    activeModule === "links" && Boolean(selectedId),
    ctx.links.map((l) => l.taskId),
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /** 统一提示：成功 2.6s 自动消失；错误保留到用户关闭（不静默吞掉失败）。 */
  const pushNotice = useCallback((kind: NoticeKind, text: string) => {
    if (noticeTimerRef.current !== null) {
      window.clearTimeout(noticeTimerRef.current);
      noticeTimerRef.current = null;
    }
    setNotice({ kind, text });
    if (kind === "ok") {
      noticeTimerRef.current = window.setTimeout(() => {
        noticeTimerRef.current = null;
        if (mountedRef.current) setNotice(null);
      }, NOTICE_OK_TIMEOUT_MS);
    }
  }, []);

  // 队列的失败回调在任意时刻触发：通过 ref 拿到最新的提示函数。
  noticeRef.current = pushNotice;

  useEffect(
    () => () => {
      if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
    },
    [],
  );

  // ── 主题同步 ────────────────────────────────────────────────────────────
  const loadTheme = useCallback(() => {
    void getSettings()
      .then((s) => {
        setThemeSnap({
          theme: s.theme,
          visualPreset: s.visual_preset ?? "",
          material: s.material,
        });
      })
      .catch((e) => pushNotice("error", `读取外观设置失败：${errorMessage(e)}`));
  }, [pushNotice]);

  useEffect(() => {
    loadTheme();
    const unsubs: Array<() => void> = [];
    const add = (p: Promise<() => void>) => {
      void p.then((u) => unsubs.push(u)).catch(() => {});
    };
    add(
      listen<string>("theme-changed", (e) =>
        setThemeSnap((c) =>
          c
            ? { ...c, theme: e.payload }
            : { theme: e.payload, visualPreset: "", material: "glass" },
        ),
      ),
    );
    add(
      listen<string>("visual-preset-changed", (e) =>
        setThemeSnap((c) =>
          c
            ? { ...c, visualPreset: e.payload }
            : { theme: "system", visualPreset: e.payload, material: "glass" },
        ),
      ),
    );
    add(
      listen<string>("material-changed", (e) =>
        setThemeSnap((c) =>
          c
            ? { ...c, material: e.payload }
            : { theme: "system", visualPreset: "", material: e.payload },
        ),
      ),
    );
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    const onSystem = (ev: MediaQueryListEvent) => setPrefersDark(ev.matches);
    media?.addEventListener("change", onSystem);
    return () => {
      unsubs.forEach((u) => u());
      media?.removeEventListener("change", onSystem);
    };
  }, [loadTheme]);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.preset = resolveSecondaryPreset(resolveVisualPreset(themeSnap?.visualPreset ?? ""));
    root.dataset.theme = resolveTheme(themeSnap?.theme ?? "system", { prefersDark });
    root.dataset.material = themeSnap?.material ?? "glass";
  }, [themeSnap, prefersDark]);

  // ── 项目列表：代次丢弃过期响应（列表刷新也可能乱序）────────────────────
  const refreshProjects = useCallback(async (): Promise<WorkspaceProject[]> => {
    const gen = ++projectsGenRef.current;
    try {
      const res = await workspaceProjectList();
      if (!mountedRef.current || gen !== projectsGenRef.current) return [];
      setProjects(res.projects);
      return res.projects;
    } catch (e) {
      if (mountedRef.current && gen === projectsGenRef.current) {
        pushNotice("error", `读取项目列表失败：${errorMessage(e)}`);
      }
      return [];
    } finally {
      if (mountedRef.current && gen === projectsGenRef.current) setProjectsLoading(false);
    }
  }, [pushNotice]);

  const refreshDevProjects = useCallback(async () => {
    try {
      const res = await devProjectList();
      if (mountedRef.current) setDevProjects(res.projects);
    } catch (e) {
      // 非致命：关联下拉为空，但已在设置页提示，不阻断工作空间使用
      if (mountedRef.current) pushNotice("error", `读取开发项目登记失败：${errorMessage(e)}`);
    }
  }, [pushNotice]);

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
    void refreshProjects().then((list) => {
      // 恢复活跃项目：设置里的 workspace_active_project 仍存在时才用，否则取第一个。
      // 恢复结果同时写回设置：重启后的「当前项目」与界面一致（无效 ID 不会残留）。
      void getSettings()
        .then((s) => {
          if (!mountedRef.current) return;
          const active = s.workspace_active_project ?? null;
          const valid = (id: string | null) => Boolean(id && list.some((p) => p.id === id));
          // 用户在加载期间已经点过项目：以用户选择为准，不让恢复逻辑覆盖。
          if (valid(selectedIdRef.current)) return;
          const resolved = valid(active) ? active : (list[0]?.id ?? null);
          setSelectedId(resolved);
          if (resolved !== active) void persistActiveRef.current(resolved);
        })
        .catch(() => {
          if (!mountedRef.current) return;
          if (selectedIdRef.current) return;
          const resolved = list[0]?.id ?? null;
          setSelectedId(resolved);
          // 设置读取失败时也把落点写回，避免下次打开再次落到别的项目。
          void persistActiveRef.current(resolved);
        });
    });
    void refreshDevProjects();
    void loadAgents();
  }, [refreshProjects, refreshDevProjects, loadAgents]);

  // 跨窗口选择：主窗口可以直接指定要打开的项目
  useEffect(() => {
    const un = onProjectWorkspaceProjectSelected((p) => {
      setSelectedId(p.projectId);
      setLocalModule(null);
      setConfirmDelete(false);
      // 其他窗口的「明确打开某项目」同样是一次项目选择：按选择所有权落盘，
      // 与本地点击共用同一条串行写入队列（最后一次选择优先）。
      void persistActiveRef.current(p.projectId);
    });
    return () => {
      void un.then((u) => u()).catch(() => {});
    };
  }, []);

  // 项目切换：清空本地模块覆盖与一次性交互状态
  useEffect(() => {
    setLocalModule(null);
    setModuleSaveFailed(false);
    setEditing(false);
    setConfirmDelete(false);
    // 切走项目后旧导航请求不再属于当前上下文：停表、清空状态机。
    // 旧请求的迟到回执因 requestId 不再匹配而被忽略。
    if (devTimerRef.current !== null) {
      window.clearTimeout(devTimerRef.current);
      devTimerRef.current = null;
    }
    devTrackerRef.current = INITIAL_DEV_NAV;
    setDevNav({ state: "idle" });
  }, [selectedId]);

  // ── 活跃项目写入：串行合并，最后一次用户选择优先 ──────────────────────
  // 队列本身在 activeProjectWriter 里（纯逻辑，有单测）；这里只把 IPC 注入。
  const persistActiveProject = useCallback((value: string | null) => {
    activeWriterRef.current?.write(value);
  }, []);
  const persistActiveRef = useRef(persistActiveProject);
  persistActiveRef.current = persistActiveProject;

  // ── 打开开发工作台：requestId 先登记，再等主窗口回执 ─────────────────
  const clearDevTimer = useCallback(() => {
    if (devTimerRef.current !== null) {
      window.clearTimeout(devTimerRef.current);
      devTimerRef.current = null;
    }
  }, []);

  /** 客户端请求编号：必须在 invoke 之前生成，早到的回执才认得出。 */
  const nextDevRequestId = useCallback(() => {
    devReqSeqRef.current = (devReqSeqRef.current + 1) % 1000;
    return Date.now() * 1000 + devReqSeqRef.current;
  }, []);

  const armDevTimeout = useCallback(
    (requestId: number) => {
      clearDevTimer();
      devTimerRef.current = window.setTimeout(() => {
        devTimerRef.current = null;
        const next = applyDevNavTimeout(devTrackerRef.current, requestId);
        if (next === devTrackerRef.current) return;
        devTrackerRef.current = next;
        if (mountedRef.current) setDevNav(next.phase);
      }, DEV_NAV_ACK_TIMEOUT_MS);
    },
    [clearDevTimer],
  );

  useEffect(() => {
    const un = onProjectWorkspaceOpenDevWorkbenchResult((ack) => {
      const result = applyDevNavAck(devTrackerRef.current, ack);
      if (result.kind === "ignored") return;
      devTrackerRef.current = result.tracker;
      // 任何属于当前请求的回执都意味着「有结果了」：停掉首个结果超时。
      if (result.kind === "updated") clearDevTimer();
      if (mountedRef.current) setDevNav(result.tracker.phase);
    });
    return () => {
      void un.then((u) => u()).catch(() => {});
      clearDevTimer();
      devTrackerRef.current = INITIAL_DEV_NAV;
    };
  }, [clearDevTimer]);

  const openDevWorkbench = useCallback(async () => {
    if (!selected) return;
    if (!selected.devProjectId) {
      pushNotice("error", "该项目未关联开发项目；请在设置页关联后再打开开发工作台");
      return;
    }
    // 单飞：requesting 期间再点不产生第二个并发请求；pending 允许被新请求取代。
    if (!canStartDevNav(devTrackerRef.current)) return;
    const requestId = nextDevRequestId();
    devTrackerRef.current = beginDevNav(requestId);
    setDevNav(devTrackerRef.current.phase);
    armDevTimeout(requestId);
    try {
      const res = await projectWorkspaceOpenDevWorkbench(selected.id, requestId);
      if (res.requestId !== requestId) {
        // 后端没有确认我们登记的编号：不能把结果记到错误的对象上。
        const next = applyDevNavFailure(
          devTrackerRef.current,
          requestId,
          "主窗口回执编号不一致，请重试",
        );
        if (next !== devTrackerRef.current) {
          devTrackerRef.current = next;
          clearDevTimer();
          if (mountedRef.current) setDevNav(next.phase);
        }
      }
      // 回执可能已经先到并收敛了状态：这里不再做任何假设。
    } catch (e) {
      const next = applyDevNavFailure(devTrackerRef.current, requestId, errorMessage(e));
      if (next !== devTrackerRef.current) {
        devTrackerRef.current = next;
        clearDevTimer();
        if (mountedRef.current) setDevNav(next.phase);
      }
    }
  }, [armDevTimeout, clearDevTimer, nextDevRequestId, pushNotice, selected]);

  // ── 项目操作 ────────────────────────────────────────────────────────────
  const selectProject = useCallback(
    async (id: string) => {
      selectionSeqRef.current += 1;
      setSelectedId(id);
      // 选择即所有权：串行写入，最后一次选择最终落库（旧写入不会覆盖新选择）。
      void persistActiveProject(id);
    },
    [persistActiveProject],
  );

  const createProject = useCallback(async () => {
    const name = newName.trim();
    if (!name) {
      pushNotice("error", "项目名称不能为空");
      return;
    }
    if (newRoot.trim() && !/^[a-zA-Z]:[\\/]/.test(newRoot.trim()) && !newRoot.trim().startsWith("\\\\")) {
      pushNotice("error", "根目录必须是绝对路径（如 D:\\\\Projects\\\\demo）");
      return;
    }
    setBusy(true);
    const mySeq = selectionSeqRef.current + 1;
    selectionSeqRef.current = mySeq;
    try {
      const res = await workspaceProjectSave({
        id: null,
        name,
        kind: newKind,
        rootPath: newRoot.trim() || null,
        devProjectId: null,
        note: newNote.trim() || null,
      });
      // 创建即选择：走同一条串行写入队列（若用户马上又选了别的项目，以最后一次为准）。
      void persistActiveProject(res.project.id);
      setShowCreate(false);
      setNewName("");
      setNewRoot("");
      setNewNote("");
      await refreshProjects();
      // 创建期间用户已切到别的项目：不强行把选择抢回新建项目。
      if (selectionSeqRef.current === mySeq) setSelectedId(res.project.id);
      pushNotice("ok", `已创建「${res.project.name}」`);
    } catch (e) {
      pushNotice("error", `创建项目失败：${errorMessage(e)}`);
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, [newName, newKind, newRoot, newNote, refreshProjects, pushNotice, persistActiveProject]);

  const saveEdit = useCallback(async () => {
    if (!selected) return;
    const targetId = selected.id;
    setBusy(true);
    try {
      await workspaceProjectSave({
        id: targetId,
        name: editName.trim() || selected.name,
        kind: editKind,
        rootPath: editRoot.trim() || null,
        devProjectId: editDev.trim() || null,
        note: editNote.trim() || null,
      });
      await refreshProjects();
      // 保存期间已切到别的项目：不得关闭/清空当前项目的编辑表单。
      if (selectedIdRef.current !== targetId) {
        pushNotice("info", "上一项目的修改已保存；当前已切换到其他项目");
        return;
      }
      setEditing(false);
      await context.reload();
      pushNotice("ok", "项目信息已保存");
    } catch (e) {
      pushNotice("error", `保存项目失败：${errorMessage(e)}`);
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, [selected, editName, editKind, editRoot, editDev, editNote, refreshProjects, context, pushNotice]);

  const archiveToggle = useCallback(async () => {
    if (!selected) return;
    const next = selected.status === "archived" ? "active" : "archived";
    try {
      await workspaceProjectSetStatus(selected.id, next);
      await refreshProjects();
      pushNotice("ok", next === "archived" ? "已归档（数据与外部文件不受影响）" : "已恢复为进行中");
    } catch (e) {
      pushNotice("error", `${next === "archived" ? "归档" : "恢复"}失败：${errorMessage(e)}`);
    }
  }, [selected, refreshProjects, pushNotice]);

  const deleteProject = useCallback(async () => {
    if (!selected) return;
    setBusy(true);
    try {
      await workspaceProjectDelete(selected.id);
      const list = await refreshProjects();
      // 删除当前项目后必须把回退选择落盘：否则设置仍指向已删除的 ID，
      // 下次打开会再次落到「第一个项目」，与界面显示不一致。
      const fallback = list[0]?.id ?? null;
      setSelectedId(fallback);
      void persistActiveProject(fallback);
      setConfirmDelete(false);
      setEditing(false);
      pushNotice("ok", "已删除工作空间登记；外部文件与关联任务未受影响");
    } catch (e) {
      pushNotice("error", `删除登记失败：${errorMessage(e)}`);
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, [selected, refreshProjects, pushNotice, persistActiveProject]);

  const startEdit = useCallback(() => {
    if (!selected) return;
    setEditName(selected.name);
    setEditKind(selected.kind);
    setEditRoot(selected.rootPath);
    setEditDev(selected.devProjectId ?? "");
    setEditNote(selected.note);
    setEditing(true);
    setConfirmDelete(false);
  }, [selected]);

  // ── 模块 / 事项 / 关联 ─────────────────────────────────────────────────
  const switchModule = useCallback(
    async (m: WorkspaceModuleId) => {
      const seq = moduleClickSeqRef.current + 1;
      moduleClickSeqRef.current = seq;
      setLocalModule(m);
      const result = await context.saveModule(m);
      // 连续点击时只让最后一次点击决定本地覆盖状态：先完成的那次不能把
      // 用户后来选的模块清回「数据层值」。
      if (moduleClickSeqRef.current !== seq) return;
      if (result === "failed") {
        setModuleSaveFailed(true);
        pushNotice("error", "模块位置未保存：下次打开会回到上次成功保存的模块");
      } else if (result === "stale") {
        setModuleSaveFailed(false);
      } else {
        setModuleSaveFailed(false);
        setLocalModule(null); // 已持久化，交回数据层
      }
    },
    [context, pushNotice],
  );

  const addItem = useCallback(async () => {
    if (!selectedId) return;
    const title = newItemTitle.trim();
    if (!title) {
      pushNotice("error", "事项标题不能为空");
      return;
    }
    const result = await context.addItem({ title, stage: newItemStage });
    if (result === "ok") {
      setNewItemTitle("");
      setNewItemStage("");
    } else if (result === "failed") {
      pushNotice("error", "添加事项失败，内容仍保留在输入框");
    } else {
      pushNotice("info", "项目已切换，本次输入未提交");
    }
  }, [selectedId, newItemTitle, newItemStage, context, pushNotice]);

  const cycleItemStatus = useCallback(
    async (item: Parameters<typeof context.cycleItemStatus>[0]) => {
      const result = await context.cycleItemStatus(item);
      if (result === "failed") pushNotice("error", "修改事项状态失败");
      if (result === "stale") pushNotice("info", "项目已切换，本次操作未提交");
    },
    [context, pushNotice],
  );

  const removeItem = useCallback(
    async (item: Parameters<typeof context.removeItem>[0]) => {
      const result = await context.removeItem(item);
      if (result === "failed") pushNotice("error", "删除事项失败");
    },
    [context, pushNotice],
  );

  const addTaskLink = useCallback(
    async (taskId: string) => {
      const result = await context.addTaskLink(taskId);
      if (result === "failed") pushNotice("error", "关联任务失败");
      if (result === "stale") pushNotice("info", "项目已切换，本次关联未提交");
    },
    [context, pushNotice],
  );

  const removeTaskLink = useCallback(
    async (taskId: string) => {
      const result = await context.removeTaskLink(taskId);
      if (result === "failed") pushNotice("error", "取消关联失败");
      if (result === "stale") pushNotice("info", "项目已切换，本次操作未提交");
    },
    [context, pushNotice],
  );

  const openFolder = useCallback(
    async (path: string) => {
      if (!path) return;
      try {
        await openSystemPath(path);
      } catch (e) {
        pushNotice("error", `打开目录失败：${errorMessage(e)}`);
      }
    },
    [pushNotice],
  );

  // 数据层提示「写入已落到上一个项目」时如实转达
  useEffect(() => {
    if (!context.lastStaleNotice) return;
    pushNotice("info", context.lastStaleNotice);
    context.clearStaleNotice();
  }, [context.lastStaleNotice, context, pushNotice]);

  // ── 渲染辅助 ────────────────────────────────────────────────────────────
  const ProfileIcon = PROFILE_ICON[profile.icon];

  const gitSummary = useMemo(() => {
    const probe = devContext.probe;
    if (!selected?.devProjectId) return { tone: "muted" as const, text: "未关联开发项目" };
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
        return {
          tone: "warn" as const,
          text: "开发项目根目录不是 Git 仓库（请检查登记的路径）",
        };
      case "git_unavailable":
        return { tone: "warn" as const, text: "未检测到可用的 Git 命令" };
      case "path_missing":
        return { tone: "error" as const, text: "开发项目根目录不存在" };
      default:
        return { tone: "muted" as const, text: `未知状态：${String(probe.status)}` };
    }
  }, [selected?.devProjectId, devContext]);

  const itemCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const it of ctx.items) counts[it.status] = (counts[it.status] ?? 0) + 1;
    return counts;
  }, [ctx.items]);

  /** 能力状态说明：planned/unavailable 必须显示原因，不渲染动作按钮。 */
  const capabilityNote = (id: WorkspaceCard["capability"]) => {
    const cap = WORKSPACE_CAPABILITIES[id];
    const usable = canInvokeCapability(profile.kind, id);
    return { cap, usable };
  };

  /** 导航状态 → 文案/色调。pending 明确「还没进入」，cancelled 明确「未切换」。 */
  const devNavView = (
    phase: DevNavPhase,
  ): { tone: "ok" | "warn" | "error"; text: string } | null => {
    switch (phase.state) {
      case "idle":
      case "requesting":
        return null;
      case "pending":
        return {
          tone: "warn",
          text: "主窗口有未保存内容：已请求切换，正在等待你在主窗口确认或取消（确认前尚未进入开发工作台）",
        };
      case "success":
        return {
          tone: "ok",
          text: phase.late
            ? "已切换到开发工作台（回执迟到，现已确认）"
            : "已切换到开发工作台",
        };
      case "cancelled":
        return {
          tone: "warn",
          text: "已在主窗口取消切换：未保存内容保留，开发工作台未打开，当前工作空间项目未改变",
        };
      case "error":
        return {
          tone: "error",
          text: phase.timedOut
            ? "主窗口未回执（可能仍在启动或已退出）。请重试，或先手动打开主窗口"
            : phase.error ?? "打开开发工作台失败",
        };
    }
  };

  const cardBody = (card: WorkspaceCard) => {
    const { cap, usable } = capabilityNote(card.capability);
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
        if (!selected) return null;
        return (
          <>
            <div className="ws-row"><span>类型</span><strong>{profile.label}</strong></div>
            <div className="ws-row"><span>状态</span><strong>{selected.status === "archived" ? "已归档" : "进行中"}</strong></div>
            <div className="ws-row"><span>事项</span><strong>{ctx.items.length}</strong></div>
            <div className="ws-row"><span>关联任务</span><strong>{ctx.links.length}</strong></div>
            <div className="ws-row">
              <span>工作目录</span>
              <span className="ws-path">{selected.rootPath || "未设置"}</span>
              {selected.rootPath && selected.rootExists && (
                <button className="ws-btn" onClick={() => void openFolder(selected.rootPath)}>
                  <FolderOpen size={12} /> 打开
                </button>
              )}
            </div>
            {selected.rootPath && !selected.rootExists && (
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
        if (!selected?.devProjectId) {
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
              <strong>{devContext.devProject?.name ?? selected.devProjectName ?? "（已失效）"}</strong>
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
              <button
                className="ws-btn ws-btn-primary"
                disabled={devNav.state === "requesting"}
                onClick={() => void openDevWorkbench()}
              >
                {devNav.state === "requesting" ? <Loader2 size={12} className="ws-spin" /> : <GitBranch size={12} />}
                {devNav.state === "requesting" ? "正在打开…" : "在开发工作台打开"}
              </button>
              {devContext.status === "ready" && (
                <button className="ws-btn" onClick={() => void devContext.refresh()}>
                  <RefreshCw size={12} /> 重新探测
                </button>
              )}
            </div>
            {devNavInfo && (
              <div className="ws-state" data-tone={devNavInfo.tone}>
                {devNav.state === "success" ? <CheckCircle2 size={13} /> : <AlertCircle size={13} />}{" "}
                {devNavInfo.text}
              </div>
            )}
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
            {!selected?.devProjectId && (
              <div className="ws-meta">Git 探测使用开发项目登记的根目录，不使用工作空间工作目录</div>
            )}
          </>
        );
      case "agents":
        return (
          <>
            {agentLoading && <div className="ws-state" data-tone="muted"><Loader2 size={12} className="ws-spin" /> 正在读取 Agent 实时快照…</div>}
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
            <button
              className="ws-btn"
              disabled={!selected?.devProjectId || devNav.state === "requesting"}
              onClick={() => void openDevWorkbench()}
            >
              <ArrowUpRight size={12} /> 去主窗口验收工作台
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

  const devNavInfo = devNavView(devNav);

  return (
    <div className="ws-root">
      <header className="ws-topbar">
        <ProfileIcon size={16} className="ws-profile-icon" aria-hidden="true" />
        <span className="ws-title">Task Dock · 工作空间</span>
        <span className="ws-badge">{profile.label}</span>
        {selected && <span className="ws-topbar-project">{selected.name}</span>}
        <div className="ws-topbar-actions">
          <button
            className="ws-btn ws-btn-quiet"
            aria-label="刷新项目数据"
            data-tip="重新读取当前项目"
            onClick={() => void refreshProjects().then(() => context.reload())}
            disabled={ctx.status === "loading"}
          >
            <RefreshCw size={13} />
          </button>
        </div>
      </header>

      <div className="ws-main">
        <aside className="ws-sidebar" aria-label="项目列表">
          <button className="ws-btn ws-btn-primary" onClick={() => setShowCreate((v) => !v)} aria-expanded={showCreate}>
            <Plus size={14} /> 新建项目
          </button>

          {showCreate && (
            <div className="ws-card ws-create" role="group" aria-label="新建工作空间项目">
              <input
                className="ws-input"
                placeholder="项目名称"
                value={newName}
                autoFocus
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void createProject();
                  if (e.key === "Escape") setShowCreate(false);
                }}
              />
              <div className="ws-gap" />
              <Select
                value={newKind}
                options={KIND_OPTIONS}
                onChange={(v) => setNewKind(v as WorkspaceKind)}
                block
                ariaLabel="工作空间类型"
              />
              <div className="ws-gap" />
              <input
                className="ws-input"
                placeholder="工作目录（绝对路径，可空）"
                value={newRoot}
                onChange={(e) => setNewRoot(e.target.value)}
                onKeyDown={(e) => e.key === "Escape" && setShowCreate(false)}
              />
              <div className="ws-gap" />
              <textarea
                className="ws-textarea"
                placeholder="备注"
                value={newNote}
                onChange={(e) => setNewNote(e.target.value)}
              />
              <div className="ws-gap" />
              <div className="ws-form-actions">
                <button className="ws-btn ws-btn-primary" disabled={busy} onClick={() => void createProject()}>
                  {busy ? <Loader2 size={12} className="ws-spin" /> : null} 创建
                </button>
                <button className="ws-btn" onClick={() => setShowCreate(false)}>取消</button>
              </div>
            </div>
          )}

          <div className="ws-list" role="list">
            {projects.map((p) => {
              const ProjectIcon = PROFILE_ICON[resolveWorkspaceProfile(p.kind).icon];
              return (
                <button
                  key={p.id}
                  type="button"
                  role="listitem"
                  className={`ws-project-item ${p.id === selectedId ? "is-active" : ""}`}
                  onClick={() => void selectProject(p.id)}
                  aria-current={p.id === selectedId ? "true" : undefined}
                >
                  <div className="ws-project-head">
                    <ProjectIcon size={13} aria-hidden="true" />
                    <strong>{p.name}</strong>
                    <span className="ws-badge ws-badge-soft">
                      {resolveWorkspaceProfile(p.kind).label}
                    </span>
                  </div>
                  <div className="ws-meta">
                    {p.status === "archived" ? "已归档" : "进行中"} · 事项 {p.itemCount} · 关联 {p.taskLinkCount}
                  </div>
                  {p.rootPath && (
                    <div className="ws-meta" data-tone={p.rootExists ? "ok" : "error"}>
                      {p.rootExists ? "✓" : "✗"} {p.rootPath}
                    </div>
                  )}
                  {p.devProjectId && !p.devProjectExists && (
                    <div className="ws-meta" data-tone="error">开发项目关联已失效</div>
                  )}
                </button>
              );
            })}
            {projectsLoading && <div className="ws-empty"><Loader2 size={13} className="ws-spin" /> 正在读取项目…</div>}
            {!projectsLoading && projects.length === 0 && (
              <div className="ws-empty">
                还没有工作空间项目。
                <br />
                主窗口的胶囊、任务、剪贴板等工具不受影响，可随时使用。
              </div>
            )}
          </div>
        </aside>

        <main className="ws-content" aria-busy={ctx.status === "loading"}>
          {notice && (
            <div className="ws-notice" data-tone={notice.kind} role={notice.kind === "error" ? "alert" : "status"}>
              {notice.kind === "error" ? <AlertCircle size={13} /> : notice.kind === "ok" ? <CheckCircle2 size={13} /> : null}
              <span>{notice.text}</span>
              <button className="ws-btn ws-btn-quiet" aria-label="关闭提示" onClick={() => setNotice(null)}>
                <X size={12} />
              </button>
            </div>
          )}

          {selected?.status === "archived" && (
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

          {!selected && (
            <div className="ws-placeholder">
              <ProfileIcon size={22} />
              <div>请选择或创建一个工作空间项目</div>
              <div className="ws-meta">
                不同项目类型会得到不同的导航与首页（开发 / 游戏 / AI 漫剧 / 通用）。
              </div>
            </div>
          )}

          {selected && (
            <>
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
                {ctx.status === "loading" && <span className="ws-tab-loading"><Loader2 size={12} className="ws-spin" /> 加载中</span>}
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
                        <div className="ws-row"><span>名称</span><strong>{selected.name}</strong></div>
                        <div className="ws-row"><span>类型</span><strong>{profile.label}</strong></div>
                        <div className="ws-row"><span>状态</span><strong>{selected.status === "archived" ? "已归档" : "进行中"}</strong></div>
                        <div className="ws-row"><span>工作目录</span><span className="ws-path">{selected.rootPath || "—"}</span></div>
                        <div className="ws-row"><span>开发项目</span><strong>{selected.devProjectName ?? "—"}</strong></div>
                        <div className="ws-row"><span>备注</span><strong>{selected.note || "—"}</strong></div>
                        <div className="ws-form-actions">
                          <button className="ws-btn" onClick={startEdit}>编辑</button>
                          <button className="ws-btn" onClick={() => void archiveToggle()}>
                            {selected.status === "archived" ? "恢复" : "归档"}
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
                            <button className="ws-btn" onClick={() => void refreshDevProjects()}>
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
            </>
          )}
        </main>
      </div>
    </div>
  );
}
