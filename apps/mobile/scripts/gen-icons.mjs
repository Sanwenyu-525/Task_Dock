// 生成手机端图标：直接以桌面端真实图标（src-tauri/icons/icon.png，1024×1024）为源。
//
// 桌面图标是「清单 + 机器人」插画，自带圆角卡片与白底；Android 自适应图标由启动器施加遮罩，
// 所以拆成：
//   icon.png                 传统图标（Android 7 及以下/商店）：与桌面图标逐字节一致
//   adaptive-foreground.png  透明前景：整张插画缩到 78% 居中，避免被启动器裁掉内容
//   adaptive-background.png  纯色背景：取插画自身的底色，与前景无缝衔接
//
// 零依赖：自行解码 PNG（zlib + 反滤波），不引入 sharp/canvas。
import { inflateSync, deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, "..");
const OUT = join(APP, "assets");
const SRC = join(APP, "..", "..", "src-tauri", "icons", "icon.png");

// ---------- PNG 解码（8bit，colorType 2/6，非隔行） ----------
function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("不是 PNG");
  let off = 8;
  let w = 0;
  let h = 0;
  let colorType = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      if (data[8] !== 8) throw new Error("仅支持 8bit");
      colorType = data[9];
      if (data[12] !== 0) throw new Error("不支持隔行 PNG");
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    off += 12 + len;
  }
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!bpp) throw new Error(`不支持的 colorType ${colorType}`);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const out = Buffer.alloc(w * h * 4);
  let prev = Buffer.alloc(stride);

  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (filter === 1) v = (v + a) & 255;
      else if (filter === 2) v = (v + b) & 255;
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 255;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      } else if (filter !== 0) throw new Error(`未知滤波 ${filter}`);
      cur[x] = v;
    }
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      out[i] = cur[x * bpp];
      out[i + 1] = cur[x * bpp + 1];
      out[i + 2] = cur[x * bpp + 2];
      out[i + 3] = bpp === 4 ? cur[x * bpp + 3] : 255;
    }
    prev = cur;
  }
  return { w, h, data: out };
}

// ---------- 缩放（面积平均，预乘 alpha 防黑边） ----------
function resample(src, dw, dh) {
  const dst = Buffer.alloc(dw * dh * 4);
  const fx = src.w / dw;
  const fy = src.h / dh;
  for (let y = 0; y < dh; y++) {
    const y0 = y * fy;
    const y1 = (y + 1) * fy;
    for (let x = 0; x < dw; x++) {
      const x0 = x * fx;
      const x1 = (x + 1) * fx;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy++) {
        for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx++) {
          const i = (sy * src.w + sx) * 4;
          const al = src.data[i + 3] / 255;
          r += src.data[i] * al;
          g += src.data[i + 1] * al;
          b += src.data[i + 2] * al;
          a += src.data[i + 3];
          n++;
        }
      }
      const i = (y * dw + x) * 4;
      const avgA = a / n;
      const norm = avgA > 0 ? avgA / 255 : 1;
      dst[i] = Math.round(r / n / norm);
      dst[i + 1] = Math.round(g / n / norm);
      dst[i + 2] = Math.round(b / n / norm);
      dst[i + 3] = Math.round(avgA);
    }
  }
  return { w: dw, h: dh, data: dst };
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

// ---------- 组合 ----------
const SIZE = 1024;
/** 插画在自适应前景里的占比：留边避免被启动器遮罩裁掉内容 */
const ART_RATIO = 0.78;

const art = decodePNG(readFileSync(SRC));
if (art.w !== SIZE || art.h !== SIZE) throw new Error(`源图标应为 ${SIZE}×${SIZE}，实际 ${art.w}×${art.h}`);

// 取插画自身底色（卡片内、顶部中间的一条），用于自适应背景，保证前景与背景无缝
function sampleBackground() {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  // 卡片圆角外侧是透明的，取样带要落在卡片内部（y≈70 已越过圆角）
  for (let y = 60; y < 90; y++) {
    for (let x = 300; x < 724; x++) {
      const i = (y * art.w + x) * 4;
      if (art.data[i + 3] < 250) continue;
      r += art.data[i];
      g += art.data[i + 1];
      b += art.data[i + 2];
      n++;
    }
  }
  if (n === 0) {
    const i = (512 * art.w + 512) * 4;
    return [art.data[i], art.data[i + 1], art.data[i + 2]];
  }
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}

function hex([r, g, b]) {
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

// 前景：透明画布 + 居中缩放的插画
function renderForeground() {
  const inner = Math.round(SIZE * ART_RATIO);
  const scaled = resample(art, inner, inner);
  const data = Buffer.alloc(SIZE * SIZE * 4);
  const off = Math.round((SIZE - inner) / 2);
  for (let y = 0; y < inner; y++) {
    scaled.data.copy(data, ((y + off) * SIZE + off) * 4, y * inner * 4, (y + 1) * inner * 4);
  }
  return { w: SIZE, h: SIZE, data };
}

// 背景：纯色（颜色取自插画底色）
function renderBackground(color) {
  const data = Buffer.alloc(SIZE * SIZE * 4);
  for (let i = 0; i < SIZE * SIZE; i++) {
    data[i * 4] = color[0];
    data[i * 4 + 1] = color[1];
    data[i * 4 + 2] = color[2];
    data[i * 4 + 3] = 255;
  }
  return { w: SIZE, h: SIZE, data };
}

mkdirSync(OUT, { recursive: true });

// 传统图标：原样复制桌面图标，保证与桌面端完全一致
const legacyBytes = readFileSync(SRC);
writeFileSync(join(OUT, "icon.png"), legacyBytes);

const bg = sampleBackground();
const outputs = [
  ["adaptive-foreground.png", renderForeground()],
  ["adaptive-background.png", renderBackground(bg)],
];
for (const [name, image] of outputs) {
  const buf = encodePNG(image);
  writeFileSync(join(OUT, name), buf);
  console.log(`written: assets/${name} ${image.w}x${image.h} ${buf.length} bytes`);
}

console.log(`written: assets/icon.png ${legacyBytes.length} bytes（源图标逐字节复制）`);
console.log(`adaptive 背景色: ${hex(bg)}`);
