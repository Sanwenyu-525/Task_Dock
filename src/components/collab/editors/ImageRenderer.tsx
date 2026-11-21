//! 图片文档的只读渲染器（预览模式）。
//!
//! 只显示原图与标注层：没有导入、删除、修改、保存入口，也不触发任何 IPC 写入。
//! 编辑能力由 `ImageAnnotator` 单独提供，二者不共用可写状态。

import { useMemo } from "react";
import { ImageOff, ImagePlus } from "lucide-react";
import type { VisualDocument } from "../../../lib/collab";
import AnnotationRenderer from "./AnnotationRenderer";
import AssetImage from "./AssetImage";
import { parseAnnotationContent } from "./annotation-types";
import "./image-annotator.css";

export default function ImageRenderer({ doc }: { doc: VisualDocument }) {
  const content = useMemo(
    () => parseAnnotationContent(doc.sourceContent),
    [doc.sourceContent],
  );
  const annotate = doc.kind === "bug_annotation";

  if (!content.assetId) {
    return (
      <div className="image-annotator-empty" data-testid="image-renderer-empty">
        <ImagePlus size={28} />
        <strong>还没有图片</strong>
        <p>
          {content.image
            ? "该文档引用的是旧版受控路径，当前无法预览；请在编辑模式重新导入为资产。"
            : "该文档尚未导入图片；切换到「编辑」后可以导入并标注。"}
        </p>
      </div>
    );
  }

  return (
    <div className="image-annotator is-readonly" data-testid="image-renderer">
      <div className="image-annotator-stage">
        <div
          className="image-annotator-canvas"
          style={{ aspectRatio: `${content.width} / ${content.height}` }}
        >
          <AssetImage
            assetId={content.assetId}
            alt={doc.title}
            className="image-annotator-image"
          />
          {annotate ? (
            <AnnotationRenderer
              width={content.width}
              height={content.height}
              annotations={content.annotations}
            />
          ) : null}
        </div>
        <div className="collab-muted">
          {content.width}×{content.height}
          {annotate ? ` · ${content.annotations.length} 条标注` : ""} · 只读预览
        </div>
      </div>
      {!annotate ? null : content.annotations.length ? (
        <ul className="image-annotation-readonly-list" aria-label="标注说明列表">
          {content.annotations.map((annotation, index) => (
            <li key={`${annotation.shape}-${index}`}>
              <span className="collab-muted">#{index + 1} {annotation.shape}</span>
              <span>{annotation.note || "（无说明）"}</span>
              <span className="collab-muted">严重程度：{annotation.severity}</span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="collab-muted">
          <ImageOff size={14} /> 该图片还没有标注。
        </div>
      )}
    </div>
  );
}
