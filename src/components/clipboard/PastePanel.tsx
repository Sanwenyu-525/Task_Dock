//! 逐项粘贴面板：显式选择目标窗口 → 逐条写入剪贴板并发送 Ctrl+V。
//! 只报告「粘贴动作已发送」，目标应用是否接收由后端如实说明，前端不推断成功。

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  Play,
  RefreshCw,
  StopCircle,
  TriangleAlert,
} from "lucide-react";
import {
  clipboardFocusTarget,
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
import { errorMessage } from "../../lib/errors";
import { createSubscriptionScope } from "../../lib/subscriptions";
import { useSettingsStore } from "../../store/useSettingsStore";
import { useUiStore } from "../../store/useUiStore";
import { radioTabIndex, useRovingRadioGroup } from "../ui/radioGroup";
import TargetIcon from "./TargetIcon";

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
  /** 窗口枚举失败：不能把失败当成「没有可见窗口」，否则会误导用户去刷新而不是重试 */
  const [targetsError, setTargetsError] = useState<string | null>(null);
  /** 分组逐项顺序读取失败：非关键，允许降级但不冒充「没有条目」 */
  const [orderError, setOrderError] = useState<string | null>(null);
  /**
   * 选中目标必须同时记录 HWND + PID：HWND 会被系统复用，
   * 只记句柄可能在执行时把按键发到另一个进程。
   */
  const [selected, setSelected] = useState<{ hwnd: number; pid: number } | null>(null);
  const [job, setJob] = useState<JobState | null>(null);
  const [otherJob, setOtherJob] = useState<JobState | null>(null);
  const [busy, setBusy] = useState<"start" | "cancel" | "resume" | "refresh" | null>(null);
  /** 正在跳转的 HWND（防连点；同一时间只允许一次跳转） */
  const [jumping, setJumping] = useState<number | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  /** 当前任务的 jobId；用于在 setJob 提交前识别属于本任务的事件（旧任务事件仍被忽略） */
  const jobIdRef = useRef<string | null>(null);
  /** 逐项状态的展示顺序：多选用传入顺序，分组用组内顺序；固定不变，状态更新不重排 */
  const [orderIds, setOrderIds] = useState<string[]>([]);
  const groupMode = !!groupId;
  /** 只有标题真的被截断时才挂 data-tip，避免悬停任意卡片都弹提示遮挡其他行。 */
  const listRef = useRef<HTMLDivElement>(null);
  const [truncatedTitles, setTruncatedTitles] = useState<Set<number>>(new Set());
  /** 粘贴目标单选组：复用 listRef，单 Tab 停靠 + 方向键切换选中。 */
  const targetRadio = useRovingRadioGroup<HTMLDivElement>(listRef);

  useLayoutEffect(() => {
    const measure = () => {
      const list = listRef.current;
      if (!list) return;
      const next = new Set<number>();
      list.querySelectorAll<HTMLElement>("[data-target-hwnd]").forEach((row) => {
        const title = row.querySelector<HTMLElement>(".clip-target-title");
        if (title && title.scrollWidth > title.clientWidth + 1) {
          next.add(Number(row.dataset.targetHwnd));
        }
      });
      setTruncatedTitles((prev) =>
        prev.size === next.size && Array.from(next).every((v) => prev.has(v)) ? prev : next,
      );
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [targets]);

  async function loadTargets() {
    setBusy("refresh");
    try {
      const list = await clipboardVisibleTargets();
      setTargets(list);
      setTargetsError(null);
      // 不自动选第一个窗口；只保留仍然存在且 PID 一致的选择，其余要求用户重新选择。
      setSelected((cur) => {
        if (!cur) return null;
        const hit = list.find((t) => t.hwnd === cur.hwnd);
        return hit && hit.pid === cur.pid ? { hwnd: hit.hwnd, pid: hit.pid } : null;
      });
    } catch (e) {
      // 保留上次结果，明确标记失败；不再伪装成空列表
      setTargetsError(errorMessage(e));
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
          if (alive) {
            setOrderIds(g.items.map((i) => i.id));
            setOrderError(null);
          }
        })
        .catch((e) => {
          // 只影响逐项状态的展示顺序；粘贴仍可按后端顺序执行
          if (alive) setOrderError(errorMessage(e));
        });
    } else {
      setOrderIds(itemIds ?? []);
    }
    clipboardPasteActive()
      .then(async (id) => {
        if (!alive || !id) return;
        const j = await clipboardPasteJob(id).catch((e) => {
          if (alive) showToast(`读取当前粘贴任务状态失败：${errorMessage(e)}`, { kind: "warning" });
          return null;
        });
        if (!alive || !j) return;
        // 分组模式按 group_id 匹配；多选模式的后端审计 group_id 为空串
        const mine = groupMode ? j.group_id === groupId : j.group_id === "";
        if (mine) {
          jobIdRef.current = j.id;
          setJob(fromJob(j));
        } else setOtherJob(fromJob(j));
      })
      .catch((e) => {
        if (alive) showToast(`读取进行中的粘贴任务失败：${errorMessage(e)}`, { kind: "warning" });
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupId, groupMode]);

  useEffect(() => {
    const scope = createSubscriptionScope();
    scope.add(onClipboardPaste((e) => {
      setJob((prev) => {
        // 只接受当前任务的事件：旧任务事件不得覆盖新任务。
        const isMine = prev ? prev.id === e.jobId : jobIdRef.current === e.jobId;
        if (!isMine) return prev;
        const base = prev ?? {
          id: e.jobId,
          groupId: groupMode ? groupId ?? "" : "",
          status: e.status,
          sent: e.sent,
          total: e.total,
          pending: e.pending,
          itemStates: {},
        };
        // 启动竞态：任务可能在 setJob 提交前就完成，此时事件先到也要接住。
        jobIdRef.current = e.jobId;
        return {
          ...base,
          status: e.status,
          sent: e.sent,
          total: e.total,
          pending: e.pending,
          message: e.message ?? base.message,
          restored: e.restored ?? base.restored,
          itemState: e.itemState ?? base.itemState,
          confirmed: e.confirmed ?? base.confirmed,
          unverified: e.unverified ?? base.unverified,
          itemStates:
            e.itemId && e.itemState
              ? { ...base.itemStates, [e.itemId]: e.itemState }
              : base.itemStates,
        };
      });
      setOtherJob((prev) =>
        prev && prev.id === e.jobId
          ? { ...prev, status: e.status, sent: e.sent, total: e.total, pending: e.pending, message: e.message }
          : prev,
      );
    }));
    return () => scope.dispose();
  }, []);

  async function onStart() {
    if (!selected) return;
    if (!groupMode && (!itemIds || itemIds.length === 0)) return;
    setBusy("start");
    try {
      const target = await clipboardPastePrecheck(selected.hwnd, selected.pid);
      const r = groupMode
        ? await clipboardPasteGroup(groupId, selected.hwnd, selected.pid)
        : await clipboardPasteItems(selected.hwnd, selected.pid, itemIds!);
      // 先建立 jobId 关联，再主动拉一次最新状态：任务可能已经完成，
      // 实时事件也可能早于本次 setJob 到达。
      jobIdRef.current = r.job_id;
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
      const fresh = await clipboardPasteJob(r.job_id).catch((e) => {
        // 任务已开始，状态读取失败只影响进度展示，不能让用户以为没开始
        showToast(`粘贴已开始，但状态读取失败：${errorMessage(e)}`, { kind: "warning" });
        return null;
      });
      if (fresh) {
        setJob((prev) =>
          prev && prev.id === r.job_id
            ? {
                ...prev,
                status: fresh.status,
                sent: fresh.sent,
                total: fresh.total,
                pending: fresh.remaining_items.length,
                message: fresh.message ?? prev.message,
                restored: fresh.restored ?? prev.restored,
                targetTitle: fresh.target_title ?? prev.targetTitle,
              }
            : prev,
        );
      }
      showToast(`开始逐项粘贴到「${target.title}」（间隔 ${r.interval_ms} ms）`, { kind: "info" });
    } catch (e) {
      showToast(`无法开始粘贴：${errorMessage(e)}`, { kind: "error" });
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
      showToast(`取消失败：${errorMessage(e)}`, { kind: "error" });
    } finally {
      setBusy(null);
    }
  }

  async function onResume() {
    if (!job || !selected) return;
    setBusy("resume");
    try {
      await clipboardPastePrecheck(selected.hwnd, selected.pid);
      const r = await clipboardPasteResume(job.id, selected.hwnd, selected.pid);
      jobIdRef.current = r.job_id;
      setJob((prev) =>
        prev
          ? {
              ...prev,
              status: "running",
              total: r.total,
              pending: r.total,
            }
          : prev,
      );
      // 快速完成时同样以主动拉取为准，避免停留在「进行中」。
      const fresh = await clipboardPasteJob(r.job_id).catch((e) => {
        showToast(`继续粘贴已开始，但状态读取失败：${errorMessage(e)}`, { kind: "warning" });
        return null;
      });
      if (fresh) {
        setJob((prev) =>
          prev && prev.id === r.job_id
            ? {
                ...prev,
                status: fresh.status,
                sent: fresh.sent,
                total: fresh.total,
                pending: fresh.remaining_items.length,
                message: fresh.message ?? prev.message,
                restored: fresh.restored ?? prev.restored,
              }
            : prev,
        );
      }
      showToast(`继续粘贴剩余项（${r.total} 项）`, { kind: "info" });
    } catch (e) {
      showToast(`继续失败：${errorMessage(e)}`, { kind: "error" });
    } finally {
      setBusy(null);
    }
  }

  /** 跳转：选中 + 后端校验 HWND/PID/权限 → 激活。只切换窗口，不写剪贴板、不发送按键。 */
  async function onJump(t: PasteTarget) {
    if (running || jumping !== null) return;
    setSelected({ hwnd: t.hwnd, pid: t.pid });
    setJumping(t.hwnd);
    try {
      await clipboardFocusTarget(t.hwnd, t.pid);
      showToast(`已切换到「${t.title || "目标窗口"}」`, { kind: "info" });
    } catch (e) {
      showToast(`无法跳转：${errorMessage(e)}`, { kind: "error" });
    } finally {
      setJumping(null);
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
        <div className="clip-paste-intro">
          <span className="clip-hint">点击卡片选择目标，右侧箭头仅跳转，不执行粘贴。</span>
          <button
            className="clip-hint-toggle"
            onClick={() => setShowHelp((v) => !v)}
            aria-expanded={showHelp}
            aria-controls="clip-paste-help"
          >
            {showHelp ? "收起说明" : "操作说明"}
          </button>
        </div>
        {showHelp && (
          <div className="clip-hint clip-paste-help" id="clip-paste-help">
            <p>
              仅在点击「开始」后执行：依次把每一项写入剪贴板并发送一次 <code>Ctrl+V</code>。
              默认间隔：文字 {intervals.text} ms / 富文本 {intervals.html} ms / 图片 {intervals.image} ms /
              文件 {intervals.files} ms；图片更保守。
            </p>
            <p>
              取消会在当前步骤结束后生效，未处理项目保留以便手动继续；继续时需重新选择仍存在的目标窗口。
              最后一项发送后会先完成独立收尾，再尝试恢复剪贴板；若期间你又复制了新内容，不会覆盖。
            </p>
            <p>
              目标应用是否真正接收内容无法自动验证，结果只说明「粘贴动作已发送」；
              状态中的「未确认」不是失败，也不会自动重发可能已被接收的内容。
            </p>
            <p>所有粘贴都只由你手动触发，不会在后台自动执行。</p>
          </div>
        )}

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
        {targetsError && (
          <div className="clip-warn" role="status">
            <TriangleAlert size={12} />
            <span>读取窗口列表失败：{targetsError}</span>
            <button className="btn sm" onClick={() => void loadTargets()} disabled={busy === "refresh"}>
              重试
            </button>
          </div>
        )}
        {targets === null ? (
          <div className="clip-hint">
            {targetsError ? "窗口列表未读取成功，请点击刷新重试。" : "正在读取可见窗口…"}
          </div>
        ) : targets.length === 0 ? (
          <div className="clip-hint">
            未发现其他可见窗口。请先打开目标应用，再点击刷新。本应用自身不能作为粘贴目标。
          </div>
        ) : (
          <div
            ref={listRef}
            className="clip-target-list"
            role="radiogroup"
            aria-label="粘贴目标窗口"
            onKeyDown={targetRadio.onKeyDown}
          >
            {targets.map((t, i) => {
              const isSelected = selected?.hwnd === t.hwnd && selected.pid === t.pid;
              const isJumping = jumping === t.hwnd;
              return (
                <div
                  key={t.hwnd}
                  data-target-hwnd={t.hwnd}
                  className={`clip-target-row ${isSelected ? "active" : ""}`}
                >
                  {/* 点击卡片只选中：高亮并更新目标身份，不跳转、不粘贴。 */}
                  <button
                    className="clip-target"
                    role="radio"
                    aria-checked={isSelected}
                    tabIndex={radioTabIndex(isSelected, !!selected, i)}
                    disabled={running}
                    onClick={() => setSelected({ hwnd: t.hwnd, pid: t.pid })}
                    data-tip={truncatedTitles.has(t.hwnd) ? t.title : undefined}
                  >
                    {/* 真实应用图标：后端按窗口身份解析 exe，失败回退统一通用图标。 */}
                    <TargetIcon hwnd={t.hwnd} pid={t.pid} exePath={t.exe_path} />
                    <span className="clip-target-text">
                      <span className="clip-target-title">{t.title || "（无标题窗口）"}</span>
                      <span className="clip-target-meta">
                        {fileBaseName(t.exe_path)} · PID {t.pid}
                      </span>
                    </span>
                  </button>
                  <span className="clip-target-state" aria-hidden={!isSelected}>
                    {isSelected && (
                      <>
                        <Check size={11} /> 已选
                      </>
                    )}
                  </span>
                  {/* 跳转是独立点击区：选中 + 校验身份 + 激活；不触发粘贴。 */}
                  <button
                    className="icon-btn sm clip-target-jump"
                    onClick={(e) => {
                      e.stopPropagation();
                      void onJump(t);
                    }}
                    disabled={running || jumping !== null}
                    data-tip="跳转到该窗口"
                    aria-label={`跳转到该窗口：${t.title || "无标题窗口"}`}
                  >
                    {isJumping ? (
                      <RefreshCw size={12} className="spin" />
                    ) : (
                      <ArrowUpRight size={12} />
                    )}
                  </button>
                </div>
              );
            })}
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
            {orderError && (
              <div className="clip-hint">
                逐项顺序读取失败，仍会按后端顺序粘贴，但暂时看不到逐项状态：{orderError}
              </div>
            )}
            {/* 秒完成任务可能只拿到聚合状态；没有逐项事件时不展示全“待处理”的误导 chip。 */}
            {orderIds.length > 0 &&
              !(job.status !== "running" && Object.keys(job.itemStates).length === 0) && (
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
              <button className="btn sm" onClick={onResume} disabled={busy === "resume" || !selected}>
                <Play size={11} /> 继续剩余 {job.pending} 项到所选窗口
              </button>
            )}
          </div>
        )}

        <div className="clip-paste-actions">
          <button
            className="btn primary"
            onClick={onStart}
            disabled={!selected || running || busy === "start"}
          >
            {busy === "start" ? <RefreshCw size={12} className="spin" /> : <Play size={12} />} 开始逐项粘贴
          </button>
          {!selected && <span className="clip-hint">请先选择目标窗口</span>}
        </div>
      </div>
    </div>
  );
}
