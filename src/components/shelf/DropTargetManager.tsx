//! 投递目标管理（完整面板内的独立内容视图）。
//!
//! 结构（与「文件暂存架」视图互斥，不新增左侧导航 Tab）：
//! 返回暂存架 → 标题与目标数量 → 主要添加操作 → 目录列表 → 辅助刷新/说明。
//! 拖入语义：本视图只负责目录配置，**不接管文件拖入**（ShelfWorkspace 在
//! `targetsOpen` 时释放拖放消费者），避免在管理目标时把文件误加进暂存架。
//!
//! 与工具面板共享同一份配置（同一后端表 + 同一 store）：这里改名称/路径/模式/可见性，
//! 胶囊「文件」子页立即看到；反过来也成立。
//!
//! 所有的删除都只是「移除快捷入口」：真实目录与其中的文件一律不动。

import { useEffect, useState } from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Eye,
  EyeOff,
  Folder,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import type { DropTargetOpMode, ShelfConflictStrategy, ShelfDropTarget } from "../../lib/bridge";
import { errorMessage } from "../../lib/errors";
import { useDropTargetsStore } from "../../store/useDropTargetsStore";
import { useUiStore } from "../../store/useUiStore";
import { ConfirmDialog } from "../ui/Dialog";
import DropTargetForm from "./DropTargetForm";

function shortPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 3) return path;
  return `…\\${parts.slice(-3).join("\\")}`;
}

export default function DropTargetManager({ onClose }: { onClose: () => void }) {
  const targets = useDropTargetsStore((s) => s.targets);
  const loading = useDropTargetsStore((s) => s.loading);
  const error = useDropTargetsStore((s) => s.error);
  const load = useDropTargetsStore((s) => s.load);
  const update = useDropTargetsStore((s) => s.update);
  const remove = useDropTargetsStore((s) => s.remove);
  const move = useDropTargetsStore((s) => s.move);
  const openDir = useDropTargetsStore((s) => s.openDir);
  const showToast = useUiStore((s) => s.showToast);
  const [adding, setAdding] = useState(false);
  /** 正在编辑的目标 id：表单就地替换该行，不新开模态。 */
  const [editing, setEditing] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  /** 有未保存表单时返回暂存架必须先确认，不能静默丢弃输入。 */
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  useEffect(() => {
    void load();
  }, [load]);

  const formOpen = adding || editing !== null;

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      if (ok) showToast(ok, { kind: "success" });
    } catch (e) {
      showToast(errorMessage(e), { kind: "error" });
    }
  };

  const requestClose = () => {
    if (formOpen) {
      setConfirmDiscard(true);
      return;
    }
    onClose();
  };

  return (
    <div className="shelf-targets-view">
      <div className="shelf-targets-head">
        <button
          type="button"
          className="shelf-targets-back"
          aria-label="返回文件暂存架"
          onClick={requestClose}
        >
          <ArrowLeft size={13} strokeWidth={2.2} aria-hidden="true" />
          文件暂存架
        </button>
        <div className="shelf-targets-title">
          <h2>投递目标</h2>
          <span className="shelf-targets-count">
            {loading && targets.length === 0 ? "读取中" : `${targets.length} 个目录`}
          </span>
        </div>
        <div className="shelf-targets-head-actions">
          {!formOpen && (
            <button type="button" className="btn sm primary" onClick={() => setAdding(true)}>
              <Plus size={13} aria-hidden="true" /> 添加目标文件夹
            </button>
          )}
          <button
            type="button"
            className="btn sm"
            disabled={loading}
            onClick={() => void load({ force: true })}
          >
            {loading ? (
              <Loader2 size={13} className="spin" aria-hidden="true" />
            ) : (
              <RefreshCw size={13} aria-hidden="true" />
            )}
            重新检查目录
          </button>
        </div>
      </div>

      <p className="shelf-targets-desc">
        拖进工具面板「收集箱 → 文件」中的目标卡片，即按这里的配置写入真实目录；默认复制并保留源文件。
      </p>

      {error && (
        <div className="shelf-targets-error" role="alert">
          <AlertTriangle size={13} strokeWidth={2.2} aria-hidden="true" />
          <span>{error}</span>
          <button type="button" className="btn sm" onClick={() => void load({ force: true })}>
            重试
          </button>
        </div>
      )}

      {adding && (
        <DropTargetForm
          target={null}
          variant="shelf"
          onDone={(msg) => {
            setAdding(false);
            if (msg) showToast(msg, { kind: "success" });
          }}
          onError={(msg) => showToast(msg, { kind: "error" })}
        />
      )}

      {targets.length === 0 && !loading && !adding && (
        <div className="shelf-targets-empty">
          <Folder size={22} strokeWidth={1.5} aria-hidden="true" />
          <p>还没有配置投递目标。</p>
          <p className="shelf-targets-empty-sub">
            添加一个真实文件夹后，就能在工具面板把文件直接拖到对应卡片；默认复制，源文件保留。
          </p>
          <button type="button" className="btn sm primary" onClick={() => setAdding(true)}>
            <Plus size={13} aria-hidden="true" /> 添加目标文件夹
          </button>
        </div>
      )}

      {targets.length === 0 && loading && (
        <p className="shelf-targets-loading" role="status">
          <Loader2 size={14} className="spin" aria-hidden="true" /> 正在检查目标目录…
        </p>
      )}

      {targets.length > 0 && (
        <ul className={`shelf-drop-targets-list${editing !== null ? " is-editing" : ""}`}>
          {targets.map((t, index) => (
            <li key={t.id} className="shelf-drop-targets-item">
              {editing === t.id ? (
                <DropTargetForm
                  target={t}
                  variant="shelf"
                  onDone={(msg) => {
                    setEditing(null);
                    if (msg) showToast(msg, { kind: "success" });
                  }}
                  onError={(msg) => showToast(msg, { kind: "error" })}
                />
              ) : (
                <TargetRow
                  target={t}
                  first={index === 0}
                  last={index === targets.length - 1}
                  confirming={confirmId === t.id}
                  onOpen={() => void run(() => openDir(t.id))}
                  onEdit={() => setEditing(t.id)}
                  onMove={(dir) => void run(() => move(t.id, dir))}
                  onToggleVisible={() =>
                    void run(
                      () => update(t.id, { show_in_capsule: !t.show_in_capsule }),
                      t.show_in_capsule ? "已从工具面板隐藏" : "已显示在工具面板",
                    )
                  }
                  onMode={(mode) =>
                    void run(
                      () => update(t.id, { op_mode: mode }),
                      mode === "move" ? "已切换为移动" : "已切换为复制",
                    )
                  }
                  onConflict={(conflict) => void run(() => update(t.id, { conflict }))}
                  onAskRemove={() => setConfirmId(t.id)}
                  onCancelRemove={() => setConfirmId(null)}
                  onConfirmRemove={() => {
                    setConfirmId(null);
                    void run(() => remove(t.id), "已移除入口（目录与文件未改动）");
                  }}
                />
              )}
            </li>
          ))}
        </ul>
      )}

      <p className="shelf-drop-targets-note">
        移除只删除快捷入口，不会删除真实目录或其中的文件；投递默认复制并保留源文件。
      </p>

      <ConfirmDialog
        open={confirmDiscard}
        title="放弃未保存的目标修改？"
        detail="正在新增或编辑的目标配置还没有保存，返回文件暂存架会丢失这些输入。"
        confirmLabel="放弃并返回"
        danger
        onConfirm={() => {
          setConfirmDiscard(false);
          setAdding(false);
          setEditing(null);
          onClose();
        }}
        onCancel={() => setConfirmDiscard(false)}
      />
    </div>
  );
}

function TargetRow({
  target,
  first,
  last,
  confirming,
  onOpen,
  onEdit,
  onMove,
  onToggleVisible,
  onMode,
  onConflict,
  onAskRemove,
  onCancelRemove,
  onConfirmRemove,
}: {
  target: ShelfDropTarget;
  first: boolean;
  last: boolean;
  confirming: boolean;
  onOpen: () => void;
  onEdit: () => void;
  onMove: (dir: "up" | "down") => void;
  onToggleVisible: () => void;
  onMode: (mode: DropTargetOpMode) => void;
  onConflict: (conflict: ShelfConflictStrategy) => void;
  onAskRemove: () => void;
  onCancelRemove: () => void;
  onConfirmRemove: () => void;
}) {
  return (
    <div className={`shelf-drop-target-row${target.available ? "" : " is-off"}`}>
      <span className="shelf-drop-target-icon" aria-hidden="true">
        <Folder size={15} strokeWidth={1.8} />
      </span>

      <div className="shelf-drop-target-main">
        <span className="shelf-drop-target-name-line">
          <span className="shelf-drop-target-name" title={target.name}>
            {target.name}
          </span>
          {!target.available && (
            <span className="shelf-fileop-badge" data-tip="目录不存在或不可访问；投递会被拒绝">
              不可用
            </span>
          )}
        </span>
        <button
          type="button"
          className="shelf-drop-target-path"
          title={`${target.path}（点击在资源管理器中打开）`}
          onClick={onOpen}
        >
          {shortPath(target.path)}
        </button>
      </div>

      <div className="shelf-drop-target-modes" role="group" aria-label={`「${target.name}」投递方式`}>
        <div className="seg-group">
          <button
            type="button"
            className={`seg-btn ${target.op_mode === "copy" ? "active" : ""}`}
            aria-pressed={target.op_mode === "copy"}
            onClick={() => onMode("copy")}
          >
            复制
          </button>
          <button
            type="button"
            className={`seg-btn ${target.op_mode === "move" ? "active" : ""}`}
            aria-pressed={target.op_mode === "move"}
            onClick={() => onMode("move")}
          >
            移动
          </button>
        </div>
        <div className="seg-group subtle">
          <button
            type="button"
            className={`seg-btn ${target.conflict === "rename" ? "active" : ""}`}
            aria-pressed={target.conflict === "rename"}
            onClick={() => onConflict("rename")}
          >
            自动重命名
          </button>
          <button
            type="button"
            className={`seg-btn ${target.conflict === "skip" ? "active" : ""}`}
            aria-pressed={target.conflict === "skip"}
            onClick={() => onConflict("skip")}
          >
            同名跳过
          </button>
        </div>
      </div>

      <div className="shelf-drop-target-actions">
        <button
          type="button"
          className="icon-btn sm"
          aria-label={`上移「${target.name}」`}
          data-tip="上移"
          disabled={first}
          onClick={() => onMove("up")}
        >
          <ArrowUp size={12} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="icon-btn sm"
          aria-label={`下移「${target.name}」`}
          data-tip="下移"
          disabled={last}
          onClick={() => onMove("down")}
        >
          <ArrowDown size={12} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="icon-btn sm"
          aria-label={`编辑「${target.name}」`}
          data-tip="编辑名称与目录"
          onClick={onEdit}
        >
          <Pencil size={12} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="icon-btn sm"
          aria-label={target.show_in_capsule ? `从工具面板隐藏「${target.name}」` : `在工具面板显示「${target.name}」`}
          aria-pressed={target.show_in_capsule}
          data-tip={target.show_in_capsule ? "在工具面板显示" : "已从工具面板隐藏"}
          onClick={onToggleVisible}
        >
          {target.show_in_capsule ? <Eye size={12} aria-hidden="true" /> : <EyeOff size={12} aria-hidden="true" />}
        </button>
        {confirming ? (
          <>
            <button type="button" className="btn sm danger" onClick={onConfirmRemove}>
              确认移除
            </button>
            <button type="button" className="btn sm" onClick={onCancelRemove}>
              取消
            </button>
          </>
        ) : (
          <button
            type="button"
            className="icon-btn sm"
            aria-label={`移除「${target.name}」入口`}
            data-tip="移除入口（不删文件）"
            onClick={onAskRemove}
          >
            <Trash2 size={12} aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
}
