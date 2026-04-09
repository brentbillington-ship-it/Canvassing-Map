## Standing Rules
Fetch and apply before starting work:
https://raw.githubusercontent.com/brentbillington-ship-it/claude-code-context/main/CLAUDE_CODE_STANDING_RULES.md

---

## Canvassing Map — Project Context

GitHub Pages app for door-to-door political canvassing. Leaflet.js map + Google Sheets backend via Apps Script.

**Live app:** https://brentbillington-ship-it.github.io/Canvassing-Map/
**Admin password:** choochoo
**Current candidate:** Kevin Chaka — Coppell ISD Place 5

---

## Run & Test

```bash
# Run Playwright tests
npx playwright test

# Serve locally (use Live Server in VS Code, or:)
npx serve .
```

No build step — plain JS served directly from GitHub Pages.

---

## Architecture

| Layer | Tech |
|-------|------|
| Frontend | Vanilla JS, Leaflet.js, leaflet-draw |
| Map data | `parcels.js`, `cisd_boundary.js`, `cisd_schools.js` (static JS files) |
| Backend | Google Apps Script (deployed via CLASP) |
| Hosting | GitHub Pages |

---

## Key Files

| File | Purpose |
|------|---------|
| `config.js` | All campaign config — candidate, colors, result types. Change campaign here. |
| `index.html` | App entry point — bump `?v=` query strings on every release |
| `version.js` | Version number — bump on every release |
| `app.js` | App bootstrap |
| `map.js` | Leaflet map, markers, parcel interaction |
| `sheets.js` | Google Sheets read/write via Apps Script API |
| `apps_script.js` | Backend — deploy changes via CLASP, never paste manually |
| `ui.js` | UI panels, modals, sidebar |
| `turf_draw.js` | Polygon draw tool (turf zones) |
| `parcels_utils.js` | Parcel filtering and lookup helpers |

---

## Apps Script Deployment
MUST use CLASP — never paste into the browser editor:
```bash
clasp push   # pushes apps_script.js to Google
```
The deployment URL in `config.js` is stable — CLASP does not change it.

---

## Release Checklist
- Bump `version.js`
- Bump all `?v=` query strings in `index.html`
- Only changed files in zip

---

## MUST follow from standing rules
- Brainstorm before touching code
- `String()` coercion on both sides for Apps Script equality checks
- GitHub MCP for all repo operations
