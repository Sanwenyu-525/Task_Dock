// 资料与链接聚合页（2026-11-16 产品整改）。
//
// 只做「查找、打开、保存链接」：项目资料与 GitHub 链接不再各占一个入口，
// 统一从这里进入；PDF / Office 继续交给系统应用，不开发手机 Office 阅读器。
import { useEffect } from "react";

import { recordToolUse } from "../../../db/toolUsage";
import type { AppNav } from "../../../lib/nav";
import { ToolHubCard } from "../shared/ToolHubCard";
import { ToolNote, ToolScreen, ToolSection } from "../shared/ToolUI";

export function ResourcesScreen({ nav, onBack }: { nav: AppNav; onBack: () => void }) {
  useEffect(() => {
    void recordToolUse("tool.docs");
  }, []);

  return (
    <ToolScreen
      title="资料与链接"
      subtitle="项目资料与 GitHub 链接的统一入口"
      onBack={onBack}
    >
      <ToolNote text="这里只保存链接和本机文件引用，不下载仓库、不缓存密码。PDF / Office 由系统应用打开；本机文件与在线链接分开标记。" />
      <ToolSection title="选择类型">
        <ToolHubCard
          title="项目资料"
          description="常用文档链接、Markdown / TXT 预览、收藏、最近查阅与关联任务"
          icon="fileDoc"
          onPress={() => nav.push("tool_docs")}
        />
        <ToolHubCard
          title="GitHub 链接"
          description="仓库 / Issue / PR 快捷打开、收藏与最近访问；不接 OAuth 或写权限 API"
          icon="code"
          onPress={() => nav.push("tool_github")}
        />
      </ToolSection>
    </ToolScreen>
  );
}
