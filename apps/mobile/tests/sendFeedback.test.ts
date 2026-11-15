// 页面发送反馈回归：单条/批量 Toast 必须由 outcome 决定，不能用 offline/stopBatch
// 两个传输层标志推断业务成功。
import { describe, expect, it } from "vitest";

import {
  countOutcomes,
  feedbackForOutcome,
  feedbackForSendResult,
  feedbackForShelfRetry,
} from "../src/features/capture/sendFeedback";

const done = (assetId = "a") => ({ assetId, state: "done" as const, remoteId: "r1" });

describe("sendFeedback", () => {
  it("单条 done 才显示成功", () => {
    expect(feedbackForOutcome(done(), "inbox")).toEqual({ message: "已发送到电脑", tone: "success" });
  });

  it("单条 failed 即使没有 offline/stopBatch 也必须显示失败", () => {
    const result = {
      outcomes: [{ assetId: "a", state: "failed" as const, message: "远端返回 400" }],
      offline: false,
      stopBatch: false,
    };
    expect(feedbackForSendResult(result, "inbox").tone).toBe("danger");
    expect(feedbackForSendResult(result, "inbox").message).toContain("失败 1 项");
  });

  it("409/429/500/pending 显示等待而不是成功", () => {
    for (const message of ["文件记录冲突（409）", "请求过于频繁（429）", "服务器暂时不可用（500）"]) {
      const result = {
        outcomes: [{ assetId: "a", state: "pending" as const, message }],
        offline: false,
        stopBatch: false,
      };
      const feedback = feedbackForSendResult(result, "inbox");
      expect(feedback.tone).toBe("warn");
      expect(feedback.message).toContain("等待 1 项");
    }
  });

  it("取消显示取消，不显示成功", () => {
    const result = {
      outcomes: [{ assetId: "a", state: "cancelled" as const, message: "用户取消上传" }],
      offline: false,
      stopBatch: false,
    };
    expect(feedbackForSendResult(result, "inbox")).toMatchObject({
      tone: "warn",
      message: expect.stringContaining("取消 1 项"),
    });
  });

  it("暂存架 desktop done 但 shelf failed 时必须显示失败", () => {
    const result = {
      outcomes: [
        { assetId: "a", state: "failed" as const, remoteId: "r1", message: "加入暂存架失败" },
      ],
      offline: false,
      stopBatch: false,
    };
    expect(feedbackForSendResult(result, "shelf").tone).toBe("danger");
  });

  it("暂存架 done 但没有 remote shelf id 不算成功", () => {
    expect(feedbackForOutcome({ ...done(), shelfId: undefined }, "shelf")).toMatchObject({
      tone: "danger",
    });
    expect(feedbackForOutcome({ ...done(), shelfId: "mf-r1" }, "shelf")).toEqual({
      message: "已加入暂存架",
      tone: "success",
    });
    expect(feedbackForShelfRetry({
      state: "done",
      remoteId: "r1",
      remoteShelfId: null,
      message: "已加入暂存架",
      stopBatch: false,
    }).tone).toBe("danger");
  });

  it("五文件部分成功按真实数量汇总，不显示全部成功", () => {
    const outcomes = [
      done("a"),
      done("b"),
      done("c"),
      { assetId: "d", state: "failed" as const, message: "上传失败" },
      { assetId: "e", state: "failed" as const, message: "暂存架失败" },
    ];
    const result = { outcomes, offline: false, stopBatch: false };
    const summary = countOutcomes(outcomes, "inbox");
    expect(summary).toMatchObject({ done: 3, failed: 2, total: 5 });
    expect(feedbackForSendResult(result, "inbox").message).toContain("成功 3 项");
    expect(feedbackForSendResult(result, "inbox").message).toContain("失败 2 项");
    expect(feedbackForSendResult(result, "inbox").tone).toBe("danger");
  });
});
