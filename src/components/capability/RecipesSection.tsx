//! 能力配方子页：知识检索 / MCP 工具 / 保存笔记三类受限步骤的编排与执行记录。
//!
//! 与工作流引擎职责分离：不提供任意 Shell/脚本步骤；高风险 MCP 步骤整次确认；
//! 失败即停止并保留逐步骤记录，不伪造成功。

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Copy, Download, Play, Plus, Trash2, Upload } from "lucide-react";
import {
  capabilityKbList,
  capabilityMcpServersList,
  capabilityRecipeDelete,
  capabilityRecipeDuplicate,
  capabilityRecipeExport,
  capabilityRecipeGet,
  capabilityRecipeImport,
  capabilityRecipeList,
  capabilityRecipeRun,
  capabilityRecipeRunGet,
  capabilityRecipeRuns,
  capabilityRecipeSave,
  type CapabilityRecipeRun,
  type CapabilityRecipeRunPage,
  type CapabilityRecipeStep,
  type CapabilityRecipeSummary,
  type ExternalMcpServer,
  type KnowledgeBase,
} from "../../lib/bridge";
import { errorMessage } from "../../lib/errors";
import { useLocale } from "../../hooks/useLocale";
import { ConfirmDialog, Dialog, EmptyState, Select, Switch } from "../ui";

interface Draft {
  id?: string;
  name: string;
  description: string;
  enabled: boolean;
  steps: CapabilityRecipeStep[];
}

const DEFAULT_LIMIT = 5;

function stepLabel(type: CapabilityRecipeStep["type"], t: (key: "cap.recipe.step.knowledge" | "cap.recipe.step.mcp" | "cap.recipe.step.note") => string) {
  if (type === "knowledge_search") return t("cap.recipe.step.knowledge");
  if (type === "mcp_tool") return t("cap.recipe.step.mcp");
  return t("cap.recipe.step.note");
}

export default function RecipesSection() {
  const { t } = useLocale();
  const [recipes, setRecipes] = useState<CapabilityRecipeSummary[]>([]);
  const [kbs, setKbs] = useState<KnowledgeBase[]>([]);
  const [servers, setServers] = useState<ExternalMcpServer[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [argsDrafts, setArgsDrafts] = useState<Record<number, string>>({});
  const [runs, setRuns] = useState<CapabilityRecipeRunPage | null>(null);
  const [runDetail, setRunDetail] = useState<CapabilityRecipeRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [runConfirmOpen, setRunConfirmOpen] = useState(false);
  const [exportText, setExportText] = useState<string | null>(null);
  const [includeSecretArgs, setIncludeSecretArgs] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");

  const load = useCallback(async () => {
    setError(null);
    try {
      const [nextRecipes, nextKbs, nextServers] = await Promise.all([
        capabilityRecipeList(),
        capabilityKbList(),
        capabilityMcpServersList(),
      ]);
      setRecipes(nextRecipes);
      setKbs(nextKbs);
      setServers(nextServers.filter((server) => server.enabled));
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const allTools = useMemo(
    () =>
      servers.flatMap((server) =>
        server.tools.map((tool) => ({ serverId: server.id, serverName: server.name, tool })),
      ),
    [servers],
  );

  async function openRecipe(id: string) {
    setBusy(true);
    setError(null);
    try {
      const recipe = await capabilityRecipeGet(id);
      setDraft({
        id: recipe.id,
        name: recipe.name,
        description: recipe.description,
        enabled: recipe.enabled,
        steps: recipe.steps,
      });
      setRunDetail(null);
      setRuns(await capabilityRecipeRuns(id, 0, 20));
      setArgsDrafts({});
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  function newRecipe() {
    setDraft({ name: "", description: "", enabled: true, steps: [] });
    setRuns(null);
    setRunDetail(null);
    setArgsDrafts({});
  }

  function updateStep(index: number, patch: Record<string, unknown>) {
    setDraft((current) =>
      current
        ? {
            ...current,
            steps: current.steps.map((step, i) =>
              i === index ? ({ ...step, ...patch } as CapabilityRecipeStep) : step,
            ),
          }
        : current,
    );
  }

  function addStep(type: CapabilityRecipeStep["type"]) {
    setDraft((current) => {
      if (!current) return current;
      const firstServer = servers[0];
      const firstTool = firstServer?.tools[0];
      const step: CapabilityRecipeStep =
        type === "knowledge_search"
          ? { type: "knowledge_search", kbIds: kbs[0] ? [kbs[0].id] : [], query: "", limit: DEFAULT_LIMIT }
          : type === "mcp_tool"
            ? {
                type: "mcp_tool",
                serverId: firstServer?.id ?? "",
                toolName: firstTool?.name ?? "",
                args: {},
                highRisk: firstTool?.highRisk ?? false,
              }
            : { type: "save_note", title: "" };
      return { ...current, steps: [...current.steps, step] };
    });
  }

  async function save() {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await capabilityRecipeSave({
        id: draft.id,
        name: draft.name,
        description: draft.description,
        enabled: draft.enabled,
        steps: draft.steps,
      });
      setNotice(t("cap.recipe.saved"));
      await load();
      setDraft({
        id: saved.id,
        name: saved.name,
        description: saved.description,
        enabled: saved.enabled,
        steps: saved.steps,
      });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  function requestRun() {
    if (!draft?.id) return;
    const highRisk = draft.steps.some(
      (step) =>
        step.type === "mcp_tool" &&
        (step.highRisk ||
          allTools.find(
            (item) => item.serverId === step.serverId && item.tool.name === step.toolName,
          )?.tool.highRisk),
    );
    if (highRisk) {
      setRunConfirmOpen(true);
      return;
    }
    void run(false);
  }

  async function run(confirmed: boolean) {
    if (!draft?.id) return;
    setBusy(true);
    setError(null);
    setRunDetail(null);
    try {
      const result = await capabilityRecipeRun(draft.id, confirmed);
      setRunDetail(result);
      setRuns(await capabilityRecipeRuns(draft.id, 0, 20));
      setNotice(
        result.status === "succeeded"
          ? t("cap.recipe.runSucceeded")
          : t("cap.recipe.runFailed"),
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
      setRunConfirmOpen(false);
    }
  }

  async function duplicate() {
    if (!draft?.id) return;
    setBusy(true);
    try {
      const copy = await capabilityRecipeDuplicate(draft.id);
      setNotice(t("cap.recipe.duplicated"));
      await load();
      await openRecipe(copy.id);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!draft?.id) return;
    setBusy(true);
    try {
      await capabilityRecipeDelete(draft.id);
      setDeleteOpen(false);
      setDraft(null);
      setRuns(null);
      setRunDetail(null);
      setNotice(t("cap.recipe.deleted"));
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function exportRecipe(includeSecrets = includeSecretArgs) {
    if (!draft?.id) return;
    setBusy(true);
    try {
      setExportText(await capabilityRecipeExport(draft.id, includeSecrets));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function importRecipe() {
    setBusy(true);
    setError(null);
    try {
      const imported = await capabilityRecipeImport(importText);
      setImportOpen(false);
      setImportText("");
      setNotice(t("cap.recipe.imported"));
      await load();
      await openRecipe(imported.id);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function openRun(id: string) {
    try {
      setRunDetail(await capabilityRecipeRunGet(id));
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <div className="cap-section">
      <div className="cap-toolbar">
        <strong className="cap-card-title">{t("cap.recipe.listTitle")}</strong>
        <span className="cap-toolbar-spacer" />
        <button type="button" className="btn sm" onClick={() => setImportOpen(true)}>
          <Upload size={13} /> {t("cap.recipe.import")}
        </button>
        <button type="button" className="btn sm primary" onClick={newRecipe}>
          <Plus size={13} /> {t("cap.recipe.new")}
        </button>
      </div>

      {notice ? <p className="cap-muted">{notice}</p> : null}
      {error ? (
        <div className="cap-warning" role="alert">
          <AlertTriangle size={13} aria-hidden="true" />
          <span>{error}</span>
        </div>
      ) : null}

      <div className="cap-split two">
        <div className="cap-col">
          <div className="cap-col-head">
            <span>{t("cap.recipe.recipes")}</span>
            <span className="cap-muted">{recipes.length}</span>
          </div>
          <div className="cap-list">
            {recipes.map((recipe) => (
              <button
                key={recipe.id}
                type="button"
                className={`cap-list-item${recipe.id === draft?.id ? " active" : ""}`}
                onClick={() => void openRecipe(recipe.id)}
              >
                <span className="cap-list-title">
                  <span className="cap-ellipsis">{recipe.name}</span>
                  {!recipe.enabled ? <span className="cap-muted">{t("cap.disabled")}</span> : null}
                </span>
                <span className="cap-list-meta">
                  {t("cap.recipe.stepCount", { count: recipe.stepCount })}
                  {recipe.lastRunStatus
                    ? ` · ${t(`cap.recipe.status.${recipe.lastRunStatus}` as "cap.recipe.status.succeeded")}`
                    : ""}
                </span>
              </button>
            ))}
          </div>
          {recipes.length === 0 ? (
            <EmptyState
              title={t("cap.recipe.empty")}
              hint={t("cap.recipe.emptyHint")}
              icon={<Play size={18} />}
            />
          ) : null}
        </div>

        <div className="cap-col">
          {draft ? (
            <div className="cap-detail">
              <div className="cap-toolbar">
                <span className="cap-list-title">
                  {draft.id ? draft.name || t("cap.recipe.untitled") : t("cap.recipe.new")}
                </span>
                <span className="cap-toolbar-spacer" />
                <Switch
                  checked={draft.enabled}
                  label={t("cap.enabled")}
                  onChange={(checked) => setDraft((current) => (current ? { ...current, enabled: checked } : current))}
                />
                <button
                  type="button"
                  className="btn sm primary"
                  disabled={busy || !draft.name.trim() || draft.steps.length === 0}
                  onClick={() => void save()}
                >
                  {t("cap.save")}
                </button>
                {draft.id ? (
                  <>
                    <button
                      type="button"
                      className="btn sm"
                      disabled={busy || !draft.enabled}
                      onClick={requestRun}
                    >
                      <Play size={12} /> {busy ? t("cap.recipe.running") : t("cap.recipe.run")}
                    </button>
                    <button type="button" className="btn sm" disabled={busy} onClick={() => void duplicate()}>
                      <Copy size={12} /> {t("cap.duplicate")}
                    </button>
                    <button type="button" className="btn sm" disabled={busy} onClick={() => void exportRecipe()}>
                      <Download size={12} /> {t("cap.export")}
                    </button>
                    <button type="button" className="btn sm" onClick={() => setDeleteOpen(true)}>
                      <Trash2 size={12} /> {t("cap.delete")}
                    </button>
                  </>
                ) : null}
              </div>

              <div className="cap-card">
                <div className="cap-form">
                  <label>
                    {t("cap.name")}
                    <input
                      className="ws-input"
                      value={draft.name}
                      maxLength={80}
                      onChange={(event) =>
                        setDraft((current) =>
                          current ? { ...current, name: event.target.value } : current,
                        )
                      }
                    />
                  </label>
                  <label>
                    {t("cap.description")}
                    <textarea
                      className="ws-input"
                      rows={2}
                      maxLength={1000}
                      value={draft.description}
                      onChange={(event) =>
                        setDraft((current) =>
                          current ? { ...current, description: event.target.value } : current,
                        )
                      }
                    />
                  </label>
                </div>
              </div>

              <div className="cap-card">
                <div className="cap-card-title">
                  <span>{t("cap.recipe.steps")}</span>
                  <span className="cap-muted">{draft.steps.length}/20</span>
                </div>
                {draft.steps.map((step, index) => (
                  <div key={index} className="cap-step">
                    <div className="cap-step-head">
                      <strong>
                        {index + 1}. {stepLabel(step.type, t)}
                      </strong>
                      <span className="cap-toolbar-spacer" />
                      <button
                        type="button"
                        className="icon-btn sm"
                        aria-label={t("cap.delete")}
                        onClick={() =>
                          setDraft((current) =>
                            current
                              ? {
                                  ...current,
                                  steps: current.steps.filter((_, i) => i !== index),
                                }
                              : current,
                          )
                        }
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                    {step.type === "knowledge_search" ? (
                      <div className="cap-form">
                        <label>
                          {t("cap.recipe.query")}
                          <input
                            className="ws-input"
                            value={step.query}
                            onChange={(event) => updateStep(index, { query: event.target.value })}
                          />
                        </label>
                        <label>
                          {t("cap.recipe.kb")}
                          <Select
                            value={step.kbIds[0] ?? ""}
                            options={kbs.map((kb) => ({ value: kb.id, label: kb.name }))}
                            onChange={(value) => updateStep(index, { kbIds: [value] })}
                            ariaLabel={t("cap.recipe.kb")}
                            block
                          />
                        </label>
                        <label>
                          {t("cap.recipe.limit")}
                          <input
                            className="ws-input"
                            type="number"
                            min={1}
                            max={20}
                            value={step.limit}
                            onChange={(event) =>
                              updateStep(index, { limit: Number(event.target.value) || 1 })
                            }
                          />
                        </label>
                      </div>
                    ) : null}
                    {step.type === "mcp_tool" ? (
                      <div className="cap-form">
                        <label>
                          {t("cap.recipe.tool")}
                          <Select
                            value={`${step.serverId}:${step.toolName}`}
                            options={allTools.map((item) => ({
                              value: `${item.serverId}:${item.tool.name}`,
                              label: `${item.serverName} / ${item.tool.name}`,
                            }))}
                            onChange={(value) => {
                              const [serverId, toolName] = value.split(":");
                              const tool = allTools.find(
                                (item) =>
                                  item.serverId === serverId && item.tool.name === toolName,
                              );
                              updateStep(index, {
                                serverId,
                                toolName,
                                highRisk: tool?.tool.highRisk ?? false,
                              });
                            }}
                            ariaLabel={t("cap.recipe.tool")}
                            block
                          />
                        </label>
                        <label>
                          {t("cap.recipe.argsJson")}
                          <textarea
                            className="ws-input cap-json"
                            rows={4}
                            value={
                              argsDrafts[index] ?? JSON.stringify(step.args, null, 2)
                            }
                            onChange={(event) =>
                              setArgsDrafts((current) => ({
                                ...current,
                                [index]: event.target.value,
                              }))
                            }
                            onBlur={() => {
                              const text = argsDrafts[index];
                              if (text === undefined) return;
                              try {
                                const parsed = JSON.parse(text || "{}");
                                updateStep(index, { args: parsed });
                                setArgsDrafts((current) => {
                                  const next = { ...current };
                                  delete next[index];
                                  return next;
                                });
                              } catch {
                                setError(t("cap.recipe.argsInvalid"));
                              }
                            }}
                          />
                          <span className="cap-muted">{t("cap.recipe.argsSecretHint")}</span>
                        </label>
                        {step.highRisk ? (
                          <div className="cap-warning">
                            <AlertTriangle size={12} aria-hidden="true" />
                            <span>{t("cap.recipe.highRiskHint")}</span>
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                    {step.type === "save_note" ? (
                      <label className="cap-form">
                        {t("cap.recipe.noteTitle")}
                        <input
                          className="ws-input"
                          value={step.title}
                          maxLength={200}
                          onChange={(event) => updateStep(index, { title: event.target.value })}
                        />
                      </label>
                    ) : null}
                  </div>
                ))}
                <div className="cap-inline">
                  <button type="button" className="btn sm" onClick={() => addStep("knowledge_search")}>
                    <Plus size={12} /> {t("cap.recipe.step.knowledge")}
                  </button>
                  <button type="button" className="btn sm" onClick={() => addStep("mcp_tool")}>
                    <Plus size={12} /> {t("cap.recipe.step.mcp")}
                  </button>
                  <button type="button" className="btn sm" onClick={() => addStep("save_note")}>
                    <Plus size={12} /> {t("cap.recipe.step.note")}
                  </button>
                </div>
              </div>

              {runs ? (
                <div className="cap-card">
                  <div className="cap-card-title">{t("cap.recipe.runs")}</div>
                  {runs.items.length === 0 ? (
                    <p className="cap-muted">{t("cap.recipe.noRuns")}</p>
                  ) : (
                    <div className="cap-sources">
                      {runs.items.map((item) => (
                        <button
                          key={item.id}
                          type="button"
                          className="cap-hit"
                          onClick={() => void openRun(item.id)}
                        >
                          <span className="cap-list-title">
                            {item.startedAt} ·{" "}
                            {t(`cap.recipe.status.${item.status}` as "cap.recipe.status.succeeded")}
                          </span>
                          {item.error ? <span className="cap-danger">{item.error}</span> : null}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ) : null}

              {runDetail ? (
                <div className="cap-card">
                  <div className="cap-card-title">
                    <span>{t("cap.recipe.runDetail")}</span>
                    <span className="cap-muted">
                      {t(`cap.recipe.status.${runDetail.status}` as "cap.recipe.status.succeeded")}
                    </span>
                  </div>
                  {runDetail.steps.map((step) => (
                    <div key={step.index} className="cap-step">
                      <div className="cap-step-head">
                        <strong>
                          {step.index + 1}. {step.stepType}
                        </strong>
                        <span className="cap-muted">
                          {step.status} · {step.durationMs} ms
                        </span>
                      </div>
                      {step.detail ? <span className="cap-danger">{step.detail}</span> : null}
                      <pre className="cap-content">
                        {JSON.stringify(step.output, null, 2)}
                      </pre>
                    </div>
                  ))}
                  {runDetail.error ? (
                    <p className="cap-danger cap-muted">{runDetail.error}</p>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : (
            <EmptyState title={t("cap.recipe.select")} hint={t("cap.recipe.selectHint")} />
          )}
        </div>
      </div>

      <ConfirmDialog
        open={deleteOpen}
        title={t("cap.recipe.deleteTitle", { name: draft?.name ?? "" })}
        detail={t("cap.recipe.deleteDetail")}
        danger
        busy={busy}
        confirmLabel={t("cap.delete")}
        cancelLabel={t("common.cancel")}
        onConfirm={() => void remove()}
        onCancel={() => setDeleteOpen(false)}
      />

      <ConfirmDialog
        open={runConfirmOpen}
        title={t("cap.recipe.confirmTitle")}
        detail={t("cap.recipe.confirmDetail")}
        danger
        busy={busy}
        confirmLabel={t("cap.recipe.runAnyway")}
        cancelLabel={t("common.cancel")}
        onConfirm={() => void run(true)}
        onCancel={() => setRunConfirmOpen(false)}
      />

      <Dialog
        open={exportText !== null}
        onClose={() => setExportText(null)}
        title={t("cap.recipe.exportTitle")}
        size="md"
        footer={
          <button type="button" className="btn" onClick={() => setExportText(null)}>
            {t("common.close")}
          </button>
        }
      >
        <div className="cap-form">
          <Switch
            checked={includeSecretArgs}
            onChange={(checked) => {
              setIncludeSecretArgs(checked);
              void exportRecipe(checked);
            }}
            label={t("cap.recipe.includeSecrets")}
          />
          <p className="cap-muted">{t("cap.recipe.includeSecretsHint")}</p>
          <textarea className="ws-input cap-json" rows={14} readOnly value={exportText ?? ""} />
        </div>
      </Dialog>

      <Dialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        title={t("cap.recipe.importTitle")}
        size="md"
        footer={
          <>
            <button type="button" className="btn" onClick={() => setImportOpen(false)}>
              {t("common.cancel")}
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={busy || !importText.trim()}
              onClick={() => void importRecipe()}
            >
              {t("cap.import")}
            </button>
          </>
        }
      >
        <textarea
          className="ws-input cap-json"
          rows={14}
          value={importText}
          onChange={(event) => setImportText(event.target.value)}
          placeholder={t("cap.recipe.importPlaceholder")}
        />
      </Dialog>
    </div>
  );
}
