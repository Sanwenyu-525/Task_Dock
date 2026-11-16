// 聚合页的入口卡片：文本处理 / 资料与链接共用，避免两套相同 JSX 与样式。
import { Pressable, StyleSheet, Text, View } from "react-native";

import { AppIcon, type IconName } from "../../../components/icons/AppIcon";
import { useTheme } from "../../../theme/ThemeProvider";
import { font, radius, space } from "../../../theme/tokens";

export function ToolHubCard({
  title,
  description,
  icon,
  onPress,
}: {
  title: string;
  description: string;
  icon: IconName;
  onPress: () => void;
}) {
  const { tokens } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`打开${title}`}
      accessibilityHint={description}
      onPress={onPress}
      style={({ pressed }) => [
        styles.card,
        {
          backgroundColor: tokens.card,
          borderColor: tokens.cardBorder,
          opacity: pressed ? 0.72 : 1,
        },
      ]}
    >
      <View style={[styles.iconTile, { backgroundColor: tokens.accentSoft }]}>
        <AppIcon name={icon} size={22} color={tokens.accent} />
      </View>
      <View style={styles.body}>
        <Text style={[styles.title, { color: tokens.text }]}>{title}</Text>
        <Text style={[styles.description, { color: tokens.muted }]} numberOfLines={2}>
          {description}
        </Text>
      </View>
      <AppIcon name="chevronRight" size={18} color={tokens.faint} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    minHeight: 76,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.row,
    borderWidth: StyleSheet.hairlineWidth,
  },
  iconTile: {
    width: 44,
    height: 44,
    borderRadius: radius.tile,
    alignItems: "center",
    justifyContent: "center",
  },
  body: { flex: 1, gap: 3, minWidth: 0 },
  title: { fontSize: font.title, fontWeight: "600" },
  description: { fontSize: font.meta, lineHeight: 19 },
});
