#!/usr/bin/env python3
"""
parcel_address_audit.py
-----------------------
Audits address quality in parcels.js and optionally cross-references DCAD
for corrected situs addresses.

Usage:
    python3 parcel_address_audit.py [--skip-dcad] [--max-dcad N]

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
    from bs4 import BeautifulSoup
    HAS_REQUESTS = True
except ImportError:
    HAS_REQUESTS = False


# ─── Config ──────────────────────────────────────────────────────────────────

PARCELS_JS   = os.path.join(os.path.dirname(__file__), '..', 'parcels.js')
RESULTS_CSV  = os.path.join(os.path.dirname(__file__), 'parcel_audit_results.csv')
PATCH_JSON   = os.path.join(os.path.dirname(__file__), 'parcel_address_patch.json')

DCAD_SEARCH_URL = 'https://www.dcad.org/property-search/'
SLEEP_MIN = 0.5
SLEEP_MAX = 1.0

VALID_ZIP_PREFIXES = ('750', '751', '752', '760', '761')   # Dallas-area zips
COPPELL_ZIPS = ('75019', '75099')

# ─── Load parcels.js ─────────────────────────────────────────────────────────

def load_parcels_geojson(path):
    """Strip JS variable wrapper and return parsed GeoJSON dict."""
    with open(path, 'r', encoding='utf-8') as f:
        raw = f.read()
    # Match: const PARCELS_GEOJSON = {...};
    m = re.match(r'^\s*(?:const|var|let)\s+\w+\s*=\s*', raw)
    if m:
        raw = raw[m.end():]
    raw = raw.rstrip().rstrip(';').rstrip()
    return json.loads(raw)


# ─── Centroid ─────────────────────────────────────────────────────────────────

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

def classify_address(addr2, props):
    """Return 'OK' or a reason string for a problem address."""
    if not addr2 or not addr2.strip():
        return 'BLANK'
    a = addr2.strip()
    if a == '0' or a == '0 ' or re.match(r'^0+$', a):
        return 'ZERO'
    upper = a.upper()
    if 'PO BOX' in upper or 'P O BOX' in upper or 'P.O. BOX' in upper:
        return 'PO_BOX'
    # Check zip — extract trailing 5-digit zip if present
    zip_match = re.search(r'\b(\d{5})\b', a)
    if zip_match:
        z = zip_match.group(1)
        if not z.startswith(VALID_ZIP_PREFIXES):
            return f'BAD_ZIP:{z}'
    return 'OK'


# ─── DCAD query ──────────────────────────────────────────────────────────────

_dcad_session = None

def _get_session():
    global _dcad_session
    if _dcad_session is None:
        _dcad_session = requests.Session()
        _dcad_session.headers.update({
            'User-Agent': 'Mozilla/5.0 (compatible; ParcelAudit/1.0)'
        })
    return _dcad_session

def query_dcad_by_address(addr2):
    """
    Attempt to find corrected situs address on DCAD.
    Returns (situs_address, account_num) or (None, None) if not found.

    DCAD property search can be reached at:
      https://www.dcad.org/property-search/?sSearch=<ADDRESS>&sTaxYear=2024
    The results page lists property cards with situs address.
    """
    if not HAS_REQUESTS:
        return None, None
    session = _get_session()
    params = {
        'sSearch': addr2.strip(),
        'sTaxYear': '2024',
    }
    try:
        resp = session.get(DCAD_SEARCH_URL, params=params, timeout=10)
        resp.raise_for_status()
        soup = BeautifulSoup(resp.text, 'html.parser')

        # DCAD search results: look for property address in result cards
        # Typical structure: <td class="PropertyAddress"> or similar
        # Try multiple selector patterns since DCAD site structure varies
        candidates = []

        # Pattern 1: table rows with situs address column
        for row in soup.select('table tr'):
            cells = row.find_all('td')
            if len(cells) >= 3:
                text = cells[1].get_text(strip=True) if len(cells) > 1 else ''
                if text and re.match(r'^\d', text):
                    candidates.append(text)

        # Pattern 2: any element with class containing 'address' or 'situs'
        if not candidates:
            for el in soup.find_all(class_=re.compile(r'address|situs|property', re.I)):
                text = el.get_text(strip=True)
                if text and re.match(r'^\d', text) and len(text) < 80:
                    candidates.append(text)

        if candidates:
            return candidates[0], None

        return None, None
    except Exception as e:
        print(f'  DCAD query error for "{addr2}": {e}', file=sys.stderr)
        return None, None


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description='Audit parcels.js address quality')
    parser.add_argument('--skip-dcad', action='store_true',
                        help='Skip DCAD cross-reference (faster, offline-safe)')
    parser.add_argument('--max-dcad', type=int, default=50,
                        help='Max number of DCAD queries to make (default 50)')
    args = parser.parse_args()

    if not HAS_REQUESTS and not args.skip_dcad:
        print('WARNING: requests/BeautifulSoup not installed. DCAD queries will be skipped.')
        print('  Install: pip3 install requests beautifulsoup4')
        args.skip_dcad = True

    print(f'Loading {PARCELS_JS}…')
    geojson = load_parcels_geojson(PARCELS_JS)
    features = geojson.get('features', [])
    print(f'  {len(features)} features loaded.')

    # ── Pass 1: classify all features
    flagged = []
    ok_count = 0
    for idx, feat in enumerate(features):
        props  = feat.get('properties', {})
        addr2  = (props.get('addr2') or '').strip()
        owner  = (props.get('owner') or '').strip()
        parcel_id = props.get('id') or props.get('GID') or props.get('OBJECTID') or str(idx)

        reason = classify_address(addr2, props)
        centroid = feature_centroid(feat)
        lat = round(centroid[0], 6) if centroid else ''
        lon = round(centroid[1], 6) if centroid else ''

        if reason == 'OK':
            ok_count += 1
        else:
            flagged.append({
                'feature_index': idx,
                'parcel_id':     str(parcel_id),
                'current_address': addr2,
                'owner':          owner,
                'reason':         reason,
                'centroid_lat':   lat,
                'centroid_lng':   lon,
                'dcad_situs_address': '',
                'status': 'MISSING' if not addr2 or addr2 == '0' else 'MISMATCH',
            })

    print(f'  OK: {ok_count}  |  Flagged: {len(flagged)}')

    # ── Pass 2: DCAD lookup for flagged parcels
    dcad_matched = 0
    dcad_not_found = 0
    dcad_queries = 0

    if not args.skip_dcad and flagged:
        print(f'\nQuerying DCAD for up to {args.max_dcad} flagged parcels…')
        for item in flagged:
            if dcad_queries >= args.max_dcad:
                print(f'  Reached max DCAD queries ({args.max_dcad}). Stopping.')
                break
            query = item['current_address'] or item['owner']
            if not query:
                item['status'] = 'MISSING'
                continue
            print(f'  [{dcad_queries+1}] Querying: {query!r}')
            situs, acct = query_dcad_by_address(query)
            dcad_queries += 1
            sleep_t = SLEEP_MIN + (SLEEP_MAX - SLEEP_MIN) * (dcad_queries % 3) / 2
            time.sleep(sleep_t)

            if situs:
                item['dcad_situs_address'] = situs
                if situs.upper() != item['current_address'].upper():
                    item['status'] = 'MISMATCH'
                    dcad_matched += 1
                else:
                    item['status'] = 'OK'
                    ok_count += 1
            else:
                item['status'] = 'NOT_FOUND'
                dcad_not_found += 1

    # ── Write CSV
    all_rows = []
    for feat_idx, feat in enumerate(features):
        props = feat.get('properties', {})
        addr2 = (props.get('addr2') or '').strip()
        parcel_id = props.get('id') or props.get('GID') or props.get('OBJECTID') or str(feat_idx)
        centroid = feature_centroid(feat)
        lat = round(centroid[0], 6) if centroid else ''
        lon = round(centroid[1], 6) if centroid else ''

        flagged_item = next((f for f in flagged if f['feature_index'] == feat_idx), None)
        if flagged_item:
            all_rows.append({
                'feature_index': feat_idx,
                'parcel_id':     flagged_item['parcel_id'],
                'current_address': addr2,
                'dcad_situs_address': flagged_item['dcad_situs_address'],
                'centroid_lat':   lat,
                'centroid_lng':   lon,
                'status':         flagged_item['status'],
            })
        else:
            all_rows.append({
                'feature_index': feat_idx,
                'parcel_id':     str(parcel_id),
                'current_address': addr2,
                'dcad_situs_address': '',
                'centroid_lat':   lat,
                'centroid_lng':   lon,
                'status':         'OK',
            })

    with open(RESULTS_CSV, 'w', newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=[
            'feature_index', 'parcel_id', 'current_address',
            'dcad_situs_address', 'centroid_lat', 'centroid_lng', 'status'
        ])
        writer.writeheader()
        writer.writerows(all_rows)
    print(f'\nAudit CSV written: {RESULTS_CSV}')

    # ── Write patch JSON (only mismatches with a DCAD address)
    patches = [
        {
            'feature_index':   r['feature_index'],
            'parcel_id':       r['parcel_id'],
            'corrected_address': r['dcad_situs_address'],
        }
        for r in all_rows
        if r['status'] == 'MISMATCH' and r['dcad_situs_address']
    ]
    with open(PATCH_JSON, 'w', encoding='utf-8') as f:
        json.dump(patches, f, indent=2)
    print(f'Patch JSON written: {PATCH_JSON}  ({len(patches)} corrections)')

    # ── Summary
    total    = len(features)
    n_flagged = len(flagged)
    print(f"""
Summary
───────
  Total parcels:     {total}
  Flagged:           {n_flagged}
  DCAD matched:      {dcad_matched}
  Mismatches:        {len(patches)}
  Not found:         {dcad_not_found}
  DCAD queries made: {dcad_queries}
""")


if __name__ == '__main__':
    main()
