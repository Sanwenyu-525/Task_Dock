// 图标底板：统一「图标放在什么底上」，避免每个页面各写一套方块。
//
// 三种语气：
//   primary  真实可用的一级入口（浅蓝渐变底 + 细描边 + 蓝线图标）
//   neutral  未接入功能 / 弱信息（中性底 + 灰线图标，明确不可点）
//   brand    品牌块（蓝底白图标，只给应用标识用）
//
// 渐变用 RN 自己的 backgroundImage（Fabric 原生实现，没有第三方依赖）。
// 之前试过「角部光斑 View」，在真机上是一块硬边扇形，像裁切事故，已废弃。
import type { StyleProp, ViewStyle } from "react-native";
import { StyleSheet, View } from "react-native";

import { useTheme } from "../theme/ThemeProvider";
import { radius } from "../theme/tokens";

import { AppIcon, type IconName } from "./icons/AppIcon";

export type IconTileTone = "primary" | "neutral" | "brand";

function iconSizeFor(tile: number) {
  if (tile >= 44) return 22;
  if (tile >= 36) return 20;
  return 18;
}

export function IconTile({
  name,
  size = 46,
  tone = "primary",
  iconSize,
  style,
}: {
  name: IconName;
  /** 底板边长（dp） */
  size?: number;
  tone?: IconTileTone;
  /** 需要和底板不成比例时显式指定（默认按底板大小取 18/20/22） */
  iconSize?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const { tokens } = useTheme();

  const surface =
    tone === "primary"
      ? {
          backgroundImage: `linear-gradient(145deg, ${tokens.tileBase} 0%, ${tokens.tileBaseAlt} 100%)`,
          borderColor: tokens.tileBorder,
        }
      : tone === "brand"
        ? { backgroundColor: tokens.accentFill, borderColor: "transparent" }
        : { backgroundColor: tokens.track, borderColor: "transparent" };

  const color =
    tone === "primary" ? tokens.accent : tone === "brand" ? tokens.onAccent : tokens.faint;

  return (
    <View
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      style={[
        styles.tile,
        {
          width: size,
          height: size,
          borderRadius: Math.round(size * 0.3),
        },
        surface,
        style,
      ]}
    >
      <AppIcon name={name} size={iconSize ?? iconSizeFor(size)} color={color} />
    </View>
  );
}

const styles = StyleSheet.create({
  tile: {
    alignItems: "center",
    justifyContent: "center",
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
    borderRadius: radius.iconTile,
  },
});
