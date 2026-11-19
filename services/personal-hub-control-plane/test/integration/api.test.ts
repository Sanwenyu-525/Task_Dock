/** 集成测试：HTTP 接口（app.inject）与 WSS 信令（mock socket）。 */
import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  baseFields,
  createIdentity,
  decideRequestBody,
  makeHarness,
  makeMockSocket,
  makeSignal,
  pairingRequestBody,
  registerIdentity,
} from '../helpers.js';
import { handleSignalingSocket } from '../../src/routes/websocket.js';
import type { DeviceRegistration } from '../../src/schema/validation.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('HTTP API（注入）', () => {
  it('GET /v1/health 返回 200', async () => {
    const { app } = makeHarness();
    const res = await app.inject({ method: 'GET', url: '/v1/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ok');
  });

  it('注册 → 签发 TURN 凭证 → 更新在线状态，全链路通过', async () => {
    const { app } = makeHarness();
    const hub = createIdentity();
    const register = await app.inject({
      method: 'POST',
      url: '/v1/devices/register',
      payload: hub.signed({
        deviceId: hub.deviceId,
        deviceType: 'windows-hub',
        displayName: 'Hub',
        identityPublicKey: hub.identityPublicKey,
        identityFingerprint: hub.identityFingerprint,
        ...baseFields(),
      }),
    });
    expect(register.statusCode).toBe(201);

    const turn = await app.inject({
      method: 'POST',
      url: '/v1/turn/credentials',
      payload: hub.signed({ deviceId: hub.deviceId, ...baseFields() }),
    });
    expect(turn.statusCode).toBe(200);
    expect(turn.json().credentials.username).toContain(hub.deviceId);

    const presence = await app.inject({
      method: 'POST',
      url: '/v1/presence/update',
      payload: hub.signed({
        deviceId: hub.deviceId,
        status: 'online',
        ...baseFields(),
      }),
    });
    expect(presence.statusCode).toBe(200);
    expect(presence.json().presence.status).toBe('online');
  });

  it('配对全链路（创建邀请 → 提交申请 → PC 批准）经 HTTP 成功', async () => {
    const { app } = makeHarness();
    const hub = createIdentity();
    await app.inject({
      method: 'POST',
      url: '/v1/devices/register',
      payload: hub.signed({
        deviceId: hub.deviceId,
        deviceType: 'windows-hub',
        displayName: 'Hub',
        identityPublicKey: hub.identityPublicKey,
        identityFingerprint: hub.identityFingerprint,
        ...baseFields(),
      }),
    });
    const created = await app.inject({
      method: 'POST',
      url: '/v1/invitations/create',
      payload: hub.signed({ issuerDeviceId: hub.deviceId, ...baseFields() }),
    });
    expect(created.statusCode).toBe(201);
    const { invitationSecret, invitation } = created.json();

    const phone = createIdentity();
    const submitted = await app.inject({
      method: 'POST',
      url: '/v1/pairing/request',
      payload: pairingRequestBody(
        phone,
        invitation.invitationId,
        invitationSecret,
      ),
    });
    expect(submitted.statusCode).toBe(201);
    expect(submitted.json().status).toBe('awaiting_pc_approval');

    const decided = await app.inject({
      method: 'POST',
      url: '/v1/pairing/decide',
      payload: decideRequestBody(hub, submitted.json().requestId, true),
    });
    expect(decided.statusCode).toBe(200);
    expect(decided.json().pairedCapabilities).toEqual([
      'DEVICE_PAIRED',
      'HUB_DISCOVERY',
    ]);
  });

  it('旧 /v1/invitations/consume 公开路由已下线（410），无法绕过 PC 批准', async () => {
    const { app, deps } = makeHarness();
    const hub = createIdentity();
    await registerIdentity(deps, hub);
    const phone = createIdentity();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/invitations/consume',
      payload: phone.signed({
        invitationId: randomUUID(),
        invitationSecret: randomBytes(16).toString('base64'),
        deviceId: phone.deviceId,
        deviceType: 'android',
        displayName: 'Phone',
        identityPublicKey: phone.identityPublicKey,
        identityFingerprint: phone.identityFingerprint,
        ...baseFields(),
      }),
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.json().ok).toBe(false);
  });

  it('schema 拒绝含 privateKey 的越界字段（400 INVALID_SCHEMA）', async () => {
    const { app } = makeHarness();
    const hub = createIdentity();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/devices/register',
      payload: {
        ...hub.signed({
          deviceId: hub.deviceId,
          deviceType: 'windows-hub',
          displayName: 'Hub',
          identityPublicKey: hub.identityPublicKey,
          identityFingerprint: hub.identityFingerprint,
          ...baseFields(),
        }),
        privateKey: 'must-be-rejected',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_SCHEMA');
  });
});

describe('WSS 信令（mock socket）', () => {
  it('未认证先发信令被拒，auth 后签名密文被原样转发', async () => {
    const harness = makeHarness();
    const hub = createIdentity();
    const phone = createIdentity();
    await registerIdentity(harness.deps, hub);
    await registerIdentity(harness.deps, phone);

    const mock = makeMockSocket();
    handleSignalingSocket(mock.socket, harness.deps);

    const signal = makeSignal(hub, phone.deviceId);
    mock.emitMessage({ id: '1', type: 'signal.forward', payload: signal });
    await tick();
    expect(mock.responses[0]).toMatchObject({
      id: '1',
      ok: false,
      error: { code: 'AUTH_REQUIRED' },
    });

    mock.emitMessage({
      id: '2',
      type: 'auth',
      payload: hub.signed({ deviceId: hub.deviceId, ...baseFields() }),
    });
    await tick();
    expect(mock.responses[1]).toMatchObject({ id: '2', ok: true });

    mock.emitMessage({ id: '3', type: 'signal.forward', payload: signal });
    await tick();
    expect(mock.responses[2]).toMatchObject({ id: '3', ok: true });
    const forwarded = mock.responses[2]?.data as { ciphertext?: string };
    expect(forwarded.ciphertext).toBe(signal.ciphertext);

    mock.socket.close();
  });

  it('注册的 DeviceRegistration 类型不含私钥字段', () => {
    const hub = createIdentity();
    const payload = hub.signed({
      deviceId: hub.deviceId,
      deviceType: 'windows-hub' as const,
      displayName: 'Hub',
      identityPublicKey: hub.identityPublicKey,
      identityFingerprint: hub.identityFingerprint,
      ...baseFields(),
    }) as DeviceRegistration;
    expect('privateKey' in payload).toBe(false);
  });
});
