// Personal Hub 配对：二维码解析 + 状态机 + 安全拒绝路径。
//
// QR 固定向量由 node:crypto 用 seed=0x02*32 生成（跨端一致性验证），
// 这样解析/验签不是「自己签自己验」的循环论证。
import { describe, expect, it, vi } from "vitest";

import {
  assertSecureControlPlaneUrl,
  HubApiError,
  type HubClient,
  type PairingStatusResult,
} from "../src/lib/hub/hubClient";
import type { DeviceIdentityApi } from "../src/lib/hub/identity";
import {
  HubPairingError,
  pairWithHub,
  parseHubInvitation,
  toInvitationView,
  type HubPairingState,
} from "../src/lib/hub/pairing";

const QR =
  "eyJ2IjoxLCJjcCI6Imh0dHBzOi8vaHViLmV4YW1wbGUuY29tIiwiaWlkIjoiMzMzMzMzMzMtMzMzMy00MzMzLTgzMzMtMzMzMzMzMzMzMzMzIiwic2VjIjoiRVJFUkVSRVJFUkVSRVJFUkVSRVJFUT09Iiwibm9uY2UiOiI0NDQ0NDQ0NC00NDQ0LTQ0NDQtODQ0NC00NDQ0NDQ0NDQ0NDQiLCJleHAiOiIyMDMwLTAxLTAxVDAwOjAwOjAwLjAwMFoiLCJoaWQiOiI1NTU1NTU1NS01NTU1LTQ1NTUtODU1NS01NTU1NTU1NTU1NTUiLCJocGsiOiJnVGwzRHFoOUYxOVdvMVJtdzB4K3pNdU5pcEcwN2plaVhmWVBXNC9KczVRPSIsImhmcCI6IjZhMzgwM2Q1ZjA1OTkwMmExYzZkYWZiYzliYTQ3MjkyIiwic2lnIjoiNmRBMTUxdHJUdUtlTUZzQVIxUnVWRU8zTE1tdXBtY1ozRlZKa2RvdU9qTlVlMWpETElQY3lwV2FyNzdnc2JkZmM2VTNCeHBSZHRrTk83aW9oeWtBQ2c9PSJ9";
const HUB_ID = "55555555-5555-4555-8555-555555555555";
const HUB_FP = "6a3803d5f059902a1c6dafbc9ba47292";
const INVITATION_SECRET = "EREREREREREREREREREREQ==";
const REQUEST_ID = "66666666-6666-4666-8666-666666666666";

const LOCAL_IDENTITY = {
  deviceId: "77777777-7777-4777-8777-777777777777",
  publicKeyBase64: "iojj3XQJ8ZX9UtstPLpdcspnCb8dlBIb83SIAbQPb1w=",
  fingerprint: "34750f98bd59fcfc946da45aaabe933b",
};

const identity: DeviceIdentityApi = {
  ensureIdentity: async () => LOCAL_IDENTITY,
  getIdentity: async () => LOCAL_IDENTITY,
  signPayload: async () => "c2lnbmF0dXJl",
  signCanonical: async () => "c2lnbmF0dXJl",
  getFingerprint: async () => LOCAL_IDENTITY.fingerprint,
  getProtectionLevel: async () => "tee",
  deleteIdentity: async () => undefined,
};

function qrJson(): Record<string, unknown> {
  return JSON.parse(Buffer.from(QR, "base64url").toString("utf8")) as Record<string, unknown>;
}

function encodeQr(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

class FakeClient implements HubClient {
  readonly baseUrl = "https://hub.example.com";
  submitCalls = 0;
  statusCalls = 0;

  constructor(
    private readonly statuses: Array<PairingStatusResult | Error>,
    private readonly ackExpiresAt: string = "2030-01-01T00:00:00.000Z",
  ) {}

  async submitPairingRequest(): Promise<{
    requestId: string;
    status: "awaiting_pc_approval";
    expiresAt: string;
  }> {
    this.submitCalls += 1;
    return {
      requestId: REQUEST_ID,
      status: "awaiting_pc_approval",
      expiresAt: this.ackExpiresAt,
    };
  }

  async getPairingStatus(): Promise<PairingStatusResult> {
    const next = this.statuses[Math.min(this.statusCalls, this.statuses.length - 1)];
    this.statusCalls += 1;
    if (next instanceof Error) throw next;
    return next;
  }
}

interface RunOptions {
  client: FakeClient;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  audit?: (event: unknown) => void;
}

async function run(options: RunOptions) {
  const states: HubPairingState[] = [];
  const result = await pairWithHub({
    qrPayload: QR,
    identity,
    deviceName: "Test Phone",
    createClient: () => options.client,
    onState: (state) => states.push(state),
    now: options.now,
    sleep: options.sleep ?? (async () => undefined),
    signal: options.signal,
    audit: options.audit ?? (() => undefined),
  });
  return { result, states };
}

async function expectPairingError(action: Promise<unknown>, code: string): Promise<void> {
  await expect(action).rejects.toMatchObject({ name: "HubPairingError", code });
}

describe("parseHubInvitation", () => {
  it("接受签名自洽、未过期且指纹匹配的二维码", () => {
    const invitation = parseHubInvitation(QR, { now: () => Date.parse("2026-11-19T00:00:00Z") });
    expect(invitation.hid).toBe(HUB_ID);
    expect(invitation.hfp).toBe(HUB_FP);
    expect(invitation.sec).toBe(INVITATION_SECRET);
    expect(invitation.cp).toBe("https://hub.example.com");
  });

  it("剔除 invitation secret 后才交给 UI", () => {
    const invitation = parseHubInvitation(QR, { now: () => Date.parse("2026-11-19T00:00:00Z") });
    const view = toInvitationView(invitation);
    expect("sec" in view).toBe(false);
    expect(JSON.stringify(view)).not.toContain(INVITATION_SECRET);
  });

  it("拒绝过期邀请", async () => {
    await expectPairingError(
      Promise.resolve().then(() =>
        parseHubInvitation(QR, { now: () => Date.parse("2031-01-01T00:00:00Z") }),
      ),
      "QR_EXPIRED",
    );
  });

  it("拒绝被篡改内容的签名", async () => {
    const tampered = qrJson();
    tampered.cp = "https://attacker.example.com";
    await expectPairingError(
      Promise.resolve().then(() => parseHubInvitation(encodeQr(tampered))),
      "QR_SIGNATURE_INVALID",
    );
  });

  it("拒绝伪造的指纹", async () => {
    const tampered = qrJson();
    tampered.hfp = "f".repeat(32);
    await expectPairingError(
      Promise.resolve().then(() => parseHubInvitation(encodeQr(tampered))),
      "QR_FINGERPRINT_MISMATCH",
    );
  });

  it("拒绝不支持的协议版本", async () => {
    const tampered = qrJson();
    tampered.v = 2;
    await expectPairingError(
      Promise.resolve().then(() => parseHubInvitation(encodeQr(tampered))),
      "VERSION_UNSUPPORTED",
    );
  });

  it("拒绝额外字段与非 JSON 内容", async () => {
    const extra = qrJson();
    extra.unexpected = "x";
    await expectPairingError(
      Promise.resolve().then(() => parseHubInvitation(encodeQr(extra))),
      "QR_INVALID",
    );
    await expectPairingError(
      Promise.resolve().then(() => parseHubInvitation("not-a-qr")),
      "QR_INVALID",
    );
  });

  it("拒绝非 HTTPS 的 Control Plane", async () => {
    const tampered = qrJson();
    tampered.cp = "http://hub.example.com";
    // URL 守卫先于签名校验：明文地址直接拒绝，不进入网络层。
    await expectPairingError(
      Promise.resolve().then(() => parseHubInvitation(encodeQr(tampered))),
      "INSECURE_URL",
    );
    expect(() => assertSecureControlPlaneUrl("http://hub.example.com")).toThrow(
      "Control Plane 必须使用 HTTPS",
    );
    expect(() => assertSecureControlPlaneUrl("https://hub.example.com/")).not.toThrow();
  });
});

describe("pairWithHub 状态机", () => {
  it("awaiting_pc_approval → approved，并返回可人工比对的电脑指纹", async () => {
    const client = new FakeClient([
      { status: "awaiting_pc_approval" },
      {
        status: "approved",
        peer: {
          deviceId: HUB_ID,
          displayName: "My PC",
          deviceType: "windows-hub",
          identityFingerprint: HUB_FP,
        },
      },
    ]);
    const { result, states } = await run({ client });
    expect(result.status).toBe("approved");
    expect(result.peer?.identityFingerprint).toBe(HUB_FP);
    expect(states.map((state) => state.phase)).toEqual([
      "verified",
      "submitting",
      "awaiting_pc_approval",
      "awaiting_pc_approval",
      "approved",
    ]);
    // UI 状态任何时刻都不能携带 invitation secret。
    expect(JSON.stringify(states)).not.toContain(INVITATION_SECRET);
  });

  it("awaiting_pc_approval → rejected", async () => {
    const client = new FakeClient([{ status: "rejected" }]);
    const { result, states } = await run({ client });
    expect(result.status).toBe("rejected");
    expect(states[states.length - 1]?.phase).toBe("rejected");
  });

  it("云端判定 expired 时立即结束", async () => {
    const client = new FakeClient([{ status: "expired" }]);
    const { result } = await run({ client });
    expect(result.status).toBe("expired");
  });

  it("邀请到期仍未批准时返回 expired，不再继续轮询", async () => {
    let nowMs = Date.parse("2026-11-19T00:00:00Z");
    const client = new FakeClient([{ status: "awaiting_pc_approval" }]);
    const { result } = await run({
      client,
      now: () => nowMs,
      // 一次轮询后直接把时钟推到 2030 年之后。
      sleep: async () => {
        nowMs = Date.parse("2031-01-01T00:00:00Z");
      },
    });
    expect(result.status).toBe("expired");
    expect(client.statusCalls).toBe(1);
  });

  it("网络抖动时继续重试，批准后成功", async () => {
    const client = new FakeClient([
      new HubApiError("NETWORK", "offline"),
      {
        status: "approved",
        peer: {
          deviceId: HUB_ID,
          displayName: "My PC",
          deviceType: "windows-hub",
          identityFingerprint: HUB_FP,
        },
      },
    ]);
    const { result, states } = await run({ client });
    expect(result.status).toBe("approved");
    expect(
      states.some(
        (state) => state.phase === "awaiting_pc_approval" && state.warning !== undefined,
      ),
    ).toBe(true);
  });

  it("云端返回与二维码不一致的电脑身份时安全终止", async () => {
    const client = new FakeClient([
      {
        status: "approved",
        peer: {
          deviceId: HUB_ID,
          displayName: "Fake PC",
          deviceType: "windows-hub",
          identityFingerprint: "f".repeat(32),
        },
      },
    ]);
    await expectPairingError(run({ client }), "SERVER_INVALID");
    expect(client.statusCalls).toBe(1);
  });

  it("二维码校验失败时绝不提交配对申请", async () => {
    const client = new FakeClient([{ status: "approved" }]);
    const states: HubPairingState[] = [];
    await expect(
      pairWithHub({
        qrPayload: "not-a-qr",
        identity,
        deviceName: "Test Phone",
        createClient: () => client,
        onState: (state) => states.push(state),
        audit: () => undefined,
      }),
    ).rejects.toBeInstanceOf(HubPairingError);
    expect(client.submitCalls).toBe(0);
    expect(states[states.length - 1]?.phase).toBe("failed");
  });

  it("取消后不再继续轮询", async () => {
    const controller = new AbortController();
    controller.abort();
    const client = new FakeClient([{ status: "awaiting_pc_approval" }]);
    await expectPairingError(run({ client, signal: controller.signal }), "CANCELLED");
    expect(client.submitCalls).toBe(0);
  });

  it("审计只收到事件类型/结果/原因码", async () => {
    const audit = vi.fn();
    const client = new FakeClient([{ status: "rejected" }]);
    await run({ client, audit });
    const serialized = JSON.stringify(audit.mock.calls);
    expect(serialized).not.toContain(INVITATION_SECRET);
    expect(serialized).not.toContain(HUB_FP);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ type: "pairing_status", result: "rejected" }),
    );
  });
});
