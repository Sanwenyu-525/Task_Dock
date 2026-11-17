import { useCallback, useEffect, useState } from "react";
import { Plus } from "lucide-react";

import { useLocale } from "../../hooks/useLocale";
import { errorMessage } from "../../lib/errors";
import {
  workspaceProjectList,
  workspaceProjectSave,
} from "../../lib/bridge";
import { openWorkbench } from "../../lib/workbenchNav";
import type { WorkspaceProject } from "../../lib/bridge";
import { resolveWorkspaceProfile } from "../../workspace/workspaceProfiles";

export default function WorkspaceProjectsPanel() {
  const { t } = useLocale();
  const [projects, setProjects] = useState<WorkspaceProject[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");

  const refresh = useCallback(async () => {
    try {
      const r = await workspaceProjectList();
      setProjects(r.projects);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const create = useCallback(async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const r = await workspaceProjectSave({ id: null, name: name.trim(), kind: "general", rootPath: null, devProjectId: null, note: null });
      setName("");
      await refresh();
      const outcome = await openWorkbench({ tab: "workspace", projectId: r.project.id });
      if (outcome.status !== "succeeded" && outcome.status !== "pending") {
        setError(outcome.error ?? "打开工作台失败");
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }, [name, refresh]);

  const openWindow = useCallback(async (id?: string) => {
    try {
      const outcome = await openWorkbench({ tab: "workspace", projectId: id ?? null });
      if (outcome.status !== "succeeded" && outcome.status !== "pending") {
        setError(outcome.error ?? "打开工作台失败");
      }
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  return (
    <div className="workspace-projects-panel ui-content-pad">
      <h2 className="wsp-title">{t("nav.workspace")}</h2>
      <p className="wsp-desc">
        项目工作空间是跨工具的长期工作容器；完整编辑在统一工作台中进行。
      </p>
      <div className="wsp-toolbar">
        <input
          className="ws-input"
          placeholder="新建项目名称"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button className="btn sm" disabled={busy} onClick={create}>
          <Plus size={12} /> 新建并打开
        </button>
        <button className="btn sm" onClick={() => openWindow()}>
          打开工作台
        </button>
      </div>
      {error && <div className="wsp-error">{error}</div>}
      <ul className="wsp-list">
        {projects.map((p) => (
          <li key={p.id} className="wsp-item">
            <div className="wsp-item-main">
              <strong className="wsp-item-name">{p.name}</strong>
              <span className="wsp-item-kind">{resolveWorkspaceProfile(p.kind).label}</span>
              <div className="wsp-item-meta">事项 {p.itemCount} · 关联 {p.taskLinkCount}</div>
            </div>
            <button className="btn sm" onClick={() => openWindow(p.id)}>打开</button>
          </li>
        ))}
        {projects.length === 0 && <li className="wsp-empty">暂无项目</li>}
      </ul>
    </div>
  );
}
