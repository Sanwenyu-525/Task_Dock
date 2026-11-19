// 设备身份 JS 包装：原生边界只接受 32B 公钥与 64B 签名，指纹必须与公钥自洽。
// 这里用注入的假原生模块验证 fail-closed，不需要真机/Keystore。
import { describe, expect, it, vi } from "vitest";

import { createDeviceIdentityApi, type DeviceIdentityNative } from "../src/lib/hub/identity";

const PUBLIC_KEY_BASE64 = "iojj3XQJ8ZX9UtstPLpdcspnCb8dlBIb83SIAbQPb1w=";
const FINGERPRINT = "34750f98bd59fcfc946da45aaabe933b";
const SIGNATURE = Buffer.alloc(64, 7).toString("base64");

function native(overrides: Partial<DeviceIdentityNative> = {}): DeviceIdentityNative {
  return {
    ensureIdentity: async () => ({
      deviceId: "11111111-1111-4111-8111-111111111111",
      publicKeyBase64: PUBLIC_KEY_BASE64,
      fingerprint: FINGERPRINT,
    }),
    getIdentity: async () => ({
      deviceId: "11111111-1111-4111-8111-111111111111",
      publicKeyBase64: PUBLIC_KEY_BASE64,
      fingerprint: FINGERPRINT,
    }),
    sign: async () => SIGNATURE,
    getProtectionLevel: async () => "tee",
    deleteIdentity: async () => undefined,
    ...overrides,
  };
}

describe("device identity 包装", () => {
  it("接受公钥/指纹自洽的身份", async () => {
    const api = createDeviceIdentityApi(native());
    await expect(api.ensureIdentity()).resolves.toEqual({
      deviceId: "11111111-1111-4111-8111-111111111111",
      publicKeyBase64: PUBLIC_KEY_BASE64,
      fingerprint: FINGERPRINT,
    });
  });

  it("指纹与公钥不一致时拒绝使用", async () => {
    const api = createDeviceIdentityApi(
      native({
        ensureIdentity: async () => ({
          deviceId: "11111111-1111-4111-8111-111111111111",
          publicKeyBase64: PUBLIC_KEY_BASE64,
          fingerprint: "f".repeat(32),
        }),
      }),
    );
    await expect(api.ensureIdentity()).rejects.toMatchObject({ code: "identity_invalid" });
  });

  it("签名载荷按 UTF-8 转 base64 交给原生，并校验 64 字节签名", async () => {
    const sign = vi.fn(async (_payloadBase64: string) => SIGNATURE);
    const api = createDeviceIdentityApi(native({ sign }));
    const payload = '{"a":"中文"}';
    await expect(api.signPayload(payload)).resolves.toBe(SIGNATURE);
    expect(Buffer.from(sign.mock.calls[0][0], "base64").toString("utf8")).toBe(payload);
  });

  it("原生返回非 64 字节签名时拒绝", async () => {
    const api = createDeviceIdentityApi(native({ sign: async () => "c2hvcnQ=" }));
    await expect(api.signPayload("payload")).rejects.toMatchObject({ code: "identity_invalid" });
  });

  it("原生模块缺失时明确失败，不伪造签名", async () => {
    const api = createDeviceIdentityApi(null);
    await expect(api.ensureIdentity()).rejects.toMatchObject({ code: "identity_unavailable" });
    await expect(api.signPayload("payload")).rejects.toMatchObject({
      code: "identity_unavailable",
    });
  });

  it("未知保护等级按 software 上报，不冒称硬件保护", async () => {
    const api = createDeviceIdentityApi(
      native({ getProtectionLevel: async () => "unknown" as never }),
    );
    await expect(api.getProtectionLevel()).resolves.toBe("software");
  });
});
