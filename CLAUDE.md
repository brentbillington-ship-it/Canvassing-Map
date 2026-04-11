# Chaka Canvassing Map — Standing Rules for Claude

## Physical Address vs. DCAD Mailing Address

**This is a recurring source of bugs. Read carefully before touching any address-related code.**

Parcel data (`parcels.js`) is sourced from **DCAD (Dallas Central Appraisal District)**. DCAD records contain two address fields:

| Field | Meaning | Example |
|-------|---------|---------|
| `addr1` / `address` | Owner **mailing** address — could be anywhere | `16815 Dallas Pkwy, Addison TX` |
| `addr2` / situs | **Physical situs** address in Coppell | `312 Mockingbird Ln` |

Voter data (`voter_data.js`) and turf sheet entries also come from DCAD and carry the same distinction.

### The Standing Rule

**Always use the physical/situs address field for map display. Never display a mailing address as a marker label.**

Coppell physical addresses (situs addresses) are **always ≤ 9999**. Any street number greater than 9999 is a DCAD owner mailing address from another city (Dallas, Irving, Lewisville, Addison, etc.) that has bled through.

### Enforcement in Code

Wherever a street number is extracted for display (marker labels, sidebar, etc.), apply this guard:

```javascript
// Numbers > 9999 are DCAD mailing addresses, not Coppell physical addresses.
if (parseInt(num, 10) > 9999) continue; // or return '', or skip
```

This guard exists in two places in `map.js`:

1. **`_renderUnassignedMarkers()`** — filters parcel-only centroid markers
2. **`_makeMarker()`** — filters the `numLabel` shown inside hanger circle markers

**Do not raise this threshold above 9999.** The v5.22 regression (which let 5-digit addresses like "16815" render as marker labels) was caused by accidentally changing `> 9999` to `> 99999`.

---

## Marker Styles

- **Not-visited hanger circle**: `#9ca3af` (must match the legend "Not visited" swatch)
- **Door-knock diamond**: `#b3a8c8`
- House number text: `.house-dot-num` CSS class — near-black `#1f2937` with white glow shadow for legibility on grey background
- Never use white circles for unvisited markers

## Versioning

- Version string lives in `version.js` → `APP_VERSION`
- All `?v=X.XX` cache busters in `index.html` (title, CSS link, all JS script srcs) must be updated to match whenever the version is bumped
- Forgetting to bump cache busters causes browsers to serve stale JS/CSS even after a push
