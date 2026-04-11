#!/usr/bin/env python3
"""
dcad_spot_check.py
------------------
Playwright spot-check: for each parcel in dcad_spot_check_sample.csv,
queries the confirmed DCAD REST API endpoint directly from the browser
context and reports the SITEADDRESS versus the old addr2 in parcels.js.

Run this LOCALLY (not in the Claude Code sandbox — it has no internet access):

    pip install playwright
    python -m playwright install chromium
    python tools/dcad_spot_check.py

Output:
    tools/dcad_spot_check_results.csv   -- machine-readable results
    Console table                        -- human-readable spot-check

API used (confirmed by prior Playwright intercept):
    https://maps.dcad.org/prdwa/rest/services/Property/ParcelQuery/MapServer/4/query
    geometry  = {"x": <web_mercator_x>, "y": <web_mercator_y>, "spatialReference": {"wkid": 102100}}
    outFields = SITEADDRESS,PARCELID,LOWPARCELID
    returnGeometry = false
    f = json
"""

import asyncio, csv, json, math, sys
from pathlib import Path

try:
    from playwright.async_api import async_playwright
except ImportError:
    print("playwright not installed. Run:  pip install playwright && python -m playwright install chromium")
    sys.exit(1)

SAMPLE_CSV  = Path(__file__).parent / 'dcad_spot_check_sample.csv'
RESULTS_CSV = Path(__file__).parent / 'dcad_spot_check_results.csv'
DCAD_LAYER  = 'https://maps.dcad.org/prdwa/rest/services/Property/ParcelQuery/MapServer/4/query'
SLEEP_S     = 0.6   # between queries


def wgs84_to_webmercator(lat, lon):
    x = lon * 20037508.342 / 180.0
    y = math.log(math.tan((90 + lat) * math.pi / 360.0)) / (math.pi / 180.0)
    y = y * 20037508.342 / 180.0
    return x, y


async def query_dcad(page, lat, lon):
    """Query DCAD REST API from within the browser (avoids proxy issues)."""
    x, y = wgs84_to_webmercator(float(lat), float(lon))
    params = {
        'geometry': json.dumps({
            'x': x, 'y': y,
            'spatialReference': {'wkid': 102100, 'latestWkid': 3857},
        }),
        'geometryType':   'esriGeometryPoint',
        'inSR':           '102100',
        'spatialRel':     'esriSpatialRelIntersects',
        'where':          '',
        'outFields':      'SITEADDRESS,PARCELID,LOWPARCELID,USECD,USEDSCRP',
        'returnGeometry': 'false',
        'f':              'json',
    }
    query_string = '&'.join(f'{k}={v}' for k, v in params.items())
    url = f'{DCAD_LAYER}?{query_string}'

    result = await page.evaluate(f"""
    async () => {{
        const r = await fetch({json.dumps(url)}, {{
            headers: {{
                'Accept': 'application/json',
                'Referer': 'https://maps.dcad.org/prd/dpm/',
            }}
        }});
        if (!r.ok) return {{ error: r.status }};
        return r.json();
    }}
    """)
    return result


async def run():
    sample = list(csv.DictReader(open(SAMPLE_CSV)))
    print(f'Loaded {len(sample)} parcels from {SAMPLE_CSV.name}')

    results = []

    async with async_playwright() as p:
        print('Launching Chromium...')
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(
            viewport={'width': 1280, 'height': 900},
            user_agent=(
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            ),
        )
        page = await context.new_page()

        # Navigate to DCAD site first to pick up any session cookies
        print('Navigating to DCAD site to establish session...')
        try:
            await page.goto('https://maps.dcad.org/prd/dpm/', timeout=30000, wait_until='domcontentloaded')
        except Exception as e:
            print(f'  (site load timed out, continuing anyway: {e})')
        await asyncio.sleep(2)

        print(f'\n{"#":>3}  {"GROUP":<16} {"OLD ADDR2":<42} {"DCAD SITEADDRESS":<42} {"MATCH?"}')
        print('─' * 130)

        for i, row in enumerate(sample, 1):
            lat = row['centroid_lat']
            lon = row['centroid_lng']
            old_addr = row['old_addr2']
            group    = row['group']

            try:
                data = await query_dcad(page, lat, lon)
                await asyncio.sleep(SLEEP_S)

                if 'error' in data:
                    dcad_addr = f'API ERROR {data["error"]}'
                    match = 'ERROR'
                    use_desc = ''
                elif not data.get('features'):
                    dcad_addr = '(no feature returned)'
                    match = 'NOT_FOUND'
                    use_desc = ''
                else:
                    attrs     = data['features'][0]['attributes']
                    dcad_addr = (attrs.get('SITEADDRESS') or '').strip()
                    use_desc  = attrs.get('USEDSCRP', '') or ''
                    if not dcad_addr:
                        dcad_addr = '(blank)'
                    if old_addr.upper() == dcad_addr.upper():
                        match = 'OK'
                    elif group == 'MAILING':
                        match = 'CORRECTED'   # we blanked it; DCAD has the real address
                    elif group == 'NON_RESIDENTIAL':
                        match = 'CONFIRMED_NR' if dcad_addr.upper() != old_addr.upper() else 'SAME'
                    else:
                        match = 'DIFFERS'

            except Exception as e:
                dcad_addr = f'EXCEPTION: {e}'
                match = 'ERROR'
                use_desc = ''

            flag = ''
            if group == 'OUTLIER' and match == 'DIFFERS':
                flag = ' <-- NEEDS FIX'
            elif group == 'MAILING' and dcad_addr and dcad_addr not in ('(no feature returned)', '(blank)') and not dcad_addr.startswith('API'):
                flag = f' <-- real addr: {dcad_addr}'

            print(f'{i:3d}  {group:<16} {old_addr:<42} {dcad_addr:<42} {match}{flag}')

            results.append({
                'feature_index': row['feature_index'],
                'group':         group,
                'old_addr2':     old_addr,
                'dcad_siteaddr': dcad_addr,
                'dcad_use':      use_desc,
                'centroid_lat':  lat,
                'centroid_lng':  lon,
                'match':         match,
            })

        await browser.close()

    # Write results
    with open(RESULTS_CSV, 'w', newline='', encoding='utf-8') as f:
        w = csv.DictWriter(f, fieldnames=list(results[0].keys()))
        w.writeheader(); w.writerows(results)
    print(f'\nResults written to {RESULTS_CSV}')

    # Summary
    by_match = {}
    for r in results:
        by_match[r['match']] = by_match.get(r['match'], 0) + 1
    print('\nSummary:')
    for k, n in sorted(by_match.items()):
        print(f'  {k:<20}: {n}')

    needs_fix = [r for r in results if r['group'] == 'OUTLIER' and r['match'] == 'DIFFERS']
    if needs_fix:
        print(f'\n⚠  {len(needs_fix)} OUTLIER(s) confirmed wrong by DCAD — '
              f'update parcels.js manually or re-run audit with DCAD access:')
        for r in needs_fix:
            print(f'  feature {r["feature_index"]}: {r["old_addr2"]} → {r["dcad_siteaddr"]}')
    else:
        print('\n✓  No OUTLIER mismatches found.')


asyncio.run(run())
