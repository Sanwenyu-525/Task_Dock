// 工具页：真实入口（常用工具 / 快捷操作）+ 未接入能力中性占位（应用导航 / 更多功能）。
//
// 数据边界（见 tmp/acceptance/mobile-ui-unified/01-audit.md 第 2 节）：
// - 本机真实能力：采集中心、快速笔记、诊断中心、拍照 / 扫码 / 导入、配对；
// - 项目空间 / 功能看板 / 剪贴板 / 投屏等桌面端能力在移动端未实现，只做中性占位，不可点；
// - 收集箱、笔记、文件互传、通知、工作区、任务的主归属在工作区 / 我的，本页不再重复目录；
// - 没有收藏数据与收藏能力，本页不渲染「已收藏」分区，也不伪造收藏项。
//
// 搜索只对本页入口名称做本地字符串过滤，不联网、不造假结果。
import { useState } from "react";
import { ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";

import { FeatureIconPlaceholder } from "../components/FeatureIconPlaceholder";
import { GlassCard } from "../components/GlassCard";
import { IconEntry } from "../components/IconEntry";
import { ScreenHeader } from "../components/ScreenHeader";
import { SearchField } from "../components/SearchField";
import { SectionHeader } from "../components/SectionHeader";
import type { IconName } from "../components/icons/AppIcon";
import { useToastTopAnchor } from "../feedback/ToastLayoutProvider";
import type { AppNav, RouteKey } from "../lib/nav";
import { gridColumnsForWidth } from "../lib/responsiveLayout";
import { useTheme } from "../theme/ThemeProvider";
import { font, space } from "../theme/tokens";

interface RealEntry {
  icon: IconName;
  label: string;
  hint?: string;
  onPress: () => void;
}

/** 未接入且不可点：纯展示占位 */
interface PlaceholderEntry {
  icon: IconName;
  label: string;
}

export function ToolsScreen({ nav }: { nav: AppNav }) {
  const { tokens } = useTheme();
  const [query, setQuery] = useState("");
  const topAnchor = useToastTopAnchor();
  // 全页统一网格：320dp 窄屏三列，其余四列；所有分区共用同一断点与同一种 cell。
  const { width } = useWindowDimensions();
  const columns = gridColumnsForWidth(width);
  const threeCol = columns === 3;

  const match = (label: string) => {
    const keyword = query.trim().toLowerCase();
    return keyword.length === 0 || label.toLowerCase().includes(keyword);
  };

  const push = (route: RouteKey) => () => nav.push(route);

  const common: RealEntry[] = [
    {
      icon: "archive",
      label: "采集中心",
      hint: "拍照、扫描、导入与本机素材",
      onPress: push("capture_home"),
    },
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

  const morePlaceholder: PlaceholderEntry[] = [
    { icon: "snippet", label: "代码片段" },
    { icon: "api", label: "API 调试" },
    { icon: "json", label: "JSON 格式化" },
    { icon: "regex", label: "正则测试" },
    { icon: "clock", label: "时间戳转换" },
    { icon: "external", label: "GitHub" },
    { icon: "fileDoc", label: "文档查阅" },
    { icon: "fileImage", label: "图片压缩" },
    { icon: "sparkles", label: "取色器" },
    { icon: "code", label: "代码对比" },
  ];

  const filteredCommon = common.filter((item) => match(item.label));
  const filteredNavPlaceholder = navPlaceholder.filter((item) => match(item.label));
  const filteredQuickReal = quickReal.filter((item) => match(item.label));
  const filteredQuickPlaceholder = quickPlaceholder.filter((item) => match(item.label));
  const filteredMore = morePlaceholder.filter((item) => match(item.label));
  const searching = query.trim().length > 0;
  const nothingMatched =
    searching &&
    filteredCommon.length === 0 &&
    filteredNavPlaceholder.length === 0 &&
    filteredQuickReal.length === 0 &&
    filteredQuickPlaceholder.length === 0 &&
    filteredMore.length === 0;

  return (
    <View style={styles.root}>
      <View onLayout={topAnchor.onLayout}>
        <ScreenHeader title="工具" subtitle="采集、笔记与本机工具集合" />

        <View style={styles.searchWrap}>
          <SearchField
            value={query}
            onChangeText={setQuery}
            placeholder="搜索工具名称"
            accessibilityLabel="搜索工具"
          />
        </View>
      </View>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {nothingMatched ? (
          <Text style={[styles.emptyText, { color: tokens.muted }]}>
            没有匹配的工具，换个关键词试试。
          </Text>
        ) : (
          <>
            {filteredCommon.length > 0 ? (
              <View style={styles.group}>
                <SectionHeader icon="zap" title="常用工具" />
                <GlassCard style={styles.gridCard}>
                  <View style={styles.grid}>
                    {filteredCommon.map((item) => (
                      <View
                        key={item.label}
                        style={[styles.cell, threeCol ? styles.cellThird : null]}
                      >
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

            {filteredNavPlaceholder.length > 0 ? (
              <View style={styles.group}>
                <SectionHeader icon="tools" title="应用导航" />
                <GlassCard style={styles.gridCard}>
                  <View style={styles.grid}>
                    {filteredNavPlaceholder.map((item) => (
                      <View key={item.label} style={[styles.cell, threeCol ? styles.cellThird : null]}>
                        <FeatureIconPlaceholder
                          icon={item.icon}
                          label={item.label}
                          variant="compact"
                        />
                      </View>
                    ))}
                  </View>
                </GlassCard>
              </View>
            ) : null}

            {filteredQuickReal.length > 0 || filteredQuickPlaceholder.length > 0 ? (
              <View style={styles.group}>
                <SectionHeader icon="send" title="快捷操作" />
                <GlassCard style={styles.gridCard}>
                  <View style={styles.grid}>
                    {filteredQuickReal.map((item) => (
                      <View key={item.label} style={[styles.cell, threeCol ? styles.cellThird : null]}>
                        <IconEntry
                          icon={item.icon}
                          label={item.label}
                          onPress={item.onPress}
                          accessibilityHint={item.hint}
                        />
                      </View>
                    ))}
                    {filteredQuickPlaceholder.map((item) => (
                      <View key={item.label} style={[styles.cell, threeCol ? styles.cellThird : null]}>
                        <FeatureIconPlaceholder
                          icon={item.icon}
                          label={item.label}
                          variant="compact"
                        />
                      </View>
                    ))}
                  </View>
                </GlassCard>
              </View>
            ) : null}

            {filteredMore.length > 0 ? (
              <View style={styles.group}>
                <SectionHeader icon="wrench" title="更多功能（开发中）" />
                <GlassCard style={styles.gridCard}>
                  <View style={styles.grid}>
                    {filteredMore.map((item) => (
                      <View key={item.label} style={[styles.cell, threeCol ? styles.cellThird : null]}>
                        <FeatureIconPlaceholder
                          icon={item.icon}
                          label={item.label}
                          variant="compact"
                        />
                      </View>
                    ))}
                  </View>
                </GlassCard>
              </View>
            ) : null}

            <Text style={[styles.footnote, { color: tokens.muted }]}>
              灰色图标是桌面端已有、移动端尚未接入的能力；蓝色入口可以直接使用。
            </Text>
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  searchWrap: {
    paddingHorizontal: space.lg,
    paddingBottom: space.xs,
  },
  content: {
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
    paddingBottom: space.xxl,
    gap: space.section,
  },
  /** 模块内标题与内容 12dp；模块之间 20dp */
  group: { gap: space.md },
  gridCard: {
    paddingHorizontal: space.sm,
    paddingVertical: space.xs,
  },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    rowGap: space.xs,
  },
  cell: {
    flexBasis: "25%",
    flexGrow: 0,
    flexShrink: 1,
  },
  cellThird: {
    flexBasis: "33.333%",
  },
  footnote: {
    fontSize: font.label,
    lineHeight: 18,
    paddingHorizontal: space.xxs,
  },
  emptyText: {
    fontSize: font.meta,
    lineHeight: 20,
    paddingVertical: space.xl,
    textAlign: "center",
  },
});
