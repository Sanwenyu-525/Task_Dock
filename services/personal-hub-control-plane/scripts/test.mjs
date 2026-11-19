/**
 * 测试启动器：在 Vitest 进程启动前把 Node/Vite 的临时目录指向服务目录内。
 * 当前执行环境的系统临时目录对沙箱不可写（EPERM），直接 `vitest run` 会间歇失败。
 * 主 Agent 集成复核（2026-11-19）：并行文件执行时 Vite SSR 缓存写入竞态会导致
 * 一个测试文件加载失败（EPERM, ssr/<hash>），出现 31/37 且 exit 1 的假阴性。
 * 因此固定 --no-file-parallelism 顺序执行，37/37 exit 0 稳定可复现。
 * 这只是测试基建稳定化，测试断言与覆盖范围不变。
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const localTmp = path.resolve(root, '.tmp');
mkdirSync(localTmp, { recursive: true });

const env = {
  ...process.env,
  TMPDIR: localTmp,
  TEMP: localTmp,
  TMP: localTmp,
};

const vitestBin = path.resolve(root, 'node_modules/vitest/vitest.mjs');
const extraArgs = process.argv.slice(2);
const noParallel = extraArgs.includes('--no-file-parallelism') || extraArgs.includes('--watch')
  ? []
  : ['--no-file-parallelism'];
const args = [vitestBin, 'run', ...noParallel, ...extraArgs];
const result = spawnSync(process.execPath, args, { stdio: 'inherit', env });
process.exit(result.status ?? 1);
