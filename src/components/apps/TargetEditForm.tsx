//! 编辑已保存导航目标的页内表单（无弹窗）：应用中心与设置「应用与快捷方式」共用。
//!
//! 边界：
//! - 身份字段（EXE 路径 / 网址 / 目录 / AppUserModelID / app_key）只读展示，
//!   只提交后端白名单字段，避免前端伪造身份变更。
//! - 保存失败保留用户输入并就近提示；保存中拒绝重复提交（连点只提交一次）。
//! - 取消/离开时若有未保存更改，先在表单内给出「放弃更改 / 继续编辑」确认。

import { useEffect, useRef, useState } from "react";
import { useUiStore } from "../../store/useUiStore";
import { errorMessage } from "../../lib/errors";
import { navUpdateTarget, type NavTarget } from "../../lib/navigation";
import { Switch } from "../ui";

interface Props {
  target: NavTarget;
  /** 无未保存更改时直接关闭；有更改时由本组件先给出放弃确认。 */
  onClose: () => void;
  /** 保存成功后调用；调用方负责关闭编辑区并刷新共享目标清单。 */
  onSaved: () => Promise<void> | void;
  /** 脏状态上报：调用方在切换目标、进入添加页前据此做离开保护。 */
  onDirtyChange?: (dirty: boolean) => void;
}

export default function TargetEditForm({
  target,
  onClose,
  onSaved,
  onDirtyChange,
}: Props) {
  const showToast = useUiStore((s) => s.showToast);
  const [name, setName] = useState(target.display_name);
  const [args, setArgs] = useState(target.launch_args);
  const [cwd, setCwd] = useState(target.working_dir);
  const [titleHint, setTitleHint] = useState(target.window_title_hint);
  const [favorite, setFavorite] = useState(target.favorite);
  const [hidden, setHidden] = useState(target.hidden);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discardOpen, setDiscardOpen] = useState(false);
  // 同步锁：setBusy 是异步的，连点两次会在第一次 await 前都通过 `if (busy)` 判断
  const savingRef = useRef(false);

  const isApp = target.target_type === "application";
  const identity = isApp ? target.exe_path : target.target_type === "url" ? target.url : target.path;

  const dirty =
    name !== target.display_name ||
    args !== target.launch_args ||
    cwd !== target.working_dir ||
    titleHint !== target.window_title_hint ||
    favorite !== target.favorite ||
    hidden !== target.hidden;

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  function requestClose() {
    if (savingRef.current) return;
    if (dirty) {
      setDiscardOpen(true);
      return;
    }
    onClose();
  }

  async function save() {
    if (savingRef.current) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setError("显示名称不能为空");
      return;
    }
    savingRef.current = true;
    setBusy(true);
    setError(null);
    setDiscardOpen(false);
    try {
      const patch = {
        display_name: trimmed,
        favorite,
        hidden,
        ...(isApp
          ? {
              launch_args: args.trim(),
              working_dir: cwd.trim(),
              window_title_hint: titleHint.trim(),
            }
          : {}),
      };
      // 身份字段不在后端白名单内，前端不伪造。
      await navUpdateTarget(target.id, patch);
      showToast("配置已保存", { kind: "success" });
      await onSaved();
    } catch (e) {
      // 失败不清空表单：保留输入，错误就近显示，便于修正后重试
      setError(`保存失败：${errorMessage(e)}`);
    } finally {
      savingRef.current = false;
      setBusy(false);
    }
  }

  return (
    <section className="target-edit-form" role="region" aria-label="编辑应用配置">
      <div className="wf-head-row">
        <h3 className="wf-title">编辑「{target.display_name}」</h3>
        <div className="wf-head-actions">
          <button type="button" className="btn sm" onClick={requestClose} disabled={busy}>
            取消
          </button>
          <button type="button" className="btn primary sm" onClick={() => void save()} disabled={busy}>
            {busy ? "保存中…" : "保存"}
          </button>
        </div>
      </div>

      <label className="target-edit-field">
        <span>显示名称</span>
        <input
          className="input"
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
          aria-label="显示名称"
        />
      </label>

      <div className="endpoint-hint">
        <span>
          目标身份（只读）：<code>{identity || "—"}</code>
          {isApp && target.app_user_model_id ? (
            <>
              {" · "}AppUserModelID：<code>{target.app_user_model_id}</code>
            </>
          ) : null}
        </span>
      </div>
      <div className="endpoint-hint">
        路径/网址与身份键属于身份字段，不能在此修改；如需更换请新增目标后删除旧项。
      </div>

      {isApp && (
        <>
          <label className="target-edit-field">
            <span>启动参数</span>
            <input
              className="input"
              value={args}
              onChange={(e) => setArgs(e.target.value)}
              placeholder="留空表示无参数"
              aria-label="启动参数"
            />
          </label>
          <label className="target-edit-field">
            <span>工作目录</span>
            <input
              className="input"
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              placeholder="留空表示使用程序所在目录"
              aria-label="工作目录"
            />
          </label>
          <label className="target-edit-field">
            <span>窗口标题匹配提示</span>
            <input
              className="input"
              value={titleHint}
              onChange={(e) => setTitleHint(e.target.value)}
              placeholder="用于多窗口时优先匹配，可留空"
              aria-label="窗口标题匹配提示"
            />
          </label>
        </>
      )}

      <div className="setting-row">
        <span>收藏（工具面板优先展示）</span>
        <Switch checked={favorite} ariaLabel="收藏" onChange={setFavorite} />
      </div>
      <div className="setting-row">
        <span>隐藏（不显示在选择器与工具面板）</span>
        <Switch checked={hidden} ariaLabel="隐藏" onChange={setHidden} />
      </div>

      {error && (
        <div className="wf-error-text" role="alert">
          {error}
        </div>
      )}

      {discardOpen && (
        <div className="wf-error-block" role="alert">
          <span>有未保存的更改</span>
          <div className="wf-head-actions">
            <button type="button" className="btn sm" onClick={() => setDiscardOpen(false)}>
              继续编辑
            </button>
            <button type="button" className="btn sm" onClick={onClose}>
              放弃更改
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
