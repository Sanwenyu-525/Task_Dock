//! 生活效率系统 v1：生活记录、商品购买历史、票据关联。
//!
//! 边界（对应任务书第二～五、七、十节）：
//! - 只新增 `life_*` 四张表，**不复制任务系统**：生活待办仍走 `tasks`，生活页只按
//!   `category = '生活'` 读取既有任务；
//! - 金额一律用最小货币单位的整数（`*_minor`）存储与累计，解析入口只接受十进制字符串，
//!   不允许浮点数进入累计路径；
//! - `quantity_value` 用规范化十进制文本（最多 3 位小数），支持小数且跨端逐字一致；
//! - 购买日期 `life_events.occurred_at` 与实际发生时间一致，绝不拿 `created_at` 代替；
//! - 票据只存引用（`life_document_links.document_ref`），不复制图片字节；删除关联不等于
//!   删除原文件；
//! - 同步走既有 `sync_changes` 日志：本迁移为四张表建立触发器，同步实体名见
//!   `life_sync_entity_names`（`life_item` / `life_event` / `life_event_item` /
//!   `life_document_link`）。
//!
//! 字段契约是跨端唯一标准：移动端 `apps/mobile/src/db/life.ts` 与桌面前端
//! `src/lib/lifeBridge.ts` 必须逐字段对齐，不得各自发明字段名。

use chrono::{DateTime, Local, NaiveDate, NaiveDateTime, SecondsFormat, TimeZone, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tauri::State;
use uuid::Uuid;

use crate::db::Db;
use crate::error::{AppError, AppResult};

/// v65：生活效率系统四张核心表（life_items / life_events / life_event_items /
/// life_document_links）+ 同步变更触发器。append-only：不改动 v1–v64。
pub const MIGRATION_65: (i64, &str) = (
    65,
    r#"
-- 商品/物品主数据：同一 normalized_name 只允许一条有效记录。
CREATE TABLE life_items (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  aliases TEXT NOT NULL DEFAULT '[]',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE UNIQUE INDEX idx_life_items_normalized
  ON life_items(normalized_name) WHERE deleted_at IS NULL;
CREATE INDEX idx_life_items_name ON life_items(name);

-- 实际发生的生活事件。occurred_at 是真实发生日期，created_at 是录入时间。
CREATE TABLE life_events (
  id TEXT PRIMARY KEY NOT NULL,
  event_type TEXT NOT NULL DEFAULT 'purchase'
    CHECK (event_type IN ('purchase','maintenance','general')),
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  occurred_at TEXT NOT NULL,
  merchant TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','capture')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_life_events_occurred
  ON life_events(event_type, occurred_at DESC, created_at DESC, id DESC);
CREATE INDEX idx_life_events_deleted ON life_events(deleted_at);

-- 一次购买涉及的具体商品。保留原始名称快照；金额为最小货币单位整数。
CREATE TABLE life_event_items (
  id TEXT PRIMARY KEY NOT NULL,
  event_id TEXT NOT NULL REFERENCES life_events(id) ON DELETE CASCADE,
  item_id TEXT REFERENCES life_items(id) ON DELETE SET NULL,
  item_name_snapshot TEXT NOT NULL,
  quantity_value TEXT,
  quantity_unit TEXT NOT NULL DEFAULT '',
  unit_price_minor INTEGER,
  total_price_minor INTEGER,
  currency TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_life_event_items_item ON life_event_items(item_id);
CREATE INDEX idx_life_event_items_event ON life_event_items(event_id);

-- 票据与生活记录的关联。owner 为多态引用（event/item），由命令层校验存在性；
-- document_ref 指向既有采集素材/文件暂存/本地文件，不复制字节。
CREATE TABLE life_document_links (
  id TEXT PRIMARY KEY NOT NULL,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('event','item')),
  owner_id TEXT NOT NULL,
  document_ref TEXT NOT NULL,
  document_source TEXT NOT NULL
    CHECK (document_source IN ('capture_asset','shelf_item','attachment','file')),
  document_name TEXT NOT NULL DEFAULT '',
  mime TEXT NOT NULL DEFAULT '',
  byte_size INTEGER,
  transfer_state TEXT NOT NULL DEFAULT 'local'
    CHECK (transfer_state IN ('local','metadata_only','transferred','missing')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE UNIQUE INDEX idx_life_document_links_owner
  ON life_document_links(owner_type, owner_id, document_ref, document_source)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_life_document_links_event ON life_document_links(owner_id);

-- 同步变更日志：与任务/笔记/收集箱同一张 sync_changes，实体名见模块文档。
CREATE TRIGGER trg_sync_life_items_insert AFTER INSERT ON life_items BEGIN
  INSERT INTO sync_changes (entity, id, deleted, changed_at)
  VALUES ('life_item', NEW.id, 0, NEW.updated_at);
END;
CREATE TRIGGER trg_sync_life_items_update AFTER UPDATE ON life_items BEGIN
  INSERT INTO sync_changes (entity, id, deleted, changed_at)
  VALUES ('life_item', NEW.id, 0, NEW.updated_at);
END;
CREATE TRIGGER trg_sync_life_items_delete AFTER DELETE ON life_items BEGIN
  INSERT INTO sync_changes (entity, id, deleted, changed_at)
  VALUES ('life_item', OLD.id, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER trg_sync_life_events_insert AFTER INSERT ON life_events BEGIN
  INSERT INTO sync_changes (entity, id, deleted, changed_at)
  VALUES ('life_event', NEW.id, 0, NEW.updated_at);
END;
CREATE TRIGGER trg_sync_life_events_update AFTER UPDATE ON life_events BEGIN
  INSERT INTO sync_changes (entity, id, deleted, changed_at)
  VALUES ('life_event', NEW.id, 0, NEW.updated_at);
END;
CREATE TRIGGER trg_sync_life_events_delete AFTER DELETE ON life_events BEGIN
  INSERT INTO sync_changes (entity, id, deleted, changed_at)
  VALUES ('life_event', OLD.id, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER trg_sync_life_event_items_insert AFTER INSERT ON life_event_items BEGIN
  INSERT INTO sync_changes (entity, id, deleted, changed_at)
  VALUES ('life_event_item', NEW.id, 0, NEW.updated_at);
END;
CREATE TRIGGER trg_sync_life_event_items_update AFTER UPDATE ON life_event_items BEGIN
  INSERT INTO sync_changes (entity, id, deleted, changed_at)
  VALUES ('life_event_item', NEW.id, 0, NEW.updated_at);
END;
CREATE TRIGGER trg_sync_life_event_items_delete AFTER DELETE ON life_event_items BEGIN
  INSERT INTO sync_changes (entity, id, deleted, changed_at)
  VALUES ('life_event_item', OLD.id, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER trg_sync_life_document_links_insert AFTER INSERT ON life_document_links BEGIN
  INSERT INTO sync_changes (entity, id, deleted, changed_at)
  VALUES ('life_document_link', NEW.id, 0, NEW.updated_at);
END;
CREATE TRIGGER trg_sync_life_document_links_update AFTER UPDATE ON life_document_links BEGIN
  INSERT INTO sync_changes (entity, id, deleted, changed_at)
  VALUES ('life_document_link', NEW.id, 0, NEW.updated_at);
END;
CREATE TRIGGER trg_sync_life_document_links_delete AFTER DELETE ON life_document_links BEGIN
  INSERT INTO sync_changes (entity, id, deleted, changed_at)
  VALUES ('life_document_link', OLD.id, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
"#,
);

/// 同步实体名（桌面 pull/push 与移动端协议共用，不得改名）。
pub const SYNC_ENTITIES: [&str; 4] = [
    "life_item",
    "life_event",
    "life_event_item",
    "life_document_link",
];

/// v66：票据关联补充「桌面端实际收到原图」的稳定引用。
/// 65 已创建基础表；本迁移只做加列，兼容已经跑过 65 的开发库与旧用户原地升级。
pub const MIGRATION_66: (i64, &str) = (
    66,
    r#"
ALTER TABLE life_document_links ADD COLUMN remote_ref TEXT;
ALTER TABLE life_document_links ADD COLUMN remote_source TEXT
  CHECK (remote_source IN ('shelf_item','file'));
"#,
);

/// v67：金额精度跨端一致。
/// 旧数据默认 scale=2，保持历史金额按原两位解释；新记录按货币精度显式写入
/// （CNY/USD=2、JPY=0、KWD=3 等），显示、编辑回显与同步都使用该行自己的 scale。
pub const MIGRATION_67: (i64, &str) = (
    67,
    r#"
ALTER TABLE life_event_items ADD COLUMN amount_scale INTEGER NOT NULL DEFAULT 2;
"#,
);

// ── 格式化与解析（跨端契约）────────────────────────────────

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn to_iso(dt: DateTime<Utc>) -> String {
    dt.to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// 商品名称归一化：全角 ASCII → 半角、折叠空白、去首尾标点、统一小写。
///
/// 只做「确定等价」的归一，不做同义词/品牌/规格合并——名称相似但实际不同的商品
/// 必须保持独立（任务书 4.1）。跨端（Rust/TypeScript）必须逐字实现同一规则。
pub fn normalize_name(raw: &str) -> String {
    let mut mapped = String::with_capacity(raw.len());
    for ch in raw.chars() {
        let code = ch as u32;
        let half = if (0xFF01..=0xFF5E).contains(&code) {
            char::from_u32(code - 0xFEE0).unwrap_or(ch)
        } else if ch == '\u{3000}' {
            ' '
        } else {
            ch
        };
        mapped.push(half);
    }
    let mut collapsed = String::with_capacity(mapped.len());
    let mut last_space = false;
    for ch in mapped.chars() {
        if ch.is_whitespace() {
            if !last_space && !collapsed.is_empty() {
                collapsed.push(' ');
                last_space = true;
            }
            continue;
        }
        last_space = false;
        collapsed.push(ch);
    }
    let mut trimmed = collapsed.trim().to_string();
    // 仅剥离首尾常见句读，不触碰名称内部（例如「大米（东北）」保持原样）。
    let edge: [char; 10] = ['。', '，', ',', '.', '!', '！', '?', '？', '、', ';'];
    while trimmed
        .chars()
        .last()
        .map(|c| edge.contains(&c))
        .unwrap_or(false)
    {
        trimmed.pop();
    }
    while trimmed
        .chars()
        .next()
        .map(|c| edge.contains(&c))
        .unwrap_or(false)
    {
        trimmed.remove(0);
    }
    trimmed.to_lowercase()
}

/// 金额解析：十进制字符串 → 最小货币单位整数（按该货币的小数位）。
///
/// 只接受非负、最多 `scale` 位小数的十进制文本；`48`（CNY, scale 2）→ 4800，
/// `48.5` → 4850；JPY（scale 0）只接受整数；KWD（scale 3）接受三位小数。
/// 拒绝科学计数法、千分位与超出精度的小数，避免静默舍入。
fn parse_minor(raw: &str, scale: i64) -> AppResult<i64> {
    let text = raw.trim();
    if text.is_empty() {
        return Err(AppError::Validation("金额不能为空".into()));
    }
    if text.starts_with('-') {
        return Err(AppError::Validation("金额不能为负数".into()));
    }
    let unsigned = text.strip_prefix('+').unwrap_or(text);
    if !unsigned.chars().all(|c| c.is_ascii_digit() || c == '.') {
        return Err(AppError::Validation("金额只能包含数字和小数点".into()));
    }
    let mut parts = unsigned.split('.');
    let int_part = parts.next().unwrap_or("");
    let frac_part = parts.next().unwrap_or("");
    if parts.next().is_some() {
        return Err(AppError::Validation("金额格式非法：小数点过多".into()));
    }
    let int_digits = if int_part.is_empty() { "0" } else { int_part };
    if int_digits.len() > 12 {
        return Err(AppError::Validation("金额过大".into()));
    }
    let scale_usize = scale as usize;
    if frac_part.len() > scale_usize {
        return Err(AppError::Validation(format!(
            "该货币金额最多支持 {scale} 位小数"
        )));
    }
    let frac: i64 = if frac_part.is_empty() {
        0
    } else {
        frac_part
            .parse::<i64>()
            .map_err(|_| AppError::Validation("金额格式非法".into()))?
    };
    let factor = 10_i64
        .checked_pow(scale as u32)
        .ok_or_else(|| AppError::Validation("货币精度非法".into()))?;
    let frac_scaled = frac
        .checked_mul(10_i64.pow((scale_usize - frac_part.len()) as u32))
        .ok_or_else(|| AppError::Validation("金额过大".into()))?;
    let whole: i64 = int_digits
        .parse::<i64>()
        .map_err(|_| AppError::Validation("金额格式非法".into()))?;
    whole
        .checked_mul(factor)
        .and_then(|v| v.checked_add(frac_scaled))
        .ok_or_else(|| AppError::Validation("金额过大".into()))
}

/// ISO 4217 常用货币的小数位。未列入的代码明确报错，不假设所有货币都是两位小数。
pub(crate) fn currency_scale(currency: &str) -> AppResult<i64> {
    let code = currency.trim().to_uppercase();
    if code.is_empty() {
        return Ok(2);
    }
    let scale = match code.as_str() {
        // 0 位：无辅币单位
        "JPY" | "KRW" | "VND" | "CLP" | "ISK" | "PYG" | "RWF" | "UGX" | "VUV"
        | "XAF" | "XOF" | "XPF" | "KMF" | "DJF" | "GNF" | "BIF" => 0,
        // 3 位：千分之一
        "KWD" | "BHD" | "OMR" | "JOD" | "TND" | "IQD" | "LYD" => 3,
        // 2 位：常用及绝大多数货币
        "CNY" | "USD" | "EUR" | "GBP" | "HKD" | "MOP" | "TWD" | "AUD" | "CAD"
        | "SGD" | "CHF" | "NZD" | "SEK" | "NOK" | "DKK" | "PLN" | "CZK" | "HUF"
        | "RON" | "BGN" | "HRK" | "RSD" | "TRY" | "RUB" | "UAH" | "INR" | "PKR"
        | "BDT" | "LKR" | "NPR" | "THB" | "MYR" | "IDR" | "PHP" | "BRL" | "MXN"
        | "ARS" | "COP" | "PEN" | "UYU" | "ZAR" | "AED" | "SAR" | "QAR" | "ILS"
        | "EGP" | "NGN" | "KES" | "GHS" | "MAD" | "DZD" => 2,
        _ => {
            return Err(AppError::Validation(format!(
                "暂不支持货币 {code} 的金额精度，请选择已支持货币或配置精度"
            )))
        }
    };
    Ok(scale)
}

/// 数量解析：十进制字符串 → 规范文本（最多 3 位小数，去掉末尾 0）。
pub(crate) fn canonical_quantity(raw: &str) -> AppResult<Option<String>> {
    let text = raw.trim();
    if text.is_empty() {
        return Ok(None);
    }
    if text.starts_with('-') {
        return Err(AppError::Validation("数量不能为负数".into()));
    }
    let unsigned = text.strip_prefix('+').unwrap_or(text);
    if !unsigned.chars().all(|c| c.is_ascii_digit() || c == '.') {
        return Err(AppError::Validation("数量只能包含数字和小数点".into()));
    }
    let mut parts = unsigned.split('.');
    let int_raw = parts.next().unwrap_or("");
    let frac_raw = parts.next().unwrap_or("");
    if parts.next().is_some() {
        return Err(AppError::Validation("数量格式非法：小数点过多".into()));
    }
    if frac_raw.len() > 3 {
        return Err(AppError::Validation("数量最多支持 3 位小数".into()));
    }
    let int_trimmed = int_raw.trim_start_matches('0');
    let int_part = if int_trimmed.is_empty() {
        "0"
    } else {
        int_trimmed
    };
    if int_part.len() > 12 {
        return Err(AppError::Validation("数量过大".into()));
    }
    let frac_trimmed = frac_raw.trim_end_matches('0');
    let canonical = if frac_trimmed.is_empty() {
        int_part.to_string()
    } else {
        format!("{}.{}", int_part, frac_trimmed)
    };
    Ok(Some(canonical))
}

/// 货币代码：三位 ASCII 字母，统一大写。空值由调用方按默认货币补齐。
pub(crate) fn normalize_currency(raw: Option<&str>) -> AppResult<String> {
    let text = raw.unwrap_or("").trim().to_uppercase();
    if text.is_empty() {
        return Ok(String::new());
    }
    if text.len() != 3 || !text.chars().all(|c| c.is_ascii_alphabetic()) {
        return Err(AppError::Validation("货币必须是三位字母代码（如 CNY）".into()));
    }
    Ok(text)
}

/// 实际发生时间：接受 RFC3339、`YYYY-MM-DD`、`YYYY-MM-DDTHH:MM`。
/// 纯日期按本地零点解释，再转 UTC 存储；排序/比较一律用 UTC 文本。
fn parse_occurred_at(raw: &str) -> AppResult<String> {
    let text = raw.trim();
    if text.is_empty() {
        return Ok(now_iso());
    }
    if let Ok(dt) = DateTime::parse_from_rfc3339(text) {
        return Ok(to_iso(dt.with_timezone(&Utc)));
    }
    if let Ok(date) = NaiveDate::parse_from_str(text, "%Y-%m-%d") {
        return local_midnight_iso(date);
    }
    if let Ok(dt) = NaiveDateTime::parse_from_str(text, "%Y-%m-%dT%H:%M") {
        return local_datetime_iso(dt);
    }
    Err(AppError::Validation(
        "日期格式非法：请使用 YYYY-MM-DD 或 RFC3339".into(),
    ))
}

fn local_midnight_iso(date: NaiveDate) -> AppResult<String> {
    let naive = date
        .and_hms_opt(0, 0, 0)
        .ok_or_else(|| AppError::Validation("日期非法".into()))?;
    local_datetime_iso(naive)
}

fn local_datetime_iso(naive: NaiveDateTime) -> AppResult<String> {
    let local = Local
        .from_local_datetime(&naive)
        .earliest()
        .ok_or_else(|| AppError::Validation("日期非法".into()))?;
    Ok(to_iso(local.with_timezone(&Utc)))
}

fn interval_days(latest: &str, previous: &str) -> Option<i64> {
    let a = DateTime::parse_from_rfc3339(latest).ok()?;
    let b = DateTime::parse_from_rfc3339(previous).ok()?;
    Some((a - b).num_days().abs())
}

fn validate_text(value: &str, field: &str, max: usize) -> AppResult<()> {
    if value.chars().count() > max {
        return Err(AppError::Validation(format!(
            "{}超过 {} 字符",
            field, max
        )));
    }
    Ok(())
}

// ── 数据模型（前端与移动端逐字段对齐）──────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct LifeItemSummary {
    pub id: String,
    pub name: String,
    pub normalized_name: String,
    pub category: String,
    pub note: String,
    pub aliases: Vec<String>,
    pub purchase_count: i64,
    pub last_purchase_at: Option<String>,
    pub last_quantity_value: Option<String>,
    pub last_quantity_unit: String,
    pub last_unit_price_minor: Option<i64>,
    pub last_total_price_minor: Option<i64>,
    pub last_currency: String,
    /// 最近一条购买金额的小数位；旧数据为 2。
    pub last_amount_scale: i64,
    pub interval_days: Option<i64>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct LifeDocumentLink {
    pub id: String,
    pub owner_type: String,
    pub owner_id: String,
    pub document_ref: String,
    pub document_source: String,
    pub document_name: String,
    pub mime: String,
    pub byte_size: Option<i64>,
    /// 原图实际传输到桌面后的稳定引用；未传输时为 None。
    pub remote_ref: Option<String>,
    pub remote_source: Option<String>,
    pub transfer_state: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct LifePurchase {
    pub event_id: String,
    pub item_row_id: String,
    pub occurred_at: String,
    pub item_name: String,
    pub quantity_value: Option<String>,
    pub quantity_unit: String,
    pub unit_price_minor: Option<i64>,
    pub total_price_minor: Option<i64>,
    pub currency: String,
    /// 该行金额的小数位（CNY=2、JPY=0、KWD=3；旧行=2）。
    pub amount_scale: i64,
    pub merchant: String,
    pub note: String,
    pub event_note: String,
    pub created_at: String,
    pub links: Vec<LifeDocumentLink>,
}

#[derive(Debug, Clone, Serialize)]
pub struct LifeItemHistory {
    pub item: LifeItemSummary,
    pub purchases: Vec<LifePurchase>,
    pub total_count: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct LifeEvent {
    pub id: String,
    pub event_type: String,
    pub title: String,
    pub description: String,
    pub occurred_at: String,
    pub merchant: String,
    pub source: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct LifeEventItem {
    pub id: String,
    pub event_id: String,
    pub item_id: Option<String>,
    pub item_name_snapshot: String,
    pub quantity_value: Option<String>,
    pub quantity_unit: String,
    pub unit_price_minor: Option<i64>,
    pub total_price_minor: Option<i64>,
    pub currency: String,
    pub amount_scale: i64,
    pub note: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct LifeEventDetail {
    pub event: LifeEvent,
    pub items: Vec<LifeEventItem>,
    pub links: Vec<LifeDocumentLink>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct CurrencyTotal {
    /// 空串 = 原记录没有填写货币，必须单独展示，不能并入任何具体币种。
    pub currency: String,
    pub amount_scale: i64,
    pub total_price_minor: i64,
    pub item_count: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct LifeEventSummary {
    pub id: String,
    pub event_type: String,
    pub title: String,
    pub description: String,
    pub occurred_at: String,
    pub merchant: String,
    pub item_names: Vec<String>,
    /// 单一币种时保留旧字段以兼容既有前端；多币种时为 None，由 `totals` 分行展示。
    pub total_price_minor: Option<i64>,
    pub currency: String,
    pub amount_scale: i64,
    /// 按币种分组的真实汇总；不同货币绝不直接相加。
    pub totals: Vec<CurrencyTotal>,
    pub link_count: i64,
}

fn convert_minor_exact(minor: i64, from_scale: i64, to_scale: i64) -> Option<i64> {
    if from_scale == to_scale {
        return Some(minor);
    }
    let diff = (to_scale - from_scale).unsigned_abs() as u32;
    let factor = 10_i64.checked_pow(diff)?;
    if to_scale > from_scale {
        minor.checked_mul(factor)
    } else if minor % factor == 0 {
        Some(minor / factor)
    } else {
        None
    }
}

/// 按币种分组汇总金额。规则与移动端 `groupLifeCurrencyTotals` 完全一致：
/// - 不同货币绝不直接相加，也不做汇率折算；
/// - 同币种优先收敛到 ISO 精度，旧数据无法整除时退到组内最大精度；
/// - 空货币单独一组；金额为空的行不参与累计。
fn group_currency_totals(entries: &[(Option<i64>, String, i64)]) -> AppResult<Vec<CurrencyTotal>> {
    use std::collections::BTreeMap;

    let mut groups: BTreeMap<String, Vec<(i64, i64)>> = BTreeMap::new();
    for (total, currency, scale) in entries {
        let Some(total) = total else { continue };
        let code = currency.trim().to_uppercase();
        let safe_scale = if (0..=3).contains(scale) { *scale } else { 2 };
        groups.entry(code).or_default().push((*total, safe_scale));
    }

    let mut totals = Vec::with_capacity(groups.len());
    for (currency, rows) in groups {
        let max_scale = rows.iter().map(|(_, scale)| *scale).max().unwrap_or(2);
        let mut target_scale = max_scale;
        if !currency.is_empty() {
            if let Ok(canonical) = currency_scale(&currency) {
                let convertible = rows
                    .iter()
                    .all(|(total, scale)| convert_minor_exact(*total, *scale, canonical).is_some());
                if convertible {
                    target_scale = canonical;
                }
            }
        }
        let mut sum = 0_i64;
        for (total, scale) in &rows {
            let converted = convert_minor_exact(*total, *scale, target_scale)
                .ok_or_else(|| AppError::Validation("金额累计超出范围".into()))?;
            sum = sum
                .checked_add(converted)
                .ok_or_else(|| AppError::Validation("金额累计超出范围".into()))?;
        }
        totals.push(CurrencyTotal {
            currency,
            amount_scale: target_scale,
            total_price_minor: sum,
            item_count: rows.len() as i64,
        });
    }
    // BTreeMap 会把空串排在最前；界面与其他端统一为「有货币在前，空货币最后」。
    totals.sort_by(|left, right| match (left.currency.is_empty(), right.currency.is_empty()) {
        (false, false) => left.currency.cmp(&right.currency),
        (true, true) => std::cmp::Ordering::Equal,
        (true, false) => std::cmp::Ordering::Greater,
        (false, true) => std::cmp::Ordering::Less,
    });
    Ok(totals)
}

#[derive(Debug, Clone, Serialize)]
pub struct LifeOverview {
    pub item_count: i64,
    pub purchase_count: i64,
    pub receipt_count: i64,
    pub purchases_last_30_days: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct LifeQuickQueryResult {
    /// `purchase_history` = 命中商品；`none` = 没有可展示记录。
    pub intent: String,
    pub keyword: String,
    pub matched_by: String,
    pub item: Option<LifeItemSummary>,
    pub purchases: Vec<LifePurchase>,
    pub total_count: i64,
    pub last_purchase_at: Option<String>,
    pub interval_days: Option<i64>,
    /// 给界面直接展示的确定性结论；没有记录时固定为「尚无购买记录」。
    pub message: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct LifeItemInput {
    /// 已有商品 ID；为空时按名称归一后复用或新建。
    #[serde(default)]
    pub item_id: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub aliases: Option<Vec<String>>,
    #[serde(default)]
    pub quantity_value: Option<String>,
    #[serde(default)]
    pub quantity_unit: Option<String>,
    /// 十进制文本（最多 3 位小数，按货币精度校验），不接受浮点数。
    #[serde(default)]
    pub unit_price: Option<String>,
    #[serde(default)]
    pub total_price: Option<String>,
    #[serde(default)]
    pub currency: Option<String>,
    /// 可选：沿用该行已有的金额小数位（编辑历史记录时保持原解释）；
    /// 新建记录不填，由货币精度映射决定。
    #[serde(default)]
    pub amount_scale: Option<i64>,
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct LifeEventInput {
    /// purchase | maintenance | general；缺省 purchase。
    #[serde(default)]
    pub event_type: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    /// 实际发生日期（YYYY-MM-DD 或 RFC3339）；缺省为当前时间。
    #[serde(default)]
    pub occurred_at: Option<String>,
    #[serde(default)]
    pub merchant: Option<String>,
    /// manual | capture。
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub items: Option<Vec<LifeItemInput>>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct LifeDocumentLinkInput {
    /// event | item。
    pub owner_type: String,
    pub owner_id: String,
    pub document_ref: String,
    /// capture_asset | shelf_item | attachment | file。
    pub document_source: String,
    #[serde(default)]
    pub document_name: String,
    #[serde(default)]
    pub mime: String,
    #[serde(default)]
    pub byte_size: Option<i64>,
    #[serde(default)]
    pub transfer_state: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct LifeItemFilter {
    #[serde(default)]
    pub query: Option<String>,
    #[serde(default)]
    pub limit: Option<u32>,
}

// ── 查询实现 ────────────────────────────────────────────────

const ITEM_SUMMARY_SQL: &str = r#"
WITH purchases AS (
  SELECT ei.item_id AS item_id,
         e.id AS event_id,
         e.occurred_at AS occurred_at,
         e.created_at AS event_created_at,
         ei.quantity_value AS quantity_value,
         ei.quantity_unit AS quantity_unit,
         ei.unit_price_minor AS unit_price_minor,
         ei.total_price_minor AS total_price_minor,
         ei.currency AS currency,
         ei.amount_scale AS amount_scale,
         ROW_NUMBER() OVER (
           PARTITION BY ei.item_id
           ORDER BY e.occurred_at DESC, e.created_at DESC, e.id DESC
         ) AS rn,
         COUNT(*) OVER (PARTITION BY ei.item_id) AS cnt
  FROM life_event_items ei
  JOIN life_events e ON e.id = ei.event_id
  WHERE e.event_type = 'purchase' AND e.deleted_at IS NULL
)
SELECT i.id, i.name, i.normalized_name, i.category, i.note, i.aliases, i.updated_at,
       p.occurred_at, p.quantity_value, p.quantity_unit, p.unit_price_minor,
       p.total_price_minor, p.currency, p.amount_scale, p.cnt,
       (SELECT p2.occurred_at FROM purchases p2 WHERE p2.item_id = i.id AND p2.rn = 2) AS prev_at
FROM life_items i
LEFT JOIN purchases p ON p.item_id = i.id AND p.rn = 1
WHERE i.deleted_at IS NULL
"#;

fn row_to_item_summary(row: &rusqlite::Row<'_>) -> rusqlite::Result<LifeItemSummary> {
    let aliases_raw: String = row.get(5)?;
    let aliases: Vec<String> = serde_json::from_str(&aliases_raw).unwrap_or_default();
    let last_purchase_at: Option<String> = row.get(7)?;
    let prev_at: Option<String> = row.get(15)?;
    let interval = match (last_purchase_at.as_deref(), prev_at.as_deref()) {
        (Some(a), Some(b)) => interval_days(a, b),
        _ => None,
    };
    Ok(LifeItemSummary {
        id: row.get(0)?,
        name: row.get(1)?,
        normalized_name: row.get(2)?,
        category: row.get(3)?,
        note: row.get(4)?,
        aliases,
        updated_at: row.get(6)?,
        purchase_count: row.get::<_, Option<i64>>(14)?.unwrap_or(0),
        last_purchase_at,
        last_quantity_value: row.get(8)?,
        last_quantity_unit: row.get::<_, Option<String>>(9)?.unwrap_or_default(),
        last_unit_price_minor: row.get(10)?,
        last_total_price_minor: row.get(11)?,
        last_currency: row.get::<_, Option<String>>(12)?.unwrap_or_default(),
        last_amount_scale: row.get::<_, Option<i64>>(13)?.unwrap_or(2),
        interval_days: interval,
    })
}

fn load_life_item_summary(conn: &Connection, item_id: &str) -> AppResult<Option<LifeItemSummary>> {
    let sql = format!("{} AND i.id = ?1", ITEM_SUMMARY_SQL);
    let mut stmt = conn.prepare(&sql)?;
    let row = stmt
        .query_row(params![item_id], row_to_item_summary)
        .optional()?;
    Ok(row)
}

fn list_life_items_inner(
    conn: &Connection,
    filter: &LifeItemFilter,
) -> AppResult<Vec<LifeItemSummary>> {
    let limit = filter.limit.unwrap_or(60).clamp(1, 200) as i64;
    let query = filter
        .query
        .as_deref()
        .map(extract_query_keyword)
        .unwrap_or_default();
    let sql = if query.is_empty() {
        format!(
            "{} ORDER BY (p.occurred_at IS NOT NULL) DESC, p.occurred_at DESC, i.name ASC, i.id ASC LIMIT ?1",
            ITEM_SUMMARY_SQL
        )
    } else {
        format!(
            "{} AND (i.name LIKE ?1 ESCAPE '\\' OR i.normalized_name LIKE ?1 ESCAPE '\\' OR i.aliases LIKE ?1 ESCAPE '\\') \
             ORDER BY (p.occurred_at IS NOT NULL) DESC, p.occurred_at DESC, i.name ASC, i.id ASC LIMIT ?2",
            ITEM_SUMMARY_SQL
        )
    };
    let mut stmt = conn.prepare(&sql)?;
    let rows = if query.is_empty() {
        stmt.query_map(params![limit], row_to_item_summary)?
            .collect::<rusqlite::Result<Vec<_>>>()?
    } else {
        let pattern = like_pattern(&query);
        stmt.query_map(params![pattern, limit], row_to_item_summary)?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };
    Ok(rows)
}

fn like_pattern(raw: &str) -> String {
    let escaped = raw
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    format!("%{}%", escaped)
}

fn load_event_items(conn: &Connection, event_id: &str) -> AppResult<Vec<LifeEventItem>> {
    let mut stmt = conn.prepare(
        "SELECT id, event_id, item_id, item_name_snapshot, quantity_value,
                quantity_unit, unit_price_minor, total_price_minor, currency, amount_scale, note
         FROM life_event_items WHERE event_id = ?1 ORDER BY created_at ASC, id ASC",
    )?;
    let rows = stmt
        .query_map(params![event_id], |row| {
            Ok(LifeEventItem {
                id: row.get(0)?,
                event_id: row.get(1)?,
                item_id: row.get(2)?,
                item_name_snapshot: row.get(3)?,
                quantity_value: row.get(4)?,
                quantity_unit: row.get::<_, Option<String>>(5)?.unwrap_or_default(),
                unit_price_minor: row.get(6)?,
                total_price_minor: row.get(7)?,
                currency: row.get(8)?,
                amount_scale: row.get(9)?,
                note: row.get(10)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

fn load_links(
    conn: &Connection,
    owner_type: Option<&str>,
    owner_id: Option<&str>,
) -> AppResult<Vec<LifeDocumentLink>> {
    let mut sql = String::from(
        "SELECT id, owner_type, owner_id, document_ref, document_source, document_name,
                mime, byte_size, remote_ref, remote_source, transfer_state, created_at, updated_at
         FROM life_document_links WHERE deleted_at IS NULL",
    );
    if owner_type.is_some() {
        sql.push_str(" AND owner_type = ?1");
    }
    if owner_id.is_some() {
        if owner_type.is_some() {
            sql.push_str(" AND owner_id = ?2");
        } else {
            sql.push_str(" AND owner_id = ?1");
        }
    }
    sql.push_str(" ORDER BY created_at DESC, id DESC LIMIT 200");
    let mut stmt = conn.prepare(&sql)?;
    let rows = match (owner_type, owner_id) {
        (Some(t), Some(i)) => stmt
            .query_map(params![t, i], map_link_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?,
        (Some(t), None) => stmt
            .query_map(params![t], map_link_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?,
        (None, Some(i)) => stmt
            .query_map(params![i], map_link_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?,
        (None, None) => stmt
            .query_map([], map_link_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?,
    };
    Ok(rows)
}

fn map_link_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<LifeDocumentLink> {
    Ok(LifeDocumentLink {
        id: row.get(0)?,
        owner_type: row.get(1)?,
        owner_id: row.get(2)?,
        document_ref: row.get(3)?,
        document_source: row.get(4)?,
        document_name: row.get(5)?,
        mime: row.get(6)?,
        byte_size: row.get(7)?,
        remote_ref: row.get(8)?,
        remote_source: row.get(9)?,
        transfer_state: row.get(10)?,
        created_at: row.get(11)?,
        updated_at: row.get(12)?,
    })
}

fn load_event(conn: &Connection, event_id: &str) -> AppResult<Option<LifeEvent>> {
    let mut stmt = conn.prepare(
        "SELECT id, event_type, title, description, occurred_at, merchant, source,
                created_at, updated_at
         FROM life_events WHERE id = ?1 AND deleted_at IS NULL",
    )?;
    let row = stmt
        .query_row(params![event_id], |row| {
            Ok(LifeEvent {
                id: row.get(0)?,
                event_type: row.get(1)?,
                title: row.get(2)?,
                description: row.get(3)?,
                occurred_at: row.get(4)?,
                merchant: row.get(5)?,
                source: row.get(6)?,
                created_at: row.get(7)?,
                updated_at: row.get(8)?,
            })
        })
        .optional()?;
    Ok(row)
}

fn load_event_detail(conn: &Connection, event_id: &str) -> AppResult<LifeEventDetail> {
    let event = load_event(conn, event_id)?
        .ok_or_else(|| AppError::NotFound("生活记录不存在或已删除".into()))?;
    let items = load_event_items(conn, event_id)?;
    let links = load_links(conn, Some("event"), Some(event_id))?;
    Ok(LifeEventDetail {
        event,
        items,
        links,
    })
}

fn list_purchases_for_item(
    conn: &Connection,
    item_id: &str,
    limit: i64,
) -> AppResult<Vec<LifePurchase>> {
    let mut stmt = conn.prepare(
        "SELECT e.id, ei.id, e.occurred_at, ei.item_name_snapshot, ei.quantity_value,
                ei.quantity_unit, ei.unit_price_minor, ei.total_price_minor, ei.currency,
                ei.amount_scale, e.merchant, ei.note, e.description, e.created_at
         FROM life_event_items ei
         JOIN life_events e ON e.id = ei.event_id
         WHERE ei.item_id = ?1 AND e.event_type = 'purchase' AND e.deleted_at IS NULL
         ORDER BY e.occurred_at DESC, e.created_at DESC, e.id DESC
         LIMIT ?2",
    )?;
    let rows = stmt
        .query_map(params![item_id, limit], |row| {
            Ok(LifePurchase {
                event_id: row.get(0)?,
                item_row_id: row.get(1)?,
                occurred_at: row.get(2)?,
                item_name: row.get(3)?,
                quantity_value: row.get(4)?,
                quantity_unit: row.get::<_, Option<String>>(5)?.unwrap_or_default(),
                unit_price_minor: row.get(6)?,
                total_price_minor: row.get(7)?,
                currency: row.get(8)?,
                amount_scale: row.get(9)?,
                merchant: row.get(10)?,
                note: row.get(11)?,
                event_note: row.get(12)?,
                created_at: row.get(13)?,
                links: Vec::new(),
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// 为购买列表补齐事件级票据关联（一次查询，不做 N+1）。
fn attach_event_links(conn: &Connection, purchases: &mut [LifePurchase]) -> AppResult<()> {
    if purchases.is_empty() {
        return Ok(());
    }
    let mut stmt = conn.prepare(
        "SELECT id, owner_type, owner_id, document_ref, document_source, document_name,
                mime, byte_size, remote_ref, remote_source, transfer_state, created_at, updated_at
         FROM life_document_links
         WHERE deleted_at IS NULL AND owner_type = 'event'
         ORDER BY created_at DESC, id DESC
         LIMIT 1000",
    )?;
    let rows = stmt
        .query_map([], map_link_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut by_owner: HashMap<String, Vec<LifeDocumentLink>> = HashMap::new();
    for link in rows {
        by_owner.entry(link.owner_id.clone()).or_default().push(link);
    }
    for purchase in purchases.iter_mut() {
        if let Some(links) = by_owner.remove(&purchase.event_id) {
            purchase.links = links;
        }
    }
    Ok(())
}

// ── 命令层 ──────────────────────────────────────────────────

#[tauri::command]
pub fn life_items_list(
    db: State<'_, Arc<Db>>,
    filter: Option<LifeItemFilter>,
) -> AppResult<Vec<LifeItemSummary>> {
    let filter = filter.unwrap_or_default();
    db.with_read(|conn| list_life_items_inner(conn, &filter))
}

#[tauri::command]
pub fn life_item_history(
    db: State<'_, Arc<Db>>,
    item_id: String,
    limit: Option<u32>,
) -> AppResult<LifeItemHistory> {
    let limit = limit.unwrap_or(40).clamp(1, 200) as i64;
    db.with_read(|conn| {
        let item = load_life_item_summary(conn, &item_id)?
            .ok_or_else(|| AppError::NotFound("商品不存在或已删除".into()))?;
        let mut purchases = list_purchases_for_item(conn, &item_id, limit)?;
        attach_event_links(conn, &mut purchases)?;
        let total_count = item.purchase_count;
        Ok(LifeItemHistory {
            item,
            purchases,
            total_count,
        })
    })
}

#[tauri::command]
pub fn life_events_recent(
    db: State<'_, Arc<Db>>,
    limit: Option<u32>,
    event_type: Option<String>,
) -> AppResult<Vec<LifeEventSummary>> {
    let limit = limit.unwrap_or(20).clamp(1, 100) as i64;
    db.with_read(|conn| {
        let mut stmt = conn.prepare(
            "SELECT e.id, e.event_type, e.title, e.description, e.occurred_at, e.merchant,
                    (SELECT GROUP_CONCAT(ei.item_name_snapshot, '、')
                       FROM life_event_items ei WHERE ei.event_id = e.id),
                    (SELECT COUNT(*) FROM life_document_links l
                       WHERE l.owner_type = 'event' AND l.owner_id = e.id AND l.deleted_at IS NULL)
             FROM life_events e
             WHERE e.deleted_at IS NULL AND (?1 IS NULL OR e.event_type = ?1)
             ORDER BY e.occurred_at DESC, e.created_at DESC, e.id DESC
             LIMIT ?2",
        )?;
        let mut rows = stmt
            .query_map(params![event_type, limit], |row| {
                let names: Option<String> = row.get(6)?;
                Ok(LifeEventSummary {
                    id: row.get(0)?,
                    event_type: row.get(1)?,
                    title: row.get(2)?,
                    description: row.get(3)?,
                    occurred_at: row.get(4)?,
                    merchant: row.get(5)?,
                    item_names: names
                        .unwrap_or_default()
                        .split('、')
                        .filter(|s| !s.is_empty())
                        .map(|s| s.to_string())
                        .collect(),
                    total_price_minor: None,
                    currency: String::new(),
                    amount_scale: 2,
                    totals: Vec::new(),
                    link_count: row.get::<_, Option<i64>>(7)?.unwrap_or(0),
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(stmt);

        // 金额按币种在 Rust 侧分组，不在 SQL 里 SUM/MAX：SQL 无法表达「不同货币不可相加」。
        // 事件上限 100，逐事件读取明细是本地小查询，换取规则可测试、可解释。
        let mut items_stmt = conn.prepare(
            "SELECT total_price_minor, currency, amount_scale
               FROM life_event_items WHERE event_id = ?1",
        )?;
        for summary in &mut rows {
            let entries = items_stmt
                .query_map(params![summary.id], |row| {
                    Ok((
                        row.get::<_, Option<i64>>(0)?,
                        row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                        row.get::<_, Option<i64>>(2)?.unwrap_or(2),
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            summary.totals = group_currency_totals(&entries)?;
            if summary.totals.len() == 1 {
                let only = &summary.totals[0];
                summary.total_price_minor = Some(only.total_price_minor);
                summary.currency = only.currency.clone();
                summary.amount_scale = only.amount_scale;
            }
        }
        Ok(rows)
    })
}

#[tauri::command]
pub fn life_event_detail(db: State<'_, Arc<Db>>, event_id: String) -> AppResult<LifeEventDetail> {
    db.with_read(|conn| load_event_detail(conn, &event_id))
}

#[tauri::command]
pub fn life_overview(db: State<'_, Arc<Db>>) -> AppResult<LifeOverview> {
    db.with_read(|conn| {
        let item_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM life_items WHERE deleted_at IS NULL",
            [],
            |r| r.get(0),
        )?;
        let purchase_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM life_events WHERE event_type = 'purchase' AND deleted_at IS NULL",
            [],
            |r| r.get(0),
        )?;
        let receipt_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM life_document_links WHERE deleted_at IS NULL",
            [],
            |r| r.get(0),
        )?;
        let cutoff = to_iso(Utc::now() - chrono::Duration::days(30));
        let purchases_last_30_days: i64 = conn.query_row(
            "SELECT COUNT(*) FROM life_events
             WHERE event_type = 'purchase' AND deleted_at IS NULL AND occurred_at >= ?1",
            params![cutoff],
            |r| r.get(0),
        )?;
        Ok(LifeOverview {
            item_count,
            purchase_count,
            receipt_count,
            purchases_last_30_days,
        })
    })
}

/// 解析/复用商品：优先显式 item_id，其次同名归一复用，最后新建。
fn resolve_item_in_tx(
    conn: &Connection,
    input: &LifeItemInput,
    now: &str,
) -> AppResult<(String, String)> {
    if let Some(item_id) = input.item_id.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let existing: Option<String> = conn
            .query_row(
                "SELECT name FROM life_items WHERE id = ?1 AND deleted_at IS NULL",
                params![item_id],
                |row| row.get(0),
            )
            .optional()?;
        let Some(name) = existing else {
            return Err(AppError::NotFound("关联商品不存在或已删除".into()));
        };
        return Ok((item_id.to_string(), name));
    }
    let raw_name = input.name.as_deref().unwrap_or("").trim();
    if raw_name.is_empty() {
        return Err(AppError::Validation("商品名称不能为空".into()));
    }
    if raw_name.chars().count() > 80 {
        return Err(AppError::Validation("商品名称超过 80 字符".into()));
    }
    let normalized = normalize_name(raw_name);
    if normalized.is_empty() {
        return Err(AppError::Validation("商品名称不合法".into()));
    }
    let existing: Option<(String, String)> = conn
        .query_row(
            "SELECT id, name FROM life_items
             WHERE normalized_name = ?1 AND deleted_at IS NULL",
            params![normalized],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    if let Some((id, name)) = existing {
        // 用户显式补充别名/分类时更新主数据；不覆盖既有名称。
        let mut aliases: Vec<String> = Vec::new();
        if let Some(input_aliases) = input.aliases.as_ref() {
            for alias in input_aliases {
                let trimmed = alias.trim();
                if trimmed.is_empty() || trimmed.chars().count() > 40 {
                    continue;
                }
                let normalized_alias = normalize_name(trimmed);
                if normalized_alias.is_empty() || aliases.iter().any(|a| normalize_name(a) == normalized_alias) {
                    continue;
                }
                aliases.push(trimmed.to_string());
                if aliases.len() >= 8 {
                    break;
                }
            }
        }
        if !aliases.is_empty() {
            let aliases_json = serde_json::to_string(&aliases)?;
            conn.execute(
                "UPDATE life_items SET aliases = ?1, updated_at = ?2 WHERE id = ?3",
                params![aliases_json, now, id],
            )?;
        }
        return Ok((id, name));
    }
    let id = format!("li_{}", Uuid::new_v4());
    let category = input.category.as_deref().unwrap_or("").trim().to_string();
    validate_text(&category, "分类", 40)?;
    let note = input.note.as_deref().unwrap_or("").trim().to_string();
    validate_text(&note, "备注", 500)?;
    let mut aliases: Vec<String> = Vec::new();
    if let Some(input_aliases) = input.aliases.as_ref() {
        for alias in input_aliases {
            let trimmed = alias.trim();
            if trimmed.is_empty() || trimmed.chars().count() > 40 {
                continue;
            }
            if aliases.iter().any(|a| normalize_name(a) == normalize_name(trimmed)) {
                continue;
            }
            aliases.push(trimmed.to_string());
            if aliases.len() >= 8 {
                break;
            }
        }
    }
    let aliases_json = serde_json::to_string(&aliases)?;
    conn.execute(
        "INSERT INTO life_items (id, name, normalized_name, category, aliases, note, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![id, raw_name, normalized, category, aliases_json, note, now, now],
    )?;
    Ok((id, raw_name.to_string()))
}

fn resolve_currency(
    db: &Db,
    input_currency: Option<&str>,
    has_amount: bool,
) -> AppResult<String> {
    let explicit = normalize_currency(input_currency)?;
    if !explicit.is_empty() {
        return Ok(explicit);
    }
    if !has_amount {
        return Ok(String::new());
    }
    let fallback = crate::db::Settings::load(db)
        .map(|s| s.life_default_currency.trim().to_uppercase())
        .unwrap_or_default();
    if fallback.is_empty() {
        return Err(AppError::Validation(
            "请选择货币：未配置默认货币时不自动假设人民币".into(),
        ));
    }
    normalize_currency(Some(fallback.as_str()))
}

fn build_event_item_values(
    db: &Db,
    input: &LifeItemInput,
) -> AppResult<(Option<String>, String, Option<i64>, Option<i64>, String, i64, String)> {
    let quantity = match input.quantity_value.as_deref() {
        Some(raw) => canonical_quantity(raw)?,
        None => None,
    };
    let unit = input.quantity_unit.as_deref().unwrap_or("").trim().to_string();
    validate_text(&unit, "单位", 16)?;
    let has_amount = input
        .unit_price
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .is_some()
        || input
            .total_price
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .is_some();
    let currency = resolve_currency(db, input.currency.as_deref(), has_amount)?;
    let scale = match input.amount_scale {
        Some(value) if (0..=3).contains(&value) => value,
        Some(_) => {
            return Err(AppError::Validation(
                "金额小数位必须是 0–3 的整数".into(),
            ))
        }
        None => currency_scale(&currency)?,
    };
    let unit_price = match input.unit_price.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(raw) => Some(parse_minor(raw, scale)?),
        None => None,
    };
    let total_price = match input.total_price.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(raw) => Some(parse_minor(raw, scale)?),
        None => None,
    };
    let note = input.note.as_deref().unwrap_or("").trim().to_string();
    validate_text(&note, "备注", 500)?;
    Ok((
        quantity,
        unit,
        unit_price,
        total_price,
        currency,
        scale,
        note,
    ))
}

#[tauri::command]
pub fn life_event_create(
    db: State<'_, Arc<Db>>,
    input: LifeEventInput,
) -> AppResult<LifeEventDetail> {
    let event_type = match input.event_type.as_deref() {
        Some("maintenance") => "maintenance",
        Some("general") => "general",
        Some("purchase") | None => "purchase",
        Some(other) => {
            return Err(AppError::Validation(format!(
                "不支持的事件类型：{}", other
            )))
        }
    };
    let source = match input.source.as_deref() {
        Some("capture") => "capture",
        Some("manual") | None => "manual",
        Some(other) => {
            return Err(AppError::Validation(format!(
                "不支持的事件来源：{}", other
            )))
        }
    };
    let items = input.items.clone().unwrap_or_default();
    if event_type == "purchase" && items.is_empty() {
        return Err(AppError::Validation("购买记录至少需要一个商品".into()));
    }
    let occurred_at = parse_occurred_at(input.occurred_at.as_deref().unwrap_or(""))?;
    let merchant = input.merchant.as_deref().unwrap_or("").trim().to_string();
    validate_text(&merchant, "商家", 80)?;
    let description = input.description.as_deref().unwrap_or("").trim().to_string();
    validate_text(&description, "描述", 2000)?;
    let title = {
        let provided = input.title.as_deref().unwrap_or("").trim().to_string();
        if provided.is_empty() {
            if event_type == "purchase" {
                let names: Vec<String> = items
                    .iter()
                    .filter_map(|i| i.name.as_deref().map(|s| s.trim().to_string()))
                    .filter(|s| !s.is_empty())
                    .collect();
                if names.is_empty() {
                    "购买记录".to_string()
                } else {
                    format!("购买 {}", names.join("、"))
                }
            } else {
                "生活记录".to_string()
            }
        } else {
            provided
        }
    };
    validate_text(&title, "标题", 120)?;

    let event_id = format!("le_{}", Uuid::new_v4());
    let now = now_iso();
    let db_ref: &Db = &**db;
    db.with_transaction(|conn| {
        conn.execute(
            "INSERT INTO life_events
             (id, event_type, title, description, occurred_at, merchant, source, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
            params![event_id, event_type, title, description, occurred_at, merchant, source, now],
        )?;
        for item in &items {
            let (item_id, snapshot) = resolve_item_in_tx(conn, item, &now)?;
            let (quantity, unit, unit_price, total_price, currency, amount_scale, note) =
                build_event_item_values(db_ref, item)?;
            let row_id = format!("lei_{}", Uuid::new_v4());
            conn.execute(
                "INSERT INTO life_event_items
                 (id, event_id, item_id, item_name_snapshot, quantity_value, quantity_unit,
                  unit_price_minor, total_price_minor, currency, amount_scale, note,
                  created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)",
                params![
                    row_id,
                    event_id,
                    item_id,
                    snapshot,
                    quantity,
                    unit,
                    unit_price,
                    total_price,
                    currency,
                    amount_scale,
                    note,
                    now
                ],
            )?;
        }
        Ok(())
    })?;
    db.with_read(|conn| load_event_detail(conn, &event_id))
}

#[tauri::command]
pub fn life_event_update(
    db: State<'_, Arc<Db>>,
    event_id: String,
    input: LifeEventInput,
) -> AppResult<LifeEventDetail> {
    let now = now_iso();
    let db_ref: &Db = &**db;
    db.with_transaction(|conn| {
        let existing = load_event(conn, &event_id)?
            .ok_or_else(|| AppError::NotFound("生活记录不存在或已删除".into()))?;
        let event_type = match input.event_type.as_deref() {
            Some("maintenance") => "maintenance",
            Some("general") => "general",
            Some("purchase") => "purchase",
            None => existing.event_type.as_str(),
            Some(other) => {
                return Err(AppError::Validation(format!(
                    "不支持的事件类型：{}", other
                )))
            }
        };
        let occurred_at = match input.occurred_at.as_deref().filter(|s| !s.trim().is_empty()) {
            Some(raw) => parse_occurred_at(raw)?,
            None => existing.occurred_at.clone(),
        };
        let title = input
            .title
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(existing.title.as_str())
            .to_string();
        validate_text(&title, "标题", 120)?;
        let description = input
            .description
            .as_deref()
            .map(str::trim)
            .unwrap_or(existing.description.as_str())
            .to_string();
        validate_text(&description, "描述", 2000)?;
        let merchant = input
            .merchant
            .as_deref()
            .map(str::trim)
            .unwrap_or(existing.merchant.as_str())
            .to_string();
        validate_text(&merchant, "商家", 80)?;
        conn.execute(
            "UPDATE life_events
             SET event_type = ?1, title = ?2, description = ?3, occurred_at = ?4,
                 merchant = ?5, updated_at = ?6
             WHERE id = ?7 AND deleted_at IS NULL",
            params![event_type, title, description, occurred_at, merchant, now, event_id],
        )?;

        if let Some(new_items) = input.items.as_ref() {
            if event_type == "purchase" && new_items.is_empty() {
                return Err(AppError::Validation("购买记录至少需要一个商品".into()));
            }
            let current = load_event_items(conn, &event_id)?;
            let shared = current.len().min(new_items.len());
            for index in 0..shared {
                let item = &new_items[index];
                let row = &current[index];
                let (item_id, snapshot) = match item
                    .item_id
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                {
                    Some(id) => {
                        let name: Option<String> = conn
                            .query_row(
                                "SELECT name FROM life_items WHERE id = ?1 AND deleted_at IS NULL",
                                params![id],
                                |r| r.get(0),
                            )
                            .optional()?;
                        match name {
                            Some(name) => (Some(id.to_string()), name),
                            None => {
                                // 显式 ID 失效：只有调用方同时给了新名称时才重建商品，
                                // 否则如实报错，不静默回退到旧快照。
                                if item
                                    .name
                                    .as_deref()
                                    .map(str::trim)
                                    .filter(|s| !s.is_empty())
                                    .is_some()
                                {
                                    let (new_id, snapshot) =
                                        resolve_item_in_tx(conn, item, &now)?;
                                    (Some(new_id), snapshot)
                                } else {
                                    return Err(AppError::NotFound(
                                        "关联商品不存在或已删除".into(),
                                    ));
                                }
                            }
                        }
                    }
                    None => {
                        let (new_id, snapshot) = resolve_item_in_tx(conn, item, &now)?;
                        (Some(new_id), snapshot)
                    }
                };
                let (quantity, unit, unit_price, total_price, currency, amount_scale, note) =
                    build_event_item_values(db_ref, item)?;
                conn.execute(
                    "UPDATE life_event_items
                     SET item_id = ?1, item_name_snapshot = ?2, quantity_value = ?3,
                         quantity_unit = ?4, unit_price_minor = ?5, total_price_minor = ?6,
                         currency = ?7, amount_scale = ?8, note = ?9, updated_at = ?10
                     WHERE id = ?11",
                    params![
                        item_id,
                        snapshot,
                        quantity,
                        unit,
                        unit_price,
                        total_price,
                        currency,
                        amount_scale,
                        note,
                        now,
                        row.id
                    ],
                )?;
            }
            for item in new_items.iter().skip(shared) {
                let (item_id, snapshot) = resolve_item_in_tx(conn, item, &now)?;
                let (quantity, unit, unit_price, total_price, currency, amount_scale, note) =
                    build_event_item_values(db_ref, item)?;
                conn.execute(
                    "INSERT INTO life_event_items
                     (id, event_id, item_id, item_name_snapshot, quantity_value, quantity_unit,
                      unit_price_minor, total_price_minor, currency, amount_scale, note,
                      created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)",
                    params![
                        format!("lei_{}", Uuid::new_v4()),
                        event_id,
                        item_id,
                        snapshot,
                        quantity,
                        unit,
                        unit_price,
                        total_price,
                        currency,
                        amount_scale,
                        note,
                        now
                    ],
                )?;
            }
            // 用户显式提交的 items 是完整列表：多余旧行按删除处理（触发器写墓碑）。
            for row in current.iter().skip(shared) {
                conn.execute(
                    "DELETE FROM life_event_items WHERE id = ?1",
                    params![row.id],
                )?;
            }
        }
        Ok(())
    })?;
    db.with_read(|conn| load_event_detail(conn, &event_id))
}

#[tauri::command]
pub fn life_event_delete(db: State<'_, Arc<Db>>, event_id: String) -> AppResult<()> {
    let now = now_iso();
    db.with_transaction(|conn| {
        load_event(conn, &event_id)?
            .ok_or_else(|| AppError::NotFound("生活记录不存在或已删除".into()))?;
        // 软删除事件本身；子行硬删除（触发器写墓碑，手机端按墓碑清副本），
        // 避免留下孤儿行让两端计数不一致。
        conn.execute(
            "UPDATE life_events SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2",
            params![now, event_id],
        )?;
        conn.execute(
            "DELETE FROM life_event_items WHERE event_id = ?1",
            params![event_id],
        )?;
        // 关联只解除，不删除任何原始文件。
        conn.execute(
            "UPDATE life_document_links SET deleted_at = ?1, updated_at = ?1
             WHERE owner_type = 'event' AND owner_id = ?2 AND deleted_at IS NULL",
            params![now, event_id],
        )?;
        Ok(())
    })
}

/// 规则化快捷查询：不引入 AI，也不返回任何预置示例数据。
#[tauri::command]
pub fn life_quick_query(db: State<'_, Arc<Db>>, text: String) -> AppResult<LifeQuickQueryResult> {
    let keyword = extract_query_keyword(&text);
    if keyword.is_empty() {
        return Ok(LifeQuickQueryResult {
            intent: "none".into(),
            keyword: String::new(),
            matched_by: "empty".into(),
            item: None,
            purchases: Vec::new(),
            total_count: 0,
            last_purchase_at: None,
            interval_days: None,
            message: "请输入商品名称".into(),
        });
    }
    db.with_read(|conn| {
        let normalized = normalize_name(&keyword);
        let by_exact: Option<String> = conn
            .query_row(
                "SELECT id FROM life_items WHERE normalized_name = ?1 AND deleted_at IS NULL",
                params![normalized],
                |row| row.get(0),
            )
            .optional()?;
        let (item_id, matched_by) = match by_exact {
            Some(id) => (Some(id), "name"),
            None => {
                let by_alias: Option<String> = conn
                    .query_row(
                        "SELECT id FROM life_items
                         WHERE deleted_at IS NULL AND aliases LIKE ?1 ESCAPE '\\'
                         ORDER BY name ASC LIMIT 1",
                        params![like_pattern(&keyword)],
                        |row| row.get(0),
                    )
                    .optional()?;
                match by_alias {
                    Some(id) => (Some(id), "alias"),
                    None => {
                        // 前缀/包含兜底：只用于定位，不合并商品。
                        let by_partial: Option<String> = conn
                            .query_row(
                                "SELECT i.id FROM life_items i
                                 WHERE i.deleted_at IS NULL AND (
                                   i.normalized_name LIKE ?1 ESCAPE '\\' OR i.name LIKE ?1 ESCAPE '\\')
                                   AND EXISTS (
                                     SELECT 1 FROM life_event_items ei
                                     JOIN life_events e ON e.id = ei.event_id
                                     WHERE ei.item_id = i.id AND e.deleted_at IS NULL
                                   )
                                 ORDER BY LENGTH(i.normalized_name) ASC, i.name ASC LIMIT 1",
                                params![like_pattern(&normalized)],
                                |row| row.get(0),
                            )
                            .optional()?;
                        match by_partial {
                            Some(id) => (Some(id), "partial"),
                            None => (None, "none"),
                        }
                    }
                }
            }
        };
        let Some(item_id) = item_id else {
            return Ok(LifeQuickQueryResult {
                intent: "none".into(),
                keyword,
                matched_by: "none".into(),
                item: None,
                purchases: Vec::new(),
                total_count: 0,
                last_purchase_at: None,
                interval_days: None,
                message: "尚无购买记录".into(),
            });
        };
        let item = load_life_item_summary(conn, &item_id)?
            .ok_or_else(|| AppError::NotFound("商品不存在或已删除".into()))?;
        let mut purchases = list_purchases_for_item(conn, &item_id, 40)?;
        attach_event_links(conn, &mut purchases)?;
        let total_count = item.purchase_count;
        let message = if total_count == 0 {
            "尚无购买记录".to_string()
        } else {
            match item.last_purchase_at.as_deref() {
                Some(last) => format!("最近一次购买：{}", display_date(last)),
                None => "尚无购买记录".to_string(),
            }
        };
        Ok(LifeQuickQueryResult {
            intent: if total_count > 0 {
                "purchase_history".into()
            } else {
                "none".into()
            },
            keyword,
            matched_by: matched_by.into(),
            last_purchase_at: item.last_purchase_at.clone(),
            interval_days: item.interval_days,
            total_count,
            item: Some(item),
            purchases,
            message,
        })
    })
}

fn display_date(iso: &str) -> String {
    DateTime::parse_from_rfc3339(iso)
        .map(|dt| {
            dt.with_timezone(&Local)
                .format("%Y-%m-%d")
                .to_string()
        })
        .unwrap_or_else(|_| iso.to_string())
}

/// 从「上次什么时候买的大米？」这类确定性口语句子里提取商品关键词。
///
/// 规则只做前缀/后缀剥离，不猜测同义词；剥离后为空则返回空串。
pub fn extract_query_keyword(text: &str) -> String {
    let mut value = text.trim();
    let trim_chars = [' ', '?', '？', '。', '！', '!', '，', ','];
    value = value.trim_matches(|c: char| trim_chars.contains(&c));
    const PREFIXES: [&str; 14] = [
        "上次什么时候买的",
        "上次什么时候买",
        "上一次什么时候买的",
        "最近一次什么时候买的",
        "上次买",
        "上一次买",
        "最近一次买",
        "最近买",
        "什么时候买的",
        "什么时候买",
        "何时买的",
        "买过",
        "买了",
        "查询",
    ];
    const SUFFIXES: [&str; 16] = [
        "的购买记录",
        "购买记录",
        "的购买历史",
        "购买历史",
        "什么时候买的",
        "什么时候买",
        "上次买的",
        "上一次买的",
        "最近一次买的",
        "买了什么",
        "买过什么",
        "的购买",
        "的记录",
        "记录",
        "历史",
        "吗",
    ];
    let mut changed = true;
    while changed {
        changed = false;
        for prefix in PREFIXES {
            if let Some(rest) = value.strip_prefix(prefix) {
                value = rest.trim();
                changed = true;
            }
        }
        for suffix in SUFFIXES {
            if let Some(rest) = value.strip_suffix(suffix) {
                value = rest.trim();
                changed = true;
            }
        }
        if let Some(rest) = value.strip_prefix('买') {
            // 单独的「买」前缀（「买大米」）；「买过」已被上表覆盖。
            if !rest.is_empty() {
                value = rest.trim();
                changed = true;
            }
        }
    }
    // 「上次什么时候买的大米」在剥掉「上次什么时候买」后仍留一个「的」。
    while let Some(rest) = value.strip_prefix('的') {
        value = rest.trim();
    }
    while let Some(rest) = value.strip_suffix('的') {
        value = rest.trim();
    }
    value.to_string()
}

/// owner 存在性校验：禁止产生悬空关联（删除的业主对象也不再接受新关联）。
fn owner_exists(conn: &Connection, owner_type: &str, owner_id: &str) -> AppResult<bool> {
    let exists = match owner_type {
        "event" => conn
            .query_row(
                "SELECT 1 FROM life_events WHERE id = ?1 AND deleted_at IS NULL",
                params![owner_id],
                |_| Ok(()),
            )
            .optional()?
            .is_some(),
        "item" => conn
            .query_row(
                "SELECT 1 FROM life_items WHERE id = ?1 AND deleted_at IS NULL",
                params![owner_id],
                |_| Ok(()),
            )
            .optional()?
            .is_some(),
        _ => false,
    };
    Ok(exists)
}

#[tauri::command]
pub fn life_document_link_create(
    db: State<'_, Arc<Db>>,
    input: LifeDocumentLinkInput,
) -> AppResult<LifeDocumentLink> {
    let owner_type = input.owner_type.trim();
    if !matches!(owner_type, "event" | "item") {
        return Err(AppError::Validation(
            "owner_type 只能是 event 或 item".into(),
        ));
    }
    let source = input.document_source.trim();
    if !matches!(source, "capture_asset" | "shelf_item" | "attachment" | "file") {
        return Err(AppError::Validation(
            "document_source 非法".into(),
        ));
    }
    let reference = input.document_ref.trim();
    if reference.is_empty() {
        return Err(AppError::Validation("票据引用不能为空".into()));
    }
    validate_text(reference, "票据引用", 500)?;
    let state = match input.transfer_state.as_deref() {
        None | Some("") => "local",
        Some("local") | Some("metadata_only") | Some("transferred") | Some("missing") => {
            input.transfer_state.as_deref().unwrap()
        }
        Some(_) => return Err(AppError::Validation("transfer_state 非法".into())),
    };
    let name = input.document_name.trim().to_string();
    validate_text(&name, "票据名称", 200)?;
    let mime = input.mime.trim().to_string();
    validate_text(&mime, "MIME", 100)?;
    let now = now_iso();
    let link_id = format!("ldl_{}", Uuid::new_v4());
    db.with_transaction(|conn| {
        // owner 必须存在：禁止悬空关联。
        if !owner_exists(conn, owner_type, &input.owner_id)? {
            return Err(AppError::NotFound("关联对象不存在或已删除".into()));
        }
        // 幂等：同一对象 + 同一文件重复提交直接返回已有行。
        let existing: Option<String> = conn
            .query_row(
                "SELECT id FROM life_document_links
                 WHERE deleted_at IS NULL AND owner_type = ?1 AND owner_id = ?2
                   AND document_ref = ?3 AND document_source = ?4",
                params![owner_type, input.owner_id, reference, source],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(id) = existing {
            return Ok(id);
        }
        conn.execute(
            "INSERT INTO life_document_links
             (id, owner_type, owner_id, document_ref, document_source, document_name, mime,
              byte_size, transfer_state, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)",
            params![
                link_id,
                owner_type,
                input.owner_id,
                reference,
                source,
                name,
                mime,
                input.byte_size,
                state,
                now
            ],
        )?;
        Ok(link_id.clone())
    })?;
    db.with_read(|conn| {
        let links = load_links(conn, Some(owner_type), Some(&input.owner_id))?;
        links
            .into_iter()
            .find(|l| l.id == link_id)
            .ok_or_else(|| AppError::NotFound("票据关联不存在".into()))
    })
}

#[tauri::command]
pub fn life_document_link_delete(db: State<'_, Arc<Db>>, link_id: String) -> AppResult<()> {
    let now = now_iso();
    db.with_transaction(|conn| {
        let exists: Option<String> = conn
            .query_row(
                "SELECT id FROM life_document_links WHERE id = ?1 AND deleted_at IS NULL",
                params![link_id],
                |row| row.get(0),
            )
            .optional()?;
        if exists.is_none() {
            // 幂等：已解除的关联再次删除视为成功。
            return Ok(());
        }
        // 只解除关联：不删除 capture_assets / shelf_items / 本地文件。
        conn.execute(
            "UPDATE life_document_links SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2",
            params![now, link_id],
        )?;
        Ok(())
    })
}

#[tauri::command]
pub fn life_document_links_list(
    db: State<'_, Arc<Db>>,
    owner_type: Option<String>,
    owner_id: Option<String>,
) -> AppResult<Vec<LifeDocumentLink>> {
    db.with_read(|conn| {
        load_links(conn, owner_type.as_deref(), owner_id.as_deref())
    })
}

// ── 测试 ────────────────────────────────────────────────────

#[cfg(test)]
#[path = "life_tests.rs"]
mod tests;
