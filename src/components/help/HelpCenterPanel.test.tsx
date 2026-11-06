/**
 * @vitest-environment jsdom
 */
//! 帮助中心面板：分类浏览 / 搜索 / 文章阅读 / 最近使用 / 相关功能跳转 /
//! 翻译状态徽标 / 一次性意图消费 / 引导重开入口。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import HelpCenterPanel from "./HelpCenterPanel";
import { useUiStore } from "../../store/useUiStore";
import { useOnboardingStore } from "../../store/useOnboardingStore";
import {
  clearRecentArticles,
  readRecentArticleIds,
} from "../../help/recent";
import { setLocalePreference, __resetLocaleForTests } from "../../i18n";

beforeEach(() => {
  localStorage.clear();
  clearRecentArticles();
  useUiStore.setState({ tab: "help", helpOpenRequest: null });
  useOnboardingStore.setState({ hasNewContent: false, open: false });
});

afterEach(() => {
  cleanup();
  __resetLocaleForTests();
  localStorage.clear();
});

describe("帮助中心 · 分类浏览", () => {
  it("渲染 8 个分类与默认分类（快速入门）的文章列表", () => {
    render(<HelpCenterPanel />);
    for (const label of [
      "快速入门",
      "任务与提醒",
      "Agent 管理",
      "剪贴板",
      "文件笔记与收集箱",
      "场景与工作流",
      "个性化",
      "故障排查",
    ]) {
      expect(screen.getByRole("button", { name: label })).toBeTruthy();
    }
    expect(screen.getByText("完整面板导览：导航、新建任务与徽标")).toBeTruthy();
  });

  it("切换分类显示对应文章；空分类显示空态", async () => {
    const user = userEvent.setup();
    render(<HelpCenterPanel />);
    await user.click(screen.getByRole("button", { name: "场景与工作流" }));
    expect(screen.getByText("一键工作流：把重复操作变成一次点击")).toBeTruthy();
    expect(screen.getByText("场景工作区：一键进入标准工作组合（规划中）")).toBeTruthy();
  });

  it("打开文章显示正文、状态徽标与元信息；返回恢复列表", async () => {
    const user = userEvent.setup();
    render(<HelpCenterPanel />);
    await user.click(screen.getByText("完整面板导览：导航、新建任务与徽标"));
    // 正文要点与元信息（适用版本 / 复制按钮在含步骤文章出现）
    expect(screen.getByText("左侧导航")).toBeTruthy();
    expect(screen.getByText("已核对")).toBeTruthy();
    expect(screen.getByText(/适用 v0\.11/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "复制操作步骤" })).toBeTruthy();
    // 返回上一级
    await user.click(screen.getByRole("button", { name: "返回教程列表" }));
    expect(screen.getByRole("button", { name: "快速入门" })).toBeTruthy();
  });

  it("打开文章写入最近浏览；最近使用区块可清空", async () => {
    const user = userEvent.setup();
    render(<HelpCenterPanel />);
    await user.click(screen.getByText("完整面板导览：导航、新建任务与徽标"));
    await user.click(screen.getByRole("button", { name: "返回教程列表" }));
    expect(readRecentArticleIds()).toEqual(["help.quickstart.panel"]);
    expect(screen.getByText("最近使用")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "清除最近浏览的教程记录" }));
    expect(readRecentArticleIds()).toEqual([]);
    expect(screen.queryByText("最近使用")).toBeNull();
  });
});

describe("帮助中心 · 搜索", () => {
  it("关键词搜索跨分类命中并显示计数；无结果显示空态", async () => {
    const user = userEvent.setup();
    render(<HelpCenterPanel />);
    await user.type(screen.getByRole("textbox", { name: "搜索帮助内容" }), "灯箱");
    await waitFor(() =>
      expect(screen.getByText("图片查看与逐项粘贴")).toBeTruthy(),
    );
    expect(screen.getByText("2 篇教程")).toBeTruthy();

    await user.type(screen.getByRole("textbox", { name: "搜索帮助内容" }), "量子纠缠");
    expect(await screen.findByText(/没有匹配/)).toBeTruthy();
  });

  it("从搜索结果打开文章再返回：回到同一搜索结果（保留查询上下文）", async () => {
    const user = userEvent.setup();
    render(<HelpCenterPanel />);
    const input = screen.getByRole("textbox", { name: "搜索帮助内容" });
    await user.type(input, "灯箱");
    await user.click(screen.getByText("图片查看与逐项粘贴"));
    await user.click(screen.getByRole("button", { name: "返回教程列表" }));
    // 「返回上一级」回到打开前的上下文：仍是同一份搜索结果，不丢查询
    expect(screen.getByText("2 篇教程")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "快速入门" })).toBeNull();
  });
});

describe("帮助中心 · 相关功能跳转", () => {
  it("partial/implemented 功能提供跳转按钮，点击切到对应 Tab", async () => {
    const user = userEvent.setup();
    render(<HelpCenterPanel />);
    await user.click(screen.getByRole("button", { name: "任务与提醒" }));
    await user.click(screen.getByText("创建任务与自然语言提醒"));
    // 相关功能（partial）与相关页面两处都提供「前往任务」；任一点击即切换
    const jumps = screen.getAllByRole("button", { name: "前往「任务」" });
    expect(jumps.length).toBeGreaterThanOrEqual(2);
    await user.click(jumps[0]);
    expect(useUiStore.getState().tab).toBe("tasks");
  });

  it("planned 功能显示状态徽标与提示，不提供死链接；partial 仍可跳转", async () => {
    const user = userEvent.setup();
    render(<HelpCenterPanel />);
    await user.click(screen.getByRole("button", { name: "故障排查" }));
    await user.click(screen.getByText("为什么某个功能找不到或不可用"));
    // eco.plugins / eco.sync 是 planned：显示「功能待开发」徽标 + 现状说明，无跳转按钮
    expect(screen.getAllByText("功能待开发").length).toBe(2);
    expect(screen.getAllByText(/该功能尚未完全可用/).length).toBeGreaterThanOrEqual(2);
    // partial 功能（场景工作区 / 文件暂存架）仍可跳转 + 相关页面区各有一个同目标按钮
    expect(screen.getAllByText("部分实现").length).toBe(2);
    expect(screen.getAllByRole("button", { name: "前往「规划中心」" }).length).toBe(2);
    expect(screen.getAllByRole("button", { name: "前往「设置」" }).length).toBe(2);
  });
});

describe("帮助中心 · 翻译状态与语言", () => {
  it("en-US 下无英文版的文章显示「暂无英文版」徽标并回退中文正文", () => {
    setLocalePreference("en-US");
    render(<HelpCenterPanel />);
    // zh-only 文章在英文界面仍显示中文标题（回退）+ 徽标，不伪称国际化完成
    fireEvent.click(screen.getByRole("button", { name: "Tasks & reminders" }));
    fireEvent.click(screen.getByText("创建任务与自然语言提醒"));
    expect(screen.getByText("This guide is not available in English yet")).toBeTruthy();
    expect(screen.getByText("用自然语言创建")).toBeTruthy();
  });

  it("en-US 下有英文版的文章正常显示英文正文且无缺失徽标", () => {
    setLocalePreference("en-US");
    render(<HelpCenterPanel />);
    fireEvent.click(screen.getByText("Full panel tour: navigation, new task and badges"));
    expect(screen.queryByText("This guide is not available in English yet")).toBeNull();
    expect(screen.queryByText("该教程暂无英文版")).toBeNull();
    expect(screen.getByText("Left navigation")).toBeTruthy();
  });
});

describe("帮助中心 · 一次性意图与引导入口", () => {
  it("消费 helpOpenRequest：挂载时直接打开指定文章并清除请求", () => {
    useUiStore.setState({
      helpOpenRequest: { token: 1, articleId: "help.clipboard.history" },
    });
    render(<HelpCenterPanel />);
    expect(screen.getByText("剪贴板历史：查找、收藏与复用")).toBeTruthy();
    expect(useUiStore.getState().helpOpenRequest).toBeNull();
    // 意图文章进入最近浏览
    expect(readRecentArticleIds()).toContain("help.clipboard.history");
  });

  it("未知文章 ID 的意图被安全忽略", () => {
    useUiStore.setState({ helpOpenRequest: { token: 2, articleId: "help.deleted.ghost" } });
    render(<HelpCenterPanel />);
    expect(screen.getByRole("button", { name: "快速入门" })).toBeTruthy();
    expect(useUiStore.getState().helpOpenRequest).toBeNull();
  });

  it("「重新打开新手引导」触发 store.reopenFromHelp 并清除新内容标志", async () => {
    const user = userEvent.setup();
    useOnboardingStore.setState({ hasNewContent: true });
    render(<HelpCenterPanel />);
    expect(document.querySelector(".help-onboarding-dot")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "重新打开新手引导" }));
    const state = useOnboardingStore.getState();
    expect(state.open).toBe(true);
    expect(state.step).toBe(0);
    expect(state.hasNewContent).toBe(false);
  });
});
