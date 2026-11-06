import { describe, expect, it } from "vitest";
import { shelfDeleteFeedback } from "./shelfDeleteFeedback";

describe("暂存架删除反馈", () => {
  it("清空刷新失败时不声称暂存架已清空", () => {
    const feedback = shelfDeleteFeedback(
      {
        report: { deleted: 4, skipped: 0, freed_bytes: 0, failed_files: 0 },
        synced: false,
        remainingTotal: null,
      },
      "clear",
    );

    expect(feedback.message).toContain("已清理 4 项");
    expect(feedback.message).toContain("列表刷新失败");
    expect(feedback.message).not.toContain("已清空暂存架");
  });

  it("托管文件残留与暂存记录删除分别说明", () => {
    const feedback = shelfDeleteFeedback(
      {
        report: { deleted: 2, skipped: 0, freed_bytes: 0, failed_files: 1 },
        synced: true,
        remainingTotal: 0,
      },
      "delete",
    );

    expect(feedback.message).toContain("已删除 2 项");
    expect(feedback.message).toContain("暂存记录已删除");
    expect(feedback.message).toContain("磁盘可能有残留");
  });
});
