// 工具页（2026-11-16 产品整改后）。
//
// 结构按「移动场景价值」而不是「技术分类」组织：
// 最近使用 → 常用操作 → 图片与素材 → 资料与内容 → 高级工具。
// API 调试 / 正则 / 代码对比已从普通工具体系下架；搜索、最近使用与星标只认新目录，
// 旧入口不会借最近使用记录重新出现。
import { useCallback, useEffect, useMemo, useState } from "react";
import { Keyboard, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";

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

interface ShortcutEntry {
  icon: IconName;
  label: string;
  hint: string;
  route: RouteKey;
}

/** 常用操作：全部是已有真实页面，不再放「开发中」占位。 */
const COMMON_ACTIONS: ShortcutEntry[] = [
  { icon: "archive", label: "采集中心", hint: "拍照、扫描、导入与本机素材", route: "capture_home" },
  { icon: "noteNew", label: "快速笔记", hint: "直接新建一条笔记", route: "note_editor" },
  { icon: "transfer", label: "文件互传", hint: "与已配对电脑互传文件", route: "files" },
  { icon: "qr", label: "扫码配对", hint: "扫描桌面端二维码或输入配对码", route: "pairing" },
];

/** 图片与素材的辅助动作：与图片压缩 / 取色器同区展示。 */
const IMAGE_SHORTCUTS: ShortcutEntry[] = [
  { icon: "fileStack", label: "本机素材库", hint: "本机采集素材（不是桌面暂存架）", route: "capture_stash" },
  { icon: "upload", label: "文件导入", hint: "从系统文件选择器导入", route: "capture_import" },
];

export function ToolsScreen({ nav }: { nav: AppNav }) {
  const { tokens } = useTheme();
  const { showToast } = useToast();
  const { config } = useEntryLayout();
  const [query, setQuery] = useState("");
  const [recent, setRecent] = useState<RecentToolUse[]>([]);
  const { width } = useWindowDimensions();
  const columns = gridColumnsForWidth(width);
  const cellStyle = columns === 2 ? styles.cellHalf : styles.cellQuarter;

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

  // 修复真机验收发现的问题：进入工具页前先收起键盘，避免底层搜索框继续持有焦点、
  // 把用户在工具输入框里的第一次键入吸到搜索框。
  const openRoute = (route: RouteKey) => {
    Keyboard.dismiss();
    nav.push(route);
  };

  const recentTools = useMemo(
    () =>
      recent
        .map((entry) => toolById(entry.id))
        .filter((tool): tool is ToolDefinition => tool != null)
        .slice(0, 6),
    [recent],
  );

  const filteredCommon = COMMON_ACTIONS.filter((item) => match(item.label, item.hint));
  const filteredImageShortcuts = IMAGE_SHORTCUTS.filter((item) => match(item.label, item.hint));
  const filteredRecent = recentTools.filter((tool) => match(tool.title, tool.description));
  const filteredTools = DEV_TOOLS.filter((tool) => match(tool.title, tool.description));
  const searching = query.trim().length > 0;
  const nothingMatched =
    searching &&
    filteredCommon.length === 0 &&
    filteredImageShortcuts.length === 0 &&
    filteredRecent.length === 0 &&
    filteredTools.length === 0;

  const toolsFor = (category: ToolDefinition["category"]) =>
    filteredTools.filter((tool) => tool.category === category);

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
          onPress={() => openRoute(tool.route)}
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

  const renderShortcut = (item: ShortcutEntry) => (
    <View key={item.label} style={[styles.cell, cellStyle]}>
      <IconEntry
        icon={item.icon}
        label={item.label}
        onPress={() => openRoute(item.route)}
        accessibilityHint={item.hint}
      />
    </View>
  );

  const renderSection = (
    categoryId: ToolDefinition["category"],
    shortcuts: ShortcutEntry[] = [],
  ) => {
    const category = TOOL_CATEGORIES.find((item) => item.id === categoryId);
    const tools = toolsFor(categoryId);
    if (!category || (tools.length === 0 && shortcuts.length === 0)) return null;
    return (
      <View key={categoryId} style={styles.group}>
        <SectionHeader icon={category.icon} title={category.label} />
        <GlassCard style={styles.gridCard}>
          <View style={styles.grid}>
            {tools.map(renderToolTile)}
            {shortcuts.map(renderShortcut)}
          </View>
        </GlassCard>
      </View>
    );
  };

  return (
    <View style={styles.root}>
      <ScreenHeader title="工具" subtitle="采集、素材与跨设备效率工具" />
      <View style={styles.searchWrap}>
        <SearchField
          value={query}
          onChangeText={setQuery}
          placeholder="搜索工具名称或用途"
          accessibilityLabel="搜索工具"
        />
      </View>

      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
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
                      onPress={() => openRoute(tool.route)}
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
                <SectionHeader icon="zap" title="常用操作" />
                <GlassCard style={styles.gridCard}>
                  <View style={styles.grid}>{filteredCommon.map(renderShortcut)}</View>
                </GlassCard>
              </View>
            ) : null}

            {renderSection("image", filteredImageShortcuts)}

            {renderSection("content")}

            {renderSection("advanced")}

            {filteredTools.some((tool) => tool.category === "advanced") ? (
              <View style={styles.group}>
                <Text style={[styles.footnote, { color: tokens.muted }]}>
                  高级工具为低频输入型能力，默认不占首页。星标可加入工作台；排序与显隐在「管理入口」调整。
                </Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="管理工作台入口"
                  onPress={() => openRoute("entry_manager")}
                  style={({ pressed }) => [styles.manageLink, { opacity: pressed ? 0.6 : 1 }]}
                >
                  <AppIcon name="settings" size={16} color={tokens.accent} />
                  <Text style={[styles.manageText, { color: tokens.accent }]}>管理入口</Text>
                </Pressable>
              </View>
            ) : null}
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
  cellHalf: { flexBasis: "50%" },
  starButton: { position: "absolute", top: 0, right: 0, width: 32, height: 32, alignItems: "center", justifyContent: "center" },
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
  footnote: { fontSize: font.label, lineHeight: 18, paddingHorizontal: space.xs },
  manageLink: { flexDirection: "row", alignItems: "center", gap: space.xs, minHeight: 44, paddingHorizontal: space.xs },
  manageText: { fontSize: font.meta, fontWeight: "600" },
  emptyText: { fontSize: font.meta, lineHeight: 20, paddingVertical: space.xl, textAlign: "center" },
});
