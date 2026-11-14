//! P1-01 注册中心契约测试（2026-11-13）。
//!
//! 锁三件事，防止「注册了就等于可用」的退化：
//! 1. 四种 Profile 的导航与首页**必须不同**（否则又退回同一套面板换徽标）；
//! 2. 能力状态必须与真实实现一致（planned/unavailable 不得可调用）；
//! 3. 布局解析对损坏/旧版数据安全回退，切换模块只改 activeModule。

import { describe, expect, it } from "vitest";

import {
  CAPABILITY_STATE_LABEL,
  WORKSPACE_CAPABILITIES,
  WORKSPACE_PROFILES,
  canInvokeCapability,
  capabilitiesFor,
  defaultLayout,
  parseWorkspaceLayout,
  resolveModuleOrder,
  resolveWorkspaceProfile,
  withActiveModule,
  WORKSPACE_LAYOUT_VERSION,
  type WorkspaceLayoutConfig,
} from "./workspaceProfiles";

describe("Profile 注册中心", () => {
  it("四种类型都有 Profile，且导航标题不同", () => {
    const kinds = ["development", "game", "ai_comic", "general"] as const;
    const labels = kinds.map((k) => WORKSPACE_PROFILES[k].modules.map((m) => m.label).join("|"));
    expect(new Set(labels).size).toBe(4);
    expect(WORKSPACE_PROFILES.development.modules.map((m) => m.label)).toContain("开发事项");
    expect(WORKSPACE_PROFILES.game.modules.map((m) => m.label)).toContain("制作事项");
    expect(WORKSPACE_PROFILES.ai_comic.modules.map((m) => m.label)).toContain("剧集与镜头");
  });

  it("四种类型的首页卡片组合不同（不是同一套模板换标题）", () => {
    const signatures = (["development", "game", "ai_comic", "general"] as const).map((k) =>
      WORKSPACE_PROFILES[k].homeCards.map((c) => c.body).join(","),
    );
    expect(new Set(signatures).size).toBe(4);
    expect(WORKSPACE_PROFILES.development.homeCards.some((c) => c.body === "git")).toBe(true);
    expect(WORKSPACE_PROFILES.game.homeCards.some((c) => c.body === "build")).toBe(true);
    expect(WORKSPACE_PROFILES.ai_comic.homeCards.some((c) => c.body === "generate")).toBe(true);
    // 通用工作空间不冒充拥有专业能力
    expect(WORKSPACE_PROFILES.general.capabilities).toEqual([
      "core.project",
      "core.items",
      "core.taskLinks",
      "core.layout",
    ]);
  });

  it("Profile 声明的能力必须在注册表里存在（禁止悬空引用）", () => {
    for (const profile of Object.values(WORKSPACE_PROFILES)) {
      for (const id of profile.capabilities) {
        expect(WORKSPACE_CAPABILITIES[id], `${profile.kind} → ${id}`).toBeTruthy();
      }
    }
  });

  it("能力状态与真实实现一致：未接入的构建/生成不得可调用", () => {
    expect(WORKSPACE_CAPABILITIES["dev.git"].state).toBe("available");
    expect(WORKSPACE_CAPABILITIES["dev.git"].provider).toContain("dev_project_probe");
    expect(WORKSPACE_CAPABILITIES["dev.agents"].provider).toContain("AgentHub");
    expect(WORKSPACE_CAPABILITIES["dev.acceptance"].state).toBe("limited");
    // 布局字段支持排序/隐藏，但当前没有编辑入口：只能声明受限，不能宣称可自定义。
    expect(WORKSPACE_CAPABILITIES["core.layout"].state).toBe("limited");
    expect(WORKSPACE_CAPABILITIES["core.layout"].fallback).toBeTruthy();
    expect(WORKSPACE_CAPABILITIES["game.build"].state).toBe("planned");
    expect(WORKSPACE_CAPABILITIES["game.assets"].state).toBe("planned");
    expect(WORKSPACE_CAPABILITIES["comic.generate"].state).toBe("unavailable");
    expect(WORKSPACE_CAPABILITIES["comic.shots"].state).toBe("limited");

    expect(canInvokeCapability("game", "game.build")).toBe(false);
    expect(canInvokeCapability("ai_comic", "comic.generate")).toBe(false);
    expect(canInvokeCapability("game", "dev.git")).toBe(false); // 跨类型不得调用
    expect(canInvokeCapability("development", "dev.git")).toBe(true);
    expect(canInvokeCapability("development", "dev.acceptance")).toBe(true); // limited 允许入口
    expect(canInvokeCapability("general", "core.items")).toBe(true);
  });

  it("每种状态都有可区分的中文文案", () => {
    expect(CAPABILITY_STATE_LABEL.available).not.toBe(CAPABILITY_STATE_LABEL.planned);
    expect(CAPABILITY_STATE_LABEL.unavailable).not.toBe(CAPABILITY_STATE_LABEL.limited);
  });

  it("未知 / 旧版本类型安全降级为通用 Profile", () => {
    expect(resolveWorkspaceProfile("unknown-kind").kind).toBe("general");
    expect(resolveWorkspaceProfile("").kind).toBe("general");
    expect(resolveWorkspaceProfile(null).kind).toBe("general");
    expect(resolveWorkspaceProfile("development").kind).toBe("development");
    // 原型链键不得当成合法 Profile
    expect(resolveWorkspaceProfile("toString").kind).toBe("general");
  });

  it("capabilitiesFor 只返回该类型声明过的能力", () => {
    expect(capabilitiesFor("game").map((c) => c.id)).not.toContain("dev.git");
    expect(capabilitiesFor("development").map((c) => c.id)).toContain("dev.agents");
  });
});

describe("布局解析与模块顺序", () => {
  const dev = WORKSPACE_PROFILES.development;

  it("空 / 旧版 \"{}\" 视为未配置，不标记 repaired 且给默认布局", () => {
    expect(parseWorkspaceLayout("", dev).layout).toEqual(defaultLayout(dev));
    expect(parseWorkspaceLayout(null, dev).layout).toEqual(defaultLayout(dev));
    const legacy = parseWorkspaceLayout("{}", dev);
    expect(legacy.layout).toEqual(defaultLayout(dev));
    expect(legacy.repaired).toBe(false);
  });

  it("损坏 JSON / 非对象 / 数组安全回退（不抛错）", () => {
    for (const bad of ["{oops", "[]", "null", "42", '"str"']) {
      const parsed = parseWorkspaceLayout(bad, dev);
      expect(parsed.layout).toEqual(defaultLayout(dev));
      expect(parsed.repaired).toBe(true);
    }
  });

  it("版本不符时回默认布局并标记 repaired", () => {
    const parsed = parseWorkspaceLayout(
      JSON.stringify({ version: 99, moduleOrder: ["items"], activeModule: "items" }),
      dev,
    );
    expect(parsed.layout).toEqual(defaultLayout(dev));
    expect(parsed.repaired).toBe(true);
  });

  it("合法布局保留顺序 / 隐藏项 / 活跃模块，并剔除非法值", () => {
    const parsed = parseWorkspaceLayout(
      JSON.stringify({
        version: 1,
        moduleOrder: ["items", "bogus", "overview", "items"],
        hiddenModules: ["links", "overview", "bogus"],
        activeModule: "items",
      }),
      dev,
    );
    expect(parsed.repaired).toBe(false);
    expect(parsed.layout.moduleOrder).toEqual(["items", "overview"]);
    expect(parsed.layout.hiddenModules).toEqual(["links"]); // overview 不可隐藏
    expect(parsed.layout.activeModule).toBe("items");
  });

  it("切换模块只替换 activeModule，保留用户顺序与隐藏项（不再写 \"{}\"）", () => {
    const layout = {
      version: 1 as const,
      moduleOrder: ["items", "overview"] as const,
      hiddenModules: ["links"] as const,
      activeModule: "overview" as const,
    };
    const next = withActiveModule({ ...layout, moduleOrder: [...layout.moduleOrder], hiddenModules: [...layout.hiddenModules] }, "settings");
    expect(next.activeModule).toBe("settings");
    expect(next.moduleOrder).toEqual(["items", "overview"]);
    expect(next.hiddenModules).toEqual(["links"]);
  });

  it("模块顺序：Profile 为底 + 用户顺序 + 剔除隐藏 + 追加 Profile 新模块", () => {
    const layout: WorkspaceLayoutConfig = {
      version: WORKSPACE_LAYOUT_VERSION,
      moduleOrder: ["links", "overview"],
      hiddenModules: ["items"],
      activeModule: "overview",
    };
    const modules = resolveModuleOrder(dev, layout);
    expect(modules.map((m) => m.id)).toEqual(["links", "overview", "settings"]);
    // 隐藏不存在的模块不影响其他模块
    expect(resolveModuleOrder(dev, { ...layout, hiddenModules: ["links"] }).map((m) => m.id)).toEqual([
      "overview",
      "items",
      "settings",
    ]);
  });
});
