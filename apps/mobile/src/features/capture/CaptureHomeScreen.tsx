// 采集中心入口（状态一：采集）。
//
// 产品语义（与 08/14 文档一致）：
// - 一次采集 = 选一个入口产生素材（拍照 / 扫描 / 相册 / 文件 / 语音 / 一句话），
//   素材先落到本机，再由用户在整理页显式选择「业务归属」与「副本目的地」；
// - 本页只做入口与「未处理素材」提示，不在这里偷偷上传、写相册或建任务；
// - 语音与文字复用既有采集页（原生录音模块、草稿与业务保存逻辑不重写）。
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { AppBar } from "../../components/AppBar";
import { PressableScale } from "../../components/PressableScale";
import * as repo from "../../db/captureAssets";
import { useWindowInsets } from "../../lib/insets";
import type { Nav } from "../../lib/nav";
import { useTheme } from "../../theme/ThemeProvider";
import { font, radius, space } from "../../theme/tokens";
import { AppIcon, type IconName } from "../../components/icons/AppIcon";

import { subscribeCaptureRevision } from "./revision";

interface Summary {
  saved: number;
  staged: number;
  pending: number;
  failed: number;
  recent: repo.CaptureAsset[];
}

const EMPTY: Summary = { saved: 0, staged: 0, pending: 0, failed: 0, recent: [] };

function CaptureAction({
  icon,
  label,
  hint,
  primary,
  onPress,
}: {
  icon: IconName;
  label: string;
  hint?: string;
  primary?: boolean;
  onPress: () => void;
}) {
  const { tokens } = useTheme();
  return (
    <PressableScale
      onPress={onPress}
      accessibilityLabel={label}
      accessibilityHint={hint}
      style={styles.actionPress}
      contentStyle={[
        styles.action,
        {
          backgroundColor: primary ? tokens.accent : tokens.card,
          borderColor: primary ? tokens.accent : tokens.cardBorder,
        },
      ]}
      scaleTo={0.97}
    >
      <View
        style={[
          styles.actionIcon,
          { backgroundColor: primary ? "rgba(255,255,255,0.18)" : tokens.accentSoft },
        ]}
      >
        <AppIcon name={icon} color={primary ? "#FFFFFF" : tokens.accentText} size={22} />
      </View>
      <Text
        style={[styles.actionLabel, { color: primary ? "#FFFFFF" : tokens.text }]}
        numberOfLines={1}
      >
        {label}
      </Text>
      {hint ? (
        <Text
          style={[styles.actionHint, { color: primary ? "rgba(255,255,255,0.82)" : tokens.muted }]}
          numberOfLines={1}
        >
          {hint}
        </Text>
      ) : null}
    </PressableScale>
  );
}

function RowEntry({
  icon,
  label,
  helper,
  onPress,
}: {
  icon: IconName;
  label: string;
  helper: string;
  onPress: () => void;
}) {
  const { tokens } = useTheme();
  return (
    <PressableScale
      onPress={onPress}
      accessibilityLabel={label}
      accessibilityHint={helper}
      style={styles.rowPress}
      contentStyle={styles.row}
      scaleTo={0.98}
    >
      <View style={[styles.rowIcon, { backgroundColor: tokens.accentSoft }]}>
        <AppIcon name={icon} color={tokens.accentText} size={18} />
      </View>
      <View style={styles.rowText}>
        <Text style={[styles.rowLabel, { color: tokens.text }]} numberOfLines={1}>
          {label}
        </Text>
        <Text style={[styles.rowHelper, { color: tokens.muted }]} numberOfLines={1}>
          {helper}
        </Text>
      </View>
      <AppIcon name="chevronRight" color={tokens.faint} size={16} />
    </PressableScale>
  );
}

export function CaptureHomeScreen({ nav }: { nav: Nav }) {
  const { tokens } = useTheme();
  const insets = useWindowInsets();
  const [summary, setSummary] = useState<Summary>(EMPTY);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const [saved, staged, destinations] = await Promise.all([
      repo.listAssets("saved"),
      repo.listStagedAssets(),
      repo.listAllDestinations(),
    ]);
    const pending = destinations.filter((item) => item.state === "pending").length;
    const failed = destinations.filter((item) => item.state === "failed").length;
    setSummary({
      saved: saved.length,
      staged: staged.length,
      pending,
      failed,
      recent: saved.slice(0, 4),
    });
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
    return subscribeCaptureRevision(() => void load());
  }, [load]);

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <AppBar
        title="采集"
        onBack={nav.back}
        right={
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="打开本机素材库"
            onPress={() => nav.push("capture_stash")}
            style={styles.headerButton}
          >
            <Text style={[styles.headerText, { color: tokens.accentText }]}>
              {summary.saved > 0 ? `素材库 ${summary.saved}` : "素材库"}
            </Text>
          </Pressable>
        }
      />

      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + space.xxl }]}
        showsVerticalScrollIndicator={false}
      >
        {loading ? (
          <ActivityIndicator color={tokens.accent} style={styles.loading} />
        ) : (
          <>
            {summary.staged > 0 ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`有 ${summary.staged} 个素材尚未处理`}
                onPress={() => nav.push("capture_review")}
                style={[
                  styles.banner,
                  { backgroundColor: tokens.accentSoft, borderColor: tokens.accent },
                ]}
              >
                <View style={styles.bannerBody}>
                  <Text style={[styles.bannerTitle, { color: tokens.accentText }]}>
                    有 {summary.staged} 个素材尚未处理
                  </Text>
                  <Text style={[styles.bannerHint, { color: tokens.accentText }]}>
                    继续保存到本机、相册或发送电脑
                  </Text>
                </View>
                <AppIcon name="chevronRight" color={tokens.accentText} size={18} />
              </Pressable>
            ) : null}

            <View style={styles.primaryRow}>
              <CaptureAction
                icon="camera"
                label="拍照"
                hint="可连拍，拍完统一整理"
                primary
                onPress={() => nav.push("capture_camera")}
              />
              <CaptureAction
                icon="docScan"
                label="文档扫描"
                hint="多页合成 PDF"
                onPress={() => nav.push("capture_scan")}
              />
            </View>

            <Text style={[styles.sectionLabel, { color: tokens.muted }]}>从系统导入</Text>
            <View style={[styles.card, { backgroundColor: tokens.card, borderColor: tokens.cardBorder }]}>
              <RowEntry
                icon="gallery"
                label="从相册选择"
                helper="只读取你选中的照片，不扫描整个相册"
                onPress={() => nav.push("capture_import")}
              />
              <View style={[styles.divider, { backgroundColor: tokens.separator }]} />
              <RowEntry
                icon="folder"
                label="从文件导入"
                helper="PDF / 图片 / 其他文件，先复制进本机再处理"
                onPress={() => nav.push("capture_import")}
              />
            </View>

            <Text style={[styles.sectionLabel, { color: tokens.muted }]}>快速记录</Text>
            <View style={[styles.card, { backgroundColor: tokens.card, borderColor: tokens.cardBorder }]}>
              <RowEntry
                icon="mic"
                label="语音速记"
                helper="录制后可直接试听，再决定保存到哪里"
                onPress={() => nav.push("capture", undefined, "voice")}
              />
              <View style={[styles.divider, { backgroundColor: tokens.separator }]} />
              <RowEntry
                icon="noteNew"
                label="一句话记录"
                helper="先写下来，再选择保存到收集箱、任务或笔记"
                onPress={() => nav.push("capture", undefined, "capture")}
              />
            </View>

            <PressableScale
              onPress={() => nav.push("capture_stash")}
              accessibilityLabel="本机素材库"
              accessibilityHint={`共 ${summary.saved} 个素材，${summary.pending} 个等待电脑，${summary.failed} 个失败`}
              style={styles.rowPress}
              contentStyle={[styles.library, { backgroundColor: tokens.card, borderColor: tokens.cardBorder }]}
              scaleTo={0.98}
            >
              <View style={styles.libraryHead}>
                <View style={styles.libraryTitleRow}>
                  <AppIcon name="fileStack" color={tokens.accentText} size={18} />
                  <Text style={[styles.libraryTitle, { color: tokens.text }]}>本机素材库</Text>
                </View>
                <Text style={[styles.libraryCount, { color: tokens.muted }]}>
                  {summary.saved} 个素材
                </Text>
              </View>

              {summary.recent.length > 0 ? (
                <View style={styles.thumbs}>
                  {summary.recent.map((asset) =>
                    asset.kind === "photo" || asset.kind === "scan" ? (
                      <Image
                        key={asset.id}
                        source={{ uri: asset.thumbnailPath ?? asset.localPath ?? "" }}
                        style={[styles.thumb, { backgroundColor: tokens.accentSoft }]}
                        resizeMode="cover"
                      />
                    ) : (
                      <View
                        key={asset.id}
                        style={[styles.thumb, styles.thumbFallback, { backgroundColor: tokens.accentSoft }]}
                      >
                        <AppIcon
                          name={asset.kind === "audio" ? "fileAudio" : asset.mime === "application/pdf" ? "filePdf" : "fileGeneric"}
                          color={tokens.accentText}
                          size={20}
                        />
                      </View>
                    ),
                  )}
                </View>
              ) : (
                <Text style={[styles.libraryEmpty, { color: tokens.muted }]}>
                  还没有保存到本机的素材。拍一张照片后选「保存到 TaskDock」即可在这里看到。
                </Text>
              )}

              <View style={styles.libraryFoot}>
                <Text style={[styles.libraryStatus, { color: tokens.muted }]}>
                  {summary.pending > 0 ? `${summary.pending} 个等待电脑 · ` : ""}
                  {summary.failed > 0 ? `${summary.failed} 个失败可重试` : "全部已处理"}
                </Text>
                <Text style={[styles.libraryLink, { color: tokens.accentText }]}>打开</Text>
              </View>
            </PressableScale>

            <Text style={[styles.footnote, { color: tokens.faint }]}>
              本机素材保存在应用私有目录；保存到系统相册或发送到电脑是独立副本，删除本机素材不会删除它们。
            </Text>
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { paddingHorizontal: space.lg, paddingTop: space.md, gap: space.md },
  loading: { marginTop: space.xl },
  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    borderWidth: 1,
    borderRadius: radius.card,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  bannerBody: { flex: 1, gap: 2 },
  bannerTitle: { fontSize: font.body, fontWeight: "600" },
  bannerHint: { fontSize: font.label },
  primaryRow: { flexDirection: "row", gap: space.md },
  actionPress: { flex: 1 },
  action: {
    borderWidth: 1,
    borderRadius: radius.card,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    gap: space.xs,
  },
  actionIcon: {
    width: 40,
    height: 40,
    borderRadius: radius.control,
    alignItems: "center",
    justifyContent: "center",
  },
  actionLabel: { fontSize: font.body, fontWeight: "700", marginTop: space.xxs },
  actionHint: { fontSize: font.label },
  sectionLabel: {
    fontSize: font.label,
    fontWeight: "600",
    marginTop: space.sm,
    paddingHorizontal: space.xxs,
  },
  card: { borderWidth: 1, borderRadius: radius.card, paddingHorizontal: space.md },
  rowPress: {},
  row: {
    minHeight: 56,
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingVertical: space.xs,
  },
  rowIcon: {
    width: 32,
    height: 32,
    borderRadius: radius.tile,
    alignItems: "center",
    justifyContent: "center",
  },
  rowText: { flex: 1, gap: 1 },
  rowLabel: { fontSize: font.body, fontWeight: "600" },
  rowHelper: { fontSize: font.label },
  divider: { height: StyleSheet.hairlineWidth },
  library: {
    borderWidth: 1,
    borderRadius: radius.card,
    padding: space.md,
    gap: space.sm,
  },
  libraryHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  libraryTitleRow: { flexDirection: "row", alignItems: "center", gap: space.xs },
  libraryTitle: { fontSize: font.body, fontWeight: "600" },
  libraryCount: { fontSize: font.label },
  thumbs: { flexDirection: "row", gap: space.xs },
  thumb: { width: 56, height: 56, borderRadius: radius.control },
  thumbFallback: { alignItems: "center", justifyContent: "center" },
  libraryEmpty: { fontSize: font.label, lineHeight: 18 },
  libraryFoot: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  libraryStatus: { fontSize: font.label },
  libraryLink: { fontSize: font.label, fontWeight: "600" },
  footnote: { fontSize: font.label, lineHeight: 17, paddingHorizontal: space.xxs },
  headerButton: { minHeight: 44, justifyContent: "center", paddingHorizontal: space.xxs },
  headerText: { fontSize: font.label, fontWeight: "600" },
});
