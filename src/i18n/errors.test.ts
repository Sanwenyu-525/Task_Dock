import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppError, ERROR_CODES, normalizeError } from "../lib/errors";
import { ERROR_MESSAGE_KEYS, localizedErrorMessage } from "./errors";
import { __resetLocaleForTests, setLocalePreference } from "./index";

beforeEach(() => {
  __resetLocaleForTests();
});

afterEach(() => {
  __resetLocaleForTests();
});

describe("错误码映射", () => {
  it("覆盖全部稳定错误码", () => {
    for (const code of ERROR_CODES) {
      expect(ERROR_MESSAGE_KEYS[code]).toBeTruthy();
    }
  });

  it("结构化错误按 code 本地化", () => {
    const error = new AppError("raw message", { code: "NOT_FOUND" });
    expect(localizedErrorMessage(error)).toBe("目标不存在或已被删除");

    setLocalePreference("en-US");
    expect(localizedErrorMessage(error)).toBe("The item does not exist or was deleted.");
  });

  it("旧格式错误保留原始文案，不做中文匹配", () => {
    const legacy = normalizeError("磁盘写入失败：磁盘已满");
    expect(legacy.legacy).toBe(true);
    expect(localizedErrorMessage(legacy)).toBe("磁盘写入失败：磁盘已满");

    setLocalePreference("en-US");
    expect(localizedErrorMessage(legacy)).toBe("磁盘写入失败：磁盘已满");
  });

  it("中文模式保留后端给出的具体业务原因，不抹成通用文案", () => {
    expect(
      localizedErrorMessage(new AppError("标题不能为空", { code: "VALIDATION_ERROR" })),
    ).toBe("标题不能为空");
    expect(
      localizedErrorMessage(new AppError("程序路径不存在", { code: "NOT_FOUND" })),
    ).toBe("程序路径不存在");
  });

  it("英文模式不混入中文技术错误，回退本地化通用文案", () => {
    setLocalePreference("en-US");
    const error = new AppError("数据库正忙", { code: "DATABASE_BUSY" });
    expect(localizedErrorMessage(error)).not.toContain("数据库");
    expect(localizedErrorMessage(error)).toMatch(/busy|try again/i);
  });

  it("未知 payload 有稳定本地化回退", () => {
    expect(localizedErrorMessage({ foo: 1 })).toBe("发生未知错误");
    setLocalePreference("en-US");
    expect(localizedErrorMessage({ foo: 1 })).toBe("An unexpected error occurred.");
  });

  it("后端新增未知错误码时回退通用文案，不返回 undefined", () => {
    const future = normalizeError({ code: "FUTURE_ERROR_CODE", message: "raw message" });
    expect(future.legacy).toBe(false);
    expect(localizedErrorMessage(future)).toBe("发生未知错误");

    setLocalePreference("en-US");
    expect(localizedErrorMessage(future)).toBe("An unexpected error occurred.");
  });
});
