"""
geocode_addresses_v3.py
-----------------------
Fixes the remaining street-only addresses in the Chaka canvassing houses sheet
using a FORWARD geocode strategy instead of reverse.

The problem with v1/v2: parcel centroids for road-ROW or boundary parcels sit
ON the road, so reverse-geocoding returns the nearest building on the wrong street.

v3 strategy:
  1. Group rows by street name (e.g. all "TANBARK CIRCLE" rows together).
  2. For each unique street, forward-geocode "STREET NAME, Coppell TX 75019"
     via Nominatim to get the street's bounding box.
  3. Use the parcel lat/lon to estimate a house number by interpolating along
     the street segment bounding box (even/odd side heuristic).
  4. If Nominatim returns an exact address for the street+city, use it directly.
  5. Rows that can't be resolved are written to _still_missing.csv for manual
     lookup.

ALSO handles:
  - Trails / greenways / arterials: auto-tagged as SKIP (not canvassable).
  - Blank address + no lat/lon: left as-is.

Usage:
    py geocode_addresses_v3.py <input_csv>

    Input: the _still_missing.csv from v2, OR the original missing addresses CSV.

Output:
    <base>_v3_geocoded.csv       — full CSV, blanks filled where possible
    <base>_v3_changes.csv        — only rows that changed
    <base>_v3_still_missing.csv  — rows that couldn't be resolved (manual review)

Nominatim fair-use: 1 req/sec enforced.
"""

import csv, sys, time, json, os, re
import urllib.request, urllib.parse

NOMINATIM_SEARCH  = "https://nominatim.openstreetmap.org/search"
NOMINATIM_REVERSE = "https://nominatim.openstreetmap.org/reverse"
USER_AGENT        = "ChakaCampaign-AddressFixer/3.0 (brent@chaka4cisd.com)"
DELAY_SEC         = 1.1
CITY_SUFFIX       = "Coppell TX 75019"

# These street types will never have individual house numbers — mark as skip
SKIP_PATTERNS = [
    r'TRAIL', r'CANAL', r'GREENWAY', r'GREENBELT', r'CAMPION',
    r'FREEPORT PARKWAY', r'OLYMPUS BLVD', r'GATEWAY BLVD',
    r'NORTH STATE HIGHWAY', r'SOUTH STATE HIGHWAY',
    r'\bHWY\b', r'\bFM\b', r'\bIH-\b',
]

# Arterials where centroids land on the road — flag for manual review
ARTERIAL_PATTERNS = [
    r'MACARTHUR BLVD', r'SANDY LAKE', r'DENTON TAP',
    r'BELT LINE', r'ROYAL LANE', r'BELTLINE',
]


def _req(url):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=12) as resp:
        return json.loads(resp.read().decode())


def is_skip(addr):
    a = addr.upper()
    return any(re.search(p, a) for p in SKIP_PATTERNS)


def is_arterial(addr):
    a = addr.upper()
    return any(re.search(p, a) for p in ARTERIAL_PATTERNS)


def is_street_only(addr):
    if not addr or not addr.strip():
        return True
    return not bool(re.match(r'^\d+\s', addr.strip()))


def forward_search(street_name):
    """
    Forward-geocode 'STREET NAME, Coppell TX 75019'.
    Returns list of Nominatim results (dicts with lat/lon/display_name/address).
    """
    query = f"{street_name}, {CITY_SUFFIX}"
    params = urllib.parse.urlencode({
        "q": query, "format": "json", "addressdetails": 1,
        "limit": 5, "countrycodes": "us",
    })
    try:
        results = _req(f"{NOMINATIM_SEARCH}?{params}")
        time.sleep(DELAY_SEC)
        return results
    except Exception as e:
        print(f"    [WARN] Forward search failed for '{street_name}': {e}")
        time.sleep(DELAY_SEC)
        return []


def reverse_geocode(lat, lon):
    """Reverse-geocode a single point. Returns address string or None."""
    params = urllib.parse.urlencode({
        "lat": lat, "lon": lon,
        "format": "json", "addressdetails": 1, "zoom": 18,
    })
    try:
        data = _req(f"{NOMINATIM_REVERSE}?{params}")
        time.sleep(DELAY_SEC)
        a    = data.get("address", {})
        num  = a.get("house_number", "").strip()
        road = a.get("road", a.get("pedestrian", "")).strip()
        if num and road:
            return f"{num} {road.upper()}"
        elif road:
            return road.upper()
        return None
    except Exception as e:
        print(f"    [WARN] Reverse geocode failed ({lat},{lon}): {e}")
        time.sleep(DELAY_SEC)
        return None


def interpolate_house_number(lat, lon, street_results):
    """
    Given a parcel centroid and the Nominatim bounding box for a street,
    estimate the house number by linear interpolation along the street axis.
    Returns an integer house number or None.
    """
    if not street_results:
        return None

    # Find result with a bounding box
    for r in street_results:
        bb = r.get("boundingbox")  # [min_lat, max_lat, min_lon, max_lon]
        if not bb:
            continue
        min_lat, max_lat = float(bb[0]), float(bb[1])
        min_lon, max_lon = float(bb[2]), float(bb[3])

        lat_range = max_lat - min_lat
        lon_range = max_lon - min_lon

        if lat_range <= 0 and lon_range <= 0:
            continue

        # Determine primary axis (which dimension is larger)
        if lat_range >= lon_range:
            # Street runs N-S
            t = (lat - min_lat) / lat_range if lat_range > 0 else 0.5
        else:
            # Street runs E-W
            t = (lon - min_lon) / lon_range if lon_range > 0 else 0.5

        t = max(0.0, min(1.0, t))

        # Try to get number range from existing address results
        nums = []
        for res in street_results:
            addr = res.get("address", {})
            hn = addr.get("house_number", "")
            if hn and re.match(r'^\d+', hn):
                nums.append(int(re.match(r'^\d+', hn).group()))

        if nums:
            lo, hi = min(nums), max(nums)
            if hi > lo:
                estimated = int(lo + t * (hi - lo))
                # Round to nearest even or odd based on t (even=left, odd=right)
                estimated = (estimated // 2) * 2
                return max(1, estimated)

    return None


def process_street_group(street_name, rows):
    """
    Try to resolve house numbers for a group of rows sharing the same street name.
    Returns list of (row, resolved_address_or_None) tuples.
    """
    print(f"\n  Street: {street_name} ({len(rows)} rows)")

    # Step 1: forward search for the street
    results = forward_search(street_name)
    if not results:
        print(f"    No forward results — trying reverse on each row individually")
        resolved = []
        for row in rows:
            lat, lon = row.get("lat", ""), row.get("lon", "")
            if not lat or not lon:
                resolved.append((row, None))
                continue
            r = reverse_geocode(lat, lon)
            if r and re.match(r'^\d+\s', r):
                resolved.append((row, r))
            else:
                resolved.append((row, None))
        return resolved

    # Step 2: try reverse geocode for each row's centroid
    # (now with the benefit of knowing we have a valid street in Nominatim)
    resolved = []
    for row in rows:
        lat, lon = row.get("lat", ""), row.get("lon", "")
        if not lat or not lon:
            resolved.append((row, None))
            continue

        # Try reverse at original centroid
        r = reverse_geocode(lat, lon)
        if r and re.match(r'^\d+\s', r) and street_name.upper() in r.upper():
            print(f"    ({lat[:8]},{lon[:9]}) → '{r}' ✓")
            resolved.append((row, r))
            continue

        # Reverse didn't get house number on correct street —
        # try interpolation from the bounding box
        num = interpolate_house_number(float(lat), float(lon), results)
        if num:
            addr = f"{num} {street_name.upper()}"
            print(f"    ({lat[:8]},{lon[:9]}) → '{addr}' (interpolated)")
            resolved.append((row, addr))
        else:
            print(f"    ({lat[:8]},{lon[:9]}) → no number found")
            resolved.append((row, None))

    return resolved


def main():
    if len(sys.argv) < 2:
        print("Usage: py geocode_addresses_v3.py <input_csv>")
        sys.exit(1)

    in_path  = sys.argv[1]
    base     = re.sub(r'_(still_missing|geocoded|changes)$', '', os.path.splitext(in_path)[0])
    out_path     = base + "_v3_geocoded.csv"
    changes_path = base + "_v3_changes.csv"
    still_path   = base + "_v3_still_missing.csv"

    with open(in_path, newline='', encoding='utf-8-sig') as f:
        rows = list(csv.DictReader(f))

    if not rows:
        print("No rows found.")
        sys.exit(1)

    fieldnames = list(rows[0].keys())
    if "nominatim_best" in fieldnames:
        fieldnames.remove("nominatim_best")  # drop v2 artifact column

    # Separate rows that need work
    to_fix = [r for r in rows if is_street_only(r.get("address", ""))]
    ok_rows = [r for r in rows if not is_street_only(r.get("address", ""))]
    print(f"Loaded {len(rows)} rows — {len(to_fix)} need fixing, {len(ok_rows)} already have house numbers.\n")

    # Split to_fix into categories
    skip_rows     = [r for r in to_fix if is_skip(r.get("address", ""))]
    arterial_rows = [r for r in to_fix if not is_skip(r.get("address", "")) and is_arterial(r.get("address", ""))]
    work_rows     = [r for r in to_fix if not is_skip(r.get("address", "")) and not is_arterial(r.get("address", ""))]

    print(f"  Skip (trails/non-residential): {len(skip_rows)}")
    print(f"  Arterials (manual review):      {len(arterial_rows)}")
    print(f"  Residential to attempt:         {len(work_rows)}")

    changes  = []
    still    = []

    # Mark skip rows
    for r in skip_rows:
        still.append({**{k: r.get(k, '') for k in fieldnames}, "reason": "trail/non-residential"})

    # Mark arterial rows
    for r in arterial_rows:
        still.append({**{k: r.get(k, '') for k in fieldnames}, "reason": "arterial-manual-review"})

    # Group work_rows by street name
    by_street = {}
    for r in work_rows:
        street = r.get("address", "").strip().upper() or "BLANK"
        by_street.setdefault(street, []).append(r)

    # Process each street group
    for street_name, street_rows in by_street.items():
        resolved = process_street_group(street_name, street_rows)
        for row, addr in resolved:
            if addr and re.match(r'^\d+\s', addr):
                changes.append({
                    "row": "(v3)", "id": row.get("id", ""),
                    "old_addr": row.get("address", ""),
                    "new_addr": addr, "lat": row.get("lat", ""), "lon": row.get("lon", ""),
                })
                row["address"] = addr
            else:
                still.append({**{k: row.get(k, '') for k in fieldnames}, "reason": "unresolved"})

    # Write outputs — all rows (ok + skip + fixed + still-missing)
    all_out = rows  # rows modified in-place above
    with open(out_path, "w", newline='', encoding='utf-8') as f:
        w = csv.DictWriter(f, fieldnames=fieldnames, extrasaction='ignore')
        w.writeheader()
        w.writerows(all_out)

    with open(changes_path, "w", newline='', encoding='utf-8') as f:
        w = csv.DictWriter(f, fieldnames=["row","id","old_addr","new_addr","lat","lon"])
        w.writeheader()
        w.writerows(changes)

    still_fields = fieldnames + ["reason"]
    with open(still_path, "w", newline='', encoding='utf-8') as f:
        w = csv.DictWriter(f, fieldnames=still_fields, extrasaction='ignore')
        w.writeheader()
        w.writerows(still)

    print(f"\n{'='*55}")
    print(f"Fixed:           {len(changes)}")
    print(f"Still missing:   {len(still)} (incl. {len(skip_rows)} trails, {len(arterial_rows)} arterials)")
    print(f"\nOutputs:")
    print(f"  {out_path}")
    print(f"  {changes_path}  ← review these before pasting to Sheets")
    print(f"  {still_path}    ← manual lookup needed")


if __name__ == "__main__":
    main()
