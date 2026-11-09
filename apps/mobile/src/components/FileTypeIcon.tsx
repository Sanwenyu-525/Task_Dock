// 文件类型图标：与 TabBar 同口径，用基础 View 画 20dp 线稿。
//
// 为什么不引图标库/图片：
// - 规范禁止新增图标库或图片装饰（docs/mobile/03-ui-spec.md §8）；
// - Unicode 字形在部分 ROM 会被渲染成彩色 emoji，emoji 在不同系统上形状也不一致。
//
// 颜色口径：类型只决定「形状」，底色与线色由方向决定（来自电脑 accent / 发往电脑 ok）。
// 不给每种文件配一个色：语义色只用于状态，十几种类型色会让整列变成彩色噪音，
// 也会把「接收中 / 失败」这两个真正需要被看见的状态淹掉。
import type { ReactNode } from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";

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

/** 20×20 画布，线重 1.5，与 TabBar 的 22dp/1.8 视觉密度对齐。 */
const BOX = 20;
const STROKE = 1.5;

function Line({ color, style }: { color: string; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.line, style, { backgroundColor: color }]} />;
}

/** 文档外框；children 的坐标是「边框内侧」的内容盒（9×13）。 */
function Page({ color, children }: { color: string; children?: ReactNode }) {
  return <View style={[styles.page, { borderColor: color }]}>{children}</View>;
}

function glyph(kind: FileTypeKind, color: string): ReactNode {
  switch (kind) {
    case "pdf":
      // 文件 + 右下角封签：没有文字时用「盖章文档」表达 PDF。
      return (
        <>
          <Page color={color}>
            <Line color={color} style={styles.pdfLine1} />
            <Line color={color} style={styles.pdfLine2} />
            <View style={[styles.pdfSeal, { backgroundColor: color }]} />
            <View style={[styles.pdfRibbonLeft, { backgroundColor: color }]} />
            <View style={[styles.pdfRibbonRight, { backgroundColor: color }]} />
          </Page>
        </>
      );

    case "doc":
      return (
        <Page color={color}>
          <Line color={color} style={styles.docLine1} />
          <Line color={color} style={styles.docLine2} />
          <Line color={color} style={styles.docLine3} />
        </Page>
      );

    case "sheet":
      // 表格：外框 + 一列两行，直接读成网格。
      return (
        <View style={[styles.sheetFrame, { borderColor: color }]}>
          <View style={[styles.sheetColumn, { backgroundColor: color }]} />
          <View style={[styles.sheetRow1, { backgroundColor: color }]} />
          <View style={[styles.sheetRow2, { backgroundColor: color }]} />
        </View>
      );

    case "slide":
      // 投影幕 + 三根柱状条 + 支架：演示文稿，而不是视频。
      return (
        <>
          <View style={[styles.slideScreen, { borderColor: color }]}>
            <View style={[styles.slideBar, styles.slideBar1, { backgroundColor: color }]} />
            <View style={[styles.slideBar, styles.slideBar2, { backgroundColor: color }]} />
            <View style={[styles.slideBar, styles.slideBar3, { backgroundColor: color }]} />
          </View>
          <View style={[styles.slideStand, { backgroundColor: color }]} />
          <View style={[styles.slideBase, { backgroundColor: color }]} />
        </>
      );

    case "image":
      return (
        <View style={[styles.imageFrame, { borderColor: color }]}>
          <View style={[styles.imageSun, { backgroundColor: color }]} />
          <View style={[styles.imageMountainSmall, { borderBottomColor: color }]} />
          <View style={[styles.imageMountain, { borderBottomColor: color }]} />
        </View>
      );

    case "video":
      return (
        <>
          <View style={[styles.videoFrame, { borderColor: color }]} />
          <View
            style={[
              styles.videoPlay,
              {
                borderLeftColor: color,
                borderTopColor: "transparent",
                borderBottomColor: "transparent",
              },
            ]}
          />
        </>
      );

    case "audio":
      // 双音符：两根符干 + 横梁 + 两个符头。
      return (
        <>
          <View style={[styles.audioBeam, { backgroundColor: color }]} />
          <View style={[styles.audioStem, styles.audioStemLeft, { backgroundColor: color }]} />
          <View style={[styles.audioStem, styles.audioStemRight, { backgroundColor: color }]} />
          <View style={[styles.audioHead, styles.audioHeadLeft, { backgroundColor: color }]} />
          <View style={[styles.audioHead, styles.audioHeadRight, { backgroundColor: color }]} />
        </>
      );

    case "archive":
      // 压缩包：盖 + 箱体 + 中缝拉链。
      return (
        <>
          <View style={[styles.archiveLid, { borderColor: color }]} />
          <View style={[styles.archiveBody, { borderColor: color }]} />
          <View style={[styles.archiveTooth, styles.archiveTooth1, { backgroundColor: color }]} />
          <View style={[styles.archiveTooth, styles.archiveTooth2, { backgroundColor: color }]} />
          <View style={[styles.archiveTooth, styles.archiveTooth3, { backgroundColor: color }]} />
        </>
      );

    case "code":
      // < / >：两组斜线 + 中间斜杠，不依赖等宽字体。
      return (
        <>
          <View style={[styles.codeBar, styles.codeLeftTop, { backgroundColor: color }]} />
          <View style={[styles.codeBar, styles.codeLeftBottom, { backgroundColor: color }]} />
          <View style={[styles.codeBar, styles.codeRightTop, { backgroundColor: color }]} />
          <View style={[styles.codeBar, styles.codeRightBottom, { backgroundColor: color }]} />
          <View style={[styles.codeSlash, { backgroundColor: color }]} />
        </>
      );

    case "text":
      // 纯文本：四行等宽横线，没有标题行，和 doc 的「三段式」区分。
      return (
        <Page color={color}>
          <Line color={color} style={styles.textLine1} />
          <Line color={color} style={styles.textLine2} />
          <Line color={color} style={styles.textLine3} />
          <Line color={color} style={styles.textLine4} />
        </Page>
      );

    case "markdown":
      // 文档 + 向下箭头（Markdown 的 M↓ 记号），不写字母。
      return (
        <Page color={color}>
          <Line color={color} style={styles.mdLine1} />
          <Line color={color} style={styles.mdLine2} />
          <View style={[styles.mdShaft, { backgroundColor: color }]} />
          <View
            style={[
              styles.mdArrow,
              {
                borderTopColor: color,
                borderLeftColor: "transparent",
                borderRightColor: "transparent",
              },
            ]}
          />
        </Page>
      );

    case "apk":
      // Android 机器人头部：半圆 + 两根天线 + 两只眼睛。
      return (
        <>
          <View style={[styles.apkHead, { borderColor: color }]}>
            <View style={[styles.apkEye, styles.apkEyeLeft, { backgroundColor: color }]} />
            <View style={[styles.apkEye, styles.apkEyeRight, { backgroundColor: color }]} />
          </View>
          <View style={[styles.apkAntenna, styles.apkAntennaLeft, { backgroundColor: color }]} />
          <View style={[styles.apkAntenna, styles.apkAntennaRight, { backgroundColor: color }]} />
        </>
      );

    default:
      // 未知类型：空白文档 + 两行占位线。
      return (
        <Page color={color}>
          <Line color={color} style={styles.genericLine1} />
          <Line color={color} style={styles.genericLine2} />
        </Page>
      );
  }
}

export function FileTypeIcon({ kind, color }: { kind: FileTypeKind; color: string }) {
  return (
    <View
      style={styles.box}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {glyph(kind, color)}
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    width: BOX,
    height: BOX,
  },
  line: {
    position: "absolute",
    height: 1.4,
    borderRadius: 0.7,
  },

  // 文档外框：12×16，圆角 2.5；内容盒 9×13。
  page: {
    position: "absolute",
    left: 4,
    top: 2,
    width: 12,
    height: 16,
    borderWidth: STROKE,
    borderRadius: 2.5,
  },

  // PDF：两行短标题 + 封签（圆 + 两条飘带）。
  pdfLine1: { left: 1.5, top: 2.2, width: 4.6 },
  pdfLine2: { left: 1.5, top: 5, width: 4.6 },
  pdfSeal: {
    position: "absolute",
    left: 3.9,
    top: 7.1,
    width: 5.2,
    height: 5.2,
    borderRadius: 2.6,
  },
  pdfRibbonLeft: {
    position: "absolute",
    left: 4.4,
    top: 10.4,
    width: 1.2,
    height: 2.5,
    borderRadius: 0.6,
    transform: [{ rotate: "16deg" }],
  },
  pdfRibbonRight: {
    position: "absolute",
    left: 7.4,
    top: 10.4,
    width: 1.2,
    height: 2.5,
    borderRadius: 0.6,
    transform: [{ rotate: "-16deg" }],
  },

  // DOC：三行，末行短。
  docLine1: { left: 1.5, top: 2.6, right: 1.5 },
  docLine2: { left: 1.5, top: 6.2, right: 1.5 },
  docLine3: { left: 1.5, top: 9.8, width: 4.4 },

  // 表格：14×14 外框 + 一列两行。
  sheetFrame: {
    position: "absolute",
    left: 3,
    top: 3,
    width: 14,
    height: 14,
    borderWidth: STROKE,
    borderRadius: 2,
  },
  sheetColumn: {
    position: "absolute",
    left: 5.35,
    top: 0,
    width: 1.2,
    height: 11,
    borderRadius: 0.6,
  },
  sheetRow1: {
    position: "absolute",
    left: 0,
    top: 3.5,
    width: 11,
    height: 1.2,
    borderRadius: 0.6,
  },
  sheetRow2: {
    position: "absolute",
    left: 0,
    top: 7,
    width: 11,
    height: 1.2,
    borderRadius: 0.6,
  },

  // 演示：16×10 屏幕 + 支架 + 底座。
  slideScreen: {
    position: "absolute",
    left: 2,
    top: 3.4,
    width: 16,
    height: 10,
    borderWidth: STROKE,
    borderRadius: 1.6,
  },
  slideBar: {
    position: "absolute",
    width: 1.8,
    bottom: 1.2,
    borderRadius: 0.5,
  },
  slideBar1: { left: 2.2, height: 2.6 },
  slideBar2: { left: 5.1, height: 4.6 },
  slideBar3: { left: 8, height: 3.4 },
  slideStand: {
    position: "absolute",
    left: 9.25,
    top: 13.4,
    width: 1.5,
    height: 2.3,
  },
  slideBase: {
    position: "absolute",
    left: 7,
    top: 15.6,
    width: 6,
    height: 1.5,
    borderRadius: 0.75,
  },

  // 图片：15×12 相框 + 太阳 + 两座山。
  imageFrame: {
    position: "absolute",
    left: 2.5,
    top: 4,
    width: 15,
    height: 12,
    borderWidth: STROKE,
    borderRadius: 2,
  },
  imageSun: {
    position: "absolute",
    left: 2,
    top: 2,
    width: 2.6,
    height: 2.6,
    borderRadius: 1.3,
  },
  imageMountainSmall: {
    position: "absolute",
    left: 1.2,
    top: 5,
    width: 0,
    height: 0,
    borderLeftWidth: 2.8,
    borderRightWidth: 2.8,
    borderBottomWidth: 4,
    borderLeftColor: "transparent",
    borderRightColor: "transparent",
  },
  imageMountain: {
    position: "absolute",
    left: 3.8,
    top: 3.5,
    width: 0,
    height: 0,
    borderLeftWidth: 3.9,
    borderRightWidth: 3.9,
    borderBottomWidth: 5.5,
    borderLeftColor: "transparent",
    borderRightColor: "transparent",
  },

  // 视频：16×12 画框 + 播放三角。
  videoFrame: {
    position: "absolute",
    left: 2,
    top: 4,
    width: 16,
    height: 12,
    borderWidth: STROKE,
    borderRadius: 2.4,
  },
  videoPlay: {
    position: "absolute",
    left: 8.1,
    top: 7.4,
    width: 0,
    height: 0,
    borderLeftWidth: 5,
    borderTopWidth: 3.2,
    borderBottomWidth: 3.2,
  },

  // 音频：双音符。
  audioBeam: {
    position: "absolute",
    left: 7.1,
    top: 4.6,
    width: 7.6,
    height: 1.5,
    borderRadius: 0.4,
  },
  audioStem: {
    position: "absolute",
    top: 4.6,
    width: 1.5,
    height: 7.6,
    borderRadius: 0.4,
  },
  audioStemLeft: { left: 7.1 },
  audioStemRight: { left: 13.2 },
  audioHead: {
    position: "absolute",
    width: 4.6,
    height: 3.3,
    borderRadius: 2.3,
    transform: [{ rotate: "-20deg" }],
  },
  audioHeadLeft: { left: 4.6, top: 10.8 },
  audioHeadRight: { left: 10.7, top: 10.8 },

  // 压缩包：盖 + 箱体 + 三个拉链齿。
  archiveLid: {
    position: "absolute",
    left: 2.4,
    top: 3,
    width: 15.2,
    height: 3.4,
    borderWidth: STROKE,
    borderRadius: 1.2,
  },
  archiveBody: {
    position: "absolute",
    left: 3.4,
    top: 6.4,
    width: 13.2,
    height: 10.6,
    borderWidth: STROKE,
    borderRadius: 1.8,
  },
  archiveTooth: {
    position: "absolute",
    left: 9.1,
    width: 1.8,
    height: 1.8,
    borderRadius: 0.4,
  },
  archiveTooth1: { top: 7.9 },
  archiveTooth2: { top: 10.9 },
  archiveTooth3: { top: 13.9 },

  // 代码：两组斜线 + 中间斜杠。
  codeBar: {
    position: "absolute",
    width: 5.6,
    height: 1.5,
    borderRadius: 0.75,
  },
  codeLeftTop: { left: 4.2, top: 6.85, transform: [{ rotate: "-45deg" }] },
  codeLeftBottom: { left: 4.2, top: 11.65, transform: [{ rotate: "45deg" }] },
  codeRightTop: { left: 10.2, top: 6.85, transform: [{ rotate: "45deg" }] },
  codeRightBottom: { left: 10.2, top: 11.65, transform: [{ rotate: "-45deg" }] },
  codeSlash: {
    position: "absolute",
    left: 9.25,
    top: 6.75,
    width: 1.5,
    height: 6.5,
    borderRadius: 0.75,
    transform: [{ rotate: "25deg" }],
  },

  // 文本：四行。
  textLine1: { left: 1.5, top: 2.4, right: 1.5 },
  textLine2: { left: 1.5, top: 5.4, right: 1.5 },
  textLine3: { left: 1.5, top: 8.4, right: 1.5 },
  textLine4: { left: 1.5, top: 11.4, right: 3.2 },

  // Markdown：两行 + 向下箭头。
  mdLine1: { left: 1.5, top: 2.2, right: 1.5 },
  mdLine2: { left: 1.5, top: 5.2, right: 1.5 },
  mdShaft: {
    position: "absolute",
    left: 3.75,
    top: 6.6,
    width: 1.5,
    height: 4,
    borderRadius: 0.75,
  },
  mdArrow: {
    position: "absolute",
    left: 2.9,
    top: 9.4,
    width: 0,
    height: 0,
    borderLeftWidth: 3.2,
    borderRightWidth: 3.2,
    borderTopWidth: 3.6,
  },

  // APK：机器人头。
  apkHead: {
    position: "absolute",
    left: 3.4,
    top: 7,
    width: 13.2,
    height: 6.6,
    borderWidth: STROKE,
    borderBottomWidth: 0,
    borderTopLeftRadius: 6.6,
    borderTopRightRadius: 6.6,
  },
  apkEye: {
    position: "absolute",
    top: 2.2,
    width: 1.6,
    height: 1.6,
    borderRadius: 0.8,
  },
  apkEyeLeft: { left: 2.4 },
  apkEyeRight: { right: 2.4 },
  apkAntenna: {
    position: "absolute",
    top: 2.6,
    width: 1.5,
    height: 4.6,
    borderRadius: 0.75,
  },
  apkAntennaLeft: { left: 5.2, transform: [{ rotate: "-28deg" }] },
  apkAntennaRight: { left: 13.3, transform: [{ rotate: "28deg" }] },

  // 通用：空白文档 + 两行。
  genericLine1: { left: 1.5, top: 3.6, right: 1.5 },
  genericLine2: { left: 1.5, top: 7.2, right: 3.2 },
});
