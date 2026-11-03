//! HTML 富文本只读预览（白名单 React 渲染器）。
//!
//! 安全模型：剪贴板 HTML 来自外部应用，按不可信输入处理。
//! - 用 DOMParser 解析后**只按白名单标签**递归构建 React 元素，
//!   不使用 dangerouslySetInnerHTML，不导入任何原始节点/属性；
//! - script/style/iframe/object/embed/表单/多媒体/图片等主动内容元素连同子树丢弃；
//! - 其余未知标签**解包**（只保留子内容），正文尽量不丢；
//! - <a> 不渲染为可点击链接（避免任何主窗口导航面），渲染为带 title 的文本，
//!   仅 http/https 的 href 写入 title 供用户查看目标；
//! - 不携带任何源属性（style/class/事件属性天然不存在）；
//! - 节点数上限 3000、深度上限 60：超限截断展示并提示（原始数据不受影响）。

import { Fragment, useMemo, type ReactNode } from "react";

const ALLOWED = new Set([
  "p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6",
  "ul", "ol", "li", "blockquote", "pre", "code",
  "b", "strong", "i", "em", "u", "s", "del", "ins", "sub", "sup",
  "span", "div", "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption",
  "a", "font", "center", "small", "mark", "abbr", "cite", "q",
]);

/** 主动内容/资源加载元素：连同子树整体丢弃，绝不渲染。 */
const DROP_TREE = new Set([
  "script", "style", "iframe", "object", "embed", "applet", "form", "input",
  "button", "select", "textarea", "option", "link", "meta", "base", "title",
  "svg", "math", "video", "audio", "source", "track", "img", "picture",
  "canvas", "map", "area", "noscript", "template", "frame", "frameset",
  "dialog", "slot",
]);

const MAX_NODES = 3000;
const MAX_DEPTH = 60;

interface Budget {
  nodes: number;
  truncated: boolean;
}

/** 只接受 http/https 的 href；其余一律视为不可信，不产生任何外链信息。 */
function safeHref(href: string | null): string | null {
  if (!href) return null;
  try {
    const u = new URL(href, "https://placeholder.invalid");
    return u.protocol === "http:" || u.protocol === "https:"
      ? u.toString().replace(/^https:\/\/placeholder\.invalid/, "")
      : null;
  } catch {
    return null;
  }
}

function renderNode(node: Node, depth: number, budget: Budget): ReactNode {
  if (budget.nodes >= MAX_NODES || depth > MAX_DEPTH) {
    budget.truncated = true;
    return null;
  }
  if (node.nodeType === Node.TEXT_NODE) {
    budget.nodes += 1;
    // textContent 原样作为 React 子节点，转义由 React 负责
    return node.textContent ?? "";
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return null;
  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  if (DROP_TREE.has(tag)) return null;

  const children: ReactNode[] = [];
  let child = el.firstChild;
  while (child) {
    const rendered = renderNode(child, depth + 1, budget);
    if (rendered !== null) children.push(rendered);
    child = child.nextSibling;
  }

  budget.nodes += 1;
  const key = budget.nodes;
  if (!ALLOWED.has(tag)) {
    // 白名单外但无害的标签：解包保留子内容
    return <Fragment key={key}>{children}</Fragment>;
  }
  if (tag === "a") {
    const href = safeHref(el.getAttribute("href"));
    return (
      <span key={key} className={href ? "clip-doc-link" : undefined} title={href ?? undefined}>
        {children}
      </span>
    );
  }
  if (tag === "font") return <span key={key}>{children}</span>;
  if (tag === "center") {
    return (
      <div key={key} style={{ textAlign: "center" }}>
        {children}
      </div>
    );
  }
  // 白名单标签直接映射同名 React 元素；不传任何源属性
  return createElementSafe(tag, key, children);
}

/** 白名单映射表已穷举标签名，这里只是让 TS 接受动态标签。 */
function createElementSafe(tag: string, key: number, children: ReactNode[]): ReactNode {
  switch (tag) {
    case "br": return <br key={key} />;
    case "hr": return <hr key={key} />;
    case "p": return <p key={key}>{children}</p>;
    case "h1": return <h1 key={key}>{children}</h1>;
    case "h2": return <h2 key={key}>{children}</h2>;
    case "h3": return <h3 key={key}>{children}</h3>;
    case "h4": return <h4 key={key}>{children}</h4>;
    case "h5": return <h5 key={key}>{children}</h5>;
    case "h6": return <h6 key={key}>{children}</h6>;
    case "ul": return <ul key={key}>{children}</ul>;
    case "ol": return <ol key={key}>{children}</ol>;
    case "li": return <li key={key}>{children}</li>;
    case "blockquote": return <blockquote key={key}>{children}</blockquote>;
    case "pre": return <pre key={key}>{children}</pre>;
    case "code": return <code key={key}>{children}</code>;
    case "b": return <b key={key}>{children}</b>;
    case "strong": return <strong key={key}>{children}</strong>;
    case "i": return <i key={key}>{children}</i>;
    case "em": return <em key={key}>{children}</em>;
    case "u": return <u key={key}>{children}</u>;
    case "s": return <s key={key}>{children}</s>;
    case "del": return <del key={key}>{children}</del>;
    case "ins": return <ins key={key}>{children}</ins>;
    case "sub": return <sub key={key}>{children}</sub>;
    case "sup": return <sup key={key}>{children}</sup>;
    case "span": return <span key={key}>{children}</span>;
    case "div": return <div key={key}>{children}</div>;
    case "table": return <table key={key}>{children}</table>;
    case "thead": return <thead key={key}>{children}</thead>;
    case "tbody": return <tbody key={key}>{children}</tbody>;
    case "tfoot": return <tfoot key={key}>{children}</tfoot>;
    case "tr": return <tr key={key}>{children}</tr>;
    case "th": return <th key={key}>{children}</th>;
    case "td": return <td key={key}>{children}</td>;
    case "caption": return <caption key={key}>{children}</caption>;
    case "small": return <small key={key}>{children}</small>;
    case "mark": return <mark key={key}>{children}</mark>;
    case "abbr": return <abbr key={key}>{children}</abbr>;
    case "cite": return <cite key={key}>{children}</cite>;
    case "q": return <q key={key}>{children}</q>;
    default: return <span key={key}>{children}</span>;
  }
}

/**
 * 解析并渲染富文本。解析失败返回 null（调用方回退源码/纯文本视图）。
 * 返回截断提示由调用方与内容一起展示。
 */
export function useHtmlDoc(html: string): { body: ReactNode; truncated: boolean; ok: boolean } {
  return useMemo(() => {
    if (!html.trim()) return { body: null, truncated: false, ok: false };
    let doc: Document;
    try {
      doc = new DOMParser().parseFromString(html, "text/html");
    } catch {
      return { body: null, truncated: false, ok: false };
    }
    const budget: Budget = { nodes: 0, truncated: false };
    const parts: ReactNode[] = [];
    let child = doc.body?.firstChild ?? null;
    while (child) {
      const rendered = renderNode(child, 0, budget);
      if (rendered !== null) parts.push(rendered);
      child = child.nextSibling;
    }
    return { body: parts, truncated: budget.truncated, ok: true };
  }, [html]);
}

export default function HtmlReader({ html }: { html: string }) {
  const { body, truncated, ok } = useHtmlDoc(html);
  if (!ok) {
    return <div className="clip-hint">无法解析这段 HTML，请改用源码视图。</div>;
  }
  return (
    <div className="clip-doc" tabIndex={0}>
      {body}
      {truncated && (
        <div className="clip-hint">内容过长，预览已截断；原始内容不受影响，可切换源码查看全部。</div>
      )}
    </div>
  );
}
