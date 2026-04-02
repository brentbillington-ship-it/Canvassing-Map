"""
fix_parcels.py
--------------
Detects and blanks addr2 fields in parcels.js that were incorrectly injected
by the Nominatim geocoding run. Detection method: a parcel whose addr2 street
name disagrees with 75%+ of its immediate geographic neighbors (within ~60m)
and shares 0% agreement is flagged as a bad injection and reverted to blank.

This stops wrong street-name labels rendering on the map (e.g. "12640 WALTHAM
DR" appearing at a Michelle Place house location).

Usage:
    py fix_parcels.py parcels.js

Output:
    parcels.js          — overwritten in place (keeps a backup as parcels.js.bak)
    fix_parcels_log.csv — list of all blanked entries for review
"""

import sys, re, os, csv, json, math

def main():
    if len(sys.argv) < 2:
        print("Usage: py fix_parcels.py parcels.js")
        sys.exit(1)

    in_path = sys.argv[1]
    bak_path = in_path + '.bak'

    print(f"Reading {in_path}…")
    with open(in_path, 'r', encoding='utf-8') as f:
        raw = f.read()

    # Parse: strip the JS wrapper, load as JSON
    # parcels.js format: const PARCELS_GEOJSON = {...};
    m = re.match(r'^\s*(?:const|var|let)\s+PARCELS_GEOJSON\s*=\s*', raw)
    if not m:
        print("ERROR: Could not find PARCELS_GEOJSON assignment")
        sys.exit(1)
    json_start = m.end()
    # Strip trailing semicolon
    json_str = raw[json_start:].rstrip().rstrip(';').rstrip()
    data = json.loads(json_str)
    features = data['features']
    print(f"Loaded {len(features)} features")

    # Compute centroids
    def centroid(f):
        geom = f['geometry']
        ring = geom['coordinates'][0] if geom['type'] == 'Polygon' else geom['coordinates'][0][0]
        lons = [c[0] for c in ring]
        lats = [c[1] for c in ring]
        return sum(lats)/len(lats), sum(lons)/len(lons)

    for f in features:
        f['_lat'], f['_lon'] = centroid(f)

    # Build spatial grid (~100m cells)
    GRID = 0.001
    grid = {}
    for idx, f in enumerate(features):
        key = (int(f['_lat']/GRID), int(f['_lon']/GRID))
        grid.setdefault(key, []).append(idx)

    # Detect bad injections
    RADIUS = 0.0006  # ~60m
    MIN_NEIGHBORS = 5
    DOM_THRESHOLD = 0.75

    bad = []
    for idx, f in enumerate(features):
        addr = (f['properties'].get('addr2') or '').strip()
        if not addr or not re.match(r'^\d+\s', addr): continue
        if len(addr) > 45 or 'STE' in addr.upper() or 'TRLR' in addr.upper(): continue
        my_street = re.sub(r'^\d+\s+', '', addr).upper().strip()
        if re.search(r'\d{4,}', my_street): continue  # out-of-area county roads

        glat, glon = int(f['_lat']/GRID), int(f['_lon']/GRID)
        neighbors = []
        for dl in (-1, 0, 1):
            for dm in (-1, 0, 1):
                for ni in grid.get((glat+dl, glon+dm), []):
                    if ni == idx: continue
                    n = features[ni]
                    naddr = (n['properties'].get('addr2') or '').strip()
                    if not naddr or not re.match(r'^\d+\s', naddr): continue
                    if 'STE' in naddr.upper() or 'TRLR' in naddr.upper(): continue
                    d = math.sqrt((f['_lat']-n['_lat'])**2 + (f['_lon']-n['_lon'])**2)
                    if d < RADIUS:
                        neighbors.append(re.sub(r'^\d+\s+', '', naddr).upper().strip())

        if len(neighbors) < MIN_NEIGHBORS: continue

        freq = {}
        for s in neighbors:
            freq[s] = freq.get(s, 0) + 1
        top = sorted(freq.items(), key=lambda x: -x[1])
        dom_street, dom_count = top[0]
        dom_pct = dom_count / len(neighbors)
        my_count = neighbors.count(my_street)

        if dom_pct >= DOM_THRESHOLD and my_count == 0 and dom_street != my_street:
            bad.append({
                'idx': idx,
                'addr': addr,
                'lat': round(f['_lat'], 6),
                'lon': round(f['_lon'], 6),
                'dom_street': dom_street,
                'dom_pct': round(dom_pct, 2),
                'neighbor_count': len(neighbors),
            })

    print(f"Found {len(bad)} bad-injection parcels to blank")

    # Write backup
    with open(bak_path, 'w', encoding='utf-8') as f:
        f.write(raw)
    print(f"Backup written to {bak_path}")

    # Apply blanks
    for b in bad:
        features[b['idx']]['properties']['addr2'] = ''

    # Clean up temp centroid keys
    for f in features:
        f.pop('_lat', None)
        f.pop('_lon', None)

    # Reserialize
    json_out = json.dumps(data, separators=(',', ':'))
    out = raw[:json_start] + json_out + ';'
    with open(in_path, 'w', encoding='utf-8') as f:
        f.write(out)
    print(f"parcels.js updated — {len(bad)} addr2 fields blanked")

    # Write log CSV
    log_path = 'fix_parcels_log.csv'
    with open(log_path, 'w', newline='', encoding='utf-8') as f:
        w = csv.DictWriter(f, fieldnames=['idx','addr','lat','lon','dom_street','dom_pct','neighbor_count'])
        w.writeheader()
        w.writerows(bad)
    print(f"Log written to {log_path}")
    print(f"\nNext steps:")
    print(f"  1. Review {log_path} to sanity-check what was blanked")
    print(f"  2. Push the updated parcels.js to GitHub")
    print(f"  3. If anything looks wrong, restore from {bak_path}")

if __name__ == '__main__':
    main()
