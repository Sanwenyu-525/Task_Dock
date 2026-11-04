//! 编辑已保存导航目标：仅允许修改后端白名单字段；程序路径/网址/身份键保持只读。
//!
//! 应用中心（AppsPanel）与设置管理（AppManagement）共用本组件，
//! 保存逻辑只有 `navUpdateTarget` 一处，避免出现第二套写法。

import { useEffect, useState } from "react";
import { useUiStore } from "../../store/useUiStore";
import { navUpdateTarget, type NavTarget } from "../../lib/navigation";
import { Dialog, Switch } from "../ui";

export default function TargetEditDialog({
  target,
  onClose,
  onSaved,
}: {
  target: NavTarget | null;
  onClose: () => void;
  onSaved: () => Promise<void> | void;
}) {
  const showToast = useUiStore((s) => s.showToast);
  const [name, setName] = useState("");
  const [args, setArgs] = useState("");
  const [cwd, setCwd] = useState("");
  const [titleHint, setTitleHint] = useState("");
  const [favorite, setFavorite] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!target) return;
    setName(target.display_name);
    setArgs(target.launch_args);
    setCwd(target.working_dir);
    setTitleHint(target.window_title_hint);
    setFavorite(target.favorite);
    setHidden(target.hidden);
  }, [target]);

  if (!target) return null;
  const targetId = target.id;
  const isApp = target.target_type === "application";
  const identity = isApp ? target.exe_path : target.target_type === "url" ? target.url : target.path;

  async function save() {
    const trimmed = name.trim();
    if (!trimmed) {
      showToast("显示名称不能为空", { kind: "error" });
      return;
    }
    setBusy(true);
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
      // 身份字段（EXE 路径 / 网址 / 目录）不在后端白名单内，前端不伪造。
      await navUpdateTarget(targetId, patch);
      showToast("配置已保存", { kind: "success" });
      await onSaved();
    } catch (e) {
      showToast(String(e), { kind: "error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="编辑应用配置"
      size="md"
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>取消</button>
          <button className="btn primary" onClick={save} disabled={busy}>保存</button>
        </>
      }
    >
      <div className="target-edit-form">
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
          目标身份：{identity || "—"}。路径/网址属于身份字段，不能在此修改；如需更换请新增目标后删除旧项。
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
      </div>
    </Dialog>
  );
}
