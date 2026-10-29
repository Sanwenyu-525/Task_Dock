//! 剪贴板 → Agent 本地导入包：只写本地文件，不自动上传/发送。

import { useState } from "react";
import { Bot, Copy, FolderOutput, RefreshCw } from "lucide-react";
import {
  clipboardAgentTargets,
  clipboardExportForAgent,
  type AgentClipboardTarget,
  type ExportPackage,
} from "../../lib/bridge";
import { copyText } from "../../lib/clipboard";
import { useUiStore } from "../../store/useUiStore";

export default function AgentExportPanel({
  targetType,
  targetId,
  taskId,
}: {
  targetType: "item" | "group";
  targetId: string;
  taskId?: string | null;
}) {
  const showToast = useUiStore((s) => s.showToast);
  const [open, setOpen] = useState(false);
  const [targets, setTargets] = useState<AgentClipboardTarget[] | null>(null);
  const [pkg, setPkg] = useState<ExportPackage | null>(null);
  const [busy, setBusy] = useState(false);

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next && targets === null) {
      try {
        setTargets(await clipboardAgentTargets());
      } catch (e) {
        setTargets([]);
        showToast(`读取 Agent 列表失败：${String(e)}`, { kind: "error" });
      }
    }
  }

  async function onExport() {
    setBusy(true);
    try {
      const p = await clipboardExportForAgent(targetType, targetId, taskId ?? null);
      setPkg(p);
      showToast(`已导出 ${p.item_count} 项到本地文件（未发送）`, { kind: "success" });
    } catch (e) {
      showToast(`导出失败：${String(e)}`, { kind: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function onCopyPath(path: string) {
    const ok = await copyText(path);
    showToast(ok ? "路径已复制" : `路径：${path}`, { kind: ok ? "success" : "info" });
  }

  return (
    <div className="clip-agent-export">
      <button className="btn sm" onClick={toggle} aria-expanded={open}>
        <Bot size={12} /> 导出给 Agent…
      </button>
      {open && (
        <div className="clip-agent-body">
          <div className="clip-hint">
            仅生成<strong>本地文件包</strong>（Markdown + 图片 + manifest），不会自动上传或发送给任何
            Agent。请在目标 Agent 中手动附加文件。
            若 Agent 窗口已打开，也可以在分组详情中手动选择该窗口逐项粘贴；那只会发送按键动作，
            是否被接收无法自动验证，且绝不会自动触发。
            {taskId ? " 任务上下文会写入导出包。" : ""}
          </div>
          {targets === null ? (
            <div className="clip-hint">正在探测已接入的 Agent…</div>
          ) : targets.length === 0 ? (
            <div className="clip-hint">未发现已注册的 Agent；仍可导出本地文件后手动附加。</div>
          ) : (
            <ul className="clip-agent-list">
              {targets.map((t) => (
                <li key={t.source_id} className={t.installed ? "" : "disabled"}>
                  <span className="clip-agent-name">{t.display_name}</span>
                  <span className={`clip-agent-state ${t.window_present ? "ok" : ""}`}>
                    {t.installed ? (t.window_present ? "窗口可用" : "已安装") : "未安装"}
                  </span>
                  <span className="clip-agent-note">{t.note}</span>
                  <span className="clip-agent-note">
                    直接发送：{t.direct_send.supported ? "可用" : "不支持"} · 文件导入：
                    {t.file_import.supported ? "可用" : "未验证"} · 桌面粘贴：
                    {t.desktop_paste.supported ? "可手动触发" : "不可用"} · 本地导出：可用
                  </span>
                  <span className="clip-agent-note">{t.direct_send.note}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="clip-agent-actions">
            <button className="btn sm primary" onClick={onExport} disabled={busy}>
              {busy ? <RefreshCw size={12} className="spin" /> : <FolderOutput size={12} />} 导出本地文件包
            </button>
          </div>
          {pkg && (
            <div className="clip-export-result">
              <div className="clip-export-line">
                <span>导出目录</span>
                <code>{pkg.dir}</code>
                <button className="icon-btn sm" title="复制目录" aria-label="复制导出目录" onClick={() => onCopyPath(pkg.dir)}>
                  <Copy size={11} />
                </button>
              </div>
              <div className="clip-export-line">
                <span>Markdown</span>
                <code>{pkg.markdown_path}</code>
                <button className="icon-btn sm" title="复制路径" aria-label="复制 Markdown 路径" onClick={() => onCopyPath(pkg.markdown_path)}>
                  <Copy size={11} />
                </button>
              </div>
              <div className="clip-hint">
                {pkg.summary}（{pkg.files.length} 个文件）
                {pkg.warnings.length > 0 ? `；${pkg.warnings.join("；")}` : ""}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
