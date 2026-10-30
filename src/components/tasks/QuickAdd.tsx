//! 快速录入：中文自然语言解析 + 创建前确认。
//! 创建统一走 useTasksStore.quickCreate（同步列表、统计与当前视图），
//! 解析/创建期间禁用重复提交并提供错误反馈。

import { useEffect, useRef, useState } from "react";
import { Sparkles, X, Loader2 } from "lucide-react";
import { parseQuickAdd, type ParsedInput } from "../../lib/bridge";
import { useUiStore } from "../../store/useUiStore";
import { useTasksStore } from "../../store/useTasksStore";
import { describeRecurrence, fromLocalInputValue, toLocalInputValue } from "../../lib/format";
import { DateTimePicker } from "../ui";

interface Props {
  compact?: boolean;
}

export default function QuickAdd({ compact }: Props) {
  const [text, setText] = useState("");
  const [parsed, setParsed] = useState<ParsedInput | null>(null);
  const [dueInput, setDueInput] = useState("");
  const [error, setError] = useState("");
  const [parsing, setParsing] = useState(false);
  const [creating, setCreating] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const quickAddToken = useUiStore((s) => s.quickAddToken);
  const showToast = useUiStore((s) => s.showToast);
  const quickCreate = useTasksStore((s) => s.quickCreate);

  useEffect(() => {
    if (quickAddToken > 0) inputRef.current?.focus();
  }, [quickAddToken]);

  async function onParse() {
    const value = text.trim();
    if (!value || parsing) return;
    setParsing(true);
    setError("");
    try {
      const p = await parseQuickAdd(value);
      setParsed(p);
      setDueInput(toLocalInputValue(p.due_at));
    } catch (e) {
      setError(String(e));
    } finally {
      setParsing(false);
    }
  }

  async function onCreate() {
    if (!parsed || creating) return;
    setCreating(true);
    setError("");
    try {
      const task = await quickCreate(
        parsed.title,
        fromLocalInputValue(dueInput),
        parsed.recurrence,
        parsed.advance_minutes,
      );
      setText("");
      setParsed(null);
      setDueInput("");
      showToast(`已创建「${task.title}」`, { kind: "success" });
      inputRef.current?.focus();
    } catch (e) {
      showToast(`创建失败：${String(e)}`, { kind: "error" });
    } finally {
      setCreating(false);
    }
  }

  function onCancel() {
    setParsed(null);
    setDueInput("");
    setError("");
  }

  const busy = parsing || creating;

  return (
    <div className={`quick-add ${compact ? "compact" : ""}`}>
      <div className="quick-add-row">
        <Sparkles size={14} className="quick-add-icon" />
        <input
          ref={inputRef}
          className="quick-add-input"
          placeholder="快速添加：明天下午三点开会 / 每周一早上九点提交周报"
          value={text}
          disabled={creating}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (parsed) onCreate();
              else onParse();
            }
            if (e.key === "Escape") {
              e.stopPropagation();
              onCancel();
            }
          }}
        />
        {busy && <Loader2 size={12} className="spin quick-add-spinner" />}
        <button
          className="btn primary sm quick-add-btn"
          onClick={parsed ? onCreate : onParse}
          disabled={!text.trim() || busy}
        >
          {parsed ? (creating ? "创建中…" : "创建") : parsing ? "解析中…" : "解析"}
        </button>
      </div>

      {parsed && (
        <div className="quick-add-preview">
          <div className="preview-line">
            <strong>{parsed.title}</strong>
            <button className="icon-btn sm" onClick={onCancel} data-tip="取消" aria-label="取消">
              <X size={12} />
            </button>
          </div>
          <div className="preview-meta">
            <label>
              时间
              <DateTimePicker
                size="sm"
                ariaLabel="时间"
                value={dueInput}
                disabled={creating}
                onChange={setDueInput}
              />
            </label>
            {parsed.recurrence && (
              <span className="chip">重复：{describeRecurrence(parsed.recurrence)}</span>
            )}
            {parsed.advance_minutes ? (
              <span className="chip">提前 {parsed.advance_minutes} 分钟</span>
            ) : null}
          </div>
          {!parsed.has_explicit_time && (
            <div className="preview-hint">
              {parsed.due_at
                ? "仅识别到日期，已默认 09:00，请确认或修改"
                : "未识别到时间，请手动设置（不会静默猜测）"}
            </div>
          )}
          {parsed.matched.length > 0 && (
            <div className="preview-matched">已识别：{parsed.matched.join(" · ")}</div>
          )}
        </div>
      )}
      {error && <div className="preview-hint error">{error}</div>}
    </div>
  );
}
