use futures_util::StreamExt;
use serde_json::Value;
use std::time::Duration;
use tauri::WebviewWindow;
use zeroize::Zeroizing;

fn endpoint(value: &str, action: &str) -> Result<reqwest::Url, String> {
    if !["open", "start", "poll", "mcp", "cancel", "close"].contains(&action) {
        return Err("ASTRBOT_ACTION_INVALID".into());
    }
    let mut url = reqwest::Url::parse(value).map_err(|_| "ASTRBOT_URL_INVALID")?;
    let loopback = matches!(url.host_str(), Some("127.0.0.1" | "[::1]" | "localhost"));
    if !(url.scheme() == "https" || url.scheme() == "http" && loopback)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err("ASTRBOT_URL_INVALID".into());
    }
    url.set_path(&format!("/readweave/v1/{action}"));
    Ok(url)
}

/// This connection only accepts an explicit memory credential. Never read the model vault.
#[tauri::command]
pub async fn astrbot_request(
    window: WebviewWindow,
    base: String,
    action: String,
    api_key: String,
    body: Value,
) -> Result<Value, String> {
    if window.label() != "main" {
        return Err("CALLER_MISMATCH".into());
    }
    let key = Zeroizing::new(api_key);
    if key.is_empty() || key.len() > 8192 {
        return Err("ASTRBOT_KEY_REQUIRED".into());
    }
    let url = endpoint(&base, &action)?;
    let payload = serde_json::to_vec(&body).map_err(|_| "ASTRBOT_BODY_INVALID")?;
    if payload.len() > 1024 * 1024 {
        return Err("ASTRBOT_BODY_TOO_LARGE".into());
    }
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(35))
        .build()
        .map_err(|_| "ASTRBOT_CONNECTION_FAILED")?;
    let response = client
        .post(url)
        .bearer_auth(key.as_str())
        .header("Content-Type", "application/json")
        .body(payload)
        .send()
        .await
        .map_err(|_| "ASTRBOT_CONNECTION_FAILED")?;
    if !response.status().is_success() {
        return Err(match response.status().as_u16() {
            401 | 403 => "ASTRBOT_KEY_REJECTED",
            409 => "ASTRBOT_SESSION_CONFLICT",
            410 => "ASTRBOT_TOPIC_EXPIRED",
            _ => "ASTRBOT_BRIDGE_FAILED",
        }
        .into());
    }
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "ASTRBOT_CONNECTION_FAILED")?;
        if bytes.len() + chunk.len() > 1024 * 1024 {
            return Err("ASTRBOT_RESPONSE_TOO_LARGE".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| "ASTRBOT_RESPONSE_INVALID".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bridge_urls_only_use_fixed_actions_without_secrets_or_insecure_remote_http() {
        assert_eq!(
            endpoint("http://127.0.0.1:16186", "open").unwrap().path(),
            "/readweave/v1/open"
        );
        for url in [
            "http://example.org",
            "https://key@example.org",
            "https://example.org/?key=x",
            "https://example.org/a",
            "https://example.org/#x",
        ] {
            assert!(endpoint(url, "open").is_err());
        }
        assert!(endpoint("https://example.org", "../chat").is_err());
    }
}
