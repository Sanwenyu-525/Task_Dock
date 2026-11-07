//! Smart Dock Capsule 信息聚合单测。
//!
//! 验收点（需求 3.3）：
//! - 数据未加载显示中性占位 `–`，不把未知伪装成 0 或全部正常；
//! - 紧凑格式：`05` 两位补零、`99+` 封顶；
//! - 异常优先级：failed / waiting 提升 alert；disconnected/idle 不算异常；
//! - aria 标签包含停靠边、待办、Agent 运行数与异常提示。

import { describe, expect, it } from "vitest";
import type { AgentRun, AgentSnapshot } from "./bridge";
import {
  capsuleAriaLabel,
  capsuleModel,
  formatCapsuleCount,
  RAIL_CATEGORIES,
  railStatus,
  tabHintKey,
} from "./capsuleModel";

function run(status: string, updatedMinutesAgo = 0): AgentRun {
  const t = new Date(Date.now() - updatedMinutesAgo * 60_000).toISOString();
  return {
    id: `run-${status}-${updatedMinutesAgo}`,
    session_id: "s1",
    source_id: "codex",
    external_run_id: `ext-${status}`,
    task_title: "内部任务标题（不得进入胶囊）",
    status,
    started_at: t,
    updated_at: t,
    ended_at: null,
    pending_items: [],
  };
}

const snapshotWith = (...runs: AgentRun[]): AgentSnapshot => ({
  sources: [],
  instances: [],
  sessions: [],
  runs,
});

describe("formatCapsuleCount 紧凑格式", () => {
  it("未加载/非法值显示占位 –", () => {
    expect(formatCapsuleCount(null)).toBe("–");
    expect(formatCapsuleCount(Number.NaN)).toBe("–");
  });

  it("两位补零：0→00、5→05、99→99", () => {
    expect(formatCapsuleCount(0)).toBe("00");
    expect(formatCapsuleCount(5)).toBe("05");
    expect(formatCapsuleCount(99)).toBe("99");
  });

  it("超过 99 封顶 99+；负数按 0", () => {
    expect(formatCapsuleCount(100)).toBe("99+");
    expect(formatCapsuleCount(1200)).toBe("99+");
    expect(formatCapsuleCount(-3)).toBe("00");
  });
});

describe("capsuleModel 信息聚合与异常优先级", () => {
  it("任务与 Agent 均未加载：中性占位，不伪装成 0", () => {
    const info = capsuleModel(null, null);
    expect(info.pendingLabel).toBe("–");
    expect(info.pendingLoaded).toBe(false);
    expect(info.agentLabel).toBe("–");
    expect(info.agentsLoaded).toBe(false);
    expect(info.alert).toBeNull();
    expect(info.worst).toBe("idle");
  });

  it("正常状态：待办数 + 运行中 Agent 数，无 alert", () => {
    const info = capsuleModel(5, snapshotWith(run("running"), run("running")));
    expect(info.pendingLabel).toBe("05");
    expect(info.agentLabel).toBe("2");
    expect(info.running).toBe(2);
    expect(info.alert).toBeNull();
    expect(info.worst).toBe("running");
  });

  it("failed 提升为异常优先级（运行数只统计 running，状态点变红）", () => {
    const info = capsuleModel(0, snapshotWith(run("running"), run("failed", 10)));
    expect(info.alert).toBe("failed");
    expect(info.worst).toBe("failed");
    expect(info.running).toBe(1);
    expect(info.agentLabel).toBe("1");
  });

  it("waiting 提升为异常优先级（failed 不在近期窗口时不覆盖）", () => {
    const info = capsuleModel(3, snapshotWith(run("waiting"), run("failed", 120)));
    // failed 已超过 1 小时近期窗口 → 不计入实时，waiting 为最差
    expect(info.alert).toBe("waiting");
    expect(info.worst).toBe("waiting");
  });

  it("disconnected 单独存在不构成 alert（不算需用户关注；运行数为 0）", () => {
    const info = capsuleModel(1, snapshotWith(run("disconnected")));
    expect(info.alert).toBeNull();
    expect(info.worst).toBe("disconnected");
    expect(info.agentLabel).toBe("0");
  });

  it("无 Agent 运行：运行数为 0，正常态", () => {
    const info = capsuleModel(0, snapshotWith());
    expect(info.agentLabel).toBe("0");
    expect(info.alert).toBeNull();
    expect(info.worst).toBe("idle");
  });

  it("待办为 0 显示 00 而非占位", () => {
    const info = capsuleModel(0, null);
    expect(info.pendingLabel).toBe("00");
    expect(info.pendingLoaded).toBe(true);
    expect(info.agentLabel).toBe("–"); // Agent 未知保持占位
  });

  it("超过 99 项显示 99+", () => {
    expect(capsuleModel(120, snapshotWith()).pendingLabel).toBe("99+");
  });
});

describe("轨道分类与收集箱徽标（B4）", () => {
  it("RAIL_CATEGORIES 顺序固定：任务 → 收集箱 → 剪贴板 → 应用（Agent 只在状态球）", () => {
    expect(RAIL_CATEGORIES).toEqual(["tasks", "inbox", "clipboard", "apps"]);
  });

  it("railStatus：收集箱未处理数生成徽标，0 与未加载不显示", () => {
    expect(railStatus(null, null, Date.now(), 3).inboxBadge).toBe("3");
    expect(railStatus(null, null, Date.now(), 3).inboxCount).toBe(3);
    expect(railStatus(null, null, Date.now(), 0).inboxBadge).toBeNull();
    expect(railStatus(null, null, Date.now(), null).inboxCount).toBeNull();
    // 缺省参数（未传收集箱计数）= 未加载，徽标为空
    expect(railStatus(null, null).inboxBadge).toBeNull();
    // 非法输入按 0 处理，徽标不显示
    expect(railStatus(null, null, Date.now(), Number.NaN).inboxBadge).toBeNull();
    // >99 封顶
    expect(railStatus(null, null, Date.now(), 120).inboxBadge).toBe("99+");
  });
});

describe("capsuleAriaLabel 可读摘要", () => {
  it("包含停靠边、待办数、Agent 运行数", () => {
    const label = capsuleAriaLabel("left", capsuleModel(5, snapshotWith(run("running"))));
    expect(label).toContain("展开 Task Dock");
    expect(label).toContain("已吸附左侧");
    expect(label).toContain("待办 5");
    expect(label).toContain("运行中 Agent 1");
  });

  it("异常状态在 aria 中明确播报", () => {
    const failed = capsuleAriaLabel("right", capsuleModel(2, snapshotWith(run("failed"))));
    expect(failed).toContain("有失败任务需要关注");
    const waiting = capsuleAriaLabel("top", capsuleModel(2, snapshotWith(run("waiting"))));
    expect(waiting).toContain("有 Agent 等待确认");
  });

  it("未加载数据播报「未知」而非 0", () => {
    const label = capsuleAriaLabel("bottom", capsuleModel(null, null));
    expect(label).toContain("待办未知");
    expect(label).toContain("Agent 状态未知");
    expect(label).not.toContain("待办 0");
  });

  it("99+ 播报为「99 以上」", () => {
    const label = capsuleAriaLabel("left", capsuleModel(150, snapshotWith()));
    expect(label).toContain("待办 99 以上");
  });
});

// ── Edge Tab 悬停提示文案 ─────────────────────────────────────
//
// 契约：状态文案与轨道状态球同源（railStatus.agentTone）；`unknown`（快照未加载）
// 与 `idle`（无活动会话）只能落到中性文案，绝不宣称「运行中」。

describe("tabHintKey", () => {
  it("四种真实状态各有专属文案键", () => {
    expect(tabHintKey("running")).toBe("capsule.tabHint.running");
    expect(tabHintKey("waiting")).toBe("capsule.tabHint.waiting");
    expect(tabHintKey("failed")).toBe("capsule.tabHint.failed");
    expect(tabHintKey("disconnected")).toBe("capsule.tabHint.disconnected");
  });

  it("未知与空闲回落到中性文案（不把未知伪装成正常）", () => {
    expect(tabHintKey("unknown")).toBe("capsule.tabHint.base");
    expect(tabHintKey("idle")).toBe("capsule.tabHint.base");
    expect(tabHintKey("")).toBe("capsule.tabHint.base");
    expect(tabHintKey("whatever")).toBe("capsule.tabHint.base");
  });

  it("未加载快照经 railStatus 得到的 tone 只会是 unknown", () => {
    const st = railStatus(null, null, Date.now(), null);
    expect(st.agentsLoaded).toBe(false);
    // CapsuleDock 传 unknown 而不是 agentTone：
    // `status.agentsLoaded ? status.agentTone : "unknown"`
    expect(tabHintKey("unknown")).toBe("capsule.tabHint.base");
  });
});
