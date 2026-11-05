/**
 * @vitest-environment jsdom
 */
//! 显示模式归一化契约：外壳唯一视图判据只能是三个合法枚举。
//! 非法值（空串 / 大小写变体 / 未来枚举 / 非字符串）一律回退 `full`，
//! 保证 `.view-slot` 至少有一个 active，不会出现「只剩标题栏」的空白窗口。

import { describe, expect, it } from "vitest";
import { isWindowMode, resolveWindowMode } from "./windowMode";

describe("windowMode", () => {
  it("合法枚举原样返回", () => {
    for (const mode of ["minimal", "compact", "full"] as const) {
      expect(isWindowMode(mode)).toBe(true);
      expect(resolveWindowMode(mode)).toBe(mode);
    }
  });

  it("非法 / 损坏 / 缺失值回退 full", () => {
    for (const raw of ["", "Full", "FULL", "complete", " minimal", null, undefined, 0, {}, []]) {
      expect(isWindowMode(raw)).toBe(false);
      expect(resolveWindowMode(raw)).toBe("full");
    }
  });
});
