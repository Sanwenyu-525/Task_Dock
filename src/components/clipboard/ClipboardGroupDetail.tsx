//! 分组详情：顺序、重命名、结束收集、拆分、整组复制、逐项粘贴、任务关联与删除策略。

import { useEffect, useState } from "react";
import {
  ArrowDown, ArrowLeft, ArrowUp, CheckSquare, Copy, Files, Link2, Pencil,
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
  type CopyReport,
} from "../../lib/bridge";
import { copyPreflight, formatBytes, groupModeLabel, groupStatusLabel, kindLabel } from "../../lib/clipboardUi";
import { useUiStore } from "../../store/useUiStore";
import AgentExportPanel from "./AgentExportPanel";
import ClipboardItemDetail from "./ClipboardItemDetail";
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
  const [itemDetailId, setItemDetailId] = useState<string | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);

  async function reload() {
    try {
      const g = await clipboardGroup(groupId);
      setGroup(g);
      setNameInput(g.name);
      return g;
    } catch (e) {
      showToast(`读取分组失败：${String(e)}`, { kind: "error" });
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
          showToast(`读取分组失败：${String(e)}`, { kind: "error" });
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
    showToast(
      `已复制 ${r.item_count} 项（${r.mode.toUpperCase()}，${formatBytes(r.bytes)}）${warn}`,
      { kind: r.warnings.length > 0 ? "info" : "success" },
    );
  }

  async function onCopyRich() {
    setBusy("copy-rich");
    try {
      reportCopy(await clipboardCopyGroupRich(groupId));
    } catch (e) {
      showToast(`复制富文本失败：${String(e)}`, { kind: "error" });
    } finally {
      setBusy(null);
    }
  }

  async function onCopyFiles() {
    setBusy("copy-files");
    try {
      reportCopy(await clipboardCopyGroupFiles(groupId));
    } catch (e) {
      showToast(`复制文件失败：${String(e)}`, { kind: "error" });
    } finally {
      setBusy(null);
    }
  }

  async function onToggle(flag: "favorite" | "pinned") {
    try {
      setGroup(await clipboardToggleGroup(groupId, flag));
      onChanged();
    } catch (e) {
      showToast(String(e), { kind: "error" });
    }
  }

  async function onCloseGroup() {
    setBusy("close");
    try {
      setGroup(await clipboardCloseGroup(groupId));
      showToast("分组已结束收集；之后的新截图会开启新分组", { kind: "success" });
      onChanged();
    } catch (e) {
      showToast(String(e), { kind: "error" });
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
      showToast(`重命名失败：${String(e)}`, { kind: "error" });
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
      showToast(`排序失败：${String(e)}`, { kind: "error" });
    } finally {
      setBusy(null);
    }
  }

  async function onRemove(itemId: string) {
    setBusy("remove");
    try {
      setGroup(await clipboardRemoveGroupItem(groupId, itemId));
      setSplitSelected((s) => s.filter((x) => x !== itemId));
      showToast("已从分组移除（内容仍保留在历史中）", { kind: "info" });
      onChanged();
    } catch (e) {
      showToast(String(e), { kind: "error" });
    } finally {
      setBusy(null);
    }
  }

  async function onSplit() {
    if (splitSelected.length === 0) return;
    setBusy("split");
    try {
      await clipboardSplitGroup(groupId, splitSelected, splitName.trim() || "拆分分组");
      setSplitSelected([]);
      setSplitName("");
      await reload();
      showToast("已拆分为新分组", { kind: "success" });
      onChanged();
    } catch (e) {
      showToast(`拆分失败：${String(e)}`, { kind: "error" });
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
      showToast(`关联失败：${String(e)}`, { kind: "error" });
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
        const r = await clipboardDeleteGroup(groupId, alsoItems);
        showToast(
          alsoItems
            ? `已删除 ${r.deleted} 条内容${r.retained_shared > 0 ? `；${r.retained_shared} 条因仍被引用而保留` : ""}`
            : "分组已删除，历史条目已保留",
          { kind: "success" },
        );
        onChanged();
        onBack();
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
          <button className="icon-btn sm" onClick={onBack} title="返回" aria-label="返回分组列表">
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
        <button className="icon-btn sm" onClick={onBack} title="返回" aria-label="返回分组列表">
          <ArrowLeft size={13} />
        </button>
        <span className="clip-group-title" title={group.name}>{group.name}</span>
        <div className="clip-detail-actions">
          <button
            className={`icon-btn sm ${group.pinned ? "active" : ""}`}
            title={group.pinned ? "取消置顶" : "置顶分组"}
            aria-label={group.pinned ? "取消置顶" : "置顶分组"}
            aria-pressed={group.pinned}
            onClick={() => onToggle("pinned")}
          >
            <Pin size={12} />
          </button>
          <button
            className={`icon-btn sm ${group.favorite ? "active" : ""}`}
            title={group.favorite ? "取消收藏" : "收藏分组"}
            aria-label={group.favorite ? "取消收藏" : "收藏分组"}
            aria-pressed={group.favorite}
            onClick={() => onToggle("favorite")}
          >
            <Star size={12} />
          </button>
          <button
            className="icon-btn sm danger-ghost"
            title="删除分组（保留条目）"
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
            title="按分组顺序复制为富文本；图片受 6 MB 内嵌上限约束"
          >
            <Copy size={11} /> 复制富文本
          </button>
          <button
            className="btn sm"
            onClick={onCopyFiles}
            disabled={busy !== null}
            title="仅把文件类条目作为文件列表复制；图片与文字不会变成文件"
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
            <button className="icon-btn sm" onClick={() => setRenaming(false)} title="取消" aria-label="取消重命名">
              <X size={12} />
            </button>
          </div>
        )}

        <div className="clip-block-head">
          <span>分组内容（按顺序）</span>
        </div>

        {group.items.length === 0 ? (
          <div className="clip-hint">分组为空。可从历史中勾选条目创建新分组。</div>
        ) : (
          <ul className="clip-group-items">
            {group.items.map((item, i) => {
              const selected = splitSelected.includes(item.id);
              return (
                <li key={item.id} className={selected ? "selected" : ""}>
                  <button
                    className="clip-check"
                    aria-label={selected ? "取消拆分选择" : "选择用于拆分"}
                    aria-pressed={selected}
                    onClick={() =>
                      setSplitSelected((s) =>
                        s.includes(item.id) ? s.filter((x) => x !== item.id) : [...s, item.id],
                      )
                    }
                  >
                    {selected ? <CheckSquare size={13} /> : <Square size={13} />}
                  </button>
                  <span className="clip-order">{i + 1}</span>
                  <button className="clip-group-item-main" onClick={() => setItemDetailId(item.id)}>
                    <span className="clip-group-item-preview">{item.preview || "（无文本预览）"}</span>
                    <span className="clip-group-item-meta">
                      {kindLabel(item.kind)} · {formatBytes(item.byte_size)}
                      {item.favorite ? " · 已收藏" : ""}
                    </span>
                  </button>
                  <div className="clip-order-actions">
                    <button
                      className="icon-btn sm"
                      title="上移"
                      aria-label={`上移第 ${i + 1} 项`}
                      disabled={i === 0 || busy !== null}
                      onClick={() => onMove(item.id, -1)}
                    >
                      <ArrowUp size={11} />
                    </button>
                    <button
                      className="icon-btn sm"
                      title="下移"
                      aria-label={`下移第 ${i + 1} 项`}
                      disabled={i === group.items.length - 1 || busy !== null}
                      onClick={() => onMove(item.id, 1)}
                    >
                      <ArrowDown size={11} />
                    </button>
                    <button
                      className="icon-btn sm"
                      title="从分组移除（不删除内容）"
                      aria-label={`从分组移除第 ${i + 1} 项`}
                      disabled={busy !== null}
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
            <button className="icon-btn sm" onClick={() => setSplitSelected([])} title="清除选择" aria-label="清除拆分选择">
              <X size={12} />
            </button>
          </div>
        )}

        <TaskLinkBar targetType="group" targetId={group.id} />
        <WorkspaceLinkBar targetType="group" targetId={group.id} />
        <AgentExportPanel targetType="group" targetId={group.id} taskId={linkTask?.id ?? null} />

        <div className="clip-danger-zone">
          <span>删除策略：删除分组默认保留历史内容；只有「删除分组及内容」会一并删除未被引用的条目。</span>
          <button className="btn sm danger" onClick={() => onDelete(true)}>
            <Trash2 size={11} /> 删除分组及内容
          </button>
        </div>
      </div>
    </div>
  );
}
