/** 测试辅助：Ed25519 身份、签名封装、内存 app 工厂。私钥只在测试进程内，云端从不接触。 */
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { canonicalStringify } from '../src/schema/canonical.js';
import { sha256Hex } from '../src/crypto/signatures.js';
import { createApp, createDeps, type AppDeps } from '../src/app.js';
import { testConfig, type ControlPlaneConfig } from '../src/config.js';
import { createMemoryStores } from '../src/store/memory/MemoryStores.js';
import type { Stores } from '../src/store/interfaces.js';
import type { FastifyInstance } from 'fastify';
import type { DeviceRegistration } from '../src/schema/validation.js';

export interface TestIdentity {
  deviceId: string;
  keyPair: { publicKey: KeyObject; privateKey: KeyObject };
  identityPublicKey: string;
  identityFingerprint: string;
  signatureFor(body: Record<string, unknown>): string;
  signed<T extends Record<string, unknown>>(body: T): T & { signature: string };
}

export function createIdentity(deviceId = randomUUID()): TestIdentity {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const der = publicKey.export({ format: 'der', type: 'spki' });
  const raw = Buffer.from(der).subarray(12); // 去掉 Ed25519 SPKI 12 字节前缀
  const identityPublicKey = raw.toString('base64');
  const identityFingerprint = createHash('sha256')
    .update(raw)
    .digest('hex')
    .slice(0, 32);
  const signatureFor = (body: Record<string, unknown>): string =>
    sign(null, Buffer.from(canonicalStringify(body), 'utf8'), privateKey).toString(
      'base64',
    );
  return {
    deviceId,
    keyPair: { publicKey, privateKey },
    identityPublicKey,
    identityFingerprint,
    signatureFor,
    signed: <T extends Record<string, unknown>>(body: T) => ({
      ...body,
      signature: signatureFor(body),
    }),
  };
}

/** 去掉旧签名后对修改过的字段重新签名（避免把旧 signature 当作载荷的一部分）。 */
export function resign<T extends Record<string, unknown>>(
  identity: TestIdentity,
  signedBody: T,
  overrides: Partial<T> = {},
): T & { signature: string } {
  const { signature: _oldSignature, ...payload } = signedBody;
  return identity.signed({ ...payload, ...overrides } as T);
}

export function baseFields() {
  return { timestamp: new Date().toISOString(), nonce: randomUUID() };
}

export interface TestHarness {
  app: FastifyInstance;
  deps: AppDeps;
  stores: Stores;
  config: ControlPlaneConfig;
}

export function makeHarness(configOverrides: Partial<ReturnType<typeof testConfig>> = {}): TestHarness {
  const config = testConfig(configOverrides);
  const stores = createMemoryStores();
  const deps = createDeps(config, stores);
  const app = createApp(deps);
  return { app, deps, stores, config };
}

export async function registerIdentity(
  deps: AppDeps,
  identity: TestIdentity,
): Promise<void> {
  await deps.devices.registerDevice(
    identity.signed({
      deviceId: identity.deviceId,
      deviceType: 'windows-hub',
      displayName: 'Test Hub',
      identityPublicKey: identity.identityPublicKey,
      identityFingerprint: identity.identityFingerprint,
      ...baseFields(),
    }) as DeviceRegistration,
  );
}

/** 构造一个签名信令信封；ciphertext 模拟端到端加密后的不透明字节。 */
export function makeSignal(
  from: TestIdentity,
  toDeviceId: string,
  ciphertext = randomBytes(48).toString('base64'),
) {
  const fields = {
    type: 'offer' as const,
    sessionId: randomUUID(),
    fromDeviceId: from.deviceId,
    toDeviceId,
    dtlsFingerprint: 'a'.repeat(64),
    ciphertext,
    ciphertextHash: sha256Hex(Buffer.from(ciphertext, 'base64')),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...baseFields(),
  };
  return from.signed(fields);
}

/** 构造 Android 提交的配对申请（P3 契约 §3.2(1)），由 Android 自身身份签名。 */
export function pairingRequestBody(
  phone: TestIdentity,
  invitationId: string,
  invitationSecret: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> & { signature: string } {
  return phone.signed({
    invitationId,
    invitationSecret,
    deviceId: phone.deviceId,
    deviceType: 'android',
    displayName: 'Pixel 8',
    identityPublicKey: phone.identityPublicKey,
    identityFingerprint: phone.identityFingerprint,
    ...baseFields(),
    ...overrides,
  });
}

/** 构造 PC 本机批准/拒绝请求（P3 契约 §3.2(3)）。 */
export function decideRequestBody(
  issuer: TestIdentity,
  requestId: string,
  approved: boolean,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> & { signature: string } {
  return issuer.signed({
    requestId,
    issuerDeviceId: issuer.deviceId,
    approved,
    ...baseFields(),
    ...overrides,
  });
}

/** 构造 Android 轮询请求（P3 契约 §3.2(4)）。 */
export function pairingStatusBody(
  device: TestIdentity,
  requestId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> & { signature: string } {
  return device.signed({
    requestId,
    deviceId: device.deviceId,
    ...baseFields(),
    ...overrides,
  });
}

/** 构造 PC 拉取待批准申请请求（P3 契约 §3.2(2)）。 */
export function listRequestsBody(
  issuer: TestIdentity,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> & { signature: string } {
  return issuer.signed({
    issuerDeviceId: issuer.deviceId,
    ...baseFields(),
    ...overrides,
  });
}

/** 极简 WebSocket 模拟器：用于直接驱动 handleSignalingSocket，无需真实端口。 */
export function makeMockSocket() {
  const responses: Array<Record<string, unknown>> = [];
  const handlers: Record<string, (...args: unknown[]) => void> = {};
  const socket = {
    readyState: 1,
    send(data: string) {
      responses.push(JSON.parse(data) as Record<string, unknown>);
    },
    close() {
      socket.readyState = 3;
      handlers['close']?.();
    },
    on(event: string, listener: (...args: unknown[]) => void) {
      handlers[event] = listener;
    },
  };
  return {
    socket,
    responses,
    emitMessage(value: unknown) {
      handlers['message']?.(Buffer.from(JSON.stringify(value)));
    },
  };
}
