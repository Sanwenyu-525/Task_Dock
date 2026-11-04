//! 全局搜索结果列表：分类分组渲染 + 关键词高亮 + 键盘选中态。

import { memo, useEffect, useRef } from "react";

import {
  GLOBAL_SEARCH_CATEGORY_LABELS,
  GLOBAL_SEARCH_KIND_LABELS,
  type GlobalSearchCategory,
  type GlobalSearchGroup,
  type GlobalSearchResult,
} from "../../lib/globalSearchBridge";

/** 把 title 中首个 keyword 出现片段标记为高亮（大小写不敏感；无命中返回原文本）。 */
function highlight(title: string, keyword: string): Array<{ text: string; hit: boolean }> {
  const q = keyword.trim();
  if (!q) return [{ text: title, hit: false }];
  const idx = title.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return [{ text: title, hit: false }];
  const parts: Array<{ text: string; hit: boolean }> = [];
  if (idx > 0) parts.push({ text: title.slice(0, idx), hit: false });
  parts.push({ text: title.slice(idx, idx + q.length), hit: true });
  if (idx + q.length < title.length) parts.push({ text: title.slice(idx + q.length), hit: false });
  return parts;
}

function kindLabel(kind: string): string {
  return GLOBAL_SEARCH_KIND_LABELS[kind] ?? kind;
}

/** 时间展示：ISO → MM-DD HH:mm（与全应用 format_local 一致的口径，前端轻量实现）。 */
function timeLabel(iso: string | null): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const hh = String(d.getHours()).padStart(2, "0");
    const mi = String(d.getMinutes()).padStart(2, "0");
    return `${mm}-${dd} ${hh}:${mi}`;
  } catch {
    return "";
  }
}

interface ResultsProps {
  groups: GlobalSearchGroup[];
  keyword: string;
  activeIndex: number;
  onSelect: (item: GlobalSearchResult) => void;
  onHoverIndex: (flatIndex: number) => void;
}

export const GlobalSearchResults = memo(function GlobalSearchResults({
  groups,
  keyword,
  activeIndex,
  onSelect,
  onHoverIndex,
}: ResultsProps) {
  const activeRef = useRef<HTMLButtonElement | null>(null);

  // 键盘导航时保持选中项可见。
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  let flat = -1;
  return (
    <div className="gs-results" role="listbox" aria-label="搜索结果">
      {groups.map((g) => (
        <section key={g.category} className="gs-group" aria-label={GLOBAL_SEARCH_CATEGORY_LABELS[g.category as GlobalSearchCategory] ?? g.category}>
          <header className="gs-group-head">
            <span>{GLOBAL_SEARCH_CATEGORY_LABELS[g.category as GlobalSearchCategory] ?? g.category}</span>
            {g.has_more ? <span className="gs-group-more">还有更多</span> : null}
          </header>
          {g.items.map((item) => {
            flat += 1;
            const idx = flat;
            const active = idx === activeIndex;
            return (
              <button
                key={`${item.category}:${item.id}`}
                type="button"
                role="option"
                aria-selected={active}
                className={`gs-item${active ? " active" : ""}`}
                data-gs-id={item.id}
                ref={active ? activeRef : undefined}
                onClick={() => onSelect(item)}
                onMouseEnter={() => onHoverIndex(idx)}
              >
                <span className={`gs-item-icon gs-kind-${item.kind}`} aria-hidden="true">
                  {kindLabel(item.kind).slice(0, 2)}
                </span>
                <span className="gs-item-main">
                  <span className="gs-item-title">
                    {highlight(item.title, keyword).map((p, i) =>
                      p.hit ? (
                        <mark key={i} className="gs-hit">{p.text}</mark>
                      ) : (
                        <span key={i}>{p.text}</span>
                      ),
                    )}
                  </span>
                  {(item.subtitle || item.snippet) && (
                    <span className="gs-item-sub">
                      {item.subtitle ? <span className="gs-item-from">{item.subtitle}</span> : null}
                      {item.snippet ? <span className="gs-item-snippet">{item.snippet}</span> : null}
                    </span>
                  )}
                </span>
                <span className="gs-item-side">
                  {item.status ? <span className="gs-item-status">{item.status}</span> : null}
                  {timeLabel(item.occurred_at) ? (
                    <span className="gs-item-time">{timeLabel(item.occurred_at)}</span>
                  ) : null}
                </span>
              </button>
            );
          })}
        </section>
      ))}
    </div>
  );
});
