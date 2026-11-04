//! 通知窗口根组件：独立透明 Tauri 窗口（notification.html）的入口与生命周期。
//!
//! - **状态源**：后端 `notification-show` 事件（结构化卡片载荷）；无轮询，
//!   队列上限/合并/关键卡保护由 notificationUtils 纯逻辑承担；
//! - **主题**：与 ContextMenuApp 同一套解析（get_settings 快照 +
//!   theme-changed 订阅 + 系统明暗跟随），落 html[data-theme][data-preset]；
//! - **尺寸**：内容变化后回传实测高度（fit_notification_window），
//!   后端收放窗口并保持右下角锚点；队列为空时隐藏窗口（WebView 常驻复用）；
//! - **动作**：只有用户点击才允许激活主窗口/跳转（notification_navigate，
//!   后端在可靠 ID 时复用已有 Agent 会话导航定位到对应会话/轮次）；失败给卡内
//!   role=alert 反馈并保留卡片，不虚假成功；
//! - **就绪门控**：`notification-show` 订阅成功后才通知后端就绪；未就绪时后端
//!   不显示空窗口、改走 OS 通知兜底，避免“显示了却没人消费事件”与双重弹窗；
//! - **退出清理**：订阅经 SubscriptionScope、离场定时器统一登记并在卸载释放。

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { invokeCommand as invoke } from "../lib/errors";
import { listen } from "@tauri-apps/api/event";
import { getSettings, snoozeReminder, toggleTask } from "../lib/bridge";
import { createSubscriptionScope } from "../lib/subscriptions";
import { resolveSecondaryPreset, resolveTheme, resolveVisualPreset } from "../lib/theme";
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
    detail: card.detail ?? null,
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
  /** 当前快照的同步镜像：show 事件回调里判断是否需要补取设置（state 在回调里是旧值）。 */
  const snapRef = useRef<SettingsSnap | null>(null);

  const rootRef = useRef<HTMLDivElement | null>(null);
  /** 最近一次上报的窗口高度；每轮展示（收到 show 事件）重置为 -1。
   *  后端在不可见时会重置自身高度缓存，所以每一轮都必须重新上报一次，
   *  即使本轮高度与上轮相同（否则窗口永远等不到首个 fit 而不显示）。 */
  const reportedRef = useRef(-1);
  /** 新卡占位解除后才绘制：等窗口高度与 WebView 视口都跟上（视口比原生窗口晚 4~9ms），
   *  否则卡片会先在旧视口里被裁掉不到一帧。 */
  const revealedRef = useRef<Set<string>>(new Set());
  /** 当前卡片快照：reveal 回调异步执行，需要读最新一批卡片键。 */
  const cardsRef = useRef<QueuedCard[]>([]);
  /** 上一提交批次已出现过的卡片键：渲染期比对出“新出现的卡片”，提交后再更新。 */
  const knownKeysRef = useRef<ReadonlySet<string>>(new Set());
  const [, bumpReveal] = useState(0);
  // 离场/反馈定时器统一登记：卸载时全部释放，不留悬挂回调
  const timersRef = useRef<Set<number>>(new Set());
  // 已进入离场的 id：自动消失与手动关闭竞态下只允许一个离场定时器
  const leavingRef = useRef<Set<string>>(new Set());

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

  /** 读取设置快照。启动瞬间 IPC 可能尚未就绪（读失败会静默回退系统明暗，
   *  导致通知窗口长期与设置里的主题/预设不一致），所以 show 事件到达时若快照
   *  仍缺失会再取一次——按真实事件驱动补取，而不是定时重试。 */
  const loadSnap = useCallback(() => {
    void getSettings()
      .then((s) => {
        const next = { theme: s.theme, visualPreset: s.visual_preset ?? "" };
        snapRef.current = next;
        setSnap(next);
      })
      .catch(() => {
        // 本次失败不阻塞展示；下一次 show 事件会再补取
      });
  }, []);

  // 设置快照 + 主题同步（与主窗/右键菜单同一套事实来源）
  useEffect(() => {
    loadSnap();
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
  }, [loadSnap]);

  useEffect(() => {
    const root = document.documentElement;
    if (snap?.visualPreset) {
      // 通知窗口需要可读底：清透预设映射到液态玻璃材质，不跟随主窗全透明。
      root.dataset.preset = resolveSecondaryPreset(resolveVisualPreset(snap.visualPreset));
    }
    root.dataset.theme = resolveTheme(snap?.theme ?? "system", { prefersDark });
  }, [snap, prefersDark]);

  // 后端事件：追加/更新卡片（合并、容量、摘要折叠都在纯逻辑里）
  useEffect(() => {
    const scope = createSubscriptionScope();
    // 订阅建立成功后才向后端声明就绪：此后后端才允许显示通知窗口。
    scope.add(
      listen<NotificationCardData[]>(SHOW_EVENT, (e) => {
        const payload = Array.isArray(e.payload) ? e.payload : [e.payload];
        if (payload.length === 0) return;
        // 启动快照读取失败时（IPC 未就绪等瞬时原因），展示前补取一次：
        // 否则整轮卡片都会按系统明暗渲染，与设置里的主题/预设不一致。
        if (!snapRef.current) loadSnap();
        // 新一轮展示：强制重新上报高度（后端不可见期间已把高度缓存重置为初始值）
        reportedRef.current = -1;
        setCards((q) => applyIncoming(q, payload, Date.now()));
      }).then((unlisten) => {
        void invoke("notification_ui_ready").catch(() => {});
        return unlisten;
      }),
    );
    return () => scope.dispose();
  }, [loadSnap]);

  // 队列空 → 隐藏窗口（WebView 保留复用）；有卡片 → 保持显示
  useEffect(() => {
    if (cards.length === 0 && leavingIds.size === 0) {
      // 下一轮展示重新走占位：窗口隐藏后，视口高度与卡片高度都要重新同步
      revealedRef.current.clear();
      knownKeysRef.current = new Set();
      void invoke("hide_notification_window").catch(() => {});
    }
  }, [cards.length, leavingIds.size]);

  // 本批次卡片键提交后登记：下一批渲染用它比对出“新出现的卡片”
  useEffect(() => {
    cardsRef.current = cards;
    knownKeysRef.current = new Set(cards.map((c) => c.mergeKey));
  }, [cards]);

  const leaving = leavingIds.size > 0;
  // 内容变化后回传实测高度：后端收放窗口高度并保持右下角锚点。
  // 用 layout effect 在提交后、绘制前同步量一次：后端要等到本轮第一个 fit 才显示窗口，
  // 异步（rAF/动画结束）测量会让首帧仍按旧高度显示而裁掉卡片底部。
  useLayoutEffect(() => {
    // rootRef 指向 .ntf-stack（槽位容器）：它自身有 max-height 与内部滚动，
    // 不能量它的父级容器（min-height:100vh，会与视口形成反馈回路）。
    const stack = rootRef.current;
    // 空队列、或仍有卡片在离场时不量：离场 150ms 内 .ntf-slot 的 grid-template-rows
    // 正从 1fr 收到 0fr，量到的是塌缩中的高度，会把窗口一路缩到 MIN_HEIGHT
    // （消失前闪缩、位置漂移）。离场结束、剩余卡片重新布局后只收缩一次。
    if (!stack || cards.length === 0 || leaving) return;

    /** 解除新卡占位：等 WebView 视口跟上窗口高度后再绘制（实测视口比原生窗口晚 4~9ms）。
     *  视口被工作区高度钳制而不再变化时，最多再等 8 帧，避免卡片一直不出现。 */
    const releaseWhenSized = (wanted: number) => {
      // 只释放本次 fit 对应的卡片：轮询期间若有新卡到达，它要等自己的 fit，
      // 不能被这一轮提前放出来（否则仍会在旧视口里被裁一帧）。
      const keys = cardsRef.current.map((c) => c.mergeKey);
      const before = window.innerHeight;
      let tries = 0;
      const tick = () => {
        const h = window.innerHeight;
        if (h !== before || h + 1 >= wanted || tries++ >= 8) {
          for (const key of keys) revealedRef.current.add(key);
          bumpReveal((n) => n + 1);
          return;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    };

    const measure = () => {
      // 离场定时器尚未清空时槽位高度不可信，不上报
      if (leavingRef.current.size > 0) return;
      // 影子余量/安全边距由 .ntf-stack 自身的 padding 承担（scrollHeight 已含），
      // 外层 .ntf-root 目前 padding:0；仍按实际计算值累加，避免两处口径漂移。
      const frame = stack.parentElement ?? stack;
      const style = getComputedStyle(frame);
      const padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
      // scrollHeight 含被 max-height 钳制而溢出的内容，窗口按真实内容高度增长；
      // +2px 容差：分数 DPI 下视口高度可能比窗口逻辑高度矮 1px（与右键菜单一致）
      const height = Math.ceil(stack.scrollHeight + padY) + 2;
      // 布局尚未完成（scrollHeight=0）或异常小时不上报：避免把窗口缩到最小高度
      if (!Number.isFinite(height) || height < 80) return;
      if (height === reportedRef.current) return;
      reportedRef.current = height;
      void invoke("fit_notification_window", { height })
        .catch(() => {})
        .finally(() => {
          // 窗口尺寸已生效后，解除新卡占位，让它们带入场动画出现
          releaseWhenSized(height);
        });
    };

    // 提交后同步量一次：本轮首个 fit 先于窗口显示到达后端
    measure();
    // 再补一次首帧后的测量：字体回退/入场动画仍可能改变高度
    const raf = requestAnimationFrame(measure);
    stack.addEventListener("animationend", measure);
    stack.addEventListener("transitionend", measure);
    void document.fonts?.ready.then(measure).catch(() => {});
    const onFontsDone = () => measure();
    document.fonts?.addEventListener?.("loadingdone", onFontsDone);
    // 同时观察槽位容器与每个槽位：字体加载/正文换行会让槽位内容继续变高，
    // 只观察 stack 时其盒子可能因 max-height 钳制不再变化而漏掉复测。
    const ro =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => measure())
        : null;
    if (ro) {
      ro.observe(stack);
      for (const slot of Array.from(stack.children)) ro.observe(slot);
    }

    return () => {
      cancelAnimationFrame(raf);
      stack.removeEventListener("animationend", measure);
      stack.removeEventListener("transitionend", measure);
      document.fonts?.removeEventListener?.("loadingdone", onFontsDone);
      ro?.disconnect();
    };
  }, [cards, leaving, expandedId, feedback]);

  const dismiss = useCallback(
    (id: string) => {
      // 自动消失与手动关闭竞态：同一卡片只允许一个离场定时器，重复调用直接忽略
      if (leavingRef.current.has(id)) return;
      leavingRef.current.add(id);
      setLeavingIds((ids) => {
        if (ids.has(id)) return ids;
        const next = new Set(ids);
        next.add(id);
        return next;
      });
      setExpandedId((e) => (e === id ? null : e));
      spawnTimer(() => {
        leavingRef.current.delete(id);
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
      // 任务提醒卡（refId = 任务 id）：查看任务 / 稍后提醒 / 完成任务都是真实后端操作
      const isReminder = card.kind === "reminder" && !!card.refId;
      if (id === "view") {
        // 用户明确点击才激活主窗口；携带可靠 ID 时后端复用已有 Agent 会话导航
        // 定位到具体会话/轮次；无 ID 时只打开对应页面（按钮文案已在渲染层如实呈现）。
        const target = isReminder ? "tasks" : "agents";
        void invoke<{ located?: boolean; reason?: string }>("notification_navigate", {
          target,
          sourceId: card.sourceId ?? null,
          sessionId: card.sessionId ?? null,
          refId: card.refId ?? null,
        })
          .then((res) => {
            done();
            if (res && res.located === false) {
              // 定位失败：保留通知并给出明确反馈，不伪装成功
              showFeedback(card.id, res.reason ?? "未能定位到对应对象");
              return;
            }
            dismiss(card.id);
          })
          .catch((e) => {
            done();
            showFeedback(card.id, `跳转失败：${String(e)}`);
          });
        return;
      }
      if (id === "snooze" && isReminder) {
        // 提醒卡「稍后提醒」走真实 snooze_reminder（移动 task_reminders，
        // 重启后仍生效）；成功反馈由主窗口 reminder-snoozed 事件统一弹（含撤销）。
        void snoozeReminder(card.refId!, 10)
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
      if (id === "done" && isReminder) {
        void toggleTask(card.refId!)
          .then(() => {
            done();
            dismiss(card.id);
          })
          .catch((e) => {
            done();
            showFeedback(card.id, `完成任务失败：${String(e)}`);
          });
        return;
      }
      if (id === "center") {
        void invoke<{ located?: boolean }>("notification_navigate", { target: "history" })
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
        // 复用同一条导航命令：内部会话 id 由后端解析为 external_id 并定位轮次
        void invoke<{ located?: boolean; reason?: string }>("notification_navigate", {
          target: "agents",
          sourceId: card.sourceId,
          sessionId: card.sessionId,
          refId: card.refId ?? null,
        })
          .then((res) => {
            done();
            if (res && res.located === false) {
              showFeedback(card.id, res.reason ?? "未能定位到对应对象");
              return;
            }
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

  // 新出现的卡片先占位：等窗口与 WebView 视口都按新高度稳定后再绘制，
  // 避免入场时底部按钮被旧视口/旧窗口裁掉（合并更新沿用已有卡片，不占位）。
  const heldKeys: ReadonlySet<string> = new Set(
    cards
      .filter((c) => !knownKeysRef.current.has(c.mergeKey) && !revealedRef.current.has(c.mergeKey))
      .map((c) => c.mergeKey),
  );

  return (
    <div className="ntf-root">
      <NotificationStack
        cards={cards}
        leavingIds={leavingIds}
        heldKeys={heldKeys}
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
