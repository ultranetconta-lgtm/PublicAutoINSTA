use crate::{
    analytics,
    config::{build_health_payload, build_public_media_url},
    error::MetaError,
    media::{self, MAX_UPLOAD_BYTES, media_kind_for_upload, normalize_reel_video, sha256_file},
    meta::MetaClient,
    routes,
    store::{ScheduleStore, utc_now_iso},
};
use anyhow::Context;
use axum::{Router, http::StatusCode};
use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Arc,
    time::Instant,
};
use tempfile::TempPath;
use tokio::sync::Mutex;
use uuid::Uuid;

pub use crate::config::AppConfig;

pub const DUPLICATE_REEL_MESSAGE: &str = "Este Reel já foi enviado ou agendado. Para evitar uma publicação duplicada, o servidor bloqueou um novo envio.";
pub type AnalyticsSnapshot = Arc<Mutex<Option<(Instant, Value, Vec<Value>)>>>;

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<AppConfig>,
    pub project_root: Arc<PathBuf>,
    pub uploads_path: Arc<PathBuf>,
    pub store: ScheduleStore,
    pub service: Option<Arc<MetaClient>>,
    pub reel_submit_lock: Arc<Mutex<()>>,
    pub analytics_snapshot: AnalyticsSnapshot,
}

impl AppState {
    pub fn new(config: AppConfig, project_root: &Path) -> anyhow::Result<Self> {
        let project_root = project_root.to_path_buf();
        let uploads_path = project_root.join("backend/uploads");
        std::fs::create_dir_all(&uploads_path).context("could not create uploads directory")?;
        let store = ScheduleStore::new(project_root.join("backend/data/schedules.json"));
        let service = if !config.access_token.is_empty() && !config.instagram_user_id.is_empty() {
            Some(Arc::new(MetaClient::new(
                config.access_token.clone(),
                config.instagram_user_id.clone(),
                config.graph_api_base_url.clone(),
                config.graph_api_version.clone(),
            )))
        } else {
            None
        };
        Ok(Self {
            config: Arc::new(config),
            project_root: Arc::new(project_root),
            uploads_path: Arc::new(uploads_path),
            store,
            service,
            reel_submit_lock: Arc::new(Mutex::new(())),
            analytics_snapshot: Arc::new(Mutex::new(None)),
        })
    }

    pub async fn initialize(&self) -> anyhow::Result<()> {
        self.store.recover_processing().await
    }

    pub fn health(&self) -> Value {
        build_health_payload(&self.config)
    }

    fn require_publish_configuration(&self) -> Result<(), WorkflowError> {
        if self.service.is_none() {
            return Err(WorkflowError::bad_request("meta_not_configured"));
        }
        if build_public_media_url(&self.config.public_base_url, "configuration-check.jpg").is_err()
        {
            return Err(WorkflowError::bad_request("public_media_not_configured"));
        }
        Ok(())
    }

    pub async fn create_story(
        &self,
        fields: HashMap<String, String>,
        media: Option<UploadedMedia>,
    ) -> Result<Value, WorkflowError> {
        let action = validate_action(fields.get("action").map(String::as_str).unwrap_or(""))?;
        let media = media.ok_or_else(|| WorkflowError::bad_request("media_required"))?;
        let (media_kind, extension) =
            media_kind_for_upload(&media.filename, &media.content_type, media.size)
                .map_err(|error| WorkflowError::bad_request(error.to_string()))?;
        let scheduled_at = if action == "schedule" {
            Some(parse_scheduled_at(
                fields.get("scheduled_at").map(String::as_str).unwrap_or(""),
            )?)
        } else {
            None
        };
        self.require_publish_configuration()?;

        let (filename, media_url, media_path) =
            self.save_public_media(media, extension, false).await?;
        let caption = fields
            .get("caption")
            .map(|value| value.trim().to_string())
            .unwrap_or_default();
        let record_payload = json!({
            "type": "story",
            "media_filename": filename,
            "media_kind": media_kind,
            "caption": caption,
            "scheduled_at": scheduled_at.map(|date| date.to_rfc3339()).unwrap_or_else(utc_now_iso),
        });
        if action == "schedule" {
            return self
                .store
                .create(record_payload)
                .await
                .map_err(WorkflowError::internal);
        }
        let mut processing_payload = record_payload;
        processing_payload["status"] = Value::String("processing".into());
        let record = self
            .store
            .create(processing_payload)
            .await
            .map_err(WorkflowError::internal)?;
        let id = record
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let result = self
            .service
            .as_ref()
            .expect("publish configuration checked above")
            .publish_story(&media_url, media_kind)
            .await;
        match result {
            Ok((media_id, container_id)) => {
                let patch = json!({ "status": "published", "instagram_media_id": media_id, "container_id": container_id, "published_at": utc_now_iso() });
                Ok(self
                    .store
                    .update(&id, &patch, None)
                    .await
                    .map_err(WorkflowError::internal)?
                    .unwrap_or(record))
            }
            Err(error) => {
                let failed = self
                    .store
                    .update(&id, &failure_patch(&error), None)
                    .await
                    .map_err(WorkflowError::internal)?;
                let _ = media_path;
                Err(WorkflowError::publish_failed(error, failed))
            }
        }
    }

    pub async fn create_reel(
        &self,
        fields: HashMap<String, String>,
        media: Option<UploadedMedia>,
    ) -> Result<Value, WorkflowError> {
        let _submit_guard = self.reel_submit_lock.lock().await;
        let action = validate_action(fields.get("action").map(String::as_str).unwrap_or(""))?;
        let strategy = fields
            .get("graduation_strategy")
            .map(String::as_str)
            .unwrap_or("MANUAL")
            .trim()
            .to_ascii_uppercase();
        let strategy = if strategy.is_empty() {
            "MANUAL".to_string()
        } else {
            strategy
        };
        if !matches!(strategy.as_str(), "MANUAL" | "SS_PERFORMANCE") {
            return Err(WorkflowError::bad_request("graduation_strategy_invalid"));
        }
        let media = media.ok_or_else(|| WorkflowError::bad_request("media_required"))?;
        let (media_kind, _) =
            media_kind_for_upload(&media.filename, &media.content_type, media.size)
                .map_err(|error| WorkflowError::bad_request(error.to_string()))?;
        if media_kind != "video" {
            return Err(WorkflowError::bad_request("reel_video_required"));
        }
        let scheduled_at = if action == "schedule" {
            Some(parse_scheduled_at(
                fields.get("scheduled_at").map(String::as_str).unwrap_or(""),
            )?)
        } else {
            None
        };
        self.require_publish_configuration()?;

        let (filename, media_url, media_path) = self.save_public_media(media, ".mp4", true).await?;
        let media_hash = match sha256_file(&media_path).await {
            Ok(hash) => hash,
            Err(error) => {
                let _ = tokio::fs::remove_file(&media_path).await;
                return Err(WorkflowError::internal(error));
            }
        };
        if self
            .is_duplicate_reel(&media_hash, &[])
            .await
            .map_err(WorkflowError::internal)?
        {
            let _ = tokio::fs::remove_file(&media_path).await;
            return Err(WorkflowError::bad_request("duplicate_reel"));
        }
        if let Err(error) = verify_public_media(
            &media_url,
            tokio::fs::metadata(&media_path)
                .await
                .map_err(WorkflowError::internal)?
                .len(),
        )
        .await
        {
            let _ = tokio::fs::remove_file(&media_path).await;
            return Err(WorkflowError::bad_request(error));
        }
        let caption = fields
            .get("caption")
            .map(|value| value.trim().to_string())
            .unwrap_or_default();
        let mut record_payload = json!({
            "type": "test_reel",
            "media_filename": filename,
            "media_kind": media_kind,
            "media_sha256": media_hash,
            "caption": caption,
            "graduation_strategy": strategy,
            "scheduled_at": scheduled_at.map(|date| date.to_rfc3339()).unwrap_or_else(utc_now_iso),
        });
        if action == "schedule" {
            return self
                .store
                .create(record_payload)
                .await
                .map_err(WorkflowError::internal);
        }
        record_payload["status"] = Value::String("processing".into());
        let record = self
            .store
            .create(record_payload.clone())
            .await
            .map_err(WorkflowError::internal)?;
        let id = record
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let result = self
            .service
            .as_ref()
            .expect("publish configuration checked above")
            .publish_reel(&media_url, &caption, &strategy)
            .await;
        match result {
            Ok((media_id, container_id)) => {
                let patch = json!({ "status": "published", "instagram_media_id": media_id, "container_id": container_id, "published_at": utc_now_iso() });
                Ok(self
                    .store
                    .update(&id, &patch, None)
                    .await
                    .map_err(WorkflowError::internal)?
                    .unwrap_or(record))
            }
            Err(error) => {
                let failed = self
                    .store
                    .update(&id, &failure_patch(&error), None)
                    .await
                    .map_err(WorkflowError::internal)?;
                Err(WorkflowError::publish_failed(error, failed))
            }
        }
    }

    async fn save_public_media(
        &self,
        media: UploadedMedia,
        extension: &str,
        normalize_video: bool,
    ) -> Result<(String, String, PathBuf), WorkflowError> {
        let filename = format!("{}{}", Uuid::new_v4().simple(), extension);
        let output_path = self.uploads_path.join(&filename);
        let content_type = media
            .content_type
            .split(';')
            .next()
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        let saved = if content_type == "image/png" {
            match media::convert_png_to_jpeg(media.temp_path.as_ref(), &output_path).await {
                Ok(()) => Ok(()),
                Err(error) => Err(WorkflowError::bad_request(error.to_string())),
            }
        } else {
            let temp_path: &Path = media.temp_path.as_ref();
            tokio::fs::rename(temp_path, &output_path)
                .await
                .map_err(WorkflowError::internal)
        };
        if let Err(error) = saved {
            let _ = tokio::fs::remove_file(&output_path).await;
            return Err(error);
        }
        if normalize_video && let Err(error) = normalize_reel_video(&output_path).await {
            let _ = tokio::fs::remove_file(&output_path).await;
            let code = if error.to_string().contains("ffmpeg_unavailable") {
                "reel_conversion_unavailable"
            } else {
                "reel_conversion_failed"
            };
            return Err(WorkflowError::bad_request(code));
        }
        let media_url = match build_public_media_url(&self.config.public_base_url, &filename) {
            Ok(url) => url,
            Err(_) => {
                let _ = tokio::fs::remove_file(&output_path).await;
                return Err(WorkflowError::bad_request("public_media_not_configured"));
            }
        };
        let metadata = tokio::fs::metadata(&output_path)
            .await
            .map_err(WorkflowError::internal)?;
        if !normalize_video
            && let Err(error) = verify_public_media(&media_url, metadata.len()).await
        {
            let _ = tokio::fs::remove_file(&output_path).await;
            return Err(WorkflowError::bad_request(error));
        }
        Ok((filename, media_url, output_path))
    }

    async fn is_duplicate_reel(
        &self,
        sha256: &str,
        excluded_ids: &[String],
    ) -> anyhow::Result<bool> {
        for record in self.store.list().await? {
            if excluded_ids
                .iter()
                .any(|id| record.get("id").and_then(Value::as_str) == Some(id))
            {
                continue;
            }
            if !matches!(
                record.get("type").and_then(Value::as_str),
                Some("reel" | "test_reel")
            ) || record.get("media_kind").and_then(Value::as_str) != Some("video")
            {
                continue;
            }
            if let Some(existing_hash) = record.get("media_sha256").and_then(Value::as_str) {
                if existing_hash == sha256 {
                    return Ok(true);
                }
                continue;
            }
            let Some(filename) = record.get("media_filename").and_then(Value::as_str) else {
                continue;
            };
            if !media::safe_filename(filename) {
                continue;
            }
            let path = self.uploads_path.join(filename);
            if tokio::fs::metadata(&path).await.is_ok() && sha256_file(&path).await? == sha256 {
                return Ok(true);
            }
        }
        Ok(false)
    }

    pub async fn run_due_schedules(&self) -> anyhow::Result<usize> {
        let now = Utc::now();
        let mut claimed = self.store.claim_due(now).await?;
        let claimed_ids = claimed
            .iter()
            .filter_map(|record| record.get("id").and_then(Value::as_str).map(str::to_string))
            .collect::<Vec<_>>();
        claimed.sort_by_key(|record| {
            (
                record
                    .get("scheduled_at")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                record
                    .get("created_at")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
            )
        });
        let mut claimed_reel_hashes = std::collections::HashSet::new();
        let mut completed = 0;
        for record in claimed {
            let id = record
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let operation = async {
                if record.get("type").and_then(Value::as_str) == Some("test_reel") {
                    let path = self.media_path_from_record(&record)?;
                    let hash = match record.get("media_sha256").and_then(Value::as_str) {
                        Some(hash) => hash.to_string(),
                        None => sha256_file(&path).await?,
                    };
                    if claimed_reel_hashes.contains(&hash) || self.is_duplicate_reel(&hash, &claimed_ids).await? {
                        self.store.update(&id, &json!({"status":"failed", "error":DUPLICATE_REEL_MESSAGE, "media_sha256":hash}), None).await?;
                        return Ok::<bool, anyhow::Error>(false);
                    }
                    claimed_reel_hashes.insert(hash.clone());
                    if record.get("media_sha256").is_none() {
                        self.store.update(&id, &json!({"media_sha256":hash}), None).await?;
                    }
                }
                self.require_publish_configuration().map_err(|error| anyhow::anyhow!(error.message))?;
                let filename = record.get("media_filename").and_then(Value::as_str).ok_or_else(|| anyhow::anyhow!("media_required"))?;
                if !media::safe_filename(filename) { anyhow::bail!("invalid media filename"); }
                let path = self.uploads_path.join(filename);
                let size = tokio::fs::metadata(&path).await?.len();
                let media_url = build_public_media_url(&self.config.public_base_url, filename).map_err(anyhow::Error::msg)?;
                verify_public_media(&media_url, size).await.map_err(anyhow::Error::msg)?;
                let service = self.service.as_ref().expect("configuration checked above");
        let result = if record.get("type").and_then(Value::as_str) == Some("test_reel") {
                    service.publish_reel(
                        &media_url,
                        record.get("caption").and_then(Value::as_str).unwrap_or(""),
                        record.get("graduation_strategy").and_then(Value::as_str).unwrap_or("MANUAL"),
                    ).await
                } else {
                    service.publish_story(&media_url, record.get("media_kind").and_then(Value::as_str).unwrap_or("image")).await
                };
                let result = match result {
                    Ok(result) => result,
                    Err(error) => {
                        self.store.update(&id, &failure_patch(&error), None).await?;
                        return Ok(false);
                    }
                };
                self.store.update(&id, &json!({"status":"published", "instagram_media_id":result.0, "container_id":result.1, "published_at":utc_now_iso()}), None).await?;
                Ok(true)
            }.await;
            match operation {
                Ok(true) => completed += 1,
                Ok(false) => {}
                Err(error) => {
                    let _ = self
                        .store
                        .update(
                            &id,
                            &json!({"status":"failed", "error":error.to_string()}),
                            None,
                        )
                        .await;
                }
            }
        }
        Ok(completed)
    }

    fn media_path_from_record(&self, record: &Value) -> anyhow::Result<PathBuf> {
        let filename = record
            .get("media_filename")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow::anyhow!("media_required"))?;
        if !media::safe_filename(filename) {
            anyhow::bail!("invalid media filename");
        }
        Ok(self.uploads_path.join(filename))
    }

    pub async fn analytics(&self, period: &str, force_refresh: bool) -> Result<Value, MetaError> {
        analytics::build_analytics(self, period, force_refresh).await
    }
}

pub struct UploadedMedia {
    pub filename: String,
    pub content_type: String,
    pub size: u64,
    pub temp_path: TempPath,
}

#[derive(Debug)]
pub struct WorkflowError {
    pub status: StatusCode,
    pub code: String,
    pub message: String,
    pub record: Option<Value>,
}

impl WorkflowError {
    pub fn bad_request(code: impl Into<String>) -> Self {
        let code = code.into();
        let message = friendly_error(&code);
        Self {
            status: if code == "duplicate_reel" {
                StatusCode::CONFLICT
            } else {
                StatusCode::BAD_REQUEST
            },
            code,
            message,
            record: None,
        }
    }

    pub fn internal(error: impl std::fmt::Display) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "internal_error".into(),
            message: error.to_string(),
            record: None,
        }
    }

    pub fn publish_failed(error: MetaError, record: Option<Value>) -> Self {
        Self {
            status: StatusCode::BAD_GATEWAY,
            code: "meta_publish_failed".into(),
            message: error.to_string(),
            record,
        }
    }
}

pub fn validate_action(action: &str) -> Result<&str, WorkflowError> {
    let action = action.trim();
    if matches!(action, "publish_now" | "schedule") {
        Ok(action)
    } else {
        Err(WorkflowError::bad_request("invalid_action"))
    }
}

pub fn parse_scheduled_at(raw: &str) -> Result<DateTime<chrono::FixedOffset>, WorkflowError> {
    if raw.trim().is_empty() {
        return Err(WorkflowError::bad_request("scheduled_at_required"));
    }
    let value = raw.trim();
    let parsed = DateTime::parse_from_rfc3339(value)
        .or_else(|_| DateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S%.f%z"))
        .map_err(|_| {
            let naive_timestamp =
                chrono::NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S%.f").is_ok()
                    || chrono::NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S%.f").is_ok()
                    || chrono::NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M").is_ok()
                    || chrono::NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M").is_ok()
                    || chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d").is_ok();
            if naive_timestamp {
                WorkflowError::bad_request("scheduled_at_timezone_required")
            } else {
                WorkflowError::bad_request("invalid_scheduled_at")
            }
        })?;
    if parsed.with_timezone(&Utc) <= Utc::now() {
        return Err(WorkflowError::bad_request("scheduled_at_must_be_future"));
    }
    Ok(parsed)
}

pub fn validate_schedule_edit(payload: &Value) -> Result<Value, WorkflowError> {
    let Some(object) = payload.as_object() else {
        return Err(WorkflowError::bad_request("invalid_schedule_update"));
    };
    if object.is_empty()
        || object
            .keys()
            .any(|key| !matches!(key.as_str(), "scheduled_at" | "caption"))
    {
        return Err(WorkflowError::bad_request("invalid_schedule_update"));
    }
    let mut patch = serde_json::Map::new();
    if let Some(value) = object.get("scheduled_at") {
        let Some(raw) = value.as_str().filter(|value| !value.trim().is_empty()) else {
            return Err(WorkflowError::bad_request("scheduled_at_required"));
        };
        patch.insert(
            "scheduled_at".into(),
            Value::String(parse_scheduled_at(raw)?.to_rfc3339()),
        );
    }
    if let Some(value) = object.get("caption") {
        let Some(caption) = value.as_str() else {
            return Err(WorkflowError::bad_request("invalid_schedule_update"));
        };
        if caption.chars().count() > 2200 {
            return Err(WorkflowError::bad_request("caption_too_long"));
        }
        patch.insert("caption".into(), Value::String(caption.trim().to_string()));
    }
    Ok(Value::Object(patch))
}

pub async fn verify_public_media(media_url: &str, expected_size: u64) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|_| {
            "Mídia pública inacessível: verifique o túnel HTTPS e PUBLIC_BASE_URL.".to_string()
        })?;
    let response = client.head(media_url).send().await.map_err(|_| {
        "Mídia pública inacessível: verifique o túnel HTTPS e PUBLIC_BASE_URL.".to_string()
    })?;
    if response.status() != StatusCode::OK {
        return Err(format!(
            "Mídia pública inacessível: HTTP {} no endereço configurado.",
            response.status().as_u16()
        ));
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    if !matches!(
        content_type.as_str(),
        "video/mp4" | "image/jpeg" | "video/quicktime"
    ) {
        return Err("Mídia pública inacessível: resposta HTTPS inesperada.".into());
    }
    let size = response
        .headers()
        .get(reqwest::header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok());
    if size != Some(expected_size) {
        return Err(
            "Mídia pública inacessível: tamanho do arquivo diferente no endereço público.".into(),
        );
    }
    Ok(())
}

fn failure_patch(error: &MetaError) -> Value {
    let mut patch = json!({ "status": "failed", "error": error.to_string() });
    if let Some(container_id) = &error.container_id {
        patch["container_id"] = Value::String(container_id.clone());
    }
    patch
}

pub fn public_schedule(record: Option<Value>) -> Option<Value> {
    record.map(|mut record| {
        if let Some(object) = record.as_object_mut() {
            object.remove("media_sha256");
        }
        record
    })
}

pub fn friendly_error(code: &str) -> String {
    match code {
        "media_required" => "Selecione uma imagem JPG ou vídeo MP4 para o Story.".into(),
        "unsupported_media_type" => "Selecione um arquivo JPG, PNG, MP4 ou MOV compatível.".into(),
        "png_conversion_unavailable" => {
            "O servidor não dispõe de FFmpeg para converter a imagem PNG.".into()
        }
        "png_conversion_failed" => "Não foi possível converter a imagem PNG para JPEG.".into(),
        "duplicate_reel" => DUPLICATE_REEL_MESSAGE.into(),
        "public_media_not_configured" => {
            "Configure PUBLIC_BASE_URL com uma URL HTTPS pública para o Meta acessar a mídia."
                .into()
        }
        "meta_not_configured" => "Configure o token e o Instagram User ID no backend.".into(),
        "reel_video_required" => "Selecione um vídeo MP4 para o Reel de teste.".into(),
        "reel_conversion_unavailable" => {
            "FFmpeg não está instalado no servidor para preparar o vídeo do Reel.".into()
        }
        "reel_conversion_failed" => {
            "Não foi possível preparar o vídeo como MP4 compatível com Reels.".into()
        }
        "graduation_strategy_invalid" => {
            "A estratégia do Reel de teste deve ser MANUAL ou SS_PERFORMANCE.".into()
        }
        "scheduled_at_required" => "Informe a data e o horário da publicação.".into(),
        "invalid_scheduled_at" => "Informe uma data e um horário válidos.".into(),
        "scheduled_at_timezone_required" => "Não foi possível identificar o fuso horário.".into(),
        "scheduled_at_must_be_future" => "A data e o horário precisam estar no futuro.".into(),
        "caption_too_long" => "A legenda pode ter no máximo 2.200 caracteres.".into(),
        "invalid_schedule_update" => "Os dados enviados para edição são inválidos.".into(),
        "json_required" => "Não foi possível enviar as alterações.".into(),
        "multipart_required" => "Envie a mídia como formulário multipart.".into(),
        "upload_too_large" => "O arquivo excede o limite de 200 MB.".into(),
        "form_field_too_large" => "Um dos campos do formulário excede o limite permitido.".into(),
        _ => code.into(),
    }
}

pub fn build_router(state: AppState) -> Router {
    routes::build_router(state)
}

pub async fn run_scheduler(state: AppState) {
    let mut interval = tokio::time::interval(std::time::Duration::from_secs(2));
    interval.tick().await;
    loop {
        interval.tick().await;
        if let Err(error) = state.run_due_schedules().await {
            tracing::error!(error = %error, "scheduler iteration failed");
        }
    }
}

pub fn max_upload_bytes() -> u64 {
    MAX_UPLOAD_BYTES
}
