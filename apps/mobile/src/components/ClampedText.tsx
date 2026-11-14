// 长文本容器：默认最多 N 行，超出时才显示「展开全文」；收起后回到 N 行。
// 判定不靠字符数猜：先渲染一层透明同宽文本量出真实行数，再决定是否出现展开按钮，
// 这样中文长段落、英文长串、URL 与带换行的速记都能得到同一个结论。
import { useState } from "react";
import { Pressable, StyleSheet, Text, View, type StyleProp, type TextStyle } from "react-native";

import { useTheme } from "../theme/ThemeProvider";
import { font, space } from "../theme/tokens";

export function ClampedText({
  text,
  maxLines,
  style,
}: {
  text: string;
  maxLines: number;
  style?: StyleProp<TextStyle>;
}) {
  const { tokens } = useTheme();
  const [expanded, setExpanded] = useState(false);
  const [overflow, setOverflow] = useState(false);
  const [measured, setMeasured] = useState(false);

  return (
    <View>
      <Text numberOfLines={expanded ? undefined : maxLines} style={style}>
        {text}
      </Text>

      {/* 只在首次布局时测量一次；测量完卸载，不参与后续滚动开销 */}
      {measured ? null : (
        <Text
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          pointerEvents="none"
          style={[style, styles.measure]}
          onTextLayout={(event) => {
            setOverflow(event.nativeEvent.lines.length > maxLines);
            setMeasured(true);
          }}
        >
          {text}
        </Text>
      )}

      {overflow ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={expanded ? "收起长文本" : "展开全文"}
          onPress={() => setExpanded((value) => !value)}
          hitSlop={{ top: 6, bottom: 6, left: 8, right: 8 }}
          style={({ pressed }) => [styles.toggle, { opacity: pressed ? 0.6 : 1 }]}
        >
          <Text style={[styles.toggleText, { color: tokens.accentText }]}>
            {expanded ? "收起" : "展开全文"}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  // 透明测量层：与正文同宽，绝对定位，不占布局高度
  measure: {
    position: "absolute",
    left: 0,
    right: 0,
    opacity: 0,
  },
  toggle: {
    alignSelf: "flex-start",
    minHeight: 36,
    justifyContent: "center",
    marginTop: space.xxs,
  },
  toggleText: {
    fontSize: font.label,
    fontWeight: "700",
  },
});
