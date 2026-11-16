//! Profile 注册中心契约测试（P1-01，2026-11-13；A 阶段扩展为五种类型，2026-11-15）。
//!
//! 锁四件事，防止「注册了就等于可用」的退化：
//! 1. 五种 Profile 的导航与首页**必须不同**（否则又退回同一套面板换徽标）；
//! 2. 能力状态必须与真实实现一致（planned/unavailable 不得可调用）；
//! 3. 新增小说类型不得改变原有四种类型的导航/卡片/能力声明；
//! 4. 布局解析对损坏/旧版数据安全回退，切换模块只改 activeModule。

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
import { WORKSPACE_PROFILE_ICONS } from "./workspaceProfileIcons";

const ALL_KINDS = ["development", "game", "ai_comic", "general", "novel"] as const;

describe("Profile 注册中心", () => {
  it("五种类型都有 Profile，类型标签与导航标题正确", () => {
    expect(ALL_KINDS.map((k) => WORKSPACE_PROFILES[k].label)).toEqual([
      "开发",
      "游戏",
      "AI 漫剧",
      "通用",
      "小说",
    ]);

    // 五种导航组合互不相同（小说有自己的专业模块命名）
    const labels = ALL_KINDS.map((k) => WORKSPACE_PROFILES[k].modules.map((m) => m.label).join("|"));
    expect(new Set(labels).size).toBe(5);
    expect(WORKSPACE_PROFILES.development.modules.map((m) => m.label)).toContain("开发事项");
    expect(WORKSPACE_PROFILES.game.modules.map((m) => m.label)).toContain("制作事项");
    expect(WORKSPACE_PROFILES.ai_comic.modules.map((m) => m.label)).toContain("剧集与镜头");
    expect(WORKSPACE_PROFILES.novel.modules.map((m) => m.label)).toEqual([
      "概览",
      "正文",
      "写作事项",
      "任务关联",
      "项目设置",
    ]);
    expect(WORKSPACE_PROFILES.novel.modules.map((m) => m.id)).toEqual([
      "overview",
      "manuscript",
      "items",
      "links",
      "settings",
    ]);
  });

  it("五种类型的首页卡片组合不同（不是同一套模板换标题）", () => {
    const signatures = ALL_KINDS.map((k) =>
      WORKSPACE_PROFILES[k].homeCards.map((c) => `${c.body}:${c.capability}`).join(","),
    );
    expect(new Set(signatures).size).toBe(5);
    expect(WORKSPACE_PROFILES.development.homeCards.some((c) => c.body === "git")).toBe(true);
    expect(WORKSPACE_PROFILES.game.homeCards.some((c) => c.body === "build")).toBe(true);
    expect(WORKSPACE_PROFILES.ai_comic.homeCards.some((c) => c.body === "generate")).toBe(true);
    // 小说首页：基本信息、项目简介、写作事项、任务关联、后续功能规划提示
    expect(WORKSPACE_PROFILES.novel.homeCards.map((c) => c.body)).toEqual([
      "project",
      "note",
      "items",
      "links",
      "roadmap",
    ]);
    expect(WORKSPACE_PROFILES.novel.homeCards.map((c) => c.title)).toEqual([
      "小说项目",
      "项目简介",
      "写作事项",
      "任务关联",
      "后续创作功能",
    ]);
  });

  it("Profile 与首页卡片声明的能力必须在注册表里存在（禁止悬空引用）", () => {
    for (const profile of Object.values(WORKSPACE_PROFILES)) {
      for (const id of profile.capabilities) {
        expect(WORKSPACE_CAPABILITIES[id], `${profile.kind} 能力 ${id}`).toBeTruthy();
      }
      // 卡片也不得引用该类型没有声明的能力（否则徽标/降级文案无处可取）
      for (const card of profile.homeCards) {
        expect(
          WORKSPACE_CAPABILITIES[card.capability],
          `${profile.kind} 卡片 ${card.id}`,
        ).toBeTruthy();
        expect(profile.capabilities, `${profile.kind} 卡片能力未声明`).toContain(card.capability);
      }
    }
  });

  it("能力状态与真实实现一致：未接入的构建/生成/小说专业能力不得可调用", () => {
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

    // 小说专业能力：B1 已接入「正文与章节」；人物/世界观/AI 仍只登记、不实现。
    const manuscript = WORKSPACE_CAPABILITIES["novel.manuscript"];
    expect(manuscript.state).toBe("available");
    expect(manuscript.provider).toContain("novel_volumes");
    expect(manuscript.provider).toContain("novel_chapters");
    expect(manuscript.action).toEqual({ kind: "module", target: "manuscript" });
    expect(manuscript.fallback).toBeTruthy();
    for (const id of ["novel.characters", "novel.worldview", "novel.aiAssist"] as const) {
      expect(WORKSPACE_CAPABILITIES[id].state).toBe("planned");
      expect(WORKSPACE_CAPABILITIES[id].action).toBeUndefined();
      expect(WORKSPACE_CAPABILITIES[id].fallback).toBeTruthy();
    }

    expect(canInvokeCapability("game", "game.build")).toBe(false);
    expect(canInvokeCapability("ai_comic", "comic.generate")).toBe(false);
    // B1：正文与章节已真实可用（模块 + v58 表 + 自动保存）
    expect(canInvokeCapability("novel", "novel.manuscript")).toBe(true);
    // 其余小说专业能力仍不得调用
    expect(canInvokeCapability("novel", "novel.characters")).toBe(false);
    expect(canInvokeCapability("novel", "novel.worldview")).toBe(false);
    expect(canInvokeCapability("novel", "novel.aiAssist")).toBe(false);
    // 跨类型不得调用
    expect(canInvokeCapability("game", "dev.git")).toBe(false);
    expect(canInvokeCapability("game", "novel.manuscript")).toBe(false);
    expect(canInvokeCapability("development", "dev.git")).toBe(true);
    expect(canInvokeCapability("development", "dev.acceptance")).toBe(true); // limited 允许入口
    expect(canInvokeCapability("novel", "core.items")).toBe(true);
    expect(canInvokeCapability("novel", "core.layout")).toBe(true); // limited 允许入口
  });

  it("小说 Profile 的可用能力包含正文与既有四项核心能力", () => {
    const available = capabilitiesFor("novel")
      .filter((c) => c.state === "available" || c.state === "limited")
      .map((c) => c.id)
      .sort();
    expect(available).toEqual([
      "core.items",
      "core.layout",
      "core.project",
      "core.taskLinks",
      "novel.manuscript",
    ]);
  });

  it("原有四种 Profile 的声明未被小说类型改变", () => {
    // 通用工作空间不冒充拥有专业能力
    expect(WORKSPACE_PROFILES.general.capabilities).toEqual([
      "core.project",
      "core.items",
      "core.taskLinks",
      "core.layout",
    ]);
    expect(WORKSPACE_PROFILES.development.capabilities).toContain("dev.git");
    expect(WORKSPACE_PROFILES.game.capabilities).toContain("game.build");
    expect(WORKSPACE_PROFILES.ai_comic.capabilities).toContain("comic.generate");
    // 小说能力不得泄漏到其它类型
    for (const kind of ["development", "game", "ai_comic", "general"]) {
      expect(capabilitiesFor(kind).map((c) => c.id).filter((id) => id.startsWith("novel."))).toEqual(
        [],
      );
    }
    // 每个 Profile 的图标 token 都有真实映射（不是只改类型声明）
    for (const profile of Object.values(WORKSPACE_PROFILES)) {
      expect(WORKSPACE_PROFILE_ICONS[profile.icon], `${profile.kind} 图标缺失`).toBeTruthy();
    }
    expect(WORKSPACE_PROFILES.novel.icon).toBe("book-open");
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
    expect(resolveWorkspaceProfile("novel").kind).toBe("novel");
    // 原型链键不得当成合法 Profile
    expect(resolveWorkspaceProfile("toString").kind).toBe("general");
  });

  it("capabilitiesFor 只返回该类型声明过的能力", () => {
    expect(capabilitiesFor("game").map((c) => c.id)).not.toContain("dev.git");
    expect(capabilitiesFor("development").map((c) => c.id)).toContain("dev.agents");
    expect(capabilitiesFor("novel").map((c) => c.id)).toContain("novel.manuscript");
  });
});

describe("布局解析与模块顺序", () => {
  const dev = WORKSPACE_PROFILES.development;
  const novel = WORKSPACE_PROFILES.novel;

  it('空 / 旧版 "{}" 视为未配置，不标记 repaired 且给默认布局', () => {
    for (const profile of [dev, novel]) {
      expect(parseWorkspaceLayout("", profile).layout).toEqual(defaultLayout(profile));
      expect(parseWorkspaceLayout(null, profile).layout).toEqual(defaultLayout(profile));
      const legacy = parseWorkspaceLayout("{}", profile);
      expect(legacy.layout).toEqual(defaultLayout(profile));
      expect(legacy.repaired).toBe(false);
    }
    // 小说默认布局来自自己的 Profile（概览起步，正文紧随其后）
    expect(defaultLayout(novel).moduleOrder).toEqual([
      "overview",
      "manuscript",
      "items",
      "links",
      "settings",
    ]);
    expect(defaultLayout(novel).activeModule).toBe("overview");
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

  it('切换模块只替换 activeModule，保留用户顺序与隐藏项（不再写 "{}"）', () => {
    const layout: WorkspaceLayoutConfig = {
      version: WORKSPACE_LAYOUT_VERSION,
      moduleOrder: ["items", "overview"],
      hiddenModules: ["links"],
      activeModule: "overview",
    };
    const next = withActiveModule(layout, "settings");
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
    expect(
      resolveModuleOrder(dev, { ...layout, hiddenModules: ["links"] }).map((m) => m.id),
    ).toEqual(["overview", "items", "settings"]);
  });

  it("小说项目读取旧版布局：已有顺序/隐藏保留，缺失模块自动补齐", () => {
    // 旧项目从通用类型切换为小说后，layout_json 仍是旧格式（version=1，两项顺序）
    const legacy: WorkspaceLayoutConfig = {
      version: WORKSPACE_LAYOUT_VERSION,
      moduleOrder: ["items", "overview"],
      hiddenModules: [],
      activeModule: "items",
    };
    expect(resolveModuleOrder(novel, legacy).map((m) => m.id)).toEqual([
      "items",
      "overview",
      "manuscript",
      "links",
      "settings",
    ]);
    // 旧配置里隐藏的模块继续隐藏，不因新增类型被重新显示
    expect(
      resolveModuleOrder(novel, { ...legacy, hiddenModules: ["links"] }).map((m) => m.id),
    ).toEqual(["items", "overview", "manuscript", "settings"]);
    // 旧布局本身是合法 v1，不标记 repaired
    expect(parseWorkspaceLayout(JSON.stringify(legacy), novel).repaired).toBe(false);
  });
});
