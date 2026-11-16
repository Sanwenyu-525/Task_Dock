//! 通用线「materials」模块（U1 D3）：把文件、文件夹、链接、笔记关联到项目。
//!
//! - 只存真实路径 / URL / 笔记 ID 与元数据；删除关联不删除、不移动原始文件。
//! - 读侧派生 `alive`：文件/目录存在性、URL 合法性、笔记记录是否仍在；失效显示原因。
//! - 项目隔离：资料按 `projectId` 查询，切换项目不串资料。
//! - 归档项目只读；IPC 只经本目录 `./ipc.ts` 的包装。

import { useEffect, useRef, useState } from "react";
import { Folder, FileText, Link2, StickyNote, Loader2, Trash2, FolderOpen, Plus } from "lucide-react";

import type { CreativeModuleProps } from "../types";
import { errorMessage } from "../../../lib/errors";
import Select from "../../../components/ui/Select";
import {
  generalMaterialDelete,
  generalMaterialList,
  generalMaterialOpen,
  generalMaterialSave,
  type GeneralMaterial,
  type MaterialKind,
} from "./ipc";
import "./general.css";

const KIND_LABEL: Record<MaterialKind, string> = {
  file: "文件",
  folder: "文件夹",
  link: "链接",
  note: "笔记",
};

const KIND_ICON: Record<MaterialKind, typeof FileText> = {
  file: FileText,
  folder: Folder,
  link: Link2,
  note: StickyNote,
};

interface Draft {
  id: string | null;
  kind: MaterialKind;
  title: string;
  path: string;
  note: string;
}

function emptyDraft(): Draft {
  return { id: null, kind: "link", title: "", path: "", note: "" };
}

export default function MaterialsPanel({ projectId, archived }: CreativeModuleProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [materials, setMaterials] = useState<GeneralMaterial[]>([]);

  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "info" | "error"; text: string } | null>(null);
  const [filter, setFilter] = useState<MaterialKind | "all">("all");

  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  async function reload() {
    setError(null);
    setLoading(true);
    try {
      const res = await generalMaterialList(projectId);
      if (!aliveRef.current) return;
      setMaterials(res.materials);
    } catch (e) {
      if (aliveRef.current) setError(errorMessage(e));
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const filtered = filter === "all" ? materials : materials.filter((m) => m.kind === filter);

  async function browse() {
    if (!draft || archived) return;
    try {
      const { open: dialogOpen } = await import("@tauri-apps/plugin-dialog");
      const selected = await dialogOpen({
        directory: draft.kind === "folder",
        multiple: false,
        title: draft.kind === "folder" ? "选择文件夹" : "选择文件",
      });
      if (!aliveRef.current) return;
      const raw = Array.isArray(selected) ? selected[0] : selected;
      if (raw) {
        setDraft({ ...draft, path: raw, title: draft.title || raw.split(/[\\/]/).pop() || raw });
      }
    } catch (e) {
      if (aliveRef.current) setNotice({ tone: "error", text: errorMessage(e) });
    }
  }

  async function saveDraft() {
    if (!draft || archived || saving) return;
    if (!draft.title.trim()) {
      setNotice({ tone: "error", text: "资料标题不能为空。" });
      return;
    }
    if (!draft.path.trim()) {
      setNotice({ tone: "error", text: "请填写路径、链接地址或笔记 ID。" });
      return;
    }
    setSaving(true);
    try {
      await generalMaterialSave({
        id: draft.id,
        projectId,
        kind: draft.kind,
        title: draft.title.trim(),
        path: draft.path.trim(),
        note: draft.note,
      });
      if (!aliveRef.current) return;
      setDraft(null);
      setNotice(null);
      await reload();
    } catch (e) {
      if (aliveRef.current) setNotice({ tone: "error", text: errorMessage(e) });
    } finally {
      if (aliveRef.current) setSaving(false);
    }
  }

  async function removeMaterial(m: GeneralMaterial) {
    if (archived || busy) return;
    if (deletingId !== m.id) {
      setDeletingId(m.id);
      return;
    }
    setBusy(true);
    try {
      await generalMaterialDelete(m.id);
      if (!aliveRef.current) return;
      setDeletingId(null);
      await reload();
    } catch (e) {
      if (aliveRef.current) setError(errorMessage(e));
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  }

  async function openMaterial(m: GeneralMaterial) {
    try {
      const res = await generalMaterialOpen(m.id);
      if (!aliveRef.current) return;
      if (!res.opened) {
        setNotice({ tone: "info", text: "笔记类型请在快速笔记中查看；此处仅保留关联。" });
      }
    } catch (e) {
      if (aliveRef.current) setNotice({ tone: "error", text: errorMessage(e) });
    }
  }

  return (
    <div className="ws-general">
      {archived && (
        <div className="ws-notice" data-tone="info" role="status">
          <span>项目已归档，资料关联为只读；恢复为进行中后才能添加或移除。</span>
        </div>
      )}

      {error && (
        <div className="ws-notice" data-tone="error" role="alert">
          <span>{error}</span>
          <button type="button" className="ws-btn" onClick={() => void reload()}>
            重试
          </button>
        </div>
      )}

      <div className="ws-general-toolbar">
        <Select
          ariaLabel="按类型筛选资料"
          value={filter}
          options={[
            { value: "all", label: "全部类型" },
            ...(["file", "folder", "link", "note"] as MaterialKind[]).map((k) => ({
              value: k,
              label: KIND_LABEL[k],
            })),
          ]}
          onChange={(value) => setFilter(value as MaterialKind | "all")}
        />
        <button
          type="button"
          className="ws-btn"
          disabled={archived}
          onClick={() => setDraft(emptyDraft())}
        >
          <Plus size={12} /> 添加资料
        </button>
      </div>

      {draft && (
        <div className="ws-general-draft" aria-label="资料编辑">
          <div className="ws-form-row">
            <Select
              ariaLabel="资料类型"
              value={draft.kind}
              options={(Object.keys(KIND_LABEL) as MaterialKind[]).map((k) => ({
                value: k,
                label: KIND_LABEL[k],
              }))}
              onChange={(value) => setDraft({ ...draft, kind: value as MaterialKind, path: "" })}
            />
            <input
              className="ws-input ws-flex"
              aria-label="资料标题"
              value={draft.title}
              placeholder="资料标题"
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            />
          </div>
          <div className="ws-form-row">
            <input
              className="ws-input ws-flex"
              aria-label={draft.kind === "link" ? "链接地址" : draft.kind === "note" ? "笔记 ID" : "文件或文件夹路径"}
              value={draft.path}
              placeholder={
                draft.kind === "link"
                  ? "https://…"
                  : draft.kind === "note"
                    ? "关联笔记 ID"
                    : "绝对路径，或点击浏览选择"
              }
              onChange={(e) => setDraft({ ...draft, path: e.target.value })}
            />
            {(draft.kind === "file" || draft.kind === "folder") && (
              <button type="button" className="ws-btn" onClick={() => void browse()}>
                <FolderOpen size={12} /> 浏览
              </button>
            )}
          </div>
          <div className="ws-form-row">
            <textarea
              className="ws-input ws-flex"
              aria-label="资料备注"
              rows={2}
              value={draft.note}
              placeholder="备注（可选）"
              onChange={(e) => setDraft({ ...draft, note: e.target.value })}
            />
          </div>
          <div className="ws-general-draft-actions">
            <button
              type="button"
              className="ws-btn ws-btn-primary"
              disabled={saving}
              onClick={() => void saveDraft()}
            >
              {saving ? <Loader2 size={12} className="ws-spin" /> : null} 保存
            </button>
            <button type="button" className="ws-btn" onClick={() => setDraft(null)}>
              取消
            </button>
          </div>
        </div>
      )}

      {notice && (
        <div className="ws-notice" data-tone={notice.tone} role="status">
          <span>{notice.text}</span>
        </div>
      )}

      {loading ? (
        <div className="ws-state" data-tone="muted">
          <Loader2 size={12} className="ws-spin" /> 正在读取资料…
        </div>
      ) : filtered.length === 0 ? (
        <div className="ws-empty">还没有关联资料；可添加文件、文件夹、链接或笔记。</div>
      ) : (
        <ul className="ws-list">
          {filtered.map((m) => {
            const Icon = KIND_ICON[m.kind];
            return (
              <li className="ws-row ws-general-row" key={m.id}>
                <Icon size={13} className="ws-general-row-icon" />
                <div className="ws-flex ws-general-row-main">
                  <div className="ws-general-row-title">
                    <strong>{m.title}</strong>
                    <span className="ws-badge">{KIND_LABEL[m.kind]}</span>
                    {m.alive ? (
                      <span className="ws-badge ws-badge-available">可用</span>
                    ) : (
                      <span className="ws-badge ws-badge-unavailable">失效</span>
                    )}
                  </div>
                  <div className="ws-meta ws-path" title={m.path}>
                    {m.kind === "note" ? `笔记：${m.linkedTitle ?? m.path}` : m.path}
                  </div>
                  {!m.alive && m.aliveReason && (
                    <div className="ws-meta" data-tone="error">
                      {m.aliveReason}
                    </div>
                  )}
                  {m.note ? <div className="ws-meta">{m.note}</div> : null}
                </div>
                {!archived && (
                  <span className="ws-general-row-actions">
                    {m.kind !== "note" && (
                      <button
                        type="button"
                        className="ws-btn ws-btn-quiet"
                        aria-label={`打开 ${m.title}`}
                        data-tip="打开来源"
                        disabled={!m.alive}
                        onClick={() => void openMaterial(m)}
                      >
                        <FolderOpen size={12} />
                      </button>
                    )}
                    <button
                      type="button"
                      className="ws-btn ws-btn-quiet ws-btn-danger"
                      aria-label={deletingId === m.id ? `确认移除 ${m.title}` : `移除 ${m.title}`}
                      data-tip={deletingId === m.id ? "再次点击确认移除关联" : "移除关联（不删除原始文件）"}
                      disabled={busy}
                      onClick={() => void removeMaterial(m)}
                    >
                      <Trash2 size={12} />
                    </button>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
