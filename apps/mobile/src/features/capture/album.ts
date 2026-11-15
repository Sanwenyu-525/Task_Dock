// Android 媒体库与图片处理的原生桥（本地 Expo 模块 `modules/media-store`）。
//
// 为什么不用第三方图像库：保存到系统相册需要 Android 10+ 的 MediaStore 分区存储语义，
// 旋转/裁剪只需要 Bitmap 基础能力；自建小模块可以避免新增依赖（包体积、维护成本、
// 授权问题），并把「真正写入 MediaStore」这一事实留在原生侧，不靠缓存目录冒充。
//
// 原生模块名：`TaskDockMedia`（见 modules/media-store/expo-module.config.json）。
import { PermissionsAndroid, Platform } from "react-native";
import { requireNativeModule } from "expo-modules-core";

import { AppError } from "../../lib/errors";

interface NativeSavedMedia {
  uri: string;
  displayName: string;
  size: number;
}

interface NativeImageInfo {
  uri: string;
  width: number;
  height: number;
  mime: string;
  size: number;
}

interface NativeTransformResult extends NativeImageInfo {}

let cached: ReturnType<typeof requireNativeModule> | null = null;

function native(): any {
  if (!cached) {
    try {
      cached = requireNativeModule("TaskDockMedia");
    } catch (error) {
      throw new AppError(
        "validation",
        `系统媒体模块不可用：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return cached;
}

/** Android 10 以下写公共媒体库需要旧式存储权限；10+ 走分区存储，不需要。 */
async function ensureLegacyWritePermission(): Promise<void> {
  if (Platform.OS !== "android" || Number(Platform.Version) >= 29) return;
  const granted = await PermissionsAndroid.request(
    PermissionsAndroid.PERMISSIONS.WRITE_EXTERNAL_STORAGE,
    {
      title: "保存到相册",
      message: "Android 9 及以下需要存储权限才能把照片写入系统相册。",
      buttonPositive: "允许",
      buttonNegative: "取消",
    },
  );
  if (granted !== PermissionsAndroid.RESULTS.GRANTED) {
    throw new AppError("validation", "未获得存储权限，照片没有保存到系统相册");
  }
}

/**
 * 真正写入系统媒体库（MediaStore）。返回 content:// URI；同名文件由 MediaStore
 * 自动去重，不覆盖相册里已有照片。
 */
export async function saveToSystemGallery(
  sourceUri: string,
  displayName: string,
  mime: string,
): Promise<NativeSavedMedia> {
  await ensureLegacyWritePermission();
  const result = await native().saveToGalleryAsync(sourceUri, displayName, mime);
  if (!result?.uri) {
    throw new AppError("storage", "系统相册未返回保存结果，请重试");
  }
  return result as NativeSavedMedia;
}

/** 生成列表缩略图（JPEG，最长边 maxSize）。失败返回 null，由 UI 显示类型图标。 */
export async function createThumbnail(
  sourceUri: string,
  maxSize = 512,
): Promise<{ uri: string; width: number; height: number } | null> {
  try {
    const result = await native().createThumbnailAsync(sourceUri, maxSize);
    if (!result?.uri) return null;
    return {
      uri: result.uri,
      width: Number(result.width) || 0,
      height: Number(result.height) || 0,
    };
  } catch {
    return null;
  }
}

/** 旋转/裁剪：rotate 为 90 的倍数，crop 使用源图像素坐标（旋转后坐标系）。 */
export async function transformImage(
  sourceUri: string,
  options: {
    rotate?: number;
    crop?: { x: number; y: number; width: number; height: number } | null;
    quality?: number;
  },
): Promise<NativeTransformResult> {
  const result = await native().transformImageAsync(
    sourceUri,
    options.rotate ?? 0,
    options.crop?.x ?? -1,
    options.crop?.y ?? -1,
    options.crop?.width ?? 0,
    options.crop?.height ?? 0,
    options.quality ?? 95,
  );
  if (!result?.uri) {
    throw new AppError("storage", "图片处理失败，请重试");
  }
  return result as NativeTransformResult;
}

export async function imageInfo(sourceUri: string): Promise<NativeImageInfo> {
  return (await native().imageInfoAsync(sourceUri)) as NativeImageInfo;
}

/**
 * 多页图片合成 A4 PDF（页序 = 传入顺序）。
 * 生成在应用缓存目录，调用方负责复制进 staging 并删除缓存源文件。
 */
export async function createPdfFromImages(
  sourceUris: string[],
): Promise<{ uri: string; size: number; pages: number; mime: string }> {
  const result = await native().createPdfAsync(sourceUris);
  if (!result?.uri) {
    throw new AppError("storage", "PDF 生成失败，请重试");
  }
  return result as { uri: string; size: number; pages: number; mime: string };
}
