/** 依赖装配：把配置、仓储、核心类组装为控制平面服务集合。 */
import type { ControlPlaneConfig } from './config.js';
import type { Stores } from './store/interfaces.js';
import { DeviceRegistry } from './core/DeviceRegistry.js';
import { RateLimiter } from './core/RateLimiter.js';
import { PresenceManager } from './core/PresenceManager.js';
import { RevocationRegistry } from './core/RevocationRegistry.js';
import { PairingInvitationStore } from './gateway/PairingInvitationStore.js';
import { PairingRequestStore } from './gateway/PairingRequestStore.js';
import { TurnCredentialIssuer } from './gateway/TurnCredentialIssuer.js';
import { SignalingGateway } from './gateway/SignalingGateway.js';

export interface ControlPlaneServices {
  config: ControlPlaneConfig;
  stores: Stores;
  devices: DeviceRegistry;
  rateLimiter: RateLimiter;
  pairing: PairingInvitationStore;
  pairingRequests: PairingRequestStore;
  presence: PresenceManager;
  revocations: RevocationRegistry;
  turnIssuer: TurnCredentialIssuer;
  signaling: SignalingGateway;
}

export function createServices(
  config: ControlPlaneConfig,
  stores: Stores,
): ControlPlaneServices {
  const devices = new DeviceRegistry(stores, config);
  const rateLimiter = new RateLimiter(config);
  const presence = new PresenceManager(stores, devices, config);
  const revocations = new RevocationRegistry(stores, devices);
  const pairing = new PairingInvitationStore(stores, config, devices);
  const pairingRequests = new PairingRequestStore(
    stores,
    config,
    devices,
    pairing,
    rateLimiter,
  );
  const turnIssuer = new TurnCredentialIssuer(
    stores,
    config,
    devices,
    rateLimiter,
  );
  const signaling = new SignalingGateway(
    stores,
    config,
    devices,
    rateLimiter,
  );
  return {
    config,
    stores,
    devices,
    rateLimiter,
    pairing,
    pairingRequests,
    presence,
    revocations,
    turnIssuer,
    signaling,
  };
}
