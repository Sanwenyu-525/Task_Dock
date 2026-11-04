//! 快速笔记面板：左侧列表（搜索 / 筛选 / 新建）+ 右侧编辑器。
//!
//! 挂载点由集成会话接入「收集与暂存」子页或工具面板（见
//! `tmp/acceptance/quick-notes/integration.md`）；本组件不新增顶级导航。
//! 窄窗下自动改为上下布局，列表限高，编辑器保证可读。
//! 所有可见文案走 `notes.*` 词条，时间用本地化格式化，不硬编码中文。

import { useEffect } from "react";
import {
  FileText,
  Loader2,
  Pin,
  Plus,
  Search,
  Star,
} from "lucide-react";

import { useLocale } from "../../hooks/useLocale";
import { formatLocalizedRelative } from "../../i18n/format";
import { useGlobalSearchStore } from "../../store/useGlobalSearchStore";
import {
  useNotesStore,
  type NoteSummary,
  type NotesFilter,
} from "../../store/useNotesStore";
import { locateElement } from "../global-search/locate";
import NoteEditor from "./NoteEditor";
import "./notes.css";

function displayTitle(item: NoteSummary, untitled: string): string {
  const title = item.title.trim();
  if (title) return title;
  const excerpt = item.excerpt.trim();
  return excerpt ? excerpt.slice(0, 40) : untitled;
}

export default function NotesPanel() {
  const { t } = useLocale();
  const items = useNotesStore((s) => s.items);
  const query = useNotesStore((s) => s.query);
  const filter = useNotesStore((s) => s.filter);
  const loading = useNotesStore((s) => s.loading);
  const listError = useNotesStore((s) => s.listError);
  const activeId = useNotesStore((s) => s.activeId);
  const active = useNotesStore((s) => s.active);
  const loadingNote = useNotesStore((s) => s.loadingNote);

  const load = useNotesStore((s) => s.load);
  const loadTemplates = useNotesStore((s) => s.loadTemplates);
  const loadLinkOptions = useNotesStore((s) => s.loadLinkOptions);
  const setQuery = useNotesStore((s) => s.setQuery);
  const setFilter = useNotesStore((s) => s.setFilter);
  const create = useNotesStore((s) => s.create);
  const select = useNotesStore((s) => s.select);
  const persistLocalDraft = useNotesStore((s) => s.persistLocalDraft);

  useEffect(() => {
    void load();
    void loadTemplates();
    void loadLinkOptions();
  }, [load, loadTemplates, loadLinkOptions]);

  // 全局搜索定位（category=notes）：清掉搜索/筛选保证目标可见，再选中并滚动高亮。
  // 意图由 useGlobalSearchStore 一次性下发，消费后必须清除。
  const pendingLocate = useGlobalSearchStore((s) => s.pendingLocate);
  const consumeLocate = useGlobalSearchStore((s) => s.consumeLocate);
  useEffect(() => {
    if (!pendingLocate || pendingLocate.category !== "notes") return;
    const intent = pendingLocate;
    consumeLocate();
    useNotesStore.setState({ query: "", filter: "all" });
    void (async () => {
      await useNotesStore.getState().load();
      await useNotesStore.getState().select(intent.id);
      locateElement({
        find: () =>
          document.querySelector<HTMLElement>(
            `[data-note-id="${CSS.escape(intent.id)}"]`,
          ),
      });
    })();
  }, [pendingLocate, consumeLocate]);

  // 关闭 / 隐藏窗口时同步写本地草稿，异常退出后可恢复未提交内容。
  useEffect(() => {
    const flushDraft = () => persistLocalDraft();
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flushDraft();
    };
    window.addEventListener("beforeunload", flushDraft);
    window.addEventListener("pagehide", flushDraft);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("beforeunload", flushDraft);
      window.removeEventListener("pagehide", flushDraft);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [persistLocalDraft]);

  const onCreate = async () => {
    try {
      await create();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      useNotesStore.setState({ listError: message });
    }
  };

  const filterOptions: Array<[NotesFilter, string]> = [
    ["all", t("notes.filter.all")],
    ["pinned", t("notes.filter.pinned")],
    ["favorite", t("notes.filter.favorite")],
  ];
  const untitled = t("notes.untitled");

  return (
    <div className="notes-panel">
      <aside className="notes-sidebar">
        <div className="notes-sidebar-head">
          <span className="notes-sidebar-title">{t("notes.title")}</span>
          <button
            type="button"
            className="icon-btn sm"
            data-tip={t("notes.new")}
            aria-label={t("notes.new")}
            onClick={() => void onCreate()}
          >
            <Plus size={14} />
          </button>
        </div>

        <div className="notes-search">
          <Search size={13} aria-hidden="true" />
          <input
            type="search"
            className="notes-search-input"
            value={query}
            placeholder={t("notes.searchPlaceholder")}
            aria-label={t("notes.searchAria")}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        <div
          className="seg-group subtle notes-filter"
          role="tablist"
          aria-label={t("notes.filterAria")}
        >
          {filterOptions.map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={filter === value}
              className={`seg-btn ${filter === value ? "active" : ""}`}
              onClick={() => setFilter(value)}
            >
              {label}
            </button>
          ))}
        </div>

        {listError && (
          <div className="notes-error" role="alert">
            {listError}
          </div>
        )}

        {loading && items.length === 0 ? (
          <div className="notes-list-hint" aria-busy="true">
            <Loader2 size={13} className="notes-spin" aria-hidden="true" />
            {t("notes.loading")}
          </div>
        ) : items.length === 0 ? (
          <div className="notes-list-empty">
            <FileText size={20} aria-hidden="true" />
            <p>{query.trim() ? t("notes.noMatch") : t("notes.empty")}</p>
            {!query.trim() && (
              <button type="button" className="btn sm" onClick={() => void onCreate()}>
                {t("notes.createFirst")}
              </button>
            )}
          </div>
        ) : (
          <ul className="notes-list" aria-label={t("notes.listAria")} aria-busy={loading}>
            {items.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className={`notes-item surface-card surface-card--interactive ${activeId === item.id ? "is-active surface-card--selected" : ""}`}
                  aria-current={activeId === item.id ? "true" : undefined}
                  data-note-id={item.id}
                  onClick={() => void select(item.id)}
                >
                  <span className="notes-item-head">
                    <span className="notes-item-title">{displayTitle(item, untitled)}</span>
                    <span className="notes-item-flags">
                      {item.pinned && <Pin size={12} aria-label={t("notes.pinnedAria")} />}
                      {item.favorite && (
                        <Star size={12} aria-label={t("notes.favoriteAria")} />
                      )}
                    </span>
                  </span>
                  <span className="notes-item-excerpt">
                    {item.excerpt || t("notes.emptyContent")}
                  </span>
                  <span className="notes-item-meta">
                    <span>{formatLocalizedRelative(item.updated_at)}</span>
                    {item.task_id && (
                      <span className="notes-item-tag">{t("notes.tag.task")}</span>
                    )}
                    {item.workspace_id && (
                      <span className="notes-item-tag">{t("notes.tag.workspace")}</span>
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>

      <section className="notes-main" aria-label={t("notes.editorAria")}>
        {active ? (
          <NoteEditor />
        ) : (
          <div className="notes-main-empty">
            {loadingNote ? (
              <>
                <Loader2 size={18} className="notes-spin" aria-hidden="true" />
                <p>{t("notes.loadingNote")}</p>
              </>
            ) : (
              <>
                <FileText size={26} aria-hidden="true" />
                <p>{t("notes.selectHint")}</p>
                <p className="notes-main-empty-hint">
                  {t("notes.selectHintDetail")}
                </p>
              </>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
