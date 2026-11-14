// 可点击的图标入口（四列网格单元）：图标底板 + 一行名称，热区 ≥ 44dp。
// 仅用于「真的有行为」的入口；未实现能力一律用 FeatureIconPlaceholder。
import { StyleSheet, Text, View } from "react-native";

import { useTheme } from "../theme/ThemeProvider";
import { font, space } from "../theme/tokens";

import { IconTile } from "./IconTile";
import { type IconName } from "./icons/AppIcon";
import { PressableScale } from "./PressableScale";

export function IconEntry({
  icon,
  label,
  onPress,
  accessibilityHint,
  badge,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  accessibilityHint?: string;
  /** 真实计数徽标（没有计数时不要传） */
  badge?: number;
}) {
  const { tokens } = useTheme();

  return (
    <PressableScale
      onPress={onPress}
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      style={styles.press}
      contentStyle={styles.content}
      scaleTo={0.94}
    >
      <View>
        <IconTile name={icon} size={46} />
        {badge != null && badge > 0 ? (
          <View style={[styles.badge, { backgroundColor: tokens.accentFill }]}>
            <Text numberOfLines={1} style={[styles.badgeText, { color: tokens.onAccent }]}>
              {badge > 99 ? "99+" : badge}
            </Text>
          </View>
        ) : null}
      </View>
      <Text numberOfLines={2} style={[styles.label, { color: tokens.text }]}>
        {label}
      </Text>
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  press: {
    flexBasis: "25%",
    flexGrow: 0,
    flexShrink: 1,
  },
  content: {
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    paddingVertical: space.sm,
    minHeight: 84,
  },
  badge: {
    position: "absolute",
    top: -5,
    right: -7,
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
    fontWeight: "600",
    textAlign: "center",
    lineHeight: 16,
  },
});
