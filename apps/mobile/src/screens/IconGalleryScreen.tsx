// 图标预览页（开发验收专用，不在任何导航入口里暴露）。
// 入口：我的 → 长按「开发效率中枢 · v版本」这一行。
//
// 目的是逐个真实渲染检查：是否裁切、是否偏心、线宽是否一致、16dp 下是否还认得出来、
// 选中/禁用态是否有区分。检查完一个勾一个，不能只看名字和类型。
import { ScrollView, StyleSheet, Text, View } from "react-native";

import { AppBar } from "../components/AppBar";
import { GlassCard } from "../components/GlassCard";
import { IconTile } from "../components/IconTile";
import { AppIcon, type IconName } from "../components/icons/AppIcon";
import iconMap from "../components/icons/iconMap.json";
import type { Nav } from "../lib/nav";
import { useTheme } from "../theme/ThemeProvider";
import { font, space } from "../theme/tokens";

const NAMES = Object.keys(iconMap.map) as IconName[];
const SIZES = [16, 20, 24, 32] as const;
/** 状态检查只用有代表性的 12 枚：覆盖导航、操作、状态、文件四类 */
const STATE_SAMPLE: IconName[] = [
  "home",
  "tasks",
  "workspace",
  "tools",
  "profile",
  "add",
  "search",
  "bell",
  "success",
  "warning",
  "error",
  "transfer",
];

export function IconGalleryScreen({ nav }: { nav: Nav }) {
  const { tokens, scheme } = useTheme();

  return (
    <View style={styles.root}>
      <AppBar title="图标预览" onBack={nav.back} />

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Text style={[styles.meta, { color: tokens.muted }]}>
          {NAMES.length} 枚语义图标 · 当前 {scheme === "dark" ? "深色" : "浅色"}主题 ·
          几何来自 lucide（与桌面端同一套），构建期栅格化
        </Text>

        <Text style={[styles.section, { color: tokens.text }]}>全部图标 @24</Text>
        <GlassCard style={styles.card}>
          <View style={styles.grid}>
            {NAMES.map((name) => (
              <View key={name} style={styles.cell}>
                <AppIcon name={name} size={24} color={tokens.text} />
                <Text numberOfLines={1} style={[styles.cellName, { color: tokens.muted }]}>
                  {name}
                </Text>
              </View>
            ))}
          </View>
        </GlassCard>

        <Text style={[styles.section, { color: tokens.text }]}>尺寸 16 / 20 / 24 / 32</Text>
        <GlassCard style={styles.card}>
          {NAMES.map((name, index) => (
            <View
              key={name}
              style={[
                styles.sizeRow,
                index > 0 ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: tokens.separator } : null,
              ]}
            >
              <Text numberOfLines={1} style={[styles.sizeName, { color: tokens.muted }]}>
                {name}
              </Text>
              {SIZES.map((size) => (
                <View key={size} style={styles.sizeCell}>
                  <AppIcon name={name} size={size} color={tokens.text} />
                </View>
              ))}
            </View>
          ))}
        </GlassCard>

        <Text style={[styles.section, { color: tokens.text }]}>状态：正常 / 选中 / 禁用</Text>
        <GlassCard style={styles.card}>
          <View style={[styles.stateHead, { borderBottomColor: tokens.separator }]}>
            <Text style={[styles.sizeName, { color: tokens.muted }]}>图标</Text>
            {["正常", "选中", "禁用"].map((label) => (
              <Text key={label} style={[styles.stateCell, styles.stateHeadLabel, { color: tokens.muted }]}>
                {label}
              </Text>
            ))}
          </View>
          {STATE_SAMPLE.map((name, index) => (
            <View
              key={name}
              style={[
                styles.sizeRow,
                index > 0
                  ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: tokens.separator }
                  : null,
              ]}
            >
              <Text numberOfLines={1} style={[styles.sizeName, { color: tokens.muted }]}>
                {name}
              </Text>
              <View style={styles.stateCell}>
                <AppIcon name={name} size={22} color={tokens.text} />
              </View>
              <View style={styles.stateCell}>
                <AppIcon name={name} size={22} color={tokens.accent} />
              </View>
              <View style={styles.stateCell}>
                <AppIcon name={name} size={22} color={tokens.faint} />
              </View>
            </View>
          ))}
        </GlassCard>

        <Text style={[styles.section, { color: tokens.text }]}>底板：一级入口 / 占位 / 品牌</Text>
        <GlassCard style={styles.card}>
          <View style={styles.tileRow}>
            <IconTile name="inbox" size={46} />
            <IconTile name="inbox" size={40} />
            <IconTile name="inbox" size={36} />
            <IconTile name="inbox" size={30} iconSize={18} />
            <IconTile name="clipboard" size={46} tone="neutral" />
            <IconTile name="project" size={46} tone="brand" />
          </View>
        </GlassCard>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: {
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: space.xxl,
    gap: space.sm,
  },
  meta: { fontSize: font.label, lineHeight: 17 },
  section: {
    fontSize: font.section,
    fontWeight: "700",
    marginTop: space.md,
  },
  card: { padding: space.sm },
  grid: { flexDirection: "row", flexWrap: "wrap" },
  cell: {
    width: "20%",
    alignItems: "center",
    paddingVertical: space.sm,
    gap: 4,
  },
  cellName: { fontSize: 10 },
  stateHead: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: space.xs,
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  stateHeadLabel: { fontSize: font.label, textAlign: "center" },
  stateCell: {
    width: 56,
    alignItems: "center",
    justifyContent: "center",
  },
  sizeRow: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 40,
    paddingHorizontal: space.xs,
  },
  sizeName: { flex: 1, fontSize: font.label },
  sizeCell: {
    width: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  tileRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    padding: space.xs,
  },
});
