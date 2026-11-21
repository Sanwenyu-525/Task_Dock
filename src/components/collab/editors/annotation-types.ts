//! 图片标注的共享类型与解析：预览（只读）与编辑（可写）共用同一份数据契约。

export type AnnotationShapeKind = "rect" | "circle" | "arrow" | "text" | "highlight";

export interface Annotation {
  shape: AnnotationShapeKind;
  x: number;
  y: number;
  w: number;
  h: number;
  note: string;
  severity: string;
  color?: string;
}

export interface AnnotationContent {
  assetId?: string;
  image?: string;
  width: number;
  height: number;
  annotations: Annotation[];
  /** static_image 的附加参数：编辑时保留，避免保存后丢失。 */
  params?: Record<string, unknown>;
}

export const SHAPE_KINDS: AnnotationShapeKind[] = [
  "rect",
  "circle",
  "arrow",
  "text",
  "highlight",
];

export function parseAnnotationContent(raw: string): AnnotationContent {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const annotations = Array.isArray(parsed.annotations)
      ? parsed.annotations
          .filter((a): a is Record<string, unknown> => !!a && typeof a === "object")
          .map((a) => ({
            shape: (SHAPE_KINDS.includes(String(a.shape) as AnnotationShapeKind)
              ? String(a.shape)
              : "rect") as AnnotationShapeKind,
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
