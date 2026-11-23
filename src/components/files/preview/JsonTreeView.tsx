//! JSON 树形视图（纯展示）。
//!
//! 输入是 `jsonTree` 的节点模型：递归渲染键、标量与容器计数，容器可逐层折叠。
//! 不做 JSON.parse、不注入 HTML、不执行任何字符串内容；
//! 折叠状态只保存已展开的**路径**，节点预算已由解析层限制（≤3000 节点）。

import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import { t as i18n } from "../../../i18n";
import { collectContainerPaths, type JsonDocument, type JsonNode } from "./jsonTree";

export interface JsonTreeViewProps {
  doc: JsonDocument;
}

const ROOT_PATH = "root";

function kindClass(node: JsonNode): string {
  switch (node.kind) {
    case "string":
      return "is-string";
    case "number":
      return "is-number";
    case "boolean":
      return "is-boolean";
    case "null":
      return "is-null";
    default:
      return "is-container";
  }
}

function valueText(node: JsonNode): string {
  if (node.kind === "array") {
    return node.size === 0 ? "[]" : `[${node.size}]`;
  }
  if (node.kind === "object") {
    return node.size === 0 ? "{}" : `{${node.size}}`;
  }
  return node.preview;
}

interface RowProps {
  node: JsonNode;
  path: string;
  expanded: Set<string>;
  onToggle: (path: string) => void;
}

function JsonRow({ node, path, expanded, onToggle }: RowProps) {
  const children = node.children;
  const expandable = Boolean(children && children.length > 0);
  const open = expandable && expanded.has(path);

  return (
    <div className="fw-json-node">
      <div
        className="fw-json-row"
        role="treeitem"
        aria-level={node.depth}
        aria-expanded={expandable ? open : undefined}
        data-kind={node.kind}
        style={{ ["--fw-json-indent" as string]: `${(node.depth - 1) * 14}px` }}
      >
        {expandable ? (
          <button
            type="button"
            className={`fw-json-toggle${open ? " is-open" : ""}`}
            aria-label={open ? i18n("fw.preview.json.collapse") : i18n("fw.preview.json.expand")}
            aria-expanded={open}
            onClick={() => onToggle(path)}
          >
            <ChevronRight size={12} aria-hidden="true" />
          </button>
        ) : (
          <span className="fw-json-dot" aria-hidden="true" />
        )}
        {node.key !== null && <span className="fw-json-key">{node.key}</span>}
        {node.key !== null && <span className="fw-json-sep" aria-hidden="true">:</span>}
        <span className={`fw-json-value ${kindClass(node)}`}>{valueText(node)}</span>
        {node.truncated && (
          <span className="fw-json-clip" data-tip={i18n("fw.preview.json.clipped")}>
            …
          </span>
        )}
      </div>
      {open && children ? (
        <div className="fw-json-children" role="group">
          {children.map((child, index) => (
            <JsonRow
              key={`${path}/${index}`}
              node={child}
              path={`${path}/${index}`}
              expanded={expanded}
              onToggle={onToggle}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export default function JsonTreeView({ doc }: JsonTreeViewProps) {
  // 默认只展开根：首屏是一棵「一眼能看懂规模」的树，逐层点开不渲染多余节点。
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([ROOT_PATH]));

  useEffect(() => {
    setExpanded(new Set([ROOT_PATH]));
  }, [doc]);

  const onToggle = useCallback((path: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const allPaths = useMemo(() => collectContainerPaths(doc.root), [doc.root]);

  if (!doc.ok || !doc.root) return null;

  return (
    <div className="fw-json-view">
      <div className="fw-json-toolbar">
        <button type="button" className="btn sm" onClick={() => setExpanded(new Set(allPaths))}>
          {i18n("fw.preview.json.expandAll")}
        </button>
        <button type="button" className="btn sm" onClick={() => setExpanded(new Set())}>
          {i18n("fw.preview.json.collapseAll")}
        </button>
      </div>
      <div className="fw-json-tree" role="tree" aria-label={i18n("fw.preview.json.treeAria")}>
        <JsonRow node={doc.root} path={ROOT_PATH} expanded={expanded} onToggle={onToggle} />
      </div>
    </div>
  );
}
