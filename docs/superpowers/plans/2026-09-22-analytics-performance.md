# Analytics Performance Plan

**Goal:** Keep the Instagram analytics view responsive after period changes, resizes, and chart interaction.

**Architecture:** Keep one pointer interaction listener on the persistent chart container. Each chart render replaces the current interaction data, while pointer work is coalesced to one animation frame and selects the nearest point with binary search. Reduce paint-heavy effects on repeated chart markers and the active tooltip.

**Tech Stack:** Existing vanilla JavaScript, SVG, and CSS.

**Scope:** `js/analises.js` chart interaction lifecycle and `css/analises.css` chart paint effects. No analytics values, API behavior, or publishing flows change.

### Task 1: Make chart pointer handling render-safe

**Files:** `js/analises.js`

- [x] Store the latest chart coordinates and bounds on the analytics module.
- [x] Bind `mousemove` and `mouseleave` once per persistent SVG container.
- [x] Coalesce pointer work with `requestAnimationFrame`, binary-search the nearest point, and update tooltip content only when the selected point changes.
- [x] Refresh the interaction data after each chart render so period changes and resizes do not add listeners or retain detached SVG nodes.

### Task 2: Reduce chart paint work

**Files:** `css/analises.css`

- [x] Remove the full-path SVG drop shadow and small repeated backdrop blurs from chart markers.
- [x] Keep hover feedback while limiting animated properties to transform, opacity, and color.

### Task 3: Verify in the local planner

- [x] Reload `http://127.0.0.1:3000/` and inspect the analytics chart and current period.
- [x] Resize across the desktop and compact breakpoints, restore the normal viewport, and move across the chart; confirm the tooltip, markers, and graph remain responsive and correct.
- [x] Confirm the original API metrics and Reel list still render.
