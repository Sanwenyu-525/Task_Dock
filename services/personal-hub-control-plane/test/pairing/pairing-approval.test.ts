/**
 * P3 配对批准状态机攻击面测试（契约 §3.2 / §7 DoD）。
 *
 * 核心不变量：**未获 PC 本机批准不得创建设备**。
 * 覆盖：正常批准、未批准不建设备、拒绝、过期、暴力猜 secret、重复消费、
 * 越权批准、越权查询、nonce 重放、签名篡改、公开旧路由下线、响应无 grant/能力越界。
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  baseFields,
  createIdentity,
  decideRequestBody,
  listRequestsBody,
  makeHarness,
  pairingRequestBody,
  pairingStatusBody,
  registerIdentity,
  resign,
  type TestIdentity,
} from '../helpers.js';
import type { CreateInvitation } from '../../src/schema/validation.js';

type Harness = ReturnType<typeof makeHarness>;

async function setup(
  configOverrides: Parameters<typeof makeHarness>[0] = {},
): Promise<Harness & { hub: TestIdentity; invitationId: string; invitationSecret: string }> {
  const harness = makeHarness(configOverrides);
  const hub = createIdentity();
  await registerIdentity(harness.deps, hub);
  const created = await harness.deps.pairings.createInvitation(
    hub.signed({
      issuerDeviceId: hub.deviceId,
      ...baseFields(),
    }) as CreateInvitation,
  );
  return {
    ...harness,
    hub,
    invitationId: created.invitation.invitationId,
    invitationSecret: created.invitationSecret,
  };
}

async function submit(
  harness: Harness,
  phone: TestIdentity,
  invitationId: string,
  invitationSecret: string,
  overrides: Record<string, unknown> = {},
) {
  return harness.app.inject({
    method: 'POST',
    url: '/v1/pairing/request',
    payload: pairingRequestBody(
      phone,
      invitationId,
      invitationSecret,
      overrides,
    ),
  });
}

async function decide(
  harness: Harness,
  issuer: TestIdentity,
  requestId: string,
  approved: boolean,
) {
  return harness.app.inject({
    method: 'POST',
    url: '/v1/pairing/decide',
    payload: decideRequestBody(issuer, requestId, approved),
  });
}

const collectKeys = (value: unknown): string[] => {
  if (value === null || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(collectKeys);
  return Object.entries(value as Record<string, unknown>).flatMap(([key, v]) => [
    key,
    ...collectKeys(v),
  ]);
};

describe('配对批准：正常流程', () => {
  it('1) submit → PC 看到 pending → 批准 → 设备创建，能力恰为 DEVICE_PAIRED/HUB_DISCOVERY', async () => {
    const h = await setup();
    const phone = createIdentity();

    const submitted = await submit(h, phone, h.invitationId, h.invitationSecret);
    expect(submitted.statusCode).toBe(201);
    const body = submitted.json();
    expect(body).toMatchObject({
      ok: true,
      status: 'awaiting_pc_approval',
    });
    expect(typeof body.requestId).toBe('string');
    expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now());

    // 申请阶段：邀请仍未消费、设备尚不存在。
    expect((await h.stores.invitations.get(h.invitationId))?.status).toBe('pending');
    expect(await h.deps.devices.getDevice(phone.deviceId)).toBeNull();

    // PC 拉取待批准列表：字段齐备，且不含任何能力/grant 字段。
    const listed = await h.app.inject({
      method: 'POST',
      url: '/v1/pairing/requests/list',
      payload: listRequestsBody(h.hub),
    });
    expect(listed.statusCode).toBe(200);
    const pendingRequests = listed.json().requests as Array<Record<string, unknown>>;
    expect(pendingRequests).toHaveLength(1);
    expect(pendingRequests[0]).toMatchObject({
      requestId: body.requestId,
      deviceId: phone.deviceId,
      deviceType: 'android',
      displayName: 'Pixel 8',
      identityFingerprint: phone.identityFingerprint,
      identityPublicKey: phone.identityPublicKey,
    });
    expect(
      collectKeys(pendingRequests).filter((key) =>
        /grant|private|capabilit/i.test(key),
      ),
    ).toEqual([]);

    const approved = await decide(h, h.hub, body.requestId, true);
    expect(approved.statusCode).toBe(200);
    const decision = approved.json();
    expect(decision.status).toBe('approved');
    expect(decision.device).toMatchObject({
      deviceId: phone.deviceId,
      identityPublicKey: phone.identityPublicKey,
    });
    expect(decision.pairedCapabilities).toEqual([
      'DEVICE_PAIRED',
      'HUB_DISCOVERY',
    ]);

    // 设备已创建、邀请已消费、申请已批准。
    const device = await h.deps.devices.getDevice(phone.deviceId);
    expect(device).not.toBeNull();
    expect((await h.stores.invitations.get(h.invitationId))?.status).toBe('consumed');
    const stored = await h.stores.pairingRequests.get(body.requestId);
    expect(stored).toMatchObject({
      status: 'approved',
      decidedBy: h.hub.deviceId,
    });

    // Android 轮询：approved + peer 指纹（供人工比对）。
    const polled = await h.app.inject({
      method: 'POST',
      url: '/v1/pairing/status',
      payload: pairingStatusBody(phone, body.requestId),
    });
    expect(polled.statusCode).toBe(200);
    expect(polled.json()).toMatchObject({
      ok: true,
      status: 'approved',
      peer: {
        deviceId: h.hub.deviceId,
        deviceType: 'windows-hub',
        identityFingerprint: h.hub.identityFingerprint,
      },
    });
  });

  it('9b) 同设备同邀请重复提交（新 nonce）幂等返回原 requestId', async () => {
    const h = await setup();
    const phone = createIdentity();
    const first = await submit(h, phone, h.invitationId, h.invitationSecret);
    const second = await submit(h, phone, h.invitationId, h.invitationSecret);
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.json().requestId).toBe(first.json().requestId);
    expect(await h.stores.pairingRequests.listAwaiting()).toHaveLength(1);
  });
});

describe('配对批准：未批准不得创建设备', () => {
  it('2) request 后设备目录中不存在该设备，也未授予任何能力', async () => {
    const h = await setup();
    const phone = createIdentity();
    const submitted = await submit(h, phone, h.invitationId, h.invitationSecret);
    expect(submitted.statusCode).toBe(201);

    expect(await h.deps.devices.getDevice(phone.deviceId)).toBeNull();
    const devices = await h.stores.devices.list();
    expect(devices.map((d) => d.deviceId)).toEqual([h.hub.deviceId]);

    // 未批准时状态仍为 awaiting_pc_approval，且不返回 peer（PC 指纹）。
    const polled = await h.app.inject({
      method: 'POST',
      url: '/v1/pairing/status',
      payload: pairingStatusBody(phone, submitted.json().requestId),
    });
    expect(polled.statusCode).toBe(200);
    expect(polled.json()).toEqual({
      ok: true,
      status: 'awaiting_pc_approval',
    });

    // 未知 requestId 不泄露任何信息。
    const unknown = await h.app.inject({
      method: 'POST',
      url: '/v1/pairing/status',
      payload: pairingStatusBody(phone, randomUUID()),
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe('REQUEST_NOT_FOUND');
  });
});

describe('配对批准：拒绝', () => {
  it('3) PC 拒绝 → request rejected + 邀请 revoked + 设备不存在', async () => {
    const h = await setup();
    const phone = createIdentity();
    const submitted = await submit(h, phone, h.invitationId, h.invitationSecret);

    const rejected = await decide(h, h.hub, submitted.json().requestId, false);
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json()).toEqual({ ok: true, status: 'rejected' });
    expect('device' in rejected.json()).toBe(false);
    expect('pairedCapabilities' in rejected.json()).toBe(false);

    const stored = await h.stores.pairingRequests.get(submitted.json().requestId);
    expect(stored?.status).toBe('rejected');
    expect((await h.stores.invitations.get(h.invitationId))?.status).toBe('revoked');
    expect(await h.deps.devices.getDevice(phone.deviceId)).toBeNull();

    // 手机侧看到 rejected，且不返回 peer。
    const polled = await h.app.inject({
      method: 'POST',
      url: '/v1/pairing/status',
      payload: pairingStatusBody(phone, submitted.json().requestId),
    });
    expect(polled.json()).toEqual({ ok: true, status: 'rejected' });

    // 邀请已吊销：其他设备无法再用。
    const other = createIdentity();
    const again = await submit(h, other, h.invitationId, h.invitationSecret);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('INVITATION_NOT_PENDING');
  });
});

describe('配对批准：邀请失效', () => {
  it('4) 邀请过期 → submit 返回 INVITATION_EXPIRED(410)，并标记 expired', async () => {
    const h = await setup();
    const invitation = await h.stores.invitations.get(h.invitationId);
    if (!invitation) throw new Error('missing invitation');
    invitation.expiresAt = new Date(Date.now() - 1000).toISOString();
    await h.stores.invitations.update(invitation);

    const phone = createIdentity();
    const res = await submit(h, phone, h.invitationId, h.invitationSecret);
    expect(res.statusCode).toBe(410);
    expect(res.json().error.code).toBe('INVITATION_EXPIRED');
    expect((await h.stores.invitations.get(h.invitationId))?.status).toBe('expired');
    expect(await h.deps.devices.getDevice(phone.deviceId)).toBeNull();
  });

  it('5) 错误 secret 5 次 → 邀请 revoked；第 6 次即使 secret 正确也失败', async () => {
    const h = await setup();
    const phone = createIdentity();
    for (let i = 0; i < 5; i += 1) {
      const res = await submit(
        h,
        phone,
        h.invitationId,
        randomBytes(16).toString('base64'),
      );
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('INVALID_INVITATION');
    }
    const stored = await h.stores.invitations.get(h.invitationId);
    expect(stored?.failedAttempts).toBe(5);
    expect(stored?.status).toBe('revoked');

    const sixth = await submit(h, phone, h.invitationId, h.invitationSecret);
    expect(sixth.statusCode).toBe(409);
    expect(sixth.json().error.code).toBe('INVITATION_NOT_PENDING');
    expect(await h.deps.devices.getDevice(phone.deviceId)).toBeNull();
  });

  it('6) 同一邀请不能被第二个设备重复消费', async () => {
    const h = await setup();
    const first = createIdentity();
    const submitted = await submit(h, first, h.invitationId, h.invitationSecret);
    expect((await decide(h, h.hub, submitted.json().requestId, true)).statusCode).toBe(200);

    const second = createIdentity();
    const res = await submit(h, second, h.invitationId, h.invitationSecret);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('INVITATION_NOT_PENDING');
    expect(await h.deps.devices.getDevice(second.deviceId)).toBeNull();
  });
});

describe('配对批准：越权', () => {
  it('7) 设备 B 批准发给 A 的请求 → IDENTITY_MISMATCH(401)', async () => {
    const h = await setup();
    const phone = createIdentity();
    const submitted = await submit(h, phone, h.invitationId, h.invitationSecret);

    // B 是另一台已注册 Hub（签名合法），但不是该邀请的 issuer。
    const otherHub = createIdentity();
    await registerIdentity(h.deps, otherHub);

    const res = await decide(h, otherHub, submitted.json().requestId, true);
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('IDENTITY_MISMATCH');

    expect((await h.stores.invitations.get(h.invitationId))?.status).toBe('pending');
    expect(await h.deps.devices.getDevice(phone.deviceId)).toBeNull();
  });

  it('8) 设备 B 看不到不属于自己的 pending 请求，也不能查询其状态', async () => {
    const h = await setup();
    const phone = createIdentity();
    const submitted = await submit(h, phone, h.invitationId, h.invitationSecret);

    const otherHub = createIdentity();
    await registerIdentity(h.deps, otherHub);

    const listed = await h.app.inject({
      method: 'POST',
      url: '/v1/pairing/requests/list',
      payload: listRequestsBody(otherHub),
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().requests).toEqual([]);

    // 未注册的第三台设备尝试轮询 → 不是该申请的设备，fail-closed。
    const stranger = createIdentity();
    const strangerPoll = await h.app.inject({
      method: 'POST',
      url: '/v1/pairing/status',
      payload: pairingStatusBody(stranger, submitted.json().requestId),
    });
    expect(strangerPoll.statusCode).toBe(401);
    expect(strangerPoll.json().error.code).toBe('IDENTITY_MISMATCH');

    // 已注册的 B 用自己身份轮询 A 的申请 → IDENTITY_MISMATCH。
    const crossPoll = await h.app.inject({
      method: 'POST',
      url: '/v1/pairing/status',
      payload: pairingStatusBody(otherHub, submitted.json().requestId),
    });
    expect(crossPoll.statusCode).toBe(401);
    expect(crossPoll.json().error.code).toBe('IDENTITY_MISMATCH');
  });
});

describe('配对批准：重放与篡改', () => {
  it('9) 同一 nonce 重复提交 → REPLAY_DETECTED(409)', async () => {
    const h = await setup();
    const phone = createIdentity();
    const payload = pairingRequestBody(phone, h.invitationId, h.invitationSecret);
    const first = await h.app.inject({
      method: 'POST',
      url: '/v1/pairing/request',
      payload,
    });
    expect(first.statusCode).toBe(201);

    const replay = await h.app.inject({
      method: 'POST',
      url: '/v1/pairing/request',
      payload,
    });
    expect(replay.statusCode).toBe(409);
    expect(replay.json().error.code).toBe('REPLAY_DETECTED');
    expect(await h.stores.pairingRequests.listAwaiting()).toHaveLength(1);
  });

  it('10) 篡改签名 / 篡改字段 → INVALID_SIGNATURE(401)', async () => {
    const h = await setup();
    const phone = createIdentity();
    const attacker = createIdentity();

    const signed = pairingRequestBody(phone, h.invitationId, h.invitationSecret);
    // 用攻击者私钥签名，但声称是 phone 的公钥。
    const forged = await h.app.inject({
      method: 'POST',
      url: '/v1/pairing/request',
      payload: { ...signed, signature: attacker.signatureFor(signed) },
    });
    expect(forged.statusCode).toBe(401);
    expect(forged.json().error.code).toBe('INVALID_SIGNATURE');

    // 签名后改动 displayName（签名未更新）。
    const tampered = await h.app.inject({
      method: 'POST',
      url: '/v1/pairing/request',
      payload: { ...signed, displayName: 'Evil Phone' },
    });
    expect(tampered.statusCode).toBe(401);
    expect(tampered.json().error.code).toBe('INVALID_SIGNATURE');
    expect(await h.stores.pairingRequests.listAwaiting()).toHaveLength(0);
  });

  it('10b) 指纹与公钥不一致 → FINGERPRINT_MISMATCH(401)', async () => {
    const h = await setup();
    const phone = createIdentity();
    const res = await submit(h, phone, h.invitationId, h.invitationSecret, {
      identityFingerprint: '0'.repeat(32),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('FINGERPRINT_MISMATCH');
  });

  it('10c) 拒绝越界字段（grant/privateKey/capabilities）→ INVALID_SCHEMA(400)', async () => {
    const h = await setup();
    const phone = createIdentity();
    for (const extra of [
      { grant: 'x' },
      { privateKey: 'x' },
      { pairedCapabilities: ['REMOTE_CONTROL'] },
    ]) {
      const res = await submit(h, phone, h.invitationId, h.invitationSecret, extra);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('INVALID_SCHEMA');
    }
  });
});

describe('配对批准：公开路由下线与响应边界', () => {
  it('11) /v1/invitations/consume 已无法绕过 PC 批准（非 2xx）', async () => {
    const h = await setup();
    const phone = createIdentity();
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/invitations/consume',
      payload: pairingRequestBody(phone, h.invitationId, h.invitationSecret),
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.json().ok).toBe(false);
    // 关键：邀请未被消费、设备未被创建。
    expect((await h.stores.invitations.get(h.invitationId))?.status).toBe('pending');
    expect(await h.deps.devices.getDevice(phone.deviceId)).toBeNull();
  });

  it('12) request 响应不含 grant / 私钥 / 能力字段', async () => {
    const h = await setup();
    const phone = createIdentity();
    const res = await submit(h, phone, h.invitationId, h.invitationSecret);
    expect(res.statusCode).toBe(201);
    const body = res.json();

    expect(Object.keys(body).sort()).toEqual([
      'expiresAt',
      'ok',
      'requestId',
      'status',
    ]);
    expect(
      collectKeys(body).filter((key) =>
        /grant|private|secret|capabilit|scope/i.test(key),
      ),
    ).toEqual([]);
    const json = JSON.stringify(body);
    for (const forbidden of ['REMOTE_CONTROL', 'DEVICE_PAIRED', 'HUB_DISCOVERY']) {
      expect(json).not.toContain(forbidden);
    }
    // 邀请 secret 明文绝不回显。
    expect(json).not.toContain(h.invitationSecret);
  });

  it('12b) decide/status 的拒绝路径同样不返回能力或设备', async () => {
    const h = await setup();
    const phone = createIdentity();
    const submitted = await submit(h, phone, h.invitationId, h.invitationSecret);
    const rejected = await decide(h, h.hub, submitted.json().requestId, false);
    expect(collectKeys(rejected.json()).filter((k) => /grant|capabilit/i.test(k))).toEqual([]);

    const polled = await h.app.inject({
      method: 'POST',
      url: '/v1/pairing/status',
      payload: pairingStatusBody(phone, submitted.json().requestId),
    });
    expect(collectKeys(polled.json()).filter((k) => /grant|capabilit|peer/i.test(k))).toEqual([]);
  });
});

describe('配对批准：惰性过期', () => {
  it('13) expireStaleRequests 把超时申请与邀请一并置为 expired', async () => {
    const h = await setup();
    const phone = createIdentity();
    const submitted = await submit(h, phone, h.invitationId, h.invitationSecret);
    expect(submitted.statusCode).toBe(201);

    const invitation = await h.stores.invitations.get(h.invitationId);
    if (!invitation) throw new Error('missing invitation');
    invitation.expiresAt = new Date(Date.now() - 1000).toISOString();
    await h.stores.invitations.update(invitation);

    const expired = await h.deps.pairingRequests.expireStaleRequests();
    expect(expired).toBe(1);
    expect(
      (await h.stores.pairingRequests.get(submitted.json().requestId))?.status,
    ).toBe('expired');
    expect((await h.stores.invitations.get(h.invitationId))?.status).toBe('expired');

    // 过期后 PC 也无法再批准。
    const late = await decide(h, h.hub, submitted.json().requestId, true);
    expect(late.statusCode).toBe(409);
    expect(await h.deps.devices.getDevice(phone.deviceId)).toBeNull();
  });
});
