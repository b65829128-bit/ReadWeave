use futures_util::StreamExt;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{collections::HashMap, path::PathBuf, sync::Mutex, time::Duration};
use tauri::{ipc::Channel, Manager, State};
use tokio::sync::watch;

struct AppState {
    db: Mutex<Connection>,
    books: PathBuf,
    requests: Mutex<HashMap<String, watch::Sender<bool>>>,
}

fn check_collection(collection: &str) -> Result<(), String> {
    match collection {
        "books" | "annotations" | "conversations" | "settings" | "packs" => Ok(()),
        _ => Err("INVALID_COLLECTION".into()),
    }
}

fn check_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 160
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.')
    {
        return Err("INVALID_ID".into());
    }
    Ok(())
}

fn check_hash(key: &str) -> Result<(), String> {
    if key.len() != 64
        || !key
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return Err("INVALID_BOOK_HASH".into());
    }
    Ok(())
}

#[tauri::command]
fn records_list(
    collection: String,
    state: State<'_, AppState>,
) -> Result<Vec<serde_json::Value>, String> {
    check_collection(&collection)?;
    let db = state.db.lock().map_err(|_| "STORAGE_UNAVAILABLE")?;
    let mut stmt = db
        .prepare("SELECT value FROM records WHERE collection = ?1 ORDER BY id")
        .map_err(|_| "STORAGE_READ_FAILED")?;
    let rows = stmt
        .query_map([collection], |row| row.get::<_, String>(0))
        .map_err(|_| "STORAGE_READ_FAILED")?;
    rows.map(|row| {
        serde_json::from_str(&row.map_err(|_| "STORAGE_READ_FAILED")?)
            .map_err(|_| "STORAGE_CORRUPTED".into())
    })
    .collect()
}

#[tauri::command]
fn record_get(
    collection: String,
    id: String,
    state: State<'_, AppState>,
) -> Result<Option<serde_json::Value>, String> {
    check_collection(&collection)?;
    check_id(&id)?;
    let db = state.db.lock().map_err(|_| "STORAGE_UNAVAILABLE")?;
    let value: Option<String> = db
        .query_row(
            "SELECT value FROM records WHERE collection = ?1 AND id = ?2",
            params![collection, id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|_| "STORAGE_READ_FAILED")?;
    value
        .map(|v| serde_json::from_str(&v).map_err(|_| "STORAGE_CORRUPTED".into()))
        .transpose()
}

#[tauri::command]
fn record_put(
    collection: String,
    id: String,
    value: serde_json::Value,
    state: State<'_, AppState>,
) -> Result<(), String> {
    check_collection(&collection)?;
    check_id(&id)?;
    let value = serde_json::to_string(&value).map_err(|_| "INVALID_RECORD")?;
    if value.len() > 8 * 1024 * 1024 {
        return Err("RECORD_TOO_LARGE".into());
    }
    state.db.lock().map_err(|_| "STORAGE_UNAVAILABLE")?.execute("INSERT INTO records (collection,id,value) VALUES (?1,?2,?3) ON CONFLICT(collection,id) DO UPDATE SET value=excluded.value", params![collection,id,value]).map_err(|_| "STORAGE_WRITE_FAILED")?;
    Ok(())
}

#[tauri::command]
fn record_delete(collection: String, id: String, state: State<'_, AppState>) -> Result<(), String> {
    check_collection(&collection)?;
    check_id(&id)?;
    state
        .db
        .lock()
        .map_err(|_| "STORAGE_UNAVAILABLE")?
        .execute(
            "DELETE FROM records WHERE collection = ?1 AND id = ?2",
            params![collection, id],
        )
        .map_err(|_| "STORAGE_WRITE_FAILED")?;
    Ok(())
}

#[derive(Deserialize)]
struct RecordEntry {
    collection: String,
    id: String,
    value: serde_json::Value,
}

#[tauri::command]
fn records_merge(entries: Vec<RecordEntry>, state: State<'_, AppState>) -> Result<(), String> {
    if entries.len() > 10_000 {
        return Err("BACKUP_TOO_LARGE".into());
    }
    let mut prepared = Vec::new();
    let mut size = 0;
    for entry in entries {
        check_collection(&entry.collection)?;
        check_id(&entry.id)?;
        let value = serde_json::to_string(&entry.value).map_err(|_| "INVALID_RECORD")?;
        size += value.len();
        if value.len() > 8 * 1024 * 1024 || size > 64 * 1024 * 1024 {
            return Err("BACKUP_TOO_LARGE".into());
        }
        prepared.push((entry.collection, entry.id, value));
    }
    let mut db = state.db.lock().map_err(|_| "STORAGE_UNAVAILABLE")?;
    let transaction = db.transaction().map_err(|_| "STORAGE_WRITE_FAILED")?;
    for (collection, id, value) in prepared {
        transaction.execute("INSERT INTO records (collection,id,value) VALUES (?1,?2,?3) ON CONFLICT(collection,id) DO UPDATE SET value=excluded.value", params![collection,id,value]).map_err(|_| "STORAGE_WRITE_FAILED")?;
    }
    transaction.commit().map_err(|_| "STORAGE_WRITE_FAILED")?;
    Ok(())
}

#[tauri::command]
fn book_blob_put(key: String, bytes: Vec<u8>, state: State<'_, AppState>) -> Result<(), String> {
    check_hash(&key)?;
    if bytes.len() > 32 * 1024 * 1024 {
        return Err("BOOK_TOO_LARGE".into());
    }
    if format!("{:x}", Sha256::digest(&bytes)) != key {
        return Err("BOOK_VERSION_MISMATCH".into());
    }
    let path = state.books.join(format!("{key}.epub"));
    let temporary = state.books.join(format!("{key}.tmp"));
    std::fs::write(&temporary, bytes).map_err(|_| "BOOK_WRITE_FAILED")?;
    // Content-addressed blobs are immutable; an existing matching hash is sufficient.
    if path.exists() {
        std::fs::remove_file(temporary).map_err(|_| "BOOK_WRITE_FAILED")?;
    } else {
        std::fs::rename(temporary, path).map_err(|_| "BOOK_WRITE_FAILED")?;
    }
    Ok(())
}

#[tauri::command]
fn book_blob_get(key: String, state: State<'_, AppState>) -> Result<Vec<u8>, String> {
    check_hash(&key)?;
    std::fs::read(state.books.join(format!("{key}.epub"))).map_err(|_| "BOOK_NOT_FOUND".into())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CompletionRequest {
    request_id: String,
    endpoint: String,
    api_key: String,
    body: serde_json::Value,
}

fn check_endpoint(endpoint: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(endpoint).map_err(|_| "INVALID_ENDPOINT")?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || url.query().is_some()
    {
        return Err("INVALID_ENDPOINT".into());
    }
    let is_loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if url.scheme() != "https" && !(url.scheme() == "http" && is_loopback) {
        return Err("HTTPS_REQUIRED".into());
    }
    Ok(url)
}

#[tauri::command]
async fn completion_stream(
    request: CompletionRequest,
    channel: Channel<Vec<u8>>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    check_id(&request.request_id)?;
    let url = check_endpoint(&request.endpoint)?;
    if request.api_key.len() > 8192 || request.body.to_string().len() > 512 * 1024 {
        return Err("REQUEST_TOO_LARGE".into());
    }
    let (tx, mut cancel) = watch::channel(false);
    {
        let mut requests = state.requests.lock().map_err(|_| "NETWORK_UNAVAILABLE")?;
        if requests.len() >= 4 || requests.contains_key(&request.request_id) {
            return Err("TOO_MANY_REQUESTS".into());
        }
        requests.insert(request.request_id.clone(), tx);
    }
    let task = async {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(600))
            .build()
            .map_err(|_| "NETWORK_UNAVAILABLE")?;
        let mut builder = client
            .post(url)
            .header("Content-Type", "application/json")
            .json(&request.body);
        if !request.api_key.is_empty() {
            builder = builder.bearer_auth(&request.api_key);
        }
        let response = builder.send().await.map_err(|_| "NETWORK_REQUEST_FAILED")?;
        if !response.status().is_success() {
            return Err(format!("PROVIDER_HTTP_{}", response.status().as_u16()));
        }
        let mut stream = response.bytes_stream();
        let mut size = 0;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| "NETWORK_STREAM_FAILED")?;
            size += chunk.len();
            if size > 16 * 1024 * 1024 {
                return Err("RESPONSE_TOO_LARGE".into());
            }
            channel
                .send(chunk.to_vec())
                .map_err(|_| "CLIENT_DISCONNECTED")?;
        }
        Ok(())
    };
    let result =
        tokio::select! { value = task => value, _ = cancel.changed() => Err("CANCELLED".into()) };
    state
        .requests
        .lock()
        .map_err(|_| "NETWORK_UNAVAILABLE")?
        .remove(&request.request_id);
    result
}

#[tauri::command]
fn completion_cancel(request_id: String, state: State<'_, AppState>) -> Result<(), String> {
    if let Some(sender) = state
        .requests
        .lock()
        .map_err(|_| "NETWORK_UNAVAILABLE")?
        .get(&request_id)
    {
        let _ = sender.send(true);
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default().setup(|app| {
        let data = app.path().app_data_dir()?;
        let books = data.join("books");
        std::fs::create_dir_all(&books)?;
        let db = Connection::open(data.join("readweave.sqlite3"))?;
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS records (collection TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(collection,id)); PRAGMA user_version=1;")?;
        app.manage(AppState { db: Mutex::new(db), books, requests: Mutex::new(HashMap::new()) });
        Ok(())
    }).invoke_handler(tauri::generate_handler![records_list, record_get, record_put, record_delete, records_merge, book_blob_put, book_blob_get, completion_stream, completion_cancel])
      .run(tauri::generate_context!()).expect("ReadWeave failed to start");
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn storage_keys_cannot_escape_the_book_directory() {
        assert!(check_hash(&"a".repeat(64)).is_ok());
        for key in ["../book", "C:\\secret", "", &"A".repeat(64)] {
            assert!(check_hash(key).is_err());
        }
        assert!(check_id("../../settings").is_err());
        assert!(check_collection("credentials").is_err());
    }
    #[test]
    fn endpoints_require_tls_except_loopback_and_never_embed_credentials() {
        assert!(check_endpoint("https://example.com/v1/chat/completions").is_ok());
        assert!(check_endpoint("http://127.0.0.1:1234/v1/chat/completions").is_ok());
        for url in [
            "http://example.com/v1",
            "https://key@example.com/v1",
            "file:///secret",
            "https://example.com/v1?key=secret",
        ] {
            assert!(check_endpoint(url).is_err());
        }
    }
}
