//! 从剪贴板详情把条目/分组关联到工作现场（显式操作，不自动绑定）。

import { useEffect, useState } from "react";
import { Layers } from "lucide-react";
import { clipboardLinkSnapshot, workspaceList, type SnapshotSummary } from "../../lib/bridge";
import { useUiStore } from "../../store/useUiStore";
import { Combobox } from "../ui";

export default function WorkspaceLinkBar({
  targetType,
  targetId,
}: {
  targetType: "item" | "group";
  targetId: string;
}) {
  const showToast = useUiStore((s) => s.showToast);
  const [snapshots, setSnapshots] = useState<SnapshotSummary[]>([]);
  const [snapshotId, setSnapshotId] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    workspaceList()
      .then((list) => {
        if (alive) setSnapshots(list);
      })
      .catch(() => {
        if (alive) setSnapshots([]);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  async function onLink() {
    if (!snapshotId) return;
    setBusy(true);
    try {
      await clipboardLinkSnapshot(snapshotId, targetType, targetId);
      const name = snapshots.find((s) => s.id === snapshotId)?.name ?? "";
      showToast(`已关联到工作现场${name ? `「${name}」` : ""}`, { kind: "success" });
      setSnapshotId("");
    } catch (e) {
      showToast(`关联现场失败：${String(e)}`, { kind: "error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="clip-tasklink">
      <span className="clip-tasklink-label">
        <Layers size={11} /> 关联现场
      </span>
      {loading ? (
        <span className="clip-hint">正在读取工作现场…</span>
      ) : snapshots.length === 0 ? (
        <span className="clip-hint">还没有工作现场；先在任务上下文或工作区中保存现场。</span>
      ) : (
        <>
          <Combobox
            ariaLabel="选择要关联的工作现场"
            value={snapshotId}
            options={snapshots.slice(0, 100).map((s) => ({
              value: s.id,
              label: `${s.name}${s.task_title ? `（${s.task_title}）` : ""}`,
            }))}
            onChange={(v) => setSnapshotId(v)}
            searchPlaceholder="搜索现场…"
            emptyText="没有匹配的工作现场"
            placeholder="选择现场…"
          />
          <button className="btn sm" onClick={onLink} disabled={!snapshotId || busy}>
            关联
          </button>
        </>
      )}
    </div>
  );
}
