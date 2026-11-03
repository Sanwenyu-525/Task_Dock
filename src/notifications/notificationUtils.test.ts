//! 通知队列纯逻辑测试：状态归一化、合并键、容量折叠（关键卡保护）、
//! 自动消失计时语义与动作配置的诚实性。

import { describe, expect, it } from "vitest";
import {
  AUTO_DISMISS_MS,
  MAX_VISIBLE,
  actionLabel,
  actionsFor,
  applyIncoming,
  detailRows,
  visibleSummary,
  findEvictionIndex,
  hasUsefulDetails,
  isCriticalKind,
  mergeKeyOf,
  normalizeKind,
  primaryActionFor,
  relativeTime,
  remainingMs,
  resumeDeadline,
  waitingDuration,
  withoutCard,
} from "./notificationUtils";
import type { NotificationCardData, QueuedCard } from "./notificationTypes";

const NOW = Date.parse("2026-11-03T10:00:00+08:00");

function card(overrides: Partial<NotificationCardData> = {}): NotificationCardData {
  return {
    id: "n1",
    kind: "agent_running",
    title: "Agent 正在执行",
    body: "codex · 整理报告",
    createdAt: "2026-11-03T09:59:30+08:00",
    ...overrides,
  };
}

function queued(overrides: Partial<QueuedCard> = {}): QueuedCard {
  return {
    ...card(),
    kind: normalizeKind(overrides.kind ?? "agent_running"),
    mergeKey: "ref:r1",
    expiresAt: NOW + 6000,
    ...overrides,
  };
}

describe("状态归一化与模板配置", () => {
  it("六种状态 + 提醒/摘要都映射到已知模板", () => {
    for (const k of [
      "agent_running",
      "agent_waiting",
      "agent_done",
      "agent_failed",
      "agent_disconnected",
      "reminder",
      "digest",
    ]) {
      expect(normalizeKind(k)).toBe(k);
      expect(AUTO_DISMISS_MS[normalizeKind(k)]).toBeGreaterThan(0);
    }
  });

  it("未知 kind 落到 generic 中性模板，不崩窗口", () => {
    expect(normalizeKind("agent_teleported")).toBe("generic");
    expect(AUTO_DISMISS_MS.generic).toBe(6000);
  });

  it("关键卡（等待/失败/断连）受保护，普通卡可折叠", () => {
    expect(isCriticalKind("agent_waiting")).toBe(true);
    expect(isCriticalKind("agent_failed")).toBe(true);
    expect(isCriticalKind("agent_disconnected")).toBe(true);
    expect(isCriticalKind("agent_done")).toBe(false);
    expect(isCriticalKind("agent_running")).toBe(false);
  });
});

describe("合并键与同轮次更新", () => {
  it("同一轮次（refId）新事件更新既有卡片而非新建", () => {
    const q0 = applyIncoming([], [card({ refId: "run-1" })], NOW);
    expect(q0).toHaveLength(1);
    const q1 = applyIncoming(q0, [card({ refId: "run-1", kind: "agent_waiting", id: "n2" })], NOW);
    expect(q1).toHaveLength(1);
    expect(q1[0].kind).toBe("agent_waiting");
    expect(q1[0].id).toBe("n2");
  });

  it("不同轮次是不同卡片；digest 永远共用一张摘要卡", () => {
    expect(mergeKeyOf(card({ refId: "a" }))).not.toBe(mergeKeyOf(card({ refId: "b" })));
    expect(mergeKeyOf(card({ kind: "digest", id: "x" }))).toBe("digest");
    expect(mergeKeyOf(card({ kind: "digest", id: "y" }))).toBe("digest");
  });

  it("无 refId 时按 来源+会话 合并", () => {
    expect(mergeKeyOf(card({ sourceId: "codex", sessionId: "s1" }))).toBe("agent:codex:s1");
  });
});

describe("容量上限与关键卡保护", () => {
  it("最多同时 3 条独立卡；普通卡先被折叠进摘要", () => {
    let q = applyIncoming([], [card({ refId: "r1", kind: "agent_done", title: "完成一" })], NOW);
    q = applyIncoming(q, [card({ refId: "r2", kind: "agent_done", title: "完成二" })], NOW);
    q = applyIncoming(q, [card({ refId: "r3", kind: "agent_done", title: "完成三" })], NOW);
    expect(q.filter((c) => c.kind !== "digest")).toHaveLength(MAX_VISIBLE);
    q = applyIncoming(q, [card({ refId: "r4", kind: "agent_done", title: "完成四" })], NOW);
    const visible = q.filter((c) => c.kind !== "digest");
    expect(visible).toHaveLength(MAX_VISIBLE);
    const digest = q.find((c) => c.kind === "digest");
    expect(digest).toBeDefined();
    expect(digest?.folded).toEqual([{ kind: "agent_done", title: "完成一" }]);
    expect(digest?.body).toContain("1 个完成");
  });

  it("等待/失败/断连不能被普通完成通知挤掉", () => {
    let q = applyIncoming([], [card({ refId: "r1", kind: "agent_waiting", title: "等待中" })], NOW);
    q = applyIncoming(q, [card({ refId: "r2", kind: "agent_disconnected", title: "断连" })], NOW);
    q = applyIncoming(q, [card({ refId: "r3", kind: "agent_failed", title: "失败" })], NOW);
    q = applyIncoming(q, [card({ refId: "r4", kind: "agent_done", title: "完成" })], NOW);
    const kinds = q.filter((c) => c.kind !== "digest").map((c) => c.kind);
    expect(kinds).toContain("agent_waiting");
    expect(kinds).toContain("agent_disconnected");
    expect(kinds).toContain("agent_failed");
    expect(q.find((c) => c.kind === "digest")?.folded?.[0]?.title).toBe("完成");
  });

  it("全是关键卡且仍超限时，折叠最旧的关键卡（而非新建第 4 张）", () => {
    let q = applyIncoming([], [card({ refId: "r1", kind: "agent_waiting" })], NOW);
    q = applyIncoming(q, [card({ refId: "r2", kind: "agent_waiting" })], NOW);
    q = applyIncoming(q, [card({ refId: "r3", kind: "agent_waiting" })], NOW);
    expect(findEvictionIndex(q)).toBe(0);
    q = applyIncoming(q, [card({ refId: "r4", kind: "agent_waiting" })], NOW);
    const visible = q.filter((c) => c.kind !== "digest");
    expect(visible).toHaveLength(MAX_VISIBLE);
    expect(visible[0].mergeKey).toBe("ref:r2");
  });

  it("折叠计数持续累计，不丢失原始标题（历史不受影响）", () => {
    let q = applyIncoming([], [card({ refId: "r1", kind: "agent_done", title: "A" })], NOW);
    q = applyIncoming(q, [card({ refId: "r2", kind: "agent_done", title: "B" })], NOW);
    q = applyIncoming(q, [card({ refId: "r3", kind: "agent_failed", title: "C" })], NOW);
    q = applyIncoming(q, [card({ refId: "r4", kind: "agent_done", title: "D" })], NOW);
    // 第一轮折叠：最旧的普通卡 A 进入摘要
    expect(q.find((c) => c.kind === "digest")?.folded?.map((f) => f.title)).toEqual(["A"]);
    q = applyIncoming(q, [card({ refId: "r5", kind: "agent_done", title: "E" })], NOW);
    // 第二轮折叠：摘要累计 B，A 不丢失
    const digest2 = q.find((c) => c.kind === "digest");
    expect(digest2?.folded?.map((f) => f.title)).toEqual(["A", "B"]);
    expect(digest2?.body).toContain("2 个完成");
  });

  it("关闭一张卡后摘要保留并继续兜底容量", () => {
    let q = applyIncoming([], [card({ refId: "r1", kind: "agent_done", title: "A" })], NOW);
    q = applyIncoming(q, [card({ refId: "r2", kind: "agent_done", title: "B" })], NOW);
    q = applyIncoming(q, [card({ refId: "r3", kind: "agent_done", title: "C" })], NOW);
    q = applyIncoming(q, [card({ refId: "r4", kind: "agent_done", title: "D" })], NOW);
    q = withoutCard(q, "r4", NOW + 1);
    const visible = q.filter((c) => c.kind !== "digest");
    expect(visible).toHaveLength(3);
    expect(q.find((c) => c.kind === "digest")).toBeDefined();
  });
});

describe("自动消失计时", () => {
  it("各状态时长符合原型规格区间", () => {
    expect(AUTO_DISMISS_MS.agent_done).toBeGreaterThanOrEqual(4000);
    expect(AUTO_DISMISS_MS.agent_done).toBeLessThanOrEqual(6000);
    expect(AUTO_DISMISS_MS.agent_failed).toBeGreaterThanOrEqual(10000);
    expect(AUTO_DISMISS_MS.agent_failed).toBeLessThanOrEqual(15000);
    expect(AUTO_DISMISS_MS.agent_disconnected).toBeGreaterThanOrEqual(10000);
    expect(AUTO_DISMISS_MS.agent_waiting).toBeGreaterThanOrEqual(10000);
  });

  it("悬停暂停后续接剩余时间，而非重置完整时长", () => {
    const c = queued({ expiresAt: NOW + 6000 });
    const remainAtPause = remainingMs(c, NOW + 2000);
    expect(remainAtPause).toBe(4000);
    const resumedAt = NOW + 5000;
    const deadline = resumeDeadline(remainAtPause, resumedAt);
    expect(deadline).toBe(NOW + 5000 + 4000); // 只剩 4s，不是重新 6s
  });
});

describe("展示辅助", () => {
  it("相对时间：刚刚 / 分钟前", () => {
    expect(relativeTime("2026-11-03T09:59:50+08:00", NOW)).toBe("刚刚");
    expect(relativeTime("2026-11-03T09:57:00+08:00", NOW)).toBe("3 分钟前");
  });

  it("等待时长来自真实通知时间", () => {
    expect(waitingDuration("2026-11-03T09:55:00+08:00", NOW)).toBe("5 分钟");
  });

  it("断连详情必须包含「不推断任务失败」的原则说明", () => {
    const rows = detailRows(queued({ kind: "agent_disconnected", mergeKey: "ref:r9" }), NOW);
    const values = rows.map((r) => r.value).join(" ");
    expect(values).toContain("不能推断失败");
  });

  it("摘要详情展开列出被折叠的原始标题", () => {
    const rows = detailRows(
      queued({
        kind: "digest",
        mergeKey: "digest",
        folded: [
          { kind: "agent_done", title: "生成报告" },
          { kind: "agent_failed", title: "代码分析" },
        ],
      }),
      NOW,
    );
    const values = rows.map((r) => r.value);
    expect(values).toContain("生成报告");
    expect(values).toContain("代码分析");
  });
});

describe("动作配置的诚实性", () => {
  it("无真实重试/重连能力：失败与断连卡不提供对应按钮", () => {
    const failed = actionsFor(queued({ kind: "agent_failed" }));
    const disconnected = actionsFor(queued({ kind: "agent_disconnected" }));
    expect(failed).toEqual(["view"]);
    expect(disconnected).toEqual(["view"]);
  });

  it("等待卡提供 立即处理 + 稍后提醒；摘要卡只保留通知中心外部入口", () => {
    const waiting = queued({ kind: "agent_waiting" });
    waiting.sourceId = "codex";
    waiting.sessionId = "s1";
    expect(actionsFor(waiting)).toEqual(["handle", "snooze"]);
    // 摘要卡的就地展开由底部详情入口承担，避免同一语义出现两个按钮
    expect(actionsFor(queued({ kind: "digest", mergeKey: "digest" }))).toEqual(["center"]);
  });

  it("缺少可靠会话信息时等待卡退化为打开 Agent 页面并如实改文案", () => {
    const waiting = queued({ kind: "agent_waiting" });
    delete waiting.sourceId;
    delete waiting.sessionId;
    expect(actionsFor(waiting)).toEqual(["view", "snooze"]);
    expect(actionLabel(waiting, "view")).toBe("打开 Agent 面板");
  });

  it("可定位时按钮文案准确区分定位与打开页面", () => {
    const failed = queued({ kind: "agent_failed" });
    expect(actionLabel(failed, "view")).toBe("打开 Agent 面板");
    expect(
      actionLabel({ ...failed, sourceId: "codex", sessionId: "s1" }, "view"),
    ).toBe("查看失败详情");
    expect(
      actionLabel({ ...failed, kind: "agent_done", sourceId: "codex", sessionId: "s1" }, "view"),
    ).toBe("定位本轮");
  });

  it("完成/执行中不显示全宽强主按钮，失败/等待保留醒目操作", () => {
    expect(primaryActionFor(queued({ kind: "agent_done" }))).toBeNull();
    expect(primaryActionFor(queued({ kind: "agent_running" }))).toBeNull();
    expect(primaryActionFor(queued({ kind: "agent_failed" }))).toBe("view");
    const waiting = queued({ kind: "agent_waiting" });
    waiting.sourceId = "codex";
    waiting.sessionId = "s1";
    expect(primaryActionFor(waiting)).toBe("handle");
  });

  it("详情不重复展示顶部已有时间；无补充信息不出展开入口", () => {
    const running = queued({ kind: "agent_running" });
    // 正文已含 sourceId，且无其他补充 → 无展开
    expect(detailRows(running, NOW)).toEqual([]);
    expect(hasUsefulDetails(running, NOW)).toBe(false);
    // 失败正文被截断/多行时才提供完整错误详情
    const failed = queued({
      kind: "agent_failed",
      body: "codex · 编译失败：\n" + "x".repeat(70),
    });
    expect(detailRows(failed, NOW).some((r) => r.label === "错误详情")).toBe(true);
  });

  it("完成/失败/等待在正文区展示真实摘要，长原因才进展开详情", () => {
    // 短原因直接可见（正文区两行内），不重复占展开详情
    const failed = queued({
      kind: "agent_failed",
      detail: "工具执行权限不足：未获得 shell 授权",
    });
    expect(visibleSummary(failed)).toBe("工具执行权限不足：未获得 shell 授权");
    expect(
      detailRows(failed, NOW).some((r) => r.label === "错误原因"),
    ).toBe(false);

    const waiting = queued({ kind: "agent_waiting", detail: "需要确认发布环境" });
    expect(visibleSummary(waiting)).toBe("需要确认发布环境");
    expect(
      detailRows(waiting, NOW).some((r) => r.label === "等待原因"),
    ).toBe(false);

    // 超过正文两行的长原因：正文区仍展示（截断），展开详情给出完整文本
    const long = "工具执行失败：" + "详情".repeat(60);
    const longFailed = queued({ kind: "agent_failed", detail: long });
    expect(
      detailRows(longFailed, NOW).find((r) => r.label === "错误原因")?.value,
    ).toBe(long);

    // 完成卡展示事件回执里的结果摘要；没有真实结果时不显示
    expect(
      visibleSummary(queued({ kind: "agent_done", detail: "已生成周报摘要" })),
    ).toBe("已生成周报摘要");
    expect(visibleSummary(queued({ kind: "agent_done" }))).toBeNull();
    // 没有原因时不编造等待原因（避免假信息）
    expect(visibleSummary(queued({ kind: "agent_waiting" }))).toBeNull();
  });

  it("执行中/完成提供查看详情", () => {
    expect(actionsFor(queued({ kind: "agent_running" }))).toEqual(["view"]);
    expect(actionsFor(queued({ kind: "agent_done" }))).toEqual(["view"]);
  });
});
