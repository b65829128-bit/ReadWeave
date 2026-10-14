use crate::reading_models::opaque;
use std::path::{Path, PathBuf};

pub struct TestDirectory {
    root: PathBuf,
    path: PathBuf,
}
impl TestDirectory {
    pub fn new() -> Self {
        let root = std::env::temp_dir().canonicalize().unwrap();
        let path = root.join(opaque("readweave-test").unwrap());
        std::fs::create_dir(&path).unwrap();
        Self { root, path }
    }
    pub fn path(&self) -> &Path {
        &self.path
    }
}
impl Drop for TestDirectory {
    fn drop(&mut self) {
        let target = self.path.canonicalize().unwrap();
        assert_eq!(target.parent(), Some(self.root.as_path()));
        assert!(target
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("readweave-test_"));
        std::fs::remove_dir_all(target).unwrap();
    }
}
