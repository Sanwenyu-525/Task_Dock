/**
 * 安全证明测试（不可降级）：
 *  P1 服务端不能签发 LocalAuthGrant（源码无签发标识符、无 Ed25519 签名调用、无 grant 路由）；
 *  P2 所有 API 响应不含任何 grant 字段，且 grant 端点不存在；
 *  P3 服务端不能读私钥（schema/SQL 无私钥或密码列，strict schema 拒绝越界字段）；
 *  P4 服务端不能读取/解密媒体或 Control DataChannel（无解密 API，密文原样透传且不落库/不入审计）；
 *  P5 只转发签名绑定的信令密文（改字段/换密钥签名均被拒）。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
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
import { sha256Hex } from '../../src/crypto/signatures.js';
import type { SignedSignal } from '../../src/schema/validation.js';

const SRC = path.resolve(process.cwd(), 'src');

function sourceFiles(dir: string): string[] {
  const result: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      result.push(...sourceFiles(full));
    } else if (full.endsWith('.ts')) {
      result.push(full);
    }
  }
  return result;
}

/** 去掉注释后扫描，避免把「禁止事项」的文档注释误判为能力。 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/--[^\n]*/g, '');
}

const code = sourceFiles(SRC)
  .map((file) => stripComments(readFileSync(file, 'utf8')))
  .join('\n');

function collectKeys(value: unknown): string[] {
  if (value === null || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(collectKeys);
  return Object.entries(value as Record<string, unknown>).flatMap(([key, v]) => [
    key,
    ...collectKeys(v),
  ]);
}

describe('安全证明 P1：服务端不能签发 LocalAuthGrant', () => {
  it('src 中不存在任何 grant 签发标识符，也无 Ed25519 签名调用', () => {
    for (const pattern of [
      /issueLocalAuthGrant/i,
      /createLocalAuthGrant/i,
      /signLocalAuthGrant/i,
      /\bgrant_id\b/i,
      /\bgrantId\b/i,
      /\bgrant_secret\b/i,
      /\bgrantSecret\b/i,
      /\blocal_signature\b/i,
      /\blocalSignature\b/i,
    ]) {
      expect(code).not.toMatch(pattern);
    }
    // 云端只验签、只做 HMAC(TURN)；没有任何 Ed25519 sign() 调用 => 无法签发被控端授权。
    expect(code).not.toMatch(/\bsign\s*\(/);
  });

  it('无 grant 路由；任何接口响应都不含 grant 字段', async () => {
    // 用真实 app 走一遍配对（申请 → PC 批准）与凭证接口，逐字段检查响应键。
    const h = makeHarness();
    const id = createIdentity();
    await registerIdentity(h.deps, id);
    const created = await h.app.inject({
      method: 'POST',
      url: '/v1/invitations/create',
      payload: id.signed({ issuerDeviceId: id.deviceId, ...baseFields() }),
    });
    const { invitationSecret, invitation } = created.json();
    const phone = createIdentity();
    const submitted = await h.app.inject({
      method: 'POST',
      url: '/v1/pairing/request',
      payload: pairingRequestBody(
        phone,
        invitation.invitationId,
        invitationSecret,
      ),
    });
    expect(submitted.statusCode).toBe(201);
    const decided = await h.app.inject({
      method: 'POST',
      url: '/v1/pairing/decide',
      payload: decideRequestBody(id, submitted.json().requestId, true),
    });
    expect(decided.statusCode).toBe(200);
    const turn = await h.app.inject({
      method: 'POST',
      url: '/v1/turn/credentials',
      payload: id.signed({ deviceId: id.deviceId, ...baseFields() }),
    });
    const responses = [
      created.json(),
      submitted.json(),
      decided.json(),
      turn.json(),
    ];
    for (const response of responses) {
      expect(collectKeys(response).filter((k) => /grant/i.test(k))).toEqual([]);
    }
    expect(decided.json().pairedCapabilities).not.toContain('REMOTE_CONTROL');
    expect(
      (await h.app.inject({ method: 'POST', url: '/v1/grants/issue', payload: {} }))
        .statusCode,
    ).toBe(404);
    // P3 安全修复：公开的邀请消费路由必须已下线，不能绕过 PC 批准。
    const legacy = await h.app.inject({
      method: 'POST',
      url: '/v1/invitations/consume',
      payload: {},
    });
    expect(legacy.statusCode).toBeGreaterThanOrEqual(400);
  });
});

describe('安全证明 P2：服务端不能读私钥', () => {
  it('schema 与 SQL 无私钥/密码列，strict schema 拒绝 privateKey 字段', async () => {
    const validationSource = stripComments(
      readFileSync(path.join(SRC, 'schema/validation.ts'), 'utf8'),
    );
    const sqlSource = stripComments(
      readFileSync(
        path.resolve(process.cwd(), 'schema/sql/001_init.sql'),
        'utf8',
      ),
    );
    // P3 新增的配对申请表同样不得含私钥/密码列。
    const pairingRequestSql = stripComments(
      readFileSync(
        path.resolve(process.cwd(), 'schema/sql/002_pairing_requests.sql'),
        'utf8',
      ),
    );
    expect(validationSource).not.toMatch(/privateKey|private_key/);
    expect(sqlSource).not.toMatch(/private_key|\bpassword\b/i);
    expect(pairingRequestSql).not.toMatch(/private_key|\bpassword\b/i);

    const { app } = makeHarness();
    const id = createIdentity();
    const rejected = await app.inject({
      method: 'POST',
      url: '/v1/devices/register',
      payload: {
        ...id.signed({
          deviceId: id.deviceId,
          deviceType: 'windows-hub',
          displayName: 'Hub',
          identityPublicKey: id.identityPublicKey,
          identityFingerprint: id.identityFingerprint,
          ...baseFields(),
        }),
        privateKey: 'SHOULD_NOT_BE_ACCEPTED',
      },
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error.code).toBe('INVALID_SCHEMA');
  });

  it('设备记录中不存在私钥字段，注册响应不回显任何私钥材料', async () => {
    const { deps } = makeHarness();
    const id = createIdentity();
    await registerIdentity(deps, id);
    const device = await deps.devices.getDevice(id.deviceId);
    expect(device).not.toBeNull();
    expect(collectKeys(device).filter((k) => /private|secret|password/i.test(k))).toEqual([]);
  });
});

describe('安全证明 P3：服务端不能读取/解密媒体或 Control DataChannel', () => {
  it('信令网关无任何解密 API', () => {
    const gateway = stripComments(
      readFileSync(path.join(SRC, 'gateway/SignalingGateway.ts'), 'utf8'),
    );
    for (const pattern of [
      /createDecipher/i,
      /createDecipheriv/i,
      /privateDecrypt/i,
      /\.decrypt\s*\(/i,
      /decipher/i,
    ]) {
      expect(gateway).not.toMatch(pattern);
    }
  });

  it('即使密文看似明文控制消息，网关也只原样转发、不解析、不落库、不入审计', async () => {
    const h = makeHarness();
    const hub = createIdentity();
    const phone = createIdentity();
    await registerIdentity(h.deps, hub);
    await registerIdentity(h.deps, phone);

    const controlPlaintext = JSON.stringify({
      session_id: randomUUID(),
      command: 'CONTROL_MOUSE_MOVE',
      x: 123,
      y: 456,
    });
    const opaqueCiphertext = Buffer.from(controlPlaintext).toString('base64');
    const signal = makeSignal(hub, phone.deviceId, opaqueCiphertext);
    const forwarded = await h.deps.signaling.forwardSignedSignal(signal as SignedSignal);

    expect(forwarded.ciphertext).toBe(opaqueCiphertext);
    // 网关未 base64 解码解析：明文控制指令不出现在转发结果、会话元数据或审计中。
    expect(JSON.stringify(forwarded)).not.toContain('CONTROL_MOUSE_MOVE');
    const session = await h.stores.sessions.get(signal.sessionId);
    expect(JSON.stringify(session)).not.toContain('CONTROL_MOUSE_MOVE');
    expect(JSON.stringify(await h.stores.audit.list())).not.toContain('CONTROL_MOUSE_MOVE');
  });
});

describe('安全证明 P4：只转发签名绑定的信令密文', () => {
  async function setup() {
    const h = makeHarness();
    const hub = createIdentity();
    const phone = createIdentity();
    await registerIdentity(h.deps, hub);
    await registerIdentity(h.deps, phone);
    return { ...h, hub, phone };
  }

  it('换密钥签名、改目标设备、改密文均被拒绝', async () => {
    const { deps, hub, phone } = await setup();
    const signal = makeSignal(hub, phone.deviceId);
    const { signature: _signature, ...payload } = signal;
    const attacker = createIdentity();

    await expect(
      deps.signaling.forwardSignedSignal({
        ...payload,
        signature: attacker.signatureFor(payload),
      } as SignedSignal),
    ).rejects.toMatchObject({ code: 'INVALID_SIGNATURE' });

    await expect(
      deps.signaling.forwardSignedSignal({
        ...signal,
        toDeviceId: randomUUID(),
        // 换一个未使用的 nonce，避免先命中重放检测；签名仍为原签名，必然验签失败。
        nonce: randomUUID(),
      } as SignedSignal),
    ).rejects.toMatchObject({ code: 'INVALID_SIGNATURE' });

    const s3 = makeSignal(hub, phone.deviceId);
    await expect(
      deps.signaling.forwardSignedSignal(
        resign(hub, s3, {
          ciphertext: randomBytes(32).toString('base64'),
          nonce: randomUUID(),
        }) as SignedSignal,
      ),
    ).rejects.toMatchObject({ code: 'CIPHERTEXT_HASH_MISMATCH' });
  });

  it('密文哈希必须与密文字节一致（签名之外的第二道完整性绑定）', async () => {
    const { deps, hub, phone } = await setup();
    const signal = makeSignal(hub, phone.deviceId);
    expect(sha256Hex(Buffer.from(signal.ciphertext, 'base64'))).toBe(
      signal.ciphertextHash,
    );
    const tamperedHash = resign(hub, signal, {
      ciphertextHash: '0'.repeat(64),
    }) as SignedSignal;
    await expect(
      deps.signaling.forwardSignedSignal(tamperedHash),
    ).rejects.toMatchObject({ code: 'CIPHERTEXT_HASH_MISMATCH' });
  });
});
