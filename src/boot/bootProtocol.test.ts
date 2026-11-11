/**
 * @vitest-environment jsdom
 */
//! 启动协议 TS 镜像的单测（契约：tmp/acceptance/startup-experience-v1/BOOT_PROTOCOL.md §3–§4）。
//!
//! 覆盖：
//! 1. 阈值常量与 watchdog（public/boot/boot-watchdog.js）的 SLOW_MS/TIMEOUT_MS 一致；
//! 2. watchdog API 缺失（404 / jsdom / 非主窗）时全部 no-op 安全，不抛错；
//! 3. bootReady 双保险：API 缺失时直接移除 #boot-splash，且幂等；
//! 4. API 在场时 stage/ready/fail 安全透传；
//! 5. 畸形 API（非对象、方法缺失）不抛错。

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BOOT_SLOW_MS,
  BOOT_TIMEOUT_MS,
  bootFail,
  bootReady,
  bootStage,
} from "./bootProtocol";

const watchdogSource = readFileSync(
  resolve(process.cwd(), "public/boot/boot-watchdog.js"),
  "utf8",
);

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TASK_DOCK_BOOT__;
  document.getElementById("boot-splash")?.remove();
});

function mountSplash(): HTMLElement {
  const splash = document.createElement("div");
  splash.id = "boot-splash";
  document.body.appendChild(splash);
  return splash;
}

describe("启动协议阈值契约", () => {
  it("BOOT_SLOW_MS / BOOT_TIMEOUT_MS 与 watchdog 的 SLOW_MS / TIMEOUT_MS 一致", () => {
    expect(BOOT_SLOW_MS).toBe(4000);
    expect(BOOT_TIMEOUT_MS).toBe(15000);
    // watchdog 是经典脚本（无构建步骤），按精确命名检索锁定镜像关系。
    expect(watchdogSource).toContain("var SLOW_MS = 4000;");
    expect(watchdogSource).toContain("var TIMEOUT_MS = 15000;");
  });

  it("watchdog 保留既有公开能力（bootSplash 契约的等价迁移）", () => {
    expect(watchdogSource).toContain("__TASK_DOCK_BOOT__");
    expect(watchdogSource).toContain("diagnostics_record");
    expect(watchdogSource).toContain("UI_BOOT_TIMEOUT");
    expect(watchdogSource).toContain("UI_BOOT_FATAL");
    expect(watchdogSource).toContain("UI_BOOT_SLOW");
    expect(watchdogSource).toContain("UI_BOOT_ERROR");
  });
});

describe("watchdog API 缺失时的 no-op 安全", () => {
  it("stage / fail / ready 不抛错", () => {
    expect(() => bootStage("modules")).not.toThrow();
    expect(() => bootFail({ stage: "mounted", message: "同步抛错" })).not.toThrow();
    expect(() => bootReady()).not.toThrow();
  });

  it("bootReady 双保险：API 缺失时直接移除 #boot-splash（watchdog 404 防永久遮挡）", () => {
    mountSplash();
    bootReady();
    expect(document.getElementById("boot-splash")).toBeNull();
  });

  it("bootReady 幂等：占位已移除后再次调用不抛错", () => {
    mountSplash();
    bootReady();
    expect(() => bootReady()).not.toThrow();
    expect(document.getElementById("boot-splash")).toBeNull();
  });
});

describe("watchdog API 在场时的透传", () => {
  it("stage / ready / fail 透传到 watchdog（幂等由 watchdog 内部保证）", () => {
    mountSplash();
    const api = {
      startedAt: 0,
      stages: {},
      state: "boot",
      errors: [],
      stage: vi.fn(),
      ready: vi.fn(),
      fail: vi.fn(),
      copyDiagnostics: vi.fn(async () => true),
    };
    (window as unknown as Record<string, unknown>).__TASK_DOCK_BOOT__ = api;

    bootStage("modules");
    bootStage("mounted");
    bootFail({ stage: "mounted", message: "render 同步抛错" });
    bootReady();
    bootReady();

    expect(api.stage).toHaveBeenNthCalledWith(1, "modules");
    expect(api.stage).toHaveBeenNthCalledWith(2, "mounted");
    expect(api.fail).toHaveBeenCalledWith({ stage: "mounted", message: "render 同步抛错" });
    expect(api.ready).toHaveBeenCalledTimes(2);
  });
});

describe("畸形 API 防御", () => {
  it("API 不是对象时不抛错", () => {
    (window as unknown as Record<string, unknown>).__TASK_DOCK_BOOT__ = "garbage";
    expect(() => bootStage("settings")).not.toThrow();
    expect(() => bootReady()).not.toThrow();
    expect(() => bootFail({})).not.toThrow();
  });

  it("API 缺方法时不抛错（旧版本 watchdog / 被截断的对象）", () => {
    (window as unknown as Record<string, unknown>).__TASK_DOCK_BOOT__ = { stages: {} };
    expect(() => bootStage("modules")).not.toThrow();
    expect(() => bootReady()).not.toThrow();
    expect(() => bootFail({ stage: "modules" })).not.toThrow();
  });
});
