//! 帮助中心主面板（完整模式第 13 个视觉入口的宿主页面）。
//!
//! R5 信息架构：分类/最近导航 + 文章列表 + 常驻阅读区，三者并行。
//! 打开文章不再替换整个列表；窄窗由 CSS 降级为上下分区。
//! 无后台任务：搜索是纯函数、最近浏览只在打开文章时写一次 localStorage。

import { useEffect, useRef, useState } from "react";
import { ArrowLeft, BookOpen, Clock3, LifeBuoy } from "lucide-react";
import { SearchField, StatusBadge } from "../ui";
import { useLocale } from "../../hooks/useLocale";
import { useUiStore } from "../../store/useUiStore";
import WorkbenchPageHeader from "../../workbench/WorkbenchPageHeader";
import { useNavigationLayout } from "../../lib/navigationLayout";
import { navEntry, navLabel } from "../../lib/navigationRegistry";
import {
  articlesByCategory,
  getHelpArticle,
  hasNativeTranslation,
  helpContent,
  searchHelpArticles,
} from "../../help/registry";
import { HELP_CATEGORY_LABEL_KEYS, HELP_CATEGORY_ORDER } from "../../help/categories";
import { HELP_STATUS_META } from "../../help/statusMeta";
import {
  clearRecentArticles,
  readRecentArticleIds,
  recentArticles,
  recordRecentArticle,
} from "../../help/recent";
import type { HelpArticle, HelpCategoryId } from "../../help/types";
import HelpArticleBody from "./HelpArticleBody";
import HelpFeatureLink from "./HelpFeatureLink";
import ReopenOnboardingButton from "../onboarding/ReopenOnboardingButton";
import "./help-center.css";

export default function HelpCenterPanel() {
  const { t, locale } = useLocale();
  const setTab = useUiStore((s) => s.setTab);
  const helpReturnTab = useUiStore((s) => s.helpReturnTab);
  const clearHelpReturnTab = useUiStore((s) => s.setHelpReturnTab);
  const layout = useNavigationLayout();
  const [query, setQuery] = useState("");
  const [categoryId, setCategoryId] = useState<HelpCategoryId>("quickstart");
  const [openId, setOpenId] = useState<string | null>(null);
  const [recentIds, setRecentIds] = useState<string[]>(() => readRecentArticleIds());
  const listScrollRef = useRef<HTMLDivElement | null>(null);
  const readerScrollRef = useRef<HTMLDivElement | null>(null);

  // 消费一次性意图（ContextHelpButton「查看完整教程」等）：打开指定文章。
  // 请求取到即清除，避免返回本页时被旧 token 重复打开。
  const helpOpenRequest = useUiStore((s) => s.helpOpenRequest);
  const clearHelpArticleRequest = useUiStore((s) => s.clearHelpArticleRequest);
  useEffect(() => {
    if (!helpOpenRequest) return;
    const article = getHelpArticle(helpOpenRequest.articleId);
    clearHelpArticleRequest();
    if (!article) return;
    setQuery("");
    setCategoryId(article.categoryId);
    setOpenId(article.id);
    setRecentIds(recordRecentArticle(article.id));
  }, [helpOpenRequest, clearHelpArticleRequest]);

  const openArticle = getHelpArticle(openId ?? "") ?? null;

  /** 打开文章：记录最近浏览（写入即返回新列表，避免再读一次存储）。 */
  function open(id: string) {
    setOpenId(id);
    setRecentIds(recordRecentArticle(id));
  }

  function returnToSource() {
    if (!helpReturnTab) return;
    setTab(helpReturnTab, { after: () => clearHelpReturnTab(null) });
  }

  const normalizedQuery = query.trim();
  const searchResults = normalizedQuery ? searchHelpArticles(normalizedQuery, locale) : [];
  const categoryArticles = articlesByCategory(categoryId);
  const recent = recentArticles(recentIds);
  const categoryCounts = new Map(
    HELP_CATEGORY_ORDER.map((id) => [id, articlesByCategory(id).length] as const),
  );

  // 滚动容器在宽/窄布局下复用同一 DOM 节点：切换分类或搜索词后列表回到顶部；
  // 切换文章后阅读区回到顶部，避免「切到下一篇仍停在上一篇的中间位置」。
  useEffect(() => {
    if (listScrollRef.current) listScrollRef.current.scrollTop = 0;
  }, [categoryId, normalizedQuery]);

  useEffect(() => {
    if (readerScrollRef.current) readerScrollRef.current.scrollTop = 0;
  }, [openId]);

  return (
    <div className={`help-panel ui-page-frame page-fill${openArticle ? " has-article" : ""}`}>
      <WorkbenchPageHeader
        icon={LifeBuoy}
        title={t("help.title")}
        subtitle={t("help.subtitle")}
        actions={
          helpReturnTab ? (
            <button
              type="button"
              className="btn sm"
              onClick={returnToSource}
              aria-label={t("help.backToSource")}
            >
              <ArrowLeft size={12} aria-hidden="true" />
              {t("help.backToSource")}
            </button>
          ) : null
        }
      />

      <div className="help-toolbar">
        <SearchField
          value={query}
          onChange={setQuery}
          placeholder={t("help.searchPlaceholder")}
          ariaLabel={t("help.searchAria")}
          clearLabel={t("help.searchClear")}
        />
        <ReopenOnboardingButton />
      </div>

      <div className="help-workspace">
        <aside className="help-side" aria-label={t("help.categories")}>
          <div className="workspace-rail-head">
            <span className="workspace-rail-eyebrow">KNOWLEDGE</span>
            <h2>{t("help.categories")}</h2>
          </div>
          <nav className="help-cat-list" aria-label={t("help.categories")}>
            {HELP_CATEGORY_ORDER.map((id) => (
              <button
                key={id}
                type="button"
                className={`help-cat${categoryId === id && !normalizedQuery ? " active" : ""}`}
                aria-pressed={categoryId === id && !normalizedQuery}
                aria-label={t(HELP_CATEGORY_LABEL_KEYS[id])}
                onClick={() => {
                  setCategoryId(id);
                  setQuery("");
                }}
              >
                <span>{t(HELP_CATEGORY_LABEL_KEYS[id])}</span>
                <em>{categoryCounts.get(id) ?? 0}</em>
              </button>
            ))}
          </nav>

          {recent.length > 0 && (
            <section className="help-side-recent" aria-label={t("help.recent")}>
              <div className="help-side-section-head">
                <span>
                  <Clock3 size={12} aria-hidden="true" /> {t("help.recent")}
                </span>
                <button
                  type="button"
                  className="btn sm"
                  aria-label={t("help.recentClearAria")}
                  onClick={() => {
                    clearRecentArticles();
                    setRecentIds([]);
                  }}
                >
                  {t("help.recentClear")}
                </button>
              </div>
              <div className="help-side-recent-list">
                {recent.slice(0, 5).map((article) => {
                  const content = helpContent(article, locale);
                  return (
                    <button
                      key={article.id}
                      type="button"
                      className={`help-side-recent-row${openId === article.id ? " is-active" : ""}`}
                      onClick={() => open(article.id)}
                    >
                      {content.title}
                    </button>
                  );
                })}
              </div>
            </section>
          )}
        </aside>

        <section className="help-list-pane" aria-label={normalizedQuery ? t("help.searchAria") : t(HELP_CATEGORY_LABEL_KEYS[categoryId])}>
          <div className="help-pane-head">
            <div>
              <span className="workspace-rail-eyebrow">ARTICLES</span>
              <h3>{normalizedQuery ? t("help.searchAria") : t(HELP_CATEGORY_LABEL_KEYS[categoryId])}</h3>
            </div>
            <span className="help-pane-meta">
              {normalizedQuery
                ? t("help.searchResultCount", { count: searchResults.length })
                : categoryArticles.length}
            </span>
          </div>
          <div className="help-list-scroll page-scroll" ref={listScrollRef}>
            {normalizedQuery && searchResults.length === 0 ? (
              <p className="help-empty" role="status">
                {t("help.searchEmpty", { query: normalizedQuery })}
              </p>
            ) : null}
            {!normalizedQuery && categoryArticles.length === 0 ? (
              <p className="help-empty" role="status">
                {t("help.emptyCategory")}
              </p>
            ) : null}
            <div className="help-list">
              {(normalizedQuery ? searchResults : categoryArticles).map((article) => (
                <ArticleRow
                  key={article.id}
                  article={article}
                  locale={locale}
                  active={openId === article.id}
                  onOpen={open}
                />
              ))}
            </div>
          </div>
        </section>

        <section className="help-reader-pane" aria-label={t("help.title")}>
          {openArticle ? (
            <>
              <div className="help-reader-head">
                <div>
                  <span className="workspace-rail-eyebrow">READING</span>
                  <h3>{helpContent(openArticle, locale).title}</h3>
                </div>
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => setOpenId(null)}
                  aria-label={t("help.backToList")}
                >
                  <ArrowLeft size={12} aria-hidden="true" />
                  {t("help.backToList")}
                </button>
              </div>
              <div className="help-reader-scroll page-scroll" ref={readerScrollRef}>
                <div className="help-article">
                  <HelpArticleBody article={openArticle} locale={locale} />
                  {openArticle.relatedFeatureIds.length > 0 && (
                    <section className="help-related" aria-label={t("help.relatedFeatures")}>
                      <p className="help-related-title">{t("help.relatedFeatures")}</p>
                      {openArticle.relatedFeatureIds.map((featureId, i) => (
                        <HelpFeatureLink
                          key={featureId}
                          featureId={featureId}
                          routeId={openArticle.relatedRouteIds[i % openArticle.relatedRouteIds.length]}
                        />
                      ))}
                    </section>
                  )}
                  {openArticle.relatedRouteIds.length > 0 && (
                    <section className="help-related" aria-label={t("help.relatedRoutes")}>
                      <p className="help-related-title">{t("help.relatedRoutes")}</p>
                      {openArticle.relatedRouteIds.map((routeId) => {
                        const entry = navEntry(routeId);
                        if (!entry) return null;
                        const label = navLabel(entry, t);
                        const hidden = !layout.left.includes(entry.id);
                        return (
                          <div key={routeId} className="help-related-row">
                            <button
                              type="button"
                              className="btn sm"
                              aria-label={t("help.goToPage", { label })}
                              onClick={() => setTab(entry.tabs[0])}
                            >
                              {t("help.goToPage", { label })}
                            </button>
                            {hidden && <span className="help-route-hint">{t("help.featureHidden")}</span>}
                          </div>
                        );
                      })}
                    </section>
                  )}
                </div>
              </div>
            </>
          ) : (
            <div className="help-reader-empty">
              <BookOpen size={26} aria-hidden="true" />
              <strong>
                {locale === "en-US"
                  ? "Choose a guide to start reading"
                  : "选择一篇教程开始阅读"}
              </strong>
              <span>{t("help.subtitle")}</span>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function ArticleRow({
  article,
  locale,
  active,
  onOpen,
}: {
  article: HelpArticle;
  locale: ReturnType<typeof useLocale>["locale"];
  active: boolean;
  onOpen: (id: string) => void;
}) {
  const { t } = useLocale();
  const content = helpContent(article, locale);
  const statusMeta = HELP_STATUS_META[article.status];
  return (
    <button
      type="button"
      className={`help-item${active ? " is-active" : ""}`}
      aria-pressed={active}
      onClick={() => onOpen(article.id)}
    >
      <p className="help-item-title">{content.title}</p>
      <p className="help-item-summary">{content.summary}</p>
      <span className="help-badges">
        <StatusBadge
          tone={statusMeta.tone}
          size="sm"
          dataTip={t("help.articleStatusAria", { status: t(statusMeta.labelKey) })}
        >
          {t(statusMeta.labelKey)}
        </StatusBadge>
        {!hasNativeTranslation(article, locale) && locale === "en-US" && (
          <StatusBadge tone="neutral" size="sm">
            {t("help.translationMissing")}
          </StatusBadge>
        )}
      </span>
    </button>
  );
}
