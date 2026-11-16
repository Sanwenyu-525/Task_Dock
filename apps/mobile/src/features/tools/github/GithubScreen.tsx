// GitHub 轻量入口：只保存常用仓库 / Issue / PR 链接，用系统链接打开；
// 不接 OAuth、不调用 GitHub API、不存储任何 GitHub 密码或 Token。
//
// 打开方式：https 链接交给系统解析——已安装官方 GitHub App 时会由 App 接管
// （Asset Links / 通用链接），否则浏览器打开；本页不硬编码私有 scheme，也不判断是否安装。
import { useEffect, useMemo, useState } from "react";
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { ActionSheet, type SheetAction } from "../../../components/ActionSheet";
import { AppBar } from "../../../components/AppBar";
import { BottomSheet } from "../../../components/BottomSheet";
import { Chip } from "../../../components/Chip";
import { AppIcon } from "../../../components/icons/AppIcon";
import { SearchField } from "../../../components/SearchField";
import { useToast } from "../../../feedback/ToastProvider";
import {
  createResource,
  deleteResource,
  listResources,
  touchResourceOpen,
  updateResource,
  type ToolResource,
} from "../../../db/toolResources";
import { recordToolUse } from "../../../db/toolUsage";
import { describeError } from "../../../lib/errors";
import { formatDateTime } from "../../../lib/format";
import { useWindowInsets } from "../../../lib/insets";
import { useTheme } from "../../../theme/ThemeProvider";
import { font, radius, space } from "../../../theme/tokens";
import { shareOutText, writeClipboard } from "../shared/nativeTools";
import { takeLinkDraft } from "../shareIntake";
import { ToolButton, ToolField, ToolNote, ToolTextArea } from "../shared/ToolUI";

const TOOL_ID = "tool.github";

interface RepoInfo {
  base: string;
  owner: string;
  repo: string;
  kind: "repo" | "issue" | "pull" | "other";
  number: string | null;
}

export function GithubScreen({ onBack }: { onBack: () => void }) {
  const { tokens } = useTheme();
  const { showToast } = useToast();
  const insets = useWindowInsets();

  const [items, setItems] = useState<ToolResource[]>([]);
  const [query, setQuery] = useState("");
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [loading, setLoading] = useState(true);
  const [actionTarget, setActionTarget] = useState<ToolResource | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ToolResource | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [note, setNote] = useState("");
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void recordToolUse(TOOL_ID);
    void reload();
  }, []);

  useEffect(() => {
    const draft = takeLinkDraft();
    if (!draft) return;
    setUrl(draft.url);
    setAddOpen(true);
  }, []);

  async function reload() {
    try {
      setItems(await listResources("github"));
    } catch (error) {
      showToast(`读取 GitHub 收藏失败：${describeError(error)}`, "danger");
    } finally {
      setLoading(false);
    }
  }

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return items.filter((item) => {
      if (favoriteOnly && !item.favorite) return false;
      if (!keyword) return true;
      return `${item.title} ${item.url} ${item.note}`.toLowerCase().includes(keyword);
    });
  }, [favoriteOnly, items, query]);

  const info = useMemo(() => parseGitHub(url), [url]);
  const preview = info ? `${info.owner}/${info.repo}` : "";

  const submit = async () => {
    if (saving) return;
    const parsed = parseGitHub(url);
    if (!parsed) {
      setFormError("请输入 github.com 的仓库 / Issue / PR 链接");
      return;
    }
    setSaving(true);
    try {
      await createResource({
        kind: "github",
        title: note.trim() || `${parsed.owner}/${parsed.repo}`,
        url: url.trim(),
        category: "GitHub",
        note: note.trim(),
        storage: "online",
      });
      setAddOpen(false);
      setUrl("");
      setNote("");
      await reload();
      showToast("GitHub 链接已保存", "success");
    } catch (error) {
      setFormError(`保存失败：${describeError(error)}`);
    } finally {
      setSaving(false);
    }
  };

  const openUrl = async (resource: ToolResource, target?: "issues" | "pulls") => {
    const parsed = parseGitHub(resource.url);
    if (!parsed) {
      showToast("这个链接无法解析为 GitHub 地址", "danger");
      return;
    }
    const destination =
      target === "issues"
        ? `${parsed.base}/issues`
        : target === "pulls"
          ? `${parsed.base}/pulls`
          : resource.url;
    try {
      await Linking.openURL(destination);
      await touchResourceOpen(resource.id);
      await reload();
    } catch (error) {
      showToast(`打开失败：${describeError(error)}`, "danger");
    }
  };

  const toggleFavorite = async (resource: ToolResource) => {
    try {
      await updateResource(resource.id, { favorite: !resource.favorite });
      await reload();
    } catch (error) {
      showToast(describeError(error), "danger");
    }
  };

  const remove = async (resource: ToolResource) => {
    try {
      await deleteResource(resource.id);
      setDeleteTarget(null);
      await reload();
      showToast("已删除", "success");
    } catch (error) {
      showToast(describeError(error), "danger");
    }
  };

  const actions: SheetAction[] = actionTarget
    ? [
        { key: "repo", label: "打开仓库", icon: "code" },
        { key: "issues", label: "打开 Issues", icon: "list" },
        { key: "pulls", label: "打开 Pull Requests", icon: "workflow" },
        { key: "favorite", label: actionTarget.favorite ? "取消收藏" : "收藏", icon: "star" },
        { key: "copy", label: "复制链接", icon: "copy" },
        { key: "share", label: "系统分享", icon: "share" },
        { key: "delete", label: "删除", tone: "danger", icon: "delete" },
      ]
    : [];

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <AppBar
        title="GitHub 入口"
        onBack={onBack}
        right={
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="新增 GitHub 链接"
            onPress={() => setAddOpen(true)}
            style={({ pressed }) => [styles.headerAction, { opacity: pressed ? 0.6 : 1 }]}
          >
            <AppIcon name="add" size={22} color={tokens.text} />
          </Pressable>
        }
      />

      <View style={styles.searchWrap}>
        <SearchField
          value={query}
          onChangeText={setQuery}
          placeholder="搜索仓库、Issue 或备注"
          accessibilityLabel="搜索 GitHub 链接"
        />
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow} style={styles.filterBar}>
        <Chip label="全部" active={!favoriteOnly} onPress={() => setFavoriteOnly(false)} variant="soft" />
        <Chip label="收藏" active={favoriteOnly} onPress={() => setFavoriteOnly((value) => !value)} variant="soft" />
      </ScrollView>

      <ScrollView contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + 24 }]} keyboardShouldPersistTaps="handled">
        {loading ? (
          <Text style={[styles.hint, { color: tokens.muted }]}>正在读取本机收藏…</Text>
        ) : filtered.length === 0 ? (
          <ToolNote
            text={
              items.length === 0
                ? "还没有 GitHub 链接。点右上角 + 添加仓库 / Issue / PR；从系统分享进入时会自动带入链接。"
                : "没有匹配的链接。"
            }
          />
        ) : (
          filtered.map((item) => {
            const parsed = parseGitHub(item.url);
            const kindLabel =
              parsed?.kind === "issue"
                ? `Issue #${parsed.number}`
                : parsed?.kind === "pull"
                  ? `PR #${parsed.number}`
                  : "仓库";
            return (
              <Pressable
                key={item.id}
                accessibilityRole="button"
                accessibilityLabel={`打开 ${item.title}`}
                accessibilityHint="长按可打开 Issues、PR、收藏或删除"
                onPress={() => void openUrl(item)}
                onLongPress={() => setActionTarget(item)}
                delayLongPress={350}
                style={({ pressed }) => [
                  styles.row,
                  { backgroundColor: tokens.card, borderColor: tokens.cardBorder, opacity: pressed ? 0.75 : 1 },
                ]}
              >
                <View style={[styles.rowIcon, { backgroundColor: tokens.tileBase, borderColor: tokens.tileBorder }]}>
                  <AppIcon name="code" size={20} color={tokens.accent} />
                </View>
                <View style={styles.rowBody}>
                  <View style={styles.rowTitleLine}>
                    {item.favorite ? <AppIcon name="star" size={14} color={tokens.accent} /> : null}
                    <Text style={[styles.rowTitle, { color: tokens.text }]} numberOfLines={1}>
                      {item.title}
                    </Text>
                    <Text style={[styles.kindBadge, { color: tokens.muted }]}>{kindLabel}</Text>
                  </View>
                  <Text style={[styles.rowMeta, { color: tokens.muted }]} numberOfLines={1}>
                    {parsed ? `${parsed.owner}/${parsed.repo}` : item.url}
                    {item.lastOpenedAt ? ` · 最近 ${formatDateTime(item.lastOpenedAt)}` : ""}
                  </Text>
                  {item.note ? (
                    <Text style={[styles.rowNote, { color: tokens.textSoft }]} numberOfLines={1}>
                      {item.note}
                    </Text>
                  ) : null}
                </View>
                <AppIcon name="external" size={18} color={tokens.muted} />
              </Pressable>
            );
          })
        )}
        <ToolNote text="本页只保存链接：不登录 GitHub、不调用 API、不读取私有仓库；打开由系统分配给 GitHub App 或浏览器。" />
      </ScrollView>

      <ActionSheet
        visible={actionTarget !== null}
        title={actionTarget?.title ?? "GitHub"}
        subtitle={actionTarget?.url}
        entityLabel="GitHub 操作"
        actions={actions}
        onAction={(key) => {
          const target = actionTarget;
          setActionTarget(null);
          if (!target) return;
          if (key === "repo") void openUrl(target);
          if (key === "issues") void openUrl(target, "issues");
          if (key === "pulls") void openUrl(target, "pulls");
          if (key === "favorite") void toggleFavorite(target);
          if (key === "copy") void writeClipboard(target.url).then(() => showToast("链接已复制", "success")).catch((error: unknown) => showToast(describeError(error), "danger"));
          if (key === "share") void shareOutText(target.url, target.title);
          if (key === "delete") setDeleteTarget(target);
        }}
        onRequestClose={() => setActionTarget(null)}
      />

      <ActionSheet
        visible={deleteTarget !== null}
        title={deleteTarget ? `删除「${deleteTarget.title}」？` : "删除链接？"}
        entityLabel="GitHub 删除"
        actions={[
          { key: "cancel", label: "取消" },
          { key: "delete", label: "删除", tone: "danger", icon: "delete" },
        ]}
        onAction={(key) => {
          if (key === "delete" && deleteTarget) void remove(deleteTarget);
          else setDeleteTarget(null);
        }}
        onRequestClose={() => setDeleteTarget(null)}
      />

      <BottomSheet visible={addOpen} onRequestClose={() => setAddOpen(false)} accessibilityLabel="新增 GitHub 链接" keyboardAware>
        <View style={styles.sheetBody}>
          <Text style={[styles.sheetTitle, { color: tokens.text }]}>新增 GitHub 链接</Text>
          <ToolTextArea
            label="链接"
            value={url}
            onChangeText={(value) => {
              setUrl(value);
              setFormError("");
            }}
            placeholder="https://github.com/owner/repo 或 …/issues/123"
            height={110}
            mono
          />
          {preview ? (
            <Text style={[styles.sheetHint, { color: tokens.muted }]}>
              解析为 {preview} · {info?.kind === "issue" ? `Issue #${info.number}` : info?.kind === "pull" ? `PR #${info.number}` : "仓库"}
            </Text>
          ) : null}
          <ToolField label="备注 / 标题（可选）" value={note} onChangeText={setNote} placeholder="例如 客户端仓库" maxLength={80} />
          {formError ? <ToolNote text={formError} tone="warn" /> : null}
          <View style={styles.actionRow}>
            <ToolButton label={saving ? "保存中…" : "保存"} tone="primary" icon="check" disabled={saving} onPress={() => void submit()} />
            <ToolButton label="取消" onPress={() => setAddOpen(false)} />
          </View>
        </View>
      </BottomSheet>
    </View>
  );
}

function parseGitHub(input: string): RepoInfo | null {
  const text = input.trim();
  const match = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+)(?:\/(issues|pull)\/(\d+))?/i.exec(
    text,
  );
  if (match) {
    const owner = match[1];
    const repo = match[2].replace(/\.git$/i, "");
    const kind = match[3] === "issues" ? "issue" : match[3] === "pull" ? "pull" : "repo";
    return {
      base: `https://github.com/${owner}/${repo}`,
      owner,
      repo,
      kind,
      number: match[4] ?? null,
    };
  }
  const ssh = /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i.exec(text);
  if (ssh) {
    return {
      base: `https://github.com/${ssh[1]}/${ssh[2]}`,
      owner: ssh[1],
      repo: ssh[2],
      kind: "repo",
      number: null,
    };
  }
  return null;
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  headerAction: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  searchWrap: { paddingHorizontal: space.lg, paddingBottom: space.xs },
  filterBar: { flexGrow: 0, paddingVertical: space.xs },
  chipRow: { gap: space.sm, paddingHorizontal: space.lg },
  list: { paddingHorizontal: space.lg, paddingTop: space.xs, gap: space.sm },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    padding: space.md,
    borderRadius: radius.row,
    borderWidth: StyleSheet.hairlineWidth,
  },
  rowIcon: {
    width: 40,
    height: 40,
    borderRadius: radius.tile,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
  },
  rowBody: { flex: 1, gap: 2, minWidth: 0 },
  rowTitleLine: { flexDirection: "row", alignItems: "center", gap: space.xs },
  rowTitle: { fontSize: font.meta, fontWeight: "600", flexShrink: 1 },
  kindBadge: { fontSize: 10 },
  rowMeta: { fontSize: font.label },
  rowNote: { fontSize: font.label },
  hint: { fontSize: font.meta, textAlign: "center", paddingVertical: space.xl },
  actionRow: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  sheetBody: { paddingHorizontal: space.lg, paddingBottom: space.lg, gap: space.sm },
  sheetTitle: { fontSize: font.section, fontWeight: "700" },
  sheetHint: { fontSize: font.label, lineHeight: 18 },
});
