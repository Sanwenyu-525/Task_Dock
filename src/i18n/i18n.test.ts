// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { enUS } from "../locales/en-US";
import { zhCN, type MessageKey } from "../locales/zh-CN";
import {
  getMissingKeys,
  resetMissingKeys,
  resolveLocale,
  resolveSystemLocale,
  translate,
} from "./messages";
import {
  __resetLocaleForTests,
  getLocale,
  LOCALE_STORAGE_KEY,
  readStoredPreference,
  setLocalePreference,
} from "./index";

beforeEach(() => {
  __resetLocaleForTests();
  resetMissingKeys();
  localStorage.clear();
});

afterEach(() => {
  __resetLocaleForTests();
  resetMissingKeys();
});

describe("词典完整性", () => {
  it("英文与中文键集合完全一致", () => {
    expect(Object.keys(enUS).sort()).toEqual(Object.keys(zhCN).sort());
  });
});

describe("默认语言与切换", () => {
  it("默认简体中文", () => {
    expect(getLocale()).toBe("zh-CN");
    expect(translate("zh-CN", "common.cancel")).toBe("取消");
  });

  it("切换到英文后立即生效并持久化", () => {
    setLocalePreference("en-US");
    expect(getLocale()).toBe("en-US");
    expect(translate(getLocale(), "common.cancel")).toBe("Cancel");
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("en-US");
    expect(document.documentElement.lang).toBe("en-US");
  });

  it("切换回中文", () => {
    setLocalePreference("en-US");
    setLocalePreference("zh-CN");
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(translate(getLocale(), "settings.language")).toBe("语言");
  });
});

describe("参数插值与复数", () => {
  it("替换命名参数", () => {
    expect(translate("zh-CN", "quickAdd.created", { title: "买牛奶" })).toBe("已创建「买牛奶」");
    expect(translate("en-US", "quickAdd.created", { title: "Buy milk" })).toBe(
      'Created "Buy milk"',
    );
  });

  it("缺失参数保留占位符，便于暴露问题", () => {
    expect(translate("en-US", "quickAdd.created", {})).toBe('Created "{title}"');
  });

  it("按 Intl 复数规则选择英文 one / other", () => {
    expect(translate("en-US", "activeReminders.count", { count: 1 })).toBe("1 reminder");
    expect(translate("en-US", "activeReminders.count", { count: 3 })).toBe("3 reminders");
    expect(translate("zh-CN", "activeReminders.count", { count: 1 })).toBe("1 条");
  });
});

describe("缺失键与兜底", () => {
  it("英文缺失时回退中文并记录", () => {
    const key = "test.not.translated" as MessageKey;
    expect(translate("en-US", key)).toBe(key);
    expect(getMissingKeys()).toContain(key);
  });

  it("非法偏好收敛到默认中文", () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, "fr-FR");
    expect(readStoredPreference()).toBe("zh-CN");
  });

  it("存储值损坏（非字符串语义）也回退默认", () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, "system;drop table");
    expect(readStoredPreference()).toBe("zh-CN");
  });
});

describe("跟随系统", () => {
  it("zh 系列归一到 zh-CN，en 系列归一到 en-US", () => {
    expect(resolveSystemLocale("zh-TW")).toBe("zh-CN");
    expect(resolveSystemLocale("zh-Hans-CN")).toBe("zh-CN");
    expect(resolveSystemLocale("en-GB")).toBe("en-US");
  });

  it("不支持的系统语言回退中文", () => {
    expect(resolveSystemLocale("fr-FR")).toBe("zh-CN");
    expect(resolveSystemLocale("")).toBe("zh-CN");
    expect(resolveLocale("system", undefined)).toBe("zh-CN");
  });

  it("显式偏好不受系统语言影响", () => {
    expect(resolveLocale("en-US", "zh-CN")).toBe("en-US");
    expect(resolveLocale("zh-CN", "en-US")).toBe("zh-CN");
  });
});
