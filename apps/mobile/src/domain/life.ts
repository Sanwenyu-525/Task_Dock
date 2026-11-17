// 生活领域纯函数与类型：规范化、金额/数量定点解析、快捷查询词剥离。
//
// 与桌面端 `src-tauri/src/commands/life.rs` 的规则保持一致：
// - 名称归一化只做全角→半角、空白折叠、首尾常见句读剥离与大小写折叠；
//   不做同义词合并，也不把相似名称强行归为一类。
// - 金额只接受十进制，按货币精度保存为最小单位整数（CNY/USD=2、JPY=0、KWD=3）；
// - 数量最多三位小数，规范化为去尾零的十进制字符串。
// 本文件不 import react-native / expo-sqlite，可直接单测。

export const LIFE_DEFAULT_CATEGORY = "生活";

export interface LifeItem {
  id: string;
  name: string;
  normalizedName: string;
  category: string;
  aliases: string[];
  note: string;
  createdAt: number;
  updatedAt: number;
}

export interface LifeDocumentLink {
  id: string;
  ownerType: "event" | "item";
  ownerId: string;
  documentRef: string;
  documentSource: "capture_asset" | "shelf_item" | "attachment" | "file";
  documentName: string;
  mime: string;
  byteSize: number | null;
  transferState: "local" | "metadata_only" | "transferred" | "missing";
  /** 原图实际传输到桌面后的稳定引用；documentRef 继续保留本机来源。 */
  remoteRef: string | null;
  remoteSource: "shelf_item" | "file" | null;
  createdAt: number;
  updatedAt: number;
  /** 关联的采集素材在本机的文件路径；仅 capture_asset 来源且仍存在时由仓储填充 */
  localUri?: string | null;
}

export interface LifePurchaseRow {
  itemRowId: string;
  eventId: string;
  itemId: string | null;
  itemName: string;
  occurredAt: number;
  createdAt: number;
  merchant: string;
  quantityValue: string | null;
  quantityUnit: string;
  unitPriceMinor: number | null;
  totalPriceMinor: number | null;
  currency: string;
  amountScale: number;
  note: string;
  links: LifeDocumentLink[];
}

export interface LifeItemHistory {
  item: LifeItem;
  purchases: LifePurchaseRow[];
  totalCount: number;
  /** 最近两次购买间隔（天）；不足两条时为 null */
  intervalDays: number | null;
}

export interface LifeRecentPurchase {
  eventId: string;
  title: string;
  occurredAt: number;
  merchant: string;
  totalPriceMinor: number | null;
  currency: string;
  amountScale: number;
  itemNames: string[];
  linkCount: number;
}

export interface LifeEventItem {
  id: string;
  itemId: string | null;
  itemName: string;
  quantityValue: string | null;
  quantityUnit: string;
  unitPriceMinor: number | null;
  totalPriceMinor: number | null;
  currency: string;
  amountScale: number;
  note: string;
}

export interface LifeEventDetail {
  eventId: string;
  eventType: string;
  title: string;
  description: string;
  occurredAt: number;
  merchant: string;
  source: string;
  items: LifeEventItem[];
  links: LifeDocumentLink[];
}

export interface LifePurchaseInput {
  name: string;
  occurredAt: number;
  quantityValue?: string | null;
  quantityUnit?: string | null;
  totalPrice?: string | null;
  currency?: string | null;
  merchant?: string | null;
  category?: string | null;
  note?: string | null;
}

export interface LifeDocumentLinkInput {
  ownerType: "event" | "item";
  ownerId: string;
  documentRef: string;
  documentSource: LifeDocumentLink["documentSource"];
  documentName: string;
  mime?: string;
  byteSize?: number | null;
  transferState?: LifeDocumentLink["transferState"];
}

// ── 名称归一化 ─────────────────────────────────────────────

const EDGE_PUNCTUATION = new Set(["。", "，", ",", ".", "!", "！", "?", "？", "、", ";"]);

/** 全角 ASCII → 半角、表意空格 → 普通空格、空白折叠、首尾句读剥离、小写。 */
export function normalizeLifeName(raw: string): string {
  let mapped = "";
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0xff01 && code <= 0xff5e) {
      mapped += String.fromCodePoint(code - 0xfee0);
    } else if (ch === "\u3000") {
      mapped += " ";
    } else {
      mapped += ch;
    }
  }

  let collapsed = "";
  let lastSpace = false;
  for (const ch of mapped) {
    if (/\s/.test(ch)) {
      if (!lastSpace && collapsed.length > 0) {
        collapsed += " ";
        lastSpace = true;
      }
      continue;
    }
    lastSpace = false;
    collapsed += ch;
  }

  let trimmed = collapsed.trim();
  while (trimmed.length > 0 && EDGE_PUNCTUATION.has(trimmed[trimmed.length - 1])) {
    trimmed = trimmed.slice(0, -1);
  }
  while (trimmed.length > 0 && EDGE_PUNCTUATION.has(trimmed[0])) {
    trimmed = trimmed.slice(1);
  }
  return trimmed.toLowerCase();
}

// ── 金额与数量 ─────────────────────────────────────────────

/**
 * ISO 4217 常用货币小数位。与桌面端 `currency_scale` 保持一致。
 * 未列入的代码明确报错，不假设所有货币都是两位小数。
 */
export const CURRENCY_DECIMALS: Readonly<Record<string, number>> = {
  JPY: 0,
  KRW: 0,
  VND: 0,
  CLP: 0,
  ISK: 0,
  PYG: 0,
  RWF: 0,
  UGX: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
  KMF: 0,
  DJF: 0,
  GNF: 0,
  BIF: 0,
  KWD: 3,
  BHD: 3,
  OMR: 3,
  JOD: 3,
  TND: 3,
  IQD: 3,
  LYD: 3,
  CNY: 2,
  USD: 2,
  EUR: 2,
  GBP: 2,
  HKD: 2,
  MOP: 2,
  TWD: 2,
  AUD: 2,
  CAD: 2,
  SGD: 2,
  CHF: 2,
  NZD: 2,
  SEK: 2,
  NOK: 2,
  DKK: 2,
  PLN: 2,
  CZK: 2,
  HUF: 2,
  RON: 2,
  BGN: 2,
  HRK: 2,
  RSD: 2,
  TRY: 2,
  RUB: 2,
  UAH: 2,
  INR: 2,
  PKR: 2,
  BDT: 2,
  LKR: 2,
  NPR: 2,
  THB: 2,
  MYR: 2,
  IDR: 2,
  PHP: 2,
  BRL: 2,
  MXN: 2,
  ARS: 2,
  COP: 2,
  PEN: 2,
  UYU: 2,
  ZAR: 2,
  AED: 2,
  SAR: 2,
  QAR: 2,
  ILS: 2,
  EGP: 2,
  NGN: 2,
  KES: 2,
  GHS: 2,
  MAD: 2,
  DZD: 2,
};

export function currencyDecimals(currency: string): number {
  const code = normalizeCurrency(currency);
  if (!code) throw new Error("金额必须指定货币");
  const scale = CURRENCY_DECIMALS[code];
  if (scale === undefined) {
    throw new Error(`暂不支持货币 ${code} 的金额精度，请选择已支持货币`);
  }
  return scale;
}

/** 十进制金额 → 最小货币单位整数；按货币精度解析，非法返回 null / 抛错。 */
export function parseMoneyMinor(
  raw: string | null | undefined,
  currency: string,
): number | null {
  const value = (raw ?? "").trim().replace(/,/g, "");
  if (value === "") return null;
  const code = normalizeCurrency(currency);
  if (!code) throw new Error("填写金额时必须选择货币");
  const scale = currencyDecimals(code);
  const pattern = scale === 0 ? /^\d+$/ : new RegExp(`^\\d+(\\.\\d{1,${scale}})?$`);
  if (!pattern.test(value)) {
    throw new Error(
      scale === 0
        ? `${code} 不支持小数金额`
        : `金额格式不正确：${code} 只支持最多 ${scale} 位小数`,
    );
  }
  const [whole, fraction = ""] = value.split(".");
  const minor =
    Number(whole) * 10 ** scale + Number(fraction.padEnd(scale, "0") || "0");
  if (!Number.isSafeInteger(minor) || minor > 1_000_000_000_000) {
    throw new Error("金额超出可用范围");
  }
  return minor;
}

/** 数量规范化：最多三位小数，去尾零；空返回 null。 */
export function normalizeQuantity(raw: string | null | undefined): string | null {
  const value = (raw ?? "").trim().replace(/,/g, "");
  if (value === "") return null;
  if (!/^\d+(\.\d{1,3})?$/.test(value)) {
    throw new Error("数量格式不正确：只支持最多三位小数的非负数字");
  }
  if (!/[1-9]/.test(value)) throw new Error("数量必须大于 0");
  const [whole, fraction = ""] = value.split(".");
  const trimmed = fraction.replace(/0+$/, "");
  const normalizedWhole = whole.replace(/^0+/, "") || "0";
  return trimmed ? `${normalizedWhole}.${trimmed}` : normalizedWhole;
}

export function normalizeCurrency(raw: string | null | undefined): string {
  const value = (raw ?? "").trim().toUpperCase();
  if (value === "") return "";
  if (!/^[A-Z]{3}$/.test(value)) throw new Error("货币必须是三位字母代码，例如 CNY");
  return value;
}

// ── 时间与展示 ─────────────────────────────────────────────

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** epoch ms → 本地 YYYY-MM-DD */
export function formatLifeDate(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "";
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** YYYY-MM-DD（本地时区）→ 当天零点的 epoch ms；非法返回 null。 */
export function parseLifeDateInput(input: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day, 0, 0, 0, 0);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }
  return date.getTime();
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  CNY: "¥",
  USD: "$",
  EUR: "€",
  JPY: "JP¥",
  GBP: "£",
  HKD: "HK$",
  KWD: "KD ",
};

/**
 * 最小货币单位 → 展示字符串；金额为空时返回空串（页面显示「未记录金额」）。
 * `amountScale` 必须与数据库行一致：旧行=2，JPY=0，KWD=3。
 */
export function formatMoneyMinor(
  minor: number | null | undefined,
  currency: string,
  amountScale?: number | null,
): string {
  if (minor == null || !Number.isFinite(minor)) return "";
  const safeScale =
    typeof amountScale === "number" &&
    Number.isInteger(amountScale) &&
    amountScale >= 0 &&
    amountScale <= 3
      ? amountScale
      : 2;
  const code = currency.trim().toUpperCase();
  const factor = 10 ** safeScale;
  const whole = Math.floor(minor / factor);
  if (safeScale === 0) {
    return code ? `${CURRENCY_SYMBOLS[code] ?? `${code} `}${whole}` : String(whole);
  }
  const fraction = String(minor % factor).padStart(safeScale, "0");
  const amount = `${whole}.${fraction}`;
  return code ? `${CURRENCY_SYMBOLS[code] ?? `${code} `}${amount}` : amount;
}

// ── 快捷查询 ───────────────────────────────────────────────

const QUERY_PREFIXES = [
  "上次什么时候买的",
  "上次什么时候买",
  "上次买",
  "什么时候买的",
  "什么时候买",
  "买过",
  "买了",
  "购买记录",
  "购买历史",
  "查询",
  "搜索",
  "查",
  "找",
];

const QUERY_SUFFIXES = [
  "购买记录",
  "购买历史",
  "什么时候买的",
  "什么时候买",
  "上次什么时候买的",
  "记录",
  "历史",
  "吗",
  "呢",
  "？",
  "?",
];

function stripEdges(value: string): string {
  let text = value.trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const prefix of QUERY_PREFIXES) {
      if (text.startsWith(prefix)) {
        text = text.slice(prefix.length).trim();
        changed = true;
      }
    }
    for (const suffix of QUERY_SUFFIXES) {
      if (text.endsWith(suffix)) {
        text = text.slice(0, -suffix.length).trim();
        changed = true;
      }
    }
    if (text.startsWith("的")) {
      text = text.slice(1).trim();
      changed = true;
    }
  }
  return text;
}

/**
 * 从自然语言式短语里提取商品关键词。
 * 例：「上次什么时候买的大米？」→「大米」；「大米购买记录」→「大米」。
 * 无法识别时返回空串（调用方按空搜索处理，不伪造示例数据）。
 */
export function extractLifeQueryKeyword(raw: string): string {
  return stripEdges(raw);
}

export type LifeSearchKind = "item" | "event" | "receipt";

export interface LifeSearchHit {
  kind: LifeSearchKind;
  id: string;
  /** 票据命中的 owner 类型；商品/事件命中为 undefined */
  ownerType?: "event" | "item";
  title: string;
  subtitle: string;
  occurredAt: number | null;
}
