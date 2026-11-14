// 文件类型图标：类型只决定「形状」，颜色由调用方决定（来自电脑 accent / 发往电脑 ok）。
//
// 第四轮：形状统一走 AppIcon（lucide 几何），不再用 View 拼三角形/笑脸。
// 不给每种文件配一个色：语义色只用于状态，十几种类型色会让整列变成彩色噪音，
// 也会把「接收中 / 失败」这两个真正需要被看见的状态淹掉。
import { AppIcon, type IconName } from "./icons/AppIcon";

export type FileTypeKind =
  | "pdf"
  | "doc"
  | "sheet"
  | "slide"
  | "image"
  | "video"
  | "audio"
  | "archive"
  | "code"
  | "text"
  | "markdown"
  | "apk"
  | "generic";

/** 只映射「图标形状」，不参与业务判断；未列出的扩展名回退 generic。 */
const TYPE_BY_EXTENSION: Record<string, FileTypeKind> = {
  pdf: "pdf",
  doc: "doc",
  docx: "doc",
  rtf: "doc",
  odt: "doc",
  pages: "doc",
  xls: "sheet",
  xlsx: "sheet",
  csv: "sheet",
  ods: "sheet",
  numbers: "sheet",
  ppt: "slide",
  pptx: "slide",
  key: "slide",
  odp: "slide",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  bmp: "image",
  heic: "image",
  heif: "image",
  avif: "image",
  svg: "image",
  mp4: "video",
  mov: "video",
  mkv: "video",
  avi: "video",
  webm: "video",
  m4v: "video",
  "3gp": "video",
  mp3: "audio",
  wav: "audio",
  flac: "audio",
  aac: "audio",
  ogg: "audio",
  m4a: "audio",
  amr: "audio",
  zip: "archive",
  rar: "archive",
  "7z": "archive",
  tar: "archive",
  gz: "archive",
  bz2: "archive",
  xz: "archive",
  tgz: "archive",
  js: "code",
  mjs: "code",
  cjs: "code",
  ts: "code",
  tsx: "code",
  jsx: "code",
  json: "code",
  html: "code",
  htm: "code",
  css: "code",
  scss: "code",
  py: "code",
  rs: "code",
  go: "code",
  java: "code",
  kt: "code",
  swift: "code",
  c: "code",
  h: "code",
  cpp: "code",
  cs: "code",
  sh: "code",
  ps1: "code",
  sql: "code",
  xml: "code",
  yml: "code",
  yaml: "code",
  toml: "code",
  txt: "text",
  log: "text",
  ini: "text",
  conf: "text",
  cfg: "text",
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  apk: "apk",
  aab: "apk",
  xapk: "apk",
};

export function fileTypeOf(name: string): FileTypeKind {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "generic";
  const extension = name.slice(dot + 1).trim().toLowerCase();
  return TYPE_BY_EXTENSION[extension] ?? "generic";
}

/** 类型 → 语义图标。13 种形状互不相同：文档/表格/演示/图片/视频/音频/压缩/代码/文本/Markdown/APK/PDF/通用。 */
const ICON_BY_KIND: Record<FileTypeKind, IconName> = {
  pdf: "filePdf",
  doc: "fileDoc",
  sheet: "fileSheet",
  slide: "fileSlide",
  image: "fileImage",
  video: "fileVideo",
  audio: "fileAudio",
  archive: "fileArchive",
  code: "fileCode",
  text: "fileText",
  markdown: "fileMarkdown",
  apk: "fileApk",
  generic: "fileGeneric",
};

export function FileTypeIcon({
  kind,
  color,
  size = 20,
}: {
  kind: FileTypeKind;
  color: string;
  size?: number;
}) {
  return <AppIcon name={ICON_BY_KIND[kind]} color={color} size={size} />;
}
