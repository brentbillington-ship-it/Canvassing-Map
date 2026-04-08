#!/usr/bin/env python3
"""
dcad_intercept.py
-----------------
Playwright script: opens maps.dcad.org/prd/dpm/, navigates to a known Coppell
parcel, clicks it, and captures every XHR/fetch request that comes back with
address data.

Run locally (NOT in the Claude Code sandbox — it can't download Chromium):
    pip install playwright
    python -m playwright install chromium
    python tools/dcad_intercept.py

Outputs:
    tools/dcad_intercept_results.json   -- every captured API URL + response body
    tools/dcad_best_api_call.txt        -- the single best API call to copy into audit script
"""

import asyncio, json, sys
from pathlib import Path

try:
    from playwright.async_api import async_playwright
except ImportError:
    print("playwright not installed. Run:  pip install playwright && python -m playwright install chromium")
    sys.exit(1)

TARGET_LAT = 32.9888083
TARGET_LON = -96.996685
OUT_JSON   = Path(__file__).parent / 'dcad_intercept_results.json'
OUT_BEST   = Path(__file__).parent / 'dcad_best_api_call.txt'

async def run():
    captures = []

    async with async_playwright() as p:
        print("Launching Chromium (non-headless so you can watch)...")
        browser = await p.chromium.launch(headless=False, slow_mo=200)
        context = await browser.new_context(
            viewport={'width': 1280, 'height': 900},
            user_agent=('Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
                        'AppleWebKit/537.36 (KHTML, like Gecko) '
                        'Chrome/120.0.0.0 Safari/537.36'),
        )
        page = await context.new_page()

        # ── Capture every network request/response
        async def on_request(req):
            url = req.url
            if any(kw in url for kw in ['MapServer', 'rest/services', 'dcad.org', 'FeatureServer']):
                captures.append({'type': 'REQUEST', 'method': req.method, 'url': url})
                print(f"  REQ  {req.method} {url[:140]}")

        async def on_response(resp):
            url = resp.url
            status = resp.status
            if any(kw in url for kw in ['MapServer', 'rest/services', 'FeatureServer']) and status == 200:
                try:
                    text = await resp.text()
                    body_lower = text.lower()
                    has_addr = any(kw in body_lower for kw in [
                        'siteaddress', 'site_address', 'prop_addr', 'address', 'features'
                    ])
                    captures.append({
                        'type': 'RESPONSE', 'url': url, 'status': status,
                        'has_address_data': has_addr,
                        'body_preview': text[:3000],
                    })
                    marker = '*** ADDR DATA ***' if has_addr else ''
                    print(f"  RSP  {status} {marker} {url[:140]}")
                    if has_addr and '"features"' in text:
                        print(f"       BODY: {text[:600]}\n")
                except Exception as e:
                    print(f"  RSP  {status} (read error: {e}) {url[:100]}")

        page.on('request',  on_request)
        page.on('response', on_response)

        # ── Load map
        print(f"\nOpening https://maps.dcad.org/prd/dpm/ ...")
        try:
            await page.goto('https://maps.dcad.org/prd/dpm/', wait_until='networkidle', timeout=60000)
        except Exception as e:
            print(f"Timeout waiting for networkidle (OK): {e}")
        print("Page loaded. Waiting 4s for map to initialize...")
        await asyncio.sleep(4)

        # ── Navigate map to target coordinate
        nav_result = await page.evaluate(f"""
        (() => {{
            // Try every common Leaflet map variable
            const candidates = [
                window.map, window._map, window.leafletMap, window.theMap,
                ...(Object.values(window).filter(v =>
                    v && typeof v === 'object' && typeof v.setView === 'function'
                ))
            ];
            for (const m of candidates) {{
                if (m && typeof m.setView === 'function') {{
                    m.setView([{TARGET_LAT}, {TARGET_LON}], 20);
                    return 'setView called on map object: ' + (m._containerId || '?');
                }}
            }}
            // Leaflet stores map instances in an internal registry
            if (window.L && L.Map && L.Map._instances) {{
                const instances = Object.values(L.Map._instances);
                if (instances.length) {{
                    instances[0].setView([{TARGET_LAT}, {TARGET_LON}], 20);
                    return 'setView via L.Map._instances';
                }}
            }}
            return 'no map found';
        }})()
        """)
        print(f"Map navigation: {nav_result}")
        await asyncio.sleep(4)

        # ── Click center of map (where the target parcel should be)
        vp = page.viewport_size
        cx, cy = vp['width'] // 2, vp['height'] // 2
        print(f"\nClicking map at screen center ({cx}, {cy})...")
        await page.mouse.click(cx, cy)
        await asyncio.sleep(4)

        # ── Check what network requests fired and try to find the API pattern
        api_urls = [c for c in captures if c['type'] == 'REQUEST' and 'MapServer' in c['url']]
        print(f"\n=== MapServer API calls seen so far ({len(api_urls)}) ===")
        for c in api_urls:
            print(f"  {c['method']}  {c['url']}")

        # ── Also dump the page's XHR history via JS (catches any missed by Playwright)
        xhr_history = await page.evaluate("""
        (() => {
            if (!window.__xhrLog) return [];
            return window.__xhrLog.slice(-50);
        })()
        """)
        if xhr_history:
            print("\n=== XHR history from page ===")
            for x in xhr_history:
                print(f"  {x}")

        # ── Try to click a known parcel popup and capture the info panel text
        popup_text = await page.evaluate("""
        (() => {
            // Look for any visible popup or info panel
            const selectors = [
                '.leaflet-popup-content',
                '.esri-popup',
                '.popup-content',
                '[class*="popup"]',
                '[class*="info"]',
                '[class*="parcel"]',
            ];
            for (const sel of selectors) {
                const el = document.querySelector(sel);
                if (el) return { selector: sel, text: el.innerText };
            }
            return null;
        })()
        """)
        if popup_text:
            print(f"\n=== Popup found ({popup_text['selector']}) ===")
            print(popup_text['text'][:500])

        # ── Save all results
        OUT_JSON.write_text(json.dumps(captures, indent=2))
        print(f"\n=== Saved {len(captures)} captures to {OUT_JSON}")

        # ── Identify the best response (has address data + features)
        best = next(
            (c for c in captures
             if c['type'] == 'RESPONSE' and c.get('has_address_data')
             and '"features"' in c.get('body_preview', '')),
            None
        )
        if best:
            OUT_BEST.write_text(f"URL: {best['url']}\n\nBODY:\n{best['body_preview']}")
            print(f"\n*** BEST API CALL ***")
            print(f"URL: {best['url']}")
            print(f"Body: {best['body_preview'][:800]}")
        else:
            print("\nNo response with address data + features found.")
            print("All response URLs:")
            for c in captures:
                if c['type'] == 'RESPONSE':
                    print(f"  {c['url'][:160]}")
            print("\nTIP: Try clicking directly on a parcel boundary (not an empty area).")

        print("\nBrowser will stay open for 30s so you can explore manually...")
        await asyncio.sleep(30)
        await browser.close()


asyncio.run(run())
