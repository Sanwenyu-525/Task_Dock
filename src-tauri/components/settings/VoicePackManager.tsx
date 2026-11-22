import { useCallback, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Check, LoaderCircle, Pencil, Play, Plus, Square, Trash2, Upload, X } from "lucide-react";
import { Select, Switch } from "../ui";
import { formatBytes } from "../../lib/clipboardUi";
import { getAudioService } from "../../lib/audioNotification";
import {
  voiceAssetImport,
  voiceAssetRemove,
  voiceBindingSet,
  voicePackCreate,
  voicePackDelete,
  voicePackRename,
  voicePacksList,
  type VoiceAsset,
  type VoiceEventKind,
  type VoicePack,
  type VoiceRouteMode,
} from "../../lib/bridge";
import { useLocale } from "../../hooks/useLocale";
import type { MessageKey } from "../../i18n";
import { useSettingsStore } from "../../store/useSettingsStore";
import "./VoicePackManager.css";

const EVENTS: Array<{ kind: VoiceEventKind; label: MessageKey; note?: MessageKey }> = [
  { kind: "agent_started", label: "settings.voicePack.event.started" },
  { kind: "agent_done", label: "settings.voicePack.event.done" },
  {
    kind: "agent_done_multiple",
    label: "settings.voicePack.event.doneMultiple",
    note: "settings.voicePack.event.doneMultipleNote",
  },
  { kind: "agent_waiting", label: "settings.voicePack.event.waiting" },
  { kind: "agent_failed", label: "settings.voicePack.event.failed" },
  { kind: "agent_disconnected", label: "settings.voicePack.event.disconnected" },
  { kind: "task_due", label: "settings.voicePack.event.taskDue" },
  { kind: "reminder", label: "settings.voicePack.event.reminder" },
];

const IMPORT_ERROR_KEYS: Record<string, MessageKey> = {
  unsupported_format: "settings.voicePack.error.unsupportedFormat",
  type_mismatch: "settings.voicePack.error.unsupportedFormat",
  decode_failed: "settings.voicePack.error.decodeFailed",
  source_unavailable: "settings.voicePack.error.sourceUnavailable",
  invalid_source: "settings.voicePack.error.sourceUnavailable",
  size_limit: "settings.voicePack.error.fileTooLarge",
  file_too_large: "settings.voicePack.error.fileTooLarge",
  duration_limit: "settings.voicePack.error.tooLong",
  too_long: "settings.voicePack.error.tooLong",
  pack_asset_limit: "settings.voicePack.error.packageLimit",
  package_limit: "settings.voicePack.error.packageLimit",
  pack_storage_limit: "settings.voicePack.error.packageCapacity",
  package_capacity: "settings.voicePack.error.packageCapacity",
  storage_error: "settings.voicePack.error.storage",
  disk_full: "settings.voicePack.error.storage",
};

const PREVIEW_ERROR_KEYS: Record<string, MessageKey> = {
  muted: "settings.voicePack.error.previewMuted",
  silent_speech: "settings.voicePack.error.previewSilentSpeech",
  busy: "settings.voicePack.error.previewBusy",
  asset_missing: "settings.voicePack.error.previewMissing",
  not_found: "settings.voicePack.error.previewMissing",
  playback_failed: "settings.voicePack.error.previewPlaybackFailed",
  audio_unavailable: "settings.voicePack.error.previewPlaybackFailed",
  failed: "settings.voicePack.error.previewPlaybackFailed",
  playback_timeout: "settings.voicePack.error.previewTimeout",
  timeout: "settings.voicePack.error.previewTimeout",
  unsupported: "settings.voicePack.error.previewUnsupported",
};

type ImportSummary = {
  name: string;
  result: "success" | "warning" | "failure";
  message: MessageKey;
};

/** Only for dialog paths: last path segment. Do not use for custom pack names. */
function basenameFromDialogPath(value: string): string {
  return value.split(/[\\/]/).filter(Boolean).pop() || value;
}

function previewErrorKey(code: string): MessageKey {
  return PREVIEW_ERROR_KEYS[code.toLowerCase()] ?? "settings.voicePack.error.previewFailed";
}

function errorCodeOf(error: unknown): string {
  if (typeof error === "string") return error.toLowerCase();
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code.toLowerCase() : "";
  }
  if (error instanceof Error) return error.message.toLowerCase();
  return "";
}

export default function VoicePackManager() {
  const { t } = useLocale();
  const settings = useSettingsStore((state) => state.settings);
  const update = useSettingsStore((state) => state.update);
  const loadSettings = useSettingsStore((state) => state.load);
  const [packs, setPacks] = useState<VoicePack[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [expandedPackId, setExpandedPackId] = useState<string | null>(null);
  const [createName, setCreateName] = useState("");
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameName, setRenameName] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<MessageKey | null>(null);
  const [cleanupWarning, setCleanupWarning] = useState<MessageKey | null>(null);
  const [importSummaries, setImportSummaries] = useState<ImportSummary[]>([]);
  const [importPackId, setImportPackId] = useState<string | null>(null);
  const [previewAssetId, setPreviewAssetId] = useState<string | null>(null);
  const previewAssetIdRef = useRef<string | null>(null);
  const previewSessionRef = useRef(0);
  const loadSequence = useRef(0);
  const alive = useRef(true);

  const currentPackId = settings?.tts_voice_pack_id ?? "";
  const currentPack = packs.find((pack) => pack.id === currentPackId);
  const route = settings?.tts_voice_route ?? "auto";
  const voicePackEnabled = settings?.tts_voice_pack_enabled ?? false;

  const loadPacks = useCallback(async () => {
    const sequence = ++loadSequence.current;
    setLoading(true);
    try {
      const result = await voicePacksList();
      if (!alive.current || sequence !== loadSequence.current) return;
      const next = Array.isArray(result) ? result : [];
      setPacks(next);
      setLoadError(false);
      setExpandedPackId((previous) =>
        previous && next.some((pack) => pack.id === previous)
          ? previous
          : next.find((pack) => pack.id === currentPackId)?.id ?? next[0]?.id ?? null,
      );
    } catch {
      if (alive.current && sequence === loadSequence.current) setLoadError(true);
    } finally {
      if (alive.current && sequence === loadSequence.current) setLoading(false);
    }
  }, [currentPackId]);

  useEffect(() => {
    alive.current = true;
    void loadPacks();
    return () => {
      alive.current = false;
      loadSequence.current += 1;
      previewSessionRef.current += 1;
      if (previewAssetIdRef.current) getAudioService().stopPreview();
      previewAssetIdRef.current = null;
    };
  }, [loadPacks]);

  useEffect(() => {
    if (previewAssetIdRef.current) {
      previewSessionRef.current += 1;
      getAudioService().stopPreview();
      previewAssetIdRef.current = null;
      setPreviewAssetId(null);
    }
  }, [currentPackId]);

  async function saveSetting(patch: Parameters<typeof update>[0]) {
    setOperationError(null);
    try {
      await update(patch);
      return true;
    } catch {
      setOperationError("settings.voicePack.error.saveFailed");
      return false;
    }
  }

  async function createPack() {
    const name = createName.trim();
    if (!name) return;
    setBusy("create");
    setOperationError(null);
    setCleanupWarning(null);
    try {
      const packId = await voicePackCreate(name);
      setCreateName("");
      await loadPacks();
      if (packId) setExpandedPackId(packId);
    } catch {
      setOperationError("settings.voicePack.error.createFailed");
    } finally {
      setBusy(null);
    }
  }

  async function renamePack(packId: string) {
    const name = renameName.trim();
    if (!name) return;
    setBusy(`rename:${packId}`);
    setOperationError(null);
    try {
      await voicePackRename(packId, name);
      setRenameId(null);
      setRenameName("");
      await loadPacks();
    } catch {
      setOperationError("settings.voicePack.error.renameFailed");
    } finally {
      setBusy(null);
    }
  }

  function stopPreviewUi() {
    previewSessionRef.current += 1;
    getAudioService().stopPreview();
    previewAssetIdRef.current = null;
    setPreviewAssetId(null);
  }

  async function deletePack(pack: VoicePack) {
    if (previewAssetIdRef.current && pack.assets.some((a) => a.id === previewAssetIdRef.current)) {
      stopPreviewUi();
    }
    setBusy(`delete:${pack.id}`);
    setOperationError(null);
    setCleanupWarning(null);
    try {
      const result = await voicePackDelete(pack.id);
      // 后端已在删除事务内同步清空活动包设置；前端只从数据库真值同步，
      if (pack.id === currentPackId) {
        try {
          await loadSettings();
        } catch {
          setOperationError("settings.voicePack.error.saveFailed");
        }
      }
      setConfirmDeleteId(null);
      await loadPacks();
      if (result?.cleanupPending) {
        setCleanupWarning("settings.voicePack.error.deleteCleanupPending");
      }
    } catch {
      setOperationError("settings.voicePack.error.deleteFailed");
    } finally {
      setBusy(null);
    }
  }

  async function changeBinding(packId: string, eventKind: VoiceEventKind, assetId: string) {
    setBusy(`binding:${packId}:${eventKind}`);
    setOperationError(null);
    try {
      await voiceBindingSet(packId, eventKind, assetId || null);
      await loadPacks();
    } catch {
      setOperationError("settings.voicePack.error.bindingFailed");
    } finally {
      setBusy(null);
    }
  }

  async function removeAsset(packId: string, assetId: string) {
    if (previewAssetIdRef.current === assetId) {
      stopPreviewUi();
    }
    setBusy(`remove:${assetId}`);
    setOperationError(null);
    setCleanupWarning(null);
    try {
      const result = await voiceAssetRemove(packId, assetId);
      await loadPacks();
      if (result?.cleanupPending) {
        setCleanupWarning("settings.voicePack.error.removeCleanupPending");
      }
    } catch {
      setOperationError("settings.voicePack.error.removeFailed");
    } finally {
      setBusy(null);
    }
  }

  async function importAssets(packId: string) {
    setOperationError(null);
    setCleanupWarning(null);
    setImportSummaries([]);
    setImportPackId(packId);
    let selected: string | string[] | null;
    try {
      selected = (await open({
        multiple: true,
        filters: [{ name: t("settings.voicePack.audioFiles"), extensions: ["mp3", "wav"] }],
      })) as string | string[] | null;
    } catch {
      setOperationError("settings.voicePack.error.filePickerFailed");
      return;
    }
    const paths = selected ? (Array.isArray(selected) ? selected : [selected]) : [];
    if (paths.length === 0) return;

    setBusy(`import:${packId}`);
    const summaries: ImportSummary[] = [];
    for (const path of paths) {
      const name = basenameFromDialogPath(path);
      try {
        const result = await voiceAssetImport(packId, path);
        if (result.ok && result.asset) {
          summaries.push({
            name,
            result: result.durationWarning ? "warning" : "success",
            message: result.durationWarning
              ? "settings.voicePack.import.durationWarning"
              : "settings.voicePack.import.success",
          });
        } else {
          summaries.push({
            name,
            result: "failure",
            message: importErrorKey(result.code),
          });
        }
      } catch (error) {
        summaries.push({
          name,
          result: "failure",
          message: importErrorKey(errorCodeOf(error)),
        });
      }
      setImportSummaries([...summaries]);
    }
    await loadPacks();
    setBusy(null);
  }

  async function previewAsset(assetId: string) {
    if (previewAssetIdRef.current === assetId) {
      stopPreviewUi();
      return;
    }
    getAudioService().stopPreview();
    const session = ++previewSessionRef.current;
    previewAssetIdRef.current = assetId;
    setPreviewAssetId(assetId);
    setOperationError(null);
    const isCurrent = () =>
      alive.current &&
      previewSessionRef.current === session &&
      previewAssetIdRef.current === assetId;
    try {
      const result = await getAudioService().previewCustomAsset(assetId);
      if (!result.ok && isCurrent() && result.code !== "cancelled") {
        setOperationError(previewErrorKey(result.code));
      }
    } catch (error) {
      if (isCurrent()) {
        const code = errorCodeOf(error);
        if (code !== "cancelled") {
          setOperationError(previewErrorKey(code));
        }
      }
    } finally {
      if (isCurrent()) {
        previewAssetIdRef.current = null;
        setPreviewAssetId(null);
      }
    }
  }

  return (
    <section className="voice-pack-manager" aria-labelledby="voice-pack-manager-title">
      <div className="voice-pack-heading">
        <div>
          <h3 id="voice-pack-manager-title">{t("settings.voicePack.title")}</h3>
          <p>{t("settings.voicePack.description")}</p>
        </div>
        <Switch
          checked={voicePackEnabled}
          disabled={packs.length === 0 || !currentPack}
          ariaLabel={t("settings.voicePack.enabled")}
          onChange={(enabled) => void saveSetting({ tts_voice_pack_enabled: enabled })}
        />
      </div>

      <div className="voice-pack-route-row">
        <span>{t("settings.voicePack.route")}</span>
        <Select<VoiceRouteMode>
          size="sm"
          value={route}
          ariaLabel={t("settings.voicePack.route")}
          options={[
            { value: "auto", label: t("settings.voicePack.route.auto") },
            { value: "system", label: t("settings.voicePack.route.system") },
            { value: "custom", label: t("settings.voicePack.route.custom") },
          ]}
          onChange={(value) => void saveSetting({ tts_voice_route: value })}
        />
      </div>
      <p className="voice-pack-note">
        {route === "custom"
          ? t("settings.voicePack.route.customNote")
          : route === "system"
            ? t("settings.voicePack.route.systemNote")
            : t("settings.voicePack.route.autoNote")}
      </p>
      <p className="voice-pack-note">{t("settings.voicePack.licenseNote")}</p>

      <div className="voice-pack-create">
        <label htmlFor="voice-pack-create-name">{t("settings.voicePack.create")}</label>
        <div className="voice-pack-input-row">
          <input
            id="voice-pack-create-name"
            value={createName}
            onChange={(event) => setCreateName(event.target.value)}
            aria-label={t("settings.voicePack.createName")}
            placeholder={t("settings.voicePack.createPlaceholder")}
            maxLength={80}
          />
          <button
            type="button"
            className="btn sm"
            onClick={() => void createPack()}
            disabled={!createName.trim() || busy !== null}
            aria-label={t("settings.voicePack.create")}
          >
            <Plus size={12} /> {t("settings.voicePack.create")}
          </button>
        </div>
      </div>

      {loadError && (
        <div className="voice-pack-error" role="alert">
          {t("settings.voicePack.error.loadFailed")}
          <button type="button" className="btn sm" onClick={() => void loadPacks()}>
            {t("common.retry")}
          </button>
        </div>
      )}
      {operationError && (
        <div className="voice-pack-error" role="alert">
          {t(operationError)}
        </div>
      )}
      {cleanupWarning && (
        <div className="voice-pack-note" role="status">
          {t(cleanupWarning)}
        </div>
      )}

      {loading && packs.length === 0 ? (
        <p className="voice-pack-empty" role="status">{t("settings.voicePack.loading")}</p>
      ) : packs.length === 0 ? (
        <p className="voice-pack-empty">{t("settings.voicePack.empty")}</p>
      ) : (
        <div className="voice-pack-list">
          {packs.map((pack) => {
            const expanded = expandedPackId === pack.id;
            const isCurrent = currentPackId === pack.id;
            return (
              <article className="voice-pack-card" key={pack.id}>
                <div className="voice-pack-card-head">
                  <div className="voice-pack-card-main">
                    <strong>{pack.name}</strong>
                    <span className="voice-pack-meta">
                      {t("settings.voicePack.packStats", {
                        assets: pack.assets.length,
                        bytes: formatBytes(pack.storageBytes),
                        bindings: pack.bindings.length,
                      })}
                    </span>
                    {isCurrent && (
                      <span className="voice-pack-current">{t("settings.voicePack.current")}</span>
                    )}
                    {isCurrent && voicePackEnabled && (
                      <span className="voice-pack-enabled">{t("settings.voicePack.active")}</span>
                    )}
                  </div>
                  <div className="voice-pack-actions">
                    {!isCurrent && (
                      <button
                        type="button"
                        className="btn sm"
                        disabled={busy !== null}
                        onClick={() => void saveSetting({ tts_voice_pack_id: pack.id })}
                        aria-label={t("settings.voicePack.makeCurrent", { name: pack.name })}
                      >
                        {t("settings.voicePack.makeCurrentShort")}
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn sm icon-only"
                      aria-label={t("settings.voicePack.rename", { name: pack.name })}
                      onClick={() => {
                        setRenameId(pack.id);
                        setRenameName(pack.name);
                        setConfirmDeleteId(null);
                      }}
                      disabled={busy !== null}
                    >
                      <Pencil size={12} />
                    </button>
                    <button
                      type="button"
                      className="btn sm icon-only"
                      aria-label={t("settings.voicePack.delete", { name: pack.name })}
                      onClick={() => {
                        setConfirmDeleteId(pack.id);
                        setRenameId(null);
                      }}
                      disabled={busy !== null}
                    >
                      <Trash2 size={12} />
                    </button>
                    <button
                      type="button"
                      className="btn sm"
                      aria-expanded={expanded}
                      aria-label={t(expanded ? "settings.voicePack.collapse" : "settings.voicePack.expand", {
                        name: pack.name,
                      })}
                      onClick={() => setExpandedPackId(expanded ? null : pack.id)}
                    >
                      {expanded ? t("settings.voicePack.collapseShort") : t("settings.voicePack.expandShort")}
                    </button>
                  </div>
                </div>

                {renameId === pack.id && (
                  <div className="voice-pack-inline-form">
                    <input
                      value={renameName}
                      onChange={(event) => setRenameName(event.target.value)}
                      aria-label={t("settings.voicePack.renameName")}
                      maxLength={80}
                    />
                    <button
                      type="button"
                      className="btn sm icon-only"
                      aria-label={t("settings.voicePack.saveRename")}
                      disabled={!renameName.trim() || busy !== null}
                      onClick={() => void renamePack(pack.id)}
                    >
                      <Check size={12} />
                    </button>
                    <button
                      type="button"
                      className="btn sm icon-only"
                      aria-label={t("common.cancel")}
                      disabled={busy !== null}
                      onClick={() => setRenameId(null)}
                    >
                      <X size={12} />
                    </button>
                  </div>
                )}

                {confirmDeleteId === pack.id && (
                  <div className="voice-pack-confirm" role="group" aria-label={t("settings.voicePack.confirmDeleteLabel")}>
                    <span>{t("settings.voicePack.confirmDelete", { name: pack.name })}</span>
                    <button
                      type="button"
                      className="btn sm danger"
                      disabled={busy !== null}
                      onClick={() => void deletePack(pack)}
                      aria-label={t("settings.voicePack.confirmDeleteAction", { name: pack.name })}
                    >
                      {busy === `delete:${pack.id}` ? <LoaderCircle size={12} className="spin" /> : t("settings.voicePack.deleteAction")}
                    </button>
                    <button
                      type="button"
                      className="btn sm"
                      disabled={busy !== null}
                      onClick={() => setConfirmDeleteId(null)}
                    >
                      {t("common.cancel")}
                    </button>
                  </div>
                )}

                {expanded && (
                  <div className="voice-pack-card-body">
                    <div className="voice-pack-import-row">
                      <strong>{t("settings.voicePack.assets")}</strong>
                      <button
                        type="button"
                        className="btn sm"
                        onClick={() => void importAssets(pack.id)}
                        disabled={busy !== null}
                        aria-label={t("settings.voicePack.importAction", { name: pack.name })}
                      >
                        {busy === `import:${pack.id}` ? (
                          <LoaderCircle size={12} className="spin" />
                        ) : (
                          <Upload size={12} />
                        )} {t("settings.voicePack.importActionShort")}
                      </button>
                    </div>
                    {pack.assets.length === 0 ? (
                      <p className="voice-pack-empty">{t("settings.voicePack.noAssets")}</p>
                    ) : (
                      <ul className="voice-pack-assets">
                        {pack.assets.map((asset) => (
                          <li key={asset.id}>
                            <span className="voice-pack-asset-name">{asset.displayName}</span>
                            <span className="voice-pack-meta">
                              {t("settings.voicePack.assetStats", {
                                duration: Math.ceil(asset.durationMs / 1000),
                                bytes: formatBytes(asset.sizeBytes),
                                type: asset.mediaType === "audio/mpeg" ? "MP3" : "WAV",
                              })}
                            </span>
                            <button
                              type="button"
                              className="btn sm icon-only"
                              onClick={() => void previewAsset(asset.id)}
                              disabled={busy !== null && busy !== `import:${pack.id}`}
                              aria-pressed={previewAssetId === asset.id}
                              aria-label={t(previewAssetId === asset.id
                                ? "settings.voicePack.stopPreview"
                                : "settings.voicePack.previewAsset", { name: asset.displayName })}
                            >
                              {previewAssetId === asset.id ? <Square size={11} /> : <Play size={11} />}
                            </button>
                            <button
                              type="button"
                              className="btn sm icon-only"
                              onClick={() => void removeAsset(pack.id, asset.id)}
                              disabled={busy !== null || pack.bindings.some((binding) => binding.assetId === asset.id)}
                              aria-label={t("settings.voicePack.removeAsset", { name: asset.displayName })}
                            >
                              <Trash2 size={11} />
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}

                    {importPackId === pack.id && importSummaries.length > 0 && (
                      <div
                        role="status"
                        aria-live="polite"
                        aria-atomic="false"
                        aria-label={t("settings.voicePack.importResults")}
                      >
                        <ul className="voice-pack-import-results">
                          {importSummaries.map((summary, index) => (
                            <li className={`is-${summary.result}`} key={`${summary.name}-${index}`}>
                              <span>{summary.name}</span>
                              <span>{t(summary.message)}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    <h4>{t("settings.voicePack.bindings")}</h4>
                    <div className="voice-pack-binding-list">
                      {EVENTS.map((event) => {
                        const boundAssetId = pack.bindings.find((binding) => binding.eventKind === event.kind)?.assetId ?? "";
                        const boundAsset = pack.assets.find((asset) => asset.id === boundAssetId);
                        const bindingBusy = busy === `binding:${pack.id}:${event.kind}`;
                        return (
                          <div className="voice-pack-binding" key={event.kind}>
                            <div className="voice-pack-binding-label">
                              <span>{t(event.label)}</span>
                              {event.note && <small>{t(event.note)}</small>}
                            </div>
                            <Select
                              size="sm"
                              value={boundAssetId}
                              ariaLabel={t("settings.voicePack.bindingFor", { event: t(event.label) })}
                              disabled={busy !== null}
                              options={[
                                { value: "", label: t("settings.voicePack.unbound") },
                                ...pack.assets.map((asset: VoiceAsset) => ({
                                  value: asset.id,
                                  label: asset.displayName,
                                })),
                              ]}
                              onChange={(assetId) => void changeBinding(pack.id, event.kind, assetId)}
                            />
                            <button
                              type="button"
                              className="btn sm icon-only"
                              onClick={() => boundAsset && void previewAsset(boundAsset.id)}
                              disabled={!boundAsset || busy !== null}
                              aria-pressed={Boolean(boundAssetId && previewAssetId === boundAssetId)}
                              aria-label={t("settings.voicePack.previewEvent", { event: t(event.label) })}
                            >
                              {previewAssetId === boundAssetId ? <Square size={11} /> : <Play size={11} />}
                            </button>
                            <button
                              type="button"
                              className="btn sm icon-only"
                              onClick={() => void changeBinding(pack.id, event.kind, "")}
                              disabled={!boundAssetId || busy !== null || bindingBusy}
                              aria-label={t("settings.voicePack.clearBinding", { event: t(event.label) })}
                            >
                              <X size={11} />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
      <div className="voice-pack-live" aria-live="polite">
        {busy === "create" || busy?.startsWith("rename:") ? t("settings.voicePack.saving") : null}
      </div>
    </section>
  );
}

function importErrorKey(code: string): MessageKey {
  return IMPORT_ERROR_KEYS[code] ?? "settings.voicePack.error.importGeneric";
}
