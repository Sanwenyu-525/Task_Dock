// 时间戳转换：时间戳 ↔ 日期，秒 / 毫秒显式可选，本地与 UTC 同时展示。
//
// 设计取舍：
// - 不自动轮询当前时间：只有点「填入当前时间」才取一次 Date.now()，避免后台定时器；
// - 结果同时给出本地时间与 UTC 两套（以及秒、毫秒、ISO），切换时区不会让用户丢失对照；
// - 单位默认 auto，但明确写出识别依据，用户可随时手动切秒/毫秒；
// - 解析失败直接显示域层给出的具体原因（含夏令时不存在时间、月份天数等）。
import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { Chip } from "../../../components/Chip";
import { AppIcon } from "../../../components/icons/AppIcon";
import { SegmentedControl } from "../../../components/SegmentedControl";
import { useToast } from "../../../feedback/ToastProvider";
import {
  currentEpochMs,
  formatEpoch,
  formatRelative,
  parseDateInput,
  parseTimestampInput,
  type TimeZoneChoice,
  type TimestampUnit,
} from "../../../domain/tools/timestamp";
import { recordToolUse } from "../../../db/toolUsage";
import { describeError } from "../../../lib/errors";
import { useTheme } from "../../../theme/ThemeProvider";
import { font, space } from "../../../theme/tokens";
import { readClipboard, shareOutText, writeClipboard } from "../shared/nativeTools";
import { ToolButton, ToolField, ToolNote, ToolScreen, ToolSection } from "../shared/ToolUI";

const TOOL_ID = "tool.timestamp";

type Mode = "epoch" | "date";

interface Converted {
  epochMs: number;
  note?: string;
  source: Mode;
}

export function TimestampScreen({ onBack }: { onBack: () => void }) {
  const { tokens } = useTheme();
  const { showToast } = useToast();

  const [mode, setMode] = useState<Mode>("epoch");
  const [unit, setUnit] = useState<TimestampUnit>("auto");
  const [zone, setZone] = useState<TimeZoneChoice>("local");
  const [epochInput, setEpochInput] = useState("");
  const [dateInput, setDateInput] = useState("");
  const [converted, setConverted] = useState<Converted | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    void recordToolUse(TOOL_ID);
  }, []);

  // 日期输入随「本地 / UTC」切换实时重算：同一个字符串在两个时区含义不同，必须给即时反馈。
  const dateLive = useMemo(() => {
    if (mode !== "date" || !dateInput.trim()) return null;
    return parseDateInput(dateInput, zone);
  }, [dateInput, mode, zone]);

  const effective =
    mode === "epoch" ? converted : dateLive?.ok ? { epochMs: dateLive.epochMs, source: "date" as const } : null;

  const local = effective ? formatEpoch(effective.epochMs, "local") : null;
  const utc = effective ? formatEpoch(effective.epochMs, "utc") : null;

  const convert = () => {
    setError("");
    if (mode === "epoch") {
      const result = parseTimestampInput(epochInput, unit);
      if (!result.ok) {
        setConverted(null);
        setError(result.message);
        return;
      }
      setConverted({ epochMs: result.epochMs, note: result.note, source: "epoch" });
      return;
    }
    const result = parseDateInput(dateInput, zone);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setConverted({ epochMs: result.epochMs, source: "date" });
  };

  const fillNow = () => {
    const now = currentEpochMs();
    setMode("epoch");
    setUnit("auto");
    setEpochInput(String(now));
    setConverted({ epochMs: now, source: "epoch" });
    setError("");
    showToast("已填入当前毫秒时间戳", "success");
  };

  const paste = async () => {
    try {
      const text = await readClipboard();
      if (!text) {
        showToast("剪贴板为空", "info");
        return;
      }
      if (mode === "epoch") setEpochInput(text.trim());
      else setDateInput(text.trim());
    } catch (pasteError) {
      showToast(describeError(pasteError), "danger");
    }
  };

  const copy = async (label: string, text: string) => {
    try {
      await writeClipboard(text);
      showToast(`${label}已复制`, "success");
    } catch (copyError) {
      showToast(describeError(copyError), "danger");
    }
  };

  const copyAll = async () => {
    if (!local || !utc) return;
    const text = [
      `时间戳(秒)：${local.seconds}`,
      `时间戳(毫秒)：${local.milliseconds}`,
      `本地时间：${local.dateTime}（${local.weekday}，${local.zoneLabel}）`,
      `UTC：${utc.dateTime}`,
      `ISO 8601（本地）：${local.iso}`,
      `ISO 8601（UTC）：${utc.iso}`,
    ].join("\n");
    await copy("完整结果", text);
  };

  const share = async () => {
    if (!local || !utc) return;
    try {
      await shareOutText(
        `时间戳 ${local.milliseconds}\n本地 ${local.dateTime}\nUTC ${utc.dateTime}\nISO ${local.iso}`,
        "时间戳转换结果",
      );
    } catch (shareError) {
      showToast(describeError(shareError), "danger");
    }
  };

  const resultRows: { key: string; label: string; value: string }[] = local
    ? [
        { key: "sec", label: "Unix 秒", value: local.seconds },
        { key: "ms", label: "Unix 毫秒", value: local.milliseconds },
        { key: "dt", label: "本地时间", value: `${local.dateTime}  ${local.weekday}` },
        { key: "iso", label: "ISO 8601", value: local.iso },
      ]
    : [];

  return (
    <ToolScreen
      title="时间戳转换"
      subtitle="秒 / 毫秒 / ISO / 本地与 UTC，双向换算"
      onBack={onBack}
      footer={
        <View style={styles.footerRow}>
          <ToolButton
            label="复制完整结果"
            tone="primary"
            icon="copy"
            disabled={!local}
            onPress={() => void copyAll()}
            style={styles.footerPrimary}
          />
          <ToolButton label="分享" icon="share" disabled={!local} onPress={() => void share()} />
        </View>
      }
    >
      <ToolSection title="转换方向">
        <SegmentedControl
          options={[
            { value: "epoch", label: "时间戳 → 日期" },
            { value: "date", label: "日期 → 时间戳" },
          ]}
          value={mode}
          onChange={(next) => {
            setMode(next as Mode);
            setError("");
            setConverted(null);
          }}
          accessibilityLabel="转换方向"
        />

        {mode === "epoch" ? (
          <>
            <ToolField
              label="时间戳"
              value={epochInput}
              onChangeText={(text) => {
                setEpochInput(text);
                setError("");
              }}
              placeholder="例如 1763270400000"
              keyboardType="numeric"
              autoCapitalize="none"
              actions={
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="从剪贴板粘贴时间戳"
                  onPress={() => void paste()}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  style={({ pressed }) => [styles.inlineAction, { opacity: pressed ? 0.6 : 1 }]}
                >
                  <AppIcon name="clipboard" size={16} color={tokens.textSoft} />
                  <Text style={[styles.inlineText, { color: tokens.textSoft }]}>粘贴</Text>
                </Pressable>
              }
            />
            <View style={styles.block}>
              <Text style={[styles.blockLabel, { color: tokens.textSoft }]}>单位</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
                {(
                  [
                    { id: "auto", label: "自动识别" },
                    { id: "seconds", label: "秒（10 位）" },
                    { id: "milliseconds", label: "毫秒（13 位）" },
                  ] as { id: TimestampUnit; label: string }[]
                ).map((item) => (
                  <Chip
                    key={item.id}
                    label={item.label}
                    active={unit === item.id}
                    onPress={() => {
                      setUnit(item.id);
                      setError("");
                    }}
                    variant="soft"
                  />
                ))}
              </ScrollView>
            </View>
          </>
        ) : (
          <>
            <ToolField
              label="日期时间"
              value={dateInput}
              onChangeText={(text) => {
                setDateInput(text);
                setError("");
              }}
              placeholder="2026-11-16 08:30:00（可带 Z 或 +08:00）"
              autoCapitalize="none"
              actions={
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="从剪贴板粘贴日期"
                  onPress={() => void paste()}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  style={({ pressed }) => [styles.inlineAction, { opacity: pressed ? 0.6 : 1 }]}
                >
                  <AppIcon name="clipboard" size={16} color={tokens.textSoft} />
                  <Text style={[styles.inlineText, { color: tokens.textSoft }]}>粘贴</Text>
                </Pressable>
              }
            />
            <View style={styles.block}>
              <Text style={[styles.blockLabel, { color: tokens.textSoft }]}>不带时区时按</Text>
              <View style={styles.chipRow}>
                <Chip
                  label="设备本地时区"
                  active={zone === "local"}
                  onPress={() => setZone("local")}
                  variant="soft"
                />
                <Chip label="UTC" active={zone === "utc"} onPress={() => setZone("utc")} variant="soft" />
              </View>
            </View>
          </>
        )}

        <View style={styles.actionRow}>
          <ToolButton label="换算" tone="primary" icon="refresh" onPress={convert} />
          <ToolButton label="填入当前时间" icon="clock" onPress={fillNow} />
        </View>

        {error ? <ToolNote text={error} tone="warn" /> : null}
        {mode === "epoch" && converted?.note ? <ToolNote text={converted.note} /> : null}
        {mode === "date" && dateLive && !dateLive.ok && dateInput.trim() ? (
          <ToolNote text={dateLive.message} tone="warn" />
        ) : null}
      </ToolSection>

      {local && utc ? (
        <>
          <ToolSection title="Unix 时间戳">
            {resultRows
              .filter((row) => row.key === "sec" || row.key === "ms")
              .map((row) => (
                <ResultRow key={row.key} label={row.label} value={row.value} onCopy={() => void copy(row.label, row.value)} />
              ))}
            <Text style={[styles.relative, { color: tokens.muted }]}>
              {formatRelative(effective!.epochMs, Date.now())}
            </Text>
          </ToolSection>

          <ToolSection title={`本地时间 · ${local.zoneLabel}`}>
            {resultRows
              .filter((row) => row.key === "dt" || row.key === "iso")
              .map((row) => (
                <ResultRow key={row.key} label={row.label} value={row.value} onCopy={() => void copy(row.label, row.value)} />
              ))}
            <Text style={[styles.note, { color: tokens.muted }]}>
              设备时区偏移随系统设置与夏令时变化；这里按当前系统时区计算。
            </Text>
          </ToolSection>

          <ToolSection title="UTC">
            <ResultRow label="UTC 时间" value={`${utc.dateTime}  ${utc.weekday}`} onCopy={() => void copy("UTC 时间", utc.dateTime)} />
            <ResultRow label="ISO 8601 (Z)" value={utc.iso} onCopy={() => void copy("ISO 8601 (UTC)", utc.iso)} />
          </ToolSection>
        </>
      ) : (
        <ToolNote text="输入后点「换算」查看结果；秒与毫秒会同时给出，避免单位误判。" />
      )}
    </ToolScreen>
  );
}

function ResultRow({
  label,
  value,
  onCopy,
}: {
  label: string;
  value: string;
  onCopy: () => void;
}) {
  const { tokens } = useTheme();
  return (
    <View style={[styles.resultRow, { borderColor: tokens.cardBorder }]}>
      <View style={styles.resultText}>
        <Text style={[styles.resultLabel, { color: tokens.muted }]}>{label}</Text>
        <Text selectable style={[styles.resultValue, { color: tokens.text }]}>
          {value}
        </Text>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`复制${label}`}
        onPress={onCopy}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        style={({ pressed }) => [styles.copyButton, { opacity: pressed ? 0.6 : 1 }]}
      >
        <AppIcon name="copy" size={18} color={tokens.textSoft} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  footerRow: { flexDirection: "row", gap: space.sm },
  footerPrimary: { flex: 1 },
  block: { gap: space.xs },
  blockLabel: { fontSize: font.label, fontWeight: "600" },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  actionRow: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  inlineAction: { flexDirection: "row", alignItems: "center", gap: space.xs, minHeight: 32 },
  inlineText: { fontSize: font.label, fontWeight: "600" },
  resultRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingVertical: space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  resultText: { flex: 1, gap: 2, minWidth: 0 },
  resultLabel: { fontSize: font.label },
  resultValue: { fontSize: font.body, fontFamily: "monospace" },
  copyButton: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  relative: { fontSize: font.label, paddingTop: space.xs },
  note: { fontSize: font.label, lineHeight: 18 },
});
