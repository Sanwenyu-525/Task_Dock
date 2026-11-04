//! 一键工作流 store（v0.9）。
//!
//! 约定（与 usePlanningStore 一致）：
//! - 读失败保留旧数据 + 置 error（面板显示重试），不用空列表冒充；
//! - 写命令 await bridge 后就地用后端权威实体替换，不整页重拉；写失败 throw 给调用方；
//! - 请求代际（seq）防乱序：面板可能被快速切换/重挂载，旧响应必须丢弃。
//! - 执行进度：面板挂载期间订阅 `workflow-run-progress` 事件推送；面板隐藏时
//!   后端照常执行，重新挂载用 refreshActive() 按需查询，不做长期轮询。

import { create } from "zustand";
import {
  workflowList,
  workflowCreate,
  workflowUpdate,
  workflowDelete,
  workflowDuplicate,
  workflowReorder,
  workflowReplaceSteps,
  workflowRun,
  workflowPause,
  workflowResume,
  workflowCancel,
  workflowActive,
  workflowRunDetail,
  workflowLastRunSummary,
  workflowListRuns,
  type Workflow,
  type WorkflowDetail,
  type WorkflowInput,
  type WorkflowPatch,
  type WorkflowStepInput,
  type WorkflowActiveRun,
  type WorkflowRunDetail,
  type WorkflowLastRunSummary,
  type WorkflowRunPage,
} from "../lib/bridge";

export function errText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

interface WorkflowsState {
  workflows: Workflow[] | null;
  workflowsLoading: boolean;
  workflowsError: string | null;
  /** 全局唯一活动运行（无 = 空闲）。 */
  activeRun: WorkflowActiveRun | null;
  /** 活动运行的详情（进度事件推送时更新）。 */
  activeRunDetail: WorkflowRunDetail | null;
  /** 各工作流最近一次运行的摘要（卡片展示）。 */
  lastRuns: Record<string, WorkflowLastRunSummary>;
  /** 历史对话框：当前查看的工作流的分页运行记录。 */
  history: { workflowId: string | null; page: WorkflowRunPage | null; loading: boolean; error: string | null };

  loadWorkflows: () => Promise<void>;
  refreshActive: () => Promise<void>;
  loadLastRun: (workflowId: string) => Promise<void>;

  createWorkflow: (input: WorkflowInput) => Promise<WorkflowDetail>;
  updateWorkflow: (id: string, patch: WorkflowPatch) => Promise<WorkflowDetail>;
  deleteWorkflow: (id: string) => Promise<void>;
  duplicateWorkflow: (id: string) => Promise<WorkflowDetail>;
  reorderWorkflows: (orderedIds: string[]) => Promise<void>;
  saveSteps: (id: string, steps: WorkflowStepInput[]) => Promise<WorkflowDetail>;

  runWorkflow: (id: string) => Promise<WorkflowRunDetail>;
  pauseWorkflow: (id: string) => Promise<void>;
  resumeWorkflow: (id: string) => Promise<void>;
  cancelWorkflow: (id: string) => Promise<void>;

  /** 事件推送入口：面板订阅 onWorkflowRunProgress 后调用。 */
  applyProgress: (detail: WorkflowRunDetail) => void;

  loadHistoryPage: (workflowId: string, offset: number) => Promise<void>;
  clearHistory: () => void;
}

let listSeq = 0;
let historySeq = 0;

export const useWorkflowsStore = create<WorkflowsState>((set, get) => ({
  workflows: null,
  workflowsLoading: false,
  workflowsError: null,
  activeRun: null,
  activeRunDetail: null,
  lastRuns: {},
  history: { workflowId: null, page: null, loading: false, error: null },

  loadWorkflows: async () => {
    const seq = ++listSeq;
    set({ workflowsLoading: true, workflowsError: null });
    try {
      const workflows = await workflowList();
      if (seq !== listSeq) return;
      set({ workflows, workflowsLoading: false });
    } catch (e) {
      if (seq !== listSeq) return;
      set({ workflowsLoading: false, workflowsError: errText(e) });
    }
  },

  refreshActive: async () => {
    try {
      const activeRun = await workflowActive();
      set({ activeRun });
      if (activeRun) {
        const detail = await workflowRunDetail(activeRun.run_id);
        // 活动槽可能在两次 await 之间释放：仍以最新 activeRun 为准
        const current = useWorkflowsStore.getState().activeRun;
        if (current?.run_id === activeRun.run_id) {
          set({ activeRunDetail: detail });
        }
      } else {
        set({ activeRunDetail: null });
      }
    } catch {
      // 概览失败不打断面板：保留旧状态，运行详情会在下一次事件推送时更新
    }
  },

  loadLastRun: async (workflowId) => {
    try {
      const summary = await workflowLastRunSummary(workflowId);
      if (!summary) return;
      set((s) => ({ lastRuns: { ...s.lastRuns, [workflowId]: summary } }));
    } catch {
      // 最近运行读取失败不影响列表展示
    }
  },

  createWorkflow: async (input) => {
    const detail = await workflowCreate(input);
    set((s) => {
      const workflows = s.workflows ? [...s.workflows, detail] : [detail];
      return { workflows };
    });
    void get().loadWorkflows();
    return detail;
  },

  updateWorkflow: async (id, patch) => {
    const detail = await workflowUpdate(id, patch);
    set((s) => ({
      workflows: s.workflows?.map((w) => (w.id === id ? detail : w)) ?? s.workflows,
    }));
    return detail;
  },

  deleteWorkflow: async (id) => {
    await workflowDelete(id);
    set((s) => {
      const lastRuns: Record<string, WorkflowLastRunSummary> = {};
      for (const [k, v] of Object.entries(s.lastRuns)) {
        if (k !== id && v) lastRuns[k] = v;
      }
      return {
        workflows: s.workflows?.filter((w) => w.id !== id) ?? s.workflows,
        lastRuns,
      };
    });
  },

  duplicateWorkflow: async (id) => {
    const detail = await workflowDuplicate(id);
    await get().loadWorkflows();
    return detail;
  },

  reorderWorkflows: async (orderedIds) => {
    await workflowReorder(orderedIds);
    // 后端已按序落库：本地按传入顺序重排，避免额外一次列表请求
    set((s) => {
      if (!s.workflows) return {};
      const byId = new Map(s.workflows.map((w) => [w.id, w]));
      const reordered = orderedIds
        .map((id) => byId.get(id))
        .filter((w): w is Workflow => Boolean(w));
      return reordered.length === s.workflows.length ? { workflows: reordered } : {};
    });
  },

  saveSteps: async (id, steps) => {
    const detail = await workflowReplaceSteps(id, steps);
    set((s) => ({
      workflows: s.workflows?.map((w) =>
        w.id === id ? { ...w, step_count: detail.steps.length, updated_at: detail.updated_at } : w,
      ),
    }));
    return detail;
  },

  runWorkflow: async (id) => {
    const detail = await workflowRun(id);
    set({
      activeRun: {
        run_id: detail.id,
        workflow_id: detail.workflow_id,
        paused: false,
        cancel_requested: false,
      },
      activeRunDetail: detail,
    });
    void get().loadLastRun(id);
    return detail;
  },

  pauseWorkflow: async (id) => {
    await workflowPause(id);
    set((s) => (s.activeRun ? { activeRun: { ...s.activeRun, paused: true } } : {}));
  },

  resumeWorkflow: async (id) => {
    await workflowResume(id);
    set((s) => (s.activeRun ? { activeRun: { ...s.activeRun, paused: false } } : {}));
  },

  cancelWorkflow: async (id) => {
    await workflowCancel(id);
    set((s) => (s.activeRun ? { activeRun: { ...s.activeRun, cancel_requested: true } } : {}));
  },

  applyProgress: (detail) => {
    set((s) => {
      const active = s.activeRun;
      const isCurrent = active?.run_id === detail.id;
      const finished = detail.finished_at !== null;
      if (!isCurrent && !finished) return {};
      // 终态事件在活动槽已释放后到达：仍然落地详情供 UI 展示，随后清空 activeRun
      return {
        activeRunDetail: detail,
        activeRun: finished ? null : isCurrent ? active : s.activeRun,
      };
    });
  },

  loadHistoryPage: async (workflowId, offset) => {
    const seq = ++historySeq;
    set((s) => ({
      history: { ...s.history, workflowId, loading: true, error: null },
    }));
    try {
      const page = await workflowListRuns(workflowId, 20, offset);
      if (seq !== historySeq) return;
      set({
        history: { workflowId, page, loading: false, error: null },
      });
    } catch (e) {
      if (seq !== historySeq) return;
      set((s) => ({
        history: { ...s.history, loading: false, error: errText(e) },
      }));
    }
  },

  clearHistory: () =>
    set({ history: { workflowId: null, page: null, loading: false, error: null } }),
}));
