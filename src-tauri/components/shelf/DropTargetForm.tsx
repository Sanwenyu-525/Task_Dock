//! 投递目标的新增 / 编辑表单（工具面板与完整面板共用）。
//!
//! 两个面板的**外观**不同（胶囊用 `cap-*` 小控件，完整面板用 `shelf-*` 控件），
//! 但字段、校验、目录选择与提交逻辑完全一致；这里用 `variant` 只切换类名与
//! 按钮原语，避免两处各写一份表单逻辑后逐渐不一致（例如一边允许金属路径、
//! 一边只能选目录，或一边忘记处理重名错误）。
//!
//! 约束：
//! - 目录只经系统目录选择器写入，不允许手打路径（避免大小写/短名歧义）；
//! - 编辑时只提交本表单字段，目标 id、排序、可见性等既有配置原样保留；
//! - 保存失败不落任何本地状态：store 不更新，界面继续显示旧目标。

import { useEffect, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { AlertTriangle, ChevronDown, FolderOpen, Loader2, X } from "lucide-react";
import type { DropTargetOpMode, ShelfConflictStrategy, ShelfDropTarget } from "../../lib/bridge";
import { errorMessage } from "../../lib/errors";
import { useDropTargetsStore } from "../../store/useDropTargetsStore";

function basenameOf(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** 路径只展示末几段：完整路径放 title，避免撑破窄面板。 */
function shortPath(path: string, depth: number): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  if (parts.length <= depth) return path;
  return `…\\${parts.slice(-depth).join("\\")}`;
}

const VARIANTS = {
  capsule: {
    form: "cap-drop-form",
    row: "cap-drop-field",
    inputWrap: "cap-input",
    pick: "cap-drop-pick",
    pickPath: "cap-drop-pick-path",
    choice: "cap-drop-choice",
    choiceBtn: "cap-mini",
    warn: "cap-drop-warn",
    advanced: "cap-drop-advanced",
    advancedToggle: "cap-drop-advanced-toggle",
    actions: "cap-drop-form-actions",
    primary: "cap-mini is-primary",
    ghost: "cap-mini",
    pathDepth: 2,
    warnText: "移动会删除源文件；目标未完整写入时绝不删除源。",
  },
  shelf: {
    form: "shelf-drop-target-add",
    row: "shelf-drop-target-add-row",
    inputWrap: "shelf-drop-target-add-input",
    pick: "btn sm",
    pickPath: "shelf-drop-target-add-path",
    choice: "seg-group",
    choiceBtn: "seg-btn",
    warn: "shelf-drop-target-warn",
    advanced: "shelf-drop-target-advanced",
    advancedToggle: "shelf-drop-target-advanced-toggle",
    actions: "shelf-cleanup-actions",
    primary: "btn sm primary",
    ghost: "btn sm",
    pathDepth: 3,
    warnText:
      "移动会删除源文件：同卷原子改名，跨卷先复制校验完整后再删源；目标未完整写入时绝不删除源文件。",
  },
} as const;

export type DropTargetFormVariant = keyof typeof VARIANTS;

export default function DropTargetForm({
  target,
  variant,
  onDone,
  onError,
  formId,
  hideActions = false,
  onBusyChange,
  onDirtyChange,
}: {
  /** null=新增；否则为编辑已有目标（只提交表单字段，保留 id/排序/可见性） */
  target: ShelfDropTarget | null;
  variant: DropTargetFormVariant;
  onDone: (msg?: string) => void;
  onError: (msg: string) => void;
  /** 与外部底栏联动：底栏按钮用 `form={formId}` 提交 */
  formId?: string;
  /** 胶囊底栏统一提供保存/取消时，隐藏表单内重复按钮 */
  hideActions?: boolean;
  onBusyChange?: (busy: boolean) => void;
  /** 字段相对初始值是否变化：目标管理用它区分「打开表单」与「真的有未保存修改」。 */
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const s = VARIANTS[variant];
  const create = useDropTargetsStore((st) => st.create);
  const update = useDropTargetsStore((st) => st.update);
  const [name, setName] = useState(target?.name ?? "");
  const [path, setPath] = useState(target?.path ?? "");
  const [mode, setMode] = useState<DropTargetOpMode>(target?.op_mode ?? "copy");
  const [conflict, setConflict] = useState<ShelfConflictStrategy>(target?.conflict ?? "rename");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  /** 打开表单时的初始值：只有真正改动过才需要在离开时确认。 */
  const baseline = useRef({
    name: target?.name ?? "",
    path: target?.path ?? "",
    mode: (target?.op_mode ?? "copy") as DropTargetOpMode,
    conflict: (target?.conflict ?? "rename") as ShelfConflictStrategy,
  });

  useEffect(() => {
    const b = baseline.current;
    onDirtyChange?.(
      name !== b.name || path !== b.path || mode !== b.mode || conflict !== b.conflict,
    );
  }, [name, path, mode, conflict, onDirtyChange]);

  const markBusy = (next: boolean) => {
    setBusy(next);
    onBusyChange?.(next);
  };

  const pick = async () => {
    try {
      const picked = await openDialog({
        directory: true,
        multiple: false,
        title: "选择投递目标文件夹",
      });
      if (typeof picked !== "string") return;
      setPath(picked);
      if (!name.trim()) setName(basenameOf(picked));
    } catch (e) {
      onError(`选择目录失败：${errorMessage(e)}`);
    }
  };

  const save = async () => {
    if (busy) return;
    if (!path) {
      onError("请先选择目标文件夹");
      return;
    }
    markBusy(true);
    try {
      if (target) {
        // 只提交表单负责的字段：id / 排序 / 可见性保持数据库里的现值。
        await update(target.id, {
          name: name.trim(),
          path,
          op_mode: mode,
          conflict,
        });
        onDone("已保存");
      } else {
        await create({ name: name.trim(), path, opMode: mode, conflict });
        onDone("已添加投递目标");
      }
    } catch (e) {
      // 失败不关闭表单：用户可以改路径或名称后重试，原配置保持不变。
      onError(errorMessage(e));
    } finally {
      markBusy(false);
    }
  };

  return (
    <form
      id={formId}
      className={s.form}
      aria-label={target ? "编辑投递目标" : "添加投递目标"}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <label className={s.row}>
        <span>名称</span>
        <span className={s.inputWrap}>
          <input
            className="input-embedded"
            value={name}
            maxLength={40}
            placeholder={path ? basenameOf(path) : "例如：工作资料"}
            onChange={(e) => setName(e.target.value)}
          />
        </span>
      </label>
      <div className={s.row}>
        <span>目录</span>
        <button
          type="button"
          className={s.pick}
          data-tip={path || undefined}
          onClick={() => void pick()}
        >
          <FolderOpen size={12} strokeWidth={2} aria-hidden="true" />
          <span className={s.pickPath}>{path ? shortPath(path, s.pathDepth) : "选择文件夹…"}</span>
        </button>
      </div>
      <div className={s.row}>
        <span>操作</span>
        <span className={s.choice} role="group" aria-label="操作模式">
          <button
            type="button"
            className={s.choiceBtn}
            aria-pressed={mode === "copy"}
            onClick={() => setMode("copy")}
          >
            复制（保留源文件）
          </button>
          <button
            type="button"
            className={s.choiceBtn}
            aria-pressed={mode === "move"}
            onClick={() => setMode("move")}
          >
            移动
          </button>
        </span>
      </div>
      {mode === "move" && (
        <p className={s.warn}>
          <AlertTriangle size={11} strokeWidth={2.2} aria-hidden="true" />
          {s.warnText}
        </p>
      )}

      {/* 低频配置折叠；摘要始终可见，避免「隐藏了会影响源文件的设置」 */}
      <button
        type="button"
        className={s.advancedToggle}
        aria-expanded={advancedOpen}
        onClick={() => setAdvancedOpen((v) => !v)}
      >
        <ChevronDown
          size={11}
          strokeWidth={2.2}
          aria-hidden="true"
          className={advancedOpen ? "is-open" : undefined}
        />
        高级选项
        <span className={s.advanced}>
          同名：{conflict === "rename" ? "自动重命名" : "跳过"}
        </span>
      </button>
      {advancedOpen && (
        <div className={s.row}>
          <span>同名</span>
          <span className={s.choice} role="group" aria-label="同名文件策略">
            <button
              type="button"
              className={s.choiceBtn}
              aria-pressed={conflict === "rename"}
              onClick={() => setConflict("rename")}
            >
              自动重命名
            </button>
            <button
              type="button"
              className={s.choiceBtn}
              aria-pressed={conflict === "skip"}
              onClick={() => setConflict("skip")}
            >
              跳过
            </button>
          </span>
        </div>
      )}

      {!hideActions && (
        <div className={s.actions}>
          <button type="submit" className={s.primary} disabled={busy}>
            {busy ? <Loader2 size={11} className="spin" aria-hidden="true" /> : null}
            {target ? "保存" : variant === "capsule" ? "添加" : "添加目标"}
          </button>
          <button type="button" className={s.ghost} disabled={busy} onClick={() => onDone()}>
            {variant === "capsule" ? <X size={11} strokeWidth={2.4} aria-hidden="true" /> : null}
            取消
          </button>
        </div>
      )}
    </form>
  );
}
