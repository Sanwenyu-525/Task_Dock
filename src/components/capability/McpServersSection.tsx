//! MCP 子页：TaskDock MCP Server 总览 + 外部 stdio MCP Server 管理。
//!
//! 两个方向严格区分：
//! - Server 端（外部 Agent 连 TaskDock）沿用设置页认证/授权/审计，这里只读总览；
//! - Client 端（TaskDock 连外部 Server）在本页新增/测试/调用，高风险工具需确认。
//! 工具返回内容按不可信数据展示，不自动执行。

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Plug, Plus, RefreshCw, Settings2, Trash2, Zap } from "lucide-react";
import {
  agentMcpStatus,
  capabilityMcpCalls,
  capabilityMcpServerCall,
  capabilityMcpServerDelete,
  capabilityMcpServerSave,
  capabilityMcpServerSetAllowHighRisk,
  capabilityMcpServerSetEnabled,
  capabilityMcpServerTest,
  capabilityMcpServersList,
  type ExternalMcpServer,
  type McpCallPage,
  type McpCallReport,
  type McpConnectionReport,
  type McpToolInfo,
  type McpStatus,
} from "../../lib/bridge";
import { errorMessage } from "../../lib/errors";
import { useLocale } from "../../hooks/useLocale";
import { useUiStore } from "../../store/useUiStore";
import { ConfirmDialog, Dialog, EmptyState, StatusBadge, Switch } from "../ui";

interface EnvRow {
  key: string;
  value: string;
  hasValue: boolean;
}

function statusTone(status: ExternalMcpServer["status"]): "neutral" | "success" | "danger" {
  if (status === "ok") return "success";
  if (status === "failed") return "danger";
  return "neutral";
}

const SECRET_ARG =
  /(token|secret|password|passwd|api[-_]?key|credential|authorization|auth)/i;

function isSecretFlag(arg: string): boolean {
  return /^--?[A-Za-z0-9_-]+$/.test(arg) && SECRET_ARG.test(arg);
}

/** 敏感参数脱敏：`--token xxx` 与 `--token=xxx` 都不显示原值。 */
function maskArgs(args: string[]): string[] {
  let maskNext = false;
  return args.map((arg) => {
    if (maskNext) {
      maskNext = false;
      return "••••••••";
    }
    if (isSecretFlag(arg)) {
      maskNext = true;
      return arg;
    }
    if (SECRET_ARG.test(arg) && arg.includes("=")) {
      return `${arg.split("=")[0]}=••••••••`;
    }
    return arg;
  });
}

function exportableArgs(args: string[]): string[] {
  const out: string[] = [];
  let skipNext = false;
  for (const arg of args) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (isSecretFlag(arg)) {
      skipNext = true;
      continue;
    }
    if (SECRET_ARG.test(arg) && arg.includes("=")) continue;
    out.push(arg);
  }
  return out;
}

function riskTone(level: McpToolInfo["riskLevel"]): "neutral" | "success" | "warning" | "danger" {
  if (level === "high") return "danger";
  if (level === "medium") return "warning";
  if (level === "low") return "success";
  return "neutral";
}

export default function McpServersSection() {
  const { t } = useLocale();
  const [sideStatus, setSideStatus] = useState<McpStatus | null>(null);
  const [servers, setServers] = useState<ExternalMcpServer[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [toolName, setToolName] = useState("");
  const [argsJson, setArgsJson] = useState("{}");
  const [callResult, setCallResult] = useState<McpCallReport | null>(null);
  const [testReport, setTestReport] = useState<McpConnectionReport | null>(null);
  const [calls, setCalls] = useState<McpCallPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [dialog, setDialog] = useState<{ mode: "create" | "edit" } | null>(null);
  const [formName, setFormName] = useState("");
  const [formCommand, setFormCommand] = useState("");
  const [formArgs, setFormArgs] = useState("");
  const [formEnv, setFormEnv] = useState<EnvRow[]>([]);
  const [formAllowHighRisk, setFormAllowHighRisk] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [pendingCall, setPendingCall] = useState<{ tool: McpToolInfo } | null>(null);
  const [confirmedTools, setConfirmedTools] = useState<Set<string>>(new Set());
  const [exportOpen, setExportOpen] = useState(false);
  const [exportIncludeSecrets, setExportIncludeSecrets] = useState(false);
  const [formArgsTouched, setFormArgsTouched] = useState(false);

  const selected = useMemo(
    () => servers.find((item) => item.id === selectedId) ?? null,
    [servers, selectedId],
  );

  const load = useCallback(async (keepSelection = true) => {
    setLoading(true);
    setError(null);
    try {
      const [nextServers, nextStatus] = await Promise.all([
        capabilityMcpServersList(),
        agentMcpStatus().catch(() => null),
      ]);
      setServers(nextServers);
      setSideStatus(nextStatus);
      setSelectedId((previous) => {
        if (keepSelection && previous && nextServers.some((item) => item.id === previous)) {
          return previous;
        }
        return nextServers[0]?.id ?? null;
      });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  useEffect(() => {
    setTestReport(null);
    setCallResult(null);
    setToolName("");
    setArgsJson("{}");
    setConfirmedTools(new Set());
    if (!selectedId) {
      setCalls(null);
      return;
    }
    void capabilityMcpCalls(selectedId, 0, 20)
      .then(setCalls)
      .catch(() => setCalls(null));
  }, [selectedId]);

  function openCreate() {
    setFormName("");
    setFormCommand("");
    setFormArgs("");
    setFormEnv([]);
    setFormAllowHighRisk(false);
    setFormArgsTouched(false);
    setDialog({ mode: "create" });
  }

  function openEdit() {
    if (!selected) return;
    setFormName(selected.name);
    setFormCommand(selected.command);
    // 参数默认不回显原值：敏感参数（token/api-key/password…）不进入表单明文。
    setFormArgs("");
    setFormArgsTouched(false);
    setFormEnv(
      selected.env.map((entry) => ({ key: entry.key, value: "", hasValue: entry.hasValue })),
    );
    setFormAllowHighRisk(selected.allowHighRisk);
    setDialog({ mode: "edit" });
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const args =
        dialog?.mode === "edit" && !formArgsTouched
          ? selected?.args ?? []
          : formArgs
              .split("\n")
              .map((line) => line.trim())
              .filter(Boolean);
      const saved = await capabilityMcpServerSave({
        id: dialog?.mode === "edit" ? selected?.id : undefined,
        name: formName,
        command: formCommand,
        args,
        env: formEnv
          .filter((row) => row.key.trim())
          .map((row) => ({ key: row.key.trim(), value: row.value })),
      });
      if (formAllowHighRisk !== saved.allowHighRisk) {
        await capabilityMcpServerSetAllowHighRisk(saved.id, formAllowHighRisk);
      }
      setNotice(t("cap.mcp.saved"));
      setDialog(null);
      setSelectedId(saved.id);
      await load(true);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    if (!selected) return;
    setBusy(true);
    setError(null);
    setTestReport(null);
    try {
      const report = await capabilityMcpServerTest(selected.id);
      setTestReport(report);
      if (report.ok) {
        setNotice(
          t("cap.mcp.testOk", {
            tools: report.tools.length,
            duration: report.durationMs,
          }),
        );
      }
      await load(true);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function executeCall(tool: McpToolInfo, confirmed: boolean) {
    if (!selected) return;
    setBusy(true);
    setError(null);
    setCallResult(null);
    try {
      const report = await capabilityMcpServerCall(selected.id, tool.name, argsJson, confirmed);
      setCallResult(report);
      if (report.ok && !report.isError) {
        setConfirmedTools((current) => new Set(current).add(tool.name));
      }
      if (report.error) setError(report.error);
      const page = await capabilityMcpCalls(selected.id, 0, 20);
      setCalls(page);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
      setPendingCall(null);
    }
  }

  function requestCall(tool: McpToolInfo) {
    if (!selected) return;
    if (selected.allowHighRisk) {
      void executeCall(tool, false);
      return;
    }
    if (tool.riskLevel === "high") {
      setPendingCall({ tool });
      return;
    }
    if (
      (tool.riskLevel === "unknown" || tool.riskLevel === "medium") &&
      !confirmedTools.has(tool.name)
    ) {
      setPendingCall({ tool });
      return;
    }
    void executeCall(tool, false);
  }

  async function removeServer() {
    if (!selected) return;
    setBusy(true);
    try {
      await capabilityMcpServerDelete(selected.id);
      setDeleteOpen(false);
      setSelectedId(null);
      setNotice(t("cap.mcp.deleted"));
      await load(false);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const tools = testReport?.tools ?? selected?.tools ?? [];
  const exportJson = selected
    ? JSON.stringify(
        {
          name: selected.name,
          transport: selected.transport,
          command: selected.command,
          args: exportIncludeSecrets ? selected.args : exportableArgs(selected.args),
          envKeys: selected.env.map((entry) => entry.key),
        },
        null,
        2,
      )
    : "";

  return (
    <div className="cap-section">
      <div className="cap-card">
        <div className="cap-card-title">
          <Plug size={13} /> {t("cap.mcp.serverSide")}
          <span className="cap-toolbar-spacer" />
          <button
            type="button"
            className="btn sm"
            onClick={() => useUiStore.getState().setTab("settings")}
          >
            <Settings2 size={12} /> {t("cap.mcp.openSettings")}
          </button>
        </div>
        <p className="cap-muted">{t("cap.mcp.serverSideHint")}</p>
        {sideStatus ? (
          <div className="cap-inline">
            <StatusBadge tone={sideStatus.running ? "success" : "neutral"} size="sm">
              {sideStatus.running ? t("cap.mcp.running") : t("cap.mcp.stopped")}
            </StatusBadge>
            <span className="cap-muted">
              {t("cap.mcp.sideSummary", {
                port: sideStatus.port ?? "—",
                agents: sideStatus.active_agent_count,
              })}
            </span>
            {sideStatus.last_call ? (
              <span className="cap-muted">
                {t("cap.mcp.lastCall", {
                  action: sideStatus.last_call.action,
                  agent: sideStatus.last_call.agentId,
                })}
              </span>
            ) : null}
          </div>
        ) : (
          <p className="cap-muted">{t("cap.mcp.sideUnavailable")}</p>
        )}
      </div>

      <div className="cap-toolbar">
        <strong className="cap-card-title">{t("cap.mcp.external")}</strong>
        <span className="cap-toolbar-spacer" />
        <button type="button" className="btn sm" disabled={loading || busy} onClick={() => void load(true)}>
          <RefreshCw size={13} /> {t("cap.refresh")}
        </button>
        <button type="button" className="btn sm primary" onClick={openCreate}>
          <Plus size={13} /> {t("cap.mcp.add")}
        </button>
      </div>

      {notice ? <p className="cap-muted">{notice}</p> : null}
      {error ? (
        <div className="cap-warning" role="alert">
          <AlertTriangle size={13} aria-hidden="true" />
          <span>{error}</span>
        </div>
      ) : null}

      <div className="cap-split">
        <div className="cap-col">
          <div className="cap-col-head">
            <span>{t("cap.mcp.listTitle")}</span>
            <span className="cap-muted">{servers.length}</span>
          </div>
          <div className="cap-list">
            {servers.map((server) => (
              <button
                key={server.id}
                type="button"
                className={`cap-list-item${server.id === selectedId ? " active" : ""}`}
                onClick={() => setSelectedId(server.id)}
              >
                <span className="cap-list-title">
                  <StatusBadge tone={statusTone(server.status)} size="sm">
                    {t(`cap.mcp.status.${server.status}` as "cap.mcp.status.unknown")}
                  </StatusBadge>
                  <span className="cap-ellipsis">{server.name}</span>
                </span>
                <span className="cap-list-meta cap-ellipsis">
                  {server.command} · {t("cap.mcp.toolCount", { count: server.tools.length })}
                </span>
              </button>
            ))}
          </div>
          {!loading && servers.length === 0 ? (
            <EmptyState
              title={t("cap.mcp.empty")}
              hint={t("cap.mcp.emptyHint")}
              icon={<Plug size={18} />}
            />
          ) : null}
        </div>

        <div className="cap-col">
          {selected ? (
            <div className="cap-detail">
              <div className="cap-toolbar">
                <strong className="cap-list-title">{selected.name}</strong>
                <StatusBadge tone={statusTone(selected.status)} size="sm">
                  {t(`cap.mcp.status.${selected.status}` as "cap.mcp.status.unknown")}
                </StatusBadge>
                <span className="cap-toolbar-spacer" />
                <Switch
                  checked={selected.enabled}
                  label={t("cap.enabled")}
                  disabled={busy}
                  onChange={(checked) => {
                    void capabilityMcpServerSetEnabled(selected.id, checked)
                      .then(() => load(true))
                      .catch((e) => setError(errorMessage(e)));
                  }}
                />
                <Switch
                  checked={selected.allowHighRisk}
                  label={t("cap.mcp.allowHighRisk")}
                  disabled={busy}
                  onChange={(checked) => {
                    void capabilityMcpServerSetAllowHighRisk(selected.id, checked)
                      .then(() => load(true))
                      .catch((e) => setError(errorMessage(e)));
                  }}
                />
              </div>
              <dl className="cap-kv">
                <dt>{t("cap.mcp.command")}</dt>
                <dd>{selected.command}</dd>
                <dt>{t("cap.mcp.args")}</dt>
                <dd data-tip={t("cap.mcp.argsSecretHint")}>
                  {maskArgs(selected.args).join(" ") || "—"}
                </dd>
                <dt>{t("cap.mcp.env")}</dt>
                <dd>{selected.env.map((entry) => entry.key).join(", ") || "—"}</dd>
                <dt>{t("cap.mcp.lastConnected")}</dt>
                <dd>{selected.lastConnectedAt ?? "—"}</dd>
              </dl>
              {selected.lastError ? <p className="cap-danger cap-muted">{selected.lastError}</p> : null}
              <div className="cap-inline">
                <button type="button" className="btn sm" disabled={busy} onClick={() => void test()}>
                  <Zap size={12} /> {busy ? t("cap.mcp.testing") : t("cap.mcp.test")}
                </button>
                <button type="button" className="btn sm" onClick={openEdit}>
                  {t("cap.edit")}
                </button>
                <button type="button" className="btn sm" onClick={() => setExportOpen(true)}>
                  {t("cap.export")}
                </button>
                <button type="button" className="btn sm" onClick={() => setDeleteOpen(true)}>
                  <Trash2 size={12} /> {t("cap.delete")}
                </button>
              </div>

              <div className="cap-card">
                <div className="cap-card-title">
                  <span>{t("cap.mcp.tools")}</span>
                  <span className="cap-muted">{tools.length}</span>
                </div>
                {tools.length === 0 ? (
                  <p className="cap-muted">{t("cap.mcp.noTools")}</p>
                ) : (
                  <div className="cap-list">
                    {tools.map((tool) => (
                      <button
                        key={tool.name}
                        type="button"
                        className={`cap-list-item${tool.name === toolName ? " active" : ""}`}
                        onClick={() => {
                          setToolName(tool.name);
                          const schema =
                            typeof tool.inputSchema === "object" && tool.inputSchema !== null
                              ? tool.inputSchema
                              : {};
                          setArgsJson(
                            JSON.stringify(
                              (schema as { properties?: Record<string, unknown> }).properties
                                ? Object.fromEntries(
                                    Object.keys(
                                      (schema as { properties: Record<string, unknown> })
                                        .properties,
                                    ).map((key) => [key, ""]),
                                  )
                                : {},
                              null,
                              2,
                            ),
                          );
                          setCallResult(null);
                        }}
                      >
                        <span className="cap-list-title">
                          <StatusBadge tone={riskTone(tool.riskLevel)} size="sm">
                            {t(`cap.mcp.risk.${tool.riskLevel}` as "cap.mcp.risk.unknown")}
                          </StatusBadge>
                          <span className="cap-ellipsis">{tool.name}</span>
                        </span>
                        <span className="cap-list-meta">{tool.description}</span>
                        {tool.riskReasons.length > 0 ? (
                          <span className="cap-list-meta cap-danger">
                            {tool.riskReasons.join("；")}
                          </span>
                        ) : null}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="cap-card">
                <div className="cap-card-title">
                  <span>{t("cap.mcp.resourcesTitle")}</span>
                  <span className="cap-muted">{(testReport?.resources ?? selected.resources).length}</span>
                </div>
                {(testReport?.resources ?? selected.resources).length === 0 ? (
                  <p className="cap-muted">{t("cap.mcp.noResources")}</p>
                ) : (
                  <div className="cap-list">
                    {(testReport?.resources ?? selected.resources).map((resource) => (
                      <div key={resource.uri} className="cap-source">
                        <span className="cap-list-title cap-ellipsis">
                          {resource.name || resource.uri}
                        </span>
                        <span className="cap-muted">{resource.uri}</span>
                        {resource.description ? (
                          <span className="cap-muted">{resource.description}</span>
                        ) : null}
                        <span className="cap-muted">{resource.mimeType || "—"}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="cap-card">
                <div className="cap-card-title">
                  <span>{t("cap.mcp.promptsTitle")}</span>
                  <span className="cap-muted">{(testReport?.prompts ?? selected.prompts).length}</span>
                </div>
                {(testReport?.prompts ?? selected.prompts).length === 0 ? (
                  <p className="cap-muted">{t("cap.mcp.noPrompts")}</p>
                ) : (
                  <div className="cap-list">
                    {(testReport?.prompts ?? selected.prompts).map((prompt) => (
                      <div key={prompt.name} className="cap-source">
                        <span className="cap-list-title cap-ellipsis">{prompt.name}</span>
                        {prompt.description ? (
                          <span className="cap-muted">{prompt.description}</span>
                        ) : null}
                        <pre className="cap-content">
                          {JSON.stringify(prompt.arguments ?? [], null, 2)}
                        </pre>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {testReport ? (
                <div className="cap-card">
                  <div className="cap-card-title">{t("cap.mcp.testResult")}</div>
                  <dl className="cap-kv">
                    <dt>{t("cap.mcp.protocol")}</dt>
                    <dd>{testReport.protocolVersion || "—"}</dd>
                    <dt>{t("cap.mcp.resources")}</dt>
                    <dd>{testReport.resources.length}</dd>
                    <dt>{t("cap.mcp.prompts")}</dt>
                    <dd>{testReport.prompts.length}</dd>
                    <dt>{t("cap.mcp.duration")}</dt>
                    <dd>{testReport.durationMs} ms</dd>
                  </dl>
                  {testReport.error ? (
                    <p className="cap-danger cap-muted">{testReport.error}</p>
                  ) : null}
                </div>
              ) : null}

              <div className="cap-card">
                <div className="cap-card-title">
                  <span>{t("cap.mcp.callTitle")}</span>
                  {toolName ? <span className="cap-muted">{toolName}</span> : null}
                </div>
                <label className="cap-form">
                  <span>{t("cap.mcp.argsJson")}</span>
                  <textarea
                    className="ws-input cap-json"
                    rows={6}
                    value={argsJson}
                    onChange={(event) => setArgsJson(event.target.value)}
                  />
                </label>
                <div className="cap-inline">
                  <button
                    type="button"
                    className="btn sm primary"
                    disabled={busy || !toolName}
                    onClick={() => {
                      const tool = tools.find((item) => item.name === toolName);
                      if (tool) requestCall(tool);
                    }}
                  >
                    {t("cap.mcp.call")}
                  </button>
                  <span className="cap-muted">{t("cap.mcp.untrusted")}</span>
                </div>
                {callResult ? (
                  <pre className="cap-content">
                    {JSON.stringify(
                      {
                        ok: callResult.ok,
                        isError: callResult.isError,
                        durationMs: callResult.durationMs,
                        content: callResult.content,
                        error: callResult.error,
                      },
                      null,
                      2,
                    )}
                  </pre>
                ) : null}
              </div>

              <div className="cap-card">
                <div className="cap-card-title">{t("cap.mcp.calls")}</div>
                {calls && calls.items.length > 0 ? (
                  <div className="cap-sources">
                    {calls.items.map((call) => (
                      <span key={call.id}>
                        {call.createdAt} · {call.toolName} ·{" "}
                        {call.success ? t("cap.mcp.callOk") : t("cap.mcp.callFailed")} ·{" "}
                        {call.durationMs} ms
                        {call.error ? ` · ${call.error}` : ""}
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="cap-muted">{t("cap.mcp.noCalls")}</p>
                )}
              </div>
            </div>
          ) : (
            <EmptyState title={t("cap.mcp.select")} hint={t("cap.mcp.selectHint")} />
          )}
        </div>
      </div>

      <Dialog
        open={dialog !== null}
        onClose={() => setDialog(null)}
        title={dialog?.mode === "edit" ? t("cap.mcp.editTitle") : t("cap.mcp.addTitle")}
        size="md"
        footer={
          <>
            <button type="button" className="btn" onClick={() => setDialog(null)}>
              {t("common.cancel")}
            </button>
            <button type="button" className="btn primary" disabled={busy} onClick={() => void save()}>
              {t("cap.save")}
            </button>
          </>
        }
      >
        <div className="cap-form">
          <label>
            {t("cap.name")}
            <input
              className="ws-input"
              value={formName}
              maxLength={80}
              autoFocus
              onChange={(event) => setFormName(event.target.value)}
            />
          </label>
          <label>
            {t("cap.mcp.command")}
            <input
              className="ws-input"
              value={formCommand}
              placeholder="npx / node / C:\\path\\server.exe"
              onChange={(event) => setFormCommand(event.target.value)}
            />
          </label>
          <label>
            {t("cap.mcp.args")}
            <span className="cap-muted">
              {dialog?.mode === "edit" ? t("cap.mcp.argsKeepHint") : t("cap.mcp.argsHint")}
            </span>
          </label>
          {dialog?.mode === "edit" && selected && selected.args.length > 0 ? (
            <div className="cap-sources">
              <span data-tip={t("cap.mcp.argsSecretHint")}>
                {maskArgs(selected.args).join(" ")}
              </span>
            </div>
          ) : null}
          <textarea
            className="ws-input"
            rows={4}
            value={formArgs}
            placeholder={t("cap.mcp.argsHint")}
            onChange={(event) => {
              setFormArgs(event.target.value);
              setFormArgsTouched(true);
            }}
          />
          <label>
            {t("cap.mcp.env")}
            <span className="cap-muted">{t("cap.mcp.envHint")}</span>
          </label>
          <div className="cap-sources">
            {formEnv.map((row, index) => (
              <div key={`${row.key}-${index}`} className="cap-inline">
                <input
                  className="ws-input"
                  value={row.key}
                  placeholder={t("cap.mcp.envKey")}
                  onChange={(event) =>
                    setFormEnv((current) =>
                      current.map((item, i) =>
                        i === index ? { ...item, key: event.target.value } : item,
                      ),
                    )
                  }
                />
                <input
                  className="ws-input"
                  type="password"
                  value={row.value}
                  placeholder={
                    row.hasValue ? t("cap.mcp.envKeepHint") : t("cap.mcp.envValue")
                  }
                  onChange={(event) =>
                    setFormEnv((current) =>
                      current.map((item, i) =>
                        i === index ? { ...item, value: event.target.value } : item,
                      ),
                    )
                  }
                />
                <button
                  type="button"
                  className="icon-btn sm"
                  aria-label={t("cap.delete")}
                  onClick={() =>
                    setFormEnv((current) => current.filter((_, i) => i !== index))
                  }
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
            <button
              type="button"
              className="btn sm"
              onClick={() => setFormEnv((current) => [...current, { key: "", value: "", hasValue: false }])}
            >
              <Plus size={12} /> {t("cap.mcp.addEnv")}
            </button>
          </div>
          <Switch
            checked={formAllowHighRisk}
            onChange={setFormAllowHighRisk}
            label={t("cap.mcp.allowHighRisk")}
          />
          <p className="cap-muted">{t("cap.mcp.allowHighRiskHint")}</p>
        </div>
      </Dialog>

      <Dialog
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        title={t("cap.mcp.exportTitle")}
        size="md"
        footer={
          <button type="button" className="btn" onClick={() => setExportOpen(false)}>
            {t("common.close")}
          </button>
        }
      >
        <div className="cap-form">
          <p className="cap-muted">{t("cap.mcp.exportHint")}</p>
          <Switch
            checked={exportIncludeSecrets}
            onChange={setExportIncludeSecrets}
            label={t("cap.mcp.exportIncludeSecrets")}
          />
          <pre className="cap-content">{exportJson}</pre>
        </div>
      </Dialog>

      <ConfirmDialog
        open={deleteOpen}
        title={t("cap.mcp.deleteTitle", { name: selected?.name ?? "" })}
        detail={t("cap.mcp.deleteDetail")}
        danger
        busy={busy}
        confirmLabel={t("cap.delete")}
        cancelLabel={t("common.cancel")}
        onConfirm={() => void removeServer()}
        onCancel={() => setDeleteOpen(false)}
      />

      <ConfirmDialog
        open={pendingCall !== null}
        title={t("cap.mcp.confirmHighRiskTitle")}
        detail={t("cap.mcp.confirmHighRiskDetail", { tool: pendingCall?.tool.name ?? "" })}
        danger
        busy={busy}
        confirmLabel={t("cap.mcp.callAnyway")}
        cancelLabel={t("common.cancel")}
        onConfirm={() => {
          if (pendingCall) void executeCall(pendingCall.tool, true);
        }}
        onCancel={() => setPendingCall(null)}
      />
    </div>
  );
}
