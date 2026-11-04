//! 功能目录契约测试：12 项核心功能数量锁定、ID 唯一性、字段与状态口径校验。
//! 这是「防止后续迭代遗漏核心功能」的自动化防线（规划页与 ROADMAP.md 均派生自此处）。

import { describe, expect, it } from "vitest";
import {
  CATEGORY_META,
  CATEGORY_ORDER,
  CORE_FEATURE_COUNT,
  CORE_FEATURE_IDS,
  FEATURE_CATALOG,
  featureCatalogSummary,
  featuresByCategory,
  getFeatureById,
  type FeatureStatus,
} from "./featureCatalog";

describe("12 项核心功能登记", () => {
  it("核心功能常量数量锁定为 12", () => {
    expect(CORE_FEATURE_COUNT).toBe(12);
    expect(CORE_FEATURE_IDS).toHaveLength(12);
  });

  it("12 个固定 ID 在目录中全部存在且不重复登记", () => {
    for (const id of CORE_FEATURE_IDS) {
      expect(getFeatureById(id), `核心功能 ${id} 未登记`).toBeTruthy();
    }
    // 核心功能按 P0/P1/P2 分属 core/workflow/info 三个分区，
    // 「核心」由固定 ID 集合定义，而不是某个单一分类
    const idsInCatalog = FEATURE_CATALOG.map((f) => f.id);
    const coreOccurrences = idsInCatalog.filter((id) => (CORE_FEATURE_IDS as readonly string[]).includes(id));
    expect(coreOccurrences).toHaveLength(12);
  });

  it("P0 五项登记在 core 分区，P1/P2 核心项分属 workflow/info 分区", () => {
    for (const id of CORE_FEATURE_IDS) {
      const f = getFeatureById(id)!;
      if (f.priority === "P0") expect(f.category, `${id}`).toBe("core");
      if (f.priority === "P1") expect(f.category, `${id}`).toBe("workflow");
      if (f.priority === "P2") expect(f.category, `${id}`).toBe("info");
    }
  });

  it("12 项核心功能 P0/P1/P2 分层正确（5 + 5 + 2）", () => {
    const byPriority = { P0: 0, P1: 0, P2: 0 } as Record<string, number>;
    for (const id of CORE_FEATURE_IDS) {
      const f = getFeatureById(id)!;
      byPriority[f.priority] += 1;
    }
    expect(byPriority.P0).toBe(5);
    expect(byPriority.P1).toBe(5);
    expect(byPriority.P2).toBe(2);
  });

  it("全局搜索固定 ID 不重命名，且属于 P1 / workflow", () => {
    expect(CORE_FEATURE_IDS).toContain("core.global-search");
    const f = getFeatureById("core.global-search")!;
    expect(f.title).toBe("全局搜索");
    expect(f.priority).toBe("P1");
    expect(f.category).toBe("workflow");
    // v0.9：统一检索层与八类跳转落地；已发现应用/FTS5 仍在缺口清单 → partial
    expect(f.status).toBe("partial");
  });

  it("快速笔记与生活例行事项保持 P2 / info", () => {
    for (const id of ["core.quick-notes", "core.life-routines"]) {
      const f = getFeatureById(id)!;
      expect(f.priority, `${id} 优先级`).toBe("P2");
      expect(f.category, `${id} 分类`).toBe("info");
    }
  });

  it("已实现的核心功能没有被错误标记为待开发（行动中心已落地）", () => {
    const actionCenter = getFeatureById("core.agent-action-center");
    expect(actionCenter?.status).toBe("implemented");
    expect(actionCenter?.verification).toBe("verified");
    expect(actionCenter?.existingFeatures.length).toBeGreaterThan(0);
  });

  it("全局快速捕获已落地为独立捕获窗口（不再以 partial 登记）", () => {
    const f = getFeatureById("core.quick-capture")!;
    expect(f.status).toBe("implemented");
    // 真机冒烟尚未完成：已实现 ≠ 已通过验收，verification 必须保持 unverified
    expect(f.verification).toBe("unverified");
    expect(f.existingFeatures.length, "已实现须列出现有能力").toBeGreaterThan(0);
    expect(f.missingFeatures, "已实现不应有缺口").toHaveLength(0);
    const capabilities = f.existingFeatures.join(" ");
    expect(capabilities).toMatch(/独立捕获窗口/);
    expect(capabilities).toMatch(/五种类型/);
    expect(capabilities).toMatch(/收集箱/);
    expect(capabilities).toMatch(/幂等/);
    const entries = (f.entryPoints ?? []).join(" ");
    expect(entries).toMatch(/Ctrl\+Shift\+Space/);
    expect(entries).toMatch(/收集箱/);
    // 旧行为（热键展开主窗并聚焦快速录入）不得再作为现有能力出现
    expect(capabilities).not.toMatch(/显示主窗并聚焦快速录入框/);
  });

  it("部分实现的核心功能都能列出具体缺口", () => {
    const partialCore = CORE_FEATURE_IDS.map((id) => getFeatureById(id)!).filter(
      (f) => f.status === "partial",
    );
    // 复核结论：场景工作区 / 现场恢复 / 智能提醒 / 通知聚合 / 生活例行 / 文件暂存架 / 一键工作流 / 全局搜索 为 partial（快速捕获已落地）
    expect(partialCore.map((f) => f.id).sort()).toEqual(
      [
        "core.scenario-workspace",
        "core.workspace-restore",
        "core.smart-reminders",
        "core.notification-aggregation",
        "core.life-routines",
        "core.file-shelf",
        "core.one-click-workflow",
        "core.global-search",
      ].sort(),
    );
    for (const f of partialCore) {
      expect(f.existingFeatures.length, `${f.id} 应列出已有能力`).toBeGreaterThan(0);
      expect(f.missingFeatures.length, `${f.id} 应列出剩余缺口`).toBeGreaterThan(0);
    }
  });

  it("Gemini CLI 当前为 planned：官方 Hooks 已存在，不再登记为受阻", () => {
    const f = getFeatureById("agent.gemini-cli")!;
    expect(f.status).toBe("planned");
    expect(f.verification).toBe("unverified");
    expect(f.blockedReason).toBeUndefined();
    expect(f.missingFeatures.length, "待开发须登记剩余工作").toBeGreaterThan(0);
    // 过时的受阻结论不得再作为功能说明出现
    expect(f.detail).not.toMatch(/未见官方 hooks/);
  });
});

describe("目录结构契约", () => {
  it("全目录 ID 唯一", () => {
    const ids = FEATURE_CATALOG.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("全目录功能名称唯一", () => {
    const titles = FEATURE_CATALOG.map((f) => f.title);
    expect(new Set(titles).size).toBe(titles.length);
  });

  it("五个分类均有条目且元数据齐全", () => {
    for (const c of CATEGORY_ORDER) {
      expect(CATEGORY_META[c].label.length).toBeGreaterThan(0);
      expect(CATEGORY_META[c].description.length).toBeGreaterThan(0);
    }
    const groups = featuresByCategory();
    expect(groups.map((g) => g.category)).toEqual([...CATEGORY_ORDER]);
    expect(groups.reduce((n, g) => n + g.items.length, 0)).toBe(FEATURE_CATALOG.length);
  });

  it("五个展示分区条目数为 core 5 / workflow 9 / info 2 / agent 7 / ecosystem 5", () => {
    const counts = Object.fromEntries(
      featuresByCategory().map((g) => [g.category, g.items.length]),
    );
    expect(counts).toEqual({ core: 5, workflow: 9, info: 2, agent: 7, ecosystem: 5 });
  });

  it("每项必备字段非空", () => {
    for (const f of FEATURE_CATALOG) {
      expect(f.title.trim().length, `${f.id} title`).toBeGreaterThan(0);
      expect(f.description.trim().length, `${f.id} description`).toBeGreaterThan(0);
      expect(f.detail.trim().length, `${f.id} detail`).toBeGreaterThan(0);
      expect(f.acceptanceCriteria.length, `${f.id} acceptanceCriteria`).toBeGreaterThan(0);
      expect(f.dependencies.length, `${f.id} dependencies`).toBeGreaterThan(0);
    }
  });

  it("状态取值合法且符合状态约束", () => {
    const validStatus: FeatureStatus[] = ["implemented", "partial", "planned", "blocked"];
    for (const f of FEATURE_CATALOG) {
      expect(validStatus).toContain(f.status);
      if (f.status === "implemented") {
        expect(f.existingFeatures.length, `${f.id} 已实现须有 existingFeatures`).toBeGreaterThan(0);
        expect(f.missingFeatures, `${f.id} 已实现不应有缺口`).toHaveLength(0);
        expect(f.entryPoints?.length, `${f.id} 已实现须给出入口`).toBeGreaterThan(0);
      }
      if (f.status === "partial") {
        expect(f.existingFeatures.length, `${f.id}`).toBeGreaterThan(0);
        expect(f.missingFeatures.length, `${f.id}`).toBeGreaterThan(0);
      }
      if (f.status === "planned") {
        expect(f.missingFeatures.length, `${f.id} 待开发须登记剩余工作`).toBeGreaterThan(0);
      }
      if (f.status === "blocked") {
        expect((f.blockedReason ?? "").length, `${f.id} 受阻须说明原因`).toBeGreaterThan(0);
      }
    }
    // 注意：不要求真实目录必须包含 blocked 项——四种状态是合法取值，
    // 而不是目录必须长期持有的条目；未来受阻项全部解除后测试不应失败。
  });

  it("verification 取值合法，已验证项必须已实现", () => {
    for (const f of FEATURE_CATALOG) {
      expect(["verified", "unverified"]).toContain(f.verification);
      if (f.verification === "verified") {
        expect(f.status, `${f.id} 未实现不应标记已验证`).toBe("implemented");
      }
    }
  });

  it("优先级取值合法", () => {
    for (const f of FEATURE_CATALOG) {
      expect(["P0", "P1", "P2"]).toContain(f.priority);
    }
  });
});

describe("统计摘要", () => {
  it("全目录状态计数与验收基线一致（28 = 9 + 13 + 6 + 0）", () => {
    const s = featureCatalogSummary();
    expect(s.total).toBe(28);
    expect(s.coreTotal).toBe(12);
    // v0.10（2026-11-04 七项功能验收整改）：专注与休息、快速笔记、Agent 工作时间统计、
    // 任务统计与效率分析、自定义全局快捷键 planned→implemented；
    // 多语言 i18n（主壳未抽取）、桌面微件库（无独立宿主窗口）planned→partial。
    expect(s.implemented).toBe(9);
    expect(s.partial).toBe(13);
    expect(s.planned).toBe(6);
    expect(s.blocked).toBe(0);
    // 状态计数之和必须等于总功能数
    expect(s.implemented + s.partial + s.planned + s.blocked).toBe(s.total);
    // 真机走查（2026-11-04）通过的 5 项 implemented 记为 verified
    expect(s.verified).toBe(8);
    expect(s.unverified).toBe(20);
    expect(s.verified + s.unverified).toBe(s.total);
  });

  it("按 id 查找命中", () => {
    expect(getFeatureById("core.focus-timer")?.title).toBe("专注与休息");
    expect(getFeatureById("not-exist")).toBeUndefined();
  });
});
