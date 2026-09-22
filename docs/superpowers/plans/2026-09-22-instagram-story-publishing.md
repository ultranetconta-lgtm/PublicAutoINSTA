# Instagram Story Publishing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform the current Story mock into a local backend-backed Instagram Story flow that accepts image/video media, publishes immediately, or persists and executes an authorized schedule.

**Architecture:** A dependency-free Python backend will serve the existing static frontend, receive multipart uploads, persist schedules/media under `backend/data` and `backend/uploads`, and run a small due-schedule worker. The Meta adapter will keep the token server-side and use the official two-step Instagram publishing flow: create a `STORIES` container from a public media URL, poll its status, then call `media_publish`. The frontend will call the backend only for `STORY`; existing non-Story mock modes remain available.

**Tech Stack:** Python 3.11+ standard library (`http.server`, `urllib`, `json`, `threading`, `unittest`), browser `fetch`/`FormData`, existing HTML/CSS/JavaScript.

**Spec:** User request: configure `backend/` and `api/` so the planner can post an Instagram Story now or schedule it.

## Global Constraints

- Never expose `INSTAGRAM_ACCESS_TOKEN` or `PLUGIN_API_KEY` to browser responses, static assets, logs, or persisted schedule records.
- Require `PUBLIC_BASE_URL` for real Meta publishing because Meta must fetch the uploaded media from a public URL; do not treat `localhost` as public.
- Story media uses `media_type=STORIES` with exactly one `image_url` or `video_url`; captions remain local metadata because Story publishing does not use feed captions.
- Do not perform a real publish during implementation verification; use read-only health/config checks and fake transport tests.
- Preserve the original uploaded files and keep the existing demo modes functional.

---

### Task 1: Define the backend publishing contract with failing tests

**Files:**
- Create: `backend/test_story_service.py`
- Create: `backend/test_storage.py`
- Create: `backend/test_server_contract.py`

**Interfaces:**
- `StoryService.publish_story(media_url: str, media_kind: str) -> dict` will be the Meta adapter contract.
- `StoryService.create_container(media_url: str, media_kind: str) -> str` will create a `STORIES` container.
- `StoryStore.create_schedule(payload: dict) -> dict`, `StoryStore.list_schedules() -> list[dict]`, and `StoryStore.update_schedule(schedule_id: str, patch: dict) -> dict` will persist local state.
- `build_public_media_url(base_url: str, filename: str) -> str` will reject a missing base URL and safely encode the filename.

- [ ] **Step 1: Write the failing service tests**

```python
def test_story_container_uses_stories_and_the_selected_media_parameter():
    calls = []

    def request(method, url, *, data=None, headers=None):
        calls.append((method, url, data, headers))
        if method == "POST" and url.endswith("/media"):
            return {"id": "container-1"}
        if method == "GET":
            return {"status_code": "FINISHED"}
        return {"id": "published-1"}

    service = StoryService("token", "ig-user", request_fn=request)
    result = service.publish_story("https://public.example/story.jpg", "image")

    assert result == {"id": "published-1", "container_id": "container-1"}
    assert calls[0][2] == {
        "media_type": "STORIES",
        "image_url": "https://public.example/story.jpg",
    }


def test_story_video_uses_video_url():
    calls = []

    def request(method, url, *, data=None, headers=None):
        calls.append(data)
        return {"id": "container-1"} if method == "POST" and url.endswith("/media") else {"status_code": "FINISHED"}

    service = StoryService("token", "ig-user", request_fn=request)
    service.create_container("https://public.example/story.mp4", "video")

    assert calls[0] == {
        "media_type": "STORIES",
        "video_url": "https://public.example/story.mp4",
    }
```

- [ ] **Step 2: Write persistence and URL contract tests**

```python
def test_store_round_trips_schedule_without_credentials(tmp_path):
    store = StoryStore(tmp_path / "schedules.json")
    created = store.create_schedule({"media_filename": "story.jpg", "scheduled_at": "2026-09-22T12:00:00-03:00"})

    assert created["status"] == "scheduled"
    assert store.list_schedules()[0]["media_filename"] == "story.jpg"
    assert "access_token" not in json.dumps(store.path.read_text())


def test_public_media_url_requires_a_nonempty_base_url():
    with self.assertRaisesRegex(ValueError, "PUBLIC_BASE_URL"):
        build_public_media_url("", "story.jpg")
```

- [ ] **Step 3: Write HTTP route contract tests**

```python
def test_health_never_returns_token():
    response = call_route("GET", "/api/health")
    assert response.status == 200
    assert "INSTAGRAM_ACCESS_TOKEN" not in response.text
    assert "token" not in response.json


def test_story_route_requires_media_and_public_base_url():
    response = call_route("POST", "/api/stories", fields={"action": "publish_now"})
    assert response.status == 400
    assert response.json["error"] == "media_required"
```

- [ ] **Step 4: Run the new tests and verify they fail for missing production interfaces**

Run: `python3 -m unittest discover -s backend -p 'test_*.py' -v`

Expected: FAIL with import/name errors for `StoryService`, `StoryStore`, `build_public_media_url`, and the route harness, not syntax errors in the tests.

### Task 2: Implement the Meta Story adapter and persistent scheduler state

**Files:**
- Create: `backend/story_service.py`
- Create: `backend/storage.py`
- Modify: `api/.env` (append non-secret runtime settings only if absent)
- Create: `api/.env.example`

**Interfaces:**
- `StoryService(access_token, instagram_user_id, base_url, api_version, request_fn=None)` stores the token only in process memory.
- `StoryService.create_container(media_url, media_kind)` returns a Meta container ID.
- `StoryService.wait_until_ready(container_id, timeout_seconds=60)` returns the final status code or raises `MetaAPIError`.
- `StoryService.publish_story(media_url, media_kind)` returns `{id, container_id}`.
- `StoryStore(path)` atomically writes JSON records with no secrets.
- `build_public_media_url(base_url, filename)` returns a URL with a safely quoted filename.

- [ ] **Step 1: Implement the smallest Meta request helper and media-kind validation**

Use `urllib.request.Request` with an `Authorization: Bearer ...` header and form-encoded parameters. Do not place the token in the URL. Allow only `image` and `video`; map them to `image_url` and `video_url`.

- [ ] **Step 2: Run the service tests and verify container construction passes**

Run: `python3 -m unittest backend.test_story_service -v`

Expected: PASS for `STORIES`, `image_url`, `video_url`, status polling, and publish response.

- [ ] **Step 3: Implement atomic JSON storage and schedule record normalization**

Persist `id`, `type`, `media_filename`, `media_kind`, `caption`, `scheduled_at`, `status`, timestamps, and Meta IDs/errors only. Write through a temporary sibling file and `os.replace` it.

- [ ] **Step 4: Run storage tests and inspect the persisted JSON for secret absence**

Run: `python3 -m unittest backend.test_storage -v`

Expected: PASS and no token-shaped values in the file.

- [ ] **Step 5: Add configuration template and preserve the existing token file**

Add `PUBLIC_BASE_URL=` and `GRAPH_API_VERSION=v25.0` to `api/.env.example`; append only missing keys to `api/.env`, never rewrite or print the existing secret values.

### Task 3: Add backend HTTP API, media serving, and due-schedule worker

**Files:**
- Create: `backend/server.py`
- Create: `backend/data/.gitkeep`
- Create: `backend/uploads/.gitkeep`
- Modify: `backend/test_server_contract.py`

**Interfaces:**
- `GET /api/health` returns safe configuration booleans and account username/id, never credentials.
- `GET /api/schedules` returns local schedule records.
- `POST /api/stories` accepts multipart fields `action`, `caption`, `scheduled_at`, and `media`; it returns a created schedule for `schedule` or a published result for `publish_now`.
- `GET /media/<filename>` serves an uploaded media file without directory traversal.
- `run_due_schedules()` claims due `scheduled` records, publishes them, and updates `published` or `failed`.
- `python3 backend/server.py --host 127.0.0.1 --port 3000` serves the project root and API.

- [ ] **Step 1: Extend route tests for schedule and immediate paths**

Cover missing `PUBLIC_BASE_URL`, invalid media type, invalid/past schedule timestamps, successful schedule persistence with a fake service, and safe health output.

- [ ] **Step 2: Run route tests and verify the new cases fail**

Run: `python3 -m unittest backend.test_server_contract -v`

Expected: FAIL on missing HTTP handler/configuration behavior.

- [ ] **Step 3: Implement env loading, multipart parsing, validation, and static serving**

Load `api/.env` without logging values. Store each upload under `backend/uploads/<uuid>.<safe-extension>`, reject empty/unsupported media, and generate the public media URL only from `PUBLIC_BASE_URL`.

- [ ] **Step 4: Implement immediate publishing and schedule persistence**

For `publish_now`, call the service after upload. For `schedule`, persist the record and return status `scheduled`; do not call Meta before the requested time.

- [ ] **Step 5: Implement the background worker with crash recovery**

On startup, convert stale `processing` records back to `scheduled`; periodically claim due records under a lock, call the service, and persist the result/error.

- [ ] **Step 6: Run all backend tests and syntax checks**

Run: `python3 -m unittest discover -s backend -p 'test_*.py' -v`

Run: `python3 -m py_compile backend/*.py`

Expected: all tests PASS and compilation exits 0.

### Task 4: Connect the planner UI to Story mode and real backend state

**Files:**
- Modify: `index.html:130-138, 360-365, 514-539`
- Modify: `js/app.js:1-220, 328-370, 835-864`
- Modify: `css/styles.css` only if Story preview/status needs a focused visual state

**Interfaces:**
- `POST /api/stories` is called with `FormData` only when `currentMode === 'story'`.
- `GET /api/schedules` hydrates `scheduledPosts` on startup.
- The selected action is tracked as `selectedPublishAction`, not inferred from button text.
- The selected upload is tracked as `currentMedia = { file, url, isVideo, kind }`.

- [ ] **Step 1: Add a browser-level regression check for Story naming and action selection**

Use the existing local browser to select the dropdown item and verify the visible label is `STORY`, the filter is `Stories`, and the schedule menu distinguishes `Agendamento` from `Publicar agora`.

- [ ] **Step 2: Update Story labels and mode state**

Change the user-facing selected mode to `STORY`, retain `data-mode="story"`, hide the Reels warning for Story, and map Story records to `type: "story"`.

- [ ] **Step 3: Track uploaded media and submit multipart Story actions**

Keep the `File` object in `currentMedia`, require it for Story submission, send `caption`, `scheduled_at`, and `action`, then use the response record to update the calendar/list. Show backend error messages without exposing response secrets.

- [ ] **Step 4: Hydrate and refresh schedules from the backend**

Load `/api/schedules` on startup, preserve a clear offline fallback for the existing mock data, and refresh after create/delete operations.

- [ ] **Step 5: Run JavaScript syntax and browser checks**

Run: `python3 - <<'PY'` with a small delimiter/bracket sanity check if no JS runtime is available.

Then use the browser to verify Story selection, media selection, schedule form submission against a local fake/safe backend response, and the calendar record rendering.

### Task 5: Run integrated verification and document the real Meta boundary

**Files:**
- Create: `backend/README.md`
- Modify: `index.html` only for user-facing configuration error copy if needed

- [ ] **Step 1: Start the backend on the existing local port after identifying the current static server**

Stop/restart only the identified `python3 -m http.server 3000` process, then run `python3 backend/server.py --host 127.0.0.1 --port 3000`.

- [ ] **Step 2: Verify safe health and schedule endpoints locally**

Run: `curl -fsS http://127.0.0.1:3000/api/health` and `curl -fsS http://127.0.0.1:3000/api/schedules`.

Expected: JSON without token values, with `meta_configured: true` and `public_media_configured: false` until `PUBLIC_BASE_URL` is supplied.

- [ ] **Step 3: Verify the UI from `http://localhost:3000/`**

Confirm the Story label, image/video upload, schedule action, immediate action, and readable configuration error when no public base URL exists. Do not click a real publish with user media during verification.

- [ ] **Step 4: Run the full verification suite**

Run: `python3 -m unittest discover -s backend -p 'test_*.py' -v`

Run: `python3 -m py_compile backend/*.py`

Run: `git diff --check` only if a repository exists; otherwise report that this checkout is not Git-backed.

- [ ] **Step 5: Document deployment requirements and final evidence**

Document the need for an HTTPS `PUBLIC_BASE_URL`, professional Instagram authorization with content-publishing permission, and a real Meta publish test requiring the user to authorize the specific post immediately before clicking `Publicar agora`.
