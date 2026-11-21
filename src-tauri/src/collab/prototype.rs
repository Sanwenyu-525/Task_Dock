//! 交互式原型：组件 Patch、事件状态机、交互流校验。
//!
//! 原型内容只按白名单 DSL 渲染，不执行 HTML/JS；状态是会话级模拟，不落库。

use std::collections::{BTreeMap, BTreeSet};

use rusqlite::Connection;
use serde_json::{json, Map, Value};

use crate::error::{AppError, AppResult};

use super::actor::{Actor, Capability};
use super::model::{
    InteractionFlowReport, PatchOp, PrototypeEvent, PrototypeState, VisualDocument,
    VisualPatch,
};
use super::visual::{get_document, normalize_content, update_document};

const MAX_OPS: usize = 100;
/// 单次 Patch 每个对象段最多删除的字段数（与组件数上限同量级，防止恶意超长列表）。
const MAX_REMOVE_KEYS: usize = 200;

pub fn apply_patch(
    conn: &Connection,
    actor: &Actor,
    document_id: &str,
    expected_revision: i64,
    ops: &[PatchOp],
    summary: &str,
) -> AppResult<VisualDocument> {
    actor.require(Capability::VisualWrite)?;
    if ops.is_empty() {
        return Err(AppError::Validation("Patch 至少包含一个操作".to_string()));
    }
    if ops.len() > MAX_OPS {
        return Err(AppError::Validation(format!(
            "单次 Patch 最多 {MAX_OPS} 个操作"
        )));
    }
    let doc = get_document(conn, actor, document_id)?;
    if doc.kind != "prototype" {
        return Err(AppError::Validation(
            "只有 prototype 类型支持组件 Patch".to_string(),
        ));
    }
    let mut content: Value = serde_json::from_str(&doc.source_content)
        .map_err(|_| AppError::Validation("原型内容损坏".to_string()))?;

    for op in ops {
        apply_one(&mut content, op)?;
    }
    let normalized = normalize_content("prototype", "json", &content.to_string())?;
    let change = if summary.trim().is_empty() {
        format!("原型 Patch（{} 个操作）", ops.len())
    } else {
        summary.to_string()
    };
    update_document(
        conn,
        actor,
        document_id,
        expected_revision,
        &VisualPatch {
            source_format: Some("json".to_string()),
            source_content: Some(normalized),
            ..Default::default()
        },
        &change,
    )
}

fn apply_one(content: &mut Value, op: &PatchOp) -> AppResult<()> {
    let action = op.op.as_str();
    match action {
        "add" => {
            let page_id = op
                .page_id
                .as_deref()
                .ok_or_else(|| AppError::Validation("add 需要 pageId".to_string()))?;
            let component = op
                .component
                .clone()
                .ok_or_else(|| AppError::Validation("add 需要 component".to_string()))?;
            // 组件 ID 在整个原型内唯一：跨页重名会让按页定位的选择项命中错组件。
            if let Some(id) = component.get("id").and_then(|v| v.as_str()) {
                if component_id_exists(content, id) {
                    return Err(AppError::Validation(format!(
                        "组件 id 重复：{id}（原型内必须唯一）"
                    )));
                }
            }
            let page = find_page_mut(content, page_id)?;
            let comps = page
                .get_mut("components")
                .and_then(|v| v.as_array_mut())
                .ok_or_else(|| AppError::Validation("页面缺少 components".to_string()))?;
            comps.push(component);
        }
        "update" => {
            let patch = match op.patch.as_ref() {
                Some(v) => Some(v.as_object().ok_or_else(|| {
                    AppError::Validation("update 需要 patch 对象".to_string())
                })?),
                None => None,
            };
            if patch.is_none() && op.remove_keys.is_none() {
                return Err(AppError::Validation(
                    "update 需要 patch 或 removeKeys".to_string(),
                ));
            }
            let comp = find_component_mut(content, op)?;
            merge_component(comp, patch, op.remove_keys.as_ref())?;
        }
        "remove" => {
            let page_id = op
                .page_id
                .as_deref()
                .ok_or_else(|| AppError::Validation("remove 需要 pageId".to_string()))?;
            let comp_id = op
                .component_id
                .as_deref()
                .ok_or_else(|| AppError::Validation("remove 需要 componentId".to_string()))?;
            let page = find_page_mut(content, page_id)?;
            let comps = page
                .get_mut("components")
                .and_then(|v| v.as_array_mut())
                .ok_or_else(|| AppError::Validation("页面缺少 components".to_string()))?;
            let before = comps.len();
            comps.retain(|c| c.get("id").and_then(|v| v.as_str()) != Some(comp_id));
            if comps.len() == before {
                return Err(AppError::NotFound(format!("组件不存在：{comp_id}")));
            }
        }
        "move" => {
            let x = op
                .x
                .ok_or_else(|| AppError::Validation("move 需要 x".to_string()))?;
            let y = op
                .y
                .ok_or_else(|| AppError::Validation("move 需要 y".to_string()))?;
            if !(0.0..=5000.0).contains(&x) || !(0.0..=5000.0).contains(&y) {
                return Err(AppError::Validation("坐标超出 0–5000".to_string()));
            }
            let comp = find_component_mut(content, op)?;
            comp["x"] = json!(x.round());
            comp["y"] = json!(y.round());
        }
        "style" => {
            let patch = op
                .patch
                .as_ref()
                .and_then(|v| v.as_object())
                .ok_or_else(|| AppError::Validation("style 需要 patch 对象".to_string()))?;
            require_only_section(op, "style")?;
            let comp = find_component_mut(content, op)?;
            apply_section(
                comp,
                "style",
                Some(patch),
                op.remove_keys.as_ref().and_then(|m| m.get("style")),
            )?;
        }
        "events" => {
            let patch = op
                .patch
                .as_ref()
                .and_then(|v| v.as_object())
                .ok_or_else(|| AppError::Validation("events 需要 patch 对象".to_string()))?;
            require_only_section(op, "events")?;
            let comp = find_component_mut(content, op)?;
            apply_section(
                comp,
                "events",
                Some(patch),
                op.remove_keys.as_ref().and_then(|m| m.get("events")),
            )?;
        }
        "page_add" => {
            // 先在不可变借用下收集已有组件 ID，再做可变借用，避免借用冲突。
            let mut existing_ids: BTreeSet<String> = BTreeSet::new();
            if let Some(existing) = content.get("pages").and_then(|v| v.as_array()) {
                for p in existing {
                    if let Some(comps) = p.get("components").and_then(|v| v.as_array()) {
                        for c in comps {
                            if let Some(cid) = c.get("id").and_then(|v| v.as_str()) {
                                existing_ids.insert(cid.to_string());
                            }
                        }
                    }
                }
            }
            let pages = content
                .get_mut("pages")
                .and_then(|v| v.as_array_mut())
                .ok_or_else(|| AppError::Validation("原型缺少 pages".to_string()))?;
            if pages.len() >= 20 {
                return Err(AppError::Validation("页面数不超过 20".to_string()));
            }
            let page = match &op.page {
                Some(raw) => {
                    let obj = raw
                        .as_object()
                        .ok_or_else(|| AppError::Validation("page 必须是对象".to_string()))?;
                    let id = obj
                        .get("id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .trim()
                        .to_string();
                    if id.is_empty() {
                        return Err(AppError::Validation("新页面需要 id".to_string()));
                    }
                    if pages
                        .iter()
                        .any(|p| p.get("id").and_then(|v| v.as_str()) == Some(id.as_str()))
                    {
                        return Err(AppError::Validation(format!("页面 id 重复：{id}")));
                    }
                    // 新页面携带的组件 ID 不得与已有组件或页面内重名。
                    let mut seen: BTreeSet<String> = BTreeSet::new();
                    if let Some(comps) = obj.get("components").and_then(|v| v.as_array()) {
                        for comp in comps {
                            if let Some(cid) = comp.get("id").and_then(|v| v.as_str()) {
                                if existing_ids.contains(cid) || !seen.insert(cid.to_string()) {
                                    return Err(AppError::Validation(format!(
                                        "组件 id 重复：{cid}（原型内必须唯一）"
                                    )));
                                }
                            }
                        }
                    }
                    json!({
                        "id": id,
                        "name": obj.get("name").and_then(|v| v.as_str()).unwrap_or(&id),
                        "components": obj.get("components").cloned().unwrap_or_else(|| json!([]))
                    })
                }
                None => {
                    let name = op
                        .name
                        .as_deref()
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .unwrap_or("新页面")
                        .to_string();
                    let id = next_page_id(pages);
                    json!({"id": id, "name": name, "components": []})
                }
            };
            pages.push(page);
        }
        "page_remove" => {
            let page_id = op
                .page_id
                .as_deref()
                .ok_or_else(|| AppError::Validation("page_remove 需要 pageId".to_string()))?;
            let pages = content
                .get_mut("pages")
                .and_then(|v| v.as_array_mut())
                .ok_or_else(|| AppError::Validation("原型缺少 pages".to_string()))?;
            if pages.len() <= 1 {
                return Err(AppError::Validation("至少保留一个页面".to_string()));
            }
            let before = pages.len();
            pages.retain(|p| p.get("id").and_then(|v| v.as_str()) != Some(page_id));
            if pages.len() == before {
                return Err(AppError::NotFound(format!("页面不存在：{page_id}")));
            }
        }
        "page_rename" => {
            let page_id = op
                .page_id
                .as_deref()
                .ok_or_else(|| AppError::Validation("page_rename 需要 pageId".to_string()))?;
            let name = op
                .name
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| AppError::Validation("page_rename 需要非空 name".to_string()))?;
            let page = find_page_mut(content, page_id)?;
            page["name"] = json!(name);
        }
        other => {
            return Err(AppError::Validation(format!(
                "未知 Patch 操作：{other}（允许 add/update/remove/move/style/events/page_add/page_remove/page_rename）"
            )))
        }
    }
    Ok(())
}

/// `style`/`events` 操作的 removeKeys 只能携带自身段名，避免语义含糊。
fn require_only_section(op: &PatchOp, section: &str) -> AppResult<()> {
    let Some(map) = op.remove_keys.as_ref() else {
        return Ok(());
    };
    if let Some(other) = map.keys().find(|k| k.as_str() != section) {
        return Err(AppError::Validation(format!(
            "{section} 操作的 removeKeys 不能包含 {other}；请用 update 一次表达"
        )));
    }
    Ok(())
}

/// 组件 ID 是否已在原型任意页面出现（组件 ID 必须全文档唯一）。
fn component_id_exists(content: &Value, id: &str) -> bool {
    content
        .get("pages")
        .and_then(|v| v.as_array())
        .map(|pages| {
            pages.iter().any(|p| {
                p.get("components")
                    .and_then(|v| v.as_array())
                    .map(|comps| {
                        comps
                            .iter()
                            .any(|c| c.get("id").and_then(|v| v.as_str()) == Some(id))
                    })
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

/// 生成下一个稳定页面 ID：`page-<n>`，跳过已被占用的编号。
fn next_page_id(pages: &[Value]) -> String {
    let used: BTreeSet<&str> = pages
        .iter()
        .filter_map(|p| p.get("id").and_then(|v| v.as_str()))
        .collect();
    let mut n = pages.len() + 1;
    loop {
        let candidate = format!("page-{n}");
        if !used.contains(candidate.as_str()) {
            return candidate;
        }
        n += 1;
    }
}

fn find_page_mut<'a>(content: &'a mut Value, page_id: &str) -> AppResult<&'a mut Value> {
    content
        .get_mut("pages")
        .and_then(|v| v.as_array_mut())
        .ok_or_else(|| AppError::Validation("原型缺少 pages".to_string()))?
        .iter_mut()
        .find(|p| p.get("id").and_then(|v| v.as_str()) == Some(page_id))
        .ok_or_else(|| AppError::NotFound(format!("页面不存在：{page_id}")))
}

fn find_component_mut<'a>(content: &'a mut Value, op: &PatchOp) -> AppResult<&'a mut Value> {
    let page_id = op
        .page_id
        .as_deref()
        .ok_or_else(|| AppError::Validation("操作需要 pageId".to_string()))?;
    let comp_id = op
        .component_id
        .as_deref()
        .ok_or_else(|| AppError::Validation("操作需要 componentId".to_string()))?;
    let page = find_page_mut(content, page_id)?;
    page.get_mut("components")
        .and_then(|v| v.as_array_mut())
        .ok_or_else(|| AppError::Validation("页面缺少 components".to_string()))?
        .iter_mut()
        .find(|c| c.get("id").and_then(|v| v.as_str()) == Some(comp_id))
        .ok_or_else(|| AppError::NotFound(format!("组件不存在：{comp_id}")))
}

/// 组件增量合并：先按 `remove_keys` 删除字段，再写入 `patch` 中的键。
///
/// - 只允许 `props` / `style` / `events` 三个对象字段与 `x`/`y`/`w`/`h` 坐标；
/// - `id` / `type` 永远不可通过 Patch 修改（类型转换必须由独立的转换规则实现）；
/// - 任一非法字段立即返回错误，调用方在全部操作成功后才做 Schema 校验与落库。
fn merge_component(
    comp: &mut Value,
    patch: Option<&Map<String, Value>>,
    remove_keys: Option<&BTreeMap<String, Vec<String>>>,
) -> AppResult<()> {
    if comp.as_object().is_none() {
        return Err(AppError::Validation("组件不是对象".to_string()));
    }

    if let Some(remove) = remove_keys {
        for (section, keys) in remove {
            if !["props", "style", "events"].contains(&section.as_str()) {
                return Err(AppError::Validation(format!(
                    "removeKeys 不支持字段 {section}（只允许 props/style/events）"
                )));
            }
            apply_section(comp, section, None, Some(keys))?;
        }
    }

    let Some(patch) = patch else {
        return Ok(());
    };
    for (k, v) in patch {
        match k.as_str() {
            "id" | "type" => {
                return Err(AppError::Validation(format!(
                    "Patch 不允许修改组件 {k}"
                )))
            }
            "props" | "style" | "events" => {
                let patch_obj = v
                    .as_object()
                    .ok_or_else(|| AppError::Validation(format!("{k} patch 不是对象")))?;
                apply_section(comp, k, Some(patch_obj), None)?;
            }
            "x" | "y" | "w" | "h" => {
                if !v.is_number() {
                    return Err(AppError::Validation(format!("{k} 必须是数字")));
                }
                comp.as_object_mut()
                    .expect("已校验为对象")
                    .insert(k.clone(), v.clone());
            }
            other => {
                return Err(AppError::Validation(format!(
                    "Patch 不允许修改字段 {other}"
                )))
            }
        }
    }
    Ok(())
}

/// 写入单个对象段（props/style/events）；`remove` 先于写入生效。
fn apply_section(
    comp: &mut Value,
    section: &str,
    patch: Option<&Map<String, Value>>,
    remove: Option<&Vec<String>>,
) -> AppResult<()> {
    if let Some(keys) = remove {
        if keys.len() > MAX_REMOVE_KEYS {
            return Err(AppError::Validation(format!(
                "removeKeys.{section} 最多 {MAX_REMOVE_KEYS} 个键"
            )));
        }
        if keys.iter().any(|k| k.trim().is_empty()) {
            return Err(AppError::Validation(format!(
                "removeKeys.{section} 含空键"
            )));
        }
        if patch.is_none() {
            // 只删除：段不存在或为 null 时无需创建空对象。
            let exists = comp
                .get(section)
                .map(|v| !v.is_null())
                .unwrap_or(false);
            if !exists {
                return Ok(());
            }
        }
    }
    let obj = comp
        .as_object_mut()
        .ok_or_else(|| AppError::Validation("组件不是对象".to_string()))?;
    let target = obj.entry(section).or_insert_with(|| json!({}));
    if target.is_null() {
        *target = json!({});
    }
    let target_obj = target
        .as_object_mut()
        .ok_or_else(|| AppError::Validation(format!("{section} 不是对象")))?;
    if let Some(keys) = remove {
        for key in keys {
            target_obj.remove(key);
        }
    }
    if let Some(patch) = patch {
        for (k, v) in patch {
            target_obj.insert(k.clone(), v.clone());
        }
    }
    Ok(())
}

// ── 状态机 ───────────────────────────────────────────────────────────────

pub fn default_state(content: &Value) -> PrototypeState {
    let first_page = content
        .get("pages")
        .and_then(|v| v.as_array())
        .and_then(|pages| pages.first())
        .and_then(|p| p.get("id"))
        .and_then(|v| v.as_str())
        .unwrap_or("page-1")
        .to_string();
    let values = content
        .get("state")
        .and_then(|v| v.as_object())
        .map(|obj| obj.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
        .unwrap_or_default();
    PrototypeState {
        current_page: first_page,
        modal: None,
        values,
    }
}

pub fn dispatch_event(
    conn: &Connection,
    actor: &Actor,
    document_id: &str,
    mut state: PrototypeState,
    event: &PrototypeEvent,
) -> AppResult<PrototypeState> {
    actor.require(Capability::VisualRead)?;
    let doc = get_document(conn, actor, document_id)?;
    if doc.kind != "prototype" {
        return Err(AppError::Validation("只有原型支持事件模拟".to_string()));
    }
    let content: Value = serde_json::from_str(&doc.source_content)
        .map_err(|_| AppError::Validation("原型内容损坏".to_string()))?;
    let page_ids: BTreeSet<String> = content
        .get("pages")
        .and_then(|v| v.as_array())
        .map(|pages| {
            pages
                .iter()
                .filter_map(|p| p.get("id").and_then(|v| v.as_str()).map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    let component_ids: BTreeSet<String> = content
        .get("pages")
        .and_then(|v| v.as_array())
        .map(|pages| {
            pages
                .iter()
                .flat_map(|p| {
                    p.get("components")
                        .and_then(|v| v.as_array())
                        .map(|cs| cs.to_vec())
                        .unwrap_or_default()
                })
                .filter_map(|c| c.get("id").and_then(|v| v.as_str()).map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();

    if state.current_page.is_empty() || !page_ids.contains(&state.current_page) {
        state.current_page = first_page_id(&content);
    }

    let target = event.target.as_deref().unwrap_or("");
    match event.action.as_str() {
        "navigate" => {
            if !page_ids.contains(target) {
                return Err(AppError::NotFound(format!("目标页面不存在：{target}")));
            }
            state.current_page = target.to_string();
            state.modal = None;
        }
        "openModal" => {
            if !component_ids.contains(target) {
                return Err(AppError::NotFound(format!("弹窗组件不存在：{target}")));
            }
            state.modal = Some(target.to_string());
        }
        "closeModal" => state.modal = None,
        "toggle" => {
            if target.is_empty() {
                return Err(AppError::Validation("toggle 需要 target".to_string()));
            }
            let current = state.values.get(target).and_then(|v| v.as_bool()).unwrap_or(false);
            state.values.insert(target.to_string(), json!(!current));
        }
        "setValue" => {
            if target.is_empty() {
                return Err(AppError::Validation("setValue 需要 target".to_string()));
            }
            let value = event
                .value
                .clone()
                .ok_or_else(|| AppError::Validation("setValue 需要 value".to_string()))?;
            state.values.insert(target.to_string(), value);
        }
        other => {
            return Err(AppError::Validation(format!(
                "未知事件动作：{other}"
            )))
        }
    }
    Ok(state)
}

fn first_page_id(content: &Value) -> String {
    content
        .get("pages")
        .and_then(|v| v.as_array())
        .and_then(|p| p.first())
        .and_then(|p| p.get("id"))
        .and_then(|v| v.as_str())
        .unwrap_or("page-1")
        .to_string()
}

// ── 交互流校验 ───────────────────────────────────────────────────────────

pub fn validate_flow(
    conn: &Connection,
    actor: &Actor,
    document_id: &str,
) -> AppResult<InteractionFlowReport> {
    actor.require(Capability::VisualRead)?;
    let doc = get_document(conn, actor, document_id)?;
    if doc.kind != "prototype" {
        return Err(AppError::Validation("只有原型支持交互流校验".to_string()));
    }
    let content: Value = serde_json::from_str(&doc.source_content)
        .map_err(|_| AppError::Validation("原型内容损坏".to_string()))?;
    let pages = content
        .get("pages")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let page_ids: BTreeSet<String> = pages
        .iter()
        .filter_map(|p| p.get("id").and_then(|v| v.as_str()).map(|s| s.to_string()))
        .collect();
    let component_ids: BTreeSet<String> = pages
        .iter()
        .flat_map(|p| {
            p.get("components")
                .and_then(|v| v.as_array())
                .map(|cs| cs.to_vec())
                .unwrap_or_default()
        })
        .filter_map(|c| c.get("id").and_then(|v| v.as_str()).map(|s| s.to_string()))
        .collect();

    let mut issues = Vec::new();
    let mut nav_edges: BTreeSet<(String, String)> = BTreeSet::new();
    for page in &pages {
        let page_id = page.get("id").and_then(|v| v.as_str()).unwrap_or("");
        let comps = page
            .get("components")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        for comp in &comps {
            let cid = comp.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let events = comp.get("events").and_then(|v| v.as_object());
            if let Some(events) = events {
                for (key, ev) in events {
                    let action = ev.get("action").and_then(|v| v.as_str()).unwrap_or("");
                    let target = ev.get("target").and_then(|v| v.as_str()).unwrap_or("");
                    match action {
                        "navigate" => {
                            if !page_ids.contains(target) {
                                issues.push(format!(
                                    "页面 {page_id} 组件 {cid} 的 {key} 指向不存在的页面 {target}"
                                ));
                            } else {
                                nav_edges.insert((page_id.to_string(), target.to_string()));
                            }
                        }
                        "openModal" => {
                            if !component_ids.contains(target) {
                                issues.push(format!(
                                    "页面 {page_id} 组件 {cid} 的 {key} 指向不存在的弹窗组件 {target}"
                                ));
                            }
                        }
                        "toggle" | "setValue" => {
                            if target.is_empty() {
                                issues.push(format!(
                                    "页面 {page_id} 组件 {cid} 的 {key} 缺少 target"
                                ));
                            }
                        }
                        "closeModal" => {}
                        _ => issues.push(format!(
                            "页面 {page_id} 组件 {cid} 的 {key} 使用未知动作 {action}"
                        )),
                    }
                }
            }
        }
    }

    // 页面导航环检测（只报告，不阻断；环本身不一定是错误，但超过 20 步一定有风险）。
    if let Some(path) = find_nav_cycle(&nav_edges) {
        issues.push(format!("页面导航存在循环：{}", path.join(" → ")));
    }

    Ok(InteractionFlowReport {
        ok: issues.is_empty(),
        issues,
    })
}

fn find_nav_cycle(edges: &BTreeSet<(String, String)>) -> Option<Vec<String>> {
    let mut adj: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for (from, to) in edges {
        adj.entry(from.clone()).or_default().push(to.clone());
    }
    for start in adj.keys().cloned().collect::<Vec<_>>() {
        let mut stack = vec![(start.clone(), vec![start.clone()])];
        let mut steps = 0;
        while let Some((node, path)) = stack.pop() {
            steps += 1;
            if steps > 200 {
                return Some(path);
            }
            if let Some(nexts) = adj.get(&node) {
                for next in nexts {
                    if next == &start {
                        let mut cycle = path.clone();
                        cycle.push(next.clone());
                        return Some(cycle);
                    }
                    if !path.contains(next) {
                        let mut p = path.clone();
                        p.push(next.clone());
                        stack.push((next.clone(), p));
                    }
                }
            }
        }
    }
    None
}
