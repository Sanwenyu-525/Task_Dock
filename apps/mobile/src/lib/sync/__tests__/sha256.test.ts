// 流式 SHA-256 的正确性用例：NIST 标准向量 + 与 node:crypto 的交叉验证 + 增量分段一致性。
// 这是文件互传下载完整性复核（fileIo.ts downloadRemoteFile）的信任基座：
// 该实现如果算错，会把损坏文件误判为完好，或把完好文件误删。
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { Sha256, sha256Hex, sha256HexOfChunks } from "../sha256";

function nodeSha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function ascendingBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) out[i] = i % 256;
  return out;
}

describe("Sha256 标准向量", () => {
  it("空字符串（FIPS 180-4 示例）", () => {
    expect(sha256Hex(new Uint8Array(0))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it('"abc"（FIPS 180-4 示例）', () => {
    expect(sha256Hex(new TextEncoder().encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it('448 位消息 "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"（FIPS 180-4 示例）', () => {
    const message =
      "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq";
    expect(sha256Hex(new TextEncoder().encode(message))).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    );
  });

  it("百万个 a（大输入，跨多块处理；常量经 node:crypto 与 python hashlib 双源核对）", () => {
    const millionA = new Uint8Array(1_000_000).fill(0x61);
    expect(sha256Hex(millionA)).toBe(
      "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0",
    );
  });
});

describe("Sha256 增量分段", () => {
  const cases = [0, 1, 63, 64, 65, 127, 128, 191, 192, 193, 1000, 192 * 1024, 192 * 1024 + 17];

  for (const length of cases) {
    it(`分段更新与整体一致（${length} 字节，跨块边界）`, () => {
      const data = ascendingBytes(length);
      const whole = sha256Hex(data);
      // 按 192KB 分块（与文件互传分块同尺寸）+ 再按奇数小块验证
      const chunked = sha256HexOfChunks(
        Array.from({ length: Math.ceil(length / 192) }, (_, i) =>
          data.subarray(i * 192, Math.min((i + 1) * 192, length)),
        ),
      );
      const oddChunks: Uint8Array[] = [];
      let offset = 0;
      let step = 1;
      while (offset < length) {
        oddChunks.push(data.subarray(offset, Math.min(offset + step, length)));
        offset += step;
        step += 3;
      }
      expect(chunked).toBe(whole);
      expect(sha256HexOfChunks(oddChunks)).toBe(whole);
      expect(whole).toBe(nodeSha256Hex(data));
    });
  }

  it("与 node:crypto 交叉验证（随机尺寸 100 组）", () => {
    for (let round = 0; round < 100; round += 1) {
      const length = Math.floor(Math.random() * 5000);
      const data = new Uint8Array(length);
      crypto.getRandomValues(data);
      expect(sha256Hex(data)).toBe(nodeSha256Hex(data));
    }
  });

  it("hex() 之后不能再 update", () => {
    const hasher = new Sha256();
    hasher.update(new Uint8Array([1, 2, 3]));
    hasher.hex();
    expect(() => hasher.update(new Uint8Array([4]))).toThrow();
  });

  it("空输入分段（空数组）", () => {
    expect(sha256HexOfChunks([])).toBe(sha256Hex(new Uint8Array(0)));
  });
});
