import { randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { basename, join, resolve } from "node:path";

function renameWithRetry(tmp, target) {
  const codes = new Set(["EPERM", "EACCES", "EBUSY", "ENOTEMPTY"]);
  const buf = new Int32Array(new SharedArrayBuffer(4));
  let lastErr = null;
  for (let i = 0; i < 200; i++) {
    try { renameSync(tmp, target); return; } catch (err) {
      lastErr = err;
      if (!codes.has(err?.code)) throw err;
      // 5ms 起、20ms 封顶，累计最多约 2s：机器被重负载或杀软拖慢时仍能等到写窗口
      Atomics.wait(buf, 0, 0, i < 4 ? 5 : 20);
    }
  }
  // 最后手段：直接原地覆盖写（放弃原子性，但绝不丢状态）。读方对半写文件已按"记录不存在"处理，
  // 下次轮询会重新写一遍，比"状态永远写不进去"安全。
  const text = readFileSync(tmp, "utf8");
  writeFileSync(target, text, "utf8");
  try { unlinkSync(tmp); } catch { /* ignore */ }
  void lastErr;
}

export function atomicWriteJson(target, value) {
  const dir = resolve(target, "..");
  const tmp = join(dir, `.${basename(target)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  const text = JSON.stringify(value, null, 2) + "\n";
  let fd = -1;
  try {
    fd = openSync(tmp, "wx");
    writeSync(fd, text);
    try { fsyncSync(fd); } catch { /* fsync 在部分 FS 上不可用，不阻塞写入 */ }
    closeSync(fd);
    fd = -1;
    renameWithRetry(tmp, target);
  } catch (err) {
    if (fd >= 0) { try { closeSync(fd); } catch { /* ignore */ } }
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

export function readJson(path) {
  try {
    const text = readFileSync(path, "utf8");
    if (!text.trim()) return null;
    return JSON.parse(text);
  } catch { return null; }
}

