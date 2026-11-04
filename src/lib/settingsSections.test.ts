/**
 * @vitest-environment jsdom
 */
//! 设置分组折叠持久化：默认折叠、独立记录、损坏/版本不兼容/存储拒绝时安全回退。

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SETTINGS_SECTION_IDS,
  SETTINGS_SECTIONS_STORAGE_KEY,
  collapsedSectionState,
  persistSettingsSectionOpenState,
  readSettingsSectionOpenState,
} from "./settingsSections";

beforeEach(() => {
  localStorage.clear();
});

describe("设置分组折叠状态", () => {
  it("首次无记录时所有主分组默认折叠", () => {
    const state = readSettingsSectionOpenState();
    expect(Object.keys(state)).toHaveLength(SETTINGS_SECTION_IDS.length);
    for (const id of SETTINGS_SECTION_IDS) expect(state[id]).toBe(false);
    expect(localStorage.getItem(SETTINGS_SECTIONS_STORAGE_KEY)).toBeNull();
  });

  it("每个分组独立记录，可同时展开多个", () => {
    const state = collapsedSectionState();
    state.appearance = true;
    state.apps = true;
    persistSettingsSectionOpenState(state);

    const restored = readSettingsSectionOpenState();
    expect(restored.appearance).toBe(true);
    expect(restored.apps).toBe(true);
    expect(restored.clipboard).toBe(false);
  });

  it("使用带版本的稳定键，不以中文标题持久化", () => {
    const raw = localStorage.getItem(SETTINGS_SECTIONS_STORAGE_KEY);
    expect(raw).toBeNull();
    const state = collapsedSectionState();
    state.agent = true;
    persistSettingsSectionOpenState(state);
    const stored = JSON.parse(localStorage.getItem(SETTINGS_SECTIONS_STORAGE_KEY) ?? "{}");
    expect(stored.version).toBe(1);
    expect(stored.sections.agent).toBe(true);
    expect(JSON.stringify(stored)).not.toContain("Agent 接入");
  });

  it("损坏 JSON、错误结构与版本不兼容时回退为全部折叠", () => {
    localStorage.setItem(SETTINGS_SECTIONS_STORAGE_KEY, "{not-json");
    expect(readSettingsSectionOpenState()).toEqual(collapsedSectionState());

    localStorage.setItem(SETTINGS_SECTIONS_STORAGE_KEY, "[]");
    expect(readSettingsSectionOpenState()).toEqual(collapsedSectionState());

    localStorage.setItem(
      SETTINGS_SECTIONS_STORAGE_KEY,
      JSON.stringify({ version: 99, sections: { appearance: true } }),
    );
    expect(readSettingsSectionOpenState()).toEqual(collapsedSectionState());
  });

  it("忽略未知分组与非布尔值", () => {
    localStorage.setItem(
      SETTINGS_SECTIONS_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        sections: { appearance: true, clipboard: "yes", unknown_section: true },
      }),
    );
    const state = readSettingsSectionOpenState();
    expect(state.appearance).toBe(true);
    expect(state.clipboard).toBe(false);
    expect("unknown_section" in state).toBe(false);
  });

  it("读取被拒绝时回退折叠且不抛错", () => {
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    expect(() => readSettingsSectionOpenState()).not.toThrow();
    expect(readSettingsSectionOpenState()).toEqual(collapsedSectionState());
    spy.mockRestore();
  });

  it("写入被拒绝时静默失败，不阻断折叠交互", () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(() => persistSettingsSectionOpenState(collapsedSectionState())).not.toThrow();
    spy.mockRestore();
  });
});
