//! 从剪贴板详情把条目/分组关联到项目根（显式操作，不自动绑定）。
//!
//! 语义（数据作用域 Phase 2）：关联只是「项目引用了这份内容」，不复制正文、
//! 不改变归属、不构成 Agent 读取或导出授权；取消关联绝不删除剪贴板内容。

import { useEffect, useState } from "react";
import { FolderKanban, X } from "lucide-react";
import {
  clipboardLinkProject,
  clipboardProjectLinks,
  clipboardUnlinkProject,
  workspaceProjectList,
  type ClipboardProjectLink,
  type WorkspaceProject,
} from "../../lib/bridge";
import { useUiStore } from "../../store/useUiStore";
import { Combobox } from "../ui";

export default function ProjectLinkBar({
  targetType,
  targetId,
}: {
  targetType: "item" | "group";
  targetId: string;
}) {
  const showToast = useUiStore((s) => s.showToast);
  const [projects, setProjects] = useState<WorkspaceProject[]>([]);
  const [links, setLinks] = useState<ClipboardProjectLink[]>([]);
  const [projectId, setProjectId] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    Promise.all([workspaceProjectList(), clipboardProjectLinks(targetType, targetId)])
      .then(([list, current]) => {
        if (!alive) return;
        setProjects(list.projects);
        setLinks(current);
      })
      .catch(() => {
        if (!alive) return;
        setProjects([]);
        setLinks([]);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [targetType, targetId]);

  async function refreshLinks() {
    setLinks(await clipboardProjectLinks(targetType, targetId));
  }

  async function onLink() {
    if (!projectId) return;
    setBusy(true);
    try {
      await clipboardLinkProject(projectId, targetType, targetId);
      const name = projects.find((p) => p.id === projectId)?.name ?? "";
      showToast(`已关联到项目${name ? `「${name}」` : ""}`, { kind: "success" });
      setProjectId("");
      await refreshLinks();
    } catch (e) {
      showToast(`关联项目失败：${String(e)}`, { kind: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function onUnlink(target: string) {
    setBusy(true);
    try {
      await clipboardUnlinkProject(target, targetType, targetId);
      showToast("已取消项目关联，剪贴板内容仍保留", { kind: "success" });
      await refreshLinks();
    } catch (e) {
      showToast(`取消关联失败：${String(e)}`, { kind: "error" });
    } finally {
      setBusy(false);
    }
  }

  const linked = links.map((link) => ({
    ...link,
    name: projects.find((p) => p.id === link.projectId)?.name ?? link.projectId,
  }));
  const candidates = projects.filter((p) => !links.some((link) => link.projectId === p.id));

  return (
    <div className="clip-tasklink clip-projectlink">
      <span className="clip-tasklink-label">
        <FolderKanban size={11} /> 关联项目
      </span>
      {loading ? (
        <span className="clip-hint">正在读取项目…</span>
      ) : (
        <>
          {linked.length > 0 && (
            <span className="clip-projectlink-chips">
              {linked.map((link) => (
                <span key={link.projectId} className="clip-projectlink-chip">
                  <span className="clip-projectlink-chip-name">{link.name}</span>
                  <button
                    type="button"
                    className="icon-btn sm"
                    aria-label={`取消关联项目「${link.name}」`}
                    data-tip="取消关联；不删除剪贴板内容"
                    disabled={busy}
                    onClick={() => void onUnlink(link.projectId)}
                  >
                    <X size={10} aria-hidden="true" />
                  </button>
                </span>
              ))}
            </span>
          )}
          {candidates.length === 0 ? (
            <span className="clip-hint">
              {projects.length === 0
                ? "还没有项目；先在规划页创建项目根后再关联。"
                : "已关联全部可用项目。"}
            </span>
          ) : (
            <>
              <Combobox
                ariaLabel="选择要关联的项目"
                value={projectId}
                options={candidates.slice(0, 100).map((p) => ({ value: p.id, label: p.name }))}
                onChange={(v) => setProjectId(v)}
                searchPlaceholder="搜索项目…"
                emptyText="没有匹配的项目"
                placeholder="选择项目…"
              />
              <button className="btn sm" onClick={() => void onLink()} disabled={!projectId || busy}>
                关联
              </button>
            </>
          )}
        </>
      )}
    </div>
  );
}
