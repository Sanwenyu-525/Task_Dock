//! 过期清理反馈契约：0 候选、保留项、托管文件失败、同步失败都不能被说成纯成功。

import { describe, expect, it } from "vitest";
import { shelfCleanupFeedback } from "./shelfCleanupFeedback";
import type { ShelfCleanupResult } from "../../store/useShelfStore";

function result(over: Partial<ShelfCleanupResult["report"]>, synced = true): ShelfCleanupResult {
  return {
    synced,
    report: {
      dry_run: false,
      candidates: 0,
      skipped_protected: 0,
      temporary_files_skipped: 0,
      freed_bytes: 0,
      failed_files: 0,
      orphan_files_removed: 0,
      ...over,
    },
  };
}

describe("shelfCleanupFeedback", () => {
  it("0 候选提示没有需要清理的条目，不报成功", () => {
    const feedback = shelfCleanupFeedback(result({}));
    expect(feedback.message).toBe("没有需要清理的过期条目。");
    expect(feedback.kind).toBe("info");
  });

  it("全部成功报清理数量与释放空间", () => {
    const feedback = shelfCleanupFeedback(result({ candidates: 3, freed_bytes: 2048 }));
    expect(feedback.message).toBe("已清理 3 项，释放约 2.0 KB。");
    expect(feedback.kind).toBe("success");
  });

  it("受保护跳过项包含场景引用", () => {
    const feedback = shelfCleanupFeedback(
      result({ candidates: 1, skipped_protected: 2, freed_bytes: 10 }),
    );
    expect(feedback.message).toContain("2 项因收藏、置顶或场景引用而保留");
    expect(feedback.kind).toBe("warning");
  });

  it("托管文件失败不是成功态，且与孤儿文件数分开表述", () => {
    const feedback = shelfCleanupFeedback(
      result({ candidates: 2, failed_files: 4, orphan_files_removed: 1, freed_bytes: 10 }),
    );
    expect(feedback.message).toContain("部分托管文件清理失败（4 个）");
    expect(feedback.message).toContain("另外清理了 1 个无引用的托管残留文件");
    expect(feedback.kind).toBe("warning");
  });

  it("后端成功但同步失败时明确提示重试，不谎报已同步", () => {
    const feedback = shelfCleanupFeedback(result({ candidates: 1, freed_bytes: 10 }, false));
    expect(feedback.message).toContain("清理操作已经执行，但列表状态尚未同步");
    expect(feedback.kind).toBe("warning");
  });
});
