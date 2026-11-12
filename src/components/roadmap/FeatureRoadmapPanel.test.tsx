/**
 * @vitest-environment jsdom
 */
//! 规划中面板测试：五个分类区块、状态计数、四类状态卡片交互、筛选与搜索。
//!
//! blocked 卡片使用独立测试夹具（FeatureCard）验证展示与点击行为：
//! 真实目录未来可能没有任何受阻项，不能为了测试向目录塞入虚假条目。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within, fireEvent } from "@testing-library/react";
import { useState } from "react";
import FeatureRoadmapPanel, { FeatureCard } from "./FeatureRoadmapPanel";
import type { FeatureEntry } from "../../lib/featureCatalog";
import { CORE_FEATURE_IDS, FEATURE_CATALOG, featureCatalogSummary } from "../../lib/featureCatalog";

beforeEach(() => {
  // 无外部依赖：目录是纯静态数据，面板不需要 mock bridge
  render(<FeatureRoadmapPanel />);
});
afterEach(cleanup);

/** 通过 aria-label（「标题（状态）」）定位卡片容器 */
function cardOf(title: string): HTMLElement {
  const head = screen.getByRole("button", { name: new RegExp(`^${title}（`) });
  return head.closest(".roadmap-card") as HTMLElement;
}

/** blocked 夹具：只验证卡片渲染与交互，不进入真实目录 */
const BLOCKED_FIXTURE: FeatureEntry = {
  id: "test.blocked-fixture",
  category: "agent",
  title: "测试受阻功能",
  description: "仅用于测试的受阻卡片夹具。",
  detail: "独立测试数据，不进入真实功能目录。",
  status: "blocked",
  priority: "P1",
  existingFeatures: [],
  missingFeatures: ["等待外部接口"],
  dependencies: ["外部接口"],
  acceptanceCriteria: ["接口可用后真实联调"],
  verification: "unverified",
  blockedReason: "测试用受阻原因：官方接口暂不可用",
};

function BlockedFixtureCard() {
  const [expanded, setExpanded] = useState(false);
  return (
    <FeatureCard feature={BLOCKED_FIXTURE} expanded={expanded} onToggle={() => setExpanded((v) => !v)} />
  );
}

describe("结构渲染", () => {
  it("渲染五个分类区块", () => {
    for (const label of ["核心效率功能", "工作流与效率增强", "信息管理与生活效率", "Agent 扩展", "长期生态"]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });

  it("统计行与目录摘要一致，且不再有受阻项", () => {
    const s = featureCatalogSummary();
    expect(screen.getByText(`已实现 ${s.implemented}`)).toBeTruthy();
    expect(screen.getByText(`部分实现 ${s.partial}`)).toBeTruthy();
    expect(screen.getByText(`待开发 ${s.planned}`)).toBeTruthy();
    expect(screen.getByText(`受阻 ${s.blocked}`)).toBeTruthy();
    expect(screen.getByText(`共 ${s.total} 项 · 核心 ${s.coreTotal} 项`)).toBeTruthy();
    expect(s.coreTotal).toBe(12);
    expect(s.blocked).toBe(0);
    expect(CORE_FEATURE_IDS).toHaveLength(12);
    // 目录中已没有受阻项：不应渲染任何「受阻」状态卡片
    expect(screen.queryByRole("button", { name: /（受阻）/ })).toBeNull();
  });

  it("五个分类区块条目数与目录一致（5 / 12 / 2 / 8 / 5）", () => {
    const expected: [label: string, count: number][] = [
      ["核心效率功能", 5],
      ["工作流与效率增强", 12],
      ["信息管理与生活效率", 2],
      ["Agent 扩展", 8],
      ["长期生态", 5],
    ];
    for (const [label, count] of expected) {
      const section = screen.getByRole("region", { name: label });
      expect(section.querySelector(".roadmap-section-count")?.textContent).toBe(String(count));
    }
  });
});

describe("四类状态卡片交互", () => {
  it("planned：点击后显示「功能待开发」（v0.10 专注/笔记转为 implemented，改用第三方插件系统）", () => {
    const card = cardOf("第三方插件系统及沙箱");
    fireEvent.click(within(card).getByRole("button"));
    expect(within(card).getByText("功能待开发")).toBeTruthy();
  });

  it("partial：点击后显示「功能待完善」并列出已有能力与待补齐缺口", () => {
    const card = cardOf("场景工作区");
    fireEvent.click(within(card).getByRole("button"));
    expect(within(card).getByText("功能待完善")).toBeTruthy();
    expect(within(card).getByText("已具备能力")).toBeTruthy();
    expect(within(card).getByText("待补齐")).toBeTruthy();
    // 缺口具体可见，而不是一句空话；进入取消/超时已交付，剩余缺口是退出场景等。
    const scene = FEATURE_CATALOG.find((entry) => entry.title === "场景工作区");
    expect(scene?.status).toBe("partial");
    expect(scene?.missingFeatures.length).toBeGreaterThan(0);
    expect(within(card).getAllByText(/「退出场景」动作/).length).toBeGreaterThan(0);
    for (const gap of scene?.missingFeatures ?? []) {
      expect(within(card).getByText(gap)).toBeTruthy();
    }
  });

  it("implemented：全局快速捕获落地后显示已实现横幅并给出现有入口", () => {
    const card = cardOf("全局快速捕获");
    fireEvent.click(within(card).getByRole("button"));
    expect(card.querySelector(".roadmap-cta.c-implemented")).toBeTruthy();
    expect(within(card).getByText("现有入口")).toBeTruthy();
    expect(within(card).queryByText("待补齐")).toBeNull();
  });

  it("implemented：点击后显示已实现横幅并给出现有入口", () => {
    const card = cardOf("Agent 行动中心");
    fireEvent.click(within(card).getByRole("button"));
    // 徽标与横幅都含「已实现」字样，这里直接断言横幅元素类型
    expect(card.querySelector(".roadmap-cta.c-implemented")).toBeTruthy();
    expect(within(card).getByText("现有入口")).toBeTruthy();
    expect(within(card).queryByText("待补齐")).toBeNull();
  });

  it("blocked：独立夹具验证「等待接口或平台条件确认」与阻塞原因（可展开/收起）", () => {
    // 真实目录已无 blocked 项：用独立夹具渲染，不向真实目录添加虚假条目
    cleanup();
    render(<BlockedFixtureCard />);
    const head = screen.getByRole("button", { name: "测试受阻功能（受阻）" });
    const card = head.closest(".roadmap-card") as HTMLElement;

    fireEvent.click(head);
    expect(within(card).getByText(/等待接口或平台条件确认/)).toBeTruthy();
    expect(within(card).getByText(/测试用受阻原因/)).toBeTruthy();

    fireEvent.click(head);
    expect(within(card).queryByText(/等待接口或平台条件确认/)).toBeNull();
  });

  it("再次点击收起详情", () => {
    const card = cardOf("第三方插件系统及沙箱");
    const head = within(card).getByRole("button");
    fireEvent.click(head);
    expect(within(card).getByText("功能待开发")).toBeTruthy();
    fireEvent.click(head);
    expect(within(card).queryByText("功能待开发")).toBeNull();
  });
});

describe("筛选与搜索", () => {
  it("状态筛选：只显示对应状态的卡片（v0.8 暂存架、v0.9 一键工作流为部分实现）", () => {
    fireEvent.click(screen.getByRole("button", { name: "待开发" }));
    expect(cardOf("第三方插件系统及沙箱")).toBeTruthy();
    // v0.10 专注与休息已为 implemented，不应出现在待开发筛选里
    expect(screen.queryByRole("button", { name: /^专注与休息（/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Agent 行动中心（/ })).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("筛选结果");

    fireEvent.click(screen.getByRole("button", { name: "部分实现" }));
    expect(cardOf("文件暂存架")).toBeTruthy();
    expect(cardOf("一键工作流")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^专注与休息（/ })).toBeNull();
  });

  it("状态筛选 implemented：能找到已落地的 Gemini CLI 适配器，且不再显示受阻说明", () => {
    fireEvent.click(screen.getByRole("button", { name: "已实现" }));
    const card = cardOf("Gemini CLI 接入");
    fireEvent.click(within(card).getByRole("button"));
    expect(card.querySelector(".roadmap-cta.c-implemented")).toBeTruthy();
    expect(within(card).getByText("现有入口")).toBeTruthy();
    expect(within(card).queryByText(/等待接口或平台条件确认/)).toBeNull();
    expect(within(card).queryByText(/未见官方 hooks/)).toBeNull();
  });

  it("优先级筛选 P0：只剩核心五项", () => {
    fireEvent.click(screen.getByRole("button", { name: "P0" }));
    const cards = document.querySelectorAll(".roadmap-card");
    expect(cards).toHaveLength(5);
    for (const title of ["全局快速捕获", "场景工作区", "Agent 行动中心", "工作现场恢复", "智能日程提醒"]) {
      expect(cardOf(title)).toBeTruthy();
    }
  });

  it("优先级筛选 P1：全局搜索出现在 P1；P2 不再包含全局搜索", () => {
    fireEvent.click(screen.getByRole("button", { name: "P1" }));
    expect(cardOf("全局搜索")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "P2" }));
    expect(screen.queryByRole("button", { name: /^全局搜索（/ })).toBeNull();
    // 快速笔记与生活例行事项保持 P2
    const quickNotes = cardOf("快速笔记");
    expect(within(quickNotes).getByText("P2")).toBeTruthy();
    expect(within(cardOf("生活例行事项")).getByText("P2")).toBeTruthy();
  });

  it("目录内搜索「全局搜索」命中统一检索与命令面板两项（2026-11-08 命令面板挂在全局搜索弹窗内）", () => {
    const input = screen.getByLabelText("搜索规划功能") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "全局搜索" } });
    const cards = document.querySelectorAll(".roadmap-card");
    expect(cards).toHaveLength(2);
    expect(cardOf("全局搜索")).toBeTruthy();
    expect(cardOf("全局命令面板")).toBeTruthy();
  });

  it("目录内搜索命中唯一功能", () => {
    const input = screen.getByLabelText("搜索规划功能") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "番茄" } });
    const cards = document.querySelectorAll(".roadmap-card");
    expect(cards).toHaveLength(1);
    expect(cardOf("专注与休息")).toBeTruthy();
  });

  it("筛选无结果时给出空态提示", () => {
    const input = screen.getByLabelText("搜索规划功能") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "不存在的功能xyz" } });
    expect(screen.getByText(/没有匹配的功能项/)).toBeTruthy();
  });
});
