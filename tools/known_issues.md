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
- **Town Creek (190 N Moore Rd)**: Unit count unknown. Added as `apartment_complex`
  with `unit_count: null`. Admin should update via Edit House modal after verifying
  with apartment management.

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

---

## Fixes Applied During Work Order v2 (Items 1–10)

### Item 1 — Knock Marker Zoom Performance Fix
- **map.js `_refreshVisibleMarkers`**: Added early-exit clearing all markers below zoom 15.
  Replaced blanket knock bypass (`always visible`) with two-tier thresholds:
  knock diamonds appear at zoom 15+, hanger circles at zoom 17+ (`_minMarkerZoom`).
  Below zoom 15, `houseGroup.clearLayers()` removes all DOM elements — fixes mobile lag.
- **map.js `_updateZoomStyle`**: Updated comment to reflect zoom 15-16 range for knock-only.

### Item 2 — Knock/Hanger Marker Overlap
- **map.js `_makeMarker`**: Knock diamonds now render at 20x20px (vs 26x26 for hangers),
  with `zIndexOffset: 300` (higher than hanger's 100). Both markers visible at shared addresses.
- **style.css `.house-dot.diamond`**: Added `border: 1.5px solid #fff` and
  `box-shadow: 0 0 3px rgba(0,0,0,0.35)` for visual separation from hanger circles beneath.

### Item 3 — Consolidate Knock Zones in Sidebar
- **ui.js `renderSidebar`**: Knock turfs now merged into single "Knocks" block at sidebar top.
  Aggregates house count and progress bar across all knock zones. Houses sorted by address
  in one flat list. Each house card still references its real underlying turf for data writes.
  Hanger zones render individually below the consolidated knock block.

### Item 4 — Remove Special Import Button, Consolidate Import
- **ui.js**: Deleted `📥 Voter Knocks` button from both admin toolbar renderings.
  Deleted `importVoterKnocks()` method (one-time bulk import function).
- **ui.js `_handleImportFile`**: Added voter CSV auto-detection. If header contains
  `voters`, `voter_count`, or `total_votes` columns → routes to `_handleVoterImportFile()`.
- **ui.js `_handleVoterImportFile`**: New method. Parses voter data CSVs, matches addresses
  to parcels, groups by precinct, imports as knock zones via `bulkImport`.
- **ui.js `exportCSV`**: Added voter data columns (`voters`, `voter_count`, `total_votes`,
  `may_votes`, `nov_votes`, `precinct`) for round-trip compatibility with voter CSV import.

### Item 6 — Apps Script CLASP Sync
- **`.gitignore`**: Added `.clasprc.json` (OAuth tokens — never commit).
- **DEPLOYMENT.md**: Created. Documents script ID, stable deployment URL, CLASP workflow,
  first-time setup steps. CLASP interactive login deferred to user.
- `.clasp.json` and `.claspignore` already correctly configured in repo.

### Item 8 — Zone Claim/Assign Polygon Color (Verified)
- **Confirmed already fixed in prior work order.** `claimZone()`, `unclaimZone()`, and
  `updateTurf()` all call `MapModule.setZoneStyle()` + `TurfDraw.setZoneStyle()` immediately
  after API success, then `render()`. User record ensured in `_users` cache before render.

### Item 9 — Missing House Markers Audit
- Knock zone polygons are stored in Google Sheets (not in repo). Full point-in-polygon
  audit requires live API data. knock_zones_import.js contains 1,784 houses across 15 zones
  (precincts 2601-4677). Diagnostic script provided but cannot run without Sheet access.

### Item 10 — Knock Data Verification & 830 Spyglass

**Full match audit results:**
- Total voter_data keys: 2,086
- Exact matches to parcels: 1,608 (77.1%)
- No parcel match: 478 (22.9%)
  - 386 of these have ", IRVING" city suffix (Irving addresses in CISD precincts)
  - After stripping city suffix: 163 rescued, 315 truly unmatched (15.1%)
- Abbreviation mismatches (DR/DRIVE etc.): zero impact — both files use same abbreviations
- Remaining 315 unmatched: mostly Irving addresses (N MacArthur Blvd, Stone Harbor Way,
  Sandbar Dr, Offshore Dr, Mateo Trl — Valley Ranch/Las Colinas area, not Coppell parcels)

**830 SPYGLASS DR: Confirmed nonexistent** in both voter_data.js and parcels.js.
SPYGLASS DR parcels range 101-416. SPYGLASS CV includes 889-902. No "830" SPYGLASS
exists in Coppell DCAD parcel data. This address is not a real Coppell property.

### Item 5 — NW Coppell Knock Data Gap

**Geographic analysis** (NW = north of Sandy Lake Rd lat>=32.975, west of Denton Tap lon<=-96.99):
- Parcels in NW quadrant: 1,433 (1,322 unique addresses)
- Voter_data entries matching NW parcels: 150 (11.4% of NW parcels)
- Knock zone precincts covering NW: **2805** (13 houses), **2808** (136 houses)

**Diagnosis:** NW Coppell is significantly under-represented. Precincts 2805 and 2808
partially cover the area but contribute only ~149 knock-zone houses. The gap is primarily
a **precinct coverage issue** — NW Coppell may need additional precincts included in
the voter file, or the 2805/2808 precincts may straddle the NW boundary with most
qualifying voters falling outside the NW quadrant. To fill the gap, regenerate voter
data with broader precinct coverage or lower vote thresholds for NW-area precincts.

## Opportunistic Fixes (Work Order v2)

- **ui.js `renderSidebar`**: Removed `isKnock` check from claim/unclaim buttons
  (was redundant since knock zones are now consolidated and don't show claim buttons).

---

## v5.18 Critical Bug Fixes

### Item 1 — Polygon Color (REAL ROOT CAUSE FOUND)
- **map.js `_renderTurfPolygon` (line 347):** `fillColor` was HARDCODED to `'#000000'`
  regardless of assignment. Border was correct (volunteer color) but fill was always
  black at 14% opacity, making polygons look dark/grey on satellite. **Fix:** changed
  to `fillColor: isUnassigned ? '#000000' : color`. Bumped fillOpacity to 0.18 for
  better visibility of assigned colors.
- **map.js `setZoneStyle`:** Was only updating `color` (border), not `fillColor`.
  After claim/assign the border updated but the fill stayed wrong. **Fix:** updates
  both `color` and `fillColor` in one `setStyle()` call. Also updates the zone label
  background color in turfLabelGroup so it matches immediately.
- **ui.js login flow:** `getUsers()` was fired with `.then()` (no await), so first
  `App.render()` could happen before `_users` cache loaded. `_turfColor()` would
  fall back to `turf.color` which may be wrong. **Fix:** awaited `getUsers()` in
  both `init()` (saved login path) and `_completeLogin()` (new login path) before
  calling `_postLogin() → App.init() → render()`.

### Item 2 — Knock Data Gap (1,301 → 1,730 markers)
- **Architectural change per user directive**: knock markers no longer depend on
  Sheets house_data. They're synthesized at runtime from voter_data + parcels.
- **tools/build_voter_data.py (NEW):** Builds `voter_data.js` (2,086 keys) and
  `voter_knocks.js` (1,730 parcel-matched entries) from the source CSV with
  abbreviation normalization (DR/DRIVE, ST/STREET, LN/LANE, etc.) and city
  stripping (`, COPPELL`, `, IRVING`).
- **voter_knocks.js (NEW):** Static asset loaded by index.html. Each entry has
  `{lat, lon, address, normKey, precinct, voterCount}`.
- **app.js `_buildVirtualKnockTurf`:** At `loadData()` and every `_silentRefresh()`,
  builds a synthetic `_VK` turf from VOTER_KNOCKS containing every voter address
  not already in a Sheet knock turf (dedup by normalized address). The virtual
  turf has `mode: 'knock'` and flows through the existing rendering pipeline.
- **app.js `setResult` interception:** When a virtual house (id starts with `vk_`,
  `_virtual: true` flag) gets a result recorded, calls `addHouse` first to
  materialize it into Sheets, then proceeds with the real result write.
- **Result**: 1,730 knock markers will render (vs 1,301 before). The remaining
  ~356 voter addresses can't match Coppell parcels (Irving / Las Colinas
  addresses outside the Coppell parcel data).

### Item 3 — Valley Ranch Duplicate Parcels & Missing Numbers
- **Root cause found:** parcels.js source data has 927 duplicate `addr2` groups
  totaling 1,786 excess parcels. Two patterns:
  1. **Mailing-address contamination** — HOA / property management LLCs use their
     office address (e.g. `8360 E VIA DE VENTURA STE L100` x19, `1722 ROUTH ST
     STE 770` x136) as the situs address for many properties they own.
  2. **Owner mailing leaks** — investor/landlord owners have their personal home
     address (e.g. `140 LEVEE PL` x9 owned by NAULT SHAE, `723 MADISON ST` x2
     owned by GOWDA) leaking into addr2 for their other rental properties.
- **tools/dedupe_parcels.py (NEW):** Smart dedup script that:
  1. Identifies mailing/commercial dups (STE/SUITE in addr2, 10+ copies, or
     all-commercial owners) → blanks ALL of them (definitely wrong).
  2. For residential dups, builds a CLEAN street index excluding all dup
     parcels, then uses linear interpolation between the closest non-dup
     neighbors above and below the duplicate's number to predict where it
     SHOULD be. Picks the parcel whose centroid is closest (must be <60m AND
     1.3x closer than runner-up). If no clear winner, blanks all in the group.
- **Backup:** parcels.js was backed up to `temp/parcels.js.backup-v5.18` before
  modification (md5 verified identical to pre-edit state).
- **Result:** 2,280 parcels' addr2 blanked. 695 mailing-address dups eliminated.
  433 residential dup groups had clean spatial winners kept. 395 ambiguous
  residential groups had all parcels blanked. Spot-checked Valley Ranch test
  cases (9413 RUIDOSA TRL x5, 9405 RUIDOSA TRL x3, 505 SIERRA BLANCA PASS x3,
  9401 RUIDOSA TRL x2) — all reduced to 1 parcel each, correctly placed.
- **Trade-off:** 41 voter addresses lost their parcel match (down from 1771 to
  1730 matches). These were previously matching the WRONG parcel (a dup at the
  wrong location). Better to have 1730 correct knocks than 1771 with 41
  wrong-positioned ones.

### Item 6 — Apps Script CLASP Sync
- Manual `clasp login` still required (no interactive OAuth in this session).
- DEPLOYMENT.md from v5.17 documents the manual workflow.

### Item 5 — Testing
- **Static smoke test (passed):** All v5.18 code changes verified at source level.
  Valley Ranch dups confirmed reduced to 1 parcel each. voter_knocks.js loads
  correctly (1730 entries). voter_data.js loads correctly (2086 keys).
- **Node.js data integrity (passed):** All JS data files parse without errors.
  Sample VOTER_KNOCKS entry verified to have lat/lon/address/normKey/precinct.
- **Browser test (blocked):** Playwright browser test couldn't run because the
  egress proxy blocks the leaflet CDN (unpkg.com), preventing the page from
  fully initializing. Visual verification needs to happen on the live deployed
  site after push.

## Files Changed in v5.18
- map.js — polygon color fixes (Item 1)
- ui.js — await getUsers in login (Item 1)
- app.js — virtual knock turf, setResult interception (Item 2)
- index.html — load voter_knocks.js, version bumps (Items 2, 6)
- voter_data.js — REGENERATED from CSV (Item 2)
- voter_knocks.js — NEW (Item 2)
- parcels.js — DEDUPED (Item 3) — backup at temp/parcels.js.backup-v5.18
- tools/build_voter_data.py — NEW
- tools/dedupe_parcels.py — NEW
- tools/dedupe_report.txt — NEW (audit log)
- version.js — v5.17 → v5.18
