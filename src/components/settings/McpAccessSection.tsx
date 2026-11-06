import { useCallback, useEffect, useRef, useState } from "react";
import { Copy, Plus, RefreshCw, Shield, X } from "lucide-react";
import {
  agentMcpConfigSnippet,
  agentMcpCreate,
  agentMcpAuditList,
  agentMcpGrantProject,
  agentMcpList,
  agentMcpRevokeProject,
  agentMcpRevoke,
  agentMcpRotateToken,
  agentMcpSetScope,
  agentMcpStatus,
  planningListProjects,
  type McpAgentCreated,
  type McpAgentInfo,
  type McpAgentScope,
  type McpAuditPage,
  type McpConfigClient,
  type McpStatus,
  type PlanningProject,
} from "../../lib/bridge";
import { localizedErrorMessage } from "../../i18n/errors";
import { useLocale } from "../../hooks/useLocale";
import type { MessageKey } from "../../i18n";

const SCOPES: readonly McpAgentScope[] = ["disabled", "readonly", "project_rw"];
const CLIENTS: readonly McpConfigClient[] = ["claude-code", "codex", "cursor", "trae", "generic"];
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
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [secretBusy, setSecretBusy] = useState(false);
  const [pendingAction, setPendingAction] = useState<
    | { kind: "rotate" | "revoke"; agent: McpAgentInfo }
    | { kind: "revokeProject"; agent: McpAgentInfo; projectId: string }
    | null
  >(null);
  const mounted = useRef(false);
  const requestId = useRef(0);
  const auditRequestId = useRef(0);
  const secretSession = useRef(0);

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
    };
  }, [refresh]);

  function closeCreate() {
    secretSession.current += 1;
    setCreateOpen(false);
    setCreated(null);
    setSnippet("");
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

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setError(null);
    } catch (reason) {
      setError(localizedErrorMessage(reason));
    }
  }

  async function buildSnippet() {
    if (!created) return;
    const session = secretSession.current;
    setError(null);
    try {
      const result = await agentMcpConfigSnippet(client, created.token);
      if (session === secretSession.current) setSnippet(result);
    } catch (reason) {
      setError(localizedErrorMessage(reason));
    }
  }

  const visibleAgents = agents.filter((agent) => !agent.revoked_at);

  return (
    <section aria-labelledby="mcp-access-title" className="settings-section">
      <header className="settings-section-header">
        <div>
          <h3 id="mcp-access-title">{t("settings.mcpAccess.title")}</h3>
          <p>{t("settings.mcpAccess.description")}</p>
        </div>
        <button type="button" aria-label={t("settings.mcpAccess.refresh")} onClick={() => void refresh()} disabled={loading}>
          <RefreshCw size={15} />
        </button>
      </header>

      <div role="status" aria-live="polite">
        <Shield size={15} aria-hidden="true" /> {t("settings.mcpAccess.serverStatus")}: {statusText(status, loading, t)}
        {status?.running && status.port !== null ? ` · ${t("settings.mcpAccess.port", { port: status.port })}` : ""}
      </div>
      {error && <p role="alert">{t("settings.mcpAccess.error", { message: error })}</p>}

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
              <fieldset>
                <legend>{t("settings.mcpAccess.configClient")}</legend>
                {CLIENTS.map((item) => (
                  <button key={item} type="button" aria-pressed={client === item} onClick={() => { setClient(item); setSnippet(""); }}>
                    {item}
                  </button>
                ))}
                <button type="button" onClick={() => void buildSnippet()}>{t("settings.mcpAccess.generateConfig")}</button>
              </fieldset>
              {snippet && <><textarea aria-label={t("settings.mcpAccess.configSnippet")} readOnly value={snippet} /><button type="button" onClick={() => void copy(snippet)}><Copy size={14} /> {t("settings.mcpAccess.copyConfig")}</button></>}
            </div>
          )}
          <button type="button" onClick={closeCreate} disabled={secretBusy}>
            <X size={14} /> {t("settings.mcpAccess.closeCreate")}
          </button>
        </div>
      )}

      <div>
        <h4>{t("settings.mcpAccess.identities")}</h4>
        {loading ? <p>{t("settings.mcpAccess.status.loading")}</p> : visibleAgents.length === 0 ? <p>{t("settings.mcpAccess.noIdentities")}</p> : null}
        {visibleAgents.map((agent) => (
          <article key={agent.id} aria-label={agent.display_name}>
            <h5>{agent.display_name}</h5>
            <p>{agent.agent_id} · {t("settings.mcpAccess.lastSeen")}: {agent.last_seen_at ?? t("settings.mcpAccess.neverSeen")}</p>
            <div aria-label={t("settings.mcpAccess.scopeLabel")}>
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
              <div aria-label={t("settings.mcpAccess.grantProject")}>
                {projects.filter((project) => !agent.granted_project_ids.includes(project.id)).map((project) => (
                  <button key={project.id} type="button" disabled={busyId === agent.id} onClick={() => void grantProject(agent, project.id)}>
                    {t("settings.mcpAccess.grantProjectTo", { project: project.name })}
                  </button>
                ))}
              </div>
            )}
            <button type="button" disabled={busyId === agent.id} onClick={() => setPendingAction({ kind: "rotate", agent })}>{t("settings.mcpAccess.rotateToken")}</button>
            <button type="button" disabled={busyId === agent.id} onClick={() => setPendingAction({ kind: "revoke", agent })}>{t("settings.mcpAccess.revoke")}</button>
          </article>
        ))}
      </div>

      {pendingAction && (
        <div role="alertdialog" aria-label={t("settings.mcpAccess.confirmTitle")}>
          <p>{t(`settings.mcpAccess.confirm.${pendingAction.kind}` as MessageKey, {
            agent: pendingAction.agent.display_name,
            project: pendingAction.kind === "revokeProject"
              ? projects.find((project) => project.id === pendingAction.projectId)?.name ?? pendingAction.projectId
              : "",
          })}</p>
          <button type="button" onClick={confirmPendingAction}>{t("settings.mcpAccess.confirmAction")}</button>
          <button type="button" onClick={() => setPendingAction(null)}>{t("common.cancel")}</button>
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
            <div>
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
