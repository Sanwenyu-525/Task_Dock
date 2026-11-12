// 流式 SHA-256（FIPS 180-4）：按 64 字节块增量计算，用于文件互传下载后的本地完整性复核。
//
// 为什么不用 expo-crypto：58 的 `digest()` 只接受一次性 BufferSource（整文件进内存），
// 没有「边写边算」的流式 API；下载分块解密发生在 JS 层（tweetnacl secretbox），
// 文件字节只在解密后才存在，原生层对响应流的摘要算的是密文信封，无法与桌面端清单里的
// 文件明文 SHA-256 比对。因此这里的增量实现是最小可行方案：每个分块（192KB）解密后
// update 一次，内存占用恒定，完成后与桌面端 `mobile_files.sha256` 比对，不匹配即
// 删除本地半成品并报错（fail-closed）。
//
// 算法实现遵循 ISO/FIPS 180-4 标准（与 node:crypto、桌面端 sha2 crate 同源），
// 用例见 `__tests__/sha256.test.ts`（NIST 向量 + 与 node:crypto 交叉验证）。

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const BLOCK_BYTES = 64;

export class Sha256 {
  private state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  /** 未满一块的尾部字节 */
  private tail = new Uint8Array(BLOCK_BYTES);
  private tailLength = 0;
  /** 已处理的总字节数（不含填充） */
  private totalBytes = 0;
  private finished = false;

  /** 追加一段字节；可多次调用，顺序影响结果（与任何流式哈希一致）。 */
  update(data: Uint8Array): this {
    if (this.finished) {
      throw new Error("SHA-256 已完成，不能再 update");
    }
    this.totalBytes += data.length;
    let offset = 0;
    // 先把上次残留填满一块
    if (this.tailLength > 0) {
      const need = BLOCK_BYTES - this.tailLength;
      const take = Math.min(need, data.length);
      this.tail.set(data.subarray(0, take), this.tailLength);
      this.tailLength += take;
      offset = take;
      if (this.tailLength === BLOCK_BYTES) {
        this.processBlock(this.tail, 0);
        this.tailLength = 0;
      } else {
        return this;
      }
    }
    // 整块直接处理
    while (offset + BLOCK_BYTES <= data.length) {
      this.processBlock(data, offset);
      offset += BLOCK_BYTES;
    }
    // 尾部缓存
    if (offset < data.length) {
      this.tail.set(data.subarray(offset), 0);
      this.tailLength = data.length - offset;
    }
    return this;
  }

  /** 结束填充并输出 64 位小写 hex。调用后实例不可再用。 */
  hex(): string {
    if (!this.finished) {
      this.finish();
    }
    return this.digestHex;
  }

  private digestHex = "";

  private finish(): void {
    // 填充：0x80 + 若干 0x00 + 64 位大端总位数；不足一块则补一块。
    const bitLengthLow = (this.totalBytes * 8) >>> 0;
    const bitLengthHigh = Math.floor((this.totalBytes * 8) / 0x100000000);
    const padding = new Uint8Array(BLOCK_BYTES);
    padding[0] = 0x80;
    // 长度放在最后 8 字节；若当前块放不下（tailLength > 56），先处理当前块再补一块。
    if (this.tailLength + 1 > BLOCK_BYTES - 8) {
      this.tail.set(padding.subarray(0, BLOCK_BYTES - this.tailLength), this.tailLength);
      this.processBlock(this.tail, 0);
      const lengthBlock = new Uint8Array(BLOCK_BYTES);
      writeUint32(lengthBlock, BLOCK_BYTES - 8, bitLengthHigh);
      writeUint32(lengthBlock, BLOCK_BYTES - 4, bitLengthLow);
      this.processBlock(lengthBlock, 0);
    } else {
      padding[BLOCK_BYTES - 8] = 0; // 先整块清零（padding 初始即 0）
      this.tail.set(padding.subarray(0, BLOCK_BYTES - this.tailLength), this.tailLength);
      writeUint32(this.tail, BLOCK_BYTES - 8, bitLengthHigh);
      writeUint32(this.tail, BLOCK_BYTES - 4, bitLengthLow);
      this.processBlock(this.tail, 0);
    }
    this.digestHex = Array.from(this.state)
      .map((word) => word.toString(16).padStart(8, "0"))
      .join("");
    this.finished = true;
  }

  private w = new Uint32Array(64);

  private processBlock(block: Uint8Array, offset: number): void {
    const w = this.w;
    for (let i = 0; i < 16; i += 1) {
      const j = offset + i * 4;
      w[i] = (block[j] << 24) | (block[j + 1] << 16) | (block[j + 2] << 8) | block[j + 3];
    }
    for (let i = 16; i < 64; i += 1) {
      const x = w[i - 15];
      const y = w[i - 2];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    const [a0, b0, c0, d0, e0, f0, g0, h0] = this.state;
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    let e = e0;
    let f = f0;
    let g = g0;
    let h = h0;

    for (let i = 0; i < 64; i += 1) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }

    const next = this.state;
    next[0] = (next[0] + a) >>> 0;
    next[1] = (next[1] + b) >>> 0;
    next[2] = (next[2] + c) >>> 0;
    next[3] = (next[3] + d) >>> 0;
    next[4] = (next[4] + e) >>> 0;
    next[5] = (next[5] + f) >>> 0;
    next[6] = (next[6] + g) >>> 0;
    next[7] = (next[7] + h) >>> 0;
  }
}

function writeUint32(target: Uint8Array, offset: number, value: number): void {
  target[offset] = (value >>> 24) & 0xff;
  target[offset + 1] = (value >>> 16) & 0xff;
  target[offset + 2] = (value >>> 8) & 0xff;
  target[offset + 3] = value & 0xff;
}

/** 一次性计算；等价 `new Sha256().update(data).hex()`。 */
export function sha256Hex(data: Uint8Array): string {
  return new Sha256().update(data).hex();
}

/** 逐段增量计算，返回 hex；用于测试与跨实现对照。 */
export function sha256HexOfChunks(chunks: Uint8Array[]): string {
  const hasher = new Sha256();
  for (const chunk of chunks) {
    hasher.update(chunk);
  }
  return hasher.hex();
}
