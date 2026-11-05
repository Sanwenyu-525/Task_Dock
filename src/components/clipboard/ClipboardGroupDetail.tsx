//! 分组详情：顺序、重命名、结束收集、整组复制与粘贴为主操作；
//! 拆分、上移/下移等整理类高级操作收进「整理与拆分」模式，默认不占每条的主区域。

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowDown, ArrowLeft, ArrowUp, CheckSquare, Copy, Files, Image as ImageIcon, Link2, ListChecks, Pencil,
  Play, Scissors, Square, Star, Pin, Trash2, X,
} from "lucide-react";
import {
  clipboardCloseGroup,
  clipboardCopyGroupFiles,
  clipboardCopyGroupRich,
  clipboardDeleteGroup,
  clipboardGroup,
  clipboardLinkTask,
  clipboardMoveGroupItem,
  clipboardRemoveGroupItem,
  clipboardRenameGroup,
  clipboardSplitGroup,
  clipboardToggleGroup,
  type ClipboardGroup,
  type ClipboardItem,
  type CopyReport,
} from "../../lib/bridge";
import { copyPreflight, formatBytes, groupDeleteFeedback, groupModeLabel, groupStatusLabel, kindLabel, objectHint } from "../../lib/clipboardUi";
import { errorMessage } from "../../lib/errors";
import { EXIT_MS, REORDER_MS, prefersReducedMotion } from "../../lib/motion";
import { useClipboardStore } from "../../store/useClipboardStore";
import { useUiStore } from "../../store/useUiStore";
import AgentExportPanel from "./AgentExportPanel";
import ClipboardItemDetail from "./ClipboardItemDetail";
import ImageLightbox from "./ImageLightbox";
import { ClipboardThumb, useThumbnail } from "./Media";
import PastePanel from "./PastePanel";
import TaskLinkBar from "./TaskLinkBar";
import WorkspaceLinkBar from "./WorkspaceLinkBar";
import type { AskConfirm, LinkTask } from "./types";

export default function ClipboardGroupDetail({
  groupId,
  linkTask,
  askConfirm,
  onBack,
  onChanged,
}: {
  groupId: string;
  linkTask: LinkTask;
  askConfirm: AskConfirm;
  onBack: () => void;
  onChanged: () => void;
}) {
  const showToast = useUiStore((s) => s.showToast);
  const bumpLink = useUiStore((s) => s.bumpClipboardLink);
  const closeDrawer = useUiStore((s) => s.closeClipboard);
  const [group, setGroup] = useState<ClipboardGroup | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [nameInput, setNameInput] = useState("");
  const [splitSelected, setSplitSelected] = useState<string[]>([]);
  const [splitName, setSplitName] = useState("");
  /** 整理模式：显示拆分选择与上移/下移（高级操作），默认只显示主操作 */
  const [tidy, setTidy] = useState(false);
  const [itemDetailId, setItemDetailId] = useState<string | null>(null);
  /** 分组内容里点缩略图直接打开的原图灯箱 */
  const [previewImage, setPreviewImage] = useState<ClipboardItem | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  /**
   * 正在离场的行：`group` 立刻落到服务端结果，这些行作为视觉快照按原位多渲染一会，
   * 各自的定时器到点只摘掉自己。连续移除多行时互不覆盖，也不会把旧顺序写回去。
   */
  const [exitRows, setExitRows] = useState<{ row: ClipboardItem; index: number; height: number }[]>([]);
  const rowListRef = useRef<HTMLUListElement>(null);
  const rowEls = useRef(new Map<string, HTMLLIElement>());
  const topsRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  const rowTimers = useRef<number[]>([]);
  const backRef = useRef<HTMLButtonElement>(null);

  useEffect(
    () => () => {
      rowTimers.current.forEach((t) => window.clearTimeout(t));
      rowTimers.current = [];
    },
    [],
  );

  const exitingRows = new Map(exitRows.map((e) => [e.row.id, e]));
  const rows = (() => {
    let out = group?.items ?? [];
    for (const e of [...exitRows].sort((a, b) => a.index - b.index)) {
      if (out.some((i) => i.id === e.row.id)) continue;
      const at = Math.min(e.index, out.length);
      out = [...out.slice(0, at), e.row, ...out.slice(at)];
    }
    return out;
  })();
  const rowOrder = (group?.items.map((i) => i.id).join("|") ?? "") + `#${exitRows.length}`;
  /**
   * 纯图片分组（且不在整理模式）用双列缩略图卡片：一屏能看更多截图，右侧不再留大片空白。
   * 混合分组必须保留原顺序列表，文字/文件/图片的先后不能被网格打乱。
   * 整理/拆分仍在顺序列表里完成，进入整理模式即切回列表，退出恢复双列。
   */
  const showGrid = !tidy && rows.length > 0 && rows.every((r) => r.kind === "image");
  /** 灯箱只在这张分组内的图片之间切换，顺序与分组真实顺序一致（跳过文字/文件）。 */
  const groupImages = rows.filter((r) => r.kind === "image");

  /**
   * 离场结束后焦点要去的相邻行：在实际展示顺序（含仍在离场的行）里，
   * 找被移除行之后第一个会留下的行；没有则往前提一个。
   * `gone` 是这次操作要离开的所有行（拆分时是多行）。
   */
  function rowAnchor(gone: string[]): string | null {
    const goneSet = new Set(gone);
    const first = rows.findIndex((r) => goneSet.has(r.id));
    if (first < 0) return null;
    const alive = (r: ClipboardItem) => !goneSet.has(r.id) && !exitingRows.has(r.id);
    const next = rows.slice(first + 1).find(alive);
    const prev = rows.slice(0, first).reverse().find(alive);
    return (next ?? prev)?.id ?? null;
  }

  /**
   * 让一行以收拢淡出离场：高度在还以正常高度渲染时实测一次，
   * 各行的定时器只摘掉自己；结束时把焦点交还给相邻行或返回按钮。
   */
  function scheduleRowExit(row: ClipboardItem, index: number, height: number, anchorId: string | null) {
    setExitRows((prev) => [...prev, { row, index, height }]);
    const timer = window.setTimeout(
      () => {
        rowTimers.current = rowTimers.current.filter((t) => t !== timer);
        setExitRows((prev) => prev.filter((e) => e.row.id !== row.id));
        if (anchorId) {
          const el = rowListRef.current?.querySelector<HTMLElement>(
            `[data-clip-row="${CSS.escape(anchorId)}"] :is(.clip-group-item-main, .clip-shot-info)`,
          );
          // 锚点行也可能已进入离场（inert 接管不了焦点），这时退回返回按钮
          if (el && !el.closest("[inert]")) {
            el.focus();
            return;
          }
        }
        backRef.current?.focus();
      },
      prefersReducedMotion() ? 0 : EXIT_MS,
    );
    rowTimers.current.push(timer);
  }

  /**
   * 上移/下移的轻量 FLIP：只在这几行之间做一次位移补偿动画。
   *
   * 不引动画库、不常驻监听：读一次各行的位置、用 Web Animations API 播完即走。
   * 减少动态模式下不做位移；行数过多时跳过（逐行读布局会让长列表掉帧）；
   * 列表布局离场开始/结束都跳过——收拢动画已在表达「下方行上移」，再叠 FLIP
   * 会让这些行先跳回去再滑一遍。网格布局离场不收缩高度，只在移除那一帧补一次
   * x/y 位移，避免补位瞬间跳动。离场进行中永远优先于重排。
   */
  const prevExitCountRef = useRef(0);
  useEffect(() => {
    prevExitCountRef.current = exitRows.length;
  }, [exitRows.length]);
  const prevGridRef = useRef(showGrid);
  useLayoutEffect(() => {
    const el = rowListRef.current;
    if (!el) {
      topsRef.current = new Map();
      return;
    }
    const list = Array.from(el.querySelectorAll<HTMLElement>("[data-clip-row]"));
    const grid = showGrid;
    const gridChanged = prevGridRef.current !== grid;
    prevGridRef.current = grid;
    const base = el.getBoundingClientRect();
    const positions = new Map<string, { x: number; y: number }>();
    for (const r of list) {
      const rect = r.getBoundingClientRect();
      positions.set(r.dataset.clipRow ?? "", { x: rect.left - base.left, y: rect.top - base.top });
    }
    const prev = topsRef.current;
    const prevExiting = prevExitCountRef.current;
    topsRef.current = positions;
    if (prefersReducedMotion() || list.length > 60 || gridChanged) return;
    // 离场优先于重排：离场进行中一律不叠 FLIP
    if (exitRows.length > 0) return;
    // 列表布局：收拢动画已经表达「下方上移」，结束那帧再 FLIP 会先闪回原位再滑一遍
    if (!grid && prevExiting > 0) return;
    // 网格布局：离场只淡出轻缩、不收拢高度，补位发生在移除后的这一帧，用一次位移补偿
    for (const r of list) {
      const id = r.dataset.clipRow ?? "";
      const before = prev.get(id);
      const now = positions.get(id);
      if (!before || !now || typeof r.animate !== "function") continue;
      const dx = before.x - now.x;
      const dy = before.y - now.y;
      if (dx === 0 && dy === 0) continue;
      r.animate(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0, 0)" }],
        { duration: REORDER_MS, easing: "ease" },
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowOrder, showGrid]);
  async function reload() {
    try {
      const g = await clipboardGroup(groupId);
      setGroup(g);
      setNameInput(g.name);
      return g;
    } catch (e) {
      showToast(`读取分组失败：${errorMessage(e)}`, { kind: "error" });
      return null;
    }
  }

  useEffect(() => {
    let alive = true;
    setGroup(null);
    setSplitSelected([]);
    setRenaming(false);
    setItemDetailId(null);
    clipboardGroup(groupId)
      .then((g) => {
        if (alive) {
          setGroup(g);
          setNameInput(g.name);
        }
      })
      .catch((e) => {
        if (alive) {
          showToast(`读取分组失败：${errorMessage(e)}`, { kind: "error" });
          onBack();
        }
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupId]);

  function reportCopy(r: CopyReport) {
    const warn = r.warnings.length > 0 ? `；${r.warnings.join("；")}` : "";
    // 写入成功即成功；统计/降级项未完成时显示「部分成功」，不报告成复制失败
    const partial = r.warnings.length > 0 || r.stats_recorded === false;
    showToast(
      `${partial ? "已复制（部分成功）" : "已复制"} ${r.item_count} 项（${r.mode.toUpperCase()}，${formatBytes(r.bytes)}）${warn}`,
      { kind: partial ? "info" : "success" },
    );
  }

  async function onCopyRich() {
    setBusy("copy-rich");
    try {
      reportCopy(await clipboardCopyGroupRich(groupId));
    } catch (e) {
      showToast(`复制富文本失败：${errorMessage(e)}`, { kind: "error" });
    } finally {
      setBusy(null);
    }
  }

  async function onCopyFiles() {
    setBusy("copy-files");
    try {
      reportCopy(await clipboardCopyGroupFiles(groupId));
    } catch (e) {
      showToast(`复制文件失败：${errorMessage(e)}`, { kind: "error" });
    } finally {
      setBusy(null);
    }
  }

  async function onToggle(flag: "favorite" | "pinned") {
    try {
      const updated = await clipboardToggleGroup(groupId, flag);
      setGroup(updated);
      // 排序可能因置顶而变，静默刷新拿新顺序；图标已经就地翻转，不用等这一趟
      showToast(
        flag === "favorite"
          ? updated.favorite ? "已收藏分组" : "已取消收藏，内容仍保留在历史中"
          : updated.pinned ? "已置顶分组，将排到前面" : "已取消置顶分组",
        { kind: "success" },
      );
      onChanged();
    } catch (e) {
      showToast(`更新分组置顶失败：${errorMessage(e)}`, { kind: "error" });
    }
  }

  async function onCloseGroup() {
    setBusy("close");
    try {
      setGroup(await clipboardCloseGroup(groupId));
      showToast("分组已结束收集；之后的新截图会开启新分组", { kind: "success" });
      onChanged();
    } catch (e) {
      showToast(`结束分组失败：${errorMessage(e)}`, { kind: "error" });
    } finally {
      setBusy(null);
    }
  }

  async function onRename() {
    if (!nameInput.trim()) return;
    setBusy("rename");
    try {
      setGroup(await clipboardRenameGroup(groupId, nameInput.trim()));
      setRenaming(false);
      onChanged();
    } catch (e) {
      showToast(`重命名失败：${errorMessage(e)}`, { kind: "error" });
    } finally {
      setBusy(null);
    }
  }

  async function onMove(itemId: string, delta: -1 | 1) {
    if (!group) return;
    const idx = group.items.findIndex((i) => i.id === itemId);
    if (idx < 0 || idx + delta < 0 || idx + delta >= group.items.length) return;
    setBusy("move");
    try {
      setGroup(await clipboardMoveGroupItem(groupId, itemId, idx + delta));
      onChanged();
    } catch (e) {
      showToast(`排序失败：${errorMessage(e)}`, { kind: "error" });
    } finally {
      setBusy(null);
    }
  }

  async function onRemove(itemId: string) {
    // 位置必须按**实际展示顺序**（含仍在离场的行）计算：连续移除时后端列表
    // 已经少了先前移除的条目，按 group.items 找索引会让后移除的行钉到
    // 已离场行的前面，顺序错乱。
    const displayIndex = rows.findIndex((r) => r.id === itemId);
    const row = displayIndex >= 0 ? rows[displayIndex] : undefined;
    const anchorId = row ? rowAnchor([itemId]) : null;
    // 高度在请求发出前测一次：此时这一行一定还以正常高度渲染
    const height = row ? (rowEls.current.get(itemId)?.offsetHeight ?? 0) : 0;
    setBusy("remove");
    try {
      const next = await clipboardRemoveGroupItem(groupId, itemId);
      setGroup(next);
      setSplitSelected((s) => s.filter((x) => x !== itemId));
      showToast(
        row
          ? `已把「${objectHint(row)}」从分组移除，内容仍保留在历史中`
          : "已从分组移除（内容仍保留在历史中）",
        { kind: "info" },
      );
      onChanged();
      if (row) {
        // 后端已经解除关联；先让这一行收拢淡出，动画结束只摘掉自己。
        scheduleRowExit(row, displayIndex, height, anchorId);
      }
    } catch (e) {
      showToast(`从分组移除失败：${errorMessage(e)}`, { kind: "error" });
    } finally {
      setBusy(null);
    }
  }

  async function onSplit() {
    if (splitSelected.length === 0) return;
    const before = group?.items.length ?? 0;
    setBusy("split");
    try {
      const g = await clipboardSplitGroup(groupId, splitSelected, splitName.trim() || "拆分分组");
      const movedCount = Math.max(0, before - g.items.length);
      // 拆分成功的条目用与移除一致的收拢离场；失败走 catch，不播任何成功动画。
      // 焦点锚点对所有被拆行统一取一次（拆分块之后的第一个存活行）。
      const anchorId = rowAnchor(splitSelected);
      const leaving = rows
        .filter((r) => splitSelected.includes(r.id))
        .map((r) => ({
          row: r,
          index: rows.findIndex((x) => x.id === r.id),
          height: rowEls.current.get(r.id)?.offsetHeight ?? 0,
        }));
      setSplitSelected([]);
      setSplitName("");
      for (const e of leaving) scheduleRowExit(e.row, e.index, e.height, anchorId);
      // 服务端已把条目移入新分组：刷新拿到真实数据，被拆行由快照按原位钉住
      // 播完离场，剩余行不会被挤跳。
      await reload();
      showToast(
        `已把 ${movedCount} 项拆分为新分组，本分组剩 ${g.items.length} 项`,
        { kind: "success" },
      );
      onChanged();
    } catch (e) {
      showToast(`拆分失败：${errorMessage(e)}`, { kind: "error" });
    } finally {
      setBusy(null);
    }
  }

  async function onLinkGroup() {
    if (!linkTask) return;
    try {
      await clipboardLinkTask(linkTask.id, "group", groupId);
      bumpLink();
      showToast(`已关联到任务「${linkTask.title}」`, { kind: "success" });
      closeDrawer();
    } catch (e) {
      showToast(`关联失败：${errorMessage(e)}`, { kind: "error" });
    }
  }

  function onDelete(alsoItems: boolean) {
    if (!group) return;
    askConfirm({
      title: `删除分组「${group.name}」？`,
      detail: alsoItems
        ? "分组内容会一并删除；仍被其他分组或任务引用的条目会保留。"
        : "只删除分组本身，分组内的历史条目仍保留在历史列表。",
      confirmLabel: alsoItems ? "删除分组及内容" : "删除分组",
      danger: true,
      run: async () => {
        try {
          const r = await clipboardDeleteGroup(groupId, alsoItems);
          // 判定与文案和卡片列表共用：`deleted` 只统计条目，分组删没删看 groups_deleted
          const feedback = groupDeleteFeedback(group.name, alsoItems, r);
          if (!feedback.removed) {
            // 并发下已被别处删掉：不演成功、不本地移除，交给刷新定性
            showToast(feedback.message, { kind: feedback.kind });
            onChanged();
            onBack();
            return;
          }
          showToast(feedback.message, { kind: feedback.kind });
          // 立刻从本地视图摘掉已确认删除的内容：否则返回列表时到下一次刷新落地之前，
          // 会短暂看到已经删掉的东西。有条目因仍被引用而保留时分不清是哪几条，
          // 宁可让刷新来定性，也不能把保留的条目本地抹掉（看起来像丢数据）。
          const gone = [groupId];
          if (alsoItems && r.retained_shared === 0) gone.push(...group.items.map((i) => i.id));
          useClipboardStore.getState().endExit(gone);
          onChanged();
          onBack();
        } catch (e) {
          showToast(`删除分组失败：${errorMessage(e)}`, { kind: "error" });
        }
      },
    });
  }

  if (itemDetailId) {
    return (
      <ClipboardItemDetail
        itemId={itemDetailId}
        linkTask={linkTask}
        askConfirm={askConfirm}
        onBack={async () => {
          setItemDetailId(null);
          await reload();
        }}
        onChanged={() => {
          void reload();
          onChanged();
        }}
      />
    );
  }

  if (pasteOpen && group) {
    return (
      <PastePanel groupId={group.id} groupName={group.name} onBack={() => setPasteOpen(false)} />
    );
  }

  if (!group) {
    return (
      <div className="clip-detail">
        <div className="clip-detail-head">
          <button className="icon-btn sm" onClick={onBack} data-tip="返回" aria-label="返回分组列表">
            <ArrowLeft size={13} />
          </button>
          <span>分组详情</span>
        </div>
        <div className="clip-loading">正在读取分组…</div>
      </div>
    );
  }

  const preflight = copyPreflight(group.items);

  return (
    <div className="clip-detail">
      <div className="clip-detail-head">
        <button
          className="icon-btn sm"
          onClick={onBack}
          data-tip="返回"
          aria-label="返回分组列表"
          ref={backRef}
        >
          <ArrowLeft size={13} />
        </button>
        <span className="clip-group-title" title={group.name}>{group.name}</span>
        <div className="clip-detail-actions">
          <button
            className={`icon-btn sm ${group.pinned ? "active" : ""}`}
            data-tip={group.pinned ? "取消置顶" : "置顶分组"}
            aria-label={group.pinned ? "取消置顶" : "置顶分组"}
            aria-pressed={group.pinned}
            onClick={() => onToggle("pinned")}
          >
            <Pin size={12} />
          </button>
          <button
            className={`icon-btn sm ${group.favorite ? "active" : ""}`}
            data-tip={group.favorite ? "取消收藏" : "收藏分组"}
            aria-label={group.favorite ? "取消收藏" : "收藏分组"}
            aria-pressed={group.favorite}
            onClick={() => onToggle("favorite")}
          >
            <Star size={12} />
          </button>
          <button
            className="icon-btn sm danger-ghost"
            data-tip="删除分组（保留条目）"
            aria-label="删除分组（保留条目）"
            onClick={() => onDelete(false)}
          >
            <Trash2 size={12} />
          </button>
        </div>
      </div>

      <div className="clip-detail-body">
        <div className="clip-detail-meta">
          <span className={`clip-badge ${group.status === "collecting" ? "live" : ""}`}>
            {groupStatusLabel(group.status)}
          </span>
          <span>{groupModeLabel(group.mode)}分组</span>
          <span>{group.item_count} 项 / {group.image_count} 张图片</span>
          <span>更新 {group.updated_at.slice(0, 16).replace("T", " ")}</span>
        </div>

        {linkTask && (
          <button className="btn sm primary clip-link-current" onClick={onLinkGroup}>
            <Link2 size={11} /> 关联到任务「{linkTask.title}」
          </button>
        )}

        {preflight.warnings.length > 0 && (
          <div className="clip-hint clip-copy-preflight" aria-label="整组复制预检">
            整组 {group.item_count} 项 · 总计 {formatBytes(preflight.totalBytes)}。
            {preflight.warnings.join("；")}。
          </div>
        )}

        <div className="clip-group-actions">
          <button
            className="btn sm"
            onClick={onCopyRich}
            disabled={busy !== null}
            data-tip="按分组顺序复制为富文本；图片受 6 MB 内嵌上限约束"
          >
            <Copy size={11} /> 复制富文本
          </button>
          <button
            className="btn sm"
            onClick={onCopyFiles}
            disabled={busy !== null}
            data-tip="仅把文件类条目作为文件列表复制；图片与文字不会变成文件"
          >
            <Files size={11} /> 复制文件
          </button>
          <button className="btn sm" onClick={() => setPasteOpen(true)} disabled={busy !== null || group.items.length === 0}>
            <Play size={11} /> 逐项粘贴
          </button>
          {group.status === "collecting" && (
            <button className="btn sm" onClick={onCloseGroup} disabled={busy !== null}>
              <CheckSquare size={11} /> 结束收集
            </button>
          )}
          <button className="btn sm" onClick={() => setRenaming((v) => !v)} disabled={busy !== null}>
            <Pencil size={11} /> 重命名
          </button>
        </div>

        {renaming && (
          <div className="clip-inline-edit">
            <input
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              placeholder="分组名称"
              aria-label="分组名称"
              maxLength={80}
            />
            <button className="btn sm primary" onClick={onRename} disabled={!nameInput.trim() || busy !== null}>
              保存
            </button>
            <button className="icon-btn sm" onClick={() => setRenaming(false)} data-tip="取消" aria-label="取消重命名">
              <X size={12} />
            </button>
          </div>
        )}

        <div className="clip-block-head">
          <span>分组内容（按顺序）</span>
          <button
            className={`btn sm ${tidy ? "primary" : ""}`}
            aria-pressed={tidy}
            disabled={group.items.length === 0}
            data-tip={tidy ? "收起拆分与排序操作" : "显示勾选拆分与上移/下移"}
            onClick={() => {
              if (tidy) setSplitSelected([]);
              setTidy((v) => !v);
            }}
          >
            <ListChecks size={11} /> 整理与拆分
          </button>
        </div>

        {rows.length === 0 ? (
          <div className="clip-hint">分组为空。可从历史中勾选条目创建新分组。</div>
        ) : (
          <ul className={showGrid ? "clip-group-shots" : "clip-group-items"} ref={rowListRef}>
            {rows.map((item, i) => {
              const selected = splitSelected.includes(item.id);
              const leaving = exitingRows.get(item.id);
              return (
                <li
                  key={item.id}
                  data-clip-row={item.id}
                  ref={(el) => {
                    if (el) rowEls.current.set(item.id, el);
                    else rowEls.current.delete(item.id);
                  }}
                  className={`${showGrid ? "clip-shot-card" : ""} ${selected ? "selected" : ""} ${leaving ? "removing" : ""}`}
                  aria-hidden={leaving ? true : undefined}
                  // 离场行整棵子树不可交互：inert 补上 pointer-events 挡不住的键盘焦点
                  inert={leaving ? true : undefined}
                  // 离场用收拢动画：高度在点击移除时实测一次，不留常驻测量
                  style={leaving ? ({ "--clip-exit-h": `${leaving.height}px` } as React.CSSProperties) : undefined}
                >
                  {showGrid ? (
                    <>
                      <ShotThumb
                        itemId={item.id}
                        hasThumb={item.has_thumb}
                        label={`查看第 ${i + 1} 张图片大图`}
                        disabled={leaving !== undefined}
                        onOpen={() => setPreviewImage(item)}
                      />
                      <button
                        className="clip-shot-info"
                        onClick={() => setItemDetailId(item.id)}
                        disabled={leaving !== undefined}
                      >
                        <span className="clip-shot-title">{item.title || item.preview || "图片"}</span>
                        <span className="clip-shot-meta">第 {i + 1} 张 · {formatBytes(item.byte_size)}</span>
                      </button>
                    </>
                  ) : (
                    <>
                      {tidy && (
                        <>
                          <button
                            className="clip-check"
                            aria-label={selected ? "取消拆分选择" : "选择用于拆分"}
                            aria-pressed={selected}
                            disabled={leaving !== undefined}
                            onClick={() =>
                              setSplitSelected((s) =>
                                s.includes(item.id) ? s.filter((x) => x !== item.id) : [...s, item.id],
                              )
                            }
                          >
                            {selected ? <CheckSquare size={13} /> : <Square size={13} />}
                          </button>
                          <span className="clip-order">{i + 1}</span>
                        </>
                      )}
                      {/* 缩略图独立成按钮放在行外：按钮里再套按钮是无效结构，
                          而且点缩略图应当直接看大图，不是打开条目详情 */}
                      {item.kind === "image" && (
                        <ClipboardThumb
                          itemId={item.id}
                          hasThumb={item.has_thumb}
                          size={30}
                          onOpen={leaving !== undefined ? undefined : () => setPreviewImage(item)}
                        />
                      )}
                      <button
                        className="clip-group-item-main"
                        onClick={() => setItemDetailId(item.id)}
                        disabled={leaving !== undefined}
                      >
                        <span className="clip-group-item-text">
                          <span className="clip-group-item-preview">
                            {item.title || item.preview || "（无文本预览）"}
                          </span>
                          <span className="clip-group-item-meta">
                            {kindLabel(item.kind)} · {formatBytes(item.byte_size)}
                            {item.favorite ? " · 已收藏" : ""}
                          </span>
                        </span>
                      </button>
                    </>
                  )}
                  <div className="clip-order-actions">
                    {tidy && (
                      <>
                        <button
                          className="icon-btn sm"
                          data-tip="上移"
                          aria-label={`上移第 ${i + 1} 项`}
                          disabled={i === 0 || busy !== null || leaving !== undefined}
                          onClick={() => onMove(item.id, -1)}
                        >
                          <ArrowUp size={11} />
                        </button>
                        <button
                          className="icon-btn sm"
                          data-tip="下移"
                          aria-label={`下移第 ${i + 1} 项`}
                          disabled={i === rows.length - 1 || busy !== null || leaving !== undefined}
                          onClick={() => onMove(item.id, 1)}
                        >
                          <ArrowDown size={11} />
                        </button>
                      </>
                    )}
                    <button
                      className="icon-btn sm"
                      data-tip="从分组移除（不删除内容）"
                      aria-label={`从分组移除第 ${i + 1} 项`}
                      disabled={busy !== null || leaving !== undefined}
                      onClick={() => onRemove(item.id)}
                    >
                      <X size={11} />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {splitSelected.length > 0 && (
          <div className="clip-splitbar">
            <span>已选 {splitSelected.length} 项</span>
            <input
              value={splitName}
              onChange={(e) => setSplitName(e.target.value)}
              placeholder="新分组名称"
              aria-label="拆分后的新分组名称"
              maxLength={80}
            />
            <button className="btn sm" onClick={onSplit} disabled={busy !== null}>
              <Scissors size={11} /> 拆分为新分组
            </button>
            <button className="icon-btn sm" onClick={() => setSplitSelected([])} data-tip="清除选择" aria-label="清除拆分选择">
              <X size={12} />
            </button>
          </div>
        )}

        <TaskLinkBar targetType="group" targetId={group.id} />
        <WorkspaceLinkBar targetType="group" targetId={group.id} />
        <AgentExportPanel targetType="group" targetId={group.id} taskId={linkTask?.id ?? null} />

        {/* 危险操作紧跟在「导出给 Agent」之后，与说明同一行；不单独占满整行。 */}
        <div className="clip-danger-zone">
          <button className="btn sm danger" onClick={() => onDelete(true)}>
            <Trash2 size={11} /> 删除分组及内容
          </button>
          <span className="clip-danger-note">
            删除分组默认保留历史；「删除分组及内容」只删未被引用的条目。
          </span>
        </div>
      </div>

      {previewImage && (
        <ImageLightbox
            item={previewImage}
            items={groupImages}
            askConfirm={askConfirm}
            onClose={() => setPreviewImage(null)}
          />
      )}
    </div>
  );
}

/**
 * 纯图片分组网格卡片里的缩略图：宽度跟随卡片、保持图片自身宽高比（contain，不拉伸）。
 * 复用 Media 的缩略图 IPC 与缓存；无缩略图时仍可点开灯箱，由灯箱报出真实缺失原因。
 */
function ShotThumb({
  itemId,
  hasThumb,
  label,
  disabled,
  onOpen,
}: {
  itemId: string;
  hasThumb: boolean;
  label: string;
  disabled?: boolean;
  onOpen: () => void;
}) {
  const url = useThumbnail(itemId, hasThumb);
  return (
    <button
      type="button"
      className="clip-shot-open"
      disabled={disabled}
      data-tip="点击查看大图"
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
      // Enter/Space 只在缩略图上生效，不再冒泡触发外层行为
      onKeyDown={(e) => e.stopPropagation()}
    >
      {url ? (
        <img className="clip-shot-img" src={url} alt="" loading="lazy" draggable={false} />
      ) : (
        <span className="clip-shot-img clip-shot-placeholder">
          <ImageIcon size={18} />
        </span>
      )}
    </button>
  );
}
