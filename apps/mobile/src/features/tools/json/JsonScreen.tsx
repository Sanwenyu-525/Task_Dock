// JSON 格式化：输入 / 结果双视图（宽屏并列）+ 格式化 / 压缩 / 校验 / 树形查看。
//
// 关键行为：
// - 解析一律走 domain/tools/jsonTools 的自建严格解析器：数字保留原始字面量，
//   超过安全整数只告警不改值；非法 JSON 给出行列与上下文。
// - 解析是同步的但有硬上限（1MB / 12 万节点 / 200 层），执行前先渲染「解析中」，
//   并用 setTimeout 让出一帧，避免用户感觉整页卡死。
// - 输入与结果都只在内存：不写数据库、不上传、退出页面即丢弃（下方有明确说明）。
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";

import { AppBar } from "../../../components/AppBar";
import { ActionSheet } from "../../../components/ActionSheet";
import { AppIcon } from "../../../components/icons/AppIcon";
import { SegmentedControl } from "../../../components/SegmentedControl";
import { useToast } from "../../../feedback/ToastProvider";
import {
  MAX_JSON_CHARS,
  MAX_JSON_DEPTH,
  MAX_JSON_NODES,
  describeJson,
  errorContext,
  expandableIds,
  flattenJsonTree,
  formatJson,
  minifyJson,
  parseJson,
  type JsonAst,
  type JsonError,
  type JsonTreeRow,
} from "../../../domain/tools/jsonTools";
import { recordToolUse } from "../../../db/toolUsage";
import { describeError } from "../../../lib/errors";
import { pickLocalFiles } from "../../../lib/sync/fileIo";
import { useWindowInsets } from "../../../lib/insets";
import { useTheme } from "../../../theme/ThemeProvider";
import { font, radius, space } from "../../../theme/tokens";
import {
  readClipboard,
  readTextFile,
  shareOutText,
  writeClipboard,
  writeToolTextFile,
} from "../shared/nativeTools";
import { saveTextFileToDownloads } from "../shared/saveOutput";
import { takeTextDraft } from "../shareIntake";
import { ToolButton, ToolField, ToolNote, ToolSection, ToolTextArea } from "../shared/ToolUI";

// 最近使用记录归到父入口「文本处理」：JSON 已降级为聚合页内的低频能力，
// 不能以已下架 id 出现在工具页最近使用里。
const TOOL_ID = "tool.text";
const RESULT_SCROLL_MAX = 420;

type ResultKind = "pretty" | "min" | "tree";
type PaneMode = "input" | "result";

interface Analysis {
  ast: JsonAst;
  pretty: string;
  minified: string;
  nodeCount: number;
  maxDepth: number;
  warnings: string[];
}

export function JsonScreen({ onBack }: { onBack: () => void }) {
  const { tokens } = useTheme();
  const { showToast } = useToast();
  const insets = useWindowInsets();
  const { width } = useWindowDimensions();
  const wide = width >= 700;

  const [input, setInput] = useState("");
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [error, setError] = useState<{ info: JsonError; context: string } | null>(null);
  const [resultKind, setResultKind] = useState<ResultKind>("pretty");
  const [pane, setPane] = useState<PaneMode>("input");
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [treeQuery, setTreeQuery] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);

  useEffect(() => {
    void recordToolUse(TOOL_ID);
  }, []);

  useEffect(() => {
    const draft = takeTextDraft();
    if (draft) {
      setInput(draft);
      setPane("input");
    }
  }, []);

  const analyze = useCallback((mode: "validate" | "pretty" | "min") => {
    if (busy) return;
    if (!input.trim()) {
      setAnalysis(null);
      setError({ info: { offset: 0, line: 1, column: 1, message: "输入为空" }, context: "" });
      showToast("请先粘贴或导入 JSON", "info");
      return;
    }
    setBusy(true);
    // 让出一帧：先让「解析中」渲染出来，再做同步解析（上限保证百毫秒级）。
    setTimeout(() => {
      const parsed = parseJson(input);
      if (!parsed.ok) {
        setAnalysis(null);
        setError({ info: parsed.error, context: errorContext(input, parsed.error) });
        setBusy(false);
        if (!wide) setPane("result");
        return;
      }
      const pretty = formatJson(parsed.ast, 2);
      const minified = minifyJson(parsed.ast);
      setAnalysis({
        ast: parsed.ast,
        pretty,
        minified,
        nodeCount: parsed.nodeCount,
        maxDepth: parsed.maxDepth,
        warnings: parsed.warnings,
      });
      setError(null);
      setExpanded(new Set(parsed.nodeCount <= 4000 ? expandableIds(parsed.ast) : []));
      setTreeQuery("");
      setResultKind(mode === "min" ? "min" : "pretty");
      setBusy(false);
      if (!wide) setPane("result");
      if (mode !== "validate") showToast(mode === "min" ? "已压缩" : "已格式化", "success");
    }, 30);
  }, [busy, input, showToast, wide]);

  const resultText = useMemo(() => {
    if (!analysis) return "";
    return resultKind === "min" ? analysis.minified : analysis.pretty;
  }, [analysis, resultKind]);

  const treeRows = useMemo<JsonTreeRow[]>(() => {
    if (!analysis || resultKind !== "tree") return [];
    return flattenJsonTree(analysis.ast, expanded, { query: treeQuery });
  }, [analysis, expanded, resultKind, treeQuery]);

  const copyResult = async () => {
    if (!resultText) {
      showToast("还没有可复制的结果", "info");
      return;
    }
    try {
      await writeClipboard(resultText);
      showToast("结果已复制", "success");
    } catch (copyError) {
      showToast(describeError(copyError), "danger");
    }
  };

  const importFile = async () => {
    try {
      const files = await pickLocalFiles();
      const file = files[0];
      if (!file) return;
      if (Number(file.size ?? 0) > 2_000_000) {
        showToast("文件超过 2MB，请先拆分后再导入", "danger");
        return;
      }
      const text = await readTextFile(file.uri, 2_000_000);
      setInput(text);
      setAnalysis(null);
      setError(null);
      showToast(`已导入 ${file.name ?? "文件"}（${text.length} 字符），点「格式化」解析`, "success");
    } catch (importError) {
      showToast(`导入失败：${describeError(importError)}`, "danger");
    }
  };

  const paste = async () => {
    try {
      const text = await readClipboard();
      if (!text) {
        showToast("剪贴板为空", "info");
        return;
      }
      setInput(text);
      setAnalysis(null);
      setError(null);
      showToast(`已粘贴 ${text.length} 字符`, "success");
    } catch (pasteError) {
      showToast(describeError(pasteError), "danger");
    }
  };

  const clearAll = () => {
    setInput("");
    setAnalysis(null);
    setError(null);
    setExpanded(new Set());
    setTreeQuery("");
    setConfirmClear(false);
    showToast("已清空输入与结果", "info");
  };

  const toggleRow = (row: JsonTreeRow) => {
    if (!row.expandable) return;
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(row.id)) next.delete(row.id);
      else next.add(row.id);
      return next;
    });
  };

  const collapseAll = () => {
    setExpanded(new Set());
    showToast("已全部折叠", "info");
  };

  const expandTop = () => {
    if (!analysis) return;
    // 只展开第一层：深层结构一次全展开会让 12 万节点直接铺满列表，失去可读性。
    const ids: string[] = [];
    const visit = (node: JsonAst, pathId: string, depth: number) => {
      if (depth > 1) return;
      if (node.kind === "object") {
        for (const entry of node.entries) {
          const id = `${pathId}/${encodeURIComponent(entry.key)}`;
          if (entry.value.kind === "object" || entry.value.kind === "array") ids.push(id);
        }
      } else if (node.kind === "array") {
        for (let index = 0; index < node.items.length; index += 1) {
          const id = `${pathId}/${index}`;
          const item = node.items[index];
          if (item.kind === "object" || item.kind === "array") ids.push(id);
        }
      }
    };
    visit(analysis.ast, "", 0);
    setExpanded(new Set(ids));
  };

  const saveResult = async () => {
    if (!resultText) return;
    try {
      const name = `json-${Date.now()}.json`;
      const file = writeToolTextFile(name, resultText);
      const saved = await saveTextFileToDownloads(file.uri, name);
      showToast(`已保存到下载目录：${saved.displayName}`, "success");
    } catch (saveError) {
      showToast(`保存失败：${describeError(saveError)}`, "danger");
    }
  };

  const shareResult = async () => {
    if (!resultText) return;
    try {
      await shareOutText(resultText, "JSON 处理结果");
    } catch (shareError) {
      showToast(describeError(shareError), "danger");
    }
  };

  const statLine = analysis
    ? `${analysis.nodeCount} 个节点 · 最深 ${analysis.maxDepth} 层 · 输出 ${resultText.length} 字符`
    : input.length > 0
      ? `输入 ${input.length} 字符（上限 ${MAX_JSON_CHARS}）`
      : "粘贴、导入或从分享进入";

  const inputPane = (
    <View style={styles.pane}>
      <ToolTextArea
        label="输入"
        value={input}
        onChangeText={(text) => {
          setInput(text);
          setAnalysis(null);
          setError(null);
        }}
        placeholder={'粘贴 JSON，例如 {"hello": "world"}'}
        height={wide ? 300 : 260}
        mono
        actions={
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="从剪贴板粘贴"
            onPress={() => void paste()}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            style={({ pressed }) => [styles.inlineAction, { opacity: pressed ? 0.6 : 1 }]}
          >
            <AppIcon name="clipboard" size={16} color={tokens.textSoft} />
            <Text style={[styles.inlineText, { color: tokens.textSoft }]}>粘贴</Text>
          </Pressable>
        }
      />
      <View style={styles.actionRow}>
        <ToolButton label="格式化" icon="check" tone="primary" onPress={() => analyze("pretty")} disabled={busy} />
        <ToolButton label="压缩" icon="archive" onPress={() => analyze("min")} disabled={busy} />
        <ToolButton label="校验" icon="shield" onPress={() => analyze("validate")} disabled={busy} />
      </View>
      <View style={styles.actionRow}>
        <ToolButton label="从文件导入" icon="upload" onPress={() => void importFile()} disabled={busy} />
        <ToolButton label="清空" icon="delete" onPress={() => setConfirmClear(true)} disabled={busy || !input} />
      </View>
    </View>
  );

  const resultPane = (
    <View style={styles.pane}>
      <View style={styles.paneHead}>
        <Text style={[styles.paneTitle, { color: tokens.text }]}>结果</Text>
        <View style={styles.kindSwitch}>
          <SegmentedControl
            options={[
              { value: "pretty", label: "格式化" },
              { value: "min", label: "压缩" },
              { value: "tree", label: "树形" },
            ]}
            value={resultKind}
            onChange={(next) => setResultKind(next as ResultKind)}
            accessibilityLabel="结果视图"
            size="compact"
          />
        </View>
      </View>

      {busy ? <ToolNote text="正在解析…（大输入会先经过本机上限校验）" /> : null}

      {error ? (
        <View style={styles.errorBox}>
          <ToolNote
            text={`第 ${error.info.line} 行第 ${error.info.column} 列：${error.info.message}`}
            tone="warn"
          />
          {error.context ? (
            <ScrollView horizontal style={styles.contextScroll}>
              <Text style={[styles.context, { color: tokens.danger, borderColor: tokens.cardBorder }]}>
                {error.context}
              </Text>
            </ScrollView>
          ) : null}
        </View>
      ) : null}

      {analysis && resultKind !== "tree" ? (
        <View style={[styles.resultBox, { backgroundColor: tokens.bgAccent, borderColor: tokens.cardBorder }]}>
          <ScrollView horizontal showsHorizontalScrollIndicator>
            <Text
              selectable
              style={[styles.monoResult, { color: tokens.text }]}
            >
              {resultText.length > 60_000 ? `${resultText.slice(0, 60_000)}\n…（预览截断，复制/保存仍为完整结果）` : resultText}
            </Text>
          </ScrollView>
        </View>
      ) : null}

      {analysis && resultKind === "tree" ? (
        <View style={styles.treeBlock}>
          <View style={styles.treeToolbar}>
            <View style={styles.treeSearch}>
              <ToolField
                label="搜索字段"
                value={treeQuery}
                onChangeText={setTreeQuery}
                placeholder="字段名或值片段"
                autoCapitalize="none"
              />
            </View>
            <ToolButton compact label="折叠" icon="chevronUp" onPress={collapseAll} />
            <ToolButton compact label="展开一层" icon="chevronDown" onPress={expandTop} />
          </View>
          <View style={[styles.treeBox, { borderColor: tokens.cardBorder, backgroundColor: tokens.card }]}>
            <FlatList
              data={treeRows}
              keyExtractor={(row) => row.id || "root"}
              nestedScrollEnabled
              initialNumToRender={40}
              windowSize={8}
              style={{ maxHeight: RESULT_SCROLL_MAX }}
              ListEmptyComponent={<ToolNote text={treeQuery ? "没有匹配的字段" : "没有可展示的节点"} />}
              renderItem={({ item }) => (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`${item.label || "根节点"}，${item.preview}`}
                  onPress={() => toggleRow(item)}
                  style={({ pressed }) => [
                    styles.treeRow,
                    { paddingLeft: space.sm + Math.min(item.depth, 12) * 12, opacity: pressed ? 0.7 : 1 },
                    item.matched ? { backgroundColor: tokens.accentSoft } : null,
                  ]}
                >
                  {item.expandable ? (
                    <AppIcon
                      name={expanded.has(item.id) ? "chevronDown" : "chevronRight"}
                      size={14}
                      color={tokens.muted}
                    />
                  ) : (
                    <View style={styles.treeSpacer} />
                  )}
                  <Text style={[styles.treeKey, { color: tokens.text }]} numberOfLines={1}>
                    {item.label || "(根)"}
                  </Text>
                  <Text style={[styles.treePreview, { color: tokens.textSoft }]} numberOfLines={1}>
                    {item.preview}
                  </Text>
                  {item.depth > 12 ? (
                    <Text style={[styles.treeDepth, { color: tokens.faint }]}>L{item.depth}</Text>
                  ) : null}
                </Pressable>
              )}
            />
          </View>
        </View>
      ) : null}

      {!analysis && !error && !busy ? (
        <ToolNote text="点「格式化」「压缩」或「校验」后在这里查看结果；树形视图会保留键顺序。" />
      ) : null}

      {analysis ? (
        <>
          <Text style={[styles.stat, { color: tokens.muted }]}>{statLine}</Text>
          <Text style={[styles.stat, { color: tokens.muted }]}>{describeJson(analysis.ast)}</Text>
          {analysis.warnings.length > 0 ? (
            <ToolNote
              text={`${analysis.warnings.length} 条提示：${analysis.warnings.slice(0, 3).join("；")}${analysis.warnings.length > 3 ? "…" : ""}`}
              tone="warn"
            />
          ) : null}
        </>
      ) : null}
    </View>
  );

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <AppBar
        title="JSON 格式化"
        onBack={onBack}
        right={
          !wide ? (
            <SegmentedControl
              options={[
                { value: "input", label: "输入" },
                { value: "result", label: "结果" },
              ]}
              value={pane}
              onChange={(next) => setPane(next as PaneMode)}
              accessibilityLabel="输入结果切换"
              size="compact"
            />
          ) : undefined
        }
      />
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <Text style={[styles.stat, { color: tokens.muted }]}>{statLine}</Text>
        {wide ? (
          <View style={styles.columns}>
            <View style={styles.column}>{inputPane}</View>
            <View style={styles.column}>{resultPane}</View>
          </View>
        ) : pane === "input" ? (
          inputPane
        ) : (
          resultPane
        )}

        <ToolSection title="关于上限与隐私">
          <ToolNote
            text={`输入上限 ${MAX_JSON_CHARS} 字符 / ${MAX_JSON_NODES} 节点 / ${MAX_JSON_DEPTH} 层；超过会在解析前直接拒绝，不会让页面卡死。`}
          />
          <ToolNote text="JSON 不会写入数据库，也不会上传；离开页面即释放。需要留存时请手动复制或保存到下载目录。" />
        </ToolSection>

        {analysis ? (
          <View style={styles.actionRow}>
            <ToolButton label="复制结果" icon="copy" onPress={() => void copyResult()} />
            <ToolButton label="保存 .json" icon="download" onPress={() => void saveResult()} />
            <ToolButton label="分享" icon="share" onPress={() => void shareResult()} />
          </View>
        ) : null}
      </ScrollView>

      <ActionSheet
        visible={confirmClear}
        title="清空输入与结果？"
        subtitle="输入与结果都只在内存，清空后无法恢复"
        entityLabel="JSON 清空"
        actions={[
          { key: "cancel", label: "取消" },
          { key: "clear", label: "清空", tone: "danger", icon: "delete" },
        ]}
        onAction={(key) => {
          if (key === "clear") clearAll();
          else setConfirmClear(false);
        }}
        onRequestClose={() => setConfirmClear(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { paddingHorizontal: space.lg, paddingTop: space.sm, gap: space.lg },
  columns: { flexDirection: "row", gap: space.lg },
  column: { flex: 1, minWidth: 0 },
  pane: { gap: space.md },
  paneHead: { gap: space.sm },
  paneTitle: { fontSize: font.section, fontWeight: "700" },
  kindSwitch: { alignSelf: "flex-start" },
  actionRow: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  inlineAction: { flexDirection: "row", alignItems: "center", gap: space.xs, minHeight: 32 },
  inlineText: { fontSize: font.label, fontWeight: "600" },
  resultBox: {
    borderRadius: radius.control,
    borderWidth: StyleSheet.hairlineWidth,
    padding: space.md,
    minHeight: 160,
    maxHeight: RESULT_SCROLL_MAX,
  },
  monoResult: { fontFamily: "monospace", fontSize: 13, lineHeight: 19 },
  context: { fontFamily: "monospace", fontSize: 12, lineHeight: 18, padding: space.sm },
  contextScroll: { maxHeight: 80 },
  errorBox: { gap: space.sm },
  treeBlock: { gap: space.sm },
  treeToolbar: { flexDirection: "row", alignItems: "flex-end", gap: space.sm },
  treeSearch: { flex: 1, minWidth: 0 },
  treeBox: { borderRadius: radius.control, borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  treeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.xs,
    minHeight: 34,
    paddingRight: space.sm,
  },
  treeSpacer: { width: 14 },
  treeKey: { fontFamily: "monospace", fontSize: 13, fontWeight: "600", maxWidth: "42%" },
  treePreview: { fontFamily: "monospace", fontSize: 12, flex: 1 },
  treeDepth: { fontSize: 10 },
  stat: { fontSize: font.label },
});
