//! 快速笔记命令层：列表 / 详情 / 新建 / 更新 / 删除 / 置顶收藏 / 关联 / 搜索 /
//! 模板 / 收集箱转笔记。
//!
//! 所有业务校验在 `notes::store` 内完成；命令层只做参数归一与状态注入。

use std::sync::Arc;

use tauri::State;

use crate::db::Db;
use crate::error::AppResult;
use crate::notes::store::{
    self, ConvertResult, CreateNoteInput, ListFilter, Note, NoteSummary, NoteTemplate,
    UpdateNoteInput,
};

#[tauri::command]
pub fn notes_list(
    db: State<'_, Arc<Db>>,
    query: Option<String>,
    pinned_only: Option<bool>,
    favorite_only: Option<bool>,
    task_id: Option<String>,
    workspace_id: Option<String>,
    limit: Option<u32>,
    offset: Option<u32>,
) -> AppResult<Vec<NoteSummary>> {
    let filter = ListFilter {
        query,
        pinned_only: pinned_only.unwrap_or(false),
        favorite_only: favorite_only.unwrap_or(false),
        task_id,
        workspace_id,
        limit,
        offset,
    };
    store::list(&db, &filter)
}

#[tauri::command]
pub fn notes_get(db: State<'_, Arc<Db>>, id: String) -> AppResult<Note> {
    store::get(&db, &id)
}

#[tauri::command]
pub fn notes_create(db: State<'_, Arc<Db>>, input: CreateNoteInput) -> AppResult<Note> {
    store::create(&db, input)
}

#[tauri::command]
pub fn notes_update(db: State<'_, Arc<Db>>, id: String, input: UpdateNoteInput) -> AppResult<Note> {
    store::update(&db, &id, input)
}

#[tauri::command]
pub fn notes_delete(db: State<'_, Arc<Db>>, id: String) -> AppResult<bool> {
    store::delete(&db, &id)
}

#[tauri::command]
pub fn notes_set_flags(
    db: State<'_, Arc<Db>>,
    id: String,
    pinned: Option<bool>,
    favorite: Option<bool>,
) -> AppResult<Note> {
    store::set_flags(&db, &id, pinned, favorite)
}

#[tauri::command]
pub fn notes_set_task(
    db: State<'_, Arc<Db>>,
    id: String,
    task_id: Option<String>,
) -> AppResult<Note> {
    store::set_task_link(&db, &id, task_id)
}

#[tauri::command]
pub fn notes_set_workspace(
    db: State<'_, Arc<Db>>,
    id: String,
    workspace_id: Option<String>,
) -> AppResult<Note> {
    store::set_workspace_link(&db, &id, workspace_id)
}

#[tauri::command]
pub fn notes_templates() -> Vec<NoteTemplate> {
    store::templates()
}

#[tauri::command]
pub fn notes_search(
    db: State<'_, Arc<Db>>,
    query: String,
    limit: Option<u32>,
) -> AppResult<Vec<NoteSummary>> {
    store::search(&db, &query, limit)
}

#[tauri::command]
pub fn notes_convert_capture(
    db: State<'_, Arc<Db>>,
    capture_id: String,
) -> AppResult<ConvertResult> {
    store::convert_capture(&db, &capture_id)
}
