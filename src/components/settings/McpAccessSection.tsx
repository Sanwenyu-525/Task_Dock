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

export default function McpAccessSection() {
  const { t } = useLocale();
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
      setAudit(result);
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
      setStatus(nextStatus);
      setAgents(nextAgents);
      setProjects(nextProjects);
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
      setCapabilities((current) => ({ ...current, [agent.id]: caps }));
      setRoots((current) => ({ ...current, [agent.id]: nextRoots }));
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
      setCapabilities((current) => ({ ...current, [agent.id]: next }));
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
      setRoots((current) => ({ ...current, [agent.id]: next }));
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
      setRoots((current) => ({ ...current, [agent.id]: next }));
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
    <section aria-labelledby="mcp-access-title" className="settings-section mcp-access">
      <header className="settings-section-header">
        <div>
          <h3 id="mcp-access-title">{t("settings.mcpAccess.title")}</h3>
          <p>{t("settings.mcpAccess.description")}</p>
        </div>
        <button type="button" aria-label={t("settings.mcpAccess.refresh")} onClick={() => void refresh()} disabled={loading}>
          <RefreshCw size={15} />
        </button>
      </header>

      <div role="status" aria-live="polite" className="setting-note">
        <Shield size={15} aria-hidden="true" /> {t("settings.mcpAccess.serverStatus")}: {statusText(status, loading, t)}
        {status ? ` · ${status.enabled ? t("settings.mcpAccess.serverEnabled") : t("settings.mcpAccess.serverDisabled")}` : ""}
        {status?.running && status.port !== null ? ` · ${t("settings.mcpAccess.port", { port: status.port })}` : ""}
        {status ? ` · ${t("settings.mcpAccess.activeAgents", { count: status.active_agent_count })}` : ""}
        {status
          ? ` · ${t("settings.mcpAccess.lastCall")}: ${
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
            }`
          : ""}
      </div>
      {error && <p role="alert">{t("settings.mcpAccess.error", { message: error })}</p>}

      <div className="setting-row column">
        <button type="button" className="btn sm" onClick={() => void runDiagnostics()} disabled={diagBusy}>
          {diagBusy ? t("settings.mcpAccess.diagnostics.running") : t("settings.mcpAccess.diagnostics.run")}
        </button>
        <div className="setting-note">
          {!diagnostics ? (
            <p>{t("settings.mcpAccess.diagnostics.empty")}</p>
          ) : (
            <>
              <p>
                {t(`settings.mcpAccess.diagnostics.overall.${diagnostics.overall}` as MessageKey)} ·{" "}
                {t("settings.mcpAccess.diagnostics.toolCount", {
                  total: diagnostics.toolCount,
                  original: diagnostics.originalToolCount,
                })}
              </p>
              <ul>
                {diagnostics.steps.map((step) => (
                  <li key={step.id}>
                    <strong>{step.label}</strong>
                    {" · "}
                    {t(`settings.mcpAccess.diagnostics.status.${step.status}` as MessageKey)}
                    {" · "}
                    {step.detail}
                    {step.hint ? <div className="setting-note">{step.hint}</div> : null}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>

      {!createOpen ? (
        <button type="button" onClick={() => { secretSession.current += 1; setCreateOpen(true); setError(null); }}>
          <Plus size={15} /> {t("settings.mcpAccess.create")}
        </button>
      ) : (
        <div aria-label={t("settings.mcpAccess.createTitle")}>
          <h4>{t("settings.mcpAccess.createTitle")}</h4>
          {!created ? (
            <>
              <label>
                {t("settings.mcpAccess.agentId")}
                <input value={agentId} onChange={(event) => setAgentId(event.target.value)} autoComplete="off" />
              </label>
              <label>
                {t("settings.mcpAccess.displayName")}
                <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} autoComplete="off" />
              </label>
              <button type="button" onClick={() => void createCredential()} disabled={busyId !== null || !agentId.trim() || !displayName.trim()}>
                {t("settings.mcpAccess.createCredential")}
              </button>
            </>
          ) : (
            <div>
              <p>{t("settings.mcpAccess.secretNotice")}</p>
              <label>
                {t("settings.mcpAccess.token")}
                <input aria-label={t("settings.mcpAccess.token")} readOnly value={created.token} />
              </label>
              <button type="button" onClick={() => void copy(created.token)}><Copy size={14} /> {t("settings.mcpAccess.copyToken")}</button>
              {copied === created.token && <span role="status">{t("settings.mcpAccess.copied")}</span>}
              <fieldset className="mcp-btn-group">
                <legend>{t("settings.mcpAccess.configClient")}</legend>
                {CLIENTS.map((item) => (
                  <button key={item} type="button" aria-pressed={client === item} onClick={() => { setClient(item); setSnippet(""); setHint(""); }}>
                    {item}
                  </button>
                ))}
                <button type="button" onClick={() => void buildSnippet()}>{t("settings.mcpAccess.generateConfig")}</button>
              </fieldset>
              {snippet && (
                <>
                  <textarea aria-label={t("settings.mcpAccess.configSnippet")} readOnly value={snippet} />
                  <button type="button" onClick={() => void copy(snippet)}><Copy size={14} /> {t("settings.mcpAccess.copyConfig")}</button>
                  {copied === snippet && <span role="status">{t("settings.mcpAccess.copied")}</span>}
                  {hint && <p className="setting-note">{t("settings.mcpAccess.configHint", { hint })}</p>}
                </>
              )}
            </div>
          )}
          <button type="button" onClick={closeCreate} disabled={secretBusy}>
            <X size={14} /> {t("settings.mcpAccess.closeCreate")}
          </button>
        </div>
      )}

      <div>
        <h4>{t("settings.mcpAccess.identities")}</h4>
        <label>
          {t("settings.mcpAccess.agents.search")}
          <input value={agentQuery} onChange={(event) => setAgentQuery(event.target.value)} type="search" />
        </label>
        {loading ? <p>{t("settings.mcpAccess.status.loading")}</p> : filteredAgents.length === 0 ? <p>{t("settings.mcpAccess.noIdentities")}</p> : null}
        <div className="mcp-agent-list">
        {filteredAgents.map((agent) => {
          const agentCaps = capabilities[agent.id];
          const agentRoots = roots[agent.id];
          return (
            <article key={agent.id} aria-label={agent.display_name} className="setting-note">
              <h5>{agent.display_name}</h5>
              <p>{agent.agent_id} · {t("settings.mcpAccess.lastSeen")}: {agent.last_seen_at ?? t("settings.mcpAccess.neverSeen")}</p>
              <div className="mcp-btn-group" aria-label={t("settings.mcpAccess.scopeLabel")}>
                {SCOPES.map((scope) => (
                  <button key={scope} type="button" aria-pressed={agent.scope === scope} disabled={busyId === agent.id || agent.scope === scope} onClick={() => void updateScope(agent, scope)}>
                    {t(scopeLabel(scope))}
                  </button>
                ))}
              </div>
              <p>{t("settings.mcpAccess.grantedProjects")}:</p>
              <ul>{agent.granted_project_ids.map((id) => (
                <li key={id}>
                  {projects.find((project) => project.id === id)?.name ?? id}
                  <button type="button" disabled={busyId === agent.id} onClick={() => setPendingAction({ kind: "revokeProject", agent, projectId: id })}>
                    {t("settings.mcpAccess.revokeProject")}
                  </button>
                </li>
              ))}</ul>
              {projects.filter((project) => !agent.granted_project_ids.includes(project.id)).length > 0 && (
                <div className="mcp-btn-group" aria-label={t("settings.mcpAccess.grantProject")}>
                  {projects.filter((project) => !agent.granted_project_ids.includes(project.id)).map((project) => (
                    <button key={project.id} type="button" disabled={busyId === agent.id} onClick={() => void grantProject(agent, project.id)}>
                      {t("settings.mcpAccess.grantProjectTo", { project: project.name })}
                    </button>
                  ))}
                </div>
              )}

              <button
                type="button"
                aria-expanded={expandedAgent === agent.id}
                aria-controls={`mcp-agent-panel-${agent.id}`}
                onClick={() => void openAgentPanel(agent)}
              >
                {t("settings.mcpAccess.agents.manage")}
              </button>
              {expandedAgent === agent.id && (
                <div id={`mcp-agent-panel-${agent.id}`} className="setting-note">
                  <h6>{t("settings.mcpAccess.capabilities.title")}</h6>
                  <p>{t("settings.mcpAccess.capabilities.hint")}</p>
                  {capBusy === agent.id && !agentCaps ? (
                    <p>{t("settings.mcpAccess.capabilities.loading")}</p>
                  ) : (
                    <div role="group" aria-label={t("settings.mcpAccess.capabilities.title")}>
                      {CAPABILITIES.map((item) => (
                        <label key={item.id}>
                          <input
                            type="checkbox"
                            checked={hasGlobalCapability(agentCaps, item.id)}
                            disabled={capBusy === agent.id}
                            onChange={() => void toggleCapability(agent, item.id)}
                          />
                          {t(item.label)}
                        </label>
                      ))}
                    </div>
                  )}
                  {agentCaps && agentCaps.length === 0 && (
                    <p>{t("settings.mcpAccess.capabilities.empty")}</p>
                  )}

                  <h6>{t("settings.mcpAccess.workspace.title")}</h6>
                  <p>{t("settings.mcpAccess.workspace.hint")}</p>
                  {agentRoots && agentRoots.length > 0 ? (
                    <ul>
                      {agentRoots.map((root) => (
                        <li key={root.id}>
                          <code>{root.rootPath}</code>
                          <button type="button" disabled={capBusy === agent.id} onClick={() => void removeRoot(agent, root.id)}>
                            {t("settings.mcpAccess.workspace.remove")}
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p>{t("settings.mcpAccess.workspace.empty")}</p>
                  )}
                  <label>
                    {t("settings.mcpAccess.workspace.title")}
                    <input
                      value={rootDraft}
                      placeholder={t("settings.mcpAccess.workspace.placeholder")}
                      onChange={(event) => setRootDraft(event.target.value)}
                      autoComplete="off"
                    />
                  </label>
                  <button type="button" disabled={capBusy === agent.id || !rootDraft.trim()} onClick={() => void addRoot(agent)}>
                    {t("settings.mcpAccess.workspace.add")}
                  </button>
                </div>
              )}

              <button type="button" disabled={busyId === agent.id} onClick={() => setPendingAction({ kind: "rotate", agent })}>{t("settings.mcpAccess.rotateToken")}</button>
              <button type="button" disabled={busyId === agent.id} onClick={() => setPendingAction({ kind: "revoke", agent })}>{t("settings.mcpAccess.revoke")}</button>
            </article>
          );
        })}
        </div>
      </div>

      {pendingAction && (
        <div role="alertdialog" aria-label={t("settings.mcpAccess.confirmTitle")}>
          <p>{t(`settings.mcpAccess.confirm.${pendingAction.kind}` as MessageKey, {
            agent: pendingAction.agent.display_name,
            project: pendingAction.kind === "revokeProject"
              ? projects.find((project) => project.id === pendingAction.projectId)?.name ?? pendingAction.projectId
              : "",
          })}</p>
          <div className="mcp-btn-group">
            <button type="button" onClick={confirmPendingAction}>{t("settings.mcpAccess.confirmAction")}</button>
            <button type="button" onClick={() => setPendingAction(null)}>{t("common.cancel")}</button>
          </div>
        </div>
      )}

      <div>
        <h4>{t("settings.mcpAccess.auditTitle")}</h4>
        {auditLoading ? <p>{t("settings.mcpAccess.status.loading")}</p> : !audit || audit.items.length === 0 ? (
          <p>{t("settings.mcpAccess.auditEmpty")}</p>
        ) : (
          <>
            <ul>
              {audit.items.map((item, index) => (
                <li key={`${item.createdAt}-${item.agentId}-${item.action}-${index}`}>
                  <time dateTime={item.createdAt}>{item.createdAt}</time>
                  {" · "}{item.displayName ?? item.agentId}{" · "}{item.action}{" · "}{item.entityType}: {item.entityId}
                  {" · "}{item.authorized ? t("settings.mcpAccess.audit.authorized") : t("settings.mcpAccess.audit.denied")}
                  {" · "}{item.success ? t("settings.mcpAccess.audit.success") : t("settings.mcpAccess.audit.failed")}
                  {item.errorCategory && ` · ${t(`settings.mcpAccess.audit.error.${item.errorCategory}` as MessageKey)}`}
                </li>
              ))}
            </ul>
            <div className="mcp-btn-group">
              <button type="button" disabled={auditLoading || audit.offset <= 0} onClick={() => void loadAudit(Math.max(0, audit.offset - audit.limit))}>
                {t("settings.mcpAccess.audit.previous")}
              </button>
              <span>{t("settings.mcpAccess.audit.page", { start: audit.total === 0 ? 0 : audit.offset + 1, end: Math.min(audit.offset + audit.items.length, audit.total), total: audit.total })}</span>
              <button type="button" disabled={auditLoading || audit.offset + audit.items.length >= audit.total} onClick={() => void loadAudit(audit.offset + audit.limit)}>
                {t("settings.mcpAccess.audit.next")}
              </button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
