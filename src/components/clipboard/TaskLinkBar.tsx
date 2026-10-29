//! 从剪贴板详情手动关联任务（不自动绑定）。

import { useState } from "react";
import { Link2 } from "lucide-react";
import { clipboardLinkTask } from "../../lib/bridge";
import { useTasksStore } from "../../store/useTasksStore";
import { useUiStore } from "../../store/useUiStore";

export default function TaskLinkBar({
  targetType,
  targetId,
}: {
  targetType: "item" | "group";
  targetId: string;
}) {
  const tasks = useTasksStore((s) => s.tasks);
  const showToast = useUiStore((s) => s.showToast);
  const bumpLink = useUiStore((s) => s.bumpClipboardLink);
  const [taskId, setTaskId] = useState("");
  const [busy, setBusy] = useState(false);

  async function onLink() {
    if (!taskId) return;
    setBusy(true);
    try {
      await clipboardLinkTask(taskId, targetType, targetId);
      const title = tasks.find((t) => t.id === taskId)?.title ?? "";
      showToast(`已关联到任务${title ? `「${title}」` : ""}`, { kind: "success" });
      setTaskId("");
      bumpLink();
    } catch (e) {
      showToast(`关联失败：${String(e)}`, { kind: "error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="clip-tasklink">
      <span className="clip-tasklink-label">
        <Link2 size={11} /> 关联任务
      </span>
      {tasks.length === 0 ? (
        <span className="clip-hint">任务列表为空，请先在任务页加载任务后再关联。</span>
      ) : (
        <>
          <select
            value={taskId}
            onChange={(e) => setTaskId(e.target.value)}
            aria-label="选择要关联的任务"
          >
            <option value="">选择任务…</option>
            {tasks.slice(0, 100).map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
          </select>
          <button className="btn sm" onClick={onLink} disabled={!taskId || busy}>
            关联
          </button>
        </>
      )}
    </div>
  );
}
