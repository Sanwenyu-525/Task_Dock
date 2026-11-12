//! 验收工作台区块（dev workbench Round 1）。
//!
//! 验收对象 = 当前任务 + 其关联规划功能（经任务↔Agent 会话↔功能真实关联链查询，
//! 绝不按标题相似度推断）；查询失败如实展示，不伪造「无关联」。
//!
//! 边界文案与设计红线：
//! - Agent 完成状态 ≠ 验收通过；自动化测试通过 ≠ 人工验收通过（区块内明示）。
//! - 验收记录追加式：只有创建，无更新/删除入口；历史不可覆盖。
//! - summary 必填：为空时四个验收动作全部禁用，绝不提交空结论。
//! - 返工提示词 / 返工任务只在最新判定为 fail 时提供。

import { useCallback, useEffect, useMemo, useState } from "react";
import { ClipboardCheck, History, ListChecks, ScrollText } from "lucide-react";
import {
  createTask,
  devAcceptanceRecordCreate,
  devAcceptanceRecordList,
  fetchTask,
  listTaskLinks,
  planningListAgentFeatureLinks,
  planningListFeatures,
  type DevAcceptanceRecord,
  type PlanningFeature,
  type Task,
} from "../../lib/bridge";
import { copyText } from "../../lib/clipboard";
import { errorMessage, normalizeError } from "../../lib/errors";
import {
  deriveAcceptanceState,
  type DerivedAcceptanceState,
  type DevVerdict,
} from "../../lib/acceptanceStatus";
import { formatRelative } from "../../lib/format";
import { useLocale } from "../../hooks/useLocale";
import { useUiStore } from "../../store/useUiStore";
import { useSettingsStore } from "../../store/useSettingsStore";
import type { MessageKey } from "../../i18n";

/** 关联会话查询上限：单任务的 Agent 关联通常个位数，超限截断并如实不再扩大查询。 */
const MAX_SESSION_LINKS = 12;

/** 当前任务关联的规划功能（含所在项目名，便于区分同名功能）。 */
export interface DevLinkedFeature {
  feature: PlanningFeature;
  projectName: string;
}

/**
 * 查询当前任务关联的规划功能：tasks 链接的 Agent 会话 → 功能-会话关联（status=linked）
 * → 按项目拉取功能详情。任何一步失败都抛错，由调用方如实展示（不得静默当「无关联」）。
 */
export async function findFeaturesForTask(taskId: string): Promise<DevLinkedFeature[]> {
  const links = await listTaskLinks(taskId);
  if (links.length === 0) return [];
  const sessionLinks = await Promise.allSettled(
    links
      .slice(0, MAX_SESSION_LINKS)
      .map((l) => planningListAgentFeatureLinks(l.source_id, l.session_external_id)),
  );
  /** feature_id → 项目（来自真实关联行；同一功能可能被多条会话链接重复指向）。 */
  const byFeature = new Map<string, string>();
  let linkFailures = 0;
  for (const r of sessionLinks) {
    if (r.status !== "fulfilled") {
      linkFailures += 1;
      continue;
    }
    for (const fl of r.value) {
      if (fl.status === "linked" && !byFeature.has(fl.feature_id)) {
        byFeature.set(fl.feature_id, fl.project_name);
      }
    }
  }
  if (byFeature.size === 0) {
    // 全部会话级查询失败 ≠ 没有关联：如实抛错，让调用方展示「查询失败」
    if (linkFailures === sessionLinks.length && sessionLinks.length > 0) {
      throw new Error("feature link query failed");
    }
    return [];
  }
  const projectIds = [...new Set(byFeature.values())];
  const projectFeats = await Promise.allSettled(
    projectIds.map((pid) => planningListFeatures(pid)),
  );
  const out: DevLinkedFeature[] = [];
  let projectFailures = 0;
  for (const r of projectFeats) {
    if (r.status !== "fulfilled") {
      projectFailures += 1;
      continue;
    }
    for (const f of r.value) {
      const projectName = byFeature.get(f.id);
      if (projectName !== undefined) out.push({ feature: f, projectName });
    }
  }
  // 关联存在但功能详情全部拉取失败：同样如实抛错
  if (out.length === 0 && projectFailures === projectFeats.length) {
    throw new Error("feature detail query failed");
  }
  return out;
}

/** 任务读取失败的展示口径：只把「任务本身不存在」显示为失效，其余按读取失败。 */
function isTaskMissingError(raw: unknown): boolean {
  const err = normalizeError(raw);
  if (err.code === "NOT_FOUND") return true;
  if (!err.legacy) return false;
  return /not[_ ]?found|不存在|no rows|未找到/i.test(err.message);
}

/** 派生状态 → 徽章 i18n key 与色调。 */
const STATE_META: Record<DerivedAcceptanceState, { key: MessageKey; tone: string }> = {
  pending_dev: { key: "devwork.acceptance.state.pending_dev", tone: "muted" },
  in_dev: { key: "devwork.acceptance.state.in_dev", tone: "running" },
  awaiting: { key: "devwork.acceptance.state.awaiting", tone: "waiting" },
  in_review: { key: "devwork.acceptance.state.in_review", tone: "waiting" },
  rejected: { key: "devwork.acceptance.state.rejected", tone: "failed" },
  accepted: { key: "devwork.acceptance.state.accepted", tone: "ok" },
  blocked: { key: "devwork.acceptance.state.blocked", tone: "failed" },
  unlinked: { key: "devwork.acceptance.state.unlinked", tone: "muted" },
};

/** 四个验收动作（顺序固定，与 UI 一致）；动作按钮与历史徽章共用同一组文案。 */
const VERDICT_LABELS: Record<DevVerdict, MessageKey> = {
  pass: "devwork.acceptance.verdict.pass",
  fail: "devwork.acceptance.verdict.fail",
  blocked: "devwork.acceptance.verdict.blocked",
  not_verified: "devwork.acceptance.verdict.not_verified",
};

const VERDICT_ACTIONS: { verdict: DevVerdict; key: MessageKey; tone: string }[] = [
  { verdict: "pass", key: VERDICT_LABELS.pass, tone: "ok" },
  { verdict: "fail", key: VERDICT_LABELS.fail, tone: "failed" },
  { verdict: "blocked", key: VERDICT_LABELS.blocked, tone: "failed" },
  { verdict: "not_verified", key: VERDICT_LABELS.not_verified, tone: "muted" },
];

/** 历史记录倒序（createdAt 降序；同刻按 id 稳定排序，不依赖后端返回顺序）。 */
function sortRecordsDesc(records: DevAcceptanceRecord[]): DevAcceptanceRecord[] {
  return [...records].sort((a, b) =>
    a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : b.createdAt.localeCompare(a.createdAt),
  );
}

export default function DevAcceptanceSection() {
  const { t } = useLocale();
  const showToast = useUiStore((s) => s.showToast);
  const taskId = useSettingsStore((s) => s.settings?.workbench_current_task ?? "") || null;

  const [task, setTask] = useState<Task | null>(null);
  const [taskMissing, setTaskMissing] = useState(false);
  const [taskError, setTaskError] = useState<string | null>(null);
  const [features, setFeatures] = useState<DevLinkedFeature[] | null>(null);
  const [featureError, setFeatureError] = useState<string | null>(null);
  const [records, setRecords] = useState<DevAcceptanceRecord[] | null>(null);
  const [recordsError, setRecordsError] = useState<string | null>(null);

  const [summary, setSummary] = useState("");
  const [evidenceInput, setEvidenceInput] = useState("");
  const [evidenceDraft, setEvidenceDraft] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  /** 无关联功能时的手填验收标准（仅本页草稿；不落库）。 */
  const [manualCriteria, setManualCriteria] = useState<string[]>([]);
  const [criteriaInput, setCriteriaInput] = useState("");
  const [reworkBusy, setReworkBusy] = useState(false);

  useEffect(() => {
    setTask(null);
    setTaskMissing(false);
    setTaskError(null);
    setFeatures(null);
    setFeatureError(null);
    setRecords(null);
    setRecordsError(null);
    setSummary("");
    setEvidenceDraft([]);
    setEvidenceInput("");
    setManualCriteria([]);
    setCriteriaInput("");
  }, [taskId]);

  useEffect(() => {
    if (!taskId) return;
    let alive = true;
    fetchTask(taskId)
      .then((task) => {
        if (alive) {
          setTask(task);
          setTaskError(null);
        }
      })
      .catch((e) => {
        if (!alive) return;
        if (isTaskMissingError(e)) setTaskMissing(true);
        else setTaskError(errorMessage(e));
      });
    findFeaturesForTask(taskId)
      .then((rows) => {
        if (alive) {
          setFeatures(rows);
          setFeatureError(null);
        }
      })
      .catch((e) => {
        if (alive) setFeatureError(errorMessage(e));
      });
    return () => {
      alive = false;
    };
  }, [taskId]);

  const loadRecords = useCallback((id: string) => {
    return devAcceptanceRecordList({ subjectKind: "task", subjectId: id, limit: 20 })
      .then(({ records: rows }) => {
        setRecords(sortRecordsDesc(rows));
        setRecordsError(null);
      })
      .catch((e) => setRecordsError(errorMessage(e)));
  }, []);

  useEffect(() => {
    if (!taskId) return;
    void loadRecords(taskId);
  }, [taskId, loadRecords]);

  const sortedRecords = useMemo(() => records ?? [], [records]);
  const latestVerdict = sortedRecords[0]?.verdict ?? null;
  const latestFail = sortedRecords.find((r) => r.verdict === "fail") ?? null;
  const primaryFeature = features?.[0] ?? null;

  const derived = useMemo(
    () =>
      deriveAcceptanceState({
        featureStatus: primaryFeature?.feature.status ?? null,
        taskStatus: task?.status ?? null,
        latestVerdict,
        hasSubject: task !== null,
      }),
    [primaryFeature, task, latestVerdict],
  );

  /** 验收标准：有关联功能用功能的 acceptance_criteria（只读），否则用手填清单。 */
  const featureCriteria = useMemo(() => {
    for (const f of features ?? []) {
      const lines = f.feature.acceptance_criteria
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      if (lines.length > 0) return lines;
    }
    return [];
  }, [features]);
  const criteria = featureCriteria.length > 0 ? featureCriteria : manualCriteria;
  const criteriaText = criteria.join("\n");

  const summaryFilled = summary.trim().length > 0;

  const createRecord = useCallback(
    (verdict: DevVerdict) => {
      if (!taskId || !task || !summaryFilled || creating) return;
      setCreating(true);
      devAcceptanceRecordCreate({
        subjectKind: "task",
        subjectId: taskId,
        verdict,
        summary: summary.trim(),
        evidence: evidenceDraft,
      })
        .then(() => {
          showToast(t("devwork.acceptance.recordCreated"), { kind: "success" });
          setSummary("");
          setEvidenceDraft([]);
          setEvidenceInput("");
          return loadRecords(taskId);
        })
        .catch((e) => {
          showToast(
            t("devwork.acceptance.recordCreateFailed", { error: errorMessage(e) }),
            { kind: "error" },
          );
        })
        .finally(() => setCreating(false));
    },
    [creating, evidenceDraft, loadRecords, showToast, summaryFilled, t, task, taskId],
  );

  /** 返工提示词：只在最新判定为 fail 时可用；复制失败如实提示，不影响任何状态。 */
  const reworkPrompt = useMemo(() => {
    if (!task || !latestFail) return null;
    return (
      `针对任务「${task.title}」的返工请求：\n\n` +
      `验收不通过原因：\n${latestFail.summary}\n\n` +
      `验收标准：\n${criteriaText || "（未填写）"}\n\n` +
      `请修复后重新提交验收。`
    );
  }, [criteriaText, latestFail, task]);

  const copyReworkPrompt = useCallback(() => {
    if (!reworkPrompt || reworkBusy) return;
    setReworkBusy(true);
    copyText(reworkPrompt)
      .then((ok) => {
        showToast(
          ok ? t("devwork.acceptance.reworkCopied") : t("devwork.acceptance.reworkCopyFailed"),
          { kind: ok ? "success" : "error" },
        );
      })
      .finally(() => setReworkBusy(false));
  }, [reworkBusy, reworkPrompt, showToast, t]);

  const createReworkTask = useCallback(() => {
    if (!task || !latestFail || reworkBusy) return;
    setReworkBusy(true);
    createTask({
      title: `【返工】${task.title}`,
      description: latestFail.summary,
    })
      .then((created) => {
        showToast(t("devwork.acceptance.reworkTaskDone", { title: created.title }), {
          kind: "success",
        });
      })
      .catch((e) => {
        showToast(
          t("devwork.acceptance.reworkTaskFailed", { error: errorMessage(e) }),
          { kind: "error" },
        );
      })
      .finally(() => setReworkBusy(false));
  }, [latestFail, reworkBusy, showToast, t, task]);

  const stateMeta = STATE_META[derived.state];

  return (
    <section className="wb-card" aria-label={t("devwork.acceptance.title")}>
      <div className="wb-section-head">
        <h3 className="wb-section-title">
          <ClipboardCheck size={13} aria-hidden="true" /> {t("devwork.acceptance.title")}
        </h3>
        <span className="flex-spacer" />
        <span className={`badge subtle wb-accept-state tone-${stateMeta.tone}`}>
          {t(stateMeta.key)}
        </span>
      </div>

      {/* 边界明示：两类「完成」都不等于验收通过 */}
      <p className="endpoint-hint wb-accept-boundary">{t("devwork.acceptance.boundary")}</p>

      {derived.evidenceInsufficient && (
        <div className="wb-error-row" role="alert">
          <span>{t("devwork.acceptance.evidenceInsufficient")}</span>
        </div>
      )}

      {!taskId && (
        <div className="empty-hint" role="status">
          {t("devwork.acceptance.noSubject")}
        </div>
      )}

      {taskId && taskMissing && (
        <div className="wb-stale" role="alert">
          <span className="wb-stale-text">{t("devwork.acceptance.taskMissing")}</span>
        </div>
      )}

      {taskId && !taskMissing && taskError && (
        <div className="wb-error-row" role="alert">
          <span>{t("workbench.loadFailed", { error: taskError })}</span>
        </div>
      )}

      {taskId && !taskMissing && !taskError && !task && (
        <div className="empty-hint" role="status">
          {t("nav.loading")}
        </div>
      )}

      {featureError && (
        <div className="wb-error-row" role="alert">
          <span>{t("devwork.acceptance.featureLoadFailed", { error: featureError })}</span>
        </div>
      )}

      {task && (
        <>
          <div className="wb-dev-current-head wb-accept-subject">
            <span className="wb-row-title">{t("devwork.acceptance.subjectTask", { title: task.title })}</span>
            {primaryFeature && (
              <span className="wb-row-sub">
                {t("devwork.acceptance.featureLinked", {
                  title: primaryFeature.feature.title,
                  project: primaryFeature.projectName,
                  status: t(`devwork.acceptance.fs.${primaryFeature.feature.status}` as MessageKey),
                })}
              </span>
            )}
            {features !== null && features.length > 1 && (
              <span className="wb-row-sub">
                {t("devwork.acceptance.featureMore", { count: features.length - 1 })}
              </span>
            )}
          </div>

          {/* 验收标准：只读展示（关联功能 criteria 优先，否则手填草稿） */}
          <div className="wb-accept-block">
            <div className="wb-links-title">
              <ListChecks size={12} aria-hidden="true" /> {t("devwork.acceptance.criteriaTitle")}
            </div>
            {criteria.length === 0 ? (
              <div className="endpoint-hint">{t("devwork.acceptance.criteriaEmpty")}</div>
            ) : (
              <ul className="wb-accept-criteria">
                {criteria.map((c, i) => (
                  <li key={`${i}:${c}`}>{c}</li>
                ))}
              </ul>
            )}
            {featureCriteria.length === 0 && (
              <div className="wb-accept-criteria-add">
                <input
                  className="wb-accept-criteria-input"
                  value={criteriaInput}
                  onChange={(e) => setCriteriaInput(e.target.value)}
                  aria-label={t("devwork.acceptance.criteriaInputAria")}
                  placeholder={t("devwork.acceptance.criteriaInputPlaceholder")}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      const v = criteriaInput.trim();
                      if (!v) return;
                      setManualCriteria((list) => [...list, v]);
                      setCriteriaInput("");
                    }
                  }}
                />
                <button
                  type="button"
                  className="btn sm"
                  disabled={!criteriaInput.trim()}
                  onClick={() => {
                    const v = criteriaInput.trim();
                    if (!v) return;
                    setManualCriteria((list) => [...list, v]);
                    setCriteriaInput("");
                  }}
                >
                  {t("devwork.acceptance.criteriaAdd")}
                </button>
              </div>
            )}
          </div>

          {/* 手工证据登记 + 验收动作 */}
          <div className="wb-accept-block">
            <label className="field">
              <span>{t("devwork.acceptance.summaryLabel")}</span>
              <input
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
                aria-label={t("devwork.acceptance.summaryLabel")}
                placeholder={t("devwork.acceptance.summaryPlaceholder")}
                maxLength={500}
              />
            </label>
            <div className="wb-accept-evidence-row">
              <input
                className="wb-accept-criteria-input"
                value={evidenceInput}
                onChange={(e) => setEvidenceInput(e.target.value)}
                aria-label={t("devwork.acceptance.evidenceInputAria")}
                placeholder={t("devwork.acceptance.evidenceInputPlaceholder")}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    const v = evidenceInput.trim();
                    if (!v) return;
                    setEvidenceDraft((list) => [...list, v]);
                    setEvidenceInput("");
                  }
                }}
              />
              <button
                type="button"
                className="btn sm"
                disabled={!evidenceInput.trim()}
                onClick={() => {
                  const v = evidenceInput.trim();
                  if (!v) return;
                  setEvidenceDraft((list) => [...list, v]);
                  setEvidenceInput("");
                }}
              >
                {t("devwork.acceptance.evidenceAdd")}
              </button>
            </div>
            {evidenceDraft.length === 0 ? (
              <div className="endpoint-hint">{t("devwork.acceptance.evidenceEmpty")}</div>
            ) : (
              <ul className="wb-accept-evidence">
                {evidenceDraft.map((e, i) => (
                  <li key={`${i}:${e}`}>
                    <span className="wb-row-title">{e}</span>
                    <button
                      type="button"
                      className="icon-btn sm"
                      aria-label={t("devwork.acceptance.evidenceRemove")}
                      data-tip={t("devwork.acceptance.evidenceRemove")}
                      onClick={() =>
                        setEvidenceDraft((list) => list.filter((_, idx) => idx !== i))
                      }
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="wb-actions wb-accept-actions">
              {VERDICT_ACTIONS.map((a) => (
                <button
                  key={a.verdict}
                  type="button"
                  className={`btn sm wb-accept-verdict tone-${a.tone}`}
                  disabled={!summaryFilled || creating}
                  onClick={() => createRecord(a.verdict)}
                >
                  {t(a.key)}
                </button>
              ))}
            </div>
            {!summaryFilled && (
              <div className="endpoint-hint">{t("devwork.acceptance.summaryRequiredHint")}</div>
            )}
          </div>

          {/* 历史记录（倒序、追加式）：只有查看，没有更新/删除入口 */}
          <div className="wb-accept-block">
            <div className="wb-links-title">
              <History size={12} aria-hidden="true" /> {t("devwork.acceptance.historyTitle")}
              <em className="badge subtle">{sortedRecords.length}</em>
            </div>
            {recordsError && (
              <div className="wb-error-row" role="alert">
                <span>{t("workbench.loadFailed", { error: recordsError })}</span>
              </div>
            )}
            {!recordsError && records === null && (
              <div className="empty-hint" role="status">
                {t("nav.loading")}
              </div>
            )}
            {records !== null && sortedRecords.length === 0 && (
              <div className="endpoint-hint">{t("devwork.acceptance.historyEmpty")}</div>
            )}
            {sortedRecords.map((r) => (
              <div className="wb-row wb-accept-record" key={r.id}>
                <span className={`badge subtle wb-verdict tone-${r.verdict}`}>
                  {t(VERDICT_LABELS[r.verdict])}
                </span>
                <span className="wb-row-main">
                  <span className="wb-row-title">{r.summary}</span>
                  <span className="wb-row-sub">
                    {r.evidence
                      ? r.evidence
                          .split("\n")
                          .filter(Boolean)
                          .map((line, i) => (
                            <span className="wb-accept-evidence-line" key={`${i}:${line}`}>
                              {t("devwork.acceptance.evidenceLine", { index: i + 1 })} {line}
                            </span>
                          ))
                      : t("devwork.acceptance.noEvidence")}
                    <span>{formatRelative(r.createdAt)}</span>
                  </span>
                </span>
              </div>
            ))}
          </div>

          {/* 返工入口：仅最新判定为 fail 时提供 */}
          {latestVerdict === "fail" && (
            <div className="wb-actions wb-accept-rework">
              <button
                type="button"
                className="btn sm"
                disabled={reworkBusy}
                onClick={copyReworkPrompt}
                data-tip={t("devwork.acceptance.reworkPromptTip")}
              >
                <ScrollText size={12} aria-hidden="true" /> {t("devwork.acceptance.reworkPrompt")}
              </button>
              <button
                type="button"
                className="btn sm"
                disabled={reworkBusy}
                onClick={createReworkTask}
              >
                {t("devwork.acceptance.reworkTask")}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
