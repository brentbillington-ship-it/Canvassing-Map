#!/usr/bin/env python3
"""
parcel_address_audit.py
-----------------------
Audits address quality in parcels.js and cross-references DCAD for corrected
situs addresses using two strategies:

  1. Text address search (for MISMATCH parcels with a bad address)
     -- Uses the DCAD ArcGIS REST API to search by address string
  2. Spatial coordinate query (for BLANK parcels with no address)
     -- Uses the DCAD ArcGIS REST API to identify parcel at centroid lat/lon

No browser / Playwright required. Pure REST API calls.

Usage:
    python parcel_address_audit.py [--skip-dcad] [--max-dcad N]

Requirements:
    pip install requests

Outputs:
    tools/parcel_audit_results.csv
    tools/parcel_address_patch.json
"""

import json
import re
import os
import csv
import time
import argparse
import sys
import random

try:
    import requests
    HAS_REQUESTS = True
except ImportError:
    HAS_REQUESTS = False

# ─── Config ──────────────────────────────────────────────────────────────────

PARCELS_JS  = os.path.join(os.path.dirname(__file__), '..', 'parcels.js')
RESULTS_CSV = os.path.join(os.path.dirname(__file__), 'parcel_audit_results.csv')
PATCH_JSON  = os.path.join(os.path.dirname(__file__), 'parcel_address_patch.json')

SLEEP_MIN = 0.5
SLEEP_MAX = 1.2

VALID_ZIP_PREFIXES = ('750', '751', '752', '760', '761')

# DCAD ArcGIS REST API endpoints
# Layer 0 is the main parcel/account layer
DCAD_REST_BASE    = 'https://maps.dcad.org/prdwa/rest/services/Property/PropMap/MapServer'
DCAD_QUERY_URL    = f'{DCAD_REST_BASE}/0/query'   # spatial + attribute queries
DCAD_FIND_URL     = f'{DCAD_REST_BASE}/find'       # text search across layers

HEADERS = {
    'User-Agent': 'Mozilla/5.0 (compatible; ParcelAudit/1.0)',
    'Referer': 'https://maps.dcad.org/prd/dpm/',
}

# ─── Load parcels.js ─────────────────────────────────────────────────────────

def load_parcels_geojson(path):
    with open(path, 'r', encoding='utf-8') as f:
        raw = f.read()
    raw = re.sub(r'//[^\n]*', '', raw)
    m = re.search(r'(?:const|var|let)\s+\w+\s*=\s*', raw)
    if m:
        raw = raw[m.end():]
    raw = raw.rstrip().rstrip(';').rstrip()
    return json.loads(raw)

# ─── Centroid ────────────────────────────────────────────────────────────────

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

# ─── Problem detection ───────────────────────────────────────────────────────

def classify_address(addr2, props):
    if not addr2 or not addr2.strip():
        return 'BLANK'
    a = addr2.strip()
    if a == '0' or re.match(r'^0+$', a):
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

# ─── DCAD REST API queries ───────────────────────────────────────────────────

_session = None

def get_session():
    global _session
    if _session is None:
        _session = requests.Session()
        _session.headers.update(HEADERS)
    return _session


def query_by_coords(lat, lon):
    """
    Spatial identify: find the parcel at (lat, lon) and return its Site Address.
    Uses ArcGIS REST identify-style spatial query with a point geometry.
    """
    # Convert WGS84 lat/lon to Web Mercator (EPSG:3857) for the API
    import math
    x = lon * 20037508.342 / 180.0
    y = math.log(math.tan((90 + lat) * math.pi / 360.0)) / (math.pi / 180.0)
    y = y * 20037508.342 / 180.0

    # Small buffer around point (5 meters in Web Mercator units)
    buf = 5
    params = {
        'geometry':     json.dumps({'x': x, 'y': y}),
        'geometryType': 'esriGeometryPoint',
        'spatialRel':   'esriSpatialRelIntersects',
        'inSR':         '102100',
        'outFields':    'SITEADDRESS,ACCOUNT_NUM,OWNER_NAME',
        'returnGeometry': 'false',
        'f':            'json',
        'where':        '1=1',
        'distance':     buf,
        'units':        'esriSRUnit_Meter',
    }
    try:
        r = get_session().get(DCAD_QUERY_URL, params=params, timeout=15)
        r.raise_for_status()
        data = r.json()
        features = data.get('features', [])
        if features:
            attrs = features[0].get('attributes', {})
            # Try common field name variations
            site = (attrs.get('SITEADDRESS') or
                    attrs.get('SiteAddress') or
                    attrs.get('SITE_ADDRESS') or
                    attrs.get('PROP_ADDR') or '')
            return site.strip() if site else None
        return None
    except Exception as e:
        print(f'    Coord query error ({lat},{lon}): {e}', file=sys.stderr)
        return None


def query_by_address(address):
    """
    Text search: find a parcel by address string, return its Site Address.
    Uses ArcGIS REST find endpoint to search across layers.
    """
    params = {
        'searchText':   address.strip(),
        'layers':       '0',
        'searchFields': 'SITEADDRESS,PROP_ADDR',
        'contains':     'true',
        'returnGeometry': 'false',
        'f':            'json',
    }
    try:
        r = get_session().get(DCAD_FIND_URL, params=params, timeout=15)
        r.raise_for_status()
        data = r.json()
        results = data.get('results', [])
        if results:
            attrs = results[0].get('attributes', {})
            site = (attrs.get('SITEADDRESS') or
                    attrs.get('SiteAddress') or
                    attrs.get('SITE_ADDRESS') or
                    attrs.get('PROP_ADDR') or '')
            return site.strip() if site else None
        return None
    except Exception as e:
        print(f'    Address query error ({address!r}): {e}', file=sys.stderr)
        return None


def dcad_lookup(item):
    """
    Pick the right strategy based on what data we have:
    - BLANK/ZERO: use coordinates
    - MISMATCH/PO_BOX/BAD_ZIP: try address text first, fall back to coordinates
    """
    reason = item['reason']
    lat    = item['centroid_lat']
    lon    = item['centroid_lng']
    addr   = item['current_address']

    if reason in ('BLANK', 'ZERO') or not addr:
        # No usable address — go straight to coordinate lookup
        if lat and lon:
            return query_by_coords(float(lat), float(lon))
        return None
    else:
        # Have a bad address — try text search first
        result = query_by_address(addr)
        if result:
            return result
        # Fall back to coordinates
        if lat and lon:
            return query_by_coords(float(lat), float(lon))
        return None


# ─── Main ────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description='Audit parcels.js address quality')
    parser.add_argument('--skip-dcad', action='store_true',
                        help='Skip DCAD cross-reference')
    parser.add_argument('--max-dcad', type=int, default=100,
                        help='Max DCAD queries (default 100)')
    args = parser.parse_args()

    if not HAS_REQUESTS and not args.skip_dcad:
        print('ERROR: requests not installed. Run: pip install requests')
        sys.exit(1)

    # First — discover what field names are actually in parcels.js
    print(f'Loading {PARCELS_JS}...')
    geojson  = load_parcels_geojson(PARCELS_JS)
    features = geojson.get('features', [])
    print(f'  {len(features)} features loaded.')

    # Sample first feature to show available property fields
    if features:
        sample_props = features[0].get('properties', {})
        print(f'  Property fields found: {list(sample_props.keys())}')

    # Pass 1: classify all features
    flagged  = []
    ok_count = 0
    for idx, feat in enumerate(features):
        props     = feat.get('properties', {})
        addr2     = (props.get('addr2') or '').strip()
        owner     = (props.get('owner') or '').strip()
        parcel_id = (props.get('id') or props.get('GID') or
                     props.get('OBJECTID') or str(idx))
        reason    = classify_address(addr2, props)
        centroid  = feature_centroid(feat)
        lat = round(centroid[0], 7) if centroid else ''
        lon = round(centroid[1], 7) if centroid else ''

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
                'status': 'MISSING' if not addr2 or addr2 in ('0', '') else 'MISMATCH',
            })

    print(f'  OK: {ok_count}  |  Flagged: {len(flagged)}')
    blank_count    = sum(1 for f in flagged if f['reason'] in ('BLANK', 'ZERO'))
    mismatch_count = len(flagged) - blank_count
    print(f'  Blank/Zero: {blank_count}  |  Mismatch/Bad: {mismatch_count}')

    # Pass 2: DCAD REST API lookup
    dcad_found     = 0
    dcad_not_found = 0
    dcad_queries   = 0

    if not args.skip_dcad and flagged:
        print(f'\nQuerying DCAD REST API for up to {args.max_dcad} flagged parcels...')
        print('  Strategy: coordinates for blanks, address text for mismatches')

        for item in flagged:
            if dcad_queries >= args.max_dcad:
                print(f'  Reached max ({args.max_dcad}). Stopping.')
                break

            strategy = ('coords' if item['reason'] in ('BLANK', 'ZERO')
                        else 'address→coords')
            print(f'  [{dcad_queries+1}/{min(args.max_dcad, len(flagged))}] '
                  f'[{strategy}] {item["current_address"] or "(blank)"!r} '
                  f'@ ({item["centroid_lat"]}, {item["centroid_lng"]})')

            situs = dcad_lookup(item)
            dcad_queries += 1
            time.sleep(random.uniform(SLEEP_MIN, SLEEP_MAX))

            if situs:
                item['dcad_situs_address'] = situs
                if situs.upper() != item['current_address'].upper():
                    item['status'] = 'MISMATCH'
                    dcad_found += 1
                else:
                    item['status'] = 'OK'
                    ok_count += 1
                print(f'    ✓ {situs}')
            else:
                item['status'] = 'NOT_FOUND'
                dcad_not_found += 1
                print(f'    ✗ Not found')

    # Write CSV — all parcels
    all_rows = []
    for feat_idx, feat in enumerate(features):
        props     = feat.get('properties', {})
        addr2     = (props.get('addr2') or '').strip()
        parcel_id = (props.get('id') or props.get('GID') or
                     props.get('OBJECTID') or str(feat_idx))
        centroid  = feature_centroid(feat)
        lat = round(centroid[0], 7) if centroid else ''
        lon = round(centroid[1], 7) if centroid else ''
        fi  = next((f for f in flagged if f['feature_index'] == feat_idx), None)
        if fi:
            all_rows.append({
                'feature_index':      feat_idx,
                'parcel_id':          fi['parcel_id'],
                'current_address':    addr2,
                'dcad_situs_address': fi['dcad_situs_address'],
                'centroid_lat':       lat,
                'centroid_lng':       lon,
                'status':             fi['status'],
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
            })

    with open(RESULTS_CSV, 'w', newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=[
            'feature_index', 'parcel_id', 'current_address',
            'dcad_situs_address', 'centroid_lat', 'centroid_lng', 'status'])
        writer.writeheader()
        writer.writerows(all_rows)
    print(f'\nAudit CSV written: {RESULTS_CSV}')

    patches = [
        {'feature_index':     r['feature_index'],
         'parcel_id':         r['parcel_id'],
         'corrected_address': r['dcad_situs_address']}
        for r in all_rows
        if r['status'] == 'MISMATCH' and r['dcad_situs_address']
    ]
    with open(PATCH_JSON, 'w', encoding='utf-8') as f:
        json.dump(patches, f, indent=2)
    print(f'Patch JSON written: {PATCH_JSON}  ({len(patches)} corrections)')

    print(f"""
Summary
-------
  Total parcels  : {len(features)}
  OK             : {ok_count}
  Flagged        : {len(flagged)}
    Blank/Zero   : {blank_count}
    Mismatch/Bad : {mismatch_count}
  DCAD found     : {dcad_found}
  Not found      : {dcad_not_found}
  DCAD queries   : {dcad_queries}
  Patches ready  : {len(patches)}
""")


if __name__ == '__main__':
    main()
