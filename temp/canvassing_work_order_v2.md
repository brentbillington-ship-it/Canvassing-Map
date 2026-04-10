# Canvassing App — Work Order
## Claude Code Session | April 2026

---

## START HERE — Required Reading

Before writing a single line of code:

1. Read `CLAUDE_CODE_STANDING_RULES.md` from the repo root (fetch via GitHub API if not present locally). All rules there apply to this session.
2. Read `CANVASSING_KICKOFF.md` from the repo root for app-specific context.
3. Run `superpowers.brainstorm` — produce a full plan covering every item below before writing any code.
4. Notify me (Claude Code push notification) when the brainstorm is ready. **Do not start coding until I confirm.**

**Repo:** `brentbillington-ship-it/Canvassing-Map`  
**GitHub PAT:** `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`  
**App password:** `choochoo`  
**Apps Script URL (canvass):** ends in `...E816I/exec`  
**Apps Script URL (signs):** ends in `...G9wU/exec`

---

## Standing Rule Reminder

**NEVER push to GitHub or execute irreversible changes without an explicit "go" from Brent.** Always:
1. Propose changes as a numbered list
2. Stop and wait
3. Proceed only after explicit approval

Exception: The parcel fix (Item 1) has pre-authorization to push `parcels.js` after Brent reviews the audit CSV. See Item 1 for details.

---

## Item 1 — Parcel Fix (DCAD Address Audit & Patch)

**Background:** `parcels.js` contains 17,436 GeoJSON parcel features. A prior audit identified:
- **671 blank/zero** address fields
- **574 mismatch/bad** addresses (mailing address vs. physical situs address)
- **1,245 total flagged** parcels

Previous attempts to fix via DCAD REST API all returned null. The Playwright-based debug never ran. Claude Code needs to complete this now from within its own environment.

**Tasks:**

### 1a — Pull parcels.js from GitHub
Fetch `parcels.js` from `brentbillington-ship-it/Canvassing-Map` via GitHub API (GET contents endpoint, base64 decode). Do not clone the repo — use the API.

### 1b — Identify the real DCAD API endpoint
Use Playwright to open `https://maps.dcad.org/prd/dpm/`, intercept all XHR/fetch network requests while clicking a known Coppell parcel at approximately lat `32.9888083`, lon `-96.996685`. Log every request URL + response that returns address or parcel data. This will reveal the exact endpoint the DCAD map UI uses — it is NOT the REST API previously tried (`/prdwa/rest/services/Property/ParcelQuery/MapServer/4/query`).

### 1c — Run the full audit
Once the working DCAD endpoint is confirmed:
- Iterate all 1,245 flagged parcels
- For blank parcels: query by centroid coordinates
- For mismatch parcels: query by centroid and compare DCAD situs to current addr2
- Write `parcel_audit_results.csv` with columns: `feature_index`, `parcel_id`, `current_address`, `dcad_situs_address`, `centroid_lat`, `centroid_lng`, `status`

### 1d — Notify Brent before patching
**Stop here. Send a push notification and wait for explicit "go" before applying the patch.**  
Share a summary: how many BLANK filled, how many MISMATCH corrected, how many NOT_FOUND.

### 1e — Apply the patch (after "go")
- Correct all BLANK and MISMATCH parcels with DCAD situs address in `parcels.js`
- For MISMATCH cases: **delete** the bad entry from `parcels.js` entirely rather than patching with a wrong address — do not leave mismatch data in the file
- For NOT_FOUND (no DCAD result): leave as-is, do not blank them out
- Push updated `parcels.js` to `main` branch on GitHub

**Data fields in parcels.js:** `name`, `owner`, `addr1`, `addr2` — the address fields are `addr1` and `addr2`.

---

## Item 2 — Knocks Data Import (Voter File)

**Background:** The canvassing app tracks which houses have been knocked. We need to seed each house with registered voter names and their individual vote history counts from the voter file.

**Source data format (2,102 rows, one row per household address):**
```
address: "137 HOLLYWOOD DR, COPPELL, TX 75019"
voters:  "CHRISTOPHER WILLIAMS; MARLA WILLIAMS; ETHAN WILLIAMS; EVAN WILLIAMS"
voter_count: 4
total_votes: "8, 8, 7, 7"    ← comma-separated, one count per voter (parallel to voters)
may_votes:   "4, 4, 3, 3"
nov_votes:   "4, 4, 4, 4"
precinct:    2807
```

**What needs to happen:**

### 2a — Voter data JSON file
Generate `voter_data.json` — a dictionary keyed by normalized address (uppercase, stripped of city/state/zip) mapping to:
```json
{
  "137 HOLLYWOOD DR": {
    "voters": [
      { "name": "CHRISTOPHER WILLIAMS", "total_votes": 8, "may_votes": 4, "nov_votes": 4 },
      { "name": "MARLA WILLIAMS",       "total_votes": 8, "may_votes": 4, "nov_votes": 4 },
      { "name": "ETHAN WILLIAMS",       "total_votes": 7, "may_votes": 3, "nov_votes": 4 },
      { "name": "EVAN WILLIAMS",        "total_votes": 7, "may_votes": 3, "nov_votes": 4 }
    ]
  }
}
```
Include `total_votes`, `may_votes`, and `nov_votes` for all voters. `may_votes` drives red school stars; `nov_votes` drives blue city stars. Normalize address key: strip `, COPPELL, TX 75019` and any city/state/zip suffix, uppercase, strip extra whitespace.

### 2b — Address matching logic
When a volunteer opens a house marker, the app needs to look up that house's address in `voter_data.json` and display:
- List of registered voter names at the address
- Each voter's `total_votes` count shown next to their name (e.g., "CHRISTOPHER WILLIAMS — 8 votes")

Matching: strip the parcel's `addr2` to the normalized form (strip city/state/zip suffix, uppercase) and look up in `voter_data.json`. Fuzzy match not required — exact normalized match only for now.

### 2c — House modal UI changes
In the house info modal (shown when clicking a house marker):
- Add a "Registered Voters" section below the address
- List each voter name on its own line
- After each name, render two rows of stars inline:
  - **Row 1 — School elections (red ★):** one star per `may_votes` count (CISD school board elections are May)
  - **Row 2 — City elections (blue ★):** one star per `nov_votes` count (city/general elections are November)
  - Stars should be rendered as actual ★ characters styled with color, not images
  - Empty stars (☆) for votes not cast are not needed — only show filled stars for actual votes
- Example rendering for CHRISTOPHER WILLIAMS with may_votes=4, nov_votes=4:
  ```
  CHRISTOPHER WILLIAMS
  ★★★★  (red)
  ★★★★  (blue)
  ```
- If no voter data matches the address, show nothing (silent)
- This section is read-only — volunteers cannot edit it

### 2d — Apps Script / Sheets impact
Voter data should be loaded from `voter_data.json` as a static JS file (same pattern as `parcels.js`) — **not** stored in Google Sheets. No Apps Script changes needed for this feature.

**Commit `voter_data.json` to the repo root.** Update `index.html` to load it with a `?v=` cache-bust tag.

---

## Item 3 — Zone CSV Export/Import (Admin Mode)

### 3a — Export
In admin mode, add an **"Export Zones CSV"** button (place it near the existing admin controls, not in the main volunteer UI).

Export should produce a CSV with one row per zone containing:
- `zone_id`, `zone_name`, `zone_color`, `zone_type` (hanger/knock), `assignee`, `volunteer_name`, `status`, `polygon_coordinates` (GeoJSON polygon as a JSON string in the cell), `house_count`

Trigger a browser download of `zones_export_YYYY-MM-DD.csv`.

### 3b — Import
Add an **"Import Zones CSV"** button in admin mode (with a file picker).

Import reads the CSV, validates it has the expected columns, then calls the Apps Script API to upsert zones. Show a preview/confirmation modal before writing anything — "This will update X zones. Proceed?"

Import should be additive/overwrite by `zone_id` — it should not delete zones that aren't in the import file.

---

## Item 4 — Zone Color Updates Without Refresh

**Bug:** After claiming or assigning a zone, the Leaflet polygon color doesn't update until the next `_silentRefresh` cycle (up to 15 seconds).

**Fix:** After a successful `claimZone` or `assignZone` API response, immediately update the local zone data object and call the polygon re-render function for that specific zone. Do not wait for the next refresh cycle. The color change should be instant — same frame as the API response.

Find the Leaflet `setStyle()` call pattern already used elsewhere in the codebase and apply it here.

---

## Item 5 — Right-Click Delete Vertex in Create Zone Mode

**Bug:** Right-clicking a vertex to delete it only works when editing an existing zone polygon, not when drawing a new zone.

**Fix:** The right-click vertex delete handler should be attached in both create mode and edit mode. Find where the edit mode handler is registered and apply the same logic to the create mode drawing tool.

---

## Item 6 — Parcel Data Already Addressed in Item 1

No separate item needed.

---

## Completion

When all items are done:
1. Bump `version.js` — increment patch version
2. Update all `?v=` query strings in `index.html` 
3. Push to `main`
4. Send a push notification: "Canvassing app work order complete — [version]"

Do not zip files for delivery — push directly to GitHub (this is a GitHub Pages app).

---

## Voter Data File Reference

The voter CSV is at:  
`all-precincts_both_min-may3-nov1_2102rows.csv`

Columns: `address`, `precinct`, `voters`, `voter_count`, `total_votes`, `may_votes`, `nov_votes`

- `voters` is semicolon-delimited, one name per voter
- `total_votes`, `may_votes`, `nov_votes` are comma-delimited parallel arrays matching voter order
- Parse carefully: strip whitespace from each element after splitting
