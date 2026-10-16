use keyring_core::{api::CredentialStoreApi, Entry, Error as KeyringError};
use zeroize::{Zeroize, Zeroizing};

const SERVICE: &str = "ReadWeave";
const USER: &str = "model-api-key";
const MAX_SECRET_BYTES: usize = 8192;

trait CredentialBackend: Send + Sync {
    fn get(&self) -> Result<Option<Zeroizing<Vec<u8>>>, ()>;
    fn set(&self, secret: &[u8]) -> Result<(), ()>;
    fn delete(&self) -> Result<(), ()>;
}

struct PlatformBackend;

impl CredentialBackend for PlatformBackend {
    fn get(&self) -> Result<Option<Zeroizing<Vec<u8>>>, ()> {
        let entry = platform_entry()?;
        match entry.get_secret() {
            Ok(secret) => Ok(Some(Zeroizing::new(secret))),
            Err(KeyringError::NoEntry) => Ok(None),
            Err(_) => Err(()),
        }
    }

    fn set(&self, secret: &[u8]) -> Result<(), ()> {
        platform_entry()?.set_secret(secret).map_err(|_| ())
    }

    fn delete(&self) -> Result<(), ()> {
        match platform_entry()?.delete_credential() {
            Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
            Err(_) => Err(()),
        }
    }
}

#[cfg(windows)]
fn platform_entry() -> Result<Entry, ()> {
    use std::collections::HashMap;

    let store = windows_native_keyring_store::Store::new().map_err(|_| ())?;
    let modifiers = HashMap::from([("persistence", "Local")]);
    store.build(SERVICE, USER, Some(&modifiers)).map_err(|_| ())
}

#[cfg(target_os = "android")]
fn platform_entry() -> Result<Entry, ()> {
    let store = android_native_keyring_store::Store::new().map_err(|_| ())?;
    store.build(SERVICE, USER, None).map_err(|_| ())
}

#[cfg(not(any(windows, target_os = "android")))]
fn platform_entry() -> Result<Entry, ()> {
    Err(())
}

pub struct CredentialVault {
    backend: Box<dyn CredentialBackend>,
}

impl CredentialVault {
    pub fn platform() -> Self {
        Self {
            backend: Box::new(PlatformBackend),
        }
    }

    pub fn has_secret(&self) -> Result<bool, &'static str> {
        self.backend
            .get()
            .map(|secret| secret.is_some())
            .map_err(|_| "CREDENTIAL_STORAGE_UNAVAILABLE")
    }

    pub fn get_secret(&self) -> Result<Option<Zeroizing<Vec<u8>>>, &'static str> {
        self.backend
            .get()
            .map_err(|_| "CREDENTIAL_STORAGE_UNAVAILABLE")
    }

    pub fn set_secret(&self, secret: String) -> Result<(), &'static str> {
        let mut input = Zeroizing::new(secret);
        let normalized = Zeroizing::new(input.trim().to_owned());
        input.zeroize();
        if normalized.is_empty() || normalized.len() > MAX_SECRET_BYTES {
            return Err("INVALID_CREDENTIAL");
        }
        self.backend
            .set(normalized.as_bytes())
            .map_err(|_| "CREDENTIAL_STORAGE_UNAVAILABLE")
    }

    pub fn delete_secret(&self) -> Result<(), &'static str> {
        self.backend
            .delete()
            .map_err(|_| "CREDENTIAL_STORAGE_UNAVAILABLE")
    }

    #[cfg(test)]
    fn with_backend(backend: impl CredentialBackend + 'static) -> Self {
        Self {
            backend: Box::new(backend),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[derive(Default)]
    struct MemoryBackend(Mutex<Option<Vec<u8>>>);

    impl CredentialBackend for MemoryBackend {
        fn get(&self) -> Result<Option<Zeroizing<Vec<u8>>>, ()> {
            Ok(self
                .0
                .lock()
                .map_err(|_| ())?
                .as_ref()
                .map(|secret| Zeroizing::new(secret.clone())))
        }

        fn set(&self, secret: &[u8]) -> Result<(), ()> {
            *self.0.lock().map_err(|_| ())? = Some(secret.to_vec());
            Ok(())
        }

        fn delete(&self) -> Result<(), ()> {
            *self.0.lock().map_err(|_| ())? = None;
            Ok(())
        }
    }

    #[test]
    fn secret_is_replaced_read_and_deleted_without_exposing_empty_values() {
        let vault = CredentialVault::with_backend(MemoryBackend::default());
        assert!(!vault.has_secret().unwrap());
        assert!(vault.set_secret("  synthetic-canary  ".to_owned()).is_ok());
        assert_eq!(
            vault.get_secret().unwrap().unwrap().as_slice(),
            b"synthetic-canary"
        );
        assert!(vault.has_secret().unwrap());
        vault.delete_secret().unwrap();
        assert!(!vault.has_secret().unwrap());
    }

    #[test]
    fn empty_and_oversized_credentials_are_rejected() {
        let vault = CredentialVault::with_backend(MemoryBackend::default());
        assert_eq!(
            vault.set_secret(" \n ".to_owned()),
            Err("INVALID_CREDENTIAL")
        );
        assert_eq!(
            vault.set_secret("x".repeat(MAX_SECRET_BYTES + 1)),
            Err("INVALID_CREDENTIAL")
        );
        assert!(!vault.has_secret().unwrap());
    }

    #[cfg(windows)]
    #[test]
    fn windows_credential_manager_persists_and_removes_a_test_secret() {
        use keyring_core::api::CredentialStoreApi;
        use std::collections::HashMap;

        let store = windows_native_keyring_store::Store::new().unwrap();
        let user = format!(
            "integration-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let modifiers = HashMap::from([("persistence", "Local")]);
        let entry = store
            .build("ReadWeave.IntegrationTest", &user, Some(&modifiers))
            .unwrap();
        let _ = entry.delete_credential();

        let saved = entry.set_secret(b"readweave-alpha8-test-canary").is_ok();
        let stored = entry
            .get_secret()
            .map(Zeroizing::new)
            .is_ok_and(|secret| secret.as_slice() == b"readweave-alpha8-test-canary");
        let deleted = entry.delete_credential().is_ok();
        let absent = matches!(entry.get_secret(), Err(KeyringError::NoEntry));

        assert!(saved && stored && deleted && absent);
    }
}
