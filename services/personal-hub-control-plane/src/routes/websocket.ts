/**
 * WSS 信令路由。
 * 帧格式：{ id?, type, payload? }；响应：{ id?, ok, data? | error? }。
 * 首帧必须 type="auth"（签名绑定设备身份）；之后只接受具名 type 且 payload 过 zod。
 * 信令密文为不透明 base64，服务端不解析 SDP/ICE、不解密、不落库正文。
 */
import { ZodError } from 'zod';
import {
  PresenceQuerySchema,
  PresenceUpdateSchema,
  RevocationListSchema,
  RevokeDeviceSchema,
  SignedSignalSchema,
  WssAuthSchema,
  type SignedSignal,
} from '../schema/validation.js';
import type { AppDeps } from '../app.js';
import { toApiError } from './errors.js';
import { SecurityError } from '../core/errors.js';

interface WsLike {
  send(data: string): void;
  on(event: string, listener: (...args: any[]) => void): void;
}

interface WsFrame {
  id?: string;
  type?: string;
  payload?: unknown;
}

// 每个服务依赖实例共享连接表；WeakMap 不把已释放的服务实例永久留在进程中。
const serviceConnections = new WeakMap<AppDeps, Map<string, Set<WsLike>>>();

/** 处理一个已建立的 WSS 连接：先认证，再按 type 分派签名帧。 */
export function handleSignalingSocket(socket: unknown, deps: AppDeps): void {
  const ws = socket as unknown as WsLike;
  let connections = serviceConnections.get(deps);
  if (!connections) {
    connections = new Map<string, Set<WsLike>>();
    serviceConnections.set(deps, connections);
  }
  const activeConnections = connections;
  let authenticatedDeviceId: string | null = null;
  let authenticating = false;
  let closed = false;

  const addConnection = (deviceId: string, s: WsLike) => {
    const set = activeConnections.get(deviceId) ?? new Set<WsLike>();
    set.add(s);
    activeConnections.set(deviceId, set);
  };
  const removeConnection = (deviceId: string, s: WsLike) => {
    const set = activeConnections.get(deviceId);
    if (!set) return;
    set.delete(s);
    if (set.size === 0) activeConnections.delete(deviceId);
  };
  const broadcast = (message: string) => {
    for (const set of activeConnections.values()) {
      for (const target of set) target.send(message);
    }
  };
  const reply = (
    id: string | undefined,
    ok: boolean,
    extra: Record<string, unknown> = {},
  ) => {
    if (closed) return;
    ws.send(
      JSON.stringify({
        ...(id !== undefined ? { id } : {}),
        ok,
        ...extra,
      }),
    );
  };
  const sendError = (id: string | undefined, err: unknown) => {
    const apiError = toApiError(err);
    reply(id, false, {
      error: { code: apiError.code, message: apiError.message },
    });
  };

  const requireConnectionIdentity = (deviceId: string) => {
    if (deviceId !== authenticatedDeviceId) throw new SecurityError('IDENTITY_MISMATCH');
  };
  const handleFrame = async (frame: WsFrame): Promise<void> => {
    if (closed) return;
    const { id, type } = frame;

    // 未认证：只允许 auth。
    if (authenticatedDeviceId === null) {
      if (type !== 'auth') {
        reply(id, false, { error: { code: 'AUTH_REQUIRED' } });
        return;
      }
      const auth = WssAuthSchema.parse(frame.payload);
      if (authenticating) throw new SecurityError('AUTH_IN_PROGRESS');
      authenticating = true;
      let deviceId: string;
      try {
        ({ deviceId } = await deps.signaling.connectDevice(auth));
      } finally {
        authenticating = false;
      }
      if (closed) return;
      authenticatedDeviceId = deviceId;
      addConnection(deviceId, ws);
      await deps.presence.setOnline(deviceId, true);
      if (closed) {
        if (!activeConnections.has(deviceId)) await deps.presence.setOnline(deviceId, false);
        return;
      }
      reply(id, true, { data: { deviceId } });
      return;
    }

    // 已认证：按 type 分派。
    switch (type) {
      case 'signal.forward': {
        const signal = SignedSignalSchema.parse(frame.payload);
        requireConnectionIdentity(signal.fromDeviceId);
        const forwarded: SignedSignal =
          await deps.signaling.forwardSignedSignal(signal);
        const targets = activeConnections.get(forwarded.toDeviceId);
        if (targets) {
          const delivery = JSON.stringify({
            type: 'signal.deliver',
            payload: forwarded,
          });
          for (const target of targets) target.send(delivery);
        }
        // data 中含原样密文与签名，但绝不含 grant。
        reply(id, true, { data: forwarded });
        return;
      }
      case 'presence.update': {
        const update = PresenceUpdateSchema.parse(frame.payload);
        requireConnectionIdentity(update.deviceId);
        reply(id, true, { data: await deps.presence.updatePresence(update) });
        return;
      }
      case 'presence.get': {
        const query = PresenceQuerySchema.parse(frame.payload);
        requireConnectionIdentity(query.deviceId);
        reply(id, true, { data: await deps.presence.getPresence(query) });
        return;
      }
      case 'revocations.list': {
        const query = RevocationListSchema.parse(frame.payload);
        requireConnectionIdentity(query.deviceId);
        await deps.devices.verifyRequestSignature(
          query.deviceId,
          query as unknown as Record<string, unknown>,
          query.signature,
          query.timestamp,
        );
        reply(id, true, {
          data: await deps.revocations.listRevocations(query.since),
        });
        return;
      }
      case 'revocation.publish': {
        const revoke = RevokeDeviceSchema.parse(frame.payload);
        requireConnectionIdentity(revoke.deviceId);
        const result = await deps.revocations.publishRevocation(revoke);
        broadcast(
          JSON.stringify({ type: 'revocation.published', payload: result }),
        );
        reply(id, true, { data: result });
        return;
      }
      default:
        reply(id, false, { error: { code: 'UNKNOWN_OP' } });
    }
  };

  ws.on('message', (raw: Buffer) => {
    if (closed) return;
    let frame: WsFrame;
    try {
      frame = JSON.parse(raw.toString('utf8')) as WsFrame;
      if (!frame || typeof frame !== 'object' || Array.isArray(frame)) throw new ZodError([]);
    } catch {
      sendError(undefined, new ZodError([]));
      return;
    }
    void handleFrame(frame).catch((err: unknown) => sendError(frame.id, err));
  });
  ws.on('close', () => {
    closed = true;
    if (authenticatedDeviceId === null) return;
    removeConnection(authenticatedDeviceId, ws);
    if (!activeConnections.has(authenticatedDeviceId)) {
      void deps.presence.setOnline(authenticatedDeviceId, false);
    }
  });
}
