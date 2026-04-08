#!/usr/bin/env python3
"""
parcel_address_audit.py
-----------------------
Audits address quality in parcels.js and cross-references DCAD ArcGIS REST API
for corrected situs addresses.

Usage:
    # Probe only — discover correct layer ID and field names:
    python3 parcel_address_audit.py --probe

    # Full audit (skips DCAD if API unavailable):
    python3 parcel_address_audit.py [--skip-dcad] [--max-dcad N]

    # Override discovered layer/field (use after --probe):
    python3 parcel_address_audit.py --layer-id 0 --addr-field SITEADDRESS

Outputs:
    tools/parcel_audit_results.csv    — full audit with status per parcel
    tools/parcel_address_patch.json   — corrections for mismatched parcels
"""

import json
import re
import os
import csv
import time
import argparse
import sys

try:
    import requests
    HAS_REQUESTS = True
except ImportError:
    HAS_REQUESTS = False


# ─── Config ──────────────────────────────────────────────────────────────────

PARCELS_JS  = os.path.join(os.path.dirname(__file__), '..', 'parcels.js')
RESULTS_CSV = os.path.join(os.path.dirname(__file__), 'parcel_audit_results.csv')
PATCH_JSON  = os.path.join(os.path.dirname(__file__), 'parcel_address_patch.json')

DCAD_BASE    = 'https://maps.dcad.org/prdwa/rest/services/Property/ParcelQuery/MapServer'
DCAD_TIMEOUT = 15
DCAD_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Referer': 'https://maps.dcad.org/prd/dpm/',
}
SLEEP_BETWEEN_QUERIES = 0.5   # seconds between API calls

# Layer IDs to try during probe (in priority order)
CANDIDATE_LAYERS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]

# Field names to look for (in priority order)
CANDIDATE_ADDR_FIELDS = [
    'SITEADDRESS', 'SITE_ADDRESS', 'SITUS_ADDRESS',
    'ADDRESS', 'ADDR', 'SITE_ADDR', 'PROP_ADDR',
    'PROPERTY_ADDRESS', 'SITUSADDRESS',
]

# Known test cases (Coppell, TX) for probe validation
TEST_LAT  = 32.9888083
TEST_LON  = -96.996685
TEST_ADDR = '200 SLEEPY HOLLOW LN'

VALID_ZIP_PREFIXES = ('750', '751', '752', '760', '761')


# ─── Load parcels.js ─────────────────────────────────────────────────────────

def load_parcels_geojson(path):
    """Strip JS variable wrapper and return parsed GeoJSON dict."""
    with open(path, 'r', encoding='utf-8') as f:
        raw = f.read()
    m = re.match(r'^\s*(?:const|var|let)\s+\w+\s*=\s*', raw)
    if m:
        raw = raw[m.end():]
    raw = raw.rstrip().rstrip(';').rstrip()
    return json.loads(raw)


# ─── Geometry helpers ─────────────────────────────────────────────────────────

def feature_centroid(feature):
    """Return (lat, lon) centroid of a Polygon or MultiPolygon feature."""
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


# ─── Problem detection ────────────────────────────────────────────────────────

def classify_address(addr2):
    """Return 'OK' or a reason string for a problem address."""
    if not addr2 or not addr2.strip():
        return 'BLANK'
    a = addr2.strip()
    if re.match(r'^0+$', a):
        return 'ZERO'
    upper = a.upper()
    if 'PO BOX' in upper or 'P O BOX' in upper or 'P.O. BOX' in upper:
        return 'PO_BOX'
    zip_match = re.search(r'\b(\d{5})\b', a)
    if zip_match:
        z = zip_match.group(1)
        if not z.startswith(VALID_ZIP_PREFIXES):
            return f'BAD_ZIP:{z}'
    return 'OK'


# ─── DCAD ArcGIS REST API ─────────────────────────────────────────────────────

_session = None

def _get_session():
    global _session
    if _session is None:
        _session = requests.Session()
        _session.headers.update(DCAD_HEADERS)
    return _session


def _get_service_layers():
    """
    Fetch the MapServer service info and return list of layer dicts
    with keys: id, name.
    Returns [] on failure.
    """
    sess = _get_session()
    url = f'{DCAD_BASE}?f=json'
    try:
        r = sess.get(url, timeout=DCAD_TIMEOUT)
        r.raise_for_status()
        data = r.json()
        # Check for ArcGIS error
        if 'error' in data:
            print(f'  Service error: {data["error"]}')
            return []
        layers = data.get('layers', [])
        return layers
    except Exception as e:
        print(f'  Could not fetch service info from {url}: {e}')
        return []


def _get_layer_fields(layer_id):
    """
    Fetch layer info and return (layer_name, [uppercase field names]).
    Returns (None, []) on failure.
    """
    sess = _get_session()
    url = f'{DCAD_BASE}/{layer_id}?f=json'
    try:
        r = sess.get(url, timeout=DCAD_TIMEOUT)
        r.raise_for_status()
        data = r.json()
        if 'error' in data:
            return None, []
        name   = data.get('name', f'Layer {layer_id}')
        fields = [f['name'].upper() for f in data.get('fields', [])]
        return name, fields
    except Exception as e:
        print(f'  Layer {layer_id} info error: {e}')
        return None, []


def _spatial_query(layer_id, lat, lon, addr_field):
    """
    Query DCAD by point geometry. Returns situs address string or None.
    Uses WGS84 (SRID 4326) input with ArcGIS projection.
    """
    sess = _get_session()
    params = {
        'geometry':         f'{lon},{lat}',
        'geometryType':     'esriGeometryPoint',
        'inSR':             '4326',
        'spatialRel':       'esriSpatialRelIntersects',
        'outFields':        addr_field,
        'returnGeometry':   'false',
        'resultRecordCount': '1',
        'f':                'json',
    }
    url = f'{DCAD_BASE}/{layer_id}/query'
    try:
        r = sess.get(url, params=params, timeout=DCAD_TIMEOUT)
        r.raise_for_status()
        data = r.json()
        if 'error' in data:
            print(f'    API error: {data["error"]}', file=sys.stderr)
            return None
        features = data.get('features', [])
        if features:
            attrs = features[0].get('attributes', {})
            # Try exact case then upper
            return (attrs.get(addr_field)
                    or attrs.get(addr_field.upper())
                    or next(iter(attrs.values()), None))
        return None
    except Exception as e:
        print(f'    Spatial query error: {e}', file=sys.stderr)
        return None


def _text_query(layer_id, addr_text, addr_field):
    """
    Query DCAD by address text (LIKE search). Returns situs address or None.
    Extracts street number + name to avoid zip/city noise.
    """
    sess = _get_session()
    # Use first two tokens (number + street name) for a focused LIKE query
    tokens = addr_text.strip().upper().split()
    search_term = ' '.join(tokens[:3]) if len(tokens) >= 2 else addr_text.strip()
    safe = search_term.replace("'", "''")

    params = {
        'where':             f"UPPER({addr_field}) LIKE '%{safe}%'",
        'outFields':         addr_field,
        'returnGeometry':    'false',
        'resultRecordCount': '3',
        'f':                 'json',
    }
    url = f'{DCAD_BASE}/{layer_id}/query'
    try:
        r = sess.get(url, params=params, timeout=DCAD_TIMEOUT)
        r.raise_for_status()
        data = r.json()
        if 'error' in data:
            return None
        features = data.get('features', [])
        if features:
            attrs = features[0].get('attributes', {})
            return (attrs.get(addr_field)
                    or attrs.get(addr_field.upper())
                    or next(iter(attrs.values()), None))
        return None
    except Exception as e:
        print(f'    Text query error: {e}', file=sys.stderr)
        return None


def probe_dcad():
    """
    Discover the correct DCAD layer ID and address field name.
    Tests all candidate layers with a known Coppell coordinate and address.
    Returns (layer_id, addr_field) or (None, None).
    """
    print(f'\n=== Probing DCAD ArcGIS REST API ===')
    print(f'  Service: {DCAD_BASE}')
    print(f'  Test point: lat={TEST_LAT}, lon={TEST_LON}')
    print(f'  Test address: {TEST_ADDR}\n')

    if not HAS_REQUESTS:
        print('  ERROR: requests library not installed. Run: pip3 install requests')
        return None, None

    # Step 1: get service layer list
    layers = _get_service_layers()
    if layers:
        print(f'  Service has {len(layers)} layers:')
        for l in layers:
            print(f'    [{l["id"]}] {l.get("name", "?")}')
        candidate_ids = [l['id'] for l in layers]
    else:
        print(f'  Could not get layer list — trying IDs {CANDIDATE_LAYERS}')
        candidate_ids = CANDIDATE_LAYERS

    print()

    # Step 2: for each layer, find address field and test
    for lid in candidate_ids:
        layer_name, fields = _get_layer_fields(lid)
        if not fields:
            print(f'  Layer {lid}: no fields returned, skipping')
            continue

        print(f'  Layer {lid} ({layer_name}):')
        print(f'    Fields: {fields}')

        # Find first matching address field
        found_field = None
        for candidate in CANDIDATE_ADDR_FIELDS:
            if candidate in fields:
                found_field = candidate
                break

        if not found_field:
            print(f'    No address field found, skipping')
            continue

        print(f'    Address field: {found_field}')

        # Step 3: test spatial query with known point
        print(f'    Testing spatial query (lat={TEST_LAT}, lon={TEST_LON})…')
        spatial_result = _spatial_query(lid, TEST_LAT, TEST_LON, found_field)
        if spatial_result:
            print(f'    ✓ Spatial result: "{spatial_result}"')
        else:
            print(f'    ✗ Spatial query returned no results')

        # Step 4: test text query with known address
        print(f'    Testing text query ("{TEST_ADDR}")…')
        text_result = _text_query(lid, TEST_ADDR, found_field)
        if text_result:
            print(f'    ✓ Text result: "{text_result}"')
        else:
            print(f'    ✗ Text query returned no results')

        if spatial_result or text_result:
            print(f'\n  ✓ Use: --layer-id {lid} --addr-field {found_field}')
            return lid, found_field

        print()

    print('\n  ✗ No working layer/field combination found.')
    print('  Try opening the Network tab in DevTools on maps.dcad.org/prd/dpm/')
    print('  and clicking a Coppell parcel to see the actual API call.\n')
    return None, None


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description='Audit parcels.js address quality')
    parser.add_argument('--probe', action='store_true',
                        help='Probe DCAD API to discover layer ID and field name, then exit')
    parser.add_argument('--skip-dcad', action='store_true',
                        help='Skip DCAD cross-reference (offline-safe, outputs CSV with MISSING/BLANK flags only)')
    parser.add_argument('--max-dcad', type=int, default=1245,
                        help='Max DCAD queries to make (default: all flagged parcels)')
    parser.add_argument('--layer-id', type=int, default=None,
                        help='DCAD MapServer layer ID (skip auto-discovery)')
    parser.add_argument('--addr-field', type=str, default=None,
                        help='DCAD situs address field name (skip auto-discovery)')
    args = parser.parse_args()

    # ── Probe-only mode
    if args.probe:
        probe_dcad()
        return

    if not HAS_REQUESTS and not args.skip_dcad:
        print('WARNING: requests not installed — DCAD queries will be skipped.')
        print('  Install: pip3 install requests')
        args.skip_dcad = True

    # ── Discover layer/field if not overridden
    layer_id   = args.layer_id
    addr_field = args.addr_field

    if not args.skip_dcad and (layer_id is None or addr_field is None):
        print('Auto-discovering DCAD layer/field (use --layer-id / --addr-field to skip)…')
        layer_id, addr_field = probe_dcad()
        if layer_id is None:
            print('Could not find working DCAD layer. Continuing without DCAD (audit-only mode).')
            args.skip_dcad = True
        else:
            print(f'Using layer {layer_id}, field {addr_field}.\n')

    # ── Load parcels
    print(f'Loading {PARCELS_JS}…')
    geojson  = load_parcels_geojson(PARCELS_JS)
    features = geojson.get('features', [])
    print(f'  {len(features)} features loaded.\n')

    # ── Pass 1: classify all features
    flagged   = []
    ok_count  = 0

    for idx, feat in enumerate(features):
        props     = feat.get('properties', {})
        addr2     = (props.get('addr2') or '').strip()
        owner     = (props.get('owner') or '').strip()
        parcel_id = (props.get('id') or props.get('GID') or
                     props.get('OBJECTID') or str(idx))

        reason   = classify_address(addr2)
        centroid = feature_centroid(feat)
        lat = round(centroid[0], 6) if centroid else ''
        lon = round(centroid[1], 6) if centroid else ''

        if reason == 'OK':
            ok_count += 1
        else:
            flagged.append({
                'feature_index':      idx,
                'parcel_id':          str(parcel_id),
                'current_address':    addr2,
                'owner':              owner,
                'reason':             reason,
                'centroid_lat':       lat,
                'centroid_lng':       lon,
                'dcad_situs_address': '',
                'status':             'MISSING' if not addr2 or addr2 == '0' else 'FLAGGED',
            })

    print(f'Classification: OK={ok_count}  Flagged={len(flagged)}')
    if flagged:
        reasons = {}
        for f in flagged:
            r = f['reason'].split(':')[0]
            reasons[r] = reasons.get(r, 0) + 1
        for r, n in sorted(reasons.items(), key=lambda x: -x[1]):
            print(f'  {r}: {n}')
    print()

    # ── Pass 2: DCAD spatial lookup for flagged parcels
    dcad_matched   = 0
    dcad_not_found = 0
    dcad_queries   = 0

    if not args.skip_dcad and flagged:
        total_to_query = min(len(flagged), args.max_dcad)
        print(f'Querying DCAD for {total_to_query} flagged parcels (layer={layer_id}, field={addr_field})…')
        print('(Use Ctrl+C to stop early — partial results will be saved)\n')

        try:
            for item in flagged:
                if dcad_queries >= args.max_dcad:
                    print(f'  Reached max DCAD queries ({args.max_dcad}). Stopping.')
                    break

                lat = item['centroid_lat']
                lon = item['centroid_lng']
                dcad_queries += 1

                if dcad_queries % 50 == 0:
                    print(f'  Progress: {dcad_queries}/{total_to_query} '
                          f'(matched={dcad_matched}, not_found={dcad_not_found})')

                situs = None

                # Primary: spatial query by centroid (most reliable)
                if lat and lon:
                    situs = _spatial_query(layer_id, lat, lon, addr_field)

                # Fallback: text query by owner name or partial address
                if not situs:
                    fallback = item['current_address'] or item['owner']
                    if fallback and len(fallback) > 3:
                        situs = _text_query(layer_id, fallback, addr_field)

                if situs:
                    situs = situs.strip()
                    item['dcad_situs_address'] = situs
                    item['status'] = 'MISMATCH' if situs.upper() != item['current_address'].upper() else 'OK'
                    if item['status'] == 'MISMATCH':
                        dcad_matched += 1
                else:
                    item['status'] = 'NOT_FOUND'
                    dcad_not_found += 1

                time.sleep(SLEEP_BETWEEN_QUERIES)

        except KeyboardInterrupt:
            print(f'\n  Interrupted at query {dcad_queries}. Saving partial results.')

    # ── Write CSV (all features)
    all_rows = []
    flagged_by_idx = {f['feature_index']: f for f in flagged}

    for feat_idx, feat in enumerate(features):
        props     = feat.get('properties', {})
        addr2     = (props.get('addr2') or '').strip()
        parcel_id = (props.get('id') or props.get('GID') or
                     props.get('OBJECTID') or str(feat_idx))
        centroid  = feature_centroid(feat)
        lat = round(centroid[0], 6) if centroid else ''
        lon = round(centroid[1], 6) if centroid else ''

        fi = flagged_by_idx.get(feat_idx)
        if fi:
            all_rows.append({
                'feature_index':      feat_idx,
                'parcel_id':          fi['parcel_id'],
                'current_address':    addr2,
                'dcad_situs_address': fi['dcad_situs_address'],
                'centroid_lat':       lat,
                'centroid_lng':       lon,
                'status':             fi['status'],
                'reason':             fi['reason'],
            })
        else:
            all_rows.append({
                'feature_index':      feat_idx,
                'parcel_id':          str(parcel_id),
                'current_address':    addr2,
                'dcad_situs_address': '',
                'centroid_lat':       lat,
                'centroid_lng':       lon,
                'status':             'OK',
                'reason':             'OK',
            })

    with open(RESULTS_CSV, 'w', newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=[
            'feature_index', 'parcel_id', 'current_address',
            'dcad_situs_address', 'centroid_lat', 'centroid_lng', 'status', 'reason',
        ])
        writer.writeheader()
        writer.writerows(all_rows)
    print(f'Audit CSV written:  {RESULTS_CSV}')

    # ── Write patch JSON (only mismatches with a confirmed DCAD address)
    patches = [
        {
            'feature_index':     r['feature_index'],
            'parcel_id':         r['parcel_id'],
            'old_address':       r['current_address'],
            'corrected_address': r['dcad_situs_address'],
        }
        for r in all_rows
        if r['status'] == 'MISMATCH' and r['dcad_situs_address']
    ]
    with open(PATCH_JSON, 'w', encoding='utf-8') as f:
        json.dump(patches, f, indent=2)
    print(f'Patch JSON written: {PATCH_JSON}  ({len(patches)} corrections)')

    # ── Summary
    total     = len(features)
    n_flagged = len(flagged)
    print(f"""
Summary
───────
  Total parcels:      {total}
  OK:                 {ok_count}
  Flagged:            {n_flagged}
  DCAD queries made:  {dcad_queries}
  DCAD matched:       {dcad_matched}
  DCAD not found:     {dcad_not_found}
  Patch corrections:  {len(patches)}

Next step:
  Review {RESULTS_CSV}
  Then apply: python3 tools/apply_parcel_patch.py --dry-run
              python3 tools/apply_parcel_patch.py
""")


if __name__ == '__main__':
    main()
