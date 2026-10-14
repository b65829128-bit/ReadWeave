use crate::{database, reading_models::*};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    path::Path,
    time::{Duration, Instant},
};

fn storage<T>(value: rusqlite::Result<T>) -> CoreResult<T> {
    value.map_err(|_| error("STORAGE_FAILED"))
}
fn json<T: serde::Serialize>(value: &T) -> CoreResult<String> {
    serde_json::to_string(value).map_err(|_| error("INVALID_ARGUMENT"))
}
pub fn units(text: &str) -> usize {
    text.encode_utf16().count()
}
// Match the host's ECMAScript /\s+/ normalization, including BOM but excluding NEL.
fn whitespace(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000d}' | ' ' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}
fn normalize(text: &str) -> String {
    text.split(whitespace)
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}
fn byte_floor(text: &str, offset: usize) -> usize {
    let mut cursor = 0;
    for (byte, ch) in text.char_indices() {
        if cursor + ch.len_utf16() > offset {
            return byte;
        }
        cursor += ch.len_utf16();
    }
    text.len()
}
fn exact_prefix(text: &str, offset: usize) -> CoreResult<String> {
    let byte = byte_floor(text, offset);
    if units(&text[..byte]) != offset {
        return Err(error("INVALID_BOUNDARY"));
    }
    Ok(text[..byte].to_owned())
}
fn snippet(text: &str, start: usize, maximum: usize) -> (String, usize) {
    let byte = byte_floor(text, start);
    let start = units(&text[..byte]);
    let end = byte_floor(text, start.saturating_add(maximum));
    (text[byte..end].to_owned(), start)
}
fn tail(text: &str, maximum: usize) -> (String, usize) {
    let wanted = units(text).saturating_sub(maximum);
    let mut byte = byte_floor(text, wanted);
    if units(&text[..byte]) < wanted {
        byte += text[byte..].chars().next().map_or(0, char::len_utf8);
    }
    (text[byte..].to_owned(), units(&text[..byte]))
}
fn match_position(text: &str, query: &str) -> Option<usize> {
    let position = text.to_lowercase().find(query)?;
    let mut lower_bytes = 0;
    let mut original_units = 0;
    for ch in text.chars() {
        let length = ch.to_lowercase().map(char::len_utf8).sum::<usize>();
        if lower_bytes + length > position {
            return Some(original_units);
        }
        lower_bytes += length;
        original_units += ch.len_utf16();
    }
    Some(original_units)
}
fn validate_identity(book_id: &str, version: &str) -> CoreResult<()> {
    if crate::check_hash(book_id).is_err() || version != format!("sha256:{book_id}") {
        return Err(error("BOOK_VERSION_MISMATCH"));
    }
    Ok(())
}
fn book_title(db: &Connection, book_id: &str, version: &str) -> CoreResult<String> {
    validate_identity(book_id, version)?;
    let value: Option<String> = storage(
        db.query_row(
            "SELECT value FROM records WHERE collection='books' AND id=?1",
            [book_id],
            |row| row.get(0),
        )
        .optional(),
    )?;
    let record: Value = serde_json::from_str(&value.ok_or_else(|| error("BOOK_VERSION_MISMATCH"))?)
        .map_err(|_| error("BOOK_VERSION_MISMATCH"))?;
    if record["id"].as_str() != Some(book_id) || record["version"].as_str() != Some(version) {
        return Err(error("BOOK_VERSION_MISMATCH"));
    }
    let title = record["title"]
        .as_str()
        .ok_or_else(|| error("BOOK_VERSION_MISMATCH"))?;
    if units(title) > 300 {
        return Err(error("INVALID_ARGUMENT"));
    }
    Ok(title.to_owned())
}
fn load_blocks(db: &Connection, book_id: &str) -> CoreResult<Vec<Paragraph>> {
    let mut statement =
        storage(db.prepare("SELECT value FROM reading_blocks WHERE book_id=?1 ORDER BY ordinal"))?;
    let rows = storage(statement.query_map([book_id], |row| row.get::<_, String>(0)))?;
    rows.map(|row| serde_json::from_str(&storage(row)?).map_err(|_| error("STORAGE_FAILED")))
        .collect()
}
fn content_hash(
    book_version: &str,
    transform_version: &str,
    blocks: &[Paragraph],
) -> CoreResult<String> {
    let mut digest = Sha256::new();
    digest.update(book_version.as_bytes());
    digest.update(transform_version.as_bytes());
    for block in blocks {
        digest.update(json(block)?.as_bytes());
        digest.update(b"\n");
    }
    Ok(format!("{:x}", digest.finalize()))
}
fn selection_matches(
    blocks: &[Paragraph],
    boundary: &Paragraph,
    prefix: &str,
    selection: &str,
) -> bool {
    let mut rest = selection;
    for block in blocks
        .iter()
        .rev()
        .filter(|p| p.section_index == boundary.section_index && p.ordinal <= boundary.ordinal)
    {
        let text = if block.id == boundary.id {
            prefix
        } else {
            &block.text
        };
        if text.ends_with(rest) {
            return true;
        }
        let Some(previous) = rest.strip_suffix(text) else {
            return false;
        };
        // DOM ranges may join adjacent block elements with or without whitespace.
        rest = previous.strip_suffix(' ').unwrap_or(previous);
    }
    rest.is_empty()
}

pub struct ReadingCore {
    device_id: String,
    grants: HashMap<String, Grant>,
}
struct Grant {
    run_id: String,
    device_id: String,
    caller: String,
    snapshot: Snapshot,
    allowed: Vec<Paragraph>,
    started: Instant,
    revoked: bool,
    calls: usize,
    emitted: usize,
    refs: HashMap<String, usize>,
    cursors: HashMap<String, (String, usize)>,
    evidence: Vec<Fragment>,
}
struct Spec {
    index: usize,
    text: String,
    start: usize,
}
struct Issued {
    index: usize,
    fragment: Fragment,
    locator: Locator,
}

impl ReadingCore {
    pub fn new(db: &Connection) -> CoreResult<Self> {
        Ok(Self {
            device_id: database::device_id(db)?,
            grants: HashMap::new(),
        })
    }

    pub fn register(
        &self,
        db: &mut Connection,
        books: &Path,
        request: RegisterBook,
    ) -> CoreResult<BookIndex> {
        book_title(db, &request.book_id, &request.book_version)?;
        if request.transform_version != limits().transform_version {
            return Err(error("TRANSFORM_MISMATCH"));
        }
        let raw = std::fs::read(books.join(format!("{}.epub", request.book_id)))
            .map_err(|_| error("BOOK_VERSION_MISMATCH"))?;
        if raw.len() > 32 * 1024 * 1024 || format!("{:x}", Sha256::digest(&raw)) != request.book_id
        {
            return Err(error("BOOK_VERSION_MISMATCH"));
        }
        if request.paragraphs.is_empty() || request.paragraphs.len() > limits().max_blocks {
            return Err(error("INVALID_ARGUMENT"));
        }
        let mut seen = HashSet::new();
        let mut section = 0;
        let mut characters = 0;
        for (ordinal, block) in request.paragraphs.iter().enumerate() {
            let prefix = format!("p_{}_", block.section_index);
            let valid_id = block
                .id
                .strip_prefix(&prefix)
                .is_some_and(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()));
            let count = units(&block.text);
            if block.ordinal != ordinal
                || block.section_index < section
                || block.section_index >= limits().max_sections
                || !valid_id
                || !seen.insert(&block.id)
                || count == 0
                || count > limits().max_block_units
                || normalize(&block.text) != block.text
                || units(&block.chapter) > 500
                || block.cfi.len() > 4096
                || !block.cfi.starts_with("epubcfi(")
                || !block.cfi.ends_with(')')
                || block.cfi.chars().any(char::is_control)
            {
                return Err(error("INVALID_ARGUMENT"));
            }
            characters += count;
            if characters > limits().max_text_units {
                return Err(error("INVALID_ARGUMENT"));
            }
            section = block.section_index;
        }
        let index = BookIndex {
            book_id: request.book_id.clone(),
            content_hash: content_hash(
                &request.book_version,
                &request.transform_version,
                &request.paragraphs,
            )?,
            book_version: request.book_version,
            transform_version: request.transform_version,
            paragraphs: request.paragraphs.len(),
            characters,
            index_status: "scan".into(),
        };
        if self.index(db, &index.book_id)?.is_some_and(|previous| {
            previous.content_hash == index.content_hash
                && previous.transform_version == index.transform_version
        }) && load_blocks(db, &index.book_id).is_ok_and(|blocks| {
            blocks.len() == index.paragraphs
                && content_hash(&index.book_version, &index.transform_version, &blocks)
                    .is_ok_and(|hash| hash == index.content_hash)
        }) {
            return Ok(index);
        }
        let tx = storage(db.transaction())?;
        storage(tx.execute(
            "DELETE FROM reading_blocks WHERE book_id=?1",
            [&index.book_id],
        ))?;
        {
            let mut insert = storage(tx.prepare("INSERT INTO reading_blocks(book_id,paragraph_id,ordinal,value) VALUES(?1,?2,?3,?4)"))?;
            for block in request.paragraphs {
                storage(insert.execute(params![
                    index.book_id,
                    block.id,
                    block.ordinal as i64,
                    json(&block)?
                ]))?;
            }
        }
        storage(tx.execute("INSERT INTO reading_books(book_id,book_version,transform_version,content_hash,block_count,utf16_units) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(book_id) DO UPDATE SET book_version=excluded.book_version,transform_version=excluded.transform_version,content_hash=excluded.content_hash,block_count=excluded.block_count,utf16_units=excluded.utf16_units", params![index.book_id,index.book_version,index.transform_version,index.content_hash,index.paragraphs as i64,index.characters as i64]))?;
        storage(tx.commit())?;
        Ok(index)
    }

    pub fn index(&self, db: &Connection, book_id: &str) -> CoreResult<Option<BookIndex>> {
        storage(db.query_row("SELECT book_version,transform_version,content_hash,block_count,utf16_units FROM reading_books WHERE book_id=?1", [book_id], |row| Ok(BookIndex { book_id: book_id.to_owned(), book_version: row.get(0)?, transform_version: row.get(1)?, content_hash: row.get(2)?, paragraphs: row.get::<_, u32>(3)? as usize, characters: row.get::<_, u32>(4)? as usize, index_status: "scan".into() })).optional())
    }

    pub fn create(
        &mut self,
        db: &mut Connection,
        caller: &str,
        request: CreateTask,
    ) -> CoreResult<TaskHandle> {
        let title = book_title(db, &request.book_id, &request.book_version)?;
        let index = self
            .index(db, &request.book_id)?
            .ok_or_else(|| error("INDEX_NOT_READY"))?;
        if index.book_version != request.book_version {
            return Err(error("BOOK_VERSION_MISMATCH"));
        }
        if index.transform_version != request.transform_version
            || index.content_hash != request.content_hash
            || request.transform_version != limits().transform_version
        {
            return Err(error("TRANSFORM_MISMATCH"));
        }
        self.grants.retain(|_, grant| {
            if grant.started.elapsed() > Duration::from_millis(limits().ttl_ms) {
                grant.release_text();
            }
            grant.started.elapsed() < Duration::from_millis(limits().ttl_ms * 2)
        });
        if self
            .grants
            .values()
            .filter(|g| !g.revoked && g.started.elapsed() <= Duration::from_millis(limits().ttl_ms))
            .count()
            >= limits().max_active_tasks
        {
            return Err(error("RUN_LIMIT"));
        }
        while self.grants.len() >= limits().max_active_tasks * 2 {
            let oldest = self
                .grants
                .iter()
                .filter(|(_, g)| {
                    g.revoked || g.started.elapsed() > Duration::from_millis(limits().ttl_ms)
                })
                .min_by_key(|(_, g)| g.started)
                .map(|(id, _)| id.clone());
            if let Some(id) = oldest {
                self.grants.remove(&id);
            } else {
                break;
            }
        }
        let blocks = load_blocks(db, &request.book_id)?;
        if blocks.len() != index.paragraphs
            || content_hash(&index.book_version, &index.transform_version, &blocks)?
                != index.content_hash
        {
            return Err(error("INDEX_NOT_READY"));
        }
        let point = &request.point;
        let boundary = blocks
            .iter()
            .find(|p| p.id == point.locator.paragraph_id)
            .ok_or_else(|| error("INVALID_BOUNDARY"))?;
        if boundary.section_index != point.locator.section_index
            || point.locator.end_offset == 0
            || !point.locator.progress.is_finite()
            || !(0.0..=1.0).contains(&point.locator.progress)
            || point.locator.cfi.len() > 4096
            || !point.locator.cfi.starts_with("epubcfi(")
            || !point.locator.cfi.ends_with(')')
            || point.locator.cfi.chars().any(char::is_control)
            || units(&point.text) > 64_000
        {
            return Err(error("INVALID_BOUNDARY"));
        }
        let boundary_prefix = exact_prefix(&boundary.text, point.locator.end_offset)?;
        if point.is_selection
            && (point.text.is_empty()
                || normalize(&point.text) != point.text
                || !selection_matches(&blocks, boundary, &boundary_prefix, &point.text))
        {
            return Err(error("INVALID_BOUNDARY"));
        }
        let selected = if point.is_selection {
            snippet(&point.text, 0, limits().max_initial_units).0
        } else {
            String::new()
        };
        let mut locator = point.locator.clone();
        locator.quote = Some(TextQuote {
            exact: if point.is_selection {
                snippet(&point.text, 0, 240).0
            } else {
                tail(&boundary_prefix, 240).0
            },
            prefix: String::new(),
            suffix: String::new(),
        });
        let snapshot = Snapshot {
            id: opaque("snap")?,
            book_id: request.book_id,
            book_version: request.book_version,
            book_title: title,
            transform_version: request.transform_version,
            content_hash: request.content_hash,
            chapter: boundary.chapter.clone(),
            created_at: now_iso()?,
            scope: request.scope,
            locator,
            selection: selected,
            initial: Vec::new(),
        };
        let mut allowed: Vec<Paragraph> = blocks
            .iter()
            .filter(|p| match request.scope {
                ReadScope::Book => true,
                ReadScope::Chapter => p.section_index == boundary.section_index,
                ReadScope::ToPosition => p.ordinal <= boundary.ordinal,
            })
            .cloned()
            .collect();
        if request.scope == ReadScope::ToPosition {
            if let Some(last) = allowed.last_mut() {
                last.text = boundary_prefix;
            }
        }
        let mut grant = Grant {
            run_id: opaque("run")?,
            device_id: self.device_id.clone(),
            caller: caller.to_owned(),
            snapshot,
            allowed,
            started: Instant::now(),
            revoked: false,
            calls: 0,
            emitted: 0,
            refs: HashMap::new(),
            cursors: HashMap::new(),
            evidence: Vec::new(),
        };
        let mut near: Vec<usize> = grant
            .allowed
            .iter()
            .enumerate()
            .filter(|(_, p)| {
                p.section_index == boundary.section_index && p.ordinal <= boundary.ordinal
            })
            .map(|(i, _)| i)
            .collect();
        if near.len() > 4 {
            near.drain(..near.len() - 4);
        }
        let mut remaining = limits().max_initial_units;
        let mut specs = Vec::new();
        for i in near.into_iter().rev() {
            if remaining == 0 {
                break;
            }
            let (text, start) = tail(&grant.allowed[i].text, remaining);
            remaining -= units(&text);
            if !text.is_empty() {
                specs.push(Spec {
                    index: i,
                    text,
                    start,
                });
            }
        }
        specs.reverse();
        let issued = grant.prepare(specs)?;
        grant.snapshot.initial = issued.iter().map(|i| i.fragment.clone()).collect();
        grant.persist(db, &issued, true)?;
        grant.record(issued);
        let handle = TaskHandle {
            run_id: grant.run_id.clone(),
            snapshot: grant.snapshot.clone(),
        };
        self.grants.insert(handle.run_id.clone(), grant);
        Ok(handle)
    }

    fn access(&mut self, db: &Connection, caller: &str, run_id: &str) -> CoreResult<&mut Grant> {
        let grant = self
            .grants
            .get_mut(run_id)
            .ok_or_else(|| error("RUN_NOT_FOUND"))?;
        if grant.caller != caller || grant.device_id != self.device_id {
            return Err(error("CALLER_MISMATCH"));
        }
        if grant.revoked {
            return Err(error("RUN_REVOKED"));
        }
        if grant.started.elapsed() > Duration::from_millis(limits().ttl_ms) {
            grant.release_text();
            return Err(error("RUN_EXPIRED"));
        }
        book_title(db, &grant.snapshot.book_id, &grant.snapshot.book_version)?;
        grant.calls += 1;
        if grant.calls > limits().max_calls || grant.emitted >= limits().max_output_units {
            return Err(error("BUDGET_EXCEEDED"));
        }
        Ok(grant)
    }

    pub fn search(
        &mut self,
        db: &mut Connection,
        caller: &str,
        run_id: &str,
        input: Value,
    ) -> CoreResult<ToolResult> {
        let grant = self.access(db, caller, run_id)?;
        let input: SearchInput =
            serde_json::from_value(input).map_err(|_| error("INVALID_ARGUMENT"))?;
        let query = input.query.trim_matches(whitespace).to_owned();
        let maximum = input.max_results.unwrap_or(5);
        if query.is_empty() || units(&query) > 160 || !(1..=5).contains(&maximum) {
            return Err(error("INVALID_ARGUMENT"));
        }
        let offset = match input.cursor {
            Some(cursor) => {
                if cursor.len() > 100 {
                    return Err(error("INVALID_ARGUMENT"));
                }
                let (original, offset) = grant
                    .cursors
                    .get(&cursor)
                    .ok_or_else(|| error("INVALID_REFERENCE"))?;
                if original != &query {
                    return Err(error("INVALID_REFERENCE"));
                }
                *offset
            }
            None => 0,
        };
        let lower = query.to_lowercase();
        let matches: Vec<(usize, usize)> = grant
            .allowed
            .iter()
            .enumerate()
            .filter_map(|(i, p)| match_position(&p.text, &lower).map(|position| (i, position)))
            .collect();
        let mut remaining = 6000.min(limits().max_output_units - grant.emitted);
        let mut specs = Vec::new();
        let mut long = false;
        for &(index, position) in matches.iter().skip(offset).take(maximum) {
            let (text, start) = snippet(
                &grant.allowed[index].text,
                position.saturating_sub(120),
                1000.min(remaining),
            );
            if text.is_empty() {
                break;
            }
            remaining -= units(&text);
            long |= units(&grant.allowed[index].text) > 1000;
            specs.push(Spec { index, text, start });
        }
        let has_more = offset + specs.len() < matches.len();
        let next = if has_more {
            Some(opaque("cursor")?)
        } else {
            None
        };
        if let Some(ref cursor) = next {
            grant
                .cursors
                .insert(cursor.clone(), (query, offset + specs.len()));
        }
        grant.finish(db, specs, has_more || long, next)
    }

    pub fn read(
        &mut self,
        db: &mut Connection,
        caller: &str,
        run_id: &str,
        input: Value,
    ) -> CoreResult<ToolResult> {
        let grant = self.access(db, caller, run_id)?;
        let input: ReadInput =
            serde_json::from_value(input).map_err(|_| error("INVALID_ARGUMENT"))?;
        let count = input.paragraphs.unwrap_or(3);
        let maximum = input.max_chars.unwrap_or(6000);
        let direction = input.direction.as_deref().unwrap_or("around");
        if input.r#ref.is_empty()
            || input.r#ref.len() > 100
            || !(1..=6).contains(&count)
            || !(1..=8000).contains(&maximum)
            || !["around", "before", "after"].contains(&direction)
        {
            return Err(error("INVALID_ARGUMENT"));
        }
        let index = *grant
            .refs
            .get(&input.r#ref)
            .ok_or_else(|| error("INVALID_REFERENCE"))?;
        let start = match direction {
            "before" => index.saturating_sub(count),
            "after" => index + 1,
            _ => index.saturating_sub(count / 2),
        };
        let end = if direction == "before" {
            index
        } else {
            (start + count).min(grant.allowed.len())
        };
        let mut remaining = maximum.min(limits().max_output_units - grant.emitted);
        let mut specs = Vec::new();
        let mut truncated = false;
        for index in start..end {
            let (text, _) = snippet(&grant.allowed[index].text, 0, remaining);
            truncated |= units(&text) < units(&grant.allowed[index].text);
            remaining -= units(&text);
            if !text.is_empty() {
                specs.push(Spec {
                    index,
                    text,
                    start: 0,
                });
            }
        }
        grant.finish(db, specs, truncated, None)
    }

    pub fn revoke(&mut self, caller: &str, run_id: &str) -> CoreResult<()> {
        let grant = self
            .grants
            .get_mut(run_id)
            .ok_or_else(|| error("RUN_NOT_FOUND"))?;
        if grant.caller != caller || grant.device_id != self.device_id {
            return Err(error("CALLER_MISMATCH"));
        }
        grant.revoked = true;
        grant.release_text();
        Ok(())
    }

    pub fn resolve(
        &self,
        db: &Connection,
        caller: &str,
        book_id: &str,
        book_version: &str,
        anchor: &str,
    ) -> CoreResult<Option<Locator>> {
        book_title(db, book_id, book_version)?;
        type StoredAnchor = (String, String, String, String, String, String, String);
        let stored: Option<StoredAnchor> = storage(db.query_row("SELECT device_id,caller_id,book_id,book_version,transform_version,content_hash,locator FROM reading_evidence WHERE anchor_ref=?1", [anchor], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,row.get(6)?))).optional())?;
        let Some((device, owner, original_book, original_version, transform, hash, locator)) =
            stored
        else {
            return Ok(None);
        };
        if device != self.device_id || owner != caller {
            return Err(error("CALLER_MISMATCH"));
        }
        if original_book != book_id || original_version != book_version {
            return Err(error("BOOK_VERSION_MISMATCH"));
        }
        if !self
            .index(db, book_id)?
            .is_some_and(|index| index.content_hash == hash && index.transform_version == transform)
        {
            return Err(error("ANCHOR_STALE"));
        }
        serde_json::from_str(&locator)
            .map(Some)
            .map_err(|_| error("STORAGE_FAILED"))
    }
}

#[cfg(test)]
#[path = "reading_tests.rs"]
mod tests;

impl Grant {
    fn release_text(&mut self) {
        self.allowed = Vec::new();
        self.refs = HashMap::new();
        self.cursors = HashMap::new();
        self.evidence = Vec::new();
        self.snapshot.initial = Vec::new();
        self.snapshot.selection = String::new();
    }
    fn prepare(&self, specs: Vec<Spec>) -> CoreResult<Vec<Issued>> {
        specs
            .into_iter()
            .map(|spec| {
                let paragraph = &self.allowed[spec.index];
                Ok(Issued {
                    index: spec.index,
                    fragment: Fragment {
                        citation_id: opaque("cite")?,
                        r#ref: opaque("passage")?,
                        text: spec.text.clone(),
                        label: paragraph.chapter.clone(),
                        anchor_ref: opaque("anchor")?,
                    },
                    locator: Locator {
                        cfi: paragraph.cfi.clone(),
                        section_index: paragraph.section_index,
                        paragraph_id: paragraph.id.clone(),
                        end_offset: spec.start + units(&spec.text),
                        progress: 0.0,
                        quote: Some(TextQuote {
                            exact: snippet(&spec.text, 0, 240).0,
                            prefix: String::new(),
                            suffix: String::new(),
                        }),
                    },
                })
            })
            .collect()
    }
    fn persist(&self, db: &mut Connection, issued: &[Issued], create: bool) -> CoreResult<()> {
        let tx = storage(db.transaction())?;
        if create {
            storage(tx.execute("INSERT INTO reading_snapshots(id,run_id,device_id,caller_id,book_id,book_version,transform_version,content_hash,value) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)", params![self.snapshot.id,self.run_id,self.device_id,self.caller,self.snapshot.book_id,self.snapshot.book_version,self.snapshot.transform_version,self.snapshot.content_hash,json(&self.snapshot)?]))?;
        }
        for item in issued {
            storage(tx.execute("INSERT INTO reading_evidence(anchor_ref,citation_id,snapshot_id,device_id,caller_id,book_id,book_version,transform_version,content_hash,fragment,locator) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)", params![item.fragment.anchor_ref,item.fragment.citation_id,self.snapshot.id,self.device_id,self.caller,self.snapshot.book_id,self.snapshot.book_version,self.snapshot.transform_version,self.snapshot.content_hash,json(&item.fragment)?,json(&item.locator)?]))?;
        }
        storage(tx.commit())
    }
    fn record(&mut self, issued: Vec<Issued>) {
        for item in issued {
            self.refs.insert(item.fragment.r#ref.clone(), item.index);
            self.evidence.push(item.fragment);
        }
    }
    fn finish(
        &mut self,
        db: &mut Connection,
        specs: Vec<Spec>,
        truncated: bool,
        next_cursor: Option<String>,
    ) -> CoreResult<ToolResult> {
        let issued = self.prepare(specs)?;
        self.persist(db, &issued, false)?;
        let fragments: Vec<Fragment> = issued.iter().map(|i| i.fragment.clone()).collect();
        self.emitted += fragments.iter().map(|f| units(&f.text)).sum::<usize>();
        self.record(issued);
        Ok(ToolResult {
            schema_version: limits().schema_version,
            snapshot_id: self.snapshot.id.clone(),
            book_version: self.snapshot.book_version.clone(),
            fragments,
            truncated,
            next_cursor,
            index_status: "scan".into(),
        })
    }
}
