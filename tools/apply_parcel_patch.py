#!/usr/bin/env python3
"""
apply_parcel_patch.py
---------------------
Applies corrected addresses from parcel_address_patch.json back into parcels.js.

Usage:
    python3 apply_parcel_patch.py [--dry-run] [--patch PATH] [--parcels PATH]

Options:
    --dry-run     Print what would change without writing parcels.js
    --patch PATH  Path to patch JSON (default: tools/parcel_address_patch.json)
    --parcels PATH Path to parcels.js (default: parcels.js in parent directory)
"""

import json
import re
import os
import argparse
import sys
import shutil
from datetime import datetime

PARCELS_JS  = os.path.join(os.path.dirname(__file__), '..', 'parcels.js')
PATCH_JSON  = os.path.join(os.path.dirname(__file__), 'parcel_address_patch.json')


# ─── Load parcels.js ─────────────────────────────────────────────────────────

def load_parcels_raw(path):
    """Return (header_comments, prefix, geojson_str, suffix) from parcels.js.
    Handles files that have // comment lines before the variable declaration."""
    with open(path, 'r', encoding='utf-8') as f:
        raw = f.read()
    # Use re.search so comment lines before the declaration are handled
    m = re.search(r'((?:const|var|let)\s+\w+\s*=\s*)', raw)
    if not m:
        raise ValueError('Could not find JS variable declaration in parcels.js')
    header   = raw[:m.start()]   # preserve comment block before declaration
    prefix   = m.group(1)
    rest     = raw[m.end():]
    suffix   = ''
    if rest.rstrip().endswith(';'):
        suffix = ';'
        rest   = rest.rstrip()[:-1]
    return header, prefix, rest.strip(), suffix


def load_geojson(geojson_str):
    return json.loads(geojson_str)


def write_parcels(path, header, prefix, geojson, suffix, dry_run=False):
    """Serialize modified GeoJSON back into the JS file, preserving header comments."""
    body = json.dumps(geojson, separators=(',', ':'), ensure_ascii=False)
    new_content = header + prefix + body + suffix + '\n'
    if dry_run:
        print(f'[DRY RUN] Would write {len(new_content):,} chars to {path}')
        return
    # Backup original
    backup = path + '.' + datetime.now().strftime('%Y%m%d_%H%M%S') + '.bak'
    shutil.copy2(path, backup)
    print(f'Backup written: {backup}')
    with open(path, 'w', encoding='utf-8') as f:
        f.write(new_content)
    print(f'parcels.js updated.')


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description='Apply address patches to parcels.js')
    parser.add_argument('--dry-run',  action='store_true',
                        help='Print changes without writing parcels.js')
    parser.add_argument('--patch',   default=PATCH_JSON,
                        help=f'Patch JSON file (default: {PATCH_JSON})')
    parser.add_argument('--parcels', default=PARCELS_JS,
                        help=f'Path to parcels.js (default: {PARCELS_JS})')
    args = parser.parse_args()

    if not os.path.exists(args.patch):
        print(f'ERROR: Patch file not found: {args.patch}', file=sys.stderr)
        print('Run parcel_address_audit.py first to generate the patch.', file=sys.stderr)
        sys.exit(1)

    with open(args.patch, 'r', encoding='utf-8') as f:
        patches = json.load(f)

    if not patches:
        print('No patches in patch file — nothing to do.')
        return

    print(f'Loading {args.parcels}…')
    header, prefix, geojson_str, suffix = load_parcels_raw(args.parcels)
    geojson = load_geojson(geojson_str)
    features = geojson.get('features', [])
    print(f'  {len(features)} features loaded.')
    print(f'  {len(patches)} patches to apply.')

    # Build lookup by feature_index and parcel_id
    by_index   = {str(p['feature_index']): p for p in patches}
    by_parcel  = {str(p['parcel_id']): p for p in patches}

    applied = 0
    skipped = 0

    for feat_idx, feat in enumerate(features):
        patch = by_index.get(str(feat_idx))
        if not patch:
            props = feat.get('properties', {})
            parcel_id = props.get('id') or props.get('GID') or props.get('OBJECTID')
            if parcel_id:
                patch = by_parcel.get(str(parcel_id))
        if not patch:
            continue

        old_addr = feat.get('properties', {}).get('addr2', '')
        # corrected_address of '' means intentional blank (MAILING / NON_RESIDENTIAL);
        # use sentinel None to detect a missing key vs an explicit empty string.
        new_addr = patch.get('corrected_address')
        if new_addr is None:
            print(f'  [SKIP] Feature {feat_idx}: no corrected_address key in patch')
            skipped += 1
            continue
        new_addr = new_addr.strip()
        if old_addr == new_addr:
            print(f'  [SAME] Feature {feat_idx}: address unchanged ({old_addr!r})')
            skipped += 1
            continue

        print(f'  [PATCH] Feature {feat_idx}: {old_addr!r} → {new_addr!r}')
        if not args.dry_run:
            feat['properties']['addr2'] = new_addr
        applied += 1

    print(f'\nApplied: {applied}  |  Skipped: {skipped}')

    if applied == 0:
        print('Nothing to write.')
        return

    write_parcels(args.parcels, header, prefix, geojson, suffix, dry_run=args.dry_run)


if __name__ == '__main__':
    main()
