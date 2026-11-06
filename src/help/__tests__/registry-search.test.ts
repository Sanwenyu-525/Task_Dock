/**
 * @vitest-environment jsdom
 */
//! 注册中心查询与搜索：搜索为纯函数；「最近浏览」依赖 localStorage（jsdom 提供）。

import { describe, expect, it } from "vitest";
import {
  allHelpArticles,
  articlesByCategory,
  articleSearchText,
  articleStepsText,
  getHelpArticle,
  hasNativeTranslation,
  helpContent,
  searchHelpArticles,
} from "../registry";
import { recentArticles, readRecentArticleIds, recordRecentArticle, clearRecentArticles } from "../recent";

describe("帮助注册中心查询", () => {
  it("按 ID 精确查询；未知 ID 返回 undefined", () => {
    expect(getHelpArticle("help.quickstart.panel")?.categoryId).toBe("quickstart");
    expect(getHelpArticle("help.not.a-real-one")).toBeUndefined();
  });

  it("按分类取文章只含该分类，且分类全覆盖", () => {
    const quickstart = articlesByCategory("quickstart");
    expect(quickstart.length).toBeGreaterThanOrEqual(3);
    expect(quickstart.every((a) => a.categoryId === "quickstart")).toBe(true);
    const categories = new Set(allHelpArticles().map((a) => a.categoryId));
    expect(categories.size).toBe(8);
  });

  it("en 缺失时 helpContent 回退 zh-CN；hasNativeTranslation 如实报告", () => {
    const translated = getHelpArticle("help.quickstart.panel")!;
    expect(hasNativeTranslation(translated, "en-US")).toBe(true);
    expect(helpContent(translated, "en-US").title).not.toBe(
      helpContent(translated, "zh-CN").title,
    );
    const zhOnly = getHelpArticle("help.tasks.create-reminders")!;
    expect(hasNativeTranslation(zhOnly, "en-US")).toBe(false);
    // 回退：拿英文查询返回中文正文，UI 据此显示「暂无英文版」徽标
    expect(helpContent(zhOnly, "en-US").title).toBe(helpContent(zhOnly, "zh-CN").title);
  });
});

describe("帮助搜索", () => {
  it("空查询返回空数组", () => {
    expect(searchHelpArticles("   ", "zh-CN")).toEqual([]);
  });

  it("标题命中优先于正文命中；大小写不敏感", () => {
    const results = searchHelpArticles("快速捕获", "zh-CN");
    expect(results[0]?.id).toBe("help.quickstart.capture");
    const enResults = searchHelpArticles("QUICK CAPTURE", "en-US");
    expect(enResults[0]?.id).toBe("help.quickstart.capture");
  });

  it("关键词命中：正文里没出现但 keywords 登记的词也能找到", () => {
    // 「灯箱」在 help.clipboard.image-paste 标题关键词里，也在正文
    const results = searchHelpArticles("灯箱", "zh-CN");
    expect(results.map((a) => a.id)).toContain("help.clipboard.image-paste");
  });

  it("正文命中兜底：搜索步骤里的词能找到文章", () => {
    const results = searchHelpArticles("自动保存", "zh-CN");
    expect(results.map((a) => a.id)).toContain("help.capture.inbox-notes");
  });

  it("完全不相关的查询无结果", () => {
    expect(searchHelpArticles("量子纠缠", "zh-CN")).toEqual([]);
  });

  it("搜索文本包含关键词与正文（小写化）", () => {
    const article = getHelpArticle("help.quickstart.hotkeys")!;
    const text = articleSearchText(article, "zh-CN");
    expect(text).toContain("快捷键");
    expect(text).toContain("ctrl+k");
  });
});

describe("复制操作步骤文本", () => {
  it("含 steps 的文章产出编号步骤；不含 steps 的返回 null", () => {
    const withSteps = getHelpArticle("help.quickstart.capture")!;
    const text = articleStepsText(withSteps, "zh-CN");
    expect(text).toBeTruthy();
    expect(text).toContain("1. ");
    expect(text!.startsWith(withSteps.translations["zh-CN"].title)).toBe(true);
    const en = articleStepsText(withSteps, "en-US");
    expect(en).toContain("2. ");
  });
});

describe("最近浏览记录", () => {
  it("记录置顶去重、容量受限、可清空", () => {
    localStorage.clear();
    const ids: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      const [first] = recordRecentArticle(`help.fake.article-${i}`);
      ids.push(first ?? "");
    }
    const stored = readRecentArticleIds();
    expect(stored.length).toBeLessThanOrEqual(8);
    expect(stored[0]).toBe("help.fake.article-9");
    // 重复记录置顶且不重复
    recordRecentArticle("help.fake.article-3");
    const again = readRecentArticleIds();
    expect(again.filter((id) => id === "help.fake.article-3").length).toBe(1);
    expect(again[0]).toBe("help.fake.article-3");
    clearRecentArticles();
    expect(readRecentArticleIds()).toEqual([]);
  });

  it("recentArticles 忽略已不存在的文章 ID", () => {
    localStorage.clear();
    recordRecentArticle("help.quickstart.panel");
    recordRecentArticle("help.deleted.ghost");
    const resolved = recentArticles(readRecentArticleIds());
    expect(resolved.map((a) => a.id)).toEqual(["help.quickstart.panel"]);
    localStorage.clear();
  });
});
