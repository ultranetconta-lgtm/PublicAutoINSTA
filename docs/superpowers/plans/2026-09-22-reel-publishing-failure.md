# Reel Publishing Failure Implementation Plan

> **For agentic workers:** Execute the steps in this task with test driven development and verify the actual running service.

**Goal:** Restore reliable scheduled Reel publishing and make Meta container failures diagnosable.

**Architecture:** Preserve the existing URL based Instagram Login publishing flow. Verify the public media URL before creating a Meta container, retain the container ID when a publish attempt fails, and request Meta's status text alongside its status code. Replace the expired temporary tunnel used by the local backend and verify public access without publishing a post.
Normalize uploaded Reel videos into a real MP4 with `moov` before `mdat` and no edit list before they become public.

**Tech Stack:** Python standard library, unittest, local HTTP server, Cloudflare Quick Tunnel.

**Spec:** User report of three scheduled test Reels ending with `Story container status: ERROR` and no saved container ID.

## Global Constraints

- Preserve all existing schedules, uploads, credentials, and unrelated in progress edits.
- Never expose the access token through URLs, logs, HTTP responses, or schedule records.
- Do not call `media_publish` in live verification; only the user schedules a real post.
- The same MP4 was successfully published earlier, so treat encoding and repeated content as unconfirmed factors.

---

### Task 1: Preserve Meta failure evidence

**Files:** `backend/test_story_service.py`, `backend/story_service.py`, `backend/test_server_contract.py`, `backend/server.py`.

- [x] Add a failing test for `status_code,status` polling and an `ERROR` response that carries a container ID and detailed status.
- [x] Add a failing application test that checks the failed schedule retains the container ID and Meta detail.
- [x] Implement the smallest changes that make those tests pass.
- [x] Run the full backend test suite.

### Task 2: Reject inaccessible public media before creating a container

**Files:** `backend/test_server_contract.py`, `backend/server.py`, `backend/README.md`.

- [x] Add a failing test for an unreachable public media URL that prevents a Meta container request and records a useful error.
- [x] Add a successful preflight test using a local HTTP server.
- [x] Implement a bounded public media fetch check immediately before both immediate and scheduled publication.
- [x] Run tests and verify the existing routes still work.

### Task 3: Restore public media access

**Files:** `api/.env`, local tunnel runtime, `backend/README.md`.

- [x] Start a new temporary HTTPS tunnel to the local backend and back up the credential file before changing its public URL.
- [x] Restart the backend so the new URL is loaded.
- [x] Verify public media returns HTTP 200 and the expected MP4 bytes, and verify `/api/health` without exposing the token.
- [x] Report that a temporary tunnel must stay alive for future scheduled posts and state the limitation of this setup.

### Task 4: Normalize Reel uploads

**Files:** `backend/test_server_contract.py`, `backend/server.py`, `backend/README.md`.

- [x] Add a failing test that requires the saved Reel to be an MP4 with `moov` before `mdat` and no `edts` atom.
- [x] Remux Reel uploads with FFmpeg using `-c copy`, `-movflags +faststart`, and `-use_editlist 0`; keep the source upload bytes only until the normalized copy succeeds.
- [x] Reject a failed remux before creating a schedule or Meta container and return a clear error.
- [x] Run the test suite and inspect a normalized copy of the user's current video without overwriting the original.
