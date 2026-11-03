//! 逐项粘贴面板：显式选择目标窗口 → 逐条写入剪贴板并发送 Ctrl+V。
//! 只报告「粘贴动作已发送」，目标应用是否接收由后端如实说明，前端不推断成功。

import { useEffect, useState } from "react";
import { ArrowLeft, Play, RefreshCw, StopCircle, TriangleAlert } from "lucide-react";
import {
  clipboardGroup,
  clipboardPasteActive,
  clipboardPasteCancel,
  clipboardPasteGroup,
  clipboardPasteItems,
  clipboardPasteJob,
  clipboardPastePrecheck,
  clipboardPasteResume,
  clipboardVisibleTargets,
  onClipboardPaste,
  type PasteJob,
  type PasteTarget,
} from "../../lib/bridge";
import { fileBaseName } from "../../lib/clipboardUi";
import { createSubscriptionScope } from "../../lib/subscriptions";
import { useSettingsStore } from "../../store/useSettingsStore";
import { useUiStore } from "../../store/useUiStore";

interface JobState {
  id: string;
  groupId: string;
  status: string;
  sent: number;
  total: number;
  pending: number;
  message?: string;
  restored?: boolean;
  targetTitle?: string;
  itemState?: string;
  confirmed?: number;
  unverified?: number;
  /** 会话内累计的逐项状态（itemId → 状态）；后端不持久化，恢复任务后重新累计 */
  itemStates: Record<string, string>;
}

function fromJob(j: PasteJob): JobState {
  return {
    id: j.id,
    groupId: j.group_id,
    status: j.status,
    sent: j.sent,
    total: j.total,
    pending: j.remaining_items.length,
    message: j.message,
    restored: j.restored,
    targetTitle: j.target_title,
    itemStates: {},
  };
}

const STATUS_LABELS: Record<string, string> = {
  running: "进行中",
  completed: "已完成",
  cancelled: "已取消",
  failed: "已停止",
};

const ITEM_STATE_LABELS: Record<string, string> = {
  pending: "待处理",
  preparing: "准备中",
  clipboard_written: "已写入剪贴板",
  input_sent: "按键已发送",
  settling: "等待目标处理",
  confirmed: "已确认接收",
  unverified: "未确认（无接收信号）",
  failed: "失败",
  cancelled: "已取消",
};

/** 逐项状态 chip 的紧凑标签：语义同上，chip 内需要更短 */
const ITEM_CHIP_LABELS: Record<string, string> = {
  pending: "待处理",
  preparing: "准备中",
  clipboard_written: "已写入",
  input_sent: "已发送",
  settling: "等待中",
  confirmed: "已确认",
  unverified: "未确认",
  failed: "失败",
  cancelled: "已取消",
};

export default function PastePanel({
  groupId,
  groupName,
  itemIds,
  onBack,
}: {
  /** 分组模式：粘贴整个分组（与 itemIds 二选一） */
  groupId?: string;
  groupName?: string;
  /** 多选模式：按传入顺序逐项粘贴，不依赖永久分组 */
  itemIds?: string[];
  onBack: () => void;
}) {
  const settings = useSettingsStore((s) => s.settings);
  const showToast = useUiStore((s) => s.showToast);
  const [targets, setTargets] = useState<PasteTarget[] | null>(null);
  const [targetHwnd, setTargetHwnd] = useState<number | null>(null);
  const [job, setJob] = useState<JobState | null>(null);
  const [otherJob, setOtherJob] = useState<JobState | null>(null);
  const [busy, setBusy] = useState<"start" | "cancel" | "resume" | "refresh" | null>(null);
  /** 逐项状态的展示顺序：多选用传入顺序，分组用组内顺序；固定不变，状态更新不重排 */
  const [orderIds, setOrderIds] = useState<string[]>([]);
  const groupMode = !!groupId;

  async function loadTargets() {
    setBusy("refresh");
    try {
      const list = await clipboardVisibleTargets();
      setTargets(list);
      setTargetHwnd((cur) => (cur !== null && list.some((t) => t.hwnd === cur) ? cur : list[0]?.hwnd ?? null));
    } catch (e) {
      setTargets([]);
      showToast(`读取窗口列表失败：${String(e)}`, { kind: "error" });
    } finally {
      setBusy(null);
    }
  }

  useEffect(() => {
    let alive = true;
    void loadTargets();
    if (groupMode) {
      // 分组模式的逐项顺序来自组内条目；失败不阻塞粘贴，只降级为不展示逐项列表
      clipboardGroup(groupId!)
        .then((g) => {
          if (alive) setOrderIds(g.items.map((i) => i.id));
        })
        .catch(() => {});
    } else {
      setOrderIds(itemIds ?? []);
    }
    clipboardPasteActive()
      .then(async (id) => {
        if (!alive || !id) return;
        const j = await clipboardPasteJob(id).catch(() => null);
        if (!alive || !j) return;
        // 分组模式按 group_id 匹配；多选模式的后端审计 group_id 为空串
        const mine = groupMode ? j.group_id === groupId : j.group_id === "";
        if (mine) setJob(fromJob(j));
        else setOtherJob(fromJob(j));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupId, groupMode]);

  useEffect(() => {
    const scope = createSubscriptionScope();
    scope.add(onClipboardPaste((e) => {
      setJob((prev) =>
        prev && prev.id === e.jobId
          ? {
              ...prev,
              status: e.status,
              sent: e.sent,
              total: e.total,
              pending: e.pending,
              message: e.message ?? prev.message,
              restored: e.restored ?? prev.restored,
              itemState: e.itemState ?? prev.itemState,
              confirmed: e.confirmed ?? prev.confirmed,
              unverified: e.unverified ?? prev.unverified,
              itemStates:
                e.itemId && e.itemState
                  ? { ...prev.itemStates, [e.itemId]: e.itemState }
                  : prev.itemStates,
            }
          : prev,
      );
      setOtherJob((prev) =>
        prev && prev.id === e.jobId
          ? { ...prev, status: e.status, sent: e.sent, total: e.total, pending: e.pending, message: e.message }
          : prev,
      );
    }));
    return () => scope.dispose();
  }, []);

  async function onStart() {
    if (targetHwnd === null) return;
    if (!groupMode && (!itemIds || itemIds.length === 0)) return;
    setBusy("start");
    try {
      const target = await clipboardPastePrecheck(targetHwnd);
      const r = groupMode
        ? await clipboardPasteGroup(groupId, targetHwnd)
        : await clipboardPasteItems(targetHwnd, itemIds!);
      setJob({
        id: r.job_id,
        groupId: groupMode ? groupId! : "",
        status: "running",
        sent: 0,
        total: r.total,
        pending: r.total,
        targetTitle: target.title,
        itemStates: {},
      });
      showToast(`开始逐项粘贴到「${target.title}」（间隔 ${r.interval_ms} ms）`, { kind: "info" });
    } catch (e) {
      showToast(`无法开始粘贴：${String(e)}`, { kind: "error" });
    } finally {
      setBusy(null);
    }
  }

  async function onCancel(j: JobState) {
    setBusy("cancel");
    try {
      await clipboardPasteCancel(j.id);
      showToast("已请求取消：当前步骤结束后停止", { kind: "info" });
    } catch (e) {
      showToast(`取消失败：${String(e)}`, { kind: "error" });
    } finally {
      setBusy(null);
    }
  }

  async function onResume() {
    if (!job || targetHwnd === null) return;
    setBusy("resume");
    try {
      await clipboardPastePrecheck(targetHwnd);
      const r = await clipboardPasteResume(job.id, targetHwnd);
      const fresh = await clipboardPasteJob(r.job_id).catch(() => null);
      setJob((prev) =>
        prev
          ? {
              ...prev,
              status: "running",
              total: r.total,
              ...(fresh ? { sent: fresh.sent, pending: fresh.remaining_items.length } : {}),
            }
          : prev,
      );
      showToast(`继续粘贴剩余项（${r.total} 项）`, { kind: "info" });
    } catch (e) {
      showToast(`继续失败：${String(e)}`, { kind: "error" });
    } finally {
      setBusy(null);
    }
  }

  const intervals = {
    text: settings?.clipboard_paste_interval_ms ?? 350,
    html: settings?.clipboard_paste_interval_html_ms ?? 600,
    image: settings?.clipboard_paste_interval_image_ms ?? 1200,
    files: settings?.clipboard_paste_interval_files_ms ?? 900,
  };
  const running = job?.status === "running";
  const progress = job && job.total > 0 ? Math.round((job.sent / job.total) * 100) : 0;

  return (
    <div className="clip-detail clip-paste">
      <div className="clip-detail-head">
        <button className="icon-btn sm" onClick={onBack} data-tip="返回" aria-label="返回分组详情">
          <ArrowLeft size={13} />
        </button>
        <span>逐项粘贴 · {groupName ?? `所选 ${itemIds?.length ?? 0} 项`}</span>
      </div>

      <div className="clip-detail-body">
        <div className="clip-hint">
          仅在点击「开始」后执行：依次把每一项写入剪贴板并发送一次 <code>Ctrl+V</code>。
          默认间隔：文字 {intervals.text} ms / 富文本 {intervals.html} ms / 图片 {intervals.image} ms /
          文件 {intervals.files} ms；图片更保守。最后一项发送后会先完成独立收尾，再尝试恢复剪贴板。
          取消会在当前步骤结束后生效，未处理项目会保留以便手动继续。
          目标应用是否真正接收内容无法自动验证，结果只说明「粘贴动作已发送」；状态中的「未确认」不是失败。
        </div>

        {otherJob && otherJob.status === "running" && (
          <div className="clip-warn">
            <TriangleAlert size={12} />
            <span>
              另一个分组正在粘贴到「{otherJob.targetTitle || "其他窗口"}」（{otherJob.sent}/{otherJob.total}）。
              同一时间只允许一个粘贴任务。
            </span>
            <button className="btn sm" onClick={() => onCancel(otherJob)} disabled={busy === "cancel"}>
              取消它
            </button>
          </div>
        )}

        <div className="clip-block-head">
          <span>目标窗口</span>
          <button className="btn sm" onClick={loadTargets} disabled={busy === "refresh" || running}>
            {busy === "refresh" ? <RefreshCw size={11} className="spin" /> : <RefreshCw size={11} />} 刷新
          </button>
        </div>
        {targets === null ? (
          <div className="clip-hint">正在读取可见窗口…</div>
        ) : targets.length === 0 ? (
          <div className="clip-hint">
            未发现其他可见窗口。请先打开目标应用，再点击刷新。本应用自身不能作为粘贴目标。
          </div>
        ) : (
          <div className="clip-target-list" role="radiogroup" aria-label="粘贴目标窗口">
            {targets.map((t) => (
              <button
                key={t.hwnd}
                className={`clip-target ${targetHwnd === t.hwnd ? "active" : ""}`}
                role="radio"
                aria-checked={targetHwnd === t.hwnd}
                disabled={running}
                onClick={() => setTargetHwnd(t.hwnd)}
                title={t.title}
              >
                <span className="clip-target-title">{t.title || "（无标题窗口）"}</span>
                <span className="clip-target-meta">
                  {fileBaseName(t.exe_path)} · PID {t.pid}
                </span>
              </button>
            ))}
          </div>
        )}

        {job && (
          <div className="clip-paste-job">
            <div className="clip-paste-job-head">
              <span className={`clip-paste-status status-${job.status}`}>
                {STATUS_LABELS[job.status] ?? job.status}
              </span>
              <span>
                已发送 {job.sent}/{job.total} 项
                {job.itemState ? ` · 当前：${ITEM_STATE_LABELS[job.itemState] ?? job.itemState}` : ""}
                {job.pending > 0 ? ` · 剩余 ${job.pending} 项` : ""}
              </span>
            </div>
            <div
              className="clip-progress"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={job.total}
              aria-valuenow={job.sent}
            >
              <div style={{ width: `${progress}%` }} />
            </div>
            {job.message && <div className="clip-paste-message">{job.message}</div>}
            {orderIds.length > 0 && (
              <div className="clip-paste-items" role="list" aria-label="逐项粘贴状态">
                {orderIds.map((id, i) => {
                  const st = job.itemStates[id] ?? "pending";
                  return (
                    <span key={id} role="listitem" className={`clip-paste-item st-${st}`}>
                      <span className="clip-paste-item-idx">{i + 1}</span>
                      {ITEM_CHIP_LABELS[st] ?? st}
                    </span>
                  );
                })}
              </div>
            )}
            {running && (
              <button className="btn sm danger" onClick={() => onCancel(job)} disabled={busy === "cancel"}>
                <StopCircle size={11} /> 取消粘贴
              </button>
            )}
            {!running && job.pending > 0 && (
              <button className="btn sm" onClick={onResume} disabled={busy === "resume" || targetHwnd === null}>
                <Play size={11} /> 继续剩余 {job.pending} 项到所选窗口
              </button>
            )}
          </div>
        )}

        <div className="clip-paste-actions">
          <button
            className="btn primary"
            onClick={onStart}
            disabled={targetHwnd === null || running || busy === "start"}
          >
            {busy === "start" ? <RefreshCw size={12} className="spin" /> : <Play size={12} />} 开始逐项粘贴
          </button>
          <span className="clip-hint">此操作只会由你手动触发，不会在后台自动粘贴。</span>
        </div>
      </div>
    </div>
  );
}
