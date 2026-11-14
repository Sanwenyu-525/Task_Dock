// 文件类型图标：类型决定形状 + 语义色；传出的方向（电脑→手机 / 手机→电脑）由外层底板表达。
//
// 第五轮：类型不再共用一种灰/蓝——
//   - PDF 走 danger 红、Markdown 走 accent 蓝、图片/视频/代码各有语义色，
//     文件名里的扩展名与图标颜色一起解决「PDF 认不出、Markdown 和普通文档混淆」；
//   - 颜色只取语义 Token，不引入十几种装饰色；接收中/失败等真正需要警觉的状态仍由
//     行内文字与底板控制，不会被类型色淹没。
// 形状仍统一走 AppIcon（lucide 几何），不允许页面自己画文件图标。
import type { Palette } from "../theme/tokens";
import { useTheme } from "../theme/ThemeProvider";

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

/** 类型 → 语义色 Token：只用于图标本身，不是状态色。 */
const TONE_BY_KIND: Record<FileTypeKind, keyof Palette> = {
  pdf: "danger",
  doc: "accentText",
  sheet: "ok",
  slide: "warn",
  image: "accentText",
  video: "accent",
  audio: "ok",
  archive: "warn",
  code: "accent",
  text: "muted",
  markdown: "accent",
  apk: "warn",
  generic: "muted",
};

export function FileTypeIcon({
  kind,
  color,
  size = 22,
}: {
  kind: FileTypeKind;
  /** 需要覆盖类型色时传入（例如状态强调）；默认按类型取语义色 */
  color?: string;
  size?: number;
}) {
  const { tokens } = useTheme();
  return (
    <AppIcon
      name={ICON_BY_KIND[kind]}
      color={color ?? tokens[TONE_BY_KIND[kind]]}
      size={size}
    />
  );
}
