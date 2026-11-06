//! 帮助注册中心契约（`npm run help:check` 的目标文件）。
//!
//! 校验范围（全部为**静态可确认**的契约；操作语义是否过时无法静态判断，
//! 由 status=needs_review / draft 如实表达，不伪装自动通过）：
//! 1. ID 稳定唯一且格式为 `help.<categoryId>.<slug>`；
//! 2. categoryId ∈ 帮助分类；status ∈ 允许枚举；
//! 3. contentVersion ≥ 1（整数）且 reviewedForVersion 非空；
//! 4. zh-CN 正文完整（标题/摘要/段落/步骤），verified 文章强制完整 + 关键词非空；
//! 5. en-US 正文若存在必须与 zh-CN 结构平行（段落数量与类型一致，防漂移）；
//! 6. relatedFeatureIds ⊆ featureCatalog（引用已删除/不存在的功能 → 明确报错）；
//! 7. relatedRouteIds ⊆ navigationRegistry 入口 ID；
//! 8. 每个 implemented 核心功能至少关联一篇非 unavailable 教程；
//! 9. requiredCapabilities 若存在必须是非空字符串数组。
//!
//! expect 消息统一指明「哪篇文章哪个字段」，失败时可直接定位。

import { describe, expect, it } from "vitest";
import { HELP_ARTICLES } from "../content";
import { HELP_CATEGORY_ORDER } from "../categories";
import { HELP_ARTICLE_STATUSES, type HelpArticle, type HelpSection } from "../types";
import { FEATURE_CATALOG, CORE_FEATURE_IDS } from "../../lib/featureCatalog";
import { NAV_ENTRIES } from "../../lib/navigationRegistry";
import { translate } from "../../i18n";
import type { MessageKey } from "../../i18n/messages";
import { HELP_OPERATION_CONTRACTS } from "../operationContracts";

const ARTICLE_IDS = new Set(HELP_ARTICLES.map((a) => a.id));
const FEATURE_IDS = new Set<string>(FEATURE_CATALOG.map((f) => f.id));
const ROUTE_IDS = new Set<string>(NAV_ENTRIES.map((e) => e.id));
const CATEGORY_IDS = new Set<string>(HELP_CATEGORY_ORDER);

const ARTICLE_ID_PATTERN = /^help\.[a-z0-9-]+\.[a-z0-9-]+$/;

/** zh-CN 正文完整性：返回缺失字段的清单（空数组 = 完整）。 */
function zhContentGaps(article: HelpArticle): string[] {
  const gaps: string[] = [];
  const zh = article.translations["zh-CN"];
  if (!zh) return ["translations['zh-CN'] 整体缺失"];
  if (typeof zh.title !== "string" || zh.title.trim().length === 0)
    gaps.push("translations['zh-CN'].title 为空");
  if (typeof zh.summary !== "string" || zh.summary.trim().length === 0)
    gaps.push("translations['zh-CN'].summary 为空");
  if (!Array.isArray(zh.sections) || zh.sections.length === 0)
    gaps.push("translations['zh-CN'].sections 为空");
  else
    zh.sections.forEach((section: HelpSection, i: number) => {
      const label = `translations['zh-CN'].sections[${i}](type=${section.type})`;
      if (section.type === "steps") {
        if (section.items.length === 0) gaps.push(`${label}.items 为空`);
        else if (section.items.some((item: string) => item.trim() === ""))
          gaps.push(`${label}.items 存在空步骤`);
      } else if (typeof section.text !== "string" || section.text.trim().length === 0) {
        gaps.push(`${label}.text 为空`);
      }
    });
  return gaps;
}

/** en-US 与 zh-CN 的结构平行性：返回不一致清单（空数组 = 平行）。 */
function enStructureGaps(article: HelpArticle): string[] {
  const gaps: string[] = [];
  const en = article.translations["en-US"];
  if (!en) return gaps;
  const zh = article.translations["zh-CN"];
  if (en.sections.length !== zh.sections.length) {
    gaps.push(
      `en-US.sections 数量(${en.sections.length}) 与 zh-CN(${zh.sections.length}) 不一致`,
    );
  }
  const zipLen = Math.min(en.sections.length, zh.sections.length);
  for (let i = 0; i < zipLen; i += 1) {
    if (en.sections[i].type !== zh.sections[i].type) {
      gaps.push(
        `en-US.sections[${i}].type(${en.sections[i].type}) 与 zh-CN(${zh.sections[i].type}) 不一致`,
      );
    }
  }
  if (typeof en.title !== "string" || en.title.trim().length === 0)
    gaps.push("en-US.title 为空");
  if (typeof en.summary !== "string" || en.summary.trim().length === 0)
    gaps.push("en-US.summary 为空");
  return gaps;
}

describe("帮助注册中心契约", () => {
  it("文章数量覆盖 8 个分类且不少于第一轮目标（12 篇 verified）", () => {
    expect(HELP_ARTICLES.length).toBeGreaterThanOrEqual(12);
    const covered = new Set(HELP_ARTICLES.map((a) => a.categoryId));
    for (const category of HELP_CATEGORY_ORDER) {
      expect(covered.has(category), `分类 ${category} 没有任何文章`).toBe(true);
    }
    const verified = HELP_ARTICLES.filter((a) => a.status === "verified").length;
    expect(verified, "verified 文章数第一轮目标 ≥12").toBeGreaterThanOrEqual(12);
  });

  it("ID 唯一且符合 help.<categoryId>.<slug> 格式", () => {
    expect(new Set(ARTICLE_IDS).size).toBe(HELP_ARTICLES.length);
    for (const article of HELP_ARTICLES) {
      expect(
        ARTICLE_ID_PATTERN.test(article.id),
        `${article.id}: ID 不符合 help.<categoryId>.<slug> 格式`,
      ).toBe(true);
      expect(
        article.id.startsWith(`help.${article.categoryId}.`),
        `${article.id}: ID 中的分类段与 categoryId(${article.categoryId}) 不一致`,
      ).toBe(true);
    }
  });

  it("categoryId 与 status 都是合法枚举值", () => {
    for (const article of HELP_ARTICLES) {
      expect(
        CATEGORY_IDS.has(article.categoryId),
        `${article.id}: 未知 categoryId "${article.categoryId}"`,
      ).toBe(true);
      expect(
        HELP_ARTICLE_STATUSES.includes(article.status),
        `${article.id}: 非法 status "${article.status}"`,
      ).toBe(true);
    }
  });

  it("contentVersion ≥ 1 且 reviewedForVersion 非空", () => {
    for (const article of HELP_ARTICLES) {
      expect(
        Number.isInteger(article.contentVersion) && article.contentVersion >= 1,
        `${article.id}: contentVersion 必须是 ≥1 的整数（当前 ${article.contentVersion}）`,
      ).toBe(true);
      expect(
        typeof article.reviewedForVersion === "string" &&
          article.reviewedForVersion.trim().length > 0,
        `${article.id}: reviewedForVersion 为空`,
      ).toBe(true);
    }
  });

  it("每篇文章的 zh-CN 正文完整（标题/摘要/段落/步骤）", () => {
    for (const article of HELP_ARTICLES) {
      expect(zhContentGaps(article), `${article.id}: zh-CN 正文不完整`).toEqual([]);
    }
  });

  it("status=verified 的文章必须有完整 zh-CN 正文与非空 zh-CN 关键词", () => {
    for (const article of HELP_ARTICLES) {
      if (article.status !== "verified") continue;
      expect(zhContentGaps(article), `${article.id}: verified 文章 zh-CN 正文不完整`).toEqual([]);
      const keywords = article.keywords["zh-CN"] ?? [];
      expect(
        keywords.length > 0 && keywords.every((k) => typeof k === "string" && k.trim() !== ""),
        `${article.id}: verified 文章 keywords['zh-CN'] 必须非空且无空项`,
      ).toBe(true);
    }
  });

  it("en-US 正文若存在必须与 zh-CN 结构平行", () => {
    for (const article of HELP_ARTICLES) {
      expect(enStructureGaps(article), `${article.id}: en-US 结构漂移`).toEqual([]);
      if (article.translations["en-US"]) {
        const enKeywords = article.keywords["en-US"];
        expect(
          Array.isArray(enKeywords) && enKeywords.length > 0,
          `${article.id}: 提供了 en-US 正文但 keywords['en-US'] 为空`,
        ).toBe(true);
      }
    }
  });

  it("relatedFeatureIds 都存在于 featureCatalog（引用已删除功能立即报错）", () => {
    for (const article of HELP_ARTICLES) {
      for (const featureId of article.relatedFeatureIds) {
        expect(
          FEATURE_IDS.has(featureId),
          `${article.id}.relatedFeatureIds 引用了 featureCatalog 中不存在的功能 "${featureId}"（功能可能已被删除或改名）`,
        ).toBe(true);
      }
    }
  });

  it("relatedRouteIds 都存在于 navigationRegistry 入口清单", () => {
    for (const article of HELP_ARTICLES) {
      for (const routeId of article.relatedRouteIds) {
        expect(
          ROUTE_IDS.has(routeId),
          `${article.id}.relatedRouteIds 引用了 navigationRegistry 中不存在的入口 "${routeId}"`,
        ).toBe(true);
      }
    }
  });

  it("每个 implemented 核心功能至少关联一篇非 unavailable 教程", () => {
    const implementedCore = FEATURE_CATALOG.filter(
      (f) => CORE_FEATURE_IDS.includes(f.id) && f.status === "implemented",
    ).map((f) => f.id);
    expect(implementedCore.length).toBeGreaterThan(0);
    for (const featureId of implementedCore) {
      const related = HELP_ARTICLES.filter(
        (a) => a.status !== "unavailable" && a.relatedFeatureIds.includes(featureId),
      );
      expect(
        related.length,
        `核心功能 "${featureId}"（implemented）没有任何关联教程`,
      ).toBeGreaterThanOrEqual(1);
    }
  });

  it("requiredCapabilities 若存在必须是非空字符串数组", () => {
    for (const article of HELP_ARTICLES) {
      if (article.requiredCapabilities === undefined) continue;
      expect(
        Array.isArray(article.requiredCapabilities) &&
          article.requiredCapabilities.length > 0 &&
          article.requiredCapabilities.every((c) => typeof c === "string" && c.trim() !== ""),
        `${article.id}: requiredCapabilities 必须是非空字符串数组`,
      ).toBe(true);
    }
  });

  it("操作契约版本必须与所关联教程的人工复核版本一致", () => {
    for (const [featureId, contract] of Object.entries(HELP_OPERATION_CONTRACTS)) {
      expect(FEATURE_IDS.has(featureId), `操作契约引用了不存在的功能 ${featureId}`).toBe(true);
      for (const articleId of contract.articleIds) {
        const article = HELP_ARTICLES.find((entry) => entry.id === articleId);
        expect(article, `${featureId} 缺少教程 ${articleId}`).toBeTruthy();
        expect(article?.relatedFeatureIds, `${articleId} 未关联功能 ${featureId}`).toContain(featureId);
        if (article?.status === "verified") {
          expect(
            article.reviewedOperationContractVersions?.[featureId],
            `${articleId} 已标记 verified，但未复核当前操作契约版本 ${contract.version}`,
          ).toBe(contract.version);
        }
      }
      expect(contract.sourceFiles.length, `${featureId} 未登记操作契约源文件`).toBeGreaterThan(0);
    }
  });

  it("分类标签与文章状态标签在两种语言下都有词典条目", () => {
    const statusKeys: Record<string, MessageKey> = {
      verified: "help.status.verified",
      needs_review: "help.status.needs_review",
      draft: "help.status.draft",
      unavailable: "help.status.unavailable",
    };
    for (const category of HELP_CATEGORY_ORDER) {
      const key = `help.category.${category}` as MessageKey;
      for (const locale of ["zh-CN", "en-US"] as const) {
        const text = translate(locale, key);
        expect(text, `分类 ${category} 缺少 ${locale} 词典条目`).not.toBe(key);
      }
    }
    for (const article of HELP_ARTICLES) {
      const key = statusKeys[article.status];
      for (const locale of ["zh-CN", "en-US"] as const) {
        const text = translate(locale, key);
        expect(
          text,
          `${article.id}: status ${article.status} 缺少 ${locale} 词典条目`,
        ).not.toBe(key);
      }
    }
  });
});
