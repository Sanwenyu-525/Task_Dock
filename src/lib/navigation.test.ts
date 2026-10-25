//! 导航前端纯函数测试：头像稳定性、状态徽标、验证级别文案、结果消息如实性。

import { describe, expect, it } from "vitest";
import {
  avatarHue,
  resultMessage,
  stateBadge,
  TARGET_TYPE_LABELS,
  verificationLabel,
  type NavigationResult,
} from "./navigation";

function result(partial: Partial<NavigationResult>): NavigationResult {
  return {
    success: true,
    requested_action: "focus_window",
    actual_action: "focus_window",
    fallback_used: false,
    target_id: "t",
    verification_level: "window-confirmed",
    ...partial,
  };
}

describe("avatarHue", () => {
  it("同一 key 稳定、不同 key 大概率不同", () => {
    expect(avatarHue("chrome.exe")).toBe(avatarHue("chrome.exe"));
    expect(avatarHue("chrome.exe")).toBeGreaterThanOrEqual(0);
    expect(avatarHue("chrome.exe")).toBeLessThan(360);
  });
});

describe("stateBadge", () => {
  it("区分有窗口/仅进程/未运行/失效", () => {
    expect(stateBadge("has_window").tone).toBe("ok");
    expect(stateBadge("process_only").tone).toBe("idle");
    expect(stateBadge("not_running").label).toBe("未运行");
    expect(stateBadge("unavailable").tone).toBe("bad");
    expect(stateBadge("always").tone).toBe("ok");
  });
});

describe("verificationLabel", () => {
  it("不夸大：进程启动 ≠ 窗口确认", () => {
    expect(verificationLabel("process-spawned")).toBe("进程已启动");
    expect(verificationLabel("window-confirmed")).toBe("已确认窗口");
    expect(verificationLabel("delegated")).toBe("已交系统处理");
    expect(verificationLabel("none")).toBe("未执行");
  });
});

describe("resultMessage", () => {
  it("失败带原因", () => {
    const msg = resultMessage(
      result({ success: false, reason: "Windows 前台锁定拒绝了切换" }),
      "微信",
    );
    expect(msg).toContain("微信");
    expect(msg).toContain("前台锁定");
  });

  it("降级成功要标注降级与原因", () => {
    const msg = resultMessage(
      result({
        fallback_used: true,
        reason: "该应用有 3 个窗口，已唤醒其一",
        verification_level: "window-confirmed",
      }),
      "Chrome",
    );
    expect(msg).toContain("已确认窗口");
    expect(msg).toContain("3 个窗口");
  });

  it("普通成功不出现失败字样", () => {
    const msg = resultMessage(result({}), "VS Code");
    expect(msg).toContain("VS Code");
    expect(msg).not.toContain("失败");
  });
});

describe("TARGET_TYPE_LABELS", () => {
  it("五种目标类型齐全", () => {
    for (const k of ["application", "url", "file", "directory", "agent_session"] as const) {
      expect(TARGET_TYPE_LABELS[k].length).toBeGreaterThan(0);
    }
  });
});
