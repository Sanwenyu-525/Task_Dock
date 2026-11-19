/** 控制平面运行时配置（生产 fail-closed：TURN_SECRET 必须显式配置）。 */
export interface ControlPlaneConfig {
  host: string;
  port: number;
  /** 为空表示使用内存仓储（仅测试/本地演示）；生产必须配置。 */
  databaseUrl: string | null;
  turnSecret: string;
  turnUris: string[];
  invitationTtlSeconds: number;
  maxInvitationAttempts: number;
  pairingRatePerMinute: number;
  signalingRatePerSecond: number;
  nonceTtlMs: number;
  maxClockSkewMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ControlPlaneConfig {
  const turnSecret = env.TURN_SECRET;
  if (!turnSecret || turnSecret.length < 16) {
    throw new Error('TURN_SECRET must be configured with at least 16 characters');
  }
  return {
    host: env.HOST ?? '127.0.0.1',
    port: Number.parseInt(env.PORT ?? '3000', 10),
    databaseUrl: env.DATABASE_URL ?? null,
    turnSecret,
    turnUris: (env.TURN_URIS ?? 'turn:127.0.0.1:3478?transport=udp')
      .split(',')
      .map((uri) => uri.trim())
      .filter(Boolean),
    invitationTtlSeconds: 300,
    maxInvitationAttempts: 5,
    pairingRatePerMinute: 10,
    signalingRatePerSecond: 30,
    nonceTtlMs: 5 * 60 * 1000,
    maxClockSkewMs: 5 * 60 * 1000,
  };
}

/** 测试用配置：固定密钥，允许覆盖任意字段，不依赖环境变量。 */
export function testConfig(
  overrides: Partial<ControlPlaneConfig> = {},
): ControlPlaneConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    databaseUrl: null,
    turnSecret: 'test-only-turn-shared-secret-0123456789',
    turnUris: ['turn:127.0.0.1:3478?transport=udp'],
    invitationTtlSeconds: 300,
    maxInvitationAttempts: 5,
    pairingRatePerMinute: 10,
    signalingRatePerSecond: 30,
    nonceTtlMs: 5 * 60 * 1000,
    maxClockSkewMs: 5 * 60 * 1000,
    ...overrides,
  };
}
