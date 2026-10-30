// 一次性验收桥：通过 CDP 在 Task Dock WebView2 / Edge 页面上执行真实操作。
// 用法：
//   node cdp-bridge.mjs invoke <port> <command> '<jsonArgs>'
//   node cdp-bridge.mjs edge-click <port> <title>
//   node cdp-bridge.mjs edge-dump <port> <title>
import { chromium } from 'playwright';

const [, , action, portArg, ...rest] = process.argv;
const port = Number(portArg);

function fail(message) {
  process.stdout.write(JSON.stringify({ ok: false, error: message }));
  process.exit(2);
}

async function connect() {
  try {
    return await chromium.connectOverCDP(`http://127.0.0.1:${port}`, {
      timeout: 15000,
    });
  } catch (err) {
    fail(`CDP connect failed: ${String(err && err.message ? err.message : err)}`);
  }
}

async function findAppPage(browser) {
  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      const url = page.url();
      if (!url.startsWith('devtools://')) return page;
    }
  }
  return null;
}

async function findEdgePage(browser, titlePart) {
  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      try {
        const title = await page.title();
        if (title.includes(titlePart)) return page;
      } catch {
        // 页面切换中，忽略
      }
    }
  }
  return null;
}

if (action === 'invoke') {
  const command = rest[0];
  const args = rest[1] ? JSON.parse(rest[1]) : {};
  const browser = await connect();
  const page = await findAppPage(browser);
  if (!page) fail('app page not found');
  const result = await page.evaluate(
    async ({ command, args }) => {
      const internals = window.__TAURI_INTERNALS__;
      if (!internals || typeof internals.invoke !== 'function') {
        return {
          ok: false,
          error: 'window.__TAURI_INTERNALS__.invoke not available',
          href: location.href,
        };
      }
      try {
        return { ok: true, value: await internals.invoke(command, args) };
      } catch (err) {
        return { ok: false, error: String(err && err.message ? err.message : err) };
      }
    },
    { command, args },
  );
  process.stdout.write(JSON.stringify(result));
  process.exit(result.ok ? 0 : 2);
}

const titlePart = rest[0] || 'TaskDock Paste Acceptance';

if (action === 'edge-click') {
  const browser = await connect();
  const page = await findEdgePage(browser, titlePart);
  if (!page) fail('edge page not found');
  await page.bringToFront();
  await page.click('#editor', { position: { x: 30, y: 30 } });
  const state = await page.evaluate(() => ({
    title: document.title,
    activeId: document.activeElement ? document.activeElement.id : null,
    focused: document.hasFocus(),
  }));
  process.stdout.write(JSON.stringify({ ok: true, ...state }));
  process.exit(0);
}

if (action === 'edge-dump') {
  const browser = await connect();
  const page = await findEdgePage(browser, titlePart);
  if (!page) fail('edge page not found');
  const dump = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const editor = document.querySelector('#editor');
    if (!editor) return { error: 'editor missing' };

    // 等待粘贴异步解码完成：DOM 结构与图片尺寸连续 500ms 稳定。
    let lastKey = '';
    let stableSince = 0;
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const images = Array.from(editor.querySelectorAll('img'));
      const key = `${editor.childNodes.length}:${images
        .map((img) => `${img.complete}:${img.naturalWidth}x${img.naturalHeight}`)
        .join(',')}`;
      const imagesReady = images.every((img) => img.complete);
      if (key === lastKey) {
        if (!stableSince) stableSince = Date.now();
        if (imagesReady && Date.now() - stableSince >= 500) break;
      } else {
        lastKey = key;
        stableSince = 0;
      }
      await sleep(100);
    }

    function sampleImage(img, index) {
      const width = img.naturalWidth;
      const height = img.naturalHeight;
      if (!width || !height) {
        return { index, error: 'natural size is zero', complete: img.complete };
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      let data;
      try {
        ctx.drawImage(img, 0, 0);
        data = ctx.getImageData(0, 0, width, height).data;
      } catch (err) {
        return { index, error: String(err) };
      }
      const pixel = (x, y) => {
        const i = (Math.floor(y) * width + Math.floor(x)) * 4;
        return [data[i], data[i + 1], data[i + 2], data[i + 3]];
      };
      let alphaMin = 255;
      let alphaMax = 0;
      let transparentPixels = 0;
      let opaquePixels = 0;
      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      for (let i = 0; i < data.length; i += 4) {
        const alpha = data[i + 3];
        if (alpha < alphaMin) alphaMin = alpha;
        if (alpha > alphaMax) alphaMax = alpha;
        if (alpha === 0) transparentPixels += 1;
        if (alpha > 0) {
          sumR += data[i];
          sumG += data[i + 1];
          sumB += data[i + 2];
          opaquePixels += 1;
        }
      }
      const rect = img.getBoundingClientRect();
      const style = getComputedStyle(img);
      return {
        index,
        complete: img.complete,
        naturalWidth: width,
        naturalHeight: height,
        renderedWidth: Math.round(rect.width),
        renderedHeight: Math.round(rect.height),
        visible:
          rect.width > 0 &&
          rect.height > 0 &&
          style.visibility !== 'hidden' &&
          Number(style.opacity) > 0 &&
          style.display !== 'none',
        alphaMin,
        alphaMax,
        transparentPixels,
        opaquePixels,
        avgRgb: opaquePixels
          ? [
              Math.round(sumR / opaquePixels),
              Math.round(sumG / opaquePixels),
              Math.round(sumB / opaquePixels),
            ]
          : null,
        samples: {
          center: pixel(width / 2, height / 2),
          topLeft: pixel(2, 2),
          topRight: pixel(width - 3, 2),
          bottomLeft: pixel(2, height - 3),
          bottomRight: pixel(width - 3, height - 3),
        },
        srcPrefix: img.src.slice(0, 48),
        srcLength: img.src.length,
      };
    }

    const images = [];
    const flat = [];
    let imageIndex = 0;
    function walk(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent || '';
        if (text.trim()) flat.push({ type: 'text', text });
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const el = node;
      if (el.tagName === 'IMG') {
        const sample = sampleImage(el, imageIndex);
        images.push(sample);
        flat.push({ type: 'image', imageIndex: sample.index });
        imageIndex += 1;
        return;
      }
      if (el.tagName === 'BR') return;
      const childImages = Array.from(el.querySelectorAll('img'));
      if (childImages.length === 0) {
        const text = (el.textContent || '').trim();
        if (text) flat.push({ type: 'text', text });
        return;
      }
      for (const child of Array.from(el.childNodes)) walk(child);
    }
    for (const child of Array.from(editor.childNodes)) walk(child);

    return {
      title: document.title,
      hasFocus: document.hasFocus(),
      activeId: document.activeElement ? document.activeElement.id : null,
      childCount: editor.childNodes.length,
      imageCount: editor.querySelectorAll('img').length,
      textContent: editor.textContent,
      flatOrder: flat,
      images,
      html: editor.innerHTML
        .replace(/data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]+/g, 'data:image/REDACTED')
        .slice(0, 2000),
    };
  });
  process.stdout.write(JSON.stringify({ ok: true, value: dump }));
  process.exit(0);
}

fail(`unknown action: ${action}`);
