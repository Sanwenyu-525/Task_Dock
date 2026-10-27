//! 导航前端纯函数测试：头像稳定性、状态徽标、验证级别文案、结果消息如实性。

import { describe, expect, it } from "vitest";
import {
  avatarHue,
  buildTargetMenuItems,
  moveMenuIndex,
  resultMessage,
  stateBadge,
  TARGET_TYPE_LABELS,
  verificationLabel,
  type NavigationResult,
  type TaskNavLink,
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

  it("窗口已出现但未置前，必须有独立文案（不得冒充已确认）", () => {
    const label = verificationLabel("window-visible");
    expect(label).toContain("窗口已出现");
    expect(label).not.toBe(verificationLabel("window-confirmed"));
    expect(label).not.toContain("已确认");
  });
});

// ── 问题 8：目标菜单键盘模型 ────────────────────────────────

function link(id: string): TaskNavLink {
  return {
    id: `link-${id}`,
    task_id: "t1",
    target_id: `target-${id}`,
    display_order: 0,
    is_default: false,
    launch_behavior: "default",
    created_at: "2026-10-26T00:00:00Z",
    running_state: "not_running",
    target: {
      id: `target-${id}`,
      display_name: id,
      target_type: "application",
      app_key: id,
      exe_path: "",
      launch_args: "",
      working_dir: "",
      app_user_model_id: "",
      url: "",
      path: "",
      agent_source_id: "",
      agent_session_id: "",
      window_title_hint: "",
      icon: "",
      category: "",
      favorite: false,
      hidden: false,
      last_used_at: null,
      use_count: 0,
      created_at: "2026-10-26T00:00:00Z",
      updated_at: "2026-10-26T00:00:00Z",
    },
  };
}

describe("buildTargetMenuItems", () => {
  it("工作区入口排在索引 0，普通目标依次后移", () => {
    const items = buildTargetMenuItems([link("A"), link("B")], true);
    expect(items).toHaveLength(3);
    expect(items[0].kind).toBe("workspace");
    expect(items[1].kind).toBe("target");
    expect(items[2].kind).toBe("target");
  });

  it("没有工作区入口时索引从 0 直接是目标", () => {
    const items = buildTargetMenuItems([link("A")], false);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("target");
  });

  it("空目标列表也能安全构建", () => {
    expect(buildTargetMenuItems([], false)).toHaveLength(0);
    expect(buildTargetMenuItems([], true)).toHaveLength(1);
  });
});

describe("moveMenuIndex", () => {
  it("上下移动并在两端回绕", () => {
    expect(moveMenuIndex(0, 1, 3)).toBe(1);
    expect(moveMenuIndex(2, 1, 3)).toBe(0);
    expect(moveMenuIndex(0, -1, 3)).toBe(2);
  });

  it("空列表不产生 NaN/负数", () => {
    expect(moveMenuIndex(0, 1, 0)).toBe(0);
    expect(moveMenuIndex(5, -1, 0)).toBe(0);
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
