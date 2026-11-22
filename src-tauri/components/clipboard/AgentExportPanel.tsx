//! 剪贴板 → Agent 本地导入包：只写本地文件，不自动上传/发送。
//!
//! 信息架构（默认轻量）：
//! - 收起只显示「导出给 Agent…」；
//! - 展开后：简短说明 → 导出说明 → 导出本地文件包 → 导出结果 → Agent 兼容信息；
//! - Agent 列表只在「Agent 兼容信息」展开时探测，列表行只显示名称 + 一个主要状态 + 详情箭头，
//!   能力细节在单项展开后展示，避免把「窗口可用」误读成「能直接发送」。

import { useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  ChevronRight,
  CircleCheck,
  Copy,
  FolderOutput,
  RefreshCw,
} from "lucide-react";
import AgentIcon from "../ui/AgentIcon";
import CollapsibleSection from "../ui/CollapsibleSection";
import StatusBadge, { type StatusTone } from "../ui/StatusBadge";
import {
  clipboardAgentTargets,
  clipboardExportForAgent,
  type AgentCapability,
  type AgentClipboardTarget,
  type ExportPackage,
} from "../../lib/bridge";
import { copyText } from "../../lib/clipboard";
import { errorMessage } from "../../lib/errors";
import { useUiStore } from "../../store/useUiStore";

const EVIDENCE_LABELS: Record<string, string> = {
  "verified-interface": "已验证接口",
  "window-present": "检测到可交互窗口",
  "exe-found": "已定位可执行文件",
  "local-export": "本地文件导出",
  "unsupported-interface": "无可用接口",
  unverified: "未验证",
  "not-installed": "未安装",
};

function evidenceLabel(evidence: string) {
  return EVIDENCE_LABELS[evidence] ?? evidence;
}

function primaryState(t: AgentClipboardTarget): {
  label: string;
  tone: StatusTone;
  tip: string;
} {
  if (!t.installed) {
    return {
      label: "未安装",
      tone: "neutral",
      tip: "未检测到安装；仍可导出本地文件后手动附加",
    };
  }
  if (t.window_present) {
    return {
      label: "窗口可用",
      tone: "success",
      tip: "仅表示检测到可交互窗口，不代表可以直接发送",
    };
  }
  return {
    label: "已安装",
    tone: "info",
    tip: "已检测到安装，当前没有可交互窗口",
  };
}

function capabilityRows(t: AgentClipboardTarget): {
  label: string;
  value: string;
  capability: AgentCapability;
}[] {
  return [
    {
      label: "直接发送",
      value: t.direct_send.supported ? "可用" : "不支持",
      capability: t.direct_send,
    },
    {
      label: "官方文件导入",
      value: t.file_import.supported ? "可用" : "未验证",
      capability: t.file_import,
    },
    {
      label: "桌面逐项粘贴",
      value: t.desktop_paste.supported ? "可手动触发" : "不可用",
      capability: t.desktop_paste,
    },
    {
      label: "本地导出",
      value: t.export.supported ? "可用" : "不可用",
      capability: t.export,
    },
  ];
}

function limitsOf(t: AgentClipboardTarget) {
  return Array.from(
    new Set([t.direct_send.note, t.file_import.note, t.desktop_paste.note].filter(Boolean)),
  );
}

/**
 * 探测时间文案：必须区分「真实扫描时间」与「缓存结果」。
 * - cached：后端直接返回 5 分钟内的旧快照，按快照年龄写成「约 N 分钟前探测」；
 * - 非 cached：本次请求真的重新扫描过，显示扫描完成的本地时间。
 * 不使用定时器刷新，下拉/收起会重新渲染，文本按当时时间保守估算。
 */
function probedLabel(at: number, cached: boolean, refreshFailed: boolean) {
  const time = new Date(at).toLocaleTimeString();
  const stale = refreshFailed ? "（本次刷新失败，以下为上次有效结果）" : "";
  if (!cached) {
    return `上次探测 ${time}${stale}；窗口状态可能已变化，可重新探测。`;
  }
  const minutes = Math.max(1, Math.round((Date.now() - at) / 60000));
  return `缓存结果 · 约 ${minutes} 分钟前探测（${time}）${stale}；窗口状态可能已变化，可重新探测。`;
}

function ExportResult({
  pkg,
  onCopy,
}: {
  pkg: ExportPackage;
  onCopy: (path: string) => void;
}) {
  return (
    <div className="clip-export-result" role="status">
      <div className="clip-export-title">
        <CircleCheck size={12} aria-hidden="true" /> 已生成本地文件包（未发送）
      </div>
      <div className="clip-export-line">
        <span className="clip-export-key">导出目录</span>
        <code>{pkg.dir}</code>
        <button
          type="button"
          className="icon-btn sm"
          data-tip="复制目录"
          aria-label="复制导出目录"
          onClick={() => onCopy(pkg.dir)}
        >
          <Copy size={11} aria-hidden="true" />
        </button>
      </div>
      <div className="clip-export-line">
        <span className="clip-export-key">Markdown</span>
        <code>{pkg.markdown_path}</code>
        <button
          type="button"
          className="icon-btn sm"
          data-tip="复制路径"
          aria-label="复制 Markdown 路径"
          onClick={() => onCopy(pkg.markdown_path)}
        >
          <Copy size={11} aria-hidden="true" />
        </button>
      </div>
      <div className="clip-export-meta">
        {pkg.summary}（{pkg.files.length} 个文件）
      </div>
      {pkg.warnings.length > 0 && (
        <div className="clip-export-warn">{pkg.warnings.join("；")}</div>
      )}
    </div>
  );
}

export default function AgentExportPanel({
  targetType,
  targetId,
  taskId,
}: {
  targetType: "item" | "group";
  targetId: string;
  taskId?: string | null;
}) {
  const showToast = useUiStore((s) => s.showToast);
  const [open, setOpen] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [agentsOpen, setAgentsOpen] = useState(false);
  const [expandedAgent, setExpandedAgent] = useState<string | null>(null);
  const [targets, setTargets] = useState<AgentClipboardTarget[] | null>(null);
  const [targetsError, setTargetsError] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);
  const [pkg, setPkg] = useState<ExportPackage | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [probedAt, setProbedAt] = useState<number | null>(null);
  const [probedCached, setProbedCached] = useState(false);
  const aliveRef = useRef(true);
  const probingRef = useRef(false);
  // 当前上下文的代际：切换条目/分组或关闭面板时递增。
  // 异步回调用发起时捕获的代际比对，只有代际未变才允许写回界面。
  const contextVersionRef = useRef(0);
  // 当前代际内已发起的导出（同上下文连点只允许一个在途请求）。
  const pendingExportRef = useRef<number | null>(null);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // 切换条目/分组后不能沿用上一次的导出结果与展开状态。
  useEffect(() => {
    contextVersionRef.current += 1;
    pendingExportRef.current = null;
    setOpen(false);
    setNoteOpen(false);
    setAgentsOpen(false);
    setExpandedAgent(null);
    setPkg(null);
    setExportError(null);
    setBusy(false);
  }, [targetType, targetId, taskId]);

  function handlePanelToggle(next: boolean) {
    // 关闭即视为当前上下文作废：在途导出/复制回调的结果都会被丢弃。
    // 注意这只丢弃前端结果，不会取消后端已开始的导出，也不会删除已生成的文件。
    contextVersionRef.current += 1;
    pendingExportRef.current = null;
    setOpen(next);
    setBusy(false);
    if (!next) {
      // 重开面板时不展示旧的导出成功状态，技术说明与兼容详情也回到默认收起。
      setPkg(null);
      setExportError(null);
      setNoteOpen(false);
      setAgentsOpen(false);
      setExpandedAgent(null);
    }
  }

  async function loadTargets(force: boolean) {
    if (probingRef.current) return;
    probingRef.current = true;
    setProbing(true);
    setTargetsError(null);
    try {
      const snapshot = await clipboardAgentTargets(force);
      if (!aliveRef.current) return;
      setTargets(snapshot.targets);
      // `probed_at_ms` 是后端快照的真实扫描时间；cached 表示本次只是读到 5 分钟内的旧快照，
      // 不能用「前端收到响应的时间」冒充扫描时间。
      setProbedAt(snapshot.probed_at_ms);
      setProbedCached(snapshot.cached);
      setExpandedAgent((prev) =>
        prev && snapshot.targets.some((t) => t.source_id === prev) ? prev : null,
      );
    } catch (e) {
      // 失败时保留最近一次有效列表与时间，错误单独展示，避免把旧数据说成刚探测。
      if (!aliveRef.current) return;
      setTargetsError(errorMessage(e));
    } finally {
      probingRef.current = false;
      if (aliveRef.current) setProbing(false);
    }
  }

  function handleAgentsToggle(next: boolean) {
    setAgentsOpen(next);
    if (!next) {
      setExpandedAgent(null);
      return;
    }
    if (targets === null && !probingRef.current) void loadTargets(false);
  }

  async function onExport() {
    const version = contextVersionRef.current;
    // 同一上下文连点只发一次；切到别的条目/分组后各自独立，结果按代际归属。
    if (pendingExportRef.current === version) return;
    pendingExportRef.current = version;
    setBusy(true);
    setExportError(null);
    setPkg(null);
    try {
      const result = await clipboardExportForAgent(targetType, targetId, taskId ?? null);
      // 这里只是「忽略异步结果」：后端导出任务已在独立线程完成并留下文件，不会中断或删除。
      // 只有代际仍属于当前上下文时才写回；否则旧结果不得覆盖新目标，也不得弹提示。
      if (!aliveRef.current || version !== contextVersionRef.current) return;
      setPkg(result);
      showToast(`已导出 ${result.item_count} 项到本地文件（未发送）`, { kind: "success" });
    } catch (e) {
      if (!aliveRef.current || version !== contextVersionRef.current) return;
      setExportError(errorMessage(e));
    } finally {
      if (pendingExportRef.current === version) pendingExportRef.current = null;
      // 代际已变时不要清掉新上下文正在进行的导出 loading。
      if (aliveRef.current && version === contextVersionRef.current) setBusy(false);
    }
  }

  async function onCopyPath(path: string) {
    const version = contextVersionRef.current;
    const ok = await copyText(path);
    // 上下文已切换/面板已关闭/组件已卸载：只丢弃提示，不重试也不写回。
    if (!aliveRef.current || version !== contextVersionRef.current) return;
    showToast(ok ? "路径已复制" : `路径：${path}`, { kind: ok ? "success" : "info" });
  }

  const description = taskId
    ? "将当前内容整理为本地文件包，供 Agent 手动导入，不会自动发送。包含关联任务上下文。"
    : "将当前内容整理为本地文件包，供 Agent 手动导入，不会自动发送。";

  return (
    <CollapsibleSection
      className="clip-agent-export"
      title="导出给 Agent…"
      icon={<AgentIcon size={12} />}
      description={open ? description : undefined}
      expanded={open}
      onExpandedChange={handlePanelToggle}
    >
      <div className="clip-agent-body">
        <CollapsibleSection
          className="clip-agent-note"
          title="导出说明"
          expanded={noteOpen}
          onExpandedChange={setNoteOpen}
        >
          <ul className="clip-agent-note-list">
            <li>导出包包含 Markdown、图片文件与 manifest.json，只写入本机目录。</li>
            <li>不会自动上传或发送给任何 Agent；请在目标 Agent 中手动附加文件。</li>
            <li>
              桌面粘贴只在分组详情中由用户手动选择窗口后逐项触发；是否被 Agent 接收无法自动验证。
            </li>
          </ul>
        </CollapsibleSection>

        <div className="clip-agent-actions">
          <button
            className="btn sm primary"
            onClick={onExport}
            disabled={busy}
            aria-busy={busy}
          >
            {busy ? (
              <RefreshCw size={12} className="spin" aria-hidden="true" />
            ) : (
              <FolderOutput size={12} aria-hidden="true" />
            )}{" "}
            导出本地文件包
          </button>
          <span className="clip-agent-actions-hint">只写本地文件，不自动发送</span>
        </div>

        {exportError && (
          <div className="clip-agent-error" role="alert">
            <AlertCircle size={12} aria-hidden="true" />
            <span>导出失败：{exportError}</span>
          </div>
        )}

        {pkg && <ExportResult pkg={pkg} onCopy={onCopyPath} />}

        <CollapsibleSection
          className="clip-agent-compat"
          title="Agent 兼容信息"
          icon={<AgentIcon size={12} />}
          badge={targets !== null ? targets.length : undefined}
          expanded={agentsOpen}
          onExpandedChange={handleAgentsToggle}
        >
          {probing && (
            <div className="clip-agent-probe" role="status">
              <RefreshCw size={12} className="spin" aria-hidden="true" />
              <span>正在探测本机 Agent 安装与窗口，首次可能需要十几秒；不影响本地导出。</span>
            </div>
          )}

          {targetsError && (
            <div className="clip-agent-error" role="alert">
              <AlertCircle size={12} aria-hidden="true" />
              <span>读取 Agent 列表失败：{targetsError}</span>
              <button
                type="button"
                className="btn sm"
                onClick={() => void loadTargets(true)}
                disabled={probing}
              >
                重试
              </button>
            </div>
          )}

          {!probing && targets !== null && (targets.length > 0 || !targetsError) && (
            <>
              {targets.length === 0 ? (
                <div className="clip-agent-empty">
                  未发现已注册的 Agent；仍可导出本地文件后手动附加。
                </div>
              ) : (
                <ul className="clip-agent-list">
                  {targets.map((t) => {
                    const state = primaryState(t);
                    const isOpen = expandedAgent === t.source_id;
                    const detailId = `clip-agent-detail-${targetType}-${targetId}-${t.source_id}`;
                    return (
                      <li key={t.source_id} className="clip-agent-item">
                        <button
                          type="button"
                          className="clip-agent-row"
                          aria-expanded={isOpen}
                          aria-controls={detailId}
                          onClick={() =>
                            setExpandedAgent(isOpen ? null : t.source_id)
                          }
                        >
                          <span className="clip-agent-name" title={t.display_name}>
                            {t.display_name}
                          </span>
                          <StatusBadge
                            tone={state.tone}
                            size="sm"
                            className="clip-agent-state"
                            dataTip={state.tip}
                          >
                            {state.label}
                          </StatusBadge>
                          <ChevronRight
                            size={12}
                            className={`clip-agent-chevron${isOpen ? " is-open" : ""}`}
                            aria-hidden="true"
                          />
                        </button>
                        <div
                          className="clip-agent-detail"
                          id={detailId}
                          hidden={!isOpen}
                        >
                          {isOpen && (
                            <>
                              <div className="clip-agent-caps">
                                {capabilityRows(t).map((row) => (
                                  <div className="clip-agent-cap" key={row.label}>
                                    <span className="clip-agent-cap-label">
                                      {row.label}
                                    </span>
                                    <span
                                      className={`clip-agent-cap-value${
                                        row.capability.supported ? "" : " is-off"
                                      }`}
                                    >
                                      <span className="clip-agent-cap-result">
                                        {row.value}
                                      </span>
                                      <span className="clip-agent-cap-evidence">
                                        {evidenceLabel(row.capability.evidence)}
                                      </span>
                                    </span>
                                  </div>
                                ))}
                              </div>
                              {limitsOf(t).length > 0 && (
                                <div className="clip-agent-limits">
                                  <span className="clip-agent-cap-label">限制说明</span>
                                  <ul>
                                    {limitsOf(t).map((note) => (
                                      <li key={note}>{note}</li>
                                    ))}
                                  </ul>
                                </div>
                              )}
                            </>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
              {probedAt !== null && (
                <div className="clip-agent-probed-at">
                  {probedLabel(probedAt, probedCached, targets !== null && targetsError !== null)}
                </div>
              )}
              <div className="clip-agent-list-foot">
                <span>「窗口可用 / 已安装」只表示应用状态，不代表可以直接发送。</span>
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => void loadTargets(true)}
                  disabled={probing}
                >
                  <RefreshCw size={11} aria-hidden="true" /> 重新探测
                </button>
              </div>
            </>
          )}
        </CollapsibleSection>
      </div>
    </CollapsibleSection>
  );
}
