// 文件集合卡片：三列文件夹型入口。真实入口（文件互传）可点；未接入的暂存架/项目资源
// 只作占位，不显示虚假的文件数量。底板与真实/占位状态同 IconEntry 一套口径。
//
// 第五轮：130% 以上字号时三列宽度放不下「文件暂存架」，由 WorkspaceScreen 切换为
// layout="row" 的全宽横排；正常字号仍用三列等高卡。
// 第六轮：未接入卡改为浅蓝无描边面板，真实入口保持白卡 + 描边，不再只靠图标颜色区分。
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
  layout = "column",
}: {
  icon: IconName;
  label: string;
  /** 真实入口的一行说明；未接入占位不需要说明文字 */
  caption?: string;
  onPress?: () => void;
  /** row：大字号下的全宽横排；column：默认三列卡 */
  layout?: "column" | "row";
}) {
  const { tokens } = useTheme();
  const enabled = Boolean(onPress);
  const horizontal = layout === "row";

  const text = (
    <>
      <Text numberOfLines={1} style={[styles.label, { color: enabled ? tokens.text : tokens.muted }]}>
        {label}
      </Text>
      {/* 说明槽位三轮对齐：没有说明的占位卡也保留空槽，三张卡的图标与标题才会在同一条线上 */}
      <Text
        numberOfLines={1}
        style={[styles.caption, { color: enabled ? tokens.accentText : tokens.muted }]}
      >
        {caption ?? (enabled ? "" : "暂未接入")}
      </Text>
    </>
  );

  const body = horizontal ? (
    <View style={styles.rowInner}>
      <IconTile name={icon} size={40} tone={enabled ? "primary" : "neutral"} />
      <View style={styles.rowText}>{text}</View>
    </View>
  ) : (
    <>
      <IconTile name={icon} size={40} tone={enabled ? "primary" : "neutral"} />
      {text}
    </>
  );

  const style = [
    styles.card,
    horizontal ? styles.cardRow : null,
    // 真实入口 = 白卡 + 描边；未接入 = 与页面同系的浅蓝面板、无描边。
    // 两者不能只靠图标颜色区分，否则一眼扫过去仍像三个都能点。
    enabled
      ? { backgroundColor: tokens.card, borderColor: tokens.cardBorder }
      : { backgroundColor: tokens.bgAccent, borderColor: "transparent" },
  ];

  if (!onPress) {
    return (
      <View
        accessible
        accessibilityLabel={`${label}，移动端暂未接入`}
        accessibilityState={{ disabled: true }}
        style={style}
      >
        {body}
      </View>
    );
  }

  return (
    <PressableScale
      onPress={onPress}
      accessibilityLabel={label}
      accessibilityHint={caption}
      style={horizontal ? styles.pressWide : styles.press}
      contentStyle={style}
      scaleTo={0.96}
    >
      {body}
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  press: { flex: 1 },
  pressWide: { width: "100%" },
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
  cardRow: {
    flex: 0,
    width: "100%",
    minHeight: 64,
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingHorizontal: space.md,
    paddingVertical: space.sm + 2,
  },
  rowInner: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
  },
  rowText: {
    flex: 1,
    gap: 1,
  },
  label: {
    fontSize: font.meta,
    fontWeight: "700",
  },
  caption: {
    fontSize: font.label,
  },
});
