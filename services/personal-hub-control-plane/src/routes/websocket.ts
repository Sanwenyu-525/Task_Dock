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

interface WsLike {
  send(data: string): void;
  on(event: string, listener: (...args: any[]) => void): void;
}

interface WsFrame {
  id?: string;
  type?: string;
  payload?: unknown;
}

/** 处理一个已建立的 WSS 连接：先认证，再按 type 分派签名帧。 */
export function handleSignalingSocket(socket: unknown, deps: AppDeps): void {
  const ws = socket as unknown as WsLike;
  const connections = new Map<string, Set<WsLike>>();
  let authenticatedDeviceId: string | null = null;
  let currentFrameId: string | undefined;

  const addConnection = (deviceId: string, s: WsLike) => {
    const set = connections.get(deviceId) ?? new Set<WsLike>();
    set.add(s);
    connections.set(deviceId, set);
  };
  const removeConnection = (deviceId: string, s: WsLike) => {
    const set = connections.get(deviceId);
    if (!set) return;
    set.delete(s);
    if (set.size === 0) connections.delete(deviceId);
  };
  const broadcast = (message: string) => {
    for (const set of connections.values()) {
      for (const target of set) target.send(message);
    }
  };
  const reply = (
    id: string | undefined,
    ok: boolean,
    extra: Record<string, unknown> = {},
  ) => {
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

  const handleFrame = async (raw: Buffer): Promise<void> => {
    let frame: WsFrame;
    try {
      frame = JSON.parse(raw.toString('utf8')) as WsFrame;
    } catch {
      throw new ZodError([]);
    }
    if (!frame || typeof frame !== 'object') throw new ZodError([]);
    const { id, type } = frame;
    currentFrameId = id;

    // 未认证：只允许 auth。
    if (authenticatedDeviceId === null) {
      if (type !== 'auth') {
        reply(id, false, { error: { code: 'AUTH_REQUIRED' } });
        return;
      }
      const auth = WssAuthSchema.parse(frame.payload);
      const { deviceId } = await deps.signaling.connectDevice(auth);
      authenticatedDeviceId = deviceId;
      addConnection(deviceId, ws);
      await deps.presence.setOnline(deviceId, true);
      reply(id, true, { data: { deviceId } });
      return;
    }

    // 已认证：按 type 分派。
    switch (type) {
      case 'signal.forward': {
        const signal = SignedSignalSchema.parse(frame.payload);
        const forwarded: SignedSignal =
          await deps.signaling.forwardSignedSignal(signal);
        const targets = connections.get(forwarded.toDeviceId);
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
        reply(id, true, { data: await deps.presence.updatePresence(update) });
        return;
      }
      case 'presence.get': {
        const query = PresenceQuerySchema.parse(frame.payload);
        reply(id, true, { data: await deps.presence.getPresence(query) });
        return;
      }
      case 'revocations.list': {
        const query = RevocationListSchema.parse(frame.payload);
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
    currentFrameId = undefined;
    void handleFrame(raw).catch((err: unknown) => sendError(currentFrameId, err));
  });
  ws.on('close', () => {
    if (authenticatedDeviceId === null) return;
    removeConnection(authenticatedDeviceId, ws);
    void deps.presence.setOnline(authenticatedDeviceId, false);
  });
}
