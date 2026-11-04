//! 全局搜索弹窗：Ctrl+Shift+F 唤起的统一检索入口。
//!
//! - 常挂载组件：open=false 时仅保留快捷键监听，不渲染面板（输入不重挂弹窗）。
//! - 弹层接入 overlayStack（"dialog" 层）：Escape 只关最上层；焦点陷阱归还焦点。
//! - 键盘：↑/↓ 移动选中、Enter 打开、输入框 Ctrl+A/Ctrl+Backspace 走原生编辑语义。

import { useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { X, Search, Clock, RotateCw } from "lucide-react";

import { useOverlayLayer, useFocusTrap } from "../ui/overlay";
import {
  GLOBAL_SEARCH_CATEGORIES,
  GLOBAL_SEARCH_CATEGORY_LABELS,
  type GlobalSearchCategoryFilter,
} from "../../lib/globalSearchBridge";
import { useGlobalSearchStore } from "../../store/useGlobalSearchStore";
import { useGlobalSearchShortcut } from "../../hooks/useGlobalSearchShortcut";
import { GlobalSearchResults } from "./GlobalSearchResults";

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

  const closeSearch = useGlobalSearchStore((s) => s.closeSearch);
  const setQuery = useGlobalSearchStore((s) => s.setQuery);
  const setActiveCategory = useGlobalSearchStore((s) => s.setActiveCategory);
  const retry = useGlobalSearchStore((s) => s.retry);
  const moveActive = useGlobalSearchStore((s) => s.moveActive);
  const setActiveIndex = useGlobalSearchStore((s) => s.setActiveIndex);
  const openResult = useGlobalSearchStore((s) => s.openResult);
  const clearRecent = useGlobalSearchStore((s) => s.clearRecent);
  const setNotice = useGlobalSearchStore((s) => s.setNotice);

  // 应用内快捷键（Ctrl+Shift+F）：挂在常驻组件上，弹窗关闭时也可唤起。
  useGlobalSearchShortcut();

  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  useOverlayLayer("dialog", open, closeSearch, rootRef);
  useFocusTrap(open, rootRef, { initial: inputRef });

  const flatItems = useMemo(
    () => results?.groups.flatMap((g) => g.items) ?? [],
    [results],
  );

  // 打开时聚焦输入框（焦点陷阱 initial 之外兜底）。
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  if (!open) return null;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      moveActive(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      moveActive(-1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = flatItems[activeIndex];
      if (item) openResult(item);
    }
    // Escape 由 overlayStack 捕获分发，这里不处理。
  };

  const showRecent = !query.trim() && recent.length > 0;
  const showEmpty =
    !!query.trim() && !loading && !error && flatItems.length === 0;

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
              <X size={14} strokeWidth={2} aria-hidden="true" />
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
          ) : showRecent ? (
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
          ) : showEmpty ? (
            <div className="gs-state">没有匹配的结果</div>
          ) : results && flatItems.length > 0 ? (
            <GlobalSearchResults
              groups={results.groups}
              keyword={query}
              activeIndex={activeIndex}
              onSelect={openResult}
              onHoverIndex={setActiveIndex}
            />
          ) : !query.trim() ? (
            <div className="gs-state">输入关键词开始搜索</div>
          ) : null}
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
          <span>↑↓ 选择</span>
          <span>Enter 打开</span>
          <span>Esc 关闭</span>
          <span className="gs-foot-hint">仅本地搜索，不上传任何内容</span>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
