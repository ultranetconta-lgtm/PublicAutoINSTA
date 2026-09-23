# Upload Progress Ring Implementation Plan

> **For agentic workers:** Execute this plan inline in the current task. The user has requested implementation in the deployed Instagram planner.

**Goal:** Show an accessible circular upload percentage with file size and transferred bytes until the backend finishes scheduling or publishing.

**Architecture:** Keep the existing multipart backend endpoints. Replace the two frontend `fetch` uploads with one shared `XMLHttpRequest` helper so browser upload progress events drive a modal progress ring; after the bytes finish, keep the ring visible at 100% while the server processes the request.

**Tech Stack:** Existing HTML, CSS, JavaScript, XMLHttpRequest, and the current Python API.

**Spec:** User comment attached to `button#btnSchedule` in the deployed planner on 2026-09-23.

## Global Constraints

- Use the browser's actual upload progress events and show the selected file's exact size.
- Keep the overlay active until the backend responds with success or failure.
- Support both `/api/stories` and `/api/reels`, including scheduled and publish-now actions.
- Do not create a real Instagram post or schedule as a validation step.
- Do not add or run tests unless the user asks for tests or verification.

---

### Task 1: Add the accessible progress overlay

**Files:**
- Modify: `index.html`
- Modify: `css/styles.css`

- [ ] Add a modal overlay with an SVG circular track/value indicator, percentage, file name, exact file size, transferred request bytes, and a live status message.
- [ ] Style the overlay for desktop and mobile and respect reduced-motion preferences.

### Task 2: Report upload and server-processing progress

**Files:**
- Modify: `js/app.js`

- [ ] Add byte formatting and one XHR helper that reports determinate upload progress when available, shows an indeterminate state otherwise, parses the existing JSON response, and rejects HTTP/network failures.
- [ ] Route Story and Reel submissions through the helper; keep the overlay at 100% during backend/Meta processing, then announce completion or show the existing error toast and close it.
- [ ] Keep the selected action stable for the duration of the request and re-enable the schedule controls in `finally`.

### Task 3: Release the feature

**Files:**
- Recheck: `index.html`, `js/app.js`, `css/styles.css`

- [ ] Review the final diff and whitespace; deploy the authorized release to the existing Fly app and confirm the deployed page responds.
- [ ] Do not submit user media or trigger an actual Instagram publication during verification.
