// 文本编解码：URL / Base64 / Unicode 转义 / 换行格式 / 去首尾空白。
//
// 为什么合并为「文本处理」一个入口：这些操作共享同一输入、同一结果区与同一套复制/分享，
// 拆成 6 个首页入口只会让工具面板变长，不增加效率。
// 所有编解码都走 domain/tools/textCodec 的严格实现（UTF-8 自实现、Base64 非法字符拒绝、
// Unicode 代理对校验），失败时给出可理解的原因，不静默返回半截结果。
import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { AppIcon } from "../../../components/icons/AppIcon";
import { SegmentedControl } from "../../../components/SegmentedControl";
import { Chip } from "../../../components/Chip";
import { useToast } from "../../../feedback/ToastProvider";
import {
  MAX_CODEC_CHARS,
  convertNewlines,
  decodeBase64,
  decodeUnicodeEscapes,
  decodeUrl,
  describeText,
  encodeBase64,
  encodeUnicodeEscapes,
  encodeUrl,
  trimWhitespace,
  type NewlineStyle,
  type TextResult,
} from "../../../domain/tools/textCodec";
import { recordToolUse } from "../../../db/toolUsage";
import { describeError } from "../../../lib/errors";
import { useTheme } from "../../../theme/ThemeProvider";
import { font, radius, space } from "../../../theme/tokens";
import {
  readClipboard,
  shareOutText,
  writeClipboard,
  writeToolTextFile,
} from "../shared/nativeTools";
import { saveTextFileToDownloads } from "../shared/saveOutput";
import { takeTextDraft } from "../shareIntake";
import { ToolButton, ToolNote, ToolScreen, ToolSection, ToolTextArea } from "../shared/ToolUI";

const TOOL_ID = "tool.text";

type OpId =
  | "urlEncode"
  | "urlDecode"
  | "b64Encode"
  | "b64Decode"
  | "unicodeEncode"
  | "unicodeDecode"
  | "trim"
  | "crlf"
  | "lf"
  | "cr";

export function TextCodecScreen({ onBack }: { onBack: () => void }) {
  const { tokens } = useTheme();
  const { showToast } = useToast();

  const [input, setInput] = useState("");
  const [output, setOutput] = useState("");
  const [error, setError] = useState("");
  const [plusAsSpace, setPlusAsSpace] = useState(true);
  const [newline, setNewline] = useState<NewlineStyle>("lf");
  const [lastOp, setLastOp] = useState<OpId | null>(null);

  useEffect(() => {
    void recordToolUse(TOOL_ID);
  }, []);

  useEffect(() => {
    const draft = takeTextDraft();
    if (draft) setInput(draft);
  }, []);

  const inputStats = useMemo(() => describeText(input), [input]);
  const outputStats = useMemo(() => describeText(output), [output]);

  const apply = (op: OpId) => {
    setError("");
    if (!input.length) {
      showToast("请先输入或粘贴文本", "info");
      return;
    }
    if (input.length > MAX_CODEC_CHARS) {
      setError(`输入 ${input.length} 字符，超过本机上限 ${MAX_CODEC_CHARS}；请先拆分`);
      return;
    }

    let result: TextResult;
    switch (op) {
      case "urlEncode":
        result = encodeUrl(input);
        break;
      case "urlDecode":
        result = decodeUrl(input, { plusAsSpace });
        break;
      case "b64Encode":
        result = encodeBase64(input);
        break;
      case "b64Decode":
        result = decodeBase64(input);
        break;
      case "unicodeEncode":
        result = encodeUnicodeEscapes(input);
        break;
      case "unicodeDecode":
        result = decodeUnicodeEscapes(input);
        break;
      case "trim":
        result = { ok: true, text: trimWhitespace(input) };
        break;
      case "lf":
      case "crlf":
      case "cr":
        result = { ok: true, text: convertNewlines(input, op) };
        break;
    }

    setLastOp(op);
    if (!result.ok) {
      setOutput("");
      setError(result.message);
      return;
    }
    setOutput(result.text);
    if (result.text === input) showToast("处理结果与输入相同", "info");
  };

  const paste = async () => {
    try {
      const text = await readClipboard();
      if (!text) {
        showToast("剪贴板为空", "info");
        return;
      }
      setInput(text);
      setOutput("");
      setError("");
    } catch (pasteError) {
      showToast(describeError(pasteError), "danger");
    }
  };

  const copy = async () => {
    if (!output) return;
    try {
      await writeClipboard(output);
      showToast("结果已复制", "success");
    } catch (copyError) {
      showToast(describeError(copyError), "danger");
    }
  };

  const save = async () => {
    if (!output) return;
    try {
      const name = `text-${Date.now()}.txt`;
      const file = writeToolTextFile(name, output);
      const saved = await saveTextFileToDownloads(file.uri, name);
      showToast(`已保存到下载目录：${saved.displayName}`, "success");
    } catch (saveError) {
      showToast(`保存失败：${describeError(saveError)}`, "danger");
    }
  };

  const share = async () => {
    if (!output) return;
    try {
      await shareOutText(output, "文本处理结果");
    } catch (shareError) {
      showToast(describeError(shareError), "danger");
    }
  };

  return (
    <ToolScreen
      title="文本编解码"
      subtitle="URL · Base64 · Unicode 转义 · 换行格式 · 去首尾空白"
      onBack={onBack}
      footer={
        <View style={styles.footerRow}>
          <ToolButton
            label="复制结果"
            tone="primary"
            icon="copy"
            disabled={!output}
            onPress={() => void copy()}
            style={styles.footerPrimary}
          />
          <ToolButton label="保存" icon="download" disabled={!output} onPress={() => void save()} />
          <ToolButton label="分享" icon="share" disabled={!output} onPress={() => void share()} />
        </View>
      }
    >
      <ToolSection title="输入">
        <ToolTextArea
          label="原始文本"
          value={input}
          onChangeText={(text) => {
            setInput(text);
            setError("");
          }}
          placeholder="粘贴需要处理的文本…"
          height={200}
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
        <Text style={[styles.stats, { color: tokens.muted }]}>
          {inputStats.chars} 字符 · {inputStats.bytes} 字节 · {inputStats.lines} 行
        </Text>
      </ToolSection>

      <ToolSection title="URL 编码 / 解码">
        <View style={styles.opRow}>
          <ToolButton label="URL 编码" icon="link" onPress={() => apply("urlEncode")} />
          <ToolButton label="URL 解码" icon="external" onPress={() => apply("urlDecode")} />
        </View>
        <Pressable
          accessibilityRole="checkbox"
          accessibilityState={{ checked: plusAsSpace }}
          onPress={() => setPlusAsSpace((value) => !value)}
          style={styles.checkRow}
        >
          <View
            style={[
              styles.checkBox,
              {
                borderColor: plusAsSpace ? tokens.accent : tokens.cardBorderStrong,
                backgroundColor: plusAsSpace ? tokens.accentSoft : "transparent",
              },
            ]}
          >
            {plusAsSpace ? <AppIcon name="check" size={14} color={tokens.accent} /> : null}
          </View>
          <Text style={[styles.checkLabel, { color: tokens.textSoft }]}>
            解码时把 + 当作空格（表单编码语义）
          </Text>
        </Pressable>
      </ToolSection>

      <ToolSection title="Base64">
        <View style={styles.opRow}>
          <ToolButton label="Base64 编码" icon="lock" onPress={() => apply("b64Encode")} />
          <ToolButton label="Base64 解码" icon="unlink" onPress={() => apply("b64Decode")} />
        </View>
        <ToolNote text="按 UTF-8 编解码；非法字符、长度不合法与孤立字节会直接报错，不会返回半截文本。" />
      </ToolSection>

      <ToolSection title="Unicode 转义">
        <View style={styles.opRow}>
          <ToolButton label="转为 \\uXXXX" icon="code" onPress={() => apply("unicodeEncode")} />
          <ToolButton label="还原转义" icon="codeTerminal" onPress={() => apply("unicodeDecode")} />
        </View>
        <ToolNote text="中文等非 ASCII 字符会转成 \\uXXXX；代理对（emoji）按完整字符处理。" />
      </ToolSection>

      <ToolSection title="换行与清理">
        <View style={styles.opRow}>
          <ToolButton label="去除首尾空白" icon="filter" onPress={() => apply("trim")} />
        </View>
        <View style={styles.newlineBlock}>
          <Text style={[styles.blockLabel, { color: tokens.textSoft }]}>换行格式</Text>
          <SegmentedControl
            options={[
              { value: "lf", label: "LF" },
              { value: "crlf", label: "CRLF" },
              { value: "cr", label: "CR" },
            ]}
            value={newline}
            onChange={(next) => {
              const style = next as NewlineStyle;
              setNewline(style);
              if (input.length > 0) apply(style);
            }}
            accessibilityLabel="目标换行格式"
            size="compact"
          />
        </View>
        <ToolButton label="转换换行格式" icon="refresh" onPress={() => apply(newline)} />
      </ToolSection>

      {error ? <ToolNote text={error} tone="warn" /> : null}

      <ToolSection title="结果">
        {output ? (
          <>
            <View
              style={[
                styles.resultBox,
                { backgroundColor: tokens.bgAccent, borderColor: tokens.cardBorder },
              ]}
            >
              <ScrollView horizontal showsHorizontalScrollIndicator>
                <Text selectable style={[styles.resultText, { color: tokens.text }]}>
                  {output}
                </Text>
              </ScrollView>
            </View>
            <Text style={[styles.stats, { color: tokens.muted }]}>
              {outputStats.chars} 字符 · {outputStats.bytes} 字节 · {outputStats.lines} 行
              {lastOp ? ` · 已执行 ${
                {
                  urlEncode: "URL 编码",
                  urlDecode: "URL 解码",
                  b64Encode: "Base64 编码",
                  b64Decode: "Base64 解码",
                  unicodeEncode: "Unicode 转义",
                  unicodeDecode: "Unicode 还原",
                  trim: "去除首尾空白",
                  lf: "换行为 LF",
                  crlf: "换行为 CRLF",
                  cr: "换行为 CR",
                }[lastOp]
              }` : ""}
            </Text>
          </>
        ) : (
          <ToolNote text="选择上面的操作后，结果显示在这里。输入与结果只在内存，不上传、不持久化。" />
        )}
      </ToolSection>
    </ToolScreen>
  );
}

const styles = StyleSheet.create({
  footerRow: { flexDirection: "row", gap: space.sm },
  footerPrimary: { flex: 1 },
  inlineAction: { flexDirection: "row", alignItems: "center", gap: space.xs, minHeight: 32 },
  inlineText: { fontSize: font.label, fontWeight: "600" },
  stats: { fontSize: font.label },
  opRow: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  checkRow: { flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 44 },
  checkBox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  checkLabel: { fontSize: font.meta, flexShrink: 1 },
  newlineBlock: { gap: space.xs },
  blockLabel: { fontSize: font.label, fontWeight: "600" },
  resultBox: {
    borderRadius: radius.control,
    borderWidth: StyleSheet.hairlineWidth,
    padding: space.md,
    maxHeight: 320,
  },
  resultText: { fontFamily: "monospace", fontSize: 13, lineHeight: 19 },
});
