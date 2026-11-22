//! 生活领域单元测试：迁移、归一化、定点金额/数量、历史排序、快捷查询、
//! 关联校验与删除语义。测试只使用内存 SQLite（真实迁移），不伪造数据。

use super::*;

fn insert_purchase(
    db: &Db,
    name: &str,
    date: &str,
    qty: Option<&str>,
    total: Option<&str>,
    currency: Option<&str>,
) -> String {
    let now = now_iso();
    let occurred = parse_occurred_at(date).unwrap();
    let item = LifeItemInput {
        name: Some(name.into()),
        quantity_value: qty.map(str::to_string),
        quantity_unit: Some("kg".into()),
        total_price: total.map(str::to_string),
        currency: currency.map(str::to_string),
        ..Default::default()
    };
    db.with_transaction(|conn| {
        let event_id = format!("le_{}", Uuid::new_v4());
        conn.execute(
            "INSERT INTO life_events
             (id, event_type, title, description, occurred_at, merchant, source, created_at, updated_at)
             VALUES (?1, 'purchase', ?2, '', ?3, '某超市', 'manual', ?4, ?4)",
            params![event_id, format!("购买 {}", name), occurred, now],
        )?;
        let (item_id, snapshot) = resolve_item_in_tx(conn, &item, &now)?;
        let (quantity, unit, unit_price, total_price, currency_value, amount_scale, note) =
            build_event_item_values(db, &item)?;
        conn.execute(
            "INSERT INTO life_event_items
             (id, event_id, item_id, item_name_snapshot, quantity_value, quantity_unit,
              unit_price_minor, total_price_minor, currency, amount_scale, note, created_at, updated_at)
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
                currency_value,
                amount_scale,
                note,
                now
            ],
        )?;
        Ok(event_id)
    })
    .unwrap()
}

#[test]
fn migration_creates_tables_and_sync_triggers() {
    let db = Db::open_in_memory().expect("内存库迁移失败");
    db.with_read(|conn| {
        for table in [
            "life_items",
            "life_events",
            "life_event_items",
            "life_document_links",
        ] {
            let exists: i64 = conn.query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name = ?1",
                params![table],
                |r| r.get(0),
            )?;
            assert_eq!(exists, 1, "缺少表 {table}");
        }
        let triggers: i64 = conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name LIKE 'trg_sync_life_%'",
            [],
            |r| r.get(0),
        )?;
        assert_eq!(triggers, 12, "生活同步触发器数量应为 12");
        // v66：票据关联必须区分本机来源（document_ref）与桌面实际收到的远端原图。
        let mut columns = Vec::new();
        let mut stmt = conn.prepare("PRAGMA table_info(life_document_links)")?;
        let mut rows = stmt.query([])?;
        while let Some(row) = rows.next()? {
            columns.push(row.get::<_, String>(1)?);
        }
        assert!(columns.contains(&"remote_ref".to_string()));
        assert!(columns.contains(&"remote_source".to_string()));
        // v67：历史金额默认 2 位；新行按货币精度显式保存。
        let amount_scale_type: String = conn.query_row(
            "SELECT type FROM pragma_table_info('life_event_items') WHERE name = 'amount_scale'",
            [],
            |r| r.get(0),
        )?;
        assert_eq!(amount_scale_type, "INTEGER");
        Ok::<_, AppError>(())
    })
    .unwrap();
}

#[test]
fn normalize_name_handles_fullwidth_and_spacing() {
    assert_eq!(normalize_name("  大　米  "), "大 米");
    assert_eq!(normalize_name("Milk"), "milk");
    assert_eq!(normalize_name("大米。"), "大米");
    // 契约明确「全角 ASCII → 半角」：全角括号同样归一为半角，与移动端一致。
    assert_eq!(normalize_name("大米（东北）"), "大米(东北)");
    assert_ne!(normalize_name("小包装大米"), normalize_name("大米"));
}

/// 购买时间以 UTC 存储，展示与验收按用户本地日期（+08:00）判断。
fn local_date(iso: &str) -> String {
    chrono::DateTime::parse_from_rfc3339(iso)
        .expect("occurred_at 必须是 RFC3339")
        .with_timezone(&chrono::FixedOffset::east_opt(8 * 3600).unwrap())
        .format("%Y-%m-%d")
        .to_string()
}

#[test]
fn money_and_quantity_are_fixed_point() {
    assert_eq!(parse_minor("48", 2).unwrap(), 4800);
    assert_eq!(parse_minor("48.5", 2).unwrap(), 4850);
    assert_eq!(parse_minor("0.05", 2).unwrap(), 5);
    assert!(parse_minor("48.555", 2).is_err());
    assert!(parse_minor("-1", 2).is_err());
    // 货币精度必须按 ISO 小数位解析：JPY 0 位、KWD 3 位，不能一律两位。
    assert_eq!(parse_minor("48", 0).unwrap(), 48);
    assert!(parse_minor("48.5", 0).is_err());
    assert_eq!(parse_minor("48.123", 3).unwrap(), 48123);
    assert!(parse_minor("48.1234", 3).is_err());
    assert_eq!(currency_scale("JPY").unwrap(), 0);
    assert_eq!(currency_scale("KWD").unwrap(), 3);
    assert_eq!(currency_scale("CNY").unwrap(), 2);
    assert!(currency_scale("XYZ").is_err());
    assert_eq!(canonical_quantity("5").unwrap().unwrap(), "5");
    assert_eq!(canonical_quantity("5.500").unwrap().unwrap(), "5.5");
    assert_eq!(canonical_quantity("0.250").unwrap().unwrap(), "0.25");
    assert!(canonical_quantity("1.2345").is_err());
}

#[test]
fn purchase_history_sorts_by_occurred_at_not_created_at() {
    let db = Db::open_in_memory().unwrap();
    insert_purchase(&db, "大米", "2026-11-03", Some("5"), Some("48"), Some("CNY"));
    // 补录两条更早的记录：创建时间更新，但最近购买必须仍是 11-03。
    insert_purchase(&db, "大米", "2026-10-04", Some("5"), Some("46"), Some("CNY"));
    insert_purchase(&db, "大米", "2026-09-06", Some("10"), Some("90"), Some("CNY"));

    let items = db
        .with_read(|conn| list_life_items_inner(conn, &LifeItemFilter::default()))
        .unwrap();
    assert_eq!(items.len(), 1);
    let summary = &items[0];
    assert_eq!(summary.purchase_count, 3);
    let last = summary.last_purchase_at.clone().unwrap();
    assert_eq!(local_date(&last), "2026-11-03", "最近购买应为 11-03，实际 {last}");
    assert_eq!(summary.interval_days, Some(30));
    assert_eq!(summary.last_total_price_minor, Some(4800));

    let history = db
        .with_read(|conn| list_purchases_for_item(conn, &summary.id, 40))
        .unwrap();
    assert_eq!(history.len(), 3);
    assert_eq!(local_date(&history[0].occurred_at), "2026-11-03");
    assert_eq!(local_date(&history[1].occurred_at), "2026-10-04");
    assert_eq!(local_date(&history[2].occurred_at), "2026-09-06");
    assert_eq!(history[0].quantity_value.as_deref(), Some("5"));
}

#[test]
fn item_reuse_uses_normalized_name_without_merging_similar_names() {
    let db = Db::open_in_memory().unwrap();
    insert_purchase(&db, "Milk", "2026-11-03", Some("1"), Some("12"), Some("CNY"));
    insert_purchase(&db, "milk", "2026-10-04", Some("2"), Some("24"), Some("CNY"));
    insert_purchase(&db, "大米", "2026-10-01", Some("5"), Some("48"), Some("CNY"));
    // 全角空格按契约折叠为普通空格，但内部空格保留：`大 米` 与 `大米`
    // 是不同 normalized_name，不能为了“看起来像”强行合并。
    insert_purchase(&db, "大　米", "2026-09-01", Some("5"), Some("46"), Some("CNY"));
    insert_purchase(&db, "东北大米", "2026-08-01", Some("5"), Some("80"), Some("CNY"));

    let items = db
        .with_read(|conn| list_life_items_inner(conn, &LifeItemFilter::default()))
        .unwrap();
    assert_eq!(items.len(), 4, "大小写归一复用；空格/相似名称不得强行合并");
    let milk = items
        .iter()
        .find(|item| item.name == "Milk")
        .expect("缺少 Milk");
    assert_eq!(milk.purchase_count, 2);
    let rice = items
        .iter()
        .find(|item| item.name == "大米")
        .expect("缺少大米");
    assert_eq!(rice.purchase_count, 1);
    let spaced_rice = items
        .iter()
        .find(|item| item.name == "大　米")
        .expect("缺少 大　米");
    assert_eq!(spaced_rice.purchase_count, 1);
}

#[test]
fn quick_query_returns_real_latest_purchase() {
    let db = Db::open_in_memory().unwrap();
    insert_purchase(&db, "大米", "2026-11-03", Some("5"), Some("48"), Some("CNY"));
    let keyword = extract_query_keyword("上次什么时候买的大米？");
    assert_eq!(keyword, "大米");
    db.with_read(|conn| {
        let item_id: String = conn.query_row(
            "SELECT id FROM life_items WHERE normalized_name = '大米' AND deleted_at IS NULL",
            [],
            |r| r.get(0),
        )?;
        let item = load_life_item_summary(conn, &item_id)?.unwrap();
        let purchases = list_purchases_for_item(conn, &item_id, 40)?;
        assert_eq!(item.purchase_count, 1);
        assert_eq!(item.last_total_price_minor, Some(4800));
        assert_eq!(purchases.len(), 1);
        Ok::<_, AppError>(())
    })
    .unwrap();
}

#[test]
fn items_list_accepts_natural_language_queries() {
    let db = Db::open_in_memory().unwrap();
    insert_purchase(&db, "大米", "2026-11-03", Some("5"), Some("48"), Some("CNY"));
    let items = db
        .with_read(|conn| {
            list_life_items_inner(
                conn,
                &LifeItemFilter {
                    query: Some("上次什么时候买的大米？".into()),
                    limit: None,
                },
            )
        })
        .unwrap();
    assert_eq!(items.len(), 1, "自然语言查询必须定位真实商品");
    assert_eq!(items[0].name, "大米");
    assert_eq!(items[0].purchase_count, 1);
}

#[test]
fn quick_query_keyword_rules_are_deterministic() {
    for (input, expected) in [
        ("大米", "大米"),
        ("买大米", "大米"),
        ("大米购买记录", "大米"),
        ("上次买大米", "大米"),
        ("大米什么时候买的", "大米"),
        ("上次什么时候买的大米？", "大米"),
    ] {
        assert_eq!(extract_query_keyword(input), expected, "输入 {input}");
    }
    assert!(extract_query_keyword("上次什么时候买的").is_empty());
}

#[test]
fn empty_db_has_no_items_and_no_demo_data() {
    let db = Db::open_in_memory().unwrap();
    let items = db
        .with_read(|conn| list_life_items_inner(conn, &LifeItemFilter::default()))
        .unwrap();
    assert!(items.is_empty(), "空库不得返回任何示例商品");
}

#[test]
fn amount_without_currency_and_default_requires_explicit_choice() {
    let db = Db::open_in_memory().unwrap();
    let item = LifeItemInput {
        name: Some("大米".into()),
        total_price: Some("48".into()),
        ..Default::default()
    };
    let err = build_event_item_values(&db, &item).unwrap_err();
    match err {
        AppError::Validation(message) => assert!(message.contains("请选择货币")),
        other => panic!("期望校验错误，实际 {other:?}"),
    }
}

#[test]
fn link_owner_validation_and_soft_delete_keep_original_event() {
    let db = Db::open_in_memory().unwrap();
    let event_id = insert_purchase(&db, "大米", "2026-11-03", Some("5"), Some("48"), Some("CNY"));
    let now = now_iso();
    db.with_transaction(|conn| {
        assert!(owner_exists(conn, "event", &event_id)?);
        assert!(!owner_exists(conn, "event", "le_missing")?);
        conn.execute(
            "INSERT INTO life_document_links
             (id, owner_type, owner_id, document_ref, document_source, document_name, mime,
              byte_size, transfer_state, created_at, updated_at)
             VALUES ('ldl_1','event',?1,'asset_1','capture_asset','小票.jpg','image/jpeg',
                     1024,'local',?2,?2)",
            params![event_id, now],
        )?;
        // 同一引用重复插入被唯一索引拒绝（命令层会先返回已有行）。
        let duplicate = conn.execute(
            "INSERT INTO life_document_links
             (id, owner_type, owner_id, document_ref, document_source, document_name, mime,
              byte_size, transfer_state, created_at, updated_at)
             VALUES ('ldl_2','event',?1,'asset_1','capture_asset','小票.jpg','image/jpeg',
                     1024,'local',?2,?2)",
            params![event_id, now],
        );
        assert!(duplicate.is_err(), "重复关联应被唯一索引拒绝");
        conn.execute(
            "UPDATE life_document_links SET deleted_at = ?1, updated_at = ?1 WHERE id = 'ldl_1'",
            params![now],
        )?;
        Ok::<_, AppError>(())
    })
    .unwrap();
    db.with_read(|conn| {
        let links = load_links(conn, Some("event"), Some(&event_id))?;
        assert!(links.is_empty(), "解除关联后不得再显示");
        assert!(
            load_event(conn, &event_id)?.is_some(),
            "解除关联不得删除生活记录"
        );
        Ok::<_, AppError>(())
    })
    .unwrap();
}

#[test]
fn deleting_event_soft_deletes_event_and_removes_children_with_tombstones() {
    let db = Db::open_in_memory().unwrap();
    let event_id = insert_purchase(&db, "大米", "2026-11-03", Some("5"), Some("48"), Some("CNY"));
    let now = now_iso();
    db.with_transaction(|conn| {
        conn.execute(
            "UPDATE life_events SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2",
            params![now, event_id],
        )?;
        conn.execute(
            "DELETE FROM life_event_items WHERE event_id = ?1",
            params![event_id],
        )?;
        Ok::<_, AppError>(())
    })
    .unwrap();
    db.with_read(|conn| {
        assert!(load_event(conn, &event_id)?.is_none());
        let items = load_event_items(conn, &event_id)?;
        assert!(items.is_empty());
        let tombstones: i64 = conn.query_row(
            "SELECT COUNT(*) FROM sync_changes
             WHERE entity = 'life_event_item' AND deleted = 1",
            [],
            |r| r.get(0),
        )?;
        assert!(tombstones >= 1, "删除子行必须写墓碑，供另一端清理副本");
        Ok::<_, AppError>(())
    })
    .unwrap();
}

#[test]
fn currency_totals_never_sum_different_currencies() {
    // 商品 A：CNY 100.00；商品 B：USD 100.00。正确结果是两行，而不是 CNY 200 或 200。
    let totals = group_currency_totals(&[
        (Some(10_000), "CNY".into(), 2),
        (Some(10_000), "USD".into(), 2),
    ])
    .unwrap();
    assert_eq!(totals.len(), 2);
    assert_eq!(totals[0].currency, "CNY");
    assert_eq!(totals[0].total_price_minor, 10_000);
    assert_eq!(totals[0].amount_scale, 2);
    assert_eq!(totals[1].currency, "USD");
    assert_eq!(totals[1].total_price_minor, 10_000);
}

#[test]
fn currency_totals_respect_iso_precision_and_legacy_scales() {
    // JPY：0 位；旧行若按 2 位存但可整除，收敛到 0 位，仍不失真。
    let jpy = group_currency_totals(&[(Some(100), "JPY".into(), 0), (Some(500), "JPY".into(), 2)])
        .unwrap();
    assert_eq!(jpy[0].total_price_minor, 105);
    assert_eq!(jpy[0].amount_scale, 0);

    // 旧 JPY 行存在 0.5 日元这种 ISO 无法表示的精度：退到组内最大精度，原样展示，不四舍五入。
    let legacy_fraction =
        group_currency_totals(&[(Some(50), "JPY".into(), 2), (Some(1), "JPY".into(), 0)]) .unwrap();
    assert_eq!(legacy_fraction[0].total_price_minor, 150);
    assert_eq!(legacy_fraction[0].amount_scale, 2);

    // KWD：3 位。2 位与 3 位混合必须按 3 位对齐，绝不丢千分位。
    let kwd =
        group_currency_totals(&[(Some(100), "KWD".into(), 2), (Some(1), "KWD".into(), 3)]).unwrap();
    assert_eq!(kwd[0].total_price_minor, 1_001);
    assert_eq!(kwd[0].amount_scale, 3);

    // 同一币种不同精度：CNY 2 位与 3 位可精确对齐到 ISO 2 位。
    let cny =
        group_currency_totals(&[(Some(10_000), "CNY".into(), 2), (Some(5_000), "CNY".into(), 3)])
            .unwrap();
    assert_eq!(cny[0].total_price_minor, 10_500);
    assert_eq!(cny[0].amount_scale, 2);
}

#[test]
fn currency_totals_keep_missing_currency_separate_and_ignore_empty_amounts() {
    let totals = group_currency_totals(&[
        (None, "CNY".into(), 2),
        (Some(1_200), "".into(), 2),
        (Some(300), "CNY".into(), 2),
    ])
    .unwrap();
    assert_eq!(totals.len(), 2, "空金额不参与累计，空货币单独成组");
    assert_eq!(totals[0].currency, "CNY");
    assert_eq!(totals[0].total_price_minor, 300);
    assert_eq!(totals[0].item_count, 1);
    assert_eq!(totals[1].currency, "", "未填货币不得并入 CNY");
    assert_eq!(totals[1].total_price_minor, 1_200);
}

#[test]
fn life_events_recent_returns_grouped_totals_from_real_rows() {
    let db = Db::open_in_memory().unwrap();
    let now = now_iso();
    db.with_transaction(|conn| {
        conn.execute(
            "INSERT INTO life_events
             (id, event_type, title, description, occurred_at, merchant, source, created_at, updated_at)
             VALUES ('evt-multi', 'purchase', '混币测试', '', ?1, '', 'manual', ?2, ?2)",
            params![parse_occurred_at("2026-11-17").unwrap(), now],
        )?;
        conn.execute(
            "INSERT INTO life_event_items
             (id, event_id, item_id, item_name_snapshot, quantity_value, quantity_unit,
              unit_price_minor, total_price_minor, currency, amount_scale, note, created_at, updated_at)
             VALUES ('ei-cny','evt-multi',NULL,'商品 A',NULL,'件',NULL,10000,'CNY',2,'',?1,?1)",
            params![now],
        )?;
        conn.execute(
            "INSERT INTO life_event_items
             (id, event_id, item_id, item_name_snapshot, quantity_value, quantity_unit,
              unit_price_minor, total_price_minor, currency, amount_scale, note, created_at, updated_at)
             VALUES ('ei-usd','evt-multi',NULL,'商品 B',NULL,'件',NULL,10000,'USD',2,'',?1,?1)",
            params![now],
        )?;
        Ok::<_, AppError>(())
    })
    .unwrap();

    // 直接复用命令内部的分组路径：读取两条明细 → group_currency_totals。
    db.with_read(|conn| {
        let entries = conn
            .prepare(
                "SELECT total_price_minor, currency, amount_scale FROM life_event_items
                  WHERE event_id = 'evt-multi' ORDER BY id",
            )?
            .query_map([], |row| {
                Ok((
                    row.get::<_, Option<i64>>(0)?,
                    row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                    row.get::<_, Option<i64>>(2)?.unwrap_or(2),
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let totals = group_currency_totals(&entries)?;
        assert_eq!(totals.len(), 2);
        assert!(totals.iter().all(|total| total.total_price_minor == 10_000));
        assert!(totals.iter().all(|total| total.total_price_minor != 20_000));
        Ok::<_, AppError>(())
    })
    .unwrap();
}

// ── 跨端契约向量（与 apps/mobile/src/domain/__tests__/lifeMoney.test.ts 共用）──
//
// 唯一事实源：docs/life/life-contract-vectors.json。Rust 与 TypeScript 都读这一份，
// 任何一端单独放宽/收紧金额、数量、货币精度或名称归一规则，都会在同一组用例上失败。

#[derive(Debug, serde::Deserialize)]
struct VectorName {
    input: String,
    normalized: String,
}

#[derive(Debug, serde::Deserialize)]
struct VectorCurrency {
    input: String,
    #[serde(default)]
    currency: Option<String>,
    #[serde(default)]
    decimals: Option<i64>,
    #[serde(default)]
    reason: Option<String>,
    #[serde(default, rename = "messagePattern")]
    message_pattern: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
struct VectorScale {
    currency: String,
    #[serde(default)]
    requested: Option<i64>,
    #[serde(default)]
    scale: Option<i64>,
    #[serde(default)]
    reason: Option<String>,
    #[serde(default, rename = "messagePattern")]
    message_pattern: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
struct VectorMoney {
    input: String,
    currency: String,
    #[serde(default, rename = "amountScale")]
    amount_scale: Option<i64>,
    #[serde(default)]
    minor: Option<i64>,
    #[serde(default)]
    reason: Option<String>,
    #[serde(default, rename = "messagePattern")]
    message_pattern: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
struct VectorQuantity {
    input: String,
    #[serde(default)]
    quantity: Option<String>,
    #[serde(default)]
    reason: Option<String>,
    #[serde(default, rename = "messagePattern")]
    message_pattern: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
struct ContractVectors {
    limits: VectorLimits,
    name_normalization: Vec<VectorName>,
    currency_normalization: Vec<VectorCurrency>,
    currency_decimals: Vec<VectorCurrency>,
    amount_scale: Vec<VectorScale>,
    money: Vec<VectorMoney>,
    quantity: Vec<VectorQuantity>,
}

#[derive(Debug, serde::Deserialize)]
struct VectorLimits {
    max_amount_minor: i64,
    max_quantity_integer_digits: usize,
}

fn contract_vectors() -> ContractVectors {
    serde_json::from_str(include_str!(
        "../../../docs/life/life-contract-vectors.json"
    ))
    .expect("契约向量文件必须是合法 JSON")
}

fn validation_text(error: AppError) -> String {
    match error {
        AppError::Validation(message) => message,
        other => panic!("期望校验错误，实际 {other:?}"),
    }
}

#[test]
fn contract_limits_match_code_constants() {
    let vectors = contract_vectors();
    assert_eq!(vectors.limits.max_amount_minor, MAX_AMOUNT_MINOR);
    assert_eq!(
        vectors.limits.max_quantity_integer_digits,
        MAX_QUANTITY_INT_DIGITS
    );
}

#[test]
fn contract_name_normalization_is_identical() {
    for vector in contract_vectors().name_normalization {
        assert_eq!(
            normalize_name(&vector.input),
            vector.normalized,
            "名称归一化不一致：{:?}",
            vector.input
        );
    }
}

#[test]
fn contract_currency_normalization_and_precision() {
    let vectors = contract_vectors();
    for vector in vectors.currency_normalization {
        match vector.currency {
            Some(expected) => assert_eq!(
                normalize_currency(Some(vector.input.as_str())).unwrap(),
                expected,
                "货币规范化不一致：{:?}",
                vector.input
            ),
            None => {
                let message = validation_text(
                    normalize_currency(Some(vector.input.as_str())).unwrap_err(),
                );
                assert!(
                    message.contains(vector.message_pattern.as_deref().unwrap_or("")),
                    "货币 {:?} 的错误信息不符：{message}",
                    vector.input
                );
            }
        }
    }
    for vector in vectors.currency_decimals {
        match vector.decimals {
            Some(expected) => assert_eq!(
                currency_scale(&vector.input).unwrap(),
                expected,
                "货币精度不一致：{}",
                vector.input
            ),
            None => {
                let message = validation_text(currency_scale(&vector.input).unwrap_err());
                assert!(
                    message.contains(vector.message_pattern.as_deref().unwrap_or("")),
                    "货币 {} 的错误信息不符：{message}",
                    vector.input
                );
            }
        }
    }
}

#[test]
fn contract_amount_scale_resolution() {
    for vector in contract_vectors().amount_scale {
        match vector.scale {
            Some(expected) => assert_eq!(
                resolve_amount_scale(&vector.currency, vector.requested).unwrap(),
                expected,
                "金额精度不一致：{} requested={:?}",
                vector.currency,
                vector.requested
            ),
            None => {
                let message = validation_text(
                    resolve_amount_scale(&vector.currency, vector.requested).unwrap_err(),
                );
                assert!(
                    message.contains(vector.message_pattern.as_deref().unwrap_or("")),
                    "{} requested={:?} 的错误信息不符：{message}",
                    vector.currency,
                    vector.requested
                );
            }
        }
    }
}

#[test]
fn contract_money_parsing() {
    let vectors = contract_vectors();
    let mut db: Option<Db> = None;
    for vector in vectors.money {
        if let Some(expected) = vector.minor {
            let scale = resolve_amount_scale(&vector.currency, vector.amount_scale)
                .unwrap_or_else(|error| panic!("{vector:?} 精度解析失败：{error:?}"));
            assert_eq!(
                parse_minor(&vector.input, scale).unwrap(),
                expected,
                "金额解析不一致：{:?} {}",
                vector.input,
                vector.currency
            );
            continue;
        }
        let pattern = vector.message_pattern.clone().unwrap_or_default();
        if vector.currency.is_empty() {
            // 空货币由仓库层拒绝（需要默认货币设置），不是 parse_minor 的职责。
            let db = db.get_or_insert_with(|| Db::open_in_memory().unwrap());
            let item = LifeItemInput {
                name: Some("契约测试".into()),
                total_price: Some(vector.input.clone()),
                ..Default::default()
            };
            let message = validation_text(build_event_item_values(db, &item).unwrap_err());
            assert!(
                message.contains(&pattern),
                "空货币金额 {:?} 的错误信息不符：{message}",
                vector.input
            );
            continue;
        }
        let outcome = resolve_amount_scale(&vector.currency, vector.amount_scale)
            .and_then(|scale| parse_minor(&vector.input, scale));
        let message = validation_text(outcome.unwrap_err());
        assert!(
            message.contains(&pattern),
            "金额 {:?}（{}）应被拒绝为 {:?}，实际：{message}",
            vector.input,
            vector.currency,
            vector.reason
        );
    }
}

#[test]
fn contract_quantity_parsing() {
    for vector in contract_vectors().quantity {
        match vector.quantity {
            Some(expected) => assert_eq!(
                canonical_quantity(&vector.input).unwrap().as_deref(),
                Some(expected.as_str()),
                "数量规范化不一致：{:?}",
                vector.input
            ),
            None => {
                if vector.reason.is_none() {
                    assert_eq!(
                        canonical_quantity(&vector.input).unwrap(),
                        None,
                        "空数量应解析为 None：{:?}",
                        vector.input
                    );
                    continue;
                }
                let message = validation_text(canonical_quantity(&vector.input).unwrap_err());
                assert!(
                    message.contains(vector.message_pattern.as_deref().unwrap_or("")),
                    "数量 {:?} 的错误信息不符：{message}",
                    vector.input
                );
            }
        }
    }
}

#[test]
fn sync_quantity_copy_accepts_legacy_zero_but_input_does_not() {
    // 旧桌面端曾把数量 0 写入数据库；复制既有记录不能让同步失败。
    assert_eq!(
        canonical_quantity_for_sync("0").unwrap().as_deref(),
        Some("0")
    );
    assert_eq!(
        canonical_quantity_for_sync("0.000").unwrap().as_deref(),
        Some("0")
    );
    assert!(canonical_quantity("0").is_err());
    // 格式仍然严格：同步也不能把千分位或科学计数法带进库。
    assert!(canonical_quantity_for_sync("1,000").is_err());
    assert!(canonical_quantity_for_sync("1e3").is_err());
}

// ── 票据关联：幂等、来源校验、删除语义 ─────────────────────

fn insert_shelf_item(db: &Db, id: &str, name: &str) {
    let now = now_iso();
    db.with_transaction(|conn| {
        conn.execute(
            "INSERT INTO shelf_items
             (id, kind, display_name, source_kind, storage_mode, byte_size, created_at, updated_at)
             VALUES (?1, 'image', ?2, 'manual', 'managed', 2048, ?3, ?3)",
            params![id, name, now],
        )?;
        Ok::<_, AppError>(())
    })
    .unwrap();
}

fn link_input(
    owner_type: &str,
    owner_id: &str,
    document_ref: &str,
    document_source: &str,
) -> LifeDocumentLinkInput {
    LifeDocumentLinkInput {
        owner_type: owner_type.into(),
        owner_id: owner_id.into(),
        document_ref: document_ref.into(),
        document_source: document_source.into(),
        document_name: "小票.jpg".into(),
        mime: "image/jpeg".into(),
        byte_size: Some(2048),
        transfer_state: Some("local".into()),
    }
}

fn link_count(db: &Db, owner_type: &str, owner_id: &str) -> i64 {
    db.with_read(|conn| {
        Ok(conn.query_row(
            "SELECT COUNT(*) FROM life_document_links
              WHERE owner_type = ?1 AND owner_id = ?2 AND deleted_at IS NULL",
            params![owner_type, owner_id],
            |row| row.get(0),
        )?)
    })
    .unwrap()
}

#[test]
fn document_link_create_returns_existing_row_on_duplicate() {
    let db = Db::open_in_memory().unwrap();
    let event_id = insert_purchase(&db, "大米", "2026-11-03", Some("5"), Some("48"), Some("CNY"));
    insert_shelf_item(&db, "si_receipt", "小票.jpg");
    let input = link_input("event", &event_id, "si_receipt", "shelf_item");

    let now = now_iso();
    let first = db
        .with_transaction(|conn| create_document_link_tx(conn, &input, &now))
        .unwrap();
    let second = db
        .with_transaction(|conn| create_document_link_tx(conn, &input, &now))
        .unwrap();

    // 幂等：第二次必须返回已有行 ID；命令层用返回值查询，不能再按新生成的 ID 查。
    assert_eq!(first, second, "重复提交不得创建第二条关联");
    assert_eq!(link_count(&db, "event", &event_id), 1);
    let loaded = db
        .with_read(|conn| load_link(conn, &second))
        .unwrap()
        .expect("按事务返回的最终 ID 必须能查到关联");
    assert_eq!(loaded.document_ref, "si_receipt");
    assert_eq!(loaded.document_source, "shelf_item");
    assert_eq!(loaded.transfer_state, "local");
}

#[test]
fn document_link_rejects_missing_and_deleted_owner() {
    let db = Db::open_in_memory().unwrap();
    insert_shelf_item(&db, "si_receipt", "小票.jpg");
    let now = now_iso();
    let missing = link_input("event", "ev_missing", "si_receipt", "shelf_item");
    let error = db
        .with_transaction(|conn| create_document_link_tx(conn, &missing, &now))
        .unwrap_err();
    assert!(matches!(error, AppError::NotFound(_)), "悬空 owner 必须 NotFound");

    let event_id = insert_purchase(&db, "大米", "2026-11-03", Some("5"), Some("48"), Some("CNY"));
    db.with_transaction(|conn| {
        conn.execute(
            "UPDATE life_events SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2",
            params![now, event_id],
        )?;
        Ok::<_, AppError>(())
    })
    .unwrap();
    let deleted = link_input("event", &event_id, "si_receipt", "shelf_item");
    let error = db
        .with_transaction(|conn| create_document_link_tx(conn, &deleted, &now))
        .unwrap_err();
    assert!(matches!(error, AppError::NotFound(_)), "已删除 owner 必须拒绝");

    // 非法 owner_type 属于校验错误，不是 NotFound。
    let mut bad_type = link_input("event", &event_id, "si_receipt", "shelf_item");
    bad_type.owner_type = "receipt".into();
    let error = db
        .with_transaction(|conn| create_document_link_tx(conn, &bad_type, &now))
        .unwrap_err();
    assert!(matches!(error, AppError::Validation(_)));
}

#[test]
fn document_link_rejects_missing_shelf_reference() {
    let db = Db::open_in_memory().unwrap();
    let event_id = insert_purchase(&db, "大米", "2026-11-03", Some("5"), Some("48"), Some("CNY"));
    let now = now_iso();
    let input = link_input("event", &event_id, "si_gone", "shelf_item");
    let error = db
        .with_transaction(|conn| create_document_link_tx(conn, &input, &now))
        .unwrap_err();
    match error {
        AppError::NotFound(message) => assert!(message.contains("文件暂存"), "{message}"),
        other => panic!("期望 NotFound，实际 {other:?}"),
    }
    // capture_asset 由另一端持有，桌面端不要求本机存在记录（保持既有语义）。
    let capture = link_input("event", &event_id, "asset_from_phone", "capture_asset");
    let created = db
        .with_transaction(|conn| create_document_link_tx(conn, &capture, &now))
        .unwrap();
    assert!(created.starts_with("ldl_"));
}

#[test]
fn document_link_rejects_invalid_size_state_and_reference() {
    let db = Db::open_in_memory().unwrap();
    let event_id = insert_purchase(&db, "大米", "2026-11-03", Some("5"), Some("48"), Some("CNY"));
    insert_shelf_item(&db, "si_receipt", "小票.jpg");
    let now = now_iso();

    let mut negative = link_input("event", &event_id, "si_receipt", "shelf_item");
    negative.byte_size = Some(-1);
    assert!(db
        .with_transaction(|conn| create_document_link_tx(conn, &negative, &now))
        .is_err());

    let mut unknown_state = link_input("event", &event_id, "si_receipt", "shelf_item");
    unknown_state.transfer_state = Some("uploading".into());
    assert!(db
        .with_transaction(|conn| create_document_link_tx(conn, &unknown_state, &now))
        .is_err());

    // “已传输”必须有 remote_ref，而创建入口无法提供 → 直接拒绝，避免造出打不开的票据。
    let mut transferred = link_input("event", &event_id, "si_receipt", "shelf_item");
    transferred.transfer_state = Some("transferred".into());
    let error = db
        .with_transaction(|conn| create_document_link_tx(conn, &transferred, &now))
        .unwrap_err();
    assert!(validation_text(error).contains("远端引用"));

    let empty = link_input("event", &event_id, "   ", "shelf_item");
    assert!(db
        .with_transaction(|conn| create_document_link_tx(conn, &empty, &now))
        .is_err());

    let control = link_input("event", &event_id, "si_re\nceipt", "shelf_item");
    assert!(db
        .with_transaction(|conn| create_document_link_tx(conn, &control, &now))
        .is_err());

    let relative = link_input("event", &event_id, "receipts/a.jpg", "file");
    let error = db
        .with_transaction(|conn| create_document_link_tx(conn, &relative, &now))
        .unwrap_err();
    assert!(validation_text(error).contains("绝对路径"));

    let absolute = link_input("event", &event_id, "C://receipts//a.jpg", "file");
    assert!(db
        .with_transaction(|conn| create_document_link_tx(conn, &absolute, &now))
        .is_ok());
}

#[test]
fn document_link_delete_is_idempotent_and_keeps_source_file() {
    let db = Db::open_in_memory().unwrap();
    let event_id = insert_purchase(&db, "大米", "2026-11-03", Some("5"), Some("48"), Some("CNY"));
    insert_shelf_item(&db, "si_receipt", "小票.jpg");
    let now = now_iso();
    let link_id = db
        .with_transaction(|conn| {
            create_document_link_tx(
                conn,
                &link_input("event", &event_id, "si_receipt", "shelf_item"),
                &now,
            )
        })
        .unwrap();

    db.with_transaction(|conn| delete_document_link_tx(conn, &link_id, &now))
        .unwrap();
    // 第二次删除必须仍然成功（幂等），不能报 NotFound。
    db.with_transaction(|conn| delete_document_link_tx(conn, &link_id, &now))
        .unwrap();

    db.with_read(|conn| {
        assert!(load_link(conn, &link_id)?.is_none(), "解除关联后不得再返回");
        assert!(
            load_event(conn, &event_id)?.is_some(),
            "解除关联不得删除生活记录"
        );
        let shelf: i64 = conn.query_row(
            "SELECT COUNT(*) FROM shelf_items WHERE id = 'si_receipt'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(shelf, 1, "解除关联不得删除暂存架原文件记录");
        Ok::<_, AppError>(())
    })
    .unwrap();
}

#[test]
fn event_detail_includes_item_links_only_for_its_own_items() {
    let db = Db::open_in_memory().unwrap();
    let event_a = insert_purchase(&db, "大米", "2026-11-03", Some("5"), Some("48"), Some("CNY"));
    let event_b = insert_purchase(&db, "牛奶", "2026-11-04", Some("2"), Some("20"), Some("CNY"));
    insert_shelf_item(&db, "si_item_a", "大米小票.jpg");
    insert_shelf_item(&db, "si_item_b", "牛奶小票.jpg");
    insert_shelf_item(&db, "si_event_a", "整单小票.jpg");
    let now = now_iso();

    let (item_a, item_b) = db
        .with_read(|conn| {
            let item_a: String = conn.query_row(
                "SELECT item_id FROM life_event_items WHERE event_id = ?1",
                params![event_a],
                |row| row.get(0),
            )?;
            let item_b: String = conn.query_row(
                "SELECT item_id FROM life_event_items WHERE event_id = ?1",
                params![event_b],
                |row| row.get(0),
            )?;
            Ok::<_, AppError>((item_a, item_b))
        })
        .unwrap();

    db.with_transaction(|conn| {
        create_document_link_tx(
            conn,
            &link_input("event", &event_a, "si_event_a", "shelf_item"),
            &now,
        )?;
        create_document_link_tx(
            conn,
            &link_input("item", &item_a, "si_item_a", "shelf_item"),
            &now,
        )?;
        create_document_link_tx(
            conn,
            &link_input("item", &item_b, "si_item_b", "shelf_item"),
            &now,
        )?;
        Ok::<_, AppError>(())
    })
    .unwrap();

    db.with_read(|conn| {
        let detail = load_event_detail(conn, &event_a)?;
        let refs: Vec<&str> = detail
            .links
            .iter()
            .map(|link| link.document_ref.as_str())
            .collect();
        assert!(refs.contains(&"si_event_a"), "事件级票据必须显示");
        assert!(refs.contains(&"si_item_a"), "事件内商品的商品级票据必须显示");
        assert!(
            !refs.contains(&"si_item_b"),
            "其它事件的商品票据不得串进来：{refs:?}"
        );
        Ok::<_, AppError>(())
    })
    .unwrap();
}
