/**
 * @vitest-environment jsdom
 */
//! 设置页信息架构注册表：分类/分组完整性、持久化回退与查找匹配。
//!
//! 这里锁住的是「结构不变量」而不是某次具体文案：
//! - 每个稳定分组必须且只能归属一个分类（新增分组忘记归类 → 测试失败）；
//! - 分类与分组 ID 唯一、顺序稳定，未知/损坏的持久化数据安全回退；
//! - 标题 Key 在中英两套词典里都存在；
//! - `diagnostics-logs` 曾经漏出「跳转索引」，现在由注册表统一提供，单独回归。

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SETTINGS_CATEGORIES,
  SETTINGS_CATEGORY_IDS,
  SETTINGS_CATEGORY_STORAGE_KEY,
  SETTINGS_SECTION_META,
  categoryForSection,
  defaultSettingsCategory,
  isSettingsCategoryId,
  matchesSettingsQuery,
  persistSettingsCategory,
  readSettingsCategory,
  sectionsForCategory,
  settingsCategory,
  settingsSectionMeta,
  type SettingsCategoryId,
} from "./settingsCategories";
import { SETTINGS_SECTION_IDS } from "./settingsSections";
import { zhCN } from "../locales/zh-CN";
import { enUS } from "../locales/en-US";

beforeEach(() => {
  localStorage.clear();
});

describe("设置分类注册表完整性", () => {
  it("每个稳定分组都归属且只归属一个分类（新增分组漏归类会失败）", () => {
    const counts = new Map<string, number>();
    for (const meta of SETTINGS_SECTION_META) {
      counts.set(meta.id, (counts.get(meta.id) ?? 0) + 1);
    }
    for (const id of SETTINGS_SECTION_IDS) {
      expect(counts.get(id), `分组 ${id} 缺少分类归属`).toBe(1);
    }
    // 注册表里不允许出现 SETTINGS_SECTION_IDS 之外的“幽灵分组”
    expect([...counts.keys()].sort()).toEqual([...SETTINGS_SECTION_IDS].sort());
  });

  it("分类 ID 唯一、顺序稳定，且每个分类至少包含一个分组", () => {
    const ids = SETTINGS_CATEGORIES.map((c) => c.id);
    expect(ids).toEqual([...SETTINGS_CATEGORY_IDS]);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of SETTINGS_CATEGORY_IDS) {
      expect(sectionsForCategory(id).length, `分类 ${id} 为空`).toBeGreaterThan(0);
    }
    // 所有分组都被某个分类覆盖，且没有分组同时出现在两个分类
    const union = SETTINGS_CATEGORY_IDS.flatMap((id) => sectionsForCategory(id).map((m) => m.id));
    expect(union.sort()).toEqual([...SETTINGS_SECTION_IDS].sort());
  });

  it("分组声明的分类与 categoryForSection 一致，且分类存在", () => {
    for (const meta of SETTINGS_SECTION_META) {
      expect(settingsCategory(meta.category)).toBeTruthy();
      expect(categoryForSection(meta.id)).toBe(meta.category);
    }
  });

  it("分类与分组的标题 Key 在中英两套词典里都存在", () => {
    for (const category of SETTINGS_CATEGORIES) {
      expect(zhCN[category.labelKey], `zh 缺少 ${category.labelKey}`).toBeTruthy();
      expect(enUS[category.labelKey], `en 缺少 ${category.labelKey}`).toBeTruthy();
      expect(zhCN[category.descriptionKey], `zh 缺少 ${category.descriptionKey}`).toBeTruthy();
      expect(enUS[category.descriptionKey], `en 缺少 ${category.descriptionKey}`).toBeTruthy();
    }
    for (const meta of SETTINGS_SECTION_META) {
      expect(zhCN[meta.labelKey], `zh 缺少 ${meta.labelKey}`).toBeTruthy();
      expect(enUS[meta.labelKey], `en 缺少 ${meta.labelKey}`).toBeTruthy();
    }
  });

  it("diagnostics-logs 已纳入分类并可被查找（历史索引遗漏回归）", () => {
    const meta = settingsSectionMeta("diagnostics-logs");
    expect(meta).toBeTruthy();
    expect(meta?.category).toBe("integration");
    expect(sectionsForCategory("integration").map((m) => m.id)).toContain("diagnostics-logs");
  });
});

describe("分类选中态持久化", () => {
  it("首次无记录时默认第一个分类", () => {
    expect(readSettingsCategory()).toBe(defaultSettingsCategory());
    expect(localStorage.getItem(SETTINGS_CATEGORY_STORAGE_KEY)).toBeNull();
  });

  it("写入后可恢复，且使用带版本的稳定键（不写中文）", () => {
    persistSettingsCategory("integration");
    expect(readSettingsCategory()).toBe("integration");
    const raw = JSON.parse(localStorage.getItem(SETTINGS_CATEGORY_STORAGE_KEY) ?? "{}");
    expect(raw.version).toBe(1);
    expect(raw.category).toBe("integration");
    expect(JSON.stringify(raw)).not.toContain("接入与诊断");
  });

  it("损坏 JSON、错误版本、未知分类都回退到默认分类", () => {
    localStorage.setItem(SETTINGS_CATEGORY_STORAGE_KEY, "{broken");
    expect(readSettingsCategory()).toBe(defaultSettingsCategory());

    localStorage.setItem(
      SETTINGS_CATEGORY_STORAGE_KEY,
      JSON.stringify({ version: 99, category: "features" }),
    );
    expect(readSettingsCategory()).toBe(defaultSettingsCategory());

    localStorage.setItem(
      SETTINGS_CATEGORY_STORAGE_KEY,
      JSON.stringify({ version: 1, category: "unknown-category" }),
    );
    expect(readSettingsCategory()).toBe(defaultSettingsCategory());
  });

  it("读取/写入被拒绝时不抛错（回退默认、写入静默失败）", () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    expect(() => readSettingsCategory()).not.toThrow();
    expect(readSettingsCategory()).toBe(defaultSettingsCategory());
    getItem.mockRestore();

    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(() => persistSettingsCategory("help")).not.toThrow();
    setItem.mockRestore();
  });

  it("分类 ID 校验只接受注册表内的值", () => {
    for (const id of SETTINGS_CATEGORY_IDS) expect(isSettingsCategoryId(id)).toBe(true);
    for (const bad of ["", "General", "unknown", null, 3, {}]) {
      expect(isSettingsCategoryId(bad)).toBe(false);
    }
  });
});

describe("查找设置匹配", () => {
  const base = { label: "数据与备份", categoryLabel: "数据与资源", aliases: ["备份", "backup"] };

  it("空查询命中全部；中文按连续子串匹配", () => {
    expect(matchesSettingsQuery(base, "  ")).toBe(true);
    expect(matchesSettingsQuery(base, "备份")).toBe(true);
    expect(matchesSettingsQuery(base, "数据")).toBe(true);
    expect(matchesSettingsQuery(base, "备份恢复")).toBe(false);
  });

  it("英文不区分大小写，别名与分类名都可命中", () => {
    expect(matchesSettingsQuery(base, "BACKUP")).toBe(true);
    expect(matchesSettingsQuery(base, "数据与资源")).toBe(true);
    expect(matchesSettingsQuery(base, "clipboard")).toBe(false);
  });

  it("所有分组的别名只影响匹配，不影响身份", () => {
    const ids = new Set(SETTINGS_SECTION_META.map((m) => m.id));
    for (const meta of SETTINGS_SECTION_META) {
      expect(ids.has(meta.id)).toBe(true);
      for (const alias of meta.aliases ?? []) expect(alias.trim().length).toBeGreaterThan(0);
    }
  });
});

// 防止有人把分类表改成“空分类也能过”的弱断言：至少覆盖六个分类
it("一级分类数量为六个且覆盖全部设置分组", () => {
  const expected: SettingsCategoryId[] = [
    "general",
    "features",
    "notify-voice",
    "data-resources",
    "integration",
    "help",
  ];
  expect(SETTINGS_CATEGORIES.map((c) => c.id)).toEqual(expected);
  expect(SETTINGS_SECTION_META.length).toBe(SETTINGS_SECTION_IDS.length);
});
