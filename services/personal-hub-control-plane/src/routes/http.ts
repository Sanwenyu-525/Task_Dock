/**
 * HTTP 路由（HTTPS，本地开发 HTTP）。
 * 统一约定：所有数据接口均为 POST + JSON body，body 含 timestamp/nonce/signature；
 * 每个接口经过 zod schema 校验 → 设备签名校验 → 限流 → 过期检查 → 审计（在核心类中完成）。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import {
  CreateInvitationSchema,
  DeviceQuerySchema,
  DeviceRegistrationSchema,
  PairingDecideSchema,
  PairingRequestSchema,
  PairingRequestsListSchema,
  PairingStatusQuerySchema,
  PresenceQuerySchema,
  PresenceUpdateSchema,
  RevocationListSchema,
  RevokeDeviceSchema,
  TurnCredentialsRequestSchema,
} from '../schema/validation.js';
import { SecurityError } from '../core/errors.js';
import type { AppDeps } from '../app.js';

function bodyOf(request: FastifyRequest): Record<string, unknown> {
  if (request.body === null || typeof request.body !== 'object') {
    throw new SecurityError('INVALID_SCHEMA');
  }
  return request.body as Record<string, unknown>;
}

function errorResponse(reply: FastifyReply, error: unknown) {
  if (error instanceof ZodError) {
    return reply.code(400).send({
      ok: false,
      error: {
        code: 'INVALID_SCHEMA',
        message: 'request payload failed schema validation',
      },
    });
  }
  if (error instanceof SecurityError) {
    const statusByCode: Record<string, number> = {
      INVALID_SCHEMA: 400,
      STALE_TIMESTAMP: 400,
      FINGERPRINT_MISMATCH: 401,
      INVALID_SIGNATURE: 401,
      DEVICE_REVOKED: 403,
      DEVICE_NOT_FOUND: 404,
      RATE_LIMITED: 429,
      REPLAY_DETECTED: 409,
      DEVICE_ALREADY_EXISTS: 409,
      INVALID_INVITATION: 400,
      INVITATION_NOT_PENDING: 409,
      INVITATION_EXPIRED: 410,
      IDENTITY_MISMATCH: 401,
      REQUEST_NOT_FOUND: 404,
    };
    return reply.code(statusByCode[error.code] ?? 400).send({
      ok: false,
      error: { code: error.code, message: error.message },
    });
  }
  // 不向客户端泄露堆栈或内部错误细节。
  return reply.code(500).send({
    ok: false,
    error: { code: 'INTERNAL_ERROR', message: 'internal error' },
  });
}

export function registerHttpRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get('/v1/health', async () => ({
    status: 'ok',
    service: 'personal-hub-control-plane',
    version: '1.0.0',
  }));

  app.post('/v1/devices/register', async (request, reply) => {
    try {
      const input = DeviceRegistrationSchema.parse(bodyOf(request));
      const device = await deps.devices.registerDevice(input);
      return reply.code(201).send({ ok: true, device });
    } catch (error) {
      return errorResponse(reply, error);
    }
  });

  app.post('/v1/devices/get', async (request, reply) => {
    try {
      const input = DeviceQuerySchema.parse(bodyOf(request));
      // 设备发现也要求请求者签名（所有云端接口必须签名校验）。
      await deps.devices.verifyRequestSignature(
        input.deviceId,
        input as unknown as Record<string, unknown>,
        input.signature,
        input.timestamp,
      );
      const device = await deps.devices.getDevice(input.deviceId);
      return reply.send({ ok: true, device });
    } catch (error) {
      return errorResponse(reply, error);
    }
  });

  app.post('/v1/devices/revoke', async (request, reply) => {
    try {
      const input = RevokeDeviceSchema.parse(bodyOf(request));
      const result = await deps.revocations.publishRevocation(input);
      return reply.send({ ok: true, revocation: result });
    } catch (error) {
      return errorResponse(reply, error);
    }
  });

  app.post('/v1/invitations/create', async (request, reply) => {
    try {
      const input = CreateInvitationSchema.parse(bodyOf(request));
      const result = await deps.pairings.createInvitation(input);
      return reply.code(201).send({
        ok: true,
        invitation: result.invitation,
        invitationSecret: result.invitationSecret,
      });
    } catch (error) {
      return errorResponse(reply, error);
    }
  });

  // P3 安全修复：`/v1/invitations/consume` 公开路由已移除。
  // 邀请只能由 PC 本机批准路径（POST /v1/pairing/decide, approved=true）消费，
  // Android 单方面调用不再能创建设备（基线 §6.2 第 4–8 步 / 契约 §0）。
  // 保留显式 410，便于旧客户端得到「已下线」而非「未知路由」的确定信号。
  app.post('/v1/invitations/consume', async (_request, reply) =>
    reply.code(410).send({
      ok: false,
      error: {
        code: 'ENDPOINT_GONE',
        message:
          'invitation consumption requires PC approval; use /v1/pairing/request then /v1/pairing/decide',
      },
    }),
  );

  // ---- P3 配对批准状态机（契约 §3.2）----

  app.post('/v1/pairing/request', async (request, reply) => {
    try {
      const input = PairingRequestSchema.parse(bodyOf(request));
      const result = await deps.pairingRequests.submitRequest(input);
      return reply.code(201).send({ ok: true, ...result });
    } catch (error) {
      return errorResponse(reply, error);
    }
  });

  app.post('/v1/pairing/requests/list', async (request, reply) => {
    try {
      const input = PairingRequestsListSchema.parse(bodyOf(request));
      const requests = await deps.pairingRequests.listPendingRequests(input);
      return reply.send({ ok: true, requests });
    } catch (error) {
      return errorResponse(reply, error);
    }
  });

  app.post('/v1/pairing/decide', async (request, reply) => {
    try {
      const input = PairingDecideSchema.parse(bodyOf(request));
      const decision = await deps.pairingRequests.decideRequest(input);
      if (decision.status === 'approved') {
        return reply.send({
          ok: true,
          status: decision.status,
          device: decision.device,
          pairedCapabilities: decision.pairedCapabilities,
        });
      }
      // 拒绝路径不返回设备、能力或任何 grant。
      return reply.send({ ok: true, status: decision.status });
    } catch (error) {
      return errorResponse(reply, error);
    }
  });

  app.post('/v1/pairing/status', async (request, reply) => {
    try {
      const input = PairingStatusQuerySchema.parse(bodyOf(request));
      const result = await deps.pairingRequests.getRequestStatus(input);
      return reply.send({ ok: true, ...result });
    } catch (error) {
      return errorResponse(reply, error);
    }
  });

  app.post('/v1/turn/credentials', async (request, reply) => {
    try {
      const input = TurnCredentialsRequestSchema.parse(bodyOf(request));
      const credentials = await deps.turn.issueEphemeralCredentials(input);
      return reply.send({ ok: true, credentials });
    } catch (error) {
      return errorResponse(reply, error);
    }
  });

  app.post('/v1/presence/update', async (request, reply) => {
    try {
      const input = PresenceUpdateSchema.parse(bodyOf(request));
      const presence = await deps.presence.updatePresence(input);
      return reply.send({ ok: true, presence });
    } catch (error) {
      return errorResponse(reply, error);
    }
  });

  app.post('/v1/presence/get', async (request, reply) => {
    try {
      const input = PresenceQuerySchema.parse(bodyOf(request));
      const presence = await deps.presence.getPresence(input);
      return reply.send({ ok: true, presence });
    } catch (error) {
      return errorResponse(reply, error);
    }
  });

  app.post('/v1/revocations/list', async (request, reply) => {
    try {
      const input = RevocationListSchema.parse(bodyOf(request));
      await deps.devices.verifyRequestSignature(
        input.deviceId,
        input as unknown as Record<string, unknown>,
        input.signature,
        input.timestamp,
      );
      const revocations = await deps.revocations.listRevocations(input.since);
      return reply.send({ ok: true, revocations });
    } catch (error) {
      return errorResponse(reply, error);
    }
  });
}
