// 工作台入口配置的本机持久化：只读写 kv 里的一个 JSON 键，不新建表、不引入依赖。
//
// 为什么用 kv：配置体积几十字节、读写频率低、只有一份，符合 kv 的定位；
// 桌面端用的是 SQLite settings.navigation_layout，两端键名不同即天然隔离。
//
// 读取永不抛异常：配置读失败/损坏都必须退回默认布局，让 App 能继续用；
// 写失败必须抛异常，由界面给出明确反馈（静默失败会让用户以为保存成功）。
import { getSetting, setSetting, deleteSetting } from "./kv";

import {
  ENTRY_LAYOUT_SETTING_KEY,
  ENTRY_LAYOUT_VERSION,
  defaultEntryLayout,
  normalizeEntryLayout,
  type EntryLayoutConfig,
  type EntryLayoutSource,
} from "../lib/entryLayout";
import { availableEntryIds } from "../lib/entryRegistry";

export interface EntryLayoutSnapshot {
  config: EntryLayoutConfig;
  source: EntryLayoutSource;
  /** 版本号与当前结构不同：结构已按当前版本重建，用户选择保留 */
  migrated: boolean;
  /** 被丢弃的无效入口 id 数量 */
  dropped: number;
  /** 原始值存在但无法解析（已安全退回默认） */
  corrupt: boolean;
  /** 读取本身失败（数据库错误），不代表配置内容有问题 */
  readFailed: boolean;
  /** 原始文本长度，仅用于诊断显示，不暴露内容 */
  rawLength: number;
}

function defaultSnapshot(): EntryLayoutSnapshot {
  return {
    config: defaultEntryLayout(),
    source: "default",
    migrated: false,
    dropped: 0,
    corrupt: false,
    readFailed: false,
    rawLength: 0,
  };
}

/** 读配置：任何异常都收敛成默认布局，并标记原因 */
export async function loadEntryLayout(): Promise<EntryLayoutSnapshot> {
  let raw: string | null;
  try {
    raw = await getSetting(ENTRY_LAYOUT_SETTING_KEY);
  } catch {
    return { ...defaultSnapshot(), readFailed: true };
  }

  const rawLength = raw?.length ?? 0;
  if (raw === null || raw.trim() === "") {
    // 首次安装：没有配置就是默认配置，不是损坏
    return { ...defaultSnapshot(), rawLength: 0 };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...defaultSnapshot(), corrupt: true, rawLength };
  }

  const normalized = normalizeEntryLayout(parsed);
  return {
    config: normalized.config,
    source: normalized.source,
    migrated: normalized.migrated,
    dropped: normalized.dropped,
    // 结构不对（visible 不是数组）时归一化会回落到 default，这里视为损坏
    corrupt: normalized.source === "default",
    readFailed: false,
    rawLength,
  };
}

/** 写配置：写入前再归一化一次，保证落盘的永远是自洽结构（版本/known 都是当前值） */
export async function saveEntryLayout(config: EntryLayoutConfig): Promise<void> {
  const normalized = normalizeEntryLayout({
    version: ENTRY_LAYOUT_VERSION,
    visible: config.visible,
    known: availableEntryIds(),
  }).config;
  await setSetting(ENTRY_LAYOUT_SETTING_KEY, JSON.stringify(normalized));
}

/** 删除配置键（恢复默认时的彻底清理，测试与本地重置使用） */
export async function clearEntryLayout(): Promise<void> {
  await deleteSetting(ENTRY_LAYOUT_SETTING_KEY);
}
