// QR 编码器回归：与独立实现（toqr，纠错等级 M）的固定矩阵逐位对照。
// 只锁定「Byte 模式 + 纠错 M + 标准掩码择优」这一条路径，不覆盖其他纠错等级。

import { describe, expect, it } from "vitest";

import { encodeQr, qrToSvgPath } from "./qr";

/** toqr 对 "hello"（纠错 M）的输出，1 = 深色模块。 */
const HELLO = [
  "111111100110001111111",
  "100000101100001000001",
  "101110100101101011101",
  "101110100011001011101",
  "101110101100101011101",
  "100000100000101000001",
  "111111101010101111111",
  "000000000011100000000",
  "101010100101000010010",
  "001011000010001000011",
  "010100101110100011111",
  "110010000000001000010",
  "011010110010101010000",
  "000000001111010100111",
  "111111100011011100111",
  "100000100011110110000",
  "101110101011011100011",
  "101110100100001100110",
  "101110101110100010101",
  "100000100100001010010",
  "111111101110101100011",
];

describe("encodeQr", () => {
  it("与独立编码器输出一致（byte / ECC M / hello）", () => {
    const matrix = encodeQr("hello");
    expect(matrix.size).toBe(21);
    const rows = matrix.modules.map((row) => row.map((dark) => (dark ? "1" : "0")).join(""));
    expect(rows).toEqual(HELLO);
  });

  it("包含标准定位图形与分隔带", () => {
    const { size, modules } = encodeQr("taskdock://pair?v=1");
    expect(size).toBeGreaterThanOrEqual(21);
    // 左上定位图形：外圈深色、内圈 3×3 深色
    expect(modules[0][0]).toBe(true);
    expect(modules[0][6]).toBe(true);
    expect(modules[1][1]).toBe(false);
    expect(modules[3][3]).toBe(true);
    // 分隔带为浅色
    expect(modules[7][0]).toBe(false);
    expect(modules[0][7]).toBe(false);
  });

  it("SVG path 每个深色模块恰好一个矩形", () => {
    const matrix = encodeQr("hello");
    const dark = matrix.modules.flat().filter(Boolean).length;
    const segments = qrToSvgPath(matrix).match(/M\d+ \d+h1v1h-1z/g) ?? [];
    expect(segments).toHaveLength(dark);
  });

  it("中文按 UTF-8 字节编码且可容纳", () => {
    const text = "taskdock://pair?name=我的 台式机";
    const matrix = encodeQr(text);
    expect(matrix.size).toBeGreaterThan(21);
  });

  it("超过版本 10 容量时明确报错，不生成截断内容", () => {
    expect(() => encodeQr("A".repeat(214))).toThrow(/最多支持 213 字节/);
  });
});
