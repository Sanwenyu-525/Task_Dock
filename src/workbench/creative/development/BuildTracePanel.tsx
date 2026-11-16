//! E3：构建与验收追溯面板。
//!
//! 数据边界：`tmp/integration/` 台账只读解析；显式关联（任务 ↔ buildId / 验收记录）
//! 落本地 `dws_task_links`；不创建第二套构建队列，不触发任何构建动作。

import { useCallback, useEffect, useRef, useState } from "react";
import type { CreativeModuleProps } from "../types";
import { errorMessage } from "../../../lib/errors";
import {
  dwsBuildTrace,
  dwsDevelopmentSummary,
  dwsTaskLinkDelete,
  dwsTaskLinkSave,
} from "./ipc";
import type {
  DwsBuildTrace,
  DwsDevelopmentSummary,
  DwsLedgerBuild,
  DwsLedgerSnapshot,
  DwsLedgerTask,
  DwsTaskLink,
} from "./types";
import { VERDICT_LABELS } from "./types";

function BuildStatusBadge({ status, exitCode }: { status: string; exitCode: number | null }) {
  const tone =
    status === "succeeded" || exitCode === 0
      ? "ws-badge-available"
      : status === "failed" || (exitCode !== null && exitCode !== 0)
        ? "ws-badge-unavailable"
        : "ws-badge-limited";
  return <span className={`ws-badge ${tone}`}>{status || "未知"}</span>;
}

function LedgerTaskRow({ task }: { task: DwsLedgerTask }) {
  return (
    <li className="ws-row">
      <div className="dws-run">
        <div className="dws-run-title">
          {task.id}
          <span className="ws-badge ws-badge-soft">{task.module || "—"}</span>
          <span className="ws-badge ws-badge-soft">{task.status}</span>
        </div>
        <div className="dws-run-sub">
          负责人：{task.owner || "—"}
          {task.buildId ? ` · 构建：${task.buildId}` : ""}
          {task.snapshot ? ` · 快照：${task.snapshot}` : ""}
        </div>
        {task.paths.length > 0 && <div className="dws-run-sub">路径：{task.paths.join("、")}</div>}
        {task.checks.length > 0 && (
          <div className="dws-run-sub">
            检查：{task.checks
              .map((c) => `${c.cmd}（exit ${c.exitCode ?? "?"}）`)
              .join("；")}
          </div>
        )}
      </div>
    </li>
  );
}

function BuildRow({ build }: { build: DwsLedgerBuild }) {
  return (
    <li className="ws-row">
      <div className="dws-run">
        <div className="dws-run-title">
          {build.id}
          <BuildStatusBadge status={build.status} exitCode={build.exitCode} />
          <span className="ws-badge ws-badge-soft">
            {build.platform}
            {build.config ? ` / ${build.config}` : ""}
          </span>
        </div>
        <div className="dws-run-sub">
          {build.shortCommit ?? build.commit ?? "无提交记录"}
          {build.dirty !== null ? (build.dirty ? " · 工作树脏" : " · 干净") : ""}
          {build.durationMs !== null ? ` · ${Math.round(build.durationMs / 1000)}s` : ""}
        </div>
        {build.snapshot && <div className="dws-run-sub">快照：{build.snapshot}</div>}
        {build.logPath && <div className="dws-run-sub" data-tip={build.logPath}>日志：{build.logPath}</div>}
        {build.artifacts.length > 0 && (
          <div className="dws-run-sub">
            产物：{build.artifacts.map((a) => `${a.name}（${a.files ?? "?"} 文件 / ${a.bytes ?? "?"} 字节）`).join("；")}
          </div>
        )}
      </div>
    </li>
  );
}

function SnapshotRow({ snap }: { snap: DwsLedgerSnapshot }) {
  return (
    <li className="ws-row">
      <div className="dws-run">
        <div className="dws-run-title">
          {snap.id}
          {snap.commit && <span className="ws-badge ws-badge-soft">{snap.commit.slice(0, 8)}</span>}
        </div>
        <div className="dws-run-sub">
          {snap.branch ?? "—"}
          {snap.base ? ` · 基线 ${snap.base}` : ""}
          {snap.note ? ` · ${snap.note}` : ""}
        </div>
      </div>
    </li>
  );
}

export default function BuildTracePanel({ projectId, archived, onNotice }: CreativeModuleProps) {
  const [trace, setTrace] = useState<DwsBuildTrace | null>(null);
  const [summary, setSummary] = useState<DwsDevelopmentSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [formTaskId, setFormTaskId] = useState<string>("");
  const [formBuildId, setFormBuildId] = useState("");
  const [formNote, setFormNote] = useState("");
  const seqRef = useRef(0);

  const reload = useCallback(() => {
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    dwsBuildTrace(projectId)
      .then(({ trace }) => {
        if (seq !== seqRef.current) return;
        setTrace(trace);
      })
      .catch((e) => {
        if (seq !== seqRef.current) return;
        setError(errorMessage(e));
        onNotice("error", errorMessage(e));
      })
      .finally(() => {
        if (seq === seqRef.current) setLoading(false);
      });
  }, [projectId, onNotice]);

  useEffect(() => {
    reload();
    dwsDevelopmentSummary(projectId)
      .then(({ summary }) => setSummary(summary))
      .catch(() => undefined);
  }, [reload, projectId]);

  const saveLink = () => {
    if (saving) return;
    setSaving(true);
    setSaveError(null);
    dwsTaskLinkSave({
      projectId,
      taskId: formTaskId || null,
      buildId: formBuildId.trim() || null,
      note: formNote.trim() || null,
    })
      .then(() => {
        setFormTaskId("");
        setFormBuildId("");
        setFormNote("");
        onNotice("ok", "关联已保存");
        reload();
      })
      .catch((e) => setSaveError(errorMessage(e)))
      .finally(() => setSaving(false));
  };

  const removeLink = (link: DwsTaskLink) => {
    dwsTaskLinkDelete(projectId, link.id)
      .then(() => reload())
      .catch((e) => onNotice("error", errorMessage(e)));
  };

  const tasks = summary?.tasks ?? [];

  return (
    <div className="dws-panel">
      <div className="ws-card-head">
        <h2 className="dws-title">构建与验收追溯</h2>
        <button type="button" className="ws-btn ws-btn-quiet" onClick={reload} disabled={loading}>
          {loading ? "加载中…" : "刷新"}
        </button>
      </div>

      {archived && (
        <div className="ws-notice" data-tone="info">
          <span>项目已归档：追溯记录只读展示，不能新增 / 删除关联。</span>
        </div>
      )}

      {error && (
        <div className="ws-notice" data-tone="error">
          <span>{error}</span>
          <button type="button" className="ws-btn ws-btn-quiet" onClick={reload}>重试</button>
        </div>
      )}

      {!error && trace && !trace.ledgerAvailable && (
        <div className="ws-notice" data-tone="info">
          <span>集成台账暂不可用：{trace.ledgerReason ?? "未找到台账目录"}。本面板只展示本地显式关联与人工验收记录。</span>
        </div>
      )}

      {!error && trace && (
        <>
          <section className="dws-section">
            <div className="dws-subhead">本地显式关联（{trace.links.length}）</div>
            {trace.links.length === 0 ? (
              <div className="ws-empty">暂无手工关联；可在下方把任务与构建版本关联起来。</div>
            ) : (
              <ul className="ws-list">
                {trace.links.map((link) => (
                  <li className="ws-row" key={link.id}>
                    <div className="dws-run">
                      <div className="dws-run-title">
                        {link.taskTitle ?? link.taskId}
                        {link.buildId && <span className="ws-badge ws-badge-soft">构建 {link.buildId}</span>}
                        {link.acceptanceVerdict && (
                          <span className="ws-badge ws-badge-soft">
                            {VERDICT_LABELS[link.acceptanceVerdict] ?? link.acceptanceVerdict}
                          </span>
                        )}
                      </div>
                      {link.note && <div className="dws-run-sub">{link.note}</div>}
                    </div>
                    {!archived && (
                      <button
                        type="button"
                        className="ws-btn ws-btn-danger"
                        onClick={() => removeLink(link)}
                      >
                        移除
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {!archived && (
              <div className="dws-link-form">
                <select
                  className="ws-input"
                  value={formTaskId}
                  onChange={(e) => setFormTaskId(e.target.value)}
                  aria-label="关联任务"
                >
                  <option value="">选择任务</option>
                  {tasks.map((t) => (
                    <option key={t.taskId} value={t.taskId}>{t.title}</option>
                  ))}
                </select>
                <input
                  className="ws-input"
                  placeholder="构建 buildId（如 b02-web-r1）"
                  value={formBuildId}
                  onChange={(e) => setFormBuildId(e.target.value)}
                />
                <input
                  className="ws-input"
                  placeholder="备注（可选）"
                  value={formNote}
                  onChange={(e) => setFormNote(e.target.value)}
                />
                <button type="button" className="ws-btn ws-btn-primary" onClick={saveLink} disabled={saving}>
                  {saving ? "保存中…" : "保存关联"}
                </button>
                {saveError && <span className="dws-save-error">{saveError}</span>}
              </div>
            )}
          </section>

          <section className="dws-section">
            <div className="dws-subhead">构建记录（{trace.builds.length}）</div>
            {trace.builds.length === 0 ? (
              <div className="ws-empty">台账中暂无构建记录。</div>
            ) : (
              <ul className="ws-list">
                {trace.builds.map((b) => <BuildRow key={b.id} build={b} />)}
              </ul>
            )}
          </section>

          <section className="dws-section">
            <div className="dws-subhead">台账任务（{trace.tasks.length}）</div>
            {trace.tasks.length === 0 ? (
              <div className="ws-empty">台账中暂无任务记录。</div>
            ) : (
              <ul className="ws-list">
                {trace.tasks.map((t) => <LedgerTaskRow key={t.id} task={t} />)}
              </ul>
            )}
          </section>

          <section className="dws-section">
            <div className="dws-subhead">集成快照（{trace.snapshots.length}）</div>
            {trace.snapshots.length === 0 ? (
              <div className="ws-empty">暂无快照记录。</div>
            ) : (
              <ul className="ws-list">
                {trace.snapshots.map((s) => <SnapshotRow key={s.id} snap={s} />)}
              </ul>
            )}
          </section>

          <section className="dws-section">
            <div className="dws-subhead">人工验收记录（{trace.acceptanceRecords.length}）</div>
            {trace.acceptanceRecords.length === 0 ? (
              <div className="ws-empty">暂无人工验收记录。</div>
            ) : (
              <ul className="ws-list">
                {trace.acceptanceRecords.map((rec) => (
                  <li className="ws-row" key={rec.id}>
                    <div className="dws-run">
                      <div className="dws-run-title">
                        <span className="ws-badge ws-badge-soft">
                          {VERDICT_LABELS[rec.verdict] ?? rec.verdict}
                        </span>
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
    </div>
  );
}
