/**
 * 通用拖入前端契约：类型窄化、落点可用性判定、事件载荷解析。
 *
 * 这里只测**纯函数**：不伪造原生事件，也不假设任何来源（浏览器/资源管理器/
 * 截图工具）一定会提供某种格式。判定错了会直接导致「链接被当成文件写进目录」
 * 或「网页图片被静默丢弃」，所以每条分支都要钉死。
 */

import { describe, expect, it } from "vitest";
import {
  DIRECTORY_REJECT_MESSAGE,
  canDropToDirectory,
  formatsLabel,
  labelOf,
  parseProbe,
  payloadCount,
  probeFromPaths,
  type DragPayloadView,
  type DragProbe,
} from "./dragPayload";

describe("labelOf：类型 → 人类可读标签", () => {
  it("已知类型各有稳定标签", () => {
    expect(labelOf("local-files")).toBe("files");
    expect(labelOf("virtual-files")).toBe("virtual");
    expect(labelOf("image")).toBe("image");
    expect(labelOf("url")).toBe("link");
    expect(labelOf("text")).toBe("text");
    // HTML 在提示层面等同文本：都只承诺「暂存文本」。
    expect(labelOf("html")).toBe("text");
    expect(labelOf("mixed")).toBe("mixed");
  });

  it("未知/空类型一律归为未识别，不猜成文件", () => {
    expect(labelOf("unsupported")).toBe("unsupported");
    expect(labelOf("")).toBe("unsupported");
    expect(labelOf("CF_FILECONTENTS")).toBe("unsupported");
  });
});

describe("canDropToDirectory：只有会变成真实文件的类型可以投递到目录", () => {
  const view = (kind: string, parts?: { kind: string; count: number; label: string }[]) =>
    ({ kind, parts }) as unknown as DragPayloadView;

  it("本地文件 / 虚拟文件 / 图片字节可投递", () => {
    expect(canDropToDirectory(view("local-files"))).toBe(true);
    expect(canDropToDirectory(view("virtual-files"))).toBe(true);
    expect(canDropToDirectory(view("image"))).toBe(true);
  });

  it("链接 / 文本 / HTML / 未识别一律拒绝（不做隐式转换）", () => {
    expect(canDropToDirectory(view("url"))).toBe(false);
    expect(canDropToDirectory(view("text"))).toBe(false);
    expect(canDropToDirectory(view("html"))).toBe(false);
    expect(canDropToDirectory(view("unsupported"))).toBe(false);
  });

  it("混合内容：只要含文件类就能投递，纯文本混合则不能", () => {
    expect(
      canDropToDirectory(
        view("mixed", [
          { kind: "local-files", count: 1, label: "1 个本地文件" },
          { kind: "text", count: 1, label: "1 段文本" },
        ]),
      ),
    ).toBe(true);
    expect(
      canDropToDirectory(
        view("mixed", [{ kind: "virtual-files", count: 2, label: "2 个虚拟文件" }]),
      ),
    ).toBe(true);
    expect(
      canDropToDirectory(
        view("mixed", [
          { kind: "url", count: 1, label: "1 个链接" },
          { kind: "text", count: 1, label: "1 段文本" },
        ]),
      ),
    ).toBe(false);
    // 后端字段缺失时按「不可投递」处理：宁可拒绝，也不写错东西。
    expect(canDropToDirectory(view("mixed", undefined))).toBe(false);
  });

  it("拒绝文案与后端一致（不含任何来源内容）", () => {
    expect(DIRECTORY_REJECT_MESSAGE).toBe("此内容不能直接投递到文件夹");
  });
});

describe("probeFromPaths：桥未安装时的降级探测", () => {
  it("有路径即可暂存、可投递", () => {
    const probe = probeFromPaths(["C:\\a.png"]);
    expect(probe).toMatchObject({
      kind: "local-files",
      count: 1,
      canShelf: true,
      canDirectory: true,
      formats: [],
    });
  });

  it("空路径不伪装成可投递", () => {
    const probe = probeFromPaths([]);
    expect(probe.kind).toBe("unsupported");
    expect(probe.canShelf).toBe(false);
    expect(probe.canDirectory).toBe(false);
  });
});

describe("parseProbe：异常载荷必须退化为「不可投递」", () => {
  const valid: DragProbe = {
    kind: "image",
    count: 2,
    canShelf: true,
    canDirectory: true,
    formats: ["PNG", "CF_HDROP"],
  };

  it("正常载荷原样解析", () => {
    expect(parseProbe(valid)).toEqual(valid);
  });

  it("非对象/缺少 kind 返回 null（调用方据此沿用默认提示）", () => {
    expect(parseProbe(null)).toBeNull();
    expect(parseProbe(undefined)).toBeNull();
    expect(parseProbe("image")).toBeNull();
    expect(parseProbe({ count: 1 })).toBeNull();
    expect(parseProbe({ kind: 42 })).toBeNull();
  });

  it("布尔必须是真正的 true：字符串 \"true\" 不算可投递", () => {
    const probe = parseProbe({ kind: "url", canShelf: "true", canDirectory: 1 });
    expect(probe).toMatchObject({ kind: "url", canShelf: false, canDirectory: false });
  });

  it("字段越界被收敛：负数条数归零、格式名只保留字符串且最多 8 项", () => {
    const probe = parseProbe({
      kind: "mixed",
      count: -3,
      canShelf: true,
      canDirectory: false,
      formats: ["A", "B", 7, null, "C", "D", "E", "F", "G", "H", "I", "J"],
    });
    expect(probe?.count).toBe(0);
    expect(probe?.formats).toEqual(["A", "B", "C", "D", "E", "F", "G", "H"]);
  });
});

describe("payloadCount / formatsLabel", () => {
  const item = { name: "a.png", size: 10, itemKind: "image" };

  it("文件类与图片按条数，混合按分项求和，单条类型为 1", () => {
    expect(
      payloadCount({ kind: "local-files", paths: ["C:\\a"], count: 3 }),
    ).toBe(3);
    expect(payloadCount({ kind: "image", items: [item], count: 2 })).toBe(2);
    expect(
      payloadCount({
        kind: "mixed",
        parts: [
          { kind: "image", count: 2, label: "2 张图片" },
          { kind: "text", count: 1, label: "1 段文本" },
        ],
      }),
    ).toBe(3);
    expect(payloadCount({ kind: "url", url: "https://example.com", isImage: false })).toBe(1);
    expect(payloadCount({ kind: "text", textPreview: "hi", chars: 2 })).toBe(1);
  });

  it("格式名只用于诊断展示：空探测结果为空白串", () => {
    const probe: DragProbe = {
      kind: "image",
      count: 1,
      canShelf: true,
      canDirectory: true,
      formats: ["PNG", "CF_HDROP"],
    };
    expect(formatsLabel(null)).toBe("");
    expect(formatsLabel({ ...probe, formats: [] })).toBe("");
    expect(formatsLabel(probe)).toBe("PNG · CF_HDROP");
  });
});
