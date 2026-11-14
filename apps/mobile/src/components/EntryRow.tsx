// 列表行入口：图标底板 + 标题/说明 + 箭头。真实入口可点；占位行用 muted 色且不可点。
import { StyleSheet, Text, View } from "react-native";

import { useTheme } from "../theme/ThemeProvider";
import { font, radius, space } from "../theme/tokens";

import { Glyph, type GlyphName } from "./Glyph";
import { PressableScale } from "./PressableScale";

export function EntryRow({
  icon,
  label,
  helper,
  onPress,
  trailingText,
}: {
  icon: GlyphName;
  label: string;
  helper?: string;
  /** 省略 onPress 即为占位行：不可点、无二级页 */
  onPress?: () => void;
  trailingText?: string;
}) {
  const { tokens } = useTheme();
  const enabled = Boolean(onPress);

  const body = (
    <>
      <View style={[styles.tile, { backgroundColor: enabled ? tokens.accentWash : tokens.track }]}>
        <Glyph name={icon} color={enabled ? tokens.accent : tokens.faint} size={18} />
      </View>
      <View style={styles.text}>
        <Text numberOfLines={1} style={[styles.label, { color: enabled ? tokens.text : tokens.muted }]}>
          {label}
        </Text>
        {helper ? (
          <Text numberOfLines={2} style={[styles.helper, { color: tokens.muted }]}>
            {helper}
          </Text>
        ) : null}
      </View>
      {trailingText ? (
        <Text numberOfLines={1} style={[styles.trailing, { color: tokens.faint }]}>
          {trailingText}
        </Text>
      ) : null}
      {enabled ? <Glyph name="chevron" color={tokens.faint} size={14} /> : null}
    </>
  );

  if (!onPress) {
    return (
      <View
        accessible
        accessibilityLabel={helper ? `${label}，${helper}` : `${label}，移动端暂未接入`}
        accessibilityState={{ disabled: true }}
        style={styles.row}
      >
        {body}
      </View>
    );
  }

  return (
    <PressableScale
      onPress={onPress}
      accessibilityLabel={label}
      accessibilityHint={helper}
      style={styles.press}
      contentStyle={styles.row}
      scaleTo={0.98}
    >
      {body}
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  press: {},
  row: {
    minHeight: 56,
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingVertical: space.xs,
  },
  tile: {
    width: 36,
    height: 36,
    borderRadius: radius.control,
    alignItems: "center",
    justifyContent: "center",
  },
  text: { flex: 1, gap: 1 },
  label: { fontSize: font.body, fontWeight: "600" },
  helper: { fontSize: font.label, lineHeight: 16 },
  trailing: { fontSize: font.label, fontWeight: "600" },
});
