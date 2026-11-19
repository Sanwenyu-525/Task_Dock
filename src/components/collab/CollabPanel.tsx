//! 协作中心主面板（规划中心第三个数据源）。
//!
//! 需求/Bug → 方案 → 可视化/原型 → 任务 → 验收证据 的完整闭环都在这里可操作；
//! 所有写操作走 `src/lib/collab.ts`（IPC）→ `collab::service::Core`，前端不复制
//! 业务规则（权限、审批状态机、版本冲突均由后端判定）。

import { useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  AlertTriangle,
  Bug,
  CheckCircle2,
  FileText,
  GitBranch,
  Loader2,
  Plus,
  Send,
  Sparkles,
  Workflow,
} from "lucide-react";
import { planningListProjects, type PlanningProject } from "../../lib/bridge";
import {
  collabAiGenerate,
  collabAiJobs,
  collabAiNotice,
  collabEvidenceAttachPath,
  collabEvidenceAttachText,
  collabIssueArchive,
  collabIssueCreate,
  collabIssueGet,
  collabIssueList,
  collabIssueResolve,
  collabIssueVerify,
  collabPlanCreateFromIssue,
  collabPlanCreateTasks,
  collabPlanGet,
  collabPlanList,
  collabPlanProgress,
  collabPlanReview,
  collabPlanSubmit,
  collabPlanUpdate,
  collabVisualGet,
  collabVisualList,
  type AiJob,
  type AiNotice,
  type Issue,
  type IssueDetail,
  type IssueKind,
  type Page,
  type Plan,
  type PlanDetail,
  type PlanProgress,
  type VisualDocument,
} from "../../lib/collab";
import { errorMessage } from "../../lib/errors";
import EmptyState from "../ui/EmptyState";
import Select from "../ui/Select";
import StatusBadge from "../ui/StatusBadge";
import VisualViewer from "./VisualViewer";
import "./collab.css";

type View = "issues" | "bugs" | "plans" | "visuals";

const ISSUE_KIND_LABEL: Record<string, string> = {
  feature: "功能",
  improvement: "优化",
  architecture: "架构",
  performance: "性能",
  security: "安全",
  tech_debt: "技术债",
  bug: "Bug",
  other: "其他",
};

const STATUS_LABEL: Record<string, string> = {
  open: "待处理",
  triaged: "已分诊",
  in_progress: "处理中",
  resolved: "已解决",
  verified: "已验证",
  closed: "已关闭",
  archived: "已归档",
  draft: "草稿",
  in_review: "待审阅",
  changes_requested: "需修改",
  approved: "已批准",
  developing: "开发中",
  accepting: "待验收",
  completed: "已完成",
  published: "已发布",
};

function issueTone(status: string) {
  if (["verified", "closed", "completed", "approved"].includes(status)) return "success" as const;
  if (["archived"].includes(status)) return "neutral" as const;
  if (["resolved", "in_progress", "developing"].includes(status)) return "warning" as const;
  return "info" as const;
}

function priorityTone(priority: string) {
  if (priority === "P0") return "danger" as const;
  if (priority === "P1") return "warning" as const;
  return "neutral" as const;
}

function evidenceKindForPath(path: string) {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "webp", "gif"].includes(ext)) return "screenshot";
  if (["log", "txt"].includes(ext)) return "log";
  if (["mp4", "webm"].includes(ext)) return "video";
  if (ext === "json" || ext === "md") return "report";
  return "other";
}

// 复现步骤用 <ol> 自动编号；用户输入里常见的 “1. / - / •” 前缀会被去掉，避免双重编号。
function reproStepText(step: string) {
  return step.replace(/^\s*(?:\d+[.)、]|[-*•])\s*/, "");
}

interface IssueDraft {
  kind: IssueKind;
  title: string;
  description: string;
  priority: string;
  acceptance: string;
  reproSteps: string;
  expectedResult: string;
  actualResult: string;
  environment: string;
  relatedFiles: string;
}

const EMPTY_DRAFT: IssueDraft = {
  kind: "feature",
  title: "",
  description: "",
  priority: "P2",
  acceptance: "",
  reproSteps: "",
  expectedResult: "",
  actualResult: "",
  environment: "",
  relatedFiles: "",
};

export default function CollabPanel() {
  const [projects, setProjects] = useState<PlanningProject[]>([]);
  const [projectId, setProjectId] = useState("");
  const [view, setView] = useState<View>("issues");
  const [notice, setNotice] = useState<AiNotice | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [issues, setIssues] = useState<Page<Issue> | null>(null);
  const [plans, setPlans] = useState<Page<Plan> | null>(null);
  const [visuals, setVisuals] = useState<Page<VisualDocument> | null>(null);
  const [jobs, setJobs] = useState<AiJob[]>([]);

  const [selectedIssue, setSelectedIssue] = useState<IssueDetail | null>(null);
  const [selectedPlan, setSelectedPlan] = useState<PlanDetail | null>(null);
  const [selectedVisual, setSelectedVisual] = useState<VisualDocument | null>(null);
  const [progress, setProgress] = useState<PlanProgress | null>(null);

  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<IssueDraft>(EMPTY_DRAFT);
  const [noticeDismissed, setNoticeDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    planningListProjects()
      .then((list) => {
        if (cancelled) return;
        setProjects(list);
        const first = list.find((p) => !p.archived) ?? list[0];
        if (first) setProjectId((current) => current || first.id);
      })
      .catch((e) => setError(errorMessage(e)));
    collabAiNotice()
      .then((n) => {
        if (!cancelled) setNotice(n);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const reload = async (pid = projectId) => {
    if (!pid) return;
    setLoading(true);
    setError("");
    try {
      const [issuePage, planPage, visualPage, jobPage] = await Promise.all([
        collabIssueList(pid, { page: 1, pageSize: 50 }),
        collabPlanList(pid, undefined, 1, 50),
        collabVisualList(pid, undefined, 1, 50),
        collabAiJobs(pid),
      ]);
      setIssues(issuePage);
      setPlans(planPage);
      setVisuals(visualPage);
      setJobs(jobPage.items);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void reload(projectId);
    setSelectedIssue(null);
    setSelectedPlan(null);
    setSelectedVisual(null);
    setProgress(null);
    // projectId 变化时重载；reload 依赖 projectId，函数体每次渲染变化不纳入依赖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const openIssue = async (issue: Issue) => {
    setError("");
    setSelectedPlan(null);
    setSelectedVisual(null);
    try {
      setSelectedIssue(await collabIssueGet(issue.id));
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const openPlan = async (plan: Plan) => {
    setError("");
    setSelectedIssue(null);
    setSelectedVisual(null);
    try {
      const detail = await collabPlanGet(plan.id);
      setSelectedPlan(detail);
      setProgress(await collabPlanProgress(plan.id));
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const openVisual = async (doc: VisualDocument) => {
    setError("");
    try {
      setSelectedVisual(await collabVisualGet(doc.id));
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const submitIssue = async () => {
    if (!projectId || !draft.title.trim()) {
      setError("请填写需求标题");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const result = await collabIssueCreate(projectId, {
        kind: draft.kind,
        title: draft.title.trim(),
        description: draft.description,
        priority: draft.priority,
        acceptance: draft.acceptance,
        reproSteps: draft.reproSteps
          .split(/\r?\n/)
          .map((s) => reproStepText(s.trim()))
          .filter(Boolean)
          .slice(0, 30),
        expectedResult: draft.expectedResult.trim() || null,
        actualResult: draft.actualResult.trim() || null,
        environment: draft.environment.trim() || null,
        relatedFiles: draft.relatedFiles
          .split(/[\n,]/)
          .map((s) => s.trim())
          .filter(Boolean)
          .slice(0, 50),
        clientRequestId: `ui-${Date.now()}`,
      });
      setCreating(false);
      setDraft(EMPTY_DRAFT);
      await reload();
      setSelectedIssue(await collabIssueGet(result.issue.id));
      setSelectedPlan(null);
      if (result.duplicateCandidates.length) {
        setError(`已创建；发现 ${result.duplicateCandidates.length} 条相似记录，请在详情中确认是否合并（未自动合并）。`);
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  const createPlan = async (issue: IssueDetail) => {
    setLoading(true);
    setError("");
    try {
      const plan = await collabPlanCreateFromIssue(issue.issue.id);
      await reload();
      setSelectedPlan(await collabPlanGet(plan.id));
      setSelectedIssue(null);
      setProgress(await collabPlanProgress(plan.id));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  const refreshPlan = async (planId: string) => {
    setSelectedPlan(await collabPlanGet(planId));
    setProgress(await collabPlanProgress(planId));
    await reload();
  };

  const filteredIssues = (issues?.items ?? []).filter((i) =>
    view === "bugs" ? i.kind === "bug" : view === "issues" ? i.kind !== "bug" : true,
  );

  return (
    <div className="collab-panel">
      <div className="collab-toolbar">
        <div className="seg-group subtle" role="group" aria-label="协作中心视图">
          {([
            ["issues", "需求"],
            ["bugs", "Bug"],
            ["plans", "方案"],
            ["visuals", "可视化"],
          ] as Array<[View, string]>).map(([key, label]) => (
            <button
              key={key}
              className={`seg-btn ${view === key ? "active" : ""}`}
              onClick={() => {
                setView(key);
                setSelectedIssue(null);
                setSelectedPlan(null);
                setSelectedVisual(null);
              }}
              aria-pressed={view === key}
            >
              {label}
            </button>
          ))}
        </div>
        <label className="collab-project-select">
          <span className="collab-muted">项目</span>
          <Select
            value={projectId}
            options={projects.map((p) => ({ value: p.id, label: p.name }))}
            onChange={setProjectId}
            ariaLabel="选择协作项目"
            size="sm"
          />
        </label>
        {loading ? <Loader2 size={16} className="spin" aria-label="加载中" /> : null}
      </div>

      {notice && notice.textProvider === "local-structured" && !noticeDismissed ? (
        <div className="collab-notice">
          <AlertTriangle size={16} />
          <div>
            <strong>AI 能力说明：</strong>
            {notice.message}
            <div className="collab-muted">文本生成使用内置规则 Provider（非模型）；图像生成当前未配置供应商。</div>
          </div>
          <button className="btn ghost small" onClick={() => setNoticeDismissed(true)}>
            知道了
          </button>
        </div>
      ) : null}

      {error ? (
        <div className="collab-error" role="alert">
          <AlertTriangle size={14} />
          <span>{error}</span>
          <button className="btn ghost small" onClick={() => setError("")}>
            关闭
          </button>
        </div>
      ) : null}

      {!projectId ? (
        <EmptyState
          title="还没有规划项目"
          hint="请先在「我的项目」中创建项目；协作中心的需求、方案与可视化都归属于项目。"
          icon={<FileText size={20} />}
        />
      ) : (
        <div className="collab-layout">
          <aside className="collab-list-pane">
            {(view === "issues" || view === "bugs") && (
              <>
                <div className="collab-pane-head">
                  <strong>{view === "bugs" ? "Bug 列表" : "需求列表"}</strong>
                  <button
                    className="btn small"
                    onClick={() => {
                      setCreating((v) => !v);
                      setDraft({ ...EMPTY_DRAFT, kind: view === "bugs" ? "bug" : "feature" });
                    }}
                  >
                    <Plus size={14} /> 新建
                  </button>
                </div>
                {creating ? (
                  <div className="collab-create-form">
                    <label>
                      类型
                      <Select
                        value={draft.kind}
                        options={Object.entries(ISSUE_KIND_LABEL).map(([value, label]) => ({
                          value: value as IssueKind,
                          label,
                        }))}
                        onChange={(value) => setDraft({ ...draft, kind: value })}
                        ariaLabel="需求类型"
                        size="sm"
                        block
                      />
                    </label>
                    <label>
                      标题
                      <input className="input" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
                    </label>
                    <label>
                      描述
                      <textarea className="input" rows={3} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
                    </label>
                    <label>
                      优先级
                      <Select
                        value={draft.priority}
                        options={["P0", "P1", "P2", "P3"].map((p) => ({ value: p, label: p }))}
                        onChange={(value) => setDraft({ ...draft, priority: value })}
                        ariaLabel="优先级"
                        size="sm"
                        block
                      />
                    </label>
                    <label>
                      验收要求
                      <textarea className="input" rows={2} value={draft.acceptance} onChange={(e) => setDraft({ ...draft, acceptance: e.target.value })} />
                    </label>
                    {draft.kind === "bug" ? (
                      <>
                        <label>
                          复现步骤（每行一步）
                          <textarea
                            className="input"
                            rows={3}
                            placeholder="1. 打开页面&#10;2. 点击生成方案&#10;3. 出现错误"
                            value={draft.reproSteps}
                            onChange={(e) => setDraft({ ...draft, reproSteps: e.target.value })}
                          />
                        </label>
                        <label>
                          预期结果
                          <input className="input" value={draft.expectedResult} onChange={(e) => setDraft({ ...draft, expectedResult: e.target.value })} />
                        </label>
                        <label>
                          实际结果
                          <input className="input" value={draft.actualResult} onChange={(e) => setDraft({ ...draft, actualResult: e.target.value })} />
                        </label>
                        <label>
                          环境
                          <input className="input" placeholder="如 Windows 11 · WebView2 · v0.5.0" value={draft.environment} onChange={(e) => setDraft({ ...draft, environment: e.target.value })} />
                        </label>
                        <label>
                          关联文件（逗号或换行分隔）
                          <textarea className="input" rows={2} value={draft.relatedFiles} onChange={(e) => setDraft({ ...draft, relatedFiles: e.target.value })} />
                        </label>
                      </>
                    ) : null}
                    <div className="collab-form-actions">
                      <button className="btn small" onClick={submitIssue} disabled={loading}>
                        提交（幂等）
                      </button>
                      <button className="btn ghost small" onClick={() => setCreating(false)}>
                        取消
                      </button>
                    </div>
                  </div>
                ) : null}
                <div className="collab-rows">
                  {filteredIssues.map((issue) => (
                    <button
                      key={issue.id}
                      type="button"
                      className={`collab-row ${selectedIssue?.issue.id === issue.id ? "is-selected" : ""}`}
                      onClick={() => void openIssue(issue)}
                    >
                      <div className="collab-row-title">{issue.title}</div>
                      <div className="collab-row-meta">
                        <StatusBadge tone={priorityTone(issue.priority)} size="sm">
                          {issue.priority}
                        </StatusBadge>
                        <StatusBadge tone={issueTone(issue.status)} size="sm">
                          {STATUS_LABEL[issue.status] ?? issue.status}
                        </StatusBadge>
                        <span className="collab-muted">{ISSUE_KIND_LABEL[issue.kind] ?? issue.kind}</span>
                        {issue.source !== "ui" ? <span className="collab-muted">来自 {issue.source}</span> : null}
                      </div>
                    </button>
                  ))}
                  {!filteredIssues.length && !loading ? (
                    <EmptyState title={view === "bugs" ? "还没有 Bug" : "还没有需求"} hint="外部 Agent 也可通过 MCP 工具提交。" framed />
                  ) : null}
                </div>
              </>
            )}

            {view === "plans" && (
              <>
                <div className="collab-pane-head">
                  <strong>方案列表</strong>
                </div>
                <div className="collab-rows">
                  {(plans?.items ?? []).map((plan) => (
                    <button
                      key={plan.id}
                      type="button"
                      className={`collab-row ${selectedPlan?.plan.id === plan.id ? "is-selected" : ""}`}
                      onClick={() => void openPlan(plan)}
                    >
                      <div className="collab-row-title">{plan.title}</div>
                      <div className="collab-row-meta">
                        <StatusBadge tone={issueTone(plan.status)} size="sm">
                          {STATUS_LABEL[plan.status] ?? plan.status}
                        </StatusBadge>
                        <span className="collab-muted">{plan.breakdown.length} 个任务草案</span>
                      </div>
                    </button>
                  ))}
                  {!(plans?.items ?? []).length && !loading ? (
                    <EmptyState title="还没有方案" hint="从需求详情点击「生成方案」创建。" framed />
                  ) : null}
                </div>
              </>
            )}

            {view === "visuals" && (
              <>
                <div className="collab-pane-head">
                  <strong>可视化文档</strong>
                </div>
                <div className="collab-rows">
                  {(visuals?.items ?? []).map((doc) => (
                    <button
                      key={doc.id}
                      type="button"
                      className={`collab-row ${selectedVisual?.id === doc.id ? "is-selected" : ""}`}
                      onClick={() => void openVisual(doc)}
                    >
                      <div className="collab-row-title">{doc.title}</div>
                      <div className="collab-row-meta">
                        <StatusBadge tone="info" size="sm">
                          {doc.kind}
                        </StatusBadge>
                        <span className="collab-muted">v{doc.version}</span>
                        {doc.planId ? <span className="collab-muted">已关联方案</span> : null}
                      </div>
                    </button>
                  ))}
                  {!(visuals?.items ?? []).length && !loading ? (
                    <EmptyState title="还没有可视化文档" hint="用下方 AI 生成，或由外部 Agent 创建。" framed />
                  ) : null}
                </div>
              </>
            )}
          </aside>

          <section className="collab-detail-pane">
            {selectedIssue ? (
              <IssueDetailView
                detail={selectedIssue}
                onCreatePlan={() => void createPlan(selectedIssue)}
                onRefresh={async () => {
                  setSelectedIssue(await collabIssueGet(selectedIssue.issue.id));
                  await reload();
                }}
                setError={setError}
              />
            ) : selectedPlan ? (
              <PlanDetailView
                detail={selectedPlan}
                progress={progress}
                onRefresh={refreshPlan}
                onVisual={async (id) => {
                  const doc = await collabVisualGet(id);
                  setSelectedVisual(doc);
                }}
                setError={setError}
              />
            ) : selectedVisual ? (
              <VisualViewer doc={selectedVisual} onUpdate={(next) => void openVisual(next)} />
            ) : (
              <div className="collab-detail-empty">
                {view === "visuals" ? (
                  <AiGenerateBar
                    projectId={projectId}
                    onGenerated={async (job) => {
                      await reload();
                      if (job.documentId) {
                        setSelectedVisual(await collabVisualGet(job.documentId));
                      }
                    }}
                    jobs={jobs}
                    setError={setError}
                  />
                ) : null}
                <EmptyState
                  title="从左侧选择一条记录"
                  hint={
                    view === "issues" || view === "bugs"
                      ? "查看详情、附证据、生成方案。"
                      : view === "plans"
                        ? "查看方案、提交审批、拆解任务。"
                        : "预览流程图/原型，切换版本并对比。"
                  }
                  icon={view === "bugs" ? <Bug size={20} /> : <Workflow size={20} />}
                />
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function IssueDetailView({
  detail,
  onCreatePlan,
  onRefresh,
  setError,
}: {
  detail: IssueDetail;
  onCreatePlan: () => void;
  onRefresh: () => Promise<void>;
  setError: (v: string) => void;
}) {
  const issue = detail.issue;
  const [evidenceText, setEvidenceText] = useState("");
  const [evidencePath, setEvidencePath] = useState("");
  const [resolution, setResolution] = useState("");
  const [verifyId, setVerifyId] = useState("");
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      await onRefresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const attach = () =>
    run(async () => {
      if (!evidenceText.trim()) throw new Error("请填写日志或复现证据");
      await collabEvidenceAttachText(issue.projectId, {
        subjectKind: "issue",
        subjectId: issue.id,
        kind: issue.kind === "bug" ? "log" : "other",
        title: issue.kind === "bug" ? "Bug 证据" : "补充说明",
        text: evidenceText,
      });
      setEvidenceText("");
    });

  const pickEvidenceFile = async () => {
    setError("");
    try {
      const selected = await openDialog({
        multiple: false,
        directory: false,
        title: "选择证据文件（≤32 MiB）",
      });
      if (typeof selected === "string") setEvidencePath(selected);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const attachFile = () =>
    run(async () => {
      if (!evidencePath.trim()) throw new Error("请选择或填写证据文件路径");
      await collabEvidenceAttachPath(issue.projectId, {
        subjectKind: "issue",
        subjectId: issue.id,
        kind: evidenceKindForPath(evidencePath),
        path: evidencePath.trim(),
      });
      setEvidencePath("");
    });

  const resolve = () =>
    run(async () => {
      if (!resolution.trim()) throw new Error("请填写解决说明");
      await collabIssueResolve(issue.id, issue.revision, resolution);
      setResolution("");
    });

  const verify = () =>
    run(async () => {
      if (!verifyId) throw new Error("请选择一条证据");
      await collabIssueVerify(issue.id, issue.revision, verifyId);
    });

  return (
    <div className="collab-detail">
      <div className="collab-detail-head">
        <div>
          <div className="collab-detail-kicker">
            <StatusBadge tone={priorityTone(issue.priority)} size="sm">
              {issue.priority}
            </StatusBadge>
            <StatusBadge tone={issueTone(issue.status)} size="sm">
              {STATUS_LABEL[issue.status] ?? issue.status}
            </StatusBadge>
            <span className="collab-muted">{ISSUE_KIND_LABEL[issue.kind] ?? issue.kind}</span>
            {issue.source !== "ui" ? <span className="collab-muted">来源 {issue.source}</span> : null}
          </div>
          <h3 className="collab-detail-title">{issue.title}</h3>
        </div>
        <div className="collab-detail-actions">
          {issue.kind !== "bug" && !detail.plans.length ? (
            <button className="btn small" onClick={onCreatePlan} disabled={busy}>
              <Sparkles size={14} /> 生成方案
            </button>
          ) : null}
          {detail.plans.length ? (
            <span className="collab-muted">已关联 {detail.plans.length} 个方案</span>
          ) : null}
          <button className="btn ghost small" onClick={() => void run(() => collabIssueArchive(issue.id, issue.revision))} disabled={busy}>
            归档
          </button>
        </div>
      </div>

      {issue.description ? <p className="collab-detail-text">{issue.description}</p> : null}

      {issue.kind === "bug" ? (
        <div className="collab-facts">
          <div>
            <strong>复现步骤</strong>
            <ol>
              {issue.reproSteps.map((s, i) => (
                <li key={`${i}-${s}`}>{reproStepText(s)}</li>
              ))}
              {!issue.reproSteps.length ? <li className="collab-muted">未填写</li> : null}
            </ol>
          </div>
          <div>
            <strong>预期 / 实际</strong>
            <div>预期：{issue.expectedResult ?? "—"}</div>
            <div>实际：{issue.actualResult ?? "—"}</div>
            <div>环境：{issue.environment ?? "—"}</div>
          </div>
        </div>
      ) : null}

      {issue.acceptance ? (
        <div className="collab-section">
          <strong>验收要求</strong>
          <p>{issue.acceptance}</p>
        </div>
      ) : null}

      <div className="collab-section">
        <strong>证据（{detail.evidenceCount}）</strong>
        {detail.evidence.length ? (
          <div className="collab-evidence-list">
            {detail.evidence.map((ev) => (
              <label key={ev.id} className="collab-evidence-row">
                <input
                  type="radio"
                  name="collab-evidence"
                  checked={verifyId === ev.id}
                  onChange={() => setVerifyId(ev.id)}
                  aria-label={`选择证据 ${ev.title}`}
                />
                <StatusBadge tone="neutral" size="sm">
                  {ev.kind}
                </StatusBadge>
                <span>{ev.title || ev.id}</span>
                <span className="collab-muted">{ev.sizeBytes} B</span>
              </label>
            ))}
          </div>
        ) : (
          <div className="collab-muted">还没有证据。</div>
        )}
        <div className="collab-form-inline">
          <textarea
            className="input"
            rows={2}
            placeholder="粘贴日志 / 复现说明（作为文本证据，落库并计算哈希）"
            value={evidenceText}
            onChange={(e) => setEvidenceText(e.target.value)}
          />
          <button className="btn small" onClick={attach} disabled={busy}>
            附证据
          </button>
        </div>
        <div className="collab-form-inline">
          <input
            className="input"
            placeholder="证据文件路径，如 D:\logs\crash.log"
            value={evidencePath}
            onChange={(e) => setEvidencePath(e.target.value)}
          />
          <button className="btn ghost small" onClick={() => void pickEvidenceFile()} disabled={busy}>
            选择文件
          </button>
          <button className="btn small" onClick={attachFile} disabled={busy || !evidencePath.trim()}>
            附文件
          </button>
        </div>
        <div className="collab-muted">文件会复制到受控证据目录并计算 sha256；支持 png/log/json/mp4/zip，单个 ≤32 MiB。</div>
      </div>

      {issue.kind === "bug" ? (
        <div className="collab-section">
          <strong>解决与验收</strong>
          <div className="collab-form-inline">
            <input
              className="input"
              placeholder="解决说明"
              value={resolution}
              onChange={(e) => setResolution(e.target.value)}
            />
            <button className="btn small" onClick={resolve} disabled={busy || issue.status === "verified"}>
              标记已解决
            </button>
          </div>
          <div className="collab-form-inline">
            <button className="btn small" onClick={verify} disabled={busy || !verifyId || issue.status === "verified"}>
              <CheckCircle2 size={14} /> 用所选证据验收
            </button>
            {issue.status === "verified" ? <span className="collab-muted">已验收，可关闭。</span> : null}
          </div>
        </div>
      ) : null}

      <div className="collab-muted collab-footnote">
        来源：{issue.source} · revision {issue.revision} · 更新于 {issue.updatedAt.slice(0, 19).replace("T", " ")}
      </div>
    </div>
  );
}

function PlanDetailView({
  detail,
  progress,
  onRefresh,
  onVisual,
  setError,
}: {
  detail: PlanDetail;
  progress: PlanProgress | null;
  onRefresh: (id: string) => Promise<void>;
  onVisual: (id: string) => Promise<void>;
  setError: (v: string) => void;
}) {
  const plan = detail.plan;
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(plan.title);
  const [summary, setSummary] = useState(plan.summary);
  const [solution, setSolution] = useState(plan.solutionMd);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      await onRefresh(plan.id);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const save = () =>
    run(async () => {
      await collabPlanUpdate(plan.id, plan.revision, { title, summary, solutionMd: solution });
      setEditing(false);
    });

  return (
    <div className="collab-detail">
      <div className="collab-detail-head">
        <div>
          <div className="collab-detail-kicker">
            <StatusBadge tone={issueTone(plan.status)} size="sm">
              {STATUS_LABEL[plan.status] ?? plan.status}
            </StatusBadge>
            {plan.approvedBy ? <span className="collab-muted">批准人 {plan.approvedBy}</span> : null}
            <span className="collab-muted">revision {plan.revision}</span>
          </div>
          <h3 className="collab-detail-title">{plan.title}</h3>
        </div>
        <div className="collab-detail-actions">
          {!editing ? (
            <button className="btn ghost small" onClick={() => setEditing(true)}>
              编辑
            </button>
          ) : (
            <>
              <button className="btn small" onClick={save} disabled={busy}>
                保存
              </button>
              <button className="btn ghost small" onClick={() => setEditing(false)}>
                取消
              </button>
            </>
          )}
          {plan.status === "draft" || plan.status === "changes_requested" ? (
            <button className="btn small" onClick={() => void run(() => collabPlanSubmit(plan.id, plan.revision))} disabled={busy}>
              <Send size={14} /> 提交审阅
            </button>
          ) : null}
          {plan.status === "in_review" ? (
            <>
              <button className="btn small" onClick={() => void run(() => collabPlanReview(plan.id, plan.revision, "approve", "通过"))} disabled={busy}>
                批准
              </button>
              <button className="btn ghost small" onClick={() => void run(() => collabPlanReview(plan.id, plan.revision, "request_changes", "请补充"))} disabled={busy}>
                要求修改
              </button>
            </>
          ) : null}
          {plan.status === "approved" ? (
            <button className="btn small" onClick={() => void run(() => collabPlanCreateTasks(plan.id))} disabled={busy}>
              <GitBranch size={14} /> 生成开发任务
            </button>
          ) : null}
        </div>
      </div>

      {editing ? (
        <div className="collab-edit-form">
          <label>
            标题
            <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label>
            摘要
            <input className="input" value={summary} onChange={(e) => setSummary(e.target.value)} />
          </label>
          <label>
            技术方案（Markdown）
            <textarea className="input" rows={10} value={solution} onChange={(e) => setSolution(e.target.value)} />
          </label>
        </div>
      ) : (
        <>
          {plan.summary ? <p className="collab-detail-text">{plan.summary}</p> : null}
          <pre className="collab-markdown">{plan.solutionMd || "（方案正文为空）"}</pre>
        </>
      )}

      <div className="collab-facts">
        <div>
          <strong>任务草案</strong>
          <ol>
            {plan.breakdown.map((t, i) => (
              <li key={`${i}-${t.title}`}>
                {t.title} <span className="collab-muted">P{t.priority ?? 2}</span>
              </li>
            ))}
            {!plan.breakdown.length ? <li className="collab-muted">未拆解</li> : null}
          </ol>
        </div>
        <div>
          <strong>开发进度</strong>
          {progress ? (
            <>
              <div>
                {progress.completed} / {progress.total}
                {progress.percent === null ? "（无数值）" : `（${progress.percent}%）`}
              </div>
              {progress.orphan ? <div className="collab-muted">孤立任务 {progress.orphan}</div> : null}
            </>
          ) : (
            <div className="collab-muted">未开始</div>
          )}
          {detail.tasks.length ? (
            <ul className="collab-task-list">
              {detail.tasks.map((task) => (
                <li key={task.taskId}>
                  <span>{task.title}</span>
                  <StatusBadge tone={task.status === "completed" ? "success" : "info"} size="sm">
                    {task.status}
                  </StatusBadge>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>

      <div className="collab-section">
        <strong>关联可视化（{detail.visuals.length}）</strong>
        {detail.visuals.length ? (
          <div className="collab-chip-list">
            {detail.visuals.map((v) => (
              <button key={v.id} className="btn ghost small" onClick={() => void onVisual(v.id)}>
                {v.title} · v{v.version}
              </button>
            ))}
          </div>
        ) : (
          <div className="collab-muted">方案还没有关联流程图或原型。</div>
        )}
      </div>
    </div>
  );
}

function AiGenerateBar({
  projectId,
  onGenerated,
  jobs,
  setError,
}: {
  projectId: string;
  onGenerated: (job: AiJob) => Promise<void>;
  jobs: AiJob[];
  setError: (v: string) => void;
}) {
  const [kind, setKind] = useState<"flowchart" | "architecture" | "dataflow" | "prototype">("flowchart");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);

  const generate = async () => {
    if (!prompt.trim()) {
      setError("请描述要生成的图表或原型");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const job = await collabAiGenerate(projectId, kind, prompt);
      if (job.status !== "succeeded") throw new Error(job.errorMessage ?? "生成未成功");
      await onGenerated(job);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="collab-ai-bar">
      <div className="collab-ai-head">
        <Sparkles size={16} />
        <strong>AI 生成可视化</strong>
        <span className="collab-muted">规则 Provider（非模型）· 生成后仍可编辑/版本化</span>
      </div>
      <div className="collab-ai-form">
        <Select
          value={kind}
          options={[
            { value: "flowchart", label: "流程图" },
            { value: "architecture", label: "架构图" },
            { value: "dataflow", label: "数据流图" },
            { value: "prototype", label: "交互式原型" },
          ]}
          onChange={(value) => setKind(value as typeof kind)}
          ariaLabel="生成类型"
          size="sm"
        />
        <textarea
          className="input"
          rows={3}
          placeholder="例：生成一个「外部 Agent 提交需求 → 审批 → 生成任务」的流程图"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
        <button className="btn" onClick={generate} disabled={busy}>
          {busy ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />} 生成
        </button>
      </div>
      {jobs.length ? (
        <div className="collab-job-list">
          {jobs.slice(0, 5).map((job) => (
            <div key={job.id} className="collab-job-row">
              <StatusBadge tone={job.status === "succeeded" ? "success" : "danger"} size="sm">
                {job.status}
              </StatusBadge>
              <span>{job.prompt.slice(0, 60)}</span>
              <span className="collab-muted">{job.provider}</span>
              {job.errorMessage ? <span className="collab-muted">{job.errorMessage.slice(0, 80)}</span> : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
