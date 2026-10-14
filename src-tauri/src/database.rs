use crate::reading_models::{error, opaque, CoreResult};
use rusqlite::Connection;
use std::{path::Path, time::Duration};

pub const DATABASE_VERSION: u32 = 2;

pub fn open_database(path: &Path) -> CoreResult<Connection> {
    let existing = path.exists();
    let mut db = Connection::open(path).map_err(|_| error("STORAGE_FAILED"))?;
    db.busy_timeout(Duration::from_secs(5))
        .map_err(|_| error("STORAGE_FAILED"))?;
    let version: u32 = db
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|_| error("STORAGE_FAILED"))?;
    if version > DATABASE_VERSION {
        return Err(error("SCHEMA_TOO_NEW"));
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
        .map_err(|_| error("STORAGE_FAILED"))?;
    Ok(db)
}

pub fn migrate(db: &mut Connection) -> CoreResult<()> {
    let version: u32 = db
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|_| error("STORAGE_FAILED"))?;
    if version > DATABASE_VERSION {
        return Err(error("SCHEMA_TOO_NEW"));
    }
    let tx = db.transaction().map_err(|_| error("STORAGE_FAILED"))?;
    tx.execute_batch("CREATE TABLE IF NOT EXISTS records (collection TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(collection,id));
        CREATE TABLE IF NOT EXISTS reading_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS reading_books (book_id TEXT PRIMARY KEY, book_version TEXT NOT NULL, transform_version TEXT NOT NULL, content_hash TEXT NOT NULL, block_count INTEGER NOT NULL, utf16_units INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS reading_blocks (book_id TEXT NOT NULL, paragraph_id TEXT NOT NULL, ordinal INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY(book_id,paragraph_id));
        CREATE INDEX IF NOT EXISTS reading_blocks_order ON reading_blocks(book_id,ordinal);
        CREATE TABLE IF NOT EXISTS reading_snapshots (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, device_id TEXT NOT NULL, caller_id TEXT NOT NULL, book_id TEXT NOT NULL, book_version TEXT NOT NULL, transform_version TEXT NOT NULL, content_hash TEXT NOT NULL, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS reading_evidence (anchor_ref TEXT PRIMARY KEY, citation_id TEXT NOT NULL UNIQUE, snapshot_id TEXT NOT NULL, device_id TEXT NOT NULL, caller_id TEXT NOT NULL, book_id TEXT NOT NULL, book_version TEXT NOT NULL, transform_version TEXT NOT NULL, content_hash TEXT NOT NULL, fragment TEXT NOT NULL, locator TEXT NOT NULL, FOREIGN KEY(snapshot_id) REFERENCES reading_snapshots(id));
        PRAGMA user_version=2;").map_err(|_| error("STORAGE_FAILED"))?;
    tx.commit().map_err(|_| error("STORAGE_FAILED"))
}

pub fn device_id(db: &Connection) -> CoreResult<String> {
    db.execute(
        "INSERT OR IGNORE INTO reading_meta(key,value) VALUES('device_id',?1)",
        [opaque("device")?],
    )
    .map_err(|_| error("STORAGE_FAILED"))?;
    db.query_row(
        "SELECT value FROM reading_meta WHERE key='device_id'",
        [],
        |row| row.get(0),
    )
    .map_err(|_| error("STORAGE_FAILED"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TestDirectory;
    use rusqlite::params;

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
