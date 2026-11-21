//! 外部入口写入后的业务刷新桥（v86）。
//!
//! 背景：`planning-changed` 只由 MCP bridge 广播；独立 CLI、REST 服务与受控文件
//! 导入都不会发它。若只同步操作状态，用户会看到「A 改完了」但列表还是旧数据。
//!
//! 做法：订阅统一操作 store 的「最近结束」列表，对**非 MCP** 的 committed 操作
//! 做一次去抖的业务刷新，复用各 store 既有的刷新入口（不新增轮询、不整页重载）。
//! MCP 仍然只走 `planning-changed`，避免同一次写入刷两遍。

import type { AgentOperation } from "./bridge";
import { useAgentOperationsStore } from "../store/useAgentOperationsStore";
import { refreshPlanningFromExternalChange } from "../store/usePlanningStore";
import { useTasksStore } from "../store/useTasksStore";
import { useNotesStore } from "../store/useNotesStore";

/** 规划域的 resourceKind（其余按任务/笔记处理）。 */
const PLANNING_KINDS = new Set(["feature", "step", "milestone", "project"]);
const DEBOUNCE_MS = 250;
/** 已处理集合上限：超过后清空，只可能造成一次无害的重复刷新。 */
const SEEN_LIMIT = 500;

let started = false;
let timer: ReturnType<typeof setTimeout> | null = null;
const pendingKinds = new Set<string>();
let pendingProject = "";
const seen = new Set<string>();

function schedule(kind: string, projectId: string): void {
  if (kind) pendingKinds.add(kind);
  if (projectId) pendingProject = projectId;
  if (timer !== null) return;
  timer = setTimeout(flush, DEBOUNCE_MS);
  (timer as unknown as { unref?: () => void }).unref?.();
}

function flush(): void {
  timer = null;
  const kinds = new Set(pendingKinds);
  const projectId = pendingProject;
  pendingKinds.clear();
  pendingProject = "";
  if (kinds.size === 0) return;
  if (kinds.has("task")) void useTasksStore.getState().refresh();
  if (kinds.has("note")) void useNotesStore.getState().load({ silent: true });
  for (const kind of kinds) {
    if (PLANNING_KINDS.has(kind)) {
      refreshPlanningFromExternalChange(projectId);
      break;
    }
  }
}

function consider(op: AgentOperation): void {
  if (!op || !op.id || op.status === "running") return;
  // 按「操作 + 终态」去重：同一操作从 interrupted 恢复为 committed 是一次真实提交，
  // 必须刷新业务数据；而 append_detail（同状态的详情更新）不会重复刷新。
  const key = `${op.id}:${op.status}`;
  if (seen.has(key)) return;
  seen.add(key);
  if (seen.size > SEEN_LIMIT) seen.clear();
  // MCP 写入已有 planning-changed：保持单一刷新来源。
  if (op.interface === "mcp") return;
  // 只有真实提交才改了业务数据；失败/冲突/中断一律不刷新。
  if (op.status !== "committed") return;
  schedule(op.resourceKind, op.projectId);
}

/**
 * 幂等启动：应用根部调用一次。
 * 启动恢复（bootstrap）产生的历史记录先标记为已处理，不触发无谓刷新。
 */
export function ensureAgentOperationBusinessRefresh(): void {
  if (started) return;
  started = true;
  for (const op of useAgentOperationsStore.getState().recent) {
    seen.add(`${op.id}:${op.status}`);
  }
  useAgentOperationsStore.subscribe((state, prev) => {
    if (state.recent === prev.recent) return;
    for (const op of state.recent) consider(op);
  });
}
