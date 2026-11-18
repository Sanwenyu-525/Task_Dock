import { describe, expect, it } from "vitest";

import {
  findResourceDeleteBlockers,
  findResourcesByCapability,
  getProjectResources,
  linkResourceToProject,
  unlinkResourceFromProject,
  validateResourceAvailability,
} from "./resource";
import type { ProjectResourceLink, ResourceRef } from "./types";

const NOW = "2026-11-18T09:00:00.000Z";

function resource(overrides: Partial<ResourceRef> = {}): ResourceRef {
  return { kind: "skill", id: "skill-writing", label: "长篇写作 Skill", ...overrides };
}

function link(overrides: Partial<ProjectResourceLink> = {}): ProjectResourceLink {
  return {
    id: "p1:skill:skill-writing",
    projectId: "p1",
    resource: resource(),
    linkedAt: NOW,
    lastVerifiedAt: null,
    availability: "unknown",
    ...overrides,
  };
}

describe("linkResourceToProject", () => {
  it("重复关联返回既有链接，不复制资源", () => {
    const existing = [link()];
    const result = linkResourceToProject("p1", resource(), existing, "2026-11-19T00:00:00.000Z");
    expect(result).toBe(existing[0]);
    expect(result.resource).toEqual(resource());
  });

  it("同一资源可以关联多个项目，但各自生成独立链接", () => {
    const p1 = linkResourceToProject("p1", resource(), [], NOW);
    const p2 = linkResourceToProject("p2", resource(), [p1], NOW);
    expect(p1.id).not.toBe(p2.id);
    expect(p2.projectId).toBe("p2");
  });

  it("资源 ID 为空时拒绝", () => {
    expect(() => linkResourceToProject("p1", resource({ id: " " }), [], NOW)).toThrow("resourceId 不能为空");
  });
});

describe("unlinkResourceFromProject", () => {
  it("只移除链接，不删除共享资源", () => {
    const links = [link()];
    const result = unlinkResourceFromProject(links, "p1:skill:skill-writing");
    expect(result.removed?.resource.id).toBe("skill-writing");
    expect(result.remaining).toHaveLength(0);
    expect(links).toHaveLength(1);
  });

  it("重复解除是幂等的", () => {
    const result = unlinkResourceFromProject([], "missing");
    expect(result.removed).toBeNull();
  });
});

describe("资源查询", () => {
  it("按项目与类型过滤", () => {
    const links = [link(), link({ id: "p1:mcp:m1", resource: resource({ kind: "mcp", id: "m1" }) })];
    expect(getProjectResources("p1", links)).toHaveLength(2);
    expect(getProjectResources("p1", links, "mcp")).toHaveLength(1);
    expect(getProjectResources("p2", links)).toHaveLength(0);
  });

  it("按能力关系找到可调用资源，不猜测归属", () => {
    const links = [link(), link({ id: "p1:tool:t1", resource: resource({ kind: "tool", id: "t1" }) })];
    const relations = [
      { capabilityId: "c1", resourceKind: "skill" as const, resourceId: "skill-writing" },
      { capabilityId: "c1", resourceKind: "tool" as const, resourceId: "t1" },
    ];
    expect(findResourcesByCapability("c1", links, relations)).toHaveLength(2);
    expect(findResourcesByCapability("c2", links, relations)).toHaveLength(0);
  });

  it("探测不存在时判为不可用", () => {
    expect(
      validateResourceAvailability({
        resource: resource(),
        exists: false,
        availability: "available",
        checkedAt: NOW,
        detail: "",
      }),
    ).toBe("unavailable");
  });

  it("探测存在时保留真实可用性，包括未知", () => {
    expect(
      validateResourceAvailability({
        resource: resource(),
        exists: true,
        availability: "partial",
        checkedAt: NOW,
        detail: "",
      }),
    ).toBe("partial");
    expect(
      validateResourceAvailability({
        resource: resource(),
        exists: true,
        availability: "unknown",
        checkedAt: NOW,
        detail: "",
      }),
    ).toBe("unknown");
  });
});

describe("findResourceDeleteBlockers", () => {
  it("被多个项目引用时阻止删除，并列出项目", () => {
    const shared = resource();
    const links = [link(), link({ id: "p2:skill:skill-writing", projectId: "p2" })];
    const blockers = findResourceDeleteBlockers([shared], links);
    expect(blockers).toHaveLength(1);
    expect(blockers[0].projectIds).toEqual(["p1", "p2"]);
  });

  it("没有引用时允许删除", () => {
    expect(findResourceDeleteBlockers([resource()], [])).toHaveLength(0);
  });
});
