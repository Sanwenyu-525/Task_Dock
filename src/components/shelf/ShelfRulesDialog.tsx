//! 可选收集规则（P3）：默认关闭、可预览、可冲突提示。
//!
//! 只支持可逆动作（加标签 / 归组）；不提供自动移动、删除或下载。
//! 规则保存在设置键 `shelf_collect_rules`，结构与后端 `shelf::rules` 一致。

import { useEffect, useMemo, useState } from "react";
import { Eye, Loader2, Play, Plus, Trash2 } from "lucide-react";
import {
  getSettings,
  shelfRulesApply,
  shelfRulesPreview,
  updateSettings,
  type ShelfRule,
  type ShelfRuleApplyReport,
  type ShelfRulePreview,
  type ShelfRuleSet,
} from "../../lib/bridge";
import { errorMessage } from "../../lib/errors";
import { logEvent, startOperation } from "../../lib/diagnostics";
import { useShelfStore } from "../../store/useShelfStore";
import { useUiStore } from "../../store/useUiStore";
import { Dialog } from "../ui/Dialog";
import Select from "../ui/Select";

const EMPTY_SET: ShelfRuleSet = { version: 1, rules: [] };

export function splitCsv(raw: string): string[] {
  return raw
    .split(/[,，\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function newRule(index: number): ShelfRule {
  return {
    id: `rule-${Date.now()}-${index}`,
    name: `规则 ${index}`,
    enabled: false,
    priority: 100,
    match: { exts: [], name_contains: "" },
    action: { type: "add_tag", value: "" },
  };
}

/** 客户端预检：空匹配或空动作值不提交，避免后端报错打断编辑。 */
export function ruleIssue(rule: ShelfRule): string | null {
  const exts = rule.match.exts ?? [];
  const keyword = (rule.match.name_contains ?? "").trim();
  if (exts.length === 0 && keyword.length === 0) return "至少填写后缀或名称关键词";
  if (!rule.action.value.trim()) return "动作值不能为空";
  if (rule.action.type === "add_tag" && splitCsv(rule.action.value).length !== 1)
    return "加标签只接受单个标签";
  return null;
}

export interface ShelfRulesDialogProps {
  open: boolean;
  onClose: () => void;
}

export default function ShelfRulesDialog({ open, onClose }: ShelfRulesDialogProps) {
  const showToast = useUiStore((s) => s.showToast);
  const groups = useShelfStore((s) => s.groups);
  const refreshMeta = useShelfStore((s) => s.refreshMeta);
  const [draft, setDraft] = useState<ShelfRuleSet>(EMPTY_SET);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<"save" | "preview" | "apply" | null>(null);
  const [preview, setPreview] = useState<ShelfRulePreview | null>(null);
  const [applied, setApplied] = useState<ShelfRuleApplyReport | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setPreview(null);
    setApplied(null);
    setError("");
    setLoaded(false);
    let alive = true;
    getSettings()
      .then((s) => {
        if (!alive) return;
        const raw = s.shelf_collect_rules;
        setDraft(
          raw && Array.isArray(raw.rules)
            ? { version: 1, rules: raw.rules.map((r) => ({ ...r, match: { ...r.match } })) }
            : EMPTY_SET,
        );
        setLoaded(true);
      })
      .catch((e) => {
        if (!alive) return;
        setError(errorMessage(e));
        setLoaded(true);
      });
    void refreshMeta().catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const enabledCount = draft.rules.filter((r) => r.enabled).length;
  const issues = useMemo(
    () =>
      draft.rules
        .filter((r) => r.enabled)
        .map((r) => ({ rule: r, issue: ruleIssue(r) }))
        .filter((x): x is { rule: ShelfRule; issue: string } => x.issue !== null),
    [draft.rules],
  );

  const patchRule = (id: string, patch: Partial<ShelfRule>) => {
    setDraft((d) => ({
      ...d,
      rules: d.rules.map((r) => (r.id === id ? { ...r, ...patch } : r)),
    }));
    setPreview(null);
    setApplied(null);
  };

  const validateBeforeWrite = (): boolean => {
    if (issues.length > 0) {
      setError(`有 ${issues.length} 条启用规则不完整：${issues[0].issue}`);
      return false;
    }
    setError("");
    return true;
  };

  const save = async (): Promise<boolean> => {
    if (!validateBeforeWrite()) return false;
    setBusy("save");
    try {
      await updateSettings({ shelf_collect_rules: draft });
      logEvent({
        level: "INFO",
        module: "shelf",
        action: "shelf_rules_saved",
        event: "shelf_rules_saved",
        status: "success",
        metadata: { rules: draft.rules.length, enabled: enabledCount },
      });
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const runPreview = async () => {
    if (!validateBeforeWrite()) return;
    setBusy("preview");
    try {
      setPreview(await shelfRulesPreview(draft));
      setApplied(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const runApply = async () => {
    if (!validateBeforeWrite()) return;
    const op = startOperation("shelf", "shelf_rules_apply", {
      metadata: { rules: enabledCount },
    });
    setBusy("apply");
    try {
      if (!(await save())) {
        op.fail({ code: "SHELF_RULES_SAVE_FAILED", category: "validation" });
        return;
      }
      const report = await shelfRulesApply();
      setApplied(report);
      setPreview(null);
      op.success({
        metadata: {
          applied: report.applied,
          tagged: report.tagged,
          grouped: report.grouped,
          skipped: report.skipped,
        },
      });
      showToast(
        `规则已应用：${report.applied} 项（标签 ${report.tagged}、归组 ${report.grouped}）`,
        { kind: report.skipped > 0 ? "warning" : "success" },
      );
    } catch (e) {
      op.fail(e);
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="收集规则"
      size="lg"
      ariaLabel="暂存架收集规则"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy !== null}>
            关闭
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => void runPreview()}
            disabled={!loaded || busy !== null}
          >
            <Eye size={14} aria-hidden="true" /> 预览匹配
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => void save().then((ok) => ok && showToast("收集规则已保存", { kind: "success" }))}
            disabled={!loaded || busy !== null}
          >
            保存规则
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={() => void runApply()}
            disabled={!loaded || busy !== null || enabledCount === 0}
          >
            {busy === "apply" ? (
              <Loader2 size={14} className="spin" aria-hidden="true" />
            ) : (
              <Play size={14} aria-hidden="true" />
            )}
            保存并应用
          </button>
        </>
      }
    >
      <div className="shelf-rules">
        <p className="shelf-batch-link-hint">
          规则默认关闭；只支持「加标签 / 归组」两类可逆动作，不会移动或删除原文件，
          也不会自动下载远程内容。应用是针对最近 300 条与当前暂存架的显式操作。
        </p>
        {error && (
          <p className="shelf-links-status is-error" role="alert">
            {error}
          </p>
        )}
        {draft.rules.length === 0 && loaded && (
          <p className="shelf-links-empty">还没有规则。新建后需要启用并保存才会生效。</p>
        )}
        <ul className="shelf-rule-list">
          {draft.rules.map((rule) => {
            const groupOptions = groups
              .filter((g) => g.id !== "shelf-default")
              .map((g) => ({ value: g.id, label: g.name }));
            return (
              <li key={rule.id} className="shelf-rule-card">
                <div className="shelf-rule-head">
                  <label className="shelf-rule-enable">
                    <input
                      type="checkbox"
                      checked={rule.enabled}
                      aria-label={`启用规则 ${rule.name}`}
                      onChange={(e) => patchRule(rule.id, { enabled: e.target.checked })}
                    />
                    启用
                  </label>
                  <input
                    className="input"
                    value={rule.name}
                    aria-label={`规则名称 ${rule.name}`}
                    onChange={(e) => patchRule(rule.id, { name: e.target.value })}
                  />
                  <input
                    className="input shelf-rule-priority"
                    type="number"
                    min={0}
                    max={1000}
                    value={rule.priority}
                    aria-label={`优先级 ${rule.name}`}
                    data-tip="数值越小越优先"
                    onChange={(e) =>
                      patchRule(rule.id, { priority: Number(e.target.value) || 0 })
                    }
                  />
                  <button
                    type="button"
                    className="icon-btn sm danger"
                    aria-label={`删除规则 ${rule.name}`}
                    data-tip="删除规则"
                    onClick={() =>
                      setDraft((d) => ({
                        ...d,
                        rules: d.rules.filter((r) => r.id !== rule.id),
                      }))
                    }
                  >
                    <Trash2 size={13} aria-hidden="true" />
                  </button>
                </div>
                <div className="shelf-rule-body">
                  <label className="shelf-rule-field">
                    <span>后缀</span>
                    <input
                      className="input"
                      value={(rule.match.exts ?? []).join(", ")}
                      placeholder="pdf, png"
                      aria-label={`后缀条件 ${rule.name}`}
                      onChange={(e) =>
                        patchRule(rule.id, {
                          match: { ...rule.match, exts: splitCsv(e.target.value) },
                        })
                      }
                    />
                  </label>
                  <label className="shelf-rule-field">
                    <span>名称包含</span>
                    <input
                      className="input"
                      value={rule.match.name_contains ?? ""}
                      placeholder="可选"
                      aria-label={`名称条件 ${rule.name}`}
                      onChange={(e) =>
                        patchRule(rule.id, {
                          match: { ...rule.match, name_contains: e.target.value },
                        })
                      }
                    />
                  </label>
                  <label className="shelf-rule-field">
                    <span>动作</span>
                    <Select
                      value={rule.action.type}
                      options={[
                        { value: "add_tag", label: "添加标签" },
                        { value: "assign_group", label: "归入分组" },
                      ]}
                      onChange={(v) =>
                        patchRule(rule.id, {
                          action: { type: v as ShelfRule["action"]["type"], value: "" },
                        })
                      }
                      ariaLabel={`动作类型 ${rule.name}`}
                      size="sm"
                      align="start"
                      menuMinWidth={140}
                    />
                  </label>
                  <label className="shelf-rule-field">
                    <span>{rule.action.type === "add_tag" ? "标签" : "分组"}</span>
                    {rule.action.type === "add_tag" ? (
                      <input
                        className="input"
                        value={rule.action.value}
                        placeholder="文档"
                        aria-label={`动作值 ${rule.name}`}
                        onChange={(e) =>
                          patchRule(rule.id, {
                            action: { type: "add_tag", value: e.target.value },
                          })
                        }
                      />
                    ) : (
                      <Select
                        value={rule.action.value}
                        options={groupOptions}
                        onChange={(v) =>
                          patchRule(rule.id, {
                            action: { type: "assign_group", value: v },
                          })
                        }
                        placeholder="选择分组"
                        ariaLabel={`目标分组 ${rule.name}`}
                        size="sm"
                        align="start"
                        menuMinWidth={160}
                      />
                    )}
                  </label>
                </div>
                {ruleIssue(rule) && rule.enabled && (
                  <p className="shelf-links-status is-error">{ruleIssue(rule)}</p>
                )}
              </li>
            );
          })}
        </ul>
        <button
          type="button"
          className="btn sm"
          onClick={() =>
            setDraft((d) => ({ ...d, rules: [...d.rules, newRule(d.rules.length + 1)] }))
          }
        >
          <Plus size={13} aria-hidden="true" /> 新建规则
        </button>

        {preview && (
          <section className="shelf-rule-result" aria-label="规则预览结果">
            <h4>预览结果</h4>
            <p>
              已评估 {preview.evaluated_items} 项，命中 {preview.matched_items} 项。
              预览不会写入任何数据。
            </p>
            {preview.matches.length === 0 && <p className="shelf-links-empty">没有条目命中</p>}
            {preview.matches.length > 0 && (
              <ul className="shelf-rule-matches">
                {preview.matches.slice(0, 20).map((m) => (
                  <li key={`${m.rule_id}-${m.item_id}`}>
                    <span className="shelf-dedup-name">{m.item_name}</span>
                    <span className="shelf-dedup-meta">
                      ← {m.rule_name}（{m.action_type === "add_tag" ? `标签 ${m.action_value}` : `归组 ${m.action_value}`}）
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {preview.conflicts.length > 0 && (
              <p className="shelf-links-status is-error">
                {preview.conflicts.length} 项同时命中多条规则：应用时每种动作只取优先级最高的一条。
              </p>
            )}
            {preview.truncated && (
              <p className="shelf-links-status">命中过多，仅展示前 20 条。</p>
            )}
          </section>
        )}

        {applied && (
          <section className="shelf-rule-result" aria-label="规则应用结果">
            <h4>应用结果</h4>
            <p>
              应用 {applied.applied} 项（标签 {applied.tagged}、归组 {applied.grouped}），
              跳过 {applied.skipped} 项。
            </p>
            <ul className="shelf-rule-matches">
              {applied.entries.slice(0, 20).map((e, i) => (
                <li key={`${e.rule_id}-${e.item_id}-${i}`}>
                  <span className="shelf-dedup-name">{e.item_name}</span>
                  <span className="shelf-dedup-meta">
                    {e.applied ? "已应用" : `跳过：${e.reason ?? "未变化"}`}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </Dialog>
  );
}
