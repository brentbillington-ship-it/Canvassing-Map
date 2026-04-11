#!/usr/bin/env python3
"""
parcel_address_audit.py  (v2 — full 5-category classifier)
-----------------------------------------------------------
Classifies every parcel in parcels.js and cross-references DCAD ArcGIS REST
API to fix: BLANK addresses, MAILING addresses (owner mailing > 9999 or other
heuristics), OUTLIER addresses (house number outside 0.4×–2.2× neighbor
median), and NON_RESIDENTIAL parcels (parks, drainage, easements).

Classification categories
  OK             – Passes all checks; no action needed.
  BLANK          – addr2 is null, empty, "0", or whitespace.
  MAILING        – House number > 9999 (DCAD owner mailing address by CLAUDE.md
                   rule); OR PO Box; OR zip in addr2 that is not a Coppell-area
                   code; OR SUITE/APT/TRLR/#UNIT pattern not matching residential.
  OUTLIER        – House number is outside 0.4×–2.2× of the median of 6+ spatial
                   neighbors within 250 m.  DCAD is consulted to confirm or fix.
  NON_RESIDENTIAL – addr2 contains PARK/CREEK/ESMT/EASEMENT/RESERVE/OPEN SPACE;
                   OR parcel use field is non-residential; OR < 3 residential
                   neighbors within 200 m.

Usage
    # Probe DCAD endpoint first (recommended):
    python3 tools/parcel_address_audit.py --probe

    # Full audit:
    python3 tools/parcel_address_audit.py [--skip-dcad] [--max-dcad N]

    # After confirming layer/field from probe:
    python3 tools/parcel_address_audit.py --layer-id 4 --addr-field SITEADDRESS

Outputs
    tools/parcel_audit_results.csv
    tools/parcel_address_patch.json
"""

import json, re, os, csv, time, argparse, sys, math, statistics

try:
    import requests
    HAS_REQUESTS = True
except ImportError:
    HAS_REQUESTS = False

# ──────────────────────────────────────────────────────────────────────────────
# Paths
# ──────────────────────────────────────────────────────────────────────────────
TOOLS_DIR   = os.path.dirname(os.path.abspath(__file__))
PARCELS_JS  = os.path.join(TOOLS_DIR, '..', 'parcels.js')
RESULTS_CSV = os.path.join(TOOLS_DIR, 'parcel_audit_results.csv')
PATCH_JSON  = os.path.join(TOOLS_DIR, 'parcel_address_patch.json')

# ──────────────────────────────────────────────────────────────────────────────
# DCAD config
# ──────────────────────────────────────────────────────────────────────────────
# Confirmed working endpoint (from prior Playwright intercept sessions):
DCAD_BASE_PARCEL  = 'https://maps.dcad.org/prdwa/rest/services/Property/ParcelQuery/MapServer'
# Work-order specified endpoint to also try:
DCAD_BASE_PROP    = 'https://maps.dcad.org/prdwa/rest/services/Property/PropMap/MapServer'

DCAD_TIMEOUT = 15
DCAD_HEADERS = {
    'User-Agent': ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                   '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'),
    'Accept':     'application/json, text/plain, */*',
    'Referer':    'https://maps.dcad.org/prd/dpm/',
}
SLEEP_MIN = 0.5
SLEEP_MAX = 1.0

DEFAULT_LAYER      = 4
DEFAULT_ADDR_FIELD = 'SITEADDRESS'

CANDIDATE_LAYERS = list(range(10))
CANDIDATE_ADDR_FIELDS = [
    'SITEADDRESS', 'SITE_ADDRESS', 'SITUS_ADDRESS',
    'ADDRESS', 'ADDR', 'SITE_ADDR', 'PROP_ADDR',
    'PROPERTY_ADDRESS', 'SITUSADDRESS',
]

# Test point: 200 SLEEPY HOLLOW LN, Coppell
TEST_LAT  = 32.9888083
TEST_LON  = -96.996685
TEST_ADDR = '200 SLEEPY HOLLOW LN'

# Coppell-area zip prefixes (75019 is Coppell; others are adjacent/common)
VALID_ZIP_PREFIXES = ('750', '751', '752', '760', '761')

# Outlier thresholds (tightened from prior session's 0.3×–2.5×)
OUTLIER_LOW  = 0.4
OUTLIER_HIGH = 2.2
OUTLIER_MIN_NEIGHBORS = 6
OUTLIER_RADIUS_M = 250   # meters

# Non-residential neighbor isolation threshold
NON_RES_ISOLATION_M       = 200   # meters
NON_RES_ISOLATION_MIN     = 3     # fewer than this → non-residential

# Non-residential keyword patterns in addr2.
# STRICT — only terms that never appear in normal residential street names:
NON_RES_KEYWORDS_STRICT = re.compile(
    r'\b(ESMT|EASEMENT|OPEN\s+SPACE|DRAINAGE|GREENBELT|RESERVE|UTILITY\s+(LOT|EASEMENT|SITE))\b',
    re.IGNORECASE
)
# BROAD — only applied when addr2 has no leading house number (e.g. "DRAINAGE LOT 3"):
NON_RES_KEYWORDS_NONUM = re.compile(
    r'\b(PARK|CREEK|LAKE|POND|COMMON|TRACT|DRAINAGE|RESERVE|UTILITY|GREENBELT|'
    r'OPEN\s+SPACE|ESMT|EASEMENT|WELL\s+SITE)\b',
    re.IGNORECASE
)

# Non-residential use field values
NON_RES_USE = {'COMM', 'COMMERCIAL', 'INDUSTRIAL', 'IND', 'EXEMPT', 'AG',
               'AGRICULTURE', 'VACANT', 'UTIL', 'UTILITY', 'GOV', 'GOVERNMENT',
               'PARK', 'RECREATION', 'SCHOOL', 'CHURCH', 'OTHER'}

# ──────────────────────────────────────────────────────────────────────────────
# Load parcels.js
# ──────────────────────────────────────────────────────────────────────────────

def load_parcels_geojson(path):
    with open(path, 'r', encoding='utf-8') as f:
        raw = f.read()
    raw = re.sub(r'//[^\n]*', '', raw)
    m = re.search(r'(?:const|var|let)\s+\w+\s*=\s*', raw)
    if m:
        raw = raw[m.end():]
    raw = raw.rstrip().rstrip(';').rstrip()
    return json.loads(raw)

# ──────────────────────────────────────────────────────────────────────────────
# Geometry helpers
# ──────────────────────────────────────────────────────────────────────────────

def feature_centroid(feature):
    geom = feature['geometry']
    if geom['type'] == 'Polygon':
        ring = geom['coordinates'][0]
    elif geom['type'] == 'MultiPolygon':
        ring = geom['coordinates'][0][0]
    else:
        return None
    lons = [c[0] for c in ring]
    lats = [c[1] for c in ring]
    return (sum(lats) / len(lats), sum(lons) / len(lons))


def haversine_m(lat1, lon1, lat2, lon2):
    """Distance in metres between two WGS84 points."""
    R = 6_371_000
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlam = math.radians(lon2 - lon1)
    a = math.sin(dphi/2)**2 + math.cos(phi1)*math.cos(phi2)*math.sin(dlam/2)**2
    return 2*R*math.asin(math.sqrt(a))


def wgs84_to_webmercator(lat, lon):
    x = lon * 20037508.342 / 180.0
    y = math.log(math.tan((90 + lat) * math.pi / 360.0)) / (math.pi / 180.0)
    y = y * 20037508.342 / 180.0
    return x, y

# ──────────────────────────────────────────────────────────────────────────────
# Spatial bucket index for fast neighbour lookup
# ──────────────────────────────────────────────────────────────────────────────

def build_spatial_index(centroids):
    """
    Returns a dict: bucket_key → list of (lat, lon, house_num, feature_idx).
    Bucket size ≈ 0.003° (~333m), so a 250m radius search needs ±1 bucket.
    """
    BUCKET = 0.003
    idx = {}
    for i, (lat, lon, num) in enumerate(centroids):
        if lat is None:
            continue
        bk = (int(lat / BUCKET), int(lon / BUCKET))
        idx.setdefault(bk, []).append((lat, lon, num, i))
    return idx, BUCKET


def get_neighbors(lat, lon, spatial_idx, bucket_size, radius_m):
    """Return list of house numbers for residential parcels within radius_m."""
    bk_lat = int(lat / bucket_size)
    bk_lon = int(lon / bucket_size)
    neighbors = []
    for dlat in (-1, 0, 1):
        for dlon in (-1, 0, 1):
            for nb_lat, nb_lon, nb_num, nb_idx in spatial_idx.get((bk_lat+dlat, bk_lon+dlon), []):
                if nb_num is None:
                    continue
                d = haversine_m(lat, lon, nb_lat, nb_lon)
                if 0 < d <= radius_m:
                    neighbors.append(nb_num)
    return neighbors

# ──────────────────────────────────────────────────────────────────────────────
# Address classification
# ──────────────────────────────────────────────────────────────────────────────

def parse_house_num(addr2):
    """Return integer house number or None."""
    if not addr2:
        return None
    m = re.match(r'^(\d+)', addr2.strip())
    return int(m.group(1)) if m else None


def classify_address(addr2, props):
    """
    Returns (category, reason_detail).
    Categories: BLANK, NON_RESIDENTIAL, MAILING, OK
    OUTLIER is applied later via spatial pass.
    """
    a = (addr2 or '').strip()

    # ── BLANK ──────────────────────────────────────────────────────────────
    if not a or re.match(r'^0+$', a):
        return 'BLANK', 'empty_or_zero'

    # ── NON_RESIDENTIAL (keyword) ──────────────────────────────────────────
    # Only apply broad keyword set when addr2 has no leading house number,
    # so we don't flag residential streets named "LAKE PARK DR" or "BRUSHY CREEK TRL".
    has_num = bool(re.match(r'^\d{1,4}\s+\w', a))
    if has_num:
        # Strict keywords only — terms that never appear in normal street names
        if NON_RES_KEYWORDS_STRICT.search(a):
            return 'NON_RESIDENTIAL', 'keyword_in_addr2'
    else:
        # No house number at all — any broad keyword is suspicious
        if NON_RES_KEYWORDS_NONUM.search(a):
            return 'NON_RESIDENTIAL', 'no_num_with_keyword'

    # ── NON_RESIDENTIAL (use field) ────────────────────────────────────────
    use_val = (props.get('use') or '').strip().upper()
    if use_val and use_val in NON_RES_USE:
        return 'NON_RESIDENTIAL', f'use={use_val}'

    upper = a.upper()

    # ── MAILING: PO Box ───────────────────────────────────────────────────
    if re.search(r'\bP\.?\s*O\.?\s*BOX\b', upper):
        return 'MAILING', 'po_box'

    # ── MAILING: out-of-area zip in addr2 ─────────────────────────────────
    z_match = re.search(r'\b(\d{5})\b', a)
    if z_match and not z_match.group(1).startswith(VALID_ZIP_PREFIXES):
        return 'MAILING', f'bad_zip:{z_match.group(1)}'

    # ── MAILING: house number > 9999 (CLAUDE.md rule) ─────────────────────
    num = parse_house_num(a)
    if num is not None and num > 9999:
        return 'MAILING', f'num>{num}'

    # ── MAILING: suite/apt/trlr pattern (non-residential formatting) ───────
    if re.search(r'\b(SUITE|STE|APT|APARTMENT|TRLR|TRAILER|#\s*\d+)\b', upper):
        # Only flag as mailing if there's also a city/state suffix (out-of-area)
        if re.search(r',\s*[A-Z]{2}\s+\d{5}', a):
            return 'MAILING', 'suite_with_city_state'

    return 'OK', ''

# ──────────────────────────────────────────────────────────────────────────────
# DCAD REST API
# ──────────────────────────────────────────────────────────────────────────────

_session = None

def _get_session():
    global _session
    if _session is None:
        _session = requests.Session()
        _session.headers.update(DCAD_HEADERS)
    return _session


def _extract_addr(attrs, addr_field):
    for key in [addr_field, addr_field.upper(), 'SITEADDRESS', 'SITE_ADDRESS', 'PROP_ADDR']:
        val = attrs.get(key)
        if val and str(val).strip():
            return str(val).strip()
    return None


def query_by_coords(lat, lon, base_url, layer_id, addr_field):
    """Spatial envelope query — matches what DCAD map UI sends."""
    PAD_DEG = 0.001
    x_min, y_min = wgs84_to_webmercator(lat - PAD_DEG, lon - PAD_DEG)
    x_max, y_max = wgs84_to_webmercator(lat + PAD_DEG, lon + PAD_DEG)
    params = {
        'geometry':       json.dumps({
            'xmin': x_min, 'ymin': y_min, 'xmax': x_max, 'ymax': y_max,
            'spatialReference': {'wkid': 102100},
        }),
        'geometryType':   'esriGeometryEnvelope',
        'inSR':           '102100',
        'spatialRel':     'esriSpatialRelIntersects',
        'where':          '',
        'outFields':      f'{addr_field},PARCELID,LOWPARCELID',
        'returnGeometry': 'false',
        'f':              'json',
    }
    try:
        r = _get_session().get(f'{base_url}/{layer_id}/query', params=params, timeout=DCAD_TIMEOUT)
        r.raise_for_status()
        data = r.json()
        if 'error' in data:
            return None
        feats = data.get('features', [])
        return _extract_addr(feats[0]['attributes'], addr_field) if feats else None
    except Exception as e:
        print(f'    coord query error ({lat:.5f},{lon:.5f}): {e}', file=sys.stderr)
        return None


def query_by_address(address, base_url, layer_id, addr_field):
    """Text search fallback."""
    safe = ' '.join(address.strip().upper().split()[:3]).replace("'", "''")
    try:
        r = _get_session().get(f'{base_url}/{layer_id}/query', params={
            'where': f"UPPER({addr_field}) LIKE '%{safe}%'",
            'outFields': addr_field, 'returnGeometry': 'false',
            'resultRecordCount': '3', 'f': 'json',
        }, timeout=DCAD_TIMEOUT)
        r.raise_for_status()
        feats = r.json().get('features', [])
        return _extract_addr(feats[0]['attributes'], addr_field) if feats else None
    except Exception as e:
        print(f'    address query error ({address!r}): {e}', file=sys.stderr)
        return None


def dcad_lookup(lat, lon, current_addr, base_url, layer_id, addr_field):
    """Spatial lookup first; address text fallback if blank."""
    result = query_by_coords(lat, lon, base_url, layer_id, addr_field)
    if not result and current_addr:
        result = query_by_address(current_addr, base_url, layer_id, addr_field)
    return result

# ──────────────────────────────────────────────────────────────────────────────
# Probe
# ──────────────────────────────────────────────────────────────────────────────

def probe_dcad():
    print('\n=== Probing DCAD ArcGIS REST API ===')
    if not HAS_REQUESTS:
        print('  ERROR: pip install requests')
        return None, None, None

    PAD_DEG = 0.001
    x_min, y_min = wgs84_to_webmercator(TEST_LAT - PAD_DEG, TEST_LON - PAD_DEG)
    x_max, y_max = wgs84_to_webmercator(TEST_LAT + PAD_DEG, TEST_LON + PAD_DEG)
    envelope = json.dumps({
        'xmin': x_min, 'ymin': y_min, 'xmax': x_max, 'ymax': y_max,
        'spatialReference': {'wkid': 102100},
    })

    for base_url in [DCAD_BASE_PARCEL, DCAD_BASE_PROP]:
        # Get layer list
        try:
            r = _get_session().get(f'{base_url}?f=json', timeout=DCAD_TIMEOUT)
            r.raise_for_status()
            candidate_ids = [l['id'] for l in r.json().get('layers', [])] or CANDIDATE_LAYERS
        except Exception:
            candidate_ids = CANDIDATE_LAYERS

        for lid in candidate_ids:
            try:
                r = _get_session().get(f'{base_url}/{lid}/query', params={
                    'geometry': envelope, 'geometryType': 'esriGeometryEnvelope',
                    'inSR': '102100', 'spatialRel': 'esriSpatialRelIntersects',
                    'where': '', 'outFields': '*', 'returnGeometry': 'false',
                    'resultRecordCount': '1', 'f': 'json',
                }, timeout=DCAD_TIMEOUT)
                r.raise_for_status()
                data = r.json()
            except Exception as e:
                print(f'  Layer {lid} @ {base_url}: {e}')
                continue

            if 'error' in data or not data.get('features'):
                continue

            attrs = data['features'][0].get('attributes', {})
            found_field = None
            for cand in CANDIDATE_ADDR_FIELDS:
                if cand in attrs:
                    found_field = cand; break
            if not found_field:
                for k, v in attrs.items():
                    if v and isinstance(v, str) and re.match(r'^\d+\s+\w', v.strip()):
                        found_field = k; break

            if not found_field:
                continue

            addr_value = attrs.get(found_field, '')
            print(f'  ✓ {base_url} / layer {lid}  field={found_field!r}  value={addr_value!r}')
            print(f'  CONFIRMED: --layer-id {lid} --addr-field {found_field}\n')
            return base_url, lid, found_field

    print('  No working DCAD layer found.')
    return None, None, None

# ──────────────────────────────────────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description='Audit parcels.js addresses against DCAD (v2)')
    parser.add_argument('--probe',      action='store_true')
    parser.add_argument('--skip-dcad',  action='store_true')
    parser.add_argument('--max-dcad',   type=int, default=999999, help='Max DCAD queries')
    parser.add_argument('--layer-id',   type=int, default=None)
    parser.add_argument('--addr-field', type=str, default=None)
    parser.add_argument('--base-url',   type=str, default=None)
    args = parser.parse_args()

    if args.probe:
        probe_dcad()
        return

    if not HAS_REQUESTS and not args.skip_dcad:
        print('WARNING: pip install requests  (DCAD queries will be skipped)')
        args.skip_dcad = True

    base_url   = args.base_url
    layer_id   = args.layer_id
    addr_field = args.addr_field

    if not args.skip_dcad and (base_url is None or layer_id is None or addr_field is None):
        bu, fl, ff = probe_dcad()
        base_url   = bu or DCAD_BASE_PARCEL
        layer_id   = fl if fl is not None else DEFAULT_LAYER
        addr_field = ff if ff is not None else DEFAULT_ADDR_FIELD
        if fl is None:
            print(f'Probe failed — using defaults: base={base_url} layer={layer_id} field={addr_field}')
        print()

    # ── Load ─────────────────────────────────────────────────────────────────
    print(f'Loading {PARCELS_JS}...')
    geojson  = load_parcels_geojson(PARCELS_JS)
    features = geojson.get('features', [])
    print(f'  {len(features)} features loaded.')
    if features:
        print(f'  Fields: {list(features[0].get("properties", {}).keys())}')
    print()

    # ── Pass 1: compute centroids and basic classification ────────────────────
    centroids = []   # (lat, lon, house_num_or_None)  — parallel to features[]
    rows      = []   # one dict per feature

    for idx, feat in enumerate(features):
        props     = feat.get('properties', {})
        addr2     = (props.get('addr2') or '').strip()
        centroid  = feature_centroid(feat)
        lat = round(centroid[0], 6) if centroid else None
        lon = round(centroid[1], 6) if centroid else None
        num = parse_house_num(addr2)
        centroids.append((lat, lon, num))

        cat, detail = classify_address(addr2, props)
        parcel_id = str(props.get('acct') or props.get('id') or props.get('OBJECTID') or idx)
        rows.append({
            'feature_index': idx,
            'parcel_id':     parcel_id,
            'current_address': addr2,
            'dcad_situs_address': '',
            'centroid_lat':  lat or '',
            'centroid_lng':  lon or '',
            'category':      cat,
            'reason':        detail,
            'status':        'PENDING' if cat != 'OK' else 'OK',
            'action':        'NONE',
        })

    counts = {}
    for r in rows:
        counts[r['category']] = counts.get(r['category'], 0) + 1
    print('Classification (pass 1):')
    for k, n in sorted(counts.items(), key=lambda x: -x[1]):
        print(f'  {k:20s}: {n}')
    print()

    # ── Pass 2: per-street outlier detection ─────────────────────────────────
    # Group OK parcels by their street name (addr2 minus the leading house number).
    # Only compare house numbers within the same street, so streets with 800s
    # numbering (Mullrany Dr, Kilbridge Ln) don't flag streets with 100s
    # (Lairds Dr, Kilmichael Dr) that happen to be geographically nearby.
    print(f'Per-street outlier detection '
          f'(threshold {OUTLIER_LOW}×–{OUTLIER_HIGH}×, min {OUTLIER_MIN_NEIGHBORS} addresses/street)...')
    from collections import defaultdict
    street_groups = defaultdict(list)  # normalised street name → [(num, row_idx)]
    for i, row in enumerate(rows):
        if row['category'] != 'OK':
            continue
        num = centroids[i][2]
        if num is None:
            continue
        m = re.match(r'^\d+\s+(.+)', row['current_address'])
        if not m:
            continue
        street_key = m.group(1).strip().upper()
        street_groups[street_key].append((num, i))

    outlier_count = 0
    for street_name, entries in street_groups.items():
        if len(entries) < OUTLIER_MIN_NEIGHBORS:
            continue
        nums = [e[0] for e in entries]
        med  = statistics.median(nums)
        if med == 0:
            continue
        for num, idx in entries:
            ratio = num / med
            if ratio < OUTLIER_LOW or ratio > OUTLIER_HIGH:
                rows[idx]['category'] = 'OUTLIER'
                rows[idx]['reason']   = (f'num={num} street_median={med:.0f} '
                                         f'ratio={ratio:.2f} street={street_name}')
                rows[idx]['status']   = 'PENDING'
                outlier_count += 1

    print(f'  OUTLIER: {outlier_count}')
    print()

    # ── Pass 3: NON_RESIDENTIAL spatial isolation check ───────────────────────
    # Build spatial index from all OK centroids for neighbour lookup
    ok_centroids_for_idx = [
        centroids[i] for i, r in enumerate(rows)
        if r['category'] == 'OK' and centroids[i][0] is not None and centroids[i][2] is not None
    ]
    spatial_idx, bucket_size = build_spatial_index(ok_centroids_for_idx)

    print(f'Checking spatial isolation for NON_RESIDENTIAL '
          f'(< {NON_RES_ISOLATION_MIN} residential neighbors within {NON_RES_ISOLATION_M}m)...')
    isolation_count = 0
    for i, row in enumerate(rows):
        if row['category'] != 'OK':
            continue
        lat, lon, _ = centroids[i]
        if lat is None:
            continue
        neighbors = get_neighbors(lat, lon, spatial_idx, bucket_size, NON_RES_ISOLATION_M)
        if len(neighbors) < NON_RES_ISOLATION_MIN:
            row['category'] = 'NON_RESIDENTIAL'
            row['reason']   = f'isolated: {len(neighbors)} residential neighbors within {NON_RES_ISOLATION_M}m'
            row['status']   = 'PENDING'
            isolation_count += 1

    print(f'  NON_RESIDENTIAL (isolated): {isolation_count}')
    print()

    # Final counts after all classification passes
    counts2 = {}
    for r in rows:
        counts2[r['category']] = counts2.get(r['category'], 0) + 1
    print('Classification (final):')
    for k, n in sorted(counts2.items(), key=lambda x: -x[1]):
        print(f'  {k:20s}: {n}')
    print()

    # ── Pass 4: DCAD lookups for BLANK, MAILING, OUTLIER ─────────────────────
    to_query = [r for r in rows if r['category'] in ('BLANK', 'MAILING', 'OUTLIER')]
    dcad_matched = dcad_confirmed = dcad_not_found = dcad_queries = 0

    if not args.skip_dcad and to_query:
        total = min(len(to_query), args.max_dcad)
        print(f'Querying DCAD for {total} parcels '
              f'(base={base_url}, layer={layer_id}, field={addr_field})...')
        print('(Ctrl+C to stop early — partial results saved)\n')
        try:
            for row in to_query:
                if dcad_queries >= args.max_dcad:
                    break
                dcad_queries += 1
                if dcad_queries % 50 == 0:
                    print(f'  [{dcad_queries}/{total}] matched={dcad_matched} '
                          f'confirmed={dcad_confirmed} not_found={dcad_not_found}')

                lat = row['centroid_lat']
                lon = row['centroid_lng']
                if not lat or not lon:
                    row['status'] = 'NO_CENTROID'
                    continue

                situs = dcad_lookup(float(lat), float(lon), row['current_address'],
                                    base_url, layer_id, addr_field)
                sleep_t = SLEEP_MIN + (SLEEP_MAX - SLEEP_MIN) * (dcad_queries % 3) / 2
                time.sleep(sleep_t)

                if not situs:
                    row['status'] = 'NOT_FOUND'
                    dcad_not_found += 1
                    continue

                row['dcad_situs_address'] = situs
                if situs.upper() == row['current_address'].upper():
                    # DCAD confirms current value — reclassify OK (for OUTLIER)
                    row['status'] = 'CONFIRMED_OK'
                    row['action'] = 'NONE'
                    dcad_confirmed += 1
                else:
                    row['status'] = 'MISMATCH'
                    row['action'] = 'CORRECT'
                    dcad_matched += 1

        except KeyboardInterrupt:
            print(f'\n  Stopped at {dcad_queries}. Saving partial results.')

    # NON_RESIDENTIAL action: blank addr2 (no DCAD query needed)
    for row in rows:
        if row['category'] == 'NON_RESIDENTIAL' and row['action'] == 'NONE':
            row['action'] = 'BLANK'
            row['status'] = 'NON_RES_BLANK'

    # ── Write CSV ──────────────────────────────────────────────────────────────
    fieldnames = ['feature_index', 'parcel_id', 'current_address', 'dcad_situs_address',
                  'centroid_lat', 'centroid_lng', 'category', 'reason', 'status', 'action']
    with open(RESULTS_CSV, 'w', newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)
    print(f'\nAudit CSV written: {RESULTS_CSV}')

    # ── Write patch JSON ───────────────────────────────────────────────────────
    patches = []
    for row in rows:
        if row['action'] == 'CORRECT' and row['dcad_situs_address']:
            patches.append({
                'feature_index':     row['feature_index'],
                'parcel_id':         row['parcel_id'],
                'old_address':       row['current_address'],
                'corrected_address': row['dcad_situs_address'],
            })
        elif row['action'] == 'BLANK':
            patches.append({
                'feature_index':     row['feature_index'],
                'parcel_id':         row['parcel_id'],
                'old_address':       row['current_address'],
                'corrected_address': '',
            })

    with open(PATCH_JSON, 'w', encoding='utf-8') as f:
        json.dump(patches, f, indent=2)
    print(f'Patch JSON written: {PATCH_JSON}  ({len(patches)} entries)')

    # ── Summary ────────────────────────────────────────────────────────────────
    print(f"""
Summary
-------
  Total features : {len(features)}
  OK (no change) : {counts2.get('OK', 0)}
  BLANK          : {counts2.get('BLANK', 0)}
  MAILING        : {counts2.get('MAILING', 0)}
  OUTLIER        : {counts2.get('OUTLIER', 0)}
  NON_RESIDENTIAL: {counts2.get('NON_RESIDENTIAL', 0)}

  DCAD queries   : {dcad_queries}
  Corrections    : {dcad_matched}
  DCAD confirmed : {dcad_confirmed}
  Not found      : {dcad_not_found}
  Patch entries  : {len(patches)}

Next step:
  Review {RESULTS_CSV}
  Then: python3 tools/apply_parcel_patch.py --dry-run
        python3 tools/apply_parcel_patch.py
""")


if __name__ == '__main__':
    main()
