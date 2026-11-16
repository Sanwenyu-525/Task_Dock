// 开发者工具目录：工具页、入口注册表与页面记录「最近使用」共用同一份稳定 id。
//
// 约束：
// - id 一旦发布不改名（工作台布局存的就是它）；
// - route 必须是 ROUTE_KEYS 里真实存在的路由（entryRegistry 单测会断言）；
// - 只列出**已经有真实页面**的工具；未完成的工具不放进目录，
//   避免出现「图标能点、进去是空白」的假入口。
import type { IconName } from "../../components/icons/AppIcon";
import type { RouteKey } from "../../lib/nav";

export type ToolCategoryId = "text" | "image" | "resource";

export interface ToolDefinition {
  /** 稳定 id，同时作为入口 id（tool.<name>）与最近使用记录键 */
  id: string;
  route: RouteKey;
  title: string;
  description: string;
  icon: IconName;
  category: ToolCategoryId;
}

export const TOOL_CATEGORIES: { id: ToolCategoryId; label: string }[] = [
  { id: "text", label: "文本与代码" },
  { id: "image", label: "图片处理" },
  { id: "resource", label: "开发资源" },
];

export const DEV_TOOLS: ToolDefinition[] = [
  {
    id: "tool.snippet",
    route: "tool_snippets",
    title: "代码片段",
    description: "保存常用代码与命令，一键复制、导出或发送到电脑",
    icon: "snippet",
    category: "text",
  },
  {
    id: "tool.json",
    route: "tool_json",
    title: "JSON 格式化",
    description: "格式化、压缩、校验与树形查看；超大数字不改值",
    icon: "json",
    category: "text",
  },
  {
    id: "tool.timestamp",
    route: "tool_timestamp",
    title: "时间戳转换",
    description: "秒 / 毫秒 / ISO / 本地与 UTC 互转，日历字段严格校验",
    icon: "clock",
    category: "text",
  },
  {
    id: "tool.text",
    route: "tool_text_codec",
    title: "文本编解码",
    description: "URL、Base64、Unicode 转义与换行格式，严格校验非法输入",
    icon: "codeTerminal",
    category: "text",
  },
  {
    id: "tool.regex",
    route: "tool_regex",
    title: "正则测试",
    description: "线性时间引擎，匹配高亮、捕获组与替换预览",
    icon: "regex",
    category: "text",
  },
  {
    id: "tool.diff",
    route: "tool_diff",
    title: "代码对比",
    description: "行级差异、忽略空白、只看差异与差异统计",
    icon: "code",
    category: "text",
  },
  {
    id: "tool.image-compress",
    route: "tool_image_compress",
    title: "图片压缩",
    description: "真正重编码，批量处理，压缩前后大小对比",
    icon: "fileImage",
    category: "image",
  },
  {
    id: "tool.color-picker",
    route: "tool_color_picker",
    title: "取色器",
    description: "读取真实像素，HEX/RGB/HSL、对比度与最近取色",
    icon: "sparkles",
    category: "image",
  },
  {
    id: "tool.api",
    route: "tool_api",
    title: "API 调试",
    description: "构建请求、导入 cURL、查看历史；真实发送待安全审查",
    icon: "api",
    category: "resource",
  },
  {
    id: "tool.docs",
    route: "tool_docs",
    title: "项目资料",
    description: "常用文档链接、Markdown/TXT 预览与系统应用打开",
    icon: "fileDoc",
    category: "resource",
  },
  {
    id: "tool.github",
    route: "tool_github",
    title: "GitHub 入口",
    description: "保存常用仓库链接，打开仓库 / Issue / PR 并记录最近访问",
    icon: "code",
    category: "resource",
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
