//! Markdown 阅读模式渲染（纯展示）。
//!
//! 输入是 `markdownParse` 产出的安全 AST：这里只把节点映射成 React 元素，
//! 不做 HTML 注入、不解析字符串、不自动加载图片/远程资源。
//! 链接点击交给调用方（`onOpenLink`）以系统浏览器打开；被拒绝的链接渲染为
//! 带提示的普通文本，绝不产生可点击的 `javascript:` 入口。

import { Fragment, useMemo, type ReactNode } from "react";
import { t as i18n } from "../../../i18n";
import { highlightLanguageOfName, createHighlightCursor, tokenizeLine } from "./codeHighlight";
import type { MdBlock, MdInline } from "./markdownParse";
import type { TextMatch } from "./textSearch";
import { renderTextWithMatches, renderTokens } from "./tokenRender";

export interface MarkdownViewProps {
  blocks: MdBlock[];
  matches: readonly TextMatch[];
  activeMatch: number;
  onOpenLink: (href: string) => void;
}

function inlineNodes(
  nodes: MdInline[],
  matches: readonly TextMatch[],
  activeMatch: number,
  onOpenLink: (href: string) => void,
): ReactNode[] {
  const out: ReactNode[] = [];
  nodes.forEach((node, index) => {
    switch (node.type) {
      case "text":
        out.push(
          <Fragment key={`t${index}`}>
            {renderTextWithMatches(node.value, node.start, matches, activeMatch)}
          </Fragment>,
        );
        break;
      case "code":
        out.push(
          <code key={`c${index}`} className="fw-md-inline-code">
            {renderTextWithMatches(node.value, node.start, matches, activeMatch)}
          </code>,
        );
        break;
      case "strong":
        out.push(<strong key={`s${index}`}>{inlineNodes(node.children, matches, activeMatch, onOpenLink)}</strong>);
        break;
      case "em":
        out.push(<em key={`e${index}`}>{inlineNodes(node.children, matches, activeMatch, onOpenLink)}</em>);
        break;
      case "del":
        out.push(<del key={`d${index}`}>{inlineNodes(node.children, matches, activeMatch, onOpenLink)}</del>);
        break;
      case "link":
        out.push(
          <a
            key={`a${index}`}
            className="fw-md-link"
            href={node.href}
            rel="noreferrer noopener"
            onClick={(event) => {
              // 绝不让 WebView 自己导航（会把整个应用带离当前页面）。
              event.preventDefault();
              onOpenLink(node.href);
            }}
          >
            {inlineNodes(node.children, matches, activeMatch, onOpenLink)}
          </a>,
        );
        break;
      case "link-blocked":
        out.push(
          <span
            key={`b${index}`}
            className="fw-md-link is-blocked"
            data-tip={i18n("fw.preview.md.linkBlocked")}
          >
            {inlineNodes(node.children, matches, activeMatch, onOpenLink)}
          </span>,
        );
        break;
      case "image":
        out.push(
          <span key={`i${index}`} className="fw-md-image" data-tip={i18n("fw.preview.md.imageHint")}>
            {i18n("fw.preview.md.image", { alt: node.alt || i18n("fw.preview.md.imageUnnamed") })}
          </span>,
        );
        break;
      case "break":
        out.push(<br key={`br${index}`} />);
        break;
      default:
        break;
    }
  });
  return out;
}

function codeBlock(text: string, lang: string, start: number, matches: readonly TextMatch[], activeMatch: number) {
  const language = highlightLanguageOfName(lang);
  const cursor = createHighlightCursor();
  const lines = text.split("\n");
  return (
    <div className="fw-md-code-block" data-lang={lang || undefined}>
      {lang ? <span className="fw-md-code-lang">{lang}</span> : null}
      <pre className="fw-md-pre">
        <code>
          {lines.map((line, index) => (
            <Fragment key={index}>
              {renderTokens(tokenizeLine(line, language, cursor), start, matches, activeMatch)}
              {index < lines.length - 1 ? "\n" : null}
            </Fragment>
          ))}
        </code>
      </pre>
    </div>
  );
}

function blockNodes(
  blocks: MdBlock[],
  matches: readonly TextMatch[],
  activeMatch: number,
  onOpenLink: (href: string) => void,
): ReactNode[] {
  return blocks.map((block, index) => {
    switch (block.type) {
      case "heading": {
        const Tag = `h${block.level}` as "h1";
        return (
          <Tag key={index} className={`fw-md-heading fw-md-h${block.level}`}>
            {inlineNodes(block.children, matches, activeMatch, onOpenLink)}
          </Tag>
        );
      }
      case "paragraph":
        return (
          <p key={index} className="fw-md-paragraph">
            {inlineNodes(block.children, matches, activeMatch, onOpenLink)}
          </p>
        );
      case "code":
        return <Fragment key={index}>{codeBlock(block.text, block.lang, block.start, matches, activeMatch)}</Fragment>;
      case "quote":
        return (
          <blockquote key={index} className="fw-md-quote">
            {blockNodes(block.blocks, matches, activeMatch, onOpenLink)}
          </blockquote>
        );
      case "list": {
        const Tag = block.ordered ? "ol" : "ul";
        return (
          <Tag key={index} className="fw-md-list">
            {block.items.map((item, itemIndex) => (
              <li key={itemIndex} className="fw-md-list-item">
                {item.checked !== null ? (
                  <input
                    type="checkbox"
                    className="fw-md-task"
                    checked={item.checked}
                    readOnly
                    tabIndex={-1}
                    aria-label={item.checked ? i18n("fw.preview.md.taskDone") : i18n("fw.preview.md.taskTodo")}
                  />
                ) : (
                  <span className="fw-md-bullet" aria-hidden="true">
                    {block.ordered ? item.marker : "•"}
                  </span>
                )}
                <div className="fw-md-list-body">
                  {blockNodes(item.blocks, matches, activeMatch, onOpenLink)}
                </div>
              </li>
            ))}
          </Tag>
        );
      }
      case "hr":
        return <hr key={index} className="fw-md-hr" />;
      case "table":
        return (
          <div key={index} className="fw-md-table-wrap">
            <table className="fw-md-table">
              <thead>
                <tr>
                  {block.header.map((cell, cellIndex) => (
                    <th key={cellIndex} style={{ textAlign: block.align[cellIndex] ?? undefined }}>
                      {inlineNodes(cell, matches, activeMatch, onOpenLink)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    {row.map((cell, cellIndex) => (
                      <td key={cellIndex} style={{ textAlign: block.align[cellIndex] ?? undefined }}>
                        {inlineNodes(cell, matches, activeMatch, onOpenLink)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      case "html":
        return (
          <div key={index} className="fw-md-html">
            <span className="fw-md-html-note">{i18n("fw.preview.md.htmlNote")}</span>
            <pre>{block.text}</pre>
          </div>
        );
      default:
        return null;
    }
  });
}

export default function MarkdownView({ blocks, matches, activeMatch, onOpenLink }: MarkdownViewProps) {
  const content = useMemo(
    () => blockNodes(blocks, matches, activeMatch, onOpenLink),
    [blocks, matches, activeMatch, onOpenLink],
  );
  return <div className="fw-md-body">{content}</div>;
}
