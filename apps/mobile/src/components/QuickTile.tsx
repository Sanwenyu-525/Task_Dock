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
  badge,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  /** 真实计数徽标（没有计数时不要传） */
  badge?: number;
}) {
  const { tokens } = useTheme();

  return (
    <PressableScale
      onPress={onPress}
      accessibilityLabel={label}
      style={styles.press}
      contentStyle={[styles.tile, { backgroundColor: tokens.accentWash }]}
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
      <Text numberOfLines={1} style={[styles.label, { color: tokens.text }]}>
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
    paddingVertical: space.sm + 2,
    alignItems: "center",
    justifyContent: "center",
    gap: space.sm,
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
  },
});
