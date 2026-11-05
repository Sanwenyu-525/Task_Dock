/**
 * @vitest-environment jsdom
 */
//! 折叠偏好读写：默认值、往返、版本/结构校验、存储不可用回退。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { persistCollapsibleState, readCollapsibleState } from "./collapsibleState";

const KEY = "test.collapsible.v1";
const DEFAULTS = { alpha: true, beta: false } as const;

beforeEach(() => localStorage.clear());
afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("collapsibleState", () => {
  it("无记录时返回默认值", () => {
    expect(readCollapsibleState(KEY, DEFAULTS)).toEqual({ alpha: true, beta: false });
  });

  it("写入后可原样读回，只接受声明的键与布尔值", () => {
    persistCollapsibleState(KEY, { alpha: false, beta: true });
    expect(readCollapsibleState(KEY, DEFAULTS)).toEqual({ alpha: false, beta: true });

    localStorage.setItem(
      KEY,
      JSON.stringify({ version: 1, sections: { alpha: "yes", beta: true, unknown: false } }),
    );
    expect(readCollapsibleState(KEY, DEFAULTS)).toEqual({ alpha: true, beta: true });
  });

  it("损坏 JSON / 未知版本 / 缺 sections 时回退默认值", () => {
    localStorage.setItem(KEY, "{broken");
    expect(readCollapsibleState(KEY, DEFAULTS)).toEqual({ alpha: true, beta: false });

    localStorage.setItem(KEY, JSON.stringify({ version: 99, sections: { alpha: false } }));
    expect(readCollapsibleState(KEY, DEFAULTS)).toEqual({ alpha: true, beta: false });

    localStorage.setItem(KEY, JSON.stringify({ version: 1 }));
    expect(readCollapsibleState(KEY, DEFAULTS)).toEqual({ alpha: true, beta: false });
  });

  it("localStorage 抛错（隐私模式/配额）时读写都不崩溃", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readCollapsibleState(KEY, DEFAULTS)).toEqual({ alpha: true, beta: false });

    vi.restoreAllMocks();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(() => persistCollapsibleState(KEY, { alpha: false, beta: true })).not.toThrow();
  });
});
