#!/usr/bin/env python3
"""
snap_existing_zones.py
----------------------
ONE-TIME MIGRATION: applies parcel-vertex snapping + a small buffer gap to all
existing zone polygons and writes corrected polygons back to the Sheet.

⚠  THIS SCRIPT WRITES TO THE GOOGLE SHEET.
   Run with --dry-run first to review the diff.
   The script will print a notification prompt before writing.

Usage:
    python3 snap_existing_zones.py --dry-run   # print diff, no write
    python3 snap_existing_zones.py             # write after confirmation

Requirements:
    pip3 install requests

Configuration:
    Copy config.js values into the constants below before running.
"""

import json
import re
import os
import sys
import math
import time
import argparse
import urllib.parse
import urllib.request

# ─── FILL THESE IN FROM config.js ────────────────────────────────────────────
SHEETS_API_URL = 'https://script.google.com/macros/s/AKfycbzWPPXdD0Y2nv1wkLrt6pqLJVnBq_DMp7rLW83AZMiSWWyJyqqTJdKxoMe2x3JE816I/exec'
API_TOKEN      = '8j9zZkuX23vRW80-BKoixdRBJQNdcvdGU9ts425VP14'
# ─────────────────────────────────────────────────────────────────────────────

PARCELS_JS     = os.path.join(os.path.dirname(__file__), '..', 'parcels.js')
SNAP_THRESHOLD_M  = 10.0   # snap if vertex is within this many meters of a parcel vertex
BUFFER_DEG        = 0.000015  # ~1.5 m in degrees lat; applied as a simple shrink

DEG_PER_M_LAT = 1.0 / 111320.0
DEG_PER_M_LON = lambda lat: 1.0 / (111320.0 * math.cos(math.radians(lat)))


# ─── Geometry helpers ─────────────────────────────────────────────────────────

def _dist_m(lat1, lon1, lat2, lon2):
    """Approximate Euclidean distance in meters between two lat/lon points."""
    dlat = (lat2 - lat1) * 111320.0
    dlon = (lon2 - lon1) * 111320.0 * math.cos(math.radians((lat1 + lat2) / 2))
    return math.sqrt(dlat * dlat + dlon * dlon)


def _ring_centroid(ring):
    lons = [c[0] for c in ring]
    lats = [c[1] for c in ring]
    return sum(lats) / len(lats), sum(lons) / len(lons)


def _polygon_area_signed(ring):
    """Signed area of a [lon,lat] ring (positive = CCW)."""
    n = len(ring)
    area = 0.0
    for i in range(n):
        j = (i + 1) % n
        area += ring[i][0] * ring[j][1]
        area -= ring[j][0] * ring[i][1]
    return area / 2.0


def shrink_ring(ring, buf_deg):
    """
    Approximate polygon shrink by moving each vertex inward by buf_deg.
    Works for convex/mostly-convex polygons. For concave polygons this
    is a rough approximation — sufficient for a small 1–2 m buffer.
    cLat, cLon = ring centroid.
    """
    cLat, cLon = _ring_centroid(ring)
    shrunk = []
    for (lon, lat) in ring:
        dlat = lat - cLat
        dlon = lon - cLon
        dist = math.sqrt(dlat**2 + dlon**2)
        if dist < 1e-9:
            shrunk.append([lon, lat])
            continue
        # Move vertex toward centroid by buf_deg
        ratio = max(0, (dist - buf_deg) / dist)
        shrunk.append([cLon + dlon * ratio, cLat + dlat * ratio])
    return shrunk


# ─── Build parcel vertex spatial index ───────────────────────────────────────

def load_parcels_geojson(path):
    with open(path, 'r', encoding='utf-8') as f:
        raw = f.read()
    m = re.match(r'^\s*(?:const|var|let)\s+\w+\s*=\s*', raw)
    if m:
        raw = raw[m.end():]
    raw = raw.rstrip().rstrip(';').rstrip()
    return json.loads(raw)


def build_vertex_grid(geojson, cell_deg=0.001):
    """
    Build a grid-bucketed spatial index of all parcel vertices.
    Returns a dict: (grid_row, grid_col) → list of (lon, lat) vertices.
    """
    grid = {}
    for feat in geojson.get('features', []):
        geom = feat['geometry']
        rings = []
        if geom['type'] == 'Polygon':
            rings = geom['coordinates']
        elif geom['type'] == 'MultiPolygon':
            for poly in geom['coordinates']:
                rings.extend(poly)
        for ring in rings:
            for (lon, lat) in ring:
                key = (int(lat / cell_deg), int(lon / cell_deg))
                if key not in grid:
                    grid[key] = []
                grid[key].append((lon, lat))
    return grid, cell_deg


def nearest_parcel_vertex(lat, lon, grid, cell_deg, threshold_m):
    """
    Search the grid for the closest parcel vertex within threshold_m.
    Returns (snap_lon, snap_lat) or None.
    """
    radius_cells = max(1, int(math.ceil(threshold_m * DEG_PER_M_LAT / cell_deg)) + 1)
    row0 = int(lat / cell_deg)
    col0 = int(lon / cell_deg)

    best_dist = threshold_m + 1.0
    best = None
    for dr in range(-radius_cells, radius_cells + 1):
        for dc in range(-radius_cells, radius_cells + 1):
            for (vlon, vlat) in grid.get((row0 + dr, col0 + dc), []):
                d = _dist_m(lat, lon, vlat, vlon)
                if d < best_dist:
                    best_dist = d
                    best = (vlon, vlat)
    return best


# ─── Sheets API calls ─────────────────────────────────────────────────────────

def _api_call(payload):
    payload['_token'] = API_TOKEN
    encoded = urllib.parse.quote(json.dumps(payload))
    url = SHEETS_API_URL + '?payload=' + encoded
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode('utf-8'))


def get_polygons():
    return _api_call({'action': 'getPolygons'})


def save_polygon(letter, geojson):
    payload = json.dumps({'action': 'saveTurfPolygon', 'letter': letter,
                          'geojson': geojson, '_token': API_TOKEN})
    req = urllib.request.Request(
        SHEETS_API_URL,
        data=payload.encode('utf-8'),
        headers={'Content-Type': 'text/plain'},
        method='POST'
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode('utf-8'))


# ─── Snap a zone ring ─────────────────────────────────────────────────────────

def snap_ring(ring, grid, cell_deg, threshold_m):
    """
    For each vertex in ring, snap to nearest parcel vertex within threshold_m.
    Skips the closing duplicate vertex (last == first).
    """
    snapped = []
    is_closed = ring[0] == ring[-1]
    verts = ring[:-1] if is_closed else ring[:]
    snap_count = 0

    for (lon, lat) in verts:
        result = nearest_parcel_vertex(lat, lon, grid, cell_deg, threshold_m)
        if result is not None:
            snapped.append(list(result))
            snap_count += 1
        else:
            snapped.append([lon, lat])

    if is_closed:
        snapped.append(snapped[0])

    return snapped, snap_count


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description='Snap existing zone polygons to parcel boundaries and apply buffer gap.')
    parser.add_argument('--dry-run', action='store_true',
                        help='Show changes without writing to Sheet')
    parser.add_argument('--threshold', type=float, default=SNAP_THRESHOLD_M,
                        help=f'Snap threshold in meters (default {SNAP_THRESHOLD_M})')
    parser.add_argument('--buffer', type=float, default=BUFFER_DEG,
                        help=f'Shrink buffer in degrees (default {BUFFER_DEG:.6f} ≈ 1.5m)')
    args = parser.parse_args()

    print('Loading parcel vertex index…')
    parcels_geojson = load_parcels_geojson(PARCELS_JS)
    grid, cell_deg = build_vertex_grid(parcels_geojson)
    print(f'  {len(grid)} grid cells from {len(parcels_geojson["features"])} parcels.')

    print('\nFetching zone polygons from Sheet…')
    poly_data = get_polygons()
    polygons  = poly_data.get('polygons', [])
    print(f'  {len(polygons)} zones fetched.')

    if not polygons:
        print('No polygons to process.')
        return

    changes = []

    for zone in polygons:
        letter   = zone['letter']
        geo_raw  = zone.get('polygon_geojson', '')
        if not geo_raw:
            continue
        try:
            geo = json.loads(geo_raw) if isinstance(geo_raw, str) else geo_raw
        except Exception:
            print(f'  Zone {letter}: could not parse GeoJSON — skip')
            continue

        if geo.get('type') == 'Polygon':
            rings = geo['coordinates']
        elif geo.get('type') == 'MultiPolygon':
            rings = [poly[0] for poly in geo['coordinates']]
        else:
            continue

        new_rings = []
        total_snapped = 0
        for ring in rings:
            snapped_ring, n = snap_ring(ring, grid, cell_deg, args.threshold)
            buffered_ring   = shrink_ring(snapped_ring, args.buffer)
            new_rings.append(buffered_ring)
            total_snapped  += n

        if geo.get('type') == 'Polygon':
            new_geo = {'type': 'Polygon', 'coordinates': new_rings}
        else:
            new_geo = {'type': 'MultiPolygon',
                       'coordinates': [[r] for r in new_rings]}

        if total_snapped > 0:
            changes.append({
                'letter':  letter,
                'old_geo': geo,
                'new_geo': new_geo,
                'snapped': total_snapped,
                'total':   len(rings[0]) if rings else 0,
            })
            print(f'  Zone {letter}: {total_snapped} vertices snapped / {len(rings[0]) if rings else 0} total')
        else:
            print(f'  Zone {letter}: no vertices within threshold — unchanged')

    if not changes:
        print('\nNo zones need snapping.')
        return

    print(f'\n{len(changes)} zones with changes.')

    if args.dry_run:
        print('\n[DRY RUN] Changes not written. Remove --dry-run to apply.')
        for c in changes:
            print(f'  Zone {c["letter"]}: {c["snapped"]} vertices snapped')
        return

    # ── Safety gate: require explicit confirmation before writing ────────────
    print('\n' + '='*60)
    print('⚠️  ABOUT TO WRITE CORRECTED POLYGONS TO GOOGLE SHEET')
    print('   Review the diff above before proceeding.')
    print('='*60)
    answer = input('Type YES to write all changes, or anything else to abort: ').strip()
    if answer != 'YES':
        print('Aborted — no changes written.')
        return

    print('\nWriting corrected polygons…')
    ok = 0; failed = 0
    for c in changes:
        try:
            res = save_polygon(c['letter'], c['new_geo'])
            if res.get('success'):
                print(f'  Zone {c["letter"]}: ✓ saved')
                ok += 1
            else:
                print(f'  Zone {c["letter"]}: ERROR — {res.get("error", "unknown")}')
                failed += 1
        except Exception as e:
            print(f'  Zone {c["letter"]}: EXCEPTION — {e}')
            failed += 1
        time.sleep(0.3)

    print(f'\nDone. Saved: {ok}  Failed: {failed}')


if __name__ == '__main__':
    main()
