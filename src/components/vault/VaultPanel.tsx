//! 安全保险箱完整面板（P1）。
//!
//! 安全边界：本文件不接触 DEK/主密码明文；主密码只从输入框直接进 IPC。
//! 锁定事件到达时清空 Store（列表、详情、搜索结果）并回到锁屏。

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";
import {
  AlertTriangle,
  Check,
  ClipboardCopy,
  Clock3,
  Eye,
  EyeOff,
  FileKey2,
  Fingerprint,
  KeyRound,
  Loader2,
  Lock,
  LockKeyhole,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  Upload,
  Download,
  X,
} from "lucide-react";

import { ConfirmDialog, Dialog, EmptyState, Select, Switch } from "../ui";
import { errorMessage } from "../../lib/errors";
import { useWorkbenchPageActive } from "../../lib/windowHost";
import {
  vaultApi,
  type VaultCategory,
  type VaultLockSettings,
  type VaultRecordDetail,
  type VaultRecordDraft,
  type VaultRecordType,
  type VaultSecretField,
  type VaultStrength,
} from "../../lib/vault";
import { useVaultStore } from "../../store/useVaultStore";
import "./vault-ui.css";

const TYPE_OPTIONS: Array<{ value: VaultRecordType; label: string }> = [
  { value: "password", label: "账号密码" },
  { value: "api_key", label: "API 密钥" },
  { value: "license", label: "软件许可证" },
  { value: "recovery", label: "账户恢复资料" },
  { value: "memo", label: "私密备忘" },
  { value: "device", label: "设备凭据" },
  { value: "ssh", label: "SSH 私钥" },
];

const TYPE_LABEL = Object.fromEntries(TYPE_OPTIONS.map((t) => [t.value, t.label])) as Record<
  VaultRecordType,
  string
>;

const DEFAULT_FIELDS: Record<VaultRecordType, VaultSecretField[]> = {
  password: [
    { id: "password", label: "密码", kind: "password", encoding: "utf8", value: "" },
  ],
  api_key: [
    { id: "api_key", label: "API Key", kind: "password", encoding: "utf8", value: "" },
    { id: "secret_key", label: "Secret Key", kind: "password", encoding: "utf8", value: "" },
    { id: "access_token", label: "Access Token", kind: "password", encoding: "utf8", value: "" },
    { id: "refresh_token", label: "Refresh Token", kind: "password", encoding: "utf8", value: "" },
  ],
  license: [
    { id: "license_key", label: "许可证密钥", kind: "password", encoding: "utf8", value: "" },
    { id: "activation_code", label: "激活码", kind: "password", encoding: "utf8", value: "" },
    { id: "expires_on", label: "到期日期", kind: "date", encoding: "utf8", value: "" },
  ],
  recovery: [
    {
      id: "recovery_codes",
      label: "双重验证恢复码",
      kind: "multiline",
      encoding: "utf8",
      value: "",
    },
    { id: "backup_email", label: "备用邮箱", kind: "text", encoding: "utf8", value: "" },
    { id: "recovery_phone", label: "恢复电话", kind: "text", encoding: "utf8", value: "" },
    {
      id: "instructions",
      label: "恢复说明",
      kind: "multiline",
      encoding: "utf8",
      value: "",
    },
  ],
  memo: [
    { id: "memo", label: "私密内容", kind: "multiline", encoding: "utf8", value: "" },
  ],
  device: [
    { id: "host", label: "管理地址", kind: "text", encoding: "utf8", value: "" },
    { id: "username", label: "用户名", kind: "text", encoding: "utf8", value: "" },
    { id: "password", label: "密码", kind: "password", encoding: "utf8", value: "" },
  ],
  ssh: [
    {
      id: "private_key",
      label: "私钥（PEM/OpenSSH 原文）",
      kind: "multiline",
      encoding: "utf8",
      value: "",
    },
    { id: "passphrase", label: "口令", kind: "password", encoding: "utf8", value: "" },
    {
      id: "public_key",
      label: "公钥",
      kind: "multiline",
      encoding: "utf8",
      value: "",
    },
  ],
};

function formatDate(value?: string): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function mask(value: string): string {
  const len = Math.min(Math.max(value.length, 8), 48);
  return "•".repeat(len);
}

function newId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

export default function VaultPanel() {
  const status = useVaultStore((s) => s.status);
  const refreshAll = useVaultStore((s) => s.refreshAll);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  // 锁定/状态事件由 `useVaultStore` 的模块级订阅统一处理（面板卸载后仍然生效：
  // 否则离开页面时锁定，store 里的明文详情不会被清空）。这里只负责首次加载。

  if (!status) {
    return (
      <div className="vault-shell vault-centered">
        <Loader2 className="spin" size={20} />
        <span>正在读取保险箱状态…</span>
      </div>
    );
  }

  if (status.state === "noVault") {
    return <VaultOnboarding startupError={status.startupError} />;
  }

  if (!status.unlocked && status.state !== "recovery") {
    return <VaultLockScreen startupError={status.startupError} />;
  }

  return <VaultHome recoveryMode={status.recoveryMode} />;
}

// ── 建库 ─────────────────────────────────────────────────────

function VaultOnboarding({ startupError }: { startupError?: string }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [strength, setStrength] = useState<VaultStrength | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{
    recoveryGroups: string[];
    recoveryCode: string;
    vaultId: string;
  } | null>(null);
  const [acked, setAcked] = useState(false);

  useEffect(() => {
    if (!password) {
      setStrength(null);
      return;
    }
    const timer = window.setTimeout(() => {
      void vaultApi.evaluateStrength(password).then(setStrength).catch(() => setStrength(null));
    }, 300);
    return () => window.clearTimeout(timer);
  }, [password]);

  async function create(event: FormEvent) {
    event.preventDefault();
    if (password !== confirm) {
      setError("两次输入的主密码不一致");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await vaultApi.create(password);
      setCreated({
        recoveryGroups: result.recoveryGroups,
        recoveryCode: result.recoveryCode,
        vaultId: result.vaultId,
      });
      setPassword("");
      setConfirm("");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function finish() {
    if (!acked) return;
    setBusy(true);
    try {
      await vaultApi.confirmRecovery(true);
      await useVaultStore.getState().refreshAll();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  if (created) {
    return (
      <div className="vault-shell vault-onboarding">
        <div className="vault-onboarding-card">
          <div className="vault-seal">
            <ShieldCheck size={26} />
          </div>
          <h1>恢复密钥已生成</h1>
          <p className="vault-muted">
            这是<strong>唯一</strong>能在主密码丢失时恢复数据的凭据。它只显示这一次，不会写入磁盘，
            也不会进入日志。请抄写到离线介质并妥善保管。
          </p>
          <div className="vault-recovery-grid" aria-label="恢复密钥">
            {created.recoveryGroups.map((group, index) => (
              <span key={`${group}-${index}`} className="vault-recovery-group">
                <em>{index + 1}</em>
                {group}
              </span>
            ))}
          </div>
          <div className="vault-recovery-actions">
            <button
              type="button"
              className="btn ghost"
              onClick={() => void navigator.clipboard.writeText(created.recoveryCode)}
            >
              <ClipboardCopy size={15} /> 复制完整密钥
            </button>
            <span className="vault-warn">
              <AlertTriangle size={14} /> 剪贴板可能被其他程序读取，抄写后请立即清空
            </span>
          </div>
          <label className="vault-check">
            <input
              type="checkbox"
              checked={acked}
              onChange={(event) => setAcked(event.target.checked)}
            />
            我已抄写恢复密钥，并理解丢失后数据不可恢复
          </label>
          {error ? <div className="vault-error">{error}</div> : null}
          <button
            type="button"
            className="btn primary vault-wide"
            disabled={!acked || busy}
            onClick={() => void finish()}
          >
            {busy ? <Loader2 size={15} className="spin" /> : <Check size={15} />}
            进入安全保险箱
          </button>
          <details className="vault-details">
            <summary>技术细节</summary>
            <p>
              保险箱 ID：<code>{created.vaultId}</code>
              <br />
              加密：AES-256-GCM；主密码派生：Argon2id（64 MiB / 3 次 / 1 并行）。
            </p>
          </details>
        </div>
      </div>
    );
  }

  return (
    <div className="vault-shell vault-onboarding">
      <div className="vault-onboarding-card">
        <div className="vault-seal">
          <LockKeyhole size={26} />
        </div>
        <h1>创建安全保险箱</h1>
        <p className="vault-muted">
          Task Dock 会为保险箱创建<strong>独立加密数据库</strong>，与普通任务、笔记、剪贴板数据完全隔离。
          主密码和恢复密钥不会上传，也不会进入 Agent / MCP / CLI。
        </p>
        {startupError ? (
          <div className="vault-error">
            上次打开保险箱失败：{startupError}。请检查数据目录后重试。
          </div>
        ) : null}
        <form onSubmit={create} className="vault-form">
          <label className="vault-label">
            主密码（8–128 字符）
            <input
              className="input"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoFocus
            />
          </label>
          <label className="vault-label">
            再次输入
            <input
              className="input"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
            />
          </label>
          {strength ? (
            <div className={`vault-strength level-${strength.level}`}>
              <span>强度：{strength.level === "weak" ? "弱" : strength.level === "fair" ? "一般" : strength.level === "good" ? "良好" : "强"}</span>
              <span className="vault-strength-track">
                <i style={{ width: `${Math.max(6, strength.score)}%` }} />
              </span>
              <span>{strength.score}/100</span>
            </div>
          ) : null}
          {error ? <div className="vault-error">{error}</div> : null}
          <button type="submit" className="btn primary vault-wide" disabled={busy}>
            {busy ? <Loader2 size={15} className="spin" /> : <ShieldCheck size={15} />}
            创建并生成恢复密钥
          </button>
        </form>
        <p className="vault-footnote">
          主密码忘记且恢复密钥丢失时，数据<strong>无法恢复</strong>。Task Dock 不提供绕过加密的后台重置。
        </p>
      </div>
    </div>
  );
}

// ── 解锁 ─────────────────────────────────────────────────────

function VaultLockScreen({ startupError }: { startupError?: string }) {
  const lastLockReason = useVaultStore((s) => s.status?.lastLockReason);
  const [mode, setMode] = useState<"password" | "recovery">("password");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function unlock(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await vaultApi.unlock(mode, value);
      setValue("");
      await useVaultStore.getState().refreshAll();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="vault-shell vault-locked">
      <div className="vault-lock-card">
        <div className="vault-lock-icon">
          <Lock size={28} />
        </div>
        <h1>安全保险箱已锁定</h1>
        <p className="vault-muted">
          {mode === "password"
            ? "输入主密码解锁。闲置或进入后台后会自动锁定。"
            : "恢复密钥适合主密码丢失时使用。解锁后只能查看，必须先设置新的主密码。"}
        </p>
        <div className="vault-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "password"}
            className={mode === "password" ? "active" : ""}
            onClick={() => {
              setMode("password");
              setValue("");
              setError(null);
            }}
          >
            主密码
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "recovery"}
            className={mode === "recovery" ? "active" : ""}
            onClick={() => {
              setMode("recovery");
              setValue("");
              setError(null);
            }}
          >
            恢复密钥
          </button>
        </div>
        {startupError ? <div className="vault-error">启动检查：{startupError}</div> : null}
        {lastLockReason === "crash" ? (
          <div className="vault-banner warning">
            <AlertTriangle size={15} />
            上次进程未正常锁定即退出，本次启动已按崩溃场景保持锁定。
          </div>
        ) : null}
        <form onSubmit={unlock} className="vault-form">
          {mode === "password" ? (
            <input
              className="input vault-unlock-input"
              type="password"
              autoComplete="current-password"
              placeholder="主密码"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              autoFocus
            />
          ) : (
            <textarea
              className="input vault-unlock-input vault-recovery-input"
              placeholder="8 组 4 字符，例如 ABCD-EFGH-…"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              rows={3}
            />
          )}
          {error ? <div className="vault-error">{error}</div> : null}
          <button type="submit" className="btn primary vault-wide" disabled={busy || !value.trim()}>
            {busy ? <Loader2 size={15} className="spin" /> : <KeyRound size={15} />}
            解锁
          </button>
        </form>
        <p className="vault-footnote">
          连续输错会短暂冷却；冷却时间随失败次数增加。冷却只能阻止应用内尝试，不能阻止离线攻击。
        </p>
      </div>
    </div>
  );
}

// ── 主界面 ───────────────────────────────────────────────────

function VaultHome({ recoveryMode }: { recoveryMode: boolean }) {
  const status = useVaultStore((s) => s.status);
  const items = useVaultStore((s) => s.items);
  const categories = useVaultStore((s) => s.categories);
  const tags = useVaultStore((s) => s.tags);
  const detail = useVaultStore((s) => s.detail);
  const filter = useVaultStore((s) => s.filter);
  const query = useVaultStore((s) => s.query);
  const loading = useVaultStore((s) => s.loading);
  const error = useVaultStore((s) => s.error);
  const lastCopied = useVaultStore((s) => s.lastCopied);
  const settings = useVaultStore((s) => s.settings);
  const setFilter = useVaultStore((s) => s.setFilter);
  const setQuery = useVaultStore((s) => s.setQuery);
  const selectRecord = useVaultStore((s) => s.selectRecord);
  const clearDetail = useVaultStore((s) => s.clearDetail);
  const toggleFieldReveal = useVaultStore((s) => s.toggleFieldReveal);
  const copyField = useVaultStore((s) => s.copyField);
  const clearClipboard = useVaultStore((s) => s.clearClipboard);
  const toggleFavorite = useVaultStore((s) => s.toggleFavorite);
  const deleteRecord = useVaultStore((s) => s.deleteRecord);
  const lock = useVaultStore((s) => s.lock);

  const [editor, setEditor] = useState<{ mode: "create" } | { mode: "edit"; detail: VaultRecordDetail } | null>(
    null,
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [recoverySetup, setRecoverySetup] = useState(recoveryMode);
  const [notice, setNotice] = useState<string | null>(null);
  const [remaining, setRemaining] = useState(0);
  const pageActive = useWorkbenchPageActive();

  // 敏感字段展开后按 revealSecs 自动收起；设置为 0 时后端已归一为 30 秒。
  const revealedKey = useMemo(
    () =>
      detail
        ? detail.fields
            .filter((field) => field.revealed)
            .map((field) => field.id)
            .join("|")
        : "",
    [detail],
  );

  useEffect(() => {
    if (!detail || !revealedKey) return;
    const secs = Math.max(1, settings?.revealSecs ?? 30);
    const timer = window.setTimeout(() => {
      const current = useVaultStore.getState().detail;
      if (current?.id === detail.id) {
        void selectRecord(detail.id, []);
      }
    }, secs * 1000);
    return () => window.clearTimeout(timer);
  }, [detail, revealedKey, settings?.revealSecs, selectRecord]);

  // 页面切走后不在 Store/DOM 里保留已展开的详情；返回时需要重新选择记录。
  useEffect(() => {
    if (pageActive === false) clearDetail();
  }, [pageActive, clearDetail]);

  useEffect(() => {
    if (!lastCopied) {
      setRemaining(0);
      return;
    }
    setRemaining(lastCopied.clearedAfterSecs);
    const timer = window.setInterval(() => {
      setRemaining((value) => Math.max(0, value - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [lastCopied]);

  const typeFilters = useMemo(
    () =>
      TYPE_OPTIONS.map((option) => ({
        ...option,
        count: items.filter((item) => item.type === option.value).length,
      })),
    [items],
  );

  const copy = useCallback(
    async (recordId: string, fieldId: string) => {
      try {
        await copyField(recordId, fieldId);
        setNotice("已复制到剪贴板，到期后自动清除");
      } catch (e) {
        setNotice(errorMessage(e));
      }
    },
    [copyField],
  );

  return (
    <div className="vault-shell vault-home">
      <header className="vault-topbar">
        <div className="vault-brand">
          <span className="vault-brand-mark">
            <ShieldCheck size={18} />
          </span>
          <div>
            <h1>安全保险箱</h1>
            <span className="vault-muted">
              {status?.recordCount ?? items.length} 条记录 · 独立加密库
            </span>
          </div>
        </div>
        <div className="vault-topbar-actions">
          <div className="vault-search">
            <Search size={15} />
            <input
              className="input"
              placeholder="搜索标题、账号、网址、备注…"
              value={query}
              onChange={(event) => void setQuery(event.target.value)}
              aria-label="搜索保险箱"
            />
            {query ? (
              <button type="button" className="icon-btn sm" onClick={() => void setQuery("")}>
                <X size={13} />
              </button>
            ) : null}
          </div>
          <button
            type="button"
            className="btn primary"
            onClick={() => setEditor({ mode: "create" })}
            disabled={recoveryMode}
            data-tip="新建记录"
          >
            <Plus size={15} /> 新建
          </button>
          <button type="button" className="btn ghost" onClick={() => setSettingsOpen(true)}>
            <ShieldCheck size={15} /> 安全设置
          </button>
          <button type="button" className="btn ghost" onClick={() => void lock()}>
            <Lock size={15} /> 锁定
          </button>
        </div>
      </header>

      {recoveryMode ? (
        <div className="vault-banner warning">
          <Fingerprint size={16} />
          <span>恢复模式：当前可以查看全部记录，但写入操作已禁用。请先设置新的主密码。</span>
          <button type="button" className="btn sm primary" onClick={() => setRecoverySetup(true)}>
            设置新主密码
          </button>
        </div>
      ) : null}

      {lastCopied ? (
        <div className="vault-banner info">
          <Clock3 size={15} />
          <span>
            剪贴板将在 <strong>{remaining}</strong> 秒后自动清除。若期间复制了其他内容，Task Dock
            不会覆盖它。
          </span>
          <button
            type="button"
            className="btn sm ghost"
            onClick={() => {
              void clearClipboard();
              setNotice("已请求清除；若内容已被替换则不会写入");
            }}
          >
            立即清除
          </button>
        </div>
      ) : null}

      {error ? <div className="vault-banner danger">{error}</div> : null}
      {notice ? (
        <div className="vault-banner info" onAnimationEnd={() => setNotice(null)}>
          {notice}
        </div>
      ) : null}

      <div className="vault-body">
        <aside className="vault-rail">
          <nav aria-label="保险箱筛选">
            <button
              type="button"
              className={filter.kind === "all" ? "vault-filter active" : "vault-filter"}
              onClick={() => void setFilter({ kind: "all" })}
            >
              <LockKeyhole size={15} /> 全部记录 <span>{items.length}</span>
            </button>
            <button
              type="button"
              className={filter.kind === "favorite" ? "vault-filter active" : "vault-filter"}
              onClick={() => void setFilter({ kind: "favorite" })}
            >
              <Check size={15} /> 收藏
            </button>
            {TYPE_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={
                  filter.kind === "type" && filter.value === option.value
                    ? "vault-filter active"
                    : "vault-filter"
                }
                onClick={() => void setFilter({ kind: "type", value: option.value })}
              >
                <FileKey2 size={15} /> {option.label}
                <span>{typeFilters.find((f) => f.value === option.value)?.count ?? 0}</span>
              </button>
            ))}
          </nav>
          <CategoryRail
            title="自定义分类"
            rows={categories}
            active={filter.kind === "category" ? filter.value : undefined}
            onSelect={(id) => void setFilter({ kind: "category", value: id })}
          />
          <CategoryRail
            title="标签"
            rows={tags}
            active={filter.kind === "tag" ? filter.value : undefined}
            onSelect={(id) => void setFilter({ kind: "tag", value: id })}
          />
        </aside>

        <main className="vault-list" aria-busy={loading}>
          {loading ? <div className="vault-list-loading"><Loader2 className="spin" size={18} /></div> : null}
          {!loading && items.length === 0 ? (
            <EmptyState
              icon={<ShieldCheck size={26} />}
              title={query ? "没有匹配的记录" : "还没有记录"}
              hint={
                query
                  ? "搜索只匹配标题、账号、网址、备注和标签名，不读取加密字段值。"
                  : "新建第一条记录，保存账号、密钥或恢复资料。"
              }
            />
          ) : null}
          {items.map((item) => (
            <div
              key={item.id}
              role="button"
              tabIndex={0}
              className={detail?.id === item.id ? "vault-item active" : "vault-item"}
              onClick={() => void selectRecord(item.id)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  void selectRecord(item.id);
                }
              }}
            >
              <span className="vault-item-icon">
                {item.type === "license" ? <FileKey2 size={17} /> : item.type === "api_key" ? <KeyRound size={17} /> : <LockKeyhole size={17} />}
              </span>
              <span className="vault-item-main">
                <strong>{item.title}</strong>
                <span className="vault-muted">
                  {item.username || item.url || item.platform || TYPE_LABEL[item.type]}
                </span>
              </span>
              <span className="vault-item-side">
                <span className="vault-type">{TYPE_LABEL[item.type]}</span>
                {item.tagNames.map((tag) => (
                  <span key={tag} className="vault-tag">{tag}</span>
                ))}
              </span>
              <button
                type="button"
                className="icon-btn sm vault-star"
                aria-label={item.favorite ? "取消收藏" : "收藏"}
                onClick={(event) => {
                  event.stopPropagation();
                  void toggleFavorite(item.id);
                }}
              >
                <Check size={13} className={item.favorite ? "vault-star-on" : "vault-star-off"} />
              </button>
            </div>
          ))}
        </main>

        <aside className="vault-detail" aria-label="记录详情">
          {!detail ? (
            <div className="vault-detail-empty">
              <Lock size={22} />
              <p>选择一条记录查看详情</p>
              <span>敏感字段默认隐藏，需要主动展开。</span>
            </div>
          ) : (
            <article>
              <header>
                <div>
                  <span className="vault-type">{TYPE_LABEL[detail.type]}</span>
                  <h2>{detail.title}</h2>
                </div>
                <div className="vault-detail-actions">
                  <button
                    type="button"
                    className="icon-btn sm"
                    aria-label="编辑"
                    onClick={async () => {
                      try {
                        const full = await vaultApi.getRecord(
                          detail.id,
                          detail.fields.map((field) => field.id),
                        );
                        setEditor({ mode: "edit", detail: full });
                      } catch (e) {
                        setNotice(errorMessage(e));
                      }
                    }}
                    disabled={recoveryMode}
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    type="button"
                    className="icon-btn sm"
                    aria-label="删除"
                    onClick={() => setConfirmDelete(detail.id)}
                    disabled={recoveryMode}
                  >
                    <Trash2 size={14} />
                  </button>
                  <button type="button" className="icon-btn sm" aria-label="关闭详情" onClick={clearDetail}>
                    <X size={14} />
                  </button>
                </div>
              </header>
              <dl className="vault-meta">
                {detail.username ? (
                  <>
                    <dt>用户名</dt>
                    <dd>
                      {detail.username}
                      <button
                        type="button"
                        className="icon-btn sm"
                        aria-label="复制用户名"
                        onClick={() => {
                          void navigator.clipboard.writeText(detail.username);
                          setNotice("已复制用户名");
                        }}
                      >
                        <ClipboardCopy size={13} />
                      </button>
                    </dd>
                  </>
                ) : null}
                {detail.email ? (
                  <>
                    <dt>邮箱</dt>
                    <dd>{detail.email}</dd>
                  </>
                ) : null}
                {detail.url ? (
                  <>
                    <dt>登录地址</dt>
                    <dd className="vault-url">{detail.url}</dd>
                  </>
                ) : null}
                {detail.platform ? (
                  <>
                    <dt>所属平台</dt>
                    <dd>{detail.platform}</dd>
                  </>
                ) : null}
                {detail.categoryName ? (
                  <>
                    <dt>分类</dt>
                    <dd>{detail.categoryName}</dd>
                  </>
                ) : null}
                <dt>最近使用</dt>
                <dd>{formatDate(detail.lastUsedAt)}</dd>
                <dt>更新时间</dt>
                <dd>{formatDate(detail.updatedAt)}</dd>
              </dl>

              {detail.fields.length ? (
                <section className="vault-fields">
                  {detail.fields.map((field) => (
                    <div key={field.id} className="vault-field">
                      <div className="vault-field-head">
                        <span>{field.label}</span>
                        <span className="vault-field-actions">
                          <button
                            type="button"
                            className="icon-btn sm"
                            aria-label={field.revealed ? "隐藏字段" : "显示字段"}
                            onClick={() => void toggleFieldReveal(field.id)}
                          >
                            {field.revealed ? <EyeOff size={14} /> : <Eye size={14} />}
                          </button>
                          <button
                            type="button"
                            className="icon-btn sm"
                            aria-label="复制字段"
                            onClick={() => void copy(detail.id, field.id)}
                          >
                            <ClipboardCopy size={14} />
                          </button>
                        </span>
                      </div>
                      <div className={field.revealed ? "vault-field-value revealed" : "vault-field-value"}>
                        {field.revealed ? (
                          <pre>{field.value}</pre>
                        ) : (
                          <span aria-label="已隐藏">{mask("x".repeat(Math.min(detail.title.length + 8, 40)))}</span>
                        )}
                      </div>
                    </div>
                  ))}
                </section>
              ) : null}

              {detail.note ? (
                <section className="vault-note">
                  <h3>备注</h3>
                  <p>{detail.note}</p>
                </section>
              ) : null}
            </article>
          )}
        </aside>
      </div>

      <RecordEditor
        open={editor !== null}
        initial={editor?.mode === "edit" ? editor.detail : null}
        categories={categories}
        tags={tags}
        disabled={recoveryMode}
        onClose={() => setEditor(null)}
        onSaved={() => {
          setEditor(null);
          setNotice("已保存");
        }}
      />

      <ConfirmDialog
        open={confirmDelete !== null}
        title="删除这条记录？"
        detail="记录会立即从列表移除并写入审计；删除不会自动清除备份中的历史副本。"
        confirmLabel="删除"
        danger
        onConfirm={() => {
          const id = confirmDelete;
          setConfirmDelete(null);
          if (id) void deleteRecord(id);
        }}
        onCancel={() => setConfirmDelete(null)}
      />

      <VaultSettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onDeleted={() => {
          useVaultStore.getState().resetAfterLock();
          void useVaultStore.getState().refreshAll();
        }}
      />

      <RecoverySetupDialog
        open={recoverySetup}
        onClose={() => setRecoverySetup(false)}
        onDone={() => {
          setRecoverySetup(false);
          void useVaultStore.getState().refreshAll();
        }}
      />
    </div>
  );
}

function CategoryRail({
  title,
  rows,
  active,
  onSelect,
}: {
  title: string;
  rows: VaultCategory[];
  active?: string;
  onSelect: (id: string) => void;
}) {
  if (!rows.length) return null;
  return (
    <div className="vault-rail-section">
      <span className="vault-rail-title">{title}</span>
      {rows.map((row) => (
        <button
          key={row.id}
          type="button"
          className={active === row.id ? "vault-filter active" : "vault-filter"}
          onClick={() => onSelect(row.id)}
        >
          <span className="vault-dot" /> {row.name}
        </button>
      ))}
    </div>
  );
}

// ── 记录编辑器 ───────────────────────────────────────────────

function RecordEditor({
  open,
  initial,
  categories,
  tags,
  disabled,
  onClose,
  onSaved,
}: {
  open: boolean;
  initial: VaultRecordDetail | null;
  categories: VaultCategory[];
  tags: VaultCategory[];
  disabled: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [type, setType] = useState<VaultRecordType>("password");
  const [title, setTitle] = useState("");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [url, setUrl] = useState("");
  const [platform, setPlatform] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [favorite, setFavorite] = useState(false);
  const [note, setNote] = useState("");
  const [fields, setFields] = useState<VaultSecretField[]>(DEFAULT_FIELDS.password);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const createRecord = useVaultStore((s) => s.createRecord);
  const updateRecord = useVaultStore((s) => s.updateRecord);

  useEffect(() => {
    if (!open) return;
    setError(null);
    if (initial) {
      setType(initial.type);
      setTitle(initial.title);
      setUsername(initial.username);
      setEmail(initial.email);
      setUrl(initial.url);
      setPlatform(initial.platform);
      setCategoryId(initial.categoryId);
      setTagIds(initial.tagIds);
      setFavorite(initial.favorite);
      setNote(initial.note);
      setFields(
        initial.fields.map((field) => ({
          id: field.id,
          label: field.label,
          kind: field.kind,
          encoding: "utf8",
          value: field.value,
        })),
      );
    } else {
      setType("password");
      setTitle("");
      setUsername("");
      setEmail("");
      setUrl("");
      setPlatform("");
      setCategoryId("");
      setTagIds([]);
      setFavorite(false);
      setNote("");
      setFields(DEFAULT_FIELDS.password.map((field) => ({ ...field })));
    }
  }, [open, initial]);

  function changeType(next: VaultRecordType) {
    setType(next);
    if (!initial) setFields(DEFAULT_FIELDS[next].map((field) => ({ ...field })));
  }

  function updateField(id: string, patch: Partial<VaultSecretField>) {
    setFields((current) => current.map((field) => (field.id === id ? { ...field, ...patch } : field)));
  }

  function addField() {
    setFields((current) => [
      ...current,
      { id: newId("field"), label: "新字段", kind: "text", encoding: "utf8", value: "" },
    ]);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (disabled) return;
    setBusy(true);
    setError(null);
    const draft: VaultRecordDraft = {
      type,
      title: title.trim(),
      username,
      email,
      url,
      platform,
      categoryId,
      tagIds,
      favorite,
      note,
      fields,
    };
    try {
      if (initial) {
        await updateRecord(initial.id, initial.rev, draft);
      } else {
        await createRecord(draft);
      }
      onSaved();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={initial ? "编辑记录" : "新建记录"}
      size="lg"
      panelClassName="vault-editor"
      footer={
        <>
          <button type="button" className="btn ghost" onClick={onClose}>
            取消
          </button>
          <button type="submit" form="vault-record-form" className="btn primary" disabled={busy}>
            {busy ? <Loader2 size={14} className="spin" /> : <Check size={14} />}
            保存
          </button>
        </>
      }
    >
      <form id="vault-record-form" className="vault-form" onSubmit={submit}>
        {error ? <div className="vault-error">{error}</div> : null}
        <div className="vault-editor-grid">
          <label className="vault-label">
            类型
            <Select
              value={type}
              onChange={(value) => changeType(value as VaultRecordType)}
              options={TYPE_OPTIONS}
              disabled={Boolean(initial)}
            />
          </label>
          <label className="vault-label">
            标题
            <input
              className="input"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={200}
              required
              autoFocus
            />
          </label>
        </div>
        <div className="vault-editor-grid">
          <label className="vault-label">
            用户名
            <input className="input" value={username} onChange={(event) => setUsername(event.target.value)} />
          </label>
          <label className="vault-label">
            邮箱
            <input className="input" type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
          </label>
        </div>
        <div className="vault-editor-grid">
          <label className="vault-label">
            登录地址
            <input className="input" value={url} onChange={(event) => setUrl(event.target.value)} />
          </label>
          <label className="vault-label">
            所属平台
            <input className="input" value={platform} onChange={(event) => setPlatform(event.target.value)} />
          </label>
        </div>
        <div className="vault-editor-grid">
          <label className="vault-label">
            分类
            <Select
              value={categoryId}
              onChange={setCategoryId}
              options={[
                { value: "", label: "未分类" },
                ...categories.map((category) => ({ value: category.id, label: category.name })),
              ]}
            />
          </label>
          <div className="vault-label">
            标签
            <div className="vault-tag-picker">
              {tags.length === 0 ? <span className="vault-muted">可在安全设置中创建标签</span> : null}
              {tags.map((tag) => (
                <label key={tag.id} className="vault-chip">
                  <input
                    type="checkbox"
                    checked={tagIds.includes(tag.id)}
                    onChange={(event) =>
                      setTagIds((current) =>
                        event.target.checked
                          ? [...current, tag.id]
                          : current.filter((id) => id !== tag.id),
                      )
                    }
                  />
                  {tag.name}
                </label>
              ))}
            </div>
          </div>
        </div>

        <section className="vault-editor-fields">
          <div className="vault-section-head">
            <h3>敏感字段</h3>
            <button type="button" className="btn sm ghost" onClick={addField}>
              <Plus size={13} /> 自定义字段
            </button>
          </div>
          <p className="vault-footnote">
            字段值会一起进入 AES-256-GCM 加密范围；SSH 私钥等多行文本按原文保存。
          </p>
          {fields.map((field) => (
            <div key={field.id} className="vault-field-editor">
              <div className="vault-field-editor-head">
                <input
                  className="input"
                  value={field.label}
                  aria-label="字段名称"
                  onChange={(event) => updateField(field.id, { label: event.target.value })}
                  maxLength={80}
                />
                <Select
                  value={field.kind}
                  onChange={(value) => updateField(field.id, { kind: value as VaultSecretField["kind"] })}
                  options={[
                    { value: "password", label: "密码型" },
                    { value: "text", label: "单行文本" },
                    { value: "multiline", label: "多行文本" },
                    { value: "date", label: "日期" },
                    { value: "number", label: "数字" },
                  ]}
                />
                <button
                  type="button"
                  className="icon-btn sm"
                  aria-label="删除字段"
                  onClick={() => setFields((current) => current.filter((f) => f.id !== field.id))}
                >
                  <Trash2 size={13} />
                </button>
              </div>
              {field.kind === "multiline" ? (
                <textarea
                  className="input vault-field-textarea"
                  value={field.value}
                  rows={4}
                  onChange={(event) => updateField(field.id, { value: event.target.value })}
                />
              ) : (
                <input
                  className="input"
                  type={field.kind === "password" ? "password" : field.kind === "date" ? "date" : "text"}
                  value={field.value}
                  onChange={(event) => updateField(field.id, { value: event.target.value })}
                />
              )}
            </div>
          ))}
        </section>

        <label className="vault-label">
          备注（不用于搜索之外的自动处理）
          <textarea
            className="input"
            value={note}
            rows={3}
            maxLength={4000}
            onChange={(event) => setNote(event.target.value)}
          />
        </label>
        <label className="vault-check">
          <input
            type="checkbox"
            checked={favorite}
            onChange={(event) => setFavorite(event.target.checked)}
          />
          收藏这条记录
        </label>
      </form>
    </Dialog>
  );
}

// ── 设置 / 备份 / 审计 ────────────────────────────────────────

function VaultSettingsDialog({
  open,
  onClose,
  onDeleted,
}: {
  open: boolean;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const settings = useVaultStore((s) => s.settings);
  const audit = useVaultStore((s) => s.audit);
  const categories = useVaultStore((s) => s.categories);
  const tags = useVaultStore((s) => s.tags);
  const saveSettings = useVaultStore((s) => s.saveSettings);
  const refreshTaxonomy = useVaultStore((s) => s.refreshTaxonomy);
  const refreshAudit = useVaultStore((s) => s.refreshAudit);

  const [tab, setTab] = useState<"security" | "generator" | "backup" | "audit">("security");
  const [draft, setDraft] = useState<VaultLockSettings>({
    idleSecs: 300,
    backgroundSecs: 60,
    clipboardClearSecs: 30,
    revealSecs: 30,
  });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (settings) setDraft(settings);
  }, [settings]);

  useEffect(() => {
    if (open) {
      void refreshTaxonomy();
      void refreshAudit();
    }
  }, [open, refreshAudit, refreshTaxonomy]);

  const badge = notice ? <div className="vault-banner info">{notice}</div> : null;

  return (
    <Dialog open={open} onClose={onClose} title="安全设置" size="lg" panelClassName="vault-settings">
      <div className="vault-tabs" role="tablist">
        {[
          ["security", "锁定与剪贴板"],
          ["generator", "密码生成器"],
          ["backup", "备份与恢复"],
          ["audit", "审计"],
        ].map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            className={tab === value ? "active" : ""}
            onClick={() => setTab(value as typeof tab)}
          >
            {label}
          </button>
        ))}
      </div>
      {badge}
      {error ? <div className="vault-error">{error}</div> : null}

      {tab === "security" ? (
        <SecurityTab
          draft={draft}
          setDraft={setDraft}
          categories={categories}
          tags={tags}
          onNotice={setNotice}
          onError={setError}
          onDeleted={onDeleted}
          onSave={async () => {
            try {
              await saveSettings(draft);
              setNotice("安全设置已保存");
            } catch (e) {
              setError(errorMessage(e));
            }
          }}
        />
      ) : null}
      {tab === "generator" ? <GeneratorTab onNotice={setNotice} /> : null}
      {tab === "backup" ? (
        <BackupTab
          onNotice={setNotice}
          onError={setError}
          onImported={() => {
            useVaultStore.getState().resetAfterLock();
            void useVaultStore.getState().refreshAll();
          }}
        />
      ) : null}
      {tab === "audit" ? (
        <div className="vault-audit">
          {audit.length === 0 ? (
            <p className="vault-muted">暂无审计事件。审计不记录标题、字段值或搜索词。</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>时间</th>
                  <th>事件</th>
                  <th>结果</th>
                  <th>原因</th>
                </tr>
              </thead>
              <tbody>
                {audit.map((row) => (
                  <tr key={row.id}>
                    <td>{formatDate(row.at)}</td>
                    <td>{row.event}</td>
                    <td>{row.outcome}</td>
                    <td>{row.reasonCode ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ) : null}
    </Dialog>
  );
}

function SecurityTab({
  draft,
  setDraft,
  categories,
  tags,
  onNotice,
  onError,
  onDeleted,
  onSave,
}: {
  draft: VaultLockSettings;
  setDraft: (next: VaultLockSettings) => void;
  categories: VaultCategory[];
  tags: VaultCategory[];
  onNotice: (message: string) => void;
  onError: (message: string) => void;
  onDeleted: () => void;
  onSave: () => Promise<void>;
}) {
  const [masterOpen, setMasterOpen] = useState(false);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [newCategory, setNewCategory] = useState("");
  const [newTag, setNewTag] = useState("");

  return (
    <div className="vault-settings-section">
      <h3>自动锁定</h3>
      <div className="vault-settings-grid">
        <label className="vault-label">
          闲置时长
          <Select
            value={String(draft.idleSecs)}
            onChange={(value) => setDraft({ ...draft, idleSecs: Number(value) })}
            options={[
              { value: "0", label: "立即锁定" },
              { value: "60", label: "1 分钟" },
              { value: "300", label: "5 分钟（推荐）" },
              { value: "600", label: "10 分钟" },
              { value: "1800", label: "30 分钟" },
            ]}
          />
        </label>
        <label className="vault-label">
          进入后台
          <Select
            value={String(draft.backgroundSecs)}
            onChange={(value) => setDraft({ ...draft, backgroundSecs: Number(value) })}
            options={[
              { value: "0", label: "立即锁定" },
              { value: "30", label: "30 秒" },
              { value: "60", label: "60 秒（推荐）" },
              { value: "180", label: "3 分钟" },
            ]}
          />
        </label>
        <label className="vault-label">
          剪贴板清除
          <Select
            value={String(draft.clipboardClearSecs)}
            onChange={(value) => setDraft({ ...draft, clipboardClearSecs: Number(value) })}
            options={[
              { value: "10", label: "10 秒" },
              { value: "30", label: "30 秒（推荐）" },
              { value: "60", label: "60 秒" },
              { value: "120", label: "120 秒" },
              { value: "300", label: "300 秒" },
            ]}
          />
        </label>
        <label className="vault-label">
          敏感内容保持展开
          <Select
            value={String(draft.revealSecs)}
            onChange={(value) => setDraft({ ...draft, revealSecs: Number(value) })}
            options={[
              { value: "30", label: "30 秒" },
              { value: "60", label: "60 秒" },
              { value: "120", label: "120 秒" },
            ]}
          />
        </label>
      </div>
      <p className="vault-footnote">
        后端每 2 秒检查一次闲置/后台时长；系统锁屏、窗口关闭与休眠由窗口事件直接锁定。
        前端计时器不作为安全机制。
      </p>
      <button type="button" className="btn primary" onClick={() => void onSave()}>
        保存锁定设置
      </button>

      <h3>分类与标签</h3>
      <div className="vault-inline">
        <input
          className="input"
          value={newCategory}
          placeholder="新分类名称（≤40 字符）"
          onChange={(event) => setNewCategory(event.target.value)}
        />
        <button
          type="button"
          className="btn sm"
          onClick={async () => {
            try {
              await vaultApi.createCategory(newCategory);
              setNewCategory("");
              onNotice("分类已创建");
            } catch (e) {
              onError(errorMessage(e));
            }
          }}
        >
          添加分类
        </button>
      </div>
      <div className="vault-chip-row">
        {categories.map((category) => (
          <span key={category.id} className="vault-chip">
            {category.name}
            <button
              type="button"
              className="icon-btn xs"
              aria-label={`删除分类 ${category.name}`}
              onClick={async () => {
                try {
                  const result = await vaultApi.deleteCategory(category.id, true);
                  onNotice(`已删除分类，影响 ${result.affectedRecords} 条记录`);
                } catch (e) {
                  onError(errorMessage(e));
                }
              }}
            >
              <X size={11} />
            </button>
          </span>
        ))}
      </div>
      <div className="vault-inline">
        <input
          className="input"
          value={newTag}
          placeholder="新标签名称（≤24 字符）"
          onChange={(event) => setNewTag(event.target.value)}
        />
        <button
          type="button"
          className="btn sm"
          onClick={async () => {
            try {
              await vaultApi.createTag(newTag);
              setNewTag("");
              onNotice("标签已创建");
            } catch (e) {
              onError(errorMessage(e));
            }
          }}
        >
          添加标签
        </button>
      </div>
      <div className="vault-chip-row">
        {tags.map((tag) => (
          <span key={tag.id} className="vault-chip">
            {tag.name}
            <button
              type="button"
              className="icon-btn xs"
              aria-label={`删除标签 ${tag.name}`}
              onClick={async () => {
                try {
                  const result = await vaultApi.deleteTag(tag.id);
                  onNotice(`已删除标签，影响 ${result.affectedRecords} 条记录`);
                } catch (e) {
                  onError(errorMessage(e));
                }
              }}
            >
              <X size={11} />
            </button>
          </span>
        ))}
      </div>

      <h3>主密码与恢复密钥</h3>
      <div className="vault-inline">
        <button type="button" className="btn" onClick={() => setMasterOpen(true)}>
          修改主密码
        </button>
        <button type="button" className="btn" onClick={() => setRecoveryOpen(true)}>
          重新生成恢复密钥
        </button>
      </div>
      <p className="vault-footnote">
        修改主密码只重新封装数据密钥，不会重新加密全部记录。重新生成恢复密钥后旧密钥立即失效。
      </p>

      <h3 className="danger">删除保险箱</h3>
      <p className="vault-footnote">
        删除会移除本机独立数据库与恢复密钥信封，<strong>不可撤销</strong>；普通任务与笔记不受影响。
      </p>
      <button type="button" className="btn danger" onClick={() => setDeleteOpen(true)}>
        删除本机保险箱
      </button>

      <MasterPasswordDialog
        open={masterOpen}
        onClose={() => setMasterOpen(false)}
        onDone={() => {
          setMasterOpen(false);
          onNotice("主密码已更新");
        }}
        onError={onError}
      />
      <RegenerateRecoveryDialog
        open={recoveryOpen}
        onClose={() => setRecoveryOpen(false)}
        onDone={() => {
          setRecoveryOpen(false);
          onNotice("恢复密钥已重新生成；旧密钥已失效");
        }}
        onError={onError}
      />
      <DeleteVaultDialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        onDeleted={onDeleted}
        onError={onError}
      />
    </div>
  );
}

function MasterPasswordDialog({
  open,
  onClose,
  onDone,
  onError,
}: {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
  onError: (message: string) => void;
}) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (next !== confirm) {
      onError("两次输入的新主密码不一致");
      return;
    }
    setBusy(true);
    try {
      await vaultApi.changeMasterPassword(current, next);
      setCurrent("");
      setNext("");
      setConfirm("");
      onDone();
    } catch (e) {
      onError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="修改主密码"
      size="sm"
      footer={
        <>
          <button type="button" className="btn ghost" onClick={onClose}>
            取消
          </button>
          <button type="submit" form="vault-master-form" className="btn primary" disabled={busy}>
            保存
          </button>
        </>
      }
    >
      <form id="vault-master-form" className="vault-form" onSubmit={submit}>
        <label className="vault-label">
          当前主密码
          <input
            className="input"
            type="password"
            value={current}
            onChange={(event) => setCurrent(event.target.value)}
            autoComplete="current-password"
          />
        </label>
        <label className="vault-label">
          新主密码（8–128 字符）
          <input
            className="input"
            type="password"
            value={next}
            onChange={(event) => setNext(event.target.value)}
            autoComplete="new-password"
          />
        </label>
        <label className="vault-label">
          再次输入新主密码
          <input
            className="input"
            type="password"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            autoComplete="new-password"
          />
        </label>
      </form>
    </Dialog>
  );
}

function RegenerateRecoveryDialog({
  open,
  onClose,
  onDone,
  onError,
}: {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
  onError: (message: string) => void;
}) {
  const [groups, setGroups] = useState<string[] | null>(null);
  const [acked, setAcked] = useState(false);
  const [busy, setBusy] = useState(false);

  async function generate() {
    setBusy(true);
    try {
      setGroups(await vaultApi.regenerateRecoveryKey());
    } catch (e) {
      onError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="重新生成恢复密钥" size="md">
      {!groups ? (
        <div className="vault-form">
          <p>
            旧恢复密钥将<strong>立即失效</strong>。确认你仍有当前主密码可用，再继续。新密钥只显示一次。
          </p>
          <button type="button" className="btn primary" disabled={busy} onClick={() => void generate()}>
            生成新恢复密钥
          </button>
        </div>
      ) : (
        <div className="vault-form">
          <div className="vault-recovery-grid">
            {groups.map((group, index) => (
              <span key={`${group}-${index}`} className="vault-recovery-group">
                <em>{index + 1}</em>
                {group}
              </span>
            ))}
          </div>
          <label className="vault-check">
            <input type="checkbox" checked={acked} onChange={(event) => setAcked(event.target.checked)} />
            我已抄写并确认旧密钥失效
          </label>
          <button type="button" className="btn primary" disabled={!acked} onClick={onDone}>
            完成
          </button>
        </div>
      )}
    </Dialog>
  );
}

function DeleteVaultDialog({
  open,
  onClose,
  onDeleted,
  onError,
}: {
  open: boolean;
  onClose: () => void;
  onDeleted: () => void;
  onError: (message: string) => void;
}) {
  const [confirm, setConfirm] = useState("");
  return (
    <Dialog open={open} onClose={onClose} title="删除本机保险箱" size="sm">
      <div className="vault-form">
        <p className="vault-warn">
          <AlertTriangle size={15} /> 此操作不可撤销，且不会自动保留备份。
        </p>
        <label className="vault-label">
          输入 <code>DELETE VAULT</code> 确认
          <input className="input" value={confirm} onChange={(event) => setConfirm(event.target.value)} />
        </label>
        <button
          type="button"
          className="btn danger"
          onClick={async () => {
            try {
              await vaultApi.deleteVault(confirm);
              onDeleted();
            } catch (e) {
              onError(errorMessage(e));
            }
          }}
        >
          永久删除
        </button>
      </div>
    </Dialog>
  );
}

function RecoverySetupDialog({
  open,
  onClose,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (password !== confirm) {
      setError("两次输入不一致");
      return;
    }
    setBusy(true);
    try {
      await vaultApi.recoverSetPassword(password);
      setPassword("");
      setConfirm("");
      onDone();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="设置新的主密码" size="sm" dismissOnScrim={false}>
      <form className="vault-form" onSubmit={submit}>
        <p>恢复模式下数据可读但不可写。设置新主密码后会重新封装同一数据密钥，记录无需重写。</p>
        {error ? <div className="vault-error">{error}</div> : null}
        <label className="vault-label">
          新主密码
          <input
            className="input"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="new-password"
          />
        </label>
        <label className="vault-label">
          再次输入
          <input
            className="input"
            type="password"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            autoComplete="new-password"
          />
        </label>
        <button type="submit" className="btn primary" disabled={busy}>
          {busy ? <Loader2 className="spin" size={14} /> : null} 设置并继续
        </button>
      </form>
    </Dialog>
  );
}

// ── 生成器 / 备份 ────────────────────────────────────────────

function GeneratorTab({ onNotice }: { onNotice: (message: string) => void }) {
  const [length, setLength] = useState(20);
  const [upper, setUpper] = useState(true);
  const [lower, setLower] = useState(true);
  const [digit, setDigit] = useState(true);
  const [symbol, setSymbol] = useState(true);
  const [excludeAmbiguous, setExcludeAmbiguous] = useState(true);
  const [result, setResult] = useState<{ password: string; entropyBits: number } | null>(null);
  const [strength, setStrength] = useState<VaultStrength | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function generate() {
    setError(null);
    try {
      const generated = await vaultApi.generatePassword({
        length,
        upper,
        lower,
        digit,
        symbol,
        excludeAmbiguous,
      });
      setResult(generated);
      setStrength(await vaultApi.evaluateStrength(generated.password));
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <div className="vault-form">
      <h3>密码生成器</h3>
      <div className="vault-settings-grid">
        <label className="vault-label">
          长度（8–64）
          <input
            className="input"
            type="number"
            min={8}
            max={64}
            value={length}
            onChange={(event) => setLength(Number(event.target.value))}
          />
        </label>
        <div className="vault-check">
          <Switch checked={upper} onChange={setUpper} label="大写字母" />
        </div>
        <div className="vault-check">
          <Switch checked={lower} onChange={setLower} label="小写字母" />
        </div>
        <div className="vault-check">
          <Switch checked={digit} onChange={setDigit} label="数字" />
        </div>
        <div className="vault-check">
          <Switch checked={symbol} onChange={setSymbol} label="特殊符号" />
        </div>
        <div className="vault-check">
          <Switch
            checked={excludeAmbiguous}
            onChange={setExcludeAmbiguous}
            label="排除易混淆字符（0/O、1/l/I）"
          />
        </div>
      </div>
      {error ? <div className="vault-error">{error}</div> : null}
      <button type="button" className="btn primary" onClick={() => void generate()}>
        <RefreshCw size={14} /> 生成
      </button>
      {result ? (
        <div className="vault-generated">
          <code>{result.password}</code>
          <div>
            <button
              type="button"
              className="icon-btn sm"
              aria-label="复制生成的密码"
              onClick={() => {
                void navigator.clipboard.writeText(result.password);
                onNotice("已复制生成的密码；该密码未写入保险箱");
              }}
            >
              <ClipboardCopy size={14} />
            </button>
            <span className="vault-muted">约 {result.entropyBits} bit 熵</span>
          </div>
        </div>
      ) : null}
      {strength ? (
        <div className={`vault-strength level-${strength.level}`}>
          <span>强度：{strength.level}</span>
          <span className="vault-strength-track"><i style={{ width: `${strength.score}%` }} /></span>
          <span>{strength.score}/100</span>
        </div>
      ) : null}
      <p className="vault-footnote">
        强度评分是启发式参考，不是安全保证。生成器使用操作系统 CSPRNG 与拒绝采样。
      </p>
    </div>
  );
}

function BackupTab({
  onNotice,
  onError,
  onImported,
}: {
  onNotice: (message: string) => void;
  onError: (message: string) => void;
  onImported: () => void;
}) {
  const [path, setPath] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [overwrite, setOverwrite] = useState(false);
  const [inspectPath, setInspectPath] = useState("");
  const [inspectResult, setInspectResult] = useState<string | null>(null);
  const [importPath, setImportPath] = useState("");
  const [importPassphrase, setImportPassphrase] = useState("");
  const [newMaster, setNewMaster] = useState("");
  const [busy, setBusy] = useState(false);

  async function exportBackup() {
    setBusy(true);
    try {
      const summary = await vaultApi.exportBackup(path, passphrase, true, overwrite);
      onNotice(`已导出 ${summary.recordCount} 条记录（${Math.round(summary.size / 1024)} KB）`);
      setPassphrase("");
    } catch (e) {
      onError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function inspect() {
    try {
      const info = await vaultApi.inspectBackup(inspectPath);
      setInspectResult(
        `版本 ${info.version} · ${info.recordCount} 条 · ${formatDate(info.createdAt)} · ${info.mode}`,
      );
    } catch (e) {
      onError(errorMessage(e));
    }
  }

  async function importBackup() {
    setBusy(true);
    try {
      const result = await vaultApi.importBackup(importPath, importPassphrase, newMaster);
      onNotice(`已导入 ${result.imported} 条记录`);
      onImported();
    } catch (e) {
      onError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="vault-form">
      <h3>导出加密备份</h3>
      <p className="vault-footnote">
        备份载荷整体加密，文件头只暴露时间、条数与来源 ID。默认不提供明文导出。
      </p>
      <label className="vault-label">
        保存路径（绝对路径，建议放在非备份保留目录）
        <input className="input" value={path} onChange={(event) => setPath(event.target.value)} placeholder="D:\\Backups\\taskdock-vault-2026.tdvault" />
      </label>
      <label className="vault-label">
        备份口令（10–128 字符，独立于主密码）
        <input
          className="input"
          type="password"
          value={passphrase}
          onChange={(event) => setPassphrase(event.target.value)}
        />
      </label>
      <label className="vault-check">
        <input type="checkbox" checked={overwrite} onChange={(event) => setOverwrite(event.target.checked)} />
        允许覆盖同名文件
      </label>
      <button type="button" className="btn primary" disabled={busy || !path || !passphrase} onClick={() => void exportBackup()}>
        <Download size={14} /> 导出
      </button>

      <h3>检查备份</h3>
      <div className="vault-inline">
        <input className="input" value={inspectPath} onChange={(event) => setInspectPath(event.target.value)} placeholder="选择 .tdvault 路径" />
        <button type="button" className="btn" onClick={() => void inspect()} disabled={!inspectPath}>
          只读检查
        </button>
      </div>
      {inspectResult ? <p className="vault-muted">{inspectResult}</p> : null}

      <h3>导入到新保险箱</h3>
      <p className="vault-footnote">
        P1 导入只在<strong>尚未创建保险箱</strong>时可用；导入会建立新库并重新生成主密码/恢复密钥信封。
      </p>
      <label className="vault-label">
        备份文件
        <input className="input" value={importPath} onChange={(event) => setImportPath(event.target.value)} />
      </label>
      <label className="vault-label">
        备份口令
        <input className="input" type="password" value={importPassphrase} onChange={(event) => setImportPassphrase(event.target.value)} />
      </label>
      <label className="vault-label">
        新主密码
        <input className="input" type="password" value={newMaster} onChange={(event) => setNewMaster(event.target.value)} />
      </label>
      <button
        type="button"
        className="btn"
        disabled={busy || !importPath || !importPassphrase || !newMaster}
        onClick={() => void importBackup()}
      >
        <Upload size={14} /> 导入
      </button>
    </div>
  );
}
