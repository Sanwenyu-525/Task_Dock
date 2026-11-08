//! commandRegistry 契约测试：动作白名单（危险动作拒绝登记）、派生完整性、
//! 匹配口径（连续子串、大小写不敏感、中英文）、默认列表边界与动态实体降级。

import { describe, expect, it } from "vitest";

import {
  buildScenarioCommands,
  buildStaticCommands,
  buildWorkflowCommands,
  defaultCommands,
  EXECUTABLE_ACTION_KINDS,
  filterCommands,
  isExecutableActionKind,
  NAV_PAGE_COMMANDS,
  SETTINGS_SECTION_COMMANDS,
  visibleCommands,
  type CommandDef,
} from "./commandRegistry";
import { NAV_ENTRIES } from "./navigationRegistry";
import { SETTINGS_SECTION_META } from "./settingsCategories";
import { zhCN } from "../locales/zh-CN";
import { enUS } from "../locales/en-US";
import { SETTINGS_SECTION_IDS } from "./settingsSections";

/** 用 zh-CN 词典做翻译（键由编译期 MessageKey 保证存在；运行时再兜底断言）。 */
const t = (key: keyof typeof zhCN): string => zhCN[key];

describe("命令注册表契约（危险动作拒绝登记）", () => {
  const all = buildStaticCommands();

  it("每条命令的动作都在白名单内（打开/跳转/草稿/运行类）", () => {
    for (const cmd of all) {
      expect(
        isExecutableActionKind(cmd.action.kind),
        `${cmd.id} 的动作 ${cmd.action.kind} 不在白名单`,
      ).toBe(true);
    }
  });

  it("命令 ID 不含危险语义词（删除/清空/覆盖/批量/停用等永不进面板）", () => {
    const dangerous = /delete|remove|clear|wipe|disable|overwrite|batch|toggle|pause|cancel|删除|清空|清除|覆盖|批量|停用|暂停|取消/;
    for (const cmd of all) {
      expect(dangerous.test(cmd.id), `${cmd.id} 命中危险词`).toBe(false);
    }
  });

  it("命令 ID 唯一", () => {
    const ids = all.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("静态命令的 i18n 键在 zh-CN 与 en-US 都存在", () => {
    for (const cmd of all) {
      if (cmd.titleKey) {
        expect(zhCN[cmd.titleKey], `${cmd.titleKey} 缺 zh-CN`).toBeTruthy();
        expect(enUS[cmd.titleKey], `${cmd.titleKey} 缺 en-US`).toBeTruthy();
      }
      expect(zhCN[cmd.subtitleKey], `${cmd.subtitleKey} 缺 zh-CN`).toBeTruthy();
      expect(enUS[cmd.subtitleKey], `${cmd.subtitleKey} 缺 en-US`).toBeTruthy();
    }
  });
});

describe("派生完整性（不复制第二份清单）", () => {
  it("导航注册表每个入口都有对应打开命令，且动作 Tab 属于该入口", () => {
    const byId = new Map(NAV_PAGE_COMMANDS.map((c) => [c.id, c]));
    for (const entry of NAV_ENTRIES) {
      const cmd = byId.get(`nav.${entry.id}`);
      expect(cmd, `入口 ${entry.id} 缺少命令`).toBeTruthy();
      expect(entry.tabs).toContain((cmd!.action as { tab: string }).tab);
    }
    expect(NAV_PAGE_COMMANDS).toHaveLength(NAV_ENTRIES.length);
  });

  it("设置分组注册表每个分组都有对应命令，且别名并入关键词", () => {
    const byId = new Map(SETTINGS_SECTION_COMMANDS.map((c) => [c.id, c]));
    for (const meta of SETTINGS_SECTION_META) {
      const cmd = byId.get(`settings.${meta.id}`);
      expect(cmd, `设置分组 ${meta.id} 缺少命令`).toBeTruthy();
      for (const alias of meta.aliases ?? []) {
        expect(cmd!.keywords).toContain(alias);
      }
    }
    expect(SETTINGS_SECTION_COMMANDS).toHaveLength(SETTINGS_SECTION_IDS.length);
  });

  it("白名单常量本身不含危险动作类型", () => {
    expect(EXECUTABLE_ACTION_KINDS).toEqual([
      "open-tab",
      "quick-add",
      "reminder-draft",
      "open-settings-section",
      "open-scenario",
      "run-workflow",
    ]);
  });
});

describe("默认列表（空查询）", () => {
  it("包含新建任务与创建提醒，且排在最前", () => {
    const list = defaultCommands();
    expect(list[0].id).toBe("create.task");
    expect(list[1].id).toBe("create.reminder");
  });

  it("包含打开页面命令，但不含设置分组命令", () => {
    const list = defaultCommands();
    expect(list.some((c) => c.group === "page")).toBe(true);
    expect(list.some((c) => c.group === "settings")).toBe(false);
    expect(list.every((c) => c.group === "create" || c.group === "page")).toBe(true);
  });
});

describe("关键词匹配（与数据搜索一致：连续子串、大小写不敏感）", () => {
  it("空查询返回空列表（默认列表由 defaultCommands 提供）", () => {
    expect(filterCommands(buildStaticCommands(), "", t)).toEqual([]);
    expect(filterCommands(buildStaticCommands(), "   ", t)).toEqual([]);
  });

  it("中文子串命中命令标题（剪贴 → 剪贴板页面与剪贴板设置分组）", () => {
    const hits = filterCommands(buildStaticCommands(), "剪贴", t);
    const ids = hits.map((c) => c.id);
    expect(ids).toContain("nav.clipboard");
    expect(ids).toContain("settings.clipboard");
  });

  it("英文不区分大小写（clip 命中同上）", () => {
    const ids = filterCommands(buildStaticCommands(), "CLIP", t).map((c) => c.id);
    expect(ids).toContain("nav.clipboard");
  });

  it("别名参与匹配（theme → 外观与主题设置分组）", () => {
    const ids = filterCommands(buildStaticCommands(), "theme", t).map((c) => c.id);
    expect(ids).toContain("settings.appearance");
  });

  it("不连续字符不命中（连续子串口径）", () => {
    const ids = filterCommands(buildStaticCommands(), "剪贴t", t).map((c) => c.id);
    expect(ids).not.toContain("nav.clipboard");
  });

  it("结果数量有上限，防止淹没数据结果", () => {
    const many: CommandDef[] = Array.from({ length: 30 }, (_, i) => ({
      id: `scenario.s${i}`,
      group: "scenario" as const,
      title: `场景-${i}`,
      subtitleKey: "commandPalette.subEnterScenario",
      keywords: [],
      icon: () => null,
      action: { kind: "open-scenario" as const, scenarioId: `s${i}`, name: `场景-${i}` },
    }));
    const hits = filterCommands(many, "场景", t);
    expect(hits.length).toBeLessThanOrEqual(12);
  });
});

describe("动态实体命令（场景/工作流）", () => {
  it("列表为空或未加载时降级为空（不伪造命令）", () => {
    expect(buildScenarioCommands(null)).toEqual([]);
    expect(buildScenarioCommands(undefined)).toEqual([]);
    expect(buildScenarioCommands([])).toEqual([]);
    expect(buildWorkflowCommands([])).toEqual([]);
  });

  it("场景实体 → 进入场景命令（携带真实 id 与名称）", () => {
    const [cmd, ...rest] = buildScenarioCommands([{ id: "s1", name: "开工" }]);
    expect(rest).toHaveLength(0);
    expect(cmd.id).toBe("scenario.s1");
    expect(cmd.title).toBe("开工");
    expect(cmd.action).toEqual({ kind: "open-scenario", scenarioId: "s1", name: "开工" });
  });

  it("工作流实体 → 运行工作流命令；停用的工作流不进列表", () => {
    const cmds = buildWorkflowCommands([
      { id: "w1", name: "每日构建", enabled: true },
      { id: "w2", name: "停用流程", enabled: false },
    ]);
    expect(cmds).toHaveLength(1);
    expect(cmds[0].id).toBe("workflow.w1");
    expect(cmds[0].action).toEqual({ kind: "run-workflow", workflowId: "w1", name: "每日构建" });
  });

  it("visibleCommands：空查询给默认列表；有关键词在全量（含动态）里过滤", () => {
    const all = [
      ...buildStaticCommands(),
      ...buildScenarioCommands([{ id: "s1", name: "写作场景" }]),
      ...buildWorkflowCommands([{ id: "w1", name: "晨间流程", enabled: true }]),
    ];
    const empty = visibleCommands(all, "", t);
    expect(empty.some((c) => c.id === "create.task")).toBe(true);
    expect(empty.some((c) => c.id === "scenario.s1")).toBe(false);

    const byName = visibleCommands(all, "写作", t);
    expect(byName.map((c) => c.id)).toEqual(["scenario.s1"]);

    const byWorkflow = visibleCommands(all, "晨间", t);
    expect(byWorkflow.map((c) => c.id)).toEqual(["workflow.w1"]);
  });
});
