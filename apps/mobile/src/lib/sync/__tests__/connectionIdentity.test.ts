// 连接身份判定单测：决定重新配对后是否重置增量游标。
import { describe, expect, it } from "vitest";

import { connectionIdentityChanged } from "../connectionIdentity";

const base = {
  baseUrl: "https://192.168.1.10:47822",
  instanceId: "instance-a",
  deviceId: "device-1",
};

describe("connectionIdentityChanged", () => {
  it("首次配对（无旧连接）需要重置游标", () => {
    expect(connectionIdentityChanged(null, base)).toBe(true);
  });

  it("同一连接身份重复保存不重置（避免无意义重放）", () => {
    expect(connectionIdentityChanged({ ...base }, { ...base })).toBe(false);
  });

  it("换桌面实例（instanceId 变）重置（真机 cursor=44 > 新库 seq=3 场景）", () => {
    expect(
      connectionIdentityChanged({ ...base }, { ...base, instanceId: "instance-b" }),
    ).toBe(true);
  });

  it("换地址或换授权（deviceId 变）也重置", () => {
    expect(
      connectionIdentityChanged({ ...base }, { ...base, baseUrl: "https://192.168.1.20:47822" }),
    ).toBe(true);
    expect(
      connectionIdentityChanged({ ...base }, { ...base, deviceId: "device-2" }),
    ).toBe(true);
  });
});
