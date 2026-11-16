//! E2：Agent 任务接续面板。
//!
//! 红线：Agent 轮次 `completed` 只是「Agent 自述完成」，绝不自动判定验收通过；
//! 验收结论只能来自 `dev_acceptance_records` 的人工记录，界面必须区分两者。

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

export default function AgentsPanel({ projectId, archived }: CreativeModuleProps) {
  const [summary, setSummary] = useState<DwsDevelopmentSummary | null>(null);
  const [handoff, setHandoff] = useState<DwsTaskHandoff | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [loadingSummary, setLoadingSummary] = useState(false);
  const [loadingHandoff, setLoadingHandoff] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seqRef = useRef(0);

  const loadSummary = useCallback(() => {
    const seq = ++seqRef.current;
    setLoadingSummary(true);
    setError(null);
    dwsDevelopmentSummary(projectId)
      .then(({ summary }) => {
        if (seq !== seqRef.current) return;
        setSummary(summary);
        setSelectedTaskId((prev) => prev ?? summary.tasks[0]?.taskId ?? null);
      })
      .catch((e) => {
        if (seq !== seqRef.current) return;
        setError(errorMessage(e));
      })
      .finally(() => {
        if (seq === seqRef.current) setLoadingSummary(false);
      });
  }, [projectId]);

  useEffect(() => {
    loadSummary();
  }, [loadSummary]);

  const loadHandoff = useCallback(
    (taskId: string) => {
      const seq = ++seqRef.current;
      setLoadingHandoff(true);
      setError(null);
      dwsTaskHandoff(projectId, taskId)
        .then(({ handoff }) => {
          if (seq !== seqRef.current) return;
          setHandoff(handoff);
        })
        .catch((e) => {
          if (seq !== seqRef.current) return;
          setError(errorMessage(e));
        })
        .finally(() => {
          if (seq === seqRef.current) setLoadingHandoff(false);
        });
    },
    [projectId],
  );

  useEffect(() => {
    if (selectedTaskId) loadHandoff(selectedTaskId);
  }, [selectedTaskId, loadHandoff]);

  const tasks: DwsTaskRef[] = summary?.tasks ?? [];

  return (
    <div className="dws-panel">
      <div className="ws-card-head">
        <h2 className="dws-title">Agent 任务接续</h2>
      </div>

      {archived && (
        <div className="ws-notice" data-tone="info">
          <span>项目已归档：接续记录只读展示。</span>
        </div>
      )}

      {error && (
        <div className="ws-notice" data-tone="error">
          <span>{error}</span>
          <button type="button" className="ws-btn ws-btn-quiet" onClick={loadSummary}>重试</button>
        </div>
      )}

      {!error && loadingSummary && (
        <div className="ws-state" data-tone="muted">正在加载关联任务…</div>
      )}

      {!error && !loadingSummary && tasks.length === 0 && (
        <div className="ws-empty">
          还没有关联任务。先在开发工作台把既有任务关联到本项目，这里会展示交接包、Agent 轮次与验收记录。
        </div>
      )}

      {tasks.length > 0 && (
        <div className="dws-task-switch">
          {tasks.map((task) => (
            <button
              key={task.taskId}
              type="button"
              className={`ws-btn ws-btn-quiet ${task.taskId === selectedTaskId ? "dws-active" : ""}`}
              onClick={() => setSelectedTaskId(task.taskId)}
            >
              {task.title}
            </button>
          ))}
        </div>
      )}

      {handoff && (
        <>
          <div className="ws-notice" data-tone="info">
            <span>
              Agent 完成轮次不等于验收通过；本面板的验收结论只以下方「人工验收记录」为准。
            </span>
          </div>

          <section className="dws-section">
            <div className="dws-subhead">Agent 执行轮次（{handoff.agentCandidates.length}）</div>
            {handoff.agentCandidates.length === 0 ? (
              <div className="ws-empty">暂无 Agent 自述完成的轮次。</div>
            ) : (
              <ul className="ws-list">
                {handoff.agentCandidates.map((run) => (
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
            <div className="dws-subhead">交接包（{handoff.packs.length}）</div>
            {handoff.packs.length === 0 ? (
              <div className="ws-empty">暂无交接包。</div>
            ) : (
              <ul className="ws-list">
                {handoff.packs.map((pack) => (
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
              人工验收记录（{handoff.acceptanceRecords.length}）
              {handoff.latestAcceptanceVerdict && (
                <span className="dws-latest">
                  最新结论：
                  <VerdictBadge verdict={handoff.latestAcceptanceVerdict} />
                </span>
              )}
            </div>
            {handoff.acceptanceRecords.length === 0 ? (
              <div className="ws-empty">暂无人工验收记录；Agent 自述完成不会自动产生验收结论。</div>
            ) : (
              <ul className="ws-list">
                {handoff.acceptanceRecords.map((rec) => (
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

      {loadingHandoff && (
        <div className="ws-state" data-tone="muted">正在加载接续记录…</div>
      )}
    </div>
  );
}
