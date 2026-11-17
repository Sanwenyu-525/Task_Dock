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
        let (quantity, unit, unit_price, total_price, currency_value, note) =
            build_event_item_values(db, &item)?;
        conn.execute(
            "INSERT INTO life_event_items
             (id, event_id, item_id, item_name_snapshot, quantity_value, quantity_unit,
              unit_price_minor, total_price_minor, currency, note, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)",
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
        Ok::<_, AppError>(())
    })
    .unwrap();
}

#[test]
fn normalize_name_handles_fullwidth_and_spacing() {
    assert_eq!(normalize_name("  大　米  "), "大 米");
    assert_eq!(normalize_name("Milk"), "milk");
    assert_eq!(normalize_name("大米。"), "大米");
    assert_eq!(normalize_name("大米（东北）"), "大米（东北）");
    assert_ne!(normalize_name("小包装大米"), normalize_name("大米"));
}

#[test]
fn money_and_quantity_are_fixed_point() {
    assert_eq!(parse_minor("48").unwrap(), 4800);
    assert_eq!(parse_minor("48.5").unwrap(), 4850);
    assert_eq!(parse_minor("0.05").unwrap(), 5);
    assert!(parse_minor("48.555").is_err());
    assert!(parse_minor("-1").is_err());
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
    assert!(last.starts_with("2026-11-03"), "最近购买应为 11-03，实际 {last}");
    assert_eq!(summary.interval_days, Some(30));
    assert_eq!(summary.last_total_price_minor, Some(4800));

    let history = db
        .with_read(|conn| list_purchases_for_item(conn, &summary.id, 40))
        .unwrap();
    assert_eq!(history.len(), 3);
    assert!(history[0].occurred_at.starts_with("2026-11-03"));
    assert!(history[1].occurred_at.starts_with("2026-10-04"));
    assert!(history[2].occurred_at.starts_with("2026-09-06"));
    assert_eq!(history[0].quantity_value.as_deref(), Some("5"));
}

#[test]
fn item_reuse_uses_normalized_name_without_merging_similar_names() {
    let db = Db::open_in_memory().unwrap();
    insert_purchase(&db, "大米", "2026-11-03", Some("5"), Some("48"), Some("CNY"));
    insert_purchase(&db, "大　米", "2026-10-04", Some("5"), Some("46"), Some("CNY"));
    insert_purchase(&db, "东北大米", "2026-09-06", Some("5"), Some("80"), Some("CNY"));

    let items = db
        .with_read(|conn| list_life_items_inner(conn, &LifeItemFilter::default()))
        .unwrap();
    assert_eq!(items.len(), 2, "全角空格归一后应复用；相似但不同的商品不得合并");
    let rice = items
        .iter()
        .find(|item| item.name == "大米")
        .expect("缺少大米");
    assert_eq!(rice.purchase_count, 2);
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
