// P1-01 主窗口 CDP 目标识别回归（第五轮专项整改）。
//
// 第四轮事故：GUI 验收脚本把 `http://tauri.localhost/context-menu.html`
// （右键菜单辅助窗口）当成主窗口，6 轮全部找不到剪贴板入口。
// 见 docs/clipboard/evidence/p1-05-gui-20261031/p1-05-ui-drive.json。
//
// 本文件用纯函数 + 注入 probe 的方式覆盖任务书 §3.3 的全部场景：
// 不需要真实 CDP / WebView2，判定逻辑与线上驱动共用同一模块
// （scripts/acceptance/cdp-main-window.mjs），保证「测试的逻辑 = 使用的逻辑」。

import { describe, expect, it } from "vitest";
import type { PageIdentity } from "../../scripts/acceptance/cdp-main-window.mjs";
import {
  CONTEXT_MENU_URL_RE,
  MAX_DEADLINE_MS,
  attachMainWindow,
  classifyTargets,
  selectMainWindow,
} from "../../scripts/acceptance/cdp-main-window.mjs";

const MAIN_URL = "http://tauri.localhost/";
const MENU_URL = "http://tauri.localhost/context-menu.html";

function t(id: string, url: string, type = "page", title = "") {
  return { targetId: id, url, title, type };
}

/** 常用身份：主窗口（已挂载）/ 右键菜单 / 未知辅助页面。 */
const idMain: PageIdentity = { label: "main", webviewLabel: "main", tauri: true, mounted: true };
const idMenu: PageIdentity = { label: "context-menu", webviewLabel: "context-menu", tauri: true, mounted: true };

function identities(list: Array<[string, PageIdentity]>): Map<string, PageIdentity> {
  return new Map(list);
}

describe("classifyTargets：URL/类型分类", () => {
  it("context-menu.html 被归入 contextMenu，无论是否带查询参数", () => {
    const r = classifyTargets([t("m", MAIN_URL), t("c", MENU_URL), t("c2", "http://tauri.localhost/context-menu.html?x=1")]);
    expect(r.contextMenu.map((x) => x.targetId)).toEqual(["c", "c2"]);
    expect(r.mainCandidates.map((x) => x.targetId)).toEqual(["m"]);
  });

  it("devtools 与非 page target 被单独归类、不参与主窗口候选", () => {
    const r = classifyTargets([t("d", "devtools://devtools/bundled/inspector.html"), t("sw", "http://tauri.localhost/", "service_worker")]);
    expect(r.devtools).toHaveLength(1);
    expect(r.nonPage).toHaveLength(1);
    expect(r.mainCandidates).toHaveLength(0);
  });
});

describe("selectMainWindow：任务书 §3.3 场景", () => {
  it("只有主窗口 → ok", () => {
    const r = selectMainWindow([t("m", MAIN_URL)], identities([["m", idMain]]));
    expect(r.status).toBe("ok");
    expect(r.target!.targetId).toBe("m");
    expect(r.rationale).toContain("唯一");
  });

  it("只有右键菜单 → not-found，绝不把 context-menu.html 当主窗口", () => {
    const r = selectMainWindow([t("c", MENU_URL)], identities([["c", idMenu]]));
    expect(r.status).toBe("not-found");
    expect(r.rationale).toContain("context-menu");
  });

  it("主窗口与右键菜单同时存在 → 选主窗口", () => {
    const r = selectMainWindow([t("m", MAIN_URL), t("c", MENU_URL)], identities([["m", idMain], ["c", idMenu]]));
    expect(r.status).toBe("ok");
    expect(r.target!.targetId).toBe("m");
    expect(r.seen!.contextMenu).toBe(1);
  });

  it("多个辅助弹窗同时存在 → 仍按 label 选出主窗口", () => {
    const aux: PageIdentity = { label: "paste-window", webviewLabel: "paste-window", tauri: true, mounted: true };
    const targets = [t("m", MAIN_URL), t("a1", "http://tauri.localhost/paste.html"), t("a2", "about:blank"), t("c", MENU_URL)];
    const r = selectMainWindow(targets, identities([["m", idMain], ["a1", aux]]));
    expect(r.status).toBe("ok");
    expect(r.target!.targetId).toBe("m");
  });

  it("主窗口尚未加载完成（mounted=false）→ loading，等待下一轮", () => {
    const r = selectMainWindow([t("m", MAIN_URL)], identities([["m", { ...idMain, mounted: false }]]));
    expect(r.status).toBe("loading");
  });

  it("页面探测失败（无身份）→ not-found，不当主窗口", () => {
    const r = selectMainWindow([t("x", MAIN_URL)], identities([]));
    expect(r.status).toBe("not-found");
    expect(r.rationale).toContain("不可探测");
  });

  it("两个 label===main 的候选 → ambiguous，明确失败不猜", () => {
    const r = selectMainWindow([t("m1", MAIN_URL), t("m2", "http://localhost:1420/")], identities([["m1", idMain], ["m2", idMain]]));
    expect(r.status).toBe("ambiguous");
    expect(r.candidates).toHaveLength(2);
  });

  it("invoke 不可用（tauri=false）→ 不算合格主窗口", () => {
    const r = selectMainWindow([t("m", MAIN_URL)], identities([["m", { ...idMain, tauri: false }]]));
    expect(r.status).toBe("not-found");
  });
});

describe("attachMainWindow：有限重试与断线处理", () => {
  it("主窗口重建后 target 变化 → 重新枚举后选中新 targetId", async () => {
    // 阶段 1：初连拿到 old；阶段 2：旧 target 销毁、重建出 new-1（context-menu 仍在）。
    // 驱动脚本在页面句柄失效时用同一函数重新识别，不沿用旧句柄。
    const probe = async (info: { targetId: string; url: string }) => {
      if (info.targetId === "old" || info.targetId === "new-1") return idMain;
      throw new Error("Target closed");
    };
    const first = await attachMainWindow({
      port: 9333,
      fetchImpl: (async () => ({ ok: true, json: async () => [t("old", MAIN_URL)] })) as unknown as typeof fetch,
      probe,
      now: () => 0, // 冻结时钟：重试由轮次驱动，不引入真实等待
    });
    expect(first.ok).toBe(true);
    expect(first.target!.targetId).toBe("old");

    const second = await attachMainWindow({
      port: 9333,
      fetchImpl: (async () => ({
        ok: true,
        json: async () => [t("new-1", MAIN_URL), t("c", MENU_URL)],
      })) as unknown as typeof fetch,
      probe,
      now: () => 0,
    });
    expect(second.ok).toBe(true);
    expect(second.target!.targetId).toBe("new-1");
    expect(second.log.some((e) => e.decision === "ok")).toBe(true);
  });

  it("CDP 目标断开（枚举持续失败）→ 有限重试后明确失败", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const r = await attachMainWindow({
      port: 9333,
      deadlineMs: 2000,
      intervalMs: 10,
      fetchImpl,
      probe: async () => idMain,
      now: (() => { let n = 0; return () => (n += 1000); })(),
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("CDP 目标枚举持续失败");
    expect(r.log.length).toBeGreaterThan(1);
  });

  it("deadline 内一直 loading → 超时后以最后状态失败（不无限等待）", async () => {
    const fetchImpl = (async () => ({ ok: true, json: async () => [t("m", MAIN_URL)] })) as unknown as typeof fetch;
    let n = 0;
    const r = await attachMainWindow({
      port: 9333,
      deadlineMs: 5000,
      intervalMs: 10,
      fetchImpl,
      probe: async () => ({ ...idMain, mounted: false }),
      now: () => (n += 1000),
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("loading");
  });

  it("ambiguous 立即失败，不等 deadline", async () => {
    const fetchImpl = (async () => ({
      ok: true,
      json: async () => [t("m1", MAIN_URL), t("m2", "http://localhost:1420/")],
    })) as unknown as typeof fetch;
    let calls = 0;
    const r = await attachMainWindow({
      port: 9333,
      deadlineMs: 60000,
      fetchImpl,
      probe: async () => { calls += 1; return idMain; },
      now: () => 0,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("不唯一");
    expect(calls).toBe(2); // 两个候选各探测一次，绝不重试掩盖歧义
  });

  it("deadline 被钳制在 MAX_DEADLINE_MS 内", async () => {
    const fetchImpl = (async () => ({ ok: true, json: async () => [] })) as unknown as typeof fetch;
    const r = await attachMainWindow({
      port: 9333,
      deadlineMs: 10 * 60 * 1000, // 试图传 10 分钟
      intervalMs: 10,
      fetchImpl,
      now: (() => { let n = 0; return () => (n += MAX_DEADLINE_MS); })(),
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain(`${MAX_DEADLINE_MS}ms`);
  });
});

describe("CONTEXT_MENU_URL_RE", () => {
  it.each([
    ["http://tauri.localhost/context-menu.html", true],
    ["http://tauri.localhost/context-menu.htm", true],
    ["http://localhost:1420/context-menu.html?a=1", true],
    ["http://tauri.localhost/", false],
    ["http://tauri.localhost/context-menu-help.html", false],
    ["http://tauri.localhost/index.html", false],
  ])("%s → %s", (url, expected) => {
    expect(CONTEXT_MENU_URL_RE.test(url)).toBe(expected);
  });
});
