use crate::reading_models::{opaque, CoreError};
use std::{fs::OpenOptions, path::Path};

#[derive(Debug)]
pub struct StartupError {
    pub stage: &'static str,
    pub code: String,
    pub message: &'static str,
}

impl StartupError {
    pub fn io(stage: &'static str, error: std::io::Error) -> Self {
        Self {
            stage,
            code: error
                .raw_os_error()
                .map(|code| format!("OS_{code}"))
                .unwrap_or_else(|| "IO_FAILED".into()),
            message: "无法访问应用的本地目录，请核对该目录的写入权限和设备剩余空间。",
        }
    }
    pub fn core(stage: &'static str, error: CoreError) -> Self {
        Self {
            stage,
            code: error.code.into(),
            message: error.message,
        }
    }
    pub fn webview(error: &tauri::Error) -> Self {
        Self {
            stage: "阅读界面初始化",
            code: webview_code(&error.to_string()),
            message: "Windows 阅读界面无法创建。请关闭其他 ReadWeave 窗口后重试。",
        }
    }
    pub fn report(&self) -> String {
        format!(
            "ReadWeave {} 启动失败\n\n步骤：{}\n错误代码：{}\n{}\n\n现有书籍和笔记未被重置。请将步骤和错误代码反馈给开发者。",
            env!("CARGO_PKG_VERSION"), self.stage, self.code, self.message
        )
    }
}

fn webview_code(detail: &str) -> String {
    let code = detail
        .split_once("HRESULT(0x")
        .and_then(|(_, suffix)| suffix.split_once(')'))
        .map(|(code, _)| code)
        .filter(|code| code.len() == 8 && code.bytes().all(|byte| byte.is_ascii_hexdigit()));
    code.map(|code| format!("WEBVIEW_0x{}", code.to_ascii_uppercase()))
        .unwrap_or_else(|| "WEBVIEW_INIT_FAILED".into())
}

pub fn check_writable(directory: &Path) -> Result<(), StartupError> {
    let name =
        opaque("startup-write").map_err(|error| StartupError::core("本地目录检查", error))?;
    let path = directory.join(format!(".{name}.tmp"));
    let handle = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|error| StartupError::io("本地目录写入检查", error))?;
    drop(handle);
    std::fs::remove_file(path).map_err(|error| StartupError::io("本地目录写入检查", error))
}

pub fn show_failure(error: &StartupError) {
    let report = error.report();
    // Only our fixed stage, error code and static message are written. Never serialize errors,
    // settings, publication content, model requests or credentials into a startup report.
    if let Ok(executable) = std::env::current_exe() {
        if let Some(directory) = executable.parent() {
            let _ = std::fs::write(directory.join("ReadWeave-startup-error.log"), &report);
        }
    }
    show_message(&report);
}

#[cfg(target_os = "windows")]
fn show_message(message: &str) {
    #[link(name = "user32")]
    extern "system" {
        fn MessageBoxW(
            hwnd: *mut std::ffi::c_void,
            text: *const u16,
            caption: *const u16,
            flags: u32,
        ) -> i32;
    }
    let text: Vec<u16> = message.encode_utf16().chain(Some(0)).collect();
    let caption: Vec<u16> = "ReadWeave 启动诊断".encode_utf16().chain(Some(0)).collect();
    // Both buffers remain alive and nul-terminated for the modal call; no window is required.
    unsafe {
        MessageBoxW(std::ptr::null_mut(), text.as_ptr(), caption.as_ptr(), 0x10);
    }
}

#[cfg(not(target_os = "windows"))]
fn show_message(message: &str) {
    eprintln!("{message}");
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TestDirectory;

    #[test]
    fn extracts_only_valid_hresult_codes_from_runtime_errors() {
        assert_eq!(
            webview_code("WebView2 error: HRESULT(0x800700AA), user data and secret text"),
            "WEBVIEW_0x800700AA"
        );
        for detail in ["secret", "HRESULT(0xsecret)", "HRESULT(0x800700AAextra)"] {
            assert_eq!(webview_code(detail), "WEBVIEW_INIT_FAILED");
        }
    }

    #[test]
    fn writable_check_cleans_its_probe_and_never_replaces_existing_files() {
        let directory = TestDirectory::new();
        let original = directory.path().join("existing.tmp");
        std::fs::write(&original, "keep original").unwrap();
        check_writable(directory.path()).unwrap();
        assert_eq!(std::fs::read_to_string(&original).unwrap(), "keep original");
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
        assert!(check_writable(&original).is_err());
    }
}
