/**
 * @vitest-environment jsdom
 */
//! OnboardingOverlay：可见性门控（完整模式/设置加载/非停靠）、步骤流转、
//! Escape 经 overlayStack 跳过、动作按钮只做页面跳转不写业务数据。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import OnboardingOverlay from "./OnboardingOverlay";
import { __resetOnboardingForTests, useOnboardingStore } from "../../store/useOnboardingStore";
import { useSettingsStore } from "../../store/useSettingsStore";
import { useEdgeSnapStore } from "../../store/useEdgeSnapStore";
import { useUiStore } from "../../store/useUiStore";
import { resetOverlayStack } from "../../lib/overlayStack";
import { setLocalePreference, __resetLocaleForTests } from "../../i18n";

function seedFullMode() {
  useSettingsStore.setState({ settings: { mode: "full" } as never });
  useEdgeSnapStore.setState({ phase: "free" });
}

function storedSkipped(): boolean {
  const raw = localStorage.getItem("taskdock.onboarding.v1");
  return raw ? (JSON.parse(raw) as { skipped: boolean }).skipped === true : false;
}

beforeEach(() => {
  __resetOnboardingForTests();
  resetOverlayStack();
  seedFullMode();
  useUiStore.setState({ tab: "tasks" });
});

afterEach(() => {
  cleanup();
  __resetOnboardingForTests();
  __resetLocaleForTests();
  resetOverlayStack();
  useSettingsStore.setState({ settings: null });
  useEdgeSnapStore.setState({ phase: "free" });
});

describe("OnboardingOverlay · 可见性门控", () => {
  it("首次使用自动展示第 1 步（完整模式、设置已加载）", () => {
    render(<OnboardingOverlay />);
    expect(screen.getByText("认识 task_dock")).toBeTruthy();
    expect(screen.getByText("第 1 步，共 3 步")).toBeTruthy();
  });

  it("紧凑模式不展示；设置未加载不展示；停靠胶囊期不展示", () => {
    useSettingsStore.setState({ settings: { mode: "compact" } as never });
    const { container: c1 } = render(<OnboardingOverlay />);
    expect(c1.querySelector(".onboarding-card")).toBeNull();

    useSettingsStore.setState({ settings: null });
    const { container: c2 } = render(<OnboardingOverlay />);
    expect(c2.querySelector(".onboarding-card")).toBeNull();

    seedFullMode();
    useEdgeSnapStore.setState({ phase: "docked-visible" });
    const { container: c3 } = render(<OnboardingOverlay />);
    expect(c3.querySelector(".onboarding-card")).toBeNull();
  });

  it("明确跳过后重启不再展示", () => {
    useOnboardingStore.getState().hydrate();
    useOnboardingStore.getState().skip();
    // 模拟重启：只清内存态，保留 localStorage 记录
    useOnboardingStore.setState({
      open: false,
      step: 0,
      hydrated: false,
      done: false,
      hasNewContent: false,
    });
    const { container } = render(<OnboardingOverlay />);
    // hydrate 由组件 effect 触发；记录 skipped → 不打开
    expect(container.querySelector(".onboarding-card")).toBeNull();
  });
});

describe("OnboardingOverlay · 步骤与操作", () => {
  it("下一步/上一步流转，最后一步显示「完成」；完成写入记录并关闭", async () => {
    render(<OnboardingOverlay />);
    fireEvent.click(screen.getByRole("button", { name: "下一步" }));
    expect(screen.getByText("完成第一个任务")).toBeTruthy();
    expect(screen.getByRole("button", { name: "上一步" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "下一步" }));
    expect(screen.getByText("按需启用功能")).toBeTruthy();
    expect(screen.getByRole("button", { name: "完成" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "完成" }));
    await waitFor(() => expect(useOnboardingStore.getState().done).toBe(true));
    expect(useOnboardingStore.getState().open).toBe(false);
  });

  it("第 2 步「去创建任务」切到任务页并推进步骤；不创建任何任务数据", async () => {
    render(<OnboardingOverlay />);
    fireEvent.click(screen.getByRole("button", { name: "下一步" }));
    fireEvent.click(screen.getByRole("button", { name: "去创建任务" }));
    expect(useUiStore.getState().tab).toBe("tasks");
    expect(useOnboardingStore.getState().step).toBe(2);
    // 引导不写入业务数据：quickAddToken 未被触发
    expect(useUiStore.getState().quickAddToken).toBe(0);
  });

  it("第 3 步「打开设置」只切换页面，不推进步骤", () => {
    render(<OnboardingOverlay />);
    fireEvent.click(screen.getByRole("button", { name: "下一步" }));
    fireEvent.click(screen.getByRole("button", { name: "下一步" }));
    fireEvent.click(screen.getByRole("button", { name: "打开设置" }));
    expect(useUiStore.getState().tab).toBe("settings");
    expect(useOnboardingStore.getState().step).toBe(2);
  });

  it("Escape 经弹层栈等价跳过：关闭卡片并持久化 skipped", async () => {
    render(<OnboardingOverlay />);
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(useOnboardingStore.getState().open).toBe(false));
    expect(storedSkipped()).toBe(true);
  });

  it("右上角关闭按钮等价跳过，带可访问名", async () => {
    render(<OnboardingOverlay />);
    fireEvent.click(screen.getByRole("button", { name: "关闭新手引导" }));
    await waitFor(() => expect(useOnboardingStore.getState().open).toBe(false));
  });

  it("步骤指示与正文键随语言切换（en-US）", () => {
    useOnboardingStore.getState().hydrate();
    useOnboardingStore.setState({ open: true, step: 0 });
    setLocalePreference("en-US");
    render(<OnboardingOverlay />);
    expect(screen.getByText("Step 1 of 3")).toBeTruthy();
    expect(screen.getByText("Meet Task Dock")).toBeTruthy();
  });
});
