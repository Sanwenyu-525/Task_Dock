//! 主窗口启动占位的静态守卫：模块脚本再慢/再失败，窗口也不能是空白页。
//!
//! 看门狗必须写在 `main.tsx` 之前（经典脚本），否则模块图加载失败时没有任何
//! 代码能显示占位或上报启动超时；这里的断言锁定这一顺序契约。
//!
//! 2026-11-12 启动体验 V1（tmp/acceptance/startup-experience-v1/BOOT_PROTOCOL.md
//! §2/§6/§7）：看门狗迁至 public/boot/boot-watchdog.js 并扩展四态状态机
//! （boot/slow/timeout/error），index.html 提供主题提示读取器、骨架屏、恢复卡与
//! 「死人在场」保险；阈值常量与 src/boot/bootProtocol.ts 跨文件锁定一致。

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { BOOT_SLOW_MS, BOOT_TIMEOUT_MS } from "../boot/bootProtocol";
import { BOOT_SPLASH_MARKER, injectBootSplashCss, readBootSplashCss } from "../boot/bootSplashInline";

const html = readFileSync(resolve(process.cwd(), "index.html"), "utf8");
/** 样式本体（单一来源）。CSS 相关断言看它；DOM 断言看源 HTML。
 *  两宿主的渲染结果由 vite 插件在 dev/build 时内联，见 bootSplashInline.ts。 */
const bootCssSource = readBootSplashCss();
/** 注入后的渲染结果：涉及 `#boot-splash[data-state=…]` 这类样式选择器时用它。 */
const htmlWithStyles = injectBootSplashCss(html, bootCssSource);
const moduleEntryAt = html.indexOf('src="/src/main.tsx"');
const watchdogTagAt = html.indexOf('<script src="/boot/boot-watchdog.js">');

describe("index.html 启动占位", () => {
  it("在主模块之前提供可见的启动占位与重试入口", () => {
    const splashAt = html.indexOf('id="boot-splash"');
    const retryAt = html.indexOf('id="boot-retry"');
    expect(splashAt).toBeGreaterThan(-1);
    expect(retryAt).toBeGreaterThan(-1);
    expect(splashAt).toBeLessThan(moduleEntryAt);
    expect(retryAt).toBeLessThan(moduleEntryAt);
  });

  it("启动看门狗先于模块安装，并能在模块未执行时上报启动超时", () => {
    const bootAt = html.indexOf("__TASK_DOCK_BOOT__");
    const reportAt = html.indexOf("diagnostics_record");
    expect(bootAt).toBeGreaterThan(-1);
    expect(reportAt).toBeGreaterThan(-1);
    expect(html).toContain("UI_BOOT_TIMEOUT");
    expect(bootAt).toBeLessThan(moduleEntryAt);
    expect(reportAt).toBeLessThan(moduleEntryAt);
  });
});

describe("index.html 启动体验 V1（协议 §2/§6/§7）", () => {
  it("主题提示读取器先于占位样式执行，且只接受白名单取值", () => {
    const hintAt = html.indexOf("taskdock.boot-theme");
    const styleAt = html.indexOf("<style>");
    expect(hintAt).toBeGreaterThan(-1);
    expect(styleAt).toBeGreaterThan(-1);
    expect(hintAt).toBeLessThan(styleAt);
    expect(html).toContain('hintTheme === "light"');
    expect(html).toContain('hintTheme === "dark"');
    expect(html).toContain('hintPreset === "frosted"');
    expect(html).toContain('hintPreset === "dream-gradient"');
  });

  it("四态占位具备完整 DOM 契约（骨架屏/恢复卡/等待/复制/原因行）", () => {
    for (const id of ["boot-skeleton", "boot-recovery", "boot-wait", "boot-copy", "boot-detail"]) {
      expect(html).toContain(`id="${id}"`);
    }
    for (const state of ["boot", "slow", "timeout", "error"]) {
      expect(htmlWithStyles).toContain(`data-state="${state}"`);
    }
  });

  it("外部看门狗脚本先于模块脚本加载", () => {
    expect(watchdogTagAt).toBeGreaterThan(-1);
    expect(watchdogTagAt).toBeLessThan(moduleEntryAt);
  });

  it("死人在场保险：watchdog 缺失时 20s 后强制撤下占位", () => {
    const deadManAt = html.indexOf("死人在场保险");
    expect(deadManAt).toBeGreaterThan(-1);
    expect(deadManAt).toBeGreaterThan(watchdogTagAt);
    expect(html).toContain("20000");
    expect(html).toContain("is-leaving");
    expect(html).toContain("removeChild");
  });
});

describe("启动阈值跨文件同步（协议 §2）", () => {
  it("watchdog 阈值与 bootProtocol 常量一致，index.html 不再内联旧阈值", () => {
    const watchdogPath = resolve(process.cwd(), "public/boot/boot-watchdog.js");
    expect(
      existsSync(watchdogPath),
      "public/boot/boot-watchdog.js 尚未落地（子智能体 A 的产出，属跨智能体时序，非本文件缺陷）",
    ).toBe(true);
    const watchdog = readFileSync(watchdogPath, "utf8");
    expect(watchdog).toContain(String(BOOT_SLOW_MS));
    expect(watchdog).toContain(String(BOOT_TIMEOUT_MS));
    // 旧内联看门狗的 4s/15s 阈值逻辑已迁出，index.html 只保留 20s 死人在场保险
    expect(html).not.toContain("4000");
    expect(html).not.toContain("15000");
  });
});

/* ── 工作台窗口（workspace.html）启动占位 ──
 * 背景：工作台窗口隐藏创建，8s 未收到前端就绪即强制显示；workspace.html
 * 此前只有 #root，React 未挂载时用户看到纯白窗口（2026-11-17 实测截图）。
 * 这里锁定与主窗口同一份看门狗、同一组恢复入口的静态契约。 */
const workspaceHtml = readFileSync(resolve(process.cwd(), "workspace.html"), "utf8");
const workspaceHtmlWithStyles = injectBootSplashCss(workspaceHtml, bootCssSource);
// 2026-11-19 启动诊断升级：入口由 main.tsx 改为极轻量 bootstrap.ts，
// 再由 bootstrap 动态 import("./main")。契约锚点随之指向新入口。
const workspaceModuleAt = workspaceHtml.indexOf(
  'src="/src/workspace/bootstrap.ts"',
);
const workspaceWatchdogAt = workspaceHtml.indexOf('<script src="/boot/boot-watchdog.js">');

describe("workspace.html 工作台启动占位", () => {
  it("在主模块之前提供可见占位与三个恢复入口", () => {
    const splashAt = workspaceHtml.indexOf('id="boot-splash"');
    const retryAt = workspaceHtml.indexOf('id="boot-retry"');
    const waitAt = workspaceHtml.indexOf('id="boot-wait"');
    const copyAt = workspaceHtml.indexOf('id="boot-copy"');
    expect(splashAt).toBeGreaterThan(-1);
    expect(retryAt).toBeGreaterThan(-1);
    expect(waitAt).toBeGreaterThan(-1);
    expect(copyAt).toBeGreaterThan(-1);
    expect(splashAt).toBeLessThan(workspaceModuleAt);
    expect(retryAt).toBeLessThan(workspaceModuleAt);
    expect(workspaceHtml).toContain('id="boot-detail"');
  });

  it("恢复卡四态可见性由 data-state 驱动（boot/slow/timeout/error）", () => {
    for (const state of ["boot", "slow", "timeout", "error"]) {
      expect(workspaceHtmlWithStyles).toContain(`data-state="${state}"`);
    }
    expect(workspaceHtmlWithStyles).toContain('#boot-splash[data-state="timeout"] #boot-recovery');
  });

  it("主题提示读取器先于占位样式执行，且只接受白名单取值", () => {
    const hintAt = workspaceHtml.indexOf("taskdock.boot-theme");
    const styleAt = workspaceHtml.indexOf("<style>");
    expect(hintAt).toBeGreaterThan(-1);
    expect(styleAt).toBeGreaterThan(-1);
    expect(hintAt).toBeLessThan(styleAt);
    expect(workspaceHtml).toContain('hintTheme === "light"');
    expect(workspaceHtml).toContain('hintTheme === "dark"');
    expect(workspaceHtml).toContain('hintPreset === "frosted"');
    expect(workspaceHtml).toContain('hintPreset === "dream-gradient"');
  });

  it("外部看门狗先于模块脚本加载，并保留 20s 死人在场保险", () => {
    expect(workspaceWatchdogAt).toBeGreaterThan(-1);
    expect(workspaceWatchdogAt).toBeLessThan(workspaceModuleAt);
    const deadManAt = workspaceHtml.indexOf("死人在场保险");
    expect(deadManAt).toBeGreaterThan(workspaceWatchdogAt);
    expect(workspaceHtml).toContain("20000");
    expect(workspaceHtml).toContain("removeChild");
  });

  it("入口链是 watchdog → bootstrap.ts，bootstrap 再动态 import main", () => {
    expect(workspaceModuleAt).toBeGreaterThan(-1);
    expect(workspaceWatchdogAt).toBeLessThan(workspaceModuleAt);
    expect(workspaceHtml).toContain("bootstrap.ts");
  });
});

/* ── 2026-11-24 启动体验专项：布局契约（垂直截断 / 短高度 / 两宿主同源） ──
 * 样式自 2026-11-24 起只有一份 `src/boot/bootSplashCss.css`，由 vite 插件
 * （`src/boot/bootSplashInline.ts`）在 dev/build 的 transformIndexHtml 阶段内联进两个
 * 宿主的 `<style>`。因此这里锁定三件事：（a）HTML 里只留注入标记、不再手抄规则；
 * （b）注入后两宿主拿到逐字相同的样式；（c）样式本体满足布局契约。
 * jsdom 不能证明布局，真实几何与「按钮是否可点」由 Playwright 在 264×112 … 960×600
 * 六个尺寸 + 明暗两主题取证（tmp/acceptance/boot-home-responsive/）。 */
/** 去掉 CSS 注释再断言：契约里的「旧写法」说明会提到被禁止的写法本身。 */
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const sharedCss = stripComments(bootCssSource);
/** 取页面里唯一 <style> 的内容（注入后应等于样式本体）。 */
const styleBlock = (source: string) => {
  const blocks = [...source.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
  expect(blocks, "每个宿主应恰好一个 <style>").toHaveLength(1);
  return blocks[0];
};

describe("启动占位样式单一来源（两宿主同源）", () => {
  it("两个 HTML 只留注入标记，不再各自手抄一份规则", () => {
    for (const [name, source] of [
      ["index.html", html],
      ["workspace.html", workspaceHtml],
    ] as const) {
      expect(styleBlock(source), `${name} 的 <style> 应含注入标记`).toContain(BOOT_SPLASH_MARKER);
      expect(source.split(BOOT_SPLASH_MARKER).length - 1, `${name} 标记应唯一`).toBe(1);
      // 规则本体不得写回 HTML：否则又变成两份需要手工同步的副本。
      expect(stripComments(styleBlock(source)), `${name} 不应再写具体规则`).not.toContain("#boot-splash");
    }
  });

  it("注入后两宿主拿到逐字相同的样式，缺标记直接抛错（不产出无样式占位）", () => {
    const indexCss = styleBlock(injectBootSplashCss(html, bootCssSource));
    const workspaceCss = styleBlock(injectBootSplashCss(workspaceHtml, bootCssSource));
    expect(indexCss).toBe(workspaceCss);
    expect(indexCss).toContain(bootCssSource.trim());
    expect(indexCss).not.toContain(BOOT_SPLASH_MARKER);
    expect(indexCss).toContain("#boot-splash {");
    expect(() => injectBootSplashCss("<html><body></body></html>", bootCssSource)).toThrow(/标记/);
  });

  it("正常高度视觉居中但不裁剪顶部（auto 外边距 + 顶部对齐 + 纵向滚动）", () => {
    // 只看 #boot-splash 自身的规则：短高度档位里 `.boot-intro` 的
    // justify-content:center 是横向居中，与「纵向安全居中」无关。
    const splashRule = sharedCss.match(/#boot-splash \{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(splashRule).toContain("justify-content: flex-start");
    expect(splashRule).not.toContain("justify-content: center");
    expect(sharedCss).toMatch(/\.boot-stack \{[\s\S]*?margin-block: auto;/);
    expect(splashRule).toContain("overflow-y: auto");
    expect(sharedCss).toContain("overscroll-behavior: contain");
  });

  it("恢复卡宽度只由父级 padding 留白，不再重复扣减同一份间距", () => {
    expect(sharedCss).toMatch(/#boot-recovery \{[\s\S]*?width: 100%;/);
    expect(sharedCss).toMatch(/#boot-recovery \{[\s\S]*?max-width: 420px;/);
    expect(sharedCss).not.toMatch(/calc\(100% - /);
    // 外层左右安全留白仍在（clamp 下限 10px，264 宽窗口也不会贴边）。
    expect(sharedCss).toContain("padding: clamp(10px, 3vmin, 24px)");
  });

  it("四个短高度档位覆盖 264×112 下限，且三个恢复操作在所有档位保留", () => {
    for (const tier of [430, 260, 200, 150]) {
      expect(sharedCss).toContain(`@media (max-height: ${tier}px)`);
    }
    // 短高度只允许隐藏装饰徽标与非核心安全说明，绝不隐藏操作按钮。
    const shortTiers = sharedCss.split("@media (max-height: 260px)")[1] ?? "";
    expect(shortTiers).not.toMatch(/\.boot-btn[^{]*\{[^}]*display: none/);
    expect(shortTiers).not.toMatch(/#boot-wait[^{]*\{[^}]*display: none/);
    expect(shortTiers).not.toMatch(/#boot-retry[^{]*\{[^}]*display: none/);
    expect(shortTiers).not.toMatch(/#boot-copy[^{]*\{[^}]*display: none/);
    // ≤260px 操作紧跟标题（弹性 order），不需要滚动才发现按钮。
    expect(sharedCss).toMatch(/@media \(max-height: 260px\)[\s\S]*?\.boot-card-actions \{ order: 1;/);
    // ≤200px 启动位转横向紧凑。
    expect(sharedCss).toMatch(/@media \(max-height: 200px\)[\s\S]*?\.boot-intro \{[\s\S]*?flex-direction: row;/);
  });

  it("长错误信息不截断：卡片内可滚动，另有复制诊断通道", () => {
    expect(sharedCss).toMatch(/\.boot-card-detail \{[\s\S]*?overflow-y: auto;/);
    expect(sharedCss).toMatch(/\.boot-card-detail \{[\s\S]*?overflow-wrap: anywhere;/);
    expect(sharedCss).not.toContain("-webkit-line-clamp");
    // 卡片自身不裁剪，焦点环与长文本都能显示。
    expect(sharedCss).toMatch(/\.boot-card \{[\s\S]*?overflow: visible;/);
    expect(sharedCss).toContain("outline-offset: 2px");
    for (const source of [html, workspaceHtml]) expect(source).toContain('id="boot-copy"');
  });

  it("按钮可换行且命中区域有下限", () => {
    expect(sharedCss).toMatch(/\.boot-btn \{[\s\S]*?min-height: 32px;/);
    expect(sharedCss).toMatch(/\.boot-btn \{[\s\S]*?white-space: normal;/);
    expect(sharedCss).toMatch(/\.boot-btn \{[\s\S]*?max-width: 100%;/);
  });

  it("reduce 下无持续旋转/流光/位移：改为静态状态反馈", () => {
    const reduce = sharedCss.split("@media (prefers-reduced-motion: reduce)")[1] ?? "";
    expect(reduce).toContain(".boot-spinner");
    expect(reduce).toMatch(/\.boot-spinner \{\s*animation: none;/);
    expect(reduce).toMatch(/\.boot-sk-bar::after,[\s\S]*?animation: none;/);
    // 位移（boot-rise）必须被同特异性的状态选择器压掉。
    expect(reduce).toMatch(
      /#boot-splash\[data-state="timeout"\] #boot-recovery,[\s\S]*?animation: none;/,
    );
  });
});

describe("工作台启动占位与主窗口同源（slow 骨架屏）", () => {
  it("slow 态有中性骨架屏，不伪造任务数据与进度", () => {
    expect(workspaceHtml).toContain('id="boot-skeleton"');
    expect(workspaceHtml).toContain("boot-sk-row");
    expect(sharedCss).toMatch(/#boot-splash\[data-state="slow"\] #boot-skeleton \{ display: flex; \}/);
    expect(sharedCss).toMatch(/#boot-splash\[data-state="error"\] #boot-skeleton \{ display: none; \}/);
    // 骨架屏是纯形状层：无文本节点、无百分比。
    const skeleton = workspaceHtml.slice(
      workspaceHtml.indexOf('id="boot-skeleton"'),
      workspaceHtml.indexOf('class="boot-stack"'),
    );
    expect(skeleton).not.toMatch(/>[^<\s][^<]*</);
    expect(skeleton).not.toContain("%");
  });

  it("骨架屏背景层不随恢复卡滚动（fixed 而非 absolute）", () => {
    expect(sharedCss).toMatch(/#boot-skeleton \{[\s\S]*?position: fixed;/);
  });

  it("骨架屏中性色只有一套明暗取值，不按预设再开第二套色板", () => {
    for (const token of ["--boot-sk-base", "--boot-sk-card", "--boot-sk-shine"]) {
      // 单一来源：浅色 :root + 深色 [data-theme] + 系统偏好深色 = 3 处，不再按预设重复。
      expect(bootCssSource.split(`${token}:`).length - 1, `${token} 定义次数`).toBe(3);
    }
    expect(sharedCss).toMatch(/--boot-sk-base: rgba\(35, 40, 64, 0\.08\)/);
    expect(sharedCss).toMatch(/--boot-sk-base: rgba\(255, 255, 255, 0\.08\)/);
    // 两宿主经由同一份样式拿到同一组取值。
    expect(styleBlock(injectBootSplashCss(html, bootCssSource))).toBe(
      styleBlock(injectBootSplashCss(workspaceHtml, bootCssSource)),
    );
  });
});

describe("启动占位零外部依赖", () => {
  it("两个宿主都不引用外部样式表：启动界面不依赖应用 CSS/React", () => {
    for (const [name, source] of [
      ["index.html", html],
      ["workspace.html", workspaceHtml],
    ] as const) {
      expect(source, `${name} 不应有 <link rel=stylesheet>`).not.toMatch(/<link[^>]+stylesheet/i);
      expect(source).not.toMatch(/<link[^>]+\.css/i);
    }
  });

  it("三个恢复按钮都是显式 type=button，不触发隐式表单提交", () => {
    for (const id of ["boot-wait", "boot-retry", "boot-copy"]) {
      expect(html).toContain(`type="button" class="boot-btn`);
      expect(workspaceHtml).toContain(`type="button" class="boot-btn`);
      expect(html).toContain(`id="${id}"`);
      expect(workspaceHtml).toContain(`id="${id}"`);
    }
  });
});

/* ── 启动诊断升级（2026-11-19）：把「模块脚本尚未执行」定位到具体请求 ── */
const bootstrapSource = readFileSync(
  resolve(process.cwd(), "src/workspace/bootstrap.ts"),
  "utf8",
);
const watchdogSource = readFileSync(
  resolve(process.cwd(), "public/boot/boot-watchdog.js"),
  "utf8",
);
const mainSource = readFileSync(
  resolve(process.cwd(), "src/workspace/workspaceEntry.tsx"),
  "utf8",
);

describe("bootstrap.ts 启动隔离契约", () => {
  it("不静态导入 React / WorkbenchShell / 业务页，只动态 import('./workspaceEntry')", () => {
    expect(bootstrapSource).toContain('import("./workspaceEntry")');
    // 只检查真实的 import 声明（注释里出现这些名字是允许的说明文字）。
    const importLines = bootstrapSource
      .split("\n")
      .filter((line) => /^\s*import\b/.test(line))
      .join("\n");
    expect(importLines).toBe("");
  });

  it("记录 bootstrap / main-import 全链路阶段，且失败时 fail() 不静默", () => {
    for (const stage of [
      "bootstrap-start",
      "main-import-start",
      "main-import-resolved",
      "main-import-failed",
    ]) {
      expect(bootstrapSource).toContain(`"${stage}"`);
    }
    expect(bootstrapSource).toContain("importState");
    expect(bootstrapSource).toMatch(/\.fail\(/);
  });
});

describe("watchdog 启动诊断采样契约", () => {
  it("采集同源资源（去 query）、CSP 违规与入口脚本 load/error", () => {
    expect(watchdogSource).toContain('getEntriesByType("resource")');
    expect(watchdogSource).toContain("PerformanceObserver");
    expect(watchdogSource).toContain("securitypolicyviolation");
    expect(watchdogSource).toContain("blockedURI");
    expect(watchdogSource).toContain("effectiveDirective");
    expect(watchdogSource).toContain("sameOriginPath");
    expect(watchdogSource).toContain('noteEntryEvent("load"');
  });

  it("维护动态导入状态机并区分 pending 与无请求", () => {
    for (const s of [
      "not-requested", "requested", "pending", "resolved", "rejected",
    ]) {
      expect(watchdogSource).toContain(s);
    }
    expect(watchdogSource).toContain("pendingExpected");
  });

  it("复制诊断输出用户约定的固定字段", () => {
    for (const field of [
      "Task Dock 启动诊断",
      "页面 URL:",
      "document.readyState:",
      "Bootstrap:",
      "Main import:",
      "Main module:",
      "React root:",
      "React mounted:",
      "Settings settled:",
      "Workbench ready:",
      "初始化函数耗时:",
      "资源请求总数:",
      "Pending 请求:",
      "失败请求:",
      "CSP 拦截:",
      "最近资源请求:",
    ]) {
      expect(watchdogSource).toContain(field);
    }
  });

  it("仍保持单一计时器对与阈值，不新增刷新/重试循环", () => {
    expect(watchdogSource).toContain("var SLOW_MS = 4000;");
    expect(watchdogSource).toContain("var TIMEOUT_MS = 15000;");
    expect(watchdogSource.match(/setTimeout\(/g)?.length).toBeLessThanOrEqual(4);
    expect(watchdogSource).not.toContain("location.reload()\n");
  });
});

describe("main.tsx 阶段信号细化契约", () => {
  it("对五个同步初始化函数分别记录 start/end 与耗时", () => {
    for (const fn of [
      "setWindowHostRole",
      "installFeatureRegistry",
      "installNativeDragBridge",
      "initLocale",
      "initWorkbenchWindowFrame",
    ]) {
      expect(mainSource).toContain(`timed("${fn}"`);
    }
    expect(mainSource).toContain("bootTiming");
    expect(mainSource).toContain('"react-root"');
    expect(mainSource).toContain('"modules"');
    expect(mainSource).toContain('"mounted"');
  });
});
