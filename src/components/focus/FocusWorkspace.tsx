//! 专注与休息工作台：倒计时、会话控制、任务关联、今日统计、历史与偏好。
//!
//! 展示层只消费 store 快照 + 共享 1 秒时钟；不在组件里创建任何定时器。

import { useEffect, useState } from "react";
import {
  Coffee,
  History,
  Pause,
  Play,
  Plus,
  Settings2,
  SkipForward,
  Square,
  Timer,
  Trash2,
} from "lucide-react";

import { listTasks, type Task } from "../../lib/bridge";
import { useSharedClock } from "../../lib/sharedClock";
import { useLocale } from "../../hooks/useLocale";
import { formatLocalizedTime } from "../../i18n/format";
import type { MessageKey, MessageParams } from "../../i18n";
import {
  SESSION_KIND_KEYS,
  SESSION_STATE_KEYS,
  acquireFocusEvents,
  formatRemaining,
  remainingFromSnapshot,
  useFocusStore,
  type FocusHistoryItem,
  type FocusPrefs,
  type FocusSessionView,
} from "../../store/useFocusStore";
import NumberInput from "../ui/NumberInput";
import Select from "../ui/Select";
import { Switch } from "../ui/Toggle";
import "./focus.css";

type Translate = (key: MessageKey, params?: MessageParams) => string;

function minutesText(ms: number, t: Translate): string {
  if (ms <= 0) return t("focus.duration.minutes", { n: 0, count: 0 });
  const minutes = Math.floor(ms / 60_000);
  if (minutes === 0) return t("focus.duration.lessThanMinute");
  return t("focus.duration.minutes", { n: minutes, count: minutes });
}

function clockText(iso: string | null): string {
  if (!iso) return "";
  // 非法输入由 formatLocalizedTime 统一返回空串（与旧行为一致）。
  return formatLocalizedTime(iso);
}

function pauseReasonText(active: FocusSessionView, t: Translate): string | null {
  if (active.state !== "paused") return null;
  if (active.pause_reason === "app_restart") {
    return t("focus.pauseReason.appRestart");
  }
  if (active.pause_reason === "unconfirmed_gap") {
    return t("focus.pauseReason.unconfirmedGap");
  }
  return t("focus.pauseReason.paused");
}

function phaseText(active: FocusSessionView | null, t: Translate): string {
  if (!active) return t("focus.phase.preparing");
  if (active.state === "paused") {
    return t("focus.phase.paused", { kind: t(SESSION_KIND_KEYS[active.kind]) });
  }
  if (active.kind === "short_break") return t("focus.phase.shortBreak");
  if (active.kind === "long_break") return t("focus.phase.longBreak");
  return t("focus.phase.focusing");
}

function historyLine(item: FocusHistoryItem, t: Translate): string {
  const task = item.task_title || t("focus.noTask");
  const suffix = item.task_deleted ? t("focus.taskDeleted") : "";
  return [
    t(SESSION_KIND_KEYS[item.kind]),
    t(SESSION_STATE_KEYS[item.state]),
    minutesText(item.accumulated_ms, t),
    `${task}${suffix}`,
  ].join(" · ");
}

export default function FocusWorkspace() {
  const snapshot = useFocusStore((s) => s.snapshot);
  const snapshotAt = useFocusStore((s) => s.snapshotAt);
  const history = useFocusStore((s) => s.history);
  const loading = useFocusStore((s) => s.loading);
  const error = useFocusStore((s) => s.error);
  const busyAction = useFocusStore((s) => s.busyAction);
  const load = useFocusStore((s) => s.load);
  const start = useFocusStore((s) => s.start);
  const pause = useFocusStore((s) => s.pause);
  const resume = useFocusStore((s) => s.resume);
  const finish = useFocusStore((s) => s.finish);
  const cancel = useFocusStore((s) => s.cancel);
  const startBreak = useFocusStore((s) => s.startBreak);
  const extendBreak = useFocusStore((s) => s.extendBreak);
  const skipBreak = useFocusStore((s) => s.skipBreak);
  const updatePrefs = useFocusStore((s) => s.updatePrefs);
  const snoozeSedentary = useFocusStore((s) => s.snoozeSedentary);

  const now = useSharedClock();
  const { t } = useLocale();
  const snapshotPrefs = snapshot?.prefs ?? null;
  const [selectedTask, setSelectedTask] = useState<string | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [taskError, setTaskError] = useState<string | null>(null);
  const [showPrefs, setShowPrefs] = useState(false);
  const [draft, setDraft] = useState<FocusPrefs | null>(null);

  useEffect(() => {
    void load();
    let disposed = false;
    let release: (() => void) | null = null;
    void acquireFocusEvents().then((off) => {
      if (disposed) off();
      else release = off;
    });
    return () => {
      disposed = true;
      release?.();
    };
  }, [load]);

  useEffect(() => {
    let alive = true;
    listTasks({ view: "all", status: "pending", sort: "priority", limit: 40 })
      .then((rows) => {
        if (alive) {
          setTasks(rows);
          setTaskError(null);
        }
      })
      .catch((raw) => {
        if (alive) {
          setTasks([]);
          setTaskError(String(raw));
        }
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!snapshotPrefs) return;
    // 面板打开期间保留用户未保存的草稿：后台事件刷新快照时不能把正在编辑的值冲掉。
    // 面板关闭（或首次加载）时再与后端偏好对齐。
    setDraft((prev) => (showPrefs && prev ? prev : snapshotPrefs));
  }, [snapshotPrefs, showPrefs]);

  const active = snapshot?.active ?? null;
  const prefs = snapshotPrefs;
  const remaining = remainingFromSnapshot(active, snapshotAt, now);
  const plannedMs = active ? active.planned_seconds * 1000 : 0;
  const progress =
    active && plannedMs > 0
      ? Math.min(100, Math.max(0, ((plannedMs - (remaining ?? 0)) / plannedMs) * 100))
      : 0;
  const reason = active ? pauseReasonText(active, t) : null;
  const isBreak = !!active && active.kind !== "focus";
  const isRunning = !!active && (active.state === "focusing" || active.state === "break");
  const isPaused = active?.state === "paused";

  const taskOptions = [
    { value: "", label: t("focus.noLinkTask") },
    ...tasks.map((task) => ({
      value: task.id,
      label: task.title,
      hint: task.category || undefined,
    })),
  ];

  function savePrefs() {
    if (!draft) return;
    void updatePrefs(draft);
  }

  return (
    <section
      className={`focus-workspace ${isBreak ? "is-break" : ""}`}
      aria-label={t("focus.title")}
    >
      <header className="focus-head">
        <span className="focus-head-icon" aria-hidden="true">
          <Timer size={16} />
        </span>
        <div className="focus-head-text">
          <h3>{t("focus.title")}</h3>
          <p>{t("focus.subtitle")}</p>
        </div>
        <button
          type="button"
          className="btn sm"
          onClick={() => setShowPrefs((v) => !v)}
          aria-expanded={showPrefs}
        >
          <Settings2 size={13} aria-hidden="true" />
          {t("focus.settings")}
        </button>
      </header>

      {error ? (
        <div className="focus-error" role="alert">
          {error}
        </div>
      ) : null}
      {taskError ? (
        <div className="focus-hint" role="status">
          {t("focus.error.taskList")}
        </div>
      ) : null}

      <div className="focus-timer-card">
        <div className="focus-phase">
          <span className={`focus-state-dot ${isRunning ? "is-running" : isPaused ? "is-paused" : ""}`} />
          {phaseText(active, t)}
        </div>
        <div className="focus-countdown" aria-live="off">
          {formatRemaining(remaining)}
        </div>
        <div className="focus-progress" role="presentation">
          <span className="focus-progress-fill" style={{ width: `${progress}%` }} />
        </div>

        <div className="focus-current-task">
          {active ? (
            <>
              <span className="focus-current-label">
                {isBreak ? t("focus.currentBreak") : t("focus.currentTask")}
              </span>
              <span className="focus-current-title" data-tip={active.task_title || undefined}>
                {isBreak
                  ? t(SESSION_KIND_KEYS[active.kind])
                  : active.task_title || t("focus.noTask")}
                {active.task_deleted ? t("focus.taskDeleted") : ""}
              </span>
            </>
          ) : (
            // 该槽位在缺少专用键前复用 Select 的占位文案（语义同为「选择任务」）。
            <span className="focus-current-label">{t("focus.selectTask")}</span>
          )}
        </div>

        {reason ? <div className="focus-pause-reason">{reason}</div> : null}

        {!active ? (
          <div className="focus-task-picker">
            <Select
              value={selectedTask ?? ""}
              options={taskOptions}
              onChange={(value) => setSelectedTask(value || null)}
              placeholder={t("focus.selectTask")}
              ariaLabel={t("focus.selectTaskAria")}
              size="sm"
              block
            />
          </div>
        ) : null}

        <div className="focus-actions">
          {!active ? (
            <>
              <button
                type="button"
                className="btn primary"
                disabled={!!busyAction || loading}
                onClick={() => void start(selectedTask)}
              >
                <Play size={14} aria-hidden="true" />
                {t("focus.start")}
              </button>
              <button
                type="button"
                className="btn"
                disabled={!!busyAction}
                onClick={() => void startBreak()}
              >
                <Coffee size={14} aria-hidden="true" />
                {t("focus.startBreak")}
              </button>
            </>
          ) : null}

          {isRunning ? (
            <>
              <button
                type="button"
                className="btn"
                disabled={!!busyAction}
                onClick={() => void pause()}
              >
                <Pause size={14} aria-hidden="true" />
                {t("focus.pause")}
              </button>
              <button
                type="button"
                className="btn"
                disabled={!!busyAction}
                onClick={() => void finish()}
              >
                <Square size={13} aria-hidden="true" />
                {isBreak ? t("focus.finishBreak") : t("focus.finishFocus")}
              </button>
            </>
          ) : null}

          {isPaused ? (
            <>
              <button
                type="button"
                className="btn primary"
                disabled={!!busyAction}
                onClick={() => void resume()}
              >
                <Play size={14} aria-hidden="true" />
                {t("focus.resume")}
              </button>
              <button
                type="button"
                className="btn"
                disabled={!!busyAction}
                onClick={() => void finish()}
              >
                <Square size={13} aria-hidden="true" />
                {t("focus.finish")}
              </button>
            </>
          ) : null}

          {isBreak ? (
            <>
              <button
                type="button"
                className="btn"
                disabled={!!busyAction}
                onClick={() => void extendBreak(5)}
              >
                <Plus size={13} aria-hidden="true" />
                {t("focus.extendBreak")}
              </button>
              <button
                type="button"
                className="btn"
                disabled={!!busyAction}
                onClick={() => void skipBreak()}
              >
                <SkipForward size={13} aria-hidden="true" />
                {t("focus.skipBreak")}
              </button>
            </>
          ) : null}

          {active ? (
            <button
              type="button"
              className="btn danger"
              disabled={!!busyAction}
              onClick={() => void cancel()}
              aria-label={t("focus.abandonAria")}
            >
              <Trash2 size={13} aria-hidden="true" />
              {t("focus.abandon")}
            </button>
          ) : null}
        </div>
      </div>

      <div className="focus-stats">
        <div className="focus-stat">
          <span className="focus-stat-label">{t("focus.stats.today")}</span>
          <strong>{minutesText(snapshot?.today.focus_ms ?? 0, t)}</strong>
        </div>
        <div className="focus-stat">
          <span className="focus-stat-label">{t("focus.stats.rounds")}</span>
          <strong>{snapshot?.today.completed_focus ?? 0}</strong>
        </div>
        <div className="focus-stat">
          <span className="focus-stat-label">{t("focus.stats.longBreak")}</span>
          <strong>
            {snapshot?.rounds_since_long ?? 0}/{prefs?.long_break_every ?? 4}
          </strong>
        </div>
      </div>

      {showPrefs && draft && prefs ? (
        <div className="focus-prefs">
          <div className="focus-prefs-grid">
            <label>
              <span>{t("focus.prefs.focusMinutes")}</span>
              <NumberInput
                value={draft.focus_minutes}
                onChange={(v) => setDraft({ ...draft, focus_minutes: v })}
                min={5}
                max={180}
                ariaLabel={t("focus.prefs.focusMinutesAria")}
              />
            </label>
            <label>
              <span>{t("focus.prefs.shortBreakMinutes")}</span>
              <NumberInput
                value={draft.short_break_minutes}
                onChange={(v) => setDraft({ ...draft, short_break_minutes: v })}
                min={1}
                max={60}
                ariaLabel={t("focus.prefs.shortBreakAria")}
              />
            </label>
            <label>
              <span>{t("focus.prefs.longBreakMinutes")}</span>
              <NumberInput
                value={draft.long_break_minutes}
                onChange={(v) => setDraft({ ...draft, long_break_minutes: v })}
                min={5}
                max={240}
                ariaLabel={t("focus.prefs.longBreakAria")}
              />
            </label>
            <label>
              <span>{t("focus.prefs.longBreakEvery")}</span>
              <NumberInput
                value={draft.long_break_every}
                onChange={(v) => setDraft({ ...draft, long_break_every: v })}
                min={2}
                max={12}
                ariaLabel={t("focus.prefs.longBreakEveryAria")}
              />
            </label>
          </div>

          <div className="focus-toggles">
            <Switch
              checked={draft.auto_start_break}
              onChange={(v) => setDraft({ ...draft, auto_start_break: v })}
              label={t("focus.prefs.autoStartBreak")}
            />
            <Switch
              checked={draft.auto_start_next}
              onChange={(v) => setDraft({ ...draft, auto_start_next: v })}
              label={t("focus.prefs.autoStartNext")}
            />
          </div>

          <div className="focus-sedentary">
            <Switch
              checked={draft.sedentary_enabled}
              onChange={(v) => setDraft({ ...draft, sedentary_enabled: v })}
              label={t("focus.prefs.sedentary")}
            />
            <Select
              value={String(draft.sedentary_interval_minutes)}
              options={[
                { value: "45", label: t("focus.prefs.every45") },
                { value: "60", label: t("focus.prefs.every60") },
                { value: "90", label: t("focus.prefs.every90") },
              ]}
              onChange={(value) =>
                setDraft({ ...draft, sedentary_interval_minutes: Number(value) })
              }
              ariaLabel={t("focus.prefs.sedentaryInterval")}
              size="sm"
              disabled={!draft.sedentary_enabled}
            />
            {prefs.sedentary_enabled ? (
              <button
                type="button"
                className="btn sm"
                disabled={!!busyAction}
                onClick={() => void snoozeSedentary(30)}
              >
                {t("focus.prefs.snooze30")}
              </button>
            ) : null}
          </div>

          <div className="focus-prefs-actions">
            <button
              type="button"
              className="btn primary sm"
              disabled={!!busyAction}
              onClick={savePrefs}
            >
              {t("focus.prefs.save")}
            </button>
            <button
              type="button"
              className="btn sm"
              onClick={() => setDraft(prefs)}
            >
              {t("focus.prefs.restore")}
            </button>
          </div>
        </div>
      ) : null}

      <div className="focus-history">
        <div className="focus-history-head">
          <History size={14} aria-hidden="true" />
          <h4>{t("focus.history.title")}</h4>
        </div>
        {history.length === 0 ? (
          <p className="focus-empty">{t("focus.history.empty")}</p>
        ) : (
          <ul>
            {history.slice(0, 8).map((item) => (
              <li key={item.id} data-tip={historyLine(item, t)}>
                <span className={`focus-history-kind kind-${item.kind}`}>
                  {t(SESSION_KIND_KEYS[item.kind])}
                </span>
                <span className="focus-history-state">
                  {t(SESSION_STATE_KEYS[item.state])}
                </span>
                <span className="focus-history-duration">
                  {minutesText(item.accumulated_ms, t)}
                </span>
                <span className="focus-history-task">
                  {item.task_title || t("focus.noTask")}
                  {item.task_deleted ? t("focus.taskDeleted") : ""}
                </span>
                <span className="focus-history-time">{clockText(item.started_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
