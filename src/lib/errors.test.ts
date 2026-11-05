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
  sanitizeForUser,
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
    // 不可信对象绝不序列化展示（可能含内部字段/敏感信息）
    expect(errorMessage({ foo: 1 })).toBe("未知错误");
    expect(errorMessage(undefined)).toBe("未知错误");
    expect(errorMessage(42)).toBe("未知错误");
  });

  it("后端新增未知错误码时使用稳定回退，不展示原始 message", () => {
    const err = normalizeError({
      code: "FUTURE_ERROR_CODE",
      message: "SELECT password FROM users WHERE id = 1",
      detail: "SELECT * FROM secrets",
    });
    expect(err.code).toBe("UNKNOWN_ERROR");
    expect(err.message).toBe("未知错误");
    expect(err.message).not.toContain("SELECT");
    expect(err.detail ?? "").not.toContain("SELECT");
  });

  it("脱敏：路径、令牌、SQL 与堆栈不进入用户文案，业务原因保留", () => {
    const err = normalizeError(
      "读取 C:\\Users\\alice\\secret.txt 失败；token=abcdef123456；\n" +
        "SELECT * FROM tasks WHERE token = 'abc'\n" +
        "at src/main.rs:10\n" +
        "/Users/bob/Library/logs 与 /home/carol/.config 不可用",
    );
    expect(err.message).toContain("读取");
    expect(err.message).toContain("失败");
    expect(err.message).not.toMatch(/alice|bob|carol/);
    expect(err.message).not.toContain("abcdef123456");
    expect(err.message).not.toContain("SELECT");
    expect(err.message).not.toContain("src/main.rs");
  });

  it("AppError 构造即脱敏，detail 不保留明文敏感值", () => {
    const err = new AppError("保存失败：authorization: Bearer abcdef123456", {
      code: "IO_ERROR",
      detail: "C:\\Users\\alice\\AppData\\Local\\taskdock\\db.sqlite",
    });
    expect(err.message).not.toContain("abcdef123456");
    expect(err.detail).not.toContain("alice");
  });

  it("本地绝对路径不原样展示，错误语义保留", () => {
    const noSpace = sanitizeForUser("启动失败: C:\\Tools\\bin\\app.exe（系统找不到指定的程序文件）");
    expect(noSpace).toContain("启动失败");
    expect(noSpace).toContain("系统找不到指定的程序文件");
    expect(noSpace).not.toContain("C:\\Tools");
    expect(noSpace).not.toContain("app.exe");

    const spaced = sanitizeForUser("启动失败: C:\\Program Files\\App\\app.exe（权限不足）");
    expect(spaced).toContain("启动失败");
    expect(spaced).toContain("权限不足");
    expect(spaced).not.toContain("C:\\");
    expect(spaced).not.toContain("app.exe");

    // 路径后的自然语言不得被一并吞掉
    const trailing = sanitizeForUser("读取 C:\\Users\\alice\\secret.txt 失败");
    expect(trailing).toContain("读取");
    expect(trailing).toContain("失败");
    expect(trailing).not.toContain("alice");
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
