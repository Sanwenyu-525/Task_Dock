//! 游戏线「构建与测试」模块（G1，2026-11-16）：构建记录 + 测试记录。
//!
//! 边界：
//! - 本轮**只做手动登记**，不接入引擎执行器，不渲染自动构建按钮；
//! - 日志/产物路径只读引用，打开原文件不修改；
//! - 归档项目只读；非 game 类型防御性降级；失败可见 + 可重试。

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  FolderOpen,
  Link2,
  Plus,
  Trash2,
  Wrench,
} from "lucide-react";

import Select from "../../../components/ui/Select";
import { errorMessage } from "../../../lib/errors";
import { formatLocalizedDateTime } from "../../../i18n/format";
import type { WorkspaceItem } from "../../../lib/bridge";
import type { CreativeModuleProps } from "../types";
import * as api from "./ipc";
import {
  GAME_BUILD_STATUSES,
  GAME_TEST_RESULTS,
  buildStatusLabel,
  testResultLabel,
  type GameBuild,
  type GameTestRecord,
} from "./types";

interface BuildForm {
  id?: string;
  target: string;
  engine: string;
  config: string;
  status: string;
  logPath: string;
  logSummary: string;
  artifactPath: string;
  itemId: string;
  note: string;
}

interface TestForm {
  id?: string;
  buildId: string;
  title: string;
  scope: string;
  result: string;
  summary: string;
  defectCount: number;
  itemId: string;
  note: string;
}

export default function GameBuildsPanel({
  projectId,
  kind,
  archived,
  onNotice,
}: CreativeModuleProps) {
  const readonly = archived || kind !== "game";

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [builds, setBuilds] = useState<GameBuild[]>([]);
  const [tests, setTests] = useState<GameTestRecord[]>([]);
  const [items, setItems] = useState<WorkspaceItem[]>([]);

  const [buildForm, setBuildForm] = useState<BuildForm | null>(null);
  const [testForm, setTestForm] = useState<TestForm | null>(null);
  const [saving, setSaving] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [buildRes, testRes, itemRes] = await Promise.all([
        api.gameBuildList(projectId),
        api.gameTestList(projectId),
        api.workspaceItemList(projectId),
      ]);
      setBuilds(buildRes.builds);
      setTests(testRes.tests);
      setItems(itemRes.items);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const buildById = useMemo(() => {
    const map = new Map<string, GameBuild>();
    for (const build of builds) map.set(build.id, build);
    return map;
  }, [builds]);

  const itemById = useMemo(() => {
    const map = new Map<string, WorkspaceItem>();
    for (const item of items) map.set(item.id, item);
    return map;
  }, [items]);

  async function saveBuild() {
    if (!buildForm) return;
    if (!buildForm.target.trim()) {
      onNotice("error", "构建目标不能为空");
      return;
    }
    setSaving(true);
    try {
      await api.gameBuildSave({
        id: buildForm.id ?? null,
        projectId,
        target: buildForm.target.trim(),
        engine: buildForm.engine || null,
        config: buildForm.config || null,
        status: buildForm.status,
        logPath: buildForm.logPath || null,
        logSummary: buildForm.logSummary || null,
        artifactPath: buildForm.artifactPath || null,
        itemId: buildForm.itemId || null,
        note: buildForm.note || null,
      });
      setBuildForm(null);
      onNotice("ok", "构建记录已保存（手动登记）");
      await reload();
    } catch (e) {
      onNotice("error", errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  async function deleteBuild(id: string) {
    setSaving(true);
    try {
      await api.gameBuildDelete(id);
      onNotice("ok", "构建记录已删除");
      await reload();
    } catch (e) {
      onNotice("error", errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  async function saveTest() {
    if (!testForm) return;
    if (!testForm.title.trim()) {
      onNotice("error", "测试标题不能为空");
      return;
    }
    setSaving(true);
    try {
      await api.gameTestSave({
        id: testForm.id ?? null,
        projectId,
        buildId: testForm.buildId || null,
        title: testForm.title.trim(),
        scope: testForm.scope || null,
        result: testForm.result,
        summary: testForm.summary || null,
        defectCount: testForm.defectCount,
        itemId: testForm.itemId || null,
        note: testForm.note || null,
      });
      setTestForm(null);
      onNotice("ok", "测试记录已保存");
      await reload();
    } catch (e) {
      onNotice("error", errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  async function deleteTest(id: string) {
    setSaving(true);
    try {
      await api.gameTestDelete(id);
      onNotice("ok", "测试记录已删除");
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
        构建与测试模块仅对游戏项目开放。
      </div>
    );
  }

  return (
    <div className="ws-game" data-testid="game-builds-panel">
      {archived && (
        <div className="ws-state" role="status" data-tone="warn">
          项目已归档：以下内容只读，不能新增或修改。
        </div>
      )}
      <div className="ws-state" role="status" data-tone="info" data-testid="game-manual-notice">
        <Wrench size={13} aria-hidden="true" />
        手动登记（未接入引擎执行器）：本轮不调用 Unity / Unreal / Godot 构建命令，
        记录由人工填写，日志与产物路径仅作只读引用。
      </div>
      {error && (
        <div className="ws-state" role="alert" data-tone="error">
          <AlertTriangle size={13} aria-hidden="true" />
          <span className="ws-flex">{error}</span>
          <button type="button" className="ws-btn ws-btn-quiet" onClick={() => void reload()}>
            重试
          </button>
        </div>
      )}

      {/* 构建记录 */}
      <section className="ws-card" aria-label="构建记录">
        <div className="ws-row">
          <h3 className="ws-subhead" style={{ margin: 0 }}>
            构建记录
          </h3>
          <span className="ws-meta">{builds.length} 条</span>
          <span className="ws-flex" />
          {!readonly && (
            <button
              type="button"
              className="ws-btn ws-btn-quiet"
              onClick={() =>
                setBuildForm({
                  target: "",
                  engine: "",
                  config: "",
                  status: "planned",
                  logPath: "",
                  logSummary: "",
                  artifactPath: "",
                  itemId: "",
                  note: "",
                })
              }
            >
              <Plus size={13} aria-hidden="true" /> 登记构建
            </button>
          )}
        </div>

        {buildForm && (
          <>
            <div className="ws-form-row">
              <input
                className="ws-input"
                placeholder="构建目标（如 Windows / Android）"
                value={buildForm.target}
                onChange={(e) => setBuildForm({ ...buildForm, target: e.target.value })}
              />
              <input
                className="ws-input"
                placeholder="引擎（可选）"
                value={buildForm.engine}
                onChange={(e) => setBuildForm({ ...buildForm, engine: e.target.value })}
              />
              <input
                className="ws-input"
                placeholder="配置（Debug/Release）"
                value={buildForm.config}
                onChange={(e) => setBuildForm({ ...buildForm, config: e.target.value })}
              />
              <Select
                ariaLabel="构建状态"
                value={buildForm.status}
                options={GAME_BUILD_STATUSES}
                onChange={(v) => setBuildForm({ ...buildForm, status: v })}
              />
            </div>
            <div className="ws-form-row">
              <input
                className="ws-input ws-flex-2"
                placeholder="日志路径（绝对路径，可选）"
                value={buildForm.logPath}
                onChange={(e) => setBuildForm({ ...buildForm, logPath: e.target.value })}
              />
              <input
                className="ws-input ws-flex-2"
                placeholder="产物路径（绝对路径，可选）"
                value={buildForm.artifactPath}
                onChange={(e) => setBuildForm({ ...buildForm, artifactPath: e.target.value })}
              />
              <Select
                ariaLabel="关联制作事项"
                value={buildForm.itemId}
                options={[
                  { value: "", label: "不关联事项" },
                  ...items.map((it) => ({ value: it.id, label: it.title })),
                ]}
                onChange={(v) => setBuildForm({ ...buildForm, itemId: v })}
              />
            </div>
            <div className="ws-form-row">
              <textarea
                className="ws-textarea ws-flex-2"
                placeholder="日志摘要（可选）"
                value={buildForm.logSummary}
                onChange={(e) => setBuildForm({ ...buildForm, logSummary: e.target.value })}
              />
              <textarea
                className="ws-textarea ws-flex-2"
                placeholder="备注（可选）"
                value={buildForm.note}
                onChange={(e) => setBuildForm({ ...buildForm, note: e.target.value })}
              />
            </div>
            <div className="ws-form-actions">
              <button type="button" className="ws-btn" disabled={saving} onClick={() => void saveBuild()}>
                保存
              </button>
              <button
                type="button"
                className="ws-btn ws-btn-quiet"
                onClick={() => setBuildForm(null)}
              >
                取消
              </button>
            </div>
          </>
        )}

        {loading && builds.length === 0 && tests.length === 0 ? (
          <div className="ws-empty">加载中…</div>
        ) : builds.length === 0 ? (
          <div className="ws-empty">暂无构建记录；在引擎里完成构建后，可在此手动登记结果。</div>
        ) : (
          builds.map((build) => {
            const linked = build.itemId ? itemById.get(build.itemId) : undefined;
            return (
              <div key={build.id} className="ws-row" data-build-id={build.id}>
                <span className="ws-flex">
                  {build.target}
                  <span className="ws-meta">
                    {" "}
                    {build.engine ? ` · ${build.engine}` : ""}
                    {build.config ? ` · ${build.config}` : ""}
                  </span>
                </span>
                <span
                  className={`ws-badge ${
                    build.status === "success"
                      ? "ws-badge-available"
                      : build.status === "failed"
                        ? "ws-badge-unavailable"
                        : "ws-badge-soft"
                  }`}
                >
                  {buildStatusLabel(build.status)}
                </span>
                <span className="ws-meta">{formatLocalizedDateTime(build.builtAt)}</span>
                {build.logPath && (
                  <button
                    type="button"
                    className="ws-btn ws-btn-quiet"
                    aria-label="打开日志"
                    data-log-exists={String(build.logExists)}
                    onClick={() => void openPath(build.logPath)}
                  >
                    <FolderOpen size={13} aria-hidden="true" /> 日志
                  </button>
                )}
                {build.artifactPath && (
                  <button
                    type="button"
                    className="ws-btn ws-btn-quiet"
                    aria-label="打开产物"
                    data-artifact-exists={String(build.artifactExists)}
                    onClick={() => void openPath(build.artifactPath)}
                  >
                    <FolderOpen size={13} aria-hidden="true" /> 产物
                  </button>
                )}
                {linked && <span className="ws-badge ws-badge-soft">{linked.title}</span>}
                {!readonly && (
                  <>
                    <button
                      type="button"
                      className="ws-btn ws-btn-quiet"
                      aria-label="编辑构建记录"
                      onClick={() =>
                        setBuildForm({
                          id: build.id,
                          target: build.target,
                          engine: build.engine,
                          config: build.config,
                          status: build.status,
                          logPath: build.logPath,
                          logSummary: build.logSummary,
                          artifactPath: build.artifactPath,
                          itemId: build.itemId ?? "",
                          note: build.note,
                        })
                      }
                    >
                      <Link2 size={13} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="ws-btn ws-btn-quiet ws-btn-danger"
                      aria-label="删除构建记录"
                      onClick={() => void deleteBuild(build.id)}
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

      {/* 测试记录 */}
      <section className="ws-card" aria-label="测试记录">
        <div className="ws-row">
          <h3 className="ws-subhead" style={{ margin: 0 }}>
            测试记录
          </h3>
          <span className="ws-meta">{tests.length} 条</span>
          <span className="ws-flex" />
          {!readonly && (
            <button
              type="button"
              className="ws-btn ws-btn-quiet"
              onClick={() =>
                setTestForm({
                  buildId: "",
                  title: "",
                  scope: "",
                  result: "unknown",
                  summary: "",
                  defectCount: 0,
                  itemId: "",
                  note: "",
                })
              }
            >
              <Plus size={13} aria-hidden="true" /> 登记测试
            </button>
          )}
        </div>

        {testForm && (
          <>
            <div className="ws-form-row">
              <input
                className="ws-input"
                placeholder="测试标题"
                value={testForm.title}
                onChange={(e) => setTestForm({ ...testForm, title: e.target.value })}
              />
              <Select
                ariaLabel="关联构建"
                value={testForm.buildId}
                options={[
                  { value: "", label: "不关联构建" },
                  ...builds.map((b) => ({ value: b.id, label: b.target })),
                ]}
                onChange={(v) => setTestForm({ ...testForm, buildId: v })}
              />
              <Select
                ariaLabel="测试结果"
                value={testForm.result}
                options={GAME_TEST_RESULTS}
                onChange={(v) => setTestForm({ ...testForm, result: v })}
              />
              <input
                className="ws-input"
                type="number"
                min={0}
                placeholder="缺陷数"
                value={testForm.defectCount}
                onChange={(e) =>
                  setTestForm({ ...testForm, defectCount: Number(e.target.value) || 0 })
                }
              />
            </div>
            <div className="ws-form-row">
              <input
                className="ws-input ws-flex-2"
                placeholder="测试范围（可选）"
                value={testForm.scope}
                onChange={(e) => setTestForm({ ...testForm, scope: e.target.value })}
              />
              <Select
                ariaLabel="关联制作事项"
                value={testForm.itemId}
                options={[
                  { value: "", label: "不关联事项" },
                  ...items.map((it) => ({ value: it.id, label: it.title })),
                ]}
                onChange={(v) => setTestForm({ ...testForm, itemId: v })}
              />
            </div>
            <div className="ws-form-row">
              <textarea
                className="ws-textarea ws-flex-2"
                placeholder="测试摘要（可选）"
                value={testForm.summary}
                onChange={(e) => setTestForm({ ...testForm, summary: e.target.value })}
              />
              <textarea
                className="ws-textarea ws-flex-2"
                placeholder="备注（可选）"
                value={testForm.note}
                onChange={(e) => setTestForm({ ...testForm, note: e.target.value })}
              />
            </div>
            <div className="ws-form-actions">
              <button type="button" className="ws-btn" disabled={saving} onClick={() => void saveTest()}>
                保存
              </button>
              <button
                type="button"
                className="ws-btn ws-btn-quiet"
                onClick={() => setTestForm(null)}
              >
                取消
              </button>
            </div>
          </>
        )}

        {tests.length === 0 ? (
          <div className="ws-empty">暂无测试记录；可登记测试轮次、范围、结果与缺陷数。</div>
        ) : (
          tests.map((test) => {
            const linkedBuild = test.buildId ? buildById.get(test.buildId) : undefined;
            const linked = test.itemId ? itemById.get(test.itemId) : undefined;
            return (
              <div key={test.id} className="ws-row" data-test-id={test.id}>
                <span className="ws-flex">
                  {test.title}
                  {test.scope ? <span className="ws-meta"> · {test.scope}</span> : null}
                </span>
                {linkedBuild && (
                  <span className="ws-badge ws-badge-soft">构建：{linkedBuild.target}</span>
                )}
                <span
                  className={`ws-badge ${
                    test.result === "passed"
                      ? "ws-badge-available"
                      : test.result === "failed"
                        ? "ws-badge-unavailable"
                        : "ws-badge-soft"
                  }`}
                >
                  {testResultLabel(test.result)}
                </span>
                <span className="ws-meta">
                  {formatLocalizedDateTime(test.testedAt)}
                  {test.defectCount > 0 ? ` · 缺陷 ${test.defectCount}` : ""}
                </span>
                {linked && <span className="ws-badge ws-badge-soft">{linked.title}</span>}
                {!readonly && (
                  <>
                    <button
                      type="button"
                      className="ws-btn ws-btn-quiet"
                      aria-label="编辑测试记录"
                      onClick={() =>
                        setTestForm({
                          id: test.id,
                          buildId: test.buildId ?? "",
                          title: test.title,
                          scope: test.scope,
                          result: test.result,
                          summary: test.summary,
                          defectCount: test.defectCount,
                          itemId: test.itemId ?? "",
                          note: test.note,
                        })
                      }
                    >
                      <Link2 size={13} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="ws-btn ws-btn-quiet ws-btn-danger"
                      aria-label="删除测试记录"
                      onClick={() => void deleteTest(test.id)}
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
