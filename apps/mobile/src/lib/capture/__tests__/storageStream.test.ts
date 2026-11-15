// 未知大小来源的流式复制边界（P0：不能「先完整写盘再判断超限」）。
//
// 用内存文件系统替身 + 缩小的上限，验证：
// 1. content:// 未知大小走流式复制并真实落盘；
// 2. 单文件超限在读取过程中立即中止，抛 validation 且不残留半成品；
// 3. 本次采集合计超限同样提前中止；
// 4. 正常文件的返回大小与磁盘字节一致。
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../limits", () => ({
  MAX_CAPTURE_ITEM_BYTES: 1_000_000,
  MAX_CAPTURE_ITEMS: 9,
  MAX_CAPTURE_TOTAL_BYTES: 2_000_000,
  stashTotalBytes: (items: Array<{ size: number }>) =>
    items.reduce((sum, item) => sum + item.size, 0),
}));

import { __activeFiles, __resetFs, __seedFile } from "../../../test/mocks/expo-file-system";

import { AppError } from "../../errors";

const SOURCE_DIR = "content://media/external/file";

function seed(bytes: number, name = "1000069262") {
  return __seedFile(SOURCE_DIR, name, new Uint8Array(bytes));
}

describe("persistIntoCaptureStore 流式边界", () => {
  beforeEach(() => {
    __resetFs();
  });

  it("未知大小的 content:// 来源走流式复制，返回真实字节数", async () => {
    const { persistIntoCaptureStore } = await import("../storage");
    const source = seed(600_000);
    const result = await persistIntoCaptureStore(
      { uri: source.uri, type: "image/jpeg", name: "IMG_0001.jpg" },
      { kind: "image" },
    );
    expect(result.size).toBe(600_000);
    expect(result.mime).toBe("image/jpeg");
    expect(__activeFiles()).toContain(result.localUri);
  });

  it("单文件超限时在读取过程中中止，不留下半成品", async () => {
    const { persistIntoCaptureStore } = await import("../storage");
    const source = seed(1_400_000);
    await expect(
      persistIntoCaptureStore(
        { uri: source.uri, type: "image/jpeg", name: "BIG.jpg" },
        { kind: "image" },
      ),
    ).rejects.toBeInstanceOf(AppError);
    // 目标目录里不应残留任何未删除文件
    expect(__activeFiles().filter((uri) => uri.includes("/capture/"))).toEqual([]);
  });

  it("本次采集合计超限时按剩余额度中止", async () => {
    const { persistIntoCaptureStore } = await import("../storage");
    const source = seed(600_000);
    await expect(
      persistIntoCaptureStore(
        { uri: source.uri, type: "image/jpeg", name: "SECOND.jpg" },
        { kind: "image", usedBytes: 1_900_000 },
      ),
    ).rejects.toBeInstanceOf(AppError);
    expect(__activeFiles().filter((uri) => uri.includes("/capture/"))).toEqual([]);
  });

  it("声明大小已超限时在复制前快速拒绝，不读取来源", async () => {
    const { persistIntoCaptureStore } = await import("../storage");
    const source = seed(10_000);
    await expect(
      persistIntoCaptureStore(
        { uri: source.uri, size: 5_000_000, type: "image/jpeg", name: "DECLARED.jpg" },
        { kind: "image" },
      ),
    ).rejects.toBeInstanceOf(AppError);
    expect(__activeFiles().filter((uri) => uri.includes("/capture/"))).toEqual([]);
  });
});
