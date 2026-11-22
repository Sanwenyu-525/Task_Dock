//! 全局搜索弹窗：Ctrl+Shift+F 唤起的统一检索入口。
//!
//! - 常挂载组件：open=false 时仅保留快捷键监听，不渲染面板（输入不重挂弹窗）。
//! - 弹层接入 overlayStack（"dialog" 层）：Escape 只关最上层；焦点陷阱归还焦点。
//! - 键盘：↑/↓ 移动选中、Enter 打开、输入框 Ctrl+A/Ctrl+Backspace 走原生编辑语义。
//! - 命令层（v0.16）：命令分组固定置于数据结果之前（仅「全部」分类下展示），
//!   flat 选中序 = 命令组在前 + 数据结果在后；Enter 按序号分发到命令或数据结果。

import { useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { X, CircleX, Search, Clock, RotateCw, Wand2 } from "lucide-react";

import { useOverlayLayer, useFocusTrap } from "../ui/overlay";
import {
  GLOBAL_SEARCH_CATEGORIES,
  GLOBAL_SEARCH_CATEGORY_LABELS,
  type GlobalSearchCategoryFilter,
} from "../../lib/globalSearchBridge";
import { useGlobalSearchStore } from "../../store/useGlobalSearchStore";
import { useGlobalSearchShortcut } from "../../hooks/useGlobalSearchShortcut";
import useImeComposition from "../../hooks/useImeComposition";
import { useLocale } from "../../hooks/useLocale";
import {
  PHRASE_EXAMPLES,
  phraseHints,
  phraseRowCount,
} from "../../lib/commandPhrases";
import { GlobalSearchResults } from "./GlobalSearchResults";
import { GlobalSearchCommands } from "./GlobalSearchCommands";
import { GlobalSearchPhrase } from "./GlobalSearchPhrase";

export function GlobalSearchDialog() {
  const open = useGlobalSearchStore((s) => s.open);
  const query = useGlobalSearchStore((s) => s.query);
  const activeCategory = useGlobalSearchStore((s) => s.activeCategory);
  const results = useGlobalSearchStore((s) => s.results);
  const loading = useGlobalSearchStore((s) => s.loading);
  const error = useGlobalSearchStore((s) => s.error);
  const activeIndex = useGlobalSearchStore((s) => s.activeIndex);
  const recent = useGlobalSearchStore((s) => s.recent);
  const notice = useGlobalSearchStore((s) => s.notice);
  const commands = useGlobalSearchStore((s) => s.commands);
  const phrase = useGlobalSearchStore((s) => s.phrase);
  const phraseLoading = useGlobalSearchStore((s) => s.phraseLoading);
  const phraseArmed = useGlobalSearchStore((s) => s.phraseArmed);
  const phraseExecuting = useGlobalSearchStore((s) => s.phraseExecuting);

  const closeSearch = useGlobalSearchStore((s) => s.closeSearch);
  const setQuery = useGlobalSearchStore((s) => s.setQuery);
  const setActiveCategory = useGlobalSearchStore((s) => s.setActiveCategory);
  const retry = useGlobalSearchStore((s) => s.retry);
  const moveActive = useGlobalSearchStore((s) => s.moveActive);
  const setActiveIndex = useGlobalSearchStore((s) => s.setActiveIndex);
  const openResult = useGlobalSearchStore((s) => s.openResult);
  const executeCommand = useGlobalSearchStore((s) => s.executeCommand);
  const clearRecent = useGlobalSearchStore((s) => s.clearRecent);
  const setNotice = useGlobalSearchStore((s) => s.setNotice);
  const disarmPhrase = useGlobalSearchStore((s) => s.disarmPhrase);
  const activatePhraseRow = useGlobalSearchStore((s) => s.activatePhraseRow);

  // 应用内快捷键（Ctrl+Shift+F）：挂在常驻组件上，弹窗关闭时也可唤起。
  useGlobalSearchShortcut();

  const { t } = useLocale();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const ime = useImeComposition();
  // Escape 先取消二次确认（不关窗），没有再关弹窗：一次按键只做一件事。
  useOverlayLayer(
    "dialog",
    open,
    () => {
      if (!disarmPhrase()) closeSearch();
    },
    rootRef,
  );
  useFocusTrap(open, rootRef, { initial: inputRef });

  const flatItems = useMemo(
    () => results?.groups.flatMap((g) => g.items) ?? [],
    [results],
  );

  // flat 键盘序 = 句式区 → 命令组 → 数据结果（与 store.moveActive 同一顺序）。
  // 命令组只在「全部」分类下展示（选择了数据分类 = 明确的数据检索意图）。
  const phraseCount = phraseRowCount(phrase);
  const showCommands = activeCategory === "all" && commands.length > 0;
  const cmdOffset = phraseCount;
  const resultOffset = phraseCount + (showCommands ? commands.length : 0);

  // 帧表近似命中但未解析成功时的模板提示（例：少写空格/用词不在表内）。
  const hints = useMemo(
    () => (!phrase && !phraseLoading ? phraseHints(query) : []),
    [phrase, phraseLoading, query],
  );

  // 武装行与当前选中行一致时才是「再按 Enter 确认」；把鼠标移到别的候选
  // 后选中行已变化，此时 Enter 是重新预览该行，不应显示确认文案。
  const armedHere =
    phrase !== null &&
    phrase.kind !== "query" &&
    phraseArmed !== null &&
    phrase.candidates[activeIndex]?.id === phraseArmed;

  // 打开时聚焦输入框（焦点陷阱 initial 之外兜底）。
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  if (!open) return null;

  const onKeyDown = (e: React.KeyboardEvent) => {
    // 输入法组合中：方向键留给候选列表，Enter 只确认候选，不打开结果
    if (ime.isComposing(e)) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      moveActive(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      moveActive(-1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (activeIndex < phraseCount) {
        activatePhraseRow(activeIndex);
        return;
      }
      if (showCommands && activeIndex < resultOffset) {
        const cmd = commands[activeIndex - cmdOffset];
        if (cmd) executeCommand(cmd);
        return;
      }
      const item = flatItems[activeIndex - resultOffset];
      if (item) openResult(item);
    }
    // Escape 由 overlayStack 捕获分发，这里不处理。
  };

  const showRecent = !query.trim() && recent.length > 0;
  const showEmpty =
    !!query.trim() &&
    !loading &&
    !error &&
    flatItems.length === 0 &&
    !showCommands &&
    !phrase &&
    hints.length === 0;

  return createPortal(
    <div className="ui-dialog-mask gs-mask" ref={rootRef} onKeyDown={onKeyDown}>
      <div
        className="ui-dialog gs-panel"
        role="dialog"
        aria-modal="true"
        aria-label="全局搜索"
      >
        <div className="gs-input-row">
          <Search size={15} strokeWidth={2} aria-hidden="true" className="gs-input-icon" />
          <input
            ref={inputRef}
            data-autofocus
            className="gs-input"
            type="text"
            value={query}
            placeholder="搜索任务、剪贴板、收集箱、文件、应用、Agent、现场与规划…"
            aria-label="搜索关键词"
            maxLength={200}
            onChange={(e) => setQuery(e.target.value)}
            onCompositionStart={ime.onCompositionStart}
            onCompositionEnd={ime.onCompositionEnd}
          />
          {query ? (
            <button
              type="button"
              className="gs-iconbtn"
              aria-label="清空搜索"
              data-tip="清空"
              onClick={() => {
                setQuery("");
                inputRef.current?.focus();
              }}
            >
              {/* 清空与关闭在同一行：不能用两个相同 X（验收 UI-21）。
                  清空用 CircleX，关闭保留 X，两者 aria-label/data-tip 各自明确。 */}
              <CircleX size={14} strokeWidth={2} aria-hidden="true" />
            </button>
          ) : null}
          {loading ? (
            <span className="gs-loading" role="status" aria-label="搜索中">
              <RotateCw size={14} strokeWidth={2} aria-hidden="true" className="gs-spin" />
            </span>
          ) : null}
          <button
            type="button"
            className="gs-iconbtn"
            aria-label="关闭搜索"
            data-tip="关闭 (Esc)"
            onClick={closeSearch}
          >
            <X size={15} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>

        <div className="gs-cats" role="tablist" aria-label="搜索分类">
          {(["all", ...GLOBAL_SEARCH_CATEGORIES] as GlobalSearchCategoryFilter[]).map((c) => (
            <button
              key={c}
              type="button"
              role="tab"
              aria-selected={activeCategory === c}
              className={`gs-cat${activeCategory === c ? " active" : ""}`}
              onClick={() => setActiveCategory(c)}
            >
              {GLOBAL_SEARCH_CATEGORY_LABELS[c]}
            </button>
          ))}
        </div>

        <div className="gs-body">
          {error ? (
            <div className="gs-state gs-error" role="alert">
              <span>搜索失败：{error}</span>
              <button type="button" className="gs-retry" aria-label="重试搜索" onClick={() => void retry()}>
                重试
              </button>
            </div>
          ) : (
            <>
              {/* 句式命令：帧表解析结果固定在最前；写意图两段式确认。 */}
              {phrase ? (
                <GlobalSearchPhrase
                  phrase={phrase}
                  activeIndex={activeIndex}
                  armedId={phraseArmed}
                  executing={phraseExecuting}
                  onActivate={activatePhraseRow}
                  onHoverIndex={setActiveIndex}
                />
              ) : null}
              {hints.length > 0 ? (
                <div className="gs-phrase-hints" role="status">
                  <Wand2 size={12} strokeWidth={2} aria-hidden="true" />
                  <span>{t("commandPhrases.hint.title")}</span>
                  {hints.map((key) => (
                    <span key={key} className="gs-phrase-hint">
                      {t(key)}
                    </span>
                  ))}
                </div>
              ) : null}
              {/* 空查询的可发现性：命令组/最近搜索存在时也要露出示例，
                  否则示例区只在「什么都没有」的空态下渲染，实际不可见。 */}
              {!query.trim() && (showCommands || showRecent) ? (
                <div className="gs-phrase-examples gs-phrase-examples-bar">
                  <span>{t("commandPhrases.hint.title")}</span>
                  {PHRASE_EXAMPLES.map((key) => (
                    <span key={key} className="gs-phrase-hint">
                      {t(key)}
                    </span>
                  ))}
                </div>
              ) : null}
              {/* 命令分组：独立于八类数据结果，紧接句式区（可辨识视觉见 CSS）。 */}
              {showCommands ? (
                <GlobalSearchCommands
                  commands={commands}
                  activeIndex={activeIndex - cmdOffset}
                  onSelect={executeCommand}
                  onHoverIndex={(i) => setActiveIndex(i + cmdOffset)}
                />
              ) : null}
              {showRecent ? (
                <div className="gs-recent" aria-label="最近搜索">
                  <header className="gs-recent-head">
                    <Clock size={13} strokeWidth={2} aria-hidden="true" />
                    <span>最近搜索</span>
                    <button
                      type="button"
                      className="gs-recent-clear"
                      aria-label="清除最近搜索"
                      onClick={clearRecent}
                    >
                      清除
                    </button>
                  </header>
                  {recent.map((r) => (
                    <button
                      key={r}
                      type="button"
                      className="gs-recent-item"
                      onClick={() => setQuery(r)}
                    >
                      {r}
                    </button>
                  ))}
                </div>
              ) : null}
              {showEmpty ? <div className="gs-state">没有匹配的结果</div> : null}
              {results && flatItems.length > 0 ? (
                <GlobalSearchResults
                  groups={results.groups}
                  keyword={query}
                  activeIndex={activeIndex - resultOffset}
                  onSelect={openResult}
                  onHoverIndex={(i) => setActiveIndex(i + resultOffset)}
                />
              ) : null}
              {!query.trim() && !showCommands && !showRecent ? (
                <div className="gs-state gs-phrase-start">
                  <span>输入关键词开始搜索</span>
                  <span className="gs-phrase-examples">
                    <span>{t("commandPhrases.hint.title")}</span>
                    {PHRASE_EXAMPLES.map((key) => (
                      <span key={key} className="gs-phrase-hint">
                        {t(key)}
                      </span>
                    ))}
                  </span>
                </div>
              ) : null}
            </>
          )}
        </div>

        {notice ? (
          <div className="gs-notice" role="status">
            <span>{notice}</span>
            <button
              type="button"
              className="gs-iconbtn"
              aria-label="关闭提示"
              onClick={() => setNotice(null)}
            >
              <X size={12} strokeWidth={2} aria-hidden="true" />
            </button>
          </div>
        ) : null}

        <footer className="gs-foot" aria-hidden="true">
          {armedHere ? (
            <>
              <span>{t("commandPhrases.footer.arm")}</span>
              <span>{t("commandPhrases.footer.disarm")}</span>
            </>
          ) : phrase && phrase.kind !== "query" ? (
            <>
              <span>{t("commandPhrases.footer.preview")}</span>
              <span>Esc 关闭</span>
            </>
          ) : (
            <>
              <span>↑↓ 选择</span>
              <span>Enter {phrase ? t("commandPhrases.footer.locate") : "打开"}</span>
              <span>Esc 关闭</span>
            </>
          )}
          <span className="gs-foot-hint">仅本地搜索，不上传任何内容</span>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
