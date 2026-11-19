//! 快速捕获的图片粘贴纯逻辑：从剪贴板挑出栅格图片、校验、并在 canvas 侧
//! 归一化成 PNG（限制长边，避免把 4K 截图原样塞进 IPC / 磁盘）。
//!
//! 为什么在 canvas 侧转 PNG：
//! - 后端只沉淀一种格式（png crate 已具备解码/缩放能力），不新增图片编解码依赖；
//! - `canvas.toBlob` 会丢掉 EXIF / 剪贴板附加块，等于先做一次内容净化；
//! - 降采样在渲染进程完成，IPC 与磁盘只承担最终尺寸。
//!
//! 这里不碰 React，也不直接调用 Tauri；`CaptureApp` 只负责编排与 UI 状态。

/** 单条捕获最多携带的图片数（与后端 `MAX_ATTACHMENTS` 一致）。 */
export const MAX_IMAGE_ATTACHMENTS = 8;
/** 源文件大小上限（剪贴板截图通常 < 10MB；超过它多半是误粘贴的大文件）。 */
export const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
/** 归一化后 PNG 的字节上限（与后端一致）。 */
export const MAX_PNG_BYTES = 12 * 1024 * 1024;
/** 归一化后的长边上限：够看清细节，又不会让单张图占几十 MB 内存。 */
export const MAX_IMAGE_EDGE = 2400;
/** 接受的栅格图片 MIME（SVG 等矢量/可执行内容一律拒绝）。 */
export const ALLOWED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

export interface PreparedImage {
  /** 归一化后的 PNG（base64，无 data: 前缀）。 */
  base64: string;
  mime: "image/png";
  width: number;
  height: number;
  bytes: number;
}

/** 从剪贴板事件里挑出图片文件（支持一次粘贴多张）。纯文本粘贴返回空数组。 */
export function extractClipboardImages(data: DataTransfer | null | undefined): File[] {
  if (!data) return [];
  const files: File[] = [];
  const items = data.items;
  if (items && items.length > 0) {
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      if (item.kind !== "file") continue;
      const file = item.getAsFile();
      if (!file) continue;
      // 剪贴板截图有时带空 type：仍交给 validatePastedImage 用扩展名/大小兜底。
      files.push(file);
    }
  }
  if (files.length > 0) return files;
  // 某些来源只有 files 列表（例如从资源管理器复制的图片文件）
  const list = data.files;
  if (list && list.length > 0) {
    for (let i = 0; i < list.length; i += 1) {
      const file = list[i];
      if (file) files.push(file);
    }
  }
  return files;
}

/**
 * 校验一张待粘贴图片；返回可展示的错误文案，null 表示通过。
 * `existingCount` 是当前已附加数量（含正在处理的占位）。
 */
export function validatePastedImage(file: File, existingCount: number): string | null {
  if (existingCount >= MAX_IMAGE_ATTACHMENTS) {
    return `最多添加 ${MAX_IMAGE_ATTACHMENTS} 张图片`;
  }
  if (!file || file.size <= 0) return "图片内容为空，无法粘贴";
  if (file.size > MAX_SOURCE_BYTES) {
    return `单张图片不能超过 ${MAX_SOURCE_BYTES / 1024 / 1024} MB`;
  }
  const type = (file.type || "").toLowerCase();
  if (type && !(ALLOWED_IMAGE_TYPES as readonly string[]).includes(type)) {
    return "只支持 PNG / JPEG / WebP 图片";
  }
  return null;
}

/** `Uint8Array` → base64（分块拼接，避免大图触发调用栈溢出）。 */
export function bytesToBase64(bytes: Uint8Array): string {
  const chunk = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    const slice = bytes.subarray(i, i + chunk);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

/** 目标尺寸：只缩小不放大，保持长边不超过 `MAX_IMAGE_EDGE`。 */
export function fitWithin(width: number, height: number, maxEdge = MAX_IMAGE_EDGE) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    scaled: scale < 1,
  };
}

/** 读取图片像素源：优先 `createImageBitmap`（快、支持 EXIF 方向），失败回退 `<img>`。 */
async function loadPixels(
  file: File,
): Promise<{ draw: CanvasImageSource; width: number; height: number; close: () => void }> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file);
      return {
        draw: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        close: () => bitmap.close(),
      };
    } catch {
      // 回退到 <img>：部分 WebView 版本对 webp/heic 的 bitmap 解码会失败
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("图片无法解码"));
      el.src = url;
    });
    return {
      draw: image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      close: () => undefined,
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * 把粘贴进来的图片归一化成 PNG（长边 ≤ `MAX_IMAGE_EDGE`）。
 * 失败抛出可展示的错误；调用方负责保留原文字与其它图片。
 */
export async function prepareImageAttachment(file: File): Promise<PreparedImage> {
  const source = await loadPixels(file);
  try {
    const size = fitWithin(source.width, source.height);
    if (!size) throw new Error("图片尺寸无效");
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("当前环境不支持图片处理");
    ctx.drawImage(source.draw, 0, 0, size.width, size.height);
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, "image/png");
    });
    if (!blob) throw new Error("图片转换失败");
    if (blob.size > MAX_PNG_BYTES) {
      throw new Error(`图片过大（转换后 ${Math.round(blob.size / 1024 / 1024)} MB）`);
    }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return {
      base64: bytesToBase64(bytes),
      mime: "image/png",
      width: size.width,
      height: size.height,
      bytes: blob.size,
    };
  } finally {
    source.close();
  }
}

/** 人类可读的大小（附件角标/提示用）。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 KB";
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
