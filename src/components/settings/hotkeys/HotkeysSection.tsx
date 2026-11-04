/**
 * 设置页「快捷键管理」区域。
 *
 * 挂载点见 `tmp/acceptance/custom-hotkeys/integration.md`（由集成会话接入
 * `SettingsPanel.tsx` 的「窗口与快捷键」分组，不新增顶级页面）。
 *
 * 行为约定：
 * - 应用内（app_local）与系统级（system_global）明确标注，绝不混称“全局快捷键”；
 * - 录制期间用捕获阶段监听并阻止原快捷键触发，Esc 取消；
 * - 只有后端返回 `ok=true` 才提示成功；注册/持久化/回滚失败原样展示原因。
 *
 * i18n：固定文案走 `hotkeys.*` 目录；动作名称按稳定 `action` 映射文案键，
 * 不直接展示后端返回的中文 `label`/`description`（未登记动作才回退后端文案）。
 * 后端错误串（注册失败原因、配置加载提示）无法本地化，原文展示并用
 * `hotkeys.loadError` / `hotkeys.toast.*` 包装以标明其为配置/后端来源。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Keyboard, RotateCcw } from "lucide-react";

import { ConfirmDialog, Switch } from "../../ui";
import { useHotkeysStore } from "../../../store/useHotkeysStore";
import { useUiStore } from "../../../store/useUiStore";
import { useLocale } from "../../../hooks/useLocale";
import type { MessageKey } from "../../../i18n";
import {
  acceleratorFromEvent,
  findConflictingBinding,
  isImeEvent,
  isModifierCode,
  isSupportedKeyCode,
  reservedReasonKey,
} from "./accelerator";
import type { HotkeyBindingView, HotkeyState } from "./types";

/** 稳定 action ID → 文案键片段（camelCase）；新增动作需同步两份 locales。 */
type ActionKeyBase =
  | "toggleMainWindow"
  | "openQuickCapture"
  | "quickAddTask"
  | "openClipboard"
  | "switchTabTasks"
  | "switchTabAgents"
  | "switchTabActions"
  | "switchTabClipboard"
  | "switchTabInbox"
  | "switchTabShelf"
  | "switchTabWorkflows"
  | "switchTabHistory"
  | "switchTabRoadmap"
  | "switchTabSettings";

const ACTION_KEY_BASE: Partial<Record<string, ActionKeyBase>> = {
  toggle_main_window: "toggleMainWindow",
  open_quick_capture: "openQuickCapture",
  quick_add_task: "quickAddTask",
  open_clipboard: "openClipboard",
  switch_tab_tasks: "switchTabTasks",
  switch_tab_agents: "switchTabAgents",
  switch_tab_actions: "switchTabActions",
  switch_tab_clipboard: "switchTabClipboard",
  switch_tab_inbox: "switchTabInbox",
  switch_tab_shelf: "switchTabShelf",
  switch_tab_workflows: "switchTabWorkflows",
  switch_tab_history: "switchTabHistory",
  switch_tab_roadmap: "switchTabRoadmap",
  switch_tab_settings: "switchTabSettings",
};

type Translate = (key: MessageKey) => string;

/** 动作名称按 ID 查目录；未登记动作回退后端文案，避免显示成裸 ID。 */
function actionLabel(t: Translate, action: string, fallback: string): string {
  const base = ACTION_KEY_BASE[action];
  return base ? t(`hotkeys.action.${base}.label`) : fallback;
}

function actionDescription(t: Translate, action: string, fallback: string): string {
  const base = ACTION_KEY_BASE[action];
  return base ? t(`hotkeys.action.${base}.description`) : fallback;
}

const STATE_COLOR: Record<HotkeyState, string> = {
  active: "var(--status-success)",
  disabled: "var(--text-tertiary)",
  conflict: "var(--status-error)",
  invalid: "var(--status-error)",
  unavailable: "var(--status-waiting)",
};

const CODE_STYLE = {
  fontFamily: "var(--font-mono, ui-monospace, monospace)",
  fontSize: "11px",
  padding: "2px 6px",
  borderRadius: "var(--radius-control)",
  border: "1px solid var(--border-subtle, var(--text-tertiary))",
  color: "var(--text-secondary)",
  whiteSpace: "nowrap" as const,
};

const HEAD_ROW_STYLE = {
  display: "flex",
  alignItems: "center",
  gap: "8px",
  flexWrap: "wrap" as const,
};

const ACTION_ROW_STYLE = {
  display: "flex",
  alignItems: "center",
  gap: "8px",
  flexWrap: "wrap" as const,
};

export default function HotkeysSection() {
  const { t } = useLocale();
  const bindings = useHotkeysStore((state) => state.bindings);
  const loadError = useHotkeysStore((state) => state.loadError);
  const loading = useHotkeysStore((state) => state.loading);
  const error = useHotkeysStore((state) => state.error);
  const recordingAction = useHotkeysStore((state) => state.recordingAction);
  const applyingAction = useHotkeysStore((state) => state.applyingAction);
  const rowErrors = useHotkeysStore((state) => state.rowErrors);
  const load = useHotkeysStore((state) => state.load);
  const change = useHotkeysStore((state) => state.change);
  const reset = useHotkeysStore((state) => state.reset);
  const startRecording = useHotkeysStore((state) => state.startRecording);
  const cancelRecording = useHotkeysStore((state) => state.cancelRecording);
  const showToast = useUiStore((state) => state.showToast);

  const [hint, setHint] = useState<string | null>(null);
  const [confirmResetAll, setConfirmResetAll] = useState(false);
  const requestedOnce = useRef(false);

  useEffect(() => {
    // 运行时会加载一次；这里仅在首次挂载且尚无数据时补一次，避免空列表反复请求。
    if (requestedOnce.current) return;
    requestedOnce.current = true;
    if (useHotkeysStore.getState().bindings.length === 0) void load();
  }, [load]);

  useEffect(() => {
    if (!recordingAction) setHint(null);
  }, [recordingAction]);

  // 卸载（例如离开设置页）时结束录制：否则残留的 recordingAction 会让
  // 应用内快捷键在本次会话剩余时间内全部失效且没有任何可见提示。
  useEffect(() => () => cancelRecording(), [cancelRecording]);

  const rows = bindings;

  const scopeLabel = (scope: HotkeyBindingView["scope"]) =>
    t(
      scope === "system_global"
        ? "hotkeys.scope.systemGlobal"
        : "hotkeys.scope.appLocal",
    );

  const stateLabel = (state: HotkeyState) => t(`hotkeys.state.${state}`);

  const commit = useCallback(
    async (
      action: string,
      options: { accelerator?: string; enabled?: boolean },
    ) => {
      const binding = useHotkeysStore
        .getState()
        .bindings.find((item) => item.action === action);
      const label = actionLabel(t, action, binding?.label ?? action);
      const outcome = await change(action, options);
      if (!outcome) {
        // IPC 层异常：具体原因已由 store 的 rowErrors / error 展示。
        showToast(t("hotkeys.toast.changeFailed", { label }), { kind: "error" });
        return;
      }
      if (!outcome.ok) {
        const rollbackNote =
          outcome.rolled_back && outcome.rollback_ok === false
            ? t("hotkeys.toast.rollbackFailed")
            : outcome.rolled_back && outcome.rollback_ok === true
              ? t("hotkeys.toast.rollbackOk")
              : "";
        showToast(
          t("hotkeys.toast.notChanged", {
            label,
            error: outcome.error ?? t("hotkeys.toast.unknownReason"),
            rollback: rollbackNote,
          }),
          { kind: outcome.error_kind === "occupied" ? "warning" : "error" },
        );
        return;
      }
      if (!outcome.persisted) return; // 组合与状态均未变化：不制造“已保存”的假象。
      if (options.enabled !== undefined) {
        showToast(
          t(
            options.enabled
              ? "hotkeys.toast.enabled"
              : "hotkeys.toast.disabled",
            { label },
          ),
          { kind: "success" },
        );
      } else {
        showToast(
          t("hotkeys.toast.updated", {
            label,
            accelerator: outcome.binding.accelerator,
          }),
          { kind: "success" },
        );
      }
    },
    [change, showToast, t],
  );

  const applyReset = useCallback(
    async (action?: string) => {
      const outcome = await reset(action);
      if (!outcome) {
        showToast(
          t(
            action
              ? "hotkeys.toast.resetOneFailed"
              : "hotkeys.toast.resetAllFailed",
          ),
          { kind: "error" },
        );
        return;
      }
      const failed = outcome.results.filter((result) => !result.ok);
      if (outcome.ok) {
        showToast(
          action
            ? t("hotkeys.toast.resetOne")
            : t("hotkeys.toast.resetAll", { count: outcome.results.length }),
          { kind: "success" },
        );
        return;
      }
      const first = failed[0];
      showToast(
        t("hotkeys.toast.partialReset", {
          error:
            first?.error ??
            outcome.error ??
            t("hotkeys.toast.unknownReason"),
        }),
        { kind: "warning" },
      );
    },
    [reset, showToast, t],
  );

  // 录制监听：捕获阶段最先执行，阻止原快捷键与页面其他处理。
  useEffect(() => {
    if (!recordingAction) return;
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();

      if (
        event.code === "Escape" &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.shiftKey &&
        !event.metaKey
      ) {
        cancelRecording();
        setHint(null);
        return;
      }
      if (event.repeat) return;
      if (isImeEvent(event)) {
        setHint(t("hotkeys.hint.ime"));
        return;
      }
      if (isModifierCode(event.code)) {
        setHint(t("hotkeys.hint.modifierOnly"));
        return;
      }
      if (!isSupportedKeyCode(event.code)) {
        setHint(t("hotkeys.hint.unsupported"));
        return;
      }
      const accelerator = acceleratorFromEvent(event);
      if (!accelerator) {
        setHint(t("hotkeys.hint.needModifier"));
        return;
      }
      const reasonKey = reservedReasonKey(accelerator);
      if (reasonKey) {
        setHint(
          t("hotkeys.hint.reserved", {
            accelerator,
            reason: t(reasonKey),
          }),
        );
        return;
      }
      const conflict = findConflictingBinding(
        useHotkeysStore.getState().bindings,
        recordingAction,
        accelerator,
      );
      if (conflict) {
        setHint(
          t("hotkeys.hint.conflict", {
            accelerator,
            label: actionLabel(t, conflict.action, conflict.label),
          }),
        );
        return;
      }
      const action = recordingAction;
      cancelRecording();
      setHint(null);
      void commit(action, { accelerator });
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [recordingAction, cancelRecording, commit, t]);

  return (
    <div className="hotkeys-section" data-testid="hotkeys-section">
      <div className="setting-row">
        <span>
          <Keyboard size={12} aria-hidden="true" /> {t("hotkeys.title")}
        </span>
        <button
          type="button"
          className="btn sm"
          aria-label={t("hotkeys.resetAllAria")}
          data-tip={t("hotkeys.resetAllTip")}
          disabled={applyingAction !== null || rows.length === 0}
          onClick={() => setConfirmResetAll(true)}
        >
          <RotateCcw size={12} aria-hidden="true" /> {t("hotkeys.resetAll")}
        </button>
      </div>
      <div className="setting-note">{t("hotkeys.note")}</div>

      {loadError && (
        <div className="setting-note" style={{ color: "var(--status-waiting)" }}>
          {t("hotkeys.loadError", { error: loadError })}
        </div>
      )}
      {error && (
        <div className="setting-note" style={{ color: "var(--status-error)" }}>
          {t("hotkeys.loadFailed", { error })}
        </div>
      )}

      {loading && rows.length === 0 && (
        <div className="setting-note">{t("hotkeys.loading")}</div>
      )}
      {!loading && rows.length === 0 && !error && (
        <div className="setting-note">{t("hotkeys.empty")}</div>
      )}

      {rows.map((binding) => {
        const recording = recordingAction === binding.action;
        const busy = applyingAction === binding.action;
        const rowError = rowErrors[binding.action];
        const editable = !recording && !busy;
        // 已启用且当前就是默认组合、状态正常时才无需重置；
        // 「冲突 / 未注册」时保留按钮，作为后端提示的「重新应用」入口。
        const resetNoop =
          binding.enabled &&
          binding.state === "active" &&
          binding.accelerator === binding.default_accelerator;
        const label = actionLabel(t, binding.action, binding.label);
        const description = actionDescription(
          t,
          binding.action,
          binding.description,
        );
        return (
          <div
            key={binding.action}
            className="setting-row setting-row-block"
            data-hotkey-action={binding.action}
          >
            <div style={HEAD_ROW_STYLE}>
              <span>{label}</span>
              <span className="chip">{scopeLabel(binding.scope)}</span>
              <span className="chip" style={{ color: STATE_COLOR[binding.state] }}>
                {stateLabel(binding.state)}
              </span>
            </div>
            <div style={ACTION_ROW_STYLE}>
              <code style={CODE_STYLE}>
                {recording ? t("hotkeys.recording") : binding.accelerator}
              </code>
              {recording ? (
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => cancelRecording()}
                  aria-label={t("hotkeys.cancelRecordAria", { label })}
                >
                  {t("common.cancel")}
                </button>
              ) : (
                <button
                  type="button"
                  className="btn sm"
                  disabled={!editable}
                  aria-label={t("hotkeys.editAria", { label })}
                  data-tip={t("hotkeys.editTip")}
                  onClick={() => startRecording(binding.action)}
                >
                  {t("hotkeys.edit")}
                </button>
              )}
              <button
                type="button"
                className="btn sm"
                disabled={busy || recording || resetNoop}
                aria-label={t("hotkeys.resetAria", { label })}
                data-tip={t("hotkeys.resetTip", {
                  accelerator: binding.default_accelerator,
                })}
                onClick={() => void applyReset(binding.action)}
              >
                {t("hotkeys.reset")}
              </button>
              <Switch
                checked={binding.enabled}
                disabled={busy || recording}
                ariaLabel={t("hotkeys.enableAria", { label })}
                onChange={(next) => void commit(binding.action, { enabled: next })}
              />
            </div>
            <div className="setting-note">{description}</div>
            {recording && (
              <div className="setting-note" style={{ color: "var(--status-running)" }}>
                {hint ?? t("hotkeys.recordingHint")}
              </div>
            )}
            {binding.message && (
              <div className="setting-note" style={{ color: "var(--status-error)" }}>
                {/* 后端注册失败原因无法本地化：保留原文并标注为配置提示。 */}
                {t("hotkeys.loadError", { error: binding.message })}
              </div>
            )}
            {rowError && rowError !== binding.message && (
              <div className="setting-note" style={{ color: "var(--status-error)" }}>
                {t("hotkeys.loadError", { error: rowError })}
              </div>
            )}
          </div>
        );
      })}

      <ConfirmDialog
        open={confirmResetAll}
        title={t("hotkeys.confirm.title")}
        detail={t("hotkeys.confirm.detail")}
        confirmLabel={t("hotkeys.confirm.ok")}
        busy={applyingAction === "all"}
        onCancel={() => setConfirmResetAll(false)}
        onConfirm={() => {
          setConfirmResetAll(false);
          void applyReset(undefined);
        }}
      />
    </div>
  );
}
