//! 投屏启动配置 Store：切页恢复与按设备隔离。

import { beforeEach, describe, expect, it } from "vitest";

import { useVirtualDisplayStore } from "./useVirtualDisplayStore";

beforeEach(() => {
  useVirtualDisplayStore.setState({ configs: {} });
});

describe("useVirtualDisplayStore", () => {
  it("页面卸载后仍能恢复同一设备的配置", () => {
    const store = useVirtualDisplayStore.getState();
    store.setVirtualDisplayConfig("UID-A", {
      mode: "virtual",
      selectedPackage: "com.android.settings",
      size: "1920x1080/384",
      multiDisplayEnabled: true,
      clipboardSync: true,
    });

    // 模拟组件重新挂载：重新读取 store（不清空）。
    const restored = useVirtualDisplayStore
      .getState()
      .restoreVirtualDisplayConfig("UID-A");
    expect(restored).toEqual({
      mode: "virtual",
      selectedPackage: "com.android.settings",
      size: "1920x1080/384",
      multiDisplayEnabled: true,
      clipboardSync: true,
    });
  });

  it("不同物理设备的配置互不影响", () => {
    const store = useVirtualDisplayStore.getState();
    store.setVirtualDisplayConfig("UID-A", {
      mode: "virtual",
      selectedPackage: "com.android.settings",
      multiDisplayEnabled: false,
    });
    store.setVirtualDisplayConfig("UID-B", {
      mode: "mirror",
      multiDisplayEnabled: true,
    });

    expect(useVirtualDisplayStore.getState().getVirtualDisplayConfig("UID-A")).toMatchObject({
      mode: "virtual",
      selectedPackage: "com.android.settings",
    });
    expect(useVirtualDisplayStore.getState().getVirtualDisplayConfig("UID-B")).toMatchObject({
      mode: "mirror",
      multiDisplayEnabled: true,
    });
  });

  it("清空配置只影响指定设备", () => {
    const store = useVirtualDisplayStore.getState();
    store.setVirtualDisplayConfig("UID-A", { mode: "virtual", multiDisplayEnabled: false });
    store.setVirtualDisplayConfig("UID-B", { mode: "mirror", multiDisplayEnabled: false });
    store.clearVirtualDisplayConfig("UID-A");

    expect(useVirtualDisplayStore.getState().getVirtualDisplayConfig("UID-A")).toBeUndefined();
    expect(useVirtualDisplayStore.getState().getVirtualDisplayConfig("UID-B")).toBeTruthy();
  });

  it("空设备 UID 不写入、不读取", () => {
    const store = useVirtualDisplayStore.getState();
    store.setVirtualDisplayConfig("", { mode: "mirror", multiDisplayEnabled: false });
    expect(store.getVirtualDisplayConfig("")).toBeUndefined();
    expect(useVirtualDisplayStore.getState().configs).toEqual({});
  });
});
