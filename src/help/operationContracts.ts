//! 高影响操作契约：明确哪些实现文件变化时必须复核对应教程。
//!
//! 每次改动登记的源文件并改变用户操作、安全或权限语义时，递增 version；
//! 教程完成人工复核后，同步更新文章的 reviewedOperationContractVersions。
//! 该映射只覆盖需要发布前人工核对的关键流程，不扫描全仓 Git diff。

export interface HelpOperationContract {
  version: number;
  articleIds: readonly string[];
  sourceFiles: readonly string[];
  /** 过期可能让用户误解外部访问权限或数据暴露边界。 */
  sensitive?: boolean;
}

export const HELP_OPERATION_CONTRACTS: Readonly<Record<string, HelpOperationContract>> = {
  "core.scenario-workspace": {
    version: 1,
    articleIds: ["help.workflows.scenes"],
    sourceFiles: [
      "src/components/workflows/ScenarioWorkspaceView.tsx",
      "src/components/workflows/WorkflowsPanel.tsx",
      "src-tauri/src/commands/scenario.rs",
      "src-tauri/src/workflows/engine.rs",
      "src/lib/bridge.ts",
    ],
  },
  "core.one-click-workflow": {
    version: 2,
    articleIds: ["help.workflows.one-click"],
    sourceFiles: [
      "src/components/workflows/WorkflowEditorView.tsx",
      "src/components/workflows/WorkflowsPanel.tsx",
      "src-tauri/src/workflows/engine.rs",
      "src-tauri/src/workflows/store.rs",
      "src/lib/bridge.ts",
    ],
  },
  "core.file-shelf": {
    version: 1,
    articleIds: ["help.capture.shelf"],
    sourceFiles: [
      "src/components/shelf/ShelfWorkspace.tsx",
      "src/components/shelf/ShelfDetail.tsx",
      "src-tauri/src/shelf/mod.rs",
      "src/lib/bridge.ts",
    ],
  },
  "agent.mcp-server": {
    version: 2,
    articleIds: ["help.agents.mcp-authorization"],
    sourceFiles: [
      "src-tauri/src/mcp/auth.rs",
      "src-tauri/src/mcp/audit.rs",
      "src-tauri/src/mcp/bridge.rs",
      "src-tauri/src/mcp/commands.rs",
      "src-tauri/src/mcp/config.rs",
      "src-tauri/src/mcp/mod.rs",
      "src-tauri/src/mcp/protocol.rs",
      "src-tauri/src/mcp/tools.rs",
      "src-tauri/src/db/mod.rs",
    ],
    sensitive: true,
  },
};
