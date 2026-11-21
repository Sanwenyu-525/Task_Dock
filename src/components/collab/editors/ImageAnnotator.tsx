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
import { AnnotationShape } from "./AnnotationRenderer";
import AssetImage from "./AssetImage";
import {
  parseAnnotationContent,
  type Annotation,
  type AnnotationContent,
  type AnnotationShapeKind,
} from "./annotation-types";
import "./image-annotator.css";

export { parseAnnotationContent };
export type { Annotation, AnnotationContent };

const SHAPES: Array<{ value: AnnotationShapeKind; label: string; icon: typeof Square }> = [
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
  const [tool, setTool] = useState<AnnotationShapeKind | "select">("select");
  const [selected, setSelected] = useState<number | null>(null);
  const [assets, setAssets] = useState<VisualAsset[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [summary, setSummary] = useState("");
  const [dirty, setDirty] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [draft, setDraft] = useState<Annotation | null>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const annotationDragRef = useRef<{
    index: number;
    mode: "move" | "resize";
    start: { x: number; y: number };
    origin: Annotation;
  } | null>(null);
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
        title: "选择图片（png/jpg/jpeg/webp/gif，≤8 MiB）",
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
      // 点在空白处才取消选择；点在标注上由 AnnotationShape 处理拖动。
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

  const beginAnnotationDrag = (index: number, mode: "move" | "resize") => (
    event: ReactPointerEvent,
  ) => {
    const annotation = contentRef.current.annotations[index];
    if (!annotation) return;
    event.stopPropagation();
    setSelected(index);
    setTool("select");
    annotationDragRef.current = {
      index,
      mode,
      start: pointOf(event),
      origin: annotation,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const onPointerMove = (event: ReactPointerEvent) => {
    const moving = annotationDragRef.current;
    if (moving) {
      const point = pointOf(event);
      const dx = point.x - moving.start.x;
      const dy = point.y - moving.start.y;
      const origin = moving.origin;
      if (moving.mode === "move") {
        updateAnnotation(moving.index, {
          x: Math.max(0, origin.x + dx),
          y: Math.max(0, origin.y + dy),
        });
      } else {
        updateAnnotation(moving.index, {
          w: Math.max(4, origin.w + dx),
          h: Math.max(4, origin.h + dy),
        });
      }
      return;
    }
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
    if (annotationDragRef.current) {
      annotationDragRef.current = null;
      return;
    }
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
          <p>导入截图或效果图后即可预览与标注；原始图片不会被标注修改。</p>
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
                  onPointerDown={beginAnnotationDrag(index, "move")}
                />
              ))}
              {draft ? <AnnotationShape annotation={draft} selected={false} /> : null}
              {selected !== null && content.annotations[selected] &&
              content.annotations[selected].shape !== "text" ? (
                <rect
                  className="annotation-resize-handle"
                  data-testid="annotation-resize-handle"
                  x={content.annotations[selected].x + content.annotations[selected].w - 4}
                  y={content.annotations[selected].y + content.annotations[selected].h - 4}
                  width={9}
                  height={9}
                  onPointerDown={beginAnnotationDrag(selected, "resize")}
                />
              ) : null}
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
