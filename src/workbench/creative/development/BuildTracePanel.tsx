//! E3：构建与验收追溯面板。
//!
//! 数据边界：`tmp/integration/` 台账只读解析；显式关联（任务 ↔ buildId / 验收记录）
//! 落本地 `dws_task_links`；不创建第二套构建队列，不触发任何构建动作。
//!
//! ## 可信度约定（本次修复重点）
//! - 构建状态以「状态 + 退出码」联合判定：`failed + exitCode=0`、`succeeded +
//!   exitCode≠0` 都按**状态冲突**显示异常，绝不显示绿色成功；状态缺失时不得
//!   仅凭退出码 0 判成功。
//! - 关联 / 摘要加载失败必须可见并提供重试，不允许 `catch(() => undefined)`。
//! - 关联记录必须有可读标题（任务标题 / 任务 ID / 「未关联任务」），不留空白行。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CreativeModuleProps } from "../types";
import { errorMessage } from "../../../lib/errors";
import {
  dwsBuildTrace,
  dwsDevelopmentSummary,
  dwsRevealPath,
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

/** 台账状态 → 中文。未知状态原样回显，不冒充已知语义。 */
const BUILD_STATUS_LABELS: Record<string, string> = {
  succeeded: "成功",
  success: "成功",
  failed: "失败",
  failure: "失败",
  running: "进行中",
  building: "构建中",
  pending: "排队中",
  queued: "排队中",
  cancelled: "已取消",
  canceled: "已取消",
  skipped: "已跳过",
  blocked: "阻塞",
  timeout: "超时",
  unknown: "未知",
};

export type BuildBadgeTone = "ok" | "bad" | "warn";

export interface BuildStatusView {
  tone: BuildBadgeTone;
  label: string;
  /** 状态与退出码冲突 / 缺证据时的说明，用于 data-tip 与测试断言。 */
  hint: string | null;
}

/**
 * 构建状态判定（导出以便单测）：状态优先、退出码做交叉校验。
 *
 * 优先级：
 * 1. 状态与退出码冲突（failed+0 / succeeded+非 0）→ 异常（红）；
 * 2. 状态明确成功且退出码为 0 → 成功（绿）；成功但无退出码 → 琥珀（证据不足）；
 * 3. 状态明确失败 / 非 0 退出码 → 失败（红）；
 * 4. 状态缺失或未知 → 琥珀，绝不因 `exitCode=0` 单独判成功。
 */
export function describeBuildStatus(status: string, exitCode: number | null): BuildStatusView {
  const raw = (status ?? "").trim();
  const key = raw.toLowerCase();
  const label = BUILD_STATUS_LABELS[key] ?? (raw || "未知");
  const conflict =
    (key === "succeeded" && exitCode !== null && exitCode !== 0) ||
    (key === "failed" && exitCode === 0);
  if (conflict) {
    return {
      tone: "bad",
      label: `${label}（退出码 ${exitCode}，状态冲突）`,
      hint: "构建状态与退出码不一致，按异常处理；请核对构建日志后再判定。",
    };
  }
  if (key === "succeeded" || key === "success") {
    if (exitCode === null) {
      return {
        tone: "warn",
        label: "成功（退出码未记录）",
        hint: "台账声称成功但没有退出码记录，证据不足，请以构建日志为准。",
      };
    }
    return { tone: "ok", label: "成功", hint: null };
  }
  if (key === "failed" || key === "failure") {
    return { tone: "bad", label: "失败", hint: exitCode === null ? "台账未记录退出码。" : null };
  }
  if (!raw || key === "unknown") {
    return {
      tone: "warn",
      label: exitCode === 0 ? "未知（退出码 0）" : "未知",
      hint: "台账没有可识别的构建状态，不能仅凭退出码判定成功。",
    };
  }
  if (exitCode !== null && exitCode !== 0) {
    return { tone: "bad", label: `${label}（退出码 ${exitCode}）`, hint: null };
  }
  return { tone: "warn", label, hint: null };
}

function badgeClass(tone: BuildBadgeTone): string {
  return tone === "ok" ? "ws-badge-available" : tone === "bad" ? "ws-badge-unavailable" : "ws-badge-limited";
}

function BuildStatusBadge({ status, exitCode }: { status: string; exitCode: number | null }) {
  const view = describeBuildStatus(status, exitCode);
  return (
    <span className={`ws-badge ${badgeClass(view.tone)}`} data-tip={view.hint ?? undefined}>
      {view.label}
    </span>
  );
}

function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  return `${Math.floor(total / 60)}m ${total % 60}s`;
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 台账里的相对日志路径按记录来源仓库根目录拼成绝对路径；绝对路径原样返回。 */
export function resolveLedgerPath(repoRoot: string, rawPath: string | null): string | null {
  if (!rawPath) return null;
  if (/^[A-Za-z]:[\\/]/.test(rawPath) || rawPath.startsWith("/") || rawPath.startsWith("\\\\")) {
    return rawPath;
  }
  if (!repoRoot) return null;
  const root = repoRoot.replace(/[\\/]+$/, "");
  const rel = rawPath.replace(/^[\\/]+/, "").replace(/\//g, "\\");
  return `${root}\\${rel}`;
}

function reveal(repoRoot: string, path: string | null, onNotice: CreativeModuleProps["onNotice"], label: string) {
  const target = resolveLedgerPath(repoRoot, path);
  if (!target) {
    onNotice("error", `${label}路径未记录，无法定位。`);
    return;
  }
  dwsRevealPath(target).catch((e) => onNotice("error", `${label}打开失败：${errorMessage(e)}`));
}

function LedgerTaskRow({ task }: { task: DwsLedgerTask }) {
  return (
    <li className="ws-row">
      <div className="dws-run">
        <div className="dws-run-title">
          {task.id || "（未命名任务）"}
          <span className="ws-badge ws-badge-soft">{task.module || "—"}</span>
          <span className="ws-badge ws-badge-soft">{task.status || "未知状态"}</span>
        </div>
        <div className="dws-run-sub">
          来源：{task.repoName || "手工台账"}
          {task.owner ? ` · 负责人：${task.owner}` : ""}
          {task.buildId ? ` · 构建：${task.buildId}` : ""}
          {task.snapshot ? ` · 快照：${task.snapshot}` : ""}
        </div>
        {task.paths.length > 0 && <div className="dws-run-sub">路径：{task.paths.join("、")}</div>}
        {task.checks.length > 0 && (
          <div className="dws-run-sub">
            检查：{task.checks.map((c) => `${c.cmd}（exit ${c.exitCode ?? "?"}）`).join("；")}
          </div>
        )}
      </div>
    </li>
  );
}

function BuildRow({ build, onNotice }: { build: DwsLedgerBuild; onNotice: CreativeModuleProps["onNotice"] }) {
  const artifactSummary = build.artifacts.length === 0
    ? "无产物记录"
    : build.artifacts
        .map((a) => `${a.name}（${a.files ?? "?"} 文件 / ${formatBytes(a.bytes)}${a.sha256 ? ` / ${a.sha256.slice(0, 8)}` : ""}）`)
        .join("；");
  return (
    <li className="ws-row">
      <div className="dws-run">
        <div className="dws-run-title">
          {build.id || "（未命名构建）"}
          <BuildStatusBadge status={build.status} exitCode={build.exitCode} />
          <span className="ws-badge ws-badge-soft">
            {build.platform || "未知平台"}
            {build.config ? ` / ${build.config}` : ""}
          </span>
        </div>
        <div className="dws-run-sub">
          来源：{build.repoName || "手工台账"}
          {build.snapshot ? ` · 快照：${build.snapshot}` : ""}
          {build.host ? ` · 主机：${build.host}` : ""}
        </div>
        <div className="dws-run-sub">
          提交：{build.shortCommit ?? build.commit ?? "无提交记录"}
          {build.dirty !== null ? (build.dirty ? " · 工作树脏" : " · 工作树干净") : ""}
          {` · 退出码：${build.exitCode ?? "未记录"}`}
        </div>
        <div className="dws-run-sub">
          开始：{build.startedAt ?? "—"} · 结束：{build.finishedAt ?? "—"} · 耗时：{formatDuration(build.durationMs)}
        </div>
        {build.tasks.length > 0 && <div className="dws-run-sub">关联任务：{build.tasks.join("、")}</div>}
        <div className="dws-run-sub">产物：{artifactSummary}</div>
        {build.artifacts.length > 0 && (
          <div className="dws-run-sub">台账未记录产物路径，无法直接定位；可打开构建目录核对。</div>
        )}
        {build.logPath && (
          <div className="dws-run-sub" data-tip={build.logPath}>日志：{build.logPath}</div>
        )}
        <div className="dws-actions">
          <button
            type="button"
            className="ws-btn ws-btn-quiet"
            disabled={!build.logPath}
            onClick={() => reveal(build.repoRoot, build.logPath, onNotice, "构建日志")}
          >
            打开日志位置
          </button>
          <button
            type="button"
            className="ws-btn ws-btn-quiet"
            disabled={!build.repoRoot || !build.id}
            onClick={() =>
              reveal(
                build.repoRoot,
                build.id ? `tmp/integration/builds/${build.id}` : null,
                onNotice,
                "构建目录",
              )
            }
          >
            打开构建目录
          </button>
        </div>
      </div>
    </li>
  );
}

function SnapshotRow({ snap }: { snap: DwsLedgerSnapshot }) {
  return (
    <li className="ws-row">
      <div className="dws-run">
        <div className="dws-run-title">
          {snap.id || "（未命名快照）"}
          {snap.commit && <span className="ws-badge ws-badge-soft">{snap.commit.slice(0, 8)}</span>}
        </div>
        <div className="dws-run-sub">
          来源：{snap.repoName || "手工台账"}
          {snap.branch ? ` · ${snap.branch}` : ""}
          {snap.base ? ` · 基线 ${snap.base}` : ""}
          {snap.note ? ` · ${snap.note}` : ""}
          {snap.createdAt ? ` · ${snap.createdAt}` : ""}
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
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const [formTaskId, setFormTaskId] = useState<string>("");
  const [formBuildId, setFormBuildId] = useState("");
  const [formNote, setFormNote] = useState("");
  const seqRef = useRef(0);
  const summarySeqRef = useRef(0);

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

  const loadSummary = useCallback(() => {
    const seq = ++summarySeqRef.current;
    setSummaryLoading(true);
    setSummaryError(null);
    dwsDevelopmentSummary(projectId)
      .then(({ summary }) => {
        if (seq !== summarySeqRef.current) return;
        setSummary(summary);
      })
      .catch((e) => {
        if (seq !== summarySeqRef.current) return;
        // 任务清单失败必须可见：否则「选择任务」下拉会静默变成空列表。
        setSummaryError(errorMessage(e));
      })
      .finally(() => {
        if (seq === summarySeqRef.current) setSummaryLoading(false);
      });
  }, [projectId]);

  useEffect(() => {
    reload();
    loadSummary();
  }, [reload, loadSummary]);

  const saveLink = () => {
    if (saving) return;
    const buildId = formBuildId.trim();
    const note = formNote.trim();
    if (!formTaskId && !buildId) {
      setSaveError("请至少选择任务或填写构建 buildId（备注不能单独构成关联）");
      return;
    }
    if (buildId && !/^[A-Za-z0-9._:-]+$/.test(buildId)) {
      setSaveError("buildId 只能包含字母、数字、点、下划线、冒号或连字符");
      return;
    }
    if (note.length > 500) {
      setSaveError("备注超过 500 字上限");
      return;
    }
    setSaving(true);
    setSaveError(null);
    dwsTaskLinkSave({
      projectId,
      taskId: formTaskId || null,
      buildId: buildId || null,
      note: note || null,
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
    // 重复删除保护：同一时刻只允许一个删除请求，按钮同步置灰。
    if (deletingId) return;
    setDeletingId(link.id);
    dwsTaskLinkDelete(projectId, link.id)
      .then(() => reload())
      .catch((e) => onNotice("error", errorMessage(e)))
      .finally(() => setDeletingId(null));
  };

  const tasks = summary?.tasks ?? [];

  // 构建按 startedAt 倒序；快照按 createdAt 倒序（后端已排序，这里再兜一层，
  // 避免手工指定台账 / 多个来源拼接后顺序退化）。
  const sortedBuilds = useMemo(
    () =>
      [...(trace?.builds ?? [])].sort((a, b) =>
        (b.startedAt ?? "").localeCompare(a.startedAt ?? ""),
      ),
    [trace],
  );
  const sortedSnapshots = useMemo(
    () =>
      [...(trace?.snapshots ?? [])].sort((a, b) =>
        (b.createdAt ?? "").localeCompare(a.createdAt ?? ""),
      ),
    [trace],
  );

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

      {summaryError && (
        <div className="ws-notice" data-tone="error">
          <span>关联任务清单加载失败：{summaryError}</span>
          <button type="button" className="ws-btn ws-btn-quiet" onClick={loadSummary}>重试</button>
        </div>
      )}

      {!error && trace && !trace.ledgerAvailable && (
        <div className="ws-notice" data-tone="info">
          <span>
            集成台账暂不可用：{trace.ledgerReason ?? "未找到台账目录"}。
            本面板只展示本地显式关联与人工验收记录。
          </span>
        </div>
      )}

      {!error && trace && trace.ledgerAvailable && trace.sources.length > 0 && (
        <section className="dws-section">
          <div className="dws-subhead">台账来源（{trace.sources.length}）</div>
          <ul className="ws-list">
            {trace.sources.map((s) => (
              <li className="ws-row" key={`${s.devProjectId ?? "manual"}:${s.ledgerDir ?? s.repoRoot}`}>
                <div className="dws-run">
                  <div className="dws-run-title">
                    {s.name}
                    <span className={`ws-badge ${s.available ? "ws-badge-available" : "ws-badge-unavailable"}`}>
                      {s.available ? "可读" : "不可用"}
                    </span>
                    {s.truncated && <span className="ws-badge ws-badge-limited">已截断</span>}
                  </div>
                  <div className="dws-run-sub" data-tip={s.ledgerDir ?? s.repoRoot}>
                    {s.ledgerDir ?? s.repoRoot}
                  </div>
                  {s.available && (
                    <div className="dws-run-sub">
                      任务 {s.taskCount} · 快照 {s.snapshotCount} · 构建 {s.buildCount}
                    </div>
                  )}
                  {s.reason && <div className="dws-run-sub">说明：{s.reason}</div>}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {!error && trace && (
        <>
          <section className="dws-section">
            <div className="dws-subhead">本地显式关联（{trace.links.length}）</div>
            {trace.links.length === 0 ? (
              <div className="ws-empty">暂无手工关联；可在下方把任务与构建版本关联起来。</div>
            ) : (
              <ul className="ws-list">
                {trace.links.map((link) => {
                  const title = link.taskTitle ?? (link.taskId ? `任务 ${link.taskId}` : "未关联任务");
                  return (
                    <li className="ws-row" key={link.id}>
                      <div className="dws-run">
                        <div className="dws-run-title">
                          {title}
                          {link.devProjectName && (
                            <span className="ws-badge ws-badge-soft">{link.devProjectName}</span>
                          )}
                          {link.buildId && (
                            <span className="ws-badge ws-badge-soft">构建 {link.buildId}</span>
                          )}
                          {link.acceptanceVerdict && (
                            <span className="ws-badge ws-badge-soft">
                              验收：{VERDICT_LABELS[link.acceptanceVerdict] ?? link.acceptanceVerdict}
                            </span>
                          )}
                        </div>
                        {(link.handoffTitle || link.note) && (
                          <div className="dws-run-sub">
                            {link.handoffTitle ? `交接包：${link.handoffTitle}` : ""}
                            {link.handoffTitle && link.note ? " · " : ""}
                            {link.note}
                          </div>
                        )}
                        <div className="dws-run-sub">更新于 {link.updatedAt}</div>
                      </div>
                      {!archived && (
                        <button
                          type="button"
                          className="ws-btn ws-btn-danger"
                          onClick={() => removeLink(link)}
                          disabled={deletingId !== null}
                        >
                          {deletingId === link.id ? "移除中…" : "移除"}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}

            {!archived && (
              <div className="dws-link-form">
                <select
                  className="ws-input"
                  value={formTaskId}
                  onChange={(e) => setFormTaskId(e.target.value)}
                  aria-label="关联任务"
                  disabled={summaryLoading}
                >
                  <option value="">{summaryLoading ? "任务加载中…" : "选择任务"}</option>
                  {tasks.map((t) => (
                    <option key={t.taskId} value={t.taskId}>{t.title}</option>
                  ))}
                </select>
                <input
                  className="ws-input"
                  placeholder="构建 buildId（如 b02-web-r1）"
                  value={formBuildId}
                  onChange={(e) => setFormBuildId(e.target.value)}
                  aria-label="构建 buildId"
                />
                <input
                  className="ws-input"
                  placeholder="备注（可选）"
                  value={formNote}
                  onChange={(e) => setFormNote(e.target.value)}
                  aria-label="关联备注"
                />
                <button type="button" className="ws-btn ws-btn-primary" onClick={saveLink} disabled={saving}>
                  {saving ? "保存中…" : "保存关联"}
                </button>
                {saveError && <span className="dws-save-error" role="alert">{saveError}</span>}
              </div>
            )}
          </section>

          <section className="dws-section">
            <div className="dws-subhead">构建记录（{sortedBuilds.length}）</div>
            {sortedBuilds.length === 0 ? (
              <div className="ws-empty">台账中暂无构建记录。</div>
            ) : (
              <ul className="ws-list">
                {sortedBuilds.map((b) => <BuildRow key={`${b.repoRoot}:${b.id}`} build={b} onNotice={onNotice} />)}
              </ul>
            )}
          </section>

          <section className="dws-section">
            <div className="dws-subhead">台账任务（{trace.tasks.length}）</div>
            {trace.tasks.length === 0 ? (
              <div className="ws-empty">台账中暂无任务记录。</div>
            ) : (
              <ul className="ws-list">
                {trace.tasks.map((t) => <LedgerTaskRow key={`${t.repoRoot}:${t.id}`} task={t} />)}
              </ul>
            )}
          </section>

          <section className="dws-section">
            <div className="dws-subhead">集成快照（{sortedSnapshots.length}）</div>
            {sortedSnapshots.length === 0 ? (
              <div className="ws-empty">暂无快照记录。</div>
            ) : (
              <ul className="ws-list">
                {sortedSnapshots.map((s) => <SnapshotRow key={`${s.repoRoot}:${s.id}`} snap={s} />)}
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
