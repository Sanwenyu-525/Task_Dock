//! 剪贴板 UI 展示辅助（纯函数）。

import { formatDayLabel, formatHM } from "./format";
import type { ClipboardGroup, ClipboardItem } from "./bridge";

export const CLIP_KIND_LABELS: Record<string, string> = {
  text: "文字",
  url: "链接",
  html: "富文本",
  image: "图片",
  files: "文件",
  group: "分组",
};

export function kindLabel(kind: string): string {
  return CLIP_KIND_LABELS[kind] ?? kind;
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 今天 14:03 · 昨天 09:12 · 10-26 18:00 */
export function clipboardTime(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${formatDayLabel(d, now)} ${formatHM(d)}`;
}

export function fileBaseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export function groupStatusLabel(status: string): string {
  if (status === "collecting") return "收集中";
  if (status === "closed") return "已结束";
  return status;
}

export function groupModeLabel(mode: string): string {
  return mode === "auto" ? "自动" : "手动";
}

export interface GroupKindCounts {
  image: number;
  text: number;
  html: number;
  url: number;
  files: number;
}

export type ClipGroupFamily = "image" | "text" | "link" | "files" | "mixed";

type GroupCountSource = Pick<
  ClipboardGroup,
  "kind_counts" | "image_count" | "item_count"
>;

/**
 * 组内类型计数。列表接口已下发 kind_counts；旧数据/旧后端缺失时按
 * image_count 与 item_count 兜底（只能区分图片组与文本组，不臆造链接/文件）。
 */
export function groupKindCounts(group: GroupCountSource): GroupKindCounts {
  const raw = group.kind_counts;
  if (raw) {
    return {
      image: Math.max(0, raw.image ?? 0),
      text: Math.max(0, raw.text ?? 0),
      html: Math.max(0, raw.html ?? 0),
      url: Math.max(0, raw.url ?? 0),
      files: Math.max(0, raw.files ?? 0),
    };
  }
  const total = Math.max(0, group.item_count ?? 0);
  const images = Math.min(total, Math.max(0, group.image_count ?? 0));
  return { image: images, text: total - images, html: 0, url: 0, files: 0 };
}

/** 与后端 CollectFamily 一致：图片为封面优先，其余按主要类型归类，多种类型为混合。 */
export function groupFamily(group: GroupCountSource): ClipGroupFamily {
  const c = groupKindCounts(group);
  const total = c.image + c.text + c.html + c.url + c.files;
  if (c.image > 0 && total > c.image) return "mixed";
  if (c.image > 0) return "image";
  if (c.files > 0 && total > c.files) return "mixed";
  if (c.files > 0) return "files";
  if (c.url > 0 && total > c.url) return "mixed";
  if (c.url > 0) return "link";
  return "text";
}

/** 类型数量片段：`3 张截图 · 1 段文本 · 2 个链接`。 */
export function groupComposition(group: GroupCountSource): string[] {
  const c = groupKindCounts(group);
  const parts: string[] = [];
  if (c.image > 0) parts.push(`${c.image} 张截图`);
  const textCount = c.text + c.html;
  if (textCount > 0) parts.push(`${textCount} 段文本`);
  if (c.url > 0) parts.push(`${c.url} 个链接`);
  if (c.files > 0) parts.push(`${c.files} 个文件`);
  return parts;
}

/** 图片组仅有「图片 W×H」这类预览，不作为可读摘要展示。 */
const IMAGE_ONLY_PREVIEW = /^图片(?:\s+\d+×\d+)?$/;

/**
 * 分组卡片的一句话摘要：只使用后端已下发的 preview（首条内容摘要），
 * 不读正文、不联网补元数据；图片预览转成空串，由缩略图承担识别。
 */
export function groupExcerpt(group: Pick<ClipboardGroup, "preview">): string {
  const flat = (group.preview ?? "").replace(/\s+/g, " ").trim();
  if (!flat || IMAGE_ONLY_PREVIEW.test(flat)) return "";
  return flat.length > 120 ? `${flat.slice(0, 120)}…` : flat;
}

/** 链接组展示：域名优先，路径作为次要信息；解析失败时退回原链接。 */
export function linkSummary(url: string): { domain: string; rest: string } {
  const raw = (url ?? "").trim();
  // 展示用域名去掉 www. 前缀，`urlDomain` 本身保留原始主机名供其他调用方使用
  const domain = urlDomain(raw).replace(/^www\./i, "");
  if (!domain) return { domain: "", rest: raw };
  try {
    const u = new URL(raw);
    const rest = `${u.pathname}${u.search}`.replace(/^\/$/, "");
    return { domain, rest };
  } catch {
    return { domain, rest: "" };
  }
}

/** 图片组代表尺寸（来自封面元数据，不读图片本体）。 */
export function groupCoverSize(
  covers: Pick<ClipboardItem, "image_width" | "image_height">[] | undefined,
): string {
  const first = covers?.[0];
  if (!first?.image_width || !first?.image_height) return "";
  return `${first.image_width}×${first.image_height}`;
}


/**
 * 分组删除的判定与反馈文案（卡片列表与分组详情共用）。
 *
 * `deleted` 只统计连带删除的条目，分组本身删没删看 `groups_deleted`；
 * 数量为 0 表示并发下已被别处删掉——绝不能演一场成功、也不能本地移除。
 */
export function groupDeleteFeedback(
  name: string,
  alsoItems: boolean,
  r: { groups_deleted: number; deleted: number; retained_shared: number },
): { removed: boolean; message: string; kind: "success" | "warning" } {
  if (r.groups_deleted <= 0) {
    return { removed: false, message: "这些内容已经不存在，列表已刷新", kind: "warning" };
  }
  const retained = alsoItems && r.retained_shared > 0
    ? `；${r.retained_shared} 条因仍被引用而保留`
    : "";
  return {
    removed: true,
    message: alsoItems
      ? `已删除 ${r.deleted} 条内容${retained}`
      : `分组「${name}」已删除，历史条目仍保留`,
    kind: "success",
  };
}

/**
 * 常见 Windows 应用的展示名。
 *
 * 纯静态查表：渲染时零系统调用、零扫描。完整应用清单需要扫注册表/开始菜单，
 * 那是导航模块的 `app_discovery`，成本高、且与「这条剪贴板从哪来」无关。
 */
const APP_DISPLAY_NAMES: Record<string, string> = {
  "chrome.exe": "Google Chrome",
  "msedge.exe": "Microsoft Edge",
  "firefox.exe": "Mozilla Firefox",
  "brave.exe": "Brave",
  "opera.exe": "Opera",
  "vivaldi.exe": "Vivaldi",
  "360se.exe": "360 安全浏览器",
  "360chrome.exe": "360 极速浏览器",
  "sogouexplorer.exe": "搜狗浏览器",
  "iexplore.exe": "Internet Explorer",
  "code.exe": "Visual Studio Code",
  "code - insiders.exe": "Visual Studio Code Insiders",
  "cursor.exe": "Cursor",
  "trae.exe": "Trae",
  "devenv.exe": "Visual Studio",
  "idea64.exe": "IntelliJ IDEA",
  "pycharm64.exe": "PyCharm",
  "webstorm64.exe": "WebStorm",
  "wechat.exe": "微信",
  "weixin.exe": "微信",
  "qq.exe": "QQ",
  "qqnt.exe": "QQ",
  "feishu.exe": "飞书",
  "dingtalk.exe": "钉钉",
  "wemeetapp.exe": "腾讯会议",
  "kugou.exe": "酷狗音乐",
  "cloudmusic.exe": "网易云音乐",
  "qqmusic.exe": "QQ 音乐",
  "explorer.exe": "文件资源管理器",
  "notepad.exe": "记事本",
  "notepad++.exe": "Notepad++",
  "winword.exe": "Microsoft Word",
  "excel.exe": "Microsoft Excel",
  "powerpnt.exe": "Microsoft PowerPoint",
  "wps.exe": "WPS Office",
  "typora.exe": "Typora",
  "obsidian.exe": "Obsidian",
  "snippingtool.exe": "截图工具",
  "snipaste.exe": "Snipaste",
  "windowsterminal.exe": "Windows Terminal",
  "powershell.exe": "PowerShell",
  "cmd.exe": "命令提示符",
  "acrobat.exe": "Adobe Acrobat",
  "acrord32.exe": "Adobe Acrobat Reader",
  "telegram.exe": "Telegram",
  "slack.exe": "Slack",
  "discord.exe": "Discord",
};

/** 浏览器进程：窗口标题末尾常带「 - 浏览器名」，展示时去掉重复那段。 */
const BROWSER_TITLE_SUFFIX: Record<string, string[]> = {
  "chrome.exe": ["Google Chrome", "Chrome"],
  "msedge.exe": ["Microsoft Edge", "Edge"],
  "firefox.exe": ["Mozilla Firefox", "Firefox"],
  "brave.exe": ["Brave"],
  "opera.exe": ["Opera"],
  "vivaldi.exe": ["Vivaldi"],
  "360se.exe": ["360 安全浏览器"],
  "360chrome.exe": ["360 极速浏览器"],
  "sogouexplorer.exe": ["搜狗浏览器"],
  "iexplore.exe": ["Internet Explorer"],
};

/** 小写化的 exe 文件名：完整路径与裸文件名都接受。 */
export function sourceAppKey(sourceApp: string): string {
  const raw = (sourceApp ?? "").trim();
  return raw ? fileBaseName(raw).toLowerCase() : "";
}

/** 原始 exe 标识：只用于详情/Tooltip，不改写 `source_app` 字段本身。 */
export function sourceAppRaw(sourceApp: string): string {
  const raw = (sourceApp ?? "").trim();
  return raw ? fileBaseName(raw) : "";
}

/**
 * 应用展示名。已知应用查表；未知应用只做文件名规整（去 .exe），
 * 不猜厂商、不冒充已知软件。
 */
export function sourceAppName(sourceApp: string): string {
  const key = sourceAppKey(sourceApp);
  if (!key || key === "unknown") return "未知应用";
  const known = APP_DISPLAY_NAMES[key];
  if (known) return known;
  const stem = sourceAppRaw(sourceApp).replace(/\.exe$/i, "");
  return stem || "未知应用";
}

/**
 * 窗口标题：浏览器标题只去掉末尾重复的浏览器名（如「 - Google Chrome」），
 * 网页标题本身一个字不删；其他应用标题原样保留。
 */
export function sourceWindowTitle(sourceApp: string, sourceTitle: string): string {
  const raw = (sourceTitle ?? "").replace(/\s+/g, " ").trim();
  if (!raw) return "";
  const suffixes = BROWSER_TITLE_SUFFIX[sourceAppKey(sourceApp)];
  if (!suffixes) return raw;
  for (const name of suffixes) {
    const tail = ` - ${name}`;
    if (raw.length > tail.length && raw.toLowerCase().endsWith(tail.toLowerCase())) {
      return raw.slice(0, raw.length - tail.length).trim();
    }
  }
  return raw;
}

/**
 * 来源识别方式的说明文案。
 *
 * `owner` 只是 `GetClipboardOwner()` 记录的系统所有者窗口，它说明“谁在系统里登记了
 * 这份剪贴板”，不保证就是用户实际按下 Ctrl+C 的程序（后台脚本、历史重放都可能写入）。
 * 因此四档文案都不使用“确认/真实写入方”这类绝对表述。
 */
export function sourceTrustLabel(sourceKind: string): string {
  if (sourceKind === "owner") return "剪贴板所有者窗口（系统记录）";
  if (sourceKind === "foreground") return "前台窗口（推断来源）";
  if (sourceKind === "unknown") return "未能识别来源";
  return "旧记录未记录识别方式";
}

export interface ClipSourceInfo {
  /** 人类可读应用名 */
  app: string;
  /** 原始 exe 标识（详情/Tooltip） */
  appRaw: string;
  /** 去掉重复浏览器名后的窗口标题 */
  window: string;
  /** 原始窗口标题 */
  windowRaw: string;
  /** owner / foreground / unknown / ''（旧记录） */
  kind: string;
  /** 识别方式的说明文案 */
  trust: string;
  /** 是否真的识别到了应用（否则一律按「未知应用」展示） */
  identified: boolean;
}

/** 卡片、详情、图片放大预览共用的来源结构：三处不得各自实现格式化规则。 */
export function clipSource(item: {
  source_app?: string;
  source_title?: string;
  source_kind?: string;
}): ClipSourceInfo {
  const raw = sourceAppRaw(item.source_app ?? "");
  // 未识别来源时不把 `unknown` 这个哨兵值暴露给详情/Tooltip，避免看起来像真实进程名。
  const identified = raw !== "" && raw.toLowerCase() !== "unknown";
  const windowRaw = (item.source_title ?? "").trim();
  const kind = (item.source_kind ?? "").trim();
  return {
    app: sourceAppName(item.source_app ?? ""),
    appRaw: identified ? raw : "",
    window: sourceWindowTitle(item.source_app ?? "", windowRaw),
    windowRaw,
    kind,
    trust: sourceTrustLabel(kind),
    identified,
  };
}

/** 单行摘要（提示条、操作提示）：应用 · 窗口。 */
export function sourceLabel(sourceApp: string, sourceTitle: string): string {
  const app = sourceAppName(sourceApp);
  const win = sourceWindowTitle(sourceApp, sourceTitle);
  return win ? `${app} · ${win}` : app;
}

/** 从 URL 提取域名；非 http/https 或解析失败返回空串（调用方不展示假域名）。 */
export function urlDomain(url: string): string {
  try {
    const u = new URL(url.trim());
    return u.protocol === "http:" || u.protocol === "https:" ? u.hostname : "";
  } catch {
    return "";
  }
}

/**
 * 判断纯文本是否「像代码」——只影响详情页默认视图，不影响数据。
 *
 * 信号（加权）：缩进行占比、代码关键字/惯用符号行占比、含语法符号行占比；
 * 反信号：成句的自然语言（以句末标点结尾且词数较多、无语法符号）。
 * 阈值取「缩进+关键字共现」才判 true，避免把 Markdown、长 URL、普通段落误判。
 */
export function looksLikeCode(text: string): boolean {
  if (!text) return false;
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length < 3) return false;
  const KW =
    /\b(function|def|class|import|export|from|const|let|var|return|if|else|for|while|switch|case|break|package|public|private|static|void|struct|impl|fn|use|mod|namespace|using|enum|interface|type|async|await|yield|try|catch|finally|throw|SELECT|FROM|WHERE|INSERT|UPDATE|DELETE|CREATE|JOIN)\b|=>|::|->|&&|\|\||#include|<\/(?:div|span|p|li|td|tr|a|h[1-6])>|^\s*<[a-z!][a-z-]*[^>]*>/i;
  let indented = 0;
  let keyword = 0;
  let symbol = 0;
  let prose = 0;
  for (const raw of lines) {
    const l = raw.trimEnd();
    if (/^(\s{2,}|\t)/.test(l)) indented += 1;
    if (KW.test(l)) keyword += 1;
    if (/[{};=<>[\]()]|^\s*[/*#<]/.test(l)) symbol += 1;
    // 自然语言行：句末标点收尾、足够长、且没有语法符号
    if (/[。．.!?！？]["'」』）)]?$/.test(l.trim()) && l.trim().split(/\s+/).length >= 6 && !/[{};=<>[\]()]/.test(l)) {
      prose += 1;
    }
  }
  const n = lines.length;
  let score = 0;
  if (indented / n >= 0.25) score += 2;
  else if (indented / n >= 0.1) score += 1;
  if (keyword / n >= 0.4) score += 2;
  else if (keyword / n >= 0.15) score += 1;
  if (symbol / n >= 0.5) score += 1;
  if (prose / n >= 0.5) score -= 3;
  return score >= 3;
}

/**
 * 操作提示里带的对象信息：优先标题，其次截断预览，最后退回来源。
 * 只用来让用户认出「刚才动的是哪一条」，不展开完整正文。
 */
export function objectHint(item: {
  kind: string;
  title?: string;
  preview?: string;
  source_app?: string;
  source_title?: string;
}): string {
  const raw =
    item.title || item.preview || sourceLabel(item.source_app ?? "", item.source_title ?? "");
  const flat = raw.replace(/\s+/g, " ").trim();
  if (!flat) return kindLabel(item.kind);
  return flat.length > 24 ? `${flat.slice(0, 24)}…` : flat;
}

export const RICH_EMBED_BUDGET = 6 * 1024 * 1024;
export const RICH_HTML_ITEM_LIMIT = 512 * 1024;

export interface CopyPreflight {
  images: number;
  imageBytes: number;
  estimatedEmbedBytes: number;
  willEmbedAllImages: boolean;
  files: number;
  oversizedHtml: number;
  totalBytes: number;
  warnings: string[];
}

/**
 * 复制前预检：区分富文本 / 多文件两种模式，说明图片内嵌预算与降级行为。
 * 只依据已加载的分组数据，不读取图片本体。
 */
export function copyPreflight(
  items: Array<{ kind: string; byte_size: number }>,
): CopyPreflight {
  let images = 0;
  let imageBytes = 0;
  let files = 0;
  let oversizedHtml = 0;
  let totalBytes = 0;
  for (const item of items) {
    const size = Number.isFinite(item.byte_size) ? item.byte_size : 0;
    totalBytes += size;
    if (item.kind === "image") {
      images += 1;
      imageBytes += size;
    } else if (item.kind === "files") {
      files += 1;
    } else if (item.kind === "html" && size > RICH_HTML_ITEM_LIMIT) {
      oversizedHtml += 1;
    }
  }
  const estimatedEmbedBytes = Math.ceil((imageBytes * 4) / 3);
  const willEmbedAllImages = images === 0 || estimatedEmbedBytes <= RICH_EMBED_BUDGET;
  const warnings: string[] = [];
  if (images > 0) {
    if (willEmbedAllImages) {
      warnings.push(
        `富文本会内嵌 ${images} 张图片，约 ${formatBytes(estimatedEmbedBytes)}（上限 6 MB，含 Base64 膨胀）`,
      );
    } else {
      warnings.push(
        `图片总计 ${formatBytes(imageBytes)}，超过富文本 6 MB 内嵌上限，超出部分会降级为占位符；建议改用逐项粘贴或复制文件`,
      );
    }
    warnings.push("部分编辑器不支持富文本图片，必要时请使用逐项粘贴保留原顺序");
  }
  if (files > 0) {
    warnings.push("文件条目在富文本中只保留名称清单；需要文件本体请使用「复制文件」");
  }
  if (oversizedHtml > 0) {
    warnings.push(`${oversizedHtml} 项富文本超过 512 KB，将降级为纯文本`);
  }
  return {
    images,
    imageBytes,
    estimatedEmbedBytes,
    willEmbedAllImages,
    files,
    oversizedHtml,
    totalBytes,
    warnings,
  };
}
