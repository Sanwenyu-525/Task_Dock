// 工具页：真实入口（常用 / 开发者工具 / 快捷操作）+ 中性占位（应用导航）。
//
// 本轮改造（2026-11-16）：
// - 移除 10 个「开发中」灰色占位，换成 11 个真实工具入口（都有页面与真实链路）；
// - 新增「最近使用」：从 db/toolUsage 读取，工具页常驻时通过订阅自动刷新；
// - 每个开发者工具右上角星标可直接加入/移出工作台，复用 entryLayoutStore，
//   不新建第二套收藏/入口管理机制；默认不把工具塞进首页，由用户决定；
// - 搜索覆盖常用、开发者工具、快捷操作与占位，一处过滤。
import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";

import { FeatureIconPlaceholder } from "../components/FeatureIconPlaceholder";
import { GlassCard } from "../components/GlassCard";
import { IconEntry } from "../components/IconEntry";
import { ScreenHeader } from "../components/ScreenHeader";
import { SearchField } from "../components/SearchField";
import { SectionHeader } from "../components/SectionHeader";
import { AppIcon, type IconName } from "../components/icons/AppIcon";
import { DEV_TOOLS, TOOL_CATEGORIES, toolById, type ToolDefinition } from "../features/tools/toolCatalog";
import { useToast } from "../feedback/ToastProvider";
import { commitEntryVisibility, useEntryLayout } from "../lib/entryLayoutStore";
import { describeError } from "../lib/errors";
import type { EntryId } from "../lib/entryRegistry";
import type { AppNav, RouteKey } from "../lib/nav";
import { gridColumnsForWidth } from "../lib/responsiveLayout";
import { listRecentTools, subscribeRecentTools, type RecentToolUse } from "../db/toolUsage";
import { useTheme } from "../theme/ThemeProvider";
import { font, space } from "../theme/tokens";

interface RealEntry {
  icon: IconName;
  label: string;
  hint?: string;
  onPress: () => void;
}

interface PlaceholderEntry {
  icon: IconName;
  label: string;
}

export function ToolsScreen({ nav }: { nav: AppNav }) {
  const { tokens } = useTheme();
  const { showToast } = useToast();
  const { config } = useEntryLayout();
  const [query, setQuery] = useState("");
  const [recent, setRecent] = useState<RecentToolUse[]>([]);
  const { width } = useWindowDimensions();
  const columns = gridColumnsForWidth(width);
  const cellStyle = columns === 3 ? styles.cellThird : styles.cellQuarter;

  const loadRecent = useCallback(() => {
    void listRecentTools()
      .then(setRecent)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    loadRecent();
    return subscribeRecentTools(loadRecent);
  }, [loadRecent]);

  const match = (label: string, hint = "") => {
    const keyword = query.trim().toLowerCase();
    return keyword.length === 0 || `${label} ${hint}`.toLowerCase().includes(keyword);
  };

  const push = (route: RouteKey) => () => nav.push(route);

  const common: RealEntry[] = [
    { icon: "archive", label: "采集中心", hint: "拍照、扫描、导入与本机素材", onPress: push("capture_home") },
    { icon: "noteNew", label: "快速笔记", hint: "直接新建一条笔记", onPress: push("note_editor") },
    { icon: "gauge", label: "诊断中心", hint: "本地自检、冲突与待发操作", onPress: push("diagnostics") },
  ];

  const navPlaceholder: PlaceholderEntry[] = [
    { icon: "project", label: "项目空间" },
    { icon: "list", label: "功能看板" },
  ];

  const quickReal: RealEntry[] = [
    { icon: "camera", label: "拍照上传", onPress: push("capture_camera") },
    { icon: "qr", label: "扫码配对", onPress: push("pairing") },
    { icon: "gallery", label: "相册/文件导入", onPress: push("capture_import") },
  ];

  const quickPlaceholder: PlaceholderEntry[] = [
    { icon: "clipboard", label: "剪贴板" },
    { icon: "smartphone", label: "投屏" },
  ];

  const recentTools = useMemo(
    () =>
      recent
        .map((entry) => toolById(entry.id))
        .filter((tool): tool is ToolDefinition => tool != null)
        .slice(0, 6),
    [recent],
  );

  const filteredCommon = common.filter((item) => match(item.label, item.hint));
  const filteredNav = navPlaceholder.filter((item) => match(item.label));
  const filteredQuick = quickReal.filter((item) => match(item.label, item.hint));
  const filteredQuickPlaceholder = quickPlaceholder.filter((item) => match(item.label));
  const filteredRecent = recentTools.filter((tool) => match(tool.title, tool.description));
  const filteredTools = DEV_TOOLS.filter((tool) => match(tool.title, tool.description));
  const searching = query.trim().length > 0;
  const nothingMatched =
    searching &&
    filteredCommon.length === 0 &&
    filteredNav.length === 0 &&
    filteredQuick.length === 0 &&
    filteredQuickPlaceholder.length === 0 &&
    filteredRecent.length === 0 &&
    filteredTools.length === 0;

  const toggleWorkbench = async (tool: ToolDefinition) => {
    const visible = config.visible.includes(tool.id as EntryId);
    try {
      await commitEntryVisibility(tool.id as EntryId, !visible);
      showToast(visible ? "已从工作台移除" : "已加入工作台", "success");
    } catch (error) {
      showToast(`更新工作台失败：${describeError(error)}`, "danger");
    }
  };

  const renderToolTile = (tool: ToolDefinition) => {
    const visible = config.visible.includes(tool.id as EntryId);
    return (
      <View key={tool.id} style={[styles.cell, cellStyle]}>
        <IconEntry
          icon={tool.icon}
          label={tool.title}
          onPress={() => nav.push(tool.route)}
          accessibilityHint={tool.description}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={visible ? `从工作台移除 ${tool.title}` : `把 ${tool.title} 加入工作台`}
          accessibilityState={{ selected: visible }}
          onPress={() => void toggleWorkbench(tool)}
          hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
          style={({ pressed }) => [styles.starButton, { opacity: pressed ? 0.55 : 1 }]}
        >
          <AppIcon name="star" size={14} color={visible ? tokens.accent : tokens.faint} />
        </Pressable>
      </View>
    );
  };

  return (
    <View style={styles.root}>
      <ScreenHeader title="工具" subtitle="采集、笔记与开发者效率工具" />
      <View style={styles.searchWrap}>
        <SearchField
          value={query}
          onChangeText={setQuery}
          placeholder="搜索工具名称或用途"
          accessibilityLabel="搜索工具"
        />
      </View>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        {nothingMatched ? (
          <Text style={[styles.emptyText, { color: tokens.muted }]}>没有匹配的工具，换个关键词试试。</Text>
        ) : (
          <>
            {filteredRecent.length > 0 ? (
              <View style={styles.group}>
                <SectionHeader icon="clock" title="最近使用" />
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.recentRow}>
                  {filteredRecent.map((tool) => (
                    <Pressable
                      key={tool.id}
                      accessibilityRole="button"
                      accessibilityLabel={`打开最近使用的 ${tool.title}`}
                      onPress={() => nav.push(tool.route)}
                      style={({ pressed }) => [
                        styles.recentChip,
                        {
                          backgroundColor: tokens.card,
                          borderColor: tokens.cardBorder,
                          opacity: pressed ? 0.7 : 1,
                        },
                      ]}
                    >
                      <AppIcon name={tool.icon} size={16} color={tokens.accent} />
                      <Text style={[styles.recentLabel, { color: tokens.text }]} numberOfLines={1}>
                        {tool.title}
                      </Text>
                    </Pressable>
                  ))}
                </ScrollView>
              </View>
            ) : null}

            {filteredCommon.length > 0 ? (
              <View style={styles.group}>
                <SectionHeader icon="zap" title="常用工具" />
                <GlassCard style={styles.gridCard}>
                  <View style={styles.grid}>
                    {filteredCommon.map((item) => (
                      <View key={item.label} style={[styles.cell, cellStyle]}>
                        <IconEntry
                          icon={item.icon}
                          label={item.label}
                          onPress={item.onPress}
                          accessibilityHint={item.hint}
                        />
                      </View>
                    ))}
                  </View>
                </GlassCard>
              </View>
            ) : null}

            {filteredTools.length > 0 ? (
              <View style={styles.group}>
                <SectionHeader
                  icon="wrench"
                  title="开发者工具"
                  actionLabel="管理入口"
                  onAction={() => nav.push("entry_manager")}
                />
                <GlassCard style={styles.gridCard}>
                  {TOOL_CATEGORIES.map((category) => {
                    const tools = filteredTools.filter((tool) => tool.category === category.id);
                    if (tools.length === 0) return null;
                    return (
                      <View key={category.id} style={styles.categoryBlock}>
                        <Text style={[styles.categoryLabel, { color: tokens.muted }]}>{category.label}</Text>
                        <View style={styles.grid}>{tools.map(renderToolTile)}</View>
                      </View>
                    );
                  })}
                </GlassCard>
                <Text style={[styles.tileHint, { color: tokens.muted }]}>
                  星标表示已加入工作台；默认不占用首页，可在「管理入口」里调整顺序与显隐。
                </Text>
              </View>
            ) : null}

            {filteredNav.length > 0 ? (
              <View style={styles.group}>
                <SectionHeader icon="tools" title="应用导航" />
                <GlassCard style={styles.gridCard}>
                  <View style={styles.grid}>
                    {filteredNav.map((item) => (
                      <View key={item.label} style={[styles.cell, cellStyle]}>
                        <FeatureIconPlaceholder icon={item.icon} label={item.label} variant="compact" />
                      </View>
                    ))}
                  </View>
                </GlassCard>
              </View>
            ) : null}

            {filteredQuick.length > 0 || filteredQuickPlaceholder.length > 0 ? (
              <View style={styles.group}>
                <SectionHeader icon="send" title="快捷操作" />
                <GlassCard style={styles.gridCard}>
                  <View style={styles.grid}>
                    {filteredQuick.map((item) => (
                      <View key={item.label} style={[styles.cell, cellStyle]}>
                        <IconEntry
                          icon={item.icon}
                          label={item.label}
                          onPress={item.onPress}
                          accessibilityHint={item.hint}
                        />
                      </View>
                    ))}
                    {filteredQuickPlaceholder.map((item) => (
                      <View key={item.label} style={[styles.cell, cellStyle]}>
                        <FeatureIconPlaceholder icon={item.icon} label={item.label} variant="compact" />
                      </View>
                    ))}
                  </View>
                </GlassCard>
              </View>
            ) : null}

            <Text style={[styles.footnote, { color: tokens.muted }]}>
              灰色图标是桌面端已有、移动端尚未接入的能力；开发者工具都有真实页面与离线处理链路。
            </Text>
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  searchWrap: { paddingHorizontal: space.lg, paddingBottom: space.xs },
  content: { paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: space.xxl, gap: space.section },
  group: { gap: space.md },
  gridCard: { paddingHorizontal: space.sm, paddingVertical: space.xs },
  grid: { flexDirection: "row", flexWrap: "wrap", rowGap: space.xs },
  cell: { flexGrow: 0, flexShrink: 1 },
  cellQuarter: { flexBasis: "25%" },
  cellThird: { flexBasis: "33.333%" },
  starButton: { position: "absolute", top: 0, right: 0, width: 32, height: 32, alignItems: "center", justifyContent: "center" },
  categoryBlock: { gap: 2, paddingTop: space.xs },
  categoryLabel: { fontSize: font.label, fontWeight: "600", paddingHorizontal: space.xs },
  recentRow: { gap: space.sm },
  recentChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.xs,
    paddingHorizontal: space.md,
    minHeight: 44,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
  },
  recentLabel: { fontSize: font.meta, fontWeight: "600" },
  tileHint: { fontSize: font.label, lineHeight: 17, paddingHorizontal: space.xs },
  footnote: { fontSize: font.label, lineHeight: 18, paddingHorizontal: space.xs },
  emptyText: { fontSize: font.meta, lineHeight: 20, paddingVertical: space.xl, textAlign: "center" },
});
