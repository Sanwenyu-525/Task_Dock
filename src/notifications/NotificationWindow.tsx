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
import type {
  ActionId,
  NotificationCardData,
  NotificationFitResult,
  NotificationShowPayload,
  QueuedCard,
} from "./notificationTypes";
import { applyIncoming, revealTarget, withoutCard } from "./notificationUtils";
import NotificationStack from "./NotificationStack";

/** 后端 notification_window.rs 的 SHOW_EVENT（避免跨入口 import 后端常量）。 */
const SHOW_EVENT = "notification-show";
/** 离场动画时长（与样式表 toastExit 200ms 对齐） */
const EXIT_MS = 210;
/** 卡内动作失败的行内反馈展示时长 */
const FEEDBACK_MS = 3000;
/** 占位释放的最长等待（帧回调被节流/fit 失败时的安全退化上限）。
 *  实测 WebView2 视口同步在部分环境下可达 ~350ms，安全阀必须明显高于该值，
 *  否则会在窗口尚未长高时提前展示详情、重新引入底部裁切。 */
const REVEAL_TIMEOUT_MS = 1200;

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
  /** 展开详情的目标高度尚未就绪：详情只以零高度影子节点参与测量，不绘制。
   *  窗口 fit 到目标高度后清空此状态，详情才进入正常布局并播放入场动画。 */
  const [expandHoldId, setExpandHoldId] = useState<string | null>(null);
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
  const [, bumpReveal] = useState(0);
  // 离场/反馈定时器统一登记：卸载时全部释放，不留悬挂回调
  const timersRef = useRef<Set<number>>(new Set());
  // 已进入离场的 id：自动消失与手动关闭竞态下只允许一个离场定时器
  const leavingRef = useRef<Set<string>>(new Set());
  /** 当前轮次号（后端随 notification-show 下发）：fit 回传时原样带回，后端据此丢弃迟到请求。 */
  const roundRef = useRef<number | null>(null);
  /** 本轮 fit 序号：同一轮内快速展开/收起时保证后发的尺寸调整胜出。 */
  const fitSeqRef = useRef(0);
  /** 最近一次 fit 的 token：只有最新一次 fit 的回调可以安排占位释放。 */
  const fitTokenRef = useRef(0);
  /** 最近一次 fit 的请求高度与后端实际生效高度（可能被工作区钳制）。 */
  const lastFitRef = useRef<{ wanted: number; applied: number } | null>(null);
  /** 最新一次测量的目标高度：释放判定每帧读取它，字体加载/换行导致目标变化时不会提前释放。 */
  const wantedRef = useRef(0);
  /** 等待窗口就绪后再展示的展开目标。 */
  const pendingExpandRef = useRef<{ id: string; wanted: number } | null>(null);
  /** expandedId 的同步镜像：异步释放回调不能读到已过期的渲染闭包。 */
  const expandedIdRef = useRef<string | null>(null);
  /** 占位释放的 rAF / 一次性超时与令牌：新测量、hide、卸载都会取消旧回调。 */
  const revealRafRef = useRef<number | null>(null);
  const revealTimerRef = useRef<number | null>(null);
  const revealTokenRef = useRef(0);
  const disposedRef = useRef(false);

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

  /** 取消尚未完成的占位释放（rAF 与一次性超时）。 */
  const cancelRevealWait = useCallback(() => {
    revealTokenRef.current += 1;
    if (revealRafRef.current !== null) {
      window.cancelAnimationFrame(revealRafRef.current);
      revealRafRef.current = null;
    }
    if (revealTimerRef.current !== null) {
      window.clearTimeout(revealTimerRef.current);
      revealTimerRef.current = null;
    }
  }, []);

  // StrictMode 会挂载→卸载→再挂载：disposed 标记必须在 setup 里复位，
  // 卸载后所有异步释放回调都不再更新状态。
  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      cancelRevealWait();
    };
  }, [cancelRevealWait]);

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
      listen<NotificationShowPayload | NotificationCardData[]>(SHOW_EVENT, (e) => {
        // 兼容旧形态（裸卡片数组）：新协议携带 round，前后端用它关联 fit 轮次。
        const payload = Array.isArray(e.payload)
          ? e.payload
          : Array.isArray(e.payload?.cards)
            ? e.payload.cards
            : [];
        if (payload.length === 0) return;
        if (!Array.isArray(e.payload) && typeof e.payload?.round === "number") {
          roundRef.current = e.payload.round;
          // 每批新轮次重新编号：后端也按批次重置序号，旧 fit 不能覆盖新轮次。
          fitSeqRef.current = 0;
          lastFitRef.current = null;
        }
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
      pendingExpandRef.current = null;
      expandedIdRef.current = null;
      setExpandHoldId(null);
      cancelRevealWait();
      // 携带本轮轮次：若隐藏请求在途时后端已送出下一批通知，后端会忽略它，避免丢通知。
      void invoke("hide_notification_window", { round: roundRef.current }).catch(() => {});
    }
  }, [cards.length, leavingIds.size, cancelRevealWait]);

  // 本批次卡片键在提交后、测量前登记：占位释放只覆盖本次 fit 已测量的卡片，
  // 之后到达的新卡仍保持占位，等它自己的 fit/视口就绪。
  useLayoutEffect(() => {
    cardsRef.current = cards;
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

    /** 展开详情的自然高度：影子容器高度为 0、不占布局，内部 .ntf-extra 仍按
     *  真实卡片宽度布局；连同它自身的 margin 一起计入目标，避免少算一段间距。 */
    const heldExtraHeight = (): number => {
      const extra = stack.querySelector<HTMLElement>(".ntf-extra-measure .ntf-extra");
      if (!extra) return 0;
      const extraStyle = getComputedStyle(extra);
      const marginTop = parseFloat(extraStyle.marginTop) || 0;
      const marginBottom = parseFloat(extraStyle.marginBottom) || 0;
      return Math.max(0, extra.getBoundingClientRect().height + marginTop + marginBottom);
    };

    /** 解除占位：只释放本次 fit 已覆盖的卡片（之后到达的新卡等自己的 fit），
     *  以及仍有效的展开目标。 */
    const releaseHeld = (keys: readonly string[]) => {
      if (disposedRef.current) return;
      revealTokenRef.current += 1;
      if (revealRafRef.current !== null) {
        window.cancelAnimationFrame(revealRafRef.current);
        revealRafRef.current = null;
      }
      if (revealTimerRef.current !== null) {
        window.clearTimeout(revealTimerRef.current);
        revealTimerRef.current = null;
      }
      for (const key of keys) {
        revealedRef.current.add(key);
      }
      const pending = pendingExpandRef.current;
      if (pending && expandedIdRef.current === pending.id) {
        pendingExpandRef.current = null;
        setExpandHoldId((held) => (held === pending.id ? null : held));
      }
      bumpReveal((n) => n + 1);
    };

    /** 等原生窗口与 WebView 视口都达到目标后再展示新增内容。
     *  - 每帧读取最新目标：字体回退/换行改变高度时不会按旧目标提前释放；
     *  - 后端 fit 结果被工作区/最大高度钳制时收敛到 applied，剩余内容由栈内滚动承载；
     *  - 一次性超时兜底：rAF 被节流或 fit 失败时也不会让新卡永久 opacity:0。 */
    const scheduleReveal = (wanted: number, keys: readonly string[]) => {
      if (disposedRef.current) return;
      wantedRef.current = wanted;
      cancelRevealWait();
      const token = ++revealTokenRef.current;
      const deadline = performance.now() + REVEAL_TIMEOUT_MS;
      const tick = () => {
        if (disposedRef.current || token !== revealTokenRef.current) return;
        const target = revealTarget(wantedRef.current, lastFitRef.current);
        if (window.innerHeight + 1.5 >= target || performance.now() >= deadline) {
          releaseHeld(keys);
          return;
        }
        revealRafRef.current = window.requestAnimationFrame(tick);
      };
      revealRafRef.current = window.requestAnimationFrame(tick);
      // rAF 在窗口被遮挡/最小化时可能被节流：一次性超时保证状态最终收敛。
      revealTimerRef.current = window.setTimeout(() => {
        if (disposedRef.current || token !== revealTokenRef.current) return;
        releaseHeld(keys);
      }, REVEAL_TIMEOUT_MS + 50);
    };

    const measure = () => {
      // 离场定时器尚未清空时槽位高度不可信，不上报
      if (leavingRef.current.size > 0) return;
      // 影子余量/安全边距由 .ntf-stack 自身的 padding 承担（scrollHeight 已含），
      // 外层 .ntf-root 目前 padding:0；仍按实际计算值累加，避免两处口径漂移。
      const frame = stack.parentElement ?? stack;
      const style = getComputedStyle(frame);
      const padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
      // 展开详情的影子节点不占布局（高度 0），其自然高度单独计入目标。
      // +2px 容差：分数 DPI 下视口高度可能比窗口逻辑高度矮 1px（与右键菜单一致）
      const height = Math.ceil(stack.scrollHeight + padY + heldExtraHeight()) + 2;
      // 布局尚未完成（scrollHeight=0）或异常小时不上报：避免把窗口缩到最小高度
      if (!Number.isFinite(height) || height < 80) return;
      wantedRef.current = height;
      const pending = pendingExpandRef.current;
      if (pending && expandedIdRef.current === pending.id) pending.wanted = height;
      // 本次 fit 覆盖的卡片快照：之后到达的新卡不在其中，仍保持占位。
      const keys = cardsRef.current.map((c) => c.mergeKey);
      if (height === reportedRef.current) {
        // 高度未变（再次展开/目标已上报）：仍需走一次就绪判定，
        // 否则展开详情可能永远等不到 fit 回调而保持占位。
        if (pending) scheduleReveal(height, keys);
        return;
      }
      reportedRef.current = height;
      const seq = ++fitSeqRef.current;
      const round = roundRef.current;
      const token = ++fitTokenRef.current;
      void invoke<NotificationFitResult>("fit_notification_window", {
        height,
        round,
        seq,
      })
        .then((res) => {
          if (disposedRef.current || token !== fitTokenRef.current) return;
          if (res && res.accepted !== false && Number.isFinite(res.applied)) {
            lastFitRef.current = { wanted: height, applied: res.applied };
          }
        })
        .catch(() => {
          if (disposedRef.current || token !== fitTokenRef.current) return;
          // fit 失败：不重试、不抛错；超时释放后内容由栈内滚动承载。
          lastFitRef.current = null;
        })
        .finally(() => {
          if (disposedRef.current || token !== fitTokenRef.current) return;
          scheduleReveal(height, keys);
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
  }, [cards, leaving, expandedId, expandHoldId, feedback, cancelRevealWait]);

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
      // 关闭的卡片不能继续作为展开目标：否则迟到的释放回调会把占位状态写回已卸载的卡片
      if (pendingExpandRef.current?.id === id) pendingExpandRef.current = null;
      if (expandedIdRef.current === id) expandedIdRef.current = null;
      setExpandHoldId((held) => (held === id ? null : held));
      setExpandedId((e) => (e === id ? null : e));
      spawnTimer(() => {
        leavingRef.current.delete(id);
        // 离场完成后才撤销“已释放”标记：同一合并键再次出现时需要重新占位等窗口长高。
        const removedKey = cardsRef.current.find((c) => c.id === id)?.mergeKey;
        if (removedKey) revealedRef.current.delete(removedKey);
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
        // 展开互斥：同一时间只展开一张（与原型一致）。
        // 展开时详情先以零高度影子节点参与测量，窗口 fit 到目标高度后才真正展示；
        // 收起时直接卸载详情，窗口随后按缩小后的高度收起（右下角锚点不变）。
        if (expandedId === card.id) {
          pendingExpandRef.current = null;
          expandedIdRef.current = null;
          setExpandHoldId(null);
          setExpandedId(null);
        } else {
          pendingExpandRef.current = { id: card.id, wanted: 0 };
          expandedIdRef.current = card.id;
          setExpandHoldId(card.id);
          setExpandedId(card.id);
        }
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
    [dismiss, showFeedback, expandedId],
  );

  // 本轮尚未释放的卡片先占位：等窗口与 WebView 视口都按新高度稳定后再绘制，
  // 避免入场时底部按钮被旧视口/旧窗口裁掉。合并更新沿用已释放的键，不重放入场动画。
  const heldKeys: ReadonlySet<string> = new Set(
    cards.filter((c) => !revealedRef.current.has(c.mergeKey)).map((c) => c.mergeKey),
  );

  return (
    <div className="ntf-root">
      <NotificationStack
        cards={cards}
        leavingIds={leavingIds}
        heldKeys={heldKeys}
        extraHeldId={expandHoldId}
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
