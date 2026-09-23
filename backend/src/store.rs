use anyhow::{Context, Result, anyhow};
use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::{Map, Value};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio::sync::Mutex;
use uuid::Uuid;

#[derive(Clone)]
pub struct ScheduleStore {
    path: Arc<PathBuf>,
    lock: Arc<Mutex<()>>,
}

impl ScheduleStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            path: Arc::new(path.into()),
            lock: Arc::new(Mutex::new(())),
        }
    }

    pub fn path(&self) -> &Path {
        self.path.as_path()
    }

    async fn read_records(&self) -> Result<Vec<Value>> {
        let contents = match tokio::fs::read_to_string(self.path()).await {
            Ok(contents) => contents,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error).context("could not read schedule store"),
        };
        let records: Value =
            serde_json::from_str(&contents).context("could not read schedule store")?;
        records
            .as_array()
            .cloned()
            .ok_or_else(|| anyhow!("schedule store must contain a JSON array"))
    }

    async fn write_records(&self, records: &[Value]) -> Result<()> {
        let parent = self
            .path()
            .parent()
            .ok_or_else(|| anyhow!("schedule store has no parent directory"))?;
        tokio::fs::create_dir_all(parent)
            .await
            .context("could not create schedule directory")?;
        let temp_path = self
            .path()
            .with_extension(format!("json.{}.tmp", Uuid::new_v4().simple()));
        let mut contents =
            serde_json::to_vec_pretty(records).context("could not encode schedules")?;
        contents.push(b'\n');
        if let Err(error) = tokio::fs::write(&temp_path, contents).await {
            let _ = tokio::fs::remove_file(&temp_path).await;
            return Err(error).context("could not write temporary schedule store");
        }
        if let Err(error) = tokio::fs::rename(&temp_path, self.path()).await {
            let _ = tokio::fs::remove_file(&temp_path).await;
            return Err(error).context("could not replace schedule store");
        }
        Ok(())
    }

    pub async fn list(&self) -> Result<Vec<Value>> {
        let _guard = self.lock.lock().await;
        self.read_records().await
    }

    pub async fn create(&self, payload: Value) -> Result<Value> {
        let allowed = [
            "type",
            "media_filename",
            "media_kind",
            "caption",
            "scheduled_at",
            "status",
            "instagram_media_id",
            "container_id",
            "graduation_strategy",
            "error",
            "media_sha256",
        ];
        let mut record = Map::new();
        if let Some(fields) = payload.as_object() {
            for key in allowed {
                if let Some(value) = fields.get(key).filter(|value| !value.is_null()) {
                    record.insert(key.to_string(), value.clone());
                }
            }
        }
        let record_type = record
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("story")
            .to_string();
        record
            .entry("id")
            .or_insert_with(|| Value::String(format!("{record_type}-{}", Uuid::new_v4().simple())));
        record
            .entry("type")
            .or_insert_with(|| Value::String("story".into()));
        record
            .entry("status")
            .or_insert_with(|| Value::String("scheduled".into()));
        record
            .entry("caption")
            .or_insert_with(|| Value::String(String::new()));
        let now = utc_now_iso();
        record.insert("created_at".into(), Value::String(now.clone()));
        record.insert("updated_at".into(), Value::String(now));
        let _guard = self.lock.lock().await;
        let mut records = self.read_records().await?;
        records.insert(0, Value::Object(record.clone()));
        self.write_records(&records).await?;
        Ok(Value::Object(record))
    }

    pub async fn update(
        &self,
        schedule_id: &str,
        patch: &Value,
        expected_status: Option<&str>,
    ) -> Result<Option<Value>> {
        let _guard = self.lock.lock().await;
        let mut records = self.read_records().await?;
        for record in &mut records {
            let object = record
                .as_object_mut()
                .ok_or_else(|| anyhow!("schedule record must be a JSON object"))?;
            if object.get("id").and_then(Value::as_str) != Some(schedule_id) {
                continue;
            }
            if expected_status.is_some_and(|expected| {
                object.get("status").and_then(Value::as_str) != Some(expected)
            }) {
                return Ok(None);
            }
            if let Some(patch) = patch.as_object() {
                for (key, value) in patch {
                    if key != "id" && key != "created_at" {
                        object.insert(key.clone(), value.clone());
                    }
                }
            }
            object.insert("updated_at".into(), Value::String(utc_now_iso()));
            let updated = record.clone();
            self.write_records(&records).await?;
            return Ok(Some(updated));
        }
        Ok(None)
    }

    pub async fn claim_due(&self, now: DateTime<Utc>) -> Result<Vec<Value>> {
        let _guard = self.lock.lock().await;
        let mut records = self.read_records().await?;
        let mut claimed = Vec::new();
        let mut changed = false;
        for record in &mut records {
            let Some(object) = record.as_object_mut() else {
                continue;
            };
            if object.get("status").and_then(Value::as_str) != Some("scheduled") {
                continue;
            }
            let Some(scheduled_at) = object.get("scheduled_at").and_then(Value::as_str) else {
                continue;
            };
            let Ok(due_at) = DateTime::parse_from_rfc3339(scheduled_at) else {
                continue;
            };
            if due_at.with_timezone(&Utc) <= now {
                let updated_at = utc_now_iso();
                object.insert("status".into(), Value::String("processing".into()));
                object.insert("updated_at".into(), Value::String(updated_at));
                claimed.push(record.clone());
                changed = true;
            }
        }
        if changed {
            self.write_records(&records).await?;
        }
        Ok(claimed)
    }

    pub async fn delete(&self, schedule_id: &str) -> Result<bool> {
        let _guard = self.lock.lock().await;
        let records = self.read_records().await?;
        let original_length = records.len();
        let remaining = records
            .into_iter()
            .filter(|record| record.get("id").and_then(Value::as_str) != Some(schedule_id))
            .collect::<Vec<_>>();
        let deleted = remaining.len() != original_length;
        if deleted {
            self.write_records(&remaining).await?;
        }
        Ok(deleted)
    }

    pub async fn recover_processing(&self) -> Result<()> {
        let _guard = self.lock.lock().await;
        let mut records = self.read_records().await?;
        let mut changed = false;
        for record in &mut records {
            let Some(object) = record.as_object_mut() else {
                continue;
            };
            if object.get("status").and_then(Value::as_str) == Some("processing") {
                object.insert("status".into(), Value::String("scheduled".into()));
                object.insert("updated_at".into(), Value::String(utc_now_iso()));
                changed = true;
            }
        }
        if changed {
            self.write_records(&records).await?;
        }
        Ok(())
    }
}

pub fn utc_now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)
}
