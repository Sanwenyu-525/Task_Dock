//! 快速提醒：任务页轻量快捷入口（智能日程提醒 2.0）。
//!
//! - 预设 5/10/15/30 分钟、1 小时一键创建；自定义时/分严格校验（1~1440 分钟）；
//! - 数据复用现有 tasks + task_reminders（remind_at = 绝对时间，秒级由调度器负责，
//!   剩余时间只在展示层换算）；
//! - 与自然语言快速录入（QuickAdd）并存，互不替代。

import { useState } from "react";
import { BellRing, Loader2 } from "lucide-react";
import { useUiStore } from "../../store/useUiStore";
import { useTasksStore } from "../../store/useTasksStore";
import { formatDue } from "../../lib/format";
import { NumberInput } from "../ui";

const PRESETS: { minutes: number; label: string }[] = [
  { minutes: 5, label: "5 分钟" },
  { minutes: 10, label: "10 分钟" },
  { minutes: 15, label: "15 分钟" },
  { minutes: 30, label: "30 分钟" },
  { minutes: 60, label: "1 小时" },
];

/** 自定义上限：24 小时（与后端 snooze 钳制一致）。 */
const MAX_MINUTES = 24 * 60;

export default function QuickReminder() {
  const [title, setTitle] = useState("");
  const [customOpen, setCustomOpen] = useState(false);
  const [hours, setHours] = useState(0);
  const [minutes, setMinutes] = useState(10);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const showToast = useUiStore((s) => s.showToast);
  const create = useTasksStore((s) => s.create);

  async function start(minutesFromNow: number) {
    if (creating) return;
    if (!Number.isFinite(minutesFromNow) || minutesFromNow < 1 || minutesFromNow > MAX_MINUTES) {
      setError("提醒时长需在 1 分钟到 24 小时之间");
      return;
    }
    setCreating(true);
    setError("");
    try {
      const remindAt = new Date(Date.now() + minutesFromNow * 60_000).toISOString();
      const task = await create({
        title: title.trim() || "快速提醒",
        remind_at: remindAt,
      });
      showToast(
        `已创建提醒「${task.title}」，预计 ${formatDue(task.remind_at)} 提醒`,
        { kind: "success" },
      );
      setTitle("");
      setCustomOpen(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setCreating(false);
    }
  }

  function onStartCustom() {
    const h = Math.round(hours);
    const m = Math.round(minutes);
    if (!(h >= 0 && h <= 23) || !(m >= 0 && m <= 59)) {
      setError("自定义时长：小时 0-23、分钟 0-59");
      return;
    }
    const total = h * 60 + m;
    if (total < 1) {
      setError("至少 1 分钟后提醒");
      return;
    }
    void start(total);
  }

  return (
    <div className="quick-reminder">
      <div className="quick-add-row">
        <BellRing size={14} className="quick-add-icon" />
        <input
          className="quick-add-input input-embedded"
          placeholder="快速提醒：输入内容后选时长（如「休息一下」+ 10 分钟）"
          value={title}
          disabled={creating}
          maxLength={200}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void start(10);
            }
          }}
        />
        {creating && <Loader2 size={12} className="spin quick-add-spinner" />}
      </div>
      <div className="quick-reminder-presets">
        {PRESETS.map((p) => (
          <button
            key={p.minutes}
            className="seg-btn sm"
            disabled={creating}
            onClick={() => void start(p.minutes)}
          >
            {p.label}
          </button>
        ))}
        <button
          className={`seg-btn sm ${customOpen ? "active" : ""}`}
          aria-expanded={customOpen}
          disabled={creating}
          onClick={() => {
            setCustomOpen((v) => !v);
            setError("");
          }}
        >
          自定义…
        </button>
      </div>
      {customOpen && (
        <div className="quick-reminder-custom">
          <NumberInput
            size="sm"
            min={0}
            max={23}
            value={hours}
            ariaLabel="自定义小时"
            onChange={setHours}
          />
          <span className="endpoint-hint">时</span>
          <NumberInput
            size="sm"
            min={0}
            max={59}
            value={minutes}
            ariaLabel="自定义分钟"
            onChange={setMinutes}
          />
          <span className="endpoint-hint">分后提醒</span>
          <button className="btn primary sm" onClick={onStartCustom} disabled={creating}>
            {creating ? "创建中…" : "开始"}
          </button>
        </div>
      )}
      {error && <div className="preview-hint error">{error}</div>}
    </div>
  );
}
