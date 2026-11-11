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
