// 轻量快捷磁贴：浅蓝底 + 无底板图标 + 名称。
// 用于首页「快捷入口」这类短入口；与 IconEntry（渐变图标底板 + 无背景）区分层级。
// 只给真实可用入口使用；未接入能力不得伪装成磁贴。
import { StyleSheet, Text, View } from "react-native";

import { useTheme } from "../theme/ThemeProvider";
import { font, radius, space } from "../theme/tokens";

import { AppIcon, type IconName } from "./icons/AppIcon";
import { PressableScale } from "./PressableScale";

export function QuickTile({
  icon,
  label,
  onPress,
  onLongPress,
  badge,
  width,
  height,
  labelLineHeight,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  /** 长按进入工作台编辑模式（入口自定义）；不传则无长按行为 */
  onLongPress?: () => void;
  /** 真实计数徽标（没有计数时不要传） */
  badge?: number;
  /**
   * 固定宽度：首页横向轨道由 lib/entryRail 统一算出磁贴宽度传进来。
   * 不传时保持原来的「占满父容器一格」（flex:1）行为。
   */
  width?: number;
  /** 固定高度：轨道高度只跟字体缩放有关，与入口数量无关 */
  height?: number;
  /** 名称行高：字体放大时显式抬高，避免两行标签被裁掉半行 */
  labelLineHeight?: number;
}) {
  const { tokens } = useTheme();

  return (
    <PressableScale
      onPress={onPress}
      onLongPress={onLongPress}
      accessibilityLabel={label}
      accessibilityHint={onLongPress ? "长按进入编辑模式，可调整顺序或移除" : undefined}
      style={
        width != null
          ? { width, flexGrow: 0, flexShrink: 0, flexBasis: "auto" }
          : styles.press
      }
      contentStyle={[
        styles.tile,
        { backgroundColor: tokens.accentWash },
        height != null ? { height } : null,
      ]}
      scaleTo={0.95}
    >
      <View>
        <AppIcon name={icon} color={tokens.accent} size={24} />
        {badge != null && badge > 0 ? (
          <View style={[styles.badge, { backgroundColor: tokens.accentFill }]}>
            <Text numberOfLines={1} style={[styles.badgeText, { color: tokens.onAccent }]}>
              {badge > 99 ? "99+" : badge}
            </Text>
          </View>
        ) : null}
      </View>
      <Text
        numberOfLines={2}
        style={[
          styles.label,
          { color: tokens.text },
          labelLineHeight != null ? { lineHeight: labelLineHeight } : null,
        ]}
      >
        {label}
      </Text>
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  press: {
    flex: 1,
  },
  tile: {
    minHeight: 78,
    borderRadius: radius.row,
    paddingHorizontal: space.xs,
    paddingVertical: space.sm,
    alignItems: "center",
    justifyContent: "center",
    // 两行标签要挤进 78 的磁贴高度：图标 24 + 间距 6 + 两行 28 + 上下内边距 16 = 74
    gap: 6,
  },
  badge: {
    position: "absolute",
    top: -6,
    right: -10,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    paddingHorizontal: 4,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeText: {
    fontSize: 10,
    fontWeight: "700",
  },
  label: {
    fontSize: font.label,
    fontWeight: "700",
    textAlign: "center",
    lineHeight: 14,
  },
});
