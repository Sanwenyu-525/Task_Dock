/**
 * 项目资源领域逻辑：只建立引用，不复制资源；解除关联不删除源对象。
 *
 * 资源类型包括知识库、Skill、MCP、Agent、工具、模板、工作流；能力通过
 * `CapabilityResourceRelation` 指向资源，二者不能混为一谈。
 */

import type {
  CapabilityResourceRelation,
  ProjectResourceLink,
  ResourceAvailability,
  ResourceDeleteBlocker,
  ResourceKind,
  ResourceProbe,
  ResourceRef,
} from "./types";

function resourceKey(resource: Pick<ResourceRef, "kind" | "id">): string {
  return `${resource.kind}:${resource.id}`;
}

/**
 * 关联资源到项目；重复关联返回既有链接（幂等），不复制资源本体。
 */
export function linkResourceToProject(
  projectId: string,
  resource: ResourceRef,
  existing: ProjectResourceLink[] = [],
  now: string = new Date().toISOString(),
): ProjectResourceLink {
  if (!projectId.trim()) throw new Error("projectId 不能为空");
  if (!resource.id.trim()) throw new Error("resourceId 不能为空");

  const current = existing.find(
    (link) => link.projectId === projectId && resourceKey(link.resource) === resourceKey(resource),
  );
  if (current) return current;

  return {
    id: `${projectId}:${resourceKey(resource)}`,
    projectId,
    resource: { ...resource },
    linkedAt: now,
    lastVerifiedAt: null,
    availability: "unknown",
  };
}

export function unlinkResourceFromProject(
  links: ProjectResourceLink[],
  linkId: string,
): { removed: ProjectResourceLink | null; remaining: ProjectResourceLink[] } {
  const target = links.find((link) => link.id === linkId) ?? null;
  if (!target) return { removed: null, remaining: [...links] };
  return { removed: target, remaining: links.filter((link) => link.id !== linkId) };
}

export function getProjectResources(
  projectId: string,
  links: ProjectResourceLink[],
  kind?: ResourceKind,
): ProjectResourceLink[] {
  return links.filter((link) => link.projectId === projectId && (!kind || link.resource.kind === kind));
}

/**
 * 找出某能力可调用的资源。关系表由能力中心维护，这里不推断资源归属。
 */
export function findResourcesByCapability(
  capabilityId: string,
  links: ProjectResourceLink[],
  relations: CapabilityResourceRelation[],
): ProjectResourceLink[] {
  const keys = new Set(
    relations
      .filter((relation) => relation.capabilityId === capabilityId)
      .map((relation) => `${relation.resourceKind}:${relation.resourceId}`),
  );
  return links.filter((link) => keys.has(resourceKey(link.resource)));
}

/**
 * 校验资源真实可用性：探测不存在 → `unavailable`；离线/未知保留探测结果。
 */
export function validateResourceAvailability(probe: ResourceProbe): ResourceAvailability {
  if (!probe.exists) return "unavailable";
  return probe.availability;
}

/**
 * 删除共享资源前检查引用；被任何项目引用即阻止删除。
 */
export function findResourceDeleteBlockers(
  resources: ResourceRef[],
  links: ProjectResourceLink[],
): ResourceDeleteBlocker[] {
  const blockers: ResourceDeleteBlocker[] = [];

  for (const resource of resources) {
    const projectIds = Array.from(
      new Set(
        links
          .filter((link) => resourceKey(link.resource) === resourceKey(resource))
          .map((link) => link.projectId),
      ),
    ).sort();
    if (projectIds.length > 0) blockers.push({ resource: { ...resource }, projectIds });
  }

  return blockers;
}
