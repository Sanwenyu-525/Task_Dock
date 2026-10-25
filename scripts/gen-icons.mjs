// Task Dock 图标生成器（零依赖：纯 Node PNG/ICO 编码）
// 用法: node scripts/gen-icons.mjs
// 产出: src-tauri/icons/{32x32,128x128,128x128@2x,icon.ico,tray.png} 及 status/*.png
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "src-tauri", "icons");
const SS = 4; // 超采样抗锯齿

// ---------- 基础绘图 ----------
function canvas(w, h) {
  return { w, h, data: new Uint8Array(w * h * 4) };
}
function setPx(c, x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= c.w || y >= c.h) return;
  const i = (y * c.w + x) * 4;
  // source-over 混合
  const sa = a / 255;
  const da = c.data[i + 3] / 255;
  const oa = sa + da * (1 - sa);
  if (oa === 0) return;
  c.data[i] = Math.round((r * sa + c.data[i] * da * (1 - sa)) / oa);
  c.data[i + 1] = Math.round((g * sa + c.data[i + 1] * da * (1 - sa)) / oa);
  c.data[i + 2] = Math.round((b * sa + c.data[i + 2] * da * (1 - sa)) / oa);
  c.data[i + 3] = Math.round(oa * 255);
}
function mix(c1, c2, t) {
  return [
    Math.round(c1[0] + (c2[0] - c1[0]) * t),
    Math.round(c1[1] + (c2[1] - c1[1]) * t),
    Math.round(c1[2] + (c2[2] - c1[2]) * t),
  ];
}
function fillRoundedRect(c, x0, y0, w, h, rad, colorFn) {
  const x1 = x0 + w;
  const y1 = y0 + h;
  for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
    for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      // 到圆角矩形符号距离（近似：采样四角）
      let dx = 0;
      let dy = 0;
      const cx = Math.min(Math.max(px, x0 + rad), x1 - rad);
      const cy = Math.min(Math.max(py, y0 + rad), y1 - rad);
      dx = px - cx;
      dy = py - cy;
      const inside = px >= x0 && px < x1 && py >= y0 && py < y1;
      if (!inside) continue;
      const d = Math.sqrt(dx * dx + dy * dy);
      const cov = Math.min(1, Math.max(0, rad - d + 0.5));
      if (cov <= 0) continue;
      const [r, g, b] = colorFn(px / c.w, py / c.h);
      setPx(c, x, y, r, g, b, Math.round(255 * cov));
    }
  }
}
function downscale(src, w, h) {
  const dst = canvas(w, h);
  const fx = src.w / w;
  const fy = src.h / h;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      const xa = Math.floor(x * fx);
      const xb = Math.min(src.w, Math.ceil((x + 1) * fx));
      const ya = Math.floor(y * fy);
      const yb = Math.min(src.h, Math.ceil((y + 1) * fy));
      for (let sy = ya; sy < yb; sy++) {
        for (let sx = xa; sx < xb; sx++) {
          const i = (sy * src.w + sx) * 4;
          r += src.data[i];
          g += src.data[i + 1];
          b += src.data[i + 2];
          a += src.data[i + 3];
          n++;
        }
      }
      const i = (y * w + x) * 4;
      dst.data[i] = r / n;
      dst.data[i + 1] = g / n;
      dst.data[i + 2] = b / n;
      dst.data[i + 3] = a / n;
    }
  }
  return dst;
}

// ---------- PNG 编码 ----------
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
function encodePNG(c) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(c.w, 0);
  ihdr.writeUInt32BE(c.h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc(c.h * (1 + c.w * 4));
  for (let y = 0; y < c.h; y++) {
    raw[y * (1 + c.w * 4)] = 0;
    c.data.subarray(y * c.w * 4, (y + 1) * c.w * 4).forEach((v, i) => {
      raw[y * (1 + c.w * 4) + 1 + i] = v;
    });
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

// ---------- 图标设计 ----------
const INDIGO = [79, 70, 229];
const VIOLET = [124, 58, 237];
const WHITE = [255, 255, 255];

// 应用主图标：圆角渐变方块 + 白色「程序坞」图形（三个方块 + 底部横条）
function drawAppIcon(bg) {
  const S = 1024 * SS;
  const c = canvas(S, S);
  const rad = (216 * SS);
  const grad = (x, y) => mix(INDIGO, VIOLET, y * 0.85 + x * 0.15);
  fillRoundedRect(c, 0, 0, S, S, rad, grad);
  // 三个白色圆角小方块（应用位）
  const sq = 132 * SS;
  const gap = 44 * SS;
  const total = sq * 3 + gap * 2;
  const sx = (S - total) / 2;
  const sy = 402 * SS;
  for (let i = 0; i < 3; i++) {
    fillRoundedRect(c, sx + i * (sq + gap), sy, sq, sq, 30 * SS, () => WHITE);
  }
  // 底部白色圆角横条（Dock 栏）
  const bw = 620 * SS;
  const bh = 104 * SS;
  fillRoundedRect(c, (S - bw) / 2, 640 * SS, bw, bh, 52 * SS, () => WHITE);
  return downscale(c, 1024, 1024);
}

// 托盘状态图标：彩色圆角方块 + 白色 Dock 图形
const STATUS_COLORS = {
  idle: [148, 163, 184],
  running: [245, 158, 11],
  waiting: [249, 115, 22],
  failed: [239, 68, 68],
  done: [34, 197, 94],
};
function drawStatusIcon(color) {
  const S = 1024 * SS;
  const c = canvas(S, S);
  fillRoundedRect(c, 0, 0, S, S, 216 * SS, () => color);
  const sq = 132 * SS;
  const gap = 44 * SS;
  const total = sq * 3 + gap * 2;
  const sx = (S - total) / 2;
  const sy = 402 * SS;
  for (let i = 0; i < 3; i++) {
    fillRoundedRect(c, sx + i * (sq + gap), sy, sq, sq, 30 * SS, () => WHITE);
  }
  const bw = 620 * SS;
  const bh = 104 * SS;
  fillRoundedRect(c, (S - bw) / 2, 640 * SS, bw, bh, 52 * SS, () => WHITE);
  return downscale(c, 1024, 1024);
}

// ICO 编码（PNG 压缩条目）
function encodeICO(images) {
  const count = images.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);
  let offset = 6 + count * 16;
  const dirs = [];
  const blobs = [];
  for (const img of images) {
    const png = encodePNG(img);
    const d = Buffer.alloc(16);
    d[0] = img.w >= 256 ? 0 : img.w;
    d[1] = img.h >= 256 ? 0 : img.h;
    d[2] = 0;
    d[3] = 0;
    d.writeUInt16LE(1, 4);
    d.writeUInt16LE(32, 6);
    d.writeUInt32LE(png.length, 8);
    d.writeUInt32LE(offset, 12);
    dirs.push(d);
    blobs.push(png);
    offset += png.length;
  }
  return Buffer.concat([header, ...dirs, ...blobs]);
}

// ---------- 生成 ----------
mkdirSync(join(OUT, "status"), { recursive: true });
const master = drawAppIcon();
const files = [
  ["32x32.png", encodePNG(downscale(master, 32, 32))],
  ["128x128.png", encodePNG(downscale(master, 128, 128))],
  ["128x128@2x.png", encodePNG(downscale(master, 256, 256))],
  ["tray.png", encodePNG(downscale(master, 32, 32))],
  ["icon.ico", encodeICO([16, 32, 48, 256].map((s) => downscale(master, s, s)))],
];
for (const [name, buf] of files) {
  writeFileSync(join(OUT, name), buf);
  console.log("written:", name, buf.length, "bytes");
}
for (const [name, color] of Object.entries(STATUS_COLORS)) {
  const s = drawStatusIcon(color);
  const png = downscale(s, 32, 32);
  writeFileSync(join(OUT, "status", `${name}.png`), encodePNG(png));
  console.log("written: status/" + name + ".png");
}
console.log("icons done ->", OUT);
