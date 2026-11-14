import { useCallback, useEffect, useState } from "react";
import { Plus } from "lucide-react";

import { useLocale } from "../../hooks/useLocale";
import { errorMessage } from "../../lib/errors";
import {
  workspaceProjectList,
  workspaceProjectSave,
  workspaceSetActiveProject,
  openProjectWorkspaceWindow,
} from "../../lib/bridge";
import type { WorkspaceProject } from "../../lib/bridge";

const KIND_LABEL: Record<string, string> = {
  development: "开发",
  game: "游戏",
  ai_comic: "AI 漫剧",
  general: "通用",
};

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
      await workspaceSetActiveProject(r.project.id);
      setName("");
      await refresh();
      await openProjectWorkspaceWindow({ projectId: r.project.id });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }, [name, refresh]);

  const openWindow = useCallback(async (id?: string) => {
    try {
      await openProjectWorkspaceWindow({ projectId: id ?? null });
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  return (
    <div className="workspace-projects-panel" style={{ padding: 16 }}>
      <h2 style={{ margin: "0 0 8px", fontSize: 16 }}>{t("nav.workspace")}</h2>
      <p style={{ margin: "0 0 12px", fontSize: 13, color: "var(--text-secondary)" }}>
        项目工作空间是跨工具的长期工作容器；完整编辑在独立专业窗口中进行。
      </p>
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <input
          style={{ flex: 1, padding: "6px 8px", border: "1px solid var(--border, #ddd)", borderRadius: 8 }}
          placeholder="新建项目名称"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button className="btn sm" disabled={busy} onClick={create}>
          <Plus size={12} /> 新建并打开
        </button>
        <button className="btn sm" onClick={() => openWindow()}>
          打开工作空间窗口
        </button>
      </div>
      {error && <div style={{ color: "var(--status-error, #dc2626)", fontSize: 12, marginBottom: 8 }}>{error}</div>}
      <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 8 }}>
        {projects.map((p) => (
          <li key={p.id} style={{ border: "1px solid var(--border, #ddd)", borderRadius: 8, padding: 10, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <strong>{p.name}</strong>
              <span style={{ marginLeft: 8, fontSize: 11, opacity: 0.7 }}>{KIND_LABEL[p.kind] ?? p.kind}</span>
              <div style={{ fontSize: 11, opacity: 0.7 }}>事项 {p.itemCount} · 关联 {p.taskLinkCount}</div>
            </div>
            <button className="btn sm" onClick={() => openWindow(p.id)}>打开</button>
          </li>
        ))}
        {projects.length === 0 && <li style={{ opacity: 0.6, fontSize: 13 }}>暂无项目</li>}
      </ul>
    </div>
  );
}
