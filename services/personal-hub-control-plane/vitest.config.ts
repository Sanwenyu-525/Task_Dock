import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

// 当前执行环境的系统临时目录对本沙箱不可写（EPERM）。
// 在加载 vitest 配置时把 Vite SSR 缓存/临时目录重定向到服务目录内。
const localTmp = path.resolve(process.cwd(), '.tmp');
const localCache = path.resolve(process.cwd(), '.vitest-cache');
mkdirSync(localTmp, { recursive: true });
mkdirSync(localCache, { recursive: true });
process.env.TMPDIR = localTmp;
process.env.TEMP = localTmp;
process.env.TMP = localTmp;

export default defineConfig({
  cacheDir: localCache,
  test: {
    cache: false,
    include: ['test/**/*.test.ts'],
  },
});
