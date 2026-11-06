//! 帮助健康度摘要：供 `help:check` 报告覆盖缺口与人工复核项。

import { FEATURE_CATALOG, CORE_FEATURE_IDS } from "../lib/featureCatalog";
import { NAV_ENTRIES } from "../lib/navigationRegistry";
import { HELP_ARTICLES } from "./content";
import { HELP_OPERATION_CONTRACTS } from "./operationContracts";
import type { HelpArticle } from "./types";

export type HelpHealthSeverity = "warning" | "blocker";

export interface HelpHealthIssue {
  severity: HelpHealthSeverity;
  code: string;
  message: string;
  articleId?: string;
  featureId?: string;
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

/** 纯函数，允许测试以模拟变更源文件验证发布门禁。 */
export function inspectHelpHealth(
  articles: readonly HelpArticle[] = HELP_ARTICLES,
  changedFiles: readonly string[] = [],
): HelpHealthIssue[] {
  const issues: HelpHealthIssue[] = [];
  const featureIds = new Set(FEATURE_CATALOG.map((feature) => feature.id));
  const routeIds = new Set<string>(NAV_ENTRIES.map((entry) => entry.id));
  const coveredFeatureIds = new Set(
    articles
      .filter((article) => article.status !== "unavailable")
      .flatMap((article) => article.relatedFeatureIds),
  );

  for (const featureId of CORE_FEATURE_IDS) {
    const feature = FEATURE_CATALOG.find((entry) => entry.id === featureId);
    if (feature?.status === "implemented" && !coveredFeatureIds.has(featureId)) {
      issues.push({
        severity: "blocker",
        code: "implemented-core-without-guide",
        featureId,
        message: `已实现核心功能 ${featureId} 没有可用教程`,
      });
    }
  }

  for (const feature of FEATURE_CATALOG) {
    if (
      (feature.status === "implemented" || feature.status === "partial") &&
      feature.entryPoints?.length &&
      !coveredFeatureIds.has(feature.id)
    ) {
      issues.push({
        severity: "warning",
        code: "visible-feature-without-guide",
        featureId: feature.id,
        message: `可见功能「${feature.title}」尚未关联教程`,
      });
    }
  }

  for (const article of articles) {
    if (article.status === "needs_review") {
      issues.push({
        severity: "warning",
        code: "article-needs-review",
        articleId: article.id,
        message: `教程 ${article.id} 标记为 needs_review`,
      });
    }
    if (!article.translations["en-US"]) {
      issues.push({
        severity: "warning",
        code: "translation-missing",
        articleId: article.id,
        message: `教程 ${article.id} 缺少 en-US 正文（界面会回退中文并显示缺失提示）`,
      });
    }
    for (const featureId of article.relatedFeatureIds) {
      if (!featureIds.has(featureId)) {
        issues.push({
          severity: "blocker",
          code: "deleted-feature-reference",
          articleId: article.id,
          featureId,
          message: `教程 ${article.id} 引用了不存在的功能 ${featureId}`,
        });
      }
    }
    for (const routeId of article.relatedRouteIds) {
      if (!routeIds.has(routeId)) {
        issues.push({
          severity: "blocker",
          code: "deleted-route-reference",
          articleId: article.id,
          message: `教程 ${article.id} 引用了不存在的路由 ${routeId}`,
        });
      }
    }
  }

  const changed = new Set(changedFiles.map(normalizePath));
  for (const [featureId, contract] of Object.entries(HELP_OPERATION_CONTRACTS)) {
    const linkedArticles = articles.filter((article) => contract.articleIds.includes(article.id));
    if (linkedArticles.length === 0 || linkedArticles.some((article) => !article.relatedFeatureIds.includes(featureId))) {
      issues.push({
        severity: contract.sensitive ? "blocker" : "warning",
        code: "operation-contract-article-missing",
        featureId,
        message: `操作契约 ${featureId} 没有关联到有效教程`,
      });
      continue;
    }

    for (const article of linkedArticles) {
      const reviewedVersion = article.reviewedOperationContractVersions?.[featureId];
      if (reviewedVersion !== contract.version) {
        issues.push({
          severity: contract.sensitive ? "blocker" : "warning",
          code: "operation-contract-version-mismatch",
          articleId: article.id,
          featureId,
          message: `教程 ${article.id} 已核对操作契约版本 ${reviewedVersion ?? "未登记"}，当前为 ${contract.version}`,
        });
      }

      const changedSources = contract.sourceFiles.filter((path) => changed.has(normalizePath(path)));
      if (changedSources.length > 0) {
        issues.push({
          severity: contract.sensitive && article.status === "verified" ? "blocker" : "warning",
          code: "operation-source-changed",
          articleId: article.id,
          featureId,
          message: `操作契约源文件变化（${changedSources.join(", ")}）；教程需人工复核`,
        });
      }
    }
  }

  return issues;
}
