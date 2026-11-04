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
});
