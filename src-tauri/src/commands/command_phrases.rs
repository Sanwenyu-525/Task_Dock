//! 句式命令命令层：只做参数收敛与转发，解析与查询在 `crate::command_phrases`。

use std::sync::Arc;

use tauri::State;

use crate::command_phrases::{resolve, PhraseResolution};
use crate::db::Db;
use crate::error::AppResult;

#[tauri::command]
pub fn resolve_command_phrase(
    db: State<'_, Arc<Db>>,
    input: String,
) -> AppResult<Option<PhraseResolution>> {
    resolve(&db, &input)
}
