//! 极简 QR Code 编码器（Byte 模式 / 纠错等级 M / 版本 1–10）。
//!
//! 只服务桌面端「配对新设备」二维码：不引入第三方二维码依赖，避免为一个展示
//! 组件扩大运行时依赖面。实现遵循 ISO/IEC 18004 的核心流程：
//! 数据编码 → Reed-Solomon 纠错 → 交织 → 功能图形 → 8 种掩码择优 → 格式/版本信息。
//!
//! 约束：
//! - 仅支持 UTF-8 字节模式与纠错等级 M；文本超过 213 字节抛错（配对载荷远小于此）；
//! - 输入不做 URL 解码/转义，调用方负责传入最终字符串；
//! - 输出为布尔矩阵（true = 深色模块），渲染层自行选择 SVG/Canvas；
//! - 本文件不依赖 React/DOM，可在 Node 与浏览器测试。

export interface QrMatrix {
  /** 边长（模块数），21 / 25 / ... / 57 */
  size: number;
  /** 行优先矩阵；true = 深色模块 */
  modules: boolean[][];
}

/** 纠错等级 M 的分块结构：[每块纠错码字数, 组1块数, 组1数据码字, 组2块数, 组2数据码字]。 */
const BLOCKS_M: Record<number, readonly [number, number, number, number, number]> = {
  1: [10, 1, 16, 0, 0],
  2: [16, 1, 28, 0, 0],
  3: [26, 1, 44, 0, 0],
  4: [18, 2, 32, 0, 0],
  5: [24, 2, 43, 0, 0],
  6: [16, 4, 27, 0, 0],
  7: [18, 4, 31, 0, 0],
  8: [22, 2, 38, 2, 39],
  9: [22, 3, 36, 2, 37],
  10: [26, 4, 43, 1, 44],
};

/** 对齐图形中心坐标（版本 1 无对齐图形）。 */
const ALIGNMENT: Record<number, readonly number[]> = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50],
};

const MAX_VERSION = 10;
/** 字节模式 + 每字节 8 位；版本 10 起字符计数为 16 位。 */
const MODE_BYTE = 0b0100;

/** GF(256) 指数/对数表，本原多项式 0x11D。 */
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
  let value = 1;
  for (let i = 0; i < 255; i += 1) {
    GF_EXP[i] = value;
    GF_LOG[value] = i;
    value <<= 1;
    if (value & 0x100) value ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) GF_EXP[i] = GF_EXP[i - 255];
}

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

/** 生成 degree 次的 Reed-Solomon 生成多项式。 */
function rsGenerator(degree: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i += 1) {
    const next = new Uint8Array(poly.length + 1);
    const root = GF_EXP[i];
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], root);
    }
    poly = next;
  }
  return poly;
}

function rsEncode(data: Uint8Array, ecCount: number): Uint8Array {
  const generator = rsGenerator(ecCount);
  const out = new Uint8Array(data.length + ecCount);
  out.set(data);
  for (let i = 0; i < data.length; i += 1) {
    const factor = out[i];
    if (factor === 0) continue;
    for (let j = 1; j < generator.length; j += 1) {
      out[i + j] ^= gfMul(generator[j], factor);
    }
  }
  return out.subarray(data.length);
}

interface BlockLayout {
  version: number;
  dataCodewords: number;
  blocks: Array<{ dataLength: number; ecLength: number }>;
}

function layoutFor(version: number): BlockLayout {
  const rule = BLOCKS_M[version];
  if (!rule) throw new Error(`不支持的 QR 版本：${version}`);
  const [ecLength, group1, data1, group2, data2] = rule;
  const blocks: BlockLayout["blocks"] = [];
  for (let i = 0; i < group1; i += 1) blocks.push({ dataLength: data1, ecLength });
  for (let i = 0; i < group2; i += 1) blocks.push({ dataLength: data2, ecLength });
  const dataCodewords = group1 * data1 + group2 * data2;
  return { version, dataCodewords, blocks };
}

function charCountBits(version: number): number {
  return version < 10 ? 8 : 16;
}

function bitCapacity(layout: BlockLayout): number {
  return layout.dataCodewords * 8;
}

function requiredBits(version: number, byteLength: number): number {
  return 4 + charCountBits(version) + byteLength * 8;
}

function chooseLayout(byteLength: number): BlockLayout {
  for (let version = 1; version <= MAX_VERSION; version += 1) {
    const layout = layoutFor(version);
    if (requiredBits(version, byteLength) <= bitCapacity(layout)) return layout;
  }
  throw new Error(`二维码内容过长（${byteLength} 字节），最多支持 213 字节`);
}

/** 组装数据码字：模式 + 长度 + 字节 + 终止符 + 补齐。 */
function buildDataCodewords(bytes: Uint8Array, layout: BlockLayout): Uint8Array {
  const bits: number[] = [];
  const pushBits = (value: number, count: number) => {
    for (let i = count - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
  };

  pushBits(MODE_BYTE, 4);
  pushBits(bytes.length, charCountBits(layout.version));
  for (const byte of bytes) pushBits(byte, 8);

  const capacity = bitCapacity(layout);
  const terminator = Math.min(4, capacity - bits.length);
  pushBits(0, terminator);
  while (bits.length % 8 !== 0) bits.push(0);

  const codewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let value = 0;
    for (let j = 0; j < 8; j += 1) value = (value << 1) | bits[i + j];
    codewords.push(value);
  }
  let pad = 0;
  while (codewords.length < layout.dataCodewords) {
    codewords.push(pad % 2 === 0 ? 0xec : 0x11);
    pad += 1;
  }
  return Uint8Array.from(codewords);
}

/** 按块纠错并交织，返回最终码字序列。 */
function interleave(data: Uint8Array, layout: BlockLayout): Uint8Array {
  const dataBlocks: Uint8Array[] = [];
  const ecBlocks: Uint8Array[] = [];
  let offset = 0;
  for (const block of layout.blocks) {
    const chunk = data.subarray(offset, offset + block.dataLength);
    offset += block.dataLength;
    dataBlocks.push(chunk);
    ecBlocks.push(rsEncode(chunk, block.ecLength));
  }

  const out: number[] = [];
  const maxData = Math.max(...dataBlocks.map((block) => block.length));
  for (let i = 0; i < maxData; i += 1) {
    for (const block of dataBlocks) {
      if (i < block.length) out.push(block[i]);
    }
  }
  const maxEc = Math.max(...ecBlocks.map((block) => block.length));
  for (let i = 0; i < maxEc; i += 1) {
    for (const block of ecBlocks) {
      if (i < block.length) out.push(block[i]);
    }
  }
  return Uint8Array.from(out);
}

interface Canvas {
  size: number;
  /** 模块颜色；null 表示尚未写入 */
  modules: (boolean | null)[][];
  /** 功能图形占用标记：数据放置必须跳过 */
  reserved: boolean[][];
}

function createCanvas(version: number): Canvas {
  const size = 17 + version * 4;
  return {
    size,
    modules: Array.from({ length: size }, () => Array<boolean | null>(size).fill(null)),
    reserved: Array.from({ length: size }, () => Array<boolean>(size).fill(false)),
  };
}

function setFunction(canvas: Canvas, row: number, col: number, dark: boolean): void {
  if (row < 0 || col < 0 || row >= canvas.size || col >= canvas.size) return;
  canvas.modules[row][col] = dark;
  canvas.reserved[row][col] = true;
}

function drawFinder(canvas: Canvas, row: number, col: number): void {
  for (let r = -1; r <= 7; r += 1) {
    for (let c = -1; c <= 7; c += 1) {
      const inside = r >= 0 && r <= 6 && c >= 0 && c <= 6;
      const dark =
        inside &&
        ((r === 0 || r === 6 || c === 0 || c === 6) ||
          (r >= 2 && r <= 4 && c >= 2 && c <= 4));
      setFunction(canvas, row + r, col + c, dark);
    }
  }
}

function drawAlignment(canvas: Canvas, row: number, col: number): void {
  for (let r = -2; r <= 2; r += 1) {
    for (let c = -2; c <= 2; c += 1) {
      const dark = Math.max(Math.abs(r), Math.abs(c)) !== 1;
      setFunction(canvas, row + r, col + c, dark);
    }
  }
}

function drawFunctionPatterns(canvas: Canvas, version: number): void {
  const { size } = canvas;
  drawFinder(canvas, 0, 0);
  drawFinder(canvas, 0, size - 7);
  drawFinder(canvas, size - 7, 0);

  for (let i = 8; i < size - 8; i += 1) {
    const dark = i % 2 === 0;
    setFunction(canvas, 6, i, dark);
    setFunction(canvas, i, 6, dark);
  }

  const centers = ALIGNMENT[version];
  const finderCorners = [
    [6, 6],
    [6, size - 7],
    [size - 7, 6],
  ];
  for (const row of centers) {
    for (const col of centers) {
      const overlapsFinder = finderCorners.some(
        ([r, c]) => Math.abs(r - row) <= 4 && Math.abs(c - col) <= 4,
      );
      if (!overlapsFinder) drawAlignment(canvas, row, col);
    }
  }

  // 预留格式信息区（实际位在掩码选择后写入）
  for (let i = 0; i < 9; i += 1) {
    if (i !== 6) setFunction(canvas, 8, i, false);
    if (i !== 6) setFunction(canvas, i, 8, false);
  }
  setFunction(canvas, 8, 8, false);
  for (let i = 0; i < 8; i += 1) {
    setFunction(canvas, 8, size - 1 - i, false);
    setFunction(canvas, size - 1 - i, 8, false);
  }
  // 固定深色模块
  setFunction(canvas, size - 8, 8, true);

  if (version >= 7) {
    for (let i = 0; i < 6; i += 1) {
      for (let j = 0; j < 3; j += 1) {
        setFunction(canvas, size - 11 + j, i, false);
        setFunction(canvas, i, size - 11 + j, false);
      }
    }
  }
}

function placeData(canvas: Canvas, codewords: Uint8Array): void {
  const { size } = canvas;
  let bitIndex = 0;
  let upward = true;

  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right -= 1; // 跳过竖直定时图形列
    for (let step = 0; step < size; step += 1) {
      const row = upward ? size - 1 - step : step;
      for (let offset = 0; offset < 2; offset += 1) {
        const col = right - offset;
        if (canvas.reserved[row][col]) continue;
        let bit = 0;
        if (bitIndex < codewords.length * 8) {
          const byte = codewords[bitIndex >> 3];
          bit = (byte >>> (7 - (bitIndex & 7))) & 1;
        }
        canvas.modules[row][col] = bit === 1;
        bitIndex += 1;
      }
    }
    upward = !upward;
  }
}

function maskBit(mask: number, row: number, col: number): boolean {
  switch (mask) {
    case 0:
      return (row + col) % 2 === 0;
    case 1:
      return row % 2 === 0;
    case 2:
      return col % 3 === 0;
    case 3:
      return (row + col) % 3 === 0;
    case 4:
      return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
    case 5:
      return ((row * col) % 2) + ((row * col) % 3) === 0;
    case 6:
      return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
    default:
      return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0;
  }
}

function applyMask(canvas: Canvas, mask: number): boolean[][] {
  return canvas.modules.map((rowCells, row) =>
    rowCells.map((cell, col) => {
      const value = cell ?? false;
      return canvas.reserved[row][col] ? value : value !== maskBit(mask, row, col);
    }),
  );
}

function penalty(matrix: boolean[][], size: number): number {
  let score = 0;

  // 规则 1：同色连续 ≥5
  const scanLine = (get: (i: number) => boolean) => {
    let run = 1;
    for (let i = 1; i < size; i += 1) {
      if (get(i) === get(i - 1)) {
        run += 1;
      } else {
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
    }
    if (run >= 5) score += 3 + (run - 5);
  };
  for (let row = 0; row < size; row += 1) scanLine((i) => matrix[row][i]);
  for (let col = 0; col < size; col += 1) scanLine((i) => matrix[i][col]);

  // 规则 2：2×2 同色块
  for (let row = 0; row < size - 1; row += 1) {
    for (let col = 0; col < size - 1; col += 1) {
      const value = matrix[row][col];
      if (
        matrix[row][col + 1] === value &&
        matrix[row + 1][col] === value &&
        matrix[row + 1][col + 1] === value
      ) {
        score += 3;
      }
    }
  }

  // 规则 3：类定位图形 1011101 + 四格空白（任一方向）
  const patternA = [true, false, true, true, true, false, true, false, false, false, false];
  const patternB = [false, false, false, false, true, false, true, true, true, false, true];
  const matches = (get: (i: number) => boolean, start: number, pattern: boolean[]) => {
    for (let i = 0; i < pattern.length; i += 1) {
      if (get(start + i) !== pattern[i]) return false;
    }
    return true;
  };
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col <= size - 11; col += 1) {
      if (matches((i) => matrix[row][i], col, patternA)) score += 40;
      if (matches((i) => matrix[row][i], col, patternB)) score += 40;
    }
  }
  for (let col = 0; col < size; col += 1) {
    for (let row = 0; row <= size - 11; row += 1) {
      if (matches((i) => matrix[i][col], row, patternA)) score += 40;
      if (matches((i) => matrix[i][col], row, patternB)) score += 40;
    }
  }

  // 规则 4：深色比例偏离 50%
  let dark = 0;
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) if (matrix[row][col]) dark += 1;
  }
  const ratio = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(ratio - 50) / 5) * 10;

  return score;
}

/** BCH(15,5) 格式信息，掩码常量 0x5412。 */
function formatInfo(mask: number): number {
  const data = mask; // 纠错等级 M 的两位为 00
  let value = data << 10;
  let remainder = value;
  for (let i = 0; i < 10; i += 1) {
    if (remainder & (1 << (14 - i))) remainder ^= 0x537 << (4 - i);
  }
  return ((value | (remainder & 0x3ff)) ^ 0x5412) & 0x7fff;
}

function versionInfo(version: number): number {
  let value = version << 12;
  let remainder = value;
  for (let i = 0; i < 6; i += 1) {
    if (remainder & (1 << (17 - i))) remainder ^= 0x1f25 << (5 - i);
  }
  return value | (remainder & 0xfff);
}

function writeFormatInfo(matrix: boolean[][], size: number, mask: number): void {
  const bits = formatInfo(mask);
  for (let i = 0; i < 15; i += 1) {
    const dark = ((bits >> i) & 1) === 1;
    // 左上：竖直 0..8（跳过第 6 行），水平 0..8（跳过第 6 列）
    if (i < 6) matrix[i][8] = dark;
    else if (i < 8) matrix[i + 1][8] = dark;
    else matrix[size - 15 + i][8] = dark;

    if (i < 8) matrix[8][size - 1 - i] = dark;
    else if (i < 9) matrix[8][15 - i - 1 + 1] = dark;
    else matrix[8][15 - i - 1] = dark;
  }
  matrix[size - 8][8] = true;
}

function writeVersionInfo(matrix: boolean[][], size: number, version: number): void {
  if (version < 7) return;
  const bits = versionInfo(version);
  for (let i = 0; i < 18; i += 1) {
    const dark = ((bits >> i) & 1) === 1;
    const row = Math.floor(i / 3);
    const col = (i % 3) + size - 11;
    matrix[col][row] = dark;
    matrix[row][col] = dark;
  }
}

/**
 * 编码为 QR 矩阵。
 *
 * 抛错条件：内容超过版本 10 的容量（213 字节）。配对载荷由调用方约束在
 * 200 字节以内，正常不会触发。
 */
export function encodeQr(text: string): QrMatrix {
  const bytes = new TextEncoder().encode(text);
  const layout = chooseLayout(bytes.length);
  const data = buildDataCodewords(bytes, layout);
  const codewords = interleave(data, layout);

  const canvas = createCanvas(layout.version);
  drawFunctionPatterns(canvas, layout.version);
  placeData(canvas, codewords);

  let bestMask = 0;
  let bestMatrix: boolean[][] | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let mask = 0; mask < 8; mask += 1) {
    const candidate = applyMask(canvas, mask);
    const score = penalty(candidate, canvas.size);
    if (score < bestScore) {
      bestScore = score;
      bestMask = mask;
      bestMatrix = candidate;
    }
  }

  const matrix = bestMatrix!;
  writeFormatInfo(matrix, canvas.size, bestMask);
  writeVersionInfo(matrix, canvas.size, layout.version);
  return { size: canvas.size, modules: matrix };
}

/** 渲染为 SVG path（每个深色模块一个 1×1 矩形），供 React 组件直接复用。 */
export function qrToSvgPath(matrix: QrMatrix): string {
  const parts: string[] = [];
  for (let row = 0; row < matrix.size; row += 1) {
    for (let col = 0; col < matrix.size; col += 1) {
      if (matrix.modules[row][col]) parts.push(`M${col} ${row}h1v1h-1z`);
    }
  }
  return parts.join("");
}
