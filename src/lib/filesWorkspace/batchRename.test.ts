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

  it("后缀/替换/删除文本均保留扩展名", () => {
    const suffix = buildBatchRenamePreview(paths, { ...DEFAULT_BATCH_RENAME_OPTIONS, mode: "suffix", suffix: "_v2" }, []);
    expect(suffix[0].newName).toBe("image_a_v2.png");
    const replace = buildBatchRenamePreview(paths, { ...DEFAULT_BATCH_RENAME_OPTIONS, mode: "replace", find: "image_", replace: "pic-" }, []);
    expect(replace[0].newName).toBe("pic-a.png");
    const remove = buildBatchRenamePreview(paths, { ...DEFAULT_BATCH_RENAME_OPTIONS, mode: "delete", find: "_a" }, []);
    expect(remove[0].newName).toBe("image.png");
  });

  it("序号位数不足时补零，超过位数不截断", () => {
    const preview = buildBatchRenamePreview(paths, { ...DEFAULT_BATCH_RENAME_OPTIONS, mode: "sequence", start: 9, digits: 2 }, []);
    expect(preview.map((item) => item.newName)).toEqual(["09.png", "10.png", "11.png"]);
  });

  it("大小写-only 改名允许执行；目标与源同一个文件不算外部冲突", () => {
    const preview = buildBatchRenamePreview(
      ["D:\\dir\\A.txt"],
      { ...DEFAULT_BATCH_RENAME_OPTIONS, mode: "lower" },
      ["D:\\dir\\a.txt"],
    );
    expect(preview[0].newName).toBe("a.txt");
    expect(preview[0].status).toBe("ok");
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

  it("目标属于本批另一源（A↔B 互换）时拒绝，不启用两阶段交换", () => {
    const preview = buildBatchRenamePreview(
      ["D:\\dir\\2.txt", "D:\\dir\\1.txt"],
      { ...DEFAULT_BATCH_RENAME_OPTIONS, mode: "sequence", start: 1, digits: 1 },
      [],
    );
    expect(preview.map((item) => item.status)).toEqual(["conflict", "conflict"]);
    expect(preview[0].reason).toContain("互换");
    expect(preview[0].reason).toContain("两阶段交换未启用");
  });
});
