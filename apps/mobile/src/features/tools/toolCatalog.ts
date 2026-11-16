// 移动端效率工具目录（2026-11-16 产品整改后）。
//
// 产品原则：手机优先做「拍照、素材处理、快速复用、跨设备接力」，
// 不再把 JSON / 时间戳 / 编解码等低频输入型工具堆成独立首页入口。
//
// 约束：
// - id 一旦发布不改名（工作台布局存的就是它）；
// - route 必须是 ROUTE_KEYS 里真实存在的路由；
// - 只列出**有真实页面**的工具；API 调试、正则、代码对比已退出普通工具体系，
//   代码保留为非可见模块，不在目录/搜索/最近使用里出现。
import type { IconName } from "../../components/icons/AppIcon";
import type { RouteKey } from "../../lib/nav";

export type ToolCategoryId = "image" | "content" | "advanced";

export interface ToolDefinition {
  /** 稳定 id，同时作为入口 id（tool.<name>）与最近使用记录键 */
  id: string;
  route: RouteKey;
  title: string;
  description: string;
  icon: IconName;
  category: ToolCategoryId;
}

export const TOOL_CATEGORIES: { id: ToolCategoryId; label: string; icon: IconName }[] = [
  { id: "image", label: "图片与素材", icon: "gallery" },
  { id: "content", label: "资料与内容", icon: "folder" },
  { id: "advanced", label: "高级工具", icon: "wrench" },
];

export const DEV_TOOLS: ToolDefinition[] = [
  {
    id: "tool.image-compress",
    route: "tool_image_compress",
    title: "图片压缩",
    description: "相册、素材库或分享图片，真正重编码后保存或发送电脑",
    icon: "fileImage",
    category: "image",
  },
  {
    id: "tool.color-picker",
    route: "tool_color_picker",
    title: "取色器",
    description: "从照片或截图读取真实像素，HEX / RGB / HSL 一键复制",
    icon: "sparkles",
    category: "image",
  },
  {
    id: "tool.snippet",
    route: "tool_snippets",
    title: "常用片段",
    description: "快速查看、搜索、复制和分享常用文本、命令与配置",
    icon: "snippet",
    category: "content",
  },
  {
    id: "tool.docs",
    route: "tool_resources",
    title: "资料与链接",
    description: "项目资料与 GitHub 链接的统一入口，支持收藏和最近查阅",
    icon: "fileDoc",
    category: "content",
  },
  {
    id: "tool.text",
    route: "tool_text",
    title: "文本处理",
    description: "JSON、时间戳与编解码；低频工具，按需进入",
    icon: "codeTerminal",
    category: "advanced",
  },
];

const BY_ID = new Map(DEV_TOOLS.map((tool) => [tool.id, tool]));

export function toolById(id: string): ToolDefinition | undefined {
  return BY_ID.get(id);
}

export function toolsInCategory(category: ToolCategoryId): ToolDefinition[] {
  return DEV_TOOLS.filter((tool) => tool.category === category);
}

/** 关键词匹配：标题、说明、分类都参与（大小写不敏感）。 */
export function matchTools(query: string): ToolDefinition[] {
  const keyword = query.trim().toLowerCase();
  if (!keyword) return DEV_TOOLS;
  return DEV_TOOLS.filter((tool) => {
    const category = TOOL_CATEGORIES.find((item) => item.id === tool.category)?.label ?? "";
    return `${tool.title} ${tool.description} ${category}`.toLowerCase().includes(keyword);
  });
}
