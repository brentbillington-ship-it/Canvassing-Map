#!/usr/bin/env python3
"""
parcel_address_audit.py
-----------------------
Audits address quality in parcels.js and cross-references DCAD ArcGIS REST API
for corrected situs addresses using two strategies:

  1. Spatial coordinate query (BLANK/ZERO parcels)
     -- Converts lat/lon to Web Mercator, queries /MapServer/{layer}/query
  2. Text address search (MISMATCH/PO_BOX/BAD_ZIP parcels)
     -- Uses the ArcGIS /find endpoint, falls back to LIKE query

No browser required. Pure REST API calls.

Usage:
    # Probe only -- discover correct layer ID and field names:
    python3 parcel_address_audit.py --probe

    # Full audit (offline-safe if DCAD unavailable):
    python3 parcel_address_audit.py [--skip-dcad] [--max-dcad N]

    # Override discovered layer/field (use after --probe):
    python3 parcel_address_audit.py --layer-id 4 --addr-field SITEADDRESS

Requirements:
    pip install requests

Outputs:
    tools/parcel_audit_results.csv    -- full audit with status per parcel
    tools/parcel_address_patch.json   -- corrections for mismatched parcels
"""

import json, re, os, csv, time, argparse, sys, math

try:
    import requests
    HAS_REQUESTS = True
except ImportError:
    HAS_REQUESTS = False

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

PARCELS_JS  = os.path.join(os.path.dirname(__file__), '..', 'parcels.js')
RESULTS_CSV = os.path.join(os.path.dirname(__file__), 'parcel_audit_results.csv')
PATCH_JSON  = os.path.join(os.path.dirname(__file__), 'parcel_address_patch.json')

DCAD_BASE    = 'https://maps.dcad.org/prdwa/rest/services/Property/ParcelQuery/MapServer'
DCAD_TIMEOUT = 15
DCAD_HEADERS = {
    'User-Agent': ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                   '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'),
    'Accept':  'application/json, text/plain, */*',
    'Referer': 'https://maps.dcad.org/prd/dpm/',
}
SLEEP_BETWEEN_QUERIES = 0.5

DEFAULT_LAYER      = 4
DEFAULT_ADDR_FIELD = 'SITEADDRESS'

CANDIDATE_LAYERS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
CANDIDATE_ADDR_FIELDS = [
    'SITEADDRESS', 'SITE_ADDRESS', 'SITUS_ADDRESS',
    'ADDRESS', 'ADDR', 'SITE_ADDR', 'PROP_ADDR',
    'PROPERTY_ADDRESS', 'SITUSADDRESS',
]

TEST_LAT  = 32.9888083
TEST_LON  = -96.996685
TEST_ADDR = '200 SLEEPY HOLLOW LN'

VALID_ZIP_PREFIXES = ('750', '751', '752', '760', '761')

# ---------------------------------------------------------------------------
# Load parcels.js
# ---------------------------------------------------------------------------

def load_parcels_geojson(path):
    with open(path, 'r', encoding='utf-8') as f:
        raw = f.read()
    raw = re.sub(r'//[^\n]*', '', raw)
    m = re.search(r'(?:const|var|let)\s+\w+\s*=\s*', raw)
    if m:
        raw = raw[m.end():]
    raw = raw.rstrip().rstrip(';').rstrip()
    return json.loads(raw)

# ---------------------------------------------------------------------------
# Geometry helpers
# ---------------------------------------------------------------------------

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


def wgs84_to_webmercator(lat, lon):
    x = lon * 20037508.342 / 180.0
    y = math.log(math.tan((90 + lat) * math.pi / 360.0)) / (math.pi / 180.0)
    y = y * 20037508.342 / 180.0
    return x, y

# ---------------------------------------------------------------------------
# Address classification
# ---------------------------------------------------------------------------

def classify_address(addr2):
    if not addr2 or not addr2.strip():
        return 'BLANK'
    a = addr2.strip()
    if re.match(r'^0+$', a):
        return 'ZERO'
    upper = a.upper()
    if 'PO BOX' in upper or 'P O BOX' in upper or 'P.O. BOX' in upper:
        return 'PO_BOX'
    z_match = re.search(r'\b(\d{5})\b', a)
    if z_match and not z_match.group(1).startswith(VALID_ZIP_PREFIXES):
        return f'BAD_ZIP:{z_match.group(1)}'
    return 'OK'

# ---------------------------------------------------------------------------
# DCAD ArcGIS REST API
# Confirmed working endpoint (from Playwright intercept):
#   https://maps.dcad.org/prdwa/rest/services/Property/ParcelQuery/MapServer/4/query
#   geometryType=esriGeometryEnvelope, inSR=102100, spatialRel=esriSpatialRelIntersects
#   where= (empty), outFields=SITEADDRESS,PARCELID,LOWPARCELID, returnGeometry=false
# ---------------------------------------------------------------------------

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
        if val:
            return str(val).strip()
    return None


def query_by_coords(lat, lon, layer_id=DEFAULT_LAYER, addr_field=DEFAULT_ADDR_FIELD):
    """
    Spatial query using a small envelope around the centroid — matches exactly
    what the DCAD map UI sends (confirmed by Playwright intercept).

    Key parameters:
      geometryType = esriGeometryEnvelope  (NOT point + distance buffer)
      inSR         = 102100 (Web Mercator)
      where        = ''     (spatial filter only, no attribute filter)
      outFields    = SITEADDRESS,PARCELID,LOWPARCELID
    """
    # ±0.001 degrees (~111m) converted to Web Mercator for the envelope.
    # Using 0.001 instead of 0.0001 ensures the envelope reliably intersects the
    # parcel polygon even for centroid estimates that land near a parcel edge.
    PAD_DEG = 0.001
    x_min, y_min = wgs84_to_webmercator(lat - PAD_DEG, lon - PAD_DEG)
    x_max, y_max = wgs84_to_webmercator(lat + PAD_DEG, lon + PAD_DEG)

    params = {
        'geometry':       json.dumps({
            'xmin': x_min, 'ymin': y_min,
            'xmax': x_max, 'ymax': y_max,
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
        r = _get_session().get(
            f'{DCAD_BASE}/{layer_id}/query', params=params, timeout=DCAD_TIMEOUT
        )
        r.raise_for_status()
        data = r.json()
        if 'error' in data:
            print(f'    API error: {data["error"]}', file=sys.stderr)
            return None
        features = data.get('features', [])
        return _extract_addr(features[0]['attributes'], addr_field) if features else None
    except Exception as e:
        print(f'    Coord query error ({lat:.5f},{lon:.5f}): {e}', file=sys.stderr)
        return None


def query_by_address(address, layer_id=DEFAULT_LAYER, addr_field=DEFAULT_ADDR_FIELD):
    """Text search: address string -> situs address. /find first, then LIKE fallback."""
    # /find endpoint
    try:
        r = _get_session().get(f'{DCAD_BASE}/find', params={
            'searchText': address.strip(), 'layers': str(layer_id),
            'searchFields': f'{addr_field},PROP_ADDR',
            'contains': 'true', 'returnGeometry': 'false', 'f': 'json',
        }, timeout=DCAD_TIMEOUT)
        r.raise_for_status()
        data = r.json()
        results = data.get('results', [])
        if results:
            return _extract_addr(results[0]['attributes'], addr_field)
    except Exception:
        pass

    # LIKE fallback
    safe = ' '.join(address.strip().upper().split()[:3]).replace("'", "''")
    try:
        r = _get_session().get(f'{DCAD_BASE}/{layer_id}/query', params={
            'where': f"UPPER({addr_field}) LIKE '%{safe}%'",
            'outFields': addr_field, 'returnGeometry': 'false',
            'resultRecordCount': '3', 'f': 'json',
        }, timeout=DCAD_TIMEOUT)
        r.raise_for_status()
        data = r.json()
        features = data.get('features', [])
        return _extract_addr(features[0]['attributes'], addr_field) if features else None
    except Exception as e:
        print(f'    Address query error ({address!r}): {e}', file=sys.stderr)
        return None


def dcad_lookup(item, layer_id, addr_field):
    """Choose spatial vs text strategy based on error type."""
    reason = item['reason']
    lat, lon = item['centroid_lat'], item['centroid_lng']
    addr = item['current_address']

    if reason in ('BLANK', 'ZERO') or not addr:
        return query_by_coords(float(lat), float(lon), layer_id, addr_field) if lat and lon else None
    result = query_by_address(addr, layer_id, addr_field)
    if result:
        return result
    return query_by_coords(float(lat), float(lon), layer_id, addr_field) if lat and lon else None

# ---------------------------------------------------------------------------
# Probe
# ---------------------------------------------------------------------------

def probe_dcad():
    """
    Probe the DCAD API without relying on layer metadata field lists.

    The ArcGIS service metadata (?f=json) only returns ~10 fields, but the layer
    actually has 20+ fields and SITEADDRESS is field #15.  Checking metadata
    causes the probe to conclude the field doesn't exist and skip the layer.

    Fix: skip metadata field checking entirely — query directly with outFields=*
    and inspect the actual response to discover available fields.
    """
    print(f'\n=== Probing DCAD ArcGIS REST API ===')
    print(f'  Endpoint: {DCAD_BASE}')
    print(f'  Test point : lat={TEST_LAT}, lon={TEST_LON}')
    print(f'  Test address: {TEST_ADDR}\n')

    if not HAS_REQUESTS:
        print('  ERROR: pip install requests')
        return None, None

    # Step 1: list layers from service info (informational only — don't gate on fields)
    try:
        r = _get_session().get(f'{DCAD_BASE}?f=json', timeout=DCAD_TIMEOUT)
        r.raise_for_status()
        svc_layers = r.json().get('layers', [])
        if svc_layers:
            print(f'  Service layers: {[(l["id"], l.get("name","?")) for l in svc_layers]}')
            candidate_ids = [l['id'] for l in svc_layers]
        else:
            candidate_ids = CANDIDATE_LAYERS
    except Exception as e:
        print(f'  Service info unavailable ({e}) — trying candidate IDs {CANDIDATE_LAYERS}')
        candidate_ids = CANDIDATE_LAYERS

    print()

    # Step 2: for each layer, fire a direct envelope query with outFields=*
    # This bypasses the truncated metadata field list entirely.
    PAD_DEG = 0.001
    x_min, y_min = wgs84_to_webmercator(TEST_LAT - PAD_DEG, TEST_LON - PAD_DEG)
    x_max, y_max = wgs84_to_webmercator(TEST_LAT + PAD_DEG, TEST_LON + PAD_DEG)
    envelope = json.dumps({
        'xmin': x_min, 'ymin': y_min, 'xmax': x_max, 'ymax': y_max,
        'spatialReference': {'wkid': 102100},
    })

    for lid in candidate_ids:
        print(f'  Testing layer {lid}...')
        try:
            r = _get_session().get(f'{DCAD_BASE}/{lid}/query', params={
                'geometry':       envelope,
                'geometryType':   'esriGeometryEnvelope',
                'inSR':           '102100',
                'spatialRel':     'esriSpatialRelIntersects',
                'where':          '',
                'outFields':      '*',
                'returnGeometry': 'false',
                'resultRecordCount': '1',
                'f':              'json',
            }, timeout=DCAD_TIMEOUT)
            r.raise_for_status()
            data = r.json()
        except Exception as e:
            print(f'    Request failed: {e}')
            continue

        if 'error' in data:
            print(f'    API error: {data["error"]}')
            continue

        features = data.get('features', [])
        if not features:
            print(f'    No features returned (wrong layer or envelope too small?)')
            continue

        # Found features — discover which address field is present
        attrs = features[0].get('attributes', {})
        all_fields = list(attrs.keys())
        print(f'    Got {len(features)} feature(s). Fields: {all_fields}')

        # Pick best address field from the actual response
        found_field = None
        for candidate in CANDIDATE_ADDR_FIELDS:
            if candidate in attrs or candidate.upper() in attrs:
                found_field = candidate if candidate in attrs else candidate.upper()
                break

        if not found_field:
            # Fall back: take first field whose value looks like a street address
            for k, v in attrs.items():
                if v and isinstance(v, str) and re.match(r'^\d+\s+\w', v.strip()):
                    found_field = k
                    print(f'    Auto-detected address field: {k!r} = {v!r}')
                    break

        if not found_field:
            print(f'    No address field recognisable in attributes — skipping')
            continue

        addr_value = attrs.get(found_field, '')
        print(f'    ✓ Layer {lid}  field={found_field!r}  value={addr_value!r}')

        # Also test text query
        tx = query_by_address(TEST_ADDR, lid, found_field)
        print(f'    Text query ("{TEST_ADDR}"): {tx!r}')

        print(f'\n  CONFIRMED: --layer-id {lid} --addr-field {found_field}\n')
        return lid, found_field

    print('  No working layer found.')
    print('  Check tools/dcad_intercept_results.json for the confirmed endpoint.')
    return None, None

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description='Audit parcels.js addresses against DCAD')
    parser.add_argument('--probe',      action='store_true', help='Discover layer/field then exit')
    parser.add_argument('--skip-dcad',  action='store_true', help='Skip DCAD queries')
    parser.add_argument('--max-dcad',   type=int,   default=1245,                 help='Max DCAD queries (default: all)')
    parser.add_argument('--layer-id',   type=int,   default=None,                 help=f'Layer ID (default: auto-discover; fallback {DEFAULT_LAYER})')
    parser.add_argument('--addr-field', type=str,   default=None,                 help=f'Address field name (fallback {DEFAULT_ADDR_FIELD})')
    args = parser.parse_args()

    if args.probe:
        probe_dcad()
        return

    if not HAS_REQUESTS and not args.skip_dcad:
        print('WARNING: pip install requests  (DCAD queries will be skipped)')
        args.skip_dcad = True

    layer_id   = args.layer_id
    addr_field = args.addr_field

    if not args.skip_dcad and (layer_id is None or addr_field is None):
        fl, ff = probe_dcad()
        layer_id   = fl if fl is not None else DEFAULT_LAYER
        addr_field = ff if ff is not None else DEFAULT_ADDR_FIELD
        if fl is None:
            print(f'Probe failed -- using defaults: layer={layer_id}, field={addr_field}')
        print()

    print(f'Loading {PARCELS_JS}...')
    geojson  = load_parcels_geojson(PARCELS_JS)
    features = geojson.get('features', [])
    print(f'  {len(features)} features loaded.')
    if features:
        print(f'  Fields: {list(features[0].get("properties", {}).keys())}')
    print()

    # Pass 1: classify
    flagged, ok_count = [], 0
    for idx, feat in enumerate(features):
        props     = feat.get('properties', {})
        addr2     = (props.get('addr2') or '').strip()
        reason    = classify_address(addr2)
        centroid  = feature_centroid(feat)
        lat = round(centroid[0], 6) if centroid else ''
        lon = round(centroid[1], 6) if centroid else ''
        parcel_id = str(props.get('id') or props.get('GID') or props.get('OBJECTID') or idx)

        if reason == 'OK':
            ok_count += 1
        else:
            flagged.append({
                'feature_index': idx, 'parcel_id': parcel_id,
                'current_address': addr2, 'owner': (props.get('owner') or '').strip(),
                'reason': reason, 'centroid_lat': lat, 'centroid_lng': lon,
                'dcad_situs_address': '',
                'status': 'MISSING' if not addr2 or addr2 == '0' else 'FLAGGED',
            })

    print(f'Classification: OK={ok_count}  Flagged={len(flagged)}')
    reasons = {}
    for f in flagged:
        k = f['reason'].split(':')[0]
        reasons[k] = reasons.get(k, 0) + 1
    for k, n in sorted(reasons.items(), key=lambda x: -x[1]):
        print(f'  {k}: {n}')
    print()

    # Pass 2: DCAD lookup
    dcad_matched = dcad_not_found = dcad_queries = 0

    if not args.skip_dcad and flagged:
        total_to_query = min(len(flagged), args.max_dcad)
        print(f'Querying DCAD for {total_to_query} parcels (layer={layer_id}, field={addr_field})...')
        print('(Ctrl+C stops early -- partial results saved)\n')
        try:
            for item in flagged:
                if dcad_queries >= args.max_dcad:
                    break
                dcad_queries += 1
                if dcad_queries % 50 == 0:
                    print(f'  [{dcad_queries}/{total_to_query}] matched={dcad_matched} not_found={dcad_not_found}')

                situs = dcad_lookup(item, layer_id, addr_field)
                if situs:
                    item['dcad_situs_address'] = situs
                    item['status'] = 'MISMATCH' if situs.upper() != item['current_address'].upper() else 'OK'
                    if item['status'] == 'MISMATCH':
                        dcad_matched += 1
                else:
                    item['status'] = 'NOT_FOUND'
                    dcad_not_found += 1
                time.sleep(SLEEP_BETWEEN_QUERIES)
        except KeyboardInterrupt:
            print(f'\n  Stopped at query {dcad_queries}. Saving partial results.')

    # Write CSV
    flagged_by_idx = {f['feature_index']: f for f in flagged}
    all_rows = []
    for feat_idx, feat in enumerate(features):
        props    = feat.get('properties', {})
        addr2    = (props.get('addr2') or '').strip()
        parcel_id = str(props.get('id') or props.get('GID') or props.get('OBJECTID') or feat_idx)
        centroid = feature_centroid(feat)
        lat = round(centroid[0], 6) if centroid else ''
        lon = round(centroid[1], 6) if centroid else ''
        fi = flagged_by_idx.get(feat_idx)
        if fi:
            all_rows.append({'feature_index': feat_idx, 'parcel_id': fi['parcel_id'],
                             'current_address': addr2, 'dcad_situs_address': fi['dcad_situs_address'],
                             'centroid_lat': lat, 'centroid_lng': lon, 'status': fi['status'], 'reason': fi['reason']})
        else:
            all_rows.append({'feature_index': feat_idx, 'parcel_id': parcel_id,
                             'current_address': addr2, 'dcad_situs_address': '',
                             'centroid_lat': lat, 'centroid_lng': lon, 'status': 'OK', 'reason': 'OK'})

    with open(RESULTS_CSV, 'w', newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=['feature_index','parcel_id','current_address',
                                               'dcad_situs_address','centroid_lat','centroid_lng','status','reason'])
        writer.writeheader(); writer.writerows(all_rows)
    print(f'Audit CSV written:  {RESULTS_CSV}')

    patches = [{'feature_index': r['feature_index'], 'parcel_id': r['parcel_id'],
                'old_address': r['current_address'], 'corrected_address': r['dcad_situs_address']}
               for r in all_rows if r['status'] == 'MISMATCH' and r['dcad_situs_address']]
    with open(PATCH_JSON, 'w', encoding='utf-8') as f:
        json.dump(patches, f, indent=2)
    print(f'Patch JSON written: {PATCH_JSON}  ({len(patches)} corrections)')

    print(f"""
Summary
-------
  Total:   {len(features)}  OK: {ok_count}  Flagged: {len(flagged)}
  Queries: {dcad_queries}  Matched: {dcad_matched}  Not found: {dcad_not_found}
  Patch:   {len(patches)} corrections

Next step:
  Review {RESULTS_CSV}
  Then:  python3 tools/apply_parcel_patch.py --dry-run
         python3 tools/apply_parcel_patch.py
""")


if __name__ == '__main__':
    main()
