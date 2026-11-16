// 正则测试：编译期拒绝回溯型构造，运行时用线性时间 Pike VM，永不执行用户提供的 RegExp。
//
// 安全边界：
// - pattern ≤ 200 字符、输入 ≤ 20000 字符、最多返回 500 个匹配；编译与匹配都是同步纯函数，
//   状态数上限保证单次在毫秒级（引擎测试里有灾难性模式 (a+)+$ 的实测）；
// - 因此不需要 Web Worker / 中断脚本；页面仍先让出一帧再执行，避免大文本瞬时卡顿；
// - 替换只支持 $1…$9、$&、$0、$$，由引擎的 expandReplacement 解析，不执行函数替换。
import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { Chip } from "../../../components/Chip";
import { AppIcon } from "../../../components/icons/AppIcon";
import { useToast } from "../../../feedback/ToastProvider";
import {
  MAX_INPUT_LENGTH,
  MAX_MATCHES,
  MAX_PATTERN_LENGTH,
  compileRegex,
  expandReplacement,
  type RegexFlags,
  type RegexMatch,
} from "../../../domain/tools/regexEngine";
import { recordToolUse } from "../../../db/toolUsage";
import { describeError } from "../../../lib/errors";
import { useTheme } from "../../../theme/ThemeProvider";
import { font, radius, space } from "../../../theme/tokens";
import { readClipboard, readTextFile, shareOutText, writeClipboard, writeToolTextFile } from "../shared/nativeTools";
import { saveTextFileToDownloads } from "../shared/saveOutput";
import { pickLocalFiles } from "../../../lib/sync/fileIo";
import { takeTextDraft } from "../shareIntake";
import { ToolButton, ToolField, ToolNote, ToolScreen, ToolSection, ToolTextArea } from "../shared/ToolUI";

const TOOL_ID = "tool.regex";

interface Outcome {
  matches: RegexMatch[];
  truncated: boolean;
  replacement: string | null;
}

const EXAMPLES = [
  {
    label: "邮箱",
    pattern: "[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}",
    text: "联系 alice@example.com 或 bob.smith@corp.cn 获取更多信息。",
    replacement: "[email]",
  },
  {
    label: "日期",
    pattern: "\\d{4}-\\d{2}-\\d{2}",
    text: "上线日期 2026-11-16，回归日期 2026-11-20。",
    replacement: "[date]",
  },
  {
    label: "URL",
    pattern: "https?://[^\\s]+",
    text: "文档 https://example.com/docs?id=1 与 http://test.local/a 都可访问。",
    replacement: "[url]",
  },
  {
    label: "连续数字",
    pattern: "\\d+",
    text: "订单 20261116 共 3 件，金额 1280 元。",
    replacement: "#",
  },
];

export function RegexScreen({ onBack }: { onBack: () => void }) {
  const { tokens } = useTheme();
  const { showToast } = useToast();

  const [pattern, setPattern] = useState("");
  const [flags, setFlags] = useState<RegexFlags>({ ignoreCase: false, multiline: false, dotAll: false });
  const [text, setText] = useState("");
  const [replacement, setReplacement] = useState("");
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void recordToolUse(TOOL_ID);
  }, []);

  useEffect(() => {
    const draft = takeTextDraft();
    if (draft) setText(draft);
  }, []);

  const run = () => {
    if (busy) return;
    setError("");
    const compiled = compileRegex(pattern, flags);
    if (!compiled.ok) {
      setOutcome(null);
      setError(compiled.message);
      return;
    }
    if (text.length > MAX_INPUT_LENGTH) {
      setOutcome(null);
      setError(`测试文本 ${text.length} 字符，超过上限 ${MAX_INPUT_LENGTH}`);
      return;
    }
    setBusy(true);
    setTimeout(() => {
      try {
        const matches = compiled.regex.matchAll(text, MAX_MATCHES);
        const truncated = matches.length >= MAX_MATCHES;
        let replaced: string | null = null;
        if (replacement.trim().length > 0) {
          let cursor = 0;
          let out = "";
          for (const match of matches) {
            out += text.slice(cursor, match.start);
            out += expandReplacement(replacement, match, text);
            cursor = match.end;
          }
          out += text.slice(cursor);
          replaced = out;
        }
        setOutcome({ matches, truncated, replacement: replaced });
      } catch (runError) {
        setError(`执行失败：${describeError(runError)}`);
        setOutcome(null);
      } finally {
        setBusy(false);
      }
    }, 30);
  };

  const highlighted = useMemo(() => {
    if (!outcome || outcome.matches.length === 0) return null;
    const limit = 100;
    const parts: { text: string; hit: boolean }[] = [];
    let cursor = 0;
    for (const match of outcome.matches.slice(0, limit)) {
      if (match.start > cursor) parts.push({ text: text.slice(cursor, match.start), hit: false });
      parts.push({ text: text.slice(match.start, match.end), hit: true });
      cursor = match.end;
    }
    if (cursor < text.length) parts.push({ text: text.slice(cursor), hit: false });
    return { parts, hidden: Math.max(0, outcome.matches.length - limit) };
  }, [outcome, text]);

  const copyMatches = async () => {
    if (!outcome) return;
    const textOut =
      replacement.trim().length > 0 && outcome.replacement !== null
        ? outcome.replacement
        : outcome.matches
            .map((match, index) => `${index + 1}. ${match.text} @${match.start}-${match.end}`)
            .join("\n");
    try {
      await writeClipboard(textOut);
      showToast("结果已复制", "success");
    } catch (copyError) {
      showToast(describeError(copyError), "danger");
    }
  };

  const saveResult = async () => {
    if (!outcome) return;
    const content =
      replacement.trim().length > 0 && outcome.replacement !== null
        ? outcome.replacement
        : outcome.matches.map((match, index) => `${index + 1}. ${match.text} @${match.start}-${match.end}`).join("\n");
    try {
      const name = `regex-${Date.now()}.txt`;
      const file = writeToolTextFile(name, content);
      const saved = await saveTextFileToDownloads(file.uri, name);
      showToast(`已保存到下载目录：${saved.displayName}`, "success");
    } catch (saveError) {
      showToast(`保存失败：${describeError(saveError)}`, "danger");
    }
  };

  const pasteTo = async (target: "pattern" | "text") => {
    try {
      const value = await readClipboard();
      if (!value) {
        showToast("剪贴板为空", "info");
        return;
      }
      if (target === "pattern") setPattern(value.trim());
      else setText(value);
    } catch (pasteError) {
      showToast(describeError(pasteError), "danger");
    }
  };

  const importText = async () => {
    try {
      const files = await pickLocalFiles();
      const file = files[0];
      if (!file) return;
      const content = await readTextFile(file.uri, 2_000_000);
      setText(content);
      showToast(`已导入 ${file.name ?? "文件"}（${content.length} 字符）`, "success");
    } catch (importError) {
      showToast(`导入失败：${describeError(importError)}`, "danger");
    }
  };

  const applyExample = (example: (typeof EXAMPLES)[number]) => {
    setPattern(example.pattern);
    setText(example.text);
    setReplacement(example.replacement);
    setOutcome(null);
    setError("");
  };

  return (
    <ToolScreen
      title="正则测试"
      subtitle="线性时间引擎 · 不支持前瞻/反向引用"
      onBack={onBack}
      footer={
        <View style={styles.footerRow}>
          <ToolButton
            label={busy ? "匹配中…" : "执行匹配"}
            tone="primary"
            icon="regex"
            disabled={busy || pattern.length === 0}
            onPress={run}
            style={styles.footerPrimary}
          />
          <ToolButton label="复制结果" icon="copy" disabled={!outcome} onPress={() => void copyMatches()} />
          <ToolButton label="保存" icon="download" disabled={!outcome} onPress={() => void saveResult()} />
        </View>
      }
    >
      <ToolSection title="表达式">
        <ToolField
          label="Pattern"
          value={pattern}
          onChangeText={(value) => {
            setPattern(value);
            setOutcome(null);
            setError("");
          }}
          placeholder="例如 [a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}"
          mono
          maxLength={MAX_PATTERN_LENGTH}
          actions={
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="从剪贴板粘贴表达式"
              onPress={() => void pasteTo("pattern")}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              style={({ pressed }) => [styles.inlineAction, { opacity: pressed ? 0.6 : 1 }]}
            >
              <AppIcon name="clipboard" size={16} color={tokens.textSoft} />
              <Text style={[styles.inlineText, { color: tokens.textSoft }]}>粘贴</Text>
            </Pressable>
          }
        />
        <View style={styles.flagRow}>
          <Chip
            label="忽略大小写 i"
            active={flags.ignoreCase}
            onPress={() => setFlags((current) => ({ ...current, ignoreCase: !current.ignoreCase }))}
            variant="soft"
          />
          <Chip
            label="多行 m"
            active={flags.multiline}
            onPress={() => setFlags((current) => ({ ...current, multiline: !current.multiline }))}
            variant="soft"
          />
          <Chip
            label=". 匹配换行 s"
            active={flags.dotAll}
            onPress={() => setFlags((current) => ({ ...current, dotAll: !current.dotAll }))}
            variant="soft"
          />
        </View>
        <ToolNote text="支持字符类、量词、分组、或、锚点与 \\d \\w \\s；前瞻、后顾、反向引用在编译期直接拒绝。" />
      </ToolSection>

      <ToolSection title="常用示例">
        <View style={styles.exampleRow}>
          {EXAMPLES.map((example) => (
            <Chip key={example.label} label={example.label} active={false} onPress={() => applyExample(example)} variant="soft" />
          ))}
        </View>
      </ToolSection>

      <ToolSection title="测试文本">
        <ToolTextArea
          label="Text"
          value={text}
          onChangeText={(value) => {
            setText(value);
            setOutcome(null);
            setError("");
          }}
          placeholder="粘贴需要匹配的文本…"
          height={180}
          actions={
            <View style={styles.fieldActions}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="从剪贴板粘贴文本"
                onPress={() => void pasteTo("text")}
                style={({ pressed }) => [styles.inlineAction, { opacity: pressed ? 0.6 : 1 }]}
              >
                <AppIcon name="clipboard" size={16} color={tokens.textSoft} />
                <Text style={[styles.inlineText, { color: tokens.textSoft }]}>粘贴</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="从文件导入文本"
                onPress={() => void importText()}
                style={({ pressed }) => [styles.inlineAction, { opacity: pressed ? 0.6 : 1 }]}
              >
                <AppIcon name="upload" size={16} color={tokens.textSoft} />
                <Text style={[styles.inlineText, { color: tokens.textSoft }]}>导入</Text>
              </Pressable>
            </View>
          }
        />
        <Text style={[styles.stats, { color: tokens.muted }]}>
          {text.length}/{MAX_INPUT_LENGTH} 字符
        </Text>
      </ToolSection>

      <ToolSection title="替换预览" hint="可选；支持 $1…$9、$&、$0、$$">
        <ToolField
          label="Replacement"
          value={replacement}
          onChangeText={(value) => {
            setReplacement(value);
            setOutcome(null);
          }}
          placeholder="例如 [$1]"
          mono
        />
      </ToolSection>

      {error ? <ToolNote text={error} tone="warn" /> : null}

      {outcome ? (
        <ToolSection
          title={`匹配结果 · ${outcome.matches.length}${outcome.truncated ? "+" : ""} 处`}
          hint={outcome.truncated ? `最多显示 ${MAX_MATCHES} 个匹配，超出的部分未列出` : undefined}
        >
          {highlighted ? (
            <View style={[styles.highlightBox, { backgroundColor: tokens.bgAccent, borderColor: tokens.cardBorder }]}>
              <ScrollView style={{ maxHeight: 220 }}>
                <Text style={[styles.highlightText, { color: tokens.text }]}>
                  {highlighted.parts.map((part, index) =>
                    part.hit ? (
                      <Text key={index} style={{ backgroundColor: tokens.accentSoft, color: tokens.accentText }}>
                        {part.text}
                      </Text>
                    ) : (
                      <Text key={index}>{part.text}</Text>
                    ),
                  )}
                </Text>
              </ScrollView>
              {highlighted.hidden > 0 ? (
                <Text style={[styles.stats, { color: tokens.muted }]}>
                  还有 {highlighted.hidden} 处未高亮（列表仍完整）
                </Text>
              ) : null}
            </View>
          ) : (
            <ToolNote text="没有匹配。" />
          )}

          {outcome.matches.slice(0, 50).map((match, index) => (
            <View key={`${match.start}-${match.end}-${index}`} style={[styles.matchRow, { borderColor: tokens.separator }]}>
              <Text style={[styles.matchIndex, { color: tokens.muted }]}>#{index + 1}</Text>
              <View style={styles.matchBody}>
                <Text selectable style={[styles.matchText, { color: tokens.text }]} numberOfLines={2}>
                  {match.text}
                </Text>
                <Text style={[styles.matchMeta, { color: tokens.muted }]}>
                  @{match.start}–{match.end}
                  {match.groups.length > 0
                    ? ` · 组：${match.groups.map((group, groupIndex) => `$${groupIndex + 1}=${group ?? "∅"}`).join("  ")}`
                    : ""}
                </Text>
              </View>
            </View>
          ))}
          {outcome.matches.length > 50 ? (
            <Text style={[styles.stats, { color: tokens.muted }]}>
              仅列出前 50 条，复制结果包含全部匹配。
            </Text>
          ) : null}

          {outcome.replacement !== null ? (
            <View style={styles.block}>
              <Text style={[styles.blockLabel, { color: tokens.textSoft }]}>替换后文本</Text>
              <View style={[styles.replaceBox, { backgroundColor: tokens.bgAccent, borderColor: tokens.cardBorder }]}>
                <ScrollView style={{ maxHeight: 200 }}>
                  <Text selectable style={[styles.highlightText, { color: tokens.text }]}>
                    {outcome.replacement}
                  </Text>
                </ScrollView>
              </View>
            </View>
          ) : null}

          <View style={styles.actionRow}>
            <ToolButton label="复制结果" icon="copy" onPress={() => void copyMatches()} />
            <ToolButton label="分享" icon="share" onPress={() => void shareOutcome(outcome, replacement, showToast)} />
          </View>
        </ToolSection>
      ) : null}
    </ToolScreen>
  );
}

async function shareOutcome(
  outcome: Outcome,
  replacement: string,
  showToast: (message: string, tone?: "info" | "success" | "danger" | "warn") => void,
): Promise<void> {
  try {
    const content =
      replacement.trim().length > 0 && outcome.replacement !== null
        ? outcome.replacement
        : outcome.matches.map((match, index) => `${index + 1}. ${match.text} @${match.start}-${match.end}`).join("\n");
    await shareOutText(content, "正则匹配结果");
  } catch (error) {
    showToast(describeError(error), "danger");
  }
}

const styles = StyleSheet.create({
  footerRow: { flexDirection: "row", gap: space.sm },
  footerPrimary: { flex: 1 },
  flagRow: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  exampleRow: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  inlineAction: { flexDirection: "row", alignItems: "center", gap: space.xs, minHeight: 32 },
  inlineText: { fontSize: font.label, fontWeight: "600" },
  fieldActions: { flexDirection: "row", alignItems: "center", gap: space.sm },
  stats: { fontSize: font.label },
  highlightBox: {
    borderRadius: radius.control,
    borderWidth: StyleSheet.hairlineWidth,
    padding: space.md,
    gap: space.xs,
  },
  highlightText: { fontSize: font.meta, lineHeight: 20, fontFamily: "monospace" },
  matchRow: {
    flexDirection: "row",
    gap: space.sm,
    paddingVertical: space.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  matchIndex: { fontSize: font.label, width: 34 },
  matchBody: { flex: 1, gap: 1, minWidth: 0 },
  matchText: { fontSize: font.meta, fontFamily: "monospace" },
  matchMeta: { fontSize: font.label },
  block: { gap: space.xs },
  blockLabel: { fontSize: font.label, fontWeight: "600" },
  replaceBox: {
    borderRadius: radius.control,
    borderWidth: StyleSheet.hairlineWidth,
    padding: space.md,
  },
  actionRow: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
});
