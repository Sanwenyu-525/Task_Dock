// 生成 Android 通知栏小图标：单色（纯白 + 透明）的「清单牌」品牌标记。
//
// 为什么不能直接用 assets/icon.png：Android 状态栏小图标只取 alpha 通道并整体染色，
// 彩色插画会被压成一块实心白色圆角方块。因此这里用与启动页同源的「清单牌」几何，
// 只保留白/透明两态，24dp 基准下笔画 ≥1.7dp，保证在状态栏尺寸仍可辨认。
//
// 大图标（通知展开后的右侧缩略图）仍用彩色 assets/icon.png，由 app.json 的
// expo-notifications 插件 largeIcon 提供，两者分工不同。
//
// 几何以 24dp 为基准（Android 通知图标标准画布），输出 8×（192px），
// 插件会按 mdpi…xxxhdpi 再缩到 24/36/48/72/96px。
//
// 用法：
//   node scripts/gen-notification-icon.mjs            写 assets/notification-icon.png
//   node scripts/gen-notification-icon.mjs --preview <dir>
//                                                     输出全部候选 + 对比预览图，供人工比选
//
// 零依赖：自行光栅化 + 编码 PNG（与 gen-icons.mjs / gen-splash.mjs 同一策略）。
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "assets");

const SIZE_DP = 24;
/** 输出 8×（xxxhdpi=4×，仍有 2× 余量）；4×4 超采样做抗锯齿 */
const OUT_PX = SIZE_DP * 8;
const SS = 4;
const PX = OUT_PX * SS;
const K = PX / SIZE_DP; // dp → 超采样像素

const WHITE = [0xff, 0xff, 0xff, 0xff];
const CLEAR = [0, 0, 0, 0];

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

/** 圆头线段（用点到线段的距离判定，端点自然成半圆） */
function capsule(buf, x1, y1, x2, y2, width, c) {
  const r = width / 2;
  const minX = Math.max(0, Math.floor((Math.min(x1, x2) - r) * K));
  const maxX = Math.min(PX, Math.ceil((Math.max(x1, x2) + r) * K));
  const minY = Math.max(0, Math.floor((Math.min(y1, y2) - r) * K));
  const maxY = Math.min(PX, Math.ceil((Math.max(y1, y2) + r) * K));
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  for (let py = minY; py < maxY; py++) {
    const fy = (py + 0.5) / K;
    for (let px = minX; px < maxX; px++) {
      const fx = (px + 0.5) / K;
      const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((fx - x1) * dx + (fy - y1) * dy) / lenSq));
      const qx = x1 + t * dx;
      const qy = y1 + t * dy;
      const ddx = fx - qx;
      const ddy = fy - qy;
      if (ddx * ddx + ddy * ddy > r * r) continue;
      put(buf, px, py, c);
    }
  }
}

/** 对勾三段（圆头），坐标按 24dp 基准 */
function checkMark(buf, points, width, c) {
  for (let i = 0; i < points.length - 1; i++) {
    capsule(buf, points[i][0], points[i][1], points[i + 1][0], points[i + 1][1], width, c);
  }
}

// ---------- 候选（24dp 基准） ----------

/** A：清单牌轮廓 + 三条「圆点 + 横条」，与启动页 brand 标记同构 */
function candidateListPlate(buf) {
  roundRect(buf, 2, 2, 20, 20, 5.2, WHITE);
  roundRect(buf, 3.7, 3.7, 16.6, 16.6, 3.6, CLEAR);
  const rows = [
    [7.6, 7.6],
    [12, 7.6],
    [16.4, 5.4],
  ];
  for (const [cy, w] of rows) {
    circle(buf, 6.3, cy, 1.05, WHITE);
    roundRect(buf, 9, cy - 0.95, w, 1.9, 0.95, WHITE);
  }
}

/** B：实心圆 + 对勾镂空（取自应用图标第一行「完成」圆） */
function candidateCheckCircle(buf) {
  circle(buf, 12, 12, 9.4, WHITE);
  checkMark(buf, [[6.9, 12.4], [10.6, 16.3], [17.3, 8.5]], 2.9, CLEAR);
}

/** C：实心圆角方块 + 对勾镂空（应用图标外轮廓剪影） */
function candidateCardCheck(buf) {
  roundRect(buf, 2, 2, 20, 20, 5.2, WHITE);
  checkMark(buf, [[7.2, 12.2], [10.6, 15.9], [16.8, 8.6]], 2.9, CLEAR);
}

/** D：清单牌轮廓 + 首行「完成圆」+ 两行横条（信息更全，24dp 风险高） */
function candidateListWithCheck(buf) {
  roundRect(buf, 2, 2, 20, 20, 5.2, WHITE);
  roundRect(buf, 3.7, 3.7, 16.6, 16.6, 3.6, CLEAR);
  circle(buf, 7.1, 8, 2.6, WHITE);
  checkMark(buf, [[5.9, 8.05], [6.8, 9.05], [8.4, 7]], 1.15, CLEAR);
  roundRect(buf, 11, 7.05, 6.2, 1.9, 0.95, WHITE);
  const rows = [
    [12.4, 7.6],
    [16, 5.4],
  ];
  for (const [cy, w] of rows) {
    circle(buf, 6.3, cy, 1.05, WHITE);
    roundRect(buf, 9, cy - 0.95, w, 1.9, 0.95, WHITE);
  }
}

const CANDIDATES = [
  ["a-list-plate", candidateListPlate],
  ["b-check-circle", candidateCheckCircle],
  ["c-card-check", candidateCardCheck],
  ["d-list-check", candidateListWithCheck],
];

// ---------- 降采样 / 编码 ----------

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

function render(draw) {
  const buf = makeCanvas();
  draw(buf);
  return downsample(buf);
}

// ---------- 预览合成（仅 --preview 时用） ----------

/** 最近邻缩放，保留 24dp 下的真实观感 */
function nearest(image, size) {
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sx = Math.floor((x * image.w) / size);
      const sy = Math.floor((y * image.h) / size);
      const si = (sy * image.w + sx) * 4;
      const di = (y * size + x) * 4;
      out[di] = image.data[si];
      out[di + 1] = image.data[si + 1];
      out[di + 2] = image.data[si + 2];
      out[di + 3] = image.data[si + 3];
    }
  }
  return { w: size, h: size, data: out };
}

/** 把图标按状态栏配色染色后贴在底色上（小图标只取 alpha，系统统一染色） */
function compose(icon, size, tint, bg) {
  const scaled = nearest(icon, size);
  const out = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const alpha = scaled.data[i * 4 + 3] / 255;
    const di = i * 4;
    out[di] = Math.round(bg[0] * (1 - alpha) + tint[0] * alpha);
    out[di + 1] = Math.round(bg[1] * (1 - alpha) + tint[1] * alpha);
    out[di + 2] = Math.round(bg[2] * (1 - alpha) + tint[2] * alpha);
    out[di + 3] = 255;
  }
  return { w: size, h: size, data: out };
}

function previewSheet(items) {
  const PAD = 12;
  const cells = [
    { size: 24, tint: [255, 255, 255], bg: [24, 26, 30] },
    { size: 24, tint: [28, 30, 34], bg: [244, 245, 247] },
    { size: 96, tint: [255, 255, 255], bg: [24, 26, 30] },
    { size: 96, tint: [28, 30, 34], bg: [244, 245, 247] },
  ];
  const CELL = Math.max(...cells.map((c) => c.size)) + PAD * 2;
  const W = CELL * cells.length;
  const H = CELL * items.length;
  const out = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    out[i * 4] = 40;
    out[i * 4 + 1] = 40;
    out[i * 4 + 2] = 40;
    out[i * 4 + 3] = 255;
  }
  const blit = (src, size, x0, y0) => {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const si = (y * size + x) * 4;
        const di = ((y0 + y) * W + x0 + x) * 4;
        out[di] = src.data[si];
        out[di + 1] = src.data[si + 1];
        out[di + 2] = src.data[si + 2];
        out[di + 3] = 255;
      }
    }
  };
  const fill = (x0, y0, w, h, color) => {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const di = ((y0 + y) * W + x0 + x) * 4;
        out[di] = color[0];
        out[di + 1] = color[1];
        out[di + 2] = color[2];
        out[di + 3] = 255;
      }
    }
  };
  items.forEach((item, row) => {
    cells.forEach((cell, col) => {
      const cellX = col * CELL;
      const cellY = row * CELL;
      fill(cellX, cellY, CELL, CELL, cell.bg);
      const icon = compose(item.image, cell.size, cell.tint, cell.bg);
      blit(icon, cell.size, cellX + (CELL - cell.size) / 2, cellY + (CELL - cell.size) / 2);
    });
  });
  return { w: W, h: H, data: out };
}

// ---------- 入口 ----------

const args = process.argv.slice(2);
if (args[0] === "--preview") {
  const dir = resolve(args[1] ?? ".");
  mkdirSync(dir, { recursive: true });
  const rendered = CANDIDATES.map(([name, draw]) => {
    const image = render(draw);
    writeFileSync(join(dir, `${name}.png`), encodePNG(image));
    return { name, image };
  });
  writeFileSync(join(dir, "preview.png"), encodePNG(previewSheet(rendered)));
  console.log(`preview written: ${dir} (${rendered.map((r) => r.name).join(", ")})`);
} else {
  // 正式图标：A 清单牌（与启动页骨架同构，24dp 下笔画最粗、结构最少）
  const image = render(candidateListPlate);
  const buf = encodePNG(image);
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "notification-icon.png"), buf);
  console.log(`written: assets/notification-icon.png ${image.w}x${image.h} ${buf.length} bytes`);
}
