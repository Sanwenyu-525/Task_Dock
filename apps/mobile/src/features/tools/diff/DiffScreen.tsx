// 代码对比：行级 Myers diff（纯函数，单端 ≤ 2000 行 / 行列积 ≤ 400 万），
// 手机端不摆两个大编辑器：窄屏上下输入 + 单栏结果，宽屏输入并列、结果仍单栏。
//
// 说明：
// - 引擎把「删除 + 新增」成对记为一次修改（stats.changed），UI 用相邻的红/绿行表达；
// - 只显示差异时仍保留 2 行上下文，避免用户失去位置感；
// - 大文本由引擎前置拒绝并给出具体行数，不在 JS 侧做无界比较。
import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";

import { Chip } from "../../../components/Chip";
import { AppIcon } from "../../../components/icons/AppIcon";
import { useToast } from "../../../feedback/ToastProvider";
import {
  MAX_DIFF_CELLS,
  MAX_DIFF_LINES,
  diffLines,
  type DiffOp,
  type DiffResult,
} from "../../../domain/tools/diffEngine";
import { recordToolUse } from "../../../db/toolUsage";
import { describeError } from "../../../lib/errors";
import { pickLocalFiles } from "../../../lib/sync/fileIo";
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
import { ToolButton, ToolNote, ToolScreen, ToolSection, ToolTextArea } from "../shared/ToolUI";

const TOOL_ID = "tool.diff";

type Result = Extract<DiffResult, { ok: true }>;
type Failure = Extract<DiffResult, { ok: false }>;

export function DiffScreen({ onBack }: { onBack: () => void }) {
  const { tokens } = useTheme();
  const { showToast } = useToast();
  const { width } = useWindowDimensions();
  const wide = width >= 700;

  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(false);
  const [onlyChanges, setOnlyChanges] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void recordToolUse(TOOL_ID);
  }, []);

  useEffect(() => {
    const draft = takeTextDraft();
    if (draft) setA(draft);
  }, []);

  const inputStats = useMemo(
    () => ({
      aLines: countLines(a),
      bLines: countLines(b),
    }),
    [a, b],
  );

  const run = () => {
    if (busy) return;
    setBusy(true);
    setTimeout(() => {
      const diff = diffLines(a, b, { ignoreWhitespace });
      if (!diff.ok) {
        setResult(null);
        setFailure(diff);
      } else {
        setFailure(null);
        setResult(diff);
      }
      setBusy(false);
    }, 30);
  };

  const visibleOps = useMemo(() => {
    if (!result) return [];
    if (!onlyChanges) return result.ops;
    // 只显示差异 + 每段前后各 2 行上下文，避免整页全灰。
    const keep = new Set<number>();
    result.ops.forEach((op, index) => {
      if (op.type === "equal") return;
      for (let offset = Math.max(0, index - 2); offset <= Math.min(result.ops.length - 1, index + 2); offset += 1) {
        keep.add(offset);
      }
    });
    return result.ops.filter((_, index) => keep.has(index));
  }, [onlyChanges, result]);

  const copyResult = async () => {
    if (!result) return;
    try {
      await writeClipboard(unifiedText(result.ops));
      showToast("差异结果已复制", "success");
    } catch (error) {
      showToast(describeError(error), "danger");
    }
  };

  const saveResult = async () => {
    if (!result) return;
    try {
      const name = `diff-${Date.now()}.txt`;
      const file = writeToolTextFile(name, unifiedText(result.ops));
      const saved = await saveTextFileToDownloads(file.uri, name);
      showToast(`已保存到下载目录：${saved.displayName}`, "success");
    } catch (error) {
      showToast(`保存失败：${describeError(error)}`, "danger");
    }
  };

  const shareResult = async () => {
    if (!result) return;
    try {
      await shareOutText(unifiedText(result.ops), "代码对比结果");
    } catch (error) {
      showToast(describeError(error), "danger");
    }
  };

  const pasteInto = async (target: "a" | "b") => {
    try {
      const text = await readClipboard();
      if (!text) {
        showToast("剪贴板为空", "info");
        return;
      }
      if (target === "a") setA(text);
      else setB(text);
      setResult(null);
      setFailure(null);
    } catch (error) {
      showToast(describeError(error), "danger");
    }
  };

  const importInto = async (target: "a" | "b") => {
    try {
      const files = await pickLocalFiles();
      const file = files[0];
      if (!file) return;
      const text = await readTextFile(file.uri, 2_000_000);
      if (target === "a") setA(text);
      else setB(text);
      setResult(null);
      setFailure(null);
      showToast(`已导入 ${file.name ?? "文件"}（${text.length} 字符）`, "success");
    } catch (error) {
      showToast(`导入失败：${describeError(error)}`, "danger");
    }
  };

  const clearAll = () => {
    setA("");
    setB("");
    setResult(null);
    setFailure(null);
  };

  const pane = (target: "a" | "b") => (
    <View style={styles.pane}>
      <ToolTextArea
        label={target === "a" ? "文本 A（旧）" : "文本 B（新）"}
        value={target === "a" ? a : b}
        onChangeText={(value) => {
          if (target === "a") setA(value);
          else setB(value);
          setResult(null);
          setFailure(null);
        }}
        placeholder="粘贴或导入文本…"
        height={wide ? 260 : 170}
        mono
        actions={
          <View style={styles.fieldActions}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`从剪贴板粘贴到文本 ${target.toUpperCase()}`}
              onPress={() => void pasteInto(target)}
              style={({ pressed }) => [styles.inlineAction, { opacity: pressed ? 0.6 : 1 }]}
            >
              <AppIcon name="clipboard" size={16} color={tokens.textSoft} />
              <Text style={[styles.inlineText, { color: tokens.textSoft }]}>粘贴</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`从文件导入到文本 ${target.toUpperCase()}`}
              onPress={() => void importInto(target)}
              style={({ pressed }) => [styles.inlineAction, { opacity: pressed ? 0.6 : 1 }]}
            >
              <AppIcon name="upload" size={16} color={tokens.textSoft} />
              <Text style={[styles.inlineText, { color: tokens.textSoft }]}>导入</Text>
            </Pressable>
          </View>
        }
      />
      <Text style={[styles.stats, { color: tokens.muted }]}>
        {(target === "a" ? inputStats.aLines : inputStats.bLines)} 行 · 上限 {MAX_DIFF_LINES} 行 / {MAX_DIFF_CELLS.toLocaleString()} 单元格
      </Text>
    </View>
  );

  return (
    <ToolScreen
      title="代码对比"
      subtitle="行级差异 · 忽略空白 · 差异统计"
      onBack={onBack}
      footer={
        <View style={styles.footerRow}>
          <ToolButton
            label={busy ? "对比中…" : "开始对比"}
            tone="primary"
            icon="code"
            disabled={busy}
            onPress={run}
            style={styles.footerPrimary}
          />
          <ToolButton label="复制差异" icon="copy" disabled={!result} onPress={() => void copyResult()} />
          <ToolButton label="保存" icon="download" disabled={!result} onPress={() => void saveResult()} />
        </View>
      }
    >
      {wide ? (
        <View style={styles.columns}>
          <View style={styles.column}>{pane("a")}</View>
          <View style={styles.column}>{pane("b")}</View>
        </View>
      ) : (
        <>
          {pane("a")}
          {pane("b")}
        </>
      )}

      <ToolSection title="对比选项">
        <View style={styles.chipRow}>
          <Chip
            label="忽略行首尾空白"
            active={ignoreWhitespace}
            onPress={() => {
              setIgnoreWhitespace((value) => !value);
              setResult(null);
            }}
            variant="soft"
          />
          <Chip
            label="只看差异（含 2 行上下文）"
            active={onlyChanges}
            onPress={() => setOnlyChanges((value) => !value)}
            variant="soft"
          />
        </View>
        <View style={styles.actionRow}>
          <ToolButton label="开始对比" tone="primary" icon="code" onPress={run} disabled={busy} />
          <ToolButton label="清空两侧" icon="delete" onPress={clearAll} disabled={busy || (!a && !b)} />
        </View>
        <ToolNote text="替换会显示为相邻的「− 旧行 / + 新行」；不会自动合并，也不修改原文。" />
      </ToolSection>

      {failure ? <ToolNote text={failure.message} tone="warn" /> : null}

      {result ? (
        <ToolSection title="差异结果">
          <View style={styles.statsRow}>
            <Stat label="新增" value={result.stats.added} tone={tokens.ok} />
            <Stat label="删除" value={result.stats.removed} tone={tokens.danger} />
            <Stat label="修改" value={result.stats.changed} tone={tokens.warn} />
            <Stat label="相同" value={result.stats.unchanged} tone={tokens.muted} />
          </View>
          {result.truncated ? (
            <ToolNote text="差异过大，引擎已截断输出；统计仍按完整比较计算。" tone="warn" />
          ) : null}

          <View style={[styles.diffBox, { borderColor: tokens.cardBorder, backgroundColor: tokens.card }]}>
            <ScrollView horizontal showsHorizontalScrollIndicator>
              <View>
                {visibleOps.map((op, index) => (
                  <DiffRow key={`${op.type}-${op.aLine ?? "x"}-${op.bLine ?? "y"}-${index}`} op={op} />
                ))}
              </View>
            </ScrollView>
            {visibleOps.length === 0 ? (
              <Text style={[styles.stats, { color: tokens.muted, padding: space.md }]}>
                两段文本没有差异。
              </Text>
            ) : null}
          </View>
          {onlyChanges ? (
            <Text style={[styles.stats, { color: tokens.muted }]}>
              已隐藏相同行；显示 {visibleOps.length} 行。
            </Text>
          ) : null}
          <View style={styles.actionRow}>
            <ToolButton label="复制差异" icon="copy" onPress={() => void copyResult()} />
            <ToolButton label="分享" icon="share" onPress={() => void shareResult()} />
          </View>
        </ToolSection>
      ) : (
        <ToolNote text="输入两段文本后点「开始对比」。输入只在内存，不写数据库、不上传。" />
      )}
    </ToolScreen>
  );
}

function DiffRow({ op }: { op: DiffOp }) {
  const { tokens } = useTheme();
  const marker = op.type === "insert" ? "+" : op.type === "delete" ? "−" : " ";
  const background =
    op.type === "insert"
      ? tokens.okSoft
      : op.type === "delete"
        ? tokens.dangerSoft
        : "transparent";
  const color = op.type === "insert" ? tokens.ok : op.type === "delete" ? tokens.danger : tokens.textSoft;
  return (
    <View style={[styles.diffRow, { backgroundColor: background }]}>
      <Text style={[styles.lineNo, { color: tokens.faint }]}>{op.aLine ?? ""}</Text>
      <Text style={[styles.lineNo, { color: tokens.faint }]}>{op.bLine ?? ""}</Text>
      <Text style={[styles.marker, { color }]}>{marker}</Text>
      <Text style={[styles.diffText, { color: op.type === "equal" ? tokens.textSoft : color }]}>
        {op.text.length > 0 ? op.text : " "}
      </Text>
    </View>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone: string }) {
  const { tokens } = useTheme();
  return (
    <View style={styles.stat}>
      <Text style={[styles.statValue, { color: tone }]}>{value}</Text>
      <Text style={[styles.statLabel, { color: tokens.muted }]}>{label}</Text>
    </View>
  );
}

function unifiedText(ops: DiffOp[]): string {
  return ops
    .map((op) => `${op.type === "insert" ? "+" : op.type === "delete" ? "-" : " "}${op.text}`)
    .join("\n");
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  return text.split(/\r\n|\r|\n/).length;
}

const styles = StyleSheet.create({
  footerRow: { flexDirection: "row", gap: space.sm },
  footerPrimary: { flex: 1 },
  columns: { flexDirection: "row", gap: space.lg },
  column: { flex: 1, minWidth: 0 },
  pane: { gap: space.xs },
  fieldActions: { flexDirection: "row", alignItems: "center", gap: space.sm },
  inlineAction: { flexDirection: "row", alignItems: "center", gap: space.xs, minHeight: 32 },
  inlineText: { fontSize: font.label, fontWeight: "600" },
  stats: { fontSize: font.label },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  actionRow: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  statsRow: { flexDirection: "row", gap: space.sm },
  stat: { flex: 1, alignItems: "center", gap: 1 },
  statValue: { fontSize: font.section, fontWeight: "700", fontVariant: ["tabular-nums"] },
  statLabel: { fontSize: font.label },
  diffBox: { borderRadius: radius.control, borderWidth: StyleSheet.hairlineWidth, paddingVertical: space.xs },
  diffRow: { flexDirection: "row", alignItems: "flex-start", minHeight: 20, paddingHorizontal: space.xs },
  lineNo: { width: 34, fontSize: 10, fontFamily: "monospace", textAlign: "right", paddingRight: space.xs },
  marker: { width: 14, fontSize: 12, fontFamily: "monospace" },
  diffText: { fontSize: 12, lineHeight: 18, fontFamily: "monospace" },
});
