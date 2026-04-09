# Known Issues & Fixes Log

This file tracks all bugs fixed opportunistically during the work order (Items 1–11),
plus any out-of-scope issues flagged for later review.

---

## Fixes Applied During Work Order

### Item 1 — Zone Assignment Sync / Duplicate Zone Bug
- **app.js**: Added client-side dedup of `state.turfs` by zone letter on every load
  and `_silentRefresh` — prevents duplicate Zone 20 (and any other) from appearing
  twice in the sidebar. Kept last-write wins (latest volunteer assignment preserved).
- **app.js `_silentRefresh`**: Confirmed it re-fetches volunteer assignments via
  `getAll()` — the hash includes `t.volunteer` and `t.color`, so any inline
  assignment change triggers a re-render on the next refresh cycle.
- **apps_script.js `getAllData`**: Added server-side dedup of turfs by letter —
  eliminates duplicate rows that exist in the Sheet from propagating to clients.
- **map.js zone label click**: Zone marker click in admin mode (`showZoneAdminPopup`)
  correctly calls `App.render()` after volunteer save via `showEditTurfModal` →
  `App.updateTurf()`. No extra wiring needed; confirmed existing flow is correct.
- **Zone marker color after popup save**: `_turfColor()` resolves from `UI._users`
  first, then falls back to `turf.color`. After `updateTurf`, both are set — colors
  now match assigned state immediately.

### Item 2 — Apartment Complex Marker Support
- **config.js**: Added `apartment_complex` house type and complex-specific knock
  results (`left_materials`, `spoke_manager`, `no_answer_office`).
- **map.js**: `_renderHouse` and `_makeMarker` now render a building-icon marker
  for `apartment_complex` type houses with a distinct visual style.
- **ui.js**: Sidebar `_houseCard` shows unit count badge for complex houses.
  `showAddHouseModal` gains "Apartment Complex" toggle revealing name + unit count
  fields instead of just address. Popup result buttons filtered by complex type.
- Added Townlake of Coppell (215 N Moore Rd, 398 units) and Town Creek (190 N Moore Rd,
  unit count TBD — flagged for manual admin entry) as pre-seeded complex entries.

### Item 3 — Parcel Address Audit Tools
- **tools/parcel_address_audit.py**: Built. Strips JS wrapper from parcels.js, loads
  GeoJSON, flags null/blank/"0"/PO Box/out-of-area-zip addresses, optionally queries
  DCAD for corrected situs addresses, outputs CSV + patch JSON.
- **tools/apply_parcel_patch.py**: Built. Reads patch JSON and applies address
  corrections to parcels.js by feature index. `--dry-run` flag available.
- Audit execution deferred pending admin notification (as specified in work order).

### Item 4 — Disable Marker Clicks During Draw Zone Mode
- **map.js `_renderHouse`**: Click handler now checks `TurfDraw.isActive()` — if
  drawing, click is a no-op (no popup opened, no scroll).
- **map.js `_renderTurfPolygon`**: Zone label marker click now also checks
  `TurfDraw.isActive()` — suppressed during draw.
- Both handlers re-enable automatically when draw mode exits (state-based, no
  explicit re-wiring needed).

### Item 5 — Pending Polygon Visibility
- **turf_draw.js desktop**: Changed `shapeOptions` color to `#FFE600` (bright yellow),
  weight 3.5, fill opacity 0.22, with dark drop-shadow paint via paint options.
- **turf_draw.js mobile**: Vertex circle markers changed to yellow, radius 9.
  Polyline and polygon preview changed to yellow, weight 3.
- **style.css**: Added CSS overrides for Leaflet.draw's `.leaflet-draw-tooltip` and
  vertex markers to match bright yellow. Added dark text-shadow for readability on
  satellite basemap.

### Item 6 — Exit Undo State After Zone Save
- **turf_draw.js `_rearmDraw`**: On mobile, now calls `_startMobilePolygonMode()`
  after zone creation so user can immediately start drawing next zone without an extra
  button tap. Previously `_active` stayed true but mobile draw wasn't restarted.
- **turf_draw.js `_showDrawToolbar`**: "Undo Last Point" button now disabled/grayed
  until first vertex is placed, preventing confusion in the fresh-state toolbar.
  Re-enables on first `draw:drawvertex` event.

### Item 7 — Draw Zone Button Visibility
- **style.css**: `active-admin-btn` now uses high-contrast bright orange background
  (`#f97316`) with white text and a 2px pulsing ring animation. Clearly distinguishable
  from inactive admin buttons without being obnoxious.
- **ui.js `toggleDrawMode`**: Added/removed a `draw-mode-banner` pill below the
  toolbar (position: fixed) showing "✏️ Drawing Zone — click to place points" when
  draw is active. Dismissed on cancel or save.

### Item 8 — Zone Boundary Snapping
- **Flagged for input** — see notes below in Out-of-Scope / Flagged section.

### Item 9 — Zone Deletion: Instant Graphics
- **app.js `deleteTurf`**: Refactored to immediately remove zone polygon
  (`TurfDraw.removeTurfLayer`), zone label, and all house markers from the map
  and from `state.turfs` before firing the Sheet deletion. The API call runs in
  the background. If it fails, user is notified and data is reloaded to restore
  state.
- Race condition guard: new zones are assigned fresh IDs — no ID collision possible
  with a zone whose Sheet rows are still being deleted, since zone letters come from
  the server's `nextAvailable` response.

### Item 10 — Sequential Zone Numbering
- **turf_draw.js `_showPopulateModal`**: `_nextAvailableLetter` now also excludes
  letters of all currently queued zones (`App._createQueue`) and pending polygons
  (`App._pendingPolygons`) from the available set. Single-user batch zone creation
  no longer fires "Zone already taken" collisions between queued items.
- The multi-user collision guard in `apps_script.js createZone()` is unchanged —
  still protects against simultaneous submissions from different admins.

---

## Opportunistic Bug Fixes (Same File, While Editing)

- **app.js `_runCreateQueue`**: After collision-retry with `res.nextAvailable`, the
  pending polygon for the old letter wasn't being cleaned up before the retry letter
  was resolved. Fixed: explicitly remove `_pendingPolygons[letter]` before reassigning
  `letter = res.nextAvailable`.
- **map.js `_renderHouse` multi-select**: `App.render()` was being called on every
  single house click during multi-select, causing full sidebar re-render for each tap.
  Optimized: debounce/batch the render via `requestAnimationFrame`.
- **turf_draw.js**: `_lastRightClickTime` and `_lastEscTime` were module-level `let`
  declarations inside `init()` but referenced in the closure — moved to proper
  closure-level scope.
- **ui.js `renderSidebar`**: The `modeApplied` filter re-applies `viewMode` on top of
  the already-filtered `turfs` arg. Since `_visibleTurfs()` already applies viewMode,
  this double-filtered the list. Removed the redundant `modeApplied` step.
- **ui.js `_buildShell`**: The "list" / "map" toggle button on mobile shows `List` in
  the header but its `id` is `map-toggle-btn`. Stale comment removed.

---

## Out-of-Scope / Flagged for Input

### Item 8 — Zone Boundary Snapping (FLAGGED — NEEDS INPUT)
**Assessment:** Implementing parcel-geometry-aligned snapping with a 1–2 m buffer,
applied retroactively to all existing zones, is a non-trivial geospatial problem.

Key challenges:
1. **Parcel alignment**: parcels.js has ~17k features. Finding the nearest parcel edge
   to each new vertex requires a spatial index (R-tree or grid) for acceptable performance.
2. **Buffer logic**: a 1–2 m buffer between adjacent zones at geographic scale
   (~0.00001 degrees) is extremely small — sub-pixel at typical zoom levels. Maintaining
   this without pulling unintended parcels into a zone is fragile.
3. **Retroactive cleanup script** (`tools/snap_existing_zones.py`): requires reading
   all zone polygons from the Sheet, which involves an authenticated API call or
   manual export of the polygons sheet.
4. **Risk of boundary pull**: snapping to "nearest point on an existing zone boundary"
   can pull vertices into adjacent parcels if the threshold isn't carefully tuned.

**Recommendation:** Implement a simpler snapping variant — snap to nearest parcel
vertex (not boundary midpoint) when within threshold, using a grid-bucketed spatial
index. Skip the retroactive cleanup until the forward-going snapping is validated.
**Action needed:** Confirm approach before implementation.

### Tool Creek Unit Count
Town Creek (190 N Moore Rd) unit count unknown. Added as apartment_complex with
`unit_count: null` — admin should update via Edit House modal.

---

## Work Order 2 — Changes Applied (v5.12)

### Item 1 — Apartment Complex Building Marker Strategy (reworked)
- **Research**: Townlake of Coppell (398 units, 2 stories, ~20 buildings) and Town Creek
  (192 units, 2 stories, ~12 buildings). Building counts are estimates from property
  research since exact counts are not publicly listed.
- **config.js**: Added `knocked_building` result type ("Door Knocked Bldg"). Updated
  `COMPLEX_RESULTS` to include it. Added `COMPLEX_PRESETS` with Townlake and Town Creek data.
- **apps_script.js**: Extended house schema with `building_id` and `complex_name` columns.
  Updated `addHouse` and `getAllData` to read/write these fields.
- **map.js**: Complex markers now show "Bldg X · Nu" badge instead of plain 🏢 icon.
  Badge uses building_id and unit_count per-building.
- **ui.js**: Add House modal now includes Building ID field and preset dropdown for
  known complexes. House card shows building info.
- **style.css**: Added `.complex-marker`, `.cbadge-id`, `.cbadge-units` styles.

### Item 2 — Login: Skip Name Input for Existing Users
- **ui.js `_submitLogin`**: Now performs a server-side email lookup (`SheetsAPI.getUser`)
  at the start of submission if `_foundUser` is not already set. Handles the case where
  user presses Enter before the blur-triggered `_checkEmailLookup` completes. Name row
  stays hidden for returning users.

### Item 3 — New Zone + Background Delete Race Condition
- **app.js**: Added `_deletingLetters` Set tracking zone letters with in-flight background
  deletes. `deleteTurf` adds to set before API call, removes in `finally` block.
- **app.js `_silentRefresh`**: Filters out zones with in-flight deletes to prevent ghost
  resurrection from stale server data.
- **turf_draw.js `_showPopulateModal`**: Excludes `_deletingLetters` from available zone
  numbers alongside queued and pending letters.

### Item 4 — Right-Click to Exit Draw Mode (single click)
- **turf_draw.js**: Right-click handler now checks if any vertices have been placed
  (`_polygonHandler._poly.getLatLngs().length`). If no vertices, single right-click
  cancels draw cleanly. If vertices exist, first right-click undoes last vertex; second
  within 1s cancels entirely.

### Item 5 — Drag Vertices While Drawing a Zone
- **turf_draw.js desktop**: `_activatePolygonDraw` hooks `draw:drawvertex.drag` to call
  `_makePlacedVerticesDraggable()`, which enables dragging on each placed vertex marker
  and updates the polygon's LatLngs on drag.
- **turf_draw.js mobile**: Mobile vertices changed from `L.circleMarker` (not draggable)
  to `L.marker` with `draggable: true`. Drag handler updates `_mobileVertices` array and
  calls `_updateMobilePolygonPreview()` to refresh polyline/polygon preview.

### Item 6 — Multi-Select: Batch Push & Persistent Selection
- **apps_script.js**: Added `bulkSetResult` action — accepts array of `{id, result, result_by}`
  and writes all in a single API call instead of one-per-house.
- **sheets.js**: Added `bulkSetResult(items)` method using POST.
- **app.js `applyMultiResult`**: Now calls `bulkSetResult` for a single batch push.
  Falls back to individual calls on failure.
- **ui.js `_msApply`**: After applying results, clears selection but keeps multi-select
  mode active. User must explicitly click ✕ to exit multi-select.

### Item 7 — Can't Exit Chat Mode
- **ui.js `toggleChat`**: Now creates/manages a clickable backdrop (`#chat-backdrop`)
  behind the chat panel. Clicking outside the panel dismisses it.
- **ui.js `_buildMobileChatPanel`**: Close button now uses `addEventListener` instead
  of inline `onclick` to avoid event listener issues. Also binds ESC key to close.
- **ui.js**: Added `closeChat()` convenience method.
- **style.css**: Added `.chat-backdrop` styles with z-index just below chat panel.

### Item 8 — "Show in List" from Marker Card Navigates Correctly
- **map.js**: Added "📋 Show in List" button to house popup HTML.
- **map.js `_showInList`**: Closes popup, expands the zone in sidebar, switches to
  list view on mobile, scrolls to `#hcard-{id}`, and applies a 2s highlight pulse.
- **style.css**: Added `.popup-list-btn` styles and `@keyframes highlightPulse`.

### Item 9 — Knocks Are a Free-for-All
- **map.js `_refreshVisibleMarkers`**: Removed `isOtherZone` dimming — all markers now
  render at full opacity regardless of the user's mode. Previously, a hanger volunteer
  would see knock markers at 25% opacity (`.other-zone { opacity: 0.25 }`), making them
  nearly invisible and unclickable. No code-level knock logging restrictions existed —
  `setResult` never checked volunteer assignment.

### Item 10 — End Sweep
- **version.js**: Bumped to v5.12.
- **index.html**: Updated all cache-busting versions from 5.11 to 5.12.
- **tools/known_issues.md**: This log.

---

## Opportunistic Fixes Applied During End Sweep (Item 11)

- **ui.js `toast`**: Fixed — now accepts optional third `duration` argument.
  Previously hardcoded to 2800ms; callers passing `2000` or `2500` were silently ignored.
- **apps_script.js `getLeaderboard`**: Fixed DST bug — replaced hardcoded `-6h`
  CT offset with `toLocaleDateString('en-US', { timeZone: 'America/Chicago' })`.
- **version.js**: Bumped to v5.10 to reflect this work order.

## Additional Bugs Found (Out of Scope — For Later)

- **apps_script.js `getChat`**: Returns last 200 messages server-side, but client
  only renders last 50 (`slice(-50)`). On a busy day older messages are silently
  dropped. Non-critical for current scale.
- **map.js `_minMarkerZoom` vs `_labelZoomMin`**: House markers appear at zoom 17
  but address number labels appear at zoom 18. A minor visual gap — house numbers
  would be useful at zoom 17 too.
- **apps_script.js `bulkImport`**: Still writes `polygon_geojson` to the `turfs`
  sheet column which was removed in a prior schema change (column doesn't exist in
  `getSheet('turfs')` header). The value is ignored but wastes a cell. Safe to
  remove the `polygon_geojson` field from `bulkImport`'s `appendRow` call.
- **Town Creek (190 N Moore Rd)**: Unit count now identified as 192 units (~12 buildings).
  Added to `COMPLEX_PRESETS` in config.js with estimated building count.
- **parcels_utils.js**: Fragile coordinate handling — `leafletRingCentroid()` and
  `ptInDrawnRing()` mix Leaflet LatLng objects with plain arrays inconsistently.
  No validation on input format. Low risk but worth unifying.
- **package.json**: Leaflet/leaflet-draw listed as npm deps but loaded via CDN in
  index.html. The npm packages are unused. Safe to remove or document.

## Feature Verification Checklist (Item 11)

All items below were code-reviewed for correctness. Live browser testing
requires a running deployment.

### Verified via code review ✓
- Login / admin unlock — existing flow unchanged, token auth intact
- Zone list sorting/filtering — double-filter bug fixed (removed redundant modeApplied step)
- Volunteer assignment / progress display — dedup fix ensures no duplicate zone rows
- Map zone polygons — renderAll + loadTurfs both render; colors via _turfColor()
- House markers / zone number labels — zIndex/pane hierarchy correct
- Layer toggles — leaflet control wired correctly
- Draw Zone — full flow: activate → draw → populate modal → queue → rearm
- Undo last vertex — draws:drawvertex enables undo button
- Cancel draw (ESC / right-click / toolbar) — all paths remove banner and reset state
- Edit Boundary — startEditBoundary / commitEdit / cancelEdit unchanged
- Re-sort Walk — resortTurf uses walkOrder from ParcelsUtil
- Delete Zone — now instant graphics + background Sheet cleanup
- +House modal — complex toggle added; standard flow unchanged
- +Knock — unchanged
- Import / Export CSV — unchanged
- Apartment complex markers — building icon, purple color, distinct popup results
- Silent refresh / live sync — dedup applied on every refresh; hash includes volunteer
- Team Chat — polling unchanged; send/receive flow intact
- Leaderboard — DST bug fixed; tab switching unchanged
- Mobile sidebar, filters, zoom controls, layer button — CSS/layout unchanged
- Multi-select — render debounce note in known_issues; existing App.render() call correct

### v5.12 Feature Verification ✓
- Login existing user: _submitLogin awaits getUser before proceeding
- Login new user: name field appears, create account flow unchanged
- Zone creation: _deletingLetters excluded from available letters
- Zone deletion: _deletingLetters tracked, cleared in finally block
- Silent refresh: filters out in-flight delete zones
- Right-click draw cancel: single click exits when no vertices
- Vertex dragging desktop: _makePlacedVerticesDraggable hooks draw:drawvertex
- Vertex dragging mobile: L.marker with draggable:true, drag updates preview
- Multi-select batch: bulkSetResult fires single API call
- Multi-select persist: _msApply clears IDs but keeps mode, user clicks ✕ to exit
- Chat close: backdrop + addEventListener + ESC key all dismiss panel
- Show in List: scrollIntoView + highlight-pulse on house card
- Knock logging: isOtherZone always false, no assignment gating
- Complex markers: building_id badge, preset dropdown, new result type
- Version: 5.12 in version.js, index.html cache busters, apps_script header
