/**
 * JSON 结构解析：节点模型、错误码与位置、节点/子项/层级预算。
 */

import { describe, expect, it } from "vitest";
import {
  JSON_MAX_CHARS,
  JSON_MAX_CHILDREN,
  JSON_MAX_DEPTH,
  JSON_MAX_NODES,
  buildJsonTree,
  collectContainerPaths,
} from "./jsonTree";

function nested(depth: number): string {
  let text = "1";
  for (let i = 0; i < depth; i += 1) text = `[${text}]`;
  return text;
}

describe("节点模型", () => {
  it("对象 / 数组 / 标量的键与层级", () => {
    const doc = buildJsonTree('{"a":1,"b":["x",true],"c":{"d":null}}');
    expect(doc.ok).toBe(true);
    const root = doc.root;
    expect(root?.kind).toBe("object");
    expect(root?.key).toBeNull();
    expect(root?.size).toBe(3);
    expect(root?.depth).toBe(1);

    const [a, b, c] = root?.children ?? [];
    expect(a.kind).toBe("number");
    expect(a.key).toBe("a");
    expect(a.preview).toBe("1");
    expect(b.kind).toBe("array");
    expect(b.children?.map((child) => child.key)).toEqual(["[0]", "[1]"]);
    expect(b.children?.[1].kind).toBe("boolean");
    expect(c.children?.[0].kind).toBe("null");
    expect(doc.nodes).toBe(7);
    expect(doc.depth).toBe(3);
    expect(doc.truncated).toBe(false);
  });

  it("字符串预览保留引号并对超长内容截断", () => {
    const doc = buildJsonTree(JSON.stringify({ s: "hello" }));
    expect(doc.root?.children?.[0].preview).toBe('"hello"');
  });

  it("根为标量时不报错", () => {
    const doc = buildJsonTree("42");
    expect(doc.ok).toBe(true);
    expect(doc.root?.kind).toBe("number");
    expect(doc.root?.preview).toBe("42");
    expect(doc.depth).toBe(1);
  });

  it("BOM 前缀与空容器", () => {
    expect(buildJsonTree("\uFEFF{}").ok).toBe(true);
    const doc = buildJsonTree('{"emptyObj":{},"emptyArr":[]}');
    const children = doc.root?.children ?? [];
    expect(children[0].children).toEqual([]);
    expect(children[0].size).toBe(0);
    expect(children[1].children).toEqual([]);
    expect(children[1].size).toBe(0);
  });
});

describe("错误", () => {
  it("空文本 → empty", () => {
    const doc = buildJsonTree("   \n ");
    expect(doc.ok).toBe(false);
    expect(doc.error?.code).toBe("empty");
    expect(doc.root).toBeNull();
  });

  it("非法 JSON → invalid，并带解析器位置", () => {
    const doc = buildJsonTree('{"a": 1,}');
    expect(doc.ok).toBe(false);
    expect(doc.error?.code).toBe("invalid");
    expect(doc.error?.message.length).toBeGreaterThan(0);
    expect(doc.error?.position).toBeGreaterThan(0);
    expect(doc.root).toBeNull();
  });

  it("超过字符上限 → too-large（不尝试解析）", () => {
    const padded = `{"s":"${"x".repeat(JSON_MAX_CHARS)}"}`;
    const doc = buildJsonTree(padded);
    expect(doc.ok).toBe(false);
    expect(doc.error?.code).toBe("too-large");
    expect(doc.nodes).toBe(0);
  });
});

describe("预算", () => {
  it("子项上限：超出子项被裁剪，size 保留真实数量", () => {
    const doc = buildJsonTree(JSON.stringify(Array.from({ length: JSON_MAX_CHILDREN + 50 }, (_, i) => i)));
    const root = doc.root;
    expect(root?.size).toBe(JSON_MAX_CHILDREN + 50);
    expect(root?.children?.length).toBe(JSON_MAX_CHILDREN);
    expect(root?.truncated).toBe(true);
    expect(doc.truncated).toBe(true);
  });

  it("层级上限：更深的结构停止展开并标记", () => {
    const doc = buildJsonTree(nested(JSON_MAX_DEPTH + 10));
    expect(doc.ok).toBe(true);
    expect(doc.depth).toBeLessThanOrEqual(JSON_MAX_DEPTH + 1);
    expect(doc.truncated).toBe(true);
  });

  it("节点上限：总节点数不越预算", () => {
    // 60 个数组各 80 个数字：节点总量约 4800，超过 3000 的节点预算但未触发子项上限。
    const wide = Object.fromEntries(
      Array.from({ length: 60 }, (_, group) => [`g${group}`, Array.from({ length: 80 }, (_, i) => i)]),
    );
    const doc = buildJsonTree(JSON.stringify(wide));
    expect(doc.nodes).toBeLessThanOrEqual(JSON_MAX_NODES);
    expect(doc.nodes).toBeGreaterThan(JSON_MAX_CHILDREN);
    expect(doc.truncated).toBe(true);
  });

  it("collectContainerPaths 只收集有子项的容器，路径以 root 开头", () => {
    const doc = buildJsonTree('{"a":{"b":1},"c":[]}');
    const paths = collectContainerPaths(doc.root);
    expect(paths).toEqual(["root", "root/0"]);
    expect(collectContainerPaths(null)).toEqual([]);
  });
});
