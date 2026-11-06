//! 收集箱「文件」子页（胶囊内）——文件投递部分。
//!
//! 职责：把 Windows 资源管理器里拖来的文件/文件夹，**直接**落到用户配置好的真实目录。
//! 与「快速收集」互补：那边存文字/链接/待办，这边只搬文件，不写库、不进暂存架。
//!
//! 设计约束（详见 docs/shelf/README.md §12）：
//! - 拖入走 `lib/fileDrop` 的**唯一** Webview 订阅，本面板只是其中一个消费者；
//!   命中不到具体卡片就什么都不做（fail-closed），绝不猜测目标目录；
//! - 命中只认 `data-drop-target` 卡片，高亮层 `pointer-events: none` 不挡命中；
//! - 结果内联展示（成功/跳过/失败逐项原因 + 打开目标目录），不依赖 Toast：
//!   胶囊窗口被 Win32 裁剪，浮层提示可能落在可见区域之外；
//! - 面板卸载只释放拖放订阅与定时器；在途投递的进度与结果由 store 持有，
//!   重开面板仍能看到，底层文件操作不会被界面卸载打断。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  Folder,
  FolderInput,
  Loader2,
  MoreVertical,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import {
  dropTargetAt,
  registerFileDropConsumer,
  type DropPoint,
} from "../../lib/fileDrop";
import { errorMessage } from "../../lib/errors";
import { useDropTargetsStore } from "../../store/useDropTargetsStore";
import { DropdownMenu } from "../ui";
import DropTargetForm from "../shelf/DropTargetForm";
import type { ShelfDropTarget } from "../../lib/bridge";
import { openFullApp } from "./actions";
import InboxRecentShelf from "./InboxRecentShelf";
import { EmptyState } from "./PanelKit";

/** 表单与底栏共用：底栏按钮通过 form 属性提交，不在表单里再放一套主操作。 */
const FORM_ID = "cap-drop-target-form";

/** 卡片上只留最有辨识度的一段路径：`…\父目录\名称`，完整路径放 title。 */
function shortPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 2) return path;
  return `…\\${parts.slice(-2).join("\\")}`;
}

/** 结果条的状态标签：跳过 / 部分完成都不能被说成成功。 */
const STATUS_LABEL: Record<string, string> = {
  ok: "成功",
  skipped: "跳过",
  failed: "失败",
  partial: "部分完成",
};

export default function InboxDropPane() {
  const targets = useDropTargetsStore((s) => s.targets);
  const loading = useDropTargetsStore((s) => s.loading);
  const loaded = useDropTargetsStore((s) => s.loaded);
  const error = useDropTargetsStore((s) => s.error);
  const ops = useDropTargetsStore((s) => s.ops);
  const reports = useDropTargetsStore((s) => s.reports);
  const reportNames = useDropTargetsStore((s) => s.reportNames);
  const lastTargetId = useDropTargetsStore((s) => s.lastTargetId);
  const load = useDropTargetsStore((s) => s.load);
  const drop = useDropTargetsStore((s) => s.drop);
  const remove = useDropTargetsStore((s) => s.remove);
  const move = useDropTargetsStore((s) => s.move);
  const openDir = useDropTargetsStore((s) => s.openDir);
  const clearReport = useDropTargetsStore((s) => s.clearReport);
  const requestManage = useDropTargetsStore((s) => s.requestManage);

  const [overId, setOverId] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  /** null=不在表单里；"new"=新增；其余为目标 id=编辑 */
  const [editing, setEditing] = useState<string | null>(null);
  /** 表单在途状态：底栏按钮与表单共享，避免重复提交/取消丢失。 */
  const [formBusy, setFormBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reportOpen, setReportOpen] = useState(false);
  const overRef = useRef<string | null>(null);
  const timers = useRef(new Set<number>());
  /** 卸载后不再更新任何本地状态：投递可能在面板关闭后才返回（结果由 store 保留）。 */
  const alive = useRef(true);
  useEffect(() => {
    // StrictMode 下 effect 会「清理 → 重跑」一次，必须在这里重新置真。
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const visible = useMemo(
    () => targets.filter((t) => t.show_in_capsule),
    [targets],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // 提示 3.2s 自动消失；卸载时清掉全部计时器（不对已卸载组件 setState）
  useEffect(() => {
    const pending = timers.current;
    return () => {
      pending.forEach((t) => window.clearTimeout(t));
      pending.clear();
    };
  }, []);

  const flash = useCallback((msg: string) => {
    if (!alive.current) return;
    setNotice(msg);
    const t = window.setTimeout(() => {
      timers.current.delete(t);
      setNotice((n) => (n === msg ? null : n));
    }, 3200);
    timers.current.add(t);
  }, []);

  const setOver = useCallback((id: string | null) => {
    // 高频 over 事件只在实际换卡时触发一次渲染，避免拖入时反复重排
    if (overRef.current === id) return;
    overRef.current = id;
    setOverId(id);
  }, []);

  /** 只命中「当前显示的卡片」，隐藏目标不接收投递。 */
  const hitVisible = useCallback((point: DropPoint): string | null => {
    const id = dropTargetAt(point);
    if (!id) return null;
    const list = useDropTargetsStore.getState().targets;
    return list.some((t) => t.id === id && t.show_in_capsule) ? id : null;
  }, []);

  // 视图切换（进入表单、目标被隐藏/删除）时旧高亮立即失效：
  // 已不在列表里的卡片不能继续显示「松开即投递到…」。
  useEffect(() => {
    if (editing !== null) {
      setOver(null);
      setDragging(false);
      return;
    }
    if (overRef.current && !visible.some((t) => t.id === overRef.current)) {
      setOver(null);
    }
  }, [editing, visible, setOver]);

  const submit = useCallback(
    async (targetId: string, paths: string[]) => {
      const target = useDropTargetsStore.getState().targets.find((t) => t.id === targetId);
      if (!target) return;
      if (!target.available) {
        // 可用性是缓存的快照：盘刚插回来时不能因为旧快照一直拒绝。
        // 强制重探一次（只在「看起来不可用」这条路径上发生，不轮询）。
        await useDropTargetsStore.getState().load({ force: true });
        const fresh = useDropTargetsStore.getState().targets.find((t) => t.id === targetId);
        if (!fresh || !fresh.available) {
          if (alive.current) flash(`「${target.name}」目录不可用，未执行投递`);
          return;
        }
      }
      try {
        const report = await drop(targetId, paths);
        if (!report || !alive.current) return; // 被去重/在途守卫拦下，或面板已关闭
        setReportOpen(report.failed > 0 || report.partial > 0);
        if (report.failed > 0 || report.partial > 0) {
          const parts: string[] = [];
          if (report.failed > 0) parts.push(`${report.failed} 项失败`);
          if (report.partial > 0) parts.push(`${report.partial} 项部分完成`);
          flash(`「${target.name}」${parts.join("、")}，详情见下方结果`);
        }
      } catch (e) {
        if (alive.current) flash(`投递失败：${errorMessage(e)}`);
      }
    },
    [drop, flash],
  );

  // ── 拖入订阅（面板在即订阅，卸载即释放；全应用只有一条 Webview 监听）──
  useEffect(() => {
    return registerFileDropConsumer({
      id: "capsule-inbox-drop",
      priority: 20,
      claim: () =>
        useDropTargetsStore.getState().targets.some((t) => t.show_in_capsule),
      onEnter: () => setDragging(true),
      onOver: (point) => setOver(point ? hitVisible(point) : null),
      onLeave: () => {
        setOver(null);
        setDragging(false);
      },
      onDrop: (paths, point) => {
        // 用**松手瞬间**的坐标重新命中：`over` 缓存可能已经过期（悬停 A 后快速移到
        // B 直接松手，不会再收到 over），拿缓存会让文件落进上一张卡片。
        // 没有坐标、没命中卡片、或卡片已隐藏/删除时一律不执行文件操作。
        const targetId = point ? hitVisible(point) : null;
        setOver(null);
        setDragging(false);
        if (!targetId || paths.length === 0) return;
        void submit(targetId, paths);
      },
    });
  }, [hitVisible, setOver, submit]);

  const lastReport = lastTargetId ? reports[lastTargetId] ?? null : null;
  const lastTarget = lastTargetId ? targets.find((t) => t.id === lastTargetId) ?? null : null;
  // 目标被移除后仍要能说明「这是哪次投递」：用投递时记录的名称兜底。
  const lastTargetName = lastTarget?.name ?? (lastTargetId ? reportNames[lastTargetId] ?? "" : "");
  /** 目标配置已不存在：不能再调 openDir（后端按 id 查不到），改为展示目标路径。 */
  const targetGone = lastTargetId !== null && lastTarget === null;
  // 跳过不是成功，部分完成也不是失败：三类都列出来，由用户判断是否需要处理。
  const pendingEntries = (lastReport?.entries ?? []).filter((e) => e.status !== "ok");

  const empty = visible.length === 0;

  return (
    <>
      {error && (
        <div className="cap-drop-error" role="alert">
          <span>{error}</span>
          <button
            type="button"
            className="cap-mini"
            onClick={() => void load({ force: true })}
          >
            重试
          </button>
        </div>
      )}

      <div className="cap-drop">
      {editing !== null ? (
        <DropTargetForm
          target={editing === "new" ? null : targets.find((t) => t.id === editing) ?? null}
          variant="capsule"
          formId={FORM_ID}
          hideActions
          onBusyChange={setFormBusy}
          onDone={(msg) => {
            setEditing(null);
            setFormBusy(false);
            if (msg) flash(msg);
          }}
          onError={(msg) => flash(msg)}
        />
      ) : (
        <>
          {/* 空态只在「确实没有目标」或「首次读取中」出现：
              读取失败由上方错误条负责（不冒充正在读取）；目标全部未勾选
              「在工具面板显示」时由下方提示负责（不误报还没有目标、不诱导重复添加）。 */}
          {empty && !loading && !error && targets.length === 0 && (
            <EmptyState
              icon={<FolderInput size={22} strokeWidth={1.6} aria-hidden="true" />}
              text={loaded ? "还没有文件投递目标" : "正在读取投递目标"}
              actionLabel={loaded ? "添加目标文件夹" : undefined}
              onAction={loaded ? () => setEditing("new") : undefined}
            />
          )}

          {/* 拖入中的「准备投递」状态：明确告诉用户松手会落到哪里 */}
          {dragging && visible.length > 0 && (
            <p className="cap-drop-hint is-live" role="status">
              {overId
                ? `松开鼠标即投递到「${visible.find((t) => t.id === overId)?.name ?? ""}」`
                : "把文件拖到目标卡片上"}
            </p>
          )}

          {visible.length > 0 && (
            <div
              className={`cap-drop-grid${dragging ? " is-dragging" : ""}`}
              role="list"
              aria-label="文件投递目标"
            >
              {visible.map((t, index) => (
                <DropCard
                  key={t.id}
                  target={t}
                  over={overId === t.id}
                  op={ops[t.id]}
                  dragging={dragging}
                  first={index === 0}
                  last={index === visible.length - 1}
                  confirming={confirmRemove === t.id}
                  onOpen={() => {
                    void openDir(t.id).catch((e) => flash(errorMessage(e)));
                  }}
                  onEdit={() => setEditing(t.id)}
                  onMove={(dir) => {
                    void move(t.id, dir).catch((e) => flash(errorMessage(e)));
                  }}
                  onAskRemove={() => setConfirmRemove(t.id)}
                  onCancelRemove={() => setConfirmRemove(null)}
                  onConfirmRemove={() => {
                    setConfirmRemove(null);
                    void remove(t.id)
                      .then(() => flash(`已移除「${t.name}」，目录与文件未改动`))
                      .catch((e) => flash(errorMessage(e)));
                  }}
                />
              ))}
            </div>
          )}

          {visible.length === 0 && targets.length > 0 && (
            <p className="cap-drop-hint">
              有 {targets.length} 个目标未勾选「在工具面板显示」，可在完整面板里开启。
            </p>
          )}

          {lastReport && (
            <div className={`cap-drop-result${lastReport.failed > 0 || lastReport.partial > 0 ? " is-warn" : ""}`}>
              <button
                type="button"
                className="cap-drop-result-head"
                aria-expanded={reportOpen}
                aria-controls="cap-drop-result-detail"
                onClick={() => setReportOpen((v) => !v)}
              >
                {lastReport.failed === 0 && lastReport.partial === 0 ? (
                  <Check size={13} strokeWidth={2.4} aria-hidden="true" />
                ) : (
                  <AlertTriangle size={13} strokeWidth={2.2} aria-hidden="true" />
                )}
                <span className="cap-drop-result-text">
                  {lastTargetName ? `${lastTargetName}：` : ""}成功 {lastReport.success} 项 · 跳过{" "}
                  {lastReport.skipped} 项
                  {lastReport.partial > 0 ? ` · 部分完成 ${lastReport.partial} 项` : ""}
                  {` · 失败 ${lastReport.failed} 项`}
                </span>
                <ChevronDown
                  size={12}
                  strokeWidth={2.2}
                  aria-hidden="true"
                  className={reportOpen ? "is-open" : undefined}
                />
              </button>
              {reportOpen && (
                <ul className="cap-drop-result-list" id="cap-drop-result-detail">
                  {pendingEntries.map((e, i) => (
                    <li key={`${e.source}-${i}`}>
                      <span className="cap-drop-result-name" title={e.source}>
                        <span className={`cap-drop-result-tag is-${e.status}`}>
                          {STATUS_LABEL[e.status] ?? e.status}
                        </span>
                        {e.display_name}
                      </span>
                      <span className="cap-drop-result-reason">{e.reason ?? STATUS_LABEL[e.status]}</span>
                      {e.residual_source && (
                        <span className="cap-drop-result-residual" title={e.residual_source}>
                          可能残留：{e.residual_source}
                        </span>
                      )}
                      {e.recovery && (
                        <span className="cap-drop-result-recovery">{e.recovery}</span>
                      )}
                    </li>
                  ))}
                  {pendingEntries.length === 0 && (
                    <li>
                      <span className="cap-drop-result-reason">
                        全部条目已完整写入目标目录。
                      </span>
                    </li>
                  )}
                </ul>
              )}
              {targetGone && (
                <p className="cap-drop-result-reason">
                  目标入口已移除；本次结果仍保留，失败的条目请到「{lastReport.target_path}」手工核对。
                </p>
              )}
              <div className="cap-drop-result-actions">
                {lastTarget ? (
                  <button
                    type="button"
                    className="cap-link"
                    onClick={() => {
                      void openDir(lastReport.target_id).catch((e) => flash(errorMessage(e)));
                    }}
                  >
                    打开目标文件夹
                  </button>
                ) : (
                  <span className="cap-drop-result-reason" title={lastReport.target_path}>
                    {lastReport.target_path}
                  </span>
                )}
                <button type="button" className="cap-link" onClick={() => clearReport(lastReport.target_id)}>
                  收起
                </button>
              </div>
            </div>
          )}

          {notice && (
            <p className="cap-drop-notice" role="status">
              {notice}
            </p>
          )}

          {/* 与投递互补：不用打开完整面板就能看到最近暂存并直接打开/复制 */}
          <InboxRecentShelf onNotice={flash} />
        </>
      )}
      </div>

      {/* 底栏固定在面板底部：列表状态给「添加目标 / 管理」；表单状态只给
          「保存 / 取消」，避免出现两套主操作或一个禁用的重复按钮。 */}
      <div className={`cap-drop-foot${editing !== null ? " is-form" : ""}`}>
        {editing !== null ? (
          <>
            <button
              type="submit"
              form={FORM_ID}
              className="cap-mini is-primary"
              disabled={formBusy}
            >
              {formBusy ? <Loader2 size={11} className="spin" aria-hidden="true" /> : null}
              {editing === "new" ? "添加目标" : "保存"}
            </button>
            <button
              type="button"
              className="cap-mini"
              disabled={formBusy}
              onClick={() => {
                setEditing(null);
                setFormBusy(false);
              }}
            >
              取消
            </button>
          </>
        ) : (
          <>
            <button type="button" className="cap-mini" onClick={() => setEditing("new")}>
              <Plus size={12} strokeWidth={2.4} aria-hidden="true" /> 添加目标
            </button>
            <button
              type="button"
              className="cap-link"
              onClick={() => {
                // 一次性意图必须绑定在导航事务上：切页被未保存草稿拦截/保存中
                // 拒绝时不能提前置位，否则之后进入暂存架会突然展开管理面板。
                openFullApp("shelf", () => requestManage());
              }}
            >
              管理
              <Folder size={12} strokeWidth={2.2} aria-hidden="true" />
            </button>
          </>
        )}
      </div>
    </>
  );
}

function DropCard({
  target,
  over,
  op,
  dragging,
  first,
  last,
  confirming,
  onOpen,
  onEdit,
  onMove,
  onAskRemove,
  onCancelRemove,
  onConfirmRemove,
}: {
  target: ShelfDropTarget;
  over: boolean;
  op?: { total: number };
  dragging: boolean;
  first: boolean;
  last: boolean;
  confirming: boolean;
  onOpen: () => void;
  onEdit: () => void;
  onMove: (dir: "up" | "down") => void;
  onAskRemove: () => void;
  onCancelRemove: () => void;
  onConfirmRemove: () => void;
}) {
  const modeLabel = target.op_mode === "move" ? "移动 · 删除源文件" : "复制 · 保留源文件";
  return (
    <div
      className={[
        "cap-drop-card",
        over ? "is-over" : "",
        op ? "is-busy" : "",
        target.available ? "" : "is-off",
        dragging && !over ? "is-idle" : "",
        confirming ? "is-confirming" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-drop-target={target.id}
      role="listitem"
    >
      <button
        type="button"
        className="cap-drop-main"
        aria-label={`打开「${target.name}」目录`}
        data-tip={target.path}
        onClick={onOpen}
      >
        <span className="cap-drop-icon" aria-hidden="true">
          <Folder size={15} strokeWidth={1.8} />
        </span>
        <span className="cap-drop-name" title={target.name}>
          {target.name}
        </span>
        <span className="cap-drop-path" title={target.path}>
          {shortPath(target.path)}
        </span>
      </button>

      <span className="cap-drop-meta">
        {op ? (
          <span className="cap-drop-busy" role="status">
            <Loader2 size={11} className="spin" aria-hidden="true" />
            {target.op_mode === "move" ? "正在移动" : "正在复制"} {op.total} 项
          </span>
        ) : !target.available ? (
          <span className="cap-drop-status is-bad">目录不可用</span>
        ) : (
          <span
            className={`cap-drop-status is-mode ${target.op_mode === "move" ? "is-warn" : ""}`}
            data-tip={target.op_mode === "move" ? "投递完成后删除源文件" : "保留源文件"}
          >
            {modeLabel}
          </span>
        )}
      </span>

      {/* 菜单在拖入开始时重置：展开的弹层不能挡住落点命中 */}
      {!confirming && (
        <DropdownMenu
          key={dragging ? "drag" : "idle"}
          menuLabel={`「${target.name}」操作`}
          placement="bottom-end"
          menuMinWidth={132}
          trigger={({ ref, onClick, onKeyDown, expanded }) => (
            <button
              ref={ref}
              type="button"
              className="cap-drop-more"
              aria-label={`「${target.name}」更多操作`}
              aria-expanded={expanded}
              data-tip="更多"
              onClick={onClick}
              onKeyDown={onKeyDown}
            >
              <MoreVertical size={13} strokeWidth={2.2} aria-hidden="true" />
            </button>
          )}
          items={[
            {
              key: "edit",
              label: "编辑",
              icon: <Pencil size={12} strokeWidth={2.2} aria-hidden="true" />,
              onSelect: onEdit,
            },
            {
              key: "up",
              label: "上移",
              icon: <ArrowUp size={12} strokeWidth={2.2} aria-hidden="true" />,
              disabled: first,
              onSelect: () => onMove("up"),
            },
            {
              key: "down",
              label: "下移",
              icon: <ArrowDown size={12} strokeWidth={2.2} aria-hidden="true" />,
              disabled: last,
              onSelect: () => onMove("down"),
            },
            {
              key: "remove",
              label: "移除入口（不删文件）",
              icon: <Trash2 size={12} strokeWidth={2.2} aria-hidden="true" />,
              danger: true,
              onSelect: onAskRemove,
            },
          ]}
        />
      )}

      {confirming && (
        <span className="cap-drop-confirm" role="group" aria-label={`移除「${target.name}」`}>
          <span className="cap-drop-confirm-text">移除入口？目录与文件不动</span>
          <span className="cap-drop-confirm-actions">
            <button type="button" className="cap-mini is-primary" onClick={onConfirmRemove}>
              移除
            </button>
            <button type="button" className="cap-mini" onClick={onCancelRemove}>
              取消
            </button>
          </span>
        </span>
      )}
    </div>
  );
}
