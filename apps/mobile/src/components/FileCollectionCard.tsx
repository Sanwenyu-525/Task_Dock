// 文件集合卡片：三列文件夹型入口。真实入口（文件互传）可点；未接入的暂存架/项目资源
// 只作占位，不显示虚假的文件数量。底板与真实/占位状态同 IconEntry 一套口径。
import { StyleSheet, Text, View } from "react-native";

import { useTheme } from "../theme/ThemeProvider";
import { font, radius, space } from "../theme/tokens";

import { IconTile } from "./IconTile";
import { type IconName } from "./icons/AppIcon";
import { PressableScale } from "./PressableScale";

export function FileCollectionCard({
  icon,
  label,
  caption,
  onPress,
}: {
  icon: IconName;
  label: string;
  /** 真实入口的一行说明；未接入占位不需要说明文字 */
  caption?: string;
  onPress?: () => void;
}) {
  const { tokens } = useTheme();
  const enabled = Boolean(onPress);

  const inner = (
    <>
      <IconTile name={icon} size={40} tone={enabled ? "primary" : "neutral"} />
      <Text numberOfLines={1} style={[styles.label, { color: enabled ? tokens.text : tokens.muted }]}>
        {label}
      </Text>
      {/* 说明槽位三等分对齐：没有说明的占位卡也保留空槽，三张卡的图标与标题才会在同一条线上 */}
      <Text
        numberOfLines={1}
        style={[styles.caption, { color: enabled ? tokens.muted : tokens.faint }]}
      >
        {caption ?? (enabled ? "" : "暂未接入")}
      </Text>
    </>
  );

  const style = [
    styles.card,
    { backgroundColor: tokens.card, borderColor: tokens.cardBorder },
  ];

  if (!onPress) {
    return (
      <View
        accessible
        accessibilityLabel={`${label}，移动端暂未接入`}
        accessibilityState={{ disabled: true }}
        style={style}
      >
        {inner}
      </View>
    );
  }

  return (
    <PressableScale
      onPress={onPress}
      accessibilityLabel={label}
      accessibilityHint={caption}
      style={styles.press}
      contentStyle={style}
      scaleTo={0.96}
    >
      {inner}
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  press: { flex: 1 },
  card: {
    flex: 1,
    minHeight: 96,
    borderRadius: radius.row,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 11,
    paddingVertical: space.sm + 2,
    gap: 4,
    justifyContent: "center",
  },
  label: {
    fontSize: font.meta,
    fontWeight: "700",
  },
  caption: {
    fontSize: font.label,
  },
});
