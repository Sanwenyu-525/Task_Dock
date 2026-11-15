// 前台自动同步判定单测：开关、配对、网络计费、单飞、退避、最小间隔。
// 只测纯判定函数与退避序列；真实网络/时钟行为由同步引擎与真机验收覆盖。
import { describe, expect, it, vi } from "vitest";

// 自动同步模块经 engine 间接引用提醒引擎（依赖 react-native），判定测试不需要它。
vi.mock("../../../notifications/reminderEngine", () => ({
  rescheduleAllReminders: vi.fn(async () => ({ scheduled: 0, skipped: 0 })),
}));

import {
  AUTO_SYNC_BACKOFF_MS,
  AUTO_SYNC_MIN_INTERVAL_MS,
  backoffForFailure,
  decideAutoSync,
  describeSkipReason,
  type AutoSyncDecisionInput,
} from "../autoSync";

function input(overrides: Partial<AutoSyncDecisionInput> = {}): AutoSyncDecisionInput {
  return {
    settings: { enabled: true, wifiOnly: true, autoTransferAttachments: false },
    paired: true,
    hasToken: true,
    metering: "unmetered",
    hasPendingLocalChanges: false,
    now: 1_000_000,
    lastSuccessAt: 0,
    nextAttemptAt: 0,
    syncing: false,
    ...overrides,
  };
}

describe("decideAutoSync", () => {
  it("具备条件时运行（无本地变更也要拉一次桌面端改动）", () => {
    expect(decideAutoSync(input())).toEqual({ run: true, reason: "ok" });
    expect(decideAutoSync(input({ hasPendingLocalChanges: false })).run).toBe(true);
  });

  it("开关关闭 / 未配对 / 令牌缺失：一律不启动", () => {
    expect(decideAutoSync(input({ settings: { enabled: false, wifiOnly: true, autoTransferAttachments: false } })).reason).toBe(
      "disabled",
    );
    expect(decideAutoSync(input({ paired: false })).reason).toBe("unpaired");
    expect(decideAutoSync(input({ hasToken: false })).reason).toBe("no_token");
  });

  it("仅 Wi-Fi 时：计费网络与无法判定都不自动同步（fail-closed）", () => {
    expect(decideAutoSync(input({ metering: "metered" })).reason).toBe("metered_network");
    expect(decideAutoSync(input({ metering: "unknown" })).reason).toBe("unknown_network");
  });

  it("关闭仅 Wi-Fi 后允许在计费网络同步", () => {
    const decision = decideAutoSync(
      input({
        settings: { enabled: true, wifiOnly: false, autoTransferAttachments: false },
        metering: "metered",
      }),
    );
    expect(decision.run).toBe(true);
  });

  it("单飞：已有同步在途时不再发起", () => {
    expect(decideAutoSync(input({ syncing: true })).reason).toBe("in_flight");
  });

  it("退避与最小间隔：未到时间不重复拉取", () => {
    expect(decideAutoSync(input({ nextAttemptAt: 1_000_001 })).reason).toBe("backoff");
    expect(
      decideAutoSync(input({ lastSuccessAt: 1_000_000 - (AUTO_SYNC_MIN_INTERVAL_MS - 1) })).reason,
    ).toBe("too_soon");
    expect(
      decideAutoSync(input({ lastSuccessAt: 1_000_000 - AUTO_SYNC_MIN_INTERVAL_MS })).run,
    ).toBe(true);
  });
});

describe("backoffForFailure", () => {
  it("30s 起步逐级翻倍并封顶 5 分钟", () => {
    expect(AUTO_SYNC_BACKOFF_MS).toEqual([30_000, 60_000, 120_000, 300_000]);
    expect(backoffForFailure(1)).toBe(30_000);
    expect(backoffForFailure(2)).toBe(60_000);
    expect(backoffForFailure(3)).toBe(120_000);
    expect(backoffForFailure(4)).toBe(300_000);
    expect(backoffForFailure(99)).toBe(300_000);
    expect(backoffForFailure(0)).toBe(30_000);
  });
});

describe("describeSkipReason", () => {
  it("所有跳过原因都有面向用户的说明", () => {
    const reasons = [
      "disabled",
      "unpaired",
      "no_token",
      "legacy_connection",
      "metered_network",
      "unknown_network",
      "in_flight",
      "backoff",
      "too_soon",
      "ok",
    ] as const;
    for (const reason of reasons) {
      expect(describeSkipReason(reason).length).toBeGreaterThan(0);
    }
  });
});
