//! 工作台窗口权限契约（U0-08）：
//! - 只授予真实消费者需要的插件能力；
//! - 不复制主窗口的导航/通知/贴边/开机自启/全局快捷键权限；
//! - 业务 IPC 的授权仍由 Rust 命令自身校验（能力文件不是唯一防线）。

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface CapabilityFile {
  identifier: string;
  windows: string[];
  permissions: string[];
}

function readCapability(relative: string): CapabilityFile {
  const url = new URL(`../../src-tauri/capabilities/${relative}`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as CapabilityFile;
}

describe("workspace capability", () => {
  const workspace = readCapability("workspace.json");
  const main = readCapability("default.json");

  it("只作用于 workspace 窗口，不继承主窗口", () => {
    expect(workspace.identifier).toBe("workspace");
    expect(workspace.windows).toEqual(["workspace"]);
    expect(main.windows).toEqual(["main"]);
  });

  it("包含工作台真实消费者：事件、文件选择、系统打开", () => {
    expect(workspace.permissions).toContain("core:default");
    expect(workspace.permissions).toContain("core:event:default");
    expect(workspace.permissions).toContain("dialog:default"); // 备份/语音包/资源导入
    expect(workspace.permissions).toContain("opener:default"); // 打开项目目录/定位文件
  });

  it("不复制主窗口的通知/开机自启/全局快捷键/窗口几何权限", () => {
    for (const forbidden of [
      "notification:default",
      "autostart:default",
      "global-shortcut:default",
      "core:window:allow-set-position",
      "core:window:allow-set-size",
      "core:window:allow-start-dragging",
    ]) {
      expect(workspace.permissions, `${forbidden} 不应授予工作台`).not.toContain(forbidden);
      expect(main.permissions, `${forbidden} 应只属于主窗口`).toContain(forbidden);
    }
  });
});
