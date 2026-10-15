use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct CoreError {
    pub code: &'static str,
    pub message: &'static str,
}
pub type CoreResult<T> = Result<T, CoreError>;
pub fn error(code: &'static str) -> CoreError {
    let message = match code {
        "BOOK_VERSION_MISMATCH" => "书籍版本不一致，请重新打开对应的原书。",
        "INDEX_NOT_READY" => "原文尚未登记，请重新打开书籍。",
        "TRANSFORM_MISMATCH" => "正文变换版本或指纹不一致，请重新打开书籍。",
        "INVALID_ARGUMENT" => "书内服务参数无效。",
        "INVALID_BOUNDARY" => "阅读边界无效，请重新选择原文。",
        "CALLER_MISMATCH" => "此调用身份未获得本次读取授权。",
        "RUN_NOT_FOUND" => "本次读取授权已失效，请开始新话题。",
        "RUN_REVOKED" => "本次任务已取消，读取授权已撤销。",
        "RUN_EXPIRED" => "本次读取授权已过期，请开始新话题。",
        "RUN_LIMIT" => "同时进行的阅读任务过多，请先结束已有任务。",
        "BUDGET_EXCEEDED" => "已达到本轮取证上限。请基于已有原文回答。",
        "INVALID_REFERENCE" => "引用或游标不属于本次任务。",
        "ANCHOR_STALE" => "引用定位资料已失效，请核对对应的书籍版本。",
        "EVIDENCE_MISMATCH" => "引用内容与已保存的原文记录不一致，请核对备份。",
        "SCHEMA_TOO_NEW" => "数据库由更新版本创建，请使用相应版本打开。",
        "MIGRATION_BACKUP_FAILED" => "升级前备份失败，数据库升级已停止。",
        "STORAGE_CORRUPTED" => "本地数据库校验失败，现有文件已保留。请先备份，再修复数据库。",
        "STORAGE_FULL" => "设备存储空间不足，暂时无法保存阅读数据。",
        "STORAGE_READ_ONLY" => "无法写入本地数据库，请检查应用数据目录的权限。",
        "STORAGE_BUSY" => "本地数据库正被占用，请关闭其他 ReadWeave 窗口后重试。",
        "STORAGE_FAILED" => "阅读数据保存失败，请重新打开书籍；若仍失败，请保留数据目录以便排查。",
        _ => "原生阅读服务暂不可用。",
    };
    CoreError { code, message }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Limits {
    pub schema_version: u32,
    pub transform_version: String,
    pub max_blocks: usize,
    pub max_sections: usize,
    pub max_text_units: usize,
    pub max_block_units: usize,
    pub max_calls: usize,
    pub max_output_units: usize,
    pub max_initial_units: usize,
    pub ttl_ms: u64,
    pub max_active_tasks: usize,
}
pub fn limits() -> &'static Limits {
    static LIMITS: OnceLock<Limits> = OnceLock::new();
    LIMITS.get_or_init(|| {
        serde_json::from_str(include_str!("../../src/core/reading-contract.json"))
            .expect("Invalid bundled reading contract")
    })
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Paragraph {
    pub id: String,
    pub section_index: usize,
    pub ordinal: usize,
    pub text: String,
    pub cfi: String,
    pub chapter: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct TextQuote {
    pub exact: String,
    pub prefix: String,
    pub suffix: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Locator {
    pub cfi: String,
    pub section_index: usize,
    pub paragraph_id: String,
    pub end_offset: usize,
    pub progress: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quote: Option<TextQuote>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadingPoint {
    pub locator: Locator,
    pub text: String,
    pub is_selection: bool,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum ReadScope {
    ToPosition,
    Chapter,
    Book,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Fragment {
    pub citation_id: String,
    pub r#ref: String,
    pub text: String,
    pub label: String,
    pub anchor_ref: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Snapshot {
    pub id: String,
    pub book_id: String,
    pub book_version: String,
    pub book_title: String,
    pub transform_version: String,
    pub content_hash: String,
    pub chapter: String,
    pub created_at: String,
    pub scope: ReadScope,
    pub locator: Locator,
    pub selection: String,
    pub initial: Vec<Fragment>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BookIndex {
    pub book_id: String,
    pub book_version: String,
    pub transform_version: String,
    pub content_hash: String,
    pub paragraphs: usize,
    pub characters: usize,
    pub index_status: String,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskHandle {
    pub run_id: String,
    pub snapshot: Snapshot,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolResult {
    pub schema_version: u32,
    pub snapshot_id: String,
    pub book_version: String,
    pub fragments: Vec<Fragment>,
    pub truncated: bool,
    pub next_cursor: Option<String>,
    pub index_status: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RegisterBook {
    pub book_id: String,
    pub book_version: String,
    pub transform_version: String,
    pub paragraphs: Vec<Paragraph>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateTask {
    pub book_id: String,
    pub book_version: String,
    pub transform_version: String,
    pub content_hash: String,
    pub point: ReadingPoint,
    pub scope: ReadScope,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SearchInput {
    pub query: String,
    #[serde(default, deserialize_with = "optional")]
    pub max_results: Option<usize>,
    #[serde(default, deserialize_with = "optional")]
    pub cursor: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadInput {
    pub r#ref: String,
    #[serde(default, deserialize_with = "optional")]
    pub direction: Option<String>,
    #[serde(default, deserialize_with = "optional")]
    pub paragraphs: Option<usize>,
    #[serde(default, deserialize_with = "optional")]
    pub max_chars: Option<usize>,
}

fn optional<'de, T: Deserialize<'de>, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<T>, D::Error> {
    T::deserialize(deserializer).map(Some)
}

pub fn opaque(prefix: &str) -> CoreResult<String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| error("SERVICE_UNAVAILABLE"))?;
    Ok(format!(
        "{prefix}_{}",
        bytes.iter().map(|b| format!("{b:02x}")).collect::<String>()
    ))
}
pub fn now_iso() -> CoreResult<String> {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .map_err(|_| error("SERVICE_UNAVAILABLE"))
}
