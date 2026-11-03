//! 通知窗口根组件：独立透明 Tauri 窗口（notification.html）的入口与生命周期。
//!
//! - **状态源**：后端 `notification-show` 事件（结构化卡片载荷）；无轮询，
//!   队列上限/合并/关键卡保护由 notificationUtils 纯逻辑承担；
//! - **主题**：与 ContextMenuApp 同一套解析（get_settings 快照 +
//!   theme-changed 订阅 + 系统明暗跟随），落 html[data-theme][data-preset]；
//! - **尺寸**：内容变化后回传实测高度（fit_notification_window），
//!   后端收放窗口并保持右下角锚点；队列为空时隐藏窗口（WebView 常驻复用）；
//! - **动作**：只有用户点击才允许激活主窗口/跳转（notification_navigate、
//!   open_agent_session）；失败给卡内 role=alert 反馈，不虚假成功；
//! - **退出清理**：订阅经 SubscriptionScope、离场定时器统一登记并在卸载释放。

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getSettings } from "../lib/bridge";
import { createSubscriptionScope } from "../lib/subscriptions";
import { resolveTheme, resolveVisualPreset } from "../lib/theme";
import type { ActionId, NotificationCardData, QueuedCard } from "./notificationTypes";
import { applyIncoming, withoutCard } from "./notificationUtils";
import NotificationStack from "./NotificationStack";

/** 后端 notification_window.rs 的 SHOW_EVENT（避免跨入口 import 后端常量）。 */
const SHOW_EVENT = "notification-show";
/** 离场动画时长（与样式表 toastExit 200ms 对齐） */
const EXIT_MS = 210;
/** 卡内动作失败的行内反馈展示时长 */
const FEEDBACK_MS = 3000;

interface SettingsSnap {
  theme: string;
  visualPreset: string;
}

/** 稍后提醒回传后端的载荷形态（与 NotificationCardPayload 对应）。 */
function snoozePayload(card: QueuedCard) {
  return {
    id: card.id,
    kind: card.kind,
    title: card.title,
    body: card.body,
    createdAt: card.createdAt,
    sourceId: card.sourceId ?? null,
    sessionId: card.sessionId ?? null,
    refId: card.refId ?? null,
  };
}

export default function NotificationWindow() {
  const [cards, setCards] = useState<QueuedCard[]>([]);
  const [leavingIds, setLeavingIds] = useState<ReadonlySet<string>>(new Set());
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [busy, setBusy] = useState<ActionId | null>(null);
  const [feedback, setFeedback] = useState<{ id: string; msg: string } | null>(null);
  const [prefersDark, setPrefersDark] = useState(
    () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-color-scheme: dark)").matches,
  );
  const [snap, setSnap] = useState<SettingsSnap | null>(null);

  const rootRef = useRef<HTMLDivElement | null>(null);
  // 离场/反馈定时器统一登记：卸载时全部释放，不留悬挂回调
  const timersRef = useRef<Set<number>>(new Set());

  const spawnTimer = useCallback((fn: () => void, ms: number): number => {
    const t = window.setTimeout(() => {
      timersRef.current.delete(t);
      fn();
    }, ms);
    timersRef.current.add(t);
    return t;
  }, []);

  useEffect(
    () => () => {
      for (const t of timersRef.current) window.clearTimeout(t);
      timersRef.current.clear();
    },
    [],
  );

  // 设置快照 + 主题同步（与主窗/右键菜单同一套事实来源）
  useEffect(() => {
    void getSettings()
      .then((s) =>
        setSnap({ theme: s.theme, visualPreset: s.visual_preset ?? "" }),
      )
      .catch(() => {
        // 快照缺失时按系统明暗渲染，不阻塞通知展示
      });
    const scope = createSubscriptionScope();
    scope.add(
      listen<string>("theme-changed", (e) =>
        setSnap((s) => (s ? { ...s, theme: e.payload } : s)),
      ),
    );
    scope.add(
      listen<string>("visual-preset-changed", (e) =>
        setSnap((s) => (s ? { ...s, visualPreset: e.payload } : s)),
      ),
    );
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    const onSystem = (ev: MediaQueryListEvent) => setPrefersDark(ev.matches);
    mq?.addEventListener("change", onSystem);
    return () => {
      scope.dispose();
      mq?.removeEventListener("change", onSystem);
    };
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    if (snap?.visualPreset) root.dataset.preset = resolveVisualPreset(snap.visualPreset);
    root.dataset.theme = resolveTheme(snap?.theme ?? "system", { prefersDark });
  }, [snap, prefersDark]);

  // 后端事件：追加/更新卡片（合并、容量、摘要折叠都在纯逻辑里）
  useEffect(() => {
    const scope = createSubscriptionScope();
    scope.add(
      listen<NotificationCardData[]>(SHOW_EVENT, (e) => {
        const payload = Array.isArray(e.payload) ? e.payload : [e.payload];
        if (payload.length === 0) return;
        setCards((q) => applyIncoming(q, payload, Date.now()));
      }),
    );
    return () => scope.dispose();
  }, []);

  // 队列空 → 隐藏窗口（WebView 保留复用）；有卡片 → 保持显示
  useEffect(() => {
    if (cards.length === 0 && leavingIds.size === 0) {
      void invoke("hide_notification_window").catch(() => {});
    }
  }, [cards.length, leavingIds.size]);

  // 内容变化后回传实测高度：后端收放窗口高度并保持右下角锚点
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      const el = rootRef.current;
      if (!el) return;
      // +2px 容差：分数 DPI 下视口高度可能比窗口逻辑高度矮 1px（与右键菜单一致）
      void invoke("fit_notification_window", { height: Math.ceil(el.scrollHeight) + 2 }).catch(
        () => {},
      );
    });
    return () => cancelAnimationFrame(raf);
  }, [cards, expandedId, feedback]);

  const dismiss = useCallback(
    (id: string) => {
      // 自动消失与手动关闭竞态：已离场的 id 直接忽略
      setLeavingIds((ids) => {
        if (ids.has(id)) return ids;
        const next = new Set(ids);
        next.add(id);
        return next;
      });
      setExpandedId((e) => (e === id ? null : e));
      spawnTimer(() => {
        setCards((q) => withoutCard(q, id, Date.now()));
        setLeavingIds((ids) => {
          const next = new Set(ids);
          next.delete(id);
          return next;
        });
      }, EXIT_MS);
    },
    [spawnTimer],
  );

  const showFeedback = useCallback(
    (id: string, msg: string) => {
      setFeedback({ id, msg });
      spawnTimer(() => setFeedback(null), FEEDBACK_MS);
    },
    [spawnTimer],
  );

  const onAction = useCallback(
    (card: QueuedCard, id: ActionId) => {
      if (id === "expand") {
        // 展开互斥：同一时间只展开一张（与原型一致）
        setExpandedId((e) => (e === card.id ? null : card.id));
        return;
      }
      setBusy(id);
      const done = () => setBusy(null);
      if (id === "view") {
        // 用户明确点击才激活主窗口并跳转 Agent 面板
        void invoke("notification_navigate", { target: "agents" })
          .then(() => {
            done();
            dismiss(card.id);
          })
          .catch((e) => {
            done();
            showFeedback(card.id, `跳转失败：${String(e)}`);
          });
        return;
      }
      if (id === "center") {
        void invoke("notification_navigate", { target: "history" })
          .then(() => {
            done();
            dismiss(card.id);
          })
          .catch((e) => {
            done();
            showFeedback(card.id, `打开通知中心失败：${String(e)}`);
          });
        return;
      }
      if (id === "handle") {
        if (!card.sourceId || !card.sessionId) {
          setBusy(null);
          showFeedback(card.id, "无法跳转：该通知缺少会话信息");
          return;
        }
        void invoke("open_agent_session", { sourceId: card.sourceId, sessionId: card.sessionId })
          .then(() => {
            done();
            dismiss(card.id);
          })
          .catch((e) => {
            done();
            showFeedback(card.id, `跳转失败：${String(e)}`);
          });
        return;
      }
      if (id === "snooze") {
        void invoke("notification_snooze", { card: snoozePayload(card), minutes: 10 })
          .then(() => {
            done();
            dismiss(card.id);
          })
          .catch((e) => {
            done();
            showFeedback(card.id, `稍后提醒设置失败：${String(e)}`);
          });
        return;
      }
      setBusy(null);
    },
    [dismiss, showFeedback],
  );

  return (
    <div className="ntf-root">
      <NotificationStack
        cards={cards}
        leavingIds={leavingIds}
        expandedId={expandedId}
        busy={busy}
        feedback={feedback}
        rootRef={rootRef}
        onExpire={dismiss}
        onClose={dismiss}
        onAction={onAction}
      />
    </div>
  );
}
