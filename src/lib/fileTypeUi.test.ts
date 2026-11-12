import { describe, expect, it } from "vitest";
import {
  FileArchive,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  Folder,
  Link2,
} from "lucide-react";
import type { ShelfItem } from "./bridge";
import { shelfFileTypeUi } from "./fileTypeUi";

function item(over: Partial<ShelfItem> = {}): ShelfItem {
  return {
    id: "i1",
    kind: "file",
    display_name: "a.txt",
    source_kind: "picker",
    storage_mode: "reference",
    original_path: "D:\\src\\a.txt",
    managed_path: null,
    content: null,
    byte_size: 100,
    file_ext: "txt",
    favorite: false,
    pinned: false,
    exists_state: "ok",
    group_id: null,
    scene_id: null,
    note: "",
    expire_at: null,
    created_at: "2026-11-05T00:00:00Z",
    updated_at: "2026-11-05T00:00:00Z",
    ...over,
  };
}

describe("暂存文件类型展示", () => {
  it("按扩展名给出不同图标、短类型名与色调", () => {
    expect(shelfFileTypeUi(item({ display_name: "报告.pdf", file_ext: "pdf" }))).toMatchObject({
      icon: FileText,
      label: "PDF 文档",
      tone: "doc",
      ext: "pdf",
    });
    expect(shelfFileTypeUi(item({ display_name: "财务.xlsx", file_ext: "XLSX" }))).toMatchObject({
      icon: FileSpreadsheet,
      label: "XLSX 表格",
      tone: "sheet",
    });
    expect(shelfFileTypeUi(item({ display_name: "截图.png", file_ext: "png" }))).toMatchObject({
      icon: FileImage,
      label: "PNG 图片",
      tone: "image",
    });
    expect(shelfFileTypeUi(item({ display_name: "归档.zip", file_ext: null }))).toMatchObject({
      icon: FileArchive,
      label: "ZIP 压缩包",
      tone: "archive",
    });
    expect(shelfFileTypeUi(item({ display_name: "main.ts", file_ext: null }))).toMatchObject({
      icon: FileCode,
      label: "TS 代码",
      tone: "code",
    });
  });

  it("后端 file_ext 优先于显示名，且做大小写/前导点归一", () => {
    const type = shelfFileTypeUi(
      item({ display_name: "名字没有后缀", file_ext: ".PDF" }),
    );
    expect(type.label).toBe("PDF 文档");
    expect(type.ext).toBe("pdf");
  });

  it("文件夹/链接/文本使用各自图标，不按扩展名误判", () => {
    expect(
      shelfFileTypeUi(
        item({ kind: "folder", display_name: "项目目录", original_path: null, file_ext: null }),
      ),
    ).toMatchObject({
      icon: Folder,
      label: "文件夹",
      tone: "folder",
      ext: null,
    });
    expect(shelfFileTypeUi(item({ kind: "link", display_name: "示例链接" }))).toMatchObject({
      icon: Link2,
      label: "链接",
      tone: "link",
    });
    expect(
      shelfFileTypeUi(item({ kind: "text", display_name: "会议纪要.txt", file_ext: null })),
    ).toMatchObject({
      label: "文本",
      tone: "text",
      ext: "txt",
    });
  });

  it("未知/缺失扩展名不臆造类型：普通文件保持通用图标", () => {
    expect(
      shelfFileTypeUi(
        item({ display_name: "README", original_path: null, file_ext: null }),
      ),
    ).toMatchObject({
      label: "文件",
      tone: "other",
      ext: null,
    });
    expect(
      shelfFileTypeUi(
        item({
          kind: "image",
          display_name: "无后缀图片",
          original_path: null,
          file_ext: null,
        }),
      ),
    ).toMatchObject({
      icon: FileImage,
      label: "图片",
      tone: "image",
    });
  });

  it("像版本号的点号不会被当成扩展名", () => {
    expect(
      shelfFileTypeUi(item({ display_name: "发布 2026.11", file_ext: null, original_path: null })),
    ).toMatchObject({ label: "文件", ext: null });
  });
});
