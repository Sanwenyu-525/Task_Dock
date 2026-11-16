//! 专业模块挂载点（2026-11-16，集成负责人独占）：壳层与五条线的唯一接触面。
//!
//! 职责边界：
//! - 壳层（`ProjectWorkspacePanel`）负责 tab、项目上下文、归档态、错误横幅与导航门禁；
//! - 本组件只做「按 kind + moduleId 找实现，找不到就诚实降级」；
//! - 专业模块自己负责内容区，不重复实现导航与项目查询。

import type { CreativeModuleId, CreativeModuleProps } from "./types";
import { CREATIVE_MODULE_PENDING_TEXT } from "./types";
import { resolveCreativeModule } from "./moduleRegistry";

export interface CreativeModuleHostProps extends CreativeModuleProps {
  moduleId: CreativeModuleId;
}

export default function CreativeModuleHost({ moduleId, kind, ...rest }: CreativeModuleHostProps) {
  const Component = resolveCreativeModule(kind, moduleId);
  if (!Component) {
    return (
      <div className="ws-state" data-tone="muted" role="status">
        <span className="ws-badge">未接入</span>
        <span>{CREATIVE_MODULE_PENDING_TEXT}</span>
      </div>
    );
  }
  return <Component {...rest} kind={kind} />;
}
