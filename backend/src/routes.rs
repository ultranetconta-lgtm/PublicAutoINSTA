use crate::{
    app::{self, AppState, UploadedMedia, WorkflowError, public_schedule},
    media::{self, MAX_FORM_FIELD_BYTES, MAX_UPLOAD_BYTES},
    meta::MetaClient,
};
use axum::{
    Router,
    body::{Body, to_bytes},
    extract::{FromRequest, Json, Multipart, Path, Query, State},
    http::{HeaderMap, Method, Request, StatusCode, header},
    response::{Html, IntoResponse, Response},
    routing::{get, patch, post},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{collections::HashMap, sync::Arc};
use tempfile::NamedTempFile;
use tower::ServiceExt;
use tower_http::services::ServeDir;

pub fn build_router(state: AppState) -> Router {
    Router::new()
        .route("/api/health", get(health))
        .route("/api/accounts", get(list_accounts).post(connect_account))
        .route("/api/account-profile", get(account_profile))
        .route("/api/schedules", get(list_schedules))
        .route("/api/analytics", get(analytics))
        .route("/api/comments", get(comments))
        .route("/api/comments/replies", post(reply_to_comments))
        .route("/api/comments/{comment_id}/reply", post(reply_to_comment))
        .route("/api/plugin/health", get(plugin_health))
        .route("/api/plugin/summary", get(plugin_summary))
        .route(
            "/webhooks/instagram",
            get(verify_instagram_webhook).post(receive_instagram_webhook),
        )
        .route("/privacy-policy", get(privacy_policy))
        .route("/api/posts", post(create_post))
        .route("/api/carousels", post(create_carousel))
        .route("/api/stories", post(create_story))
        .route("/api/reels", post(create_reel))
        .route(
            "/api/schedules/{id}",
            patch(update_schedule).delete(delete_schedule),
        )
        .route("/media/{filename}", get(get_media).head(head_media))
        .fallback(static_or_not_found)
        .layer(axum::extract::DefaultBodyLimit::max(
            MAX_UPLOAD_BYTES as usize + 64 * 1024,
        ))
        .with_state(state)
}

async fn health(State(state): State<AppState>) -> Response {
    json_response(StatusCode::OK, state.health())
}

async fn privacy_policy() -> Html<&'static str> {
    Html(include_str!("privacy_policy.html"))
}

#[derive(Deserialize, Default)]
struct InstagramWebhookVerification {
    #[serde(rename = "hub.mode")]
    mode: Option<String>,
    #[serde(rename = "hub.verify_token")]
    verify_token: Option<String>,
    #[serde(rename = "hub.challenge")]
    challenge: Option<String>,
}

async fn verify_instagram_webhook(
    State(state): State<AppState>,
    Query(query): Query<InstagramWebhookVerification>,
) -> Response {
    if query.mode.is_none() && query.verify_token.is_none() && query.challenge.is_none() {
        return (
            StatusCode::OK,
            "Instagram webhook endpoint ativo; a Meta usa parâmetros hub.* para verificar a URL.",
        )
            .into_response();
    }
    let (Some(mode), Some(verify_token), Some(challenge)) = (
        query.mode.as_deref(),
        query.verify_token.as_deref(),
        query.challenge,
    ) else {
        return (
            StatusCode::BAD_REQUEST,
            "Parâmetros incompletos: hub.mode, hub.verify_token e hub.challenge são obrigatórios.",
        )
            .into_response();
    };
    let expected_token = &state.config.meta_webhook_verify_token;
    if expected_token.is_empty() {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    if mode != "subscribe" || !constant_time_eq(expected_token, verify_token) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let mut response = (StatusCode::OK, challenge).into_response();
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        "no-store".parse().expect("static cache-control header"),
    );
    response
}

const MAX_INSTAGRAM_WEBHOOK_BYTES: usize = 256 * 1024;

async fn receive_instagram_webhook(
    State(state): State<AppState>,
    request: Request<Body>,
) -> Response {
    let content_length = request
        .headers()
        .get(header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok());
    tracing::info!(
        content_length,
        signature_present = request.headers().contains_key("x-hub-signature-256"),
        "Instagram webhook POST received"
    );
    let Some(signature) = request
        .headers()
        .get("x-hub-signature-256")
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned)
    else {
        tracing::warn!("Rejected Instagram webhook without signature");
        return StatusCode::FORBIDDEN.into_response();
    };
    if state.config.meta_app_secret.is_empty() {
        tracing::error!("Instagram webhook App Secret is not configured");
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    let body = match to_bytes(request.into_body(), MAX_INSTAGRAM_WEBHOOK_BYTES).await {
        Ok(body) => body,
        Err(_) => {
            tracing::warn!("Rejected oversized Instagram webhook payload");
            return StatusCode::PAYLOAD_TOO_LARGE.into_response();
        }
    };
    if !valid_meta_signature(&state.config.meta_app_secret, &body, &signature) {
        tracing::warn!("Rejected Instagram webhook with invalid signature");
        return StatusCode::FORBIDDEN.into_response();
    }
    let payload: Value = match serde_json::from_slice(&body) {
        Ok(payload) => payload,
        Err(_) => {
            tracing::warn!("Rejected Instagram webhook with invalid JSON");
            return StatusCode::BAD_REQUEST.into_response();
        }
    };
    if payload.get("object").and_then(Value::as_str) != Some("instagram")
        || !payload.get("entry").is_some_and(Value::is_array)
    {
        tracing::warn!("Rejected Instagram webhook with unexpected payload shape");
        return StatusCode::BAD_REQUEST.into_response();
    }
    let fields: Vec<&str> = payload["entry"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|entry| entry["changes"].as_array().into_iter().flatten())
        .filter_map(|change| change["field"].as_str())
        .collect();
    tracing::info!(
        entries = payload["entry"].as_array().map_or(0, Vec::len),
        fields = ?fields,
        "Verified Instagram webhook received"
    );
    (StatusCode::OK, "EVENT_RECEIVED").into_response()
}

fn valid_meta_signature(secret: &str, body: &[u8], signature: &str) -> bool {
    use hmac::{Hmac, Mac};
    use sha2::Sha256;

    let Some(signature_hex) = signature.strip_prefix("sha256=") else {
        return false;
    };
    if signature_hex.len() != 64 {
        return false;
    }
    let mut signature_bytes = [0_u8; 32];
    for (index, pair) in signature_hex.as_bytes().chunks_exact(2).enumerate() {
        let Ok(pair) = std::str::from_utf8(pair) else {
            return false;
        };
        let Ok(byte) = u8::from_str_radix(pair, 16) else {
            return false;
        };
        signature_bytes[index] = byte;
    }
    let Ok(mut mac) = Hmac::<Sha256>::new_from_slice(secret.as_bytes()) else {
        return false;
    };
    mac.update(body);
    mac.verify_slice(&signature_bytes).is_ok()
}

fn constant_time_eq(expected: &str, provided: &str) -> bool {
    let expected = expected.as_bytes();
    let provided = provided.as_bytes();
    if expected.len() != provided.len() {
        return false;
    }
    expected
        .iter()
        .zip(provided)
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

#[derive(Deserialize)]
struct ConnectAccountRequest {
    access_token: String,
}

async fn list_accounts(State(state): State<AppState>) -> Response {
    match state.connected_accounts().await {
        Ok(accounts) => json_response(StatusCode::OK, json!({"accounts":accounts})),
        Err(error) => internal_error(error),
    }
}

async fn account_profile(
    State(state): State<AppState>,
    Query(query): Query<AccountQuery>,
) -> Response {
    let Some(account_id) = query
        .account_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
    else {
        return json_response(
            StatusCode::BAD_REQUEST,
            json!({"ok": false, "error": "instagram_account_required"}),
        );
    };
    match state.account_profile_picture_url(account_id).await {
        Ok(profile_picture_url) => json_response(
            StatusCode::OK,
            json!({"profile_picture_url": profile_picture_url}),
        ),
        Err(error) => workflow_error(error),
    }
}

async fn connect_account(
    State(state): State<AppState>,
    Json(payload): Json<ConnectAccountRequest>,
) -> Response {
    match state.connect_account(&payload.access_token).await {
        Ok(account) => json_response(StatusCode::CREATED, json!({"account":account})),
        Err(error) => workflow_error(error),
    }
}

#[derive(Deserialize, Default)]
struct AccountQuery {
    account_id: Option<String>,
}

#[derive(Deserialize, Default)]
struct CommentsQuery {
    account_id: Option<String>,
    #[serde(default)]
    probe: bool,
    media_id: Option<String>,
}

async fn schedule_account_id(
    state: &AppState,
    query: &AccountQuery,
) -> Result<Option<String>, WorkflowError> {
    if query
        .account_id
        .as_deref()
        .is_none_or(|id| id.trim().is_empty())
        && state
            .connected_accounts()
            .await
            .map_err(WorkflowError::internal)?
            .is_empty()
    {
        return Ok(None);
    }
    state
        .resolve_account(query.account_id.as_deref())
        .await
        .map(|account| Some(account.id))
}

fn matches_schedule_account(state: &AppState, record: &Value, account_id: Option<&str>) -> bool {
    match account_id {
        Some(account_id) => state.schedule_belongs_to_account(record, account_id),
        None => record.get("account_id").and_then(Value::as_str).is_none(),
    }
}

async fn list_schedules(
    State(state): State<AppState>,
    Query(query): Query<AccountQuery>,
) -> Response {
    let account_id = match schedule_account_id(&state, &query).await {
        Ok(account_id) => account_id,
        Err(error) => return workflow_error(error),
    };
    match state.store.list().await {
        Ok(records) => json_response(
            StatusCode::OK,
            json!({ "schedules": records.into_iter().filter(|record| matches_schedule_account(&state, record, account_id.as_deref())).filter_map(|record| public_schedule(Some(record))).collect::<Vec<_>>() }),
        ),
        Err(error) => internal_error(error),
    }
}

#[derive(Deserialize)]
struct AnalyticsQuery {
    account_id: Option<String>,
    #[serde(default = "default_period")]
    period: String,
    #[serde(default)]
    refresh: String,
}

#[derive(Deserialize, Default)]
struct PluginSummaryQuery {
    days: Option<u8>,
}

async fn plugin_health(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Some(response) = plugin_auth_error(&state, &headers) {
        return response;
    }
    match state.connected_accounts().await {
        Ok(accounts) => json_response(
            StatusCode::OK,
            json!({
                "ok": true,
                "authenticated": true,
                "configured": !accounts.is_empty(),
                "account": accounts.first().map(|account| json!({"username": account.username, "igUserId": account.id})).unwrap_or(Value::Null),
            }),
        ),
        Err(error) => internal_error(error),
    }
}

async fn plugin_summary(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<PluginSummaryQuery>,
) -> Response {
    if let Some(response) = plugin_auth_error(&state, &headers) {
        return response;
    }
    let days = query.days.unwrap_or(7);
    let period = match days {
        1 => "today",
        7 => "7d",
        30 => "30d",
        _ => {
            return json_response(
                StatusCode::BAD_REQUEST,
                json!({"ok": false, "error": "unsupported_period", "message": "days must be 1, 7, or 30"}),
            );
        }
    };
    let account = match state.resolve_account(None).await {
        Ok(account) => account,
        Err(error) => return workflow_error(error),
    };
    match state.analytics(&account.id, period, false).await {
        Ok(analytics) => json_response(StatusCode::OK, json!({"ok": true, "analytics": analytics})),
        Err(_) => json_response(
            StatusCode::BAD_GATEWAY,
            json!({
                "ok": false,
                "error": "meta_insights_unavailable",
                "message": "A Meta não retornou Insights atuais. Tente novamente mais tarde."
            }),
        ),
    }
}

fn plugin_auth_error(state: &AppState, headers: &HeaderMap) -> Option<Response> {
    if state.config.plugin_api_key.is_empty() {
        return Some(json_response(
            StatusCode::SERVICE_UNAVAILABLE,
            json!({"ok": false, "error": "plugin_auth_not_configured"}),
        ));
    }
    let provided = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .unwrap_or("");
    if constant_time_equal(provided.as_bytes(), state.config.plugin_api_key.as_bytes()) {
        None
    } else {
        Some(json_response(
            StatusCode::UNAUTHORIZED,
            json!({"ok": false, "error": "plugin_unauthorized"}),
        ))
    }
}

fn constant_time_equal(left: &[u8], right: &[u8]) -> bool {
    let mut difference = left.len() ^ right.len();
    for index in 0..left.len().max(right.len()) {
        difference |= usize::from(
            left.get(index).copied().unwrap_or(0) ^ right.get(index).copied().unwrap_or(0),
        );
    }
    difference == 0
}

fn default_period() -> String {
    "30d".into()
}

async fn analytics(State(state): State<AppState>, Query(query): Query<AnalyticsQuery>) -> Response {
    let account = match state.resolve_account(query.account_id.as_deref()).await {
        Ok(account) => account,
        Err(error) => return workflow_error(error),
    };
    match state
        .analytics(&account.id, &query.period, query.refresh == "1")
        .await
    {
        Ok(payload) => json_response(StatusCode::OK, payload),
        Err(_) => json_response(
            StatusCode::BAD_GATEWAY,
            json!({
                "ok": false,
                "error": "meta_insights_unavailable",
                "message": "A Meta não retornou Insights atuais. Atualize novamente em instantes."
            }),
        ),
    }
}

async fn comments(State(state): State<AppState>, Query(query): Query<CommentsQuery>) -> Response {
    let account = match state.resolve_account(query.account_id.as_deref()).await {
        Ok(account) => account,
        Err(error) => return workflow_error(error),
    };
    if query.probe {
        return match state
            .comments_probe(&account.id, query.media_id.as_deref())
            .await
        {
            Ok(payload) => json_response(
                StatusCode::OK,
                json!({"ok": true, "account": {"id": account.id, "username": account.username}, "probe": payload}),
            ),
            Err(error) => json_response(
                StatusCode::BAD_GATEWAY,
                json!({"ok": false, "error": "instagram_comments_probe_failed", "message": error.message}),
            ),
        };
    }
    match state.comments(&account.id).await {
        Ok(payload) => json_response(
            StatusCode::OK,
            json!({
                "ok": true,
                "account": {"id": account.id, "username": account.username},
                "posts": payload.get("posts").cloned().unwrap_or_else(|| json!([])),
                "reported_comments": payload.get("reported_comments").cloned().unwrap_or_else(|| json!(0)),
                "retrieved_comments": payload.get("retrieved_comments").cloned().unwrap_or_else(|| json!(0)),
                "comments_incomplete": payload.get("comments_incomplete").and_then(Value::as_bool).unwrap_or(false),
                "failed_publications": payload.get("failed_publications").cloned().unwrap_or_else(|| json!(0)),
                "empty_comment_edges": payload.get("empty_comment_edges").cloned().unwrap_or_else(|| json!(0)),
                "required_permission": if state.config.graph_api_base_url.contains("graph.instagram.com") { "instagram_business_manage_comments" } else { "instagram_manage_comments" },
            }),
        ),
        Err(error) => json_response(
            StatusCode::BAD_GATEWAY,
            json!({
                "ok": false,
                "error": "instagram_comments_unavailable",
                "message": error.message,
            }),
        ),
    }
}

#[derive(Deserialize)]
struct CommentReplyRequest {
    account_id: String,
    message: String,
}

#[derive(Deserialize)]
struct CommentBatchReply {
    comment_id: String,
    message: String,
}

#[derive(Deserialize)]
struct CommentBatchReplyRequest {
    account_id: String,
    replies: Vec<CommentBatchReply>,
}

const MAX_COMMENT_REPLIES_PER_REQUEST: usize = 50;

async fn reply_to_comments(
    State(state): State<AppState>,
    Json(payload): Json<CommentBatchReplyRequest>,
) -> Response {
    let account_id = payload.account_id.trim();
    if account_id.is_empty() {
        return json_response(
            StatusCode::BAD_REQUEST,
            json!({"ok": false, "error": "instagram_account_required", "message": "Selecione uma conta do Instagram."}),
        );
    }
    if payload.replies.is_empty() || payload.replies.len() > MAX_COMMENT_REPLIES_PER_REQUEST {
        return json_response(
            StatusCode::BAD_REQUEST,
            json!({"ok": false, "error": "invalid_comment_reply_batch", "message": "A API aceita até 50 respostas por chamada."}),
        );
    }

    let mut seen_ids = std::collections::HashSet::with_capacity(payload.replies.len());
    let mut replies = Vec::with_capacity(payload.replies.len());
    for reply in payload.replies {
        let comment_id = reply.comment_id.trim();
        let message = reply.message.trim();
        if comment_id.is_empty()
            || comment_id.len() > 128
            || !comment_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
            || !seen_ids.insert(comment_id.to_string())
        {
            return json_response(
                StatusCode::BAD_REQUEST,
                json!({"ok": false, "error": "invalid_comment_id", "message": "Há um identificador de comentário inválido ou repetido."}),
            );
        }
        if message.is_empty() || message.chars().count() > 2200 {
            return json_response(
                StatusCode::BAD_REQUEST,
                json!({"ok": false, "error": "invalid_comment_reply", "message": "Cada resposta deve conter até 2.200 caracteres e não pode ficar vazia."}),
            );
        }
        replies.push((comment_id.to_string(), message.to_string()));
    }

    let account = match state.resolve_account(Some(account_id)).await {
        Ok(account) => account,
        Err(error) => return workflow_error(error),
    };
    let Some(service) = state.service_for_account(&account.id).await else {
        return json_response(
            StatusCode::BAD_REQUEST,
            json!({"ok": false, "error": "instagram_account_not_found", "message": "A conta selecionada não está conectada neste planejador."}),
        );
    };
    send_comment_reply_batch(&state, &account.id, &account.username, &service, &replies).await
}

async fn send_comment_reply_batch(
    state: &AppState,
    account_id: &str,
    account_username: &str,
    service: &MetaClient,
    replies: &[(String, String)],
) -> Response {
    let account_lock = {
        let mut locks = state.comment_reply_locks.lock().await;
        Arc::clone(
            locks
                .entry(account_id.to_string())
                .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(()))),
        )
    };
    let _account_guard = account_lock.lock().await;
    let already_sent = state.sent_comment_replies.lock().await;
    let sent_ids: std::collections::HashSet<String> = replies
        .iter()
        .filter(|(comment_id, _)| {
            already_sent.contains(&(account_id.to_string(), comment_id.clone()))
        })
        .map(|(comment_id, _)| comment_id.clone())
        .collect();
    drop(already_sent);

    let candidates: Vec<(String, String)> = replies
        .iter()
        .filter(|(comment_id, _)| !sent_ids.contains(comment_id))
        .cloned()
        .collect();
    let mut results_by_id = HashMap::with_capacity(replies.len());
    for comment_id in &sent_ids {
        results_by_id.insert(
            comment_id.clone(),
            json!({
                "comment_id": comment_id,
                "ok": false,
                "blocked": true,
                "already_replied": true,
                "message": "Este comentário já recebeu uma resposta deste planejador; bloqueei a duplicata.",
            }),
        );
    }

    if !candidates.is_empty() {
        match service
            .reply_to_comments(&candidates, account_username)
            .await
        {
            Ok(results) => {
                let successful_ids: Vec<String> = results
                    .iter()
                    .filter(|result| result["ok"] == true)
                    .filter_map(|result| result["comment_id"].as_str().map(str::to_owned))
                    .collect();
                if !successful_ids.is_empty() {
                    let mut sent = state.sent_comment_replies.lock().await;
                    sent.extend(
                        successful_ids
                            .into_iter()
                            .map(|comment_id| (account_id.to_string(), comment_id)),
                    );
                }
                for result in results {
                    if let Some(comment_id) = result["comment_id"].as_str() {
                        results_by_id.insert(comment_id.to_string(), result);
                    }
                }
            }
            Err(error) => {
                return json_response(
                    StatusCode::BAD_GATEWAY,
                    json!({"ok": false, "error": "instagram_comment_reply_batch_failed", "message": error.message}),
                );
            }
        }
    }

    let results: Vec<Value> = replies
        .iter()
        .map(|(comment_id, _)| {
            results_by_id.remove(comment_id).unwrap_or_else(|| {
                json!({
                    "comment_id": comment_id,
                    "ok": false,
                    "message": "Não consegui confirmar o resultado desta resposta; revise o comentário antes de tentar novamente.",
                })
            })
        })
        .collect();
    let partial = results.iter().any(|result| result["ok"] != true);
    json_response(
        if partial {
            StatusCode::MULTI_STATUS
        } else {
            StatusCode::OK
        },
        json!({"ok": true, "partial": partial, "results": results}),
    )
}

async fn reply_to_comment(
    State(state): State<AppState>,
    Path(comment_id): Path<String>,
    Json(payload): Json<CommentReplyRequest>,
) -> Response {
    let account_id = payload.account_id.trim();
    let message = payload.message.trim();
    if account_id.is_empty() {
        return json_response(
            StatusCode::BAD_REQUEST,
            json!({"ok": false, "error": "instagram_account_required", "message": "Selecione uma conta do Instagram."}),
        );
    }
    if comment_id.is_empty()
        || comment_id.len() > 128
        || !comment_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return json_response(
            StatusCode::BAD_REQUEST,
            json!({"ok": false, "error": "invalid_comment_id", "message": "O identificador deste comentário é inválido."}),
        );
    }
    if message.is_empty() || message.chars().count() > 2200 {
        return json_response(
            StatusCode::BAD_REQUEST,
            json!({"ok": false, "error": "invalid_comment_reply", "message": "Escreva uma resposta com até 2.200 caracteres."}),
        );
    }
    let account = match state.resolve_account(Some(account_id)).await {
        Ok(account) => account,
        Err(error) => return workflow_error(error),
    };
    let Some(service) = state.service_for_account(&account.id).await else {
        return json_response(
            StatusCode::BAD_REQUEST,
            json!({"ok": false, "error": "instagram_account_not_found", "message": "A conta selecionada não está conectada neste planejador."}),
        );
    };
    send_comment_reply_batch(
        &state,
        &account.id,
        &account.username,
        &service,
        &[(comment_id, message.to_string())],
    )
    .await
}

async fn create_story(State(state): State<AppState>, request: Request<Body>) -> Response {
    create_publication(state, request, PublicationEndpoint::Story).await
}

async fn create_post(State(state): State<AppState>, request: Request<Body>) -> Response {
    create_publication(state, request, PublicationEndpoint::Post).await
}

async fn create_carousel(State(state): State<AppState>, request: Request<Body>) -> Response {
    create_publication(state, request, PublicationEndpoint::Carousel).await
}

async fn create_reel(State(state): State<AppState>, request: Request<Body>) -> Response {
    create_publication(state, request, PublicationEndpoint::Reel).await
}

#[derive(Clone, Copy)]
enum PublicationEndpoint {
    Post,
    Carousel,
    Reel,
    Story,
}

async fn create_publication(
    state: AppState,
    request: Request<Body>,
    endpoint: PublicationEndpoint,
) -> Response {
    let content_type = request
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    if !content_type
        .to_ascii_lowercase()
        .starts_with("multipart/form-data")
    {
        return workflow_error(WorkflowError::bad_request("multipart_required"));
    }
    let mut multipart = match Multipart::from_request(request, &state).await {
        Ok(multipart) => multipart,
        Err(error) => {
            let message = error.to_string().to_ascii_lowercase();
            let code = if message.contains("limit") || message.contains("too large") {
                "upload_too_large"
            } else {
                "invalid_multipart"
            };
            let mut failure = WorkflowError::bad_request(code);
            if code == "upload_too_large" {
                failure.status = StatusCode::PAYLOAD_TOO_LARGE;
            }
            return workflow_error(failure);
        }
    };
    let mut fields = HashMap::new();
    let mut media_files: Vec<UploadedMedia> = Vec::new();
    let mut total_upload_bytes = 0_u64;
    loop {
        let next = multipart.next_field().await;
        let field = match next {
            Ok(Some(field)) => field,
            Ok(None) => break,
            Err(_) => {
                return json_response(
                    StatusCode::BAD_REQUEST,
                    json!({"error":"invalid_multipart", "message":"Envie os dados em um formulário multipart válido."}),
                );
            }
        };
        let name = field.name().unwrap_or("").to_string();
        if name.is_empty() {
            continue;
        }
        let filename = field.file_name().map(portable_basename);
        let field_content_type = field
            .content_type()
            .unwrap_or("application/octet-stream")
            .to_string();
        if let Some(filename) = filename {
            let temp_file = match NamedTempFile::new_in(state.uploads_path.as_path()) {
                Ok(temp) => temp,
                Err(error) => return internal_error(error),
            };
            let temp_path = temp_file.into_temp_path();
            let remaining = MAX_UPLOAD_BYTES.saturating_sub(total_upload_bytes);
            let size =
                match media::persist_multipart_field(field, temp_path.as_ref(), remaining).await {
                    Ok(size) => size,
                    Err(error) => {
                        let code = error.to_string();
                        let code = if code.contains("upload_too_large") {
                            "upload_too_large"
                        } else {
                            "invalid_multipart"
                        };
                        let mut failure = WorkflowError::bad_request(code);
                        if code == "upload_too_large" {
                            failure.status = StatusCode::PAYLOAD_TOO_LARGE;
                        }
                        return workflow_error(failure);
                    }
                };
            total_upload_bytes += size;
            media_files.push(UploadedMedia {
                filename,
                content_type: field_content_type,
                size,
                temp_path,
            });
            let max_files = if matches!(endpoint, PublicationEndpoint::Carousel) {
                10
            } else {
                1
            };
            if media_files.len() > max_files {
                let code = if matches!(endpoint, PublicationEndpoint::Carousel) {
                    "carousel_item_count_invalid"
                } else {
                    "multiple_media_not_supported"
                };
                return workflow_error(WorkflowError::bad_request(code));
            }
        } else {
            match media::read_text_field(field, MAX_FORM_FIELD_BYTES).await {
                Ok(value) => {
                    fields.insert(name, value);
                }
                Err(_) => {
                    return workflow_error(WorkflowError::bad_request("form_field_too_large"));
                }
            }
        }
    }

    let result = match endpoint {
        PublicationEndpoint::Carousel => state.create_carousel(fields, media_files).await,
        PublicationEndpoint::Post => state.create_post(fields, media_files.pop()).await,
        PublicationEndpoint::Reel => state.create_reel(fields, media_files.pop()).await,
        PublicationEndpoint::Story => state.create_story(fields, media_files.pop()).await,
    };
    match result {
        Ok(record) => json_response(
            StatusCode::CREATED,
            json!({"story":public_schedule(Some(record))}),
        ),
        Err(error) => workflow_error(error),
    }
}

async fn update_schedule(
    State(state): State<AppState>,
    Path(schedule_id): Path<String>,
    Query(query): Query<AccountQuery>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    let account_id = match schedule_account_id(&state, &query).await {
        Ok(account_id) => account_id,
        Err(error) => return workflow_error(error),
    };
    if !headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .eq_ignore_ascii_case("application/json")
    {
        return workflow_error(WorkflowError::bad_request("json_required"));
    }
    let bytes = match axum::body::to_bytes(body, 64 * 1024).await {
        Ok(bytes) => bytes,
        Err(_) => return workflow_error(WorkflowError::bad_request("invalid_schedule_update")),
    };
    let payload: Value = match serde_json::from_slice(&bytes) {
        Ok(payload) => payload,
        Err(_) => return workflow_error(WorkflowError::bad_request("invalid_schedule_update")),
    };
    let patch = match app::validate_schedule_edit(&payload) {
        Ok(patch) => patch,
        Err(error) => return workflow_error(error),
    };
    let schedules = match state.store.list().await {
        Ok(records) => records,
        Err(error) => return internal_error(error),
    };
    let Some(current) = schedules.into_iter().find(|record| {
        record.get("id").and_then(Value::as_str) == Some(&schedule_id)
            && matches_schedule_account(&state, record, account_id.as_deref())
    }) else {
        return json_response(StatusCode::NOT_FOUND, json!({"error":"schedule_not_found"}));
    };
    if current.get("status").and_then(Value::as_str) != Some("scheduled") {
        return json_response(
            StatusCode::CONFLICT,
            json!({"error":"schedule_not_editable"}),
        );
    }
    match state
        .store
        .update(&schedule_id, &patch, Some("scheduled"))
        .await
    {
        Ok(Some(record)) => {
            state.notify_scheduler();
            json_response(
                StatusCode::OK,
                json!({"schedule":public_schedule(Some(record))}),
            )
        }
        Ok(None) => json_response(
            StatusCode::CONFLICT,
            json!({"error":"schedule_not_editable"}),
        ),
        Err(error) => internal_error(error),
    }
}

async fn delete_schedule(
    State(state): State<AppState>,
    Path(schedule_id): Path<String>,
    Query(query): Query<AccountQuery>,
) -> Response {
    let account_id = match schedule_account_id(&state, &query).await {
        Ok(account_id) => account_id,
        Err(error) => return workflow_error(error),
    };
    let schedules = match state.store.list().await {
        Ok(records) => records,
        Err(error) => return internal_error(error),
    };
    if !schedules.iter().any(|record| {
        record.get("id").and_then(Value::as_str) == Some(&schedule_id)
            && matches_schedule_account(&state, record, account_id.as_deref())
    }) {
        return json_response(StatusCode::NOT_FOUND, json!({"error":"schedule_not_found"}));
    }
    match state.store.delete(&schedule_id).await {
        Ok(deleted) => {
            if deleted {
                state.notify_scheduler();
            }
            json_response(
                if deleted {
                    StatusCode::OK
                } else {
                    StatusCode::NOT_FOUND
                },
                json!({"deleted":deleted}),
            )
        }
        Err(error) => internal_error(error),
    }
}

async fn get_media(State(state): State<AppState>, Path(filename): Path<String>) -> Response {
    media_response(state, filename, false).await
}

async fn head_media(State(state): State<AppState>, Path(filename): Path<String>) -> Response {
    media_response(state, filename, true).await
}

async fn media_response(state: AppState, filename: String, head_only: bool) -> Response {
    if !media::safe_filename(&filename) {
        return json_response(StatusCode::NOT_FOUND, json!({"error":"media_not_found"}));
    }
    let path = state.uploads_path.join(&filename);
    let metadata = match tokio::fs::metadata(&path).await {
        Ok(metadata) if metadata.is_file() => metadata,
        _ => return json_response(StatusCode::NOT_FOUND, json!({"error":"media_not_found"})),
    };
    let response = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, media::mime_for_filename(&filename))
        .header(header::CONTENT_LENGTH, metadata.len());
    if head_only {
        return response
            .body(Body::empty())
            .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response());
    }
    match media::stream_file(&path).await {
        Ok(body) => response
            .body(body)
            .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response()),
        Err(_) => json_response(StatusCode::NOT_FOUND, json!({"error":"media_not_found"})),
    }
}

async fn static_or_not_found(State(state): State<AppState>, request: Request<Body>) -> Response {
    let path = request.uri().path();
    let is_static = path == "/"
        || path == "/index.html"
        || path == "/CLIP6.mp4"
        || path.starts_with("/css/")
        || path.starts_with("/js/")
        || path.starts_with("/assets/");
    if is_static && matches!(*request.method(), Method::GET | Method::HEAD) {
        return match ServeDir::new(state.project_root.as_path())
            .oneshot(request)
            .await
        {
            Ok(response) => {
                let (parts, body) = response.into_parts();
                Response::from_parts(parts, Body::new(body))
            }
            Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        };
    }
    json_response(StatusCode::NOT_FOUND, json!({"error":"not_found"}))
}

fn workflow_error(error: WorkflowError) -> Response {
    if let Some(record) = error.record {
        json_response(
            error.status,
            json!({ "error": error.code, "message": error.message, "story": public_schedule(Some(record)) }),
        )
    } else {
        json_response(
            error.status,
            json!({ "error": error.code, "message": error.message }),
        )
    }
}

fn json_response(status: StatusCode, payload: Value) -> Response {
    let mut response = (status, axum::Json(payload)).into_response();
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        "no-store".parse().expect("static cache-control header"),
    );
    response
}

fn internal_error(error: impl std::fmt::Display) -> Response {
    json_response(
        StatusCode::INTERNAL_SERVER_ERROR,
        json!({"error":"internal_error", "message":error.to_string()}),
    )
}

fn portable_basename(filename: &str) -> String {
    filename
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("")
        .to_string()
}
