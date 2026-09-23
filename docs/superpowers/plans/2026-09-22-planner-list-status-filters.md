# Planner List and Status Filters Implementation Plan

> **For agentic workers:** Execute this plan inline in the current task and preserve unrelated working-tree changes.

**Goal:** Make the Planner open in list mode, show scheduled items by default with selectable status filters, and keep type labels on one line.

**Architecture:** Add a compact accessible status-filter menu to the existing schedule toolbar. Apply the selected status set and existing content-type filter to both calendar and list renderers. Set list mode as the initial HTML state and prevent type pills from wrapping in the schedule table.

**Tech Stack:** Existing static HTML, CSS, and browser JavaScript; no new dependencies.

**Spec:** Browser comments 1–3 on the local Planner, 2026-09-22.

## Global Constraints

- Keep existing schedule records, actions, and content-type filters intact.
- Default visible status is only `Agendado`; let users include or exclude `Publicando`, `Publicado`, and `Falhou` individually.
- Do not call Meta APIs or alter scheduled-post records while changing the Planner UI.
- Do not add or run automated tests unless the user asks for tests or verification.

---

### Task 1: Add selectable status filters

**Files:**
- Modify: `index.html` schedule toolbar.
- Modify: `js/app.js` status-filter state and both renderers.
- Modify: `css/styles.css` status-filter menu.

**Interfaces:**
- Status controls use `data-status-filter` values `scheduled`, `processing`, `published`, and `failed`.
- `getFilteredPosts()` returns posts matching both the existing type filter and selected statuses.
- The status button summary reports selected statuses and its expanded state accessibly.

- [x] Add the status dropdown and four labeled checkboxes; check only `scheduled` initially.
- [x] Map backend statuses and display labels to stable status keys, then use one shared filtering helper in calendar and list rendering.
- [x] Toggle each status independently, refresh both views, update the summary, and close the menu on outside click or Escape.
- [x] Add compact menu styles and confirm the default list shows only scheduled rows, with other statuses appearing when selected.

### Task 2: Make list mode the initial view

**Files:**
- Modify: `index.html` view-toggle buttons and calendar/list containers.

**Interfaces:**
- `btnModeList` starts active; `calendarListView` starts visible; `btnModeCalendar` starts inactive; `calendarGridView` starts hidden.

- [x] Update the initial classes to match list mode without changing the existing toggle handlers.
- [x] Confirm the list view is visible on initial page load and the Calendar button still switches views.

### Task 3: Keep type labels on one line

**Files:**
- Modify: `css/styles.css` schedule table type pill rules.

**Interfaces:**
- Table type pills do not wrap; table overflow remains horizontally scrollable on narrow screens if needed.

- [x] Apply `white-space: nowrap` to schedule-table type pills and keep the badge aligned within its cell.
- [x] Confirm `REELS DE TESTE` remains on one line in the list.

### Task 4: Read back the Planner UI

**Files:** None.

- [x] Reload the local Planner and visually confirm list-first mode, status filter defaults, status toggling, and one-line type labels.
- [x] Confirm status-filter interaction is client-side and leaves the stored schedule list unchanged.
