//! Skill 子页：发现/导入、详情与目录、启停、作用域、风险提示与 SKILL.md 编辑。
//!
//! 边界：只读扫描与静态风险标记；TaskDock 永不执行 Skill 内脚本。
//! 发现型 Skill 不允许在应用内删除（从原目录移除后重新扫描）。

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, FolderInput, RefreshCw, ShieldAlert, Trash2 } from "lucide-react";
import {
  agentMcpList,
  capabilitySkillDelete,
  capabilitySkillGet,
  capabilitySkillImport,
  capabilitySkillList,
  capabilitySkillSaveContent,
  capabilitySkillScan,
  capabilitySkillSetEnabled,
  capabilitySkillSetScope,
  workspaceProjectList,
  type McpAgentInfo,
  type SkillDetail,
  type SkillSummary,
} from "../../lib/bridge";
import { errorMessage } from "../../lib/errors";
import { useLocale } from "../../hooks/useLocale";
import { ConfirmDialog, EmptyState, SearchField, Select, StatusBadge, Switch } from "../ui";
import { pickFolder } from "../../lib/filesWorkspace/folderPicker";

function riskTone(risk: SkillSummary["riskLevel"]): "success" | "warning" | "danger" {
  return risk === "high" ? "danger" : risk === "medium" ? "warning" : "success";
}

export default function SkillsSection() {
  const { t } = useLocale();
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState("");
  const [risk, setRisk] = useState("");
  const [projects, setProjects] = useState<{ id: string; name: string; rootPath: string }[]>([]);
  const [agents, setAgents] = useState<McpAgentInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await capabilitySkillList({
        query: query.trim() || undefined,
        scope: scope || undefined,
        risk: risk || undefined,
      });
      setSkills(list);
      setSelectedId((previous) =>
        previous && list.some((item) => item.id === previous) ? previous : list[0]?.id ?? null,
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [query, scope, risk]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void workspaceProjectList()
      .then((response) =>
        setProjects(
          response.projects.map((p) => ({ id: p.id, name: p.name, rootPath: p.rootPath })),
        ),
      )
      .catch(() => {
        // 项目列表只用于作用域选择；失败不影响 Skill 浏览。
      });
    void agentMcpList()
      .then((list) => setAgents(list.filter((agent) => !agent.revoked_at)))
      .catch(() => {
        // Agent 列表只用于 agent 作用域；失败不影响 Skill 浏览。
      });
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    let alive = true;
    void capabilitySkillGet(selectedId)
      .then((next) => {
        if (!alive) return;
        setDetail(next);
        setEditing(false);
        setDraft(next.content);
      })
      .catch((e) => {
        if (alive) setError(errorMessage(e));
      });
    return () => {
      alive = false;
    };
  }, [selectedId]);

  const selected = useMemo(
    () => skills.find((item) => item.id === selectedId) ?? null,
    [skills, selectedId],
  );

  async function scan() {
    setBusy(true);
    setError(null);
    try {
      // 项目级 Skill 目录（Agent Skills 开放规范的常见位置）；不存在会被后端忽略。
      const extraRoots = projects
        .filter((project) => project.rootPath)
        .slice(0, 4)
        .flatMap((project) => [
          `${project.rootPath}\\.agents\\skills`,
          `${project.rootPath}\\.claude\\skills`,
        ]);
      const report = await capabilitySkillScan(extraRoots);
      setNotice(
        t("cap.skill.scanReport", {
          discovered: report.discovered,
          updated: report.updated,
          missing: report.missing,
        }),
      );
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function importSkill() {
    const picked = await pickFolder({ title: t("cap.skill.pickFolder") });
    if (picked.status !== "ok") {
      if (picked.status === "invalid") {
        setError(t("cap.skill.pickFailed", { error: picked.message ?? picked.reason }));
      }
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const imported = await capabilitySkillImport(picked.path);
      setNotice(t("cap.skill.imported", { name: imported.name }));
      await load();
      setSelectedId(imported.id);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function toggleEnabled(item: SkillSummary, enabled: boolean) {
    setBusy(true);
    try {
      const updated = await capabilitySkillSetEnabled(item.id, enabled);
      setSkills((current) => current.map((row) => (row.id === updated.id ? updated : row)));
      if (detail?.id === updated.id) setDetail({ ...detail, ...updated });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function changeScope(
    nextScope: SkillSummary["scope"],
    target?: string | null,
  ) {
    if (!selected) return;
    const projectId =
      nextScope === "project" ? target ?? projects[0]?.id ?? null : null;
    const workspaceId =
      nextScope === "workspace" ? target ?? projects[0]?.id ?? null : null;
    const agentId = nextScope === "agent" ? target ?? agents[0]?.id ?? null : null;
    if (nextScope === "project" && !projectId) {
      setError(t("cap.skill.projectRequired"));
      return;
    }
    if (nextScope === "workspace" && !workspaceId) {
      setError(t("cap.skill.workspaceRequired"));
      return;
    }
    if (nextScope === "agent" && !agentId) {
      setError(t("cap.skill.agentRequired"));
      return;
    }
    setBusy(true);
    try {
      const updated = await capabilitySkillSetScope(
        selected.id,
        nextScope,
        projectId,
        workspaceId,
        agentId,
      );
      setSkills((current) => current.map((row) => (row.id === updated.id ? updated : row)));
      if (detail?.id === updated.id) setDetail({ ...detail, ...updated });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  function scopeTargetLabel(skill: SkillSummary): string | null {
    if (skill.scope === "project" || skill.scope === "workspace") {
      const id = skill.scope === "project" ? skill.projectId : skill.workspaceId;
      if (!id) return null;
      return projects.find((project) => project.id === id)?.name ?? id;
    }
    if (skill.scope === "agent") {
      if (!skill.agentId) return null;
      const agent = agents.find((item) => item.id === skill.agentId);
      return agent?.display_name || agent?.agent_id || skill.agentId;
    }
    return null;
  }

  async function saveContent() {
    if (!detail) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await capabilitySkillSaveContent(detail.id, draft);
      setNotice(t("cap.skill.saved"));
      setSkills((current) => current.map((row) => (row.id === updated.id ? updated : row)));
      const next = await capabilitySkillGet(detail.id);
      setDetail(next);
      setDraft(next.content);
      setEditing(false);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!selected) return;
    setBusy(true);
    try {
      await capabilitySkillDelete(selected.id);
      setDeleteOpen(false);
      setNotice(t("cap.skill.deleted"));
      setSelectedId(null);
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="cap-section">
      <div className="cap-toolbar">
        <SearchField
          value={query}
          onChange={setQuery}
          ariaLabel={t("cap.skill.search")}
          placeholder={t("cap.skill.search")}
          size="compact"
        />
        <Select
          value={scope}
          options={[
            { value: "", label: t("common.all") },
            { value: "global", label: t("cap.skill.scope.global") },
            { value: "project", label: t("cap.skill.scope.project") },
            { value: "workspace", label: t("cap.skill.scope.workspace") },
            { value: "agent", label: t("cap.skill.scope.agent") },
          ]}
          onChange={setScope}
          ariaLabel={t("cap.skill.scopeTitle")}
          size="sm"
        />
        <Select
          value={risk}
          options={[
            { value: "", label: t("common.all") },
            { value: "low", label: t("cap.skill.risk.low") },
            { value: "medium", label: t("cap.skill.risk.medium") },
            { value: "high", label: t("cap.skill.risk.high") },
          ]}
          onChange={setRisk}
          ariaLabel={t("cap.skill.riskTitle")}
          size="sm"
        />
        <span className="cap-toolbar-spacer" />
        <button type="button" className="btn sm" disabled={busy} onClick={() => void scan()}>
          <RefreshCw size={13} /> {t("cap.skill.scan")}
        </button>
        <button type="button" className="btn sm" disabled={busy} onClick={() => void importSkill()}>
          <FolderInput size={13} /> {t("cap.skill.import")}
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
            <span>{t("cap.skill.listTitle")}</span>
            <span className="cap-muted">{skills.length}</span>
          </div>
          <div className="cap-list">
            {skills.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`cap-list-item${item.id === selectedId ? " active" : ""}`}
                onClick={() => setSelectedId(item.id)}
              >
                <span className="cap-list-title">
                  <StatusBadge tone={riskTone(item.riskLevel)} size="sm">
                    {t(`cap.skill.risk.${item.riskLevel}` as "cap.skill.risk.low")}
                  </StatusBadge>
                  <span className="cap-ellipsis">{item.name}</span>
                </span>
                <span className="cap-list-meta">
                  {t(`cap.skill.scope.${item.scope}` as "cap.skill.scope.global")}
                  {scopeTargetLabel(item) ? ` · ${scopeTargetLabel(item)}` : ""}
                  {item.version ? ` · v${item.version}` : ""}
                  {item.missing ? ` · ${t("cap.skill.missing")}` : ""}
                  {item.nameConflict ? ` · ${t("cap.skill.conflict")}` : ""}
                </span>
              </button>
            ))}
          </div>
          {!loading && skills.length === 0 ? (
            <EmptyState
              title={t("cap.skill.empty")}
              hint={t("cap.skill.emptyHint")}
              icon={<FolderInput size={18} />}
            />
          ) : null}
        </div>

        <div className="cap-col">
          {detail ? (
            <div className="cap-detail">
              <div className="cap-toolbar">
                <strong className="cap-list-title">{detail.name}</strong>
                <StatusBadge tone={riskTone(detail.riskLevel)} size="sm">
                  {t(`cap.skill.risk.${detail.riskLevel}` as "cap.skill.risk.low")}
                </StatusBadge>
                {detail.missing ? (
                  <StatusBadge tone="danger" size="sm">
                    {t("cap.skill.missing")}
                  </StatusBadge>
                ) : null}
                {detail.nameConflict ? (
                  <StatusBadge tone="warning" size="sm">
                    {t("cap.skill.conflict")}
                  </StatusBadge>
                ) : null}
                <span className="cap-toolbar-spacer" />
                <Switch
                  checked={detail.enabled}
                  onChange={(checked) => void toggleEnabled(detail, checked)}
                  label={t("cap.enabled")}
                  disabled={busy}
                />
              </div>
              <p className="cap-muted">{detail.description || t("cap.skill.noDescription")}</p>
              <div className="cap-card">
                <dl className="cap-kv">
                  <dt>{t("cap.skill.sourcePath")}</dt>
                  <dd data-tip={detail.sourcePath}>{detail.sourcePath}</dd>
                  <dt>{t("cap.skill.version")}</dt>
                  <dd>{detail.version || "—"}</dd>
                  <dt>{t("cap.skill.format")}</dt>
                  <dd>{detail.formatOk ? t("cap.skill.formatOk") : t("cap.skill.formatBad")}</dd>
                  <dt>{t("cap.skill.scopeTitle")}</dt>
                  <dd>
                    <div className="cap-inline">
                      <Select
                        value={detail.scope}
                        options={[
                          { value: "global", label: t("cap.skill.scope.global") },
                          { value: "project", label: t("cap.skill.scope.project") },
                          { value: "workspace", label: t("cap.skill.scope.workspace") },
                          { value: "agent", label: t("cap.skill.scope.agent") },
                        ]}
                        onChange={(value) =>
                          void changeScope(value as SkillSummary["scope"], null)
                        }
                        ariaLabel={t("cap.skill.scopeTitle")}
                        size="sm"
                      />
                      {detail.scope === "project" ? (
                        <Select
                          value={detail.projectId ?? ""}
                          options={projects.map((project) => ({
                            value: project.id,
                            label: project.name,
                          }))}
                          onChange={(value) => void changeScope("project", value || null)}
                          ariaLabel={t("cap.project")}
                          size="sm"
                        />
                      ) : null}
                      {detail.scope === "workspace" ? (
                        <Select
                          value={detail.workspaceId ?? ""}
                          options={projects.map((project) => ({
                            value: project.id,
                            label: project.name,
                          }))}
                          onChange={(value) => void changeScope("workspace", value || null)}
                          ariaLabel={t("cap.kb.workspaceLabel")}
                          size="sm"
                        />
                      ) : null}
                      {detail.scope === "agent" ? (
                        <Select
                          value={detail.agentId ?? ""}
                          options={agents.map((agent) => ({
                            value: agent.id,
                            label: agent.display_name || agent.agent_id,
                          }))}
                          onChange={(value) => void changeScope("agent", value || null)}
                          ariaLabel={t("cap.skill.agentLabel")}
                          size="sm"
                        />
                      ) : null}
                    </div>
                  </dd>
                </dl>
              </div>

              {detail.riskNotes.length > 0 ? (
                <div className="cap-card">
                  <div className="cap-card-title">
                    <ShieldAlert size={13} /> {t("cap.skill.riskNotes")}
                  </div>
                  {detail.riskNotes.map((note, index) => (
                    <div key={`${note.kind}-${index}`} className="cap-warning">
                      <AlertTriangle size={12} aria-hidden="true" />
                      <span>
                        <strong>{note.kind}</strong> · {note.detail}（{note.file}）
                      </span>
                    </div>
                  ))}
                  <p className="cap-muted">{t("cap.skill.noExecution")}</p>
                </div>
              ) : null}

              <div className="cap-card">
                <div className="cap-card-title">
                  <span>{t("cap.skill.files")}</span>
                  <span className="cap-muted">{detail.files.length}</span>
                </div>
                <div className="cap-sources">
                  {detail.files.slice(0, 60).map((file) => (
                    <span key={file.path}>
                      {file.path} · {file.sizeBytes} B
                    </span>
                  ))}
                </div>
              </div>

              <div className="cap-card">
                <div className="cap-card-title">
                  <span>SKILL.md</span>
                  <span className="cap-toolbar-spacer" />
                  {editing ? (
                    <>
                      <button
                        type="button"
                        className="btn sm"
                        onClick={() => {
                          setEditing(false);
                          setDraft(detail.content);
                        }}
                      >
                        {t("common.cancel")}
                      </button>
                      <button
                        type="button"
                        className="btn sm primary"
                        disabled={busy}
                        onClick={() => void saveContent()}
                      >
                        {t("cap.save")}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="btn sm"
                      disabled={detail.missing}
                      onClick={() => setEditing(true)}
                    >
                      {t("cap.edit")}
                    </button>
                  )}
                </div>
                {editing ? (
                  <textarea
                    className="ws-input cap-json"
                    rows={14}
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                  />
                ) : (
                  <pre className="cap-content">{detail.content || t("cap.skill.noContent")}</pre>
                )}
              </div>

              <div className="cap-inline">
                <button
                  type="button"
                  className="btn sm"
                  disabled={detail.sourceKind !== "imported"}
                  onClick={() => setDeleteOpen(true)}
                >
                  <Trash2 size={12} /> {t("cap.delete")}
                </button>
                {detail.sourceKind !== "imported" ? (
                  <span className="cap-muted">{t("cap.skill.discoveredDeleteHint")}</span>
                ) : null}
              </div>
            </div>
          ) : (
            <EmptyState title={t("cap.skill.select")} hint={t("cap.skill.selectHint")} />
          )}
        </div>
      </div>

      <ConfirmDialog
        open={deleteOpen}
        title={t("cap.skill.deleteTitle", { name: selected?.name ?? "" })}
        detail={t("cap.skill.deleteDetail")}
        danger
        busy={busy}
        confirmLabel={t("cap.delete")}
        cancelLabel={t("common.cancel")}
        onConfirm={() => void remove()}
        onCancel={() => setDeleteOpen(false)}
      />
    </div>
  );
}
