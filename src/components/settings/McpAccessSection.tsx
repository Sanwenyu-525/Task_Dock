//! MCP 访问管理 + Agent 身份 + 审计记录（2026-11-20 第二阶段重排）。
//!
//! 业务行为（命令、鉴权、范围切换、令牌轮换、审计分页）与第一阶段完全一致，
//! 只重排信息结构：三个分组各自承担一件事——
//!   1. MCP 访问管理：服务开关、运行状态、连接诊断、刷新；
//!   2. Agent 身份：创建凭据、搜索、身份卡（范围/项目/能力/工作区）、撤销与换令牌；
//!   3. 操作审计：分页记录与空状态。
//! 空状态统一 `EmptyState`，搜索统一 `SearchField`，不再把标题、输入框、空态裸堆。
//!
//! 健壮性：IPC 返回 null/非数组时按空集合处理（后端在服务未启动等分支会返回空），
//! 页面不允许因为一次空响应白屏。

import { useCallback, useEffect, useRef, useState } from "react";
import { Copy, Plus, RefreshCw, Shield, X } from "lucide-react";
import {
  agentMcpAuditList,
  agentMcpCapabilities,
  agentMcpConfigHint,
  agentMcpConfigSnippet,
  agentMcpCreate,
  agentMcpDiagnostics,
  agentMcpGrantCapability,
  agentMcpGrantProject,
  agentMcpGrantWorkspaceRoot,
  agentMcpList,
  agentMcpRevoke,
  agentMcpRevokeCapability,
  agentMcpRevokeProject,
  agentMcpRevokeWorkspaceRoot,
  agentMcpRotateToken,
  agentMcpSetScope,
  agentMcpStatus,
  agentMcpWorkspaceRoots,
  planningListProjects,
  type McpAgentCreated,
  type McpAgentInfo,
  type McpAgentScope,
  type McpAuditPage,
  type McpCapability,
  type McpCapabilityGrant,
  type McpConfigClient,
  type McpDiagnosticsReport,
  type McpStatus,
  type McpWorkspaceRoot,
  type PlanningProject,
} from "../../lib/bridge";
import { localizedErrorMessage } from "../../i18n/errors";
import { useLocale } from "../../hooks/useLocale";
import { useSettingsStore } from "../../store/useSettingsStore";
import { EmptyState, SearchField, Switch } from "../ui";
import SettingsGroup from "./SettingsGroup";
import ContextHelpButton from "../help/ContextHelpButton";
import type { MessageKey } from "../../i18n";
import "./mcp-access.css";

const SCOPES: readonly McpAgentScope[] = ["disabled", "readonly", "project_rw"];
const CLIENTS: readonly McpConfigClient[] = ["claude-code", "codex", "cursor", "trae", "generic"];
const CAPABILITIES: readonly { id: McpCapability; label: MessageKey }[] = [
  { id: "tasks.read", label: "settings.mcpAccess.capabilities.tasksRead" },
  { id: "tasks.write", label: "settings.mcpAccess.capabilities.tasksWrite" },
  { id: "notes.read", label: "settings.mcpAccess.capabilities.notesRead" },
  { id: "notes.write", label: "settings.mcpAccess.capabilities.notesWrite" },
  { id: "workflows.read", label: "settings.mcpAccess.capabilities.workflowsRead" },
  { id: "workspace.read", label: "settings.mcpAccess.capabilities.workspaceRead" },
  { id: "knowledge.read", label: "settings.mcpAccess.capabilities.knowledgeRead" },
  { id: "skills.read", label: "settings.mcpAccess.capabilities.skillsRead" },
];
const AUDIT_PAGE_SIZE = 20;

function scopeLabel(scope: McpAgentScope): MessageKey {
  return `settings.mcpAccess.scope.${scope}` as MessageKey;
}

function statusText(status: McpStatus | null, loading: boolean, t: (key: MessageKey) => string) {
  if (loading) return t("settings.mcpAccess.status.loading");
  if (!status) return t("settings.mcpAccess.status.unavailable");
  return status.running
    ? t("settings.mcpAccess.status.running")
    : t("settings.mcpAccess.status.stopped");
}

function hasGlobalCapability(
  grants: McpCapabilityGrant[] | undefined,
  capability: McpCapability,
) {
  return Boolean(grants?.some((grant) => grant.capability === capability && grant.resourceId === ""));
}

/** 只信任数组响应；null/异常结构按空集合处理，避免 `.filter` 打在 null 上白屏。 */
function asList<T>(value: T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

/** 单条身份数据做结构兜底（后端旧数据可能缺项目列表字段）。 */
function normalizeAgent(agent: McpAgentInfo): McpAgentInfo {
  return {
    ...agent,
    granted_project_ids: asList(agent.granted_project_ids),
  };
}

export default function McpAccessSection() {
  const { t } = useLocale();
  const settings = useSettingsStore((s) => s.settings);
  const updateSettings = useSettingsStore((s) => s.update);
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [agents, setAgents] = useState<McpAgentInfo[]>([]);
  const [projects, setProjects] = useState<PlanningProject[]>([]);
  const [audit, setAudit] = useState<McpAuditPage | null>(null);
  const [auditLoading, setAuditLoading] = useState(true);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [agentId, setAgentId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [created, setCreated] = useState<McpAgentCreated | null>(null);
  const [client, setClient] = useState<McpConfigClient>("codex");
  const [snippet, setSnippet] = useState("");
  const [hint, setHint] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [secretBusy, setSecretBusy] = useState(false);
  const [capabilities, setCapabilities] = useState<Record<string, McpCapabilityGrant[]>>({});
  const [roots, setRoots] = useState<Record<string, McpWorkspaceRoot[]>>({});
  const [expandedAgent, setExpandedAgent] = useState<string | null>(null);
  const [capBusy, setCapBusy] = useState<string | null>(null);
  const [rootDraft, setRootDraft] = useState("");
  const [diagnostics, setDiagnostics] = useState<McpDiagnosticsReport | null>(null);
  const [diagBusy, setDiagBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [agentQuery, setAgentQuery] = useState("");
  const [pendingAction, setPendingAction] = useState<
    | { kind: "rotate" | "revoke"; agent: McpAgentInfo }
    | { kind: "revokeProject"; agent: McpAgentInfo; projectId: string }
    | null
  >(null);
  const mounted = useRef(false);
  const requestId = useRef(0);
  const auditRequestId = useRef(0);
  const secretSession = useRef(0);
  const copyTimer = useRef<number | null>(null);

  const loadAudit = useCallback(async (offset = 0) => {
    const request = ++auditRequestId.current;
    setAuditLoading(true);
    try {
      const result = await agentMcpAuditList(offset, AUDIT_PAGE_SIZE);
      if (!mounted.current || request !== auditRequestId.current) return;
      setAudit(result && Array.isArray(result.items) ? result : null);
    } catch (reason) {
      if (!mounted.current || request !== auditRequestId.current) return;
      setError(localizedErrorMessage(reason));
    } finally {
      if (mounted.current && request === auditRequestId.current) setAuditLoading(false);
    }
  }, []);

  const refresh = useCallback(async () => {
    const request = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const [nextStatus, nextAgents, nextProjects] = await Promise.all([
        agentMcpStatus(),
        agentMcpList(),
        planningListProjects(false),
      ]);
      if (!mounted.current || request !== requestId.current) return;
      setStatus(nextStatus ?? null);
      setAgents(asList(nextAgents).map(normalizeAgent));
      setProjects(asList(nextProjects));
      void loadAudit(0);
    } catch (reason) {
      if (!mounted.current || request !== requestId.current) return;
      setError(localizedErrorMessage(reason));
    } finally {
      if (mounted.current && request === requestId.current) setLoading(false);
    }
  }, [loadAudit]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
      requestId.current += 1;
      auditRequestId.current += 1;
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    };
  }, [refresh]);

  function closeCreate() {
    secretSession.current += 1;
    setCreateOpen(false);
    setCreated(null);
    setSnippet("");
    setHint("");
    setAgentId("");
    setDisplayName("");
    setError(null);
  }

  async function createCredential() {
    const session = secretSession.current;
    setBusyId("create");
    setSecretBusy(true);
    setError(null);
    try {
      const result = await agentMcpCreate(agentId.trim(), displayName.trim());
      if (session !== secretSession.current) return;
      setCreated(result);
      setSnippet("");
      setHint("");
      await refresh();
    } catch (reason) {
      setError(localizedErrorMessage(reason));
    } finally {
      setBusyId(null);
      setSecretBusy(false);
    }
  }

  async function updateScope(agent: McpAgentInfo, scope: McpAgentScope) {
    setBusyId(agent.id);
    setError(null);
    try {
      const updated = await agentMcpSetScope(agent.id, scope);
      setAgents((current) => current.map((item) => (item.id === updated.id ? updated : item)));
    } catch (reason) {
      setError(localizedErrorMessage(reason));
    } finally {
      setBusyId(null);
    }
  }

  async function grantProject(agent: McpAgentInfo, projectId: string) {
    setBusyId(agent.id);
    setError(null);
    try {
      const updated = await agentMcpGrantProject(agent.id, projectId);
      setAgents((current) => current.map((item) => (item.id === updated.id ? updated : item)));
    } catch (reason) {
      setError(localizedErrorMessage(reason));
    } finally {
      setBusyId(null);
    }
  }

  async function revoke(agent: McpAgentInfo) {
    setBusyId(agent.id);
    setError(null);
    try {
      const updated = await agentMcpRevoke(agent.id);
      setAgents((current) => current.map((item) => (item.id === updated.id ? updated : item)));
    } catch (reason) {
      setError(localizedErrorMessage(reason));
    } finally {
      setBusyId(null);
    }
  }

  async function revokeProject(agent: McpAgentInfo, projectId: string) {
    setBusyId(agent.id);
    setError(null);
    try {
      const updated = await agentMcpRevokeProject(agent.id, projectId);
      setAgents((current) => current.map((item) => (item.id === updated.id ? updated : item)));
    } catch (reason) {
      setError(localizedErrorMessage(reason));
    } finally {
      setBusyId(null);
    }
  }

  async function rotateToken(agent: McpAgentInfo) {
    const session = ++secretSession.current;
    setBusyId(agent.id);
    setSecretBusy(true);
    setError(null);
    try {
      const result = await agentMcpRotateToken(agent.id);
      if (session !== secretSession.current) return;
      setAgents((current) => current.map((item) => (item.id === result.id ? result : item)));
      setCreated(result);
      setSnippet("");
      setHint("");
      setClient("codex");
      setCreateOpen(true);
    } catch (reason) {
      setError(localizedErrorMessage(reason));
    } finally {
      setBusyId(null);
      setSecretBusy(false);
    }
  }

  function confirmPendingAction() {
    const pending = pendingAction;
    if (!pending) return;
    setPendingAction(null);
    if (pending.kind === "rotate") void rotateToken(pending.agent);
    else if (pending.kind === "revoke") void revoke(pending.agent);
    else if ("projectId" in pending) void revokeProject(pending.agent, pending.projectId);
  }

  function flashCopied(value: string) {
    setCopied(value);
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopied(null), 2000);
  }

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setError(null);
      flashCopied(value);
    } catch (reason) {
      setError(localizedErrorMessage(reason));
    }
  }

  async function buildSnippet() {
    if (!created) return;
    const session = secretSession.current;
    setError(null);
    try {
      const [result, nextHint] = await Promise.all([
        agentMcpConfigSnippet(client, created.token),
        agentMcpConfigHint(client),
      ]);
      if (session === secretSession.current) {
        setSnippet(result);
        setHint(nextHint);
      }
    } catch (reason) {
      setError(localizedErrorMessage(reason));
    }
  }

  async function openAgentPanel(agent: McpAgentInfo) {
    if (expandedAgent === agent.id) {
      setExpandedAgent(null);
      return;
    }
    setExpandedAgent(agent.id);
    setRootDraft("");
    setCapBusy(agent.id);
    try {
      const [caps, nextRoots] = await Promise.all([
        agentMcpCapabilities(agent.id),
        agentMcpWorkspaceRoots(agent.id),
      ]);
      setCapabilities((current) => ({ ...current, [agent.id]: asList(caps) }));
      setRoots((current) => ({ ...current, [agent.id]: asList(nextRoots) }));
    } catch (reason) {
      setError(localizedErrorMessage(reason));
    } finally {
      setCapBusy(null);
    }
  }

  async function toggleCapability(agent: McpAgentInfo, capability: McpCapability) {
    const granted = hasGlobalCapability(capabilities[agent.id], capability);
    setCapBusy(agent.id);
    setError(null);
    try {
      const next = granted
        ? await agentMcpRevokeCapability(agent.id, capability, "")
        : await agentMcpGrantCapability(agent.id, capability, "");
      setCapabilities((current) => ({ ...current, [agent.id]: asList(next) }));
    } catch (reason) {
      setError(localizedErrorMessage(reason));
    } finally {
      setCapBusy(null);
    }
  }

  async function addRoot(agent: McpAgentInfo) {
    const path = rootDraft.trim();
    if (!path) return;
    setCapBusy(agent.id);
    setError(null);
    try {
      const next = await agentMcpGrantWorkspaceRoot(agent.id, path);
      setRoots((current) => ({ ...current, [agent.id]: asList(next) }));
      setRootDraft("");
    } catch (reason) {
      setError(localizedErrorMessage(reason));
    } finally {
      setCapBusy(null);
    }
  }

  async function removeRoot(agent: McpAgentInfo, rootId: string) {
    setCapBusy(agent.id);
    setError(null);
    try {
      const next = await agentMcpRevokeWorkspaceRoot(agent.id, rootId);
      setRoots((current) => ({ ...current, [agent.id]: asList(next) }));
    } catch (reason) {
      setError(localizedErrorMessage(reason));
    } finally {
      setCapBusy(null);
    }
  }

  async function runDiagnostics() {
    setDiagBusy(true);
    setError(null);
    try {
      const report = await agentMcpDiagnostics(
        expandedAgent ?? agents.find((agent) => !agent.revoked_at)?.id,
      );
      setDiagnostics(report);
    } catch (reason) {
      setError(localizedErrorMessage(reason));
    } finally {
      setDiagBusy(false);
    }
  }

  const visibleAgents = agents.filter((agent) => !agent.revoked_at);
  const filteredAgents = visibleAgents.filter((agent) => {
    const query = agentQuery.trim().toLowerCase();
    if (!query) return true;
    return (
      agent.display_name.toLowerCase().includes(query) ||
      agent.agent_id.toLowerCase().includes(query)
    );
  });

  return (
    <>
      {/* ① MCP 访问管理：开关 / 状态 / 诊断 */}
      <SettingsGroup
        className="mcp-access"
        title={t("settings.mcpAccess.title")}
        description={t("settings.mcpAccess.description")}
        actions={
          <button
            type="button"
            className="icon-btn sm"
            aria-label={t("settings.mcpAccess.refresh")}
            data-tip={t("settings.mcpAccess.refresh")}
            onClick={() => void refresh()}
            disabled={loading}
          >
            <RefreshCw size={13} className={loading ? "spin" : undefined} />
          </button>
        }
      >
        <div role="status" aria-live="polite" className="settings-status">
          <span
            className={`settings-status-dot${status?.running ? " is-on" : ""}`}
            aria-hidden="true"
          />
          <div className="settings-status-text">
            <strong>
              {t("settings.mcpAccess.serverStatus")}: {statusText(status, loading, t)}
            </strong>
            <span>
              {status
                ? [
                    status.enabled
                      ? t("settings.mcpAccess.serverEnabled")
                      : t("settings.mcpAccess.serverDisabled"),
                    status.running && status.port !== null
                      ? t("settings.mcpAccess.port", { port: status.port })
                      : "",
                    t("settings.mcpAccess.activeAgents", { count: status.active_agent_count }),
                    `${t("settings.mcpAccess.lastCall")}: ${
                      status.last_call
                        ? `${status.last_call.createdAt} · ${status.last_call.action} · ${
                            status.last_call.authorized
                              ? t("settings.mcpAccess.audit.authorized")
                              : t("settings.mcpAccess.audit.denied")
                          } · ${
                            status.last_call.success
                              ? t("settings.mcpAccess.audit.success")
                              : t("settings.mcpAccess.audit.failed")
                          }`
                        : t("settings.mcpAccess.neverCalled")
                    }`,
                  ]
                    .filter(Boolean)
                    .join(" · ")
                : ""}
            </span>
          </div>
        </div>

        <div className="setting-row">
          <span>{t("settings.agent.mcpServer")}</span>
          <div className="btn-row">
            <Switch
              checked={Boolean(settings?.mcp_server_enabled)}
              ariaLabel={t("settings.agent.mcpServer")}
              onChange={(v) => updateSettings({ mcp_server_enabled: v })}
            />
            <ContextHelpButton articleId="help.agents.mcp-authorization" />
          </div>
        </div>

        <div className="settings-actions-row">
          <button
            type="button"
            className="btn sm"
            onClick={() => void runDiagnostics()}
            disabled={diagBusy}
          >
            <Shield size={12} aria-hidden="true" />
            {diagBusy
              ? t("settings.mcpAccess.diagnostics.running")
              : t("settings.mcpAccess.diagnostics.run")}
          </button>
        </div>

        {diagnostics ? (
          <div className="settings-diagnostic" role="group" aria-label={t("settings.mcpAccess.diagnostics.run")}>
            <p className="settings-diagnostic-summary">
              {t(`settings.mcpAccess.diagnostics.overall.${diagnostics.overall}` as MessageKey)} ·{" "}
              {t("settings.mcpAccess.diagnostics.toolCount", {
                total: diagnostics.toolCount,
                original: diagnostics.originalToolCount,
              })}
            </p>
            <ul className="settings-diagnostic-steps">
              {diagnostics.steps.map((step) => (
                <li
                  key={step.id}
                  className={`settings-diagnostic-step is-${step.status}`}
                  data-status={step.status}
                >
                  <span className="settings-diagnostic-step-label">{step.label}</span>
                  <span className="settings-diagnostic-step-status">
                    {t(`settings.mcpAccess.diagnostics.status.${step.status}` as MessageKey)}
                  </span>
                  <span className="settings-diagnostic-step-detail">{step.detail}</span>
                  {step.hint ? (
                    <span className="settings-diagnostic-step-hint">{step.hint}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <div className="setting-note">{t("settings.mcpAccess.diagnostics.empty")}</div>
        )}

        {error && (
          <p role="alert" className="setting-note error-text">
            {t("settings.mcpAccess.error", { message: error })}
          </p>
        )}
      </SettingsGroup>

      {/* ② Agent 身份管理：创建 / 搜索 / 身份卡 */}
      <SettingsGroup
        className="mcp-access mcp-identities"
        title={t("settings.mcpAccess.identities")}
        description={t("settings.mcpAccess.identitiesDesc")}
        actions={
          !createOpen ? (
            <button
              type="button"
              className="btn sm"
              onClick={() => {
                secretSession.current += 1;
                setCreateOpen(true);
                setError(null);
              }}
            >
              <Plus size={13} aria-hidden="true" /> {t("settings.mcpAccess.create")}
            </button>
          ) : undefined
        }
      >
        {createOpen && (
          <div className="settings-subpanel" aria-label={t("settings.mcpAccess.createTitle")}>
            <h5 className="settings-subpanel-title">{t("settings.mcpAccess.createTitle")}</h5>
            {!created ? (
              <div className="settings-field-grid">
                <label className="settings-field">
                  <span>{t("settings.mcpAccess.agentId")}</span>
                  <input
                    className="ui-input"
                    value={agentId}
                    onChange={(event) => setAgentId(event.target.value)}
                    autoComplete="off"
                  />
                </label>
                <label className="settings-field">
                  <span>{t("settings.mcpAccess.displayName")}</span>
                  <input
                    className="ui-input"
                    value={displayName}
                    onChange={(event) => setDisplayName(event.target.value)}
                    autoComplete="off"
                  />
                </label>
                <div className="settings-actions-row">
                  <button
                    type="button"
                    className="btn sm primary"
                    onClick={() => void createCredential()}
                    disabled={busyId !== null || !agentId.trim() || !displayName.trim()}
                  >
                    {t("settings.mcpAccess.createCredential")}
                  </button>
                  <button type="button" className="btn sm" onClick={closeCreate} disabled={secretBusy}>
                    <X size={12} /> {t("settings.mcpAccess.closeCreate")}
                  </button>
                </div>
              </div>
            ) : (
              <div className="settings-field-grid">
                <p className="setting-note">{t("settings.mcpAccess.secretNotice")}</p>
                <label className="settings-field">
                  <span>{t("settings.mcpAccess.token")}</span>
                  <input
                    className="ui-input"
                    aria-label={t("settings.mcpAccess.token")}
                    readOnly
                    value={created.token}
                  />
                </label>
                <div className="settings-actions-row">
                  <button type="button" className="btn sm" onClick={() => void copy(created.token)}>
                    <Copy size={12} /> {t("settings.mcpAccess.copyToken")}
                  </button>
                  {copied === created.token && (
                    <span role="status" className="setting-note">
                      {t("settings.mcpAccess.copied")}
                    </span>
                  )}
                </div>
                <fieldset className="settings-fieldset">
                  <legend>{t("settings.mcpAccess.configClient")}</legend>
                  <div className="settings-segmented">
                    {CLIENTS.map((item) => (
                      <button
                        key={item}
                        type="button"
                        aria-pressed={client === item}
                        className={client === item ? "is-active" : undefined}
                        onClick={() => {
                          setClient(item);
                          setSnippet("");
                          setHint("");
                        }}
                      >
                        {item}
                      </button>
                    ))}
                  </div>
                  <button type="button" className="btn sm" onClick={() => void buildSnippet()}>
                    {t("settings.mcpAccess.generateConfig")}
                  </button>
                </fieldset>
                {snippet && (
                  <>
                    <textarea
                      className="settings-textarea"
                      aria-label={t("settings.mcpAccess.configSnippet")}
                      readOnly
                      value={snippet}
                    />
                    <div className="settings-actions-row">
                      <button type="button" className="btn sm" onClick={() => void copy(snippet)}>
                        <Copy size={12} /> {t("settings.mcpAccess.copyConfig")}
                      </button>
                      {copied === snippet && (
                        <span role="status" className="setting-note">
                          {t("settings.mcpAccess.copied")}
                        </span>
                      )}
                    </div>
                    {hint && (
                      <p className="setting-note">
                        {t("settings.mcpAccess.configHint", { hint })}
                      </p>
                    )}
                  </>
                )}
                <div className="settings-actions-row">
                  <button type="button" className="btn sm" onClick={closeCreate} disabled={secretBusy}>
                    <X size={12} /> {t("settings.mcpAccess.closeCreate")}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        <div className="settings-toolbar">
          <SearchField
            value={agentQuery}
            onChange={setAgentQuery}
            ariaLabel={t("settings.mcpAccess.agents.search")}
            placeholder={t("settings.mcpAccess.agents.searchPlaceholder")}
            clearLabel={t("common.clear")}
            size="compact"
            className="settings-search-field"
          />
        </div>

        {loading && filteredAgents.length === 0 ? (
          <p className="setting-note">{t("settings.mcpAccess.status.loading")}</p>
        ) : filteredAgents.length === 0 ? (
          <EmptyState
            title={t("settings.mcpAccess.noIdentities")}
            hint={
              visibleAgents.length === 0
                ? t("settings.mcpAccess.noIdentitiesHint")
                : t("settings.mcpAccess.noIdentitiesFiltered")
            }
            action={
              visibleAgents.length === 0 ? (
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => {
                    secretSession.current += 1;
                    setCreateOpen(true);
                    setError(null);
                  }}
                >
                  <Plus size={13} /> {t("settings.mcpAccess.create")}
                </button>
              ) : undefined
            }
          />
        ) : (
          <div className="settings-identity-list">
            {filteredAgents.map((agent) => {
              const agentCaps = capabilities[agent.id];
              const agentRoots = roots[agent.id];
              const granted = asList(agent.granted_project_ids);
              const grantable = projects.filter((project) => !granted.includes(project.id));
              return (
                <article key={agent.id} className="settings-identity" aria-label={agent.display_name}>
                  <header className="settings-identity-head">
                    <div className="settings-identity-id">
                      <h5>{agent.display_name}</h5>
                      <p>
                        <code dir="ltr">{agent.agent_id}</code>
                        <span aria-hidden="true"> · </span>
                        {t("settings.mcpAccess.lastSeen")}:{" "}
                        {agent.last_seen_at ?? t("settings.mcpAccess.neverSeen")}
                      </p>
                    </div>
                    <div className="settings-identity-actions">
                      <button
                        type="button"
                        className="btn sm"
                        aria-expanded={expandedAgent === agent.id}
                        aria-controls={`mcp-agent-panel-${agent.id}`}
                        onClick={() => void openAgentPanel(agent)}
                      >
                        {t("settings.mcpAccess.agents.manage")}
                      </button>
                      <button
                        type="button"
                        className="btn sm"
                        disabled={busyId === agent.id}
                        onClick={() => setPendingAction({ kind: "rotate", agent })}
                      >
                        {t("settings.mcpAccess.rotateToken")}
                      </button>
                      <button
                        type="button"
                        className="btn sm danger"
                        disabled={busyId === agent.id}
                        onClick={() => setPendingAction({ kind: "revoke", agent })}
                      >
                        {t("settings.mcpAccess.revoke")}
                      </button>
                    </div>
                  </header>

                  <div className="settings-identity-scope">
                    <span className="settings-field-label">
                      {t("settings.mcpAccess.scopeLabel")}
                    </span>
                    <div className="settings-segmented" role="group" aria-label={t("settings.mcpAccess.scopeLabel")}>
                      {SCOPES.map((scope) => (
                        <button
                          key={scope}
                          type="button"
                          aria-pressed={agent.scope === scope}
                          className={agent.scope === scope ? "is-active" : undefined}
                          disabled={busyId === agent.id || agent.scope === scope}
                          onClick={() => void updateScope(agent, scope)}
                        >
                          {t(scopeLabel(scope))}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="settings-identity-projects">
                    <span className="settings-field-label">
                      {t("settings.mcpAccess.grantedProjects")}
                    </span>
                    {granted.length === 0 ? (
                      <span className="setting-note">{t("settings.mcpAccess.grantedProjectsEmpty")}</span>
                    ) : (
                      <ul className="settings-chip-list">
                        {granted.map((id) => (
                          <li key={id} className="chip">
                            <span>{projects.find((project) => project.id === id)?.name ?? id}</span>
                            <button
                              type="button"
                              className="chip-remove"
                              aria-label={t("settings.mcpAccess.revokeProject")}
                              disabled={busyId === agent.id}
                              onClick={() => setPendingAction({ kind: "revokeProject", agent, projectId: id })}
                            >
                              ×
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                    {grantable.length > 0 && (
                      <div className="settings-actions-row">
                        {grantable.map((project) => (
                          <button
                            key={project.id}
                            type="button"
                            className="btn sm"
                            disabled={busyId === agent.id}
                            onClick={() => void grantProject(agent, project.id)}
                          >
                            {t("settings.mcpAccess.grantProjectTo", { project: project.name })}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  {expandedAgent === agent.id && (
                    <div id={`mcp-agent-panel-${agent.id}`} className="settings-identity-panel">
                      <div className="settings-subgroup">
                        <h6 className="settings-subgroup-title">
                          {t("settings.mcpAccess.capabilities.title")}
                        </h6>
                        <p className="setting-note">{t("settings.mcpAccess.capabilities.hint")}</p>
                        {capBusy === agent.id && !agentCaps ? (
                          <p className="setting-note">
                            {t("settings.mcpAccess.capabilities.loading")}
                          </p>
                        ) : (
                          <div
                            className="settings-checkbox-grid"
                            role="group"
                            aria-label={t("settings.mcpAccess.capabilities.title")}
                          >
                            {CAPABILITIES.map((item) => (
                              <label key={item.id}>
                                <input
                                  type="checkbox"
                                  checked={hasGlobalCapability(agentCaps, item.id)}
                                  disabled={capBusy === agent.id}
                                  onChange={() => void toggleCapability(agent, item.id)}
                                />
                                <span>{t(item.label)}</span>
                              </label>
                            ))}
                          </div>
                        )}
                        {agentCaps && agentCaps.length === 0 && (
                          <p className="setting-note">{t("settings.mcpAccess.capabilities.empty")}</p>
                        )}
                      </div>

                      <div className="settings-subgroup">
                        <h6 className="settings-subgroup-title">
                          {t("settings.mcpAccess.workspace.title")}
                        </h6>
                        <p className="setting-note">{t("settings.mcpAccess.workspace.hint")}</p>
                        {agentRoots && agentRoots.length > 0 ? (
                          <ul className="settings-root-list">
                            {agentRoots.map((root) => (
                              <li key={root.id}>
                                <code dir="ltr">{root.rootPath}</code>
                                <button
                                  type="button"
                                  className="btn sm"
                                  disabled={capBusy === agent.id}
                                  onClick={() => void removeRoot(agent, root.id)}
                                >
                                  {t("settings.mcpAccess.workspace.remove")}
                                </button>
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p className="setting-note">{t("settings.mcpAccess.workspace.empty")}</p>
                        )}
                        <div className="settings-inline-form">
                          <label className="settings-field">
                            <span>{t("settings.mcpAccess.workspace.title")}</span>
                            <input
                              className="ui-input"
                              value={rootDraft}
                              placeholder={t("settings.mcpAccess.workspace.placeholder")}
                              onChange={(event) => setRootDraft(event.target.value)}
                              autoComplete="off"
                            />
                          </label>
                          <button
                            type="button"
                            className="btn sm"
                            disabled={capBusy === agent.id || !rootDraft.trim()}
                            onClick={() => void addRoot(agent)}
                          >
                            {t("settings.mcpAccess.workspace.add")}
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </SettingsGroup>

      {/* ③ 操作审计 */}
      <SettingsGroup
        className="mcp-access mcp-audit"
        title={t("settings.mcpAccess.auditTitle")}
        description={t("settings.mcpAccess.auditDesc")}
      >
        {auditLoading ? (
          <p className="setting-note">{t("settings.mcpAccess.status.loading")}</p>
        ) : !audit || audit.items.length === 0 ? (
          <EmptyState
            title={t("settings.mcpAccess.auditEmpty")}
            hint={t("settings.mcpAccess.auditEmptyHint")}
          />
        ) : (
          <>
            <ul className="settings-audit-list">
              {audit.items.map((item, index) => (
                <li
                  key={`${item.createdAt}-${item.agentId}-${item.action}-${index}`}
                  className="settings-audit-item"
                >
                  <span className="settings-audit-time">
                    <time dateTime={item.createdAt}>{item.createdAt}</time>
                  </span>
                  <span className="settings-audit-main">
                    <strong>{item.displayName ?? item.agentId}</strong>
                    <span className="settings-audit-action">{item.action}</span>
                    <span className="settings-audit-entity">
                      {item.entityType}: {item.entityId}
                    </span>
                  </span>
                  <span className="settings-audit-flags">
                    <span
                      className={`chip${item.authorized ? "" : " is-danger"}`}
                    >
                      {item.authorized
                        ? t("settings.mcpAccess.audit.authorized")
                        : t("settings.mcpAccess.audit.denied")}
                    </span>
                    <span className={`chip${item.success ? "" : " is-danger"}`}>
                      {item.success
                        ? t("settings.mcpAccess.audit.success")
                        : t("settings.mcpAccess.audit.failed")}
                    </span>
                    {item.errorCategory && (
                      <span className="chip">
                        {t(`settings.mcpAccess.audit.error.${item.errorCategory}` as MessageKey)}
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
            <div className="settings-pager">
              <button
                type="button"
                className="btn sm"
                disabled={auditLoading || audit.offset <= 0}
                onClick={() => void loadAudit(Math.max(0, audit.offset - audit.limit))}
              >
                {t("settings.mcpAccess.audit.previous")}
              </button>
              <span className="settings-pager-label">
                {t("settings.mcpAccess.audit.page", {
                  start: audit.total === 0 ? 0 : audit.offset + 1,
                  end: Math.min(audit.offset + audit.items.length, audit.total),
                  total: audit.total,
                })}
              </span>
              <button
                type="button"
                className="btn sm"
                disabled={auditLoading || audit.offset + audit.items.length >= audit.total}
                onClick={() => void loadAudit(audit.offset + audit.limit)}
              >
                {t("settings.mcpAccess.audit.next")}
              </button>
            </div>
          </>
        )}
      </SettingsGroup>

      {pendingAction && (
        <div
          role="alertdialog"
          aria-label={t("settings.mcpAccess.confirmTitle")}
          className="settings-confirm"
        >
          <p>
            {t(`settings.mcpAccess.confirm.${pendingAction.kind}` as MessageKey, {
              agent: pendingAction.agent.display_name,
              project:
                pendingAction.kind === "revokeProject"
                  ? projects.find((project) => project.id === pendingAction.projectId)?.name ??
                    pendingAction.projectId
                  : "",
            })}
          </p>
          <div className="settings-actions-row">
            <button type="button" className="btn sm danger" onClick={confirmPendingAction}>
              {t("settings.mcpAccess.confirmAction")}
            </button>
            <button type="button" className="btn sm" onClick={() => setPendingAction(null)}>
              {t("common.cancel")}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
