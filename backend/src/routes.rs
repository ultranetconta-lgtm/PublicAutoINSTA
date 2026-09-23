use crate::{
    app::{self, AppState, UploadedMedia, WorkflowError, public_schedule},
    media::{self, MAX_FORM_FIELD_BYTES, MAX_UPLOAD_BYTES},
};
use axum::{
    Router,
    body::Body,
    extract::{FromRequest, Multipart, Path, Query, State},
    http::{HeaderMap, Method, Request, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, patch, post},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::HashMap;
use tempfile::NamedTempFile;
use tower::ServiceExt;
use tower_http::services::ServeDir;

pub fn build_router(state: AppState) -> Router {
    Router::new()
        .route("/api/health", get(health))
        .route("/api/schedules", get(list_schedules))
        .route("/api/analytics", get(analytics))
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

async fn list_schedules(State(state): State<AppState>) -> Response {
    match state.store.list().await {
        Ok(records) => json_response(
            StatusCode::OK,
            json!({ "schedules": records.into_iter().filter_map(|record| public_schedule(Some(record))).collect::<Vec<_>>() }),
        ),
        Err(error) => internal_error(error),
    }
}

#[derive(Deserialize)]
struct AnalyticsQuery {
    #[serde(default = "default_period")]
    period: String,
    #[serde(default)]
    refresh: String,
}

fn default_period() -> String {
    "30d".into()
}

async fn analytics(State(state): State<AppState>, Query(query): Query<AnalyticsQuery>) -> Response {
    match state.analytics(&query.period, query.refresh == "1").await {
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

async fn create_story(State(state): State<AppState>, request: Request<Body>) -> Response {
    create_publication(state, request, false).await
}

async fn create_reel(State(state): State<AppState>, request: Request<Body>) -> Response {
    create_publication(state, request, true).await
}

async fn create_publication(state: AppState, request: Request<Body>, reel: bool) -> Response {
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
    let mut media_file: Option<UploadedMedia> = None;
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
            media_file = Some(UploadedMedia {
                filename,
                content_type: field_content_type,
                size,
                temp_path,
            });
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

    let result = if reel {
        state.create_reel(fields, media_file).await
    } else {
        state.create_story(fields, media_file).await
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
    headers: HeaderMap,
    body: Body,
) -> Response {
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
    let Some(current) = schedules
        .into_iter()
        .find(|record| record.get("id").and_then(Value::as_str) == Some(&schedule_id))
    else {
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
        Ok(Some(record)) => json_response(
            StatusCode::OK,
            json!({"schedule":public_schedule(Some(record))}),
        ),
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
) -> Response {
    match state.store.delete(&schedule_id).await {
        Ok(deleted) => json_response(
            if deleted {
                StatusCode::OK
            } else {
                StatusCode::NOT_FOUND
            },
            json!({"deleted":deleted}),
        ),
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
