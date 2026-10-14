use super::*;
use crate::test_support::TestDirectory;
use serde_json::json;

const CALLER: &str = "host:main";

struct Fixture {
    db: Connection,
    core: ReadingCore,
    index: BookIndex,
    blocks: Vec<Paragraph>,
    directory: TestDirectory,
}
fn block(section: usize, ordinal: usize, text: &str, chapter: &str) -> Paragraph {
    Paragraph {
        id: format!("p_{section}_{ordinal}"),
        section_index: section,
        ordinal,
        text: text.into(),
        cfi: format!(
            "epubcfi(/6/{}!/4/2,/1:0,/1:{})",
            section * 2 + 2,
            units(text)
        ),
        chapter: chapter.into(),
    }
}
fn blocks() -> Vec<Paragraph> {
    vec![
        block(0, 0, "丞相负责政务。", "第一章"),
        block(0, 1, "中文😀é 原文。后半段是未读内容。", "第一章"),
        block(1, 2, "后文秘密。丞相在后文再次出现。", "结局秘密章节"),
    ]
}
impl Fixture {
    fn new(blocks: Vec<Paragraph>) -> Self {
        let directory = TestDirectory::new();
        let db = database::open_database(&directory.path().join("core.sqlite3")).unwrap();
        let core = ReadingCore::new(&db).unwrap();
        let raw = b"Synthetic book bytes for native service tests; no real user data.";
        let book_id = format!("{:x}", Sha256::digest(raw));
        let version = format!("sha256:{book_id}");
        std::fs::write(directory.path().join(format!("{book_id}.epub")), raw).unwrap();
        db.execute(
            "INSERT INTO records(collection,id,value) VALUES('books',?1,?2)",
            params![
                book_id,
                json!({"id": book_id, "version": version, "title": "测试书😀"}).to_string()
            ],
        )
        .unwrap();
        let index = BookIndex {
            book_id,
            book_version: version,
            transform_version: limits().transform_version.clone(),
            content_hash: String::new(),
            paragraphs: 0,
            characters: 0,
            index_status: "scan".into(),
        };
        let mut fixture = Self {
            db,
            core,
            index,
            blocks,
            directory,
        };
        fixture.index = fixture.register(fixture.blocks.clone()).unwrap();
        fixture
    }
    fn register(&mut self, blocks: Vec<Paragraph>) -> CoreResult<BookIndex> {
        self.core.register(
            &mut self.db,
            self.directory.path(),
            RegisterBook {
                book_id: self.index.book_id.clone(),
                book_version: self.index.book_version.clone(),
                transform_version: self.index.transform_version.clone(),
                paragraphs: blocks,
            },
        )
    }
    fn point(&self, ordinal: usize, offset: usize) -> ReadingPoint {
        let block = &self.blocks[ordinal];
        ReadingPoint {
            locator: Locator {
                cfi: block.cfi.clone(),
                section_index: block.section_index,
                paragraph_id: block.id.clone(),
                end_offset: offset,
                progress: 0.4,
                quote: Some(TextQuote {
                    exact: "forged future quote".into(),
                    prefix: "secret".into(),
                    suffix: "future".into(),
                }),
            },
            text: String::new(),
            is_selection: false,
        }
    }
    fn request(&self, point: ReadingPoint, scope: ReadScope) -> CreateTask {
        CreateTask {
            book_id: self.index.book_id.clone(),
            book_version: self.index.book_version.clone(),
            transform_version: self.index.transform_version.clone(),
            content_hash: self.index.content_hash.clone(),
            point,
            scope,
        }
    }
    fn create(&mut self, scope: ReadScope) -> TaskHandle {
        let mut point = self.point(1, units("中文😀é 原文。"));
        point.text = "中文😀é 原文。".into();
        point.is_selection = true;
        self.try_create(point, scope).unwrap()
    }
    fn try_create(&mut self, point: ReadingPoint, scope: ReadScope) -> CoreResult<TaskHandle> {
        let request = self.request(point, scope);
        self.core.create(&mut self.db, CALLER, request)
    }
    fn search(&mut self, run: &str, input: Value) -> CoreResult<ToolResult> {
        self.core.search(&mut self.db, CALLER, run, input)
    }
    fn read(&mut self, run: &str, input: Value) -> CoreResult<ToolResult> {
        self.core.read(&mut self.db, CALLER, run, input)
    }
}
fn code<T: std::fmt::Debug>(result: CoreResult<T>, expected: &str) {
    assert_eq!(result.unwrap_err().code, expected);
}

#[test]
fn default_snapshot_and_every_tool_respect_the_frozen_utf16_boundary() {
    let mut f = Fixture::new(blocks());
    let task = f.create(ReadScope::ToPosition);
    let snapshot = serde_json::to_string(&task.snapshot).unwrap();
    for forbidden in ["未读", "后文", "结局", "forged", "secret", "future"] {
        assert!(!snapshot.contains(forbidden), "{forbidden}");
    }
    assert_eq!(task.snapshot.locator.quote.unwrap().exact, "中文😀é 原文。");
    assert_eq!(task.snapshot.transform_version, limits().transform_version);
    assert_eq!(task.snapshot.content_hash, f.index.content_hash);
    assert!(task.snapshot.created_at.ends_with('Z'));
    let result = f.search(&task.run_id, json!({"query":"丞相"})).unwrap();
    assert_eq!(result.fragments.len(), 1);
    assert_eq!(result.fragments[0].text, "丞相负责政务。");
    assert_eq!(result.index_status, "scan");
    assert!(f
        .search(&task.run_id, json!({"query":"未读"}))
        .unwrap()
        .fragments
        .is_empty());
    assert!(f
        .read(
            &task.run_id,
            json!({"ref":task.snapshot.initial.last().unwrap().r#ref,"direction":"after"})
        )
        .unwrap()
        .fragments
        .is_empty());
    let read = f
        .read(
            &task.run_id,
            json!({"ref":task.snapshot.initial.last().unwrap().r#ref,"paragraphs":6}),
        )
        .unwrap();
    assert!(read
        .fragments
        .iter()
        .all(|x| x.label == "第一章" && !x.text.contains("未读")));
}

#[test]
fn reindexing_does_not_change_live_grants_and_corrupt_cache_is_rebuilt() {
    let mut f = Fixture::new(blocks());
    let task = f.create(ReadScope::ToPosition);
    let original = task.snapshot.initial[0].clone();
    let mut changed = f.blocks.clone();
    changed[0].text = "MUTATED".into();
    let rebuilt = f.register(changed).unwrap();
    assert_ne!(rebuilt.content_hash, f.index.content_hash);
    assert_eq!(
        f.search(&task.run_id, json!({"query":"丞相"}))
            .unwrap()
            .fragments[0]
            .text,
        original.text
    );
    code(
        f.core.resolve(
            &f.db,
            CALLER,
            &f.index.book_id,
            &f.index.book_version,
            &original.anchor_ref,
        ),
        "ANCHOR_STALE",
    );
    code(
        f.try_create(f.point(1, 2), ReadScope::Book),
        "TRANSFORM_MISMATCH",
    );
    f.index = f.register(f.blocks.clone()).unwrap();
    f.db.execute(
        "UPDATE reading_blocks SET value=replace(value,'丞相','坏缓存') WHERE ordinal=0",
        [],
    )
    .unwrap();
    code(
        f.try_create(f.point(1, 2), ReadScope::Book),
        "INDEX_NOT_READY",
    );
    f.register(f.blocks.clone()).unwrap();
    assert_eq!(
        f.search(&task.run_id, json!({"query":"丞相"}))
            .unwrap()
            .fragments[0]
            .text,
        original.text
    );
    let fresh = f.create(ReadScope::ToPosition);
    assert_eq!(fresh.snapshot.initial[0].text, original.text);
}

#[test]
fn chapter_and_book_scopes_are_deliberate_and_labels_remain_within_scope() {
    let mut f = Fixture::new(blocks());
    let chapter = f.create(ReadScope::Chapter);
    assert_eq!(
        f.search(&chapter.run_id, json!({"query":"未读"}))
            .unwrap()
            .fragments
            .len(),
        1
    );
    assert!(f
        .search(&chapter.run_id, json!({"query":"后文"}))
        .unwrap()
        .fragments
        .is_empty());
    assert!(f
        .read(
            &chapter.run_id,
            json!({"ref":chapter.snapshot.initial.last().unwrap().r#ref,"direction":"after"})
        )
        .unwrap()
        .fragments
        .is_empty());
    let book = f.create(ReadScope::Book);
    assert_eq!(
        f.search(&book.run_id, json!({"query":"后文"}))
            .unwrap()
            .fragments[0]
            .label,
        "结局秘密章节"
    );
}

#[test]
fn malformed_or_forged_host_boundaries_are_rejected() {
    let mut f = Fixture::new(blocks());
    for offset in [0, 3, units(&f.blocks[1].text) + 1] {
        code(
            f.try_create(f.point(1, offset), ReadScope::ToPosition),
            "INVALID_BOUNDARY",
        );
    }
    let mut point = f.point(1, 4);
    point.locator.section_index = 1;
    code(f.try_create(point, ReadScope::Book), "INVALID_BOUNDARY");
    let mut point = f.point(1, 4);
    point.text = "伪造的正文".into();
    point.is_selection = true;
    code(f.try_create(point, ReadScope::Book), "INVALID_BOUNDARY");
    let mut request = f.request(f.point(1, 4), ReadScope::Book);
    request.book_version = "sha256:other".into();
    code(
        f.core.create(&mut f.db, CALLER, request),
        "BOOK_VERSION_MISMATCH",
    );
    let mut request = f.request(f.point(1, 4), ReadScope::Book);
    request.transform_version = "unknown".into();
    code(
        f.core.create(&mut f.db, CALLER, request),
        "TRANSFORM_MISMATCH",
    );
    assert!(f.core.grants.is_empty());
}

#[test]
fn multi_block_selection_accepts_dom_whitespace_without_accepting_forged_text() {
    let mut f = Fixture::new(blocks());
    for text in [
        "丞相负责政务。 中文😀",
        "丞相负责政务。中文😀",
        "负责政务。中文😀",
    ] {
        let mut point = f.point(1, 4);
        point.text = text.into();
        point.is_selection = true;
        assert!(f.try_create(point, ReadScope::ToPosition).is_ok());
    }
    for text in [
        "丞相负责政务。 假内容中文😀",
        "后文秘密。 中文😀",
        "丞相负责中文😀",
    ] {
        let mut point = f.point(1, 4);
        point.text = text.into();
        point.is_selection = true;
        code(f.try_create(point, ReadScope::Book), "INVALID_BOUNDARY");
    }
}

#[test]
fn only_valid_registered_originals_and_normalized_ordered_blocks_are_accepted() {
    let mut f = Fixture::new(blocks());
    for mutation in 0..6 {
        let mut malformed = f.blocks.clone();
        match mutation {
            0 => malformed[0].ordinal = 2,
            1 => malformed[1].id = malformed[0].id.clone(),
            2 => malformed[0].text = "非  规范化".into(),
            3 => malformed[0].cfi = "file:///secret".into(),
            4 => malformed[0].section_index = 512,
            _ => malformed[0].text.clear(),
        }
        code(f.register(malformed), "INVALID_ARGUMENT");
        assert_eq!(
            f.core
                .index(&f.db, &f.index.book_id)
                .unwrap()
                .unwrap()
                .content_hash,
            f.index.content_hash
        );
    }
    std::fs::write(
        f.directory.path().join(format!("{}.epub", f.index.book_id)),
        b"changed original",
    )
    .unwrap();
    code(f.register(f.blocks.clone()), "BOOK_VERSION_MISMATCH");
    assert_eq!(normalize("\u{feff}中\u{00a0}文\n 😀\t é "), "中 文 😀 é");
    assert_eq!(normalize("中\u{0085}文"), "中\u{0085}文");
}

#[test]
fn caller_book_version_run_references_and_cursors_cannot_be_swapped() {
    let mut f = Fixture::new(blocks());
    let first = f.create(ReadScope::Book);
    let other = f.create(ReadScope::Book);
    code(
        f.core.search(
            &mut f.db,
            "model-controlled",
            &first.run_id,
            json!({"query":"丞相"}),
        ),
        "CALLER_MISMATCH",
    );
    assert_eq!(f.core.grants[&first.run_id].calls, 0);
    code(
        f.core.revoke("model-controlled", &first.run_id),
        "CALLER_MISMATCH",
    );
    code(
        f.read(
            &other.run_id,
            json!({"ref":first.snapshot.initial[0].r#ref}),
        ),
        "INVALID_REFERENCE",
    );
    for extra in ["bookId", "bookVersion", "scope", "caller", "runId"] {
        let mut input = json!({"query":"丞相"});
        input[extra] = json!("injected");
        code(f.search(&first.run_id, input), "INVALID_ARGUMENT");
    }
    let result = f
        .search(&other.run_id, json!({"query":"丞相","maxResults":1}))
        .unwrap();
    let cursor = result.next_cursor.unwrap();
    assert!(cursor.starts_with("cursor_"));
    code(
        f.search(&other.run_id, json!({"query":"别的","cursor":cursor})),
        "INVALID_REFERENCE",
    );
    let last = f
        .search(
            &other.run_id,
            json!({"query":"丞相","maxResults":1,"cursor":cursor}),
        )
        .unwrap();
    assert_eq!(last.fragments[0].label, "结局秘密章节");
    let next = f.create(ReadScope::Book);
    code(
        f.search(&next.run_id, json!({"query":"丞相","cursor":cursor})),
        "INVALID_REFERENCE",
    );
    f.db.execute("UPDATE records SET value=json_set(value,'$.version','sha256:wrong') WHERE collection='books'", []).unwrap();
    code(
        f.search(&next.run_id, json!({"query":"丞相"})),
        "BOOK_VERSION_MISMATCH",
    );
}

#[test]
fn strict_native_arguments_charge_invalid_attempts_and_cap_call_count() {
    let mut f = Fixture::new(blocks());
    let task = f.create(ReadScope::Book);
    for input in [
        json!({"query":"中","maxResults":null}),
        json!({"query":"中","maxResults":-1}),
        json!({"query":"中","cursor":null}),
        json!({"query":""}),
        json!({"query":"中","maxResults":6}),
        json!({"query":"中","maxResults":1.5}),
    ] {
        code(f.search(&task.run_id, input), "INVALID_ARGUMENT");
    }
    code(
        f.search(&task.run_id, json!({"query":"中"})),
        "BUDGET_EXCEEDED",
    );
    let task = f.create(ReadScope::Book);
    for _ in 0..limits().max_calls {
        assert!(f
            .search(&task.run_id, json!({"query":"absent"}))
            .unwrap()
            .fragments
            .is_empty());
    }
    code(
        f.search(&task.run_id, json!({"query":"中"})),
        "BUDGET_EXCEEDED",
    );
}

#[test]
fn output_budget_and_snippets_never_cut_a_surrogate_pair() {
    let mut f = Fixture::new(vec![block(0, 0, &"😀".repeat(6000), "长段落")]);
    let request = f.request(f.point(0, 12000), ReadScope::Book);
    let task = f.core.create(&mut f.db, CALLER, request).unwrap();
    assert_eq!(units(&task.snapshot.initial[0].text), 6000);
    let reference = &task.snapshot.initial[0].r#ref;
    let short = f
        .read(
            &task.run_id,
            json!({"ref":reference,"maxChars":3,"paragraphs":1}),
        )
        .unwrap();
    assert_eq!(short.fragments[0].text, "😀");
    assert!(short.truncated);
    let mut total = 2;
    for _ in 0..3 {
        total += f
            .read(
                &task.run_id,
                json!({"ref":reference,"maxChars":8000,"paragraphs":1}),
            )
            .unwrap()
            .fragments
            .iter()
            .map(|x| units(&x.text))
            .sum::<usize>();
    }
    assert_eq!(total, 24000);
    code(
        f.read(&task.run_id, json!({"ref":reference})),
        "BUDGET_EXCEEDED",
    );
    assert_eq!(snippet("中😀é文", 2, 3), ("😀e".into(), 1));
    assert_eq!(tail("中😀", 1), (String::new(), 3));
    assert_eq!(match_position("İ中文😀 ABC", "abc"), Some(6));
}

#[test]
fn revoked_expired_and_restarted_runs_cannot_read_but_evidence_survives_restart() {
    let mut f = Fixture::new(blocks());
    let revoked = f.create(ReadScope::Book);
    f.core.revoke(CALLER, &revoked.run_id).unwrap();
    f.core.revoke(CALLER, &revoked.run_id).unwrap();
    code(
        f.search(&revoked.run_id, json!({"query":"丞相"})),
        "RUN_REVOKED",
    );
    let expired = f.create(ReadScope::Book);
    f.core.grants.get_mut(&expired.run_id).unwrap().started =
        Instant::now() - Duration::from_millis(limits().ttl_ms + 1);
    code(
        f.search(&expired.run_id, json!({"query":"丞相"})),
        "RUN_EXPIRED",
    );
    let device = f.core.device_id.clone();
    f.core = ReadingCore::new(&f.db).unwrap();
    assert_eq!(f.core.device_id, device);
    code(
        f.search(&revoked.run_id, json!({"query":"丞相"})),
        "RUN_NOT_FOUND",
    );
    let anchor = &revoked.snapshot.initial[0].anchor_ref;
    let locator = f
        .core
        .resolve(
            &f.db,
            CALLER,
            &f.index.book_id,
            &f.index.book_version,
            anchor,
        )
        .unwrap()
        .unwrap();
    assert_eq!(locator.paragraph_id, f.blocks[0].id);
    code(
        f.core.resolve(
            &f.db,
            "foreign",
            &f.index.book_id,
            &f.index.book_version,
            anchor,
        ),
        "CALLER_MISMATCH",
    );
    assert!(f
        .core
        .resolve(
            &f.db,
            CALLER,
            &f.index.book_id,
            &f.index.book_version,
            "legacy_anchor"
        )
        .unwrap()
        .is_none());
}

#[test]
fn identical_quotes_have_distinct_host_issued_persistent_locations() {
    let mut f = Fixture::new(vec![
        block(0, 0, "同样的句子😀", "第一章"),
        block(0, 1, "同样的句子😀", "第一章"),
    ]);
    let request = f.request(f.point(1, units(&f.blocks[1].text)), ReadScope::Book);
    let task = f.core.create(&mut f.db, CALLER, request).unwrap();
    let result = f.search(&task.run_id, json!({"query":"同样"})).unwrap();
    assert_eq!(result.fragments.len(), 2);
    assert_ne!(
        result.fragments[0].citation_id,
        result.fragments[1].citation_id
    );
    for (i, fragment) in result.fragments.iter().enumerate() {
        let persisted: String =
            f.db.query_row(
                "SELECT fragment FROM reading_evidence WHERE citation_id=?1",
                [&fragment.citation_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Fragment>(&persisted).unwrap(),
            *fragment
        );
        let locator = f
            .core
            .resolve(
                &f.db,
                CALLER,
                &f.index.book_id,
                &f.index.book_version,
                &fragment.anchor_ref,
            )
            .unwrap()
            .unwrap();
        assert_eq!(locator.paragraph_id, f.blocks[i].id);
        assert_eq!(locator.quote.unwrap().exact, fragment.text);
        let serialized = serde_json::to_string(fragment).unwrap();
        assert!(!serialized.contains("epubcfi"));
        assert!(serialized.contains("\"ref\":"));
    }
}

#[test]
fn registration_and_issuance_are_atomic_when_storage_fails() {
    let mut f = Fixture::new(blocks());
    f.db.execute_batch("CREATE TRIGGER fail_blocks BEFORE INSERT ON reading_blocks BEGIN SELECT RAISE(ABORT,'test'); END;").unwrap();
    let mut changed = f.blocks.clone();
    changed[0].text = "changed".into();
    code(f.register(changed), "STORAGE_FAILED");
    assert_eq!(load_blocks(&f.db, &f.index.book_id).unwrap(), f.blocks);
    f.db.execute_batch("DROP TRIGGER fail_blocks; CREATE TRIGGER fail_evidence BEFORE INSERT ON reading_evidence BEGIN SELECT RAISE(ABORT,'test'); END;").unwrap();
    code(
        f.try_create(f.point(1, 2), ReadScope::Book),
        "STORAGE_FAILED",
    );
    assert!(f.core.grants.is_empty());
    assert_eq!(
        f.db.query_row::<u32, _, _>("SELECT count(*) FROM reading_snapshots", [], |row| row
            .get(0))
            .unwrap(),
        0
    );
    f.db.execute_batch("DROP TRIGGER fail_evidence;").unwrap();
    let task = f.create(ReadScope::Book);
    let refs = f.core.grants[&task.run_id].refs.len();
    f.db.execute_batch("CREATE TRIGGER fail_evidence BEFORE INSERT ON reading_evidence BEGIN SELECT RAISE(ABORT,'test'); END;").unwrap();
    code(
        f.search(&task.run_id, json!({"query":"丞相"})),
        "STORAGE_FAILED",
    );
    assert_eq!(f.core.grants[&task.run_id].refs.len(), refs);
    assert_eq!(f.core.grants[&task.run_id].emitted, 0);
}

#[test]
fn live_grants_are_bounded_and_revocation_frees_capacity() {
    let mut f = Fixture::new(blocks());
    let mut tasks = Vec::new();
    for _ in 0..limits().max_active_tasks {
        tasks.push(f.create(ReadScope::Book));
    }
    code(f.try_create(f.point(1, 2), ReadScope::Book), "RUN_LIMIT");
    f.core.revoke(CALLER, &tasks[0].run_id).unwrap();
    assert!(f.try_create(f.point(1, 2), ReadScope::Book).is_ok());
}

#[test]
fn repeated_preview_cancellation_releases_text_and_bounds_inactive_grants() {
    let mut f = Fixture::new(blocks());
    let mut oldest = String::new();
    for i in 0..limits().max_active_tasks * 3 {
        let task = f.create(ReadScope::Book);
        if i == 0 {
            oldest = task.run_id.clone();
        }
        f.core.revoke(CALLER, &task.run_id).unwrap();
        let grant = &f.core.grants[&task.run_id];
        assert!(grant.allowed.is_empty() && grant.refs.is_empty() && grant.cursors.is_empty());
        assert!(grant.snapshot.initial.is_empty() && grant.snapshot.selection.is_empty());
        assert!(f.core.grants.len() <= limits().max_active_tasks * 2);
        assert!(f
            .core
            .resolve(
                &f.db,
                CALLER,
                &f.index.book_id,
                &f.index.book_version,
                &task.snapshot.initial[0].anchor_ref
            )
            .unwrap()
            .is_some());
    }
    code(f.search(&oldest, json!({"query":"中"})), "RUN_NOT_FOUND");
}
