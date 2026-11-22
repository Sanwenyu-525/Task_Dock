//! 批量关联项目/任务：复用 ShelfDetail 同一套关联表与选择器，
//! 只做「选择目标 → 一次提交」，不新建项目/任务体系。
//!
//! 失败呈现：目标不存在 = 整批失败；条目已删除等 = 部分失败明细。

import { useEffect, useState } from "react";
import { Link2, Loader2 } from "lucide-react";
import {
  listTasks,
  workspaceProjectList,
  type ShelfBatchLinkReport,
} from "../../lib/bridge";
import { errorMessage } from "../../lib/errors";
import { useShelfStore } from "../../store/useShelfStore";
import { useUiStore } from "../../store/useUiStore";
import { Dialog } from "../ui/Dialog";
import Select from "../ui/Select";

type BatchLinkTarget = "project" | "task";
type OptionsState = "loading" | "ready" | "error";

export interface ShelfBatchLinkDialogProps {
  open: boolean;
  ids: string[];
  onClose: () => void;
  /** 部分失败需要外层展示详情时回调（成功时也会回调）。 */
  onDone?: (report: ShelfBatchLinkReport) => void;
}

function failureDetail(report: ShelfBatchLinkReport): string {
  const lines = report.failed
    .slice(0, 3)
    .map((f) => `${f.item_id.slice(0, 8)}…：${f.reason}`);
  if (report.failed.length > 3) lines.push(`另有 ${report.failed.length - 3} 项失败`);
  return lines.join("；");
}

export default function ShelfBatchLinkDialog({
  open,
  ids,
  onClose,
  onDone,
}: ShelfBatchLinkDialogProps) {
  const showToast = useUiStore((s) => s.showToast);
  const batchLink = useShelfStore((s) => s.batchLink);
  const [target, setTarget] = useState<BatchLinkTarget>("project");
  const [targetId, setTargetId] = useState("");
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [tasks, setTasks] = useState<{ id: string; title: string }[]>([]);
  const [state, setState] = useState<OptionsState>("loading");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTarget("project");
    setTargetId("");
    setState("loading");
    setError("");
    let alive = true;
    Promise.all([workspaceProjectList("active"), listTasks({ view: "all", limit: 200 })])
      .then(([projectRes, taskList]) => {
        if (!alive) return;
        setProjects(projectRes.projects.map((p) => ({ id: p.id, name: p.name })));
        setTasks(taskList.map((t) => ({ id: t.id, title: t.title })));
        setState("ready");
      })
      .catch((e) => {
        if (!alive) return;
        setProjects([]);
        setTasks([]);
        setError(errorMessage(e));
        setState("error");
      });
    return () => {
      alive = false;
    };
  }, [open]);

  const options = target === "project" ? projects : tasks;
  const placeholder =
    state === "loading"
      ? "正在加载…"
      : state === "error"
        ? "列表加载失败"
        : options.length === 0
          ? target === "project"
            ? "暂无可关联项目"
            : "暂无可关联任务"
          : target === "project"
            ? "选择项目…"
            : "选择任务…";

  const submit = async () => {
    if (!targetId || busy) return;
    setBusy(true);
    try {
      const report = await batchLink(ids, target, targetId);
      if (report.success) {
        const extra: string[] = [];
        if (report.duplicates > 0) extra.push(`${report.duplicates} 项已关联`);
        if (report.failed.length > 0) extra.push(`${report.failed.length} 项失败`);
        showToast(
          `已关联「${report.target_name}」${report.linked} 项${extra.length ? `（${extra.join("，")}）` : ""}`,
          {
            kind: report.partial ? "warning" : "success",
            detail: report.partial ? failureDetail(report) : undefined,
            code: report.code ?? undefined,
          },
        );
        onDone?.(report);
        onClose();
      } else {
        showToast(`批量关联失败：${failureDetail(report) || "没有可关联的条目"}`, {
          kind: "error",
          code: report.code ?? "SHELF_BATCH_LINK_FAILED",
        });
      }
    } catch (e) {
      showToast(`批量关联失败：${errorMessage(e)}`, { kind: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="批量关联"
      size="sm"
      ariaLabel="批量关联项目或任务"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={() => void submit()}
            disabled={busy || !targetId}
          >
            {busy ? <Loader2 size={14} className="spin" aria-hidden="true" /> : <Link2 size={14} aria-hidden="true" />}
            关联 {ids.length} 项
          </button>
        </>
      }
    >
      <div className="shelf-batch-link">
        <div className="shelf-batch-link-mode" role="group" aria-label="关联目标类型">
          <button
            type="button"
            className={`btn sm${target === "project" ? " primary" : ""}`}
            aria-pressed={target === "project"}
            onClick={() => {
              setTarget("project");
              setTargetId("");
            }}
          >
            项目
          </button>
          <button
            type="button"
            className={`btn sm${target === "task" ? " primary" : ""}`}
            aria-pressed={target === "task"}
            onClick={() => {
              setTarget("task");
              setTargetId("");
            }}
          >
            任务
          </button>
        </div>
        <Select
          value={targetId}
          options={options.map((o) => ({
            value: o.id,
            label: "name" in o ? o.name : o.title,
          }))}
          onChange={setTargetId}
          placeholder={placeholder}
          disabled={state !== "ready" || options.length === 0}
          ariaLabel={target === "project" ? "选择要关联的项目" : "选择要关联的任务"}
          size="sm"
          align="start"
          menuMinWidth={220}
        />
        {state === "error" && (
          <p className="shelf-links-status is-error" role="alert">
            列表加载失败：{error}
          </p>
        )}
        <p className="shelf-batch-link-hint">
          只建立关联关系，不复制内容、不移动文件；已关联的条目会跳过。
        </p>
      </div>
    </Dialog>
  );
}
