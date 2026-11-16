// 产品整改后的工具目录契约：只暴露有移动场景价值的 5 个工具。
// 这里钉住「下架、降级、合并」三类事实，防止后续又把手搓输入型工具加回首页。
import { describe, expect, it } from "vitest";

import { entryById } from "../../../lib/entryRegistry";
import { ROUTE_KEYS } from "../../../lib/nav";
import { DEV_TOOLS, TOOL_CATEGORIES, matchTools, toolById } from "../toolCatalog";

const EXPECTED_IDS = [
  "tool.image-compress",
  "tool.color-picker",
  "tool.snippet",
  "tool.docs",
  "tool.text",
];

const REMOVED_IDS = [
  "tool.api",
  "tool.regex",
  "tool.diff",
  "tool.json",
  "tool.timestamp",
  "tool.github",
];

describe("工具目录", () => {
  it("只保留 5 个有移动场景的工具", () => {
    expect(DEV_TOOLS.map((tool) => tool.id).sort()).toEqual([...EXPECTED_IDS].sort());
  });

  it("已下架工具不再出现在目录与搜索里", () => {
    for (const id of REMOVED_IDS) {
      expect(toolById(id), `${id} 不应还能被目录查到`).toBeUndefined();
    }
    for (const keyword of ["API", "正则", "代码对比", "时间戳单独"]) {
      expect(matchTools(keyword), `${keyword} 不应返回结果`).toHaveLength(0);
    }
  });

  it("合并后的入口仍可通过新名称搜索", () => {
    expect(matchTools("GitHub").map((tool) => tool.id)).toEqual(["tool.docs"]);
    expect(matchTools("JSON").map((tool) => tool.id)).toEqual(["tool.text"]);
    expect(matchTools("图片").map((tool) => tool.id)).toEqual([
      "tool.image-compress",
      "tool.color-picker",
    ]);
  });

  it("每条目录路由都真实存在，且与入口注册表一致", () => {
    for (const tool of DEV_TOOLS) {
      expect(ROUTE_KEYS.includes(tool.route), `${tool.id} 路由不存在 ${tool.route}`).toBe(true);
      const entry = entryById(tool.id);
      expect(entry, `${tool.id} 缺少注册表入口`).toBeDefined();
      expect(entry?.launch, `${tool.id} 缺少落点`).toEqual({ kind: "route", route: tool.route });
      expect(entry?.defaultVisible, `${tool.id} 不应默认占首页`).toBe(false);
    }
  });

  it("分类都有归属，高级工具只放低频文本处理", () => {
    for (const category of TOOL_CATEGORIES) {
      expect(DEV_TOOLS.some((tool) => tool.category === category.id)).toBe(true);
    }
    expect(DEV_TOOLS.filter((tool) => tool.category === "advanced").map((tool) => tool.id)).toEqual([
      "tool.text",
    ]);
    expect(DEV_TOOLS.filter((tool) => tool.category === "image").map((tool) => tool.id)).toEqual([
      "tool.image-compress",
      "tool.color-picker",
    ]);
  });
});
