//! 内部拖拽协调单测：效果解析（Ctrl/Shift/默认同异卷）、合法性、剪贴板暂存。

import { describe, expect, it } from "vitest";

import {
  defaultEffect,
  resolveEffect,
  validateFileDrop,
  getFwClipboard,
  setFwClipboard,
  subscribeFwDrag,
  startFwDrag,
  finishFwDrag,
  getFwDragState,
} from "./interactions";

describe("defaultEffect 同/异卷", () => {
  it("同盘符默认移动", () => {
    expect(defaultEffect(["D:\\a\\f.txt"], "D:\\b")).toBe("move");
  });
  it("不同盘符默认复制", () => {
    expect(defaultEffect(["C:\\a\\f.txt"], "D:\\b")).toBe("copy");
  });
  it("UNC 与本地盘之间默认复制", () => {
    expect(defaultEffect(["\\\\srv\\share\\f.txt"], "D:\\b")).toBe("copy");
  });
  it("UNC 同一共享之间默认移动", () => {
    expect(defaultEffect(["\\\\srv\\share\\a\\f.txt"], "\\\\srv\\share\\b")).toBe("move");
  });
});

describe("resolveEffect 修饰键", () => {
  const files = { kind: "files" as const, paths: ["C:\\x\\a.txt"], fromPaneId: "p1" };
  it("Ctrl 强制复制", () => {
    expect(resolveEffect(files, "D:\\y", { ctrlKey: true })).toBe("copy");
  });
  it("Shift 强制移动", () => {
    expect(resolveEffect(files, "D:\\y", { shiftKey: true })).toBe("move");
  });
  it("无修饰键按默认（同异卷）", () => {
    expect(resolveEffect(files, "C:\\z", {})).toBe("move");
    expect(resolveEffect(files, "D:\\z", {})).toBe("copy");
  });
  it("标签拖拽恒为 tab 效果", () => {
    const tabs = { kind: "tabs" as const, tabIds: ["t1"], fromPaneId: "p1", paths: [] };
    expect(resolveEffect(tabs, null, {})).toBe("tab");
  });
});

describe("validateFileDrop", () => {
  it("目录拖进自身子树非法", () => {
    expect(validateFileDrop(["D:\\proj"], "D:\\proj\\sub")).toBeNull();
    expect(validateFileDrop(["D:\\proj"], "D:\\proj")).toBeNull();
  });
  it("常规目标返回目标目录", () => {
    expect(validateFileDrop(["D:\\proj\\a.txt"], "D:\\other")).toBe("D:\\other");
  });
});

describe("fwClipboard", () => {
  it("设置与读取", () => {
    setFwClipboard(null);
    expect(getFwClipboard()).toBeNull();
    setFwClipboard({ mode: "cut", paths: ["C:\\a"] });
    expect(getFwClipboard()?.mode).toBe("cut");
    setFwClipboard(null);
  });
});

describe("fwDrag 会话", () => {
  it("start/finish 状态与订阅", () => {
    const seen: Array<unknown> = [];
    const unsub = subscribeFwDrag((s) => seen.push(s.payload?.kind ?? null));
    expect(isDragging()).toBe(false);
    startFwDrag({ kind: "files", paths: ["C:\\a"], fromPaneId: "p" }, 10, 20);
    expect(isDragging()).toBe(true);
    const st = getFwDragState();
    expect(st.x).toBe(10);
    expect(st.y).toBe(20);
    finishFwDrag();
    expect(isDragging()).toBe(false);
    expect(seen).toEqual(["files", null]);
    unsub();
  });

  function isDragging(): boolean {
    return getFwDragState().payload !== null;
  }
});
