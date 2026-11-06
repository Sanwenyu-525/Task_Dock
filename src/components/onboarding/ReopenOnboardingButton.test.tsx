/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import ReopenOnboardingButton from "./ReopenOnboardingButton";
import { __resetOnboardingForTests, useOnboardingStore } from "../../store/useOnboardingStore";

beforeEach(() => {
  __resetOnboardingForTests();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  __resetOnboardingForTests();
});

describe("ReopenOnboardingButton", () => {
  it("重开引导到第 1 步并清除新内容标志", () => {
    useOnboardingStore.setState({ hasNewContent: true });
    render(<ReopenOnboardingButton />);
    expect(document.querySelector(".onboarding-reopen-dot")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "重新打开新手引导" }));

    const state = useOnboardingStore.getState();
    expect(state.open).toBe(true);
    expect(state.step).toBe(0);
    expect(state.hasNewContent).toBe(false);
  });

  it("本地存储写入失败时仍在当前会话打开引导", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage unavailable");
    });
    render(<ReopenOnboardingButton />);

    expect(() => fireEvent.click(screen.getByRole("button", { name: "重新打开新手引导" }))).not.toThrow();
    expect(useOnboardingStore.getState().open).toBe(true);
  });
});
