//! 智能剪贴板抽屉：标题栏唯一入口，次级面板，不占用主标签页。
//! 历史 / 分组 / 逐项粘贴 / 任务关联 / Agent 本地导出；所有写入与自动化均为显式操作。

import { useEffect, useRef, useState } from "react";
import {
  Clipboard, FolderPlus, Link2, Merge, Pause, Play, RefreshCw, Search,
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
  onClipboardChanged,
  type ClipboardGroup,
  type ClipboardItem,
  type ClipboardStatus,
  type CopyReport,
} from "../../lib/bridge";
import { formatBytes } from "../../lib/clipboardUi";
import { useClipboardStore } from "../../store/useClipboardStore";
import { useSettingsStore } from "../../store/useSettingsStore";
import { useUiStore } from "../../store/useUiStore";
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

export default function ClipboardDrawer() {
  const open = useUiStore((s) => s.clipboardOpen);
  const linkTask = useUiStore((s) => s.clipboardLinkTask);
  const closeDrawer = useUiStore((s) => s.closeClipboard);
  const bumpLink = useUiStore((s) => s.bumpClipboardLink);
  const setTab = useUiStore((s) => s.setTab);
  const showToast = useUiStore((s) => s.showToast);
  const settings = useSettingsStore((s) => s.settings);
  const updateSettings = useSettingsStore((s) => s.update);

  const view = useClipboardStore((s) => s.view);
  const filters = useClipboardStore((s) => s.filters);
  const loading = useClipboardStore((s) => s.loading);
  const loadingMore = useClipboardStore((s) => s.loadingMore);
  const error = useClipboardStore((s) => s.error);
  const selectedItems = useClipboardStore((s) => s.selectedItems);
  const selectedGroups = useClipboardStore((s) => s.selectedGroups);
  const setFilters = useClipboardStore((s) => s.setFilters);
  const load = useClipboardStore((s) => s.load);
  const toggleItemSelection = useClipboardStore((s) => s.toggleItemSelection);
  const toggleGroupSelection = useClipboardStore((s) => s.toggleGroupSelection);
  const clearSelection = useClipboardStore((s) => s.clearSelection);

  const [tab, setLocalTab] = useState<"items" | "groups">("items");
  const [searchInput, setSearchInput] = useState(filters.search);
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
    if (!open) return;
    void load();
  }, [open, filters.kind, filters.favorite, filters.search, load]);

  // 搜索防抖
  useEffect(() => {
    const t = window.setTimeout(() => {
      if (searchInput !== filters.search) setFilters({ search: searchInput });
    }, 260);
    return () => window.clearTimeout(t);
  }, [searchInput]);

  // 从任务编辑器进入关联模式时固定回到「历史」：抽屉常驻挂载，
  // 上次浏览停在「分组」时直接复用会让用户看不到任何可选条目。
  useEffect(() => {
    if (!linkTask) return;
    setLocalTab("items");
    clearSelection();
  }, [linkTask, clearSelection]);

  // 监听后端变更（采集 / 操作 / 清理），合并短时间内的多次事件
  useEffect(() => {
    if (!open) return;
    let alive = true;
    let unlisten: (() => void) | undefined;
    let timer: number | undefined;
    onClipboardChanged(() => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        void load({ silent: true });
      }, 300);
    }).then((u) => {
      if (alive) unlisten = u;
      else u();
    });
    return () => {
      alive = false;
      if (timer) window.clearTimeout(timer);
      unlisten?.();
    };
  }, [open, load]);

  // 监听状态（区分「已暂停」与「监听线程未启动」）
  useEffect(() => {
    if (!open) return;
    let alive = true;
    clipboardStatus()
      .then((s) => {
        if (alive) setStatus(s);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [open]);

  // 关闭时重置子视图与确认框；打开时聚焦抽屉
  useEffect(() => {
    if (!open) {
      setDetail(null);
      setConfirm(null);
      return;
    }
    const raf = requestAnimationFrame(() => drawerRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [open]);

  // Escape：确认框 → 子视图 → 抽屉（标题栏已避让，不会隐藏窗口）
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (confirm) {
        setConfirm(null);
        e.preventDefault();
        return;
      }
      if (detail) {
        setDetail(null);
        e.preventDefault();
        return;
      }
      closeDrawer();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, confirm, detail, closeDrawer]);

  if (!open) return null;

  const paused = settings?.clipboard_paused ?? false;
  const enabled = settings?.clipboard_enabled ?? true;
  const monitoringDown = status?.monitoring === false;
  const statusLabel = !enabled ? "已停用" : paused ? "已暂停" : monitoringDown ? "监听未启动" : "监听中";
  const statusTone = !enabled ? "off" : paused ? "paused" : monitoringDown ? "bad" : "ok";
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
      setLocalTab("groups");
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
      setLocalTab("groups");
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
    closeDrawer();
  }

  const filterActive = filters.kind !== "all" || filters.favorite || filters.search.trim() !== "";

  function renderList() {
    if (tab === "groups") {
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
            {!enabled
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

  return (
    <div className={`clipboard-layer${linkTask ? " link-mode" : ""}`}>
      <div className="clipboard-scrim" aria-hidden onMouseDown={closeDrawer} />
      <section
        className="clipboard-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="智能剪贴板"
        ref={drawerRef}
        tabIndex={-1}
      >
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
              title={
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
            <button className="icon-btn sm" title="剪贴板设置" aria-label="剪贴板设置" onClick={goSettings}>
              <SettingsIcon size={13} />
            </button>
            <button className="icon-btn sm" title="关闭 (Esc)" aria-label="关闭剪贴板" onClick={closeDrawer}>
              <X size={14} />
            </button>
          </div>
        </header>

        {linkTask && (
          <div className="clip-link-banner">
            <Link2 size={12} />
            <span>为任务「{linkTask.title}」选择要关联的条目或分组；关联后抽屉会自动关闭。</span>
            <button className="link-btn" onClick={closeDrawer}>取消</button>
          </div>
        )}

        {!detail && (
          <>
            <div className="clip-toolbar">
              <div className="clip-search">
                <Search size={12} />
                <input
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  placeholder="搜索文字、来源应用、文件名…"
                  aria-label="搜索剪贴板历史"
                />
                {searchInput && (
                  <button className="icon-btn sm" title="清除搜索" aria-label="清除搜索" onClick={() => setSearchInput("")}>
                    <X size={11} />
                  </button>
                )}
              </div>
              <button
                className={`icon-btn sm ${filters.favorite ? "active" : ""}`}
                title={filters.favorite ? "显示全部" : "只看收藏"}
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
                aria-selected={tab === "items"}
                className={tab === "items" ? "active" : ""}
                onClick={() => {
                  setLocalTab("items");
                  clearSelection();
                }}
              >
                历史 <em>{view?.total_items ?? 0}</em>
              </button>
              <button
                role="tab"
                aria-selected={tab === "groups"}
                className={tab === "groups" ? "active" : ""}
                onClick={() => {
                  setLocalTab("groups");
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

        {!detail && tab === "items" && selectedItems.length > 0 && (
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
            <button className="icon-btn sm" onClick={clearSelection} title="取消选择" aria-label="取消选择">
              <X size={12} />
            </button>
          </div>
        )}

        {!detail && tab === "groups" && selectedGroups.length > 0 && (
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
            <button className="icon-btn sm" onClick={clearSelection} title="取消选择" aria-label="取消选择">
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
      </section>

      {confirm && (
        <div
          className="clip-confirm-mask"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setConfirm(null);
          }}
        >
          <div className="clip-confirm" role="alertdialog" aria-modal="true" aria-label={confirm.title}>
            <strong>{confirm.title}</strong>
            {confirm.detail && <p>{confirm.detail}</p>}
            <div className="clip-confirm-actions">
              <button className="btn sm" onClick={() => setConfirm(null)}>取消</button>
              <button
                className={`btn sm ${confirm.danger ? "danger" : "primary"}`}
                onClick={() => {
                  const run = confirm.run;
                  setConfirm(null);
                  Promise.resolve(run()).catch((e) => showToast(String(e), { kind: "error" }));
                }}
              >
                {confirm.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
