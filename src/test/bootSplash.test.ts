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

const html = readFileSync(resolve(process.cwd(), "index.html"), "utf8");
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
      expect(html).toContain(`data-state="${state}"`);
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
      expect(workspaceHtml).toContain(`data-state="${state}"`);
    }
    expect(workspaceHtml).toContain('#boot-splash[data-state="timeout"] #boot-recovery');
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
  resolve(process.cwd(), "src/workspace/main.tsx"),
  "utf8",
);

describe("bootstrap.ts 启动隔离契约", () => {
  it("不静态导入 React / WorkbenchShell / 业务页，只动态 import('./main')", () => {
    expect(bootstrapSource).toContain('import("./main")');
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
