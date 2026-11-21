//! Agent 共享工作空间管理面（v76）。
//!
//! 只做「接入状态 / 活动 / 交接 / 同步 / 权限」的展示与操作入口；
//! 所有读写都经 Tauri 命令进入统一 service 层，UI 不直接碰数据库或文件。
//!
//! 契约要点（v81）：
//! - 冲突解决方式与 Rust 端枚举一致（db / file / dismiss），且**作用于选中的那条冲突**；
//! - 工作报告来自 `agent_access_reports`，不再误用活动流；
//! - 文件导入默认「待批准」，本机用户逐条批准后才写入业务表。

import { useCallback, useEffect, useMemo, useState } from "react";
import { AgentOperationTimeline } from "../agents/operations/AgentOperationTimeline";
import {
  Activity,
  ArrowLeftRight,
  Copy,
  Download,
  FolderOpen,
  History,
  RefreshCw,
  ScanLine,
  Shield,
  Users,
} from "lucide-react";
import {
  agentAccessActivity,
  agentAccessAgents,
  agentAccessConfigInfo,
  agentAccessConflictDetail,
  agentAccessConflicts,
  agentAccessContext,
  agentAccessExport,
  agentAccessGrant,
  agentAccessHandoffs,
  agentAccessHandoffDetail,
  agentAccessHandoffTransition,
  agentAccessImportApprove,
  agentAccessImportPolicies,
  agentAccessImportPolicyRemove,
  agentAccessImportPolicySet,
  agentAccessImportReject,
  agentAccessImportRequests,
  agentAccessInit,
  agentAccessPermissions,
  agentAccessResolveConflict,
  agentAccessReports,
  agentAccessRevoke,
  agentAccessScan,
  agentAccessStatus,
  agentAccessSyncStatus,
  fsReveal,
  type AgentAccessData,
  type ConflictResolution,
} from "../../lib/bridge";
import { errorMessage } from "../../lib/errors";
import { useLocale } from "../../hooks/useLocale";
import { EmptyState, Select } from "../ui";
import "./agent-access.css";

type Row = Record<string, unknown>;
type SubTab = "overview" | "activity" | "handoffs" | "sync" | "permissions";

const SUB_TABS: readonly { id: SubTab; key: string; icon: typeof Activity }[] = [
  { id: "overview", key: "agent.subtab.overview", icon: Shield },
  { id: "activity", key: "agent.subtab.activity", icon: Activity },
  { id: "handoffs", key: "agent.subtab.handoffs", icon: ArrowLeftRight },
  { id: "sync", key: "agent.subtab.sync", icon: History },
  { id: "permissions", key: "agent.subtab.permissions", icon: Users },
];

/** 写能力：授权前必须让用户知道它能改数据。 */
const WRITE_CAPABILITIES = new Set([
  "tasks.write",
  "notes.write",
  "knowledge.write",
  "decisions.write",
  "handoffs.write",
  // 创建项目是独立写能力：scope=project_rw 不隐含创建权，必须单独勾选。
  "projects.create",
  "projects.write",
]);

const CAPABILITY_FAMILIES: readonly { key: string; label: string }[] = [
  { key: "tasks", label: "任务" },
  { key: "knowledge", label: "知识" },
  { key: "decisions", label: "决策" },
  { key: "handoffs", label: "交接" },
  { key: "projects", label: "项目" },
  { key: "plans", label: "规划" },
  { key: "context", label: "上下文" },
  { key: "skills", label: "技能" },
  { key: "notes", label: "笔记" },
  { key: "workflows", label: "工作流" },
  { key: "workspace", label: "文件工作区" },
];

function asRow(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {};
}

function asRows(value: unknown): Row[] {
  return Array.isArray(value) ? value.map(asRow) : [];
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function pick(row: Row | null | undefined, ...keys: string[]): unknown {
  if (!row) return undefined;
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null) return row[key];
  }
  return undefined;
}

function short(value: unknown, max = 80): string {
  const raw = text(value);
  return raw.length > max ? `${raw.slice(0, max - 1)}…` : raw;
}

function listText(value: unknown): string {
  if (Array.isArray(value)) return value.map((item) => text(item)).filter(Boolean).join("；");
  return text(value);
}

export default function AgentAccessSection() {
  const { t } = useLocale();
  const [tab, setTab] = useState<SubTab>("overview");
  const [status, setStatus] = useState<AgentAccessData>({});
  const [config, setConfig] = useState<AgentAccessData>({});
  const [activity, setActivity] = useState<Row[]>([]);
  const [handoffs, setHandoffs] = useState<Row[]>([]);
  const [reports, setReports] = useState<Row[]>([]);
  const [conflicts, setConflicts] = useState<Row[]>([]);
  const [selectedConflictId, setSelectedConflictId] = useState<string>("");
  const [conflictDetail, setConflictDetail] = useState<Row | null>(null);
  const [resolution, setResolution] = useState<ConflictResolution>("db");
  const [sync, setSync] = useState<AgentAccessData>({});
  const [agents, setAgents] = useState<Row[]>([]);
  const [agentQuery, setAgentQuery] = useState<string>("");
  const [selectedAgent, setSelectedAgent] = useState<string>("");
  const [permissions, setPermissions] = useState<AgentAccessData>({});
  const [capability, setCapability] = useState<string>("tasks.read");
  const [resourceId, setResourceId] = useState<string>("");
  const [handoffFilter, setHandoffFilter] = useState<string>("all");
  const [detail, setDetail] = useState<Row | null>(null);
  const [detailRevision, setDetailRevision] = useState<number>(0);
  const [reason, setReason] = useState<string>("");
  const [importRequests, setImportRequests] = useState<Row[]>([]);
  const [importPolicies, setImportPolicies] = useState<Row[]>([]);
  const [policyDir, setPolicyDir] = useState<string>("inbox");
  const [policyMode, setPolicyMode] = useState<"off" | "review" | "trusted">("review");
  const [policyCapability, setPolicyCapability] = useState<string>("tasks.write");
  const [contextProject, setContextProject] = useState<string>("");
  const [contextTask, setContextTask] = useState<string>("");
  const [contextMarkdown, setContextMarkdown] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const workspace = asRow(status.workspace);
  const rest = asRow(status.rest);
  const cli = asRow(status.cli);
  const watch = asRow(status.watch);
  const syncStatus = asRow(sync.workspace);
  const initialized = Boolean(pick(workspace, "workspaceId", "workspace_id"));

  const refreshConflicts = useCallback(async () => {
    const next = await agentAccessConflicts();
    const rows = asRows(next);
    setConflicts(rows);
    return rows;
  }, []);

  const loadAll = useCallback(async () => {
    setError(null);
    try {
      const [
        nextStatus,
        nextConfig,
        nextSync,
        nextConflicts,
        nextAgents,
        nextRequests,
        nextPolicies,
      ] = await Promise.all([
        agentAccessStatus(),
        agentAccessConfigInfo(),
        agentAccessSyncStatus(),
        agentAccessConflicts(),
        agentAccessAgents(),
        agentAccessImportRequests(),
        agentAccessImportPolicies(),
      ]);
      setStatus(nextStatus);
      setConfig(nextConfig);
      setSync(nextSync);
      setConflicts(asRows(nextConflicts));
      setImportRequests(asRows(nextRequests));
      setImportPolicies(asRows(nextPolicies));
      const agentRows = asRows(nextAgents);
      setAgents(agentRows);
      setSelectedAgent((previous) =>
        previous && agentRows.some((item) => text(pick(item, "id")) === previous)
          ? previous
          : text(pick(agentRows[0] ?? {}, "id")),
      );
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  const loadTab = useCallback(
    async (which: SubTab) => {
      try {
        if (which === "activity") {
          const page = await agentAccessActivity({ limit: 50, offset: 0 });
          setActivity(asRows(page.items));
        } else if (which === "handoffs") {
          const page = await agentAccessHandoffs({
            status: handoffFilter === "all" ? undefined : handoffFilter,
            limit: 50,
            offset: 0,
          });
          setHandoffs(asRows(page.items));
          const reportPage = await agentAccessReports({ limit: 50, offset: 0 });
          setReports(asRows(reportPage.items));
        }
      } catch (e) {
        setError(errorMessage(e));
      }
    },
    [handoffFilter],
  );

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  useEffect(() => {
    void loadTab(tab);
  }, [tab, loadTab]);

  useEffect(() => {
    if (tab !== "permissions" || !selectedAgent) return;
    void agentAccessPermissions(selectedAgent)
      .then((value) => setPermissions(value))
      .catch((e) => setError(errorMessage(e)));
  }, [tab, selectedAgent]);

  const capabilityOptions = useMemo(() => {
    const items = Array.isArray(permissions.capabilities) ? permissions.capabilities : [];
    return items.map((item) => ({ value: text(item), label: text(item) }));
  }, [permissions]);

  const grants = asRows(permissions.grants);

  const run = async (action: () => Promise<unknown>, doneKey: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      setNotice(t(doneKey as Parameters<typeof t>[0]));
      await loadAll();
      await loadTab(tab);
      if (tab === "permissions" && selectedAgent) {
        setPermissions(await agentAccessPermissions(selectedAgent));
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const instructions = useMemo(() => {
    const root = text(pick(workspace, "rootPath", "root_path")) || "<workspace>";
    const base = text((pick(rest, "base_url") as string)) || "http://127.0.0.1:47911/api/v1";
    return [
      "TaskDock Agent Workspace",
      `workspace: ${root}`,
      "",
      "CLI:",
      "  taskdock status --json",
      "  taskdock task list --json",
      "  taskdock context get --project <project_id>",
      "",
      "MCP (stdio):",
      "  task-dock --mcp-server",
      "  env TASKDOCK_MCP_TOKEN=<agent token>",
      "  resources: taskdock://manifest, taskdock://projects, taskdock://context/current",
      "",
      "REST:",
      `  ${base}`,
      "  Authorization: Bearer <agent token>",
      "",
      "Files: read the workspace tree; write ONLY inbox/, tasks/inbox/, knowledge/inbox/.",
      "File writes are review-by-default: approve them in the Sync tab.",
      "Remote access is disabled; loopback only.",
    ].join("\n");
  }, [workspace, rest]);

  const copyInstructions = async () => {
    try {
      await navigator.clipboard.writeText(instructions);
      setNotice(t("agent.msg.copied"));
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const openDetail = async (id: string) => {
    try {
      const payload = await agentAccessHandoffDetail(id);
      const nested = asRow(payload.handoff);
      const handoff = Object.keys(nested).length > 0 ? nested : asRow(payload);
      setDetail(handoff);
      setDetailRevision(Number(pick(handoff, "revision") ?? pick(payload, "revision") ?? 0));
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const transition = async (action: "accept" | "reject" | "complete") => {
    if (!detail) return;
    await run(
      () =>
        agentAccessHandoffTransition(
          text(pick(detail, "id")),
          action,
          detailRevision,
          action === "reject" ? reason : undefined,
        ),
      "agent.msg.transitioned",
    );
    const id = text(pick(detail, "id"));
    if (id) await openDetail(id);
  };

  /** 选择一条冲突并读取详情（文件内容、两侧版本、所需能力）。 */
  const selectConflict = async (id: string) => {
    setSelectedConflictId(id);
    setConflictDetail(null);
    if (!id) return;
    try {
      const detailPayload = await agentAccessConflictDetail(id);
      setConflictDetail(asRow(detailPayload));
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const resolveSelectedConflict = async () => {
    if (!selectedConflictId) return;
    await run(
      () => agentAccessResolveConflict(selectedConflictId, resolution),
      "agent.msg.resolved",
    );
    await refreshConflicts();
    const still = conflicts.find((item) => text(pick(item, "id")) === selectedConflictId);
    if (still) {
      await selectConflict(selectedConflictId);
    } else {
      setSelectedConflictId("");
      setConflictDetail(null);
    }
  };

  const approveImport = async (requestId: string) => {
    await run(() => agentAccessImportApprove(requestId), "agent.msg.approved");
  };

  const rejectImport = async (requestId: string) => {
    await run(() => agentAccessImportReject(requestId, reason), "agent.msg.rejected");
  };

  const runContext = async () => {
    setBusy(true);
    setError(null);
    try {
      const value = await agentAccessContext({
        projectId: contextProject || undefined,
        task: contextTask || undefined,
        budgetTokens: 6000,
        format: "markdown",
      });
      setContextMarkdown(text(value.markdown));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const filteredAgents = useMemo(() => {
    const query = agentQuery.trim().toLowerCase();
    if (!query) return agents;
    return agents.filter((item) => {
      const haystack = [
        text(pick(item, "agentId", "agent_id")),
        text(pick(item, "displayName", "display_name")),
        text(pick(item, "id")),
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(query);
    });
  }, [agents, agentQuery]);

  const grantsByFamily = useMemo(() => {
    const map = new Map<string, Row[]>();
    for (const grant of grants) {
      const cap = text(pick(grant, "capability"));
      const family = cap.split(".")[0] || "other";
      const bucket = map.get(family) ?? [];
      bucket.push(grant);
      map.set(family, bucket);
    }
    return map;
  }, [grants]);

  const restState = text(pick(rest, "state")) || "stopped";
  const handoffStatus = text(pick(detail, "status"));
  const canAccept = handoffStatus === "pending";
  const canReject = handoffStatus === "pending";
  const canComplete = handoffStatus === "accepted";
  const pendingReviewCount = importRequests.filter(
    (item) => text(pick(item, "status")) === "pending",
  ).length;

  return (
    <div className="cap-section agent-access">
      <div className="cap-toolbar">
        <strong className="agent-access-heading">{t("cap.tab.agent")}</strong>
        <span className="cap-muted">
          {initialized
            ? text(pick(workspace, "name")) || t("agent.kv.notInit")
            : t("agent.kv.notInit")}
        </span>
        <span className="cap-toolbar-spacer" />
        <button type="button" className="btn sm" onClick={() => void loadAll()} disabled={busy}>
          <RefreshCw size={13} /> {t("agent.btn.refresh")}
        </button>
      </div>

      {error ? <div className="agent-access-error">{error}</div> : null}
      {notice ? <div className="agent-access-notice">{notice}</div> : null}

      {/* 职责边界（项目中枢 S7）：Agent 接入属于「Agent 协作与接入体系」，
          不是项目资源。资源关联（知识库 / Skill / MCP）请到「项目中枢 → 项目资源」。
          能力中心的 capability 路由暂时保留兼容，等新入口完成真实验收再调整导航。 */}
      <p className="cap-muted agent-access-scope">
        本面板只负责 Agent 身份、权限授权、文件导入审批、交接、同步与冲突处理；知识库 / Skill / MCP
        等资源关联在「项目中枢 → 项目资源」中管理。
      </p>

      <div className="cap-tabs agent-access-tabs" role="tablist" aria-label={t("cap.tab.agent")}>
        {SUB_TABS.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              className="cap-tab"
              aria-selected={tab === item.id}
              onClick={() => setTab(item.id)}
            >
              <Icon size={13} strokeWidth={1.8} aria-hidden="true" />
              {t(item.key as Parameters<typeof t>[0])}
            </button>
          );
        })}
      </div>

      {tab === "overview" ? (
        <div className="agent-access-grid">
          <div className="cap-card">
            <div className="cap-card-title">{t("agent.title.interfaces")}</div>
            <dl className="cap-kv">
              <dt>{t("agent.kv.workspaceId")}</dt>
              <dd>{text(pick(workspace, "workspaceId", "workspace_id")) || "-"}</dd>
              <dt>{t("agent.kv.path")}</dt>
              <dd>{text(pick(workspace, "rootPath", "root_path")) || "-"}</dd>
              <dt>{t("agent.kv.protocol")}</dt>
              <dd>
                {text(pick(workspace, "protocolVersion", "protocol_version")) || "-"} /{" "}
                {text(pick(workspace, "schemaVersion", "schema_version")) || "-"}
              </dd>
              <dt>{t("agent.kv.watch")}</dt>
              <dd>
                {watch.running ? t("agent.state.running") : t("agent.state.off")}
                {" · "}
                {Boolean(pick(config, "watch_enabled")) ? t("agent.state.on") : t("agent.state.off")}
                {text(pick(watch, "last_error")) ? ` · ${text(pick(watch, "last_error"))}` : ""}
              </dd>
              <dt>{t("agent.kv.cli")}</dt>
              <dd>
                {cli.installed ? t("agent.state.installed") : t("agent.state.missing")}
                {text(cli.path) ? ` · ${text(cli.path)}` : ""}
              </dd>
              <dt>{t("agent.kv.rest")}</dt>
              <dd>
                {restState === "listening"
                  ? t("agent.state.running")
                  : restState === "failed"
                    ? t("agent.state.error")
                    : t("agent.state.stopped")}
                {" · "}
                {text((pick(rest, "base_url") as string)) || "-"}
                {text(pick(rest, "last_error")) ? ` · ${text(pick(rest, "last_error"))}` : ""}
              </dd>
              <dt>{t("agent.kv.mcp")}</dt>
              <dd>{Boolean(pick(config, "mcp_enabled")) ? t("agent.state.on") : t("agent.state.off")}</dd>
            </dl>
            <div className="agent-access-actions">
              <button
                type="button"
                className="btn sm primary"
                disabled={busy}
                onClick={() => void run(() => agentAccessInit(), "agent.msg.initDone")}
              >
                <Shield size={13} /> {t("agent.btn.init")}
              </button>
              <button
                type="button"
                className="btn sm"
                disabled={!initialized || busy}
                onClick={() => void run(() => agentAccessExport(), "agent.msg.exported")}
              >
                <Download size={13} /> {t("agent.btn.export")}
              </button>
              <button
                type="button"
                className="btn sm"
                disabled={!initialized || busy}
                onClick={() => void run(() => agentAccessScan(), "agent.msg.scanDone")}
              >
                <ScanLine size={13} /> {t("agent.btn.scan")}
              </button>
              <button
                type="button"
                className="btn sm"
                disabled={!initialized}
                onClick={() => {
                  const path = text(pick(workspace, "rootPath", "root_path"));
                  if (path) void fsReveal(path).catch((e) => setError(errorMessage(e)));
                }}
              >
                <FolderOpen size={13} /> {t("agent.btn.open")}
              </button>
              <button type="button" className="btn sm" onClick={() => void copyInstructions()}>
                <Copy size={13} /> {t("agent.btn.copyInstructions")}
              </button>
            </div>
            <p className="cap-muted agent-access-hint">{t("agent.hint.remoteClosed")}</p>
          </div>

          <div className="cap-card">
            <div className="cap-card-title">{t("agent.title.contextPreview")}</div>
            <div className="agent-access-form">
              <input
                className="agent-access-input"
                value={contextProject}
                onChange={(event) => setContextProject(event.target.value)}
                placeholder={t("agent.ph.projectId")}
                aria-label={t("agent.ph.projectId")}
              />
              <input
                className="agent-access-input"
                value={contextTask}
                onChange={(event) => setContextTask(event.target.value)}
                placeholder={t("agent.ph.task")}
                aria-label={t("agent.ph.task")}
              />
              <button type="button" className="btn sm" disabled={busy} onClick={() => void runContext()}>
                {t("agent.btn.context")}
              </button>
            </div>
            {contextMarkdown ? (
              <pre className="agent-access-pre">{contextMarkdown}</pre>
            ) : (
              <p className="cap-muted">{t("agent.empty.context")}</p>
            )}
          </div>

          <div className="cap-card">
            <div className="cap-card-title">{t("agent.title.recent")}</div>
            {asRows(status.recent_activity).length === 0 ? (
              <p className="cap-muted">{t("agent.empty.activity")}</p>
            ) : (
              <ul className="agent-access-list">
                {asRows(status.recent_activity).slice(0, 8).map((item, index) => (
                  <li key={`${text(pick(item, "id"))}-${index}`}>
                    <span className="agent-access-time">
                      {short(pick(item, "createdAt", "created_at"), 19)}
                    </span>
                    <span>{text(pick(item, "agentId", "agent_id")) || t("agent.localUser")}</span>
                    <span className="cap-muted">
                      {text(pick(item, "interface"))} · {text(pick(item, "action"))} ·{" "}
                      {text(pick(item, "resourceKind", "resource_kind"))}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : null}

      {tab === "activity" ? (
        <>
          {/* 实时操作：统一 store 驱动（运行中 + 最近结束），点击可定位真实资源。 */}
          <div className="cap-card">
            <div className="cap-card-title">{t("agent.col.action")} · Agent 实时操作</div>
            <AgentOperationTimeline
              limit={8}
              emptyHint="当前没有运行中或最近的 Agent 操作"
            />
          </div>
          <div className="cap-card">
          {activity.length === 0 ? (
            <EmptyState title={t("agent.empty.activity")} hint={t("agent.empty.activityHint")} />
          ) : (
            <table className="agent-access-table">
              <thead>
                <tr>
                  <th>{t("agent.col.time")}</th>
                  <th>{t("agent.col.agent")}</th>
                  <th>{t("agent.col.interface")}</th>
                  <th>{t("agent.col.action")}</th>
                  <th>{t("agent.col.resource")}</th>
                  <th>{t("agent.col.result")}</th>
                </tr>
              </thead>
              <tbody>
                {activity.map((item, index) => (
                  <tr key={`${text(pick(item, "id"))}-${index}`}>
                    <td>{short(pick(item, "createdAt", "created_at"), 19)}</td>
                    <td>{text(pick(item, "agentId", "agent_id")) || t("agent.localUser")}</td>
                    <td>{text(pick(item, "interface"))}</td>
                    <td>{text(pick(item, "action"))}</td>
                    <td title={text(pick(item, "resourceId", "resource_id"))}>
                      {text(pick(item, "resourceKind", "resource_kind"))} ·{" "}
                      {short(pick(item, "resourceId", "resource_id"), 24)}
                    </td>
                    <td>
                      {/* 活动记录只有 success 布尔值与 errorCode；此前读 status
                          导致永远显示 “-”，这里按真实字段展示结果与失败原因。 */}
                      {pick(item, "success") === false ? (
                        <span className="agent-access-failed">
                          {t("agent.state.failed")}
                          {text(pick(item, "errorCode", "error_code"))
                            ? ` · ${text(pick(item, "errorCode", "error_code"))}`
                            : ""}
                        </span>
                      ) : (
                        t("agent.state.ok")
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          </div>
        </>
      ) : null}

      {tab === "handoffs" ? (
        <div className="agent-access-grid two">
          <div className="cap-card">
            <div className="cap-toolbar">
              <Select
                value={handoffFilter}
                onChange={(value) => setHandoffFilter(value)}
                options={[
                  { value: "all", label: t("agent.filter.all") },
                  { value: "pending", label: "pending" },
                  { value: "accepted", label: "accepted" },
                  { value: "completed", label: "completed" },
                  { value: "rejected", label: "rejected" },
                ]}
                size="sm"
                ariaLabel={t("agent.col.status")}
              />
              <span className="cap-toolbar-spacer" />
              <span className="cap-muted">{handoffs.length}</span>
            </div>
            {handoffs.length === 0 ? (
              <EmptyState title={t("agent.empty.handoffs")} />
            ) : (
              <table className="agent-access-table">
                <thead>
                  <tr>
                    <th>{t("agent.col.summary")}</th>
                    <th>{t("agent.col.from")}</th>
                    <th>{t("agent.col.to")}</th>
                    <th>{t("agent.col.status")}</th>
                  </tr>
                </thead>
                <tbody>
                  {handoffs.map((item) => (
                    <tr
                      key={text(pick(item, "id"))}
                      className="agent-access-clickable"
                      onClick={() => void openDetail(text(pick(item, "id")))}
                    >
                      <td title={text(pick(item, "summary"))}>
                        {short(pick(item, "summary"), 60)}
                      </td>
                      <td>{text(pick(item, "fromAgent", "from_agent", "from_agent_id"))}</td>
                      <td>{text(pick(item, "toAgent", "to_agent", "to_agent_id"))}</td>
                      <td>{text(pick(item, "status"))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="cap-card-title">{t("agent.kv.reports")}</div>
            {reports.length === 0 ? (
              <p className="cap-muted">{t("agent.empty.reports")}</p>
            ) : (
              <ul className="agent-access-list">
                {reports.map((item, index) => (
                  <li key={`${text(pick(item, "id"))}-${index}`}>
                    <span className="agent-access-time">
                      {short(pick(item, "createdAt", "created_at"), 19)}
                    </span>
                    <span>{text(pick(item, "agentId", "agent_id")) || t("agent.localUser")}</span>
                    <span title={text(pick(item, "summary"))}>
                      {short(pick(item, "summary"), 60)}
                    </span>
                    <span className="cap-muted">{text(pick(item, "result"))}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="cap-card">
            <div className="cap-card-title">{t("agent.title.handoffDetail")}</div>
            {!detail ? (
              <p className="cap-muted">{t("agent.empty.selectHandoff")}</p>
            ) : (
              <>
                <dl className="cap-kv">
                  <dt>{t("agent.col.status")}</dt>
                  <dd>{text(pick(detail, "status"))}</dd>
                  <dt>{t("agent.col.from")}</dt>
                  <dd>{text(pick(detail, "fromAgent", "from_agent", "from_agent_id"))}</dd>
                  <dt>{t("agent.col.to")}</dt>
                  <dd>{text(pick(detail, "toAgent", "to_agent", "to_agent_id"))}</dd>
                  <dt>{t("agent.col.summary")}</dt>
                  <dd>{text(pick(detail, "summary"))}</dd>
                  <dt>{t("agent.col.completed")}</dt>
                  <dd>{listText(pick(detail, "completedItems", "completed_items")) || "-"}</dd>
                  <dt>{t("agent.col.pending")}</dt>
                  <dd>{listText(pick(detail, "pendingItems", "pending_items")) || "-"}</dd>
                  <dt>{t("agent.col.risks")}</dt>
                  <dd>{listText(pick(detail, "risks")) || "-"}</dd>
                  <dt>{t("agent.col.nextSteps")}</dt>
                  <dd>{listText(pick(detail, "nextSteps", "next_steps")) || "-"}</dd>
                </dl>
                <div className="agent-access-actions">
                  <button
                    type="button"
                    className="btn sm primary"
                    disabled={busy || !canAccept}
                    onClick={() => void transition("accept")}
                  >
                    {t("agent.btn.accept")}
                  </button>
                  <button
                    type="button"
                    className="btn sm"
                    disabled={busy || !canComplete}
                    onClick={() => void transition("complete")}
                  >
                    {t("agent.btn.complete")}
                  </button>
                  <button
                    type="button"
                    className="btn sm"
                    disabled={busy || !canReject}
                    onClick={() => void transition("reject")}
                  >
                    {t("agent.btn.reject")}
                  </button>
                </div>
                <input
                  className="agent-access-input"
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder={t("agent.ph.reason")}
                  aria-label={t("agent.ph.reason")}
                />
              </>
            )}
          </div>
        </div>
      ) : null}

      {tab === "sync" ? (
        <div className="agent-access-grid">
          <div className="cap-card">
            <div className="cap-card-title">{t("agent.title.sync")}</div>
            <dl className="cap-kv">
              <dt>{t("agent.kv.path")}</dt>
              <dd>{text(pick(syncStatus, "rootPath", "root_path")) || "-"}</dd>
              <dt>{t("agent.kv.pending")}</dt>
              <dd>{text(pick(sync, "pendingImports", "pending_imports")) || "0"}</dd>
              <dt>{t("agent.kv.pendingReview")}</dt>
              <dd>{pendingReviewCount}</dd>
              <dt>{t("agent.kv.conflicts")}</dt>
              <dd>{text(pick(sync, "conflicts")) || "0"}</dd>
              <dt>{t("agent.kv.lastScan")}</dt>
              <dd>{short(pick(syncStatus, "lastScanAt", "last_scan_at"), 19) || "-"}</dd>
              <dt>{t("agent.kv.lastError")}</dt>
              <dd>{text(pick(sync, "last_error", "lastError")) || "-"}</dd>
            </dl>
            <div className="agent-access-actions">
              <button
                type="button"
                className="btn sm"
                disabled={!initialized || busy}
                onClick={() => void run(() => agentAccessScan(), "agent.msg.scanDone")}
              >
                <ScanLine size={13} /> {t("agent.btn.scan")}
              </button>
              <button
                type="button"
                className="btn sm"
                disabled={!initialized || busy}
                onClick={() => void run(() => agentAccessExport(), "agent.msg.exported")}
              >
                <Download size={13} /> {t("agent.btn.export")}
              </button>
            </div>
          </div>

          <div className="cap-card">
            <div className="cap-card-title">{t("agent.title.importReview")}</div>
            {importRequests.length === 0 ? (
              <p className="cap-muted">{t("agent.empty.imports")}</p>
            ) : (
              <ul className="agent-access-list">
                {importRequests.map((item) => (
                  <li key={text(pick(item, "id"))}>
                    <span title={text(pick(item, "rel_path", "relPath"))}>
                      {short(pick(item, "rel_path", "relPath"), 40)}
                    </span>
                    <span className="cap-muted">
                      {text(pick(item, "kind"))} · {text(pick(item, "status"))}
                    </span>
                    <span className="cap-muted">{text(pick(item, "reason"))}</span>
                    {text(pick(item, "status")) === "pending" ? (
                      <>
                        <button
                          type="button"
                          className="btn sm primary"
                          disabled={busy}
                          onClick={() => void approveImport(text(pick(item, "id")))}
                        >
                          {t("agent.btn.approve")}
                        </button>
                        <button
                          type="button"
                          className="btn sm"
                          disabled={busy}
                          onClick={() => void rejectImport(text(pick(item, "id")))}
                        >
                          {t("agent.btn.rejectFile")}
                        </button>
                      </>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            <div className="cap-card-title">{t("agent.title.importPolicy")}</div>
            <div className="agent-access-form">
              <input
                className="agent-access-input"
                value={policyDir}
                onChange={(event) => setPolicyDir(event.target.value)}
                placeholder={t("agent.ph.policyDir")}
                aria-label={t("agent.ph.policyDir")}
              />
              <Select
                value={policyMode}
                onChange={(value) => setPolicyMode(value as "off" | "review" | "trusted")}
                options={[
                  { value: "review", label: t("agent.policy.review") },
                  { value: "trusted", label: t("agent.policy.trusted") },
                  { value: "off", label: t("agent.policy.off") },
                ]}
                size="sm"
                ariaLabel={t("agent.title.importPolicy")}
              />
              <Select
                value={policyCapability}
                onChange={(value) => setPolicyCapability(value)}
                options={[
                  { value: "tasks.write", label: "tasks.write" },
                  { value: "knowledge.write", label: "knowledge.write" },
                  { value: "decisions.write", label: "decisions.write" },
                  { value: "handoffs.write", label: "handoffs.write" },
                ]}
                size="sm"
                ariaLabel={t("agent.field.capability")}
              />
              <button
                type="button"
                className="btn sm primary"
                disabled={busy || !policyDir.trim()}
                onClick={() =>
                  void run(
                    () =>
                      agentAccessImportPolicySet({
                        relDir: policyDir.trim(),
                        mode: policyMode,
                        capabilities: [policyCapability],
                      }),
                    "agent.msg.policySaved",
                  )
                }
              >
                {t("agent.btn.savePolicy")}
              </button>
            </div>
            {importPolicies.length === 0 ? (
              <p className="cap-muted">{t("agent.empty.policies")}</p>
            ) : (
              <ul className="agent-access-list">
                {importPolicies.map((item) => (
                  <li key={text(pick(item, "id"))}>
                    <span>{text(pick(item, "rel_dir", "relDir")) || "/"}</span>
                    <span className="cap-muted">{text(pick(item, "mode"))}</span>
                    <span className="cap-muted">{listText(pick(item, "capabilities"))}</span>
                    <button
                      type="button"
                      className="btn sm"
                      disabled={busy}
                      onClick={() =>
                        void run(
                          () => agentAccessImportPolicyRemove(text(pick(item, "id"))),
                          "agent.msg.policyRemoved",
                        )
                      }
                    >
                      {t("agent.btn.removePolicy")}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="cap-card agent-access-conflicts">
            <div className="cap-card-title">{t("agent.title.conflicts")}</div>
            {conflicts.length === 0 ? (
              <p className="cap-muted">{t("agent.empty.conflicts")}</p>
            ) : (
              <>
                <ul className="agent-access-list">
                  {conflicts.map((item) => {
                    const id = text(pick(item, "id"));
                    return (
                      <li
                        key={id}
                        className={`agent-access-clickable${id === selectedConflictId ? " active" : ""}`}
                        onClick={() => void selectConflict(id)}
                      >
                        <span>{short(pick(item, "relPath", "rel_path"), 44)}</span>
                        <span className="cap-muted">
                          {text(pick(item, "resource_kind", "resourceKind"))} ·{" "}
                          {text(pick(item, "status"))}
                        </span>
                      </li>
                    );
                  })}
                </ul>
                <div className="cap-card-title">{t("agent.title.conflictDetail")}</div>
                {!conflictDetail ? (
                  <p className="cap-muted">{t("agent.empty.conflictDetail")}</p>
                ) : (
                  <>
                    <dl className="cap-kv">
                      <dt>{t("agent.col.resource")}</dt>
                      <dd>
                        {text(pick(conflictDetail, "resource_kind", "resourceKind"))} ·{" "}
                        {text(pick(conflictDetail, "resource_id", "resourceId")) || "-"}
                      </dd>
                      <dt>{t("agent.col.dbRevision")}</dt>
                      <dd>{text(pick(conflictDetail, "db_revision", "dbRevision")) || "-"}</dd>
                      <dt>{t("agent.col.fileRevision")}</dt>
                      <dd>{text(pick(conflictDetail, "file_revision", "fileRevision")) || "-"}</dd>
                      <dt>{t("agent.col.file")}</dt>
                      <dd>{text(pick(conflictDetail, "rel_path", "relPath")) || "-"}</dd>
                    </dl>
                    {text(pick(conflictDetail, "file_content", "fileContent")) ? (
                      <pre className="agent-access-pre">
                        {short(pick(conflictDetail, "file_content", "fileContent"), 1200)}
                      </pre>
                    ) : (
                      <p className="cap-muted">{t("agent.empty.conflictFile")}</p>
                    )}
                    <div className="agent-access-form">
                      <Select
                        value={resolution}
                        onChange={(value) => setResolution(value as ConflictResolution)}
                        options={[
                          { value: "db", label: t("agent.resolve.db") },
                          { value: "file", label: t("agent.resolve.file") },
                          { value: "dismiss", label: t("agent.resolve.dismiss") },
                        ]}
                        size="sm"
                        ariaLabel={t("agent.title.conflicts")}
                      />
                      <button
                        type="button"
                        className="btn sm primary"
                        disabled={busy || !selectedConflictId}
                        onClick={() => void resolveSelectedConflict()}
                      >
                        {t("agent.btn.resolve")}
                      </button>
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        </div>
      ) : null}

      {tab === "permissions" ? (
        <div className="agent-access-grid two">
          <div className="cap-card">
            <div className="cap-card-title">{t("agent.title.agents")}</div>
            <div className="agent-access-form">
              <input
                className="agent-access-input"
                value={agentQuery}
                onChange={(event) => setAgentQuery(event.target.value)}
                placeholder={t("agent.ph.agentSearch")}
                aria-label={t("agent.ph.agentSearch")}
              />
            </div>
            {filteredAgents.length === 0 ? (
              <EmptyState title={t("agent.empty.agents")} hint={t("agent.hint.createAgent")} />
            ) : (
              <table className="agent-access-table">
                <thead>
                  <tr>
                    <th>{t("agent.col.agent")}</th>
                    <th>{t("agent.col.scope")}</th>
                    <th>{t("agent.col.lastSeen")}</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredAgents.map((item) => (
                    <tr
                      key={text(pick(item, "id"))}
                      className={`agent-access-clickable${text(pick(item, "id")) === selectedAgent ? " active" : ""}`}
                      onClick={() => setSelectedAgent(text(pick(item, "id")))}
                    >
                      <td>{text(pick(item, "agentId", "agent_id"))}</td>
                      <td>{text(pick(item, "scope"))}</td>
                      <td>{short(pick(item, "lastSeenAt", "last_seen_at"), 19) || "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="cap-card">
            <div className="cap-card-title">{t("agent.title.grants")}</div>
            {!selectedAgent ? (
              <p className="cap-muted">{t("agent.empty.selectAgent")}</p>
            ) : (
              <>
                <div className="agent-access-form">
                  <Select
                    value={capability}
                    onChange={(value) => setCapability(value)}
                    options={capabilityOptions}
                    size="sm"
                    ariaLabel={t("agent.field.capability")}
                  />
                  <input
                    className="agent-access-input"
                    value={resourceId}
                    onChange={(event) => setResourceId(event.target.value)}
                    placeholder={t("agent.ph.resource")}
                    aria-label={t("agent.ph.resource")}
                  />
                  <button
                    type="button"
                    className="btn sm primary"
                    disabled={busy || !capability}
                    onClick={() =>
                      void run(
                        () => agentAccessGrant(selectedAgent, capability, resourceId),
                        "agent.msg.granted",
                      )
                    }
                  >
                    {t("agent.btn.grant")}
                  </button>
                </div>
                {WRITE_CAPABILITIES.has(capability) ? (
                  <p className="cap-muted agent-access-warning">{t("agent.hint.writeGrant")}</p>
                ) : null}
                {grants.length === 0 ? (
                  <p className="cap-muted">{t("agent.empty.grants")}</p>
                ) : (
                  CAPABILITY_FAMILIES.map((family) => {
                    const bucket = grantsByFamily.get(family.key) ?? [];
                    if (bucket.length === 0) return null;
                    return (
                      <div key={family.key} className="agent-access-grant-group">
                        <div className="cap-card-title">{family.label}</div>
                        <ul className="agent-access-list">
                          {bucket.map((grant) => {
                            const cap = text(pick(grant, "capability"));
                            const scope = text(pick(grant, "resourceId", "resource_id"));
                            return (
                              <li key={`${cap}-${scope}`}>
                                <span className={WRITE_CAPABILITIES.has(cap) ? "is-write" : ""}>
                                  {cap}
                                </span>
                                <span className="cap-muted">{scope || "global"}</span>
                                <button
                                  type="button"
                                  className="btn sm"
                                  disabled={busy}
                                  onClick={() => {
                                    const target = `${cap} · ${scope || "global"}`;
                                    if (!window.confirm(`${t("agent.hint.confirmRevoke")}\n${target}`)) {
                                      return;
                                    }
                                    void run(
                                      () => agentAccessRevoke(selectedAgent, cap, scope),
                                      "agent.msg.revoked",
                                    );
                                  }}
                                >
                                  {t("agent.btn.revoke")}
                                </button>
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    );
                  })
                )}
                {reports.length > 0 ? (
                  <p className="cap-muted">
                    {t("agent.kv.reports")}: {reports.length}
                  </p>
                ) : null}
              </>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
