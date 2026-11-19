//! 全局搜索面板：Ctrl+Shift+F 唤起的统一检索入口。
//!
//! 两种承载形态共用同一条业务链路：
//! 1) 传入 `anchorRef` → 锚定在顶栏搜索字段下方的**下拉层**（工作台主入口）；
//! 2) 未传 → 居中**模态弹窗**（主窗口只有快捷键、没有可见的搜索字段）。
//!
//! - 常挂载组件：open=false 时仅保留快捷键监听，不渲染面板（输入不重挂弹层）。
//! - 模态：overlayStack（"dialog" 层）+ 焦点陷阱；Escape 先取消二次确认再关窗。
//! - 下拉：交给 ui/Popover 的 "menu" 层——外部点击收起、Escape 一次收起、
//!   不锁 Tab 焦点；锚点定位/翻转/边界收敛由基元负责。
//! - 键盘：↑/↓ 移动选中、Enter 打开、输入框 Ctrl+A/Ctrl+Backspace 走原生编辑语义。
//! - 命令层（v0.16）：命令分组固定置于数据结果之前（仅「全部」分类下展示），
//!   flat 选中序 = 命令组在前 + 数据结果在后；Enter 按序号分发到命令或数据结果。

import { useEffect, useMemo, useRef, type RefObject } from "react";
import { createPortal } from "react-dom";
import { X, CircleX, Search, Clock, RotateCw, Wand2 } from "lucide-react";

import Popover from "../ui/Popover";
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

export interface GlobalSearchDialogProps {
  /**
   * 下拉形态的锚点（顶栏搜索字段）。提供时渲染为锚定弹层；
   * 缺省保持居中模态框，不改变主窗口既有快捷键入口。
   */
  anchorRef?: RefObject<HTMLElement | null>;
  /**
   * 下拉形态下承载输入行的容器（顶栏字段内部节点，portal 目标）：
   * 提供时输入就在字段本体里，面板不再重复一个输入框；
   * 缺省则输入行留在面板首行（模态形态没有外部字段可借）。
   */
  inputHost?: HTMLElement | null;
  /** 收起后焦点归还目标（缺省用锚点）。下拉形态传字段里的触发按钮：
   *  锚点容器本身不可聚焦。 */
  returnFocusRef?: RefObject<HTMLElement | null>;
}

export function GlobalSearchDialog({
  anchorRef,
  inputHost,
  returnFocusRef,
}: GlobalSearchDialogProps = {}) {
  const dropdown = anchorRef !== undefined;
  // 输入行搬到顶栏字段的条件：下拉形态 + 字段已把宿主节点挂好。
  const portaledInput = dropdown && !!inputHost;
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
  // 模态：Escape 先取消二次确认（不关窗），没有再关弹窗：一次按键只做一件事。
  // 下拉：不注册这条 dialog 层——收起语义由 Popover 的 menu 层承担（一次收起），
  // 外部点击也不会出现「只取消确认、弹层不关」的半截状态。
  useOverlayLayer(
    "dialog",
    open && !dropdown,
    () => {
      if (!disarmPhrase()) closeSearch();
    },
    rootRef,
  );
  // 下拉层不锁 Tab 焦点：它不是模态框，用户仍可直接操作页面其他控件。
  useFocusTrap(open && !dropdown, rootRef, { initial: inputRef });

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

  // 下拉层关闭后把焦点归还触发字段：否则焦点随着面板卸载掉到 body，
  // 键盘用户会丢失当前位置。仅当没有别的控件接走焦点时才抢，避免干扰
  // 「点导航/点结果」这类本来就该落在目标控件上的操作。
  const dropdownWasOpen = useRef(false);
  useEffect(() => {
    if (!dropdown) return;
    if (open) {
      dropdownWasOpen.current = true;
      return;
    }
    if (!dropdownWasOpen.current) return;
    dropdownWasOpen.current = false;
    if (document.activeElement === document.body) {
      (returnFocusRef ?? anchorRef)?.current?.focus();
    }
  }, [open, dropdown, anchorRef, returnFocusRef]);

  // 键盘：↑↓ 移动、Enter 打开/执行；输入法组合中把方向键留给候选列表。
  // 挂在这里而不是只挂面板：输入行可能被 portal 到顶栏字段（面板之外），
  // 需要由输入行自己接到同一个处理器。
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

  if (!open) return null;

  const showRecent = !query.trim() && recent.length > 0;
  const showEmpty =
    !!query.trim() &&
    !loading &&
    !error &&
    flatItems.length === 0 &&
    !showCommands &&
    !phrase &&
    hints.length === 0;

  // 输入行：模态留在面板首行；下拉形态下由顶栏字段把输入行 portal 进去，
  // 面板里不再出现第二个输入框。输入行在面板外时事件不会冒泡到弹层，
  // 因此这一份自己接 onKeyDown（否则 ↑↓/Enter 只有焦点在面板里才生效）。
  const inputRow = (
    <div className="gs-input-row" onKeyDown={portaledInput ? onKeyDown : undefined}>
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
  );

  // 面板本体：分类 / 结果区 / 提示与键位说明（输入行在上方按承载形态放置）。
  // 两种承载形态共用同一份，差异只在「外面套遮罩模态还是锚定下拉」这一层。
  const panel = (
    <>
      {portaledInput ? null : inputRow}
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
    </>
  );

  if (anchorRef) {
    return (
      <>
        {/* 输入行走顶栏字段本体（字段即搜索框），面板只保留分类/结果/键位说明。 */}
        {inputHost ? createPortal(inputRow, inputHost) : null}
        <Popover
          open={open}
          onOpenChange={(next) => {
            // 下拉层不是模态：外部点击 / Escape 都直接收起整层，
            // 不保留「只取消二次确认却不关层」的半截状态。
            if (!next) closeSearch();
          }}
          anchorRef={anchorRef}
          placement="bottom-start"
          offsetPx={6}
          maxWidth={560}
          maxHeight={520}
          className="gs-popover"
          role="dialog"
          ariaLabel="全局搜索"
          layer="menu"
          onKeyDown={onKeyDown}
          // 焦点由本组件显式管理：打开时聚焦输入框。基元的自动归还在
          // StrictMode 首次挂载的 effect 重放里会把焦点抢回触发按钮，
          // 导致刚打开的输入框丢掉焦点、打字落到页面上。
          restoreFocus={false}
        >
          <div className="gs-panel gs-dropdown-panel" ref={rootRef}>
            {panel}
          </div>
        </Popover>
      </>
    );
  }

  return createPortal(
    <div className="ui-dialog-mask gs-mask" ref={rootRef} onKeyDown={onKeyDown}>
      <div className="ui-dialog gs-panel" role="dialog" aria-modal="true" aria-label="全局搜索">
        {panel}
      </div>
    </div>,
    document.body,
  );
}
