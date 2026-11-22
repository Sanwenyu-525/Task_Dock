//! 轻量趋势图：纯 SVG 堆叠柱（执行/等待/未知），不引入图表库。
//! 文案走 `agentStats.trend.*`（空态复用 `agentStats.bySource.empty`，无专用键）。

import { useLocale } from "../../../hooks/useLocale";
import type { TrendPoint } from "./api";

const BAR_W = 14;
const GAP = 5;
const PLOT_H = 108;
const TOP_PAD = 8;

function mmdd(bucket: string): string {
  // bucket 形如 "2026-11-04" 或 "2026-11-04 周"；只取日期部分，不依赖语言
  const m = bucket.match(/\d{4}-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}` : bucket;
}

export default function WorkTimeTrend({ points }: { points: TrendPoint[] }) {
  const { t } = useLocale();
  if (points.length === 0) {
    return <div className="empty-hint">{t("agentStats.bySource.empty")}</div>;
  }
  const totals = points.map((p) => p.exec_sec + p.wait_sec + p.unknown_sec);
  const max = Math.max(1, ...totals);
  const width = Math.max(points.length * (BAR_W + GAP), 280);
  const height = PLOT_H + TOP_PAD + 18;
  const step = Math.ceil(points.length / 8);
  const gridLines = [0.25, 0.5, 0.75, 1].map((f) => Math.round(f * max));

  return (
    <div className="astats-chart-wrap">
      <svg
        className="astats-chart"
        role="img"
        aria-label={t("agentStats.trend.aria")}
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
      >
        {/* 网格线 + 刻度（秒） */}
        {gridLines.map((v, i) => {
          const y = TOP_PAD + PLOT_H - (v / max) * PLOT_H;
          return (
            <g key={`grid-${i}`}>
              <line x1={0} x2={width} y1={y} y2={y} className="astats-grid" />
              <text x={2} y={y - 2} className="astats-axis astats-grid-label">
                {v >= 3600 ? `${Math.round(v / 3600)}h` : `${v}s`}
              </text>
            </g>
          );
        })}
        {points.map((p, i) => {
          const x = i * (BAR_W + GAP) + GAP / 2;
          const exec = (p.exec_sec / max) * PLOT_H;
          const wait = (p.wait_sec / max) * PLOT_H;
          const unknown = (p.unknown_sec / max) * PLOT_H;
          let acc = 0;
          const bars = [
            { h: exec, cls: "is-exec" },
            { h: wait, cls: "is-wait" },
            { h: unknown, cls: "is-unknown" },
          ];
          return (
            <g key={p.start_at}>
              {bars.map((b, j) => {
                const h = b.h > 0 ? Math.max(b.h, 1) : 0;
                if (h === 0) return null;
                const y = TOP_PAD + PLOT_H - acc - h;
                acc += h;
                return (
                  <rect
                    key={`${p.start_at}-${j}`}
                    x={x}
                    y={y}
                    width={BAR_W}
                    height={h}
                    rx={2}
                    className={`astats-bar ${b.cls}`}
                  />
                );
              })}
              {(i % step === 0 || i === points.length - 1) && (
                <text
                  x={x + BAR_W / 2}
                  y={height - 5}
                  textAnchor="middle"
                  className="astats-axis"
                >
                  {mmdd(p.bucket)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
