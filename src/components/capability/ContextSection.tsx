//! 项目上下文子页：绑定知识库 / Skill / MCP 工具 / 任务，并预览装配结果与来源。
//!
//! 装配只使用用户显式绑定的资源；有总字符上限和逐项截断，不把整库塞给 Agent。

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Copy, FileSearch, Plus, Trash2 } from "lucide-react";
import {
  capabilityContextAssemble,
  capabilityContextDelete,
  capabilityContextDuplicate,
  capabilityContextGet,
  capabilityContextList,
  capabilityContextSave,
  capabilityKbList,
  capabilityMcpServersList,
  capabilitySkillList,
  workspaceProjectList,
  type CapabilityContextBundle,
  type CapabilityContextConfig,
  type CapabilityContextProfile,
  type ExternalMcpServer,
  type KnowledgeBase,
  type SkillSummary,
} from "../../lib/bridge";
import { errorMessage } from "../../lib/errors";
import { useLocale } from "../../hooks/useLocale";
import { Checkbox, ConfirmDialog, EmptyState, Select } from "../ui";

interface Draft {
  id?: string;
  name: string;
  description: string;
  projectId: string;
  config: CapabilityContextConfig;
}

const EMPTY_CONFIG: CapabilityContextConfig = {
  kbIds: [],
  skillIds: [],
  mcpTools: [],
  taskIds: [],
  rules: "",
};

function toggle<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

export default function ContextSection() {
  const { t } = useLocale();
  const [profiles, setProfiles] = useState<CapabilityContextProfile[]>([]);
  const [kbs, setKbs] = useState<KnowledgeBase[]>([]);
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [servers, setServers] = useState<ExternalMcpServer[]>([]);
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [taskText, setTaskText] = useState("");
  const [query, setQuery] = useState("");
  const [budget, setBudget] = useState("4000");
  const [bundle, setBundle] = useState<CapabilityContextBundle | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [nextProfiles, nextKbs, nextSkills, nextServers, projectResponse] =
        await Promise.all([
          capabilityContextList(),
          capabilityKbList(),
          capabilitySkillList(),
          capabilityMcpServersList(),
          workspaceProjectList().catch(() => ({ projects: [] })),
        ]);
      setProfiles(nextProfiles);
      setKbs(nextKbs);
      setSkills(nextSkills.filter((item) => item.enabled && !item.missing));
      setServers(nextServers.filter((item) => item.enabled));
      setProjects(projectResponse.projects.map((p) => ({ id: p.id, name: p.name })));
      setSelectedId((previous) =>
        previous && nextProfiles.some((item) => item.id === previous)
          ? previous
          : nextProfiles[0]?.id ?? null,
      );
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const applyProfile = useCallback((profile: CapabilityContextProfile) => {
    setDraft({
      id: profile.id,
      name: profile.name,
      description: profile.description,
      projectId: profile.projectId ?? "",
      config: profile.config,
    });
    setTaskText(profile.config.taskIds.join("\n"));
    setDirty(false);
    setBundle(null);
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setDraft(null);
      return;
    }
    let alive = true;
    void capabilityContextGet(selectedId)
      .then((profile) => {
        if (alive) applyProfile(profile);
      })
      .catch((e) => {
        if (alive) setError(errorMessage(e));
      });
    return () => {
      alive = false;
    };
  }, [selectedId, applyProfile]);

  const allTools = useMemo(
    () =>
      servers.flatMap((server) =>
        server.tools.map((tool) => ({
          serverId: server.id,
          serverName: server.name,
          tool,
        })),
      ),
    [servers],
  );

  function updateDraft(patch: Partial<Draft>) {
    setDraft((current) => (current ? { ...current, ...patch } : current));
    setDirty(true);
  }

  function updateConfig(patch: Partial<CapabilityContextConfig>) {
    setDraft((current) =>
      current ? { ...current, config: { ...current.config, ...patch } } : current,
    );
    setDirty(true);
  }

  function newProfile() {
    setSelectedId(null);
    setDraft({
      name: "",
      description: "",
      projectId: "",
      config: { ...EMPTY_CONFIG },
    });
    setTaskText("");
    setBundle(null);
    setDirty(true);
  }

  async function save() {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await capabilityContextSave({
        id: draft.id,
        name: draft.name,
        description: draft.description,
        projectId: draft.projectId || null,
        config: {
          ...draft.config,
          taskIds: taskText
            .split(/[\n,]/)
            .map((item) => item.trim())
            .filter(Boolean),
        },
      });
      setNotice(t("cap.ctx.saved"));
      setDirty(false);
      await load();
      setSelectedId(saved.id);
      applyProfile(saved);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function assemble() {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      const next = await capabilityContextAssemble({
        id: draft.id,
        config: {
          ...draft.config,
          taskIds: taskText
            .split(/[\n,]/)
            .map((item) => item.trim())
            .filter(Boolean),
        },
        query: query.trim() || undefined,
        maxChars: Number(budget) || undefined,
      });
      setBundle(next);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function duplicate() {
    if (!draft?.id) return;
    setBusy(true);
    try {
      const copy = await capabilityContextDuplicate(draft.id);
      setNotice(t("cap.ctx.duplicated"));
      await load();
      setSelectedId(copy.id);
      applyProfile(copy);
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
      await capabilityContextDelete(draft.id);
      setDeleteOpen(false);
      setSelectedId(null);
      setDraft(null);
      setBundle(null);
      setNotice(t("cap.ctx.deleted"));
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
        <strong className="cap-card-title">{t("cap.ctx.listTitle")}</strong>
        <span className="cap-toolbar-spacer" />
        <button type="button" className="btn sm primary" onClick={newProfile}>
          <Plus size={13} /> {t("cap.ctx.new")}
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
            <span>{t("cap.ctx.profiles")}</span>
            <span className="cap-muted">{profiles.length}</span>
          </div>
          <div className="cap-list">
            {profiles.map((profile) => (
              <button
                key={profile.id}
                type="button"
                className={`cap-list-item${profile.id === draft?.id ? " active" : ""}`}
                onClick={() => setSelectedId(profile.id)}
              >
                <span className="cap-list-title cap-ellipsis">{profile.name}</span>
                <span className="cap-list-meta">
                  {t("cap.ctx.profileMeta", {
                    kb: profile.config.kbIds.length,
                    skills: profile.config.skillIds.length,
                    tools: profile.config.mcpTools.length,
                  })}
                </span>
              </button>
            ))}
          </div>
          {profiles.length === 0 ? (
            <EmptyState
              title={t("cap.ctx.empty")}
              hint={t("cap.ctx.emptyHint")}
              icon={<FileSearch size={18} />}
            />
          ) : null}
        </div>

        <div className="cap-col">
          {draft ? (
            <div className="cap-detail">
              <div className="cap-toolbar">
                <span className="cap-list-title">
                  {draft.id ? draft.name || t("cap.ctx.untitled") : t("cap.ctx.new")}
                </span>
                {dirty ? (
                  <span className="cap-muted">{t("cap.ctx.unsaved")}</span>
                ) : null}
                <span className="cap-toolbar-spacer" />
                <button
                  type="button"
                  className="btn sm primary"
                  disabled={busy || !draft.name.trim()}
                  onClick={() => void save()}
                >
                  {t("cap.save")}
                </button>
                {draft.id ? (
                  <>
                    <button type="button" className="btn sm" disabled={busy} onClick={() => void duplicate()}>
                      <Copy size={12} /> {t("cap.duplicate")}
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
                      onChange={(event) => updateDraft({ name: event.target.value })}
                    />
                  </label>
                  <label>
                    {t("cap.description")}
                    <textarea
                      className="ws-input"
                      rows={2}
                      maxLength={1000}
                      value={draft.description}
                      onChange={(event) => updateDraft({ description: event.target.value })}
                    />
                  </label>
                  <label>
                    {t("cap.project")}
                    <Select
                      value={draft.projectId}
                      options={[
                        { value: "", label: t("cap.ctx.noProject") },
                        ...projects.map((project) => ({ value: project.id, label: project.name })),
                      ]}
                      onChange={(value) => updateDraft({ projectId: value })}
                      ariaLabel={t("cap.project")}
                      block
                    />
                  </label>
                  <label>
                    {t("cap.ctx.rules")}
                    <textarea
                      className="ws-input"
                      rows={3}
                      maxLength={4000}
                      value={draft.config.rules}
                      onChange={(event) => updateConfig({ rules: event.target.value })}
                    />
                  </label>
                </div>
              </div>

              <div className="cap-card">
                <div className="cap-card-title">{t("cap.ctx.bindKb")}</div>
                <div className="cap-check-grid">
                  {kbs.map((kb) => (
                    <Checkbox
                      key={kb.id}
                      checked={draft.config.kbIds.includes(kb.id)}
                      onChange={() => updateConfig({ kbIds: toggle(draft.config.kbIds, kb.id) })}
                      label={`${kb.name}（${kb.indexedCount}）`}
                    />
                  ))}
                  {kbs.length === 0 ? <span className="cap-muted">{t("cap.ctx.noKb")}</span> : null}
                </div>
              </div>

              <div className="cap-card">
                <div className="cap-card-title">{t("cap.ctx.bindSkills")}</div>
                <div className="cap-check-grid">
                  {skills.map((skill) => (
                    <Checkbox
                      key={skill.id}
                      checked={draft.config.skillIds.includes(skill.id)}
                      onChange={() =>
                        updateConfig({ skillIds: toggle(draft.config.skillIds, skill.id) })
                      }
                      label={skill.name}
                    />
                  ))}
                  {skills.length === 0 ? (
                    <span className="cap-muted">{t("cap.ctx.noSkill")}</span>
                  ) : null}
                </div>
              </div>

              <div className="cap-card">
                <div className="cap-card-title">{t("cap.ctx.bindTools")}</div>
                <div className="cap-check-grid">
                  {allTools.map((item) => {
                    const checked = draft.config.mcpTools.some(
                      (ref) => ref.serverId === item.serverId && ref.toolName === item.tool.name,
                    );
                    return (
                      <Checkbox
                        key={`${item.serverId}:${item.tool.name}`}
                        checked={checked}
                        onChange={() => {
                          const next = checked
                            ? draft.config.mcpTools.filter(
                                (ref) =>
                                  !(ref.serverId === item.serverId && ref.toolName === item.tool.name),
                              )
                            : [
                                ...draft.config.mcpTools,
                                { serverId: item.serverId, toolName: item.tool.name },
                              ];
                          updateConfig({ mcpTools: next });
                        }}
                        label={`${item.serverName} / ${item.tool.name}`}
                      />
                    );
                  })}
                  {allTools.length === 0 ? (
                    <span className="cap-muted">{t("cap.ctx.noTools")}</span>
                  ) : null}
                </div>
              </div>

              <div className="cap-card">
                <div className="cap-card-title">{t("cap.ctx.bindTasks")}</div>
                <textarea
                  className="ws-input"
                  rows={3}
                  value={taskText}
                  placeholder={t("cap.ctx.taskIdsHint")}
                  onChange={(event) => {
                    setTaskText(event.target.value);
                    setDirty(true);
                  }}
                />
              </div>

              <div className="cap-card">
                <div className="cap-card-title">{t("cap.ctx.previewTitle")}</div>
                <div className="cap-inline">
                  <input
                    className="ws-input"
                    value={query}
                    placeholder={t("cap.ctx.queryPlaceholder")}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                  <input
                    className="ws-input"
                    type="number"
                    min={200}
                    max={40000}
                    value={budget}
                    aria-label={t("cap.ctx.budget")}
                    onChange={(event) => setBudget(event.target.value)}
                  />
                  <button type="button" className="btn sm" disabled={busy} onClick={() => void assemble()}>
                    {t("cap.ctx.assemble")}
                  </button>
                </div>
                {bundle ? (
                  <>
                    <div className="cap-inline">
                      <span className="cap-muted">
                        {t("cap.ctx.totalChars", { chars: bundle.totalChars })}
                      </span>
                      {bundle.truncated ? (
                        <span className="cap-muted">{t("cap.ctx.truncated")}</span>
                      ) : null}
                    </div>
                    {bundle.sections.map((section) => (
                      <div key={section.kind} className="cap-card">
                        <div className="cap-card-title">
                          <span>{section.title}</span>
                          <span className="cap-muted">{section.chars}</span>
                        </div>
                        {section.items.map((item) => (
                          <div key={`${section.kind}:${item.id}`} className="cap-source">
                            <span className="cap-list-title cap-ellipsis">{item.title}</span>
                            <span className="cap-muted">{item.source}</span>
                            <pre className="cap-content">{item.excerpt}</pre>
                          </div>
                        ))}
                      </div>
                    ))}
                    <div className="cap-card">
                      <div className="cap-card-title">{t("cap.ctx.sources")}</div>
                      <div className="cap-sources">
                        {bundle.sources.map((source) => (
                          <span key={`${source.kind}:${source.id}`}>
                            {source.kind} · {source.label}
                            {source.path ? ` · ${source.path}` : ""}
                          </span>
                        ))}
                      </div>
                    </div>
                    {bundle.sections.length === 0 ? (
                      <p className="cap-muted">{t("cap.ctx.noSections")}</p>
                    ) : null}
                  </>
                ) : null}
              </div>
            </div>
          ) : (
            <EmptyState title={t("cap.ctx.select")} hint={t("cap.ctx.selectHint")} />
          )}
        </div>
      </div>

      <ConfirmDialog
        open={deleteOpen}
        title={t("cap.ctx.deleteTitle", { name: draft?.name ?? "" })}
        detail={t("cap.ctx.deleteDetail")}
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
