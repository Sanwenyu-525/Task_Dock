//! 液态玻璃右键菜单本体（独立透明弹窗）。
//!
//! - **状态源**：后端设置库。打开时经 get_settings 取快照，打开期间订阅
//!   theme-changed / mode-changed 与主窗保持同步，不另建状态源；
//! - **主题**：与 useSettingsStore 同一套解析（resolveTheme / resolveVisualPreset），
//!   theme=system 时跟随系统明暗实时切换，无需重启；
//! - **键盘**：↑↓/Home/End 移动（roving tabindex）、Enter/Space 触发、
//!   Esc/Tab 关闭 —— 与主窗 DropdownMenu 基元同一套交互约定；
//! - **尺寸**：显示后把实测内容尺寸回传 fit_context_menu，后端收放窗口
//!   并按锚点重新定位；尺寸稳定后重复 show 不再触发 resize。
//!
//! 性能：无轮询、无常驻动画循环；所有监听经 SubscriptionScope 释放，
//! fit 测量仅在 show 后执行一次（rAF 内读取，避免布局抖动）。

import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { invokeCommand as invoke } from "../lib/errors";
import { listen } from "@tauri-apps/api/event";
import { Check } from "lucide-react";
import { getSettings } from "../lib/bridge";
import { createSubscriptionScope } from "../lib/subscriptions";
import { resolveSecondaryPreset, resolveTheme, resolveVisualPreset } from "../lib/theme";
import {
  flatItemsFor,
  groupLabel,
  initialActiveIndex,
  isItemChecked,
  itemLabel,
  menuGroupsFor,
  showsGroupLabels,
  type MenuAction,
  type MenuSnapshot,
  type MenuVariant,
} from "./items";
import { t } from "../i18n";

const SHOW_EVENT = "context-menu-show";

/** show 事件载荷：变体由后端决定（托盘 = tray，极简标签 = tab）。 */
interface ShowPayload {
  variant?: string;
}

function readVariant(payload: unknown): MenuVariant {
  return payload && typeof payload === "object" && (payload as ShowPayload).variant === "tab"
    ? "tab"
    : "tray";
}

/** context_menu_action 的返回：成功带最新快照，失败带可读原因（后端权威状态）。 */
interface MenuActionResult {
  ok: boolean;
  error?: string;
  snapshot?: MenuSnapshot;
}

export default function ContextMenuApp() {
  const [snap, setSnap] = useState<MenuSnapshot | null>(null);
  /** 本次显示的变体：由后端 show 载荷决定；默认托盘菜单。 */
  const [variant, setVariant] = useState<MenuVariant>("tray");
  // 变体对应的条目：键盘导航、索引与渲染都只读这一份，不各自维护列表。
  const groups = menuGroupsFor(variant);
  const items = flatItemsFor(variant);
  const showGroupLabels = showsGroupLabels(variant);
  const [activeIndex, setActiveIndex] = useState(-1);
  // 每次后端 show 事件 +1：重放入场动画、触发一次尺寸回传
  const [showTick, setShowTick] = useState(0);
  // 动作失败的行内反馈（role=alert，2.5s 自动消失；不留悬空定时器）
  const [feedback, setFeedback] = useState<string | null>(null);
  const feedbackTimer = useRef<number | null>(null);
  const [prefersDark, setPrefersDark] = useState(
    () =>
      typeof window !== "undefined" &&
      !!window.matchMedia?.("(prefers-color-scheme: dark)").matches,
  );
  const menuRef = useRef<HTMLDivElement>(null);
  // showTick 的镜像：SHOW_EVENT 里需要读取当前值决定是否重放入场动画
  const showTickRef = useRef(0);
  // 焦点重定位信号：重开/重定位时都把键盘焦点拉回勾选项
  const [focusTick, setFocusTick] = useState(0);

  const refresh = useCallback(async (): Promise<MenuSnapshot | null> => {
    try {
      const s = await getSettings();
      const next: MenuSnapshot = {
        mode: s.mode,
        theme: s.theme,
        autostart: s.autostart,
        visual_preset: s.visual_preset,
        snap_display_mode: s.snap_display_mode,
      };
      setSnap(next);
      return next;
    } catch {
      // 快照缺失时菜单仍可渲染（无勾选态），动作照常可用
      return null;
    }
  }, []);

  const showFeedback = useCallback((message: string) => {
    setFeedback(message);
    if (feedbackTimer.current !== null) window.clearTimeout(feedbackTimer.current);
    feedbackTimer.current = window.setTimeout(() => {
      feedbackTimer.current = null;
      setFeedback(null);
    }, 2500);
  }, []);

  const runAction = useCallback(
    (action: MenuAction) => {
      // 后端执行动作，成功才隐藏菜单；成功回传最新快照（不做乐观更新），
      // 失败保留菜单 + 行内错误反馈 —— 不虚假显示成功，也不静默失败。
      void invoke<MenuActionResult>("context_menu_action", { action })
        .then((result) => {
          if (result.snapshot) setSnap(result.snapshot);
          if (!result.ok) {
            showFeedback(result.error ?? "操作失败");
            void refresh();
          }
        })
        .catch(() => {
          // IPC 本身异常：回读权威状态，避免残留乐观勾选
          showFeedback("菜单命令未响应");
          void refresh();
        });
    },
    [showFeedback, refresh],
  );

  const close = useCallback(() => {
    void invoke("hide_context_menu").catch(() => {});
  }, []);

  // 快照 + 事件订阅（show 刷新 / theme、mode 同步 / 系统明暗跟随）
  useEffect(() => {
    void refresh();
    const scope = createSubscriptionScope();
    scope.add(
      listen(SHOW_EVENT, (event) => {
        // 变体先落定：同一次显示里的条目、键盘表、初始焦点都按它取。
        const nextVariant = readVariant(event.payload);
        setVariant(nextVariant);
        // 重开/重定位时清掉上一轮失败反馈：失败反馈有 2.5s 自动消失窗口，
        // 若在窗口内重开菜单，残留的旧错误会闪现误导用户。
        if (feedbackTimer.current !== null) window.clearTimeout(feedbackTimer.current);
        feedbackTimer.current = null;
        setFeedback(null);
        // 仅「从隐藏到显示」才重放入场动画；已打开时的再次右键只更新
        // 快照与焦点（统一重定位策略），不重挂载 —— 否则连续右键会闪。
        const alreadyShown =
          document.visibilityState === "visible" && showTickRef.current > 0;
        if (!alreadyShown) setShowTick((t) => t + 1);
        setFocusTick((t) => t + 1);
        // 先刷新快照再定初始焦点：优先落在勾选项上（tab 变体无勾选，恒第一项）
        void refresh().then((s) => setActiveIndex(initialActiveIndex(s, nextVariant)));
      }),
    );
    scope.add(
      listen<string>("theme-changed", (e) =>
        setSnap((s) => (s ? { ...s, theme: e.payload } : s)),
      ),
    );
    scope.add(
      listen<string>("mode-changed", (e) =>
        setSnap((s) => (s ? { ...s, mode: e.payload } : s)),
      ),
    );
    scope.add(
      listen<string>("snap-form-changed", (e) =>
        setSnap((s) => (s ? { ...s, snap_display_mode: e.payload } : s)),
      ),
    );
    // 系统明暗变化：theme=system 时实时反映
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    const onSystem = (ev: MediaQueryListEvent) => setPrefersDark(ev.matches);
    mq?.addEventListener("change", onSystem);
    return () => {
      scope.dispose();
      mq?.removeEventListener("change", onSystem);
    };
  }, [refresh]);

  // 卸载/热更新时清掉未执行的反聩定时器
  useEffect(
    () => () => {
      if (feedbackTimer.current !== null) window.clearTimeout(feedbackTimer.current);
    },
    [],
  );

  // 主题落到 DOM：与主窗同一套解析，保证两边永远一致
  useEffect(() => {
    const root = document.documentElement;
    if (snap) {
      // 清透玻璃只属于主窗：菜单窗口需要可读的不透明表面，沿用液态玻璃材质。
      root.dataset.preset = resolveSecondaryPreset(resolveVisualPreset(snap.visual_preset));
    }
    root.dataset.theme = resolveTheme(snap?.theme ?? "system", { prefersDark });
  }, [snap, prefersDark]);

  // roving tabindex：焦点跟随 activeIndex（仅键盘导航移动；hover 走纯 CSS，
  // 鼠标不再劫持 DOM 焦点 —— focus-visible 只在键盘使用时出现）
  useEffect(() => {
    if (activeIndex < 0) return;
    const raf = requestAnimationFrame(() => {
      menuRef.current
        ?.querySelector<HTMLElement>(`[data-idx="${activeIndex}"]`)
        ?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [activeIndex, focusTick]);

  // 把实测内容高度回传后端（窗口收放高度并按锚点重新定位）。
  // **挂载时也执行一次**：窗口尚不可见时就完成收放，首开即最终尺寸，
  // 消除「先显示 620 高窗口再缩小」的首开跳动。showTick 触发的重复回传
  // 由后端 0.5px 阈值去重，不会反复 resize。
  // 高度必须用 scrollHeight：菜单被 max-height 钳制时 getBoundingClientRect
  // 只能拿到被裁后的高度，会让 fit 把窗口钉在钳制值上（内容被滚动截断）。
  // +2px 容差：分数 DPI（125%/150%）下 WebView 视口高度可能比窗口逻辑高度
  // 矮 1px，若窗口高度 == 内容高度，max-height:100vh 会比 scrollHeight 矮，
  // 触发 1px 幽灵溢出 → 右侧出现一条系统滚动条（视觉上就是「白边」）。
  useEffect(() => {
    showTickRef.current = showTick;
    const raf = requestAnimationFrame(() => {
      const el = menuRef.current;
      if (!el) return;
      void invoke("fit_context_menu", {
        height: Math.ceil(el.scrollHeight) + 2,
      }).catch(() => {});
    });
    return () => cancelAnimationFrame(raf);
  }, [showTick]);

  const step = useCallback(
    (dir: 1 | -1) => {
      setActiveIndex((i) => {
        const n = items.length;
        if (n === 0) return -1;
        return (((i < 0 ? 0 : i) + dir) % n + n) % n;
      });
    },
    [items],
  );

  function onKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        step(1);
        return;
      case "ArrowUp":
        e.preventDefault();
        step(-1);
        return;
      case "Home":
        e.preventDefault();
        setActiveIndex(items.length ? 0 : -1);
        return;
      case "End":
        e.preventDefault();
        setActiveIndex(items.length - 1);
        return;
      case "Enter":
      case " ":
        e.preventDefault();
        if (activeIndex >= 0 && activeIndex < items.length) {
          runAction(items[activeIndex].action);
        }
        return;
      case "Escape":
        e.preventDefault();
        close();
        return;
      case "Tab":
        // Tab 离开菜单等同关闭（与主窗 DropdownMenu 行为一致）
        e.preventDefault();
        close();
        return;
    }
  }

  return (
    // key={showTick}：每次显示重挂载，重放入场动画
    <div
      key={showTick}
      ref={menuRef}
      className="liquid-context-menu"
      role="menu"
      aria-label={variant === "tab" ? t("capsule.tabMenu.group") : "Task Dock 菜单"}
      onKeyDown={onKeyDown}
    >
      {groups.map((group, gi) => (
        <section
          key={group.key}
          className="menu-group"
          role="group"
          aria-label={groupLabel(group)}
        >
          {gi > 0 && <div className="menu-sep" role="separator" aria-hidden="true" />}
          {showGroupLabels && <div className="menu-group-label">{groupLabel(group)}</div>}
          {group.items.map((item) => {
            const idx = items.indexOf(item);
            const checked = snap ? isItemChecked(item, snap) : false;
            const Icon = item.icon;
            return (
              <button
                key={item.key}
                type="button"
                data-idx={idx}
                role={item.radio ? "menuitemradio" : item.toggle ? "menuitemcheckbox" : "menuitem"}
                aria-checked={item.radio || item.toggle ? checked : undefined}
                tabIndex={idx === activeIndex ? 0 : -1}
                className={`menu-item${checked ? " is-checked" : ""}${
                  item.action === "quit" ? " menu-item-quit" : ""
                }`}
                onClick={() => runAction(item.action)}
              >
                <span className="menu-item-icon" aria-hidden="true">
                  <Icon size={16} strokeWidth={1.75} />
                </span>
                <span className="menu-item-label">{itemLabel(item)}</span>
                <span className="menu-item-trailing" aria-hidden="true">
                  {checked && <Check size={14} strokeWidth={2.5} />}
                </span>
              </button>
            );
          })}
        </section>
      ))}
      {feedback && (
        <div className="menu-feedback" role="alert">
          {feedback}
        </div>
      )}
    </div>
  );
}
