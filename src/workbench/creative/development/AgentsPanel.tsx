//! E2：Agent 任务接续面板。
//!
//! 红线：Agent 轮次 `completed` 只是「Agent 自述完成」，绝不自动判定验收通过；
//! 验收结论只能来自 `dev_acceptance_records` 的人工记录，界面必须区分两者。
//!
//! ## 状态管理约定（本次修复重点）
//! - `summary` 与 `handoff` **各自**维护请求序号、加载态与错误态：一个失败不能
//!   把另一个的界面清空，重试也只重试失败的那一个。
//! - 切换任务时**立即**清空旧 handoff（并作废在途请求），不允许「新数据到达前
//!   短暂展示上一个任务的交接记录」。
//! - 组件卸载后旧请求不得再写入状态（`mountedRef` + 序号双保险）。

import { useCallback, useEffect, useRef, useState } from "react";
import type { CreativeModuleProps } from "../types";
import { errorMessage } from "../../../lib/errors";
import { dwsDevelopmentSummary, dwsTaskHandoff } from "./ipc";
import type {
  DwsDevelopmentSummary,
  DwsTaskHandoff,
  DwsTaskRef,
} from "./types";
import { VERDICT_LABELS } from "./types";

function VerdictBadge({ verdict }: { verdict: string | null }) {
  if (!verdict) return <span className="ws-badge ws-badge-planned">待人工验收</span>;
  const tone =
    verdict === "pass"
      ? "ws-badge-available"
      : verdict === "fail"
        ? "ws-badge-unavailable"
        : "ws-badge-limited";
  return <span className={`ws-badge ${tone}`}>{VERDICT_LABELS[verdict] ?? verdict}</span>;
}

export default function AgentsPanel({
  projectId,
  archived,
  switchModule,
}: CreativeModuleProps) {
  const [summary, setSummary] = useState<DwsDevelopmentSummary | null>(null);
  const [handoff, setHandoff] = useState<DwsTaskHandoff | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [loadingSummary, setLoadingSummary] = useState(false);
  const [loadingHandoff, setLoadingHandoff] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [handoffError, setHandoffError] = useState<string | null>(null);

  const summarySeq = useRef(0);
  const handoffSeq = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      // 卸载后所有在途请求失效：序号自增即可让回调直接返回。
      mountedRef.current = false;
      summarySeq.current += 1;
      handoffSeq.current += 1;
    };
  }, []);

  const loadSummary = useCallback(async () => {
    const seq = ++summarySeq.current;
    setLoadingSummary(true);
    setSummaryError(null);
    try {
      const { summary: next } = await dwsDevelopmentSummary(projectId);
      if (seq !== summarySeq.current || !mountedRef.current) return;
      setSummary(next);
      // 刷新后收敛选中项：原选中任务已不在列表 → 取第一个；没有任务 → 清空。
      setSelectedTaskId((prev) => {
        if (prev && next.tasks.some((t) => t.taskId === prev)) return prev;
        return next.tasks[0]?.taskId ?? null;
      });
    } catch (e) {
      if (seq !== summarySeq.current || !mountedRef.current) return;
      setSummaryError(errorMessage(e));
    } finally {
      if (seq === summarySeq.current && mountedRef.current) setLoadingSummary(false);
    }
  }, [projectId]);

  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

  const loadHandoff = useCallback(
    async (taskId: string) => {
      const seq = ++handoffSeq.current;
      setLoadingHandoff(true);
      setHandoffError(null);
      try {
        const { handoff: next } = await dwsTaskHandoff(projectId, taskId);
        if (seq !== handoffSeq.current || !mountedRef.current) return;
        setHandoff(next);
      } catch (e) {
        if (seq !== handoffSeq.current || !mountedRef.current) return;
        setHandoffError(errorMessage(e));
      } finally {
        if (seq === handoffSeq.current && mountedRef.current) setLoadingHandoff(false);
      }
    },
    [projectId],
  );

  useEffect(() => {
    // 任务切换：先作废在途请求并清空旧数据，再按新任务取数。
    // 这样「切换后到新数据返回前」不会残留上一个任务的交接记录。
    handoffSeq.current += 1;
    setHandoff(null);
    setHandoffError(null);
    setLoadingHandoff(false);
    if (!selectedTaskId) {
      return;
    }
    void loadHandoff(selectedTaskId);
  }, [selectedTaskId, loadHandoff]);

  const tasks: DwsTaskRef[] = summary?.tasks ?? [];
  // 防御：只渲染与当前选中任务一致的交接数据（避免任何残留）。
  const visibleHandoff =
    handoff && selectedTaskId && handoff.taskId === selectedTaskId ? handoff : null;
  const selectedTask = tasks.find((t) => t.taskId === selectedTaskId) ?? null;

  return (
    <div className="dws-panel">
      <div className="ws-card-head">
        <h2 className="dws-title">Agent 任务接续</h2>
        <div className="dws-actions">
          <button
            type="button"
            className="ws-btn ws-btn-quiet"
            onClick={() => void loadSummary()}
            disabled={loadingSummary}
          >
            {loadingSummary ? "刷新中…" : "刷新"}
          </button>
        </div>
      </div>

      {archived && (
        <div className="ws-notice" data-tone="info">
          <span>项目已归档：接续记录只读展示。</span>
        </div>
      )}

      {summaryError && (
        <div className="ws-notice" data-tone="error">
          <span>关联任务加载失败：{summaryError}</span>
          <button type="button" className="ws-btn ws-btn-quiet" onClick={() => void loadSummary()}>
            重试
          </button>
        </div>
      )}

      {!summaryError && loadingSummary && !summary && (
        <div className="ws-state" data-tone="muted">正在加载关联任务…</div>
      )}

      {!summaryError && !loadingSummary && summary && tasks.length === 0 && (
        <div className="ws-empty dws-empty-cta">
          <span>
            还没有关联任务。项目工作空间的「任务关联」模块可以直接把既有任务关联到本项目，
            关联后这里展示交接包、Agent 轮次与验收记录。
          </span>
          <button type="button" className="ws-btn" onClick={() => switchModule("links")}>
            去「任务关联」
          </button>
        </div>
      )}

      {tasks.length > 0 && (
        <div className="dws-task-switch">
          {tasks.map((task) => (
            <button
              key={task.taskId}
              type="button"
              className={`ws-btn ws-btn-quiet ${task.taskId === selectedTaskId ? "dws-active" : ""}`}
              aria-pressed={task.taskId === selectedTaskId}
              onClick={() => {
                if (task.taskId !== selectedTaskId) setSelectedTaskId(task.taskId);
              }}
            >
              {task.title}
            </button>
          ))}
        </div>
      )}

      {handoffError && (
        <div className="ws-notice" data-tone="error">
          <span>
            接续记录加载失败{selectedTask ? `（${selectedTask.title}）` : ""}：{handoffError}
          </span>
          <button
            type="button"
            className="ws-btn ws-btn-quiet"
            onClick={() => {
              if (selectedTaskId) void loadHandoff(selectedTaskId);
            }}
          >
            重试
          </button>
        </div>
      )}

      {!handoffError && loadingHandoff && (
        <div className="ws-state" data-tone="muted">正在加载接续记录…</div>
      )}

      {!handoffError && visibleHandoff && (
        <>
          <div className="ws-notice" data-tone="info">
            <span>
              Agent 完成轮次不等于验收通过；本面板的验收结论只以下方「人工验收记录」为准。
            </span>
          </div>

          <section className="dws-section">
            <div className="dws-subhead">Agent 执行轮次（{visibleHandoff.agentCandidates.length}）</div>
            {visibleHandoff.agentCandidates.length === 0 ? (
              <div className="ws-empty">暂无 Agent 自述完成的轮次。</div>
            ) : (
              <ul className="ws-list">
                {visibleHandoff.agentCandidates.map((run) => (
                  <li className="ws-row" key={run.runExternalId}>
                    <div className="dws-run">
                      <div className="dws-run-title">
                        {run.runTaskTitle ?? run.sessionTitle}
                        <span className="ws-badge ws-badge-soft">{run.runStatus}</span>
                      </div>
                      <div className="dws-run-sub">
                        会话：{run.sessionTitle}
                        {run.endedAt ? ` · 结束于 ${run.endedAt}` : ""}
                      </div>
                    </div>
                    <VerdictBadge verdict={run.acceptedVerdict} />
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="dws-section">
            <div className="dws-subhead">交接包（{visibleHandoff.packs.length}）</div>
            {visibleHandoff.packs.length === 0 ? (
              <div className="ws-empty">暂无交接包。</div>
            ) : (
              <ul className="ws-list">
                {visibleHandoff.packs.map((pack) => (
                  <li className="ws-row" key={pack.id}>
                    <div className="dws-run">
                      <div className="dws-run-title">
                        {pack.title}
                        <span className="ws-badge ws-badge-soft">v{pack.version}</span>
                      </div>
                      <div className="dws-run-sub">
                        {pack.createdAt}
                        {pack.agentSessionTitle
                          ? ` · 会话：${pack.agentSessionTitle}${pack.agentSessionAvailable ? "" : "（已失效）"}`
                          : ""}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="dws-section">
            <div className="dws-subhead">
              人工验收记录（{visibleHandoff.acceptanceRecords.length}）
              {visibleHandoff.latestAcceptanceVerdict && (
                <span className="dws-latest">
                  最新结论：
                  <VerdictBadge verdict={visibleHandoff.latestAcceptanceVerdict} />
                </span>
              )}
            </div>
            {visibleHandoff.acceptanceRecords.length === 0 ? (
              <div className="ws-empty">暂无人工验收记录；Agent 自述完成不会自动产生验收结论。</div>
            ) : (
              <ul className="ws-list">
                {visibleHandoff.acceptanceRecords.map((rec) => (
                  <li className="ws-row" key={rec.id}>
                    <div className="dws-run">
                      <div className="dws-run-title">
                        <VerdictBadge verdict={rec.verdict} />
                        <span className="dws-run-sub">{rec.summary || "（无摘要）"}</span>
                      </div>
                      <div className="dws-run-sub">
                        {rec.createdAt}
                        {rec.evidence.length > 0 ? ` · 证据 ${rec.evidence.length} 项` : ""}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      {!summaryError && summary && summary.tasks.length > 0 && !selectedTaskId && (
        <div className="ws-state" data-tone="muted">请选择上方一个任务查看接续记录。</div>
      )}
    </div>
  );
}
