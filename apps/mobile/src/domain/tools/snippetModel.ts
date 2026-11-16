// 代码片段的纯模型：语言清单、标签归一化、本地搜索匹配、排序与导出文本。
//
// 说明：片段是**本机数据**，不进同步协议。跨设备只有两条真实路径：
// 1) 导出文本文件 → 系统分享 / 保存；
// 2) 发送到电脑（复用文件互传 TLS 通道）。
// 因此这里没有任何「已同步」字段，UI 也只能展示「已保存在本机 / 已发送到电脑」。

export interface Snippet {
  id: string;
  title: string;
  language: string;
  content: string;
  tags: string[];
  /** 可选备注：说明用途/来源，不参与复制正文 */
  note: string;
  favorite: boolean;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
  deletedAt: number | null;
}

export interface SnippetDraft {
  title: string;
  language: string;
  content: string;
  tags: string[];
  note: string;
  favorite: boolean;
  pinned: boolean;
}

export const SNIPPET_LANGUAGES = [
  { id: "text", label: "纯文本", extension: "txt" },
  { id: "javascript", label: "JavaScript", extension: "js" },
  { id: "typescript", label: "TypeScript", extension: "ts" },
  { id: "python", label: "Python", extension: "py" },
  { id: "java", label: "Java", extension: "java" },
  { id: "kotlin", label: "Kotlin", extension: "kt" },
  { id: "go", label: "Go", extension: "go" },
  { id: "rust", label: "Rust", extension: "rs" },
  { id: "sql", label: "SQL", extension: "sql" },
  { id: "shell", label: "Shell", extension: "sh" },
  { id: "json", label: "JSON", extension: "json" },
  { id: "yaml", label: "YAML", extension: "yaml" },
  { id: "html", label: "HTML", extension: "html" },
  { id: "css", label: "CSS", extension: "css" },
  { id: "markdown", label: "Markdown", extension: "md" },
  { id: "dockerfile", label: "Dockerfile", extension: "dockerfile" },
  { id: "other", label: "其他", extension: "txt" },
] as const;

export type SnippetLanguageId = (typeof SNIPPET_LANGUAGES)[number]["id"];

export function languageLabel(id: string): string {
  return SNIPPET_LANGUAGES.find((language) => language.id === id)?.label ?? id;
}

export function languageExtension(id: string): string {
  return SNIPPET_LANGUAGES.find((language) => language.id === id)?.extension ?? "txt";
}

/** 标签输入归一化：逗号/中文逗号/换行分隔，去重（大小写不敏感），最多 12 个、单个 24 字符。 */
export function normalizeTags(input: string | readonly string[]): string[] {
  const raw = typeof input === "string" ? input.split(/[,，\n\r]+/) : input;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const tag = item.trim().slice(0, 24);
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= 12) break;
  }
  return out;
}

export function formatTags(tags: readonly string[]): string {
  return tags.join(", ");
}

/** 搜索：标题 / 正文 / 语言标签 / 标签，全部大小写不敏感；查询按空白拆成多个词，要求全部命中。 */
export function matchesSnippetQuery(snippet: Snippet, query: string): boolean {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const haystack = [
    snippet.title,
    snippet.content,
    languageLabel(snippet.language),
    snippet.language,
    snippet.tags.join(" "),
    snippet.note,
  ]
    .join("\n")
    .toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

/** 列表排序：置顶 → 收藏 → 最近使用/更新时间；与 SQL 的 ORDER BY 语义一致。 */
export function sortSnippets(snippets: readonly Snippet[]): Snippet[] {
  return [...snippets].sort((left, right) => {
    if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
    if (left.favorite !== right.favorite) return left.favorite ? -1 : 1;
    const leftRecent = left.lastUsedAt ?? left.updatedAt;
    const rightRecent = right.lastUsedAt ?? right.updatedAt;
    if (leftRecent !== rightRecent) return rightRecent - leftRecent;
    return right.updatedAt - left.updatedAt;
  });
}

export interface SnippetFilter {
  query?: string;
  language?: string | null;
  favoriteOnly?: boolean;
}

export function filterSnippets(snippets: readonly Snippet[], filter: SnippetFilter): Snippet[] {
  return sortSnippets(
    snippets.filter((snippet) => {
      if (filter.favoriteOnly && !snippet.favorite) return false;
      if (filter.language && snippet.language !== filter.language) return false;
      if (filter.query && !matchesSnippetQuery(snippet, filter.query)) return false;
      return true;
    }),
  );
}

/** 导出文件名：标题清洗为可用文件名，扩展名取自语言。 */
export function snippetFileName(snippet: Snippet): string {
  const stem =
    snippet.title
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .replace(/[\\/:*?"<>|]/g, "_")
      .replace(/\s+/g, "-")
      .trim()
      .slice(0, 48) || "snippet";
  return `${stem}.${languageExtension(snippet.language)}`;
}

/** 导出内容：正文原样输出（不插注释头，避免破坏可直接运行的代码）。 */
export function snippetToPlainText(snippet: Snippet): string {
  return snippet.content;
}

/** 正文首行摘要：列表与回收站共用，避免在两处各写一份截断逻辑。 */
export function snippetSummary(snippet: Snippet, max = 80): string {
  const firstLine = snippet.content.split(/\r?\n/).find((line) => line.trim().length > 0) ?? "";
  const compact = firstLine.replace(/\s+/g, " ").trim();
  if (!compact) return "（空片段）";
  return compact.length > max ? `${compact.slice(0, max)}…` : compact;
}

/** 新建片段的默认草稿。 */
export function emptySnippetDraft(): SnippetDraft {
  return { title: "", language: "text", content: "", tags: [], note: "", favorite: false, pinned: false };
}

/** 草稿是否可保存：正文非空即可（标题允许自动生成）。 */
export function canSaveSnippet(draft: SnippetDraft): boolean {
  return draft.content.trim().length > 0;
}

/** 无标题时用正文首行生成默认标题（不写「未命名」，列表里更有辨识度）。 */
export function draftTitle(draft: SnippetDraft): string {
  const title = draft.title.trim();
  if (title) return title;
  const first = draft.content.split(/\r?\n/).find((line) => line.trim().length > 0) ?? "";
  const compact = first.replace(/\s+/g, " ").trim();
  return compact ? compact.slice(0, 40) : "未命名片段";
}
