//! 安全保险箱前端桥接：**唯一 invoke 入口**。
//!
//! 这里只做类型与命令封装；任何密钥、主密码、恢复密钥都只存在于用户输入和
//! 单次请求中，不写入本模块、Store 或日志。

import { invokeCommand } from "./errors";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type VaultRuntimeState = "noVault" | "locked" | "unlocked" | "recovery";

export type VaultRecordType =
  | "password"
  | "api_key"
  | "license"
  | "recovery"
  | "memo"
  | "device"
  | "ssh";

export type VaultFieldKind = "password" | "text" | "multiline" | "date" | "number";

export interface VaultLockSettings {
  idleSecs: number;
  backgroundSecs: number;
  clipboardClearSecs: number;
  revealSecs: number;
}

export interface VaultStatus {
  state: VaultRuntimeState;
  hasVault: boolean;
  unlocked: boolean;
  recoveryMode: boolean;
  recordCount?: number;
  lock?: VaultLockSettings;
  startupError?: string;
  lastLockReason?: string;
}

export interface VaultSecretField {
  id: string;
  label: string;
  kind: VaultFieldKind;
  encoding: "utf8" | "base64";
  value: string;
}

export interface VaultRecordDraft {
  type: VaultRecordType;
  title: string;
  username?: string;
  email?: string;
  url?: string;
  platform?: string;
  categoryId?: string;
  tagIds?: string[];
  favorite?: boolean;
  note?: string;
  fields?: VaultSecretField[];
}

export type VaultRecordPatch = Partial<
  Pick<
    VaultRecordDraft,
    | "title"
    | "username"
    | "email"
    | "url"
    | "platform"
    | "categoryId"
    | "tagIds"
    | "favorite"
    | "note"
    | "fields"
  >
>;

export interface VaultRecordListItem {
  id: string;
  rev: number;
  type: VaultRecordType;
  title: string;
  username: string;
  email: string;
  url: string;
  platform: string;
  categoryId: string;
  categoryName: string;
  tagIds: string[];
  tagNames: string[];
  favorite: boolean;
  updatedAt: string;
  lastUsedAt?: string;
  fieldCount: number;
}

export interface VaultFieldView {
  id: string;
  label: string;
  kind: VaultFieldKind;
  revealed: boolean;
  value: string;
}

export interface VaultRecordDetail extends VaultRecordListItem {
  note: string;
  createdAt: string;
  fields: VaultFieldView[];
}

export interface VaultCategory {
  id: string;
  name: string;
  sortOrder: number;
}

export interface VaultCopyReceipt {
  clearedAfterSecs: number;
  token: string;
}

export interface VaultClearResult {
  cleared: boolean;
  reason: string;
}

export interface VaultGeneratedPassword {
  password: string;
  charset: string;
  entropyBits: number;
}

export interface VaultStrength {
  score: number;
  level: "weak" | "fair" | "good" | "strong";
  entropyBits: number;
  reasons: string[];
}

export interface VaultCreateResult {
  vaultId: string;
  recoveryCode: string;
  recoveryGroups: string[];
  kdf: {
    alg: string;
    mCostKib?: number;
    tCost?: number;
    pCost?: number;
    saltB64: string;
  };
  createdAt: string;
  unlocked: boolean;
}

export interface VaultAuditEvent {
  id: number;
  at: string;
  event: string;
  outcome: string;
  reasonCode?: string;
  count?: number;
}

export interface VaultBackupSummary {
  path: string;
  size: number;
  recordCount: number;
  sha256: string;
}

export interface VaultBackupInspect {
  path: string;
  version: number;
  vaultId: string;
  createdAt: string;
  mode: string;
  recordCount: number;
  payloadLen: number;
}

export interface VaultImportResult {
  imported: number;
  skipped: number;
}

export const vaultApi = {
  status: () => invokeCommand<VaultStatus>("vault_status", {}, "读取保险箱状态"),
  create: (masterPassword: string) =>
    invokeCommand<VaultCreateResult>("vault_create", { masterPassword }, "创建保险箱"),
  confirmRecovery: (ack: boolean) =>
    invokeCommand<void>("vault_create_confirm_recovery", { ack }, "确认恢复密钥"),
  unlock: (kind: "password" | "recovery", value: string) =>
    invokeCommand<{ state: VaultRuntimeState; usedSlot: string }>(
      "vault_unlock",
      { credential: { kind, value } },
      "解锁保险箱",
    ),
  lock: (reason?: string) =>
    invokeCommand<void>("vault_lock", { reason }, "锁定保险箱"),
  touch: () => invokeCommand<void>("vault_touch", {}, "刷新保险箱活动时间"),
  appBackground: (background: boolean) =>
    invokeCommand<void>("vault_app_background", { background }, "保险箱后台状态"),
  changeMasterPassword: (current: string, newPassword: string) =>
    invokeCommand<void>(
      "vault_change_master_password",
      { current, newPassword },
      "修改主密码",
    ),
  recoverSetPassword: (newPassword: string) =>
    invokeCommand<void>("vault_recover_set_password", { newPassword }, "设置新主密码"),
  regenerateRecoveryKey: () =>
    invokeCommand<string[]>("vault_regenerate_recovery_key", {}, "生成恢复密钥"),
  deleteVault: (confirm: string) =>
    invokeCommand<void>("vault_delete", { confirm }, "删除保险箱"),
  listRecords: (filter: {
    recordType?: string;
    categoryId?: string;
    tagId?: string;
    favoriteOnly?: boolean;
    query?: string;
    limit?: number;
    offset?: number;
  } = {}) =>
    invokeCommand<VaultRecordListItem[]>("vault_record_list", filter, "读取保险箱列表"),
  getRecord: (id: string, reveal: string[] = []) =>
    invokeCommand<VaultRecordDetail>("vault_record_get", { id, reveal }, "读取保险箱记录"),
  createRecord: (draft: VaultRecordDraft) =>
    invokeCommand<{ id: string; rev: number }>("vault_record_create", { draft }, "新建保险箱记录"),
  updateRecord: (id: string, expectedRev: number, patch: VaultRecordPatch) =>
    invokeCommand<{ id: string; rev: number }>(
      "vault_record_update",
      { id, expectedRev, patch },
      "更新保险箱记录",
    ),
  deleteRecord: (id: string) =>
    invokeCommand<void>("vault_record_delete", { id }, "删除保险箱记录"),
  restoreRecord: (id: string) =>
    invokeCommand<void>("vault_record_restore", { id }, "恢复保险箱记录"),
  toggleFavorite: (id: string) =>
    invokeCommand<boolean>("vault_record_toggle_favorite", { id }, "切换收藏"),
  markUsed: (id: string) =>
    invokeCommand<void>("vault_record_mark_used", { id }, "更新最近使用"),
  search: (query: string) =>
    invokeCommand<VaultRecordListItem[]>("vault_search_records", { query }, "搜索保险箱"),
  categories: () => invokeCommand<VaultCategory[]>("vault_category_list", {}, "读取分类"),
  createCategory: (name: string) =>
    invokeCommand<VaultCategory>("vault_category_create", { name }, "新建分类"),
  renameCategory: (id: string, name: string) =>
    invokeCommand<void>("vault_category_rename", { id, name }, "重命名分类"),
  deleteCategory: (id: string, confirmAffected = false) =>
    invokeCommand<{ affectedRecords: number }>(
      "vault_category_delete",
      { id, confirmAffected },
      "删除分类",
    ),
  tags: () => invokeCommand<VaultCategory[]>("vault_tag_list", {}, "读取标签"),
  createTag: (name: string) =>
    invokeCommand<VaultCategory>("vault_tag_create", { name }, "新建标签"),
  renameTag: (id: string, name: string) =>
    invokeCommand<void>("vault_tag_rename", { id, name }, "重命名标签"),
  deleteTag: (id: string) =>
    invokeCommand<{ affectedRecords: number }>("vault_tag_delete", { id }, "删除标签"),
  getSettings: () => invokeCommand<VaultLockSettings>("vault_settings_get", {}, "读取安全设置"),
  setSettings: (settings: VaultLockSettings) =>
    invokeCommand<void>("vault_settings_set", { settings }, "保存安全设置"),
  generatePassword: (options: {
    length: number;
    upper: boolean;
    lower: boolean;
    digit: boolean;
    symbol: boolean;
    excludeAmbiguous: boolean;
  }) =>
    invokeCommand<VaultGeneratedPassword>(
      "vault_generate_password",
      { options },
      "生成密码",
    ),
  evaluateStrength: (password: string) =>
    invokeCommand<VaultStrength>(
      "vault_evaluate_password_strength",
      { password },
      "评估密码强度",
    ),
  copySecret: (recordId: string, fieldId: string, clearAfterSecs?: number) =>
    invokeCommand<VaultCopyReceipt>(
      "vault_copy_secret",
      { recordId, fieldId, clearAfterSecs },
      "复制保险箱字段",
    ),
  clearClipboardNow: () =>
    invokeCommand<VaultClearResult>("vault_clipboard_clear_now", {}, "清除保险箱剪贴板"),
  audit: () => invokeCommand<VaultAuditEvent[]>("vault_audit_list", {}, "读取审计事件"),
  exportBackup: (path: string, passphrase: string, includeSettings = true, overwrite = false) =>
    invokeCommand<VaultBackupSummary>(
      "vault_export_backup",
      { path, passphrase, includeSettings, overwrite },
      "导出加密备份",
    ),
  inspectBackup: (path: string) =>
    invokeCommand<VaultBackupInspect>("vault_backup_inspect", { path }, "检查备份"),
  importBackup: (path: string, passphrase: string, newMasterPassword: string) =>
    invokeCommand<VaultImportResult>(
      "vault_backup_import",
      { path, passphrase, newMasterPassword },
      "导入加密备份",
    ),
};

export function onVaultLocked(
  handler: (payload: { reason: string; at: string }) => void,
): Promise<UnlistenFn> {
  return listen<{ reason: string; at: string }>("vault-locked", (event) =>
    handler(event.payload),
  );
}

export function onVaultStatus(handler: () => void): Promise<UnlistenFn> {
  return listen("vault-status", () => handler());
}
