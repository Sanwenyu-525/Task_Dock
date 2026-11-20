//! 图片导入与标注编辑器。
//!
//! 原始图片作为受控资产保存，标注层单独存入文档 JSON；保存只写标注层，
//! 永不改写原图。只支持应用内资产（`va_…`），不加载外部 URL。

import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  ArrowUpRight,
  Circle,
  Download,
  Highlighter,
  ImagePlus,
  Loader2,
  MousePointer2,
  Save,
  Square,
  Trash2,
  Type,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import Select from "../../ui/Select";
import {
  collabVisualAssetImport,
  collabVisualAssetList,
  collabVisualUpdate,
  type VisualAsset,
  type VisualDocument,
} from "../../../lib/collab";
import { errorMessage } from "../../../lib/errors";
import AssetImage from "./AssetImage";
import "./image-annotator.css";

type Shape = "rect" | "circle" | "arrow" | "text" | "highlight";

interface Annotation {
  shape: Shape;
  x: number;
  y: number;
  w: number;
  h: number;
  note: string;
  severity: string;
  color?: string;
}

interface AnnotationContent {
  assetId?: string;
  image?: string;
  width: number;
  height: number;
  annotations: Annotation[];
  /** static_image 的附加参数：编辑时保留，避免保存后丢失。 */
  params?: Record<string, unknown>;
}

const SHAPES: Array<{ value: Shape; label: string; icon: typeof Square }> = [
  { value: "rect", label: "矩形", icon: Square },
  { value: "circle", label: "圆形", icon: Circle },
  { value: "arrow", label: "箭头", icon: ArrowUpRight },
  { value: "text", label: "文字", icon: Type },
  { value: "highlight", label: "重点", icon: Highlighter },
];

const SEVERITIES = [
  { value: "low", label: "低" },
  { value: "medium", label: "中" },
  { value: "high", label: "高" },
  { value: "critical", label: "严重" },
];

export function parseAnnotationContent(raw: string): AnnotationContent {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const annotations = Array.isArray(parsed.annotations)
      ? parsed.annotations
          .filter((a): a is Record<string, unknown> => !!a && typeof a === "object")
          .map((a) => ({
            shape: (["rect", "circle", "arrow", "text", "highlight"].includes(String(a.shape))
              ? String(a.shape)
              : "rect") as Shape,
            x: Number(a.x) || 0,
            y: Number(a.y) || 0,
            w: Number(a.w) || 0,
            h: Number(a.h) || 0,
            note: String(a.note ?? ""),
            severity: String(a.severity ?? "medium"),
            color: typeof a.color === "string" ? a.color : undefined,
          }))
      : [];
    return {
      assetId: typeof parsed.assetId === "string" ? parsed.assetId : undefined,
      image: typeof parsed.image === "string" ? parsed.image : undefined,
      width: Number(parsed.width) || 1280,
      height: Number(parsed.height) || 720,
      annotations,
      params:
        parsed.params && typeof parsed.params === "object"
          ? (parsed.params as Record<string, unknown>)
          : undefined,
    };
  } catch {
    return { width: 1280, height: 720, annotations: [] };
  }
}

export interface ImageAnnotatorProps {
  doc: VisualDocument;
  onSaved: (doc: VisualDocument) => void;
  onError?: (message: string) => void;
}

export default function ImageAnnotator({ doc, onSaved, onError }: ImageAnnotatorProps) {
  const annotate = doc.kind === "bug_annotation";
  const [content, setContent] = useState<AnnotationContent>(() =>
    parseAnnotationContent(doc.sourceContent),
  );
  const contentRef = useRef(content);
  contentRef.current = content;
  const [tool, setTool] = useState<Shape | "select">("select");
  const [selected, setSelected] = useState<number | null>(null);
  const [assets, setAssets] = useState<VisualAsset[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [summary, setSummary] = useState("");
  const [dirty, setDirty] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [draft, setDraft] = useState<Annotation | null>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const overlayRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    setContent(parseAnnotationContent(doc.sourceContent));
    setSelected(null);
    setDirty(false);
    setError("");
  }, [doc.id, doc.revision, doc.sourceContent]);

  useEffect(() => {
    let cancelled = false;
    collabVisualAssetList(doc.projectId, doc.id)
      .then((list) => {
        if (!cancelled) setAssets(list);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [doc.projectId, doc.id]);

  const fail = (e: unknown) => {
    const message = errorMessage(e);
    setError(message);
    onError?.(message);
  };

  const update = (next: AnnotationContent) => {
    contentRef.current = next;
    setContent(next);
    setDirty(true);
  };

  const importImage = async () => {
    setError("");
    try {
      const selectedPath = await openDialog({
        multiple: false,
        directory: false,
        title: "选择图片（png/jpg/jpeg/webp/gif，≤32 MiB）",
      });
      if (typeof selectedPath !== "string") return;
      setBusy(true);
      const asset = await collabVisualAssetImport(doc.projectId, {
        path: selectedPath,
        title: doc.title,
        documentId: doc.id,
      });
      setAssets((list) => [asset, ...list.filter((a) => a.id !== asset.id)]);
      update({ ...contentRef.current, assetId: asset.id });
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const pointOf = (event: ReactPointerEvent): { x: number; y: number } => {
    const rect = overlayRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return { x: 0, y: 0 };
    return {
      x: Math.round(((event.clientX - rect.left) / rect.width) * contentRef.current.width),
      y: Math.round(((event.clientY - rect.top) / rect.height) * contentRef.current.height),
    };
  };

  const onPointerDown = (event: ReactPointerEvent) => {
    if (tool === "select") {
      setSelected(null);
      return;
    }
    const point = pointOf(event);
    startRef.current = point;
    if (tool === "text") {
      const annotation: Annotation = {
        shape: "text",
        x: point.x,
        y: point.y,
        w: 0,
        h: 0,
        note: "说明文字",
        severity: "medium",
        color: "var(--status-danger)",
      };
      const next = [...contentRef.current.annotations, annotation];
      update({ ...contentRef.current, annotations: next });
      setSelected(next.length - 1);
      startRef.current = null;
      setTool("select");
      return;
    }
    setDraft({
      shape: tool,
      x: point.x,
      y: point.y,
      w: 0,
      h: 0,
      note: "",
      severity: "medium",
      color: "var(--status-danger)",
    });
  };

  const onPointerMove = (event: ReactPointerEvent) => {
    if (!draft || !startRef.current) return;
    const point = pointOf(event);
    const start = startRef.current;
    setDraft({
      ...draft,
      x: Math.min(start.x, point.x),
      y: Math.min(start.y, point.y),
      w: Math.abs(point.x - start.x),
      h: Math.abs(point.y - start.y),
    });
  };

  const onPointerUp = () => {
    const current = draft;
    setDraft(null);
    startRef.current = null;
    if (!current) return;
    if (current.w < 4 && current.h < 4) return;
    const next = [...contentRef.current.annotations, current];
    update({ ...contentRef.current, annotations: next });
    setSelected(next.length - 1);
    setTool("select");
  };

  const updateAnnotation = (index: number, patch: Partial<Annotation>) => {
    const annotations = contentRef.current.annotations.map((a, i) =>
      i === index ? { ...a, ...patch } : a,
    );
    update({ ...contentRef.current, annotations });
  };

  const removeAnnotation = (index: number) => {
    const annotations = contentRef.current.annotations.filter((_, i) => i !== index);
    update({ ...contentRef.current, annotations });
    setSelected(null);
  };

  const save = async () => {
    if (!contentRef.current.assetId && !contentRef.current.image) {
      setError("请先导入图片");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const payload: AnnotationContent =
        doc.kind === "static_image"
          ? contentRef.current
          : {
              assetId: contentRef.current.assetId,
              image: contentRef.current.image,
              width: contentRef.current.width,
              height: contentRef.current.height,
              annotations: contentRef.current.annotations,
            };
      const next = await collabVisualUpdate(
        doc.id,
        doc.revision,
        { sourceContent: JSON.stringify(payload) },
        summary.trim() || "图片标注",
      );
      setDirty(false);
      setSummary("");
      onSaved(next);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(contentRef.current)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${doc.id}-annotation.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const current = selected !== null ? content.annotations[selected] : null;
  const selectedAsset = useMemo(
    () => assets.find((a) => a.id === content.assetId),
    [assets, content.assetId],
  );

  return (
    <div className="image-annotator">
      <div className="image-annotator-toolbar" role="toolbar" aria-label="图片标注工具栏">
        <button className="btn small" onClick={() => void importImage()} disabled={busy}>
          {busy ? <Loader2 size={14} className="spin" /> : <ImagePlus size={14} />} 导入图片
        </button>
        {assets.length ? (
          <Select
            value={content.assetId ?? ""}
            options={assets.map((a) => ({
              value: a.id,
              label: a.title || a.sha256.slice(0, 8),
            }))}
            onChange={(value) => update({ ...contentRef.current, assetId: value })}
            ariaLabel="选择已有资产"
            size="sm"
            placeholder="选择已有资产"
          />
        ) : null}
        <span className="graph-toolbar-sep" />
        <button
          className="btn icon-btn"
          aria-label="缩小图片"
          data-tip="缩小"
          onClick={() => setZoom((z) => Math.max(0.4, Number((z - 0.1).toFixed(2))))}
        >
          <ZoomOut size={14} />
        </button>
        <span className="collab-zoom-label">{Math.round(zoom * 100)}%</span>
        <button
          className="btn icon-btn"
          aria-label="放大图片"
          data-tip="放大"
          onClick={() => setZoom((z) => Math.min(2, Number((z + 0.1).toFixed(2))))}
        >
          <ZoomIn size={14} />
        </button>
        {annotate ? (
          <>
            <span className="graph-toolbar-sep" />
            <button
              className={`btn icon-btn ${tool === "select" ? "is-active" : ""}`}
              aria-label="选择"
              data-tip="选择/移动"
              onClick={() => setTool("select")}
            >
              <MousePointer2 size={14} />
            </button>
            {SHAPES.map((shape) => (
              <button
                key={shape.value}
                className={`btn icon-btn ${tool === shape.value ? "is-active" : ""}`}
                aria-label={shape.label}
                data-tip={shape.label}
                onClick={() => setTool(shape.value)}
              >
                <shape.icon size={14} />
              </button>
            ))}
          </>
        ) : null}
        <div className="graph-toolbar-spacer" />
        <button className="btn ghost small" onClick={exportJson}>
          <Download size={14} /> 导出 JSON
        </button>
        <input
          className="input small graph-summary"
          aria-label="版本说明"
          placeholder="版本说明（可选）"
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
        />
        <button className="btn small" onClick={() => void save()} disabled={busy}>
          {busy ? <Loader2 size={14} className="spin" /> : <Save size={14} />} 保存{dirty ? " *" : ""}
        </button>
      </div>

      {error ? <div className="collab-inline-error">{error}</div> : null}

      {!content.assetId && !content.image ? (
        <div className="image-annotator-empty">
          <ImagePlus size={28} />
          <strong>还没有图片</strong>
          <p>导入截图或效果图后即可预览与标注；原始图片不会被子标注修改。</p>
          <button className="btn" onClick={() => void importImage()} disabled={busy}>
            选择图片文件
          </button>
        </div>
      ) : content.assetId ? (
        <div className="image-annotator-stage">
          <div
            className="image-annotator-canvas"
            style={{
              aspectRatio: `${content.width} / ${content.height}`,
              width: zoom <= 1 ? undefined : Math.min(1800, Math.round(880 * zoom)),
              maxWidth: zoom <= 1 ? undefined : "none",
            }}
          >
            <AssetImage
              assetId={content.assetId}
              alt={doc.title}
              className="image-annotator-image"
              onNaturalSize={(w, h) => {
                if (w > 0 && h > 0 && (w !== content.width || h !== content.height)) {
                  update({ ...contentRef.current, width: w, height: h });
                }
              }}
            />
            <svg
              ref={overlayRef}
              data-testid="annotation-overlay"
              className={`image-annotator-overlay tool-${tool}`}
              viewBox={`0 0 ${content.width} ${content.height}`}
              preserveAspectRatio="none"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerLeave={onPointerUp}
            >
              <defs>
                <marker id="annotation-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
                  <path d="M0,0 L8,4 L0,8 z" style={{ fill: "var(--status-danger)" }} />
                </marker>
              </defs>
              {content.annotations.map((annotation, index) => (
                <AnnotationShape
                  key={`${annotation.shape}-${index}`}
                  annotation={annotation}
                  selected={selected === index}
                  onSelect={() => {
                    setSelected(index);
                    setTool("select");
                  }}
                />
              ))}
              {draft ? <AnnotationShape annotation={draft} selected={false} onSelect={() => undefined} /> : null}
            </svg>
          </div>
          <div className="collab-muted">
            {content.width}×{content.height}
            {selectedAsset ? ` · ${selectedAsset.sizeBytes} B` : ""}
            {annotate ? ` · ${content.annotations.length} 条标注` : ""}
          </div>
        </div>
      ) : (
        <div className="collab-muted">图片引用来自旧版受控路径，当前仅能保存元数据；请重新导入为资产。</div>
      )}

      {annotate && current !== null ? (
        <div className="image-annotation-props">
          <strong>标注 {selected !== null ? selected + 1 : ""}</strong>
          <label>
            说明
            <input
              className="input"
              value={current.note}
              onChange={(e) =>
                selected !== null && updateAnnotation(selected, { note: e.target.value })
              }
            />
          </label>
          <label>
            严重程度
            <Select
              value={current.severity}
              options={SEVERITIES}
              onChange={(value) =>
                selected !== null && updateAnnotation(selected, { severity: value })
              }
              ariaLabel="严重程度"
              size="sm"
              block
            />
          </label>
          <button className="btn ghost small" onClick={() => selected !== null && removeAnnotation(selected)}>
            <Trash2 size={14} /> 删除标注
          </button>
        </div>
      ) : null}
    </div>
  );
}

function AnnotationShape({
  annotation,
  selected,
  onSelect,
}: {
  annotation: Annotation;
  selected: boolean;
  onSelect: () => void;
}) {
  const color = annotation.color ?? "var(--status-danger)";
  const stroke = { stroke: color, strokeWidth: selected ? 3 : 2, fill: "none" };
  const common = {
    className: "annotation-shape",
    onPointerDown: (event: ReactPointerEvent) => {
      event.stopPropagation();
      onSelect();
    },
  } as const;
  switch (annotation.shape) {
    case "circle":
      return (
        <ellipse
          cx={annotation.x + annotation.w / 2}
          cy={annotation.y + annotation.h / 2}
          rx={Math.max(1, annotation.w / 2)}
          ry={Math.max(1, annotation.h / 2)}
          {...stroke}
          {...common}
        />
      );
    case "arrow":
      return (
        <line
          x1={annotation.x}
          y1={annotation.y}
          x2={annotation.x + annotation.w}
          y2={annotation.y + annotation.h}
          {...stroke}
          markerEnd="url(#annotation-arrow)"
          {...common}
        />
      );
    case "text":
      return (
        <text
          x={annotation.x}
          y={annotation.y}
          fontSize={Math.max(14, annotation.h || 16)}
          style={{ fill: color, cursor: "pointer" }}
          {...common}
        >
          {annotation.note || "说明文字"}
        </text>
      );
    case "highlight":
      return (
        <rect
          x={annotation.x}
          y={annotation.y}
          width={Math.max(1, annotation.w)}
          height={Math.max(1, annotation.h)}
          style={{ fill: color, opacity: 0.28, stroke: color, strokeWidth: 1 }}
          {...common}
        />
      );
    default:
      return (
        <rect
          x={annotation.x}
          y={annotation.y}
          width={Math.max(1, annotation.w)}
          height={Math.max(1, annotation.h)}
          {...stroke}
          {...common}
        />
      );
  }
}
