//! 应用面板（胶囊内，对照 `docs/design-refs/v07/停靠效果图/04-apps.png`）。
//!
//! 复用既有 `nav_list_targets` 缓存与 `nav_navigate`（窗口识别 / 启动 / 聚焦
//! 全在后端），胶囊内不实现第二套启动逻辑。
//!
//! 真实性约束：
//! - 列表只来自用户**已配置**的快捷目标，不预置微信 / Chrome / VS Code；
//! - 应用图标走统一的 `AppIcon`（后端按需提取 Windows 真实图标），
//!   网址/文件夹没有可执行文件，仍用「稳定色相 + 首字母」圆点；
//! - 搜索框做的是对已加载目标的本地过滤（真实可用），不是装饰；
//! - 启动失败如实提示后端返回的 `reason`，不显示「已启动」。

import { useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { LayoutGrid, Loader2, Plus, Search, X } from "lucide-react";
import {
  navDeleteTarget, navNavigate, avatarHue, resultMessage, type NavTarget,
} from "../../lib/navigation";
import { normalizeError } from "../../lib/errors";
import { searchApps, sortTargetsForDisplay } from "../../lib/appSearch";
import {
  buildAppGrid,
  filterAppGrid,
  moveAppGridBy,
  moveAppGridId,
  readAppGridOrder,
  writeAppGridOrder,
} from "../../lib/appGridOrder";
import { onAppGridOrderApplied, schedulePreferencesMirror } from "../../lib/userPreferences";
import AppIcon from "../ui/AppIcon";
import { SearchField } from "../ui";
import { useNavigationStore } from "../../store/useNavigationStore";
import { openAppsAdd, openAppsManager } from "./actions";
import { EmptyState, PanelHead } from "./PanelKit";

/** 启动异常 → 可读原因：按稳定错误码区分权限/缺失/超时，不展示堆栈或原始路径。 */
function launchFailureReason(raw: unknown): string {
  const err = normalizeError(raw, "nav_navigate");
  switch (err.code) {
    case "PERMISSION_DENIED":
      return "没有权限启动该应用";
    case "NOT_FOUND":
      return "应用或窗口不存在";
    case "TIMEOUT":
      return "启动超时，请稍后重试";
    case "SERVICE_UNAVAILABLE":
    case "SERVICE_OVERLOADED":
      return "启动服务暂不可用，请稍后重试";
    default:
      return err.reason || err.message || "启动失败";
  }
}

export default function AppsLite() {
  const targets = useNavigationStore((s) => s.targets);
  const targetsLoaded = useNavigationStore((s) => s.targetsLoaded);
  const targetsError = useNavigationStore((s) => s.targetsError);
  const loadTargets = useNavigationStore((s) => s.loadTargets);
  const loadTaskLinks = useNavigationStore((s) => s.loadTaskLinks);
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  /** 用户手动网格顺序（含加号伪 id）；null = 使用自然顺序。 */
  const [savedOrder, setSavedOrder] = useState<string[] | null>(() => readAppGridOrder());
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropHint, setDropHint] = useState<{ id: string; after: boolean } | null>(null);
  const dragIdRef = useRef<string | null>(null);
  /** 拖放结束后浏览器可能仍补发一次 click；用时间戳挡住误启动。 */
  const lastDropAtRef = useRef(0);
  /** 待确认删除的目标：胶囊窗口被 Win32 区域裁成 340×440，不能复用完整面板的浮层删除框，
      改为面板内确认条（同一套确认语义与后端删除命令）。 */
  const [pendingDelete, setPendingDelete] = useState<NavTarget | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  /** 后端删除成功但刷新失败时，本地先隐藏该项，避免旧缓存把「已删除」显示回来。 */
  const [removedIds, setRemovedIds] = useState<ReadonlySet<string>>(new Set());
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const deleteTriggerRef = useRef<HTMLButtonElement | null>(null);
  const restoreFocusRef = useRef(false);
  const hadPendingRef = useRef(false);
  // 单条反馈只保留一个计时器：新反馈覆盖旧反馈时先取消旧计时器，
  // 自然结束后置空，避免连续启动/失败把已结束的 ID 一直累积。
  const noticeTimer = useRef<number | null>(null);

  useEffect(() => {
    if (!targetsLoaded) void loadTargets();
  }, [targetsLoaded, loadTargets]);

  useEffect(() => {
    return () => {
      if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
      noticeTimer.current = null;
    };
  }, []);

  // 备份恢复会替换 localStorage 中的网格顺序：已挂载的面板同步重读，
  // 不必重启应用。订阅在卸载时解除，不产生常驻监听。
  useEffect(
    () =>
      onAppGridOrderApplied(() => {
        setSavedOrder(readAppGridOrder());
      }),
    [],
  );

  // 确认条打开时焦点落在「取消」；取消关闭后还给触发删除的按钮。
  // 删除成功时触发按钮已随列表移除，不再抢焦点。
  useEffect(() => {
    if (pendingDelete) {
      hadPendingRef.current = true;
      cancelRef.current?.focus();
    } else if (hadPendingRef.current) {
      hadPendingRef.current = false;
      if (restoreFocusRef.current) {
        restoreFocusRef.current = false;
        deleteTriggerRef.current?.focus();
      }
    }
  }, [pendingDelete]);

  const flash = (msg: string) => {
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    setNotice(msg);
    noticeTimer.current = window.setTimeout(() => {
      setNotice((n) => (n === msg ? null : n));
      noticeTimer.current = null;
    }, 2600);
  };

  // 只展示普通应用快捷方式：网址/文件夹单独分区，Agent 会话不进入应用网格。
  const visible = useMemo(
    () => targets.filter(
      (t) => !t.hidden && t.target_type === "application" && !removedIds.has(t.id),
    ),
    [targets, removedIds],
  );

  const extras = useMemo(
    () =>
      targets.filter(
        (t) =>
          !t.hidden &&
          !removedIds.has(t.id) &&
          (t.target_type === "url" || t.target_type === "directory" || t.target_type === "file"),
      ),
    [targets, removedIds],
  );

  // 默认顺序沿用应用中心的规则：收藏优先 → 最近使用 → 名称。
  // `last_used_at` / `use_count` 仍来自后端真实计数，这里只做展示排序。
  const ranked = useMemo(() => sortTargetsForDisplay(visible), [visible]);

  const rankedExtras = useMemo(
    () => sortTargetsForDisplay(extras, { recent: false }),
    [extras],
  );

  // 与选择器/应用中心共用同一套搜索规则（中文连续子串、英文大小写、身份绑定别名），
  // 数据范围是「已配置集合」，不是扫描到的全部应用。应用与网址/文件夹都参与搜索，
  // 不再在展示层截断——完整列表由固定高度的内容区滚动承载。
  const filtered = useMemo(() => {
    const q = query.trim();
    if (!q) return { apps: ranked, extras: rankedExtras };
    const filter = (list: NavTarget[]) => {
      const byId = new Map(list.map((t) => [t.id, t]));
      return searchApps(
        list.map((t) => ({
          key: t.id,
          displayName: t.display_name,
          category: t.category,
          exePath: t.exe_path || t.url || t.path,
          identity: t.app_key,
        })),
        q,
      )
        .map((s) => byId.get(s.key))
        .filter((t): t is NavTarget => !!t);
    };
    // 应用网格保持用户手动顺序（未手动排序时就是自然顺序），搜索只过滤不重排；
    // 网址/文件夹没有手动排序语义，仍按收藏 → 名称。
    return {
      apps: filter(ranked),
      extras: sortTargetsForDisplay(filter(rankedExtras), { recent: false }),
    };
  }, [ranked, rankedExtras, query]);

  const extraList = filtered.extras;

  /** 完整网格（所有应用 + 加号），手动顺序在此生效。 */
  const fullGrid = useMemo(
    () => buildAppGrid(ranked, savedOrder),
    [ranked, savedOrder],
  );
  const fullOrder = useMemo(() => fullGrid.map((entry) => entry.id), [fullGrid]);
  /** 搜索命中的应用 id；null = 不过滤。 */
  const matchedIds = useMemo(
    () => (query.trim() ? new Set(filtered.apps.map((t) => t.id)) : null),
    [filtered.apps, query],
  );
  // 加号跟随它前面仍匹配的应用：前面的项被过滤掉时自然前移，不固定跳到末尾。
  const gridEntries = useMemo(
    () => filterAppGrid(fullGrid, matchedIds),
    [fullGrid, matchedIds],
  );

  const launch = async (id: string, name: string) => {
    if (busyId) return;
    setBusyId(id);
    try {
      const res = await navNavigate(id);
      // 与完整面板共用同一结果解释：请求启动 ≠ 已确认启动，请求聚焦 ≠ 已获得焦点，
      // 后端只报 requested-unverified 时如实显示「未核实」，不自行判成功。
      flash(resultMessage(res, name));
      if (res.success) {
        // 成功后刷新共享目标，让网格的「最近使用优先」排序反映真实后端计数。
        // 刷新失败只影响排序展示，不能把已成功的启动说成失败（错误由共享 store 记录）。
        void loadTargets(true);
      }
    } catch (e) {
      flash(`${name}：${launchFailureReason(e)}`);
    } finally {
      setBusyId(null);
    }
  };

  // 「没有配置」与「读取失败」必须分开：targetsError 存在时绝不把旧清单/空清单
  // 伪装成「尚未配置快捷应用」。读取失败且从未成功 → 错误空态（可重试）；
  // 失败但已有旧清单 → 旧清单保留 + 错误提示条。
  const loadError = targetsError !== null;
  const empty = targetsLoaded && !loadError && ranked.length === 0 && extras.length === 0;
  const loadFailedFresh = loadError && !targetsLoaded;
  const loadFailedStale = loadError && targetsLoaded;

  const requestDelete = (t: NavTarget, trigger: HTMLButtonElement) => {
    if (deleteBusy || busyId === t.id) return;
    deleteTriggerRef.current = trigger;
    restoreFocusRef.current = false;
    setPendingDelete(t);
  };

  const cancelDelete = () => {
    if (deleteBusy) return;
    restoreFocusRef.current = true;
    setPendingDelete(null);
  };

  const confirmDelete = async () => {
    if (!pendingDelete || deleteBusy) return;
    const target = pendingDelete;
    setDeleteBusy(true);
    try {
      await navDeleteTarget(target.id);
    } catch (e) {
      const err = normalizeError(e, "nav_delete_target");
      if (err.code === "NOT_FOUND") {
        // 目标已被其他入口删除：等价于删除完成，刷新共享列表并如实提示。
        setRemovedIds((prev) => new Set(prev).add(target.id));
        setPendingDelete(null);
        const [tOutcome, lOutcome] = await Promise.all([loadTargets(true), loadTaskLinks()]);
        if (tOutcome === "ok" && lOutcome === "ok") setRemovedIds(new Set());
        flash(tOutcome === "error" || lOutcome === "error"
          ? "该快捷目标已不存在，但列表刷新失败"
          : "该快捷目标已不存在，列表已刷新");
      } else {
        // 删除失败必须保留应用项，不把配置从列表里误删。
        flash(`删除失败：${err.reason || err.message || "未知错误"}`);
      }
      setDeleteBusy(false);
      return;
    }
    // 删除已成功：先本地隐藏，刷新失败也不回退成「删除失败」。
    setRemovedIds((prev) => new Set(prev).add(target.id));
    setPendingDelete(null);
    const [tOutcome, lOutcome] = await Promise.all([loadTargets(true), loadTaskLinks()]);
    if (tOutcome === "ok" && lOutcome === "ok") setRemovedIds(new Set());
    flash(tOutcome === "error" || lOutcome === "error"
      ? "目标已删除，但列表刷新失败"
      : "目标已删除");
    setDeleteBusy(false);
  };

  // ── 网格排序（应用 + 加号共用）──────────────────────────────
  // 只用原生 HTML5 拖放与键盘移动，不引入拖拽库，也不把加号做成绝对定位浮层。
  const commitOrder = (next: string[]) => {
    if (next.length === 0) return;
    writeAppGridOrder(next);
    setSavedOrder(next);
    // 排序属于用户偏好：防抖镜像到 preferences.json，随完整/快速备份迁移。
    schedulePreferencesMirror();
    flash("顺序已保存");
  };

  const isDropAfter = (event: ReactDragEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return event.clientX > rect.left + rect.width / 2;
  };

  const onDragStart = (event: ReactDragEvent<HTMLElement>, id: string) => {
    dragIdRef.current = id;
    setDragId(id);
    event.dataTransfer.effectAllowed = "move";
    // Firefox/WebView 需要 setData 才会真正开始拖拽；内容本身不参与业务。
    event.dataTransfer.setData("text/plain", id);
  };

  const onDragOver = (event: ReactDragEvent<HTMLElement>, id: string) => {
    const dragged = dragIdRef.current;
    if (!dragged || dragged === id) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const after = isDropAfter(event);
    setDropHint((prev) =>
      prev?.id === id && prev.after === after ? prev : { id, after },
    );
  };

  const endDrag = () => {
    dragIdRef.current = null;
    setDragId(null);
    setDropHint(null);
  };

  const onDrop = (event: ReactDragEvent<HTMLElement>, targetId: string) => {
    const dragged = dragIdRef.current;
    if (!dragged || dragged === targetId) {
      endDrag();
      return;
    }
    event.preventDefault();
    const after = isDropAfter(event);
    lastDropAtRef.current = Date.now();
    commitOrder(moveAppGridId(fullOrder, dragged, targetId, after));
    endDrag();
  };

  /** 拖放结束后浏览器可能补发 click：短时间内挡住误启动。 */
  const consumeDropClick = () => Date.now() - lastDropAtRef.current < 400;

  const onOrderKeyDown = (event: ReactKeyboardEvent<HTMLElement>, id: string) => {
    if (!event.altKey) return;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const next = moveAppGridBy(fullOrder, id, event.key === "ArrowLeft" ? -1 : 1);
    if (next.every((value, index) => value === fullOrder[index])) return;
    commitOrder(next);
  };

  const dropClass = (id: string) => {
    if (dropHint?.id !== id) return "";
    return dropHint.after ? "is-drop-after" : "is-drop-before";
  };

  return (
    <>
      <PanelHead title="应用" sub="常用应用、快捷启动与窗口切换" />

      <SearchField
        value={query}
        onChange={setQuery}
        placeholder="搜索已配置的快捷应用…"
        ariaLabel="搜索快捷应用"
        clearLabel="清除应用搜索"
        size="compact"
        className="cap-search ui-search--capsule"
      />

      {pendingDelete && (
        <div className="cap-confirm" role="alertdialog" aria-label="确认删除快捷目标">
          <p className="cap-confirm-text">
            从快捷列表删除「{pendingDelete.display_name}」？
            <span>只删除 task_dock 中的快捷目标，不会卸载应用或删除程序文件；相关任务关联会一并解除。</span>
          </p>
          <div className="cap-confirm-actions">
            <button
              ref={cancelRef}
              type="button"
              className="cap-mini"
              onClick={cancelDelete}
              disabled={deleteBusy}
            >
              取消
            </button>
            <button
              type="button"
              className="cap-mini cap-confirm-danger"
              onClick={() => void confirmDelete()}
              disabled={deleteBusy || busyId === pendingDelete.id}
            >
              删除
            </button>
          </div>
        </div>
      )}

      <div className="cap-list">
        {loadFailedFresh && (
          <EmptyState
            icon={<LayoutGrid size={22} strokeWidth={1.6} aria-hidden="true" />}
            text="快捷应用读取失败"
            actionLabel="重试"
            onAction={() => void loadTargets()}
          />
        )}

        {loadFailedStale && (
          <div className="cap-item cap-error-row" role="alert">
            <span className="cap-error-text">刷新失败，显示的是上次结果</span>
            <button type="button" className="cap-mini" aria-label="重试读取快捷应用" onClick={() => void loadTargets()}>
              重试
            </button>
          </div>
        )}

        {empty && (
          <EmptyState
            icon={<LayoutGrid size={22} strokeWidth={1.6} aria-hidden="true" />}
            text="尚未配置快捷应用"
          />
        )}

        {targetsLoaded && !loadFailedFresh && (
          <div
            className="cap-app-grid"
            aria-label="应用网格，拖动或在项目上按 Alt+左右方向键调整顺序"
          >
            {gridEntries.map((entry) => {
              if (entry.type === "add") {
                return (
                  <button
                    key={entry.id}
                    type="button"
                    data-grid-id={entry.id}
                    className={`cap-app cap-app-add ${dropClass(entry.id)}`}
                    aria-label="添加应用"
                    draggable={!busyId}
                    onDragStart={(e) => onDragStart(e, entry.id)}
                    onDragEnd={endDrag}
                    onDragOver={(e) => onDragOver(e, entry.id)}
                    onDragLeave={(e) => {
                      const related = e.relatedTarget;
                      if (related instanceof Node && e.currentTarget.contains(related)) return;
                      setDropHint((hint) => (hint?.id === entry.id ? null : hint));
                    }}
                    onDrop={(e) => onDrop(e, entry.id)}
                    onKeyDown={(e) => onOrderKeyDown(e, entry.id)}
                    onClick={() => {
                      if (consumeDropClick()) return;
                      openAppsAdd();
                    }}
                  >
                    <span className="cap-app-avatar is-add" aria-hidden="true">
                      <Plus size={16} strokeWidth={2.4} />
                    </span>
                  </button>
                );
              }
              const t = entry.app;
              return (
                <div
                  key={t.id}
                  data-grid-id={t.id}
                  className={`cap-app-slot ${dragId === t.id ? "is-dragging" : ""} ${dropClass(t.id)}`}
                  onDragOver={(e) => onDragOver(e, t.id)}
                  onDragLeave={(e) => {
                    const related = e.relatedTarget;
                    if (related instanceof Node && e.currentTarget.contains(related)) return;
                    setDropHint((hint) => (hint?.id === t.id ? null : hint));
                  }}
                  onDrop={(e) => onDrop(e, t.id)}
                >
                  <button
                    type="button"
                    data-grid-id={t.id}
                    className="cap-app"
                    aria-label={`启动 ${t.display_name}`}
                    aria-busy={busyId === t.id}
                    disabled={busyId === t.id}
                    draggable={busyId !== t.id}
                    onDragStart={(e) => onDragStart(e, t.id)}
                    onDragEnd={endDrag}
                    onKeyDown={(e) => onOrderKeyDown(e, t.id)}
                    onClick={() => {
                      if (consumeDropClick()) return;
                      void launch(t.id, t.display_name);
                    }}
                  >
                    <span className="cap-app-icon">
                      <AppIcon targetId={t.id} name={t.display_name} size={34} />
                      {busyId === t.id && (
                        <Loader2
                          size={17}
                          strokeWidth={2.2}
                          className="spin cap-app-spinner"
                          aria-hidden="true"
                        />
                      )}
                    </span>
                    <span className="cap-app-name" data-tip={t.display_name}>
                      {t.display_name}
                    </span>
                  </button>
                  {/* 删除是启动的并列兄弟按钮，绝不嵌套在启动按钮内。 */}
                  <button
                    type="button"
                    className="cap-app-del"
                    aria-label={`从快捷列表删除 ${t.display_name}`}
                    disabled={busyId === t.id}
                    onClick={(e) => requestDelete(t, e.currentTarget)}
                  >
                    <X size={12} aria-hidden="true" />
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {extras.length > 0 && !loadFailedFresh && extraList.length > 0 && (
          <div className="cap-recent">
            <span className="cap-recent-title">
              {query.trim() ? "匹配的网址 / 文件夹 / 文件" : "网址 / 文件夹 / 文件"}
            </span>
            <span className="cap-recent-list">
              {extraList.map((t) => (
                <button
                  type="button"
                  key={t.id}
                  className="cap-recent-chip"
                  aria-label={`打开 ${t.display_name}`}
                  data-tip={t.url || t.path}
                  disabled={busyId === t.id}
                  onClick={() => void launch(t.id, t.display_name)}
                >
                  <i
                    className="cap-recent-dot"
                    style={{ "--app-hue": String(avatarHue(t.app_key || t.display_name)) } as CSSProperties}
                    aria-hidden="true"
                  >
                    {(t.display_name || "?").slice(0, 1).toUpperCase()}
                  </i>
                  <span>{t.display_name}</span>
                </button>
              ))}
            </span>
          </div>
        )}

        {query.trim() && filtered.apps.length === 0 && extraList.length === 0 && !loadFailedFresh && (
          <EmptyState
            icon={<Search size={20} strokeWidth={1.6} aria-hidden="true" />}
            text="没有匹配的应用"
          />
        )}
      </div>

      <div className="cap-foot">
        <span className="cap-foot-note">{notice ?? "点击即启动或聚焦已有窗口"}</span>
        <button type="button" className="cap-link" onClick={openAppsManager}>
          管理
        </button>
      </div>
    </>
  );
}
