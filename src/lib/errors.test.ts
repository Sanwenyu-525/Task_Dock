//! 统一错误模型测试：结构化错误码、旧格式兼容、安全文案与 IPC 归一化。

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import {
  AppError,
  errorMessage,
  invokeCommand,
  isRetryable,
  normalizeError,
} from "./errors";

const mockedInvoke = vi.mocked(invoke);

beforeEach(() => {
  mockedInvoke.mockReset();
});

describe("normalizeError · 结构化 payload", () => {
  it("保留后端错误码/分类/可重试标记与安全文案", () => {
    const err = normalizeError({
      code: "DATABASE_BUSY",
      category: "database",
      severity: "warning",
      retryable: true,
      message: "数据库正忙",
      detail: "sqlite code=DatabaseBusy",
    }, "保存任务");

    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe("DATABASE_BUSY");
    expect(err.category).toBe("database");
    expect(err.retryable).toBe(true);
    expect(err.operation).toBe("保存任务");
    expect(err.detail).toContain("sqlite");
    expect(err.toString()).toBe("数据库正忙");
  });

  it("不因文案缺少特征而误判：结构化 code 优先于文案", () => {
    const err = normalizeError({
      code: "PERMISSION_DENIED",
      category: "permission",
      severity: "error",
      retryable: false,
      message: "操作被拒绝",
    });
    expect(err.code).toBe("PERMISSION_DENIED");
    expect(err.legacy).toBe(false);
  });
});

describe("normalizeError · 旧格式兼容", () => {
  it("字符串保留可读文案并做兜底分类", () => {
    const err = normalizeError("未找到: 任务不存在");
    expect(err.message).toBe("任务不存在");
    expect(err.legacy).toBe(true);
    expect(err.code).toBe("NOT_FOUND");
    expect(isRetryable(err)).toBe(false);
  });

  it("Error 实例直接取 message，不产生 [object Object]", () => {
    const err = normalizeError(new Error("网络超时"));
    expect(err.message).toBe("网络超时");
    expect(err.toString()).toBe("网络超时");
    expect(err.code).toBe("TIMEOUT");
  });

  it("未知对象不会抛出，返回可读兜底文案", () => {
    expect(errorMessage({ foo: 1 })).toBe('{"foo":1}');
    expect(errorMessage(undefined)).toBe("未知错误");
  });
});

describe("invokeCommand", () => {
  it("成功时透传结果", async () => {
    mockedInvoke.mockResolvedValueOnce({ ok: true });
    await expect(invokeCommand<{ ok: boolean }>("cmd", { a: 1 })).resolves.toEqual({ ok: true });
  });

  it("失败时统一抛 AppError（结构化与旧字符串均可）", async () => {
    mockedInvoke.mockRejectedValueOnce({
      code: "SERVICE_OVERLOADED",
      category: "service",
      severity: "warning",
      retryable: true,
      message: "服务繁忙，请稍后重试：队列已满",
    });
    await expect(invokeCommand("cmd")).rejects.toMatchObject({
      code: "SERVICE_OVERLOADED",
      retryable: true,
    });

    mockedInvoke.mockRejectedValueOnce("IO 错误: 文件被占用");
    await expect(invokeCommand("cmd")).rejects.toBeInstanceOf(AppError);
  });
});
