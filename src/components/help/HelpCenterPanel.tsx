//! 帮助中心主面板（完整模式第 13 个视觉入口的宿主页面）。
//!
//! 结构：搜索 + 分类浏览 + 最近使用 + 文章阅读视图 + 相关功能/页面跳转。
//! 无后台任务：搜索是纯函数、最近浏览只在打开文章时写一次 localStorage。

import { useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { SearchField, StatusBadge } from "../ui";
import { useLocale } from "../../hooks/useLocale";
import { useUiStore } from "../../store/useUiStore";
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

  function backToList() {
    setOpenId(null);
  }

  function returnToSource() {
    if (!helpReturnTab) return;
    setTab(helpReturnTab, { after: () => clearHelpReturnTab(null) });
  }

  const normalizedQuery = query.trim();
  const searchResults = normalizedQuery ? searchHelpArticles(normalizedQuery, locale) : [];
  const categoryArticles = articlesByCategory(categoryId);
  const recent = recentArticles(recentIds);

  return (
    <div className="help-panel">
      <header className="help-head">
        <h2>{t("help.title")}</h2>
        <p className="help-subtitle">{t("help.subtitle")}</p>
      </header>

      {helpReturnTab && (
        <div className="help-badges">
          <button
            type="button"
            className="btn sm"
            onClick={returnToSource}
            aria-label={t("help.backToSource")}
          >
            <ArrowLeft size={12} aria-hidden="true" style={{ marginRight: 4 }} />
            {t("help.backToSource")}
          </button>
        </div>
      )}

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

      {openArticle ? (
        <div className="help-article">
          <div className="help-badges">
            <button
              type="button"
              className="btn sm"
              onClick={backToList}
              aria-label={t("help.backToList")}
            >
              <ArrowLeft size={12} aria-hidden="true" style={{ marginRight: 4 }} />
              {t("help.backToList")}
            </button>
          </div>
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
      ) : (
        <>
          {recent.length > 0 && (
            <section className="help-related" aria-label={t("help.recent")}>
              <div className="help-related-row">
                <p className="help-related-title">{t("help.recent")}</p>
                <span className="flex-spacer" />
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
              <div className="help-list">
                {recent.map((article) => (
                  <ArticleRow
                    key={article.id}
                    article={article}
                    locale={locale}
                    onOpen={open}
                  />
                ))}
              </div>
            </section>
          )}

          {normalizedQuery ? (
            <section aria-label={t("help.searchAria")}>
              {searchResults.length === 0 ? (
                <p className="help-empty" role="status">
                  {t("help.searchEmpty", { query: normalizedQuery })}
                </p>
              ) : (
                <>
                  <div className="help-badges">
                    <span className="help-meta-text">
                      {t("help.searchResultCount", { count: searchResults.length })}
                    </span>
                  </div>
                  <div className="help-list">
                    {searchResults.map((article) => (
                      <ArticleRow
                        key={article.id}
                        article={article}
                        locale={locale}
                        onOpen={open}
                      />
                    ))}
                  </div>
                </>
              )}
            </section>
          ) : (
            <>
              <nav className="help-cats" aria-label={t("help.categories")}>
                {HELP_CATEGORY_ORDER.map((id) => (
                  <button
                    key={id}
                    type="button"
                    className={`help-cat${categoryId === id ? " active" : ""}`}
                    aria-pressed={categoryId === id}
                    onClick={() => setCategoryId(id)}
                  >
                    {t(HELP_CATEGORY_LABEL_KEYS[id])}
                  </button>
                ))}
              </nav>
              <div className="help-list">
                {categoryArticles.length === 0 ? (
                  <p className="help-empty" role="status">
                    {t("help.emptyCategory")}
                  </p>
                ) : (
                  categoryArticles.map((article) => (
                    <ArticleRow
                      key={article.id}
                      article={article}
                      locale={locale}
                      onOpen={open}
                    />
                  ))
                )}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

function ArticleRow({
  article,
  locale,
  onOpen,
}: {
  article: HelpArticle;
  locale: ReturnType<typeof useLocale>["locale"];
  onOpen: (id: string) => void;
}) {
  const { t } = useLocale();
  const content = helpContent(article, locale);
  const statusMeta = HELP_STATUS_META[article.status];
  return (
    <button type="button" className="help-item" onClick={() => onOpen(article.id)}>
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
