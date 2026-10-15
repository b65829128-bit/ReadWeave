use crate::reading_models::{error, opaque, CoreResult};
use rusqlite::{Connection, TransactionBehavior};
use std::{path::Path, time::Duration};

pub const DATABASE_VERSION: u32 = 2;

pub fn storage_error(failure: rusqlite::Error) -> crate::reading_models::CoreError {
    use rusqlite::ErrorCode;
    let code = match failure.sqlite_error_code() {
        Some(ErrorCode::DatabaseCorrupt | ErrorCode::NotADatabase) => "STORAGE_CORRUPTED",
        Some(ErrorCode::DiskFull) => "STORAGE_FULL",
        Some(ErrorCode::ReadOnly | ErrorCode::PermissionDenied) => "STORAGE_READ_ONLY",
        Some(ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked) => "STORAGE_BUSY",
        _ => "STORAGE_FAILED",
    };
    error(code)
}

fn check_integrity(db: &Connection) -> CoreResult<()> {
    let mut statement = db.prepare("PRAGMA quick_check").map_err(storage_error)?;
    let results = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(storage_error)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(storage_error)?;
    if results != ["ok"] {
        return Err(error("STORAGE_CORRUPTED"));
    }
    Ok(())
}

pub fn open_database(path: &Path) -> CoreResult<Connection> {
    let existing = path.exists();
    // Windows can redirect an existing AppData file without redirecting its
    // sibling WAL/SHM files. Resolve the file first so SQLite keeps one physical
    // database and its sidecars together, including during migration/backup.
    let resolved = if existing {
        Some(path.canonicalize().map_err(|_| error("STORAGE_FAILED"))?)
    } else {
        None
    };
    let path = resolved.as_deref().unwrap_or(path);
    let mut db = Connection::open(path).map_err(storage_error)?;
    db.busy_timeout(Duration::from_secs(5))
        .map_err(storage_error)?;
    let version: u32 = db
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(storage_error)?;
    if version > DATABASE_VERSION {
        return Err(error("SCHEMA_TOO_NEW"));
    }
    // Check before migrations, device registration or library writes. Do not
    // silently rebuild a database whose user records may also be damaged.
    if existing {
        check_integrity(&db)?;
    }
    if existing && version < DATABASE_VERSION {
        let backup = path.with_file_name(format!(
            "readweave-before-v{DATABASE_VERSION}-{}.sqlite3",
            opaque("backup")?
        ));
        db.execute(
            "VACUUM INTO ?1",
            [backup
                .to_str()
                .ok_or_else(|| error("MIGRATION_BACKUP_FAILED"))?],
        )
        .map_err(|_| error("MIGRATION_BACKUP_FAILED"))?;
        let check = Connection::open(&backup).map_err(|_| error("MIGRATION_BACKUP_FAILED"))?;
        let status: String = check
            .query_row("PRAGMA quick_check", [], |row| row.get(0))
            .map_err(|_| error("MIGRATION_BACKUP_FAILED"))?;
        if status != "ok" {
            return Err(error("MIGRATION_BACKUP_FAILED"));
        }
    }
    migrate(&mut db)?;
    db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")
        .map_err(storage_error)?;
    Ok(db)
}

pub fn migrate(db: &mut Connection) -> CoreResult<()> {
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(storage_error)?;
    let version: u32 = tx
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(storage_error)?;
    if version > DATABASE_VERSION {
        return Err(error("SCHEMA_TOO_NEW"));
    }
    tx.execute_batch("CREATE TABLE IF NOT EXISTS records (collection TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(collection,id));
        CREATE TABLE IF NOT EXISTS reading_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS reading_books (book_id TEXT PRIMARY KEY, book_version TEXT NOT NULL, transform_version TEXT NOT NULL, content_hash TEXT NOT NULL, block_count INTEGER NOT NULL, utf16_units INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS reading_blocks (book_id TEXT NOT NULL, paragraph_id TEXT NOT NULL, ordinal INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY(book_id,paragraph_id));
        CREATE INDEX IF NOT EXISTS reading_blocks_order ON reading_blocks(book_id,ordinal);
        CREATE TABLE IF NOT EXISTS reading_snapshots (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, device_id TEXT NOT NULL, caller_id TEXT NOT NULL, book_id TEXT NOT NULL, book_version TEXT NOT NULL, transform_version TEXT NOT NULL, content_hash TEXT NOT NULL, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS reading_evidence (anchor_ref TEXT PRIMARY KEY, citation_id TEXT NOT NULL UNIQUE, snapshot_id TEXT NOT NULL, device_id TEXT NOT NULL, caller_id TEXT NOT NULL, book_id TEXT NOT NULL, book_version TEXT NOT NULL, transform_version TEXT NOT NULL, content_hash TEXT NOT NULL, fragment TEXT NOT NULL, locator TEXT NOT NULL, FOREIGN KEY(snapshot_id) REFERENCES reading_snapshots(id));
        ").map_err(storage_error)?;
    tx.pragma_update(None, "user_version", DATABASE_VERSION)
        .map_err(storage_error)?;
    tx.commit().map_err(storage_error)
}

pub fn device_id(db: &Connection) -> CoreResult<String> {
    db.execute(
        "INSERT OR IGNORE INTO reading_meta(key,value) VALUES('device_id',?1)",
        [opaque("device")?],
    )
    .map_err(storage_error)?;
    db.query_row(
        "SELECT value FROM reading_meta WHERE key='device_id'",
        [],
        |row| row.get(0),
    )
    .map_err(storage_error)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TestDirectory;
    use rusqlite::params;

    #[test]
    fn damaged_cache_pages_stop_startup_without_changing_user_records_or_the_file() {
        let directory = TestDirectory::new();
        let path = directory.path().join("damaged.sqlite3");
        let db = open_database(&path).unwrap();
        db.execute(
            "INSERT INTO records VALUES('annotations','note','original note')",
            [],
        )
        .unwrap();
        let root: u32 = db
            .query_row(
                "SELECT rootpage FROM sqlite_master WHERE name='reading_blocks'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let page_size: u32 = db
            .pragma_query_value(None, "page_size", |row| row.get(0))
            .unwrap();
        drop(db);
        let mut damaged = std::fs::read(&path).unwrap();
        damaged[((root - 1) * page_size) as usize] = 0x7f;
        std::fs::write(&path, &damaged).unwrap();

        assert_eq!(open_database(&path).unwrap_err().code, "STORAGE_CORRUPTED");
        assert_eq!(std::fs::read(&path).unwrap(), damaged);
        let db = Connection::open(&path).unwrap();
        assert_eq!(
            db.query_row::<String, _, _>("SELECT value FROM records WHERE id='note'", [], |row| {
                row.get(0)
            })
            .unwrap(),
            "original note"
        );
        assert!(!directory.path().read_dir().unwrap().any(|entry| entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with("readweave-before")));
    }

    #[test]
    fn storage_errors_distinguish_corruption_space_permissions_and_locks_without_details() {
        for (number, expected) in [
            (rusqlite::ffi::SQLITE_CORRUPT, "STORAGE_CORRUPTED"),
            (rusqlite::ffi::SQLITE_NOTADB, "STORAGE_CORRUPTED"),
            (rusqlite::ffi::SQLITE_FULL, "STORAGE_FULL"),
            (rusqlite::ffi::SQLITE_READONLY, "STORAGE_READ_ONLY"),
            (rusqlite::ffi::SQLITE_PERM, "STORAGE_READ_ONLY"),
            (rusqlite::ffi::SQLITE_BUSY, "STORAGE_BUSY"),
            (rusqlite::ffi::SQLITE_LOCKED, "STORAGE_BUSY"),
            (rusqlite::ffi::SQLITE_IOERR, "STORAGE_FAILED"),
        ] {
            let failure = storage_error(rusqlite::Error::SqliteFailure(
                rusqlite::ffi::Error::new(number),
                Some("private path, content and credentials".into()),
            ));
            assert_eq!(failure.code, expected);
            assert!(!failure.message.contains("private"));
        }
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn existing_database_uses_its_physical_location_through_a_directory_alias() {
        let directory = TestDirectory::new();
        let physical = directory.path().join("physical");
        let alias = directory.path().join("alias");
        std::fs::create_dir(&physical).unwrap();
        let original = physical.join("readweave.sqlite3");
        let db = open_database(&original).unwrap();
        db.execute(
            "INSERT INTO records(collection,id,value) VALUES('settings','keep','true')",
            [],
        )
        .unwrap();
        drop(db);
        let output = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", "New-Item -ItemType Junction -Path $env:READWEAVE_TEST_ALIAS -Target $env:READWEAVE_TEST_TARGET | Out-Null"])
            .env("READWEAVE_TEST_ALIAS", alias.to_string_lossy().trim_start_matches(r"\\?\"))
            .env("READWEAVE_TEST_TARGET", physical.to_string_lossy().trim_start_matches(r"\\?\"))
            .output().unwrap();
        assert!(
            output.status.success(),
            "Cannot create the local test junction: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let db = open_database(&alias.join("readweave.sqlite3")).unwrap();
        assert_eq!(
            Path::new(db.path().unwrap()),
            original.canonicalize().unwrap()
        );
        assert_eq!(
            db.query_row::<String, _, _>("SELECT value FROM records WHERE id='keep'", [], |row| {
                row.get(0)
            })
            .unwrap(),
            "true"
        );
        assert_eq!(
            db.query_row::<String, _, _>("PRAGMA quick_check", [], |row| row.get(0))
                .unwrap(),
            "ok"
        );
    }

    fn records(db: &Connection) -> Vec<(String, String, String)> {
        db.prepare("SELECT collection,id,value FROM records ORDER BY collection,id")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    }

    #[test]
    fn migration_preserves_records_and_backs_up_uncheckpointed_wal() {
        let directory = TestDirectory::new();
        let path = directory.path().join("readweave.sqlite3");
        let original = Connection::open(&path).unwrap();
        original.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE records(collection TEXT,id TEXT,value TEXT,PRIMARY KEY(collection,id)); PRAGMA user_version=1;").unwrap();
        for (collection, id, value) in [
            (
                "books",
                "book",
                r#"{"position":{"endOffset":42},"title":"旧书😀"}"#,
            ),
            (
                "annotations",
                "note",
                r#"{"note":"原笔记","locator":"原位置"}"#,
            ),
            ("conversations", "thread", r#"{"messages":["旧回答"]}"#),
            ("settings", "preferences", r#"{"scope":"to-position"}"#),
            ("packs", "action", r#"{"enabled":true}"#),
        ] {
            original
                .execute(
                    "INSERT INTO records VALUES(?1,?2,?3)",
                    params![collection, id, value],
                )
                .unwrap();
        }
        let expected = records(&original);
        let upgraded = open_database(&path).unwrap();
        assert_eq!(records(&upgraded), expected);
        assert_eq!(
            upgraded
                .pragma_query_value::<u32, _>(None, "user_version", |row| row.get(0))
                .unwrap(),
            2
        );
        let backups: Vec<_> = std::fs::read_dir(directory.path())
            .unwrap()
            .map(|p| p.unwrap().path())
            .filter(|p| {
                p.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("readweave-before-v2-")
            })
            .collect();
        assert_eq!(backups.len(), 1);
        let backup = Connection::open(&backups[0]).unwrap();
        assert_eq!(records(&backup), expected);
        assert_eq!(
            backup
                .pragma_query_value::<String, _>(None, "quick_check", |row| row.get(0))
                .unwrap(),
            "ok"
        );
        assert_eq!(
            backup
                .pragma_query_value::<u32, _>(None, "user_version", |row| row.get(0))
                .unwrap(),
            1
        );
        let device = device_id(&upgraded).unwrap();
        let reopened = open_database(&path).unwrap();
        assert_eq!(records(&reopened), expected);
        assert_eq!(device_id(&reopened).unwrap(), device);
        assert_eq!(
            std::fs::read_dir(directory.path())
                .unwrap()
                .filter(|p| p
                    .as_ref()
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .starts_with("readweave-before-v2-"))
                .count(),
            1
        );
    }

    #[test]
    fn future_database_version_is_never_downgraded() {
        let directory = TestDirectory::new();
        let path = directory.path().join("future.sqlite3");
        let mut future = Connection::open(&path).unwrap();
        future.execute_batch("PRAGMA user_version=99; CREATE TABLE future_data(value TEXT); INSERT INTO future_data VALUES('keep');").unwrap();
        assert_eq!(migrate(&mut future).unwrap_err().code, "SCHEMA_TOO_NEW");
        assert_eq!(open_database(&path).unwrap_err().code, "SCHEMA_TOO_NEW");
        assert_eq!(
            future
                .pragma_query_value::<u32, _>(None, "user_version", |row| row.get(0))
                .unwrap(),
            99
        );
        assert_eq!(
            future
                .query_row::<String, _, _>("SELECT value FROM future_data", [], |row| row.get(0))
                .unwrap(),
            "keep"
        );
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[test]
    fn migration_rechecks_version_after_waiting_for_a_concurrent_writer() {
        let directory = TestDirectory::new();
        let path = directory.path().join("concurrent.sqlite3");
        let mut writer = Connection::open(&path).unwrap();
        writer.execute_batch("PRAGMA journal_mode=WAL; PRAGMA user_version=1; CREATE TABLE records(collection TEXT,id TEXT,value TEXT); INSERT INTO records VALUES('annotations','note','keep');").unwrap();
        let future = writer
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        future.pragma_update(None, "user_version", 99).unwrap();
        let (started, ready) = std::sync::mpsc::channel();
        let (completed, result) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            let mut db = Connection::open(path).unwrap();
            db.busy_timeout(Duration::from_secs(5)).unwrap();
            started.send(()).unwrap();
            completed.send(migrate(&mut db)).unwrap();
        });
        ready.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(matches!(
            result.recv_timeout(Duration::from_millis(100)),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout)
        ));
        future.commit().unwrap();
        assert_eq!(
            result
                .recv_timeout(Duration::from_secs(5))
                .unwrap()
                .unwrap_err()
                .code,
            "SCHEMA_TOO_NEW"
        );
        worker.join().unwrap();
        assert_eq!(
            writer
                .pragma_query_value::<u32, _>(None, "user_version", |row| row.get(0))
                .unwrap(),
            99
        );
        assert_eq!(records(&writer)[0].2, "keep");
    }

    #[test]
    fn fresh_database_does_not_need_a_backup_and_failed_migration_rolls_back() {
        let directory = TestDirectory::new();
        let db = open_database(&directory.path().join("new.sqlite3")).unwrap();
        assert!(std::fs::read_dir(directory.path()).unwrap().all(|p| !p
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with("readweave-before")));
        drop(db);
        let mut broken = Connection::open_in_memory().unwrap();
        broken.execute_batch("CREATE TABLE records(collection TEXT,id TEXT,value TEXT); INSERT INTO records VALUES('annotations','note','original'); CREATE TABLE reading_blocks(wrong TEXT); PRAGMA user_version=1;").unwrap();
        assert_eq!(migrate(&mut broken).unwrap_err().code, "STORAGE_FAILED");
        assert_eq!(
            broken
                .pragma_query_value::<u32, _>(None, "user_version", |row| row.get(0))
                .unwrap(),
            1
        );
        assert_eq!(records(&broken)[0].2, "original");
        assert_eq!(
            broken
                .query_row::<u32, _, _>(
                    "SELECT count(*) FROM sqlite_master WHERE name='reading_books'",
                    [],
                    |row| row.get(0)
                )
                .unwrap(),
            0
        );
    }
}
