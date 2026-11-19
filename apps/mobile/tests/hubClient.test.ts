// Hub 客户端：请求体签名、时间戳/nonce、HTTPS 守卫与响应校验。
// 用注入的 fetch/identity 验证协议字节，不触达真实网络。
import { describe, expect, it } from "vitest";

import { canonicalStringify } from "../src/lib/hub/canonical";
import {
  assertSecureControlPlaneUrl,
  createHubClient,
  HubApiError,
} from "../src/lib/hub/hubClient";
import type { DeviceIdentityApi } from "../src/lib/hub/identity";

const NOW = Date.parse("2026-11-19T04:05:06.000Z");
const NONCE = "22222222-2222-4222-8222-222222222222";
const LOCAL_IDENTITY = {
  deviceId: "11111111-1111-4111-8111-111111111111",
  publicKeyBase64: "iojj3XQJ8ZX9UtstPLpdcspnCb8dlBIb83SIAbQPb1w=",
  fingerprint: "34750f98bd59fcfc946da45aaabe933b",
};

function identity(signPayload: (payload: string) => Promise<string>): DeviceIdentityApi {
  return {
    ensureIdentity: async () => LOCAL_IDENTITY,
    getIdentity: async () => LOCAL_IDENTITY,
    signPayload,
    signCanonical: async (body) => signPayload(canonicalStringify(body)),
    getFingerprint: async () => LOCAL_IDENTITY.fingerprint,
    getProtectionLevel: async () => "tee",
    deleteIdentity: async () => undefined,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("createHubClient", () => {
  it("自动附加 timestamp/nonce/signature，签名覆盖 canonical(body-sans-signature)", async () => {
    let sent: { url: string; init: RequestInit } | null = null;
    let signedPayload = "";
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      sent = { url: String(url), init: init ?? {} };
      return jsonResponse(201, {
        ok: true,
        requestId: "33333333-3333-4333-8333-333333333333",
        status: "awaiting_pc_approval",
        expiresAt: "2026-11-19T04:10:06.000Z",
      });
    }) as typeof fetch;

    const client = createHubClient({
      baseUrl: "https://hub.example.com/",
      identity: identity(async (payload) => {
        signedPayload = payload;
        return Buffer.alloc(64, 1).toString("base64");
      }),
      fetchImpl,
      now: () => NOW,
      newNonce: () => NONCE,
    });

    const ack = await client.submitPairingRequest({
      invitationId: "44444444-4444-4444-8444-444444444444",
      invitationSecret: "EREREREREREREREREREREQ==",
      displayName: "Test Phone",
    });
    expect(ack.status).toBe("awaiting_pc_approval");
    expect(sent).not.toBeNull();
    const request = sent as unknown as { url: string; init: RequestInit };
    expect(request.url).toBe("https://hub.example.com/v1/pairing/request");
    expect(request.init.method).toBe("POST");

    const body = JSON.parse(String(request.init.body)) as Record<string, unknown>;
    expect(body.timestamp).toBe("2026-11-19T04:05:06.000Z");
    expect(body.nonce).toBe(NONCE);
    expect(body.deviceId).toBe(LOCAL_IDENTITY.deviceId);
    expect(body.deviceType).toBe("android");
    expect(typeof body.signature).toBe("string");

    const { signature: _signature, ...signed } = body;
    expect(signedPayload).toBe(canonicalStringify(signed));
  });

  it("拒绝 http Control Plane", () => {
    expect(() => assertSecureControlPlaneUrl("http://hub.example.com")).toThrow(HubApiError);
    expect(() => createHubClient({ baseUrl: "http://hub.example.com", identity: identity(async () => "") })).toThrow(
      "必须使用 HTTPS",
    );
  });

  it("允许显式开启的 loopback 开发地址", () => {
    expect(assertSecureControlPlaneUrl("http://127.0.0.1:8787", true)).toBe(
      "http://127.0.0.1:8787",
    );
    expect(() => assertSecureControlPlaneUrl("http://192.168.1.2:8787", true)).toThrow();
  });

  it("approved 缺少 peer 时按不可信响应拒绝", async () => {
    const fetchImpl = (async () =>
      jsonResponse(200, { ok: true, status: "approved" })) as typeof fetch;
    const client = createHubClient({
      baseUrl: "https://hub.example.com",
      identity: identity(async () => Buffer.alloc(64, 1).toString("base64")),
      fetchImpl,
    });
    await expect(
      client.getPairingStatus({ requestId: "33333333-3333-4333-8333-333333333333" }),
    ).rejects.toMatchObject({ code: "SERVER_INVALID" });
  });

  it("服务端错误码原样保留，供上层 fail-closed 判定", async () => {
    const fetchImpl = (async () =>
      jsonResponse(401, {
        ok: false,
        error: { code: "INVALID_SIGNATURE", message: "bad signature" },
      })) as typeof fetch;
    const client = createHubClient({
      baseUrl: "https://hub.example.com",
      identity: identity(async () => Buffer.alloc(64, 1).toString("base64")),
      fetchImpl,
    });
    await expect(
      client.getPairingStatus({ requestId: "33333333-3333-4333-8333-333333333333" }),
    ).rejects.toMatchObject({ code: "INVALID_SIGNATURE", status: 401 });
  });
});
