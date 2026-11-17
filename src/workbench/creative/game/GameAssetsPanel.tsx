//! 游戏线「资源」模块（G1，2026-11-16）：引擎识别 + 制作事项 + 游戏资源关联。
//!
//! 边界：
//! - 事项复用既有 `workspace_items`（分类存 `metadataJson.category`），不新建事项表；
//! - 资源只存路径与元数据，不复制原文件；删除登记不删除外部文件；
//! - 归档项目只读；非 game 类型防御性降级；失败可见 + 可重试。

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  FolderOpen,
  Link2,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";

import Select from "../../../components/ui/Select";
import { errorMessage } from "../../../lib/errors";
import { formatLocalizedDateTime } from "../../../i18n/format";
import type { WorkspaceItem, WorkspaceItemStatus } from "../../../lib/bridge";
import type { CreativeModuleProps } from "../types";
import * as api from "./ipc";
import {
  GAME_ASSET_KINDS,
  GAME_ITEM_CATEGORIES,
  assetKindLabel,
  categoryLabel,
  engineLabel,
  type GameAsset,
  type GameDetectionReport,
  type GameEngine,
  type GameProjectFact,
} from "./types";
import { formatSize, itemCategory, itemCategoryLabel, itemStatusLabel } from "./common";

const ITEM_STATUS_OPTIONS: ReadonlyArray<{ value: WorkspaceItemStatus; label: string }> = [
  { value: "todo", label: "待办" },
  { value: "doing", label: "进行中" },
  { value: "blocked", label: "阻塞" },
  { value: "done", label: "完成" },
];

interface ItemForm {
  id?: string;
  title: string;
  category: string;
  status: WorkspaceItemStatus;
  stage: string;
}

interface AssetForm {
  id?: string;
  kind: string;
  name: string;
  path: string;
  itemId: string;
  note: string;
}

export default function GameAssetsPanel({
  projectId,
  kind,
  archived,
  onNotice,
}: CreativeModuleProps) {
  const readonly = archived || kind !== "game";

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detection, setDetection] = useState<GameDetectionReport | null>(null);
  const [facts, setFacts] = useState<GameProjectFact | null>(null);
  const [items, setItems] = useState<WorkspaceItem[]>([]);
  const [assets, setAssets] = useState<GameAsset[]>([]);

  const [itemStatusFilter, setItemStatusFilter] = useState<string>("");
  const [itemStageFilter, setItemStageFilter] = useState<string>("");
  const [assetKindFilter, setAssetKindFilter] = useState<string>("");

  const [itemForm, setItemForm] = useState<ItemForm | null>(null);
  const [assetForm, setAssetForm] = useState<AssetForm | null>(null);
  const [manualEngine, setManualEngine] = useState<GameEngine>("unknown");
  const [manualVersion, setManualVersion] = useState("");
  const [saving, setSaving] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [det, itemRes, assetRes] = await Promise.all([
        api.gameProjectDetect(projectId),
        api.workspaceItemList(projectId),
        api.gameAssetList(projectId),
      ]);
      setDetection(det.detection);
      setFacts(det.facts);
      setItems(itemRes.items);
      setAssets(assetRes.assets);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const itemById = useMemo(() => {
    const map = new Map<string, WorkspaceItem>();
    for (const item of items) map.set(item.id, item);
    return map;
  }, [items]);

  const filteredItems = useMemo(() => {
    return items.filter((it) => {
      if (itemStatusFilter && it.status !== itemStatusFilter) return false;
      if (itemStageFilter && !it.stage.toLowerCase().includes(itemStageFilter.toLowerCase())) {
        return false;
      }
      return true;
    });
  }, [items, itemStatusFilter, itemStageFilter]);

  const groupedItems = useMemo(() => {
    const groups = new Map<string, WorkspaceItem[]>();
    for (const item of filteredItems) {
      const key = itemCategory(item);
      const list = groups.get(key) ?? [];
      list.push(item);
      groups.set(key, list);
    }
    return [...groups.entries()];
  }, [filteredItems]);

  const itemStats = useMemo(() => {
    const total = items.length;
    const done = items.filter((it) => it.status === "done").length;
    return { total, done, percent: total === 0 ? 0 : Math.round((done / total) * 100) };
  }, [items]);

  const filteredAssets = useMemo(() => {
    if (!assetKindFilter) return assets;
    return assets.filter((a) => a.kind === assetKindFilter);
  }, [assets, assetKindFilter]);

  async function runDetectAndPersist() {
    setSaving(true);
    try {
      const det = await api.gameProjectDetect(projectId);
      setDetection(det.detection);
      setFacts(det.facts);
      // 已保存的手动指定事实优先：自动扫描结果仅作展示参考，不静默覆盖用户的显式选择。
      const persistedManual = det.facts?.detectionMethod === "manual";
      if (det.detection.engine !== "unknown") {
        if (persistedManual) {
          onNotice("info", "已保留手动指定的引擎；本次扫描结果仅作参考，可在下方重新保存手动指定");
        } else {
          await api.gameProjectFactsSave({
            projectId,
            engine: det.detection.engine,
            detectionMethod: "auto",
            evidence: det.detection.evidence.join("; "),
            engineVersion: det.detection.engineVersion || null,
          });
          onNotice("ok", "已按真实文件特征识别引擎并保存");
        }
      } else {
        onNotice("info", "未识别到已知引擎特征，可手动指定");
      }
      await reload();
    } catch (e) {
      onNotice("error", errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  async function saveManualEngine() {
    setSaving(true);
    try {
      await api.gameProjectFactsSave({
        projectId,
        engine: manualEngine,
        detectionMethod: "manual",
        evidence: "用户手动指定",
        engineVersion: manualVersion || null,
      });
      onNotice("ok", "已保存手动指定的引擎类型");
      await reload();
    } catch (e) {
      onNotice("error", errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  async function saveItem() {
    if (!itemForm) return;
    if (!itemForm.title.trim()) {
      onNotice("error", "事项标题不能为空");
      return;
    }
    setSaving(true);
    try {
      await api.workspaceItemSave({
        id: itemForm.id ?? null,
        projectId,
        title: itemForm.title.trim(),
        stage: itemForm.stage.trim() || null,
        status: itemForm.status,
        metadataJson: JSON.stringify({ category: itemForm.category }),
      });
      setItemForm(null);
      onNotice("ok", "事项已保存");
      await reload();
    } catch (e) {
      onNotice("error", errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  async function deleteItem(id: string) {
    setSaving(true);
    try {
      await api.workspaceItemDelete(id);
      onNotice("ok", "事项已删除");
      await reload();
    } catch (e) {
      onNotice("error", errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  async function saveAsset() {
    if (!assetForm) return;
    if (!assetForm.name.trim() || !assetForm.path.trim()) {
      onNotice("error", "资源名称与路径不能为空");
      return;
    }
    setSaving(true);
    try {
      await api.gameAssetSave({
        id: assetForm.id ?? null,
        projectId,
        kind: assetForm.kind,
        name: assetForm.name.trim(),
        path: assetForm.path.trim(),
        itemId: assetForm.itemId || null,
        note: assetForm.note || null,
      });
      setAssetForm(null);
      onNotice("ok", "资源已登记");
      await reload();
    } catch (e) {
      onNotice("error", errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  async function deleteAsset(id: string) {
    setSaving(true);
    try {
      await api.gameAssetDelete(id);
      onNotice("ok", "资源登记已删除（原文件未改动）");
      await reload();
    } catch (e) {
      onNotice("error", errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  async function openPath(path: string) {
    if (!path) return;
    try {
      await api.fsOpen(path);
    } catch (e) {
      onNotice("error", errorMessage(e));
    }
  }

  if (kind !== "game") {
    return (
      <div className="ws-state" role="status" data-tone="error">
        游戏资源模块仅对游戏项目开放。
      </div>
    );
  }

  return (
    <div className="ws-game" data-testid="game-assets-panel">
      {archived && (
        <div className="ws-state" role="status" data-tone="warn">
          项目已归档：以下内容只读，不能新增或修改。
        </div>
      )}
      {error && (
        <div className="ws-state" role="alert" data-tone="error">
          <AlertTriangle size={13} aria-hidden="true" />
          <span className="ws-flex">{error}</span>
          <button type="button" className="ws-btn ws-btn-quiet" onClick={() => void reload()}>
            重试
          </button>
        </div>
      )}

      {/* 引擎识别 */}
      <section className="ws-card" aria-label="引擎识别">
        <h3 className="ws-subhead">引擎识别</h3>
        {loading && !detection ? (
          <div className="ws-empty">加载中…</div>
        ) : (
          <>
            <div className="ws-row">
              <span className="ws-flex">
                识别结果：
                <span className="ws-badge" data-testid="game-engine-badge">
                  {detection ? engineLabel(detection.engine) : "—"}
                </span>
                {facts && (
                  <span className="ws-badge ws-badge-soft" data-testid="game-facts-method">
                    {facts.detectionMethod === "manual" ? "手动指定" : "自动识别"}
                    {facts.engineVersion ? ` · ${facts.engineVersion}` : ""}
                  </span>
                )}
              </span>
              {!readonly && (
                <button
                  type="button"
                  className="ws-btn ws-btn-quiet"
                  disabled={saving}
                  onClick={() => void runDetectAndPersist()}
                >
                  <RefreshCw size={13} aria-hidden="true" /> 重新识别
                </button>
              )}
            </div>
            {detection && detection.evidence.length > 0 && (
              <div className="ws-meta">
                特征证据：{detection.evidence.map((e) => `「${e}」`).join("、")}
              </div>
            )}
            {detection && detection.conflicts.length > 0 && (
              <div className="ws-state" data-tone="warn" data-testid="game-detect-conflicts">
                <AlertTriangle size={12} aria-hidden="true" />
                <span>
                  检测到多引擎标记冲突：{detection.conflicts.join("、")}；当前按优先级暂判为
                  {engineLabel(detection.engine)}，请核对后手动指定。
                </span>
              </div>
            )}
            {detection && !detection.rootExists && (
              <div className="ws-state" data-tone="warn">
                项目根目录不存在；识别结果为未知，可在设置中重新指定路径。
              </div>
            )}
            {!readonly && (
              <div className="ws-form-row">
                <Select
                  ariaLabel="手动指定引擎"
                  value={manualEngine}
                  options={GAME_ENGINE_OPTIONS}
                  onChange={(v) => setManualEngine(v as GameEngine)}
                />
                <input
                  className="ws-input"
                  placeholder="引擎版本（可选）"
                  value={manualVersion}
                  onChange={(e) => setManualVersion(e.target.value)}
                />
                <button
                  type="button"
                  className="ws-btn"
                  disabled={saving}
                  onClick={() => void saveManualEngine()}
                >
                  保存手动指定
                </button>
              </div>
            )}
          </>
        )}
      </section>

      {/* 制作事项 */}
      <section className="ws-card" aria-label="制作事项">
        <div className="ws-row">
          <h3 className="ws-subhead" style={{ margin: 0 }}>
            制作事项
          </h3>
          <span className="ws-meta">
            共 {itemStats.total} 项 · 完成 {itemStats.done} · {itemStats.percent}%
          </span>
          <span className="ws-flex" />
          <Select
            ariaLabel="按状态筛选事项"
            value={itemStatusFilter}
            options={STATUS_FILTER_OPTIONS}
            onChange={setItemStatusFilter}
          />
          <input
            className="ws-input"
            placeholder="按阶段筛选"
            value={itemStageFilter}
            onChange={(e) => setItemStageFilter(e.target.value)}
          />
          {!readonly && (
            <button
              type="button"
              className="ws-btn ws-btn-quiet"
              onClick={() =>
                setItemForm({ title: "", category: "system", status: "todo", stage: "" })
              }
            >
              <Plus size={13} aria-hidden="true" /> 新增事项
            </button>
          )}
        </div>

        {itemForm && (
          <div className="ws-form-row">
            <input
              className="ws-input"
              placeholder="事项标题"
              value={itemForm.title}
              onChange={(e) => setItemForm({ ...itemForm, title: e.target.value })}
            />
            <Select
              ariaLabel="事项分类"
              value={itemForm.category}
              options={GAME_ITEM_CATEGORIES.map((c) => ({ value: c.value, label: c.label }))}
              onChange={(v) => setItemForm({ ...itemForm, category: v })}
            />
            <Select
              ariaLabel="事项状态"
              value={itemForm.status}
              options={ITEM_STATUS_OPTIONS}
              onChange={(v) => setItemForm({ ...itemForm, status: v })}
            />
            <input
              className="ws-input"
              placeholder="阶段（可选）"
              value={itemForm.stage}
              onChange={(e) => setItemForm({ ...itemForm, stage: e.target.value })}
            />
            <button type="button" className="ws-btn" disabled={saving} onClick={() => void saveItem()}>
              保存
            </button>
            <button
              type="button"
              className="ws-btn ws-btn-quiet"
              onClick={() => setItemForm(null)}
            >
              取消
            </button>
          </div>
        )}

        {items.length === 0 ? (
          <div className="ws-empty">暂无制作事项；新增后可在这里按分类查看进度。</div>
        ) : (
          groupedItems.map(([category, list]) => (
            <div key={category}>
              <div className="ws-meta" style={{ marginTop: 8 }}>
                {categoryLabel(category)}（{list.length}）
              </div>
              {list.map((item) => (
                <div key={item.id} className="ws-row">
                  <span className="ws-flex">
                    {item.title}
                    {item.stage ? <span className="ws-meta"> · {item.stage}</span> : null}
                  </span>
                  <span className="ws-badge ws-badge-soft">{itemCategoryLabel(item)}</span>
                  <span
                    className={`ws-badge ${
                      item.status === "done"
                        ? "ws-badge-available"
                        : item.status === "blocked"
                          ? "ws-badge-unavailable"
                          : ""
                    }`}
                  >
                    {itemStatusLabel(item.status)}
                  </span>
                  {!readonly && (
                    <>
                      <button
                        type="button"
                        className="ws-btn ws-btn-quiet"
                        aria-label="编辑事项"
                        onClick={() =>
                          setItemForm({
                            id: item.id,
                            title: item.title,
                            category: itemCategory(item),
                            status: item.status,
                            stage: item.stage,
                          })
                        }
                      >
                        <Link2 size={13} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="ws-btn ws-btn-quiet ws-btn-danger"
                        aria-label="删除事项"
                        onClick={() => void deleteItem(item.id)}
                      >
                        <Trash2 size={13} aria-hidden="true" />
                      </button>
                    </>
                  )}
                </div>
              ))}
            </div>
          ))
        )}
      </section>

      {/* 游戏资源 */}
      <section className="ws-card" aria-label="游戏资源">
        <div className="ws-row">
          <h3 className="ws-subhead" style={{ margin: 0 }}>
            游戏资源
          </h3>
          <span className="ws-flex" />
          <Select
            ariaLabel="按类型筛选资源"
            value={assetKindFilter}
            options={[
              { value: "", label: "全部类型" },
              ...GAME_ASSET_KINDS.map((k) => ({ value: k.value, label: k.label })),
            ]}
            onChange={setAssetKindFilter}
          />
          {!readonly && (
            <button
              type="button"
              className="ws-btn ws-btn-quiet"
              onClick={() =>
                setAssetForm({ kind: "image", name: "", path: "", itemId: "", note: "" })
              }
            >
              <Plus size={13} aria-hidden="true" /> 登记资源
            </button>
          )}
        </div>

        {assetForm && (
          <div className="ws-form-row">
            <input
              className="ws-input"
              placeholder="资源名称"
              value={assetForm.name}
              onChange={(e) => setAssetForm({ ...assetForm, name: e.target.value })}
            />
            <Select
              ariaLabel="资源类型"
              value={assetForm.kind}
              options={GAME_ASSET_KINDS}
              onChange={(v) => setAssetForm({ ...assetForm, kind: v })}
            />
            <input
              className="ws-input ws-flex-2"
              placeholder="绝对路径（不复制原文件）"
              value={assetForm.path}
              onChange={(e) => setAssetForm({ ...assetForm, path: e.target.value })}
            />
            <Select
              ariaLabel="关联制作事项"
              value={assetForm.itemId}
              options={[
                { value: "", label: "不关联事项" },
                ...items.map((it) => ({ value: it.id, label: it.title })),
              ]}
              onChange={(v) => setAssetForm({ ...assetForm, itemId: v })}
            />
            <button type="button" className="ws-btn" disabled={saving} onClick={() => void saveAsset()}>
              保存
            </button>
            <button
              type="button"
              className="ws-btn ws-btn-quiet"
              onClick={() => setAssetForm(null)}
            >
              取消
            </button>
          </div>
        )}

        {assets.length === 0 ? (
          <div className="ws-empty">暂无登记资源；可贴图、模型、音频、场景等资产的路径引用。</div>
        ) : (
          filteredAssets.map((asset) => {
            const linked = asset.itemId ? itemById.get(asset.itemId) : undefined;
            return (
              <div key={asset.id} className="ws-row" data-asset-id={asset.id}>
                <span className="ws-flex">
                  {asset.name}
                  <span className="ws-meta"> · {assetKindLabel(asset.kind)}</span>
                  {asset.location === "outside" && (
                    <span className="ws-badge ws-badge-soft">项目目录外</span>
                  )}
                </span>
                {asset.pathExists ? (
                  <span className="ws-path">
                    {asset.relativePath || asset.path}
                    <span className="ws-meta">
                      {" "}
                      · {formatSize(asset.sizeBytes)}
                      {asset.modifiedAt ? ` · ${formatLocalizedDateTime(asset.modifiedAt)}` : ""}
                    </span>
                  </span>
                ) : (
                  <span className="ws-state" data-tone="error" data-testid="asset-lost">
                    <AlertTriangle size={12} aria-hidden="true" /> 文件丢失：{asset.path}
                  </span>
                )}
                {asset.itemId && !asset.itemExists && (
                  <span className="ws-badge ws-badge-unavailable">事项（已删除）</span>
                )}
                {linked && <span className="ws-badge ws-badge-soft">{linked.title}</span>}
                {asset.pathExists && (
                  <button
                    type="button"
                    className="ws-btn ws-btn-quiet"
                    aria-label="打开原文件"
                    onClick={() => void openPath(asset.path)}
                  >
                    <FolderOpen size={13} aria-hidden="true" />
                  </button>
                )}
                {!readonly && (
                  <>
                    <button
                      type="button"
                      className="ws-btn ws-btn-quiet"
                      aria-label="编辑资源"
                      onClick={() =>
                        setAssetForm({
                          id: asset.id,
                          kind: asset.kind,
                          name: asset.name,
                          path: asset.path,
                          itemId: asset.itemId ?? "",
                          note: asset.note,
                        })
                      }
                    >
                      <Link2 size={13} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="ws-btn ws-btn-quiet ws-btn-danger"
                      aria-label="删除资源登记"
                      onClick={() => void deleteAsset(asset.id)}
                    >
                      <Trash2 size={13} aria-hidden="true" />
                    </button>
                  </>
                )}
              </div>
            );
          })
        )}
      </section>
    </div>
  );
}

const GAME_ENGINE_OPTIONS = [
  { value: "unity", label: "Unity" },
  { value: "unreal", label: "Unreal" },
  { value: "godot", label: "Godot" },
  { value: "custom", label: "自定义引擎" },
  { value: "unknown", label: "未知" },
];

const STATUS_FILTER_OPTIONS = [
  { value: "", label: "全部状态" },
  { value: "todo", label: "待办" },
  { value: "doing", label: "进行中" },
  { value: "blocked", label: "阻塞" },
  { value: "done", label: "完成" },
];
