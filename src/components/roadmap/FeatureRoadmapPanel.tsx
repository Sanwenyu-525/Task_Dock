//! 规划中面板（v0.7）：统一功能目录的展示层。
//!
//! - 数据唯一来源：`lib/featureCatalog.ts`（12 项核心功能 + 历史规划），不在组件里维护第二份清单
//! - 按分类浏览 / 按状态筛选 / 按优先级筛选 / 目录内搜索 + 状态计数
//! - 卡片点击就地展开详情（无弹层，不接入 overlayStack；Escape 交给全局弹层栈处理其他层）
//! - 状态口径与目录一致：已实现 / 功能待完善（列已有与缺口）/ 功能待开发 / 等待接口或平台条件确认
//! - 「待开发」只代表登记与规划，不代表功能可用；已实现项说明现有入口，避免重复开发

import { useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import { SearchField, StatusBadge, type StatusTone } from "../ui";
import {
  CATEGORY_META,
  FEATURE_CATALOG,
  STATUS_META,
  featureCatalogSummary,
  featuresByCategory,
  type FeatureCategory,
  type FeatureEntry,
  type FeaturePriority,
  type FeatureStatus,
} from "../../lib/featureCatalog";

const STATUS_FILTERS: { id: "all" | FeatureStatus; label: string }[] = [
  { id: "all", label: "全部状态" },
  { id: "implemented", label: "已实现" },
  { id: "partial", label: "部分实现" },
  { id: "planned", label: "待开发" },
  { id: "blocked", label: "受阻" },
];

const PRIORITY_FILTERS: { id: "all" | FeaturePriority; label: string }[] = [
  { id: "all", label: "全部优先级" },
  { id: "P0", label: "P0" },
  { id: "P1", label: "P1" },
  { id: "P2", label: "P2" },
];

function statusMatches(status: "all" | FeatureStatus, filter: "all" | FeatureStatus): boolean {
  return filter === "all" || status === filter;
}

function matchesSearch(f: FeatureEntry, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    f.title.toLowerCase().includes(q) ||
    f.description.toLowerCase().includes(q) ||
    f.detail.toLowerCase().includes(q)
  );
}

const FEATURE_STATUS_TONE: Record<FeatureStatus, StatusTone> = {
  implemented: "success",
  partial: "warning",
  planned: "neutral",
  blocked: "danger",
};

/**
 * 单张功能卡片（导出以便测试用独立夹具覆盖四类状态中的每一种，
 * 避免为了测试向真实目录塞入虚假条目）。
 */
export function FeatureCard({
  feature,
  expanded,
  onToggle,
}: {
  feature: FeatureEntry;
  expanded: boolean;
  onToggle: () => void;
}) {
  const meta = STATUS_META[feature.status];
  return (
    <div className="task-card roadmap-card">
      <button
        className="roadmap-card-head"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-label={`${feature.title}（${meta.label}）`}
      >
        <span className="roadmap-card-title-row">
          <span className="roadmap-card-title">{feature.title}</span>
          <StatusBadge tone={FEATURE_STATUS_TONE[feature.status]} size="sm">
            {meta.label}
          </StatusBadge>
          <span className={`priority-tag ${feature.priority.toLowerCase()}`}>{feature.priority}</span>
          <ChevronDown
            size={15}
            strokeWidth={1.75}
            aria-hidden="true"
            className={`roadmap-chevron ${expanded ? "open" : ""}`}
          />
        </span>
        <span className="roadmap-card-desc">{feature.description}</span>
      </button>
      {expanded && (
        <div className="roadmap-detail" role="region" aria-label={`${feature.title} 详情`}>
          {/* 状态结论横幅：口径与目录 STATUS_META 一致，不允许所有卡片都显示同一种提示。
              动作文案单独成 span，便于测试与读屏精确定位（句尾标点不混入匹配文本）。 */}
          <p className={`roadmap-cta c-${feature.status}`}>
            <span>{meta.action}</span>
            {feature.status === "blocked" && feature.blockedReason ? `：${feature.blockedReason}` : "。"}
          </p>
          <p className="roadmap-detail-text">{feature.detail}</p>
          {feature.entryPoints && feature.entryPoints.length > 0 && (
            <div className="roadmap-field">
              <h4>现有入口</h4>
              <ul>
                {feature.entryPoints.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </div>
          )}
          {feature.existingFeatures.length > 0 && (
            <div className="roadmap-field">
              <h4>已具备能力</h4>
              <ul>
                {feature.existingFeatures.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </div>
          )}
          {feature.missingFeatures.length > 0 && (
            <div className="roadmap-field">
              <h4>待补齐</h4>
              <ul>
                {feature.missingFeatures.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="roadmap-field">
            <h4>依赖条件</h4>
            <ul>
              {feature.dependencies.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          </div>
          <div className="roadmap-field">
            <h4>验收标准（未完成，仅登记）</h4>
            <ul>
              {feature.acceptanceCriteria.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          </div>
          <p className="roadmap-verify">
            验证状态：{feature.verification === "verified" ? "已验证（有测试或真机验收证据）" : "未充分验证"}
          </p>
        </div>
      )}
    </div>
  );
}

export default function FeatureRoadmapPanel() {
  const [statusFilter, setStatusFilter] = useState<"all" | FeatureStatus>("all");
  const [priorityFilter, setPriorityFilter] = useState<"all" | FeaturePriority>("all");
  const [search, setSearch] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const summary = useMemo(() => featureCatalogSummary(), []);

  const groups = useMemo(() => {
    return featuresByCategory()
      .map(({ category, items }) => ({
        category,
        items: items.filter(
          (f) =>
            statusMatches(f.status, statusFilter) &&
            (priorityFilter === "all" || f.priority === priorityFilter) &&
            matchesSearch(f, search),
        ),
      }))
      .filter((g) => g.items.length > 0);
  }, [statusFilter, priorityFilter, search]);

  const visibleCount = groups.reduce((n, g) => n + g.items.length, 0);
  const hasFilter = statusFilter !== "all" || priorityFilter !== "all" || search.trim() !== "";

  return (
    <div className="roadmap-panel">
      <div className="roadmap-head">
        <h3>规划中</h3>
        <p className="roadmap-head-desc">
          统一功能规划目录：已登记不等于已开发。点开卡片查看已有能力、剩余缺口与验收标准。
        </p>
        {/* 统计行与目录同源（featureCatalogSummary），不手工维护数字 */}
        <div className="roadmap-summary" aria-label="功能状态统计">
          <span className="roadmap-sum s-implemented">已实现 {summary.implemented}</span>
          <span className="roadmap-sum s-partial">部分实现 {summary.partial}</span>
          <span className="roadmap-sum s-planned">待开发 {summary.planned}</span>
          <span className="roadmap-sum s-blocked">受阻 {summary.blocked}</span>
          <span className="roadmap-sum muted">共 {summary.total} 项 · 核心 {summary.coreTotal} 项</span>
        </div>
      </div>

      <div className="filter-bar primary">
        <SearchField
          className="roadmap-search"
          size="compact"
          value={search}
          placeholder="搜索功能…"
          ariaLabel="搜索规划功能"
          clearLabel="清空搜索"
          onChange={setSearch}
        />
        <div className="seg-group subtle" role="group" aria-label="按状态筛选">
          {STATUS_FILTERS.map((s) => (
            <button
              key={s.id}
              className={`seg-btn ${statusFilter === s.id ? "active" : ""}`}
              onClick={() => setStatusFilter(s.id)}
            >
              {s.label}
            </button>
          ))}
        </div>
        <div className="seg-group subtle" role="group" aria-label="按优先级筛选">
          {PRIORITY_FILTERS.map((p) => (
            <button
              key={p.id}
              className={`seg-btn ${priorityFilter === p.id ? "active" : ""}`}
              onClick={() => setPriorityFilter(p.id)}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {hasFilter && (
        <p className="roadmap-filter-hint" role="status">
          筛选结果 {visibleCount} / {FEATURE_CATALOG.length} 项
        </p>
      )}

      {groups.length === 0 ? (
        <div className="roadmap-empty">没有匹配的功能项，试试调整筛选或清空搜索。</div>
      ) : (
        groups.map(({ category, items }: { category: FeatureCategory; items: FeatureEntry[] }) => (
          <section key={category} className="roadmap-section" aria-label={CATEGORY_META[category].label}>
            <div className="roadmap-section-head">
              <h4>{CATEGORY_META[category].label}</h4>
              <span className="roadmap-section-desc">{CATEGORY_META[category].description}</span>
              <span className="roadmap-section-count">{items.length}</span>
            </div>
            <div className="roadmap-cards">
              {items.map((f) => (
                <FeatureCard
                  key={f.id}
                  feature={f}
                  expanded={expandedId === f.id}
                  onToggle={() => setExpandedId(expandedId === f.id ? null : f.id)}
                />
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}
