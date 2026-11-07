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
import { useLocale } from "../../hooks/useLocale";
import useImeComposition from "../../hooks/useImeComposition";
import { localizedErrorMessage } from "../../i18n/errors";

interface Props {
  compact?: boolean;
}

export default function QuickAdd({ compact }: Props) {
  const { t } = useLocale();
  const [text, setText] = useState("");
  const [parsed, setParsed] = useState<ParsedInput | null>(null);
  /* 解析结果对应的输入原文：输入被改动后预览必须失效，否则「创建」会提交
     上一条解析结果并清空当前输入（验收 UI-02）。 */
  const [parsedSource, setParsedSource] = useState("");
  const [dueInput, setDueInput] = useState("");
  const [error, setError] = useState("");
  const [parsing, setParsing] = useState(false);
  const [creating, setCreating] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  /* 输入法组合期间不因中间文本让预览失效（Escape 只关候选的既有语义）；
     组合结束后按最终文本判定。isComposing 只接受键盘事件，故这里单独跟踪。 */
  const composingRef = useRef(false);
  const ime = useImeComposition();
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
      setParsedSource(value);
      setDueInput(toLocalInputValue(p.due_at));
    } catch (e) {
      setError(localizedErrorMessage(e));
    } finally {
      setParsing(false);
    }
  }

  async function onCreate() {
    if (!parsed || creating) return;
    // 双保险：即使有路径绕过 onChange 改写了输入，也绝不提交与输入不一致的旧解析结果。
    if (text.trim() !== parsedSource) {
      clearParsed();
      return;
    }
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
      setParsedSource("");
      setDueInput("");
      showToast(t("quickAdd.created", { title: task.title }), { kind: "success" });
      inputRef.current?.focus();
    } catch (e) {
      showToast(t("quickAdd.createFailed", { error: localizedErrorMessage(e) }), { kind: "error" });
    } finally {
      setCreating(false);
    }
  }

  function clearParsed() {
    setParsed(null);
    setParsedSource("");
    setDueInput("");
    setError("");
  }

  function onCancel() {
    clearParsed();
  }

  const busy = parsing || creating;

  return (
    <div className={`quick-add ${compact ? "compact" : ""}`}>
      <div className="quick-add-row">
        <Sparkles size={14} className="quick-add-icon" />
        <input
          ref={inputRef}
          className="quick-add-input input-embedded"
          placeholder={t("quickAdd.placeholder")}
          /* placeholder 在输入后消失，不能作为唯一可访问名（验收 UI-15）。 */
          aria-label={t("quickAdd.placeholder")}
          value={text}
          disabled={creating}
          onChange={(e) => {
            setText(e.target.value);
            // 输入一变，上一条解析结果立即失效：按钮回到「解析」，避免创建旧任务。
            // 输入法组合期间先保留预览（Escape 只关候选的既有语义），
            // 组合结束后再按最终文本判定。
            if (parsed && !composingRef.current) clearParsed();
          }}
          onCompositionStart={(e) => {
            composingRef.current = true;
            ime.onCompositionStart(e);
          }}
          onCompositionEnd={(e) => {
            composingRef.current = false;
            ime.onCompositionEnd(e);
            if (parsed && e.currentTarget.value.trim() !== parsedSource) clearParsed();
          }}
          onKeyDown={(e) => {
            // 输入法组合中：Enter 用于确认候选、Escape 用于关闭候选，
            // 都不能触发解析/创建或取消预览，也不能 preventDefault 打断 IME。
            if (ime.isComposing(e)) {
              if (e.key === "Escape") e.stopPropagation();
              return;
            }
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
          {parsed
            ? creating
              ? t("quickAdd.creating")
              : t("quickAdd.create")
            : parsing
              ? t("quickAdd.parsing")
              : t("quickAdd.parse")}
        </button>
      </div>

      {parsed && (
        <div className="quick-add-preview">
          <div className="preview-line">
            <strong>{parsed.title}</strong>
            <button
              className="icon-btn sm"
              onClick={onCancel}
              data-tip={t("common.cancel")}
              aria-label={t("common.cancel")}
            >
              <X size={12} />
            </button>
          </div>
          <div className="preview-meta">
            <label>
              {t("quickAdd.time")}
              <DateTimePicker
                size="sm"
                ariaLabel={t("quickAdd.time")}
                value={dueInput}
                disabled={creating}
                onChange={setDueInput}
              />
            </label>
            {parsed.recurrence && (
              <span className="chip">
                {t("quickAdd.recurrence", { value: describeRecurrence(parsed.recurrence) })}
              </span>
            )}
            {parsed.advance_minutes ? (
              <span className="chip">
                {t("quickAdd.advance", { minutes: parsed.advance_minutes })}
              </span>
            ) : null}
          </div>
          {!parsed.has_explicit_time && (
            <div className="preview-hint">
              {parsed.due_at
                ? t("quickAdd.dateOnlyHint")
                : t("quickAdd.noTimeHint")}
            </div>
          )}
          {parsed.matched.length > 0 && (
            <div className="preview-matched">
              {t("quickAdd.recognized", { items: parsed.matched.join(" · ") })}
            </div>
          )}
        </div>
      )}
      {error && <div className="preview-hint error">{error}</div>}
    </div>
  );
}
