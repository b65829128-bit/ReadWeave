use crate::{reading_models::*, AppState};
use serde_json::Value;
use tauri::{State, WebviewWindow};

// Caller identity comes from the native dispatcher, never from a model argument.
fn caller(window: &WebviewWindow) -> CoreResult<&'static str> {
    if window.label() == "main" {
        Ok("host:main")
    } else {
        Err(error("CALLER_MISMATCH"))
    }
}

#[tauri::command]
pub async fn reading_register_book(
    window: WebviewWindow,
    request: RegisterBook,
    state: State<'_, AppState>,
) -> CoreResult<BookIndex> {
    caller(&window)?;
    let core = state
        .reading
        .lock()
        .map_err(|_| error("SERVICE_UNAVAILABLE"))?;
    let mut db = state.db.lock().map_err(|_| error("STORAGE_FAILED"))?;
    core.register(&mut db, &state.books, request)
}
#[tauri::command]
pub async fn reading_create_task(
    window: WebviewWindow,
    request: CreateTask,
    state: State<'_, AppState>,
) -> CoreResult<TaskHandle> {
    let caller = caller(&window)?;
    let mut core = state
        .reading
        .lock()
        .map_err(|_| error("SERVICE_UNAVAILABLE"))?;
    let mut db = state.db.lock().map_err(|_| error("STORAGE_FAILED"))?;
    core.create(&mut db, caller, request)
}
#[tauri::command]
pub async fn reading_search(
    window: WebviewWindow,
    run_id: String,
    input: Value,
    state: State<'_, AppState>,
) -> CoreResult<ToolResult> {
    let caller = caller(&window)?;
    let mut core = state
        .reading
        .lock()
        .map_err(|_| error("SERVICE_UNAVAILABLE"))?;
    let mut db = state.db.lock().map_err(|_| error("STORAGE_FAILED"))?;
    core.search(&mut db, caller, &run_id, input)
}
#[tauri::command]
pub async fn reading_read(
    window: WebviewWindow,
    run_id: String,
    input: Value,
    state: State<'_, AppState>,
) -> CoreResult<ToolResult> {
    let caller = caller(&window)?;
    let mut core = state
        .reading
        .lock()
        .map_err(|_| error("SERVICE_UNAVAILABLE"))?;
    let mut db = state.db.lock().map_err(|_| error("STORAGE_FAILED"))?;
    core.read(&mut db, caller, &run_id, input)
}
#[tauri::command]
pub async fn reading_revoke_task(
    window: WebviewWindow,
    run_id: String,
    state: State<'_, AppState>,
) -> CoreResult<()> {
    let caller = caller(&window)?;
    state
        .reading
        .lock()
        .map_err(|_| error("SERVICE_UNAVAILABLE"))?
        .revoke(caller, &run_id)
}
#[tauri::command]
pub async fn reading_resolve_anchor(
    window: WebviewWindow,
    book_id: String,
    book_version: String,
    anchor_ref: String,
    state: State<'_, AppState>,
) -> CoreResult<Option<Locator>> {
    let caller = caller(&window)?;
    let core = state
        .reading
        .lock()
        .map_err(|_| error("SERVICE_UNAVAILABLE"))?;
    let db = state.db.lock().map_err(|_| error("STORAGE_FAILED"))?;
    core.resolve(&db, caller, &book_id, &book_version, &anchor_ref)
}
