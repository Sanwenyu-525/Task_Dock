// 底部导航：参考「蓝青专业版」的一体式导航条。
// 贴屏幕底部、白/主题表面、顶部 hairline，不做浮动外框、不做滑动胶囊；
// 五项等宽，选中 = 品牌蓝图标 + 蓝字，未选中 = 中性灰蓝。
// 点击区高度 ≥ 52dp；底部安全区由 bottomInset 自然衔接。
import { Pressable, StyleSheet, Text, View } from "react-native";

import type { TabKey } from "../lib/nav";
import { useTheme } from "../theme/ThemeProvider";
import { font, space } from "../theme/tokens";

import { AppIcon, type IconName } from "./icons/AppIcon";

export type { TabKey };

const TABS: { key: TabKey; label: string; icon: IconName }[] = [
  { key: "home", label: "首页", icon: "home" },
  { key: "tasks", label: "任务", icon: "tasks" },
  { key: "workspace", label: "工作区", icon: "workspace" },
  { key: "tools", label: "工具", icon: "tools" },
  { key: "profile", label: "我的", icon: "profile" },
];

export function TabBar({
  active,
  onChange,
  bottomInset,
}: {
  active: TabKey;
  onChange: (key: TabKey) => void;
  bottomInset: number;
}) {
  const { tokens } = useTheme();

  return (
    <View
      style={[
        styles.host,
        {
          backgroundColor: tokens.card,
          borderTopColor: tokens.separator,
          paddingBottom: Math.max(bottomInset, space.xs + 2),
        },
      ]}
    >
      <View accessibilityRole="tablist" style={styles.track}>
        {TABS.map((tab) => {
          const selected = tab.key === active;
          const color = selected ? tokens.accent : tokens.muted;
          return (
            <Pressable
              key={tab.key}
              accessibilityRole="tab"
              accessibilityLabel={tab.label}
              accessibilityHint={selected ? undefined : `切换到${tab.label}`}
              accessibilityState={{ selected }}
              onPress={() => onChange(tab.key)}
              style={({ pressed }) => [styles.item, { opacity: pressed ? 0.65 : 1 }]}
            >
              <AppIcon name={tab.icon} color={color} size={22} />
              <Text
                numberOfLines={1}
                style={[
                  styles.label,
                  { color: selected ? tokens.accentText : tokens.muted },
                  selected ? styles.labelActive : null,
                ]}
              >
                {tab.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  host: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: space.xs + 2,
  },
  track: {
    flexDirection: "row",
  },
  item: {
    flex: 1,
    minHeight: 52,
    alignItems: "center",
    justifyContent: "center",
    gap: 3,
  },
  label: {
    fontSize: font.tab,
    fontWeight: "500",
    letterSpacing: 0.2,
  },
  labelActive: {
    fontWeight: "700",
  },
});
