//! 句式命令分组：全局搜索弹窗内的确定性短语层。
//!
//! - 独立于命令面板（commandRegistry 禁止数据写入）：本组件只消费后端解析结果，
//!   写意图必须两段式 Enter/点击确认，且确认时展示将发生的差异。
//! - flat 键盘序固定在最前（0..n-1），与数据结果、命令组共用同一 activeIndex。
//! - 查询结果条目可跳转（任务定位 / Agent 会话聚焦），不在前端做二次写作。

import { memo, useEffect, useRef, type RefObject } from "react";
import {
  Bot,
  CalendarClock,
  CheckCircle2,
  CircleAlert,
  Wand2,
} from "lucide-react";

import { useLocale } from "../../hooks/useLocale";
import { formatDue, formatRelative } from "../../lib/format";
import { priorityLabelKey } from "../../lib/commandPhrases";
import type {
  PhraseQuery,
  PhraseResolution,
  PhraseTaskCandidate,
} from "../../lib/bridge";

type PhraseWriteResolution = Exclude<PhraseResolution, { kind: "query" }>;

interface PhraseProps {
  phrase: PhraseResolution;
  /** 全局 flat 选中序号（句式区固定占据 0..n-1）。 */
  activeIndex: number;
  /** 已武装（第一次 Enter）的候选任务 id。 */
  armedId: string | null;
  /** 写意图执行在途：禁用交互并标记 aria-busy。 */
  executing: boolean;
  onActivate: (flatIndex: number) => void;
  onHoverIndex: (flatIndex: number) => void;
}

function actionKey(kind: PhraseWriteResolution["kind"]) {
  if (kind === "complete") return "commandPhrases.action.complete" as const;
  if (kind === "reschedule") return "commandPhrases.action.reschedule" as const;
  return "commandPhrases.action.priority" as const;
}

export const GlobalSearchPhrase = memo(function GlobalSearchPhrase({
  phrase,
  activeIndex,
  armedId,
  executing,
  onActivate,
  onHoverIndex,
}: PhraseProps) {
  const { t } = useLocale();
  const activeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (activeIndex >= 0) activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, phrase]);

  return (
    <section
      className="gs-phrase"
      role="listbox"
      aria-label={t("commandPhrases.section")}
      aria-busy={executing || undefined}
    >
      <header className="gs-group-head gs-phrase-head">
        <span className="gs-cmd-head-label">
          <Wand2 size={12} strokeWidth={2} aria-hidden="true" />
          {t("commandPhrases.section")}
        </span>
        {phrase.kind === "query" ? (
          <span className="gs-phrase-summary">{querySummary(phrase, t)}</span>
        ) : (
          <span className="gs-phrase-summary">
            {t(actionKey(phrase.kind))}
            {phrase.candidates.length > 1
              ? ` · ${t("commandPhrases.writeSummary", { count: phrase.candidates.length })}`
              : ""}
          </span>
        )}
      </header>

      {phrase.kind === "query" ? (
        <QueryRows
          phrase={phrase}
          activeIndex={activeIndex}
          activeRef={activeRef}
          onActivate={onActivate}
          onHoverIndex={onHoverIndex}
        />
      ) : (
        <WriteRows
          phrase={phrase}
          activeIndex={activeIndex}
          armedId={armedId}
          executing={executing}
          activeRef={activeRef}
          onActivate={onActivate}
          onHoverIndex={onHoverIndex}
        />
      )}
    </section>
  );
});

function querySummary(phrase: PhraseQuery, t: ReturnType<typeof useLocale>["t"]): string {
  const count = phrase.items.length;
  if (phrase.query === "weekCompleted" && phrase.summary) {
    return t("commandPhrases.query.week", {
      completed: phrase.summary.completed,
      overdue: phrase.summary.overdue,
      due: phrase.summary.due,
    });
  }
  if (phrase.query === "overdue") return t("commandPhrases.query.overdue", { count });
  if (phrase.query === "today") return t("commandPhrases.query.today", { count });
  return t("commandPhrases.query.agentFailures", { count });
}

interface RowsProps {
  activeIndex: number;
  activeRef: RefObject<HTMLButtonElement | null>;
  onActivate: (flatIndex: number) => void;
  onHoverIndex: (flatIndex: number) => void;
}

function QueryRows({
  phrase,
  activeIndex,
  activeRef,
  onActivate,
  onHoverIndex,
}: RowsProps & { phrase: PhraseQuery }) {
  const { t } = useLocale();
  if (phrase.items.length === 0) {
    return <div className="gs-phrase-empty">{t("commandPhrases.query.empty")}</div>;
  }
  const Icon =
    phrase.query === "weekCompleted"
      ? CheckCircle2
      : phrase.query === "overdue"
        ? CircleAlert
        : phrase.query === "today"
          ? CalendarClock
          : Bot;
  return (
    <>
      {phrase.items.map((item, i) => {
        const active = i === activeIndex;
        const meta =
          item.kind === "agent"
            ? [item.sourceName || "Agent", item.occurredAt ? formatRelative(item.occurredAt) : ""]
                .filter(Boolean)
                .join(" · ")
            : formatDue(item.dueAt ?? item.occurredAt);
        return (
          <button
            key={`${item.kind}-${item.id}`}
            type="button"
            role="option"
            aria-selected={active}
            className={`gs-item gs-phrase-row${active ? " active" : ""}`}
            data-gs-phrase-row={i}
            ref={active ? activeRef : undefined}
            onClick={() => onActivate(i)}
            onMouseEnter={() => onHoverIndex(i)}
          >
            <span className="gs-item-icon gs-cmd-icon" aria-hidden="true">
              <Icon size={15} strokeWidth={1.9} />
            </span>
            <span className="gs-item-main">
              <span className="gs-item-title">{item.title}</span>
              {meta ? (
                <span className="gs-item-sub">
                  <span className="gs-item-from">{meta}</span>
                </span>
              ) : null}
            </span>
          </button>
        );
      })}
    </>
  );
}

function WriteRows({
  phrase,
  activeIndex,
  armedId,
  executing,
  activeRef,
  onActivate,
  onHoverIndex,
}: RowsProps & {
  phrase: PhraseWriteResolution;
  armedId: string | null;
  executing: boolean;
}) {
  const { t } = useLocale();
  if (phrase.candidates.length === 0) {
    return (
      <div className="gs-phrase-empty">
        {t("commandPhrases.zeroCandidates", { target: phrase.target })}
      </div>
    );
  }
  return (
    <>
      {phrase.candidates.map((candidate, i) => {
        const active = i === activeIndex;
        const armed = candidate.id === armedId;
        return (
          <button
            key={candidate.id}
            type="button"
            role="option"
            aria-selected={active}
            aria-disabled={executing || undefined}
            className={`gs-item gs-phrase-row${active ? " active" : ""}${armed ? " armed" : ""}`}
            data-gs-phrase-row={i}
            data-gs-phrase-armed={armed ? "true" : undefined}
            ref={active ? activeRef : undefined}
            onClick={() => onActivate(i)}
            onMouseEnter={() => onHoverIndex(i)}
          >
            <span className="gs-item-icon gs-cmd-icon" aria-hidden="true">
              <Wand2 size={15} strokeWidth={1.9} />
            </span>
            <span className="gs-item-main">
              <span className="gs-item-title">{candidate.title}</span>
              {armed ? (
                <span className="gs-phrase-preview">
                  <span className="gs-phrase-diff">{writeDiff(phrase, candidate, t)}</span>
                  {phrase.kind === "reschedule" && phrase.dateOnly ? (
                    <span className="gs-phrase-note">{t("commandPhrases.diff.dateOnly")}</span>
                  ) : null}
                  <span className="gs-phrase-armed">{t("commandPhrases.armedHint")}</span>
                </span>
              ) : (
                <span className="gs-item-sub">
                  <span className="gs-item-from">{currentMeta(candidate, t)}</span>
                </span>
              )}
            </span>
          </button>
        );
      })}
    </>
  );
}

type T = ReturnType<typeof useLocale>["t"];

function currentMeta(candidate: PhraseTaskCandidate, t: T): string {
  return candidate.dueAt ? formatDue(candidate.dueAt) : t("commandPhrases.diff.noDue");
}

function writeDiff(
  phrase: PhraseWriteResolution,
  candidate: PhraseTaskCandidate,
  t: T,
): string {
  if (phrase.kind === "complete") return t("commandPhrases.diff.complete");
  if (phrase.kind === "reschedule") {
    return t("commandPhrases.diff.reschedule", {
      from: candidate.dueAt ? formatDue(candidate.dueAt) : t("commandPhrases.diff.noDue"),
      to: formatDue(phrase.dueAt),
    });
  }
  return t("commandPhrases.diff.priority", {
    from: t(priorityLabelKey(candidate.priority)),
    to: t(priorityLabelKey(phrase.priority)),
  });
}
