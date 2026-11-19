//! PDF 预览：本地 pdfjs-dist（随包打包，禁止 CDN / 禁止上传），
//! `fs_read_binary` 读取原始字节 → 逐页渲染到 canvas。
//!
//! 资源边界：只渲染当前页；切换页面/缩放/关闭时取消渲染任务并销毁文档，
//! 避免 worker 与页面位图泄漏。CMap/标准字体/WASM 走本地 `/pdfjs/` 资源。

import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Maximize, Minus, Plus, Rows3 } from "lucide-react";
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { fsReadBinary } from "../../../lib/bridge";
import { useLocale } from "../../../hooks/useLocale";
import { errorMessage } from "../../../lib/errors";
import { formatSize } from "../../../lib/filesWorkspace/fileMeta";
import { PDF_MAX_BYTES } from "./previewKind";
import { base64ToBytes } from "./mediaToken";
import { PreviewError, PreviewLoading } from "./PreviewState";

interface Props {
  path: string;
  name: string;
  size: number | null;
}

export default function FilePdfPreview({ path, size }: Props) {
  const { t } = useLocale();
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 大小超限是「策略拒绝」而不是解析失败：错误标题直接给可操作原因。 */
  const [tooLarge, setTooLarge] = useState(false);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [page, setPage] = useState(1);
  const [mode, setMode] = useState<"page" | "width">("page");
  const [zoom, setZoom] = useState(100);
  const [rendering, setRendering] = useState(false);
  const [box, setBox] = useState({ width: 0, height: 0 });
  const [reloadKey, setReloadKey] = useState(0);

  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // 容器尺寸：适应宽度/适应页面都以此为基准（窗口缩放/分栏变化即时生效）。
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => setBox({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [status]);

  useEffect(() => {
    let cancelled = false;
    let loadingTask: PDFDocumentLoadingTask | null = null;
    setStatus("loading");
    setError(null);
    setTooLarge(false);
    setProgress(null);
    setDoc(null);
    setNumPages(0);
    setPage(1);
    setMode("page");
    setZoom(100);

    void (async () => {
      if (size !== null && size > PDF_MAX_BYTES) {
        setError(t("fw.preview.pdf.tooLarge", { size: formatSize(size) }));
        setTooLarge(true);
        setStatus("error");
        return;
      }
      try {
        const binary = await fsReadBinary(path, PDF_MAX_BYTES);
        if (cancelled) return;
        if (binary.truncated) {
          setError(t("fw.preview.pdf.tooLarge", { size: formatSize(binary.size) }));
          setTooLarge(true);
          setStatus("error");
          return;
        }
        const pdfjs = await import("pdfjs-dist");
        if (cancelled) return;
        pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
        loadingTask = pdfjs.getDocument({
          data: base64ToBytes(binary.base64),
          useSystemFonts: true,
          cMapUrl: "/pdfjs/cmaps/",
          cMapPacked: true,
          standardFontDataUrl: "/pdfjs/standard_fonts/",
          wasmUrl: "/pdfjs/wasm/",
        });
        loadingTask.onProgress = ({ loaded, total }: { loaded: number; total: number }) => {
          if (!cancelled) setProgress(total > 0 ? loaded / total : null);
        };
        const loaded = await loadingTask.promise;
        if (cancelled) {
          void loadingTask.destroy();
          return;
        }
        setNumPages(loaded.numPages);
        setDoc(loaded);
        setStatus("ready");
      } catch (e) {
        if (!cancelled) {
          setError(errorMessage(e));
          setStatus("error");
        }
      }
    })();

    return () => {
      cancelled = true;
      // 销毁 loading task 同时释放文档与 worker；幂等，不重复调用。
      void loadingTask?.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, size, reloadKey]);

  // 逐页渲染：只画当前页；页面/尺寸/缩放变化先取消旧任务。
  useEffect(() => {
    if (!doc || status !== "ready") return;
    if (box.width <= 0 || box.height <= 0) return;
    let cancelled = false;
    let renderTask: RenderTask | null = null;
    setRendering(true);

    void (async () => {
      try {
        const pageProxy = await doc.getPage(page);
        if (cancelled) return;
        const base = pageProxy.getViewport({ scale: 1 });
        // 适应页面留一点内边距；适应宽度按可用宽度铺满。
        const scaleX = (box.width - 16) / base.width;
        const scaleY = (box.height - 16) / base.height;
        const baseScale = mode === "width" ? scaleX : Math.min(scaleX, scaleY);
        const scale = Math.max(0.05, Math.min(4, baseScale * (zoom / 100)));
        const viewport = pageProxy.getViewport({ scale });
        const canvas = canvasRef.current;
        if (!canvas) return;
        const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
        canvas.width = Math.max(1, Math.floor(viewport.width * dpr));
        canvas.height = Math.max(1, Math.floor(viewport.height * dpr));
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        renderTask = pageProxy.render({
          canvas,
          viewport,
          transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
        });
        await renderTask.promise;
        if (!cancelled) setRendering(false);
      } catch (e) {
        if (cancelled) return;
        const name = (e as { name?: string } | null)?.name ?? "";
        if (name === "RenderingCancelledException") return;
        setError(errorMessage(e));
        setStatus("error");
        setRendering(false);
      }
    })();

    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [doc, status, page, mode, zoom, box.width, box.height]);

  if (status === "loading") {
    return (
      <PreviewLoading
        label={
          progress !== null
            ? t("fw.preview.pdf.loadingProgress", { percent: Math.round(progress * 100) })
            : t("fw.preview.loading")
        }
      />
    );
  }
  if (status === "error") {
    return (
      <PreviewError
        title={tooLarge ? error ?? t("fw.preview.pdf.tooLarge") : error ? t("fw.preview.error", { error }) : t("fw.preview.pdf.failed")}
        hint={t("fw.preview.fallbackOpen")}
        onRetry={tooLarge ? undefined : () => setReloadKey((value) => value + 1)}
        retryLabel={t("common.retry")}
      />
    );
  }

  return (
    <div className="fw-preview-pdf">
      <div className="fw-preview-pdf-bar">
        <div className="fw-preview-pdf-pages">
          <button
            type="button"
            className="fw-icon-btn"
            aria-label={t("fw.preview.pdf.prevPage")}
            disabled={page <= 1}
            onClick={() => setPage((value) => Math.max(1, value - 1))}
          >
            <ChevronLeft size={14} aria-hidden="true" />
          </button>
          <span className="fw-preview-pdf-counter" aria-live="polite">
            {t("fw.preview.pdf.pageOf", { page, total: numPages })}
          </span>
          <button
            type="button"
            className="fw-icon-btn"
            aria-label={t("fw.preview.pdf.nextPage")}
            disabled={page >= numPages}
            onClick={() => setPage((value) => Math.min(numPages, value + 1))}
          >
            <ChevronRight size={14} aria-hidden="true" />
          </button>
        </div>
        <div className="fw-preview-pdf-zoom">
          <button
            type="button"
            className={`fw-preview-hud-btn${mode === "width" ? " is-on" : ""}`}
            aria-pressed={mode === "width"}
            onClick={() => {
              setMode("width");
              setZoom(100);
            }}
          >
            <Rows3 size={12} aria-hidden="true" />
            {t("fw.preview.pdf.fitWidth")}
          </button>
          <button
            type="button"
            className={`fw-preview-hud-btn${mode === "page" ? " is-on" : ""}`}
            aria-pressed={mode === "page"}
            onClick={() => {
              setMode("page");
              setZoom(100);
            }}
          >
            <Maximize size={12} aria-hidden="true" />
            {t("fw.preview.pdf.fitPage")}
          </button>
          <span className="fw-preview-hud-sep" aria-hidden="true" />
          <button
            type="button"
            className="fw-icon-btn"
            aria-label={t("fw.preview.zoomOut")}
            disabled={zoom <= 25}
            onClick={() => setZoom((value) => Math.max(25, value - 25))}
          >
            <Minus size={13} aria-hidden="true" />
          </button>
          <span className="fw-preview-hud-value">{zoom}%</span>
          <button
            type="button"
            className="fw-icon-btn"
            aria-label={t("fw.preview.zoomIn")}
            disabled={zoom >= 400}
            onClick={() => setZoom((value) => Math.min(400, value + 25))}
          >
            <Plus size={13} aria-hidden="true" />
          </button>
        </div>
      </div>
      <div className="fw-preview-pdf-scroll" ref={scrollRef}>
        {rendering && (
          <span className="fw-preview-pdf-rendering" role="status">
            {t("fw.preview.pdf.rendering")}
          </span>
        )}
        <canvas ref={canvasRef} className="fw-preview-pdf-canvas" aria-label={t("fw.preview.pdf.canvasAria")} />
      </div>
    </div>
  );
}
