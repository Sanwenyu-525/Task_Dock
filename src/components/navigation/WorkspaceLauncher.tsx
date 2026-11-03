//! 任务工作区启动器：批量打开任务关联的一组目标（应用/网页/目录/Agent 会话）。
//!
//! 执行策略：前端驱动顺序执行（每个目标单独一次后端导航调用）——
//! - 已运行应用由后端优先复用（唤醒窗口），未运行的按需启动；
//! - 每个目标独立反馈成功/失败与验证级别，单个失败不阻断后续；
//! - 用户可随时取消尚未执行的目标（已发出的启动无法撤回）；
//! - 明确区分「全部成功 / 部分成功 / 存在失败」；任务完成状态不受影响。

import { useEffect, useMemo, useRef, useState } from "react";
import { X, Rocket, Ban, CheckCircle2, AlertTriangle, CircleDashed, Loader2 } from "lucide-react";
import type { Task } from "../../lib/bridge";
import { useUiStore } from "../../store/useUiStore";
import { useSettingsStore } from "../../store/useSettingsStore";
import { useNavigationStore } from "../../store/useNavigationStore";
import { navNavigate, verificationLabel, type NavigationResult } from "../../lib/navigation";
import { summarizeWorkspace } from "../../lib/workspace";
import { useOverlayLayer } from "../ui/overlay";

type ItemState =
  | { phase: "pending" }
  | { phase: "running" }
  | { phase: "done"; result: NavigationResult }
  | { phase: "skipped" };

const STAGGER_MS = 400;

export default function WorkspaceLauncher() {
  const workspace = useUiStore((s) => s.workspace);
  const closeWorkspace = useUiStore((s) => s.closeWorkspace);
  const settings = useSettingsStore((s) => s.settings);
  const [states, setStates] = useState<ItemState[]>([]);
  const [running, setRunning] = useState(false);
  const cancelRef = useRef(false);
  /** 批次令牌：任务切换/关闭后旧批次的结果一律丢弃，不得写入新任务 UI */
  const batchRef = useRef(0);
  /** 同步执行锁：避免状态尚未刷新时连点产生两批并发启动 */
  const runningRef = useRef(false);
  const mountedRef = useRef(true);
  const task: Task | null = workspace.task;
  const taskId = task?.id ?? null;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // 卸载时让所有在途结果失效
      batchRef.current += 1;
    };
  }, []);

  // 任务切换 / 重新打开：清空上一次的执行结果并中止旧批次。
  // 组件常驻挂载（App 里固定渲染），不清理就会出现「打开 A 任务的工作区，
  // 看到的是上次 B 任务的成功/失败列表」——最容易被误读成真实执行结果。
  useEffect(() => {
    batchRef.current += 1;
    cancelRef.current = true;
    runningRef.current = false;
    setStates([]);
    setRunning(false);
  }, [taskId, workspace.open]);

  const cap = settings?.nav_workspace_max ?? 8;
  // selector 只取稳定引用，列表在 useMemo 派生（避免每次渲染新建数组触发无限重渲染）
  const linksByTask = useNavigationStore((s) => s.linksByTask);
  const links = useMemo(
    () => linksByTask[workspace.task?.id ?? ""] ?? [],
    [linksByTask, workspace.task],
  );
  const list = useMemo(() => links.slice(0, cap), [links, cap]);
  const truncated = links.length > cap;

  /**
   * 关闭策略（Escape / 关闭按钮 / 遮罩点击一致）：
   * - 空闲时直接关闭；
   * - 启动中关闭 = 取消尚未开始的目标 + 让在途结果失效后关闭。
   *   已发出的单次导航无法撤回，但其结果不会再写入 UI，也不会继续启动后续软件。
   */
  function requestClose() {
    if (runningRef.current) {
      cancelRef.current = true;
      runningRef.current = false;
      batchRef.current += 1; // 旧批次结果作废
      setRunning(false);
    }
    closeWorkspace();
  }

  // 弹层栈：工作区启动器是模态对话框，Escape 只关它
  useOverlayLayer("dialog", workspace.open && !!task, requestClose);

  if (!workspace.open || !task) return null;

  async function launchAll() {
    if (runningRef.current || list.length === 0) return;
    const batch = ++batchRef.current;
    cancelRef.current = false;
    runningRef.current = true;
    setRunning(true);
    setStates(list.map(() => ({ phase: "pending" }) as ItemState));

    // 只有当前批次且组件仍挂载时才提交状态
    const commit = (updater: (prev: ItemState[]) => ItemState[]) => {
      if (!mountedRef.current || batchRef.current !== batch) return;
      setStates(updater);
    };

    for (let i = 0; i < list.length; i++) {
      // 关闭/切换任务/取消剩余：跳过尚未开始的目标（绝不标记成功）
      if (cancelRef.current || batchRef.current !== batch) {
        commit((prev) => {
          const next = [...prev];
          for (let j = i; j < next.length; j++) {
            if (next[j].phase === "pending") next[j] = { phase: "skipped" };
          }
          return next;
        });
        break;
      }
      commit((prev) => {
        const next = [...prev];
        next[i] = { phase: "running" };
        return next;
      });
      try {
        const behavior = list[i].launch_behavior;
        const action =
          behavior === "launch"
            ? "open_app"
            : behavior === "focus_or_launch"
              ? "focus_window"
              : behavior === "resume_session"
                ? "resume_session"
                : undefined;
        const result = await navNavigate(list[i].target_id, { action, task_link_id: list[i].id });
        // 等待期间可能已关闭/切换任务：旧任务结果不得写入新任务 UI
        commit((prev) => {
          const next = [...prev];
          next[i] = { phase: "done", result };
          return next;
        });
      } catch (e) {
        commit((prev) => {
          const next = [...prev];
          next[i] = {
            phase: "done",
            result: {
              success: false,
              requested_action: "navigate",
              actual_action: null,
              fallback_used: false,
              target_id: list[i].target_id,
              reason: String(e),
              verification_level: "none",
            },
          };
          return next;
        });
      }
      // 目标间留出间隔：避免同时抢占前台、也便于用户中断
      if (i < list.length - 1) {
        await new Promise((r) => setTimeout(r, STAGGER_MS));
      }
    }
    if (mountedRef.current && batchRef.current === batch) {
      runningRef.current = false;
      setRunning(false);
    }
  }

  /**
   * 统计走纯函数（可单测）：分母恒为「本次计划启动的目标数」，
   * 成功 / 失败 / 取消三种终态严格分开——取消的目标绝不计入成功。
   */
  const stats = summarizeWorkspace(
    states.map((s) =>
      s.phase === "done" ? { phase: "done" as const, success: s.result.success } : s,
    ),
    list.length,
    running,
  );
  const summary =
    stats.text === null
      ? null
      : { text: stats.text, tone: stats.tone as "ok" | "warn" | "bad" };

  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && requestClose()}>
      <div className="modal workspace-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span><Rocket size={14} /> 打开工作区 — {task.title}</span>
          <button className="icon-btn sm" onClick={requestClose} aria-label="关闭">
            <X size={14} />
          </button>
        </div>
        <div className="modal-body">
          <div className="workspace-hint">
            将按顺序打开 {list.length} 个关联目标（已运行的优先唤醒窗口）。任务状态不会因此改变。
            {truncated && ` 已按设置截取前 ${cap} 个（导航偏好中可调）。`}
          </div>
          <div className="workspace-list" role="list">
            {list.map((l, i) => {
              const st = states[i] ?? { phase: "pending" } as ItemState;
              return (
                <div key={l.id} className={`workspace-item st-${st.phase}`} role="listitem">
                  <span className="workspace-item-icon">
                    {st.phase === "pending" && <CircleDashed size={13} />}
                    {st.phase === "running" && <Loader2 size={13} className="spin" />}
                    {st.phase === "skipped" && <Ban size={13} />}
                    {st.phase === "done" && st.result.success && <CheckCircle2 size={13} />}
                    {st.phase === "done" && !st.result.success && <AlertTriangle size={13} />}
                  </span>
                  <span className="workspace-item-name">{l.target.display_name}</span>
                  <span className={`workspace-item-state ${st.phase === "done" && !st.result.success ? "bad" : ""}`}>
                    {st.phase === "pending" && "等待"}
                    {st.phase === "running" && "启动中…"}
                    {st.phase === "skipped" && "已取消"}
                    {st.phase === "done" &&
                      (st.result.success
                        ? `${verificationLabel(st.result.verification_level)}${st.result.fallback_used ? "（降级）" : ""}`
                        : st.result.reason ?? "失败")}
                  </span>
                </div>
              );
            })}
          </div>
          {summary && (
            <div className={`workspace-summary tone-${summary.tone}`}>
              {summary.tone === "ok" && <CheckCircle2 size={13} />}
              {summary.tone !== "ok" && <AlertTriangle size={13} />}
              {summary.text}
            </div>
          )}
        </div>
        <div className="modal-foot">
          {running ? (
            <button className="btn danger" onClick={() => (cancelRef.current = true)}>
              <Ban size={13} /> 取消剩余
            </button>
          ) : (
            <>
              <button className="btn" onClick={requestClose}>关闭</button>
              <button className="btn primary" onClick={launchAll} disabled={list.length === 0}>
                <Rocket size={13} /> 启动全部
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
