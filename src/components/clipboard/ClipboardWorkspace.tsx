//! 智能剪贴板工作区：**页面与抽屉共用同一份业务逻辑**。
//!
//! - `variant="page"`：完整模式左侧导航「剪贴板」页，直接占据右侧内容区；
//! - `variant="drawer"`：任务关联 / 紧凑模式下的临时抽屉，遮罩 + 侧滑面板。
//!
//! 两种形态共用同一套状态、订阅与操作逻辑（不复制第二份）：
//! - 数据加载、筛选、分页、多选由 useClipboardStore 统一持有；
//! - 后端变更监听由 store 内部**引用计数**保证全局只有一个 Tauri 监听，
//!   因此页面与抽屉同时存在时不会重复处理同一次采集事件；
//! - Escape 走全局弹层栈：确认框(dialog) → 子弹层(sublayer) → 抽屉(drawer) → 主窗口。

import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle, Clipboard, FolderPlus, Info, Link2, Merge, Pause, Play, RefreshCw, Search,
  Settings as SettingsIcon, Star, Trash2, X,
} from "lucide-react";
import {
  clipboardCopyGroupFiles,
  clipboardCopyGroupRich,
  clipboardCopyItem,
  clipboardCreateGroup,
  clipboardDeleteGroup,
  clipboardDeleteItems,
  clipboardLinkTask,
  clipboardMergeGroups,
  clipboardStatus,
  clipboardToggleGroup,
  clipboardToggleItem,
  type ClipboardGroup,
  type ClipboardItem,
  type ClipboardStatus,
  type CopyReport,
} from "../../lib/bridge";
import { formatBytes } from "../../lib/clipboardUi";
import { useClipboardStore } from "../../store/useClipboardStore";
import { useSettingsStore } from "../../store/useSettingsStore";
import { useUiStore } from "../../store/useUiStore";
import { useFocusTrap, useOverlayLayer } from "../ui/overlay";
import { ConfirmDialog } from "../ui/Dialog";
import ClipboardGroupCard from "./ClipboardGroupCard";
import ClipboardGroupDetail from "./ClipboardGroupDetail";
import ClipboardItemCard from "./ClipboardItemCard";
import ClipboardItemDetail from "./ClipboardItemDetail";
import PastePanel from "./PastePanel";
import type { AskConfirm, ClipboardDetail } from "./types";

const KIND_CHIPS: { id: string; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "text", label: "文字" },
  { id: "url", label: "链接" },
  { id: "html", label: "富文本" },
  { id: "image", label: "图片" },
  { id: "files", label: "文件" },
];

export interface ClipboardWorkspaceProps {
  variant: "page" | "drawer";
  /** 活跃态：false 时不加载、不订阅（面板页离开时避免后台空转） */
  active: boolean;
  /** 抽屉形态的关闭回调 */
  onClose?: () => void;
}

export default function ClipboardWorkspace({ variant, active, onClose }: ClipboardWorkspaceProps) {
  const isDrawer = variant === "drawer";
  const linkTask = useUiStore((s) => s.clipboardLinkTask);
  const closeDrawer = useUiStore((s) => s.closeClipboard);
  const bumpLink = useUiStore((s) => s.bumpClipboardLink);
  const setTab = useUiStore((s) => s.setTab);
  const showToast = useUiStore((s) => s.showToast);
  const settings = useSettingsStore((s) => s.settings);
  const updateSettings = useSettingsStore((s) => s.update);

  const view = useClipboardStore((s) => s.view);
  const filters = useClipboardStore((s) => s.filters);
  const section = useClipboardStore((s) => s.section);
  const searchText = useClipboardStore((s) => s.searchText);
  const loading = useClipboardStore((s) => s.loading);
  const loadingMore = useClipboardStore((s) => s.loadingMore);
  const error = useClipboardStore((s) => s.error);
  const selectedItems = useClipboardStore((s) => s.selectedItems);
  const selectedGroups = useClipboardStore((s) => s.selectedGroups);
  const setFilters = useClipboardStore((s) => s.setFilters);
  const setSection = useClipboardStore((s) => s.setSection);
  const setSearchText = useClipboardStore((s) => s.setSearchText);
  const load = useClipboardStore((s) => s.load);
  const setLive = useClipboardStore((s) => s.setLive);
  const toggleItemSelection = useClipboardStore((s) => s.toggleItemSelection);
  const toggleGroupSelection = useClipboardStore((s) => s.toggleGroupSelection);
  const clearSelection = useClipboardStore((s) => s.clearSelection);

  const [detail, setDetail] = useState<ClipboardDetail | null>(null);
  const [status, setStatus] = useState<ClipboardStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [groupName, setGroupName] = useState("");
  const [mergeName, setMergeName] = useState("");
  const [confirm, setConfirm] = useState<{
    title: string;
    detail?: string;
    confirmLabel: string;
    danger?: boolean;
    run: () => void | Promise<void>;
  } | null>(null);
  const drawerRef = useRef<HTMLElement>(null);

  const askConfirm: AskConfirm = (opts) =>
    setConfirm({
      title: opts.title,
      detail: opts.detail,
      confirmLabel: opts.confirmLabel ?? "确认",
      danger: opts.danger,
      run: opts.run,
    });

  // 打开或筛选变化时拉取
  useEffect(() => {
    if (!active) return;
    void load();
  }, [active, filters.kind, filters.favorite, filters.search, load]);

  // 搜索防抖：输入框即时回显，筛选条件延迟落库
  useEffect(() => {
    if (!active) return;
    const t = window.setTimeout(() => {
      if (searchText !== filters.search) setFilters({ search: searchText });
    }, 260);
    return () => window.clearTimeout(t);
  }, [searchText, active, filters.search, setFilters]);

  // 关联模式固定回到「历史」：上次浏览停在「分组」时直接复用会让用户看不到任何可选条目
  useEffect(() => {
    if (!linkTask) return;
    setSection("items");
    clearSelection();
  }, [linkTask, clearSelection, setSection]);

  // 实时监听：交给 store 统一管理（全局只建一个 Tauri 监听）
  useEffect(() => {
    if (!active) return;
    setLive(true);
    return () => setLive(false);
  }, [active, setLive]);

  // 监听状态（区分「已暂停」与「监听线程未启动」）
  useEffect(() => {
    if (!active) return;
    let alive = true;
    clipboardStatus()
      .then((s) => {
        if (alive) setStatus(s);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [active]);

  // 关闭时重置子视图与确认框
  useEffect(() => {
    if (active) return;
    setDetail(null);
    setConfirm(null);
  }, [active]);

  // 弹层栈：详情子视图 → 抽屉。确认框由 ConfirmDialog 自己注册（dialog，优先级最高）。
  useOverlayLayer("sublayer", active && !!detail, () => setDetail(null));
  // 关联模式（从任务编辑器发起）时，抽屉是**盖在编辑器之上**的模态选择面，
  // Escape 必须先关抽屉而不是编辑器——弹层层级要和视觉层级一致。
  // 因此关联模式按 dialog 注册，并让任务编辑器在抽屉打开期间让出弹层栈。
  useOverlayLayer(linkTask ? "dialog" : "drawer", active && isDrawer, () => (onClose ?? closeDrawer)(), drawerRef);
  // 焦点陷阱：抽屉内 Tab 循环；确认框打开时交由确认框自己接管
  useFocusTrap(active && isDrawer && !confirm, drawerRef);

  // 配置异常优先于 enabled/paused：损坏的配置绝不能显示为“监听中”。
  const configError = status?.configError ?? null;
  const configOrigin = status?.configOrigin ?? null;
  const legacyPaused = !configError && configOrigin === "legacy_upgrade_paused";
  const paused = configError ? true : settings?.clipboard_paused ?? false;
  const enabled = configError ? false : settings?.clipboard_enabled ?? true;
  const monitoringDown = status?.monitoring === false;
  const statusLabel = configError
    ? "配置异常，自动记录已暂停"
    : !enabled
      ? "已停用"
      : paused
        ? "已暂停"
        : monitoringDown
          ? "监听未启动"
          : "监听中";
  const statusTone = configError ? "bad" : !enabled ? "off" : paused ? "paused" : monitoringDown ? "bad" : "ok";
  const stats = view?.stats;

  function reportCopy(r: CopyReport) {
    const warn = r.warnings.length > 0 ? `；${r.warnings.join("；")}` : "";
    showToast(`已复制 ${r.item_count} 项（${r.mode.toUpperCase()}，${formatBytes(r.bytes)}）${warn}`, {
      kind: r.warnings.length > 0 ? "info" : "success",
    });
  }

  async function onCopyItem(item: ClipboardItem) {
    try {
      reportCopy(await clipboardCopyItem(item.id));
      void load({ silent: true });
    } catch (e) {
      showToast(`复制失败：${String(e)}`, { kind: "error" });
    }
  }

  async function onToggleItem(item: ClipboardItem, flag: "favorite" | "pinned") {
    try {
      await clipboardToggleItem(item.id, flag);
      void load({ silent: true });
    } catch (e) {
      showToast(String(e), { kind: "error" });
    }
  }

  function onDeleteItem(item: ClipboardItem) {
    askConfirm({
      title: "删除这条剪贴板历史？",
      detail: item.file_paths.length > 0
        ? "将同时从所属分组和任务关联中移除；文件条目只删除历史记录，不会删除磁盘上的文件。"
        : "将同时从所属分组和任务关联中移除。",
      confirmLabel: "删除",
      danger: true,
      run: async () => {
        const r = await clipboardDeleteItems([item.id]);
        showToast(`已删除 ${r.deleted} 条`, { kind: "success" });
        void load({ silent: true });
      },
    });
  }

  async function onCopyGroup(group: ClipboardGroup, mode: "rich" | "files") {
    setBusy(`${mode}-${group.id}`);
    try {
      const r = mode === "rich"
        ? await clipboardCopyGroupRich(group.id)
        : await clipboardCopyGroupFiles(group.id);
      reportCopy(r);
    } catch (e) {
      showToast(`复制失败：${String(e)}`, { kind: "error" });
    } finally {
      setBusy(null);
    }
  }

  async function onToggleGroup(group: ClipboardGroup, flag: "favorite" | "pinned") {
    try {
      await clipboardToggleGroup(group.id, flag);
      void load({ silent: true });
    } catch (e) {
      showToast(String(e), { kind: "error" });
    }
  }

  function onDeleteGroup(group: ClipboardGroup) {
    askConfirm({
      title: `删除分组「${group.name}」？`,
      detail: "只删除分组本身，分组内的历史条目仍保留。若要连同内容删除，请在分组详情中操作。",
      confirmLabel: "删除分组",
      danger: true,
      run: async () => {
        await clipboardDeleteGroup(group.id, false);
        showToast("分组已删除，历史条目已保留", { kind: "success" });
        void load({ silent: true });
      },
    });
  }

  async function onCreateGroup() {
    if (selectedItems.length === 0) return;
    setBusy("create-group");
    try {
      const g = await clipboardCreateGroup(groupName.trim() || "手动分组", selectedItems);
      setGroupName("");
      clearSelection();
      setSection("groups");
      showToast(`已创建分组「${g.name}」，共 ${g.item_count} 项`, { kind: "success" });
      void load({ silent: true });
    } catch (e) {
      showToast(`创建分组失败：${String(e)}`, { kind: "error" });
    } finally {
      setBusy(null);
    }
  }

  async function onMergeGroups() {
    if (selectedGroups.length < 2) return;
    setBusy("merge");
    try {
      const g = await clipboardMergeGroups(selectedGroups, mergeName.trim() || "合并分组");
      setMergeName("");
      clearSelection();
      setSection("groups");
      showToast(`已合并为「${g.name}」，共 ${g.item_count} 项`, { kind: "success" });
      void load({ silent: true });
    } catch (e) {
      showToast(`合并失败：${String(e)}`, { kind: "error" });
    } finally {
      setBusy(null);
    }
  }

  function onDeleteSelectedItems() {
    const n = selectedItems.length;
    if (n === 0) return;
    askConfirm({
      title: `删除选中的 ${n} 条历史？`,
      detail: "将同时从所属分组和任务关联中移除；文件条目只删除记录，不会删除磁盘文件。",
      confirmLabel: "删除所选",
      danger: true,
      run: async () => {
        const r = await clipboardDeleteItems(selectedItems);
        showToast(`已删除 ${r.deleted} 条`, { kind: "success" });
        clearSelection();
        void load({ silent: true });
      },
    });
  }

  async function onLink(targetType: "item" | "group", targetId: string) {
    if (!linkTask) return;
    try {
      await clipboardLinkTask(linkTask.id, targetType, targetId);
      bumpLink();
      showToast(`已关联到任务「${linkTask.title}」`, { kind: "success" });
      closeDrawer();
    } catch (e) {
      showToast(`关联失败：${String(e)}`, { kind: "error" });
    }
  }

  async function togglePause() {
    try {
      await updateSettings({ clipboard_paused: !paused });
      showToast(!paused ? "已暂停记录新的剪贴板内容" : "已恢复监听", { kind: "success" });
    } catch (e) {
      showToast(`切换失败：${String(e)}`, { kind: "error" });
    }
  }

  function goSettings() {
    setTab("settings");
    if (isDrawer) closeDrawer();
  }

  const filterActive = filters.kind !== "all" || filters.favorite || filters.search.trim() !== "";

  function renderList() {
    if (section === "groups") {
      const groups = view?.groups ?? [];
      if (loading && !view) return <div className="clip-loading">正在加载分组…</div>;
      if (error) {
        return (
          <div className="clip-empty">
            <span>{error}</span>
            <button className="btn sm" onClick={() => void load()}>重试</button>
          </div>
        );
      }
      if (groups.length === 0) {
        return (
          <div className="clip-empty">
            <Clipboard size={22} className="clip-empty-icon" />
            <strong>暂无分组</strong>
            <span>连续截图会自动成组；也可以在历史中勾选条目后手动创建分组。</span>
          </div>
        );
      }
      return (
        <div className="clip-list">
          {groups.map((g) => (
            <ClipboardGroupCard
              key={g.id}
              group={g}
              selected={selectedGroups.includes(g.id)}
              linkMode={!!linkTask}
              onSelect={() => toggleGroupSelection(g.id)}
              onToggle={(flag) => void onToggleGroup(g, flag)}
              onCopyRich={() => void onCopyGroup(g, "rich")}
              onCopyFiles={() => void onCopyGroup(g, "files")}
              onPaste={() => setDetail({ kind: "paste", id: g.id, name: g.name })}
              onDetail={() => setDetail({ kind: "group", id: g.id })}
              onDelete={() => onDeleteGroup(g)}
              onLink={() => void onLink("group", g.id)}
            />
          ))}
        </div>
      );
    }

    const items = view?.items ?? [];
    if (loading && !view) return <div className="clip-loading">正在加载剪贴板历史…</div>;
    if (error) {
      return (
        <div className="clip-empty">
          <span>{error}</span>
          <button className="btn sm" onClick={() => void load()}>重试</button>
        </div>
      );
    }
    if (items.length === 0) {
      return (
        <div className="clip-empty">
          <Clipboard size={22} className="clip-empty-icon" />
          <strong>{filterActive ? "没有符合条件的记录" : "还没有剪贴板记录"}</strong>
          <span>
            {configError
              ? "剪贴板配置异常，自动记录已暂停；请在设置 → 智能剪贴板中修复。"
              : !enabled
                ? "剪贴板记录已停用，可在设置中开启。"
                : paused
                  ? "监听已暂停，恢复后新的复制才会被记录。"
                  : filterActive
                    ? "试试清除搜索或切换类型筛选。"
                    : "复制文字、图片或文件后会自动出现在这里。"}
          </span>
        </div>
      );
    }
    return (
      <>
        <div className="clip-list">
          {items.map((item) => (
            <ClipboardItemCard
              key={item.id}
              item={item}
              selected={selectedItems.includes(item.id)}
              linkMode={!!linkTask}
              onSelect={() => toggleItemSelection(item.id)}
              onCopy={() => void onCopyItem(item)}
              onToggle={(flag) => void onToggleItem(item, flag)}
              onDetail={() => setDetail({ kind: "item", id: item.id })}
              onDelete={() => onDeleteItem(item)}
              onLink={() => void onLink("item", item.id)}
            />
          ))}
        </div>
        {view && view.items.length < view.total_items && (
          <button className="btn sm clip-more" onClick={() => void load({ append: true })} disabled={loadingMore}>
            {loadingMore ? <RefreshCw size={12} className="spin" /> : null}
            加载更多（{view.items.length}/{view.total_items}）
          </button>
        )}
      </>
    );
  }

  const body = (
    <>
      <header className="clip-head">
        <div className="clip-head-title">
          <Clipboard size={15} />
          <span>智能剪贴板</span>
          <span className={`clip-status tone-${statusTone}`}>
            <i /> {statusLabel}
          </span>
        </div>
        <div className="clip-head-actions">
          <button
            className={`icon-btn sm ${paused ? "active" : ""}`}
            data-tip={
              !enabled
                ? "剪贴板记录已停用，请在设置中开启"
                : paused
                  ? "恢复监听"
                  : "暂停记录新的剪贴板内容（仍可查看历史）"
            }
            aria-label={paused ? "恢复监听" : "暂停监听"}
            aria-pressed={paused}
            disabled={!enabled}
            onClick={togglePause}
          >
            {paused ? <Play size={13} /> : <Pause size={13} />}
          </button>
          <button className="icon-btn sm" data-tip="剪贴板设置" aria-label="剪贴板设置" onClick={goSettings}>
            <SettingsIcon size={13} />
          </button>
          {isDrawer && (
            <button className="icon-btn sm" data-tip="关闭 (Esc)" aria-label="关闭剪贴板" onClick={onClose ?? closeDrawer}>
              <X size={14} />
            </button>
          )}
        </div>
      </header>

      {configError && (
        <div className="clip-link-banner clip-config-banner" role="alert">
          <AlertTriangle size={12} />
          <span>
            {configError.message}
            {configError.keys.length > 0 ? `（键：${configError.keys.join("、")}）` : ""}
            。监听线程仍在运行，但不会记录任何新内容；损坏的原始值已保留，可在设置中修复。
          </span>
          <button className="link-btn" onClick={goSettings}>去修复</button>
        </div>
      )}

      {legacyPaused && (
        <div className="clip-link-banner" role="status">
          <Info size={12} />
          <span>从旧版本升级：为避免未经确认的记录，剪贴板自动采集默认保持暂停，Task Dock 不会自行开始记录。</span>
          <button className="link-btn" onClick={goSettings}>去设置</button>
        </div>
      )}

      {linkTask && (
        <div className="clip-link-banner">
          <Link2 size={12} />
          <span>为任务「{linkTask.title}」选择要关联的条目或分组；关联后抽屉会自动关闭。</span>
          <button className="link-btn" onClick={onClose ?? closeDrawer}>取消</button>
        </div>
      )}

      {!detail && (
        <>
          <div className="clip-toolbar">
            <div className="clip-search">
              <Search size={12} />
              <input
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
                placeholder="搜索文字、来源应用、文件名…"
                aria-label="搜索剪贴板历史"
              />
              {searchText && (
                <button className="icon-btn sm" data-tip="清除搜索" aria-label="清除搜索" onClick={() => setSearchText("")}>
                  <X size={11} />
                </button>
              )}
            </div>
            <button
              className={`icon-btn sm ${filters.favorite ? "active" : ""}`}
              data-tip={filters.favorite ? "显示全部" : "只看收藏"}
              aria-label={filters.favorite ? "显示全部条目" : "只看收藏"}
              aria-pressed={filters.favorite}
              onClick={() => setFilters({ favorite: !filters.favorite })}
            >
              <Star size={13} />
            </button>
          </div>
          <div className="seg-group subtle clip-chips" role="group" aria-label="类型筛选">
            {KIND_CHIPS.map((k) => (
              <button
                key={k.id}
                className={`seg-btn ${filters.kind === k.id ? "active" : ""}`}
                aria-pressed={filters.kind === k.id}
                onClick={() => setFilters({ kind: k.id })}
              >
                {k.label}
              </button>
            ))}
          </div>
          <div className="clip-tabs" role="tablist" aria-label="剪贴板视图">
            <button
              role="tab"
              aria-selected={section === "items"}
              className={section === "items" ? "active" : ""}
              onClick={() => {
                setSection("items");
                clearSelection();
              }}
            >
              历史 <em>{view?.total_items ?? 0}</em>
            </button>
            <button
              role="tab"
              aria-selected={section === "groups"}
              className={section === "groups" ? "active" : ""}
              onClick={() => {
                setSection("groups");
                clearSelection();
              }}
            >
              分组 <em>{view?.groups.length ?? 0}</em>
            </button>
          </div>
        </>
      )}

      <div className="clip-body">
        {detail?.kind === "item" ? (
          <ClipboardItemDetail
            itemId={detail.id}
            linkTask={linkTask}
            askConfirm={askConfirm}
            onBack={() => setDetail(null)}
            onChanged={() => void load({ silent: true })}
          />
        ) : detail?.kind === "group" ? (
          <ClipboardGroupDetail
            groupId={detail.id}
            linkTask={linkTask}
            askConfirm={askConfirm}
            onBack={() => setDetail(null)}
            onChanged={() => void load({ silent: true })}
          />
        ) : detail?.kind === "paste" ? (
          <PastePanel groupId={detail.id} groupName={detail.name} onBack={() => setDetail(null)} />
        ) : (
          renderList()
        )}
      </div>

      {!detail && section === "items" && selectedItems.length > 0 && (
        <div className="clip-selectbar">
          <span>{selectedItems.length} 项已选</span>
          <input
            value={groupName}
            onChange={(e) => setGroupName(e.target.value)}
            placeholder="新分组名称"
            aria-label="新分组名称"
            maxLength={80}
          />
          <button className="btn sm primary" onClick={onCreateGroup} disabled={busy !== null}>
            {busy === "create-group" ? <RefreshCw size={11} className="spin" /> : <FolderPlus size={11} />} 创建分组
          </button>
          <button className="btn sm danger" onClick={onDeleteSelectedItems} disabled={busy !== null}>
            <Trash2 size={11} /> 删除所选
          </button>
          <button className="icon-btn sm" onClick={clearSelection} data-tip="取消选择" aria-label="取消选择">
            <X size={12} />
          </button>
        </div>
      )}

      {!detail && section === "groups" && selectedGroups.length > 0 && (
        <div className="clip-selectbar">
          <span>{selectedGroups.length} 个分组已选</span>
          <input
            value={mergeName}
            onChange={(e) => setMergeName(e.target.value)}
            placeholder="合并后的分组名称"
            aria-label="合并后的分组名称"
            maxLength={80}
          />
          <button
            className="btn sm primary"
            onClick={onMergeGroups}
            disabled={selectedGroups.length < 2 || busy !== null}
            title={selectedGroups.length < 2 ? "至少选择两个分组" : "按选择顺序合并"}
          >
            {busy === "merge" ? <RefreshCw size={11} className="spin" /> : <Merge size={11} />} 合并
          </button>
          <button className="icon-btn sm" onClick={clearSelection} data-tip="取消选择" aria-label="取消选择">
            <X size={12} />
          </button>
        </div>
      )}

      <footer className="clip-foot">
        <span className={`clip-status tone-${statusTone}`}><i />{statusLabel}</span>
        <span>{stats?.items ?? 0} 条 · {stats?.groups ?? 0} 组</span>
        <span>图片缓存 {formatBytes(stats?.asset_bytes ?? 0)}</span>
        <button className="link-btn" onClick={goSettings}>
          <SettingsIcon size={11} /> 剪贴板设置
        </button>
      </footer>
    </>
  );

  return (
    <>
      {isDrawer ? (
        <div className={`clipboard-layer${linkTask ? " link-mode" : ""}`}>
          <div className="clipboard-scrim" aria-hidden onMouseDown={onClose ?? closeDrawer} />
          <section
            className="clipboard-drawer"
            role="dialog"
            aria-modal="true"
            aria-label="智能剪贴板"
            ref={drawerRef}
            tabIndex={-1}
          >
            {body}
          </section>
        </div>
      ) : (
        <div className="clipboard-page" role="region" aria-label="智能剪贴板">
          {body}
        </div>
      )}

      <ConfirmDialog
        open={!!confirm}
        title={confirm?.title ?? ""}
        detail={confirm?.detail}
        confirmLabel={confirm?.confirmLabel}
        danger={confirm?.danger}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          const run = confirm?.run;
          setConfirm(null);
          if (run) Promise.resolve(run()).catch((e) => showToast(String(e), { kind: "error" }));
        }}
      />
    </>
  );
}
