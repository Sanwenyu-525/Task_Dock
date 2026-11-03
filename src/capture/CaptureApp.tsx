//! 快速捕获窗口：640×360 液态玻璃卡片。
//! 只通过 src/lib/bridge.ts 的自定义命令/事件与后端交互；窗口显隐、焦点恢复
//! 都由后端负责，这里绝不直接调用 Tauri window API。

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent } from "react";
import { X } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import {
  getSettings,
  onCaptureFlushDraft,
  onQuickCaptureHidden,
  onQuickCaptureSummoned,
  quickCaptureHide,
  quickCaptureSaveDraft,
  quickCaptureSetLastType,
  quickCaptureState,
  quickCaptureSubmit,
  type CaptureKind,
} from "../lib/bridge";
import { createSubscriptionScope } from "../lib/subscriptions";
import { resolveSecondaryPreset, resolveTheme, resolveVisualPreset } from "../lib/theme";
import {
  CAPTURE_KIND_META,
  CAPTURE_KIND_ORDER,
  type CaptureFeedback,
} from "./captureTypes";
import {
  CONTENT_MAX,
  COUNTER_THRESHOLD,
  DRAFT_DEBOUNCE_MS,
  SUCCESS_HIDE_MS,
  composeSubmitInput,
  describeDraft,
  draftReducer,
  formatError,
  initialDraftState,
  newClientId,
  normalizeKind,
  suggestKind,
  validateCapture,
} from "./captureUtils";

/** 已落库的草稿快照：只用于「没有变化就不重复保存」的判断，绝不代替后端状态。 */
interface SavedDraftSnapshot {
  kind: CaptureKind;
  content: string;
}

export default function CaptureApp() {
  const [kind, setKind] = useState<CaptureKind>("task");
  const [content, setContent] = useState("");
  const [hydrated, setHydrated] = useState(false);
  const [feedback, setFeedback] = useState<CaptureFeedback | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [draft, dispatchDraft] = useReducer(draftReducer, initialDraftState);

  /** 最新输入：事件回调里同步读取，避免闭包读到旧值。 */
  const latestRef = useRef<{ kind: CaptureKind; content: string }>({ kind, content });
  latestRef.current = { kind, content };

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const chipRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const composingRef = useRef(false);
  const hydratedRef = useRef(false);
  const submitLockRef = useRef(false);
  const successRef = useRef(false);
  const clientIdRef = useRef(newClientId());
  const lastSavedRef = useRef<SavedDraftSnapshot | null>(null);
  const draftSeqRef = useRef(0);
  const savePromiseRef = useRef<Promise<void> | null>(null);
  const debounceRef = useRef<number | null>(null);
  const hideTimerRef = useRef<number | null>(null);

  const clearDebounce = useCallback(() => {
    if (debounceRef.current !== null) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
  }, []);
  const clearHideTimer = useCallback(() => {
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  }, []);

  const focusInput = useCallback(() => {
    window.requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      try {
        el.setSelectionRange(el.value.length, el.value.length);
      } catch {
        // 非文本控件兜底：焦点已设置即可
      }
    });
  }, []);

  /** 立即保存草稿（失焦/隐藏/退出/提交失败/类型切换共用）。 */
  const flushDraft = useCallback(
    async (nextKind?: CaptureKind, nextContent?: string): Promise<void> => {
      if (!hydratedRef.current) return;
      if (submitLockRef.current || successRef.current) return;
      const targetKind = nextKind ?? latestRef.current.kind;
      const rawContent = nextContent ?? latestRef.current.content;
      const trimmed = rawContent.trim();
      const saved = lastSavedRef.current;
      // 内容与类型都没变（且不是待重试的失败态）时跳过，避免重复 IPC
      if (saved && saved.kind === targetKind && saved.content === trimmed) return;
      const seq = ++draftSeqRef.current;
      dispatchDraft({ type: "saving" });
      const task = (async () => {
        try {
          const result = await quickCaptureSaveDraft(targetKind, rawContent);
          if (seq !== draftSeqRef.current) return; // 有更新的保存请求，旧结果作废
          lastSavedRef.current = { kind: targetKind, content: trimmed };
          dispatchDraft(
            trimmed === "" ? { type: "reset" } : { type: "saved", savedAt: result.saved_at },
          );
        } catch {
          if (seq !== draftSeqRef.current) return;
          dispatchDraft({ type: "failed" });
        }
      })();
      savePromiseRef.current = task;
      await task;
    },
    [],
  );

  /** 拉取草稿 + 上次类型；summoned 时恢复草稿并提示「已恢复草稿」。 */
  const applyState = useCallback(
    async (notify: boolean) => {
      clearDebounce();
      try {
        const state = await quickCaptureState();
        const lastKind = normalizeKind(state.last_type);
        if (state.draft) {
          const draftKind = normalizeKind(state.draft.kind, lastKind);
          setKind(draftKind);
          setContent(state.draft.content);
          latestRef.current = { kind: draftKind, content: state.draft.content };
          lastSavedRef.current = {
            kind: draftKind,
            content: state.draft.content.trim(),
          };
          dispatchDraft({ type: "reset" });
          if (notify) setFeedback({ tone: "info", message: "已恢复草稿" });
        } else if (!notify && latestRef.current.content.trim() === "") {
          // 首次挂载（窗口隐藏）只同步默认类型与空状态
          setKind(lastKind);
          latestRef.current = { kind: lastKind, content: "" };
          lastSavedRef.current = { kind: lastKind, content: "" };
          dispatchDraft({ type: "reset" });
        } else if (latestRef.current.content.trim() === "") {
          // 唤起但无草稿：采用 last_type；若残留未保存内容则原样保留
          setKind(lastKind);
          latestRef.current = { kind: lastKind, content: "" };
          lastSavedRef.current = { kind: lastKind, content: "" };
          dispatchDraft({ type: "reset" });
          setFeedback(null);
        }
      } catch {
        // 状态拉取失败不阻塞捕获：保留当前内容，允许继续输入/保存
        if (!hydratedRef.current) {
          lastSavedRef.current = {
            kind: latestRef.current.kind,
            content: latestRef.current.content.trim(),
          };
        }
      } finally {
        hydratedRef.current = true;
        setHydrated(true);
        focusInput();
      }
    },
    [clearDebounce, focusInput],
  );

  /** 切换类型：绝不改内容；有内容立即落草稿，空内容只记 last_type。 */
  const changeKind = useCallback(
    (next: CaptureKind) => {
      const current = latestRef.current;
      if (next === current.kind) return;
      setKind(next);
      latestRef.current = { ...current, kind: next };
      void quickCaptureSetLastType(next).catch(() => undefined);
      const hasContent = current.content.trim() !== "";
      const hasDraft = (lastSavedRef.current?.content ?? "") !== "";
      if (hasContent || hasDraft) {
        dispatchDraft({ type: "change" });
        void flushDraft(next, current.content);
      } else {
        lastSavedRef.current = { kind: next, content: "" };
        dispatchDraft({ type: "reset" });
      }
    },
    [flushDraft],
  );

  const submit = useCallback(async () => {
    if (submitLockRef.current || successRef.current) return;
    const current = latestRef.current;
    const validation = validateCapture(current.kind, current.content);
    if (validation) {
      setFeedback({ tone: "error", message: validation });
      focusInput();
      return;
    }
    submitLockRef.current = true;
    setSubmitting(true);
    setFeedback(null);
    clearDebounce();
    // 提交事务内后端会清空草稿：先等在途保存结束，避免「清空后又被写回」
    await savePromiseRef.current;
    try {
      const result = await quickCaptureSubmit(
        composeSubmitInput(current.kind, current.content, clientIdRef.current),
      );
      successRef.current = true;
      clientIdRef.current = newClientId(); // 成功才重置，失败重试复用同一个
      setContent("");
      latestRef.current = { kind: current.kind, content: "" };
      lastSavedRef.current = { kind: current.kind, content: "" };
      dispatchDraft({ type: "reset" });
      const target =
        result.kind === "task" || result.kind === "todo" ? "任务已创建" : "已加入收集箱";
      setFeedback({
        tone: "success",
        message: result.duplicate ? "已保存 · 重复提交已忽略" : `已保存 · ${target}`,
      });
      clearHideTimer();
      hideTimerRef.current = window.setTimeout(() => {
        hideTimerRef.current = null;
        void quickCaptureHide("success").catch(() => undefined);
      }, SUCCESS_HIDE_MS);
    } catch (error) {
      submitLockRef.current = false;
      setSubmitting(false);
      setFeedback({ tone: "error", message: `保存失败：${formatError(error)}` });
      void flushDraft(); // 失败立即落草稿，内容不丢
      focusInput();
    }
  }, [clearDebounce, clearHideTimer, flushDraft, focusInput]);

  const close = useCallback(() => {
    clearDebounce();
    clearHideTimer();
    void flushDraft();
    void quickCaptureHide("user").catch(() => undefined);
  }, [clearDebounce, clearHideTimer, flushDraft]);

  // 草稿防抖：内容/类型变化后 600ms 保存；与上次成功快照一致则不重复发请求。
  useEffect(() => {
    if (!hydrated) return;
    const saved = lastSavedRef.current;
    const trimmed = content.trim();
    if (saved && saved.kind === kind && saved.content === trimmed) return;
    dispatchDraft({ type: "change" });
    clearDebounce();
    debounceRef.current = window.setTimeout(() => {
      debounceRef.current = null;
      void flushDraft();
    }, DRAFT_DEBOUNCE_MS);
    return clearDebounce;
  }, [kind, content, hydrated, clearDebounce, flushDraft]);

  // 挂载：同步 last_type / 草稿（窗口静态常驻，启动即加载）
  useEffect(() => {
    void applyState(false);
  }, [applyState]);

  // 订阅：唤起 / 隐藏 / 退出前 flush
  useEffect(() => {
    const scope = createSubscriptionScope();
    scope.add(
      onQuickCaptureSummoned(() => {
        clearHideTimer();
        submitLockRef.current = false;
        successRef.current = false;
        setSubmitting(false);
        void applyState(true);
      }),
    );
    scope.add(onQuickCaptureHidden(() => void flushDraft()));
    scope.add(onCaptureFlushDraft(() => void flushDraft()));
    return () => scope.dispose();
  }, [applyState, clearHideTimer, flushDraft]);

  // 失焦 / 页面隐藏：立即 flush（桌面窗口被抢焦点时也要落盘）
  useEffect(() => {
    const onBlur = () => {
      clearDebounce();
      void flushDraft();
    };
    const onVisibility = () => {
      if (document.visibilityState !== "hidden") return;
      clearDebounce();
      void flushDraft();
    };
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [clearDebounce, flushDraft]);

  // 键盘：Ctrl+Enter 提交 / Esc 关闭；IME 组合输入中一律让输入法先行。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const composing =
        event.isComposing || composingRef.current || (event as KeyboardEvent).keyCode === 229;
      if (composing) return;
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        void submit();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [close, submit]);

  // 卸载：清理定时器（订阅由 scope.dispose 负责）
  useEffect(
    () => () => {
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
      if (hideTimerRef.current !== null) window.clearTimeout(hideTimerRef.current);
    },
    [],
  );

  // 主题：与通知窗口同一套事实来源（设置快照 + 主题/预设事件 + 系统明暗兜底）
  const [prefersDark, setPrefersDark] = useState(
    () => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false,
  );
  const [snapshot, setSnapshot] = useState<{ theme: string; visualPreset: string } | null>(
    null,
  );
  useEffect(() => {
    void getSettings()
      .then((settings) =>
        setSnapshot({ theme: settings.theme, visualPreset: settings.visual_preset ?? "" }),
      )
      .catch(() => {
        // 快照缺失时按系统明暗渲染，不阻塞捕获
      });
    const scope = createSubscriptionScope();
    scope.add(
      listen<string>("theme-changed", (event) =>
        setSnapshot((current) => (current ? { ...current, theme: event.payload } : current)),
      ),
    );
    scope.add(
      listen<string>("visual-preset-changed", (event) =>
        setSnapshot((current) =>
          current ? { ...current, visualPreset: event.payload } : current,
        ),
      ),
    );
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    const onSystemTheme = (event: MediaQueryListEvent) => setPrefersDark(event.matches);
    media?.addEventListener("change", onSystemTheme);
    return () => {
      scope.dispose();
      media?.removeEventListener("change", onSystemTheme);
    };
  }, []);
  useEffect(() => {
    const root = document.documentElement;
    if (snapshot?.visualPreset) {
      // 截图浮窗需要稳定的不透明底，不套用清透玻璃的全透明窗口策略。
      root.dataset.preset = resolveSecondaryPreset(resolveVisualPreset(snapshot.visualPreset));
    }
    root.dataset.theme = resolveTheme(snapshot?.theme ?? "system", { prefersDark });
  }, [snapshot, prefersDark]);

  const suggestion = useMemo(() => {
    const suggested = suggestKind(content);
    return suggested && suggested !== kind ? suggested : null;
  }, [content, kind]);

  const showCounter = content.length > COUNTER_THRESHOLD;
  const trimmedEmpty = content.trim() === "";
  const draftLabel = describeDraft(draft);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    void submit();
  };

  const handleKindKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const index = CAPTURE_KIND_ORDER.indexOf(kind);
    let nextIndex: number;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        nextIndex = (index + 1) % CAPTURE_KIND_ORDER.length;
        break;
      case "ArrowLeft":
      case "ArrowUp":
        nextIndex = (index - 1 + CAPTURE_KIND_ORDER.length) % CAPTURE_KIND_ORDER.length;
        break;
      case "Home":
        nextIndex = 0;
        break;
      case "End":
        nextIndex = CAPTURE_KIND_ORDER.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    chipRefs.current[nextIndex]?.focus();
    changeKind(CAPTURE_KIND_ORDER[nextIndex]);
  };

  return (
    <div className="capture-shell">
      <div className="capture-card">
        <header className="capture-head">
          <h1 className="capture-title">快速捕获</h1>
          <span className="capture-kind-tag">{CAPTURE_KIND_META[kind].label}</span>
          <span className="capture-spacer" />
          <button
            type="button"
            className="capture-close"
            aria-label="关闭快速捕获"
            data-tip="关闭（Esc）"
            onClick={close}
          >
            <X size={14} />
          </button>
        </header>

        <form className="capture-form" onSubmit={handleSubmit}>
          <div className="capture-input-wrap">
            <textarea
              id="capture-input"
              ref={textareaRef}
              className="capture-input"
              aria-label="捕获内容"
              aria-describedby="capture-feedback"
              aria-invalid={feedback?.tone === "error"}
              placeholder={CAPTURE_KIND_META[kind].placeholder}
              maxLength={CONTENT_MAX}
              rows={4}
              value={content}
              onChange={(event) => setContent(event.target.value)}
              onCompositionStart={() => {
                composingRef.current = true;
              }}
              onCompositionEnd={() => {
                composingRef.current = false;
              }}
            />
            {showCounter && (
              <span className="capture-counter">
                {content.length} / {CONTENT_MAX}
              </span>
            )}
          </div>

          <div className="capture-aux">
            <p
              id="capture-feedback"
              className={`capture-feedback${feedback ? ` tone-${feedback.tone}` : ""}`}
              role={feedback?.tone === "error" ? "alert" : "status"}
              aria-live={feedback?.tone === "error" ? "assertive" : "polite"}
            >
              {feedback?.message ?? ""}
            </p>
            {suggestion && (
              <button
                type="button"
                className="capture-suggest"
                data-tip="只切换类型，不改动已输入内容"
                onClick={() => changeKind(suggestion)}
              >
                建议：{CAPTURE_KIND_META[suggestion].label}
              </button>
            )}
          </div>

          <div
            className="capture-kinds"
            role="radiogroup"
            aria-label="捕获类型"
            onKeyDown={handleKindKeyDown}
          >
            {CAPTURE_KIND_ORDER.map((option, index) => {
              const active = option === kind;
              return (
                <button
                  key={option}
                  ref={(el) => {
                    chipRefs.current[index] = el;
                  }}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  aria-label={CAPTURE_KIND_META[option].ariaLabel}
                  tabIndex={active ? 0 : -1}
                  className={`capture-kind${active ? " is-active" : ""}`}
                  onClick={() => changeKind(option)}
                >
                  {CAPTURE_KIND_META[option].label}
                </button>
              );
            })}
          </div>

          <footer className="capture-foot">
            <div className="capture-status">
              {draft.status === "error" ? (
                <button
                  type="button"
                  className="capture-draft is-error"
                  data-tip="立即重试保存草稿"
                  onClick={() => {
                    clearDebounce();
                    void flushDraft();
                  }}
                >
                  保存失败，点击重试
                </button>
              ) : (
                <span className="capture-draft" aria-live="polite">
                  {draftLabel}
                </span>
              )}
            </div>
            <span className="capture-hint" id="capture-hint">
              Ctrl+Enter 保存 · Esc 关闭
            </span>
            <button
              type="submit"
              className="capture-submit"
              disabled={submitting || trimmedEmpty}
              aria-describedby="capture-hint"
            >
              {submitting ? "保存中…" : "保存"}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}
