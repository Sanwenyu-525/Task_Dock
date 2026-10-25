//! 任务工作区启动器：批量打开任务关联的一组目标（应用/网页/目录/Agent 会话）。
//!
//! 执行策略：前端驱动顺序执行（每个目标单独一次后端导航调用）——
//! - 已运行应用由后端优先复用（唤醒窗口），未运行的按需启动；
//! - 每个目标独立反馈成功/失败与验证级别，单个失败不阻断后续；
//! - 用户可随时取消尚未执行的目标（已发出的启动无法撤回）；
//! - 明确区分「全部成功 / 部分成功 / 存在失败」；任务完成状态不受影响。

import { useMemo, useRef, useState } from "react";
import { X, Rocket, Ban, CheckCircle2, AlertTriangle, CircleDashed, Loader2 } from "lucide-react";
import type { Task } from "../../lib/bridge";
import { useUiStore } from "../../store/useUiStore";
import { useSettingsStore } from "../../store/useSettingsStore";
import { useNavigationStore } from "../../store/useNavigationStore";
import { navNavigate, verificationLabel, type NavigationResult } from "../../lib/navigation";

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
  const links = useNavigationStore((s) => (workspace.task ? s.linksByTask[workspace.task.id] : undefined)) ?? [];
  const [states, setStates] = useState<ItemState[]>([]);
  const [running, setRunning] = useState(false);
  const cancelRef = useRef(false);
  const task: Task | null = workspace.task;

  const cap = settings?.nav_workspace_max ?? 8;
  const list = useMemo(() => links.slice(0, cap), [links, cap]);
  const truncated = links.length > cap;

  if (!workspace.open || !task) return null;

  async function launchAll() {
    if (running || list.length === 0) return;
    cancelRef.current = false;
    setRunning(true);
    setStates(list.map(() => ({ phase: "pending" }) as ItemState));
    for (let i = 0; i < list.length; i++) {
      if (cancelRef.current) {
        setStates((prev) => {
          const next = [...prev];
          for (let j = i; j < next.length; j++) {
            if (next[j].phase === "pending") next[j] = { phase: "skipped" };
          }
          return next;
        });
        break;
      }
      setStates((prev) => {
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
        const result = await navNavigate(list[i].target_id, action ? { action } : undefined);
        setStates((prev) => {
          const next = [...prev];
          next[i] = { phase: "done", result };
          return next;
        });
      } catch (e) {
        setStates((prev) => {
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
    setRunning(false);
  }

  const done = states.filter((s) => s.phase === "done");
  const ok = done.filter((s) => s.phase === "done" && s.result.success).length;
  const failed = done.length - ok;
  const summary = !running
    ? done.length === 0
      ? null
      : failed === 0
        ? { text: `全部成功（${ok}/${list.length}）`, tone: "ok" as const }
        : ok > 0
          ? { text: `部分成功：${ok} 成功 · ${failed} 失败${states.some((s) => s.phase === "skipped") ? " · 已取消部分" : ""}`, tone: "warn" as const }
          : { text: `全部失败（${failed} 个目标）`, tone: "bad" as const }
    : null;

  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && !running && closeWorkspace()}>
      <div className="modal workspace-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span><Rocket size={14} /> 打开工作区 — {task.title}</span>
          <button className="icon-btn sm" onClick={() => !running && closeWorkspace()} aria-label="关闭" disabled={running}>
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
              <button className="btn" onClick={closeWorkspace}>关闭</button>
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
