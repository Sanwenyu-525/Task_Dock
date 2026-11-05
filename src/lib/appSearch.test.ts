/**
 * @vitest-environment node
 */
//! 共享应用搜索规则测试：中文只做连续子串、英文大小写不敏感、别名按身份绑定、
//! 排序等级（完全 > 前缀 > 包含 > 别名）与大量结果不丢失。

import { describe, expect, it } from "vitest";
import {
  matchRank,
  searchApps,
  sortTargetsForDisplay,
  APP_PAGE_SIZE,
  type SearchableApp,
} from "./appSearch";

function app(
  displayName: string,
  opts?: { key?: string; exePath?: string; identity?: string; category?: string; customName?: string },
): SearchableApp {
  return {
    key: opts?.key ?? displayName,
    displayName,
    exePath: opts?.exePath,
    identity: opts?.identity,
    category: opts?.category,
    customName: opts?.customName,
  };
}

const WECHAT = app("微信", { exePath: "D:\\微信\\Weixin\\Weixin.exe" });
const WECOM = app("企业微信", { exePath: "C:\\Program Files\\WXWork\\WXWork.exe" });
const WECHAT_DEVTOOLS = app("微信开发者工具", {
  exePath: "C:\\Program Files\\Tencent\\微信web开发者工具\\微信开发者工具.exe",
});
const WECHAT_BOOK = app("微信读书", { exePath: "C:\\Program Files\\WeRead\\WeRead.exe" });
const MINI_CHAT = app("微型聊天工具", { exePath: "C:\\Program Files\\MiniChat\\MiniChat.exe" });
const CHROME = app("Google Chrome 浏览器", {
  exePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  category: "browser",
});
const VSCODE = app("Visual Studio Code", { exePath: "C:\\Program Files\\Microsoft VS Code\\Code.exe" });

function names(list: SearchableApp[]): string[] {
  return list.map((a) => a.displayName);
}

describe("中文搜索：只做连续子串", () => {
  it("「微信」命中微信、企业微信、微信开发者工具、微信读书", () => {
    const found = searchApps(
      [WECHAT, WECOM, WECHAT_DEVTOOLS, WECHAT_BOOK, MINI_CHAT, CHROME, VSCODE],
      "微信",
    );
    expect(names(found)).toEqual(
      expect.arrayContaining(["微信", "企业微信", "微信开发者工具", "微信读书"]),
    );
    expect(names(found)).not.toContain("微型聊天工具");
  });

  it("不连续中文不命中：微开 不命中 微信开发者工具", () => {
    expect(matchRank(WECHAT_DEVTOOLS, "微开")).toBeNull();
  });

  it("「浏览器」命中 Google Chrome 浏览器", () => {
    const found = searchApps([CHROME, WECHAT], "浏览器");
    expect(names(found)).toEqual(["Google Chrome 浏览器"]);
  });
});

describe("英文搜索：大小写不敏感", () => {
  it("WECHAT / wechat / WeChat 结果一致", () => {
    const items = [
      app("WeChat", { exePath: "D:\\微信\\Weixin\\Weixin.exe" }),
      app("微信", { exePath: "D:\\微信\\Weixin\\Weixin.exe" }),
      WECHAT_DEVTOOLS,
    ];
    const upper = names(searchApps(items, "WECHAT"));
    const lower = names(searchApps(items, "wechat"));
    const mixed = names(searchApps(items, "WeChat"));
    expect(upper).toEqual(lower);
    expect(lower).toEqual(mixed);
  });

  it("CHROME 命中 chrome.exe 的浏览器", () => {
    expect(names(searchApps([CHROME, VSCODE], "CHROME"))).toEqual(["Google Chrome 浏览器"]);
  });

  it("VS CODE 通过身份绑定别名命中 Visual Studio Code", () => {
    expect(names(searchApps([VSCODE, CHROME], "VS CODE"))).toEqual(["Visual Studio Code"]);
    expect(names(searchApps([VSCODE], "vscode"))).toEqual(["Visual Studio Code"]);
  });
});

describe("别名：可搜索但不覆盖展示名，且必须绑定真实身份", () => {
  it("微信别名命中 WeChat 主程序，但不会命中身份无关的「WeChat Work」", () => {
    const wechatEn = app("WeChat", { exePath: "D:\\微信\\Weixin\\Weixin.exe" });
    const other = app("WeChat Work", { exePath: "C:\\Other\\FakeChat.exe" });
    const found = searchApps([wechatEn, other], "微信");
    expect(names(found)).toEqual(["WeChat"]);
  });

  it("企业微信别名按身份命中，QQ 不把 QQ音乐 / QQ浏览器 当成同一应用", () => {
    expect(names(searchApps([WECOM], "企业微信"))).toEqual(["企业微信"]);
    expect(names(searchApps([WECOM], "WeCom"))).toEqual(["企业微信"]);

    const qq = app("QQ", { exePath: "C:\\Program Files\\Tencent\\QQ\\QQ.exe" });
    const qqMusic = app("QQ音乐", { exePath: "C:\\Program Files\\QQMusic\\QQMusic.exe" });
    const qqBrowser = app("QQ浏览器", { exePath: "C:\\Program Files\\QQBrowser\\QQBrowser.exe" });
    const found = searchApps([qq, qqMusic, qqBrowser], "Tencent QQ");
    expect(names(found)).toEqual(["QQ"]);
  });

  it("别名不覆盖展示名：展示名命中的排序仍高于别名命中", () => {
    const aliasOnly = app("WeChat", { exePath: "D:\\微信\\Weixin\\Weixin.exe" });
    const found = searchApps([aliasOnly, WECHAT], "微信");
    expect(names(found)).toEqual(["微信", "WeChat"]);
  });
});

describe("排序：完全匹配 > 前缀 > 包含 > 别名", () => {
  it("同一查询下按等级排序，同等级按展示名排序", () => {
    const exact = app("微信");
    const prefix = app("微信读书");
    const contains = app("企业微信");
    const alias = app("WeChat", { exePath: "D:\\微信\\Weixin\\Weixin.exe" });
    const found = searchApps([alias, contains, prefix, exact], "微信");
    expect(names(found)).toEqual(["微信", "微信读书", "企业微信", "WeChat"]);
    expect(matchRank(exact, "微信")).toBe(0);
    expect(matchRank(prefix, "微信")).toBe(1);
    expect(matchRank(contains, "微信")).toBe(2);
    expect(matchRank(alias, "微信")).toBe(3);
  });

  it("已保存自定义名参与匹配", () => {
    expect(matchRank(app("Code", { customName: "我的编辑器" }), "我的编辑器")).toBe(0);
  });
});

describe("快捷目标展示排序（完整面板与胶囊共用）", () => {
  const t = (
    name: string,
    opts?: { favorite?: boolean; recent?: string },
  ) => ({
    display_name: name,
    favorite: opts?.favorite ?? false,
    last_used_at: opts?.recent ?? null,
  });

  it("收藏优先 → 最近使用 → 名称", () => {
    const sorted = sortTargetsForDisplay([
      t("B 普通"),
      t("A 收藏", { favorite: true }),
      t("C 最近", { recent: "2026-11-01T00:00:00.000Z" }),
      t("D 更近", { recent: "2026-11-02T00:00:00.000Z" }),
    ]);
    expect(sorted.map((x) => x.display_name)).toEqual([
      "A 收藏",
      "D 更近",
      "C 最近",
      "B 普通",
    ]);
  });

  it("最近使用筛选不重新按收藏优先，保持自身最近语义", () => {
    const sorted = sortTargetsForDisplay(
      [t("收藏但旧", { favorite: true, recent: "2026-10-01T00:00:00.000Z" }), t("新", { recent: "2026-11-01T00:00:00.000Z" })],
      { favorite: false },
    );
    expect(sorted.map((x) => x.display_name)).toEqual(["新", "收藏但旧"]);
  });

  it("无最近语义的分区（网址/文件夹/文件）按收藏后名称", () => {
    const sorted = sortTargetsForDisplay(
      [t("B"), t("A 收藏", { favorite: true }), t("A")],
      { recent: false },
    );
    expect(sorted.map((x) => x.display_name)).toEqual(["A 收藏", "A", "B"]);
  });

  it("不修改入参数组", () => {
    const input = [t("B"), t("A")];
    sortTargetsForDisplay(input);
    expect(input.map((x) => x.display_name)).toEqual(["B", "A"]);
  });
});

describe("无结果与大量结果", () => {
  it("没有匹配时返回空数组", () => {
    expect(searchApps([CHROME, VSCODE], "完全不存在的应用")).toEqual([]);
  });

  it("大量结果不丢失、不截断", () => {
    const many = Array.from({ length: 300 }, (_, i) => app(`微信应用 ${String(i).padStart(3, "0")}`));
    expect(searchApps(many, "微信")).toHaveLength(300);
    expect(APP_PAGE_SIZE).toBeGreaterThan(0);
  });

  it("分类过滤只影响数据范围，不改变匹配规则", () => {
    const im = app("微信", { category: "im" });
    const dev = app("微信开发者工具", { category: "dev" });
    expect(names(searchApps([im, dev], "微信", { category: "im" }))).toEqual(["微信"]);
    expect(names(searchApps([im, dev], "微信", { category: "all" }))).toEqual([
      "微信",
      "微信开发者工具",
    ]);
  });
});
