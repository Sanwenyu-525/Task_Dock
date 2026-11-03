/**
 * @vitest-environment jsdom
 */
//! 规划中面板测试：五个分类区块、状态计数、四类状态卡片交互、筛选与搜索。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within, fireEvent } from "@testing-library/react";
import FeatureRoadmapPanel from "./FeatureRoadmapPanel";
import { CORE_FEATURE_IDS, featureCatalogSummary } from "../../lib/featureCatalog";

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

describe("结构渲染", () => {
  it("渲染五个分类区块", () => {
    for (const label of ["核心效率功能", "工作流与效率增强", "信息管理与生活效率", "Agent 扩展", "长期生态"]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });

  it("统计行与目录摘要一致", () => {
    const s = featureCatalogSummary();
    expect(screen.getByText(`已实现 ${s.implemented}`)).toBeTruthy();
    expect(screen.getByText(`部分实现 ${s.partial}`)).toBeTruthy();
    expect(screen.getByText(`待开发 ${s.planned}`)).toBeTruthy();
    expect(screen.getByText(`受阻 ${s.blocked}`)).toBeTruthy();
    expect(screen.getByText(`共 ${s.total} 项 · 核心 ${s.coreTotal} 项`)).toBeTruthy();
    expect(s.coreTotal).toBe(12);
    expect(CORE_FEATURE_IDS).toHaveLength(12);
  });
});

describe("四类状态卡片交互", () => {
  it("planned：点击后显示「功能待开发」", () => {
    const card = cardOf("一键工作流");
    fireEvent.click(within(card).getByRole("button"));
    expect(within(card).getByText("功能待开发")).toBeTruthy();
  });

  it("partial：点击后显示「功能待完善」并列出已有能力与待补齐缺口", () => {
    const card = cardOf("全局快速捕获");
    fireEvent.click(within(card).getByRole("button"));
    expect(within(card).getByText("功能待完善")).toBeTruthy();
    expect(within(card).getByText("已具备能力")).toBeTruthy();
    expect(within(card).getByText("待补齐")).toBeTruthy();
    // 缺口具体可见，而不是一句空话
    expect(within(card).getByText(/独立轻量悬浮捕获窗/)).toBeTruthy();
  });

  it("implemented：点击后显示已实现横幅并给出现有入口", () => {
    const card = cardOf("Agent 行动中心");
    fireEvent.click(within(card).getByRole("button"));
    // 徽标与横幅都含「已实现」字样，这里直接断言横幅元素类型
    expect(card.querySelector(".roadmap-cta.c-implemented")).toBeTruthy();
    expect(within(card).getByText("现有入口")).toBeTruthy();
    expect(within(card).queryByText("待补齐")).toBeNull();
  });

  it("blocked：显示「等待接口或平台条件确认」与阻塞原因", () => {
    const card = cardOf("Gemini CLI 接入");
    fireEvent.click(within(card).getByRole("button"));
    expect(within(card).getByText(/等待接口或平台条件确认/)).toBeTruthy();
    expect(within(card).getByText(/未见官方 hooks/)).toBeTruthy();
  });

  it("再次点击收起详情", () => {
    const card = cardOf("一键工作流");
    const head = within(card).getByRole("button");
    fireEvent.click(head);
    expect(within(card).getByText("功能待开发")).toBeTruthy();
    fireEvent.click(head);
    expect(within(card).queryByText("功能待开发")).toBeNull();
  });
});

describe("筛选与搜索", () => {
  it("状态筛选：只显示对应状态的卡片", () => {
    fireEvent.click(screen.getByRole("button", { name: "待开发" }));
    expect(cardOf("文件暂存架")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Agent 行动中心（/ })).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("筛选结果");
  });

  it("优先级筛选 P0：只剩核心五项", () => {
    fireEvent.click(screen.getByRole("button", { name: "P0" }));
    const cards = document.querySelectorAll(".roadmap-card");
    expect(cards).toHaveLength(5);
    for (const title of ["全局快速捕获", "场景工作区", "Agent 行动中心", "工作现场恢复", "智能日程提醒"]) {
      expect(cardOf(title)).toBeTruthy();
    }
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
