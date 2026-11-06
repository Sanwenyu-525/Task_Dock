//! 导航布局一致性校验：孤儿入口与损坏回退只记录诊断，不改用户数据。
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ logEvent: vi.fn() }));

vi.mock("./diagnostics", () => ({ logEvent: mocks.logEvent }));
// 一致性校验模块会导入设置 store（其内部依赖 Tauri bridge）；这里只测纯校验逻辑。
vi.mock("../store/useSettingsStore", () => ({
  useSettingsStore: { getState: () => ({ settings: null }), subscribe: () => () => {} },
}));

import { checkNavigationLayout } from "./consistencyChecks";

describe("checkNavigationLayout", () => {
  beforeEach(() => mocks.logEvent.mockReset());

  it("孤儿入口（存储里有、注册中心没有）记录 WARN 且不改数据", () => {
    checkNavigationLayout({
      version: 1,
      left: ["tasks", "ghost-entry"],
      capsule: ["agents"],
      known: { left: ["tasks", "ghost-entry", "agents"], capsule: ["agents"] },
    });
    expect(mocks.logEvent).toHaveBeenCalledTimes(1);
    expect(mocks.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "WARN",
        module: "navigation",
        action: "layout_check",
        event: "orphan_entries",
        error_code: "CONFIG_ERROR",
      }),
    );
  });

  it("结构损坏时记录回退事件（用户自定义可能丢失）", () => {
    checkNavigationLayout({ left: "not-an-array" });
    expect(mocks.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event: "invalid_fallback", error_code: "CONFIG_ERROR" }),
    );
  });

  it("首次使用（无配置）不误报", () => {
    checkNavigationLayout(null);
    checkNavigationLayout(undefined);
    expect(mocks.logEvent).not.toHaveBeenCalled();
  });

  it("正常配置不产生任何事件，避免假阳性", () => {
    checkNavigationLayout({
      version: 1,
      left: ["tasks"],
      capsule: ["agents"],
      known: { left: ["tasks", "agents"], capsule: ["agents"] },
    });
    expect(mocks.logEvent).not.toHaveBeenCalled();
  });
});
