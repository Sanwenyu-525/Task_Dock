// 图标位图生成器（正式工程脚本）。
//
// 输入：src/components/icons/iconMap.json（语义名 → lucide 名称）
// 几何：仓库根 node_modules/lucide-react/dist/esm/icons（桌面端已有依赖，不新增包）
// 输出：src/components/icons/iconAssets.g.ts（单色透明 PNG data URI）
//
// 为什么是构建期位图而不是运行时 SVG：
// - react-native-svg 是原生模块，本机内存不足以重建 APK；字体图标同样要改 resources.arsc；
// - 因此用 Chromium 把 lucide 矢量几何栅格化，运行时只做 tintColor 单色着色；
// - 语义表与 AppIcon API 保持不变，将来能跑原生构建时可平滑换回矢量。
//
// 环境要求（均为仓库已有开发依赖，不需要 npm install 新包）：
// - 仓库根已安装 playwright 与 lucide-react；
// - Playwright 的 Chromium 已下载（npx playwright install chromium）。
//
// 用法：
//   node scripts/gen-ui-icons.mjs          # 生成
//   node scripts/gen-ui-icons.mjs --check  # 只校验生成物是否最新，不写文件
//
// 所有路径都基于脚本位置解析，不依赖盘符、用户名或临时验收目录。
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "..");
const REPO = path.resolve(APP, "../..");
const MAP_FILE = path.join(APP, "src/components/icons/iconMap.json");
const OUT_FILE = path.join(APP, "src/components/icons/iconAssets.g.ts");

function findLucide() {
  const candidates = [
    path.join(APP, "node_modules/lucide-react/dist/esm/icons"),
    path.join(REPO, "node_modules/lucide-react/dist/esm/icons"),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "house.js"))) return dir;
  }
  throw new Error(
    `找不到 lucide 图标几何。已查找：\n  ${candidates.join("\n  ")}\n` +
      `请在仓库根安装依赖（lucide-react 是桌面端已有依赖）。`,
  );
}

function findChromium() {
  const roots = [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "ms-playwright") : null,
    path.join(os.homedir(), ".cache/ms-playwright"),
  ].filter(Boolean);
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const versions = fs
      .readdirSync(root)
      .filter((name) => /^chromium-\d+$/.test(name))
      .sort()
      .reverse();
    for (const version of versions) {
      const exe =
        process.platform === "win32"
          ? path.join(root, version, "chrome-win64/chrome.exe")
          : path.join(root, version, "chrome-linux/chrome");
      if (fs.existsSync(exe)) return exe;
    }
  }
  return null;
}

const LUCIDE = findLucide();
const source = JSON.parse(fs.readFileSync(MAP_FILE, "utf8"));
const map = source.map;
const small = source.small ?? [];
const large = source.large ?? [];
const overrides = source.overrides ?? {};

const names = Object.keys(map).sort();
const missing = names.filter(
  (name) =>
    !overrides[name] && !fs.existsSync(path.join(LUCIDE, `${map[name]}.js`)),
);
if (missing.length > 0) {
  throw new Error(
    `iconMap.json 引用了不存在的 lucide 图标：${missing
      .map((name) => `${name} → ${map[name]}`)
      .join(", ")}`,
  );
}

// 映射指纹：测试会重算这个值，拦住「改了 iconMap 却忘记重新生成」。
const canonical = JSON.stringify({
  map: Object.fromEntries(Object.entries(map).sort(([a], [b]) => a.localeCompare(b))),
  small: [...small].sort(),
  large: [...large].sort(),
  overrides: Object.fromEntries(
    Object.entries(overrides)
      .filter(([name]) => name !== "_comment")
      .sort(([a], [b]) => a.localeCompare(b)),
  ),
});
const MAP_HASH = createHash("sha256").update(canonical).digest("hex").slice(0, 16);

const VARIANTS = {
  md: { px: 96, sw: 2 },
  sm: { px: 64, sw: 1.5 },
  lg: { px: 128, sw: 1.5 },
};

function nodesOf(lucideName, override) {
  if (override) return override;
  const src = fs.readFileSync(path.join(LUCIDE, `${lucideName}.js`), "utf8");
  const match = src.match(/createLucideIcon\("[^"]+",\s*(\[[\s\S]*?\])\s*\);/);
  if (!match) throw new Error(`无法解析 lucide 图标源码：${lucideName}`);
  return new Function(`return ${match[1]}`)();
}

function svgOf(nodes, px, sw) {
  const body = nodes
    .map(([tag, attrs]) => {
      const pairs = Object.entries(attrs)
        .filter(([key]) => key !== "key")
        .map(([key, value]) => `${key}="${String(value).replace(/"/g, "&quot;")}"`)
        .join(" ");
      return `<${tag} ${pairs} />`;
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 24 24" fill="none" stroke="#000000" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
}

async function generate() {
  let browser;
  try {
    browser = await chromium.launch();
  } catch (error) {
    const executablePath = findChromium();
    if (!executablePath) {
      throw new Error(
        `Playwright 无法启动 Chromium，也没有找到本地安装：${String(error)}\n` +
          `请先执行 npx playwright install chromium。`,
      );
    }
    browser = await chromium.launch({ executablePath });
  }

  const page = await browser.newPage({ viewport: { width: 200, height: 200 } });
  await page.setContent(
    `<!doctype html><html><head><style>html,body{margin:0;background:transparent}#box{display:block}</style></head><body><div id="box"></div></body></html>`,
  );

  const cache = new Map();
  async function pngBase64(semanticName, lucideName, variant) {
    const key = `${semanticName}:${variant}`;
    if (cache.has(key)) return cache.get(key);
    const { px, sw } = VARIANTS[variant];
    const markup = svgOf(nodesOf(lucideName, overrides[semanticName]), px, sw);
    await page.evaluate(
      ({ html, size }) => {
        const box = document.getElementById("box");
        box.style.width = `${size}px`;
        box.style.height = `${size}px`;
        box.innerHTML = html;
      },
      { html: markup, size: px },
    );
    const element = await page.$("#box");
    if (!element) throw new Error("生成器内部错误：找不到栅格化容器");
    const buffer = await element.screenshot({ omitBackground: true });
    const base64 = buffer.toString("base64");
    cache.set(key, base64);
    return base64;
  }

  const out = {};
  let totalBytes = 0;
  for (const name of names) {
    const lucideName = map[name];
    const variants = ["md"];
    if (small.includes(name)) variants.push("sm");
    if (large.includes(name)) variants.push("lg");
    out[name] = {};
    for (const variant of variants) {
      const base64 = await pngBase64(name, lucideName, variant);
      out[name][variant] = `data:image/png;base64,${base64}`;
      totalBytes += Math.round((base64.length * 3) / 4);
    }
  }
  await browser.close();

  const header = `// AUTO-GENERATED — 不要手改。生成器：apps/mobile/scripts/gen-ui-icons.mjs
// 几何来源：仓库已有的 lucide 图标（node_modules/lucide-react，ISC），见 iconMap.json。
// 所有图标为单色透明 PNG，运行时由 AppIcon 用 tintColor 着色：md 96px / sm 64px / lg 128px。
// ICON_MAP_HASH 是映射内容的指纹；改 iconMap.json 后必须重跑 npm run icons:generate。
/* eslint-disable */
export type IconBitmap = { md: string; sm?: string; lg?: string };
export const ICON_MAP_HASH = "${MAP_HASH}";
export const ICON_BITMAP: Record<string, IconBitmap> = `;

  return {
    content: `${header}${JSON.stringify(out, null, 0)};\n`,
    stats: {
      icons: names.length,
      variants: Object.values(out).reduce((total, value) => total + Object.keys(value).length, 0),
      rawBytes: totalBytes,
    },
  };
}

const { content, stats } = await generate();

if (process.argv.includes("--check")) {
  const current = fs.existsSync(OUT_FILE) ? fs.readFileSync(OUT_FILE, "utf8") : "";
  if (current !== content) {
    console.error("图标资源不是最新：请运行 npm run icons:generate 后重新提交。");
    process.exitCode = 1;
  } else {
    console.log(`icons up to date: ${stats.icons} icons / ${stats.variants} variants`);
  }
} else {
  fs.writeFileSync(OUT_FILE, content, "utf8");
  console.log(`icons: ${stats.icons}, variants: ${stats.variants}`);
  console.log(`raw png total: ${(stats.rawBytes / 1024).toFixed(1)} KB`);
  console.log(`written: ${path.relative(REPO, OUT_FILE)} (${(content.length / 1024).toFixed(1)} KB)`);
}
