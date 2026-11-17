// 图标底板：统一「图标放在什么底上」，避免每个页面各写一套方块。
//
// 两种语气：
//   primary  真实可用的一级入口（浅蓝渐变底 + 细描边 + 蓝线图标）
//   neutral  未接入功能 / 弱信息（中性底 + 灰线图标，明确不可点）
//
// 板径只有三档，新增入口必须落在这三档里，不得自造 38/40/48 这类中间值：
//   46  页面/网格上的入口（IconEntry、占位 compact、工作区两列网格）
//   36  卡片与列表内的入口（EntryRow、FileCollectionCard、项目卡、活动行）
//   30  统计磁贴（MetricTile stat）；24 只给分区标题（SettingSection / 分组头）
//
// 一屏只允许一层底：卡片/磁贴本身已有底色（accentWash / accentSoft / accentFill）时，
// 图标要裸放，不再叠底板；否则会变成「底上叠底」，两层几乎同色，看起来脏。
//
// 品牌标识不是底板语气，统一走 BrandMark（蓝→青渐变 + 白色 </>）。
// 渐变用 RN 自己的 backgroundImage（Fabric 原生实现，没有第三方依赖）。
// 之前试过「角部光斑 View」，在真机上是一块硬边扇形，像裁切事故，已废弃。
import type { StyleProp, ViewStyle } from "react-native";
import { StyleSheet, View } from "react-native";

import { useTheme } from "../theme/ThemeProvider";

import { AppIcon, type IconName } from "./icons/AppIcon";

export type IconTileTone = "primary" | "neutral";

/** 底板圆角 = 边长的 30%（46→14 / 36→11 / 30→9），不同板径的形状语言保持一致 */
export function iconTileRadius(size: number) {
  return Math.round(size * 0.3);
}

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
      : { backgroundColor: tokens.track, borderColor: "transparent" };

  const color = tone === "primary" ? tokens.accent : tokens.faint;

  return (
    <View
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      style={[
        styles.tile,
        {
          width: size,
          height: size,
          borderRadius: iconTileRadius(size),
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
  },
});
