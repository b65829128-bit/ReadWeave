use crate::{reading::ReadingCore, reading_models::*, AppState};
use rmcp::{model::*, service::RequestContext, ErrorData, RoleServer, ServerHandler, ServiceExt};
use rusqlite::Connection;
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{ipc::Channel, State, WebviewWindow};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream, WriteHalf},
    sync::{watch, Mutex as AsyncMutex},
};

const MAX_FRAME: usize = 256 * 1024;
pub type PeerMap = Mutex<HashMap<String, Arc<ReadingMcpPeer>>>;

#[derive(Clone)]
pub struct ReadingMcpServer {
    db: Arc<Mutex<Connection>>,
    core: Arc<Mutex<ReadingCore>>,
    run_id: String,
    caller: String,
}

fn definitions() -> Vec<Tool> {
    let definitions: Vec<Value> =
        serde_json::from_str(include_str!("../../src/core/reading-tools.json"))
            .expect("Invalid bundled tool definitions");
    definitions
        .into_iter()
        .map(|item| {
            let tool = &item["function"];
            Tool::new(
                tool["name"].as_str().unwrap().to_owned(),
                tool["description"].as_str().unwrap().to_owned(),
                tool["parameters"].as_object().unwrap().clone(),
            )
            .annotate(
                ToolAnnotations::new()
                    .read_only(true)
                    .destructive(false)
                    .open_world(false),
            )
        })
        .collect()
}

impl ServerHandler for ReadingMcpServer {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("ReadWeave", env!("CARGO_PKG_VERSION")))
    }

    async fn list_tools(
        &self,
        _: Option<PaginatedRequestParams>,
        _: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        Ok(ListToolsResult::with_all_items(definitions()))
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        let result = (|| -> CoreResult<ToolResult> {
            let mut core = self.core.lock().map_err(|_| error("SERVICE_UNAVAILABLE"))?;
            let mut db = self.db.lock().map_err(|_| error("STORAGE_FAILED"))?;
            let input = Value::Object(request.arguments.unwrap_or_default());
            match request.name.as_ref() {
                "book_search" => core.search(&mut db, &self.caller, &self.run_id, input),
                "book_read_passage" => core.read(&mut db, &self.caller, &self.run_id, input),
                _ => Err(error("INVALID_ARGUMENT")),
            }
        })();
        let response = match result {
            Ok(result) => CallToolResult::success(vec![ContentBlock::text(
                serde_json::to_string(&result)
                    .map_err(|_| ErrorData::internal_error("SERIALIZATION_FAILED", None))?,
            )]),
            Err(error) => CallToolResult::error(vec![ContentBlock::text(
                serde_json::to_string(&error)
                    .unwrap_or_else(|_| "{\"code\":\"SERVICE_UNAVAILABLE\"}".into()),
            )]),
        };
        Ok(response.into())
    }
}

pub struct ReadingMcpPeer {
    writer: AsyncMutex<WriteHalf<DuplexStream>>,
    cancel: watch::Sender<bool>,
    run_id: String,
    caller: String,
    workers: AsyncMutex<Vec<tokio::task::JoinHandle<()>>>,
}

impl ReadingMcpPeer {
    pub fn open(
        db: Arc<Mutex<Connection>>,
        core: Arc<Mutex<ReadingCore>>,
        run_id: String,
        on_message: impl Fn(Value) -> bool + Send + 'static,
    ) -> CoreResult<(String, Arc<Self>)> {
        let id = opaque("mcp")?;
        let caller = format!("astrbot:{id}");
        core.lock()
            .map_err(|_| error("SERVICE_UNAVAILABLE"))?
            .delegate("host:main", &run_id, &caller)?;
        let (server_io, client_io) = tokio::io::duplex(MAX_FRAME);
        let (reader, writer) = tokio::io::split(client_io);
        let (cancel, mut server_cancel) = watch::channel(false);
        let mut reader_cancel = cancel.subscribe();
        let handler = ReadingMcpServer {
            db,
            core: core.clone(),
            run_id: run_id.clone(),
            caller: caller.clone(),
        };
        let server_worker = tokio::spawn(async move {
            let initialized = tokio::select! {
                result = handler.serve(server_io) => result,
                _ = server_cancel.changed() => return,
            };
            if let Ok(service) = initialized {
                let token = service.cancellation_token();
                let waiting = service.waiting();
                tokio::pin!(waiting);
                tokio::select! {
                    _ = &mut waiting => {},
                    _ = server_cancel.changed() => { token.cancel(); let _ = waiting.await; },
                }
            }
        });
        let cleanup_run = run_id.clone();
        let cleanup_caller = caller.clone();
        let reader_worker = tokio::spawn(async move {
            let mut reader = BufReader::new(reader);
            loop {
                let mut line = Vec::new();
                let read = tokio::select! {
                    result = reader.read_until(b'\n', &mut line) => result,
                    _ = reader_cancel.changed() => break,
                };
                if !matches!(read, Ok(count) if count > 0) || line.len() > MAX_FRAME {
                    break;
                }
                let Ok(message) = serde_json::from_slice::<Value>(&line) else {
                    break;
                };
                if !on_message(message) {
                    break;
                }
            }
            if let Ok(mut core) = core.lock() {
                let _ = core.remove_delegate("host:main", &cleanup_run, &cleanup_caller);
            }
        });
        Ok((
            id,
            Arc::new(Self {
                writer: AsyncMutex::new(writer),
                cancel,
                run_id,
                caller,
                workers: AsyncMutex::new(vec![server_worker, reader_worker]),
            }),
        ))
    }

    pub async fn send(&self, frames: Vec<Value>) -> CoreResult<()> {
        if frames.len() > 8 {
            return Err(error("INVALID_ARGUMENT"));
        }
        let mut encoded = Vec::new();
        for frame in frames {
            let mut bytes = serde_json::to_vec(&frame).map_err(|_| error("INVALID_ARGUMENT"))?;
            if bytes.len() > MAX_FRAME || frame["jsonrpc"] != "2.0" {
                return Err(error("INVALID_ARGUMENT"));
            }
            bytes.push(b'\n');
            encoded.push(bytes);
        }
        let mut writer = self.writer.lock().await;
        for bytes in encoded {
            tokio::time::timeout(Duration::from_secs(5), writer.write_all(&bytes))
                .await
                .map_err(|_| error("SERVICE_UNAVAILABLE"))?
                .map_err(|_| error("SERVICE_UNAVAILABLE"))?;
        }
        Ok(())
    }

    pub async fn close(&self, core: &Mutex<ReadingCore>) -> CoreResult<()> {
        // Remove authority before stopping transport workers.
        let result = core
            .lock()
            .map_err(|_| error("SERVICE_UNAVAILABLE"))?
            .remove_delegate("host:main", &self.run_id, &self.caller);
        let _ = self.cancel.send(true);
        for worker in self.workers.lock().await.drain(..) {
            let _ = worker.await;
        }
        result
    }
}

fn host(window: &WebviewWindow) -> CoreResult<()> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err(error("CALLER_MISMATCH"))
    }
}

#[tauri::command]
pub async fn reading_mcp_open(
    window: WebviewWindow,
    run_id: String,
    channel: Channel<Value>,
    state: State<'_, AppState>,
) -> CoreResult<String> {
    host(&window)?;
    let mut peers = state.mcp.lock().map_err(|_| error("SERVICE_UNAVAILABLE"))?;
    if peers.len() >= 4 {
        return Err(error("RUN_LIMIT"));
    }
    let (id, peer) = ReadingMcpPeer::open(
        state.db.clone(),
        state.reading.clone(),
        run_id,
        move |message| channel.send(message).is_ok(),
    )?;
    peers.insert(id.clone(), peer);
    Ok(id)
}

#[tauri::command]
pub async fn reading_mcp_send(
    window: WebviewWindow,
    peer_id: String,
    frames: Vec<Value>,
    state: State<'_, AppState>,
) -> CoreResult<()> {
    host(&window)?;
    let peer = state
        .mcp
        .lock()
        .map_err(|_| error("SERVICE_UNAVAILABLE"))?
        .get(&peer_id)
        .cloned()
        .ok_or_else(|| error("CALLER_MISMATCH"))?;
    peer.send(frames).await
}

#[tauri::command]
pub async fn reading_mcp_close(
    window: WebviewWindow,
    peer_id: String,
    state: State<'_, AppState>,
) -> CoreResult<()> {
    host(&window)?;
    let peer = state
        .mcp
        .lock()
        .map_err(|_| error("SERVICE_UNAVAILABLE"))?
        .remove(&peer_id);
    if let Some(peer) = peer {
        peer.close(&state.reading).await?;
    }
    Ok(())
}

#[tauri::command]
pub async fn reading_evidence(
    window: WebviewWindow,
    run_id: String,
    state: State<'_, AppState>,
) -> CoreResult<Vec<Fragment>> {
    host(&window)?;
    state
        .reading
        .lock()
        .map_err(|_| error("SERVICE_UNAVAILABLE"))?
        .evidence("host:main", &run_id)
}
