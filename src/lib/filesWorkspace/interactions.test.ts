//! 内部拖拽协调单测：效果解析（Ctrl/Shift/默认同异卷）、合法性、剪贴板暂存、
//! 广播纪律（重入收敛/变更检测/取消清理）——P0 拖拽重入缺陷的回归钉。

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./volumeCache", () => ({
  volumeDecision: vi.fn(),
}));

import { volumeDecision } from "./volumeCache";
import {
  defaultEffect,
  resolveEffect,
  validateFileDrop,
  getFwClipboard,
  setFwClipboard,
  subscribeFwDrag,
  startFwDrag,
  moveFwDrag,
  updateFwHover,
  finishFwDrag,
  cancelFwDrag,
  getFwDragState,
  isFwDragging,
  sameZone,
} from "./interactions";

const volume = vi.mocked(volumeDecision);

beforeEach(() => {
  volume.mockReset();
  // 默认按同卷处理，便于拖拽状态机测试；未知/跨卷用例显式覆盖。
  volume.mockReturnValue("move");
});

describe("defaultEffect 同/异卷", () => {
  it("卷未知时默认复制，不按盘符猜移动（P0 安全默认）", () => {
    volume.mockReturnValue(null);
    expect(defaultEffect(["D:\\a\\f.txt"], "D:\\b")).toBe("copy");
    expect(defaultEffect(["\\\\srv\\share\\a\\f.txt"], "\\\\srv\\share\\b")).toBe("copy");
  });
  it("明确同卷默认移动", () => {
    volume.mockReturnValue("move");
    expect(defaultEffect(["D:\\a\\f.txt"], "D:\\b")).toBe("move");
  });
  it("明确跨卷默认复制", () => {
    volume.mockReturnValue("copy");
    expect(defaultEffect(["C:\\a\\f.txt"], "D:\\b")).toBe("copy");
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
  it("无修饰键按真实卷判定；未知按复制", () => {
    volume.mockReturnValue("move");
    expect(resolveEffect(files, "C:\\z", {})).toBe("move");
    volume.mockReturnValue("copy");
    expect(resolveEffect(files, "D:\\z", {})).toBe("copy");
    volume.mockReturnValue(null);
    expect(resolveEffect(files, "C:\\z", {})).toBe("copy");
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
    expect(isFwDragging()).toBe(false);
    startFwDrag({ kind: "files", paths: ["C:\\a"], fromPaneId: "p" }, 10, 20);
    expect(isFwDragging()).toBe(true);
    const st = getFwDragState();
    expect(st.x).toBe(10);
    expect(st.y).toBe(20);
    finishFwDrag();
    expect(isFwDragging()).toBe(false);
    expect(seen).toEqual(["files", null]);
    unsub();
  });

  it("moveFwDrag 更新坐标与修饰键（P0：旧实现坐标冻结在起点）", () => {
    try {
      startFwDrag({ kind: "files", paths: ["C:\\a\\f.txt"], fromPaneId: "p" }, 0, 0);
      moveFwDrag(300, 400, { ctrlKey: true });
      const st = getFwDragState();
      expect(st.x).toBe(300);
      expect(st.y).toBe(400);
      expect(st.modifiers.ctrlKey).toBe(true);
      // hover 指向同卷目录时 Ctrl 覆盖默认 → copy。
      updateFwHover({ type: "center", paneId: "p2", dir: "C:\\b" });
      expect(getFwDragState().effect).toBe("copy");
      moveFwDrag(320, 402, { shiftKey: true });
      expect(getFwDragState().effect).toBe("move");
    } finally {
      finishFwDrag();
    }
  });

  it("订阅回调内调用 updateFwHover 收敛不递归（P0 重入缺陷钉）", () => {
    try {
      let calls = 0;
      const unsub = subscribeFwDrag((fw) => {
        calls += 1;
        if (!fw.payload) return;
        // 模拟 FilePane 订阅者：按坐标计算命中并回写 hover。
        const zone = fw.x > 100 ? ({ type: "center", paneId: "p2", dir: "C:\\t" } as const) : null;
        updateFwHover(zone);
      });
      startFwDrag({ kind: "files", paths: ["C:\\a\\f.txt"], fromPaneId: "p" }, 200, 10);
      // 若递归不收敛，这里早已栈溢出；再推两次坐标仍收敛。
      moveFwDrag(210, 12, {});
      moveFwDrag(220, 14, {});
      expect(calls).toBeLessThan(20);
      expect(getFwDragState().hover).toEqual({ type: "center", paneId: "p2", dir: "C:\\t" });
      unsub();
    } finally {
      finishFwDrag();
    }
  });

  it("无变化不重复广播（变更检测）", () => {
    try {
      const seen = vi.fn();
      const unsub = subscribeFwDrag(seen);
      startFwDrag({ kind: "files", paths: ["C:\\a"], fromPaneId: "p" }, 5, 5);
      const afterStart = seen.mock.calls.length;
      // 相同坐标/修饰键重复 move：签名不变 → 不广播。
      moveFwDrag(5, 5, {});
      expect(seen.mock.calls.length).toBe(afterStart);
      moveFwDrag(6, 5, {});
      expect(seen.mock.calls.length).toBe(afterStart + 1);
      unsub();
    } finally {
      finishFwDrag();
    }
  });

  it("cancelFwDrag 清空载荷与 hover（Escape/失焦/卸载清理语义）", () => {
    startFwDrag({ kind: "files", paths: ["C:\\a"], fromPaneId: "p" }, 1, 1);
    updateFwHover({ type: "center", paneId: "p2", dir: "C:\\b" });
    expect(getFwDragState().hover).not.toBeNull();
    cancelFwDrag();
    expect(isFwDragging()).toBe(false);
    expect(getFwDragState().hover).toBeNull();
    // 幂等：再次取消不报错。
    cancelFwDrag();
  });
});

describe("sameZone 落点相等", () => {
  it("类型/边缘/目录/索引逐项比较", () => {
    expect(sameZone(null, null)).toBe(true);
    expect(sameZone(null, { type: "center", paneId: "p", dir: "C:\\a" })).toBe(false);
    expect(sameZone({ type: "edge", paneId: "p", edge: "left" }, { type: "edge", paneId: "p", edge: "left" })).toBe(true);
    expect(sameZone({ type: "edge", paneId: "p", edge: "left" }, { type: "edge", paneId: "p", edge: "right" })).toBe(false);
    expect(sameZone({ type: "center", paneId: "p", dir: "C:\\a" }, { type: "center", paneId: "p", dir: "c:\\a\\" })).toBe(true);
    expect(sameZone({ type: "center", paneId: "p", dir: "C:\\a" }, { type: "center", paneId: "p2", dir: "C:\\a" })).toBe(false);
    expect(sameZone({ type: "tabbar", paneId: "p", index: 1 }, { type: "tabbar", paneId: "p", index: 2 })).toBe(false);
  });
});
