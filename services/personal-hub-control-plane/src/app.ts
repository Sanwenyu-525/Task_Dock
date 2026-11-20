/** 依赖组装与应用工厂（便于集成测试用 app.inject，无需真实网络/数据库）。 */
import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import type { ControlPlaneConfig } from './config.js';
import type { Stores } from './store/interfaces.js';
import { RateLimiter } from './core/RateLimiter.js';
import { DeviceRegistry } from './core/DeviceRegistry.js';
import { PresenceManager } from './core/PresenceManager.js';
import { RevocationRegistry } from './core/RevocationRegistry.js';
import { PairingInvitationStore } from './gateway/PairingInvitationStore.js';
import { PairingRequestStore } from './gateway/PairingRequestStore.js';
import { TurnCredentialIssuer } from './gateway/TurnCredentialIssuer.js';
import { SignalingGateway } from './gateway/SignalingGateway.js';
import { registerHttpRoutes } from './routes/http.js';
import { handleSignalingSocket } from './routes/websocket.js';
import { toApiError } from './routes/errors.js';

export interface AppDeps {
  config: ControlPlaneConfig;
  stores: Stores;
  rateLimiter: RateLimiter;
  devices: DeviceRegistry;
  pairings: PairingInvitationStore;
  pairingRequests: PairingRequestStore;
  presence: PresenceManager;
  revocations: RevocationRegistry;
  turn: TurnCredentialIssuer;
  signaling: SignalingGateway;
}

export function createDeps(
  config: ControlPlaneConfig,
  stores: Stores,
): AppDeps {
  const rateLimiter = new RateLimiter(config);
  const devices = new DeviceRegistry(stores, config);
  const pairings = new PairingInvitationStore(stores, config, devices);
  return {
    config,
    stores,
    rateLimiter,
    devices,
    pairings,
    pairingRequests: new PairingRequestStore(
      stores,
      config,
      devices,
      pairings,
      rateLimiter,
    ),
    presence: new PresenceManager(stores, devices, config),
    revocations: new RevocationRegistry(stores, devices),
    turn: new TurnCredentialIssuer(stores, config, devices, rateLimiter),
    signaling: new SignalingGateway(stores, config, devices, rateLimiter),
  };
}

export function createApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 + 4096 });
  app.setErrorHandler((error, _request, reply) => {
    const apiError = toApiError(error);
    reply.code(apiError.statusCode).send({
      ok: false,
      error: { code: apiError.code, message: apiError.message },
    });
  });
  app.register(websocket);
  registerHttpRoutes(app, deps);
  // 在 WebSocket 插件就绪后注册路由，使升级钩子先安装。
  app.register(async (scope) => {
    scope.get('/v1/signaling', { websocket: true }, (socket) => {
      handleSignalingSocket(socket, deps);
    });
  });
  return app;
}
