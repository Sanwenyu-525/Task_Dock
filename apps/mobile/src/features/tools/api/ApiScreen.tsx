// API 调试（离线请求工作台）：编辑请求、cURL 导入导出、历史与响应粘贴查看。
//
// 安全边界（本页不会发出任何网络请求）：
// - 真实发送被**明确禁用**：通用互联网 HTTPS 客户端尚未完成独立网络安全设计评审，
//   不能拿配对/同步的 secure-http（无指纹首发的 TOFU 模式）当第三方 API 校验；
// - 因此页面里没有 fetch / XMLHttpRequest / secure-http 调用，只做纯本地编辑与校验；
// - 敏感 Header（Authorization/Cookie/Token 等）在保存历史前由仓储统一脱敏，
//   密钥不会以明文进入请求历史；
// - 「响应查看」只接受用户手动粘贴的文本，不冒充真实响应。
import { useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { ActionSheet } from "../../../components/ActionSheet";
import { BottomSheet } from "../../../components/BottomSheet";
import { Chip } from "../../../components/Chip";
import { AppIcon } from "../../../components/icons/AppIcon";
import { SegmentedControl } from "../../../components/SegmentedControl";
import { useToast } from "../../../feedback/ToastProvider";
import {
  HTTP_METHODS,
  buildUrl,
  cloneDraft,
  emptyDraft,
  isSensitiveHeader,
  maskHeaderValue,
  newRow,
  normalizeBody,
  summarizeDraft,
  toCurl,
  validateDraft,
  type BodyKind,
  type HttpMethod,
  type RequestDraft,
} from "../../../domain/tools/apiRequest";
import { parseCurl } from "../../../domain/tools/curl";
import { formatJson, parseJson } from "../../../domain/tools/jsonTools";
import {
  clearHistory,
  deleteRequest,
  listRequests,
  saveRequest,
  touchRequestUse,
  type RequestRecord,
} from "../../../db/toolRequests";
import { recordToolUse } from "../../../db/toolUsage";
import { describeError } from "../../../lib/errors";
import { formatDateTime } from "../../../lib/format";
import { useTheme } from "../../../theme/ThemeProvider";
import { font, space } from "../../../theme/tokens";
import {
  readClipboard,
  shareOutText,
  writeClipboard,
  writeToolTextFile,
} from "../shared/nativeTools";
import { saveTextFileToDownloads } from "../shared/saveOutput";
import { ToolButton, ToolField, ToolNote, ToolScreen, ToolSection, ToolTextArea } from "../shared/ToolUI";

const TOOL_ID = "tool.api";

export function ApiScreen({ onBack }: { onBack: () => void }) {
  const { tokens } = useTheme();
  const { showToast } = useToast();

  const [draft, setDraft] = useState<RequestDraft>(() => emptyDraft());
  const [saved, setSaved] = useState<RequestRecord[]>([]);
  const [history, setHistory] = useState<RequestRecord[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [curlOpen, setCurlOpen] = useState(false);
  const [curlText, setCurlText] = useState("");
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [busy, setBusy] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<RequestRecord | null>(null);

  const [statusCode, setStatusCode] = useState("");
  const [rawResponse, setRawResponse] = useState("");
  const [responseView, setResponseView] = useState<"pretty" | "raw">("pretty");

  useEffect(() => {
    void recordToolUse(TOOL_ID);
    void reload();
  }, []);

  async function reload() {
    try {
      const [savedList, historyList] = await Promise.all([listRequests("saved"), listRequests("history")]);
      setSaved(savedList);
      setHistory(historyList);
    } catch (loadError) {
      setError(`读取请求历史失败：${describeError(loadError)}`);
    }
  }

  const patch = (changes: Partial<RequestDraft>) => {
    setDraft((current) => ({ ...current, ...changes }));
    setError("");
    setNotice("");
  };

  const urlCheck = useMemo(() => buildUrl(draft.url, draft.query), [draft.query, draft.url]);
  const bodyCheck = useMemo(() => normalizeBody(draft), [draft]);
  const curlTextOut = useMemo(() => toCurl(draft), [draft]);

  const validate = () => {
    const result = validateDraft(draft);
    if (!result.ok) {
      setError(result.message);
      setNotice("");
      return;
    }
    if (!result.secure) {
      setError("URL 使用明文 http：按安全规则不能作为可发送请求，请改用 https");
      return;
    }
    if (!bodyCheck.ok) {
      setError(bodyCheck.message);
      return;
    }
    setError("");
    setNotice(`请求结构有效：${result.url}${bodyCheck.contentType ? ` · ${bodyCheck.contentType}` : ""}`);
  };

  const copyCurl = async () => {
    try {
      await writeClipboard(curlTextOut);
      showToast("cURL 已复制", "success");
    } catch (copyError) {
      showToast(describeError(copyError), "danger");
    }
  };

  const importCurl = () => {
    const result = parseCurl(curlText);
    if (!result.ok) {
      showToast(result.message, "danger");
      return;
    }
    setDraft(result.draft);
    setCurlOpen(false);
    setError("");
    setNotice(
      result.warnings.length > 0 ? `已导入 cURL；${result.warnings.join("；")}` : "已导入 cURL，请核对 URL 与 Header",
    );
  };

  const openSave = () => {
    const result = validateDraft(draft);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setSaveName(draft.url ? summarizeDraft(draft) : "");
    setSaveOpen(true);
  };

  const persist = async (kind: "saved" | "history") => {
    setBusy(true);
    try {
      await saveRequest(kind, draft, { name: kind === "saved" ? saveName.trim() : "" });
      showToast(kind === "saved" ? "请求已收藏（敏感 Header 已脱敏）" : "已写入请求历史", "success");
      setSaveOpen(false);
      await reload();
    } catch (saveError) {
      showToast(`保存失败：${describeError(saveError)}`, "danger");
    } finally {
      setBusy(false);
    }
  };

  const loadRecord = async (record: RequestRecord) => {
    setDraft(cloneDraft(record.draft));
    setError("");
    setNotice(
      record.draft.headers.some((row) => isSensitiveHeader(row.name) && row.value.startsWith("••••"))
        ? "已载入历史请求；敏感 Header 已脱敏，真实发送前需要重新填写（本版不发送）"
        : "已载入历史请求",
    );
    try {
      await touchRequestUse(record.id);
    } catch {
      // 使用时间更新失败不影响编辑
    }
  };

  const removeRecord = async (record: RequestRecord) => {
    try {
      await deleteRequest(record.id);
      setDeleteTarget(null);
      await reload();
      showToast("已删除", "success");
    } catch (deleteError) {
      showToast(describeError(deleteError), "danger");
    }
  };

  const clearAllHistory = async () => {
    try {
      await clearHistory();
      await reload();
      showToast("请求历史已清空", "success");
    } catch (clearError) {
      showToast(describeError(clearError), "danger");
    }
  };

  const pasteResponse = async () => {
    try {
      const text = await readClipboard();
      if (!text) {
        showToast("剪贴板为空", "info");
        return;
      }
      setRawResponse(text);
    } catch (pasteError) {
      showToast(describeError(pasteError), "danger");
    }
  };

  const formattedResponse = useMemo(() => {
    if (!rawResponse.trim()) return "";
    if (responseView === "raw") return rawResponse;
    const parsed = parseJson(rawResponse);
    if (!parsed.ok) return "";
    return formatJson(parsed.ast, 2);
  }, [rawResponse, responseView]);

  const responseInvalid = responseView === "pretty" && rawResponse.trim().length > 0 && formattedResponse === "";

  const copyResponse = async () => {
    const text = responseView === "pretty" ? formattedResponse || rawResponse : rawResponse;
    if (!text) return;
    try {
      await writeClipboard(text);
      showToast("响应文本已复制", "success");
    } catch (copyError) {
      showToast(describeError(copyError), "danger");
    }
  };

  const saveResponse = async () => {
    const text = responseView === "pretty" ? formattedResponse || rawResponse : rawResponse;
    if (!text) return;
    try {
      const name = `response-${Date.now()}.${responseView === "pretty" ? "json" : "txt"}`;
      const file = writeToolTextFile(name, text);
      const savedFile = await saveTextFileToDownloads(file.uri, name);
      showToast(`已保存到下载目录：${savedFile.displayName}`, "success");
    } catch (saveError) {
      showToast(`保存失败：${describeError(saveError)}`, "danger");
    }
  };

  const headerHint = draft.headers.some((row) => row.name.trim() && isSensitiveHeader(row.name))
    ? "检测到敏感 Header：保存历史时会自动脱敏，不会写入明文密钥"
    : undefined;

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <ToolScreen
        title="API 调试"
        subtitle="离线请求工作台 · 真实发送未开放"
        onBack={onBack}
        footer={
          <View style={styles.footerRow}>
            <ToolButton
              label="发送（未开放）"
              tone="secondary"
              icon="lock"
              disabled
              onPress={() => undefined}
              style={styles.footerPrimary}
            />
            <ToolButton label="校验" icon="shield" onPress={validate} />
            <ToolButton label="复制 cURL" icon="copy" onPress={() => void copyCurl()} />
          </View>
        }
      >
        <ToolNote
          tone="warn"
          text="真实发送已阻塞：通用互联网 HTTPS 客户端需要独立网络安全设计评审（证书链/主机名校验、重定向、响应体上限、密钥不入历史）。本页不会发出任何网络请求。"
        />

        <ToolSection title="请求">
          <View style={styles.methodRow}>
            {HTTP_METHODS.map((method) => (
              <Chip
                key={method}
                label={method}
                active={draft.method === method}
                onPress={() => patch({ method: method as HttpMethod })}
                variant="soft"
              />
            ))}
          </View>
          <ToolField
            label="URL"
            value={draft.url}
            onChangeText={(url) => patch({ url })}
            placeholder="https://api.example.com/v1/items"
            autoCapitalize="none"
            hint={urlCheck.ok ? `最终 URL：${urlCheck.url}${urlCheck.secure ? "" : "（明文 http，发送会被禁止）"}` : urlCheck.message}
          />
          {!urlCheck.ok && draft.url.trim() ? <ToolNote text={urlCheck.message} tone="warn" /> : null}
        </ToolSection>

        <ToolSection title="Query Parameters">
          <RowsEditor
            rows={draft.query}
            onChange={(query) => patch({ query })}
            prefix="query"
            emptyHint="没有查询参数。点「添加一行」新增。"
          />
          <ToolButton label="添加一行" icon="add" compact onPress={() => patch({ query: [...draft.query, newRow("query")] })} />
        </ToolSection>

        <ToolSection title="Headers" hint={headerHint}>
          <RowsEditor
            rows={draft.headers}
            onChange={(headers) => patch({ headers })}
            prefix="header"
            sensitive
            emptyHint="没有自定义 Header。默认不添加任何 Header。"
          />
          <ToolButton label="添加一行" icon="add" compact onPress={() => patch({ headers: [...draft.headers, newRow("header")] })} />
        </ToolSection>

        <ToolSection title="请求体">
          <SegmentedControl
            options={[
              { value: "none", label: "无" },
              { value: "json", label: "JSON" },
              { value: "text", label: "文本" },
            ]}
            value={draft.bodyKind}
            onChange={(next) => patch({ bodyKind: next as BodyKind })}
            accessibilityLabel="请求体类型"
            size="compact"
          />
          {draft.bodyKind !== "none" ? (
            <>
              <ToolTextArea
                label="Body"
                value={draft.body}
                onChangeText={(body) => patch({ body })}
                placeholder={draft.bodyKind === "json" ? '{"name": "taskdock"}' : "纯文本请求体"}
                height={180}
                mono
              />
              {draft.method === "GET" || draft.method === "DELETE" ? (
                <ToolNote text={`${draft.method} 请求不会携带请求体（与 HTTP 语义一致）。`} tone="warn" />
              ) : null}
            </>
          ) : (
            <ToolNote text="当前请求没有请求体。" />
          )}
        </ToolSection>

        <ToolSection title="预览">
          <ToolNote text={`${draft.method} ${urlCheck.ok ? urlCheck.url : draft.url || "（未填写 URL）"}`} />
          <View style={styles.actionRow}>
            <ToolButton label="校验请求" icon="shield" onPress={validate} />
            <ToolButton label="收藏请求" icon="star" onPress={openSave} disabled={busy} />
            <ToolButton label="写入历史" icon="archive" onPress={() => void persist("history")} disabled={busy} />
            <ToolButton label="导入 cURL" icon="download" onPress={() => setCurlOpen(true)} />
          </View>
          {error ? <ToolNote text={error} tone="warn" /> : null}
          {notice ? <ToolNote text={notice} tone="ok" /> : null}
        </ToolSection>

        {(saved.length > 0 || history.length > 0) ? (
          <ToolSection
            title="请求历史"
            hint="收藏与历史都只在本机；敏感 Header 已脱敏，不保存明文密钥"
            right={
              history.length > 0 ? (
                <ToolButton compact label="清空历史" tone="danger" onPress={() => void clearAllHistory()} />
              ) : undefined
            }
          >
            {saved.map((record) => (
              <RequestRow
                key={record.id}
                record={record}
                badge="收藏"
                onOpen={() => void loadRecord(record)}
                onDelete={() => setDeleteTarget(record)}
              />
            ))}
            {history.map((record) => (
              <RequestRow
                key={record.id}
                record={record}
                badge="历史"
                onOpen={() => void loadRecord(record)}
                onDelete={() => setDeleteTarget(record)}
              />
            ))}
          </ToolSection>
        ) : (
          <ToolNote text="还没有请求记录。收藏或写入历史后会显示在这里（本机 SQLite）。" />
        )}

        <ToolSection title="响应查看（手动粘贴）" hint="这里的内容由你粘贴，不是本应用发出的响应">
          <View style={styles.responseHead}>
            <ToolField
              label="状态码（可选）"
              value={statusCode}
              onChangeText={setStatusCode}
              placeholder="200"
              keyboardType="numeric"
            />
            <SegmentedControl
              options={[
                { value: "pretty", label: "JSON 格式化" },
                { value: "raw", label: "原始" },
              ]}
              value={responseView}
              onChange={(next) => setResponseView(next as "pretty" | "raw")}
              accessibilityLabel="响应查看模式"
              size="compact"
            />
          </View>
          <ToolTextArea
            label="响应正文"
            value={rawResponse}
            onChangeText={(value) => {
              setRawResponse(value);
            }}
            placeholder="从浏览器/命令行复制响应正文粘贴到这里…"
            height={180}
            mono
            actions={
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="从剪贴板粘贴响应"
                onPress={() => void pasteResponse()}
                style={({ pressed }) => [styles.inlineAction, { opacity: pressed ? 0.6 : 1 }]}
              >
                <AppIcon name="clipboard" size={16} color={tokens.textSoft} />
                <Text style={[styles.inlineText, { color: tokens.textSoft }]}>粘贴</Text>
              </Pressable>
            }
          />
          {responseInvalid ? (
            <ToolNote text="这段内容不是合法 JSON；切到「原始」可原样查看。" tone="warn" />
          ) : null}
          {rawResponse.trim() && !responseInvalid ? (
            <View style={styles.actionRow}>
              <Text style={[styles.responseMeta, { color: tokens.muted }]}>
                {statusCode ? `状态码 ${statusCode} · ` : ""}
                {rawResponse.length} 字符
              </Text>
              <ToolButton compact label="复制" icon="copy" onPress={() => void copyResponse()} />
              <ToolButton compact label="保存" icon="download" onPress={() => void saveResponse()} />
              <ToolButton compact label="分享" icon="share" onPress={() => void shareOutText(formattedResponse || rawResponse, "API 响应")} />
            </View>
          ) : null}
        </ToolSection>

        <ToolNote text="请求定义保存在本机 tool_requests 表；临时响应不写入数据库。配对与设备同步使用独立的 TLS 通道，本页不会触碰它。" />
      </ToolScreen>

      <BottomSheet
        visible={curlOpen}
        onRequestClose={() => setCurlOpen(false)}
        accessibilityLabel="导入 cURL"
        keyboardAware
        maxHeightRatio={0.8}
      >
        <View style={styles.sheetBody}>
          <Text style={[styles.sheetTitle, { color: tokens.text }]}>导入 cURL</Text>
          <Text style={[styles.sheetHint, { color: tokens.muted }]}>
            支持 -X / -H / -d / --json / -G / -u / -A / -b / -e / -m / -o；-F 与 -T 会被拒绝。
          </Text>
          <ToolTextArea
            label="命令"
            value={curlText}
            onChangeText={setCurlText}
            placeholder="curl 'https://api.example.com/v1/items' -H 'Accept: application/json'"
            height={200}
            mono
          />
          <View style={styles.actionRow}>
            <ToolButton label="导入" tone="primary" icon="check" onPress={importCurl} />
            <ToolButton label="取消" onPress={() => setCurlOpen(false)} />
          </View>
        </View>
      </BottomSheet>

      <BottomSheet
        visible={saveOpen}
        onRequestClose={() => setSaveOpen(false)}
        accessibilityLabel="收藏请求"
        keyboardAware
      >
        <View style={styles.sheetBody}>
          <Text style={[styles.sheetTitle, { color: tokens.text }]}>收藏请求</Text>
          <ToolField label="名称" value={saveName} onChangeText={setSaveName} placeholder="例如 获取用户列表" maxLength={80} />
          <ToolNote text="保存前会自动脱敏 Authorization、Cookie、Token 等敏感 Header。" />
          <View style={styles.actionRow}>
            <ToolButton label="保存" tone="primary" icon="check" onPress={() => void persist("saved")} disabled={busy} />
            <ToolButton label="取消" onPress={() => setSaveOpen(false)} />
          </View>
        </View>
      </BottomSheet>

      <ActionSheet
        visible={deleteTarget !== null}
        title={deleteTarget ? `删除「${deleteTarget.name || summarizeDraft(deleteTarget.draft)}」？` : "删除请求记录？"}
        subtitle="只删除本机记录，不影响任何服务器"
        entityLabel="请求记录"
        actions={[
          { key: "cancel", label: "取消" },
          { key: "delete", label: "删除", tone: "danger", icon: "delete" },
        ]}
        onAction={(key) => {
          if (key === "delete" && deleteTarget) void removeRecord(deleteTarget);
          else setDeleteTarget(null);
        }}
        onRequestClose={() => setDeleteTarget(null)}
      />
    </View>
  );
}

function RowsEditor({
  rows,
  onChange,
  prefix,
  sensitive = false,
  emptyHint,
}: {
  rows: RequestDraft["query"];
  onChange: (rows: RequestDraft["query"]) => void;
  prefix: string;
  sensitive?: boolean;
  emptyHint: string;
}) {
  const { tokens } = useTheme();
  if (rows.length === 0) {
    return <Text style={[styles.emptyHint, { color: tokens.muted }]}>{emptyHint}</Text>;
  }
  const update = (id: string, patchRow: Partial<(typeof rows)[number]>) => {
    onChange(rows.map((row) => (row.id === id ? { ...row, ...patchRow } : row)));
  };
  return (
    <View style={styles.rows}>
      {rows.map((row) => (
        <View key={row.id} style={styles.rowLine}>
          <Pressable
            accessibilityRole="checkbox"
            accessibilityState={{ checked: row.enabled }}
            accessibilityLabel="启用这一行"
            onPress={() => update(row.id, { enabled: !row.enabled })}
            style={styles.rowToggle}
          >
            <View
              style={[
                styles.checkBox,
                {
                  borderColor: row.enabled ? tokens.accent : tokens.cardBorderStrong,
                  backgroundColor: row.enabled ? tokens.accentSoft : "transparent",
                },
              ]}
            >
              {row.enabled ? <AppIcon name="check" size={12} color={tokens.accent} /> : null}
            </View>
          </Pressable>
          <View style={styles.rowFields}>
            <ToolField
              label="Key"
              value={row.name}
              onChangeText={(name) => update(row.id, { name })}
              placeholder={prefix === "query" ? "page" : "Accept"}
              mono
              maxLength={120}
            />
            <ToolField
              label={sensitive && isSensitiveHeader(row.name) ? "Value（敏感，保存时脱敏）" : "Value"}
              value={row.value}
              onChangeText={(value) => update(row.id, { value })}
              placeholder={prefix === "query" ? "1" : "application/json"}
              mono
              maxLength={2048}
            />
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="删除这一行"
            onPress={() => onChange(rows.filter((entry) => entry.id !== row.id))}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            style={styles.rowRemove}
          >
            <AppIcon name="delete" size={18} color={tokens.muted} />
          </Pressable>
        </View>
      ))}
      {rows.some((row) => row.name.trim() && isSensitiveHeader(row.name)) ? (
        <Text style={[styles.emptyHint, { color: tokens.muted }]}>
          敏感 Header 值会在保存历史时替换为 {maskHeaderValue("secret")} 形式。
        </Text>
      ) : null}
    </View>
  );
}

function RequestRow({
  record,
  badge,
  onOpen,
  onDelete,
}: {
  record: RequestRecord;
  badge: string;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const { tokens } = useTheme();
  return (
    <View style={[styles.recordRow, { borderColor: tokens.separator }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`加载 ${record.name || summarizeDraft(record.draft)}`}
        onPress={onOpen}
        style={({ pressed }) => [styles.recordBody, { opacity: pressed ? 0.7 : 1 }]}
      >
        <View style={styles.recordTitleLine}>
          <Text style={[styles.recordBadge, { color: badge === "收藏" ? tokens.accent : tokens.muted }]}>
            {badge}
          </Text>
          <Text style={[styles.recordTitle, { color: tokens.text }]} numberOfLines={1}>
            {record.name || summarizeDraft(record.draft)}
          </Text>
        </View>
        <Text style={[styles.recordMeta, { color: tokens.muted }]} numberOfLines={1}>
          {summarizeDraft(record.draft)} · {formatDateTime(record.updatedAt)}
        </Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="删除请求记录"
        onPress={onDelete}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        style={styles.rowRemove}
      >
        <AppIcon name="delete" size={18} color={tokens.muted} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  footerRow: { flexDirection: "row", gap: space.sm },
  footerPrimary: { flex: 1 },
  methodRow: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  actionRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm },
  rows: { gap: space.sm },
  rowLine: { flexDirection: "row", alignItems: "flex-end", gap: space.xs },
  rowToggle: { width: 32, height: 44, alignItems: "center", justifyContent: "center" },
  rowFields: { flex: 1, flexDirection: "row", gap: space.xs, minWidth: 0 },
  rowRemove: { width: 36, height: 44, alignItems: "center", justifyContent: "center" },
  checkBox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  emptyHint: { fontSize: font.label, lineHeight: 18 },
  inlineAction: { flexDirection: "row", alignItems: "center", gap: space.xs, minHeight: 32 },
  inlineText: { fontSize: font.label, fontWeight: "600" },
  recordRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.xs,
    paddingVertical: space.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  recordBody: { flex: 1, gap: 1, minWidth: 0 },
  recordTitleLine: { flexDirection: "row", alignItems: "center", gap: space.xs },
  recordBadge: { fontSize: 10, fontWeight: "700" },
  recordTitle: { fontSize: font.meta, fontWeight: "600", flexShrink: 1 },
  recordMeta: { fontSize: font.label },
  responseHead: { flexDirection: "row", alignItems: "flex-start", gap: space.sm },
  responseMeta: { fontSize: font.label, flex: 1 },
  sheetBody: { paddingHorizontal: space.lg, paddingBottom: space.lg, gap: space.sm },
  sheetTitle: { fontSize: font.section, fontWeight: "700" },
  sheetHint: { fontSize: font.label, lineHeight: 18 },
});
