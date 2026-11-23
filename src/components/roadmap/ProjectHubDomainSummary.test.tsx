/**
 * @vitest-environment jsdom
 */
//! 项目中枢「专业工作进展」组件测试（jsdom）：
//! - 五种类型渲染各自真实指标，且只调用对应接口；
//! - 未接入类型 / 空数据 / 查询失败三态不互相混淆，失败不显示 0；
//! - 项目切换立即清空旧摘要，迟到响应不覆盖新项目；
//! - 卸载后迟到响应不再写状态；手动刷新（refreshToken）才重新请求。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const ipc = vi.hoisted(() => ({
  novelOverviewStats: vi.fn(),
  comicOverviewStats: vi.fn(),
  gameOverviewStats: vi.fn(),
  dwsDevelopmentSummary: vi.fn(),
  generalStats: vi.fn(),
}));

vi.mock("../../workbench/creative/novel/ipc", () => ({
  novelOverviewStats: ipc.novelOverviewStats,
}));
vi.mock("../../workbench/creative/comic/ipc", () => ({
  comicOverviewStats: ipc.comicOverviewStats,
}));
vi.mock("../../workbench/creative/game/ipc", () => ({
  gameOverviewStats: ipc.gameOverviewStats,
}));
vi.mock("../../workbench/creative/development/ipc", () => ({
  dwsDevelopmentSummary: ipc.dwsDevelopmentSummary,
}));
vi.mock("../../workbench/creative/general/ipc", () => ({
  generalStats: ipc.generalStats,
}));

import type { NovelOverviewStats } from "../../workbench/creative/novel/types";
import ProjectHubDomainSummary from "./ProjectHubDomainSummary";
import {
  comicStats,
  devSummary,
  emptyNovelStats,
  gameStats,
  generalStatsData,
  novelStats,
} from "./projectHubDomainFixtures";

const WAIT = { timeout: 3000 };

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (cause: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function Hub({
  projectId,
  projectKind,
  refreshToken = 0,
}: {
  projectId: string;
  projectKind: string;
  refreshToken?: number;
}) {
  return (
    <ProjectHubDomainSummary
      projectId={projectId}
      projectKind={projectKind}
      refreshToken={refreshToken}
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  ipc.novelOverviewStats.mockResolvedValue(novelStats());
  ipc.comicOverviewStats.mockResolvedValue(comicStats());
  ipc.gameOverviewStats.mockResolvedValue(gameStats());
  ipc.dwsDevelopmentSummary.mockResolvedValue({ summary: devSummary() });
  ipc.generalStats.mockResolvedValue({ stats: generalStatsData() });
});

afterEach(() => {
  cleanup();
});

describe("专业工作进展摘要", () => {
  it("小说：渲染章节/字数/角色/世界观，只调用小说概览接口", async () => {
    render(<Hub projectId="p-novel" projectKind="novel" />);

    expect(await screen.findByText("章节", {}, WAIT)).toBeTruthy();
    expect(screen.getByText("12")).toBeTruthy();
    expect(screen.getByText("18.6 万字")).toBeTruthy();
    expect(screen.getByText("8")).toBeTruthy();
    expect(screen.getByText("15")).toBeTruthy();
    // 真实 DTO 里没有「已完成章节数」，不能凭空造一个
    expect(screen.queryByText(/已完成章节/)).toBeNull();
    expect(ipc.novelOverviewStats).toHaveBeenCalledWith("p-novel");
    expect(ipc.comicOverviewStats).not.toHaveBeenCalled();
  });

  it("漫剧：渲染剧集/分镜/素材与分镜完成度，并显示真实更新时间", async () => {
    render(<Hub projectId="p-comic" projectKind="ai_comic" />);

    expect(await screen.findByText("剧集", {}, WAIT)).toBeTruthy();
    expect(screen.getByText("4")).toBeTruthy();
    expect(screen.getByText("40")).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "分镜完成度" })).toBeTruthy();
    expect(
      screen.getByRole("progressbar", { name: "分镜完成度" }).getAttribute("aria-valuenow"),
    ).toBe("25");
    expect(screen.getByText(/最近更新 2026-11-22/)).toBeTruthy();
    expect(ipc.comicOverviewStats).toHaveBeenCalledWith("p-comic");
  });

  it("游戏：渲染资源/构建/测试，最近构建按真实状态着色", async () => {
    render(<Hub projectId="p-game" projectKind="game" />);

    expect(await screen.findByText("资源", {}, WAIT)).toBeTruthy();
    expect(screen.getByText("18")).toBeTruthy();
    expect(screen.getByText("3 成功 · 2 失败")).toBeTruthy();
    expect(screen.getByText("5 通过 · 3 失败")).toBeTruthy();
    expect(screen.getByText(/构建失败 · 2026-11-21/)).toBeTruthy();
    expect(ipc.gameOverviewStats).toHaveBeenCalledWith("p-game");
  });

  it("开发：区分仓库数量与任务数量，路径失效如实展示且不虚构「进行中任务」", async () => {
    render(<Hub projectId="p-dev" projectKind="development" />);

    expect(await screen.findByText("task_dock", {}, WAIT)).toBeTruthy();
    expect(screen.getByText("1 可用 · 1 路径失效")).toBeTruthy();
    expect(screen.getByText("路径失效")).toBeTruthy();
    expect(screen.getByText("1 / 3 已完成")).toBeTruthy();
    expect(screen.getByText(/失效任务引用/)).toBeTruthy();
    // tasks 只有 pending/completed/missing，不能凭空统计「进行中任务」
    expect(screen.queryByText("进行中任务")).toBeNull();
    expect(ipc.dwsDevelopmentSummary).toHaveBeenCalledWith("p-dev");
  });

  it("通用：渲染事项/里程碑/资料，并声明关联任务口径", async () => {
    render(<Hub projectId="p-general" projectKind="general" />);

    expect(await screen.findByText("事项", {}, WAIT)).toBeTruthy();
    expect(screen.getByText("3 待办 · 2 进行中 · 3 已完成")).toBeTruthy();
    expect(screen.getByText("已完成 3 / 4 · 75%")).toBeTruthy();
    expect(screen.getByText("4 个可用")).toBeTruthy();
    expect(screen.getByText("事项库弱引用，与公共项目任务分开统计")).toBeTruthy();
    expect(ipc.generalStats).toHaveBeenCalledWith("p-general");
  });

  it("未接入的项目类型：明确提示「尚未接入专业摘要」，且不发任何请求", async () => {
    render(<Hub projectId="p-other" projectKind="other" />);

    expect(await screen.findByTestId("ph-domain-unsupported", {}, WAIT)).toBeTruthy();
    expect(ipc.novelOverviewStats).not.toHaveBeenCalled();
    expect(ipc.comicOverviewStats).not.toHaveBeenCalled();
    expect(ipc.gameOverviewStats).not.toHaveBeenCalled();
    expect(ipc.dwsDevelopmentSummary).not.toHaveBeenCalled();
    expect(ipc.generalStats).not.toHaveBeenCalled();
  });

  it("查询成功但无数据：显示「暂无专业数据」，不铺一排 0", async () => {
    ipc.novelOverviewStats.mockResolvedValue(emptyNovelStats());
    render(<Hub projectId="p-novel" projectKind="novel" />);

    expect(await screen.findByTestId("ph-domain-empty", {}, WAIT)).toBeTruthy();
    expect(screen.queryByText("章节")).toBeNull();
  });

  it("查询失败：显示「专业摘要暂不可用」与重试，绝不显示 0", async () => {
    ipc.gameOverviewStats.mockRejectedValue(new Error("数据库忙"));
    render(<Hub projectId="p-game" projectKind="game" />);

    const alert = await screen.findByTestId("ph-domain-error", {}, WAIT);
    expect(alert.textContent).toContain("专业摘要暂不可用");
    expect(alert.textContent).toContain("数据库忙");
    expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();
    expect(document.querySelectorAll(".ph-domain-metric")).toHaveLength(0);
  });

  it("切换到新项目时立即清空旧摘要，迟到的旧响应不覆盖新项目", async () => {
    const pendingA = deferred<NovelOverviewStats>();
    ipc.novelOverviewStats.mockReturnValueOnce(pendingA.promise);
    ipc.novelOverviewStats.mockResolvedValueOnce(
      novelStats({ chapters: 77, words: 900_000, lastChapter: null }),
    );

    const { rerender } = render(<Hub projectId="p-a" projectKind="novel" />);
    // 旧项目还在读取：不应显示任何领域数字
    expect(await screen.findByLabelText("正在读取专业摘要")).toBeTruthy();

    rerender(<Hub projectId="p-b" projectKind="novel" />);
    expect(await screen.findByText("77", {}, WAIT)).toBeTruthy();

    // 切回/推进：A 的迟到响应必须被丢弃
    await act(async () => {
      pendingA.resolve(novelStats({ chapters: 12 }));
      await Promise.resolve();
    });
    expect(screen.getByText("77")).toBeTruthy();
    expect(screen.queryByText("第十章 雪夜")).toBeNull();
  });

  it("已显示的项目在切换瞬间清空，不残留上一个项目的数字", async () => {
    const pendingB = deferred<NovelOverviewStats>();
    ipc.novelOverviewStats.mockResolvedValueOnce(novelStats());
    ipc.novelOverviewStats.mockReturnValueOnce(pendingB.promise);

    const { rerender } = render(<Hub projectId="p-a" projectKind="novel" />);
    expect(await screen.findByText("12", {}, WAIT)).toBeTruthy();

    rerender(<Hub projectId="p-b" projectKind="novel" />);
    expect(screen.queryByText("12")).toBeNull();
    expect(screen.queryByText("第十章 雪夜")).toBeNull();
    expect(screen.getByLabelText("正在读取专业摘要")).toBeTruthy();
  });

  it("项目类型变化触发重新加载，切换瞬间不显示上一个类型的数据", async () => {
    const pendingComic = deferred<ReturnType<typeof comicStats>>();
    const { rerender } = render(<Hub projectId="p-x" projectKind="novel" />);
    expect(await screen.findByText("章节", {}, WAIT)).toBeTruthy();

    ipc.comicOverviewStats.mockReturnValueOnce(pendingComic.promise);
    rerender(<Hub projectId="p-x" projectKind="ai_comic" />);
    expect(screen.queryByText("章节")).toBeNull();
    expect(await screen.findByLabelText("正在读取专业摘要")).toBeTruthy();

    await act(async () => {
      pendingComic.resolve(comicStats({ projectId: "p-x" }));
      await Promise.resolve();
    });
    expect(await screen.findByText("剧集", {}, WAIT)).toBeTruthy();
  });

  it("卸载后迟到的响应不再写状态，也不产生未处理拒绝", async () => {
    const pending = deferred<NovelOverviewStats>();
    ipc.novelOverviewStats.mockReturnValue(pending.promise);

    const { unmount } = render(<Hub projectId="p-novel" projectKind="novel" />);
    expect(await screen.findByLabelText("正在读取专业摘要")).toBeTruthy();
    unmount();

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    pending.reject(new Error("迟到的失败"));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("同一项目不会重复请求；只有手动刷新（refreshToken）才重新取一次", async () => {
    const { rerender } = render(<Hub projectId="p-general" projectKind="general" />);
    expect(await screen.findByText("事项", {}, WAIT)).toBeTruthy();
    expect(ipc.generalStats).toHaveBeenCalledTimes(1);

    rerender(<Hub projectId="p-general" projectKind="general" refreshToken={0} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(ipc.generalStats).toHaveBeenCalledTimes(1);

    rerender(<Hub projectId="p-general" projectKind="general" refreshToken={1} />);
    await waitFor(() => expect(ipc.generalStats).toHaveBeenCalledTimes(2), WAIT);
  });

  it("失败后点「重试」会重新请求并恢复摘要", async () => {
    ipc.generalStats.mockRejectedValueOnce(new Error("暂时不可用"));
    const user = userEvent.setup();
    render(<Hub projectId="p-general" projectKind="general" />);

    expect(await screen.findByTestId("ph-domain-error", {}, WAIT)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "重试" }));

    expect(await screen.findByText("事项", {}, WAIT)).toBeTruthy();
    expect(ipc.generalStats).toHaveBeenCalledTimes(2);
  });
});
