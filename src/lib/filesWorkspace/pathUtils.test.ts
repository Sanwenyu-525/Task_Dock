//! 路径工具单测（Windows 语义）。

import { describe, expect, it } from "vitest";

import {
  basename,
  breadcrumbSegments,
  isSubPath,
  joinPath,
  normalizePath,
  parentOf,
  samePath,
} from "./pathUtils";

describe("normalizePath", () => {
  it("统一分隔符并去尾部反斜杠", () => {
    expect(normalizePath("D:/Develop/task_dock/")).toBe("D:\\Develop\\task_dock");
    expect(normalizePath("C:\\")).toBe("C:\\");
    expect(normalizePath("c:\\")).toBe("c:\\");
  });
});

describe("basename / parentOf", () => {
  it("取末段与父目录", () => {
    expect(basename("D:\\a\\MyGame")).toBe("MyGame");
    expect(basename("D:\\")).toBe("D:盘");
    expect(parentOf("D:\\a\\MyGame")).toBe("D:\\a");
    expect(parentOf("D:\\MyGame")).toBe("D:\\");
    expect(parentOf("D:\\")).toBeNull();
  });
});

describe("joinPath / samePath / isSubPath", () => {
  it("拼接与大小写不敏感比较", () => {
    expect(joinPath("D:\\a", "b.txt")).toBe("D:\\a\\b.txt");
    expect(samePath("D:\\A\\b", "d:\\a\\B")).toBe(true);
    expect(isSubPath("D:\\a", "D:\\a\\b\\c")).toBe(true);
    expect(isSubPath("D:\\a", "D:\\ab")).toBe(false);
    expect(isSubPath("D:\\a", "D:\\a")).toBe(false);
  });
});

describe("breadcrumbSegments", () => {
  it("盘符路径分段", () => {
    const segs = breadcrumbSegments("D:\\Games\\MyGame\\Source");
    expect(segs[0]).toEqual({ name: "D:盘", path: "D:\\" });
    expect(segs.map((s) => s.name)).toEqual(["D:盘", "Games", "MyGame", "Source"]);
    expect(segs[segs.length - 1].path).toBe("D:\\Games\\MyGame\\Source\\");
  });

  it("UNC 路径分段", () => {
    const segs = breadcrumbSegments("\\\\server\\share\\dir");
    expect(segs.map((s) => s.name)).toEqual(["server", "share", "dir"]);
    expect(segs[0].path).toBe("\\\\server");
  });
});
