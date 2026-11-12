//! 功能规划中心回归契约测试（task-3 新增独立文件，不修改既有测试与实现）。
//!
//! 目的：锁定本次回归核对的关键契约，防止并行会话更新统计时发生静默漂移：
//! - CORE_FEATURE_IDS 恰好 12 项，ID、标题、顺序固定；
//! - 12 项核心 P0=5 / P1=5 / P2=2；全局搜索固定 P1；核心项状态集合固定；
//! - 目录 31 项，状态 implemented=13 / partial=15 / planned=3 / blocked=0
//!   （2026-11-06 规划纠偏：场景 / 工作流 / MCP / 帮助四项按代码证据修正描述，数量不变）；
//! - Gemini CLI 为 implemented + unverified（真实会话未联调，不登记为受阻）。
//!
//! 本文件只校验数据，不渲染面板；面板交互由既有
//! src/components/roadmap/FeatureRoadmapPanel.test.tsx（16 用例）覆盖。

import { describe, expect, it } from "vitest";
import {
  CORE_FEATURE_COUNT,
  CORE_FEATURE_IDS,
  FEATURE_CATALOG,
  featureCatalogSummary,
  getFeatureById,
  type FeaturePriority,
  type FeatureStatus,
} from "./featureCatalog";

/** 12 项核心功能固定 ID（顺序即 P0 → P1 → P2 登记顺序） */
const EXPECTED_CORE_IDS = [
  "core.quick-capture",
  "core.scenario-workspace",
  "core.agent-action-center",
  "core.workspace-restore",
  "core.smart-reminders",
  "core.file-shelf",
  "core.one-click-workflow",
  "core.notification-aggregation",
  "core.focus-timer",
  "core.global-search",
  "core.quick-notes",
  "core.life-routines",
] as const;

/** 12 项核心功能标题（与 ID 顺序一一对应） */
const EXPECTED_CORE_TITLES = [
  "全局快速捕获",
  "场景工作区",
  "Agent 行动中心",
  "工作现场恢复",
  "智能日程提醒",
  "文件暂存架",
  "一键工作流",
  "智能通知聚合",
  "专注与休息",
  "全局搜索",
  "快速笔记",
  "生活例行事项",
] as const;

/** 核心项优先级精确集合 */
const EXPECTED_CORE_BY_PRIORITY: Record<FeaturePriority, readonly string[]> = {
  P0: [
    "core.quick-capture",
    "core.scenario-workspace",
    "core.agent-action-center",
    "core.workspace-restore",
    "core.smart-reminders",
  ],
  P1: [
    "core.file-shelf",
    "core.one-click-workflow",
    "core.notification-aggregation",
    "core.focus-timer",
    "core.global-search",
  ],
  P2: ["core.quick-notes", "core.life-routines"],
};

/** 核心项状态精确集合（v0.10：专注与休息、快速笔记 planned→implemented） */
const EXPECTED_CORE_BY_STATUS: Record<"implemented" | "partial" | "planned", readonly string[]> = {
  implemented: [
    "core.quick-capture",
    "core.agent-action-center",
    "core.focus-timer",
    "core.quick-notes",
  ],
  partial: [
    "core.scenario-workspace",
    "core.workspace-restore",
    "core.smart-reminders",
    "core.notification-aggregation",
    "core.life-routines",
    "core.file-shelf",
    "core.one-click-workflow",
    "core.global-search",
  ],
  planned: [],
};

function featuresOf(ids: readonly string[]) {
  return ids.map((id) => {
    const feature = getFeatureById(id);
    expect(feature, `功能 ${id} 未在目录登记`).toBeTruthy();
    return feature!;
  });
}

describe("12 项核心功能精确契约", () => {
  it("CORE_FEATURE_IDS 恰好为规定 12 项且顺序固定", () => {
    expect(CORE_FEATURE_COUNT).toBe(12);
    expect([...CORE_FEATURE_IDS]).toEqual([...EXPECTED_CORE_IDS]);
  });

  it("12 项核心标题与规定中文名一一对应（顺序一致）", () => {
    expect(featuresOf(CORE_FEATURE_IDS).map((f) => f.title)).toEqual([...EXPECTED_CORE_TITLES]);
  });

  it("核心项优先级精确集合：P0 5 项 / P1 5 项 / P2 2 项", () => {
    for (const priority of ["P0", "P1", "P2"] as FeaturePriority[]) {
      const actual = featuresOf(EXPECTED_CORE_IDS)
        .filter((f) => f.priority === priority)
        .map((f) => f.id)
        .sort();
      expect(actual, `${priority} 核心项集合`).toEqual([...EXPECTED_CORE_BY_PRIORITY[priority]].sort());
    }
  });

  it("核心项状态精确集合：implemented 4 / partial 8 / planned 0", () => {
    for (const status of ["implemented", "partial", "planned"] as const) {
      const actual = featuresOf(EXPECTED_CORE_IDS)
        .filter((f) => f.status === status)
        .map((f) => f.id)
        .sort();
      expect(actual, `${status} 核心项集合`).toEqual([...EXPECTED_CORE_BY_STATUS[status]].sort());
    }
  });

  it("全局搜索固定为 P1 / partial / workflow", () => {
    const f = getFeatureById("core.global-search");
    expect(f?.title).toBe("全局搜索");
    expect(f?.priority).toBe("P1");
    // v0.9：统一检索层落地为 partial（已发现应用/FTS5 仍在缺口清单）
    expect(f?.status).toBe("partial");
    expect(f?.category).toBe("workflow");
  });
});

describe("全目录统计契约", () => {
  it("目录总数 33，状态计数 implemented=14 / partial=16 / planned=3 / blocked=0", () => {
    expect(FEATURE_CATALOG).toHaveLength(33);
    const counts: Record<FeatureStatus, number> = {
      implemented: 0,
      partial: 0,
      planned: 0,
      blocked: 0,
    };
    for (const f of FEATURE_CATALOG) counts[f.status] += 1;
    // v0.11 第一轮新增 agent.mcp-server / ux.help-center（partial）与 ux.onboarding（implemented）；
    // 第三轮新增 ux.command-palette（implemented，2026-11-08）；
    // core.dev-workbench（partial）随开发工作台 P0 合入（2026-11-12），契约计数同步
    expect(counts).toEqual({ implemented: 14, partial: 16, planned: 3, blocked: 0 });
  });

  it("摘要函数与目录实际计数一致（total / coreTotal / 状态 / 验证）", () => {
    const summary = featureCatalogSummary();
    const statusCounts: Record<FeatureStatus, number> = {
      implemented: 0,
      partial: 0,
      planned: 0,
      blocked: 0,
    };
    let verified = 0;
    for (const f of FEATURE_CATALOG) {
      statusCounts[f.status] += 1;
      if (f.verification === "verified") verified += 1;
    }
    expect(summary.total).toBe(FEATURE_CATALOG.length);
    expect(summary.coreTotal).toBe(EXPECTED_CORE_IDS.length);
    expect(summary.implemented).toBe(statusCounts.implemented);
    expect(summary.partial).toBe(statusCounts.partial);
    expect(summary.planned).toBe(statusCounts.planned);
    expect(summary.blocked).toBe(statusCounts.blocked);
    expect(summary.verified).toBe(verified);
    expect(summary.verified + summary.unverified).toBe(summary.total);
  });

  it("目录中不存在 blocked 项，Gemini CLI 为 implemented + unverified 且无 blockedReason", () => {
    expect(FEATURE_CATALOG.filter((f) => f.status === "blocked")).toHaveLength(0);
    const gemini = getFeatureById("agent.gemini-cli");
    expect(gemini?.status).toBe("implemented");
    expect(gemini?.verification).toBe("unverified");
    expect(gemini?.blockedReason).toBeUndefined();
  });
});
