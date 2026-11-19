/**
 * 生产入口：优先 PostgreSQL（fail-closed）；未配置 DATABASE_URL 时回退内存仓储，
 * 仅供本地演示（README 有说明）。TLS 由前置反向代理终止。
 */
import { Pool } from 'pg';
import { loadConfig } from './config.js';
import { createApp, createDeps } from './app.js';
import { createMemoryStores } from './store/memory/MemoryStores.js';
import { createPostgresStores } from './store/postgres/PostgresStores.js';
import type { Stores } from './store/interfaces.js';

async function main(): Promise<void> {
  const config = loadConfig();
  let stores: Stores;
  let pool: Pool | null = null;

  if (config.databaseUrl) {
    pool = new Pool({
      connectionString: config.databaseUrl,
      max: 10,
      connectionTimeoutMillis: 5_000,
    });
    await pool.query('SELECT 1');
    stores = createPostgresStores(pool);
  } else {
    process.stderr.write(
      '[control-plane] WARNING: DATABASE_URL not set; using in-memory stores (demo only, not durable)\n',
    );
    stores = createMemoryStores();
  }

  const deps = createDeps(config, stores);
  const app = createApp(deps);
  await app.listen({ host: config.host, port: config.port });

  const shutdown = async (signal: string) => {
    process.stderr.write(`[control-plane] ${signal}: shutting down\n`);
    await app.close();
    if (pool) await pool.end();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[control-plane] fatal: ${message}\n`);
  process.exit(1);
});
