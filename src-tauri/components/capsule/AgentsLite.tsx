//! Agent 面板（胶囊内，对照 `docs/design-refs/v07/停靠效果图/02-agents.png`）。
//!
//! 「消息数量不能简单用累计历史」的落点：这里只列**实时**运行
//! （`liveRuns`：running / waiting / 近 1 小时 failed / disconnected），
//! 并按 failed → waiting → running → disconnected 排序，需要人处理的排最前。
//! 状态筛选分段（全部/运行中/等待/失败/失联）是对这份实时集合的**客户端过滤**
//! ——快照数据已在本面板，不新增后端调用，与 attention 排序共存。
//!
//! 效果图里的 Agent 名称、会话数、轮次都只是视觉示例；这里全部来自
//! `useAgentsStore.snapshot`（本地事件流），没有的字段（如进度百分比）不显示，
//! 也不提供后端不支持的「暂停 / 重启 / 新建 Agent」。
//! 每个 Agent 能做的只有两件真实存在的事：打开它的会话，或进入完整 Agent 页。
//!
//! 「行动」入口只做导航：行动中心的数据、刷新与门控归完整页
//! （`useActionsStore` / `ActionCenterPanel`）。胶囊不再订阅一份聚合 feed，
//! 也不轮询；用户关闭行动中心时入口隐藏，避免给出只能看到「已关闭」的死入口。

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { Activity, ArrowUpRight, ChevronRight, RefreshCw } from "lucide-react";
import AgentIcon from "../ui/AgentIcon";
import { openAgentSession } from "../../lib/bridge";
import { useAgentsStore } from "../../store/useAgentsStore";
import { useSettingsStore } from "../../store/useSettingsStore";
import { attentionRank, liveRuns, liveSummary } from "../../lib/agentTree";
import { AGENT_STATE_LABELS } from "../../lib/format";
import { avatarHue } from "../../lib/navigation";
import { useLocale, type UseLocaleResult } from "../../hooks/useLocale";
import { openFullApp } from "./actions";
import { EmptyState, PanelHead, Segmented, type SegOption } from "./PanelKit";

const pad = (n: number) => String(n).padStart(2, "0");

/** 状态分段：对实时集合的客户端过滤，不新增后端调用。 */
type AgentFilter = "all" | "running" | "waiting" | "failed" | "disconnected";

function filterOptions(t: UseLocaleResult["t"]): readonly SegOption<AgentFilter>[] {
  return [
    { value: "all", label: t("capsule.agents.filter.all") },
    { value: "running", label: t("capsule.agents.filter.running") },
    { value: "waiting", label: t("capsule.agents.filter.waiting") },
    { value: "failed", label: t("capsule.agents.filter.failed") },
    { value: "disconnected", label: t("capsule.agents.filter.disconnected") },
  ];
}

/** 最近活动时间：今天显示 HH:mm，其他显示 M/D。 */
function stamp(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const d = new Date(t);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  return sameDay ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : `${d.getMonth() + 1}/${d.getDate()}`;
}

export default function AgentsLite() {
  const { t } = useLocale();
  const snapshot = useAgentsStore((s) => s.snapshot);
  const snapshotError = useAgentsStore((s) => s.snapshotError);
  const load = useAgentsStore((s) => s.load);
  // 只读既有设置，判断「行动」入口是否还有意义；不订阅行动 feed、不发 IPC。
  // 设置未加载（null）按默认开启处理，与完整页 `?? true` 的口径一致。
  const actionsEnabled = useSettingsStore((s) => s.settings?.actions_enabled ?? true);
  const [filter, setFilter] = useState<AgentFilter>("all");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // 面板打开时补一次快照（既有的节流/单飞机制保证不会打爆 IPC）
  useEffect(() => {
    if (!snapshot) void load();
  }, [snapshot, load]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 2400);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const summary = useMemo(() => liveSummary(snapshot), [snapshot]);
  const hasLiveActivity =
    summary.running + summary.waiting + summary.failed + summary.disconnected > 0;
  const runs = useMemo(
    () =>
      [...liveRuns(snapshot?.runs ?? [])]
        // 状态分段是对同一份实时集合的客户端过滤（快照已在本面板，无新 IPC）
        .filter((r) => filter === "all" || r.status === filter)
        .sort((a, b) => {
          // 与完整 Agent 页同源：等待介入优先于失败（可直接行动的先看到）。
          const ra = attentionRank(a.status);
          const rb = attentionRank(b.status);
          if (ra !== rb) return ra - rb;
          return (b.updated_at ?? "").localeCompare(a.updated_at ?? "");
        })
        .slice(0, 8),
    [snapshot, filter],
  );
  const refresh = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await load();
      // `load` 内部已捕获后端错误：结果以 store 的错误字段为准，不能把它当成功
      setNotice(
        useAgentsStore.getState().snapshotError ? t("capsule.agents.refreshFailed") : t("capsule.agents.refreshed"),
      );
    } catch {
      setNotice(t("capsule.agents.refreshFailed"));
    } finally {
      setBusy(false);
    }
  };

  /** 打开会话：后端按 `agent_sessions.external_id` 校验并恢复，不能传本地行 ID
      （`run.session_id` 是内部外键，传它必然查不到会话）。 */
  const open = async (sourceId: string, externalSessionId: string) => {
    try {
      await openAgentSession(sourceId, externalSessionId);
    } catch {
      // 会话跳转依赖具体 Agent 的能力：失败时如实提示，不伪造成功
      setNotice(t("capsule.agents.openSessionFailed"));
    }
  };

  const filters = useMemo(() => filterOptions(t), [t]);

  return (
    <>
      <PanelHead
        title={t("capsule.agents.title")}
        sub={t("capsule.agents.subtitle")}
        actions={
          <>
            {/* 效果图右侧是「搜索 / 筛选 / 新建」三颗按钮；后端没有搜索、新建
                Agent 的接口，因此只保留真实可做的事：状态筛选（客户端）、刷新
                快照、进完整页。 */}
            <button
              type="button"
              className="cap-iconbtn"
              aria-label={t("capsule.agents.refreshAria")}
              data-tip-placement="bottom"
              aria-disabled={busy}
              onClick={() => void refresh()}
            >
              <RefreshCw size={15} strokeWidth={2} aria-hidden="true" />
            </button>
          </>
        }
      />

      <div className="cap-summary">
        <Activity size={13} strokeWidth={1.9} aria-hidden="true" />
        {snapshot === null && snapshotError !== null ? (
          <span>{t("capsule.agents.loadFailed")}</span>
        ) : snapshot === null ? (
          <span>{t("capsule.agents.loading")}</span>
        ) : (
          // 数量口径全部来自 snapshot 的实时轮次（liveRuns），按状态分列、不合并：
          // 绝不把实例/会话总数算成「运行中」，失联只在真实存在时出现。
          <span>
            {t("capsule.agents.summaryCounts", {
              running: summary.running,
              waiting: summary.waiting,
              failed: summary.failed,
            })}
            {summary.disconnected > 0
              ? ` ${t("capsule.agents.summaryDisconnected", { disconnected: summary.disconnected })}`
              : null}
            {snapshot.live_summary?.sessions_truncated || snapshot.live_summary?.runs_truncated
              ? ` ${t("capsule.agents.summaryTruncated")}`
              : null}
            {snapshotError !== null ? ` ${t("capsule.agents.summaryStale")}` : null}
          </span>
        )}
      </div>

      <Segmented
        label={t("capsule.agents.filterAria")}
        options={filters}
        value={filter}
        onChange={setFilter}
      />

      <div className="cap-list">
        {/* 首次读取失败：明确错误空态 + 重试，不能一直停在「读取中…」 */}
        {snapshot === null && snapshotError !== null && (
          <EmptyState
            icon={<AgentIcon size={22} strokeWidth={1.6} aria-hidden="true" />}
            text={t("capsule.agents.emptyError")}
            actionLabel={t("common.retry")}
            onAction={() => void refresh()}
          />
        )}

        {/* 已有旧快照但本次刷新失败：保留旧数据，同时标注可能过期 */}
        {snapshot !== null && snapshotError !== null && (
          <div className="cap-item cap-error-row" role="alert">
            <span className="cap-error-text">{t("capsule.panel.staleText")}</span>
            <button type="button" className="cap-mini" aria-label={t("capsule.agents.retryAria")} onClick={() => void refresh()}>
              {t("common.retry")}
            </button>
          </div>
        )}

        {snapshot !== null && snapshotError === null && !hasLiveActivity && (
          <EmptyState
            icon={<AgentIcon size={22} strokeWidth={1.6} aria-hidden="true" />}
            text={t("capsule.agents.emptyNone")}
            actionLabel={t("capsule.agents.emptyConfigAction")}
            onAction={() => openFullApp("agents")}
          />
        )}
        {snapshot !== null && snapshotError === null && hasLiveActivity && runs.length === 0 && (
          <div className="cap-item" role="status">
            {filter === "all"
              ? t("capsule.agents.truncatedNote")
              : t("capsule.agents.emptyFiltered")}
          </div>
        )}
        {runs.map((r) => {
          const session = snapshot?.sessions.find((s) => s.id === r.session_id);
          /** 可直接跳转的外部会话 ID；会话不在当前快照明细里（被截断或已清理）时为空，
              此时不提供「打开」（传内部 ID 必然失败），改为进完整页查看。 */
          const externalSessionId = session?.external_id ?? "";
          const title = r.task_title || session?.title || r.source_id;
          const label = AGENT_STATE_LABELS[r.status] ?? r.status;
          const sourceCounts = snapshot?.live_summary?.by_source?.[r.source_id];
          const sessionCount = sourceCounts?.session_total ??
            snapshot?.sessions.filter((s) => s.source_id === r.source_id).length ?? 0;
          // 「运行」只统计当前实时轮次（running/waiting/近期 failed/disconnected），
          // 不能把 completed 历史轮次算成正在运行。
          const runCount = sourceCounts?.run_total ?? liveRuns(snapshot?.runs ?? []).filter(
            (x) => x.source_id === r.source_id,
          ).length;
          const hue = avatarHue(r.source_id || title);
          return (
            <div className="cap-item cap-agent-row" key={r.id}>
              <span
                className="cap-tile tile-sm"
                style={{ "--app-hue": String(hue) } as CSSProperties}
                aria-hidden="true"
              >
                <span className="cap-agent-initial">{title.slice(0, 1).toUpperCase()}</span>
              </span>
              <span className="cap-main">
                <span className="cap-agent-head">
                  <span className="cap-agent-name" title={title}>
                    {title}
                  </span>
                  <span className={`cap-state state-${r.status}`}>{label}</span>
                </span>
                <span className="cap-agent-meta">
                  {t("capsule.agents.metaSessions", { count: sessionCount })}
                  <i className="sep" aria-hidden="true" />
                  {t("capsule.agents.metaRuns", { count: runCount })}
                  {stamp(r.updated_at) ? (
                    <>
                      <i className="sep" aria-hidden="true" />
                      {stamp(r.updated_at)}
                    </>
                  ) : null}
                </span>
                {r.pending_items.length > 0 ? (
                  // 摘要直接复用快照里的 pending_items（不新起消息队列）：
                  // 数量之外给出第一条内容，用户不必进完整页才知道要确认什么。
                  <span className="cap-agent-meta cap-agent-pending">
                    {t("capsule.agents.pendingItems", { count: r.pending_items.length })}
                    <i className="sep" aria-hidden="true" />
                    <span className="cap-agent-pending-text">{r.pending_items[0]}</span>
                  </span>
                ) : null}
              </span>
              <span className="cap-agent-side">
                {externalSessionId ? (
                  <button
                    type="button"
                    className="cap-mini"
                    aria-label={t("capsule.agents.openSessionAria", { title })}
                    onClick={() => void open(r.source_id, externalSessionId)}
                  >
                    {t("capsule.agents.openBtn")}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="cap-mini is-icon"
                    aria-label={t("capsule.agents.viewAria", { title })}
                    onClick={() => openFullApp("agents")}
                  >
                    <ArrowUpRight size={12} strokeWidth={2.2} aria-hidden="true" />
                  </button>
                )}
              </span>
            </div>
          );
        })}
      </div>

      <div className="cap-foot">
        <span className="cap-foot-note">
          {notice ??
            (snapshotError !== null
              ? t("capsule.agents.staleNote")
              : t("capsule.agents.localNote"))}
        </span>
        <div className="cap-actions">
          {/* 行动中心入口：只导航，不在胶囊里加载/轮询第二份聚合 feed。
              用户在设置里关闭行动中心时隐藏，避免死入口。 */}
          {actionsEnabled ? (
            <button type="button" className="cap-link" onClick={() => openFullApp("actions")}>
              {t("capsule.agents.actionsEntry")}
              <ChevronRight size={12} strokeWidth={2.2} aria-hidden="true" />
            </button>
          ) : null}
          <button type="button" className="cap-link" onClick={() => openFullApp("agents")}>
            {t("capsule.agents.openFullShort")}
            <ChevronRight size={12} strokeWidth={2.2} aria-hidden="true" />
          </button>
        </div>
      </div>
    </>
  );
}
