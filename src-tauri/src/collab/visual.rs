//! 统一可视化引擎：文档 Schema、渲染器注册表、版本、差异、导出、安全校验。
//!
//! 所有 `sourceContent` 都是**可重新编辑的结构化数据**，不是截图。
//! 不执行模型/Agent 提供的 HTML 或 JS；校验失败直接拒绝，绝不“尽量渲染”。

use std::collections::{BTreeMap, BTreeSet};

use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Map, Value};

use crate::error::{AppError, AppResult};

use super::actor::{assert_project_scope, write_audit, Actor, ActorKind, Capability};
use super::model::{
    page_args, DiffItem, ExportResult, Page, RendererCapability, VisualDiff, VisualDocument,
    VisualInput, VisualPatch, VisualVersion, AUTHORING_MODES, MAX_DESCRIPTION, MAX_TITLE,
    VISUAL_KINDS,
};
use super::util::{new_id, now_iso, validate_enum, validate_text};

const COLS: &str = "id, project_id, plan_id, title, description, kind, authoring_mode, \
schema_version, source_format, source_content, renderer, preview_asset, status, version, revision, \
created_by, updated_by, created_at, updated_at";

const MAX_NODES: usize = 200;
const MAX_EDGES: usize = 400;
const MAX_PAGES: usize = 20;
const MAX_COMPONENTS_PER_PAGE: usize = 200;
const COMPONENT_TYPES: &[&str] = &[
    "frame", "text", "heading", "button", "input", "switch", "tabs", "list", "image", "badge",
    "divider", "chart",
];
const STYLE_KEYS: &[&str] = &[
    "bg",
    "fg",
    "radius",
    "fontSize",
    "fontWeight",
    "padding",
    "gap",
    "align",
    "border",
];
const EVENT_KEYS: &[&str] = &["onClick", "onChange", "onSubmit"];
const ACTIONS: &[&str] = &[
    "navigate",
    "openModal",
    "closeModal",
    "toggle",
    "setValue",
];
const ASSET_EXTS: &[&str] = &["png", "jpg", "jpeg", "webp", "gif", "svg"];

pub(crate) fn map_doc_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<VisualDocument> {
    Ok(VisualDocument {
        id: r.get(0)?,
        project_id: r.get(1)?,
        plan_id: r.get(2)?,
        title: r.get(3)?,
        description: r.get(4)?,
        kind: r.get(5)?,
        authoring_mode: r.get(6)?,
        schema_version: r.get(7)?,
        source_format: r.get(8)?,
        source_content: r.get(9)?,
        renderer: r.get(10)?,
        preview_asset: r.get(11)?,
        status: r.get(12)?,
        version: r.get(13)?,
        revision: r.get(14)?,
        created_by: r.get(15)?,
        updated_by: r.get(16)?,
        created_at: r.get(17)?,
        updated_at: r.get(18)?,
    })
}

/// 创作来源推断：显式值优先；否则 UI=manual、Agent=agent_authored、System=manual。
fn resolve_authoring_mode(actor: &Actor, explicit: Option<&str>) -> AppResult<String> {
    if let Some(mode) = explicit {
        return validate_enum(mode, AUTHORING_MODES, "创作来源");
    }
    Ok(match actor.kind {
        ActorKind::Agent => "agent_authored",
        _ => "manual",
    }
    .to_string())
}

pub fn renderer_for(kind: &str) -> AppResult<&'static str> {
    Ok(match kind {
        "flowchart" | "architecture" | "dataflow" => "graph-svg",
        "prototype" => "prototype-react",
        "bug_annotation" => "image-annotation",
        "static_image" => "image",
        "diff" => "diff-view",
        _ => {
            return Err(AppError::Validation(format!(
                "不支持的可视化类型：{kind}"
            )))
        }
    })
}

pub fn list_renderers() -> Vec<RendererCapability> {
    vec![
        cap("flowchart", "graph-svg", true, true, &["json", "svg"], "业务流程/任务流程"),
        cap("architecture", "graph-svg", true, true, &["json", "svg"], "系统结构与模块关系"),
        cap("dataflow", "graph-svg", true, true, &["json", "svg"], "数据传递与调用"),
        cap("prototype", "prototype-react", true, true, &["json"], "交互式 UI 原型"),
        cap("bug_annotation", "image-annotation", true, false, &["json"], "Bug 截图标注"),
        cap("static_image", "image", false, false, &["json"], "UI 效果图/概念图"),
        cap("diff", "diff-view", false, false, &["json"], "版本差异（只读）"),
    ]
}

fn cap(
    kind: &str,
    renderer: &str,
    interactive: bool,
    editable: bool,
    exports: &[&str],
    desc: &str,
) -> RendererCapability {
    RendererCapability {
        kind: kind.to_string(),
        renderer: renderer.to_string(),
        interactive,
        editable,
        export_formats: exports.iter().map(|s| s.to_string()).collect(),
        description: desc.to_string(),
    }
}

// ── 安全校验 ─────────────────────────────────────────────────────────────

/// 不可信文本扫描：拒绝脚本、事件属性、外部协议与 CSS 注入。
pub fn scan_text(text: &str) -> AppResult<()> {
    let lower = text.to_ascii_lowercase();
    const BAD: &[&str] = &[
        "<script",
        "</script",
        "<iframe",
        "javascript:",
        "vbscript:",
        "onerror=",
        "onclick=",
        "onload=",
        "onmouseover=",
        "expression(",
        "@import",
        "url(",
        "data:text/html",
    ];
    for bad in BAD {
        if lower.contains(bad) {
            return Err(AppError::Validation(format!(
                "内容包含不允许的片段（{bad}）"
            )));
        }
    }
    Ok(())
}

fn scan_value(value: &Value) -> AppResult<()> {
    match value {
        Value::String(s) => scan_text(s),
        Value::Array(items) => {
            for item in items {
                scan_value(item)?;
            }
            Ok(())
        }
        Value::Object(map) => {
            for (k, v) in map {
                scan_text(k)?;
                scan_value(v)?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

fn validate_asset_path(raw: &str) -> AppResult<String> {
    let path = raw.trim();
    if path.is_empty() {
        return Err(AppError::Validation("资源路径不能为空".to_string()));
    }
    if path.contains("://") || path.starts_with("http") || path.starts_with("data:") {
        return Err(AppError::Validation(
            "资源必须来自应用内资产，不允许外部 URL".to_string(),
        ));
    }
    let lower = path.to_ascii_lowercase();
    let ext = lower.rsplit('.').next().unwrap_or("");
    if !ASSET_EXTS.contains(&ext) {
        return Err(AppError::Validation(format!(
            "不支持的资源类型：{ext}（允许 {}）",
            ASSET_EXTS.join("/")
        )));
    }
    if path.contains("..") {
        return Err(AppError::Validation("资源路径不允许 .. 逃逸".to_string()));
    }
    Ok(path.to_string())
}

// ── Schema 校验 ───────────────────────────────────────────────────────────

pub fn normalize_content(kind: &str, format: &str, content: &str) -> AppResult<String> {
    validate_enum(kind, VISUAL_KINDS, "可视化类型")?;
    if kind == "diff" {
        return Err(AppError::Validation(
            "diff 文档只能由版本对比服务生成".to_string(),
        ));
    }
    let format = validate_enum(format, &["json", "mermaid", "image", "svg"], "内容格式")?;
    scan_text(content)?;
    match kind {
        "flowchart" | "architecture" | "dataflow" => {
            let graph = if format == "mermaid" {
                parse_mermaid(content)?
            } else {
                serde_json::from_str::<Value>(content)
                    .map_err(|e| AppError::Validation(format!("图 JSON 解析失败：{e}")))?
            };
            normalize_graph(kind, graph)
        }
        "prototype" => {
            let doc = serde_json::from_str::<Value>(content)
                .map_err(|e| AppError::Validation(format!("原型 JSON 解析失败：{e}")))?;
            normalize_prototype(doc)
        }
        "bug_annotation" => {
            let doc = serde_json::from_str::<Value>(content)
                .map_err(|e| AppError::Validation(format!("标注 JSON 解析失败：{e}")))?;
            normalize_annotation(doc)
        }
        "static_image" => {
            let doc = serde_json::from_str::<Value>(content)
                .map_err(|e| AppError::Validation(format!("图片 JSON 解析失败：{e}")))?;
            normalize_static(doc)
        }
        _ => Err(AppError::Validation("不支持的可视化类型".to_string())),
    }
}

fn required_object<'a>(value: &'a Value, field: &str) -> AppResult<&'a Map<String, Value>> {
    value
        .as_object()
        .ok_or_else(|| AppError::Validation(format!("{field} 必须是对象")))
}

fn normalize_graph(kind: &str, value: Value) -> AppResult<String> {
    let obj = required_object(&value, "图内容")?;
    let nodes = obj
        .get("nodes")
        .and_then(|v| v.as_array())
        .ok_or_else(|| AppError::Validation("缺少 nodes 数组".to_string()))?;
    if nodes.is_empty() {
        return Err(AppError::Validation("至少需要一个节点".to_string()));
    }
    if nodes.len() > MAX_NODES {
        return Err(AppError::Validation(format!(
            "节点数超过 {MAX_NODES} 上限"
        )));
    }
    let direction = obj
        .get("layout")
        .and_then(|v| v.get("direction"))
        .and_then(|v| v.as_str())
        .unwrap_or("TB");
    let direction = validate_enum(direction, &["TB", "LR"], "布局方向")?;
    let node_kinds: &[&str] = match kind {
        "architecture" => &["module", "service", "store", "ui", "external"],
        "dataflow" => &["source", "process", "store", "sink"],
        _ => &["start", "process", "decision", "end", "note"],
    };
    let mut out_nodes = Vec::new();
    let mut ids = BTreeSet::new();
    for (index, node) in nodes.iter().enumerate() {
        let node_obj = required_object(node, "节点")?;
        let id = node_obj
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim();
        if id.is_empty() {
            return Err(AppError::Validation("节点 id 不能为空".to_string()));
        }
        if !ids.insert(id.to_string()) {
            return Err(AppError::Validation(format!("节点 id 重复：{id}")));
        }
        let label = node_obj
            .get("label")
            .and_then(|v| v.as_str())
            .unwrap_or(id);
        let label = validate_text(label, "节点标题", 200, true)?;
        let nkind = node_obj
            .get("kind")
            .and_then(|v| v.as_str())
            .unwrap_or("process");
        let nkind = validate_enum(nkind, node_kinds, "节点类型")?;
        let config = node_obj.get("config").cloned().unwrap_or_else(|| json!({}));
        if !config.is_object() {
            return Err(AppError::Validation("节点 config 必须是对象".to_string()));
        }
        scan_value(&config)?;
        // 人工编辑的位置必须原样保留；缺失时才生成确定性默认坐标。
        let default_x = 60.0 + (index % 3) as f64 * 220.0;
        let default_y = 80.0 + (index / 3) as f64 * 140.0;
        let x = number_in_range(node_obj.get("x"), "节点 x", 0.0, 5000.0, default_x)?;
        let y = number_in_range(node_obj.get("y"), "节点 y", 0.0, 5000.0, default_y)?;
        let color = match node_obj.get("color").and_then(|v| v.as_str()) {
            Some(raw) if !raw.trim().is_empty() => {
                let raw = raw.trim();
                validate_node_color(raw)?;
                Some(raw.to_string())
            }
            _ => None,
        };
        let mut node_value = json!({
            "id": id, "label": label, "kind": nkind, "config": config,
            "x": x.round(), "y": y.round()
        });
        if let Some(color) = color {
            node_value["color"] = Value::String(color);
        }
        out_nodes.push(node_value);
    }

    let edges = obj
        .get("edges")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    if edges.len() > MAX_EDGES {
        return Err(AppError::Validation(format!(
            "连线数超过 {MAX_EDGES} 上限"
        )));
    }
    let mut out_edges = Vec::new();
    let mut edge_ids = BTreeSet::new();
    for (i, edge) in edges.iter().enumerate() {
        let edge_obj = required_object(edge, "连线")?;
        let from = edge_obj.get("from").and_then(|v| v.as_str()).unwrap_or("");
        let to = edge_obj.get("to").and_then(|v| v.as_str()).unwrap_or("");
        if !ids.contains(from) || !ids.contains(to) {
            return Err(AppError::Validation(format!(
                "连线引用了不存在的节点：{from} → {to}"
            )));
        }
        let eid = edge_obj
            .get("id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("e{}", i + 1));
        if !edge_ids.insert(eid.clone()) {
            return Err(AppError::Validation(format!("连线 id 重复：{eid}")));
        }
        let label = edge_obj.get("label").and_then(|v| v.as_str()).unwrap_or("");
        let label = validate_text(label, "连线标题", 200, false)?;
        out_edges.push(json!({"id": eid, "from": from, "to": to, "label": label}));
    }

    // 画布尺寸：显式值优先（320–6000），否则按节点包围盒推导并留出余量。
    let max_x = out_nodes
        .iter()
        .filter_map(|n| n.get("x").and_then(|v| v.as_f64()))
        .fold(0.0_f64, f64::max);
    let max_y = out_nodes
        .iter()
        .filter_map(|n| n.get("y").and_then(|v| v.as_f64()))
        .fold(0.0_f64, f64::max);
    let layout_obj = obj.get("layout").cloned().unwrap_or_else(|| json!({}));
    let layout_map = layout_obj.as_object();
    let width = number_in_range(
        layout_map.and_then(|m| m.get("width")),
        "画布宽度",
        320.0,
        6000.0,
        (max_x + 260.0).max(720.0),
    )?;
    let height = number_in_range(
        layout_map.and_then(|m| m.get("height")),
        "画布高度",
        320.0,
        6000.0,
        (max_y + 180.0).max(360.0),
    )?;
    Ok(json!({
        "nodes": out_nodes,
        "edges": out_edges,
        "layout": {
            "direction": direction,
            "width": width.round(),
            "height": height.round()
        }
    })
    .to_string())
}

fn normalize_prototype(value: Value) -> AppResult<String> {
    let obj = required_object(&value, "原型内容")?;
    let pages = obj
        .get("pages")
        .and_then(|v| v.as_array())
        .ok_or_else(|| AppError::Validation("缺少 pages 数组".to_string()))?;
    if pages.is_empty() {
        return Err(AppError::Validation("至少需要一个页面".to_string()));
    }
    if pages.len() > MAX_PAGES {
        return Err(AppError::Validation(format!(
            "页面数超过 {MAX_PAGES} 上限"
        )));
    }
    let mut page_ids = BTreeSet::new();
    let mut all_pages = Vec::new();
    for page in pages {
        let p = required_object(page, "页面")?;
        let id = p.get("id").and_then(|v| v.as_str()).unwrap_or("").trim();
        if id.is_empty() || !page_ids.insert(id.to_string()) {
            return Err(AppError::Validation(format!("页面 id 为空或重复：{id}")));
        }
        let name = validate_text(
            p.get("name").and_then(|v| v.as_str()).unwrap_or(id),
            "页面名称",
            200,
            true,
        )?;
        let components = p
            .get("components")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        if components.len() > MAX_COMPONENTS_PER_PAGE {
            return Err(AppError::Validation(format!(
                "单页组件数超过 {MAX_COMPONENTS_PER_PAGE} 上限"
            )));
        }
        let mut comp_ids = BTreeSet::new();
        let mut out_components = Vec::new();
        for comp in &components {
            out_components.push(normalize_component(comp, &mut comp_ids)?);
        }
        all_pages.push(json!({"id": id, "name": name, "components": out_components}));
    }

    let viewport = obj.get("viewport").cloned().unwrap_or_else(|| json!({}));
    let vp = required_object(&viewport, "viewport")?;
    let width = vp.get("width").and_then(|v| v.as_f64()).unwrap_or(400.0);
    let height = vp.get("height").and_then(|v| v.as_f64()).unwrap_or(640.0);
    if !(280.0..=3840.0).contains(&width) || !(320.0..=2160.0).contains(&height) {
        return Err(AppError::Validation(
            "viewport 尺寸超出允许范围（宽 280–3840，高 320–2160）".to_string(),
        ));
    }
    let state = obj
        .get("state")
        .map(|v| -> AppResult<Value> {
            if !v.is_object() {
                return Err(AppError::Validation("state 必须是对象".to_string()));
            }
            scan_value(v)?;
            Ok(v.clone())
        })
        .transpose()?
        .unwrap_or_else(|| json!({}));

    // 事件目标必须真实存在：避免保存后出现死链（页面删除/改名后的常见问题）。
    let page_ids: BTreeSet<String> = all_pages
        .iter()
        .filter_map(|p| p.get("id").and_then(|v| v.as_str()).map(str::to_string))
        .collect();
    let component_ids: BTreeSet<String> = all_pages
        .iter()
        .flat_map(|p| {
            p.get("components")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default()
        })
        .filter_map(|c| c.get("id").and_then(|v| v.as_str()).map(str::to_string))
        .collect();
    for page in &all_pages {
        let page_id = page.get("id").and_then(|v| v.as_str()).unwrap_or("");
        for comp in page
            .get("components")
            .and_then(|v| v.as_array())
            .into_iter()
            .flatten()
        {
            let comp_id = comp.get("id").and_then(|v| v.as_str()).unwrap_or("");
            for (key, event) in comp
                .get("events")
                .and_then(|v| v.as_object())
                .into_iter()
                .flatten()
            {
                let action = event.get("action").and_then(|v| v.as_str()).unwrap_or("");
                let target = event.get("target").and_then(|v| v.as_str()).unwrap_or("");
                let ok = match action {
                    "navigate" => page_ids.contains(target),
                    "openModal" => component_ids.contains(target),
                    _ => true,
                };
                if !ok {
                    return Err(AppError::Validation(format!(
                        "页面 {page_id} 组件 {comp_id} 的 {key} 指向不存在的目标：{target}"
                    )));
                }
            }
        }
    }

    Ok(json!({
        "schemaVersion": 1,
        "viewport": {"width": width.round(), "height": height.round()},
        "pages": all_pages,
        "state": state
    })
    .to_string())
}

fn normalize_component(comp: &Value, ids: &mut BTreeSet<String>) -> AppResult<Value> {
    let c = required_object(comp, "组件")?;
    let id = c.get("id").and_then(|v| v.as_str()).unwrap_or("").trim();
    if id.is_empty() || !ids.insert(id.to_string()) {
        return Err(AppError::Validation(format!("组件 id 为空或重复：{id}")));
    }
    let ty = c.get("type").and_then(|v| v.as_str()).unwrap_or("");
    let ty = validate_enum(ty, COMPONENT_TYPES, "组件类型")?;
    let x = number_in_range(c.get("x"), "x", 0.0, 5000.0, 0.0)?;
    let y = number_in_range(c.get("y"), "y", 0.0, 5000.0, 0.0)?;
    let w = number_in_range(c.get("w"), "w", 1.0, 2000.0, 120.0)?;
    let h = number_in_range(c.get("h"), "h", 1.0, 2000.0, 40.0)?;

    let props = c.get("props").cloned().unwrap_or_else(|| json!({}));
    let props_obj = required_object(&props, "props")?;
    let mut out_props = Map::new();
    for (k, v) in props_obj {
        scan_text(k)?;
        match v {
            Value::String(s) => {
                out_props.insert(
                    k.clone(),
                    Value::String(validate_text(s, "组件属性", 500, false)?),
                );
            }
            Value::Number(_) | Value::Bool(_) => {
                out_props.insert(k.clone(), v.clone());
            }
            _ => {
                return Err(AppError::Validation(
                    "props 只允许字符串/数字/布尔值".to_string(),
                ))
            }
        };
    }

    let style = c.get("style").cloned().unwrap_or_else(|| json!({}));
    let style_obj = required_object(&style, "style")?;
    let mut out_style = Map::new();
    for (k, v) in style_obj {
        if !STYLE_KEYS.contains(&k.as_str()) {
            return Err(AppError::Validation(format!("不支持的样式键：{k}")));
        }
        let s = v.as_str().ok_or_else(|| {
            AppError::Validation("样式值必须是字符串（px/hex/var token）".to_string())
        })?;
        validate_style_value(s)?;
        out_style.insert(k.clone(), Value::String(s.to_string()));
    }

    let events = c.get("events").cloned().unwrap_or_else(|| json!({}));
    let events_obj = required_object(&events, "events")?;
    let mut out_events = Map::new();
    for (k, v) in events_obj {
        if !EVENT_KEYS.contains(&k.as_str()) {
            return Err(AppError::Validation(format!("不支持的事件：{k}")));
        }
        let e = required_object(v, "事件")?;
        let action = e.get("action").and_then(|x| x.as_str()).unwrap_or("");
        let action = validate_enum(action, ACTIONS, "事件动作")?;
        let target = e.get("target").and_then(|x| x.as_str()).unwrap_or("");
        if action != "closeModal" && action != "toggle" && target.is_empty() {
            return Err(AppError::Validation(format!(
                "事件 {action} 需要 target"
            )));
        }
        let mut ev = Map::new();
        ev.insert("action".to_string(), Value::String(action));
        if !target.is_empty() {
            ev.insert("target".to_string(), Value::String(validate_text(target, "事件目标", 200, true)?));
        }
        if let Some(value) = e.get("value") {
            scan_value(value)?;
            ev.insert("value".to_string(), value.clone());
        }
        out_events.insert(k.clone(), Value::Object(ev));
    }

    Ok(json!({
        "id": id, "type": ty,
        "x": x.round(), "y": y.round(), "w": w.round(), "h": h.round(),
        "props": out_props, "style": out_style, "events": out_events
    }))
}

fn number_in_range(
    value: Option<&Value>,
    field: &str,
    min: f64,
    max: f64,
    default: f64,
) -> AppResult<f64> {
    let n = match value {
        Some(v) => v
            .as_f64()
            .ok_or_else(|| AppError::Validation(format!("{field} 必须是数字")))?,
        None => default,
    };
    if !n.is_finite() || n < min || n > max {
        return Err(AppError::Validation(format!(
            "{field} 超出范围 {min}–{max}"
        )));
    }
    Ok(n)
}

/// 节点颜色只允许语义 Token 或 hex；避免把任意 CSS 枚举写成颜色。
fn validate_node_color(value: &str) -> AppResult<()> {
    let v = value.trim();
    let token = v.starts_with("var(--") && v.ends_with(')');
    let hex = v.starts_with('#')
        && matches!(v.len(), 4 | 7)
        && v[1..].chars().all(|c| c.is_ascii_hexdigit());
    if token || hex {
        Ok(())
    } else {
        Err(AppError::Validation(format!(
            "节点颜色不合法：{value}（只允许 var(--token) 或 #hex）"
        )))
    }
}

fn validate_style_value(value: &str) -> AppResult<()> {
    let v = value.trim();
    if v.is_empty() {
        return Ok(());
    }
    let lower = v.to_ascii_lowercase();
    let ok = (v.starts_with("var(--") && v.ends_with(')'))
        || (v.starts_with('#') && (v.len() == 4 || v.len() == 7) && v[1..].chars().all(|c| c.is_ascii_hexdigit()))
        || v.ends_with("px") && v[..v.len() - 2].parse::<f64>().is_ok()
        || v.parse::<f64>().is_ok()
        || matches!(
            lower.as_str(),
            "left" | "center" | "right" | "row" | "column" | "bold" | "normal" | "none"
        );
    if !ok {
        return Err(AppError::Validation(format!(
            "样式值不合法：{value}（只允许 var(--token)/hex/Npx/数字/枚举）"
        )));
    }
    Ok(())
}

/// 资产引用：既支持平台资产 ID（`va_…`），也兼容旧版受控路径。
fn validate_asset_ref(raw: &str) -> AppResult<String> {
    let value = raw.trim();
    if value.starts_with("va_")
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Ok(value.to_string());
    }
    validate_asset_path(value)
}

fn normalize_annotation(value: Value) -> AppResult<String> {
    let obj = required_object(&value, "标注内容")?;
    let asset_id = obj
        .get("assetId")
        .and_then(|v| v.as_str())
        .map(validate_asset_ref)
        .transpose()?;
    let image = obj
        .get("image")
        .and_then(|v| v.as_str())
        .map(validate_asset_ref)
        .transpose()?;
    if asset_id.is_none() && image.is_none() {
        return Err(AppError::Validation(
            "缺少图片来源（assetId 或 image）".to_string(),
        ));
    }
    let width = number_in_range(obj.get("width"), "图片宽度", 1.0, 7680.0, 1280.0)?;
    let height = number_in_range(obj.get("height"), "图片高度", 1.0, 4320.0, 720.0)?;
    let annotations = obj
        .get("annotations")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    if annotations.len() > 200 {
        return Err(AppError::Validation("标注最多 200 条".to_string()));
    }
    let mut out = Vec::new();
    for a in &annotations {
        let o = required_object(a, "标注")?;
        let shape = validate_enum(
            o.get("shape").and_then(|v| v.as_str()).unwrap_or("rect"),
            &["rect", "circle", "arrow", "text", "highlight"],
            "标注形状",
        )?;
        let x = number_in_range(o.get("x"), "x", 0.0, 10_000.0, 0.0)?;
        let y = number_in_range(o.get("y"), "y", 0.0, 10_000.0, 0.0)?;
        let w = number_in_range(o.get("w"), "w", 0.0, 10_000.0, 50.0)?;
        let h = number_in_range(o.get("h"), "h", 0.0, 10_000.0, 50.0)?;
        let note = validate_text(
            o.get("note").and_then(|v| v.as_str()).unwrap_or(""),
            "标注说明",
            500,
            false,
        )?;
        let severity = validate_enum(
            o.get("severity").and_then(|v| v.as_str()).unwrap_or("medium"),
            &["low", "medium", "high", "critical"],
            "严重程度",
        )?;
        let color = match o.get("color").and_then(|v| v.as_str()) {
            Some(raw) if !raw.trim().is_empty() => {
                let raw = raw.trim();
                validate_style_value(raw)?;
                Some(raw.to_string())
            }
            _ => None,
        };
        let mut item = json!({
            "shape": shape,
            "x": x.round(), "y": y.round(), "w": w.round(), "h": h.round(),
            "note": note, "severity": severity
        });
        if let Some(color) = color {
            item["color"] = Value::String(color);
        }
        out.push(item);
    }
    let mut doc = json!({
        "width": width.round(),
        "height": height.round(),
        "annotations": out
    });
    if let Some(asset_id) = asset_id {
        doc["assetId"] = Value::String(asset_id);
    }
    if let Some(image) = image {
        doc["image"] = Value::String(image);
    }
    Ok(doc.to_string())
}

fn normalize_static(value: Value) -> AppResult<String> {
    let obj = required_object(&value, "图片内容")?;
    let asset_id = obj
        .get("assetId")
        .and_then(|v| v.as_str())
        .map(validate_asset_ref)
        .transpose()?;
    let asset = obj
        .get("asset")
        .and_then(|v| v.as_str())
        .map(validate_asset_ref)
        .transpose()?;
    if asset_id.is_none() && asset.is_none() {
        return Err(AppError::Validation(
            "缺少图片资产（assetId 或 asset）".to_string(),
        ));
    }
    let width = number_in_range(obj.get("width"), "width", 1.0, 7680.0, 400.0)?;
    let height = number_in_range(obj.get("height"), "height", 1.0, 4320.0, 600.0)?;
    let params = obj.get("params").cloned().unwrap_or_else(|| json!({}));
    scan_value(&params)?;
    let mut doc = json!({"width": width.round(), "height": height.round(), "params": params});
    if let Some(asset_id) = asset_id {
        doc["assetId"] = Value::String(asset_id);
    }
    if let Some(asset) = asset {
        doc["asset"] = Value::String(asset);
    }
    Ok(doc.to_string())
}

/// 受限 Mermaid 解析：只支持 `graph TD/LR` + `A[Label] --> B[Label]`。
/// 不支持样式、点击事件、子图；解析失败明确报错，不静默降级。
fn parse_mermaid(source: &str) -> AppResult<Value> {
    let mut nodes: BTreeMap<String, String> = BTreeMap::new();
    let mut edges = Vec::new();
    let mut direction = "TB";
    for raw in source.lines() {
        let line = raw.trim().trim_end_matches(';');
        if line.is_empty() || line.starts_with("%%") {
            continue;
        }
        let lower = line.to_ascii_lowercase();
        if lower.starts_with("graph ") || lower.starts_with("flowchart ") {
            let d = line.split_whitespace().nth(1).unwrap_or("TD");
            direction = if d.eq_ignore_ascii_case("LR") { "LR" } else { "TB" };
            continue;
        }
        let parts: Vec<&str> = line.split("-->").collect();
        if parts.len() != 2 {
            return Err(AppError::Validation(format!(
                "不支持的 Mermaid 语法：{line}（仅支持 A[标签] --> B[标签]）"
            )));
        }
        let left = parse_mermaid_node(parts[0].trim())?;
        let right = parse_mermaid_node(parts[1].trim())?;
        nodes.insert(left.0.clone(), left.1.clone());
        nodes.insert(right.0.clone(), right.1.clone());
        edges.push(json!({"from": left.0, "to": right.0, "label": ""}));
    }
    if nodes.is_empty() {
        return Err(AppError::Validation("Mermaid 内容为空或没有连线".to_string()));
    }
    let list: Vec<Value> = nodes
        .into_iter()
        .map(|(id, label)| json!({"id": id, "label": label, "kind": "process", "config": {}}))
        .collect();
    Ok(json!({"nodes": list, "edges": edges, "layout": {"direction": direction}}))
}

fn parse_mermaid_node(raw: &str) -> AppResult<(String, String)> {
    let raw = raw.trim();
    let (id, label) = if let Some(open) = raw.find('[') {
        let close = raw
            .rfind(']')
            .ok_or_else(|| AppError::Validation("Mermaid 节点缺少 ]".to_string()))?;
        let id = raw[..open].trim();
        let label = raw[open + 1..close].trim().trim_matches('"');
        (id, label)
    } else {
        (raw, raw)
    };
    if id.is_empty() {
        return Err(AppError::Validation("Mermaid 节点 id 为空".to_string()));
    }
    if !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        return Err(AppError::Validation(format!("Mermaid 节点 id 非法：{id}")));
    }
    Ok((id.to_string(), label.to_string()))
}

// ── CRUD ─────────────────────────────────────────────────────────────────

pub fn create_document(
    conn: &Connection,
    actor: &Actor,
    project_id: &str,
    input: &VisualInput,
) -> AppResult<VisualDocument> {
    actor.require(Capability::VisualWrite)?;
    assert_project_scope(conn, actor, project_id)?;
    let kind = validate_enum(&input.kind, VISUAL_KINDS, "可视化类型")?;
    let title = validate_text(&input.title, "标题", MAX_TITLE, true)?;
    let description = validate_text(&input.description, "描述", MAX_DESCRIPTION, false)?;
    let format = validate_enum(&input.source_format, &["json", "mermaid", "image", "svg"], "内容格式")?;
    let content = if input.source_content.trim().is_empty() {
        "{}".to_string()
    } else {
        input.source_content.clone()
    };
    let normalized = normalize_content(&kind, &format, &content)?;
    let renderer = renderer_for(&kind)?.to_string();

    if let Some(plan_id) = &input.plan_id {
        let plan_project: Option<String> = conn
            .query_row(
                "SELECT project_id FROM collab_plans WHERE id=?1",
                rusqlite::params![plan_id],
                |r| r.get(0),
            )
            .optional()?;
        if plan_project.as_deref() != Some(project_id) {
            return Err(AppError::Forbidden("关联方案不存在或不属于该项目".to_string()));
        }
    }
    if let Some(asset) = &input.preview_asset {
        validate_asset_path(asset)?;
    }

    let now = now_iso();
    let authoring_mode = resolve_authoring_mode(actor, input.authoring_mode.as_deref())?;
    let doc = VisualDocument {
        id: new_id("vd"),
        project_id: project_id.to_string(),
        plan_id: input.plan_id.clone(),
        title,
        description,
        kind,
        authoring_mode: authoring_mode.clone(),
        schema_version: 1,
        source_format: format,
        source_content: normalized,
        renderer,
        preview_asset: input.preview_asset.clone(),
        status: "draft".to_string(),
        version: 1,
        revision: 1,
        created_by: actor.id.clone(),
        updated_by: actor.id.clone(),
        created_at: now.clone(),
        updated_at: now.clone(),
    };
    conn.execute(
        &format!("INSERT INTO collab_visual_docs ({COLS}) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19)"),
        rusqlite::params![
            doc.id, doc.project_id, doc.plan_id, doc.title, doc.description, doc.kind,
            doc.authoring_mode, doc.schema_version, doc.source_format, doc.source_content,
            doc.renderer, doc.preview_asset, doc.status, doc.version, doc.revision,
            doc.created_by, doc.updated_by, doc.created_at, doc.updated_at
        ],
    )?;
    if let Some(plan_id) = &doc.plan_id {
        conn.execute(
            "INSERT OR IGNORE INTO collab_plan_links (id, plan_id, target_kind, target_id, created_at)
             VALUES (?1,?2,'visual',?3,?4)",
            rusqlite::params![new_id("pl"), plan_id, doc.id, now],
        )?;
    }
    write_version(conn, &doc, actor, &authoring_mode, None, "创建")?;
    write_audit(
        conn,
        project_id,
        "visual",
        &doc.id,
        "create",
        actor,
        None,
        Some(1),
        json!({"kind": doc.kind, "title": doc.title}),
    )?;
    Ok(doc)
}

pub fn update_document(
    conn: &Connection,
    actor: &Actor,
    id: &str,
    expected_revision: i64,
    patch: &VisualPatch,
    change_summary: &str,
) -> AppResult<VisualDocument> {
    actor.require(Capability::VisualWrite)?;
    let current = load_document(conn, id)?;
    assert_project_scope(conn, actor, &current.project_id)?;

    let mut next = current.clone();
    if let Some(v) = &patch.title {
        next.title = validate_text(v, "标题", MAX_TITLE, true)?;
    }
    if let Some(v) = &patch.description {
        next.description = validate_text(v, "描述", MAX_DESCRIPTION, false)?;
    }
    if let Some(v) = &patch.status {
        next.status = validate_enum(v, &["draft", "published", "archived"], "文档状态")?;
    }
    if let Some(v) = &patch.preview_asset {
        if v.trim().is_empty() {
            next.preview_asset = None;
        } else {
            next.preview_asset = Some(validate_asset_path(v)?);
        }
    }
    let format = patch
        .source_format
        .clone()
        .unwrap_or_else(|| current.source_format.clone());
    if patch.source_format.is_some() || patch.source_content.is_some() {
        let content = patch
            .source_content
            .clone()
            .unwrap_or_else(|| current.source_content.clone());
        next.source_content = normalize_content(&current.kind, &format, &content)?;
        next.source_format = format;
        next.renderer = renderer_for(&current.kind)?.to_string();
    }

    // 创作来源：显式值优先；否则按身份与当前来源推断。
    let version_mode = match patch.authoring_mode.as_deref() {
        Some(mode) => validate_enum(mode, AUTHORING_MODES, "创作来源")?,
        None => match actor.kind {
            ActorKind::Agent => "agent_authored".to_string(),
            _ => "manual".to_string(),
        },
    };
    next.authoring_mode = match patch.authoring_mode.as_deref() {
        Some(mode) => validate_enum(mode, AUTHORING_MODES, "创作来源")?,
        None => match actor.kind {
            ActorKind::Agent => "agent_authored".to_string(),
            // 人工修改 AI/Agent 内容 → 混合创作；其余保持原来源。
            _ if matches!(current.authoring_mode.as_str(), "ai_generated" | "agent_authored") => {
                "ai_assisted".to_string()
            }
            _ => current.authoring_mode.clone(),
        },
    };

    let revision = current.revision + 1;
    let version = current.version + 1;
    let now = now_iso();
    let changed = conn.execute(
        "UPDATE collab_visual_docs SET title=?2, description=?3, source_format=?4,
         source_content=?5, renderer=?6, preview_asset=?7, status=?8, version=?9,
         revision=?10, updated_by=?11, updated_at=?12, authoring_mode=?13
         WHERE id=?1 AND revision=?14",
        rusqlite::params![
            id,
            next.title,
            next.description,
            next.source_format,
            next.source_content,
            next.renderer,
            next.preview_asset,
            next.status,
            version,
            revision,
            actor.id,
            now,
            next.authoring_mode,
            expected_revision,
        ],
    )?;
    if changed == 0 {
        return Err(AppError::Conflict(format!(
            "版本冲突：文档已被其他操作修改（当前 revision={}）",
            current.revision
        )));
    }
    next.revision = revision;
    next.version = version;
    next.updated_by = actor.id.clone();
    next.updated_at = now;

    let summary = if change_summary.trim().is_empty() {
        "更新可视化"
    } else {
        change_summary.trim()
    };
    write_version(
        conn,
        &next,
        actor,
        &version_mode,
        patch.ai_job_id.as_deref(),
        summary,
    )?;
    write_audit(
        conn,
        &current.project_id,
        "visual",
        id,
        "update",
        actor,
        Some(current.revision),
        Some(revision),
        json!({"version": version, "summary": summary}),
    )?;
    Ok(next)
}

pub fn load_document(conn: &Connection, id: &str) -> AppResult<VisualDocument> {
    conn.query_row(
        &format!("SELECT {COLS} FROM collab_visual_docs WHERE id=?1"),
        rusqlite::params![id],
        map_doc_row,
    )
    .optional()?
    .ok_or_else(|| AppError::NotFound("可视化文档不存在".to_string()))
}

pub fn get_document(conn: &Connection, actor: &Actor, id: &str) -> AppResult<VisualDocument> {
    actor.require(Capability::VisualRead)?;
    let doc = load_document(conn, id)?;
    assert_project_scope(conn, actor, &doc.project_id)?;
    Ok(doc)
}

pub fn list_documents(
    conn: &Connection,
    actor: &Actor,
    project_id: &str,
    kind: Option<&str>,
    page: Option<i64>,
    page_size: Option<i64>,
) -> AppResult<Page<VisualDocument>> {
    actor.require(Capability::VisualRead)?;
    assert_project_scope(conn, actor, project_id)?;
    let (page, size, offset) = page_args(page, page_size);
    let total: i64 = match kind {
        Some(k) => {
            validate_enum(k, VISUAL_KINDS, "可视化类型")?;
            conn.query_row(
                "SELECT COUNT(*) FROM collab_visual_docs WHERE project_id=?1 AND kind=?2",
                rusqlite::params![project_id, k],
                |r| r.get(0),
            )?
        }
        None => conn.query_row(
            "SELECT COUNT(*) FROM collab_visual_docs WHERE project_id=?1",
            rusqlite::params![project_id],
            |r| r.get(0),
        )?,
    };
    let sql = match kind {
        Some(_) => format!(
            "SELECT {COLS} FROM collab_visual_docs WHERE project_id=?1 AND kind=?2 \
             ORDER BY updated_at DESC LIMIT ?3 OFFSET ?4"
        ),
        None => format!(
            "SELECT {COLS} FROM collab_visual_docs WHERE project_id=?1 \
             ORDER BY updated_at DESC LIMIT ?2 OFFSET ?3"
        ),
    };
    let mut stmt = conn.prepare(&sql)?;
    let items = match kind {
        Some(k) => stmt
            .query_map(rusqlite::params![project_id, k, size, offset], map_doc_row)?
            .collect::<Result<Vec<_>, _>>()?,
        None => stmt
            .query_map(rusqlite::params![project_id, size, offset], map_doc_row)?
            .collect::<Result<Vec<_>, _>>()?,
    };
    Ok(Page::new(items, total, page, size))
}

// ── 版本 ─────────────────────────────────────────────────────────────────

fn snapshot(doc: &VisualDocument, ai_job_id: Option<&str>) -> String {
    let mut value = json!({
        "title": doc.title,
        "description": doc.description,
        "kind": doc.kind,
        "authoringMode": doc.authoring_mode,
        "schemaVersion": doc.schema_version,
        "sourceFormat": doc.source_format,
        "sourceContent": doc.source_content,
        // 入库内容是 normalize_content 之后的 JSON；恢复时不能再按原格式（如
        // Mermaid 文本）解析，否则会把已结构化的快照当成非法 Mermaid。
        "normalized": true,
        "renderer": doc.renderer,
        "previewAsset": doc.preview_asset,
        "status": doc.status
    });
    if let Some(job_id) = ai_job_id {
        value["aiJobId"] = Value::String(job_id.to_string());
    }
    value.to_string()
}

fn write_version(
    conn: &Connection,
    doc: &VisualDocument,
    actor: &Actor,
    authoring_mode: &str,
    ai_job_id: Option<&str>,
    summary: &str,
) -> AppResult<()> {
    conn.execute(
        "INSERT INTO collab_visual_versions
         (id, document_id, version, snapshot_json, change_summary, authoring_mode, created_by,
          source, created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
        rusqlite::params![
            new_id("vv"),
            doc.id,
            doc.version,
            snapshot(doc, ai_job_id),
            summary,
            authoring_mode,
            actor.id,
            actor.source,
            now_iso()
        ],
    )?;
    Ok(())
}

pub fn list_versions(
    conn: &Connection,
    actor: &Actor,
    document_id: &str,
    page: Option<i64>,
    page_size: Option<i64>,
) -> AppResult<Page<VisualVersion>> {
    actor.require(Capability::VisualRead)?;
    let doc = load_document(conn, document_id)?;
    assert_project_scope(conn, actor, &doc.project_id)?;
    let (page, size, offset) = page_args(page, page_size);
    let total: i64 = conn.query_row(
        "SELECT COUNT(*) FROM collab_visual_versions WHERE document_id=?1",
        rusqlite::params![document_id],
        |r| r.get(0),
    )?;
    let mut stmt = conn.prepare(
        "SELECT id, document_id, version, snapshot_json, change_summary, authoring_mode,
                created_by, source, created_at
         FROM collab_visual_versions WHERE document_id=?1 ORDER BY version DESC LIMIT ?2 OFFSET ?3",
    )?;
    let items = stmt
        .query_map(rusqlite::params![document_id, size, offset], |r| {
            Ok(VisualVersion {
                id: r.get(0)?,
                document_id: r.get(1)?,
                version: r.get(2)?,
                snapshot: r.get(3)?,
                change_summary: r.get(4)?,
                authoring_mode: r.get(5)?,
                created_by: r.get(6)?,
                source: r.get(7)?,
                created_at: r.get(8)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Page::new(items, total, page, size))
}

pub fn get_version(conn: &Connection, document_id: &str, version: i64) -> AppResult<VisualVersion> {
    conn.query_row(
        "SELECT id, document_id, version, snapshot_json, change_summary, authoring_mode,
                created_by, source, created_at
         FROM collab_visual_versions WHERE document_id=?1 AND version=?2",
        rusqlite::params![document_id, version],
        |r| {
            Ok(VisualVersion {
                id: r.get(0)?,
                document_id: r.get(1)?,
                version: r.get(2)?,
                snapshot: r.get(3)?,
                change_summary: r.get(4)?,
                authoring_mode: r.get(5)?,
                created_by: r.get(6)?,
                source: r.get(7)?,
                created_at: r.get(8)?,
            })
        },
    )
    .optional()?
    .ok_or_else(|| AppError::NotFound("版本不存在".to_string()))
}

pub fn restore_version(
    conn: &Connection,
    actor: &Actor,
    document_id: &str,
    version: i64,
    expected_revision: i64,
) -> AppResult<VisualDocument> {
    actor.require(Capability::VisualWrite)?;
    let current = load_document(conn, document_id)?;
    assert_project_scope(conn, actor, &current.project_id)?;
    if current.revision != expected_revision {
        return Err(AppError::Conflict(format!(
            "版本冲突：当前 revision={}",
            current.revision
        )));
    }
    let snapshot_version = get_version(conn, document_id, version)?;
    let snap: Value = serde_json::from_str(&snapshot_version.snapshot)
        .map_err(|_| AppError::Validation("版本快照损坏".to_string()))?;
    let source_content = snap
        .get("sourceContent")
        .and_then(|v| v.as_str())
        .unwrap_or("{}");
    let title = snap
        .get("title")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| current.title.clone());
    let description = snap
        .get("description")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| current.description.clone());
    let preview_asset = snap
        .get("previewAsset")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let source_format = snap
        .get("sourceFormat")
        .and_then(|v| v.as_str())
        .unwrap_or("json");
    let normalized_flag = snap
        .get("normalized")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let normalized = if normalized_flag {
        normalize_content(&current.kind, "json", source_content)?
    } else {
        normalize_content(&current.kind, source_format, source_content)?
    };

    let now = now_iso();
    let revision = current.revision + 1;
    let next_version = current.version + 1;
    let restore_mode = match actor.kind {
        ActorKind::Agent => "agent_authored".to_string(),
        _ => "manual".to_string(),
    };
    let doc_mode = match current.authoring_mode.as_str() {
        "ai_generated" | "agent_authored" if actor.kind != ActorKind::Agent => {
            "ai_assisted".to_string()
        }
        _ => current.authoring_mode.clone(),
    };
    let changed = conn.execute(
        "UPDATE collab_visual_docs SET title=?2, description=?3, source_format=?4, source_content=?5,
         preview_asset=?6, version=?7, revision=?8, updated_by=?9, updated_at=?10, authoring_mode=?11
         WHERE id=?1 AND revision=?12",
        rusqlite::params![
            document_id,
            title,
            description,
            source_format,
            normalized,
            preview_asset,
            next_version,
            revision,
            actor.id,
            now,
            doc_mode,
            expected_revision
        ],
    )?;
    if changed == 0 {
        return Err(AppError::Conflict("版本冲突".to_string()));
    }
    let mut restored = current;
    restored.title = title;
    restored.description = description;
    restored.source_format = source_format.to_string();
    restored.source_content = normalized;
    restored.preview_asset = preview_asset;
    restored.version = next_version;
    restored.revision = revision;
    restored.authoring_mode = doc_mode;
    restored.updated_by = actor.id.clone();
    restored.updated_at = now;
    write_version(
        conn,
        &restored,
        actor,
        &restore_mode,
        None,
        &format!("恢复到版本 {version}"),
    )?;
    write_audit(
        conn,
        &restored.project_id,
        "visual",
        document_id,
        "restore",
        actor,
        Some(restored.revision - 1),
        Some(restored.revision),
        json!({"restoredFrom": version, "newVersion": next_version}),
    )?;
    Ok(restored)
}

// ── 差异 ─────────────────────────────────────────────────────────────────

pub fn compare_versions(
    conn: &Connection,
    actor: &Actor,
    document_id: &str,
    source_version: i64,
    target_version: i64,
) -> AppResult<VisualDiff> {
    actor.require(Capability::VisualRead)?;
    let doc = load_document(conn, document_id)?;
    assert_project_scope(conn, actor, &doc.project_id)?;
    let left = get_version(conn, document_id, source_version)?;
    let right = get_version(conn, document_id, target_version)?;
    Ok(diff_snapshots(&doc.kind, &left.snapshot, &right.snapshot))
}

pub fn diff_snapshots(kind: &str, left: &str, right: &str) -> VisualDiff {
    let l: Value = serde_json::from_str(left).unwrap_or_else(|_| json!({}));
    let r: Value = serde_json::from_str(right).unwrap_or_else(|_| json!({}));
    let mut items = Vec::new();

    for field in ["title", "description", "status"] {
        let lv = l.get(field).cloned().unwrap_or(Value::Null);
        let rv = r.get(field).cloned().unwrap_or(Value::Null);
        if lv != rv {
            items.push(DiffItem {
                path: field.to_string(),
                change: "changed".to_string(),
                before: value_text(&lv),
                after: value_text(&rv),
            });
        }
    }

    match kind {
        "flowchart" | "architecture" | "dataflow" => {
            diff_graph(&l, &r, &mut items);
        }
        "prototype" => diff_prototype(&l, &r, &mut items),
        _ => {
            let lc = l.get("sourceContent").and_then(|v| v.as_str()).unwrap_or("");
            let rc = r.get("sourceContent").and_then(|v| v.as_str()).unwrap_or("");
            if lc != rc {
                items.push(DiffItem {
                    path: "sourceContent".to_string(),
                    change: "changed".to_string(),
                    before: Some(summarize_content(lc)),
                    after: Some(summarize_content(rc)),
                });
            }
        }
    }

    let added = items.iter().filter(|i| i.change == "added").count() as i64;
    let removed = items.iter().filter(|i| i.change == "removed").count() as i64;
    let changed = items.iter().filter(|i| i.change == "changed").count() as i64;
    let summary = if items.is_empty() {
        "两个版本内容一致".to_string()
    } else {
        format!("新增 {added}、删除 {removed}、修改 {changed}")
    };
    VisualDiff {
        added,
        removed,
        changed,
        summary,
        items,
    }
}

fn value_text(v: &Value) -> Option<String> {
    match v {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        other => Some(other.to_string()),
    }
}

fn summarize_content(raw: &str) -> String {
    let chars: String = raw.chars().take(120).collect();
    if raw.chars().count() > 120 {
        format!("{chars}…")
    } else {
        chars
    }
}

fn content_obj(snapshot: &Value) -> Value {
    let raw = snapshot
        .get("sourceContent")
        .and_then(|v| v.as_str())
        .unwrap_or("{}");
    serde_json::from_str(raw).unwrap_or_else(|_| json!({}))
}

fn diff_graph(left: &Value, right: &Value, items: &mut Vec<DiffItem>) {
    let lg = content_obj(left);
    let rg = content_obj(right);
    let ln = lg.get("nodes").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let rn = rg.get("nodes").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let mut lmap = BTreeMap::new();
    for n in &ln {
        if let Some(id) = n.get("id").and_then(|v| v.as_str()) {
            lmap.insert(id.to_string(), n.clone());
        }
    }
    let mut rmap = BTreeMap::new();
    for n in &rn {
        if let Some(id) = n.get("id").and_then(|v| v.as_str()) {
            rmap.insert(id.to_string(), n.clone());
        }
    }
    for (id, node) in &lmap {
        match rmap.get(id) {
            None => items.push(DiffItem {
                path: format!("node:{id}"),
                change: "removed".to_string(),
                before: node.get("label").and_then(|v| v.as_str()).map(|s| s.to_string()),
                after: None,
            }),
            Some(other) => {
                let before = node.get("label").and_then(|v| v.as_str()).unwrap_or("");
                let after = other.get("label").and_then(|v| v.as_str()).unwrap_or("");
                if before != after {
                    items.push(DiffItem {
                        path: format!("node:{id}"),
                        change: "changed".to_string(),
                        before: Some(before.to_string()),
                        after: Some(after.to_string()),
                    });
                }
            }
        }
    }
    for (id, node) in &rmap {
        if !lmap.contains_key(id) {
            items.push(DiffItem {
                path: format!("node:{id}"),
                change: "added".to_string(),
                before: None,
                after: node.get("label").and_then(|v| v.as_str()).map(|s| s.to_string()),
            });
        }
    }
    let le = lg.get("edges").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let re = rg.get("edges").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let mut l_edges: BTreeSet<String> = BTreeSet::new();
    for e in &le {
        l_edges.insert(format!(
            "{}->{}",
            e.get("from").and_then(|v| v.as_str()).unwrap_or(""),
            e.get("to").and_then(|v| v.as_str()).unwrap_or("")
        ));
    }
    let mut r_edges: BTreeSet<String> = BTreeSet::new();
    for e in &re {
        r_edges.insert(format!(
            "{}->{}",
            e.get("from").and_then(|v| v.as_str()).unwrap_or(""),
            e.get("to").and_then(|v| v.as_str()).unwrap_or("")
        ));
    }
    for e in l_edges.difference(&r_edges) {
        items.push(DiffItem {
            path: format!("edge:{e}"),
            change: "removed".to_string(),
            before: Some(e.clone()),
            after: None,
        });
    }
    for e in r_edges.difference(&l_edges) {
        items.push(DiffItem {
            path: format!("edge:{e}"),
            change: "added".to_string(),
            before: None,
            after: Some(e.clone()),
        });
    }
}

fn diff_prototype(left: &Value, right: &Value, items: &mut Vec<DiffItem>) {
    let lp = content_obj(left);
    let rp = content_obj(right);
    let lpages = lp.get("pages").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let rpages = rp.get("pages").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let lmap: BTreeMap<String, Value> = lp_pages(&lpages).into_iter().collect();
    let rmap: BTreeMap<String, Value> = lp_pages(&rpages).into_iter().collect();
    for id in lmap.keys() {
        if !rmap.contains_key(id) {
            items.push(DiffItem {
                path: format!("page:{id}"),
                change: "removed".to_string(),
                before: None,
                after: None,
            });
        }
    }
    for id in rmap.keys() {
        if !lmap.contains_key(id) {
            items.push(DiffItem {
                path: format!("page:{id}"),
                change: "added".to_string(),
                before: None,
                after: None,
            });
        }
    }
    let keys: Vec<String> = lmap.keys().cloned().collect();
    for page_id in keys {
        let Some(lpage) = lmap.get(&page_id).cloned() else { continue };
        let Some(rpage) = rmap.get(&page_id).cloned() else { continue };
        let lc = lpage.get("components").and_then(|v| v.as_array()).cloned().unwrap_or_default();
        let rc = rpage.get("components").and_then(|v| v.as_array()).cloned().unwrap_or_default();
        let mut lcomps = BTreeMap::new();
        for c in &lc {
            if let Some(id) = c.get("id").and_then(|v| v.as_str()) {
                lcomps.insert(id.to_string(), c.clone());
            }
        }
        let mut rcomps = BTreeMap::new();
        for c in &rc {
            if let Some(id) = c.get("id").and_then(|v| v.as_str()) {
                rcomps.insert(id.to_string(), c.clone());
            }
        }
        for (cid, comp) in &lcomps {
            match rcomps.get(cid) {
                None => items.push(DiffItem {
                    path: format!("page:{page_id}/component:{cid}"),
                    change: "removed".to_string(),
                    before: comp.get("type").and_then(|v| v.as_str()).map(|s| s.to_string()),
                    after: None,
                }),
                Some(other) => {
                    let before = comp.to_string();
                    let after = other.to_string();
                    if before != after {
                        items.push(DiffItem {
                            path: format!("page:{page_id}/component:{cid}"),
                            change: "changed".to_string(),
                            before: Some(before),
                            after: Some(after),
                        });
                    }
                }
            }
        }
        for (cid, comp) in &rcomps {
            if !lcomps.contains_key(cid) {
                items.push(DiffItem {
                    path: format!("page:{page_id}/component:{cid}"),
                    change: "added".to_string(),
                    before: None,
                    after: comp.get("type").and_then(|v| v.as_str()).map(|s| s.to_string()),
                });
            }
        }
    }
}

fn lp_pages(pages: &[Value]) -> Vec<(String, Value)> {
    pages
        .iter()
        .filter_map(|p| {
            p.get("id")
                .and_then(|v| v.as_str())
                .map(|id| (id.to_string(), p.clone()))
        })
        .collect()
}

// ── 导出 ─────────────────────────────────────────────────────────────────

pub fn export_document(
    conn: &Connection,
    actor: &Actor,
    id: &str,
    format: &str,
) -> AppResult<ExportResult> {
    actor.require(Capability::VisualRead)?;
    let doc = get_document(conn, actor, id)?;
    match format {
        "json" => Ok(ExportResult {
            format: "json".to_string(),
            content: json!({
                "schemaVersion": doc.schema_version,
                "kind": doc.kind,
                "title": doc.title,
                "description": doc.description,
                "sourceFormat": doc.source_format,
                "sourceContent": serde_json::from_str::<Value>(&doc.source_content)
                    .unwrap_or_else(|_| json!({})),
                "version": doc.version
            })
            .to_string(),
            filename: format!("{}-v{}.json", doc.id, doc.version),
        }),
        "svg" => {
            if !matches!(doc.kind.as_str(), "flowchart" | "architecture" | "dataflow") {
                return Err(AppError::Unavailable(
                    "该类型不支持 SVG 导出（仅流程图/架构图/数据流图）".to_string(),
                ));
            }
            let svg = render_svg(&doc)?;
            Ok(ExportResult {
                format: "svg".to_string(),
                content: svg,
                filename: format!("{}-v{}.svg", doc.id, doc.version),
            })
        }
        _ => Err(AppError::Validation(
            "导出格式只支持 json 或 svg".to_string(),
        )),
    }
}

/// 服务端 SVG 生成：按边的层级做简单分层布局（不依赖前端 canvas）。
pub fn render_svg(doc: &VisualDocument) -> AppResult<String> {
    let graph: Value = serde_json::from_str(&doc.source_content)
        .map_err(|_| AppError::Validation("图内容损坏".to_string()))?;
    let nodes = graph
        .get("nodes")
        .and_then(|v| v.as_array())
        .ok_or_else(|| AppError::Validation("图缺少 nodes".to_string()))?;
    let edges = graph
        .get("edges")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let direction = graph
        .get("layout")
        .and_then(|v| v.get("direction"))
        .and_then(|v| v.as_str())
        .unwrap_or("TB");

    let mut layers: BTreeMap<String, usize> = BTreeMap::new();
    for node in nodes {
        let id = node.get("id").and_then(|v| v.as_str()).unwrap_or("");
        layers.insert(id.to_string(), 0);
    }
    // 最多迭代 N 次，避免异常图导致死循环。
    for _ in 0..nodes.len().min(200) {
        let mut changed = false;
        for e in &edges {
            let from = e.get("from").and_then(|v| v.as_str()).unwrap_or("");
            let to = e.get("to").and_then(|v| v.as_str()).unwrap_or("");
            if let (Some(&lf), Some(&lt)) = (layers.get(from), layers.get(to)) {
                if lf + 1 > lt {
                    layers.insert(to.to_string(), lf + 1);
                    changed = true;
                }
            }
        }
        if !changed {
            break;
        }
    }

    let mut per_layer: BTreeMap<usize, Vec<(String, String)>> = BTreeMap::new();
    for node in nodes {
        let id = node.get("id").and_then(|v| v.as_str()).unwrap_or("");
        let label = node.get("label").and_then(|v| v.as_str()).unwrap_or(id);
        let layer = *layers.get(id).unwrap_or(&0);
        per_layer
            .entry(layer)
            .or_default()
            .push((id.to_string(), label.to_string()));
    }

    let node_w = 170.0;
    let node_h = 46.0;
    let gap_x = 210.0;
    let gap_y = 70.0;
    let max_layer = per_layer.keys().copied().max().unwrap_or(0);
    let max_rows = per_layer.values().map(|v| v.len()).max().unwrap_or(1);
    let (width, height) = if direction == "LR" {
        ((max_layer + 1) as f64 * gap_x + 40.0, max_rows as f64 * gap_y + 40.0)
    } else {
        (max_rows as f64 * 200.0 + 40.0, (max_layer + 1) as f64 * gap_y + 40.0)
    };

    let mut positions: BTreeMap<String, (f64, f64)> = BTreeMap::new();
    for (layer, items) in &per_layer {
        for (i, (id, _)) in items.iter().enumerate() {
            let (x, y) = if direction == "LR" {
                (40.0 + *layer as f64 * gap_x, 40.0 + i as f64 * gap_y)
            } else {
                (40.0 + i as f64 * 200.0, 40.0 + *layer as f64 * gap_y)
            };
            positions.insert(id.clone(), (x, y));
        }
    }

    let mut svg = String::new();
    svg.push_str(&format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{width}\" height=\"{height}\" viewBox=\"0 0 {width} {height}\" role=\"img\">\n"
    ));
    svg.push_str("<style>text{font-family:Segoe UI,sans-serif;font-size:12px;fill:#1f2328}rect{fill:#f6f8fa;stroke:#8c959f;stroke-width:1;rx:8}</style>\n");
    for e in &edges {
        let from = e.get("from").and_then(|v| v.as_str()).unwrap_or("");
        let to = e.get("to").and_then(|v| v.as_str()).unwrap_or("");
        let (fx, fy) = positions.get(from).copied().unwrap_or((0.0, 0.0));
        let (tx, ty) = positions.get(to).copied().unwrap_or((0.0, 0.0));
        let x1 = if direction == "LR" { fx + node_w } else { fx + node_w / 2.0 };
        let y1 = if direction == "LR" { fy + node_h / 2.0 } else { fy + node_h };
        let x2 = if direction == "LR" { tx } else { tx + node_w / 2.0 };
        let y2 = if direction == "LR" { ty + node_h / 2.0 } else { ty };
        svg.push_str(&format!(
            "<line x1=\"{x1:.1}\" y1=\"{y1:.1}\" x2=\"{x2:.1}\" y2=\"{y2:.1}\" stroke=\"#8c959f\" marker-end=\"url(#arrow)\"/>\n"
        ));
    }
    let mut labels: BTreeMap<String, String> = BTreeMap::new();
    for node in nodes {
        let id = node.get("id").and_then(|v| v.as_str()).unwrap_or("");
        let label = node.get("label").and_then(|v| v.as_str()).unwrap_or(id);
        labels.insert(id.to_string(), label.to_string());
    }
    for (id, label) in &labels {
        let (x, y) = positions.get(id).copied().unwrap_or((0.0, 0.0));
        svg.push_str(&format!(
            "<rect x=\"{x:.1}\" y=\"{y:.1}\" width=\"{node_w}\" height=\"{node_h}\"/>\n"
        ));
        svg.push_str(&format!(
            "<text x=\"{:.1}\" y=\"{:.1}\">{}</text>\n",
            x + 10.0,
            y + 27.0,
            escape_xml(label)
        ));
    }
    svg.push_str("<defs><marker id=\"arrow\" markerWidth=\"8\" markerHeight=\"8\" refX=\"6\" refY=\"3\" orient=\"auto\"><path d=\"M0,0 L6,3 L0,6\" fill=\"#8c959f\"/></marker></defs>\n");
    svg.push_str("</svg>");
    Ok(svg)
}

fn escape_xml(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// 归档而不是物理删除：保留版本与审计。
pub fn delete_document(conn: &Connection, actor: &Actor, id: &str) -> AppResult<VisualDocument> {
    actor.require(Capability::VisualWrite)?;
    let doc = load_document(conn, id)?;
    assert_project_scope(conn, actor, &doc.project_id)?;
    if doc.status == "archived" {
        return Ok(doc);
    }
    let revision = doc.revision + 1;
    conn.execute(
        "UPDATE collab_visual_docs SET status='archived', revision=?2, updated_by=?3, updated_at=?4
         WHERE id=?1",
        rusqlite::params![id, revision, actor.id, now_iso()],
    )?;
    write_audit(
        conn,
        &doc.project_id,
        "visual",
        id,
        "archive",
        actor,
        Some(doc.revision),
        Some(revision),
        json!({"from": doc.status}),
    )?;
    load_document(conn, id)
}
