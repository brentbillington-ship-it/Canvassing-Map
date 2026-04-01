"""
geocode_addresses.py
--------------------
Reads a CSV exported from the Chaka Canvassing app (houses sheet),
finds rows with blank or street-only addresses, reverse-geocodes them
using OpenStreetMap Nominatim, and writes a corrected CSV.

Usage:
    py geocode_addresses.py houses_export.csv

Output:
    houses_export_geocoded.csv  — same file with blanks filled in
    houses_export_changes.csv   — only the rows that changed, for review

Nominatim fair-use: 1 request/second max, no bulk. This script
respects that with a 1.1s delay between requests.
"""

import csv
import sys
import time
import urllib.request
import urllib.parse
import json
import os
import re
from datetime import datetime

NOMINATIM_URL = "https://nominatim.openstreetmap.org/reverse"
USER_AGENT    = "ChakaCampaign-AddressFixer/1.0 (brent@chaka4cisd.com)"
DELAY_SEC     = 1.1  # Nominatim fair-use: max 1 req/sec


def is_blank_address(addr):
    """True if address has no street number — just a street name or empty."""
    if not addr or not addr.strip():
        return True
    # Has a leading number? e.g. "123 Main St"
    if re.match(r'^\d+\s', addr.strip()):
        return False
    return True


def reverse_geocode(lat, lon):
    """Query Nominatim for address at lat/lon. Returns house_number + road or None."""
    params = urllib.parse.urlencode({
        "lat":            lat,
        "lon":            lon,
        "format":         "json",
        "addressdetails": 1,
        "zoom":           18,  # building-level
    })
    url = f"{NOMINATIM_URL}?{params}"
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode())
        a = data.get("address", {})
        num  = a.get("house_number", "").strip()
        road = a.get("road", a.get("pedestrian", "")).strip()
        if num and road:
            return f"{num} {road.upper()}"
        elif road:
            return road.upper()
        return None
    except Exception as e:
        print(f"  [WARN] Nominatim error for ({lat},{lon}): {e}")
        return None


def main():
    if len(sys.argv) < 2:
        print("Usage: py geocode_addresses.py <houses_csv>")
        sys.exit(1)

    in_path = sys.argv[1]
    base    = os.path.splitext(in_path)[0]
    out_path     = base + "_geocoded.csv"
    changes_path = base + "_changes.csv"

    with open(in_path, newline='', encoding='utf-8-sig') as f:
        rows = list(csv.DictReader(f))

    if not rows:
        print("No rows found.")
        sys.exit(1)

    fieldnames = list(rows[0].keys())
    changes    = []
    total      = 0
    fixed      = 0
    skipped    = 0

    print(f"Loaded {len(rows)} rows. Scanning for missing addresses...\n")

    for i, row in enumerate(rows):
        addr = row.get("address", "").strip()
        lat  = row.get("lat", "").strip()
        lon  = row.get("lon", "").strip()

        if not is_blank_address(addr):
            continue

        total += 1
        if not lat or not lon:
            print(f"  Row {i+1}: no lat/lon, skipping")
            skipped += 1
            continue

        print(f"  Row {i+1}: geocoding ({lat}, {lon}) — was: '{addr}'", end="", flush=True)
        time.sleep(DELAY_SEC)
        result = reverse_geocode(lat, lon)

        if result:
            print(f" → '{result}'")
            changes.append({
                "row":      i + 1,
                "id":       row.get("id", ""),
                "old_addr": addr,
                "new_addr": result,
                "lat":      lat,
                "lon":      lon,
            })
            row["address"] = result
            fixed += 1
        else:
            print(" → [no result]")
            skipped += 1

    # Write corrected full CSV
    with open(out_path, "w", newline='', encoding='utf-8') as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        w.writerows(rows)

    # Write changes-only CSV for review
    with open(changes_path, "w", newline='', encoding='utf-8') as f:
        w = csv.DictWriter(f, fieldnames=["row","id","old_addr","new_addr","lat","lon"])
        w.writeheader()
        w.writerows(changes)

    print(f"\n{'='*50}")
    print(f"Done. {total} blank addresses found.")
    print(f"  Fixed:   {fixed}")
    print(f"  Skipped: {skipped}")
    print(f"\nOutputs:")
    print(f"  Full corrected CSV: {out_path}")
    print(f"  Changes for review: {changes_path}")
    print(f"\nNext steps:")
    print(f"  1. Review {changes_path} to verify geocoded addresses look right")
    print(f"  2. In Google Sheets, filter 'address' column for blanks")
    print(f"  3. Paste corrected values from {out_path} into the 'address' column")


if __name__ == "__main__":
    main()
