//! 协作中心 · 统一可视化工作台。
//!
//! 预览：GraphPreview / PrototypeInteractionSimulator / 图片标注；
//! 编辑：GraphEditor / PrototypeEditor / ImageAnnotator；
//! 版本：列表、对比、恢复（恢复生成新版本，不删历史）。
//!
//! 所有内容来自结构化 `sourceContent`，不执行 HTML/JS；高亮/编辑均走 IPC。

import { useEffect, useState } from "react";
import {
  ArrowLeftRight,
  ChevronLeft,
  Download,
  History,
  Loader2,
  Pencil,
  Eye,
} from "lucide-react";
import StatusBadge from "../ui/StatusBadge";
import EmptyState from "../ui/EmptyState";
import {
  collabVisualCompare,
  collabVisualExport,
  collabVisualRestore,
  collabVisualVersions,
  type VisualDiff,
  type VisualDocument,
  type VisualVersion,
} from "../../lib/collab";
import { errorMessage } from "../../lib/errors";
import GraphPreview from "./editors/GraphPreview";
import GraphEditor from "./editors/GraphEditor";
import PrototypeEditor from "./editors/PrototypeEditor";
import PrototypeInteractionSimulator from "./editors/PrototypeInteractionSimulator";
import ImageAnnotator from "./editors/ImageAnnotator";
import { isGraphKind, parseGraph } from "./editors/graph-types";
import { parsePrototype } from "./editors/prototype-types";

const KIND_LABEL: Record<string, string> = {
  flowchart: "流程图",
  architecture: "架构图",
  dataflow: "数据流图",
  prototype: "交互式原型",
  bug_annotation: "Bug 标注",
  static_image: "静态图片",
  diff: "版本对比",
};

const AUTHORING_LABEL: Record<string, string> = {
  manual: "人工创作",
  ai_generated: "AI 生成",
  ai_assisted: "AI 辅助",
  agent_authored: "Agent 创作",
  imported: "导入",
};

function toneForStatus(status: string) {
  if (["published", "approved", "verified", "completed"].includes(status)) return "success" as const;
  if (["archived", "closed"].includes(status)) return "neutral" as const;
  if (["draft", "open"].includes(status)) return "info" as const;
  return "warning" as const;
}

export default function VisualViewer({
  doc,
  onUpdate,
}: {
  doc: VisualDocument;
  onUpdate?: (doc: VisualDocument) => void;
}) {
  const [tab, setTab] = useState<"preview" | "edit" | "versions">("preview");
  const [versions, setVersions] = useState<VisualVersion[]>([]);
  const [diff, setDiff] = useState<VisualDiff | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [fromV, setFromV] = useState(1);
  const [toV, setToV] = useState(1);

  const isGraph = isGraphKind(doc.kind);
  const isPrototype = doc.kind === "prototype";
  const isImage = doc.kind === "bug_annotation" || doc.kind === "static_image";

  useEffect(() => {
    setTab("preview");
    setVersions([]);
    setDiff(null);
    setError("");
  }, [doc.id]);

  const loadVersions = async () => {
    setBusy(true);
    setError("");
    try {
      const page = await collabVisualVersions(doc.id);
      setVersions(page.items);
      setFromV(Math.max(1, doc.version - 1));
      setToV(doc.version);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const openVersions = () => {
    setTab("versions");
    if (!versions.length) void loadVersions();
  };

  const compare = async () => {
    setBusy(true);
    setError("");
    try {
      setDiff(await collabVisualCompare(doc.id, fromV, toV));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const restore = async (version: number) => {
    setBusy(true);
    setError("");
    try {
      const next = await collabVisualRestore(doc.id, version, doc.revision);
      onUpdate?.(next);
      await loadVersions();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const exportFile = async () => {
    setBusy(true);
    setError("");
    try {
      const format = isGraph ? "svg" : "json";
      const result = await collabVisualExport(doc.id, format);
      const blob = new Blob([result.content], {
        type: isGraph ? "image/svg+xml" : "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = result.filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const saved = (next: VisualDocument) => {
    onUpdate?.(next);
    if (tab === "versions") void loadVersions();
  };

  return (
    <div className="collab-visual-viewer">
      <div className="collab-visual-head">
        <div className="collab-visual-title">
          <strong>{doc.title}</strong>
          <StatusBadge tone={toneForStatus(doc.status)} size="sm">
            {KIND_LABEL[doc.kind] ?? doc.kind}
          </StatusBadge>
          <StatusBadge tone={doc.authoringMode === "manual" ? "neutral" : "info"} size="sm">
            {AUTHORING_LABEL[doc.authoringMode] ?? doc.authoringMode}
          </StatusBadge>
          <span className="collab-muted">v{doc.version}</span>
        </div>
        <div className="collab-viewer-actions">
          <button className={`btn ghost small ${tab === "preview" ? "is-active" : ""}`} onClick={() => setTab("preview")}>
            <Eye size={14} /> 预览
          </button>
          <button className={`btn ghost small ${tab === "edit" ? "is-active" : ""}`} onClick={() => setTab("edit")}>
            <Pencil size={14} /> 编辑
          </button>
          <button className={`btn ghost small ${tab === "versions" ? "is-active" : ""}`} onClick={openVersions}>
            <History size={14} /> 版本
          </button>
          <button className="btn ghost small" onClick={() => void exportFile()} disabled={busy}>
            <Download size={14} /> 导出
          </button>
        </div>
      </div>
      {error ? <div className="collab-inline-error">{error}</div> : null}

      {tab === "preview" ? (
        <div className="collab-visual-body">
          {isGraph ? (
            <GraphPreview graph={parseGraph(doc.sourceContent)} />
          ) : isPrototype ? (
            <PrototypeInteractionSimulator
              docId={doc.id}
              content={parsePrototype(doc.sourceContent)}
              serverBacked
            />
          ) : isImage ? (
            <ImageAnnotator doc={doc} onSaved={saved} onError={setError} />
          ) : doc.kind === "diff" ? (
            <pre className="collab-source-json">{doc.sourceContent}</pre>
          ) : (
            <EmptyState title="不支持的可视化类型" hint="该文档没有可用的渲染器。" />
          )}
        </div>
      ) : tab === "edit" ? (
        <div className="collab-visual-body">
          {isGraph ? (
            <GraphEditor doc={doc} onSaved={saved} onError={setError} />
          ) : isPrototype ? (
            <PrototypeEditor doc={doc} onSaved={saved} onError={setError} />
          ) : isImage ? (
            <ImageAnnotator doc={doc} onSaved={saved} onError={setError} />
          ) : (
            <EmptyState
              title="该类型不支持图形化编辑"
              hint={doc.kind === "diff" ? "版本对比由系统生成，只读。" : "请通过对应入口创建或修改。"}
            />
          )}
        </div>
      ) : (
        <div className="collab-versions">
          <div className="collab-version-compare">
            <label>
              从
              <input
                type="number"
                min={1}
                max={doc.version}
                value={fromV}
                onChange={(e) => setFromV(Number(e.target.value))}
                className="input small"
              />
            </label>
            <ArrowLeftRight size={14} />
            <label>
              到
              <input
                type="number"
                min={1}
                max={doc.version}
                value={toV}
                onChange={(e) => setToV(Number(e.target.value))}
                className="input small"
              />
            </label>
            <button className="btn small" onClick={() => void compare()} disabled={busy}>
              对比
            </button>
          </div>
          {diff ? (
            <div className="collab-diff">
              <div className="collab-muted">{diff.summary}</div>
              {diff.items.map((item, i) => (
                <div key={`${item.path}-${i}`} className="collab-diff-row">
                  <StatusBadge
                    tone={item.change === "added" ? "success" : item.change === "removed" ? "danger" : "warning"}
                    size="sm"
                  >
                    {item.change}
                  </StatusBadge>
                  <span className="collab-diff-path">{item.path}</span>
                  <span className="collab-diff-value">
                    {item.before ?? "—"} → {item.after ?? "—"}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
          <div className="collab-version-list">
            {busy && !versions.length ? <Loader2 size={16} className="spin" /> : null}
            {versions.map((v) => (
              <div key={v.id} className="collab-version-row">
                <span className="collab-version-tag">v{v.version}</span>
                <span className="collab-version-summary">{v.changeSummary || "无说明"}</span>
                <span className="collab-muted">{AUTHORING_LABEL[v.authoringMode] ?? v.authoringMode}</span>
                <span className="collab-muted">{v.createdAt.slice(0, 19).replace("T", " ")}</span>
                <button className="btn ghost small" onClick={() => void restore(v.version)} disabled={busy || v.version === doc.version}>
                  恢复
                </button>
              </div>
            ))}
            {!versions.length && !busy ? <EmptyState title="暂无版本记录" hint="第一次修改后会生成版本快照。" /> : null}
          </div>
          <button className="btn ghost small collab-back" onClick={() => setTab("preview")}>
            <ChevronLeft size={14} /> 返回预览
          </button>
        </div>
      )}
    </div>
  );
}
