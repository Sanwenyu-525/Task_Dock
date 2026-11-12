// 遗留连接判定单测：设备页与同步页共用同一口径，避免「一处已连接、一处需重新配对」。
import { describe, expect, it } from "vitest";

import { isLegacyConnection } from "../connectionState";

const PIN = "a".repeat(64);

describe("isLegacyConnection", () => {
  it("没有连接记录时不算遗留（未配对）", () => {
    expect(isLegacyConnection(null)).toBe(false);
    expect(isLegacyConnection(undefined)).toBe(false);
  });

  it("http:// 地址即使带指纹也判为遗留（桌面端已 TLS-only）", () => {
    expect(isLegacyConnection({ baseUrl: "http://192.168.1.5:47822", tlsFingerprint: PIN })).toBe(
      true,
    );
  });

  it("https:// 但缺少 SPKI 指纹判为遗留（同步会 fail-closed）", () => {
    expect(isLegacyConnection({ baseUrl: "https://192.168.1.5:47822", tlsFingerprint: "" })).toBe(
      true,
    );
    expect(
      isLegacyConnection({ baseUrl: "https://192.168.1.5:47822", tlsFingerprint: "not-hex" }),
    ).toBe(true);
  });

  it("https:// + 64 位 hex 指纹是当前协议的健康记录", () => {
    expect(isLegacyConnection({ baseUrl: "https://192.168.1.5:47822", tlsFingerprint: PIN })).toBe(
      false,
    );
  });

  it("指纹大小写不敏感，首尾空白不影响判断", () => {
    expect(
      isLegacyConnection({
        baseUrl: "https://192.168.1.5:47822",
        tlsFingerprint: `  ${PIN.toUpperCase()}  `,
      }),
    ).toBe(false);
  });
});
