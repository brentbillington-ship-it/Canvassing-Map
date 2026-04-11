#!/usr/bin/env python3
"""
Build voter_data.js and voter_knocks.js from the source CSV + parcels.js.

- voter_data.js: keyed by normalized address, stores voter list per address (popup data)
- voter_knocks.js: array of {lat, lon, address, normKey, precinct, voters: [...]} ready to render

Run from repo root:
    python3 tools/build_voter_data.py

Source CSV: temp/all-precincts_both_min-may3-nov1_2102rows.csv
"""
import csv, json, re, sys, os

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CSV_PATH    = os.path.join(REPO, 'temp', 'all-precincts_both_min-may3-nov1_2102rows.csv')
PARCELS_PATH = os.path.join(REPO, 'parcels.js')
VOTER_DATA_OUT  = os.path.join(REPO, 'voter_data.js')
VOTER_KNOCKS_OUT = os.path.join(REPO, 'voter_knocks.js')

ABBREV = [
    (' DRIVE', ' DR'), (' STREET', ' ST'), (' LANE', ' LN'),
    (' COURT', ' CT'), (' CIRCLE', ' CIR'), (' BOULEVARD', ' BLVD'),
    (' TRAIL', ' TRL'), (' AVENUE', ' AVE'), (' PLACE', ' PL'),
    (' ROAD', ' RD'), (' COVE', ' CV'), (' PARKWAY', ' PKWY'),
    (' HIGHWAY', ' HWY'), (' SQUARE', ' SQ'), (' TERRACE', ' TER'),
]

def normalize(addr):
    if not addr:
        return ''
    a = addr.upper().strip()
    # Strip city/state/zip
    a = re.sub(r',\s*COPPELL.*', '', a)
    a = re.sub(r',\s*IRVING.*', '', a)
    a = re.sub(r',\s*TX.*', '', a)
    # Collapse spaces
    a = re.sub(r'\s+', ' ', a).strip()
    # Normalize abbreviations
    for full, abbr in ABBREV:
        a = a.replace(full, abbr)
    # Strip apartment unit suffixes
    a = re.sub(r'\s+(APT|UNIT|STE|SUITE)\s+\S+.*$', '', a)
    a = re.sub(r'\s+#\S+.*$', '', a)
    return a

def load_parcels():
    """Returns dict: normalized_addr -> {lat, lon, addr2, owner}"""
    print(f"Loading parcels from {PARCELS_PATH}...", file=sys.stderr)
    with open(PARCELS_PATH) as f:
        content = f.read()
    # Strip JS wrapper
    m = re.search(r'const PARCELS_GEOJSON\s*=\s*({.*});?\s*$', content, re.DOTALL)
    if not m:
        raise RuntimeError("Could not parse parcels.js")
    data = json.loads(m.group(1))

    parcels_by_norm = {}
    for f in data['features']:
        addr2 = (f['properties'].get('addr2') or '').strip()
        if not addr2:
            continue
        norm = normalize(addr2)
        if not norm:
            continue
        # Compute centroid
        geom = f['geometry']
        if geom['type'] == 'Polygon':
            ring = geom['coordinates'][0]
        elif geom['type'] == 'MultiPolygon':
            ring = geom['coordinates'][0][0]
        else:
            continue
        if not ring:
            continue
        lat = sum(p[1] for p in ring) / len(ring)
        lon = sum(p[0] for p in ring) / len(ring)
        # Pick the parcel with the most vertices for duplicates (richest geometry)
        existing = parcels_by_norm.get(norm)
        if existing is None or len(ring) > existing.get('_vertices', 0):
            parcels_by_norm[norm] = {
                'lat': lat, 'lon': lon, 'addr2': addr2,
                'owner': f['properties'].get('owner', ''),
                '_vertices': len(ring),
            }
    return parcels_by_norm

def parse_int(s):
    try: return int(str(s).strip())
    except: return 0

def main():
    parcels = load_parcels()
    print(f"Loaded {len(parcels)} unique parcels (by normalized address)", file=sys.stderr)

    # ── Read source CSV ────────────────────────────────────────────────
    voter_data = {}  # normKey -> {voters: [...]}
    csv_rows = 0
    with open(CSV_PATH) as f:
        reader = csv.DictReader(f)
        for row in reader:
            csv_rows += 1
            addr = row['address']
            norm = normalize(addr)
            if not norm:
                continue
            names = [n.strip() for n in row.get('voters', '').split(';') if n.strip()]
            totals = [parse_int(s) for s in row.get('total_votes', '').split(',')]
            mays   = [parse_int(s) for s in row.get('may_votes', '').split(',')]
            novs   = [parse_int(s) for s in row.get('nov_votes', '').split(',')]

            voters = []
            for i, name in enumerate(names):
                voters.append({
                    'name': name,
                    'total_votes': totals[i] if i < len(totals) else 0,
                    'may_votes':   mays[i]   if i < len(mays) else 0,
                    'nov_votes':   novs[i]   if i < len(novs) else 0,
                })
            entry = voter_data.setdefault(norm, {'voters': [], '_precinct': row.get('precinct', '')})
            # If duplicate normKey, append voters (don't dedup by name — same name in different rows is rare)
            entry['voters'].extend(voters)

    print(f"CSV rows: {csv_rows}", file=sys.stderr)
    print(f"voter_data keys (after normalization): {len(voter_data)}", file=sys.stderr)

    # ── Build voter_data.js (popup lookup, keyed by normKey) ───────────
    voter_data_out = {k: {'voters': v['voters']} for k, v in voter_data.items()}
    with open(VOTER_DATA_OUT, 'w') as f:
        f.write('// Voter data — generated from CSV by tools/build_voter_data.py\n')
        f.write(f'// Source: temp/all-precincts_both_min-may3-nov1_2102rows.csv ({csv_rows} rows)\n')
        f.write(f'// Total addresses: {len(voter_data_out)}\n')
        f.write('const VOTER_DATA = ')
        json.dump(voter_data_out, f, separators=(',', ':'))
        f.write(';\n')
    print(f"Wrote {VOTER_DATA_OUT}", file=sys.stderr)

    # ── Build voter_knocks.js (rendering data, parcel-matched) ──────────
    knocks = []
    matched = 0
    unmatched = []
    for norm, entry in voter_data.items():
        parcel = parcels.get(norm)
        if parcel:
            knocks.append({
                'lat': round(parcel['lat'], 7),
                'lon': round(parcel['lon'], 7),
                'address': parcel['addr2'],
                'normKey': norm,
                'precinct': entry['_precinct'],
                'voterCount': len(entry['voters']),
            })
            matched += 1
        else:
            unmatched.append(norm)

    with open(VOTER_KNOCKS_OUT, 'w') as f:
        f.write('// Voter knocks — generated from voter_data + parcels by tools/build_voter_data.py\n')
        f.write(f'// Total: {matched} parcel-matched knock locations\n')
        f.write('const VOTER_KNOCKS = ')
        json.dump(knocks, f, separators=(',', ':'))
        f.write(';\n')
    print(f"Wrote {VOTER_KNOCKS_OUT}", file=sys.stderr)

    print(f"\n=== SUMMARY ===", file=sys.stderr)
    print(f"CSV rows: {csv_rows}", file=sys.stderr)
    print(f"voter_data unique addresses: {len(voter_data)}", file=sys.stderr)
    print(f"Parcel matches: {matched}", file=sys.stderr)
    print(f"Unmatched (no Coppell parcel): {len(unmatched)}", file=sys.stderr)
    if unmatched[:10]:
        print(f"Sample unmatched:", file=sys.stderr)
        for u in unmatched[:10]:
            print(f"  - {u}", file=sys.stderr)

if __name__ == '__main__':
    main()
