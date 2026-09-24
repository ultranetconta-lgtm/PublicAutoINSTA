use crate::{
    accounts::{AccountStore, PublicAccount, StoredAccount},
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
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::Arc,
    time::Instant,
};
use tempfile::TempPath;
use tokio::sync::{Mutex, Notify};
use uuid::Uuid;

pub use crate::config::AppConfig;

pub const DUPLICATE_REEL_MESSAGE: &str = "Este Reel já foi enviado ou agendado. Para evitar uma publicação duplicada, o servidor bloqueou um novo envio.";
pub type AnalyticsSnapshot = Arc<Mutex<HashMap<String, (Instant, Value, Vec<Value>)>>>;

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<AppConfig>,
    pub project_root: Arc<PathBuf>,
    pub uploads_path: Arc<PathBuf>,
    pub store: ScheduleStore,
    pub accounts: AccountStore,
    pub service: Option<Arc<MetaClient>>,
    pub reel_submit_locks: Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>,
    pub scheduler_notify: Arc<Notify>,
    pub analytics_snapshot: AnalyticsSnapshot,
}

impl AppState {
    pub fn new(config: AppConfig, project_root: &Path) -> anyhow::Result<Self> {
        let project_root = project_root.to_path_buf();
        let uploads_path = project_root.join("backend/uploads");
        std::fs::create_dir_all(&uploads_path).context("could not create uploads directory")?;
        let store = ScheduleStore::new(project_root.join("backend/data/schedules.json"));
        let accounts = AccountStore::new(project_root.join("backend/data/accounts.json"));
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
            accounts,
            service,
            reel_submit_locks: Arc::new(Mutex::new(HashMap::new())),
            scheduler_notify: Arc::new(Notify::new()),
            analytics_snapshot: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    pub async fn initialize(&self) -> anyhow::Result<()> {
        self.store.recover_processing().await
    }

    pub fn notify_scheduler(&self) {
        self.scheduler_notify.notify_one();
    }

    async fn create_scheduled_record(&self, payload: Value) -> anyhow::Result<Value> {
        let record = self.store.create(payload).await?;
        self.notify_scheduler();
        Ok(record)
    }

    pub fn health(&self) -> Value {
        build_health_payload(&self.config)
    }

    pub async fn connected_accounts(&self) -> anyhow::Result<Vec<PublicAccount>> {
        let mut connected = Vec::new();
        if self.service.is_some() {
            let username = if self.config.instagram_username.trim().is_empty() {
                self.config.instagram_user_id.clone()
            } else {
                self.config.instagram_username.clone()
            };
            connected.push(PublicAccount {
                id: self.config.instagram_user_id.clone(),
                username,
            });
        }
        for account in self.accounts.list().await? {
            if !connected.iter().any(|existing| existing.id == account.id) {
                connected.push(account.public());
            }
        }
        Ok(connected)
    }

    pub async fn resolve_account(
        &self,
        requested_id: Option<&str>,
    ) -> Result<PublicAccount, WorkflowError> {
        let accounts = self
            .connected_accounts()
            .await
            .map_err(WorkflowError::internal)?;
        if let Some(requested_id) = requested_id.map(str::trim).filter(|id| !id.is_empty()) {
            return accounts
                .into_iter()
                .find(|account| account.id == requested_id)
                .ok_or_else(|| WorkflowError::bad_request("instagram_account_not_found"));
        }
        accounts
            .into_iter()
            .next()
            .ok_or_else(|| WorkflowError::bad_request("instagram_account_required"))
    }

    pub async fn service_for_account(&self, account_id: &str) -> Option<MetaClient> {
        if self.service.is_some() && self.config.instagram_user_id == account_id {
            return self.service.as_deref().cloned();
        }
        self.accounts
            .list()
            .await
            .ok()?
            .into_iter()
            .find(|account| account.id == account_id)
            .map(|account| {
                MetaClient::new(
                    account.access_token().to_string(),
                    account.id,
                    self.config.graph_api_base_url.clone(),
                    self.config.graph_api_version.clone(),
                )
            })
    }

    pub async fn connect_account(
        &self,
        access_token: &str,
    ) -> Result<PublicAccount, WorkflowError> {
        let access_token = access_token.trim();
        if access_token.is_empty() || access_token.len() > 8192 {
            return Err(WorkflowError::bad_request("instagram_token_invalid"));
        }
        let client = MetaClient::new(
            access_token.to_string(),
            String::new(),
            self.config.graph_api_base_url.clone(),
            self.config.graph_api_version.clone(),
        );
        let profile = client
            .get_authenticated_profile()
            .await
            .map_err(WorkflowError::invalid_token)?;
        let id = profile
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.trim().is_empty())
            .ok_or_else(|| WorkflowError::bad_request("instagram_token_invalid"))?
            .to_string();
        let username = profile
            .get("username")
            .and_then(Value::as_str)
            .filter(|username| !username.trim().is_empty())
            .ok_or_else(|| WorkflowError::bad_request("instagram_token_invalid"))?
            .trim_start_matches('@')
            .to_string();
        if self
            .connected_accounts()
            .await
            .map_err(WorkflowError::internal)?
            .iter()
            .any(|account| account.id == id)
        {
            return Err(WorkflowError::bad_request(
                "instagram_account_already_connected",
            ));
        }
        let account = StoredAccount::new(id, username, access_token.to_string());
        self.accounts.add(account.clone()).await.map_err(|error| {
            if error.to_string().contains("account_already_connected") {
                WorkflowError::bad_request("instagram_account_already_connected")
            } else {
                WorkflowError::internal(error)
            }
        })?;
        Ok(account.public())
    }

    pub fn schedule_belongs_to_account(&self, record: &Value, account_id: &str) -> bool {
        record
            .get("account_id")
            .and_then(Value::as_str)
            .map(|id| id == account_id)
            .unwrap_or_else(|| {
                self.service.is_some() && self.config.instagram_user_id == account_id
            })
    }

    fn require_publish_configuration(&self) -> Result<(), WorkflowError> {
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
        let account = self
            .resolve_account(fields.get("account_id").map(String::as_str))
            .await?;
        let service = self
            .service_for_account(&account.id)
            .await
            .ok_or_else(|| WorkflowError::bad_request("instagram_account_not_found"))?;
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
            "account_id": account.id,
            "account_username": account.username,
            "media_filename": filename,
            "media_kind": media_kind,
            "caption": caption,
            "scheduled_at": scheduled_at.map(|date| date.to_rfc3339()).unwrap_or_else(utc_now_iso),
        });
        if action == "schedule" {
            return self
                .create_scheduled_record(record_payload)
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
        let result = service.publish_story(&media_url, media_kind).await;
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

    pub async fn create_post(
        &self,
        fields: HashMap<String, String>,
        media: Option<UploadedMedia>,
    ) -> Result<Value, WorkflowError> {
        let action = validate_action(fields.get("action").map(String::as_str).unwrap_or(""))?;
        let account = self
            .resolve_account(fields.get("account_id").map(String::as_str))
            .await?;
        let service = self
            .service_for_account(&account.id)
            .await
            .ok_or_else(|| WorkflowError::bad_request("instagram_account_not_found"))?;
        let media = media.ok_or_else(|| WorkflowError::bad_request("media_required"))?;
        let (media_kind, extension) =
            media_kind_for_upload(&media.filename, &media.content_type, media.size)
                .map_err(|error| WorkflowError::bad_request(error.to_string()))?;
        if media_kind != "image" {
            return Err(WorkflowError::bad_request("post_image_required"));
        }
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
            "type": "post",
            "account_id": account.id,
            "account_username": account.username,
            "media_filename": filename,
            "media_kind": media_kind,
            "caption": caption,
            "scheduled_at": scheduled_at.map(|date| date.to_rfc3339()).unwrap_or_else(utc_now_iso),
        });
        if action == "schedule" {
            return self
                .create_scheduled_record(record_payload)
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
        match service.publish_post(&media_url, &caption).await {
            Ok((media_id, container_id)) => Ok(self
                .store
                .update(
                    &id,
                    &json!({"status":"published", "instagram_media_id":media_id, "container_id":container_id, "published_at":utc_now_iso()}),
                    None,
                )
                .await
                .map_err(WorkflowError::internal)?
                .unwrap_or(record)),
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

    pub async fn create_carousel(
        &self,
        fields: HashMap<String, String>,
        media_files: Vec<UploadedMedia>,
    ) -> Result<Value, WorkflowError> {
        let action = validate_action(fields.get("action").map(String::as_str).unwrap_or(""))?;
        if !(2..=10).contains(&media_files.len()) {
            return Err(WorkflowError::bad_request("carousel_item_count_invalid"));
        }
        let account = self
            .resolve_account(fields.get("account_id").map(String::as_str))
            .await?;
        let service = self
            .service_for_account(&account.id)
            .await
            .ok_or_else(|| WorkflowError::bad_request("instagram_account_not_found"))?;
        let media_specs = media_files
            .iter()
            .map(|media| {
                media_kind_for_upload(&media.filename, &media.content_type, media.size)
                    .map_err(|error| WorkflowError::bad_request(error.to_string()))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let scheduled_at = if action == "schedule" {
            Some(parse_scheduled_at(
                fields.get("scheduled_at").map(String::as_str).unwrap_or(""),
            )?)
        } else {
            None
        };
        let caption = fields
            .get("caption")
            .map(|value| value.trim().to_string())
            .unwrap_or_default();
        if caption.chars().count() > 2200 {
            return Err(WorkflowError::bad_request("caption_too_long"));
        }
        self.require_publish_configuration()?;

        let mut saved_items: Vec<(String, String, String, PathBuf)> = Vec::with_capacity(media_files.len());
        for (media, (media_kind, extension)) in media_files.into_iter().zip(media_specs) {
            let extension = if media_kind == "video" { ".mp4" } else { extension };
            let (filename, media_url, media_path) =
                match self
                    .save_public_media(media, extension, media_kind == "video")
                    .await
                {
                    Ok(saved) => saved,
                    Err(error) => {
                        remove_saved_media_files(&saved_items).await;
                        return Err(error);
                    }
                };
            let size = match tokio::fs::metadata(&media_path).await {
                Ok(metadata) => metadata.len(),
                Err(error) => {
                    let _ = tokio::fs::remove_file(&media_path).await;
                    remove_saved_media_files(&saved_items).await;
                    return Err(WorkflowError::internal(error));
                }
            };
            if let Err(error) = verify_public_media(&media_url, size).await {
                let _ = tokio::fs::remove_file(&media_path).await;
                remove_saved_media_files(&saved_items).await;
                return Err(WorkflowError::bad_request(error));
            }
            saved_items.push((filename, media_url, media_kind.to_string(), media_path));
        }

        let filenames = saved_items
            .iter()
            .map(|(filename, _, _, _)| filename.clone())
            .collect::<Vec<_>>();
        let media_kinds = saved_items
            .iter()
            .map(|(_, _, media_kind, _)| media_kind.clone())
            .collect::<Vec<_>>();
        let record_payload = json!({
            "type": "carousel",
            "account_id": account.id,
            "account_username": account.username,
            "media_filename": filenames[0].clone(),
            "media_filenames": filenames,
            "media_kind": media_kinds[0].clone(),
            "media_kinds": media_kinds,
            "caption": caption,
            "scheduled_at": scheduled_at.map(|date| date.to_rfc3339()).unwrap_or_else(utc_now_iso),
        });
        if action == "schedule" {
            return match self.create_scheduled_record(record_payload).await {
                Ok(record) => Ok(record),
                Err(error) => {
                    remove_saved_media_files(&saved_items).await;
                    Err(WorkflowError::internal(error))
                }
            };
        }

        let mut processing_payload = record_payload;
        processing_payload["status"] = Value::String("processing".into());
        let record = match self.store.create(processing_payload).await {
            Ok(record) => record,
            Err(error) => {
                remove_saved_media_files(&saved_items).await;
                return Err(WorkflowError::internal(error));
            }
        };
        let id = record
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let media_refs = saved_items
            .iter()
            .map(|(_, media_url, media_kind, _)| (media_url.as_str(), media_kind.as_str()))
            .collect::<Vec<_>>();
        match service.publish_carousel(&media_refs, &caption).await {
            Ok((media_id, container_id)) => Ok(self
                .store
                .update(
                    &id,
                    &json!({"status":"published", "instagram_media_id":media_id, "container_id":container_id, "published_at":utc_now_iso()}),
                    None,
                )
                .await
                .map_err(WorkflowError::internal)?
                .unwrap_or(record)),
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

    pub async fn create_reel(
        &self,
        fields: HashMap<String, String>,
        media: Option<UploadedMedia>,
    ) -> Result<Value, WorkflowError> {
        let action = validate_action(fields.get("action").map(String::as_str).unwrap_or(""))?;
        let account = self
            .resolve_account(fields.get("account_id").map(String::as_str))
            .await?;
        let submit_lock = {
            let mut locks = self.reel_submit_locks.lock().await;
            Arc::clone(
                locks
                    .entry(account.id.clone())
                    .or_insert_with(|| Arc::new(Mutex::new(()))),
            )
        };
        let _submit_guard = submit_lock.lock().await;
        let service = self
            .service_for_account(&account.id)
            .await
            .ok_or_else(|| WorkflowError::bad_request("instagram_account_not_found"))?;
        let publication_type = match fields
            .get("publication_type")
            .map(String::as_str)
            .unwrap_or("reel")
        {
            "reel" => "reel",
            "test_reel" => "test_reel",
            _ => return Err(WorkflowError::bad_request("invalid_publication_type")),
        };
        let strategy = if publication_type == "test_reel" {
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
            Some(strategy)
        } else {
            None
        };
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
            .is_duplicate_reel(&account.id, &media_hash, &[])
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
            "type": publication_type,
            "account_id": account.id,
            "account_username": account.username,
            "media_filename": filename,
            "media_kind": media_kind,
            "media_sha256": media_hash,
            "caption": caption,
            "scheduled_at": scheduled_at.map(|date| date.to_rfc3339()).unwrap_or_else(utc_now_iso),
        });
        if let Some(strategy) = &strategy {
            record_payload["graduation_strategy"] = Value::String(strategy.clone());
        }
        if action == "schedule" {
            return self
                .create_scheduled_record(record_payload)
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
        let result = if publication_type == "test_reel" {
            service
                .publish_reel(&media_url, &caption, strategy.as_deref().unwrap_or("MANUAL"))
                .await
        } else {
            service.publish_feed_reel(&media_url, &caption).await
        };
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
        account_id: &str,
        sha256: &str,
        excluded_ids: &[String],
    ) -> anyhow::Result<bool> {
        for record in self.store.list().await? {
            if excluded_ids
                .iter()
                .any(|id| record.get("id").and_then(Value::as_str) == Some(id))
                || !self.schedule_belongs_to_account(&record, account_id)
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

    async fn publish_due_schedules(&self, claimed: Vec<Value>) -> anyhow::Result<usize> {
        let claimed_ids = claimed
            .iter()
            .filter_map(|record| record.get("id").and_then(Value::as_str).map(str::to_string))
            .collect::<Vec<_>>();
        let mut claimed_reel_hashes = HashSet::new();
        let mut completed = 0;
        for record in claimed {
            let id = record
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            match self
                .publish_scheduled_record(&record, &id, &claimed_ids, &mut claimed_reel_hashes)
                .await
            {
                Ok(true) => completed += 1,
                Ok(false) => {}
                Err(error) => {
                    tracing::error!(schedule_id = %id, error = %error, "scheduled publication failed");
                    if let Err(update_error) = self
                        .store
                        .update(
                            &id,
                            &json!({"status":"failed", "error":error.to_string()}),
                            None,
                        )
                        .await
                    {
                        tracing::error!(schedule_id = %id, error = %update_error, "could not mark scheduled publication as failed");
                    }
                }
            }
        }
        Ok(completed)
    }

    async fn publish_scheduled_record(
        &self,
        record: &Value,
        id: &str,
        claimed_ids: &[String],
        claimed_reel_hashes: &mut HashSet<(String, String)>,
    ) -> anyhow::Result<bool> {
        let account_id = record
            .get("account_id")
            .and_then(Value::as_str)
            .unwrap_or(&self.config.instagram_user_id);
        if matches!(
            record.get("type").and_then(Value::as_str),
            Some("reel" | "test_reel")
        ) {
            let path = self.media_path_from_record(record)?;
            let hash = match record.get("media_sha256").and_then(Value::as_str) {
                Some(hash) => hash.to_string(),
                None => sha256_file(&path).await?,
            };
            let account_hash = (account_id.to_string(), hash.clone());
            if claimed_reel_hashes.contains(&account_hash)
                || self
                    .is_duplicate_reel(account_id, &hash, claimed_ids)
                    .await?
            {
                self.store
                    .update(
                        id,
                        &json!({"status":"failed", "error":DUPLICATE_REEL_MESSAGE, "media_sha256":hash}),
                        None,
                    )
                    .await?;
                return Ok(false);
            }
            claimed_reel_hashes.insert(account_hash);
            if record.get("media_sha256").is_none() {
                self.store
                    .update(id, &json!({"media_sha256":hash}), None)
                    .await?;
            }
        }

        self.require_publish_configuration()
            .map_err(|error| anyhow::anyhow!(error.message))?;
        let service = self
            .service_for_account(account_id)
            .await
            .ok_or_else(|| anyhow::anyhow!("instagram_account_not_found"))?;
        let caption = record.get("caption").and_then(Value::as_str).unwrap_or("");
        let publication_type = record
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("story");
        let result = if publication_type == "carousel" {
            let owned_items = self.carousel_media_urls_from_record(record).await?;
            let media_refs = owned_items
                .iter()
                .map(|(media_url, media_kind)| (media_url.as_str(), media_kind.as_str()))
                .collect::<Vec<_>>();
            service.publish_carousel(&media_refs, caption).await
        } else {
            let filename = record
                .get("media_filename")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow::anyhow!("media_required"))?;
            if !media::safe_filename(filename) {
                anyhow::bail!("invalid media filename");
            }
            let path = self.uploads_path.join(filename);
            let size = tokio::fs::metadata(&path).await?.len();
            let media_url = build_public_media_url(&self.config.public_base_url, filename)
                .map_err(anyhow::Error::msg)?;
            verify_public_media(&media_url, size)
                .await
                .map_err(anyhow::Error::msg)?;
            match publication_type {
                "post" => service.publish_post(&media_url, caption).await,
                "reel" => service.publish_feed_reel(&media_url, caption).await,
                "test_reel" => {
                    service
                        .publish_reel(
                            &media_url,
                            caption,
                            record
                                .get("graduation_strategy")
                                .and_then(Value::as_str)
                                .unwrap_or("MANUAL"),
                        )
                        .await
                }
                _ => {
                    service
                        .publish_story(
                            &media_url,
                            record
                                .get("media_kind")
                                .and_then(Value::as_str)
                                .unwrap_or("image"),
                        )
                        .await
                }
            }
        };
        let (instagram_media_id, container_id) = match result {
            Ok(result) => result,
            Err(error) => {
                self.store.update(id, &failure_patch(&error), None).await?;
                return Ok(false);
            }
        };
        self.store
            .update(
                id,
                &json!({"status":"published", "instagram_media_id":instagram_media_id, "container_id":container_id, "published_at":utc_now_iso()}),
                None,
            )
            .await?;
        Ok(true)
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

    async fn carousel_media_urls_from_record(
        &self,
        record: &Value,
    ) -> anyhow::Result<Vec<(String, String)>> {
        let filenames = record
            .get("media_filenames")
            .and_then(Value::as_array)
            .ok_or_else(|| anyhow::anyhow!("carousel_media_required"))?;
        let media_kinds = record
            .get("media_kinds")
            .and_then(Value::as_array)
            .ok_or_else(|| anyhow::anyhow!("carousel_media_required"))?;
        if !(2..=10).contains(&filenames.len()) || filenames.len() != media_kinds.len() {
            anyhow::bail!("carousel_item_count_invalid");
        }

        let mut media_items = Vec::with_capacity(filenames.len());
        for (filename, media_kind) in filenames.iter().zip(media_kinds) {
            let filename = filename
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("invalid carousel filename"))?;
            let media_kind = media_kind
                .as_str()
                .filter(|kind| matches!(*kind, "image" | "video"))
                .ok_or_else(|| anyhow::anyhow!("invalid carousel media kind"))?;
            if !media::safe_filename(filename) {
                anyhow::bail!("invalid media filename");
            }
            let path = self.uploads_path.join(filename);
            let size = tokio::fs::metadata(&path).await?.len();
            let media_url = build_public_media_url(&self.config.public_base_url, filename)
                .map_err(anyhow::Error::msg)?;
            verify_public_media(&media_url, size)
                .await
                .map_err(anyhow::Error::msg)?;
            media_items.push((media_url, media_kind.to_string()));
        }
        Ok(media_items)
    }

    pub async fn analytics(
        &self,
        account_id: &str,
        period: &str,
        force_refresh: bool,
    ) -> Result<Value, MetaError> {
        analytics::build_analytics(self, account_id, period, force_refresh).await
    }
}

pub struct UploadedMedia {
    pub filename: String,
    pub content_type: String,
    pub size: u64,
    pub temp_path: TempPath,
}

async fn remove_saved_media_files(items: &[(String, String, String, PathBuf)]) {
    for (_, _, _, path) in items {
        let _ = tokio::fs::remove_file(path).await;
    }
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

    pub fn invalid_token(error: MetaError) -> Self {
        Self {
            status: StatusCode::UNPROCESSABLE_ENTITY,
            code: "instagram_token_invalid".into(),
            message: format!("A Meta não validou esse token: {error}"),
            record: None,
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
        "instagram_token_invalid" => "Não foi possível validar o token na Meta. Confira o token e as permissões da conta profissional.".into(),
        "instagram_account_required" => "Conecte ou selecione uma conta do Instagram antes de continuar.".into(),
        "instagram_account_not_found" => "A conta selecionada não está conectada neste planejador.".into(),
        "instagram_account_already_connected" => "Essa conta do Instagram já está conectada.".into(),
        "invalid_publication_type" => "Selecione um tipo válido de publicação.".into(),
        "carousel_item_count_invalid" => "Selecione de 2 a 10 imagens ou vídeos para o carrossel.".into(),
        "multiple_media_not_supported" => "Este formato aceita somente um arquivo de mídia.".into(),
        "carousel_media_required" => "As mídias do carrossel não estão disponíveis no servidor.".into(),
        "post_image_required" => "O modo Post aceita uma foto. Para vídeo, selecione Reel ou Reel de teste.".into(),
        "reel_video_required" => "Selecione um vídeo MP4 para o Reel.".into(),
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

async fn requeue_interrupted_schedules(state: &AppState, schedule_ids: Vec<String>) {
    for schedule_id in schedule_ids {
        match state
            .store
            .update(
                &schedule_id,
                &json!({"status":"scheduled"}),
                Some("processing"),
            )
            .await
        {
            Ok(Some(_)) => {
                tracing::warn!(schedule_id = %schedule_id, "requeued schedule after account task stopped unexpectedly");
            }
            Ok(None) => {}
            Err(error) => {
                tracing::error!(schedule_id = %schedule_id, error = %error, "could not recover interrupted schedule");
            }
        }
    }
}

pub async fn run_scheduler(state: AppState) {
    const STORE_RETRY_DELAY: std::time::Duration = std::time::Duration::from_secs(2);
    const MAX_SLEEP: std::time::Duration = std::time::Duration::from_secs(24 * 60 * 60);

    let mut active_accounts = HashSet::new();
    let mut tasks = tokio::task::JoinSet::<anyhow::Result<usize>>::new();
    let mut task_accounts = HashMap::<tokio::task::Id, String>::new();
    let mut task_schedule_ids = HashMap::<tokio::task::Id, Vec<String>>::new();

    loop {
        let notified = state.scheduler_notify.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();

        let claimed = state
            .store
            .claim_due_excluding_accounts(
                Utc::now(),
                &state.config.instagram_user_id,
                &active_accounts,
            )
            .await;
        let mut wait_duration = None;
        match claimed {
            Ok(claimed) => {
                let mut schedules_by_account = HashMap::<String, Vec<Value>>::new();
                for record in claimed {
                    let account_id = record
                        .get("account_id")
                        .and_then(Value::as_str)
                        .filter(|id| !id.trim().is_empty())
                        .unwrap_or(&state.config.instagram_user_id)
                        .to_string();
                    schedules_by_account
                        .entry(account_id)
                        .or_default()
                        .push(record);
                }
                for (account_id, records) in schedules_by_account {
                    active_accounts.insert(account_id.clone());
                    let schedule_ids = records
                        .iter()
                        .filter_map(|record| {
                            record.get("id").and_then(Value::as_str).map(str::to_string)
                        })
                        .collect::<Vec<_>>();
                    let task_state = state.clone();
                    let task =
                        tasks.spawn(async move { task_state.publish_due_schedules(records).await });
                    task_accounts.insert(task.id(), account_id);
                    task_schedule_ids.insert(task.id(), schedule_ids);
                }
            }
            Err(error) => {
                tracing::error!(error = %error, "scheduler could not claim due schedules");
                wait_duration = Some(STORE_RETRY_DELAY);
            }
        }

        if wait_duration.is_none() {
            match state
                .store
                .next_scheduled_at_excluding_accounts(
                    &state.config.instagram_user_id,
                    &active_accounts,
                )
                .await
            {
                Ok(Some(next_scheduled_at)) => {
                    wait_duration = Some(
                        next_scheduled_at
                            .signed_duration_since(Utc::now())
                            .to_std()
                            .unwrap_or_default()
                            .min(MAX_SLEEP),
                    );
                }
                Ok(None) => {}
                Err(error) => {
                    tracing::error!(error = %error, "scheduler could not read next schedule");
                    wait_duration = Some(STORE_RETRY_DELAY);
                }
            }
        }

        let wake_for_schedule = async {
            match wait_duration {
                Some(duration) => tokio::time::sleep(duration).await,
                None => std::future::pending::<()>().await,
            }
        };
        tokio::pin!(wake_for_schedule);

        tokio::select! {
            joined = tasks.join_next_with_id(), if !tasks.is_empty() => {
                match joined {
                    Some(Ok((task_id, Ok(published)))) => {
                        task_schedule_ids.remove(&task_id);
                        if let Some(account_id) = task_accounts.remove(&task_id) {
                            active_accounts.remove(&account_id);
                            tracing::info!(account_id = %account_id, published, "account schedule batch completed");
                        }
                    }
                    Some(Ok((task_id, Err(error)))) => {
                        let schedule_ids = task_schedule_ids.remove(&task_id).unwrap_or_default();
                        if let Some(account_id) = task_accounts.remove(&task_id) {
                            active_accounts.remove(&account_id);
                            tracing::error!(account_id = %account_id, error = %error, "account schedule batch failed");
                        } else {
                            tracing::error!(error = %error, "untracked schedule task failed");
                        }
                        requeue_interrupted_schedules(&state, schedule_ids).await;
                    }
                    Some(Err(error)) => {
                        let task_id = error.id();
                        let schedule_ids = task_schedule_ids.remove(&task_id).unwrap_or_default();
                        if let Some(account_id) = task_accounts.remove(&task_id) {
                            active_accounts.remove(&account_id);
                            tracing::error!(account_id = %account_id, error = %error, "account schedule task ended unexpectedly");
                        } else {
                            tracing::error!(error = %error, "untracked schedule task ended unexpectedly");
                        }
                        requeue_interrupted_schedules(&state, schedule_ids).await;
                    }
                    None => {}
                }
            }
            _ = notified.as_mut() => {}
            _ = &mut wake_for_schedule => {}
        }
    }
}

pub fn max_upload_bytes() -> u64 {
    MAX_UPLOAD_BYTES
}
