// 未接入占位页：移动端没有这条能力的数据链路时，用它承载「入口存在但页面未接入」。
//
// 硬约束（与 FeatureIconPlaceholder 同一条纪律）：
// - 不渲染任何假卡片、假进度、假列表、假按钮；
// - 只说明「缺什么能力、去哪里才能用」，让用户不会把空白当成故障；
// - 顶栏是可返回的 AppBar，保证返回路径与其它推送页一致。
import { ScrollView, StyleSheet, Text, View } from "react-native";

import { useTheme } from "../theme/ThemeProvider";
import { font, space } from "../theme/tokens";

import { AppBar } from "./AppBar";
import { AppIcon, type IconName } from "./icons/AppIcon";

export function PlaceholderPage({
  title,
  icon,
  reason,
  from,
  onBack,
}: {
  title: string;
  icon: IconName;
  /** 为什么这里没有内容（一句话，说明缺的是数据链路而不是功能坏了） */
  reason: string;
  /** 这项能力在桌面端的位置，给用户一个可执行的下一步 */
  from: string;
  onBack: () => void;
}) {
  const { tokens } = useTheme();

  return (
    <View style={styles.root}>
      <AppBar title={title} onBack={onBack} />
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View
          accessible
          accessibilityLabel={`${title}，${reason}${from}`}
          style={[styles.iconWrap, { backgroundColor: tokens.track }]}
        >
          <AppIcon name={icon} color={tokens.faint} size={40} />
        </View>
        <Text style={[styles.headline, { color: tokens.text }]}>移动端尚未接入</Text>
        <Text style={[styles.reason, { color: tokens.muted }]}>{reason}</Text>
        <Text style={[styles.from, { color: tokens.faint }]}>{from}</Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: {
    flexGrow: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: space.md,
    paddingHorizontal: space.xxl,
    paddingBottom: space.xxl,
  },
  iconWrap: {
    width: 88,
    height: 88,
    borderRadius: 44,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: space.xs,
  },
  headline: { fontSize: font.section, fontWeight: "600" },
  reason: { fontSize: font.meta, lineHeight: 20, textAlign: "center" },
  from: { fontSize: font.label, textAlign: "center" },
});
