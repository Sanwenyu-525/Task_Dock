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
  findNavGroup,
  hasNavGroups,
  parseWorkspaceLayout,
  resolveGroupDefaultModule,
  resolveModuleOrder,
  resolveNavGroups,
  resolveSafeActiveModule,
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
    expect(WORKSPACE_PROFILES.ai_comic.modules.map((m) => m.label)).toContain("分镜");
    expect(WORKSPACE_PROFILES.novel.modules.map((m) => m.label)).toEqual([
      "概览",
      "正文",
      "人物",
      "世界观",
      "写作事项",
      "任务关联",
      "项目设置",
    ]);
    expect(WORKSPACE_PROFILES.novel.modules.map((m) => m.id)).toEqual([
      "overview",
      "manuscript",
      "characters",
      "worldview",
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
    // 2026-11-17：项目页已提供排序/显隐编辑器并真实写回 layout_json。
    expect(WORKSPACE_CAPABILITIES["core.layout"].state).toBe("available");
    expect(WORKSPACE_CAPABILITIES["core.layout"].provider).toContain("布局");
    // 五线（2026-11-16）：前端与编译检查已通过，但 Rust 运行期测试未取得证据，
    // 因此专业能力只能是 limited（可入口 + 明确降级），不得宣称 available。
    expect(WORKSPACE_CAPABILITIES["game.build"].state).toBe("limited");
    expect(WORKSPACE_CAPABILITIES["game.build"].fallback).toContain("未接入");
    expect(WORKSPACE_CAPABILITIES["game.assets"].state).toBe("limited");
    // 未接入生成管线：永远不可调用，即使同类型其它能力已开放。
    expect(WORKSPACE_CAPABILITIES["comic.generate"].state).toBe("unavailable");
    expect(WORKSPACE_CAPABILITIES["comic.shots"].state).toBe("limited");
    expect(WORKSPACE_CAPABILITIES["comic.shots"].provider).toContain("comic_shots");

    // 小说专业能力：B1 正文已 available；B2 人物/世界观已落盘但运行期测试未取证 → limited；
    // AI 辅助仍只登记、不实现。
    const manuscript = WORKSPACE_CAPABILITIES["novel.manuscript"];
    expect(manuscript.state).toBe("available");
    expect(manuscript.provider).toContain("novel_volumes");
    expect(manuscript.provider).toContain("novel_chapters");
    expect(manuscript.action).toEqual({ kind: "module", target: "manuscript" });
    expect(manuscript.fallback).toBeTruthy();
    for (const id of ["novel.characters", "novel.worldview"] as const) {
      expect(WORKSPACE_CAPABILITIES[id].state).toBe("limited");
      expect(WORKSPACE_CAPABILITIES[id].provider).toContain("v59");
      expect(WORKSPACE_CAPABILITIES[id].fallback).toBeTruthy();
    }
    expect(WORKSPACE_CAPABILITIES["novel.aiAssist"].state).toBe("planned");
    expect(WORKSPACE_CAPABILITIES["novel.aiAssist"].action).toBeUndefined();

    expect(canInvokeCapability("game", "game.build")).toBe(true); // limited 允许入口，降级文案必读
    expect(canInvokeCapability("ai_comic", "comic.generate")).toBe(false);
    // B1：正文与章节已真实可用（模块 + v58 表 + 自动保存）
    expect(canInvokeCapability("novel", "novel.manuscript")).toBe(true);
    expect(canInvokeCapability("novel", "novel.characters")).toBe(true);
    expect(canInvokeCapability("novel", "novel.worldview")).toBe(true);
    expect(canInvokeCapability("novel", "novel.aiAssist")).toBe(false);
    // 跨类型不得调用
    expect(canInvokeCapability("game", "dev.git")).toBe(false);
    expect(canInvokeCapability("game", "novel.manuscript")).toBe(false);
    expect(canInvokeCapability("development", "dev.git")).toBe(true);
    expect(canInvokeCapability("development", "dev.acceptance")).toBe(true); // limited 允许入口
    expect(canInvokeCapability("novel", "core.items")).toBe(true);
    expect(canInvokeCapability("novel", "core.layout")).toBe(true); // limited 允许入口
  });

  it("小说 Profile 的可用能力包含正文、人物、世界观与既有四项核心能力", () => {
    const available = capabilitiesFor("novel")
      .filter((c) => c.state === "available" || c.state === "limited")
      .map((c) => c.id)
      .sort();
    expect(available).toEqual([
      "core.items",
      "core.layout",
      "core.project",
      "core.taskLinks",
      "novel.characters",
      "novel.manuscript",
      "novel.worldview",
    ]);
  });

  it("原有四种 Profile 的声明未被小说类型改变", () => {
    // 通用工作空间不冒充拥有专业能力：只声明 core.* + 本轮 U1 的四项通用专业能力
    expect(WORKSPACE_PROFILES.general.capabilities).toEqual([
      "core.project",
      "core.items",
      "core.taskLinks",
      "core.layout",
      "general.templates",
      "general.milestones",
      "general.materials",
      "general.delivery",
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
    // 小说默认布局来自自己的 Profile（概览起步，正文紧随其后，人物与世界观随后）
    expect(defaultLayout(novel).moduleOrder).toEqual([
      "overview",
      "manuscript",
      "characters",
      "worldview",
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
    expect(modules.map((m) => m.id)).toEqual([
      "links",
      "overview",
      "git",
      "agents",
      "builds",
      "settings",
    ]);
    // 隐藏不存在的模块不影响其他模块
    expect(
      resolveModuleOrder(dev, { ...layout, hiddenModules: ["links"] }).map((m) => m.id),
    ).toEqual(["overview", "items", "git", "agents", "builds", "settings"]);
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
      "characters",
      "worldview",
      "links",
      "settings",
    ]);
    // 旧配置里隐藏的模块继续隐藏，不因新增类型被重新显示
    expect(
      resolveModuleOrder(novel, { ...legacy, hiddenModules: ["links"] }).map((m) => m.id),
    ).toEqual(["items", "overview", "manuscript", "characters", "worldview", "settings"]);
    // 旧布局本身是合法 v1，不标记 repaired
    expect(parseWorkspaceLayout(JSON.stringify(legacy), novel).repaired).toBe(false);
  });
});

describe("展示层导航分组（小说，2026-11-20）", () => {
  const novel = WORKSPACE_PROFILES.novel;

  it("只有小说声明分组；七个模块 ID 全都保留且只归属一个分组", () => {
    expect(hasNavGroups(novel)).toBe(true);
    for (const kind of ["development", "game", "ai_comic", "general"] as const) {
      expect(hasNavGroups(WORKSPACE_PROFILES[kind])).toBe(false);
    }
    // 模块 ID 没有被删减或改名
    expect(novel.modules.map((m) => m.id)).toEqual([
      "overview",
      "manuscript",
      "characters",
      "worldview",
      "items",
      "links",
      "settings",
    ]);
    const grouped = (novel.navGroups ?? []).flatMap((g) => g.modules);
    expect(new Set(grouped).size).toBe(grouped.length);
    expect([...grouped].sort()).toEqual([...novel.modules.map((m) => m.id)].sort());
    expect(findNavGroup(novel, "characters")?.label).toBe("设定");
    expect(findNavGroup(novel, "links")?.label).toBe("推进");
    expect(findNavGroup(novel, "overview")?.label).toBe("概览");
  });

  it("默认布局渲染五个一级入口，设定/推进各有二级模块", () => {
    const groups = resolveNavGroups(novel, defaultLayout(novel));
    expect(groups.map((g) => g.label)).toEqual(["概览", "正文", "设定", "推进", "项目设置"]);
    expect(groups.map((g) => g.id)).toEqual([
      "overview",
      "manuscript",
      "setting",
      "progress",
      "settings",
    ]);
    const setting = groups.find((g) => g.id === "setting");
    expect(setting?.modules.map((m) => m.label)).toEqual(["人物", "世界观"]);
    expect(setting?.defaultModule).toBe("characters");
    const progress = groups.find((g) => g.id === "progress");
    expect(progress?.modules.map((m) => m.label)).toEqual(["写作事项", "任务关联"]);
    expect(progress?.defaultModule).toBe("items");
    // 单模块分组不产生额外子模块
    expect(groups.find((g) => g.id === "overview")?.modules.map((m) => m.id)).toEqual(["overview"]);
  });

  it("分组顺序跟随现有 moduleOrder（旧布局或用户排序都生效）", () => {
    const layout: WorkspaceLayoutConfig = {
      version: WORKSPACE_LAYOUT_VERSION,
      moduleOrder: ["overview", "items", "links", "manuscript", "characters", "worldview", "settings"],
      hiddenModules: [],
      activeModule: "overview",
    };
    expect(resolveNavGroups(novel, layout).map((g) => g.label)).toEqual([
      "概览",
      "推进",
      "正文",
      "设定",
      "项目设置",
    ]);
    // 组内顺序同样由 moduleOrder 决定
    const reversed: WorkspaceLayoutConfig = {
      ...layout,
      moduleOrder: ["overview", "worldview", "characters", "manuscript", "links", "items", "settings"],
    };
    const groups = resolveNavGroups(novel, reversed);
    expect(groups.find((g) => g.id === "setting")?.modules.map((m) => m.id)).toEqual([
      "worldview",
      "characters",
    ]);
    expect(groups.find((g) => g.id === "progress")?.modules.map((m) => m.id)).toEqual([
      "links",
      "items",
    ]);
  });

  it("隐藏人物但保留世界观：设定入口仍显示并落在世界观；整组隐藏则不显示", () => {
    const onlyWorldview: WorkspaceLayoutConfig = {
      ...defaultLayout(novel),
      hiddenModules: ["characters"],
    };
    const groups = resolveNavGroups(novel, onlyWorldview);
    expect(groups.map((g) => g.label)).toContain("设定");
    expect(groups.find((g) => g.id === "setting")?.modules.map((m) => m.id)).toEqual(["worldview"]);
    expect(groups.find((g) => g.id === "setting")?.defaultModule).toBe("worldview");
    expect(resolveGroupDefaultModule(novel, onlyWorldview, "setting")).toBe("worldview");

    const settingHidden: WorkspaceLayoutConfig = {
      ...defaultLayout(novel),
      hiddenModules: ["characters", "worldview"],
    };
    expect(resolveNavGroups(novel, settingHidden).map((g) => g.label)).toEqual([
      "概览",
      "正文",
      "推进",
      "项目设置",
    ]);
    expect(resolveGroupDefaultModule(novel, settingHidden, "setting")).toBeNull();

    // 单模块分组全部隐藏后同样消失
    expect(
      resolveNavGroups(novel, { ...defaultLayout(novel), hiddenModules: ["manuscript", "settings"] }).map(
        (g) => g.label,
      ),
    ).toEqual(["概览", "设定", "推进"]);
  });

  it("当前模块被隐藏时优先回退到同组可见模块，再回退概览", () => {
    const hiddenCharacters: WorkspaceLayoutConfig = {
      ...defaultLayout(novel),
      activeModule: "characters",
      hiddenModules: ["characters"],
    };
    expect(resolveSafeActiveModule(novel, hiddenCharacters)).toBe("worldview");

    const hiddenItems: WorkspaceLayoutConfig = {
      ...defaultLayout(novel),
      activeModule: "items",
      hiddenModules: ["items"],
    };
    expect(resolveSafeActiveModule(novel, hiddenItems)).toBe("links");

    const hiddenProgress: WorkspaceLayoutConfig = {
      ...defaultLayout(novel),
      activeModule: "items",
      hiddenModules: ["items", "links"],
    };
    expect(resolveSafeActiveModule(novel, hiddenProgress)).toBe("overview");

    // 仍是可见模块时保持原值
    expect(resolveSafeActiveModule(novel, { ...defaultLayout(novel), activeModule: "settings" })).toBe(
      "settings",
    );
    // 其他类型没有分组：隐藏后直接回退概览
    expect(
      resolveSafeActiveModule(WORKSPACE_PROFILES.development, {
        ...defaultLayout(WORKSPACE_PROFILES.development),
        activeModule: "items",
        hiddenModules: ["items"],
      }),
    ).toBe("overview");
  });
});

describe("创作工作台五线模块注册（2026-11-16）", () => {
  it("五种类型各自具备自己的生产流程模块，不复用同一套导航", () => {
    expect(WORKSPACE_PROFILES.novel.modules.map((m) => m.id)).toEqual(
      expect.arrayContaining(["manuscript", "characters", "worldview"]),
    );
    expect(WORKSPACE_PROFILES.game.modules.map((m) => m.id)).toEqual(
      expect.arrayContaining(["items", "assets", "builds"]),
    );
    expect(WORKSPACE_PROFILES.ai_comic.modules.map((m) => m.id)).toEqual(
      expect.arrayContaining(["episodes", "shots", "characters", "assets"]),
    );
    expect(WORKSPACE_PROFILES.general.modules.map((m) => m.id)).toEqual(
      expect.arrayContaining(["milestones", "materials"]),
    );
    expect(WORKSPACE_PROFILES.development.modules.map((m) => m.id)).toEqual(
      expect.arrayContaining(["git", "agents", "builds"]),
    );
    // 任何类型都不得缺少「概览」落点，否则没有可打开的默认页
    for (const profile of Object.values(WORKSPACE_PROFILES)) {
      expect(profile.modules.map((m) => m.id)).toContain("overview");
      expect(profile.defaultModule).toBe("overview");
      // 同一类型内模块 ID 不得重复（重复会让 tab key 冲突、布局解析去重后丢项）
      expect(new Set(profile.modules.map((m) => m.id)).size).toBe(profile.modules.length);
    }
  });

  it("每个声明模块的 ID 都是布局合法值（否则切换模块后无法持久化）", () => {
    for (const profile of Object.values(WORKSPACE_PROFILES)) {
      const ids = profile.modules.map((m) => m.id);
      const parsed = parseWorkspaceLayout(
        JSON.stringify({
          version: WORKSPACE_LAYOUT_VERSION,
          moduleOrder: ids,
          hiddenModules: [],
          activeModule: profile.defaultModule,
        }),
        profile,
      );
      expect(parsed.repaired).toBe(false);
      // 全部保留：说明 isModuleId 已覆盖五线新增的每个模块
      expect(parsed.layout.moduleOrder).toEqual(ids);
    }
  });

  it("五线专业能力：状态诚实（非 planned 必须有真实 provider），未接入项永不可调用", () => {
    const delivered = [
      "novel.characters",
      "novel.worldview",
      "game.projectDetect",
      "game.test",
      "game.assets",
      "game.build",
      "comic.episodes",
      "comic.shots",
      "comic.characters",
      "comic.assets",
      "comic.scripts",
      "comic.review",
      "general.templates",
      "general.milestones",
      "general.materials",
      "dev.gitRisk",
      "dev.taskHandoff",
      "dev.buildTrace",
    ] as const;
    for (const id of delivered) {
      const cap = WORKSPACE_CAPABILITIES[id];
      expect(cap, `能力 ${id} 未登记`).toBeTruthy();
      // 已交付但运行期测试未取证：只能 limited，且不得出现「未接入」式 provider
      expect(cap.state, `能力 ${id} 状态`).toBe("limited");
      expect(cap.provider, `能力 ${id} provider`).not.toContain("未接入");
      expect(cap.fallback, `能力 ${id} 缺少降级说明`).toBeTruthy();
    }
    // 明确不提供/只预留的，仍必须被闸门挡住
    expect(WORKSPACE_CAPABILITIES["comic.generate"].state).toBe("unavailable");
    expect(WORKSPACE_CAPABILITIES["novel.aiAssist"].state).toBe("planned");
    expect(WORKSPACE_CAPABILITIES["general.delivery"].state).toBe("planned");
    expect(canInvokeCapability("general", "general.delivery")).toBe(false);
    // 跨媒介引用只预留：不得被任何 Profile 声明，永远不可调用
    expect(WORKSPACE_CAPABILITIES["core.mediaLink"].state).toBe("planned");
    for (const profile of Object.values(WORKSPACE_PROFILES)) {
      expect(profile.capabilities).not.toContain("core.mediaLink");
      expect(canInvokeCapability(profile.kind, "core.mediaLink")).toBe(false);
    }
    expect(canInvokeCapability("ai_comic", "comic.generate")).toBe(false);
  });
});
