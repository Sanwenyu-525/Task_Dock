//! 生命周期前端适配层：控制键映射与意图派生（纯函数）。

import { describe, expect, it } from "vitest";
import {
  controlFor,
  isControllableModule,
  moduleControlPatch,
  moduleDisabledFromSettings,
  modulePausedFromSettings,
  moduleStatusById,
} from "./lifecycle";
import type { ModuleRuntimeStatus, Settings } from "./bridge";

function status(id: string, patch: Partial<ModuleRuntimeStatus> = {}): ModuleRuntimeStatus {
  return {
    id,
    category: "resident",
    state: "running",
    intent: "running",
    controllable: true,
    background: [],
    detail: {},
    error: null,
    ...patch,
  };
}

describe("生命周期控制映射", () => {
  it("暂停写入各模块既有设置键，恢复写入反面值", () => {
    expect(moduleControlPatch("clipboard", true)).toEqual({ clipboard_paused: true });
    expect(moduleControlPatch("clipboard", false)).toEqual({ clipboard_paused: false });
    expect(moduleControlPatch("reminders", true)).toEqual({ reminders_paused: true });
    // 开关型设置：暂停 = false，恢复 = true
    expect(moduleControlPatch("shelf_cleanup", true)).toEqual({
      shelf_auto_cleanup_enabled: false,
    });
    expect(moduleControlPatch("shelf_cleanup", false)).toEqual({
      shelf_auto_cleanup_enabled: true,
    });
    expect(moduleControlPatch("actions", true)).toEqual({ actions_paused: true });
    expect(moduleControlPatch("actions", false)).toEqual({ actions_paused: false });
    expect(moduleControlPatch("voice", true)).toEqual({ tts_enabled: false });
  });

  it("长期停用与临时暂停分离：停用态不能被暂停字段伪装成可恢复", () => {
    const disabled = {
      clipboard_enabled: false,
      clipboard_paused: false,
      actions_enabled: false,
      actions_paused: false,
    } as Partial<Settings>;
    expect(moduleDisabledFromSettings("clipboard", disabled)).toBe(true);
    expect(moduleDisabledFromSettings("actions", disabled)).toBe(true);
    const enabled = {
      clipboard_enabled: true,
      actions_enabled: true,
    } as Partial<Settings>;
    expect(moduleDisabledFromSettings("clipboard", enabled)).toBe(false);
    expect(moduleDisabledFromSettings("actions", enabled)).toBe(false);
    // 未登记的模块没有停用维度
    expect(moduleDisabledFromSettings("messages", enabled)).toBe(false);
  });

  it("共享基础设施与按需模块没有控制键，避免无效按钮", () => {
    for (const id of ["agents", "diagnostics", "hotkeys", "ocr", "apps", "widgets"]) {
      expect(controlFor(id)).toBeUndefined();
      expect(isControllableModule(id)).toBe(false);
      expect(moduleControlPatch(id, true)).toBeNull();
    }
  });

  it("由设置派生暂停意图（首帧/交叉核对用）", () => {
    const settings = {
      clipboard_paused: true,
      shelf_auto_cleanup_enabled: false,
      reminders_paused: false,
    } as Partial<Settings>;
    expect(modulePausedFromSettings("clipboard", settings)).toBe(true);
    expect(modulePausedFromSettings("shelf_cleanup", settings)).toBe(true);
    expect(modulePausedFromSettings("reminders", settings)).toBe(false);
    // 无设置/无控制键时按未暂停处理，不误报
    expect(modulePausedFromSettings("clipboard", null)).toBe(false);
    expect(modulePausedFromSettings("agents", settings)).toBe(false);
  });

  it("按稳定 ID 查找状态，不依赖数组顺序", () => {
    const list = [status("a"), status("clipboard", { state: "paused" })];
    expect(moduleStatusById(list, "clipboard")?.state).toBe("paused");
    expect(moduleStatusById(list, "missing")).toBeUndefined();
    expect(moduleStatusById(null, "clipboard")).toBeUndefined();
  });
});
