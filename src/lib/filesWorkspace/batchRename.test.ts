//! 批量重命名预览规则：非法名、重复目标、已存在目标、序号与扩展名保留。

import { describe, expect, it } from "vitest";
import { buildBatchRenamePreview, DEFAULT_BATCH_RENAME_OPTIONS, invalidRenameName } from "./batchRename";

const paths = ["D:\\dir\\image_a.png", "D:\\dir\\image_b.png", "D:\\dir\\image_c.png"];

describe("invalidRenameName", () => {
  it("拒绝路径穿越、Windows 非法字符与保留名", () => {
    expect(invalidRenameName("a/b.png")).not.toBeNull();
    expect(invalidRenameName("a:b.png")).not.toBeNull();
    expect(invalidRenameName("CON.txt")).not.toBeNull();
    expect(invalidRenameName("ok.png")).toBeNull();
  });
});

describe("buildBatchRenamePreview", () => {
  it("按序号保留扩展名", () => {
    const preview = buildBatchRenamePreview(paths, { ...DEFAULT_BATCH_RENAME_OPTIONS, mode: "sequence", start: 1, digits: 3 }, []);
    expect(preview.map((item) => item.newName)).toEqual(["001.png", "002.png", "003.png"]);
    expect(preview.every((item) => item.status === "ok")).toBe(true);
  });

  it("前缀作用于主文件名而非扩展名", () => {
    const preview = buildBatchRenamePreview(paths, { ...DEFAULT_BATCH_RENAME_OPTIONS, prefix: "Character_" }, []);
    expect(preview[0].newName).toBe("Character_image_a.png");
  });

  it("批量内目标与其他源重名标冲突，不静默覆盖", () => {
    const preview = buildBatchRenamePreview(
      ["D:\\dir\\A.txt", "D:\\dir\\a.txt"],
      { ...DEFAULT_BATCH_RENAME_OPTIONS, mode: "lower" },
      [],
    );
    expect(preview[0].status).toBe("conflict");
    expect(preview[1].status).toBe("unchanged");
  });

  it("目标已存在为冲突，不静默覆盖", () => {
    const preview = buildBatchRenamePreview(paths, DEFAULT_BATCH_RENAME_OPTIONS, ["D:\\dir\\Character_image_a.png"]);
    expect(preview[0].status).toBe("conflict");
    expect(preview[1].status).toBe("ok");
  });

  it("名称不变标 unchanged，不参与执行", () => {
    const preview = buildBatchRenamePreview(["D:\\dir\\same.png"], { ...DEFAULT_BATCH_RENAME_OPTIONS, mode: "prefix", prefix: "" }, []);
    expect(preview[0].status).toBe("unchanged");
  });
});
