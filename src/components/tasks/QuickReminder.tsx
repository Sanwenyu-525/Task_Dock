//! 快速提醒：任务页轻量快捷入口（智能日程提醒 2.0）。
//!
//! - 预设 5/10/15/30 分钟、1 小时一键创建；自定义时/分严格校验（1~1440 分钟）；
//! - 数据复用现有 tasks + task_reminders（remind_at = 绝对时间，秒级由调度器负责，
//!   剩余时间只在展示层换算）；
//! - 与自然语言快速录入（QuickAdd）并存，互不替代。

import { useState } from "react";
import { BellRing, ChevronDown, Loader2 } from "lucide-react";
import { useUiStore } from "../../store/useUiStore";
import { useTasksStore } from "../../store/useTasksStore";
import { formatDue } from "../../lib/format";
import { NumberInput } from "../ui";
import { useLocale } from "../../hooks/useLocale";
import useImeComposition from "../../hooks/useImeComposition";
import { localizedErrorMessage } from "../../i18n/errors";

/** 预设分钟数；文案在渲染时本地化（1 小时仍按分钟存储）。 */
const PRESET_MINUTES = [5, 10, 15, 30, 60];

/** 自定义上限：24 小时（与后端 snooze 钳制一致）。 */
const MAX_MINUTES = 24 * 60;

export default function QuickReminder() {
  const { t } = useLocale();
  // 默认收起：快捷提醒不是每次打开任务页都需要的操作，收起后把高度还给任务列表；
  // 展开后所有预设/自定义能力与语义保持不变（仅视觉收纳，不改创建逻辑）。
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [customOpen, setCustomOpen] = useState(false);
  const [hours, setHours] = useState(0);
  const [minutes, setMinutes] = useState(10);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const ime = useImeComposition();
  const showToast = useUiStore((s) => s.showToast);
  const create = useTasksStore((s) => s.create);

  async function start(minutesFromNow: number) {
    if (creating) return;
    if (!Number.isFinite(minutesFromNow) || minutesFromNow < 1 || minutesFromNow > MAX_MINUTES) {
      setError(t("quickReminder.errorRange"));
      return;
    }
    setCreating(true);
    setError("");
    try {
      const remindAt = new Date(Date.now() + minutesFromNow * 60_000).toISOString();
      const task = await create({
        title: title.trim() || t("quickReminder.defaultTitle"),
        remind_at: remindAt,
      });
      showToast(
        t("quickReminder.created", {
          title: task.title,
          time: formatDue(task.remind_at),
        }),
        { kind: "success" },
      );
      setTitle("");
      setCustomOpen(false);
    } catch (e) {
      setError(localizedErrorMessage(e));
    } finally {
      setCreating(false);
    }
  }

  function onStartCustom() {
    const h = Math.round(hours);
    const m = Math.round(minutes);
    if (!(h >= 0 && h <= 23) || !(m >= 0 && m <= 59)) {
      setError(t("quickReminder.errorCustom"));
      return;
    }
    const total = h * 60 + m;
    if (total < 1) {
      setError(t("quickReminder.errorMin"));
      return;
    }
    void start(total);
  }

  return (
    <div className={`quick-reminder ${open ? "is-open" : "is-collapsed"}`}>
      <button
        type="button"
        className="quick-reminder-toggle"
        aria-expanded={open}
        aria-label={open ? t("quickReminder.collapse") : t("quickReminder.expand")}
        onClick={() => setOpen((v) => !v)}
      >
        <BellRing size={13} />
        <span>{t("quickReminder.collapsed")}</span>
        <span className="quick-reminder-hint">{t("quickReminder.hint")}</span>
        <ChevronDown size={12} className="quick-reminder-chevron" />
      </button>
      {open && (
        <div className="quick-reminder-body">
      <div className="quick-add-row">
        <BellRing size={14} className="quick-add-icon" />
        <input
          className="quick-add-input input-embedded"
          placeholder={t("quickReminder.placeholder")}
          aria-label={t("quickReminder.placeholder")}
          value={title}
          disabled={creating}
          maxLength={200}
          onChange={(e) => setTitle(e.target.value)}
          onCompositionStart={ime.onCompositionStart}
          onCompositionEnd={ime.onCompositionEnd}
          onKeyDown={(e) => {
            // 输入法确认候选的那次 Enter 不创建提醒，避免候选词未确认就误创建
            if (ime.isComposing(e)) return;
            if (e.key === "Enter") {
              e.preventDefault();
              void start(10);
            }
          }}
        />
        {creating && <Loader2 size={12} className="spin quick-add-spinner" />}
      </div>
      <div className="quick-reminder-presets">
        {PRESET_MINUTES.map((minutes) => (
          <button
            key={minutes}
            className="seg-btn sm"
            disabled={creating}
            onClick={() => void start(minutes)}
          >
            {minutes >= 60
              ? t("format.hours", { n: minutes / 60 })
              : t("format.minutes", { n: minutes })}
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
          {t("quickReminder.custom")}
        </button>
      </div>
      {customOpen && (
        <div className="quick-reminder-custom">
          <NumberInput
            size="sm"
            min={0}
            max={23}
            value={hours}
            ariaLabel={t("quickReminder.customHoursAria")}
            onChange={setHours}
          />
          <span className="endpoint-hint">{t("quickReminder.hoursUnit")}</span>
          <NumberInput
            size="sm"
            min={0}
            max={59}
            value={minutes}
            ariaLabel={t("quickReminder.customMinutesAria")}
            onChange={setMinutes}
          />
          <span className="endpoint-hint">{t("quickReminder.minutesUnit")}</span>
          <button className="btn primary sm" onClick={onStartCustom} disabled={creating}>
            {creating ? t("quickReminder.creating") : t("quickReminder.start")}
          </button>
        </div>
      )}
      {error && <div className="preview-hint error">{error}</div>}
        </div>
      )}
    </div>
  );
}
