// 导航迁移表：重构后所有旧入口都必须仍有可达位置。
import { describe, expect, it } from "vitest";

import { NAVIGATION_MAP, isLegacyEntryReachable, type LegacyEntry } from "../navigationMap";

const LEGACY: LegacyEntry[] = ["tasks", "inbox", "notes", "device", "settings"];

describe("NAVIGATION_MAP", () => {
  it("五个旧入口全部有映射，没有导航倒退", () => {
    expect(NAVIGATION_MAP).toHaveLength(LEGACY.length);
    for (const entry of LEGACY) {
      expect(isLegacyEntryReachable(entry)).toBe(true);
    }
  });

  it("任务仍是一级栏；收集箱与笔记改为工具栏下的二级页", () => {
    const tasks = NAVIGATION_MAP.find((mapping) => mapping.legacy === "tasks");
    expect(tasks).toMatchObject({ primary: "tasks", via: "tab" });

    for (const legacy of ["inbox", "notes"] as const) {
      const mapping = NAVIGATION_MAP.find((item) => item.legacy === legacy);
      expect(mapping).toMatchObject({ primary: "tools", via: "push" });
      expect(mapping?.shortcuts).toContain("home");
    }
  });

  it("设备与设置都收敛到「我的」，且保留二级页直达", () => {
    for (const legacy of ["device", "settings"] as const) {
      const mapping = NAVIGATION_MAP.find((item) => item.legacy === legacy);
      expect(mapping).toMatchObject({ primary: "profile", via: "push" });
    }
  });
});
