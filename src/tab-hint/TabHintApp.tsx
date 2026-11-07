//! 极简标签悬停提示条（独立透明弹窗）。
//!
//! 流程（全程事件驱动，无轮询、无常驻计时器）：
//! 1. 本窗口**先建立 `tab-hint-show` 订阅**，订阅成功后回传 `tab_hint_ready`；
//! 2. 主窗 `EdgeTab` 悬停 350ms → `show_tab_hint { edge, text }`；
//! 3. 后端推进显示代次 → 向本窗口 emit `tab-hint-show { id, text }`；
//! 4. 本窗口渲染文字后**先测量自然尺寸**并回传 `fit_tab_hint { width, height, id }`；
//! 5. 后端校验代次仍有效后按实测尺寸收放窗口、贴边定位、应用圆角区域，最后才 `show()`。
//!    先量后显，避免「先弹一个默认宽度的气泡再缩」的跳动；过期代次被丢弃，
//!    鼠标离开后到达的测量不会把窗口重新显示出来。
//!
//! 就绪顺序（2026-11-07 round3）：`listen()` 返回 Promise，旧实现先发 ready 再订阅，
//! 后端可能在监听器建立前 emit 首次 show（事件不排队 → 首次提示丢失）。现在 ready
//! 严格在显示事件订阅建立之后发送；后端在未就绪期间缓存最近一次显示请求，收到 ready
//! 后补发（见 `tab_hint.rs` 的 `pending`）。
//!
//! 主题：与右键菜单同一套解析（`resolveSecondaryPreset` / `resolveTheme`），
//! 只订阅既有 `theme-changed` / `visual-preset-changed` 事件，不新建状态源。

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invokeCommand as invoke } from "../lib/errors";
import { getSettings } from "../lib/bridge";
import { createSubscriptionScope } from "../lib/subscriptions";
import { resolveSecondaryPreset, resolveTheme, resolveVisualPreset } from "../lib/theme";

const SHOW_EVENT = "tab-hint-show";

/** 显示请求：`id` 是后端本次显示会话的代次，必须原样回传给 `fit_tab_hint`。 */
interface HintShow {
  id: number;
  text: string;
}

export default function TabHintApp() {
  // 同一个文案可能连续出现（Agent 状态没变）：只有 id 能区分「这是新的一次显示」。
  // 任何依赖 text 的缓存/去重都会让第二次悬停静默失败。
  const [hint, setHint] = useState<HintShow>({ id: 0, text: "" });
  const [theme, setTheme] = useState("system");
  const [visualPreset, setVisualPreset] = useState("default");
  const [prefersDark, setPrefersDark] = useState(
    () =>
      typeof window !== "undefined" &&
      !!window.matchMedia?.("(prefers-color-scheme: dark)").matches,
  );
  const bubbleRef = useRef<HTMLDivElement>(null);
  /** 已处理的最大代次：重复投递/乱序旧事件不得把提示退回旧会话。 */
  const lastId = useRef(0);

  const refresh = useCallback(async () => {
    try {
      const s = await getSettings();
      setTheme(s.theme);
      setVisualPreset(s.visual_preset);
    } catch {
      // 读不到设置就沿用默认外观：提示条不能因为设置读取失败而消失
    }
  }, []);

  // 初次挂载：读一次快照；**先建立事件订阅，再上报 ready**。
  // Tauri 的 `listen()` 是异步的：旧顺序（先 ready 再订阅）存在丢事件窗口——
  // 后端收到 ready、主窗随即发首次 show、事件在监听器建立前发出，首次提示静默丢失。
  // 现在只有显示事件监听**真正建立**后才发送 ready；订阅失败或组件已卸载都不发。
  useEffect(() => {
    void refresh();
    const scope = createSubscriptionScope();
    let cancelled = false;

    const showSubscription = scope.add(
      listen<HintShow>(SHOW_EVENT, (e) => {
        const payload = e.payload;
        if (!payload || typeof payload.id !== "number") return;
        // 单调 id：事件重复投递或旧会话迟到时，不得回退渲染（旧 fit 会被
        // 后端代次拒绝，但前端也不应该把已经换掉的文案又写回来）。
        if (payload.id <= lastId.current) return;
        lastId.current = payload.id;
        setHint({ id: payload.id, text: payload.text ?? "" });
      }),
    );
    scope.add(
      listen<string>("theme-changed", (e) =>
        setTheme(typeof e.payload === "string" ? e.payload : "system"),
      ),
    );
    scope.add(
      listen<string>("visual-preset-changed", (e) =>
        setVisualPreset(typeof e.payload === "string" ? e.payload : "default"),
      ),
    );

    // 就绪的必要条件是**显示事件订阅**：主题订阅失败只影响外观，不阻断提示。
    // 失败时不发 ready：后端把就绪前的显示请求排队（不提前显示空气泡），
    // StrictMode 的重挂载会重新订阅；不引入固定延迟或轮询来掩盖失败。
    void showSubscription.then((ok) => {
      if (!ok || cancelled || scope.closed) return;
      void invoke("tab_hint_ready").catch(() => {});
    });

    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    const onSystem = (ev: MediaQueryListEvent) => setPrefersDark(ev.matches);
    mq?.addEventListener("change", onSystem);
    return () => {
      cancelled = true;
      scope.dispose();
      mq?.removeEventListener("change", onSystem);
    };
  }, [refresh]);

  // 主题落到 DOM：与主窗 / 菜单弹窗同一套解析，保证三处外观永远一致
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.preset = resolveSecondaryPreset(resolveVisualPreset(visualPreset));
    root.dataset.theme = resolveTheme(theme, { prefersDark });
  }, [theme, visualPreset, prefersDark]);

  // 每次显示请求（新 id）都同步测量一次自然尺寸并回传：后端据此收放窗口并显示。
  // - **不按 text 去重**：同文案重复悬停也必须重新走一遍显示事务；
  // - **不用 rAF**：窗口在隐藏态时帧调度可能被节流，同步读 offsetWidth 更可靠
  //   （layout effect 阶段 DOM 已提交，强制布局是有效的）；
  // - +2px 与右键菜单同口径：分数 DPI 下视口可能比内容矮 1px，避免幽灵溢出。
  useLayoutEffect(() => {
    if (!hint.id || !hint.text) return;
    const el = bubbleRef.current;
    if (!el) return;
    const width = Math.ceil(el.offsetWidth) + 2;
    const height = Math.ceil(el.offsetHeight) + 2;
    if (width <= 0 || height <= 0) return;
    void invoke("fit_tab_hint", { width, height, id: hint.id }).catch(() => {});
  }, [hint]);

  return (
    <div className="tab-hint" role="tooltip" ref={bubbleRef}>
      {hint.text}
    </div>
  );
}
