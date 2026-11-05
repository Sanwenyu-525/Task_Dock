// @vitest-environment jsdom
//! 用户可见反馈（Toast / 错误提示）随语言切换：
//! Toast 组件本身不翻译文案，调用方用 `t()` 生成；这里验证「调用方 + Toast」
//! 链路在英文模式下不输出中文、不出现 undefined，并在切换语言后就地更新。

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Toast from "../components/Toast";
import { useUiStore } from "../store/useUiStore";
import { __resetLocaleForTests, setLocalePreference, t } from "./index";
import { localizedErrorMessage } from "./errors";

beforeEach(() => {
  __resetLocaleForTests();
  vi.useFakeTimers({ now: 1_000_000 });
  useUiStore.setState({ toast: null, toasts: [] });
});

afterEach(() => {
  cleanup();
  useUiStore.setState({ toast: null, toasts: [] });
  vi.useRealTimers();
  __resetLocaleForTests();
});

describe("Toast 文案本地化", () => {
  it("英文模式下成功/错误提示使用词典文案，带参数不出现占位符", () => {
    setLocalePreference("en-US");
    render(<Toast />);

    act(() => {
      useUiStore.getState().showToast(
        t("apps.launchRefreshFailed"),
        { kind: "success" },
      );
    });
    expect(screen.getByText("App launched, but \"recently used\" could not refresh")).toBeTruthy();

    act(() => {
      useUiStore.getState().dismissToast();
      useUiStore.getState().showToast(
        t("settings.clipboard.cleanupFailed", { error: "boom" }),
        { kind: "error" },
      );
    });
    const error = screen.getByText("Cleanup failed: boom");
    expect(error.closest(".toast")?.getAttribute("role")).toBe("alert");
    expect(error.textContent).not.toContain("{error}");
  });

  it("中文模式下同一键输出中文，切换语言后新提示切换语言", () => {
    render(<Toast />);
    act(() => {
      useUiStore.getState().showToast(t("settings.data.auditNone"), { kind: "success" });
    });
    expect(screen.getByText("没有可证明的测试/压测数据")).toBeTruthy();

    act(() => {
      setLocalePreference("en-US");
      useUiStore.getState().dismissToast();
      useUiStore.getState().showToast(t("settings.data.auditNone"), { kind: "success" });
    });
    expect(screen.getByText("No provable test / benchmark data")).toBeTruthy();
  });
});

describe("错误提示本地化", () => {
  it("结构化错误在英文模式只输出本地化通用文案，不混入中文原因", () => {
    setLocalePreference("en-US");
    const text = localizedErrorMessage({
      code: "DATABASE_BUSY",
      message: "数据库正忙",
      reason: "写锁超时",
    });
    expect(text).toBe("The database is busy. Try again shortly.");
    expect(text).not.toMatch(/[\u4e00-\u9fff]/);
  });

  it("未知错误码与非法语言偏好都回退到明确文案，不返回 undefined", () => {
    setLocalePreference("fr-FR" as never);
    expect(localizedErrorMessage({ code: "NOT_A_REAL_CODE", message: "" })).toBe(
      "发生未知错误",
    );
  });
});
