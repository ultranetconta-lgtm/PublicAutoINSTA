# Rust Server Migration Implementation Plan

> **For agentic workers:** Execute this plan inline in the current task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `backend/server.py` with a Rust HTTP backend that preserves the planner, Instagram publishing, analytics, scheduler, and deployment contracts while streaming uploads and media responses.

**Architecture:** Build a Rust crate under `backend/` with Axum and Tokio. Keep route behavior and JSON schedule persistence compatible, implement the Meta Graph client in Rust, and use streamed multipart fields and streamed file responses so uploaded/downloaded media are not copied into one large in-memory buffer.

**Tech Stack:** Rust 2024, Axum, Tokio, Reqwest, Serde, Chrono, SHA-256, FFmpeg subprocesses, Cargo tests.

**Spec:** The supplied backend analysis notes and the existing route behavior in `backend/server.py`.

## Global Constraints

- Preserve `/api/health`, `/api/schedules`, `/api/analytics`, `/api/stories`, `/api/reels`, schedule PATCH/DELETE, and `/media/<filename>` semantics.
- Keep the existing `backend/data/schedules.json` record format and hide `media_sha256` from public API responses.
- Enforce the 200 MiB upload ceiling while writing incoming file parts incrementally to disk.
- Serve stored media incrementally from disk and preserve `Content-Length`, MIME, and HEAD support.
- Never publish to Meta or expose credentials during local tests.
- Preserve current environment names, static site files, FFmpeg normalization/conversion behavior, and Fly port binding.

---

### Task 1: Establish Rust contract tests

**Files:**
- Create: `backend/Cargo.toml`
- Create: `backend/tests/server_contract.rs`
- Test: `backend/tests/server_contract.rs`

**Interfaces:**
- Tests consume public `backend::app::{AppConfig, AppState, build_router}` and `backend::store::ScheduleStore` interfaces.
- Tests verify health JSON, unknown routes, streamed media GET/HEAD, multipart size rejection, schedule JSON round-trip, and secret/hash redaction.

- [ ] Add the minimal Cargo manifest and integration tests before production modules.
- [ ] Run `cargo test --manifest-path backend/Cargo.toml --test server_contract`; confirm it fails because the Rust contract modules are not implemented yet.

### Task 2: Implement configuration, storage, and upload-stream primitives

**Files:**
- Create: `backend/src/lib.rs`
- Create: `backend/src/config.rs`
- Create: `backend/src/store.rs`
- Create: `backend/src/media.rs`
- Modify: `backend/tests/server_contract.rs`

**Interfaces:**
- `AppConfig::load(project_root: &Path) -> AppConfig` reads process environment first, then `api/.env`.
- `ScheduleStore::{list, create, update, claim_due, delete, recover_processing}` preserve existing JSON records and atomic replacement.
- `persist_upload_field(field, destination, max_bytes) -> Result<u64, UploadError>` writes multipart chunks directly to a file and rejects overflow without collecting the media bytes.
- `stream_file(path) -> Result<Body, io::Error>` exposes a disk-backed response body.

- [ ] Add tests for the store's existing JSON format and the 200 MiB streaming limit.
- [ ] Run the affected Cargo tests and observe the expected missing-module failures.
- [ ] Implement config, atomic JSON store, path/MIME helpers, incremental multipart persistence, and disk-backed file streaming.
- [ ] Run the affected Cargo tests and require them to pass.

### Task 3: Port Meta Graph operations and analytics

**Files:**
- Create: `backend/src/meta.rs`
- Create: `backend/src/analytics.rs`
- Create: `backend/src/error.rs`
- Modify: `backend/tests/server_contract.rs`

**Interfaces:**
- `MetaClient` implements Story/Reel container creation, status polling, publish, profile/media lookup, account insights, and media views.
- `MetaError` retains safe error detail and an optional container ID while redacting the access token.
- `build_analytics(state, period, force_refresh)` returns the existing dashboard JSON contract and limits concurrent Meta insight calls to five.

- [ ] Add deterministic tests for encoded Reel trial parameters, ERROR container behavior, token redaction, accepted insight metrics, and supported periods.
- [ ] Run the new tests and observe expected failures before implementing the Meta/analytics modules.
- [ ] Implement the Meta HTTP adapter and analytics aggregation, retaining Sao Paulo day boundaries and the 20-second profile/media cache.
- [ ] Run the affected Cargo tests without contacting the live Meta API.

### Task 4: Port application workflows and HTTP routes

**Files:**
- Create: `backend/src/app.rs`
- Create: `backend/src/routes.rs`
- Modify: `backend/src/lib.rs`
- Modify: `backend/tests/server_contract.rs`

**Interfaces:**
- `AppState::new(config, project_root)` constructs shared store, upload directory, Meta client, submission lock, and analytics cache.
- `build_router(state)` registers the API, static asset, and media routes.
- Handlers preserve current validation/error status codes and schedule state transitions; media upload parsing streams each field to temporary disk before validation and atomically moves accepted files into uploads.

- [ ] Add route tests for health, schedules, media GET/HEAD, multipart-required, invalid action, oversized upload, safe public records, and schedule PATCH/DELETE.
- [ ] Run these tests and confirm failures correspond to the missing route behavior.
- [ ] Implement route handlers and application workflows, including duplicate Reel SHA-256 checks and FFmpeg invocations matching the current flags.
- [ ] Run all Rust tests and ensure none requires real Meta credentials or invokes publication.

### Task 5: Start the Rust service and switch deployment/docs

**Files:**
- Create: `backend/server.rs`
- Modify: `Dockerfile`
- Modify: `backend/README.md`
- Modify: `README.md`
- Delete: `backend/server.py`
- Delete: `backend/test_server_contract.py` and `backend/test_video.py` (their behavior is covered by Rust contract/media tests)

**Interfaces:**
- Binary listens on `HOST` (default `0.0.0.0`) and `PORT` (default `3000`), starts the two-second due-schedule worker, and shuts down cleanly.
- Docker builds a release binary in a Rust builder stage and retains FFmpeg plus static project assets in the runtime image.

- [ ] Add a startup smoke test and document local `cargo run` / `cargo test` commands.
- [ ] Run the startup smoke test, `cargo fmt --check`, `cargo test`, and a release build.
- [ ] Remove the Python entry point only after all route and workflow checks pass; verify Fly configuration and README commands reference the Rust service.

## Coverage Review

The plan covers all route handlers, request validation, schedule persistence and recovery, scheduler polling, static assets, streamed upload and media delivery, duplicate Reel protection, FFmpeg conversions, Meta publishing and error details, analytics, cache TTL, environment configuration, deployment, and secret/hash redaction. Tests remain local and non-publishing.
