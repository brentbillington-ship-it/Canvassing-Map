#!/usr/bin/env python3
"""
Dedupe parcels.js to fix duplicate addr2 entries.

Two categories of duplicates are handled:

  A. MAILING ADDRESS CONTAMINATION
     addr2 contains STE/SUITE/PO BOX/FL/FLOOR, or appears 10+ times.
     These are property-management mailing addresses (e.g. HOA, LLC, INC)
     leaking into the situs address field. The addr2 is wrong for ALL
     copies. Action: BLANK addr2 for all parcels in the group. The
     parcels still exist; they just don't get a misleading label.

  B. RESIDENTIAL DUPLICATES
     2-5 parcels share a residential street address. Only one is correct
     (without DCAD live access we can't know which). Action: pick the
     parcel whose centroid is closest to the spatial neighborhood
     median for that street/number, keep its addr2, blank the rest.

Outputs:
  - parcels.js (modified in place; backup at temp/parcels.js.backup-v5.18)
  - tools/dedupe_report.txt (what was changed and why)

Run: python3 tools/dedupe_parcels.py [--dry-run]
"""

import json, re, sys, os, argparse
from collections import defaultdict, Counter

REPO         = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PARCELS_PATH = os.path.join(REPO, 'parcels.js')
REPORT_PATH  = os.path.join(REPO, 'tools', 'dedupe_report.txt')

# Patterns identifying mailing/commercial addresses
MAILING_RE = re.compile(r'\b(STE|SUITE|FL|FLOOR|PO\s*BOX|P\s*O\s*BOX|UNIT|#)\b', re.I)
COMMERCIAL_OWNERS = re.compile(r'\b(LLC|INC|CORP|TRUST|HOA|HOMEOWNERS?\s*ASS|ASSOC|MANAGEMENT|PROPERT|CHURCH|SCHOOL|CITY OF|ISD|UNIVERSITY)\b', re.I)

def centroid(feat):
    g = feat['geometry']
    if g['type'] == 'Polygon':
        ring = g['coordinates'][0]
    elif g['type'] == 'MultiPolygon':
        ring = g['coordinates'][0][0]
    else:
        return None
    if not ring:
        return None
    return (sum(p[1] for p in ring) / len(ring),
            sum(p[0] for p in ring) / len(ring))

def vertex_count(feat):
    g = feat['geometry']
    if g['type'] == 'Polygon':
        return len(g['coordinates'][0])
    if g['type'] == 'MultiPolygon':
        return len(g['coordinates'][0][0])
    return 0

def parse_addr(addr):
    """Returns (number, street) or (None, None)."""
    if not addr:
        return None, None
    m = re.match(r'^(\d+)\s+(.+)$', addr.strip())
    if not m:
        return None, None
    return int(m.group(1)), m.group(2).strip().upper()

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args()

    print(f"Reading {PARCELS_PATH}...", file=sys.stderr)
    with open(PARCELS_PATH) as f:
        content = f.read()
    m = re.search(r'(const PARCELS_GEOJSON\s*=\s*)({.*})(;?\s*)$', content, re.DOTALL)
    if not m:
        sys.exit("Could not parse parcels.js")
    header = content[:m.start(1)]
    prefix, body, suffix = m.group(1), m.group(2), m.group(3)
    data = json.loads(body)
    features = data['features']
    print(f"Loaded {len(features)} features", file=sys.stderr)

    # ── Group by addr2 ────────────────────────────────────────────────
    by_addr = defaultdict(list)
    for i, f in enumerate(features):
        a = (f['properties'].get('addr2') or '').strip()
        if a:
            by_addr[a.upper()].append(i)

    dup_groups = {a: idxs for a, idxs in by_addr.items() if len(idxs) > 1}
    print(f"Duplicate addr2 groups: {len(dup_groups)}", file=sys.stderr)
    print(f"Total duplicate parcels: {sum(len(v) - 1 for v in dup_groups.values())}", file=sys.stderr)

    # ── Build street → CLEAN parcels index for spatial heuristic ─────
    # Exclude any parcel whose addr2 is duplicated — those are unreliable.
    all_dup_indices = set()
    for idxs in dup_groups.values():
        all_dup_indices.update(idxs)

    street_index = defaultdict(list)  # street -> [(num, idx, lat, lon), ...]
    for i, f in enumerate(features):
        if i in all_dup_indices:
            continue  # skip dup parcels — only use clean ones for reference
        a = (f['properties'].get('addr2') or '').strip()
        num, street = parse_addr(a)
        if num is None: continue
        c = centroid(f)
        if c is None: continue
        street_index[street].append((num, i, c[0], c[1]))

    # ── Process each duplicate group ─────────────────────────────────
    # Strategy:
    #  1. Mailing/commercial dups (STE/SUITE, 10+ copies, all-commercial owners):
    #     Blank ALL — they're definitely wrong.
    #  2. Residential dups: use spatial heuristic to find the ONE parcel whose
    #     centroid fits the address number sequence on its street. Keep that
    #     one, blank the rest. If no spatial fit can be determined (street has
    #     too few non-dup neighbors), blank ALL — they're all suspect.
    blanked = []  # (idx, old_addr, reason)
    spatial_kept = []  # (idx, addr, reason) — residential dup we kept by spatial vote
    residential_unresolved = []  # groups with no spatial signal — blanked

    for addr_upper, idxs in dup_groups.items():
        # Decision A: mailing address contamination
        is_mailing = bool(MAILING_RE.search(addr_upper))
        if not is_mailing and len(idxs) >= 10:
            is_mailing = True
        if not is_mailing and len(idxs) >= 3:
            owners = [(features[i]['properties'].get('owner') or '').strip().upper() for i in idxs]
            if owners and all(COMMERCIAL_OWNERS.search(o) for o in owners if o):
                is_mailing = True

        if is_mailing:
            for i in idxs:
                blanked.append((i, addr_upper, f'mailing/commercial dup x{len(idxs)}'))
            continue

        # Decision B: residential dup — spatial heuristic
        num, street = parse_addr(addr_upper)
        if num is None:
            for i in idxs:
                blanked.append((i, addr_upper, 'unparseable residential dup'))
            continue

        # Find CLEAN parcels on the same street with NEARBY numbers (within 30)
        same_street_clean = [(n, idx, lat, lon) for (n, idx, lat, lon) in street_index[street]
                             if 0 < abs(n - num) <= 30]

        if len(same_street_clean) < 2:
            # Not enough spatial signal — blank all (all suspect)
            residential_unresolved.append((addr_upper, idxs))
            for i in idxs:
                blanked.append((i, addr_upper, 'residential dup, no spatial signal'))
            continue

        # Sort by absolute number distance, take the closest 5
        same_street_clean.sort(key=lambda p: abs(p[0] - num))
        neighbors = same_street_clean[:5]

        # Predict the (lat,lon) for our number using linear interpolation
        # over the closest two clean neighbors (one below, one above the target)
        below = [n for n in neighbors if n[0] < num]
        above = [n for n in neighbors if n[0] > num]
        if below and above:
            b = max(below, key=lambda x: x[0])  # closest below
            a = min(above, key=lambda x: x[0])  # closest above
            # Linear interp
            t = (num - b[0]) / (a[0] - b[0]) if a[0] != b[0] else 0.5
            ref_lat = b[2] + (a[2] - b[2]) * t
            ref_lon = b[3] + (a[3] - b[3]) * t
        else:
            # Fall back to median
            ref_lat = sum(p[2] for p in neighbors) / len(neighbors)
            ref_lon = sum(p[3] for p in neighbors) / len(neighbors)

        # Score each parcel in the dup group by distance to predicted position
        scored = []
        for i in idxs:
            c = centroid(features[i])
            if c is None:
                continue
            d = ((c[0] - ref_lat) ** 2 + (c[1] - ref_lon) ** 2) ** 0.5
            scored.append((d, i))
        scored.sort()
        if not scored:
            for i in idxs:
                blanked.append((i, addr_upper, 'no centroid'))
            continue

        best_dist, best_idx = scored[0]
        best_dist_m = best_dist * 111000
        second_dist_m = scored[1][0] * 111000 if len(scored) > 1 else float('inf')

        # Tighter thresholds: must be within 60m AND clearly closer than runner-up
        if best_dist_m < 60 and second_dist_m > best_dist_m * 1.3:
            spatial_kept.append((best_idx, addr_upper, f'spatial winner ({best_dist_m:.0f}m)'))
            for i in idxs:
                if i != best_idx:
                    blanked.append((i, addr_upper, f'residential dup, lost spatial vote'))
        else:
            residential_unresolved.append((addr_upper, idxs))
            for i in idxs:
                blanked.append((i, addr_upper, f'residential dup, ambiguous ({best_dist_m:.0f}m best)'))

    # ── Apply changes ────────────────────────────────────────────────
    print(f"\nTotal blanked: {len(blanked)}", file=sys.stderr)
    print(f"Spatial winners kept: {len(spatial_kept)}", file=sys.stderr)
    print(f"Unresolved (all blanked): {len(residential_unresolved)} groups", file=sys.stderr)

    # Group blanked by reason for the report
    by_reason = defaultdict(int)
    for _, _, reason in blanked:
        # Strip the count for grouping
        key = re.sub(r' x\d+$', '', reason)
        by_reason[key] += 1

    print("\nBlanked by reason:", file=sys.stderr)
    for r, c in sorted(by_reason.items(), key=lambda x: -x[1]):
        print(f"  {c:5d}  {r}", file=sys.stderr)

    if args.dry_run:
        print("\n[DRY RUN] No changes written.", file=sys.stderr)
        return

    # Apply blanks
    blank_set = set(i for i, _, _ in blanked)
    for i in blank_set:
        features[i]['properties']['addr2'] = ''

    # Re-serialize parcels.js preserving the wrapper
    new_body = json.dumps(data, separators=(',', ':'), ensure_ascii=False)
    new_content = header + prefix + new_body + suffix
    with open(PARCELS_PATH, 'w') as f:
        f.write(new_content)
    print(f"\nWrote {PARCELS_PATH}", file=sys.stderr)

    # Write report
    with open(REPORT_PATH, 'w') as f:
        f.write(f"Parcel dedup report (v5.18)\n")
        f.write(f"===========================\n\n")
        f.write(f"Total parcels: {len(features)}\n")
        f.write(f"Duplicate addr2 groups: {len(dup_groups)}\n")
        f.write(f"Total blanked: {len(blanked)}\n")
        f.write(f"Spatial winners kept (residential): {len(spatial_kept)}\n")
        f.write(f"Unresolved residential groups (all blanked): {len(residential_unresolved)}\n\n")
        f.write("Blanked by reason:\n")
        for r, c in sorted(by_reason.items(), key=lambda x: -x[1]):
            f.write(f"  {c:5d}  {r}\n")
        f.write("\n\nSpatial winners kept (residential dups, picked by spatial vote):\n")
        for i, addr, reason in spatial_kept[:200]:
            f.write(f"  [{i}] KEEP {addr!r}  ({reason})\n")
    print(f"Wrote report to {REPORT_PATH}", file=sys.stderr)

if __name__ == '__main__':
    main()
