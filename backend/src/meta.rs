use crate::error::MetaError;
use futures_util::future::try_join_all;
use reqwest::{Client, Method, Url};
use serde_json::{Value, json};
use std::time::Duration;

#[derive(Clone)]
pub struct MetaClient {
    access_token: String,
    instagram_user_id: String,
    base_url: String,
    api_version: String,
    client: Client,
}

impl MetaClient {
    pub fn new(
        access_token: String,
        instagram_user_id: String,
        base_url: String,
        api_version: String,
    ) -> Self {
        Self {
            access_token,
            instagram_user_id,
            base_url: base_url.trim_end_matches('/').to_string(),
            api_version: api_version.trim_matches('/').to_string(),
            client: Client::builder()
                .timeout(Duration::from_secs(45))
                .build()
                .unwrap_or_default(),
        }
    }

    fn endpoint(&self, path: &str) -> String {
        format!(
            "{}/{}/{}/{}",
            self.base_url,
            self.api_version,
            self.instagram_user_id,
            path.trim_start_matches('/')
        )
    }

    fn container_endpoint(&self, container_id: &str) -> String {
        format!("{}/{}/{}", self.base_url, self.api_version, container_id)
    }

    pub async fn get_authenticated_profile(&self) -> Result<Value, MetaError> {
        let mut url = Url::parse(&format!("{}/{}/me", self.base_url, self.api_version))
            .map_err(|_| MetaError::new("Meta account URL is invalid"))?;
        url.query_pairs_mut().append_pair("fields", "id,username");
        self.request_json(Method::GET, url.as_str(), None).await
    }

    async fn request_json(
        &self,
        method: Method,
        url: &str,
        data: Option<&[(&str, String)]>,
    ) -> Result<Value, MetaError> {
        let mut request = self
            .client
            .request(method.clone(), url)
            .bearer_auth(&self.access_token)
            .header(reqwest::header::ACCEPT, "application/json");
        if method == Method::POST {
            request = request.form(&data.unwrap_or_default());
        }
        let response = request.send().await.map_err(|error| {
            MetaError::new(redact(
                &format!("Meta connection failed: {error}"),
                &self.access_token,
            ))
        })?;
        let status = response.status();
        let body = response.bytes().await.map_err(|error| {
            MetaError::new(redact(
                &format!("Meta response read failed: {error}"),
                &self.access_token,
            ))
        })?;
        let parsed: Value = serde_json::from_slice(&body)
            .map_err(|_| MetaError::new("Meta returned an invalid JSON response"))?;
        if !status.is_success() {
            let detail = parsed
                .get("error")
                .and_then(Value::as_object)
                .map(|error| {
                    let mut parts = vec![
                        error
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("Meta request failed")
                            .to_string(),
                    ];
                    for (label, key) in [
                        ("code", "code"),
                        ("subcode", "error_subcode"),
                        ("trace", "fbtrace_id"),
                    ] {
                        if let Some(value) = error.get(key) {
                            let value = value
                                .as_str()
                                .map(str::to_string)
                                .unwrap_or_else(|| value.to_string());
                            parts.push(format!("{label}={value}"));
                        }
                    }
                    parts.join("; ")
                })
                .unwrap_or_else(|| format!("Meta request failed with HTTP {}", status.as_u16()));
            return Err(MetaError::new(redact(&detail, &self.access_token)));
        }
        Ok(parsed)
    }

    pub async fn create_story_container(
        &self,
        media_url: &str,
        media_kind: &str,
    ) -> Result<String, MetaError> {
        let parameter = match media_kind {
            "image" => "image_url",
            "video" => "video_url",
            _ => return Err(MetaError::new("media_kind must be image or video")),
        };
        let data = [
            ("media_type", "STORIES".to_string()),
            (parameter, media_url.to_string()),
        ];
        let response = self
            .request_json(Method::POST, &self.endpoint("media"), Some(&data))
            .await?;
        response
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| MetaError::new("Meta did not return a Story container id"))
    }

    pub async fn create_reel_container(
        &self,
        media_url: &str,
        caption: &str,
        graduation_strategy: &str,
    ) -> Result<String, MetaError> {
        if !matches!(graduation_strategy, "MANUAL" | "SS_PERFORMANCE") {
            return Err(MetaError::new(
                "graduation_strategy must be MANUAL or SS_PERFORMANCE",
            ));
        }
        let trial_params = json!({"graduation_strategy": graduation_strategy}).to_string();
        let data = [
            ("media_type", "REELS".to_string()),
            ("video_url", media_url.to_string()),
            ("caption", caption.to_string()),
            ("trial_params", trial_params),
        ];
        let response = self
            .request_json(Method::POST, &self.endpoint("media"), Some(&data))
            .await?;
        response
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| MetaError::new("Meta did not return a Reel container id"))
    }

    pub async fn create_post_container(
        &self,
        image_url: &str,
        caption: &str,
    ) -> Result<String, MetaError> {
        let data = [
            ("image_url", image_url.to_string()),
            ("caption", caption.to_string()),
        ];
        let response = self
            .request_json(Method::POST, &self.endpoint("media"), Some(&data))
            .await?;
        response
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| MetaError::new("Meta did not return a post container id"))
    }

    async fn create_carousel_item_container(
        &self,
        media_url: &str,
        media_kind: &str,
    ) -> Result<String, MetaError> {
        let mut data = vec![("is_carousel_item", "true".to_string())];
        match media_kind {
            "image" => data.push(("image_url", media_url.to_string())),
            "video" => {
                data.push(("media_type", "VIDEO".to_string()));
                data.push(("video_url", media_url.to_string()));
            }
            _ => return Err(MetaError::new("carousel media must be an image or video")),
        }
        let response = self
            .request_json(Method::POST, &self.endpoint("media"), Some(data.as_slice()))
            .await?;
        response
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| MetaError::new("Meta did not return a carousel item container id"))
    }

    async fn create_carousel_container(
        &self,
        child_container_ids: &[String],
        caption: &str,
    ) -> Result<String, MetaError> {
        let data = [
            ("media_type", "CAROUSEL".to_string()),
            ("children", child_container_ids.join(",")),
            ("caption", caption.to_string()),
        ];
        let response = self
            .request_json(Method::POST, &self.endpoint("media"), Some(&data))
            .await?;
        response
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| MetaError::new("Meta did not return a carousel container id"))
    }

    async fn wait_until_ready(
        &self,
        container_id: &str,
        timeout: Duration,
    ) -> Result<(), MetaError> {
        let deadline = tokio::time::Instant::now() + timeout;
        let mut last_status: String;
        loop {
            let mut url = Url::parse(&format!(
                "{}?fields=status_code,status",
                self.container_endpoint(container_id)
            ))
            .map_err(|_| MetaError::new("Meta container URL is invalid"))?;
            url.set_query(Some("fields=status_code,status"));
            let response = self.request_json(Method::GET, url.as_str(), None).await?;
            last_status = response
                .get("status_code")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_ascii_uppercase();
            if last_status == "FINISHED" {
                return Ok(());
            }
            if matches!(last_status.as_str(), "ERROR" | "EXPIRED") {
                let detail = response
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim();
                let detail = redact(detail, &self.access_token);
                let message = if detail.is_empty() {
                    format!("Meta container status: {last_status}")
                } else {
                    format!("Meta container status: {last_status} — {detail}")
                };
                return Err(MetaError::new(message).with_container(container_id));
            }
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                break;
            }
            tokio::time::sleep(Duration::from_secs(20).min(remaining)).await;
        }
        Err(
            MetaError::new(format!("Meta container did not finish: {last_status}"))
                .with_container(container_id),
        )
    }

    async fn publish_container(&self, container_id: &str) -> Result<String, MetaError> {
        let data = [("creation_id", container_id.to_string())];
        let response = self
            .request_json(Method::POST, &self.endpoint("media_publish"), Some(&data))
            .await?;
        response
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| MetaError::new("Meta did not return a published media id"))
    }

    pub async fn publish_story(
        &self,
        media_url: &str,
        media_kind: &str,
    ) -> Result<(String, String), MetaError> {
        let container_id = self.create_story_container(media_url, media_kind).await?;
        self.wait_until_ready(&container_id, Duration::from_secs(300))
            .await
            .map_err(|error| MetaError {
                message: error.message,
                container_id: Some(container_id.clone()),
            })?;
        let media_id = self
            .publish_container(&container_id)
            .await
            .map_err(|error| MetaError {
                message: error.message,
                container_id: Some(container_id.clone()),
            })?;
        Ok((media_id, container_id))
    }

    pub async fn publish_post(
        &self,
        image_url: &str,
        caption: &str,
    ) -> Result<(String, String), MetaError> {
        let container_id = self.create_post_container(image_url, caption).await?;
        self.wait_until_ready(&container_id, Duration::from_secs(300))
            .await
            .map_err(|error| MetaError {
                message: error.message,
                container_id: Some(container_id.clone()),
            })?;
        let media_id = self
            .publish_container(&container_id)
            .await
            .map_err(|error| MetaError {
                message: error.message,
                container_id: Some(container_id.clone()),
            })?;
        Ok((media_id, container_id))
    }

    pub async fn publish_carousel(
        &self,
        media_items: &[(&str, &str)],
        caption: &str,
    ) -> Result<(String, String), MetaError> {
        if !(2..=10).contains(&media_items.len()) {
            return Err(MetaError::new("carousel must contain between 2 and 10 items"));
        }
        let mut child_container_ids = Vec::with_capacity(media_items.len());
        for (media_url, media_kind) in media_items {
            child_container_ids.push(
                self.create_carousel_item_container(media_url, media_kind)
                    .await?,
            );
        }
        try_join_all(child_container_ids.iter().map(|container_id| async move {
            self.wait_until_ready(container_id, Duration::from_secs(300))
                .await
                .map_err(|error| MetaError {
                    message: error.message,
                    container_id: Some(container_id.clone()),
                })
        }))
        .await?;

        let container_id = self
            .create_carousel_container(&child_container_ids, caption)
            .await?;
        self.wait_until_ready(&container_id, Duration::from_secs(300))
            .await
            .map_err(|error| MetaError {
                message: error.message,
                container_id: Some(container_id.clone()),
            })?;
        let media_id = self
            .publish_container(&container_id)
            .await
            .map_err(|error| MetaError {
                message: error.message,
                container_id: Some(container_id.clone()),
            })?;
        Ok((media_id, container_id))
    }

    pub async fn publish_feed_reel(
        &self,
        media_url: &str,
        caption: &str,
    ) -> Result<(String, String), MetaError> {
        let data = [
            ("media_type", "REELS".to_string()),
            ("video_url", media_url.to_string()),
            ("caption", caption.to_string()),
            ("share_to_feed", "true".to_string()),
        ];
        let response = self
            .request_json(Method::POST, &self.endpoint("media"), Some(&data))
            .await?;
        let container_id = response
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| MetaError::new("Meta did not return a Reel container id"))?;
        self.wait_until_ready(&container_id, Duration::from_secs(300))
            .await
            .map_err(|error| MetaError {
                message: error.message,
                container_id: Some(container_id.clone()),
            })?;
        let media_id = self
            .publish_container(&container_id)
            .await
            .map_err(|error| MetaError {
                message: error.message,
                container_id: Some(container_id.clone()),
            })?;
        Ok((media_id, container_id))
    }

    pub async fn publish_reel(
        &self,
        media_url: &str,
        caption: &str,
        graduation_strategy: &str,
    ) -> Result<(String, String), MetaError> {
        let container_id = self
            .create_reel_container(media_url, caption, graduation_strategy)
            .await?;
        self.wait_until_ready(&container_id, Duration::from_secs(300))
            .await
            .map_err(|error| MetaError {
                message: error.message,
                container_id: Some(container_id.clone()),
            })?;
        let media_id = self
            .publish_container(&container_id)
            .await
            .map_err(|error| MetaError {
                message: error.message,
                container_id: Some(container_id.clone()),
            })?;
        Ok((media_id, container_id))
    }

    pub async fn get_profile(&self) -> Result<Value, MetaError> {
        let url = format!(
            "{}/{}/{}?fields=id,username,name,profile_picture_url,followers_count,media_count",
            self.base_url, self.api_version, self.instagram_user_id
        );
        self.request_json(Method::GET, &url, None).await
    }

    pub async fn get_recent_media(&self, limit: usize) -> Result<Vec<Value>, MetaError> {
        let url = format!(
            "{}?fields=id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count&limit={limit}",
            self.endpoint("media")
        );
        let response = self.request_json(Method::GET, &url, None).await?;
        Ok(response
            .get("data")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default())
    }

    pub async fn get_account_insights(
        &self,
        metrics: &[&str],
        since: i64,
        until: i64,
    ) -> Result<std::collections::HashMap<String, i64>, MetaError> {
        const SUPPORTED: &[&str] = &[
            "views",
            "reach",
            "accounts_engaged",
            "total_interactions",
            "likes",
            "comments",
            "shares",
            "saves",
            "replies",
            "follows_and_unfollows",
            "profile_links_taps",
        ];
        if metrics.is_empty() || metrics.iter().any(|metric| !SUPPORTED.contains(metric)) {
            return Err(MetaError::new(
                "unsupported Instagram account insight metric",
            ));
        }
        if until <= since {
            return Err(MetaError::new(
                "Instagram insight end must be after its start",
            ));
        }
        let mut url = Url::parse(&self.endpoint("insights"))
            .map_err(|_| MetaError::new("Instagram insights URL is invalid"))?;
        url.query_pairs_mut()
            .append_pair("metric", &metrics.join(","))
            .append_pair("period", "day")
            .append_pair("metric_type", "total_value")
            .append_pair("since", &since.to_string())
            .append_pair("until", &until.to_string());
        let response = self.request_json(Method::GET, url.as_str(), None).await?;
        let rows = response
            .get("data")
            .and_then(Value::as_array)
            .ok_or_else(|| MetaError::new("Meta returned an invalid account insights response"))?;
        let mut results = std::collections::HashMap::new();
        for row in rows {
            let Some(name) = row.get("name").and_then(Value::as_str) else {
                continue;
            };
            if !metrics.contains(&name) {
                continue;
            }
            if let Some(value) = row.pointer("/total_value/value").and_then(value_as_integer) {
                results.insert(name.to_string(), value);
            }
        }
        if let Some(missing) = metrics
            .iter()
            .find(|metric| !results.contains_key(**metric))
        {
            return Err(MetaError::new(format!(
                "Meta did not return account insight metric: {missing}"
            )));
        }
        Ok(results)
    }

    pub async fn get_follower_changes(
        &self,
        since: i64,
        until: i64,
    ) -> Result<(i64, i64), MetaError> {
        if until <= since {
            return Err(MetaError::new(
                "Instagram insight end must be after its start",
            ));
        }
        let mut url = Url::parse(&self.endpoint("insights"))
            .map_err(|_| MetaError::new("Instagram insights URL is invalid"))?;
        url.query_pairs_mut()
            .append_pair("metric", "follows_and_unfollows")
            .append_pair("period", "day")
            .append_pair("metric_type", "total_value")
            .append_pair("breakdown", "follow_type")
            .append_pair("since", &since.to_string())
            .append_pair("until", &until.to_string());

        let response = self.request_json(Method::GET, url.as_str(), None).await?;
        let rows = response
            .get("data")
            .and_then(Value::as_array)
            .ok_or_else(|| MetaError::new("Meta returned an invalid follower insights response"))?;
        let row = rows
            .iter()
            .find(|row| row.get("name").and_then(Value::as_str) == Some("follows_and_unfollows"))
            .ok_or_else(|| MetaError::new("Meta did not return follows_and_unfollows"))?;
        let mut breakdowns = Vec::new();
        collect_insight_breakdowns(row, &mut breakdowns);
        if breakdowns.is_empty() {
            return Err(MetaError::new("Meta did not return follower breakdown values"));
        }

        let mut follow_type_breakdown_found = false;
        let mut gained = 0_i64;
        let mut lost = 0_i64;
        let mut gained_found = false;
        let mut lost_found = false;
        for breakdown in &breakdowns {
            let keys = breakdown
                .get("dimension_keys")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or_default();
            let Some(dimension_index) = keys
                .iter()
                .position(|key| key.as_str().is_some_and(|key| key.eq_ignore_ascii_case("follow_type")))
                .or_else(|| (keys.len() == 1).then_some(0))
            else {
                continue;
            };
            follow_type_breakdown_found = true;

            let results = breakdown
                .get("results")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or_default();
            for result in results {
                let follow_type = result
                    .get("dimension_values")
                    .and_then(Value::as_array)
                    .and_then(|values| values.get(dimension_index))
                    .and_then(Value::as_str)
                    .or_else(|| result.get("follow_type").and_then(Value::as_str))
                    .unwrap_or("")
                    .to_ascii_lowercase()
                    .replace('-', "_")
                    .replace(' ', "_");
                let Some(count) = result.get("value").and_then(value_as_integer) else {
                    continue;
                };
                match follow_type.as_str() {
                    "follow" | "follows" | "followed" | "follower" | "new_followers" | "gained" => {
                        gained = gained.saturating_add(count);
                        gained_found = true;
                    }
                    "unfollow"
                    | "unfollows"
                    | "unfollowed"
                    | "unfollower"
                    | "non_follower"
                    | "lost" => {
                        lost = lost.saturating_add(count);
                        lost_found = true;
                    }
                    _ => {}
                }
            }
        }

        if !follow_type_breakdown_found {
            return Err(MetaError::new("Meta did not return the follow_type breakdown"));
        }
        if !gained_found && !lost_found {
            return Err(MetaError::new("Meta did not return follow_type counts for this period"));
        }
        Ok((gained, lost))
    }

    pub async fn get_media_views(&self, media_id: &str) -> Result<i64, MetaError> {
        let url = format!(
            "{}/insights?metric=views",
            self.container_endpoint(media_id)
        );
        let response = self.request_json(Method::GET, &url, None).await?;
        let rows = response
            .get("data")
            .and_then(Value::as_array)
            .ok_or_else(|| MetaError::new("Meta returned an invalid media insights response"))?;
        let row = rows
            .iter()
            .find(|row| row.get("name").and_then(Value::as_str) == Some("views"))
            .ok_or_else(|| MetaError::new("Meta did not return media views"))?;
        let value = row
            .pointer("/total_value/value")
            .and_then(value_as_integer)
            .or_else(|| row.pointer("/values/0/value").and_then(value_as_integer))
            .ok_or_else(|| MetaError::new("Meta returned an invalid media views value"))?;
        Ok(value)
    }
}

fn collect_insight_breakdowns<'a>(value: &'a Value, output: &mut Vec<&'a Value>) {
    match value {
        Value::Object(object) => {
            if object.contains_key("dimension_keys") {
                output.push(value);
            }
            for child in object.values() {
                collect_insight_breakdowns(child, output);
            }
        }
        Value::Array(values) => {
            for child in values {
                collect_insight_breakdowns(child, output);
            }
        }
        _ => {}
    }
}

fn value_as_integer(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_f64().map(|number| number as i64))
}

fn redact(message: &str, token: &str) -> String {
    if token.is_empty() {
        message.to_string()
    } else {
        message.replace(token, "[redacted]")
    }
}
