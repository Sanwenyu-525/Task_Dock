// 本地安全事件：只允许事件类型/时间/结果与稳定原因码，任意长文本必须被清洗。
import { beforeEach, describe, expect, it } from "vitest";

import { listHubAudit, recordHubAudit } from "../src/lib/hub/audit";
import { __resetFs } from "../src/test/mocks/expo-file-system";

describe("hub audit", () => {
  beforeEach(() => {
    __resetFs();
  });

  it("只落事件类型、时间、结果与稳定原因码", async () => {
    await recordHubAudit({
      type: "pairing_scan",
      result: "rejected",
      reason: "QR_SIGNATURE_INVALID",
    });
    const events = await listHubAudit();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "pairing_scan",
      result: "rejected",
      reason: "QR_SIGNATURE_INVALID",
    });
    expect(typeof events[0].at).toBe("string");
    expect(Number.isFinite(Date.parse(events[0].at))).toBe(true);
  });

  it("调用方误传长文本（可能含密钥）时脱敏", async () => {
    const leaked = "EREREREREREREREREREREQ==publickey";
    await recordHubAudit({
      type: "pairing_request",
      result: "error",
      reason: leaked,
    });
    const events = await listHubAudit();
    expect(events[0].reason).toBe("REDACTED");
    expect(JSON.stringify(events)).not.toContain(leaked);
  });
});
