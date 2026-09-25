use api_publicacao_backend::{
    app::{
        AppConfig, AppState, build_router, parse_scheduled_at, validate_schedule_edit,
        verify_public_media,
    },
    config::build_public_media_url,
    media::persist_chunks,
    meta::MetaClient,
    store::ScheduleStore,
};
use axum::{
    body::Body,
    http::{Request, StatusCode, header},
};
use bytes::Bytes;
use futures_util::stream;
use http_body_util::BodyExt;
use serde_json::{Value, json};
use std::{fs, io, path::Path, sync::Arc};
use tempfile::TempDir;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::Mutex,
};
use tower::ServiceExt;

fn test_state(root: &Path) -> AppState {
    AppState::new(AppConfig::default(), root).expect("test app state")
}

#[tokio::test]
async fn health_exposes_safe_configuration_state() {
    let temp = TempDir::new().expect("temporary project root");
    let response = build_router(test_state(temp.path()))
        .oneshot(Request::get("/api/health").body(Body::empty()).unwrap())
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let payload: Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(payload["ok"], true);
    assert_eq!(payload["meta_configured"], false);
    assert!(payload.get("access_token").is_none());
}

#[tokio::test]
async fn health_never_returns_configured_credentials() {
    let temp = TempDir::new().expect("temporary project root");
    let config = AppConfig {
        access_token: "secret-token".into(),
        instagram_user_id: "123".into(),
        instagram_username: "account".into(),
        public_base_url: "https://public.example".into(),
        ..AppConfig::default()
    };
    let response = build_router(AppState::new(config, temp.path()).unwrap())
        .oneshot(Request::get("/api/health").body(Body::empty()).unwrap())
        .await
        .unwrap();
    let payload: Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();

    assert_eq!(payload["meta_configured"], true);
    assert_eq!(payload["public_media_configured"], true);
    assert!(!payload.to_string().contains("secret-token"));
    assert!(payload.get("access_token").is_none());
}

#[tokio::test]
async fn privacy_policy_page_is_public_and_contains_user_supplied_policy_text() {
    let temp = TempDir::new().expect("temporary project root");
    let response = build_router(test_state(temp.path()))
        .oneshot(Request::get("/privacy-policy").body(Body::empty()).unwrap())
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    assert!(
        response.headers()[header::CONTENT_TYPE]
            .to_str()
            .unwrap()
            .starts_with("text/html")
    );
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let html = String::from_utf8(body.to_vec()).unwrap();
    for expected in [
        "Política de Privacidade",
        "utilizado exclusivamente para automações internas relacionadas a uma conta comercial do Instagram",
        "comentários e mensagens",
        "não são compartilhados com terceiros",
        "Nenhuma informação pessoal é vendida ou distribuída",
        "gu95ckt02@gmail.com",
    ] {
        assert!(html.contains(expected), "missing policy text: {expected}");
    }
}

#[tokio::test]
async fn instagram_webhook_verification_returns_plain_challenge_for_matching_token() {
    let temp = TempDir::new().expect("temporary project root");
    let config = AppConfig {
        meta_webhook_verify_token: "webhook-token".into(),
        ..AppConfig::default()
    };
    let response = build_router(AppState::new(config, temp.path()).unwrap())
        .oneshot(
            Request::get(
                "/webhooks/instagram?hub.mode=subscribe&hub.verify_token=webhook-token&hub.challenge=challenge-123",
            )
            .body(Body::empty())
            .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers()[header::CONTENT_TYPE],
        "text/plain; charset=utf-8"
    );
    assert_eq!(
        response.into_body().collect().await.unwrap().to_bytes(),
        "challenge-123"
    );
}

#[tokio::test]
async fn instagram_webhook_verification_rejects_wrong_token_and_missing_configuration() {
    let temp = TempDir::new().expect("temporary project root");
    let config = AppConfig {
        meta_webhook_verify_token: "webhook-token".into(),
        ..AppConfig::default()
    };
    let response = build_router(AppState::new(config, temp.path()).unwrap())
        .oneshot(
            Request::get(
                "/webhooks/instagram?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=challenge-123",
            )
            .body(Body::empty())
            .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);

    let response = build_router(test_state(temp.path()))
        .oneshot(
            Request::get(
                "/webhooks/instagram?hub.mode=subscribe&hub.verify_token=webhook-token&hub.challenge=challenge-123",
            )
            .body(Body::empty())
            .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
}

#[tokio::test]
async fn instagram_webhook_root_returns_help_instead_of_query_deserialization_error() {
    let temp = TempDir::new().expect("temporary project root");
    let response = build_router(test_state(temp.path()))
        .oneshot(
            Request::get("/webhooks/instagram")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let body = String::from_utf8(body.to_vec()).unwrap();
    assert!(body.contains("endpoint"));
    assert!(!body.contains("deserialize"));
}

#[tokio::test]
async fn instagram_webhook_rejects_incomplete_challenge_parameters_clearly() {
    let temp = TempDir::new().expect("temporary project root");
    let response = build_router(test_state(temp.path()))
        .oneshot(
            Request::get("/webhooks/instagram?hub.mode=subscribe")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let body = String::from_utf8(body.to_vec()).unwrap();
    assert!(body.contains("hub.verify_token"));
    assert!(!body.contains("deserialize"));
}

#[tokio::test]
async fn instagram_webhook_accepts_signed_comment_events_and_rejects_bad_signatures() {
    use hmac::{Hmac, Mac};
    use sha2::Sha256;

    let temp = TempDir::new().expect("temporary project root");
    let secret = "test-app-secret";
    let body = r#"{"object":"instagram","entry":[{"id":"ig-user","changes":[{"field":"comments","value":{"id":"comment-1","text":"Test comment"}}]}]}"#;
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).unwrap();
    mac.update(body.as_bytes());
    let signature = mac.finalize().into_bytes();
    let signature = signature
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let config = AppConfig {
        meta_app_secret: secret.into(),
        ..AppConfig::default()
    };

    let response = build_router(AppState::new(config.clone(), temp.path()).unwrap())
        .oneshot(
            Request::post("/webhooks/instagram")
                .header(header::CONTENT_TYPE, "application/json")
                .header("x-hub-signature-256", format!("sha256={signature}"))
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.into_body().collect().await.unwrap().to_bytes(),
        "EVENT_RECEIVED"
    );

    let response = build_router(AppState::new(config, temp.path()).unwrap())
        .oneshot(
            Request::post("/webhooks/instagram")
                .header(header::CONTENT_TYPE, "application/json")
                .header("x-hub-signature-256", "sha256=invalid")
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn instagram_webhook_requires_app_secret_configuration_for_post_events() {
    let temp = TempDir::new().expect("temporary project root");
    let response = build_router(test_state(temp.path()))
        .oneshot(
            Request::post("/webhooks/instagram")
                .header("x-hub-signature-256", "sha256=00")
                .body(Body::from("{}"))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
}

#[tokio::test]
async fn due_instagram_token_is_refreshed_and_persisted_without_immediate_retry() {
    let temp = TempDir::new().unwrap();
    let (graph_url, server, requests) = mock_graph_server().await;
    let config = AppConfig {
        access_token: "legacy-token".into(),
        instagram_user_id: "ig-user".into(),
        instagram_username: "account".into(),
        graph_api_base_url: graph_url,
        ..AppConfig::default()
    };
    let state = AppState::new(config, temp.path()).unwrap();
    state.initialize().await.unwrap();

    state.refresh_due_tokens().await.unwrap();
    let accounts = state.accounts.list().await.unwrap();
    assert_eq!(accounts.len(), 1);
    assert_eq!(accounts[0].access_token(), "renewed-token");
    assert!(accounts[0].expires_at().unwrap() > chrono::Utc::now().timestamp() + 50 * 86400);
    assert!(requests.lock().await.iter().any(|request| {
        request.contains("/me?fields=id")
            && request
                .to_ascii_lowercase()
                .contains("authorization: bearer renewed-token")
    }));
    assert_eq!(
        requests
            .lock()
            .await
            .iter()
            .filter(|request| request.contains("/refresh_access_token?"))
            .count(),
        1
    );

    state.refresh_due_tokens().await.unwrap();
    assert_eq!(
        requests
            .lock()
            .await
            .iter()
            .filter(|request| request.contains("/refresh_access_token?"))
            .count(),
        1
    );
    server.abort();
}

#[test]
fn public_media_urls_require_https_and_encode_only_the_filename() {
    assert_eq!(
        build_public_media_url("https://public.example/base/", "reel 1.mp4").unwrap(),
        "https://public.example/base/media/reel%201.mp4"
    );
    assert!(build_public_media_url("http://public.example", "reel.mp4").is_err());
    assert!(build_public_media_url("https://public.example", "../reel.mp4").is_err());
}

#[tokio::test]
async fn schedule_listing_hides_internal_reel_hashes() {
    let temp = TempDir::new().expect("temporary project root");
    let data_path = temp.path().join("backend/data/schedules.json");
    fs::create_dir_all(data_path.parent().unwrap()).unwrap();
    fs::write(
        &data_path,
        serde_json::to_vec(&json!([{
            "id": "test_reel-1",
            "type": "test_reel",
            "status": "scheduled",
            "media_sha256": "private-hash"
        }]))
        .unwrap(),
    )
    .unwrap();

    let response = build_router(test_state(temp.path()))
        .oneshot(Request::get("/api/schedules").body(Body::empty()).unwrap())
        .await
        .unwrap();
    let payload: Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();

    assert_eq!(payload["schedules"][0]["id"], "test_reel-1");
    assert!(payload["schedules"][0].get("media_sha256").is_none());
}

#[tokio::test]
async fn media_get_and_head_return_file_bytes_and_length() {
    let temp = TempDir::new().expect("temporary project root");
    let upload_dir = temp.path().join("backend/uploads");
    fs::create_dir_all(&upload_dir).unwrap();
    fs::write(upload_dir.join("fixture.mp4"), b"streamed-video-content").unwrap();
    let router = build_router(test_state(temp.path()));

    let get_response = router
        .clone()
        .oneshot(
            Request::get("/media/fixture.mp4")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(get_response.status(), StatusCode::OK);
    assert_eq!(get_response.headers()[header::CONTENT_LENGTH], "22");
    assert_eq!(
        &get_response.into_body().collect().await.unwrap().to_bytes()[..],
        b"streamed-video-content"
    );

    let head_response = router
        .oneshot(
            Request::head("/media/fixture.mp4")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(head_response.status(), StatusCode::OK);
    assert_eq!(head_response.headers()[header::CONTENT_LENGTH], "22");
    assert!(
        head_response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes()
            .is_empty()
    );
}

#[tokio::test]
async fn multipart_upload_is_rejected_when_stream_exceeds_its_limit() {
    let temp = TempDir::new().expect("temporary upload dir");
    let destination = temp.path().join("media.part");
    let chunks = stream::iter([
        Ok::<_, anyhow::Error>(Bytes::from_static(b"1234")),
        Ok::<_, anyhow::Error>(Bytes::from_static(b"5678")),
    ]);

    let error = persist_chunks(chunks, &destination, 6).await.unwrap_err();

    assert!(error.to_string().contains("upload_too_large"));
    assert!(
        !destination.exists(),
        "partial uploads must be removed on rejection"
    );
}

#[tokio::test]
async fn unknown_api_route_returns_json_not_found() {
    let temp = TempDir::new().expect("temporary project root");
    let response = build_router(test_state(temp.path()))
        .oneshot(
            Request::get("/api/does-not-exist")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let payload: Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(payload, json!({"error": "not_found"}));
}

#[tokio::test]
async fn non_multipart_story_request_is_rejected_before_meta_access() {
    let temp = TempDir::new().expect("temporary project root");
    let response = build_router(test_state(temp.path()))
        .oneshot(
            Request::post("/api/stories")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from("{}"))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let payload: Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(payload["error"], "multipart_required");
}

#[tokio::test]
async fn failed_stream_io_removes_partial_upload() {
    let temp = TempDir::new().expect("temporary upload dir");
    let destination = temp.path().join("broken.part");
    let chunks = stream::iter([
        Ok::<_, anyhow::Error>(Bytes::from_static(b"first")),
        Err(anyhow::Error::new(io::Error::other("stream interrupted"))),
    ]);

    assert!(persist_chunks(chunks, &destination, 10).await.is_err());
    assert!(!destination.exists());
}

#[tokio::test]
async fn multipart_upload_is_streamed_and_temporary_media_is_cleaned_on_rejection() {
    let temp = TempDir::new().expect("temporary project root");
    let chunks = [
        b"--boundary\r\nContent-Disposition: form-data; name=\"action\"\r\n\r\nschedule\r\n--boundary\r\nContent-Disposition: form-data; name=\"scheduled_at\"\r\n\r\n2099-01-01T00:00:00Z\r\n".to_vec(),
        b"--boundary\r\nContent-Disposition: form-data; name=\"media\"; filename=\"clip.mp4\"\r\nContent-Type: video/mp4\r\n\r\nvideo-payload\r\n--boundary--\r\n".to_vec(),
    ];
    let request = Request::post("/api/stories")
        .header(
            header::CONTENT_TYPE,
            "multipart/form-data; boundary=boundary",
        )
        .body(Body::from_stream(stream::iter(
            chunks.into_iter().map(Ok::<_, io::Error>),
        )))
        .unwrap();
    let response = build_router(test_state(temp.path()))
        .oneshot(request)
        .await
        .unwrap();
    let status = response.status();
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let payload: Value = serde_json::from_slice(&body).unwrap();

    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(payload["error"], "instagram_account_required");
    assert_eq!(
        fs::read_dir(temp.path().join("backend/uploads"))
            .unwrap()
            .count(),
        0
    );
}

#[tokio::test]
async fn due_schedules_are_claimed_and_recovered_after_restart() {
    let temp = TempDir::new().expect("temporary project root");
    let store = ScheduleStore::new(temp.path().join("schedules.json"));
    let record = store
        .create(json!({
            "type":"story", "status":"scheduled", "scheduled_at":"2000-01-01T00:00:00Z"
        }))
        .await
        .unwrap();
    let claimed = store.claim_due(chrono::Utc::now()).await.unwrap();
    assert_eq!(claimed.len(), 1);
    assert_eq!(claimed[0]["status"], "processing");
    assert_eq!(store.list().await.unwrap()[0]["id"], record["id"]);
    store.recover_processing().await.unwrap();
    assert_eq!(store.list().await.unwrap()[0]["status"], "scheduled");
}

#[tokio::test]
async fn scheduled_records_can_be_updated_and_deleted_through_the_api() {
    let temp = TempDir::new().expect("temporary project root");
    let data_path = temp.path().join("backend/data/schedules.json");
    fs::create_dir_all(data_path.parent().unwrap()).unwrap();
    fs::write(
        &data_path,
        serde_json::to_vec(&json!([{
            "id":"story-1", "type":"story", "status":"scheduled", "caption":"old", "scheduled_at":"2099-01-01T00:00:00Z"
        }])).unwrap(),
    ).unwrap();
    let router = build_router(test_state(temp.path()));
    let updated = router
        .clone()
        .oneshot(
            Request::patch("/api/schedules/story-1")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(r#"{"caption":"  updated  "}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(updated.status(), StatusCode::OK);
    let payload: Value =
        serde_json::from_slice(&updated.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(payload["schedule"]["caption"], "updated");

    let deleted = router
        .oneshot(
            Request::delete("/api/schedules/story-1")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(deleted.status(), StatusCode::OK);
    let payload: Value =
        serde_json::from_slice(&deleted.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(payload["deleted"], true);
}

#[test]
fn schedule_validation_distinguishes_bad_dates_and_missing_timezones() {
    assert_eq!(
        parse_scheduled_at("not-a-date").unwrap_err().code,
        "invalid_scheduled_at"
    );
    assert_eq!(
        parse_scheduled_at("2099-01-01T12:00:00").unwrap_err().code,
        "scheduled_at_timezone_required"
    );
    assert_eq!(
        validate_schedule_edit(&json!({"caption":"  Reel  "})).unwrap()["caption"],
        "Reel"
    );
    assert_eq!(
        validate_schedule_edit(&json!({"unexpected":true}))
            .unwrap_err()
            .code,
        "invalid_schedule_update"
    );
}

#[tokio::test]
async fn meta_errors_preserve_trace_details_but_redact_credentials() {
    let (base_url, server) = one_shot_server(
        "400 Bad Request",
        r#"{"error":{"message":"invalid token secret-token","code":400,"error_subcode":1234,"fbtrace_id":"trace-42"}}"#,
    ).await;
    let client = MetaClient::new(
        "secret-token".into(),
        "ig-user".into(),
        base_url,
        "v26.0".into(),
    );
    let error = client.get_profile().await.unwrap_err();
    server.await.unwrap();

    assert!(error.to_string().contains("code=400"));
    assert!(error.to_string().contains("subcode=1234"));
    assert!(error.to_string().contains("trace=trace-42"));
    assert!(!error.to_string().contains("secret-token"));
}

#[tokio::test]
async fn public_media_probe_requires_expected_mime_and_exact_size() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        for _ in 0..2 {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = read_request(&mut socket).await;
            assert!(request.starts_with("HEAD /media/reel.mp4 HTTP/1.1"));
            let response = "HTTP/1.1 200 OK\r\nContent-Type: video/mp4\r\nContent-Length: 1234\r\nConnection: close\r\n\r\n";
            socket.write_all(response.as_bytes()).await.unwrap();
        }
    });
    let url = format!("http://{address}/media/reel.mp4");

    verify_public_media(&url, 1234).await.unwrap();
    let error = verify_public_media(&url, 1235).await.unwrap_err();
    server.await.unwrap();

    assert!(error.contains("tamanho do arquivo diferente"));
}

#[tokio::test]
async fn reel_container_uses_trial_fields_and_sends_credentials_in_authorization() {
    let (base_url, server) = one_shot_server("200 OK", r#"{"id":"container-1"}"#).await;
    let client = MetaClient::new(
        "test-token".into(),
        "ig-user".into(),
        base_url,
        "v26.0".into(),
    );
    let container_id = client
        .create_reel_container("https://public.example/reel.mp4", "Reel de teste", "MANUAL")
        .await
        .unwrap();
    let request = server.await.unwrap();

    assert_eq!(container_id, "container-1");
    assert!(request.starts_with("POST /v26.0/ig-user/media HTTP/1.1"));
    assert!(
        request
            .to_ascii_lowercase()
            .contains("authorization: bearer test-token")
    );
    assert!(request.contains("media_type=REELS"));
    assert!(request.contains("trial_params=%7B%22graduation_strategy%22%3A%22MANUAL%22%7D"));
    assert!(!request.lines().next().unwrap_or("").contains("test-token"));
}

#[tokio::test]
async fn reel_publish_waits_for_meta_container_before_publishing() {
    let (base_url, server) = sequence_server(vec![
        ("200 OK", r#"{"id":"container-2"}"#),
        ("200 OK", r#"{"status_code":"FINISHED"}"#),
        ("200 OK", r#"{"id":"published-2"}"#),
    ])
    .await;
    let client = MetaClient::new(
        "test-token".into(),
        "ig-user".into(),
        base_url,
        "v26.0".into(),
    );

    let result = client
        .publish_reel("https://public.example/reel.mp4", "caption", "MANUAL")
        .await
        .unwrap();
    let requests = server.await.unwrap();

    assert_eq!(result, ("published-2".into(), "container-2".into()));
    assert_eq!(requests.len(), 3);
    assert!(requests[1].starts_with("GET /v26.0/container-2?fields=status_code,status HTTP/1.1"));
    assert!(requests[2].starts_with("POST /v26.0/ig-user/media_publish HTTP/1.1"));
}

#[tokio::test]
async fn failed_reel_container_keeps_its_id_and_never_calls_media_publish() {
    let (base_url, server) = sequence_server(vec![
        ("200 OK", r#"{"id":"failed-container"}"#),
        (
            "200 OK",
            r#"{"status_code":"ERROR","status":"Media could not be fetched."}"#,
        ),
    ])
    .await;
    let client = MetaClient::new(
        "test-token".into(),
        "ig-user".into(),
        base_url,
        "v26.0".into(),
    );

    let error = client
        .publish_reel("https://public.example/reel.mp4", "caption", "MANUAL")
        .await
        .unwrap_err();
    let requests = server.await.unwrap();

    assert_eq!(error.container_id.as_deref(), Some("failed-container"));
    assert!(error.to_string().contains("Media could not be fetched"));
    assert_eq!(requests.len(), 2);
    assert!(
        !requests
            .iter()
            .any(|request| request.contains("media_publish"))
    );
}

#[tokio::test]
async fn analytics_contract_uses_local_meta_responses_and_actual_reel_views() {
    let (base_url, server, requests) = mock_graph_server().await;
    let temp = TempDir::new().expect("temporary project root");
    let config = AppConfig {
        access_token: "test-token".into(),
        instagram_user_id: "ig-user".into(),
        instagram_username: "alesantorooficial".into(),
        plugin_api_key: String::new(),
        meta_app_secret: String::new(),
        meta_webhook_verify_token: String::new(),
        graph_api_base_url: base_url,
        graph_api_version: "v26.0".into(),
        public_base_url: String::new(),
    };
    let router = build_router(AppState::new(config, temp.path()).unwrap());
    let response = router
        .oneshot(
            Request::get("/api/analytics?period=today")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let payload: Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    server.abort();
    let calls = requests.lock().await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(payload["period"], "today");
    assert_eq!(payload["timezone"], "America/Sao_Paulo");
    assert_eq!(payload["metrics"]["views"], 123);
    assert_eq!(payload["metrics"]["reach"], 45);
    assert_eq!(payload["chart"]["points"][0]["views"], 10);
    assert_eq!(payload["reels"][0]["views"], 99);
    assert!(calls.iter().any(|request| request.contains("/insights")));
    assert!(calls.iter().all(|request| {
        let request_target = request.lines().next().unwrap_or("");
        !request_target.contains("test-token")
    }));
    assert!(calls.iter().any(|request| {
        request
            .to_ascii_lowercase()
            .contains("authorization: bearer test-token")
    }));
}

async fn one_shot_server(
    status: &str,
    payload: &'static str,
) -> (String, tokio::task::JoinHandle<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let status = status.to_string();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let request = read_request(&mut socket).await;
        write_json_response(&mut socket, &status, payload).await;
        request
    });
    (format!("http://{address}"), server)
}

async fn sequence_server(
    responses: Vec<(&'static str, &'static str)>,
) -> (String, tokio::task::JoinHandle<Vec<String>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let mut requests = Vec::new();
        for (status, payload) in responses {
            let (mut socket, _) = listener.accept().await.unwrap();
            requests.push(read_request(&mut socket).await);
            write_json_response(&mut socket, status, payload).await;
        }
        requests
    });
    (format!("http://{address}"), server)
}

async fn mock_graph_server() -> (String, tokio::task::JoinHandle<()>, Arc<Mutex<Vec<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let received = requests.clone();
    let server = tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                break;
            };
            let received = received.clone();
            tokio::spawn(async move {
                let request = read_request(&mut socket).await;
                received.lock().await.push(request.clone());
                let path = request.lines().next().unwrap_or("");
                let payload = if path.contains("/ig-user?") {
                    r#"{"username":"mock-account","followers_count":7,"media_count":11,"profile_picture_url":"https://images.example/avatar.jpg"}"#
                } else if path.contains("/refresh_access_token?") {
                    r#"{"access_token":"renewed-token","token_type":"bearer","expires_in":5184000}"#
                } else if path.contains("/me?fields=id") {
                    r#"{"id":"ig-user"}"#
                } else if path.contains("/ig-user/media?") {
                    r#"{"data":[{"id":"reel-1","media_product_type":"REELS","media_type":"VIDEO","caption":"Today","thumbnail_url":"https://images.example/reel.jpg","permalink":"https://instagram.com/reel-1","timestamp":"__NOW__","like_count":4,"comments_count":2}]}"#
                } else if path.contains("/reel-1/insights") {
                    r#"{"data":[{"name":"views","total_value":{"value":99}}]}"#
                } else if path.contains("/insights?") && path.contains("reach") {
                    r#"{"data":[{"name":"views","total_value":{"value":123}},{"name":"reach","total_value":{"value":45}}]}"#
                } else if path.contains("/insights?") {
                    r#"{"data":[{"name":"views","total_value":{"value":10}}]}"#
                } else {
                    r#"{"data":[]}"#
                };
                let payload = payload.replace("__NOW__", &chrono::Utc::now().to_rfc3339());
                write_json_response(&mut socket, "200 OK", &payload).await;
            });
        }
    });
    (format!("http://{address}"), server, requests)
}

async fn read_request(socket: &mut tokio::net::TcpStream) -> String {
    let mut request = Vec::new();
    let mut chunk = [0_u8; 2048];
    loop {
        let read = socket.read(&mut chunk).await.unwrap_or(0);
        if read == 0 {
            break;
        }
        request.extend_from_slice(&chunk[..read]);
        if let Some(header_end) = request.windows(4).position(|window| window == b"\r\n\r\n") {
            let headers = String::from_utf8_lossy(&request[..header_end]);
            let content_length = headers
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().ok())
                        .flatten()
                })
                .unwrap_or(0);
            if request.len() >= header_end + 4 + content_length {
                break;
            }
        }
    }
    String::from_utf8_lossy(&request).into_owned()
}

async fn write_json_response(socket: &mut tokio::net::TcpStream, status: &str, payload: &str) {
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
        payload.len()
    );
    let _ = socket.write_all(response.as_bytes()).await;
}
