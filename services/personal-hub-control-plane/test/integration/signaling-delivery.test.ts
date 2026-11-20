import { describe, expect, it, vi } from 'vitest';
import {
  baseFields, createIdentity, makeHarness, makeMockSocket, makeSignal,
  registerIdentity,
} from '../helpers.js';
import { handleSignalingSocket } from '../../src/routes/websocket.js';

async function setup() {
  const h = makeHarness();
  const hub = createIdentity();
  const phone = createIdentity();
  await registerIdentity(h.deps, hub);
  await registerIdentity(h.deps, phone);
  async function connect(identity = hub, deps = h.deps) {
    const mock = makeMockSocket();
    handleSignalingSocket(mock.socket, deps);
    mock.emitMessage({
      id: 'auth', type: 'auth',
      payload: identity.signed({ deviceId: identity.deviceId, ...baseFields() }),
    });
    await vi.waitFor(() => expect(mock.responses).toContainEqual(
      expect.objectContaining({ id: 'auth', ok: true }),
    ));
    return mock;
  }
  return { ...h, hub, phone, connect };
}

describe('WSS 双连接投递与生命周期', () => {
  it('经 Fastify WebSocket 升级入口将消息投递至第二个客户端', async () => {
    const h = await setup();
    await h.app.ready();
    const sender = await h.app.injectWS('/v1/signaling');
    const target = await h.app.injectWS('/v1/signaling');
    const senderMessages: unknown[] = [];
    const targetMessages: unknown[] = [];
    sender.on('message', (data: Buffer) => senderMessages.push(JSON.parse(data.toString())));
    target.on('message', (data: Buffer) => targetMessages.push(JSON.parse(data.toString())));
    try {
      sender.send(JSON.stringify({ id: 'auth', type: 'auth', payload: h.hub.signed({ deviceId: h.hub.deviceId, ...baseFields() }) }));
      target.send(JSON.stringify({ id: 'auth', type: 'auth', payload: h.phone.signed({ deviceId: h.phone.deviceId, ...baseFields() }) }));
      await vi.waitFor(() => {
        expect(senderMessages).toContainEqual({ id: 'auth', ok: true, data: { deviceId: h.hub.deviceId } });
        expect(targetMessages).toContainEqual({ id: 'auth', ok: true, data: { deviceId: h.phone.deviceId } });
      });
      const signal = makeSignal(h.hub, h.phone.deviceId);
      sender.send(JSON.stringify({ id: 'send', type: 'signal.forward', payload: signal }));
      await vi.waitFor(() => expect(targetMessages).toContainEqual({ type: 'signal.deliver', payload: signal }));
    } finally {
      sender.terminate();
      target.terminate();
      await h.app.close();
    }
  });

  it('认证等待期间关闭不会注册已关闭连接，并发认证不能切换身份', async () => {
    const h = await setup();
    let finish!: (result: { deviceId: string }) => void;
    const pending = new Promise<{ deviceId: string }>((resolve) => { finish = resolve; });
    vi.spyOn(h.deps.signaling, 'connectDevice').mockReturnValueOnce(pending);
    const mock = makeMockSocket();
    handleSignalingSocket(mock.socket, h.deps);
    const auth = (identity: typeof h.hub, id: string) => mock.emitMessage({
      id, type: 'auth', payload: identity.signed({ deviceId: identity.deviceId, ...baseFields() }),
    });
    auth(h.hub, 'first');
    auth(h.phone, 'second');
    await vi.waitFor(() => expect(mock.responses).toContainEqual({
      id: 'second', ok: false, error: { code: 'AUTH_IN_PROGRESS', message: 'AUTH_IN_PROGRESS' },
    }));
    mock.socket.close();
    finish({ deviceId: h.hub.deviceId });
    await pending;
    expect(await h.stores.presence.get(h.hub.deviceId)).toBeNull();
    expect(mock.responses).toHaveLength(1);
  });

  it('将签名信令投递至目标连接，保持密文与签名，其他服务实例不接收', async () => {
    const h = await setup();
    const sender = await h.connect();
    const target = await h.connect(h.phone);
    const other = makeHarness();
    await registerIdentity(other.deps, h.phone);
    const isolated = await h.connect(h.phone, other.deps);
    const signal = makeSignal(h.hub, h.phone.deviceId);
    sender.emitMessage({ id: 'send', type: 'signal.forward', payload: signal });
    await vi.waitFor(() => expect(target.responses).toContainEqual({
      type: 'signal.deliver', payload: signal,
    }));
    expect(isolated.responses).toHaveLength(1);
    sender.socket.close();
    target.socket.close();
    isolated.socket.close();
  });

  it('同设备关闭一个连接仍在线，最后一个连接关闭后离线且不再接收', async () => {
    const h = await setup();
    const sender = await h.connect();
    const first = await h.connect(h.phone);
    const second = await h.connect(h.phone);
    first.socket.close();
    const signal = makeSignal(h.hub, h.phone.deviceId);
    sender.emitMessage({ id: 'send', type: 'signal.forward', payload: signal });
    await vi.waitFor(() => expect(second.responses).toHaveLength(2));
    expect(first.responses).toHaveLength(1);
    expect(await h.stores.presence.get(h.phone.deviceId)).toMatchObject({ status: 'online' });
    second.socket.close();
    await vi.waitFor(async () => expect(await h.stores.presence.get(h.phone.deviceId))
      .toMatchObject({ status: 'offline' }));
    sender.socket.close();
  });

  it('撤销事件可从发布连接投递至同服务其他设备', async () => {
    const h = await setup();
    const sender = await h.connect();
    const target = await h.connect(h.phone);
    sender.emitMessage({
      id: 'revoke', type: 'revocation.publish',
      payload: h.hub.signed({ deviceId: h.hub.deviceId, reason: 'user', ...baseFields() }),
    });
    await vi.waitFor(() => expect(target.responses).toContainEqual({
      type: 'revocation.published',
      payload: { deviceId: h.hub.deviceId, revokedAt: expect.any(String) },
    }));
    sender.socket.close();
    target.socket.close();
  });

  it('拒绝已认证连接转发其他身份签名的信令及状态请求', async () => {
    const h = await setup();
    const sender = await h.connect();
    const signal = makeSignal(h.phone, h.hub.deviceId);
    const payloads = [
      ['signal.forward', signal],
      ['presence.update', h.phone.signed({ deviceId: h.phone.deviceId, status: 'online', ...baseFields() })],
      ['presence.get', h.phone.signed({ deviceId: h.phone.deviceId, ...baseFields() })],
      ['revocations.list', h.phone.signed({ deviceId: h.phone.deviceId, ...baseFields() })],
      ['revocation.publish', h.phone.signed({ deviceId: h.phone.deviceId, reason: 'user', ...baseFields() })],
    ] as const;
    for (const [type, payload] of payloads) {
      sender.emitMessage({ id: type, type, payload });
      await vi.waitFor(() => expect(sender.responses).toContainEqual({
        id: type, ok: false,
        error: { code: 'IDENTITY_MISMATCH', message: 'IDENTITY_MISMATCH' },
      }));
    }
    expect(await h.stores.sessions.get(signal.sessionId)).toBeNull();
    expect(await h.deps.devices.requireActiveDevice(h.phone.deviceId)).toBeDefined();
    sender.socket.close();
  });

  it('并发请求失败回执保留各自的 id', async () => {
    const h = await setup();
    const sender = await h.connect();
    let rejectFirst!: (reason: Error) => void;
    const pending = new Promise<never>((_resolve, reject) => { rejectFirst = reject; });
    vi.spyOn(h.deps.presence, 'getPresence').mockReturnValueOnce(pending);
    sender.emitMessage({ id: 'first', type: 'presence.get', payload: h.hub.signed({ deviceId: h.hub.deviceId, ...baseFields() }) });
    sender.emitMessage({ id: 'second', type: 'unknown' });
    rejectFirst(new Error('test-only'));
    await vi.waitFor(() => expect(sender.responses).toContainEqual({
      id: 'first', ok: false,
      error: { code: 'INTERNAL_ERROR', message: 'INTERNAL_ERROR' },
    }));
    expect(sender.responses).toContainEqual({ id: 'second', ok: false, error: { code: 'UNKNOWN_OP' } });
    sender.socket.close();
  });
});
