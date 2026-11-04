//! 统一错误反馈测试：操作上下文、下一步建议、Toast 错误码与重试动作。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useUiStore } from "../store/useUiStore";
import {
  errorSuggestion,
  formatErrorForUser,
  recordBackgroundError,
  reportError,
} from "./errorReport";
import { AppError, normalizeError } from "./errors";

beforeEach(() => {
  vi.useFakeTimers({ now: 1_000_000 });
  useUiStore.setState({ toast: null, toasts: [] });
});

afterEach(() => {
  useUiStore.setState({ toast: null, toasts: [] });
  vi.useRealTimers();
});

describe("formatErrorForUser", () => {
  it("包含操作、原因与可执行的下一步", () => {
    const err = new AppError("任务不存在", { code: "NOT_FOUND", category: "not_found" });
    const out = formatErrorForUser(err, "完成任务");
    expect(out.message).toContain("完成任务失败：任务不存在");
    expect(out.message).toContain("刷新后确认");
  });

  it("无建议的错误码不追加空句", () => {
    const err = new AppError("未知错误", { code: "UNKNOWN_ERROR", category: "unknown" });
    expect(formatErrorForUser(err, "操作").message).toBe("操作失败：未知错误");
  });

  it("按错误码给出稳定建议", () => {
    expect(errorSuggestion(normalizeError({ code: "DATABASE_BUSY", message: "忙" }))).toContain(
      "稍后重试",
    );
    expect(errorSuggestion(normalizeError({ code: "DATA_INTEGRITY_ERROR", message: "损坏" })))
      .toContain("备份");
  });
});

describe("reportError", () => {
  it("错误 Toast 携带稳定错误码与详情", () => {
    reportError(
      { code: "IO_ERROR", category: "io", message: "文件操作失败", detail: "os error 5", retryable: true },
      { operation: "保存任务", retry: () => {} },
    );
    const toast = useUiStore.getState().toast;
    expect(toast?.kind).toBe("error");
    expect(toast?.code).toBe("IO_ERROR");
    expect(toast?.detail).toBe("os error 5");
    expect(toast?.message).toContain("保存任务失败");
    expect(toast?.action?.label).toBe("重试");
  });

  it("未提供 retry 时不出现重试按钮", () => {
    reportError({ code: "CONFLICT", message: "已有运行" });
    expect(useUiStore.getState().toast?.action).toBeUndefined();
  });

  it("silent 只归一化，不弹 Toast（用于后台或已有内联错误状态）", () => {
    const err = reportError({ code: "AGENT_ERROR", message: "扫描失败" }, { silent: true });
    expect(err.code).toBe("AGENT_ERROR");
    expect(useUiStore.getState().toast).toBeNull();
  });

  it("recordBackgroundError 不主动打扰用户", () => {
    const err = recordBackgroundError("旧格式错误");
    expect(err.code).toBe("UNKNOWN_ERROR");
    expect(useUiStore.getState().toast).toBeNull();
  });
});
