use serde_json::{Value, json};
use std::{collections::HashMap, env, fs, path::Path};
use url::Url;

#[derive(Clone, Debug)]
pub struct AppConfig {
    pub access_token: String,
    pub instagram_user_id: String,
    pub instagram_username: String,
    pub graph_api_base_url: String,
    pub graph_api_version: String,
    pub public_base_url: String,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            access_token: String::new(),
            instagram_user_id: String::new(),
            instagram_username: String::new(),
            graph_api_base_url: "https://graph.instagram.com".into(),
            graph_api_version: "v25.0".into(),
            public_base_url: String::new(),
        }
    }
}

impl AppConfig {
    pub fn load(project_root: &Path) -> Self {
        let file_values = load_env_file(&project_root.join("api/.env"));
        Self {
            access_token: env_value("INSTAGRAM_ACCESS_TOKEN", &file_values, ""),
            instagram_user_id: env_value("INSTAGRAM_USER_ID", &file_values, ""),
            instagram_username: env_value("INSTAGRAM_USERNAME", &file_values, ""),
            graph_api_base_url: env_value(
                "GRAPH_API_BASE_URL",
                &file_values,
                "https://graph.instagram.com",
            ),
            graph_api_version: env_value("GRAPH_API_VERSION", &file_values, "v25.0"),
            public_base_url: env_value("PUBLIC_BASE_URL", &file_values, ""),
        }
    }
}

fn load_env_file(path: &Path) -> HashMap<String, String> {
    let Ok(contents) = fs::read_to_string(path) else {
        return HashMap::new();
    };
    contents
        .lines()
        .filter_map(|raw| {
            let line = raw.trim();
            if line.is_empty() || line.starts_with('#') {
                return None;
            }
            let (key, raw_value) = line.split_once('=')?;
            let value = raw_value.trim();
            let value = if value.len() >= 2
                && ((value.starts_with('"') && value.ends_with('"'))
                    || (value.starts_with('\'') && value.ends_with('\'')))
            {
                &value[1..value.len() - 1]
            } else {
                value
            };
            Some((key.trim().to_string(), value.to_string()))
        })
        .collect()
}

fn env_value(name: &str, file_values: &HashMap<String, String>, default: &str) -> String {
    env::var(name)
        .ok()
        .or_else(|| file_values.get(name).cloned())
        .unwrap_or_else(|| default.to_string())
}

pub fn build_public_media_url(base_url: &str, filename: &str) -> Result<String, String> {
    let trimmed = base_url.trim();
    if trimmed.is_empty() {
        return Err("PUBLIC_BASE_URL is required for Meta media access".into());
    }
    let parsed = Url::parse(trimmed).map_err(|_| "PUBLIC_BASE_URL must be an HTTPS URL")?;
    if parsed.scheme() != "https" || parsed.host_str().is_none() {
        return Err("PUBLIC_BASE_URL must be an HTTPS URL".into());
    }
    if filename.is_empty()
        || filename == "."
        || filename == ".."
        || filename.contains('/')
        || filename.contains('\\')
    {
        return Err("invalid media filename".into());
    }
    let encoded_filename = url::form_urlencoded::byte_serialize(filename.as_bytes())
        .collect::<String>()
        .replace('+', "%20");
    Ok(format!(
        "{}/media/{}",
        trimmed.trim_end_matches('/'),
        encoded_filename
    ))
}

pub fn build_health_payload(config: &AppConfig) -> Value {
    let (public_media_configured, public_media_reason) =
        match build_public_media_url(&config.public_base_url, "health-check.jpg") {
            Ok(_) => (true, String::new()),
            Err(_error) if config.public_base_url.trim().is_empty() => {
                (false, "PUBLIC_BASE_URL is not configured".to_string())
            }
            Err(error) => (false, error),
        };
    json!({
        "ok": true,
        "meta_configured": !config.access_token.is_empty() && !config.instagram_user_id.is_empty(),
        "instagram_user_id": config.instagram_user_id,
        "instagram_username": config.instagram_username,
        "public_media_configured": public_media_configured,
        "public_media_reason": public_media_reason,
        "graph_api_version": config.graph_api_version,
    })
}
