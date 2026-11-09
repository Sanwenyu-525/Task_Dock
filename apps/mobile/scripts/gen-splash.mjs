// 生成原生启动图：与 JS 启动动画首帧完全一致的「清单骨架」。
//
// 背景：expo-splash-screen 的 android 原生图只支持一张静态位图，而 JS 启动页要从
// 同一张骨架开始做「行填充 → 勾选弹入」。两边几何一旦漂移，原生图隐藏时就会跳一下。
// 因此几何只在这里和 src/components/LaunchOverlay.tsx 的常量里各写一份，改动必须同步：
//
//   PLATE=80  RADIUS=22  BORDER=1
//   DOT=12    DOT_X=14   ROW_CY=[26,40,54]
//   BAR_X=31  BAR_H=7    BAR_W=[30,35,24]
//
// 颜色取 tokens 的合成值（图片不支持 Token）：
//   浅色：card #FFFFFF / cardBorder #E4E8F0 / muted #5D6B80 @38%
//   深色：card #121A28 / cardBorder #242F42 / muted #93A5BD @35%
//
// 零依赖：自行光栅化 + 编码 PNG，不引入 sharp/canvas（与 gen-icons.mjs 同一策略）。
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "assets");

// ---------- 画布 ----------
const SIZE_DP = 80;
/** 输出 8×（xxxhdpi=4×，仍有 2× 余量），4×4 超采样做抗锯齿 */
const OUT_PX = 640;
const SS = 4;
const PX = OUT_PX * SS;
const K = PX / SIZE_DP; // dp → 超采样像素

const light = {
  canvas: [0, 0, 0, 0],
  plate: [0xff, 0xff, 0xff, 0xff],
  border: [0xe4, 0xe8, 0xf0, 0xff],
  track: [0xc1, 0xc7, 0xcf, 0xff], // muted #5D6B80 @38% on card
};
const dark = {
  canvas: [0, 0, 0, 0],
  plate: [0x12, 0x1a, 0x28, 0xff],
  border: [0x24, 0x2f, 0x42, 0xff],
  track: [0x3f, 0x4b, 0x5c, 0xff], // muted #93A5BD @35% on card
};

function makeCanvas() {
  return Buffer.alloc(PX * PX * 4);
}

function put(buf, x, y, c) {
  const i = (y * PX + x) * 4;
  buf[i] = c[0];
  buf[i + 1] = c[1];
  buf[i + 2] = c[2];
  buf[i + 3] = c[3];
}

/** 圆角矩形（dp 坐标，含边界判定） */
function roundRect(buf, x, y, w, h, r, c) {
  const x0 = Math.max(0, Math.floor(x * K));
  const x1 = Math.min(PX, Math.ceil((x + w) * K));
  const y0 = Math.max(0, Math.floor(y * K));
  const y1 = Math.min(PX, Math.ceil((y + h) * K));
  for (let py = y0; py < y1; py++) {
    const fy = (py + 0.5) / K;
    if (fy < y || fy > y + h) continue;
    for (let px = x0; px < x1; px++) {
      const fx = (px + 0.5) / K;
      if (fx < x || fx > x + w) continue;
      const cx = Math.min(Math.max(fx, x + r), x + w - r);
      const cy = Math.min(Math.max(fy, y + r), y + h - r);
      const dx = fx - cx;
      const dy = fy - cy;
      if (dx * dx + dy * dy > r * r) continue;
      put(buf, px, py, c);
    }
  }
}

function circle(buf, cx, cy, radius, c) {
  const x0 = Math.max(0, Math.floor((cx - radius) * K));
  const x1 = Math.min(PX, Math.ceil((cx + radius) * K));
  const y0 = Math.max(0, Math.floor((cy - radius) * K));
  const y1 = Math.min(PX, Math.ceil((cy + radius) * K));
  for (let py = y0; py < y1; py++) {
    const fy = (py + 0.5) / K;
    for (let px = x0; px < x1; px++) {
      const fx = (px + 0.5) / K;
      const dx = fx - cx;
      const dy = fy - cy;
      if (dx * dx + dy * dy > radius * radius) continue;
      put(buf, px, py, c);
    }
  }
}

// ---------- 几何（与 LaunchOverlay 同步） ----------
const PLATE = 80;
const RADIUS = 22;
const BORDER = 1;
const DOT = 12;
const DOT_X = 14;
const ROW_CY = [26, 40, 54];
const BAR_X = 31;
const BAR_H = 7;
const BAR_W = [30, 35, 24];

function render(colors) {
  const buf = makeCanvas();
  // 外圈边框 + 内层表面：1dp 均匀描边
  roundRect(buf, 0, 0, PLATE, PLATE, RADIUS, colors.border);
  roundRect(
    buf,
    BORDER,
    BORDER,
    PLATE - BORDER * 2,
    PLATE - BORDER * 2,
    RADIUS - BORDER,
    colors.plate,
  );
  for (let i = 0; i < ROW_CY.length; i++) {
    circle(buf, DOT_X + DOT / 2, ROW_CY[i], DOT / 2, colors.track);
    roundRect(buf, BAR_X, ROW_CY[i] - BAR_H / 2, BAR_W[i], BAR_H, BAR_H / 2, colors.track);
  }
  return downsample(buf);
}

/** 4×4 面积平均（预乘 alpha，避免透明边缘发黑） */
function downsample(buf) {
  const out = Buffer.alloc(OUT_PX * OUT_PX * 4);
  for (let y = 0; y < OUT_PX; y++) {
    for (let x = 0; x < OUT_PX; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const i = ((y * SS + sy) * PX + (x * SS + sx)) * 4;
          const al = buf[i + 3] / 255;
          r += buf[i] * al;
          g += buf[i + 1] * al;
          b += buf[i + 2] * al;
          a += buf[i + 3];
        }
      }
      const n = SS * SS;
      const i = (y * OUT_PX + x) * 4;
      const avgA = a / n;
      const norm = avgA > 0 ? avgA / 255 : 1;
      out[i] = Math.round(r / n / norm);
      out[i + 1] = Math.round(g / n / norm);
      out[i + 2] = Math.round(b / n / norm);
      out[i + 3] = Math.round(avgA);
    }
  }
  return { w: OUT_PX, h: OUT_PX, data: out };
}

// ---------- PNG 编码（同 gen-icons.mjs） ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function encodePNG(image) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(image.w, 0);
  ihdr.writeUInt32BE(image.h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc(image.h * (1 + image.w * 4));
  for (let y = 0; y < image.h; y++) {
    raw[y * (1 + image.w * 4)] = 0;
    image.data.copy(raw, y * (1 + image.w * 4) + 1, y * image.w * 4, (y + 1) * image.w * 4);
  }
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT, { recursive: true });
for (const [name, colors] of [
  ["splash-mark.png", light],
  ["splash-mark-dark.png", dark],
]) {
  const image = render(colors);
  const buf = encodePNG(image);
  writeFileSync(join(OUT, name), buf);
  console.log(`written: assets/${name} ${image.w}x${image.h} ${buf.length} bytes`);
}
