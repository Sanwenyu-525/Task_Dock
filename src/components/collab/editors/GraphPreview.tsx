//! 图表只读渲染（预览/查看器共用）。只输出 SVG，不执行任何脚本。

import { useMemo, useState } from "react";
import { Minus, Plus, RotateCcw } from "lucide-react";
import { NODE_H, NODE_W, graphBounds, type GraphContent } from "./graph-types";

export default function GraphPreview({ graph }: { graph: GraphContent }) {
  const [zoom, setZoom] = useState(1);
  const bounds = useMemo(() => graphBounds(graph.nodes), [graph.nodes]);
  const width = Math.max(320, graph.layout.width ?? bounds.width + 120);
  const height = Math.max(320, graph.layout.height ?? bounds.height + 120);
  const positions = useMemo(
    () => new Map(graph.nodes.map((n) => [n.id, n])),
    [graph.nodes],
  );

  return (
    <div className="collab-graph-wrap">
      <div className="collab-viewer-toolbar">
        <button
          className="btn icon-btn"
          aria-label="缩小"
          data-tip="缩小"
          onClick={() => setZoom((z) => Math.max(0.4, Number((z - 0.1).toFixed(2))))}
        >
          <Minus size={14} />
        </button>
        <span className="collab-zoom-label">{Math.round(zoom * 100)}%</span>
        <button
          className="btn icon-btn"
          aria-label="放大"
          data-tip="放大"
          onClick={() => setZoom((z) => Math.min(2, Number((z + 0.1).toFixed(2))))}
        >
          <Plus size={14} />
        </button>
        <button className="btn icon-btn" aria-label="重置缩放" data-tip="重置缩放" onClick={() => setZoom(1)}>
          <RotateCcw size={14} />
        </button>
        <span className="collab-muted">
          {graph.nodes.length} 节点 · {graph.edges.length} 连线
        </span>
      </div>
      <div className="collab-graph-scroll">
        <svg
          className="collab-graph"
          width={width * zoom}
          height={height * zoom}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label="结构化图表"
        >
          {graph.edges.map((edge) => {
            const from = positions.get(edge.from);
            const to = positions.get(edge.to);
            if (!from || !to) return null;
            const horizontal = graph.layout.direction === "LR";
            const x1 = horizontal ? from.x + NODE_W : from.x + NODE_W / 2;
            const y1 = horizontal ? from.y + NODE_H / 2 : from.y + NODE_H;
            const x2 = horizontal ? to.x : to.x + NODE_W / 2;
            const y2 = horizontal ? to.y + NODE_H / 2 : to.y;
            return (
              <g key={edge.id}>
                <line x1={x1} y1={y1} x2={x2} y2={y2} className="collab-edge" markerEnd="url(#collab-arrow)" />
                {edge.label ? (
                  <text x={(x1 + x2) / 2 + 6} y={(y1 + y2) / 2} className="collab-edge-label">
                    {edge.label}
                  </text>
                ) : null}
              </g>
            );
          })}
          <defs>
            <marker id="collab-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
              <path d="M0,0 L8,4 L0,8 z" className="collab-arrow-head" />
            </marker>
          </defs>
          {graph.nodes.map((node) => (
            <g key={node.id} transform={`translate(${node.x},${node.y})`}>
              <rect
                width={NODE_W}
                height={NODE_H}
                rx="10"
                className={`collab-node kind-${node.kind}`}
                style={node.color ? { fill: node.color } : undefined}
              />
              <text x={NODE_W / 2} y={NODE_H / 2 + 5} textAnchor="middle" className="collab-node-label">
                {node.label}
              </text>
            </g>
          ))}
        </svg>
      </div>
    </div>
  );
}
