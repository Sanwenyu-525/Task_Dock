//! Smart Dock Capsule 信息聚合单测。
//!
//! 验收点（需求 3.3）：
//! - 数据未加载显示中性占位 `–`，不把未知伪装成 0 或全部正常；
//! - 紧凑格式：`05` 两位补零、`99+` 封顶；
//! - 异常优先级：failed / waiting 提升 alert；disconnected/idle 不算异常；
//! - aria 标签包含停靠边、待办、Agent 运行数与异常提示。

import { describe, expect, it } from "vitest";
import type { AgentRun, AgentSnapshot } from "./bridge";
import { capsuleAriaLabel, capsuleModel, formatCapsuleCount } from "./capsuleModel";

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
