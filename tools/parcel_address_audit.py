#!/usr/bin/env python3
"""
parcel_address_audit.py
-----------------------
Audits address quality in parcels.js and cross-references DCAD
for corrected situs addresses using Playwright (real browser, bot-resistant).

Usage:
    python parcel_address_audit.py [--skip-dcad] [--max-dcad N]

Requirements:
    pip install playwright beautifulsoup4
    playwright install chromium

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
import random

try:
    from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout
    HAS_PLAYWRIGHT = True
except ImportError:
    HAS_PLAYWRIGHT = False

# ─── Config ──────────────────────────────────────────────────────────────────

PARCELS_JS  = os.path.join(os.path.dirname(__file__), '..', 'parcels.js')
RESULTS_CSV = os.path.join(os.path.dirname(__file__), 'parcel_audit_results.csv')
PATCH_JSON  = os.path.join(os.path.dirname(__file__), 'parcel_address_patch.json')

DCAD_SEARCH_URL = 'https://www.dcad.org/property-search/'
SLEEP_MIN = 1.5
SLEEP_MAX = 3.0

VALID_ZIP_PREFIXES = ('750', '751', '752', '760', '761')

# ─── Load parcels.js ─────────────────────────────────────────────────────────

def load_parcels_geojson(path):
    """Strip JS comments and variable wrapper, return parsed GeoJSON dict."""
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

# ─── Playwright DCAD scraper ─────────────────────────────────────────────────

class DCADScraper:
    def __init__(self, headless=True):
        self._pw = None
        self._browser = None
        self._page = None
        self.headless = headless

    def __enter__(self):
        self._pw = sync_playwright().start()
        self._browser = self._pw.chromium.launch(
            headless=self.headless,
            args=['--disable-blink-features=AutomationControlled']
        )
        context = self._browser.new_context(
            viewport={'width': 1280, 'height': 800},
            user_agent=(
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
                'AppleWebKit/537.36 (KHTML, like Gecko) '
                'Chrome/122.0.0.0 Safari/537.36'
            ),
            locale='en-US',
        )
        self._page = context.new_page()
        # Mask webdriver flag
        self._page.add_init_script(
            "Object.defineProperty(navigator, 'webdriver', {get: () => undefined})"
        )
        print('  Browser launched. Loading DCAD search page...')
        self._page.goto(DCAD_SEARCH_URL, wait_until='networkidle', timeout=30000)
        time.sleep(2)
        return self

    def __exit__(self, *args):
        if self._browser:
            self._browser.close()
        if self._pw:
            self._pw.stop()

    def query(self, address):
        """
        Search DCAD for address. Returns situs address string or None.
        """
        page = self._page
        try:
            # Find and clear the search input
            # DCAD uses various input selectors — try common ones
            search_sel = (
                'input[name="sSearch"], '
                'input[placeholder*="search" i], '
                'input[placeholder*="address" i], '
                'input[type="search"], '
                '#sSearch, '
                '.search-input input, '
                'input[type="text"]'
            )
            search_box = page.locator(search_sel).first
            search_box.wait_for(state='visible', timeout=8000)
            search_box.triple_click()
            search_box.fill(address)

            # Small human-like pause
            time.sleep(random.uniform(0.3, 0.7))

            # Submit — try Enter key first, then look for a button
            search_box.press('Enter')

            # Wait for results to load
            try:
                page.wait_for_load_state('networkidle', timeout=10000)
            except PWTimeout:
                pass
            time.sleep(random.uniform(0.8, 1.5))

            # Extract situs address from results
            # DCAD results typically show property address in a table or card
            html = page.content()

            from bs4 import BeautifulSoup
            soup = BeautifulSoup(html, 'html.parser')

            candidates = []

            # Pattern 1: table cells starting with a number (street address)
            for row in soup.select('table tbody tr'):
                cells = row.find_all('td')
                for cell in cells:
                    text = cell.get_text(strip=True)
                    if re.match(r'^\d+\s+\w', text) and len(text) < 80:
                        candidates.append(text)
                        break

            # Pattern 2: elements with address-like classes
            if not candidates:
                for el in soup.find_all(
                    class_=re.compile(r'address|situs|street|property-addr', re.I)
                ):
                    text = el.get_text(strip=True)
                    if re.match(r'^\d+\s+\w', text) and len(text) < 80:
                        candidates.append(text)

            # Pattern 3: any text node that looks like a Coppell street address
            if not candidates:
                for el in soup.find_all(string=re.compile(
                    r'^\d+\s+\w+.*(COPPELL|75019)', re.I
                )):
                    text = el.strip()
                    if len(text) < 80:
                        candidates.append(text)

            return candidates[0] if candidates else None

        except Exception as e:
            print(f'    Query error for "{address}": {e}', file=sys.stderr)
            # Try to recover by reloading search page
            try:
                page.goto(DCAD_SEARCH_URL, wait_until='networkidle', timeout=15000)
                time.sleep(2)
            except Exception:
                pass
            return None

# ─── Main ────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description='Audit parcels.js address quality')
    parser.add_argument('--skip-dcad', action='store_true',
                        help='Skip DCAD cross-reference')
    parser.add_argument('--max-dcad', type=int, default=100,
                        help='Max DCAD queries (default 100)')
    parser.add_argument('--visible', action='store_true',
                        help='Show browser window (non-headless, useful for debugging)')
    args = parser.parse_args()

    if not HAS_PLAYWRIGHT and not args.skip_dcad:
        print('ERROR: playwright not installed.')
        print('  Run: pip install playwright && playwright install chromium')
        sys.exit(1)

    print(f'Loading {PARCELS_JS}...')
    geojson = load_parcels_geojson(PARCELS_JS)
    features = geojson.get('features', [])
    print(f'  {len(features)} features loaded.')

    # Pass 1: classify all features
    flagged = []
    ok_count = 0
    for idx, feat in enumerate(features):
        props     = feat.get('properties', {})
        addr2     = (props.get('addr2') or '').strip()
        owner     = (props.get('owner') or '').strip()
        parcel_id = (props.get('id') or props.get('GID') or
                     props.get('OBJECTID') or str(idx))
        reason    = classify_address(addr2, props)
        centroid  = feature_centroid(feat)
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
                'status': 'MISSING' if not addr2 or addr2 == '0' else 'MISMATCH',
            })

    print(f'  OK: {ok_count}  |  Flagged: {len(flagged)}')

    # Pass 2: DCAD Playwright lookup
    dcad_matched = dcad_not_found = dcad_queries = 0

    if not args.skip_dcad and flagged:
        print(f'\nLaunching Playwright browser for DCAD queries (max {args.max_dcad})...')
        headless = not args.visible
        with DCADScraper(headless=headless) as scraper:
            for item in flagged:
                if dcad_queries >= args.max_dcad:
                    print(f'  Reached max ({args.max_dcad}). Stopping DCAD queries.')
                    break

                # Use owner name as fallback query if address is blank
                query = item['current_address'] or item['owner']
                if not query:
                    item['status'] = 'MISSING'
                    continue

                print(f'  [{dcad_queries+1}/{min(args.max_dcad, len(flagged))}] '
                      f'Querying: {query!r}')
                situs = scraper.query(query)
                dcad_queries += 1

                # Polite random sleep between queries
                time.sleep(random.uniform(SLEEP_MIN, SLEEP_MAX))

                if situs:
                    item['dcad_situs_address'] = situs
                    if situs.upper() != item['current_address'].upper():
                        item['status'] = 'MISMATCH'
                        dcad_matched += 1
                    else:
                        item['status'] = 'OK'
                        ok_count += 1
                    print(f'    Found: {situs}')
                else:
                    item['status'] = 'NOT_FOUND'
                    dcad_not_found += 1
                    print(f'    Not found.')

    # Write CSV
    all_rows = []
    for feat_idx, feat in enumerate(features):
        props     = feat.get('properties', {})
        addr2     = (props.get('addr2') or '').strip()
        parcel_id = (props.get('id') or props.get('GID') or
                     props.get('OBJECTID') or str(feat_idx))
        centroid  = feature_centroid(feat)
        lat = round(centroid[0], 6) if centroid else ''
        lon = round(centroid[1], 6) if centroid else ''
        fi = next((f for f in flagged if f['feature_index'] == feat_idx), None)
        if fi:
            all_rows.append({
                'feature_index': feat_idx, 'parcel_id': fi['parcel_id'],
                'current_address': addr2, 'dcad_situs_address': fi['dcad_situs_address'],
                'centroid_lat': lat, 'centroid_lng': lon, 'status': fi['status'],
            })
        else:
            all_rows.append({
                'feature_index': feat_idx, 'parcel_id': str(parcel_id),
                'current_address': addr2, 'dcad_situs_address': '',
                'centroid_lat': lat, 'centroid_lng': lon, 'status': 'OK',
            })

    with open(RESULTS_CSV, 'w', newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=[
            'feature_index', 'parcel_id', 'current_address',
            'dcad_situs_address', 'centroid_lat', 'centroid_lng', 'status'])
        writer.writeheader()
        writer.writerows(all_rows)
    print(f'\nAudit CSV written: {RESULTS_CSV}')

    patches = [
        {'feature_index': r['feature_index'], 'parcel_id': r['parcel_id'],
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
  DCAD matched   : {dcad_matched}
  Mismatches     : {len(patches)}
  Not found      : {dcad_not_found}
  DCAD queries   : {dcad_queries}
""")


if __name__ == '__main__':
    main()
