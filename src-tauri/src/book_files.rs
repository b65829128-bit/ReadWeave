use crate::{check_hash, reading_models::opaque};
use sha2::{Digest, Sha256};
use std::{io::Read, path::Path};

const MAX_BOOK_BYTES: usize = 32 * 1024 * 1024;

pub fn put(books: &Path, key: &str, bytes: &[u8]) -> Result<(), String> {
    check_hash(key)?;
    if bytes.len() > MAX_BOOK_BYTES {
        return Err("BOOK_TOO_LARGE".into());
    }
    if format!("{:x}", Sha256::digest(bytes)) != key {
        return Err("BOOK_VERSION_MISMATCH".into());
    }
    let path = books.join(format!("{key}.epub"));
    if path.exists() {
        return Ok(());
    }
    let name = opaque("book-write").map_err(|_| "BOOK_WRITE_FAILED")?;
    let temporary = books.join(format!("{key}-{name}.tmp"));
    let result = (|| {
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|_| "BOOK_WRITE_FAILED")?;
        file.write_all(bytes).map_err(|_| "BOOK_WRITE_FAILED")?;
        drop(file);
        // A concurrent import of the same content may have finished first.
        if std::fs::rename(&temporary, &path).is_err() && !path.exists() {
            return Err("BOOK_WRITE_FAILED".into());
        }
        Ok(())
    })();
    if temporary.exists() {
        std::fs::remove_file(temporary).map_err(|_| "BOOK_WRITE_FAILED")?;
    }
    result
}

pub fn get(books: &Path, key: &str) -> Result<Vec<u8>, String> {
    check_hash(key)?;
    let file =
        std::fs::File::open(books.join(format!("{key}.epub"))).map_err(|_| "BOOK_NOT_FOUND")?;
    let mut bytes = Vec::new();
    file.take(MAX_BOOK_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "BOOK_NOT_FOUND")?;
    if bytes.len() > MAX_BOOK_BYTES {
        return Err("BOOK_TOO_LARGE".into());
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TestDirectory;

    #[test]
    fn binary_books_preserve_bytes_and_enforce_hash_path_and_size_limits() {
        let directory = TestDirectory::new();
        let bytes = [0, 255, 128, 13, 10, 80, 75];
        let key = format!("{:x}", Sha256::digest(bytes));
        put(directory.path(), &key, &bytes).unwrap();
        assert_eq!(get(directory.path(), &key).unwrap(), bytes);
        assert_eq!(
            put(directory.path(), &key, b"changed").unwrap_err(),
            "BOOK_VERSION_MISMATCH"
        );
        assert_eq!(get(directory.path(), &key).unwrap(), bytes);
        for invalid in ["../book", "", "C:\\book", &"A".repeat(64)] {
            assert_eq!(
                get(directory.path(), invalid).unwrap_err(),
                "INVALID_BOOK_HASH"
            );
            assert_eq!(
                put(directory.path(), invalid, &bytes).unwrap_err(),
                "INVALID_BOOK_HASH"
            );
        }
        assert_eq!(
            get(directory.path(), &"0".repeat(64)).unwrap_err(),
            "BOOK_NOT_FOUND"
        );
        assert_eq!(
            put(directory.path(), &key, &vec![0; MAX_BOOK_BYTES + 1]).unwrap_err(),
            "BOOK_TOO_LARGE"
        );
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[test]
    fn concurrent_imports_leave_one_complete_book_and_no_temporary_files() {
        let directory = TestDirectory::new();
        let bytes = vec![42; 128 * 1024];
        let key = format!("{:x}", Sha256::digest(&bytes));
        std::thread::scope(|scope| {
            for _ in 0..4 {
                scope.spawn(|| put(directory.path(), &key, &bytes).unwrap());
            }
        });
        assert_eq!(get(directory.path(), &key).unwrap(), bytes);
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    }
}
