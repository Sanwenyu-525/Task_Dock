// 开发者工具的统一页面基座与交互组件。
//
// 这一层只做三件事：
// 1) 统一结构：AppBar + 说明 + 内容 + 底部操作区（安全区/键盘让位/滚动都处理一次）；
// 2) 统一视觉：全部取自语义 Token，圆角/间距/字阶与现有移动端页面一致；
// 3) 统一命中区：按钮/输入/图标操作都不小于 44dp，按压有反馈，尊重减少动态效果。
//
// 不引入抽象组件框架：这里只有工具页真实需要的 9 个组件，页面仍可直接写 JSX。
import type { ReactNode } from "react";
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type KeyboardTypeOptions,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from "react-native";

import { AppBar } from "../../../components/AppBar";
import { AppIcon, type IconName } from "../../../components/icons/AppIcon";
import { PressableScale } from "../../../components/PressableScale";
import { useTheme } from "../../../theme/ThemeProvider";
import { font, radius, space } from "../../../theme/tokens";
import { useWindowInsets } from "../../../lib/insets";
import { useKeyboardHeight } from "../../../lib/keyboard";

export const MONO_FONT = Platform.select({ android: "monospace", ios: "Menlo", default: "monospace" });

export function ToolScreen({
  title,
  subtitle,
  onBack,
  right,
  children,
  footer,
  scroll = true,
  contentStyle,
}: {
  title: string;
  subtitle?: string;
  onBack: () => void;
  right?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  /** false 时由页面自己渲染 FlatList/ScrollView（列表页需要虚拟化） */
  scroll?: boolean;
  contentStyle?: StyleProp<ViewStyle>;
}) {
  const { tokens } = useTheme();
  const insets = useWindowInsets();
  const keyboardHeight = useKeyboardHeight();

  const content = (
    <View style={[styles.content, { paddingBottom: space.xl + insets.bottom + keyboardHeight }, contentStyle]}>
      {subtitle ? (
        <Text style={[styles.subtitle, { color: tokens.muted }]}>{subtitle}</Text>
      ) : null}
      {children}
    </View>
  );

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <AppBar title={title} onBack={onBack} right={right} />
      {scroll ? (
        <ScrollView
          style={styles.body}
          contentContainerStyle={styles.grow}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          showsVerticalScrollIndicator={false}
        >
          {content}
        </ScrollView>
      ) : (
        <View style={styles.body}>{content}</View>
      )}
      {footer ? (
        <View
          style={[
            styles.footer,
            {
              backgroundColor: tokens.bg,
              borderColor: tokens.separator,
              paddingBottom: Math.max(insets.bottom, 8),
              marginBottom: keyboardHeight,
            },
          ]}
        >
          {footer}
        </View>
      ) : null}
    </View>
  );
}

export function ToolSection({
  title,
  hint,
  right,
  children,
}: {
  title?: string;
  hint?: string;
  right?: ReactNode;
  children: ReactNode;
}) {
  const { tokens } = useTheme();
  return (
    <View style={styles.section}>
      {title || right ? (
        <View style={styles.sectionHead}>
          {title ? <Text style={[styles.sectionTitle, { color: tokens.text }]}>{title}</Text> : <View />}
          {right}
        </View>
      ) : null}
      {hint ? <Text style={[styles.sectionHint, { color: tokens.muted }]}>{hint}</Text> : null}
      <View style={styles.sectionBody}>{children}</View>
    </View>
  );
}

export type ToolButtonTone = "primary" | "secondary" | "ghost" | "danger" | "ok";

export function ToolButton({
  label,
  onPress,
  tone = "secondary",
  icon,
  disabled = false,
  loading = false,
  accessibilityHint,
  style,
  compact = false,
}: {
  label: string;
  onPress: () => void;
  tone?: ToolButtonTone;
  icon?: IconName;
  disabled?: boolean;
  /** 只改变视觉与无障碍状态，实际进行中的状态由页面文案表达 */
  loading?: boolean;
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
  compact?: boolean;
}) {
  const { tokens } = useTheme();
  const palette =
    tone === "primary"
      ? { background: tokens.accentFill, border: tokens.accentFill, text: tokens.onAccent }
      : tone === "danger"
        ? { background: tokens.dangerSoft, border: tokens.danger, text: tokens.danger }
        : tone === "ok"
          ? { background: tokens.okSoft, border: tokens.ok, text: tokens.ok }
          : tone === "ghost"
            ? { background: "transparent", border: "transparent", text: tokens.textSoft }
            : { background: tokens.card, border: tokens.cardBorder, text: tokens.text };

  return (
    <PressableScale
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: disabled || loading }}
      disabled={disabled || loading}
      onPress={onPress}
      style={style}
      contentStyle={[
        styles.button,
        compact ? styles.buttonCompact : null,
        { backgroundColor: palette.background, borderColor: palette.border },
      ]}
    >
     <View style={styles.buttonInner}>
        {icon ? <AppIcon name={icon} size={18} color={palette.text} /> : null}
        <Text
          numberOfLines={1}
          style={[styles.buttonLabel, compact ? styles.buttonLabelCompact : null, { color: palette.text }]}
        >
          {loading ? "处理中…" : label}
        </Text>
      </View>
    </PressableScale>
  );
}

export function ToolIconButton({
  icon,
  label,
  onPress,
  tone = "normal",
  disabled = false,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  tone?: "normal" | "accent" | "danger";
  disabled?: boolean;
}) {
  const { tokens } = useTheme();
  const color = tone === "danger" ? tokens.danger : tone === "accent" ? tokens.accent : tokens.text;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
      style={({ pressed }) => [styles.iconButton, { opacity: disabled ? 0.4 : pressed ? 0.6 : 1 }]}
    >
      <AppIcon name={icon} size={22} color={color} />
    </Pressable>
  );
}

export function ToolField({
  label,
  value,
  onChangeText,
  placeholder,
  hint,
  mono = false,
  multiline = false,
  minHeight,
  keyboardType,
  autoCapitalize = "none",
  autoCorrect = false,
  maxLength,
  right,
  actions,
}: {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  hint?: string;
  mono?: boolean;
  multiline?: boolean;
  minHeight?: number;
  keyboardType?: KeyboardTypeOptions;
  autoCapitalize?: TextInputProps["autoCapitalize"];
  autoCorrect?: boolean;
  maxLength?: number;
  right?: ReactNode;
  /** 与 ToolTextArea 一致的字段右上角操作（粘贴 / 清空等） */
  actions?: ReactNode;
}) {
  const { tokens } = useTheme();
  return (
    <View style={styles.field}>
      <View style={styles.fieldHead}>
        <Text style={[styles.fieldLabel, { color: tokens.textSoft }]}>{label}</Text>
        <View style={styles.fieldActions}>
          {right}
          {actions}
        </View>
      </View>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={tokens.muted}
        multiline={multiline}
        textAlignVertical={multiline ? "top" : "center"}
        keyboardType={keyboardType}
        autoCapitalize={autoCapitalize}
        autoCorrect={autoCorrect}
        maxLength={maxLength}
        underlineColorAndroid="transparent"
        style={[
          styles.input,
          multiline ? styles.inputMultiline : null,
          mono ? styles.mono : null,
          {
            backgroundColor: tokens.bgAccent,
            borderColor: tokens.cardBorder,
            color: tokens.text,
            minHeight: minHeight ?? (multiline ? 120 : 44),
          },
        ]}
      />
      {hint ? <Text style={[styles.fieldHint, { color: tokens.muted }]}>{hint}</Text> : null}
    </View>
  );
}

export function ToolTextArea({
  label,
  value,
  onChangeText,
  placeholder,
  minHeight = 180,
  height,
  mono = false,
  actions,
}: {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  minHeight?: number;
  /** 固定高度（长文本使用输入框内部滚动，避免把外层页面撑成几千像素） */
  height?: number;
  mono?: boolean;
  actions?: ReactNode;
}) {
  const { tokens } = useTheme();
  return (
    <View style={styles.field}>
      <View style={styles.fieldHead}>
        <Text style={[styles.fieldLabel, { color: tokens.textSoft }]}>{label}</Text>
        <View style={styles.fieldActions}>{actions}</View>
      </View>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={tokens.muted}
        multiline
        autoCapitalize="none"
        autoCorrect={false}
        textAlignVertical="top"
        underlineColorAndroid="transparent"
        style={[
          styles.input,
          styles.inputMultiline,
          mono ? styles.mono : null,
          {
            backgroundColor: tokens.bgAccent,
            borderColor: tokens.cardBorder,
            color: tokens.text,
            minHeight: height ? undefined : minHeight,
            height,
          },
        ]}
      />
    </View>
  );
}

export function ToolError({ message, hint }: { message: string; hint?: string }) {
  const { tokens } = useTheme();
  if (!message) return null;
  return (
    <View style={[styles.note, { backgroundColor: tokens.dangerSoft, borderColor: tokens.danger }]}>
      <AppIcon name="warning" size={18} color={tokens.danger} />
      <View style={styles.noteBody}>
        <Text accessibilityRole="alert" style={[styles.noteText, { color: tokens.danger }]}>
          {message}
        </Text>
        {hint ? <Text style={[styles.noteHint, { color: tokens.danger }]}>{hint}</Text> : null}
      </View>
    </View>
  );
}

export function ToolNote({
  text,
  tone = "info",
  icon,
}: {
  text: string;
  tone?: "info" | "warn" | "ok";
  icon?: IconName;
}) {
  const { tokens } = useTheme();
  const palette =
    tone === "warn"
      ? { bg: tokens.warnSoft, border: tokens.warn, text: tokens.warn, icon: "warning" as IconName }
      : tone === "ok"
        ? { bg: tokens.okSoft, border: tokens.ok, text: tokens.ok, icon: "success" as IconName }
        : { bg: tokens.accentSoft, border: tokens.accentSoft, text: tokens.accentText, icon: "info" as IconName };
  return (
    <View style={[styles.note, { backgroundColor: palette.bg, borderColor: palette.border }]}>
      <AppIcon name={icon ?? palette.icon} size={18} color={palette.text} />
      <Text style={[styles.noteText, { color: palette.text }]}>{text}</Text>
    </View>
  );
}

export function ToolResultCard({
  title,
  meta,
  actions,
  children,
}: {
  title: string;
  meta?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const { tokens } = useTheme();
  return (
    <View style={[styles.result, { backgroundColor: tokens.card, borderColor: tokens.cardBorder }]}>
      <View style={styles.resultHead}>
        <View style={styles.resultTitleWrap}>
          <Text style={[styles.resultTitle, { color: tokens.text }]} numberOfLines={1}>
            {title}
          </Text>
          {meta ? <Text style={[styles.resultMeta, { color: tokens.muted }]}>{meta}</Text> : null}
        </View>
        {actions ? <View style={styles.resultActions}>{actions}</View> : null}
      </View>
      {children}
    </View>
  );
}

export function ToolStat({ label, value, tone }: { label: string; value: string; tone?: "ok" | "danger" }) {
  const { tokens } = useTheme();
  return (
    <View style={styles.stat}>
      <Text style={[styles.statValue, { color: tone === "danger" ? tokens.danger : tokens.text }]}>
        {value}
      </Text>
      <Text style={[styles.statLabel, { color: tokens.muted }]}>{label}</Text>
    </View>
  );
}

export function ToolEmpty({ title, hint, icon = "inbox" }: { title: string; hint: string; icon?: IconName }) {
  const { tokens } = useTheme();
  return (
    <View style={styles.empty}>
      <View style={[styles.emptyIcon, { backgroundColor: tokens.tileBase, borderColor: tokens.tileBorder }]}>
        <AppIcon name={icon} size={26} color={tokens.accent} />
      </View>
      <Text style={[styles.emptyTitle, { color: tokens.text }]}>{title}</Text>
      <Text style={[styles.emptyHint, { color: tokens.muted }]}>{hint}</Text>
    </View>
  );
}

export function ToolDivider() {
  const { tokens } = useTheme();
  return <View style={[styles.divider, { backgroundColor: tokens.separator }]} />;
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  body: { flex: 1 },
  grow: { flexGrow: 1 },
  content: { paddingHorizontal: space.lg, paddingTop: space.md, gap: space.lg },
  subtitle: { fontSize: font.meta, lineHeight: 20, marginTop: -space.xs },
  footer: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
    gap: space.sm,
  },
  section: { gap: space.sm },
  sectionHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm },
  sectionTitle: { fontSize: font.section, fontWeight: "600", flexShrink: 1 },
  sectionHint: { fontSize: font.meta, lineHeight: 19 },
  sectionBody: { gap: space.sm },
  button: {
    minHeight: 44,
    borderRadius: radius.control,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: space.lg,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonCompact: { minHeight: 40, paddingHorizontal: space.md },
  buttonInner: { flexDirection: "row", alignItems: "center", gap: space.sm },
  buttonLabel: { fontSize: font.body, fontWeight: "600" },
  buttonLabelCompact: { fontSize: font.meta },
  iconButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  field: { gap: 6 },
  fieldHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm },
  fieldActions: { flexDirection: "row", alignItems: "center", gap: space.xs },
  fieldLabel: { fontSize: font.meta, fontWeight: "600" },
  input: {
    borderRadius: radius.control,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    fontSize: font.body,
    lineHeight: 20,
  },
  inputMultiline: { paddingTop: space.sm, paddingBottom: space.sm },
  mono: { fontFamily: MONO_FONT, fontSize: font.meta, lineHeight: 19 },
  fieldHint: { fontSize: font.label, lineHeight: 16 },
  note: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space.sm,
    padding: space.md,
    borderRadius: radius.control,
    borderWidth: StyleSheet.hairlineWidth,
  },
  noteBody: { flex: 1, gap: 2 },
  noteText: { flex: 1, fontSize: font.meta, lineHeight: 19 },
  noteHint: { fontSize: font.label, lineHeight: 16, opacity: 0.85 },
  result: {
    borderRadius: radius.card,
    borderWidth: StyleSheet.hairlineWidth,
    padding: space.md,
    gap: space.sm,
  },
  resultHead: { flexDirection: "row", alignItems: "center", gap: space.sm },
  resultTitleWrap: { flex: 1 },
  resultTitle: { fontSize: font.body, fontWeight: "600" },
  resultMeta: { fontSize: font.label, marginTop: 1 },
  resultActions: { flexDirection: "row", gap: space.xs },
  stat: { flex: 1, alignItems: "center", gap: 2 },
  statValue: { fontSize: font.section, fontWeight: "700", fontVariant: ["tabular-nums"] },
  statLabel: { fontSize: font.label },
  empty: { alignItems: "center", paddingVertical: space.xxl, gap: space.sm },
  emptyIcon: {
    width: 56,
    height: 56,
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
  },
  emptyTitle: { fontSize: font.title, fontWeight: "600" },
  emptyHint: { fontSize: font.meta, lineHeight: 19, textAlign: "center", maxWidth: 280 },
  divider: { height: StyleSheet.hairlineWidth, marginVertical: space.sm },
});
