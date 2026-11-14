// 统一图标组件：App 内所有通用图标只从这里出，不允许页面各自画图。
//
// 几何来自项目已有的 lucide 图标（桌面端同一套），构建期栅格化成单色透明位图，
// 运行时只做 tintColor 着色。这样做的原因见 iconAssets.g.ts 头部：
// 当前机器空闲内存约 1GB，无法跑原生构建，react-native-svg / 字体图标都会强制重建 APK。
//
// 尺寸约定（调用方按用途选，不允许随手给数）：
//   14–16 小状态 / 行内附注，18 行内操作，20 模块标题，22–24 工具入口与底部导航，
//   24–28 功能占位，32 空状态。
import { useMemo } from "react";
import { Image, type StyleProp, type ImageStyle } from "react-native";

import iconMap from "./iconMap.json";
import { ICON_BITMAP } from "./iconAssets.g";

export type IconName = keyof typeof iconMap.map;

const sourceCache = new Map<string, { uri: string }>();
function sourceOf(uri: string) {
  let source = sourceCache.get(uri);
  if (!source) {
    source = { uri };
    sourceCache.set(uri, source);
  }
  return source;
}

export function AppIcon({
  name,
  size = 22,
  color,
  style,
}: {
  name: IconName;
  /** 视觉边长（dp）。按用途取值，见文件头。 */
  size?: number;
  color: string;
  style?: StyleProp<ImageStyle>;
}) {
  const bitmap = ICON_BITMAP[name];
  // 小尺寸换细线版本、大尺寸换更细的线宽版本，保证不同尺寸的视觉重量一致
  const preferSmall = size <= 16 && bitmap.sm != null;
  const preferLarge = size >= 30 && bitmap.lg != null;
  const uri = preferSmall ? bitmap.sm! : preferLarge ? bitmap.lg! : bitmap.md;
  const source = useMemo(() => sourceOf(uri), [uri]);

  return (
    <Image
      accessible={false}
      importantForAccessibility="no"
      fadeDuration={0}
      resizeMode="contain"
      source={source}
      style={[{ width: size, height: size, tintColor: color }, style]}
    />
  );
}
