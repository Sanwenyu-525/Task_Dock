import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import { HELP_ARTICLES } from "../content";
import { HELP_OPERATION_CONTRACTS } from "../operationContracts";
import { inspectHelpHealth } from "../health";

function changedOperationFiles(): string[] {
  const sources = [...new Set(Object.values(HELP_OPERATION_CONTRACTS).flatMap((contract) => contract.sourceFiles))];
  try {
    const tracked = execFileSync("git", ["diff", "--name-only", "HEAD", "--", ...sources], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split(/\r?\n/)
      .map((path) => path.trim())
      .filter(Boolean);
    const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "--", ...sources], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split(/\r?\n/)
      .map((path) => path.trim())
      .filter(Boolean);
    return [...new Set([...tracked, ...untracked])].sort();
  } catch {
    // 源码归档包没有 Git 元数据时，静态契约和显式版本号检查仍然有效。
    return [];
  }
}

describe("帮助健康度与变更影响识别", () => {
  it("help:check 汇总教程覆盖、待复核、翻译缺失和受监控源文件变更", () => {
    const changed = changedOperationFiles();
    const issues = inspectHelpHealth(HELP_ARTICLES, changed);
    const blockers = issues.filter((issue) => issue.severity === "blocker");
    const warnings = issues.filter((issue) => issue.severity === "warning");
    const codes = new Set(warnings.map((issue) => issue.code));

    expect(blockers, blockers.map((issue) => issue.message).join("\n")).toEqual([]);
    // 2026-11-08 收口后的目标状态：en-US 正文全覆盖、可见功能全关联教程、
    // 操作契约版本全部登记。剩余 warning 只允许两类：
    // 1. operation-source-changed —— 并行会话在途文件变化（登记源文件 dirty）；
    // 2. article-needs-review —— 仅 MCP 教程：其敏感契约源文件（db/mod.rs）有在途改动，
    //    转 verified 会升级为阻断，故如实保持待复核（正文已按当前源码复核并更新）。
    expect(codes.has("translation-missing")).toBe(false);
    expect(codes.has("visible-feature-without-guide")).toBe(false);
    expect(codes.has("operation-contract-version-mismatch")).toBe(false);
    for (const warning of warnings) {
      expect(
        ["article-needs-review", "operation-source-changed"],
        `不允许保留的提示类型：${warning.code} ${warning.message}`,
      ).toContain(warning.code);
    }
    for (const warning of warnings.filter((item) => item.code === "article-needs-review")) {
      expect(
        warning.articleId,
        "仅 MCP 教程因敏感契约门禁保持待复核",
      ).toBe("help.agents.mcp-authorization");
    }
    console.info(
      `[help:check] 文章 ${HELP_ARTICLES.length} 篇；提示 ${warnings.length} 项（待复核/缺翻译/可见功能缺帮助/源文件变化）。` +
        (changed.length ? ` 受监控源文件变化：${changed.join(", ")}` : ""),
    );
    for (const issue of warnings) console.info(`[help:check] ${issue.message}`);
  });

  it("已删除功能或路由引用会进入阻断级健康问题", () => {
    const sample = HELP_ARTICLES.find((article) => article.id === "help.agents.mcp-authorization")!;
    const broken = {
      ...sample,
      relatedFeatureIds: [...sample.relatedFeatureIds, "feature.deleted"],
      relatedRouteIds: [...sample.relatedRouteIds, "route.deleted"],
    };
    const issues = inspectHelpHealth(
      HELP_ARTICLES.map((article) => (article.id === sample.id ? broken : article)),
    );

    expect(issues.some((issue) => issue.code === "deleted-feature-reference" && issue.featureId === "feature.deleted")).toBe(true);
    expect(issues.some((issue) => issue.code === "deleted-route-reference" && issue.articleId === sample.id)).toBe(true);
  });

  it("敏感操作源文件变化后仍标记 verified 会产生阻断级问题", () => {
    const sample = HELP_ARTICLES.find((article) => article.id === "help.agents.mcp-authorization")!;
    const falselyVerified = { ...sample, status: "verified" as const };
    const issues = inspectHelpHealth(
      HELP_ARTICLES.map((article) => (article.id === sample.id ? falselyVerified : article)),
      ["src-tauri/src/mcp/tools.rs"],
    );

    expect(
      issues.some(
        (issue) =>
          issue.code === "operation-source-changed" &&
          issue.articleId === sample.id &&
          issue.severity === "blocker",
      ),
    ).toBe(true);
  });

  it("MCP 审计、模块装配和数据库迁移变化也会触发教程复核", () => {
    for (const changedFile of [
      "src-tauri/src/mcp/audit.rs",
      "src-tauri/src/mcp/mod.rs",
      "src-tauri/src/db/mod.rs",
    ]) {
      const issues = inspectHelpHealth(HELP_ARTICLES, [changedFile]);
      expect(
        issues.some(
          (issue) =>
            issue.code === "operation-source-changed" &&
            issue.articleId === "help.agents.mcp-authorization",
        ),
        `${changedFile} 变化时应提示 MCP 教程复核`,
      ).toBe(true);
    }
  });

  it("工作流与暂存架操作源变化会提示人工复核", () => {
    for (const changedFile of [
      "src/components/workflows/WorkflowEditorView.tsx",
      "src-tauri/src/workflows/engine.rs",
      "src/components/workflows/ScenarioWorkspaceView.tsx",
      "src-tauri/src/commands/scenario.rs",
      "src/components/shelf/ShelfWorkspace.tsx",
      "src-tauri/src/shelf/mod.rs",
    ]) {
      const issues = inspectHelpHealth(HELP_ARTICLES, [changedFile]);
      expect(
        issues.some(
          (issue) => issue.code === "operation-source-changed" && issue.severity === "warning",
        ),
        `${changedFile} 变化时应提示相关教程复核`,
      ).toBe(true);
    }
  });

  it("操作契约版本未同步时产生阻断级问题", () => {
    const sample = HELP_ARTICLES.find((article) => article.id === "help.agents.mcp-authorization")!;
    const staleArticle = {
      ...sample,
      reviewedOperationContractVersions: {
        ...sample.reviewedOperationContractVersions,
        "agent.mcp-server": HELP_OPERATION_CONTRACTS["agent.mcp-server"].version - 1,
      },
    };
    const issues = inspectHelpHealth(
      HELP_ARTICLES.map((article) => (article.id === sample.id ? staleArticle : article)),
    );

    expect(
      issues.some(
        (issue) =>
          issue.code === "operation-contract-version-mismatch" &&
          issue.articleId === sample.id &&
          issue.severity === "blocker",
      ),
    ).toBe(true);
  });
});
