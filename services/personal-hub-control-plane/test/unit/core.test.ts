/** 单元与行为测试：覆盖 §11.3 全部类/方法。 */
import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  baseFields,
  createIdentity,
  decideRequestBody,
  makeHarness,
  makeSignal,
  pairingRequestBody,
  registerIdentity,
  resign,
} from '../helpers.js';
import { DeviceRegistry } from '../../src/core/DeviceRegistry.js';
import { RateLimiter } from '../../src/core/RateLimiter.js';
import { testConfig } from '../../src/config.js';
import { sha256Hex } from '../../src/crypto/signatures.js';
import type {
  CreateInvitation,
  PairingDecide,
  PairingRequest,
  PresenceUpdate,
  RevokeDevice,
  SignedSignal,
  TurnCredentialsRequest,
  WssAuth,
} from '../../src/schema/validation.js';

describe('DeviceRegistry', () => {
  it('registerDevice 保存自签名设备公钥与最小元数据', async () => {
    const { deps } = makeHarness();
    const id = createIdentity();
    await registerIdentity(deps, id);
    const device = await deps.devices.getDevice(id.deviceId);
    expect(device).toMatchObject({
      deviceId: id.deviceId,
      identityPublicKey: id.identityPublicKey,
      identityFingerprint: id.identityFingerprint,
      revokedAt: null,
    });
    expect(JSON.stringify(device)).not.toMatch(/private.?key/i);
  });

  it('registerDevice 拒绝伪造签名与错误指纹', async () => {
    const { deps } = makeHarness();
    const id = createIdentity();
    const attacker = createIdentity();
    const body = id.signed({
      deviceId: id.deviceId,
      deviceType: 'windows-hub' as const,
      displayName: 'Hub',
      identityPublicKey: id.identityPublicKey,
      identityFingerprint: id.identityFingerprint,
      ...baseFields(),
    });
    await expect(
      deps.devices.registerDevice({
        ...body,
        signature: attacker.signatureFor(body),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_SIGNATURE' });
    await expect(
      deps.devices.registerDevice({
        ...id.signed({
          ...body,
          identityFingerprint: '0'.repeat(32),
        }),
      }),
    ).rejects.toMatchObject({ code: 'FINGERPRINT_MISMATCH' });
  });

  it('拒绝重复注册，避免公钥被覆盖', async () => {
    const { deps } = makeHarness();
    const id = createIdentity();
    await registerIdentity(deps, id);
    await expect(registerIdentity(deps, id)).rejects.toMatchObject({
      code: 'DEVICE_ALREADY_EXISTS',
    });
  });

  it('getDevice 对未知设备返回 null 且记审计', async () => {
    const { deps, stores } = makeHarness();
    expect(await deps.devices.getDevice(randomUUID())).toBeNull();
    expect((await stores.audit.list()).some((e) => e.resultCode === 'NOT_FOUND')).toBe(true);
  });
});

describe('PairingInvitationStore', () => {
  async function setup() {
    const harness = makeHarness();
    const hub = createIdentity();
    await registerIdentity(harness.deps, hub);
    const created = await harness.deps.pairings.createInvitation(
      hub.signed({ issuerDeviceId: hub.deviceId, ...baseFields() }),
    );
    return { ...harness, hub, created };
  }

  it('createInvitation 只存 secret 哈希，明文一次性返回', async () => {
    const { deps, stores, created } = await setup();
    const stored = await stores.invitations.get(created.invitation.invitationId);
    expect(stored?.invitationSecretHash).toBe(
      sha256Hex(Buffer.from(created.invitationSecret, 'base64')),
    );
    expect(stored?.invitationSecretHash).not.toBe(created.invitationSecret);
    expect(stored?.failedAttempts).toBe(0);
    expect(stored?.status).toBe('pending');
    expect(JSON.stringify(stored)).not.toContain(created.invitationSecret);
    expect(JSON.stringify(deps.devices)).not.toContain(created.invitationSecret);
  });

  it('PC 批准后只授予设备配对能力，绝不授予远控或 grant', async () => {
    const { deps, created, hub } = await setup();
    const phone = createIdentity();
    const submitted = await deps.pairingRequests.submitRequest(
      pairingRequestBody(
        phone,
        created.invitation.invitationId,
        created.invitationSecret,
      ) as PairingRequest,
    );
    const decision = await deps.pairingRequests.decideRequest(
      decideRequestBody(hub, submitted.requestId, true) as PairingDecide,
    );
    expect(decision.status).toBe('approved');
    expect(decision.pairedCapabilities).toEqual([
      'DEVICE_PAIRED',
      'HUB_DISCOVERY',
    ]);
    expect(decision.pairedCapabilities).not.toContain('REMOTE_CONTROL');
    expect(JSON.stringify(decision)).not.toMatch(/grant/i);
    const stored = await deps.stores.invitations.get(
      created.invitation.invitationId,
    );
    expect(stored?.status).toBe('consumed');
  });

  it('邀请一次性：第一个设备的申请批准后，第二个设备无法再用同一邀请', async () => {
    const { deps, created, hub } = await setup();
    const phone = createIdentity();
    const submitted = await deps.pairingRequests.submitRequest(
      pairingRequestBody(
        phone,
        created.invitation.invitationId,
        created.invitationSecret,
      ) as PairingRequest,
    );
    await deps.pairingRequests.decideRequest(
      decideRequestBody(hub, submitted.requestId, true) as PairingDecide,
    );

    const second = createIdentity();
    await expect(
      deps.pairingRequests.submitRequest(
        pairingRequestBody(
          second,
          created.invitation.invitationId,
          created.invitationSecret,
        ) as PairingRequest,
      ),
    ).rejects.toMatchObject({ code: 'INVITATION_NOT_PENDING' });
  });

  it('错误 secret 累计失败次数并在上限后吊销邀请', async () => {
    const { deps, stores, created } = await setup();
    const phone = createIdentity();
    for (let i = 0; i < 5; i += 1) {
      await expect(
        deps.pairingRequests.submitRequest(
          pairingRequestBody(
            phone,
            created.invitation.invitationId,
            randomBytes(16).toString('base64'),
          ) as PairingRequest,
        ),
      ).rejects.toMatchObject({ code: 'INVALID_INVITATION' });
    }
    const stored = await stores.invitations.get(created.invitation.invitationId);
    expect(stored?.failedAttempts).toBe(5);
    expect(stored?.status).toBe('revoked');
  });

  it('过期邀请被拒绝并标记为 expired', async () => {
    const { deps, stores, created } = await setup();
    const invitation = await stores.invitations.get(created.invitation.invitationId);
    if (!invitation) throw new Error('missing invitation');
    invitation.expiresAt = new Date(Date.now() - 1000).toISOString();
    await stores.invitations.update(invitation);
    const phone = createIdentity();
    await expect(
      deps.pairingRequests.submitRequest(
        pairingRequestBody(
          phone,
          invitation.invitationId,
          created.invitationSecret,
        ) as PairingRequest,
      ),
    ).rejects.toMatchObject({ code: 'INVITATION_EXPIRED' });
    expect((await stores.invitations.get(invitation.invitationId))?.status).toBe('expired');
  });

  it('配对尝试触发限流', async () => {
    const harness = makeHarness({ pairingRatePerMinute: 2 });
    const hub = createIdentity();
    await registerIdentity(harness.deps, hub);
    const created = await harness.deps.pairings.createInvitation(
      hub.signed({ issuerDeviceId: hub.deviceId, ...baseFields() }) as CreateInvitation,
    );
    const phone = createIdentity();
    const attempt = () =>
      harness.deps.pairingRequests.submitRequest(
        pairingRequestBody(
          phone,
          created.invitation.invitationId,
          randomBytes(16).toString('base64'),
        ) as PairingRequest,
      );
    await expect(attempt()).rejects.toMatchObject({ code: 'INVALID_INVITATION' });
    await expect(attempt()).rejects.toMatchObject({ code: 'INVALID_INVITATION' });
    await expect(attempt()).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });
});

describe('PresenceManager', () => {
  it('updatePresence / getPresence 验签并返回在线状态', async () => {
    const { deps } = makeHarness();
    const hub = createIdentity();
    await registerIdentity(deps, hub);
    await deps.presence.updatePresence(
      hub.signed({ deviceId: hub.deviceId, status: 'online', ...baseFields() }) as PresenceUpdate,
    );
    const presence = await deps.presence.getPresence(
      hub.signed({ deviceId: hub.deviceId, ...baseFields() }),
    );
    expect(presence).toMatchObject({ deviceId: hub.deviceId, status: 'online' });
  });

  it('拒绝未签名/伪造的在线状态更新', async () => {
    const { deps } = makeHarness();
    const hub = createIdentity();
    await registerIdentity(deps, hub);
    const attacker = createIdentity();
    await expect(
      deps.presence.updatePresence(
        attacker.signed({
          deviceId: hub.deviceId,
          status: 'online',
          ...baseFields(),
        }) as PresenceUpdate,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_SIGNATURE' });
  });
});

describe('RevocationRegistry', () => {
  it('publishRevocation 标记撤销并可同步', async () => {
    const { deps } = makeHarness();
    const hub = createIdentity();
    const phone = createIdentity();
    await registerIdentity(deps, hub);
    await registerIdentity(deps, phone);
    const result = await deps.revocations.publishRevocation(
      phone.signed({ deviceId: phone.deviceId, reason: 'user revoked', ...baseFields() }) as RevokeDevice,
    );
    expect(result.deviceId).toBe(phone.deviceId);
    expect(await deps.revocations.isRevoked(phone.deviceId)).toBe(true);
    expect((await deps.revocations.listRevocations()).map((r) => r.deviceId)).toContain(phone.deviceId);
  });

  it('撤销设备后续签名请求被拒绝', async () => {
    const { deps } = makeHarness();
    const hub = createIdentity();
    await registerIdentity(deps, hub);
    await deps.revocations.publishRevocation(
      hub.signed({ deviceId: hub.deviceId, reason: 'policy', ...baseFields() }) as RevokeDevice,
    );
    await expect(
      deps.devices.verifyRequestSignature(
        hub.deviceId,
        { deviceId: hub.deviceId, ...baseFields() },
        hub.signatureFor({ deviceId: hub.deviceId }),
        new Date().toISOString(),
      ),
    ).rejects.toMatchObject({ code: 'DEVICE_REVOKED' });
  });
});

describe('RateLimiter', () => {
  it('信令速率超限后拒绝并返回重试时间', () => {
    const rl = new RateLimiter(testConfig({ signalingRatePerSecond: 2 }));
    expect(rl.checkSignalingRate('device-a', 1000)).toEqual({
      allowed: true,
      retryAfterSeconds: 0,
    });
    expect(rl.checkSignalingRate('device-a', 1000).allowed).toBe(true);
    const blocked = rl.checkSignalingRate('device-a', 1000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('nonce 单次使用防重放', () => {
    const rl = new RateLimiter(testConfig());
    expect(rl.checkAndConsumeNonce('d', 'n', 1000)).toBe(true);
    expect(rl.checkAndConsumeNonce('d', 'n', 1001)).toBe(false);
  });
});

describe('TurnCredentialIssuer', () => {
  it('issueEphemeralCredentials 签发短时凭证，不泄露服务端共享密钥', async () => {
    const h = makeHarness();
    const hub = createIdentity();
    await registerIdentity(h.deps, hub);
    const credentials = await h.deps.turn.issueEphemeralCredentials(
      hub.signed({ deviceId: hub.deviceId, ...baseFields() }) as TurnCredentialsRequest,
    );
    const [expiry] = credentials.username.split(':');
    expect(Number(expiry) * 1000).toBeGreaterThan(Date.now());
    expect(credentials.ttlSeconds).toBeGreaterThanOrEqual(30);
    expect(credentials.ttlSeconds).toBeLessThanOrEqual(600);
    expect(Buffer.from(credentials.credential, 'base64').length).toBeGreaterThan(0);
    expect(JSON.stringify(credentials)).not.toContain(h.config.turnSecret);
  });

  it('拒绝伪造的 TURN 凭证请求', async () => {
    const { deps } = makeHarness();
    const hub = createIdentity();
    await registerIdentity(deps, hub);
    const attacker = createIdentity();
    await expect(
      deps.turn.issueEphemeralCredentials(
        attacker.signed({ deviceId: hub.deviceId, ...baseFields() }) as TurnCredentialsRequest,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_SIGNATURE' });
  });
});

describe('SignalingGateway', () => {
  async function setup() {
    const h = makeHarness();
    const hub = createIdentity();
    const phone = createIdentity();
    await registerIdentity(h.deps, hub);
    await registerIdentity(h.deps, phone);
    return { ...h, hub, phone };
  }

  it('connectDevice 验签，nonce 重放被拒绝', async () => {
    const { deps, hub } = await setup();
    const auth = hub.signed({ deviceId: hub.deviceId, ...baseFields() }) as WssAuth;
    expect(await deps.signaling.connectDevice(auth)).toEqual({ deviceId: hub.deviceId });
    await expect(deps.signaling.connectDevice(auth)).rejects.toMatchObject({
      code: 'REPLAY_DETECTED',
    });
  });

  it('forwardSignedSignal 原样转发密文与签名，只记最小会话元数据', async () => {
    const { deps, stores, hub, phone } = await setup();
    const signal = makeSignal(hub, phone.deviceId);
    const forwarded = await deps.signaling.forwardSignedSignal(signal as SignedSignal);
    expect(forwarded.ciphertext).toBe(signal.ciphertext);
    expect(forwarded.signature).toBe(signal.signature);
    expect(forwarded.dtlsFingerprint).toBe(signal.dtlsFingerprint);
    const session = await stores.sessions.get(signal.sessionId);
    expect(session).toMatchObject({
      sessionId: signal.sessionId,
      controllerDeviceId: hub.deviceId,
      targetDeviceId: phone.deviceId,
    });
    expect(JSON.stringify(session)).not.toContain(signal.ciphertext);
    expect(JSON.stringify(await stores.audit.list())).not.toContain(signal.ciphertext);
  });

  it('篡改密文（哈希不符）被拒绝', async () => {
    const { deps, hub, phone } = await setup();
    const signal = makeSignal(hub, phone.deviceId);
    const tampered = resign(hub, signal, {
      ciphertext: randomBytes(48).toString('base64'),
    });
    await expect(
      deps.signaling.forwardSignedSignal(tampered as SignedSignal),
    ).rejects.toMatchObject({ code: 'CIPHERTEXT_HASH_MISMATCH' });
  });

  it('篡改签名字段（sessionId/fingerprint）被拒绝', async () => {
    const { deps, hub, phone } = await setup();
    const first = makeSignal(hub, phone.deviceId);
    await expect(
      deps.signaling.forwardSignedSignal({
        ...first,
        sessionId: randomUUID(),
      } as SignedSignal),
    ).rejects.toMatchObject({ code: 'INVALID_SIGNATURE' });
    const second = makeSignal(hub, phone.deviceId);
    await expect(
      deps.signaling.forwardSignedSignal({
        ...second,
        dtlsFingerprint: 'b'.repeat(64),
      } as SignedSignal),
    ).rejects.toMatchObject({ code: 'INVALID_SIGNATURE' });
  });

  it('过期信令与已撤销目标设备被拒绝', async () => {
    const { deps, hub, phone } = await setup();
    const expired = resign(
      hub,
      makeSignal(hub, phone.deviceId, randomBytes(16).toString('base64')),
      { expiresAt: new Date(Date.now() - 1000).toISOString() },
    ) as SignedSignal;
    await expect(deps.signaling.forwardSignedSignal(expired)).rejects.toMatchObject({
      code: 'SIGNAL_EXPIRED',
    });
    await deps.revocations.publishRevocation(
      phone.signed({ deviceId: phone.deviceId, reason: 'policy', ...baseFields() }),
    );
    await expect(
      deps.signaling.forwardSignedSignal(makeSignal(hub, phone.deviceId) as SignedSignal),
    ).rejects.toMatchObject({ code: 'DEVICE_REVOKED' });
  });
});
