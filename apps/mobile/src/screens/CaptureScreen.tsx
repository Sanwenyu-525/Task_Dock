// 统一采集中心：拍照 / 相册 / 文件 / 文本 / 语音速记共用一条「暂存 → 预览 → 统一保存」流程。
//
// 为什么是一个页面而不是四个工具页：
// - 用户不用为每种来源各学一套保存流程；采集入口（工具页、系统分享、桌面快捷方式）都落到这里；
// - 暂存项已经落库（`capture_stash`），应用被杀后下一次打开还能恢复，不会「刚拍的照片丢了」；
// - 保存目标（收集箱 / 任务 / 笔记）在底部一次选完，附件随归属一起转正（见 db/captureSave.ts）。
//
// 边界：
// - 不接管桌面端的大工作台；不放「开发中」占位按钮，每个按钮都有真实行为；
// - 图片/音频只在本机处理，不上传；需要送电脑时走既有文件互传通道（同步页可开自动传送）；
// - 没有可靠的离线语音识别时不伪造转写：录音先保留，明确显示「尚未转写」，手写要点可选。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  BackHandler,
  Image,
  PermissionsAndroid,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { File } from "expo-file-system";

import VoiceRecorder, { voiceRecorderAvailable } from "../../modules/voice-recorder";
import type { ShareIntentPayload } from "../../modules/share-intent";
import { AppBar } from "../components/AppBar";
import { Badge } from "../components/Badge";
import { GlassCard } from "../components/GlassCard";
import { PressableScale } from "../components/PressableScale";
import { SegmentedControl } from "../components/SegmentedControl";
import { useToast } from "../feedback/ToastProvider";
import { ToggleSwitch } from "../components/ToggleSwitch";
import { AppIcon, type IconName } from "../components/icons/AppIcon";
import {
  addStashItem,
  listStash,
  removeStashItem,
  removeStashItems,
  stashTotalBytes,
  updateStashItem,
} from "../db/captureStash";
import { saveCapture, type SaveDestination } from "../db/captureSave";
import { loadConnection } from "../db/syncConnection";
import { notifyLocalChange } from "../lib/sync/localChange";
import { requestAutoSync } from "../lib/sync/autoSync";
import { transferAttachmentsByIds } from "../lib/sync/attachmentTransfer";
import {
  MAX_CAPTURE_ITEMS,
  deleteStoredFileQuietly,
  fileUriFromPath,
  pathFromFileUri,
  persistIntoCaptureStore,
} from "../lib/capture/storage";
import { describeQuotaRejection, planCaptureBatch } from "../lib/capture/limits";
import { clearCaptureDraft, loadCaptureDraft, saveCaptureDraft } from "../lib/capture/draft";
import { formatBytes, formatDuration } from "../lib/capture/summary";
import { describeError } from "../lib/errors";
import { newId } from "../lib/id";
import type { CaptureIntent, Nav, RouteKey } from "../lib/nav";
import { consumePendingShare, subscribePendingShare } from "../lib/pendingShare";
import { offerImageDraft, offerLinkDraft, offerSnippetDraft, offerTextDraft } from "../features/tools/shareIntake";
import { sendToolFileToDesktop } from "../features/tools/shared/sendToDesktop";
import type { CaptureSource, StashedItem } from "../domain/types";
import { useTheme } from "../theme/ThemeProvider";
import { font, radius, space } from "../theme/tokens";

type Mode = "compose" | "camera" | "voice";

const DESTINATION_OPTIONS: { value: SaveDestination; label: string }[] = [
  { value: "capture", label: "收集箱" },
  { value: "task", label: "任务" },
  { value: "note", label: "笔记" },
];

const SOURCE_LABEL: Record<CaptureSource, string> = {
  manual: "手动",
  camera: "相机",
  album: "相册",
  share: "系统分享",
  voice: "录音",
  file: "文件",
};

function itemIcon(item: StashedItem): IconName {
  if (item.kind === "image") return "fileImage";
  if (item.kind === "audio") return "fileAudio";
  return "fileGeneric";
}

/** 分享文本是否是一个可以直接保存为资料/GitHub 的链接（只认 http/https）。 */
function isHttpLink(text: string): boolean {
  return /^https?:\/\/[^\s]+$/i.test(text.trim());
}

/**
 * 原生模块拒绝调用时，Expo 会把整段 `Call to function ... rejected. → Caused by:
 * java.lang.IllegalStateException: xxx` 塞进 Error.message。用户在屏幕上只需要
 * 最后那段业务原因，这里剥掉调用栈前缀，避免 toast 里出现内部函数名。
 */
function voiceErrorText(error: unknown): string {
  const raw = describeError(error);
  const tail = raw.split("Caused by:").pop() ?? raw;
  const business = tail.split("IllegalStateException:").pop() ?? tail;
  const cleaned = business.replace(/\s+/g, " ").trim();
  return (cleaned || "录音模块调用失败").slice(0, 60);
}

export function CaptureScreen({
  nav,
  onDataChanged,
  intent = "capture",
  intentNonce,
}: {
  nav: Nav;
  onDataChanged: () => void;
  intent?: CaptureIntent;
  /** 采集中心已打开时收到新快捷动作：序号变化代表用户重新选择了模式 */
  intentNonce?: number;
}) {
  const { tokens } = useTheme();
  const [permission, requestPermission] = useCameraPermissions();
  /** 采集会话幂等键：整屏生命周期内复用，重复点保存不会落两条收集箱记录 */
  const sessionId = useRef(newId("cap"));
  const appliedIntentNonce = useRef(intentNonce ?? 0);
  const [mode, setMode] = useState<Mode>(
    intent === "camera" ? "camera" : intent === "voice" ? "voice" : "compose",
  );
  const [text, setText] = useState("");
  const [items, setItems] = useState<StashedItem[]>([]);
  const [destination, setDestination] = useState<SaveDestination>(
    intent === "task" ? "task" : "capture",
  );
  const [sendToDesktop, setSendToDesktop] = useState(false);
  const [paired, setPaired] = useState(false);
  const [staging, setStaging] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  /** 记录因超限/权限被拒绝的分享项，必须显示给用户，不能静默吞掉 */
  const [rejected, setRejected] = useState<string[]>([]);
  const [recording, setRecording] = useState(false);
  const [recordStartedAt, setRecordStartedAt] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  /** 系统分享进来的内容：给「分享快捷处理」用；只保留本次分享，不覆盖用户输入 */
  const [shareQuick, setShareQuick] = useState<{
    text: string;
    imageUri: string | null;
    imageName: string;
    mime: string;
  } | null>(null);
  const [shareSending, setShareSending] = useState(false);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [voiceResultId, setVoiceResultId] = useState<string | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [shotBusy, setShotBusy] = useState(false);
  const cameraRef = useRef<CameraView>(null);
  const [transcripts, setTranscripts] = useState<Record<string, string>>({});

  const { showToast } = useToast();

  // 采集中心已打开时再次收到快捷动作（热启动）：切到用户这次选择的模式。
  // 不能只依赖首次挂载的 intent，也不能因为「页面已存在」就静默忽略。
  useEffect(() => {
    if (intentNonce === undefined) return;
    if (intentNonce === appliedIntentNonce.current) return;
    appliedIntentNonce.current = intentNonce;
    setMode(intent === "camera" ? "camera" : intent === "voice" ? "voice" : "compose");
    if (intent === "task") setDestination("task");
    setResult(null);
  }, [intent, intentNonce]);

  // 暂存项的可信计数：批量导入连续 await 期间 React state 不会及时更新，
  // 只读 state 会把 7 项 + 5 张全部入库再隐藏。ref 与 state 同步推进，
  // 数据库还有一层 addStashItem 守卫（并发点击也守得住）。
  const itemsRef = useRef<StashedItem[]>([]);
  const replaceItems = useCallback((next: StashedItem[]) => {
    itemsRef.current = next;
    setItems(next);
  }, []);
  const pushItem = useCallback((item: StashedItem) => {
    itemsRef.current = [...itemsRef.current, item];
    setItems(itemsRef.current);
  }, []);

  /** 把一批来源文件按配额加入本次采集；返回成功数量，失败逐项提示。 */
  const stageFiles = useCallback(
    async (
      files: readonly { uri: string; size: number | null; type?: string | null; name?: string | null }[],
      kindOf: (file: { type?: string | null }) => StashedItem["kind"],
      source: CaptureSource,
      extra: (stored: { size: number }) => {
        width?: number | null;
        height?: number | null;
        durationMs?: number | null;
      } = () => ({}),
    ): Promise<number> => {
      const current = itemsRef.current;
      const plan = planCaptureBatch({
        itemCount: current.length,
        usedBytes: stashTotalBytes(current),
        candidates: files.map((file) => ({ size: file.size, name: file.name ?? "" })),
      });
      for (const rejection of plan.rejected) {
        setRejected((prev) => [
          ...prev,
          `${rejection.name || "文件"}：${describeQuotaRejection(rejection.reason)}`,
        ]);
      }
      let added = 0;
      for (const accept of plan.accepted) {
        const file = files[accept.index];
        let stored: Awaited<ReturnType<typeof persistIntoCaptureStore>> | null = null;
        try {
          stored = await persistIntoCaptureStore(
            { uri: file.uri, size: file.size, type: file.type, name: file.name ?? null },
            { kind: kindOf(file), usedBytes: stashTotalBytes(itemsRef.current) },
          );
          const staged = await addStashItem({
            kind: kindOf(file),
            mime: stored.mime,
            name: stored.name,
            localUri: stored.localUri,
            size: stored.size,
            source,
            ...extra(stored),
          });
          pushItem(staged);
          added += 1;
        } catch (error) {
          // 落库失败时清掉刚复制出的私有文件，避免留下无业务引用的孤儿；
          // 配额失败发生在复制之前，persistIntoCaptureStore 内部已自清半成品。
          if (stored?.localUri) deleteStoredFileQuietly(stored.localUri);
          setRejected((prev) => [...prev, `${file.name ?? "文件"}：${describeError(error)}`]);
        }
      }
      if (plan.rejected.length > 0 || added < plan.accepted.length) {
        showToast(
          `${added} 项已加入，${plan.rejected.length + (plan.accepted.length - added)} 项未加入`,
          "warn",
        );
      }
      return added;
    },
    [pushItem, showToast],
  );

  // ── 暂存恢复 + 分享载荷接入 ───────────────────────────────────────────
  const stagePayload = useCallback(
    async (payload: ShareIntentPayload): Promise<number> => {
      const reasons = (payload.rejected ?? []).map((item) => `${item.name}：${item.reason}`);
      const incoming = (payload.items ?? []).map((item) => ({
        ...item,
        localUri: fileUriFromPath(item.path),
      }));
      const plan = planCaptureBatch({
        itemCount: itemsRef.current.length,
        usedBytes: stashTotalBytes(itemsRef.current),
        candidates: incoming.map((item) => ({ size: item.size, name: item.name })),
      });
      // 未接收的分享副本必须清掉：原生已把它们复制进私有目录，留在磁盘就是无引用文件
      for (const rejection of plan.rejected) {
        const item = incoming[rejection.index];
        deleteStoredFileQuietly(item.localUri);
        reasons.push(`${item.name || "文件"}：${describeQuotaRejection(rejection.reason)}`);
      }
      let added = 0;
      for (const accept of plan.accepted) {
        const item = incoming[accept.index];
        try {
          const staged = await addStashItem({
            kind: item.kind,
            mime: item.mime,
            name: item.name,
            localUri: item.localUri,
            size: item.size,
            source: "share",
          });
          pushItem(staged);
          added += 1;
        } catch (error) {
          deleteStoredFileQuietly(item.localUri);
          reasons.push(`${item.name || "文件"}：${describeError(error)}`);
        }
      }
      if (reasons.length > 0) setRejected((prev) => [...prev, ...reasons]);
      if (payload.text) setText((prev) => (prev.trim() ? `${prev}\n${payload.text}` : payload.text ?? ""));
      const firstImage = incoming.find((item) => item.kind === "image");
      if (payload.text || added > 0) {
        setShareQuick({
          text: payload.text ?? "",
          imageUri: firstImage?.localUri ?? null,
          imageName: firstImage?.name ?? "分享图片",
          mime: firstImage?.mime ?? "image/jpeg",
        });
      }
      return added;
    },
    [pushItem],
  );

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const [stashed, connection, draft] = await Promise.all([
          listStash(),
          loadConnection(),
          loadCaptureDraft(),
        ]);
        if (!active) return;
        replaceItems(stashed);
        setTranscripts(
          Object.fromEntries(
            stashed.filter((item) => item.transcript).map((item) => [item.id, item.transcript ?? ""]),
          ),
        );
        setPaired(Boolean(connection));
        // 草稿先于分享载荷恢复：分享文本只能追加在用户已有输入之后，不能覆盖
        if (draft) {
          setText(draft.text);
          if (intent !== "task") setDestination(draft.destination);
        }
        const payload = consumePendingShare();
        if (payload) {
          await stagePayload(payload);
          // 分享文本在进入页面时先落一次草稿：即使用户立刻被杀进程，也不会只剩暂存附件。
          // 附件由 stagePayload 写入 capture_stash，本身已持久化。
          const baseText = draft?.text ?? "";
          const mergedText = payload.text
            ? baseText.trim()
              ? `${baseText}\n${payload.text}`
              : payload.text
            : baseText;
          await saveCaptureDraft({
            text: mergedText,
            destination: draft?.destination ?? "capture",
          }).catch(() => undefined);
        }
      } catch (error) {
        if (active) showToast(`读取本机采集失败：${describeError(error)}`, "danger");
      } finally {
        if (active) setLoaded(true);
      }
    })();
    return () => {
      active = false;
    };
  }, [intent, replaceItems, showToast, stagePayload]);

  // 运行中又收到系统分享：直接追加到当前采集，不新开页面、不丢已有输入
  useEffect(
    () =>
      subscribePendingShare(() => {
        const payload = consumePendingShare();
        if (payload) void stagePayload(payload);
      }),
    [stagePayload],
  );

  // 草稿防抖落盘：每敲一个字就写 SQLite 会产生高频写；700ms 合并一次，
  // 离开页面/保存时另有显式落盘（见 leave/handleSave），短时间 killed 也最多丢最后 0.7s。
  useEffect(() => {
    if (!loaded) return;
    const timer = setTimeout(() => {
      void saveCaptureDraft({ text, destination }).catch(() => undefined);
    }, 700);
    return () => clearTimeout(timer);
  }, [destination, loaded, text]);

  // ── 录音计时（仅在录音期间存在定时器，离开即清理）─────────────────────
  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(() => setElapsedMs(Date.now() - recordStartedAt), 500);
    return () => clearInterval(timer);
  }, [recording, recordStartedAt]);

  const stopRecordingSafely = useCallback(
    (discard: boolean) => {
      if (!voiceRecorderAvailable) {
        setRecording(false);
        return;
      }
      try {
        if (discard) VoiceRecorder?.cancelRecording();
      } catch {
        // 取消失败不影响页面状态复位
      }
      setRecording(false);
      setElapsedMs(0);
      setRecordStartedAt(0);
    },
    [],
  );

  // 离开屏幕：录音必须停下，否则麦克风/文件句柄会一直被占用。
  // 依赖必须是「空数组 + ref」：把 recording 放进依赖会让 stopRecordingSafely 在
  // setRecording(false) 之后立刻触发清理，进而 cancelRecording 把刚录好的文件删掉。
  const recordingRef = useRef(false);
  useEffect(() => {
    recordingRef.current = recording;
  }, [recording]);
  useEffect(
    () => () => {
      if (recordingRef.current) stopRecordingSafely(true);
      try {
        VoiceRecorder?.stopPlayback();
      } catch {
        // 模块缺失或已释放
      }
    },
    [stopRecordingSafely],
  );

  const dirty = text.trim().length > 0 || items.length > 0;

  const leave = useCallback(() => {
    if (recording) stopRecordingSafely(true);
    // 离开前把当前文字落成草稿：附件已在暂存表，文字不能只活在组件 state 里
    void saveCaptureDraft({ text, destination }).catch(() => undefined);
    // 暂存项已落库，退出不是丢弃：保留在暂存区，下次进入可以继续
    nav.back();
  }, [destination, nav, recording, stopRecordingSafely, text]);

  const confirmDiscard = useCallback(() => {
    Alert.alert(`清空列表中的 ${items.length} 项？`, "只删除当前列表里的内容，其他采集会话与已保存附件不受影响。", [
      { text: "保留", style: "cancel" },
      {
        text: "清空",
        style: "destructive",
        onPress: () => {
          void (async () => {
            try {
              if (recording) stopRecordingSafely(true);
              // 只删当前列表里用户看到的这几项，不整表清空：另一采集会话或系统分享
              // 中途接入的暂存行不属于本次「清空」范围。
              await removeStashItems(items.map((item) => item.id));
              replaceItems([]);
              setText("");
              setTranscripts({});
              await clearCaptureDraft();
              showToast("已清空本次采集", "info");
            } catch (error) {
              showToast(`清空失败：${describeError(error)}`, "danger");
            }
          })();
        },
      },
    ]);
  }, [recording, showToast, stopRecordingSafely]);

  // 硬件返回：相机/录音模式先退回编辑态；录音中先取消而不是直接离开
  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (mode === "camera") {
        setMode("compose");
        return true;
      }
      if (mode === "voice") {
        if (recording) {
          stopRecordingSafely(true);
          showToast("已取消本次录音", "info");
          return true;
        }
        if (playingId) {
          try {
            VoiceRecorder?.stopPlayback();
          } catch {
            // 播放器已释放
          }
          setPlayingId(null);
        }
        setVoiceResultId(null);
        setElapsedMs(0);
        setMode("compose");
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [mode, playingId, recording, showToast, stopRecordingSafely]);

  // ── 采集动作 ─────────────────────────────────────────────────────────
  const stagePersisted = useCallback(
    async (
      file: { localUri: string; name: string; mime: string; size: number },
      kind: StashedItem["kind"],
      source: CaptureSource,
      extra: { width?: number | null; height?: number | null; durationMs?: number | null } = {},
    ) => {
      // 单件也走同一配额判定：itemsRef 是同步推进的计数，不读可能过期的 state
      const plan = planCaptureBatch({
        itemCount: itemsRef.current.length,
        usedBytes: stashTotalBytes(itemsRef.current),
        candidates: [{ size: file.size, name: file.name }],
      });
      if (plan.accepted.length === 0) {
        const rejection = plan.rejected[0];
        deleteStoredFileQuietly(file.localUri);
        const reason = rejection ? describeQuotaRejection(rejection.reason) : "超出本次采集上限";
        setRejected((prev) => [...prev, `${file.name || "文件"}：${reason}`]);
        showToast(reason, "warn");
        return null;
      }
      try {
        const staged = await addStashItem({
          kind,
          mime: file.mime,
          name: file.name,
          localUri: file.localUri,
          size: file.size,
          source,
          width: extra.width ?? null,
          height: extra.height ?? null,
          durationMs: extra.durationMs ?? null,
        });
        pushItem(staged);
        showToast("已加入本次采集", "success");
        return staged;
      } catch (error) {
        deleteStoredFileQuietly(file.localUri);
        showToast(`加入采集失败：${describeError(error)}`, "danger");
        return null;
      }
    },
    [pushItem, showToast],
  );

  const takePhoto = useCallback(async () => {
    if (!cameraRef.current || shotBusy || staging) return;
    setShotBusy(true);
    try {
      // 采集不再静默降质：0.95 接近原图，上传体积由 50MB 上限兜底；
      // 需要更小副本时由用户在整理页明确裁剪/压缩，不默认损失原图。
      const shot = await cameraRef.current.takePictureAsync({ quality: 0.95 });
      if (!shot?.uri) throw new Error("相机没有返回照片");
      const stored = await persistIntoCaptureStore(
        { uri: shot.uri, size: null, type: "image/jpeg", name: "photo.jpg" },
        { kind: "image", name: "photo.jpg", usedBytes: stashTotalBytes(itemsRef.current) },
      );
      // 相机把原图写在缓存目录：复制进私有存储后再删缓存，避免缓存越积越大
      deleteStoredFileQuietly(shot.uri);
      await stagePersisted(stored, "image", "camera", { width: shot.width, height: shot.height });
    } catch (error) {
      showToast(`拍照失败：${describeError(error)}`, "danger");
    } finally {
      setShotBusy(false);
    }
  }, [shotBusy, showToast, stagePersisted, staging]);

  const pickImages = useCallback(async () => {
    if (staging) return;
    setStaging(true);
    try {
      const picked = await File.pickFileAsync({ multipleFiles: true, mimeTypes: ["image/*"] });
      if (picked.canceled || !picked.result) return;
      const files = Array.isArray(picked.result) ? picked.result : [picked.result];
      // 真实剩余名额由 itemsRef + 数据库计数决定；超出的图片不会先入库再被隐藏
      const capacity = MAX_CAPTURE_ITEMS - itemsRef.current.length;
      if (capacity <= 0) {
        showToast(`一次最多 ${MAX_CAPTURE_ITEMS} 项，请先保存或删除部分内容`, "warn");
        return;
      }
      await stageFiles(
        files.map((file) => ({
          uri: file.uri,
          size: file.size,
          type: file.type,
          name: file.uri.split("/").pop() ?? null,
        })),
        () => "image",
        "album",
      );
    } catch (error) {
      showToast(`选择图片失败：${describeError(error)}`, "danger");
    } finally {
      setStaging(false);
    }
  }, [showToast, stageFiles, staging]);

  const pickFiles = useCallback(async () => {
    if (staging) return;
    setStaging(true);
    try {
      const picked = await File.pickFileAsync({ multipleFiles: true, mimeTypes: ["*/*"] });
      if (picked.canceled || !picked.result) return;
      const files = Array.isArray(picked.result) ? picked.result : [picked.result];
      if (MAX_CAPTURE_ITEMS - itemsRef.current.length <= 0) {
        showToast(`一次最多 ${MAX_CAPTURE_ITEMS} 项，请先保存或删除部分内容`, "warn");
        return;
      }
      await stageFiles(
        files.map((file) => ({
          uri: file.uri,
          size: file.size,
          type: file.type,
          name: file.uri.split("/").pop() ?? null,
        })),
        (file) =>
          file.type?.startsWith("image/")
            ? "image"
            : file.type?.startsWith("audio/")
              ? "audio"
              : "file",
        "file",
      );
    } catch (error) {
      showToast(`选择文件失败：${describeError(error)}`, "danger");
    } finally {
      setStaging(false);
    }
  }, [showToast, stageFiles, staging]);

  const startRecording = useCallback(async () => {
    if (recording || voiceBusy) return;
    if (!voiceRecorderAvailable) {
      showToast("当前构建未包含录音模块，请安装新版安装包后再用语音速记", "warn");
      return;
    }
    setVoiceBusy(true);
    try {
      const granted = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
      if (granted !== PermissionsAndroid.RESULTS.GRANTED) {
        showToast("没有麦克风权限，无法录音；可在系统设置里允许后重试", "warn");
        return;
      }
      const started = VoiceRecorder?.startRecording(`voice_${sessionId.current}`);
      if (!started) throw new Error("录音模块没有返回结果");
      setRecording(true);
      setRecordStartedAt(Date.now());
      setElapsedMs(0);
      setVoiceResultId(null);
      setMode("voice");
    } catch (error) {
      showToast(`开始录音失败：${voiceErrorText(error)}`, "danger");
    } finally {
      setVoiceBusy(false);
    }
  }, [recording, sessionId, showToast, voiceBusy]);

  const finishRecording = useCallback(async () => {
    if (!recording || !VoiceRecorder || voiceBusy) return;
    setVoiceBusy(true);
    try {
      const stopped = VoiceRecorder.stopRecording();
      setRecording(false);
      const duration = formatDuration(stopped.durationMs) ?? "0:00";
      // 录音先用私有存储里的临时文件，这里复制进统一的采集附件目录：
      // 附件行只引用 `files/capture/`，试听、发送到电脑、清理都走同一条路径。
      const persisted = await persistIntoCaptureStore(
        {
          uri: fileUriFromPath(stopped.path),
          size: stopped.size,
          type: "audio/mp4",
          name: `语音 ${duration}.m4a`,
        },
        { kind: "audio", name: `语音 ${duration}`, usedBytes: items.reduce((sum, item) => sum + item.size, 0) },
      );
      const staged = await stagePersisted(persisted, "audio", "voice", {
        durationMs: stopped.durationMs,
      });
      try {
        VoiceRecorder.deleteFile(stopped.path);
      } catch {
        // 临时文件清理失败不影响已保存的副本
      }
      setElapsedMs(staged ? stopped.durationMs : 0);
      setRecordStartedAt(0);
      setVoiceResultId(staged?.id ?? null);
      // 停在语音结果页，让用户直接试听、删除、重录或保存；不再自动跳回编辑态。
      setMode("voice");
    } catch (error) {
      setRecording(false);
      setElapsedMs(0);
      setRecordStartedAt(0);
      showToast(`结束录音失败：${voiceErrorText(error)}`, "danger");
    } finally {
      setVoiceBusy(false);
    }
  }, [items, recording, showToast, stagePersisted, voiceBusy]);

  const cancelRecording = useCallback(() => {
    stopRecordingSafely(true);
    setRecording(false);
    setElapsedMs(0);
    setRecordStartedAt(0);
    setVoiceBusy(false);
    setMode("voice");
    showToast("已取消录音，临时文件已删除", "info");
  }, [showToast, stopRecordingSafely]);

  const handlePlay = useCallback(
    async (item: StashedItem) => {
      if (!VoiceRecorder) {
        showToast("当前构建未包含播放模块", "warn");
        return;
      }
      try {
        if (playingId === item.id) {
          VoiceRecorder.stopPlayback();
          setPlayingId(null);
          return;
        }
        VoiceRecorder.play(pathFromFileUri(item.localUri));
        setPlayingId(item.id);
      } catch (error) {
        setPlayingId(null);
        showToast(`试听失败：${voiceErrorText(error)}`, "danger");
      }
    },
    [playingId, showToast],
  );

  const handleRemove = useCallback(
    async (item: StashedItem): Promise<boolean> => {
      try {
        if (playingId === item.id) {
          VoiceRecorder?.stopPlayback();
          setPlayingId(null);
        }
        await removeStashItem(item.id);
        replaceItems(itemsRef.current.filter((row) => row.id !== item.id));
        setTranscripts((prev) => {
          const next = { ...prev };
          delete next[item.id];
          return next;
        });
        return true;
      } catch (error) {
        showToast(`删除失败：${describeError(error)}`, "danger");
        return false;
      }
    },
    [playingId, showToast],
  );

  const handleTranscript = useCallback(
    (item: StashedItem, value: string) => {
      setTranscripts((prev) => ({ ...prev, [item.id]: value }));
    },
    [],
  );

  const voiceResult = useMemo(
    () => (voiceResultId ? items.find((item) => item.id === voiceResultId) ?? null : null),
    [items, voiceResultId],
  );

  const deleteVoiceResult = useCallback(async () => {
    if (!voiceResult || voiceBusy) return;
    setVoiceBusy(true);
    try {
      const removed = await handleRemove(voiceResult);
      if (removed) {
        setVoiceResultId(null);
        setElapsedMs(0);
        showToast("已删除本次录音", "success");
      }
    } finally {
      setVoiceBusy(false);
    }
  }, [handleRemove, showToast, voiceBusy, voiceResult]);

  const restartVoice = useCallback(async () => {
    if (voiceBusy) return;
    if (voiceResult) {
      const removed = await handleRemove(voiceResult);
      if (!removed) return;
    }
    setVoiceResultId(null);
    setElapsedMs(0);
    await startRecording();
  }, [handleRemove, startRecording, voiceBusy, voiceResult]);

  const persistTranscript = useCallback(
    async (item: StashedItem, value: string) => {
      try {
        await updateStashItem(item.id, { transcript: value.trim() ? value : null });
      } catch {
        // 转写是可选内容：落库失败不阻塞保存，主流程仍可用
      }
    },
    [],
  );

  // ── 统一保存 ─────────────────────────────────────────────────────────
  const canSave = !saving && (text.trim().length > 0 || items.length > 0);

  const handleSave = useCallback(async () => {
    if (saving) return;
    if (!canSave) {
      showToast("先输入内容，或拍一张照片、录一段语音、选一个文件", "warn");
      return;
    }
    if (recording) {
      showToast("请先结束录音，再保存", "warn");
      return;
    }
    setSaving(true);
    try {
      // 批注过的语音要点并入正文：用户不写正文时，转写就是内容本身
      const transcriptText = Object.values(transcripts)
        .map((value) => value.trim())
        .filter(Boolean)
        .join("\n");
      const effectiveText = text.trim() || transcriptText;
      const saved = await saveCapture({
        destination,
        text: effectiveText,
        items,
        clientId: sessionId.current,
      });

      let message =
        destination === "capture"
          ? "已保存到收集箱"
          : destination === "task"
            ? "已创建任务"
            : "已保存为笔记";
      if (items.length > 0) {
        // 文本与附件生命周期不同：文本走同步（可能还没上传成功），附件留在本机等待传送
        message += ` · ${items.length} 个附件留在本机（文字同步与附件传送分开显示）`;
      }
      if (saved.duplicated) message = "这条内容已经保存过，没有重复创建记录";

      if (sendToDesktop && saved.attachmentIds.length > 0) {
        // 只发送「本次保存」产生的附件 id：历史积压交给同步页/后台批量，
        // 否则刚拍的两张会排在 10 个历史附件后面，用户以为没发出去。
        const outcome = await transferAttachmentsByIds(saved.attachmentIds);
        if (outcome.unavailable) {
          message += `；发送到电脑需要先配对：${outcome.message ?? "尚未配对"}`;
        } else {
          if (outcome.sent > 0) message += `；已发送 ${outcome.sent} 个本次附件到电脑`;
          if (outcome.failed > 0) {
            message += `；${outcome.failed} 个发送失败：${outcome.errors.slice(0, 2).join("；")}`;
          }
          if (outcome.handledIds.length < saved.attachmentIds.length) {
            message += `；${saved.attachmentIds.length - outcome.handledIds.length} 个未处理，可在同步页重试`;
          }
        }
      } else if (items.length > 0) {
        message += "；附件不会自动上传，需要时在同步页开启或手动发送";
      }

      setResult(message);
      replaceItems([]);
      setText("");
      setTranscripts({});
      setRejected([]);
      setSendToDesktop(false);
      setVoiceResultId(null);
      setElapsedMs(0);
      setPlayingId(null);
      try {
        VoiceRecorder?.stopPlayback();
      } catch {
        // 播放器已释放
      }
      await clearCaptureDraft().catch(() => undefined);
      sessionId.current = newId("cap");
      notifyLocalChange();
      requestAutoSync("manual_after_save");
      onDataChanged();
      setMode("compose");
    } catch (error) {
      showToast(`保存失败：${describeError(error)}`, "danger");
    } finally {
      setSaving(false);
    }
  }, [
    canSave,
    destination,
    items,
    onDataChanged,
    recording,
    sendToDesktop,
    saving,
    sessionId,
    showToast,
    text,
    transcripts,
  ]);

  const openCamera = useCallback(async () => {
    if (!permission?.granted) {
      const response = await requestPermission();
      if (!response.granted) {
        showToast("没有相机权限，可改用相册导入", "warn");
        return;
      }
    }
    setMode("camera");
  }, [permission?.granted, requestPermission, showToast]);

  const totalBytes = useMemo(() => items.reduce((sum, item) => sum + item.size, 0), [items]);
  const totalDuration = useMemo(
    () => items.reduce((sum, item) => sum + (item.durationMs ?? 0), 0),
    [items],
  );

  // ── 系统分享快捷处理（J）：不替换采集流程，只在分享来源的会话里提供入口 ──
  const openSharedTextTool = (route: RouteKey, mode: "snippet" | "text") => {
    const value = shareQuick?.text?.trim() ?? "";
    if (!value) {
      showToast("这次分享没有可处理的文本", "warn");
      return;
    }
    if (mode === "snippet") offerSnippetDraft(value);
    else offerTextDraft(value);
    nav.push(route);
  };

  const openSharedLinkTool = (route: RouteKey) => {
    const value = shareQuick?.text?.trim() ?? "";
    if (!isHttpLink(value)) {
      showToast("分享内容不是 http/https 链接", "warn");
      return;
    }
    offerLinkDraft(value);
    nav.push(route);
  };

  const openSharedImageTool = (route: RouteKey) => {
    if (!shareQuick?.imageUri) {
      showToast("这次分享没有图片", "warn");
      return;
    }
    offerImageDraft(shareQuick.imageUri, shareQuick.imageName);
    nav.push(route);
  };

  const sendSharedImage = async () => {
    if (!shareQuick?.imageUri || shareSending) return;
    setShareSending(true);
    try {
      const outcome = await sendToolFileToDesktop({
        uri: shareQuick.imageUri,
        fileName: shareQuick.imageName,
        mime: shareQuick.mime,
      });
      showToast(outcome.message, outcome.ok ? "success" : "warn");
    } catch (error) {
      showToast(`发送失败：${describeError(error)}`, "danger");
    } finally {
      setShareSending(false);
    }
  };

  const sharedText = shareQuick?.text.trim() ?? "";
  const sharedIsLink = isHttpLink(sharedText);
  const showShareQuick = Boolean(shareQuick && (sharedText || shareQuick.imageUri));

  return (
    <View style={styles.container} testID="capture-screen">
      <AppBar
        title={mode === "camera" ? "拍照采集" : mode === "voice" ? "语音速记" : "快速采集"}
        badge={
          mode === "compose" && items.length > 0 ? (
            <Badge label={`${items.length} 项`} tone="active" />
          ) : undefined
        }
        onBack={() => {
          if (mode === "voice") {
            if (recording) {
              cancelRecording();
              setMode("compose");
              return;
            }
            if (playingId) {
              try {
                VoiceRecorder?.stopPlayback();
              } catch {
                // 播放器已释放
              }
              setPlayingId(null);
            }
            // 离开语音页只收起结果视图；录音仍在采集列表/本机素材库里。
            setVoiceResultId(null);
            setElapsedMs(0);
            setMode("compose");
            return;
          }
          if (mode !== "compose") {
            setMode("compose");
            return;
          }
          leave();
        }}
        right={
          mode === "compose" ? (
            <PressableScale
              onPress={confirmDiscard}
              accessibilityLabel="清空本次采集"
              disabled={!dirty}
              contentStyle={styles.headerAction}
            >
              <Text style={[styles.headerActionText, { color: dirty ? tokens.danger : tokens.faint }]}>
                清空
              </Text>
            </PressableScale>
          ) : undefined
        }
      />

      {mode === "camera" ? (
        <View style={styles.cameraWrap}>
          <View style={[styles.cameraStage, { backgroundColor: tokens.ink }]}>
            {permission?.granted ? (
              <CameraView ref={cameraRef} style={StyleSheet.absoluteFill} facing="back" />
            ) : (
              <View style={styles.cameraPermission}>
                <Text style={[styles.cameraPermissionText, { color: tokens.inkText }]}>
                  需要相机权限才能拍照采集
                </Text>
                <PressableScale
                  onPress={() => void requestPermission()}
                  accessibilityLabel="允许使用相机"
                  contentStyle={[styles.cameraButton, { backgroundColor: tokens.accentFill }]}
                >
                  <Text style={[styles.cameraButtonText, { color: tokens.onAccent }]}>允许使用相机</Text>
                </PressableScale>
              </View>
            )}
            {shotBusy ? (
              <View style={styles.cameraBusy}>
                <ActivityIndicator color={tokens.onAccent} />
              </View>
            ) : null}
          </View>
          <View style={styles.cameraBar}>
            <PressableScale
              onPress={() => setMode("compose")}
              accessibilityLabel="返回编辑"
              contentStyle={[styles.cameraSecondary, { borderColor: tokens.cardBorder }]}
            >
              <Text style={[styles.cameraSecondaryText, { color: tokens.textSoft }]}>完成</Text>
            </PressableScale>
            <PressableScale
              onPress={() => void takePhoto()}
              accessibilityLabel="拍照"
              disabled={shotBusy}
              contentStyle={[styles.shutter, { backgroundColor: tokens.accentFill, opacity: shotBusy ? 0.5 : 1 }]}
            >
              <AppIcon name="scan" size={24} color={tokens.onAccent} />
            </PressableScale>
            <View style={styles.cameraCount}>
              <Text style={[styles.cameraCountText, { color: tokens.textSoft }]}>
                {items.filter((item) => item.source === "camera").length} 张
              </Text>
            </View>
          </View>
          <Text style={[styles.cameraHint, { color: tokens.faint }]}>
            每按一次记一张，最多 {MAX_CAPTURE_ITEMS} 张；点「完成」回到保存页
          </Text>
        </View>
      ) : null}

      {mode === "voice" ? (
        <ScrollView
          contentContainerStyle={styles.voiceWrap}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          <GlassCard style={styles.voiceCard}>
            <PressableScale
              onPress={() => {
                if (recording) void finishRecording();
                else if (voiceResult) void handlePlay(voiceResult);
                else void startRecording();
              }}
              accessibilityLabel={
                recording
                  ? "停止录音并保留"
                  : voiceResult
                    ? playingId === voiceResult.id
                      ? "暂停试听"
                      : "试听录音"
                    : "开始录音"
              }
              accessibilityState={{ disabled: voiceBusy || saving }}
              disabled={voiceBusy || saving}
              style={styles.voiceMicPress}
              contentStyle={[
                styles.voiceMic,
                {
                  backgroundColor: tokens.accentFill,
                  opacity: voiceBusy || saving ? 0.72 : 1,
                },
              ]}
            >
              {voiceBusy && !recording ? (
                <ActivityIndicator color={tokens.onAccent} size="large" />
              ) : recording ? (
                <View style={[styles.voiceStopGlyph, { backgroundColor: tokens.onAccent }]} />
              ) : (
                <AppIcon
                  name={voiceResult ? "activity" : "mic"}
                  color={tokens.onAccent}
                  size={46}
                />
              )}
            </PressableScale>
            <Text style={[styles.voiceTimer, { color: tokens.text }]} accessibilityRole="timer">
              {formatDuration(recording ? elapsedMs : voiceResult?.durationMs ?? elapsedMs) ?? "0:00"}
            </Text>
            <Text
              style={[
                styles.voiceState,
                { color: recording || voiceResult ? tokens.text : tokens.muted },
              ]}
            >
              {recording
                ? "正在录音…再次点击中央按钮停止"
                : voiceBusy
                  ? "正在保存录音…"
                  : voiceResult
                    ? playingId === voiceResult.id
                      ? "正在试听录音"
                      : "录音已完成"
                    : "点击麦克风开始录音"}
            </Text>
            <Text style={[styles.voiceHelper, { color: tokens.faint }]}>
              {recording
                ? "停止后录音会保存到本机，可试听、删除或重新录制"
                : voiceResult
                  ? "录音已保存在本机素材库；保存后可按当前目标继续处理"
                  : "进入页面不会自动录音，点击后才会申请麦克风权限"}
            </Text>

            {recording ? (
              <PressableScale
                onPress={cancelRecording}
                accessibilityLabel="取消并删除本次录音"
                style={styles.voiceCancelPress}
                contentStyle={styles.voiceCancelButton}
              >
                <Text style={[styles.voiceCancelText, { color: tokens.danger }]}>取消并删除</Text>
              </PressableScale>
            ) : null}

            {voiceResult ? (
              <View style={[styles.voiceResult, { borderColor: tokens.separator }]}>
                <View style={styles.voiceResultHead}>
                  <View style={[styles.voiceResultIcon, { backgroundColor: tokens.okSoft }]}>
                    <AppIcon name="fileAudio" color={tokens.ok} size={24} />
                  </View>
                  <View style={styles.voiceResultText}>
                    <Text numberOfLines={1} style={[styles.voiceResultName, { color: tokens.text }]}>
                      {voiceResult.name}
                    </Text>
                    <Text numberOfLines={1} style={[styles.voiceResultMeta, { color: tokens.muted }]}>
                      录音已完成 · {formatBytes(voiceResult.size)} · 本机素材库
                    </Text>
                  </View>
                </View>
                <View style={styles.voiceResultActions}>
                  <PressableScale
                    onPress={() => void handlePlay(voiceResult)}
                    accessibilityLabel={playingId === voiceResult.id ? "暂停试听录音" : "试听录音"}
                    style={styles.voiceActionSlot}
                    contentStyle={[styles.voiceAction, { backgroundColor: tokens.accentSoft }]}
                  >
                    <Text style={[styles.voiceActionText, { color: tokens.accentText }]}>
                      {playingId === voiceResult.id ? "暂停试听" : "试听"}
                    </Text>
                  </PressableScale>
                  <PressableScale
                    onPress={() => void restartVoice()}
                    accessibilityLabel="删除当前录音并重新录制"
                    disabled={voiceBusy}
                    style={styles.voiceActionSlot}
                    contentStyle={[styles.voiceAction, { backgroundColor: tokens.track }]}
                  >
                    <Text style={[styles.voiceActionText, { color: tokens.textSoft }]}>重新录制</Text>
                  </PressableScale>
                  <PressableScale
                    onPress={() => void deleteVoiceResult()}
                    accessibilityLabel="删除本次录音"
                    disabled={voiceBusy}
                    style={styles.voiceActionSlot}
                    contentStyle={[styles.voiceAction, { backgroundColor: tokens.dangerSoft }]}
                  >
                    <Text style={[styles.voiceActionText, { color: tokens.danger }]}>删除</Text>
                  </PressableScale>
                  <PressableScale
                    onPress={() => void handleSave()}
                    accessibilityLabel="保存本次录音"
                    disabled={voiceBusy || saving}
                    style={styles.voiceActionSlot}
                    contentStyle={[
                      styles.voiceAction,
                      { backgroundColor: saving ? tokens.track : tokens.accentFill },
                    ]}
                  >
                    {saving ? (
                      <ActivityIndicator color={tokens.onAccent} size="small" />
                    ) : (
                      <Text style={[styles.voiceActionText, { color: tokens.onAccent }]}>
                        {destination === "capture"
                          ? "保存"
                          : destination === "task"
                            ? "创建任务"
                            : "保存为笔记"}
                      </Text>
                    )}
                  </PressableScale>
                </View>
              </View>
            ) : null}
          </GlassCard>
          <Text style={[styles.voiceHint, { color: tokens.faint }]}>
            录音只保存在这台手机上，不会自动上传。本机未接入离线语音识别，录完显示「尚未转写」；
            原文音频始终保留，方便以后接识别服务。
          </Text>
        </ScrollView>
      ) : null}

      {mode === "compose" ? (
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {result ? (
            <GlassCard style={[styles.resultCard, { borderColor: tokens.ok }]}>
              <View style={styles.resultRow}>
                <AppIcon name="success" size={18} color={tokens.ok} />
                <Text style={[styles.resultText, { color: tokens.text }]}>{result}</Text>
              </View>
              <View style={styles.resultActions}>
                <PressableScale
                  onPress={() => setResult(null)}
                  accessibilityLabel="继续采集"
                  contentStyle={[styles.resultPrimary, { backgroundColor: tokens.accentFill }]}
                >
                  <Text style={[styles.resultPrimaryText, { color: tokens.onAccent }]}>继续采集</Text>
                </PressableScale>
                <PressableScale
                  onPress={() => nav.back()}
                  accessibilityLabel="完成并返回"
                  contentStyle={styles.resultSecondary}
                >
                  <Text style={[styles.resultSecondaryText, { color: tokens.accentText }]}>完成</Text>
                </PressableScale>
              </View>
            </GlassCard>
          ) : null}

          {!loaded ? (
            <View style={styles.loadingRow}>
              <ActivityIndicator color={tokens.accent} />
              <Text style={[styles.loadingText, { color: tokens.muted }]}>正在恢复上次未保存的采集…</Text>
            </View>
          ) : null}

          {rejected.length > 0 ? (
            <GlassCard style={[styles.rejectedCard, { borderColor: tokens.warn }]}>
              <View style={styles.resultRow}>
                <AppIcon name="warning" size={18} color={tokens.warn} />
                <Text style={[styles.resultText, { color: tokens.text }]}>
                  {rejected.length} 项分享内容没有接入
                </Text>
              </View>
              {rejected.map((reason, index) => (
                <Text key={`${reason}-${index}`} style={[styles.rejectReason, { color: tokens.muted }]}>
                  · {reason}
                </Text>
              ))}
            </GlassCard>
          ) : null}

          {showShareQuick && shareQuick ? (
            <GlassCard style={[styles.shareCard, { borderColor: tokens.accent }]}>
              <View style={styles.shareHead}>
                <AppIcon name="share" size={18} color={tokens.accent} />
                <View style={styles.shareHeadText}>
                  <Text style={[styles.shareTitle, { color: tokens.text }]}>分享内容快捷处理</Text>
                  <Text style={[styles.shareHint, { color: tokens.muted }]}>
                    内容已在本机；选择工具不会上传，也不会自动发起网络请求
                  </Text>
                </View>
              </View>

              {sharedText ? (
                <View style={[styles.shareGroup, { borderTopColor: tokens.separator }]}>
                  <Text style={[styles.shareLabel, { color: tokens.textSoft }]} numberOfLines={1}>
                    {sharedIsLink ? "链接" : "文本"} · {sharedText.length} 字符
                  </Text>
                  <View style={styles.shareActions}>
                    {sharedIsLink ? (
                      <>
                        <ShareQuickButton icon="folder" label="项目资料" onPress={() => openSharedLinkTool("tool_docs")} />
                        <ShareQuickButton icon="code" label="GitHub" onPress={() => openSharedLinkTool("tool_github")} />
                      </>
                    ) : (
                      <>
                        <ShareQuickButton icon="snippet" label="常用片段" onPress={() => openSharedTextTool("tool_snippets", "snippet")} />
                        <ShareQuickButton icon="json" label="JSON 格式化" onPress={() => openSharedTextTool("tool_json", "text")} />
                        <ShareQuickButton icon="fileText" label="文本编解码" onPress={() => openSharedTextTool("tool_text_codec", "text")} />
                      </>
                    )}
                    <ShareQuickButton
                      icon="note"
                      label="保存为笔记"
                      onPress={() => {
                        setDestination("note");
                        showToast("已切到「保存为笔记」，检查内容后点底部保存", "info");
                      }}
                    />
                  </View>
                </View>
              ) : null}

              {shareQuick.imageUri ? (
                <View style={[styles.shareGroup, { borderTopColor: tokens.separator }]}>
                  <Text style={[styles.shareLabel, { color: tokens.textSoft }]}>
                    图片 · {shareQuick.imageName}
                  </Text>
                  <View style={styles.shareActions}>
                    <ShareQuickButton icon="gauge" label="压缩图片" onPress={() => openSharedImageTool("tool_image_compress")} />
                    <ShareQuickButton icon="sparkles" label="提取颜色" onPress={() => openSharedImageTool("tool_color_picker")} />
                    <ShareQuickButton
                      icon="desktop"
                      label={shareSending ? "发送中…" : "发送到电脑"}
                      onPress={() => void sendSharedImage()}
                    />
                  </View>
                  <Text style={[styles.shareHint, { color: tokens.muted }]}>
                    发送到电脑走已配对的文件互传；未配对时会明确提示，不会显示成已发送。
                  </Text>
                </View>
              ) : null}
            </GlassCard>
          ) : null}

          <GlassCard style={styles.composer}>
            <TextInput
              value={text}
              onChangeText={setText}
              multiline
              placeholder="快速记一句…也可以只拍照/录音，保存时自动带上时间"
              placeholderTextColor={tokens.faint}
              style={[styles.input, { color: tokens.text, borderColor: tokens.cardBorder }]}
              accessibilityLabel="采集内容"
              textAlignVertical="top"
              maxLength={4000}
            />
            <Text style={[styles.counter, { color: tokens.faint }]}>{text.length}/4000</Text>
          </GlassCard>

          {items.length > 0 ? (
            <View style={styles.itemList}>
              {items.map((item) => {
                const transcript = transcripts[item.id] ?? item.transcript ?? "";
                return (
                  <GlassCard key={item.id} style={styles.itemCard}>
                    <View style={styles.itemRow}>
                      {item.kind === "image" ? (
                        <Image
                          source={{ uri: item.localUri }}
                          style={styles.thumb}
                          accessibilityLabel={item.name || "采集图片"}
                        />
                      ) : (
                        <View style={[styles.fileTile, { backgroundColor: tokens.accentWash }]}>
                          <AppIcon name={itemIcon(item)} size={22} color={tokens.accentText} />
                        </View>
                      )}
                      <View style={styles.itemMeta}>
                        <Text numberOfLines={1} style={[styles.itemName, { color: tokens.text }]}>
                          {item.name || (item.kind === "image" ? "照片" : "附件")}
                        </Text>
                        <Text style={[styles.itemSub, { color: tokens.faint }]}>
                          {SOURCE_LABEL[item.source]}
                          {item.size > 0 ? ` · ${formatBytes(item.size)}` : ""}
                          {item.kind === "audio"
                            ? ` · ${formatDuration(item.durationMs) ?? "时长未知"}`
                            : ""}
                        </Text>
                      </View>
                      {item.kind === "audio" && item.source === "voice" ? (
                        <PressableScale
                          onPress={() => void handlePlay(item)}
                          accessibilityLabel={playingId === item.id ? "停止试听" : "试听录音"}
                          contentStyle={[styles.itemAction, { borderColor: tokens.cardBorder }]}
                        >
                          <AppIcon
                            name={playingId === item.id ? "close" : "activity"}
                            size={18}
                            color={tokens.accentText}
                          />
                        </PressableScale>
                      ) : null}
                      <PressableScale
                        onPress={() => void handleRemove(item)}
                        accessibilityLabel="删除这一项"
                        contentStyle={[styles.itemAction, { borderColor: tokens.cardBorder }]}
                      >
                        <AppIcon name="delete" size={18} color={tokens.danger} />
                      </PressableScale>
                    </View>
                    {item.kind === "audio" ? (
                      <View style={styles.transcriptBox}>
                        <Text style={[styles.transcriptLabel, { color: tokens.muted }]}>
                          尚未转写 · 可手写要点
                        </Text>
                        <TextInput
                          value={transcript}
                          onChangeText={(value) => handleTranscript(item, value)}
                          onBlur={() => void persistTranscript(item, transcript)}
                          multiline
                          placeholder="写下这段语音的要点（可选）"
                          placeholderTextColor={tokens.faint}
                          style={[
                            styles.transcriptInput,
                            { color: tokens.text, borderColor: tokens.cardBorder },
                          ]}
                          accessibilityLabel="语音要点"
                        />
                      </View>
                    ) : null}
                  </GlassCard>
                );
              })}
              <Text style={[styles.summaryLine, { color: tokens.faint }]}>
                共 {items.length} 项
                {totalBytes > 0 ? ` · ${formatBytes(totalBytes)}` : ""}
                {totalDuration > 0 ? ` · 语音 ${formatDuration(totalDuration)}` : ""}
              </Text>
            </View>
          ) : null}

          <View style={styles.pickerRow}>
            <PressableScale
              onPress={() => void openCamera()}
              accessibilityLabel="拍照"
              style={styles.pickerPress}
              contentStyle={[styles.picker, { backgroundColor: tokens.accentWash }]}
            >
              <AppIcon name="scan" size={20} color={tokens.accentText} />
              <Text style={[styles.pickerText, { color: tokens.accentText }]}>拍照</Text>
            </PressableScale>
            <PressableScale
              onPress={() => void pickImages()}
              accessibilityLabel="从相册选择图片"
              disabled={staging}
              style={styles.pickerPress}
              contentStyle={[styles.picker, { backgroundColor: tokens.accentWash }]}
            >
              <AppIcon name="fileImage" size={20} color={tokens.accentText} />
              <Text style={[styles.pickerText, { color: tokens.accentText }]}>相册</Text>
            </PressableScale>
            <PressableScale
              onPress={() => {
                setResult(null);
                setVoiceResultId(null);
                setElapsedMs(0);
                setMode("voice");
              }}
              accessibilityLabel="语音速记"
              style={styles.pickerPress}
              contentStyle={[styles.picker, { backgroundColor: tokens.accentWash }]}
            >
              <AppIcon name="activity" size={20} color={tokens.accentText} />
              <Text style={[styles.pickerText, { color: tokens.accentText }]}>语音</Text>
            </PressableScale>
            <PressableScale
              onPress={() => void pickFiles()}
              accessibilityLabel="选择文件"
              disabled={staging}
              style={styles.pickerPress}
              contentStyle={[styles.picker, { backgroundColor: tokens.accentWash }]}
            >
              <AppIcon name="folder" size={20} color={tokens.accentText} />
              <Text style={[styles.pickerText, { color: tokens.accentText }]}>文件</Text>
            </PressableScale>
          </View>

          <GlassCard style={styles.saveBox}>
            <Text style={[styles.saveLabel, { color: tokens.textSoft }]}>保存到</Text>
            <SegmentedControl
              options={DESTINATION_OPTIONS}
              value={destination}
              onChange={setDestination}
              accessibilityLabel="保存目标"
            />
            {destination === "task" ? (
              <Text style={[styles.saveHint, { color: tokens.faint }]}>
                标题取第一行文字，正文保留完整内容与附件；附件可在任务页打开
              </Text>
            ) : null}
            {destination === "note" ? (
              <Text style={[styles.saveHint, { color: tokens.faint }]}>
                保存到笔记，图片和录音随笔记保留在本机
              </Text>
            ) : null}
          </GlassCard>
        </ScrollView>
      ) : null}

      {mode === "compose" ? (
        <View style={[styles.footer, { borderColor: tokens.separator, backgroundColor: tokens.bg }]}>
          <View style={styles.sendRow}>
            <View style={styles.sendText}>
              <Text style={[styles.sendLabel, { color: tokens.textSoft }]}>同时发送到电脑</Text>
              <Text style={[styles.sendHint, { color: tokens.faint }]}>
                {paired
                  ? "通过已配对的安全连接传原始附件；失败可在同步页重试"
                  : "尚未配对桌面端，开启后请先在设备页完成配对"}
              </Text>
            </View>
            <ToggleSwitch
              value={sendToDesktop}
              onChange={setSendToDesktop}
              disabled={items.length === 0}
              accessibilityLabel="同时发送到电脑"
            />
          </View>
          <PressableScale
            onPress={() => void handleSave()}
            accessibilityLabel="保存这次采集"
            disabled={!canSave}
            contentStyle={[
              styles.saveButton,
              { backgroundColor: canSave ? tokens.accentFill : tokens.track },
            ]}
          >
            {saving ? (
              <ActivityIndicator color={tokens.onAccent} />
            ) : (
              <Text style={[styles.saveButtonText, { color: canSave ? tokens.onAccent : tokens.muted }]}>
                {destination === "capture"
                  ? "保存到收集箱"
                  : destination === "task"
                    ? "创建任务"
                    : "保存为笔记"}
              </Text>
            )}
          </PressableScale>
        </View>
      ) : null}
    </View>
  );
}

function ShareQuickButton({
  icon,
  label,
  onPress,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
}) {
  const { tokens } = useTheme();
  return (
    <PressableScale
      onPress={onPress}
      accessibilityLabel={label}
      contentStyle={[
        styles.shareAction,
        { backgroundColor: tokens.accentWash, borderColor: tokens.cardBorder },
      ]}
    >
      <AppIcon name={icon} size={16} color={tokens.accentText} />
      <Text style={[styles.shareActionText, { color: tokens.accentText }]}>{label}</Text>
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },  headerAction: { minHeight: 40, paddingHorizontal: space.sm, justifyContent: "center" },
  headerActionText: { fontSize: font.meta, fontWeight: "600" },
  content: {
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: 160,
    gap: space.md,
  },
  loadingRow: { flexDirection: "row", alignItems: "center", gap: space.sm },
  loadingText: { fontSize: font.meta },
  resultCard: { padding: space.md, gap: space.sm, borderWidth: 1 },
  resultRow: { flexDirection: "row", alignItems: "center", gap: space.xs },
  resultText: { flex: 1, fontSize: font.body, lineHeight: 20 },
  resultActions: { flexDirection: "row", alignItems: "center", gap: space.md },
  resultPrimary: {
    minHeight: 40,
    paddingHorizontal: space.lg,
    borderRadius: radius.control,
    alignItems: "center",
    justifyContent: "center",
  },
  resultPrimaryText: { fontSize: font.body, fontWeight: "600" },
  resultSecondary: { minHeight: 40, justifyContent: "center" },
  resultSecondaryText: { fontSize: font.body, fontWeight: "600" },
  rejectedCard: { padding: space.md, gap: space.xs, borderWidth: 1 },
  rejectReason: { fontSize: font.label, lineHeight: 17 },
  shareCard: { padding: space.md, gap: space.sm, borderWidth: 1 },
  shareHead: { flexDirection: "row", alignItems: "flex-start", gap: space.sm },
  shareHeadText: { flex: 1, gap: 2 },
  shareTitle: { fontSize: font.body, fontWeight: "700" },
  shareHint: { fontSize: font.label, lineHeight: 17 },
  shareGroup: { gap: space.xs, paddingTop: space.xs, borderTopWidth: StyleSheet.hairlineWidth },
  shareLabel: { fontSize: font.label },
  shareActions: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  shareAction: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.xs,
    minHeight: 44,
    paddingHorizontal: space.md,
    borderRadius: radius.control,
    borderWidth: StyleSheet.hairlineWidth,
  },
  shareActionText: { fontSize: font.meta, fontWeight: "600" },
  composer: { padding: space.md, gap: space.xs },
  input: {
    minHeight: 96,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.control,
    padding: space.md,
    fontSize: font.reading,
    lineHeight: 22,
  },
  counter: { fontSize: font.label, textAlign: "right" },
  itemList: { gap: space.sm },
  itemCard: { padding: space.sm, gap: space.sm },
  itemRow: { flexDirection: "row", alignItems: "center", gap: space.sm },
  thumb: { width: 52, height: 52, borderRadius: radius.tile, backgroundColor: "#00000010" },
  fileTile: {
    width: 52,
    height: 52,
    borderRadius: radius.tile,
    alignItems: "center",
    justifyContent: "center",
  },
  itemMeta: { flex: 1, gap: 2 },
  itemName: { fontSize: font.body, fontWeight: "600" },
  itemSub: { fontSize: font.label },
  itemAction: {
    width: 38,
    height: 38,
    borderRadius: radius.control,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
  },
  transcriptBox: { gap: space.xs },
  transcriptLabel: { fontSize: font.label },
  transcriptInput: {
    minHeight: 56,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.control,
    padding: space.sm,
    fontSize: font.body,
  },
  summaryLine: { fontSize: font.label, textAlign: "right" },
  pickerRow: { flexDirection: "row", gap: space.sm },
  // 等宽四列：flex 必须在外层 Pressable 上，写进 contentStyle 只会让内层按内容宽度排列
  pickerPress: { flex: 1 },
  picker: {
    minHeight: 64,
    borderRadius: radius.row,
    alignItems: "center",
    justifyContent: "center",
    gap: space.xxs,
  },
  pickerText: { fontSize: font.meta, fontWeight: "600" },
  saveBox: { padding: space.md, gap: space.sm },
  saveLabel: { fontSize: font.meta, fontWeight: "600" },
  saveHint: { fontSize: font.label, lineHeight: 17 },
  footer: {
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
    paddingBottom: space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: space.sm,
  },
  sendRow: { flexDirection: "row", alignItems: "center", gap: space.md },
  sendText: { flex: 1, gap: 2 },
  sendLabel: { fontSize: font.meta, fontWeight: "600" },
  sendHint: { fontSize: font.label, lineHeight: 16 },
  saveButton: {
    minHeight: 48,
    borderRadius: radius.control,
    alignItems: "center",
    justifyContent: "center",
  },
  saveButtonText: { fontSize: font.title, fontWeight: "700" },
  cameraWrap: { flex: 1, paddingBottom: space.lg },
  cameraStage: { flex: 1, marginHorizontal: space.lg, borderRadius: radius.card, overflow: "hidden" },
  cameraBusy: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  cameraPermission: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: space.md,
    padding: space.lg,
  },
  cameraPermissionText: { fontSize: font.body, textAlign: "center" },
  cameraButton: {
    minHeight: 44,
    paddingHorizontal: space.lg,
    borderRadius: radius.control,
    alignItems: "center",
    justifyContent: "center",
  },
  cameraButtonText: { fontSize: font.body, fontWeight: "600" },
  cameraBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: space.xl,
    paddingTop: space.lg,
  },
  cameraSecondary: {
    minWidth: 72,
    minHeight: 44,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.control,
    alignItems: "center",
    justifyContent: "center",
  },
  cameraSecondaryText: { fontSize: font.body, fontWeight: "600" },
  shutter: {
    width: 68,
    height: 68,
    borderRadius: 34,
    alignItems: "center",
    justifyContent: "center",
  },
  cameraCount: { minWidth: 72, alignItems: "flex-end" },
  cameraCountText: { fontSize: font.meta },
  cameraHint: { fontSize: font.label, textAlign: "center", paddingTop: space.sm },
  voiceWrap: { flexGrow: 1, padding: space.lg, gap: space.md },
  voiceCard: {
    width: "100%",
    paddingHorizontal: space.lg,
    paddingVertical: space.xl,
    alignItems: "center",
    gap: space.xs,
  },
  voiceMicPress: { alignSelf: "center", marginBottom: space.xs },
  voiceMic: {
    width: 104,
    height: 104,
    borderRadius: 52,
    alignItems: "center",
    justifyContent: "center",
  },
  voiceStopGlyph: {
    width: 28,
    height: 28,
    borderRadius: 6,
  },
  voiceTimer: { fontSize: font.display, fontWeight: "700", fontVariant: ["tabular-nums"] },
  voiceState: { fontSize: font.body, fontWeight: "600", textAlign: "center" },
  voiceHelper: { fontSize: font.meta, lineHeight: 18, textAlign: "center", paddingHorizontal: space.sm },
  voiceCancelPress: { minHeight: 44, justifyContent: "center", marginTop: space.xxs },
  voiceCancelButton: { minHeight: 44, alignItems: "center", justifyContent: "center" },
  voiceCancelText: { fontSize: font.meta, fontWeight: "600" },
  voiceResult: {
    width: "100%",
    borderTopWidth: StyleSheet.hairlineWidth,
    marginTop: space.sm,
    paddingTop: space.md,
    gap: space.sm,
  },
  voiceResultHead: { flexDirection: "row", alignItems: "center", gap: space.sm },
  voiceResultIcon: {
    width: 40,
    height: 40,
    borderRadius: radius.iconTile,
    alignItems: "center",
    justifyContent: "center",
  },
  voiceResultText: { flex: 1, minWidth: 0, gap: 2 },
  voiceResultName: { fontSize: font.body, fontWeight: "700" },
  voiceResultMeta: { fontSize: font.label },
  voiceResultActions: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  voiceActionSlot: { flexBasis: "48%", flexGrow: 1, minWidth: 0 },
  voiceAction: {
    minHeight: 44,
    borderRadius: radius.control,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: space.sm,
  },
  voiceActionText: { fontSize: font.meta, fontWeight: "700", textAlign: "center" },
  voiceHint: { fontSize: font.label, lineHeight: 18 },
});
